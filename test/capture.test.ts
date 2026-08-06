import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHeaders } from '../src/capture/recorder.ts';
import { shortName, disambiguate } from '../src/analyze/shortname.ts';
import { shapesMatch, inferShape, signature } from '../src/analyze/schema.ts';

test('extraInfo headers win over the earlier partial set', () => {
  // requestWillBeSent fires before cookies and some sec-* headers are attached;
  // requestWillBeSentExtraInfo carries what actually went on the wire.
  const fromRequest: Array<[string, string]> = [
    ['accept', 'application/json'],
    ['user-agent', 'Chrome'],
  ];
  const fromExtraInfo: Array<[string, string]> = [
    ['accept', 'application/json'],
    ['user-agent', 'Chrome'],
    ['cookie', 'session=abc123'],
    ['sec-fetch-site', 'cross-site'],
  ];

  const merged = mergeHeaders(fromRequest, fromExtraInfo);
  const names = merged.map(([name]) => name);
  assert.ok(names.includes('cookie'), 'cookie must survive the merge');
  assert.ok(names.includes('sec-fetch-site'));
  assert.equal(names.filter((name) => name === 'accept').length, 1, 'no duplicates');
});

test('falls back to the partial set when extraInfo never arrives', () => {
  const fromRequest: Array<[string, string]> = [['accept', '*/*']];
  assert.deepEqual(mergeHeaders(fromRequest, null), fromRequest);
  assert.deepEqual(mergeHeaders(fromRequest, []), fromRequest);
});

test('keeps headers the extraInfo view omitted', () => {
  const merged = mergeHeaders(
    [['x-custom', 'kept']],
    [['cookie', 'a=1']],
  );
  assert.deepEqual(merged, [
    ['cookie', 'a=1'],
    ['x-custom', 'kept'],
  ]);
});

test('short name matches the Chrome network tab', () => {
  assert.equal(shortName('https://gateway.acme-api.net/AccountV3Api/prod/profile/enrollment/verify'), 'verify');
  assert.equal(shortName('https://example.com/api/users?page=2'), 'users?page=2');
  assert.equal(shortName('https://example.com/'), 'example.com');
});

test('falls back to the host when paths are identical', () => {
  // Five health probes on one path across five servers: no amount of path
  // widening separates them, so the host has to.
  const names = disambiguate([
    'https://t5-eu-1.algolia.net/1/isalive?probe=1',
    'https://c3-de-1.algolia.net/1/isalive?probe=1',
    'https://t32-usw-1.algolia.net/1/isalive?probe=1',
  ]);
  assert.equal(new Set(names).size, 3, 'every name is distinct');
  assert.ok(names.some((name) => name.includes('t5-eu-1.algolia.net')));
  // A prefix that separates nothing must not be bolted on.
  assert.ok(!names.some((name) => name.startsWith('1/')), `got ${names.join(', ')}`);
});

test('repeated calls to one endpoint keep one name', () => {
  // Same URL twice is the same endpoint; the serial numbers distinguish them.
  const names = disambiguate([
    'https://api.example.com/v1/poll',
    'https://api.example.com/v1/poll',
  ]);
  assert.deepEqual(names, ['poll', 'poll']);
});

test('widens colliding names with their parent segment', () => {
  const names = disambiguate([
    'https://api.example.com/auth/login/verify',
    'https://api.example.com/phr/enrollment/verify',
    'https://api.example.com/profile',
  ]);
  assert.equal(names[2], 'profile');
  assert.notEqual(names[0], names[1]);
  assert.ok(names[0].includes('login'));
  assert.ok(names[1].includes('enrollment'));
});

test('response shapes compare structurally, not by value', () => {
  const a = JSON.stringify({ id: 1, name: 'a', tags: ['x'] });
  const b = JSON.stringify({ id: 99, name: 'zzz', tags: ['y', 'z'] });
  assert.equal(shapesMatch(a, b), true);

  const different = JSON.stringify({ id: 1, name: 'a' });
  assert.equal(shapesMatch(a, different), false);

  // Not comparable rather than "mismatched" when either side is not JSON.
  assert.equal(shapesMatch(a, '<html></html>'), null);
  assert.equal(shapesMatch(null, b), null);
});

test('shape signatures ignore key order', () => {
  const left = signature(inferShape({ b: 1, a: 'x' }));
  const right = signature(inferShape({ a: 'y', b: 2 }));
  assert.equal(left, right);
});
