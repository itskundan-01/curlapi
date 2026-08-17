/**
 * The cURL Extractor app: capture a browser session, review it, export it.
 *
 * This is the original curlapi, unchanged in what it does and rehomed in what
 * owns it. The routes below were the whole server; they are now one app's
 * routes, mounted under `/api/apps/curl-extractor`, and the browser they depend
 * on is started by {@link CaptureController} when the user asks for it rather
 * than by the process on the way up.
 */

import { randomUUID } from 'node:crypto';
import type { AppContext, AppInstance, AppModule, RouteRequest } from '../../platform/app.ts';
import { json, readJsonBody, text } from '../../platform/http.ts';
import type {
  BodySummary,
  CurlOptions,
  DocEntry,
  RequestRecord,
  SlimRecord,
} from '../../types.ts';
import { DEFAULT_CURL_OPTIONS } from '../../types.ts';
import type { Store } from '../../store/db.ts';
import { buildCurl } from '../../curl/build.ts';
import { replay } from '../../replay/run.ts';
import { toShellScript } from '../../export/script.ts';
import { toPostmanCollection } from '../../export/postman.ts';
import { toMarkdown } from '../../export/doc.ts';
import { assessReplayability } from '../../analyze/replayability.ts';
import { findDependencies } from '../../analyze/links.ts';
import { CaptureController, type StartOptions } from './controller.ts';
import { manifest } from './manifest.ts';

function summarize(
  body: { encoding: 'text' | 'base64'; data: string; truncated: boolean } | null,
): BodySummary | null {
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

/**
 * Rejects anything that is not an http(s) URL.
 *
 * The target now arrives from a form rather than from the user's own shell, so
 * it is worth refusing `file:` and `javascript:` here instead of handing them
 * to Page.navigate and finding out what happens.
 */
function normalizeTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // A bare host is what people type; assume https rather than failing on it.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export class CurlExtractorApp implements AppInstance {
  #store: Store;
  #context: AppContext;
  #controller: CaptureController;
  /**
   * The session the UI is looking at, when the user has picked one explicitly.
   *
   * Null means "follow the capture", which is what a fresh page load wants.
   * Without this a stored capture would become unreachable the moment the next
   * one begins — still on disk, but with nothing able to show it, which is
   * indistinguishable from having lost it.
   */
  #viewingSessionId: string | null = null;

  constructor(context: AppContext) {
    this.#context = context;
    this.#store = context.store;
    this.#controller = new CaptureController({
      store: context.store,
      serverUrl: context.serverUrl,
      onRecord: (record) => context.broadcast({ type: 'record', record: slim(record) }),
      onStateChange: () => {
        // A new capture pulls the view back to itself; the user can step away
        // again with the session picker.
        if (this.#controller.running) this.#viewingSessionId = null;
        context.pushStatus();
      },
    });
  }

  /** Exposed so the CLI can start a capture the moment the shell is up. */
  get capture(): CaptureController {
    return this.#controller;
  }

  /** Opens the workspace on a stored session, for `curlapi ui --session ID`. */
  viewSession(id: string): boolean {
    if (!this.#store.getSession(id)) return false;
    this.#viewingSessionId = id;
    return true;
  }

  /** The session on screen: the user's pick, the live capture, or the newest. */
  get #sessionId(): string {
    return (
      this.#viewingSessionId ??
      this.#controller.sessionId ??
      this.#store.listSessions()[0]?.id ??
      ''
    );
  }

  status(): unknown {
    const store = this.#store;
    const sessionId = this.#sessionId;
    const captureSessionId = this.#controller.sessionId;
    const recorder = this.#controller.recorder;

    const all = sessionId ? store.listRequests(sessionId, { includeNoise: true }) : [];
    const kept = all.filter((record) => record.verdict.keep);
    const session = sessionId ? store.getSession(sessionId) : null;

    return {
      capture: {
        state: this.#controller.state,
        targetUrl: this.#controller.targetUrl,
        browserName: this.#controller.browserName,
        error: this.#controller.error,
        lastSummary: this.#controller.lastSummary,
      },
      sessionId,
      captureSessionId,
      /** True while viewing the session the recorder is writing into. */
      viewingCapture: captureSessionId !== null && sessionId === captureSessionId,
      session,
      sessions: store.listSessionSummaries(),
      capturing: this.#controller.running,
      paused: recorder?.paused ?? false,
      primaryHost: recorder?.primaryHost ?? session?.primaryHost ?? null,
      staleTabs: recorder?.staleTabs ?? [],
      counts: {
        total: all.length,
        kept: kept.length,
        approved: all.filter((record) => record.approved).length,
        // Counted over kept requests only: a filtered-out tracker pixel 404ing
        // is not something anyone is trying to debug.
        failed: kept.filter((record) => record.error !== null || (record.status ?? 0) >= 400)
          .length,
      },
      storedBytes: sessionId ? store.sessionBytes(sessionId) : 0,
    };
  }

  async dispose(): Promise<void> {
    await this.#controller.stop();
  }

  async handle(request: RouteRequest): Promise<boolean> {
    const { path, method, url, req, res } = request;
    const store = this.#store;
    const sessionId = this.#sessionId;

    // --- capture lifecycle ---------------------------------------------------

    if (path === '/capture/start' && method === 'POST') {
      const body = await readJsonBody(req);
      const raw = typeof body['url'] === 'string' ? body['url'] : '';
      const target = raw.length > 0 ? normalizeTarget(raw) : null;

      // An unusable URL has to fail before Chrome is launched, not after.
      if (raw.length > 0 && !target) {
        json(res, 400, { error: `"${raw}" is not an http or https URL` });
        return true;
      }

      const options: StartOptions = {
        url: target ?? undefined,
        label: typeof body['label'] === 'string' ? body['label'] : undefined,
        headless: body['headless'] === true,
        resume: body['resume'] === true,
        keep: body['keep'] === true,
        attachPort: typeof body['attachPort'] === 'number' ? body['attachPort'] : undefined,
      };

      try {
        const started = await this.#controller.start(options);
        json(res, 200, { ok: true, sessionId: started.sessionId, status: this.status() });
      } catch (err) {
        json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
          status: this.status(),
        });
      }
      return true;
    }

    if (path === '/capture/stop' && method === 'POST') {
      const body = await readJsonBody(req);
      const summary = await this.#controller.stop({ keep: body['keep'] === true });
      json(res, 200, { ok: true, summary, status: this.status() });
      return true;
    }

    // --- session-level reads -------------------------------------------------

    if (path === '/status') {
      json(res, 200, this.status());
      return true;
    }

    if (path === '/sessions' && method === 'GET') {
      json(res, 200, store.listSessionSummaries());
      return true;
    }

    // Switching what the UI shows. Recording is unaffected — it keeps writing
    // into the capture session, so browsing an old one never costs live traffic.
    if (path === '/session' && method === 'POST') {
      const body = await readJsonBody(req);
      const next = typeof body['id'] === 'string' ? store.getSession(body['id']) : null;
      if (!next) {
        json(res, 404, { error: 'no such session' });
        return true;
      }
      this.#viewingSessionId = next.id;
      this.#context.pushStatus();
      json(res, 200, this.status());
      return true;
    }

    const sessionMatch = /^\/sessions\/(.+)$/.exec(path);
    if (sessionMatch && method === 'DELETE') {
      const id = decodeURIComponent(sessionMatch[1]);
      if (id === this.#controller.sessionId) {
        json(res, 409, { error: 'cannot delete the session being recorded' });
        return true;
      }
      store.deleteSession(id);
      // Fall back to whatever the default view resolves to now.
      if (this.#viewingSessionId === id) this.#viewingSessionId = null;
      json(res, 200, { ok: true, status: this.status() });
      return true;
    }

    if (path === '/requests') {
      const includeNoise = url.searchParams.get('noise') === '1';
      json(res, 200, store.listRequests(sessionId, { includeNoise }).map(slim));
      return true;
    }

    if (path === '/approved') {
      json(res, 200, store.listApproved(sessionId).map(slim));
      return true;
    }

    // Rendering the collection needs every approved command at once; one round
    // trip per card would make the options toggles feel sluggish.
    if (path === '/curls') {
      const curlOptions = curlOptionsFrom(url.searchParams);
      json(
        res,
        200,
        store.listApproved(sessionId).map((record) => ({
          id: record.id,
          curl: buildCurl(record, curlOptions),
        })),
      );
      return true;
    }

    // --- per-request operations ---------------------------------------------

    const requestMatch = /^\/requests\/(.+?)(?:\/(curl|replay|approve|title))?$/.exec(path);
    if (requestMatch) {
      const id = decodeURIComponent(requestMatch[1]);
      const action = requestMatch[2];
      // Falls back to a document's own copy, so anything documented stays
      // viewable, copyable and runnable after its capture has been discarded.
      const record = store.getRequest(id) ?? store.getDocSnapshot(id);
      if (!record) {
        json(res, 404, { error: `no request ${id}` });
        return true;
      }

      if (action === 'curl') {
        text(
          res,
          200,
          buildCurl(record, curlOptionsFrom(url.searchParams)),
          'text/plain; charset=utf-8',
        );
        return true;
      }

      if (action === 'replay' && method === 'POST') {
        json(res, 200, await replay(record));
        return true;
      }

      if (action === 'approve' && method === 'POST') {
        const body = await readJsonBody(req);
        store.setApproved(id, body['approved'] !== false);
        const updated = store.getRequest(id);
        json(res, 200, updated ? slim(updated) : null);
        return true;
      }

      if (action === 'title' && method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
        store.setTitle(id, title.length > 0 ? title : null);
        const updated = store.getRequest(id);
        json(res, 200, updated ? slim(updated) : null);
        return true;
      }

      if (!action) {
        // Flow analysis rides along with the detail view: whether this request
        // can be replayed at all, and which earlier response fed it its values.
        json(res, 200, {
          ...record,
          replayability: assessReplayability(record),
          dependencies: findDependencies(record, store.listRequests(sessionId)),
        });
        return true;
      }
    }

    // --- bulk operations -----------------------------------------------------

    if (path === '/approve-many' && method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.setApprovedMany(ids, body['approved'] !== false);
      json(res, 200, { ok: true, count: ids.length });
      return true;
    }

    if (path === '/clear' && method === 'POST') {
      // The document is intentionally left alone: entries fall back to their
      // snapshotted command, so clearing a noisy list never costs notes.
      const removed = store.clearRequests(sessionId);
      // Numbering restarts too, so the next request shows up as #1 rather than
      // continuing from wherever the cleared list happened to end. Only when the
      // live session is the one being cleared — resetting it while looking at an
      // old capture would renumber traffic the user can't even see.
      if (sessionId === this.#controller.sessionId) this.#controller.recorder?.resetSequence();
      json(res, 200, { ok: true, removed });
      return true;
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

    if (path === '/doc') {
      if (method === 'POST') {
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
          return true;
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
        return true;
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
      return true;
    }

    if (path === '/doc/order' && method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.reorderDocEntries(ids);
      json(res, 200, { ok: true });
      return true;
    }

    // --- document folders ----------------------------------------------------

    if (path === '/folders') {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body['name'] === 'string' ? body['name'] : '';
        json(res, 200, store.createFolder(sessionId, name));
        return true;
      }
      json(res, 200, store.listFolders(sessionId));
      return true;
    }

    if (path === '/folders/order' && method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.reorderFolders(ids);
      json(res, 200, { ok: true });
      return true;
    }

    const folderMatch = /^\/folders\/(.+)$/.exec(path);
    if (folderMatch) {
      const id = decodeURIComponent(folderMatch[1]);
      if (method === 'DELETE') {
        json(res, 200, { ok: true, removed: store.deleteFolder(id) });
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body['name'] === 'string') store.renameFolder(id, body['name']);
        json(res, 200, { ok: true });
        return true;
      }
    }

    const docMatch = /^\/doc\/(.+)$/.exec(path);
    if (docMatch) {
      const id = decodeURIComponent(docMatch[1]);
      if (method === 'DELETE') {
        store.deleteDocEntry(id);
        json(res, 200, { ok: true });
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        store.updateDocEntry(id, {
          title: typeof body['title'] === 'string' ? body['title'] : undefined,
          note: typeof body['note'] === 'string' ? body['note'] : undefined,
        });
        if (typeof body['folderId'] === 'string' && store.getFolder(body['folderId'])) {
          store.moveDocEntry(id, body['folderId']);
        }
        json(res, 200, { ok: true });
        return true;
      }
    }

    // --- collection ordering -------------------------------------------------

    if (path === '/order' && method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
      store.setOrder(ids);
      json(res, 200, { ok: true });
      return true;
    }

    // --- capture control -----------------------------------------------------

    if (path === '/reload' && method === 'POST') {
      const reloaded = (await this.#controller.recorder?.reloadPages()) ?? 0;
      // The stale-tab warning is gone now; pushing means it disappears on the
      // click rather than on the next two-second tick.
      this.#context.pushStatus();
      json(res, 200, { ok: true, reloaded });
      return true;
    }

    if (path === '/pause' && method === 'POST') {
      const body = await readJsonBody(req);
      this.#controller.recorder?.setPaused(body['paused'] === true);
      this.#context.pushStatus();
      json(res, 200, { paused: this.#controller.recorder?.paused ?? false });
      return true;
    }

    // --- exports -------------------------------------------------------------

    const exportMatch = /^\/export\/(script|postman|json|doc)$/.exec(path);
    if (exportMatch) {
      const session = store.getSession(sessionId);
      if (!session) {
        json(res, 404, { error: 'session not found' });
        return true;
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
        return true;
      }

      const approved = store.listApproved(sessionId);
      const records = approved.length > 0 ? approved : store.listRequests(sessionId);
      const curlOptions = curlOptionsFrom(url.searchParams);

      switch (exportMatch[1]) {
        case 'script':
          res.setHeader('content-disposition', 'attachment; filename="curls.sh"');
          text(
            res,
            200,
            toShellScript(records, session, curlOptions),
            'text/x-shellscript; charset=utf-8',
          );
          return true;
        case 'postman':
          res.setHeader('content-disposition', 'attachment; filename="collection.json"');
          text(
            res,
            200,
            toPostmanCollection(records, session, curlOptions),
            'application/json; charset=utf-8',
          );
          return true;
        default:
          res.setHeader('content-disposition', 'attachment; filename="session.json"');
          text(
            res,
            200,
            JSON.stringify({ session, records }, null, 2),
            'application/json; charset=utf-8',
          );
          return true;
      }
    }

    return false;
  }
}

export const curlExtractorApp: AppModule = {
  manifest,
  create: (context) => new CurlExtractorApp(context),
};
