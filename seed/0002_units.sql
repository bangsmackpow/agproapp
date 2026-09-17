-- ════════════════════════════════════════════════════════════════════════════
-- Units of measure
-- ════════════════════════════════════════════════════════════════════════════
--
-- Deliberately NOT in `migrations/`, like the other reference data, so Drizzle's
-- generated migration sequence stays untouched. Apply with:
--
--   pnpm db:seed:local        # or db:seed:remote
--
-- `factor_to_base` expresses the unit in base units of its own dimension:
-- fluid ounces for volume, pounds for mass. Conversion is multiplication within
-- a dimension and is refused across dimensions — ounces to pounds needs to know
-- what the substance is, which is what `products.density` is for.
--
-- Seeded with what the price sheets and vendor invoices actually use. `#` is the
-- sheets' shorthand for pounds, and `ea`/`each` are both kept because the
-- catalogue default is `each` while the sheets write `EA`.
--
-- Idempotent: INSERT OR IGNORE on the primary key.
-- ════════════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO `units` (`code`, `label`, `dimension`, `factor_to_base`, `sort_order`, `is_active`) VALUES
  -- Volume (base: fluid ounce)
  ('fl oz',   'Fluid ounce',   'volume', 1,    10, 1),
  ('oz',      'Ounce (fluid)', 'volume', 1,    20, 1),
  ('pt',      'Pint',          'volume', 16,   30, 1),
  ('qt',      'Quart',         'volume', 32,   40, 1),
  ('gal',     'Gallon',        'volume', 128,  50, 1),

  -- Mass (base: pound)
  ('lb',      'Pound',         'mass',   1,    60, 1),
  ('#',       'Pound (dry)',   'mass',   1,    70, 1),
  ('ton',     'Ton',           'mass',   2000, 80, 1),

  -- Count
  ('ea',      'Each',          'count',  1,    90, 1),
  ('each',    'Each',          'count',  1,    91, 1),
  ('bottle',  'Bottle',        'count',  1,   100, 1),
  ('bag',     'Bag',           'count',  1,   110, 1),
  ('package', 'Package',       'count',  1,   120, 1),

  -- Area
  ('acre',    'Acre',          'area',   1,   130, 1);
