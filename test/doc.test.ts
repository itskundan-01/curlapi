import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { toMarkdown, toCopyBlock } from '../src/export/doc.ts';
import type { DocEntry, SessionRecord } from '../src/types.ts';
import { makeRecord } from './helpers.ts';

function withStore<T>(fn: (store: Store, sessionId: string, session: SessionRecord) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'curlapi-doc-'));
  const store = new Store(join(dir, 'test.db'));
  const session: SessionRecord = {
    id: 'session-1',
    label: 'Doc test',
    startedAt: Date.UTC(2026, 7, 4),
    endedAt: null,
    primaryHost: 'app.acme.co.uk',
  };
  store.createSession(session);
  try {
    return fn(store, session.id, session);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('document entries keep their order and renumber on reorder', () => {
  withStore((store, sessionId) => {
    const ids = ['a', 'b', 'c'].map((name, index) =>
      store.addDocEntry({
        id: name,
        sessionId,
        requestId: `req-${index}`,
        title: name,
        note: '',
        curlSnapshot: `curl '${name}'`,
        url: `https://api.example.com/${name}`,
        method: 'GET',
        status: 200,
      }).id,
    );

    assert.deepEqual(
      store.listDocEntries(sessionId).map((entry) => entry.title),
      ['a', 'b', 'c'],
    );

    store.reorderDocEntries([ids[2], ids[0], ids[1]]);
    assert.deepEqual(
      store.listDocEntries(sessionId).map((entry) => entry.title),
      ['c', 'a', 'b'],
    );
  });
});

test('clearing captured requests leaves the document intact', () => {
  withStore((store, sessionId) => {
    const record = makeRecord({ id: 'req-1', sessionId, shortName: 'verify' });
    store.upsertRequest(record);

    store.addDocEntry({
      id: 'entry-1',
      sessionId,
      requestId: 'req-1',
      title: 'verify',
      note: 'confirms the OTP',
      curlSnapshot: "curl 'https://api.example.com/verify'",
      url: 'https://api.example.com/verify',
      method: 'POST',
      status: 200,
    });

    const removed = store.clearRequests(sessionId);
    assert.equal(removed, 1);
    assert.equal(store.listRequests(sessionId, { includeNoise: true }).length, 0);

    // This is the point of snapshotting the command when the entry is created.
    const entries = store.listDocEntries(sessionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].note, 'confirms the OTP');
    assert.match(entries[0].curlSnapshot, /^curl /);
  });
});

test('bulk approval applies to every id at once', () => {
  withStore((store, sessionId) => {
    for (const id of ['r1', 'r2', 'r3']) {
      store.upsertRequest(makeRecord({ id, sessionId }));
    }
    store.setApprovedMany(['r1', 'r3'], true);
    assert.deepEqual(
      store.listApproved(sessionId).map((record) => record.id),
      ['r1', 'r3'],
    );

    store.setApprovedMany(['r1', 'r3'], false);
    assert.equal(store.listApproved(sessionId).length, 0);
  });
});

test('markdown numbers commands and leaves notes as headings', () => {
  const session: SessionRecord = {
    id: 's',
    label: 'Account login flow',
    startedAt: Date.UTC(2026, 7, 4),
    endedAt: null,
    primaryHost: 'app.acme.co.uk',
  };

  const entries: DocEntry[] = [
    {
      id: 'n1',
      sessionId: 's',
      folderId: 'f1',
      requestId: null,
      position: 0,
      title: 'Login',
      note: 'Two calls: request an OTP, then verify it.',
      curlSnapshot: '',
      recordSnapshot: null,
      url: '',
      method: '',
      status: null,
      createdAt: 0,
    },
    {
      id: 'e1',
      sessionId: 's',
      folderId: 'f1',
      requestId: 'r1',
      position: 1,
      title: 'request-otp',
      note: 'Takes the account number.',
      curlSnapshot: '',
      recordSnapshot: null,
      url: 'https://gateway.acme-api.net/otp',
      method: 'POST',
      status: 200,
      createdAt: 0,
    },
    {
      id: 'e2',
      sessionId: 's',
      folderId: 'f1',
      requestId: 'r2',
      position: 2,
      title: 'verify',
      note: '',
      curlSnapshot: '',
      recordSnapshot: null,
      url: 'https://gateway.acme-api.net/verify',
      method: 'POST',
      status: 200,
      createdAt: 0,
    },
  ];

  const markdown = toMarkdown(entries, session, (entry) => `curl '${entry.url}'`);

  assert.match(markdown, /^# Account login flow/);
  assert.ok(markdown.includes('## Login'), 'free-text entry becomes a heading');
  assert.ok(markdown.includes('Two calls: request an OTP'));
  // Commands are numbered in document order, and headings do not consume a
  // number — the same numbers the Doc tab and "Copy all" show.
  assert.ok(markdown.includes('## 1. request-otp'));
  assert.ok(markdown.includes('## 2. verify'));
  assert.ok(markdown.includes("```bash\ncurl 'https://gateway.acme-api.net/otp'\n```"));
  assert.ok(markdown.includes('Takes the account number.'));
});

test('markdown skips the contents index for short documents', () => {
  const session: SessionRecord = {
    id: 's',
    label: 'Short',
    startedAt: 0,
    endedAt: null,
    primaryHost: null,
  };
  const one: DocEntry[] = [
    {
      id: 'e1',
      sessionId: 's',
      folderId: 'f1',
      requestId: 'r1',
      position: 0,
      title: 'only',
      note: '',
      curlSnapshot: '',
      recordSnapshot: null,
      url: 'https://x.test/a',
      method: 'GET',
      status: 200,
      createdAt: 0,
    },
  ];
  assert.ok(!toMarkdown(one, session, () => 'curl').includes('## Contents'));
});

test('each document numbers and orders its own entries', () => {
  withStore((store, sessionId) => {
    const login = store.createFolder(sessionId, 'Login flow');
    const profile = store.createFolder(sessionId, 'Profile');

    const add = (folderId: string, title: string) =>
      store.addDocEntry({
        id: `${folderId}-${title}`,
        sessionId,
        folderId,
        requestId: `req-${title}`,
        title,
        note: '',
        curlSnapshot: `curl '${title}'`,
        url: `https://api.example.com/${title}`,
        method: 'GET',
        status: 200,
      });

    add(login.id, 'otp');
    add(login.id, 'verify');
    add(profile.id, 'getProfile');

    // Positions restart per folder: the first entry in Profile is #1, not #3.
    assert.deepEqual(
      store.listDocEntries(sessionId, login.id).map((entry) => entry.position),
      [0, 1],
    );
    assert.deepEqual(
      store.listDocEntries(sessionId, profile.id).map((entry) => entry.position),
      [0],
    );

    // Listing the whole session walks folders in order, then entries in theirs.
    assert.deepEqual(
      store.listDocEntries(sessionId).map((entry) => entry.title),
      ['otp', 'verify', 'getProfile'],
    );

    // Reordering one document leaves the other alone.
    const inLogin = store.listDocEntries(sessionId, login.id);
    store.reorderDocEntries([inLogin[1].id, inLogin[0].id]);
    assert.deepEqual(
      store.listDocEntries(sessionId, login.id).map((entry) => entry.title),
      ['verify', 'otp'],
    );
    assert.deepEqual(
      store.listDocEntries(sessionId, profile.id).map((entry) => entry.title),
      ['getProfile'],
    );
  });
});

test('moving an entry between documents appends it to the target', () => {
  withStore((store, sessionId) => {
    const from = store.createFolder(sessionId, 'Scratch');
    const to = store.createFolder(sessionId, 'Keep');

    const make = (folderId: string, title: string) =>
      store.addDocEntry({
        id: title,
        sessionId,
        folderId,
        requestId: `req-${title}`,
        title,
        note: '',
        curlSnapshot: '',
        url: '',
        method: 'GET',
        status: 200,
      });

    make(to.id, 'first');
    make(from.id, 'moved');

    store.moveDocEntry('moved', to.id);
    assert.deepEqual(
      store.listDocEntries(sessionId, to.id).map((entry) => entry.title),
      ['first', 'moved'],
    );
    assert.equal(store.listDocEntries(sessionId, from.id).length, 0);
  });
});

test('deleting a document takes its entries and nothing else', () => {
  withStore((store, sessionId) => {
    const doomed = store.createFolder(sessionId, 'Doomed');
    const kept = store.createFolder(sessionId, 'Kept');

    for (const [folderId, title] of [
      [doomed.id, 'a'],
      [doomed.id, 'b'],
      [kept.id, 'c'],
    ] as const) {
      store.addDocEntry({
        id: title,
        sessionId,
        folderId,
        requestId: `req-${title}`,
        title,
        note: '',
        curlSnapshot: '',
        url: '',
        method: 'GET',
        status: 200,
      });
    }

    assert.equal(store.deleteFolder(doomed.id), 2);
    assert.equal(store.getFolder(doomed.id), null);
    assert.deepEqual(
      store.listDocEntries(sessionId).map((entry) => entry.title),
      ['c'],
    );
  });
});

test('entries land in a default document when no folder is chosen', () => {
  withStore((store, sessionId) => {
    // Nothing exists yet, so the first add has to create somewhere to put it.
    assert.deepEqual(store.listFolders(sessionId), []);

    const entry = store.addDocEntry({
      id: 'e1',
      sessionId,
      requestId: 'r1',
      title: 'verify',
      note: '',
      curlSnapshot: '',
      recordSnapshot: null,
      url: '',
      method: 'POST',
      status: 200,
    });

    const folders = store.listFolders(sessionId);
    assert.equal(folders.length, 1);
    assert.equal(entry.folderId, folders[0].id);

    // A second add reuses it rather than making a folder per entry.
    store.addDocEntry({
      id: 'e2',
      sessionId,
      requestId: 'r2',
      title: 'profile',
      note: '',
      curlSnapshot: '',
      recordSnapshot: null,
      url: '',
      method: 'GET',
      status: 200,
    });
    assert.equal(store.listFolders(sessionId).length, 1);
  });
});

test('copy-all numbers the commands and separates them with a blank line', () => {
  const entries: DocEntry[] = [
    {
      id: 'n1',
      sessionId: 's',
      folderId: 'f1',
      requestId: null,
      position: 0,
      title: 'Login',
      note: 'Run these in order.',
      curlSnapshot: '',
      recordSnapshot: null,
      url: '',
      method: '',
      status: null,
      createdAt: 0,
    },
    {
      id: 'e1',
      sessionId: 's',
      folderId: 'f1',
      requestId: 'r1',
      position: 1,
      title: 'otp',
      note: '',
      curlSnapshot: '',
      recordSnapshot: null,
      url: 'https://gateway.acme-api.net/otp',
      method: 'POST',
      status: 200,
      createdAt: 0,
    },
    {
      id: 'e2',
      sessionId: 's',
      folderId: 'f1',
      requestId: 'r2',
      position: 2,
      title: 'verify',
      note: '',
      curlSnapshot: '',
      recordSnapshot: null,
      url: 'https://gateway.acme-api.net/verify',
      method: 'POST',
      status: 200,
      createdAt: 0,
    },
  ];

  const text = toCopyBlock(entries, (entry) => `curl '${entry.url}'`);

  assert.equal(
    text,
    [
      '# Login',
      '# Run these in order.',
      '',
      '# 1. otp — POST 200',
      "curl 'https://gateway.acme-api.net/otp'",
      '',
      '# 2. verify — POST 200',
      "curl 'https://gateway.acme-api.net/verify'",
      '',
    ].join('\n'),
  );

  // Every line that is not a command is a comment, so the whole block pastes
  // into a shell and runs.
  for (const line of text.split('\n')) {
    assert.ok(line === '' || line.startsWith('#') || line.startsWith('curl '), line);
  }
});

test('a document with only notes copies as nothing runnable, not as junk', () => {
  assert.equal(toCopyBlock([], () => ''), '');
});

test('markdown keeps each document in its own section, numbered from one', () => {
  withStore((store, sessionId, session) => {
    const login = store.createFolder(sessionId, 'Login flow');
    const profile = store.createFolder(sessionId, 'Profile');

    for (const [folderId, title] of [
      [login.id, 'otp'],
      [login.id, 'verify'],
      [profile.id, 'getProfile'],
    ] as const) {
      store.addDocEntry({
        id: title,
        sessionId,
        folderId,
        requestId: `req-${title}`,
        title,
        note: '',
        curlSnapshot: `curl '${title}'`,
        url: `https://api.example.com/${title}`,
        method: 'GET',
        status: 200,
      });
    }

    const markdown = toMarkdown(
      store.listDocEntries(sessionId),
      session,
      (entry) => entry.curlSnapshot,
      store.listFolders(sessionId),
    );

    assert.ok(markdown.includes('# Login flow'));
    assert.ok(markdown.includes('# Profile'));
    assert.ok(markdown.includes('## 1. otp'));
    assert.ok(markdown.includes('## 2. verify'));
    // Numbering restarts in the next document rather than continuing at 3.
    assert.ok(markdown.includes('## 1. getProfile'));

    // One folder alone exports without the section heading getting in the way.
    const alone = toMarkdown(
      store.listDocEntries(sessionId, profile.id),
      session,
      (entry) => entry.curlSnapshot,
      [profile],
    );
    assert.ok(!alone.includes('# Login flow'));
    assert.ok(alone.includes('## 1. getProfile'));
  });
});

test('captures survive the process that recorded them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curlapi-persist-'));
  const path = join(dir, 'test.db');
  try {
    // One process records two sessions and exits.
    const first = new Store(path);
    for (const [sessionId, label, startedAt] of [
      ['s1', 'Monday', 1_000],
      ['s2', 'Tuesday', 2_000],
    ] as const) {
      first.createSession({
        id: sessionId,
        label,
        startedAt,
        endedAt: null,
        primaryHost: 'app.acme.co.uk',
      });
      first.upsertRequest(makeRecord({ id: `${sessionId}-a`, sessionId, shortName: 'verify' }));
    }
    first.addDocEntry({
      id: 'note',
      sessionId: 's1',
      requestId: 's1-a',
      title: 'verify',
      note: 'one-time',
      curlSnapshot: "curl 'https://x/verify'",
      url: 'https://x/verify',
      method: 'POST',
      status: 200,
    });
    first.close();

    // A later process finds all of it, which is what the session picker lists.
    const second = new Store(path);
    const summaries = second.listSessionSummaries();
    assert.deepEqual(summaries.map((s) => s.label), ['Tuesday', 'Monday']);
    assert.deepEqual(summaries.map((s) => s.kept), [1, 1]);
    assert.equal(second.listRequests('s1').length, 1);
    assert.equal(second.listDocEntries('s1')[0].note, 'one-time');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session summaries count only what belongs to each session', () => {
  withStore((store, sessionId) => {
    store.createSession({
      id: 'other',
      label: 'Other',
      startedAt: 1,
      endedAt: null,
      primaryHost: null,
    });

    const keep = makeRecord({ id: 'k', sessionId });
    const noise = makeRecord({ id: 'n', sessionId });
    noise.verdict = { keep: false, reason: 'dropped: resourceType=Image', score: -1 };
    const approved = makeRecord({ id: 'a', sessionId });
    approved.approved = true;
    for (const record of [keep, noise, approved]) store.upsertRequest(record);
    store.upsertRequest(makeRecord({ id: 'x', sessionId: 'other' }));

    const summaries = store.listSessionSummaries();
    const mine = summaries.find((s) => s.id === sessionId);
    assert.equal(mine?.total, 3, 'noise counts toward total');
    assert.equal(mine?.kept, 2, 'but not toward kept');
    assert.equal(mine?.approved, 1);
    assert.equal(summaries.find((s) => s.id === 'other')?.kept, 1);

    // A session with nothing in it still appears, rather than being dropped by
    // the join — otherwise a fresh capture would be unreachable in the picker.
    store.createSession({
      id: 'empty',
      label: 'Empty',
      startedAt: 2,
      endedAt: null,
      primaryHost: null,
    });
    const withEmpty = store.listSessionSummaries();
    assert.ok(withEmpty.some((s) => s.id === 'empty' && s.total === 0));
  });
});

test('pruning keeps only what was documented or approved', () => {
  withStore((store, sessionId) => {
    for (const id of ['noise', 'documented', 'approved', 'ignored']) {
      store.upsertRequest(makeRecord({ id, sessionId, shortName: id }));
    }
    store.setApproved('approved', true);
    store.addDocEntry({
      id: 'entry',
      sessionId,
      requestId: 'documented',
      title: 'documented',
      note: 'the one that matters',
      curlSnapshot: "curl 'https://x/documented'",
      recordSnapshot: store.getRequest('documented'),
      url: 'https://x/documented',
      method: 'GET',
      status: 200,
    });

    const discarded = store.pruneSession(sessionId);
    assert.equal(discarded, 2, 'the two unselected requests go');

    assert.deepEqual(
      store.listRequests(sessionId, { includeNoise: true }).map((r) => r.id).sort(),
      ['approved', 'documented'],
    );
    // And the document is untouched by the pruning.
    assert.equal(store.listDocEntries(sessionId).length, 1);
  });
});

test('a documented request stays usable after its capture is discarded', () => {
  withStore((store, sessionId) => {
    const record = makeRecord({ id: 'req', sessionId, shortName: 'verify' });
    record.requestHeaders = [
      ['authorization', 'Bearer live-token'],
      ['x-api-key', 'SECRET'],
    ];
    store.upsertRequest(record);

    store.addDocEntry({
      id: 'entry',
      sessionId,
      requestId: 'req',
      title: 'verify',
      note: '',
      curlSnapshot: 'curl stale',
      recordSnapshot: record,
      url: record.url,
      method: record.method,
      status: record.status,
    });

    // Simulate the capture being thrown away, as it is when a session ends.
    store.clearRequests(sessionId);
    assert.equal(store.getRequest('req'), null);

    // The full request is still reachable through the document, which is what
    // lets the detail view, the curl options and Run keep working.
    const snapshot = store.getDocSnapshot('req');
    assert.ok(snapshot, 'snapshot survives');
    assert.equal(snapshot?.shortName, 'verify');
    assert.deepEqual(snapshot?.requestHeaders, [
      ['authorization', 'Bearer live-token'],
      ['x-api-key', 'SECRET'],
    ]);
  });
});

test('history pruning drops empty sessions but never the current one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curlapi-prune-'));
  const store = new Store(join(dir, 'test.db'));
  try {
    for (const [id, started] of [['old-junk', 1], ['old-kept', 2], ['current', 3]] as const) {
      store.createSession({
        id,
        label: id,
        startedAt: started,
        endedAt: null,
        primaryHost: null,
      });
      store.upsertRequest(makeRecord({ id: `${id}-r`, sessionId: id }));
    }
    // One old session has something worth keeping; the other does not.
    store.addDocEntry({
      id: 'e',
      sessionId: 'old-kept',
      requestId: 'old-kept-r',
      title: 'kept',
      note: '',
      curlSnapshot: 'curl x',
      url: 'https://x/',
      method: 'GET',
      status: 200,
    });

    const result = store.pruneHistory('current');
    assert.equal(result.sessions, 1, 'only the junk session is removed');
    assert.equal(result.requests, 1, 'and only its request was discarded');

    assert.deepEqual(
      store.listSessions().map((s) => s.id).sort(),
      ['current', 'old-kept'],
    );
    // The current session is never touched, even holding nothing selected.
    assert.equal(store.listRequests('current', { includeNoise: true }).length, 1);
    assert.equal(store.listRequests('old-kept', { includeNoise: true }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session is empty only when nothing at all was kept', () => {
  withStore((store, sessionId) => {
    assert.equal(store.isSessionEmpty(sessionId), true);

    store.upsertRequest(makeRecord({ id: 'r', sessionId }));
    assert.equal(store.isSessionEmpty(sessionId), false);

    store.clearRequests(sessionId);
    assert.equal(store.isSessionEmpty(sessionId), true);

    // A document alone is reason enough to keep a session.
    store.createFolder(sessionId, 'Notes');
    assert.equal(store.isSessionEmpty(sessionId), false);
  });
});
