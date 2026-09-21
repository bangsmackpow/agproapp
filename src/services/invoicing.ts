import { eq, inArray, sql } from 'drizzle-orm';

import { conflict, notFound, unprocessable } from '../api/lib/http';
import type { InvoiceCreateInput, InvoiceUpdateInput } from '../api/schemas';
import type { Database } from '../db';
import {
  applicationPrograms,
  companySettings,
  customers,
  invoiceItems,
  invoiceSequences,
  invoices,
  iowaComplianceLogs,
  products,
  type Invoice,
  type InvoiceItem,
  type PriceTier,
  type Product,
} from '../db/schema';
import type { InvoiceStatus, PriceTierKey } from '../shared/enums';
import {
  acreageTotalCents,
  lineTotalCents,
  marginPercent,
  sumCents,
  taxCents,
} from '../shared/pricing';
import { findApplicationFee, findProgramPrice, getTierByKey } from './pricing';
import { consumeForInvoice, reverseForInvoice } from './inventory';

/* ────────────────────────────────────────────────────────────────────────────
 * Pure totals math — no database access, so it is exhaustively unit-testable.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PricedLine {
  lineSubtotalCents: number;
  discountCents: number;
  taxable: boolean;
}

export interface InvoiceTotals {
  subtotalCents: number;
  discountCents: number;
  taxableBaseCents: number;
  taxCents: number;
  totalCents: number;
  balanceCents: number;
}

/**
 * Computes invoice totals.
 *
 * An invoice-level discount is apportioned across taxable and non-taxable lines
 * in proportion to their share of the subtotal, so tax is never under-collected
 * by discounting a non-taxable line.
 */
export function calculateInvoiceTotals(
  lines: readonly PricedLine[],
  options: { taxRate: number; discountCents?: number; amountPaidCents?: number },
): InvoiceTotals {
  const subtotalCents = sumCents(lines.map((line) => line.lineSubtotalCents));
  const lineDiscountCents = sumCents(lines.map((line) => line.discountCents));
  const invoiceDiscountCents = options.discountCents ?? 0;

  const discountCents = Math.min(subtotalCents, lineDiscountCents + invoiceDiscountCents);
  const taxableGrossCents = sumCents(
    lines.filter((line) => line.taxable).map((line) => line.lineSubtotalCents),
  );

  const taxableShare = subtotalCents > 0 ? taxableGrossCents / subtotalCents : 0;
  const taxableBaseCents = Math.max(0, Math.round(taxableGrossCents - discountCents * taxableShare));

  const computedTaxCents = taxCents(taxableBaseCents, options.taxRate);
  const totalCents = Math.max(0, subtotalCents - discountCents + computedTaxCents);
  const balanceCents = Math.max(0, totalCents - (options.amountPaidCents ?? 0));

  return {
    subtotalCents,
    discountCents,
    taxableBaseCents,
    taxCents: computedTaxCents,
    totalCents,
    balanceCents,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Numbering
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Allocates the next invoice number.
 *
 * The increment happens inside a single `UPDATE … RETURNING`, so two concurrent
 * requests cannot observe the same counter value.
 */
export async function allocateInvoiceNumber(db: Database, scope = 'default'): Promise<string> {
  const [row] = await db
    .update(invoiceSequences)
    .set({ nextNumber: sql`${invoiceSequences.nextNumber} + 1`, updatedAt: new Date() })
    .where(eq(invoiceSequences.scope, scope))
    .returning({
      allocated: sql<number>`${invoiceSequences.nextNumber} - 1`,
      prefix: invoiceSequences.prefix,
    });

  if (!row) throw conflict(`No invoice sequence configured for scope "${scope}"`);

  return `${row.prefix}-${String(Number(row.allocated)).padStart(5, '0')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Line pricing
 * ──────────────────────────────────────────────────────────────────────────── */

/** Flat per-product price fallback, selected by tier. Returns undefined if unset. */
function productFallbackPrice(product: Product, tierKey: PriceTierKey): number | undefined {
  switch (tierKey) {
    case 'financed_app':
      return product.financedAppPriceCents ?? undefined;
    case 'cash_app':
      return product.cashAppPriceCents ?? undefined;
    case 'cash_carry':
    case 'finance_carry':
      return product.carryPriceCents ?? undefined;
  }
}

interface ResolvedLine {
  values: Omit<InvoiceItem, 'id' | 'invoiceId' | 'createdAt' | 'updatedAt'>;
}

async function resolveLine(
  db: Database,
  line: InvoiceCreateInput['items'][number],
  options: { tier: PriceTier; on: Date; sortOrder: number },
): Promise<ResolvedLine> {
  const { tier, on, sortOrder } = options;

  /* ── Blend / program line: priced per acre from program_prices ─────────── */
  if (line.lineType === 'program') {
    const programId = line.programId as string;

    const program = await db
      .select()
      .from(applicationPrograms)
      .where(eq(applicationPrograms.id, programId))
      .get();
    if (!program) throw notFound(`Application program ${programId} not found`);

    const price = await findProgramPrice(db, { programId, tierId: tier.id, on });
    if (!price) {
      throw unprocessable(
        `No ${tier.label} price is configured for program "${program.name}" as of ${on.toISOString().slice(0, 10)}`,
      );
    }

    const acres = line.acres ?? line.quantity;
    const unitCostCents = price.costPerAcreCents ?? line.unitCostCents ?? undefined;

    return {
      values: {
        lineType: 'program',
        programId,
        productId: null,
        applicationFeeId: null,
        applicationMethod: line.applicationMethod ?? program.defaultApplicationMethod,
        // Derived rather than required from the caller: the program is loaded right
        // here, so its name is the authoritative description and the client cannot
        // get it wrong or send a placeholder.
        description: line.description?.trim() || program.name,
        quantity: acres,
        unit: 'acre',
        acres,
        unitPriceCents: price.pricePerAcreCents,
        unitCostCents: unitCostCents ?? null,
        marginPercent:
          unitCostCents === undefined
            ? null
            : marginPercent(price.pricePerAcreCents, unitCostCents),
        lineSubtotalCents: acreageTotalCents(acres, price.pricePerAcreCents),
        discountCents: 0,
        taxable: line.taxable ?? true,
        lotNumber: line.lotNumber ?? null,
        complianceLogId: line.complianceLogId ?? null,
        sortOrder: line.sortOrder ?? sortOrder,
      },
    };
  }

  /* ── Application fee line: priced per acre from application_fees ────────── */
  if (line.lineType === 'application_fee') {
    const fee = await findApplicationFee(db, {
      applicationFeeId: line.applicationFeeId,
      method: line.applicationMethod,
      on,
    });
    if (!fee) throw notFound('No matching application fee is configured');

    const acres = line.acres ?? line.quantity;
    const unitPriceCents = line.unitPriceCents ?? fee.pricePerAcreCents;

    return {
      values: {
        lineType: 'application_fee',
        applicationFeeId: fee.id,
        programId: null,
        productId: null,
        applicationMethod: fee.method,
        description: line.description?.trim() || fee.label,
        quantity: acres,
        unit: 'acre',
        acres,
        unitPriceCents,
        unitCostCents: line.unitCostCents ?? null,
        marginPercent: null,
        lineSubtotalCents: acreageTotalCents(acres, unitPriceCents),
        discountCents: 0,
        taxable: line.taxable ?? true,
        lotNumber: null,
        complianceLogId: null,
        sortOrder: line.sortOrder ?? sortOrder,
      },
    };
  }

  /* ── Product / package / misc: explicit price, else tier fallback ──────── */
  let product: Product | undefined;
  if (line.productId) {
    product = await db.select().from(products).where(eq(products.id, line.productId)).get();
    if (!product) throw notFound(`Product ${line.productId} not found`);
  }

  // Derived from the product when there is one. A misc line has no product, so for
  // those the description must come from the caller and the schema already required
  // it — this is the belt to that braces, since the service can be called directly
  // and an empty description would otherwise reach the database. Resolved before the
  // price check so the refusal below can name the line.
  const description = line.description?.trim() || product?.name;
  if (!description) {
    throw unprocessable('A line with no product requires a description');
  }

  const unitPriceCents =
    line.unitPriceCents ?? (product ? productFallbackPrice(product, tier.key) : undefined);

  if (unitPriceCents === undefined) {
    throw unprocessable(
      `Line "${description}" has no price for tier "${tier.label}" and none was supplied`,
    );
  }

  const unitCostCents = line.unitCostCents ?? product?.defaultCostCents ?? undefined;
  const lineSubtotalCents = lineTotalCents(line.quantity, unitPriceCents);

  return {
    values: {
      lineType: line.lineType,
      productId: product?.id ?? null,
      programId: null,
      applicationFeeId: null,
      applicationMethod: line.applicationMethod ?? null,
      description,
      quantity: line.quantity,
      unit: line.unit ?? product?.unit ?? null,
      acres: line.acres ?? null,
      unitPriceCents,
      unitCostCents: unitCostCents ?? null,
      marginPercent: unitCostCents === undefined ? null : marginPercent(unitPriceCents, unitCostCents),
      lineSubtotalCents,
      discountCents: 0,
      taxable: line.taxable ?? product?.taxable ?? true,
      lotNumber: line.lotNumber ?? null,
      complianceLogId: line.complianceLogId ?? null,
      sortOrder: line.sortOrder ?? sortOrder,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Draft creation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a Draft invoice with priced line items.
 *
 * Drafts are intentionally permitted to be non-compliant; the seed-compliance
 * gate is enforced on the Draft → Sent transition by `updateInvoiceStatus`.
 */
export async function createInvoiceDraft(
  db: Database,
  input: InvoiceCreateInput,
  actorUserId: string,
): Promise<Invoice> {
  const customer = await db.select().from(customers).where(eq(customers.id, input.customerId)).get();
  if (!customer) throw notFound(`Customer ${input.customerId} not found`);
  if (!customer.isActive) throw unprocessable(`Customer "${customer.name}" is inactive`);

  const tier = await getTierByKey(db, input.pricingTierKey);
  const settings = await db.select().from(companySettings).limit(1).get();

  const issueDate = input.issueDate ?? new Date();
  const termsDays = input.termsDays ?? customer.defaultTermsDays ?? settings?.invoiceTermsDays ?? 30;
  const dueDate = input.dueDate ?? new Date(issueDate.getTime() + termsDays * 86_400_000);

  const resolved = await Promise.all(
    input.items.map((line, index) => resolveLine(db, line, { tier, on: issueDate, sortOrder: index })),
  );

  const totals = calculateInvoiceTotals(
    resolved.map((line) => ({
      lineSubtotalCents: line.values.lineSubtotalCents,
      discountCents: line.values.discountCents,
      taxable: line.values.taxable && !customer.taxExempt,
    })),
    {
      taxRate: customer.taxExempt ? 0 : (settings?.defaultTaxRate ?? 0),
      discountCents: input.discountCents ?? 0,
    },
  );

  const invoiceNumber = await allocateInvoiceNumber(db);
  const now = new Date();

  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber,
      customerId: customer.id,
      status: 'draft',
      pricingTierId: tier.id,
      pricingTierKey: tier.key,
      issueDate,
      dueDate,
      termsDays,
      poNumber: input.poNumber ?? null,

      customerName: customer.name,
      billLine1: customer.billLine1,
      billLine2: customer.billLine2,
      billCity: customer.billCity,
      billState: customer.billState,
      billPostalCode: customer.billPostalCode,
      shipLine1: customer.shipLine1,
      shipLine2: customer.shipLine2,
      shipCity: customer.shipCity,
      shipState: customer.shipState,
      shipPostalCode: customer.shipPostalCode,

      serviceAcres: input.serviceAcres ?? null,
      applicationMethod: input.applicationMethod ?? null,

      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxRate: customer.taxExempt ? 0 : (settings?.defaultTaxRate ?? 0),
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      amountPaidCents: 0,
      balanceCents: totals.balanceCents,

      notes: input.notes ?? null,
      internalNotes: input.internalNotes ?? null,
      createdByUserId: actorUserId,
      updatedAt: now,
    })
    .returning();

  if (!invoice) throw conflict('Failed to create invoice');

  await db
    .insert(invoiceItems)
    .values(resolved.map((line) => ({ ...line.values, invoiceId: invoice.id })));

  return invoice;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Editing
 * ──────────────────────────────────────────────────────────────────────────── */

export interface InvoiceUpdateResult {
  invoice: Invoice;
  /** The row as it was, for the audit diff. */
  before: Invoice;
  linesBefore: InvoiceItem[];
  linesAfter: InvoiceItem[];
  /** True when `items` was supplied and the whole line set was replaced. */
  itemsReplaced: boolean;
  /** Movements written to the stock ledger (reversal + re-consumption). */
  stockMovements: number;
}

/**
 * Edits a Draft or Sent invoice.
 *
 * Only those two statuses are editable: `paid` is settled and `canceled` is
 * terminal, and either would need a credit path rather than an edit.
 *
 * Two consequences of editing a **Sent** invoice are handled here rather than in
 * the route, because both are business rules:
 *
 * 1. **Seed compliance is re-checked before anything is written.** The gate runs
 *    on `draft → sent`, so an edit could otherwise leave a document that has
 *    already reached a customer without the BOL/CMR and Order Number tokens it
 *    needs. A violating edit is refused and the document is left untouched.
 * 2. **Stock is reconciled.** Sending consumed the lines, so the new lines have
 *    to leave the pool in the same state. The outstanding effect is reversed
 *    first, then the final set consumed, so a failure part-way can only ever
 *    leave stock *over*-available — never oversold.
 *
 * Totals always recompute; a discount-only edit is a real edit. The balance is
 * floored at zero and the status is left alone, so an edit that drops the total
 * below what was paid does not silently refund or re-open anything.
 */
export async function updateInvoice(
  db: Database,
  invoiceId: string,
  input: InvoiceUpdateInput,
  actorUserId: string,
): Promise<InvoiceUpdateResult> {
  const before = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!before) throw notFound(`Invoice ${invoiceId} not found`);

  if (before.status !== 'draft' && before.status !== 'sent') {
    throw conflict(`A ${before.status} invoice cannot be edited`);
  }

  const itemsReplaced = input.items !== undefined;

  const linesBefore = itemsReplaced
    ? await db
        .select()
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, invoiceId))
        .orderBy(invoiceItems.sortOrder)
        .all()
    : [];

  // Re-price only when the lines change. The pricing date is the invoice's own
  // issue date, so an edit months later still resolves the price that applied.
  let tier: PriceTier | undefined;
  let resolved: ResolvedLine[] | undefined;

  if (input.items) {
    const tierKey = input.pricingTierKey ?? before.pricingTierKey;
    if (!tierKey) {
      throw unprocessable('This invoice has no pricing tier; set one before editing its lines');
    }

    const resolvedTier = await getTierByKey(db, tierKey);
    tier = resolvedTier;

    resolved = await Promise.all(
      input.items.map((line, index) =>
        resolveLine(db, line, { tier: resolvedTier, on: before.issueDate, sortOrder: index }),
      ),
    );
  }

  // A sent invoice must not be left non-compliant. Checked against the proposed
  // lines, before the write, so a refusal leaves the document untouched.
  if (before.status === 'sent' && resolved) {
    const violations = await violationsForLines(
      db,
      resolved.map((line, index) => ({
        invoiceItemId: `line-${index}`,
        productId: line.values.productId,
        complianceLogId: line.values.complianceLogId,
        description: line.values.description,
      })),
    );

    if (violations.length > 0) {
      throw unprocessable(
        'This edit would leave a sent invoice failing Iowa seed compliance: BOL/CMR Number and Order Number must be verified on every regulated seed line',
        violations,
      );
    }
  }

  const effectiveDiscountCents = input.discountCents ?? before.discountCents;
  const effectiveLines = resolved
    ? resolved.map((line) => line.values)
    : await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all();

  const totals = calculateInvoiceTotals(
    effectiveLines.map((line) => ({
      lineSubtotalCents: line.lineSubtotalCents,
      discountCents: line.discountCents,
      taxable: line.taxable,
    })),
    {
      taxRate: before.taxRate,
      discountCents: effectiveDiscountCents,
      amountPaidCents: before.amountPaidCents,
    },
  );

  const now = new Date();

  const patch: Partial<typeof invoices.$inferInsert> = {
    pricingTierId: tier ? tier.id : before.pricingTierId,
    pricingTierKey: tier ? tier.key : before.pricingTierKey,
    dueDate: input.dueDate ?? before.dueDate,
    termsDays: input.termsDays ?? before.termsDays,
    poNumber: input.poNumber !== undefined ? input.poNumber : before.poNumber,
    serviceAcres: input.serviceAcres !== undefined ? input.serviceAcres : before.serviceAcres,
    applicationMethod:
      input.applicationMethod !== undefined ? input.applicationMethod : before.applicationMethod,
    discountCents: effectiveDiscountCents,
    notes: input.notes !== undefined ? input.notes : before.notes,
    internalNotes: input.internalNotes !== undefined ? input.internalNotes : before.internalNotes,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    balanceCents: totals.balanceCents,
    updatedAt: now,
  };

  if (resolved) {
    // Delete + insert in one batch. D1 has no interactive transaction, and a
    // crash between the two would otherwise leave the invoice with no lines.
    await db.batch([
      db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)),
      db.insert(invoiceItems).values(resolved.map((line) => ({ ...line.values, invoiceId }))),
    ]);
  }

  const [updated] = await db
    .update(invoices)
    .set(patch)
    .where(eq(invoices.id, invoiceId))
    .returning();

  if (!updated) throw conflict('Failed to update invoice');

  // Stock follows the document. A draft has moved nothing yet.
  let stockMovements = 0;
  if (before.status === 'sent' && resolved) {
    await reverseForInvoice(db, invoiceId, actorUserId, now);
    stockMovements = await consumeForInvoice(
      db,
      invoiceId,
      resolved.map((line) => line.values),
      actorUserId,
      now,
    );
  }

  const linesAfter = resolved
    ? await db
        .select()
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, invoiceId))
        .orderBy(invoiceItems.sortOrder)
        .all()
    : [];

  return {
    invoice: updated,
    before,
    linesBefore,
    linesAfter,
    itemsReplaced,
    stockMovements,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Seed-compliance gate
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ComplianceViolation {
  invoiceItemId: string;
  description: string;
  reason: string;
}

/** A line to check, whether or not it has been written yet. */
interface ComplianceLine {
  /** A real item id, or a synthetic one for a line still being resolved. */
  invoiceItemId: string;
  productId: string | null;
  complianceLogId: string | null;
  description: string;
}

/**
 * Every line whose product is a regulated seed must reference a *verified*
 * compliance log carrying the BOL/CMR and Order Number tokens.
 *
 * Takes lines rather than an invoice id so it can check a proposed edit **before**
 * anything is written — a sent invoice must not be left non-compliant by an edit
 * that then has to be undone. Returns the violations rather than throwing, so the
 * caller decides how to surface them.
 */
async function violationsForLines(
  db: Database,
  lines: readonly ComplianceLine[],
): Promise<ComplianceViolation[]> {
  if (lines.length === 0) return [];

  const productIds = [...new Set(lines.map((line) => line.productId).filter((id): id is string => Boolean(id)))];
  const regulated = new Set<string>();

  if (productIds.length > 0) {
    const rows = await db
      .select({ id: products.id, isRegulatedSeed: products.isRegulatedSeed })
      .from(products)
      .where(inArray(products.id, productIds))
      .all();

    for (const row of rows) if (row.isRegulatedSeed) regulated.add(row.id);
  }

  const logIds = [...new Set(lines.map((line) => line.complianceLogId).filter((id): id is string => Boolean(id)))];
  const verifiedLogs = new Set<string>();

  if (logIds.length > 0) {
    const rows = await db
      .select({ id: iowaComplianceLogs.id, verified: iowaComplianceLogs.verified })
      .from(iowaComplianceLogs)
      .where(inArray(iowaComplianceLogs.id, logIds))
      .all();

    for (const row of rows) if (row.verified) verifiedLogs.add(row.id);
  }

  const violations: ComplianceViolation[] = [];

  for (const line of lines) {
    const isRegulated = line.productId !== null && regulated.has(line.productId);
    if (!isRegulated) continue;

    if (!line.complianceLogId) {
      violations.push({
        invoiceItemId: line.invoiceItemId,
        description: line.description,
        reason: 'Regulated seed line has no BOL/CMR + Order Number record attached',
      });
      continue;
    }

    if (!verifiedLogs.has(line.complianceLogId)) {
      violations.push({
        invoiceItemId: line.invoiceItemId,
        description: line.description,
        reason: 'Attached BOL/CMR + Order Number record is not verified',
      });
    }
  }

  return violations;
}

/** The live verdict for a stored invoice. */
export async function findComplianceViolations(
  db: Database,
  invoiceId: string,
): Promise<ComplianceViolation[]> {
  const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all();

  return violationsForLines(
    db,
    items.map((item) => ({
      invoiceItemId: item.id,
      productId: item.productId,
      complianceLogId: item.complianceLogId,
      description: item.description,
    })),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Lifecycle
 * ──────────────────────────────────────────────────────────────────────────── */

const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['sent', 'canceled'],
  sent: ['paid', 'canceled'],
  paid: [],
  canceled: [],
};

/**
 * Moves an invoice through its lifecycle.
 *
 * Draft → Sent is the compliance gate: it fails with a 422 listing every
 * regulated seed line that lacks verified BOL/CMR and Order Number tokens.
 */
export async function updateInvoiceStatus(
  db: Database,
  invoiceId: string,
  nextStatus: InvoiceStatus,
  actorUserId: string,
): Promise<Invoice> {
  const invoice = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw notFound(`Invoice ${invoiceId} not found`);

  if (invoice.status === nextStatus) return invoice;

  const allowed = ALLOWED_TRANSITIONS[invoice.status];
  if (!allowed.includes(nextStatus)) {
    throw conflict(`Cannot move invoice from "${invoice.status}" to "${nextStatus}"`);
  }

  const now = new Date();
  const patch: Partial<typeof invoices.$inferInsert> = { status: nextStatus, updatedAt: now };

  if (nextStatus === 'sent') {
    const violations = await findComplianceViolations(db, invoiceId);
    if (violations.length > 0) {
      throw unprocessable(
        'Iowa seed compliance is not satisfied: BOL/CMR Number and Order Number must be verified before this invoice can be sent',
        violations,
      );
    }

    if (invoice.totalCents === 0) {
      throw unprocessable('Cannot send an invoice with a zero total');
    }

    patch.sentAt = now;
    patch.complianceVerifiedAt = now;
    patch.complianceVerifiedByUserId = actorUserId;
  }

  if (nextStatus === 'paid') {
    patch.paidAt = now;
    patch.amountPaidCents = invoice.totalCents;
    patch.balanceCents = 0;
  }

  if (nextStatus === 'canceled') patch.canceledAt = now;

  const [updated] = await db.update(invoices).set(patch).where(eq(invoices.id, invoiceId)).returning();
  if (!updated) throw conflict('Failed to update invoice');

  // Stock moves as a consequence of the document, not of the API call: sending
  // consumes, cancelling reverses. Both are written to the ledger, which is
  // append-only, so a correction is a new movement rather than an edit.
  if (nextStatus === 'sent') {
    const items = await db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .all();

    await consumeForInvoice(db, invoiceId, items, actorUserId, now);
  }

  if (nextStatus === 'canceled') {
    await reverseForInvoice(db, invoiceId, actorUserId, now);
  }

  return updated;
}

/** Applies a payment and flips the invoice to Paid once the balance clears. */
export async function recordInvoicePayment(
  db: Database,
  invoiceId: string,
  amountCents: number,
): Promise<Invoice> {
  const invoice = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw notFound(`Invoice ${invoiceId} not found`);
  if (invoice.status === 'canceled') throw conflict('Cannot pay a canceled invoice');

  /*
   * A payment must not be a back door around sending.
   *
   * Sending is where the Iowa seed-compliance gate is enforced and where stock is
   * consumed, and both hang off the `draft -> sent` transition. Letting a draft be
   * marked paid here would skip them: the invoice would report as settled without
   * its BOL/CMR and Order Number ever being verified, and without drawing down the
   * inventory it shipped. The UI only offers this button on a sent invoice, but the
   * API is the authority, so the guard has to live here.
   */
  if (invoice.status !== 'sent' && invoice.status !== 'paid') {
    throw conflict(`Cannot record a payment on a ${invoice.status} invoice. Send it first.`);
  }

  const amountPaidCents = invoice.amountPaidCents + amountCents;
  const balanceCents = Math.max(0, invoice.totalCents - amountPaidCents);
  const now = new Date();

  const [updated] = await db
    .update(invoices)
    .set({
      amountPaidCents,
      balanceCents,
      status: balanceCents === 0 ? 'paid' : invoice.status,
      paidAt: balanceCents === 0 ? now : invoice.paidAt,
      updatedAt: now,
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  if (!updated) throw conflict('Failed to record payment');
  return updated;
}

/** Loads an invoice together with its line items. */
export async function getInvoiceWithItems(db: Database, invoiceId: string) {
  const invoice = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw notFound(`Invoice ${invoiceId} not found`);

  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(invoiceItems.sortOrder)
    .all();

  return { invoice, items };
}

/** Recomputes and persists totals, e.g. after a line was edited. */
export async function recalculateInvoice(db: Database, invoiceId: string): Promise<Invoice> {
  const invoice = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw notFound(`Invoice ${invoiceId} not found`);

  const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all();

  const totals = calculateInvoiceTotals(
    items.map((item) => ({
      lineSubtotalCents: item.lineSubtotalCents,
      discountCents: item.discountCents,
      taxable: item.taxable,
    })),
    {
      taxRate: invoice.taxRate,
      discountCents: invoice.discountCents,
      amountPaidCents: invoice.amountPaidCents,
    },
  );

  const [updated] = await db
    .update(invoices)
    .set({
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      balanceCents: totals.balanceCents,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  if (!updated) throw conflict('Failed to recalculate invoice');
  return updated;
}

/** Convenience predicate used by the UI to explain why submission is blocked. */
export async function isCompliant(db: Database, invoiceId: string): Promise<boolean> {
  return (await findComplianceViolations(db, invoiceId)).length === 0;
}

export interface InvoiceComplianceToken {
  invoiceItemId: string;
  description: string;
  bolCmrNumber: string | null;
  orderNumber: string | null;
  seedNumber: string | null;
  lotNumber: string | null;
  verified: boolean;
}

/**
 * The audit tokens attached to an invoice's regulated lines.
 *
 * Printed on the invoice so the BOL/CMR and Order Number travel with the
 * document that was actually sold — which is what an Iowa seed audit asks for.
 */
export async function getInvoiceComplianceTokens(
  db: Database,
  invoiceId: string,
): Promise<InvoiceComplianceToken[]> {
  const rows = await db
    .select({
      invoiceItemId: invoiceItems.id,
      description: invoiceItems.description,
      bolCmrNumber: iowaComplianceLogs.bolCmrNumber,
      orderNumber: iowaComplianceLogs.orderNumber,
      seedNumber: iowaComplianceLogs.seedNumber,
      lotNumber: iowaComplianceLogs.lotNumber,
      verified: iowaComplianceLogs.verified,
    })
    .from(invoiceItems)
    .innerJoin(iowaComplianceLogs, eq(iowaComplianceLogs.id, invoiceItems.complianceLogId))
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .all();

  return rows;
}
