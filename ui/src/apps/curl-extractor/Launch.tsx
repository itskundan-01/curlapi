import { useState } from 'react';
import { api, type CaptureSummary, type SessionSummary, type Status } from './api.ts';
import { formatBytes } from '../../util.ts';

/**
 * What the app opens on: where to point the browser, asked before it exists.
 *
 * The tool used to take its target on the command line and launch Chrome as it
 * started, which meant deciding what to capture before seeing anything. Asking
 * here instead is the whole reason the browser's lifecycle was lifted out of the
 * process's — nothing is launched until this form is submitted.
 */
export function Launch({
  status,
  onOpenSession,
}: {
  status: Status | null;
  onOpenSession: (id: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [headless, setHeadless] = useState(false);
  const [keep, setKeep] = useState(false);
  const [resume, setResume] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const starting = status?.capture.state === 'starting';
  const sessions = status?.sessions ?? [];
  const summary = status?.capture.lastSummary ?? null;

  const start = async (): Promise<void> => {
    setError(null);
    try {
      await api.startCapture({
        url: url.trim() || undefined,
        label: label.trim() || undefined,
        headless,
        keep,
        resume,
      });
      // The status push that follows flips this screen to the workspace; there
      // is nothing to do here on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="launch">
      <div className="launch-card">
        <h1>Capture a site’s API calls</h1>
        <p className="launch-lede">
          A fresh Chrome window opens on the address below, signed in to its own
          profile. Browse the way you normally would — every API call behind what
          you do is recorded with the headers that actually went on the wire.
        </p>

        <form
          className="launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!starting) void start();
          }}
        >
          <label className="field">
            <span className="field-label">Target URL</span>
            <input
              className="input url"
              type="text"
              inputMode="url"
              placeholder="app.example.com/login"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
              disabled={starting}
              spellCheck={false}
            />
            <span className="field-hint">
              Leave this empty to open a blank tab and navigate yourself.
            </span>
          </label>

          <button className="btn primary large" type="submit" disabled={starting}>
            {starting ? 'Launching Chrome…' : 'Launch browser and capture'}
          </button>
        </form>

        {error && (
          <div className="launch-error">
            <strong>Could not start the capture</strong>
            <pre>{error}</pre>
          </div>
        )}

        <button
          className="link-btn"
          type="button"
          onClick={() => setShowOptions((open) => !open)}
        >
          {showOptions ? 'Hide options' : 'Options'}
        </button>

        {showOptions && (
          <div className="launch-options">
            <label className="field">
              <span className="field-label">Name this capture</span>
              <input
                className="input"
                type="text"
                placeholder="Defaults to the site’s hostname"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={starting}
              />
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={resume}
                onChange={(event) => setResume(event.target.checked)}
                disabled={starting || sessions.length === 0}
              />
              <span>
                <b>Continue the last session</b>
                <em>
                  Adds to the previous capture instead of numbering from #1 again.
                </em>
              </span>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={keep}
                onChange={(event) => setKeep(event.target.checked)}
                disabled={starting}
              />
              <span>
                <b>Keep everything</b>
                <em>
                  By default anything you did not document or approve is discarded
                  when the capture ends.
                </em>
              </span>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={headless}
                onChange={(event) => setHeadless(event.target.checked)}
                disabled={starting}
              />
              <span>
                <b>Run Chrome without a window</b>
                <em>Only useful when the site needs no interaction.</em>
              </span>
            </label>
          </div>
        )}
      </div>

      {summary && <LastCapture summary={summary} />}

      {sessions.length > 0 && (
        <section className="launch-sessions">
          <h2>Stored captures</h2>
          <p className="muted">
            Open one to review, copy or export what it kept. Nothing is recorded.
          </p>
          <ul>
            {sessions.map((session) => (
              <StoredSession
                key={session.id}
                session={session}
                onOpen={() => onOpenSession(session.id)}
              />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function LastCapture({ summary }: { summary: CaptureSummary }) {
  if (!summary.sessionKept) {
    return (
      <div className="launch-note">
        The last capture recorded {summary.total} requests. Nothing was selected, so
        it was not kept.
      </div>
    );
  }
  return (
    <div className="launch-note">
      <strong>Last capture</strong> recorded {summary.total} requests and kept{' '}
      {summary.retained} — {summary.documented} documented, the rest approved.{' '}
      {summary.discarded > 0 && `${summary.discarded} discarded. `}
      {formatBytes(summary.bytes)} stored.
    </div>
  );
}

function StoredSession({
  session,
  onOpen,
}: {
  session: SessionSummary;
  onOpen: () => void;
}) {
  return (
    <li>
      <button className="stored" onClick={onOpen}>
        <span className="stored-label">{session.label}</span>
        <span className="stored-host">{session.primaryHost ?? '—'}</span>
        <span className="stored-counts">
          {session.kept} kept · {session.approved} approved
        </span>
        <span className="stored-when">
          {new Date(session.startedAt).toLocaleString()}
        </span>
      </button>
    </li>
  );
}
