import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { invoices } from '../../db/schema';
import type { AppEnv } from '../../env';
import { notFound, parseJson, parseQuery } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import {
  invoiceCreateSchema,
  invoiceListQuerySchema,
  invoiceRecordPaymentSchema,
} from '../schemas';
import { recordAudit } from '../../services/audit';
import {
  createInvoiceDraft,
  findComplianceViolations,
  getInvoiceWithItems,
  recordInvoicePayment,
  updateInvoiceStatus,
} from '../../services/invoicing';

export const invoiceRoutes = new Hono<AppEnv>();

invoiceRoutes.use('*', requireAuth);

invoiceRoutes.get('/', requirePermission('invoices:read'), async (c) => {
  const { limit, offset, customerId, status } = parseQuery(
    new URL(c.req.url),
    invoiceListQuerySchema,
  );
  const db = createDb(c.env.DB);

  const conditions: SQL[] = [];
  if (customerId) conditions.push(eq(invoices.customerId, customerId));
  if (status) conditions.push(eq(invoices.status, status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(desc(invoices.issueDate))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: sql<number>`count(*)` }).from(invoices).where(where).get(),
  ]);

  return c.json({ data: rows, pagination: { limit, offset, total: Number(counted?.total ?? 0) } });
});

/** Invoice plus line items plus the live compliance verdict. */
invoiceRoutes.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = createDb(c.env.DB);
  const { invoice, items } = await getInvoiceWithItems(db, c.req.param('id'));
  const violations = await findComplianceViolations(db, invoice.id);

  return c.json({
    data: invoice,
    items,
    compliance: {
      satisfied: violations.length === 0,
      violations,
    },
  });
});

invoiceRoutes.get('/:id/compliance', requirePermission('invoices:read'), async (c) => {
  const db = createDb(c.env.DB);
  const invoice = await db.select().from(invoices).where(eq(invoices.id, c.req.param('id'))).get();
  if (!invoice) throw notFound('Invoice not found');

  const violations = await findComplianceViolations(db, invoice.id);
  return c.json({ satisfied: violations.length === 0, violations });
});

invoiceRoutes.post('/', requirePermission('invoices:write'), async (c) => {
  const input = await parseJson(c.req.raw, invoiceCreateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const invoice = await createInvoiceDraft(db, input, actor.id);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: invoice.id,
    metadata: {
      invoiceNumber: invoice.invoiceNumber,
      pricingTierKey: invoice.pricingTierKey,
      totalCents: invoice.totalCents,
    },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: invoice }, 201);
});

/**
 * Draft → Sent. This is the Iowa seed-compliance gate: the request fails with a
 * 422 listing every regulated seed line whose BOL/CMR and Order Number tokens
 * are missing or unverified.
 */
invoiceRoutes.post('/:id/send', requirePermission('invoices:send'), async (c) => {
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const invoice = await updateInvoiceStatus(db, id, 'sent', actor.id);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'invoice.sent',
    entityType: 'invoice',
    entityId: invoice.id,
    metadata: { invoiceNumber: invoice.invoiceNumber },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: invoice });
});

invoiceRoutes.post('/:id/cancel', requirePermission('invoices:cancel'), async (c) => {
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const invoice = await updateInvoiceStatus(db, id, 'canceled', actor.id);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'invoice.canceled',
    entityType: 'invoice',
    entityId: invoice.id,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: invoice });
});

invoiceRoutes.post('/:id/payments', requirePermission('invoices:write'), async (c) => {
  const { amountCents } = await parseJson(c.req.raw, invoiceRecordPaymentSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');

  const invoice = await recordInvoicePayment(db, c.req.param('id'), amountCents);

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'invoice.payment_recorded',
    entityType: 'invoice',
    entityId: invoice.id,
    metadata: { amountCents, balanceCents: invoice.balanceCents, status: invoice.status },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: invoice });
});
