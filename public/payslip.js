/* ============================================================
   The doctor payslip — one renderer, soon two panels.

   It is built on screen and written to a file from the SAME string, because a
   payslip that renders one way and downloads another is two documents with one
   name. `html()` returns markup and touches nothing; `open()` puts it in the
   dialog the NRS import already uses, so the shell, the backdrop click and the
   Escape key come for free; `download()` wraps the identical markup in a
   self-contained HTML document.

   WHY A FILE AND NOT A PDF. Generating a real PDF needs a library the CSP would
   have to allow. An HTML document opens in any browser, prints to PDF from
   there, and can be mailed as it is.

   WHAT IT REFUSES. A doctor with no payroll month gets the commission and a
   sentence saying the salary build-up is unavailable — never a build-up of
   zeros, which would read as "earned nothing" rather than "we do not know yet".

   `open()` and `download()` take an explicit DOM, like `target-view.js`: this
   file is a <script> in the browser and a `require` under the test harness,
   where it is evaluated outside the vm sandbox and has no `document` at all.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Payslip = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, esc } = F;

  function html(r, period) {
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

  /**
   * Draw one person's payslip into the shared dialog.
   *
   * Takes the ROWS rather than reaching for a page-level `DATA`, so the two
   * panels that will call this — Doctors and Staff — share one function
   * instead of each keeping a copy wired to its own state.
   */
  function open(rows, period, name, dom) {
    const d = dom || (typeof document === 'undefined' ? null : document);
    if (!d || !rows) return null;
    const r = rows.find((x) => x.name === name);
    if (!r) return null;
    const $ = (id) => d.getElementById(id);

    $('dlgTitle').textContent = `Payslip — ${r.name}`;
    $('dlgBody').innerHTML = html(r, period);
    $('dlgActions').innerHTML = `
    <button class="btn" id="psPrintBtn">Print / save as PDF</button>
    <button class="btn ghost" id="psDownBtn">Download payslip</button>
    <button class="btn ghost" id="psCloseBtn">Close</button>`;
    $('dlg').hidden = false;

    $('psPrintBtn').addEventListener('click', () => window.print());
    $('psDownBtn').addEventListener('click', () => download(r, period, d));
    $('psCloseBtn').addEventListener('click', () => { $('dlg').hidden = true; });
    return r;
  }

  function download(r, period, dom) {
    const d = dom || document;
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
      <body>${html(r, period)}
      <div class="foot">Nouvelage · generated ${new Date().toLocaleString('en-GB')} ·
        revenue ex-package ex-VAT from the Odoo cache; hours, deductions and withholding from the
        monthly payroll file.</div></body></html>`;

    const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = Object.assign(d.createElement('a'), {
      href, download: `payslip-${String(r.name).replace(/[^\w]+/g, '-')}-${period}.html`,
    });
    d.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  return { html, open, download };
});
