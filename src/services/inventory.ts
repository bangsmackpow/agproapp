import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  customers,
  inventoryLots,
  inventoryMovements,
  invoices,
  products,
  programIngredients,
  units,
  type InventoryMovement,
  type NewInventoryMovement,
} from '../db/schema';
import type { MovementReferenceType } from '../shared/enums';
import { convertWithinDimension } from './units';

/**
 * Stock, as an append-only ledger.
 *
 * Pooling is the model: a gallon of herbicide is a gallon of herbicide, so stock
 * is a single quantity per product rather than a set of buckets an operator has to
 * pick between when selling. Receipts still record provenance and cost, and FIFO
 * allocation draws on them behind the scenes for cost of goods sold.
 */

/** Floating-point comparisons throughout: quantities are REAL. */
const EPSILON = 1e-9;

export interface Receipt {
  lotId: string | null;
  /** What is still available on this receipt, in the product's base unit. */
  remaining: number;
  unitCostCents: number | null;
  /** Ordering key; FIFO draws on the oldest first. */
  occurredAt: number;
}

export interface Allocation {
  /** Null when there was no receipt to draw on — the pool went negative. */
  lotId: string | null;
  quantity: number;
  unitCostCents: number | null;
}

/**
 * Draws a quantity from receipts, oldest first.
 *
 * When the request exceeds what is on hand the shortfall is returned as a final
 * allocation with a null lot rather than being truncated. The sale did happen, and
 * a negative pool is something a person needs to see, not something to round away.
 */
export function allocateFifo(receipts: readonly Receipt[], quantity: number): Allocation[] {
  if (quantity <= EPSILON) return [];

  const allocations: Allocation[] = [];
  let outstanding = quantity;

  const ordered = [...receipts].sort((a, b) => a.occurredAt - b.occurredAt);

  for (const receipt of ordered) {
    if (outstanding <= EPSILON) break;
    if (receipt.remaining <= EPSILON) continue;

    const take = Math.min(receipt.remaining, outstanding);
    allocations.push({
      lotId: receipt.lotId,
      quantity: take,
      unitCostCents: receipt.unitCostCents,
    });
    outstanding -= take;
  }

  if (outstanding > EPSILON) {
    allocations.push({ lotId: null, quantity: outstanding, unitCostCents: null });
  }

  return allocations;
}

/**
 * Weighted-average cost of an allocation, in cents.
 *
 * This is the number that keeps margin honest when one receipt cost $14.77 and the
 * next cost $16.10. Returns null when no allocation carried a cost, so a line
 * reports "unknown" rather than a confident zero.
 */
export function weightedAverageCostCents(allocations: readonly Allocation[]): number | null {
  let costed = 0;
  let quantity = 0;

  for (const allocation of allocations) {
    if (allocation.unitCostCents === null || allocation.quantity <= 0) continue;
    costed += allocation.unitCostCents * allocation.quantity;
    quantity += allocation.quantity;
  }

  if (quantity <= EPSILON) return null;
  return Math.round(costed / quantity);
}

/** The pool: every movement summed. Nothing is cached, so nothing can drift. */
export function poolQuantity(movements: readonly { quantityInBase: number }[]): number {
  return movements.reduce((total, movement) => total + movement.quantityInBase, 0);
}

/** Rounds away float noise so a pool of 60 reads as 60, not 59.999999999999. */
export function tidyQuantity(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : Math.round(value * 1e6) / 1e6;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Database access
 * ──────────────────────────────────────────────────────────────────────────── */

/** Current pooled quantity for a product, in its base unit. */
export async function productPoolQuantity(db: Database, productId: string): Promise<number> {
  const row = await db
    .select({ total: sql<number>`COALESCE(SUM(${inventoryMovements.quantityInBase}), 0)` })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.productId, productId))
    .get();

  return tidyQuantity(Number(row?.total ?? 0));
}

/** Pooled quantities for many products at once, for list screens. */
export async function poolQuantitiesByProduct(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({
      productId: inventoryMovements.productId,
      total: sql<number>`COALESCE(SUM(${inventoryMovements.quantityInBase}), 0)`,
    })
    .from(inventoryMovements)
    .groupBy(inventoryMovements.productId)
    .all();

  return new Map(rows.map((row) => [row.productId, tidyQuantity(Number(row.total))]));
}

/**
 * Receipts for a product with their remaining quantity.
 *
 * Remaining is derived from the ledger rather than stored per lot, so it cannot
 * disagree with the movements that produced it.
 */
export async function receiptsWithRemaining(
  db: Database,
  productId: string,
  pending: readonly { lotId?: string | null; quantityInBase: number }[] = [],
): Promise<Receipt[]> {
  const [lots, grouped] = await Promise.all([
    db.select().from(inventoryLots).where(eq(inventoryLots.productId, productId)).all(),
    db
      .select({
        lotId: inventoryMovements.lotId,
        total: sql<number>`COALESCE(SUM(${inventoryMovements.quantityInBase}), 0)`,
      })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId))
      .groupBy(inventoryMovements.lotId)
      .all(),
  ]);

  const remainingByLot = new Map(
    grouped.map((row) => [row.lotId, tidyQuantity(Number(row.total))]),
  );

  // Account for movements staged but not yet written, so a second line drawing on
  // the same product sees what the first one already took.
  for (const entry of pending) {
    if (entry.quantityInBase === 0) continue;
    const lotKey = entry.lotId ?? null;
    remainingByLot.set(lotKey, tidyQuantity((remainingByLot.get(lotKey) ?? 0) + entry.quantityInBase));
  }

  return lots.map((lot) => ({
    lotId: lot.id,
    remaining: remainingByLot.get(lot.id) ?? 0,
    unitCostCents: lot.unitCostCents ?? null,
    occurredAt: (lot.receivedAt ?? lot.createdAt).getTime(),
  }));
}

/** The ledger for a product, oldest first, with a running balance. */
export async function productLedger(
  db: Database,
  productId: string,
): Promise<(InventoryMovement & { balanceInBase: number })[]> {
  const movements = await db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.productId, productId))
    .orderBy(inventoryMovements.occurredAt, inventoryMovements.createdAt)
    .all();

  let balance = 0;
  return movements.map((movement) => {
    balance = tidyQuantity(balance + movement.quantityInBase);
    return { ...movement, balanceInBase: balance };
  });
}

/** Appends movements. The ledger is append-only; corrections are new rows. */
export async function recordMovements(
  db: Database,
  movements: readonly Omit<NewInventoryMovement, 'id' | 'createdAt' | 'updatedAt'>[],
): Promise<void> {
  if (movements.length === 0) return;
  await db.insert(inventoryMovements).values([...movements]);
}

export interface CustomerSales {
  customerId: string;
  customerName: string;
  /** Positive quantity sold, in the product's base unit. */
  quantity: number;
  movementCount: number;
  lastSoldAt: Date | null;
}

/**
 * Who bought this product, and how much.
 *
 * Sourced from the ledger rather than from invoice lines, so it reflects what was
 * actually drawn from stock and stays correct after a reversal. Reversals are
 * excluded by filtering to `sale` movements, and a cancelled sale re-appears here
 * only if it was cancelled and then re-sent, which is the truth of the matter.
 */
export async function salesByCustomer(db: Database, productId: string): Promise<CustomerSales[]> {
  const rows = await db
    .select({
      customerId: invoices.customerId,
      customerName: customers.name,
      quantity: sql<number>`COALESCE(SUM(-${inventoryMovements.quantityInBase}), 0)`,
      movementCount: sql<number>`COUNT(*)`,
      lastSoldAt: sql<number>`MAX(${inventoryMovements.occurredAt})`,
    })
    .from(inventoryMovements)
    .innerJoin(invoices, eq(invoices.id, inventoryMovements.referenceId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(inventoryMovements.productId, productId),
        eq(inventoryMovements.movementType, 'sale'),
      ),
    )
    .groupBy(invoices.customerId, customers.name)
    .orderBy(sql`COALESCE(SUM(-${inventoryMovements.quantityInBase}), 0) DESC`)
    .all();

  return rows.map((row) => ({
    customerId: row.customerId,
    customerName: row.customerName,
    quantity: tidyQuantity(Number(row.quantity)),
    movementCount: Number(row.movementCount),
    lastSoldAt: row.lastSoldAt ? new Date(Number(row.lastSoldAt)) : null,
  }));
}

/** Convenience for a movement tied to a document. */
export function movementReference(  type: MovementReferenceType,
  id: string,
): { referenceType: MovementReferenceType; referenceId: string } {
  return { referenceType: type, referenceId: id };
}

/**
 * Expresses a quantity in the product's base unit.
 *
 * `converted: false` means the units measure different things — ounces against
 * pounds, say — and the raw quantity was kept. The caller records that rather than
 * inventing a conversion, because a wrong number is worse than a flagged one.
 */
export async function convertToBase(
  db: Database,
  unit: string | null,
  baseUnit: string | null,
  quantity: number,
): Promise<{ quantityInBase: number; converted: boolean }> {
  if (!unit || !baseUnit || unit === baseUnit) {
    return { quantityInBase: quantity, converted: true };
  }

  const rows = await db.select().from(units).all();
  const from = rows.find((row) => row.code === unit);
  const to = rows.find((row) => row.code === baseUnit);

  if (!from || !to || from.dimension !== to.dimension) {
    return { quantityInBase: quantity, converted: false };
  }

  const converted = convertWithinDimension(from, to, quantity);
  return converted === null
    ? { quantityInBase: quantity, converted: false }
    : { quantityInBase: converted, converted: true };
}

/**
 * Turns invoice lines into individual product consumptions.
 *
 * A program is a blend, so selling one consumes its ingredients in proportion to
 * the acreage rather than consuming "the program" — there is no such stock. This
 * is why a program line previously moved nothing: approximating it would have put
 * wrong numbers in the ledger, which is worse than an obvious gap.
 */
export async function consumptionRequests(
  db: Database,
  items: readonly {
    lineType: string;
    productId: string | null;
    programId: string | null;
    quantity: number;
    unit: string | null;
    acres: number | null;
    description: string;
  }[],
): Promise<{ productId: string; quantity: number; unit: string | null; description: string }[]> {
  const requests: {
    productId: string;
    quantity: number;
    unit: string | null;
    description: string;
  }[] = [];

  for (const item of items) {
    if (item.lineType === 'program') {
      const acres = item.acres ?? item.quantity;
      if (!item.programId || !Number.isFinite(acres) || acres <= 0) continue;

      const ingredients = await db
        .select()
        .from(programIngredients)
        .where(eq(programIngredients.programId, item.programId))
        .all();

      for (const ingredient of ingredients) {
        if (!ingredient.productId || ingredient.ratePerAcre === null) continue;

        requests.push({
          productId: ingredient.productId,
          quantity: ingredient.ratePerAcre * acres,
          unit: ingredient.rateUnit ?? null,
          description: `${ingredient.productNameRaw ?? 'ingredient'} at ${ingredient.ratePerAcre}/acre over ${acres} acres`,
        });
      }

      continue;
    }

    if (item.productId && item.quantity > 0) {
      requests.push({
        productId: item.productId,
        quantity: item.quantity,
        unit: item.unit,
        description: item.description,
      });
    }
  }

  return requests;
}

/**
 * Consumes stock for an invoice's lines, allocating cost FIFO across receipts.
 *
 * Program lines are expanded into their ingredients first, so a blend draws down
 * the chemicals it is actually made of.
 */
export async function consumeForInvoice(
  db: Database,
  invoiceId: string,
  items: readonly {
    lineType: string;
    productId: string | null;
    programId: string | null;
    quantity: number;
    unit: string | null;
    acres: number | null;
    description: string;
  }[],
  actorUserId: string | null,
  occurredAt: Date,
): Promise<number> {
  const requests = await consumptionRequests(db, items);
  if (requests.length === 0) return 0;

  const movements: Omit<NewInventoryMovement, 'id' | 'createdAt' | 'updatedAt'>[] = [];

  for (const request of requests) {
    const product = await db.select().from(products).where(eq(products.id, request.productId)).get();
    if (!product) continue;

    const baseUnit = product.baseUnitCode ?? product.unit;
    const { quantityInBase, converted } = await convertToBase(
      db,
      request.unit ?? product.unit,
      baseUnit,
      request.quantity,
    );

    // Re-read receipts per request: two lines may draw on the same product, and
    // the second must see what the first left behind.
    const receipts = await receiptsWithRemaining(db, product.id, movements);
    const allocations = allocateFifo(receipts, quantityInBase);

    for (const allocation of allocations) {
      movements.push({
        productId: product.id,
        lotId: allocation.lotId,
        movementType: 'sale',
        quantityDelta: -allocation.quantity,
        unit: baseUnit,
        quantityInBase: -allocation.quantity,
        unitCostCents: allocation.unitCostCents,
        ...movementReference('invoice', invoiceId),
        occurredAt,
        createdByUserId: actorUserId,
        note: converted
          ? request.description
          : `${request.description} (unit ${request.unit ?? '?'} could not be converted to ${baseUnit})`,
      });
    }
  }

  await recordMovements(db, movements);
  return movements.length;
}

/**
 * Reverses an invoice's stock effect.
 *
 * Idempotent: if a reversal already exists for this invoice, nothing is written.
 * Without that guard, cancelling twice — or cancelling a re-opened invoice — would
 * quietly inflate the pool.
 */
export async function reverseForInvoice(
  db: Database,
  invoiceId: string,
  actorUserId: string | null,
  occurredAt: Date,
): Promise<number> {
  const existing = await db
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.referenceType, 'invoice'),
        eq(inventoryMovements.referenceId, invoiceId),
        eq(inventoryMovements.movementType, 'void_reversal'),
      ),
    )
    .limit(1)
    .get();

  if (existing) return 0;

  const sales = await db
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.referenceType, 'invoice'),
        eq(inventoryMovements.referenceId, invoiceId),
        eq(inventoryMovements.movementType, 'sale'),
      ),
    )
    .all();

  if (sales.length === 0) return 0;

  await recordMovements(
    db,
    sales.map((sale) => ({
      productId: sale.productId,
      lotId: sale.lotId,
      movementType: 'void_reversal',
      quantityDelta: -sale.quantityDelta,
      unit: sale.unit,
      quantityInBase: -sale.quantityInBase,
      unitCostCents: sale.unitCostCents,
      ...movementReference('invoice', invoiceId),
      occurredAt,
      createdByUserId: actorUserId,
      note: `Reversal of ${sale.note ?? 'sale'}`,
    })),
  );

  return sales.length;
}
