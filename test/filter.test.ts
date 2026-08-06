import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, registrableDomain } from '../src/filter/verdict.ts';
import { DEFAULT_CONFIG } from '../src/filter/rules.ts';

const PAGE_HOST = 'app.acme.co.uk';

function check(
  url: string,
  overrides: { method?: string; resourceType?: string; mimeType?: string } = {},
) {
  return evaluate(
    {
      url,
      method: overrides.method ?? 'GET',
      resourceType: overrides.resourceType ?? 'Other',
      primaryHost: PAGE_HOST,
      mimeType: overrides.mimeType,
    },
    DEFAULT_CONFIG,
  );
}

test('keeps the API call even though it is on a different registrable domain', () => {
  // This is the shape of the real case: the page is app.acme.co.uk but the API
  // lives on gateway.acme-api.net. A first-party-only rule would throw it away.
  assert.notEqual(registrableDomain('app.acme.co.uk'), registrableDomain('gateway.acme-api.net'));

  const verdict = check('https://gateway.acme-api.net/AccountV3Api/prod/profile/enrollment/verify', {
    method: 'POST',
    resourceType: 'Fetch',
  });
  assert.equal(verdict.keep, true);
});

test('treats multi-part public suffixes as one registrable domain', () => {
  assert.equal(registrableDomain('app.acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain('gateway.acme-api.net'), 'acme-api.net');
  assert.equal(registrableDomain('api.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('drops static assets by type and by extension', () => {
  assert.equal(check('https://app.acme.co.uk/logo.png', { resourceType: 'Image' }).keep, false);
  assert.equal(check('https://app.acme.co.uk/app.css').keep, false);
  assert.equal(check('https://app.acme.co.uk/font.woff2').keep, false);
  assert.equal(check('https://app.acme.co.uk/main.js.map').keep, false);
});

test('drops telemetry by exact domain, not by substring', () => {
  assert.equal(check('https://www.google-analytics.com/collect').keep, false);
  assert.equal(check('https://o1234.ingest.sentry.io/api/1/envelope/').keep, false);

  // A substring match would wrongly kill this one.
  const lookalike = check('https://api.sentry-clone.example.com/v1/data', {
    resourceType: 'Fetch',
  });
  assert.equal(lookalike.keep, true);
});

test('always explains itself', () => {
  for (const verdict of [
    check('https://app.acme.co.uk/logo.png', { resourceType: 'Image' }),
    check('https://gateway.acme-api.net/api/v1/thing', { resourceType: 'Fetch' }),
    check('https://www.googletagmanager.com/gtm.js'),
  ]) {
    assert.ok(verdict.reason.length > 0, 'every verdict carries a reason');
  }
});

test('holds judgement until the content type is known', () => {
  const pending = check('https://cdn.example.com/data-endpoint');
  assert.equal(pending.stage, 'maybe');

  const asJson = check('https://cdn.example.com/data-endpoint', {
    mimeType: 'application/json',
  });
  assert.equal(asJson.keep, true);

  const asHtml = check('https://cdn.example.com/data-endpoint', { mimeType: 'text/html' });
  assert.equal(asHtml.keep, false);
});

test('keeps form posts but not plain navigations', () => {
  assert.equal(check('https://app.acme.co.uk/login', { resourceType: 'Document' }).keep, false);
  assert.equal(
    check('https://app.acme.co.uk/login', { resourceType: 'Document', method: 'POST' }).keep,
    true,
  );
});

test('keeps failing API calls — validation errors document the API', () => {
  // Status plays no part in the verdict, so a 400 survives exactly like a 200.
  const verdict = check('https://gateway.acme-api.net/api/v1/verify', {
    resourceType: 'Fetch',
    method: 'POST',
  });
  assert.equal(verdict.keep, true);
});

test('ignores non-network schemes outright rather than merely dropping them', () => {
  // `ignore` means no record is created at all. These are not the site's traffic,
  // so recording them would burn serial numbers and clutter the noise view.
  for (const url of ['data:image/png;base64,iVBOR', 'chrome-extension://abcdef/script.js']) {
    const verdict = check(url);
    assert.equal(verdict.keep, false);
    assert.equal(verdict.stage, 'ignore', `${url} should be ignored, not dropped`);
  }
});

test('site noise is dropped, not ignored, so it stays auditable', () => {
  // The distinction matters: these are real requests the site made, and the user
  // must be able to see them under "show filtered-out" to trust the filter.
  for (const verdict of [
    check('https://app.acme.co.uk/logo.png', { resourceType: 'Image' }),
    check('https://www.google-analytics.com/collect'),
    check('https://app.acme.co.uk/app.css'),
  ]) {
    assert.equal(verdict.keep, false);
    assert.equal(verdict.stage, 'drop');
  }
});

test('drops CORS preflights', () => {
  // Browser-generated and never hand-written, so they are not part of an API
  // wrapper even though they are XHR-shaped.
  const verdict = check('https://gateway.acme.co.uk/important-update?mode=web', {
    method: 'OPTIONS',
    resourceType: 'Other',
  });
  assert.equal(verdict.keep, false);
  assert.match(verdict.reason, /preflight/i);
});

test('drops script payloads fetched through fetch() rather than a script tag', () => {
  // Bundler-loaded chunks arrive as resourceType Fetch, so the type rule alone
  // misses them and the extension has to catch it.
  const verdict = check('https://app.acme.co.uk/assets/service_auth.min.js', {
    resourceType: 'Fetch',
  });
  assert.equal(verdict.keep, false);
});
