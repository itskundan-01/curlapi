# SOP — how to use curlapi

A step-by-step guide. **New users start at Part 1.** If you already have it
installed, jump to [Part 3](#part-3--returning-user).

What you get at the end: the handful of real API calls a website makes, as curl
commands that actually run, with your notes attached.

---

## Before you start

| Need | Check with | If missing |
|---|---|---|
| Node 24+ | `node --version` | Install from [nodejs.org](https://nodejs.org) or `nvm install 24` |
| Chrome / Chromium / Edge / Brave | already installed? | Install any one of them |
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

**3. Build the review UI**

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

**5. Check it works**

```bash
curlapi --help
```

You should see the list of commands. Setup is done.

---

## Part 2 — Your first capture

Goal: capture the API calls behind one action on a website — a login, a search, a
profile load.

### Step 1 — Start a capture

```bash
curlapi start https://example.com
```

Two things happen:
- A browser window opens at that site
- The review UI starts at **http://127.0.0.1:7317**

> This browser has its own profile, separate from your everyday one. It will look
> logged out the first time. That is expected — see [Why a separate
> browser?](#why-a-separate-browser)

### Step 2 — Open the review UI

Open **http://127.0.0.1:7317** in your *normal* browser and put it side by side
with the captured one. You now watch requests appear as you browse.

### Step 3 — Use the website normally

Log in. Click the thing you care about. **Do the action you want to reverse
engineer.** Everything real the site requests shows up in the **Live** tab,
newest first; images, fonts, scripts and trackers are dropped automatically.

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

### Step 8 — Finish

Press **Ctrl-C** in the terminal.

Everything you ticked or documented is saved. Everything else is discarded — this
is deliberate, and it is what keeps the database small.

### Step 9 — Take your results out

```bash
curlapi export doc        # api-notes.md — your documents and notes
curlapi export script     # curls.sh — a runnable shell script
curlapi export postman    # Postman collection
```

> ⚠️ **Exports contain live credentials by default**, because a command with
> `{{token}}` in it does not run. Add `--redact` before sharing with anyone:
> `curlapi export postman --redact`

---

## Part 3 — Returning user

You already have it installed. The loop is:

```bash
cd curlapi
curlapi start https://the-site.com     # capture
# ... browse, tick, add to doc, Ctrl-C
curlapi export doc                     # take the notes out
```

Other things you will want:

```bash
curlapi ui                    # review what you kept, without capturing
curlapi ls                    # list stored sessions
curlapi start --resume        # add to the previous session instead of a new one
```

**After a `git pull`:**

```bash
npm install && npm run build:ui
```

Re-run both — a pull can change dependencies or the UI.

---

## Part 4 — Common tasks

| I want to… | Command |
|---|---|
| Look at an old session | `curlapi ui --session <id>` (get ids from `curlapi ls`) |
| Keep the entire capture, not just picks | `curlapi start --keep` |
| Capture without a visible window | `curlapi start --headless` |
| Use a browser I launched myself | `curlapi attach --port 9222` |
| Generate commands for PowerShell | `curlapi export script --shell powershell` |
| Strip browser noise headers | add `--clean` |
| Hide credentials in output | add `--redact` |
| Change what gets filtered | `curlapi config`, then edit `~/.curlapi/filters.json` |
| Free up disk space | `curlapi prune` |

---

## Part 5 — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Almost nothing is captured | The tab finished loading before capture attached | Click **Reload and capture** in the banner |
| `Unknown file extension ".ts"` | Node older than 24 | `nvm install 24 && nvm use 24` |
| "Could not find Chrome…" | Browser in a non-standard location | `CURLAPI_CHROME="/path/to/chrome" curlapi start` |
| The site looks logged out | Separate browser profile, first run | Log in once; it persists after that |
| A request I expected is missing | The filter dropped it | Tick **Show filtered-out** — the reason is listed |
| Command worked, now 401s | Token expired | Recapture. The token panel shows shelf life |
| Run fails but the browser works | Nonce / timestamp / one-time value | Check the **one-time** label and the flow chain |
| Review UI won't open | Port 7317 in use | `curlapi start --ui-port 7400` |
| Pasting a command breaks the shell | Multi-line command mangled | Use **Copy one-line** in the detail panel |

---

## Things worth knowing

### Why a separate browser?

Since Chrome 136, `--remote-debugging-port` is silently ignored on your default
profile — hardening against cookie theft. So curlapi uses its own profile at
`~/.curlapi/chrome-profile`. You sign in once; it remembers.

### What is kept, and what is thrown away

When a capture ends, **only what you ticked or documented survives.** A session
where you picked nothing is not kept at all.

This is on purpose: captures are hundreds of requests, and keeping them all
buries the ones that matter. Use `--keep` if you want the whole thing.

### Documents outlive captures

Adding a request to a document copies the whole request into it. So even after
the capture is pruned, the document entry still shows the headers, rebuilds the
curl, and **runs**.

### Where everything lives

```
~/.curlapi/
  curlapi.db        your sessions, documents and notes
  filters.json      your filter rules (after `curlapi config`)
  chrome-profile/   the dedicated browser profile
```

> ⚠️ `curlapi.db` contains live cookies and tokens from your sessions. Treat it
> like a password store. Never commit it or share it.

---

## Quick reference

```bash
# Setup (once)
git clone https://github.com/itskundan-01/curlapi.git && cd curlapi
npm install && npm run build:ui && npm link

# Capture
curlapi start https://site.com    # browse → tick → Add to doc → Ctrl-C

# Review and export
curlapi ui
curlapi export doc --redact
```

More detail: [README](README.md) · Why it behaves this way: [DESIGN.md](DESIGN.md)
