import { unprocessable } from '../../api/lib/http';
import { channelBolParser } from './channel-bol';
import type { DocumentParser, ParsedDocument } from './types';
import { atticusParser, ibAgSupplyParser, wickmanParser } from './vendor-invoices';

/**
 * Parser registry.
 *
 * Order matters: the first parser whose `detect` returns true wins, so the most
 * specific signatures are listed before the looser ones.
 */
export const PARSERS: readonly DocumentParser[] = [
  channelBolParser,
  wickmanParser,
  atticusParser,
  ibAgSupplyParser,
];

export function listParsers(): { key: string; label: string; documentType: string }[] {
  return PARSERS.map((parser) => ({
    key: parser.key,
    label: parser.label,
    documentType: parser.documentType,
  }));
}

export function getParser(key: string): DocumentParser | undefined {
  return PARSERS.find((parser) => parser.key === key);
}

/**
 * Selects a parser for the given text, or the explicitly forced one.
 *
 * Detection is deterministic and content-based: the extracted text is scanned
 * for each vendor's signature rather than trusting a filename or a user choice.
 */
export function detectParser(text: string, forcedKey?: string): DocumentParser | undefined {
  if (forcedKey) {
    const forced = getParser(forcedKey);
    if (!forced) throw unprocessable(`Unknown parser "${forcedKey}"`);
    return forced;
  }

  return PARSERS.find((parser) => parser.detect(text));
}

/**
 * Parses a document into a reviewable draft.
 *
 * Throws a 422 when no parser recognises the document — a document the system
 * cannot interpret must never be silently imported.
 */
export function parseDocument(text: string, options: { parserKey?: string } = {}): ParsedDocument {
  const parser = detectParser(text, options.parserKey);

  if (!parser) {
    throw unprocessable(
      'No parser recognised this document. Supply parserKey explicitly or review the layout.',
      { availableParsers: listParsers().map((entry) => entry.key) },
    );
  }

  return parser.parse(text);
}
