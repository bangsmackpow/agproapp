/**
 * Text utilities shared by every vendor parser.
 *
 * These are deliberately dependency-free and side-effect-free so the parsers
 * stay pure functions of their input text.
 */

/**
 * Money-ish token: optional sign/parens, optional thousands separators, 2-4
 * decimals.
 *
 * The integer part is `\d+` rather than `\d{1,3}` so that unseparated values
 * such as `1800.00` and `3662.00` are captured whole — with `\d{1,3}` the match
 * would start at the final three digits and report `800.00`.
 */
export const MONEY_PATTERN = /\(?-?\d+(?:,\d{3})*(?:\.\d{2,4})\)?/g;

/** Splits into trimmed, non-empty lines and collapses runs of intra-line spaces. */
export function toLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

export function normalize(text: string): string {
  return toLines(text).join('\n');
}

/** Converts a money token to integer cents, tolerating commas, `$` and parens. */
export function parseMoneyToCents(value: string): number | undefined {
  const negative = value.includes('(') && value.includes(')');
  const cleaned = value.replace(/[(),$\s]/g, '');
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round((negative ? -parsed : parsed) * 100);
}

/** First capturing-group match across a list of patterns, in priority order. */
export function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const captured = match?.[1]?.trim();
    if (captured) return captured;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds `Label   value` on a single line, tolerating `:`, `#`, `.` separators.
 *
 * Labels on these documents are adjacent to their values (`BOL/CMR Number
 * 8358475862`), so the value is taken from the same line and optionally the next.
 *
 * Whitespace classes exclude newlines on purpose: letting the separator span a
 * line break would let `BOL/CMR Number` capture the next line's label text.
 */
export function matchLabel(text: string, label: string, options: { allowNextLine?: boolean } = {}): string | undefined {
  const escaped = escapeRegExp(label).replace(/\\?\s+/g, '[ \\t]*');
  const separator = '[ \\t:#.]*';
  const value = '([A-Za-z0-9][A-Za-z0-9\\-/\\.]{1,30})';

  const sameLine = new RegExp(`${escaped}${separator}${value}`, 'i');
  const found = sameLine.exec(text)?.[1]?.trim();
  if (found) return found;

  if (options.allowNextLine) {
    const nextLine = new RegExp(`${escaped}${separator}\\n[ \\t]*${value}`, 'i');
    const next = nextLine.exec(text)?.[1]?.trim();
    if (next) return next;
  }

  return undefined;
}

/** All money tokens on a line, in order of appearance. */
export function extractMoneyTokens(line: string): string[] {
  return line.match(MONEY_PATTERN) ?? [];
}

/** First `MM/DD/YYYY` or `YYYY-MM-DD` date anywhere in the text. */
export function firstDate(text: string): string | undefined {
  return firstMatch(text, [
    /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/,
  ]);
}

/** EPA registration numbers, e.g. 35915-4-60663 or 83529-53-94278. */
export function findEpaNumber(text: string): string | undefined {
  return firstMatch(text, [
    /EPA\s*#?\s*(\d{2,5}-\d{1,5}(?:-\d{1,5})?)/i,
    /\bEPA\s*(?:Reg(?:istration)?\.?\s*(?:No\.?|#)?)\s*[:#]?\s*(\d{2,5}-\d{1,5}(?:-\d{1,5})?)/i,
  ]);
}

/** "NET 30" / "Net 30 days" → 30 */
export function parseTermsDays(text: string): number | undefined {
  const match = /\b(?:net|terms)\s*[:#]?\s*(?:net\s*)?(\d{1,3})\b/i.exec(text);
  if (!match?.[1]) return undefined;
  const days = Number.parseInt(match[1], 10);
  return Number.isFinite(days) && days >= 0 && days <= 365 ? days : undefined;
}

/** Quantity token such as `55`, `22.5`, `1.000SP`, `43,000`. */
export function parseQuantity(token: string): number | undefined {
  const cleaned = token.replace(/[,\s]/g, '').replace(/[A-Za-z]+$/, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface MoneyToken {
  raw: string;
  cents: number;
  index: number;
}

/** Every money token on a line with its position, which several parsers need. */
export function findMoneyTokens(line: string): MoneyToken[] {
  const tokens: MoneyToken[] = [];
  const pattern = new RegExp(MONEY_PATTERN.source, 'g');

  let match = pattern.exec(line);
  while (match !== null) {
    const cents = parseMoneyToCents(match[0]);
    if (cents !== undefined) {
      tokens.push({ raw: match[0], cents, index: match.index });
    }
    match = pattern.exec(line);
  }

  return tokens;
}

export interface NumberBeforeResult {
  value: number;
  index: number;
}

/**
 * The nearest number preceding an offset, with its position.
 *
 * Vendor rows look like `… Atrazine. 55 14.77 812.35`, where the quantity sits
 * immediately before the unit-price column. Returning the index lets the caller
 * cut the description at the quantity rather than at the first money-like number
 * it happens to find (which may just be a density).
 */
export function numberBefore(line: string, index: number, window = 64): NumberBeforeResult | undefined {
  const slice = line.slice(Math.max(0, index - window), index);
  const pattern = /\d[\d,]*(?:\.\d+)?/g;

  let last: RegExpExecArray | null = null;
  let match = pattern.exec(slice);
  while (match !== null) {
    last = match;
    match = pattern.exec(slice);
  }

  if (!last) return undefined;
  const value = parseQuantity(last[0]);
  if (value === undefined) return undefined;

  return { value, index: Math.max(0, index - window) + last.index };
}

export interface MoneyRow {
  /** Text preceding the quantity/price columns. */
  description: string;
  tokens: MoneyToken[];
  /** Last money token — the extended amount in every vendor layout observed. */
  amountCents?: number;
  /** Second-to-last money token, when present — the unit price. */
  unitCostCents?: number;
  /** Nearest number before the unit price. */
  quantity?: number;
}

/**
 * Splits a line into a leading description plus its trailing money columns.
 *
 * All four vendor layouts put the extended amount last, so this one heuristic
 * covers Wickman, I&B, Atticus and the Channel BOL item rows.
 *
 * The description ends at the quantity column when one was located, and at the
 * first money token otherwise. Cutting at the *later* of the two would swallow
 * the quantity on rows with no embedded numbers (`Mesotrione 4SC 10 43.24 432.40`).
 */
export function splitMoneyRow(line: string): MoneyRow | undefined {
  const tokens = findMoneyTokens(line);
  if (tokens.length === 0) return undefined;

  const first = tokens[0] as MoneyToken;
  const last = tokens[tokens.length - 1] as MoneyToken;

  let quantity: number | undefined;
  let quantityIndex = -1;

  if (tokens.length >= 2) {
    const unitPrice = tokens[tokens.length - 2] as MoneyToken;
    const found = numberBefore(line, unitPrice.index);
    if (found) {
      quantity = found.value;
      quantityIndex = found.index;
    }
  }

  const cut = quantityIndex >= 0 ? quantityIndex : first.index;

  return {
    description: line.slice(0, cut).trim(),
    tokens,
    amountCents: last.cents,
    ...(tokens.length >= 2 ? { unitCostCents: (tokens[tokens.length - 2] as MoneyToken).cents } : {}),
    ...(quantity === undefined ? {} : { quantity }),
  };
}
