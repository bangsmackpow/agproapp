#!/usr/bin/env node
/**
 * Archives audit-log rows older than the retention window, then deletes them.
 *
 *   pnpm audit:archive                      # report only, writes nothing
 *   pnpm audit:archive -- --confirm         # write the file, then delete
 *   pnpm audit:archive -- --months=24 --out=docs/archive/audit-2026.ndjson --confirm
 *   pnpm audit:archive -- --remote --confirm
 *
 * Retention was set at 12 months, with a yearly archive run by hand. Deliberately
 * manual: a scheduled job that deletes financial-adjacent records unattended is
 * not something that should exist in this app.
 *
 * SAFETY: the export is written and its size verified BEFORE any delete runs, and
 * deletion requires an explicit --confirm. If the file cannot be written, nothing
 * is deleted.
 *
 * `inventory_movements` is NOT touched by this script and never will be. Audit
 * rows are a record of actions; movements are the stock and cost ledger. Pruning
 * movements would reset every running total and destroy margin history.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { executeSql, PROJECT_ROOT, queryRows } from './lib/d1.mjs';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const months = Number.parseInt(flagValue('months', '12'), 10);
const confirm = args.includes('--confirm');
const local = !args.includes('--remote');
const outArg = flagValue('out', `docs/archive/audit-${new Date().toISOString().slice(0, 10)}.ndjson`);
const outPath = isAbsolute(outArg) ? outArg : join(PROJECT_ROOT, outArg);

if (!Number.isFinite(months) || months < 1 || months > 120) {
  console.error('--months must be between 1 and 120');
  process.exit(1);
}

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - months);

const cutoffIso = cutoff.toISOString();
console.log(`\nAudit archive${confirm ? '' : ' (dry run)'}`);
console.log(`Target   : ${local ? 'local D1' : 'remote D1'}`);
console.log(`Cutoff   : rows created before ${cutoffIso} (${months} months)`);
console.log(`Export   : ${outPath}`);

const counted = queryRows(
  `SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM audit_logs WHERE created_at < ${cutoff.getTime()};`,
);
const summary = counted[0] ?? {};

const total = Number(summary.total ?? 0);
if (total === 0) {
  console.log('\nNothing to archive.\n');
  process.exit(0);
}

const oldest = summary.oldest ? new Date(Number(summary.oldest)).toISOString() : 'unknown';
const newest = summary.newest ? new Date(Number(summary.newest)).toISOString() : 'unknown';
console.log(`\nRows     : ${total}`);
console.log(`Range    : ${oldest} .. ${newest}`);

if (!confirm) {
  console.log('\nDry run: nothing written, nothing deleted. Re-run with --confirm.\n');
  process.exit(0);
}

/* ── Export first, verify, then delete ─────────────────────────────────────── */

const rows = queryRows(
  [
    'SELECT id, actor_user_id, action, entity_type, entity_id, metadata, ip_address, created_at',
    'FROM audit_logs',
    `WHERE created_at < ${cutoff.getTime()}`,
    'ORDER BY created_at;',
  ].join(' '),
);

if (rows.length !== total) {
  console.error(
    `\nRefusing to continue: counted ${total} rows but selected ${rows.length}. Nothing was deleted.\n`,
  );
  process.exit(1);
}

const ndjson = rows.map((row) => JSON.stringify(row)).join('\n');
const ndjsonBytes = Buffer.byteLength(ndjson, 'utf8');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${ndjson}\n`, 'utf8');

// Verify the file actually landed before destroying the only other copy.
const written = statSync(outPath).size;
if (written < ndjsonBytes) {
  console.error(
    `\nRefusing to continue: wrote ${written} bytes but expected at least ${ndjsonBytes}. Nothing was deleted.\n`,
  );
  process.exit(1);
}

console.log(`Wrote    : ${written} bytes to ${outPath}`);

executeSql(`DELETE FROM audit_logs WHERE created_at < ${cutoff.getTime()};`, { local });

const remaining = queryRows('SELECT COUNT(*) AS total FROM audit_logs;');
console.log(`Deleted  : ${total} rows (${remaining[0]?.total ?? 0} remain)\n`);
