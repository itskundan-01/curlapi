/**
 * The shell: one local server that hosts every utility.
 *
 * It owns the things that are the same for all of them — the port, the database,
 * the static UI, the WebSocket every client already holds open — and nothing
 * else. Starting Chrome, parsing a document, or anything else with a lifecycle
 * of its own belongs to an app, and does not happen until the user opens that
 * app and asks for it.
 *
 * That is the whole reason this layer exists: booting the process used to mean
 * launching a browser, so the tool could not be opened without committing to a
 * capture. Now `curlapi` opens a dashboard and costs nothing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Store } from '../store/db.ts';
import type { AppInstance, AppManifest, AppModule } from './app.ts';
import { json } from './http.ts';
import { serveStatic } from '../server/static.ts';
import { applyUpdate, checkForUpdate, type UpdateStatus } from '../update/index.ts';

export type ShellOptions = {
  store: Store;
  port: number;
  /** Which utilities to mount. Defaults to the full registry. */
  modules: AppModule[];
};

export type ShellHandle = {
  port: number;
  url: string;
  /** The mounted app instances, by manifest id — for the CLI to drive directly. */
  app<T extends AppInstance>(id: string): T | null;
  manifests: AppManifest[];
  broadcast(message: unknown): void;
  /** Pushes current status for every app to every client. */
  pushStatus(): void;
  /**
   * How many clients currently hold the WebSocket open.
   *
   * The desktop launcher is the only caller: started from an icon there is no
   * terminal to press Ctrl-C in, so "the user closed the window" has to be
   * inferred, and the socket going quiet is the signal.
   */
  clientCount(): number;
  close(): Promise<void>;
};

/** Message envelope. `app` is null for shell-level messages. */
type Envelope = Record<string, unknown> & { app: string | null; type: string };

/**
 * The last answer GitHub gave about releases, and when.
 *
 * Cached at module scope because the dashboard asks on every load and the answer
 * changes a few times a year. Without this, leaving the workspace open in a tab
 * that reloads would be a steady trickle of requests to a third party from a
 * tool whose whole premise is that it runs locally.
 */
let updateCache: { at: number; status: UpdateStatus } | null = null;
const UPDATE_CACHE_MS = 30 * 60 * 1000;

async function updateStatus(force: boolean): Promise<UpdateStatus> {
  if (!force && updateCache && Date.now() - updateCache.at < UPDATE_CACHE_MS) {
    return updateCache.status;
  }
  const status = await checkForUpdate();
  // Only a definite answer is worth caching: a failed check leaves `latest`
  // null, and holding that for half an hour would hide an update from someone
  // who was merely offline for a moment.
  if (status.latest) updateCache = { at: Date.now(), status };
  return status;
}

export async function startShell(options: ShellOptions): Promise<ShellHandle> {
  const clients = new Set<WebSocket>();
  const instances = new Map<string, AppInstance>();

  const broadcast = (message: unknown): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };

  /**
   * Status for every mounted app in one message.
   *
   * Sent as a single frame rather than one per app so a client never renders a
   * half-updated dashboard, and so an app with nothing running costs one null.
   */
  const statusMessage = (): Envelope => {
    const apps: Record<string, unknown> = {};
    for (const [id, instance] of instances) {
      try {
        apps[id] = instance.status();
      } catch {
        // A broken status must not take down the push for the others.
        apps[id] = null;
      }
    }
    return { app: null, type: 'status', apps };
  };

  const pushStatus = (): void => {
    if (clients.size === 0) return;
    broadcast(statusMessage());
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

    // Anything that is not an API call is the single-page UI, including the
    // app routes like /apps/curl-extractor — they resolve client-side.
    if (!path.startsWith('/api/')) {
      serveStatic(path, res);
      return;
    }

    if (path === '/api/apps') {
      json(res, 200, {
        apps: options.modules.map((module) => module.manifest),
        status: statusMessage().apps,
      });
      return;
    }

    if (path === '/api/update' && req.method === 'GET') {
      json(res, 200, await updateStatus(url.searchParams.get('refresh') === '1'));
      return;
    }

    if (path === '/api/update' && req.method === 'POST') {
      const status = await updateStatus(true);
      if (!status.release || !status.available) {
        json(res, 409, { error: 'There is no newer release to install.' });
        return;
      }
      try {
        await applyUpdate(status.release);
        // The running process still has the old code loaded, so the update is
        // only real once it restarts — say so rather than implying otherwise.
        updateCache = null;
        json(res, 200, { installed: status.release.version, restartRequired: true });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const appMatch = /^\/api\/apps\/([^/]+)(\/.*)?$/.exec(path);
    if (appMatch) {
      const instance = instances.get(appMatch[1]);
      if (!instance) {
        json(res, 404, { error: `no app "${appMatch[1]}"` });
        return;
      }
      const handled = await instance.handle({
        path: appMatch[2] ?? '/',
        method: req.method ?? 'GET',
        url,
        req,
        res,
      });
      if (handled) return;
      json(res, 404, {
        error: `no route for ${req.method} ${path} in app ${appMatch[1]}`,
      });
      return;
    }

    json(res, 404, { error: `no route for ${req.method} ${path}` });
  }

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify(statusMessage()));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  /**
   * Status is pushed rather than polled. A review UI is normally open in the
   * very browser being recorded, so a polling loop would be a request every few
   * seconds against the tool's own endpoint — traffic about ourselves, in a
   * window whose whole purpose is watching someone else's traffic.
   */
  const statusTimer = setInterval(pushStatus, 2000);
  statusTimer.unref();

  await new Promise<void>((resolve, reject) => {
    // A port collision is the one startup failure users actually hit, and the
    // raw errno for it says nothing about what to do. It is also invisible when
    // the workspace was launched from a desktop icon, so it has to arrive as a
    // sentence rather than as a stack trace.
    const onListenError = (err: NodeJS.ErrnoException): void => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${options.port} is already in use by something else. ` +
                'Close whatever is holding it, or choose another with --ui-port.',
            )
          : err,
      );
    };

    // Both, because the WebSocket server attaches to this HTTP server and
    // re-emits its errors as its own. Handling only the HTTP side still crashes
    // the process, on the copy of the event nobody is listening for.
    server.once('error', onListenError);
    wss.once('error', onListenError);

    // Loopback only: captures hold live credentials and have no business being
    // reachable from the network.
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onListenError);
      wss.off('error', onListenError);
      // A socket error once we are serving is not a startup failure and must not
      // take the workspace down with it — the promise has settled, so an
      // unhandled 'error' here would be fatal rather than reported.
      wss.on('error', (err: Error) => {
        console.error(`WebSocket server error: ${err.message}`);
      });
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://127.0.0.1:${port}`;

  // Instances are created after the socket is bound, because an app that
  // instruments a browser needs this origin to exclude it from its own capture.
  for (const module of options.modules) {
    instances.set(
      module.manifest.id,
      module.create({
        store: options.store,
        serverUrl: url,
        broadcast: (message) => broadcast({ ...message, app: module.manifest.id }),
        pushStatus,
      }),
    );
  }

  return {
    port,
    url,
    manifests: options.modules.map((module) => module.manifest),
    app<T extends AppInstance>(id: string): T | null {
      return (instances.get(id) as T | undefined) ?? null;
    },
    broadcast,
    pushStatus,
    clientCount: () => clients.size,
    async close() {
      clearInterval(statusTimer);
      for (const instance of instances.values()) await instance.dispose();
      for (const client of clients) client.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
