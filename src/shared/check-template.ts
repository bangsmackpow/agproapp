/**
 * Check stock layout.
 *
 * Three-part cheque forms are physical objects: every field's position depends on
 * the printer's non-printable margin, the paper's registration and the tray. The
 * offsets cannot be known from software, so nothing here is hard-coded into the
 * markup — the printable view is driven entirely by these values and an Admin
 * calibrates them by printing one and nudging numbers.
 *
 * All measurements are inches, relative to the top-left of the page.
 */

export interface FieldOffset {
  leftIn: number;
  topIn: number;
  /** Optional clamp so a long payee or memo cannot collide with the next field. */
  widthIn?: number;
  /** Text alignment within the field box. */
  align?: 'left' | 'right' | 'center';
}

export interface CheckTemplateConfig {
  pageWidthIn: number;
  pageHeightIn: number;
  /** The cheque itself, inside the three-part form. */
  checkLeftIn: number;
  checkTopIn: number;
  checkWidthIn: number;
  checkHeightIn: number;
  fontFamily: string;
  fontSizePt: number;

  date: FieldOffset;
  payee: FieldOffset;
  amountNumeric: FieldOffset;
  /** The written amount, e.g. "One thousand two hundred dollars and 56/100". */
  amountWords: FieldOffset;
  memo: FieldOffset;
  /** MICR line. Toggle off for pre-encoded stock. */
  micr: FieldOffset & { show: boolean };
}

export const DEFAULT_CHECK_TEMPLATE: CheckTemplateConfig = {
  pageWidthIn: 8.5,
  pageHeightIn: 11,
  checkLeftIn: 0.25,
  checkTopIn: 0.5,
  checkWidthIn: 8,
  checkHeightIn: 3.5,
  fontFamily: 'Helvetica, Arial, sans-serif',
  fontSizePt: 11,

  date: { leftIn: 6.1, topIn: 0.62, widthIn: 1.7, align: 'right' },
  payee: { leftIn: 0.75, topIn: 1.12, widthIn: 4.7 },
  amountNumeric: { leftIn: 6.1, topIn: 1.12, widthIn: 1.7, align: 'right' },
  amountWords: { leftIn: 0.75, topIn: 1.52, widthIn: 5.9 },
  memo: { leftIn: 0.75, topIn: 2.42, widthIn: 3.6 },
  /**
   * Off by default. A MICR line is only readable by a bank's sorter when it is
   * printed in E-13B font with magnetic toner on encoded stock; printing it
   * otherwise produces a line that looks authoritative and scans as nothing.
   * Most offices leave this off and use pre-encoded cheques.
   */
  micr: { leftIn: 1.5, topIn: 2.95, widthIn: 5.5, show: false },
};

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function field(value: unknown, fallback: FieldOffset): FieldOffset {
  const source = (value ?? {}) as Partial<FieldOffset>;
  return {
    leftIn: num(source.leftIn, fallback.leftIn),
    topIn: num(source.topIn, fallback.topIn),
    widthIn: num(source.widthIn, fallback.widthIn ?? 0) || undefined,
    align: source.align ?? fallback.align,
  };
}

/**
 * Merges a stored (partial, Admin-edited) config over the defaults.
 *
 * Written defensively because this value is edited by hand: a missing or
 * malformed field must fall back to a printable default rather than break the
 * print view or produce a blank cheque.
 */
export function resolveCheckTemplate(stored: unknown): CheckTemplateConfig {
  const source = (stored ?? {}) as Partial<CheckTemplateConfig> & {
    micr?: Partial<CheckTemplateConfig['micr']>;
  };

  return {
    pageWidthIn: num(source.pageWidthIn, DEFAULT_CHECK_TEMPLATE.pageWidthIn),
    pageHeightIn: num(source.pageHeightIn, DEFAULT_CHECK_TEMPLATE.pageHeightIn),
    checkLeftIn: num(source.checkLeftIn, DEFAULT_CHECK_TEMPLATE.checkLeftIn),
    checkTopIn: num(source.checkTopIn, DEFAULT_CHECK_TEMPLATE.checkTopIn),
    checkWidthIn: num(source.checkWidthIn, DEFAULT_CHECK_TEMPLATE.checkWidthIn),
    checkHeightIn: num(source.checkHeightIn, DEFAULT_CHECK_TEMPLATE.checkHeightIn),
    fontFamily: str(source.fontFamily, DEFAULT_CHECK_TEMPLATE.fontFamily),
    fontSizePt: num(source.fontSizePt, DEFAULT_CHECK_TEMPLATE.fontSizePt),

    date: field(source.date, DEFAULT_CHECK_TEMPLATE.date),
    payee: field(source.payee, DEFAULT_CHECK_TEMPLATE.payee),
    amountNumeric: field(source.amountNumeric, DEFAULT_CHECK_TEMPLATE.amountNumeric),
    amountWords: field(source.amountWords, DEFAULT_CHECK_TEMPLATE.amountWords),
    memo: field(source.memo, DEFAULT_CHECK_TEMPLATE.memo),
    micr: {
      ...field(source.micr, DEFAULT_CHECK_TEMPLATE.micr),
      show: source.micr?.show ?? DEFAULT_CHECK_TEMPLATE.micr.show,
    },
  };
}

/**
 * Flattens the template into CSS custom properties.
 *
 * The print view consumes only these variables, so calibrating the layout is a
 * data change — no component edits, and the same code serves every deployment.
 */
export function checkTemplateCssVars(template: CheckTemplateConfig): Record<string, string> {
  const vars: Record<string, string> = {
    '--page-w': `${template.pageWidthIn}in`,
    '--page-h': `${template.pageHeightIn}in`,
    '--check-left': `${template.checkLeftIn}in`,
    '--check-top': `${template.checkTopIn}in`,
    '--check-w': `${template.checkWidthIn}in`,
    '--check-h': `${template.checkHeightIn}in`,
    '--check-font': template.fontFamily,
    '--check-size': `${template.fontSizePt}pt`,
  };

  const fieldVars = (prefix: string, offset: FieldOffset) => {
    vars[`--${prefix}-left`] = `${offset.leftIn}in`;
    vars[`--${prefix}-top`] = `${offset.topIn}in`;
    if (offset.widthIn !== undefined) vars[`--${prefix}-w`] = `${offset.widthIn}in`;
    if (offset.align) vars[`--${prefix}-align`] = offset.align;
  };

  fieldVars('date', template.date);
  fieldVars('payee', template.payee);
  fieldVars('amount', template.amountNumeric);
  fieldVars('words', template.amountWords);
  fieldVars('memo', template.memo);
  fieldVars('micr', template.micr);

  return vars;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Amount in words
 * ──────────────────────────────────────────────────────────────────────────── */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

function underOneThousand(value: number): string {
  const parts: string[] = [];

  if (value >= 100) {
    parts.push(`${ONES[Math.floor(value / 100)]} Hundred`);
    value %= 100;
  }

  if (value >= 20) {
    const tens = TENS[Math.floor(value / 10)] as string;
    const ones = value % 10;
    parts.push(ones ? `${tens}-${ONES[ones]}` : tens);
  } else if (value > 0) {
    parts.push(ONES[value] as string);
  }

  return parts.join(' ');
}

/** Whole dollars in words, e.g. 1234 -> "One Thousand Two Hundred Thirty-Four". */
export function dollarsInWords(amount: number): string {
  const whole = Math.floor(Math.abs(amount));
  if (whole === 0) return 'Zero';

  const groups: number[] = [];
  let remaining = whole;
  while (remaining > 0) {
    groups.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }

  const words: string[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] as number;
    if (group === 0) continue;
    const scale = SCALES[index] ?? '';
    words.push(scale ? `${underOneThousand(group)} ${scale}` : underOneThousand(group));
  }

  return words.join(' ');
}

/**
 * The full written amount as it appears on a cheque:
 * `One Thousand Two Hundred Thirty-Four dollars and 56/100`.
 */
export function amountInWords(cents: number): string {
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;

  const unit = dollars === 1 ? 'dollar' : 'dollars';
  return `${dollarsInWords(dollars)} ${unit} and ${String(remainder).padStart(2, '0')}/100`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * MICR
 * ──────────────────────────────────────────────────────────────────────────── */

/** U+2446 TRANSIT and U+2448 ON-US, the E-13B symbols banks sort on. */
export const MICR_TRANSIT = '\u2446';
export const MICR_ON_US = '\u2448';

/**
 * Builds a MICR line: transit routing, account, then the cheque number.
 *
 * Returns null when either number is missing — a partial MICR line is worse than
 * none, because it encodes wrong information rather than obviously nothing.
 */
export function buildMicrLine(input: {
  routingNumber?: string | null;
  accountNumber?: string | null;
  checkNumber: number;
}): string | null {
  const routing = input.routingNumber?.replace(/\D/g, '');
  const account = input.accountNumber?.replace(/\D/g, '');

  if (!routing || routing.length !== 9 || !account) return null;

  return `${MICR_TRANSIT}${routing}${MICR_TRANSIT} ${account}${MICR_ON_US} ${input.checkNumber}${MICR_ON_US}`;
}
