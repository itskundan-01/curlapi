import type { Replayability } from '@core/analyze/replayability.ts';
import type { Dependency } from '@core/analyze/links.ts';
import type {
  CurlOptions,
  DocEntry,
  DocFolder,
  ReplayResult,
  RequestRecord,
  SessionRecord,
  SessionSummary,
  SlimRecord,
} from '@core/types.ts';
import { appPath } from '../../shell/api.ts';

export type {
  ReplayResult,
  RequestRecord,
  SessionRecord,
  SessionSummary,
  SlimRecord,
  CurlOptions,
  DocEntry,
  DocFolder,
  Replayability,
  Dependency,
};

export const CURL_EXTRACTOR_ID = 'curl-extractor';

/** Every route below hangs off the app's own prefix, not the server root. */
const BASE = appPath(CURL_EXTRACTOR_ID);

/**
 * A document entry with its command resolved, live or from its own snapshot.
 * The snapshot itself stays on the server — the UI only needs the command.
 */
export type DocEntryWithCurl = Omit<DocEntry, 'recordSnapshot'> & { curl: string };

/** The whole document: its folders and every entry across them. */
export type DocState = { folders: DocFolder[]; entries: DocEntryWithCurl[] };

/** The detail view adds flow analysis that the list endpoints do not carry. */
export type RequestDetail = RequestRecord & {
  replayability: Replayability;
  dependencies: Dependency[];
};

export type CaptureState = 'idle' | 'starting' | 'running' | 'stopping';

/** What a finished capture kept, shown once the browser has closed. */
export type CaptureSummary = {
  sessionId: string;
  label: string;
  total: number;
  documented: number;
  discarded: number;
  retained: number;
  bytes: number;
  sessionKept: boolean;
};

export type Status = {
  /** The browser lifecycle, which is now separate from the process's. */
  capture: {
    state: CaptureState;
    targetUrl: string | null;
    browserName: string | null;
    error: string | null;
    lastSummary: CaptureSummary | null;
  };
  /** The session on screen, which is not always the one being recorded. */
  sessionId: string;
  captureSessionId: string | null;
  viewingCapture: boolean;
  session: SessionRecord | null;
  sessions: SessionSummary[];
  capturing: boolean;
  paused: boolean;
  primaryHost: string | null;
  /** Pages that had already loaded when capture attached to them. */
  staleTabs: string[];
  counts: { total: number; kept: number; approved: number; failed: number };
  storedBytes: number;
};

export type StartRequest = {
  url?: string;
  label?: string;
  headless?: boolean;
  resume?: boolean;
  keep?: boolean;
};

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
  // The start endpoint reports a failed Chrome launch in the body, and that
  // message is the only useful thing on screen when it happens.
  if (!res.ok) throw new Error(payload?.error ?? `${res.status} ${res.statusText}`);
  return payload;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
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
  status: () => getJson<Status>('/status'),

  /** Launches the browser and begins recording. Resolves once it is navigating. */
  startCapture: (request: StartRequest) =>
    postJson<{ ok: boolean; sessionId: string; status: Status }>(
      '/capture/start',
      request,
    ),

  stopCapture: (keep = false) =>
    postJson<{ ok: boolean; summary: CaptureSummary | null; status: Status }>(
      '/capture/stop',
      { keep },
    ),

  selectSession: (id: string) => postJson<Status>('/session', { id }),

  deleteSession: (id: string) =>
    del<{ ok: boolean; status: Status }>(`/sessions/${encodeURIComponent(id)}`),

  requests: (includeNoise: boolean) =>
    getJson<SlimRecord[]>(`/requests${includeNoise ? '?noise=1' : ''}`),

  approved: () => getJson<SlimRecord[]>('/approved'),

  detail: (id: string) => getJson<RequestDetail>(`/requests/${encodeURIComponent(id)}`),

  curls: (options: CurlOptions) =>
    getJson<Array<{ id: string; curl: string }>>(`/curls?${curlQuery(options)}`),

  curl: async (id: string, options: CurlOptions): Promise<string> => {
    const res = await fetch(
      `${BASE}/requests/${encodeURIComponent(id)}/curl?${curlQuery(options)}`,
    );
    return res.text();
  },

  approve: (id: string, approved: boolean) =>
    postJson<SlimRecord>(`/requests/${encodeURIComponent(id)}/approve`, { approved }),

  rename: (id: string, title: string) =>
    postJson<SlimRecord>(`/requests/${encodeURIComponent(id)}/title`, { title }),

  replay: (id: string) =>
    postJson<ReplayResult>(`/requests/${encodeURIComponent(id)}/replay`),

  approveMany: (ids: string[], approved: boolean) =>
    postJson<{ ok: boolean; count: number }>('/approve-many', { ids, approved }),

  clear: () => postJson<{ ok: boolean; removed: number }>('/clear'),

  setOrder: (ids: string[]) => postJson<{ ok: boolean }>('/order', { ids }),

  pause: (paused: boolean) => postJson<{ paused: boolean }>('/pause', { paused }),

  reload: () => postJson<{ ok: boolean; reloaded: number }>('/reload'),

  doc: (options: CurlOptions) => getJson<DocState>(`/doc?${curlQuery(options)}`),

  addToDoc: (requestIds: string[], options: CurlOptions, folderId: string | null) =>
    postJson<DocEntry[]>(`/doc?${curlQuery(options)}`, { requestIds, folderId }),

  addDocNote: (title: string, note: string, folderId: string | null) =>
    postJson<DocEntry[]>('/doc', { title, note, folderId, requestIds: [] }),

  updateDocEntry: (
    id: string,
    fields: { title?: string; note?: string; folderId?: string },
  ) => postJson<{ ok: boolean }>(`/doc/${encodeURIComponent(id)}`, fields),

  deleteDocEntry: (id: string) => del<{ ok: boolean }>(`/doc/${encodeURIComponent(id)}`),

  setDocOrder: (ids: string[]) => postJson<{ ok: boolean }>('/doc/order', { ids }),

  createFolder: (name: string) => postJson<DocFolder>('/folders', { name }),

  renameFolder: (id: string, name: string) =>
    postJson<{ ok: boolean }>(`/folders/${encodeURIComponent(id)}`, { name }),

  deleteFolder: (id: string) =>
    del<{ ok: boolean; removed: number }>(`/folders/${encodeURIComponent(id)}`),

  setFolderOrder: (ids: string[]) => postJson<{ ok: boolean }>('/folders/order', { ids }),

  exportUrl: (
    format: 'script' | 'postman' | 'json' | 'doc',
    options: CurlOptions,
    folderId?: string,
  ) => {
    const params = new URLSearchParams(curlQuery(options));
    if (folderId) params.set('folder', folderId);
    return `${BASE}/export/${format}?${params.toString()}`;
  },
};
