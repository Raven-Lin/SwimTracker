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

  const BASE_OPTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 220 },
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { labels: { font: FONT, usePointStyle: true, boxWidth: 8, padding: 12 } },
      tooltip: {
        backgroundColor: 'rgba(15,23,42,.94)',
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

  const STROKE_COLORS = {
    Freestyle: '#0086b8', Backstroke: '#7c3aed',
    Breaststroke: '#15803d', Butterfly: '#e09400', Medley: '#b91c1c'
  };

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
            borderColor: '#e09400',
            borderWidth: 2,
            borderDash: [],
            pointRadius: 0,
            fill: false,
            order: 3
          },
          {
            label: 'Race',
            data: points,
            backgroundColor: 'rgba(0,134,184,.5)',
            borderColor: '#0086b8',
            borderWidth: 1,
            pointRadius: 4,
            pointHoverRadius: 6,
            order: 2
          },
          {
            label: 'New PB',
            data: newPBs,
            backgroundColor: '#e09400',
            borderColor: '#fff',
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
            grid: { color: 'rgba(15,23,42,.05)' }
          },
          y: {
            // Faster is up. See the header note — this is not optional.
            reverse: true,
            title: { display: true, text: 'Time (faster is higher)', font: FONT },
            ticks: { font: FONT, callback: v => D.secondsToTime(v) },
            grid: { color: 'rgba(15,23,42,.07)' }
          }
        }
      })
    });
  }

  /* ==========================================================================
     2. SEASON BEST vs PERSONAL BEST — the form chart
     ========================================================================== */

  /**
   * One horizontal range bar per event, spanning this season's best up to the
   * all-time PB, scored in points. A short bar means the swimmer is racing at
   * their level right now; a long bar means there is a gap to close.
   */
  function formGap(canvasId, swimmer, opts) {
    const settings = opts || {};
    const rows = [];
    swimmer.events.forEach(ev => {
      if (!ev.pb || ev.pb.points === null) return;
      if (!ev.seasonBest || ev.seasonBest.points === null) return;
      rows.push({
        label: `${ev.course} ${ev.distance} ${P.strokeShort(ev.stroke)}`,
        sb: ev.seasonBest.points,
        pb: ev.pb.points,
        gapPct: ev.sbToPbGapPct || 0,
        gapSec: ev.sbToPbGapSec || 0,
        ev
      });
    });

    if (!rows.length) {
      return empty(canvasId, settings.seasonLabel
        ? `${swimmer.name} has not raced in the ${settings.seasonLabel} season, so there is no season best to compare against their PBs yet.`
        : `${swimmer.name} has no season best to compare against their PBs yet.`);
    }
    rows.sort((a, b) => b.pb - a.pb);
    const shown = rows.slice(0, settings.limit || 12);

    return make(canvasId, {
      type: 'bar',
      data: {
        labels: shown.map(r => r.label),
        datasets: [
          {
            label: 'Season best → personal best',
            // Floating bars: [start, end]. The bar IS the gap.
            data: shown.map(r => [r.sb, r.pb]),
            backgroundColor: shown.map(r =>
              r.gapPct <= 0.01 ? 'rgba(21,128,61,.75)'      // at PB — in form
                : r.gapPct < 2 ? 'rgba(0,134,184,.65)'      // within touching distance
                : 'rgba(224,148,0,.6)'),                    // work to do
            borderColor: shown.map(r =>
              r.gapPct <= 0.01 ? '#15803d' : r.gapPct < 2 ? '#0086b8' : '#e09400'),
            borderWidth: 1,
            borderRadius: 3,
            barPercentage: 0.72
          }
        ]
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
                  ` Season best: ${D.secondsToTime(r.ev.seasonBest.seconds)} (${r.sb} pts)`,
                  ` Personal best: ${D.secondsToTime(r.ev.pb.seconds)} (${r.pb} pts)`,
                  ` Gap: ${r.gapSec <= 0 ? 'at PB' : D.formatDelta(r.gapSec) + 's · ' + r.gapPct.toFixed(1) + '%'}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'World Aquatics points', font: FONT },
            ticks: { font: FONT },
            grid: { color: 'rgba(15,23,42,.07)' }
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
          backgroundColor: shown.map(r => (STROKE_COLORS[r.stroke] || '#0086b8') + 'cc'),
          borderColor: shown.map(r => STROKE_COLORS[r.stroke] || '#0086b8'),
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
            beginAtZero: true, ticks: { font: FONT }, grid: { color: 'rgba(15,23,42,.07)' }
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
          backgroundColor: 'rgba(0,134,184,.68)',
          borderColor: '#0086b8', borderWidth: 1,
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
               grid: { color: 'rgba(15,23,42,.07)' } }
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
          backgroundColor: shown.map(r => r.gain >= 0 ? 'rgba(21,128,61,.72)' : 'rgba(185,28,28,.7)'),
          borderColor: shown.map(r => r.gain >= 0 ? '#15803d' : '#b91c1c'),
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
               ticks: { font: FONT }, grid: { color: 'rgba(15,23,42,.07)' } },
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
            backgroundColor: shown.map(r => r.points === best ? 'rgba(224,148,0,.85)' : 'rgba(0,134,184,.6)'),
            borderColor: shown.map(r => r.points === best ? '#e09400' : '#0086b8'),
            borderWidth: 1, borderRadius: 3, barPercentage: 0.8
          }]
        },
        options: merge(BASE_OPTS, {
          indexAxis: 'y',
          plugins: { legend: { display: false }, tooltip: { callbacks: tooltipCallbacks } },
          scales: {
            x: { title: { display: true, text: 'World Aquatics points', font: FONT },
                 beginAtZero: true, ticks: { font: FONT }, grid: { color: 'rgba(15,23,42,.07)' } },
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
          backgroundColor: shown.map(r => r.seconds === min ? '#e09400' : 'rgba(0,134,184,.75)'),
          borderColor: shown.map(r => r.seconds === min ? '#b87700' : '#0086b8'),
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
            grid: { color: 'rgba(15,23,42,.07)' }
          },
          y: {
            type: 'category', labels: names, offset: true,
            ticks: { font: FONT, autoSkip: false },
            grid: { color: 'rgba(15,23,42,.045)' }
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
            ticks: { font: FONT }, grid: { color: 'rgba(15,23,42,.07)' }
          } : {
            reverse: true,
            title: { display: true, text: 'Season-best time (faster is higher)', font: FONT },
            ticks: { font: FONT, callback: v => D.secondsToTime(v) },
            grid: { color: 'rgba(15,23,42,.07)' }
          }
        }
      })
    });
  }

  /* ==========================================================================
     8. RACE CONSISTENCY
     ========================================================================== */

  /**
   * Every race for one swimmer plotted as "percent off their PB at the time",
   * against date. A tight band near 0% is a reliable racer; a wide scatter
   * means the swimmer is inconsistent under pressure — a training signal that
   * raw times hide completely, because raw times mix event and improvement
   * into the same number.
   */
  function consistency(canvasId, swimmer, opts) {
    const settings = opts || {};
    const series = new Map();

    swimmer.events.forEach(ev => {
      if (settings.eventKey && settings.eventKey !== 'all' && ev.eventKey !== settings.eventKey) return;
      let best = Infinity;
      ev.races.forEach(r => {
        if (!r.date) return;
        // Compare each swim against the PB standing *before* it, so a new PB
        // shows as 0% rather than being measured against a future best.
        const reference = Math.min(best, r.seconds);
        const pct = reference > 0 ? ((r.seconds - reference) / reference) * 100 : 0;
        if (r.seconds < best) best = r.seconds;
        const key = ev.stroke;
        if (!series.has(key)) series.set(key, []);
        series.get(key).push({ x: r.date.getTime(), y: pct, race: r });
      });
    });

    if (!series.size) {
      return empty(canvasId, `${swimmer.name} needs races with valid dates before consistency can be shown.`);
    }

    const datasets = Array.from(series.entries()).map(([stroke, pts]) => ({
      label: stroke,
      data: pts,
      backgroundColor: (STROKE_COLORS[stroke] || '#0086b8') + '99',
      borderColor: STROKE_COLORS[stroke] || '#0086b8',
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
                const pct = ctx.parsed.y;
                return ` ${D.secondsToTime(r.seconds)} · ${pct < 0.005 ? 'at PB' : '+' + pct.toFixed(2) + '% off PB'}`;
              },
              afterLabel: ctx => ` ${ctx.raw.race.course} ${ctx.raw.race.distance} ${ctx.raw.race.stroke}`
            }
          }
        },
        scales: {
          x: { type: 'linear',
               ticks: { font: FONT, callback: v => fmtDateShort(v), maxRotation: 0, autoSkipPadding: 22 },
               grid: { color: 'rgba(15,23,42,.05)' } },
          y: { title: { display: true, text: '% off personal best (lower is better)', font: FONT },
               beginAtZero: true,
               ticks: { font: FONT, callback: v => v.toFixed(1) + '%' },
               grid: { color: 'rgba(15,23,42,.07)' } }
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
