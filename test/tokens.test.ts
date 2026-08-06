import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTokens,
  expiredTokens,
  shortestLived,
  describeExpiry,
  describeLifetime,
} from '../src/analyze/tokens.ts';

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS512' })}.${encode(claims)}.c2lnbmF0dXJl`;
}

// Lifetimes of the kind seen on real API gateways: a six-hour gateway token
// beside a thirty-minute session token and a five-minute transaction token.
const ISSUED = 1785908936;
const HEADERS: Array<[string, string]> = [
  ['authorization', `Bearer ${jwt({ iat: 1785908902, exp: 1785930502 })}`],
  ['x-token', `Bearer ${jwt({ iat: ISSUED, exp: ISSUED + 1800 })}`],
  ['t-token', `Bearer ${jwt({ iat: 1785908933, exp: 1785909233 })}`],
  ['x-api-key', 'EXAMPLE000NOTAREALKEY000TESTFIXTURE00000'],
  ['accept', 'application/json'],
];

test('finds JWTs regardless of which header carries them', () => {
  const tokens = findTokens(HEADERS);
  assert.deepEqual(
    tokens.map((token) => token.header).sort(),
    ['authorization', 't-token', 'x-token'],
  );
  // A plain API key is not a JWT and must not be reported as one.
  assert.ok(!tokens.some((token) => token.header === 'x-api-key'));
});

test('reports the real lifetime of each token', () => {
  const tokens = findTokens(HEADERS);
  const byHeader = new Map(tokens.map((token) => [token.header, token]));
  assert.equal(byHeader.get('authorization')?.lifetimeSeconds, 21600);
  assert.equal(byHeader.get('x-token')?.lifetimeSeconds, 1800);
  assert.equal(byHeader.get('t-token')?.lifetimeSeconds, 300);
});

test('the shortest-lived token is the command shelf life', () => {
  const shortest = shortestLived(findTokens(HEADERS));
  // t-token dies first, so the whole command is unusable after five minutes.
  assert.equal(shortest?.header, 't-token');
  assert.equal(shortest?.lifetimeSeconds, 300);
});

test('identifies which tokens are expired at a given moment', () => {
  const tokens = findTokens(HEADERS);

  // Ten minutes after capture: the transaction token is gone, the rest are fine.
  const tenMinutesLater = (ISSUED + 600) * 1000;
  assert.deepEqual(
    expiredTokens(tokens, tenMinutesLater).map((token) => token.header),
    ['t-token'],
  );

  // An hour later the session token has gone too, but the gateway one survives.
  const anHourLater = (ISSUED + 3600) * 1000;
  assert.deepEqual(
    expiredTokens(tokens, anHourLater).map((token) => token.header).sort(),
    ['t-token', 'x-token'],
  );

  assert.equal(expiredTokens(tokens, ISSUED * 1000).length, 0, 'nothing expired at capture');
});

test('describes expiry in terms a person can act on', () => {
  const tokens = findTokens(HEADERS);
  const xToken = tokens.find((token) => token.header === 'x-token')!;

  assert.equal(describeExpiry(xToken, (ISSUED + 600) * 1000), 'expires in 20 min');
  assert.equal(describeExpiry(xToken, (ISSUED + 3600) * 1000), 'expired 30 min ago');
  assert.equal(describeLifetime(xToken), 'lives 30 min');
});

test('ignores values that merely look like tokens', () => {
  assert.equal(findTokens([['x-thing', 'not.a.jwt']]).length, 0);
  assert.equal(findTokens([['x-thing', 'eyJhbGciOiJub25lIn0']]).length, 0);
  // A well-formed JWT with no exp claim says nothing about shelf life.
  assert.equal(findTokens([['authorization', jwt({ sub: 'abc' })]]).length, 0);
});
