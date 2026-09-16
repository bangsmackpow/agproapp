-- ════════════════════════════════════════════════════════════════════════════
-- AG Pro Solutions — reference / baseline data
-- ════════════════════════════════════════════════════════════════════════════
--
-- Deliberately NOT part of `migrations/` so drizzle-kit's generated migration
-- sequence stays untouched. Apply it explicitly:
--
--   pnpm db:seed:local          # local sqlite (dev)
--   pnpm db:seed:staging        # remote staging D1
--   pnpm db:seed:production     # remote production D1
--
-- Every statement is idempotent (INSERT OR IGNORE on a unique key), so running
-- it twice is safe.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Company identity (singleton row) ────────────────────────────────────────
-- Canonical location confirmed: 1200 E Howard St, Creston, IA 50801.
INSERT OR IGNORE INTO `company_settings` (
  `id`, `legal_name`, `display_name`,
  `address_line1`, `city`, `state`, `postal_code`, `country`,
  `phone`, `email`,
  `default_tax_rate`, `invoice_terms_days`, `default_currency`
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Agpro Solutions', 'AG Pro Solutions',
  '1200 E Howard St', 'Creston', 'IA', '50801', 'US',
  '(641) 745-7392', 'agprosolu@gmail.com',
  0, 30, 'USD'
);

-- ── Pricing tiers ───────────────────────────────────────────────────────────
-- Multipliers verified against the source worksheet arithmetic:
-- on `2027_chemical_prices.xlsx`, Finance App = 1.20 x cost, Cash App = 1.10 x
-- cost and Cash & Carry = 1.05 x cost. Finance & Carry is ~1.24.
-- The original spec described three tiers; both worksheets price four.
INSERT OR IGNORE INTO `price_tiers`
  (`id`, `key`, `label`, `description`, `multiplier`,
   `requires_application`, `requires_pesticide_license`, `sort_order`, `is_active`)
VALUES
  ('10000000-0000-0000-0000-000000000001', 'financed_app', 'Financed Application',
   'Product sold on finance terms; company performs the application. Highest margin.',
   1.20, 1, 0, 10, 1),
  ('10000000-0000-0000-0000-000000000002', 'cash_app', 'Cash Application',
   'Product paid in cash; company performs the application. Standard margin.',
   1.10, 1, 0, 20, 1),
  ('10000000-0000-0000-0000-000000000003', 'cash_carry', 'Cash & Carry (no application)',
   'Direct product sale; customer arranges transport and independent application. Flat margin.',
   1.05, 0, 1, 30, 1),
  ('10000000-0000-0000-0000-000000000004', 'finance_carry', 'Finance & Carry (no application)',
   'Financed direct product sale; no company application service.',
   1.24, 0, 1, 40, 1);

-- ── Application service fees (per acre) ─────────────────────────────────────
-- Source: `2027_chemical_prices.xlsx` / "Fungicide" sheet application-fee table.
-- Effective 2026-01-01T00:00:00Z.
INSERT OR IGNORE INTO `application_fees`
  (`id`, `method`, `label`, `price_per_acre_cents`, `crop`,
   `effective_from`, `is_active`)
VALUES
  ('20000000-0000-0000-0000-000000000001', 'drone', 'Drone Application', 1350, NULL, 1767225600000, 1),
  ('20000000-0000-0000-0000-000000000002', 'ground', 'Ground Application (beans only)', 1150, 'bean', 1767225600000, 1),
  ('20000000-0000-0000-0000-000000000003', 'helicopter', 'Helicopter Application', 1350, NULL, 1767225600000, 1);

-- ── Default warehouse ───────────────────────────────────────────────────────
INSERT OR IGNORE INTO `warehouses`
  (`id`, `code`, `name`, `address_line1`, `city`, `state`, `postal_code`, `is_default`, `is_active`)
VALUES
  ('30000000-0000-0000-0000-000000000001', 'CRESTON', 'Creston Warehouse',
   '1200 E Howard St', 'Creston', 'IA', '50801', 1, 1);

-- ── Invoice numbering sequence ──────────────────────────────────────────────
INSERT OR IGNORE INTO `invoice_sequences`
  (`id`, `scope`, `prefix`, `next_number`)
VALUES
  ('40000000-0000-0000-0000-000000000001', 'default', 'INV', 1001);

-- ── Known vendors ───────────────────────────────────────────────────────────
-- `code` values match the parser registry keys used in Phase 2.
INSERT OR IGNORE INTO `vendors`
  (`id`, `code`, `name`, `address_line1`, `city`, `state`, `postal_code`, `is_active`)
VALUES
  ('50000000-0000-0000-0000-000000000001', 'product_supply_seeds', 'Product Supply Seeds LLC',
   '1401 SE Olson Dr Ste 1055', 'Waukee', 'IA', '50263', 1),
  ('50000000-0000-0000-0000-000000000002', 'atticus', 'Atticus LLC',
   '940 NW Cary Pkwy Suite 200', 'Cary', 'NC', '27513', 1),
  ('50000000-0000-0000-0000-000000000003', 'ib_ag_supply', 'IB Enterprises, LLC dba I & B Ag Supply',
   '3807 20th Avenue', 'Fenton', 'IA', '50539', 1),
  ('50000000-0000-0000-0000-000000000004', 'wickman_chemical', 'Wickman Chemical LLC',
   'P.O. Box 909', 'Oxford', 'KS', '67119', 1);
