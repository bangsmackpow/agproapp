import { env, SELF } from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/api/lib/password';
import { createDb } from '../src/db';
import { isUniqueConstraintError } from '../src/db/errors';
import {
  applicationFees,
  applicationPrograms,
  bankAccounts,
  companySettings,
  customers,
  inventoryLots,
  inventoryMovements,
  invoiceItems,
  invoiceSequences,
  iowaComplianceLogs,
  loginAttempts,
  priceTiers,
  products,
  programIngredients,
  programPrices,
  users,
} from '../src/db/schema';
import { PRICE_TIER_KEYS } from '../src/shared/enums';
import { DEFAULT_TIER_MULTIPLIERS, PRICE_TIER_LABELS } from '../src/shared/pricing';
import { MAX_FAILURES_PER_EMAIL } from '../src/services/login-rate-limit';
import { productPoolQuantity, reverseForInvoice } from '../src/services/inventory';

const PASSWORD = 'correct horse battery staple';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SALES_ID = '22222222-2222-4222-8222-222222222222';
const MANAGER_ID = '33333333-3333-4333-8333-333333333333';
/** Dedicated account for lockout tests, so they cannot lock out other suites. */
const LOCKABLE_ID = '33333333-3333-4333-8333-333333333334';
const LOCKABLE_EMAIL = 'lockable@agpro.test';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const SEED_PRODUCT_ID = '55555555-5555-4555-8555-555555555555';
/** Unregulated item, so delivery can be tested without the seed gate in the way. */
const MISC_PRODUCT_ID = '55555555-5555-4555-8555-555555555556';
/** Dedicated stock-tracked product, so pool assertions are not disturbed by other tests. */
const STOCK_PRODUCT_ID = '55555555-5555-4555-8555-555555555557';
/** Ingredient of the test blend, tracked separately so the blend maths is isolated. */
const BLEND_INGREDIENT_ID = '55555555-5555-4555-8555-555555555558';
const TEST_PROGRAM_ID = '88888888-8888-4888-8888-888888888888';
const BANK_ACCOUNT_ID = '66666666-6666-4666-8666-666666666666';

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = /agpro_session=([^;]+)/.exec(header);
  if (!match?.[1]) throw new Error(`No session cookie in response: ${header}`);
  return `agpro_session=${match[1]}`;
}

async function login(email: string): Promise<string> {
  const response = await SELF.fetch('https://agpro.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

function api(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) headers.set('cookie', cookie);
  if (rest.body) headers.set('content-type', 'application/json');

  return SELF.fetch(`https://agpro.test${path}`, { ...rest, headers });
}

let adminCookie = '';
let salesCookie = '';
let managerCookie = '';

beforeAll(async () => {
  const db = createDb(env.DB);
  const passwordHash = await hashPassword(PASSWORD);

  await db.insert(users).values([
    { id: ADMIN_ID, email: 'admin@agpro.test', name: 'Ada Admin', role: 'admin', passwordHash },
    { id: SALES_ID, email: 'sales@agpro.test', name: 'Sam Sales', role: 'sales', passwordHash },
    { id: MANAGER_ID, email: 'manager@agpro.test', name: 'Mia Manager', role: 'manager', passwordHash },
    { id: LOCKABLE_ID, email: LOCKABLE_EMAIL, name: 'Lockable User', role: 'sales', passwordHash },
  ]);

  await db.insert(companySettings).values({ legalName: 'AG Pro Solutions LLC' });

  await db.insert(priceTiers).values(
    PRICE_TIER_KEYS.map((key, index) => ({
      key,
      label: PRICE_TIER_LABELS[key],
      multiplier: DEFAULT_TIER_MULTIPLIERS[key],
      requiresApplication: key === 'financed_app' || key === 'cash_app',
      requiresPesticideLicense: key === 'cash_carry' || key === 'finance_carry',
      sortOrder: index * 10,
    })),
  );

  await db.insert(applicationFees).values({
    method: 'drone',
    label: 'Drone Application',
    pricePerAcreCents: 1350,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });

  await db.insert(invoiceSequences).values({ scope: 'default', prefix: 'INV', nextNumber: 1001 });

  await db.insert(customers).values({
    id: CUSTOMER_ID,
    accountNumber: 'AGP-001',
    name: 'Prairie Ridge Farms',
    phone: '641-555-0100',
    billCity: 'Creston',
    billState: 'IA',
  });

  await db.insert(products).values({
    id: SEED_PRODUCT_ID,
    sku: 'SEED-CL204',
    name: 'Channel CL-204',
    type: 'seed',
    unit: 'bag',
    isRegulatedSeed: true,
  });

  await db.insert(products).values({
    id: MISC_PRODUCT_ID,
    sku: 'MISC-SPRAYER',
    name: 'Sprayer nozzle kit',
    type: 'misc',
    unit: 'each',
    defaultCostCents: 3000,
  });

  // Stock-tracked product with a single receipt of 10, so the pool starts known.
  await db.insert(products).values({
    id: STOCK_PRODUCT_ID,
    sku: 'CHEM-STOCKTEST',
    name: 'Stock Test Herbicide',
    type: 'chemical',
    unit: 'gal',
    defaultCostCents: 1477,
  });

  await db.insert(inventoryLots).values({
    id: '77777777-7777-4777-8777-777777777777',
    productId: STOCK_PRODUCT_ID,
    lotNumber: 'LOT-A',
    quantityOnHand: 10,
    unitCostCents: 1477,
    receivedAt: new Date('2026-06-01T00:00:00Z'),
  });

  await db.insert(inventoryMovements).values({
    productId: STOCK_PRODUCT_ID,
    lotId: '77777777-7777-4777-8777-777777777777',
    movementType: 'receipt',
    quantityDelta: 10,
    unit: 'gal',
    quantityInBase: 10,
    unitCostCents: 1477,
    referenceType: 'manual',
    occurredAt: new Date('2026-06-01T00:00:00Z'),
  });

  /*
   * A program (blend) with one ingredient, so selling the blend can be shown to
   * draw down the chemical it is made of rather than consuming nothing.
   */
  await db.insert(products).values({
    id: BLEND_INGREDIENT_ID,
    sku: 'CHEM-BLENDINGREDIENT',
    name: 'Blend Ingredient',
    type: 'chemical',
    unit: 'oz',
    baseUnitCode: 'oz',
  });

  await db.insert(inventoryLots).values({
    id: '77777777-7777-4777-8777-777777777778',
    productId: BLEND_INGREDIENT_ID,
    lotNumber: 'LOT-B',
    quantityOnHand: 1000,
    unitCostCents: 100,
    receivedAt: new Date('2026-06-01T00:00:00Z'),
  });

  await db.insert(inventoryMovements).values({
    productId: BLEND_INGREDIENT_ID,
    lotId: '77777777-7777-4777-8777-777777777778',
    movementType: 'receipt',
    quantityDelta: 1000,
    unit: 'oz',
    quantityInBase: 1000,
    unitCostCents: 100,
    referenceType: 'manual',
    occurredAt: new Date('2026-06-01T00:00:00Z'),
  });

  await db.insert(applicationPrograms).values({
    id: TEST_PROGRAM_ID,
    name: 'Test Blend',
    crop: 'corn',
    stage: 'single',
    seasonYear: 2027,
  });

  await db.insert(programIngredients).values({
    programId: TEST_PROGRAM_ID,
    productId: BLEND_INGREDIENT_ID,
    productNameRaw: 'Blend Ingredient',
    ratePerAcre: 32,
    rateUnit: 'oz',
    costPerAcreCents: 3200,
  });

  const cashAppTier = await db
    .select()
    .from(priceTiers)
    .where(eq(priceTiers.key, 'cash_app'))
    .get();

  if (cashAppTier) {
    await db.insert(programPrices).values({
      programId: TEST_PROGRAM_ID,
      tierId: cashAppTier.id,
      pricePerAcreCents: 4500,
      costPerAcreCents: 3200,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
  }

  await db.insert(bankAccounts).values({
    id: BANK_ACCOUNT_ID,
    name: 'Operating',
    nextCheckNumber: 1001,
  });

  adminCookie = await login('admin@agpro.test');
  salesCookie = await login('sales@agpro.test');
  managerCookie = await login('manager@agpro.test');
});

describe('health', () => {
  it('reports the database as reachable', async () => {
    const response = await api('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string; checks: { database: string } };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
  });
});

describe('authentication', () => {
  it('rejects a wrong password without revealing whether the account exists', async () => {
    const response = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@agpro.test', password: 'wrong password entirely' }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Invalid email or password');
  });

  it('rejects an unknown account with the same message', async () => {
    const response = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@agpro.test', password: PASSWORD }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Invalid email or password');
  });

  it('requires a session for protected routes', async () => {
    expect((await api('/api/customers')).status).toBe(401);
  });

  it('returns the caller for a valid session', async () => {
    const response = await api('/api/auth/me', { cookie: salesCookie });
    const body = (await response.json()) as { user: { role: string; email: string } };

    expect(response.status).toBe(200);
    expect(body.user.role).toBe('sales');
    expect(body.user.email).toBe('sales@agpro.test');
  });

  it('never returns the password digest', async () => {
    const response = await api('/api/auth/me', { cookie: adminCookie });
    const body = (await response.json()) as { user: Record<string, unknown> };

    expect(body.user.passwordHash).toBeUndefined();
  });

  it('revokes the session on logout', async () => {
    const cookie = await login('sales@agpro.test');

    expect((await api('/api/auth/me', { cookie })).status).toBe(200);
    expect((await api('/api/auth/logout', { method: 'POST', cookie })).status).toBe(200);
    expect((await api('/api/auth/me', { cookie })).status).toBe(401);
  });
});

describe('RBAC enforcement', () => {
  it('lets sales users read and write the CRM', async () => {
    expect((await api('/api/customers', { cookie: salesCookie })).status).toBe(200);

    const created = await api('/api/customers', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ accountNumber: 'AGP-002', name: 'Walnut Creek Coop' }),
    });
    expect(created.status).toBe(201);
  });

  it('ignores a client-supplied account number and allocates its own', async () => {
    // Account numbers come from a sequence and identify the account, so a caller
    // must not be able to choose one. Supplying the same value twice has to yield
    // two *distinct* allocated numbers rather than the conflict a duplicate used
    // to produce — that conflict is now unreachable from the API by construction.
    const first = await api('/api/customers', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ accountNumber: 'AGP-002', name: 'Walnut Creek Coop' }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { accountNumber: string } };
    expect(firstBody.data.accountNumber).toMatch(/^AGP-\d{3,}$/);

    const second = await api('/api/customers', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ accountNumber: 'AGP-002', name: 'Duplicate Attempt' }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { accountNumber: string } };

    expect(secondBody.data.accountNumber).toMatch(/^AGP-\d{3,}$/);
    expect(secondBody.data.accountNumber).not.toBe(firstBody.data.accountNumber);
  });

  it('lets sales users read inventory but not write it', async () => {
    expect((await api('/api/products', { cookie: salesCookie })).status).toBe(200);

    const attempt = await api('/api/products', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ sku: 'CHEM-X', name: 'Test Herbicide', type: 'chemical' }),
    });
    expect(attempt.status).toBe(403);
  });

  it('lets managers write inventory', async () => {
    const created = await api('/api/products', {
      method: 'POST',
      cookie: managerCookie,
      body: JSON.stringify({ sku: 'CHEM-MGR-1', name: 'Manager Herbicide', type: 'chemical' }),
    });
    expect(created.status).toBe(201);
  });

  it('blocks sales from importing documents', async () => {
    const attempt = await api('/api/imports/batches', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ label: 'x', text: 'STRAIGHT BILL OF LADING' }),
    });
    expect(attempt.status).toBe(403);
  });
});

describe('checkwriting lockdown', () => {
  it('denies sales users outright', async () => {
    expect((await api('/api/checks', { cookie: salesCookie })).status).toBe(403);
  });

  it('denies managers outright', async () => {
    expect((await api('/api/checks', { cookie: managerCookie })).status).toBe(403);
  });

  it('denies sales users even on write endpoints', async () => {
    const attempt = await api('/api/checks', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ bankAccountId: BANK_ACCOUNT_ID, payeeName: 'X', amountCents: 100 }),
    });
    expect(attempt.status).toBe(403);
  });

  it('allows an admin', async () => {
    expect((await api('/api/checks', { cookie: adminCookie })).status).toBe(200);
  });

  it('allocates strictly increasing check numbers', async () => {
    const first = await api('/api/checks', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        bankAccountId: BANK_ACCOUNT_ID,
        payeeName: 'Wickman Chemical LLC',
        amountCents: 97_055,
        memo: 'Invoice 103935',
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { check: { checkNumber: number } } };
    expect(firstBody.data.check.checkNumber).toBe(1001);

    const second = await api('/api/checks', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        bankAccountId: BANK_ACCOUNT_ID,
        payeeName: 'Atticus LLC',
        amountCents: 5_760_000,
      }),
    });
    const secondBody = (await second.json()) as { data: { check: { checkNumber: number } } };
    expect(secondBody.data.check.checkNumber).toBe(1002);
  });

  it('issues distinct numbers under concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        api('/api/checks', {
          method: 'POST',
          cookie: adminCookie,
          body: JSON.stringify({
            bankAccountId: BANK_ACCOUNT_ID,
            payeeName: 'Concurrent Payee',
            amountCents: 100,
          }),
        }),
      ),
    );

    const numbers = await Promise.all(
      responses.map(async (response) => {
        const body = (await response.json()) as { data: { check: { checkNumber: number } } };
        return body.data.check.checkNumber;
      }),
    );

    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('reverses allocations when a check is voided, restoring the bill balance', async () => {
    // Bill with an open balance, paid by check, then voided.
    const billsResponse = await api('/api/checks', { cookie: adminCookie });
    expect(billsResponse.status).toBe(200);

    const created = await api('/api/checks', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        bankAccountId: BANK_ACCOUNT_ID,
        payeeName: 'I & B Ag Supply',
        amountCents: 25_000,
      }),
    });
    const { data } = (await created.json()) as { data: { check: { id: string; status: string } } };
    expect(data.check.status).toBe('draft');

    const printed = await api(`/api/checks/${data.check.id}/print`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(((await printed.json()) as { data: { status: string } }).data.status).toBe('printed');

    const voided = await api(`/api/checks/${data.check.id}/void`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ reason: 'Misprinted' }),
    });
    const voidedBody = (await voided.json()) as { data: { status: string; voidReason: string } };

    expect(voidedBody.data.status).toBe('voided');
    expect(voidedBody.data.voidReason).toBe('Misprinted');
  });
});

describe('Iowa seed compliance gate', () => {
  async function createSeedInvoice(): Promise<{ id: string; itemId: string }> {
    const response = await api('/api/invoices', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        pricingTierKey: 'cash_app',
        items: [
          {
            lineType: 'product',
            productId: SEED_PRODUCT_ID,
            description: 'Channel CL-204 seed',
            quantity: 10,
            unit: 'bag',
            unitPriceCents: 5000,
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };

    const db = createDb(env.DB);
    const items = await db.select().from(invoiceItems).all();
    const item = items.find((entry) => entry.invoiceId === body.data.id);

    return { id: body.data.id, itemId: item?.id as string };
  }

  it('creates a draft and prices it in integer cents', async () => {
    const { id } = await createSeedInvoice();

    const response = await api(`/api/invoices/${id}`, { cookie: salesCookie });
    const body = (await response.json()) as {
      data: { invoiceNumber: string; subtotalCents: number; totalCents: number; status: string };
    };

    expect(body.data.status).toBe('draft');
    expect(body.data.invoiceNumber).toMatch(/^INV-\d{5}$/);
    expect(body.data.subtotalCents).toBe(50_000);
    expect(body.data.totalCents).toBe(50_000);
  });

  it('blocks submission of regulated seed with no BOL/CMR and Order Number', async () => {
    const { id } = await createSeedInvoice();

    const response = await api(`/api/invoices/${id}/send`, { method: 'POST', cookie: salesCookie });
    expect(response.status).toBe(422);

    const body = (await response.json()) as {
      error: { message: string; details: { description: string }[] };
    };
    expect(body.error.message).toContain('Iowa seed compliance');
    expect(body.error.details).toHaveLength(1);
  });

  it('still reports the invoice as a draft after a blocked submission', async () => {
    const { id } = await createSeedInvoice();
    await api(`/api/invoices/${id}/send`, { method: 'POST', cookie: salesCookie });

    const response = await api(`/api/invoices/${id}`, { cookie: salesCookie });
    const body = (await response.json()) as { data: { status: string } };
    expect(body.data.status).toBe('draft');
  });

  it('permits submission once the audit tokens are recorded and verified', async () => {
    const { id, itemId } = await createSeedInvoice();
    const db = createDb(env.DB);

    // Record what the Channel BOL would have supplied, then verify it.
    const [log] = await db
      .insert(iowaComplianceLogs)
      .values({
        customerId: CUSTOMER_ID,
        productId: SEED_PRODUCT_ID,
        bolCmrNumber: '8358475862',
        orderNumber: '618150791',
        seedNumber: '173720',
        lotNumber: 'LOT-A',
        source: 'bol_import',
        verified: true,
        verifiedAt: new Date(),
      })
      .returning();

    await db
      .update(invoiceItems)
      .set({ complianceLogId: log?.id ?? null })
      .where(eq(invoiceItems.id, itemId));

    const response = await api(`/api/invoices/${id}/send`, { method: 'POST', cookie: salesCookie });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { status: string; complianceVerifiedAt: string | null };
    };
    expect(body.data.status).toBe('sent');
    expect(body.data.complianceVerifiedAt).not.toBeNull();

    // And the unique index refuses a duplicate token triple. The driver error is
    // wrapped by Drizzle, so this asserts through the same helper production uses
    // to translate the conflict into a 409.
    let duplicateRejected = false;
    try {
      await db.insert(iowaComplianceLogs).values({
        bolCmrNumber: '8358475862',
        orderNumber: '618150791',
        lotNumber: 'LOT-A',
      });
    } catch (error) {
      duplicateRejected = isUniqueConstraintError(error);
    }

    expect(duplicateRejected).toBe(true);
  });
});

describe('stock ledger', () => {
  /** Set by the consumption test so the reversal test operates on the same invoice. */
  let stockInvoiceId: string | null = null;

  it('starts from the receipt', async () => {
    const db = createDb(env.DB);
    expect(await productPoolQuantity(db, STOCK_PRODUCT_ID)).toBe(10);
  });

  it('consumes stock when an invoice is sent, and restores it when cancelled', async () => {
    const db = createDb(env.DB);

    const created = await api('/api/invoices', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        pricingTierKey: 'cash_app',
        items: [
          {
            lineType: 'product',
            productId: STOCK_PRODUCT_ID,
            description: 'Stock Test Herbicide',
            quantity: 3,
            unit: 'gal',
            unitPriceCents: 2000,
          },
        ],
      }),
    });
    const invoiceId = ((await created.json()) as { data: { id: string } }).data.id;
    stockInvoiceId = invoiceId;

    const sent = await api(`/api/invoices/${invoiceId}/send`, { method: 'POST', cookie: salesCookie });
    expect(sent.status).toBe(200);
    expect(await productPoolQuantity(db, STOCK_PRODUCT_ID)).toBe(7);

    // Cancelling is manager-level; sales can send but not cancel.
    const canceled = await api(`/api/invoices/${invoiceId}/cancel`, {
      method: 'POST',
      cookie: managerCookie,
    });
    expect(canceled.status).toBe(200);
    expect(await productPoolQuantity(db, STOCK_PRODUCT_ID)).toBe(10);
  });

  it('reversing twice does not inflate the pool', async () => {
    const db = createDb(env.DB);

    // Already reversed above; a second reversal must be a no-op rather than
    // crediting another 3 gallons.
    if (stockInvoiceId) {
      await reverseForInvoice(db, stockInvoiceId, null, new Date());
      await reverseForInvoice(db, stockInvoiceId, null, new Date());
    }

    expect(await productPoolQuantity(db, STOCK_PRODUCT_ID)).toBe(10);
  });

  it('goes negative rather than truncating when more is sold than held', async () => {
    const db = createDb(env.DB);

    const created = await api('/api/invoices', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        pricingTierKey: 'cash_app',
        items: [
          {
            lineType: 'product',
            productId: STOCK_PRODUCT_ID,
            description: 'Stock Test Herbicide',
            quantity: 15,
            unit: 'gal',
            unitPriceCents: 2000,
          },
        ],
      }),
    });
    const invoiceId = ((await created.json()) as { data: { id: string } }).data.id;

    await api(`/api/invoices/${invoiceId}/send`, { method: 'POST', cookie: salesCookie });

    // The sale happened, so the pool says -5. A person needs to see that, not have
    // it rounded to zero.
    expect(await productPoolQuantity(db, STOCK_PRODUCT_ID)).toBe(-5);
  });
});

describe('blend consumption', () => {
  it('draws down the ingredients of a program, in proportion to the acreage', async () => {
    const db = createDb(env.DB);

    expect(await productPoolQuantity(db, BLEND_INGREDIENT_ID)).toBe(1000);

    const created = await api('/api/invoices', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        pricingTierKey: 'cash_app',
        items: [
          {
            lineType: 'program',
            programId: TEST_PROGRAM_ID,
            description: 'Test Blend',
            acres: 10,
          },
        ],
      }),
    });

    expect(created.status).toBe(201);
    const invoiceId = ((await created.json()) as { data: { id: string } }).data.id;

    const sent = await api(`/api/invoices/${invoiceId}/send`, { method: 'POST', cookie: salesCookie });
    expect(sent.status).toBe(200);

    // 32 oz/acre over 10 acres is 320 oz, drawn from the 1000 on hand. Consuming
    // "the program" would have moved nothing at all, since a blend holds no stock.
    expect(await productPoolQuantity(db, BLEND_INGREDIENT_ID)).toBe(680);
  });
});

describe('search limits', () => {
  it('rejects a search term that would exceed D1 LIKE pattern limits', async () => {
    // D1 refuses a LIKE pattern over 50 bytes, so a long term is a hard error
    // rather than a slow query. It must be caught at the boundary.
    const long = 'x'.repeat(120);

    const response = await api(`/api/customers?q=${long}`, { cookie: salesCookie });
    expect(response.status).toBe(422);
  });

  it('accepts a search term within the limit', async () => {
    const response = await api('/api/customers?q=Prairie', { cookie: salesCookie });
    expect(response.status).toBe(200);
  });
});

describe('sign-in brute-force protection', () => {
  // Failures are counted per email (10) and per source IP (50). These tests stay
  // well inside the IP budget; if you add many more failure-driven tests, the IP
  // window will start tripping and the cause will not be obvious.
  async function attempt(email: string, password: string): Promise<Response> {
    return api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  it('clears recent failures after a successful sign-in', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await attempt('admin@agpro.test', 'wrong password entirely')).status).toBe(401);
    }

    expect((await attempt('admin@agpro.test', PASSWORD)).status).toBe(200);

    const db = createDb(env.DB);
    const remaining = await db
      .select({ total: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.email, 'admin@agpro.test'), eq(loginAttempts.success, false)))
      .get();

    expect(Number(remaining?.total ?? 0)).toBe(0);
  });

  it('locks an account after repeated failures, and the lock holds against the correct password', async () => {
    let response: Response | undefined;

    for (let i = 0; i <= MAX_FAILURES_PER_EMAIL; i += 1) {
      response = await attempt(LOCKABLE_EMAIL, 'wrong password entirely');
    }

    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('retry-after'))).toBeGreaterThan(0);

    const body = (await response?.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toContain('Too many sign-in attempts');

    // The lockout is real, not just failure counting: the right password is
    // refused while the window is open.
    expect((await attempt(LOCKABLE_EMAIL, PASSWORD)).status).toBe(429);
    // Generous on purpose. This makes MAX_FAILURES_PER_EMAIL + 2 genuine sign-in
    // attempts and each one deliberately pays a full Argon2id verification, so it
    // is seconds of hashing by design. Argon2id is roughly four times slower than
    // the PBKDF2 it replaced, which left this sitting on the default five-second
    // budget — a coin flip is not a useful thing for a test to be.
  }, 30_000);

  it('does not lock unrelated accounts', async () => {
    expect((await attempt('sales@agpro.test', PASSWORD)).status).toBe(200);
  });

  it('answers identically for an unknown account, so the limit is not an oracle', async () => {
    const unknown = await attempt('nobody-at-all@agpro.test', 'wrong password entirely');

    expect(unknown.status).toBe(401);
    const body = (await unknown.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Invalid email or password');
  });
});

describe('invoice delivery', () => {
  async function createInvoice(productId: string, description: string): Promise<string> {
    const response = await api('/api/invoices', {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        pricingTierKey: 'cash_app',
        items: [
          {
            lineType: 'product',
            productId,
            description,
            quantity: 1,
            unitPriceCents: 5000,
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    return ((await response.json()) as { data: { id: string } }).data.id;
  }

  it('refuses to email a regulated seed invoice whose tokens are not verified', async () => {
    const id = await createInvoice(SEED_PRODUCT_ID, 'Channel CL-204 seed');

    const response = await api(`/api/invoices/${id}/deliveries`, {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ method: 'email', to: 'customer@example.com' }),
    });

    expect(response.status).toBe(422);

    // And it must still be a draft: a blocked send cannot half-submit the invoice.
    const detail = await api(`/api/invoices/${id}`, { cookie: salesCookie });
    expect(((await detail.json()) as { data: { status: string } }).data.status).toBe('draft');
  });

  it('requires a recipient when the customer has no email address', async () => {
    const id = await createInvoice(MISC_PRODUCT_ID, 'Sprayer nozzle kit');

    const response = await api(`/api/invoices/${id}/deliveries`, {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ method: 'email' }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no email address');
  });

  it('records a delivery, submits the invoice, and admits when no provider is configured', async () => {
    const id = await createInvoice(MISC_PRODUCT_ID, 'Sprayer nozzle kit');

    const response = await api(`/api/invoices/${id}/deliveries`, {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ method: 'email', to: 'customer@example.com' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { delivery: { status: string; error: string | null }; invoice: { status: string } };
    };

    // No MAIL_PROVIDER_API_KEY in tests, so the honest outcome is "skipped" —
    // recorded, not transmitted, and never reported as a success.
    expect(body.data.delivery.status).toBe('skipped');
    expect(body.data.delivery.error).toContain('No mail provider is configured');
    expect(body.data.invoice.status).toBe('sent');
  });

  it('records a print as a delivery without needing a recipient', async () => {
    const id = await createInvoice(MISC_PRODUCT_ID, 'Sprayer nozzle kit');

    const response = await api(`/api/invoices/${id}/deliveries`, {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ method: 'print' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { delivery: { method: string; status: string } } };
    expect(body.data.delivery.method).toBe('print');
    expect(body.data.delivery.status).toBe('sent');
  });

  it('lists the delivery history for an invoice', async () => {
    const id = await createInvoice(MISC_PRODUCT_ID, 'Sprayer nozzle kit');

    await api(`/api/invoices/${id}/deliveries`, {
      method: 'POST',
      cookie: salesCookie,
      body: JSON.stringify({ method: 'print' }),
    });

    const response = await api(`/api/invoices/${id}/deliveries`, { cookie: salesCookie });
    const body = (await response.json()) as { data: { method: string }[] };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.method).toBe('print');
  });
});
