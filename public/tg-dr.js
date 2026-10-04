/* ============================================================
   Doctor targets — the approved sheet, flat and sortable.

   The same rows as Target vs achieved, with the commission each doctor earned
   beside the target they were measured against.

   THE TWO FIGURES ARE NOT THE SAME BASIS and the table says so: the target is
   set on the sheet in whole EGP of invoiced revenue, and the commission is a
   rate applied to that revenue. A doctor can be behind target and still earn,
   which reads as a contradiction until the columns are labelled.

   A PURE RENDERER: it takes the scored payload and returns a string. It writes
   to no element and reads no page state, so the controller decides where the
   markup lands and the test harness can draw it without a DOM.

   THE BODY IS INDENTED AS IT WAS, one level shallower than its wrapper. That
   looks wrong for about a second and is deliberate: most of this function is
   one long template literal, so re-indenting the source re-indents the HTML
   it emits. Harmless on screen, but it makes the markup differ byte for byte
   from the version this was lifted out of, and that equality is the only
   proof the move changed nothing.

   Loaded as a plain <script> before the page's own, so `TgDr` is a global —
   the CSP forbids inline script and every page already loads its JS this way.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgDr = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  /**
   * @param T the scored target sheet — `targets` on the tracker payload
   * @param C the doctor commission block — `commission` on the same payload
   */
  function html(T, C) {

  let h = `<section>
    <div class="kicker">02 — Doctor targets</div>
    <h2 class="title">Every doctor, one list</h2>`;

  if (!T || T.missing) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>No target sheet for ${esc((T && T.period) || 'this month')}.</strong>
      Publish one in <a href="/admin">Admin → Periods</a> and this fills in. The commission
      column below does not need it and is shown regardless.</div>`;
  }

  const com = new Map(((C && C.rows) || []).map((r) => [String(r.name).trim().toLowerCase(), r]));
  const rows = T && !T.missing
    ? T.groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.name })))
    : ((C && C.rows) || []).map((r) => ({
      name: r.name, group: r.scheme || '—', monthlyTarget: 0, mtdEx: r.ex,
      mtdPct: 0, mtdInvoices: r.invoices, rangeEx: r.ex, perDay: 0, mtdTone: '',
    }));

  const withCom = rows.map((r) => ({ ...r, com: com.get(String(r.name).trim().toLowerCase()) || null }));
  const earned = withCom.filter((r) => r.com && r.com.commission != null);

  h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Doctors listed</div>
        <div class="kpi-value">${fmt(withCom.length)}</div>
        <div class="kpi-sub">${fmt(earned.length)} with a commission figure</div></div>
      <div class="kpi"><div class="kpi-label">Invoiced ex-VAT</div>
        <div class="kpi-value sm">${fmt(withCom.reduce((s, r) => s + (r.mtdEx || 0), 0))}</div>
        <div class="kpi-sub">ex-package, the basis both columns use</div></div>
      <div class="kpi"><div class="kpi-label">Commission earned</div>
        <div class="kpi-value sm">${fmt(earned.reduce((s, r) => s + r.com.commission, 0))}</div>
        <div class="kpi-sub">revenue × the doctor's rate</div></div>
      <div class="kpi"><div class="kpi-label">On a scheme</div>
        <div class="kpi-value sm">${C && !C.error ? fmt(C.coverage.onScheme) : '—'}</div>
        <div class="kpi-sub">${C && !C.error && C.missing.noScheme.length
    ? `<strong style="color:#b0503c">${C.missing.noScheme.length}</strong> invoiced with none`
    : 'everyone who invoiced has one'}</div></div>
    </div>

    <div class="tg-note"><strong>Target and commission are different agreements.</strong>
      The target is a figure Finance publishes on the monthly sheet; the commission is a rate
      applied to what was actually invoiced. A doctor can sit below target and still earn, and
      that is not a contradiction — it is two contracts measured on one page.</div>

    <input class="searchbox" id="dtSearch" placeholder="Search doctor, group or scheme…">
    <div class="tw scrolly" style="--minw:760px;--h:560px"><table class="ltab"><thead><tr>
      <th>Doctor</th><th>Group / scheme</th><th class="n">Invoiced ex-VAT</th>
      <th class="n">Monthly target</th><th class="n">vs target</th>
      <th class="n">Rate</th><th class="n">Commission</th>
    </tr></thead><tbody>${withCom
    .sort((a, b) => (b.com ? b.com.commission || 0 : 0) - (a.com ? a.com.commission || 0 : 0)
      || (b.mtdEx || 0) - (a.mtdEx || 0))
    .map((r) => `<tr data-search-target>
      <td class="nm">${esc(r.name)}</td>
      <td style="font-size:11.5px">${esc(r.group || '—')}${r.com && r.com.scheme && r.com.scheme !== r.group
    ? `<br><span class="sm2">${esc(r.com.scheme)}</span>` : ''}</td>
      <td class="n">${fmt(r.mtdEx)}</td>
      <td class="n">${r.monthlyTarget ? fmt(r.monthlyTarget) : '<span class="sm2">no target</span>'}</td>
      <td class="n">${r.monthlyTarget ? `<b class="${esc(r.mtdTone || '')}">${(r.mtdPct || 0).toFixed(1)}%</b>` : '—'}</td>
      <td class="n">${r.com && r.com.rate != null
    ? `${(r.com.rate * 100).toFixed(2)}%${r.com.rateFrom === 'override'
      ? ` <span class="pill" title="${esc(r.com.rateWhy || '')}">agreed</span>` : ''}`
    : `<span class="sm2" title="${esc((r.com && r.com.rateWhy) || 'Not on a scheme')}">none</span>`}</td>
      <td class="n"><strong>${r.com && r.com.commission != null ? fmt(r.com.commission) : '—'}</strong></td>
    </tr>`).join('')}</tbody></table></div>`;

  if (C && !C.error && C.missing.noScheme.length) {
    h += `<h3 class="subtitle">Invoiced with no scheme</h3>
      <div class="tg-note"><strong>${fmt(C.missing.noSchemeEx)} EGP ex-VAT</strong> was invoiced by
        ${C.missing.noScheme.length} people who are on no commission scheme, so no rate applies and
        no commission is computed for them. Assign a scheme in
        <a href="/admin">Admin → Commission</a>. They are listed rather than dropped: the revenue
        is real and it is in every other total on this page.</div>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Name</th><th class="n">Invoiced ex-VAT</th></tr></thead>
        <tbody>${C.missing.noScheme.map((x) => `<tr><td class="nm">${esc(x.name)}</td><td class="n">${fmt(x.ex)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  return `${h}</section>`;
  }

  /* ---- the multi-year plan, beside the approved sheet ----

     TWO DIFFERENT DOCUMENTS, and the headings say so. The table above is the
     APPROVED SHEET: one published month, reconciled, with actuals against it.
     This is the PLAN: a figure per doctor per month to the end of 2027, agreed
     once and edited in Admin. A doctor can be on one and not the other, and
     merging them into a single table would make that invisible. */

  const PLAN_VIEW = { year: null, group: 'all' };

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLab = (k) => {
    const [y, m] = String(k).split('-').map(Number);
    return `${MON[m - 1]} ${String(y).slice(2)}`;
  };

  function planHtml(plan) {
    const D = plan && plan.doctors;
    if (!D || !D.doctors.length) {
      return `<h3 class="subtitle">The plan</h3>
        <div class="tg-note">No doctor plan is stored. Set it in
        <a href="/admin">Admin → Periods</a>.</div>`;
    }
    const years = [...new Set(D.months.map((k) => Number(k.slice(0, 4))))].sort();
    if (PLAN_VIEW.year == null || !years.includes(PLAN_VIEW.year)) PLAN_VIEW.year = years[years.length - 1];
    const months = D.months.filter((k) => Number(k.slice(0, 4)) === PLAN_VIEW.year);
    const mIdx = months.map((k) => D.months.indexOf(k));

    const groups = ['all', ...D.groups];
    const rows = D.doctors
      .map((d, ri) => ({ ...d, ri, total: mIdx.reduce((a, mi) => a + (D.target[ri][mi] || 0), 0) }))
      .filter((d) => PLAN_VIEW.group === 'all' || d.group === PLAN_VIEW.group)
      .sort((a, b) => b.total - a.total);
    const grand = rows.reduce((a, d) => a + d.total, 0);

    let h = `<h3 class="subtitle">The plan <span class="vat-tag">${PLAN_VIEW.year}</span></h3>
      <p class="cp-desc">A target per doctor per month, agreed once and edited in Admin — separate
        from the approved sheet above, which is published a month at a time and reconciled against
        actuals. ${D.doctors.length} doctors, ${D.months.length} months.</p>
      <div class="tg-chips" id="drPlanYear">${years.map((y) => `<button class="tg-chip${y === PLAN_VIEW.year ? ' on' : ''}"
        data-drplanyear="${y}">${y}</button>`).join('')}</div>
      <div class="tg-chips" id="drPlanGroup">${groups.map((g) => `<button class="tg-chip${g === PLAN_VIEW.group ? ' on' : ''}"
        data-drplangroup="${esc(g)}">${g === 'all' ? 'All groups' : esc(g)}</button>`).join('')}</div>`;

    h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">${PLAN_VIEW.year} plan</div>
        <div class="kpi-value">${fmt(grand)}</div>
        <div class="kpi-sub">${rows.length} doctor${rows.length === 1 ? '' : 's'}${
  PLAN_VIEW.group === 'all' ? '' : ` in ${esc(PLAN_VIEW.group)}`}</div></div>
      <div class="kpi"><div class="kpi-label">Largest</div>
        <div class="kpi-value sm">${fmt(rows.length ? rows[0].total : 0)}</div>
        <div class="kpi-sub">${esc(rows.length ? rows[0].name : '—')}</div></div>
      <div class="kpi"><div class="kpi-label">Median</div>
        <div class="kpi-value sm">${fmt(rows.length ? rows[Math.floor(rows.length / 2)].total : 0)}</div>
        <div class="kpi-sub">half are above, half below</div></div>
    </div>`;

    h += `<div class="tw scrolly" style="--minw:${200 + months.length * 92}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr><th>Doctor</th><th>Group</th>
        ${months.map((k) => `<th class="n">${esc(mLab(k))}</th>`).join('')}
        <th class="n">Total</th></tr></thead><tbody>
      ${rows.map((d) => `<tr><td class="nm">${esc(d.name)}</td>
        <td><span class="sm2">${esc(d.group || '—')}</span></td>
        ${mIdx.map((mi) => {
    const v = D.target[d.ri][mi];
    return `<td class="n">${v == null ? '<span class="sm2">—</span>' : fmt(v)}</td>`;
  }).join('')}
        <td class="n"><strong>${fmt(d.total)}</strong></td></tr>`).join('')}
      </tbody><tfoot><tr><th>All</th><th></th>
        ${mIdx.map((mi) => `<th class="n">${fmt(rows.reduce((a, d) => a + (D.target[d.ri][mi] || 0), 0))}</th>`).join('')}
        <th class="n">${fmt(grand)}</th></tr></tfoot></table></div>`;

    return h;
  }

  /** The plan chips. Bound directly to the nodes, never delegated. */
  function wirePlan(el, redraw) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-drplanyear]').forEach((b) => b.addEventListener('click', () => {
      PLAN_VIEW.year = Number(b.dataset.drplanyear); redraw();
    }));
    el.querySelectorAll('[data-drplangroup]').forEach((b) => b.addEventListener('click', () => {
      PLAN_VIEW.group = b.dataset.drplangroup; redraw();
    }));
  }

  return { html, planHtml, wirePlan, PLAN_VIEW };
});
