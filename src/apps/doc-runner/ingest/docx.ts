/**
 * Reading a .docx without a dependency.
 *
 * A .docx is a zip holding `word/document.xml`, and the part we need — the order
 * of paragraphs and tables, and the text in each — is a small, stable corner of
 * OOXML. Pulling in a full Word parser to reach it would add a dependency tree
 * to a tool whose whole install story is that it has none.
 *
 * The zip is inflated with node:zlib, and the XML is scanned rather than parsed
 * into a tree: we only ever ask for `w:p`, `w:tbl`, `w:tc`, `w:t` and a couple of
 * attributes, and a DOM of a 200KB document to read five element names would be
 * cost without benefit.
 */

import { inflateRawSync } from 'node:zlib';
import type { Block, DocModel, Paragraph, Table } from './model.ts';
import { normalizeText } from '../normalize.ts';

// --- zip ------------------------------------------------------------------

/**
 * Extracts one file from a zip archive by name.
 *
 * Reads the central directory rather than scanning local headers: a local header
 * may declare sizes of zero and defer them to a data descriptor after the
 * compressed data, which cannot be found without already knowing the length.
 * The central directory always carries the real sizes.
 */
function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  const eocd = findEndOfCentralDirectory(zip);
  if (eocd === -1) return null;

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) return null;

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === wanted) {
      // The local header's own name/extra lengths differ from the central
      // directory's, so they have to be read again here to find the data.
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(start, start + compressedSize);
      // 0 = stored, 8 = deflate. Word only ever emits these two.
      return method === 0 ? data : inflateRawSync(data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is at the very end unless the archive has a comment, so scan
  // backwards over the largest comment the format allows.
  const earliest = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= earliest; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// --- XML ------------------------------------------------------------------

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    // Last, so an escaped `&amp;lt;` does not become `<`.
    .replace(/&amp;/g, '&');
}

/**
 * Splits a body into its top-level `w:p` and `w:tbl` elements, in order.
 *
 * Depth tracking matters because a table's cells contain paragraphs: emitting
 * those as top-level blocks would duplicate every word inside every table.
 */
function topLevelBlocks(body: string): Array<{ tag: 'p' | 'tbl'; xml: string }> {
  const out: Array<{ tag: 'p' | 'tbl'; xml: string }> = [];
  const tagRe = /<w:(p|tbl)(?:\s[^>]*)?>|<\/w:(p|tbl)>/g;
  let depth = 0;
  let start = 0;
  let openTag: 'p' | 'tbl' = 'p';
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(body))) {
    // `[^>]*` inside the open-tag pattern swallows a trailing slash, so a
    // self-closing `<w:p/>` matches the open branch and would leave the depth
    // counter permanently unbalanced. It has to be recognised from the text.
    if (match[0].endsWith('/>')) continue;

    if (match[1]) {
      if (depth === 0) {
        start = match.index;
        openTag = match[1] as 'p' | 'tbl';
      }
      depth++;
    } else if (match[2]) {
      depth--;
      if (depth === 0) {
        out.push({ tag: openTag, xml: body.slice(start, match.index + match[0].length) });
      }
      // A stray close tag would drive this negative and swallow the rest.
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/**
 * The visible text of a paragraph.
 *
 * `w:br` and `w:cr` become newlines rather than spaces: a document that writes a
 * multi-line JSON body inside one paragraph depends on those breaks, and
 * flattening them produces a body that cannot be parsed.
 */
function paragraphText(xml: string): string {
  let out = '';
  const runRe =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:cr\s*\/?>|<w:tab\s*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = runRe.exec(xml))) {
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else if (match[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out;
}

function attr(xml: string, name: string): string {
  const match = new RegExp(`<${name}\\s+w:val="([^"]*)"`).exec(xml);
  return match ? match[1] : '';
}

/** Only the paragraph's own properties, not those of the runs inside it. */
function paragraphProperties(xml: string): string {
  const match = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml);
  return match ? match[1] : '';
}

const HEADING_STYLE = /^heading(\d)$/;

function headingLevelOf(style: string, outlineLevel: string): number {
  const match = HEADING_STYLE.exec(style);
  if (match) return Number(match[1]);
  if (style === 'title') return 1;
  // Documents built without styles still set an outline level for headings.
  if (outlineLevel) return Math.min(6, Number(outlineLevel) + 1);
  return 0;
}

/**
 * True when every run in the paragraph uses a monospaced face.
 *
 * That is how a pasted curl command or a JSON body is usually marked in a Word
 * document, and knowing it lets the extractors treat the paragraph as code
 * rather than prose.
 */
function looksMonospaced(xml: string): boolean {
  const fonts = [...xml.matchAll(/<w:rFonts[^>]*w:ascii="([^"]*)"/g)].map((m) => m[1]);
  if (fonts.length === 0) return false;
  return fonts.every((font) => /mono|courier|consol|menlo|code/i.test(font));
}

function parseTable(xml: string, index: number): Table {
  const rows: string[][] = [];
  const rowRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(xml))) {
    const cells: string[] = [];
    const cellRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const paragraphs: string[] = [];
      const paraRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
      let paraMatch: RegExpExecArray | null;
      while ((paraMatch = paraRe.exec(cellMatch[1]))) {
        paragraphs.push(paragraphText(paraMatch[0]));
      }
      cells.push(normalizeText(paragraphs.join('\n')).trim());
    }
    rows.push(cells);
  }

  return { kind: 'table', index, rows };
}

function documentTitle(zip: Buffer): string | null {
  const core = readZipEntry(zip, 'docProps/core.xml');
  if (!core) return null;
  const match = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core.toString('utf8'));
  const title = match ? normalizeText(decodeEntities(match[1])).trim() : '';
  return title.length > 0 ? title : null;
}

export function readDocx(bytes: Buffer): DocModel {
  const warnings: string[] = [];
  const documentXml = readZipEntry(bytes, 'word/document.xml');
  if (!documentXml) {
    throw new Error(
      'This does not look like a Word document — word/document.xml is missing. ' +
        'If it is an older .doc file, re-save it as .docx first.',
    );
  }

  const xml = documentXml.toString('utf8');
  const bodyStart = xml.indexOf('<w:body>');
  const bodyEnd = xml.lastIndexOf('</w:body>');
  const body = bodyStart === -1 ? xml : xml.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);

  const blocks: Block[] = [];
  for (const raw of topLevelBlocks(body)) {
    const index = blocks.length;
    if (raw.tag === 'tbl') {
      blocks.push(parseTable(raw.xml, index));
      continue;
    }

    const text = normalizeText(paragraphText(raw.xml));
    // Empty paragraphs are spacing, and keeping them would put a gap between
    // lines the extractors need to read as one run.
    if (text.trim().length === 0) continue;

    const properties = paragraphProperties(raw.xml);
    const style = attr(properties, 'w:pStyle').toLowerCase();
    const paragraph: Paragraph = {
      kind: 'paragraph',
      index,
      text,
      style,
      headingLevel: headingLevelOf(style, attr(properties, 'w:outlineLvl')),
      code: looksMonospaced(raw.xml),
    };
    blocks.push(paragraph);
  }

  if (blocks.length === 0) {
    warnings.push('No text was found in this document.');
  }

  return { blocks, title: documentTitle(bytes), warnings };
}
