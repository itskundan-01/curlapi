/**
 * Storage for imported documents, owned by this app.
 *
 * Deliberately its own tables rather than a reuse of the capture side's
 * `sessions`/`requests`. Those carry capture semantics — a filter verdict, a
 * serial number in browsing order, a retention rule that discards anything
 * nobody approved — and none of them mean anything for a document. An imported
 * endpoint is not working state to be pruned; it is the artefact.
 *
 * The tables live in the same SQLite file, which is what makes an app a module
 * rather than a second program with a second database to back up.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { HeaderPair } from '../../types.ts';
import type { DocParam, ParsedEndpoint, ResponseCode, Variable } from './types.ts';
import type { EndpointOverrides } from './resolve.ts';
import type { SourceFormat } from './parse.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_imports (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  format        TEXT NOT NULL,
  imported_at   INTEGER NOT NULL,
  /** JSON: the reader-editable values applied across every endpoint. */
  variables     TEXT NOT NULL DEFAULT '[]',
  warnings      TEXT NOT NULL DEFAULT '[]',
  stats         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS doc_endpoints (
  id                  TEXT PRIMARY KEY,
  import_id           TEXT NOT NULL,
  position            INTEGER NOT NULL,
  name                TEXT NOT NULL,
  section             TEXT NOT NULL DEFAULT '[]',
  method              TEXT NOT NULL,
  url                 TEXT NOT NULL,
  environments        TEXT NOT NULL DEFAULT '[]',
  headers             TEXT NOT NULL DEFAULT '[]',
  body                TEXT,
  body_mime           TEXT NOT NULL DEFAULT '',
  documented_response TEXT,
  response_codes      TEXT NOT NULL DEFAULT '[]',
  params              TEXT NOT NULL DEFAULT '[]',
  description         TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '[]',
  provenance          TEXT NOT NULL DEFAULT '{}',
  warnings            TEXT NOT NULL DEFAULT '[]',
  /** JSON: the reader's edits, kept apart from what the document said. */
  overrides           TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (import_id) REFERENCES doc_imports(id)
);

CREATE INDEX IF NOT EXISTS idx_doc_endpoints_import
  ON doc_endpoints(import_id, position);
`;

export type ImportSummary = {
  id: string;
  title: string;
  fileName: string;
  format: SourceFormat;
  importedAt: number;
  endpointCount: number;
  warnings: string[];
  stats: Record<string, number>;
};

export type StoredEndpoint = ParsedEndpoint & { overrides: EndpointOverrides };

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToEndpoint(row: Row): StoredEndpoint {
  return {
    id: String(row['id']),
    position: Number(row['position']),
    name: String(row['name']),
    section: parseJson<string[]>(row['section'], []),
    method: String(row['method']),
    url: String(row['url']),
    environments: parseJson(row['environments'], []),
    headers: parseJson<HeaderPair[]>(row['headers'], []),
    body: row['body'] === null ? null : String(row['body']),
    bodyMime: String(row['body_mime'] ?? ''),
    documentedResponse:
      row['documented_response'] === null ? null : String(row['documented_response']),
    responseCodes: parseJson<ResponseCode[]>(row['response_codes'], []),
    params: parseJson<DocParam[]>(row['params'], []),
    description: String(row['description'] ?? ''),
    notes: parseJson<string[]>(row['notes'], []),
    provenance: parseJson(row['provenance'], {
      extractor: 'spec-table' as const,
      confidence: 0,
      blocks: [],
    }),
    warnings: parseJson<string[]>(row['warnings'], []),
    overrides: parseJson<EndpointOverrides>(row['overrides'], {}),
  };
}

export class DocStore {
  #db: DatabaseSync;

  /**
   * Opens against the same file the rest of curlapi uses.
   *
   * The connection is this app's own rather than the capture app's `Store`
   * instance: sharing one would make the two apps' schemas each other's problem,
   * and SQLite in WAL mode handles two readers of one file without either
   * knowing about the other.
   */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  createImport(input: {
    title: string;
    fileName: string;
    format: SourceFormat;
    endpoints: ParsedEndpoint[];
    variables: Variable[];
    warnings: string[];
    stats: Record<string, number>;
  }): string {
    const id = randomUUID();

    this.#db
      .prepare(
        `INSERT INTO doc_imports
           (id, title, file_name, format, imported_at, variables, warnings, stats)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.title,
        input.fileName,
        input.format,
        Date.now(),
        JSON.stringify(input.variables),
        JSON.stringify(input.warnings),
        JSON.stringify(input.stats),
      );

    const statement = this.#db.prepare(
      `INSERT INTO doc_endpoints
         (id, import_id, position, name, section, method, url, environments, headers,
          body, body_mime, documented_response, response_codes, params, description,
          notes, provenance, warnings, overrides)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    for (const endpoint of input.endpoints) {
      statement.run(
        endpoint.id,
        id,
        endpoint.position,
        endpoint.name,
        JSON.stringify(endpoint.section),
        endpoint.method,
        endpoint.url,
        JSON.stringify(endpoint.environments),
        JSON.stringify(endpoint.headers),
        endpoint.body,
        endpoint.bodyMime,
        endpoint.documentedResponse,
        JSON.stringify(endpoint.responseCodes),
        JSON.stringify(endpoint.params),
        endpoint.description,
        JSON.stringify(endpoint.notes),
        JSON.stringify(endpoint.provenance),
        JSON.stringify(endpoint.warnings),
        '{}',
      );
    }

    return id;
  }

  listImports(): ImportSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT i.*, COUNT(e.id) AS endpoint_count
         FROM doc_imports i
         LEFT JOIN doc_endpoints e ON e.import_id = i.id
         GROUP BY i.id
         ORDER BY i.imported_at DESC`,
      )
      .all() as Row[];

    return rows.map((row) => ({
      id: String(row['id']),
      title: String(row['title']),
      fileName: String(row['file_name']),
      format: String(row['format']) as SourceFormat,
      importedAt: Number(row['imported_at']),
      endpointCount: Number(row['endpoint_count'] ?? 0),
      warnings: parseJson<string[]>(row['warnings'], []),
      stats: parseJson<Record<string, number>>(row['stats'], {}),
    }));
  }

  getImport(id: string): ImportSummary | null {
    return this.listImports().find((entry) => entry.id === id) ?? null;
  }

  listEndpoints(importId: string): StoredEndpoint[] {
    const rows = this.#db
      .prepare('SELECT * FROM doc_endpoints WHERE import_id = ? ORDER BY position')
      .all(importId) as Row[];
    return rows.map(rowToEndpoint);
  }

  getEndpoint(id: string): StoredEndpoint | null {
    const row = this.#db.prepare('SELECT * FROM doc_endpoints WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? rowToEndpoint(row) : null;
  }

  /** Which import an endpoint belongs to, for loading its variables. */
  importIdOf(endpointId: string): string | null {
    const row = this.#db
      .prepare('SELECT import_id FROM doc_endpoints WHERE id = ?')
      .get(endpointId) as Row | undefined;
    return row ? String(row['import_id']) : null;
  }

  getVariables(importId: string): Variable[] {
    const row = this.#db
      .prepare('SELECT variables FROM doc_imports WHERE id = ?')
      .get(importId) as Row | undefined;
    return row ? parseJson<Variable[]>(row['variables'], []) : [];
  }

  setVariables(importId: string, variables: Variable[]): void {
    this.#db
      .prepare('UPDATE doc_imports SET variables = ? WHERE id = ?')
      .run(JSON.stringify(variables), importId);
  }

  /**
   * Saves the reader's edits to one endpoint.
   *
   * Stored separately from the parsed fields so the document's own reading is
   * never overwritten — "what it said" and "what I changed it to" are different
   * questions, and a mis-parse is easier to spot when both are still there.
   */
  setOverrides(endpointId: string, overrides: EndpointOverrides): void {
    this.#db
      .prepare('UPDATE doc_endpoints SET overrides = ? WHERE id = ?')
      .run(JSON.stringify(overrides), endpointId);
  }

  rename(endpointId: string, name: string): void {
    this.#db.prepare('UPDATE doc_endpoints SET name = ? WHERE id = ?').run(name, endpointId);
  }

  deleteImport(id: string): void {
    this.#db.prepare('DELETE FROM doc_endpoints WHERE import_id = ?').run(id);
    this.#db.prepare('DELETE FROM doc_imports WHERE id = ?').run(id);
  }

  deleteEndpoint(id: string): void {
    this.#db.prepare('DELETE FROM doc_endpoints WHERE id = ?').run(id);
  }
}
