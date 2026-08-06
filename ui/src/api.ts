import type { Replayability } from '../../src/analyze/replayability.ts';
import type { Dependency } from '../../src/analyze/links.ts';
import type {
  CurlOptions,
  DocEntry,
  DocFolder,
  ReplayResult,
  RequestRecord,
  SessionRecord,
  SessionSummary,
  SlimRecord,
} from '../../src/types.ts';

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

export type Status = {
  /** The session on screen, which is not always the one being recorded. */
  sessionId: string;
  captureSessionId: string;
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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
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
  status: () => getJson<Status>('/api/status'),

  selectSession: (id: string) => postJson<Status>('/api/session', { id }),

  deleteSession: (id: string) =>
    del<{ ok: boolean; status: Status }>(`/api/sessions/${encodeURIComponent(id)}`),

  requests: (includeNoise: boolean) =>
    getJson<SlimRecord[]>(`/api/requests${includeNoise ? '?noise=1' : ''}`),

  approved: () => getJson<SlimRecord[]>('/api/approved'),

  detail: (id: string) =>
    getJson<RequestDetail>(`/api/requests/${encodeURIComponent(id)}`),

  curls: (options: CurlOptions) =>
    getJson<Array<{ id: string; curl: string }>>(`/api/curls?${curlQuery(options)}`),

  curl: async (id: string, options: CurlOptions): Promise<string> => {
    const res = await fetch(
      `/api/requests/${encodeURIComponent(id)}/curl?${curlQuery(options)}`,
    );
    return res.text();
  },

  approve: (id: string, approved: boolean) =>
    postJson<SlimRecord>(`/api/requests/${encodeURIComponent(id)}/approve`, { approved }),

  rename: (id: string, title: string) =>
    postJson<SlimRecord>(`/api/requests/${encodeURIComponent(id)}/title`, { title }),

  replay: (id: string) =>
    postJson<ReplayResult>(`/api/requests/${encodeURIComponent(id)}/replay`),

  approveMany: (ids: string[], approved: boolean) =>
    postJson<{ ok: boolean; count: number }>('/api/approve-many', { ids, approved }),

  clear: () => postJson<{ ok: boolean; removed: number }>('/api/clear'),

  setOrder: (ids: string[]) => postJson<{ ok: boolean }>('/api/order', { ids }),

  pause: (paused: boolean) => postJson<{ paused: boolean }>('/api/pause', { paused }),

  reload: () => postJson<{ ok: boolean; reloaded: number }>('/api/reload'),

  doc: (options: CurlOptions) => getJson<DocState>(`/api/doc?${curlQuery(options)}`),

  addToDoc: (requestIds: string[], options: CurlOptions, folderId: string | null) =>
    postJson<DocEntry[]>(`/api/doc?${curlQuery(options)}`, { requestIds, folderId }),

  addDocNote: (title: string, note: string, folderId: string | null) =>
    postJson<DocEntry[]>('/api/doc', { title, note, folderId, requestIds: [] }),

  updateDocEntry: (
    id: string,
    fields: { title?: string; note?: string; folderId?: string },
  ) => postJson<{ ok: boolean }>(`/api/doc/${encodeURIComponent(id)}`, fields),

  deleteDocEntry: (id: string) => del<{ ok: boolean }>(`/api/doc/${encodeURIComponent(id)}`),

  setDocOrder: (ids: string[]) => postJson<{ ok: boolean }>('/api/doc/order', { ids }),

  createFolder: (name: string) => postJson<DocFolder>('/api/folders', { name }),

  renameFolder: (id: string, name: string) =>
    postJson<{ ok: boolean }>(`/api/folders/${encodeURIComponent(id)}`, { name }),

  deleteFolder: (id: string) =>
    del<{ ok: boolean; removed: number }>(`/api/folders/${encodeURIComponent(id)}`),

  setFolderOrder: (ids: string[]) =>
    postJson<{ ok: boolean }>('/api/folders/order', { ids }),

  exportUrl: (
    format: 'script' | 'postman' | 'json' | 'doc',
    options: CurlOptions,
    folderId?: string,
  ) => {
    const params = new URLSearchParams(curlQuery(options));
    if (folderId) params.set('folder', folderId);
    return `/api/export/${format}?${params.toString()}`;
  },
};

/**
 * Live push of captured requests and session status. Reconnects on drop.
 *
 * Status arrives over this socket rather than being polled, because this page is
 * usually open in the browser being recorded and a polling loop would show up as
 * a request every few seconds in the very list it is meant to display.
 */
export function connectLive(handlers: {
  onRecord: (record: SlimRecord) => void;
  onStatus: (status: Status) => void;
}): () => void {
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let closed = false;

  const open = (): void => {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as {
          type: string;
          record?: SlimRecord;
          status?: Status;
        };
        if (message.type === 'record' && message.record) handlers.onRecord(message.record);
        if (message.type === 'status' && message.status) handlers.onStatus(message.status);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (!closed) timer = window.setTimeout(open, 1200);
    };
  };

  open();
  return () => {
    closed = true;
    if (timer) window.clearTimeout(timer);
    socket?.close();
  };
}
