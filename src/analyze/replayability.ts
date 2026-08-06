import type { RequestRecord } from '../types.ts';

/**
 * Judges whether a captured request can be re-run at all.
 *
 * Some endpoints are single-use by construction: an OTP exchange consumes both
 * the one-time code and the transaction id that scoped it, and hands back a
 * freshly minted token. Replaying the identical bytes fails forever, however
 * fresh the credentials in the headers are. Saying that plainly saves the user
 * from concluding the capture is broken — and tells them their wrapper has to
 * perform the preceding step rather than replay this one.
 */

export type Replayability = {
  verdict: 'single-use' | 'likely-replayable' | 'unknown';
  /** Human-readable evidence, shown verbatim. */
  reasons: string[];
};

/** Field names that carry a one-time secret. */
const ONE_TIME_FIELDS = [
  'otp',
  'otpvalue',
  'otpcode',
  'oneTimePassword'.toLowerCase(),
  'verificationcode',
  'authcode',
  'code_verifier',
];

/** Field names that scope a request to a single server-side transaction. */
const TRANSACTION_FIELDS = [
  'txnid',
  'transactionid',
  'requestid',
  'nonce',
  'challenge',
  'state',
  'sessionid',
];

/** Keys whose presence in a response means credentials were just issued. */
const MINTED_TOKEN_KEYS = [
  'token',
  'tokens',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'idtoken',
  'id_token',
  'authtoken',
  'jwt',
];

function collectKeys(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectKeys(item, into, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    into.add(key.toLowerCase());
    collectKeys(child, into, depth + 1);
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

export function assessReplayability(record: RequestRecord): Replayability {
  const reasons: string[] = [];

  const requestKeys = new Set<string>();
  if (record.requestBody?.encoding === 'text') {
    collectKeys(parse(record.requestBody.data), requestKeys);
  }

  const responseKeys = new Set<string>();
  if (record.responseBody?.encoding === 'text') {
    collectKeys(parse(record.responseBody.data), responseKeys);
  }

  const oneTime = ONE_TIME_FIELDS.filter((field) => requestKeys.has(field));
  if (oneTime.length > 0) {
    reasons.push(`submits a one-time secret (${oneTime.join(', ')}) that the server consumes`);
  }

  const transaction = TRANSACTION_FIELDS.filter((field) => requestKeys.has(field));
  if (transaction.length > 0) {
    reasons.push(`scoped to a server-side transaction (${transaction.join(', ')})`);
  }

  const minted = MINTED_TOKEN_KEYS.filter((key) => responseKeys.has(key));
  if (minted.length > 0) {
    reasons.push(`its response issues credentials (${minted.join(', ')}), so it is an auth exchange`);
  }

  // A one-time secret is decisive on its own. Otherwise it takes both a
  // transaction scope and freshly minted credentials to be confident, since
  // plenty of ordinary endpoints carry a request id for tracing alone.
  const singleUse = oneTime.length > 0 || (transaction.length > 0 && minted.length > 0);
  if (singleUse) return { verdict: 'single-use', reasons };

  if (record.method.toUpperCase() === 'GET' && reasons.length === 0) {
    return {
      verdict: 'likely-replayable',
      reasons: ['a GET carrying no one-time values'],
    };
  }

  return { verdict: 'unknown', reasons };
}
