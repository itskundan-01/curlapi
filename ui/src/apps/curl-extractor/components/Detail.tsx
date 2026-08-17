import { useEffect, useState } from 'react';
import { api, type CurlOptions, type ReplayResult, type RequestDetail, type RequestRecord } from '../api.ts';
import { copyText, formatBytes, formatMs, prettyJson, statusClass } from '../../../util.ts';
import { CopyButton } from './CopyButton.tsx';
import { RunResult } from './RunResult.tsx';
import { TokenChips, ShelfLifeNote } from './Tokens.tsx';
import { Flow } from './Flow.tsx';
import type { HeaderPair } from '@core/types.ts';

function Headers({ pairs }: { pairs: HeaderPair[] }) {
  if (pairs.length === 0) return <p className="hint">None recorded.</p>;
  return (
    <dl className="headers">
      {pairs.map(([name, value], index) => (
        <div key={`${name}-${index}`}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Body({ body }: { body: RequestRecord['responseBody'] }) {
  if (!body) return <p className="hint">No body captured.</p>;
  if (body.encoding === 'base64') {
    return <p className="hint">Binary payload, {formatBytes(body.data.length)} (base64).</p>;
  }
  return (
    <>
      <pre className="code">{prettyJson(body.data)}</pre>
      {body.truncated && <p className="hint">Truncated at the capture size limit.</p>}
    </>
  );
}

export function Detail({
  id,
  curlOptions,
  onClose,
  onAddToDoc,
}: {
  id: string;
  curlOptions: CurlOptions;
  onClose: () => void;
  onAddToDoc: (ids: string[]) => void;
}) {
  const [record, setRecord] = useState<RequestDetail | null>(null);
  const [curl, setCurl] = useState('');
  const [run, setRun] = useState<ReplayResult | null>(null);
  const [running, setRunning] = useState(false);

  // Esc closes the panel, which is what every other dismissible surface does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setRecord(null);
    setRun(null);
    void api.detail(id).then((value) => {
      if (live) setRecord(value);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    let live = true;
    void api.curl(id, curlOptions).then((value) => {
      if (live) setCurl(value);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, curlOptions]);

  const execute = async () => {
    setRunning(true);
    const result = await api.replay(id).catch((err: unknown) => ({
      ok: false,
      status: null,
      statusText: '',
      headers: [],
      body: '',
      bodyEncoding: 'text' as const,
      truncated: false,
      durationMs: 0,
      sizeBytes: 0,
      shapeMatchesCapture: null,
      error: err instanceof Error ? err.message : String(err),
    }));
    setRun(result);
    setRunning(false);
  };

  if (!record) {
    return (
      <aside className="detail">
        <div className="detail-head">
          <h2>Loading…</h2>
          <button className="btn close" onClick={onClose} aria-label="Close details">
            ×
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="detail">
      <div className="detail-head">
        <h2>{record.title ?? record.shortName}</h2>
        <button className="btn close" onClick={onClose} aria-label="Close details" title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="url">{record.url}</div>

      <div className="chips">
        <span className="badge">{record.method}</span>
        <span className={`badge ${record.status && record.status < 400 ? 'ok' : 'err'}`}>
          {record.status ?? record.error ?? 'pending'}
        </span>
        <span className="badge">{record.resourceType}</span>
        <span className="badge">{formatMs(record.durationMs)}</span>
        <span className="badge">{formatBytes(record.responseSize)}</span>
      </div>

      <div className="chips">
        <button className="btn small primary" onClick={() => void execute()} disabled={running}>
          {running ? 'Running…' : 'Run'}
        </button>
        <button className="btn small" onClick={() => void copyText(curl)}>
          Copy cURL
        </button>
        <button
          className="btn small"
          title="One line, for pasting into a terminal without continuation prompts"
          onClick={() => {
            void api
              .curl(id, { ...curlOptions, singleLine: true })
              .then((text) => copyText(text));
          }}
        >
          Copy one-line
        </button>
        <button className="btn small" onClick={() => onAddToDoc([record.id])}>
          Add to doc
        </button>
      </div>

      <TokenChips headers={record.requestHeaders} />
      <ShelfLifeNote headers={record.requestHeaders} />
      <Flow
        replayability={record.replayability}
        dependencies={record.dependencies}
      />

      {run && (
        <RunResult
          result={run}
          requestHeaders={record.requestHeaders}
          singleUse={record.replayability.verdict === 'single-use'}
        />
      )}

      <p className="hint">
        {record.verdict.keep ? 'Kept' : 'Filtered out'} — {record.verdict.reason}
      </p>

      {record.redirectChain.length > 0 && (
        <details className="section">
          <summary>Redirects ({record.redirectChain.length})</summary>
          <pre className="code wrap">
            {record.redirectChain
              .map((hop) => `${hop.status} ${hop.url}\n  → ${hop.location ?? '(none)'}`)
              .join('\n')}
          </pre>
        </details>
      )}

      <details className="section" open>
        <summary>cURL</summary>
        <pre className="code wrap">{curl}</pre>
        <div style={{ marginTop: 6 }}>
          <CopyButton text={curl} label="Copy command" />
        </div>
      </details>

      <details className="section">
        <summary>Request headers ({record.requestHeaders.length})</summary>
        <Headers pairs={record.requestHeaders} />
      </details>

      {record.requestBody && (
        <details className="section">
          <summary>Request body</summary>
          <Body body={record.requestBody} />
        </details>
      )}

      <details className="section">
        <summary>Response headers ({record.responseHeaders.length})</summary>
        <Headers pairs={record.responseHeaders} />
      </details>

      <details className="section" open>
        <summary>
          Response{' '}
          <span className={`status ${statusClass(record.status)}`}>{record.status ?? ''}</span>
        </summary>
        <Body body={record.responseBody} />
      </details>
    </aside>
  );
}
