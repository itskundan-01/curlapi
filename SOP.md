# SOP — how to use curlapi

A step-by-step guide. **New users start at Part 1.** If it is already installed,
jump to the utility you need:

- [Part 2 — Capturing a site's API calls](#part-2--capturing-a-sites-api-calls)
- [Part 3 — Turning a document into runnable requests](#part-3--turning-a-document-into-runnable-requests)

> **Beta.** Both utilities work and are in daily use, but expect rough edges.
> Check what a document import produced before acting on it, and treat generated
> commands as a starting point. Nothing is ever uploaded — everything stays on
> your machine.

---

## Before you start

| Need | Check with | If missing |
|---|---|---|
| Node 24+ | `node --version` | Install from [nodejs.org](https://nodejs.org) or `nvm install 24` |
| Chrome / Chromium / Edge / Brave | already installed? | Install any one of them — only needed for capturing |
| Git | `git --version` | Install from [git-scm.com](https://git-scm.com) |

---

## Part 1 — First-time setup

Do this once per machine. Takes about two minutes.

**1. Get the code**

```bash
git clone https://github.com/itskundan-01/curlapi.git
cd curlapi
```

**2. Install dependencies**

```bash
npm install
```

**3. Build the interface**

```bash
npm run build:ui
```

This is the only build step, and it only runs once.

**4. Make `curlapi` available anywhere (optional but recommended)**

```bash
npm link
```

Now you can type `curlapi` from any folder. Without this, use
`node src/cli.ts` instead of `curlapi` in every command below.

**5. Open the workspace**

```bash
curlapi
```

Your browser opens on a dashboard at **http://127.0.0.1:7317** listing the
utilities. **Nothing else has started** — no browser has been launched, no
capture is running. Setup is done.

Press **Ctrl-C** in the terminal to close the workspace when you are finished.

---

## Part 2 — Capturing a site's API calls

Goal: get the API calls behind one action on a website — a login, a search, a
profile load — as commands that run.

### Step 1 — Open the utility

From the dashboard, click **⚡ cURL Extractor**.

### Step 2 — Say what you are targeting

Type the address of the site into **Target URL** and click **Launch browser and
capture**.

*Now* a Chrome window opens on that address, and recording begins.

> This browser has its own profile, separate from your everyday one. It will look
> logged out the first time. That is expected — see [Why a separate
> browser?](#why-a-separate-browser)

Under **Options** you can also name the capture, continue the previous session,
keep everything instead of only your picks, or run without a window.

### Step 3 — Use the website normally

Put the workspace and the captured browser side by side. Log in. Click the thing
you care about. **Do the action you want to reverse engineer.** Everything real
the site requests shows up in the **Live** tab, newest first; images, fonts,
scripts and trackers are dropped automatically.

> **Tip:** click **Clear** in the Live tab just before the action you care about.
> Numbering restarts at #1, so the next few rows are exactly your action and
> nothing else. This is the single most useful habit.

### Step 4 — Pick the requests you want

In the **Live** tab:

| To do this | Do that |
|---|---|
| Select one request | Tick its checkbox |
| Select a range | Tick one, then **shift-click** another |
| Select everything shown | Tick the checkbox in the header row |
| Inspect before deciding | Click the row — a detail panel opens (Esc closes it) |
| See only what failed | Click the red **n failed** chip |

Ticked requests go into the **Collection** tab.

### Step 5 — File them into a document

With rows ticked, a bar appears showing **N selected**:

1. Pick or create a document in the **into** selector next to the button
2. Click **Add to doc**

Create one document per flow — `login`, `search`, `checkout`. Each numbers from 1
independently, so "#2 in login" stays #2 forever.

### Step 6 — Write down what each one does

Open the **Doc** tab. For each entry:

- Rename it to something meaningful (double-click the name)
- Type in the notes box what the endpoint actually does
- Reorder with the arrows so it reads in call order

**This is the real output.** The capture gets thrown away; your document does not.

### Step 7 — Check the commands still work

Click **Run** on an entry. You get status, timing, size, and whether the response
still looks like it did at capture time.

- **200** — good, the command is reproducible
- **401** — a token expired; the tool names which one and by how long
- **one-time** label — this request can *never* be replayed (an OTP, a
  single-use transaction). That is information, not a failure

### Step 8 — Stop the capture

Click **Stop** in the workspace header. Chrome closes, the session is finalised,
and **the workspace stays open** — so starting the next capture is one click, not
another run of the tool.

Everything you ticked or documented is saved. Everything else is discarded — this
is deliberate, and it is what keeps the database small.

### Step 9 — Take your results out

```bash
curlapi export doc        # api-notes.md — your documents and notes
curlapi export script     # curls.sh — a runnable shell script
curlapi export postman    # Postman collection
```

> ⚠️ **Capture exports contain live credentials by default**, because a command
> with `{{token}}` in it does not run. Add `--redact` before sharing with anyone:
> `curlapi export postman --redact`

---

## Part 3 — Turning a document into runnable requests

Goal: take the API document a department handed over and get every endpoint in it
as something you can run — without retyping any of it into Postman.

### Step 1 — Open the utility

From the dashboard, click **📄 Doc → Requests**.

### Step 2 — Drop the document in

Drag the file onto the drop zone, or click to choose one.

| Format | Notes |
|---|---|
| **Word** (`.docx`) | The common case. Read directly, tables and all |
| **PDF** | Text-based PDFs only. A scan has no text to find, and the import says so |
| **Markdown** / **text** | Also the fallback when a PDF comes back empty — paste the text in |
| **JSON** | An existing Postman collection or OpenAPI description is imported exactly |

Several files can go in at once; each is reported separately.

> ⚠️ These documents usually carry **live API keys**, and sometimes sign-in
> details. What comes out deserves the same care as the file itself.

### Step 3 — Check what was read

The endpoint list is on the left. Each entry shows the method and the name taken
from the document's own heading.

**Spend a minute here.** Open a few and look at the **cURL** tab — the whole
command, in one view. Every endpoint also shows, on the right, which layout it
was read as and how confident that reading was (`spec-table · 95%`).

If something is wrong, the fix is in the same place — see Step 5.

### Step 4 — Fill in the shared values

The bar across the top lists values that appear across the document:
**credentials** found in headers, and **placeholders** like `{bookingId}` from
the URLs. Fill each in once and it applies to every endpoint, and to everything
you copy and export.

> Running is blocked while a placeholder is unfilled, on purpose: a 404 from a
> URL still containing `{bookingId}` looks like a broken endpoint and isn't.

### Step 5 — Adjust anything that needs it

The **cURL** tab is the whole request in one view, and every line is clickable:

| Click | Opens |
|---|---|
| The `curl 'https://…'` line | **Params** — the query string as editable rows |
| A `-H '…'` line | **Headers** — with that row focused |
| The `--data-raw` line | **Body** — with JSON formatting |

Headers can be switched **off** rather than deleted, which is how you find out
whether one is load-bearing. **Format JSON** names the parse error if a body will
not parse — usually a quote the word processor mangled.

Pasted a command from somewhere else? **Replace with a pasted command** takes a
curl from Chrome's *Copy as cURL*, from Postman, from a colleague's message.

Your edits are stored separately from what the document said, so **Reset to
document** always works.

### Step 6 — Run it

Click **Run**. The response appears directly underneath: status, time, size, the
body, the response headers — and a **Compare** tab putting the real response
beside the one the document promised.

The document's own field tables and response codes stay visible on the right
throughout, so deciding what to send and judging what came back are both
one-glance questions.

### Step 7 — Take it to Postman, or wherever

Tick endpoints in the list, then:

| Button | Does |
|---|---|
| **Copy for Postman** | Puts the collection JSON on your clipboard. In Postman: **Import → Raw text → paste**. No file to save and find |
| **Copy curl** | The commands, ready for a terminal |
| **Export ▾** | The same as files — Postman collection, shell script, Markdown |

With nothing ticked, exports cover the whole document.

Credentials become **collection variables** by default, so the file can be sent
to somebody as-is. There is a separate *credentials inline* option for your own
use — it is labelled, and it means what it says.

What arrives in Postman, from either utility:

- every method the document or the capture used, including `DELETE`, `PATCH` and
  `HEAD`;
- the port, when the URL has one — a request to `localhost:8080` is not silently
  turned into `localhost`;
- `{bookingId}`-style placeholders as **path variables**, editable in Postman's
  own path-variable row;
- form bodies as key/value rows rather than one long encoded string;
- a body on a `GET` or `DELETE` kept rather than pruned, which is Postman's
  default behaviour otherwise;
- the documented (or captured) response saved as an **example**, so the
  collection still describes the endpoint after the sample credentials expire.

If an import ever fails, it is a bug worth reporting: the exported file is
checked against Postman's published schema by the test suite.

Commands are escaped for **your** shell automatically: PowerShell on Windows,
bash/zsh elsewhere. The dropdown in the header overrides it when you are copying
something for a colleague on the other kind of machine.

---

## Part 4 — Returning user

```bash
cd curlapi
curlapi          # open the workspace, pick a utility
```

Shortcuts that skip the launch screen:

```bash
curlapi start https://the-site.com   # open the workspace and start capturing at once
curlapi ui                           # open on a stored capture, without recording
curlapi ls                           # list stored sessions
curlapi start --resume               # add to the previous session instead of a new one
```

**After a `git pull`:**

```bash
npm install && npm run build:ui
```

Re-run both — a pull can change dependencies or the UI.

---

## Part 5 — Common tasks

| I want to… | Do this |
|---|---|
| Look at an old capture | `curlapi ui --session <id>` (ids from `curlapi ls`) |
| Keep the entire capture, not just picks | Tick **Keep everything** under Options, or `curlapi start --keep` |
| Capture without a visible window | Tick **Run Chrome without a window**, or `curlapi start --headless` |
| Use a browser I launched myself | `curlapi attach --port 9222` |
| Generate commands for PowerShell | Pick it in the header dropdown, or `--shell powershell` on an export |
| Strip browser noise headers | Add `--clean` to an export |
| Hide credentials in output | Tick **Redact**, or add `--redact` |
| Change what gets filtered in a capture | `curlapi config`, then edit `~/.curlapi/filters.json` |
| Free up disk space | `curlapi prune` |
| Run the workspace on another port | `curlapi --ui-port 7400` |

---

## Part 6 — Troubleshooting

### Capturing

| Symptom | Cause | Fix |
|---|---|---|
| Almost nothing is captured | The tab finished loading before capture attached | Click **Reload and capture** in the banner |
| The site looks logged out | Separate browser profile, first run | Log in once; it persists after that |
| A request I expected is missing | The filter dropped it | Tick **Show filtered-out** — the reason is listed |
| Command worked, now 401s | Token expired | Recapture. The token panel shows shelf life |
| Run fails but the browser works | Nonce / timestamp / one-time value | Check the **one-time** label and the flow chain |
| "Could not find Chrome…" | Browser in a non-standard location | `CURLAPI_CHROME="/path/to/chrome" curlapi start` |
| Pasting a command breaks the shell | Multi-line command mangled | Use **Copy one-line** in the detail panel |

### Importing documents

| Symptom | Cause | Fix |
|---|---|---|
| No endpoints found | A layout the parser has not seen | Paste one request in as a curl command — that is always understood. Then please [open an issue](https://github.com/itskundan-01/curlapi/issues) with the document's *shape*, hosts and keys removed |
| Nothing found in a PDF | It is a scan — an image of text | Copy the text out and paste it in as Markdown, or use the Word original |
| Too many endpoints, or odd names | A layout read wrongly | Check the confidence label on each. Please report it — this is the most useful bug report for this utility |
| A body will not parse | A quote the word processor mangled | **Format JSON** in the Body tab names the position |
| **Run** is greyed out | A placeholder is unfilled | Fill it in under **Shared values** |

### Everything else

| Symptom | Fix |
|---|---|
| `Unknown file extension ".ts"` | Node older than 24 — `nvm install 24 && nvm use 24` |
| Workspace won't open | Port 7317 in use — `curlapi --ui-port 7400` |
| Nothing on screen after an update | `npm install && npm run build:ui` |

---

## Things worth knowing

### Why a separate browser?

Since Chrome 136, `--remote-debugging-port` is silently ignored on your default
profile — hardening against cookie theft. So curlapi uses its own profile at
`~/.curlapi/chrome-profile`. You sign in once; it remembers.

### What is kept, and what is thrown away

When a **capture** ends, only what you ticked or documented survives. A session
where you picked nothing is not kept at all. This is on purpose: captures are
hundreds of requests, and keeping them all buries the ones that matter. Use
**Keep everything** if you want the whole thing.

**Imported documents are not pruned.** They are the artefact, not working state,
and stay until you delete them.

### Documents outlive captures

Adding a request to a document copies the whole request into it. So even after
the capture is pruned, the document entry still shows the headers, rebuilds the
curl, and **runs**.

### Where everything lives

```
~/.curlapi/
  curlapi.db        your sessions, documents, notes and imports
  filters.json      your filter rules (after `curlapi config`)
  chrome-profile/   the dedicated browser profile
```

> ⚠️ `curlapi.db` contains live cookies and tokens from your sessions, and the
> keys from any document you imported. Treat it like a password store. Never
> commit it or share it.

---

## Quick reference

```bash
# Setup (once)
git clone https://github.com/itskundan-01/curlapi.git && cd curlapi
npm install && npm run build:ui && npm link

# Every day
curlapi                            # dashboard → pick a utility
curlapi start https://site.com     # or go straight to capturing

# Take results out
curlapi export doc --redact
```

More detail: [README](README.md) · Why it behaves this way: [DESIGN.md](DESIGN.md)
