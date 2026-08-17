import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * One WebSocket for the whole workspace, shared by every app.
 *
 * Status is pushed over it rather than polled, because a review UI is normally
 * open in the very browser being recorded and a polling loop would show up as a
 * request every few seconds in the list it exists to display. With more than one
 * app on the page that argument only gets stronger, so the socket is opened once
 * here and messages are routed by the `app` field on each frame.
 */

type Envelope = Record<string, unknown> & { app: string | null; type: string };

type LiveValue = {
  /** Latest status for every app, keyed by app id. */
  status: Record<string, unknown>;
  /** True once the socket is open; false while it is reconnecting. */
  connected: boolean;
  /** Receives every non-status frame addressed to `appId`. */
  subscribe(appId: string, handler: (message: Envelope) => void): () => void;
};

const LiveContext = createContext<LiveValue>({
  status: {},
  connected: false,
  subscribe: () => () => undefined,
});

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const [connected, setConnected] = useState(false);
  const subscribers = useRef(new Map<string, Set<(message: Envelope) => void>>());

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const open = (): void => {
      if (closed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/ws`);

      socket.onopen = () => setConnected(true);

      socket.onmessage = (event: MessageEvent<string>) => {
        let message: Envelope;
        try {
          message = JSON.parse(event.data) as Envelope;
        } catch {
          return; // malformed frame
        }

        if (message.type === 'status' && message['apps']) {
          setStatus(message['apps'] as Record<string, unknown>);
          return;
        }

        if (!message.app) return;
        for (const handler of subscribers.current.get(message.app) ?? []) {
          handler(message);
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(open, 1200);
      };
    };

    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  // Stable across renders on purpose: a subscribe that changed with every status
  // push would tear down and re-establish each app's subscription twice a
  // second, and a record arriving in that gap would be dropped.
  const subscribe = useCallback<LiveValue['subscribe']>((appId, handler) => {
    const existing = subscribers.current.get(appId) ?? new Set();
    existing.add(handler);
    subscribers.current.set(appId, existing);
    return () => existing.delete(handler);
  }, []);

  const value = useMemo<LiveValue>(
    () => ({ status, connected, subscribe }),
    [status, connected, subscribe],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue {
  return useContext(LiveContext);
}

/** The latest status an app published, or null before the first push arrives. */
export function useAppStatus<T>(appId: string): T | null {
  const { status } = useLive();
  return (status[appId] as T | undefined) ?? null;
}

/**
 * Subscribes to an app's pushed messages.
 *
 * The handler is held in a ref so a component can pass an inline closure without
 * tearing down and re-establishing the subscription on every render.
 */
export function useAppMessages(
  appId: string,
  handler: (message: Record<string, unknown>) => void,
): void {
  const { subscribe } = useLive();
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(
    () => subscribe(appId, (message) => latest.current(message)),
    [appId, subscribe],
  );
}
