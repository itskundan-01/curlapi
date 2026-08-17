import type { CurlOptions, HeaderPair, ReplayResult } from '@core/types.ts';
import type { DocParam, ParsedEndpoint, ResponseCode, Variable } from '@core/apps/doc-runner/types.ts';
import type { ImportSummary } from '@core/apps/doc-runner/store.ts';
import type { EndpointOverrides, HeaderRow } from '@core/apps/doc-runner/resolve.ts';
import { appPath } from '../../shell/api.ts';

export type {
  CurlOptions,
  DocParam,
  HeaderPair,
  HeaderRow,
  ImportSummary,
  ParsedEndpoint,
  ReplayResult,
  ResponseCode,
  Variable,
};

export const DOC_RUNNER_ID = 'doc-runner';

const BASE = appPath(DOC_RUNNER_ID);

/** What the request would actually be right now, resolved on the server. */
export type Resolved = {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | null;
};

/**
 * What the editor binds to — the reader's edits if there are any, the document's
 * own reading otherwise. Shaped by the server so the browser never has to decide
 * which of the two is in force.
 */
export type Draft = {
  method: string;
  url: string;
  headers: HeaderRow[];
  body: string | null;
};

export type Endpoint = ParsedEndpoint & {
  overrides: EndpointOverrides;
  resolved: Resolved;
  draft: Draft;
  /** Placeholders still unfilled; running is blocked while any remain. */
  placeholders: string[];
  edited: boolean;
};

export type ImportDetail = {
  summary: ImportSummary;
  variables: Variable[];
  endpoints: Endpoint[];
};

export type ImportResponse = {
  ok: boolean;
  id: string;
  endpointCount: number;
  warnings: string[];
  stats: Record<string, number>;
};

/** A run either happened, or was refused because a placeholder is unfilled. */
export type RunResponse =
  | { blocked: true; placeholders: string[]; error: string }
  | { blocked: false; result: ReplayResult };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(payload?.error ?? `${res.status} ${res.statusText}`);
  return payload;
}

export function curlQuery(options: CurlOptions): string {
  const params = new URLSearchParams();
  if (options.clean) params.set('clean', '1');
  if (options.redact) params.set('redact', '1');
  if (options.shell !== 'posix') params.set('shell', options.shell);
  if (options.singleLine) params.set('singleLine', '1');
  return params.toString();
}

export const api = {
  /**
   * Uploads one file as a raw body with its name in a header.
   *
   * Not multipart: there is exactly one file per request, so a boundary parser
   * on the server would be machinery in exchange for nothing.
   */
  async import(file: File): Promise<ImportResponse> {
    const res = await fetch(`${BASE}/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        // Encoded because a file name may hold anything, and a header may not.
        'x-file-name': encodeURIComponent(file.name),
      },
      body: file,
    });
    const payload = (await res.json()) as ImportResponse & { error?: string };
    if (!res.ok) throw new Error(payload?.error ?? `${res.status} ${res.statusText}`);
    return payload;
  },

  imports: () => getJson<ImportSummary[]>('/imports'),

  detail: (id: string) => getJson<ImportDetail>(`/imports/${encodeURIComponent(id)}`),

  deleteImport: async (id: string): Promise<void> => {
    await fetch(`${BASE}/imports/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  setVariables: (id: string, variables: Variable[]) =>
    postJson<{ ok: boolean }>(`/imports/${encodeURIComponent(id)}/variables`, { variables }),

  update: (
    id: string,
    fields: Partial<EndpointOverrides> & { name?: string; reset?: boolean },
  ) => postJson<Endpoint>(`/endpoints/${encodeURIComponent(id)}`, fields),

  deleteEndpoint: async (id: string): Promise<void> => {
    await fetch(`${BASE}/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  run: (id: string) => postJson<RunResponse>(`/endpoints/${encodeURIComponent(id)}/run`),

  /** Replaces the request with a curl command pasted in from anywhere. */
  fromCurl: (id: string, command: string) =>
    postJson<Endpoint>(`/endpoints/${encodeURIComponent(id)}/from-curl`, { command }),

  curl: async (id: string, options: CurlOptions): Promise<string> => {
    const res = await fetch(
      `${BASE}/endpoints/${encodeURIComponent(id)}/curl?${curlQuery(options)}`,
    );
    return res.text();
  },

  /** Every command in one request — see the note on the route. */
  curls: (id: string, options: CurlOptions) =>
    getJson<Array<{ id: string; curl: string }>>(
      `/imports/${encodeURIComponent(id)}/curls?${curlQuery(options)}`,
    ),

  exportUrl: (
    id: string,
    format: 'postman' | 'script' | 'markdown',
    options: CurlOptions,
    extra: {
      /** Keep credential values in the file instead of lifting them to variables. */
      inline?: boolean;
      environment?: string;
      /** Restrict the export to a selection. */
      ids?: string[];
      /** Return the text for the clipboard rather than as a download. */
      forClipboard?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams(curlQuery(options));
    if (extra.inline) params.set('inline', '1');
    if (extra.environment) params.set('environment', extra.environment);
    if (extra.ids?.length) params.set('ids', extra.ids.join(','));
    if (extra.forClipboard) params.set('download', '0');
    return `${BASE}/imports/${encodeURIComponent(id)}/export/${format}?${params.toString()}`;
  },

  /** Fetches an export as text, for putting on the clipboard. */
  exportText: async (
    id: string,
    format: 'postman' | 'script' | 'markdown',
    options: CurlOptions,
    extra: { inline?: boolean; ids?: string[] } = {},
  ): Promise<string> => {
    const res = await fetch(
      api.exportUrl(id, format, options, { ...extra, forClipboard: true }),
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  },
};
