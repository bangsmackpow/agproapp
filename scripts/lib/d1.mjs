import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(LIB_DIR, '..', '..');

/** Locates Wrangler's entry point so it can be run with node, avoiding shell quoting. */
function resolveWranglerBin() {
  const local = join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (existsSync(local)) return local;

  try {
    return createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');
  } catch {
    throw new Error('Could not locate wrangler. Run `pnpm install` first.');
  }
}

/**
 * Runs SQL against a D1 database via Wrangler.
 *
 * The SQL is written to a temp file rather than passed as a `--command`
 * argument: that avoids Windows command-line length and quoting limits, and means
 * a shell can never mangle the statement.
 */
export function executeSql(sql, options = {}) {
  const { database = 'agpro-db', local = true, environment, json = false } = options;

  const dir = mkdtempSync(join(tmpdir(), 'agpro-sql-'));
  const file = join(dir, 'statement.sql');
  writeFileSync(file, sql, 'utf8');

  const args = ['d1', 'execute', database];
  if (environment) args.push('--env', environment);
  args.push(local ? '--local' : '--remote');
  if (json) args.push('--json');
  args.push('--file', file);

  try {
    return execFileSync(process.execPath, [resolveWranglerBin(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs a read-only query and returns the rows.
 *
 * Wrangler wraps results as an array of per-statement envelopes, and may print
 * banners around them, so the JSON is located by its outermost brackets rather
 * than assumed to be the whole of stdout.
 */
export function queryRows(sql, options = {}) {
  const output = executeSql(sql, { ...options, json: true });

  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  const parsed = JSON.parse(output.slice(start, end + 1));
  return parsed.flatMap((envelope) => envelope?.results ?? []);
}

/** Applies pending migrations to the local database. */
export function migrateLocal(database = 'agpro-db') {
  return execFileSync(
    process.execPath,
    [resolveWranglerBin(), 'd1', 'migrations', 'apply', database, '--local'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
}
