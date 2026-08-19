#!/usr/bin/env node
import './suppress-warnings.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startShell } from './platform/shell.ts';
import { openWindow, openInBrowser } from './desktop/window.ts';
import { findRunningWorkspace, watchForClose } from './desktop/session.ts';
import { APPS } from './platform/registry.ts';
import type { CurlExtractorApp } from './apps/curl-extractor/index.ts';
import { CURL_EXTRACTOR_ID } from './apps/curl-extractor/manifest.ts';
import { toShellScript } from './export/script.ts';
import { toPostmanCollection } from './export/postman.ts';
import { toMarkdown } from './export/doc.ts';
import { buildCurl } from './curl/build.ts';
import { writeDefaultConfig } from './filter/config.ts';
import { DEFAULT_CURL_OPTIONS, type CurlOptions } from './types.ts';
import { DB_PATH, EXPORT_DIR, ensureDirs, FILTERS_PATH, HOME, VERSION } from './paths.ts';
import { applyUpdate, checkForUpdate, checkForUpdateDaily } from './update/index.ts';

// Deferred on purpose — see suppress-warnings.ts. A static import here would
// load node:sqlite during module linking, before the warning filter is in place.
const { Store } = await import('./store/db.ts');

type Args = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Args {
  const [command = 'serve', ...rest] = argv;
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

function curlOptionsFromFlags(flags: Record<string, string | boolean>): CurlOptions {
  return {
    ...DEFAULT_CURL_OPTIONS,
    clean: flags['clean'] === true,
    redact: flags['redact'] === true,
    shell: flags['shell'] === 'powershell' ? 'powershell' : 'posix',
    singleLine: flags['single-line'] === true,
  };
}

const HELP = `curlapi — a local workspace of small API utilities  (beta)

Usage
  curlapi                      Open the dashboard. Nothing is launched until you pick an app
  curlapi app                  Open the workspace as its own window (what the desktop icon runs)
  curlapi start [url]          Open the dashboard and begin a capture right away
  curlapi attach [--port N]    Capture from a Chrome already started with --remote-debugging-port
  curlapi ui [--session ID]    Open the dashboard on a stored capture, without recording
  curlapi ls                   List stored sessions
  curlapi prune                Discard captures nobody documented or approved
  curlapi export <format>      Write curls.sh, a Postman collection, or raw JSON
  curlapi config               Write the default filter rules so they can be edited
  curlapi update [--check]     Install the newest release, or only report whether there is one

Apps
${APPS.map(
  (app) =>
    `  ${app.manifest.icon}  ${app.manifest.name.padEnd(16)} ${app.manifest.tagline}` +
    (app.manifest.status === 'coming-soon' ? '  (coming soon)' : ''),
).join('\n')}

Options
  --port N            DevTools port for attach (default 9222)
  --ui-port N         Port for the workspace (default 7317)
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
  --no-open           Do not open a browser window at the workspace
  --version           Print the installed version

Everything is stored under ${HOME}
`;

/**
 * Boots the workspace, and nothing else.
 *
 * This is the whole point of the app split: opening curlapi no longer commits
 * you to a capture. The shell binds a port, serves the dashboard and waits —
 * Chrome is not launched until an app asks for it.
 */
async function runShell(args: Args): Promise<void> {
  ensureDirs();
  const port = Number(args.flags['ui-port'] ?? 7317);

  // Launched from an icon, where clicking twice is normal and must not be an
  // error. A workspace already on this port is shown rather than duplicated —
  // and it owns the database, so a second one could not open it anyway.
  const desktop = args.command === 'app';
  if (desktop) {
    const running = await findRunningWorkspace(port);
    if (running) {
      openWindow(running);
      console.log(`Workspace already running at ${running} — opened a window on it.`);
      return;
    }
  }

  const store = new Store();
  const shell = await startShell({ store, port, modules: APPS });

  const extractor = shell.app<CurlExtractorApp>(CURL_EXTRACTOR_ID);

  // `start` and `attach` skip the launch screen: the user has already said what
  // they want, so asking for it again in the UI would be a step backwards.
  const autoCapture = args.command === 'start' || args.command === 'attach';

  if (args.command === 'ui' && typeof args.flags['session'] === 'string' && extractor) {
    if (!extractor.viewSession(args.flags['session'])) {
      console.error(`No session ${args.flags['session']} — showing the most recent instead.`);
    }
  }

  if (autoCapture && extractor) {
    try {
      await extractor.capture.start({
        url: args.positional[0],
        label: typeof args.flags['label'] === 'string' ? args.flags['label'] : undefined,
        headless: args.flags['headless'] === true,
        resume: args.flags['resume'] === true,
        keep: args.flags['keep'] === true,
        attachPort:
          args.command === 'attach' ? Number(args.flags['port'] ?? 9222) : undefined,
      });
      console.log(
        `Capturing with ${extractor.capture.browserName ?? 'the browser'}` +
          (args.positional[0] ? ` at ${args.positional[0]}` : ''),
      );
    } catch (err) {
      // The workspace still comes up: the failure is reported there too, and a
      // dead Chrome launch should not cost the user the rest of the tool.
      console.error(
        `Could not start the capture: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const landing =
    autoCapture || args.command === 'ui'
      ? `${shell.url}/apps/${CURL_EXTRACTOR_ID}`
      : shell.url;

  console.log('');
  console.log(`  Workspace   ${landing}`);
  console.log(`  Filters     ${FILTERS_PATH}`);
  console.log(`  Version     ${VERSION} — beta, so check what it produces`);
  console.log('');
  console.log(
    desktop
      ? 'Close the window to quit.'
      : autoCapture
        ? 'Browse the site as you normally would. Press Ctrl-C when finished.'
        : 'Pick a utility from the dashboard. Press Ctrl-C to close the workspace.',
  );

  // Deliberately not awaited: whether a newer release exists has no bearing on
  // whether this one can open, and nobody should wait on GitHub to see a
  // dashboard that runs entirely on their own machine.
  void checkForUpdateDaily().then((status) => {
    if (status?.available) {
      console.log(`\n  curlapi ${status.latest} is available — run \`curlapi update\`.`);
    }
  });

  if (args.flags['no-open'] !== true) {
    if (desktop) openWindow(landing);
    else openInBrowser(landing);
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    // A capture in flight is finalised and pruned before the process goes, which
    // is what `shell.close()` does by disposing each app.
    if (extractor?.capture.running) console.log('\nFinishing capture…');
    await shell.close();

    const summary = extractor?.capture.lastSummary ?? null;
    if (summary) {
      console.log(`Captured ${summary.total} requests.`);
      if (summary.discarded > 0) {
        console.log(
          `Discarded ${summary.discarded} of them; kept ${summary.retained} ` +
            `(${summary.documented} documented, the rest approved).`,
        );
      }
      if (!summary.sessionKept) {
        console.log('Nothing was selected, so this session was not kept.');
      } else {
        console.log(`${Math.round(summary.bytes / 1024)} KB stored in ${DB_PATH}`);
        console.log('');
        console.log('  curlapi                 Reopen the workspace');
        console.log('  curlapi start --resume  Capture more into this same session');
        console.log('  curlapi start --keep    Next time, keep the whole capture');
      }
    }

    store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // There is no terminal behind a desktop launch, so closing the window is the
  // only quit gesture available. It runs the same shutdown Ctrl-C would, which
  // is what finalises a capture that was still recording.
  if (desktop) watchForClose(shell, () => void shutdown());
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

/**
 * Installs the newest release, or reports on one.
 *
 * Deliberately its own short-lived process rather than something the workspace
 * does to itself while running: the files being replaced are the ones this
 * program is executing from, and a module imported lazily after the swap would
 * be read from the new version while everything already loaded came from the
 * old one.
 */
async function runUpdate(args: Args): Promise<void> {
  console.log('Checking for a newer release…');
  const status = await checkForUpdate();

  if (!status.latest) {
    console.error(status.checkError ?? 'Could not work out whether there is a newer release.');
    process.exit(1);
  }

  if (!status.available) {
    console.log(`curlapi ${status.current} is the newest release.`);
    return;
  }

  console.log(`curlapi ${status.latest} is available — this is ${status.current}.`);

  if (args.flags['check'] === true) {
    console.log('Run `curlapi update` to install it.');
    return;
  }

  if (!status.updatable) {
    console.error('');
    console.error(status.reason);
    process.exit(1);
  }

  try {
    await applyUpdate(status.release!, (message) => console.log(`  ${message}…`));
  } catch (err) {
    console.error('');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log('');
  console.log(`Updated to ${status.latest}. Reopen curlapi to run it.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'serve':
    case 'app':
    case 'start':
    case 'attach':
    case 'ui':
      await runShell(args);
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
    case 'update':
      await runUpdate(args);
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
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
