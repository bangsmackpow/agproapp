import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { isUniqueConstraintError } from '../../db/errors';
import { bankAccounts, checks } from '../../db/schema';
import type { AppEnv } from '../../env';
import { conflict, notFound, parseJson, parseQuery } from '../lib/http';
import { requireAdmin, requireAuth, requirePermission } from '../middleware';
import { bankAccountCreateSchema, checkCreateSchema, checkListQuerySchema } from '../schemas';
import { recordAudit } from '../../services/audit';
import { createCheck, getCheckWithAllocations, updateCheckStatus } from '../../services/checkwriting';

/**
 * Checkwriting.
 *
 * The entire module is Admin-exclusive. `requireAdmin` runs before any handler,
 * so a request from a Sales or Manager session is rejected in middleware and the
 * handlers are never reached — visibility and execution are locked by the same
 * gate.
 */
export const checkRoutes = new Hono<AppEnv>();

checkRoutes.use('*', requireAuth);
checkRoutes.use('*', requireAdmin);

checkRoutes.get('/', requirePermission('checks:read'), async (c) => {
  const { limit, offset, bankAccountId, payeeVendorId, status } = parseQuery(
    new URL(c.req.url),
    checkListQuerySchema,
  );
  const db = createDb(c.env.DB);

  const conditions: SQL[] = [];
  if (bankAccountId) conditions.push(eq(checks.bankAccountId, bankAccountId));
  if (payeeVendorId) conditions.push(eq(checks.payeeVendorId, payeeVendorId));
  if (status) conditions.push(eq(checks.status, status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(checks)
      .where(where)
      .orderBy(desc(checks.paymentDate), desc(checks.checkNumber))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(checks).where(where).get(),
  ]);

  return c.json({ data: rows, pagination: { limit, offset, total: Number(counted?.total ?? 0) } });
});

checkRoutes.get('/bank-accounts', requirePermission('checks:read'), async (c) => {
  const db = createDb(c.env.DB);
  // Explicit columns: `accountNumber` must never leave the Worker in a list.
  const rows = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      bankName: bankAccounts.bankName,
      routingNumber: bankAccounts.routingNumber,
      accountNumberLast4: bankAccounts.accountNumberLast4,
      nextCheckNumber: bankAccounts.nextCheckNumber,
      isDefault: bankAccounts.isDefault,
      isActive: bankAccounts.isActive,
      createdAt: bankAccounts.createdAt,
      updatedAt: bankAccounts.updatedAt,
    })
    .from(bankAccounts)
    .orderBy(bankAccounts.name)
    .all();

  return c.json({ data: rows });
});

/** Banking details for one account, including the full number the print view needs. */
checkRoutes.get('/bank-accounts/:id', requirePermission('checks:read'), async (c) => {
  const db = createDb(c.env.DB);
  const account = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, c.req.param('id')))
    .get();

  if (!account) throw notFound('Bank account not found');
  return c.json({ data: account });
});

checkRoutes.post('/bank-accounts', requirePermission('admin:settings'), async (c) => {
  const input = await parseJson(c.req.raw, bankAccountCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  try {
    const [created] = await db.insert(bankAccounts).values(input).returning();
    if (!created) throw conflict('Failed to create bank account');

    await recordAudit(db, {
      actorUserId: actor.id,
      action: 'bank_account.created',
      entityType: 'bank_account',
      entityId: created.id,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });

    return c.json({ data: created }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict('A bank account with that name already exists');
    throw error;
  }
});

checkRoutes.get('/:id', requirePermission('checks:read'), async (c) => {
  const db = createDb(c.env.DB);
  const { check, allocations } = await getCheckWithAllocations(db, c.req.param('id'));

  // Included for the print view: composing a cheque needs the paying account.
  const bankAccount = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, check.bankAccountId))
    .get();

  return c.json({ data: { check, allocations, bankAccount: bankAccount ?? null } });
});

checkRoutes.post('/', requirePermission('checks:write'), async (c) => {
  const input = await parseJson(c.req.raw, checkCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const result = await createCheck(db, input, actor.id);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'check.created',
    entityType: 'check',
    entityId: result.check.id,
    metadata: {
      checkNumber: result.check.checkNumber,
      amountCents: result.check.amountCents,
      payeeName: result.check.payeeName,
      allocations: result.allocations.length,
    },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: result }, 201);
});

checkRoutes.post('/:id/print', requirePermission('checks:print'), async (c) => {
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const check = await updateCheckStatus(db, c.req.param('id'), 'printed');

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'check.printed',
    entityType: 'check',
    entityId: check.id,
    metadata: { checkNumber: check.checkNumber },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: check });
});

checkRoutes.post('/:id/clear', requirePermission('checks:write'), async (c) => {
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const check = await updateCheckStatus(db, c.req.param('id'), 'cleared');

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'check.cleared',
    entityType: 'check',
    entityId: check.id,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: check });
});

/**
 * Voids a check and reverses every allocation, restoring the affected vendor bill
 * balances and statuses in the same batch.
 */
checkRoutes.post('/:id/void', requirePermission('checks:void'), async (c) => {
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  let reason: string | undefined;
  try {
    const body = (await c.req.json()) as { reason?: string };
    reason = typeof body?.reason === 'string' ? body.reason : undefined;
  } catch {
    reason = undefined;
  }

  const check = await updateCheckStatus(db, c.req.param('id'), 'voided', reason);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'check.voided',
    entityType: 'check',
    entityId: check.id,
    metadata: { checkNumber: check.checkNumber, reason: reason ?? null },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: check });
});
