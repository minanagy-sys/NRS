/* ============================================================
   The helpers the eight Contact Centre panels share.

   Same reasoning as tg-fmt.js: these were declared at the top of one 536-line
   page file, and the eight panels that replace it would otherwise carry eight
   copies. `fmt(null)` returning an em dash rather than "0" is a decision — a
   missing figure and a figure of zero are different claims — and decisions
   drift quietly when they live in eight places.

   WHAT IS HERE AND NOT IN tg-fmt.js: `table()`, `windowBanner()` and
   `refusal()`. The first is the sortable table every panel builds; the other
   two are this report's particular discipline — it answers for two snapshots
   with different windows, and it refuses by name rather than drawing zeros.

   Resolved at CALL time, never at load: under the test harness this file is a
   `require` evaluated outside the vm sandbox, where there is no `document` at
   all. Same trap target-view.js documents in its wire().

   Loaded as a plain <script> before the page's own, so `CcFmt` is a global.
   The CSP forbids inline script, and every page already loads its JS this way.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcFmt = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  /* $, fmt, pc and esc come from public/fmt.js — one copy for every page. */
  const F = (typeof module === 'object' && module.exports) ? require('./fmt.js') : root.Fmt;
  const { $, fmt, pc, esc } = F;

  const mmss = (s) => (s === null || s === undefined ? '—'
    : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);

  /** Minutes as a person says them. 2 -> "2m", 1500 -> "1d 1h". */
  const dur = (m) => {
    if (m === null || m === undefined || m < 0) return '—';
    if (m < 60) return `${Math.round(m)}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
    return `${Math.floor(m / 1440)}d ${Math.round((m % 1440) / 60)}h`;
  };

  /** Minutes from midnight as a clock time. 1080 -> "18:00". */
  const clock = (m) => (m === null || m === undefined || m < 0 ? '—'
    : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

  const bar = (v, max) =>
    `<div class="tr"><i style="width:${Math.min(100, max ? (v / max) * 100 : 0).toFixed(1)}%"></i></div>`;

  /**
   * Colour a rate against the policy floor.
   *
   * Green at or above target, amber within reach, red below. The floor is the
   * commission policy's, not a style choice, so it is passed in rather than
   * assumed.
   */
  const tone = (v, floor) => {
    if (v === null || v === undefined) return '';
    if (v >= 1) return 'g';
    if (v >= floor) return 'a';
    return 'r';
  };

  /**
   * The banner a panel opens with when its figures are not for the range the
   * control bar shows.
   *
   * Not a footnote and not optional. This report answers from two frozen
   * snapshots with different windows — the phones are 1–18 August, the CRM is
   * September into October — and a panel showing 2,919 under a bar reading
   * "September" is telling the reader something untrue.
   */
  function windowBanner(win, what) {
    if (!win) return '';
    if (!win.any) {
      return `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>Nothing to show for this range.</strong> ${esc(win.note || '')}</div>`;
    }
    if (win.full) return '';
    return `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>These are ${esc(win.from)} → ${esc(win.to)}, not the range above.</strong>
      ${esc(win.note || '')}</div>`;
  }

  /** A panel with nothing to draw, saying why rather than drawing zeros. */
  function emptyPanel(kicker, title, win) {
    return `<section>
      <div class="kicker">${esc(kicker)}</div>
      <h2 class="title">${esc(title)}</h2>
      ${windowBanner(win, title)}
      <div class="tg-note"><strong>Nothing is shown here rather than zero.</strong>
        Drawing zeroes would be a claim that nothing happened on these dates. What is true is
        that the export does not cover them.</div>
    </section>`;
  }

  /**
   * A block the report cannot answer, and why.
   *
   * The distinction this exists to keep: a section can be empty because nothing
   * happened, or because the export does not carry the column. Those look
   * identical on screen and mean opposite things, so the second is always drawn
   * as a refusal with the reason and the remedy.
   */
  function refusal(title, o) {
    if (!o) return '';
    return `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>${esc(title)}</strong><br>${esc(o.why || '')}
      ${o.alsoTrue ? `<br><br>${esc(o.alsoTrue)}` : ''}
      ${o.fix ? `<br><br><em>To fix it:</em> ${esc(o.fix)}` : ''}</div>`;
  }

  /**
   * A table.
   *
   * `cols` is `[{k, h, n?, f?, w?}]` — key, heading, numeric, a formatter, and
   * an optional width hint. Numeric columns are right-aligned through the `n`
   * class so figures line up on the decimal point, which is the only way a
   * column of money can be read down.
   */
  function table(rows, cols, opts = {}) {
    if (!rows || !rows.length) return `<div class="sm2">${esc(opts.empty || 'Nothing in range.')}</div>`;
    const head = cols.map((c) => `<th${c.n ? ' class="n"' : ''}>${esc(c.h)}</th>`).join('');
    const body = rows.map((r) => `<tr>${cols.map((c) => {
      const v = c.f ? c.f(r) : r[c.k];
      return `<td class="${c.n ? 'n' : 'nm'}">${c.f ? v : esc(v == null ? '—' : v)}</td>`;
    }).join('')}</tr>`).join('');
    const foot = opts.foot
      ? `<tfoot><tr>${cols.map((c) => `<th${c.n ? ' class="n"' : ''}>${opts.foot[c.k] == null ? '' : opts.foot[c.k]}</th>`).join('')}</tr></tfoot>`
      : '';
    const t = `<table class="ltab tight"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
    return opts.scroll
      ? `<div class="tw scrolly" style="--minw:${opts.minw || 560}px;--h:${opts.h || 420}px">${t}</div>`
      : `<div class="tw">${t}</div>`;
  }

  /** One KPI card. */
  const kpi = (label, value, sub, cls = '') =>
    `<div class="kpi${cls ? ` ${cls}` : ''}"><div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value sm">${value}</div>
      <div class="kpi-sub">${sub || ''}</div></div>`;

  const kpis = (cards) => `<div class="kpi-grid">${cards.join('')}</div>`;

  /** A heat grid. `rows` is `[{label, cells:[n]}]`; the scale is the max cell. */
  function heat(rows, headers, opts = {}) {
    if (!rows || !rows.length) return `<div class="sm2">${esc(opts.empty || 'Nothing in range.')}</div>`;
    const max = rows.reduce((m, r) => Math.max(m, ...r.cells), 0) || 1;
    const head = `<tr><th></th>${headers.map((h) => `<th class="n">${esc(h)}</th>`).join('')}</tr>`;
    const body = rows.map((r) => `<tr><td class="nm">${esc(r.label)}</td>${r.cells.map((c) => {
      const a = c ? (0.12 + 0.78 * (c / max)).toFixed(3) : 0;
      return `<td class="n" style="background:rgba(88,56,44,${a})">${c || ''}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="tw scrolly" style="--minw:${opts.minw || 700}px;--h:${opts.h || 420}px">
      <table class="ltab tight"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  return { $, fmt, pc, esc, mmss, dur, clock, bar, tone, windowBanner, emptyPanel, refusal, table, kpi, kpis, heat };
});
