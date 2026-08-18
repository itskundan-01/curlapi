import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readText } from '../src/apps/doc-runner/ingest/text.ts';
import { cleanHeading, extractEndpoints } from '../src/apps/doc-runner/extract/index.ts';
import { parseCurl } from '../src/apps/doc-runner/extract/curl.ts';
import { normalizeText, splitPair } from '../src/apps/doc-runner/normalize.ts';
import {
  fromHeaderRows,
  resolveEndpoint,
  substitute,
  toHeaderRows,
  toRequestRecord,
} from '../src/apps/doc-runner/resolve.ts';
import { toPostmanCollection } from '../src/apps/doc-runner/export/postman.ts';
import { buildCurl } from '../src/curl/build.ts';
import { DEFAULT_CURL_OPTIONS } from '../src/types.ts';
import type { ParsedEndpoint } from '../src/apps/doc-runner/types.ts';

/**
 * Fixtures reproduce the shapes of real handed-over documents — the spec table,
 * the labelled prose, the environment column, the pasted-and-mangled curl — with
 * invented hosts and keys. The originals carry live credentials and stay out of
 * the repository; what matters for a test is the layout, not the values.
 */

function parse(markdown: string) {
  return extractEndpoints(readText(markdown));
}

// --- normalisation ---------------------------------------------------------

test('word-processor punctuation is undone', () => {
  // Autocorrect leaves an opening curly quote and a straight closing one, and
  // turns `--` into an en dash. All three break a pasted command.
  assert.equal(normalizeText('curl ‘http://x’'), "curl 'http://x'");
  assert.equal(normalizeText('––data'), '--data');
  assert.equal(normalizeText('a b'), 'a b');
  // A curly quote closing a JSON key is the one that produces a baffling error.
  assert.equal(normalizeText('{"brandNo”: "1"}'), '{"brandNo": "1"}');
});

test('a label splits from its value at the first separator', () => {
  assert.deepEqual(splitPair('Method :- GET'), ['Method', 'GET']);
  // The value keeps its own separators.
  assert.deepEqual(splitPair('URL - https://x.test/a-b'), ['URL', 'https://x.test/a-b']);
  assert.equal(splitPair('a sentence with no separator at all'), null);
});

// --- spec tables -----------------------------------------------------------

const SPEC_TABLE = `
# 1. Check Availability API

| HTTP Method | GET |
| --- | --- |
| URL | https://api.example.test/open/checkAvailability?spotId=1 |
| Request Header | Accept: */* |
| Request Body | No Request Body Required |
| Response | { "status": true, "rooms": 6 } |

## HTTP Response Code

| Response Code | Description |
| --- | --- |
| 200 | Successful Response |
| 400 | Bad Request / Validation Error |
`;

test('a key-value spec table becomes an endpoint', () => {
  const { endpoints } = parse(SPEC_TABLE);
  assert.equal(endpoints.length, 1);

  const [endpoint] = endpoints;
  assert.equal(endpoint.method, 'GET');
  assert.equal(endpoint.url, 'https://api.example.test/open/checkAvailability?spotId=1');
  assert.deepEqual(endpoint.headers, [['Accept', '*/*']]);
  // "No Request Body Required" is an absence, not a body.
  assert.equal(endpoint.body, null);
  assert.match(endpoint.documentedResponse ?? '', /"rooms": 6/);
  // The numbering in the heading is not part of the name.
  assert.equal(endpoint.name, 'Check Availability API');
});

test('the response-code table is attached, not mistaken for an endpoint', () => {
  const { endpoints } = parse(SPEC_TABLE);
  assert.equal(endpoints.length, 1, 'the code table must not become a second endpoint');
  assert.deepEqual(
    endpoints[0].responseCodes.map((code) => code.code),
    ['200', '400'],
  );
});

const ENVIRONMENT_TABLE = `
## Submit API

| HTTP Method | POST |
| --- | --- | --- |
| URL | Staging | https://staging.example.test/v1 |
|  | Production | https://api.example.test/v1 |
| Request Header | Content-Type: application/json |
| Request Body (application/json) | {"id": "1"} |
`;

test('a URL row split by environment keeps both, and picks one to run', () => {
  const [endpoint] = parse(ENVIRONMENT_TABLE).endpoints;
  assert.deepEqual(
    endpoint.environments.map((environment) => environment.name),
    ['Staging', 'Production'],
  );
  // The first environment is what a run goes to by default — never the word
  // "Staging", which a fixed column index would have picked up as the URL.
  assert.equal(endpoint.url, 'https://staging.example.test/v1');
  assert.equal(endpoint.method, 'POST');
});

test('switching environment swaps the origin and keeps the path', () => {
  const [endpoint] = parse(ENVIRONMENT_TABLE).endpoints;
  const resolved = resolveEndpoint(endpoint, [], { environment: 'Production' });
  assert.equal(resolved.url, 'https://api.example.test/v1');
});

test('a body with no stated content type gets one from its shape', () => {
  const [endpoint] = parse(`
| HTTP Method | POST |
| --- | --- |
| URL | https://api.example.test/v1/save |
| Request Body | {"a": 1} |
`).endpoints;

  assert.deepEqual(endpoint.headers, [['Content-Type', 'application/json']]);
  assert.ok(endpoint.warnings.some((warning) => /Content-Type/.test(warning)));
});

// --- labelled prose --------------------------------------------------------

const LABELLED = `
List Application of Students

Method :- GET

https://api.example.test/PMSApi/Get_Applications?SamagraId=1

Headers :-  Pass below keys in header

X-Api-Key - AAAA1111-2222-3333

Activation_Key - BBBB4444-5555-6666
`;

test('labelled prose with a bare URL line becomes an endpoint', () => {
  const { endpoints } = parse(LABELLED);
  assert.equal(endpoints.length, 1);

  const [endpoint] = endpoints;
  assert.equal(endpoint.method, 'GET');
  assert.equal(endpoint.url, 'https://api.example.test/PMSApi/Get_Applications?SamagraId=1');
  // The "pass below keys" sentence is prose; the two pairs under it are headers.
  assert.deepEqual(endpoint.headers, [
    ['X-Api-Key', 'AAAA1111-2222-3333'],
    ['Activation_Key', 'BBBB4444-5555-6666'],
  ]);
});

test('the key/value pair form is read as one header', () => {
  const [endpoint] = parse(`
Application Detail

Method : POST

Authorization Headers :

key - X-Api-Key

Value - CCCC7777

URL :- https://api.example.test/v1/status?n=1
`).endpoints;

  assert.deepEqual(endpoint.headers, [['X-Api-Key', 'CCCC7777']]);
  assert.equal(endpoint.method, 'POST');
});

test('staging sign-in details are not turned into an endpoint', () => {
  // Both MP-SEDC documents end like this. The login page is a note for a human.
  const { endpoints } = parse(`${LABELLED}

Staging URL

URL - https://portal.example.test/Account/Login

Login Id - someone

Pwd - hunter2
`);

  assert.equal(endpoints.length, 1);
  assert.ok(!endpoints[0].url.includes('Account/Login'));
});

// --- pasted curl -----------------------------------------------------------

const MANGLED_CURL = `
Challan Details

curl --location ‘http://api.example.test/service/api/Challandetails'

header 'Api-Key: DDDD8888'

header 'Content-Type: application/json'

Request Parameter:

data '{

"challanNo": "29308"

}'

Response Parameter:

{

"count": 1,

"status": "success"

}
`;

test('a curl command survives losing its dashes and its quotes', () => {
  const { endpoints } = parse(MANGLED_CURL);
  assert.equal(endpoints.length, 1);

  const [endpoint] = endpoints;
  assert.equal(endpoint.url, 'http://api.example.test/service/api/Challandetails');
  // `header` with no `--` still has to register, or the auth header is lost.
  assert.deepEqual(endpoint.headers, [
    ['Api-Key', 'DDDD8888'],
    ['Content-Type', 'application/json'],
  ]);
  // `Request Parameter:` sits between the flags and the body. Treating it as the
  // end of the command loses the body, and a documented POST becomes a GET.
  assert.equal(endpoint.method, 'POST');
  assert.deepEqual(JSON.parse(endpoint.body ?? '{}'), { challanNo: '29308' });
  assert.deepEqual(JSON.parse(endpoint.documentedResponse ?? '{}'), {
    count: 1,
    status: 'success',
  });
});

test('a well-formed curl command parses the ordinary way too', () => {
  const candidate = parseCurl(
    `curl -X PUT 'https://api.example.test/v1/thing' \\
       -H 'Authorization: Bearer abc' \\
       --data-raw '{"n":1}'`,
    [0],
  );
  assert.ok(candidate);
  assert.equal(candidate.method, 'PUT');
  assert.deepEqual(candidate.headers, [['Authorization', 'Bearer abc']]);
  assert.equal(candidate.body, '{\n  "n": 1\n}');
});

test('-G keeps a command with data on GET', () => {
  const candidate = parseCurl(`curl -G 'https://api.example.test/v1' -d 'a=1'`, [0]);
  assert.equal(candidate?.method, 'GET');
});

test('every method a document can state is read back as that method', () => {
  // -X is the common form, but three flags state the method by implication and
  // are the only statement of it in commands that use them.
  const methodOf = (command: string) => parseCurl(command, [0])?.method;

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal(
      methodOf(`curl -X ${method} 'https://api.example.test/v1/thing'`),
      method,
      `-X ${method} must survive`,
    );
  }

  // `-I` is a HEAD. Without it the command reads as a GET.
  assert.equal(methodOf(`curl -I 'https://api.example.test/v1/thing'`), 'HEAD');

  // `-T` is a PUT — and its filename argument used to be mistaken for the URL,
  // which sent the request to https://payload.json.
  const upload = parseCurl(`curl -T payload.json 'https://api.example.test/v1/thing'`, [0]);
  assert.equal(upload?.method, 'PUT');
  assert.equal(upload?.url, 'https://api.example.test/v1/thing');
  assert.ok(upload?.warnings.some((warning) => /attach it yourself/.test(warning)));

  // `--json` is a POST that both sends and accepts JSON.
  const json = parseCurl(`curl --json '{"a":1}' 'https://api.example.test/v1/thing'`, [0]);
  assert.equal(json?.method, 'POST');
  assert.deepEqual(json?.headers, [
    ['Content-Type', 'application/json'],
    ['Accept', 'application/json'],
  ]);

  // A DELETE that carries a body keeps both.
  const remove = parseCurl(
    `curl -X DELETE 'https://api.example.test/v1/thing/9' -d '{"reason":"x"}'`,
    [0],
  );
  assert.equal(remove?.method, 'DELETE');
  assert.equal(remove?.body, '{\n  "reason": "x"\n}');
});

// --- merging ---------------------------------------------------------------

test('two readings of one endpoint merge instead of duplicating', () => {
  // The table omits the auth header; the curl paste below it carries one.
  const { endpoints } = parse(`
## Thing

| HTTP Method | POST |
| --- | --- |
| URL | https://api.example.test/v1/thing |
| Request Body | {"a": 1} |
| Response | {"ok": true} |

curl --location 'https://api.example.test/v1/thing' -H 'X-Api-Key: EEEE9999' -d '{"a": 1}'
`);

  assert.equal(endpoints.length, 1, 'the same endpoint read twice is still one endpoint');
  const names = endpoints[0].headers.map(([name]) => name);
  assert.ok(names.includes('X-Api-Key'), 'the header only the curl paste had must survive');
  assert.equal(endpoints[0].documentedResponse, '{\n  "ok": true\n}');
});

// --- a document that is nothing but exported curl commands ------------------

/**
 * The shape a browser export takes: `# N. name — METHOD STATUS` over a full
 * Chrome-style command. Reduced from a real 23-command file that came back with
 * 26 endpoints, two names between them, and POSTs listed as GETs.
 */
const EXPORTED = `# 1. userrecentservice — POST 200
curl 'https://api.example.test/core-profile/ws1/userrecentservice' \\
  -H 'accept: text/plain' \\
  -H 'origin: https://web.example.test' \\
  -H 'referer: https://web.example.test/' \\
  -H 'x-api-key: KEY1111' \\
  --data-raw 'AAAA=='

# 2. firebase:fetch?key=AAA — POST 200
curl 'https://config.example.test/v1/projects/p/namespaces/firebase:fetch?key=AAA' \\
  -H 'content-type: application/json' \\
  -H 'origin: https://web.example.test' \\
  --data-raw '{"sdk_version":"1"}' \\
  --compressed

# 3. document-needed?lang=en — GET 200
curl 'https://api.example.test/v2/document-needed?lang=en' \\
  -H 'accept: application/json' \\
  -H 'referer: https://web.example.test/' \\
  -H 'x-api-key: KEY2222'
`;

test('a document of exported curl commands yields exactly those commands', () => {
  const { endpoints } = parse(EXPORTED);
  assert.equal(endpoints.length, 3);
});

test("a curl command's own header lines are not read as endpoints", () => {
  // `-H 'origin: https://web.example.test'` and its `referer` twin are bare URLs
  // on a line. Left to the line-by-line extractor they became phantom GETs
  // against the site's home page — sixteen of them in the real document.
  const { endpoints, stats } = parse(EXPORTED);
  assert.equal(stats['labelled'], undefined, 'nothing should be read outside the commands');
  assert.ok(
    !endpoints.some((endpoint) => /^https:\/\/web\.example\.test\/?$/.test(endpoint.url)),
    'the referer host must not become an endpoint',
  );
});

test('a hand-marked heading names its command, and only its command', () => {
  const { endpoints } = parse(EXPORTED);
  // Every endpoint inherited the last heading that happened to pass the
  // conservative unstyled-heading test, so three commands shared one name.
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.name),
    ['userrecentservice', 'firebase:fetch?key=AAA', 'document-needed?lang=en'],
  );
});

test('the marker, numbering and trailing method are stripped from a name', () => {
  assert.equal(cleanHeading('# 1. userrecentservice — POST 200'), 'userrecentservice');
  assert.equal(cleanHeading('12) Fetch profile - GET'), 'Fetch profile');
  assert.equal(cleanHeading('### Submit API (200)'), 'Submit API');
  // Nothing left to keep means the original was the name.
  assert.equal(cleanHeading('## 4.'), '4.');
});

test('methods survive a document written entirely in curl', () => {
  const { endpoints } = parse(EXPORTED);
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.method),
    ['POST', 'POST', 'GET'],
  );
});

test('the same route with different bodies stays as two entries', () => {
  const { endpoints } = parse(`# 1. stationcondition — POST 200
curl 'https://api.example.test/ws1/stationcondition' -H 'x-api-key: K' --data-raw '{"subHeadId":"127"}'

# 2. stationcondition — POST 200
curl 'https://api.example.test/ws1/stationcondition' -H 'x-api-key: K' --data-raw '{"subHeadId":"213"}'
`);

  // Two payloads to one route are two test cases; collapsing them loses one.
  assert.equal(endpoints.length, 2);
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.name),
    ['stationcondition', 'stationcondition (2)'],
  );
});

test('the same command written twice is still one endpoint', () => {
  const { endpoints } = parse(`# 1. thing — GET 200
curl 'https://api.example.test/v1/thing' -H 'x-api-key: K'

# 2. thing — GET 200
curl 'https://api.example.test/v1/thing' -H 'x-api-key: K'
`);
  assert.equal(endpoints.length, 1);
});

test('a body differing only in whitespace and key order is the same body', () => {
  const { endpoints } = parse(`# 1. save — POST 200
curl 'https://api.example.test/v1/save' --data-raw '{"a":1,"b":2}'

# 2. save — POST 200
curl 'https://api.example.test/v1/save' --data-raw '{ "b": 2, "a": 1 }'
`);
  assert.equal(endpoints.length, 1);
});

// --- parameters and placeholders -------------------------------------------

test('path placeholders become parameters and block a run', () => {
  const [endpoint] = parse(`
| HTTP Method | GET |
| --- | --- |
| URL | https://api.example.test/v1/order-status/{bookingId} |
`).endpoints;

  assert.deepEqual(
    endpoint.params.filter((param) => param.in === 'path').map((param) => param.name),
    ['bookingId'],
  );
  assert.ok(endpoint.warnings.some((warning) => warning.includes('{bookingId}')));
});

test('field tables are split into what is sent and what comes back', () => {
  const [endpoint] = parse(`
## Submit API

| HTTP Method | POST |
| --- | --- |
| URL | https://api.example.test/v1/save |
| Request Body | {"benfTypeCd": "1"} |
| Response | {"rs": "S"} |

| # | Parameter Name | Description | Data Type |
| --- | --- | --- | --- |
| 1 | benfTypeCd | Beneficiary type | String |
| 2 | rs | Request status | String |
`).endpoints;

  const where = (name: string) =>
    endpoint.params.find((param) => param.name === name)?.in;
  // Membership in the payloads decides this — the table itself says neither.
  assert.equal(where('benfTypeCd'), 'body');
  assert.equal(where('rs'), 'response');
});

// --- resolution ------------------------------------------------------------

test('variables fill placeholders in every form, and leave unset ones visible', () => {
  const values = new Map([['bookingId', 'ABC123']]);
  assert.equal(substitute('/orders/{bookingId}', values), '/orders/ABC123');
  assert.equal(substitute('/orders/{{bookingId}}', values), '/orders/ABC123');
  assert.equal(substitute('/orders/:bookingId', values), '/orders/ABC123');
  // An unknown name is left alone rather than blanked, so `/orders//` is never
  // silently produced.
  assert.equal(substitute('/orders/{other}', values), '/orders/{other}');
});

test('a header turned off is kept in the editor but not sent', () => {
  const [endpoint] = parse(SPEC_TABLE).endpoints;
  const rows = [
    ...toHeaderRows(endpoint.headers),
    { name: 'X-Trace', value: 'abc', enabled: true },
    { name: 'X-Off', value: 'no', enabled: false },
  ];

  // Disabling rather than deleting is the point: turning a header off to see
  // whether it is load-bearing, and back on again, is most of what anyone does
  // to a header list while testing an endpoint.
  const sent = fromHeaderRows(rows).map(([name]) => name);
  assert.deepEqual(sent, ['Accept', 'X-Trace']);

  const resolved = resolveEndpoint(endpoint, [], { headers: rows });
  assert.deepEqual(
    resolved.headers.map(([name]) => name),
    ['Accept', 'X-Trace'],
  );
});

test('an override replaces the document reading without erasing it', () => {
  const [endpoint] = parse(SPEC_TABLE).endpoints;
  const resolved = resolveEndpoint(endpoint, [], {
    method: 'POST',
    url: 'https://elsewhere.test/v2',
    body: '{"n":1}',
  });

  assert.equal(resolved.method, 'POST');
  assert.equal(resolved.url, 'https://elsewhere.test/v2');
  // What the document said is untouched underneath, which is what makes
  // "reset to document" possible and a mis-parse easy to spot.
  assert.equal(endpoint.url, 'https://api.example.test/open/checkAvailability?spotId=1');
  assert.equal(endpoint.body, null);
});

test('a documented endpoint produces a runnable curl command', () => {
  const [endpoint] = parse(MANGLED_CURL).endpoints;
  const record = toRequestRecord(endpoint);
  const command = buildCurl(record, DEFAULT_CURL_OPTIONS);

  assert.match(command, /^curl 'http:\/\/api\.example\.test\/service\/api\/Challandetails'/);
  assert.match(command, /-H 'Api-Key: DDDD8888'/);
  assert.match(command, /--data-raw/);
  // No `-X POST`, and that is right: curl infers POST from a data flag, which is
  // what Chrome's own Copy as cURL emits too. What matters is that the record
  // carries the method, so a run sends the right one.
  assert.equal(record.method, 'POST');
  assert.doesNotMatch(command, /-X GET/);
});

// --- Postman export --------------------------------------------------------

function collectionOf(endpoints: ParsedEndpoint[], variables = []) {
  return JSON.parse(
    toPostmanCollection(endpoints, variables, 'Doc', { useVariables: true }),
  ) as Record<string, any>;
}

test('the Postman export carries path variables, examples and folders', () => {
  const { endpoints } = parse(`
# Payments

## Order Status

| HTTP Method | GET |
| --- | --- |
| URL | https://api.example.test/v1/order-status/{bookingId} |
| Response | {"status": "success"} |
`);

  const collection = collectionOf(endpoints);
  assert.equal(collection['info']['schema'].includes('v2.1.0'), true);

  // The heading trail above the endpoint becomes a folder.
  const folder = collection['item'][0];
  assert.equal(folder['name'], 'Payments');

  const request = folder['item'][0]['request'];
  // Postman only offers its path-variable editor for the colon form.
  assert.equal(request['url']['raw'], 'https://api.example.test/v1/order-status/:bookingId');
  assert.deepEqual(
    request['url']['variable'].map((variable: { key: string }) => variable.key),
    ['bookingId'],
  );

  // The documented response is saved as an example, so the collection still
  // describes the endpoint once the sample credentials expire.
  assert.equal(folder['item'][0]['response'][0]['body'], '{\n  "status": "success"\n}');
});

test('credentials become collection variables so the file can be shared', () => {
  const { endpoints, variables } = parse(MANGLED_CURL);
  const collection = JSON.parse(
    toPostmanCollection(endpoints, variables, 'Doc', { useVariables: true }),
  ) as Record<string, any>;

  const headers = collection['item'][0]['request']['header'] as Array<{
    key: string;
    value: string;
  }>;
  const apiKey = headers.find((header) => header.key === 'Api-Key');
  assert.equal(apiKey?.value, '{{api_key}}', 'the live key must not be baked into the request');

  const variable = (collection['variable'] as Array<{ key: string; value: string }>).find(
    (entry) => entry.key === 'api_key',
  );
  assert.ok(variable, 'the credential needs a variable to be filled in');
  assert.equal(variable.value, '', 'the recipient fills in their own');
});

test('an inline export keeps the values, for private use', () => {
  const { endpoints, variables } = parse(MANGLED_CURL);
  const collection = JSON.parse(
    toPostmanCollection(endpoints, variables, 'Doc', { useVariables: false }),
  ) as Record<string, any>;

  const headers = collection['item'][0]['request']['header'] as Array<{
    key: string;
    value: string;
  }>;
  assert.equal(headers.find((header) => header.key === 'Api-Key')?.value, 'DDDD8888');
});

// --- empty and hostile input ------------------------------------------------

test('a document with no endpoints says so rather than failing', () => {
  const result = parse('# Notes\n\nThere is no API described here at all.\n');
  assert.equal(result.endpoints.length, 0);
  assert.ok(result.warnings.some((warning) => /No endpoints were recognised/.test(warning)));
});

test('a malformed body is kept and flagged rather than dropped', () => {
  const [endpoint] = parse(`
| HTTP Method | POST |
| --- | --- |
| URL | https://api.example.test/v1/x |
| Request Body | {"a": 1,,} |
`).endpoints;

  assert.equal(endpoint.body, '{"a": 1,,}');
  assert.ok(endpoint.warnings.some((warning) => /does not parse/.test(warning)));
});
