/**
 * Markdown and plain text.
 *
 * Often the fastest route out of a format we cannot read well: a PDF that comes
 * back empty is usually a scan, and pasting the text in beats fighting it.
 * Markdown also arrives directly, because that is what a document exported from
 * a wiki or a Git repository looks like.
 */

import type { Block, DocModel, Paragraph, Table } from './model.ts';
import { normalizeText } from '../normalize.ts';

const FENCE = /^\s*(```|~~~)/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const SETEXT_UNDERLINE = /^\s*(=+|-{2,})\s*$/;
/** A Markdown table row: at least two cells between pipes. */
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/**
 * Markdown syntax is recognised in plain text too, rather than gated behind the
 * extension: a `.txt` that happens to use `#` headings or a fenced block loses
 * nothing by having them understood, and documents rarely arrive labelled.
 */
export function readText(input: string): DocModel {
  const lines = normalizeText(input).split('\n');
  const blocks: Block[] = [];
  const warnings: string[] = [];
  let title: string | null = null;

  // Spelled out as a union of both omits rather than `Omit<Block, 'index'>`:
  // omitting over a union keeps only the keys the members share, which is
  // `kind` alone, and every field would then be rejected.
  const push = (block: Omit<Paragraph, 'index'> | Omit<Table, 'index'>): void => {
    blocks.push({ ...block, index: blocks.length } as Block);
  };

  /** Consecutive non-blank prose lines, flushed as one paragraph. */
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length > 0) {
      push({ kind: 'paragraph', text, style: '', headingLevel: 0, code: false });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: kept whole, and marked as code. A pasted curl command lives
    // here, and reflowing it would break the line continuations it depends on.
    if (FENCE.test(line)) {
      flush();
      const fence = FENCE.exec(line)![1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
        body.push(lines[i]);
        i++;
      }
      push({
        kind: 'paragraph',
        text: body.join('\n'),
        style: 'code',
        headingLevel: 0,
        code: true,
      });
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      flush();
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      if (!title && heading[1].length === 1) title = text;
      push({
        kind: 'paragraph',
        text,
        style: `heading${heading[1].length}`,
        headingLevel: heading[1].length,
        code: false,
      });
      continue;
    }

    // Setext heading: the underline belongs to the line already buffered.
    if (SETEXT_UNDERLINE.test(line) && buffer.length === 1) {
      const text = buffer[0].trim();
      buffer = [];
      const level = line.trim().startsWith('=') ? 1 : 2;
      if (!title && level === 1) title = text;
      push({ kind: 'paragraph', text, style: `heading${level}`, headingLevel: level, code: false });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        // The `|---|---|` separator carries alignment, not content.
        if (!TABLE_DIVIDER.test(lines[i])) {
          rows.push(
            TABLE_ROW.exec(lines[i])![1]
              .split('|')
              .map((cell) => cell.trim()),
          );
        }
        i++;
      }
      i--;
      push({ kind: 'table', rows });
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    // An indented code block, the other way a curl command gets pasted in.
    if (/^(\t| {4})/.test(line) && buffer.length === 0) {
      const body: string[] = [];
      while (i < lines.length && (/^(\t| {4})/.test(lines[i]) || lines[i].trim() === '')) {
        body.push(lines[i].replace(/^(\t| {4})/, ''));
        i++;
      }
      i--;
      push({
        kind: 'paragraph',
        text: body.join('\n').trim(),
        style: 'code',
        headingLevel: 0,
        code: true,
      });
      continue;
    }

    buffer.push(line);
  }
  flush();

  if (blocks.length === 0) warnings.push('No text was found in this file.');
  return { blocks, title, warnings };
}
