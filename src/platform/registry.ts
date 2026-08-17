/**
 * Every utility the shell knows about, in the order the dashboard shows them.
 *
 * Adding a utility means writing its module and adding one line here. Nothing
 * else in the shell, the CLI or the UI router needs to know it exists — the
 * dashboard is rendered from this list, and its routes are mounted under
 * `/api/apps/<id>` automatically.
 *
 * Modules must not import `store/db.ts` for its value: the entry point defers
 * that on purpose (see suppress-warnings.ts), and a static import here would
 * pull node:sqlite in during module linking and undo it.
 */

import type { AppModule } from './app.ts';
import { curlExtractorApp } from '../apps/curl-extractor/index.ts';
import { docRunnerApp } from '../apps/doc-runner/index.ts';

export const APPS: AppModule[] = [curlExtractorApp, docRunnerApp];

export function findApp(id: string): AppModule | null {
  return APPS.find((app) => app.manifest.id === id) ?? null;
}
