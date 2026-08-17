# Contributing

Thanks for taking a look. Issues and pull requests are welcome. curlapi is in
**beta**, so reports about things being read or rendered wrongly are especially
useful.

## Getting set up

```bash
git clone https://github.com/itskundan-01/curlapi.git
cd curlapi
npm install
npm run build:ui
```

Requires Node 24 or newer, and Chrome, Chromium, Edge or Brave installed. There is
no build step for the tool itself — Node runs the TypeScript directly.

## How the repository is arranged

```
src/platform/      the app contract, the registry, the shell server
src/apps/
  curl-extractor/  manifest · capture controller · routes
  doc-runner/      manifest · readers · extractors · exporters · routes
src/curl · replay · filter · store · export      shared by both apps
ui/src/shell/      router · dashboard · live socket · theme
ui/src/apps/…      one folder per app
```

A **utility is an app**: a manifest, routes mounted under `/api/apps/<id>`, and a
`dispose` that releases whatever it started. Adding one means writing the module
and adding a line to `src/platform/registry.ts` (and `ui/src/shell/apps.tsx` for
its screen). Nothing in the shell, the CLI or the router needs to change.

Two constraints that are easy to trip over:

- **Never import `src/store/db.ts` for its value from a module the registry
  loads.** The entry point defers it deliberately — a static import pulls in
  `node:sqlite` during module linking and defeats the experimental-warning
  filter. Import the type, and `await import()` the value on first use.
- **An app owns its own tables.** Reusing the capture side's `sessions` and
  `requests` would make two apps' schemas each other's problem.

[DESIGN.md](DESIGN.md) explains why the tricky parts are the way they are.

## Before opening a pull request

```bash
npm run typecheck
npm test
```

Both must pass. The test suite includes an end-to-end capture that drives headless
Chrome against a local site, so it needs a browser present.

### Changing the document parser

`src/apps/doc-runner/extract/` is the part most likely to regress, because it is
built against how real documents are written rather than against a specification.
Any change there needs a fixture in `test/docparse.test.ts` covering **both** what
is now read correctly and what must still not be picked up — the failure mode is
almost always something extra being recognised, not something missing.

The four layouts currently supported are listed in the README under
[Doc → Requests](README.md#doc--requests). If you add a fifth, add it there too.

## Never commit real credentials

This tool captures live sessions *and* imports documents that carry live API
keys, so it is unusually easy to paste a real token into a test fixture. Don't.

Handed-over API documents in particular must not be committed — they routinely
contain working keys and sometimes sign-in details. Keep them out of the
repository (`Doc samples/` is gitignored for exactly this) and write fixtures
that reproduce the document's *layout* with invented hosts and keys, which is
what the parser tests actually exercise.

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

Include your OS, `node --version`, your browser and version, and what the
workspace showed.

**For a capture:** if a request was filtered when it shouldn't have been, the
reason under *Show filtered-out* is the most useful thing you can paste.

**For a document import:** the most useful thing is the document's *shape* — the
headings, and how the requests are laid out under them — plus the endpoint count
you got against the count you expected, and the confidence label shown on a
wrongly-read endpoint. A few representative lines are enough.

Redact any credentials first, and please do not attach the document itself.
