import type { DocumentType } from '../../shared/enums';

/**
 * Parser contract.
 *
 * Parsers receive *extracted text*, never the binary. OCR (or a vendor API, or a
 * pasted body) is a separate upstream concern, which keeps the parsers pure,
 * unit-testable, and independent of whichever extraction method is used.
 */

export interface ParsedLineItem {
  lineNumber: number;
  itemCode?: string;
  description: string;
  quantity?: number;
  unit?: string;
  /** Unit price as an integer number of cents. */
  unitCostCents?: number;
  /** Extended amount as an integer number of cents. */
  amountCents?: number;
  epaNumber?: string;
  lotNumber?: string;
  /** 0..1 — how much of this row the parser was confident about. */
  confidence: number;
  raw: string;
}

export interface ParsedHeader {
  documentNumber?: string;
  /** Channel BOL "Order Number" — one of the two Iowa audit tokens. */
  orderNumber?: string;
  /** Channel BOL "BOL/CMR Number" — the other Iowa audit token. */
  bolCmrNumber?: string;
  shipperNumber?: string;
  seedNumber?: string;
  poNumber?: string;
  documentDate?: string;
  dueDate?: string;
  termsDays?: number;
  subtotalCents?: number;
  taxCents?: number;
  totalCents?: number;
}

export interface ParsedDocument {
  parserKey: string;
  vendorCode?: string;
  documentType: DocumentType;
  header: ParsedHeader;
  lineItems: ParsedLineItem[];
  /** Human-readable problems for the reviewer; never blocks parsing. */
  warnings: string[];
  /** 0..1 overall extraction confidence. */
  confidence: number;
}

export interface DocumentParser {
  key: string;
  vendorCode?: string;
  documentType: DocumentType;
  label: string;
  /** Cheap heuristic over the raw text to decide if this parser fits. */
  detect(text: string): boolean;
  parse(text: string): ParsedDocument;
}
