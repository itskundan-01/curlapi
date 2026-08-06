import type { HeaderPair, ReplayResult, RequestRecord } from '../types.ts';
import { shapesMatch } from '../analyze/schema.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;

/**
 * Headers undici sets for itself. Passing them through either throws or produces
 * a request that disagrees with its own body length.
 */
const MANAGED = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'expect',
  'accept-encoding',
]);

function replayHeaders(headers: HeaderPair[]): Headers {
  const out = new Headers();
  for (const [rawName, value] of headers) {
    const name = rawName.replace(/^:/, '');
    if (MANAGED.has(name.toLowerCase())) continue;
    try {
      out.append(name, value);
    } catch {
      // A header name Node refuses is not worth failing the whole replay over.
    }
  }
  return out;
}

function isTextual(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('urlencoded')
  );
}

/**
 * Reads at most `limit` bytes and then stops the transfer.
 *
 * Buffering the whole body first would make a multi-megabyte response cost real
 * memory to produce a preview that gets truncated anyway. Cancelling the reader
 * also tells the server to stop sending, so the bytes are never transferred.
 */
async function readCapped(
  response: Response,
  limit: number,
): Promise<{ buffer: Buffer; truncated: boolean; total: number }> {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), truncated: false, total: 0 };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > limit) {
      chunks.push(chunk.subarray(0, chunk.byteLength - (total - limit)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(chunk);
  }

  return { buffer: Buffer.concat(chunks), truncated, total };
}

/**
 * Re-runs a captured request from the server side and reports what happened.
 *
 * Execution is in-process over undici's connection pool rather than by spawning
 * the curl binary: no process to fork per run, and sockets are reused across
 * repeated runs of the same endpoint. Redirects are deliberately not followed —
 * the generated curl has no `-L`, so following them here would show the user a
 * result their command cannot reproduce. Nothing is retried either; a 401 from
 * an expired token is a fact worth surfacing, not a problem to paper over.
 */
export async function replay(record: RequestRecord): Promise<ReplayResult> {
  const startedAt = performance.now();

  const init: RequestInit = {
    method: record.method,
    headers: replayHeaders(record.requestHeaders),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };

  if (record.requestBody && record.method.toUpperCase() !== 'GET') {
    init.body =
      record.requestBody.encoding === 'base64'
        ? Buffer.from(record.requestBody.data, 'base64')
        : record.requestBody.data;
  }

  try {
    const response = await fetch(record.url, init);
    const headers: HeaderPair[] = [];
    response.headers.forEach((value, name) => headers.push([name, value]));

    const contentType = response.headers.get('content-type') ?? '';
    const { buffer, truncated, total } = await readCapped(response, MAX_BODY_BYTES);
    const textual = isTextual(contentType);
    const body = textual ? buffer.toString('utf8') : buffer.toString('base64');

    const capturedBody =
      record.responseBody && record.responseBody.encoding === 'text'
        ? record.responseBody.data
        : null;

    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      bodyEncoding: textual ? 'text' : 'base64',
      truncated,
      durationMs: Math.round(performance.now() - startedAt),
      sizeBytes: total,
      shapeMatchesCapture: textual && !truncated ? shapesMatch(capturedBody, body) : null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      statusText: '',
      headers: [],
      body: '',
      bodyEncoding: 'text',
      truncated: false,
      durationMs: Math.round(performance.now() - startedAt),
      sizeBytes: 0,
      shapeMatchesCapture: null,
      error: message,
    };
  }
}
