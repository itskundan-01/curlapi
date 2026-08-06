import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BodySummary, CurlOptions, RequestRecord, SlimRecord } from '../types.ts';
import { DEFAULT_CURL_OPTIONS } from '../types.ts';
import type { Store } from '../store/db.ts';
import type { Recorder } from '../capture/recorder.ts';
import { buildCurl } from '../curl/build.ts';
import { replay } from '../replay/run.ts';
import { toShellScript } from '../export/script.ts';
import { toPostmanCollection } from '../export/postman.ts';
import { toMarkdown } from '../export/doc.ts';
import { assessReplayability } from '../analyze/replayability.ts';
import { findDependencies } from '../analyze/links.ts';
import { serveStatic } from './static.ts';
import { randomUUID } from 'node:crypto';
import type { DocEntry } from '../types.ts';

export type ServerHandle = {
  port: number;
  url: string;
  broadcast(message: unknown): void;
  /**
   * The server is started before the recorder so the recorder can be told to
   * ignore this server's own origin. This closes that loop afterwards.
   */
  setRecorder(recorder: Recorder | null): void;
  close(): Promise<void>;
};

type ServerOptions = {
  store: Store;
  sessionId: string;
  port: number;
  /** Absent when the UI is opened against a stored session with no live capture. */
  recorder: Recorder | null;
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function summarize(body: { encoding: 'text' | 'base64'; data: string; truncated: boolean } | null): BodySummary | null {
  if (!body) return null;
  return { encoding: body.encoding, truncated: body.truncated, size: body.data.length };
}

/** Strips payloads so a list of several hundred records stays small. */
function slim(record: RequestRecord): SlimRecord {
  return {
    ...record,
    requestBody: summarize(record.requestBody),
    responseBody: summarize(record.responseBody),
  };
}

/**
 * A folder name reduced to something safe in a Content-Disposition header.
 * Quotes and non-ASCII would either break the header or arrive mangled.
 */
function fileNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'api-notes';
}

function curlOptionsFrom(params: URLSearchParams): CurlOptions {
  return {
    ...DEFAULT_CURL_OPTIONS,
    clean: params.get('clean') === '1',
    redact: params.get('redact') === '1',
    shell: params.get('shell') === 'powershell' ? 'powershell' : 'posix',
    singleLine: params.get('singleLine') === '1' || params.get('single') === '1',
  };
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { store } = options;
  let recorder = options.recorder;
  const clients = new Set<WebSocket>();

  /** Where the recorder writes. Fixed for the life of the process. */
  const captureSessionId = options.sessionId;
  /**
   * What the UI is looking at, which is not always what is being recorded.
   *
   * Every run of `curlapi start` opens a new session, so without this the
   * previous capture becomes unreachable the moment the next one begins — it is
   * still on disk, but nothing can show it, which is indistinguishable from
   * having lost it.
   */
  let sessionId = options.sessionId;

  const statusPayload = () => {
    const session = store.getSession(sessionId);
    const all = store.listRequests(sessionId, { includeNoise: true });
    const kept = all.filter((record) => record.verdict.keep);
    return {
      sessionId,
      captureSessionId,
      /** True while viewing the session the recorder is writing into. */
      viewingCapture: sessionId === captureSessionId,
      session,
      sessions: store.listSessionSummaries(),
      capturing: recorder !== null,
      paused: recorder?.paused ?? false,
      primaryHost: recorder?.primaryHost ?? session?.primaryHost ?? null,
      staleTabs: recorder?.staleTabs ?? [],
      counts: {
        total: all.length,
        kept: kept.length,
        approved: all.filter((record) => record.approved).length,
        // Counted over kept requests only: a filtered-out tracker pixel 404ing
        // is not something anyone is trying to debug.
        failed: kept.filter(
          (record) => record.error !== null || (record.status ?? 0) >= 400,
        ).length,
      },
      storedBytes: store.sessionBytes(sessionId),
    };
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      serveStatic(path, res);
      return;
    }

    // --- session-level reads -------------------------------------------------

    if (path === '/api/status') {
      json(res, 200, statusPayload());
      return;
    }

    if (path === '/api/sessions') {
      json(res, 200, store.listSessionSummaries());
      return;
    }

    // Switching what the UI shows. Recording is unaffected — it keeps writing
    // into the capture session, so browsing an old one never costs live traffic.
    if (path === '/api/session' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const next = typeof body['id'] === 'string' ? store.getSession(body['id']) : null;
      if (!next) {
        json(res, 404, { error: 'no such session' });
        return;
      }
      sessionId = next.id;
      broadcast({ type: 'status', status: statusPayload() });
      json(res, 200, statusPayload());
      return;
    }

    const sessionMatch = /^\/api\/sessions\/(.+)$/.exec(path);
    if (sessionMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(sessionMatch[1]);
      if (id === captureSessionId) {
        json(res, 409, { error: 'cannot delete the session being recorded' });
        return;
      }
      store.deleteSession(id);
      // Fall back to the live capture if the deleted one was on screen.
      if (sessionId === id) sessionId = captureSessionId;
      json(res, 200, { ok: true, status: statusPayload() });
      return;
    }

    if (path === '/api/requests') {
      const includeNoise = url.searchParams.get('noise') === '1';
      json(res, 200, store.listRequests(sessionId, { includeNoise }).map(slim));
      return;
    }

    if (path === '/api/approved') {
      json(res, 200, store.listApproved(sessionId).map(slim));
      return;
    }

    // Rendering the collection needs every approved command at once; one round
    // trip per card would make the options toggles feel sluggish.
    if (path === '/api/curls') {
      const curlOptions = curlOptionsFrom(url.searchParams);
      json(
        res,
        200,
        store.listApproved(sessionId).map((record) => ({
          id: record.id,
          curl: buildCurl(record, curlOptions),
        })),
      );
      return;
    }

    // --- per-request operations ---------------------------------------------

    const requestMatch = /^\/api\/requests\/(.+?)(?:\/(curl|replay|approve|title))?$/.exec(
      path,
    );
    if (requestMatch) {
      const id = decodeURIComponent(requestMatch[1]);
      const action = requestMatch[2];
      // Falls back to a document's own copy, so anything documented stays
      // viewable, copyable and runnable after its capture has been discarded.
      const record = store.getRequest(id) ?? store.getDocSnapshot(id);
      if (!record) {
        json(res, 404, { error: `no request ${id}` });
        return;
      }

      if (action === 'curl') {
        text(res, 200, buildCurl(record, curlOptionsFrom(url.searchParams)), 'text/plain; charset=utf-8');
        return;
      }

      if (action === 'replay' && req.method === 'POST') {
        json(res, 200, await replay(record));
        return;
      }

      if (action === 'approve' && req.method === 'POST') {
        const body = await readJsonBody(req);
        store.setApproved(id, body['approved'] !== false);
        const updated = store.getRequest(id);
        json(res, 200, updated ? slim(updated) : null);
        return;
      }

      if (action === 'title' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
        store.setTitle(id, title.length > 0 ? title : null);
        const updated = store.getRequest(id);
        json(res, 200, updated ? slim(updated) : null);
        return;
      }

      if (!action) {
        // Flow analysis rides along with the detail view: whether this request
        // can be replayed at all, and which earlier response fed it its values.
        json(res, 200, {
          ...record,
          replayability: assessReplayability(record),
          dependencies: findDependencies(record, store.listRequests(sessionId)),
        });
        return;
      }
    }

    // --- bulk operations -----------------------------------------------------

    if (path === '/api/approve-many' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.setApprovedMany(ids, body['approved'] !== false);
      json(res, 200, { ok: true, count: ids.length });
      return;
    }

    if (path === '/api/clear' && req.method === 'POST') {
      // The document is intentionally left alone: entries fall back to their
      // snapshotted command, so clearing a noisy list never costs notes.
      const removed = store.clearRequests(sessionId);
      // Numbering restarts too, so the next request shows up as #1 rather than
      // continuing from wherever the cleared list happened to end. Only when the
      // live session is the one being cleared — resetting it while looking at an
      // old capture would renumber traffic the user can't even see.
      if (sessionId === captureSessionId) recorder?.resetSequence();
      json(res, 200, { ok: true, removed });
      return;
    }

    // --- document ------------------------------------------------------------

    /**
     * The entry's command, rebuilt with the current options.
     *
     * Prefers the live request, then the entry's own copy of it — both allow the
     * clean/redact/shell toggles to apply. The stored command string is the last
     * resort, for entries written before snapshots existed.
     */
    const curlForEntry = (
      entry: Omit<DocEntry, 'recordSnapshot'>,
      curlOptions: CurlOptions,
    ): string => {
      if (!entry.requestId) return '';
      const record =
        store.getRequest(entry.requestId) ?? store.getDocSnapshot(entry.requestId);
      return record ? buildCurl(record, curlOptions) : entry.curlSnapshot;
    };

    if (path === '/api/doc') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const requestIds = Array.isArray(body['requestIds'])
          ? (body['requestIds'] as string[])
          : [];
        const curlOptions = curlOptionsFrom(url.searchParams);

        // An unknown folder id falls back to the default document rather than
        // failing: losing the command the user just picked would be worse than
        // filing it somewhere they can move it from.
        const requested =
          typeof body['folderId'] === 'string' ? store.getFolder(body['folderId']) : null;
        const folderId = requested?.id ?? store.defaultFolder(sessionId).id;

        // A note with no requests is a heading or paragraph the user typed.
        if (requestIds.length === 0) {
          const entry = store.addDocEntry({
            id: randomUUID(),
            sessionId,
            folderId,
            requestId: null,
            title: typeof body['title'] === 'string' ? body['title'] : '',
            note: typeof body['note'] === 'string' ? body['note'] : '',
            curlSnapshot: '',
            url: '',
            method: '',
            status: null,
          });
          json(res, 200, [entry]);
          return;
        }

        const added: DocEntry[] = [];
        for (const requestId of requestIds) {
          const record = store.getRequest(requestId);
          if (!record) continue;
          added.push(
            store.addDocEntry({
              id: randomUUID(),
              sessionId,
              folderId,
              requestId,
              title: record.title ?? record.shortName,
              note: '',
              curlSnapshot: buildCurl(record, curlOptions),
              // The full record travels with the entry, so the document keeps
              // working once the capture behind it is discarded.
              recordSnapshot: record,
              url: record.url,
              method: record.method,
              status: record.status,
            }),
          );
        }
        json(res, 200, added);
        return;
      }

      const curlOptions = curlOptionsFrom(url.searchParams);
      json(res, 200, {
        folders: store.listFolders(sessionId),
        entries: store.listDocEntries(sessionId).map((entry) => {
          // The snapshot carries full headers and bodies. It is what makes the
          // entry durable, but the UI renders from `curl`, so shipping it to
          // the browser on every refresh would be pure weight.
          const { recordSnapshot: _snapshot, ...rest } = entry;
          return { ...rest, curl: curlForEntry(entry, curlOptions) };
        }),
      });
      return;
    }

    if (path === '/api/doc/order' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.reorderDocEntries(ids);
      json(res, 200, { ok: true });
      return;
    }

    // --- document folders ------------------------------------------------------

    if (path === '/api/folders') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body['name'] === 'string' ? body['name'] : '';
        json(res, 200, store.createFolder(sessionId, name));
        return;
      }
      json(res, 200, store.listFolders(sessionId));
      return;
    }

    if (path === '/api/folders/order' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.reorderFolders(ids);
      json(res, 200, { ok: true });
      return;
    }

    const folderMatch = /^\/api\/folders\/(.+)$/.exec(path);
    if (folderMatch) {
      const id = decodeURIComponent(folderMatch[1]);
      if (req.method === 'DELETE') {
        json(res, 200, { ok: true, removed: store.deleteFolder(id) });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body['name'] === 'string') store.renameFolder(id, body['name']);
        json(res, 200, { ok: true });
        return;
      }
    }

    const docMatch = /^\/api\/doc\/(.+)$/.exec(path);
    if (docMatch) {
      const id = decodeURIComponent(docMatch[1]);
      if (req.method === 'DELETE') {
        store.deleteDocEntry(id);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        store.updateDocEntry(id, {
          title: typeof body['title'] === 'string' ? body['title'] : undefined,
          note: typeof body['note'] === 'string' ? body['note'] : undefined,
        });
        if (typeof body['folderId'] === 'string' && store.getFolder(body['folderId'])) {
          store.moveDocEntry(id, body['folderId']);
        }
        json(res, 200, { ok: true });
        return;
      }
    }

    // --- collection ordering -------------------------------------------------

    if (path === '/api/order' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.setOrder(ids);
      json(res, 200, { ok: true });
      return;
    }

    // --- capture control -----------------------------------------------------

    if (path === '/api/reload' && req.method === 'POST') {
      const reloaded = (await recorder?.reloadPages()) ?? 0;
      json(res, 200, { ok: true, reloaded });
      return;
    }

    if (path === '/api/pause' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const paused = body['paused'] === true;
      recorder?.setPaused(paused);
      json(res, 200, { paused: recorder?.paused ?? false });
      return;
    }

    // --- exports -------------------------------------------------------------

    const exportMatch = /^\/api\/export\/(script|postman|json|doc)$/.exec(path);
    if (exportMatch) {
      const session = store.getSession(sessionId);
      if (!session) {
        json(res, 404, { error: 'session not found' });
        return;
      }

      if (exportMatch[1] === 'doc') {
        const curlOptions = curlOptionsFrom(url.searchParams);
        // ?folder=ID exports that document alone; without it the whole session
        // comes out, each document as its own top-level section.
        const folderId = url.searchParams.get('folder');
        const folder = folderId ? store.getFolder(folderId) : null;
        const entries = store.listDocEntries(sessionId, folder?.id);
        const folders = folder ? [folder] : store.listFolders(sessionId);

        res.setHeader(
          'content-disposition',
          `attachment; filename="${folder ? fileNameFor(folder.name) : 'api-notes'}.md"`,
        );
        text(
          res,
          200,
          toMarkdown(entries, session, (entry) => curlForEntry(entry, curlOptions), folders),
          'text/markdown; charset=utf-8',
        );
        return;
      }

      const approved = store.listApproved(sessionId);
      const records = approved.length > 0 ? approved : store.listRequests(sessionId);
      const curlOptions = curlOptionsFrom(url.searchParams);

      switch (exportMatch[1]) {
        case 'script':
          res.setHeader('content-disposition', 'attachment; filename="curls.sh"');
          text(res, 200, toShellScript(records, session, curlOptions), 'text/x-shellscript; charset=utf-8');
          return;
        case 'postman':
          res.setHeader('content-disposition', 'attachment; filename="collection.json"');
          text(res, 200, toPostmanCollection(records, session, curlOptions), 'application/json; charset=utf-8');
          return;
        default:
          res.setHeader('content-disposition', 'attachment; filename="session.json"');
          text(res, 200, JSON.stringify({ session, records }, null, 2), 'application/json; charset=utf-8');
          return;
      }
    }

    json(res, 404, { error: `no route for ${req.method} ${path}` });
  }

  const broadcast = (message: unknown): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'status', status: statusPayload() }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  /**
   * Status is pushed rather than polled. The review UI is normally open in the
   * very browser being recorded, so a polling loop would be a request every few
   * seconds against the tool's own endpoint — traffic about ourselves, in a
   * window whose whole purpose is watching someone else's traffic.
   */
  const statusTimer = setInterval(() => {
    if (clients.size === 0) return;
    broadcast({ type: 'status', status: statusPayload() });
  }, 2000);
  statusTimer.unref();

  await new Promise<void>((resolve) => {
    // Bind to loopback only: the capture holds live credentials and has no
    // business being reachable from the network.
    server.listen(options.port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    setRecorder(next: Recorder | null) {
      recorder = next;
    },
    broadcast,
    async close() {
      clearInterval(statusTimer);
      for (const client of clients) client.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function recordMessage(record: RequestRecord): unknown {
  return { type: 'record', record: slim(record) };
}
