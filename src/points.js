/* ============================================================================
   SwimTracker — World Aquatics (FINA) Points Engine
   ============================================================================

   Why this exists
   ---------------
   A squad of 150 swimmers races dozens of different events. You cannot put a
   16 y/o girl's 200 Breaststroke and a 12 y/o boy's 50 Freestyle on the same
   axis in seconds — the numbers are meaningless next to each other.

   World Aquatics points (still widely called "FINA points") solve exactly
   this. Every swim is scored against the world record for that
   gender/course/event, so every swim in the squad lands on one 0–1000 scale.
   A 50-point gain in the 400 IM is directly comparable to a 50-point gain in
   the 50 Free. This is the standard currency coaches use to rank a squad,
   pick relays, and spot who is actually improving.

   Formula (World Aquatics):
       points = floor( 1000 * (base_time / swum_time)^3 )

   `base_time` is the world record for that event at the start of the season.
   The cubic curve is deliberate: it makes gains near the top of the scale far
   harder to earn than gains at the bottom.

   About the base times below
   --------------------------
   These follow the published World Aquatics base-time table. World records
   move, so this table carries a version stamp and is designed to be edited:
   update a number here and every chart in the app re-scores itself.

   Note on interpretation: within a single event, changing the base time
   scales everyone's points by the same factor, so rankings inside an event
   never change. Base-time drift only slightly affects cross-event
   comparison. Treat points as a strong relative measure, not a certificate.
============================================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STPoints = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE_TIME_VERSION = '2023 World Aquatics base times';

  // Times in seconds. Key: `${course}|${distance}|${stroke}` with distance in
  // metres and stroke as the canonical long name.
  const BASE_TIMES = {
    F: {
      LC: {
        '50|Freestyle': 23.61,   '100|Freestyle': 51.71,  '200|Freestyle': 112.23,
        '400|Freestyle': 235.38, '800|Freestyle': 484.79, '1500|Freestyle': 920.48,
        '50|Backstroke': 26.86,  '100|Backstroke': 57.13, '200|Backstroke': 123.14,
        '50|Breaststroke': 29.16,'100|Breaststroke': 64.13,'200|Breaststroke': 137.55,
        '50|Butterfly': 24.43,   '100|Butterfly': 54.60,  '200|Butterfly': 121.81,
        '200|Medley': 126.12,    '400|Medley': 264.38
      },
      SC: {
        '50|Freestyle': 22.93,   '100|Freestyle': 50.25,  '200|Freestyle': 110.31,
        '400|Freestyle': 231.30, '800|Freestyle': 477.42, '1500|Freestyle': 908.24,
        '50|Backstroke': 25.25,  '100|Backstroke': 54.02, '200|Backstroke': 118.04,
        '50|Breaststroke': 28.37,'100|Breaststroke': 62.36,'200|Breaststroke': 134.57,
        '50|Butterfly': 23.91,   '100|Butterfly': 52.71,  '200|Butterfly': 119.32,
        '100|Medley': 56.51,     '200|Medley': 121.63,    '400|Medley': 255.48
      }
    },
    M: {
      LC: {
        '50|Freestyle': 20.91,   '100|Freestyle': 46.40,  '200|Freestyle': 102.00,
        '400|Freestyle': 220.07, '800|Freestyle': 452.12, '1500|Freestyle': 871.02,
        '50|Backstroke': 23.71,  '100|Backstroke': 51.60, '200|Backstroke': 111.92,
        '50|Breaststroke': 25.95,'100|Breaststroke': 56.88,'200|Breaststroke': 125.48,
        '50|Butterfly': 22.27,   '100|Butterfly': 49.45,  '200|Butterfly': 110.34,
        '200|Medley': 114.00,    '400|Medley': 242.50
      },
      SC: {
        '50|Freestyle': 19.90,   '100|Freestyle': 44.84,  '200|Freestyle': 98.61,
        '400|Freestyle': 212.25, '800|Freestyle': 440.46, '1500|Freestyle': 846.88,
        '50|Backstroke': 22.11,  '100|Backstroke': 48.33, '200|Backstroke': 105.63,
        '50|Breaststroke': 24.95,'100|Breaststroke': 55.28,'200|Breaststroke': 120.16,
        '50|Butterfly': 21.32,   '100|Butterfly': 47.71,  '200|Butterfly': 106.85,
        '100|Medley': 49.28,     '200|Medley': 108.88,    '400|Medley': 234.81
      }
    }
  };

  /* --------------------------------------------------------------------------
     Gender normalisation.

     The source data does not always agree with itself: a coach may type
     "female", the CSV may carry "F", an import may carry "Girls". Everything
     funnels through here so the rest of the app only ever sees 'M', 'F' or
     null. Returning null (rather than guessing) matters — a wrong guess
     silently scores a swimmer against the wrong world record.
  -------------------------------------------------------------------------- */
  function normalizeGender(g) {
    if (g === null || g === undefined) return null;
    const s = String(g).trim().toLowerCase();
    if (!s) return null;
    if (s === 'f' || s === 'female' || s === 'girl' || s === 'girls' || s === 'w' || s === 'women') return 'F';
    if (s === 'm' || s === 'male' || s === 'boy' || s === 'boys' || s === 'men') return 'M';
    return null;
  }

  /* --------------------------------------------------------------------------
     Stroke normalisation. Swimming Australia exports long names, but hand-made
     CSVs commonly use "Free"/"Fly"/"IM". Accept all of them.
  -------------------------------------------------------------------------- */
  const STROKE_ALIASES = {
    free: 'Freestyle', freestyle: 'Freestyle', fr: 'Freestyle',
    back: 'Backstroke', backstroke: 'Backstroke', bk: 'Backstroke',
    breast: 'Breaststroke', breaststroke: 'Breaststroke', br: 'Breaststroke',
    fly: 'Butterfly', butterfly: 'Butterfly', bf: 'Butterfly',
    im: 'Medley', medley: 'Medley', 'individual medley': 'Medley'
  };

  function normalizeStroke(s) {
    if (!s) return null;
    const key = String(s).trim().toLowerCase();
    return STROKE_ALIASES[key] || null;
  }

  /* --------------------------------------------------------------------------
     Distance normalisation: "100M", "100m", "100", 100 -> 100 (number).
  -------------------------------------------------------------------------- */
  function normalizeDistance(d) {
    if (d === null || d === undefined) return null;
    const m = String(d).match(/(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function normalizeCourse(c) {
    if (!c) return null;
    const s = String(c).trim().toUpperCase();
    if (s === 'LC' || s === 'LCM' || s === 'L' || s === 'LONG COURSE') return 'LC';
    if (s === 'SC' || s === 'SCM' || s === 'S' || s === 'SHORT COURSE') return 'SC';
    return null;
  }

  /** Canonical event key used everywhere: "LC|100|Freestyle". */
  function eventKey(course, distance, stroke) {
    return `${course}|${distance}|${stroke}`;
  }

  /** Human label: "LC 100m Freestyle". */
  function eventLabel(course, distance, stroke) {
    return `${course} ${distance}m ${stroke}`;
  }

  /**
   * The abbreviations coaches actually write on a whiteboard. Slicing the
   * first two letters instead gives "Bu" and "Me", which nobody in swimming
   * says — it is "Fly" and "IM".
   */
  const STROKE_SHORT = {
    Freestyle: 'Free', Backstroke: 'Back', Breaststroke: 'Breast',
    Butterfly: 'Fly', Medley: 'IM'
  };
  function strokeShort(stroke) {
    return STROKE_SHORT[stroke] || stroke;
  }

  function baseTime(gender, course, distance, stroke) {
    const g = BASE_TIMES[gender];
    if (!g) return null;
    const c = g[course];
    if (!c) return null;
    return c[`${distance}|${stroke}`] ?? null;
  }

  /**
   * Score one swim.
   * Returns an integer 0–~1000+, or null when the event has no base time
   * (e.g. an unusual distance) or the gender is unknown. Callers must handle
   * null rather than defaulting to 0 — a 0 would drag squad averages down and
   * make an unscored swimmer look like the worst in the squad.
   */
  function score(seconds, gender, course, distance, stroke) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const base = baseTime(gender, course, distance, stroke);
    if (!base) return null;
    const pts = 1000 * Math.pow(base / seconds, 3);
    if (!Number.isFinite(pts)) return null;
    // Guard against absurd values from a mis-parsed time (e.g. "1.00" for a
    // 400 Free) that would otherwise dominate every chart's y-axis.
    if (pts > 1600) return null;
    return Math.floor(pts);
  }

  /** True when we hold a base time for this event/gender combination. */
  function isScorable(gender, course, distance, stroke) {
    return baseTime(gender, course, distance, stroke) !== null;
  }

  /** Every event we can score, for building "what's missing" views. */
  function knownEvents(gender, course) {
    const table = BASE_TIMES[gender] && BASE_TIMES[gender][course];
    if (!table) return [];
    return Object.keys(table).map(k => {
      const [distance, stroke] = k.split('|');
      return { course, distance: parseInt(distance, 10), stroke };
    });
  }

  return {
    BASE_TIME_VERSION,
    BASE_TIMES,
    normalizeGender,
    normalizeStroke,
    normalizeDistance,
    normalizeCourse,
    eventKey,
    eventLabel,
    strokeShort,
    baseTime,
    score,
    isScorable,
    knownEvents
  };
});
