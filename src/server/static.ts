import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { UI_DIST } from '../paths.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MISSING_UI_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>curlapi — UI not built</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 34rem;
         margin: 12vh auto; padding: 0 1.5rem; color: #1a1a1a; }
  code { background: #f1f1f0; padding: .15em .4em; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16161a; color: #e8e8ea; } code { background: #26262c; }
  }
</style>
<h1>The review UI has not been built yet</h1>
<p>Capture is running and requests are being recorded. To get the interface, run:</p>
<p><code>npm install &amp;&amp; npm run build:ui</code></p>
<p>then reload this page.</p>`;

export function serveStatic(pathname: string, res: ServerResponse): void {
  if (!existsSync(UI_DIST)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(MISSING_UI_PAGE);
    return;
  }

  // Resolve inside UI_DIST only — a traversal attempt must not escape it.
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let filePath = join(UI_DIST, relative);
  if (!filePath.startsWith(UI_DIST)) filePath = join(UI_DIST, 'index.html');

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(UI_DIST, 'index.html');
  }

  res.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}
