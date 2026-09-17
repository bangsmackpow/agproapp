import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { invoiceCreateSchema } from '../api/schemas';
import { createDb } from '../db';
import {
  applicationPrograms,
  customers,
  invoiceItems,
  invoices,
  invoiceSequences,
  priceTiers,
  programPrices,
  users,
} from '../db/schema';
import { PRICE_TIER_KEYS } from '../shared/enums';
import { createInvoiceDraft, getInvoiceWithItems } from './invoicing';

/**
 * Line descriptions.
 *
 * These exist because a real defect reached production: the invoice form sent an
 * empty `description` on every line, the schema required at least one character,
 * and so *every* invoice creation failed body validation — while the whole test
 * suite stayed green, because nothing exercised the schema/service contract.
 *
 * The first four cases pin the contract itself. The last three pin the behaviour
 * that replaced it: the server derives the description from the program, product
 * or fee it already loads, so a caller cannot get it wrong by omission.
 */

const TIER_KEY = PRICE_TIER_KEYS[0];

/**
 * Prices are dated, and the fixture's is a 2027 sheet. Invoicing after the price
 * takes effect keeps the fixture honest rather than back-dating it to always apply.
 */
const ISSUE_DATE = new Date('2027-03-01T00:00:00Z');

async function seed() {
  const db = createDb(env.DB);

  // Children first, so foreign keys never dangle. Invoices are cleared so the
  // sequence below can reset without colliding on invoice numbers.
  await db.delete(invoiceItems);
  await db.delete(invoices);
  await db.delete(programPrices);
  await db.delete(applicationPrograms);
  await db.delete(priceTiers);
  await db.delete(customers);
  await db.delete(invoiceSequences);
  await db.delete(users);

  // Normally reference data from seed/0001_reference.sql; migrations do not insert it.
  await db.insert(invoiceSequences).values({ scope: 'default', prefix: 'INV' });

  // invoices.created_by_user_id is a foreign key, so the actor must exist.
  const [actor] = await db
    .insert(users)
    .values({
      email: 'test-actor@example.com',
      passwordHash: 'not-a-real-hash',
      name: 'Test Actor',
      role: 'admin',
    })
    .returning();

  const [tier] = await db
    .insert(priceTiers)
    .values({ key: TIER_KEY, label: 'Cash Application', multiplier: 1.2 })
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
    .values({ accountNumber: 'TEST-0001', name: 'Test Farms' })
    .returning();

  return { db, tier: tier!, program: program!, customer: customer!, actor: actor! };
}

describe('invoice line description — the schema contract', () => {
  const base = {
    customerId: '11111111-1111-4111-8111-111111111111',
    pricingTierKey: TIER_KEY,
  };
  const programId = '22222222-2222-4222-8222-222222222222';

  it('accepts a program line with no description at all', () => {
    const result = invoiceCreateSchema.safeParse({
      ...base,
      items: [{ lineType: 'program', programId, acres: 160 }],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a program line whose description is an empty string', () => {
    // The exact shape the form used to send. An empty string is what a present but
    // unpopulated input yields, and it must not fail the way it did in production.
    const result = invoiceCreateSchema.safeParse({
      ...base,
      items: [{ lineType: 'program', programId, description: '', acres: 160 }],
    });

    expect(result.success).toBe(true);
  });

  it('requires a description for misc lines, which reference nothing', () => {
    // A misc line has no program, product or fee, so there is nothing to derive
    // from and the caller must supply one.
    const result = invoiceCreateSchema.safeParse({
      ...base,
      items: [{ lineType: 'misc', quantity: 1, unitPriceCents: 1000 }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
      'items.0.description',
    );
  });

  it('treats an empty description as absent for misc lines', () => {
    const result = invoiceCreateSchema.safeParse({
      ...base,
      items: [{ lineType: 'misc', description: '', quantity: 1, unitPriceCents: 1000 }],
    });

    expect(result.success).toBe(false);
  });

  it('accepts a misc line that does carry a description', () => {
    const result = invoiceCreateSchema.safeParse({
      ...base,
      items: [{ lineType: 'misc', description: 'Mileage', quantity: 1, unitPriceCents: 1000 }],
    });

    expect(result.success).toBe(true);
  });
});

describe('invoice line description — derivation', () => {
  let ctx: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    ctx = await seed();
  });

  // A program line is priced per acre, and the schema's default makes `quantity`
  // required on the parsed type; the service treats it as the acreage fallback.
  const line = { lineType: 'program' as const, acres: 160, quantity: 160 };

  it('derives the program name when no description is supplied', async () => {
    const invoice = await createInvoiceDraft(
      ctx.db,
      {
                customerId: ctx.customer.id,
        pricingTierKey: TIER_KEY,
        issueDate: ISSUE_DATE,
        items: [
{ ...line, programId: ctx.program.id }],
      },
      ctx.actor.id,
    );

    const { items } = await getInvoiceWithItems(ctx.db, invoice.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe('CORN (1 PASS)');
  });

  it('derives the program name when the description is an empty string', async () => {
    // The production payload: an empty description must not be persisted as empty,
    // which would print a blank line on the invoice.
    const invoice = await createInvoiceDraft(
      ctx.db,
      {
                customerId: ctx.customer.id,
        pricingTierKey: TIER_KEY,
        issueDate: ISSUE_DATE,
        items: [
{ ...line, programId: ctx.program.id, description: '' }],
      },
      ctx.actor.id,
    );

    const { items } = await getInvoiceWithItems(ctx.db, invoice.id);
    expect(items[0]!.description).toBe('CORN (1 PASS)');
  });

  it('prefers an explicit description when one is given', async () => {
    const invoice = await createInvoiceDraft(
      ctx.db,
      {
                customerId: ctx.customer.id,
        pricingTierKey: TIER_KEY,
        issueDate: ISSUE_DATE,
        items: [
{ ...line, programId: ctx.program.id, description: 'East 80 — custom' }],
      },
      ctx.actor.id,
    );

    const { items } = await getInvoiceWithItems(ctx.db, invoice.id);
    expect(items[0]!.description).toBe('East 80 — custom');
  });

  it('refuses a line that has neither a product nor a description', async () => {
    // Belt to the schema's braces: the service is callable directly, and an empty
    // description would otherwise reach the database.
    await expect(
      createInvoiceDraft(
        ctx.db,
        {
          customerId: ctx.customer.id,
          pricingTierKey: TIER_KEY,
          items: [{ lineType: 'misc', quantity: 1, unitPriceCents: 1000 }],
        },
        ctx.actor.id,
      ),
    ).rejects.toThrow(/requires a description/);
  });
});
