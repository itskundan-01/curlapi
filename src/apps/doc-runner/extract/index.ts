/**
 * From a document to a list of endpoints somebody can actually run.
 *
 * The extractors find requests; this puts them back in context. An endpoint
 * lifted out of a table with no name, no section and none of the surrounding
 * explanation is a curl command in a list — which is exactly the state the
 * reader was already in with the document open beside Postman.
 */

import { randomUUID } from 'node:crypto';
import type { HeaderPair } from '../../../types.ts';
import type { Block, DocModel, Paragraph } from '../ingest/model.ts';
import { isParagraph, isTable } from '../ingest/model.ts';
import { squash } from '../normalize.ts';
import type { DocParam, ParsedEndpoint, ParseResult, Variable } from '../types.ts';
import type { Candidate } from './candidate.ts';
import { extractCurl } from './curl.ts';
import { extractLabelled } from './labelled.ts';
import { extractSpecTables } from './spec-table.ts';
import { mergeCandidates } from './merge.ts';
import { readParamTable, readResponseCodeTable } from './tables.ts';
import { isSecretHeader } from './shared.ts';

/** How far ahead of an endpoint to look for its parameter and code tables. */
const LOOKAHEAD_BLOCKS = 8;
/** How far back to look for a name when there is no heading. */
const LOOKBEHIND_BLOCKS = 4;

export function extractEndpoints(model: DocModel): ParseResult {
  const tables = model.blocks.filter(isTable);

  /**
   * A curl command claims its lines exclusively.
   *
   * Without this, a Chrome-exported command turns into a swarm of phantom
   * endpoints: `-H 'origin: https://site'` and `-H 'referer: https://site/'` are
   * bare URLs on a line to any extractor that reads line by line, so a document
   * of twenty-three commands produced sixteen extra candidates and two survived
   * into the list as GETs against the site's own home page.
   */
  const curlCandidates = extractCurl(model.blocks);
  const claimed = new Set(curlCandidates.flatMap((candidate) => candidate.blocks));

  const candidates = [
    ...extractSpecTables(tables),
    ...curlCandidates,
    ...extractLabelled(model.blocks, claimed),
  ];

  const stats: Record<string, number> = {};
  for (const candidate of candidates) {
    stats[candidate.extractor] = (stats[candidate.extractor] ?? 0) + 1;
  }

  const merged = mergeCandidates(candidates);
  // Headings are read from what is left: a `-H 'accept: application/json'` line
  // is not a section title, however much it looks like a short line of text.
  const headings = headingIndex(model.blocks, claimed);

  const endpoints = merged.map((candidate, position) =>
    // Where the next endpoint begins bounds the search for this one's tables.
    // Without it, the last endpoint in a document collects every table after it.
    enrich(
      candidate,
      position,
      model,
      headings,
      merged[position + 1]?.blocks[0] ?? Number.MAX_SAFE_INTEGER,
    ),
  );

  // Two endpoints under one heading — the same route posted with different
  // payloads — would otherwise be indistinguishable in the list.
  disambiguate(endpoints);

  const warnings = [...model.warnings];
  if (endpoints.length === 0 && model.blocks.length > 0) {
    warnings.push(
      'No endpoints were recognised in this document. If the requests are ' +
        'written in a way this has not seen before, paste one in as a curl ' +
        'command and it will be read directly.',
    );
  }

  return {
    endpoints,
    variables: collectVariables(endpoints),
    title: model.title,
    warnings,
    stats,
  };
}

/**
 * Numbers repeated names in place.
 *
 * Only the second and later occurrences are touched, so the common case — one
 * heading, one endpoint — reads exactly as the document wrote it.
 */
function disambiguate(endpoints: ParsedEndpoint[]): void {
  const seen = new Map<string, number>();
  for (const endpoint of endpoints) {
    const count = (seen.get(endpoint.name) ?? 0) + 1;
    seen.set(endpoint.name, count);
    if (count > 1) endpoint.name = `${endpoint.name} (${count})`;
  }
}

// --- naming and sections --------------------------------------------------

type HeadingEntry = { index: number; level: number; text: string };

function headingIndex(blocks: Block[], claimed: Set<number>): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  for (const block of blocks) {
    if (!isParagraph(block)) continue;
    // Lines inside a curl command are never headings, however title-like they
    // look on their own.
    if (claimed.has(block.index)) continue;

    if (block.headingLevel > 0) {
      headings.push({ index: block.index, level: block.headingLevel, text: squash(block.text) });
      continue;
    }

    const marked = markedHeadingLevel(block.text);
    if (marked > 0) {
      headings.push({ index: block.index, level: marked, text: squash(block.text) });
      continue;
    }

    // A document with no styles still has headings; a short line on its own
    // that names the thing below it is one in every sample here.
    if (looksLikeUnstyledHeading(block)) {
      headings.push({ index: block.index, level: 3, text: squash(block.text) });
    }
  }
  return headings;
}

/**
 * A heading the author marked by hand rather than with a style.
 *
 * `# 1. userrecentservice — POST 200` and `2) Fetch profile` are both headings
 * that no word processor knows about. This matters more than it sounds: the
 * conservative test below rejects most of them — one has a colon, another is
 * mostly punctuation — and an endpoint with no heading of its own silently
 * inherits the last one that *was* recognised. A document of twenty-three
 * commands ended up with two names between them.
 */
function markedHeadingLevel(raw: string): number {
  const text = squash(raw);
  // Markdown-style, as pasted into Word: the count of hashes is the depth.
  const hashes = /^(#{1,6})\s+\S/.exec(text);
  if (hashes) return hashes[1].length;
  // A numbered item followed by a name, not by a sentence.
  if (/^\d{1,3}[.)]\s+\S/.test(text) && text.length <= 90 && !/[.!?]$/.test(text)) return 2;
  return 0;
}

/**
 * A heading a word processor never marked as one.
 *
 * Two of the samples are written entirely in body text, so relying on styles
 * alone would leave every endpoint in them unnamed. The test is deliberately
 * conservative: short, no sentence punctuation, not itself a labelled value.
 */
function looksLikeUnstyledHeading(block: Paragraph): boolean {
  const text = squash(block.text);
  if (text.length === 0 || text.length > 70) return false;
  if (text.includes('\n')) return false;
  if (/[.:;,]$/.test(text)) return false;
  if (/^(https?:\/\/|curl\b|[-{[])/i.test(text)) return false;
  // `Method : GET` and friends are values, not titles.
  if (/[:=]\s*\S/.test(text)) return false;
  // At least two words, and mostly letters.
  if (!/\s/.test(text)) return false;
  const letters = text.replace(/[^A-Za-z]/g, '').length;
  return letters / text.length > 0.6;
}

/**
 * A heading reduced to the name of the thing it labels.
 *
 * Chrome-exported documents write `# 1. userrecentservice — POST 200`, where
 * everything but the middle is scaffolding: the marker, the position in the
 * list, and a method and status that the request itself already states.
 */
export function cleanHeading(text: string): string {
  let name = squash(text)
    // Leading marker and numbering, in either order.
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d{1,3}(\.\d+)*[.)]?\s+/, '')
    // Trailing "— POST 200", "- GET", "(200)". The status is `(\s+\d{3})?` and
    // not `\d{3}?`, which is a lazy quantifier for exactly three digits and so
    // would require the code rather than allow it.
    .replace(/\s*[-–—]\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(\s+\d{3})?\s*$/i, '')
    .replace(/\s*\(\s*\d{3}\s*\)\s*$/, '')
    .trim();

  // Stripping everything is worse than keeping the original.
  if (name.length === 0) name = squash(text).replace(/^#{1,6}\s*/, '').trim();
  return name;
}

/** The heading trail above a block, outermost first. */
function sectionFor(headings: HeadingEntry[], blockIndex: number): string[] {
  const above = headings.filter((heading) => heading.index < blockIndex);
  const trail: HeadingEntry[] = [];
  for (const heading of above) {
    // A heading closes every heading at or below its own level.
    while (trail.length > 0 && trail[trail.length - 1].level >= heading.level) trail.pop();
    trail.push(heading);
  }
  return trail.map((heading) => heading.text);
}

/**
 * A name for the endpoint.
 *
 * The nearest heading above it is right nearly always, because that is how these
 * documents are organised. Failing that, the URL's last meaningful path segment
 * is a better label than "Endpoint 4".
 */
function nameFor(
  candidate: Candidate,
  section: string[],
  model: DocModel,
): string {
  const first = candidate.blocks[0] ?? 0;

  const heading = section.at(-1);
  if (heading && heading.length > 0) return cleanHeading(heading);

  // No heading: a short line just above the request often names it.
  for (let i = first - 1; i >= Math.max(0, first - LOOKBEHIND_BLOCKS); i--) {
    const block = model.blocks[i];
    if (block && isParagraph(block) && looksLikeUnstyledHeading(block)) {
      return squash(block.text);
    }
  }

  try {
    const url = new URL(candidate.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    if (last) return decodeURIComponent(last);
    return url.hostname;
  } catch {
    return candidate.url;
  }
}

// --- attaching the tables around an endpoint ------------------------------

/**
 * Finds the parameter and response-code tables that belong to an endpoint.
 *
 * They follow it, so the search runs forward and stops at the next endpoint —
 * otherwise the last endpoint in a document would collect every table after it.
 */
function tablesAfter(
  model: DocModel,
  fromBlock: number,
  nextEndpointBlock: number,
): { params: DocParam[]; codes: ParsedEndpoint['responseCodes'] } {
  const params: DocParam[] = [];
  const codes: ParsedEndpoint['responseCodes'] = [];
  const limit = Math.min(nextEndpointBlock, fromBlock + LOOKAHEAD_BLOCKS + 1);

  for (let i = fromBlock + 1; i < limit && i < model.blocks.length; i++) {
    const block = model.blocks[i];
    if (!block || !isTable(block)) continue;

    const responseCodes = readResponseCodeTable(block);
    if (responseCodes) {
      codes.push(...responseCodes);
      continue;
    }

    const tableParams = readParamTable(block);
    if (tableParams) params.push(...tableParams);
  }

  return { params, codes };
}

/** The prose immediately above an endpoint, which is usually what it is for. */
function descriptionFor(model: DocModel, firstBlock: number): string {
  for (let i = firstBlock - 1; i >= Math.max(0, firstBlock - 3); i--) {
    const block = model.blocks[i];
    if (!block || !isParagraph(block)) continue;
    if (block.headingLevel > 0) return '';
    const text = squash(block.text);
    // A sentence, rather than a label or a heading.
    if (text.length > 25 && /[.!]$/.test(text)) return text;
  }
  return '';
}

function enrich(
  candidate: Candidate,
  position: number,
  model: DocModel,
  headings: HeadingEntry[],
  nextEndpointBlock: number,
): ParsedEndpoint {
  const firstBlock = candidate.blocks[0] ?? 0;
  const lastBlock = candidate.blocks.at(-1) ?? firstBlock;
  // Cleaned here so the trail reads the same everywhere it is shown — the list
  // grouping, the Postman folders and the Markdown export.
  const section = sectionFor(headings, firstBlock).map(cleanHeading).filter(Boolean);
  const { params, codes } = tablesAfter(model, lastBlock, nextEndpointBlock);

  const headers = ensureContentType(candidate);
  const warnings = [...candidate.warnings];

  const pathParams = pathVariablesOf(candidate.url);
  const queryParams = queryParamsOf(candidate.url);

  // Where each documented field actually belongs.
  //
  // These documents put request and response field tables in the same shape,
  // one after the other, and only the payloads say which is which. Membership in
  // the request body or the documented response is direct evidence, so it is
  // preferred over the table's own claim and over any default.
  const bodyKeys = jsonKeys(candidate.body);
  const responseKeys = jsonKeys(candidate.documentedResponse);

  const placed = params.map((param) => {
    const key = param.name.toLowerCase();
    let where: DocParam['in'] = param.in;

    if (pathParams.includes(param.name)) where = 'path';
    else if (queryParams.includes(param.name)) where = 'query';
    else if (bodyKeys.has(key)) where = 'body';
    else if (responseKeys.has(key)) where = 'response';
    // Nothing matched. A field table under an endpoint that sends no body is
    // describing what comes back — there is nowhere else for it to be.
    else if (!candidate.body && param.in === 'body') where = 'response';

    return { ...param, in: where };
  });

  // Path placeholders with no documentation still have to be surfaced, or the
  // request runs with `{bookingId}` in the URL and 404s.
  for (const name of pathParams) {
    if (placed.some((param) => param.name === name)) continue;
    placed.push({
      name,
      in: 'path',
      description: '',
      dataType: '',
      expected: '',
      required: true,
    });
  }

  if (pathParams.length > 0) {
    warnings.push(
      `The URL has ${pathParams.length === 1 ? 'a placeholder' : 'placeholders'} ` +
        `(${pathParams.map((name) => `{${name}}`).join(', ')}) — fill ${
          pathParams.length === 1 ? 'it' : 'them'
        } in before running.`,
    );
  }

  return {
    id: randomUUID(),
    position,
    name: nameFor(candidate, section, model),
    section,
    method: candidate.method.toUpperCase(),
    url: candidate.url,
    environments: candidate.environments,
    headers,
    body: candidate.body,
    bodyMime: candidate.bodyMime,
    documentedResponse: candidate.documentedResponse,
    responseCodes: codes,
    params: placed,
    description: descriptionFor(model, firstBlock),
    notes: [],
    provenance: {
      extractor: candidate.extractor,
      confidence: candidate.confidence,
      blocks: candidate.blocks,
    },
    warnings,
  };
}

/**
 * Adds the content type a body implies but the document did not state.
 *
 * Sending a JSON body with no `Content-Type` is the most common reason one of
 * these documented calls 400s the first time it is run for real, and the
 * document meant JSON — it wrote JSON.
 */
function ensureContentType(candidate: Candidate): HeaderPair[] {
  if (!candidate.body) return candidate.headers;
  if (candidate.headers.some(([name]) => name.toLowerCase() === 'content-type')) {
    return candidate.headers;
  }
  const mime = candidate.bodyMime || 'application/json';
  return [...candidate.headers, ['Content-Type', mime]];
}

// --- variables ------------------------------------------------------------

/**
 * Every key in a JSON payload, at any depth, lower-cased.
 *
 * Nested because these documents describe `pd.success` as `success`, and a
 * top-level-only scan would file it as a request field instead.
 */
function jsonKeys(payload: string | null): Set<string> {
  const keys = new Set<string>();
  if (!payload) return keys;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not valid JSON — fall back to reading the quoted keys out of the text, so
    // a body the document mangled still classifies its own fields.
    for (const match of payload.matchAll(/"([^"]+)"\s*:/g)) keys.add(match[1].toLowerCase());
    return keys;
  }

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.add(key.toLowerCase());
      walk(child);
    }
  };
  walk(parsed);
  return keys;
}

/** `{bookingId}` and `:bookingId` in a path. */
function pathVariablesOf(url: string): string[] {
  const names = new Set<string>();
  let path = url;
  try {
    // Decoded, because `new URL()` percent-encodes braces: a path written
    // `/order-status/{bookingId}` comes back as `/order-status/%7BbookingId%7D`
    // and the placeholder becomes invisible to the pattern below.
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    /* keep the raw string */
  }
  for (const match of path.matchAll(/\{([A-Za-z_][\w-]*)\}/g)) names.add(match[1]);
  for (const match of path.matchAll(/(?:^|\/):([A-Za-z_][\w-]*)/g)) names.add(match[1]);
  return [...names];
}

function queryParamsOf(url: string): string[] {
  try {
    return [...new URL(url).searchParams.keys()];
  } catch {
    return [];
  }
}

/**
 * The values worth filling in once for the whole document.
 *
 * Credentials are the important half. A department's API key repeated across
 * thirty endpoints has to become one variable before the collection can be
 * shared with anybody — which is the whole reason to export one.
 */
function collectVariables(endpoints: ParsedEndpoint[]): Variable[] {
  const variables = new Map<string, Variable>();

  for (const endpoint of endpoints) {
    for (const [name, value] of endpoint.headers) {
      if (!isSecretHeader(name)) continue;
      const key = variableKey(name);
      const existing = variables.get(key);
      // Two endpoints with different values for the same credential header
      // means it is per-request, so leave the first and let the reader decide.
      if (existing && existing.value !== value) continue;
      variables.set(key, { key, value, secret: true, origin: 'header' });
    }

    for (const param of endpoint.params) {
      if (param.in !== 'path') continue;
      const key = param.name;
      if (variables.has(key)) continue;
      variables.set(key, {
        key,
        value: param.expected || '',
        secret: false,
        origin: 'path',
      });
    }
  }

  return [...variables.values()];
}

/** `X-Api-Key` → `api_key`, which is what reads well in `{{api_key}}`. */
function variableKey(headerName: string): string {
  return headerName
    .toLowerCase()
    .replace(/^x-/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export { pathVariablesOf, variableKey };
