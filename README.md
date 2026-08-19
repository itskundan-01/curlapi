# curlapi

**A local workspace of small API utilities.** Capture a browser session's real
API calls as working curl commands, or turn a handed-over API document into
runnable requests — without either one leaving your machine.

[![CI](https://github.com/itskundan-01/curlapi/actions/workflows/ci.yml/badge.svg)](https://github.com/itskundan-01/curlapi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-beta-b45309)](#beta)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```
                        ┌─ ⚡ cURL Extractor ──┐
 browse a site  ────────▶  only the API calls  ├──▶  run · copy · Postman · notes
                        └──────────────────────┘
                        ┌─ 📄 Doc → Requests ──┐
 drop in a document ────▶  every endpoint in it ├──▶  run · copy · Postman · notes
                        └──────────────────────┘
```

---

> ## Beta
>
> Both utilities work and are in daily use, but the shape of things may still
> change. Two things worth knowing before you rely on it:
>
> - **Check what a document import produced** before you act on it. The parser
>   handles the layouts in [Doc → Requests](#doc--requests) well, but documents
>   are written by people and a new one may be read wrongly. Every endpoint shows
>   which layout it came from and how confident that reading was.
> - **Generated commands are a starting point.** They reproduce what was captured
>   or documented; tokens expire and sample values go stale.
>
> Your data is not at risk either way — everything is stored locally, and nothing
> is ever uploaded. Bug reports are very welcome.

> **New here?** [**SOP.md**](SOP.md) is a step-by-step walkthrough — setup, and
> the day-to-day loop for each utility. Start there.

## Contents

- [What this replaces](#what-this-replaces)
- [Requirements](#requirements)
- [Install](#install)
- [Updating](#updating)
- [Quick start](#quick-start)
- [Utilities](#utilities)
  - [cURL Extractor](#curl-extractor)
  - [Doc → Requests](#doc--requests)
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

## What this replaces

Two jobs that are otherwise done by hand, one per utility.

**Reverse-engineering an API from the browser.** A HAR embeds a response body for
every request, including images, JS bundles and source maps, which is how one page
refresh becomes 22 MB. Of the 200–400 requests a modern SPA fires, maybe 10–20 are
real API calls, and DevTools gives you no way to tell which belonged to the button
you just clicked. Then it's right-click → Copy as cURL, one at a time. curlapi
filters at capture time — a response body that is never fetched costs nothing — so
a session that produced a 22 MB HAR lands well under 1 MB.

**Testing endpoints somebody sent you in a Word file.** Read the document, retype
each endpoint into Postman with its headers and body, run them one at a time to
find out which work, and do it again when the document is revised. An afternoon,
per document, repeatedly. curlapi reads the document instead.

## Requirements

| | |
|---|---|
| **Browser** | Chrome, Chromium, Edge or Brave, at a standard install location |
| **OS** | macOS, Windows or Linux — 64-bit |
| **Node** | 24 or newer, **but you do not need to install it** — see below |

There is **no build step for the tool itself and no native modules**, so there is
nothing to compile per platform. If your browser lives somewhere unusual, point at
it with `CURLAPI_CHROME=/path/to/browser`.

## Install

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/itskundan-01/curlapi/main/scripts/install.sh | sh
```

**Windows**

```powershell
irm https://raw.githubusercontent.com/itskundan-01/curlapi/main/scripts/install.ps1 | iex
```

That gives you both a `curlapi` command and a real application you can launch
from Spotlight, the Start Menu or your applications menu — it opens the workspace
in its own window, with no tab strip and no address bar.

**If you already have Node 24**, the whole install is about 3 MB and takes a
second. **If you have no Node at all**, the installer says so and fetches an
official runtime for you — one 30–50 MB download, once, and nothing else on the
machine changes. Either way it needs no administrator, touches nothing outside
`~/.curlapi`, and can be undone by deleting that directory (plus the shortcut).

<details>
<summary>Why a terminal command rather than a download link</summary>

curlapi is not code-signed, because a signing certificate costs money every year
and this is a free tool. That matters only for files a **browser** downloads:
macOS and Windows both flag those, and you would have to click through a warning.

Files fetched by `curl` and `Invoke-WebRequest` carry no such flag, so the
command above installs with no warnings at all. It is the same software either
way — this route just skips a dialog that exists to protect you from a risk you
are not taking.

Every release also publishes `SHA256SUMS`, and both installers verify what they
download against it before writing anything.
</details>

### From source, or via npm

If you already work in Node and would rather manage it yourself:

```bash
git clone https://github.com/itskundan-01/curlapi.git
cd curlapi
npm install
npm run build:ui     # compiles the review UI into ui/dist — the one build step
npm link             # optional: puts `curlapi` on your PATH
```

## Updating

```bash
curlapi update           # install the newest release
curlapi update --check   # only say whether there is one
```

An update downloads **under a megabyte** — the application only, not the runtime
and certainly not a browser — verifies its checksum, and swaps it into place. The
workspace also checks quietly on startup and tells you when there is something
newer.

A copy installed from source or through npm is left alone: it will tell you a
release exists, and let `git pull` or `npm update` do the work, rather than
overwriting files another tool believes it owns.

## Quick start

```bash
curlapi
# or, from a source checkout:
node src/cli.ts
```

The workspace opens at <http://127.0.0.1:7317> on a dashboard of utilities.
**Nothing is launched yet** — no browser, no capture. Open **cURL Extractor**,
type the address of the site you are targeting, and confirm.

*Then* Chrome opens on that address. **Log in and use the site exactly as you
normally would**; the review UI fills in live. Tick the requests worth keeping,
switch to **Collection**, and you get them numbered, named, with the full curl and
a **Run** button. **Stop** ends the capture and keeps what you selected, without
closing the workspace — so the next capture is another click, not another run.

Everything lives under `~/.curlapi`.

For the same thing broken into numbered steps, with the UI actions spelled out,
see [SOP.md](SOP.md).

### Skipping the launch screen

If you already know the target, the old one-shot form still works and starts the
capture as the workspace comes up:

```bash
curlapi start https://example.com
```

## Utilities

| | | |
|---|---|---|
| ⚡ | **[cURL Extractor](#curl-extractor)** | Capture a site's real API calls as working curl commands. |
| 📄 | **[Doc → Requests](#doc--requests)** | Turn a handed-over API document into runnable requests. |

Each utility is a module under `src/apps/`, mounted by the shell at
`/api/apps/<id>` and listed on the dashboard from its own manifest. Adding one
means writing the module and adding a line to `src/platform/registry.ts` —
nothing in the shell, the CLI or the router needs to know it exists.

### cURL Extractor

Open it, type the address of the site you are targeting, and confirm. *Then*
Chrome opens on that address, signed in to its own profile. Browse as you
normally would; every API call behind what you did is captured with the headers
that actually went on the wire, cookies included.

The workspace has three tabs — **Live**, **Collection** and **Doc** — described
under [The review UI](#the-review-ui). **Stop** ends the capture and closes the
browser without closing the workspace, so the next capture is a click rather than
another run.

### Doc → Requests

Drop in the Word file, PDF or Markdown a department sends over, and every
endpoint in it comes back as a request you can read, run and export — instead of
retyping each one into Postman to find out whether it works.

It reads the layouts these documents actually use, and more than one per file:

- **Spec tables** — `HTTP Method` / `URL` / `Request Header` / `Request Body` /
  `Response` down the left, including the form that splits the URL row across
  *Staging* and *Production* columns.
- **Labelled prose** — `Method :- GET`, the URL on a line of its own, then
  `X-Api-Key - …` pairs under a "pass these in the header" sentence.
- **Pasted curl commands**, in the state a word processor leaves them: curly
  quotes, `--` eaten off the front of `--header` and `--data`, and the command
  broken across paragraphs with a `Request Parameter:` label in the middle.
- **Postman collections and OpenAPI descriptions**, imported directly.

It also keeps what the document says *about* each endpoint — the field tables
(sorting them into what you send and what comes back), the response codes, and
the response the document claims, which is shown beside the real one after a run.

The endpoint list sits on the left, and the selected endpoint opens as **two
panes side by side** — the request you can edit and run, and what the document
said about it. That pairing is the point: choosing what to put in a field means
reading the field table, and judging a run means comparing it against the
documented response.

**cURL is the first thing you see**, because the command *is* the request — one
view holding the URL, every header and the body, where a tabbed editor shows a
third of it at a time. Every line is clickable: the URL opens the parameters, a
header line opens the header table with that row focused, the payload opens the
body. Reading it and fixing it are the same gesture.

Behind that it is a full editor: a method dropdown, the URL, query parameters
and headers as rows you can add, edit, remove or **switch off**, and a body
editor with JSON formatting that names the parse error. A pasted curl command
replaces the request outright, so anything from Chrome's *Copy as cURL* or a
colleague's message lands here intact. Edits are stored separately from the
document's own reading, so **Reset to document** always works.

Tick endpoints in the list to **copy a Postman collection straight to the
clipboard** — Postman's Import takes raw text, so there is no file to save, find
and upload — or to copy them as curl commands. Exports follow the selection too.

The command is shown in full — URL, every header, and the payload across the
lines it was written on, syntax-coloured and nothing truncated — and clicking any
part of it opens the tab that owns it. What you read is exactly what the Copy
button gives you.

Commands are escaped for **your** shell: PowerShell on Windows, POSIX
elsewhere, detected in the browser so it is right even when the workspace is
running on someone else's machine. The override is still there for when you are
copying a command for a colleague.

Path placeholders like `{bookingId}` and credentials found in headers become
**shared values** you fill in once and have applied everywhere. Running is
blocked while a placeholder is unfilled, because a 404 from a URL still
containing `{bookingId}` looks like a broken endpoint and isn't.

Exports: a **Postman collection** with folders, path variables, saved response
examples and field descriptions — and with credentials lifted into collection
variables so the file can be shared — plus a shell script and a Markdown
summary.

> These documents usually arrive carrying live API keys. Treat what comes out of
> them the same way, and prefer the default export that keeps credentials as
> variables.

Each utility is a module under `src/apps/`, mounted by the shell at
`/api/apps/<id>` and listed on the dashboard from its own manifest. Adding one
means writing the module and adding a line to `src/platform/registry.ts`.

## Commands

```
curlapi                      Open the dashboard. Nothing launches until you pick an app
curlapi app                  Open the workspace in its own window (what the desktop icon runs)
curlapi start [url]          Open the dashboard and begin a capture right away
curlapi attach [--port N]    Capture from a browser you started yourself
curlapi ui [--session ID]    Open the workspace on a stored session, without recording
curlapi ls                   List stored sessions
curlapi prune                Discard captures nobody documented or approved
curlapi export <format>      script | postman | json | doc
curlapi config               Write the default filter rules so you can edit them
curlapi update [--check]     Install the newest release, or only report whether there is one
curlapi version              Print the installed version
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
| `--no-open` | Do not open a browser window at the workspace |
| `--check` | For `update`: report whether a release exists without installing it |

Two environment variables are worth knowing: `CURLAPI_CHROME` points at a browser
in an unusual location, and `CURLAPI_NO_UPDATE_CHECK=1` stops the once-a-day
check for new releases.

## The review UI

The cURL Extractor's workspace: three tabs, inside the shell at
`http://127.0.0.1:7317/apps/curl-extractor`.

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

From a capture, on the command line:

```bash
curlapi export script     # curls.sh — serial-numbered, one commented command per endpoint
curlapi export postman    # Postman collection v2.1, captured responses as examples
curlapi export doc        # api-notes.md — your documents, numbered, with your notes
curlapi export json       # session.json — the full record, re-importable
```

Add `--redact` to swap credentials for placeholders (and lift them into Postman
variables) before sharing any of these.

From a document import, in the workspace: the **Export** menu gives the same
Postman collection, shell script and Markdown. Credentials become collection
variables by default there, so the file can be sent to somebody as-is; there is a
separate "credentials inline" option for your own use.

Tick endpoints in the list first and everything — exports and the clipboard
copies — narrows to just those.

### What the Postman collection guarantees

Both utilities emit **Collection format v2.1**, built by one shared module
(`src/postman/`) and checked in the test suite against the published schema,
which is vendored in `test/fixtures/`. A collection that would fail to import
fails the tests first. In particular:

- **Every method survives** — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, and
  anything non-standard a document happens to use.
- **The port is kept.** A capture from `localhost:8080` imports as
  `localhost:8080`, not `localhost`.
- **`{placeholders}` become path variables** (`:bookingId`), declared as well as
  written into the path, so Postman shows its path-variable editor.
- **Form bodies land in the right editor** — `x-www-form-urlencoded` and
  text-only `multipart/form-data` become key/value rows instead of one long
  string. A multipart body containing a file stays raw, where the boundary still
  matches and the request works exactly as captured.
- **A body on a GET, HEAD or DELETE is not pruned.** Postman drops those by
  default; the item asks for it to be kept, because documents do describe them.
- **Credentials become collection variables** (with `--redact`, or by default
  from a document), so the file can be handed over.
- **Query values are not re-encoded.** `?q=a%20b` arrives as `a%20b`, not
  `a%2520b`.

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

**A document imported with too many endpoints, or the wrong names.** Each
endpoint shows the layout it was read as and how confident that reading was.
Please [open an issue](https://github.com/itskundan-01/curlapi/issues) with the
*shape* of the document — the headings and how the requests are laid out, with
your hosts and keys removed. That is what the parser is built against.

**A document imported with nothing.** A scanned PDF has no text to find, only an
image of it; the import says so. Copy the text out and paste it in as Markdown,
or use the original Word file if there is one.

**A request 404s with `{bookingId}` still in the URL.** It won't — the run is
refused while a placeholder is unfilled. Fill it in under **Shared values**,
which applies it to every endpoint at once.

## Security and privacy

**Everything stays on your machine.** curlapi binds to `127.0.0.1` only, has no
accounts, no telemetry and no server component. It cannot be a hosted service —
[the reasons are structural](DESIGN.md#why-this-cannot-be-hosted), not a scaling
decision.

Three things to know:

- **Captures contain live credentials.** `~/.curlapi/curlapi.db` holds the cookies
  and bearer tokens from your logged-in session. Treat it like a password store.
- **Imported documents usually do too.** The files departments hand over routinely
  carry live API keys, and sometimes sign-in details. What comes out of one
  deserves the same care as the file itself.
- **Exports carry those credentials**, by default and on purpose for captures — a
  command with `{{token}}` in it does not run. Use `--redact` before sharing a
  capture export. Document exports default the other way, lifting credentials into
  collection variables, because a collection exists to be sent to somebody.

## Development

```bash
npm test          # 106 tests: curl golden file, filter decisions, header merge,
                  # document parsing across four layouts, end-to-end capture
npm run typecheck # tsc --noEmit
npm run dev:ui    # Vite dev server for the UI
npm run build:ui  # build ui/dist
```

The end-to-end test drives headless Chrome against a local site and checks both
that the API call is captured completely and that the noise around it is not.

Layout of the repository:

```
src/platform/      the app contract, the registry, the shell server
src/apps/
  curl-extractor/  manifest · capture controller · routes
  doc-runner/      manifest · readers · extractors · exporters · routes
src/curl · replay · filter · store · export      shared by both apps
ui/src/shell/      router · dashboard · live socket · theme
ui/src/apps/…      one folder per app
```

Why it is arranged this way, and the browser and word-processor behaviours behind
the fiddly parts: [DESIGN.md](DESIGN.md).

Test fixtures use synthetic credentials that are structurally identical to real
ones. Please keep it that way — never commit a real token, cookie or API key.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Design notes

[DESIGN.md](DESIGN.md) covers the decisions behind the behaviour: what is kept and
what is discarded, why the document outlives the capture, how header fidelity is
achieved, and why this has to run locally.

## License

[MIT](LICENSE) © Kundan
