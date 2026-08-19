/**
 * Lifecycle for a workspace that was launched from an icon rather than a shell.
 *
 * Two things a terminal gives you for free have to be built here. The first is
 * "there is already one running" — clicking a dock icon twice must show the
 * window twice, not fail to bind port 7317 and die. The second is quitting:
 * there is no Ctrl-C to press, so the process has to notice the window is gone.
 *
 * It notices through the WebSocket every client holds open. That connection is
 * already there for status pushes, and its absence is the most direct evidence
 * available that nobody is looking at the workspace any more.
 */

import type { ShellHandle } from '../platform/shell.ts';

/**
 * How long to wait for the window to connect before concluding it never will.
 *
 * Generous, because this covers a cold Chrome start on a slow machine, and the
 * cost of being wrong is a server nobody can see holding a port.
 */
const STARTUP_GRACE_MS = 90_000;

/**
 * How long the socket may stay empty before the process exits.
 *
 * A page reload drops the connection and remakes it, typically inside a second.
 * This has to be comfortably longer than that, or refreshing the workspace would
 * quit the application under the user.
 */
const IDLE_GRACE_MS = 20_000;

/**
 * Asks a server already on this port whether it is one of ours.
 *
 * Checked by shape rather than by a lock file: a stale lock outlives the process
 * that wrote it, and something else entirely may hold the port. `/api/apps` is
 * answered only by a curlapi shell, so a reply is proof.
 */
export async function findRunningWorkspace(port: number): Promise<string | null> {
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/api/apps`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { apps?: unknown };
    return Array.isArray(body.apps) ? url : null;
  } catch {
    return null;
  }
}

export type IdleWatch = { stop(): void };

/**
 * Calls `onIdle` once the window has been closed, or never opened at all.
 *
 * Polls rather than hooking the socket's close event, because what matters is
 * not that a client disconnected but that none reconnected — and a poll
 * expresses "still empty a moment later" without any timer bookkeeping per
 * connection.
 */
export function watchForClose(shell: ShellHandle, onIdle: () => void): IdleWatch {
  const startedAt = Date.now();
  let everConnected = false;
  let emptySince: number | null = null;
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return;

    if (shell.clientCount() > 0) {
      everConnected = true;
      emptySince = null;
      return;
    }

    // Nothing connected yet, and the window has had long enough to show up.
    if (!everConnected) {
      if (Date.now() - startedAt > STARTUP_GRACE_MS) {
        fired = true;
        onIdle();
      }
      return;
    }

    emptySince ??= Date.now();
    if (Date.now() - emptySince > IDLE_GRACE_MS) {
      fired = true;
      onIdle();
    }
  }, 2_000);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
