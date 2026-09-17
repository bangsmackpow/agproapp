#!/usr/bin/env node
/**
 * End-to-end smoke test against a built Worker.
 *
 * The unit suite runs against the API entry point (`src/worker.ts`) inside
 * workerd. It cannot see the React Router SSR layer, and that gap has already
 * produced two production bugs: a session cookie that was never relayed, and a
 * sign-out form whose action lived on a pathless layout.
 *
 * So this boots the real build, signs in as a throwaway admin, walks the auth
 * journey and loads every screen, then deletes the account it made.
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

/** Screens the shell renders; each must load without throwing. */
const SCREENS = ['/', '/customers', '/inventory', '/invoices', '/checks', '/imports', '/audit'];

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

function removeSmokeUser() {
  // Order matters: inventory_movements references products with ON DELETE
  // restrict, so the ledger has to go before the product it describes. That
  // constraint is the reason a product with movements cannot be deleted at all
  // from the application, which is deliberate.
  const smokeProducts = `(SELECT id FROM products WHERE sku LIKE 'SMOKE-%')`;

  executeSql(
    [
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
    const { body: created } = await jsonRequest('/api/products', cookie, {
      method: 'POST',
      body: JSON.stringify({ sku, name: 'Smoke Audit Product', type: 'chemical', unit: 'gal' }),
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
