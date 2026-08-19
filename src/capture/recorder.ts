import type {
  HeaderPair,
  RequestBody,
  RequestRecord,
  ResponseBody,
  RedirectHop,
} from '../types.ts';
import { CdpConnection, type CdpEvent } from './client.ts';
import { evaluate, type StagedVerdict } from '../filter/verdict.ts';
import { loadConfig } from '../filter/config.ts';
import type { FilterConfig } from '../filter/rules.ts';
import { shortName } from '../analyze/shortname.ts';
import type { Store } from '../store/db.ts';

/** Bodies above this are stored truncated; the shape is what matters, not the bulk. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Cap on retained WebSocket frames per connection. */
const MAX_WS_FRAMES = 200;

type Pending = {
  key: string;
  requestId: string;
  cdpSessionId: string | undefined;
  seq: number;
  url: string;
  method: string;
  resourceType: string;
  /** Headers as reported by requestWillBeSent — incomplete on purpose, see merge. */
  requestHeaders: HeaderPair[];
  /** Headers as actually sent, from requestWillBeSentExtraInfo. Authoritative. */
  extraRequestHeaders: HeaderPair[] | null;
  /** CDP's own promise that an extra-info event is still coming for this request. */
  expectRequestExtraInfo: boolean;
  expectResponseExtraInfo: boolean;
  requestBody: RequestBody | null;
  hasPostData: boolean;
  status: number | null;
  statusText: string;
  responseHeaders: HeaderPair[];
  extraResponseHeaders: HeaderPair[] | null;
  mimeType: string;
  responseSize: number;
  startedAt: number;
  endedAt: number | null;
  redirectChain: RedirectHop[];
  error: string | null;
  verdict: StagedVerdict;
  wsFrames: string[];
  finalized: boolean;
};

export type RecorderOptions = {
  connection: CdpConnection;
  sessionId: string;
  store: Store;
  onRecord: (record: RequestRecord) => void;
  maxBodyBytes?: number;
  /**
   * Origins to discard outright — in practice the review UI's own address, so
   * that opening it in the instrumented browser does not record the tool
   * talking to itself.
   */
  ignoreOrigins?: string[];
};

/**
 * CDP reports duplicate headers by joining them with newlines, which is how
 * multiple set-cookie values arrive. Splitting them back out keeps each one
 * addressable instead of collapsing them into a single unusable string.
 */
function headersToPairs(headers: unknown): HeaderPair[] {
  if (!headers || typeof headers !== 'object') return [];
  const out: HeaderPair[] = [];
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    for (const part of String(value).split('\n')) out.push([name, part]);
  }
  return out;
}

/**
 * Combines the two header views CDP provides for one request.
 *
 * `Network.requestWillBeSent` fires while the request is still being assembled,
 * so its header set is missing cookies and several `sec-*` values that the
 * network stack appends afterwards. `requestWillBeSentExtraInfo` carries what
 * actually went on the wire. DevTools merges the two internally; a tool that
 * reads only the first event produces curl commands that look complete and then
 * fail with 401 — the single most common way this kind of capture goes wrong.
 */
export function mergeHeaders(
  fromRequest: HeaderPair[],
  fromExtraInfo: HeaderPair[] | null,
): HeaderPair[] {
  if (!fromExtraInfo || fromExtraInfo.length === 0) return fromRequest;
  const authoritative = new Set(fromExtraInfo.map(([name]) => name.toLowerCase()));
  const supplemental = fromRequest.filter(
    ([name]) => !authoritative.has(name.toLowerCase()),
  );
  return [...fromExtraInfo, ...supplemental];
}

/** Cap on extra-info events parked waiting for a parent that may never come. */
const MAX_ORPHANS = 500;

/**
 * Holds an extra-info payload whose parent event has not arrived (or has already
 * been finalised). Bounded so a long session cannot accumulate them forever;
 * evicting the oldest is safe because a parent that has not appeared by now
 * never will.
 */
function park(store: Map<string, HeaderPair[]>, key: string, headers: HeaderPair[]): void {
  store.set(key, headers);
  while (store.size > MAX_ORPHANS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

export class Recorder {
  #connection: CdpConnection;
  #sessionId: string;
  #store: Store;
  #onRecord: (record: RequestRecord) => void;
  #maxBodyBytes: number;
  #config: FilterConfig;
  #ignoreOrigins: string[];

  #pending = new Map<string, Pending>();
  /** ExtraInfo can arrive before its parent event, so it is parked here. */
  #orphanRequestExtra = new Map<string, HeaderPair[]>();
  #orphanResponseExtra = new Map<string, HeaderPair[]>();
  #attached = new Set<string>();
  /** targetId -> sessionId, populated only once a target is fully instrumented. */
  #readyTargets = new Map<string, string>();
  /** Page targets that had already finished loading when we attached. */
  #staleTabs = new Set<string>();
  #primaryHost: string | null = null;
  #seq: number;
  #unsubscribe: (() => void) | null = null;
  #paused = false;
  /**
   * Set once `stop` has finished, after which nothing may touch the store.
   *
   * Unsubscribing removes the listener but cannot cancel a `#handleEvent` that
   * is already partway through its awaits. One of those resuming after the
   * capture has been torn down would write to a database the caller has since
   * closed — which surfaces as an unhandled rejection during shutdown, long
   * after the line that caused it.
   */
  #stopped = false;

  constructor(options: RecorderOptions) {
    this.#connection = options.connection;
    this.#sessionId = options.sessionId;
    this.#store = options.store;
    this.#onRecord = options.onRecord;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#config = loadConfig();
    this.#ignoreOrigins = options.ignoreOrigins ?? [];
    this.#seq = options.store.nextSeq(options.sessionId);
  }

  get primaryHost(): string | null {
    return this.#primaryHost;
  }

  /**
   * Pages that were already sitting on a real URL when we attached to them.
   *
   * Their load finished before instrumentation existed, so nothing of it was
   * recorded. Surfacing them lets the UI say so and offer a reload, instead of
   * leaving the user staring at a page that looks like it is being ignored.
   */
  get staleTabs(): string[] {
    return [...this.#staleTabs];
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  get paused(): boolean {
    return this.#paused;
  }

  async start(): Promise<void> {
    this.#unsubscribe = this.#connection.onEvent((event) => {
      void this.#handleEvent(event);
    });

    await this.#connection.send('Target.setDiscoverTargets', { discover: true });
    // waitForDebuggerOnStart lets us turn Network on before a new page executes,
    // so requests fired during startup are not missed.
    await this.#connection.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // Snapshotted because finalising removes entries from the map.
    for (const pending of [...this.#pending.values()]) {
      if (!pending.finalized) await this.#finalize(pending);
    }
    // Set last, not first: the loop above is the legitimate final write, and it
    // has to happen while the store is still open. Everything after this point
    // is an event that arrived too late to belong to the capture.
    this.#stopped = true;
  }

  async #handleEvent(event: CdpEvent): Promise<void> {
    if (this.#stopped) return;
    switch (event.method) {
      case 'Target.attachedToTarget':
        await this.#onTargetAttached(event);
        return;
      case 'Target.detachedFromTarget': {
        const gone = event.params['sessionId'] as string | undefined;
        if (gone) {
          this.#attached.delete(gone);
          for (const [targetId, sessionId] of this.#readyTargets) {
            if (sessionId === gone) this.#readyTargets.delete(targetId);
          }
        }
        return;
      }
      case 'Page.frameNavigated':
        this.#onFrameNavigated(event);
        return;
      default:
        break;
    }

    if (this.#paused) return;
    if (!event.method.startsWith('Network.')) return;

    const key = this.#keyFor(event);
    switch (event.method) {
      case 'Network.requestWillBeSent':
        this.#onRequestWillBeSent(event, key);
        return;
      case 'Network.requestWillBeSentExtraInfo':
        this.#onRequestExtraInfo(event, key);
        return;
      case 'Network.responseReceived':
        this.#onResponseReceived(event, key);
        return;
      case 'Network.responseReceivedExtraInfo':
        this.#onResponseExtraInfo(event, key);
        return;
      case 'Network.loadingFinished':
        await this.#onLoadingFinished(event, key);
        return;
      case 'Network.loadingFailed':
        await this.#onLoadingFailed(event, key);
        return;
      case 'Network.webSocketCreated':
        this.#onWebSocketCreated(event, key);
        return;
      case 'Network.webSocketWillSendHandshakeRequest':
        this.#onWebSocketHandshakeRequest(event, key);
        return;
      case 'Network.webSocketHandshakeResponseReceived':
        this.#onWebSocketHandshakeResponse(event, key);
        return;
      case 'Network.webSocketFrameSent':
        this.#onWebSocketFrame(event, key, 'sent');
        return;
      case 'Network.webSocketFrameReceived':
        this.#onWebSocketFrame(event, key, 'received');
        return;
      case 'Network.webSocketClosed':
        await this.#onWebSocketClosed(key);
        return;
      default:
        return;
    }
  }

  /** requestIds are only unique within a target session, so scope the key. */
  #keyFor(event: CdpEvent): string {
    return `${event.sessionId ?? 'root'}:${String(event.params['requestId'] ?? '')}`;
  }

  async #onTargetAttached(event: CdpEvent): Promise<void> {
    const sessionId = event.params['sessionId'] as string | undefined;
    const targetInfo = event.params['targetInfo'] as
      | { type?: string; targetId?: string; url?: string }
      | undefined;
    if (!sessionId || this.#attached.has(sessionId)) return;
    // A second session on the same target would duplicate every event it emits.
    const targetId = targetInfo?.targetId;
    if (targetId && this.#readyTargets.has(targetId)) return;
    this.#attached.add(sessionId);

    const type = targetInfo?.type ?? '';

    // Buffers are raised well above the default so response bodies survive long
    // enough to be fetched on a busy page.
    await this.#connection.trySend(
      'Network.enable',
      { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 20_000_000 },
      sessionId,
    );

    if (type === 'page' || type === 'iframe') {
      await this.#connection.trySend('Page.enable', {}, sessionId);
    }

    // Recurse so out-of-process iframes and workers spawned later are also seen.
    await this.#connection.trySend(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );

    // Release the target that setAutoAttach paused for us.
    await this.#connection.trySend('Runtime.runIfWaitingForDebugger', {}, sessionId);

    // Registered last, so anything waiting on this target knows Network is live.
    if (targetId) this.#readyTargets.set(targetId, sessionId);

    // A page already showing real content loaded before we could watch it.
    const url = targetInfo?.url ?? '';
    if (
      type === 'page' &&
      /^https?:/.test(url) &&
      !this.#isOwnTraffic(url)
    ) {
      this.#staleTabs.add(url);
    }
  }

  /**
   * Reloads every attached page, so a tab that was open before capture started
   * replays its traffic through the recorder.
   */
  async reloadPages(): Promise<number> {
    let reloaded = 0;
    for (const sessionId of this.#readyTargets.values()) {
      const result = await this.#connection.trySend('Page.reload', {}, sessionId);
      if (result !== null) reloaded++;
    }
    this.#staleTabs.clear();
    return reloaded;
  }

  async #waitForTarget(targetId: string, timeoutMs = 10_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sessionId = this.#readyTargets.get(targetId);
      if (sessionId) return sessionId;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  /**
   * Opens a tab and navigates it only after Network is enabled on that target.
   *
   * Handing a URL straight to Chrome (or to Target.createTarget) starts fetching
   * before instrumentation is in place, and the document plus its first
   * stylesheet, image and script are lost — they surface later as
   * `loadingFinished` events for requests that were never announced.
   */
  async openAndNavigate(url: string): Promise<void> {
    const created = (await this.#connection.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId?: string };
    const targetId = created.targetId;
    if (!targetId) throw new Error('Chrome did not return a target id');

    const sessionId = await this.#waitForTarget(targetId);
    if (!sessionId) throw new Error('timed out instrumenting the new tab');

    await this.#connection.send('Page.navigate', { url }, sessionId);
  }

  #onFrameNavigated(event: CdpEvent): void {
    const frame = event.params['frame'] as
      | { parentId?: string; url?: string }
      | undefined;
    // Only the top-level frame defines the site under test.
    if (!frame || frame.parentId || !frame.url) return;
    // The review UI is usually open in this same browser; letting its tab claim
    // primaryHost would make every real request look third-party.
    if (this.#isOwnTraffic(frame.url)) return;
    // Navigating means this page's traffic is now flowing through the recorder,
    // so it is no longer one of the tabs we missed.
    this.#staleTabs.delete(frame.url);
    try {
      const host = new URL(frame.url).hostname;
      if (!host) return;
      this.#primaryHost = host;
      this.#store.setPrimaryHost(this.#sessionId, host);
    } catch {
      /* about:blank and friends */
    }
  }

  #evaluate(input: {
    url: string;
    method: string;
    resourceType: string;
    mimeType?: string;
  }): StagedVerdict {
    if (this.#isOwnTraffic(input.url)) {
      return { keep: false, stage: 'ignore', score: 0, reason: 'curlapi UI traffic' };
    }
    return evaluate({ ...input, primaryHost: this.#primaryHost }, this.#config);
  }

  #isOwnTraffic(url: string): boolean {
    return this.#ignoreOrigins.some((origin) => url.startsWith(origin));
  }

  /**
   * Restarts serial numbering. Called when the user clears the capture: leaving
   * the counter where it was would show the next request as #192 in a list that
   * was just emptied.
   */
  resetSequence(): void {
    this.#seq = 1;
  }

  #onRequestWillBeSent(event: CdpEvent, key: string): void {
    const request = event.params['request'] as
      | { url?: string; method?: string; headers?: unknown; postData?: string; hasPostData?: boolean }
      | undefined;
    if (!request?.url) return;

    const resourceType = String(event.params['type'] ?? 'Other');
    const redirectResponse = event.params['redirectResponse'] as
      | { url?: string; status?: number; headers?: Record<string, string> }
      | undefined;

    const existing = this.#pending.get(key);

    // A redirect reuses the same requestId: record the hop and carry on with the
    // new URL rather than losing the original request.
    const redirectChain: RedirectHop[] = existing ? [...existing.redirectChain] : [];
    if (redirectResponse && existing) {
      redirectChain.push({
        url: redirectResponse.url ?? existing.url,
        status: redirectResponse.status ?? 0,
        location: redirectResponse.headers?.['location'] ?? null,
      });
    }

    const url = request.url;
    const method = String(request.method ?? 'GET');
    const verdict = this.#evaluate({ url, method, resourceType });

    // Never recorded at all: this tool talking to its own UI, `data:` payloads,
    // extension traffic. Persisting these would burn serial numbers and bury the
    // site's real requests under a stream of our own status polling.
    if (verdict.stage === 'ignore') {
      this.#pending.delete(key);
      return;
    }

    const headers = headersToPairs(request.headers);
    const orphan = this.#orphanRequestExtra.get(key) ?? null;
    if (orphan) this.#orphanRequestExtra.delete(key);

    const timestampMs = Number(event.params['wallTime'] ?? 0) * 1000 || Date.now();

    this.#pending.set(key, {
      key,
      requestId: String(event.params['requestId'] ?? ''),
      cdpSessionId: event.sessionId,
      seq: existing?.seq ?? this.#seq++,
      url,
      method,
      resourceType,
      requestHeaders: headers,
      // A redirect hop is a new request: the previous hop's wire headers do not
      // describe it, so they are dropped rather than carried forward.
      extraRequestHeaders: orphan ?? (redirectResponse ? null : existing?.extraRequestHeaders ?? null),
      expectRequestExtraInfo: event.params['hasExtraInfo'] === true,
      expectResponseExtraInfo: false,
      requestBody: request.postData
        ? { encoding: 'text', data: request.postData, truncated: false }
        : null,
      hasPostData: Boolean(request.hasPostData),
      status: null,
      statusText: '',
      responseHeaders: [],
      extraResponseHeaders: null,
      mimeType: '',
      responseSize: 0,
      startedAt: existing?.startedAt ?? timestampMs,
      endedAt: null,
      redirectChain,
      error: null,
      verdict,
      wsFrames: [],
      finalized: false,
    });
  }

  #onRequestExtraInfo(event: CdpEvent, key: string): void {
    const headers = headersToPairs(event.params['headers']);
    if (headers.length === 0) return;
    const pending = this.#pending.get(key);
    if (pending) pending.extraRequestHeaders = headers;
    else park(this.#orphanRequestExtra, key, headers);
  }

  #onResponseReceived(event: CdpEvent, key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    const response = event.params['response'] as
      | { status?: number; statusText?: string; headers?: unknown; mimeType?: string; encodedDataLength?: number }
      | undefined;
    if (!response) return;

    pending.status = response.status ?? null;
    pending.statusText = String(response.statusText ?? '');
    pending.responseHeaders = headersToPairs(response.headers);
    pending.mimeType = String(response.mimeType ?? '');
    pending.expectResponseExtraInfo = event.params['hasExtraInfo'] === true;

    const orphan = this.#orphanResponseExtra.get(key);
    if (orphan) {
      pending.extraResponseHeaders = orphan;
      this.#orphanResponseExtra.delete(key);
    }

    // Content type is often the deciding signal, so re-run the filter now that
    // we finally have it.
    if (pending.verdict.stage === 'maybe') {
      pending.verdict = this.#evaluate({
        url: pending.url,
        method: pending.method,
        resourceType: pending.resourceType,
        mimeType: pending.mimeType,
      });
    }
  }

  #onResponseExtraInfo(event: CdpEvent, key: string): void {
    const headers = headersToPairs(event.params['headers']);
    if (headers.length === 0) return;
    const pending = this.#pending.get(key);
    if (pending) pending.extraResponseHeaders = headers;
    else park(this.#orphanResponseExtra, key, headers);
  }

  async #onLoadingFinished(event: CdpEvent, key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (!pending) return;
    pending.responseSize = Number(event.params['encodedDataLength'] ?? 0);
    pending.endedAt = Date.now();
    await this.#finalize(pending);
  }

  async #onLoadingFailed(event: CdpEvent, key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (!pending) return;
    const canceled = Boolean(event.params['canceled']);
    pending.error = canceled
      ? 'canceled'
      : String(event.params['errorText'] ?? 'request failed');
    pending.endedAt = Date.now();
    await this.#finalize(pending);
  }

  #onWebSocketCreated(event: CdpEvent, key: string): void {
    const url = String(event.params['url'] ?? '');
    if (!url) return;
    const wsVerdict = this.#evaluate({ url, method: 'GET', resourceType: 'WebSocket' });
    if (wsVerdict.stage === 'ignore') return;
    this.#pending.set(key, {
      key,
      requestId: String(event.params['requestId'] ?? ''),
      cdpSessionId: event.sessionId,
      seq: this.#seq++,
      url,
      method: 'GET',
      resourceType: 'WebSocket',
      requestHeaders: [],
      extraRequestHeaders: null,
      requestBody: null,
      hasPostData: false,
      status: null,
      statusText: '',
      responseHeaders: [],
      extraResponseHeaders: null,
      mimeType: 'application/websocket',
      responseSize: 0,
      startedAt: Date.now(),
      endedAt: null,
      redirectChain: [],
      error: null,
      expectRequestExtraInfo: false,
      expectResponseExtraInfo: false,
      verdict: wsVerdict,
      wsFrames: [],
      finalized: false,
    });
  }

  #onWebSocketHandshakeRequest(event: CdpEvent, key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    const request = event.params['request'] as { headers?: unknown } | undefined;
    pending.requestHeaders = headersToPairs(request?.headers);
  }

  #onWebSocketHandshakeResponse(event: CdpEvent, key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    const response = event.params['response'] as
      | { status?: number; statusText?: string; headers?: unknown; requestHeaders?: unknown }
      | undefined;
    if (!response) return;
    pending.status = response.status ?? null;
    pending.statusText = String(response.statusText ?? '');
    pending.responseHeaders = headersToPairs(response.headers);
    // The handshake response echoes the full request headers actually sent.
    const echoed = headersToPairs(response.requestHeaders);
    if (echoed.length > 0) pending.extraRequestHeaders = echoed;
  }

  #onWebSocketFrame(event: CdpEvent, key: string, direction: 'sent' | 'received'): void {
    const pending = this.#pending.get(key);
    if (!pending || pending.wsFrames.length >= MAX_WS_FRAMES) return;
    const response = event.params['response'] as { payloadData?: string } | undefined;
    const payload = String(response?.payloadData ?? '');
    pending.wsFrames.push(
      `${direction === 'sent' ? '>>' : '<<'} ${payload.slice(0, 4000)}`,
    );
  }

  async #onWebSocketClosed(key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (!pending) return;
    pending.endedAt = Date.now();
    await this.#finalize(pending);
  }

  async #fetchPostData(pending: Pending): Promise<void> {
    if (pending.requestBody || !pending.hasPostData) return;
    const result = await this.#connection.trySend(
      'Network.getRequestPostData',
      { requestId: pending.requestId },
      pending.cdpSessionId,
    );
    const data = result?.['postData'];
    if (typeof data === 'string') {
      pending.requestBody = { encoding: 'text', data, truncated: false };
    }
  }

  async #fetchResponseBody(pending: Pending): Promise<ResponseBody | null> {
    if (pending.resourceType === 'WebSocket') {
      if (pending.wsFrames.length === 0) return null;
      return {
        encoding: 'text',
        data: pending.wsFrames.join('\n'),
        truncated: pending.wsFrames.length >= MAX_WS_FRAMES,
      };
    }

    const result = await this.#connection.trySend(
      'Network.getResponseBody',
      { requestId: pending.requestId },
      pending.cdpSessionId,
    );
    // Bodies get evicted from Chrome's buffer under load; a miss is normal and
    // must not lose the rest of the record.
    if (!result || typeof result['body'] !== 'string') return null;

    const base64 = Boolean(result['base64Encoded']);
    const body = result['body'];
    const truncated = body.length > this.#maxBodyBytes;
    return {
      encoding: base64 ? 'base64' : 'text',
      data: truncated ? body.slice(0, this.#maxBodyBytes) : body,
      truncated,
    };
  }

  /**
   * Waits for extra-info events that CDP has told us are still on their way.
   *
   * `requestWillBeSent` and `responseReceived` each carry a `hasExtraInfo` flag,
   * and the matching `...ExtraInfo` event is delivered on a separate path that
   * can lag behind `loadingFinished` when the machine is busy. Finalising
   * immediately would discard the only complete header set we get — losing the
   * cookie, and producing a command that 401s. The wait is bounded, and is
   * normally zero because the extra info has already arrived.
   */
  async #awaitExtraInfo(pending: Pending, timeoutMs = 2000): Promise<void> {
    const outstanding = (): boolean =>
      (pending.expectRequestExtraInfo && pending.extraRequestHeaders === null) ||
      (pending.expectResponseExtraInfo && pending.extraResponseHeaders === null);

    if (!outstanding()) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!outstanding()) return;
    }
  }

  async #finalize(pending: Pending): Promise<void> {
    // The guard has to be here as well as in #handleEvent: a handler that was
    // already suspended mid-await when the capture stopped resumes and lands
    // straight here, having passed the entry check long ago.
    if (this.#stopped) return;
    if (pending.finalized) return;
    // Claimed before the await so a second terminal event cannot re-enter, but
    // the entry stays in #pending so late extra-info events still find it.
    pending.finalized = true;
    await this.#awaitExtraInfo(pending);

    this.#pending.delete(pending.key);
    this.#orphanRequestExtra.delete(pending.key);
    this.#orphanResponseExtra.delete(pending.key);

    // An unresolved 'maybe' at this point never got a content type; settle it
    // against whatever we know so the record carries a definite reason.
    if (pending.verdict.stage === 'maybe') {
      pending.verdict = this.#evaluate({
        url: pending.url,
        method: pending.method,
        resourceType: pending.resourceType,
        mimeType: pending.mimeType,
      });
    }

    let responseBody: ResponseBody | null = null;
    if (pending.verdict.keep) {
      // Bodies are fetched only for survivors. This is the whole size story:
      // the 22MB HAR was mostly bodies belonging to requests like these that
      // were never worth keeping.
      await this.#fetchPostData(pending);
      responseBody = await this.#fetchResponseBody(pending);
    }

    let parsed: URL | null = null;
    try {
      parsed = new URL(pending.url);
    } catch {
      /* keep the raw string below */
    }

    const record: RequestRecord = {
      id: `${this.#sessionId}:${pending.key}`,
      sessionId: this.#sessionId,
      seq: pending.seq,
      url: pending.url,
      method: pending.method,
      host: parsed?.host ?? '',
      path: parsed?.pathname ?? pending.url,
      query: parsed?.search ?? '',
      shortName: shortName(pending.url),
      resourceType: pending.resourceType,
      requestHeaders: mergeHeaders(pending.requestHeaders, pending.extraRequestHeaders),
      requestBody: pending.requestBody,
      status: pending.status,
      statusText: pending.statusText,
      responseHeaders: mergeHeaders(pending.responseHeaders, pending.extraResponseHeaders),
      mimeType: pending.mimeType,
      responseBody,
      responseSize: pending.responseSize,
      startedAt: pending.startedAt,
      endedAt: pending.endedAt,
      durationMs: pending.endedAt ? pending.endedAt - pending.startedAt : null,
      redirectChain: pending.redirectChain,
      error: pending.error,
      verdict: {
        keep: pending.verdict.keep,
        reason: pending.verdict.reason,
        score: pending.verdict.score,
      },
      approved: false,
      actionGroup: null,
      title: null,
      orderIndex: null,
    };

    this.#store.upsertRequest(record);
    this.#onRecord(record);
  }
}
