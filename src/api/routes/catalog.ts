import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { isUniqueConstraintError } from '../../db/errors';
import {
  applicationPrograms,
  droneUnits,
  inventoryLots,
  products,
  programIngredients,
  programPrices,
} from '../../db/schema';
import type { AppEnv } from '../../env';
import { conflict, notFound, parseJson, parseQuery } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import {
  droneUnitCreateSchema,
  droneUnitListQuerySchema,
  inventoryAdjustSchema,
  inventoryLotCreateSchema,
  inventoryLotListQuerySchema,
  productCreateSchema,
  productListQuerySchema,
  productUpdateSchema,
} from '../schemas';
import { recordAudit, recordChange } from '../../services/audit';
import { listActiveTiers } from '../../services/pricing';

export const catalogRoutes = new Hono<AppEnv>();

catalogRoutes.use('*', requireAuth);

/* ── Pricing tiers ─────────────────────────────────────────────────────────── */

/** Drives the tier selector in the invoice composer. */
catalogRoutes.get('/pricing/tiers', requirePermission('pricing:read'), async (c) => {
  const db = createDb(c.env.DB);
  return c.json({ data: await listActiveTiers(db) });
});

/**
 * Application programs (per-acre blends) with the prices currently in force.
 *
 * This is the sellable unit for chemical work, so the invoice composer needs it:
 * a program line is priced per acre from `program_prices`, not from a flat
 * per-product price.
 */
catalogRoutes.get('/programs', requirePermission('pricing:read'), async (c) => {
  const db = createDb(c.env.DB);
  const on = new Date();

  const [programs, tiers, prices, ingredients] = await Promise.all([
    db
      .select()
      .from(applicationPrograms)
      .where(eq(applicationPrograms.isActive, true))
      .orderBy(asc(applicationPrograms.name))
      .all(),
    listActiveTiers(db),
    db.select().from(programPrices).all(),
    db.select({ programId: programIngredients.programId }).from(programIngredients).all(),
  ]);

  const tierKeyById = new Map(tiers.map((tier) => [tier.id, tier.key]));

  const pricesByProgram = new Map<string, Record<string, number>>();
  for (const row of prices) {
    const tierKey = tierKeyById.get(row.tierId);
    if (!tierKey) continue;

    const effective =
      row.effectiveFrom.getTime() <= on.getTime() &&
      (row.effectiveTo === null || row.effectiveTo.getTime() > on.getTime());
    if (!effective) continue;

    const bucket = pricesByProgram.get(row.programId) ?? {};
    bucket[tierKey] = row.pricePerAcreCents;
    pricesByProgram.set(row.programId, bucket);
  }

  const ingredientCounts = new Map<string, number>();
  for (const row of ingredients) {
    ingredientCounts.set(row.programId, (ingredientCounts.get(row.programId) ?? 0) + 1);
  }

  return c.json({
    data: programs.map((program) => ({
      id: program.id,
      name: program.name,
      crop: program.crop,
      stage: program.stage,
      defaultApplicationMethod: program.defaultApplicationMethod,
      ingredientCount: ingredientCounts.get(program.id) ?? 0,
      pricesByTier: pricesByProgram.get(program.id) ?? {},
    })),
  });
});

/* ── Products ──────────────────────────────────────────────────────────────── */
catalogRoutes.get('/products', requirePermission('inventory:read'), async (c) => {
  const { q, limit, offset, includeInactive, type } = parseQuery(
    new URL(c.req.url),
    productListQuerySchema,
  );
  const db = createDb(c.env.DB);

  const conditions: SQL[] = [];
  if (!includeInactive) conditions.push(eq(products.isActive, true));
  if (type) conditions.push(eq(products.type, type));
  if (q) {
    const term = `%${q}%`;
    const search = or(
      like(products.name, term),
      like(products.sku, term),
      like(products.brand, term),
      like(products.epaNumber, term),
    );
    if (search) conditions.push(search);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(products)
      .where(where)
      .orderBy(asc(products.name))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(products).where(where).get(),
  ]);

  return c.json({ data: rows, pagination: { limit, offset, total: Number(counted?.total ?? 0) } });
});

catalogRoutes.get('/products/:id', requirePermission('inventory:read'), async (c) => {
  const db = createDb(c.env.DB);
  const product = await db.select().from(products).where(eq(products.id, c.req.param('id'))).get();
  if (!product) throw notFound('Product not found');
  return c.json({ data: product });
});

catalogRoutes.post('/products', requirePermission('inventory:write'), async (c) => {
  const input = await parseJson(c.req.raw, productCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  try {
    const [created] = await db.insert(products).values(input).returning();
    if (!created) throw conflict('Failed to create product');

    await recordAudit(db, {
      actorUserId: actor.id,
      action: 'product.created',
      entityType: 'product',
      entityId: created.id,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });

    return c.json({ data: created }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`SKU "${input.sku}" already exists`);
    }
    throw error;
  }
});

catalogRoutes.patch('/products/:id', requirePermission('inventory:write'), async (c) => {
  const input = await parseJson(c.req.raw, productUpdateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  // Read before writing: the audit trail is only useful if it can say what the
  // value used to be.
  const before = await db.select().from(products).where(eq(products.id, id)).get();
  if (!before) throw notFound('Product not found');

  const [updated] = await db
    .update(products)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(products.id, id))
    .returning();

  if (!updated) throw notFound('Product not found');

  const changes = await recordChange(db, {
    actorUserId: actor.id,
    action: 'product.updated',
    entityType: 'product',
    entityId: updated.id,
    before,
    after: updated,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: updated, changes });
});

/* ── Inventory lots ───────────────────────────────────────────────────────── */

catalogRoutes.get('/inventory/lots', requirePermission('inventory:read'), async (c) => {
  const { limit, offset, productId, warehouseId } = parseQuery(
    new URL(c.req.url),
    inventoryLotListQuerySchema,
  );
  const db = createDb(c.env.DB);

  const conditions: SQL[] = [];
  if (productId) conditions.push(eq(inventoryLots.productId, productId));
  if (warehouseId) conditions.push(eq(inventoryLots.warehouseId, warehouseId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(inventoryLots)
      .where(where)
      .orderBy(desc(inventoryLots.receivedAt), asc(inventoryLots.lotNumber))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(inventoryLots).where(where).get(),
  ]);

  return c.json({ data: rows, pagination: { limit, offset, total: Number(counted?.total ?? 0) } });
});

catalogRoutes.post('/inventory/lots', requirePermission('inventory:write'), async (c) => {
  const input = await parseJson(c.req.raw, inventoryLotCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const [created] = await db.insert(inventoryLots).values(input).returning();
  if (!created) throw conflict('Failed to create inventory lot');

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'inventory_lot.created',
    entityType: 'inventory_lot',
    entityId: created.id,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: created }, 201);
});

/**
 * Relative stock adjustment.
 *
 * Applied as `quantity_on_hand = quantity_on_hand + delta` in the database, so
 * two concurrent adjustments compose instead of clobbering each other.
 */
catalogRoutes.post('/inventory/lots/:id/adjust', requirePermission('inventory:write'), async (c) => {
  const { delta, reason } = await parseJson(c.req.raw, inventoryAdjustSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const [updated] = await db
    .update(inventoryLots)
    .set({
      quantityOnHand: sql`${inventoryLots.quantityOnHand} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryLots.id, id))
    .returning();

  if (!updated) throw notFound('Inventory lot not found');

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'inventory_lot.adjusted',
    entityType: 'inventory_lot',
    entityId: updated.id,
    metadata: { delta, reason: reason ?? null, quantityOnHand: updated.quantityOnHand },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: updated });
});

/* ── Serialized drone units ────────────────────────────────────────────────── */

catalogRoutes.get('/drone-units', requirePermission('inventory:read'), async (c) => {
  const { limit, offset, productId, status } = parseQuery(
    new URL(c.req.url),
    droneUnitListQuerySchema,
  );
  const db = createDb(c.env.DB);

  const conditions: SQL[] = [];
  if (productId) conditions.push(eq(droneUnits.productId, productId));
  if (status) conditions.push(eq(droneUnits.status, status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(droneUnits)
      .where(where)
      .orderBy(asc(droneUnits.serialNumber))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(droneUnits).where(where).get(),
  ]);

  return c.json({ data: rows, pagination: { limit, offset, total: Number(counted?.total ?? 0) } });
});

catalogRoutes.post('/drone-units', requirePermission('inventory:write'), async (c) => {
  const input = await parseJson(c.req.raw, droneUnitCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  try {
    const [created] = await db.insert(droneUnits).values(input).returning();
    if (!created) throw conflict('Failed to create drone unit');

    await recordAudit(db, {
      actorUserId: actor.id,
      action: 'drone_unit.created',
      entityType: 'drone_unit',
      entityId: created.id,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });

    return c.json({ data: created }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`Serial number "${input.serialNumber}" is already registered`);
    }
    throw error;
  }
});
