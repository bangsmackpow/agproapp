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
 * Two transports, and the choice matters:
 *
 * - `--file` (the default) writes the SQL to a temp file. Use it for writes and
 *   multi-statement scripts: it avoids Windows command-line length limits and means
 *   a shell can never mangle the statement.
 * - `--command` passes the SQL as an argument. Reads MUST use this. Against the
 *   remote database, `--file --json` returns an execution *summary* in `results`
 *   rather than the query rows, so a read over `--file` silently yields a summary
 *   object that looks like a row.
 *
 * Everything is run through `execFileSync` with an argv array and no shell, so
 * quoting is not a concern either way.
 */
export function executeSql(sql, options = {}) {
  const { database = 'agpro-db', local = true, environment, json = false, command = false } = options;

  const args = ['d1', 'execute', database];
  if (environment) args.push('--env', environment);
  args.push(local ? '--local' : '--remote');
  if (json) args.push('--json');

  let tempDir = null;

  if (command) {
    args.push('--command', sql.replace(/\s+/g, ' ').trim());
  } else {
    tempDir = mkdtempSync(join(tmpdir(), 'agpro-sql-'));
    const file = join(tempDir, 'statement.sql');
    writeFileSync(file, sql, 'utf8');
    args.push('--file', file);
  }

  try {
    return execFileSync(process.execPath, [resolveWranglerBin(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Wrangler wraps results as `[{ results: [...], success, meta }]`. */
function extractEnvelopes(output) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
}

/**
 * True when a "row" is really Wrangler's execution summary.
 *
 * Detecting this is the point: over `--file` the summary arrives inside `results`,
 * so a naive reader treats "Total queries executed" as a column of a data row and
 * silently proceeds with nonsense.
 */
const isSummaryRow = (row) =>
  row !== null &&
  typeof row === 'object' &&
  ('Total queries executed' in row || 'Rows read' in row) &&
  !('id' in row);

/**
 * Runs a read-only query and returns the rows.
 *
 * Throws rather than returning garbage if the response looks like a summary, or if
 * every row was filtered as one — a wrong number that looks plausible is the worst
 * possible outcome for an import.
 */
export function queryRows(sql, options = {}) {
  if (sql.length > 20_000) {
    throw new Error('queryRows is for short statements; use executeSql for large scripts.');
  }

  const output = executeSql(sql, { ...options, json: true, command: true });
  const rows = extractEnvelopes(output).flatMap((envelope) => envelope?.results ?? []);

  const summaries = rows.filter(isSummaryRow);
  if (summaries.length > 0) {
    throw new Error(
      `queryRows received an execution summary instead of rows for: ${sql.slice(0, 80)}`,
    );
  }

  return rows;
}

/**
 * Binds a database target so reads and writes cannot diverge.
 *
 * This exists because they did. The price importer read products from the LOCAL
 * database while writing to remote, because `queryRows` defaulted to local and the
 * script only passed `--remote` to the writes. It matched twenty product names
 * against a catalogue that was not there, then inserted foreign keys pointing at
 * rows that did not exist. D1's referential integrity refused the write, which is
 * the only reason this was not silent data corruption.
 *
 * Bind the target once, then use the returned client for everything.
 */
export function createD1(options = {}) {
  const { database = 'agpro-db', local = true, environment } = options;
  const target = { database, local, environment };

  return {
    /** 'local' or 'remote', for logging which database is about to be touched. */
    where: local ? 'local' : 'remote',

    execute: (sql) => executeSql(sql, target),
    query: (sql) => queryRows(sql, target),
  };
}

/** Applies pending migrations to the local database. */
export function migrateLocal(database = 'agpro-db') {
  return execFileSync(
    process.execPath,
    [resolveWranglerBin(), 'd1', 'migrations', 'apply', database, '--local'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
}
