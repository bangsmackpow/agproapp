import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { isUniqueConstraintError } from '../../db/errors';
import {
  applicationPrograms,
  droneUnits,
  inventoryLots,
  products,
  productCosts,
  programIngredients,
  programPrices,
  units,
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
  stockAdjustSchema,
  stockReceiptSchema,
  unitCreateSchema,
} from '../schemas';
import { recordAudit, recordChange } from '../../services/audit';
import { listActiveTiers } from '../../services/pricing';
import { assertKnownUnits, listUnits } from '../../services/units';
import {
  convertToBase,
  movementReference,
  poolQuantitiesByProduct,
  productLedger,
  productPoolQuantity,
  receiptsWithRemaining,
  recordMovements,
  salesByCustomer,
  tidyQuantity,
} from '../../services/inventory';

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

/* ── Units of measure ──────────────────────────────────────────────────────── */

/** Drives every unit dropdown. The registry is the source, not a hard-coded list. */
catalogRoutes.get('/units', requirePermission('inventory:read'), async (c) => {
  const db = createDb(c.env.DB);
  return c.json({ data: await listUnits(db) });
});

catalogRoutes.post('/units', requirePermission('admin:settings'), async (c) => {
  const input = await parseJson(c.req.raw, unitCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  try {
    const [created] = await db.insert(units).values(input).returning();
    if (!created) throw conflict('Failed to create unit');

    await recordAudit(db, {
      actorUserId: actor.id,
      action: 'unit.created',
      entityType: 'unit',
      entityId: created.code,
      metadata: { code: created.code, dimension: created.dimension },
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });

    return c.json({ data: created }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`Unit "${input.code}" already exists`);
    }
    throw error;
  }
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

  // Pooled stock alongside each row, so the list answers "how much is there"
  // without a second trip per product.
  const pools = await poolQuantitiesByProduct(db);

  return c.json({
    data: rows.map((product) => ({
      ...product,
      baseUnit: product.baseUnitCode ?? product.unit,
      quantityOnHand: pools.get(product.id) ?? 0,
    })),
    pagination: { limit, offset, total: Number(counted?.total ?? 0) },
  });
});

/**
 * Stock for one product: the pool, where it came from, and where it went.
 *
 * The pool is the headline number; receipts and the ledger sit underneath it so a
 * "where did this come from" question can be answered without leaving the screen.
 */
catalogRoutes.get('/products/:id/stock', requirePermission('inventory:read'), async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');

  await assertKnownUnits(db, []);
  const product = await db.select().from(products).where(eq(products.id, id)).get();
  if (!product) throw notFound('Product not found');

  const [pool, receipts, ledger, sold] = await Promise.all([
    productPoolQuantity(db, id),
    receiptsWithRemaining(db, id),
    productLedger(db, id),
    salesByCustomer(db, id),
  ]);

  return c.json({
    data: {
      productId: id,
      baseUnit: product.baseUnitCode ?? product.unit,
      quantityOnHand: pool,
      receipts,
      ledger,
      salesByCustomer: sold,
      totalSold: tidyQuantity(sold.reduce((total, row) => total + row.quantity, 0)),
    },
  });
});

/**
 * Receives stock: creates a receipt and logs the movement.
 *
 * The lot records provenance and cost; the movement is what actually changes the
 * pool. Doing only one of the two is how an inventory screen starts lying.
 */
catalogRoutes.post('/products/:id/receipts', requirePermission('inventory:write'), async (c) => {
  const input = await parseJson(c.req.raw, stockReceiptSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const product = await db.select().from(products).where(eq(products.id, id)).get();
  if (!product) throw notFound('Product not found');

  const baseUnit = product.baseUnitCode ?? product.unit;
  const { quantityInBase, converted } = await convertToBase(
    db,
    input.unit ?? product.unit,
    baseUnit,
    input.quantity,
  );

  const receivedAt = input.receivedAt ?? new Date();

  const [lot] = await db
    .insert(inventoryLots)
    .values({
      productId: product.id,
      warehouseId: input.warehouseId ?? null,
      lotNumber: input.lotNumber ?? null,
      seedNumber: input.seedNumber ?? null,
      quantityOnHand: quantityInBase,
      unitCostCents: input.unitCostCents ?? null,
      expirationDate: input.expirationDate ?? null,
      receivedAt,
      sourceVendorId: input.sourceVendorId ?? null,
    })
    .returning();

  if (!lot) throw conflict('Failed to create the receipt');

  await recordMovements(db, [
    {
      productId: product.id,
      lotId: lot.id,
      movementType: 'receipt',
      quantityDelta: quantityInBase,
      unit: baseUnit,
      quantityInBase,
      unitCostCents: input.unitCostCents ?? null,
      ...movementReference('manual', lot.id),
      occurredAt: receivedAt,
      createdByUserId: actor.id,
      note: converted
        ? (input.note ?? `Received ${input.quantity} ${input.unit ?? product.unit}`)
        : `${input.note ?? 'Received'} (unit ${input.unit ?? '?'} could not be converted to ${baseUnit})`,
    },
  ]);

  // Cost history is what keeps margin honest when a vendor price changes.
  if (input.unitCostCents !== undefined) {
    await db.insert(productCosts).values({
      productId: product.id,
      costCents: input.unitCostCents,
      unit: input.unit ?? product.unit,
      effectiveFrom: receivedAt,
      sourceVendorId: input.sourceVendorId ?? null,
      notes: input.note ?? null,
    });
  }

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'inventory.received',
    entityType: 'product',
    entityId: product.id,
    metadata: {
      lotId: lot.id,
      quantity: quantityInBase,
      unit: baseUnit,
      unitCostCents: input.unitCostCents ?? null,
      lotNumber: input.lotNumber ?? null,
    },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: { lot, quantityInBase, baseUnit, converted } }, 201);
});

/** A physical-count correction. Recorded as a movement, never as an edit. */
catalogRoutes.post('/products/:id/adjustments', requirePermission('inventory:write'), async (c) => {
  const input = await parseJson(c.req.raw, stockAdjustSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const product = await db.select().from(products).where(eq(products.id, id)).get();
  if (!product) throw notFound('Product not found');

  const baseUnit = product.baseUnitCode ?? product.unit;
  const { quantityInBase, converted } = await convertToBase(
    db,
    input.unit ?? product.unit,
    baseUnit,
    input.delta,
  );

  await recordMovements(db, [
    {
      productId: product.id,
      movementType: 'adjustment',
      quantityDelta: quantityInBase,
      unit: baseUnit,
      quantityInBase,
      ...movementReference('manual', id),
      occurredAt: new Date(),
      createdByUserId: actor.id,
      note: converted ? input.reason : `${input.reason} (unit could not be converted to ${baseUnit})`,
    },
  ]);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'inventory.adjusted',
    entityType: 'product',
    entityId: product.id,
    metadata: { delta: quantityInBase, unit: baseUnit, reason: input.reason },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: { productId: id, delta: quantityInBase, baseUnit } }, 201);
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

  // Validated against the registry rather than a fixed list, so an Admin can add
  // a unit without a deploy.
  await assertKnownUnits(db, [input.unit]);

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

  await assertKnownUnits(db, [input.unit]);

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
