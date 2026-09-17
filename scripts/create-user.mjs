#!/usr/bin/env node
/**
 * Creates a user, hashing the password with the exact same scheme the Worker
 * verifies against (src/api/lib/password.ts):
 *
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt base64url>$<digest base64url>
 *
 * Both sides call `@noble/hashes` with identical parameters rather than each
 * carrying its own derivation, because they diverged once: this script used to
 * mint PBKDF2 digests at a work factor Cloudflare's WebCrypto refuses to compute,
 * so every account it created was impossible to sign in with. Importing one
 * implementation is what prevents a repeat.
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

import { createInterface } from 'node:readline';

import { executeSql } from './lib/d1.mjs';
import { hashPassword, sqlText } from './lib/password.mjs';

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
  pnpm user:create -- --update -- --remote    reset an existing password

Options:
  --email <address>    required (prompted if omitted)
  --name <full name>   required when creating (prompted if omitted)
  --role <role>        sales | manager | admin   (default: admin)
  --password <value>   prompted and hidden if omitted
  --update             reset the password of an existing account
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

/* ── SQL ───────────────────────────────────────────────────────────────────── */

function buildInsert({ email, name, role, passwordHash }) {
  // A fixed id keeps re-running idempotent-ish and makes the row easy to find.
  return [
    'INSERT INTO users (id, email, password_hash, name, role, is_active, created_at, updated_at)',
    `VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),`,
    `${sqlText(email)}, ${sqlText(passwordHash)}, ${sqlText(name)}, ${sqlText(role)}, 1, unixepoch() * 1000, unixepoch() * 1000);`,
  ].join(' ');
}

/**
 * Resets the password on an existing account.
 *
 * This is the documented way out when someone is locked out — including when a
 * stored digest was created with a work factor the deployed runtime cannot
 * compute, which is not fixable by signing in.
 */
function buildPasswordReset({ email, name, role, passwordHash }) {
  const assignments = [`password_hash = ${sqlText(passwordHash)}`];
  if (name) assignments.push(`name = ${sqlText(name)}`);
  if (role) assignments.push(`role = ${sqlText(role)}`);
  assignments.push('updated_at = unixepoch() * 1000');

  return `UPDATE users SET ${assignments.join(', ')} WHERE email = ${sqlText(email)};`;
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

try {
  const resetting = Boolean(flags.update);

  const email = String(flags.email ?? (await prompt('Email: '))).trim().toLowerCase();
  if (!email.includes('@')) throw new Error('That does not look like an email address.');

  // A name is required when creating; optional when only resetting a password.
  const name = String(flags.name ?? (resetting ? '' : await prompt('Full name: '))).trim();
  if (!name && !resetting) throw new Error('A name is required.');

  const roleExplicit = flags.role !== undefined;
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

  const sql = resetting
    ? buildPasswordReset({
        email,
        name,
        // Only touch the role when it was asked for explicitly.
        role: roleExplicit ? role : null,
        passwordHash,
      })
    : buildInsert({ email, name, role, passwordHash });

  console.log(
    `\n${resetting ? 'Resetting password for' : 'Creating'} ${role}${name ? ` "${name}"` : ''} <${email}>`,
  );
  console.log(
    `Target: ${database} ${flags.remote ? '(remote)' : '(local)'}${flags.env ? ` env=${flags.env}` : ''}`,
  );

  const output = executeSql(sql, {
    database,
    local: !flags.remote,
    environment: flags.env ? String(flags.env) : undefined,
  });

  if (resetting && /"rows_written":\s*0/.test(output)) {
    console.error(`\nNo account exists with the email <${email}> — nothing was changed.`);
    process.exitCode = 1;
  } else {
    console.log('\nDone. Sign in with the password you just entered.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
  const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';

  if (/UNIQUE constraint failed/i.test(`${message}${stderr}${stdout}`)) {
    console.error(
      `\nThat email address already exists. Re-run with --update to reset its password instead.`,
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
