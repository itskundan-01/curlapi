/**
 * The small readings every extractor needs: is this a method, a URL, a header,
 * a body? Kept in one place because the answers have to agree — an extractor
 * that recognises `Api-Key: abc` as a header while another treats it as prose
 * produces two different endpoints from the same document.
 */

import type { HeaderPair } from '../../../types.ts';
import { normalizeText, squash } from '../normalize.ts';

export const METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

const METHOD_SET = new Set<string>(METHODS);

export function isMethod(value: string): boolean {
  return METHOD_SET.has(squash(value).toUpperCase());
}

/** The HTTP method mentioned in a piece of text, if exactly one is. */
export function findMethod(text: string): string | null {
  const found = new Set<string>();
  for (const match of squash(text).toUpperCase().matchAll(/\b([A-Z]+)\b/g)) {
    if (METHOD_SET.has(match[1])) found.add(match[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Matches a URL, including the `{placeholder}` segments documents use for path
 * parameters — which a stricter pattern would cut the URL short at.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\)\]]+/gi;

export function findUrls(text: string): string[] {
  const urls = normalizeText(text).match(URL_PATTERN) ?? [];
  return urls.map(trimTrailingPunctuation);
}

export function findUrl(text: string): string | null {
  return findUrls(text)[0] ?? null;
}

/**
 * Removes sentence punctuation a URL picked up from the prose around it.
 *
 * Closing brackets are only stripped when unbalanced, so a genuine
 * `…/order-status/{bookingId}` keeps its brace.
 */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (!last) break;
    if ('.,;:'.includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ')' && count(out, '(') < count(out, ')')) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === '}' && count(out, '{') < count(out, '}')) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

function count(haystack: string, needle: string): number {
  let total = 0;
  for (const char of haystack) if (char === needle) total++;
  return total;
}

/**
 * Header names that carry credentials.
 *
 * Used to mark values as secret so an export can lift them into variables
 * rather than baking a department's live key into every request in a collection
 * that then gets emailed around.
 */
const SECRET_HEADERS =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|auth-token|token|activation[_-]?key|x-access-token|access[_-]?token|client[_-]?secret|secret[_-]?key)$/i;

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADERS.test(name.trim());
}

/** A header name as HTTP allows it — no spaces, no colon. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isHeaderName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && name.length <= 64 && HEADER_NAME.test(name);
}

/**
 * Reads header lines out of a block of text.
 *
 * Handles the three forms the samples use:
 *   `Accept: * / *`                          — the plain form
 *   `Content-Type:application/json`           — no space after the colon
 *   `key - X-Api-Key` / `Value - <the value>` — name and value on separate lines
 *
 * The third only appears in a "pass these keys in the header" section, so it is
 * handled by the caller that knows it is in one; here we take colon-separated
 * pairs and reject anything that is plainly a sentence.
 */
export function parseHeaderLines(text: string): HeaderPair[] {
  const headers: HeaderPair[] = [];
  for (const rawLine of normalizeText(text).split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const colon = line.indexOf(':');
    if (colon <= 0) continue;

    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!isHeaderName(name) || value.length === 0) continue;

    headers.push([name, value]);
  }
  return headers;
}

/** True when the cell says there is nothing rather than holding a value. */
export function isEmptyMarker(text: string): boolean {
  const value = squash(text).toLowerCase().replace(/[.!]$/, '');
  return (
    value.length === 0 ||
    value === 'n/a' ||
    value === 'na' ||
    value === 'none' ||
    value === '-' ||
    value === 'nil' ||
    /^no\s+(request\s+)?(body|parameter|payload|header)s?(\s+required)?$/.test(value) ||
    /^not\s+(required|applicable)$/.test(value)
  );
}

/**
 * A body's content type, from an explicit header or from the body itself.
 *
 * Guessing is worth it: a request sent without a content type is rejected by
 * most of the APIs these documents describe, and the document usually implies
 * JSON by writing JSON rather than by saying so.
 */
export function inferMime(body: string | null, headers: HeaderPair[]): string {
  const declared = headers.find(([name]) => name.toLowerCase() === 'content-type');
  if (declared) return declared[1].split(';')[0].trim();
  if (!body) return '';

  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'application/json';
  if (trimmed.startsWith('<')) return 'application/xml';
  if (/^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(trimmed)) {
    return 'application/x-www-form-urlencoded';
  }
  return 'text/plain';
}

/**
 * Pretty-prints a JSON body, or returns it untouched.
 *
 * Documents wrap bodies to fit a table cell, so what arrives is JSON with the
 * line breaks in arbitrary places. Reformatting makes it readable and — more
 * usefully — proves it parses, which is how a smart-quote left in the text gets
 * noticed before someone tries to run it.
 */
export function tidyJson(body: string): { text: string; valid: boolean } {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { text: trimmed, valid: false };
  }
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), valid: true };
  } catch {
    return { text: trimmed, valid: false };
  }
}
