import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
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

export function ensureDirs(): void {
  for (const dir of [HOME, CHROME_PROFILE, EXPORT_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}
