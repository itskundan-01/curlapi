import type { RequestRecord } from '../types.ts';

/**
 * Traces values from one response into a later request.
 *
 * A single-use endpoint is only half the story: what the user actually needs is
 * the step *before* it. If `txnId` came back from `/requestOtp` and is then
 * posted to `/verify`, that edge is the shape of the flow their wrapper has to
 * reproduce — and it is recoverable, because the whole session was captured.
 */

export type ValueLink = {
  /** Truncated for display; ids and tokens can be enormous. */
  value: string;
  /** Key the value was found under in the producing response. */
  producedAs: string;
  where: 'body' | 'header' | 'query';
  /** Key it was consumed under in the dependent request. */
  consumedAs: string;
};

export type Dependency = {
  producerId: string;
  producerSeq: number;
  producerName: string;
  links: ValueLink[];
};

/** Values shorter than this are too collision-prone to be evidence of anything. */
const MIN_VALUE_LENGTH = 8;
const MAX_VALUE_LENGTH = 4096;
const MAX_DEPTH = 8;

function isInterestingValue(value: string): boolean {
  if (value.length < MIN_VALUE_LENGTH || value.length > MAX_VALUE_LENGTH) return false;
  // Identifier-shaped: ids, uuids, tokens, hashes. Prose and URLs are not.
  return /^[A-Za-z0-9_\-.:+/=]+$/.test(value) && /[0-9A-Za-z]/.test(value);
}

function walk(
  value: unknown,
  visit: (key: string, value: string) => void,
  key = '',
  depth = 0,
): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (isInterestingValue(value)) visit(key, value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walk(item, visit, key, depth + 1);
    return;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    walk(child, visit, childKey, depth + 1);
  }
}

function parse(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Every identifier-shaped value a response handed back, keyed by the value. */
function producedValues(record: RequestRecord): Map<string, string> {
  const out = new Map<string, string>();
  if (record.responseBody?.encoding !== 'text') return out;
  walk(parse(record.responseBody.data), (key, value) => {
    if (!out.has(value)) out.set(value, key || '(root)');
  });
  return out;
}

/** Every identifier-shaped value a request sent, with where it appeared. */
function consumedValues(record: RequestRecord): Array<[string, string, ValueLink['where']]> {
  const out: Array<[string, string, ValueLink['where']]> = [];

  if (record.requestBody?.encoding === 'text') {
    walk(parse(record.requestBody.data), (key, value) => {
      out.push([value, key || '(body)', 'body']);
    });
  }

  for (const [name, value] of record.requestHeaders) {
    // Strip an auth scheme so `Bearer <jwt>` matches the bare token.
    const bare = value.replace(/^(Bearer|Basic|Token)\s+/i, '');
    if (isInterestingValue(bare)) out.push([bare, name.toLowerCase(), 'header']);
  }

  try {
    new URL(record.url).searchParams.forEach((value, key) => {
      if (isInterestingValue(value)) out.push([value, key, 'query']);
    });
  } catch {
    /* unparseable URL */
  }

  return out;
}

/**
 * Finds which earlier requests produced the values this one sends.
 *
 * Only earlier requests count — a value cannot come from a response that had not
 * arrived yet, and the ordering is what makes the result a usable flow.
 */
export function findDependencies(
  target: RequestRecord,
  candidates: RequestRecord[],
  limit = 4,
): Dependency[] {
  const consumed = consumedValues(target);
  if (consumed.length === 0) return [];

  const byProducer = new Map<string, Dependency>();

  for (const candidate of candidates) {
    if (candidate.id === target.id || candidate.seq >= target.seq) continue;
    const produced = producedValues(candidate);
    if (produced.size === 0) continue;

    for (const [value, consumedAs, where] of consumed) {
      const producedAs = produced.get(value);
      if (producedAs === undefined) continue;

      const existing = byProducer.get(candidate.id) ?? {
        producerId: candidate.id,
        producerSeq: candidate.seq,
        producerName: candidate.title ?? candidate.shortName,
        links: [],
      };
      // One shared value per key pair is enough to make the point.
      if (!existing.links.some((link) => link.consumedAs === consumedAs)) {
        existing.links.push({
          value: value.length > 40 ? `${value.slice(0, 40)}…` : value,
          producedAs,
          where,
          consumedAs,
        });
      }
      byProducer.set(candidate.id, existing);
    }
  }

  // Nearest producer first: that is the step immediately before this one.
  return [...byProducer.values()]
    .sort((a, b) => b.producerSeq - a.producerSeq)
    .slice(0, limit);
}
