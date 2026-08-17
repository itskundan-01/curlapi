# Design notes

Why curlapi behaves the way it does. The [README](README.md) covers what it does;
this covers the decisions behind it.

- [One shell, many utilities](#one-shell-many-utilities)
- [Reading a document nobody wrote for a parser](#reading-a-document-nobody-wrote-for-a-parser)
- [Retention: the document is the artefact](#retention-the-document-is-the-artefact)
- [What gets kept at capture time](#what-gets-kept-at-capture-time)
- [Fidelity](#fidelity)
- [Replay](#replay)
- [Why this cannot be hosted](#why-this-cannot-be-hosted)

## One shell, many utilities

**The process used to be the capture.**

`curlapi start <url>` launched Chrome on the way up and tore it down on Ctrl-C.
That made the tool's lifecycle and one capture's lifecycle the same object, with
two consequences: you could not open curlapi without committing to a capture, and
a second capture meant a second run of the process.

It also left nowhere to put a second utility. A document importer has no browser
to launch and no session to record, so it could not be bolted onto a process
shaped entirely around one.

So the process now boots a **shell** that owns only what every utility shares —
the port, the SQLite database, the static UI, and the one WebSocket the page
already holds open — and each utility is an **app** that starts its own work when
the user asks for it:

```
src/platform/      the contract, the registry, the server
src/apps/
  curl-extractor/  manifest · controller (Chrome, CDP, recorder) · routes
  doc-runner/      manifest · (parser pending a real document)
```

An app is three things: a manifest the dashboard renders without loading any of
the app's code, routes mounted under `/api/apps/<id>`, and a `dispose` that
releases whatever it started. Adding one is a module plus a line in
`src/platform/registry.ts`.

### The browser is asked for, not assumed

Lifting Chrome's lifecycle into `CaptureController` is what lets the app ask
**where to point it** before it exists. The order inside `start()` is
load-bearing and unchanged — session → browser → CDP → recorder → navigate —
because a page handed to Chrome at launch starts fetching before Network is
enabled on its target, and its first requests are lost.

Two things fall out of the browser outliving no longer being tied to the process:

- **Stop is a button.** Ending a capture finalises, prunes and closes Chrome
  without closing the workspace, so the next capture is a click rather than
  another run.
- **Quitting Chrome by hand ends the capture.** The CDP connection reports its
  own close, and the controller treats that as a stop. Otherwise the dashboard
  would go on reporting *Recording* against a browser that is not there, and the
  session would never be finalised.

### Why status is pushed, not polled

Unchanged in reason and stronger in effect. The review UI is normally open in the
very browser being recorded, so a polling loop would be a request every few
seconds in the list it exists to display. With more than one app on the page
that argument only compounds, so the socket is opened once by the shell and
frames are routed to apps by an `app` field.

## Reading a document nobody wrote for a parser

**The layout varies inside one file, so the format is not the hard part.**

Five real handed-over documents produced four different layouts, and one file
used two of them. So the pipeline separates the two axes: **readers** flatten a
format into a block model (paragraphs with a style hint, tables as rows of
cells), and **extractors** read layouts out of that model. A new format is a
reader; a new layout is an extractor; neither is both.

Extractors all run, and their results are merged afterwards, rather than one
layout being detected up front. A document with a spec table for most endpoints
and a pasted curl for the one somebody added later needs both, and detection
would have to pick.

### Merging is where the reading gets better than any one extractor

Two readings of the same endpoint — matched on method, host, path and query
*keys*, not query values — are combined rather than deduplicated. The more
confident one wins the scalar fields; the other fills its gaps. In practice a
curl paste carries the auth header a table omitted, and the table carries the
documented response the paste had no room for.

Headers merge **by name**, not by pair: two readings disagreeing about
`Content-Type` means one mis-parsed, and emitting both produces a request whose
duplicate header the server resolves arbitrarily.

### What the word processor did to the text

Every substitution in `normalize.ts` was observed breaking a real file:

- Autocorrect turns `'` into `‘ ’`, so a pasted `curl --header 'Api-Key: …'`
  arrives with quotes no shell accepts. Worse, a body written `"brandNo”: "1"`
  fails `JSON.parse` on the *closing* quote of a key.
- `--data` becomes `–data`, or loses its dashes entirely — one sample's curl
  commands are literally `header '…'` and `data '{`. Flags are therefore matched
  with an optional `--`.
- Non-breaking spaces survive `.trim()`, so a URL looks clean and still fails to
  parse.

The command is also split across paragraphs with the shell's backslash
continuations gone, and annotated mid-command with a `Request Parameter:` label.
Treating that label as the end of the command loses the body — and a documented
POST silently becomes a GET, because curl infers the method from whether a body
is present.

### A curl command claims its own lines

A document exported from a browser is nothing but headings and full curl
commands, and it broke the reader badly: twenty-three commands came back as
twenty-six endpoints, sharing two names between them, with POSTs listed as GETs.

Three causes, all worth stating because each is a trap the next extractor will
fall into too:

- **`-H 'origin: https://site'` is a bare URL on a line.** So is its `referer`
  twin. To a line-by-line extractor those are endpoints, and one document
  produced sixteen phantoms from them. Curl extraction now runs first and its
  blocks are claimed exclusively; nothing else reads inside them.
- **Hand-marked headings are not headings.** `# 1. userrecentservice — POST 200`
  fails a conservative "short line of mostly letters" test — one has a colon,
  another is mostly punctuation. An endpoint with no heading of its own then
  silently inherits the last one that *was* recognised, which is how three
  commands ended up sharing a name. `#`-prefixed and numbered lines are now
  headings outright, and the marker, the numbering and the trailing method and
  status are stripped from the name.
- **A phantom endpoint has no method**, so it defaults to GET. The wrong methods
  were a symptom of the first bug, not a separate one.

### Two payloads to one route are two test cases

Identity for merging includes the body — compared by value, so key order and
whitespace do not split one endpoint in two. A reading with *no* body still folds
into one that has it, because a spec table that omitted the payload and a curl
paste that carries it describe the same endpoint. Two different payloads stay
apart, and the second gets a numbered name.

### Evidence beats declaration

These documents put request-field and response-field tables in the same shape,
one after the other, and neither says which it is. So a field is placed by
**membership in the payloads**: a name that appears in the request body is a body
field, one that appears in the documented response is a response field. A reader
shown `publicKey` as something to send would be badly misled.

The same principle rejects things that merely look like endpoints. A
response-code table has two columns and consistent labels; a staging sign-in
block has a URL, a login id and a password. Both would otherwise become requests.

### Refusing to run is a feature

A request whose URL still contains `{bookingId}` is refused rather than sent. The
404 it would return reads as a broken endpoint, and is not — so the placeholder
is named instead. Credentials and path placeholders become **shared values**
filled in once, which is also what lets the Postman export lift a department's
live API key into a collection variable. A collection with the key baked into
thirty requests cannot be sent to anyone, which is the only reason to export one.

### The document belongs next to the request, not behind a tab

The endpoint list is on the left and the selected endpoint fills the rest as two
panes: the editable request, and what the document said. Both questions a reader
has are one-glance questions — *what do I put in this field* is answered by the
field table, and *did that run go right* by the documented response — and a tab
turns each into a click and a memory test.

Edits are stored as **overrides**, separately from the parsed reading. "What the
document said" and "what I changed it to" are different questions, Reset depends
on both being kept, and a mis-parse is far easier to spot when the original is
still there to compare against.

### The command is the primary view, not a tab

cURL opens first. It is the only view that holds the whole request at once — URL,
every header, the body — which is how anyone checks whether the document was
understood at all. A tabbed editor shows a third of it at a time and makes that
check three clicks.

Each line is a button into the tab that owns it, with the clicked header row
focused on arrival. Spotting something wrong and fixing it is then one gesture
rather than a hunt for which tab the value lives under.

The response panel renders nothing until there is a response. An earlier version
reserved a tall region under every request, which reads as a broken panel rather
than as an answer that has not arrived yet.

### The shell is the reader's, not the server's

A POSIX-quoted command pasted into PowerShell fails in a way that looks like the
endpoint is broken. The default is therefore taken from the browser's platform
rather than from `process.platform`: the workspace runs on one machine and is
read from whichever machine opened it, and those need not agree.

### A flex item shrinks to fit, which is never what a list wants

The first version of this screen laid the endpoint list out as a flex column. Its
children took the default `flex-shrink: 1`, so instead of overflowing the
container and scrolling, they were **compressed to fit it** — content was
silently cut off and nothing moved. Two rules follow, and both are load-bearing
elsewhere in the UI:

- Any flex child holding content sets `flex-shrink: 0`.
- Only one element in a chain scrolls. The shell body is `overflow: hidden` and
  each screen owns its own scrolling: a scroll container wrapping another gives
  the inner one an unbounded height to resolve against, so its `overflow: auto`
  never engages.

### Reuse, not reimplementation

Running an endpoint and copying it as curl are the capture side's `replay` and
`buildCurl`, reached by presenting a parsed endpoint as a `RequestRecord`.
Neither was ever specific to captures, and a second implementation of curl's
shell escaping is not something to own twice. The documented response goes into
that record's `responseBody`, so `replay`'s existing shape comparison answers
"does this match what the document claimed" for free.

## Retention: the document is the artefact

**The capture is scaffolding.**

A capture is hundreds of requests with response bodies, of which a handful matter.
Keeping every session forever buries the ones that do and grows the database
without limit — a few sessions of ordinary browsing is already 13 MB.

So when a capture ends, everything you **didn't** select is discarded. What
survives is what you deliberately picked:

- anything **added to a document**
- anything **approved into the collection** — the same act of selection, one step
  earlier

A session where you picked nothing isn't kept at all. Old sessions are pruned the
next time a capture starts, so history cannot accumulate in the background.

```bash
curlapi prune              # apply the same rule now, without capturing
curlapi start --keep       # keep the whole capture instead
```

On a real 15-session database this took **13,123 KB down to 73 KB** and 15
sessions down to 3, keeping every documented and approved endpoint.

### Documents are self-contained

Adding a request to a document copies the **entire captured request** into it —
headers, bodies, timings — not just the command text. So after the capture behind
it is gone, a document entry still:

- rebuilds its curl under any option, including **Redact secrets** and
  **Copy one-line**
- opens in the detail view with full headers and flow analysis
- **runs**, straight from the document

Verified end to end: with every request row deleted, a documented endpoint still
resolved 17 headers, rendered a 15-line curl, and replayed 200.

Everything persists to SQLite at `~/.curlapi/curlapi.db` as it happens, so
stopping the server never loses what you kept. Sessions that survive are reachable
from the session picker in the header; recording carries on into the live session
while you look at an older one.

### Confirmation without dialogs

Destructive buttons confirm in place rather than in a modal: the first click
relabels the button (*Clear 137?*), the second acts, and Escape, a click elsewhere
or five seconds of hesitation cancels it. A modal for a two-click decision would
steal focus in the middle of a list you are working through.

## What gets kept at capture time

`XHR`, `Fetch`, `WebSocket` and `EventSource` always survive. Images, fonts,
stylesheets, media, script bundles and page navigations are dropped, as are known
telemetry and CDN domains (GA, GTM, Segment, Sentry, Mixpanel, Hotjar, Datadog,
the browser's own service traffic…). Anything undecided waits for its content
type.

CORS preflights (`OPTIONS`) and script payloads are dropped even when they arrive
as `Fetch` — a bundler-loaded chunk is still a script, and a preflight is
generated by the browser rather than written by you.

### Ignored is not the same as dropped

A **dropped** request is real traffic from the site that we chose not to surface:
it is recorded, keeps its serial number, and appears under *Show filtered-out* so
the filter stays auditable.

An **ignored** request was never the site's — this tool's own UI talking to its
own server, a `data:` URI, a browser extension — so no record is created at all.
Recording those would burn serial numbers and bury the site's real requests under
a stream of noise about ourselves.

For the same reason the review UI **never polls**: status is pushed over the
WebSocket it already holds open, so leaving the page open in the monitored browser
generates no traffic whatsoever.

### Two deliberate choices

- **A different domain is not a reason to drop something.** Private APIs commonly
  live on a separate registrable domain from the page — `app.acme.co.uk` calls
  `gateway.acme-api.net`. A first-party-only rule would throw away the payload.
- **Every dropped request records why.** A filter you cannot audit stops being
  trusted the first time something you expected goes missing.

Edit `~/.curlapi/filters.json` (run `curlapi config` to create it) to change any of
this, or add `allowDomains` entries that beat every drop rule.

## Fidelity

Generated commands reproduce Chrome's own **Copy as cURL** byte for byte — there
is a golden test asserting exactly that against a captured request.

Two details make the difference between a command that runs and one that 401s.

**Headers come from two CDP events, merged.** `Network.requestWillBeSent` fires
while the request is still being assembled, so it is missing cookies and several
`sec-*` values the network stack appends afterwards. The authoritative set arrives
separately in `requestWillBeSentExtraInfo`. DevTools merges them internally; tools
that read only the first event produce curl commands that look complete and then
fail.

**Only curl-managed headers are omitted** — `host`, `connection`,
`content-length`, `accept-encoding`, `transfer-encoding`, `expect` and HTTP/2
pseudo-headers. Everything else is emitted verbatim, including `sec-ch-ua`,
`priority` and custom headers like `x-api-key`, `request-id` or `timestamp`, which
are frequently load-bearing for signature or replay checks.

Credentials are emitted as captured, because a command with `{{token}}` in it does
not run. `--redact` swaps them for placeholders and lifts them into Postman
variables when you are sharing a collection instead of using one.

### Pasting into a terminal

Long multi-line commands are easy for a shell to mangle — one lost first line and
zsh sits at a `>` continuation prompt doing nothing. **Copy one-line** in the
detail panel produces a single-line command that pastes reliably.

## Replay

Execution is in-process over undici's connection pool rather than shelling out to
the curl binary: there is no process to fork per run, and sockets are reused
across repeated runs of the same endpoint. The response is read as a stream and
cancelled once it passes the preview cap, so a large body costs neither the memory
to buffer it nor the bandwidth to finish downloading it.

Redirects are not followed and nothing is retried, because the generated curl has
no `-L` either.

If an endpoint sends a nonce or timestamp header, replay may legitimately fail
where the browser succeeded. That is a property of the API worth knowing about
before you build a wrapper on it, so it is surfaced rather than hidden.

### Token lifetimes are the usual cause of a dead command

The browser refreshes credentials continuously; a captured snapshot cannot. So
curlapi decodes any JWT it finds in the headers and shows the real shelf life next
to the command, and when a run comes back 401 it names the token that expired and
by how long, rather than guessing at "credentials may have expired".

This matters for the wrapper you are building: it means the wrapper has to **mint**
these tokens, not replay captured ones.

## Why this cannot be hosted

**This has to run locally on the user's machine**, and that isn't a scaling
decision — it's structural:

- The tool drives *your* browser over the DevTools protocol. A server has no
  browser to attach to, and cannot reach yours.
- The whole point is capturing traffic from a **logged-in** session. That means
  live cookies, bearer tokens and whatever personal data the session carries.
  Sending those to a server would make whoever runs it the custodian of other
  people's credentials — a data-protection obligation acquired in exchange for
  nothing the user wanted.
- Locally it binds to `127.0.0.1` only, so it needs no accounts, no TLS, no
  authentication and no infrastructure. A hosted version needs all four before it
  is even safe to turn on.

So the shape to ship is a **local CLI**. Three things make that work on macOS,
Windows and Linux alike:

- **No build step and no native modules.** Node 24 runs the TypeScript directly
  and ships SQLite in the standard library, so there is nothing to compile per
  platform — the usual reason a tool like this fails on someone else's machine.
- **`bin/curlapi.js` is plain JavaScript.** It checks the Node version and prints
  an actionable message before the TypeScript entry point is imported. On an old
  Node the alternative is `Unknown file extension ".ts"`, which tells nobody
  anything.
- **Browser discovery per platform** — Chrome, Chromium, Edge and Brave at the
  standard install locations on each OS, `which`/`where` on Linux, and
  `CURLAPI_CHROME` to point at anything unusual.

If a team ever needs to *share* results, share the artefacts — the Postman
collection, `api-notes.md`, `session.json` — not the capture service. Turn on
**Redact secrets** first; without it those files carry live credentials.
