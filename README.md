# curlapi

**Capture a browser session's real API calls, drop the noise, and turn what's left into working curl commands.**

[![CI](https://github.com/itskundan-01/curlapi/actions/workflows/ci.yml/badge.svg)](https://github.com/itskundan-01/curlapi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Built for reverse-engineering a private API so you can write a wrapper around it:
use the site normally, see exactly which endpoints it hit, and get a command you
can paste into Postman — or run right there to check it still works.

```
Browse the site  ──▶  curlapi records only the API calls  ──▶  tick the ones you want
                                                                      │
        curls.sh · Postman · Markdown notes  ◀──  runnable curl, named and numbered
```

---

> **New here?** [**SOP.md**](SOP.md) is a step-by-step walkthrough — setup, your
> first capture, and the day-to-day loop. Start there.

## Contents

- [Why not just export a HAR](#why-not-just-export-a-har)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [The review UI](#the-review-ui)
- [What it tells you that DevTools doesn't](#what-it-tells-you-that-devtools-doesnt)
- [Exports](#exports)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)
- [Development](#development)
- [Design notes](#design-notes)
- [License](#license)

---

## Why not just export a HAR

A HAR embeds a response body for every request, including images, JS bundles and
source maps, which is how one page refresh becomes 22 MB. Of the 200–400 requests
a modern SPA fires, maybe 10–20 are real API calls, and DevTools gives you no way
to tell which of them belonged to the button you just clicked. Then it's
right-click → Copy as cURL, one at a time.

curlapi filters at capture time — a response body that is never fetched costs
nothing — so a session that produced a 22 MB HAR lands well under 1 MB.

## Requirements

| | |
|---|---|
| **Node** | 24 or newer — it runs the TypeScript directly and ships SQLite in the standard library |
| **Browser** | Chrome, Chromium, Edge or Brave, at a standard install location |
| **OS** | macOS, Windows or Linux |

There is **no build step for the tool itself and no native modules**, so there is
nothing to compile per platform. If your browser lives somewhere unusual, point at
it with `CURLAPI_CHROME=/path/to/browser`.

## Install

```bash
git clone https://github.com/itskundan-01/curlapi.git
cd curlapi
npm install
npm run build:ui
```

That's the whole install. `npm run build:ui` compiles the review UI into
`ui/dist/`; it is the one build step, and it only has to run once.

To get a `curlapi` command on your PATH instead of typing `node src/cli.ts`:

```bash
npm link
```

## Quick start

```bash
node src/cli.ts start https://example.com
# or, after `npm link`:
curlapi start https://example.com
```

Chrome opens. **Log in and use the site exactly as you normally would**; the review
UI at <http://127.0.0.1:7317> fills in live. Tick the requests worth keeping,
switch to **Collection**, and you get them numbered, named, with the full curl and
a **Run** button. Press Ctrl-C when finished — the session is saved.

Everything lives under `~/.curlapi`.

For the same thing broken into numbered steps, with the UI actions spelled out,
see [SOP.md](SOP.md).

## Commands

```
curlapi start [url]          Launch the browser, capture, and open the review UI
curlapi attach [--port N]    Attach to a browser you started yourself
curlapi ui [--session ID]    Review a stored session without capturing
curlapi ls                   List stored sessions
curlapi prune                Discard captures nobody documented or approved
curlapi export <format>      script | postman | json | doc
curlapi config               Write the default filter rules so you can edit them
```

| Option | Effect |
|---|---|
| `--port N` | DevTools port for `attach` (default 9222) |
| `--ui-port N` | Port for the review UI (default 7317) |
| `--session ID` | Target a specific session instead of the most recent |
| `--resume` | Continue the previous capture rather than starting a new one |
| `--keep` | Keep the whole capture instead of only what you selected |
| `--label TEXT` | Name the capture session |
| `--out PATH` | Where to write the export |
| `--clean` | Strip `sec-*` / `priority` headers from generated curl |
| `--redact` | Replace credentials with `{{placeholders}}` |
| `--shell SHELL` | `posix` (default) or `powershell` |
| `--headless` | Run the browser without a window |

## The review UI

Three tabs, at `http://127.0.0.1:7317`.

**Live** — the capture as it happens, newest first. Tick rows to select them;
shift-click takes a range, and the header checkbox takes everything shown.
Clicking a row opens a detail panel with full headers, flow analysis and its own
**Run**. **Clear** empties the list and restarts numbering at #1. Failures are
impossible to miss: 4xx, 5xx and network errors get a red status pill, a red name
and a red edge marker, and the **n failed** chip filters to exactly those.

**Collection** — your selected endpoints, numbered, each with the full command, a
copy button and Run.

**Doc** — the notepad, holding **as many documents as you want**, because one
session usually covers several unrelated flows (login, profile, payments). Each
document numbers from 1 independently. Entries carry an editable name, the curl
with one-click copy, and a free-text box for what the endpoint actually does.
**Copy all** puts every command in the open document on the clipboard, numbered
and commented, so the whole block pastes into a shell and runs.

Adding a request to a document copies the **entire captured request** into it, so
a document entry still rebuilds its curl, opens in the detail view and **runs**
long after the capture behind it is gone.

## What it tells you that DevTools doesn't

### Byte-for-byte fidelity

Generated commands reproduce Chrome's own **Copy as cURL** exactly — there is a
golden test asserting it. The detail that makes the difference between a command
that runs and one that 401s: headers are merged from **two** CDP events, because
`Network.requestWillBeSent` fires before cookies and several `sec-*` values are
appended. Tools that read only the first event produce curl commands that look
complete and then fail. See [DESIGN.md](DESIGN.md#fidelity).

### Token shelf life

A captured command for an authenticated endpoint stops working, usually much
sooner than people expect:

| header | lives |
|---|---|
| `authorization` (gateway) | 6 hours |
| `x-token` (session) | 30 minutes |
| `t-token` (transaction) | 5 minutes |

curlapi decodes any JWT in the headers and shows the real shelf life next to the
command — *"t-token expires in 4 min"* — and when a run comes back 401 it names
the token that expired and by how long. If every token is still valid it says so
too, which points at a nonce, an IP check or a one-time transaction id instead.

### One-time requests, and where values come from

Some requests cannot be replayed at all, no matter how fresh the credentials. An
OTP verification submits a one-time code scoped to a `txnId`; the server consumes
all of it on first use. curlapi recognises that shape and labels the request
**one-time** rather than letting you conclude the capture is broken.

Then it traces values backwards into the responses that produced them:

```
#14 otp        → produces txnId
#20 verify     → consumes txnId, produces token     [one-time]
#26 getProfile → consumes that token as x-token
```

That chain is the flow your wrapper has to perform.

### Run

The Run button replays a request server-side and reports status, timing, size,
and whether the response still has the same shape as the capture. Redirects are
not followed and nothing is retried, because the generated curl has no `-L`
either — showing you a result your command cannot reproduce would be worse than
showing you the failure.

## Exports

```bash
curlapi export script     # curls.sh — serial-numbered, one commented command per endpoint
curlapi export postman    # Postman collection v2.1, captured responses as examples
curlapi export doc        # api-notes.md — your documents, numbered, with your notes
curlapi export json       # session.json — the full record, re-importable
```

Add `--redact` to swap credentials for placeholders (and lift them into Postman
variables) before sharing any of these.

## Troubleshooting

**A page isn't being captured.** Capture can only record traffic from the moment
it attaches. A tab that had *already finished loading* produces almost nothing,
which looks exactly like the tool being broken. curlapi detects this and shows a
banner naming the affected tabs with a **Reload and capture** button.

**The browser isn't found.** Set `CURLAPI_CHROME` to the executable path.

**Why a separate browser profile?** `start` uses a dedicated profile at
`~/.curlapi/chrome-profile`, not your everyday one. This is not a preference:
since Chrome 136, `--remote-debugging-port` is silently ignored on the default
profile, as hardening against local cookie theft. Your logins persist in this
profile between runs, so it only costs you one sign-in.

**Something I expected was filtered out.** Every dropped request records why,
visible under *Show filtered-out*. Run `curlapi config` and edit
`~/.curlapi/filters.json` — `allowDomains` entries beat every drop rule.

**Node is too old.** `curlapi` prints an actionable message rather than
`Unknown file extension ".ts"`. Install Node 24+ from
[nodejs.org](https://nodejs.org) or `nvm install 24`.

## Security and privacy

**Everything stays on your machine.** curlapi binds to `127.0.0.1` only, has no
accounts, no telemetry and no server component. It cannot be a hosted service —
[the reasons are structural](DESIGN.md#why-this-cannot-be-hosted), not a scaling
decision.

Two things to know:

- **Captures contain live credentials.** `~/.curlapi/curlapi.db` holds the cookies
  and bearer tokens from your logged-in session. Treat it like a password store.
- **Exports carry those credentials too**, by default and on purpose — a command
  with `{{token}}` in it does not run. Use `--redact` before sharing an export,
  and share the artefacts rather than the database.

## Development

```bash
npm test          # 73 tests: curl golden file, filter decisions, header merge, end-to-end capture
npm run typecheck # tsc --noEmit
npm run dev:ui    # Vite dev server for the review UI
npm run build:ui  # build ui/dist
```

The end-to-end test drives headless Chrome against a local site and checks both
that the API call is captured completely and that the noise around it is not.

Test fixtures use synthetic credentials that are structurally identical to real
ones. Please keep it that way — never commit a real token, cookie or API key.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Design notes

[DESIGN.md](DESIGN.md) covers the decisions behind the behaviour: what is kept and
what is discarded, why the document outlives the capture, how header fidelity is
achieved, and why this has to run locally.

## License

[MIT](LICENSE) © Kundan
