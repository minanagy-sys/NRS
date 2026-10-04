/* ============================================================
   Branch targets, at every tier.

   A target is one number; what a branch is actually chased for is five. The
   policy pays from 80% of target upward, so the row a branch manager needs is
   not "4,049,171" but "3,239,337 to start earning, 4,049,171 to be whole" —
   and the tier chips switch which of those the whole grid shows.

   THE TIERS COME FROM THE POLICY, not from a constant. The dashboard this is
   ported from hardcodes `[.8,.85,.9,.95,1]` and separately stores five
   achievement levels that say the same thing; when somebody moves the floor to
   85% the constant keeps saying 80. These read `policy.levels`.

   THE CHART DRAWS SIX BRANCHES AND A REMAINDER. Twelve stacked series in
   fourteen near-identical browns is what the source does, and no reader can
   tell the seventh colour from the ninth. The exact figures are in the matrix
   directly beneath it, which is where a number belongs anyway.

   Loaded as a plain <script> before the page's own, so `TgTb` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgTb = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const C = (typeof module === 'object' && module.exports)
    ? require('./chartlet.js') : root.Chartlet;
  const { fmt, pc, esc } = F;

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLab = (k) => {
    const [y, m] = String(k).split('-').map(Number);
    return `${MON[m - 1]} ${String(y).slice(2)}`;
  };

  /* What the reader is looking at. Module state, so switching tabs and coming
     back does not reset the question they were asking. */
  const VIEW = { tier: 100, year: null, mode: 'year' };
  const OFF = {};

  const tiersOf = (plan) => {
    const lv = plan.policy && plan.policy.levels;
    return (lv && lv.length ? lv.map((l) => l.level) : [80, 85, 90, 95, 100]);
  };

  function html(plan) {
    const P = plan && plan.branches;
    if (!P || !P.months.length) {
      return `<section><div class="kicker">04 — Branch targets</div>
        <h2 class="title">No branch targets are stored</h2>
        <p class="sub">Set them in <a href="/admin">Admin → Periods</a>.</p></section>`;
    }
    const TIERS = tiersOf(plan);
    if (!TIERS.includes(VIEW.tier)) VIEW.tier = TIERS[TIERS.length - 1];
    const years = [...new Set(P.months.map((k) => Number(k.slice(0, 4))))].sort();
    if (VIEW.year == null || !years.includes(VIEW.year)) VIEW.year = years[years.length - 1];

    const months = VIEW.mode === 'all' ? P.months : P.months.filter((k) => Number(k.slice(0, 4)) === VIEW.year);
    const mIdx = months.map((k) => P.months.indexOf(k));
    const f = VIEW.tier / 100;
    const at = (ri, mi) => (P.target[ri][mi] == null ? null : Math.round(P.target[ri][mi] * f));

    const rowTotal = (ri) => mIdx.reduce((a, mi) => a + (at(ri, mi) || 0), 0);
    const colTotal = (mi) => P.branches.reduce((a, _b, ri) => a + (at(ri, mi) || 0), 0);
    const grand = mIdx.reduce((a, mi) => a + colTotal(mi), 0);

    let h = `<section>
      <div class="kicker">04 — Branch targets</div>
      <h2 class="title">Every branch, every month</h2>
      <p class="sub">The figure a branch is measured against, shown at the tier you pick. The policy
        pays nothing below ${pc(TIERS[0] / 100, 0)} of target, so ${pc(TIERS[0] / 100, 0)} is the
        number that decides whether a team earns at all and 100% is the one on the plan.</p>`;

    h += `<div class="tg-chips" id="tbTier">${TIERS.map((t) => `<button class="tg-chip${t === VIEW.tier ? ' on' : ''}"
      data-tbtier="${t}">${t}% of target</button>`).join('')}</div>
      <div class="tg-chips" id="tbYear">${years.map((y) => `<button class="tg-chip${VIEW.mode === 'year' && y === VIEW.year ? ' on' : ''}"
      data-tbyear="${y}">${y}</button>`).join('')}<button class="tg-chip${VIEW.mode === 'all' ? ' on' : ''}" data-tbyear="all">All months</button></div>`;

    h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">${VIEW.mode === 'all' ? 'Whole plan' : VIEW.year} at ${VIEW.tier}%</div>
        <div class="kpi-value">${fmt(grand)}</div>
        <div class="kpi-sub">${P.branches.length} branches · ${months.length} months</div></div>
      <div class="kpi"><div class="kpi-label">Biggest month</div>
        <div class="kpi-value sm">${fmt(Math.max(0, ...mIdx.map(colTotal)))}</div>
        <div class="kpi-sub">${esc(mLab(months[mIdx.map(colTotal).indexOf(Math.max(0, ...mIdx.map(colTotal)))] || '') || '—')}</div></div>
      <div class="kpi"><div class="kpi-label">Largest branch</div>
        <div class="kpi-value sm">${fmt(Math.max(0, ...P.branches.map((_b, ri) => rowTotal(ri))))}</div>
        <div class="kpi-sub">${esc((P.branches[P.branches.map((_b, ri) => rowTotal(ri)).indexOf(Math.max(0, ...P.branches.map((_b, ri) => rowTotal(ri))))] || {}).name || '—')}</div></div>
    </div>`;

    /* ---- the chart ---- */
    const series = P.branches.map((b, ri) => ({
      name: b.name, values: mIdx.map((mi) => at(ri, mi) || 0),
    }));
    const st = C.stack({
      labels: months.map(mLab),
      series: series.filter((_s, i) => !OFF[i]),
      topN: 6,
      title: `Branch targets at ${VIEW.tier}%`,
    });
    h += `<div class="chart-card"><div class="chartwrap">${st.svg}</div>
      ${C.legend(st.drawn, 'tb')}
      <p class="sub" style="margin:8px 0 0">Six branches are drawn separately and the rest share one
        band — twelve stacked colours cannot be told apart. Every exact figure is in the table below.</p>
    </div>`;

    /* ---- the matrix ---- */
    h += `<div class="tw scrolly" style="--minw:${170 + months.length * 94}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr><th>Branch</th>
        ${months.map((k) => `<th class="n">${esc(mLab(k))}</th>`).join('')}
        <th class="n">Total</th></tr></thead><tbody>
      ${P.branches.map((b, ri) => `<tr><td class="nm">${esc(b.name)}</td>
        ${mIdx.map((mi) => {
    const v = at(ri, mi);
    return `<td class="n">${v == null ? '<span class="sm2">—</span>' : fmt(v)}</td>`;
  }).join('')}
        <td class="n"><strong>${fmt(rowTotal(ri))}</strong></td></tr>`).join('')}
      </tbody><tfoot><tr><th>All branches</th>
        ${mIdx.map((mi) => `<th class="n">${fmt(colTotal(mi))}</th>`).join('')}
        <th class="n">${fmt(grand)}</th></tr></tfoot></table></div>`;

    /* A month with no figure at all is the thing somebody has to act on. */
    const holes = [];
    for (const b of P.branches) {
      const ri = P.branches.indexOf(b);
      const n = mIdx.filter((mi) => P.target[ri][mi] == null).length;
      if (n) holes.push(`${b.name} (${n})`);
    }
    if (holes.length) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e;margin-top:12px">
        <strong>${holes.length} branch${holes.length === 1 ? ' has' : 'es have'} months with no target.</strong>
        A blank is not a target of zero — those months score as having nothing to measure against.
        ${esc(holes.join(', '))}</div>`;
    }

    return `${h}</section>`;
  }

  /** Chips and legend. Bound directly to the nodes, never delegated. */
  function wire(el, redraw) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-tbtier]').forEach((b) => b.addEventListener('click', () => {
      VIEW.tier = Number(b.dataset.tbtier); redraw();
    }));
    el.querySelectorAll('[data-tbyear]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.tbyear === 'all') VIEW.mode = 'all';
      else { VIEW.mode = 'year'; VIEW.year = Number(b.dataset.tbyear); }
      redraw();
    }));
    C.wire(el, 'tb', OFF, redraw);
  }

  return { html, wire, VIEW };
});
