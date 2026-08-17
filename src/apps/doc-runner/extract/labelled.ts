/**
 * An endpoint written as labelled lines rather than a table.
 *
 *   List Application of Students
 *   Method :- GET
 *   https://host/PMSApi/api/PMSApply/Get_PMS_Applications?SamagraId=163614172
 *   Headers :-  Pass below keys in header
 *   X-Api-Key - 606F4068-…
 *   Activation_Key - 5983C7A0-…
 *
 * Two things make this harder than the table form. The URL is on a line of its
 * own with no label at all, and the headers are `Name - Value` pairs written
 * under a "pass these in the header" sentence — so whether `X-Api-Key - 606F…`
 * is a header or a sentence depends on the line above it.
 *
 * The reading is therefore stateful: walk the lines, and let a `Headers:` label
 * put the walk into a mode where bare pairs are headers until something ends it.
 */

import type { HeaderPair } from '../../../types.ts';
import type { Block } from '../ingest/model.ts';
import { isParagraph } from '../ingest/model.ts';
import { labelKey, normalizeText, squash, stripSeparator } from '../normalize.ts';
import {
  findMethod,
  findUrl,
  inferMime,
  isEmptyMarker,
  isHeaderName,
  isMethod,
  tidyJson,
} from './shared.ts';
import type { Candidate } from './candidate.ts';

type Label = 'method' | 'url' | 'headers' | 'body' | 'response' | 'name';

const LABELS: Record<string, Label> = {
  method: 'method',
  httpmethod: 'method',
  requestmethod: 'method',
  requesttype: 'method',

  url: 'url',
  apiurl: 'url',
  endpoint: 'url',
  endpointurl: 'url',
  requesturl: 'url',
  apiendpoint: 'url',
  serviceurl: 'url',
  baseurl: 'url',

  header: 'headers',
  headers: 'headers',
  requestheader: 'headers',
  requestheaders: 'headers',
  authorizationheader: 'headers',
  authorizationheaders: 'headers',

  body: 'body',
  requestbody: 'body',
  payload: 'body',
  requestpayload: 'body',
  requestparameter: 'body',
  requestparameters: 'body',
  parameters: 'body',

  response: 'response',
  responsebody: 'response',
  responseparameter: 'response',
  responseparameters: 'response',
  sampleresponse: 'response',

  apiname: 'name',
  name: 'name',
  servicename: 'name',
};

/** Splits `Method :- GET` into its label and value. */
function readLabel(line: string): { label: Label; value: string } | null {
  const text = squash(line);
  // The separator has to be present: a heading that happens to read "Headers"
  // is a section title, not a labelled value.
  const match = /^([A-Za-z][A-Za-z ]{0,28}?)\s*[:=]-?\s*(.*)$/.exec(text);
  if (!match) return null;
  const label = LABELS[labelKey(match[1])];
  if (!label) return null;
  return { label, value: stripSeparator(match[2]) };
}

/** `X-Api-Key - 606F…` → a header pair, or null if the line is prose. */
function readHeaderPair(line: string): HeaderPair | null {
  const text = squash(line);
  const match = /^([A-Za-z][A-Za-z0-9_-]{0,63})\s*[:\-]\s*(.+)$/.exec(text);
  if (!match) return null;
  const name = match[1].trim();
  const value = match[2].trim();
  if (!isHeaderName(name) || value.length === 0) return null;
  // A sentence with a dash in it would otherwise become a header.
  if (/\s/.test(name)) return null;
  return [name, value];
}

/**
 * The `key - X-Api-Key` / `Value - F13D…` form, where the header's name and its
 * value are on separate lines under their own labels.
 */
function isKeyLabel(line: string): 'key' | 'value' | null {
  const key = labelKey(squash(line).split(/[:\-]/)[0] ?? '');
  if (key === 'key' || key === 'keyname' || key === 'headername') return 'key';
  if (key === 'value' || key === 'keyvalue' || key === 'headervalue') return 'value';
  return null;
}

/**
 * A line the walk should stop at, and treat what follows as environment notes.
 *
 * Both MP-SEDC samples end with sign-in details for the staging *website* —
 * a URL, a login id, a password, a district. Those are notes for a human, not an
 * endpoint: without this the login page becomes a GET request in the list, and
 * the password becomes a header.
 */
const SECTION_BREAK =
  /^(staging|production|uat|test|dev)\s*(url|environment|details|credentials|server)?\s*:?\s*$/i;

/**
 * @param claimed Blocks another extractor has already taken, skipped entirely.
 *   A Chrome-exported curl command is full of lines that read as endpoints on
 *   their own — `-H 'origin: https://site'`, `-H 'referer: https://site/'` — and
 *   without this a document of twenty-three commands yields sixteen phantoms.
 */
export function extractLabelled(blocks: Block[], claimed: Set<number> = new Set()): Candidate[] {
  const candidates: Candidate[] = [];

  // Flatten to lines, remembering which block each came from so provenance and
  // the section trail still work.
  const lines: Array<{ text: string; block: number; heading: boolean }> = [];
  for (const block of blocks) {
    if (!isParagraph(block)) continue;
    if (claimed.has(block.index)) continue;
    for (const line of normalizeText(block.text).split('\n')) {
      if (line.trim().length === 0) continue;
      lines.push({ text: line, block: block.index, heading: block.headingLevel > 0 });
    }
  }

  let current: Draft | null = null;
  const flush = (): void => {
    const candidate = current ? finish(current) : null;
    if (candidate) candidates.push(candidate);
    current = null;
  };

  let mode: 'none' | 'headers' | 'body' | 'response' = 'none';
  let pendingKey: string | null = null;
  /**
   * Set once a "Staging URL" style break is seen. Everything after it is an
   * environment note until an explicit label starts a real endpoint again, so a
   * bare URL in that region is not turned into a request.
   */
  let inEnvironmentNotes = false;

  for (const line of lines) {
    const text = line.text.trim();
    const labelled = readLabel(text);

    // A curl command is another extractor's business, and its lines would be
    // misread here as labels.
    if (/^curl\b/i.test(text)) {
      flush();
      mode = 'none';
      continue;
    }

    if (labelled) {
      const { label, value } = labelled;

      // A second method or URL means a new endpoint has started.
      if (
        current &&
        ((label === 'method' && current.method !== null) ||
          (label === 'url' && current.url !== null))
      ) {
        flush();
      }
      // An explicit label means the notes section is over and a real endpoint
      // is being described again.
      inEnvironmentNotes = false;
      current ??= newDraft(line.block);
      current.blocks.add(line.block);
      mode = 'none';

      switch (label) {
        case 'method': {
          const method = isMethod(value) ? squash(value).toUpperCase() : findMethod(value);
          if (method) current.method = method;
          break;
        }
        case 'url': {
          const url = findUrl(value);
          if (url) current.url = url;
          break;
        }
        case 'headers':
          mode = 'headers';
          // The value may be a header itself, or a sentence introducing them.
          if (value.length > 0 && !isEmptyMarker(value)) {
            const pair = readHeaderPair(value);
            if (pair) current.headers.push(pair);
          }
          break;
        case 'body':
          mode = 'body';
          if (value.length > 0 && !isEmptyMarker(value)) current.bodyLines.push(value);
          break;
        case 'response':
          mode = 'response';
          if (value.length > 0 && !isEmptyMarker(value)) current.responseLines.push(value);
          break;
        case 'name':
          if (value.length > 0) current.name = value;
          break;
      }
      continue;
    }

    // A bare URL line, which is how the samples give the endpoint address.
    const url = findUrl(text);
    if (url && !line.heading && !inEnvironmentNotes) {
      // A URL under a "Staging URL" break belongs to that section, not here.
      if (mode === 'none' || !current) {
        current ??= newDraft(line.block);
        if (!current.url) {
          current.url = url;
          current.blocks.add(line.block);
          continue;
        }
        // A second bare URL starts a new endpoint.
        flush();
        current = newDraft(line.block);
        current.url = url;
        current.blocks.add(line.block);
        continue;
      }
    }

    if (SECTION_BREAK.test(text)) {
      flush();
      mode = 'none';
      inEnvironmentNotes = true;
      continue;
    }

    if (!current) continue;

    if (mode === 'headers') {
      const keyLabel = isKeyLabel(text);
      if (keyLabel === 'key') {
        pendingKey = stripSeparator(text.replace(/^[^:\-]*/, ''));
        current.blocks.add(line.block);
        continue;
      }
      if (keyLabel === 'value' && pendingKey) {
        const value = stripSeparator(text.replace(/^[^:\-]*/, ''));
        if (isHeaderName(pendingKey) && value.length > 0) {
          current.headers.push([pendingKey, value]);
        }
        pendingKey = null;
        current.blocks.add(line.block);
        continue;
      }

      const pair = readHeaderPair(text);
      if (pair) {
        current.headers.push(pair);
        current.blocks.add(line.block);
        continue;
      }
      // Prose inside a header section — "Pass below keys in header" — is kept
      // as a note rather than ending the section.
      if (text.length < 120) continue;
      mode = 'none';
      continue;
    }

    if (mode === 'body') {
      current.bodyLines.push(line.text);
      current.blocks.add(line.block);
      continue;
    }

    if (mode === 'response') {
      current.responseLines.push(line.text);
      current.blocks.add(line.block);
      continue;
    }
  }

  flush();
  return candidates;
}

type Draft = {
  name: string | null;
  method: string | null;
  url: string | null;
  headers: HeaderPair[];
  bodyLines: string[];
  responseLines: string[];
  blocks: Set<number>;
};

function newDraft(block: number): Draft {
  return {
    name: null,
    method: null,
    url: null,
    headers: [],
    bodyLines: [],
    responseLines: [],
    blocks: new Set([block]),
  };
}

function finish(draft: Draft): Candidate | null {
  if (!draft.url) return null;

  const bodyText = draft.bodyLines.join('\n').trim();
  const body = bodyText.length > 0 && !isEmptyMarker(bodyText) ? tidyJson(bodyText).text : null;
  const responseText = draft.responseLines.join('\n').trim();

  return {
    method: draft.method ?? (body ? 'POST' : 'GET'),
    url: draft.url,
    environments: [],
    headers: draft.headers,
    body,
    bodyMime: inferMime(body, draft.headers),
    documentedResponse:
      responseText.length > 0 && !isEmptyMarker(responseText)
        ? tidyJson(responseText).text
        : null,
    blocks: [...draft.blocks].sort((a, b) => a - b),
    extractor: 'labelled',
    // Lower than a table: the reading depends on line order and on labels that
    // vary between documents, so it is the one most worth checking.
    confidence: 0.7,
    warnings:
      draft.method === null
        ? ['No HTTP method was stated; it was inferred from whether a body is present.']
        : [],
  };
}
