import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  connectLive,
  type CurlOptions,
  type DocState,
  type SlimRecord,
  type Status,
} from './api.ts';
import { Live } from './components/Live.tsx';
import { Collection } from './components/Collection.tsx';
import { Doc } from './components/Doc.tsx';
import { SessionPicker } from './components/SessionPicker.tsx';
import { ConfirmButton } from './components/ConfirmButton.tsx';
import { formatBytes } from './util.ts';

type Theme = 'light' | 'dark' | null;

function mergeRecord(records: SlimRecord[], incoming: SlimRecord): SlimRecord[] {
  const index = records.findIndex((record) => record.id === incoming.id);
  if (index === -1) return [...records, incoming];
  const next = [...records];
  next[index] = incoming;
  return next;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [records, setRecords] = useState<SlimRecord[]>([]);
  const [doc, setDoc] = useState<DocState>({ folders: [], entries: [] });
  /** Which document new entries are filed under; shared by every Add-to-doc. */
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [tab, setTab] = useState<'live' | 'collection' | 'doc'>('live');
  const [curlOptions, setCurlOptions] = useState<CurlOptions>({
    clean: false,
    redact: false,
    shell: 'posix',
    singleLine: false,
  });
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('curlapi-theme') as Theme) ?? null,
  );
  /**
   * Mirrors status.viewingCapture for the socket handler, which is registered
   * once and would otherwise close over the value as it was at mount.
   */
  const viewingCapture = useRef(true);

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('curlapi-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('curlapi-theme');
    }
  }, [theme]);

  // Everything, noise included: the list is slim, so the "show noise" toggle can
  // be a pure client-side filter instead of a round trip.
  const reloadRecords = useCallback(() => {
    void api.requests(true).then(setRecords).catch(() => undefined);
  }, []);

  useEffect(() => reloadRecords(), [reloadRecords]);

  const refreshDoc = useCallback(() => {
    void api
      .doc(curlOptions)
      .then((next) => {
        setDoc(next);
        // Keep the target document valid: it may have just been deleted, or the
        // first one may have only now been created by an Add-to-doc.
        setActiveFolderId((current) =>
          next.folders.some((folder) => folder.id === current)
            ? current
            : (next.folders[0]?.id ?? null),
        );
      })
      .catch(() => undefined);
  }, [curlOptions]);

  useEffect(() => refreshDoc(), [refreshDoc]);

  // Records and status both arrive over one socket; nothing here polls.
  useEffect(
    () =>
      connectLive({
        onRecord: (record) =>
          // A live record belongs to the session being recorded. Dropping it
          // while an older capture is on screen keeps that view a true picture
          // of what was captured then.
          setRecords((prev) =>
            viewingCapture.current ? mergeRecord(prev, record) : prev,
          ),
        onStatus: (next) => {
          viewingCapture.current = next.viewingCapture;
          setStatus(next);
        },
      }),
    [],
  );

  const selectSession = useCallback(
    async (id: string) => {
      const next = await api.selectSession(id).catch(() => null);
      if (!next) return;
      viewingCapture.current = next.viewingCapture;
      setStatus(next);
      // The whole view belongs to the session, its documents included.
      reloadRecords();
      refreshDoc();
    },
    [reloadRecords, refreshDoc],
  );

  const removeSession = useCallback(
    async (id: string) => {
      const result = await api.deleteSession(id).catch(() => null);
      if (!result) return;
      // The server drops back to the live capture, so follow it there.
      viewingCapture.current = result.status.viewingCapture;
      setStatus(result.status);
      reloadRecords();
      refreshDoc();
    },
    [reloadRecords, refreshDoc],
  );

  const addToDoc = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      await api.addToDoc(ids, curlOptions, activeFolderId).catch(() => undefined);
      refreshDoc();
      setTab('doc');
    },
    [curlOptions, refreshDoc, activeFolderId],
  );

  const createFolder = useCallback(
    async (name: string) => {
      const folder = await api.createFolder(name).catch(() => null);
      if (folder) setActiveFolderId(folder.id);
      refreshDoc();
    },
    [refreshDoc],
  );

  const clearCaptured = useCallback(async () => {
    setRecords([]);
    await api.clear().catch(() => undefined);
    // Entries keep their snapshotted command, so the document survives a clear.
    refreshDoc();
  }, [refreshDoc]);

  const setApprovedMany = useCallback(async (ids: string[], approved: boolean) => {
    const target = new Set(ids);
    setRecords((prev) =>
      prev.map((record) => (target.has(record.id) ? { ...record, approved } : record)),
    );
    await api.approveMany(ids, approved).catch(() => undefined);
  }, []);

  const setApproved = useCallback(async (id: string, approved: boolean) => {
    setRecords((prev) =>
      prev.map((record) => (record.id === id ? { ...record, approved } : record)),
    );
    await api.approve(id, approved).catch(() => undefined);
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    const value = title.trim();
    setRecords((prev) =>
      prev.map((record) =>
        record.id === id ? { ...record, title: value.length > 0 ? value : null } : record,
      ),
    );
    await api.rename(id, value).catch(() => undefined);
  }, []);

  const approved = useMemo(
    () =>
      records
        .filter((record) => record.approved)
        .sort((a, b) => (a.orderIndex ?? a.seq) - (b.orderIndex ?? b.seq)),
    [records],
  );

  const kept = useMemo(() => records.filter((record) => record.verdict.keep), [records]);

  // Failures among the calls that matter: a filtered-out tracker pixel returning
  // 404 is not something anyone is trying to debug.
  const failed = useMemo(
    () => kept.filter((record) => record.error !== null || (record.status ?? 0) >= 400),
    [kept],
  );

  const togglePause = async () => {
    if (!status?.capturing) return;
    const next = await api.pause(!status.paused).catch(() => null);
    if (next) setStatus({ ...status, paused: next.paused });
  };

  const dotClass = !status?.capturing ? '' : status.paused ? 'paused' : 'live';
  const dotLabel = !status?.capturing
    ? 'Not capturing'
    : status.paused
      ? 'Paused'
      : 'Recording';

  return (
    <div className="app">
      <header className="topbar">
        <div className="identity">
          <div className="brand">
            <span className={`dot ${dotClass}`} title={dotLabel} />
            curlapi
          </div>
          {status && (
            <SessionPicker
              sessions={status.sessions}
              activeId={status.sessionId}
              captureId={status.captureSessionId}
              onSelect={(id) => void selectSession(id)}
            />
          )}
          {/* Only for a session that is not being recorded into — the live one
              must not be deletable out from under the recorder. */}
          {status && !status.viewingCapture && (
            <ConfirmButton
              className="btn small danger"
              confirmLabel="Delete forever?"
              title="Delete this stored capture and its documents"
              onConfirm={() => void removeSession(status.sessionId)}
            >
              Delete
            </ConfirmButton>
          )}
          {status?.primaryHost && status.sessions.length <= 1 && (
            <span className="session-host">{status.primaryHost}</span>
          )}
        </div>

        <nav className="tabs" role="tablist">
          {(
            [
              ['live', 'Live', kept.length],
              ['collection', 'Collection', approved.length],
              ['doc', 'Doc', doc.entries.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              className="tab"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
              {count > 0 && <span className="tab-count">{count}</span>}
            </button>
          ))}
        </nav>

        <div className="meta">
          <div className="counts">
            <span title="Requests recorded, noise included">
              <b>{records.length}</b> seen
            </span>
            <span title="Requests that survived the filter">
              <b>{kept.length}</b> kept
            </span>
            {failed.length > 0 && (
              <span className="bad" title="Kept requests that errored or returned 4xx/5xx">
                <b>{failed.length}</b> failed
              </span>
            )}
            {status && <span title="Stored on disk">{formatBytes(status.storedBytes)}</span>}
          </div>

          {status?.capturing && status.viewingCapture && (
            <button className="btn small" onClick={() => void togglePause()}>
              {status.paused ? 'Resume' : 'Pause'}
            </button>
          )}

          <button
            className="btn icon"
            title="Switch theme"
            aria-label="Switch theme"
            onClick={() =>
              setTheme((current) => {
                const isDark =
                  current === 'dark' ||
                  (current === null &&
                    window.matchMedia('(prefers-color-scheme: dark)').matches);
                return isDark ? 'light' : 'dark';
              })
            }
          >
            ◐
          </button>
        </div>
      </header>

      {status && !status.viewingCapture && (
        <div className="warnbar viewing">
          <strong>Viewing a stored capture</strong>
          <span>
            Recording continues into the live session — nothing here is being added to.
          </span>
          <div className="spacer" />
          <button
            className="btn small primary"
            onClick={() => void selectSession(status.captureSessionId)}
          >
            Back to live
          </button>
        </div>
      )}

      {status && status.staleTabs.length > 0 && (
        <div className="warnbar">
          <strong>
            {status.staleTabs.length} tab
            {status.staleTabs.length === 1 ? ' was' : 's were'} already open when capture
            started
          </strong>
          <span>
            Their traffic finished loading before recording began, so none of it was
            captured.
          </span>
          <div className="spacer" />
          <button
            className="btn small primary"
            onClick={() => void api.reload().then(() => api.status().then(setStatus))}
          >
            Reload and capture
          </button>
        </div>
      )}

      {tab === 'live' && (
        <Live
          records={records}
          curlOptions={curlOptions}
          onApprove={setApproved}
          onApproveMany={setApprovedMany}
          onClear={() => void clearCaptured()}
          onAddToDoc={(ids) => void addToDoc(ids)}
          capturing={status?.capturing ?? false}
          folders={doc.folders}
          activeFolderId={activeFolderId}
          onSelectFolder={setActiveFolderId}
          onCreateFolder={(name) => void createFolder(name)}
        />
      )}
      {tab === 'collection' && (
        <Collection
          approved={approved}
          curlOptions={curlOptions}
          onCurlOptions={setCurlOptions}
          onApprove={setApproved}
          onRename={rename}
          onAddToDoc={(ids) => void addToDoc(ids)}
          folders={doc.folders}
          activeFolderId={activeFolderId}
          onSelectFolder={setActiveFolderId}
          onCreateFolder={(name) => void createFolder(name)}
        />
      )}
      {tab === 'doc' && (
        <Doc
          doc={doc}
          activeFolderId={activeFolderId}
          onSelectFolder={setActiveFolderId}
          curlOptions={curlOptions}
          onChanged={refreshDoc}
        />
      )}
    </div>
  );
}
