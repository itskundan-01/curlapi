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
 * The same string, quoted to be read rather than to match Chrome.
 *
 * Chrome's escaping turns a JSON body into one unreadable line —
 * `--data-raw $'{\n  "brandNo": "1",\n  "qty": 2\n}'` — because ANSI-C quoting
 * is the only way to keep the command on a single line. A document's own curl
 * commands, and the ones Postman generates, instead put the payload across the
 * lines it was written on:
 *
 *     --data-raw '{
 *       "brandNo": "1",
 *       "qty": 2
 *     }'
 *
 * Both run identically in bash and zsh — a newline inside single quotes is
 * simply a newline. This form is used where the command is something a person
 * reads (the document app), and Chrome's is kept where the command is something
 * to diff against DevTools (the capture app).
 *
 * Falls back to the strict form for anything a literal quote cannot carry: a
 * control character other than tab or newline would be invisible in the output.
 */
export function escapePosixReadable(value: string): string {
  if (/[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(value)) return escapePosix(value);
  // A single quote cannot appear inside single quotes at all; the shell's own
  // idiom is to close, emit an escaped quote, and reopen.
  return "'" + value.replace(/'/g, "'\\''") + "'";
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

/** As `escapeFor`, but keeping a multi-line payload readable. */
export function escapeBodyFor(
  shell: 'posix' | 'powershell',
  value: string,
  readable: boolean,
): string {
  if (!readable) return escapeFor(shell, value);
  // PowerShell's literal string already carries newlines as themselves.
  return shell === 'powershell' ? escapePowerShell(value) : escapePosixReadable(value);
}

/**
 * curl applies glob expansion to the URL even when the shell has already quoted
 * it, so `[`, `]`, `{` and `}` must be backslash-escaped or a URL containing
 * them is silently rewritten. Chrome does exactly this substitution.
 */
export function escapeUrlGlobs(quotedUrl: string): string {
  return quotedUrl.replace(/[[{}\]]/g, '\\$&');
}
