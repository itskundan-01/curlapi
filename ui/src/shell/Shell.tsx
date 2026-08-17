import { useEffect, useState } from 'react';
import { Dashboard } from './Dashboard.tsx';
import { findUiApp } from './apps.tsx';
import { LiveProvider } from './live.tsx';
import { navigate, useRoute } from './router.ts';
import { shellApi, type AppManifest } from './api.ts';
import { useTheme } from './theme.ts';

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
              {current ? `${current.icon}  ${current.name}` : route.id}
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
                <span aria-hidden="true">{manifest.icon}</span>
                {manifest.name}
              </button>
            ))}
          </nav>
        )}

        <button
          className="btn icon"
          title="Switch theme"
          aria-label="Switch theme"
          onClick={toggle}
        >
          ◐
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
