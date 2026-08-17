/**
 * A curl command someone pasted into the document, in whatever state it arrived.
 *
 * The literal text from one of the samples:
 *
 *   curl --location ‘http://host/service/api/Challandetails'
 *   header 'Api-Key: joxNe…'
 *   header 'Content-Type: application/json'
 *   Request Parameter:
 *   data '{
 *   "challanNo": "29308"
 *   }'
 *
 * Three things have happened to it. The opening quote is curly and the closing
 * one is not, so quote matching cannot assume symmetry. The `--` in front of
 * `header` and `data` is *gone* — Word ate it — so flags have to be recognised
 * by name. And the command is split across paragraphs with the shell's
 * backslash continuations stripped, so where it ends has to be judged rather
 * than read.
 *
 * A parser that insisted on well-formed input would find nothing here, and this
 * is the form the person actually has to work from.
 */

import type { HeaderPair } from '../../../types.ts';
import type { Block } from '../ingest/model.ts';
import { isParagraph } from '../ingest/model.ts';
import { normalizeText, squash } from '../normalize.ts';
import { inferMime, isHeaderName, tidyJson } from './shared.ts';
import type { Candidate } from './candidate.ts';

/**
 * Flags we understand, with their aliases.
 *
 * Matched with an optional `--` prefix precisely because the dashes go missing.
 * The risk of a false positive is low: a prose line beginning `data '{` is a
 * curl fragment in every document that contains one.
 */
const FLAGS: Record<string, string> = {
  location: 'location',
  request: 'request',
  X: 'request',
  header: 'header',
  H: 'header',
  data: 'data',
  d: 'data',
  'data-raw': 'data',
  'data-binary': 'data',
  'data-urlencode': 'data-urlencode',
  form: 'form',
  F: 'form',
  user: 'user',
  u: 'user',
  url: 'url',
  compressed: 'flag',
  insecure: 'flag',
  k: 'flag',
  L: 'location',
  s: 'flag',
  silent: 'flag',
  i: 'flag',
  v: 'flag',
  G: 'get',
  get: 'get',
};

/**
 * A label introducing the request payload — `Request Parameter:`, `Body:`.
 *
 * These sit *inside* the pasted command in the samples, between the `header`
 * lines and the `data` line, because the person pasted the command in pieces
 * and annotated it. Treating one as the end of the command loses the body
 * entirely, which is how a documented POST turns into a GET.
 */
const REQUEST_LABEL = /^request\s*(parameter|body|payload|data)?s?\s*:?\s*$/i;

/** A label introducing the expected response, which does end the command. */
const RESPONSE_LABEL = /^(response|sample\s*response|output)\s*(parameter|body|payload|code)?s?\s*:?\s*$/i;

/**
 * Collects the paragraphs that belong to one pasted command.
 *
 * A command runs from the `curl` line until something is plainly not part of it:
 * a heading, a response label, or a new command. Quote depth is tracked so a
 * multi-line JSON body inside `data '…'` is kept whole even though its lines
 * look like prose on their own.
 */
function collectCommand(
  blocks: Block[],
  startIndex: number,
): { text: string; blocks: number[]; endedAt: number } {
  const parts: string[] = [];
  const used: number[] = [];
  let open = false;
  let i = startIndex;

  for (; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isParagraph(block)) break;

    const text = normalizeText(block.text);
    const trimmed = text.trim();

    if (i > startIndex && !open) {
      if (block.headingLevel > 0) break;
      if (RESPONSE_LABEL.test(trimmed)) break;
      if (/^curl\b/i.test(trimmed)) break;
      // An annotation between the flags: skip the label, keep collecting.
      if (REQUEST_LABEL.test(trimmed)) {
        used.push(block.index);
        continue;
      }
      // Otherwise only continuation-looking lines belong.
      if (!isContinuation(trimmed)) break;
    }

    parts.push(text);
    used.push(block.index);

    // Count unescaped single quotes across everything so far. An odd total
    // means a value is still open and the next paragraph continues it.
    open = (parts.join('\n').match(/(?<!\\)'/g) ?? []).length % 2 === 1;
  }

  return { text: parts.join('\n'), blocks: used, endedAt: i };
}

/**
 * The response a document shows under `Response Parameter:` after a command.
 *
 * Worth collecting rather than skipping: it is the only statement of what the
 * endpoint returns, and having it beside a real run is what makes the run
 * meaningful — a 200 with a different shape than documented is the finding.
 */
function collectResponse(
  blocks: Block[],
  startIndex: number,
): { text: string | null; blocks: number[] } {
  const first = blocks[startIndex];
  if (!first || !isParagraph(first) || !RESPONSE_LABEL.test(normalizeText(first.text).trim())) {
    return { text: null, blocks: [] };
  }

  const parts: string[] = [];
  const used = [first.index];
  let depth = 0;
  let started = false;

  for (let i = startIndex + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isParagraph(block)) break;
    const text = normalizeText(block.text);
    const trimmed = text.trim();

    if (!started) {
      // The body has to start with a brace; anything else means the label was
      // introducing prose rather than a payload.
      if (!/^[{[]/.test(trimmed)) break;
      started = true;
    } else if (depth === 0) {
      break;
    }

    parts.push(text);
    used.push(block.index);
    for (const char of trimmed) {
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
    }
    if (depth <= 0) break;
  }

  return { text: parts.length > 0 ? parts.join('\n') : null, blocks: used };
}

/** True when a line looks like more of a command rather than a new thought. */
function isContinuation(line: string): boolean {
  if (line.length === 0) return false;
  if (line.startsWith('-')) return true;
  const firstWord = line.split(/[\s'"]/)[0];
  return Object.hasOwn(FLAGS, firstWord);
}

type Token = { value: string; quoted: boolean };

/**
 * Splits a command into tokens, honouring quotes.
 *
 * Asymmetric quoting is the point: `‘http://host/x'` has been normalised to
 * `'http://host/x'` by the time it gets here, but a value may still open with a
 * quote and never close it because the document dropped the closing one. An
 * unclosed quote therefore runs to the end of the line rather than swallowing
 * the rest of the command.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // A backslash at end of line is a shell continuation, not a token.
    if (char === '\\' && (command[i + 1] === '\n' || command[i + 1] === undefined)) {
      i += 2;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let value = '';
      i++;
      while (i < command.length && command[i] !== quote) {
        if (command[i] === '\\' && command[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        // Unterminated: stop at the line end so one lost quote costs one value
        // rather than everything after it.
        if (command[i] === '\n' && !command.slice(i + 1).includes(quote)) break;
        value += command[i];
        i++;
      }
      i++; // past the closing quote, or past the line end
      tokens.push({ value, quoted: true });
      continue;
    }

    let value = '';
    while (i < command.length && !/\s/.test(command[i])) {
      value += command[i];
      i++;
    }
    tokens.push({ value, quoted: false });
  }

  return tokens;
}

/** Normalises `--header`, `-H` and a dash-stripped `header` to one name. */
function flagOf(token: Token): string | null {
  if (token.quoted) return null;
  const bare = token.value.replace(/^-+/, '');
  if (bare.length === 0) return null;
  const known = FLAGS[bare];
  if (!known) return null;
  // A bare word is only a flag if the dashes plausibly went missing; a quoted
  // or mid-URL occurrence is not one.
  return known;
}

export function extractCurl(blocks: Block[]): Candidate[] {
  const candidates: Candidate[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isParagraph(block)) continue;
    if (!/^\s*curl\b/i.test(normalizeText(block.text))) continue;

    const { text, blocks: used, endedAt } = collectCommand(blocks, i);
    const response = collectResponse(blocks, endedAt);

    const candidate = parseCurl(text, [...used, ...response.blocks]);
    if (!candidate) continue;

    if (response.text) {
      candidate.documentedResponse = tidyJson(response.text).text;
    }
    candidates.push(candidate);
    // Resume past what this command consumed, so its own body lines are not
    // scanned again as if they started something.
    i = Math.max(i, endedAt - 1);
  }

  return candidates;
}

/** Parses one complete curl command into a candidate. */
export function parseCurl(command: string, blocks: number[]): Candidate | null {
  const tokens = tokenize(normalizeText(command).replace(/^\s*curl\b/i, ''));

  const headers: HeaderPair[] = [];
  const dataParts: string[] = [];
  const formParts: string[] = [];
  const warnings: string[] = [];
  let url: string | null = null;
  let method: string | null = null;
  let user: string | null = null;
  let forceGet = false;

  for (let i = 0; i < tokens.length; i++) {
    const flag = flagOf(tokens[i]);

    if (!flag) {
      // A bare token is the URL. The first one wins; curl allows several but a
      // document never means to describe more than one endpoint per command.
      if (!url && /^(https?:\/\/|\/\/|[\w.-]+\.[a-z]{2,})/i.test(tokens[i].value)) {
        url = tokens[i].value;
      }
      continue;
    }

    const next = tokens[i + 1];
    switch (flag) {
      case 'location':
      case 'url':
        // `--location` takes the URL when it is followed by one, and is a bare
        // "follow redirects" flag otherwise.
        if (next && !flagOf(next) && /^(https?:)?\/\//i.test(next.value)) {
          url = next.value;
          i++;
        }
        break;
      case 'request':
        if (next) {
          method = squash(next.value).toUpperCase();
          i++;
        }
        break;
      case 'header':
        if (next) {
          const colon = next.value.indexOf(':');
          if (colon > 0) {
            const name = next.value.slice(0, colon).trim();
            const value = next.value.slice(colon + 1).trim();
            if (isHeaderName(name)) headers.push([name, value]);
          }
          i++;
        }
        break;
      case 'data':
      case 'data-urlencode':
        if (next) {
          dataParts.push(next.value);
          i++;
        }
        break;
      case 'form':
        if (next) {
          formParts.push(next.value);
          i++;
        }
        break;
      case 'user':
        if (next) {
          user = next.value;
          i++;
        }
        break;
      case 'get':
        forceGet = true;
        break;
      default:
        break;
    }
  }

  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/\//, '')}`;

  let body: string | null = null;
  if (formParts.length > 0) {
    body = formParts.join('\n');
    if (!headers.some(([name]) => name.toLowerCase() === 'content-type')) {
      headers.push(['Content-Type', 'multipart/form-data']);
    }
  } else if (dataParts.length > 0) {
    body = tidyJson(dataParts.join('&')).text;
  }

  // curl's own rule: a body implies POST unless -G or an explicit method says
  // otherwise. Getting this wrong turns a documented POST into a GET that 405s.
  const resolved = method ?? (body && !forceGet ? 'POST' : 'GET');

  if (user) {
    headers.push([
      'Authorization',
      `Basic ${Buffer.from(user, 'utf8').toString('base64')}`,
    ]);
  }

  if (body && !tidyJson(body).valid && /^[{[]/.test(body.trim())) {
    warnings.push(
      'The body of this curl command looks like JSON but does not parse — the ' +
        'document may have mangled a quote.',
    );
  }

  return {
    method: resolved,
    url,
    environments: [],
    headers,
    body,
    bodyMime: inferMime(body, headers),
    documentedResponse: null,
    blocks,
    extractor: 'curl',
    // Below a spec table: the command is unambiguous, but recovering it from a
    // mangled paste involves guesses a table does not require.
    confidence: 0.85,
    warnings,
  };
}
