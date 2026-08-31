/* Opens the dashboard, imports a squad, and screenshots every tab.
   Usage: node tools/screenshot.mjs [file|http]
   `file` mode proves the app works with no server at all.                    */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT = join(ROOT, 'tests/screenshots');
const MODE = process.argv[2] || 'http';
const FIXTURE = join(ROOT, 'tests/fixtures/squad-150.csv');

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter(x => x.startsWith('chromium-')).sort().reverse()) {
    const bin = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv' };

let server, baseURL;
if (MODE === 'http') {
  server = createServer(async (req, res) => {
    try {
      const p = new URL(req.url, 'http://l').pathname;
      const file = join(ROOT, decodeURIComponent(p === '/' ? '/index.html' : p));
      await stat(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, r));
  baseURL = `http://127.0.0.1:${server.address().port}`;
} else {
  baseURL = 'file://' + join(ROOT, 'index.html');
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

console.log(`Loading ${baseURL}`);
await page.goto(baseURL, { waitUntil: 'load' });
await page.waitForTimeout(600);

await page.setInputFiles('#file-input', FIXTURE);
await page.waitForFunction(() => window.__swimtracker?.state?.dataset?.swimmers?.size > 100,
  { timeout: 40000 });
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const ds = window.__swimtracker.state.dataset;
  return { swimmers: ds.swimmers.size, races: ds.races.length, storage: window.STStore.status() };
});
console.log(`  ${info.swimmers} swimmers, ${info.races} races, storage=${info.storage.mode}`);
if (info.storage.lastError) console.log('  storage note:', info.storage.lastError);

for (const tab of ['squad', 'swimmer', 'events', 'coverage', 'results', 'data']) {
  await page.click('#tab-' + tab);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: join(OUT, `${MODE}-${tab}.png`), fullPage: false });
  console.log(`  captured ${tab}`);
}

if (errors.length) {
  console.log('\nERRORS:\n' + errors.join('\n'));
} else {
  console.log('\nNo page or console errors.');
}

await browser.close();
if (server) server.close();
process.exit(errors.length ? 1 : 0);
