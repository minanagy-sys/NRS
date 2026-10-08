/* ============================================================
   02 — Actuals. What actually happened, by branch and by service, against the
   same months a year earlier.

   The year-before column is the same MONTHS, not the same number of days, which
   is what makes a growth figure mean anything. Where a month has no prior year
   the cell says "new" rather than showing an infinite percentage.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcAc = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;
  const VIEW = { year: null, more: false, mode: 'full', period: 'year' };

  const histFor = (kind, period) => ((C.ST.ref && C.ST.ref.history[kind]) || {})[period] || {};

  const MONTHS_IN = {
    year: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    h1: [1, 2, 3, 4, 5, 6], h2: [7, 8, 9, 10, 11, 12],
    q1: [1, 2, 3], q2: [4, 5, 6], q3: [7, 8, 9], q4: [10, 11, 12],
  };

  /**
   * Which months of a year this view counts.
   *
   * "Like for like" clamps BOTH years to the months the later one actually has,
   * so a year still in progress is not compared against twelve months of the
   * one before it. That comparison is how a normal year reads as a collapse.
   */
  function monthsFor(kind, year) {
    const hist = (C.ST.ref && C.ST.ref.history[kind]) || {};
    const want = MONTHS_IN[VIEW.period] || MONTHS_IN.year;
    if (VIEW.mode !== 'ytd') return want;
    const latest = Object.keys(hist).filter((p) => p.startsWith(VIEW.year || year))
      .map((p) => +p.slice(5, 7));
    const last = latest.length ? Math.max(...latest) : 12;
    return want.filter((m) => m <= last);
  }

  /** Sum a cut across the months of a year, respecting scope for branches. */
  function cut(kind, year) {
    const hist = (C.ST.ref && C.ST.ref.history[kind]) || {};
    const months = monthsFor(kind, year);
    const out = {};
    for (const [period, byName] of Object.entries(hist)) {
      if (!period.startsWith(year)) continue;
      if (!months.includes(+period.slice(5, 7))) continue;
      for (const [name, v] of Object.entries(byName)) {
        if (kind === 'branch' && !C.inScope(name)) continue;
        out[name] = (out[name] || 0) + v;
      }
    }
    return out;
  }

  function years() {
    const hist = (C.ST.ref && C.ST.ref.history.branch) || {};
    return [...new Set(Object.keys(hist).map((p) => p.slice(0, 4)))].sort().reverse();
  }

  function render() {
    if (!C.ST.ref) return;
    const { fmt, esc, pct } = C;
    const ys = years();
    if (!ys.length) { C.$('acBr').innerHTML = '<tbody><tr><td>No history loaded.</td></tr></tbody>'; return; }
    const year = VIEW.year && ys.includes(VIEW.year) ? VIEW.year : ys[0];
    VIEW.year = year;
    const prev = String(+year - 1);

    C.$('acYear').innerHTML = ys.map((y) => `<button class="chip${y === year ? ' on' : ''}" data-year="${y}">${y}</button>`).join('');
    C.$('acYear').querySelectorAll('[data-year]').forEach((b) => b.addEventListener('click', () => {
      VIEW.year = b.getAttribute('data-year');
      render();
    }));

    /* Whole year, or the part of it that has actually happened. Comparing a
       part year against a full prior year is the classic way to invent a
       collapse, so the like-for-like option is here and is the default once a
       year is still running. */
    const MODES = [['full', 'Full years'], ['ytd', 'Like for like']];
    C.$('acMode').innerHTML = MODES.map(([v, l]) => `<button class="chip${v === VIEW.mode ? ' on' : ''}" data-mode="${v}">${l}</button>`).join('');
    C.$('acMode').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      VIEW.mode = b.getAttribute('data-mode');
      render();
    }));

    /* Which months of the year to count. */
    const monthsOf = (y) => Object.keys((C.ST.ref.history.branch) || {}).filter((p) => p.startsWith(y));
    const PERIODS = [['year', 'Whole year'], ['h1', 'Jan–Jun'], ['h2', 'Jul–Dec'],
      ['q1', 'Q1'], ['q2', 'Q2'], ['q3', 'Q3'], ['q4', 'Q4']];
    const per = C.$('acPer');
    per.innerHTML = PERIODS.map(([v, l]) => `<option value="${v}"${v === VIEW.period ? ' selected' : ''}>${l}</option>`).join('');
    per.onchange = () => { VIEW.period = per.value; render(); };

    const cur = cut('branch', year);
    const was = cut('branch', prev);
    const c = C.S(Object.values(cur));
    const p = C.S(Object.values(was));
    const planTotal = C.S(C.branchNames().filter(C.inScope)
      .map((n) => C.S(Object.entries(C.branchPlan(n)).filter(([k]) => k.startsWith(year)).map(([, v]) => v))));

    C.$('acKpi').innerHTML = [
      ['Billed', fmt(c), `${year}, ex-VAT`],
      ['Year before', fmt(p), prev],
      ['Growth', p ? pct(c / p - 1) : '—', 'against the same months'],
      ['Plan', fmt(planTotal * C.tierOf()),
        C.ST.tier === 100 ? `${year} target` : `${year} target at ${C.ST.tier}%`],
    ].map(([l, v, s]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`).join('');

    C.$('acBrTag').textContent = 'billed ex-VAT';
    const names = [...new Set([...Object.keys(cur), ...Object.keys(was)])]
      .sort((a, b) => (cur[b] || 0) - (cur[a] || 0));
    C.$('acBr').innerHTML = `<thead><tr><th>Branch</th><th>${year}</th><th>${prev}</th><th>Growth</th><th>Share</th></tr></thead><tbody>${
      names.map((n) => {
        const g = was[n] ? (cur[n] || 0) / was[n] - 1 : null;
        return `<tr><td class="nm">${esc(n)}</td><td>${fmt(cur[n] || 0)}</td><td>${fmt(was[n] || 0)}</td>
          <td class="${g == null ? '' : g >= 0 ? 'up' : 'dn'}">${g == null ? 'new' : pct(g)}</td>
          <td>${c ? `${(((cur[n] || 0) / c) * 100).toFixed(1)}%` : '—'}</td></tr>`;
      }).join('')
    }<tr class="total"><td>Total</td><td>${fmt(c)}</td><td>${fmt(p)}</td><td>${p ? pct(c / p - 1) : '—'}</td><td>100%</td></tr></tbody>`;

    /* Services, with the product types nested under each when asked for. */
    const gCur = cut('group', year);
    const gWas = cut('group', prev);
    const pCur = cut('product', year);
    const pWas = cut('product', prev);
    const groups = (C.ST.ref.groups || []).filter((g) => gCur[g] || gWas[g]);
    const mixOf = (g) => {
      const mix = (C.ST.ref.mix || {});
      const types = new Set();
      Object.values(mix).forEach((byGroup) => Object.keys(byGroup[g] || {}).forEach((t) => types.add(t)));
      return [...types].filter((t) => pCur[t] || pWas[t]).sort((a, b) => (pCur[b] || 0) - (pCur[a] || 0));
    };

    C.$('acSv').innerHTML = `<thead><tr><th>Service</th><th>${year}</th><th>${prev}</th><th>Growth</th><th>Share</th></tr></thead><tbody>${
      groups.map((g) => {
        const gr = gWas[g] ? (gCur[g] || 0) / gWas[g] - 1 : null;
        const head = `<tr class="grp"><td>${esc(g)}</td><td>${fmt(gCur[g] || 0)}</td><td>${fmt(gWas[g] || 0)}</td>
          <td class="${gr == null ? '' : gr >= 0 ? 'up' : 'dn'}">${gr == null ? 'new' : pct(gr)}</td>
          <td>${c ? `${(((gCur[g] || 0) / c) * 100).toFixed(1)}%` : '—'}</td></tr>`;
        if (!VIEW.more) return head;
        return head + mixOf(g).map((t) => {
          const tg = pWas[t] ? (pCur[t] || 0) / pWas[t] - 1 : null;
          return `<tr><td class="nm" style="padding-left:26px">${esc(t)}</td><td>${fmt(pCur[t] || 0)}</td>
            <td>${fmt(pWas[t] || 0)}</td><td class="${tg == null ? '' : tg >= 0 ? 'up' : 'dn'}">${tg == null ? 'new' : pct(tg)}</td>
            <td>${c ? `${(((pCur[t] || 0) / c) * 100).toFixed(1)}%` : '—'}</td></tr>`;
        }).join('');
      }).join('')
    }<tr class="total"><td>Total</td><td>${fmt(C.S(groups.map((g) => gCur[g] || 0)))}</td>
      <td>${fmt(C.S(groups.map((g) => gWas[g] || 0)))}</td><td></td><td>100%</td></tr></tbody>`;

    const more = C.$('acPtMore');
    more.textContent = VIEW.more ? 'Hide product types' : 'See product types';
    more.onclick = () => { VIEW.more = !VIEW.more; render(); };
  }

  return { render, VIEW };
});
