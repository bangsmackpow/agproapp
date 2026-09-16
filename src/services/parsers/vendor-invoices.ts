import {
  VENDOR_CODE_ATTICUS,
  VENDOR_CODE_IB_AG,
  VENDOR_CODE_WICKMAN,
} from '../../shared/enums';
import {
  findEpaNumber,
  firstDate,
  matchLabel,
  normalize,
  parseTermsDays,
  splitMoneyRow,
  toLines,
} from './text';
import type { DocumentParser, ParsedDocument, ParsedLineItem } from './types';

/**
 * The three chemical/adjuvant vendors.
 *
 * Their invoices differ in layout but share one property: the extended amount is
 * the last money token on the row. A single heuristic therefore recovers the
 * description, unit price, quantity and amount for all three, with the labeled
 * header tokens handled per vendor.
 */

/** Lines that look like money rows but are not line items. */
const NON_ITEM =
  /^(?:total|subtotal|tax|balance|amount\s+due|page|invoice|terms|rate\b|item\b|items\b|ship|billed|bill\s+to|ship\s+to|loading|po\s*#|nk\b|if\s+you|delivery|billing|payment|this\s+sale|commerce|dallas|aba|acc|account|sales\s+rep|tax\s+total|due\s+date|sales\s+order|invoice\s+number|invoice\s+date|payment\s+terms|po\s+reference|package|price\s+each|quantity|description|amount\b|unit)/i;

function extractMoneyRowItems(lines: readonly string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];

  for (const line of lines) {
    if (NON_ITEM.test(line)) continue;

    const row = splitMoneyRow(line);
    if (!row || row.amountCents === undefined) continue;

    // A real line item has a meaningful description, not just stray punctuation.
    const letters = row.description.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) continue;

    items.push({
      lineNumber: items.length + 1,
      description: row.description,
      quantity: row.quantity,
      unitCostCents: row.unitCostCents,
      amountCents: row.amountCents,
      epaNumber: findEpaNumber(line),
      confidence:
        row.unitCostCents !== undefined && row.quantity !== undefined
          ? 0.8
          : row.unitCostCents !== undefined
            ? 0.65
            : 0.5,
      raw: line,
    });
  }

  return items;
}

function moneyLabel(text: string, label: string): number | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ \\t]+');
  // The gap class excludes newlines so a label never reaches the next line.
  const match = new RegExp(`${escaped}[^0-9$\\-\\n]*\\$?[ \\t]*([\\d,]+\\.\\d{2})`, 'i').exec(text);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

function scoreDocument(headerScore: number, items: number): number {
  const itemScore = Math.min(1, items / 3);
  return Math.round((headerScore * 0.5 + itemScore * 0.5) * 100) / 100;
}

/* ── Atticus LLC ───────────────────────────────────────────────────────────── */

export const atticusParser: DocumentParser = {
  key: 'atticus_invoice_v1',
  vendorCode: VENDOR_CODE_ATTICUS,
  documentType: 'vendor_invoice',
  label: 'Atticus LLC invoice',

  detect(text: string): boolean {
    return /\bATTICUS\b/i.test(text) && /\binvoice\b/i.test(text);
  },

  parse(text: string): ParsedDocument {
    const normalized = normalize(text);
    const lines = toLines(text);
    const warnings: string[] = [];

    const documentNumber = matchLabel(normalized, 'Invoice number');
    const documentDate = matchLabel(normalized, 'Invoice date') ?? firstDate(normalized);
    const dueDate = matchLabel(normalized, 'Due date');
    const termsDays = parseTermsDays(normalized);
    const poNumber = matchLabel(normalized, 'P.O reference') ?? matchLabel(normalized, 'PO reference');
    const totalCents = moneyLabel(normalized, 'Invoice total (USD)');

    if (!documentNumber) warnings.push('Invoice number not found');

    const lineItems = extractMoneyRowItems(lines);
    if (lineItems.length === 0) warnings.push('No line items were recognised on this invoice');

    return {
      parserKey: atticusParser.key,
      vendorCode: atticusParser.vendorCode,
      documentType: 'vendor_invoice',
      header: { documentNumber, documentDate, dueDate, termsDays, poNumber, totalCents },
      lineItems,
      warnings,
      confidence: scoreDocument(documentNumber ? 1 : 0.3, lineItems.length),
    };
  },
};

/* ── I & B Ag Supply (IB Enterprises, LLC) ─────────────────────────────────── */

export const ibAgSupplyParser: DocumentParser = {
  key: 'ib_ag_supply_order_v1',
  vendorCode: VENDOR_CODE_IB_AG,
  documentType: 'vendor_invoice',
  label: 'I & B Ag Supply sales order',

  detect(text: string): boolean {
    return (
      /\bI\s*&\s*B\s+AG\s+SUPPLY\b/i.test(text) ||
      /\bIB\s+ENTERPRISES\b/i.test(text) ||
      (/\bAG\s+SUPPLY\b/i.test(text) && /\bSales\s+Order\b/i.test(text))
    );
  },

  parse(text: string): ParsedDocument {
    const normalized = normalize(text);
    const lines = toLines(text);
    const warnings: string[] = [];

    const documentNumber =
      matchLabel(normalized, 'Sales Order') ?? matchLabel(normalized, 'Order') ?? undefined;
    const documentDate = matchLabel(normalized, 'Ship Date') ?? firstDate(normalized);
    const termsDays = parseTermsDays(normalized);
    const totalCents = moneyLabel(normalized, 'Total');
    const subtotalCents = moneyLabel(normalized, 'Subtotal');
    const taxCents = moneyLabel(normalized, 'Tax Total');

    if (!documentNumber) warnings.push('Sales order number not found');

    const lineItems = extractMoneyRowItems(lines);
    if (lineItems.length === 0) warnings.push('No line items were recognised on this order');

    return {
      parserKey: ibAgSupplyParser.key,
      vendorCode: ibAgSupplyParser.vendorCode,
      documentType: 'vendor_invoice',
      header: {
        documentNumber,
        documentDate,
        termsDays,
        totalCents,
        subtotalCents,
        taxCents,
      },
      lineItems,
      warnings,
      confidence: scoreDocument(documentNumber ? 1 : 0.3, lineItems.length),
    };
  },
};

/* ── Wickman Chemical LLC ──────────────────────────────────────────────────── */

export const wickmanParser: DocumentParser = {
  key: 'wickman_invoice_v1',
  vendorCode: VENDOR_CODE_WICKMAN,
  documentType: 'vendor_invoice',
  label: 'Wickman Chemical LLC invoice',

  detect(text: string): boolean {
    return (
      /\bWICKMAN\s+CHEMICAL\b/i.test(text) ||
      /\bBroker\/Generic\s+Products\b/i.test(text) ||
      /\bFOB-Wickman\b/i.test(text)
    );
  },

  parse(text: string): ParsedDocument {
    const normalized = normalize(text);
    const lines = toLines(text);
    const warnings: string[] = [];

    const documentNumber = matchLabel(normalized, 'Invoice #') ?? matchLabel(normalized, 'Invoice No');
    const documentDate = matchLabel(normalized, 'Date') ?? firstDate(normalized);
    const dueDate = matchLabel(normalized, 'DUE');
    const poNumber = matchLabel(normalized, 'PO #');
    const termsDays = parseTermsDays(normalized);

    if (!documentNumber) warnings.push('Invoice number not found');

    const lineItems = extractMoneyRowItems(lines);
    if (lineItems.length === 0) warnings.push('No line items were recognised on this invoice');

    // Wickman item descriptions carry the EPA number and state restrictions.
    const missingEpa = lineItems.filter((item) => !item.epaNumber).length;
    if (missingEpa > 0 && lineItems.length > 0) {
      warnings.push(`${missingEpa} of ${lineItems.length} lines had no EPA number in the description`);
    }

    return {
      parserKey: wickmanParser.key,
      vendorCode: wickmanParser.vendorCode,
      documentType: 'vendor_invoice',
      header: { documentNumber, documentDate, dueDate, poNumber, termsDays },
      lineItems,
      warnings,
      confidence: scoreDocument(documentNumber ? 1 : 0.3, lineItems.length),
    };
  },
};
