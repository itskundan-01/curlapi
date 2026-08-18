import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type CurlOptions,
  type Endpoint,
  type HeaderRow,
  type ReplayResult,
} from './api.ts';
import { CurlView } from './CurlView.tsx';
import { ResponsePanel } from './ResponsePanel.tsx';
import { shellLabel } from './platform.ts';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export type EditorTab = 'curl' | 'params' | 'headers' | 'body';

/**
 * The request, editable.
 *
 * cURL is the first tab and the default, because the command is the request:
 * one view holding the URL, every header and the body, where a tabbed editor
 * shows a third of it at a time. Clicking a line there opens the tab that owns
 * it, so reading and fixing are the same gesture.
 *
 * Edits are held locally and saved on blur rather than on every keystroke: a
 * round trip per character would fight the cursor, and every save re-resolves
 * the request server-side.
 */
export function RequestEditor({
  endpoint,
  curl,
  curlOptions,
  onSaved,
}: {
  endpoint: Endpoint;
  curl: string;
  curlOptions: CurlOptions;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<EditorTab>('curl');
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [method, setMethod] = useState(endpoint.draft.method);
  const [url, setUrl] = useState(endpoint.draft.url);
  const [headers, setHeaders] = useState<HeaderRow[]>(endpoint.draft.headers);
  const [body, setBody] = useState(endpoint.draft.body ?? '');

  // Re-seeded when a different endpoint is selected, or after a save re-resolves.
  const draftKey = JSON.stringify(endpoint.draft);
  useEffect(() => {
    setMethod(endpoint.draft.method);
    setUrl(endpoint.draft.url);
    setHeaders(endpoint.draft.headers);
    setBody(endpoint.draft.body ?? '');
  }, [draftKey, endpoint.draft]);

  // A different endpoint gets a clean response area; a re-save of the same one
  // keeps what was just run.
  useEffect(() => {
    setResult(null);
    setBlocked(null);
    setTab('curl');
  }, [endpoint.id]);

  const save = (fields: Parameters<typeof api.update>[1]): void => {
    void api.update(endpoint.id, fields).then(onSaved).catch(() => undefined);
  };

  const run = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    setBlocked(null);
    try {
      const response = await api.run(endpoint.id);
      if (response.blocked) setBlocked(response.error);
      else setResult(response.result);
    } catch (err) {
      setBlocked(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const openFor = (next: EditorTab, focus?: string): void => {
    setTab(next);
    setFocusRow(focus ?? null);
  };

  const blockedByPlaceholders = endpoint.placeholders.length > 0;
  const paramCount = countParams(url);

  return (
    <div className="request-editor">
      <div className="request-bar">
        <select
          // The method carries its own colour here as well as in the list, so
          // the request bar states what it is about to do before you read it.
          className={`method-select ${method.toUpperCase()}`}
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
            save({ method: event.target.value });
          }}
          aria-label="HTTP method"
        >
          {/* A method the document used that is not in the standard list still
              has to be selectable, or changing anything else would lose it. */}
          {(METHODS.includes(method) ? METHODS : [method, ...METHODS]).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <input
          className="url-input"
          value={url}
          spellCheck={false}
          placeholder="https://…"
          onChange={(event) => setUrl(event.target.value)}
          onBlur={() => url !== endpoint.draft.url && save({ url })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          aria-label="Request URL"
        />

        <button
          className="btn primary run"
          disabled={running || blockedByPlaceholders}
          title={
            blockedByPlaceholders
              ? `Fill in ${endpoint.placeholders.map((n) => `{${n}}`).join(', ')} first`
              : 'Send this request now'
          }
          onClick={() => void run()}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <div className="request-meta">
        {endpoint.environments.length > 0 && (
          <label className="meta-field">
            <span>Environment</span>
            <select
              className="input tiny"
              value={endpoint.overrides.environment ?? ''}
              onChange={(event) => save({ environment: event.target.value })}
            >
              <option value="">As documented</option>
              {endpoint.environments.map((environment) => (
                <option key={environment.name} value={environment.name}>
                  {environment.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {endpoint.edited && <span className="badge">edited</span>}
        <div className="spacer" />
        {endpoint.edited && (
          <button
            className="link-btn"
            title="Discard your edits and go back to what the document said"
            onClick={() => save({ reset: true })}
          >
            Reset to document
          </button>
        )}
      </div>

      <nav className="subtabs" role="tablist">
        {(
          [
            ['curl', 'cURL'],
            ['params', paramCount ? `Params (${paramCount})` : 'Params'],
            ['headers', headers.length ? `Headers (${headers.length})` : 'Headers'],
            ['body', body.trim().length > 0 ? 'Body •' : 'Body'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            className="subtab"
            aria-selected={tab === key}
            onClick={() => openFor(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="editor-body">
        {tab === 'curl' && (
          <CurlView
            curl={curl}
            shellLabel={shellLabel(curlOptions.shell)}
            redacted={curlOptions.redact}
            endpointId={endpoint.id}
            onEdit={openFor}
            onReplaced={onSaved}
          />
        )}

        {tab === 'params' && (
          <ParamsTable
            url={url}
            onChange={(next) => {
              setUrl(next);
              save({ url: next });
            }}
          />
        )}

        {tab === 'headers' && (
          <KeyValueTable
            rows={headers}
            showToggle
            namePlaceholder="Header"
            focusName={focusRow}
            onChange={(next) => {
              setHeaders(next);
              save({ headers: next });
            }}
          />
        )}

        {tab === 'body' && (
          <BodyEditor
            value={body}
            onChange={setBody}
            onCommit={(next) => save({ body: next.length > 0 ? next : null })}
          />
        )}
      </div>

      <ResponsePanel
        endpoint={endpoint}
        result={result}
        blocked={blocked}
        running={running}
      />
    </div>
  );
}

function countParams(url: string): number {
  try {
    return [...new URL(url).searchParams.keys()].length;
  } catch {
    return 0;
  }
}

/**
 * Query parameters as editable rows, written back into the URL.
 *
 * The URL stays the single source of truth rather than being kept in sync with a
 * separate list: two representations of the same thing drift, and the one in the
 * address bar is the one that gets sent.
 */
function ParamsTable({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const parsed = useMemo(() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }, [url]);

  if (!parsed) {
    return (
      <p className="editor-note">
        This URL cannot be parsed yet — usually because a placeholder has not been
        filled in. Edit it directly in the bar above.
      </p>
    );
  }

  const rows = [...parsed.searchParams.entries()].map(([name, value]) => ({
    name,
    value,
    enabled: true,
  }));

  const write = (next: HeaderRow[]): void => {
    const rebuilt = new URL(url);
    rebuilt.search = '';
    for (const row of next) {
      if (!row.enabled || row.name.trim().length === 0) continue;
      rebuilt.searchParams.append(row.name, row.value);
    }
    onChange(rebuilt.toString());
  };

  return (
    <KeyValueTable
      rows={rows}
      showToggle
      namePlaceholder="Parameter"
      focusName={null}
      onChange={write}
    />
  );
}

/**
 * The editable grid the header and parameter tables are made of.
 *
 * There is always one blank row at the bottom, so adding an entry is typing
 * rather than clicking Add first — the behaviour every API client has settled on.
 */
function KeyValueTable({
  rows,
  showToggle,
  namePlaceholder,
  focusName,
  onChange,
}: {
  rows: HeaderRow[];
  showToggle: boolean;
  namePlaceholder: string;
  /** Row to focus on open, when arrived at by clicking that line in the command. */
  focusName: string | null;
  onChange: (rows: HeaderRow[]) => void;
}) {
  const [draft, setDraft] = useState<HeaderRow[]>(rows);
  const signature = JSON.stringify(rows);
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setDraft(rows);
    }
  }, [signature, rows]);

  // Focusing the row the reader clicked in the command is the whole point of
  // arriving here that way; landing on the tab with nothing selected would make
  // them find the line a second time.
  const focusTarget = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusName) focusTarget.current?.focus();
  }, [focusName]);

  const commit = (next: HeaderRow[]): void => {
    setDraft(next);
    onChange(next.filter((row) => row.name.trim().length > 0 || row.value.length > 0));
  };

  const update = (index: number, patch: Partial<HeaderRow>): void => {
    commit(draft.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const withBlank = [...draft, { name: '', value: '', enabled: true }];

  return (
    <table className="kv-table">
      <thead>
        <tr>
          {showToggle && <th className="kv-toggle" aria-label="Enabled" />}
          <th>{namePlaceholder}</th>
          <th>Value</th>
          <th className="kv-remove" aria-label="Remove" />
        </tr>
      </thead>
      <tbody>
        {withBlank.map((row, index) => {
          const isBlank = index === draft.length;
          const focused =
            !isBlank && focusName !== null && row.name.toLowerCase() === focusName.toLowerCase();
          return (
            <tr key={index} className={`${row.enabled ? '' : 'off'}${focused ? ' focused' : ''}`}>
              {showToggle && (
                <td className="kv-toggle">
                  {!isBlank && (
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      title={row.enabled ? 'Sent' : 'Not sent'}
                      onChange={(event) => update(index, { enabled: event.target.checked })}
                    />
                  )}
                </td>
              )}
              <td>
                <input
                  className="kv-input"
                  value={row.name}
                  placeholder={isBlank ? namePlaceholder : ''}
                  spellCheck={false}
                  onChange={(event) =>
                    isBlank
                      ? commit([...draft, { name: event.target.value, value: '', enabled: true }])
                      : update(index, { name: event.target.value })
                  }
                />
              </td>
              <td>
                <input
                  ref={focused ? focusTarget : undefined}
                  className="kv-input"
                  value={row.value}
                  placeholder={isBlank ? 'Value' : ''}
                  spellCheck={false}
                  onChange={(event) =>
                    isBlank
                      ? commit([...draft, { name: '', value: event.target.value, enabled: true }])
                      : update(index, { value: event.target.value })
                  }
                />
              </td>
              <td className="kv-remove">
                {!isBlank && (
                  <button
                    className="kv-x"
                    title="Remove"
                    aria-label={`Remove ${row.name || 'row'}`}
                    onClick={() => commit(draft.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BodyEditor({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const format = (): void => {
    try {
      const formatted = JSON.stringify(JSON.parse(value), null, 2);
      onChange(formatted);
      onCommit(formatted);
      setError(null);
    } catch (err) {
      // Naming the position is the whole value of the button: a smart quote left
      // in by the document is otherwise invisible.
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="body-editor">
      <div className="body-tools">
        <button className="btn small" onClick={format} disabled={value.trim().length === 0}>
          Format JSON
        </button>
        {value.trim().length > 0 && (
          <button
            className="btn small"
            onClick={() => {
              onChange('');
              onCommit('');
            }}
          >
            Clear
          </button>
        )}
        <div className="spacer" />
        {error && <span className="body-error">{error}</span>}
      </div>
      <textarea
        className="body-input"
        value={value}
        spellCheck={false}
        placeholder="No body. Type or paste one here."
        onChange={(event) => {
          onChange(event.target.value);
          setError(null);
        }}
        onBlur={() => onCommit(value)}
      />
    </div>
  );
}
