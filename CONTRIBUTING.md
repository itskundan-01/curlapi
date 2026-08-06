# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

```bash
git clone https://github.com/itskundan-01/curlapi.git
cd curlapi
npm install
npm run build:ui
```

Requires Node 24 or newer, and Chrome, Chromium, Edge or Brave installed. There is
no build step for the tool itself — Node runs the TypeScript directly.

## Before opening a pull request

```bash
npm run typecheck
npm test
```

Both must pass. The test suite includes an end-to-end capture that drives headless
Chrome against a local site, so it needs a browser present.

## Never commit real credentials

This tool captures live sessions, so it is unusually easy to paste a real token
into a test fixture. Don't.

Fixtures use **synthetic** credentials that keep the *shape* of the real thing —
an RS256 JWT with a `kid`, a 40-character key, a long base64 blob containing `+`,
`/` and `=` — because that shape is what the escaping, ordering and redaction
assertions exercise. Nothing depends on the contents.

They are also **self-identifying**: the values read `NOT-A-REAL-SIGNATURE`,
`EXAMPLE000NOTAREALKEY000TESTFIXTURE00000` and so on. Please keep new fixtures
that way. Realistic-looking placeholders trip secret scanners, and a repository
about captured credentials cannot afford alerts that are routinely false —
`.gitguardian.yaml` excludes the fixture files so that a finding here means
something.

If you notice a real secret in the repository or its history, please report it
privately rather than opening a public issue.

## Conventions

- Comments explain **why**, not what. Most of the tricky code here exists because
  of a specific browser or protocol behaviour — say which one.
- Tests assert observable behaviour, and their names read as statements about the
  tool ("a promised extra info that never arrives does not hang the capture").
- Filter changes need a test in `test/filter.test.ts` showing both what is now
  kept and what is still dropped.

## Reporting a bug

Include your OS, `node --version`, your browser and version, and what the review
UI showed. If a request was filtered when it shouldn't have been, the reason under
*Show filtered-out* is the most useful thing you can paste — but redact any
credentials first.
