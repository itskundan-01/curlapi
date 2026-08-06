import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessReplayability } from '../src/analyze/replayability.ts';
import { findDependencies } from '../src/analyze/links.ts';
import { makeRecord } from './helpers.ts';

const TXN = '1868d3bc-4dfc-4506-8f30-3a289b66caf5';

/** A typical OTP exchange: submits a one-time code, gets credentials back. */
function verifyRecord() {
  return makeRecord({
    id: 'verify',
    seq: 20,
    url: 'https://gateway.acme-api.net/AccountV3Api/prod/profile/enrollment/verify',
    method: 'POST',
    shortName: 'verify',
    requestBody: {
      encoding: 'text',
      truncated: false,
      data: JSON.stringify({
        scope: ['account-address-enroll', 'mobile-verify'],
        authData: {
          authMethods: ['otp'],
          otp: { txnId: TXN, otpValue: 'ENCRYPTED_OTP_PAYLOAD_VALUE' },
        },
      }),
    },
    responseBody: {
      encoding: 'text',
      truncated: false,
      data: JSON.stringify({
        txnId: TXN,
        message: 'OTP Verified Successfully',
        authResult: 'success',
        tokens: { token: 'eyJhbGciOiJSUzUxMiJ9.payload.sig', expiresIn: 300 },
      }),
    },
  });
}

test('recognises a one-time OTP exchange as unreplayable', () => {
  const verdict = assessReplayability(verifyRecord());
  assert.equal(verdict.verdict, 'single-use');
  // All three signals should be spotted, because each is separately useful.
  assert.ok(verdict.reasons.some((r) => r.includes('one-time secret')));
  assert.ok(verdict.reasons.some((r) => r.includes('transaction')));
  assert.ok(verdict.reasons.some((r) => r.includes('issues credentials')));
});

test('a plain GET is not flagged as single-use', () => {
  const verdict = assessReplayability(
    makeRecord({
      method: 'GET',
      url: 'https://cache.acme.co.uk/landingstats',
      responseBody: {
        encoding: 'text',
        truncated: false,
        data: JSON.stringify({ services: 1234, states: 36 }),
      },
    }),
  );
  assert.equal(verdict.verdict, 'likely-replayable');
});

test('a request id alone does not make something single-use', () => {
  // Plenty of ordinary endpoints carry a request id purely for tracing.
  const verdict = assessReplayability(
    makeRecord({
      method: 'POST',
      requestBody: {
        encoding: 'text',
        truncated: false,
        data: JSON.stringify({ requestId: 'abc-123', query: 'hello' }),
      },
      responseBody: {
        encoding: 'text',
        truncated: false,
        data: JSON.stringify({ results: [] }),
      },
    }),
  );
  assert.notEqual(verdict.verdict, 'single-use');
});

test('traces the txnId back to the request that issued it', () => {
  // This is the step the wrapper actually has to reproduce.
  const requestOtp = makeRecord({
    id: 'request-otp',
    seq: 12,
    url: 'https://gateway.acme-api.net/AccountV3Api/prod/profile/enrollment/request/otp',
    method: 'POST',
    shortName: 'otp',
    responseBody: {
      encoding: 'text',
      truncated: false,
      data: JSON.stringify({ txnId: TXN, message: 'OTP sent' }),
    },
  });

  const unrelated = makeRecord({
    id: 'unrelated',
    seq: 5,
    url: 'https://cache.acme.co.uk/landingstats',
    responseBody: {
      encoding: 'text',
      truncated: false,
      data: JSON.stringify({ count: 42 }),
    },
  });

  const deps = findDependencies(verifyRecord(), [requestOtp, unrelated]);
  assert.equal(deps.length, 1, 'only the request that produced the txnId');
  assert.equal(deps[0].producerSeq, 12);
  assert.equal(deps[0].producerName, 'otp');
  assert.equal(deps[0].links[0].value, TXN);
  assert.equal(deps[0].links[0].producedAs, 'txnId');
  assert.equal(deps[0].links[0].consumedAs, 'txnId');
  assert.equal(deps[0].links[0].where, 'body');
});

test('a value can only come from a response that already arrived', () => {
  const later = makeRecord({
    id: 'later',
    seq: 99,
    responseBody: {
      encoding: 'text',
      truncated: false,
      data: JSON.stringify({ txnId: TXN }),
    },
  });
  assert.deepEqual(findDependencies(verifyRecord(), [later]), []);
});

test('traces a bearer token back to the exchange that minted it', () => {
  const login = makeRecord({
    id: 'login',
    seq: 3,
    shortName: 'login',
    responseBody: {
      encoding: 'text',
      truncated: false,
      data: JSON.stringify({ tokens: { token: 'eyJhbGciOiJIUzI1NiJ9.abcdefgh.signature' } }),
    },
  });

  const authed = makeRecord({
    id: 'profile',
    seq: 8,
    requestHeaders: [['authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh.signature']],
  });

  const deps = findDependencies(authed, [login]);
  assert.equal(deps.length, 1);
  // The auth scheme is stripped so the bare token matches.
  assert.equal(deps[0].links[0].consumedAs, 'authorization');
  assert.equal(deps[0].links[0].where, 'header');
});
