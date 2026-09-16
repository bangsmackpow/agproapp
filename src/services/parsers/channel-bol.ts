import { VENDOR_CODE_PRODUCT_SUPPLY } from '../../shared/enums';
import {
  firstDate,
  firstMatch,
  matchLabel,
  normalize,
  parseQuantity,
  splitMoneyRow,
  toLines,
} from './text';
import type { DocumentParser, ParsedDocument, ParsedLineItem } from './types';

/**
 * Channel / Product Supply Seeds "Straight Bill of Lading".
 *
 * The State of Iowa audit requires two tokens from this document, both of which
 * appear as explicit labels in the header block:
 *
 *     BOL/CMR Number  8358475862
 *     Order Number    618150791
 *
 * Shipper number, Seed NO. and the customer PO are captured too, because a
 * shipment cannot otherwise be reconciled back to a customer's purchase history.
 */

// Whitespace classes exclude newlines: a label must not capture the next line's
// text when its own value is absent.
const BOL_CMR_PATTERNS = [
  /\bBOL\s*\/\s*CMR\s*(?:Number|No\.?)[ \t]*[:#]?[ \t]*([A-Za-z0-9-]{4,})/i,
  /\bBOL\s*(?:Number|No\.?)[ \t]*[:#]?[ \t]*([A-Za-z0-9-]{4,})/i,
];

const ORDER_NUMBER_PATTERNS = [
  /\bOrder\s*(?:Number|No\.?)[ \t]*[:#]?[ \t]*([A-Za-z0-9-]{4,})/i,
];

/** `1 83169339 C.CL-204-…` — line number, material code, then the description. */
const ITEM_ROW = /^(\d{1,3})\s+(\d{6,14})\s+(.+)$/;

/** `1.000SP`, `24,000 BAG`, `43,000 BAG` */
const QUANTITY_TOKEN = /([\d,]+(?:\.\d{1,3})?)\s*(SP|BAGS?|LB|LBS|BU|CWT|SEED)\b/i;

/** Optional lot column; this document prints slashes when no lot is assigned. */
const LOT_CANDIDATE = /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{2,}){1,})\b/;

function parseLineItems(lines: readonly string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];

  for (const line of lines) {
    const match = ITEM_ROW.exec(line);
    if (!match) continue;

    const lineNumber = Number.parseInt(match[1] as string, 10);
    const itemCode = match[2] as string;
    const rest = match[3] as string;

    // The goods description ends where the padding run or the first quantity
    // column begins. Unassigned lot columns print as a run of slashes.
    const paddingIndex = rest.search(/[/\\*]{5,}/);
    const quantityIndex = rest.search(/\b[\d,]+(?:\.\d{1,3})?\s*(?:SP|BAGS?|LB|LBS|BU|CWT|SEED)\b/i);
    const cutCandidates = [paddingIndex, quantityIndex].filter((index) => index > 0);
    const cut = cutCandidates.length > 0 ? Math.min(...cutCandidates) : -1;
    const description = (cut > 0 ? rest.slice(0, cut) : rest).trim();

    const quantityMatch = QUANTITY_TOKEN.exec(rest);
    const quantity = quantityMatch?.[1] ? parseQuantity(quantityMatch[1]) : undefined;
    const unit = quantityMatch?.[2]?.toUpperCase();

    const row = splitMoneyRow(line);
    const lotMatch = LOT_CANDIDATE.exec(description);

    items.push({
      lineNumber: Number.isNaN(lineNumber) ? items.length + 1 : lineNumber,
      itemCode,
      description,
      quantity,
      unit,
      unitCostCents: row?.unitCostCents,
      amountCents: row?.amountCents,
      lotNumber: lotMatch?.[1],
      confidence: quantity !== undefined ? 0.8 : 0.55,
      raw: line,
    });
  }

  return items;
}

export const channelBolParser: DocumentParser = {
  key: 'channel_bol_v1',
  vendorCode: VENDOR_CODE_PRODUCT_SUPPLY,
  documentType: 'bol_seed',
  label: 'Channel / Product Supply Seeds straight bill of lading',

  detect(text: string): boolean {
    return (
      /\bSTRAIGHT\s+BILL\s+OF\s+LADING\b/i.test(text) ||
      /\bBOL\s*\/\s*CMR\b/i.test(text) ||
      (/\bPRODUCT\s+SUPPLY\s+SEEDS\b/i.test(text) && /\bLADING\b/i.test(text))
    );
  },

  parse(text: string): ParsedDocument {
    const normalized = normalize(text);
    const lines = toLines(text);
    const warnings: string[] = [];

    const bolCmrNumber = firstMatch(normalized, BOL_CMR_PATTERNS);
    const orderNumber =
      firstMatch(normalized, ORDER_NUMBER_PATTERNS) ??
      matchLabel(normalized, 'Customer Purchase Order');

    const shipperNumber =
      matchLabel(normalized, "Shipper's No") ?? matchLabel(normalized, 'Shippers No');
    const seedNumber = matchLabel(normalized, 'Seed NO') ?? matchLabel(normalized, 'Seed No');
    const poNumber =
      matchLabel(normalized, 'Customer Purchase Order') ?? matchLabel(normalized, 'Customer P.O. #');
    const documentDate = matchLabel(normalized, 'Invoice Date') ?? firstDate(normalized);

    if (!bolCmrNumber) {
      warnings.push('BOL/CMR Number not found — Iowa audit token is missing');
    }
    if (!orderNumber) {
      warnings.push('Order Number not found — Iowa audit token is missing');
    }

    const lineItems = parseLineItems(lines);
    if (lineItems.length === 0) warnings.push('No line items were recognised on this BOL');

    const headerScore = [bolCmrNumber, orderNumber].filter(Boolean).length / 2;
    const confidence =
      lineItems.length > 0 ? Math.min(0.95, 0.6 + headerScore * 0.35) : headerScore * 0.6;

    return {
      parserKey: channelBolParser.key,
      vendorCode: channelBolParser.vendorCode,
      documentType: 'bol_seed',
      header: {
        bolCmrNumber,
        orderNumber,
        shipperNumber,
        seedNumber,
        poNumber,
        documentDate,
      },
      lineItems,
      warnings,
      confidence,
    };
  },
};
