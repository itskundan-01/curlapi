/**
 * A capture as a Postman collection.
 *
 * The mapping only: everything about the file format itself lives in
 * ../postman/collection.ts, which both utilities share so their exports cannot
 * drift apart.
 */

import { randomUUID } from 'node:crypto';
import type { CurlOptions, RequestRecord, SessionRecord } from '../types.ts';
import { selectHeaders, extractSecrets } from '../curl/build.ts';
import { resolveNames } from './naming.ts';
import {
  bodyLanguage,
  bodyPruningBehavior,
  collection,
  postmanBody,
  postmanHeaders,
  postmanUrl,
  stringifyCollection,
  type PostmanItem,
  type PostmanRequest,
  type PostmanFolder,
  type PostmanNode,
  type PostmanVariable,
} from '../postman/collection.ts';

function headerValue(record: RequestRecord, name: string): string {
  return record.requestHeaders.find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
}

function describe(record: RequestRecord): string | undefined {
  const lines: string[] = [];
  if (record.verdict.reason) {
    lines.push(`Captured from ${record.host}. Kept because: ${record.verdict.reason}.`);
  }
  if (record.requestBody?.encoding === 'base64') {
    // The bytes are in the capture, not on the importer's disk, so there is
    // nothing Postman could attach. Saying so beats an empty body.
    lines.push(
      '**The request body was binary and is not included.** ' +
        'Re-attach the file in the Body tab before sending.',
    );
  }
  if (record.requestBody?.truncated) {
    lines.push('**The browser only handed over part of this request body.**');
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function toItem(record: RequestRecord, name: string, options: CurlOptions): PostmanItem {
  const body =
    record.requestBody && record.requestBody.encoding === 'text'
      ? postmanBody({ raw: record.requestBody.data, contentType: headerValue(record, 'content-type') })
      : undefined;

  const description = describe(record);
  const request: PostmanRequest = {
    method: record.method.toUpperCase(),
    header: postmanHeaders(selectHeaders(record.requestHeaders, options)),
    url: postmanUrl(record.url),
    ...(body ? { body } : {}),
    ...(description ? { description } : {}),
  };

  const pruning = bodyPruningBehavior(record.method, body);
  const item: PostmanItem = {
    name,
    request,
    response: [],
    ...(pruning ? { protocolProfileBehavior: pruning } : {}),
  };

  // Saving the captured response as a Postman example means the collection still
  // documents the endpoint's shape even after the credentials expire.
  if (record.responseBody && record.responseBody.encoding === 'text') {
    item.response = [
      {
        name: `${record.status ?? 0} ${record.statusText}`.trim() || 'Captured response',
        originalRequest: request,
        status: record.statusText,
        code: record.status ?? 0,
        _postman_previewlanguage: bodyLanguage(record.mimeType),
        header: postmanHeaders(record.responseHeaders),
        body: record.responseBody.data,
      },
    ];
  }

  return item;
}

export function toPostmanCollection(
  records: RequestRecord[],
  session: SessionRecord,
  options: CurlOptions,
): string {
  const names = resolveNames(records);

  // Group into folders only when action labels exist; a flat list is easier to
  // scan than a tree of one-item folders.
  const grouped = new Map<string, PostmanItem[]>();
  const flat: PostmanItem[] = [];
  records.forEach((record, index) => {
    const item = toItem(record, `${index + 1}. ${names[index]}`, options);
    if (record.actionGroup) {
      const bucket = grouped.get(record.actionGroup) ?? [];
      bucket.push(item);
      grouped.set(record.actionGroup, bucket);
    } else {
      flat.push(item);
    }
  });

  const folders: PostmanFolder[] = [...grouped.entries()].map(([name, item]) => ({ name, item }));
  const items: PostmanNode[] = [...folders, ...flat];

  const variables: PostmanVariable[] = [];
  if (options.redact) {
    const merged: Record<string, string> = {};
    for (const record of records) Object.assign(merged, extractSecrets(record));
    for (const [key, value] of Object.entries(merged)) {
      variables.push({
        key,
        value,
        type: 'string',
        description: 'Credential from the captured session — replace with your own.',
      });
    }
  }

  return stringifyCollection(
    collection({
      id: randomUUID(),
      name: session.label,
      description:
        `Captured with curlapi from ${session.primaryHost ?? 'a browser session'} ` +
        `on ${new Date(session.startedAt).toISOString()}.` +
        (options.redact
          ? '\n\nCredentials are stored as collection variables — fill them in before running.'
          : '\n\nContains live credentials from the captured session.'),
      items,
      variables,
    }),
  );
}
