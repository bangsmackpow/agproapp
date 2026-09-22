-- ─────────────────────────────────────────────────────────────────────────────
-- AG Pro Solutions — reference data (v2)
--
-- Deliberately NOT in `migrations/`, so drizzle-kit's generated sequence stays
-- untouched. Apply it explicitly:
--
--   pnpm db:seed:local      # local sqlite (dev)
--   pnpm db:seed:remote     # the deployed D1
--
-- Every statement is idempotent (`INSERT OR IGNORE` on a unique key), so running
-- it twice is safe.
--
-- WHAT IS NOT HERE, AND WHY
--
-- The catalog is empty by decision: the 2027 worksheet carried no prices, and the
-- first build spent a phase importing structure that could not yet be sold. Products
-- and programs arrive from a real cost list, entered or imported, not seeded.
--
-- Service rates are also absent. A mileage or per-acre application rate is a real
-- number only the business knows; inventing one here would print a plausible,
-- wrong invoice. Settings says plainly when none exist yet, and the Settings screen
-- is where they get entered.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Company identity (singleton row) ─────────────────────────────────────────
-- The address is a column default in the schema; this row exists to carry the
-- contact details that have no sensible default.
INSERT OR IGNORE INTO `settings` (
  `id`, `legal_name`, `display_name`,
  `address_line1`, `city`, `state`, `postal_code`, `country`,
  `phone`, `email`,
  `default_tax_rate`, `default_terms_days`, `invoice_prefix`
) VALUES (
  'primary',
  'Agpro Solutions', 'AG Pro Solutions',
  '1200 E Howard St', 'Creston', 'IA', '50801', 'US',
  '(641) 745-7392', 'agprosolu@gmail.com',
  0, 30, 'INV'
);

-- ── Pricing tiers ────────────────────────────────────────────────────────────
-- Multipliers verified against the source worksheet arithmetic:
-- Finance App = 1.20 x cost, Cash App = 1.10 x, Cash & Carry = 1.05 x.
-- Finance & Carry is ~1.24. The spec described three tiers; both worksheets price
-- four, so four it is. Once seeded, this table is the source of truth and an
-- Admin edits multipliers in Settings without a deploy.
INSERT OR IGNORE INTO `price_tiers`
  (`id`, `key`, `label`, `description`, `multiplier`,
   `requires_application`, `requires_pesticide_license`, `sort_order`, `is_active`)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'financed_app', 'Financed Application',
   'Product on finance terms; company performs the drone application.',
   1.20, 1, 0, 1, 1),
  ('10000000-0000-4000-8000-000000000002', 'cash_app', 'Cash Application',
   'Product paid in cash; company performs the drone application.',
   1.10, 1, 0, 2, 1),
  ('10000000-0000-4000-8000-000000000003', 'cash_carry', 'Cash & Carry',
   'Direct sale; customer transports and applies independently.',
   1.05, 0, 1, 3, 1),
  ('10000000-0000-4000-8000-000000000004', 'finance_carry', 'Finance & Carry',
   'Financed direct sale; no company application.',
   1.24, 0, 1, 4, 1);

-- ── Allocated numbering ──────────────────────────────────────────────────────
-- Both counters also self-create on first use (see src/services/numbering.ts), so
-- a database that has been migrated but never seeded can still issue its first
-- invoice. Seeding them here is what pins the starting values.
--
-- Customer numbers restart at AGP-001 rather than continuing the old service's
-- AGP-057: the v1 account numbers are not carried across, and resuming the old
-- counter would silently skip a run of numbers nobody can explain later.
INSERT OR IGNORE INTO `counters` (`scope`, `prefix`, `next_number`, `updated_at`)
VALUES
  ('invoice', 'INV', 1001, (unixepoch() * 1000)),
  ('customer', 'AGP', 1, (unixepoch() * 1000));
