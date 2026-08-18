/**
 * Both apps' Postman exports, checked against the published collection schema.
 *
 * The failure this suite is written against is not a crash — it is a file that
 * exports cleanly, looks right in a text editor, and then imports into Postman
 * with the port missing from every URL or the request body silently dropped.
 * None of that is visible from this side, so the schema vendored in
 * test/fixtures is the referee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { toPostmanCollection as captureCollection } from '../src/export/postman.ts';
import { toPostmanCollection as docCollection } from '../src/apps/doc-runner/export/postman.ts';
import { postmanBody, postmanUrl } from '../src/postman/collection.ts';
import { extractEndpoints } from '../src/apps/doc-runner/extract/index.ts';
import { readText } from '../src/apps/doc-runner/ingest/text.ts';
import { DEFAULT_CURL_OPTIONS, type RequestRecord, type SessionRecord } from '../src/types.ts';
import { makeRecord, headers } from './helpers.ts';
import { loadSchema, validate, describeErrors } from './jsonschema.ts';

const SCHEMA = loadSchema(
  fileURLToPath(new URL('./fixtures/postman-collection-v2.1.0.schema.json', import.meta.url)),
);

const SESSION: SessionRecord = {
  id: 'session-1',
  label: 'Checkout flow',
  startedAt: 1_700_000_000_000,
  endedAt: null,
  primaryHost: 'shop.example.test',
};

function assertValid(json: string): Record<string, any> {
  const parsed = JSON.parse(json) as Record<string, any>;
  const errors = validate(parsed, SCHEMA);
  assert.equal(
    errors.length,
    0,
    `collection does not match the Postman v2.1 schema:\n${describeErrors(errors)}`,
  );
  return parsed;
}

/** One record per shape the exporter has to handle. */
function mixedCapture(): RequestRecord[] {
  return [
    makeRecord({
      id: 'r1',
      seq: 1,
      method: 'GET',
      url: 'https://api.example.test:8443/v1/orders?page=2&q=a%20b',
      requestHeaders: headers({ accept: 'application/json', ':authority': 'api.example.test' }),
      responseBody: { encoding: 'text', data: '{"ok":true}', truncated: false },
      responseHeaders: headers({ 'content-type': 'application/json' }),
    }),
    makeRecord({
      id: 'r2',
      seq: 2,
      method: 'POST',
      url: 'https://api.example.test/v1/orders',
      requestHeaders: headers({
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
      }),
      requestBody: { encoding: 'text', data: '{"item":"a"}', truncated: false },
      status: 201,
      statusText: 'Created',
      actionGroup: 'Checkout',
    }),
    makeRecord({
      id: 'r3',
      seq: 3,
      method: 'PUT',
      url: 'https://api.example.test/v1/orders/9',
      requestHeaders: headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      requestBody: { encoding: 'text', data: 'qty=2&note=two+items', truncated: false },
    }),
    makeRecord({
      id: 'r4',
      seq: 4,
      method: 'DELETE',
      url: 'https://api.example.test/v1/orders/9',
      requestHeaders: headers({ 'content-type': 'application/json' }),
      requestBody: { encoding: 'text', data: '{"reason":"changed mind"}', truncated: false },
    }),
    makeRecord({
      id: 'r5',
      seq: 5,
      method: 'PATCH',
      url: 'https://api.example.test/v1/orders/9',
      requestHeaders: headers({ 'content-type': 'application/merge-patch+json' }),
      requestBody: { encoding: 'text', data: '{"note":"x"}', truncated: false },
    }),
    makeRecord({
      id: 'r6',
      seq: 6,
      method: 'HEAD',
      url: 'http://127.0.0.1:7317/health',
    }),
    makeRecord({
      id: 'r7',
      seq: 7,
      method: 'POST',
      url: 'https://api.example.test/v1/upload',
      requestHeaders: headers({ 'content-type': 'application/octet-stream' }),
      requestBody: { encoding: 'base64', data: 'AAECAw==', truncated: false },
    }),
  ];
}

// --- the capture app --------------------------------------------------------

test('a capture of every common method exports a valid collection', () => {
  const collection = assertValid(
    captureCollection(mixedCapture(), SESSION, DEFAULT_CURL_OPTIONS),
  );

  // Every method survives the round trip, in capture order. A collection that
  // turns a DELETE into a GET is worse than no collection.
  const items = collection['item'] as Array<Record<string, any>>;
  const flat = items.flatMap((entry) => (entry['item'] ? entry['item'] : [entry]));
  const methods = flat.map((item: Record<string, any>) => item['request']['method']);
  assert.deepEqual(methods.sort(), ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'POST', 'PUT']);
});

test('a non-default port survives, because a collection without it points nowhere', () => {
  const [record] = mixedCapture();
  const collection = JSON.parse(captureCollection([record], SESSION, DEFAULT_CURL_OPTIONS));
  const url = collection['item'][0]['request']['url'];
  assert.equal(url['port'], '8443');
  assert.deepEqual(url['host'], ['api', 'example', 'test']);
  assert.deepEqual(url['path'], ['v1', 'orders']);
  // Query values stay exactly as they were on the wire: `%20` decoded here would
  // be re-encoded on send as `%2520`.
  assert.deepEqual(url['query'], [
    { key: 'page', value: '2' },
    { key: 'q', value: 'a%20b' },
  ]);
});

test('form bodies land in the editors that own them', () => {
  const records = mixedCapture();
  const collection = JSON.parse(captureCollection(records, SESSION, DEFAULT_CURL_OPTIONS));
  const items = collection['item'] as Array<Record<string, any>>;
  const byMethod = (method: string) =>
    items.flatMap((entry) => (entry['item'] ? entry['item'] : [entry])).find(
      (item: Record<string, any>) => item['request']['method'] === method,
    );

  const put = byMethod('PUT')!['request']['body'];
  assert.equal(put['mode'], 'urlencoded');
  // `+` is a space in a form body, and the editor holds decoded text.
  assert.deepEqual(put['urlencoded'], [
    { key: 'qty', value: '2' },
    { key: 'note', value: 'two items' },
  ]);

  const post = byMethod('POST')!['request']['body'];
  assert.equal(post['mode'], 'raw');
  assert.equal(post['options']['raw']['language'], 'json');
});

test('a DELETE with a body keeps it, which Postman otherwise prunes', () => {
  const records = mixedCapture();
  const collection = JSON.parse(captureCollection(records, SESSION, DEFAULT_CURL_OPTIONS));
  const items = (collection['item'] as Array<Record<string, any>>).flatMap((entry) =>
    entry['item'] ? entry['item'] : [entry],
  );
  const del = items.find((item: Record<string, any>) => item['request']['method'] === 'DELETE')!;
  assert.equal(del['protocolProfileBehavior']['disableBodyPruning'], true);

  const post = items.find((item: Record<string, any>) => item['request']['method'] === 'POST')!;
  assert.equal(post['protocolProfileBehavior'], undefined, 'a POST body is never pruned');
});

test('a binary body is declared missing rather than exported empty', () => {
  const records = mixedCapture();
  const collection = JSON.parse(captureCollection(records, SESSION, DEFAULT_CURL_OPTIONS));
  const items = (collection['item'] as Array<Record<string, any>>).flatMap((entry) =>
    entry['item'] ? entry['item'] : [entry],
  );
  const upload = items.find((item: Record<string, any>) =>
    item['request']['url']['raw'].endsWith('/upload'),
  )!;
  assert.equal(upload['request']['body'], undefined);
  assert.match(upload['request']['description'], /binary and is not included/);
});

test('HTTP/2 pseudo-headers are dropped, since Postman cannot send them', () => {
  const [record] = mixedCapture();
  const collection = JSON.parse(captureCollection([record], SESSION, DEFAULT_CURL_OPTIONS));
  const keys = (collection['item'][0]['request']['header'] as Array<{ key: string }>).map(
    (header) => header.key,
  );
  assert.deepEqual(keys, ['accept']);
});

test('redacted exports carry credentials as variables of a type the schema allows', () => {
  const json = captureCollection(mixedCapture(), SESSION, { ...DEFAULT_CURL_OPTIONS, redact: true });
  const collection = assertValid(json);
  const variables = collection['variable'] as Array<{ key: string; type: string }>;
  assert.ok(variables.length > 0);
  // `secret` is a Postman product concept; the file format's enum is
  // string/boolean/number/any, and anything else fails validation on import.
  for (const variable of variables) assert.equal(variable.type, 'string');
});

// --- the document app -------------------------------------------------------

const DOCUMENT = `
# Bookings API

## Create booking

curl --location 'https://api.example.test:9443/v1/bookings' \\
--header 'Content-Type: application/json' \\
--header 'Api-Key: DDDD8888' \\
--data-raw '{"brandNo": "1", "qty": 2}'

Response:
{"status": "success"}

## Cancel booking

| HTTP Method | DELETE |
| --- | --- |
| URL | https://api.example.test/v1/bookings/{bookingId} |
| Request Body | {"reason": "duplicate"} |

## Update booking

| HTTP Method | PUT |
| --- | --- |
| URL | https://api.example.test/v1/bookings/{bookingId} |
| Request Body | {"qty": 3} |

## Check booking

| HTTP Method | HEAD |
| --- | --- |
| URL | https://api.example.test/v1/bookings/{bookingId} |
`;

test('a document with mixed methods exports a valid collection', () => {
  const { endpoints, variables } = extractEndpoints(readText(DOCUMENT));
  const collection = assertValid(
    docCollection(endpoints, variables, 'Bookings API', { useVariables: true }),
  );

  const flatten = (nodes: Array<Record<string, any>>): Array<Record<string, any>> =>
    nodes.flatMap((node) => (node['item'] ? flatten(node['item']) : [node]));
  const items = flatten(collection['item'] as Array<Record<string, any>>);

  const methods = items.map((item) => item['request']['method']).sort();
  assert.deepEqual(methods, ['DELETE', 'HEAD', 'POST', 'PUT']);

  // The port in a documented URL is as load-bearing as one in a capture.
  const post = items.find((item) => item['request']['method'] === 'POST')!;
  assert.equal(post['request']['url']['port'], '9443');

  // A DELETE the document gives a body for keeps it.
  const del = items.find((item) => item['request']['method'] === 'DELETE')!;
  assert.equal(del['protocolProfileBehavior']['disableBodyPruning'], true);
  assert.equal(del['request']['url']['variable'][0]['key'], 'bookingId');
});

test('an export with no endpoints is still an importable collection', () => {
  const collection = assertValid(docCollection([], [], 'Empty', { useVariables: true }));
  assert.deepEqual(collection['item'], []);
});

// --- the format layer -------------------------------------------------------

test('a URL built from Postman variables is kept whole', () => {
  // `new URL()` throws on this, and inventing parts for it would leave the raw
  // string and the parts disagreeing — which is what Postman shows the user.
  const url = postmanUrl('{{baseUrl}}/v1/orders/:id');
  assert.deepEqual(url, { raw: '{{baseUrl}}/v1/orders/:id' });
});

test('an IPv6 host is not mistaken for a port', () => {
  const url = postmanUrl('http://[::1]:7317/health');
  assert.deepEqual(url.host, ['[::1]']);
  assert.equal(url.port, '7317');
});

test('placeholders in a path are not percent-encoded away', () => {
  const url = postmanUrl('https://api.example.test/v1/order/{bookingId}');
  assert.deepEqual(url.path, ['v1', 'order', '{bookingId}']);
});

test('a multipart body with a file part stays raw, so it still sends', () => {
  const boundary = '----curlapiTest';
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="a.pdf"\r\n\r\n%PDF\r\n` +
    `--${boundary}--\r\n`;
  const body = postmanBody({ raw, contentType: `multipart/form-data; boundary=${boundary}` });
  // The file's bytes are in the capture, not on the importer's disk, so a
  // formdata rendering would send the PDF's contents as a text field.
  assert.equal(body?.mode, 'raw');
});

test('a multipart body the browser cut short stays raw', () => {
  // No terminating `--boundary--`: splitting this would drop the part that was
  // in flight and produce an export that looks complete and sends one field
  // fewer than the capture did.
  const boundary = '----curlapiTest';
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="qty"\r\n\r\n2`;
  const body = postmanBody({ raw, contentType: `multipart/form-data; boundary=${boundary}` });
  assert.equal(body?.mode, 'raw');
});

test('a text-only multipart body becomes fields somebody can edit', () => {
  const boundary = '----curlapiTest';
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="qty"\r\n\r\n2\r\n` +
    `--${boundary}--\r\n`;
  const body = postmanBody({ raw, contentType: `multipart/form-data; boundary="${boundary}"` });
  assert.equal(body?.mode, 'formdata');
  assert.deepEqual(body?.mode === 'formdata' ? body.formdata : null, [
    { key: 'note', value: 'hello', type: 'text' },
    { key: 'qty', value: '2', type: 'text' },
  ]);
});

// --- the referee itself -----------------------------------------------------

test('the validator rejects the mistakes it is here to catch', () => {
  // Without this, a validator that silently passed everything would make every
  // assertion above meaningless.
  const wrongVariableType = {
    info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [],
    variable: [{ key: 'api_key', value: '', type: 'secret' }],
  };
  assert.equal(validate(wrongVariableType, SCHEMA).length, 1);

  const missingName = { info: { schema: 'x' }, item: [] };
  assert.equal(validate(missingName, SCHEMA).length, 1);

  const itemWithoutRequest = { info: { name: 'x', schema: 'y' }, item: [{ name: 'no request' }] };
  assert.ok(validate(itemWithoutRequest, SCHEMA).length > 0);
});
