/**
 * Shell quoting that reproduces Chrome DevTools' own "Copy as cURL" output.
 *
 * The algorithm below is deliberately a port of Chrome's `escapeStringPosix`
 * rather than a cleaner equivalent. The goal is byte-identical output so a
 * generated command can be diffed against what DevTools produces; any "tidier"
 * quoting would still run correctly but would defeat that check.
 */

function escapeControlCharacter(character: string): string {
  const code = character.charCodeAt(0);
  // Pad so the following character can never be read as part of the escape.
  return code < 16 ? '\\u000' + code.toString(16) : '\\u00' + code.toString(16);
}

export function escapePosix(value: string): string {
  // Chrome switches to ANSI-C quoting for control characters, C1 characters,
  // `!` (history expansion) and `'` (which cannot be escaped inside '...').
  if (/[\0-\x1F\x7F-\x9F!]|'/.test(value)) {
    return (
      "$'" +
      value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/[\0-\x1F\x7F-\x9F!]/g, escapeControlCharacter) +
      "'"
    );
  }
  return "'" + value + "'";
}

/**
 * PowerShell literal string: single quotes, with embedded quotes doubled.
 * Backticks and `$` carry no meaning inside a single-quoted PowerShell string,
 * so nothing else needs escaping.
 */
export function escapePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function escapeFor(shell: 'posix' | 'powershell', value: string): string {
  return shell === 'powershell' ? escapePowerShell(value) : escapePosix(value);
}

/**
 * curl applies glob expansion to the URL even when the shell has already quoted
 * it, so `[`, `]`, `{` and `}` must be backslash-escaped or a URL containing
 * them is silently rewritten. Chrome does exactly this substitution.
 */
export function escapeUrlGlobs(quotedUrl: string): string {
  return quotedUrl.replace(/[[{}\]]/g, '\\$&');
}
