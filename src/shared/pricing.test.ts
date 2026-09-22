import { describe, expect, it } from 'vitest';

import {
  applyMultiplier,
  lineTotalCents,
  marginPercent,
  programCostPerAcreCents,
  programPricePerAcreCents,
  requiresPesticideLicense,
  sumCents,
  taxCents,
} from './pricing';

/**
 * The one pricing rule: a price is a cost basis times the tier multiplier, and an
 * amount is always a whole number of cents.
 *
 * These are pure, so they are exhaustively testable without a database — which
 * matters more than it sounds, because in v2 a wrong rounding here silently
 * misprices every program line.
 */

describe('applyMultiplier', () => {
  it('rounds to whole cents rather than carrying fractions forward', () => {
    // 3100 x 1.1 = 3410 exactly.
    expect(applyMultiplier(3100, 1.1)).toBe(3410);
    // 347 x 1.05 = 364.35 -> 364.
    expect(applyMultiplier(347, 1.05)).toBe(364);
  });

  it('never returns a fractional cent', () => {
    for (const cost of [1, 7, 99, 101, 4999]) {
      for (const multiplier of [1.05, 1.1, 1.2, 1.24]) {
        expect(Number.isInteger(applyMultiplier(cost, multiplier))).toBe(true);
      }
    }
  });
});

describe('program cost and price per acre', () => {
  const blend = [
    { unitCostCents: 4200, ratePerAcre: 0.25 }, // gal/acre of a $42/gal chemical
    { unitCostCents: 1900, ratePerAcre: 0.5 },
  ];

  it('sums ingredient costs per acre in the products own units', () => {
    // 1050 + 950 = 2000.
    expect(programCostPerAcreCents(blend)).toBe(2000);
  });

  it('rounds once, at the total, not per ingredient', () => {
    // 33 x 0.33 = 10.89 and 47 x 0.1 = 4.7 -> 15.59 -> 16.
    // Rounding each first would give 11 + 5 = 16 here, and differs elsewhere.
    const awkward = [
      { unitCostCents: 33, ratePerAcre: 0.33 },
      { unitCostCents: 47, ratePerAcre: 0.1 },
    ];
    expect(programCostPerAcreCents(awkward)).toBe(16);
  });

  it('is zero for an empty blend rather than undefined', () => {
    expect(programCostPerAcreCents([])).toBe(0);
  });

  it('prices the blended cost through the same multiplier rule', () => {
    expect(programPricePerAcreCents(2000, 1.1)).toBe(2200);
  });
});

describe('line totals', () => {
  it('rounds a fractional quantity times a unit price to whole cents', () => {
    // 160.5 acres x 2200 = 353100.
    expect(lineTotalCents(160.5, 2200)).toBe(353100);
    // 3 x 33.3 -> 100 (99.9 rounds up).
    expect(lineTotalCents(3, 33.3)).toBe(100);
  });
});

describe('tax', () => {
  it('returns zero for an exempt invoice', () => {
    expect(taxCents(50000, 0)).toBe(0);
  });

  it('rounds tax to whole cents', () => {
    // 1000 x 0.06 = 60; 1005 x 0.055 = 55.275 -> 55.
    expect(taxCents(1000, 0.06)).toBe(60);
    expect(taxCents(1005, 0.055)).toBe(55);
  });
});

describe('tier semantics', () => {
  it('requires a pesticide license on carry tiers only', () => {
    expect(requiresPesticideLicense('cash_carry')).toBe(true);
    expect(requiresPesticideLicense('finance_carry')).toBe(true);
    expect(requiresPesticideLicense('cash_app')).toBe(false);
    expect(requiresPesticideLicense('financed_app')).toBe(false);
  });
});

describe('margin reporting', () => {
  it('computes gross margin against the selling price', () => {
    // Sell 110 against 100 of cost = 9.09% margin.
    expect(marginPercent(110, 100)).toBeCloseTo(9.09, 2);
  });

  it('is zero, not infinite, when the price is zero', () => {
    expect(marginPercent(0, 100)).toBe(0);
  });
});

describe('sumCents', () => {
  it('adds exact integer cents', () => {
    expect(sumCents([1, 2, 3])).toBe(6);
    expect(sumCents([])).toBe(0);
  });
});
