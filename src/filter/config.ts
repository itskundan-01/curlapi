import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FILTERS_PATH } from '../paths.ts';
import { DEFAULT_CONFIG, type FilterConfig } from './rules.ts';

let cached: FilterConfig | null = null;

/**
 * Loads the user's filter overrides, merged shallowly over the defaults so a
 * config that only sets `allowDomains` still gets every built-in rule.
 */
export function loadConfig(): FilterConfig {
  if (cached) return cached;
  if (!existsSync(FILTERS_PATH)) {
    cached = DEFAULT_CONFIG;
    return cached;
  }
  try {
    const raw = JSON.parse(readFileSync(FILTERS_PATH, 'utf8')) as Partial<FilterConfig>;
    cached = { ...DEFAULT_CONFIG, ...raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[curlapi] ignoring malformed ${FILTERS_PATH}: ${message}`);
    cached = DEFAULT_CONFIG;
  }
  return cached;
}

export function reloadConfig(): FilterConfig {
  cached = null;
  return loadConfig();
}

/** Writes the effective defaults out so the user has something to edit. */
export function writeDefaultConfig(): string {
  writeFileSync(FILTERS_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  return FILTERS_PATH;
}
