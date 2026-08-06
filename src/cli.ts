#!/usr/bin/env node
import './suppress-warnings.ts';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CdpConnection } from './capture/client.ts';
import { Recorder } from './capture/recorder.ts';
import { launchBrowser, attachBrowser, type LaunchedBrowser } from './chrome/launch.ts';
import { startServer, recordMessage } from './server/http.ts';
import { toShellScript } from './export/script.ts';
import { toPostmanCollection } from './export/postman.ts';
import { toMarkdown } from './export/doc.ts';
import { buildCurl } from './curl/build.ts';
import { writeDefaultConfig } from './filter/config.ts';
import { DEFAULT_CURL_OPTIONS, type CurlOptions } from './types.ts';
import { DB_PATH, EXPORT_DIR, ensureDirs, FILTERS_PATH, HOME } from './paths.ts';

// Deferred on purpose — see suppress-warnings.ts. A static import here would
// load node:sqlite during module linking, before the warning filter is in place.
const { Store } = await import('./store/db.ts');

type Args = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, positional, flags };
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Printing the URL is the fallback, and it always happens anyway.
  }
}

function curlOptionsFromFlags(flags: Record<string, string | boolean>): CurlOptions {
  return {
    ...DEFAULT_CURL_OPTIONS,
    clean: flags['clean'] === true,
    redact: flags['redact'] === true,
    shell: flags['shell'] === 'powershell' ? 'powershell' : 'posix',
    singleLine: flags['single-line'] === true,
  };
}

const HELP = `curlapi — capture a browser session's real API calls as working curl commands

Usage
  curlapi start [url]          Launch Chrome, capture, and open the review UI
  curlapi attach [--port N]    Attach to a Chrome already started with --remote-debugging-port
  curlapi ui [--session ID]    Review a stored session without capturing
  curlapi ls                   List stored sessions
  curlapi prune                Discard captures nobody documented or approved
  curlapi export <format>      Write curls.sh, a Postman collection, or raw JSON
  curlapi config               Write the default filter rules so they can be edited

Options
  --port N            DevTools port for attach (default 9222)
  --ui-port N         Port for the review UI (default 7317)
  --session ID        Target a specific session instead of the most recent
  --resume            Continue the previous capture rather than starting a new one
  --keep              Keep the whole capture instead of only what you selected
  --label TEXT        Name the capture session
  --format FORMAT     script | postman | json | doc   (also accepted positionally)
  --out PATH          Where to write the export
  --clean             Strip sec-* / priority headers from generated curl
  --redact            Replace credentials with {{placeholders}}
  --shell SHELL       posix (default) or powershell
  --headless          Run Chrome without a window

Everything is stored under ${HOME}
`;

async function runCapture(args: Args): Promise<void> {
  ensureDirs();
  const store = new Store();

  // --resume continues the previous capture instead of opening a new one, so a
  // restart adds to the same numbered list rather than starting from #1.
  // Everything is on disk either way; the review UI can switch between sessions.
  const resumeTarget =
    args.flags['resume'] === true
      ? store.listSessions()[0]
      : typeof args.flags['session'] === 'string'
        ? store.getSession(args.flags['session'])
        : null;

  const sessionId = resumeTarget?.id ?? randomUUID();
  const label =
    typeof args.flags['label'] === 'string'
      ? args.flags['label']
      : `Capture ${new Date().toLocaleString()}`;

  if (resumeTarget) {
    console.log(
      `Resuming "${resumeTarget.label}" ` +
        `(${store.listRequests(sessionId).length} API calls already captured)`,
    );
  } else {
    store.createSession({
      id: sessionId,
      label,
      startedAt: Date.now(),
      endedAt: null,
      primaryHost: null,
    });
  }

  // Old captures are cleared before this one starts, so history cannot pile up.
  // Documented and approved endpoints are kept; the rest was working state.
  if (args.flags['keep'] !== true) {
    const pruned = store.pruneHistory(sessionId);
    if (pruned.requests > 0 || pruned.sessions > 0) {
      console.log(
        `Cleared ${pruned.requests} request${pruned.requests === 1 ? '' : 's'} ` +
          `from ${pruned.sessions} earlier session${pruned.sessions === 1 ? '' : 's'} ` +
          '(documented and approved endpoints kept).',
      );
    }
  }

  let browser: LaunchedBrowser;
  if (args.command === 'attach') {
    const port = Number(args.flags['port'] ?? 9222);
    browser = await attachBrowser(port);
    console.log(`Attached to ${browser.browserName} on port ${port}`);
  } else {
    // Deliberately launched with no URL: a page Chrome opens for itself starts
    // loading before we are attached, so the start URL is navigated below instead.
    browser = await launchBrowser({ headless: args.flags['headless'] === true });
    console.log(`Launched ${browser.browserName} (DevTools port ${browser.port})`);
  }

  const uiPort = Number(args.flags['ui-port'] ?? 7317);

  // The server comes up first so the recorder can be told to ignore its origin.
  const server = await startServer({ store, sessionId, port: uiPort, recorder: null });

  const connection = await CdpConnection.connect(
    await CdpConnection.browserUrl(browser.port),
  );

  const recorder = new Recorder({
    connection,
    sessionId,
    store,
    onRecord: (record) => server.broadcast(recordMessage(record)),
    ignoreOrigins: [server.url, `http://localhost:${server.port}`],
  });

  server.setRecorder(recorder);
  await recorder.start();

  const startUrl = args.positional[0];
  if (startUrl) {
    await recorder.openAndNavigate(startUrl);
  }

  console.log('');
  console.log(`  Review UI   ${server.url}`);
  console.log(`  Filters     ${FILTERS_PATH}`);
  console.log('');
  console.log('Browse the site as you normally would. Press Ctrl-C when finished.');

  openInBrowser(server.url);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nFinishing capture…');
    await recorder.stop();
    store.endSession(sessionId, Date.now());

    const total = store.listRequests(sessionId, { includeNoise: true }).length;

    // The document is the artefact; the capture behind it was scaffolding.
    // Discarding it here is what stops the database growing without limit.
    const documented = store.listDocEntries(sessionId).filter((e) => e.requestId).length;
    const discarded = args.flags['keep'] === true ? 0 : store.pruneSession(sessionId);
    const retained = store.listRequests(sessionId, { includeNoise: true }).length;

    console.log(`Captured ${total} requests.`);
    if (discarded > 0) {
      console.log(
        `Discarded ${discarded} of them; kept ${retained} ` +
          `(${documented} documented, the rest approved).`,
      );
    }

    if (store.isSessionEmpty(sessionId)) {
      // Nothing was picked, so there is nothing worth a row in the session list.
      store.deleteSession(sessionId);
      console.log('Nothing was selected, so this session was not kept.');
    } else {
      const kb = Math.round(store.sessionBytes(sessionId) / 1024);
      console.log(`${kb} KB stored in ${DB_PATH}`);
      console.log('');
      console.log('  curlapi ui              Reopen what you kept');
      console.log('  curlapi start --resume  Capture more into this same session');
      console.log('  curlapi start --keep    Next time, keep the whole capture');
    }

    // Ask Chrome to exit properly. Killing the process instead makes Chrome
    // treat the next launch as crash recovery and restore these tabs, which
    // silently breaks the following capture: a restored tab finishes loading
    // before we are attached, so none of its traffic is recorded.
    await connection.trySend('Browser.close');
    await new Promise((resolve) => setTimeout(resolve, 300));

    connection.close();
    await server.close();
    await browser.close();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function runUi(args: Args): Promise<void> {
  const store = new Store();
  const sessions = store.listSessions();
  const sessionId =
    typeof args.flags['session'] === 'string' ? args.flags['session'] : sessions[0]?.id;

  if (!sessionId) {
    console.error('No sessions stored yet. Run `curlapi start` first.');
    process.exit(1);
  }

  const port = Number(args.flags['ui-port'] ?? 7317);
  const server = await startServer({ store, sessionId, port, recorder: null });
  console.log(`Review UI  ${server.url}`);
  openInBrowser(server.url);
}

function runList(): void {
  const store = new Store();
  const sessions = store.listSessions();
  if (sessions.length === 0) {
    console.log('No sessions stored yet. Run `curlapi start` to make one.');
    return;
  }
  for (const session of sessions) {
    const kept = store.listRequests(session.id).length;
    const approved = store.listApproved(session.id).length;
    const when = new Date(session.startedAt).toLocaleString();
    console.log(
      `${session.id}  ${when}  ${String(kept).padStart(4)} kept  ` +
        `${String(approved).padStart(3)} approved  ${session.primaryHost ?? '—'}  ${session.label}`,
    );
  }
}

/**
 * Discards captured requests nobody selected, across every stored session.
 *
 * The same rule a capture applies when it ends, available on demand for a
 * database that grew before that existed.
 */
function runPrune(): void {
  const store = new Store();
  const before = store.listSessions().length;
  const bytesBefore = store
    .listSessions()
    .reduce((sum, session) => sum + store.sessionBytes(session.id), 0);

  // No session is exempt: nothing is being recorded.
  const result = store.pruneHistory('');

  const after = store.listSessions();
  const bytesAfter = after.reduce((sum, session) => sum + store.sessionBytes(session.id), 0);
  const saved = Math.max(0, Math.round((bytesBefore - bytesAfter) / 1024));

  console.log(
    `Discarded ${result.requests} unselected request${result.requests === 1 ? '' : 's'} ` +
      `and removed ${result.sessions} empty session${result.sessions === 1 ? '' : 's'}.`,
  );
  console.log(`${before} sessions → ${after.length}, freeing about ${saved} KB.`);
  if (after.length > 0) {
    console.log('Kept everything documented or approved.');
  }
}

function runExport(args: Args): void {
  ensureDirs();
  const store = new Store();
  const sessions = store.listSessions();
  const sessionId =
    typeof args.flags['session'] === 'string' ? args.flags['session'] : sessions[0]?.id;

  if (!sessionId) {
    console.error('No sessions stored yet.');
    process.exit(1);
  }

  const session = store.getSession(sessionId);
  if (!session) {
    console.error(`No session ${sessionId}`);
    process.exit(1);
  }

  const format = String(args.positional[0] ?? args.flags['format'] ?? 'script');
  const curlOptionsForDoc = curlOptionsFromFlags(args.flags);

  // The document is written from its own entries, not from the approved list.
  if (format === 'doc') {
    const entries = store.listDocEntries(sessionId);
    if (entries.length === 0) {
      console.error('The document is empty — add entries from the Doc tab first.');
      process.exit(1);
    }
    const markdown = toMarkdown(
      entries,
      session,
      (entry) => {
        if (!entry.requestId) return '';
        const record =
          store.getRequest(entry.requestId) ?? store.getDocSnapshot(entry.requestId);
        return record ? buildCurl(record, curlOptionsForDoc) : entry.curlSnapshot;
      },
      store.listFolders(sessionId),
    );
    const target =
      typeof args.flags['out'] === 'string'
        ? args.flags['out']
        : join(EXPORT_DIR, 'api-notes.md');
    writeFileSync(target, markdown, 'utf8');
    console.log(`Wrote ${entries.length} document entries to ${target}`);
    return;
  }

  const approved = store.listApproved(sessionId);
  // Fall back to everything that survived the filter when nothing is approved yet.
  const records = approved.length > 0 ? approved : store.listRequests(sessionId);

  if (records.length === 0) {
    console.error('Nothing to export — the session has no kept requests.');
    process.exit(1);
  }

  const curlOptions = curlOptionsFromFlags(args.flags);
  let contents: string;
  let defaultName: string;

  switch (format) {
    case 'script':
      contents = toShellScript(records, session, curlOptions);
      defaultName = 'curls.sh';
      break;
    case 'postman':
      contents = toPostmanCollection(records, session, curlOptions);
      defaultName = 'collection.json';
      break;
    case 'json':
      contents = JSON.stringify({ session, records }, null, 2);
      defaultName = 'session.json';
      break;
    default:
      console.error(`Unknown format "${format}". Use script, postman, json or doc.`);
      process.exit(1);
      return;
  }

  const out =
    typeof args.flags['out'] === 'string'
      ? args.flags['out']
      : join(EXPORT_DIR, defaultName);
  writeFileSync(out, contents, 'utf8');

  const source = approved.length > 0 ? 'approved' : 'kept';
  console.log(`Wrote ${records.length} ${source} endpoints to ${out}`);
  if (!curlOptions.redact) {
    console.log('This file contains live credentials from the session. Treat it as a secret.');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'start':
    case 'attach':
      await runCapture(args);
      return;
    case 'ui':
      await runUi(args);
      return;
    case 'ls':
      runList();
      return;
    case 'export':
      runExport(args);
      return;
    case 'prune':
      runPrune();
      return;
    case 'config':
      console.log(`Wrote default filter rules to ${writeDefaultConfig()}`);
      return;
    default:
      console.log(HELP);
      return;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
