#!/usr/bin/env node
/**
 * End-to-end smoke test against a built Worker.
 *
 * The unit suite runs against the API entry point (`src/worker.ts`) inside
 * workerd. It cannot see the React Router SSR layer, and that gap has already
 * produced three production bugs: a session cookie that was never relayed, a
 * sign-out form whose action lived on a pathless layout, and invoice creation
 * failing validation because the form sent an empty description the schema
 * rejected. All three lived in the action/form layer the unit suite cannot reach.
 *
 * So this boots the real build, signs in as a throwaway admin, walks the auth
 * journey, loads every screen, submits the invoice form the way a browser does,
 * then deletes everything it made.
 *
 *   pnpm smoke
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { executeSql, migrateLocal, PROJECT_ROOT } from './lib/d1.mjs';
import { generatePassword, hashPassword, sqlText } from './lib/password.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 4319);
const BASE = `http://localhost:${PORT}`;
const EMAIL = `smoke-${Date.now()}@agpro.local`;
const PASSWORD = generatePassword();

/**
 * Invoicing needs a customer and a price tier. The tier normally arrives via
 * seed/0001_reference.sql, but the smoke database is only migrated, not seeded,
 * so the run ensures one exists and removes everything it created afterwards.
 */
const PRICE_TIER_KEY = 'cash_app';
const CUSTOMER_PREFIX = 'SMOKE-';
const CUSTOMER_NAME = 'Smoke Invoice Customer';
const PRODUCT_NAME = 'Smoke Audit Product';

/** Screens the shell renders; each must load without throwing. */
const SCREENS = [
  '/',
  '/customers',
  '/inventory',
  // The product create screen. Listed explicitly because it is a literal route
  // declared ahead of `inventory/:id`, and a mis-ordered table would send it to
  // the record page instead — which loads fine and would hide the mistake.
  '/inventory/new',
  '/invoices',
  '/checks',
  '/imports',
  '/audit',
];

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
    if (server.exitCode !== null) {
      throw new Error(`preview exited early with code ${server.exitCode}`);
    }
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

function createSmokeUser() {
  const sql = [
    'INSERT INTO users (id, email, password_hash, name, role, is_active, created_at, updated_at)',
    `VALUES (${sqlText(randomUUID())}, ${sqlText(EMAIL)}, ${sqlText(hashPassword(PASSWORD))},`,
    `${sqlText('Smoke Test Admin')}, 'admin', 1, unixepoch() * 1000, unixepoch() * 1000);`,
  ].join(' ');

  executeSql(sql);
}

/**
 * Invoicing needs at least one price tier to exist, and tiers come from
 * seed/0001_reference.sql rather than from a migration. `INSERT OR IGNORE` keys
 * off the unique index on `key`, so this is safe whether or not the database was
 * ever seeded, and it never disturbs a real tier's pricing.
 */
function ensureSmokeReference() {
  executeSql(
    [
      'INSERT OR IGNORE INTO price_tiers',
      '(id, key, label, multiplier, requires_application, requires_pesticide_license, sort_order, is_active, created_at, updated_at)',
      `VALUES (${sqlText(randomUUID())}, ${sqlText(PRICE_TIER_KEY)}, 'Smoke Cash Application', 1.2, 0, 0, 0, 1, unixepoch() * 1000, unixepoch() * 1000);`,
    ].join(' '),
  );
}

function removeSmokeUser() {
  // Order matters: inventory_movements references products with ON DELETE
  // restrict, so the ledger has to go before the product it describes. That
  // constraint is the reason a product with movements cannot be deleted at all
  // from the application, which is deliberate. Invoices are the same story —
  // their lines and delivery records point at them.
  const smokeProducts = `(SELECT id FROM products WHERE sku LIKE 'SMOKE-%')`;
  const smokeCustomers = `(SELECT id FROM customers WHERE account_number LIKE '${CUSTOMER_PREFIX}%')`;
  const smokeInvoices = `(SELECT id FROM invoices WHERE customer_id IN ${smokeCustomers})`;

  executeSql(
    [
      `DELETE FROM invoice_deliveries WHERE invoice_id IN ${smokeInvoices};`,
      `DELETE FROM invoice_items WHERE invoice_id IN ${smokeInvoices};`,
      `DELETE FROM audit_logs WHERE entity_type = 'invoice' AND entity_id IN ${smokeInvoices};`,
      `DELETE FROM invoices WHERE customer_id IN ${smokeCustomers};`,
      `DELETE FROM audit_logs WHERE entity_type = 'customer' AND entity_id IN ${smokeCustomers};`,
      `DELETE FROM customers WHERE account_number LIKE '${CUSTOMER_PREFIX}%';`,
      `DELETE FROM inventory_movements WHERE product_id IN ${smokeProducts};`,
      `DELETE FROM inventory_lots WHERE product_id IN ${smokeProducts};`,
      `DELETE FROM product_costs WHERE product_id IN ${smokeProducts};`,
      `DELETE FROM audit_logs WHERE entity_id IN ${smokeProducts};`,
      `DELETE FROM products WHERE sku LIKE 'SMOKE-%';`,
      `DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${sqlText(EMAIL)}) OR entity_id IN (SELECT id FROM users WHERE email = ${sqlText(EMAIL)});`,
      `DELETE FROM login_attempts WHERE email = ${sqlText(EMAIL)};`,
      `DELETE FROM users WHERE email = ${sqlText(EMAIL)};`,
    ].join('\n'),
  );
}

/** A JSON request carrying the session cookie. */
async function jsonRequest(path, cookie, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    redirect: 'manual',
  });

  return { response, body: await response.json().catch(() => null) };
}

async function signIn() {
  const response = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
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
  createSmokeUser();
  ensureSmokeReference();

  const server = startPreview();

  try {
    await waitForServer(server);

    /* ── Unauthenticated ─────────────────────────────────────────────────── */
    const health = await fetch(`${BASE}/api/health`);
    const healthBody = await health.json().catch(() => null);
    check('health reports the database reachable', health.status === 200 && healthBody?.status === 'ok');

    const anonymous = await fetch(`${BASE}/`, { redirect: 'manual' });
    check(
      'anonymous request to / redirects to /login',
      anonymous.status === 302 && (anonymous.headers.get('location') ?? '').startsWith('/login'),
      `got ${anonymous.status} -> ${anonymous.headers.get('location')}`,
    );

    const loginPage = await fetch(`${BASE}/login`);
    const loginHtml = await loginPage.text();
    check('login page renders', loginPage.status === 200 && /Sign in/.test(loginHtml));

    /* ── Authentication ──────────────────────────────────────────────────── */
    const bad = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: EMAIL, password: 'definitely-not-the-password' }),
      redirect: 'manual',
    });
    const badHtml = await bad.text();
    check(
      'wrong password is rejected without setting a session',
      bad.status === 200 &&
        /Invalid email or password/.test(badHtml) &&
        !bad.headers.get('set-cookie'),
    );

    const { response: signedIn, cookie } = await signIn();
    check(
      'correct password issues a session',
      signedIn.status === 302 && cookie !== null,
      `got ${signedIn.status}, cookie ${cookie ? 'present' : 'missing'}`,
    );

    if (!cookie) throw new Error('cannot continue without a session cookie');

    /* ── Authenticated journey ───────────────────────────────────────────── */
    const dashboard = await fetch(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
    const dashboardHtml = await dashboard.text();
    check('dashboard loads', dashboard.status === 200);
    check(
      'sign-out form targets its own route',
      dashboardHtml.includes('action="/logout"'),
      'a form without an explicit action posts to the current path and will 405',
    );

    for (const screen of SCREENS) {
      const response = await fetch(`${BASE}${screen}`, { headers: { cookie }, redirect: 'manual' });
      check(`screen ${screen} loads`, response.status === 200, `got ${response.status}`);
    }

    /* ── Audit records what actually changed ─────────────────────────────── */
    // A diff is only worth having if it captures the previous value, so this
    // changes a product's unit and reads the change back out of the trail.
    const sku = `SMOKE-${Date.now()}`;
    // Priced for the tier the invoice check below sells on, so the line is
    // sellable from the form — the form sends no price of its own.
    const { body: created } = await jsonRequest('/api/products', cookie, {
      method: 'POST',
      body: JSON.stringify({
        sku,
        name: PRODUCT_NAME,
        type: 'chemical',
        unit: 'gal',
        cashAppPriceCents: 500,
      }),
    });
    check('product can be created', Boolean(created?.data?.id), JSON.stringify(created));

    const productId = created?.data?.id;

    if (productId) {
      await jsonRequest(`/api/products/${productId}`, cookie, {
        method: 'PATCH',
        body: JSON.stringify({ unit: 'oz' }),
      });

      const { body: audit } = await jsonRequest('/api/audit?entityType=product&limit=20', cookie);
      const event = (audit?.data ?? []).find(
        (row) => row.entityId === productId && row.action === 'product.updated',
      );
      const change = event?.metadata?.changes?.unit;

      check(
        'the audit trail records who changed what, including the previous value',
        change?.from === 'gal' && change?.to === 'oz',
        `expected gal -> oz, got ${JSON.stringify(change)}`,
      );

      /* ── Receiving stock moves the pool ─────────────────────────────────── */
      // The pool is the sum of ledger movements, so a receipt that writes a lot but
      // no movement would leave stock invisible. This asserts the two travel
      // together.
      const { response: received, body: receipt } = await jsonRequest(
        `/api/products/${productId}/receipts`,
        cookie,
        { method: 'POST', body: JSON.stringify({ quantity: 10, unit: 'oz', unitCostCents: 1477 }) },
      );
      check('stock can be received', received.status === 201, JSON.stringify(receipt));

      const { body: afterReceive } = await jsonRequest(`/api/products/${productId}/stock`, cookie);
      check(
        'receiving stock raises the pool',
        afterReceive?.data?.quantityOnHand === 10,
        `expected 10, got ${JSON.stringify(afterReceive?.data?.quantityOnHand)}`,
      );

      await jsonRequest(`/api/products/${productId}/adjustments`, cookie, {
        method: 'POST',
        body: JSON.stringify({ delta: -3, unit: 'oz', reason: 'Annual count' }),
      });

      const { body: afterAdjust } = await jsonRequest(`/api/products/${productId}/stock`, cookie);
      check(
        'an adjustment with a reason moves the pool and is recorded in the ledger',
        afterAdjust?.data?.quantityOnHand === 7 &&
          afterAdjust?.data?.ledger?.some((row) => row.movementType === 'adjustment'),
        `pool ${JSON.stringify(afterAdjust?.data?.quantityOnHand)}, ledger ${afterAdjust?.data?.ledger?.length}`,
      );

      /* ── Invoice creation through the form ───────────────────────────────
       * Submits the payload the browser actually sends, urlencoded to the route
       * action, because that is the layer that broke: the action assembled an
       * empty description from a hidden input, the schema required one character,
       * and every invoice failed. The unit suite cannot reach this layer, so this
       * is the check that would have caught it.
       */
      const { body: customer } = await jsonRequest('/api/customers', cookie, {
        method: 'POST',
        body: JSON.stringify({
          accountNumber: `${CUSTOMER_PREFIX}${Date.now()}`,
          name: CUSTOMER_NAME,
        }),
      });

      if (customer?.data?.id) {
        const submitted = await fetch(`${BASE}/invoices.data`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            customerId: customer.data.id,
            pricingTierKey: PRICE_TIER_KEY,
            lineKind: 'product',
            productId,
            quantity: '2',
          }),
          redirect: 'manual',
        });
        const submittedBody = await submitted.text();

        check(
          'an invoice can be created from the form, the way the browser submits it',
          submitted.status < 400 && !/failed validation/i.test(submittedBody),
          `${submitted.status} ${submittedBody.slice(0, 300)}`,
        );

        // The form no longer sends a description; the server derives it. A blank
        // one would mean the regression returned by another route.
        const { body: invoices } = await jsonRequest('/api/invoices?limit=50', cookie);
        const draft = (invoices?.data ?? []).find((row) => row.customerName === CUSTOMER_NAME);
        const { body: detail } = draft
          ? await jsonRequest(`/api/invoices/${draft.id}`, cookie)
          : { body: null };

        // `items` is a sibling of `data` on this endpoint, not nested under it.
        check(
          'the draft line is described by the product, not left blank',
          detail?.items?.[0]?.description === PRODUCT_NAME,
          `got ${JSON.stringify(detail?.items?.[0]?.description)}`,
        );
      } else {
        check('an invoice can be created from the form, the way the browser submits it', false, 'no customer created');
      }
    }

    /* ── Sign out ────────────────────────────────────────────────────────── */    const signedOut = await fetch(`${BASE}/logout`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'x=1',
      redirect: 'manual',
    });
    const cleared = signedOut.headers.getSetCookie?.()[0] ?? signedOut.headers.get('set-cookie');
    check(
      'sign out redirects to /login and clears the cookie',
      signedOut.status === 302 &&
        (signedOut.headers.get('location') ?? '').includes('/login') &&
        /agpro_session=;|agpro_session=(;|$)/.test(cleared ?? '') === true,
      `got ${signedOut.status} -> ${signedOut.headers.get('location')}`,
    );

    const replay = await fetch(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
    check(
      'the old cookie is rejected afterwards (session revoked server-side)',
      replay.status === 302 && (replay.headers.get('location') ?? '').startsWith('/login'),
      `got ${replay.status} -> ${replay.headers.get('location')}`,
    );
  } finally {
    server.kill();
    removeSmokeUser();
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
