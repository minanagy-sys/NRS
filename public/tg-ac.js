/* ============================================================
   Actuals — a year of months, with the year before it beside them.

   THE PRIOR YEAR IS NOT ONE KIND OF NUMBER. Before 2026 it comes from the
   journal exports the plan was built on and will never update; from 2026 it is
   derived live from Odoo. A growth figure that crosses that line compares two
   different sources, so the row says which it is rather than printing a
   percentage and hoping.

   A MONTH WITH NO PRIOR YEAR SHOWS AN EM DASH, not 0% and not "new". There is
   no comparison to make, and every way of writing one is a claim.

   Loaded as a plain <script> before the page's own, so `TgAc` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgAc = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLab = (k) => MON[Number(String(k).slice(5, 7)) - 1] || k;

  const VIEW = { year: null };

  const growthTone = (g) => (g == null ? '' : (g > 0.02 ? 'g' : (g < -0.02 ? 'r' : 'a')));

  function html(ac, years) {
    if (!ac || !ac.months) {
      return `<section><div class="kicker">03 — Actuals</div>
        <h2 class="title">Loading…</h2></section>`;
    }
    const T = ac.totals;
    const frozen = ac.months.some((m) => m.source === 'frozen');
    const priorFrozen = ac.months.some((m) => m.priorSource === 'frozen');

    let h = `<section>
      <div class="kicker">03 — Actuals</div>
      <h2 class="title">${ac.year}, month by month</h2>
      <p class="sub">Billed ex-VAT and ex-package. ${esc(ac.note)}</p>`;

    if (years && years.length > 1) {
      h += `<div class="tg-chips" id="acYear">${years.map((y) => `<button class="tg-chip${y === ac.year ? ' on' : ''}"
        data-acyear="${y}">${y}</button>`).join('')}</div>`;
    }

    h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">${ac.year} billed${frozen ? ' · frozen' : ''}</div>
        <div class="kpi-value">${fmt(T.billed)}</div>
        <div class="kpi-sub">${T.monthsWithData} month${T.monthsWithData === 1 ? '' : 's'}${
  frozen ? ' · from the journal exports' : ' · derived from Odoo'}</div></div>
      <div class="kpi"><div class="kpi-label">${ac.year - 1}${priorFrozen ? ' · frozen' : ''}</div>
        <div class="kpi-value sm">${T.prior == null ? '—' : fmt(T.prior)}</div>
        <div class="kpi-sub">${T.prior == null ? 'no prior year held' : 'the same measure'}</div></div>
      <div class="kpi"><div class="kpi-label">Growth</div>
        <div class="kpi-value sm ${growthTone(T.prior ? T.billed / T.prior - 1 : null)}">${
  T.prior ? pc(T.billed / T.prior - 1) : '—'}</div>
        <div class="kpi-sub">${T.prior ? `on ${ac.year - 1}` : 'nothing to compare'}</div></div>
      <div class="kpi"><div class="kpi-label">Planned</div>
        <div class="kpi-value sm">${T.target == null ? '—' : fmt(T.target)}</div>
        <div class="kpi-sub">${T.target ? `billed is ${pc(T.billed / T.target)} of it` : 'no plan for this year'}</div></div>
    </div>`;

    if (priorFrozen && !frozen) {
      h += `<div class="tg-note"><strong>The growth column crosses a change of source.</strong>
        ${ac.year} is derived live from Odoo; ${ac.year - 1} is a frozen figure from the journal
        exports, because the cache does not reach back before ${esc(ac.frozenBefore)}. The
        comparison is the best available, not a like-for-like one.</div>`;
    }

    h += `<h3 class="subtitle">By month</h3>
      <div class="tw scrolly" style="--minw:620px;--h:420px"><table class="ltab tight"><thead><tr>
        <th>Month</th><th class="n">Billed ex-VAT</th><th class="n">${ac.year - 1}</th>
        <th class="n">Growth</th><th class="n">Planned</th><th class="n">Of plan</th>
      </tr></thead><tbody>
      ${ac.months.map((m) => `<tr><td class="nm">${esc(mLab(m.period))}${
  m.source === 'frozen' ? ' <span class="sm2">frozen</span>' : ''}</td>
        <td class="n">${fmt(m.billed)}</td>
        <td class="n">${m.prior == null ? '<span class="sm2">—</span>' : fmt(m.prior)}</td>
        <td class="n ${growthTone(m.growth)}">${m.growth == null ? '<span class="sm2">—</span>' : pc(m.growth)}</td>
        <td class="n">${m.target == null ? '<span class="sm2">—</span>' : fmt(m.target)}</td>
        <td class="n">${m.target ? pc(m.billed / m.target) : '<span class="sm2">—</span>'}</td></tr>`).join('')}
      </tbody><tfoot><tr><th>${ac.year}</th><th class="n">${fmt(T.billed)}</th>
        <th class="n">${T.prior == null ? '—' : fmt(T.prior)}</th>
        <th class="n">${T.prior ? pc(T.billed / T.prior - 1) : '—'}</th>
        <th class="n">${T.target == null ? '—' : fmt(T.target)}</th>
        <th class="n">${T.target ? pc(T.billed / T.target) : '—'}</th></tr></tfoot></table></div>`;

    h += `<h3 class="subtitle">By branch</h3>
      <div class="tw scrolly" style="--minw:620px;--h:420px"><table class="ltab tight"><thead><tr>
        <th>Branch</th><th class="n">Billed ex-VAT</th><th class="n">${ac.year - 1}</th>
        <th class="n">Growth</th><th class="n">Share</th><th class="n">Months</th>
      </tr></thead><tbody>
      ${ac.byBranch.map((b) => `<tr><td class="nm">${esc(b.branch)}</td>
        <td class="n">${fmt(b.billed)}</td>
        <td class="n">${b.prior == null || !b.prior ? '<span class="sm2">—</span>' : fmt(b.prior)}</td>
        <td class="n ${growthTone(b.growth)}">${b.growth == null ? '<span class="sm2">—</span>' : pc(b.growth)}</td>
        <td class="n">${pc(b.share)}</td>
        <td class="n">${b.months}${b.months < T.monthsWithData ? ` <span class="sm2">of ${T.monthsWithData}</span>` : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><th>All</th><th class="n">${fmt(T.billed)}</th>
        <th class="n">${T.prior == null ? '—' : fmt(T.prior)}</th><th class="n"></th>
        <th class="n">100.0%</th><th class="n"></th></tr></tfoot></table></div>`;

    return `${h}</section>`;
  }

  function wire(el, onYear) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-acyear]').forEach((b) => b.addEventListener('click', () => {
      VIEW.year = Number(b.dataset.acyear);
      onYear(VIEW.year);
    }));
  }

  return { html, wire, VIEW };
});
