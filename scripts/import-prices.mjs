#!/usr/bin/env node
/**
 * Imports the 2027 chemical price sheet.
 *
 *   pnpm import:prices --dry-run     # report only, writes nothing
 *   pnpm import:prices               # apply to local D1
 *   pnpm import:prices -- --remote   # apply to the deployed D1
 *
 * Scope is deliberately narrow: `prices2027.csv` (programs and their
 * ingredients) only. The fungicide sheet packs three different tables — program
 * blocks, a package price list and an application-fee table — into one grid, and
 * is not parsed here.
 *
 * The 2027 sheet carries no costs and no prices: every tier cell is `0`. That is
 * "not yet priced", so zero is dropped rather than imported, and the resulting
 * programs are unpriced until someone fills them in through the app.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createD1, PROJECT_ROOT } from './lib/d1.mjs';
import { sqlText } from './lib/password.mjs';
import { matchProduct, parseCsv, parseProgramSheet, skuFor } from './lib/price-sheet.mjs';

const PRICE_COLUMNS = ['Finance App', 'Cash App', 'Cash & Carry', 'Finance & Carry'];
const SEASON_YEAR = 2027;
const SHEET = join(PROJECT_ROOT, 'docs', 'csv', 'prices2027.csv');

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const dryRun = flags.has('--dry-run');

/**
 * One bound client for every read and write. Reads previously defaulted to local
 * while writes went to remote, which matched product names against the wrong
 * catalogue.
 */
const db = createD1({ local: !flags.has('--remote') });

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!existsSync(SHEET)) {
  fail(
    `No sheet found at ${SHEET}\n` +
      'Export the "AG Pro 2027" worksheet as CSV into docs/csv/ first.',
  );
}

/* ── Parse ─────────────────────────────────────────────────────────────────── */

const parsed = parseProgramSheet(parseCsv(readFileSync(SHEET, 'utf8')), {
  priceColumns: PRICE_COLUMNS,
  seasonYear: SEASON_YEAR,
});

const ingredientRows = parsed.programs.reduce(
  (total, program) => total + program.ingredients.length,
  0,
);

console.log(`\nSheet      : ${SHEET}`);
console.log(
  `Parsed     : ${parsed.programs.length} programs, ${ingredientRows} ingredient rows, ` +
    `${parsed.annotations.length} stray cell notes`,
);
console.log(`Target     : ${db.where} D1${dryRun ? ' (dry run)' : ''}`);
if (db.where === 'remote') {
  console.log('             ^ PRODUCTION: both reads and writes go to the deployed database');
}

if (parsed.warnings.length > 0) {
  console.log('\nWarnings');
  for (const warning of parsed.warnings) console.log(`  ! ${warning}`);
}

for (const program of parsed.programs) {
  const priced = Object.values(program.totals?.pricesByTier ?? {}).filter(
    (price) => price !== null,
  ).length;
  console.log(
    `  · ${program.name.padEnd(22)} ${program.crop.padEnd(6)} ${program.stage.padEnd(6)} ` +
      `${String(program.passCount)} pass  ${program.ingredients.length} ingredients  ${priced} priced tiers`,
  );
}

if (parsed.annotations.length > 0) {
  console.log('\nStray notes that were not imported (review these by hand)');
  for (const note of parsed.annotations.slice(0, 20)) {
    console.log(`  row ${note.row}, column ${note.column}: ${note.value}`);
  }
  if (parsed.annotations.length > 20) {
    console.log(`  … and ${parsed.annotations.length - 20} more`);
  }
}

/* ── Reconcile products ────────────────────────────────────────────────────── */

const tiers = db.query('SELECT id, key FROM price_tiers WHERE is_active = 1;');
const tierIdByKey = new Map(tiers.map((tier) => [tier.key, tier.id]));

const TIER_KEY_BY_COLUMN = {
  'Finance App': 'financed_app',
  'Cash App': 'cash_app',
  'Cash & Carry': 'cash_carry',
  'Finance & Carry': 'finance_carry',
};

const missingTiers = PRICE_COLUMNS.filter(
  (column) => !tierIdByKey.has(TIER_KEY_BY_COLUMN[column]),
);
if (missingTiers.length > 0) {
  fail(
    `Pricing tiers are not seeded (missing: ${missingTiers.join(', ')}).\n` +
      'Run `pnpm db:seed:local` first.',
  );
}

const products = db.query('SELECT id, sku, name FROM products;');
/** Ids that existed before this run, to tell catalogue matches from in-run dedupe. */
const preexistingIds = new Set(products.map((product) => product.id));

const creations = [];
const matches = new Map();

for (const program of parsed.programs) {
  for (const ingredient of program.ingredients) {
    if (matches.has(ingredient.name)) continue;

    const found = matchProduct(ingredient.name, products);
    if (found) {
      matches.set(ingredient.name, {
        id: found.id,
        name: found.name,
        created: false,
        preexisting: preexistingIds.has(found.id),
      });
      continue;
    }

    // Unmatched names become products, but they are reported loudly: a bad
    // fuzzy match that creates a duplicate is invisible, a list is not.
    const created = {
      id: crypto.randomUUID(),
      sku: skuFor(ingredient.name),
      name: ingredient.name,
      created: true,
      preexisting: false,
    };
    matches.set(ingredient.name, created);
    creations.push(created);
    products.push({ id: created.id, sku: created.sku, name: created.name });
  }
}

const distinctProducts = new Set(parsed.programs.flatMap((p) => p.ingredients.map((i) => i.name)));
const resolved = [...matches.values()];
const fromCatalogue = resolved.filter((entry) => entry.preexisting).length;
const deduped = resolved.length - creations.length - fromCatalogue;

console.log(`\nProducts   : ${distinctProducts.size} distinct names across the sheet, ${resolved.length} resolved`);
console.log(`  created  : ${creations.length}`);
console.log(`  deduped  : ${deduped} (a second spelling of a name already seen in this sheet)`);
console.log(`  catalogue: ${fromCatalogue} (already in the product catalogue)`);

if (creations.length > 0) {
  console.log('\nProducts that will be created (check for near-duplicates of existing ones)');
  for (const product of creations) console.log(`  + ${product.sku.padEnd(28)} ${product.name}`);
}

const remapped = [...matches.entries()].filter(
  ([sheetName, resolved]) => !resolved.created && resolved.name !== sheetName,
);
if (remapped.length > 0) {
  console.log('\nFuzzy matches used (confirm these are the products you meant)');
  for (const [sheetName, resolved] of remapped) {
    console.log(`  ~ ${sheetName}  ->  ${resolved.name}`);
  }
}

/* ── Write ─────────────────────────────────────────────────────────────────── */

if (dryRun) {
  console.log('\nDry run: nothing was written.\n');
  process.exit(0);
}

const statements = [];
const effectiveFrom = Date.UTC(SEASON_YEAR, 0, 1);
let priceRowsWritten = 0;

for (const created of creations) {
  statements.push(
    `INSERT INTO products (id, sku, name, type, unit, is_active, taxable, created_at, updated_at) ` +
      `VALUES (${sqlText(created.id)}, ${sqlText(created.sku)}, ${sqlText(created.name)}, 'chemical', 'each', 1, 1, unixepoch() * 1000, unixepoch() * 1000);`,
  );
}

for (const program of parsed.programs) {
  const programId = crypto.randomUUID();

  statements.push(
    `INSERT INTO application_programs (id, name, crop, stage, pass_count, trait_system, default_application_method, season_year, is_active, created_at, updated_at) ` +
      `VALUES (${sqlText(programId)}, ${sqlText(program.name)}, ${sqlText(program.crop)}, ${sqlText(program.stage)}, ${program.passCount}, ` +
      `${program.traitSystem ? sqlText(program.traitSystem) : 'NULL'}, 'drone', ${SEASON_YEAR}, 1, unixepoch() * 1000, unixepoch() * 1000) ` +
      `ON CONFLICT (name, season_year) DO UPDATE SET crop = excluded.crop, stage = excluded.stage, ` +
      `pass_count = excluded.pass_count, trait_system = excluded.trait_system, updated_at = unixepoch() * 1000;`,
  );

  // Re-derive the id after the upsert so re-runs reuse the existing program.
  const [existing] = db.query(
    `SELECT id FROM application_programs WHERE name = ${sqlText(program.name)} AND season_year = ${SEASON_YEAR};`,
  );
  const resolvedProgramId = existing?.id ?? programId;

  // Idempotent: ingredients are replaced wholesale rather than merged, so a row
  // removed from the sheet disappears here too.
  statements.push(`DELETE FROM program_ingredients WHERE program_id = ${sqlText(resolvedProgramId)};`);
  statements.push(`DELETE FROM program_prices WHERE program_id = ${sqlText(resolvedProgramId)};`);

  program.ingredients.forEach((ingredient, index) => {
    const resolved = matches.get(ingredient.name);
    statements.push(
      `INSERT INTO program_ingredients (id, program_id, product_id, product_name_raw, rate_per_acre, rate_unit, cost_per_acre_cents, sort_order, created_at, updated_at) ` +
        `VALUES (${sqlText(crypto.randomUUID())}, ${sqlText(resolvedProgramId)}, ${sqlText(resolved.id)}, ${sqlText(ingredient.name)}, ` +
        `${ingredient.ratePerAcre ?? 'NULL'}, ${ingredient.rateUnit ? sqlText(ingredient.rateUnit) : 'NULL'}, ` +
        `${ingredient.costPerAcreCents ?? 'NULL'}, ${index}, unixepoch() * 1000, unixepoch() * 1000);`,
    );
  });

  for (const [column, key] of Object.entries(TIER_KEY_BY_COLUMN)) {
    const price = program.totals?.pricesByTier[column] ?? null;
    if (price === null) continue;

    statements.push(
      `INSERT INTO program_prices (id, program_id, tier_id, price_per_acre_cents, cost_per_acre_cents, effective_from, source_sheet, created_at, updated_at) ` +
        `VALUES (${sqlText(crypto.randomUUID())}, ${sqlText(resolvedProgramId)}, ${sqlText(tierIdByKey.get(key))}, ${price}, ` +
        `${program.totals?.costPerAcreCents ?? 'NULL'}, ${effectiveFrom}, 'prices2027.csv', unixepoch() * 1000, unixepoch() * 1000);`,
    );
    priceRowsWritten += 1;
  }
}

db.execute(statements.join('\n'));

console.log(
  `\nWritten    : ${creations.length} products, ${parsed.programs.length} programs, ` +
    `${ingredientRows} ingredients, ${priceRowsWritten} prices\n`,
);

if (priceRowsWritten === 0) {
  console.log(
    'No prices were imported because every tier cell in this sheet is 0.\n' +
      'The programs exist but cannot be invoiced until prices are set in the app.\n',
  );
}
