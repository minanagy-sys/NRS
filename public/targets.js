/* Report 05 — the target tracker.
 *
 * Everything here arrives already scored by /api/targets-tracker, so the page
 * decides nothing about bands, tiers or pools. Same discipline as the finance
 * page: one payload, no second copy of the rules in the browser.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 1) => `${((Number(v) || 0) * 100).toFixed(d)}%`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;
let SCOPE = 'all';
let MIXBRANCH = 'all';
const SIM = { branch: null, net: null, mult: {} };

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const inScope = (b) => SCOPE === 'all' || b.entity === SCOPE;

/* ------------------------------------------------- 01 · target vs achieved --

   THE SAME SECTION NRS DRAWS, not a copy of it. `public/target-view.js` holds
   the markup and both pages call it — see that file for why a second table with
   the same colouring rules and sort options would have agreed exactly until the
   first time somebody edited one of them.

   It is scored against the APPROVED TARGET SHEET: doctors, groups and the
   monthly schedule Finance publishes. That is a different question from the
   branch commission the rest of this report answers, which is why the two used
   to live on different pages and why the distinction is stated on screen. */

function renderTVA() {
  const T = DATA && DATA.targets;
  $('tva').innerHTML = TargetView.html(T, {
    kicker: '01 — Target vs achieved',
    Rules,
    append: `<div class="tg-note" style="margin-top:16px">This tab scores the
      <strong>approved target schedule</strong> — doctors against the monthly sheet published in
      Admin. Tabs 03 and 05 score something else entirely: <strong>branches against collected
      cash</strong>, on the commission policy. Two different agreements, two different bases, and
      they are not expected to agree.</div>`,
  });
  TargetView.wire(() => renderTVA(), document);
}

/* ----------------------------------------------------------- 02 · doctors ---

   The same rows as tab 01, flat and sortable, with the commission each doctor
   earned beside the target they were measured against.

   THE TWO FIGURES ARE NOT THE SAME BASIS and the table says so: the target is
   set on the sheet in whole EGP of invoiced revenue, and the commission is a
   rate applied to that revenue. A doctor can be behind target and still earn,
   which reads as a contradiction until the columns are labelled. */

function renderDocTargets() {
  const T = DATA && DATA.targets;
  const C = DATA && DATA.commission;

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

  $('doc').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------ 04 · doctor commission

   The payslip pack, live. Click a doctor for the full build-up.

   WHAT IS DERIVED AND WHAT IS NOT is the whole discipline of this tab, and it
   is stated on screen rather than left for somebody to work out: revenue and
   commission come from the Odoo cache and the scheme; hours, deductions,
   management fees and withholding come from the monthly payroll upload and are
   never inferred. With no payroll loaded the commission is shown and the
   payslip is not — because a payslip missing its deductions is not a smaller
   payslip, it is a wrong one. */

function renderCommission() {
  const C = DATA && DATA.commission;

  let h = `<section>
    <div class="kicker">04 — Doctor commission</div>
    <h2 class="title">Commission and payslips</h2>`;

  if (!C || C.error) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>Commission could not be built.</strong> ${esc((C && C.error) || 'No payload.')}</div></section>`;
    $('com').innerHTML = h;
    return;
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

  $('com').innerHTML = `${h}</section>`;
}

/* ---- the payslip itself ---------------------------------------------------

   Opens in the dialog the NRS import already uses, so the shell, the backdrop
   click and the Escape key come for free. Two buttons, as asked: Print — which
   is a `@media print` block, not a library — and Download, which writes the
   same content to a file the browser saves. */

function payslipHtml(r, period) {
  const p = r.payslip;
  const line = (label, value, sub, strong) => `<div class="ps-line${strong ? ' strong' : ''}">
    <div class="ps-l">${label}${sub ? `<span class="ps-sub">${sub}</span>` : ''}</div>
    <div class="ps-v">${value}</div></div>`;

  let h = `<div class="ps" id="psPrint">
    <div class="ps-head">
      <div><div class="ps-name">${esc(r.name)}</div>
        <div class="ps-meta">${esc(r.scheme || 'no scheme')} · ${esc(period)}</div></div>
      <div class="ps-net">${p ? fmt(p.net) : fmt(r.commission)}
        <small>${p ? 'EGP net' : 'EGP commission'}</small></div>
    </div>

    <h4 class="ps-h">Revenue invoiced (ex-VAT)</h4>
    ${line('Invoiced in this period', fmt(r.ex), `${fmt(r.invoices)} invoices · ex-package`)}

    <h4 class="ps-h">Commission earned</h4>
    ${line('Rate', r.rate != null ? `${(r.rate * 100).toFixed(2)}%` : '—',
    r.rateFrom === 'override' ? esc(r.rateWhy || 'agreed for this person')
      : r.rateFrom === 'band' ? 'from the scheme band' : esc(r.rateWhy || ''))}
    ${line('Commission', fmt(r.commission), 'revenue × rate', true)}`;

  if (p) {
    h += `<h4 class="ps-h">Salary build-up</h4>
      ${p.hourlyRate != null
    ? line('Hours', fmt(p.hours, 2), `at ${fmt(p.hourlyRate)} / hour = ${fmt(p.hourlyBasic)}`)
    : line('Hours', '—', 'this scheme does not count working hours')}
      ${p.fixedBasic ? line('Fixed basic', fmt(p.fixedBasic), 'stated by the scheme') : ''}
      ${p.ded ? line('Deductions', `−${fmt(p.ded)}`, esc(p.dedReason || '')) : ''}
      ${p.onda ? line('Onda', fmt(p.onda), 'nurse deduction') : ''}
      ${line('Taxable salary', fmt(p.tsal), 'commission + basic − deductions', true)}
      ${p.mgmt ? line('Management fee', fmt(p.mgmt), 'paid on top of commission') : ''}
      ${p.adjustment ? line('Adjustment', fmt(p.adjustment), 'an explicit correction, not absorbed') : ''}
      ${line('Gross', fmt(p.total), '', true)}
      ${p.taxRate ? line('Withholding', `−${fmt(p.tax)}`, `${(p.taxRate * 100).toFixed(0)}% of gross`) : ''}
      ${p.maint ? line('Maintenance', `−${fmt(p.maint)}`, '') : ''}
      ${p.gcell ? line('G-Cell', fmt(p.gcell), '') : ''}
      ${line('Net payable', fmt(p.net), '', true)}`;
  } else {
    h += `<div class="tg-note" style="margin-top:12px">No payroll is loaded for ${esc(period)},
      so the salary build-up below the commission line cannot be shown. Hours, deductions,
      management fees and withholding are not in Odoo — they arrive with the monthly file.</div>`;
  }

  if (r.branches && r.branches.length) {
    h += `<h4 class="ps-h">Where the revenue came from</h4>
      <table class="ps-t"><thead><tr><th>Branch</th><th class="n">Invoices</th>
        <th class="n">Revenue ex-VAT</th><th class="n">Share</th></tr></thead><tbody>
      ${r.branches.map((b) => `<tr><td>${esc(b.name)}</td><td class="n">${fmt(b.invoices)}</td>
        <td class="n">${fmt(b.ex)}</td><td class="n">${r.ex ? ((b.ex / r.ex) * 100).toFixed(1) : '0.0'}%</td></tr>`).join('')}
      </tbody><tfoot><tr><th>Total</th><th class="n">${fmt(r.invoices)}</th>
        <th class="n">${fmt(r.ex)}</th><th class="n">100.0%</th></tr></tfoot></table>`;
  }

  if (r.note) {
    h += `<h4 class="ps-h">Notes</h4><div class="ps-note">${esc(r.note)}</div>`;
  }

  if (r.pay && (r.pay.method || r.pay.acc)) {
    h += `<h4 class="ps-h">Payment</h4>
      ${line('Method', esc(String(r.pay.method || '—').toUpperCase()), '')}
      ${r.pay.acc ? line('Account', esc(r.pay.acc), esc(r.pay.accName || '')) : ''}`;
  }

  return `${h}</div>`;
}

function openPayslip(name) {
  const C = DATA && DATA.commission;
  if (!C || C.error) return;
  const r = C.rows.find((x) => x.name === name);
  if (!r) return;

  $('dlgTitle').textContent = `Payslip — ${r.name}`;
  $('dlgBody').innerHTML = payslipHtml(r, C.period);
  $('dlgActions').innerHTML = `
    <button class="btn" id="psPrintBtn">Print / save as PDF</button>
    <button class="btn ghost" id="psDownBtn">Download payslip</button>
    <button class="btn ghost" id="psCloseBtn">Close</button>`;
  $('dlg').hidden = false;

  $('psPrintBtn').addEventListener('click', () => window.print());
  $('psDownBtn').addEventListener('click', () => downloadPayslip(r, C.period));
  $('psCloseBtn').addEventListener('click', () => { $('dlg').hidden = true; });
}

/**
 * The payslip as a file.
 *
 * A self-contained HTML document rather than a PDF: generating a real PDF needs
 * a library the CSP would have to allow, and this opens in any browser, prints
 * to PDF from there, and can be mailed as it is.
 */
function downloadPayslip(r, period) {
  const css = `body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#2b2119;
    margin:0;padding:28px;max-width:720px}
    .ps-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
      border-bottom:2px solid #58382C;padding-bottom:12px;margin-bottom:18px}
    .ps-name{font-size:21px;font-weight:700;color:#58382C}
    .ps-meta{font-size:12px;color:#8a7b70;margin-top:3px}
    .ps-net{font-size:26px;font-weight:700;color:#58382C;text-align:right;white-space:nowrap}
    .ps-net small{display:block;font-size:10px;font-weight:400;color:#8a7b70;letter-spacing:.1em;text-transform:uppercase}
    .ps-h{font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:#8a7b70;
      margin:18px 0 6px;font-weight:700}
    .ps-line{display:flex;justify-content:space-between;gap:12px;padding:6px 0;
      border-bottom:1px solid #eee5df;font-size:13px}
    .ps-line.strong{font-weight:700;color:#58382C;border-bottom:1px solid #c9b8ac}
    .ps-sub{display:block;font-size:10.5px;color:#8a7b70;font-weight:400;margin-top:1px}
    .ps-v{white-space:nowrap;font-variant-numeric:tabular-nums}
    .ps-t{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
    .ps-t th,.ps-t td{padding:5px 6px;border-bottom:1px solid #eee5df;text-align:left}
    .ps-t .n{text-align:right;font-variant-numeric:tabular-nums}
    .ps-t tfoot th{border-top:2px solid #c9b8ac;font-weight:700}
    .ps-note{font-size:12px;color:#6b5c50;background:#faf6f2;padding:10px 12px;border-radius:6px;
      white-space:pre-wrap}
    .foot{margin-top:24px;font-size:10px;color:#8a7b70;border-top:1px solid #eee5df;padding-top:10px}`;

  const doc = `<!doctype html><html><head><meta charset="utf-8">
    <title>Payslip — ${esc(r.name)} — ${esc(period)}</title><style>${css}</style></head>
    <body>${payslipHtml(r, period)}
    <div class="foot">Nouvelage · generated ${new Date().toLocaleString('en-GB')} ·
      revenue ex-package ex-VAT from the Odoo cache; hours, deductions and withholding from the
      monthly payroll file.</div></body></html>`;

  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href, download: `payslip-${String(r.name).replace(/[^\w]+/g, '-')}-${period}.html`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** The summary, as a CSV — the pack's own "Export summary to CSV". */
function commissionCsv() {
  const C = DATA && DATA.commission;
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
  const a = Object.assign(document.createElement('a'), {
    href, download: `doctor-commission-${C.period}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/* ------------------------------------------------- 03 · branch targets --- */

/* Report 05's six-card header row.
 *
 * The two cards that matter are BRANCHES and BRANCH POOLS, and they read the
 * PAYABLE figures — `qualifyNow` and `poolNow` — not the run-rate ones. Mid-month
 * both are zero, and report 05 says so in words: no branch can reach 90% of a
 * full month on day 19, and nothing is payable until the month closes.
 *
 * An earlier version of this header showed the run-rate count and the projected
 * pool instead (5 branches, 116,750). Those are real forecasts and they live one
 * screen down, labelled as forecasts — but sitting in a KPI row with no
 * qualifier they read as "five branches have earned 116,750", which is the one
 * thing this report must never imply. A projection in a headline slot is a claim.
 */
function paceCards(T, rows) {
  const net = rows.reduce((s, b) => s + b.net, 0);
  const gross = rows.reduce((s, b) => s + (b.gross || 0), 0);
  const refunds = rows.reduce((s, b) => s + (b.refunds || 0), 0);
  const target = rows.reduce((s, b) => s + (b.target || 0), 0);
  const prorata = rows.reduce((s, b) => s + (b.prorata || 0), 0);
  const pace = prorata ? net / prorata : 0;
  const achievement = target ? net / target : 0;
  const withTarget = rows.filter((b) => b.target);
  /* Actual achievement against the FULL month target — the only basis on which
     anything is owed. */
  const qualify = withTarget.filter((b) => b.achievement >= T.policy.bands.floor).length;
  const pool = rows.reduce((s, b) => s + b.now.pool, 0);
  const txns = rows.reduce((s, b) => s + (b.txns || 0), 0);
  const I = T.extras ? T.extras.integrity : null;
  const floorPc = pc(T.policy.bands.floor, 0);

  const shortRange = (a, b) => {
    const d = (x) => new Date(`${x}T00:00:00Z`);
    const day = (x) => d(x).getUTCDate();
    const mon = (x) => d(x).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    if (a === b) return `${day(a)} ${mon(a)}`;
    return mon(a) === mon(b) ? `${day(a)}\u2013${day(b)} ${mon(b)}` : `${day(a)} ${mon(a)} \u2013 ${day(b)} ${mon(b)}`;
  };
  const monthName = new Date(`${T.from}T00:00:00Z`)
    .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

  return `<div class="kpi-grid six">
    <div class="kpi accent">
      <div class="kpi-label">Net collection &middot; ${esc(shortRange(T.from, T.to))}</div>
      <div class="kpi-value">${fmt(net)}<span class="kpi-unit">EGP</span></div>
      <div class="kpi-sub">ex-VAT &middot; ${fmt(gross)} gross less ${fmt(refunds)} refunds</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">${esc(monthName)} target</div>
      <div class="kpi-value">${fmt(target)}<span class="kpi-unit">EGP</span></div>
      <div class="kpi-sub">${withTarget.length} branch${withTarget.length === 1 ? '' : 'es'}
        &middot; pro-rata ${T.daysElapsed}/${T.daysInMonth} <strong>${fmt(prorata)}</strong></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Pace vs pro-rata</div>
      <div class="kpi-value">${(pace * 100).toFixed(1)}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">${T.closed ? 'Month closed' : 'Month to date'} is
        <strong>${pc(achievement)}</strong> of the full-month target</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Branches &ge; ${esc(floorPc)}</div>
      <div class="kpi-value">${qualify} / ${withTarget.length}</div>
      <div class="kpi-sub">${T.closed
    ? `Measured on the closed month against the full target`
    : `No branch can reach ${esc(floorPc)} of a full month on day ${T.daysElapsed}`}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Branch pools</div>
      <div class="kpi-value">${fmt(pool)}<span class="kpi-unit">EGP</span></div>
      <div class="kpi-sub">${T.closed ? 'Payable on this closed month' : 'Nothing payable mid-month'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Payments captured</div>
      <div class="kpi-value">${fmt(txns)}</div>
      <div class="kpi-sub">${I ? `${fmt(I.revenueInvoices)} invoices &middot; ${fmt(I.revenueExVat)} invoiced ex-VAT`
    : 'invoice figures unavailable'}</div>
    </div>
  </div>`;
}

function paceSection(T) {
  const rows = T.branches.filter(inScope);
  const target = rows.reduce((s, b) => s + (b.target || 0), 0);
  const net = rows.reduce((s, b) => s + b.net, 0);
  const prorata = rows.reduce((s, b) => s + (b.prorata || 0), 0);
  const pace = prorata ? net / prorata : 0;

  /* The distinction the source report leads with and which is easy to misread:
     pace is "on track", achievement is what actually pays, and mid-month they
     are far apart — 93.5% against 57.3% on day 19. */
  let h = `<section>
    <div class="kicker">01 — Pacing</div>
    <h2 class="title">${T.closed ? 'Month closed' : `Day ${T.daysElapsed} of ${T.daysInMonth}`}</h2>
    <p class="sub">${esc(T.baseNote)}</p>
    ${paceCards(T, rows)}
    <div class="tg-note" style="border-left:3px solid ${T.closed ? '#5e8d4a' : '#c98a2e'}">
      <strong>${T.closed ? 'This month is closed — these pools are payable.'
    : 'Mid-month: nothing is payable yet.'}</strong>
      A pool is earned on the <em>closed</em> month against the full target. On day
      ${T.daysElapsed} the run-rate column is a forecast, not an entitlement.
      Policy <strong>${esc(T.policy.version || '—')}</strong>${T.policy.effectiveFrom ? ` in force from ${esc(T.policy.effectiveFrom)}` : ''} ·
      eligibility <strong>${pc(T.policy.bands.floor, 0)}</strong>.
    </div>
    <div class="tg-sum">
      <div class="tg-s inj"><div class="l">Collected vs pro-rata</div><div class="p">${pc(pace)}</div>
        <div class="n">${fmt(net)}<br>of ${fmt(prorata)}</div>
        <div class="b"><i style="width:${Math.min(100, pace * 100).toFixed(1)}%"></i><u style="left:100%"></u></div></div>
      <div class="tg-s las"><div class="l">Against the full month</div><div class="p">${pc(target ? net / target : 0)}</div>
        <div class="n">${fmt(net)}<br>of ${fmt(target)}</div>
        <div class="b"><i style="width:${Math.min(100, (target ? net / target : 0) * 100).toFixed(1)}%"></i><u style="left:${(T.share * 100).toFixed(1)}%"></u></div></div>
      <div class="tg-s tot"><div class="l">${T.closed ? 'Payable' : 'On this run-rate'}</div>
        <div class="p">${fmt(T.closed ? T.totals.poolNow : T.totals.poolRun)}</div>
        <div class="n">${T.closed ? T.totals.qualifyNow : T.totals.qualifyRun} of ${rows.length} branches qualify<br>pool, EGP</div></div>
    </div>`;

  h += `<h3 class="subtitle">Pace by branch</h3>
    <p class="sub">Bar is collection against the pro-rata target; the marker sits at 100%. Anything short of
      <strong>${pc(T.policy.bands.floor, 0)}</strong> on the closed month pays nothing at any tier.</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Collected ex-VAT</th>
      <th class="n">vs pro-rata</th><th class="n">Projected</th><th class="n">Lands at</th></tr></thead><tbody>`;
  for (const b of [...rows].sort((x, y) => y.pace - x.pace)) {
    h += `<tr><td><div class="nm">${esc(b.name)}${b.via ? ` <span class="pill" title="Odoo spells it ${esc(b.via)}">→ ${esc(b.via)}</span>` : ''}${b.override ? ' <span class="pill" style="background:rgba(201,138,46,.14);color:#c98a2e">own bands</span>' : ''}</div>
        <div class="sm2">${esc(b.area)} · ${esc(b.entity)} · ${fmt(b.txns)} payments</div></td>
      <td class="n tcell"><b>${fmt(b.net)}</b><small>of ${fmt(b.target)}</small></td>
      <td class="n tcell"><b class="${b.paceTone}">${pc(b.pace)}</b><small>${fmt(b.prorata)} due by now</small>
        <div class="trk"><i style="width:${Math.min(100, b.pace * 100).toFixed(1)}%"></i><u style="left:100%"></u></div></td>
      <td class="n tcell"><b>${fmt(b.projected)}</b><small>${pc(b.achievementProjected)} of target</small></td>
      <td class="n tcell"><b class="${b.run.band === 'zero' ? 'r' : 'g'}">${b.run.band === 'zero' ? '—' : esc(b.run.band.toUpperCase())}</b>
        <small>${b.run.pool ? `${fmt(b.run.pool)} pool` : 'below the floor'}</small></td></tr>`;
  }
  h += `</tbody></table></div>`;

  const short = rows.filter((b) => b.run.band === 'zero' && b.target);
  if (short.length) {
    h += `<h3 class="subtitle">What each one still needs</h3>
      <p class="sub">Collection required by month end to reach ${pc(T.policy.bands.floor, 0)} of target, and what is left to find.</p>
      <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Needs</th><th class="n">Has</th><th class="n">Gap</th><th class="n">Per remaining day</th></tr></thead><tbody>`;
    const daysLeft = Math.max(1, T.daysInMonth - T.daysElapsed);
    for (const b of short.sort((x, y) => (y.target * T.policy.bands.floor - y.net) - (x.target * T.policy.bands.floor - x.net))) {
      const needs = b.target * T.policy.bands.floor;
      const gap = Math.max(0, needs - b.net);
      h += `<tr><td class="nm">${esc(b.name)}</td><td class="n">${fmt(needs)}</td><td class="n">${fmt(b.net)}</td>
        <td class="n"><b class="r">${fmt(gap)}</b></td><td class="n">${fmt(gap / daysLeft)}</td></tr>`;
    }
    h += `</tbody></table></div>`;
  }
  /* Regional roll-up. `area` is already on every branch row; report 05 leads the
     Pacing tab with this because a director's gate is measured on it. */
  if (T.areas && T.areas.length) {
    const areas = T.areas.filter((a) => SCOPE === 'all'
      || rows.some((b) => b.area === a.area));
    if (areas.length) {
      h += `<h3 class="subtitle">Regional roll-up</h3>
        <p class="sub">The area manager gate reads on this, not on the group total.</p>
        <div class="tw"><table class="ltab"><thead><tr><th>Area</th><th class="n">Branches</th>
          <th class="n">Collected ex-VAT</th><th class="n">Target</th><th class="n">Achievement</th>
          <th class="n">At the floor</th></tr></thead><tbody>`;
      for (const a of areas) {
        const mine = rows.filter((b) => b.area === a.area);
        const net = mine.reduce((x, b) => x + b.net, 0);
        const tgt = mine.reduce((x, b) => x + (b.target || 0), 0);
        const at = mine.filter((b) => b[T.closed ? 'now' : 'run'].band !== 'zero').length;
        h += `<tr><td class="nm">${esc(a.area)}</td><td class="n">${fmt(mine.length)}</td>
          <td class="n">${fmt(net)}</td><td class="n">${fmt(tgt)}</td>
          <td class="n"><b class="${tgt && net / tgt >= T.policy.bands.floor ? 'g' : 'r'}">${pc(tgt ? net / tgt : 0)}</b></td>
          <td class="n">${at} / ${mine.length}</td></tr>`;
      }
      h += '</tbody></table></div>';
    }
  }

  /* Daily collection. The weekly rhythm is the point — a weak Friday is not a
     failing month, and the median says which is which. */
  const D = T.extras && T.extras.daily;
  if (D && D.days.length) {
    h += `<h3 class="subtitle">Daily collection <span class="sm2">net ex-VAT per day</span></h3>
      <p class="sub">${D.days.length} day${D.days.length === 1 ? '' : 's'} · median
        <strong>${fmt(D.median)}</strong> across ${fmt(D.txns)} payments · best
        <strong>${esc(D.best.date)}</strong> at ${fmt(D.best.net)} · weakest
        <strong>${esc(D.worst.date)}</strong> at ${fmt(D.worst.net)}.</p>
      <div class="dbars">`;
    for (const dd of D.days) {
      const pctH = D.peak ? (dd.net / D.peak) * 100 : 0;
      const dow = new Date(`${dd.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
      h += `<div class="dbar" title="${esc(dd.date)} · ${fmt(dd.net)} ex-VAT · ${dd.txns} payments">
        <div class="dbar-t"><i style="height:${pctH.toFixed(1)}%${dd.net === D.worst.net ? ';background:#b0503c' : dd.net === D.best.net ? ';background:#5e8d4a' : ''}"></i></div>
        <div class="dbar-d">${esc(dd.date.slice(8))}</div>
        <div class="dbar-w">${esc(dow)}</div></div>`;
    }
    h += `</div>
      <div class="tg-note">Bars are net <strong>ex-VAT</strong>, the same basis as the
        commission figure above — <code>CollectionDay.net</code> is stored inc-VAT and is
        divided here, so the chart and the headline cannot disagree.</div>`;
  }

  return `${h}</section>`;
}

/* ------------------------------------------------------------- 02 tracker --- */

function trackerSection(T) {
  const rows = T.branches.filter(inScope);
  let h = `<section><div class="kicker">02 — Branch tracker</div>
    <h2 class="title">Target to pool, per branch</h2>
    <p class="sub">The full chain: collection, the band it lands in, the revenue tier that sets the pool size,
      and the pool that follows. <strong>Now</strong> is today's closed-month answer; <strong>run-rate</strong>
      projects the month at the current daily pace.</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Target</th>
      <th class="n">Gross</th><th class="n">Refunds</th><th class="n">Net ex-VAT</th>
      <th class="n">Now</th><th class="n">Run-rate</th></tr></thead><tbody>`;
  for (const b of rows) {
    h += `<tr><td><div class="nm">${esc(b.name)}</div><div class="sm2">${esc(b.area)} · ${esc(b.entity)}</div></td>
      <td class="n">${fmt(b.target)}</td>
      <td class="n">${fmt(b.gross)}</td>
      <td class="n">${b.refunds ? `<span class="r">−${fmt(b.refunds)}</span>` : '—'}</td>
      <td class="n tcell"><b>${fmt(b.net)}</b><small>${fmt(b.netIncVat)} inc-VAT</small></td>
      <td class="n tcell"><b class="${b.now.band === 'zero' ? 'r' : 'g'}">${b.now.pool ? fmt(b.now.pool) : '0'}</b>
        <small>${pc(b.achievement)} · ${b.now.band === 'zero' ? 'no band' : esc(b.now.band)} · tier ${b.now.tierNo || '—'}</small></td>
      <td class="n tcell"><b class="${b.run.band === 'zero' ? 'r' : 'g'}">${b.run.pool ? fmt(b.run.pool) : '0'}</b>
        <small>${pc(b.achievementProjected)} · ${b.run.band === 'zero' ? 'no band' : esc(b.run.band)} · tier ${b.run.tierNo || '—'}</small></td></tr>`;
  }
  const t = (f) => rows.reduce((s, b) => s + (f(b) || 0), 0);
  h += `</tbody><tfoot><tr><td>${rows.length} branches</td><td class="n">${fmt(t((b) => b.target))}</td>
    <td class="n">${fmt(t((b) => b.gross))}</td><td class="n">−${fmt(t((b) => b.refunds))}</td>
    <td class="n">${fmt(t((b) => b.net))}</td><td class="n">${fmt(t((b) => b.now.pool))}</td>
    <td class="n">${fmt(t((b) => b.run.pool))}</td></tr></tfoot></table></div>`;

  if (T.unmatched.length) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>${T.unmatched.length} branch${T.unmatched.length === 1 ? '' : 'es'} with no collection rows</strong>
      — ${T.unmatched.map(esc).join(' · ')}. Either nothing was banked, or the name does not resolve to Odoo and needs an alias.</div>`;
  }
  const X = T.extras;
  if (X) {
    /* Service mix, filterable by branch — report 05's own framing, because the
       multiplier tests below are read off exactly these shares. */
    const mixRows = X.mix.branches.filter((b) => SCOPE === 'all'
      || rows.some((r) => r.name === b.branch || r.via === b.branch));
    const picked = MIXBRANCH === 'all' ? null : mixRows.find((b) => b.branch === MIXBRANCH);
    const catSrc = picked ? picked.categories
      : X.mix.categories.map((c) => ({ ...c, lines: null }));
    const catTot = catSrc.reduce((a, c) => a + c.exVat, 0);

    h += `<h3 class="subtitle">Service mix <span class="sm2">invoice lines · ex-VAT</span></h3>
      <div class="tg-tools"><select class="tg-sort" id="mixBranch">
        <option value="all"${MIXBRANCH === 'all' ? ' selected' : ''}>All branches</option>
        ${mixRows.map((b) => `<option value="${esc(b.branch)}"${MIXBRANCH === b.branch ? ' selected' : ''}>${esc(b.branch)}</option>`).join('')}
      </select></div>
      <div class="tw scrolly" style="--minw:680px;--h:400px"><table class="ltab"><thead><tr><th>Category</th><th>Family</th>
        <th class="n">Revenue ex-VAT</th><th class="n">Share</th></tr></thead><tbody>`;
    for (const c of catSrc.slice(0, 20)) {
      h += `<tr><td class="nm">${esc(c.category)}</td>
        <td><span class="sev ${c.family === 'laser' ? 'open' : c.family === 'inj' ? 'attended' : 'lost'}">${esc(c.family)}</span></td>
        <td class="n">${fmt(c.exVat)}</td><td class="n">${pc(catTot ? c.exVat / catTot : 0)}</td></tr>`;
    }
    h += `</tbody><tfoot><tr><th>${picked ? esc(picked.branch) : 'All categories'}</th><th></th>
      <th class="n">${fmt(catTot)}</th><th class="n">100.0%</th></tr></tfoot></table></div>`;

    /* By doctor — report 01 offers the same category selection sliced by doctor,
       and it is the cut that says who actually drives a category. */
    if (X.mix.doctors && X.mix.doctors.length) {
      h += `<h4 class="subtitle">By doctor <span class="sm2">top 12 · ex-VAT</span></h4>
        <div class="tw scrolly" style="--minw:760px"><table class="ltab tight"><thead><tr><th>Doctor</th>
          <th class="n">Revenue ex-VAT</th><th class="n">Share</th><th>Their top category</th>
          <th class="n">Of their own revenue</th></tr></thead><tbody>`;
      for (const dc of X.mix.doctors.slice(0, 12)) {
        const top = dc.categories[0];
        h += `<tr><td class="nm">${esc(dc.doctor)}</td><td class="n">${fmt(dc.exVat)}</td>
          <td class="n">${pc(dc.share)}</td><td>${esc(top ? top.category : '—')}</td>
          <td class="n">${pc(top && dc.exVat ? top.exVat / dc.exVat : 0)}</td></tr>`;
      }
      h += `</tbody></table></div>
        <p class="sub">"Unassigned" is the package journal: a package is invoiced when it is sold and
          carries no specialist, so it cannot be credited to a doctor at all.</p>`;
    }

    /* Multiplier eligibility. The finding report 05 states in prose and this
       computes: the branches with the right mix have the wrong revenue. */
    if (mixRows.length) {
      h += `<h3 class="subtitle">Multiplier eligibility on current mix <span class="sm2">policy floors applied</span></h3>
        <p class="sub">A floor is a minimum share of the branch's own revenue; a ceiling is a maximum.
          The band gate comes first — a branch under ${pc(T.policy.bands.floor, 0)} of target earns
          nothing regardless of mix, so the last column is what actually decides.</p>
        <div class="tw scrolly" style="--minw:880px"><table class="ltab tight"><thead><tr><th>Branch</th>
          ${X.mix.departments.filter((dp) => dp.multiplier).map((dp) => `<th class="n">${esc(dp.label)} &times;${dp.multiplier}</th>`).join('')}
          <th class="n">Band</th><th>Reachable?</th></tr></thead><tbody>`;
      for (const b of mixRows) {
        const tr = rows.find((r) => r.name === b.branch || r.via === b.branch);
        const band = tr ? tr[T.closed ? 'now' : 'run'].band : null;
        const anyPass = b.tests.some((t) => t.pass === true);
        h += `<tr><td class="nm">${esc(b.branch)}</td>`;
        for (const t of b.tests) {
          h += `<td class="n" title="${esc(t.reason)}">${pc(t.share)}
            <span class="sev ${t.pass === null ? 'open' : t.pass ? 'attended' : 'lost'}">${t.pass === null ? 'n/a' : t.pass ? 'pass' : 'fail'}</span></td>`;
        }
        h += `<td class="n">${band ? esc(band) : '—'}</td>
          <td>${band && band !== 'zero' && anyPass
    ? '<span class="sev attended">yes</span>'
    : `<span class="sev lost">no</span> <span class="sm2">${band === 'zero' ? 'band gate' : anyPass ? '—' : 'mix'}</span>`}</td></tr>`;
      }
      h += '</tbody></table></div>';
      const bandOk = mixRows.filter((b) => { const tr = rows.find((r) => r.name === b.branch || r.via === b.branch); return tr && tr[T.closed ? 'now' : 'run'].band !== 'zero'; });
      const mixOk = mixRows.filter((b) => b.tests.some((t) => t.pass === true));
      const both = bandOk.filter((b) => mixOk.includes(b));
      h += `<div class="tg-note"${both.length ? '' : ' style="border-left:3px solid #c98a2e"'}>
        <strong>${both.length === 0
    ? 'No branch can earn a service multiplier on this range.'
    : `${both.length} branch${both.length === 1 ? '' : 'es'} can earn one.`}</strong>
        ${mixOk.length} branch${mixOk.length === 1 ? '' : 'es'} clear a mix test and
        ${bandOk.length} clear the band gate${both.length === 0 ? ', but they are not the same branches — the ones with the right mix have the wrong revenue and the ones with the right revenue have the wrong mix' : ''}.
        Body Contouring shows <em>n/a</em> because the policy attaches no mix floor to it: its
        real gate is a per-category monthly target, and those targets are not in the data.</div>`;
    }

    /* Data integrity. */
    h += `<h3 class="subtitle">Data integrity</h3>
      <div class="tw"><table class="ltab"><thead><tr><th>Check</th><th class="n">Value</th>
        <th>Reading</th><th></th></tr></thead><tbody>`;
    for (const c of X.integrity.checks) {
      h += `<tr><td class="nm">${esc(c.check)}</td><td class="n">${esc(c.value)}</td>
        <td class="sub" style="margin:0">${esc(c.reading)}</td>
        <td><span class="sev ${c.severity}">${esc(c.severity)}</span></td></tr>`;
    }
    h += '</tbody></table></div>';
  }

  return `${h}</section>`;
}



/* ------------------------------------------------------------- 05 payout --- */

function payoutSection(T) {
  const basis = T.closed ? 'now' : 'run';
  const rows = T.branches.filter(inScope);
  let h = `<section><div class="kicker">05 — Payout &amp; gates</div>
    <h2 class="title">Who earns, and what gates it</h2>
    <p class="sub">A gate that fails pays <strong>zero</strong> however well an individual branch did.
      ${T.closed ? 'Evaluated on the closed month.'
    : `Evaluated on the <strong>projected</strong> month — on day ${T.daysElapsed} no branch has reached a full-month target, so judging the gates on today's total would report "failed" everywhere.`}</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Area</th><th>Branches</th><th class="n">At the floor</th>
      <th class="n">Combined pools</th><th class="n">Gate</th><th class="n">Earns</th></tr></thead><tbody>`;
  for (const a of T.areas) {
    h += `<tr><td class="nm">${esc(a.area)}</td>
      <td style="font-size:11.5px;color:var(--muted)">${a.branches.map(esc).join(' · ')}</td>
      <td class="n tcell"><b class="${a.passed ? 'g' : 'r'}">${a.hits} of ${a.of}</b><small>needs 2</small></td>
      <td class="n">${fmt(a.poolSum)}</td>
      <td class="n"><span class="pill" style="background:${a.passed ? 'rgba(94,141,74,.14)' : 'rgba(176,80,60,.14)'};color:${a.passed ? '#5e8d4a' : '#b0503c'}">${a.passed ? 'passed' : 'failed'}</span></td>
      <td class="n tcell"><b class="${a.passed ? 'g' : 'r'}">${fmt(a.amount)}</b><small>8% of pools</small></td></tr>`;
  }
  if (T.director) {
    const d = T.director;
    h += `<tr><td class="nm">Sales Director</td><td style="font-size:11.5px;color:var(--muted)">all ${d.of} branches</td>
      <td class="n tcell"><b class="${d.byCount ? 'g' : 'r'}">${d.hits} of ${d.of}</b><small>needs 6</small></td>
      <td class="n">${fmt(d.poolSum)}</td>
      <td class="n"><span class="pill" style="background:${d.passed ? 'rgba(94,141,74,.14)' : 'rgba(176,80,60,.14)'};color:${d.passed ? '#5e8d4a' : '#b0503c'}">${d.passed ? 'passed' : 'failed'}</span>
        <div class="sm2" style="text-align:right">${d.byCount ? 'on branch count' : d.byGroup ? `on group ${pc(d.groupAchieved)}` : `group ${pc(d.groupAchieved)}, needs 85%`}</div></td>
      <td class="n tcell"><b class="${d.passed ? 'g' : 'r'}">${fmt(d.amount)}</b><small>5% of pools</small></td></tr>`;
  }
  h += `</tbody></table></div>`;

  h += `<h3 class="subtitle">The team split, branch by branch</h3>
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Pool</th>
      ${T.roles.map((r) => `<th class="n">${esc(r.name)}</th>`).join('')}</tr></thead><tbody>`;
  for (const b of rows.filter((x) => x[basis].pool)) {
    h += `<tr><td class="nm">${esc(b.name)}</td><td class="n"><b>${fmt(b[basis].pool)}</b></td>
      ${b[basis].roles.map((r) => `<td class="n">${fmt(r.amount)}</td>`).join('')}</tr>`;
  }
  if (!rows.some((x) => x[basis].pool)) {
    h += `<tr><td colspan="${T.roles.length + 2}" style="color:var(--muted);font-size:12.5px">No branch qualifies, so there is nothing to split.</td></tr>`;
  }
  h += `</tbody></table></div>`;

  /* The call-centre layer. Report 05 lists it as a table of tiers with a reason
     each, and the reasons are the useful part: this is not "not built yet", it
     is blocked on data that does not exist. */
  h += `<h3 class="subtitle">Call centre layer <span class="sm2">not computed</span></h3>
    <p class="sub">The policy pays the call centre per patient outcome. None of it can be
      credited from what NRS holds, and each row says which specific thing is missing rather
      than showing a zero that reads as "nobody earned anything".</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Tier</th><th class="n">Rate</th>
      <th class="n">Credited</th><th>Why not</th></tr></thead><tbody>
      <tr><td class="nm">NEW patient · invoiced</td><td class="n">30</td><td class="n">0</td>
        <td class="sub" style="margin:0">Odoo's new-patient flag overstated new patients by ~44% in June:
          deleted historical invoices make a returning patient look new. NRS decides new-versus-returning
          from first invoice in the cache instead, but the cache starts 2026-01-01, so anyone whose first
          visit predates that is unprovable. See the Patients report.</td></tr>
      <tr><td class="nm">Reactivated · 6&ndash;12 months</td><td class="n">15</td><td class="n">0</td>
        <td class="sub" style="margin:0">Needs invoice history back to 2023 plus mobile de-duplication.
          NRS holds 2026 only.</td></tr>
      <tr><td class="nm">Reactivated · 1&ndash;2 years</td><td class="n">10</td><td class="n">0</td>
        <td class="sub" style="margin:0">Same gap, further back.</td></tr>
      <tr><td class="nm">Per-agent attribution</td><td class="n">&mdash;</td><td class="n">0</td>
        <td class="sub" style="margin:0">Every call-centre booking is entered under one shared login, so
          <code>create_uid</code> identifies the desk and never a person. The bonus is per agent, so it
          cannot be split from this field at all — not a history problem, a design one.</td></tr>
    </tbody></table></div>
    <div class="tg-note" style="border-left:3px solid #c98a2e"><strong>Nothing above is a zero
      you can act on.</strong> Three rows need history NRS does not have; the fourth needs a
      field Odoo does not populate per person. Crediting any of them would be inventing numbers.</div>`;

  return `${h}</section>`;
}


/* ---------------------------------------------------------- 06 simulator --- */

/* The simulator does NOT re-implement the policy. It posts a collection figure to
   /api/targets-simulate, which runs `commission-rules.branchMonth` — the same
   function that scores the real month — and draws whatever comes back. An earlier
   draft of this panel scored it in the browser; that is a second copy of the
   ladder, the bands and the multiplier cap, and it would disagree with the
   tracker beside it the first time a tier was edited in Admin. */

let SIMRUN = null;

/**
 * Score a what-if and redraw the gates panel around it.
 *
 * It repaints the WHOLE panel rather than the simulator alone, because the
 * simulator sits under the payout rules it is exercising and re-rendering only
 * half would leave the two describing different branches.
 */
async function runSim(T) {
  const rows = T.branches.filter(inScope);
  if (!SIM.branch || !rows.some((b) => b.name === SIM.branch)) {
    const first = rows[0];
    if (!first) return;
    SIM.branch = first.name;
    SIM.net = Math.round(first.net);
  }
  const br = rows.find((b) => b.name === SIM.branch);
  const q = new URLSearchParams({
    branchId: br.branchId, year: T.year, month: T.month,
    net: Math.max(0, Math.round(Number(SIM.net) || 0)),
    mults: Object.keys(SIM.mult).filter((k) => SIM.mult[k]).join(','),
  });
  try {
    SIMRUN = await api(`/api/targets-simulate?${q}`);
    renderGates(T);
  } catch (e) {
    $('gates').innerHTML = payoutSection(T)
      + `<section><h3 class="subtitle">Could not score that</h3>
         <p class="sub">${esc(e.message)}</p></section>`;
  }
}


/**
 * The simulator's controls.
 *
 * Wired from OUTSIDE `simSection` so the panel can be redrawn without binding
 * a second listener to every control each time — the shape that turns one
 * keystroke into four requests after four redraws.
 */
function wireSim(T) {
  const rows = T.branches.filter(inScope);
  const br = rows.find((b) => b.name === SIM.branch);
  if (!br) return;
  const nb = $('simBranch');
  if (nb) nb.addEventListener('change', () => { SIM.branch = nb.value; SIM.net = null; runSim(T); });
  const nn = $('simNet');
  if (nn) nn.addEventListener('change', () => { SIM.net = nn.value; runSim(T); });
  const rb = $('simReset');
  if (rb) rb.addEventListener('click', () => { SIM.net = Math.round(br.net); runSim(T); });
  document.querySelectorAll('#gates [data-mult]').forEach((cb) => cb.addEventListener('change', () => {
    SIM.mult[cb.dataset.mult] = cb.checked; runSim(T);
  }));
}


/**
 * The sheet's own branch targets — Target 1 and Target 2.
 *
 * THESE HAVE NEVER BEEN SHOWN ANYWHERE. `src/lib/targets.js` has always scored
 * them and returned them in the payload, and no page drew them: Mina typed
 * figures into the sheet editor's Branches section and then looked at this
 * report, which reads a completely different table. That is the confusion this
 * section exists to end.
 *
 * They are NOT the commission targets in the table below. The sheet's branch
 * figures are invoiced revenue; the commission targets are collected cash. Two
 * agreements, two bases, shown one above the other with the difference stated
 * rather than left to be discovered.
 */
function sheetBranchSection() {
  const T = DATA && DATA.targets;
  if (!T || T.missing || !T.branches || !T.branches.length) {
    return `<h3 class="subtitle">Branch targets on the approved sheet</h3>
      <div class="tg-note">${!T || T.missing
    ? `No target sheet for ${esc((T && T.period) || 'this month')}, so it carries no branch figures.`
    : 'The sheet for this month carries no branch targets.'}</div>`;
  }

  const rows = T.branches;
  const t1 = rows.reduce((s2, b) => s2 + (b.target1 || 0), 0);
  const t2 = rows.reduce((s2, b) => s2 + (b.target2 || 0), 0);
  const ach = rows.reduce((s2, b) => s2 + (b.mtdEx || 0), 0);

  return `<h3 class="subtitle">Branch targets on the approved sheet
      <span class="vat-tag">Invoiced ex-VAT</span></h3>
    <div class="tg-note"><strong>A different agreement from the table above.</strong>
      These come from the monthly sheet published in <a href="/admin">Admin → Periods</a> and are
      measured on <strong>invoiced revenue</strong>. The commission table above measures
      <strong>collected cash</strong> against its own targets. The two are not expected to match,
      and neither is wrong.
      <br>Daily figures come from <strong>Target 1</strong>; Target 2 is a parallel slab scored
      against the same actual.</div>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Branch</th><th class="n">Target 1</th><th class="n">vs T1</th>
      <th class="n">Target 2</th><th class="n">vs T2</th>
      <th class="n">Invoiced ex-VAT</th><th class="n">Per day</th>
    </tr></thead><tbody>${rows.map((b) => `<tr>
      <td class="nm">${esc(b.name)}${b.matched === false
    ? ' <span class="pill" style="background:rgba(201,138,46,.14);color:#c98a2e">no invoices</span>' : ''}</td>
      <td class="n">${fmt(b.target1)}</td>
      <td class="n">${b.target1 ? `<b class="${esc(b.tone1 || '')}">${((b.mtdEx / b.target1) * 100).toFixed(1)}%</b>` : '—'}</td>
      <td class="n">${b.target2 ? fmt(b.target2) : '—'}</td>
      <td class="n">${b.target2 ? `<b class="${esc(b.tone2 || '')}">${((b.mtdEx / b.target2) * 100).toFixed(1)}%</b>` : '—'}</td>
      <td class="n"><strong>${fmt(b.mtdEx)}</strong></td>
      <td class="n">${fmt(b.perDay1 || (b.target1 ? Math.round(b.target1 / (T.daysInPeriod || 30)) : 0))}</td>
    </tr>`).join('')}</tbody>
      <tfoot><tr><th>Total</th><th class="n">${fmt(t1)}</th>
        <th class="n">${t1 ? `${((ach / t1) * 100).toFixed(1)}%` : '—'}</th>
        <th class="n">${fmt(t2)}</th>
        <th class="n">${t2 ? `${((ach / t2) * 100).toFixed(1)}%` : '—'}</th>
        <th class="n">${fmt(ach)}</th><th class="n"></th></tr></tfoot></table></div>`;
}

/* ------------------------------------------------- 05 · management gates --- */

/** The payout rules, and the simulator that exercises them, in one panel. */
function renderGates(T) {
  const rows = T.branches.filter(inScope);
  const br = rows.find((b) => b.name === SIM.branch);
  $('gates').innerHTML = payoutSection(T) + (SIMRUN && br ? simSection(T, br) : '');
  wireSim(T);
}

function simSection(T, br) {
  const r = SIMRUN;
  const rows = T.branches.filter(inScope);
  const actual = Math.round(br.net);

  let h = `<section><div class="kicker">06 — Simulator</div>
    <h2 class="title">What would that <em>pay</em></h2>
    <p class="sub">Pick a branch, type a net collection ex-VAT, and policy
      <strong>${esc(r.policyVersion || '—')}</strong> runs on it server-side: band, ladder tier,
      base pool, multipliers, the &times;${r.multiplierCap.toFixed(2)} cap and the per-title split.
      It opens on the branch's real figure for ${esc(T.from)} → ${esc(T.to)}, so the first thing you
      see is what the range has actually produced.</p>

    <div class="tg-tools">
      <select class="tg-sort" id="simBranch">
        ${rows.map((b) => `<option value="${esc(b.name)}"${b.name === SIM.branch ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
      </select>
      <label class="fld">Net collection ex-VAT
        <input type="number" id="simNet" value="${Math.round(Number(SIM.net) || 0)}" step="50000" min="0"></label>
      <button class="btn ghost" id="simReset">Load actual (${fmt(actual)})</button>
    </div>
    <div class="tg-tools" style="margin-top:6px">
      ${r.departments.map((dp) => `<label class="tg-flat"><input type="checkbox" data-mult="${esc(dp.key)}"${SIM.mult[dp.key] ? ' checked' : ''}> ${esc(dp.label)} &times;${dp.multiplier}</label>`).join('')}
    </div>

    <div class="tg-sum">
      <div class="tg-s"><div class="l">Achievement</div><div class="p">${pc(r.achievement)}</div>
        <div class="n">${fmt(r.net)}<br>of ${fmt(r.target)} target</div>
        <div class="b"><i style="width:${Math.min(100, r.achievement * 100).toFixed(1)}%"></i>
          <u style="left:${(r.bands.floor * 100).toFixed(0)}%"></u></div></div>
      <div class="tg-s"><div class="l">Band</div><div class="p">${esc(r.band === 'zero' ? 'none' : r.band)}</div>
        <div class="n">${esc(r.bandLabel || '')}<br>floor ${pc(r.bands.floor, 0)} · mid ${pc(r.bands.mid, 0)} · max ${pc(r.bands.max, 0)}</div></div>
      <div class="tg-s"><div class="l">Ladder tier</div><div class="p">${r.tierNo || '—'}</div>
        <div class="n">${esc(r.tierLabel || '—')}<br>base pool ${fmt(r.basePool)}</div></div>
      <div class="tg-s inj"><div class="l">Final pool</div><div class="p">${fmt(r.pool)}</div>
        <div class="n">${r.multiplier && r.multiplier.applied > 1
    ? `&times;${r.multiplier.applied.toFixed(2)} applied${r.multiplier.capped ? ` <b class="r">(capped from &times;${r.multiplier.raw.toFixed(3)})</b>` : ''}`
    : 'no multiplier'}</div></div>
    </div>`;

  if (r.band === 'zero') {
    const need = r.target * r.bands.floor;
    h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>Nothing is payable at
      ${pc(r.achievement)}.</strong> ${pc(r.bands.floor, 0)} of target is the first paying point under
      ${esc(r.policyVersion || 'this policy')}, which needs ${fmt(need)} — a further
      ${fmt(Math.max(0, need - r.net))}. Multipliers do not apply below the band, so ticking them
      changes nothing here.</div>`;
  } else if (!r.basePool) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>The band is met but the
      ladder rung pays nothing.</strong> ${esc(r.tierLabel || 'This rung')} carries a zero pool in all
      three bands — the policy's own floor for small collections. Raise the figure to the next rung to
      see a pool.</div>`;
  }

  if (r.roles && r.roles.length && r.pool) {
    h += `<h3 class="subtitle">Per-title split</h3>
      <div class="tw"><table class="ltab"><thead><tr><th>Role</th><th class="n">Share</th><th class="n">Amount</th></tr></thead><tbody>
        ${r.roles.map((x) => `<tr><td class="nm">${esc(x.name || x.role)}</td><td class="n">${pc(x.sharePct || x.share, 0)}</td><td class="n">${fmt(x.amount)}</td></tr>`).join('')}
      </tbody><tfoot><tr><th>Total</th><th class="n">100%</th><th class="n">${fmt(r.roles.reduce((a, x) => a + x.amount, 0))}</th></tr></tfoot></table></div>`;
  }

  h += `<div class="tg-note">Scored by the same code as the real month, against
    ${esc(String(T.year))}-${String(T.month).padStart(2, '0')}'s stored target. Edit the ladder, the
    bands or the split in Admin and this moves with them.</div></section>`;
  return h;

  /* Re-bind after each repaint, since the panel is replaced wholesale. */
}



/* ----------------------------------------------------------------- load --- */

function paint() {
  const T = DATA;
  const rows = T.branches.filter(inScope);
  $('hPeriod').textContent = `${T.from} → ${T.to}`;
  $('hNet').textContent = fmt(rows.reduce((s, b) => s + b.net, 0));
  const prorata = rows.reduce((s, b) => s + (b.prorata || 0), 0);
  $('hPace').textContent = pc(prorata ? rows.reduce((s, b) => s + b.net, 0) / prorata : 0);
  /* PAYABLE, not projected. The run-rate count and the projected pool are real
     and useful, but they belong on the Pacing panel where each is labelled a
     forecast — in the header they would read as money already earned. Mid-month
     both of these are zero, and that is the correct headline. */
  const withTarget = rows.filter((b) => b.target);
  $('hQual').textContent = `${withTarget.filter((b) => b.achievement >= T.policy.bands.floor).length} / ${withTarget.length}`;
  $('hQualU').textContent = T.closed ? 'on the closed month' : `nothing can reach ${pc(T.policy.bands.floor, 0)} on day ${T.daysElapsed}`;
  $('hPool').textContent = fmt(rows.reduce((s, b) => s + b.now.pool, 0));
  $('hPoolU').textContent = T.closed ? 'EGP · payable' : 'EGP · nothing payable mid-month';
  $('rangeline').innerHTML = `<strong>${T.closed ? 'closed' : `day ${T.daysElapsed} of ${T.daysInMonth}`}</strong>
    · policy <strong>${esc(T.policy.version || '—')}</strong> · eligibility <strong>${pc(T.policy.bands.floor, 0)}</strong>
    · base <strong>net collection ex-VAT</strong> · source <strong>${esc(T.source)}</strong>
    · ${fmt(T.totals.txns)} payments${T.unmatched.length ? ` · <span style="color:#b0503c">${T.unmatched.length} branch(es) unmatched</span>` : ''}`;
  /* Two banners that decide how everything below should be read.

     The first: a range spanning months is a SUM of months, not one long month.
     The second, and the more dangerous one: for any range before the Odoo 18
     cutover the cash exists but carries no branch_id, so every per-branch figure
     collapses toward zero while the money was really collected. Without this the
     report shows June as eleven branches at 0.1% of target. */
  let banner = '';
  const R2 = T.range;
  if (R2 && R2.multi) {
    banner += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${R2.totals.monthsCovered} months in this range, scored separately.</strong>
      A branch is measured against one month's target, so the pools below are each month's
      pool added together — not one comparison of pooled cash against a pooled target, which
      would let a strong month carry a failing one into a band it never reached.
      ${R2.totals.partialMonths ? `${R2.totals.partialMonths} month${R2.totals.partialMonths === 1 ? ' is' : 's are'} clipped by the range and measured against the FULL month target, so ${R2.totals.partialMonths === 1 ? 'it' : 'they'} will read as behind.` : ''}
      <div class="tw" style="margin-top:10px"><table class="ltab tight"><thead><tr><th>Month</th>
        <th class="n">Covers</th><th class="n">Collected ex-VAT</th><th class="n">Target</th>
        <th class="n">Achievement</th><th class="n">Qualifying</th><th class="n">Pool</th></tr></thead><tbody>
        ${R2.months.map((m) => {
    const qual = m.branches.filter((b) => b[m.closed ? 'now' : 'run'].band !== 'zero').length;
    const pool = m.branches.reduce((a, b) => a + b[m.closed ? 'now' : 'run'].pool, 0);
    return `<tr><td class="nm">${esc(m.key)}${m.partial ? ' <span class="sm2">partial</span>' : ''}</td>
          <td class="n">${esc(m.coversFrom.slice(8))}–${esc(m.coversTo.slice(8))}</td>
          <td class="n">${fmt(m.totals.net)}</td><td class="n">${fmt(m.totals.target)}</td>
          <td class="n">${pc(m.totals.achievement)}</td>
          <td class="n">${qual} / ${m.branches.length}</td><td class="n">${fmt(pool)}</td></tr>`;
  }).join('')}
      </tbody><tfoot><tr><th>Range</th><th class="n"></th><th class="n">${fmt(R2.totals.net)}</th>
        <th class="n">${fmt(R2.totals.target)}</th>
        <th class="n">${pc(R2.totals.target ? R2.totals.net / R2.totals.target : 0)}</th>
        <th class="n"></th><th class="n">${fmt(R2.totals.pool)}</th></tr></tfoot></table></div>
      <p class="sub" style="margin-top:8px">The panels below show
        <strong>${esc(T.from)} → ${esc(T.to)}</strong>, the last month in the range.</p></div>`;
  }

  const U = T.unattributed;
  if (U && U.share > 0.02) {
    const blocking = !T.branchScoringPossible;
    banner += `<div class="tg-note" style="border-left:3px solid ${blocking ? '#b0503c' : '#c98a2e'}">
      <strong>${fmt(U.net)} of collected cash has no branch — ${pc(U.share)} of this range.</strong>
      Odoo 18 went live 2026-08-01 and payments migrated from the old system carry no
      <code>branch_id</code>.
      ${blocking
    ? 'Per-branch scoring is <strong>not possible</strong> for this range: the money was really collected, but it cannot be attributed, so every branch below reads as near-zero against target. Those are not failing branches — they are unattributable months. Pick a range from August onward to score branches.'
    : 'The branch split below is materially complete; this residue is filed as Unassigned.'}</div>`;
  }

  /* Tabs 01, 02 and 04 read the target sheet and the doctor commission; tabs 03
     and 05 read the branch commission this route was always built for. Both
     payloads arrive in one response so the two halves cannot describe different
     months. */
  renderTVA();
  renderDocTargets();
  renderCommission();

  /* Banners belong at the top of the branch panel: they qualify the branch
     figures, not the doctor ones. */
  $('br').innerHTML = banner + paceSection(T) + trackerSection(T) + sheetBranchSection();
  renderGates(T);
  runSim(T).catch(() => {});
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    if (new URLSearchParams(location.search).get('versions') === '1') q.set('versions', '1');
    DATA = await api(`/api/targets-tracker?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${DATA.policy.version || 'policy'} · ${DATA.source}`;
  } catch (e) {
    $('dot').className = 'dot bad';
    $('status').textContent = 'failed';
    $('err').textContent = e.message;
  }
}

/* Targets are monthly, so the presets stay inside one month — a range spanning
   two would have no single target to measure against, and the API refuses it. */
const iso = (d) => d.toISOString().slice(0, 10);
/* Any range. The earlier version of this report refused anything spanning two
   months, because commission is scored against ONE month's target — a correct
   instinct built as a wall. The range is now sliced into months server-side,
   each scored against its own target, and the pools added the way payroll adds
   them, so a quarter or a year is a legitimate question again. */
function preset(p) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (p === 'lastmonth') {
    $('from').value = iso(new Date(Date.UTC(y, m - 1, 1)));
    $('to').value = iso(new Date(Date.UTC(y, m, 0)));
  } else if (p === 'quarter') {
    $('from').value = iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)));
    $('to').value = iso(now);
  } else if (p === 'ytd') {
    $('from').value = `${y}-01-01`;
    $('to').value = iso(now);
  } else {
    $('from').value = `${iso(now).slice(0, 7)}-01`; $('to').value = iso(now);
  }
}

document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
  preset(b.dataset.p); load();
}));
/* The mix filter lives inside a panel that is replaced wholesale on every
   repaint, so it is delegated from the document rather than bound to the node. */
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'mixBranch') {
    MIXBRANCH = e.target.value;
    if (DATA) { renderTracker(DATA); }
  }
});
/* The payslip, the CSV and the modal. Delegated, because tab 04 is rebuilt on
   every range change and its rows come from the payload rather than a fixed
   list here. */
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;

  const slip = e.target.closest('[data-slip]');
  if (slip) { openPayslip(slip.dataset.slip); return; }

  if (e.target.id === 'comCsv') { commissionCsv(); return; }

  /* Clicking the backdrop closes; clicking inside the card does not. */
  if (e.target.id === 'dlg') $('dlg').hidden = true;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('dlg').hidden) $('dlg').hidden = true;
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.classList) return;
  if (!el.classList.contains('searchbox') && !el.classList.contains('search-input')) return;
  const q = el.value.toLowerCase().trim();
  const panel = el.closest('.panel');
  if (!panel) return;
  panel.querySelectorAll('[data-search-target]').forEach((n) => {
    n.style.display = !q || n.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});


document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#scope button').forEach((x) => x.classList.toggle('on', x === b));
  SCOPE = b.dataset.scope;
  if (DATA) paint();
}));
$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
