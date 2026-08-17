import { useEffect, useState } from 'react';
import {
  api,
  type CurlOptions,
  type DocFolder,
  type ReplayResult,
  type SlimRecord,
} from '../api.ts';
import { statusClass } from '../../../util.ts';
import { CopyButton } from './CopyButton.tsx';
import { RunResult } from './RunResult.tsx';
import { ShelfLifeNote } from './Tokens.tsx';
import { FolderPicker } from './FolderPicker.tsx';

type Props = {
  approved: SlimRecord[];
  curlOptions: CurlOptions;
  onCurlOptions: (options: CurlOptions) => void;
  onApprove: (id: string, approved: boolean) => void;
  onRename: (id: string, title: string) => void;
  onAddToDoc: (ids: string[]) => void;
  folders: DocFolder[];
  activeFolderId: string | null;
  onSelectFolder: (id: string) => void;
  onCreateFolder: (name: string) => void;
};

type RunState = { status: 'running' } | { status: 'done'; result: ReplayResult };

function Card({
  record,
  index,
  curl,
  run,
  onRun,
  onApprove,
  onRename,
  onAddToDoc,
}: {
  record: SlimRecord;
  index: number;
  curl: string;
  run: RunState | undefined;
  onRun: () => void;
  onApprove: (id: string, approved: boolean) => void;
  onRename: (id: string, title: string) => void;
  onAddToDoc: (ids: string[]) => void;
}) {
  const [name, setName] = useState(record.title ?? record.shortName);

  useEffect(() => {
    setName(record.title ?? record.shortName);
  }, [record.title, record.shortName]);

  return (
    <article className="card">
      <div className="card-head">
        <span className="card-seq">{index + 1}.</span>
        <input
          className="card-name"
          value={name}
          size={Math.max(name.length, 6)}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => onRename(record.id, name)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          aria-label="Endpoint name"
        />
        <span className={`method ${record.method}`}>{record.method}</span>
        <span className={`status ${statusClass(record.status)}`}>
          {record.status ?? '—'}
        </span>

        <div className="spacer" />

        <button className="btn small primary" onClick={onRun} disabled={run?.status === 'running'}>
          {run?.status === 'running' ? 'Running…' : 'Run'}
        </button>
        <CopyButton text={curl} label="Copy cURL command" />
        <button className="btn small" onClick={() => onAddToDoc([record.id])}>
          Add to doc
        </button>
        <button
          className="btn small"
          onClick={() => onApprove(record.id, false)}
          title="Remove from collection"
        >
          Remove
        </button>

        <div className="card-url">{record.url}</div>
      </div>

      <div className="card-body">
        <ShelfLifeNote headers={record.requestHeaders} />
        <pre className="code">{curl || 'Loading…'}</pre>
      </div>

      {run?.status === 'done' && (
        <RunResult result={run.result} requestHeaders={record.requestHeaders} />
      )}
    </article>
  );
}

export function Collection({
  approved,
  curlOptions,
  onCurlOptions,
  onApprove,
  onRename,
  onAddToDoc,
  folders,
  activeFolderId,
  onSelectFolder,
  onCreateFolder,
}: Props) {
  const [curls, setCurls] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, RunState>>({});

  useEffect(() => {
    let live = true;
    void api.curls(curlOptions).then((rows) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const row of rows) next[row.id] = row.curl;
      setCurls(next);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [curlOptions, approved.length]);

  const run = async (id: string) => {
    setRuns((prev) => ({ ...prev, [id]: { status: 'running' } }));
    const result = await api.replay(id).catch(
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
    setRuns((prev) => ({ ...prev, [id]: { status: 'done', result } }));
  };

  if (approved.length === 0) {
    return (
      <div className="collection">
        <div className="empty">
          <h3>No endpoints approved yet</h3>
          <p>
            Switch to the Live tab and tick the requests worth keeping. They appear here
            numbered, with a complete curl command and a Run button to check each one still
            works outside the browser.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="collection">
      <div className="collection-inner">
        <div className="toolbar" style={{ borderRadius: 10, border: '1px solid var(--border)' }}>
          <label className="check">
            <input
              type="checkbox"
              checked={curlOptions.clean}
              onChange={(event) =>
                onCurlOptions({ ...curlOptions, clean: event.target.checked })
              }
            />
            Clean headers
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={curlOptions.redact}
              onChange={(event) =>
                onCurlOptions({ ...curlOptions, redact: event.target.checked })
              }
            />
            Redact secrets
          </label>
          <select
            value={curlOptions.shell}
            onChange={(event) =>
              onCurlOptions({
                ...curlOptions,
                shell: event.target.value === 'powershell' ? 'powershell' : 'posix',
              })
            }
          >
            <option value="posix">bash / zsh</option>
            <option value="powershell">PowerShell</option>
          </select>

          <div className="spacer" />

          <div className="exports">
            <button
              className="btn small"
              onClick={() => onAddToDoc(approved.map((record) => record.id))}
            >
              Add all to doc
            </button>
            <FolderPicker
              folders={folders}
              activeId={activeFolderId}
              onSelect={onSelectFolder}
              onCreate={onCreateFolder}
            />
            <a className="btn small" href={api.exportUrl('script', curlOptions)} download>
              curls.sh
            </a>
            <a className="btn small" href={api.exportUrl('postman', curlOptions)} download>
              Postman
            </a>
            <a className="btn small" href={api.exportUrl('json', curlOptions)} download>
              JSON
            </a>
          </div>
        </div>

        {!curlOptions.redact && (
          <p className="hint">
            Commands include live credentials from the captured session. Turn on{' '}
            <code>Redact secrets</code> before sharing an export.
          </p>
        )}

        {approved.map((record, index) => (
          <Card
            key={record.id}
            record={record}
            index={index}
            curl={curls[record.id] ?? ''}
            run={runs[record.id]}
            onRun={() => void run(record.id)}
            onApprove={onApprove}
            onRename={onRename}
            onAddToDoc={onAddToDoc}
          />
        ))}
      </div>
    </div>
  );
}
