/**
 * The window the desktop launcher opens.
 *
 * curlapi has no bundled browser and does not want one. The workspace is a page
 * served on loopback, and Chromium-family browsers can show a page as a plain
 * window with no tab strip and no address bar — `--app=URL`. So the "desktop
 * app" is the browser the user already has, minus its chrome, and the download
 * stays at a few megabytes instead of carrying a second Chromium.
 *
 * The window gets a profile directory of its own, deliberately not the one
 * captures use. Two Chrome processes sharing a `--user-data-dir` do not stay two
 * processes: the second exits immediately and hands its arguments to the first,
 * which would mean a capture launch quietly attaching to the window instead of
 * owning a browser it can instrument.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { locateBrowser } from '../chrome/locate.ts';
import { HOME } from '../paths.ts';

/** Profile for the workspace window. Never the capture profile — see above. */
export const WINDOW_PROFILE = join(HOME, 'window-profile');

export type WindowKind = 'app-window' | 'browser-tab';

/** Opens a URL in whatever the platform's default browser is. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is always printed as well, so there is still a way in.
  }
}

/**
 * Shows the workspace as its own window, falling back to a browser tab.
 *
 * The fallback is not a failure case worth reporting loudly: a tab is a
 * perfectly good way to use the tool, and it is what the CLI has always done.
 */
export function openWindow(url: string): WindowKind {
  let browser;
  try {
    browser = locateBrowser();
  } catch {
    // A bad CURLAPI_CHROME override should not cost the user their window.
    browser = null;
  }

  if (!browser) {
    openInBrowser(url);
    return 'browser-tab';
  }

  mkdirSync(WINDOW_PROFILE, { recursive: true });

  try {
    const child = spawn(
      browser.path,
      [
        `--app=${url}`,
        `--user-data-dir=${WINDOW_PROFILE}`,
        // Matches StartupWMClass in the .desktop file, so Linux docks group the
        // window under curlapi's icon rather than under Chrome's.
        '--class=curlapi',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--window-size=1360,900',
        // Chrome asks the OS keyring for a key to encrypt saved credentials
        // with, and on a profile it has never seen that surfaces as a macOS
        // keychain unlock prompt — before the workspace has even appeared, from
        // an application the user has just installed. This profile exists only
        // to display a page on loopback: nothing is signed into it and nothing
        // is saved from it, so there is nothing for that key to protect. These
        // two flags are how browser-automation tools have always avoided the
        // same prompt, one for macOS and one for the Linux keyrings.
        '--use-mock-keychain',
        '--password-store=basic',
      ],
      { stdio: 'ignore', detached: true },
    );
    child.unref();
    return 'app-window';
  } catch {
    openInBrowser(url);
    return 'browser-tab';
  }
}
