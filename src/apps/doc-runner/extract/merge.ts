/**
 * Reconciling what the extractors found.
 *
 * They are run all at once rather than in priority order, because one document
 * routinely uses two layouts — a spec table for most endpoints and a pasted curl
 * for the one somebody added later. Running them all and merging afterwards
 * means neither layout has to be detected up front.
 *
 * When two readings describe the same endpoint, the more confident one wins the
 * scalar fields and the other is used to fill its gaps: a curl paste often
 * carries an auth header the table omitted, and the table usually carries the
 * documented response the curl paste has no room for.
 */

import type { HeaderPair } from '../../../types.ts';
import type { Candidate } from './candidate.ts';

/**
 * The identity of an endpoint, for deciding what is a duplicate.
 *
 * Query *values* are dropped but their keys are kept: `?SamagraId=1` and
 * `?SamagraId=2` are the same endpoint with different sample data, while
 * `?id=1` and `?name=x` are not. Trailing slashes and case in the host are
 * noise either way.
 */
function identity(candidate: Candidate): string {
  const body = bodyKey(candidate.body);

  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return `${candidate.method} ${candidate.url.toLowerCase()} ${body}`;
  }

  const keys = [...url.searchParams.keys()].sort().join(',');
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  return `${candidate.method.toUpperCase()} ${url.host.toLowerCase()}${path}?${keys} ${body}`;
}

/**
 * The body's contribution to an endpoint's identity.
 *
 * Two commands to the same URL with *different* bodies are two test cases, not
 * one endpoint written twice — a document that posts `{"subHeadId":"127"}` and
 * `{"subHeadId":"213"}` to the same path means both, and collapsing them loses
 * one outright. An absent body matches anything, so a spec table with no example
 * still merges with the curl paste that has one.
 */
function bodyKey(body: string | null): string {
  if (!body) return '';
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  try {
    // Compared by value rather than by text, so whitespace and key order in an
    // otherwise identical payload do not split one endpoint into two.
    return JSON.stringify(sortDeep(JSON.parse(trimmed)));
  } catch {
    return trimmed.replace(/\s+/g, '');
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortDeep(child)]),
  );
}

/** Header names already present, lower-cased. */
function nameSet(headers: HeaderPair[]): Set<string> {
  return new Set(headers.map(([name]) => name.toLowerCase()));
}

/**
 * Adds headers from `extra` that `into` does not already name.
 *
 * By name rather than by pair: two readings of the same document giving
 * different values for `Content-Type` means one of them mis-parsed, and the
 * more confident reading is the one to keep. Emitting both would produce a
 * request with a duplicate header that the server resolves arbitrarily.
 */
function fillHeaders(into: HeaderPair[], extra: HeaderPair[]): HeaderPair[] {
  const present = nameSet(into);
  const merged = [...into];
  for (const [name, value] of extra) {
    if (present.has(name.toLowerCase())) continue;
    present.add(name.toLowerCase());
    merged.push([name, value]);
  }
  return merged;
}

function combine(winner: Candidate, loser: Candidate): Candidate {
  return {
    ...winner,
    // The winner's URL is kept, but a loser that carries query values the
    // winner lacks is the better example to run with.
    url: winner.url.includes('?') || !loser.url.includes('?') ? winner.url : loser.url,
    environments:
      winner.environments.length > 0 ? winner.environments : loser.environments,
    headers: fillHeaders(winner.headers, loser.headers),
    body: winner.body ?? loser.body,
    bodyMime: winner.bodyMime || loser.bodyMime,
    documentedResponse: winner.documentedResponse ?? loser.documentedResponse,
    blocks: [...new Set([...winner.blocks, ...loser.blocks])].sort((a, b) => a - b),
    // Two independent readings agreeing is genuine evidence, so the merged
    // reading is a little more trustworthy than either alone.
    confidence: Math.min(0.99, Math.max(winner.confidence, loser.confidence) + 0.03),
    warnings: [...new Set([...winner.warnings, ...loser.warnings])],
  };
}

/** The same key without the body, for the second pass below. */
function routeIdentity(candidate: Candidate): string {
  return identity({ ...candidate, body: null });
}

export function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const byIdentity = new Map<string, Candidate>();

  const absorb = (map: Map<string, Candidate>, key: string, candidate: Candidate): void => {
    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      return;
    }
    const [winner, loser] =
      candidate.confidence > existing.confidence
        ? [candidate, existing]
        : [existing, candidate];
    map.set(key, combine(winner, loser));
  };

  // Pass one: identical requests, body included, are one endpoint.
  for (const candidate of candidates) absorb(byIdentity, identity(candidate), candidate);

  // Pass two: a reading with no body folds into one for the same route that has
  // one — a spec table that omitted the payload and a curl paste that carries it
  // describe the same endpoint. Readings that both have bodies stay apart,
  // because two different payloads to one route are two test cases.
  const merged: Candidate[] = [];
  const byRoute = new Map<string, Candidate[]>();
  for (const candidate of byIdentity.values()) {
    const key = routeIdentity(candidate);
    const bucket = byRoute.get(key) ?? [];
    bucket.push(candidate);
    byRoute.set(key, bucket);
  }

  for (const bucket of byRoute.values()) {
    const withBody = bucket.filter((candidate) => Boolean(candidate.body?.trim()));
    const without = bucket.filter((candidate) => !candidate.body?.trim());

    if (withBody.length === 0 || without.length === 0) {
      merged.push(...bucket);
      continue;
    }

    // Each bodyless reading is folded into the most confident bodied one; the
    // rest stand as they are.
    const target = withBody.reduce((best, candidate) =>
      candidate.confidence > best.confidence ? candidate : best,
    );
    let combined = target;
    for (const orphan of without) combined = combine(combined, orphan);
    merged.push(combined, ...withBody.filter((candidate) => candidate !== target));
  }

  // Document order, which is the order the reader expects to find them in.
  return merged.sort((a, b) => (a.blocks[0] ?? 0) - (b.blocks[0] ?? 0));
}
