import { describe, expect, it } from 'vitest';

import {
  amountInWords,
  buildMicrLine,
  checkTemplateCssVars,
  DEFAULT_CHECK_TEMPLATE,
  dollarsInWords,
  resolveCheckTemplate,
} from './check-template';

describe('resolveCheckTemplate', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(resolveCheckTemplate(null)).toEqual(DEFAULT_CHECK_TEMPLATE);
    expect(resolveCheckTemplate(undefined)).toEqual(DEFAULT_CHECK_TEMPLATE);
  });

  it('overrides only the fields that were supplied', () => {
    const resolved = resolveCheckTemplate({ checkTopIn: 0.75, micr: { show: true } });

    expect(resolved.checkTopIn).toBe(0.75);
    expect(resolved.micr.show).toBe(true);
    // Untouched values stay at their defaults.
    expect(resolved.checkLeftIn).toBe(DEFAULT_CHECK_TEMPLATE.checkLeftIn);
    expect(resolved.micr.leftIn).toBe(DEFAULT_CHECK_TEMPLATE.micr.leftIn);
  });

  it('falls back rather than producing a blank cheque when the config is rubbish', () => {
    // This value is typed in by hand, so it must survive nonsense.
    const resolved = resolveCheckTemplate({
      checkTopIn: 'nonsense',
      fontSizePt: null,
      date: { leftIn: Number.NaN, topIn: 1.25 },
      micr: 'not-an-object',
    });

    expect(resolved.checkTopIn).toBe(DEFAULT_CHECK_TEMPLATE.checkTopIn);
    expect(resolved.fontSizePt).toBe(DEFAULT_CHECK_TEMPLATE.fontSizePt);
    expect(resolved.date.leftIn).toBe(DEFAULT_CHECK_TEMPLATE.date.leftIn);
    expect(resolved.date.topIn).toBe(1.25);
    expect(resolved.micr.leftIn).toBe(DEFAULT_CHECK_TEMPLATE.micr.leftIn);
  });

  it('keeps MICR off unless it is explicitly enabled', () => {
    expect(DEFAULT_CHECK_TEMPLATE.micr.show).toBe(false);
    expect(resolveCheckTemplate({}).micr.show).toBe(false);
  });

  it('drops a width of zero instead of collapsing the field', () => {
    expect(resolveCheckTemplate({ payee: { widthIn: 0 } }).payee.widthIn).toBeUndefined();
  });
});

describe('checkTemplateCssVars', () => {
  it('exposes every coordinate as a CSS custom property', () => {
    const vars = checkTemplateCssVars(resolveCheckTemplate({ checkTopIn: 1.5 }));

    expect(vars['--check-top']).toBe('1.5in');
    expect(vars['--check-left']).toBe(`${DEFAULT_CHECK_TEMPLATE.checkLeftIn}in`);
    expect(vars['--payee-left']).toBe(`${DEFAULT_CHECK_TEMPLATE.payee.leftIn}in`);
    expect(vars['--words-top']).toBe(`${DEFAULT_CHECK_TEMPLATE.amountWords.topIn}in`);
    expect(vars['--micr-top']).toBe(`${DEFAULT_CHECK_TEMPLATE.micr.topIn}in`);
    expect(vars['--date-align']).toBe('right');
  });

  it('suffixes lengths in inches', () => {
    const vars = checkTemplateCssVars(resolveCheckTemplate({}));
    for (const [key, value] of Object.entries(vars)) {
      if (key.endsWith('-w') || key.endsWith('-left') || key.endsWith('-top') || key.startsWith('--page')) {
        expect(value.endsWith('in')).toBe(true);
      }
    }
  });
});

describe('dollarsInWords', () => {
  it('handles the boundaries', () => {
    expect(dollarsInWords(0)).toBe('Zero');
    expect(dollarsInWords(1)).toBe('One');
    expect(dollarsInWords(19)).toBe('Nineteen');
    expect(dollarsInWords(20)).toBe('Twenty');
    expect(dollarsInWords(21)).toBe('Twenty-One');
    expect(dollarsInWords(100)).toBe('One Hundred');
    expect(dollarsInWords(999)).toBe('Nine Hundred Ninety-Nine');
  });

  it('scales through the groups', () => {
    expect(dollarsInWords(1000)).toBe('One Thousand');
    expect(dollarsInWords(1234)).toBe('One Thousand Two Hundred Thirty-Four');
    expect(dollarsInWords(1_000_000)).toBe('One Million');
    expect(dollarsInWords(1_234_567)).toBe(
      'One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven',
    );
    expect(dollarsInWords(1_000_000_000)).toBe('One Billion');
  });

  it('skips empty groups rather than saying "zero hundred"', () => {
    expect(dollarsInWords(1_000_001)).toBe('One Million One');
    expect(dollarsInWords(100_000)).toBe('One Hundred Thousand');
  });
});

describe('amountInWords', () => {
  it('renders the cents as a fraction', () => {
    expect(amountInWords(123_456)).toBe(
      'One Thousand Two Hundred Thirty-Four dollars and 56/100',
    );
    expect(amountInWords(100)).toBe('One dollar and 00/100');
    expect(amountInWords(0)).toBe('Zero dollars and 00/100');
  });

  it('pads single-digit cents', () => {
    expect(amountInWords(105)).toBe('One dollar and 05/100');
  });

  it('renders the values actually seen on real cheques', () => {
    expect(amountInWords(97_055)).toBe('Nine Hundred Seventy dollars and 55/100');
    expect(amountInWords(812_35)).toBe('Eight Hundred Twelve dollars and 35/100');
  });
});

describe('buildMicrLine', () => {
  const good = {
    routingNumber: '073000228',
    accountNumber: '000123456789',
    checkNumber: 1001,
  };

  it('composes a line when both numbers are present', () => {
    const line = buildMicrLine(good);

    expect(line).toContain('073000228');
    expect(line).toContain('000123456789');
    expect(line).toContain('1001');
  });

  it('refuses to emit a partial line', () => {
    // A wrong MICR line encodes bad information; an absent one is obviously absent.
    expect(buildMicrLine({ ...good, routingNumber: null })).toBeNull();
    expect(buildMicrLine({ ...good, accountNumber: null })).toBeNull();
    expect(buildMicrLine({ ...good, routingNumber: '12345' })).toBeNull();
  });

  it('strips formatting characters from the account number', () => {
    const line = buildMicrLine({ ...good, accountNumber: '000-1234-56789' });
    expect(line).toContain('000123456789');
  });
});
