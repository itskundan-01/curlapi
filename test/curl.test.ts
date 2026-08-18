import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurl } from '../src/curl/build.ts';
import { escapePosix, escapePosixReadable } from '../src/curl/escape.ts';
import { DEFAULT_CURL_OPTIONS } from '../src/types.ts';
import { makeRecord, headers } from './helpers.ts';

/*
 * SYNTHETIC FIXTURES — none of the values below is a real credential.
 *
 * These assert how credentials are *rendered*, never what they contain, so the
 * fixtures are deliberately self-identifying: the JWT's claims and signature
 * say so in plain text, and the key and body are fixed filler. Earlier versions
 * were realistic enough to trip secret scanners, which is noise nobody needs on
 * a repository whose whole subject is captured credentials.
 *
 * The shapes are still faithful — an RS256 JWT with a `kid`, a 40-character
 * key, a long base64 body carrying `+`, `/` and `=` — because those are what
 * the escaping and header-ordering assertions actually exercise.
 */
const JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkVYQU1QTEUtS0VZLUlELU5PVC1SRUFMIn0.eyJfY29tbWVudCI6IlNZTlRIRVRJQyBURVNUIEZJWFRVUkUgLSBOT1QgQSBSRUFMIFRPS0VOIiwiZXhwIjoxNzg1ODY0MTkyLCJpYXQiOjE3ODU4NDI1OTIsImlzcyI6Imh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbS9yZWFsbXMvZXhhbXBsZSIsImF1ZCI6ImFjY291bnQiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJ0eXAiOiJCZWFyZXIiLCJhenAiOiJFWEFNUExFX0NMSUVOVCIsInNjb3BlIjoib3BlbmlkIGVtYWlsIHByb2ZpbGUiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJleGFtcGxlLXVzZXIifQ.NOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURENOT-A-REAL-SIGNATURE';

/** 40 characters, the shape of a gateway key. Not one. */
const API_KEY = 'EXAMPLE000NOTAREALKEY000TESTFIXTURE00000';

/** Stands in for an RSA-encrypted OTP: long base64 carrying `+`, `/` and `=`. */
const OTP_VALUE = `${'NOTAREALOTP+NOTAREALOTP/'.repeat(28)}==`;

const BODY = JSON.stringify({
  scope: ['account-login', 'mobile-verify'],
  authData: {
    authMethods: ['otp'],
    otp: { txnId: 'a75e2b8a-8ff4-489a-bb4e-332e2cf8c685', otpValue: OTP_VALUE },
  },
});

/**
 * The reference output is a real "Copy as cURL" from Chrome 150, with the
 * credential values swapped for the synthetic ones above; every byte of
 * structure, ordering and escaping is Chrome's own. Headers are fed in
 * deliberately shuffled to prove the renderer reproduces Chrome's ordering
 * rather than accidentally inheriting it from the input.
 */
const EXPECTED = `curl 'https://gateway.acme-api.net/AccountV3Api/prod/profile/enrollment/verify' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,hi;q=0.6' \\
  -H 'authorization: Bearer ${JWT}' \\
  -H 'content-type: application/json' \\
  -H 'origin: https://app.acme.co.uk' \\
  -H 'priority: u=1, i' \\
  -H 'referer: https://app.acme.co.uk/' \\
  -H 'request-id: adba0c54-5b95-4a2d-9287-344af6086a7a' \\
  -H 'sec-ch-ua: "Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "macOS"' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'sec-fetch-site: cross-site' \\
  -H 'timestamp: 2026-08-04T11:46:34.577Z' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36' \\
  -H 'x-api-key: ${API_KEY}' \\
  --data-raw '${BODY}'`;

function gatewayRecord() {
  return makeRecord({
    url: 'https://gateway.acme-api.net/AccountV3Api/prod/profile/enrollment/verify',
    method: 'POST',
    shortName: 'verify',
    resourceType: 'Fetch',
    requestHeaders: headers({
      // Shuffled on purpose, plus the transport headers CDP really does report.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'sec-fetch-mode': 'cors',
      accept: 'application/json, text/plain, */*',
      'x-api-key': API_KEY,
      'content-type': 'application/json',
      host: 'gateway.acme-api.net',
      'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
      authorization: `Bearer ${JWT}`,
      'accept-encoding': 'gzip, deflate, br, zstd',
      'sec-fetch-dest': 'empty',
      origin: 'https://app.acme.co.uk',
      'sec-ch-ua-mobile': '?0',
      'content-length': String(BODY.length),
      priority: 'u=1, i',
      'sec-fetch-site': 'cross-site',
      referer: 'https://app.acme.co.uk/',
      'sec-ch-ua-platform': '"macOS"',
      'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,hi;q=0.6',
      'request-id': 'adba0c54-5b95-4a2d-9287-344af6086a7a',
      timestamp: '2026-08-04T11:46:34.577Z',
    }),
    requestBody: { encoding: 'text', data: BODY, truncated: false },
  });
}

test('reproduces Chrome Copy-as-cURL byte for byte', () => {
  assert.equal(buildCurl(gatewayRecord(), DEFAULT_CURL_OPTIONS), EXPECTED);
});

test('omits only curl-managed transport headers', () => {
  const output = buildCurl(gatewayRecord(), DEFAULT_CURL_OPTIONS);
  for (const dropped of ['host:', 'accept-encoding:', 'content-length:']) {
    assert.ok(!output.includes(dropped), `${dropped} should not be emitted`);
  }
  // Load-bearing custom headers must survive untouched.
  for (const kept of ['x-api-key:', 'request-id:', 'timestamp:', 'priority:']) {
    assert.ok(output.includes(kept), `${kept} should be emitted`);
  }
});

test('emits real credentials by default so the command actually runs', () => {
  const output = buildCurl(gatewayRecord(), DEFAULT_CURL_OPTIONS);
  assert.ok(output.includes(JWT));
  assert.ok(output.includes(API_KEY));
  assert.ok(!output.includes('{{'));
});

test('redaction is opt-in and preserves the auth scheme', () => {
  const output = buildCurl(gatewayRecord(), { ...DEFAULT_CURL_OPTIONS, redact: true });
  assert.ok(output.includes('-H \'authorization: Bearer {{authorization}}\''));
  assert.ok(output.includes('-H \'x-api-key: {{x_api_key}}\''));
  assert.ok(!output.includes(JWT));
});

test('clean mode strips browser fingerprint headers but keeps custom ones', () => {
  const output = buildCurl(gatewayRecord(), { ...DEFAULT_CURL_OPTIONS, clean: true });
  assert.ok(!output.includes('sec-ch-ua'));
  assert.ok(!output.includes('sec-fetch-'));
  assert.ok(!output.includes('priority:'));
  assert.ok(output.includes('x-api-key:'));
  assert.ok(output.includes('authorization:'));
});

test('GET needs no explicit method, other verbs do', () => {
  const get = buildCurl(makeRecord({ method: 'GET' }), DEFAULT_CURL_OPTIONS);
  assert.ok(!get.includes('-X'));

  // Chrome quotes the method argument, so we do too.
  const del = buildCurl(makeRecord({ method: 'DELETE' }), DEFAULT_CURL_OPTIONS);
  assert.ok(del.includes("-X 'DELETE'"));

  // --data-raw already implies POST, so Chrome omits -X there.
  const post = buildCurl(
    makeRecord({
      method: 'POST',
      requestBody: { encoding: 'text', data: '{}', truncated: false },
    }),
    DEFAULT_CURL_OPTIONS,
  );
  assert.ok(!post.includes("-X 'POST'"));

  const put = buildCurl(
    makeRecord({
      method: 'PUT',
      requestBody: { encoding: 'text', data: '{}', truncated: false },
    }),
    DEFAULT_CURL_OPTIONS,
  );
  assert.ok(put.includes("-X 'PUT'"));
});

test('switches to ANSI-C quoting exactly where Chrome does', () => {
  assert.equal(escapePosix('plain'), "'plain'");
  assert.equal(escapePosix("it's"), "$'it\\'s'");
  assert.equal(escapePosix('bang!'), "$'bang\\u0021'");
  assert.equal(escapePosix('a\nb'), "$'a\\nb'");
  // Non-ASCII above the C1 range stays inside ordinary single quotes.
  assert.equal(escapePosix('héllo'), "'héllo'");
});

test('a readable body keeps its lines, and still runs', () => {
  // What the document app displays and copies. `$'{\n  "a": 1\n}'` is correct
  // and unreadable; a newline inside single quotes is just a newline.
  assert.equal(escapePosixReadable('{\n  "a": 1\n}'), "'{\n  \"a\": 1\n}'");
  // A quote cannot live inside single quotes, so the shell's own idiom is used.
  assert.equal(escapePosixReadable("it's"), "'it'\\''s'");
  // Anything a literal cannot carry falls back to Chrome's strict form, or the
  // character would vanish from the command entirely.
  assert.equal(escapePosixReadable('a\u0007b'), escapePosix('a\u0007b'));

  const record = makeRecord({
    method: 'POST',
    requestHeaders: headers({ 'content-type': 'application/json' }),
    requestBody: { encoding: 'text', data: '{\n  "a": 1\n}', truncated: false },
  });

  const readable = buildCurl(record, { ...DEFAULT_CURL_OPTIONS, readableBody: true });
  assert.match(readable, /--data-raw '\{\n {2}"a": 1\n\}'/);

  // The capture app is unaffected: its output is diffed against DevTools.
  const chrome = buildCurl(record, DEFAULT_CURL_OPTIONS);
  assert.match(chrome, /--data-raw \$'\{\\n {2}"a": 1\\n\}'/);
});

test('adds --compressed only when the server actually compressed', () => {
  // A server that compresses regardless of the request header would otherwise
  // dump gzip bytes into the terminal, because accept-encoding is not emitted.
  const compressed = buildCurl(
    makeRecord({ responseHeaders: [['content-encoding', 'gzip']] }),
    DEFAULT_CURL_OPTIONS,
  );
  assert.ok(compressed.endsWith('--compressed'));

  const plain = buildCurl(
    makeRecord({ responseHeaders: [['content-type', 'application/json']] }),
    DEFAULT_CURL_OPTIONS,
  );
  assert.ok(!plain.includes('--compressed'));

  const identity = buildCurl(
    makeRecord({ responseHeaders: [['content-encoding', 'identity']] }),
    DEFAULT_CURL_OPTIONS,
  );
  assert.ok(!identity.includes('--compressed'));
});

test('escapes curl glob characters in the URL', () => {
  const output = buildCurl(
    makeRecord({ url: 'https://example.com/api/items?filter[id]=7' }),
    DEFAULT_CURL_OPTIONS,
  );
  assert.ok(output.includes('filter\\[id\\]=7'));
});
