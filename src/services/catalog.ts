import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';

import { conflict, notFound, unprocessable } from '../api/lib/http';
import type {
  CatalogListQuery,
  ProductCreateInput,
  ProductUpdateInput,
  StockAdjustInput,
  StockReceiptInput,
  VendorCreateInput,
  VendorUpdateInput,
} from '../api/schemas';
import { createDb } from '../db';
import { isUniqueConstraintError } from '../db/errors';
import {
  products,
  stockMovements,
  vendors,
  type Product,
  type StockMovement,
  type Vendor,
} from '../db/schema';

import { recordAudit, recordChange } from './audit';

/**
 * Catalog, stock, and vendors.
 *
 * There is no stored "quantity on hand" column, on purpose. The pool is derived
 * every time from the append-only ledger, so it cannot drift from the movements
 * that justify it, and "why does this number say 14" is always answerable by
 * reading the rows below it.
 *
 * v1 also tracked lots and allocated cost FIFO across them. v2 stocks one pooled
 * quantity per product: nobody was querying lot-level cost of goods, and the
 * machinery to do it (`convertToBase`, `receiptsWithRemaining`, `allocateFifo`)
 * was the single largest source of subtle complexity in the schema. Lot numbers
 * still exist where the State of Iowa requires them — on the seed record.
 */

type Db = ReturnType<typeof createDb>;

/** Float dust: 0.1 + 0.2 must not render as 0.30000000000000004. */
export function tidyQuantity(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export interface ProductWithStock extends Product {
  quantityOnHand: number;
  vendorName: string | null;
  /** False when no reorder point is set, which is "don't alert", not "out". */
  needsReorder: boolean;
  /** A product without a cost cannot be priced, so it cannot be invoiced. */
  isInvoiceable: boolean;
}

/**
 * Pooled quantity per product, in one grouped query.
 *
 * Bounded to the products on the page being rendered: an unbounded GROUP BY over
 * the whole ledger is cheap at a few thousand rows and pointless when four are
 * about to be displayed.
 */
export async function productPools(db: Db, productIds?: readonly string[]): Promise<Map<string, number>> {
  const where = productIds ? inArray(stockMovements.productId, [...productIds]) : undefined;
  if (productIds && productIds.length === 0) return new Map();

  const rows = await db
    .select({
      productId: stockMovements.productId,
      quantityOnHand: sql<number>`COALESCE(SUM(${stockMovements.quantityDelta}), 0)`,
    })
    .from(stockMovements)
    .where(where)
    .groupBy(stockMovements.productId)
    .all();

  return new Map(rows.map((row) => [row.productId, tidyQuantity(Number(row.quantityOnHand))]));
}

/** Sort keys are whitelisted to columns; a column name never comes from the client. */
const PRODUCT_SORTS = {
  name: products.name,
  sku: products.sku,
  type: products.type,
  costCents: products.costCents,
  createdAt: products.createdAt,
} as const;

export interface ProductListPage {
  rows: ProductWithStock[];
  total: number;
  limit: number;
  offset: number;
}

export async function listProducts(db: Db, query: CatalogListQuery): Promise<ProductListPage> {
  const { limit, offset, q, type, includeInactive, stock, sort, direction } = query;

  const conditions: SQL[] = [];
  if (!includeInactive) conditions.push(eq(products.isActive, true));
  if (type) conditions.push(eq(products.type, type));
  if (q) {
    const term = `%${q}%`;
    const search = or(
      like(products.name, term),
      like(products.sku, term),
      like(products.description, term),
      like(products.epaNumber, term),
    );
    if (search) conditions.push(search);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const sortColumn = PRODUCT_SORTS[sort];
  const ordered = direction === 'desc' ? desc(sortColumn) : asc(sortColumn);

  const [rows, vendorRows, counted] = await Promise.all([
    db.select().from(products).where(where).orderBy(ordered).limit(limit).offset(offset).all(),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors).all(),
    db.select({ total: sql<number>`count(*)` }).from(products).where(where).get(),
  ]);

  const pools = await productPools(db, rows.map((row) => row.id));
  const vendorNames = new Map(vendorRows.map((row) => [row.id, row.name]));

  const enriched: ProductWithStock[] = rows.map((row) => {
    const quantityOnHand = pools.get(row.id) ?? 0;
    return {
      ...row,
      quantityOnHand,
      vendorName: row.vendorId ? (vendorNames.get(row.vendorId) ?? null) : null,
      needsReorder: row.reorderPoint !== null && quantityOnHand <= row.reorderPoint,
      isInvoiceable: row.costCents !== null && row.costCents > 0,
    };
  });

  const needsOrdering = stock === 'low';

  return {
    rows: needsOrdering ? enriched.filter((row) => row.needsReorder) : enriched,
    total: Number(counted?.total ?? 0),
    limit,
    offset,
  };
}

/** The needs-ordering set, for the dashboard panel and the email digest. */
export async function lowStockProducts(db: Db): Promise<ProductWithStock[]> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.isActive, true), sql`${products.reorderPoint} IS NOT NULL`))
    .orderBy(asc(products.name))
    .all();

  const pools = await productPools(db, rows.map((row) => row.id));
  const vendorRows = await db.select({ id: vendors.id, name: vendors.name }).from(vendors).all();
  const vendorNames = new Map(vendorRows.map((row) => [row.id, row.name]));

  return rows
    .map((row) => {
      const quantityOnHand = pools.get(row.id) ?? 0;
      return {
        ...row,
        quantityOnHand,
        vendorName: row.vendorId ? (vendorNames.get(row.vendorId) ?? null) : null,
        needsReorder: quantityOnHand <= (row.reorderPoint ?? 0),
        isInvoiceable: row.costCents !== null && row.costCents > 0,
      };
    })
    .filter((row) => row.needsReorder);
}

/** How many products cannot be invoiced because no cost has been entered. */
export async function productsMissingCost(db: Db): Promise<number> {
  const row = await db
    .select({ total: sql<number>`count(*)` })
    .from(products)
    .where(and(eq(products.isActive, true), sql`${products.costCents} IS NULL OR ${products.costCents} <= 0`))
    .get();

  return Number(row?.total ?? 0);
}

export interface ProductDetail {
  product: ProductWithStock;
  ledger: StockMovement[];
  usedOnAcres: number;
}

/**
 * One product: what it is, how much is left, and every movement that explains the
 * difference. The ledger is newest-first and bounded, because a decade of history
 * is a report, not a screen.
 */
export async function getProductDetail(db: Db, id: string): Promise<ProductDetail> {
  const product = await db.select().from(products).where(eq(products.id, id)).get();
  if (!product) throw notFound('Product not found');

  const [pools, ledger, vendorRows] = await Promise.all([
    productPools(db, [product.id]),
    db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.productId, product.id))
      .orderBy(desc(stockMovements.occurredAt))
      .limit(200)
      .all(),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors).all(),
  ]);

  const quantityOnHand = pools.get(product.id) ?? 0;
  const vendorNames = new Map(vendorRows.map((row) => [row.id, row.name]));

  return {
    product: {
      ...product,
      quantityOnHand,
      vendorName: product.vendorId ? (vendorNames.get(product.vendorId) ?? null) : null,
      needsReorder: product.reorderPoint !== null && quantityOnHand <= product.reorderPoint,
      isInvoiceable: product.costCents !== null && product.costCents > 0,
    },
    ledger,
    usedOnAcres: tidyQuantity(
      ledger
        .filter((movement) => movement.movementType === 'sale')
        .reduce((total, movement) => total + Math.abs(movement.quantityDelta), 0),
    ),
  };
}

export async function createProduct(
  db: Db,
  input: ProductCreateInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<Product> {
  if (input.vendorId) await requireVendor(db, input.vendorId);

  let created: Product | undefined;
  try {
    [created] = await db.insert(products).values(input).returning();
  } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict(`SKU "${input.sku}" already exists`);
    throw error;
  }

  if (!created) throw conflict('Failed to create product');

  await logActivity(db, actor, { action: 'product.created', entityType: 'product', entityId: created.id });
  return created;
}

export async function updateProduct(
  db: Db,
  id: string,
  input: ProductUpdateInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<Product> {
  const before = await db.select().from(products).where(eq(products.id, id)).get();
  if (!before) throw notFound('Product not found');

  if (input.vendorId) await requireVendor(db, input.vendorId);

  const patch = withoutUndefined(input);
  if (Object.keys(patch).length === 0) return before;

  let updated: Product | undefined;
  try {
    [updated] = await db.update(products).set(patch).where(eq(products.id, id)).returning();
  } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict(`SKU "${input.sku}" already exists`);
    throw error;
  }

  if (!updated) throw notFound('Product not found');

  await recordChange(db, {
    actorUserId: actor.userId,
    action: 'product.updated',
    entityType: 'product',
    entityId: updated.id,
    before,
    after: updated,
    ipAddress: actor.ipAddress,
  });
  return updated;
}

/** Receives stock: one positive movement. Cost may arrive with it. */
export async function receiveStock(
  db: Db,
  productId: string,
  input: StockReceiptInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<{ movement: StockMovement; quantityOnHand: number }> {
  const product = await db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw notFound('Product not found');
  if (input.vendorId) await requireVendor(db, input.vendorId);

  const unit = input.unit ?? product.unit;

  const [movement] = await db
    .insert(stockMovements)
    .values({
      productId: product.id,
      movementType: 'receipt',
      quantityDelta: input.quantity,
      unit,
      unitCostCents: input.unitCostCents ?? null,
      referenceType: 'manual',
      referenceId: product.id,
      occurredAt: input.occurredAt ?? new Date(),
      note: input.note ?? input.reference ?? `Received ${input.quantity} ${unit}`,
      createdByUserId: actor.userId,
    })
    .returning();

  if (!movement) throw conflict('Failed to record the receipt');

  const pools = await productPools(db, [product.id]);

  await logActivity(db, actor, {
    action: 'inventory.received',
    entityType: 'product',
    entityId: product.id,
    metadata: { quantity: input.quantity, unit, unitCostCents: input.unitCostCents ?? null },
  });

  return { movement, quantityOnHand: pools.get(product.id) ?? 0 };
}

/**
 * A physical-count correction.
 *
 * A negative delta is refused if it would take the pool below zero: you cannot
 * lose stock you never had, and recording it anyway would bury a counting error in
 * a ledger that now sums to a number no shipment supports.
 */
export async function adjustStock(
  db: Db,
  productId: string,
  input: StockAdjustInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<{ movement: StockMovement; quantityOnHand: number }> {
  const product = await db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw notFound('Product not found');

  const pools = await productPools(db, [product.id]);
  const current = pools.get(product.id) ?? 0;
  const next = tidyQuantity(current + input.delta);

  if (next < 0) {
    throw unprocessable(
      `That would leave ${product.name} at ${next} ${product.unit}. The pool is built from the ledger, so a shrinkage larger than the stock on hand means the count or a past movement is wrong — fix the ledger rather than forcing it negative.`,
    );
  }

  const [movement] = await db
    .insert(stockMovements)
    .values({
      productId: product.id,
      movementType: 'adjustment',
      quantityDelta: input.delta,
      unit: input.unit ?? product.unit,
      referenceType: 'manual',
      referenceId: product.id,
      occurredAt: input.occurredAt ?? new Date(),
      note: input.reason,
      createdByUserId: actor.userId,
    })
    .returning();

  if (!movement) throw conflict('Failed to record the adjustment');

  await logActivity(db, actor, {
    action: 'inventory.adjusted',
    entityType: 'product',
    entityId: product.id,
    metadata: { delta: input.delta, from: current, to: next, reason: input.reason },
  });

  return { movement, quantityOnHand: next };
}

/* ── Vendors ──────────────────────────────────────────────────────────────────
 *
 * Deliberately minimal: a name and a way to reach them. Accounts payable is not in
 * v2, so a vendor exists to answer "who do I call about this pallet", and to make
 * the needs-ordering list actionable.
 * ──────────────────────────────────────────────────────────────────────────── */

export async function listVendors(db: Db, includeInactive = false): Promise<Vendor[]> {
  const rows = await db.select().from(vendors).orderBy(asc(vendors.name)).all();
  return includeInactive ? rows : rows.filter((row) => row.isActive);
}

export async function createVendor(db: Db, input: VendorCreateInput): Promise<Vendor> {
  const [created] = await db.insert(vendors).values(input).returning();
  if (!created) throw conflict('Failed to create vendor');
  return created;
}

export async function updateVendor(
  db: Db,
  id: string,
  input: VendorUpdateInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<Vendor> {
  const before = await db.select().from(vendors).where(eq(vendors.id, id)).get();
  if (!before) throw notFound('Vendor not found');

  const patch = withoutUndefined(input);
  if (Object.keys(patch).length === 0) return before;

  const [updated] = await db.update(vendors).set(patch).where(eq(vendors.id, id)).returning();
  if (!updated) throw notFound('Vendor not found');

  await recordChange(db, {
    actorUserId: actor.userId,
    action: 'vendor.updated',
    entityType: 'vendor',
    entityId: updated.id,
    before,
    after: updated,
    ipAddress: actor.ipAddress,
  });
  return updated;
}

async function requireVendor(db: Db, id: string): Promise<void> {
  const vendor = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, id)).get();
  if (!vendor) throw unprocessable('That vendor does not exist');
}

/* ── Activity ─────────────────────────────────────────────────────────────────
 * Small local wrappers so this module has one way to write the trail, with the
 * actor and ip threaded once instead of at every call site.
 * ──────────────────────────────────────────────────────────────────────────── */

function withoutUndefined<T extends object>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function logActivity(
  db: Db,
  actor: { userId: string; ipAddress: string | null },
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  return recordAudit(db, {
    actorUserId: actor.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata,
    ipAddress: actor.ipAddress,
  });
}
