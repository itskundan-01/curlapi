import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  DocEntry,
  DocFolder,
  HeaderPair,
  RequestBody,
  RequestRecord,
  ResponseBody,
  RedirectHop,
  SessionRecord,
  SessionSummary,
  Verdict,
} from '../types.ts';
import { DB_PATH, ensureDirs } from '../paths.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  primary_host TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  url              TEXT NOT NULL,
  method           TEXT NOT NULL,
  host             TEXT NOT NULL,
  path             TEXT NOT NULL,
  query            TEXT NOT NULL DEFAULT '',
  short_name       TEXT NOT NULL,
  resource_type    TEXT NOT NULL,
  request_headers  TEXT NOT NULL DEFAULT '[]',
  request_body     TEXT,
  status           INTEGER,
  status_text      TEXT NOT NULL DEFAULT '',
  response_headers TEXT NOT NULL DEFAULT '[]',
  mime_type        TEXT NOT NULL DEFAULT '',
  response_body    TEXT,
  response_size    INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  duration_ms      INTEGER,
  redirect_chain   TEXT NOT NULL DEFAULT '[]',
  error            TEXT,
  verdict          TEXT NOT NULL,
  approved         INTEGER NOT NULL DEFAULT 0,
  action_group     TEXT,
  title            TEXT,
  order_index      INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_requests_session_seq ON requests(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_requests_approved ON requests(session_id, approved);

CREATE TABLE IF NOT EXISTS doc_folders (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_folders_session ON doc_folders(session_id, position);

CREATE TABLE IF NOT EXISTS doc_entries (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  folder_id     TEXT NOT NULL DEFAULT '',
  request_id    TEXT,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  curl_snapshot TEXT NOT NULL DEFAULT '',
  record_snapshot TEXT,
  url           TEXT NOT NULL DEFAULT '',
  method        TEXT NOT NULL DEFAULT '',
  status        INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_session ON doc_entries(session_id, position);
`;

/**
 * Indexes over columns that migrations add.
 *
 * Kept out of SCHEMA and applied afterwards: on a database created before those
 * columns existed, `CREATE TABLE IF NOT EXISTS` is a no-op and the index would
 * be built against a column that is not there yet, failing the whole open.
 */
const POST_MIGRATION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_doc_folder ON doc_entries(folder_id, position);
`;

/** Name given to the document created for entries that predate folders. */
const DEFAULT_FOLDER_NAME = 'API notes';

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: Row): RequestRecord {
  return {
    id: String(row['id']),
    sessionId: String(row['session_id']),
    seq: Number(row['seq']),
    url: String(row['url']),
    method: String(row['method']),
    host: String(row['host']),
    path: String(row['path']),
    query: String(row['query'] ?? ''),
    shortName: String(row['short_name']),
    resourceType: String(row['resource_type']),
    requestHeaders: parseJson<HeaderPair[]>(row['request_headers'], []),
    requestBody: parseJson<RequestBody | null>(row['request_body'], null),
    status: row['status'] === null ? null : Number(row['status']),
    statusText: String(row['status_text'] ?? ''),
    responseHeaders: parseJson<HeaderPair[]>(row['response_headers'], []),
    mimeType: String(row['mime_type'] ?? ''),
    responseBody: parseJson<ResponseBody | null>(row['response_body'], null),
    responseSize: Number(row['response_size'] ?? 0),
    startedAt: Number(row['started_at']),
    endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
    durationMs: row['duration_ms'] === null ? null : Number(row['duration_ms']),
    redirectChain: parseJson<RedirectHop[]>(row['redirect_chain'], []),
    error: row['error'] === null ? null : String(row['error']),
    verdict: parseJson<Verdict>(row['verdict'], { keep: true, reason: '', score: 0 }),
    approved: Number(row['approved']) === 1,
    actionGroup: row['action_group'] === null ? null : String(row['action_group']),
    title: row['title'] === null ? null : String(row['title']),
    orderIndex: row['order_index'] === null ? null : Number(row['order_index']),
  };
}

export class Store {
  #db: DatabaseSync;

  constructor(path: string = DB_PATH) {
    ensureDirs();
    this.#db = new DatabaseSync(path);
    // WAL keeps the UI's reads from blocking the recorder's writes mid-capture.
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
    this.#migrate();
    this.#db.exec(POST_MIGRATION_INDEXES);
  }

  /**
   * Brings an existing database up to the current schema.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing for a table that already exists,
   * so columns added later have to be applied by hand. A user with notes from a
   * previous run must not lose them because folders arrived afterwards.
   */
  #migrate(): void {
    const columns = this.#db.prepare('PRAGMA table_info(doc_entries)').all() as Row[];
    const has = (name: string) => columns.some((column) => String(column['name']) === name);

    // Older entries have no snapshot; they keep working from curl_snapshot.
    if (!has('record_snapshot')) {
      this.#db.exec('ALTER TABLE doc_entries ADD COLUMN record_snapshot TEXT');
    }

    if (has('folder_id')) return;

    this.#db.exec("ALTER TABLE doc_entries ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''");

    // Existing entries are unfiled, so give each affected session one document
    // holding exactly what it had before. Order is preserved by position.
    const sessions = this.#db
      .prepare("SELECT DISTINCT session_id FROM doc_entries WHERE folder_id = ''")
      .all() as Row[];
    for (const row of sessions) {
      const sessionId = String(row['session_id']);
      const folder = this.createFolder(sessionId, DEFAULT_FOLDER_NAME);
      this.#db
        .prepare("UPDATE doc_entries SET folder_id = ? WHERE session_id = ? AND folder_id = ''")
        .run(folder.id, sessionId);
    }
  }

  close(): void {
    this.#db.close();
  }

  createSession(session: SessionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, label, started_at, ended_at, primary_host)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.label,
        session.startedAt,
        session.endedAt,
        session.primaryHost,
      );
  }

  endSession(id: string, endedAt: number): void {
    this.#db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, id);
  }

  setPrimaryHost(id: string, host: string): void {
    this.#db
      .prepare('UPDATE sessions SET primary_host = ? WHERE id = ? AND primary_host IS NULL')
      .run(host, id);
  }

  listSessions(): SessionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
      .all() as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      label: String(row['label']),
      startedAt: Number(row['started_at']),
      endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
      primaryHost: row['primary_host'] === null ? null : String(row['primary_host']),
    }));
  }

  /**
   * Sessions with their headline counts, for the session picker.
   *
   * Aggregated in SQL rather than by loading every record: the picker refreshes
   * with each status push, and walking thousands of rows to render a dropdown
   * would make the UI cost grow with the size of the history behind it.
   */
  listSessionSummaries(): SessionSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT s.*,
                COUNT(r.id) AS total,
                COALESCE(SUM(json_extract(r.verdict, '$.keep') = 1), 0) AS kept,
                COALESCE(SUM(r.approved = 1), 0) AS approved
         FROM sessions s
         LEFT JOIN requests r ON r.session_id = s.id
         GROUP BY s.id
         -- rowid breaks the tie so the picker's order never flickers between
         -- refreshes for two sessions started in the same millisecond.
         ORDER BY s.started_at DESC, s.rowid DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      label: String(row['label']),
      startedAt: Number(row['started_at']),
      endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
      primaryHost: row['primary_host'] === null ? null : String(row['primary_host']),
      total: Number(row['total'] ?? 0),
      kept: Number(row['kept'] ?? 0),
      approved: Number(row['approved'] ?? 0),
    }));
  }

  getSession(id: string): SessionRecord | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      label: String(row['label']),
      startedAt: Number(row['started_at']),
      endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
      primaryHost: row['primary_host'] === null ? null : String(row['primary_host']),
    };
  }

  /** Next serial number for a session. This is the "#" the user sees in the UI. */
  nextSeq(sessionId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM requests WHERE session_id = ?')
      .get(sessionId) as Row;
    return Number(row['max_seq']) + 1;
  }

  upsertRequest(record: RequestRecord): void {
    this.#db
      .prepare(
        `INSERT INTO requests (
           id, session_id, seq, url, method, host, path, query, short_name, resource_type,
           request_headers, request_body, status, status_text, response_headers, mime_type,
           response_body, response_size, started_at, ended_at, duration_ms, redirect_chain,
           error, verdict, approved, action_group, title, order_index
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url,
           method = excluded.method,
           status = excluded.status,
           status_text = excluded.status_text,
           request_headers = excluded.request_headers,
           request_body = excluded.request_body,
           response_headers = excluded.response_headers,
           mime_type = excluded.mime_type,
           response_body = excluded.response_body,
           response_size = excluded.response_size,
           ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms,
           redirect_chain = excluded.redirect_chain,
           error = excluded.error,
           verdict = excluded.verdict`,
      )
      .run(
        record.id,
        record.sessionId,
        record.seq,
        record.url,
        record.method,
        record.host,
        record.path,
        record.query,
        record.shortName,
        record.resourceType,
        JSON.stringify(record.requestHeaders),
        record.requestBody ? JSON.stringify(record.requestBody) : null,
        record.status,
        record.statusText,
        JSON.stringify(record.responseHeaders),
        record.mimeType,
        record.responseBody ? JSON.stringify(record.responseBody) : null,
        record.responseSize,
        record.startedAt,
        record.endedAt,
        record.durationMs,
        JSON.stringify(record.redirectChain),
        record.error,
        JSON.stringify(record.verdict),
        record.approved ? 1 : 0,
        record.actionGroup,
        record.title,
        record.orderIndex,
      );
  }

  listRequests(sessionId: string, options: { includeNoise?: boolean } = {}): RequestRecord[] {
    const sql = options.includeNoise
      ? 'SELECT * FROM requests WHERE session_id = ? ORDER BY seq'
      : `SELECT * FROM requests WHERE session_id = ?
         AND json_extract(verdict, '$.keep') = 1 ORDER BY seq`;
    const rows = this.#db.prepare(sql).all(sessionId) as Row[];
    return rows.map(rowToRecord);
  }

  listApproved(sessionId: string): RequestRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM requests WHERE session_id = ? AND approved = 1
         ORDER BY COALESCE(order_index, seq)`,
      )
      .all(sessionId) as Row[];
    return rows.map(rowToRecord);
  }

  getRequest(id: string): RequestRecord | null {
    const row = this.#db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  setApproved(id: string, approved: boolean): void {
    this.#db
      .prepare('UPDATE requests SET approved = ? WHERE id = ?')
      .run(approved ? 1 : 0, id);
  }

  setTitle(id: string, title: string | null): void {
    this.#db.prepare('UPDATE requests SET title = ? WHERE id = ?').run(title, id);
  }

  setOrder(ids: string[]): void {
    const statement = this.#db.prepare('UPDATE requests SET order_index = ? WHERE id = ?');
    for (const [index, id] of ids.entries()) statement.run(index, id);
  }

  setApprovedMany(ids: string[], approved: boolean): void {
    const statement = this.#db.prepare('UPDATE requests SET approved = ? WHERE id = ?');
    for (const id of ids) statement.run(approved ? 1 : 0, id);
  }

  /**
   * Wipes captured requests but leaves the session and its document intact, so
   * the user can reset a noisy list and keep watching without losing notes.
   */
  clearRequests(sessionId: string): number {
    const before = this.#db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?')
      .get(sessionId) as Row;
    this.#db.prepare('DELETE FROM requests WHERE session_id = ?').run(sessionId);
    return Number(before['n']);
  }

  // --- document folders ------------------------------------------------------

  listFolders(sessionId: string): DocFolder[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM doc_folders WHERE session_id = ? ORDER BY position, created_at',
      )
      .all(sessionId) as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      sessionId: String(row['session_id']),
      name: String(row['name'] ?? ''),
      position: Number(row['position']),
      createdAt: Number(row['created_at']),
    }));
  }

  getFolder(id: string): DocFolder | null {
    const row = this.#db.prepare('SELECT * FROM doc_folders WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      sessionId: String(row['session_id']),
      name: String(row['name'] ?? ''),
      position: Number(row['position']),
      createdAt: Number(row['created_at']),
    };
  }

  createFolder(sessionId: string, name: string): DocFolder {
    const row = this.#db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_position FROM doc_folders WHERE session_id = ?',
      )
      .get(sessionId) as Row;
    const folder: DocFolder = {
      id: randomUUID(),
      sessionId,
      name: name.trim().length > 0 ? name.trim() : 'Untitled',
      position: Number(row['max_position']) + 1,
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        `INSERT INTO doc_folders (id, session_id, name, position, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(folder.id, folder.sessionId, folder.name, folder.position, folder.createdAt);
    return folder;
  }

  /**
   * The document entries land in when the user has not picked one.
   *
   * Created lazily rather than up front: a session where nobody opens the Doc
   * tab should not leave an empty document behind.
   */
  defaultFolder(sessionId: string): DocFolder {
    return this.listFolders(sessionId)[0] ?? this.createFolder(sessionId, DEFAULT_FOLDER_NAME);
  }

  renameFolder(id: string, name: string): void {
    const value = name.trim();
    this.#db
      .prepare('UPDATE doc_folders SET name = ? WHERE id = ?')
      .run(value.length > 0 ? value : 'Untitled', id);
  }

  /** Deletes a document and everything filed under it. */
  deleteFolder(id: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM doc_entries WHERE folder_id = ?')
      .get(id) as Row;
    this.#db.prepare('DELETE FROM doc_entries WHERE folder_id = ?').run(id);
    this.#db.prepare('DELETE FROM doc_folders WHERE id = ?').run(id);
    return Number(row['n']);
  }

  reorderFolders(ids: string[]): void {
    const statement = this.#db.prepare('UPDATE doc_folders SET position = ? WHERE id = ?');
    for (const [index, id] of ids.entries()) statement.run(index, id);
  }

  // --- document entries ------------------------------------------------------

  /** Positions are per folder, so every document numbers its commands from 1. */
  #nextDocPosition(folderId: string): number {
    const row = this.#db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_position FROM doc_entries WHERE folder_id = ?',
      )
      .get(folderId) as Row;
    return Number(row['max_position']) + 1;
  }

  addDocEntry(
    entry: Omit<DocEntry, 'position' | 'createdAt' | 'folderId' | 'recordSnapshot'> & {
      folderId?: string;
      recordSnapshot?: RequestRecord | null;
    },
  ): DocEntry {
    const folderId = entry.folderId ?? this.defaultFolder(entry.sessionId).id;
    const full: DocEntry = {
      ...entry,
      folderId,
      recordSnapshot: entry.recordSnapshot ?? null,
      position: this.#nextDocPosition(folderId),
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        `INSERT INTO doc_entries
           (id, session_id, folder_id, request_id, position, title, note, curl_snapshot,
            record_snapshot, url, method, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        full.id,
        full.sessionId,
        full.folderId,
        full.requestId,
        full.position,
        full.title,
        full.note,
        full.curlSnapshot,
        full.recordSnapshot ? JSON.stringify(full.recordSnapshot) : null,
        full.url,
        full.method,
        full.status,
        full.createdAt,
      );
    return full;
  }

  listDocEntries(sessionId: string, folderId?: string): DocEntry[] {
    // Ordered by folder first so a whole-document export reads in the order the
    // folders are shown, then by each entry's position inside its folder.
    const rows = (
      folderId === undefined
        ? this.#db
            .prepare(
              `SELECT e.* FROM doc_entries e
               LEFT JOIN doc_folders f ON f.id = e.folder_id
               WHERE e.session_id = ?
               ORDER BY COALESCE(f.position, 0), e.position, e.created_at`,
            )
            .all(sessionId)
        : this.#db
            .prepare(
              `SELECT * FROM doc_entries WHERE session_id = ? AND folder_id = ?
               ORDER BY position, created_at`,
            )
            .all(sessionId, folderId)
    ) as Row[];

    return rows.map((row) => ({
      id: String(row['id']),
      sessionId: String(row['session_id']),
      folderId: String(row['folder_id'] ?? ''),
      requestId: row['request_id'] === null ? null : String(row['request_id']),
      position: Number(row['position']),
      title: String(row['title'] ?? ''),
      note: String(row['note'] ?? ''),
      curlSnapshot: String(row['curl_snapshot'] ?? ''),
      recordSnapshot: parseJson<RequestRecord | null>(row['record_snapshot'], null),
      url: String(row['url'] ?? ''),
      method: String(row['method'] ?? ''),
      status: row['status'] === null ? null : Number(row['status']),
      createdAt: Number(row['created_at']),
    }));
  }

  /**
   * The captured request behind a document entry, from the entry's own copy.
   *
   * Lets the detail view, the curl builder and Run keep working for anything
   * documented after the capture it came from has been discarded.
   */
  getDocSnapshot(requestId: string): RequestRecord | null {
    const row = this.#db
      .prepare(
        `SELECT record_snapshot FROM doc_entries
         WHERE request_id = ? AND record_snapshot IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(requestId) as Row | undefined;
    return row ? parseJson<RequestRecord | null>(row['record_snapshot'], null) : null;
  }

  /** Moves an entry to another document, appending it at the end. */
  moveDocEntry(id: string, folderId: string): void {
    this.#db
      .prepare('UPDATE doc_entries SET folder_id = ?, position = ? WHERE id = ?')
      .run(folderId, this.#nextDocPosition(folderId), id);
  }

  updateDocEntry(id: string, fields: { title?: string; note?: string }): void {
    if (fields.title !== undefined) {
      this.#db.prepare('UPDATE doc_entries SET title = ? WHERE id = ?').run(fields.title, id);
    }
    if (fields.note !== undefined) {
      this.#db.prepare('UPDATE doc_entries SET note = ? WHERE id = ?').run(fields.note, id);
    }
  }

  deleteDocEntry(id: string): void {
    this.#db.prepare('DELETE FROM doc_entries WHERE id = ?').run(id);
  }

  reorderDocEntries(ids: string[]): void {
    const statement = this.#db.prepare('UPDATE doc_entries SET position = ? WHERE id = ?');
    for (const [index, id] of ids.entries()) statement.run(index, id);
  }

  // --- retention -------------------------------------------------------------

  /**
   * Throws away a session's captured requests, keeping only what was chosen.
   *
   * A capture is working state: hundreds of requests with response bodies, of
   * which a handful matter. Keeping every session forever buries the ones that
   * do and grows the database without limit. What survives is what the user
   * deliberately picked — anything in a document, and anything approved into the
   * collection, which is the same act of selection one step earlier.
   */
  pruneSession(sessionId: string): number {
    const before = this.#db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?')
      .get(sessionId) as Row;

    this.#db
      .prepare(
        `DELETE FROM requests
         WHERE session_id = ?
           AND approved = 0
           AND id NOT IN (
             SELECT request_id FROM doc_entries WHERE request_id IS NOT NULL
           )`,
      )
      .run(sessionId);

    const after = this.#db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?')
      .get(sessionId) as Row;
    return Number(before['n']) - Number(after['n']);
  }

  /** True when a session holds nothing worth keeping. */
  isSessionEmpty(sessionId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM requests WHERE session_id = ?) AS requests,
           (SELECT COUNT(*) FROM doc_entries WHERE session_id = ?) AS entries,
           (SELECT COUNT(*) FROM doc_folders WHERE session_id = ?) AS folders`,
      )
      .get(sessionId, sessionId, sessionId) as Row;
    return (
      Number(row['requests']) === 0 &&
      Number(row['entries']) === 0 &&
      Number(row['folders']) === 0
    );
  }

  /**
   * Prunes every session except one, then removes those left with nothing.
   *
   * Run at the start of a capture so old history is cleared before it can
   * accumulate, and the exception is the session about to be recorded into.
   */
  pruneHistory(exceptSessionId: string): { sessions: number; requests: number } {
    let sessions = 0;
    let requests = 0;
    for (const session of this.listSessions()) {
      if (session.id === exceptSessionId) continue;
      requests += this.pruneSession(session.id);
      if (this.isSessionEmpty(session.id)) {
        this.deleteSession(session.id);
        sessions++;
      }
    }
    return { sessions, requests };
  }

  deleteSession(id: string): void {
    this.#db.prepare('DELETE FROM doc_entries WHERE session_id = ?').run(id);
    this.#db.prepare('DELETE FROM doc_folders WHERE session_id = ?').run(id);
    this.#db.prepare('DELETE FROM requests WHERE session_id = ?').run(id);
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Rough on-disk cost of a session, used to demonstrate the size win over HAR. */
  sessionBytes(sessionId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(
           LENGTH(request_headers) + LENGTH(COALESCE(request_body, '')) +
           LENGTH(response_headers) + LENGTH(COALESCE(response_body, '')) + LENGTH(url)
         ), 0) AS bytes FROM requests WHERE session_id = ?`,
      )
      .get(sessionId) as Row;
    return Number(row['bytes']);
  }
}
