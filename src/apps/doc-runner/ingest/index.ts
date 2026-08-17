/**
 * Choosing a reader for whatever was dropped on the page.
 *
 * The extension is a hint, not the answer — documents get renamed, and a file
 * saved as `.doc` from a modern Word is usually a `.docx` underneath. The magic
 * bytes are checked first and win, because being wrong here means a confusing
 * failure several layers down.
 */

import type { DocModel } from './model.ts';
import { readDocx } from './docx.ts';
import { readPdf } from './pdf.ts';
import { readText } from './text.ts';

export type SourceFormat = 'docx' | 'pdf' | 'markdown' | 'text' | 'json';

export type ReadResult = {
  /**
   * Excludes `json` so this and {@link JsonSource} form a discriminated union —
   * a caller that checks `format === 'json'` then has the other branch narrowed
   * to something with a `model` on it.
   */
  format: Exclude<SourceFormat, 'json'>;
  model: DocModel;
};

/** A structured API definition, which skips the document pipeline entirely. */
export type JsonSource = {
  format: 'json';
  /** Parsed contents, handed to the Postman or OpenAPI importer. */
  data: unknown;
};

function sniff(bytes: Buffer, fileName: string): SourceFormat {
  // PK\x03\x04 — a zip, which for our purposes means an Office document.
  if (bytes.length > 4 && bytes.readUInt32BE(0) === 0x504b0304) return 'docx';
  if (bytes.length > 4 && bytes.toString('latin1', 0, 5) === '%PDF-') return 'pdf';

  const head = bytes.toString('utf8', 0, 512).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';

  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return 'text';
}

export function detectFormat(bytes: Buffer, fileName: string): SourceFormat {
  return sniff(bytes, fileName);
}

/**
 * Reads a file into the block model, or reports it as structured JSON.
 *
 * JSON is returned rather than read because a Postman collection or an OpenAPI
 * document already *is* the answer — flattening it into paragraphs so the
 * extractors could guess at it again would lose everything it states outright.
 */
export function readDocument(
  bytes: Buffer,
  fileName: string,
): ReadResult | JsonSource {
  const format = sniff(bytes, fileName);

  switch (format) {
    case 'docx':
      return { format, model: readDocx(bytes) };
    case 'pdf':
      return { format, model: readPdf(bytes) };
    case 'json': {
      try {
        return { format: 'json', data: JSON.parse(bytes.toString('utf8')) };
      } catch (err) {
        throw new Error(
          `That file starts like JSON but could not be parsed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    default:
      return { format, model: readText(bytes.toString('utf8')) };
  }
}

export { readDocx, readPdf, readText };
export type { DocModel };
