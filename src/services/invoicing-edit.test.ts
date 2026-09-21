import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../db';
import {
  applicationPrograms,
  customers,
  inventoryMovements,
  invoiceItems,
  invoices,
  invoiceSequences,
  priceTiers,
  products,
  programPrices,
  users,
} from '../db/schema';
import { PRICE_TIER_KEYS } from '../shared/enums';
import { productPoolQuantity, recordMovements } from './inventory';
import {
  createInvoiceDraft,
  getInvoiceWithItems,
  recordInvoicePayment,
  updateInvoice,
  updateInvoiceStatus,
} from './invoicing';

/**
 * Editing a Draft or Sent invoice.
 *
 * The behaviour worth pinning is what happens to the things an invoice touches
 * beyond its own row: the stock ledger (a sent invoice has already consumed) and
 * the Iowa seed-compliance gate (a sent invoice has already passed it). Both are
 * easy to get wrong in a way no type checker catches.
 */

// financed_app, so `productFallbackPrice` reads `financedAppPriceCents`.
const TIER_KEY = PRICE_TIER_KEYS[0];
const ISSUE_DATE = new Date('2027-03-01T00:00:00Z');
const RECEIPT_QTY = 100;
const PRODUCT_PRICE_CENTS = 5000;

async function seed() {
  const db = createDb(env.DB);

  // inventory_movements references products with ON DELETE restrict, so the
  // ledger goes before the catalogue it describes.
  await db.delete(inventoryMovements);
  await db.delete(invoiceItems);
  await db.delete(invoices);
  await db.delete(programPrices);
  await db.delete(applicationPrograms);
  await db.delete(priceTiers);
  await db.delete(customers);
  await db.delete(products);
  await db.delete(invoiceSequences);
  await db.delete(users);

  await db.insert(invoiceSequences).values({ scope: 'default', prefix: 'INV' });

  const [actor] = await db
    .insert(users)
    .values({ email: 'edit-actor@example.com', passwordHash: 'x', name: 'Edit Actor', role: 'admin' })
    .returning();

  const [tier] = await db
    .insert(priceTiers)
    .values({ key: TIER_KEY, label: 'Financed Application', multiplier: 1.2 })
    .returning();

  const [program] = await db
    .insert(applicationPrograms)
    .values({ name: 'CORN (1 PASS)', crop: 'corn', seasonYear: 2027 })
    .returning();

  await db.insert(programPrices).values({
    programId: program!.id,
    tierId: tier!.id,
    pricePerAcreCents: 4250,
    costPerAcreCents: 3100,
    effectiveFrom: new Date('2027-01-01T00:00:00Z'),
  });

  const [customer] = await db
    .insert(customers)
    .values({ accountNumber: 'TEST-0002', name: 'Edit Farms' })
    .returning();

  const [product] = await db
    .insert(products)
    .values({
      sku: 'EDIT-1',
      name: 'Ventas',
      type: 'chemical',
      unit: 'gal',
      financedAppPriceCents: PRODUCT_PRICE_CENTS,
    })
    .returning();

  const [regulated] = await db
    .insert(products)
    .values({
      sku: 'EDIT-SEED',
      name: 'Regulated Seed',
      type: 'seed',
      unit: 'bag',
      financedAppPriceCents: 20000,
      isRegulatedSeed: true,
    })
    .returning();

  await recordMovements(db, [
    {
      productId: product!.id,
      lotId: null,
      movementType: 'receipt',
      quantityDelta: RECEIPT_QTY,
      unit: 'gal',
      quantityInBase: RECEIPT_QTY,
      occurredAt: new Date('2027-02-01T00:00:00Z'),
      createdByUserId: actor!.id,
      note: 'Opening stock',
    },
  ]);

  return { db, tier: tier!, program: program!, customer: customer!, actor: actor!, product: product!, regulated: regulated! };
}

type Ctx = Awaited<ReturnType<typeof seed>>;

const productLine = (ctx: Ctx, quantity: number) => ({
  lineType: 'product' as const,
  productId: ctx.product.id,
  quantity,
});

function draft(ctx: Ctx, quantity = 10) {
  return createInvoiceDraft(
    ctx.db,
    {
      customerId: ctx.customer.id,
      pricingTierKey: TIER_KEY,
      issueDate: ISSUE_DATE,
      items: [productLine(ctx, quantity)],
    },
    ctx.actor.id,
  );
}

describe('editing a draft', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await seed();
  });

  it('re-prices and recomputes totals when a line is added', async () => {
    const invoice = await draft(ctx, 2);
    expect(invoice.totalCents).toBe(2 * PRODUCT_PRICE_CENTS);

    const result = await updateInvoice(
      ctx.db,
      invoice.id,
      {
        items: [
          productLine(ctx, 2),
          { lineType: 'program', programId: ctx.program.id, acres: 10 },
        ],
      },
      ctx.actor.id,
    );

    // 2 x $50 product + 10 acres x $42.50 program.
    expect(result.invoice.totalCents).toBe(2 * PRODUCT_PRICE_CENTS + 10 * 4250);
    expect(result.itemsReplaced).toBe(true);

    const { items } = await getInvoiceWithItems(ctx.db, invoice.id);
    expect(items).toHaveLength(2);
  });

  it('moves no stock, because a draft has not shipped anything', async () => {
    const invoice = await draft(ctx, 10);

    await updateInvoice(ctx.db, invoice.id, { items: [productLine(ctx, 40)] }, ctx.actor.id);

    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY);
  });

  it('edits header fields without touching the lines', async () => {
    const invoice = await draft(ctx, 3);

    const result = await updateInvoice(
      ctx.db,
      invoice.id,
      { poNumber: 'PO-77', termsDays: 45, notes: 'Call before delivery' },
      ctx.actor.id,
    );

    expect(result.itemsReplaced).toBe(false);
    expect(result.invoice.poNumber).toBe('PO-77');
    expect(result.invoice.termsDays).toBe(45);
    expect(result.invoice.notes).toBe('Call before delivery');

    const { items } = await getInvoiceWithItems(ctx.db, invoice.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(3);
  });

  it('clears a field when null is sent, rather than leaving it alone', async () => {
    const invoice = await draft(ctx, 1);
    await updateInvoice(ctx.db, invoice.id, { poNumber: 'PO-1' }, ctx.actor.id);

    const result = await updateInvoice(ctx.db, invoice.id, { poNumber: null }, ctx.actor.id);
    expect(result.invoice.poNumber).toBeNull();
  });
});

describe('editing a sent invoice', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await seed();
  });

  it('reconciles the stock ledger to the new line set', async () => {
    const invoice = await draft(ctx, 10);
    await updateInvoiceStatus(ctx.db, invoice.id, 'sent', ctx.actor.id);
    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY - 10);

    const result = await updateInvoice(
      ctx.db,
      invoice.id,
      { items: [productLine(ctx, 15)] },
      ctx.actor.id,
    );

    // 15 consumed, not 25: the original 10 was reversed before the new set.
    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY - 15);
    expect(result.stockMovements).toBeGreaterThan(0);
  });

  it('leaves the pool untouched when the lines are unchanged', async () => {
    const invoice = await draft(ctx, 10);
    await updateInvoiceStatus(ctx.db, invoice.id, 'sent', ctx.actor.id);

    await updateInvoice(ctx.db, invoice.id, { items: [productLine(ctx, 10)] }, ctx.actor.id);

    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY - 10);
  });

  it('refuses an edit that would leave a regulated seed line unverified', async () => {
    const invoice = await draft(ctx, 10);
    await updateInvoiceStatus(ctx.db, invoice.id, 'sent', ctx.actor.id);

    await expect(
      updateInvoice(
        ctx.db,
        invoice.id,
        {
          items: [
            productLine(ctx, 10),
            { lineType: 'product', productId: ctx.regulated.id, quantity: 1 },
          ],
        },
        ctx.actor.id,
      ),
    ).rejects.toThrow(/compliance/i);

    // Nothing changed: still one line, still ten consumed.
    const { items } = await getInvoiceWithItems(ctx.db, invoice.id);
    expect(items).toHaveLength(1);
    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY - 10);
  });

  it('still reverses stock when cancelled after an edit', async () => {
    // The regression the reversal rework exists for: the old "a reversal already
    // exists" guard let the edit's reversal satisfy it, so the cancel reversed
    // nothing and stock stayed consumed for a cancelled document.
    const invoice = await draft(ctx, 10);
    await updateInvoiceStatus(ctx.db, invoice.id, 'sent', ctx.actor.id);
    await updateInvoice(ctx.db, invoice.id, { items: [productLine(ctx, 15)] }, ctx.actor.id);
    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY - 15);

    await updateInvoiceStatus(ctx.db, invoice.id, 'canceled', ctx.actor.id);

    expect(await productPoolQuantity(ctx.db, ctx.product.id)).toBe(RECEIPT_QTY);
  });

  it('floors the balance at zero when the total drops below what was paid', async () => {
    const invoice = await draft(ctx, 10); // $500
    await updateInvoiceStatus(ctx.db, invoice.id, 'sent', ctx.actor.id);
    await recordInvoicePayment(ctx.db, invoice.id, 40000); // $400 paid, still sent

    const result = await updateInvoice(
      ctx.db,
      invoice.id,
      { items: [productLine(ctx, 2)] }, // $100 total
      ctx.actor.id,
    );

    expect(result.invoice.totalCents).toBe(2 * PRODUCT_PRICE_CENTS);
    expect(result.invoice.balanceCents).toBe(0);
    expect(result.invoice.status).toBe('sent');
  });
});

describe('terminal invoices', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await seed();
  });

  it('refuses to edit a paid invoice', async () => {
    const invoice = await draft(ctx, 10);
    await updateInvoiceStatus(ctx.db, invoice.id, 'sent', ctx.actor.id);
    await recordInvoicePayment(ctx.db, invoice.id, invoice.totalCents);

    await expect(
      updateInvoice(ctx.db, invoice.id, { poNumber: 'PO-9' }, ctx.actor.id),
    ).rejects.toThrow(/cannot be edited/);
  });

  it('refuses to edit a canceled invoice', async () => {
    const invoice = await draft(ctx, 10);
    await updateInvoiceStatus(ctx.db, invoice.id, 'canceled', ctx.actor.id);

    await expect(
      updateInvoice(ctx.db, invoice.id, { poNumber: 'PO-9' }, ctx.actor.id),
    ).rejects.toThrow(/cannot be edited/);
  });
});
