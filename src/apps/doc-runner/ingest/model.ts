/**
 * One shape every input format collapses to before anything tries to read it.
 *
 * A handed-over API document is a Word file, a PDF, or a Markdown export of
 * either, and the endpoints inside are written four or five different ways. Two
 * axes of variation is one too many, so the readers flatten the *format* into
 * this, and the extractors deal only with the *layout*.
 *
 * Deliberately minimal: paragraphs with a style hint, and tables as rows of
 * cells. Fonts, colours and numbering carry no information about an endpoint.
 */

export type Block = Paragraph | Table;

export type Paragraph = {
  kind: 'paragraph';
  /** Zero-based position in the document, shared across both block types. */
  index: number;
  text: string;
  /**
   * Word's paragraph style, lower-cased — `heading1`, `title`, `listparagraph`.
   * Empty when the format has no styles. Used for section headings, never
   * required: plenty of documents mark headings with bold text alone.
   */
  style: string;
  /** Heading depth, 1-6, or 0 when this is not a heading. */
  headingLevel: number;
  /** True when the whole paragraph is monospaced or fenced — a code block. */
  code: boolean;
};

export type Table = {
  kind: 'table';
  index: number;
  /** Rows of already-flattened cell text. Ragged rows are normal and kept. */
  rows: string[][];
};

export type DocModel = {
  /** Blocks in document order; `index` matches the position in this array. */
  blocks: Block[];
  /** Title from the file's own metadata, when it has any. */
  title: string | null;
  /** Anything the reader wants a human to know — truncation, missing text. */
  warnings: string[];
};

export function isParagraph(block: Block): block is Paragraph {
  return block.kind === 'paragraph';
}

export function isTable(block: Block): block is Table {
  return block.kind === 'table';
}

/** Every paragraph's text joined, for extractors that work line by line. */
export function linesOf(blocks: Block[]): Array<{ index: number; text: string }> {
  const lines: Array<{ index: number; text: string }> = [];
  for (const block of blocks) {
    if (!isParagraph(block)) continue;
    // A paragraph can hold several visual lines via <w:br/>; an extractor
    // matching "Method : GET" has to see those separately.
    for (const line of block.text.split('\n')) {
      lines.push({ index: block.index, text: line });
    }
  }
  return lines;
}
