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
const SCREENS = ['/'];

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
  d1.execute(
    [
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
