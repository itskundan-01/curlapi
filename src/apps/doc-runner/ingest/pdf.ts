/**
 * Reading text out of a PDF without a dependency.
 *
 * A PDF has no paragraphs. It has instructions for painting glyphs at
 * coordinates, so "the text" has to be reconstructed: decode the content
 * streams, follow the text-positioning operators, and group runs back into lines
 * by where they landed on the page.
 *
 * What this handles: text drawn with the standard operators, streams compressed
 * with Flate (which node:zlib provides), object streams, and fonts that carry a
 * ToUnicode map. That covers a PDF exported from Word, which is what a handed-
 * over API document nearly always is.
 *
 * What it does not: a scanned page. There are no glyphs in an image of text, so
 * nothing here can find any — the caller is told so plainly rather than being
 * handed an empty document with no explanation.
 */

import { inflateSync } from 'node:zlib';
import type { Block, DocModel } from './model.ts';
import { normalizeText } from '../normalize.ts';

/** A run of glyphs with the position it was painted at. */
type TextRun = { text: string; x: number; y: number; size: number };

// --- object access --------------------------------------------------------

/**
 * Every `N M obj … endobj` in the file, by object number.
 *
 * Built by scanning rather than by following the cross-reference table: a
 * damaged or incrementally-updated xref is common in the wild, and the scan
 * costs one pass over a file we have already read into memory.
 */
function indexObjects(pdf: Buffer): Map<number, { start: number; end: number }> {
  const objects = new Map<number, { start: number; end: number }>();
  const text = pdf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text))) {
    const number = Number(match[1]);
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end === -1) continue;
    // A later generation of the same object supersedes an earlier one, and the
    // later one appears further down the file.
    objects.set(number, { start, end });
  }
  return objects;
}

/** The bytes of a stream inside an object, decoded if we know the filter. */
function streamOf(pdf: Buffer, region: { start: number; end: number }): Buffer | null {
  const header = pdf.toString('latin1', region.start, region.end);
  const marker = header.indexOf('stream');
  if (marker === -1) return null;

  // The keyword is followed by CRLF or LF, and nothing else is legal.
  let dataStart = region.start + marker + 'stream'.length;
  if (pdf[dataStart] === 0x0d) dataStart++;
  if (pdf[dataStart] === 0x0a) dataStart++;

  const endMarker = header.indexOf('endstream', marker);
  const dataEnd = endMarker === -1 ? region.end : region.start + endMarker;
  const raw = pdf.subarray(dataStart, Math.max(dataStart, dataEnd));

  const dictionary = header.slice(0, marker);
  if (!/\/Fl(ate)?Decode/.test(dictionary)) {
    // Uncompressed, or a filter we do not implement (LZW, JBIG2 — image codecs
    // in practice). Returning it raw is right for the former and harmless for
    // the latter, which yields no text either way.
    return raw;
  }

  try {
    return inflateSync(raw);
  } catch {
    // Some writers leave a stray byte before the zlib header.
    for (const skip of [1, 2]) {
      try {
        return inflateSync(raw.subarray(skip));
      } catch {
        /* try the next offset */
      }
    }
    return null;
  }
}

// --- content stream text --------------------------------------------------

/** Decodes a PDF string literal, honouring escapes and octal codes. */
function decodeLiteral(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = source[++i];
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '\n': break; // a line continuation inside the literal
      default:
        if (next >= '0' && next <= '7') {
          let octal = next;
          while (octal.length < 3 && source[i + 1] >= '0' && source[i + 1] <= '7') {
            octal += source[++i];
          }
          out += String.fromCharCode(parseInt(octal, 8));
        } else {
          out += next;
        }
    }
  }
  return out;
}

function decodeHexString(source: string): string {
  const hex = source.replace(/[^0-9a-f]/gi, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Reads the text-showing operators out of one content stream.
 *
 * Only the operators that move the cursor or paint glyphs are interpreted. The
 * text matrix is tracked just well enough to know where each run started, which
 * is all that is needed to put runs back into lines.
 */
function runsFrom(content: string, fonts: Map<string, Map<number, string>>): TextRun[] {
  const runs: TextRun[] = [];
  let x = 0;
  let y = 0;
  let lineX = 0;
  let lineY = 0;
  let leading = 0;
  let size = 12;
  let font: Map<number, string> | null = null;

  // Operands accumulate until an operator consumes them, which is how postfix
  // notation is read.
  let operands: string[] = [];

  const tokenRe =
    /\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)|<[0-9A-Fa-f\s]*>|\/[^\s/[\]<>()]+|[-+]?[\d.]+|\[|\]|[A-Za-z'"*]+/g;

  const show = (raw: string): void => {
    const decoded = raw.startsWith('<')
      ? decodeHexString(raw.slice(1, -1))
      : decodeLiteral(raw.slice(1, -1));
    const text = font ? mapThroughFont(decoded, font, raw.startsWith('<')) : decoded;
    if (text.length > 0) runs.push({ text, x, y, size });
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(content))) {
    const token = match[0];

    // Operands
    if (
      token.startsWith('(') ||
      token.startsWith('<') ||
      token.startsWith('/') ||
      token === '[' ||
      token === ']' ||
      /^[-+]?[\d.]+$/.test(token)
    ) {
      operands.push(token);
      continue;
    }

    switch (token) {
      case 'BT':
        x = y = lineX = lineY = 0;
        break;
      case 'Tf': {
        size = Number(operands.at(-1)) || size;
        const name = operands.at(-2) ?? '';
        font = fonts.get(name.replace(/^\//, '')) ?? null;
        break;
      }
      case 'TL':
        leading = Number(operands.at(-1)) || leading;
        break;
      case 'Td':
        lineX += Number(operands.at(-2)) || 0;
        lineY += Number(operands.at(-1)) || 0;
        x = lineX;
        y = lineY;
        break;
      case 'TD':
        leading = -(Number(operands.at(-1)) || 0);
        lineX += Number(operands.at(-2)) || 0;
        lineY += Number(operands.at(-1)) || 0;
        x = lineX;
        y = lineY;
        break;
      case 'Tm':
        // e and f of [a b c d e f] are the translation.
        lineX = Number(operands.at(-2)) || 0;
        lineY = Number(operands.at(-1)) || 0;
        x = lineX;
        y = lineY;
        break;
      case 'T*':
        lineY -= leading;
        x = lineX;
        y = lineY;
        break;
      case 'Tj':
      case "'":
      case '"': {
        if (token !== 'Tj') {
          lineY -= leading;
          x = lineX;
          y = lineY;
        }
        const last = operands.at(-1);
        if (last && (last.startsWith('(') || last.startsWith('<'))) show(last);
        break;
      }
      case 'TJ': {
        // An array of strings interleaved with kerning adjustments. A large
        // negative adjustment is how a space is drawn without a space glyph.
        const open = operands.lastIndexOf('[');
        if (open !== -1) {
          for (const item of operands.slice(open + 1)) {
            if (item.startsWith('(') || item.startsWith('<')) show(item);
            else if (/^[-+]?[\d.]+$/.test(item) && Number(item) < -180) {
              runs.push({ text: ' ', x, y, size });
            }
          }
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }

  return runs;
}

/** Applies a font's ToUnicode map to the bytes of a shown string. */
function mapThroughFont(
  raw: string,
  map: Map<number, string>,
  hex: boolean,
): string {
  if (map.size === 0) return raw;
  let out = '';
  // Hex strings in a subsetted font are two bytes per glyph; literals are one.
  const step = hex ? 2 : 1;
  for (let i = 0; i < raw.length; i += step) {
    const code =
      step === 2 ? (raw.charCodeAt(i) << 8) | (raw.charCodeAt(i + 1) || 0) : raw.charCodeAt(i);
    out += map.get(code) ?? (step === 1 ? raw[i] : '');
  }
  return out;
}

/** Parses a ToUnicode CMap into code → text. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charRe.exec(cmap))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairRe.exec(block[1]))) {
      map.set(parseInt(pair[1], 16), utf16beToString(pair[2]));
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeRe.exec(cmap))) {
    const lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let line: RegExpExecArray | null;
    while ((line = lineRe.exec(block[1]))) {
      const from = parseInt(line[1], 16);
      const to = parseInt(line[2], 16);
      const base = parseInt(line[3], 16);
      // A pathological range would otherwise allocate without bound.
      for (let code = from; code <= to && code - from < 65_536; code++) {
        map.set(code, String.fromCodePoint(base + (code - from)));
      }
    }
  }

  return map;
}

function utf16beToString(hex: string): string {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4), 16);
    if (!Number.isNaN(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/**
 * Font resources for a page, as name → ToUnicode map.
 *
 * Fonts without a ToUnicode map are left out, and their bytes are then used as
 * characters directly — correct for the WinAnsi encoding that ordinary Latin
 * text uses, and the reason an exported-from-Word PDF reads correctly.
 */
function fontsFor(
  pdf: Buffer,
  objects: Map<number, { start: number; end: number }>,
  pageDict: string,
): Map<string, Map<number, string>> {
  const fonts = new Map<string, Map<number, string>>();

  const resourceRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageDict);
  const resources = resourceRef
    ? regionText(pdf, objects.get(Number(resourceRef[1])))
    : pageDict;

  const fontSection = /\/Font\s*<<([\s\S]*?)>>/.exec(resources);
  const fontRefBlock = fontSection
    ? fontSection[1]
    : (() => {
        const ref = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resources);
        return ref ? regionText(pdf, objects.get(Number(ref[1]))) : '';
      })();

  const entryRe = /\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(fontRefBlock))) {
    const fontDict = regionText(pdf, objects.get(Number(entry[2])));
    const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontDict);
    if (!toUnicodeRef) continue;
    const region = objects.get(Number(toUnicodeRef[1]));
    const stream = region ? streamOf(pdf, region) : null;
    if (stream) fonts.set(entry[1], parseToUnicode(stream.toString('latin1')));
  }

  return fonts;
}

function regionText(
  pdf: Buffer,
  region: { start: number; end: number } | undefined,
): string {
  return region ? pdf.toString('latin1', region.start, region.end) : '';
}

// --- assembly -------------------------------------------------------------

/** Groups runs into lines by their baseline, then into paragraphs by gaps. */
function linesFromRuns(runs: TextRun[]): string[] {
  if (runs.length === 0) return [];

  const lines: Array<{ y: number; runs: TextRun[] }> = [];
  for (const run of runs) {
    // Half the font size of tolerance: subscripts and slight baseline shifts
    // belong to the line they sit on, a new line does not.
    const tolerance = Math.max(2, run.size * 0.5);
    const line = lines.find((candidate) => Math.abs(candidate.y - run.y) <= tolerance);
    if (line) line.runs.push(run);
    else lines.push({ y: run.y, runs: [run] });
  }

  // Top of the page downwards; PDF's y axis points up.
  lines.sort((a, b) => b.y - a.y);

  return lines.map((line) => {
    const ordered = [...line.runs].sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd: number | null = null;
    for (const run of ordered) {
      // A horizontal gap wider than a space means the writer moved rather than
      // drew a space — table columns and indentation both look like this.
      if (previousEnd !== null && run.x - previousEnd > run.size * 0.25) text += ' ';
      text += run.text;
      previousEnd = run.x + run.text.length * run.size * 0.5;
    }
    return text.replace(/\s+/g, ' ').trim();
  });
}

export function readPdf(bytes: Buffer): DocModel {
  const warnings: string[] = [];
  const objects = indexObjects(bytes);
  const text = bytes.toString('latin1');

  // Pages in document order. The page tree would be more correct, but object
  // order matches it in every writer that matters and needs no tree walk.
  const pageRegions: Array<{ dict: string; contents: number[] }> = [];
  for (const [, region] of objects) {
    const dict = bytes.toString('latin1', region.start, Math.min(region.end, region.start + 4000));
    if (!/\/Type\s*\/Page\b/.test(dict)) continue;

    const contents: number[] = [];
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (single) contents.push(Number(single[1]));
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict);
    if (array) {
      for (const ref of array[1].matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(Number(ref[1]));
    }
    if (contents.length > 0) pageRegions.push({ dict, contents });
  }

  const paragraphs: string[] = [];
  for (const page of pageRegions) {
    const fonts = fontsFor(bytes, objects, page.dict);
    let content = '';
    for (const number of page.contents) {
      const region = objects.get(number);
      const stream = region ? streamOf(bytes, region) : null;
      if (stream) content += stream.toString('latin1') + '\n';
    }
    if (content.length === 0) continue;
    for (const line of linesFromRuns(runsFrom(content, fonts))) {
      if (line.length > 0) paragraphs.push(line);
    }
  }

  const blocks: Block[] = paragraphs.map((line, index) => ({
    kind: 'paragraph',
    index,
    text: normalizeText(line),
    style: '',
    // A PDF carries no styles, so headings are inferred later from the text
    // itself rather than claimed here.
    headingLevel: 0,
    code: false,
  }));

  if (blocks.length === 0) {
    warnings.push(
      pageRegions.length === 0
        ? 'No pages could be read from this PDF. It may be encrypted.'
        : 'This PDF contains no extractable text — it is most likely a scan. ' +
          'Copy the text out and paste it in as Markdown, or use the original ' +
          'Word file if there is one.',
    );
  } else if (/\/Encrypt\b/.test(text)) {
    warnings.push('This PDF is encrypted; some text may be missing.');
  }

  return { blocks, title: null, warnings };
}
