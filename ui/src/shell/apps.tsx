import type { ComponentType } from 'react';
import { curlExtractorUi } from '../apps/curl-extractor/app.tsx';
import { docRunnerUi } from '../apps/doc-runner/app.tsx';

/**
 * The client half of an app.
 *
 * The server's registry says which apps exist and what their cards read; this
 * says what to render when one is opened. They are kept apart so the dashboard
 * can list an app — including a coming-soon one — without its code being in the
 * bundle path of anything else.
 */
export type UiApp = {
  id: string;
  component: ComponentType;
  /**
   * A line for the dashboard card describing what this app is doing right now,
   * derived from its own status shape. Null when it is idle.
   *
   * This is why the dashboard needs no knowledge of any particular app: it asks
   * each one to describe itself instead of reaching into its status.
   */
  activity?(status: unknown): { label: string; tone: 'live' | 'warn' } | null;
};

const REGISTERED: UiApp[] = [curlExtractorUi, docRunnerUi];

export function findUiApp(id: string): UiApp | null {
  return REGISTERED.find((app) => app.id === id) ?? null;
}
