import type { HeaderPair, RequestRecord } from '../src/types.ts';

/** Builds a RequestRecord with sensible defaults so tests only state what matters. */
export function makeRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  const url = overrides.url ?? 'https://example.com/api/thing';
  const parsed = new URL(url);
  return {
    id: 'test:1',
    sessionId: 'test',
    seq: 1,
    url,
    method: 'GET',
    host: parsed.host,
    path: parsed.pathname,
    query: parsed.search,
    shortName: 'thing',
    resourceType: 'Fetch',
    requestHeaders: [],
    requestBody: null,
    status: 200,
    statusText: 'OK',
    responseHeaders: [],
    mimeType: 'application/json',
    responseBody: null,
    responseSize: 0,
    startedAt: 0,
    endedAt: 1,
    durationMs: 1,
    redirectChain: [],
    error: null,
    verdict: { keep: true, reason: 'test', score: 100 },
    approved: false,
    actionGroup: null,
    title: null,
    orderIndex: null,
    ...overrides,
  };
}

export function headers(pairs: Record<string, string>): HeaderPair[] {
  return Object.entries(pairs);
}
