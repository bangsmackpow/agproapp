#!/usr/bin/env node
/**
 * End-to-end smoke test against a built Worker (v2).
 *
 * The unit suite runs the API inside workerd. It cannot see the React Router SSR
 * layer, and that blind spot produced three production bugs in the first build: a
 * session cookie that was never relayed, a sign-out whose action lived on a
 * pathless layout, and invoice creation failing body validation. So this boots the
 * real build and walks the paths a browser would take.
 *
 * It is deliberately small. Each check exists because something real breaks
 * without it — most importantly the staff-role 403, which is the only thing here
 * proving the capability map is enforced by the API rather than merely hidden by
 * the UI.
 *
 *   pnpm smoke
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createD1, migrateLocal, PROJECT_ROOT } from './lib/d1.mjs';
import { generatePassword, hashPassword, sqlText } from './lib/password.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 4319);
const BASE = `http://localhost:${PORT}`;
const STAMP = Date.now();
const ADMIN_EMAIL = `smoke-admin-${STAMP}@agpro.local`;
const STAFF_EMAIL = `smoke-staff-${STAMP}@agpro.local`;
const PASSWORD = generatePassword();

/** Screens that exist in the current phase. Add to this as phases land. */
const SCREENS = ['/', '/inventory', '/inventory/new', '/vendors'];

/** Filled in as the catalog checks run, so teardown can remove exactly these. */
const created = { productId: null, noCostId: null, vendorId: null };

const d1 = createD1({ local: true });
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPreview() {
  const vite = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(server, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`preview exited early with code ${server.exitCode}`);
    try {
      const response = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`preview did not become ready within ${timeoutMs}ms`);
}

/**
 * Hashes with the same implementation the Worker verifies against, so a digest
 * this script mints can never be a format the app would reject.
 */
function insertUser(email, name, role) {
  d1.execute(
    [
      'INSERT INTO users (id, email, password_hash, name, role, is_active, created_at, updated_at)',
      `VALUES (${sqlText(randomUUID())}, ${sqlText(email)}, ${sqlText(hashPassword(PASSWORD))},`,
      `${sqlText(name)}, ${sqlText(role)}, 1, unixepoch() * 1000, unixepoch() * 1000);`,
    ].join(' '),
  );
}

function teardown(emails) {
  const list = emails.map(sqlText).join(', ');
  const productIds = [created.productId, created.noCostId].filter(Boolean).map(sqlText).join(', ');
  const productsClause = productIds ? `(${productIds})` : "(NULL)";

  d1.execute(
    [
      // stock_movements references products with ON DELETE restrict, so the ledger
      // goes before the rows it describes — the same constraint that stops the app
      // deleting a product that has ever moved.
      `DELETE FROM stock_movements WHERE product_id IN ${productsClause};`,
      `DELETE FROM activity_log WHERE entity_type = 'product' AND entity_id IN ${productsClause};`,
      `DELETE FROM products WHERE id IN ${productsClause};`,
      `DELETE FROM activity_log WHERE entity_type = 'vendor' AND entity_id = ${sqlText(created.vendorId ?? '')};`,
      `DELETE FROM vendors WHERE id = ${sqlText(created.vendorId ?? '')};`,
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN (${list}));`,
      `DELETE FROM activity_log WHERE actor_user_id IN (SELECT id FROM users WHERE email IN (${list}));`,
      `DELETE FROM login_attempts WHERE email IN (${list});`,
      `DELETE FROM users WHERE email IN (${list});`,
    ].join('\n'),
  );
}

async function signIn(email) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
    redirect: 'manual',
  });
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  return { response, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function run() {
  if (!existsSync(join(PROJECT_ROOT, 'build', 'client'))) {
    throw new Error('No build found. Run `pnpm build` first (or use `pnpm smoke`).');
  }

  migrateLocal();
  // Reference data is idempotent, so running it here also proves it still applies
  // cleanly — a seed that only works on an empty database is a trap.
  d1.execute(readFileSync(join(PROJECT_ROOT, 'seed', '0001_reference.sql'), 'utf8'));
  insertUser(ADMIN_EMAIL, 'Smoke Admin', 'admin');
  insertUser(STAFF_EMAIL, 'Smoke Staff', 'staff');

  const server = startPreview();

  try {
    await waitForServer(server);

    /* ── Health and the anonymous boundary ─────────────────────────────────── */
    const health = await fetch(`${BASE}/api/health`);
    const healthBody = await health.json().catch(() => null);
    check('health reports the database reachable', health.status === 200 && healthBody?.status === 'ok');
    check(
      'health leaks no driver detail to an anonymous caller',
      !JSON.stringify(healthBody).includes('databaseError'),
    );

    const anonymous = await fetch(`${BASE}/`, { redirect: 'manual' });
    check(
      'anonymous request to / redirects to /login',
      anonymous.status === 302 && (anonymous.headers.get('location') ?? '').startsWith('/login'),
      `got ${anonymous.status} -> ${anonymous.headers.get('location')}`,
    );

    const loginPage = await fetch(`${BASE}/login`);
    const loginHtml = await loginPage.text();
    check('login page renders', loginPage.status === 200 && /Sign in/.test(loginHtml));

    /* ── Authentication ────────────────────────────────────────────────────── */
    const wrong = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'definitely-not-the-password' }),
      redirect: 'manual',
    });
    const unknown = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `nobody-${STAMP}@agpro.local`, password: PASSWORD }),
      redirect: 'manual',
    });
    const wrongBody = await wrong.text();
    const unknownBody = await unknown.text();

    check('wrong password is rejected without a session', wrong.status === 401 && !wrong.headers.get('set-cookie'), `${wrong.status}`);
    check(
      'unknown account and wrong password are indistinguishable',
      wrong.status === unknown.status && wrongBody === unknownBody,
      `${wrong.status} vs ${unknown.status}`,
    );

    const { response: signedIn, cookie } = await signIn(ADMIN_EMAIL);
    check('correct password issues a session', signedIn.status === 200 && cookie !== null, `${signedIn.status}`);
    if (!cookie) throw new Error('cannot continue without a session cookie');

    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
    const meBody = await me.json().catch(() => null);
    check('session resolves the current user', me.status === 200 && meBody?.user?.email === ADMIN_EMAIL);
    check(
      'the current-user response carries no password digest',
      !JSON.stringify(meBody).includes('passwordHash'),
    );

    /* ── Authenticated screens, as document and as client navigation ───────── */
    for (const screen of SCREENS) {
      const doc = await fetch(`${BASE}${screen}`, { headers: { cookie }, redirect: 'manual' });
      check(`screen ${screen} loads`, doc.status === 200, `got ${doc.status}`);

      const dataPath = screen === '/' ? '/.data' : `${screen}.data`;
      const data = await fetch(`${BASE}${dataPath}`, { headers: { cookie }, redirect: 'manual' });
      check(`screen ${screen} answers client navigation`, data.status === 200, `got ${data.status} for ${dataPath}`);
    }

    const dashboard = await fetch(`${BASE}/`, { headers: { cookie } });
    const dashboardHtml = await dashboard.text();
    check('dashboard greets the signed-in user', /Smoke/.test(dashboardHtml));
    check('dashboard warns that no service rates exist yet', /No service rates/i.test(dashboardHtml));

    /* ── Reference data reaches the UI through the typed client ────────────── */
    const tiers = await (await fetch(`${BASE}/api/settings/price-tiers`, { headers: { cookie } })).json();
    check('all four margin tiers are seeded', Array.isArray(tiers?.data) && tiers.data.length === 4, `got ${tiers?.data?.length}`);
    check('tier multipliers carry the worksheet arithmetic', (tiers?.data ?? []).every((t) => Number.isFinite(t.multiplier) && t.multiplier > 1));

    const settingsBody = await (await fetch(`${BASE}/api/settings`, { headers: { cookie } })).json();
    check('settings carry the Creston letterhead', settingsBody?.data?.city === 'Creston' && settingsBody?.data?.state === 'IA');

    /* ── Catalog and the stock ledger ────────────────────────────────────────
     * The spine of the business: a product has a cost, stock arrives, and the
     * on-hand number is *derived* from those movements rather than stored. Each
     * check below is a claim the inventory screen makes to a person deciding what
     * to buy, so a wrong answer here is a wrong order.
     */
    const vendor = await fetch(`${BASE}/api/vendors`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Smoke Supplier ${STAMP}`, phone: '(641) 555-0100' }),
    });
    const vendorBody = await vendor.json().catch(() => null);
    created.vendorId = vendorBody?.data?.id ?? null;
    check('a vendor can be added', vendor.status === 201 && created.vendorId !== null, `${vendor.status}`);

    const product = await fetch(`${BASE}/api/products`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        sku: `SMOKE-${STAMP}`,
        name: 'Smoke Glypho',
        type: 'chemical',
        unit: 'gal',
        costCents: 4200,
        reorderPoint: 50,
        reorderQuantity: 55,
        vendorId: created.vendorId,
      }),
    });
    const productBody = await product.json().catch(() => null);
    created.productId = productBody?.data?.id ?? null;
    check('a product can be catalogued with a cost', product.status === 201 && created.productId !== null, `${product.status} ${JSON.stringify(productBody)?.slice(0, 160)}`);

    const empty = await (await fetch(`${BASE}/api/products/${created.productId}`, { headers: { cookie } })).json();
    check('a new product starts at zero on hand', empty?.product?.quantityOnHand === 0, JSON.stringify(empty?.product?.quantityOnHand));
    check('zero against a reorder point of 50 is flagged as needing ordering', empty?.product?.needsReorder === true);
    check('a product with a cost is invoiceable', empty?.product?.isInvoiceable === true);

    const low = await (await fetch(`${BASE}/api/inventory/low`, { headers: { cookie } })).json();
    check('the needs-ordering list includes it', (low?.data ?? []).some((row) => row.id === created.productId));

    const receipt = await fetch(`${BASE}/api/products/${created.productId}/receipts`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 100, unitCostCents: 4300, reference: 'SMOKE-INV-1' }),
    });
    const receiptBody = await receipt.json().catch(() => null);
    check('receiving stock raises the pool', receipt.status === 201 && receiptBody?.data?.quantityOnHand === 100, `${receipt.status} ${JSON.stringify(receiptBody)?.slice(0, 160)}`);

    const adjustment = await fetch(`${BASE}/api/products/${created.productId}/adjustments`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ delta: -70, reason: 'Applied 70 acres on the Smith field' }),
    });
    const adjustmentBody = await adjustment.json().catch(() => null);
    check('a signed adjustment moves the pool', adjustment.status === 201 && adjustmentBody?.data?.quantityOnHand === 30, `${adjustment.status} ${JSON.stringify(adjustmentBody)?.slice(0, 160)}`);
    check('the adjustment keeps its reason', (adjustmentBody?.data?.movement?.note ?? '').includes('Smith field'));

    const overspill = await fetch(`${BASE}/api/products/${created.productId}/adjustments`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ delta: -1000, reason: 'Trying to go negative' }),
    });
    const overspillBody = await overspill.text();
    check(
      'a shrinkage larger than the stock on hand is refused',
      overspill.status === 422 && /negative|ledger/i.test(overspillBody),
      `${overspill.status} ${overspillBody.slice(0, 140)}`,
    );

    const detail = await fetch(`${BASE}/api/products/${created.productId}`, { headers: { cookie } });
    const detailBody = await detail.json().catch(() => null);
    check('the ledger tells the whole story of the number', (detailBody?.ledger ?? []).length === 2, `got ${(detailBody?.ledger ?? []).length}`);
    check('sold quantity is reported from the ledger', detailBody?.usedOnAcres === 0);

    const productPage = await fetch(`${BASE}/inventory/${created.productId}`, { headers: { cookie }, redirect: 'manual' });
    check(`the product screen loads`, productPage.status === 200, `got ${productPage.status}`);

    const priced = await fetch(`${BASE}/api/products?q=SMOKE-${STAMP}`, { headers: { cookie } });
    const pricedBody = await priced.json().catch(() => null);
    check('search finds the product by SKU', (pricedBody?.data ?? []).some((row) => row.id === created.productId));

    const unpriceable = await fetch(`${BASE}/api/products`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ sku: `SMOKE-NOCOST-${STAMP}`, name: 'No Cost Yet', type: 'other', unit: 'each' }),
    });
    const unpriceableBody = await unpriceable.json().catch(() => null);
    if (unpriceableBody?.data?.id) created.noCostId = unpriceableBody.data.id;
    check('a product may be saved without a cost', unpriceable.status === 201, `${unpriceable.status}`);
    check(
      'but it is reported as not invoiceable rather than priced at zero',
      unpriceableBody?.data?.costCents === null,
      JSON.stringify(unpriceableBody?.data?.costCents),
    );

    const attention = await (await fetch(`${BASE}/api/inventory/attention`, { headers: { cookie } })).json();
    check(
      'the dashboard count of unpriceable products includes it',
      (attention?.data?.missingCost ?? 0) >= 1,
      JSON.stringify(attention?.data?.missingCost),
    );
    check(
      'and the needs-ordering list is counted from the same place it is displayed',
      (attention?.data?.low ?? []).some((row) => row.id === created.noCostId || row.id === created.productId),
    );

    /* ── Capabilities are enforced by the API, not just the UI ─────────────── */
    const unauth = await fetch(`${BASE}/api/settings/service-rates`);
    check('unauthenticated API request is 401 JSON', unauth.status === 401 && (unauth.headers.get('content-type') ?? '').includes('json'), `${unauth.status}`);

    const notFound = await fetch(`${BASE}/api/nope`, { headers: { cookie } });
    const notFoundBody = await notFound.text();
    check(
      'unrouted API path returns structured JSON, never an HTML error page',
      notFound.status === 404 && notFoundBody.startsWith('{'),
      `${notFound.status} ${notFoundBody.slice(0, 60)}`,
    );

    const adminPatch = await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTermsDays: settingsBody?.data?.defaultTermsDays ?? 30 }),
    });
    check('admin may write settings', adminPatch.status === 200, `${adminPatch.status} ${await adminPatch.text()}`);

    const staffSession = await signIn(STAFF_EMAIL);
    const staffPatch = await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { cookie: staffSession.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTermsDays: 15 }),
    });
    check(
      'staff is refused at the API, not merely hidden in the UI',
      staffPatch.status === 403,
      `got ${staffPatch.status} ${await staffPatch.text()}`,
    );

    const staffRead = await fetch(`${BASE}/api/settings/price-tiers`, { headers: { cookie: staffSession.cookie } });
    check('staff can still read what the invoice composer needs', staffRead.status === 200, `${staffRead.status}`);

    // The split that matters in the field: someone at the barn can say what
    // arrived, but cannot redefine what a product costs.
    const staffProduct = await fetch(`${BASE}/api/products`, {
      method: 'POST',
      headers: { cookie: staffSession.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ sku: `SMOKE-STAFF-${STAMP}`, name: 'Should Not Exist', type: 'other', unit: 'each' }),
    });
    check('staff cannot change the catalog', staffProduct.status === 403, `got ${staffProduct.status}`);

    const staffReceipt = await fetch(`${BASE}/api/products/${created.productId}/receipts`, {
      method: 'POST',
      headers: { cookie: staffSession.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 1 }),
    });
    check('staff can record stock that physically arrived', staffReceipt.status === 201, `got ${staffReceipt.status}`);

    const staffScreen = await fetch(`${BASE}/inventory`, { headers: { cookie: staffSession.cookie }, redirect: 'manual' });
    check('staff can open the inventory screen', staffScreen.status === 200, `got ${staffScreen.status}`);

    const staffNew = await fetch(`${BASE}/inventory/new`, { headers: { cookie: staffSession.cookie }, redirect: 'manual' });
    check(
      'but the create screen refuses them rather than rendering a dead form',
      staffNew.status === 403,
      `got ${staffNew.status}`,
    );

    /* ── Sign out really revokes ───────────────────────────────────────────── */
    const signedOut = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    const replay = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
    check('sign out succeeds', signedOut.status === 200);
    check('the old cookie is rejected afterwards (revoked server-side)', replay.status === 401, `got ${replay.status}`);
  } finally {
    server.kill();
    teardown([ADMIN_EMAIL, STAFF_EMAIL]);
  }
}

try {
  await run();
} catch (error) {
  check('smoke run completed', false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((result) => !result.ok);

for (const result of results) {
  const mark = result.ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${mark}  ${result.name}${result.ok || !result.detail ? '' : `\n        ${result.detail}`}`);
}

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
