import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Everything the tool persists lives under one directory the user can delete. */
export const HOME = process.env.CURLAPI_HOME ?? join(homedir(), '.curlapi');

export const DB_PATH = join(HOME, 'curlapi.db');
export const FILTERS_PATH = join(HOME, 'filters.json');

/**
 * Chrome refuses --remote-debugging-port on its default profile (a deliberate
 * hardening change in Chrome 136 against cookie theft), so we always run against
 * a profile of our own. Logins persist here between runs.
 */
export const CHROME_PROFILE = join(HOME, 'chrome-profile');

export const EXPORT_DIR = join(HOME, 'exports');

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(here, '..');
export const UI_DIST = join(PROJECT_ROOT, 'ui', 'dist');

/**
 * The version, read from package.json rather than duplicated here.
 *
 * A second copy of a version number is a second thing to forget to bump, and the
 * one people quote in a bug report should be the one npm installed.
 */
const MANIFEST: { version?: string; repository?: { url?: string } } = (() => {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
      repository?: { url?: string };
    };
  } catch {
    return {};
  }
})();

export const VERSION: string = MANIFEST.version ?? 'unknown';

/**
 * The `owner/name` the updater asks GitHub about.
 *
 * Read from the manifest rather than written out again, for the same reason the
 * version is: a fork that changes one and not the other would check the original
 * repository for its updates and quietly install someone else's build.
 */
export const REPO: string = (() => {
  const url = MANIFEST.repository?.url ?? '';
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  return match ? match[1] : 'itskundan-01/curlapi';
})();

/**
 * True when this copy was put here by the desktop installer.
 *
 * The updater replaces the application directory wholesale, which is right for
 * an install that owns that directory and wrong for one npm owns — there, `npm
 * update` is the mechanism, and overwriting the package behind npm's back leaves
 * its metadata describing a version that is no longer on disk.
 */
export const IS_MANAGED_INSTALL: boolean =
  PROJECT_ROOT === join(HOME, 'app') || PROJECT_ROOT.startsWith(join(HOME, 'app') + '/');

export function ensureDirs(): void {
  for (const dir of [HOME, CHROME_PROFILE, EXPORT_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}
