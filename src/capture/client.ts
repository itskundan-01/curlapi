import WebSocket from 'ws';

export type CdpEvent = {
  method: string;
  params: Record<string, unknown>;
  /** Present for events from an attached target when using flat sessions. */
  sessionId?: string;
};

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/**
 * A minimal DevTools Protocol client.
 *
 * Written by hand rather than pulled from a library because the only thing we
 * need beyond raw JSON-over-WebSocket is request/response correlation, and
 * flat-session routing (the `sessionId` field) has to be exact — that is what
 * lets a single connection observe every tab, iframe and service worker.
 */
export class CdpConnection {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #listeners = new Set<(event: CdpEvent) => void>();
  #closeListeners = new Set<() => void>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (data: WebSocket.RawData) => this.#handleMessage(String(data)));
    socket.on('close', () => this.#failAll(new Error('DevTools connection closed')));
    socket.on('error', (err: Error) => this.#failAll(err));
  }

  static async connect(webSocketUrl: string): Promise<CdpConnection> {
    const socket = new WebSocket(webSocketUrl, {
      // CDP frames carrying response bodies routinely exceed the 100MB default.
      maxPayload: 512 * 1024 * 1024,
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new CdpConnection(socket);
  }

  /** Resolves the browser-level WebSocket endpoint for a debugging port. */
  static async browserUrl(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) throw new Error(`DevTools /json/version returned HTTP ${res.status}`);
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) {
      throw new Error('DevTools did not report a browser WebSocket URL');
    }
    return info.webSocketDebuggerUrl;
  }

  #handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message['id'] === 'number') {
      const call = this.#pending.get(message['id']);
      if (!call) return;
      this.#pending.delete(message['id']);
      const error = message['error'] as { message?: string } | undefined;
      if (error) call.reject(new Error(error.message ?? 'CDP error'));
      else call.resolve((message['result'] as Record<string, unknown>) ?? {});
      return;
    }

    if (typeof message['method'] === 'string') {
      const event: CdpEvent = {
        method: message['method'],
        params: (message['params'] as Record<string, unknown>) ?? {},
        sessionId: message['sessionId'] as string | undefined,
      };
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch (err) {
          // A throwing handler must not take down the capture loop.
          console.error('[curlapi] event handler failed:', err);
        }
      }
    }
  }

  #failAll(error: Error): void {
    const wasOpen = !this.#closed;
    this.#closed = true;
    for (const call of this.#pending.values()) call.reject(error);
    this.#pending.clear();
    // Only the first transition fires: an error is normally followed by a close,
    // and a capture must not be torn down twice.
    if (!wasOpen) return;
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[curlapi] close handler failed:', err);
      }
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error('DevTools connection closed'));
    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload['sessionId'] = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  /** Fire-and-forget for calls whose failure should not interrupt capture. */
  async trySend(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.send(method, params, sessionId);
    } catch {
      return null;
    }
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Fires when the browser goes away without being asked to.
   *
   * Now that a capture starts and stops while the tool keeps running, quitting
   * Chrome by hand has to end the capture too — otherwise the dashboard goes on
   * reporting "Recording" against a browser that no longer exists.
   */
  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#socket.close();
  }
}
