import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { conflict, unprocessable } from '../api/lib/http';
import type { Database } from '../db';
import {
  importBatches,
  importDrafts,
  inventoryLots,
  iowaComplianceLogs,
  products,
  vendorBillItems,
  vendorBills,
  type ImportBatch,
  type ImportDraft,
} from '../db/schema';
import { UNITS, type ImportTarget, type Unit } from '../shared/enums';
import { recordAudit } from './audit';
import type { ParsedDocument } from './parsers/types';

/**
 * The ingestion review queue.
 *
 * A parser's output is never written to live inventory. It is staged as
 * `import_drafts` rows that an operator reviews, corrects, and then commits.
 * The queue is polymorphic — `target` names the destination table — so a new
 * import shape needs a schema and a case here, not a new table.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Unit normalisation
 *
 * Vendor documents print units freely ("Oz", "Gal", "1.000SP", "bottle"), so they
 * are mapped onto the canonical set before they reach the database.
 * ──────────────────────────────────────────────────────────────────────────── */

const UNIT_ALIASES: Record<string, Unit> = {
  sp: 'bag',
  bag: 'bag',
  bags: 'bag',
  seed: 'bag',
  gal: 'gal',
  gallon: 'gal',
  gallons: 'gal',
  qt: 'qt',
  quart: 'qt',
  pt: 'pt',
  pint: 'pt',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  bottle: 'bottle',
  bt: 'bottle',
  each: 'each',
  ea: 'each',
  unit: 'each',
  package: 'package',
  pkg: 'package',
  ton: 'ton',
  acre: 'acre',
  acres: 'acre',
  cwt: 'lb',
};

export function normalizeUnit(value: string | undefined | null): Unit | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  if ((UNITS as readonly string[]).includes(key)) return key as Unit;
  return UNIT_ALIASES[key];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Payload contracts, one per commit target
 * ──────────────────────────────────────────────────────────────────────────── */

const compliancePayload = z.object({
  customerId: z.string().min(1).optional(),
  productId: z.string().min(1).optional(),
  bolCmrNumber: z.string().trim().min(1).optional(),
  orderNumber: z.string().trim().min(1).optional(),
  seedNumber: z.string().trim().min(1).optional(),
  shipperNumber: z.string().trim().min(1).optional(),
  poNumber: z.string().trim().min(1).optional(),
  lotNumber: z.string().trim().min(1).optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  purchaseDate: z.coerce.date().optional(),
  documentId: z.string().min(1).optional(),
  verified: z.boolean().optional(),
});

const productPayload = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.enum(['chemical', 'seed', 'drone', 'misc']),
  brand: z.string().trim().optional(),
  manufacturer: z.string().trim().optional(),
  unit: z.string().optional(),
  packageSize: z.string().trim().optional(),
  epaNumber: z.string().trim().optional(),
  activeIngredient: z.string().trim().optional(),
  density: z.number().optional(),
  defaultCostCents: z.number().int().min(0).optional(),
  isRegulatedSeed: z.boolean().optional(),
  isSerialized: z.boolean().optional(),
});

const inventoryLotPayload = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1).optional(),
  lotNumber: z.string().trim().optional(),
  seedNumber: z.string().trim().optional(),
  quantityOnHand: z.number().optional(),
  unitCostCents: z.number().int().min(0).optional(),
  receivedAt: z.coerce.date().optional(),
  sourceVendorId: z.string().min(1).optional(),
  sourceDocumentId: z.string().min(1).optional(),
});

const vendorBillPayload = z.object({
  vendorId: z.string().min(1),
  billNumber: z.string().trim().min(1),
  poReference: z.string().trim().optional(),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  termsDays: z.number().int().min(0).optional(),
  subtotalCents: z.number().int().min(0).optional(),
  taxCents: z.number().int().min(0).optional(),
  totalCents: z.number().int().min(0).optional(),
  documentId: z.string().min(1).optional(),
  notes: z.string().optional(),
});

const vendorBillItemPayload = z.object({
  vendorBillId: z.string().min(1).optional(),
  itemCode: z.string().trim().optional(),
  description: z.string().trim().min(1),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  unitCostCents: z.number().int().min(0).optional(),
  amountCents: z.number().int().min(0).optional(),
  epaNumber: z.string().trim().optional(),
  lotNumber: z.string().trim().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const customerPayload = z.object({
  accountNumber: z.string().trim().min(1),
  name: z.string().trim().min(1),
  contactName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().optional(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Staging: parser output → draft rows
 * ──────────────────────────────────────────────────────────────────────────── */

export interface StagedDraft {
  target: ImportTarget;
  lineNumber?: number;
  confidence: number;
  parsedPayload: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  issues?: string[];
}

/**
 * Maps a parsed document onto reviewable drafts.
 *
 * A seed BOL becomes one Iowa compliance record per line (each carrying the two
 * audit tokens); a vendor invoice becomes one bill plus one bill-item draft per
 * line. Nothing is priced or posted until a human accepts it.
 */
export function stageDrafts(parsed: ParsedDocument, options: { vendorId?: string; documentId?: string } = {}): StagedDraft[] {
  const drafts: StagedDraft[] = [];
  const header = parsed.header;

  if (parsed.documentType === 'bol_seed') {
    for (const item of parsed.lineItems) {
      drafts.push({
        target: 'iowa_compliance_log',
        lineNumber: item.lineNumber,
        confidence: Math.min(item.confidence, parsed.confidence),
        parsedPayload: {
          bolCmrNumber: header.bolCmrNumber,
          orderNumber: header.orderNumber,
          seedNumber: header.seedNumber,
          shipperNumber: header.shipperNumber,
          poNumber: header.poNumber,
          lotNumber: item.lotNumber,
          quantity: item.quantity,
          unit: normalizeUnit(item.unit),
          purchaseDate: header.documentDate,
          documentId: options.documentId,
          source: 'bol_import',
          verified: false,
        },
        rawPayload: { description: item.description, itemCode: item.itemCode },
        issues: [
          !header.bolCmrNumber ? 'BOL/CMR Number missing from document header' : undefined,
          !header.orderNumber ? 'Order Number missing from document header' : undefined,
        ].filter((issue): issue is string => Boolean(issue)),
      });
    }
  }

  if (parsed.documentType === 'vendor_invoice') {
    drafts.push({
      target: 'vendor_bill',
      lineNumber: 0,
      confidence: parsed.confidence,
      parsedPayload: {
        vendorId: options.vendorId,
        billNumber: header.documentNumber,
        poReference: header.poNumber,
        billDate: header.documentDate,
        dueDate: header.dueDate,
        termsDays: header.termsDays,
        subtotalCents: header.subtotalCents,
        taxCents: header.taxCents,
        totalCents: header.totalCents,
        documentId: options.documentId,
      },
      issues: !header.documentNumber ? ['Invoice number missing — required before commit'] : [],
    });

    for (const item of parsed.lineItems) {
      drafts.push({
        target: 'vendor_bill_item',
        lineNumber: item.lineNumber,
        confidence: Math.min(item.confidence, parsed.confidence),
        parsedPayload: {
          itemCode: item.itemCode,
          description: item.description,
          quantity: item.quantity,
          unit: normalizeUnit(item.unit),
          unitCostCents: item.unitCostCents,
          amountCents: item.amountCents,
          epaNumber: item.epaNumber,
          lotNumber: item.lotNumber,
        },
        rawPayload: { raw: item.raw },
        issues: [],
      });
    }
  }

  return drafts;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Committing
 * ──────────────────────────────────────────────────────────────────────────── */

function parsePayload<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues: readonly { path: PropertyKey[]; message: string }[] } } }, payload: unknown, draftId: string): T {
  const result = schema.safeParse(payload);
  if (!result.success || result.data === undefined) {
    throw unprocessable(`Draft ${draftId} could not be committed: payload failed validation`, {
      draftId,
      issues: result.error?.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/** Inserts a single draft's payload into its target table. Returns the new row id. */
async function commitOne(
  db: Database,
  draft: ImportDraft,
  context: { vendorBillId?: string },
): Promise<string> {
  const payload = draft.parsedPayload;

  switch (draft.target) {
    case 'iowa_compliance_log': {
      const data = parsePayload(compliancePayload, payload, draft.id);
      const [row] = await db
        .insert(iowaComplianceLogs)
        .values({
          customerId: data.customerId ?? null,
          productId: data.productId ?? null,
          bolCmrNumber: data.bolCmrNumber ?? null,
          orderNumber: data.orderNumber ?? null,
          seedNumber: data.seedNumber ?? null,
          shipperNumber: data.shipperNumber ?? null,
          poNumber: data.poNumber ?? null,
          lotNumber: data.lotNumber ?? null,
          quantity: data.quantity ?? null,
          unit: normalizeUnit(data.unit) ?? null,
          purchaseDate: data.purchaseDate ?? null,
          source: 'bol_import',
          documentId: data.documentId ?? null,
          verified: false,
        })
        .returning({ id: iowaComplianceLogs.id });
      if (!row) throw conflict('Failed to insert compliance record');
      return row.id;
    }

    case 'product': {
      const data = parsePayload(productPayload, payload, draft.id);
      const [row] = await db
        .insert(products)
        .values({
          sku: data.sku,
          name: data.name,
          type: data.type,
          brand: data.brand ?? null,
          manufacturer: data.manufacturer ?? null,
          unit: normalizeUnit(data.unit) ?? 'each',
          packageSize: data.packageSize ?? null,
          epaNumber: data.epaNumber ?? null,
          activeIngredient: data.activeIngredient ?? null,
          density: data.density ?? null,
          defaultCostCents: data.defaultCostCents ?? null,
          isRegulatedSeed: data.isRegulatedSeed ?? false,
          isSerialized: data.isSerialized ?? false,
        })
        .returning({ id: products.id });
      if (!row) throw conflict('Failed to insert product');
      return row.id;
    }

    case 'inventory_lot': {
      const data = parsePayload(inventoryLotPayload, payload, draft.id);
      const [row] = await db
        .insert(inventoryLots)
        .values({
          productId: data.productId,
          warehouseId: data.warehouseId ?? null,
          lotNumber: data.lotNumber ?? null,
          seedNumber: data.seedNumber ?? null,
          quantityOnHand: data.quantityOnHand ?? 0,
          unitCostCents: data.unitCostCents ?? null,
          receivedAt: data.receivedAt ?? new Date(),
          sourceVendorId: data.sourceVendorId ?? null,
          sourceDocumentId: data.sourceDocumentId ?? null,
        })
        .returning({ id: inventoryLots.id });
      if (!row) throw conflict('Failed to insert inventory lot');
      return row.id;
    }

    case 'vendor_bill': {
      const data = parsePayload(vendorBillPayload, payload, draft.id);
      const totalCents = data.totalCents ?? 0;
      const [row] = await db
        .insert(vendorBills)
        .values({
          vendorId: data.vendorId,
          billNumber: data.billNumber,
          poReference: data.poReference ?? null,
          billDate: data.billDate,
          dueDate: data.dueDate ?? null,
          termsDays: data.termsDays ?? null,
          subtotalCents: data.subtotalCents ?? totalCents,
          taxCents: data.taxCents ?? 0,
          totalCents,
          balanceCents: totalCents,
          status: 'open',
          documentId: data.documentId ?? null,
          notes: data.notes ?? null,
        })
        .returning({ id: vendorBills.id });
      if (!row) throw conflict('Failed to insert vendor bill');
      return row.id;
    }

    case 'vendor_bill_item': {
      const data = parsePayload(vendorBillItemPayload, payload, draft.id);
      const vendorBillId = data.vendorBillId ?? context.vendorBillId;
      if (!vendorBillId) {
        throw unprocessable(
          'Cannot commit a bill item without a vendor bill. Commit the bill in the same batch.',
          { draftId: draft.id },
        );
      }
      const [row] = await db
        .insert(vendorBillItems)
        .values({
          vendorBillId,
          itemCode: data.itemCode ?? null,
          description: data.description,
          quantity: data.quantity ?? null,
          unit: normalizeUnit(data.unit) ?? null,
          unitCostCents: data.unitCostCents ?? null,
          amountCents: data.amountCents ?? null,
          epaNumber: data.epaNumber ?? null,
          lotNumber: data.lotNumber ?? null,
          sortOrder: data.sortOrder ?? draft.lineNumber ?? 0,
        })
        .returning({ id: vendorBillItems.id });
      if (!row) throw conflict('Failed to insert vendor bill item');
      return row.id;
    }

    case 'customer': {
      const data = parsePayload(customerPayload, payload, draft.id);
      throw unprocessable(
        `Committing ${draft.target} from the import queue is not enabled yet; create it through the CRM API`,
        { draftId: draft.id, attempted: data.accountNumber },
      );
    }

    default:
      throw unprocessable(`Unsupported commit target "${draft.target}"`, { draftId: draft.id });
  }
}

/** True when a draft is in a state that may be committed. */
function isCommittable(draft: ImportDraft): boolean {
  return draft.status === 'accepted' || draft.status === 'edited';
}

export interface CommitResult {
  batchId: string;
  committed: { draftId: string; target: string; recordId: string }[];
  skipped: { draftId: string; target: string; reason: string }[];
}

/**
 * Commits a batch's drafts.
 *
 * Bills are committed before bill items so that item drafts can inherit the newly
 * created bill id, and a partial failure is reported per draft rather than
 * aborting the whole batch.
 */
export async function commitBatch(
  db: Database,
  batchId: string,
  options: { draftIds?: string[]; actorUserId: string },
): Promise<CommitResult> {
  const batch = await db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) throw unprocessable(`Import batch ${batchId} not found`);
  if (batch.status === 'committed') throw conflict('This batch has already been committed');

  const all = await db.select().from(importDrafts).where(eq(importDrafts.batchId, batchId)).all();

  const selected = options.draftIds
    ? all.filter((draft) => options.draftIds?.includes(draft.id))
    : all.filter(isCommittable);

  if (selected.length === 0) {
    throw unprocessable('No drafts are ready to commit. Accept or edit drafts first.');
  }

  const ordered = [...selected].sort((a, b) => {
    const rank = (target: string) => (target === 'vendor_bill' ? 0 : 1);
    return rank(a.target) - rank(b.target);
  });

  const committed: CommitResult['committed'] = [];
  const skipped: CommitResult['skipped'] = [];
  let vendorBillId: string | undefined;

  for (const draft of ordered) {
    try {
      const recordId = await commitOne(db, draft, { vendorBillId });
      if (draft.target === 'vendor_bill') vendorBillId = recordId;

      await db
        .update(importDrafts)
        .set({
          status: 'accepted',
          committedRecordId: recordId,
          reviewedByUserId: options.actorUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(importDrafts.id, draft.id));

      committed.push({ draftId: draft.id, target: draft.target, recordId });
    } catch (error) {
      skipped.push({
        draftId: draft.id,
        target: draft.target,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const committedCount = batch.committedCount + committed.length;
  const stillPending = all.filter((draft) => !committed.some((entry) => entry.draftId === draft.id)).length;

  await db
    .update(importBatches)
    .set({
      status: stillPending === 0 ? 'committed' : 'in_review',
      committedCount,
      committedAt: stillPending === 0 ? new Date() : batch.committedAt,
      committedByUserId: options.actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(importBatches.id, batchId));

  await recordAudit(db, {
    actorUserId: options.actorUserId,
    action: 'import_batch.committed',
    entityType: 'import_batch',
    entityId: batchId,
    metadata: { committed: committed.length, skipped: skipped.length },
  });

  return { batchId, committed, skipped };
}

/** Marks every pending draft in a batch as rejected. */
export async function rejectBatch(
  db: Database,
  batchId: string,
  actorUserId: string,
): Promise<ImportBatch> {
  const batch = await db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) throw unprocessable(`Import batch ${batchId} not found`);

  const drafts = await db.select().from(importDrafts).where(eq(importDrafts.batchId, batchId)).all();
  const pendingIds = drafts.filter((draft) => draft.status === 'pending').map((draft) => draft.id);

  if (pendingIds.length > 0) {
    await db
      .update(importDrafts)
      .set({ status: 'rejected', reviewedByUserId: actorUserId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(inArray(importDrafts.id, pendingIds));
  }

  const [updated] = await db
    .update(importBatches)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(eq(importBatches.id, batchId))
    .returning();

  if (!updated) throw conflict('Failed to reject batch');
  return updated;
}
