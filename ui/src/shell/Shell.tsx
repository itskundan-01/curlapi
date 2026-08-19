import { useEffect, useState } from 'react';
import { Dashboard } from './Dashboard.tsx';
import { findUiApp } from './apps.tsx';
import { LiveProvider } from './live.tsx';
import { navigate, useRoute } from './router.ts';
import { shellApi, type AppManifest, type UpdateStatus } from './api.ts';
import { useTheme } from './theme.ts';
import { AppIcon, IconTheme, Wordmark } from './icons.tsx';

/**
 * The frame every page sits in.
 *
 * It owns only what is the same everywhere — where you are, how to get back, and
 * the theme. Apps render their own toolbars below this, because a capture needs
 * a session picker and a document importer will not.
 */
export function Shell() {
  return (
    <LiveProvider>
      <ShellFrame />
    </LiveProvider>
  );
}

function ShellFrame() {
  const route = useRoute();
  const { toggle } = useTheme();
  const [manifests, setManifests] = useState<AppManifest[]>([]);

  useEffect(() => {
    void shellApi
      .apps()
      .then((response) => setManifests(response.apps))
      .catch(() => undefined);
  }, []);

  const current =
    route.name === 'app' ? manifests.find((app) => app.id === route.id) : undefined;
  const ui = route.name === 'app' ? findUiApp(route.id) : null;

  return (
    <div className="shell">
      <div className="rail">
        <button
          className="rail-brand"
          onClick={() => navigate({ name: 'dashboard' })}
          title="Back to the dashboard"
        >
          <Wordmark size={15} />
          curlapi
        </button>
        {/* Stated on every screen rather than only on the front page: the thing
            people need to know about a beta is what it means for the work in
            front of them, and they may have arrived here from a bookmark. */}
        <span className="rail-beta" title="Beta — the shape of things may still change">
          beta
        </span>

        {route.name === 'app' && (
          <>
            <span className="rail-sep" aria-hidden="true">
              /
            </span>
            <span className="rail-here">
              {current && <AppIcon id={current.id} fallback={current.icon} size={13} />}
              {current ? current.name : route.id}
            </span>
          </>
        )}

        <div className="spacer" />

        {manifests.length > 1 && (
          <nav className="rail-apps">
            {manifests.map((manifest) => (
              <button
                key={manifest.id}
                className="rail-app"
                aria-current={route.name === 'app' && route.id === manifest.id}
                disabled={manifest.status !== 'ready'}
                title={
                  manifest.status === 'ready'
                    ? manifest.tagline
                    : `${manifest.name} — coming soon`
                }
                onClick={() => navigate({ name: 'app', id: manifest.id })}
              >
                <AppIcon id={manifest.id} fallback={manifest.icon} size={13} />
                {manifest.name}
              </button>
            ))}
          </nav>
        )}

        <UpdateChip />

        <button
          className="btn ghost icon rail-theme"
          title="Switch theme"
          aria-label="Switch theme"
          onClick={toggle}
        >
          <IconTheme size={15} />
        </button>
      </div>

      <div className="shell-body">
        {route.name === 'dashboard' && <Dashboard />}
        {route.name === 'app' && ui && <ui.component />}
        {route.name === 'app' && !ui && <UnknownApp id={route.id} />}
      </div>
    </div>
  );
}

/**
 * Says when there is a newer release, and installs it.
 *
 * Renders nothing at all in the normal case, which is most of the time — a
 * permanent "you are up to date" badge would be chrome earning its space about
 * twice a year.
 *
 * The install is offered only where it can actually be done. A copy running from
 * a source checkout or from npm shows the version and leaves it there, because
 * replacing those files is the other tool's job and doing it here would leave its
 * metadata describing something that is no longer on disk.
 */
function UpdateChip() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void shellApi
      .update()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  if (installed) {
    return (
      <span className="rail-update done" title="The new version runs once curlapi is reopened">
        Updated to {installed} — reopen curlapi
      </span>
    );
  }

  if (!status?.available) return null;

  if (!status.updatable) {
    return (
      <span className="rail-update" title={status.reason ?? undefined}>
        {status.latest} available
      </span>
    );
  }

  const install = (): void => {
    setInstalling(true);
    setFailed(null);
    void shellApi
      .installUpdate()
      .then((result) => setInstalled(result.installed))
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(false));
  };

  return (
    <button
      className="rail-update"
      onClick={install}
      disabled={installing}
      title={failed ?? `Install curlapi ${status.latest}, replacing ${status.current}`}
    >
      {installing ? 'Updating…' : failed ? 'Update failed — retry' : `Update to ${status.latest}`}
    </button>
  );
}

function UnknownApp({ id }: { id: string }) {
  return (
    <main className="dashboard">
      <header className="dash-hero">
        <h1>No app called “{id}”</h1>
        <p>It may have been renamed, or this link may be from an older version.</p>
      </header>
      <button className="btn primary" onClick={() => navigate({ name: 'dashboard' })}>
        Back to the dashboard
      </button>
    </main>
  );
}
