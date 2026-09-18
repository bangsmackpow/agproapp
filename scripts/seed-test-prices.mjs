#!/usr/bin/env node
/**
 * Loads placeholder prices so invoicing can be exercised before the real 2027
 * sheet is priced.
 *
 * The 2027 import brought in 7 programs and 15 products with **no prices at all**,
 * which means the invoice composer refuses every program line ("no price for tier")
 * and every product line. Nothing about the invoicing flow can be tested until
 * something is priced.
 *
 * **These are not real prices.** Every row this writes is tagged with a marker so
 * it can be found and removed in one command, and the product columns it fills are
 * recorded in `product_costs` for the same reason:
 *
 *   pnpm prices:test                     # local
 *   pnpm prices:test -- --remote         # the deployed D1
 *   pnpm prices:test -- --remote --clear # remove every placeholder
 *
 * Run the clear before real prices are loaded, or the placeholders will look like
 * a quote someone entered.
 *
 * Placeholder costs are round numbers derived from the program name, not from the
 * ingredient sheet, so the derived prices are tidy and obviously synthetic.
 */

import { randomUUID } from 'node:crypto';

import { createD1 } from './lib/d1.mjs';
import { sqlText } from './lib/password.mjs';

const MARKER = 'TEST DATA (placeholder)';

/**
 * Dated well before today on purpose.
 *
 * `findProgramPrice` resolves a price effective *on the invoice issue date*, which
 * defaults to now. A 2027-dated price would be invisible to an invoice raised
 * today and the line would still be refused — which is exactly the confusion this
 * script exists to remove.
 */
const EFFECTIVE_FROM_MS = Date.UTC(2026, 0, 1);

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const db = createD1({ local: !flags.has('--remote') });

/** A round placeholder cost per acre, varied by program so the rows differ. */
function placeholderCostPerAcre(program) {
  const base = program.crop === 'corn' ? 4500 : 3800;
  const secondPass = /2 PASS/.test(program.name) ? 1200 : 0;
  const preEmergent = /PRE/.test(program.name) ? 400 : 0;
  return base + secondPass + preEmergent;
}

/** A round placeholder cost per stock unit, varied by position. */
function placeholderUnitCost(index) {
  return 2000 + index * 150;
}

function clear() {
  console.log(`Removing placeholder prices from the ${db.where} database…`);

  db.execute(
    [
      `DELETE FROM program_prices WHERE source_sheet = ${sqlText(MARKER)};`,
      // Null the product columns only for products this script priced, then drop
      // the marker rows. Keying off the marker rather than clearing everything
      // means a real price entered since would survive.
      `UPDATE products SET
         default_cost_cents = NULL,
         financed_app_price_cents = NULL,
         cash_app_price_cents = NULL,
         carry_price_cents = NULL,
         updated_at = unixepoch() * 1000
       WHERE id IN (SELECT product_id FROM product_costs WHERE notes = ${sqlText(MARKER)});`,
      `DELETE FROM product_costs WHERE notes = ${sqlText(MARKER)};`,
    ].join('\n'),
  );

  console.log('Done. Program prices removed and product price columns cleared.');
}

function seed() {
  const programs = db.query(
    'SELECT id, name, crop FROM application_programs WHERE is_active = 1 ORDER BY name',
  );
  const tiers = db.query(
    'SELECT id, key, label, multiplier FROM price_tiers WHERE is_active = 1 ORDER BY sort_order',
  );
  const products = db.query(
    'SELECT id, sku, name FROM products WHERE is_active = 1 ORDER BY sku',
  );

  if (programs.length === 0 || tiers.length === 0) {
    throw new Error('No active programs or price tiers — run the reference seed first.');
  }

  console.log(`Seeding placeholder prices into the ${db.where} database:`);
  console.log(`  ${programs.length} programs x ${tiers.length} tiers`);
  console.log(`  ${products.length} products`);

  const statements = [];

  /* ── Program prices: one row per program and tier ─────────────────────────── */
  for (const program of programs) {
    const costPerAcre = placeholderCostPerAcre(program);

    for (const tier of tiers) {
      const pricePerAcre = Math.round(costPerAcre * tier.multiplier);

      // INSERT OR IGNORE rides the unique index on (program, tier, effective_from),
      // so re-running this is safe and never doubles a price up.
      statements.push(
        `INSERT OR IGNORE INTO program_prices
           (id, program_id, tier_id, price_per_acre_cents, cost_per_acre_cents,
            multiplier_applied, effective_from, source_sheet, created_at, updated_at)
         VALUES (
           ${sqlText(randomUUID())}, ${sqlText(program.id)}, ${sqlText(tier.id)},
           ${pricePerAcre}, ${costPerAcre}, ${tier.multiplier}, ${EFFECTIVE_FROM_MS},
           ${sqlText(MARKER)}, unixepoch() * 1000, unixepoch() * 1000
         );`,
      );
    }
  }

  /* ── Product prices: cost basis plus the three flat tier prices ───────────── */
  products.forEach((product, index) => {
    const cost = placeholderUnitCost(index);

    // The three columns map to the tiers the way `productFallbackPrice` reads them:
    // financed application, cash application, and both carry tiers.
    const financedApp = Math.round(cost * 1.2);
    const cashApp = Math.round(cost * 1.1);
    const carry = Math.round(cost * 1.05);

    statements.push(
      `UPDATE products SET
         default_cost_cents = ${cost},
         financed_app_price_cents = ${financedApp},
         cash_app_price_cents = ${cashApp},
         carry_price_cents = ${carry},
         updated_at = unixepoch() * 1000
       WHERE id = ${sqlText(product.id)};`,
      // Doubles as the marker that records which products were touched.
      `INSERT INTO product_costs
         (id, product_id, cost_cents, unit, effective_from, notes, created_at, updated_at)
       VALUES (
         ${sqlText(randomUUID())}, ${sqlText(product.id)}, ${cost}, 'unit',
         ${EFFECTIVE_FROM_MS}, ${sqlText(MARKER)}, unixepoch() * 1000, unixepoch() * 1000
       );`,
    );
  });

  db.execute(statements.join('\n'));

  console.log('');
  console.log(`  Programs priced : ${programs.length * tiers.length} rows`);
  console.log(`  Products priced : ${products.length}`);
  console.log('');
  console.log('These are PLACEHOLDERS, not the 2027 sheet.');
  const remote = flags.has('--remote') ? ' --remote' : '';
  console.log(`Remove them with: pnpm prices:test --${remote} --clear`);
}

try {
  if (flags.has('--clear')) clear();
  else seed();
} catch (error) {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
