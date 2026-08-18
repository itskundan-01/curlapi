/**
 * The Postman Collection v2.1 format, written once for the whole workspace.
 *
 * Both utilities export collections, and until now each built the JSON by hand
 * from its own idea of the format. That drifted: one emitted `type: "secret"`
 * for a variable (the schema allows only string/boolean/any/number), and both
 * dropped the port out of the URL object, so a capture from `localhost:8080`
 * imported as `localhost`. Neither is visible until somebody opens Postman.
 *
 * Everything here is checked against the published schema —
 * https://schema.postman.com/json/collection/v2.1.0/collection.json — which is
 * vendored into test/fixtures and validated in test/postman.test.ts, so a change
 * that would fail to import fails the test suite first.
 *
 * Two rules the format does not state but Postman's behaviour requires:
 *
 * - A URL is split into parts *and* kept raw. Postman shows the raw string but
 *   edits the parts, so a request whose parts disagree with its raw URL is one
 *   the user cannot correct in the UI.
 * - A body on a GET/HEAD/DELETE is pruned before sending unless the item asks
 *   for it to be kept. Documents do describe GETs with bodies, so the request
 *   would silently go out empty.
 */

export type PostmanHeader = {
  key: string;
  value: string;
  disabled?: boolean;
  description?: string;
};

export type PostmanQueryParam = {
  key: string;
  value: string | null;
  disabled?: boolean;
  description?: string;
};

/** The schema's enum. `secret` is a Postman product concept, not a format one. */
export type PostmanVariableType = 'string' | 'boolean' | 'number' | 'any';

export type PostmanVariable = {
  key: string;
  value: string;
  type?: PostmanVariableType;
  description?: string;
  disabled?: boolean;
};

export type PostmanUrl = {
  raw: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: PostmanQueryParam[];
  hash?: string;
  variable?: PostmanVariable[];
};

export type PostmanFormParam =
  | { key: string; value: string; type: 'text'; disabled?: boolean; description?: string }
  | { key: string; src: null; type: 'file'; disabled?: boolean; description?: string };

export type PostmanBody =
  | { mode: 'raw'; raw: string; options?: { raw: { language: string } } }
  | { mode: 'urlencoded'; urlencoded: PostmanQueryParam[] }
  | { mode: 'formdata'; formdata: PostmanFormParam[] };

export type PostmanRequest = {
  method: string;
  header: PostmanHeader[];
  url: PostmanUrl;
  body?: PostmanBody;
  description?: string;
};

export type PostmanResponse = {
  name: string;
  originalRequest: PostmanRequest;
  status: string;
  code: number;
  header: PostmanHeader[];
  body: string;
  _postman_previewlanguage?: string;
};

export type PostmanItem = {
  name: string;
  request: PostmanRequest;
  response: PostmanResponse[];
  description?: string;
  protocolProfileBehavior?: { disableBodyPruning?: boolean };
};

export type PostmanFolder = {
  name: string;
  item: PostmanNode[];
  description?: string;
};

export type PostmanNode = PostmanItem | PostmanFolder;

export type PostmanCollection = {
  info: {
    _postman_id?: string;
    name: string;
    description?: string;
    schema: string;
  };
  item: PostmanNode[];
  variable?: PostmanVariable[];
};

export const COLLECTION_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** The methods Postman lists explicitly. Anything else is legal but custom. */
export const POSTMAN_METHODS = new Set([
  'GET',
  'PUT',
  'POST',
  'PATCH',
  'DELETE',
  'COPY',
  'HEAD',
  'OPTIONS',
  'LINK',
  'UNLINK',
  'PURGE',
  'LOCK',
  'UNLOCK',
  'PROPFIND',
  'VIEW',
]);

/**
 * Splits a URL without decoding any part of it.
 *
 * `new URL()` is the obvious tool and the wrong one here. It percent-encodes the
 * `{bookingId}` placeholders documents are full of, turns `+` into a space when
 * reading query values back out, and rejects a URL that starts with `{{baseUrl}}`
 * outright. Every one of those is a URL we are specifically trying to carry
 * across intact, so the string is taken apart literally instead.
 */
const URL_PATTERN =
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

export type UrlAnnotations = {
  /** Describes a query or path parameter, when the source knows anything about it. */
  describe?: (name: string, kind: 'query' | 'path') => string | undefined;
  /** A starting value for a `:pathVariable`, so the request is runnable as imported. */
  pathValue?: (name: string) => string | undefined;
};

export function postmanUrl(raw: string, annotations: UrlAnnotations = {}): PostmanUrl {
  const match = URL_PATTERN.exec(raw.trim());

  // A relative URL, or one built entirely from variables. Postman accepts the
  // raw string on its own and shows it for editing, which is the best available
  // answer — parts invented here would only disagree with it.
  if (!match) return { raw: raw.trim() };

  const [, protocol, authority, pathname, search, hash] = match;
  const url: PostmanUrl = { raw: raw.trim(), protocol: protocol.toLowerCase() };

  // Credentials in the authority belong to the request, not the host.
  const hostPort = authority.includes('@') ? authority.slice(authority.indexOf('@') + 1) : authority;

  let host = hostPort;
  let port = '';
  if (hostPort.startsWith('[')) {
    // IPv6 literal: the colons inside the brackets are not a port separator.
    const close = hostPort.indexOf(']');
    host = hostPort.slice(0, close + 1);
    if (hostPort[close + 1] === ':') port = hostPort.slice(close + 2);
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
    }
  }

  if (host) url.host = host.includes('.') && !host.startsWith('[') ? host.split('.') : [host];
  if (port) url.port = port;

  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0) url.path = segments;

  if (search !== undefined && search.length > 0) {
    url.query = search.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? null : pair.slice(eq + 1);
      const description = annotations.describe?.(key, 'query');
      return { key, value, ...(description ? { description } : {}) };
    });
  }

  if (hash !== undefined && hash.length > 0) url.hash = hash;

  // `:name` segments are what makes Postman show the path-variable editor. They
  // have to be declared as well as appear in the path, or the editor is empty.
  const variables: PostmanVariable[] = [];
  for (const segment of segments) {
    if (!segment.startsWith(':') || segment.length < 2) continue;
    const name = segment.slice(1);
    if (variables.some((variable) => variable.key === name)) continue;
    const description = annotations.describe?.(name, 'path');
    variables.push({
      key: name,
      value: annotations.pathValue?.(name) ?? '',
      ...(description ? { description } : {}),
    });
  }
  if (variables.length > 0) url.variable = variables;

  return url;
}

/** Postman's syntax-highlighting hint for a body or a saved example. */
export function bodyLanguage(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('xml')) return 'xml';
  if (lower.includes('html')) return 'html';
  if (lower.includes('javascript')) return 'javascript';
  return 'text';
}

/** The `boundary=...` parameter, which is the only way to split a multipart body. */
function boundaryOf(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Reads a multipart body back into fields — but only when every part is a plain
 * text field.
 *
 * A file part cannot be reconstructed: the bytes are in the capture, not on the
 * user's disk, and emitting it as a text field would send the file's contents as
 * a string. Those bodies stay raw, where the boundary in the Content-Type header
 * still matches what is being sent and the request works exactly as captured.
 */
function parseMultipart(raw: string, boundary: string): PostmanFormParam[] | null {
  // Without the terminator the body was cut short somewhere, and splitting it
  // would quietly drop whatever part was in flight — an export that looks
  // complete and sends one field fewer than the capture did.
  if (!raw.includes(`--${boundary}--`)) return null;

  const parts = raw.split(`--${boundary}`).slice(1, -1);
  if (parts.length === 0) return null;

  const fields: PostmanFormParam[] = [];
  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    if (split === -1) return null;
    const headerText = part.slice(0, split);
    const separator = part.slice(split, split + 4) === '\r\n\r\n' ? 4 : 2;
    const value = part.slice(split + separator).replace(/\r?\n$/, '');

    const disposition = /content-disposition:[^\n]*/i.exec(headerText)?.[0] ?? '';
    if (/filename\s*=/i.test(disposition)) return null;
    const name = /name=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition);
    if (!name) return null;

    fields.push({ key: name[1] ?? name[2], value, type: 'text' });
  }

  return fields;
}

export type BodyInput = {
  /** The payload as text. Binary payloads have no representation here. */
  raw: string;
  contentType: string;
};

/**
 * Chooses the body mode Postman would have chosen.
 *
 * Form bodies land in the editors that own them (a key/value table rather than
 * one long percent-encoded string), because the point of the export is that
 * somebody can change a field and re-send it. Everything else stays raw, which
 * is always byte-accurate.
 */
export function postmanBody(input: BodyInput): PostmanBody | undefined {
  const { raw, contentType } = input;
  if (raw.length === 0) return undefined;

  const lower = contentType.toLowerCase();

  if (lower.includes('x-www-form-urlencoded')) {
    const pairs = raw
      .split('&')
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const eq = pair.indexOf('=');
        // The editor holds decoded text and re-encodes on send, so a value that
        // arrives encoded has to be decoded here or it is encoded twice.
        return {
          key: safeDecode(eq === -1 ? pair : pair.slice(0, eq)),
          value: eq === -1 ? '' : safeDecode(pair.slice(eq + 1)),
        };
      });
    if (pairs.length > 0) return { mode: 'urlencoded', urlencoded: pairs };
  }

  if (lower.includes('multipart/form-data')) {
    const boundary = boundaryOf(contentType);
    const fields = boundary ? parseMultipart(raw, boundary) : null;
    if (fields && fields.length > 0) return { mode: 'formdata', formdata: fields };
  }

  return { mode: 'raw', raw, options: { raw: { language: bodyLanguage(contentType) } } };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // A stray `%` is not an escape. Better the literal text than an exception.
    return value;
  }
}

/**
 * Postman drops the body of a GET, HEAD or DELETE unless told not to.
 *
 * Handed-over documents describe those requests with bodies more often than they
 * should, and a request that silently sends nothing is worse than one that fails
 * loudly — so where a body exists, it is kept.
 */
export function bodyPruningBehavior(
  method: string,
  body: PostmanBody | undefined,
): { disableBodyPruning: true } | undefined {
  if (!body) return undefined;
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'DELETE' || upper === 'OPTIONS'
    ? { disableBodyPruning: true }
    : undefined;
}

/** Drops rows the format requires to have a key, which nothing downstream checks. */
export function postmanHeaders(
  pairs: Iterable<readonly [string, string]>,
  annotate?: (name: string, value: string) => { description?: string; disabled?: boolean },
): PostmanHeader[] {
  const headers: PostmanHeader[] = [];
  for (const [name, value] of pairs) {
    const key = name.trim();
    if (key.length === 0) continue;
    // HTTP/2 pseudo-headers are set by the transport; Postman rejects them as
    // header rows and they would be a manual delete for whoever imports.
    if (key.startsWith(':')) continue;
    const extra = annotate?.(key, value) ?? {};
    headers.push({
      key,
      value: value ?? '',
      ...(extra.description ? { description: extra.description } : {}),
      ...(extra.disabled ? { disabled: true } : {}),
    });
  }
  return headers;
}

export type CollectionInput = {
  id?: string;
  name: string;
  description?: string;
  items: PostmanNode[];
  variables?: PostmanVariable[];
};

export function collection(input: CollectionInput): PostmanCollection {
  return {
    info: {
      ...(input.id ? { _postman_id: input.id } : {}),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      schema: COLLECTION_SCHEMA,
    },
    item: input.items,
    ...(input.variables && input.variables.length > 0 ? { variable: input.variables } : {}),
  };
}

/** Two spaces, because a collection is a file people read and diff. */
export function stringifyCollection(value: PostmanCollection): string {
  return JSON.stringify(value, null, 2);
}
