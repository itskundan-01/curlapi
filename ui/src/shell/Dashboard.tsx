import { useEffect, useState } from 'react';
import { shellApi, type AppManifest } from './api.ts';
import { findUiApp } from './apps.tsx';
import { useLive } from './live.tsx';
import { navigate } from './router.ts';

/**
 * The front page: what this workspace can do, and what it is doing.
 *
 * Rendered entirely from the server's app registry, so a new utility appears
 * here by being registered rather than by anything on this page being edited.
 */
export function Dashboard() {
  const [apps, setApps] = useState<AppManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status } = useLive();

  useEffect(() => {
    void shellApi
      .apps()
      .then((response) => setApps(response.apps))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  return (
    <main className="dashboard">
      <header className="dash-hero">
        <h1>Utilities</h1>
        <p>
          Small local tools for the parts of API work that are otherwise done by
          hand. Nothing starts until you open one — and nothing leaves this machine.
        </p>
        {/* What a beta means *here*, in terms of the work: your data is on disk
            and safe, but check what the tools produce before you trust it. */}
        <p className="dash-beta">
          <strong>Beta.</strong> Everything here works and is in daily use, but
          expect rough edges — check what a document import produced before you
          act on it, and treat generated commands as a starting point.
        </p>
      </header>

      {error && <div className="dash-error">Could not load the app list: {error}</div>}

      <div className="dash-grid">
        {apps?.map((manifest) => (
          <AppCard key={manifest.id} manifest={manifest} status={status[manifest.id]} />
        ))}
        {apps === null && !error && <p className="dash-loading">Loading…</p>}
      </div>
    </main>
  );
}

function AppCard({ manifest, status }: { manifest: AppManifest; status: unknown }) {
  const ready = manifest.status === 'ready';
  const activity = ready ? (findUiApp(manifest.id)?.activity?.(status) ?? null) : null;
  const open = (): void => {
    if (ready) navigate({ name: 'app', id: manifest.id });
  };

  return (
    <article
      className={`app-card${ready ? '' : ' soon'}`}
      // The whole card is the target, not just the link at the bottom: a card
      // that looks clickable everywhere and only works in one corner is worse
      // than one that does not look clickable at all.
      role={ready ? 'link' : undefined}
      tabIndex={ready ? 0 : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <div className="app-card-top">
        <span className="app-icon" aria-hidden="true">
          {manifest.icon}
        </span>
        {activity ? (
          <span className={`app-badge ${activity.tone}`}>
            <span className="dot" />
            {activity.label}
          </span>
        ) : (
          <span className={`app-badge ${ready ? 'ready' : 'soon'}`}>
            {ready ? 'Ready' : 'Coming soon'}
          </span>
        )}
      </div>

      <h2>{manifest.name}</h2>
      <p className="app-tagline">{manifest.tagline}</p>

      <ul className="app-highlights">
        {manifest.highlights.map((highlight) => (
          <li key={highlight}>{highlight}</li>
        ))}
      </ul>

      <span className="app-open">{ready ? 'Open →' : 'Not built yet'}</span>
    </article>
  );
}
