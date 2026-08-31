/* Stress check: push well past the 150-swimmer requirement and time the
   things a coach actually waits for.
   Usage: node tools/stress.mjs [swimmers]                                   */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const COUNT = parseInt(process.argv[2], 10) || 400;
const FIXTURE = join(ROOT, `tests/fixtures/stress-${COUNT}.csv`);

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter(x => x.startsWith('chromium-')).sort().reverse()) {
    const bin = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

console.log(`Generating a ${COUNT}-swimmer fixture…`);
execFileSync('node', [join(ROOT, 'tools/make-fixture.mjs'), String(COUNT), FIXTURE], { stdio: 'inherit' });
console.log(`Fixture size: ${(statSync(FIXTURE).size / 1024 / 1024).toFixed(2)} MB\n`);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv' };
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://l').pathname;
    const f = join(ROOT, decodeURIComponent(p === '/' ? '/index.html' : p));
    await stat(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', e => errors.push('PAGE ERROR: ' + e));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(baseURL, { waitUntil: 'networkidle' });

async function timed(label, fn) {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  const flag = ms > 2000 ? '  <-- SLOW' : '';
  console.log(`  ${label.padEnd(42)} ${String(ms).padStart(6)} ms${flag}`);
  return ms;
}

console.log('Timings:');
await timed('import + index + first render', async () => {
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForFunction(n => window.__swimtracker?.state?.dataset?.swimmers?.size >= n,
    COUNT, { timeout: 120000 });
  await page.waitForSelector('#squad-table .vrow');
});

const stats = await page.evaluate(() => {
  const ds = window.__swimtracker.state.dataset;
  return { swimmers: ds.swimmers.size, races: ds.races.length, storage: window.STStore.status().mode };
});
console.log(`\n  ${stats.swimmers} swimmers · ${stats.races.toLocaleString()} races · storage: ${stats.storage}\n`);

for (const tab of ['swimmer', 'events', 'coverage', 'results']) {
  await timed(`open ${tab} tab`, async () => {
    await page.click('#tab-' + tab);
    await page.waitForTimeout(60);
  });
}

await page.click('#tab-results');
await timed('filter results to PBs only', async () => {
  await page.selectOption('#res-show', 'pb');
  await page.waitForTimeout(60);
});
await timed('sort results by time', async () => {
  await page.click('#res-table .vhead [data-key="seconds"]');
  await page.waitForTimeout(60);
});
await timed('scroll to the end of the results', async () => {
  await page.evaluate(() => {
    const s = document.querySelector('#res-table .vscroll');
    s.scrollTop = s.scrollHeight;
  });
  await page.waitForTimeout(120);
});
await page.selectOption('#res-show', 'all');

await page.click('#tab-squad');
await timed('search the squad table', async () => {
  await page.fill('#squad-search', 'a');
  await page.waitForTimeout(320);
});
await page.fill('#squad-search', '');

const dom = await page.evaluate(() => ({
  total: document.querySelectorAll('*').length,
  resultRows: document.querySelectorAll('#res-table .vrow').length,
  squadRows: document.querySelectorAll('#squad-table .vrow').length
}));
console.log(`\n  DOM: ${dom.total.toLocaleString()} elements total; ` +
  `${dom.resultRows} result rows and ${dom.squadRows} squad rows rendered`);

// Narrow viewport — a coach on a tablet at the pool.
await page.setViewportSize({ width: 820, height: 1000 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log(`  Horizontal page overflow at 820px wide: ${overflow}px` +
  (overflow > 2 ? '  <-- the page itself should not scroll sideways' : '  (none)'));

console.log(errors.length ? `\nERRORS:\n${errors.join('\n')}` : '\nNo page or console errors.');

await browser.close();
server.close();
process.exit(errors.filter(e => !/net::ERR|fonts\./.test(e)).length ? 1 : 0);
