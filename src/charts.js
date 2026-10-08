/* ============================================================================
   SwimTracker — Charts
   ============================================================================

   What changed, and why
   ---------------------
   The old dashboard shipped two line charts that plotted *the same thing*:
   "Best Times Over Time" and "Improvement from First Race" drew identical
   curves whenever the metric selector was set to "improvement". Both binned
   times by calendar YEAR, which throws away the detail a coach actually
   reads — you cannot see a taper, a mid-season plateau, or which meet a swim
   came from when twelve months collapse to one point.

   The charts here follow what coaches use in practice (see README for
   sources). Four ideas drive the set:

   1. PROGRESSION IS PLOTTED AGAINST THE ACTUAL MEET DATE, and the personal
      best is drawn as a STEPPED line beneath the individual swims. A stepped
      line is the honest shape: a PB holds flat until it is broken. A smoothed
      curve through every swim implies improvement between races that never
      happened.

   2. SEASON BEST vs PERSONAL BEST, as a range bar. This is the single most
      used diagnostic in a coach's week: an SB sitting close to the PB means
      the swimmer is in form; a wide gap means they are climbing back.

   3. SQUAD-WIDE COMPARISON USES WORLD AQUATICS POINTS, never seconds. Across
      150 swimmers of different ages, genders and events, seconds are not
      comparable and a bar chart of them is meaningless.

   4. NO CHART EVER DRAWS 150 SERIES. Line charts cap at a handful of
      swimmers, chosen deliberately. Everything squad-wide is a bar, a
      histogram or a heatmap — forms that stay readable at scale.

   The y-axis for any time-based chart is REVERSED, so faster (a lower time)
   is higher on the page. Coaches read "up" as "better"; an un-reversed time
   axis is read backwards at a glance and is a genuine source of mistakes.
============================================================================ */

(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./data.js') : root.STData,
    typeof require === 'function' ? require('./ui.js') : root.STUi,
    typeof require === 'function' ? require('./points.js') : root.STPoints
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STCharts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D, U, P) {
  'use strict';

  const registry = new Map();

  function ChartCtor() {
    return typeof Chart !== 'undefined' ? Chart : null;
  }

  /** Tear down the chart bound to a canvas before drawing a new one.
      Skipping this leaks the old chart's event listeners and animation loop,
      which is how a dashboard gets slower every time you change a filter. */
  function destroy(canvasId) {
    const existing = registry.get(canvasId);
    if (existing) {
      try { existing.destroy(); } catch (_) {}
      registry.delete(canvasId);
    }
  }

  function destroyAll() {
    Array.from(registry.keys()).forEach(destroy);
  }

  /**
   * Show an explanation in place of a chart that has nothing to draw.
   *
   * A blank white rectangle is the worst possible answer: the coach cannot
   * tell whether the app is broken, still loading, or correctly telling them
   * there is no data. Every bail-out path below routes through here with a
   * sentence that says which of those it is.
   */
  function empty(canvasId, message) {
    destroy(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const wrap = canvas.parentElement;
    if (!wrap) return null;
    canvas.style.display = 'none';
    let note = wrap.querySelector('.chart-empty');
    if (!note) {
      note = document.createElement('div');
      note.className = 'chart-empty';
      wrap.appendChild(note);
    }
    note.textContent = message || 'Nothing to show for these filters.';
    return null;
  }

  function clearEmpty(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.style.display = '';
    const wrap = canvas.parentElement;
    const note = wrap && wrap.querySelector('.chart-empty');
    if (note) note.remove();
  }

  function make(canvasId, config) {
    const C = ChartCtor();
    const canvas = document.getElementById(canvasId);
    if (!C || !canvas) return null;
    destroy(canvasId);
    clearEmpty(canvasId);
    const chart = new C(canvas.getContext('2d'), config);
    registry.set(canvasId, chart);
    return chart;
  }

  const FONT = { family: '"DM Sans", system-ui, sans-serif', size: 11 };

  /* Colour lives in the UI module so the page and the charts cannot drift. */
  const T = U.THEME;
  const STROKE_COLORS = U.STROKE_COLORS;

  const BASE_OPTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 220 },
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { labels: { font: FONT, usePointStyle: true, boxWidth: 8, padding: 12 } },
      tooltip: {
        backgroundColor: T.tooltipBg,
        titleFont: FONT, bodyFont: FONT,
        padding: 10, cornerRadius: 6, displayColors: true, boxWidth: 8
      }
    }
  };

  function merge(a, b) {
    const out = Object.assign({}, a);
    Object.keys(b || {}).forEach(k => {
      out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]))
        ? merge(a[k] || {}, b[k]) : b[k];
    });
    return out;
  }


  function fmtDateShort(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  function fmtDateFull(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  /* ==========================================================================
     1. PB PROGRESSION — the chart coaches actually read
     ========================================================================== */

  /**
   * Every swim as a point against its real meet date, with the personal best
   * drawn as a stepped line underneath.
   *
   * Dates are plotted on a LINEAR scale of timestamps rather than Chart.js's
   * time scale, deliberately: the time scale needs a date-adapter library,
   * and this app must run offline from a file:// URL with no network and no
   * extra dependency. A tick callback gives the same readable axis.
   */
  function pbProgression(canvasId, swimmer, eventKey, opts) {
    const settings = opts || {};
    const prog = D.progression(swimmer, eventKey);
    if (!prog.length) {
      return empty(canvasId, `${swimmer.name} has no recorded races in this event.`);
    }

    const points = prog
      .filter(p => p.race.date)
      .map(p => ({ x: p.race.date.getTime(), y: p.race.seconds, meta: p }));

    if (!points.length) {
      return empty(canvasId, 'These races have no valid dates, so they cannot be plotted over time.');
    }

    // The stepped PB line: hold the current best flat, then drop on the swim
    // that broke it. Two points per improvement gives a true step rather than
    // a diagonal that implies gradual change.
    const stepped = [];
    let last = null;
    prog.forEach(p => {
      if (!p.race.date) return;
      const x = p.race.date.getTime();
      if (last !== null && p.pbSoFar !== last) stepped.push({ x, y: last });
      stepped.push({ x, y: p.pbSoFar });
      last = p.pbSoFar;
    });
    // Extend the final step to "today" so a stale PB visibly runs flat.
    if (stepped.length) {
      const endX = Math.max(Date.now(), stepped[stepped.length - 1].x);
      if (endX > stepped[stepped.length - 1].x) stepped.push({ x: endX, y: last });
    }

    const newPBs = points.filter(p => p.meta.isNewPB);

    return make(canvasId, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Personal best',
            data: stepped,
            type: 'line',
            stepped: 'before',
            borderColor: T.warm,
            borderWidth: 2,
            borderDash: [],
            pointRadius: 0,
            fill: false,
            order: 3
          },
          {
            label: 'Race',
            data: points,
            backgroundColor: T.accentFill,
            borderColor: T.accent,
            borderWidth: 1,
            pointRadius: 4,
            pointHoverRadius: 6,
            order: 2
          },
          {
            label: 'New PB',
            data: newPBs,
            backgroundColor: T.warm,
            borderColor: T.white,
            borderWidth: 1.5,
            pointRadius: 6,
            pointStyle: 'triangle',
            pointHoverRadius: 8,
            order: 1
          }
        ]
      },
      options: merge(BASE_OPTS, {
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: items => fmtDateFull(items[0].parsed.x),
              label: ctx => {
                const p = ctx.raw.meta;
                if (!p) return ` PB: ${D.secondsToTime(ctx.parsed.y)}`;
                const bits = [` ${D.secondsToTime(p.race.seconds)}`];
                if (p.race.points !== null) bits.push(` ${p.race.points} pts`);
                if (p.isNewPB) bits.push(' New PB');
                return bits.join(' ·');
              },
              afterLabel: ctx => (ctx.raw.meta ? ctx.raw.meta.race.meet : '')
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: false },
            ticks: { font: FONT, callback: v => fmtDateShort(v), maxRotation: 0, autoSkipPadding: 22 },
            grid: { color: T.gridFaint }
          },
          y: {
            // Faster is up. See the header note — this is not optional.
            reverse: true,
            title: { display: true, text: 'Time (faster is higher)', font: FONT },
            ticks: { font: FONT, callback: v => D.secondsToTime(v) },
            grid: { color: T.grid }
          }
        }
      })
    });
  }

  /* ==========================================================================
     2. SEASON BEST vs PERSONAL BEST — the form chart
     ========================================================================== */

  /**
   * How far off their personal best each event currently is, IN SECONDS.
   *
   * This used to be a range bar on the World Aquatics points scale. That was
   * the wrong unit for the question: a coach does not ask "how many points
   * off is she?", they ask "how far off her best is she?" — and the answer is
   * "half a second" or "four seconds". Seconds are also what the swimmer
   * hears in the pool.
   *
   * Seconds-off-PB works as a shared axis where raw times do not: a 50 Free
   * and a 400 IM sit on utterly different time scales, but "1.2 seconds off"
   * and "3.5 seconds off" are directly comparable, and zero means "at their
   * best" in every event. The bar starts at a true zero, so bar length is an
   * honest quantity.
   */
  function formGap(canvasId, swimmer, opts) {
    const settings = opts || {};
    const rows = [];
    swimmer.events.forEach(ev => {
      if (!ev.pb || !ev.seasonBest) return;
      if (ev.sbToPbGapSec === null || ev.sbToPbGapSec === undefined) return;
      rows.push({
        label: `${ev.course} ${ev.distance} ${P.strokeShort(ev.stroke)}`,
        gapSec: Math.max(0, ev.sbToPbGapSec),
        gapPct: ev.sbToPbGapPct || 0,
        ev
      });
    });

    if (!rows.length) {
      return empty(canvasId, settings.seasonLabel
        ? `${swimmer.name} has not raced in the ${settings.seasonLabel} season, so there is no season best to compare against their PBs yet.`
        : `${swimmer.name} has no season best to compare against their PBs yet.`);
    }

    // Biggest gap first: the events with the most to claw back are the ones
    // worth a conversation.
    rows.sort((a, b) => b.gapSec - a.gapSec);
    const shown = rows.slice(0, settings.limit || 12);

    return make(canvasId, {
      type: 'bar',
      data: {
        labels: shown.map(r => r.label),
        datasets: [{
          label: 'Seconds off personal best',
          data: shown.map(r => r.gapSec),
          backgroundColor: shown.map(r =>
            r.gapSec <= 0.005 ? T.greenSoft      // at their PB
              : r.gapPct < 2 ? T.accentSoft       // within touching distance
              : T.warmSoft),                    // work to do
          borderColor: shown.map(r =>
            r.gapSec <= 0.005 ? T.green : r.gapPct < 2 ? T.accent : T.warm),
          borderWidth: 1, borderRadius: 3, barPercentage: 0.72
        }]
      },
      options: merge(BASE_OPTS, {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = shown[ctx.dataIndex];
                return [
                  ` Season best: ${D.secondsToTime(r.ev.seasonBest.seconds)}`,
                  ` Personal best: ${D.secondsToTime(r.ev.pb.seconds)}`,
                  r.gapSec <= 0.005
                    ? ' At their personal best'
                    : ` ${r.gapSec.toFixed(2)}s off their PB`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            title: { display: true, text: 'Seconds off their personal best (0 = at their best)', font: FONT },
            ticks: { font: FONT, callback: v => v === 0 ? '0' : v.toFixed(1) + 's' },
            grid: { color: T.grid }
          },
          y: { ticks: { font: FONT }, grid: { display: false } }
        }
      })
    });
  }

  /* ==========================================================================
     3. EVENT PORTFOLIO — where is this swimmer actually strongest?
     ========================================================================== */

  /**
   * PB points per event for one swimmer, coloured by stroke.
   *
   * This answers a question seconds cannot: a 1:18 breaststroke and a 1:00
   * freestyle look like the freestyle is better, but on points the
   * breaststroke may be the stronger swim. Coaches use this to decide what a
   * swimmer should specialise in and which relay leg they belong on.
   */
  function eventPortfolio(canvasId, swimmer, opts) {
    const settings = opts || {};
    const rows = [];
    swimmer.events.forEach(ev => {
      if (!ev.pb || ev.pb.points === null) return;
      rows.push({
        label: `${ev.course} ${ev.distance} ${ev.stroke}`,
        points: ev.pb.points,
        stroke: ev.stroke,
        ev
      });
    });
    if (!rows.length) {
      return empty(canvasId, swimmer.gender
        ? `No scorable events for ${swimmer.name} yet.`
        : `${swimmer.name} has no gender set, so their swims cannot be scored in points. Set it on the Data tab.`);
    }

    rows.sort((a, b) => b.points - a.points);
    const shown = rows.slice(0, settings.limit || 14);

    return make(canvasId, {
      type: 'bar',
      data: {
        labels: shown.map(r => r.label),
        datasets: [{
          label: 'PB (points)',
          data: shown.map(r => r.points),
          backgroundColor: shown.map(r => (STROKE_COLORS[r.stroke] || T.accent) + 'cc'),
          borderColor: shown.map(r => STROKE_COLORS[r.stroke] || T.accent),
          borderWidth: 1, borderRadius: 3, barPercentage: 0.75
        }]
      },
      options: merge(BASE_OPTS, {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = shown[ctx.dataIndex];
                return ` ${D.secondsToTime(r.ev.pb.seconds)} · ${r.points} pts`;
              },
              afterLabel: ctx => ` ${shown[ctx.dataIndex].ev.pb.meet || ''}`
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'World Aquatics points', font: FONT },
            beginAtZero: true, ticks: { font: FONT }, grid: { color: T.grid }
          },
          y: { ticks: { font: FONT }, grid: { display: false } }
        }
      })
    });
  }

  /* ==========================================================================
     4. SQUAD POINTS DISTRIBUTION
     ========================================================================== */

  /**
   * Histogram of every swimmer's best points. Shows the squad's standard and
   * its shape in one glance — where the bulk sits, and whether there is a
   * long tail of developing swimmers or a cluster near the top.
   */
  function pointsDistribution(canvasId, bins) {
    if (!bins || !bins.length) {
      return empty(canvasId, 'No swimmer has a scorable swim yet. Points need a gender — set any missing ones on the Data tab.');
    }
    return make(canvasId, {
      type: 'bar',
      data: {
        labels: bins.map(b => `${b.from}–${b.to}`),
        datasets: [{
          label: 'Swimmers',
          data: bins.map(b => b.count),
          backgroundColor: T.accentSoft,
          borderColor: T.accent, borderWidth: 1,
          borderRadius: 3, barPercentage: 0.92, categoryPercentage: 0.95
        }]
      },
      options: merge(BASE_OPTS, {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => `${items[0].label} points`,
              label: ctx => ` ${ctx.parsed.y} swimmer${ctx.parsed.y === 1 ? '' : 's'}`
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'Best World Aquatics points', font: FONT },
               ticks: { font: FONT, maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: { title: { display: true, text: 'Swimmers', font: FONT },
               beginAtZero: true, ticks: { font: FONT, precision: 0 },
               grid: { color: T.grid } }
        }
      })
    });
  }

  /* ==========================================================================
     5. IMPROVEMENT LEADERBOARD — "who is moving?"
     ========================================================================== */

  /**
   * Top N swimmers by points gained this season versus their previous best.
   *
   * Points rather than seconds or percent, so a 12 y/o's 50 Free and a
   * 17 y/o's 400 IM are ranked on the same footing. A negative bar (a swimmer
   * below their previous best) is drawn in red and kept in the chart — a
   * leaderboard that hides regression is not much use to a coach.
   */
  function improvementLeaderboard(canvasId, rows, opts) {
    const settings = opts || {};
    if (!rows || !rows.length) {
      return empty(canvasId, 'Nobody has a previous season to improve on yet. This fills in once your data covers more than one season.');
    }
    const shown = rows.slice(0, settings.limit || 20);

    return make(canvasId, {
      type: 'bar',
      data: {
        labels: shown.map(r => r.name),
        datasets: [{
          label: 'Points gained',
          data: shown.map(r => r.gain),
          backgroundColor: shown.map(r => r.gain >= 0 ? T.greenSoft : T.redSoft),
          borderColor: shown.map(r => r.gain >= 0 ? T.green : T.red),
          borderWidth: 1, borderRadius: 3, barPercentage: 0.8
        }]
      },
      options: merge(BASE_OPTS, {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = shown[ctx.dataIndex];
                return ` ${r.gain >= 0 ? '+' : ''}${r.gain} pts in ${r.event.course} ${r.event.distance} ${r.event.stroke}`;
              },
              afterLabel: ctx => {
                const r = shown[ctx.dataIndex];
                return ` ${D.secondsToTime(r.previous.seconds)} → ${D.secondsToTime(r.current.seconds)}`;
              }
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'World Aquatics points gained', font: FONT },
               ticks: { font: FONT }, grid: { color: T.grid } },
          y: { ticks: { font: FONT, autoSkip: false }, grid: { display: false } }
        }
      })
    });
  }

  /* ==========================================================================
     6. EVENT RANKINGS
     ========================================================================== */

  /**
   * Rankings for one event, fastest at the top.
   *
   * The chart TYPE changes with the metric, and that is deliberate:
   *
   *   Points -> BAR. Points have a true zero, so bar length is a meaningful
   *   quantity and the eye can compare it honestly.
   *
   *   Time -> DOT PLOT. A field in the 100m spans maybe 55–75 seconds. Drawn
   *   as bars from zero, every real difference is squashed into the last 20%
   *   of the bar and the chart is useless. Drawn as bars from a non-zero
   *   baseline, the bar lengths are a lie — the SLOWEST swimmer gets the
   *   longest bar, which is exactly backwards. A dot plot has no baseline to
   *   get wrong: each swimmer is a point at their time, and the eye compares
   *   position, which is the most accurate visual encoding there is.
   *
   * Horizontal in both cases, because 30 swimmer names read fine down a
   * vertical axis and are unreadable rotated along a horizontal one.
   */
  function eventRanking(canvasId, rows, opts) {
    const settings = opts || {};
    if (!rows || !rows.length) {
      return empty(canvasId, 'No swimmer in this filter has raced this event.');
    }
    const shown = rows.slice(0, settings.limit || 30);
    const usePoints = settings.metric === 'points';

    const names = shown.map(r => r.name);
    const tooltipCallbacks = {
      title: items => items[0].label || '',
      label: ctx => {
        const r = shown[ctx.dataIndex];
        const t = ` ${D.secondsToTime(r.seconds)}`;
        return r.points !== null ? `${t} · ${r.points} pts` : t;
      },
      afterLabel: ctx => {
        const r = shown[ctx.dataIndex];
        return [` ${r.race.meet || ''}`, ` ${r.race.dateISO || ''}`]
          .filter(s => s.trim()).join('\n');
      }
    };

    if (usePoints) {
      const values = shown.map(r => r.points).filter(v => v !== null);
      if (!values.length) {
        return empty(canvasId, 'None of these swimmers can be scored in points — check their genders on the Data tab.');
      }
      let best = values[0];
      for (let i = 1; i < values.length; i++) if (values[i] > best) best = values[i];

      return make(canvasId, {
        type: 'bar',
        data: {
          labels: names,
          datasets: [{
            label: 'PB (points)',
            data: shown.map(r => r.points),
            backgroundColor: shown.map(r => r.points === best ? T.warmSoft : T.accentSoft),
            borderColor: shown.map(r => r.points === best ? T.warm : T.accent),
            borderWidth: 1, borderRadius: 3, barPercentage: 0.8
          }]
        },
        options: merge(BASE_OPTS, {
          indexAxis: 'y',
          plugins: { legend: { display: false }, tooltip: { callbacks: tooltipCallbacks } },
          scales: {
            x: { title: { display: true, text: 'World Aquatics points', font: FONT },
                 beginAtZero: true, ticks: { font: FONT }, grid: { color: T.grid } },
            y: { ticks: { font: FONT, autoSkip: false }, grid: { display: false } }
          }
        })
      });
    }

    // --- Time: dot plot -----------------------------------------------------
    const secs = shown.map(r => r.seconds);
    let min = secs[0], max = secs[0];
    for (let i = 1; i < secs.length; i++) {
      if (secs[i] < min) min = secs[i];
      if (secs[i] > max) max = secs[i];
    }
    const pad = Math.max((max - min) * 0.08, 0.25);

    return make(canvasId, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Personal best',
          data: shown.map(r => ({ x: r.seconds, y: r.name })),
          backgroundColor: shown.map(r => r.seconds === min ? T.warm : T.accentSoft),
          borderColor: shown.map(r => r.seconds === min ? T.warmDeep : T.accent),
          borderWidth: 1.5,
          pointRadius: shown.map(r => r.seconds === min ? 7 : 5),
          pointHoverRadius: 9
        }]
      },
      options: merge(BASE_OPTS, {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => String(items[0].raw.y),
              label: ctx => {
                const r = shown[ctx.dataIndex];
                const t = ` ${D.secondsToTime(r.seconds)}`;
                const behind = r.seconds === min ? ' · fastest' : ` · +${(r.seconds - min).toFixed(2)} behind`;
                return (r.points !== null ? `${t} · ${r.points} pts` : t) + behind;
              },
              afterLabel: tooltipCallbacks.afterLabel
            }
          }
        },
        scales: {
          x: {
            // Reversed so faster sits to the right, matching "further right is
            // better" everywhere else in the app.
            reverse: true,
            min: Math.max(0, min - pad), max: max + pad,
            title: { display: true, text: 'Personal best (faster is further right)', font: FONT },
            ticks: { font: FONT, callback: v => D.secondsToTime(v) },
            grid: { color: T.grid }
          },
          y: {
            type: 'category', labels: names, offset: true,
            ticks: { font: FONT, autoSkip: false },
            grid: { color: T.gridFaint }
          }
        }
      })
    });
  }

  /* ==========================================================================
     7. MULTI-SWIMMER SEASON COMPARISON
     ========================================================================== */

  /**
   * Season-best trajectories for a HANDFUL of chosen swimmers.
   *
   * Hard-capped, because 150 overlapping lines is not a chart — it is a
   * texture. The caller enforces the cap in the picker UI; this function
   * slices defensively as well.
   */
  function seasonComparison(canvasId, swimmers, opts) {
    const settings = opts || {};
    const eventKey = settings.eventKey;
    const usePoints = settings.metric !== 'seconds';
    const capped = swimmers.slice(0, settings.limit || 8);

    const seasonSet = new Set();
    capped.forEach(sw => {
      const ev = sw.events.get(eventKey);
      if (!ev) return;
      ev.bySeason.forEach(entry => { if (entry.season !== null) seasonSet.add(entry.season); });
    });
    const seasons = Array.from(seasonSet).sort((a, b) => a - b);
    if (!seasons.length) {
      return empty(canvasId, 'Pick a few swimmers who have raced this event to compare them across seasons.');
    }

    const datasets = capped.map((sw, i) => {
      const ev = sw.events.get(eventKey);
      const color = U.colorFor(i);
      const data = seasons.map(s => {
        if (!ev) return null;
        const entry = ev.bySeason.get(s);
        if (!entry) return null;
        return usePoints ? entry.best.points : entry.best.seconds;
      });
      return {
        label: sw.name, data,
        borderColor: color, backgroundColor: color,
        borderWidth: 2, pointRadius: 4, pointHoverRadius: 6,
        tension: 0,          // straight segments: nothing happened between seasons
        fill: false,
        spanGaps: true       // a missed season should not break the line
      };
    }).filter(d => d.data.some(v => v !== null));

    if (!datasets.length) {
      return empty(canvasId, 'None of the selected swimmers has a scorable time in this event.');
    }

    return make(canvasId, {
      type: 'line',
      data: { labels: seasons.map(String), datasets },
      options: merge(BASE_OPTS, {
        plugins: {
          legend: { position: 'top', align: 'start' },
          tooltip: {
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                if (v === null) return '';
                return usePoints
                  ? ` ${ctx.dataset.label}: ${v} pts`
                  : ` ${ctx.dataset.label}: ${D.secondsToTime(v)}`;
              }
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'Season', font: FONT },
               ticks: { font: FONT }, grid: { display: false } },
          y: usePoints ? {
            title: { display: true, text: 'Season-best points', font: FONT },
            ticks: { font: FONT }, grid: { color: T.grid }
          } : {
            reverse: true,
            title: { display: true, text: 'Season-best time (faster is higher)', font: FONT },
            ticks: { font: FONT, callback: v => D.secondsToTime(v) },
            grid: { color: T.grid }
          }
        }
      })
    });
  }

  /* ==========================================================================
     8. RACE CONSISTENCY
     ========================================================================== */

  /**
   * Every race for one swimmer plotted as "seconds off their PB at the time",
   * against date. A tight band near 0 is a reliable racer; a wide scatter
   * means the swimmer is inconsistent under pressure — a training signal that
   * raw times hide completely, because raw times mix event and improvement
   * into the same number.
   *
   * The axis is seconds, not percent, because seconds is what a coach can act
   * on: "she is landing 1.5s off her PB" sets the week's target, "3.1% off"
   * does not. The cost is that one seconds axis cannot fairly hold a 50 and a
   * 400 at once — 1.5s off a 50 is a bad swim, off a 400 it is a good one —
   * so the event selector above the progression chart filters this one too,
   * and the axis title says so when it is showing everything.
   */
  function consistency(canvasId, swimmer, opts) {
    const settings = opts || {};
    const oneEvent = !!(settings.eventKey && settings.eventKey !== 'all');
    const series = new Map();

    swimmer.events.forEach(ev => {
      if (oneEvent && ev.eventKey !== settings.eventKey) return;
      let best = Infinity;
      ev.races.forEach(r => {
        if (!r.date) return;
        // Compare each swim against the PB standing *before* it, so a new PB
        // shows as 0 rather than being measured against a future best.
        const reference = Math.min(best, r.seconds);
        const off = r.seconds - reference;
        if (r.seconds < best) best = r.seconds;
        const key = ev.stroke;
        if (!series.has(key)) series.set(key, []);
        series.get(key).push({ x: r.date.getTime(), y: off, race: r });
      });
    });

    if (!series.size) {
      return empty(canvasId, `${swimmer.name} needs races with valid dates before consistency can be shown.`);
    }

    const datasets = Array.from(series.entries()).map(([stroke, pts]) => ({
      label: stroke,
      data: pts,
      backgroundColor: (STROKE_COLORS[stroke] || T.accent) + '99',
      borderColor: STROKE_COLORS[stroke] || T.accent,
      borderWidth: 1, pointRadius: 4, pointHoverRadius: 6
    }));

    return make(canvasId, {
      type: 'scatter',
      data: { datasets },
      options: merge(BASE_OPTS, {
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: items => fmtDateFull(items[0].parsed.x),
              label: ctx => {
                const r = ctx.raw.race;
                const off = ctx.parsed.y;
                return ` ${D.secondsToTime(r.seconds)} · ${off < 0.005 ? 'at PB' : '+' + off.toFixed(2) + 's off PB'}`;
              },
              afterLabel: ctx => ` ${ctx.raw.race.course} ${ctx.raw.race.distance} ${ctx.raw.race.stroke}`
            }
          }
        },
        scales: {
          x: { type: 'linear',
               ticks: { font: FONT, callback: v => fmtDateShort(v), maxRotation: 0, autoSkipPadding: 22 },
               grid: { color: T.gridFaint } },
          y: { title: { display: true,
                         text: oneEvent
                           ? 'Seconds off personal best (lower is better)'
                           : 'Seconds off personal best — all events together, so distances are not comparable',
                         font: FONT },
               beginAtZero: true,
               ticks: { font: FONT, callback: v => v.toFixed(2) + 's' },
               grid: { color: T.grid } }
        }
      })
    });
  }

  return {
    destroy, destroyAll, empty,
    pbProgression, formGap, eventPortfolio, pointsDistribution,
    improvementLeaderboard, eventRanking, seasonComparison, consistency,
    STROKE_COLORS
  };
});
