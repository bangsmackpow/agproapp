import { describe, expect, it } from 'vitest';

import { calculateInvoiceTotals } from './invoicing';

const line = (cents: number, taxable = true) => ({
  lineSubtotalCents: cents,
  discountCents: 0,
  taxable,
});

describe('calculateInvoiceTotals', () => {
  it('sums lines with no tax or discount', () => {
    const totals = calculateInvoiceTotals([line(10_000), line(2500)], { taxRate: 0 });

    expect(totals.subtotalCents).toBe(12_500);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(12_500);
    expect(totals.balanceCents).toBe(12_500);
  });

  it('applies tax to the taxable subtotal only', () => {
    const totals = calculateInvoiceTotals([line(1000, true), line(1000, false)], { taxRate: 0.07 });

    expect(totals.taxableBaseCents).toBe(1000);
    expect(totals.taxCents).toBe(70);
    expect(totals.totalCents).toBe(2070);
  });

  it('apportions an invoice discount across taxable and non-taxable lines', () => {
    // Half taxable, so half the discount reduces the taxable base — tax must not
    // be under-collected by discounting a non-taxable line.
    const totals = calculateInvoiceTotals([line(1000, true), line(1000, false)], {
      taxRate: 0.1,
      discountCents: 200,
    });

    expect(totals.discountCents).toBe(200);
    expect(totals.taxableBaseCents).toBe(900);
    expect(totals.taxCents).toBe(90);
    expect(totals.totalCents).toBe(1890);
  });

  it('never produces a negative total or balance', () => {
    const totals = calculateInvoiceTotals([line(500)], { taxRate: 0, discountCents: 5000, amountPaidCents: 5000 });

    expect(totals.discountCents).toBe(500);
    expect(totals.totalCents).toBe(0);
    expect(totals.balanceCents).toBe(0);
  });

  it('nets recorded payments into the balance', () => {
    const totals = calculateInvoiceTotals([line(10_000)], { taxRate: 0, amountPaidCents: 4000 });

    expect(totals.totalCents).toBe(10_000);
    expect(totals.balanceCents).toBe(6000);
  });

  it('handles an empty invoice without dividing by zero', () => {
    const totals = calculateInvoiceTotals([], { taxRate: 0.07 });

    expect(totals.subtotalCents).toBe(0);
    expect(totals.taxableBaseCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });

  it('reproduces the tier arithmetic observed on the 2027 price sheet', () => {
    // "CORN (1 PASS)" totals on the real sheet: cost 20.55 -> 1.20x = 24.66.
    const totals = calculateInvoiceTotals([line(2466)], { taxRate: 0 });
    expect(totals.totalCents).toBe(2466);
  });
});
