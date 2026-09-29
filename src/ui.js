/* ============================================================================
   SwimTracker — UI toolkit
   ============================================================================

   Two things in here carry most of the weight.

   1. `esc()` — every value that reaches the DOM as HTML goes through it.
      The old build interpolated swimmer names straight into markup, including
      into an inline `onclick="toggleSwimmer('NAME')"` attribute. A perfectly
      ordinary name like O'Brien broke the handler, and a name containing a
      quote or an angle bracket could inject markup. Names come from a
      third-party website, so they are untrusted input.

   2. `VirtualTable` — renders only the rows that are actually on screen.
      A 150-swimmer squad produces tens of thousands of results. Building that
      many <tr> elements (worse: with `tbody.innerHTML +=` per row, which
      re-parses the entire table on every iteration — quadratic work) is what
      froze and then killed the old Results tab. Here the DOM holds ~40 rows
      no matter how large the dataset is.
============================================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** Escape a value for safe interpolation into HTML. */
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, c => ESC[c]);
  }

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c === null || c === undefined) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  /**
   * Replace a container's contents in one write.
   *
   * Every `innerHTML +=` in a loop is O(n^2): the browser serialises and
   * re-parses everything already there on each pass. Building the string
   * first and assigning once is the whole fix.
   */
  function setHTML(node, htmlParts) {
    node.innerHTML = Array.isArray(htmlParts) ? htmlParts.join('') : htmlParts;
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms === undefined ? 150 : ms);
    };
  }

  /** Run work after the browser has had a chance to paint a loading state. */
  function nextFrame() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
      else setTimeout(resolve, 0);
    });
  }

  let toastTimer = null;
  function toast(message, ms) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), ms || 2600);
  }

  function busy(on, label) {
    const node = document.getElementById('busy');
    if (!node) return;
    if (label) {
      const l = node.querySelector('.busy-label');
      if (l) l.textContent = label;
    }
    node.hidden = !on;
  }

  /** Trigger a client-side file download. No server involved. */
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** Fill a <select> in one write, preserving the current value if still valid. */
  function fillSelect(select, options, opts) {
    const settings = opts || {};
    const previous = select.value;
    const parts = [];
    if (settings.placeholder) {
      parts.push(`<option value="${esc(settings.placeholderValue || 'all')}">${esc(settings.placeholder)}</option>`);
    }
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const value = typeof o === 'object' ? o.value : o;
      const label = typeof o === 'object' ? o.label : o;
      parts.push(`<option value="${esc(value)}">${esc(label)}</option>`);
    }
    select.innerHTML = parts.join('');
    if (previous && Array.prototype.some.call(select.options, o => o.value === previous)) {
      select.value = previous;
    }
  }

  /* ==========================================================================
     VIRTUAL TABLE
     ========================================================================== */

  /**
   * A windowed list with a sticky, sortable header.
   *
   * @param {HTMLElement} container  Element to take over.
   * @param {Array} columns          [{ key, label, width, align, sortable, render }]
   * @param {Object} opts            { rowHeight, overscan, onRowClick, rowClass }
   */
  function VirtualTable(container, columns, opts) {
    const settings = opts || {};
    const rowHeight = settings.rowHeight || 33;
    const overscan = settings.overscan || 8;

    let rows = [];
    let sortKey = settings.sortKey || null;
    let sortAsc = settings.sortAsc !== undefined ? settings.sortAsc : true;
    let scrollRaf = null;

    // The header lives INSIDE the scroller and is sticky only vertically, so
    // it scrolls sideways in lockstep with the rows. A header outside the
    // scroller drifts out of alignment the moment the table is wider than the
    // viewport — which, with ten columns, it usually is on a laptop.
    container.classList.add('vtable');
    container.innerHTML =
      '<div class="vscroll">' +
        '<div class="vhead" role="row"></div>' +
        '<div class="vscroll-sizer"><div class="vscroll-window"></div></div>' +
      '</div>';

    const head = container.querySelector('.vhead');
    const scroller = container.querySelector('.vscroll');
    const sizer = container.querySelector('.vscroll-sizer');
    const win = container.querySelector('.vscroll-window');

    function widthStyle(c) {
      // Fixed-width columns keep the header aligned with the body without a
      // real <table>, which is what makes windowing possible at all.
      return `width:${c.width || 120}px;${c.align === 'right' ? 'text-align:right;' : ''}`;
    }

    // Total column width, so the header and the windowed rows scroll together
    // horizontally instead of the header drifting out of alignment.
    const totalWidth = columns.reduce((sum, c) => sum + (c.width || 120), 0) + 8;
    head.style.minWidth = totalWidth + 'px';
    sizer.style.minWidth = totalWidth + 'px';

    function renderHead() {
      head.innerHTML = columns.map(c => {
        const sortable = c.sortable !== false;
        const active = sortKey === c.key;
        const arrow = sortable ? `<span class="arrow">${active ? (sortAsc ? '▲' : '▼') : '↕'}</span>` : '';
        return `<span class="${sortable ? 'sortable' : ''}" style="${widthStyle(c)}"` +
               (sortable ? ` data-key="${esc(c.key)}" role="columnheader" tabindex="0"` : '') +
               (active ? ` aria-sort="${sortAsc ? 'ascending' : 'descending'}"` : '') +
               `>${esc(c.label)}${arrow}</span>`;
      }).join('');
    }

    function onSort(key) {
      if (!key) return;
      if (sortKey === key) sortAsc = !sortAsc;
      else { sortKey = key; sortAsc = true; }
      applySort();
      renderHead();
      scroller.scrollTop = 0;
      renderWindow();
    }

    head.addEventListener('click', e => {
      const t = e.target.closest('[data-key]');
      if (t) onSort(t.getAttribute('data-key'));
    });
    head.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target.closest('[data-key]');
      if (t) { e.preventDefault(); onSort(t.getAttribute('data-key')); }
    });

    function applySort() {
      if (!sortKey) return;
      const col = columns.find(c => c.key === sortKey);
      if (!col) return;
      const valueOf = col.sortValue || (r => r[sortKey]);
      const dir = sortAsc ? 1 : -1;
      rows.sort((a, b) => {
        const av = valueOf(a), bv = valueOf(b);
        // Missing values always sort last, whichever direction is active —
        // an empty cell floating to the top of a rankings table is noise.
        const an = av === null || av === undefined || av === '';
        const bn = bv === null || bv === undefined || bv === '';
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
      });
    }

    function renderWindow() {
      const total = rows.length;
      sizer.style.height = (total * rowHeight) + 'px';

      const viewport = scroller.clientHeight || 400;
      const first = Math.max(0, Math.floor(scroller.scrollTop / rowHeight) - overscan);
      const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
      const last = Math.min(total, first + visible);

      const parts = [];
      for (let i = first; i < last; i++) {
        const r = rows[i];
        const cls = settings.rowClass ? settings.rowClass(r, i) : '';
        parts.push(`<div class="vrow ${cls}" style="height:${rowHeight}px" data-index="${i}" role="row">`);
        for (let c = 0; c < columns.length; c++) {
          const col = columns[c];
          const content = col.render ? col.render(r, i) : esc(r[col.key]);
          parts.push(`<span style="${widthStyle(col)}" role="cell">${content}</span>`);
        }
        parts.push('</div>');
      }
      win.style.transform = `translateY(${first * rowHeight}px)`;
      win.innerHTML = parts.join('');
    }

    // Coalesce scroll events to one render per animation frame. Without this
    // a fast flick queues dozens of renders and the list visibly tears.
    scroller.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = null; renderWindow(); });
    }, { passive: true });

    if (settings.onRowClick) {
      win.addEventListener('click', e => {
        const r = e.target.closest('.vrow');
        if (!r) return;
        const i = parseInt(r.getAttribute('data-index'), 10);
        if (rows[i]) settings.onRowClick(rows[i], i);
      });
    }

    // Re-window on resize: the viewport height changes how many rows we need.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => renderWindow()).observe(scroller);
    } else {
      window.addEventListener('resize', debounce(renderWindow, 120));
    }

    renderHead();

    return {
      setRows(next) {
        rows = next || [];
        applySort();
        scroller.scrollTop = 0;
        renderWindow();
        return rows.length;
      },
      getRows() { return rows; },
      setSort(key, asc) { sortKey = key; sortAsc = !!asc; applySort(); renderHead(); renderWindow(); },
      refresh: renderWindow,
      count() { return rows.length; }
    };
  }

  /* ==========================================================================
     COLOUR
     ========================================================================== */

  /**
   * Series colours. Ten hand-picked hues that stay distinguishable side by
   * side; beyond that we generate evenly-spaced hues rather than silently
   * repeating, which is what made two different swimmers share a line colour
   * in the old charts.
   */
  const PALETTE = [
    '#2f7ba8', '#b5762a', '#276848', '#a8475c', '#7565b5',
    '#2d8f9e', '#8f5c1f', '#5f8a3f', '#9a4a86', '#41618f'
  ];

  /**
   * THEME — the single source of truth for every colour a chart draws.
   *
   * These values mirror the CSS custom properties in assets/app.css. They are
   * duplicated rather than read from getComputedStyle so that charts render
   * identically under Node (the unit tests import this module with no DOM) and
   * so a missing stylesheet degrades to a readable chart instead of a blank
   * one. Change a colour in both places, or the charts drift from the page.
   *
   * Anything named *Soft* or *Fill* is a translucent area fill and must never
   * carry text — only the solid values clear contrast requirements.
   */
  const THEME = {
    accent:     '#2f7ba8',
    accentSoft: 'rgba(47,123,168,.62)',
    accentFill: 'rgba(47,123,168,.50)',
    warm:       '#b5762a',
    warmSoft:   'rgba(181,118,42,.62)',
    warmDeep:   '#8f5c1f',
    green:      '#276848',
    greenSoft:  'rgba(39,104,72,.72)',
    red:        '#b0384a',
    redSoft:    'rgba(176,56,74,.68)',
    deep:       '#41618f',
    white:      '#ffffff',
    /* Grid lines are tinted with the page blue: a neutral grey grid reads as a
       smudge once the surface behind it is no longer neutral. */
    gridFaint:  'rgba(65,97,143,.07)',
    grid:       'rgba(65,97,143,.11)',
    gridStrong: 'rgba(65,97,143,.15)',
    tooltipBg:  'rgba(22,33,47,.94)'
  };

  /** One hue per stroke, held here so the page and the charts agree. */
  const STROKE_COLORS = {
    Freestyle: THEME.accent, Backstroke: '#7565b5',
    Breaststroke: THEME.green, Butterfly: THEME.warm, Medley: THEME.red
  };

  function colorFor(i) {
    if (i < PALETTE.length) return PALETTE[i];
    const hue = (i * 137.508) % 360;          // golden-angle spacing
    const light = 38 + ((i % 3) * 9);
    return `hsl(${hue.toFixed(0)} 62% ${light}%)`;
  }

  /**
   * Heatmap colour for a points value.
   * A single hue ramp (pale -> deep blue) rather than red-to-green: it reads
   * correctly for the ~8% of men with red/green colour blindness, and keeps
   * the ordering obvious in greyscale when a coach prints the page.
   */
  function heatColor(points, min, max) {
    if (points === null || points === undefined) return null;
    const span = Math.max(1, max - min);
    const t = Math.max(0, Math.min(1, (points - min) / span));
    const light = 96 - t * 54;      // 96% -> 42%
    const sat = 34 + t * 40;
    return `hsl(205 ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
  }

  /** Black or white text, whichever stays readable on the given lightness. */
  function heatTextColor(points, min, max) {
    if (points === null || points === undefined) return 'inherit';
    const span = Math.max(1, max - min);
    const t = Math.max(0, Math.min(1, (points - min) / span));
    return (96 - t * 54) < 62 ? '#ffffff' : '#16212f';
  }

  return {
    esc, $, $$, el, setHTML, debounce, nextFrame, toast, busy, download,
    fillSelect, VirtualTable, PALETTE, THEME, STROKE_COLORS,
    colorFor, heatColor, heatTextColor
  };
});
