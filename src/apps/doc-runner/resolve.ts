/**
 * Turning a documented endpoint into something that can actually be sent.
 *
 * Two jobs. Substituting the values the reader has filled in — a document is
 * full of `{bookingId}` and expired sample tokens, and a request carrying those
 * verbatim fails in a way that says nothing about the API. And presenting the
 * result as a `RequestRecord`, which is the shape the rest of curlapi already
 * knows how to run, escape and export.
 *
 * That second part is the reason this app can run and copy anything at all
 * without a line of new HTTP or shell-escaping code: the capture side had both,
 * and they were never specific to captures.
 */

import type { HeaderPair, RequestRecord } from '../../types.ts';
import type { ParsedEndpoint, Variable } from './types.ts';

/**
 * One row in the header editor.
 *
 * Carries `enabled` rather than being deleted, because turning a header off to
 * see whether it is load-bearing — and turning it straight back on — is most of
 * what anyone does with a header list while testing an endpoint.
 */
export type HeaderRow = { name: string; value: string; enabled: boolean };

/** User-supplied edits to an endpoint, kept apart from what the document said. */
export type EndpointOverrides = {
  url?: string;
  headers?: HeaderRow[];
  body?: string | null;
  method?: string;
  /** Which of the document's environments to send to. */
  environment?: string;
};

/** The document's own headers, as editor rows. */
export function toHeaderRows(headers: HeaderPair[]): HeaderRow[] {
  return headers.map(([name, value]) => ({ name, value, enabled: true }));
}

/** Editor rows as they go on the wire: enabled and named only. */
export function fromHeaderRows(rows: HeaderRow[]): HeaderPair[] {
  return rows
    .filter((row) => row.enabled && row.name.trim().length > 0)
    .map((row) => [row.name.trim(), row.value] as HeaderPair);
}

/**
 * Replaces `{{name}}`, `{name}` and `:name` with the reader's values.
 *
 * All three forms because they all appear: Postman writes `{{name}}`, these
 * documents write `{name}` in paths, and OpenAPI-ish prose writes `:name`. A
 * name with no value is left exactly as it was rather than being blanked, so an
 * unfilled placeholder stays visible instead of silently producing `/orders//`.
 */
export function substitute(text: string, values: Map<string, string>): string {
  if (values.size === 0) return text;

  return text
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) => values.get(name) ?? whole)
    .replace(/\{\s*([\w.-]+)\s*\}/g, (whole, name: string) => values.get(name) ?? whole)
    .replace(/(?<=\/):([A-Za-z_][\w-]*)/g, (whole, name: string) => values.get(name) ?? whole);
}

function valueMap(variables: Variable[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const variable of variables) {
    // An empty value is not a substitution — leaving the placeholder in place
    // is what makes "you have not filled this in" visible.
    if (variable.value.length > 0) values.set(variable.key, variable.value);
  }
  return values;
}

/**
 * The endpoint as it will actually be sent: overrides applied, then variables.
 *
 * Order matters. Overrides are what the reader typed into the fields, and may
 * themselves contain `{{placeholders}}` they expect to be filled from the
 * variables panel.
 */
export function resolveEndpoint(
  endpoint: ParsedEndpoint,
  variables: Variable[],
  overrides: EndpointOverrides = {},
): { method: string; url: string; headers: HeaderPair[]; body: string | null } {
  const values = valueMap(variables);

  let url = overrides.url ?? endpoint.url;

  // Switching environment swaps the origin and keeps the path, which is what a
  // document listing Staging and Production means by them.
  if (overrides.environment) {
    const environment = endpoint.environments.find(
      (candidate) => candidate.name === overrides.environment,
    );
    if (environment) url = swapOrigin(url, environment.url);
  }

  const headers = overrides.headers
    ? fromHeaderRows(overrides.headers)
    : endpoint.headers;
  const body = overrides.body !== undefined ? overrides.body : endpoint.body;

  return {
    method: (overrides.method ?? endpoint.method).toUpperCase(),
    url: substitute(url, values),
    headers: headers.map(
      ([name, value]) => [name, substitute(value, values)] as HeaderPair,
    ),
    body: body === null ? null : substitute(body, values),
  };
}

/**
 * Replaces the origin (and any base path) of a URL with another environment's.
 *
 * The environment URL in these documents is a base — `https://host/v1` — so its
 * path is a prefix, not a replacement for the endpoint's own path.
 */
function swapOrigin(url: string, base: string): string {
  try {
    const target = new URL(url);
    const replacement = new URL(base);
    const basePath = replacement.pathname.replace(/\/+$/, '');
    // Avoid doubling the base path when it is already there.
    const path = target.pathname.startsWith(basePath)
      ? target.pathname
      : `${basePath}${target.pathname}`;
    return `${replacement.origin}${path}${target.search}`;
  } catch {
    return url;
  }
}

/**
 * A `RequestRecord` standing in for a documented endpoint.
 *
 * Fields that only mean something for a capture — timings, the filter verdict,
 * the response that came back — are filled with neutral values rather than
 * invented ones. The documented response goes into `responseBody` on purpose:
 * that is what `replay` compares a real response's shape against, so a run can
 * report "the shape matches what the document said" for free.
 */
export function toRequestRecord(
  endpoint: ParsedEndpoint,
  variables: Variable[] = [],
  overrides: EndpointOverrides = {},
): RequestRecord {
  const resolved = resolveEndpoint(endpoint, variables, overrides);

  let parsed: URL | null = null;
  try {
    parsed = new URL(resolved.url);
  } catch {
    /* an unfilled placeholder can leave the URL unparseable; keep the raw text */
  }

  return {
    id: endpoint.id,
    sessionId: '',
    seq: endpoint.position + 1,
    url: resolved.url,
    method: resolved.method,
    host: parsed?.host ?? '',
    path: parsed?.pathname ?? resolved.url,
    query: parsed?.search ?? '',
    shortName: endpoint.name,
    resourceType: 'Fetch',
    requestHeaders: resolved.headers,
    requestBody: resolved.body
      ? { encoding: 'text', data: resolved.body, truncated: false }
      : null,
    status: null,
    statusText: '',
    responseHeaders: [],
    mimeType: endpoint.bodyMime,
    responseBody: endpoint.documentedResponse
      ? { encoding: 'text', data: endpoint.documentedResponse, truncated: false }
      : null,
    responseSize: 0,
    startedAt: 0,
    endedAt: null,
    durationMs: null,
    redirectChain: [],
    error: null,
    verdict: { keep: true, reason: 'documented', score: 100 },
    approved: true,
    actionGroup: endpoint.section.at(-1) ?? null,
    title: endpoint.name,
    orderIndex: endpoint.position,
  };
}

/**
 * Placeholders still unfilled in what is about to be sent.
 *
 * Surfaced before a run rather than after it: a 404 from `/orders/{bookingId}`
 * looks like a broken endpoint, and is not.
 */
export function unresolvedPlaceholders(
  endpoint: ParsedEndpoint,
  variables: Variable[],
  overrides: EndpointOverrides = {},
): string[] {
  const resolved = resolveEndpoint(endpoint, variables, overrides);
  const haystack = [
    resolved.url,
    ...resolved.headers.map(([, value]) => value),
    resolved.body ?? '',
  ].join('\n');

  const names = new Set<string>();
  for (const match of haystack.matchAll(/\{\{?\s*([\w.-]+)\s*\}?\}/g)) names.add(match[1]);
  return [...names];
}
