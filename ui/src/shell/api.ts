import type { AppManifest } from '@core/platform/app.ts';
// Type-only, so none of the updater's node: imports reach the browser bundle.
import type { UpdateStatus } from '@core/update/index.ts';

export type { AppManifest, UpdateStatus };

/** Every app the shell has mounted, plus whatever each of them is doing now. */
export type AppsResponse = {
  apps: AppManifest[];
  status: Record<string, unknown>;
};

export const shellApi = {
  apps: async (): Promise<AppsResponse> => {
    const res = await fetch('/api/apps');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as AppsResponse;
  },

  /** Whether a newer release exists. Answered from a cache on the server. */
  update: async (): Promise<UpdateStatus> => {
    const res = await fetch('/api/update');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as UpdateStatus;
  },

  /** Installs the newest release. The workspace must be reopened afterwards. */
  installUpdate: async (): Promise<{ installed: string }> => {
    const res = await fetch('/api/update', { method: 'POST' });
    const body = (await res.json()) as { installed?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return { installed: body.installed ?? 'the newest release' };
  },
};

/** Base path for an app's own routes. Apps build their URLs from this. */
export function appPath(appId: string): string {
  return `/api/apps/${appId}`;
}
