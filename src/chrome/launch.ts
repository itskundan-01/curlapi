import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { locateBrowser, describeMissingBrowser } from './locate.ts';
import { CHROME_PROFILE } from '../paths.ts';

export type LaunchedBrowser = {
  port: number;
  /** Null when we attached to a browser someone else started. */
  process: ChildProcess | null;
  browserName: string;
  /**
   * Resolves once the browser process has actually exited. Chrome keeps writing
   * to its profile directory for a moment after being signalled, so anything
   * that touches that directory afterwards has to wait for this.
   */
  close(): Promise<void>;
};

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found near ${preferred}`);
}

/** Polls /json/version until the DevTools endpoint answers, or gives up. */
export async function waitForDevTools(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = (await res.json()) as { Browser?: string };
        return info.Browser ?? 'unknown';
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DevTools endpoint on port ${port} never became ready (${lastError})`);
}

const BASE_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  // Chrome's own first-run promos and sign-in nags fire network requests that
  // would otherwise show up as noise in the very first capture.
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--hide-crash-restore-bubble',
  // Restoring the previous session is actively harmful here: a restored tab
  // finishes loading before we are attached, so its traffic is never recorded
  // and the page looks like it is being ignored. Always start clean.
  '--no-restore-session-state',
  '--disable-session-crashed-bubble',
];

/**
 * Launches the user's installed Chrome against a dedicated profile directory.
 *
 * The dedicated profile is not optional: since Chrome 136, passing
 * --remote-debugging-port while using the *default* profile is silently ignored
 * (hardening against local cookie theft). Keeping our own profile under
 * ~/.curlapi means the flag works and the user's logins still persist between
 * runs, so browsing feels normal after the first sign-in.
 */
export async function launchBrowser(options: {
  port?: number;
  startUrl?: string;
  headless?: boolean;
  /** Overrides the shared profile; tests use a throwaway directory. */
  userDataDir?: string;
}): Promise<LaunchedBrowser> {
  const browser = locateBrowser();
  if (!browser) throw new Error(describeMissingBrowser());

  const port = await findFreePort(options.port ?? 9222);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.userDataDir ?? CHROME_PROFILE}`,
    ...BASE_FLAGS,
  ];
  if (options.headless) args.push('--headless=new');
  // Always open a blank tab rather than Chrome's New Tab Page: the NTP fetches
  // its own tiles, ads and logging endpoints, which would be the first thing the
  // user sees in a capture that should only contain their site.
  args.push(options.startUrl ?? 'about:blank');

  const child = spawn(browser.path, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    // Chrome is chatty on stderr; we only keep it to explain a startup failure.
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      reject(
        new Error(
          `${browser.name} exited before DevTools was ready (code ${code}).\n${stderr.trim()}`,
        ),
      );
    });
  });

  await Promise.race([waitForDevTools(port), exited]);

  return {
    port,
    process: child,
    browserName: browser.name,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      // Do not hang forever if Chrome refuses to go.
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    },
  };
}

/** Connects to a Chrome the user started themselves with --remote-debugging-port. */
export async function attachBrowser(port: number): Promise<LaunchedBrowser> {
  let version: string;
  try {
    version = await waitForDevTools(port, 3000);
  } catch {
    throw new Error(
      [
        `Nothing is listening for DevTools on port ${port}.`,
        '',
        'Start Chrome with remote debugging enabled first. Note that Chrome 136+',
        'ignores the flag on your default profile, so a separate profile is required:',
        '',
        process.platform === 'darwin'
          ? `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n    --remote-debugging-port=${port} --user-data-dir="$HOME/.curlapi/chrome-profile"`
          : `  google-chrome --remote-debugging-port=${port} --user-data-dir=~/.curlapi/chrome-profile`,
        '',
        'Or just run `curlapi start`, which does this for you.',
      ].join('\n'),
    );
  }
  return {
    port,
    process: null,
    browserName: version,
    async close() {
      /* not ours to close */
    },
  };
}
