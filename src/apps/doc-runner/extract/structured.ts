/**
 * Documents that are already machine-readable: a Postman collection, or an
 * OpenAPI description.
 *
 * These skip the extractors entirely. Flattening a collection into paragraphs so
 * the guessing could start again would throw away everything it states outright,
 * and guess wrong about some of it. Teams that already have one of these should
 * get a perfect import, not a good one.
 */

import { randomUUID } from 'node:crypto';
import type { HeaderPair } from '../../../types.ts';
import type { DocParam, ParsedEndpoint, ParseResult, ResponseCode, Variable } from '../types.ts';
import { inferMime } from './shared.ts';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Which importer, if any, recognises this payload. */
export function detectStructured(data: unknown): 'postman' | 'openapi' | null {
  if (!isObject(data)) return null;
  if (isObject(data['info']) && Array.isArray(data['item'])) return 'postman';
  if (typeof data['swagger'] === 'string' || typeof data['openapi'] === 'string') {
    return 'openapi';
  }
  return null;
}

export function importStructured(data: unknown): ParseResult {
  const kind = detectStructured(data);
  if (kind === 'postman') return importPostman(data as Json);
  if (kind === 'openapi') return importOpenApi(data as Json);
  throw new Error(
    'That JSON file is neither a Postman collection nor an OpenAPI description. ' +
      'If it is an API document, export it as Word or Markdown instead.',
  );
}

// --- Postman ---------------------------------------------------------------

function importPostman(collection: Json): ParseResult {
  const endpoints: ParsedEndpoint[] = [];
  const info = isObject(collection['info']) ? collection['info'] : {};

  /** Items nest arbitrarily deep; each level of nesting is a folder. */
  const walk = (items: unknown[], section: string[]): void => {
    for (const raw of items) {
      if (!isObject(raw)) continue;
      const name = asString(raw['name']);

      if (Array.isArray(raw['item'])) {
        walk(raw['item'], [...section, name]);
        continue;
      }

      const request = isObject(raw['request']) ? raw['request'] : null;
      if (!request) continue;

      const url = postmanUrl(request['url']);
      if (!url) continue;

      const headers: HeaderPair[] = [];
      if (Array.isArray(request['header'])) {
        for (const header of request['header']) {
          if (!isObject(header)) continue;
          if (header['disabled'] === true) continue;
          const key = asString(header['key']);
          if (key) headers.push([key, asString(header['value'])]);
        }
      }

      const body = postmanBody(request['body']);

      endpoints.push({
        id: randomUUID(),
        position: endpoints.length,
        name: name || url,
        section,
        method: (asString(request['method']) || 'GET').toUpperCase(),
        url,
        environments: [],
        headers,
        body,
        bodyMime: inferMime(body, headers),
        documentedResponse: postmanExample(raw['response']),
        responseCodes: postmanResponseCodes(raw['response']),
        params: postmanParams(request['url']),
        description: asString(request['description']),
        notes: [],
        provenance: { extractor: 'postman', confidence: 1, blocks: [] },
        warnings: [],
      });
    }
  };

  walk(Array.isArray(collection['item']) ? collection['item'] : [], []);

  // A collection's own variables come across as-is; they are the same idea.
  const variables: Variable[] = [];
  if (Array.isArray(collection['variable'])) {
    for (const entry of collection['variable']) {
      if (!isObject(entry)) continue;
      const key = asString(entry['key']);
      if (!key) continue;
      variables.push({
        key,
        value: asString(entry['value']),
        secret: asString(entry['type']) === 'secret',
        origin: 'manual',
      });
    }
  }

  return {
    endpoints,
    variables,
    title: asString(info['name']) || null,
    warnings: [],
    stats: { postman: endpoints.length },
  };
}

/** Postman stores a URL either as a string or as its parsed parts. */
function postmanUrl(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return null;

  const raw = asString(value['raw']);
  if (raw) return raw;

  const protocol = asString(value['protocol']) || 'https';
  const host = Array.isArray(value['host']) ? value['host'].map(asString).join('.') : '';
  const path = Array.isArray(value['path']) ? value['path'].map(asString).join('/') : '';
  if (!host) return null;
  return `${protocol}://${host}${path ? `/${path}` : ''}`;
}

function postmanBody(value: unknown): string | null {
  if (!isObject(value)) return null;
  const mode = asString(value['mode']);
  if (mode === 'raw') return asString(value['raw']) || null;
  if (mode === 'urlencoded' && Array.isArray(value['urlencoded'])) {
    const pairs = value['urlencoded']
      .filter(isObject)
      .filter((entry) => entry['disabled'] !== true)
      .map(
        (entry) =>
          `${encodeURIComponent(asString(entry['key']))}=` +
          encodeURIComponent(asString(entry['value'])),
      );
    return pairs.length > 0 ? pairs.join('&') : null;
  }
  return null;
}

/** The first saved example, which is what the collection documents. */
function postmanExample(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (isObject(entry) && typeof entry['body'] === 'string') return entry['body'];
  }
  return null;
}

function postmanResponseCodes(value: unknown): ResponseCode[] {
  if (!Array.isArray(value)) return [];
  const codes: ResponseCode[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const code = entry['code'];
    if (typeof code !== 'number') continue;
    codes.push({ code: String(code), description: asString(entry['status']) });
  }
  return codes;
}

function postmanParams(value: unknown): DocParam[] {
  if (!isObject(value)) return [];
  const params: DocParam[] = [];

  if (Array.isArray(value['query'])) {
    for (const entry of value['query']) {
      if (!isObject(entry) || entry['disabled'] === true) continue;
      const key = asString(entry['key']);
      if (!key) continue;
      params.push({
        name: key,
        in: 'query',
        description: asString(entry['description']),
        dataType: '',
        expected: asString(entry['value']),
        required: false,
      });
    }
  }

  if (Array.isArray(value['variable'])) {
    for (const entry of value['variable']) {
      if (!isObject(entry)) continue;
      const key = asString(entry['key']);
      if (!key) continue;
      params.push({
        name: key,
        in: 'path',
        description: asString(entry['description']),
        dataType: '',
        expected: asString(entry['value']),
        required: true,
      });
    }
  }

  return params;
}

// --- OpenAPI ---------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function importOpenApi(document: Json): ParseResult {
  const endpoints: ParsedEndpoint[] = [];
  const paths = isObject(document['paths']) ? document['paths'] : {};
  const baseUrl = openApiBaseUrl(document);
  const warnings: string[] = [];

  if (!baseUrl) {
    warnings.push(
      'This description declares no server URL, so paths are relative. Set a ' +
        'base URL variable before running anything.',
    );
  }

  for (const [path, rawItem] of Object.entries(paths)) {
    if (!isObject(rawItem)) continue;

    for (const method of HTTP_METHODS) {
      const operation = rawItem[method];
      if (!isObject(operation)) continue;

      // Parameters are inheritable from the path item.
      const merged = [
        ...(Array.isArray(rawItem['parameters']) ? rawItem['parameters'] : []),
        ...(Array.isArray(operation['parameters']) ? operation['parameters'] : []),
      ];

      const params: DocParam[] = [];
      const headers: HeaderPair[] = [];
      const query = new URLSearchParams();

      for (const raw of merged) {
        if (!isObject(raw)) continue;
        const name = asString(raw['name']);
        if (!name) continue;
        const where = asString(raw['in']);
        const schema = isObject(raw['schema']) ? raw['schema'] : {};
        const example = raw['example'] ?? schema['example'] ?? schema['default'];
        const value = example === undefined ? '' : String(example);

        if (where === 'header') {
          headers.push([name, value]);
        } else if (where === 'query') {
          // Only required parameters go into the URL — an example carrying every
          // optional filter is a worse starting point than a minimal one.
          if (raw['required'] === true) query.set(name, value);
        }

        params.push({
          name,
          in: where === 'path' ? 'path' : where === 'header' ? 'header' : 'query',
          description: asString(raw['description']),
          dataType: asString(schema['type']),
          expected: value,
          required: raw['required'] === true,
        });
      }

      const { body, mime } = openApiBody(operation['requestBody']);
      if (mime) headers.push(['Content-Type', mime]);

      const search = query.toString();
      endpoints.push({
        id: randomUUID(),
        position: endpoints.length,
        name: asString(operation['summary']) || asString(operation['operationId']) || path,
        section: Array.isArray(operation['tags'])
          ? operation['tags'].map(asString).filter(Boolean)
          : [],
        method: method.toUpperCase(),
        url: `${baseUrl}${path}${search ? `?${search}` : ''}`,
        environments: openApiEnvironments(document),
        headers,
        body,
        bodyMime: mime,
        documentedResponse: openApiExample(operation['responses']),
        responseCodes: openApiCodes(operation['responses']),
        params,
        description: asString(operation['description']),
        notes: [],
        provenance: { extractor: 'openapi', confidence: 1, blocks: [] },
        warnings: [],
      });
    }
  }

  return {
    endpoints,
    variables: [],
    title: isObject(document['info']) ? asString(document['info']['title']) || null : null,
    warnings,
    stats: { openapi: endpoints.length },
  };
}

function openApiBaseUrl(document: Json): string {
  if (Array.isArray(document['servers'])) {
    const first = document['servers'].find(isObject);
    if (first) return asString(first['url']).replace(/\/+$/, '');
  }
  // Swagger 2 spelled it out in three fields.
  const host = asString(document['host']);
  if (host) {
    const schemes = Array.isArray(document['schemes']) ? document['schemes'].map(asString) : [];
    const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
    return `${scheme}://${host}${asString(document['basePath']).replace(/\/+$/, '')}`;
  }
  return '';
}

function openApiEnvironments(document: Json): Array<{ name: string; url: string }> {
  if (!Array.isArray(document['servers'])) return [];
  return document['servers']
    .filter(isObject)
    .map((server) => ({
      name: asString(server['description']) || asString(server['url']),
      url: asString(server['url']).replace(/\/+$/, ''),
    }))
    .filter((server) => server.url.length > 0);
}

function openApiBody(requestBody: unknown): { body: string | null; mime: string } {
  if (!isObject(requestBody)) return { body: null, mime: '' };
  const content = isObject(requestBody['content']) ? requestBody['content'] : {};

  // JSON first when it is on offer; it is what a reader can edit by hand.
  const entries = Object.entries(content);
  const chosen =
    entries.find(([type]) => type.includes('json')) ?? entries[0] ?? null;
  if (!chosen) return { body: null, mime: '' };

  const [mime, media] = chosen;
  if (!isObject(media)) return { body: null, mime };

  const example =
    media['example'] ??
    (isObject(media['examples'])
      ? Object.values(media['examples']).find(isObject)?.['value']
      : undefined) ??
    (isObject(media['schema']) ? sampleFromSchema(media['schema']) : undefined);

  if (example === undefined) return { body: null, mime };
  return {
    body: typeof example === 'string' ? example : JSON.stringify(example, null, 2),
    mime,
  };
}

/**
 * A minimal example payload from a schema.
 *
 * A body of `{}` is not runnable and not informative; one with every declared
 * property present, holding its type's placeholder, tells the reader what to
 * fill in. Recursion is bounded because `$ref` cycles are legal and common.
 */
function sampleFromSchema(schema: Json, depth = 0): unknown {
  if (depth > 4) return null;
  const type = asString(schema['type']);

  if (schema['example'] !== undefined) return schema['example'];
  if (schema['default'] !== undefined) return schema['default'];
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) return schema['enum'][0];

  if (type === 'object' || isObject(schema['properties'])) {
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    const out: Json = {};
    for (const [name, child] of Object.entries(properties)) {
      if (isObject(child)) out[name] = sampleFromSchema(child, depth + 1);
    }
    return out;
  }

  if (type === 'array') {
    const items = isObject(schema['items']) ? sampleFromSchema(schema['items'], depth + 1) : null;
    return [items];
  }

  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  return '';
}

function openApiExample(responses: unknown): string | null {
  if (!isObject(responses)) return null;
  for (const [code, response] of Object.entries(responses)) {
    if (!code.startsWith('2') || !isObject(response)) continue;
    const content = isObject(response['content']) ? response['content'] : {};
    for (const media of Object.values(content)) {
      if (!isObject(media)) continue;
      const example =
        media['example'] ??
        (isObject(media['examples'])
          ? Object.values(media['examples']).find(isObject)?.['value']
          : undefined) ??
        (isObject(media['schema']) ? sampleFromSchema(media['schema']) : undefined);
      if (example !== undefined) {
        return typeof example === 'string' ? example : JSON.stringify(example, null, 2);
      }
    }
  }
  return null;
}

function openApiCodes(responses: unknown): ResponseCode[] {
  if (!isObject(responses)) return [];
  return Object.entries(responses).map(([code, response]) => ({
    code,
    description: isObject(response) ? asString(response['description']) : '',
  }));
}
