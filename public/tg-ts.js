/* ============================================================
   Service targets — a branch target split across the departments.

   WHERE THE SPLIT COMES FROM. Not from the plan file, which froze a mix per
   branch per month in September. Each branch's target is divided by what that
   branch ACTUALLY BILLS, recomputed from the invoice lines, so the split
   follows the clinic rather than a spreadsheet somebody closed. A branch with
   no history of its own borrows the clinic-wide shape and the panel says so.

   THE DEPARTMENTS ARE THE COMMISSION'S OWN. Same list, same mapping function —
   `target-tracker.familyOf` — as the multipliers use. A second grouping here
   would mean a branch could breach its injections cap on one page and not on
   another.

   THIS IS A DERIVED TARGET, AND IT SAYS SO. Nobody agreed "Alex Camp Chizar
   must bill 1,355,594 of laser in March". They agreed a branch total; this is
   that total shaped by the branch's own mix, and it is useful for planning
   capacity rather than for holding anyone to.

   Loaded as a plain <script> before the page's own, so `TgTs` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgTs = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLab = (k) => {
    const [y, m] = String(k).split('-').map(Number);
    return `${MON[m - 1]} ${String(y).slice(2)}`;
  };

  const VIEW = { year: null, branch: 'all' };

  /**
   * The split, per department, for the months in view.
   *
   * Done branch by branch and then summed — NOT by applying a clinic-wide mix
   * to the clinic-wide total. The two differ whenever a branch's mix differs
   * from the average, which is the entire point of the panel: El Rehab is 41%
   * laser and Alex Camp Chizar is 32%, so a pooled split would understate one
   * and overstate the other while summing to the same grand total.
   */
  function split(plan, months) {
    const P = plan.branches;
    const M = plan.mix;
    const keys = M.departments.map((d) => d.key);
    const mIdx = months.map((k) => P.months.indexOf(k));
    const zero = () => Object.fromEntries(keys.map((k) => [k, 0]));

    const byMonth = months.map(() => zero());
    const byBranch = new Map();
    let total = 0;
    let borrowed = [];

    P.branches.forEach((b, ri) => {
      const m = M.byBranch[b.odooName] || M.byBranch[b.name];
      const share = m ? m.share : M.whole.share;
      if (!m || !m.derived) borrowed.push(b.name);
      const row = zero();
      mIdx.forEach((mi, j) => {
        const t = P.target[ri][mi];
        if (t == null) return;
        for (const k of keys) {
          const v = t * (share[k] || 0);
          row[k] += v;
          byMonth[j][k] += v;
          total += v;
        }
      });
      byBranch.set(b.name, row);
    });

    return { keys, byMonth, byBranch, total, borrowed };
  }

  function html(plan) {
    const P = plan && plan.branches;
    const M = plan && plan.mix;
    if (!P || !P.months.length || !M) {
      return `<section><div class="kicker">05 — Service targets</div>
        <h2 class="title">No plan to split</h2>
        <p class="sub">Set branch targets in <a href="/admin">Admin → Periods</a> first.</p></section>`;
    }
    const years = [...new Set(P.months.map((k) => Number(k.slice(0, 4))))].sort();
    if (VIEW.year == null || !years.includes(VIEW.year)) VIEW.year = years[years.length - 1];
    const months = P.months.filter((k) => Number(k.slice(0, 4)) === VIEW.year);
    const S = split(plan, months);
    const label = Object.fromEntries(M.departments.map((d) => [d.key, d.label]));
    const mult = Object.fromEntries(M.departments.map((d) => [d.key, d.multiplier]));

    let h = `<section>
      <div class="kicker">05 — Service targets</div>
      <h2 class="title">What the plan implies, service by service</h2>
      <p class="sub">Each branch's target divided by what that branch actually bills.
        ${esc(M.note)} <strong>Nobody agreed these figures</strong> — they are the branch totals
        shaped by the branch's own mix, useful for planning capacity rather than for holding a
        department to.</p>
      <div class="tg-chips" id="tsYear">${years.map((y) => `<button class="tg-chip${y === VIEW.year ? ' on' : ''}"
        data-tsyear="${y}">${y}</button>`).join('')}</div>`;

    /* The headline per department, with the multiplier beside it — the reason a
       department is worth pushing is on the same card as its number. */
    h += '<div class="kpi-grid">';
    for (const k of S.keys) {
      const v = S.byMonth.reduce((a, m) => a + m[k], 0);
      h += `<div class="kpi"><div class="kpi-label">${esc(label[k])}</div>
        <div class="kpi-value sm">${fmt(v)}</div>
        <div class="kpi-sub">${S.total ? pc(v / S.total) : '—'} of the plan${
  mult[k] ? ` · &times;${mult[k]} on the pool` : ''}</div></div>`;
    }
    h += `<div class="kpi accent"><div class="kpi-label">${VIEW.year} plan</div>
      <div class="kpi-value">${fmt(S.total)}</div>
      <div class="kpi-sub">${P.branches.length} branches · ${months.length} months</div></div></div>`;

    if (M.unmapped.length) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${M.unmapped.map((k) => esc(label[k] || k)).join(', ')} never receives any revenue.</strong>
        It is a stored department that the category mapping never returns, so it reads 0% on every
        branch — a gap in the mapping rather than a department nobody sells. Shown rather than
        hidden, because a silent zero looks like a fact.</div>`;
    }
    if (S.borrowed.length) {
      h += `<div class="tg-note"><strong>${S.borrowed.length} branch${S.borrowed.length === 1 ? '' : 'es'}
        ${S.borrowed.length === 1 ? 'has' : 'have'} no billing history</strong>, so
        ${S.borrowed.length === 1 ? 'its' : 'their'} target is split on the clinic-wide shape:
        ${esc(S.borrowed.join(', '))}.</div>`;
    }

    /* ---- by month ---- */
    h += `<h3 class="subtitle">Month by month</h3>
      <div class="tw scrolly" style="--minw:${150 + S.keys.length * 120}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr><th>Month</th>
        ${S.keys.map((k) => `<th class="n">${esc(label[k])}</th>`).join('')}
        <th class="n">Total</th></tr></thead><tbody>
      ${months.map((k, j) => {
    const row = S.byMonth[j];
    const tot = S.keys.reduce((a, d) => a + row[d], 0);
    return `<tr><td class="nm">${esc(mLab(k))}</td>
          ${S.keys.map((d) => `<td class="n">${fmt(Math.round(row[d]))}</td>`).join('')}
          <td class="n"><strong>${fmt(Math.round(tot))}</strong></td></tr>`;
  }).join('')}
      </tbody><tfoot><tr><th>${VIEW.year}</th>
        ${S.keys.map((d) => `<th class="n">${fmt(Math.round(S.byMonth.reduce((a, m) => a + m[d], 0)))}</th>`).join('')}
        <th class="n">${fmt(Math.round(S.total))}</th></tr></tfoot></table></div>`;

    /* ---- by branch, with each branch's own mix on the row ---- */
    h += `<h3 class="subtitle">By branch <span class="vat-tag">each on its own mix</span></h3>
      <div class="tw scrolly" style="--minw:${180 + S.keys.length * 120}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr><th>Branch</th>
        ${S.keys.map((k) => `<th class="n">${esc(label[k])}</th>`).join('')}
        <th class="n">Total</th></tr></thead><tbody>
      ${P.branches.map((b) => {
    const row = S.byBranch.get(b.name) || {};
    const tot = S.keys.reduce((a, d) => a + (row[d] || 0), 0);
    return `<tr><td class="nm">${esc(b.name)}</td>
          ${S.keys.map((d) => `<td class="n">${fmt(Math.round(row[d] || 0))}
            <span class="sm2">${tot ? pc((row[d] || 0) / tot, 0) : '—'}</span></td>`).join('')}
          <td class="n"><strong>${fmt(Math.round(tot))}</strong></td></tr>`;
  }).join('')}
      </tbody></table></div>`;

    return `${h}</section>`;
  }

  function wire(el, redraw) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-tsyear]').forEach((b) => b.addEventListener('click', () => {
      VIEW.year = Number(b.dataset.tsyear); redraw();
    }));
  }

  return { html, wire, split, VIEW };
});
