/**
 * Reproduces the "Name" column of Chrome's Network tab, which is how the user
 * already recognises their requests: `/AccountV3Api/prod/profile/enrollment/verify`
 * shows up simply as `verify`.
 */

const MAX_QUERY_LENGTH = 24;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function pathSegments(url: string): string[] {
  return parse(url)?.pathname.split('/').filter(Boolean) ?? [];
}

export function shortName(url: string): string {
  const parsed = parse(url);
  if (!parsed) return url.slice(0, 40);

  const segments = parsed.pathname.split('/').filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : parsed.hostname;

  if (!parsed.search) return base;

  const query =
    parsed.search.length > MAX_QUERY_LENGTH
      ? parsed.search.slice(0, MAX_QUERY_LENGTH) + '…'
      : parsed.search;
  return base + query;
}

/** Name including `depth` extra parent segments, e.g. `enrollment/verify`. */
function widen(url: string, depth: number): string {
  const segments = pathSegments(url);
  const base = shortName(url);
  if (segments.length <= depth) return base;
  const prefix = segments.slice(-(depth + 1), -1).join('/');
  return prefix ? `${prefix}/${base}` : base;
}

function groupsOf(names: string[]): number[][] {
  const byName = new Map<string, number[]>();
  names.forEach((name, index) => {
    const bucket = byName.get(name) ?? [];
    bucket.push(index);
    byName.set(name, bucket);
  });
  return [...byName.values()].filter((group) => group.length > 1);
}

/**
 * Makes each entry recognisable within its list.
 *
 * Uniqueness is a property of the list rather than of any single URL, so this
 * works over all of them at once: first widen with parent path segments, but
 * only where that actually separates the conflicting entries — otherwise every
 * name picks up a useless prefix like `1/`. Whatever still collides differs only
 * by host (five `/1/isalive` probes across five Algolia servers), so the host is
 * what gets appended. Genuinely repeated calls to one endpoint keep the same
 * name, which is correct — their serial numbers tell them apart.
 */
export function disambiguate(urls: string[]): string[] {
  const names = urls.map((url) => shortName(url));

  for (let depth = 1; depth <= 3; depth++) {
    const conflicts = groupsOf(names);
    if (conflicts.length === 0) return names;

    let progressed = false;
    for (const group of conflicts) {
      const candidates = group.map((index) => widen(urls[index], depth));
      // Only accept the wider form if it tells these entries apart.
      if (new Set(candidates).size > 1) {
        group.forEach((index, position) => {
          names[index] = candidates[position];
        });
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  for (const group of groupsOf(names)) {
    const hosts = group.map((index) => parse(urls[index])?.host ?? '');
    if (new Set(hosts).size <= 1) continue;
    group.forEach((index, position) => {
      names[index] = `${names[index]} (${hosts[position]})`;
    });
  }

  return names;
}
