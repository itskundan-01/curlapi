import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export type BrowserInfo = {
  path: string;
  name: string;
};

/**
 * Candidate binaries in preference order. Chrome first, then Chromium-family
 * alternatives — all speak the same DevTools protocol, so any of them works.
 */
function macCandidates(): Array<[string, string]> {
  return [
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium'],
    ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary', 'Chrome Canary'],
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge'],
    ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'],
  ];
}

function windowsCandidates(): Array<[string, string]> {
  const roots = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA'],
  ].filter((r): r is string => Boolean(r));

  const out: Array<[string, string]> = [];
  for (const root of roots) {
    out.push([join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome']);
    out.push([join(root, 'Chromium', 'Application', 'chrome.exe'), 'Chromium']);
    out.push([join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge']);
    out.push([
      join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      'Brave',
    ]);
  }
  return out;
}

const LINUX_COMMANDS: Array<[string, string]> = [
  ['google-chrome', 'Google Chrome'],
  ['google-chrome-stable', 'Google Chrome'],
  ['chromium', 'Chromium'],
  ['chromium-browser', 'Chromium'],
  ['microsoft-edge', 'Microsoft Edge'],
  ['brave-browser', 'Brave'],
];

function which(command: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Finds an installed Chromium-family browser. Honours CURLAPI_CHROME as an
 * explicit override so unusual installs don't need code changes.
 */
export function locateBrowser(): BrowserInfo | null {
  const override = process.env['CURLAPI_CHROME'];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CURLAPI_CHROME points at a file that does not exist: ${override}`);
    }
    return { path: override, name: 'Chrome (from CURLAPI_CHROME)' };
  }

  if (process.platform === 'linux') {
    for (const [command, name] of LINUX_COMMANDS) {
      const resolved = which(command);
      if (resolved) return { path: resolved, name };
    }
    return null;
  }

  const candidates = process.platform === 'win32' ? windowsCandidates() : macCandidates();
  for (const [path, name] of candidates) {
    if (existsSync(path)) return { path, name };
  }
  return null;
}

export function describeMissingBrowser(): string {
  return [
    'Could not find Chrome, Chromium, Edge or Brave on this machine.',
    'Install Google Chrome, or point the tool at an existing binary:',
    '',
    '  CURLAPI_CHROME="/path/to/chrome" curlapi start',
  ].join('\n');
}
