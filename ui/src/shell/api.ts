import type { AppManifest } from '@core/platform/app.ts';

export type { AppManifest };

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
};

/** Base path for an app's own routes. Apps build their URLs from this. */
export function appPath(appId: string): string {
  return `/api/apps/${appId}`;
}
