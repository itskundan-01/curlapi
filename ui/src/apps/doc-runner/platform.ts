import type { CurlOptions } from './api.ts';

/**
 * The shell the person reading this page actually has.
 *
 * A command copied in POSIX quoting and pasted into PowerShell fails in a way
 * that looks like the endpoint is broken — single quotes do not nest the same
 * way, and `--data-raw $'…'` is meaningless there. Defaulting to the viewer's
 * own shell is the difference between "copy, paste, run" and "copy, paste,
 * puzzle, find the dropdown".
 *
 * The workspace serves whoever opens it, which need not be the machine it runs
 * on, so this is decided in the browser rather than from `process.platform`.
 * The override stays available for the case where somebody is copying a command
 * for a colleague on the other kind of machine.
 */
export function detectShell(): CurlOptions['shell'] {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = data?.platform ?? navigator.platform ?? navigator.userAgent ?? '';
  return /win/i.test(platform) ? 'powershell' : 'posix';
}

export function shellLabel(shell: CurlOptions['shell']): string {
  return shell === 'powershell' ? 'PowerShell' : 'bash / zsh';
}

/** Curl options seeded for this machine. */
export function defaultCurlOptions(): CurlOptions {
  return { clean: false, redact: false, shell: detectShell(), singleLine: false };
}
