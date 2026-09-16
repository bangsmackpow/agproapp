import { describe, expect, it } from 'vitest';

import {
  matchProduct,
  normalizeName,
  parseCsv,
  parseCsvLine,
  parsePriceCents,
  parseProgramSheet,
  parseRate,
  similarity,
  skuFor,
} from './price-sheet.mjs';

// NOTE: these tests run inside workerd, which has no real filesystem, so they
// deliberately cover only pure parsing. Real-sheet validation lives in
// `scripts/import-prices.mjs --dry-run`, which runs in plain Node.
const PRICE_COLUMNS = ['Finance App', 'Cash App', 'Cash & Carry', 'Finance & Carry'];

const FIXTURE = [
  '"CORN (1 PASS)","RATE PER ACRE","COST PER ACRE","Finance App","Cash App","Cash & Carry","Finance & Carry"',
  '"Ventas","32 oz","","24.66","22.61","21.58","25.49"',
  '"Fulltec ","2 oz","","0","0","0","0"',
  '"","TOTAL","","0","0","0","0"',
  '"CORN PRE (2 PASS)","RATE PER ACRE","COST PER ACRE","Finance App","Cash App","Cash & Carry","Finance & Carry"',
  '"Nano","1 oz","9.28","0","0","0","0"',
  '"","TOTAL","20.55","0","0","0","0"',
].join('\n');

describe('parseCsvLine', () => {
  it('handles quoted values and doubled quotes', () => {
    expect(parseCsvLine('"a","b"')).toEqual(['a', 'b']);
    expect(parseCsvLine('"say ""hi""",x')).toEqual(['say "hi"', 'x']);
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('keeps commas inside quotes', () => {
    expect(parseCsvLine('"1,234.56",x')).toEqual(['1,234.56', 'x']);
  });
});

describe('parseRate', () => {
  it('splits magnitude from unit', () => {
    expect(parseRate('32 oz')).toEqual({ ratePerAcre: 32, rateUnit: 'oz' });
    expect(parseRate('2.50 oz')).toEqual({ ratePerAcre: 2.5, rateUnit: 'oz' });
    expect(parseRate('2 #')).toEqual({ ratePerAcre: 2, rateUnit: 'lb' });
    expect(parseRate('1.000SP')).toEqual({ ratePerAcre: 1, rateUnit: 'bag' });
  });

  it('returns nulls for nothing usable', () => {
    expect(parseRate('')).toEqual({ ratePerAcre: null, rateUnit: null });
    expect(parseRate('oz')).toEqual({ ratePerAcre: null, rateUnit: null });
  });
});

describe('parsePriceCents', () => {
  it('reads dollars as cents', () => {
    expect(parsePriceCents('14.77')).toBe(1477);
    expect(parsePriceCents('1,234.56')).toBe(123_456);
    expect(parsePriceCents('$32.00')).toBe(3200);
  });

  it('treats blank and zero as absent, because a sheet of zeros means unpriced', () => {
    expect(parsePriceCents('')).toBeNull();
    expect(parsePriceCents('   ')).toBeNull();
    expect(parsePriceCents('0')).toBeNull();
    expect(parsePriceCents('0.00')).toBeNull();
    expect(parsePriceCents('nonsense')).toBeNull();
  });
});

describe('parseProgramSheet', () => {
  const parsed = parseProgramSheet(parseCsv(FIXTURE), {
    priceColumns: PRICE_COLUMNS,
    seasonYear: 2027,
  });

  it('finds each program block', () => {
    expect(parsed.programs).toHaveLength(2);
    expect(parsed.programs.map((program) => program.name)).toEqual([
      'CORN (1 PASS)',
      'CORN PRE (2 PASS)',
    ]);
  });

  it('derives crop, stage, pass count and trait system from the name', () => {
    const [first, second] = parsed.programs;
    expect(first).toMatchObject({ crop: 'corn', stage: 'single', passCount: 1 });
    expect(second).toMatchObject({ crop: 'corn', stage: 'pre', passCount: 2 });
  });

  it('attaches ingredients to the right program, with rates', () => {
    const [first] = parsed.programs;
    expect(first.ingredients).toHaveLength(2);
    expect(first.ingredients[0]).toMatchObject({
      name: 'Ventas',
      ratePerAcre: 32,
      rateUnit: 'oz',
    });
    // Product names arrive with stray whitespace; it is trimmed at the cell.
    expect(first.ingredients[1].name).toBe('Fulltec');
  });

  it('captures tier prices in cents and drops zeros', () => {
    const [first] = parsed.programs;
    expect(first.ingredients[0].pricesByTier).toEqual({
      'Finance App': 2466,
      'Cash App': 2261,
      'Cash & Carry': 2158,
      'Finance & Carry': 2549,
    });
    expect(first.ingredients[1].pricesByTier['Finance App']).toBeNull();
  });

  it('reads the total row', () => {
    const [, second] = parsed.programs;
    expect(second.totals?.costPerAcreCents).toBe(2055);
  });

  it('warns rather than silently shifting when headers do not line up', () => {
    const wrong = [
      '"CORN (1 PASS)","RATE PER ACRE","COST PER ACRE","Cash App","Cash App","Cash App","Cash App"',
      '"Ventas","32 oz","","2466","2261","2158","2549"',
      '"","TOTAL","","0","0","0","0"',
    ].join('\n');

    const result = parseProgramSheet(parseCsv(wrong), {
      priceColumns: PRICE_COLUMNS,
      seasonYear: 2027,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('expected');
  });

  it('warns when a program has no TOTAL row', () => {
    const truncated = [
      '"CORN (1 PASS)","RATE PER ACRE","COST PER ACRE","Finance App","Cash App","Cash & Carry","Finance & Carry"',
      '"Ventas","32 oz","","2466","2261","2158","2549"',
    ].join('\n');

    const result = parseProgramSheet(parseCsv(truncated), {
      priceColumns: PRICE_COLUMNS,
      seasonYear: 2027,
    });

    expect(result.warnings.some((warning) => warning.includes('no TOTAL row'))).toBe(true);
  });

  it('captures stray notes that sit outside the price columns', () => {
    const withNote = [
      '"CORN (1 PASS)","RATE PER ACRE","COST PER ACRE","Finance App","Cash App","Cash & Carry","Finance & Carry","","Notes"',
      '"Ventas","32 oz","","2466","2261","2158","2549","","107.00 new price"',
      '"","TOTAL","","0","0","0","0"',
    ].join('\n');

    const result = parseProgramSheet(parseCsv(withNote), {
      priceColumns: PRICE_COLUMNS,
      seasonYear: 2027,
    });

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].value).toBe('107.00 new price');
  });
});

describe('product matching', () => {
  const catalogue = [
    { id: '1', name: 'Ventas' },
    { id: '2', name: 'XSAte 53.8%' },
    { id: '3', name: 'Fulltec' },
    { id: '4', name: 'Tenkoz 4L' },
  ];

  it('normalises punctuation, case and spacing', () => {
    expect(normalizeName('XSAte 53.8%')).toBe(normalizeName('Xsate 53.8%'));
    expect(normalizeName('Fulltec ')).toBe(normalizeName('FullTec'));
  });

  it('matches an exact name after normalisation', () => {
    expect(matchProduct('Xsate 53.8%', catalogue)?.id).toBe('2');
    expect(matchProduct('FULLTEC', catalogue)?.id).toBe('3');
  });

  it('matches a prefix, which is how "Tenkoz 4L" and "Tenkoz" reconcile', () => {
    expect(matchProduct('Tenkoz', catalogue)?.id).toBe('4');
  });

  it('tolerates a small typo', () => {
    expect(matchProduct('Ventas  ', catalogue)?.id).toBe('1');
    expect(similarity('ventas', 'ventaz')).toBeGreaterThan(0.8);
  });

  it('refuses a match rather than guessing wildly', () => {
    expect(matchProduct('Atrazine 4L', catalogue)).toBeNull();
    expect(matchProduct('', catalogue)).toBeNull();
  });

  it('builds a stable SKU', () => {
    expect(skuFor('XSAte 53.8%')).toBe('CHEM-XSATE-53-8');
    expect(skuFor('')).toBe('CHEM-UNKNOWN');
  });
});
