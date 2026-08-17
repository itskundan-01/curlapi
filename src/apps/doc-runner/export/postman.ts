/**
 * The document as a Postman collection.
 *
 * This is the artefact the whole app exists to produce. The workflow being
 * replaced is "read the Word file, retype each endpoint into Postman, run them
 * one at a time to find out which work" — so the collection has to arrive
 * complete enough that nobody opens the document again:
 *
 * - **Folders** follow the document's own headings, so the collection reads in
 *   the order the document did.
 * - **Path placeholders** become Postman path variables (`:bookingId`), which is
 *   what makes the URL bar editable rather than a string to hand-edit.
 * - **The documented response** is saved as an example, so the collection still
 *   says what the endpoint returns after the sample credentials expire.
 * - **Field descriptions** from the document's parameter tables ride along in
 *   the request description, because that is the only place they exist.
 * - **Credentials become collection variables**, so the file can be sent to
 *   somebody without sending them the department's live API key.
 */

import { randomUUID } from 'node:crypto';
import type { HeaderPair } from '../../../types.ts';
import type { ParsedEndpoint, Variable } from '../types.ts';
import { isSecretHeader } from '../extract/shared.ts';

type PostmanHeader = { key: string; value: string; description?: string };
type PostmanVariable = { key: string; value: string; description?: string; type?: string };

type PostmanUrl = {
  raw: string;
  protocol?: string;
  host?: string[];
  path?: string[];
  query?: Array<{ key: string; value: string; description?: string }>;
  variable?: PostmanVariable[];
};

type PostmanRequest = {
  method: string;
  header: PostmanHeader[];
  url: PostmanUrl;
  body?: { mode: 'raw'; raw: string; options?: { raw: { language: string } } };
  description?: string;
};

type PostmanItem = {
  name: string;
  request: PostmanRequest;
  response: unknown[];
};

type PostmanFolder = { name: string; item: Array<PostmanItem | PostmanFolder> };

export type PostmanOptions = {
  /** Lift credentials out of the requests and into collection variables. */
  useVariables: boolean;
  /** The environment to point the collection at, when the document lists any. */
  environment?: string;
};

function bodyLanguage(mime: string): string {
  if (mime.includes('json')) return 'json';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('html')) return 'html';
  return 'text';
}

/**
 * Rewrites `{placeholder}` to Postman's `:placeholder` and describes each one.
 *
 * Postman only offers the path-variable editor for the colon form, and that
 * editor is the difference between a URL somebody can fill in and one they have
 * to retype.
 */
function toPostmanUrl(endpoint: ParsedEndpoint, url: string): PostmanUrl {
  const withColons = url.replace(/\{([A-Za-z_][\w-]*)\}/g, ':$1');

  let parsed: URL | null = null;
  try {
    parsed = new URL(withColons);
  } catch {
    // An unresolvable URL still round-trips as a raw string, which Postman
    // accepts and shows for editing.
    return { raw: withColons };
  }

  const describe = (name: string): string | undefined => {
    const param = endpoint.params.find((candidate) => candidate.name === name);
    if (!param) return undefined;
    return [param.description, param.dataType && `(${param.dataType})`]
      .filter(Boolean)
      .join(' ')
      .trim() || undefined;
  };

  const query = [...parsed.searchParams.entries()].map(([key, value]) => ({
    key,
    value,
    description: describe(key),
  }));

  const pathSegments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const variables: PostmanVariable[] = [];
  for (const segment of pathSegments) {
    if (!segment.startsWith(':')) continue;
    const name = segment.slice(1);
    const param = endpoint.params.find((candidate) => candidate.name === name);
    variables.push({
      key: name,
      value: param?.expected ?? '',
      description: describe(name),
    });
  }

  return {
    raw: withColons,
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname.split('.'),
    path: pathSegments,
    ...(query.length > 0 ? { query } : {}),
    ...(variables.length > 0 ? { variable: variables } : {}),
  };
}

/**
 * Everything the document said about this endpoint, as Markdown.
 *
 * Postman renders the description panel as Markdown, so the field table and the
 * response codes survive as tables rather than as a wall of text — which is the
 * only reason to carry them across at all.
 */
function describeEndpoint(endpoint: ParsedEndpoint): string | undefined {
  const parts: string[] = [];

  if (endpoint.description) parts.push(endpoint.description);

  const requestFields = endpoint.params.filter((param) => param.in !== 'response');
  const responseFields = endpoint.params.filter((param) => param.in === 'response');

  const fieldTable = (title: string, fields: typeof endpoint.params): void => {
    if (fields.length === 0) return;
    parts.push(
      `#### ${title}\n\n` +
        '| Field | In | Type | Required | Description | Expected |\n' +
        '| --- | --- | --- | --- | --- | --- |\n' +
        fields
          .map(
            (field) =>
              `| \`${field.name}\` | ${field.in} | ${field.dataType || '—'} | ` +
              `${field.required ? 'yes' : '—'} | ${escapeCell(field.description)} | ` +
              `${escapeCell(field.expected)} |`,
          )
          .join('\n'),
    );
  };

  fieldTable('Request fields', requestFields);
  fieldTable('Response fields', responseFields);

  if (endpoint.responseCodes.length > 0) {
    parts.push(
      '#### Response codes\n\n' +
        '| Code | Meaning |\n| --- | --- |\n' +
        endpoint.responseCodes
          .map((code) => `| \`${code.code}\` | ${escapeCell(code.description)} |`)
          .join('\n'),
    );
  }

  if (endpoint.warnings.length > 0) {
    parts.push(
      '#### Check before running\n\n' +
        endpoint.warnings.map((warning) => `- ${warning}`).join('\n'),
    );
  }

  parts.push(
    `_Imported from ${endpoint.section.join(' › ') || 'the API document'} by curlapi._`,
  );

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** A pipe in a cell would end the column early. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ') || '—';
}

function toItem(
  endpoint: ParsedEndpoint,
  options: PostmanOptions,
  secrets: Map<string, string>,
): PostmanItem {
  let url = endpoint.url;
  if (options.environment) {
    const environment = endpoint.environments.find(
      (candidate) => candidate.name === options.environment,
    );
    if (environment) {
      try {
        const target = new URL(url);
        const base = new URL(environment.url);
        url = `${base.origin}${target.pathname}${target.search}`;
      } catch {
        /* leave the documented URL alone */
      }
    }
  }

  const headers: PostmanHeader[] = endpoint.headers.map(([name, value]) => {
    // The value is replaced by a reference to the collection variable holding
    // it, which is what lets the file be shared.
    if (options.useVariables && isSecretHeader(name)) {
      const key = secrets.get(value);
      if (key) return { key: name, value: `{{${key}}}`, description: 'Collection variable' };
    }
    return { key: name, value };
  });

  const request: PostmanRequest = {
    method: endpoint.method,
    header: headers,
    url: toPostmanUrl(endpoint, url),
    description: describeEndpoint(endpoint),
  };

  if (endpoint.body) {
    request.body = {
      mode: 'raw',
      raw: endpoint.body,
      options: { raw: { language: bodyLanguage(endpoint.bodyMime) } },
    };
  }

  const item: PostmanItem = { name: endpoint.name, request, response: [] };

  if (endpoint.documentedResponse) {
    const success = endpoint.responseCodes.find((code) => code.code.startsWith('2'));
    item.response = [
      {
        name: 'Documented response',
        originalRequest: request,
        status: success?.description ?? 'OK',
        code: Number(success?.code) || 200,
        _postman_previewlanguage: bodyLanguage(
          endpoint.documentedResponse.trimStart().startsWith('{') ? 'json' : 'text',
        ),
        header: [],
        body: endpoint.documentedResponse,
      },
    ];
  }

  return item;
}

/**
 * Nests items under folders following each endpoint's heading trail.
 *
 * A flat list of forty requests from a document with seven sections loses the
 * grouping the document spent its structure establishing.
 */
function nest(endpoints: ParsedEndpoint[], build: (endpoint: ParsedEndpoint) => PostmanItem) {
  const root: Array<PostmanItem | PostmanFolder> = [];
  const folders = new Map<string, PostmanFolder>();

  const folderFor = (trail: string[]): Array<PostmanItem | PostmanFolder> => {
    let container = root;
    let key = '';
    for (const name of trail) {
      key = key ? `${key} › ${name}` : name;
      let folder = folders.get(key);
      if (!folder) {
        folder = { name, item: [] };
        folders.set(key, folder);
        container.push(folder);
      }
      container = folder.item;
    }
    return container;
  };

  for (const endpoint of endpoints) {
    // The last heading usually names the endpoint itself and is already the
    // item's name, so it would make a folder holding exactly one request.
    const trail = endpoint.section.slice(0, -1);
    folderFor(trail).push(build(endpoint));
  }

  return root;
}

export function toPostmanCollection(
  endpoints: ParsedEndpoint[],
  variables: Variable[],
  title: string,
  options: PostmanOptions,
): string {
  // Credential value → variable name, so two endpoints sharing a key share the
  // variable rather than getting one each.
  const secrets = new Map<string, string>();
  for (const variable of variables) {
    if (variable.secret && variable.value) secrets.set(variable.value, variable.key);
  }

  const items = nest(endpoints, (endpoint) => toItem(endpoint, options, secrets));

  const collectionVariables: PostmanVariable[] = variables.map((variable) => ({
    key: variable.key,
    // A secret is emitted empty when it is being lifted out, which is the point:
    // the recipient fills in their own.
    value: options.useVariables && variable.secret ? '' : variable.value,
    type: variable.secret ? 'secret' : 'string',
    description:
      variable.origin === 'path'
        ? 'Path parameter from the document'
        : variable.secret
          ? 'Credential from the document — fill in your own'
          : undefined,
  }));

  return JSON.stringify(
    {
      info: {
        _postman_id: randomUUID(),
        name: title,
        description:
          `Imported from an API document by curlapi.\n\n` +
          `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}. ` +
          (options.useVariables
            ? 'Credentials are collection variables — fill them in before running.'
            : 'This file contains credentials copied from the document. Treat it as a secret.'),
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: items,
      ...(collectionVariables.length > 0 ? { variable: collectionVariables } : {}),
    },
    null,
    2,
  );
}
