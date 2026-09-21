import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb } from '../../db';
import { companySettings, customers, invoiceDeliveries, invoices } from '../../db/schema';
import type { AppEnv } from '../../env';
import { conflict, notFound, parseJson, parseQuery, unprocessable } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware';
import {
  invoiceCreateSchema,
  invoiceDeliverySchema,
  invoiceListQuerySchema,
  invoiceRecordPaymentSchema,
  invoiceUpdateSchema,
} from '../schemas';
import { diffFields, recordAudit } from '../../services/audit';
import { composeInvoiceEmail } from '../../services/invoice-email';
import { createMailer } from '../../services/mailer';
import {
  createInvoiceDraft,
  findComplianceViolations,
  getInvoiceComplianceTokens,
  getInvoiceWithItems,
  recordInvoicePayment,
  updateInvoice,
  updateInvoiceStatus,
} from '../../services/invoicing';

export const invoiceRoutes = new Hono<AppEnv>();

/** The parts of a line worth keeping in the audit trail. */
function compactLine(line: {
  lineType: string;
  description: string;
  quantity: number;
  unit: string | null;
  unitPriceCents: number;
  lineSubtotalCents: number;
}) {
  return {
    lineType: line.lineType,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPriceCents: line.unitPriceCents,
    lineSubtotalCents: line.lineSubtotalCents,
  };
}

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
  const [violations, complianceTokens] = await Promise.all([
    findComplianceViolations(db, invoice.id),
    getInvoiceComplianceTokens(db, invoice.id),
  ]);

  return c.json({
    data: invoice,
    items,
    complianceTokens,
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
 * Edits a Draft or Sent invoice: header fields, and — when `items` is supplied —
 * the whole line set.
 *
 * Both gates a Sent edit needs live in the service: seed compliance is re-checked
 * against the proposed lines before anything is written, and the stock ledger is
 * reconciled. This route only validates the payload and records the audit.
 */
invoiceRoutes.patch('/:id', requirePermission('invoices:write'), async (c) => {
  const input = await parseJson(c.req.raw, invoiceUpdateSchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const result = await updateInvoice(db, id, input, actor.id);

  // A header diff alone would miss an edit that swaps one line for another of
  // equal value, so the line set is snapshotted alongside it when it changed.
  const changes = diffFields(result.before, result.invoice, { ignore: ['updatedAt'] });
  if (Object.keys(changes).length > 0 || result.itemsReplaced) {
    await recordAudit(db, {
      actorUserId: actor.id,
      action: 'invoice.updated',
      entityType: 'invoice',
      entityId: id,
      metadata: {
        changes,
        ...(result.itemsReplaced
          ? {
              items: {
                before: result.linesBefore.map(compactLine),
                after: result.linesAfter.map(compactLine),
              },
            }
          : {}),
      },
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
    });
  }

  return c.json({ data: result.invoice });
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

invoiceRoutes.post('/:id/payments', requirePermission('invoices:write'), async (c) => {  const { amountCents } = await parseJson(c.req.raw, invoiceRecordPaymentSchema);
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

/** Delivery history, newest first. */
invoiceRoutes.get('/:id/deliveries', requirePermission('invoices:read'), async (c) => {
  const db = createDb(c.env.DB);

  const rows = await db
    .select()
    .from(invoiceDeliveries)
    .where(eq(invoiceDeliveries.invoiceId, c.req.param('id')))
    .orderBy(desc(invoiceDeliveries.createdAt))
    .all();

  return c.json({ data: rows });
});

/**
 * Delivers an invoice.
 *
 * For `email` this actually transmits; for `print` and `download` it records that
 * the document left the building. Email delivery is gated on Iowa seed compliance
 * for the same reason sending is: it puts a document in a customer's hands.
 */
invoiceRoutes.post('/:id/deliveries', requirePermission('invoices:send'), async (c) => {
  const input = await parseJson(c.req.raw, invoiceDeliverySchema);
  const db = createDb(c.env.DB);
  const actor = c.get('user');
  const id = c.req.param('id');

  const existing = await db.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!existing) throw notFound('Invoice not found');
  if (existing.status === 'canceled') throw conflict('Cannot deliver a canceled invoice');

  // Draft -> Sent is the compliance gate. An already-sent invoice has passed it.
  const invoice =
    existing.status === 'draft' ? await updateInvoiceStatus(db, id, 'sent', actor.id) : existing;

  const { items } = await getInvoiceWithItems(db, id);
  const complianceTokens = await getInvoiceComplianceTokens(db, id);

  const now = new Date();
  let destination: string | null = input.to?.trim() ?? null;
  let status = 'sent';
  let error: string | null = null;
  let providerMessageId: string | null = null;

  if (input.method === 'email') {
    if (!destination) {
      const customer = await db
        .select({ email: customers.email })
        .from(customers)
        .where(eq(customers.id, invoice.customerId))
        .get();
      destination = customer?.email ?? null;
    }

    if (!destination) {
      throw unprocessable('This customer has no email address. Add one, or supply a recipient.');
    }

    const company = await db.select().from(companySettings).limit(1).get();
    const message = composeInvoiceEmail({
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customerName,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        totalCents: invoice.totalCents,
        amountPaidCents: invoice.amountPaidCents,
        balanceCents: invoice.balanceCents,
        termsDays: invoice.termsDays,
        poNumber: invoice.poNumber,
      },
      company: {
        displayName: company?.displayName ?? 'AG Pro Solutions',
        legalName: company?.legalName ?? 'AG Pro Solutions LLC',
        phone: company?.phone ?? null,
        email: company?.email ?? null,
        addressLine1: company?.addressLine1 ?? null,
        city: company?.city ?? null,
        state: company?.state ?? null,
        postalCode: company?.postalCode ?? null,
      },
      itemCount: items.length,
      invoiceUrl: new URL(`/invoices/${id}/print`, c.req.url).toString(),
      complianceTokens: complianceTokens.map((token) => ({
        bolCmrNumber: token.bolCmrNumber,
        orderNumber: token.orderNumber,
      })),
    });

    const result = await createMailer(c.env).send({
      to: destination,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    if (result.ok) {
      providerMessageId = result.providerMessageId ?? null;
    } else {
      // A configured provider that refused is a failure; no provider at all is a
      // skipped delivery. Conflating the two would hide a misconfiguration.
      status = result.skipped ? 'skipped' : 'failed';
      error = result.error ?? 'Delivery failed';
    }
  }

  const [delivery] = await db
    .insert(invoiceDeliveries)
    .values({
      invoiceId: id,
      method: input.method,
      destination,
      providerMessageId,
      status,
      error,
      sentAt: status === 'sent' ? now : null,
    })
    .returning();

  await recordAudit(db, {
    actorUserId: actor.id,
    action: 'invoice.delivered',
    entityType: 'invoice',
    entityId: id,
    metadata: { method: input.method, destination, status, note: input.note ?? null },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ data: { delivery, invoice } }, status === 'failed' ? 502 : 201);
});
