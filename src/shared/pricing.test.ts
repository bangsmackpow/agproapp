import { describe, expect, it } from 'vitest';

import {
  applyMultiplier,
  acreageTotalCents,
  formatUsd,
  lineTotalCents,
  marginPercent,
  markupPercent,
  requiresPesticideLicense,
  sumCents,
  taxCents,
} from './pricing';

describe('tier semantics', () => {
  it('flags carry tiers as requiring a pesticide licence', () => {
    expect(requiresPesticideLicense('cash_carry')).toBe(true);
    expect(requiresPesticideLicense('finance_carry')).toBe(true);
    expect(requiresPesticideLicense('financed_app')).toBe(false);
    expect(requiresPesticideLicense('cash_app')).toBe(false);
  });
});

describe('money arithmetic', () => {
  it('reproduces the 2027 sheet multipliers', () => {
    // Cost 20.55/acre -> Finance App 24.66, Cash App 22.605, Cash & Carry 21.5775.
    expect(applyMultiplier(2055, 1.2)).toBe(2466);
    expect(applyMultiplier(2055, 1.1)).toBe(2261);
  });

  it('rounds multipliers to whole cents', () => {
    expect(applyMultiplier(3463, 1.2)).toBe(4156);
  });

  it('multiplies quantity and acreage without floating point drift', () => {
    expect(lineTotalCents(1800, 3200)).toBe(5_760_000);
    expect(acreageTotalCents(1.5, 2466)).toBe(3699);
    expect(acreageTotalCents(0.1, 1000)).toBe(100);
  });

  it('computes margin on the selling price, not the cost', () => {
    // 20.55 cost sold at 24.66 -> margin 16.67%, markup 20%.
    expect(marginPercent(2466, 2055)).toBeCloseTo(16.67, 1);
    expect(markupPercent(2466, 2055)).toBeCloseTo(20, 5);
  });

  it('guards against division by zero', () => {
    expect(marginPercent(0, 100)).toBe(0);
    expect(markupPercent(100, 0)).toBe(0);
  });

  it('sums and taxes integer cents', () => {
    expect(sumCents([100, 200, 300])).toBe(600);
    expect(taxCents(10_000, 0.07)).toBe(700);
  });

  it('formats cents as USD', () => {
    expect(formatUsd(2466)).toBe('$24.66');
    expect(formatUsd(5_760_000)).toBe('$57,600.00');
  });
});
