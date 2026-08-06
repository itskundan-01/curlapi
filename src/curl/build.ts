import type { CurlOptions, HeaderPair, RequestRecord } from '../types.ts';
import { escapeFor, escapeUrlGlobs } from './escape.ts';

/**
 * Headers curl derives or manages itself. Emitting these produces a command that
 * either fails or misbehaves:
 *
 *  - `accept-encoding` makes the server return brotli/gzip that curl will not
 *    decode unless `--compressed` is also passed, so the terminal fills with
 *    binary garbage. Chrome omits it for the same reason.
 *  - `content-length` goes stale the moment anyone edits the body.
 *  - `host`, `connection`, `transfer-encoding` and `expect` are transport-level.
 *  - HTTP/2 pseudo-headers arrive from CDP with a leading colon and are not real
 *    headers at all.
 */
const CURL_MANAGED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'expect',
  'method',
  'path',
  'scheme',
  'version',
  'authority',
  'protocol',
]);

/** Browser-fingerprinting headers stripped only when the user asks for a clean curl. */
const NOISE_HEADER_PREFIXES = ['sec-ch-', 'sec-fetch-'];
const NOISE_HEADERS = new Set([
  'sec-ch-ua',
  'priority',
  'dnt',
  'upgrade-insecure-requests',
  'pragma',
  'cache-control',
  'accept-language',
]);

const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'x-apikey',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-access-token',
  'proxy-authorization',
]);

function isNoiseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (NOISE_HEADERS.has(lower)) return true;
  return NOISE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Replaces a secret with a placeholder while preserving any scheme prefix. */
function redactValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  const variable = `{{${lower.replace(/[^a-z0-9]+/g, '_')}}}`;
  const schemeMatch = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value);
  if (schemeMatch) return `${schemeMatch[1]} ${variable}`;
  return variable;
}

/**
 * Chrome's HTTP/2 stack hands headers to DevTools in sorted order, which is why
 * a copied command lists them alphabetically. We store headers in wire order for
 * fidelity of capture and sort here, at render time, to match that output.
 */
function sortHeaders(headers: HeaderPair[]): HeaderPair[] {
  return [...headers].sort((a, b) =>
    a[0].toLowerCase().localeCompare(b[0].toLowerCase(), 'en'),
  );
}

export function selectHeaders(headers: HeaderPair[], options: CurlOptions): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (const [rawName, value] of headers) {
    // CDP reports HTTP/2 pseudo-headers with a leading colon.
    const name = rawName.replace(/^:/, '');
    const lower = name.toLowerCase();
    if (CURL_MANAGED_HEADERS.has(lower)) continue;
    if (options.clean && isNoiseHeader(lower)) continue;
    const finalValue =
      options.redact && SECRET_HEADERS.has(lower) ? redactValue(lower, value) : value;
    out.push([name, finalValue]);
  }
  return sortHeaders(out);
}

function bodyArgument(record: RequestRecord, options: CurlOptions): string[] {
  const body = record.requestBody;
  if (!body) return [];

  if (body.encoding === 'base64') {
    // Inlining arbitrary bytes into a shell command is not reliably round-trippable,
    // so point at a file the user can dump instead of silently corrupting the payload.
    return [`--data-binary @${record.shortName || 'request'}.bin`];
  }

  if (body.entries && body.entries.length > 0) {
    return body.entries.map((entry) => `-F ${escapeFor(options.shell, entry)}`);
  }

  return [`--data-raw ${escapeFor(options.shell, body.data)}`];
}

/** True when the captured response body arrived compressed. */
function servedCompressed(record: RequestRecord): boolean {
  return record.responseHeaders.some(
    ([name, value]) =>
      name.toLowerCase() === 'content-encoding' &&
      value.trim().length > 0 &&
      value.trim().toLowerCase() !== 'identity',
  );
}

/**
 * Renders a request as a runnable curl command.
 *
 * Argument order matches Chrome: URL, then an explicit method only when it
 * cannot be inferred, then headers, then the body.
 */
export function buildCurl(record: RequestRecord, options: CurlOptions): string {
  // The URL rides on the same line as `curl`; every later argument gets its own.
  const parts: string[] = [`curl ${escapeUrlGlobs(escapeFor(options.shell, record.url))}`];

  const body = bodyArgument(record, options);

  // curl infers POST from the presence of a data flag, exactly as Chrome assumes.
  const inferredMethod = body.length > 0 ? 'POST' : 'GET';
  if (record.method.toUpperCase() !== inferredMethod) {
    parts.push(`-X ${escapeFor(options.shell, record.method.toUpperCase())}`);
  }

  for (const [name, value] of selectHeaders(record.requestHeaders, options)) {
    parts.push(`-H ${escapeFor(options.shell, `${name}: ${value}`)}`);
  }

  parts.push(...body);

  // Some servers compress whether or not the client asked. Since `accept-encoding`
  // is dropped above, curl would not know to decompress and the terminal fills
  // with gzip bytes. The capture already tells us which servers do this, so the
  // flag is added only where it is actually needed — everything else stays
  // byte-identical to what DevTools would have produced.
  if (servedCompressed(record)) parts.push('--compressed');

  if (options.singleLine) return parts.join(' ');

  const continuation = options.shell === 'powershell' ? ' `' : ' \\';
  return parts
    .map((part, index) => (index === 0 ? part : '  ' + part))
    .join(continuation + '\n');
}

/** Collects the secrets a redacted command leaves behind, for env/Postman export. */
export function extractSecrets(record: RequestRecord): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of record.requestHeaders) {
    const lower = name.toLowerCase().replace(/^:/, '');
    if (!SECRET_HEADERS.has(lower)) continue;
    const key = lower.replace(/[^a-z0-9]+/g, '_');
    const schemeMatch = /^(Bearer|Basic|Token|Digest)\s+(.*)$/is.exec(value);
    secrets[key] = schemeMatch ? schemeMatch[2] : value;
  }
  return secrets;
}
