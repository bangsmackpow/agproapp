#!/usr/bin/env node
/**
 * Creates a user, hashing the password with the exact same scheme the Worker
 * verifies against (src/api/lib/password.ts):
 *
 *   pbkdf2$sha256$210000$<salt base64url>$<digest base64url>
 *
 * This exists because a fresh database has no users, so there is no way to log
 * in. Run it once after the first migration to create the founding Admin.
 *
 *   pnpm user:create                       # interactive, writes to local D1
 *   pnpm user:create -- --remote           # writes to the Cloudflare D1
 *   pnpm user:create -- --remote --env production
 *
 * Flags: --email --name --role --password --remote --env --db --help
 */

import { execFileSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

const ITERATIONS = 210_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const DIGEST = 'sha256';
const MIN_PASSWORD_LENGTH = 12;
const ROLES = new Set(['sales', 'manager', 'admin']);
const DEFAULT_DATABASE = 'agpro-db';

/* ── Argument parsing ──────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const flags = { positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') continue;
    if (!token.startsWith('--')) {
      flags.positionals.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      flags[key] = argv[i + 1];
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

if (flags.help) {
  console.log(`
Create a user for AG Pro Solutions.

  pnpm user:create                     interactive; local D1
  pnpm user:create -- --remote         Cloudflare D1 (top-level environment)
  pnpm user:create -- --remote --env production

Options:
  --email <address>    required (prompted if omitted)
  --name <full name>   required (prompted if omitted)
  --role <role>        sales | manager | admin   (default: admin)
  --password <value>   prompted and hidden if omitted
  --remote             target the deployed D1 instead of the local one
  --env <name>         wrangler environment to target
  --db <name>          D1 database name      (default: ${DEFAULT_DATABASE})
`);
  process.exit(0);
}

/* ── Prompts ───────────────────────────────────────────────────────────────── */

let rl;
function prompt(question) {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** Reads a line with the characters hidden; falls back to a plain read when not a TTY. */
function promptHidden(question) {
  if (!process.stdin.isTTY) return prompt(question);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);

    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (result) => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(result);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') return finish(value);
        if (char === '\u0003') {
          process.stdout.write('\n');
          stdin.setRawMode(wasRaw);
          reject(new Error('Cancelled'));
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };

    stdin.on('data', onData);
  });
}

/* ── Hashing (kept byte-compatible with src/api/lib/password.ts) ───────────── */

function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const digest = pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, DIGEST);
  return [
    'pbkdf2',
    DIGEST,
    ITERATIONS,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

/* ── SQL ───────────────────────────────────────────────────────────────────── */

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;

function buildInsert({ email, name, role, passwordHash }) {
  // A fixed id keeps re-running idempotent-ish and makes the row easy to find.
  return [
    'INSERT INTO users (id, email, password_hash, name, role, is_active, created_at, updated_at)',
    `VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),`,
    `${sqlText(email)}, ${sqlText(passwordHash)}, ${sqlText(name)}, ${sqlText(role)}, 1, unixepoch() * 1000, unixepoch() * 1000);`,
  ].join(' ');
}

/**
 * Runs a SQL file through `wrangler d1 execute`.
 *
 * The SQL goes in a temp file rather than a `--command` argument: it avoids
 * Windows command-line quoting and length limits, and it means neither the
 * password hash nor the email can be mangled by a shell.
 */
function executeSql(sql, { database, remote, environment }) {
  const localBin = join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  let wranglerBin = existsSync(localBin) ? localBin : null;

  if (!wranglerBin) {
    try {
      wranglerBin = createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');
    } catch {
      wranglerBin = null;
    }
  }

  if (!wranglerBin) {
    throw new Error('Could not locate wrangler. Run `pnpm install` first.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'agpro-create-user-'));
  const file = join(dir, 'create-user.sql');
  writeFileSync(file, sql, 'utf8');

  const args = ['d1', 'execute', database];
  if (environment) args.push('--env', environment);
  args.push(remote ? '--remote' : '--local');
  args.push('--file', file);

  try {
    return execFileSync(process.execPath, [wranglerBin, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

try {
  const email = String(flags.email ?? (await prompt('Email: '))).trim().toLowerCase();
  if (!email.includes('@')) throw new Error('That does not look like an email address.');

  const name = String(flags.name ?? (await prompt('Full name: '))).trim();
  if (!name) throw new Error('A name is required.');

  const role = String(flags.role ?? 'admin').trim().toLowerCase();
  if (!ROLES.has(role)) throw new Error(`Role must be one of: ${[...ROLES].join(', ')}`);

  let password = typeof flags.password === 'string' ? flags.password : '';
  if (!password) {
    password = await promptHidden(`Password (min ${MIN_PASSWORD_LENGTH} characters): `);
    const confirmation = await promptHidden('Confirm password: ');
    if (password !== confirmation) throw new Error('Passwords did not match.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const database = String(flags.db ?? DEFAULT_DATABASE);

  const passwordHash = hashPassword(password);
  const sql = buildInsert({ email, name, role, passwordHash });

  console.log(`\nCreating ${role} "${name}" <${email}>`);
  console.log(
    `Target: ${database} ${flags.remote ? '(remote)' : '(local)'}${flags.env ? ` env=${flags.env}` : ''}`,
  );

  executeSql(sql, {
    database,
    remote: Boolean(flags.remote),
    environment: flags.env ? String(flags.env) : undefined,
  });

  console.log('\nCreated. Sign in with the password you just entered.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
  const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';

  if (/UNIQUE constraint failed/i.test(`${message}${stderr}${stdout}`)) {
    console.error(
      `\nThat email address already exists. Use --email with a different address, or change the existing user's password from the app.`,
    );
  } else {
    console.error(`\nFailed: ${message}`);
    const detail = stderr.trim() || stdout.trim();
    if (detail) console.error(detail);
  }
  process.exitCode = 1;
} finally {
  rl?.close();
}
