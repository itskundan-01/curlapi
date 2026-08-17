import { useEffect, useState } from 'react';
import {
  findTokens,
  expiredTokens,
  shortestLived,
  describeExpiry,
  describeLifetime,
} from '@core/analyze/tokens.ts';
import type { HeaderPair } from '@core/types.ts';

/** Re-renders on a timer so a countdown does not sit there going stale. */
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Shows the shelf life of a captured command.
 *
 * Authenticated endpoints usually carry several tokens with wildly different
 * lifetimes, and the shortest one decides how long the command remains usable.
 * Saying so up front turns a mystifying 401 into an expected one.
 */
export function TokenChips({ headers }: { headers: HeaderPair[] }) {
  const now = useNow();
  const tokens = findTokens(headers);
  if (tokens.length === 0) return null;

  const dead = new Set(expiredTokens(tokens, now).map((token) => token.header));

  return (
    <div className="chips">
      {tokens.map((token) => {
        const lifetime = describeLifetime(token);
        return (
          <span
            key={token.header}
            className={`badge ${dead.has(token.header) ? 'err' : 'ok'}`}
            title={lifetime ? `${token.header} ${lifetime}` : token.header}
          >
            {token.header} · {describeExpiry(token, now)}
          </span>
        );
      })}
    </div>
  );
}

/** One-line summary of why a replay failed, when tokens explain it. */
export function TokenExplanation({
  headers,
  status,
}: {
  headers: HeaderPair[];
  status: number | null;
}) {
  const now = useNow();
  if (status !== 401 && status !== 403) return null;

  const tokens = findTokens(headers);
  const dead = expiredTokens(tokens, now);
  if (dead.length === 0) {
    if (tokens.length === 0) return null;
    return (
      <span className="hint">
        the tokens in this request are still valid, so the rejection is coming from
        something else — a nonce, an IP check, or a one-time transaction id
      </span>
    );
  }

  const shortest = shortestLived(tokens);
  const lifetime = shortest ? describeLifetime(shortest) : null;

  return (
    <span className="hint">
      {dead.map((token) => `${token.header} ${describeExpiry(token, now)}`).join(', ')}
      {lifetime && shortest ? ` — ${shortest.header} only ${lifetime}, so re-capture and run within that window` : ''}
    </span>
  );
}

/** Warns before running that this command has a short shelf life. */
export function ShelfLifeNote({ headers }: { headers: HeaderPair[] }) {
  const now = useNow();
  const tokens = findTokens(headers);
  const shortest = shortestLived(tokens);
  if (!shortest) return null;

  const expired = shortest.expiresAt !== null && shortest.expiresAt <= now;
  const lifetime = describeLifetime(shortest);

  return (
    <p className={`hint ${expired ? 'stale' : ''}`}>
      {expired
        ? `This command has expired — ${shortest.header} ${describeExpiry(shortest, now)}. Re-capture it to get a working one.`
        : `Shelf life: ${shortest.header} ${describeExpiry(shortest, now)}${lifetime ? ` (${lifetime})` : ''}.`}
    </p>
  );
}
