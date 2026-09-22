import {
  APPLICATION_TIER_KEYS,
  CARRY_TIER_KEYS,
  PRICE_TIER_KEYS,
  type PriceTierKey,
} from './enums';

/**
 * Pricing engine — one rule.
 *
 * A price is always a cost basis times the selected tier's multiplier, whether
 * the line is a product, a program blend, or (for services) a flat rate. A
 * per-line override is allowed and wins. Nothing else computes money.
 *
 * This replaced the first build's `program_prices` table, which was the thing that
 * made the app unsellable: the source worksheet had no figures, so no program ever
 * had a price row and the composer refused every program line. Computing from
 * ingredient costs means there is no price sheet to load — only costs to keep
 * current.
 *
 * These multipliers seed the `price_tiers` table. Once seeded, the database is the
 * source of truth: read multipliers from the table and treat the constants below
 * as seed data only, so an Admin can change one without a deploy.
 */

/** Seed multipliers, verified against `2027_chemical_prices.xlsx` arithmetic. */
export const DEFAULT_TIER_MULTIPLIERS: Record<PriceTierKey, number> = {
  financed_app: 1.2,
  cash_app: 1.1,
  cash_carry: 1.05,
  finance_carry: 1.24,
};

export const PRICE_TIER_LABELS: Record<PriceTierKey, string> = {
  financed_app: 'Financed Application',
  cash_app: 'Cash Application',
  cash_carry: 'Cash & Carry',
  finance_carry: 'Finance & Carry',
};

export const PRICE_TIER_DESCRIPTIONS: Record<PriceTierKey, string> = {
  financed_app: 'Product on finance terms; company performs the drone application.',
  cash_app: 'Product paid in cash; company performs the drone application.',
  cash_carry: 'Direct sale; customer transports and applies independently.',
  finance_carry: 'Financed direct sale; no company application.',
};

export function isPriceTierKey(value: string): value is PriceTierKey {
  return (PRICE_TIER_KEYS as readonly string[]).includes(value);
}

/** True when the tier includes a company-performed application service. */
export function requiresApplicationService(tier: PriceTierKey): boolean {
  return APPLICATION_TIER_KEYS.includes(tier);
}

/**
 * True when the customer takes the product. Carry sales require the customer's
 * pesticide license number on file at time of sale.
 */
export function requiresPesticideLicense(tier: PriceTierKey): boolean {
  return CARRY_TIER_KEYS.includes(tier);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Money.
 *
 * Convention: every amount is an integer number of USD cents. Never float for
 * settled money. Fractional *rates* (a cost per acre, a multiplier) live as REAL
 * at rest and are rounded to whole cents the moment they become an amount.
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

/** Line total for a quantity-priced line. */
export function lineTotalCents(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents);
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Invoice tax, rounded to whole cents. `taxRate` is a decimal fraction (0.07). */
export function taxCents(taxableCents: number, taxRate: number): number {
  return Math.round(taxableCents * taxRate);
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

/* ────────────────────────────────────────────────────────────────────────────
 * Program (per-acre blend) math.
 *
 * A program is a set of ingredients, each drawn at a rate per acre in the
 * ingredient product's own stock unit. Its cost per acre is the sum of the
 * ingredient costs; its sell price is that cost times the tier multiplier.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ProgramIngredientCost {
  /** The ingredient product's current cost, in cents per its stock unit. */
  unitCostCents: number;
  /** How many of those units are applied per acre. */
  ratePerAcre: number;
}

/** Sum of ingredient costs per acre, rounded to whole cents. */
export function programCostPerAcreCents(
  ingredients: readonly ProgramIngredientCost[],
): number {
  return Math.round(
    ingredients.reduce((total, ingredient) => {
      return total + ingredient.unitCostCents * ingredient.ratePerAcre;
    }, 0),
  );
}

/** The sell price per acre for a program's cost basis at a tier multiplier. */
export function programPricePerAcreCents(costPerAcreCents: number, multiplier: number): number {
  return applyMultiplier(costPerAcreCents, multiplier);
}
