import {
  APPLICATION_TIER_KEYS,
  CARRY_TIER_KEYS,
  PRICE_TIER_KEYS,
  type PriceTierKey,
} from './enums';

/**
 * Pricing engine.
 *
 * The multi-tiered markups are expressed as multipliers applied to an item's
 * cost basis, which is how the source worksheets actually compute them. On the
 * 2027 sheet, for example, `Finance App = 1.20 × cost`, `Cash App = 1.10 × cost`
 * and `Cash & Carry = 1.05 × cost`.
 *
 * These defaults seed the `price_tiers` table. Once seeded, the database is the
 * source of truth and an Admin may edit multipliers or add tiers without a code
 * change — so always read multipliers from the table in application code and
 * treat the constants below as seed data only.
 */

/** Seed multipliers, verified against `2027_chemical_prices.xlsx`. */
export const DEFAULT_TIER_MULTIPLIERS: Record<PriceTierKey, number> = {
  financed_app: 1.2,
  cash_app: 1.1,
  cash_carry: 1.05,
  finance_carry: 1.24,
};

export const PRICE_TIER_LABELS: Record<PriceTierKey, string> = {
  financed_app: 'Financed Application',
  cash_app: 'Cash Application',
  cash_carry: 'Cash & Carry (no application)',
  finance_carry: 'Finance & Carry (no application)',
};

export const PRICE_TIER_DESCRIPTIONS: Record<PriceTierKey, string> = {
  financed_app: 'Product sold on finance terms; company performs drone application. Highest margin.',
  cash_app: 'Product paid in cash; company performs drone application. Standard margin.',
  cash_carry: 'Direct product sale, customer arranges transport and independent application. Flat margin.',
  finance_carry: 'Financed direct product sale, no company application service.',
};

export function isPriceTierKey(value: string): value is PriceTierKey {
  return (PRICE_TIER_KEYS as readonly string[]).includes(value);
}

/** True when the tier includes a company-performed application service. */
export function requiresApplicationService(tier: PriceTierKey): boolean {
  return APPLICATION_TIER_KEYS.includes(tier);
}

/**
 * True when the tier is a carry sale. Per `docs/README.txt`, carry sales require
 * the customer's pesticide licence number to be on file at time of sale.
 */
export function requiresPesticideLicense(tier: PriceTierKey): boolean {
  return CARRY_TIER_KEYS.includes(tier);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Money helpers.
 *
 * Convention: every monetary amount is stored and passed around as an integer
 * number of USD minor units (cents). Never use floating point for settled money.
 * Per-unit cost/price *rates* may be fractional in the source data and are kept
 * as REAL at rest, but are rounded to cents the moment they become an amount.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Applies a tier multiplier to a cost basis, rounding to whole cents. */
export function applyMultiplier(costCents: number, multiplier: number): number {
  return Math.round(costCents * multiplier);
}

/** Gross margin as a percentage of the selling price. */
export function marginPercent(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return ((priceCents - costCents) / priceCents) * 100;
}

/** Markup as a percentage of cost — the inverse view of the multiplier. */
export function markupPercent(priceCents: number, costCents: number): number {
  if (costCents <= 0) return 0;
  return ((priceCents - costCents) / costCents) * 100;
}

/** Line total for a quantity-priced line (product / fee / misc). */
export function lineTotalCents(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents);
}

/** Line total for an acreage-priced line (application programs). */
export function acreageTotalCents(acres: number, pricePerAcreCents: number): number {
  return Math.round(acres * pricePerAcreCents);
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Invoice tax, rounded to whole cents. `taxRate` is a decimal fraction (0.07). */
export function taxCents(subtotalCents: number, taxRate: number): number {
  return Math.round(subtotalCents * taxRate);
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

/** Formats cents as a USD string, e.g. 2466 -> "$24.66". */
export function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    centsToDollars(cents),
  );
}
