/**
 * Undoing what a word processor did to the text on its way in.
 *
 * This is not cosmetic. Every one of these substitutions was observed breaking a
 * real handed-over document:
 *
 * - Autocorrect turns `'` into `‘ ’` and `"` into `“ ”`, so a pasted
 *   `curl --header 'Api-Key: …'` arrives with quotes no shell accepts — and a
 *   body written `"brandNo”: "10009"` fails `JSON.parse` on the *closing* quote
 *   of a key, which is a genuinely baffling error to hit by hand.
 * - `--data` becomes `–data` (en dash), or loses its dashes entirely.
 * - Non-breaking spaces arrive as U+00A0 and survive `.trim()`, so a URL looks
 *   clean and still fails to parse.
 * - Zero-width characters ride along invisibly from copied web content.
 *
 * The originals are never useful to us, so this is applied once at read time
 * rather than defensively at each use.
 *
 * Written as escapes rather than literals: several of these are invisible or
 * indistinguishable from ASCII in an editor, which is exactly why they cause the
 * bugs they do.
 */

/** Curly single quotes and primes. Backtick is excluded — Markdown needs it. */
const SMART_SINGLE = /[‘’‚‛′´]/g;
const SMART_DOUBLE = /[“”„‟″«»]/g;
/** Hyphen variants, en/em dash, horizontal bar, minus sign. */
const DASHES = /[‐‑‒–—―−]/g;
/** Zero-width space / non-joiner / joiner, word joiner, BOM. */
const INVISIBLE = /[​‌‍⁠﻿]/g;
/** Non-breaking, en/em/thin/hair spaces, narrow no-break, ideographic space. */
const SPACES = /[  -   　]/g;

/**
 * Text as it was meant to be typed.
 *
 * Dashes are folded to ASCII `-`, which is what makes `–data` and `—location`
 * recoverable. It also rewrites prose hyphens, which is harmless: nothing
 * downstream distinguishes an en dash from a hyphen in a description.
 */
export function normalizeText(input: string): string {
  return input
    .replace(INVISIBLE, '')
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(DASHES, '-')
    .replace(SPACES, ' ')
    .replace(/\r\n?/g, '\n');
}

/** Collapses runs of whitespace, for comparing labels rather than storing text. */
export function squash(input: string): string {
  return normalizeText(input).replace(/\s+/g, ' ').trim();
}

/**
 * A label reduced to a comparison key: `Request Body\n(application/json)` and
 * `request body` both become `requestbody`.
 *
 * Parenthesised qualifiers are dropped because documents use them to note the
 * content type, which is information we want from the *value* rather than a
 * reason to fail to recognise the row.
 */
export function labelKey(input: string): string {
  return squash(input)
    .replace(/\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Strips the punctuation documents put between a label and its value.
 *
 * Seen in the samples: `Method :- GET`, `URL : https://…`, `Headers :-`,
 * `key - X-Api-Key`. The separator is not consistent even within one file.
 */
export function stripSeparator(input: string): string {
  return normalizeText(input).replace(/^\s*[:\-=]+\s*/, '').trim();
}

/**
 * Splits `Name - Value` / `Name: Value` into a pair, or null if there is no
 * separator to split on.
 *
 * Prefers the *first* separator so a value containing one — a URL's `https:`, a
 * token full of dashes — stays intact on the right-hand side. The name is capped
 * at 60 characters so a sentence containing a dash is not mistaken for a pair.
 */
export function splitPair(line: string): [string, string] | null {
  const text = normalizeText(line).trim();
  const match = /^([^:\-]{1,60}?)\s*[:\-]+\s*(.+)$/s.exec(text);
  if (!match) return null;
  const name = match[1].trim();
  const value = match[2].trim();
  if (name.length === 0 || value.length === 0) return null;
  return [name, value];
}
