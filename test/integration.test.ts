import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store/db.ts';
import { CdpConnection } from '../src/capture/client.ts';
import { Recorder } from '../src/capture/recorder.ts';
import { launchBrowser } from '../src/chrome/launch.ts';
import { buildCurl } from '../src/curl/build.ts';
import { DEFAULT_CURL_OPTIONS, type RequestRecord } from '../src/types.ts';

/**
 * Drives a real headless Chrome against a local site.
 *
 * The page deliberately mixes one genuine API call with the kind of traffic that
 * makes a HAR export unusable — an image, a stylesheet, a script — so the test
 * covers both halves of the tool: that the API call is captured completely, and
 * that the noise around it is discarded.
 */

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head>
<body>
<img src="/logo.png" alt="">
<script src="/vendor.js"></script>
<script>
  fetch('/api/v1/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'TEST_KEY_123' },
    body: JSON.stringify({ user: 'kundan', otp: '000111' })
  }).then(function (r) { return r.json(); });
</script>
</body></html>`;

function startSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/') {
      // The cookie is the point: it is attached after requestWillBeSent fires, so
      // it only appears in the record if the extraInfo merge works.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'session=s3cr3t; Path=/',
      });
      res.end(PAGE);
      return;
    }
    if (path === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('body{margin:0}');
      return;
    }
    if (path === '/vendor.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('window.__vendor = 1;');
      return;
    }
    if (path === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
      return;
    }
    if (path === '/api/v1/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'jwt-value', profile: { id: 7, name: 'Kundan' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/** Retries removal briefly, since a just-killed Chrome may still be flushing. */
async function removeWhenSettled(dir: string, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the expected request');
}

test('captures a real browser session end to end', { timeout: 90_000 }, async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'curlapi-test-'));
  const { server, origin } = await startSite();

  const store = new Store(join(workDir, 'test.db'));
  const sessionId = randomUUID();
  store.createSession({
    id: sessionId,
    label: 'integration',
    startedAt: Date.now(),
    endedAt: null,
    primaryHost: null,
  });

  const records: RequestRecord[] = [];
  const browser = await launchBrowser({
    headless: true,
    userDataDir: join(workDir, 'profile'),
  });

  const connection = await CdpConnection.connect(
    await CdpConnection.browserUrl(browser.port),
  );
  const recorder = new Recorder({
    connection,
    sessionId,
    store,
    onRecord: (record) => records.push(record),
  });
  await recorder.start();

  t.after(async () => {
    await recorder.stop();
    connection.close();
    // Awaited: Chrome keeps writing to its profile for a moment after exiting,
    // and removing the directory underneath it fails with ENOTEMPTY.
    await browser.close();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeWhenSettled(workDir);
  });

  await recorder.openAndNavigate(`${origin}/`);

  const login = await waitFor(() =>
    records.find((record) => record.path === '/api/v1/login'),
  );

  await t.test('captures the API call with a complete header set', () => {
    assert.equal(login.method, 'POST');
    assert.equal(login.status, 200);
    assert.equal(login.verdict.keep, true);

    const names = login.requestHeaders.map(([name]) => name.toLowerCase());
    assert.ok(names.includes('x-api-key'), 'custom header captured');
    assert.ok(
      names.includes('cookie'),
      'cookie must be present — it proves requestWillBeSentExtraInfo was merged',
    );

    const apiKey = login.requestHeaders.find(([name]) => name.toLowerCase() === 'x-api-key');
    assert.equal(apiKey?.[1], 'TEST_KEY_123');

    const cookie = login.requestHeaders.find(([name]) => name.toLowerCase() === 'cookie');
    assert.match(cookie?.[1] ?? '', /session=s3cr3t/);
  });

  await t.test('captures both bodies in full', () => {
    assert.ok(login.requestBody, 'request body captured');
    assert.deepEqual(JSON.parse(login.requestBody.data), {
      user: 'kundan',
      otp: '000111',
    });

    assert.ok(login.responseBody, 'response body captured');
    assert.deepEqual(JSON.parse(login.responseBody.data), {
      token: 'jwt-value',
      profile: { id: 7, name: 'Kundan' },
    });
  });

  await t.test('generates a curl carrying the credentials', () => {
    const curl = buildCurl(login, DEFAULT_CURL_OPTIONS);
    assert.ok(curl.includes("-H 'x-api-key: TEST_KEY_123'"));
    assert.ok(curl.includes('session=s3cr3t'));
    assert.ok(curl.includes('--data-raw'));
    assert.ok(!curl.includes('accept-encoding'), 'transport headers excluded');
  });

  await t.test('discards the surrounding noise', async () => {
    // These are the requests that made the HAR 22MB.
    const image = await waitFor(() => records.find((r) => r.path === '/logo.png'));
    const style = await waitFor(() => records.find((r) => r.path === '/style.css'));
    const script = await waitFor(() => records.find((r) => r.path === '/vendor.js'));

    for (const record of [image, style, script]) {
      assert.equal(record.verdict.keep, false, `${record.path} should be filtered out`);
      assert.ok(record.verdict.reason.length > 0, 'the drop is explained');
      assert.equal(record.responseBody, null, 'no body is fetched for dropped requests');
    }
  });

  await t.test('assigns Chrome-style short names and serial numbers', () => {
    assert.equal(login.shortName, 'login');
    assert.ok(login.seq >= 1);
  });

  await t.test('the session on disk stays small', () => {
    const bytes = store.sessionBytes(sessionId);
    assert.ok(bytes < 200_000, `session should be small, was ${bytes} bytes`);
  });
});
