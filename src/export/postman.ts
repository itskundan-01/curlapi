import { randomUUID } from 'node:crypto';
import type { CurlOptions, RequestRecord, SessionRecord } from '../types.ts';
import { selectHeaders, extractSecrets } from '../curl/build.ts';
import { resolveNames } from './naming.ts';

type PostmanHeader = { key: string; value: string };
type PostmanQuery = { key: string; value: string };

type PostmanItem = {
  name: string;
  request: {
    method: string;
    header: PostmanHeader[];
    url: {
      raw: string;
      protocol: string;
      host: string[];
      path: string[];
      query?: PostmanQuery[];
    };
    body?: { mode: 'raw'; raw: string; options?: { raw: { language: string } } };
    description?: string;
  };
  response: unknown[];
};

type PostmanFolder = { name: string; item: PostmanItem[] };

function urlParts(rawUrl: string) {
  const parsed = new URL(rawUrl);
  const query: PostmanQuery[] = [];
  parsed.searchParams.forEach((value, key) => query.push({ key, value }));
  return {
    raw: rawUrl,
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname.split('.'),
    path: parsed.pathname.split('/').filter(Boolean),
    ...(query.length > 0 ? { query } : {}),
  };
}

function bodyLanguage(mimeType: string): string {
  if (mimeType.includes('json')) return 'json';
  if (mimeType.includes('xml')) return 'xml';
  if (mimeType.includes('html')) return 'html';
  return 'text';
}

function toItem(record: RequestRecord, name: string, options: CurlOptions): PostmanItem {
  const contentType =
    record.requestHeaders.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';

  const item: PostmanItem = {
    name,
    request: {
      method: record.method.toUpperCase(),
      header: selectHeaders(record.requestHeaders, options).map(([key, value]) => ({
        key,
        value,
      })),
      url: urlParts(record.url),
      description: record.verdict.reason
        ? `Captured from ${record.host}. Kept because: ${record.verdict.reason}.`
        : undefined,
    },
    response: [],
  };

  if (record.requestBody && record.requestBody.encoding === 'text') {
    item.request.body = {
      mode: 'raw',
      raw: record.requestBody.data,
      options: { raw: { language: bodyLanguage(contentType) } },
    };
  }

  // Saving the captured response as a Postman example means the collection still
  // documents the endpoint's shape even after the credentials expire.
  if (record.responseBody && record.responseBody.encoding === 'text') {
    item.response = [
      {
        name: `${record.status ?? 0} ${record.statusText}`.trim(),
        originalRequest: item.request,
        status: record.statusText,
        code: record.status ?? 0,
        _postman_previewlanguage: bodyLanguage(record.mimeType),
        header: record.responseHeaders.map(([key, value]) => ({ key, value })),
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

  const items: Array<PostmanItem | PostmanFolder> = [
    ...[...grouped.entries()].map(([name, item]) => ({ name, item })),
    ...flat,
  ];

  const variables: Array<{ key: string; value: string; type: string }> = [];
  if (options.redact) {
    const merged: Record<string, string> = {};
    for (const record of records) Object.assign(merged, extractSecrets(record));
    for (const [key, value] of Object.entries(merged)) {
      variables.push({ key, value, type: 'secret' });
    }
  }

  return JSON.stringify(
    {
      info: {
        _postman_id: randomUUID(),
        name: session.label,
        description:
          `Captured with curlapi from ${session.primaryHost ?? 'a browser session'} ` +
          `on ${new Date(session.startedAt).toISOString()}.` +
          (options.redact
            ? '\n\nCredentials are stored as collection variables — fill them in before running.'
            : '\n\nContains live credentials from the captured session.'),
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: items,
      ...(variables.length > 0 ? { variable: variables } : {}),
    },
    null,
    2,
  );
}
