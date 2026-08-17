/**
 * One call, from bytes to endpoints.
 *
 * The only thing above this that has to know about formats is the sniffer, and
 * the only thing below it that knows about layouts is the extractors — so a new
 * format is a reader, and a new layout is an extractor, and neither is both.
 */

import { readDocument, type SourceFormat } from './ingest/index.ts';
import { extractEndpoints } from './extract/index.ts';
import { importStructured } from './extract/structured.ts';
import type { ParseResult } from './types.ts';

export type ParsedDocument = ParseResult & {
  format: SourceFormat;
  fileName: string;
};

export function parseDocument(bytes: Buffer, fileName: string): ParsedDocument {
  const read = readDocument(bytes, fileName);

  if (read.format === 'json') {
    return { ...importStructured(read.data), format: 'json', fileName };
  }

  const result = extractEndpoints(read.model);

  // A PDF that yields nothing has already explained why in its own warnings;
  // anything else that comes back empty gets the generic advice from the
  // extractor. Neither should look like success.
  return { ...result, format: read.format, fileName };
}

export type { ParseResult, SourceFormat };
