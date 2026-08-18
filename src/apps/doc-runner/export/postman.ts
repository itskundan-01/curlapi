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
 *
 * The format itself — URL parts, body modes, what a variable is allowed to
 * contain — lives in src/postman/collection.ts, shared with the capture app and
 * checked against the published schema by the test suite.
 */

import { randomUUID } from 'node:crypto';
import type { ParsedEndpoint, Variable } from '../types.ts';
import { isSecretHeader } from '../extract/shared.ts';
import {
  bodyPruningBehavior,
  collection,
  postmanBody,
  postmanHeaders,
  postmanUrl,
  stringifyCollection,
  type PostmanFolder,
  type PostmanItem,
  type PostmanNode,
  type PostmanRequest,
  type PostmanVariable,
} from '../../../postman/collection.ts';

export type PostmanOptions = {
  /** Lift credentials out of the requests and into collection variables. */
  useVariables: boolean;
  /** The environment to point the collection at, when the document lists any. */
  environment?: string;
};

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

/** What the document said about one named parameter, in one line. */
function annotationsFor(endpoint: ParsedEndpoint) {
  const describe = (name: string): string | undefined => {
    const param = endpoint.params.find((candidate) => candidate.name === name);
    if (!param) return undefined;
    return (
      [param.description, param.dataType && `(${param.dataType})`]
        .filter(Boolean)
        .join(' ')
        .trim() || undefined
    );
  };

  return {
    describe,
    pathValue: (name: string): string | undefined =>
      endpoint.params.find((candidate) => candidate.name === name)?.expected || undefined,
  };
}

/**
 * Points the request at a named environment, keeping the documented path.
 *
 * Documents usually give one worked example against staging and list the other
 * base URLs in a table; swapping the origin is what turns that table into
 * something usable.
 */
function applyEnvironment(endpoint: ParsedEndpoint, environment: string | undefined): string {
  if (!environment) return endpoint.url;
  const match = endpoint.environments.find((candidate) => candidate.name === environment);
  if (!match) return endpoint.url;
  try {
    const target = new URL(endpoint.url);
    const base = new URL(match.url);
    return `${base.origin}${target.pathname}${target.search}`;
  } catch {
    return endpoint.url;
  }
}

function toItem(
  endpoint: ParsedEndpoint,
  options: PostmanOptions,
  secrets: Map<string, string>,
): PostmanItem {
  // Postman only offers the path-variable editor for the colon form, and that
  // editor is the difference between a URL somebody can fill in and one they
  // have to retype.
  const url = applyEnvironment(endpoint, options.environment).replace(
    /\{([A-Za-z_][\w-]*)\}/g,
    ':$1',
  );

  // A credential is replaced by a reference to the collection variable holding
  // it, which is what lets the file be shared.
  const lifted = new Set<string>();
  const pairs = endpoint.headers.map(([name, value]) => {
    const key = options.useVariables && isSecretHeader(name) ? secrets.get(value) : undefined;
    if (!key) return [name, value] as const;
    lifted.add(name);
    return [name, `{{${key}}}`] as const;
  });
  const header = postmanHeaders(pairs, (name) =>
    lifted.has(name) ? { description: 'Collection variable' } : {},
  );

  const body = endpoint.body
    ? postmanBody({ raw: endpoint.body, contentType: endpoint.bodyMime })
    : undefined;

  const description = describeEndpoint(endpoint);
  const request: PostmanRequest = {
    method: endpoint.method,
    header,
    url: postmanUrl(url, annotationsFor(endpoint)),
    ...(body ? { body } : {}),
    ...(description ? { description } : {}),
  };

  const pruning = bodyPruningBehavior(endpoint.method, body);
  const item: PostmanItem = {
    name: endpoint.name,
    request,
    response: [],
    ...(pruning ? { protocolProfileBehavior: pruning } : {}),
  };

  if (endpoint.documentedResponse) {
    const success = endpoint.responseCodes.find((code) => code.code.startsWith('2'));
    item.response = [
      {
        name: 'Documented response',
        originalRequest: request,
        status: success?.description ?? 'OK',
        code: Number(success?.code) || 200,
        _postman_previewlanguage: endpoint.documentedResponse.trimStart().startsWith('{')
          ? 'json'
          : 'text',
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
  const root: PostmanNode[] = [];
  const folders = new Map<string, PostmanFolder>();

  const folderFor = (trail: string[]): PostmanNode[] => {
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
    // The format's own enum is string/boolean/number/any — Postman's "secret"
    // type is a product feature, not a file one, and a collection carrying it
    // fails schema validation on import.
    type: 'string',
    description:
      variable.origin === 'path'
        ? 'Path parameter from the document'
        : variable.secret
          ? 'Credential from the document — fill in your own'
          : undefined,
  }));

  return stringifyCollection(
    collection({
      id: randomUUID(),
      name: title,
      description:
        `Imported from an API document by curlapi.\n\n` +
        `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}. ` +
        (options.useVariables
          ? 'Credentials are collection variables — fill them in before running.'
          : 'This file contains credentials copied from the document. Treat it as a secret.'),
      items,
      variables: collectionVariables,
    }),
  );
}
