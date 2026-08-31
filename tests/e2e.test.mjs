/* ============================================================================
   End-to-end tests — drives the real dashboard in a real browser.
   Run with: npm run test:e2e   (or `npm test`, which runs both suites)

   These check the things unit tests cannot: that the page actually loads with
   no console errors, that 150 swimmers render without freezing, that charts
   get drawn, that the virtualised table keeps the DOM small, and that a
   swimmer name containing markup is escaped rather than executed.
============================================================================ */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const FIXTURE = join(ROOT, 'tests/fixtures/squad-150.csv');

/**
 * Use a Chromium that is already on the machine when one is available, rather
 * than making every contributor download a second copy. CI images and dev
 * containers often ship a browser whose build number does not match the
 * pinned Playwright release; pointing at it directly avoids that mismatch.
 * Set SWIMTRACKER_CHROMIUM to override.
 */
function findChromium() {
  if (process.env.SWIMTRACKER_CHROMIUM) return process.env.SWIMTRACKER_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  const dirs = readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    const bin = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.csv': 'text/csv', '.json': 'application/json'
};

let server, browser, page, baseURL;
const consoleErrors = [];
const pageErrors = [];

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(ROOT, decodeURIComponent(rel));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      await stat(file);
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, r));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch({ executablePath: findChromium() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();

  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(baseURL, { waitUntil: 'networkidle' });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
});

/** Import the fixture CSV through the real file input. */
async function importFixture() {
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForFunction(
    () => window.__swimtracker?.state?.dataset?.swimmers?.size > 100,
    { timeout: 30000 }
  );
}

test('the first-run storage notice does not warn about losing data', async () => {
  // With nothing imported yet there is nothing to lose. Telling a coach their
  // zero races are "in memory only and will be lost" is alarming nonsense.
  const notice = await page.textContent('#storage-status');
  assert.match(notice, /No results loaded yet/);
  assert.doesNotMatch(notice, /will be lost/);
  assert.equal(await page.$$eval('#storage-status .notice-warn', n => n.length), 0);
});

test('a file that is not a results CSV is rejected with an explanation', async () => {
  const bogus = join(ROOT, 'tests/fixtures/not-results.csv');
  await writeFile(bogus, 'alpha,beta\n1,2\n', 'utf8');
  await page.setInputFiles('#file-input', bogus);
  await page.waitForSelector('#import-report .notice-error', { timeout: 10000 });
  const text = await page.textContent('#import-report');
  assert.match(text, /does not look like a results file/);
  assert.match(text, /name.*time|time.*name/i, 'says which columns are needed');
  // And the app is still usable rather than stuck.
  assert.equal(await page.isDisabled('#tab-squad'), true, 'still no data loaded');
  await rm(bogus, { force: true });
});

test('an empty CSV is reported, not silently ignored', async () => {
  const emptyFile = join(ROOT, 'tests/fixtures/empty.csv');
  await writeFile(emptyFile, '', 'utf8');
  await page.setInputFiles('#file-input', emptyFile);
  await page.waitForSelector('#import-report .notice-warn, #import-report .notice-error', { timeout: 10000 });
  assert.match(await page.textContent('#import-report'), /empty|does not look like/i);
  await rm(emptyFile, { force: true });
});

test('loads with no JavaScript errors', async () => {
  assert.equal(pageErrors.length, 0, 'page errors: ' + pageErrors.join('\n'));
  assert.equal(await page.title(), 'SwimTracker — Squad Dashboard');
});

test('starts on the Data tab with analysis tabs disabled', async () => {
  // With no data loaded there is nothing to analyse, so the tabs must not
  // offer a blank page.
  assert.equal(await page.getAttribute('#tab-data', 'aria-selected'), 'true');
  assert.equal(await page.isDisabled('#tab-squad'), true);
});

test('the vendored chart library loaded (no CDN, works offline)', async () => {
  assert.equal(await page.evaluate(() => typeof window.Chart), 'function');
});

test('imports a 150-swimmer CSV in reasonable time', async () => {
  const t0 = Date.now();
  await importFixture();
  const elapsed = Date.now() - t0;

  const info = await page.evaluate(() => {
    const ds = window.__swimtracker.state.dataset;
    return { swimmers: ds.swimmers.size, races: ds.races.length, quality: ds.quality };
  });

  // 150 generated swimmers, plus the three deliberately awkward ones the
  // fixture adds (no gender, a quoted/comma name, and a name made of markup).
  // 'Bad Row' is absent because every one of its rows is unusable.
  assert.equal(info.swimmers, 153, '150 generated swimmers plus 3 edge cases');
  assert.ok(info.races > 8000, `imported ${info.races} races`);
  assert.ok(elapsed < 20000, `import took ${elapsed}ms`);
});

test('skips unusable rows and removes duplicates on import', async () => {
  const q = await page.evaluate(() => window.__swimtracker.state.dataset.quality);
  assert.ok(q.rejected >= 3, `rejected ${q.rejected} bad rows (DQ, blank time, no name)`);
  assert.ok(q.duplicatesRemoved >= 1, `removed ${q.duplicatesRemoved} duplicates`);
});

test('moves to the Squad tab and enables the rest', async () => {
  assert.equal(await page.getAttribute('#tab-squad', 'aria-selected'), 'true');
  for (const t of ['squad', 'swimmer', 'events', 'coverage', 'results']) {
    assert.equal(await page.isDisabled('#tab-' + t), false, t + ' tab should be enabled');
  }
});

test('squad stats and both squad charts render', async () => {
  await page.waitForSelector('#squad-stats .stat');
  assert.ok((await page.$$('#squad-stats .stat')).length >= 5);

  const drawn = await page.evaluate(() => {
    const ids = ['chart-distribution', 'chart-improvement'];
    return ids.map(id => {
      const c = document.getElementById(id);
      return { id, w: c.width, h: c.height };
    });
  });
  drawn.forEach(d => {
    assert.ok(d.w > 0 && d.h > 0, `${d.id} has zero size`);
  });
});

test('the squad table virtualises: 151 rows, far fewer in the DOM', async () => {
  // This is the fix for the freeze. The old build created one <tr> per row via
  // `innerHTML +=`, which is quadratic and locked the browser up.
  const counts = await page.evaluate(() => ({
    rows: window.__swimtracker.state.dataset.swimmers.size,
    dom: document.querySelectorAll('#squad-table .vrow').length
  }));
  assert.equal(counts.rows, 153);
  assert.ok(counts.dom > 0, 'some rows are rendered');
  assert.ok(counts.dom < 60, `only ${counts.dom} rows in the DOM, not ${counts.rows}`);
});

test('squad search and filters narrow the table', async () => {
  const before = await page.textContent('#squad-count');
  await page.fill('#squad-search', 'Artemis');
  await page.waitForTimeout(320);
  const after = await page.textContent('#squad-count');
  assert.notEqual(before, after, 'count changed after searching');

  await page.fill('#squad-search', 'zzzznotarealswimmer');
  await page.waitForTimeout(320);
  assert.match(await page.textContent('#squad-count'), /^0 of/);
  assert.equal((await page.$$('#squad-table .vrow')).length, 0, 'empty result renders no rows');

  await page.fill('#squad-search', '');
  await page.waitForTimeout(320);
  assert.equal(await page.textContent('#squad-count'), before);
});

test('a swimmer name containing markup is escaped, not executed', async () => {
  // The fixture contains a swimmer literally named "<script>alert(1)</script>".
  await page.fill('#squad-search', 'script');
  await page.waitForTimeout(320);
  const cell = await page.textContent('#squad-table .vrow .name-cell');
  assert.equal(cell, '<script>alert(1)</script>', 'rendered as text');
  const injected = await page.evaluate(() =>
    document.querySelectorAll('#squad-table script').length);
  assert.equal(injected, 0, 'no script element was created');
  await page.fill('#squad-search', '');
  await page.waitForTimeout(320);
});

test('a name with a quote and comma survives the round trip', async () => {
  await page.fill('#squad-search', 'Jordan');
  await page.waitForTimeout(320);
  const cell = await page.textContent('#squad-table .vrow .name-cell');
  assert.equal(cell, 'Smith, Jordan "JJ"');
  await page.fill('#squad-search', '');
  await page.waitForTimeout(320);
});

test('clicking a squad row opens that swimmer', async () => {
  await page.click('#squad-table .vrow');
  await page.waitForSelector('#panel-swimmer:not([hidden])');
  assert.equal(await page.getAttribute('#tab-swimmer', 'aria-selected'), 'true');
  assert.ok((await page.inputValue('#sw-select')).length > 0);
});

test('all four swimmer charts render for the selected swimmer', async () => {
  await page.waitForFunction(() => {
    const ids = ['chart-progression', 'chart-formgap', 'chart-portfolio', 'chart-consistency'];
    return ids.every(id => {
      const c = document.getElementById(id);
      return c && c.width > 0;
    });
  }, { timeout: 10000 });

  const rows = await page.$$('#sw-events-body tr');
  assert.ok(rows.length > 0, 'best-times table is populated');
});

test('the progression chart plots dates, not just years', async () => {
  // Pick a swimmer who has actually raced an event several times, rather than
  // relying on whoever happens to sort first — the squad table's default sort
  // is by name, so the first row is not necessarily an interesting swimmer.
  const target = await page.evaluate(() => {
    const ds = window.__swimtracker.state.dataset;
    let best = null;
    ds.swimmers.forEach(sw => {
      sw.events.forEach(ev => {
        if (!best || ev.races.length > best.count) {
          best = { name: sw.name, eventKey: ev.eventKey, count: ev.races.length };
        }
      });
    });
    return best;
  });
  assert.ok(target && target.count > 1, `found ${target && target.count} races in one event`);

  await page.selectOption('#sw-select', target.name);
  await page.waitForTimeout(400);
  await page.selectOption('#sw-event', target.eventKey);
  await page.waitForTimeout(400);

  // The old build binned every swim into a calendar year, which hid tapers
  // and mid-season plateaus entirely.
  const xs = await page.evaluate(() => {
    const chart = Object.values(window.Chart.instances || {})
      .find(c => c.canvas && c.canvas.id === 'chart-progression');
    if (!chart) return null;
    const ds = chart.data.datasets.find(d => d.label === 'Race');
    return ds ? ds.data.slice(0, 40).map(p => p.x) : null;
  });
  assert.ok(xs && xs.length > 1, 'progression has points');
  // Timestamps, not year numbers.
  assert.ok(xs.every(x => x > 1e12), 'x values are millisecond timestamps');
});

test('changing the progression event redraws without error', async () => {
  const options = await page.$$eval('#sw-event option', os => os.map(o => o.value));
  assert.ok(options.length > 0);
  if (options.length > 1) {
    await page.selectOption('#sw-event', options[1]);
    await page.waitForTimeout(300);
  }
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
});

test('event rankings render and respect the age filter', async () => {
  await page.click('#tab-events');
  await page.waitForSelector('#panel-events:not([hidden])');
  await page.waitForSelector('#ev-body tr');

  const all = (await page.$$('#ev-body tr')).length;
  assert.ok(all > 0, 'rankings table populated');

  const ages = await page.$$eval('#ev-age option', os => os.map(o => o.value).filter(v => v !== 'all'));
  if (ages.length) {
    await page.selectOption('#ev-age', ages[Math.floor(ages.length / 2)]);
    await page.waitForTimeout(300);
    const filtered = (await page.$$('#ev-body tr')).length;
    assert.ok(filtered <= all, 'age filter narrows or holds the field');
    await page.selectOption('#ev-age', 'all');
    await page.waitForTimeout(300);
  }
});

test('ranking metric can switch between time and points', async () => {
  await page.click('#ev-metric button[data-metric="points"]');
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute('#ev-metric button[data-metric="points"]', 'aria-pressed'), 'true');
  const axis = await page.evaluate(() => {
    const chart = Object.values(window.Chart.instances || {})
      .find(c => c.canvas && c.canvas.id === 'chart-ranking');
    return chart ? chart.options.scales.x.title.text : null;
  });
  assert.match(String(axis), /points/i);
  await page.click('#ev-metric button[data-metric="seconds"]');
  await page.waitForTimeout(300);
});

test('the comparison picker caps at 8 swimmers', async () => {
  // 150 overlapping lines is a texture, not a chart. The cap is enforced.
  const boxes = await page.$$('#cmp-list input[type="checkbox"]');
  const target = Math.min(10, boxes.length);
  for (let i = 0; i < target; i++) {
    const fresh = await page.$$('#cmp-list input[type="checkbox"]:not(:disabled)');
    if (!fresh[0]) break;
    await fresh[0].check().catch(() => {});
    await page.waitForTimeout(90);
  }
  const picked = await page.evaluate(() => window.__swimtracker.state.comparison.length);
  assert.ok(picked > 0, 'at least one swimmer selected');
  assert.ok(picked <= 8, `selected ${picked}, cap is 8`);
});

test('coverage heatmap renders a swimmers x events grid', async () => {
  await page.click('#tab-coverage');
  await page.waitForSelector('#panel-coverage:not([hidden])');
  await page.waitForSelector('#cov-table tbody tr');

  const grid = await page.evaluate(() => ({
    rows: document.querySelectorAll('#cov-table tbody tr').length,
    cells: document.querySelectorAll('#cov-table td.cell').length,
    empty: document.querySelectorAll('#cov-table td.cell.empty').length
  }));
  assert.ok(grid.rows > 50, `${grid.rows} swimmer rows`);
  assert.ok(grid.cells > 100, `${grid.cells} cells`);
  assert.ok(grid.empty > 0, 'unraced events show as empty cells — that is the point of the view');
});

test('results tab virtualises tens of thousands of races', async () => {
  await page.click('#tab-results');
  await page.waitForSelector('#panel-results:not([hidden])');
  await page.waitForSelector('#res-table .vrow');

  const info = await page.evaluate(() => ({
    total: window.__swimtracker.state.dataset.races.length,
    dom: document.querySelectorAll('#res-table .vrow').length,
    label: document.getElementById('res-count').textContent
  }));
  assert.ok(info.total > 8000);
  assert.ok(info.dom < 60, `${info.dom} rows in the DOM for ${info.total} races`);
  assert.match(info.label, /races/);
});

test('scrolling the results table stays responsive and correct', async () => {
  const t0 = Date.now();
  await page.evaluate(() => {
    const s = document.querySelector('#res-table .vscroll');
    s.scrollTop = s.scrollHeight / 2;
  });
  await page.waitForTimeout(250);
  const elapsed = Date.now() - t0;

  const dom = await page.evaluate(() =>
    document.querySelectorAll('#res-table .vrow').length);
  assert.ok(dom > 0, 'rows rendered after scrolling');
  assert.ok(elapsed < 3000, `scroll render took ${elapsed}ms`);
});

test('sorting the results table by time works', async () => {
  await page.click('#res-table .vhead [data-key="seconds"]');
  await page.waitForTimeout(300);
  const times = await page.$$eval('#res-table .vrow', rows =>
    rows.slice(0, 8).map(r => r.children[5].textContent.trim()));
  const secs = times.map(t => {
    const p = t.split(':');
    return p.length === 2 ? +p[0] * 60 + +p[1] : +p[0];
  });
  for (let i = 1; i < secs.length; i++) {
    assert.ok(secs[i] >= secs[i - 1], `sorted ascending: ${times.join(', ')}`);
  }
});

test('the PB-only filter shows only personal bests', async () => {
  await page.selectOption('#res-show', 'pb');
  await page.waitForTimeout(300);
  const allPB = await page.$$eval('#res-table .vrow', rows =>
    rows.every(r => r.classList.contains('is-pb')));
  assert.ok(allPB, 'every visible row is a PB');
  await page.selectOption('#res-show', 'all');
  await page.waitForTimeout(300);
});

test('a swimmer with no gender is listed but not scored', async () => {
  // Points need a gender to pick the right world record. Rather than guessing
  // (which would silently mis-score them), they are shown unscored and
  // surfaced on the Data tab for the coach to fix.
  const info = await page.evaluate(() => {
    const ds = window.__swimtracker.state.dataset;
    const sw = ds.swimmers.get('Unknown Gender');
    return sw ? { gender: sw.gender, points: sw.bestPoints, races: sw.raceCount } : null;
  });
  assert.ok(info, 'the swimmer is present in the data');
  assert.equal(info.gender, null);
  assert.equal(info.points, null, 'not scored');
  assert.ok(info.races > 0, 'their races are still counted');
});

test('the Data tab offers to fix the missing gender', async () => {
  await page.click('#tab-data');
  await page.waitForSelector('#panel-data:not([hidden])');
  assert.equal(await page.isVisible('#roster-card'), true);
  const names = await page.$$eval('#roster-body [data-roster]', els =>
    els.map(e => e.getAttribute('data-roster')));
  assert.ok(names.includes('Unknown Gender'));
});

test('setting a gender scores that swimmer', async () => {
  await page.selectOption('#roster-body select[data-roster="Unknown Gender"]', 'F');
  await page.click('#roster-apply');
  await page.waitForFunction(() => {
    const sw = window.__swimtracker.state.dataset.swimmers.get('Unknown Gender');
    return sw && sw.bestPoints !== null;
  }, { timeout: 10000 });

  const pts = await page.evaluate(() =>
    window.__swimtracker.state.dataset.swimmers.get('Unknown Gender').bestPoints);
  assert.ok(pts > 0, `now scored at ${pts} points`);
});

test('data survives a page reload', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.__swimtracker?.state?.dataset?.swimmers?.size > 100,
    { timeout: 20000 }
  );
  const n = await page.evaluate(() => window.__swimtracker.state.dataset.swimmers.size);
  assert.equal(n, 153, 'the squad came back from browser storage');
});

test('re-importing the same file does not duplicate anything', async () => {
  // Re-scraping used to double every swimmer's race count.
  const before = await page.evaluate(() => window.__swimtracker.state.dataset.races.length);
  await page.click('#tab-data');
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForTimeout(3000);
  await page.waitForFunction(
    prev => window.__swimtracker.state.dataset.races.length === prev,
    before,
    { timeout: 20000 }
  ).catch(() => {});
  const after = await page.evaluate(() => window.__swimtracker.state.dataset.races.length);
  assert.equal(after, before, `${before} races before, ${after} after re-import`);
});

test('exports a CSV that can be re-imported', async () => {
  await page.click('#tab-data');
  await page.waitForSelector('#panel-data:not([hidden])');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-all')
  ]);
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  const lines = text.trim().split('\n');
  assert.ok(lines.length > 8000, `exported ${lines.length - 1} rows`);
  assert.match(lines[0], /^name,gender,club,course,distance,stroke,time,race_date,age_grp,race_name$/);
});

test('no console errors across the whole session', async () => {
  const ignorable = /favicon|fonts\.googleapis|fonts\.gstatic|ERR_NAME_NOT_RESOLVED|net::ERR/i;
  const real = consoleErrors.filter(e => !ignorable.test(e));
  assert.equal(real.length, 0, 'console errors:\n' + real.join('\n'));
  assert.equal(pageErrors.length, 0, 'page errors:\n' + pageErrors.join('\n'));
});

test('a chart with nothing to draw explains why instead of going blank', async () => {
  // Build a swimmer whose only race is years before the current season, so
  // they have a PB but no season best to compare it against.
  await page.evaluate(() => {
    const st = window.__swimtracker.state;
    st.rawRows.push({
      name: 'Retired Rachel', gender: 'F', club: 'Old Guard', course: 'LC',
      distance: '100M', stroke: 'Freestyle', time: '1:20.00',
      race_date: '2019-03-01', age_grp: '14y/o', race_name: '2019 Club Championships'
    });
    window.__swimtracker.rebuild({ silent: true });
  });

  await page.click('#tab-swimmer');
  await page.waitForSelector('#panel-swimmer:not([hidden])');
  await page.selectOption('#sw-select', 'Retired Rachel');
  await page.waitForTimeout(700);

  const note = await page.textContent('#chart-formgap ~ .chart-empty, .chart-wrap .chart-empty');
  assert.ok(note && note.length > 0, 'an explanation is shown');
  assert.match(note, /season|races|compare/i);

  // And the canvas is hidden rather than sitting there blank.
  const canvasHidden = await page.evaluate(() =>
    getComputedStyle(document.getElementById('chart-formgap')).display);
  assert.equal(canvasHidden, 'none');
});

test('the empty state clears when a chart has data again', async () => {
  // Must be a swimmer with a SEASON BEST, not merely a high points score —
  // the form chart compares season best against PB, so a swimmer who has not
  // raced this season legitimately has nothing to draw.
  const withData = await page.evaluate(() => {
    const ds = window.__swimtracker.state.dataset;
    let found = null;
    ds.swimmers.forEach(sw => {
      if (found) return;
      sw.events.forEach(ev => {
        if (!found && ev.seasonBest && ev.seasonBest.points !== null) found = sw.name;
      });
    });
    return found;
  });
  assert.ok(withData, 'found a swimmer with a season best');

  await page.selectOption('#sw-select', withData);
  await page.waitForTimeout(700);
  const display = await page.evaluate(() =>
    getComputedStyle(document.getElementById('chart-formgap')).display);
  assert.notEqual(display, 'none', 'the canvas is shown again');
});

test('the season selector is visible and defaults sensibly', async () => {
  // The fixture's newest season holds only a trickle of races. Defaulting to
  // it would blank the whole squad's season bests.
  const info = await page.evaluate(() => {
    const ds = window.__swimtracker.state.dataset;
    return {
      current: ds.currentSeason,
      auto: ds.autoSeason,
      newest: ds.facets.seasons[ds.facets.seasons.length - 1],
      counts: Array.from(ds.seasonCounts.entries())
    };
  });
  assert.equal(info.current, info.auto);
  assert.ok(info.current < info.newest,
    `defaulted to ${info.current} rather than the barely-started ${info.newest}`);

  assert.equal(await page.isVisible('#season-select'), true);
  const labels = await page.$$eval('#season-select option', os => os.map(o => o.textContent));
  assert.ok(labels.some(l => /default/.test(l)), 'the default is marked in the list');
  assert.ok(labels.every(l => /races/.test(l)), 'each season shows its race count');
});

test('changing the season changes season bests across the app', async () => {
  const before = await page.evaluate(() => {
    let n = 0;
    window.__swimtracker.state.dataset.swimmers.forEach(sw =>
      sw.events.forEach(ev => { if (ev.seasonBest) n++; }));
    return n;
  });

  const options = await page.$$eval('#season-select option', os => os.map(o => o.value));
  assert.ok(options.length > 1, 'more than one season to choose from');
  const oldest = options[options.length - 1];
  await page.selectOption('#season-select', oldest);
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => ({
    season: window.__swimtracker.state.dataset.currentSeason,
    count: (() => {
      let n = 0;
      window.__swimtracker.state.dataset.swimmers.forEach(sw =>
        sw.events.forEach(ev => { if (ev.seasonBest) n++; }));
      return n;
    })()
  }));

  assert.equal(String(after.season), oldest);
  assert.notEqual(after.count, before, 'season bests were recomputed');
});

test('no console errors after the season and empty-state work', async () => {
  const ignorable = /favicon|fonts\.googleapis|fonts\.gstatic|ERR_NAME_NOT_RESOLVED|net::ERR/i;
  const real = consoleErrors.filter(e => !ignorable.test(e));
  assert.equal(real.length, 0, 'console errors:\n' + real.join('\n'));
  assert.equal(pageErrors.length, 0, 'page errors:\n' + pageErrors.join('\n'));
});

/* ==========================================================================
   file:// — the way most people will actually open this
   ========================================================================== */

test('Load sample data works from a double-clicked file, not just over HTTP', async () => {
  // Browsers block fetch()/XHR from a file:// page (opaque origin), which is
  // why the sample ships as a <script> as well as a .csv. This is the exact
  // path a coach takes when they unzip the download and double-click.
  const filePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const fileErrors = [];
  filePage.on('pageerror', e => fileErrors.push(String(e)));

  try {
    await filePage.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'load' });
    await filePage.click('#load-sample');
    await filePage.waitForFunction(
      () => window.__swimtracker?.state?.dataset?.swimmers?.size > 5,
      { timeout: 20000 }
    );

    const info = await filePage.evaluate(() => ({
      swimmers: window.__swimtracker.state.dataset.swimmers.size,
      races: window.__swimtracker.state.dataset.races.length,
      warnings: document.querySelectorAll(
        '#import-report .notice-warn, #import-report .notice-error').length
    }));

    assert.ok(info.swimmers > 5, `loaded ${info.swimmers} swimmers from file://`);
    assert.ok(info.races > 100, `loaded ${info.races} races`);
    assert.equal(info.warnings, 0, 'no "could not load the sample file" warning');
    assert.equal(fileErrors.length, 0, fileErrors.join('\n'));
  } finally {
    await filePage.close();
  }
});

test('the generated sample script matches the sample CSV exactly', async () => {
  // assets/sample-squad.js is generated from the .csv. If someone edits the
  // CSV and forgets to regenerate, the download and the button disagree.
  const csv = await readFile(join(ROOT, 'assets/sample-squad.csv'), 'utf8');
  const js = await readFile(join(ROOT, 'assets/sample-squad.js'), 'utf8');

  const sandbox = {};
  // eslint-disable-next-line no-new-func
  new Function('window', js)(sandbox);

  assert.equal(sandbox.__SWIMTRACKER_SAMPLE__, csv,
    'assets/sample-squad.js is stale — run `node tools/make-sample-js.mjs`');
});
