/**
 * The most common layout: one table per endpoint, keys down the left.
 *
 *   | HTTP Method  | GET                                  |
 *   | URL          | https://host/api/thing?id=1          |
 *   | Request Header | Accept: * / *                      |
 *   | Request Body | No Request Body Required             |
 *   | Response     | { "status": true }                   |
 *
 * And the same thing with an environment column, which is how a document lists
 * staging and production without writing the table twice:
 *
 *   | URL |            | Staging    | https://staging.host/v1 |
 *   |     | Production | https://host/v1                      |
 *
 * The second form is why the value is taken as "everything after the label
 * column" rather than "the second cell": a fixed column index reads the word
 * `Staging` as the URL.
 */

import type { HeaderPair } from '../../../types.ts';
import type { Table } from '../ingest/model.ts';
import { labelKey, squash } from '../normalize.ts';
import {
  findMethod,
  findUrl,
  inferMime,
  isEmptyMarker,
  isMethod,
  parseHeaderLines,
  tidyJson,
} from './shared.ts';
import type { Candidate } from './candidate.ts';

/** Row labels, normalised, mapped to the field they fill. */
const FIELDS: Record<string, 'method' | 'url' | 'headers' | 'body' | 'response'> = {
  httpmethod: 'method',
  method: 'method',
  requestmethod: 'method',
  verb: 'method',
  httpverb: 'method',

  url: 'url',
  endpoint: 'url',
  endpointurl: 'url',
  apiurl: 'url',
  requesturl: 'url',
  uri: 'url',
  apiendpoint: 'url',
  serviceurl: 'url',

  requestheader: 'headers',
  requestheaders: 'headers',
  header: 'headers',
  headers: 'headers',
  authorizationheaders: 'headers',

  requestbody: 'body',
  body: 'body',
  requestpayload: 'body',
  payload: 'body',
  requestparameter: 'body',
  requestparameters: 'body',
  input: 'body',

  response: 'response',
  responsebody: 'response',
  sampleresponse: 'response',
  responseparameter: 'response',
  responseparameters: 'response',
  output: 'response',
};

/** Environment names a URL row may be split by. */
const ENVIRONMENTS = /^(staging|stage|uat|dev|development|test|testing|sit|qa|production|prod|live)$/i;

/**
 * True when this table describes one endpoint.
 *
 * The bar is a URL or a method plus at least one other recognised row: a
 * response-code table has two columns and consistent labels too, and mistaking
 * one for an endpoint puts a phantom request in the list.
 */
function looksLikeSpec(table: Table): boolean {
  let recognised = 0;
  let hasUrlOrMethod = false;

  for (const row of table.rows) {
    if (row.length < 2) continue;
    const field = FIELDS[labelKey(row[0])];
    if (!field) continue;
    recognised++;
    if (field === 'url' || field === 'method') hasUrlOrMethod = true;
  }

  return hasUrlOrMethod && recognised >= 2;
}

/** Everything to the right of the label, joined — see the note about columns. */
function valueOf(row: string[]): string {
  return row
    .slice(1)
    .filter((cell) => cell.trim().length > 0)
    .join('\n')
    .trim();
}

/**
 * Reads a URL row that may be split across environments.
 *
 * Rows after the first often have an empty label cell, so the caller passes the
 * whole run of rows belonging to the URL label.
 */
function readUrlRows(rows: string[][]): {
  url: string | null;
  environments: Array<{ name: string; url: string }>;
} {
  const environments: Array<{ name: string; url: string }> = [];
  let fallback: string | null = null;

  for (const row of rows) {
    const cells = row.filter((cell) => cell.trim().length > 0);
    const url = findUrl(cells.join(' '));
    if (!url) continue;

    // The environment is whichever cell before the URL names one.
    const label = cells.find((cell) => ENVIRONMENTS.test(squash(cell)));
    if (label) environments.push({ name: squash(label), url });
    else if (!fallback) fallback = url;
  }

  // A document that names its environments has no unlabelled URL, so the first
  // environment becomes the one we run against by default.
  const url = fallback ?? environments[0]?.url ?? null;
  return { url, environments };
}

export function extractSpecTables(tables: Table[]): Candidate[] {
  const candidates: Candidate[] = [];

  for (const table of tables) {
    if (!looksLikeSpec(table)) continue;

    // Group rows under the last label seen, so continuation rows with an empty
    // first cell attach to the row above them rather than being dropped.
    const grouped = new Map<string, string[][]>();
    let current: string | null = null;

    for (const row of table.rows) {
      if (row.length === 0) continue;
      const field = FIELDS[labelKey(row[0])];
      if (field) {
        current = field;
        const bucket = grouped.get(field) ?? [];
        bucket.push(row);
        grouped.set(field, bucket);
        continue;
      }
      // No label: a continuation of the previous field, but only when the first
      // cell really is empty — otherwise it is an unrelated row.
      if (current && row[0].trim().length === 0) {
        grouped.get(current)!.push(row);
      }
    }

    const urlRows = grouped.get('url') ?? [];
    const { url, environments } = readUrlRows(urlRows);
    if (!url) continue;

    const methodRows = grouped.get('method') ?? [];
    const methodText = methodRows.map(valueOf).join(' ');
    const method = isMethod(methodText)
      ? squash(methodText).toUpperCase()
      : (findMethod(methodText) ?? 'GET');

    const headerText = (grouped.get('headers') ?? []).map(valueOf).join('\n');
    const headers: HeaderPair[] = isEmptyMarker(headerText)
      ? []
      : parseHeaderLines(headerText);

    const bodyText = (grouped.get('body') ?? []).map(valueOf).join('\n');
    const body = isEmptyMarker(bodyText) ? null : tidyJson(bodyText).text;

    const responseText = (grouped.get('response') ?? []).map(valueOf).join('\n');
    const documentedResponse = isEmptyMarker(responseText)
      ? null
      : tidyJson(responseText).text;

    const warnings: string[] = [];
    if (body && !tidyJson(bodyText).valid && /^[{[]/.test(bodyText.trim())) {
      warnings.push(
        'The request body looks like JSON but does not parse — check it before running.',
      );
    }
    // A body with no content type is the single most common reason one of these
    // documented calls 400s when someone finally runs it.
    if (body && headers.every(([name]) => name.toLowerCase() !== 'content-type')) {
      warnings.push('No Content-Type header was documented; one was added from the body.');
    }

    candidates.push({
      method,
      url,
      environments,
      headers,
      body,
      bodyMime: inferMime(body, headers),
      documentedResponse,
      blocks: [table.index],
      extractor: 'spec-table',
      // The highest confidence of any extractor: the document has said outright
      // which value is which, rather than leaving it to be inferred.
      confidence: 0.95,
      warnings,
    });
  }

  return candidates;
}
