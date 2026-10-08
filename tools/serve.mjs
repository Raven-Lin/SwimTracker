/* A tiny static file server for local development.
   `npm run serve`, then open the URL it prints.

   You do NOT need this to use SwimTracker — opening index.html by
   double-clicking works. It exists only so the "Load sample data" button
   (which reads a file over HTTP) can be exercised while developing.        */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const target = normalize(join(ROOT, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
    // Refuse anything that escapes the project directory.
    if (!target.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    await stat(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(await readFile(target));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`SwimTracker dev server: http://localhost:${PORT}`);
  console.log('(You do not need this to use the app — index.html opens on its own.)');
});
