/**
 * Finds and decodes JWTs sitting in request headers.
 *
 * Captured commands for authenticated endpoints have a shelf life, and it is
 * usually much shorter than people expect: a gateway token might last hours
 * while the session token beside it lasts thirty minutes and a transaction token
 * five. When a replay comes back 401 the useful answer is not "credentials may
 * have expired" but "x-token expired 47 minutes ago; it only lives 30 minutes".
 *
 * Written without Node built-ins so the UI can share it.
 */

export type TokenInfo = {
  /** Header the token was found in, lowercased. */
  header: string;
  issuedAt: number | null;
  expiresAt: number | null;
  /** Seconds between issue and expiry, when both are present. */
  lifetimeSeconds: number | null;
};

/** Three base64url segments, the first of which decodes to a JSON object. */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

function base64UrlDecode(input: string): string | null {
  try {
    const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function decodeClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const json = base64UrlDecode(parts[1]);
  if (!json) return null;
  try {
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function findTokens(headers: Array<[string, string]>): TokenInfo[] {
  const found: TokenInfo[] = [];

  for (const [rawName, value] of headers) {
    const match = JWT_PATTERN.exec(value);
    if (!match) continue;
    const claims = decodeClaims(match[0]);
    if (!claims) continue;

    const issued = asSeconds(claims['iat']);
    const expires = asSeconds(claims['exp']);
    // A JWT with no expiry claim tells us nothing useful about shelf life.
    if (expires === null) continue;

    found.push({
      header: rawName.toLowerCase().replace(/^:/, ''),
      issuedAt: issued === null ? null : issued * 1000,
      expiresAt: expires * 1000,
      lifetimeSeconds: issued === null ? null : expires - issued,
    });
  }

  return found;
}

export function expiredTokens(tokens: TokenInfo[], now: number = Date.now()): TokenInfo[] {
  return tokens.filter((token) => token.expiresAt !== null && token.expiresAt <= now);
}

/** The token that will expire first — the real shelf life of the command. */
export function shortestLived(tokens: TokenInfo[]): TokenInfo | null {
  let best: TokenInfo | null = null;
  for (const token of tokens) {
    if (token.expiresAt === null) continue;
    if (best === null || token.expiresAt < best.expiresAt!) best = token;
  }
  return best;
}

function humanDuration(seconds: number): string {
  const value = Math.abs(Math.round(seconds));
  if (value < 90) return `${value} sec`;
  if (value < 5400) return `${Math.round(value / 60)} min`;
  return `${(value / 3600).toFixed(1)} hr`;
}

/** e.g. "expired 47 min ago" or "expires in 12 min". */
export function describeExpiry(token: TokenInfo, now: number = Date.now()): string {
  if (token.expiresAt === null) return 'no expiry claim';
  const delta = (token.expiresAt - now) / 1000;
  return delta <= 0
    ? `expired ${humanDuration(delta)} ago`
    : `expires in ${humanDuration(delta)}`;
}

export function describeLifetime(token: TokenInfo): string | null {
  if (token.lifetimeSeconds === null) return null;
  return `lives ${humanDuration(token.lifetimeSeconds)}`;
}
