import { and, asc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { isUniqueConstraintError } from '../../db/errors';
import { customers } from '../../db/schema';
import type { AppEnv } from '../../env';
import { conflict, notFound, parseJson, parseQuery } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import { customerCreateSchema, customerUpdateSchema, listQuerySchema } from '../schemas';
import { recordAudit, recordChange } from '../../services/audit';

export const customerRoutes = new Hono<AppEnv>();

customerRoutes.use('*', requireAuth);

/** Builds the shared WHERE clause for list/search queries. */
function customerFilters(options: { q?: string; includeInactive: boolean }): SQL | undefined {
  const conditions: SQL[] = [];

  if (!options.includeInactive) conditions.push(eq(customers.isActive, true));

  if (options.q) {
    const term = `%${options.q}%`;
    const search = or(
      like(customers.name, term),
      like(customers.accountNumber, term),
      like(customers.phone, term),
    );
    if (search) conditions.push(search);
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

customerRoutes.get('/', requirePermission('crm:read'), async (c) => {
  const { q, limit, offset, includeInactive } = parseQuery(new URL(c.req.url), listQuerySchema);
  const db = createDb(c.env.DB);
  const where = customerFilters({ q, includeInactive });

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(where)
      .orderBy(asc(customers.name))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(customers).where(where).get(),
  ]);

  return c.json({
    data: rows,
    pagination: { limit, offset, total: Number(counted?.total ?? 0) },
  });
});

customerRoutes.get('/:id', requirePermission('crm:read'), async (c) => {
  const db = createDb(c.env.DB);
  const customer = await db.select().from(customers).where(eq(customers.id, c.req.param('id'))).get();
  if (!customer) throw notFound('Customer not found');
  return c.json({ data: customer });
});

customerRoutes.post('/', requirePermission('crm:write'), async (c) => {
  const input = await parseJson(c.req.raw, customerCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  try {
    const [created] = await db.insert(customers).values(input).returning();
    if (!created) throw conflict('Failed to create customer');

    await recordAudit(db, {
      actorUserId: actor.id,
      action: 'customer.created',
      entityType: 'customer',
      entityId: created.id,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });

    return c.json({ data: created }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`Account number "${input.accountNumber}" is already in use`);
    }
    throw error;
  }
});

customerRoutes.patch('/:id', requirePermission('crm:write'), async (c) => {
  const id = c.req.param('id');
  const input = await parseJson(c.req.raw, customerUpdateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const before = await db.select().from(customers).where(eq(customers.id, id)).get();
  if (!before) throw notFound('Customer not found');

  try {
    const [updated] = await db
      .update(customers)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();

    if (!updated) throw notFound('Customer not found');

    const changes = await recordChange(db, {
      actorUserId: actor.id,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: updated.id,
      before,
      after: updated,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });

    return c.json({ data: updated, changes });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('That account number is already in use');
    }
    throw error;
  }
});

/**
 * Soft delete. Customers are referenced by historical invoices, so a row is
 * deactivated rather than removed — `onDelete: 'restrict'` would refuse the
 * delete anyway, which is the behaviour we want.
 */
customerRoutes.delete('/:id', requirePermission('crm:delete'), async (c) => {
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const [updated] = await db
    .update(customers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(customers.id, id))
    .returning();

  if (!updated) throw notFound('Customer not found');

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'customer.deactivated',
    entityType: 'customer',
    entityId: updated.id,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: updated });
});
