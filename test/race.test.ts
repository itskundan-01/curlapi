import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { Recorder } from '../src/capture/recorder.ts';
import type { CdpConnection, CdpEvent } from '../src/capture/client.ts';
import type { RequestRecord } from '../src/types.ts';

/**
 * A CDP connection whose event stream the test controls, so protocol orderings
 * that only show up on a loaded machine can be reproduced deliberately.
 */
function fakeConnection() {
  const listeners = new Set<(event: CdpEvent) => void>();
  const connection = {
    onEvent(listener: (event: CdpEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method: string) {
      if (method === 'Network.getResponseBody') {
        return Promise.resolve({ body: '{"ok":true}', base64Encoded: false });
      }
      return Promise.resolve({});
    },
    trySend(method: string) {
      return connection.send(method);
    },
    close() {},
  };

  return {
    connection: connection as unknown as CdpConnection,
    emit(method: string, params: Record<string, unknown>) {
      for (const listener of listeners) listener({ method, params });
    },
  };
}

const REQUEST_ID = '1000.1';

function withRecorder(
  fn: (
    emit: (method: string, params: Record<string, unknown>) => void,
    records: RequestRecord[],
    recorder: Recorder,
  ) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'curlapi-race-'));
  const store = new Store(join(dir, 'test.db'));
  store.createSession({
    id: 's',
    label: 'race',
    startedAt: Date.now(),
    endedAt: null,
    primaryHost: 'example.com',
  });

  const { connection, emit } = fakeConnection();
  const records: RequestRecord[] = [];
  const recorder = new Recorder({
    connection,
    sessionId: 's',
    store,
    onRecord: (record) => records.push(record),
  });

  return fn(emit, records, recorder).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function requestWillBeSent(hasExtraInfo: boolean) {
  return {
    requestId: REQUEST_ID,
    type: 'Fetch',
    wallTime: Date.now() / 1000,
    request: {
      url: 'https://api.example.com/v1/login',
      method: 'POST',
      headers: { accept: 'application/json' },
      postData: '{"user":"kundan"}',
      hasPostData: true,
    },
    hasExtraInfo,
  };
}

test('a late requestWillBeSentExtraInfo still reaches the record', async () => {
  await withRecorder(async (emit, records, recorder) => {
    await recorder.start();

    // The order that breaks a naive implementation: the request finishes before
    // its wire headers are reported, which is what happens under CPU load.
    emit('Network.requestWillBeSent', requestWillBeSent(true));
    emit('Network.responseReceived', {
      requestId: REQUEST_ID,
      hasExtraInfo: false,
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
      },
    });
    emit('Network.loadingFinished', { requestId: REQUEST_ID, encodedDataLength: 11 });

    // Arrives only after finalisation has already begun.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(records.length, 0, 'finalisation should still be waiting');

    emit('Network.requestWillBeSentExtraInfo', {
      requestId: REQUEST_ID,
      headers: {
        accept: 'application/json',
        cookie: 'session=s3cr3t',
        'sec-fetch-site': 'same-origin',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(records.length, 1, 'the record is emitted once');
    const names = records[0].requestHeaders.map(([name]) => name.toLowerCase());
    assert.ok(names.includes('cookie'), 'the late cookie survived');
    assert.ok(names.includes('accept'));
    assert.equal(names.filter((name) => name === 'accept').length, 1, 'no duplicates');
  });
});

test('finalisation is not held up when no extra info is promised', async () => {
  await withRecorder(async (emit, records, recorder) => {
    await recorder.start();

    emit('Network.requestWillBeSent', requestWillBeSent(false));
    emit('Network.responseReceived', {
      requestId: REQUEST_ID,
      hasExtraInfo: false,
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        mimeType: 'application/json',
      },
    });
    emit('Network.loadingFinished', { requestId: REQUEST_ID, encodedDataLength: 11 });

    // No wait is warranted, so the record should be ready almost immediately.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 200);
    assert.equal(records[0].requestBody?.data, '{"user":"kundan"}');
  });
});

test('the review UI polling itself is never recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curlapi-self-'));
  const store = new Store(join(dir, 'test.db'));
  store.createSession({
    id: 's',
    label: 'self',
    startedAt: Date.now(),
    endedAt: null,
    primaryHost: null,
  });

  const { connection, emit } = fakeConnection();
  const records: RequestRecord[] = [];
  const recorder = new Recorder({
    connection,
    sessionId: 's',
    store,
    onRecord: (record) => records.push(record),
    ignoreOrigins: ['http://127.0.0.1:7317'],
  });
  await recorder.start();

  // The UI tab must not be allowed to claim primaryHost either, or every real
  // request would be measured against 127.0.0.1.
  emit('Page.frameNavigated', { frame: { url: 'http://127.0.0.1:7317/', id: 'f1' } });

  for (let i = 0; i < 5; i++) {
    emit('Network.requestWillBeSent', {
      requestId: `poll.${i}`,
      type: 'Fetch',
      wallTime: Date.now() / 1000,
      request: { url: 'http://127.0.0.1:7317/api/status', method: 'GET', headers: {} },
      hasExtraInfo: false,
    });
    emit('Network.loadingFinished', { requestId: `poll.${i}`, encodedDataLength: 514 });
  }

  // One genuine request, to prove the recorder is still working at all.
  emit('Network.requestWillBeSent', {
    requestId: 'real.1',
    type: 'Fetch',
    wallTime: Date.now() / 1000,
    request: { url: 'https://gateway.acme.co.uk/v1/landingstats', method: 'GET', headers: {} },
    hasExtraInfo: false,
  });
  emit('Network.loadingFinished', { requestId: 'real.1', encodedDataLength: 100 });

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(records.length, 1, 'only the site request is recorded');
  assert.equal(records[0].host, 'gateway.acme.co.uk');
  assert.equal(recorder.primaryHost, null, 'the UI tab did not claim primaryHost');
  // Serial numbers were not consumed by the polling.
  assert.equal(records[0].seq, 1);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a tab that was already loaded is reported, not silently ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curlapi-stale-'));
  const store = new Store(join(dir, 'test.db'));
  store.createSession({
    id: 's',
    label: 'stale',
    startedAt: Date.now(),
    endedAt: null,
    primaryHost: null,
  });

  const { connection, emit } = fakeConnection();
  const recorder = new Recorder({
    connection,
    sessionId: 's',
    store,
    onRecord: () => {},
    ignoreOrigins: ['http://127.0.0.1:7317'],
  });
  await recorder.start();

  // A page already showing content finished loading before we could watch it,
  // so the user would otherwise see an idle list and assume capture is broken.
  emit('Target.attachedToTarget', {
    sessionId: 'sess-1',
    targetInfo: { type: 'page', targetId: 't1', url: 'https://app.acme.co.uk/landing/' },
  });
  // A blank tab has nothing to miss, and our own UI is not the site under test.
  emit('Target.attachedToTarget', {
    sessionId: 'sess-2',
    targetInfo: { type: 'page', targetId: 't2', url: 'about:blank' },
  });
  emit('Target.attachedToTarget', {
    sessionId: 'sess-3',
    targetInfo: { type: 'page', targetId: 't3', url: 'http://127.0.0.1:7317/' },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(recorder.staleTabs, ['https://app.acme.co.uk/landing/']);

  // Navigating that tab means its traffic is flowing again.
  emit('Page.frameNavigated', {
    frame: { url: 'https://app.acme.co.uk/landing/', id: 'f1' },
  });
  assert.deepEqual(recorder.staleTabs, [], 'no longer stale once it navigates');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('clearing restarts serial numbering', async () => {
  await withRecorder(async (emit, records, recorder) => {
    await recorder.start();

    const send = (id: string, url: string) => {
      emit('Network.requestWillBeSent', {
        requestId: id,
        type: 'Fetch',
        wallTime: Date.now() / 1000,
        request: { url, method: 'GET', headers: {} },
        hasExtraInfo: false,
      });
      emit('Network.loadingFinished', { requestId: id, encodedDataLength: 10 });
    };

    send('a.1', 'https://api.example.com/one');
    send('a.2', 'https://api.example.com/two');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(records.map((record) => record.seq), [1, 2]);

    recorder.resetSequence();
    send('b.1', 'https://api.example.com/three');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(records[2].seq, 1, 'numbering starts over after a clear');
  });
});

test('a promised extra info that never arrives does not hang the capture', async () => {
  await withRecorder(async (emit, records, recorder) => {
    await recorder.start();

    // hasExtraInfo is true but the event never comes; the wait must time out.
    emit('Network.requestWillBeSent', requestWillBeSent(true));
    emit('Network.loadingFailed', { requestId: REQUEST_ID, errorText: 'net::ERR_FAILED' });

    await new Promise((resolve) => setTimeout(resolve, 2400));
    assert.equal(records.length, 1, 'the record is still emitted after the timeout');
    assert.equal(records[0].error, 'net::ERR_FAILED');
  });
});
