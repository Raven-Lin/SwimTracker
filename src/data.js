/* ============================================================================
   SwimTracker — Data Layer
   ============================================================================

   Parses result CSVs and builds the indexes every view reads from.

   The performance contract
   ------------------------
   The previous version answered questions like "what is this swimmer's best
   time this year?" by calling `allData.filter(...)` inside a loop over
   swimmers inside a loop over years. At 150 swimmers x 10 years x 37,000 rows
   that is tens of millions of comparisons per redraw, and the browser locks
   up or dies.

   Everything here is built in a SINGLE PASS over the rows at load time, into
   Maps. After that, every question a view asks is a Map lookup, not a scan.
   Redrawing a chart touches only the swimmers on screen.

   The other crash this fixes: `Math.min(...bigArray)` throws
   "Maximum call stack size exceeded" once the array passes ~65k entries,
   because spread pushes every element onto the call stack. Nothing in this
   file uses spread on an unbounded array — minimums are accumulated in
   plain loops.
============================================================================ */

(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./points.js') : root.STPoints
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  /* ==========================================================================
     CSV PARSING
     ========================================================================== */

  /**
   * RFC 4180 CSV parser.
   *
   * The old parser split on "\n" and toggled a quote flag, which broke on:
   *   - escaped quotes ("" inside a quoted field)
   *   - newlines inside quoted fields (meet names sometimes contain them)
   *   - CRLF line endings (left a stray \r on the last column of every row)
   *   - the UTF-8 BOM that Excel writes (turned "name" into "﻿name",
   *     so every lookup of the name column silently returned undefined)
   *
   * All four are handled here.
   */
  function parseCSV(text) {
    if (typeof text !== 'string') return [];
    // Strip UTF-8 BOM.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    let fieldWasQuoted = false;

    while (i < n) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }

      if (ch === '"') { inQuotes = true; fieldWasQuoted = true; i++; continue; }

      if (ch === ',') {
        row.push(fieldWasQuoted ? field : field.trim());
        field = ''; fieldWasQuoted = false; i++; continue;
      }

      if (ch === '\r') {
        // Consume CRLF or a lone CR as one line break.
        if (text[i + 1] === '\n') i++;
        row.push(fieldWasQuoted ? field : field.trim());
        rows.push(row);
        row = []; field = ''; fieldWasQuoted = false; i++; continue;
      }

      if (ch === '\n') {
        row.push(fieldWasQuoted ? field : field.trim());
        rows.push(row);
        row = []; field = ''; fieldWasQuoted = false; i++; continue;
      }

      field += ch; i++;
    }

    // Final field / row (files often lack a trailing newline).
    if (field.length > 0 || row.length > 0) {
      row.push(fieldWasQuoted ? field : field.trim());
      rows.push(row);
    }

    // Drop entirely blank lines.
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
  }

  /** CSV text -> array of objects keyed by header name. */
  function parseCSVToObjects(text) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    const headers = rows[0].map(h => String(h).trim().replace(/^﻿/, '').toLowerCase());
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const vals = rows[i];
      const obj = {};
      for (let j = 0; j < headers.length; j++) obj[headers[j]] = vals[j] !== undefined ? vals[j] : '';
      out.push(obj);
    }
    return out;
  }

  /** Serialise objects back to CSV, quoting correctly. */
  function toCSV(rows, columns) {
    if (!rows.length) return columns ? columns.join(',') + '\n' : '';
    const cols = columns || Object.keys(rows[0]);
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(',')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cells = new Array(cols.length);
      for (let j = 0; j < cols.length; j++) cells[j] = esc(r[cols[j]]);
      lines.push(cells.join(','));
    }
    return lines.join('\n') + '\n';
  }

  /* ==========================================================================
     TIME PARSING
     ========================================================================== */

  /**
   * "1:18.14" -> 78.14, "29.30" -> 29.3, "1:02:33.44" -> 3753.44.
   * Returns null for anything unparseable, so a junk row is dropped rather
   * than poisoning a chart axis with NaN.
   */
  function timeToSeconds(t) {
    if (t === null || t === undefined) return null;
    if (typeof t === 'number') return Number.isFinite(t) && t > 0 ? t : null;
    const s = String(t).trim();
    if (!s) return null;
    if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d{1,3})?$|^\d+(\.\d{1,3})?$/.test(s)) return null;

    const parts = s.split(':');
    let seconds = 0;
    for (let i = 0; i < parts.length; i++) {
      const v = parseFloat(parts[i]);
      if (!Number.isFinite(v)) return null;
      seconds = seconds * 60 + v;
    }
    return seconds > 0 && seconds < 86400 ? seconds : null;
  }

  /**
   * Format for coaches, not for computers.
   * Under a minute they write "29.30", never "0:29.30". Over a minute it is
   * "1:18.14". Getting this wrong makes every table look subtly amateur.
   */
  function secondsToTime(s) {
    if (s === null || s === undefined || !Number.isFinite(s)) return '—';
    if (s < 60) return s.toFixed(2);
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
  }

  /** Signed delta, e.g. "-1.24" (faster) or "+0.33" (slower). */
  function formatDelta(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
    const sign = sec < 0 ? '−' : '+';
    return sign + Math.abs(sec).toFixed(2);
  }

  /* ==========================================================================
     DATE PARSING
     ========================================================================== */

  /** Accepts YYYY-MM-DD and DD-MM-YYYY (what the scraper emits upstream). */
  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function isoDate(d) {
    return d ? d.toISOString().slice(0, 10) : '';
  }

  /**
   * Choose which season counts as "the current one" for season-best purposes.
   *
   * The obvious answer — the season containing the most recent race — is
   * wrong in a way that bites constantly. Seasons roll over, and for the
   * first few weeks of a new one only a handful of swimmers have raced. Take
   * the latest season literally and the ENTIRE squad's season best vanishes
   * because one swimmer swam a time trial in January.
   *
   * So: start at the latest season and step back while it holds less than a
   * quarter of the racing of the season before it. That treats a
   * barely-started season as "not yet the season we judge form by", while a
   * genuinely active new season is picked immediately.
   *
   * This is a default, not a verdict — the coach can override it in the UI,
   * and `seasonCounts` is exposed so it can be labelled honestly.
   */
  const SEASON_ACTIVITY_THRESHOLD = 0.25;

  function pickCurrentSeason(counts) {
    const seasons = Array.from(counts.keys())
      .filter(s => s !== null && s !== undefined)
      .sort((a, b) => a - b);
    if (!seasons.length) return null;

    let i = seasons.length - 1;
    // Step back at most a couple of times; beyond that the data is simply
    // sparse and the newest season is as good an answer as any.
    let steps = 0;
    while (i > 0 && steps < 2) {
      const current = counts.get(seasons[i]) || 0;
      const previous = counts.get(seasons[i - 1]) || 0;
      if (previous > 0 && current < previous * SEASON_ACTIVITY_THRESHOLD) {
        i--; steps++;
      } else {
        break;
      }
    }
    return seasons[i];
  }

  /**
   * Which season a date belongs to.
   *
   * Coaches do not think in calendar years — an Australian season commonly
   * starts in October, so a December swim and the following March swim are the
   * same season's work. `seasonStartMonth` (1–12) makes that configurable;
   * with the default of 1 a season is simply the calendar year.
   *
   * The label is the year the season *ends* in, which is how squads talk
   * about it ("the 2026 season").
   */
  function seasonOf(date, seasonStartMonth) {
    if (!date) return null;
    const startM = seasonStartMonth || 1;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    if (startM === 1) return y;
    return m >= startM ? y + 1 : y;
  }

  /* ==========================================================================
     ROW NORMALISATION
     ========================================================================== */

  const AGE_RE = /(\d{1,2})/;

  function normalizeAgeGroup(v) {
    if (!v) return null;
    const m = AGE_RE.exec(String(v));
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Turn one raw CSV object into a canonical race record, or null if it is
   * not usable. Rejecting here (rather than letting undefined flow into a
   * chart) is what stops one malformed row from blanking a whole view.
   */
  function normalizeRow(raw, genderLookup) {
    const name = String(raw.name || raw.swimmer || '').trim();
    if (!name) return null;

    const seconds = timeToSeconds(raw.time);
    if (seconds === null) return null;

    const course = P.normalizeCourse(raw.course);
    const stroke = P.normalizeStroke(raw.stroke);
    const distance = P.normalizeDistance(raw.distance);
    if (!course || !stroke || !distance) return null;

    const date = parseDate(raw.race_date || raw.date);

    // Gender may come from the CSV itself or from the coach's roster
    // assignment. The CSV wins when present.
    let gender = P.normalizeGender(raw.gender || raw.sex);
    if (!gender && genderLookup) gender = genderLookup(name) || null;

    const points = P.score(seconds, gender, course, distance, stroke);

    return {
      name,
      club: String(raw.club || '').trim(),
      gender,
      course,
      distance,
      stroke,
      eventKey: P.eventKey(course, distance, stroke),
      time: secondsToTime(seconds),
      seconds,
      points,
      date,
      dateISO: isoDate(date),
      year: date ? date.getUTCFullYear() : null,
      ageGroup: normalizeAgeGroup(raw.age_grp || raw.age_group || raw.age),
      meet: String(raw.race_name || raw.meet || '').trim()
    };
  }

  /**
   * Two rows describe the same swim if the swimmer, event, date and time all
   * agree. Re-scraping a swimmer previously appended a duplicate copy of
   * every one of their races; this key is what makes imports idempotent.
   */
  function raceKey(r) {
    return `${r.name} ${r.eventKey} ${r.dateISO} ${r.seconds}`;
  }

  function dedupe(races) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < races.length; i++) {
      const k = raceKey(races[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(races[i]);
    }
    return out;
  }

  /* ==========================================================================
     DATASET + INDEXES
     ========================================================================== */

  /**
   * Build the full indexed dataset.
   *
   * Cost is O(rows log rows) once, dominated by the sort. Every view then
   * reads precomputed structures. This is the difference between a dashboard
   * that opens instantly with 150 swimmers and one that hangs.
   */
  function buildDataset(rawRows, opts) {
    const options = opts || {};
    const seasonStartMonth = options.seasonStartMonth || 1;
    const genderLookup = options.genderLookup || null;

    // ---- Pass 1: normalise and drop unusable rows -------------------------
    const races = [];
    let rejected = 0;
    for (let i = 0; i < rawRows.length; i++) {
      const r = normalizeRow(rawRows[i], genderLookup);
      if (r) races.push(r); else rejected++;
    }

    const deduped = dedupe(races);
    const duplicatesRemoved = races.length - deduped.length;

    // Chronological order lets every downstream pass be a single sweep:
    // "first ever swim", "PB history", "season best" all fall out of order.
    deduped.sort((a, b) => {
      const at = a.date ? a.date.getTime() : 0;
      const bt = b.date ? b.date.getTime() : 0;
      if (at !== bt) return at - bt;
      return a.seconds - b.seconds;
    });

    for (let i = 0; i < deduped.length; i++) {
      deduped[i].season = seasonOf(deduped[i].date, seasonStartMonth);
    }

    // ---- Pass 2: per-swimmer, per-event aggregates ------------------------
    /** @type {Map<string, Swimmer>} */
    const swimmers = new Map();
    /** @type {Map<string, EventAgg>} */
    const events = new Map();

    for (let i = 0; i < deduped.length; i++) {
      const r = deduped[i];

      let sw = swimmers.get(r.name);
      if (!sw) {
        sw = {
          name: r.name,
          club: r.club,
          gender: r.gender,
          ageGroup: r.ageGroup,
          races: [],
          events: new Map(),
          bestPoints: null,
          bestPointsRace: null,
          firstDate: r.date,
          lastDate: r.date,
          seasons: new Set()
        };
        swimmers.set(r.name, sw);
      }

      // Later rows carry fresher club / age-group information.
      if (r.club) sw.club = r.club;
      if (r.gender) sw.gender = r.gender;
      if (r.ageGroup !== null) sw.ageGroup = r.ageGroup;
      if (r.date) {
        if (!sw.firstDate || r.date < sw.firstDate) sw.firstDate = r.date;
        if (!sw.lastDate || r.date > sw.lastDate) sw.lastDate = r.date;
      }
      if (r.season !== null && r.season !== undefined) sw.seasons.add(r.season);
      sw.races.push(r);

      let ev = sw.events.get(r.eventKey);
      if (!ev) {
        ev = {
          eventKey: r.eventKey,
          course: r.course,
          distance: r.distance,
          stroke: r.stroke,
          races: [],
          pb: null,          // fastest race ever
          firstRace: null,   // earliest race, for improvement-since-first
          bySeason: new Map()// season -> { best race, count }
        };
        sw.events.set(r.eventKey, ev);
      }
      ev.races.push(r);
      if (!ev.firstRace) ev.firstRace = r;

      // PB tracking. Strict `<` means the FIRST swim at a tied time keeps the
      // PB flag — the old code flagged every tied swim, inflating the "PBs
      // recorded" stat and putting several gold rows in the table.
      r.isPB = false;
      if (!ev.pb || r.seconds < ev.pb.seconds) ev.pb = r;

      const seasonEntry = ev.bySeason.get(r.season);
      if (!seasonEntry) {
        ev.bySeason.set(r.season, { season: r.season, best: r, count: 1 });
      } else {
        seasonEntry.count++;
        if (r.seconds < seasonEntry.best.seconds) seasonEntry.best = r;
      }

      if (r.points !== null && (sw.bestPoints === null || r.points > sw.bestPoints)) {
        sw.bestPoints = r.points;
        sw.bestPointsRace = r;
      }

      let eagg = events.get(r.eventKey);
      if (!eagg) {
        eagg = {
          eventKey: r.eventKey,
          course: r.course,
          distance: r.distance,
          stroke: r.stroke,
          label: P.eventLabel(r.course, r.distance, r.stroke),
          count: 0,
          swimmers: new Set()
        };
        events.set(r.eventKey, eagg);
      }
      eagg.count++;
      eagg.swimmers.add(r.name);
    }

    // ---- Pass 3: flag PBs and compute per-swimmer summaries ---------------
    // How much racing each season actually holds, so the "current season" can
    // be chosen sensibly rather than from a single stray late date.
    const seasonCounts = new Map();
    for (let i = 0; i < deduped.length; i++) {
      const s = deduped[i].season;
      if (s === null || s === undefined) continue;
      seasonCounts.set(s, (seasonCounts.get(s) || 0) + 1);
    }

    const autoSeason = pickCurrentSeason(seasonCounts);
    const requested = options.currentSeason;
    const currentSeason = (requested !== undefined && requested !== null &&
                           seasonCounts.has(Number(requested)))
      ? Number(requested)
      : autoSeason;

    swimmers.forEach(sw => {
      let pbCount = 0;
      sw.events.forEach(ev => {
        if (ev.pb) { ev.pb.isPB = true; pbCount++; }

        // Season best and the gap back to the PB. This pairing is the single
        // most-used diagnostic in a coach's week: an SB close to the PB means
        // the swimmer is in form, a stale gap means they are not.
        const cur = ev.bySeason.get(currentSeason);
        ev.seasonBest = cur ? cur.best : null;
        ev.sbToPbGapSec = ev.seasonBest && ev.pb
          ? ev.seasonBest.seconds - ev.pb.seconds
          : null;
        ev.sbToPbGapPct = ev.sbToPbGapSec !== null && ev.pb.seconds
          ? (ev.sbToPbGapSec / ev.pb.seconds) * 100
          : null;

        // Improvement since the very first recorded swim in this event.
        //
        // Seconds is the headline number and the percentage is kept beside it
        // only for colour thresholds. A coach thinks in seconds: "she has taken
        // 4.2s off her 100 Free" is actionable, "she is 6.1% faster" needs
        // mental arithmetic against a time nobody has memorised. The two are
        // also not interchangeable across distances -- 1% of a 50 is half a
        // second, 1% of a 1500 is eleven -- so a percentage column silently
        // flatters the sprinters and buries the distance swimmers.
        ev.improvementSec = ev.firstRace && ev.pb
          ? ev.firstRace.seconds - ev.pb.seconds
          : null;
        ev.improvementPct = ev.improvementSec !== null && ev.firstRace.seconds
          ? (ev.improvementSec / ev.firstRace.seconds) * 100
          : null;
      });
      sw.pbCount = pbCount;
      sw.raceCount = sw.races.length;
      sw.eventCount = sw.events.size;
      sw.seasonList = Array.from(sw.seasons).sort((a, b) => a - b);
    });

    // ---- Facets for the filter controls -----------------------------------
    const strokes = new Set();
    const distances = new Set();
    const ageGroups = new Set();
    const meets = new Set();
    const seasons = new Set();
    for (let i = 0; i < deduped.length; i++) {
      const r = deduped[i];
      strokes.add(r.stroke);
      distances.add(r.distance);
      if (r.ageGroup !== null) ageGroups.add(r.ageGroup);
      if (r.meet) meets.add(r.meet);
      if (r.season !== null && r.season !== undefined) seasons.add(r.season);
    }

    const STROKE_ORDER = ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly', 'Medley'];

    return {
      races: deduped,
      swimmers,
      events,
      currentSeason,
      autoSeason,
      seasonCounts,
      seasonStartMonth,
      facets: {
        strokes: Array.from(strokes).sort(
          (a, b) => STROKE_ORDER.indexOf(a) - STROKE_ORDER.indexOf(b)
        ),
        distances: Array.from(distances).sort((a, b) => a - b),
        ageGroups: Array.from(ageGroups).sort((a, b) => a - b),
        seasons: Array.from(seasons).sort((a, b) => a - b),
        meetCount: meets.size,
        eventList: Array.from(events.values()).sort((a, b) => {
          if (a.course !== b.course) return a.course === 'LC' ? -1 : 1;
          const si = STROKE_ORDER.indexOf(a.stroke) - STROKE_ORDER.indexOf(b.stroke);
          if (si !== 0) return si;
          return a.distance - b.distance;
        })
      },
      quality: {
        rowsIn: rawRows.length,
        rowsUsed: deduped.length,
        rejected,
        duplicatesRemoved,
        missingGender: countMissingGender(swimmers),
        unscored: countUnscored(deduped)
      }
    };
  }

  function countMissingGender(swimmers) {
    let n = 0;
    swimmers.forEach(s => { if (!s.gender) n++; });
    return n;
  }

  function countUnscored(races) {
    let n = 0;
    for (let i = 0; i < races.length; i++) if (races[i].points === null) n++;
    return n;
  }

  /* ==========================================================================
     QUERIES — all read the indexes, none re-scan the full race list
     ========================================================================== */

  /**
   * The PB progression for one swimmer in one event: every race, plus a
   * `pbSoFar` value that only ever steps downward.
   *
   * Plotting `pbSoFar` as a stepped line under the scatter of individual
   * swims is the chart coaches actually read — it separates "raced well" from
   * "set a new best", which a plain line of every swim cannot show.
   */
  function progression(swimmer, eventKey) {
    const ev = swimmer.events.get(eventKey);
    if (!ev) return [];
    let best = Infinity;
    return ev.races.map(r => {
      const isNew = r.seconds < best;
      if (isNew) best = r.seconds;
      return {
        race: r,
        pbSoFar: best,
        isNewPB: isNew,
        improvementFromPrev: isNew && Number.isFinite(best) ? r.seconds - best : null
      };
    });
  }

  /**
   * Squad-wide improvement over a season, in World Aquatics points.
   *
   * Points (not seconds, not percent) because it is the only unit that lets
   * a 12 y/o's 50 Free sit honestly beside a 17 y/o's 400 IM. Ranked
   * descending, this answers "who is moving?" — the question a head coach
   * asks every month.
   */
  function improvementLeaderboard(dataset, opts) {
    const options = opts || {};
    const season = options.season !== undefined ? options.season : dataset.currentSeason;
    const rows = [];

    dataset.swimmers.forEach(sw => {
      let bestGain = null;
      let bestEv = null;
      let curBest = null;
      let prevBest = null;

      sw.events.forEach(ev => {
        const cur = ev.bySeason.get(season);
        if (!cur || cur.best.points === null) return;

        // Best points in this event before the season under review.
        let priorPoints = null;
        let priorRace = null;
        ev.bySeason.forEach(entry => {
          if (entry.season >= season) return;
          if (entry.best.points === null) return;
          if (priorPoints === null || entry.best.points > priorPoints) {
            priorPoints = entry.best.points;
            priorRace = entry.best;
          }
        });
        if (priorPoints === null) return; // no baseline — not an improvement

        const gain = cur.best.points - priorPoints;
        if (bestGain === null || gain > bestGain) {
          bestGain = gain;
          bestEv = ev;
          curBest = cur.best;
          prevBest = priorRace;
        }
      });

      if (bestGain !== null) {
        rows.push({
          name: sw.name,
          club: sw.club,
          gender: sw.gender,
          ageGroup: sw.ageGroup,
          gain: bestGain,
          event: bestEv,
          current: curBest,
          previous: prevBest
        });
      }
    });

    rows.sort((a, b) => b.gain - a.gain);
    return rows;
  }

  /**
   * One row per swimmer for the squad table: their strongest swim on the
   * points scale, plus current form.
   */
  function squadSummary(dataset, opts) {
    const options = opts || {};
    const season = options.season !== undefined ? options.season : dataset.currentSeason;
    const out = [];

    dataset.swimmers.forEach(sw => {
      // Best points swum *this* season, and the all-time best.
      let seasonPoints = null;
      let seasonRace = null;
      let inForm = null;      // percentage — drives the colour threshold only
      let inFormSec = null;   // seconds — the number actually shown

      sw.events.forEach(ev => {
        const entry = ev.bySeason.get(season);
        if (!entry || entry.best.points === null) return;
        if (seasonPoints === null || entry.best.points > seasonPoints) {
          seasonPoints = entry.best.points;
          seasonRace = entry.best;
        }
      });

      // Form = how close this season's best in the swimmer's strongest event
      // sits to their all-time PB in that event.
      //
      // Both units are carried: seconds is what the column prints, the
      // percentage only decides whether it reads as good or stale. A fixed
      // seconds threshold cannot do that job -- 0.8s off a 50 is a worry,
      // 0.8s off a 400 is nothing -- so the threshold stays proportional
      // while the number stays concrete.
      if (sw.bestPointsRace) {
        const ev = sw.events.get(sw.bestPointsRace.eventKey);
        if (ev && ev.sbToPbGapPct !== null) {
          inForm = ev.sbToPbGapPct;
          inFormSec = ev.sbToPbGapSec;
        }
      }

      out.push({
        name: sw.name,
        club: sw.club,
        gender: sw.gender,
        ageGroup: sw.ageGroup,
        raceCount: sw.raceCount,
        eventCount: sw.eventCount,
        bestPoints: sw.bestPoints,
        bestRace: sw.bestPointsRace,
        seasonPoints,
        seasonRace,
        formGapPct: inForm,
        formGapSec: inFormSec,
        lastDate: sw.lastDate,
        swimmer: sw
      });
    });

    return out;
  }

  /**
   * Rankings for one event: every swimmer's PB, ordered fastest first.
   * Optionally restricted to an age group or gender, because ranking a 12 y/o
   * against a 17 y/o in the same list is not information a coach can use.
   */
  function eventRankings(dataset, eventKey, opts) {
    const options = opts || {};
    const rows = [];

    dataset.swimmers.forEach(sw => {
      if (options.gender && options.gender !== 'all' && sw.gender !== options.gender) return;
      const ev = sw.events.get(eventKey);
      if (!ev || !ev.pb) return;
      if (options.ageGroup && options.ageGroup !== 'all') {
        const want = parseInt(options.ageGroup, 10);
        if (ev.pb.ageGroup !== want) return;
      }
      if (options.season !== undefined && options.season !== 'all') {
        const entry = ev.bySeason.get(Number(options.season));
        if (!entry) return;
        rows.push({
          name: sw.name, club: sw.club, gender: sw.gender,
          race: entry.best, seconds: entry.best.seconds,
          points: entry.best.points, count: entry.count,
          seasonBest: ev.seasonBest, pb: ev.pb
        });
        return;
      }
      rows.push({
        name: sw.name, club: sw.club, gender: sw.gender,
        race: ev.pb, seconds: ev.pb.seconds,
        points: ev.pb.points, count: ev.races.length,
        seasonBest: ev.seasonBest, pb: ev.pb
      });
    });

    rows.sort((a, b) => a.seconds - b.seconds);
    return rows;
  }

  /**
   * Grid of swimmers x events scored in points — the "who can swim what"
   * view. Empty cells are the point: they show where a squad has no data and
   * where a swimmer has never raced an event.
   */
  function coverageMatrix(dataset, opts) {
    const options = opts || {};
    const course = options.course || 'LC';
    const eventCols = dataset.facets.eventList.filter(e => e.course === course);
    const swimmerRows = [];

    dataset.swimmers.forEach(sw => {
      if (options.gender && options.gender !== 'all' && sw.gender !== options.gender) return;
      const cells = eventCols.map(ec => {
        const ev = sw.events.get(ec.eventKey);
        if (!ev || !ev.pb) return null;
        return { points: ev.pb.points, race: ev.pb, seconds: ev.pb.seconds };
      });
      let filled = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i]) filled++;
      swimmerRows.push({ swimmer: sw, cells, filled });
    });

    swimmerRows.sort((a, b) => {
      if (b.filled !== a.filled) return b.filled - a.filled;
      return a.swimmer.name.localeCompare(b.swimmer.name);
    });

    return { events: eventCols, rows: swimmerRows };
  }

  /** Histogram of best points across the squad, for the standard-at-a-glance view. */
  function pointsDistribution(dataset, binSize) {
    const size = binSize || 50;
    const bins = new Map();
    dataset.swimmers.forEach(sw => {
      if (sw.bestPoints === null) return;
      const b = Math.floor(sw.bestPoints / size) * size;
      bins.set(b, (bins.get(b) || 0) + 1);
    });
    const keys = Array.from(bins.keys()).sort((a, b) => a - b);
    if (!keys.length) return [];
    const out = [];
    for (let v = keys[0]; v <= keys[keys.length - 1]; v += size) {
      out.push({ from: v, to: v + size, count: bins.get(v) || 0 });
    }
    return out;
  }

  return {
    parseCSV,
    parseCSVToObjects,
    toCSV,
    timeToSeconds,
    secondsToTime,
    formatDelta,
    parseDate,
    isoDate,
    seasonOf,
    normalizeRow,
    raceKey,
    dedupe,
    buildDataset,
    pickCurrentSeason,
    progression,
    improvementLeaderboard,
    squadSummary,
    eventRankings,
    coverageMatrix,
    pointsDistribution
  };
});
