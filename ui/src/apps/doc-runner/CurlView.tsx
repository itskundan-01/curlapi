import { useMemo, useState } from 'react';
import { CopyButton } from '../curl-extractor/components/CopyButton.tsx';
import { api } from './api.ts';
import type { EditorTab } from './RequestEditor.tsx';

/**
 * The whole request, as the command that would run it — and as the way in to
 * editing any part of it.
 *
 * This is the first thing shown, not a tab off to the side, because the command
 * *is* the request: it holds the URL, every header and the body in one view,
 * where a tabbed editor shows a third of it at a time. Reading it is how anyone
 * checks whether the document was understood.
 *
 * Each line is a button. Clicking the URL opens the parameters, a header line
 * opens the header table with that row focused, the payload opens the body —
 * so seeing something wrong and fixing it is one click, not a hunt for the tab
 * it lives under.
 */

type Segment = {
  text: string;
  tab: EditorTab | null;
  /** Which header row to focus, when this line is one. */
  headerName?: string;
  kind: 'command' | 'url' | 'header' | 'body' | 'flag';
};

/**
 * Splits a generated command into clickable lines.
 *
 * Driven by the shape the builder emits — `curl 'url'` first, then one
 * continued line per flag — rather than by re-parsing the command, which would
 * be a second implementation of the thing that produced it.
 */
function segment(curl: string): Segment[] {
  const lines = curl.split('\n');
  return lines.map((line) => {
    const trimmed = line.trim().replace(/\s*\\$/, '');

    if (/^curl\b/.test(trimmed)) {
      return { text: line, tab: 'params', kind: 'url' as const };
    }
    const header = /^-H\s+['"]([^:'"]+):/.exec(trimmed);
    if (header) {
      return { text: line, tab: 'headers' as const, headerName: header[1], kind: 'header' as const };
    }
    if (/^(--data|-d\b|--form|-F\b)/.test(trimmed)) {
      return { text: line, tab: 'body' as const, kind: 'body' as const };
    }
    if (/^-X\s/.test(trimmed)) {
      return { text: line, tab: null, kind: 'command' as const };
    }
    // A continuation of the previous line — a multi-line body, usually.
    return { text: line, tab: 'body' as const, kind: 'flag' as const };
  });
}

export function CurlView({
  curl,
  shellLabel,
  redacted,
  endpointId,
  onEdit,
  onReplaced,
}: {
  curl: string;
  shellLabel: string;
  redacted: boolean;
  endpointId: string;
  /** Opens the tab that owns the clicked part, focusing a row where relevant. */
  onEdit: (tab: EditorTab, focus?: string) => void;
  onReplaced: () => void;
}) {
  const segments = useMemo(() => segment(curl), [curl]);
  const [pasting, setPasting] = useState(false);

  if (curl.length === 0) {
    return <p className="editor-note">Building the command…</p>;
  }

  return (
    <div className="curl-view">
      <div className="curl-view-head">
        <span className="curl-shell">{shellLabel}</span>
        {redacted && <span className="badge warn">credentials redacted</span>}
        <span className="curl-hint">Click any line to edit it</span>
        <div className="spacer" />
        <CopyButton text={curl} label="Copy as curl" />
      </div>

      <div className="curl-lines" role="list">
        {segments.map((line, index) => (
          <button
            key={index}
            role="listitem"
            className={`curl-line ${line.kind}`}
            disabled={line.tab === null}
            title={
              line.tab === null
                ? undefined
                : line.kind === 'header'
                  ? `Edit the ${line.headerName} header`
                  : line.kind === 'body'
                    ? 'Edit the body'
                    : 'Edit the URL and its parameters'
            }
            onClick={() => line.tab && onEdit(line.tab, line.headerName)}
          >
            <span className="curl-text">{line.text}</span>
            {line.tab !== null && <span className="curl-edit">edit</span>}
          </button>
        ))}
      </div>

      <div className="curl-replace">
        <button className="link-btn" onClick={() => setPasting((value) => !value)}>
          {pasting ? 'Cancel' : 'Replace with a pasted command'}
        </button>
        {pasting && (
          <PasteCurl
            endpointId={endpointId}
            onDone={() => {
              setPasting(false);
              onReplaced();
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Replacing the request from a command pasted from anywhere.
 *
 * This is how these requests reach people in practice — Chrome's Copy as cURL,
 * a colleague's message, Postman's own code view. It reuses the importer's
 * parser, so a command a word processor has mangled is understood here too.
 */
function PasteCurl({
  endpointId,
  onDone,
}: {
  endpointId: string;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.fromCurl(endpointId, text);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="curl-paste">
      <textarea
        className="body-input short"
        value={text}
        spellCheck={false}
        autoFocus
        placeholder="Paste a curl command — from Chrome's Copy as cURL, from Postman, from anywhere."
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
      />
      <div className="row">
        <button
          className="btn primary"
          disabled={text.trim().length === 0 || busy}
          onClick={() => void apply()}
        >
          {busy ? 'Reading…' : 'Replace request'}
        </button>
        {error && <span className="body-error">{error}</span>}
      </div>
    </div>
  );
}
