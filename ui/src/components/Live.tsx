import { useMemo, useRef, useState } from 'react';
import type { CurlOptions, DocFolder, SlimRecord } from '../api.ts';
import { formatBytes, formatMs, statusClass } from '../util.ts';
import { Detail } from './Detail.tsx';
import { ConfirmButton } from './ConfirmButton.tsx';
import { FolderPicker } from './FolderPicker.tsx';

type Props = {
  records: SlimRecord[];
  curlOptions: CurlOptions;
  capturing: boolean;
  onApprove: (id: string, approved: boolean) => void;
  onApproveMany: (ids: string[], approved: boolean) => void;
  onClear: () => void;
  onAddToDoc: (ids: string[]) => void;
  folders: DocFolder[];
  activeFolderId: string | null;
  onSelectFolder: (id: string) => void;
  onCreateFolder: (name: string) => void;
};

export function Live({
  records,
  curlOptions,
  capturing,
  onApprove,
  onApproveMany,
  onClear,
  onAddToDoc,
  folders,
  activeFolderId,
  onSelectFolder,
  onCreateFolder,
}: Props) {
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showNoise, setShowNoise] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Anchor for shift-click range selection, as an index into `visible`. */
  const lastToggled = useRef<number | null>(null);

  const methods = useMemo(
    () => [...new Set(records.map((record) => record.method))].sort(),
    [records],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = records
      .filter((record) => showNoise || record.verdict.keep)
      .filter((record) => (method ? record.method === method : true))
      .filter((record) => {
        if (!statusFilter) return true;
        if (statusFilter === 'err') return record.status === null || record.status >= 400;
        return String(record.status ?? '').startsWith(statusFilter);
      })
      .filter((record) =>
        needle.length === 0
          ? true
          : record.url.toLowerCase().includes(needle) ||
            record.shortName.toLowerCase().includes(needle) ||
            (record.title ?? '').toLowerCase().includes(needle),
      );
    return rows.sort((a, b) => (newestFirst ? b.seq - a.seq : a.seq - b.seq));
  }, [records, query, method, statusFilter, showNoise, newestFirst]);

  const noiseCount = records.length - records.filter((record) => record.verdict.keep).length;
  const failedCount = records.filter(
    (record) => record.verdict.keep && (record.error !== null || (record.status ?? 0) >= 400),
  ).length;
  const approvedVisible = visible.filter((record) => record.approved);
  const allVisibleApproved = visible.length > 0 && approvedVisible.length === visible.length;

  /** Shift-click extends the previous toggle across the rows in between. */
  const toggleAt = (index: number, checked: boolean, shift: boolean) => {
    const anchor = lastToggled.current;
    if (shift && anchor !== null && anchor !== index) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      const ids = visible.slice(from, to + 1).map((record) => record.id);
      onApproveMany(ids, checked);
    } else {
      onApprove(visible[index].id, checked);
    }
    lastToggled.current = index;
  };

  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Filter by name or URL…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="">All methods</option>
          {methods.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">Any status</option>
          <option value="2">2xx</option>
          <option value="3">3xx</option>
          <option value="4">4xx</option>
          <option value="5">5xx</option>
          <option value="err">Errors only</option>
        </select>
        <select
          value={newestFirst ? 'new' : 'old'}
          onChange={(event) => setNewestFirst(event.target.value === 'new')}
          title="Row order"
        >
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={showNoise}
            onChange={(event) => setShowNoise(event.target.checked)}
          />
          Show filtered-out ({noiseCount})
        </label>

        {/* One click to the failures, which is the question being asked whenever
            something in the flow stopped working. */}
        {failedCount > 0 && (
          <button
            className={`chip bad${statusFilter === 'err' ? ' on' : ''}`}
            title={
              statusFilter === 'err'
                ? 'Showing failures only — click to show everything'
                : 'Show only calls that errored or returned 4xx/5xx'
            }
            onClick={() => setStatusFilter(statusFilter === 'err' ? '' : 'err')}
          >
            {failedCount} failed
          </button>
        )}

        <div className="spacer" />

        <span className="hint">{visible.length} shown</span>
        {/* Documents keep their own copy of each command, so a clear costs no
            notes — which is why this confirms in place rather than in a dialog. */}
        <ConfirmButton
          disabled={records.length === 0}
          confirmLabel={`Clear ${records.length}?`}
          title={`Clear all ${records.length} captured requests — your document is kept`}
          onConfirm={onClear}
        >
          Clear
        </ConfirmButton>
      </div>

      {approvedVisible.length > 0 && (
        <div className="bulkbar">
          <strong>{approvedVisible.length}</strong> selected
          <button
            className="btn small primary"
            onClick={() => onAddToDoc(approvedVisible.map((record) => record.id))}
          >
            Add to doc
          </button>
          <FolderPicker
            folders={folders}
            activeId={activeFolderId}
            onSelect={onSelectFolder}
            onCreate={onCreateFolder}
          />
          <button
            className="btn small"
            onClick={() => onApproveMany(approvedVisible.map((record) => record.id), false)}
          >
            Deselect all
          </button>
          <div className="spacer" />
          <span className="hint">Shift-click a checkbox to select a range</span>
        </div>
      )}

      <div className="split">
        <div className="table-wrap">
          {visible.length === 0 ? (
            <div className="empty">
              <h3>{capturing ? 'Waiting for API calls' : 'Nothing captured yet'}</h3>
              <p>
                {capturing
                  ? 'Use the site in the browser window that opened. Requests appear here as they happen — images, fonts, scripts and analytics are dropped automatically.'
                  : 'Run curlapi start to record a session.'}
              </p>
            </div>
          ) : (
            <table className="rows">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allVisibleApproved}
                      onChange={(event) =>
                        onApproveMany(
                          visible.map((record) => record.id),
                          event.target.checked,
                        )
                      }
                      aria-label="Select all shown"
                      title="Select all shown"
                    />
                  </th>
                  <th className="seq">#</th>
                  <th>Name</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>Host</th>
                  <th>Type</th>
                  <th className="num">Time</th>
                  <th className="num">Size</th>
                  {showNoise && <th>Why</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((record, index) => (
                  <tr
                    key={record.id}
                    className={
                      [
                        record.verdict.keep ? '' : 'noise',
                        record.error !== null || (record.status ?? 0) >= 400 ? 'failed' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }
                    aria-selected={record.id === selectedId}
                    onClick={() => setSelectedId(record.id)}
                  >
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={record.approved}
                        onChange={(event) =>
                          toggleAt(
                            index,
                            event.target.checked,
                            (event.nativeEvent as MouseEvent).shiftKey,
                          )
                        }
                        aria-label={`Select ${record.shortName}`}
                      />
                    </td>
                    <td className="seq">{record.seq}</td>
                    <td className="name" title={record.url}>
                      {record.title ?? record.shortName}
                    </td>
                    <td>
                      <span className={`method ${record.method}`}>{record.method}</span>
                    </td>
                    <td>
                      <span
                        className={`status ${record.error ? 's5' : statusClass(record.status)}`}
                        title={record.error ?? record.statusText}
                      >
                        {record.status ?? (record.error ? 'ERR' : '—')}
                      </span>
                    </td>
                    <td className="host">{record.host}</td>
                    <td className="host">{record.resourceType}</td>
                    <td className="num">{formatMs(record.durationMs)}</td>
                    <td className="num">{formatBytes(record.responseSize)}</td>
                    {showNoise && <td className="why">{record.verdict.reason}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedId && (
          <Detail
            id={selectedId}
            curlOptions={curlOptions}
            onClose={() => setSelectedId(null)}
            onAddToDoc={onAddToDoc}
          />
        )}
      </div>
    </>
  );
}
