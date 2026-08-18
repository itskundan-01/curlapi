/**
 * Core record shapes shared by the recorder, the store, the server and the UI.
 *
 * Headers are kept as ordered [name, value] pairs rather than an object: duplicate
 * header names are legal on the wire (set-cookie especially) and an object would
 * silently collapse them.
 */

export type HeaderPair = [name: string, value: string];

export type BodyEncoding = 'text' | 'base64';

export type RequestBody = {
  /** How `data` is encoded. Binary payloads round-trip as base64. */
  encoding: BodyEncoding;
  data: string;
  /** Present for multipart form posts, from CDP's postDataEntries. */
  entries?: string[];
  /** True when the browser refused to hand us the full payload. */
  truncated: boolean;
};

export type ResponseBody = {
  encoding: BodyEncoding;
  data: string;
  truncated: boolean;
};

export type RedirectHop = {
  url: string;
  status: number;
  location: string | null;
};

/** Why the filter kept or dropped a request. Always populated, both ways. */
export type Verdict = {
  keep: boolean;
  /** Human-readable, shown verbatim in the UI's "why" column. */
  reason: string;
  /** Positive values indicate API-ish signals; used only for ranking. */
  score: number;
};

export type RequestRecord = {
  /** `${sessionId}:${cdpRequestId}` — stable across the whole capture. */
  id: string;
  sessionId: string;
  /** Serial number in capture order, 1-based. This is the "#" the user sees. */
  seq: number;

  url: string;
  method: string;
  host: string;
  path: string;
  query: string;
  /** Chrome network-tab "Name" column, e.g. `verify`. */
  shortName: string;

  /** CDP Network.ResourceType: XHR, Fetch, Document, Script, Image, ... */
  resourceType: string;

  requestHeaders: HeaderPair[];
  requestBody: RequestBody | null;

  status: number | null;
  statusText: string;
  responseHeaders: HeaderPair[];
  mimeType: string;
  responseBody: ResponseBody | null;
  /** Encoded bytes over the wire, as reported by CDP. */
  responseSize: number;

  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;

  redirectChain: RedirectHop[];
  /** Network-level failure (DNS, aborted, blocked), not an HTTP error status. */
  error: string | null;

  verdict: Verdict;
  approved: boolean;
  /** Label of the user action this request followed, when known. */
  actionGroup: string | null;
  /** User-supplied rename, overrides shortName in the collection view. */
  title: string | null;
  /** Position within the approved collection; null until approved. */
  orderIndex: number | null;
};

/** Body metadata without the payload, for list responses. */
export type BodySummary = {
  encoding: BodyEncoding;
  truncated: boolean;
  size: number;
};

/**
 * A record with its bodies replaced by size metadata. List views send hundreds
 * of these, and shipping megabytes of response payloads to render a table would
 * undo the point of filtering at capture time.
 */
export type SlimRecord = Omit<RequestRecord, 'requestBody' | 'responseBody'> & {
  requestBody: BodySummary | null;
  responseBody: BodySummary | null;
};

export type SessionRecord = {
  id: string;
  label: string;
  startedAt: number;
  endedAt: number | null;
  /** Origin of the first top-level document, used for first-party detection. */
  primaryHost: string | null;
};

/** A session plus its headline counts, for the session picker. */
export type SessionSummary = SessionRecord & {
  total: number;
  kept: number;
  approved: number;
};

/**
 * A named document within a session — the "file" entries are filed under.
 *
 * A session usually covers several distinct flows (login, profile, payments),
 * and a single flat list stops being useful the moment the second one starts.
 * Folders keep each flow separately numbered and separately copyable.
 */
export type DocFolder = {
  id: string;
  sessionId: string;
  name: string;
  position: number;
  createdAt: number;
};

/**
 * One line in the user's working document.
 *
 * `curl` is snapshotted when the entry is created so the document survives the
 * capture being cleared. While the request still exists the command is
 * regenerated live instead, so the redact/clean toggles apply to what gets
 * shared; the snapshot is the fallback, not the usual path.
 */
export type DocEntry = {
  id: string;
  sessionId: string;
  /** The document this entry belongs to. */
  folderId: string;
  /** Null for free-text notes and section headings. */
  requestId: string | null;
  /** Position within its folder, so each document numbers from 1. */
  position: number;
  title: string;
  note: string;
  curlSnapshot: string;
  /**
   * The whole captured request, copied in when the entry is created.
   *
   * This is what makes a document survive its capture being discarded: headers,
   * bodies and timings are all here, so the command can still be rebuilt with
   * different options and still be replayed after the requests are gone.
   */
  recordSnapshot: RequestRecord | null;
  url: string;
  method: string;
  status: number | null;
  createdAt: number;
};

export type ReplayResult = {
  ok: boolean;
  status: number | null;
  statusText: string;
  headers: HeaderPair[];
  body: string;
  bodyEncoding: BodyEncoding;
  truncated: boolean;
  durationMs: number;
  sizeBytes: number;
  /** Null when there was no captured response to compare against. */
  shapeMatchesCapture: boolean | null;
  error: string | null;
};

export type CurlOptions = {
  /** Strip sec-*, priority and other browser-noise headers. Off by default. */
  clean: boolean;
  /** Replace tokens/cookies with placeholders. Off by default. */
  redact: boolean;
  /** POSIX single-quote form, or PowerShell for Windows terminals. */
  shell: 'posix' | 'powershell';
  /** Emit as one line instead of backslash-continued lines. */
  singleLine: boolean;
  /**
   * Keep a multi-line payload on its own lines instead of escaping it to
   * `$'...\n...'`.
   *
   * Off by default, because the capture app's output is diffed against Chrome's
   * own Copy as cURL. The document app turns it on: there, the command is
   * something a person reads to check whether their document was understood.
   */
  readableBody?: boolean;
};

export const DEFAULT_CURL_OPTIONS: CurlOptions = {
  clean: false,
  redact: false,
  shell: 'posix',
  singleLine: false,
};
