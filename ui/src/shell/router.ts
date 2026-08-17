import { useCallback, useEffect, useState } from 'react';

/**
 * Routing, in about forty lines.
 *
 * There are two kinds of page — the dashboard and one app — so a router library
 * would be more configuration than the thing it configures. The server serves
 * index.html for every non-API path, which is what lets these be real URLs the
 * user can reload and bookmark rather than fragments.
 */

export type Route = { name: 'dashboard' } | { name: 'app'; id: string };

export function parseRoute(pathname: string): Route {
  const match = /^\/apps\/([^/]+)/.exec(pathname);
  return match ? { name: 'app', id: match[1] } : { name: 'dashboard' };
}

export function pathFor(route: Route): string {
  return route.name === 'app' ? `/apps/${route.id}` : '/';
}

export function navigate(route: Route): void {
  const path = pathFor(route);
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  // pushState does not fire popstate, so the hook is told directly.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const read = useCallback(() => parseRoute(window.location.pathname), []);
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onChange = (): void => setRoute(read());
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, [read]);

  return route;
}
