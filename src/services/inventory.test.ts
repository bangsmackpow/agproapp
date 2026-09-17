import { describe, expect, it } from 'vitest';

import { allocateFifo, poolQuantity, tidyQuantity, weightedAverageCostCents } from './inventory';

const receipt = (lotId: string, remaining: number, unitCostCents: number, occurredAt: number) => ({
  lotId,
  remaining,
  unitCostCents,
  occurredAt,
});

describe('allocateFifo', () => {
  it('draws from the oldest receipt first', () => {
    const receipts = [receipt('newer', 30, 1610, 2), receipt('older', 30, 1477, 1)];

    const allocations = allocateFifo(receipts, 20);

    expect(allocations).toEqual([{ lotId: 'older', quantity: 20, unitCostCents: 1477 }]);
  });

  it('spans receipts when one is not enough', () => {
    // This is the case the pooled model exists to avoid asking about: sell 40 from
    // 30 + 30 and nobody has to choose.
    const receipts = [receipt('older', 30, 1477, 1), receipt('newer', 30, 1610, 2)];

    const allocations = allocateFifo(receipts, 40);

    expect(allocations).toEqual([
      { lotId: 'older', quantity: 30, unitCostCents: 1477 },
      { lotId: 'newer', quantity: 10, unitCostCents: 1610 },
    ]);
  });

  it('skips exhausted receipts', () => {
    const receipts = [receipt('empty', 0, 1477, 1), receipt('stocked', 10, 1610, 2)];
    expect(allocateFifo(receipts, 5)).toEqual([
      { lotId: 'stocked', quantity: 5, unitCostCents: 1610 },
    ]);
  });

  it('reports the shortfall rather than truncating, so the pool can go negative', () => {
    const receipts = [receipt('only', 5, 1477, 1)];

    const allocations = allocateFifo(receipts, 12);

    expect(allocations).toEqual([
      { lotId: 'only', quantity: 5, unitCostCents: 1477 },
      { lotId: null, quantity: 7, unitCostCents: null },
    ]);
  });

  it('allocates entirely to a null lot when nothing is on hand', () => {
    expect(allocateFifo([], 3)).toEqual([{ lotId: null, quantity: 3, unitCostCents: null }]);
  });

  it('returns nothing for a non-positive quantity', () => {
    expect(allocateFifo([receipt('a', 10, 100, 1)], 0)).toEqual([]);
    expect(allocateFifo([receipt('a', 10, 100, 1)], -5)).toEqual([]);
  });

  it('handles fractional quantities without losing a drop', () => {
    const receipts = [receipt('a', 0.5, 1000, 1), receipt('b', 0.75, 1000, 2)];

    const allocations = allocateFifo(receipts, 1.25);

    expect(allocations.reduce((total, a) => total + a.quantity, 0)).toBeCloseTo(1.25, 10);
  });
});

describe('weightedAverageCostCents', () => {
  it('averages across receipts, which is what keeps margin honest', () => {
    // 30 gal at $14.77 plus 10 at $16.10 -> $15.10, not either one.
    const allocations = [
      { lotId: 'older', quantity: 30, unitCostCents: 1477 },
      { lotId: 'newer', quantity: 10, unitCostCents: 1610 },
    ];

    expect(weightedAverageCostCents(allocations)).toBe(1510);
  });

  it('ignores allocations with no known cost', () => {
    const allocations = [
      { lotId: 'a', quantity: 10, unitCostCents: 1000 },
      { lotId: null, quantity: 10, unitCostCents: null },
    ];

    expect(weightedAverageCostCents(allocations)).toBe(1000);
  });

  it('returns null rather than a confident zero when no cost is known', () => {
    expect(weightedAverageCostCents([{ lotId: null, quantity: 5, unitCostCents: null }])).toBeNull();
    expect(weightedAverageCostCents([])).toBeNull();
  });
});

describe('poolQuantity', () => {
  it('sums signed movements', () => {
    expect(
      poolQuantity([{ quantityInBase: 60 }, { quantityInBase: -14 }, { quantityInBase: -2.5 }]),
    ).toBeCloseTo(43.5, 10);
  });

  it('is zero for an empty ledger', () => {
    expect(poolQuantity([])).toBe(0);
  });
});

describe('tidyQuantity', () => {
  it('removes floating point noise so a pool of 60 reads as 60', () => {
    expect(tidyQuantity(59.999999999999)).toBe(60);
    expect(tidyQuantity(0.1 + 0.2)).toBe(0.3);
  });

  it('collapses a vanishing remainder to exactly zero', () => {
    expect(tidyQuantity(1e-12)).toBe(0);
  });
});
