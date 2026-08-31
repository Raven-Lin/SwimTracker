/* Unit tests for the SwimTracker data + points engines.
   Run with: npm test                                                        */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/points.js');
const D = require('../src/data.js');

/* ==========================================================================
   CSV PARSING — the four bugs that silently corrupted the old dashboard
   ========================================================================== */

test('parses a plain CSV', () => {
  const rows = D.parseCSV('a,b,c\n1,2,3\n4,5,6');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

test('strips the UTF-8 BOM Excel writes', () => {
  // Without this, the "name" header became "﻿name" and every lookup of
  // the swimmer name returned undefined.
  const objs = D.parseCSVToObjects('﻿name,time\nJo,29.30');
  assert.equal(objs[0].name, 'Jo');
});

test('handles CRLF without leaving \\r on the last column', () => {
  const objs = D.parseCSVToObjects('name,club\r\nJo,Artemis\r\n');
  assert.equal(objs[0].club, 'Artemis');
});

test('handles quoted fields containing commas, quotes and newlines', () => {
  const rows = D.parseCSV('a,"x, y","he said ""hi""","line1\nline2"');
  assert.deepEqual(rows, [['a', 'x, y', 'he said "hi"', 'line1\nline2']]);
});

test('round-trips through toCSV', () => {
  const rows = [{ name: 'O"Brien, Jo', meet: 'State\nChamps' }];
  const back = D.parseCSVToObjects(D.toCSV(rows, ['name', 'meet']));
  assert.equal(back[0].name, 'O"Brien, Jo');
  assert.equal(back[0].meet, 'State\nChamps');
});

test('ignores blank trailing lines', () => {
  assert.equal(D.parseCSVToObjects('name\nJo\n\n').length, 1);
});

/* ==========================================================================
   TIME PARSING
   ========================================================================== */

test('parses swim time formats', () => {
  assert.equal(D.timeToSeconds('1:18.14'), 78.14);
  assert.equal(D.timeToSeconds('29.30'), 29.3);
  assert.equal(D.timeToSeconds('15:20.48'), 920.48);
  assert.equal(D.timeToSeconds('1:02:33.44'), 3753.44);
});

test('rejects junk times instead of producing NaN', () => {
  for (const bad of ['', null, undefined, 'DQ', 'NT', 'abc', '--', '0']) {
    assert.equal(D.timeToSeconds(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('formats times the way coaches write them', () => {
  // Not "0:29.30" — a sub-minute swim has no minutes component.
  assert.equal(D.secondsToTime(29.3), '29.30');
  assert.equal(D.secondsToTime(78.14), '1:18.14');
  assert.equal(D.secondsToTime(920.48), '15:20.48');
  assert.equal(D.secondsToTime(null), '—');
});

test('time formatting round-trips', () => {
  for (const s of [23.61, 29.3, 60, 78.14, 235.38, 920.48]) {
    assert.equal(D.timeToSeconds(D.secondsToTime(s)), s);
  }
});

/* ==========================================================================
   WORLD AQUATICS POINTS
   ========================================================================== */

test('base time scores exactly 1000 points', () => {
  assert.equal(P.score(51.71, 'F', 'LC', 100, 'Freestyle'), 1000);
  assert.equal(P.score(46.40, 'M', 'LC', 100, 'Freestyle'), 1000);
});

test('matches the published worked example', () => {
  // 1000 * (46.40 / 49.00)^3 = 849.07 -> 849
  assert.equal(P.score(49.0, 'M', 'LC', 100, 'Freestyle'), 849);
});

test('points fall as time rises, on a cubic curve', () => {
  const fast = P.score(60, 'F', 'LC', 100, 'Freestyle');
  const slow = P.score(70, 'F', 'LC', 100, 'Freestyle');
  assert.ok(fast > slow);
  // Doubling the time should quarter-and-then-some the points (1/8th).
  const half = P.score(103.42, 'F', 'LC', 100, 'Freestyle');
  assert.ok(Math.abs(half - 125) <= 1);
});

test('returns null rather than 0 when the swim cannot be scored', () => {
  // A null must never be silently treated as 0 — that would rank an unscored
  // swimmer below the slowest scored one.
  assert.equal(P.score(60, null, 'LC', 100, 'Freestyle'), null, 'unknown gender');
  assert.equal(P.score(60, 'F', 'LC', 75, 'Freestyle'), null, 'no such event');
  assert.equal(P.score(0, 'F', 'LC', 100, 'Freestyle'), null, 'zero time');
  assert.equal(P.score(-5, 'F', 'LC', 100, 'Freestyle'), null, 'negative time');
  assert.equal(P.score(NaN, 'F', 'LC', 100, 'Freestyle'), null, 'NaN time');
});

test('rejects impossible times that would blow up a chart axis', () => {
  // A 400 Free mis-parsed as "1.00" would otherwise score ~14 million points
  // and flatten every other series to the baseline.
  assert.equal(P.score(1.0, 'F', 'LC', 400, 'Freestyle'), null);
});

test('normalises the gender spellings that show up in real CSVs', () => {
  for (const v of ['F', 'f', 'Female', 'FEMALE', 'girls', 'W']) {
    assert.equal(P.normalizeGender(v), 'F', v);
  }
  for (const v of ['M', 'male', 'Boys', 'men']) {
    assert.equal(P.normalizeGender(v), 'M', v);
  }
  for (const v of ['', null, undefined, 'unknown', 'X']) {
    assert.equal(P.normalizeGender(v), null, String(v));
  }
});

test('normalises stroke and distance shorthand', () => {
  assert.equal(P.normalizeStroke('Free'), 'Freestyle');
  assert.equal(P.normalizeStroke('IM'), 'Medley');
  assert.equal(P.normalizeStroke('fly'), 'Butterfly');
  assert.equal(P.normalizeStroke('nonsense'), null);
  assert.equal(P.normalizeDistance('100M'), 100);
  assert.equal(P.normalizeDistance('1500m'), 1500);
  assert.equal(P.normalizeDistance(50), 50);
  assert.equal(P.normalizeDistance('abc'), null);
});

/* ==========================================================================
   DATASET BUILD
   ========================================================================== */

function row(o) {
  return Object.assign({
    name: 'Jo Swimmer', club: 'Artemis', gender: 'F', course: 'LC',
    distance: '100M', stroke: 'Freestyle', time: '1:00.00',
    race_date: '2025-03-01', age_grp: '15y/o', race_name: 'State Champs'
  }, o);
}

test('builds an indexed dataset', () => {
  const ds = D.buildDataset([row({}), row({ time: '59.00', race_date: '2025-06-01' })]);
  assert.equal(ds.races.length, 2);
  assert.equal(ds.swimmers.size, 1);
  const sw = ds.swimmers.get('Jo Swimmer');
  assert.equal(sw.gender, 'F');
  assert.equal(sw.raceCount, 2);
  const ev = sw.events.get('LC|100|Freestyle');
  assert.equal(ev.pb.seconds, 59);
});

test('drops unusable rows instead of crashing on them', () => {
  const ds = D.buildDataset([
    row({}),
    row({ time: 'DQ' }),
    row({ name: '' }),
    row({ stroke: 'Kickboard' }),
    row({ distance: 'abc' }),
    row({ course: '' })
  ]);
  assert.equal(ds.races.length, 1);
  assert.equal(ds.quality.rejected, 5);
});

test('deduplicates re-imported results', () => {
  // Re-scraping a swimmer used to append a second copy of every race, so a
  // coach who ran the scrape twice saw doubled race counts and broken stats.
  const r = row({});
  const ds = D.buildDataset([r, Object.assign({}, r), Object.assign({}, r)]);
  assert.equal(ds.races.length, 1);
  assert.equal(ds.quality.duplicatesRemoved, 2);
});

test('flags exactly one PB per event, even on a tie', () => {
  const ds = D.buildDataset([
    row({ time: '1:00.00', race_date: '2025-01-01' }),
    row({ time: '1:00.00', race_date: '2025-05-01' }),
    row({ time: '1:01.00', race_date: '2025-06-01' })
  ]);
  const pbs = ds.races.filter(r => r.isPB);
  assert.equal(pbs.length, 1);
  assert.equal(pbs[0].dateISO, '2025-01-01', 'the earliest of the tied swims holds the PB');
});

test('separates PBs by course, distance and stroke', () => {
  const ds = D.buildDataset([
    row({ course: 'LC', time: '1:00.00' }),
    row({ course: 'SC', time: '1:05.00' }),
    row({ distance: '200M', time: '2:20.00' }),
    row({ stroke: 'Backstroke', time: '1:10.00' })
  ]);
  assert.equal(ds.races.filter(r => r.isPB).length, 4);
});

test('computes season best, PB gap and improvement', () => {
  const ds = D.buildDataset([
    row({ time: '1:05.00', race_date: '2023-03-01' }),  // first ever
    row({ time: '1:00.00', race_date: '2024-03-01' }),  // all-time PB
    row({ time: '1:01.00', race_date: '2025-03-01' })   // current-season best
  ]);
  const ev = ds.swimmers.get('Jo Swimmer').events.get('LC|100|Freestyle');
  assert.equal(ds.currentSeason, 2025);
  assert.equal(ev.pb.seconds, 60);
  assert.equal(ev.seasonBest.seconds, 61);
  assert.ok(Math.abs(ev.sbToPbGapSec - 1) < 1e-9, 'one second off the PB');
  assert.ok(Math.abs(ev.improvementPct - 7.6923) < 0.01, '65s -> 60s is 7.69%');
});

test('honours a non-January season start', () => {
  // With an October start, a December 2024 swim belongs to the 2025 season.
  const ds = D.buildDataset([
    row({ race_date: '2024-12-01' }),
    row({ race_date: '2025-03-01', time: '59.00' })
  ], { seasonStartMonth: 10 });
  assert.equal(ds.races[0].season, 2025);
  assert.equal(ds.races[1].season, 2025);
  assert.equal(ds.currentSeason, 2025);
});

test('takes gender from a roster when the CSV omits it', () => {
  // The old app keyed gender on the name the coach *typed*, while the CSV
  // stored the name the website *returned*, so the filter matched nothing.
  const ds = D.buildDataset([row({ gender: '' })], {
    genderLookup: name => (name === 'Jo Swimmer' ? 'F' : null)
  });
  assert.equal(ds.races[0].gender, 'F');
  assert.ok(ds.races[0].points > 0, 'and that makes the swim scorable');
});

test('reports unscored swims in the quality summary', () => {
  const ds = D.buildDataset([row({ gender: '' })]);
  assert.equal(ds.quality.missingGender, 1);
  assert.equal(ds.quality.unscored, 1);
  assert.equal(ds.races[0].points, null);
});

/* ==========================================================================
   QUERIES
   ========================================================================== */

test('progression produces a monotonically improving PB line', () => {
  const ds = D.buildDataset([
    row({ time: '1:05.00', race_date: '2024-01-01' }),
    row({ time: '1:07.00', race_date: '2024-02-01' }),  // slower — PB holds
    row({ time: '1:02.00', race_date: '2024-03-01' }),  // new PB
    row({ time: '1:03.00', race_date: '2024-04-01' })
  ]);
  const prog = D.progression(ds.swimmers.get('Jo Swimmer'), 'LC|100|Freestyle');
  assert.deepEqual(prog.map(p => p.pbSoFar), [65, 65, 62, 62]);
  assert.deepEqual(prog.map(p => p.isNewPB), [true, false, true, false]);
});

test('improvement leaderboard ranks by points gained this season', () => {
  const ds = D.buildDataset([
    row({ name: 'Fast Riser', time: '1:10.00', race_date: '2024-03-01' }),
    row({ name: 'Fast Riser', time: '1:00.00', race_date: '2025-03-01' }),
    row({ name: 'Steady Sam', time: '1:02.00', race_date: '2024-03-01' }),
    row({ name: 'Steady Sam', time: '1:01.50', race_date: '2025-03-01' })
  ]);
  const lb = D.improvementLeaderboard(ds, { season: 2025 });
  assert.equal(lb[0].name, 'Fast Riser');
  assert.ok(lb[0].gain > lb[1].gain);
});

test('improvement leaderboard skips swimmers with no prior baseline', () => {
  const ds = D.buildDataset([row({ name: 'Brand New', race_date: '2025-03-01' })]);
  assert.equal(D.improvementLeaderboard(ds, { season: 2025 }).length, 0);
});

test('event rankings sort fastest first and can filter by gender', () => {
  const ds = D.buildDataset([
    row({ name: 'A', gender: 'F', time: '1:02.00' }),
    row({ name: 'B', gender: 'F', time: '1:00.00' }),
    row({ name: 'C', gender: 'M', time: '58.00' })
  ]);
  const all = D.eventRankings(ds, 'LC|100|Freestyle');
  assert.deepEqual(all.map(r => r.name), ['C', 'B', 'A']);
  const women = D.eventRankings(ds, 'LC|100|Freestyle', { gender: 'F' });
  assert.deepEqual(women.map(r => r.name), ['B', 'A']);
});

test('coverage matrix marks events a swimmer has never raced', () => {
  const ds = D.buildDataset([
    row({ name: 'A', stroke: 'Freestyle' }),
    row({ name: 'A', stroke: 'Backstroke', time: '1:10.00' }),
    row({ name: 'B', stroke: 'Freestyle' })
  ]);
  const m = D.coverageMatrix(ds, { course: 'LC' });
  assert.equal(m.events.length, 2);
  assert.equal(m.rows[0].swimmer.name, 'A', 'best-covered swimmer sorts first');
  assert.equal(m.rows[0].filled, 2);
  assert.equal(m.rows[1].filled, 1);
  assert.ok(m.rows[1].cells.includes(null), 'the unraced event is an empty cell');
});

test('points distribution bins the squad', () => {
  const ds = D.buildDataset([
    row({ name: 'A', time: '1:00.00' }),
    row({ name: 'B', time: '1:00.50' }),
    row({ name: 'C', time: '2:00.00' })
  ]);
  const dist = D.pointsDistribution(ds, 50);
  assert.ok(dist.length > 0);
  assert.equal(dist.reduce((s, b) => s + b.count, 0), 3, 'every swimmer lands in a bin');
});

/* ==========================================================================
   SCALE — the failure mode that killed the old app
   ========================================================================== */

test('handles a 150-swimmer squad without stack overflow or timeout', () => {
  const strokes = ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly', 'Medley'];
  const rows = [];
  for (let s = 0; s < 150; s++) {
    for (let y = 2020; y <= 2026; y++) {
      for (let e = 0; e < 8; e++) {
        rows.push(row({
          name: `Swimmer ${s}`,
          gender: s % 2 ? 'M' : 'F',
          course: e % 2 ? 'SC' : 'LC',
          distance: [50, 100, 200][e % 3] + 'M',
          stroke: strokes[e % strokes.length],
          time: `1:${(10 + (s % 40)).toString().padStart(2, '0')}.${(e * 7 % 100).toString().padStart(2, '0')}`,
          race_date: `${y}-0${(e % 9) + 1}-15`
        }));
      }
    }
  }
  assert.ok(rows.length > 8000, `generated ${rows.length} rows`);

  const t0 = Date.now();
  const ds = D.buildDataset(rows);
  const buildMs = Date.now() - t0;

  assert.equal(ds.swimmers.size, 150);
  assert.ok(buildMs < 4000, `index built in ${buildMs}ms`);

  // Each query must also stay fast — these run on every filter change.
  const t1 = Date.now();
  D.squadSummary(ds);
  D.improvementLeaderboard(ds);
  D.coverageMatrix(ds, { course: 'LC' });
  D.pointsDistribution(ds);
  D.eventRankings(ds, ds.facets.eventList[0].eventKey);
  const queryMs = Date.now() - t1;
  assert.ok(queryMs < 2000, `queries ran in ${queryMs}ms`);
});

test('survives an array large enough to break Math.min(...spread)', () => {
  // Math.min(...arr) throws RangeError past ~65k elements. The old dashboard
  // called it on unbounded per-swimmer arrays.
  const rows = [];
  for (let i = 0; i < 80000; i++) {
    rows.push(row({
      time: `1:${(i % 60).toString().padStart(2, '0')}.${(i % 100).toString().padStart(2, '0')}`,
      race_date: `202${i % 5}-0${(i % 9) + 1}-${((i % 28) + 1).toString().padStart(2, '0')}`
    }));
  }
  const ds = D.buildDataset(rows);
  assert.ok(ds.races.length > 1000);
  const ev = ds.swimmers.get('Jo Swimmer').events.get('LC|100|Freestyle');
  assert.ok(ev.pb.seconds > 0, 'PB computed without a stack overflow');
});

/* ==========================================================================
   CURRENT-SEASON SELECTION
   ========================================================================== */

test('picks the latest season when it is genuinely active', () => {
  const counts = new Map([[2024, 500], [2025, 480], [2026, 420]]);
  assert.equal(D.pickCurrentSeason(counts), 2026);
});

test('steps back past a season that has barely started', () => {
  // The bug this fixes: one swimmer races in January of a new season, and
  // the whole squad's "season best" silently becomes empty.
  const counts = new Map([[2024, 1900], [2025, 1800], [2026, 1100], [2027, 12]]);
  assert.equal(D.pickCurrentSeason(counts), 2026);
});

test('does not step back past a merely quieter season', () => {
  // 40% of the previous season is a quiet year, not an unstarted one.
  const counts = new Map([[2025, 1000], [2026, 400]]);
  assert.equal(D.pickCurrentSeason(counts), 2026);
});

test('handles a single season and an empty dataset', () => {
  assert.equal(D.pickCurrentSeason(new Map([[2026, 30]])), 2026);
  assert.equal(D.pickCurrentSeason(new Map()), null);
});

test('the dataset exposes the automatic choice and the per-season counts', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row({ name: `S${i}`, race_date: '2025-05-01' }));
  rows.push(row({ name: 'Early Bird', race_date: '2026-01-04' }));

  const ds = D.buildDataset(rows);
  assert.equal(ds.autoSeason, 2025, 'one January swim does not make 2026 the season');
  assert.equal(ds.currentSeason, 2025);
  assert.equal(ds.seasonCounts.get(2026), 1);
  assert.equal(ds.seasonCounts.get(2025), 60);
});

test('an explicit season overrides the automatic choice', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row({ name: `S${i}`, race_date: '2025-05-01' }));
  rows.push(row({ name: 'Early Bird', race_date: '2026-01-04' }));

  const ds = D.buildDataset(rows, { currentSeason: 2026 });
  assert.equal(ds.currentSeason, 2026, 'the coach can pin the new season');
  assert.equal(ds.autoSeason, 2025, 'the automatic choice is still reported');
});

test('an override naming a season with no data is ignored', () => {
  const ds = D.buildDataset([row({ race_date: '2025-05-01' })], { currentSeason: 1999 });
  assert.equal(ds.currentSeason, 2025);
});

test('season choice actually drives season bests', () => {
  const rows = [
    row({ time: '1:05.00', race_date: '2024-03-01' }),
    row({ time: '1:00.00', race_date: '2025-03-01' })
  ];
  const a = D.buildDataset(rows, { currentSeason: 2024 });
  assert.equal(a.swimmers.get('Jo Swimmer').events.get('LC|100|Freestyle').seasonBest.seconds, 65);

  const b = D.buildDataset(rows, { currentSeason: 2025 });
  assert.equal(b.swimmers.get('Jo Swimmer').events.get('LC|100|Freestyle').seasonBest.seconds, 60);
});
