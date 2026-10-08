/* ============================================================
   07 — Overview. Each year month by month, the commission ladder, and the
   year-by-year summary.

   THE 2026 FORECAST IS PART JUDGEMENT, AND THE PAGE SAYS SO. The dashboard
   this came from closed 2026 as:

       January–August actual
     + September grossed up from 27 days to 30, because the daily figures stop
       on the 28th and a short month would read as a collapse
     + October, November and December at 17.4M, 17.1M and 19.6M — three numbers
       somebody typed, not three numbers anything computed.

   Reproducing the figure without reproducing that fact would be the dishonest
   half of the job, so the three months live in `MANUAL_CLOSE` where they can be
   seen and changed, and the panel says plainly which part is a guess.

   The chart is the app's SVG chartlet rather than Chart.js — the CSP forbids an
   external origin. Same seven series, same dashed 80% floor.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcOv = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;
  const Chart = () => root.Chartlet;

  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** The three months of 2026 nobody has figures for yet. */
  const MANUAL_CLOSE = { '2026-10': 17.4e6, '2026-11': 17.1e6, '2026-12': 19.6e6 };
  /** September's daily data stops on the 28th — 27 complete days of 30. */
  const SEP_DAYS = { have: 27, inMonth: 30 };

  /** Actual revenue for a year, as twelve slots; `null` where there is none. */
  function actualYear(y) {
    const hist = (C.ST.ref && C.ST.ref.history.branch) || {};
    return MN.map((_, i) => {
      const row = hist[`${y}-${String(i + 1).padStart(2, '0')}`];
      if (!row) return null;
      return C.S(Object.entries(row).filter(([b]) => C.inScope(b)).map(([, v]) => v));
    });
  }

  /** Plan for a year, as twelve slots. */
  function planYear(y) {
    return MN.map((_, i) => {
      const k = `${y}-${String(i + 1).padStart(2, '0')}`;
      const t = C.S(C.branchNames().filter(C.inScope).map((n) => C.branchPlan(n)[k] || 0));
      return t || null;
    });
  }

  /** How 2026 closes: August actual, September grossed up, then the manual months. */
  function close2026(a26) {
    const sep = a26[8] == null ? null : (a26[8] / SEP_DAYS.have) * SEP_DAYS.inMonth;
    const series = MN.map((_, i) => {
      if (i === 7) return a26[7];                 // where the forecast line joins the actual
      if (i === 8) return sep;
      const k = `2026-${String(i + 1).padStart(2, '0')}`;
      return MANUAL_CLOSE[k] == null ? null : MANUAL_CLOSE[k];
    });
    const total = C.S(a26.slice(0, 8).map((v) => v || 0))
      + (sep || 0)
      + C.S(Object.values(MANUAL_CLOSE));
    return { series, total, sep };
  }

  function render() {
    if (!C.ST.ref) return;
    const { fmt, esc } = C;

    const a24 = actualYear(2024);
    const a25 = actualYear(2025);
    const a26 = actualYear(2026);
    const p26 = planYear(2026);
    const p27 = planYear(2027);
    const close = close2026(a26);

    /* ---- the chart: seven series, the last the 80% commission floor ---- */
    const el = C.$('trend');
    if (el && Chart()) {
      const series = [
        { name: '2024', values: a24 },
        { name: '2025', values: a25 },
        { name: '2026', values: a26 },
        { name: '2026 forecast', values: close.series, dash: true },
        { name: '2026 target', values: p26 },
        { name: '2027 target', values: p27 },
        { name: '2027 at 80%', values: p27.map((v) => (v == null ? null : v * 0.8)), dash: true },
      ];
      const drawn = Chart().lines({ labels: MN, height: 340, width: 1100, series });
      const markup = drawn && drawn.svg ? drawn.svg : drawn;
      const legend = Chart().legend ? Chart().legend(series, 'ovLegend') : '';
      el.outerHTML = `<div id="trend">${legend}${markup}</div>`;
    }

    /* ---- the ladder: what the 2027 TARGET is at each tier ----
       Not what the pool pays — the revenue the year has to reach. 80% of
       315.94M is 252.75M, and that is the number a reader is looking for. */
    const T27 = C.S(p27.map((v) => v || 0));
    const levels = ((C.ST.ref.policy || {}).levels || []).map((l) => l.level);
    C.$('ladder').innerHTML = levels.map((lvl) => `<div class="rung${lvl === 100 ? ' tot' : ''}">
      <div class="l">${lvl}%</div><div class="p">${C.fm(T27 * (lvl / 100))}</div></div>`).join('');

    /* ---- year by year ---- */
    const A24 = C.S(a24.map((v) => v || 0));
    const A25 = C.S(a25.map((v) => v || 0));
    const TQ = C.S(['2026-10', '2026-11', '2026-12']
      .map((k) => C.S(C.branchNames().filter(C.inScope).map((n) => C.branchPlan(n)[k] || 0))));
    const q4Forecast = C.S(Object.values(MANUAL_CLOSE));
    const pc = (a, b) => (b ? `${a / b - 1 >= 0 ? '+' : ''}${Math.round((a / b - 1) * 100)}%` : '—');

    C.$('yrKpi').innerHTML = [
      ['2027 target', C.fm(T27), `${pc(T27, close.total)} on the 2026 forecast · 80% floor ${C.fm(T27 * 0.8)}`],
      ['Q4 2026 target', C.fm(TQ), `80% floor ${C.fm(TQ * 0.8)} · forecast ${C.fm(q4Forecast)}`],
      ['2025', C.fm(A25), A24 ? `${pc(A25, A24)} on the year before` : 'actual'],
      ['2026 forecast', C.fm(close.total), A25 ? `${pc(close.total, A25)} on the year before` : 'forecast'],
    ].map(([l, v, s], i) => `<div class="kpi${i === 0 ? ' accent' : ''}">
      <div class="kpi-label">${esc(l)}</div><div class="kpi-value">${v}</div>
      <div class="kpi-sub">${esc(s)}</div></div>`).join('');

    /* The judgement in the forecast, stated where the forecast is read. */
    let note = C.$('ovNote');
    if (!note) {
      note = document.createElement('div');
      note.className = 'tg-note';
      note.id = 'ovNote';
      const anchor = C.$('yrKpi');
      if (anchor && anchor.before) anchor.before(note);
    }
    note.innerHTML = `<strong>Three months of the 2026 forecast are a judgement, not a calculation.</strong> `
      + `January to August are actual (${fmt(C.S(a26.slice(0, 8).map((v) => v || 0)))}); `
      + `September is grossed up from ${SEP_DAYS.have} days to ${SEP_DAYS.inMonth} `
      + `(${fmt(a26[8])} → ${fmt(close.sep)}), because the daily figures stop on the 28th; `
      + `October, November and December were entered by hand at `
      + `${Object.values(MANUAL_CLOSE).map((v) => C.fm(v)).join(', ')}, totalling `
      + `${C.fm(q4Forecast)} against a Q4 target of ${C.fm(TQ)}.`;
  }

  return { render, MANUAL_CLOSE, close2026, actualYear, planYear };
});
