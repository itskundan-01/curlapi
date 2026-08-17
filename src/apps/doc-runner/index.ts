/**
 * Doc → Requests: the handed-over API document, made runnable.
 *
 * The workflow this replaces is entirely manual — read the Word file the
 * department sent, retype each endpoint into Postman with its headers and body,
 * run them one at a time to find out which ones actually work, and do it again
 * when the document is revised. An afternoon, per document, repeatedly.
 *
 * Everything below is glue. The reading is in `parse.ts`, and running and
 * escaping are the capture side's `replay` and `buildCurl`, which were never
 * specific to captures.
 */

import type { IncomingMessage } from 'node:http';
import type { AppContext, AppInstance, AppModule, RouteRequest } from '../../platform/app.ts';
import { json, readJsonBody, text } from '../../platform/http.ts';
import { DEFAULT_CURL_OPTIONS, type CurlOptions, type HeaderPair } from '../../types.ts';
import { buildCurl } from '../../curl/build.ts';
import { replay } from '../../replay/run.ts';
import { DB_PATH } from '../../paths.ts';
import { parseDocument } from './parse.ts';
import { parseCurl } from './extract/curl.ts';
import { cleanHeading } from './extract/index.ts';
import {
  resolveEndpoint,
  toHeaderRows,
  toRequestRecord,
  unresolvedPlaceholders,
} from './resolve.ts';
import type { EndpointOverrides, HeaderRow } from './resolve.ts';
import { toPostmanCollection } from './export/postman.ts';
import { toMarkdown, toShellScript } from './export/text.ts';
import type { DocStore, StoredEndpoint } from './store.ts';
import type { Variable } from './types.ts';
import { manifest } from './manifest.ts';

/**
 * Cap on an uploaded document.
 *
 * Generous — one of the samples is 1.5MB because somebody pasted screenshots
 * into it — but bounded, because the whole file is held in memory to be parsed.
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Reads a raw upload, refusing anything past the cap without buffering it. */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      throw new Error(
        `That file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB. ` +
          'If it is mostly screenshots, exporting the text alone will import fine.',
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function curlOptionsFrom(params: URLSearchParams): CurlOptions {
  return {
    ...DEFAULT_CURL_OPTIONS,
    clean: params.get('clean') === '1',
    redact: params.get('redact') === '1',
    shell: params.get('shell') === 'powershell' ? 'powershell' : 'posix',
    singleLine: params.get('singleLine') === '1',
  };
}

/** A file name safe to put in a Content-Disposition header. */
function fileNameFor(title: string, extension: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'api-document';
  return `${slug}.${extension}`;
}

class DocRunnerApp implements AppInstance {
  #context: AppContext;
  #store: DocStore | null = null;
  /** Set while a document is being read, so the UI can say so. */
  #importing: string | null = null;

  constructor(context: AppContext) {
    this.#context = context;
  }

  /**
   * Opens the database on first use.
   *
   * Deferred rather than opened in the constructor because loading node:sqlite
   * during module linking defeats the experimental-warning filter the entry
   * point installs — the same reason the capture side imports its store
   * dynamically.
   */
  async #db(): Promise<DocStore> {
    if (!this.#store) {
      const { DocStore } = await import('./store.ts');
      this.#store = new DocStore(DB_PATH);
    }
    return this.#store;
  }

  status(): unknown {
    return { importing: this.#importing };
  }

  async dispose(): Promise<void> {
    this.#store?.close();
    this.#store = null;
  }

  async handle(request: RouteRequest): Promise<boolean> {
    const { path, method, url, req, res } = request;

    // --- importing -----------------------------------------------------------

    if (path === '/import' && method === 'POST') {
      // The file is sent as a raw body with its name in a header rather than as
      // multipart: one upload, no boundary parser, and nothing to get wrong
      // about a 32MB binary payload.
      const fileName = decodeURIComponent(
        (req.headers['x-file-name'] as string | undefined) ?? 'document',
      );
      this.#importing = fileName;
      this.#context.pushStatus();

      try {
        const bytes = await readRawBody(req);
        const parsed = parseDocument(bytes, fileName);
        const store = await this.#db();

        // A document that is nothing but endpoints has an endpoint for its
        // first heading, and naming the import after it reads as a mistake.
        const fromFile = fileName.replace(/\.[^.]+$/, '');
        const cleanedTitle = parsed.title ? cleanHeading(parsed.title) : '';
        const namesEndpoint = parsed.endpoints.some(
          (endpoint) => endpoint.name === cleanedTitle,
        );
        const headline = cleanedTitle && !namesEndpoint ? cleanedTitle : fromFile;

        const id = store.createImport({
          title: headline,
          fileName,
          format: parsed.format,
          endpoints: parsed.endpoints,
          variables: parsed.variables,
          warnings: parsed.warnings,
          stats: parsed.stats,
        });

        json(res, 200, {
          ok: true,
          id,
          endpointCount: parsed.endpoints.length,
          warnings: parsed.warnings,
          stats: parsed.stats,
        });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.#importing = null;
        this.#context.pushStatus();
      }
      return true;
    }

    // --- imports -------------------------------------------------------------

    if (path === '/imports' && method === 'GET') {
      json(res, 200, await (await this.#db()).listImports());
      return true;
    }

    const importMatch = /^\/imports\/([^/]+)(\/.*)?$/.exec(path);
    if (importMatch) {
      const store = await this.#db();
      const importId = decodeURIComponent(importMatch[1]);
      const rest = importMatch[2] ?? '';

      const summary = store.getImport(importId);
      if (!summary) {
        json(res, 404, { error: 'no such import' });
        return true;
      }

      if (rest === '' && method === 'GET') {
        const variables = store.getVariables(importId);
        const endpoints = store.listEndpoints(importId);
        json(res, 200, {
          summary,
          variables,
          endpoints: endpoints.map((endpoint) => this.#present(endpoint, variables)),
        });
        return true;
      }

      if (rest === '' && method === 'DELETE') {
        store.deleteImport(importId);
        json(res, 200, { ok: true });
        return true;
      }

      // Every command at once. Rendering the list needs all of them, and one
      // round trip per card would make the curl options toggles feel sluggish
      // on a document with forty endpoints.
      if (rest === '/curls' && method === 'GET') {
        const variables = store.getVariables(importId);
        const curlOptions = curlOptionsFrom(url.searchParams);
        json(
          res,
          200,
          store.listEndpoints(importId).map((endpoint) => ({
            id: endpoint.id,
            curl: buildCurl(
              toRequestRecord(endpoint, variables, endpoint.overrides),
              curlOptions,
            ),
          })),
        );
        return true;
      }

      if (rest === '/variables' && method === 'POST') {
        const body = await readJsonBody(req);
        const variables = Array.isArray(body['variables'])
          ? (body['variables'] as Variable[])
          : [];
        store.setVariables(importId, variables);
        json(res, 200, { ok: true, variables });
        return true;
      }

      const exportMatch = /^\/export\/(postman|script|markdown)$/.exec(rest);
      if (exportMatch) {
        const variables = store.getVariables(importId);

        // `?ids=` narrows the export to a selection. This is what makes "copy
        // the four I ticked into Postman" a single action rather than four.
        const wanted = url.searchParams.get('ids');
        const selection = wanted ? new Set(wanted.split(',').filter(Boolean)) : null;
        const endpoints = store
          .listEndpoints(importId)
          .filter((endpoint) => !selection || selection.has(endpoint.id));

        if (endpoints.length === 0) {
          json(res, 404, { error: 'none of those endpoints are in this import' });
          return true;
        }

        const curlOptions = curlOptionsFrom(url.searchParams);
        // Copying to the clipboard wants the text, not a download.
        const inline = url.searchParams.get('download') === '0';
        const attach = (fileName: string): void => {
          if (!inline) res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
        };
        // Credentials become collection variables unless the reader has said
        // they want the values inline — the safe default for a file that exists
        // to be sent to somebody.
        const useVariables = url.searchParams.get('inline') !== '1';

        switch (exportMatch[1]) {
          case 'postman':
            attach(fileNameFor(summary.title, 'postman_collection.json'));
            text(
              res,
              200,
              toPostmanCollection(endpoints, variables, summary.title, {
                useVariables,
                environment: url.searchParams.get('environment') ?? undefined,
              }),
              'application/json; charset=utf-8',
            );
            return true;
          case 'script':
            attach(fileNameFor(summary.title, 'sh'));
            text(
              res,
              200,
              toShellScript(endpoints, variables, summary.title, curlOptions),
              'text/x-shellscript; charset=utf-8',
            );
            return true;
          default:
            attach(fileNameFor(summary.title, 'md'));
            text(
              res,
              200,
              toMarkdown(endpoints, variables, summary.title, curlOptions),
              'text/markdown; charset=utf-8',
            );
            return true;
        }
      }
    }

    // --- endpoints -----------------------------------------------------------

    const endpointMatch = /^\/endpoints\/([^/]+)(?:\/(curl|run|from-curl))?$/.exec(path);
    if (endpointMatch) {
      const store = await this.#db();
      const id = decodeURIComponent(endpointMatch[1]);
      const action = endpointMatch[2];

      const endpoint = store.getEndpoint(id);
      if (!endpoint) {
        json(res, 404, { error: `no endpoint ${id}` });
        return true;
      }

      const importId = store.importIdOf(id);
      const variables = importId ? store.getVariables(importId) : [];

      if (action === 'curl') {
        text(
          res,
          200,
          buildCurl(
            toRequestRecord(endpoint, variables, endpoint.overrides),
            curlOptionsFrom(url.searchParams),
          ),
          'text/plain; charset=utf-8',
        );
        return true;
      }

      /**
       * Replaces the request with a curl command the reader pasted in.
       *
       * The same parser the importer uses, so a command copied out of Chrome,
       * Postman or a colleague's message lands here with its headers and body
       * intact — and the document's own reading stays underneath as an override
       * that can be reset.
       */
      if (action === 'from-curl' && method === 'POST') {
        const body = await readJsonBody(req);
        const command = typeof body['command'] === 'string' ? body['command'] : '';
        const parsed = parseCurl(command, []);
        if (!parsed) {
          json(res, 400, {
            error:
              'That does not look like a curl command — it needs at least a URL. ' +
              'Paste the whole command, including the `curl` at the front.',
          });
          return true;
        }
        store.setOverrides(id, {
          ...endpoint.overrides,
          method: parsed.method,
          url: parsed.url,
          headers: toHeaderRows(parsed.headers),
          body: parsed.body,
        });
        const updated = store.getEndpoint(id);
        json(res, 200, updated ? this.#present(updated, variables) : null);
        return true;
      }

      if (action === 'run' && method === 'POST') {
        const pending = unresolvedPlaceholders(endpoint, variables, endpoint.overrides);
        if (pending.length > 0) {
          // Refused rather than sent: a 404 from a URL still containing
          // `{bookingId}` reads as a broken endpoint, which it is not.
          json(res, 200, {
            blocked: true,
            placeholders: pending,
            error:
              `Fill in ${pending.map((name) => `{${name}}`).join(', ')} before running — ` +
              'the request would go out with the placeholder text in it.',
          });
          return true;
        }
        const record = toRequestRecord(endpoint, variables, endpoint.overrides);
        json(res, 200, { blocked: false, result: await replay(record) });
        return true;
      }

      if (!action && method === 'POST') {
        const body = await readJsonBody(req);

        if (typeof body['name'] === 'string' && body['name'].trim().length > 0) {
          store.rename(id, body['name'].trim());
        }

        // Only the keys the caller sent are changed, so editing the body does
        // not silently reset a header change made a moment earlier.
        const overrides: EndpointOverrides = { ...endpoint.overrides };
        if (typeof body['url'] === 'string') overrides.url = body['url'];
        if (typeof body['method'] === 'string') overrides.method = body['method'];
        if (typeof body['environment'] === 'string') overrides.environment = body['environment'];
        if (body['body'] === null || typeof body['body'] === 'string') {
          overrides.body = body['body'] as string | null;
        }
        if (Array.isArray(body['headers'])) {
          overrides.headers = body['headers'] as HeaderRow[];
        }
        // An explicit reset drops every edit and goes back to the document.
        if (body['reset'] === true) {
          store.setOverrides(id, {});
        } else {
          store.setOverrides(id, overrides);
        }

        const updated = store.getEndpoint(id);
        json(res, 200, updated ? this.#present(updated, variables) : null);
        return true;
      }

      if (!action && method === 'DELETE') {
        store.deleteEndpoint(id);
        json(res, 200, { ok: true });
        return true;
      }
    }

    return false;
  }

  /**
   * An endpoint as the UI needs it: what the document said, what the reader
   * changed, and what would actually be sent right now.
   *
   * The third is computed here rather than in the browser so that "the request
   * about to go out" is decided in exactly one place — the same code the run
   * endpoint uses.
   */
  #present(endpoint: StoredEndpoint, variables: Variable[]) {
    const resolved = resolveEndpoint(endpoint, variables, endpoint.overrides);
    return {
      ...endpoint,
      resolved,
      /**
       * What the editor binds to: the reader's rows if they have edited, the
       * document's headers as rows otherwise. Sent pre-shaped so the browser
       * never has to decide which of the two is in force.
       */
      draft: {
        method: endpoint.overrides.method ?? endpoint.method,
        url: endpoint.overrides.url ?? endpoint.url,
        headers: endpoint.overrides.headers ?? toHeaderRows(endpoint.headers),
        body: endpoint.overrides.body !== undefined ? endpoint.overrides.body : endpoint.body,
      },
      placeholders: unresolvedPlaceholders(endpoint, variables, endpoint.overrides),
      edited: Object.keys(endpoint.overrides).length > 0,
    };
  }
}

export const docRunnerApp: AppModule = {
  manifest,
  create: (context) => new DocRunnerApp(context),
};
