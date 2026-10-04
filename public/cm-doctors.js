/* ============================================================
   Doctor commission and payslips — the pack, live.

   WHAT IS DERIVED AND WHAT IS NOT is the whole discipline of this panel.
   Revenue and the rate come from the Odoo cache; hours, deductions, management
   fees and withholding come from the monthly payroll file and are never
   inferred. The table labels which is which, because half a payslip that looks
   whole is the one failure worth designing against.

   PURE RENDERERS. `html(C)` returns a string and writes to nothing — including
   on its refusal path, which used to write to the panel and return early. The
   controller decides where the markup lands; the harness can draw it with no
   DOM at all.

   THE BODIES ARE INDENTED AS THEY WERE, one level shallower than this wrapper.
   Most of `html` is a single template literal, so re-indenting the source
   re-indents the HTML it emits — harmless on screen, but it breaks the
   byte-for-byte equality that is the only proof this move changed nothing.

   Loaded as a plain <script> before the page's own, so `CmDoctors` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CmDoctors = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

function html(C) {


  let h = `<section>
    <div class="kicker">04 — Doctor commission</div>
    <h2 class="title">Commission and payslips</h2>`;

  if (!C || C.error) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>Commission could not be built.</strong> ${esc((C && C.error) || 'No payload.')}</div></section>`;
    return h;
  }

  const T = C.totals;
  h += `<p class="sub">${esc(C.window.from)} → ${esc(C.window.to)}. Revenue is ex-package and
      ex-VAT, the same basis as every other report; commission is that revenue at the doctor's
      rate. <strong>Tap a doctor</strong> for the full payslip.</p>

    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Commission earned</div>
        <div class="kpi-value">${fmt(T.commission)}<span class="kpi-unit">EGP</span></div>
        <div class="kpi-sub">${fmt(T.rated)} of ${fmt(T.doctors)} doctors have a rate</div></div>
      <div class="kpi"><div class="kpi-label">Revenue behind it</div>
        <div class="kpi-value sm">${fmt(T.ex)}</div>
        <div class="kpi-sub">ex-VAT, ex-package</div></div>
      <div class="kpi"><div class="kpi-label">Net payable</div>
        <div class="kpi-value sm">${T.withPayslip ? fmt(T.net) : '—'}</div>
        <div class="kpi-sub">${T.withPayslip
    ? `${fmt(T.withPayslip)} payslips · ${fmt(T.tax)} withheld`
    : 'no payroll loaded for this month'}</div></div>
      <div class="kpi"><div class="kpi-label">Management fees</div>
        <div class="kpi-value sm">${T.withPayslip ? fmt(T.mgmt) : '—'}</div>
        <div class="kpi-sub">paid on top of commission</div></div>
    </div>`;

  /* The one thing a reader must know before reading a single figure below. */
  if (!C.missing.payrollLoaded) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>No payroll has been loaded for ${esc(C.period)}, so there are no payslips yet —
      only commission.</strong> Hours, deductions, management fees and withholding are not in
      Odoo; they arrive with the monthly file in <a href="/admin">Admin → Data</a>. Showing a
      payslip without them would not be a smaller payslip, it would be a wrong one.</div>`;
  }
  if (C.missing.noRate.length) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>${C.missing.noRate.length} on a scheme that gives them no rate.</strong>
      ${C.missing.noRate.slice(0, 3).map((x) => `${esc(x.name)} — ${esc(x.why)}`).join('<br>')}
      Nothing is computed for them; a rate invented to fill the gap is a payment nobody agreed.</div>`;
  }

  h += `<div class="search-row">
      <input class="search-input" id="comSearch" type="search"
        placeholder="Search doctor or scheme…" autocomplete="off">
      <div class="search-btns">
        <button class="expand-btn" id="comCsv">Export summary to CSV</button>
      </div>
    </div>

    <div class="tw scrolly" style="--minw:820px;--h:620px"><table class="ltab"><thead><tr>
      <th>Doctor</th><th>Scheme</th><th class="n">Revenue ex-VAT</th><th class="n">Rate</th>
      <th class="n">Commission</th><th class="n">Net payable</th><th></th>
    </tr></thead><tbody>${C.rows.map((r) => `<tr data-search-target>
      <td class="nm">${esc(r.name)}${r.note ? ' <span class="pill" title="' + esc(r.note) + '">note</span>' : ''}</td>
      <td style="font-size:11.5px">${r.scheme ? esc(r.scheme)
    : '<span class="pill" style="background:rgba(176,80,60,.14);color:#b0503c">no scheme</span>'}</td>
      <td class="n">${fmt(r.ex)}<br><span class="sm2">${fmt(r.invoices)} inv</span></td>
      <td class="n">${r.rate != null ? `${(r.rate * 100).toFixed(2)}%${r.rateFrom === 'override'
    ? '<br><span class="sm2" title="' + esc(r.rateWhy || '') + '">agreed rate</span>' : ''}` : '—'}</td>
      <td class="n"><strong>${r.commission != null ? fmt(r.commission) : '—'}</strong></td>
      <td class="n">${r.payslip ? fmt(r.payslip.net) : '<span class="sm2">no payroll</span>'}</td>
      <td class="n">${r.commission != null
    ? `<button class="btn ghost" data-slip="${esc(r.name)}">Payslip</button>` : ''}</td>
    </tr>`).join('')}</tbody>
      <tfoot><tr><th>Total</th><th></th><th class="n">${fmt(T.ex)}</th><th></th>
        <th class="n">${fmt(T.commission)}</th><th class="n">${T.withPayslip ? fmt(T.net) : '—'}</th>
        <th></th></tr></tfoot></table></div>

    <div class="tg-note">${esc(C.note)}</div>`;

  return `${h}</section>`;
}

function csv(C, dom) {
  const d = dom || document;
  if (!C || C.error) return;
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Doctor', 'Scheme', 'Revenue ex-VAT', 'Rate', 'Commission', 'Hours', 'Basic',
    'Deductions', 'Management fee', 'Gross', 'Withholding', 'Net'];
  const rows = C.rows.map((r) => [
    r.name, r.scheme || '', r.ex, r.rate == null ? '' : r.rate,
    r.commission == null ? '' : r.commission,
    r.payslip ? r.payslip.hours : '', r.payslip ? r.payslip.basic : '',
    r.payslip ? r.payslip.ded : '', r.payslip ? r.payslip.mgmt : '',
    r.payslip ? r.payslip.total : '', r.payslip ? r.payslip.tax : '',
    r.payslip ? r.payslip.net : '',
  ]);
  const csv = [head, ...rows].map((line) => line.map(cell).join(',')).join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = Object.assign(d.createElement('a'), {
    href, download: `doctor-commission-${C.period}.csv`,
  });
  d.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

  return { html, csv };
});
