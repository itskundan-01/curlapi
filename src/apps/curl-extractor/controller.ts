/**
 * A capture, as something that can be started and stopped while the tool runs.
 *
 * This used to be the shape of the process itself: `curlapi start <url>` launched
 * Chrome on the way up and tore it down on Ctrl-C, so the tool could not be
 * opened without committing to a capture, and a second capture meant a second
 * run. Everything here is that same lifecycle, lifted into an object the UI can
 * drive — which is what lets the dashboard ask for a target URL first and launch
 * the browser only once the user confirms it.
 *
 * The sequence is load-bearing and is kept in this order:
 *   session → browser → CDP → recorder → navigate
 * The tab is opened by the recorder rather than by Chrome's command line,
 * because a page handed to Chrome at launch starts fetching before Network is
 * enabled on its target and the first requests are lost.
 */

import { randomUUID } from 'node:crypto';
import { CdpConnection } from '../../capture/client.ts';
import { Recorder } from '../../capture/recorder.ts';
import { attachBrowser, launchBrowser, type LaunchedBrowser } from '../../chrome/launch.ts';
import type { Store } from '../../store/db.ts';
import type { RequestRecord } from '../../types.ts';
import { ensureDirs } from '../../paths.ts';

export type CaptureState = 'idle' | 'starting' | 'running' | 'stopping';

export type StartOptions = {
  /** Navigated to once the recorder is listening. Absent starts a blank tab. */
  url?: string;
  label?: string;
  headless?: boolean;
  /** Attach to a Chrome the user started themselves, instead of launching one. */
  attachPort?: number;
  /** Continue the most recent session rather than opening a new one. */
  resume?: boolean;
  /** Keep the whole capture instead of only what was selected. */
  keep?: boolean;
};

/** What a finished capture kept, for the summary the UI shows afterwards. */
export type CaptureSummary = {
  sessionId: string;
  label: string;
  /** Everything recorded, noise included. */
  total: number;
  documented: number;
  discarded: number;
  retained: number;
  bytes: number;
  /** False when nothing was selected and the session was not worth keeping. */
  sessionKept: boolean;
};

export type ControllerOptions = {
  store: Store;
  /** The shell's origin, excluded from the capture so the UI never records itself. */
  serverUrl: string;
  onRecord: (record: RequestRecord) => void;
  /** Fired whenever the capture starts, stops, or dies on its own. */
  onStateChange: () => void;
};

export class CaptureController {
  #options: ControllerOptions;
  #state: CaptureState = 'idle';
  #browser: LaunchedBrowser | null = null;
  #connection: CdpConnection | null = null;
  #recorder: Recorder | null = null;
  #sessionId: string | null = null;
  #startedUrl: string | null = null;
  /** The last capture's summary, so the UI can report it after Chrome closes. */
  #lastSummary: CaptureSummary | null = null;
  #error: string | null = null;

  constructor(options: ControllerOptions) {
    this.#options = options;
  }

  get state(): CaptureState {
    return this.#state;
  }

  get running(): boolean {
    return this.#state === 'running';
  }

  /** The session being recorded into, or null when nothing is running. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  get recorder(): Recorder | null {
    return this.#recorder;
  }

  get targetUrl(): string | null {
    return this.#startedUrl;
  }

  get lastSummary(): CaptureSummary | null {
    return this.#lastSummary;
  }

  /** Why the last start failed, cleared by the next successful one. */
  get error(): string | null {
    return this.#error;
  }

  async start(options: StartOptions = {}): Promise<{ sessionId: string }> {
    if (this.#state !== 'idle') {
      throw new Error(`a capture is already ${this.#state}`);
    }

    this.#state = 'starting';
    this.#error = null;
    this.#options.onStateChange();

    try {
      const sessionId = this.#openSession(options);
      await this.#attachBrowser(options);

      const connection = await CdpConnection.connect(
        await CdpConnection.browserUrl(this.#browser!.port),
      );
      this.#connection = connection;

      // Quitting Chrome by hand has to end the capture too. Without this the
      // dashboard would go on reporting "Recording" against a browser that is
      // no longer there, and the session would never be finalised or pruned.
      connection.onClose(() => {
        if (this.#connection === connection) void this.stop();
      });

      const recorder = new Recorder({
        connection,
        sessionId,
        store: this.#options.store,
        onRecord: this.#options.onRecord,
        ignoreOrigins: [this.#options.serverUrl, `http://localhost:${this.#port()}`],
      });
      this.#recorder = recorder;
      await recorder.start();

      if (options.url) {
        await recorder.openAndNavigate(options.url);
        this.#startedUrl = options.url;
      }

      this.#state = 'running';
      this.#options.onStateChange();
      return { sessionId };
    } catch (err) {
      // A half-started capture leaves a browser process and a socket behind, so
      // unwind before surfacing the failure rather than leaking either.
      this.#error = err instanceof Error ? err.message : String(err);
      await this.#teardown();
      this.#state = 'idle';
      this.#options.onStateChange();
      throw err;
    }
  }

  /**
   * Ends the capture and applies the retention rule.
   *
   * What survives is what the user deliberately picked — anything added to a
   * document, and anything approved into the collection. The rest was working
   * state, and discarding it here is what stops the database growing without
   * limit. `--keep` opts out.
   */
  async stop(options: { keep?: boolean } = {}): Promise<CaptureSummary | null> {
    if (this.#state === 'idle' || this.#state === 'stopping') return this.#lastSummary;

    const store = this.#options.store;
    const sessionId = this.#sessionId;
    this.#state = 'stopping';
    this.#options.onStateChange();

    await this.#recorder?.stop();

    let summary: CaptureSummary | null = null;
    if (sessionId) {
      store.endSession(sessionId, Date.now());

      const total = store.listRequests(sessionId, { includeNoise: true }).length;
      const documented = store.listDocEntries(sessionId).filter((e) => e.requestId).length;
      const discarded = options.keep === true ? 0 : store.pruneSession(sessionId);
      const retained = store.listRequests(sessionId, { includeNoise: true }).length;
      const session = store.getSession(sessionId);
      const bytes = store.sessionBytes(sessionId);

      const sessionKept = !store.isSessionEmpty(sessionId);
      // Nothing was picked, so there is nothing worth a row in the session list.
      if (!sessionKept) store.deleteSession(sessionId);

      summary = {
        sessionId,
        label: session?.label ?? '',
        total,
        documented,
        discarded,
        retained,
        bytes,
        sessionKept,
      };
    }

    await this.#teardown();
    this.#lastSummary = summary;
    this.#state = 'idle';
    this.#options.onStateChange();
    return summary;
  }

  #port(): number {
    return Number(new URL(this.#options.serverUrl).port || 80);
  }

  /**
   * Creates or resumes the session this capture writes into.
   *
   * Resuming means a restart adds to the same numbered list rather than starting
   * again from #1. Everything is on disk either way; the review UI can switch
   * between sessions.
   */
  #openSession(options: StartOptions): string {
    ensureDirs();
    const store = this.#options.store;

    const resumeTarget = options.resume === true ? store.listSessions()[0] : null;
    const sessionId = resumeTarget?.id ?? randomUUID();

    if (!resumeTarget) {
      store.createSession({
        id: sessionId,
        label:
          options.label?.trim() ||
          (options.url ? labelFor(options.url) : `Capture ${new Date().toLocaleString()}`),
        startedAt: Date.now(),
        endedAt: null,
        primaryHost: null,
      });
    }

    // Old captures are cleared before this one starts, so history cannot pile
    // up in the background. Documented and approved endpoints are kept.
    if (options.keep !== true) store.pruneHistory(sessionId);

    this.#sessionId = sessionId;
    this.#startedUrl = options.url ?? null;
    return sessionId;
  }

  async #attachBrowser(options: StartOptions): Promise<void> {
    if (typeof options.attachPort === 'number') {
      this.#browser = await attachBrowser(options.attachPort);
      return;
    }
    // Deliberately launched with no URL: a page Chrome opens for itself starts
    // loading before we are attached, so the target is navigated to afterwards.
    this.#browser = await launchBrowser({ headless: options.headless === true });
  }

  async #teardown(): Promise<void> {
    // Ask Chrome to exit properly. Killing the process instead makes Chrome
    // treat the next launch as crash recovery and restore these tabs, which
    // silently breaks the following capture: a restored tab finishes loading
    // before we are attached, so none of its traffic is recorded.
    if (this.#connection) {
      await this.#connection.trySend('Browser.close');
      await new Promise((resolve) => setTimeout(resolve, 300));
      this.#connection.close();
    }
    await this.#browser?.close();

    this.#connection = null;
    this.#browser = null;
    this.#recorder = null;
    this.#sessionId = null;
    this.#startedUrl = null;
  }

  get browserName(): string | null {
    return this.#browser?.browserName ?? null;
  }
}

/** A capture named after what it is pointed at, rather than when it was run. */
function labelFor(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
