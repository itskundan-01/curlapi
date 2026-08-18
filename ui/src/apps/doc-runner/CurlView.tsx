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
 * Each part is a button. Clicking the URL opens the parameters, a header opens
 * the header table with that row focused, the payload opens the body — so
 * seeing something wrong and fixing it is one click, not a hunt for the tab it
 * lives under.
 *
 * Two things this view refuses to do, both learned the hard way:
 *
 * - **Nothing is truncated.** An earlier version ellipsised each line, so the
 *   payload — the part most worth checking — showed as `--data-raw $'{\n
 *   "brandNo"…` and the only way to read it was to click through to the body
 *   editor. Lines wrap instead.
 * - **The payload keeps its shape.** The command is generated with the body on
 *   its own lines rather than escaped onto one (see `escapePosixReadable`), so
 *   what is displayed here is exactly what the Copy button puts on the
 *   clipboard, and both look like the commands these documents are written in.
 */

type Segment = {
  /** May span several lines: a JSON payload is one segment, not one per line. */
  text: string;
  tab: EditorTab | null;
  /** Which header row to focus, when this segment is one. */
  headerName?: string;
  kind: 'command' | 'url' | 'header' | 'body';
};

/** Body lines shown before the block is collapsed. */
const BODY_PREVIEW_LINES = 24;

/**
 * Splits a generated command into clickable parts.
 *
 * Driven by the shape the builder emits — `curl 'url'` first, then one
 * continued line per flag — rather than by re-parsing the command, which would
 * be a second implementation of the thing that produced it. The one piece of
 * real parsing is finding where a multi-line payload ends: it runs until a line
 * closes the quote the data flag opened.
 */
function segment(curl: string): Segment[] {
  const lines = curl.split('\n');
  const segments: Segment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim().replace(/\s*\\$/, '');

    if (/^curl\b/.test(trimmed)) {
      segments.push({ text: line, tab: 'params', kind: 'url' });
      continue;
    }

    const header = /^-H\s+['"]([^:'"]+):/.exec(trimmed);
    if (header) {
      segments.push({ text: line, tab: 'headers', headerName: header[1], kind: 'header' });
      continue;
    }

    if (/^(--data|-d\b|--form|-F\b)/.test(trimmed)) {
      // The payload runs to the line that closes the opening quote. A single
      // line closes it immediately; a formatted JSON body takes several.
      const collected = [line];
      while (!closesQuote(collected.at(-1)!) && i + 1 < lines.length) {
        i++;
        collected.push(lines[i]);
      }
      segments.push({ text: collected.join('\n'), tab: 'body', kind: 'body' });
      continue;
    }

    segments.push({ text: line, tab: null, kind: 'command' });
  }

  return segments;
}

/** True when a line ends the quoted argument a data flag opened. */
function closesQuote(line: string): boolean {
  const text = line.replace(/\s*\\$/, '').trimEnd();
  if (!text.endsWith("'") && !text.endsWith('"')) return false;
  // `--data-raw '{` opens without closing; `--data-raw '{"a":1}'` does both.
  const quotes = (text.match(/'/g) ?? []).length;
  return quotes >= 2;
}

type Token = { text: string; cls: string };

/**
 * Colours one part of the command.
 *
 * Per kind rather than one grammar for the whole command: a flag is only a flag
 * at the start of its own line, and `--data-raw` inside a JSON string is a
 * string. Knowing which part is being rendered removes the ambiguity instead of
 * trying to resolve it.
 */
function tokenize(segment: Segment): Token[] {
  const { text, kind } = segment;

  if (kind === 'body') {
    const open = /^(\s*)(--?[\w-]+)(\s+)/.exec(text);
    if (!open) return jsonTokens(text);
    return [
      { text: open[1], cls: '' },
      { text: open[2], cls: 'tk-flag' },
      { text: open[3], cls: '' },
      ...jsonTokens(text.slice(open[0].length)),
    ];
  }

  const tokens: Token[] = [];
  const pattern = /(^\s+)|(\bcurl\b)|(--?[A-Za-z][\w-]*)|('(?:[^']|\\')*'?)|(\\$)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index), cls: '' });
    const [whole, indent, keyword, flag, quoted, continuation] = match;
    if (indent !== undefined) tokens.push({ text: whole, cls: '' });
    else if (keyword !== undefined) tokens.push({ text: whole, cls: 'tk-cmd' });
    else if (flag !== undefined) tokens.push({ text: whole, cls: 'tk-flag' });
    else if (continuation !== undefined) tokens.push({ text: whole, cls: 'tk-punct' });
    else if (quoted !== undefined && kind === 'header') tokens.push(...headerTokens(whole));
    else tokens.push({ text: whole, cls: 'tk-string' });
    last = match.index + whole.length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), cls: '' });
  return tokens;
}

/** `'Api-Key: DDDD8888'` — the name reads as a label, the value as the value. */
function headerTokens(quoted: string): Token[] {
  const split = quoted.indexOf(':');
  if (split === -1) return [{ text: quoted, cls: 'tk-string' }];
  return [
    { text: quoted.slice(0, split + 1), cls: 'tk-key' },
    { text: quoted.slice(split + 1), cls: 'tk-string' },
  ];
}

const JSON_PATTERN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function jsonTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_PATTERN)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index), cls: 'tk-punct' });
    const [whole, string, colon, number, literal] = match;
    if (string !== undefined) {
      // A string followed by a colon is a field name, and naming the fields is
      // most of what makes a payload readable at a glance.
      tokens.push({ text: string, cls: colon ? 'tk-key' : 'tk-string' });
      if (colon) tokens.push({ text: colon, cls: 'tk-punct' });
    } else if (number !== undefined) tokens.push({ text: whole, cls: 'tk-number' });
    else if (literal !== undefined) tokens.push({ text: whole, cls: 'tk-literal' });
    last = match.index + whole.length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), cls: 'tk-punct' });
  return tokens;
}

function titleFor(segment: Segment): string | undefined {
  switch (segment.kind) {
    case 'header':
      return `Edit the ${segment.headerName} header`;
    case 'body':
      return 'Edit the body';
    case 'url':
      return 'Edit the URL and its parameters';
    default:
      return undefined;
  }
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
  const [expanded, setExpanded] = useState(false);

  if (curl.length === 0) {
    return <p className="editor-note">Building the command…</p>;
  }

  const lineCount = curl.split('\n').length;

  return (
    <div className="curl-view">
      <div className="curl-view-head">
        <span className="curl-shell">{shellLabel}</span>
        {redacted && <span className="badge warn">credentials redacted</span>}
        <span className="curl-hint">Click any part to edit it</span>
        <div className="spacer" />
        <CopyButton text={curl} label="Copy as curl" />
      </div>

      <div className="curl-block">
        <div className="curl-lines" role="list">
          {segments.map((part, index) => (
            <CommandPart
              key={index}
              part={part}
              expanded={expanded}
              onExpand={() => setExpanded(true)}
              onEdit={onEdit}
            />
          ))}
        </div>
        <div className="curl-foot">
          <span className="curl-count">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
          <div className="spacer" />
          <button className="link-btn quiet" onClick={() => setPasting((value) => !value)}>
            {pasting ? 'Cancel' : 'Replace with a pasted command'}
          </button>
        </div>
      </div>

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
  );
}

/**
 * One clickable part of the command.
 *
 * A long payload is shown to a readable depth with the rest one click away,
 * rather than either cut off or unrolled to four hundred lines above everything
 * else on the screen.
 */
function CommandPart({
  part,
  expanded,
  onExpand,
  onEdit,
}: {
  part: Segment;
  expanded: boolean;
  onExpand: () => void;
  onEdit: (tab: EditorTab, focus?: string) => void;
}) {
  const lines = part.text.split('\n');
  const clipped = part.kind === 'body' && !expanded && lines.length > BODY_PREVIEW_LINES;
  const shown = clipped ? lines.slice(0, BODY_PREVIEW_LINES).join('\n') : part.text;
  const tokens = tokenize({ ...part, text: shown });

  return (
    <>
      <button
        role="listitem"
        className={`curl-line ${part.kind}`}
        disabled={part.tab === null}
        title={titleFor(part)}
        onClick={() => part.tab && onEdit(part.tab, part.headerName)}
      >
        <span className="curl-text">
          {tokens.map((token, index) => (
            <span key={index} className={token.cls}>
              {token.text}
            </span>
          ))}
        </span>
        {part.tab !== null && <span className="curl-edit">edit</span>}
      </button>
      {clipped && (
        <button className="curl-more" onClick={onExpand}>
          Show {lines.length - BODY_PREVIEW_LINES} more lines
        </button>
      )}
    </>
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
