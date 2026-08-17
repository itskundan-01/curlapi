import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type CurlOptions,
  type Endpoint,
  type ImportDetail,
  type Variable,
} from './api.ts';
import { DocPanel } from './DocPanel.tsx';
import { RequestEditor } from './RequestEditor.tsx';
import { defaultCurlOptions, shellLabel } from './platform.ts';
import { ConfirmButton } from '../curl-extractor/components/ConfirmButton.tsx';
import { copyText } from '../../util.ts';

/**
 * One imported document.
 *
 * A list on the left, and the selected endpoint on the right as two panes side
 * by side: the request you can edit and run, and what the document said about
 * it. That pairing is the point — choosing what to put in a field means reading
 * the field table, and judging a run means comparing it against the documented
 * response.
 *
 * Every scrolling region is explicit, and every flex child that holds content
 * sets `flex-shrink: 0`. An earlier version made the endpoint list a flex
 * column without it, so its children shrank to fit instead of overflowing:
 * content was silently compressed and nothing scrolled.
 */
export function Workspace({
  importId,
  onBack,
}: {
  importId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [curls, setCurls] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showValues, setShowValues] = useState(true);
  // Seeded from the viewer's own platform: a POSIX-quoted command pasted into
  // PowerShell fails in a way that looks like a broken endpoint.
  const [curlOptions, setCurlOptions] = useState<CurlOptions>(defaultCurlOptions);

  const load = useCallback(() => {
    void api
      .detail(importId)
      .then((next) => {
        setDetail(next);
        setSelectedId((current) =>
          current && next.endpoints.some((endpoint) => endpoint.id === current)
            ? current
            : (next.endpoints[0]?.id ?? null),
        );
      })
      .catch(() => setDetail(null));
  }, [importId]);

  useEffect(() => load(), [load]);

  // Commands are rebuilt whenever the values or the options change, because both
  // change what the command says.
  const variablesKey = JSON.stringify(detail?.variables ?? []);
  const endpointsKey = detail?.endpoints.map((endpoint) => endpoint.id).join(',') ?? '';
  useEffect(() => {
    void api
      .curls(importId, curlOptions)
      .then((entries) =>
        setCurls(Object.fromEntries(entries.map((entry) => [entry.id, entry.curl]))),
      )
      .catch(() => undefined);
  }, [importId, curlOptions, variablesKey, endpointsKey, detail]);

  const saveVariables = useCallback(
    async (next: Variable[]) => {
      setDetail((current) => (current ? { ...current, variables: next } : current));
      await api.setVariables(importId, next).catch(() => undefined);
      load();
    },
    [importId, load],
  );

  const visible = useMemo(() => {
    if (!detail) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return detail.endpoints;
    return detail.endpoints.filter(
      (endpoint) =>
        endpoint.name.toLowerCase().includes(needle) ||
        endpoint.resolved.url.toLowerCase().includes(needle) ||
        endpoint.resolved.method.toLowerCase().includes(needle) ||
        endpoint.section.join(' ').toLowerCase().includes(needle),
    );
  }, [detail, filter]);

  const selected = detail?.endpoints.find((endpoint) => endpoint.id === selectedId) ?? null;
  const unfilled = detail?.variables.filter((variable) => !variable.value).length ?? 0;

  const toggleTick = (id: string): void => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!detail) return <div className="app-loading">Loading…</div>;

  const allTicked = visible.length > 0 && visible.every((endpoint) => ticked.has(endpoint.id));

  return (
    <div className="app doc-app">
      <header className="topbar">
        <div className="identity">
          <button className="btn small" onClick={onBack} title="Back to the document list">
            ‹ Documents
          </button>
          <span className="doc-title" title={detail.summary.title}>
            {detail.summary.title}
          </span>
          <span className="session-host">
            {detail.summary.endpointCount} endpoint
            {detail.summary.endpointCount === 1 ? '' : 's'} · {detail.summary.format}
          </span>
        </div>

        <div className="tabs-space">
          <input
            className="input filter"
            placeholder="Filter endpoints…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <div className="meta">
          <label className="toggle" title="Replace credentials with placeholders in copied commands">
            <input
              type="checkbox"
              checked={curlOptions.redact}
              onChange={(event) =>
                setCurlOptions({ ...curlOptions, redact: event.target.checked })
              }
            />
            Redact
          </label>
          <select
            className="input tiny"
            value={curlOptions.shell}
            onChange={(event) =>
              setCurlOptions({
                ...curlOptions,
                shell: event.target.value as CurlOptions['shell'],
              })
            }
            title={`Commands are escaped for ${shellLabel(curlOptions.shell)} — picked from your platform`}
          >
            <option value="posix">bash / zsh</option>
            <option value="powershell">PowerShell</option>
          </select>
          <ExportMenu
            importId={importId}
            curlOptions={curlOptions}
            detail={detail}
            selection={[...ticked]}
          />
        </div>
      </header>

      {detail.summary.warnings.length > 0 && (
        <div className="warnbar">
          <strong>Reading this document</strong>
          <span>{detail.summary.warnings.join(' ')}</span>
        </div>
      )}

      {detail.variables.length > 0 && (
        <section className={`values-bar${showValues ? '' : ' collapsed'}`}>
          <div className="values-head">
            <h2>
              Shared values
              {unfilled > 0 && <span className="badge warn">{unfilled} to fill in</span>}
            </h2>
            <span className="muted">Applied to every endpoint, and to what you copy and export.</span>
            <div className="spacer" />
            <button className="link-btn" onClick={() => setShowValues((value) => !value)}>
              {showValues ? 'Hide' : 'Show'}
            </button>
          </div>

          {showValues && (
            <div className="values-grid">
              {detail.variables.map((variable, index) => (
                <label key={variable.key} className="value-field">
                  <span className="value-name">
                    {variable.key}
                    {variable.secret && <em className="secret">secret</em>}
                    <em className="origin">{variable.origin}</em>
                  </span>
                  <input
                    className="input mono"
                    type={variable.secret ? 'password' : 'text'}
                    value={variable.value}
                    placeholder={variable.secret ? 'not set' : `{${variable.key}}`}
                    onChange={(event) => {
                      const next = [...detail.variables];
                      next[index] = { ...variable, value: event.target.value };
                      void saveVariables(next);
                    }}
                  />
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="doc-split">
        <aside className="endpoint-rail">
          <div className="rail-head">
            <label className="rail-all" title="Select every endpoint shown">
              <input
                type="checkbox"
                checked={allTicked}
                onChange={() =>
                  setTicked(
                    allTicked ? new Set() : new Set(visible.map((endpoint) => endpoint.id)),
                  )
                }
              />
              {ticked.size > 0 ? `${ticked.size} selected` : 'Select'}
            </label>
            {ticked.size > 0 && (
              <BulkCopy
                importId={importId}
                ids={[...ticked]}
                curls={curls}
                curlOptions={curlOptions}
              />
            )}
          </div>

          <ol className="rail-list">
            {visible.length === 0 && (
              <li className="rail-empty">
                {detail.endpoints.length === 0
                  ? 'No endpoints were recognised in this document.'
                  : 'Nothing matches that filter.'}
              </li>
            )}
            {visible.map((endpoint, index) => (
              <RailItem
                key={endpoint.id}
                endpoint={endpoint}
                previous={visible[index - 1]}
                active={endpoint.id === selectedId}
                ticked={ticked.has(endpoint.id)}
                onSelect={() => setSelectedId(endpoint.id)}
                onTick={() => toggleTick(endpoint.id)}
              />
            ))}
          </ol>

          <footer className="rail-footer">
            <ConfirmButton
              className="btn small danger"
              confirmLabel="Delete this import?"
              onConfirm={() => void api.deleteImport(importId).then(onBack)}
            >
              Delete import
            </ConfirmButton>
          </footer>
        </aside>

        <section className="endpoint-detail">
          {selected ? (
            <>
              <div className="detail-head">
                <h2>{selected.name}</h2>
                {selected.section.length > 1 && (
                  <span className="detail-section">
                    {selected.section.slice(0, -1).join(' › ')}
                  </span>
                )}
              </div>

              <div className="detail-panes">
                <div className="pane pane-request">
                  <RequestEditor
                    endpoint={selected}
                    curl={curls[selected.id] ?? ''}
                    curlOptions={curlOptions}
                    onSaved={load}
                  />
                </div>
                <div className="pane pane-docs">
                  <DocPanel endpoint={selected} />
                </div>
              </div>
            </>
          ) : (
            <div className="empty">
              <h3>Nothing to show</h3>
              <p>
                {detail.endpoints.length === 0
                  ? 'No endpoints were recognised in this document.'
                  : 'Pick an endpoint from the list.'}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** A row in the list, with its section heading printed once above it. */
function RailItem({
  endpoint,
  previous,
  active,
  ticked,
  onSelect,
  onTick,
}: {
  endpoint: Endpoint;
  previous: Endpoint | undefined;
  active: boolean;
  ticked: boolean;
  onSelect: () => void;
  onTick: () => void;
}) {
  const section = endpoint.section.slice(0, -1).join(' › ');
  const previousSection = previous?.section.slice(0, -1).join(' › ') ?? null;
  const showHeading = section.length > 0 && section !== previousSection;

  return (
    <>
      {showHeading && <li className="rail-section">{section}</li>}
      <li className={`rail-row${active ? ' active' : ''}`}>
        <input
          type="checkbox"
          className="rail-tick"
          checked={ticked}
          onChange={onTick}
          aria-label={`Select ${endpoint.name}`}
          onClick={(event) => event.stopPropagation()}
        />
        <button className="rail-item" onClick={onSelect} aria-current={active}>
          <span className={`method ${endpoint.resolved.method.toUpperCase()}`}>
            {endpoint.resolved.method}
          </span>
          <span className="rail-name" title={endpoint.resolved.url}>
            {endpoint.name}
          </span>
          {endpoint.edited && <em className="rail-flag" title="You have edited this">•</em>}
          {endpoint.placeholders.length > 0 && (
            <em className="rail-flag warn" title="A placeholder is unfilled">
              ⚠
            </em>
          )}
        </button>
      </li>
    </>
  );
}

/**
 * Copying a selection straight into Postman, or into a terminal.
 *
 * Postman's Import accepts a pasted collection as raw text, so putting the
 * collection JSON on the clipboard is a genuine one-step route from here to
 * there — no file to save, find and upload.
 */
function BulkCopy({
  importId,
  ids,
  curls,
  curlOptions,
}: {
  importId: string;
  ids: string[];
  curls: Record<string, string>;
  curlOptions: CurlOptions;
}) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = (label: string): void => {
    setDone(label);
    window.setTimeout(() => setDone(null), 1800);
  };

  const copyCollection = async (): Promise<void> => {
    setBusy(true);
    try {
      const json = await api.exportText(importId, 'postman', curlOptions, { ids });
      if (await copyText(json)) flash('Collection copied — paste it into Postman’s Import');
    } catch {
      flash('Could not build the collection');
    } finally {
      setBusy(false);
    }
  };

  const copyCommands = async (): Promise<void> => {
    const text = ids
      .map((id) => curls[id])
      .filter(Boolean)
      .join('\n\n');
    if (await copyText(text)) flash(`${ids.length} command${ids.length === 1 ? '' : 's'} copied`);
  };

  return (
    <div className="bulk-copy">
      <button
        className="btn small primary"
        disabled={busy}
        title="Copy these as a Postman collection, ready to paste into Import → Raw text"
        onClick={() => void copyCollection()}
      >
        {busy ? 'Building…' : 'Copy for Postman'}
      </button>
      <button
        className="btn small"
        title="Copy these as curl commands"
        onClick={() => void copyCommands()}
      >
        Copy curl
      </button>
      {done && <span className="bulk-done">{done}</span>}
    </div>
  );
}

function ExportMenu({
  importId,
  curlOptions,
  detail,
  selection,
}: {
  importId: string;
  curlOptions: CurlOptions;
  detail: ImportDetail;
  selection: string[];
}) {
  const [open, setOpen] = useState(false);
  const hasSecrets = detail.variables.some((variable) => variable.secret);
  // Exports follow the selection when there is one, and cover the document when
  // there is not — the same rule the copy buttons use.
  const ids = selection.length > 0 ? selection : undefined;
  const scope = ids ? `${ids.length} selected` : 'all endpoints';

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    // Registered late enough not to catch the click that opened it.
    const timer = window.setTimeout(() => window.addEventListener('click', close), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('click', close);
    };
  }, [open]);

  return (
    <div className="export-menu">
      <button className="btn small primary" onClick={() => setOpen((value) => !value)}>
        Export ▾
      </button>
      {open && (
        <div className="export-popover">
          <p className="export-scope">Downloading {scope}</p>
          <a className="export-item" href={api.exportUrl(importId, 'postman', curlOptions, { ids })}>
            <strong>Postman collection</strong>
            <span>
              Folders, path variables and documented responses.
              {hasSecrets && ' Credentials become collection variables.'}
            </span>
          </a>
          {hasSecrets && (
            <a
              className="export-item"
              href={api.exportUrl(importId, 'postman', curlOptions, { ids, inline: true })}
            >
              <strong>Postman collection, credentials inline</strong>
              <span>For your own use only — do not share this file.</span>
            </a>
          )}
          <a className="export-item" href={api.exportUrl(importId, 'script', curlOptions, { ids })}>
            <strong>Shell script</strong>
            <span>Every command, commented out, ready to uncomment and run.</span>
          </a>
          <a className="export-item" href={api.exportUrl(importId, 'markdown', curlOptions, { ids })}>
            <strong>Markdown</strong>
            <span>The endpoints, their fields and their response codes.</span>
          </a>
        </div>
      )}
    </div>
  );
}
