import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { compareVersions, expectedChecksumFor, selectRelease } from '../src/update/index.ts';
import { extractZip, looksLikeCurlapiPayload, zipEntryNames } from '../src/update/zip.ts';

// --- version ordering -----------------------------------------------------

test('orders releases by version', () => {
  assert.equal(compareVersions('0.3.0', '0.2.0') > 0, true);
  assert.equal(compareVersions('0.2.0', '0.3.0') < 0, true);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99') > 0, true);
  // A missing segment is a zero, not a mismatch.
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  // A leading v is how GitHub writes tags and has no bearing on ordering.
  assert.equal(compareVersions('v0.3.0', '0.2.0') > 0, true);
});

test('a prerelease is older than the release it leads to', () => {
  // The case that matters most: everyone on the beta has to be offered 0.2.0.
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0') < 0, true);
  assert.equal(compareVersions('0.2.0', '0.2.0-beta.1') > 0, true);
});

test('orders prerelease identifiers numerically, not as text', () => {
  // Sorted as strings, "10" comes before "9" and beta.10 would never install.
  assert.equal(compareVersions('0.2.0-beta.10', '0.2.0-beta.9') > 0, true);
  assert.equal(compareVersions('0.2.0-beta.2', '0.2.0-beta.10') < 0, true);
  assert.equal(compareVersions('0.2.0-alpha.1', '0.2.0-beta.1') < 0, true);
  // More identifiers wins when the shared ones are equal.
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0-beta') > 0, true);
});

// --- which release to offer -----------------------------------------------

const RELEASES = [
  { tag_name: 'v0.3.0-beta.1', prerelease: true },
  { tag_name: 'v0.2.0', prerelease: false },
  { tag_name: 'v0.1.1', prerelease: false },
];

test('offers a stable install only stable releases', () => {
  // Publishing a beta must not drag everyone on the stable line onto it.
  assert.equal(selectRelease(RELEASES, '0.1.1')?.tag_name, 'v0.2.0');
});

test('offers a prerelease install the newest of anything', () => {
  // Already on a beta is already opted in.
  assert.equal(selectRelease(RELEASES, '0.2.0-beta.1')?.tag_name, 'v0.3.0-beta.1');
});

test('offers prereleases when nothing stable has shipped yet', () => {
  // The case that broke the first release: /releases/latest omits prereleases,
  // so a project whose only release is a beta looked like it had none.
  const betasOnly = [{ tag_name: 'v0.2.0-beta.1', prerelease: true }];
  assert.equal(selectRelease(betasOnly, '0.1.1')?.tag_name, 'v0.2.0-beta.1');
});

test('ignores drafts, and an empty listing', () => {
  const withDraft = [{ tag_name: 'v9.9.9', prerelease: false, draft: true }, ...RELEASES];
  assert.equal(selectRelease(withDraft, '0.1.1')?.tag_name, 'v0.2.0');
  assert.equal(selectRelease([], '0.1.1'), null);
});

test('picks the highest version, not whatever was published last', () => {
  // A patch to an old line can be published after a newer minor, and GitHub
  // returns these newest-first by date rather than by version.
  const outOfOrder = [
    { tag_name: 'v1.0.1', prerelease: false },
    { tag_name: 'v1.2.0', prerelease: false },
  ];
  assert.equal(selectRelease(outOfOrder, '1.0.0')?.tag_name, 'v1.2.0');
});

// --- checksums ------------------------------------------------------------

const SUMS = [
  'aaa111  curlapi-0.3.0-app.tar.gz',
  'bbb222  curlapi-0.3.0-app.zip',
  'ccc333  *curlapi-0.3.0-app.exe',
].join('\n');

test('finds the hash recorded for a payload', () => {
  assert.equal(expectedChecksumFor(SUMS, 'curlapi-0.3.0-app.zip'), 'bbb222');
  assert.equal(expectedChecksumFor(SUMS, 'curlapi-0.3.0-app.tar.gz'), 'aaa111');
  // sha256sum writes a * before the name in binary mode; it is not part of it.
  assert.equal(expectedChecksumFor(SUMS, 'curlapi-0.3.0-app.exe'), 'ccc333');
});

test('reports no hash rather than the wrong one', () => {
  // The bug this guards: a listing for one version, consulted for another,
  // matched nothing and verification was quietly skipped. A null here is what
  // makes applyUpdate refuse instead of installing an unverified payload.
  assert.equal(expectedChecksumFor(SUMS, 'curlapi-0.4.0-app.zip'), null);
  // A suffix match would wrongly accept the .tar.gz hash for a .zip request.
  assert.equal(expectedChecksumFor(SUMS, 'app.zip'), null);
  assert.equal(expectedChecksumFor('', 'curlapi-0.3.0-app.zip'), null);
});

// --- zip ------------------------------------------------------------------

/**
 * Builds a zip in memory.
 *
 * Written out by hand rather than shelled out to `zip`, so the tests exercise
 * the reader against archives with exactly the shape each case needs — including
 * ones no archiver would willingly produce.
 */
function makeZip(
  entries: Array<{ name: string; body?: string; mode?: number; claimSize?: number }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const isDirectory = entry.name.endsWith('/');
    const raw = Buffer.from(entry.body ?? '', 'utf8');
    const compressed = isDirectory ? Buffer.alloc(0) : deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(isDirectory ? 0 : 8, 8); // stored / deflated
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(isDirectory ? 0 : 8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.claimSize ?? raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // Unix mode lives in the top 16 bits of the external attributes.
    central.writeUInt32LE((entry.mode ?? 0o644) << 16, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, end]);
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'curlapi-update-'));
}

test('unpacks an archive to disk', () => {
  const dir = scratch();
  try {
    const zip = makeZip([
      { name: 'src/', body: '' },
      { name: 'src/cli.ts', body: 'console.log("hi")' },
      { name: 'package.json', body: '{"version":"9.9.9"}' },
    ]);

    const result = extractZip(zip, dir);

    assert.equal(result.files, 2);
    assert.deepEqual(result.rejected, []);
    assert.equal(readFileSync(join(dir, 'src', 'cli.ts'), 'utf8'), 'console.log("hi")');
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"version":"9.9.9"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to write outside the destination', () => {
  const dir = scratch();
  try {
    // The payload arrives over the network, so a traversal attempt is the case
    // this reader exists to survive rather than a hypothetical.
    const zip = makeZip([
      { name: '../escaped.txt', body: 'nope' },
      { name: 'src/../../also-escaped.txt', body: 'nope' },
      { name: '/absolute.txt', body: 'nope' },
      { name: 'kept.txt', body: 'yes' },
    ]);

    const result = extractZip(zip, dir);

    assert.equal(result.files, 1);
    assert.equal(result.rejected.length, 3);
    assert.equal(existsSync(join(dir, 'kept.txt')), true);
    assert.equal(existsSync(join(dir, '..', 'escaped.txt')), false);
    assert.equal(existsSync(join(dir, '..', '..', 'also-escaped.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path that merely looks like an escape is still allowed', () => {
  const dir = scratch();
  try {
    // `..` inside a name that resolves back inside is fine, and rejecting it
    // would be a reader that cannot unpack its own archives.
    const zip = makeZip([{ name: 'src/nested/../cli.ts', body: 'ok' }]);
    const result = extractZip(zip, dir);

    assert.deepEqual(result.rejected, []);
    assert.equal(readFileSync(join(dir, 'src', 'cli.ts'), 'utf8'), 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('carries the executable bit across', { skip: process.platform === 'win32' }, () => {
  const dir = scratch();
  try {
    // Losing this silently breaks `curlapi` for anyone who installed via npm,
    // because bin/curlapi.js stops being runnable after an update.
    const zip = makeZip([{ name: 'bin/curlapi.js', body: '#!/usr/bin/env node', mode: 0o755 }]);
    extractZip(zip, dir);

    assert.equal(statSync(join(dir, 'bin', 'curlapi.js')).mode & 0o111, 0o111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an archive whose contents do not match its own sizes', () => {
  const dir = scratch();
  try {
    // The archive says this entry unpacks to 999 bytes; it does not. A reader
    // that trusted the stream alone would install a truncated file and report
    // success.
    const zip = makeZip([{ name: 'a.txt', body: 'hello', claimSize: 999 }]);

    assert.throws(() => extractZip(zip, dir), /unpacked to 5 bytes, expected 999/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects something that is not a zip at all', () => {
  const dir = scratch();
  try {
    assert.throws(
      () => extractZip(Buffer.from('this is an error page, not an archive'), dir),
      /Not a zip archive/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recognises a curlapi payload, and declines anything else', () => {
  const real = makeZip([
    { name: 'src/cli.ts', body: '' },
    { name: 'package.json', body: '{}' },
  ]);
  const other = makeZip([{ name: 'README.md', body: '' }]);

  assert.equal(looksLikeCurlapiPayload(real), true);
  assert.equal(looksLikeCurlapiPayload(other), false);
  assert.deepEqual(zipEntryNames(other), ['README.md']);
});
