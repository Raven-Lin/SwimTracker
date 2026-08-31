/* ============================================================================
   SwimTracker — Application
   ============================================================================

   Wires the data layer, charts and UI together. Runs entirely in the browser:
   no server, no build step, no network. Opening index.html from disk is a
   complete, working install.

   Two rules keep this fast with 150 swimmers:

   * Only the ACTIVE panel renders. Switching tabs renders that tab; a filter
     change re-renders only what depends on it. The old build rebuilt every
     chart and every table on every interaction.
   * The dataset is rebuilt only when the underlying rows or the season
     setting change — never on a filter change. Filtering reads the prebuilt
     indexes.
============================================================================ */

(function () {
  'use strict';

  const P = window.STPoints;
  const D = window.STData;
  const S = window.STStore;
  const U = window.STUi;
  const C = window.STCharts;

  const KEY_ROWS = 'rows.csv';
  const KEY_GENDERS = 'genders';
  const KEY_SETTINGS = 'settings';

  const IMPORT_COLUMNS = [
    'name', 'gender', 'club', 'course', 'distance', 'stroke',
    'time', 'race_date', 'age_grp', 'race_name'
  ];

  const state = {
    rawRows: [],
    dataset: null,
    genderOverrides: {},
    settings: { seasonStartMonth: 1, currentSeason: null },
    activePanel: 'data',
    comparison: [],
    renderedPanels: new Set()
  };

  /* ==========================================================================
     BOOT
     ========================================================================== */

  async function boot() {
    wireTabs();
    wireSeason();
    wireData();
    wireSquad();
    wireSwimmer();
    wireEvents();
    wireCoverage();
    wireResults();

    const versionNode = document.getElementById('base-version');
    if (versionNode) versionNode.textContent = `Base times: ${P.BASE_TIME_VERSION}.`;

    try {
      const [csv, genders, settings] = await Promise.all([
        S.get(KEY_ROWS, ''),
        S.get(KEY_GENDERS, {}),
        S.get(KEY_SETTINGS, { seasonStartMonth: 1, currentSeason: null })
      ]);
      state.genderOverrides = genders || {};
      state.settings = Object.assign({ seasonStartMonth: 1, currentSeason: null }, settings || {});
      document.getElementById('set-season-start').value = String(state.settings.seasonStartMonth);
      if (csv) {
        state.rawRows = D.parseCSVToObjects(csv);
        rebuild({ silent: true });
      }
    } catch (err) {
      // A storage failure must not leave a blank page — the coach can still
      // import a CSV and work normally, they just start empty.
      console.warn('Could not restore saved data:', err);
      showImportReport([{
        kind: 'warn',
        title: 'Could not restore your saved data',
        body: 'Import your CSV again to continue. ' + (err && err.message ? err.message : '')
      }]);
    }

    renderStorageStatus();
    if (!state.rawRows.length) selectPanel('data');
  }

  /* ==========================================================================
     TABS
     ========================================================================== */

  function wireSeason() {
    document.getElementById('season-select').addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      state.settings.currentSeason = Number.isFinite(v) ? v : null;
      S.set(KEY_SETTINGS, state.settings);
      rebuild();
      U.toast(`Season bests now measured against ${state.settings.currentSeason}`);
    });
  }

  function wireTabs() {
    U.$$('.tab').forEach(btn => {
      btn.addEventListener('click', () => selectPanel(btn.getAttribute('data-panel')));
      btn.addEventListener('keydown', e => {
        // Roving arrow-key navigation between tabs, as expected of a tablist.
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const tabs = U.$$('.tab').filter(t => !t.disabled);
        const i = tabs.indexOf(btn);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        if (next) { next.focus(); selectPanel(next.getAttribute('data-panel')); }
      });
    });
  }

  function selectPanel(name) {
    state.activePanel = name;
    U.$$('.tab').forEach(t => {
      const on = t.getAttribute('data-panel') === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    U.$$('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
    renderPanel(name);
  }

  function setTabsEnabled(on) {
    ['squad', 'swimmer', 'events', 'coverage', 'results'].forEach(n => {
      const t = document.getElementById('tab-' + n);
      if (t) t.disabled = !on;
    });
  }

  /**
   * Charts must be built while their canvas is visible. Chart.js measures the
   * canvas at construction time, and a canvas inside a `hidden` panel measures
   * zero — which is why deferring each panel's render until it is shown is
   * both the fast option and the correct one.
   */
  function renderPanel(name) {
    if (!state.dataset) return;
    switch (name) {
      case 'squad':    renderSquad(); break;
      case 'swimmer':  renderSwimmer(); break;
      case 'events':   renderEvents(); break;
      case 'coverage': renderCoverage(); break;
      case 'results':  renderResults(); break;
      case 'data':     renderRoster(); renderStorageStatus(); break;
    }
    state.renderedPanels.add(name);
  }

  /* ==========================================================================
     DATA IMPORT
     ========================================================================== */

  function wireData() {
    const dz = document.getElementById('dropzone');
    const input = document.getElementById('file-input');

    document.getElementById('choose-file').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files && input.files.length) importFiles(Array.from(input.files));
      input.value = '';   // let the same file be re-picked after a fix
    });

    ['dragenter', 'dragover'].forEach(ev =>
      dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', e => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) importFiles(Array.from(files));
    });

    document.getElementById('load-sample').addEventListener('click', loadSample);

    document.getElementById('set-season-start').addEventListener('change', e => {
      state.settings.seasonStartMonth = parseInt(e.target.value, 10) || 1;
      // Season labels shift when the start month moves, so a pinned season
      // number no longer means what the coach picked. Fall back to the
      // automatic choice rather than silently pinning the wrong year.
      state.settings.currentSeason = null;
      S.set(KEY_SETTINGS, state.settings);
      rebuild();
      U.toast('Season grouping updated');
    });

    document.getElementById('roster-apply').addEventListener('click', applyRoster);
    document.getElementById('export-all').addEventListener('click', exportAll);
    document.getElementById('clear-all').addEventListener('click', clearAll);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read ' + file.name));
      reader.readAsText(file);
    });
  }

  async function importFiles(files) {
    U.busy(true, `Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    await U.nextFrame();

    const reports = [];
    const incoming = [];

    for (const file of files) {
      try {
        const text = await readFile(file);
        const objs = D.parseCSVToObjects(text);
        if (!objs.length) {
          reports.push({ kind: 'warn', title: `${file.name} is empty`, body: 'No rows were found in the file.' });
          continue;
        }
        const headers = Object.keys(objs[0]);
        if (headers.indexOf('name') === -1 || headers.indexOf('time') === -1) {
          reports.push({
            kind: 'error',
            title: `${file.name} does not look like a results file`,
            body: `It needs at least a "name" and a "time" column. Found: ${headers.slice(0, 10).join(', ')}.`
          });
          continue;
        }
        incoming.push({ file: file.name, rows: objs });
      } catch (err) {
        reports.push({ kind: 'error', title: `Could not read ${file.name}`, body: err.message || String(err) });
      }
    }

    if (!incoming.length) {
      U.busy(false);
      showImportReport(reports);
      return;
    }

    const before = state.rawRows.length;
    incoming.forEach(i => { state.rawRows = state.rawRows.concat(i.rows); });

    const result = rebuild({ autoNavigate: before === 0 });

    // Persist the deduplicated, canonical form rather than the raw imports —
    // this is what stops the stored file growing every time a coach re-imports.
    state.rawRows = datasetToRawRows(state.dataset);
    await persistRows();

    U.busy(false);

    incoming.forEach(i => reports.push({
      kind: 'ok', title: `Imported ${i.file}`, body: `${i.rows.length} rows read.`
    }));
    reports.push(qualityReport(result, before));
    showImportReport(reports);
    U.toast(`${state.dataset.swimmers.size} swimmers loaded`);
  }

  /**
   * Fetch the demo dataset without using fetch().
   *
   * A page opened by double-clicking index.html has an opaque origin, so
   * fetch() and XHR to a sibling file are treated as cross-origin and
   * blocked — which broke "Load sample data" for the most obvious way to
   * open the app. A classic <script> tag is exempt from that rule, so the
   * same CSV also ships as assets/sample-squad.js, which assigns the text to
   * a global. This path works identically from disk and over HTTP.
   */
  function loadSampleText() {
    if (window.__SWIMTRACKER_SAMPLE__) return Promise.resolve(window.__SWIMTRACKER_SAMPLE__);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'assets/sample-squad.js';
      script.onload = () => {
        if (window.__SWIMTRACKER_SAMPLE__) resolve(window.__SWIMTRACKER_SAMPLE__);
        else reject(new Error('the sample file loaded but contained no data'));
      };
      script.onerror = () => reject(new Error('assets/sample-squad.js could not be loaded'));
      document.head.appendChild(script);
    });
  }

  async function loadSample() {
    U.busy(true, 'Loading sample data\u2026');
    try {
      const text = await loadSampleText();
      const objs = D.parseCSVToObjects(text);
      const wasEmpty = state.rawRows.length === 0;
      state.rawRows = state.rawRows.concat(objs);
      const result = rebuild({ autoNavigate: wasEmpty });
      state.rawRows = datasetToRawRows(state.dataset);
      await persistRows();
      showImportReport([
        { kind: 'ok', title: 'Sample data loaded', body: `${objs.length} rows from a 24-swimmer demo squad.` },
        qualityReport(result, 0)
      ]);
      U.toast('Sample data loaded');
    } catch (err) {
      // Only reachable if the file is genuinely missing from the download.
      showImportReport([{
        kind: 'warn',
        title: 'Could not load the sample data',
        body: (err && err.message ? err.message + '. ' : '') +
              'Use \u201cChoose CSV file\u201d and pick assets/sample-squad.csv from the ' +
              'folder you unzipped, or your own results CSV.'
      }]);
    } finally {
      U.busy(false);
    }
  }

  function datasetToRawRows(ds) {
    return ds.races.map(r => ({
      name: r.name,
      gender: r.gender || '',
      club: r.club,
      course: r.course,
      distance: r.distance + 'M',
      stroke: r.stroke,
      time: r.time,
      race_date: r.dateISO,
      age_grp: r.ageGroup !== null ? r.ageGroup + 'y/o' : '',
      race_name: r.meet
    }));
  }

  function persistRows() {
    const csv = D.toCSV(state.rawRows, IMPORT_COLUMNS);
    return S.set(KEY_ROWS, csv).then(() => renderStorageStatus());
  }

  function qualityReport(ds, rowsBefore) {
    const q = ds.quality;
    const lines = [`${ds.races.length} races across ${ds.swimmers.size} swimmers.`];
    if (q.duplicatesRemoved) lines.push(`${q.duplicatesRemoved} duplicate rows ignored.`);
    if (q.rejected) lines.push(`${q.rejected} rows skipped (no usable time, event or name).`);
    if (q.missingGender) {
      lines.push(`${q.missingGender} swimmer${q.missingGender === 1 ? ' has' : 's have'} no gender set, ` +
                 `so ${q.missingGender === 1 ? 'their swims are' : 'their swims are'} not scored in points — set them below.`);
    }
    return {
      kind: q.missingGender || q.rejected ? 'warn' : 'ok',
      title: 'Import summary',
      body: lines.join(' ')
    };
  }

  function showImportReport(reports) {
    const node = document.getElementById('import-report');
    if (!node) return;
    U.setHTML(node, reports.filter(Boolean).map(r => {
      const cls = r.kind === 'error' ? 'notice-error'
        : r.kind === 'warn' ? 'notice-warn'
        : r.kind === 'ok' ? 'notice-ok' : 'notice-info';
      return `<div class="notice ${cls}"><div><strong>${U.esc(r.title)}</strong>${U.esc(r.body)}</div></div>`;
    }));
  }

  /* ==========================================================================
     REBUILD
     ========================================================================== */

  function rebuild(opts) {
    const settings = opts || {};
    const ds = D.buildDataset(state.rawRows, {
      seasonStartMonth: state.settings.seasonStartMonth,
      currentSeason: state.settings.currentSeason,
      genderLookup: name => state.genderOverrides[name] || null
    });
    state.dataset = ds;

    const has = ds.races.length > 0;
    setTabsEnabled(has);
    updateMeta();
    populateFacets();

    // Anything already drawn is now stale. Drop the charts and mark every
    // panel dirty; the active one redraws immediately, the rest when opened.
    C.destroyAll();
    state.renderedPanels.clear();

    // Drop comparison picks that no longer exist in the data.
    state.comparison = state.comparison.filter(n => ds.swimmers.has(n));

    // Jump to the squad view only on the FIRST import, when the coach has
    // nothing to look at yet. On a later import they are on the Data tab
    // reading the import summary, and yanking them away hides it.
    if (has && settings.autoNavigate && state.activePanel === 'data') {
      selectPanel('squad');
      return ds;
    }
    renderPanel(state.activePanel);
    return ds;
  }

  function updateMeta() {
    const ds = state.dataset;
    const node = document.getElementById('meta-summary');
    const sel = document.getElementById('season-select');
    const lbl = document.querySelector('.season-label');

    if (!ds || !ds.races.length) {
      node.textContent = 'No data loaded';
      sel.hidden = true;
      if (lbl) lbl.hidden = true;
      return;
    }

    node.textContent = `${ds.swimmers.size} swimmers · ${ds.races.length.toLocaleString()} races`;

    // Show how much racing each season holds. The default is a judgement call
    // (see pickCurrentSeason), so the coach can see it and change it.
    const seasons = ds.facets.seasons.slice().reverse();
    sel.hidden = seasons.length < 2;
    if (lbl) lbl.hidden = sel.hidden;
    if (sel.hidden) return;

    U.fillSelect(sel, seasons.map(s => ({
      value: String(s),
      label: `${s} (${(ds.seasonCounts.get(s) || 0).toLocaleString()} races)` +
             (s === ds.autoSeason ? ' — default' : '')
    })));
    sel.value = String(ds.currentSeason);
  }

  function populateFacets() {
    const ds = state.dataset;
    if (!ds) return;
    const f = ds.facets;

    const ages = f.ageGroups.map(a => ({ value: String(a), label: a + ' years' }));
    ['squad-age', 'ev-age'].forEach(id => {
      const el = document.getElementById(id);
      if (el) U.fillSelect(el, ages, { placeholder: 'All ages', placeholderValue: 'all' });
    });

    const strokeEl = document.getElementById('res-stroke');
    if (strokeEl) U.fillSelect(strokeEl, f.strokes, { placeholder: 'All strokes', placeholderValue: 'all' });

    const distEl = document.getElementById('res-distance');
    if (distEl) {
      U.fillSelect(distEl, f.distances.map(d => ({ value: String(d), label: d + 'm' })),
        { placeholder: 'All', placeholderValue: 'all' });
    }

    const seasonEl = document.getElementById('res-season');
    if (seasonEl) {
      U.fillSelect(seasonEl, f.seasons.slice().reverse().map(s => ({ value: String(s), label: String(s) })),
        { placeholder: 'All seasons', placeholderValue: 'all' });
    }

    const swimmerNames = Array.from(ds.swimmers.keys()).sort((a, b) => a.localeCompare(b));
    const swEl = document.getElementById('sw-select');
    if (swEl) {
      const had = swEl.value;
      U.fillSelect(swEl, swimmerNames);
      // Land on the squad's strongest swimmer rather than whoever happens to
      // sort first alphabetically — opening on a swimmer with one recorded
      // race makes the whole tab look broken.
      if (!had || !ds.swimmers.has(had)) {
        let top = null;
        ds.swimmers.forEach(sw => {
          if (sw.bestPoints === null) return;
          if (!top || sw.bestPoints > top.bestPoints) top = sw;
        });
        if (top) swEl.value = top.name;
      }
    }

    const eventOptions = f.eventList.map(e => ({ value: e.eventKey, label: e.label }));
    const evEl = document.getElementById('ev-select');
    if (evEl) U.fillSelect(evEl, eventOptions);
  }

  /* ==========================================================================
     PANEL: SQUAD
     ========================================================================== */

  let squadTable = null;

  function wireSquad() {
    const search = document.getElementById('squad-search');
    search.addEventListener('input', U.debounce(renderSquadTable, 160));
    document.getElementById('squad-gender').addEventListener('change', renderSquadTable);
    document.getElementById('squad-age').addEventListener('change', renderSquadTable);
    document.getElementById('imp-limit').addEventListener('change', renderImprovement);
    document.getElementById('squad-export').addEventListener('click', exportSquad);
  }

  function renderSquad() {
    renderSquadStats();
    renderDistribution();
    renderImprovement();
    renderSquadTable();
  }

  function renderSquadStats() {
    const ds = state.dataset;
    const summary = D.squadSummary(ds);

    let scored = 0, totalPoints = 0, top = null;
    for (let i = 0; i < summary.length; i++) {
      const s = summary[i];
      if (s.bestPoints === null) continue;
      scored++; totalPoints += s.bestPoints;
      if (!top || s.bestPoints > top.bestPoints) top = s;
    }
    const avg = scored ? Math.round(totalPoints / scored) : null;

    let pbThisSeason = 0;
    ds.races.forEach(r => { if (r.isPB && r.season === ds.currentSeason) pbThisSeason++; });

    const stats = [
      { v: ds.swimmers.size, l: 'Swimmers' },
      { v: ds.races.length.toLocaleString(), l: 'Races' },
      { v: avg === null ? '—' : avg, l: 'Average best points', sub: scored + ' of ' + ds.swimmers.size + ' scored' },
      { v: top ? top.bestPoints : '—', l: 'Top points', sub: top ? top.name : '' },
      { v: pbThisSeason, l: 'PBs this season', sub: ds.currentSeason ? String(ds.currentSeason) : '' },
      { v: ds.facets.meetCount, l: 'Meets' }
    ];

    U.setHTML(document.getElementById('squad-stats'), stats.map(s =>
      `<div class="stat"><div class="v">${U.esc(s.v)}</div><div class="l">${U.esc(s.l)}</div>` +
      (s.sub ? `<div class="sub">${U.esc(s.sub)}</div>` : '') + '</div>'));
  }

  function renderDistribution() {
    C.pointsDistribution('chart-distribution', D.pointsDistribution(state.dataset, 50));
  }

  function renderImprovement() {
    const limit = parseInt(document.getElementById('imp-limit').value, 10) || 20;
    const rows = D.improvementLeaderboard(state.dataset);
    if (!rows.length) {
      C.destroy('chart-improvement');
      return;
    }
    C.improvementLeaderboard('chart-improvement', rows, { limit });
  }

  function squadColumns() {
    return [
      { key: 'name', label: 'Swimmer', width: 190,
        render: r => `<span class="name-cell">${U.esc(r.name)}</span>` },
      { key: 'club', label: 'Club', width: 150, render: r => `<span class="muted">${U.esc(r.club)}</span>` },
      { key: 'gender', label: '', width: 46, sortable: false,
        render: r => r.gender
          ? `<span class="badge badge-${r.gender.toLowerCase()}">${r.gender}</span>`
          : '<span class="badge badge-warn" title="No gender set — cannot be scored in points">?</span>' },
      { key: 'ageGroup', label: 'Age', width: 56, align: 'right',
        render: r => r.ageGroup === null ? '<span class="muted">—</span>' : U.esc(r.ageGroup) },
      { key: 'bestEvent', label: 'Strongest event', width: 168, sortable: true,
        sortValue: r => r.bestRace ? r.bestRace.eventKey : null,
        render: r => r.bestRace
          ? `${U.esc(r.bestRace.course)} ${r.bestRace.distance} ${U.esc(P.strokeShort(r.bestRace.stroke))}`
          : '<span class="muted">—</span>' },
      { key: 'bestTime', label: 'PB', width: 86, align: 'right',
        sortValue: r => r.bestRace ? r.bestRace.seconds : null,
        render: r => r.bestRace ? `<strong class="time">${U.esc(r.bestRace.time)}</strong>` : '—' },
      { key: 'seasonTime', label: 'Season best', width: 92, align: 'right',
        sortValue: r => r.seasonRace ? r.seasonRace.seconds : null,
        render: r => r.seasonRace
          ? `<span class="time">${U.esc(r.seasonRace.time)}</span>`
          : '<span class="muted">—</span>' },
      { key: 'formGapPct', label: 'Form', width: 80, align: 'right',
        render: r => {
          if (r.formGapPct === null) return '<span class="muted">—</span>';
          if (r.formGapPct <= 0.005) return '<span class="badge badge-sb">At PB</span>';
          const cls = r.formGapPct < 2 ? 'pos-good' : 'pos-bad';
          return `<span class="${cls} num">+${r.formGapPct.toFixed(1)}%</span>`;
        } },
      { key: 'bestPoints', label: 'Points', width: 72, align: 'right',
        render: r => r.bestPoints === null
          ? '<span class="muted">—</span>'
          : `<span class="points muted">${r.bestPoints}</span>` },
      { key: 'raceCount', label: 'Races', width: 62, align: 'right' },
      { key: 'lastDate', label: 'Last raced', width: 96,
        sortValue: r => r.lastDate ? r.lastDate.getTime() : null,
        render: r => r.lastDate ? `<span class="muted small">${D.isoDate(r.lastDate)}</span>` : '—' }
    ];
  }

  function renderSquadTable() {
    const container = document.getElementById('squad-table');
    if (!squadTable) {
      squadTable = U.VirtualTable(container, squadColumns(), {
        rowHeight: 34,
        // Sort by name, not by points. Opening the squad view on a points
        // league table makes the score feel like the subject; the roster is
        // the subject, and points are one sortable column among several.
        sortKey: 'name',
        sortAsc: true,
        onRowClick: row => openSwimmer(row.name)
      });
    }

    const q = document.getElementById('squad-search').value.trim().toLowerCase();
    const gender = document.getElementById('squad-gender').value;
    const age = document.getElementById('squad-age').value;

    const rows = D.squadSummary(state.dataset).filter(r => {
      if (gender !== 'all' && r.gender !== gender) return false;
      if (age !== 'all' && String(r.ageGroup) !== age) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 &&
          (r.club || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    const n = squadTable.setRows(rows);
    document.getElementById('squad-count').textContent =
      `${n} of ${state.dataset.swimmers.size} swimmers`;
  }

  function exportSquad() {
    const rows = squadTable ? squadTable.getRows() : D.squadSummary(state.dataset);
    const out = rows.map(r => ({
      name: r.name, club: r.club, gender: r.gender || '',
      age_group: r.ageGroup === null ? '' : r.ageGroup,
      best_points: r.bestPoints === null ? '' : r.bestPoints,
      best_event: r.bestRace ? `${r.bestRace.course} ${r.bestRace.distance} ${r.bestRace.stroke}` : '',
      best_time: r.bestRace ? r.bestRace.time : '',
      season_points: r.seasonPoints === null ? '' : r.seasonPoints,
      form_gap_pct: r.formGapPct === null ? '' : r.formGapPct.toFixed(2),
      races: r.raceCount,
      last_raced: r.lastDate ? D.isoDate(r.lastDate) : ''
    }));
    U.download('swimtracker-squad.csv', D.toCSV(out, Object.keys(out[0] || { name: '' })));
    U.toast('Squad table exported');
  }

  /* ==========================================================================
     PANEL: SWIMMER
     ========================================================================== */

  function wireSwimmer() {
    document.getElementById('sw-select').addEventListener('change', renderSwimmer);
    document.getElementById('sw-event').addEventListener('change', renderProgressionOnly);
    document.getElementById('sw-export').addEventListener('click', exportSwimmer);
  }

  function openSwimmer(name) {
    const sel = document.getElementById('sw-select');
    sel.value = name;
    selectPanel('swimmer');
  }

  function currentSwimmer() {
    const name = document.getElementById('sw-select').value;
    return state.dataset.swimmers.get(name) || null;
  }

  function renderSwimmer() {
    const sw = currentSwimmer();
    if (!sw) return;

    // The event list belongs to this swimmer, ordered by how strong they are
    // in each — the first entry is the one worth looking at first.
    const evs = Array.from(sw.events.values()).sort((a, b) => {
      const ap = a.pb && a.pb.points !== null ? a.pb.points : -1;
      const bp = b.pb && b.pb.points !== null ? b.pb.points : -1;
      if (bp !== ap) return bp - ap;
      return b.races.length - a.races.length;
    });
    const evSel = document.getElementById('sw-event');
    const previous = evSel.value;
    U.fillSelect(evSel, evs.map(e => ({
      value: e.eventKey,
      label: `${e.course} ${e.distance}m ${e.stroke} (${e.races.length} race${e.races.length === 1 ? '' : 's'})`
    })));
    if (previous && sw.events.has(previous)) evSel.value = previous;

    renderSwimmerStats(sw);
    renderProgressionOnly();
    C.formGap('chart-formgap', sw, { seasonLabel: state.dataset.currentSeason });
    C.eventPortfolio('chart-portfolio', sw);
    C.consistency('chart-consistency', sw);
    renderSwimmerEvents(sw, evs);
  }

  function renderProgressionOnly() {
    const sw = currentSwimmer();
    if (!sw) return;
    const key = document.getElementById('sw-event').value;
    if (!key) { C.destroy('chart-progression'); return; }
    C.pbProgression('chart-progression', sw, key);
  }

  function renderSwimmerStats(sw) {
    let seasonPBs = 0;
    sw.races.forEach(r => { if (r.isPB && r.season === state.dataset.currentSeason) seasonPBs++; });

    const stats = [
      { v: sw.bestPointsRace ? sw.bestPointsRace.time : '—', l: 'Best swim',
        sub: sw.bestPointsRace
          ? `${sw.bestPointsRace.course} ${sw.bestPointsRace.distance} ${P.strokeShort(sw.bestPointsRace.stroke)}`
          : '' },
      { v: seasonPBs, l: 'PBs this season' },
      { v: sw.raceCount, l: 'Races' },
      { v: sw.eventCount, l: 'Events' },
      { v: sw.bestPoints === null ? '—' : sw.bestPoints, l: 'Points',
        sub: sw.bestPoints === null ? 'needs a gender' : 'for that swim' },
      { v: sw.ageGroup === null ? '—' : sw.ageGroup, l: 'Age group' },
      { v: sw.club || '—', l: 'Club' }
    ];
    U.setHTML(document.getElementById('sw-stats'), stats.map(s =>
      `<div class="stat"><div class="v" style="font-size:${String(s.v).length > 8 ? '1rem' : '1.5rem'}">${U.esc(s.v)}</div>` +
      `<div class="l">${U.esc(s.l)}</div>` + (s.sub ? `<div class="sub">${U.esc(s.sub)}</div>` : '') + '</div>'));
  }

  function renderSwimmerEvents(sw, evs) {
    const parts = evs.map(ev => {
      const gap = ev.sbToPbGapSec;
      const gapCell = ev.seasonBest === null || gap === null
        ? '<span class="muted">—</span>'
        : (gap <= 0.0001
            ? '<span class="badge badge-sb">At PB</span>'
            : `<span class="${ev.sbToPbGapPct < 2 ? 'pos-good' : 'pos-bad'}">+${gap.toFixed(2)}s</span>`);
      return '<tr>' +
        `<td><span class="badge badge-${ev.course.toLowerCase()}">${ev.course}</span> ${ev.distance}m ${U.esc(ev.stroke)}</td>` +
        `<td class="num time"><strong>${U.esc(ev.pb.time)}</strong></td>` +
        `<td class="num points">${ev.pb.points === null ? '<span class="muted">—</span>' : ev.pb.points}</td>` +
        `<td class="small muted">${U.esc(ev.pb.dateISO)}</td>` +
        `<td class="num time">${ev.seasonBest ? U.esc(ev.seasonBest.time) : '<span class="muted">—</span>'}</td>` +
        `<td class="num">${gapCell}</td>` +
        `<td class="num">${ev.races.length}</td>` +
        `<td class="num">${ev.improvementPct === null || ev.improvementPct === 0
          ? '<span class="muted">—</span>'
          : `<span class="pos-good">${ev.improvementPct.toFixed(1)}%</span>`}</td>` +
        '</tr>';
    });
    U.setHTML(document.getElementById('sw-events-body'), parts);
    document.getElementById('sw-events-count').textContent = `${evs.length} events`;
  }

  function exportSwimmer() {
    const sw = currentSwimmer();
    if (!sw) return;
    const out = sw.races.map(r => ({
      name: r.name, club: r.club, gender: r.gender || '',
      course: r.course, distance: r.distance, stroke: r.stroke,
      time: r.time, points: r.points === null ? '' : r.points,
      race_date: r.dateISO, age_grp: r.ageGroup === null ? '' : r.ageGroup,
      race_name: r.meet, is_pb: r.isPB ? 'Y' : ''
    }));
    U.download(`swimtracker-${sw.name.replace(/[^\w-]+/g, '_')}.csv`,
      D.toCSV(out, Object.keys(out[0])));
    U.toast(`Exported ${sw.name}`);
  }

  /* ==========================================================================
     PANEL: EVENTS
     ========================================================================== */

  let eventMetric = 'seconds';

  function wireEvents() {
    document.getElementById('ev-select').addEventListener('change', renderEvents);
    document.getElementById('ev-gender').addEventListener('change', renderEvents);
    document.getElementById('ev-age').addEventListener('change', renderEvents);
    document.getElementById('ev-export').addEventListener('click', exportRankings);

    document.getElementById('ev-metric').addEventListener('click', e => {
      const btn = e.target.closest('[data-metric]');
      if (!btn) return;
      eventMetric = btn.getAttribute('data-metric');
      U.$$('#ev-metric button').forEach(b =>
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      renderEvents();
    });

    document.getElementById('cmp-metric').addEventListener('change', renderComparison);
    document.getElementById('cmp-search').addEventListener('input', U.debounce(renderComparisonPicker, 160));
  }

  function currentRankings() {
    const key = document.getElementById('ev-select').value;
    if (!key) return { key: null, rows: [] };
    return {
      key,
      rows: D.eventRankings(state.dataset, key, {
        gender: document.getElementById('ev-gender').value,
        ageGroup: document.getElementById('ev-age').value
      })
    };
  }

  function renderEvents() {
    const { key, rows } = currentRankings();
    const ev = key ? state.dataset.events.get(key) : null;

    document.getElementById('ev-title').textContent =
      ev ? `${ev.label} — rankings` : 'Event rankings';
    document.getElementById('ev-count').textContent =
      `${rows.length} swimmer${rows.length === 1 ? '' : 's'}`;

    if (!rows.length) {
      C.destroy('chart-ranking');
      U.setHTML(document.getElementById('ev-body'),
        '<tr><td colspan="9" class="empty">No swimmer in this filter has raced this event.</td></tr>');
    } else {
      C.eventRanking('chart-ranking', rows, { metric: eventMetric, limit: 30 });
      const leader = rows[0].seconds;
      U.setHTML(document.getElementById('ev-body'), rows.map((r, i) => {
        const behind = i === 0 ? '' : `+${(r.seconds - leader).toFixed(2)}`;
        return '<tr' + (i === 0 ? ' class="is-pb"' : '') + '>' +
          `<td class="num"><strong>${i + 1}</strong></td>` +
          `<td class="name-cell">${U.esc(r.name)}</td>` +
          `<td class="muted small">${U.esc(r.club)}</td>` +
          `<td>${r.gender ? `<span class="badge badge-${r.gender.toLowerCase()}">${r.gender}</span>` : ''}</td>` +
          `<td class="num time"><strong>${U.esc(r.race.time)}</strong></td>` +
          `<td class="num points">${r.points === null ? '<span class="muted">—</span>' : r.points}</td>` +
          `<td class="small muted">${U.esc(r.race.dateISO)}</td>` +
          `<td class="num muted">${behind}</td>` +
          `<td class="num">${r.count}</td>` +
          '</tr>';
      }));
    }

    renderComparisonPicker();
    renderComparison();
  }

  function exportRankings() {
    const { key, rows } = currentRankings();
    if (!rows.length) { U.toast('Nothing to export'); return; }
    const ev = state.dataset.events.get(key);
    const out = rows.map((r, i) => ({
      rank: i + 1, name: r.name, club: r.club, gender: r.gender || '',
      event: ev ? ev.label : '', pb: r.race.time,
      points: r.points === null ? '' : r.points,
      date: r.race.dateISO, meet: r.race.meet, races: r.count
    }));
    U.download('swimtracker-rankings.csv', D.toCSV(out, Object.keys(out[0])));
    U.toast('Rankings exported');
  }

  const COMPARISON_CAP = 8;

  function renderComparisonPicker() {
    const ds = state.dataset;
    const key = document.getElementById('ev-select').value;
    const q = document.getElementById('cmp-search').value.trim().toLowerCase();

    // Only offer swimmers who have actually raced the selected event —
    // adding someone with no data just draws an empty line.
    const candidates = [];
    ds.swimmers.forEach(sw => {
      const ev = key ? sw.events.get(key) : null;
      if (key && !ev) return;
      if (q && sw.name.toLowerCase().indexOf(q) === -1) return;
      candidates.push({ sw, points: ev && ev.pb ? ev.pb.points : sw.bestPoints });
    });
    candidates.sort((a, b) => (b.points || -1) - (a.points || -1));

    U.setHTML(document.getElementById('cmp-list'), candidates.slice(0, 200).map(c => {
      const on = state.comparison.indexOf(c.sw.name) !== -1;
      const full = !on && state.comparison.length >= COMPARISON_CAP;
      return `<label class="picker-opt ${on ? 'on' : ''}">` +
        `<input type="checkbox" data-name="${U.esc(c.sw.name)}"${on ? ' checked' : ''}${full ? ' disabled' : ''}>` +
        `<span>${U.esc(c.sw.name)}</span>` +
        `<span class="pts">${c.points === null || c.points === undefined ? '—' : c.points + ' pts'}</span>` +
        '</label>';
    }));

    U.setHTML(document.getElementById('cmp-chips'), state.comparison.map((n, i) =>
      `<span class="chip"><span class="dot" style="background:${U.colorFor(i)}"></span>${U.esc(n)}` +
      `<button type="button" data-remove="${U.esc(n)}" aria-label="Remove ${U.esc(n)}">×</button></span>`));

    if (state.comparison.length >= COMPARISON_CAP) {
      document.getElementById('cmp-chips').insertAdjacentHTML('beforeend',
        `<span class="small muted" style="align-self:center">Maximum ${COMPARISON_CAP} — remove one to add another.</span>`);
    }
  }

  function wireComparisonDelegates() {
    document.getElementById('cmp-list').addEventListener('change', e => {
      const cb = e.target.closest('input[data-name]');
      if (!cb) return;
      const name = cb.getAttribute('data-name');
      const i = state.comparison.indexOf(name);
      if (cb.checked && i === -1) {
        if (state.comparison.length >= COMPARISON_CAP) {
          cb.checked = false;
          U.toast(`Maximum ${COMPARISON_CAP} swimmers on one chart`);
          return;
        }
        state.comparison.push(name);
      } else if (!cb.checked && i !== -1) {
        state.comparison.splice(i, 1);
      }
      renderComparisonPicker();
      renderComparison();
    });

    document.getElementById('cmp-chips').addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      const i = state.comparison.indexOf(btn.getAttribute('data-remove'));
      if (i !== -1) state.comparison.splice(i, 1);
      renderComparisonPicker();
      renderComparison();
    });
  }

  function renderComparison() {
    const key = document.getElementById('ev-select').value;
    const metric = document.getElementById('cmp-metric').value;
    const swimmers = state.comparison
      .map(n => state.dataset.swimmers.get(n))
      .filter(Boolean);
    if (!swimmers.length || !key) { C.destroy('chart-comparison'); return; }
    C.seasonComparison('chart-comparison', swimmers, {
      eventKey: key, metric, limit: COMPARISON_CAP
    });
  }

  /* ==========================================================================
     PANEL: COVERAGE
     ========================================================================== */

  function wireCoverage() {
    document.getElementById('cov-course').addEventListener('change', renderCoverage);
    document.getElementById('cov-gender').addEventListener('change', renderCoverage);
    document.getElementById('cov-search').addEventListener('input', U.debounce(renderCoverage, 160));
  }

  function renderCoverage() {
    const course = document.getElementById('cov-course').value;
    const gender = document.getElementById('cov-gender').value;
    const q = document.getElementById('cov-search').value.trim().toLowerCase();

    const matrix = D.coverageMatrix(state.dataset, { course, gender });
    const rows = q
      ? matrix.rows.filter(r => r.swimmer.name.toLowerCase().indexOf(q) !== -1)
      : matrix.rows;

    const table = document.getElementById('cov-table');
    document.getElementById('cov-count').textContent =
      `${rows.length} swimmers × ${matrix.events.length} events`;

    if (!matrix.events.length || !rows.length) {
      U.setHTML(table, '<tbody><tr><td class="empty">No ' +
        U.esc(course === 'LC' ? 'long course' : 'short course') +
        ' results for this filter.</td></tr></tbody>');
      U.setHTML(document.getElementById('cov-legend'), '');
      return;
    }

    // Scale the colour ramp to the range actually present, so a developing
    // squad still gets a full spread of shading rather than one flat block.
    let min = Infinity, max = -Infinity;
    rows.forEach(r => r.cells.forEach(c => {
      if (!c || c.points === null) return;   // unscored cells still render, just uncoloured
      if (c.points < min) min = c.points;
      if (c.points > max) max = c.points;
    }));
    if (!Number.isFinite(min)) { min = 0; max = 1000; }
    if (min === max) { min = Math.max(0, min - 50); max = max + 50; }

    const parts = ['<thead><tr><th class="corner">Swimmer</th>'];
    matrix.events.forEach(e => {
      parts.push(`<th title="${U.esc(P.eventLabel(e.course, e.distance, e.stroke))}">` +
        `${e.distance}<br>${U.esc(P.strokeShort(e.stroke))}</th>`);
    });
    parts.push('</tr></thead><tbody>');

    // A 150 x 20 grid is 3,000 cells, built as one string and written once.
    // The search box narrows it further when a coach wants a closer look.
    rows.forEach(r => {
      parts.push('<tr>');
      parts.push(`<td class="rowhead" title="${U.esc(r.swimmer.name)}">${U.esc(r.swimmer.name)}</td>`);
      r.cells.forEach((c, i) => {
        if (!c) {
          parts.push('<td class="cell empty" title="Never raced">·</td>');
        } else {
          const e = matrix.events[i];
          // The CELL SHOWS THE TIME, not the points. Every column here is a
          // single event, so times down a column are directly comparable —
          // there is no need to abstract them into points to read the grid.
          // Colour still encodes points, which is what makes strength
          // comparable ACROSS columns; and a swimmer with no gender (so no
          // points) still gets their times shown rather than a blank row.
          const label = U.esc(c.race.time);
          if (c.points === null) {
            parts.push(`<td class="cell unscored" ` +
              `title="${U.esc(r.swimmer.name)} — ${U.esc(P.eventLabel(e.course, e.distance, e.stroke))}: ` +
              `${label} (no gender set, so not scored)">${label}</td>`);
          } else {
            const bg = U.heatColor(c.points, min, max);
            const fg = U.heatTextColor(c.points, min, max);
            parts.push(`<td class="cell" style="background:${bg};color:${fg}" ` +
              `title="${U.esc(r.swimmer.name)} — ${U.esc(P.eventLabel(e.course, e.distance, e.stroke))}: ` +
              `${label} (${c.points} pts)">${label}</td>`);
          }
        }
      });
      parts.push('</tr>');
    });
    parts.push('</tbody>');

    U.setHTML(table, parts);

    const swatches = [];
    for (let i = 0; i < 6; i++) {
      swatches.push(`<span class="sw" style="background:${U.heatColor(min + (max - min) * (i / 5), min, max)}"></span>`);
    }
    U.setHTML(document.getElementById('cov-legend'), swatches);
  }

  /* ==========================================================================
     PANEL: RESULTS
     ========================================================================== */

  let resultsTable = null;

  function wireResults() {
    const rerender = U.debounce(renderResults, 160);
    document.getElementById('res-search').addEventListener('input', rerender);
    ['res-stroke', 'res-distance', 'res-course', 'res-gender', 'res-season', 'res-show']
      .forEach(id => document.getElementById(id).addEventListener('change', renderResults));
    document.getElementById('res-export').addEventListener('click', exportResults);
  }

  function resultsColumns() {
    return [
      { key: 'name', label: 'Swimmer', width: 175,
        render: r => `<span class="name-cell">${U.esc(r.name)}</span>` },
      { key: 'dateISO', label: 'Date', width: 96,
        sortValue: r => (r.date ? r.date.getTime() : null),
        render: r => `<span class="muted">${U.esc(r.dateISO)}</span>` },
      { key: 'course', label: 'Course', width: 78, sortable: false,
        render: r => `<span class="badge badge-${r.course.toLowerCase()}">${r.course}</span>` },
      { key: 'distance', label: 'Dist', width: 58, align: 'right',
        render: r => `${r.distance}m` },
      { key: 'stroke', label: 'Stroke', width: 108 },
      { key: 'seconds', label: 'Time', width: 82, align: 'right',
        render: r => `<strong class="time">${U.esc(r.time)}</strong>` },
      { key: 'points', label: 'Points', width: 78, align: 'right',
        render: r => r.points === null ? '<span class="muted">—</span>' : `<span class="points">${r.points}</span>` },
      { key: 'ageGroup', label: 'Age', width: 58, align: 'right',
        render: r => r.ageGroup === null ? '<span class="muted">—</span>' : r.ageGroup },
      { key: 'meet', label: 'Meet', width: 300,
        render: r => `<span class="muted small">${U.esc(r.meet)}</span>` },
      { key: 'isPB', label: 'PB', width: 50, sortable: true,
        sortValue: r => (r.isPB ? 1 : 0),
        render: r => r.isPB ? '<span class="badge badge-pb">PB</span>' : '' }
    ];
  }

  function filteredRaces() {
    const q = document.getElementById('res-search').value.trim().toLowerCase();
    const stroke = document.getElementById('res-stroke').value;
    const distance = document.getElementById('res-distance').value;
    const course = document.getElementById('res-course').value;
    const gender = document.getElementById('res-gender').value;
    const season = document.getElementById('res-season').value;
    const show = document.getElementById('res-show').value;

    const races = state.dataset.races;
    const out = [];
    for (let i = 0; i < races.length; i++) {
      const r = races[i];
      if (stroke !== 'all' && r.stroke !== stroke) continue;
      if (distance !== 'all' && String(r.distance) !== distance) continue;
      if (course !== 'all' && r.course !== course) continue;
      if (gender !== 'all' && r.gender !== gender) continue;
      if (season !== 'all' && String(r.season) !== season) continue;
      if (show === 'pb' && !r.isPB) continue;
      if (q) {
        const hay = r.name.toLowerCase() + ' ' + (r.meet || '').toLowerCase() + ' ' + (r.club || '').toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      out.push(r);
    }
    return out;
  }

  function renderResults() {
    const container = document.getElementById('res-table');
    if (!resultsTable) {
      resultsTable = U.VirtualTable(container, resultsColumns(), {
        rowHeight: 33,
        sortKey: 'dateISO',
        sortAsc: false,
        rowClass: r => (r.isPB ? 'is-pb' : '')
      });
    }
    const rows = filteredRaces();
    resultsTable.setRows(rows);
    document.getElementById('res-count').textContent =
      `${rows.length.toLocaleString()} of ${state.dataset.races.length.toLocaleString()} races`;
  }

  function exportResults() {
    const rows = resultsTable ? resultsTable.getRows() : [];
    if (!rows.length) { U.toast('Nothing to export'); return; }
    const out = rows.map(r => ({
      name: r.name, club: r.club, gender: r.gender || '',
      course: r.course, distance: r.distance, stroke: r.stroke,
      time: r.time, points: r.points === null ? '' : r.points,
      race_date: r.dateISO, age_grp: r.ageGroup === null ? '' : r.ageGroup,
      race_name: r.meet, is_pb: r.isPB ? 'Y' : ''
    }));
    U.download('swimtracker-results.csv', D.toCSV(out, Object.keys(out[0])));
    U.toast(`${rows.length.toLocaleString()} races exported`);
  }

  /* ==========================================================================
     ROSTER / STORAGE / EXPORT
     ========================================================================== */

  function renderRoster() {
    const card = document.getElementById('roster-card');
    if (!state.dataset) { card.hidden = true; return; }

    const missing = [];
    state.dataset.swimmers.forEach(sw => { if (!sw.gender) missing.push(sw); });
    card.hidden = missing.length === 0;
    if (!missing.length) return;

    missing.sort((a, b) => b.raceCount - a.raceCount);
    U.setHTML(document.getElementById('roster-body'), missing.map(sw =>
      '<tr>' +
      `<td class="name-cell">${U.esc(sw.name)}</td>` +
      `<td class="muted">${U.esc(sw.club)}</td>` +
      `<td class="num">${sw.raceCount}</td>` +
      `<td><select data-roster="${U.esc(sw.name)}">` +
        '<option value="">Not set</option>' +
        '<option value="F">Female</option>' +
        '<option value="M">Male</option>' +
      '</select></td></tr>'));
  }

  async function applyRoster() {
    let changed = 0;
    U.$$('#roster-body select[data-roster]').forEach(sel => {
      const name = sel.getAttribute('data-roster');
      const v = P.normalizeGender(sel.value);
      if (v) { state.genderOverrides[name] = v; changed++; }
    });
    if (!changed) { U.toast('No genders were set'); return; }

    await S.set(KEY_GENDERS, state.genderOverrides);
    rebuild();
    state.rawRows = datasetToRawRows(state.dataset);
    await persistRows();
    U.toast(`${changed} swimmer${changed === 1 ? '' : 's'} updated and scored`);
    renderRoster();
  }

  function renderStorageStatus() {
    const node = document.getElementById('storage-status');
    if (!node) return;
    const st = S.status();
    const rows = state.dataset ? state.dataset.races.length : 0;

    if (st.lastError) {
      U.setHTML(node, `<div class="notice notice-error"><div><strong>Your data is not being saved</strong>${U.esc(st.lastError)}</div></div>`);
      return;
    }

    // Before anything is loaded there is nothing to warn about. Telling a
    // coach their zero races are "in memory only and will be lost" on first
    // run is alarming and meaningless — storage is only actually chosen when
    // something is written to it.
    if (!rows) {
      U.setHTML(node,
        '<div class="notice notice-info"><div><strong>No results loaded yet</strong>' +
        'Import a CSV above. It is saved in this browser so it will still be here next time, ' +
        'and nothing is uploaded anywhere.</div></div>');
      return;
    }

    const where = st.mode === 'idb' ? 'this browser’s local database'
      : st.mode === 'local' ? 'this browser’s local storage'
      : 'memory only — it will be lost when you close the tab';
    const cls = st.mode === 'memory' ? 'notice-warn' : 'notice-info';
    U.setHTML(node,
      `<div class="notice ${cls}"><div><strong>${rows.toLocaleString()} races stored in ${U.esc(where)}</strong>` +
      'Nothing is uploaded anywhere. Clearing your browser data removes it, so export a CSV if you want a backup.</div></div>');
  }

  function exportAll() {
    if (!state.rawRows.length) { U.toast('No data to export'); return; }
    U.download('swimmer_results.csv', D.toCSV(state.rawRows, IMPORT_COLUMNS));
    U.toast('All data exported');
  }

  async function clearAll() {
    if (!confirm('Delete all stored results from this browser?\n\nThis cannot be undone. Export a CSV first if you want a backup.')) return;
    state.rawRows = [];
    state.genderOverrides = {};
    state.comparison = [];
    await S.clear();
    C.destroyAll();
    squadTable = null;
    resultsTable = null;
    document.getElementById('squad-table').innerHTML = '';
    document.getElementById('res-table').innerHTML = '';
    rebuild({ silent: true });
    selectPanel('data');
    showImportReport([{ kind: 'info', title: 'All data deleted', body: 'Import a CSV to start again.' }]);
    U.toast('All data deleted');
  }

  /* ==========================================================================
     START
     ========================================================================== */

  function start() {
    // A missing chart library must not take the whole app down — tables and
    // exports still work, and the coach is told what is wrong.
    if (typeof Chart === 'undefined') {
      const n = document.getElementById('import-report');
      if (n) {
        U.setHTML(n, '<div class="notice notice-warn"><div><strong>Charts are unavailable</strong>' +
          'assets/vendor/chart.umd.js did not load, so tables will work but charts will be blank.</div></div>');
      }
    }
    wireComparisonDelegates();
    boot().catch(err => {
      console.error(err);
      U.toast('Something went wrong starting up — see the browser console.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Exposed for the end-to-end tests only.
  window.__swimtracker = { state, rebuild, selectPanel };
})();
