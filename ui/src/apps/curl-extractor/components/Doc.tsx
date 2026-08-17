import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type CurlOptions,
  type DocEntryWithCurl,
  type DocFolder,
  type DocState,
  type ReplayResult,
} from '../api.ts';
import { copyText, statusClass } from '../../../util.ts';
import { CopyButton } from './CopyButton.tsx';
import { ConfirmButton } from './ConfirmButton.tsx';
import { RunResult } from './RunResult.tsx';
import { toCopyBlock } from '@core/export/doc.ts';

type Props = {
  doc: DocState;
  activeFolderId: string | null;
  onSelectFolder: (id: string) => void;
  curlOptions: CurlOptions;
  onChanged: () => void;
};

function Entry({
  entry,
  index,
  first,
  last,
  folders,
  onChanged,
  onMove,
}: {
  entry: DocEntryWithCurl;
  index: number;
  first: boolean;
  last: boolean;
  folders: DocFolder[];
  onChanged: () => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [note, setNote] = useState(entry.note);
  const [run, setRun] = useState<ReplayResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => setTitle(entry.title), [entry.title]);
  useEffect(() => setNote(entry.note), [entry.note]);

  const execute = async () => {
    if (!entry.requestId) return;
    setRunning(true);
    const result = await api.replay(entry.requestId).catch(
      (err: unknown): ReplayResult => ({
        ok: false,
        status: null,
        statusText: '',
        headers: [],
        body: '',
        bodyEncoding: 'text',
        truncated: false,
        durationMs: 0,
        sizeBytes: 0,
        shapeMatchesCapture: null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    setRun(result);
    setRunning(false);
  };

  const save = (fields: { title?: string; note?: string; folderId?: string }) => {
    void api.updateDocEntry(entry.id, fields).then(onChanged).catch(() => undefined);
  };

  const isNote = entry.requestId === null;

  return (
    <article className={`doc-entry${isNote ? ' note' : ''}`}>
      <div className="doc-head">
        {!isNote && <span className="doc-seq">{index}.</span>}
        <input
          className="doc-title"
          value={title}
          placeholder={isNote ? 'Section heading' : 'Endpoint name'}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title !== entry.title && save({ title })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        {!isNote && (
          <>
            <span className={`method ${entry.method}`}>{entry.method}</span>
            <span className={`status ${statusClass(entry.status)}`}>
              {entry.status ?? '—'}
            </span>
            {/* The document outlives its capture, so it carries its own Run
                rather than sending you back to a list that may be gone. */}
            <button
              className="btn small primary"
              disabled={running || entry.curl.length === 0}
              onClick={() => void execute()}
            >
              {running ? 'Running…' : 'Run'}
            </button>
            <CopyButton text={entry.curl} label="Copy cURL command" />
          </>
        )}
        {folders.length > 1 && (
          <select
            className="doc-folder-pick"
            value={entry.folderId}
            title="Move to another document"
            onChange={(event) => save({ folderId: event.target.value })}
          >
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        )}
        <div className="doc-move">
          <button onClick={() => onMove(entry.id, -1)} disabled={first} title="Move up">
            ↑
          </button>
          <button onClick={() => onMove(entry.id, 1)} disabled={last} title="Move down">
            ↓
          </button>
        </div>
        <ConfirmButton
          className="btn remove"
          confirmLabel="✕ sure?"
          title="Remove from document"
          onConfirm={() => {
            void api.deleteDocEntry(entry.id).then(onChanged).catch(() => undefined);
          }}
        >
          ✕
        </ConfirmButton>
      </div>

      <textarea
        className="doc-note"
        value={note}
        placeholder={
          isNote ? 'Write anything…' : 'What does this endpoint do? Notes, params, gotchas…'
        }
        onChange={(event) => setNote(event.target.value)}
        onBlur={() => note !== entry.note && save({ note })}
      />

      {!isNote && entry.curl && <pre className="code wrap">{entry.curl}</pre>}
      {run && <RunResult result={run} requestHeaders={[]} />}
    </article>
  );
}

/** The folder list: creating, picking, renaming and deleting documents. */
function Folders({
  folders,
  counts,
  activeId,
  onSelect,
  onChanged,
}: {
  folders: DocFolder[];
  counts: Record<string, number>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const create = () => {
    const value = name.trim();
    if (value.length === 0) {
      setCreating(false);
      return;
    }
    void api
      .createFolder(value)
      .then((folder) => {
        onSelect(folder.id);
        onChanged();
      })
      .catch(() => undefined);
    setName('');
    setCreating(false);
  };

  return (
    <aside className="doc-folders">
      <div className="doc-folders-head">
        <h3>Documents</h3>
        <button
          className="btn small"
          onClick={() => setCreating(true)}
          title="New document"
          aria-label="New document"
        >
          ＋
        </button>
      </div>

      <ul className="folder-list">
        {folders.map((folder) => (
          <li key={folder.id}>
            {renamingId === folder.id ? (
              <input
                className="folder-rename"
                autoFocus
                defaultValue={folder.name}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  setRenamingId(null);
                  if (value.length > 0 && value !== folder.name) {
                    void api.renameFolder(folder.id, value).then(onChanged).catch(() => undefined);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    event.currentTarget.value = folder.name;
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <div
                className={`folder${folder.id === activeId ? ' active' : ''}`}
                onClick={() => onSelect(folder.id)}
                onDoubleClick={() => setRenamingId(folder.id)}
                title="Double-click to rename"
              >
                <span className="folder-name">{folder.name}</span>
                <span className="folder-count">{counts[folder.id] ?? 0}</span>
                <ConfirmButton
                  className="btn remove folder-remove"
                  confirmLabel="delete?"
                  title="Delete this document and its entries"
                  onConfirm={() => {
                    void api.deleteFolder(folder.id).then(onChanged).catch(() => undefined);
                  }}
                >
                  ✕
                </ConfirmButton>
              </div>
            )}
          </li>
        ))}

        {creating && (
          <li>
            <input
              className="folder-rename"
              autoFocus
              placeholder="Document name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={create}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setName('');
                  setCreating(false);
                }
              }}
            />
          </li>
        )}
      </ul>

      {folders.length === 0 && !creating && (
        <p className="hint">
          Adding a request from the Live tab starts one for you.
        </p>
      )}
    </aside>
  );
}

export function Doc({
  doc,
  activeFolderId,
  onSelectFolder,
  curlOptions,
  onChanged,
}: Props) {
  const [copied, setCopied] = useState(false);

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const entry of doc.entries) {
      if (entry.requestId === null) continue;
      result[entry.folderId] = (result[entry.folderId] ?? 0) + 1;
    }
    return result;
  }, [doc.entries]);

  const folder =
    doc.folders.find((candidate) => candidate.id === activeFolderId) ?? doc.folders[0] ?? null;
  const entries = useMemo(
    () => (folder ? doc.entries.filter((entry) => entry.folderId === folder.id) : []),
    [doc.entries, folder],
  );

  const move = (id: string, direction: -1 | 1) => {
    // Reordering is scoped to the open document; ids from other folders would
    // renumber them as a side effect of moving a row here.
    const order = entries.map((entry) => entry.id);
    const from = order.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    void api.setDocOrder(order).then(onChanged).catch(() => undefined);
  };

  const addNote = () => {
    void api.addDocNote('', '', folder?.id ?? null).then(onChanged).catch(() => undefined);
  };

  const copyAll = () => {
    // Same numbering the entries show, and the same the Markdown export uses.
    const curls = new Map(entries.map((entry) => [entry.id, entry.curl]));
    const text = toCopyBlock(entries, (entry) => curls.get(entry.id) ?? '');
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  const commandCount = entries.filter((entry) => entry.requestId).length;

  return (
    <div className="doc">
      <Folders
        folders={doc.folders}
        counts={counts}
        activeId={folder?.id ?? null}
        onSelect={onSelectFolder}
        onChanged={onChanged}
      />

      <div className="doc-inner">
        {!folder ? (
          <div className="empty">
            <h3>Your document is empty</h3>
            <p>
              Select requests in the Live tab and choose <strong>Add to doc</strong>. Each one
              arrives numbered, with its name and a copy button for the command — then write
              what it does beside it.
            </p>
            <p>
              Use <strong>Documents</strong> on the left to keep separate flows apart — a login
              file, a profile file — each numbered from 1 and copyable in one go.
            </p>
          </div>
        ) : (
          <>
            <div
              className="toolbar"
              style={{ borderRadius: 10, border: '1px solid var(--border)' }}
            >
              <strong>{folder.name}</strong>
              <span className="hint">
                {commandCount} {commandCount === 1 ? 'endpoint' : 'endpoints'}
              </span>
              <div className="spacer" />
              <button
                className={`btn small${copied ? ' done' : ''}`}
                disabled={commandCount === 0}
                onClick={copyAll}
                title="Copy every command in this document, numbered"
              >
                {copied ? '✓ copied' : '⧉ Copy all'}
              </button>
              <button className="btn small" onClick={addNote}>
                Add note
              </button>
              <a
                className="btn small"
                href={api.exportUrl('doc', curlOptions, folder.id)}
                download
              >
                Export Markdown
              </a>
            </div>

            {entries.length === 0 ? (
              <div className="empty">
                <h3>{folder.name} is empty</h3>
                <p>
                  Tick requests in the Live tab and choose <strong>Add to doc</strong> — pick
                  this document in the selector beside the button.
                </p>
              </div>
            ) : (
              (() => {
                // Commands are numbered; free-text notes are headings and sit
                // outside the count, per document.
                let commandNumber = 0;
                return entries.map((entry, index) => {
                  if (entry.requestId) commandNumber++;
                  return (
                    <Entry
                      key={entry.id}
                      entry={entry}
                      index={commandNumber}
                      first={index === 0}
                      last={index === entries.length - 1}
                      folders={doc.folders}
                      onChanged={onChanged}
                      onMove={move}
                    />
                  );
                });
              })()
            )}
          </>
        )}
      </div>
    </div>
  );
}
