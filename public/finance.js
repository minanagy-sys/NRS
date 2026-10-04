/* ============================================================
   Nouvelage finance — page.

   Four sections, all arriving scored from /api/finance. Every verdict, bucket,
   availability group and gap cause is decided on the server by
   lib/finance-rules.js, so this file only draws. There is deliberately no copy
   of those rules here.
   ============================================================ */

/* From public/fmt.js — one copy of these for every page. They had drifted
   apart by 2026-10-04 (two `pc`, two `esc`); see that file. */
const { $, fmt, escAll: esc } = Fmt;
const pct = (a, b) => (!b ? 0 : (a / b) * 100);
const { iso } = Rules;

let DATA = null;

const shortDate = (s) => new Date(s + 'T00:00:00')
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const weekday = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });

function setStatus(text, state) {
  $('status').textContent = text;
  $('dot').className = 'dot' + (state ? ' ' + state : '');
}

const tw = (inner) => `<div class="tw"><table class="ltab">${inner}</table></div>`;
const heads = (cols) => `<thead><tr>${cols.map((c, i) =>
  `<th${i ? ' class="n"' : ''}>${c}</th>`).join('')}</tr></thead>`;

/** A source banner, so a figure is never read without knowing where it came from. */
function sourceNote(section) {
  const s = DATA.meta.sources[section];
  const batch = DATA.meta.batches.find((b) => b.section === section && b.source === (s.mode === 'odoo' ? 'odoo' : 'snapshot'));
  if (!s) return '';
  if (s.mode === 'stitched') {
    return `<div class="fnote seam"><strong>Two systems, one table.</strong> Everything before
      <strong>${esc(s.cutover)}</strong> comes from the imported extract of the old system; from that date
      onward it comes from Odoo 18, which went live then. The seam is real — treat a figure that
      spans it with care.</div>`;
  }
  const label = s.mode === 'odoo' ? 'Live from Odoo' : 'Imported snapshot';
  const when = batch ? ` · as of ${esc(batch.asOf)} · ${fmt(batch.rowCount)} rows` : '';
  return `<div class="fnote">${label}${when}. Change this under <a href="/admin#sources">Data sources</a>.</div>`;
}

/* ---- 01 collections ---------------------------------------------------- */

function renderCollections(C) {
  if (!C || !C.days.length) return empty('collections', 'No collections data for this range.');
  const days = C.days.map((d) => d.date);
  const regs = C.registers.map((r) => r.name);

  let h = `<section>
    <div class="kicker">01 — Collections</div>
    <h2 class="title">Net customer receipts</h2>
    <p class="sub">Posted customer receipts allocated to the branch, register and date on each voucher.
      Figures are <strong>net</strong> — inbound receipts minus customer refunds. Inter-register
      transfers are excluded. The <strong>◆ package</strong> figure is the share OF the net settled
      against package-sale invoices, not an addition to it.</p>
    ${sourceNote('collections')}
    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Net collections</div><div class="kpi-value">${fmt(C.totals.net)}<span class="kpi-unit">EGP</span></div><div class="kpi-sub">${C.totals.branches} branches · gross <strong>${fmt(C.totals.gross)}</strong></div></div>
      <div class="kpi"><div class="kpi-label">Refunds</div><div class="kpi-value sm">${fmt(C.totals.refunds)}</div><div class="kpi-sub">already deducted above</div></div>
      <div class="kpi"><div class="kpi-label">◆ Packages</div><div class="kpi-value sm">${fmt(C.totals.packageShare)}</div><div class="kpi-sub">${pct(C.totals.packageShare, C.totals.net).toFixed(1)}% of net</div></div>
      <div class="kpi"><div class="kpi-label">Receipts</div><div class="kpi-value sm">${fmt(C.totals.txns)}</div><div class="kpi-sub">avg <strong>${fmt(C.totals.txns ? C.totals.net / C.totals.txns : 0)}</strong></div></div>
    </div>`;

  /* When the money is actually usable — a different question from which register
     took it, and the one that matters for cash planning. */
  h += `<h3 class="subtitle">When the funds land</h3><div class="fav">`;
  for (const g of C.availability) {
    h += `<div class="fav-c"><div class="t">${esc(g.label)}</div><div class="d">${g.registers.map(esc).join(' · ') || '—'}</div>
      <div class="v">${fmt(g.net)}</div><div class="s">${pct(g.net, C.totals.net).toFixed(1)}% of net</div></div>`;
  }
  h += `</div>`;
  if (C.unclassified.length) {
    h += `<div class="fnote warn"><strong>${C.unclassified.length} register${C.unclassified.length === 1 ? '' : 's'} not classified</strong>
      — ${C.unclassified.map(esc).join(', ')}. Their money is in the totals but in none of the groups above,
      because nobody has said when it becomes available.</div>`;
  }

  /* Each day opens onto the branches behind it. The company summary answers
     "how big was the day"; the row underneath answers "who made it", which is
     the next question every time. */
  h += `<h3 class="subtitle">Company daily summary</h3>
    <p class="sub">Tap a day to see the branches behind it.</p>` + tw(
    heads(['Day', 'Gross', 'Refunds', 'Net', '◆ Packages', 'Receipts'])
    + `<tbody>${C.days.map((d) => `<tr class="dayrow" data-opens="day:${esc(d.date)}">
        <td><div class="nm"><span class="car">▸</span> ${shortDate(d.date)}</div><div class="sm2">${weekday(d.date)}</div></td>
        <td class="n">${fmt(d.gross)}</td>
        <td class="n${d.refunds ? ' neg' : ' z'}">${d.refunds ? fmt(d.refunds) : '—'}</td>
        <td class="n"><strong>${fmt(d.net)}</strong></td>
        <td class="n pk">${d.packageShare ? '◆ ' + fmt(d.packageShare) : '—'}</td>
        <td class="n">${fmt(d.txns)}</td></tr>
      <tr class="drill" data-drill="day:${esc(d.date)}" hidden><td colspan="6">${dayByBranch(C, d)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="n">${fmt(C.totals.gross)}</td>
        <td class="n neg">${fmt(C.totals.refunds)}</td><td class="n"><strong>${fmt(C.totals.net)}</strong></td>
        <td class="n pk">◆ ${fmt(C.totals.packageShare)}</td><td class="n">${fmt(C.totals.txns)}</td></tr></tbody>`);

  /* The grid reads by funds availability, not by register size: the columns are
     banded into T+0 / T+1 / on settlement, and a band earns a subtotal column
     only when it holds more than one register — a single-register band would
     just repeat itself. */
  const bands = C.availability
    .map((g) => ({ ...g, subtotal: g.registers.length > 1 }))
    .filter((g) => g.registers.length);
  const cellOf = (row, r) => row[r] || null;
  const bandNet = (row, g) => g.registers.reduce((s, r) => s + ((row[r] || {}).net || 0), 0);

  const groupBand = `<tr class="cgrp"><th class="blank"></th>${bands.map((g) =>
    `<th colspan="${g.registers.length + (g.subtotal ? 1 : 0)}">${esc(g.label)}</th>`).join('')}<th class="blank" colspan="2"></th></tr>`;
  const registerHead = `<tr><th>Day</th>${bands.map((g) =>
    g.registers.map((r) => `<th class="n">${esc(r)}</th>`).join('')
    + (g.subtotal ? `<th class="n st">${g.key === 't0' ? 'T+0' : g.key === 't1' ? 'T+1' : 'Settl.'} total</th>` : '')).join('')
    }<th class="n">Day net</th><th class="n">◆ Packages</th></tr>`;

  h += `<h3 class="subtitle">Day × register — all branches</h3>
    <p class="sub">“Cash” merges the ${C.totals.branches} branch cash registers. Figures are net of refunds
      (shown in red). <strong>◆</strong> is the package-sale share within the amount. Tinted columns are
      band subtotals.</p>` + tw(
    `<thead>${groupBand}${registerHead}</thead>`
    + `<tbody>${days.map((d) => {
      const row = C.byDayRegister[d] || {};
      const day = C.days.find((x) => x.date === d) || { net: 0, packageShare: 0 };
      return `<tr><td><div class="nm">${shortDate(d)}</div><div class="sm2">${weekday(d)}</div></td>${
        bands.map((g) => g.registers.map((r) => {
          const c = cellOf(row, r);
          if (!c || (!c.net && !c.refunds)) return `<td class="n"><span class="z">—</span></td>`;
          return `<td class="n">${fmt(c.net)}`
            + (c.refunds ? `<span class="rfl">− ${fmt(c.refunds)} refund</span>` : '')
            + (c.pkg ? `<span class="pkl">◆ ${fmt(c.pkg)}</span>` : '') + `</td>`;
        }).join('') + (g.subtotal ? `<td class="n st"><strong>${bandNet(row, g) ? fmt(bandNet(row, g)) : '—'}</strong></td>` : '')).join('')
      }<td class="n"><strong>${fmt(day.net)}</strong></td>
        <td class="n pk">${day.packageShare ? '◆ ' + fmt(day.packageShare) : '<span class="z">—</span>'}</td></tr>`;
    }).join('')}
      <tr class="tot"><td>Total</td>${
        bands.map((g) => g.registers.map((r) => {
          const reg = C.registers.find((x) => x.name === r);
          return `<td class="n">${fmt(reg ? reg.net : 0)}</td>`;
        }).join('') + (g.subtotal ? `<td class="n st"><strong>${fmt(g.net)}</strong></td>` : '')).join('')
      }<td class="n"><strong>${fmt(C.totals.net)}</strong></td>
        <td class="n pk">◆ ${fmt(C.totals.packageShare)}</td></tr></tbody>`);

  h += `<h3 class="subtitle">Branch ranking</h3>${bars(C.branches, C.totals.net,
    (b) => `${pct(b.net, C.totals.net).toFixed(1)}% of net${b.pkg ? ` · ◆ ${fmt(b.pkg)} packages` : ''}`)}`;

  h += `<h3 class="subtitle">Branch detail — day × register</h3>
    <input class="searchbox" id="colSearch" placeholder="Search branch…">`;
  for (const b of C.perBranch) {
    /* Only the registers this branch actually uses, still in band order. A band
       here earns a subtotal on the same rule as the grid above — more than one
       active register — so a branch on cash alone gets no redundant column. */
    const own = bands
      .map((g) => ({ ...g, registers: g.registers.filter((r) => Object.values(b.days).some((d) => d[r] && (d[r].net || d[r].refunds))) }))
      .filter((g) => g.registers.length)
      .map((g) => ({ ...g, subtotal: g.registers.length > 1 }));
    const active = own.flatMap((g) => g.registers);
    const total = Object.values(b.days).reduce((s, d) => s + active.reduce((a, r) => a + ((d[r] || {}).net || 0), 0), 0);
    const pkg = Object.values(b.days).reduce((s, d) => s + active.reduce((a, r) => a + ((d[r] || {}).pkg || 0), 0), 0);
    const refunds = Object.values(b.days).reduce((s, d) => s + active.reduce((a, r) => a + ((d[r] || {}).refunds || 0), 0), 0);

    h += `<div class="acc" data-acc data-search-target><div class="acc-h"><span class="car">▸</span>
      <div><div class="acc-name">${esc(b.name)}</div><div class="acc-meta">${active.length} register${active.length === 1 ? '' : 's'} · ${pct(total, C.totals.net).toFixed(1)}% of net${pkg ? ` · ◆ ${fmt(pkg)} packages` : ''}${refunds ? ` · <span class="r">${fmt(refunds)} refunded</span>` : ''}</div></div>
      <div class="cv"><b>${fmt(total)}</b><small>net EGP</small></div></div>
      <div class="acc-b"><div style="padding:10px 14px 14px">` + tw(
      `<thead><tr class="cgrp"><th class="blank"></th>${own.map((g) =>
        `<th colspan="${g.registers.length + (g.subtotal ? 1 : 0)}">${esc(g.label)}</th>`).join('')}<th class="blank"></th></tr>
        <tr><th>Day</th>${own.map((g) => g.registers.map((r) => `<th class="n">${esc(r)}</th>`).join('')
        + (g.subtotal ? `<th class="n st">${g.key === 't0' ? 'T+0' : g.key === 't1' ? 'T+1' : 'Settl.'} total</th>` : '')).join('')}<th class="n">Net</th></tr></thead>`
      + `<tbody>${days.map((d) => {
        const row = b.days[d] || {};
        const net = active.reduce((s, r) => s + ((row[r] || {}).net || 0), 0);
        if (!net) return '';
        return `<tr><td><div class="nm">${shortDate(d)}</div><div class="sm2">${weekday(d)}</div></td>${
          own.map((g) => {
            const sub = g.registers.reduce((s, r) => s + ((row[r] || {}).net || 0), 0);
            return g.registers.map((r) => {
              const c = row[r];
              if (!c || (!c.net && !c.refunds)) return '<td class="n"><span class="z">—</span></td>';
              return `<td class="n">${fmt(c.net)}`
                + (c.refunds ? `<span class="rfl">− ${fmt(c.refunds)} refund</span>` : '')
                + (c.pkg ? `<span class="pkl">◆ ${fmt(c.pkg)}</span>` : '') + '</td>';
            }).join('') + (g.subtotal ? `<td class="n st"><strong>${sub ? fmt(sub) : '—'}</strong></td>` : '');
          }).join('')
        }<td class="n"><strong>${fmt(net)}</strong></td></tr>`;
      }).join('')}</tbody>`) + `</div></div></div>`;
  }

  $('collections').innerHTML = h + `</section>`;
}

function bars(rows, total, meta) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.net !== undefined ? r.net : r.value)) || 1;
  return `<div class="bar-list">${rows.map((r) => {
    const v = r.net !== undefined ? r.net : r.value;
    return `<div class="bar-row"><div class="bar-top"><div><div class="bar-name">${esc(r.name)}</div>
      <div class="bar-meta">${meta(r)}</div></div><div class="bar-val">${fmt(v)}</div></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct(v, max).toFixed(1)}%"></div></div></div>`;
  }).join('')}</div>`;
}

const empty = (id, msg) => { $(id).innerHTML = `<section><p class="sub">${esc(msg)}</p></section>`; };

/**
 * One day, broken out by branch — what opens underneath a day row.
 *
 * Registers keep the same band order as the grid, and only the ones that
 * actually moved that day get a column. The footer share is a live check: the
 * branches must add up to the published day net, so anything other than 100%
 * means the two tables disagree.
 */
function dayByBranch(C, day) {
  const order = C.availability.flatMap((g) => g.registers);
  const rows = C.perBranch
    .map((b) => {
      const cells = b.days[day.date] || {};
      const at = (k) => order.reduce((s, r) => s + ((cells[r] || {})[k] || 0), 0);
      return { name: b.name, cells, net: at('net'), pkg: at('pkg'), refunds: at('refunds') };
    })
    .filter((r) => r.net || r.refunds)
    .sort((a, b) => b.net - a.net);

  if (!rows.length) return '<div class="drillbox"><p class="sub">Nothing was collected on this day.</p></div>';

  const cols = order.filter((r) => rows.some((x) => (x.cells[r] || {}).net || (x.cells[r] || {}).refunds));
  const colTotal = (c) => rows.reduce((s, r) => s + ((r.cells[c] || {}).net || 0), 0);
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);

  return '<div class="drillbox">' + tw(
    heads(['Branch', ...cols, 'Net', '◆ Packages', 'Share of day'])
    + `<tbody>${rows.map((r) => `<tr>
        <td class="nm">${esc(r.name)}</td>${cols.map((c) => {
      const cell = r.cells[c];
      if (!cell || (!cell.net && !cell.refunds)) return '<td class="n"><span class="z">—</span></td>';
      return `<td class="n">${fmt(cell.net)}`
        + (cell.refunds ? `<span class="rfl">− ${fmt(cell.refunds)} refund</span>` : '')
        + (cell.pkg ? `<span class="pkl">◆ ${fmt(cell.pkg)}</span>` : '') + '</td>';
    }).join('')}
        <td class="n"><strong>${fmt(r.net)}</strong></td>
        <td class="n pk">${r.pkg ? '◆ ' + fmt(r.pkg) : '<span class="z">—</span>'}</td>
        <td class="n">${pct(r.net, day.net).toFixed(1)}%</td></tr>`).join('')}
      <tr class="tot"><td>${rows.length} branch${rows.length === 1 ? '' : 'es'}</td>${
    cols.map((c) => `<td class="n">${fmt(colTotal(c))}</td>`).join('')}
        <td class="n"><strong>${fmt(sum('net'))}</strong></td>
        <td class="n pk">◆ ${fmt(sum('pkg'))}</td>
        <td class="n">${pct(sum('net'), day.net).toFixed(1)}%</td></tr></tbody>`) + '</div>';
}

/* ---- 02 payables ------------------------------------------------------- */

function renderPayables(P) {
  if (!P || !P.suppliers.length) return empty('payables', 'No payables data loaded.');
  const owe = P.totals.closing > 0;

  let h = `<section>
    <div class="kicker">02 — Payables</div>
    <h2 class="title">Suppliers, purchases and payments</h2>
    <p class="sub">A <strong>positive</strong> balance means we owe the supplier; negative means we are
      in debit with them — a prepayment or a rent advance.</p>
    ${sourceNote('payables')}
    <div class="fnote warn"><strong>Closing balances are extracted, not derived.</strong>
      <code>opening + purchases − payments</code> does not reconcile to them and is not supposed to:
      the balances come from the supplier ledger itself. Do not read the columns below as an equation.</div>
    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Closing balance</div><div class="kpi-value">${fmt(Math.abs(P.totals.closing))}<span class="kpi-unit">EGP</span></div><div class="kpi-sub">${owe ? 'we owe suppliers' : 'net debit · prepaid'}</div></div>
      <div class="kpi"><div class="kpi-label">Opening</div><div class="kpi-value sm">${fmt(Math.abs(P.totals.opening))}</div><div class="kpi-sub">${P.totals.opening > 0 ? 'owed' : 'prepaid'} at the start</div></div>
      <div class="kpi"><div class="kpi-label">Purchases</div><div class="kpi-value sm">${fmt(P.totals.bills)}</div><div class="kpi-sub">inc-VAT across the period</div></div>
      <div class="kpi"><div class="kpi-label">Payments</div><div class="kpi-value sm">${fmt(P.totals.payments)}</div><div class="kpi-sub">${P.totals.suppliers} suppliers</div></div>
    </div>`;

  h += `<h3 class="subtitle">Year on year</h3>` + tw(
    heads(['Year', 'Purchases inc-VAT', 'of which VAT', 'Payments', 'Net', '# Bills', '# Pays', '# Suppliers'])
    + `<tbody>${P.years.map((y) => `<tr>
        <td class="nm">${y.year}</td><td class="n">${fmt(y.gross)}</td><td class="n">${fmt(y.vat)}</td>
        <td class="n">${fmt(y.paid)}</td><td class="n"><strong>${fmt(y.gross - y.paid)}</strong></td>
        <td class="n">${fmt(y.bills)}</td><td class="n">${fmt(y.pays)}</td><td class="n">${fmt(y.vendors)}</td></tr>`).join('')}</tbody>`);

  const years = Object.keys(P.heatmap).sort();
  if (years.length) {
    h += `<h3 class="subtitle">Month by month</h3>
      <p class="sub">Purchases above, payments below, per month.</p><div class="heat">`;
    for (const y of years) {
      h += `<div class="heat-row"><div class="heat-y">${esc(y)}</div>`;
      for (const c of P.heatmap[y]) {
        const dead = !c.bills && !c.pays;
        h += `<div class="heat-c${dead ? ' dead' : ''}" title="${esc(y)}-${String(c.m).padStart(2, '0')}">
          <div class="m">${['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][c.m - 1]}</div>
          ${dead ? '' : `<div class="b">${fmt(c.bills / 1000)}k</div><div class="p">${fmt(c.pays / 1000)}k</div>`}</div>`;
      }
      h += `</div>`;
    }
    h += `</div>`;
  }

  h += `<h3 class="subtitle">Balance per supplier</h3>
    <input class="searchbox" id="supSearch" placeholder="Search supplier…">` + tw(
    heads(['Supplier', 'Opening', 'Purchases 2025', 'Payments 2025', 'Purchases 2026', 'Payments 2026', 'Closing'])
    + `<tbody>${P.suppliers.map((s) => `<tr data-search-target>
        <td><div class="nm">${esc(s.name)}</div><div class="sm2">${esc(s.category || '—')} · ${s.nbills} bills · ${s.npays} payments</div></td>
        <td class="n">${s.opening ? fmt(s.opening) : '<span class="z">—</span>'}</td>
        <td class="n">${s.bills25 ? fmt(s.bills25) : '<span class="z">—</span>'}</td>
        <td class="n neg">${s.pays25 ? fmt(s.pays25) : '<span class="z">—</span>'}</td>
        <td class="n">${s.bills26 ? fmt(s.bills26) : '<span class="z">—</span>'}</td>
        <td class="n neg">${s.pays26 ? fmt(s.pays26) : '<span class="z">—</span>'}</td>
        <td class="n"><strong class="${s.closing > 0.5 ? 'r' : s.closing < -0.5 ? 'g' : ''}">${fmt(s.closing)}</strong></td></tr>`).join('')}</tbody>`);

  h += `<h3 class="subtitle">Where the money goes</h3>${bars(P.categories.slice(0, 20), 0,
    (c) => `${c.products} product${c.products === 1 ? '' : 's'} · ${c.vendors} supplier${c.vendors === 1 ? '' : 's'}`)}`;

  h += `<h3 class="subtitle">Top 20 by spend</h3>` + tw(
    heads(['Product or account', 'Category', 'Paid qty', 'Bonus qty', 'Total EGP', '# Bills', '# Suppliers'])
    + `<tbody>${P.topProducts.map((p) => `<tr>
        <td class="nm">${esc(p.name)}</td><td>${esc(p.category || '—')}</td>
        <td class="n">${fmt(p.qtyPaid, 1)}</td><td class="n">${p.qtyBonus ? fmt(p.qtyBonus, 1) : '<span class="z">—</span>'}</td>
        <td class="n"><strong>${fmt(p.value)}</strong></td><td class="n">${fmt(p.bills)}</td><td class="n">${fmt(p.vendors)}</td></tr>`).join('')}</tbody>`);

  h += `<h3 class="subtitle">How suppliers were paid</h3>
    <p class="sub">The method is inferred from the journal each payment was posted to — it is not a field in
      Odoo. <strong>Adjustment</strong> is a journal reclassification, not cash leaving the business.</p>` + tw(
    heads(['Method', '# Payments', 'Total EGP', 'Share'])
    + `<tbody>${P.methods.map((m) => `<tr>
        <td class="nm">${esc(m.name)}</td><td class="n">${fmt(m.n)}</td>
        <td class="n"><strong>${fmt(m.amount)}</strong></td><td class="n">${m.share.toFixed(1)}%</td></tr>`).join('')}</tbody>`);

  if (P.bonusVendors.length) {
    h += `<h3 class="subtitle">Free units received</h3>
      <p class="sub">A bonus line is a real quantity carrying no money — a "buy 100 get 10" trade discount.
        Detected as quantity above zero with a subtotal of zero.</p>` + tw(
      heads(['Supplier', 'Category', 'Bills', 'Bonus units', 'Paid units', 'Bonus %'])
      + `<tbody>${P.bonusVendors.map((v) => `<tr>
          <td class="nm">${esc(v.name)}</td><td>${esc(v.category || '—')}</td>
          <td class="n">${fmt(v.bills)}</td><td class="n"><strong>${fmt(v.bonusQty, 1)}</strong></td>
          <td class="n">${fmt(v.paidQty, 1)}</td><td class="n">${v.ratio === null ? '—' : v.ratio.toFixed(1) + '%'}</td></tr>`).join('')}</tbody>`);

    h += `<h3 class="subtitle">Most-given free products</h3>` + tw(
      heads(['Product', 'Category', 'Supplier', 'Bonus qty', 'Paid qty', 'Ratio'])
      + `<tbody>${P.bonusProducts.map((p) => `<tr>
          <td class="nm">${esc(p.name)}</td><td>${esc(p.category || '—')}</td><td>${esc(p.supplier)}</td>
          <td class="n"><strong>${fmt(p.bonusQty, 1)}</strong></td><td class="n">${fmt(p.paidQty, 1)}</td>
          <td class="n">${p.ratio === null ? '—' : p.ratio.toFixed(1) + '%'}</td></tr>`).join('')}</tbody>`);
  }

  $('payables').innerHTML = h + `</section>`;
}

/* ---- 03 sold vs issued ------------------------------------------------- */

/* Quantities are fractional where it matters (half a vial) and whole where it
   does not, so a trailing .0 is just noise. */
const qty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? fmt(v) : fmt(v, 1);
};

/** A gap reads better with its sign: +2 units invoiced but not issued, −1.5 the other way. */
const signedQty = (n) => {
  const v = Number(n) || 0;
  const body = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  return v > 0 ? `+${body}` : v < 0 ? `−${body}` : '0';
};
const signed = (n) => (Number(n) > 0 ? `+${fmt(n)}` : Number(n) < 0 ? `−${fmt(Math.abs(n))}` : fmt(0));

/* Positive means invoiced without issuing — stock overstated. Negative means it
   left the shelf with no sale. Coloured by sign, the way the source report does. */
const gapPill = (n) => {
  const v = Number(n) || 0;
  const cls = v > 0.001 ? 'pos' : v < -0.001 ? 'neg' : 'zero';
  return `<span class="gp ${cls}">${signedQty(v)}</span>`;
};

/** One product, broken out by branch — what opens under a product row. */
function productByBranch(r) {
  if (!r.branches || !r.branches.length) {
    return '<div class="drillbox"><p class="sub">No branch activity for this product in this range.</p></div>';
  }
  const sum = (k) => r.branches.reduce((s, b) => s + b[k], 0);
  return '<div class="drillbox">' + tw(
    heads(['Branch breakdown', 'Units', 'Value', 'Out', 'Returns', 'Net', 'At cost', 'Gap', 'At cost'])
    + `<tbody>${r.branches.map((b) => `<tr>
        <td class="nm branchcell">${esc(b.name)}</td>
        <td class="n">${b.soldQty ? qty(b.soldQty) : '<span class="z">—</span>'}</td>
        <td class="n">${b.soldValue ? fmt(b.soldValue) : '<span class="z">—</span>'}</td>
        <td class="n">${b.issuedQty ? qty(b.issuedQty) : '<span class="z">—</span>'}</td>
        <td class="n">${b.returnedQty ? `<span class="neg">−${qty(b.returnedQty)}</span>` : '<span class="z">—</span>'}</td>
        <td class="n">${b.netQty ? qty(b.netQty) : '<span class="z">—</span>'}</td>
        <td class="n">${b.netCost ? fmt(b.netCost) : '<span class="z">—</span>'}</td>
        <td class="n">${gapPill(b.gapQty)}</td>
        <td class="n">${b.gapCost ? signed(b.gapCost) : '<span class="z">—</span>'}</td></tr>`).join('')}
      <tr class="tot"><td>${r.branches.length} branch${r.branches.length === 1 ? '' : 'es'}</td>
        <td class="n">${qty(sum('soldQty'))}</td><td class="n">${fmt(sum('soldValue'))}</td>
        <td class="n">${qty(sum('issuedQty'))}</td>
        <td class="n">${sum('returnedQty') ? `<span class="neg">−${qty(sum('returnedQty'))}</span>` : '<span class="z">—</span>'}</td>
        <td class="n">${qty(sum('netQty'))}</td><td class="n">${fmt(sum('netCost'))}</td>
        <td class="n">${gapPill(sum('gapQty'))}</td>
        <td class="n">${sum('gapCost') ? signed(sum('gapCost')) : '<span class="z">—</span>'}</td></tr></tbody>`) + '</div>';
}

function renderRecon(R) {
  if (!R || !R.products.length) return empty('recon', 'No sold-versus-issued data for this range.');
  const T = R.totals;

  let h = `<section>
    <div class="kicker">03 — Sold vs Issued</div>
    <h2 class="title">The same product, two sides</h2>
    <p class="sub">What was invoiced against what actually left the shelf. <strong>Net issued</strong> is
      stock out minus stock returned, so a vial put back no longer counts as consumption. The two sides are
      compared in <strong>units</strong>; the money is the unit gap priced at cost, never at selling price.</p>
    ${sourceNote('recon')}
    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Sold ex-VAT</div><div class="kpi-value">${fmt(T.soldValue)}<span class="kpi-unit">EGP</span></div><div class="kpi-sub">${fmt(T.soldQty, 1)} units over ${T.pairs} paired products</div></div>
      <div class="kpi"><div class="kpi-label">Net issued at cost</div><div class="kpi-value sm">${fmt(T.netCost)}</div><div class="kpi-sub">${fmt(T.netQty, 1)} units · ${fmt(T.returnedQty, 1)} returned</div></div>
      <div class="kpi"><div class="kpi-label">Invoiced, not issued</div><div class="kpi-value sm r">${fmt(T.gapPos)}</div><div class="kpi-sub">stock overstated by this</div></div>
      <div class="kpi"><div class="kpi-label">Issued, not sold</div><div class="kpi-value sm">${fmt(T.gapNeg)}</div><div class="kpi-sub">wastage, samples or packages</div></div>
    </div>
    <div class="fnote">A treatment issued one day can be invoiced another, and package treatments were
      often invoiced when the package was sold — so a narrow window is noisier than the full period.
      Returns in range: ${fmt(R.returns.qty, 0)} units across ${fmt(R.returns.rows)} branch-days,
      ${fmt(R.returns.cost)} at the period-average cost.</div>`;

  if (R.lookFirst.length) {
    h += `<h3 class="subtitle">Where to look first</h3>
      <p class="sub">Gaps worth at least ${fmt(3000)} EGP at cost, largest first.</p>` + tw(
      heads(['Product', 'Sold units', 'Net issued', 'Gap units', 'Gap at cost', 'Likely cause'])
      + `<tbody>${R.lookFirst.map((r) => `<tr>
          <td class="nm">${esc(r.label)}</td><td class="n">${fmt(r.soldQty, 1)}</td>
          <td class="n">${fmt(r.netQty, 1)}</td>
          <td class="n"><strong class="${r.gapQty > 0 ? 'r' : 'a'}">${fmt(r.gapQty, 1)}</strong></td>
          <td class="n"><strong>${fmt(r.gapCost)}</strong></td>
          <td class="sm2">${esc(R.causes[r.cause] || '')}</td></tr>`).join('')}</tbody>`);
  }

  h += `<h3 class="subtitle">Product reconciliation</h3>
    <p class="sub">Tap a product to see the branches behind it — a gap is almost always one or two
      branches, not the product.</p>
    <input class="searchbox" id="recSearch" placeholder="Search product…">` + tw(
    heads(['Product pair', 'Units', 'Value', 'Out', 'Returns', 'Net', 'At cost', 'Gap', 'At cost', 'Unit cost'])
    + `<tbody>${R.products.map((r, i) => `<tr class="prodrow" data-search-target data-opens="prod:${i}">
        <td><div class="nm"><span class="car">▸</span> ${esc(r.label)}</div><div class="sm2 inv">${esc(r.stockName || '')}</div></td>
        <td class="n">${qty(r.soldQty)}</td><td class="n">${fmt(r.soldValue)}</td>
        <td class="n">${qty(r.issuedQty)}</td>
        <td class="n">${r.returnedQty ? `<span class="neg">−${qty(r.returnedQty)}</span>` : '<span class="z">—</span>'}</td>
        <td class="n">${qty(r.netQty)}</td><td class="n">${fmt(r.netCost)}</td>
        <td class="n">${gapPill(r.gapQty)}</td>
        <td class="n">${r.gapCost ? signed(r.gapCost) : '<span class="z">—</span>'}</td>
        <td class="n sm2">${fmt(r.unitCost, 2)}</td></tr>
      <tr class="drill" data-drill="prod:${i}" hidden><td colspan="10">${productByBranch(r)}</td></tr>`).join('')}</tbody>`);

  h += `<h3 class="subtitle">By branch — paired products only</h3>
    <p class="sub">Sales are attributed by invoice journal; issuance and returns by the branch warehouse.</p>` + tw(
    heads(['Branch', 'Sold units', 'Sold ex-VAT', 'Net units', 'Net at cost', 'Cost ratio', 'Gap units'])
    + `<tbody>${R.branches.map((b) => `<tr>
        <td class="nm">${esc(b.name)}</td><td class="n">${fmt(b.soldQty, 1)}</td>
        <td class="n">${fmt(b.soldValue)}</td><td class="n">${fmt(b.netQty, 1)}</td>
        <td class="n">${fmt(b.netCost)}</td>
        <td class="n">${b.costRatio === null ? '—' : b.costRatio.toFixed(1) + '%'}</td>
        <td class="n"><strong class="${b.gapQty > 0 ? 'r' : b.gapQty < 0 ? 'a' : ''}">${fmt(b.gapQty, 1)}</strong></td></tr>`).join('')}</tbody>`);

  if (R.unmatched.length) {
    h += `<h3 class="subtitle">Issued with no sales twin</h3>
      <p class="sub">Stock items with no same-named sellable product — mostly consumables and syringes
        billed inside the treatment price rather than sold separately. Real consumption, but invisible to
        the reconciliation above, so it is shown apart from the gap rather than counted as one.</p>` + tw(
      heads(['Stock item', 'Out', 'Returns', 'Net units', 'Net at cost'])
      + `<tbody>${R.unmatched.map((r) => `<tr>
          <td class="nm">${esc(r.label)}</td><td class="n">${fmt(r.issuedQty, 1)}</td>
          <td class="n">${r.returnedQty ? fmt(r.returnedQty, 1) : '<span class="z">—</span>'}</td>
          <td class="n">${fmt(r.netQty, 1)}</td><td class="n"><strong>${fmt(r.netCost)}</strong></td></tr>`).join('')}</tbody>`);
  }

  $('recon').innerHTML = h + `</section>`;
}

/* ---- 04 expiry risk --------------------------------------------------- */

/* Filter state. Horizon defaults to 90 days rather than 30 because the lot names
   in the source encode month and year only, so a tighter window would be false
   precision. Drill-open sets survive a repaint — the bodies are rebuilt on every
   filter change and losing an open row each time would make the tables unusable. */
const XF = { horizon: 90, scope: 'all', search: '' };
const openLoc = new Set();
const openProd = new Set();

const shortName = (p) => String(p).replace(/\s*\([^)]*\)\s*$/, '').trim();
const daysBadge = (d) => `<span class="bg ${bucketKey(d)}">${d < 0 ? `${Math.abs(d)}d ago` : `${d}d`}</span>`;
const bucketKey = (d) => (d < 0 ? 'expired' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : d <= 180 ? 'd180' : 'safe');
const coverText = (c) => (c === null ? '—' : `${c > 99 ? '99+' : c.toFixed(1)}mo`);
const risky = (v) => `<span class="rv${v < 0.5 ? ' z' : ''}">${fmt(v)}</span>`;

/* Scope and horizon are independent, and the tables deliberately obey different
   combinations of them — see the comments on each paint function. */
const inScope = (l) => (XF.scope === 'clinics' ? !l.isWarehouse : XF.scope === 'wh' ? l.isWarehouse : true);
const inHorizon = (l) => (XF.horizon === 9999 ? true : XF.horizon === 0 ? l.daysLeft < 0 : l.daysLeft <= XF.horizon);
const inSearch = (l) => {
  if (!XF.search) return true;
  const s = XF.search.toLowerCase();
  return l.product.toLowerCase().includes(s) || l.location.toLowerCase().includes(s) || String(l.lot).toLowerCase().includes(s);
};

function renderExpiry(X) {
  if (!X || !X.lots.length) return empty('expiry', 'No expiry data loaded.');
  const T = X.totals;

  $('expiry').innerHTML = `<section>
    <div class="kicker">04 — Expiry Risk</div>
    <h2 class="title">What will not be used in time</h2>
    <p class="sub"><strong>Cover</strong> is stock on hand divided by the monthly consumption rate at that
      location. If a lot expires sooner than its cover, the surplus is at risk and costed. Consumption is
      net of returns. Stock as of <strong>${esc(X.asOf)}</strong>.</p>
    ${sourceNote('expiry')}

    <div class="fbar">
      <span class="lbl">Horizon</span>
      <button data-h="0">Expired only</button>
      <button data-h="30">30d</button>
      <button data-h="60">60d</button>
      <button data-h="90">90d</button>
      <button data-h="180">180d</button>
      <button data-h="9999">All stock</button>
      <span class="lbl">Scope</span>
      <button data-s="all">Everything</button>
      <button data-s="clinics">Clinics</button>
      <button data-s="wh">Warehouses</button>
      <input type="search" id="xSearch" placeholder="Search product, branch, lot…">
      <span class="cnt" id="xCount"></span>
    </div>

    <div class="kpi-grid six" id="xKpis"></div>

    <div class="fnote warn"><strong>The forecast is only as good as its history.</strong> The rate is a short
      run-rate scaled to a month — solid for fast movers, rough for the slow, expensive injectables where the
      money actually sits. Rows marked <em>thin movement</em> need a human look, not a decision.</div>
    <div class="fnote warn"><strong>The warehouses are the blind spot.</strong> They hold
      <strong>${fmt(T.warehouse)}</strong> — ${pct(T.warehouse, T.value).toFixed(0)}% of the total — and issue
      to branches, not to patients. Those transfers are not posted in Odoo, so no rate and no honest cover
      figure exist for them. They are marked <em>no rate</em> rather than given a fabricated one.</div>
    <div class="fnote"><strong>${fmt(T.parked)}</strong> sits in lots with no movement yet but expiry far
      off. A short window says nothing useful about them, so they are kept out of the waste figure instead of
      being counted as loss.</div>

    <h3 class="subtitle">Expiry buckets</h3>
    <p class="sub">Value of stock on hand by time to expiry. The at-risk column is the burn-rate forecast,
      and is zero for warehouse lines and for far-dated items with no movement signal.
      <em>Scope applies here; horizon does not — the buckets are the horizon.</em></p>
    <div class="stack" id="xBar"></div>
    ${tw(heads(['Bucket', 'Lines', 'Qty', 'Value at cost', 'Share', 'Forecast at risk']) + '<tbody id="xBuckets"></tbody>')}

    <h3 class="subtitle">By location <span class="hint">tap a location for its products</span></h3>
    <p class="sub">Clinic branches and the two central warehouses. <strong>Exposure</strong> is expired plus
      everything due within 90 days, as a share of that location's lot-tracked value.</p>
    ${tw(heads(['Location', 'Lines', 'Qty', 'Value', 'Expired', 'Due ≤ 90d', 'Forecast at risk', 'Exposure']) + '<tbody id="xLoc"></tbody>')}

    <h3 class="subtitle">By product <span class="hint">tap a product for branch, lot &amp; expiry detail</span></h3>
    <p class="sub">Sorted by forecast at-risk value. <strong>Rate/mo</strong> is the company-wide monthly
      consumption; the drill-down shows every lot with its own expiry date, cover and verdict.</p>
    ${tw(heads(['Product', 'Lots', 'Qty', 'Value', 'Rate/mo', 'Nearest expiry', 'Expired', 'Due ≤ 90d', 'Forecast at risk']) + '<tbody id="xProd"></tbody>')}

    <h3 class="subtitle">Act this week</h3>
    <p class="sub">Everything already expired, plus lots due within 90 days carrying at least 500 EGP of
      forecast risk — <span id="xActN">—</span> lines, first 60 shown.
      <em>Scope applies; horizon and search do not — urgent is urgent.</em></p>
    ${tw(heads(['Product · lot · expiry', 'Location', 'Days left', 'Qty', 'Value', 'Cover', 'At risk', 'Suggested action']) + '<tbody id="xAct"></tbody>')}
  </section>`;

  const bar = $('expiry').querySelector('.fbar');
  bar.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => {
    XF.horizon = Number(b.dataset.h);
    paintExpiry(X);
  }));
  bar.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => {
    XF.scope = b.dataset.s;
    paintExpiry(X);
  }));
  $('xSearch').addEventListener('input', (e) => { XF.search = e.target.value.trim(); paintExpiry(X); });

  $('expiry').addEventListener('click', (e) => {
    const loc = e.target.closest('#xLoc [data-loc]');
    if (loc) {
      const k = loc.dataset.loc;
      openLoc.has(k) ? openLoc.delete(k) : openLoc.add(k);
      paintExpiry(X);
      return;
    }
    const prod = e.target.closest('#xProd [data-prod]');
    if (prod) {
      const k = prod.dataset.prod;
      openProd.has(k) ? openProd.delete(k) : openProd.add(k);
      paintExpiry(X);
    }
  });

  paintExpiry(X);
}

function paintExpiry(X) {
  const bar = $('expiry').querySelector('.fbar');
  bar.querySelectorAll('[data-h]').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === XF.horizon));
  bar.querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('on', b.dataset.s === XF.scope));

  const scoped = X.lots.filter(inScope);
  const shown = scoped.filter((l) => inHorizon(l) && inSearch(l));
  const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);

  $('xCount').textContent = `${fmt(shown.length)} of ${fmt(scoped.length)} lines`;

  /* KPIs answer "how much is there", so scope applies but horizon does not —
     except forecast waste, which is the one figure the horizon is asking about. */
  const expired = scoped.filter((l) => l.daysLeft < 0);
  const due90 = scoped.filter((l) => l.daysLeft >= 0 && l.daysLeft <= 90);
  const noMove = scoped.filter((l) => l.verdict === 'no_move');
  const wh = scoped.filter((l) => l.isWarehouse);
  const forecast = sum(scoped.filter(inHorizon), 'atRiskValue');
  const horizonText = XF.horizon === 9999 ? 'across all expiry dates'
    : XF.horizon === 0 ? 'already expired' : `within the next ${XF.horizon} days`;

  const kpi = (cls, label, value, sub) => `<div class="kpi ${cls}">
    <div class="kpi-label">${label}</div><div class="kpi-value sm">${fmt(value)}</div>
    <div class="kpi-sub">${sub}</div></div>`;
  $('xKpis').innerHTML =
    kpi('accent', 'Lot-tracked stock', sum(scoped, 'value'), `${fmt(scoped.length)} stock lines`)
    + kpi('bad', 'Already expired', sum(expired, 'value'), `${fmt(expired.length)} lines — write off now`)
    + kpi('warn', 'Expiring within 90 days', sum(due90, 'value'), `${fmt(due90.length)} lines expiring in 90 days`)
    + kpi('bad', 'Forecast waste', forecast, horizonText)
    + kpi('warn', 'Zero-movement stock', sum(noMove, 'value'), `${fmt(noMove.length)} lines, zero issuance, expiring ≤ 1yr`)
    + kpi('unk', 'Warehouses — no rate', sum(wh, 'value'), 'cover not computable');

  /* Buckets ARE the horizon, so only scope applies to them. */
  const total = sum(scoped, 'value') || 1;
  let bars = '';
  $('xBuckets').innerHTML = X.buckets.map((b) => {
    const rs = scoped.filter((l) => l.bucket === b.key);
    const v = sum(rs, 'value'), share = (v / total) * 100;
    if (share > 0.15) bars += `<i class="${b.key}" style="width:${share.toFixed(2)}%" title="${esc(b.label)} · ${fmt(v)}"></i>`;
    return `<tr><td><span class="bg ${b.key}">${esc(b.label)}</span></td>
      <td class="n">${fmt(rs.length)}</td><td class="n">${qty(sum(rs, 'qty'))}</td>
      <td class="n">${fmt(v)}</td><td class="n">${share.toFixed(1)}%</td>
      <td class="n">${risky(sum(rs, 'atRiskValue'))}</td></tr>`;
  }).join('') + `<tr class="tot"><td>Total</td><td class="n">${fmt(scoped.length)}</td>
    <td class="n">${qty(sum(scoped, 'qty'))}</td><td class="n">${fmt(sum(scoped, 'value'))}</td>
    <td class="n">100%</td><td class="n">${risky(sum(scoped, 'atRiskValue'))}</td></tr>`;
  $('xBar').innerHTML = bars;

  const groupBy = (rows, key) => {
    const m = new Map();
    for (const l of rows) {
      const g = m.get(l[key]) || {
        name: l[key], isWarehouse: l.isWarehouse, companyRate: l.companyRate, thin: l.thinMovement,
        lines: 0, qty: 0, value: 0, atRisk: 0, expired: 0, due90: 0, nearest: Infinity, lots: [],
      };
      g.lines++; g.qty += l.qty; g.value += l.value; g.atRisk += l.atRiskValue;
      g.nearest = Math.min(g.nearest, l.daysLeft);
      if (l.daysLeft < 0) g.expired += l.value; else if (l.daysLeft <= 90) g.due90 += l.value;
      g.lots.push(l);
      m.set(l[key], g);
    }
    return [...m.values()];
  };

  /* Location and product tables obey everything — they are the browsing surface. */
  const locs = groupBy(shown, 'location').sort((a, b) => b.value - a.value);
  const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="xempty">${msg}</td></tr>`;

  $('xLoc').innerHTML = !locs.length ? emptyRow(8, 'Nothing matches the current filters.')
    : locs.map((o) => {
      const open = openLoc.has(o.name);
      let html = `<tr class="clk${open ? ' open' : ''}" data-loc="${esc(o.name)}">
        <td><div class="nm"><span class="car">▸</span> ${esc(o.name)}</div>${o.isWarehouse ? '<div class="sm2">central warehouse</div>' : ''}</td>
        <td class="n">${fmt(o.lines)}</td><td class="n">${qty(o.qty)}</td><td class="n">${fmt(o.value)}</td>
        <td class="n">${risky(o.expired)}</td><td class="n">${fmt(o.due90)}</td>
        <td class="n">${o.isWarehouse ? '<span class="bg unk">n/a</span>' : risky(o.atRisk)}</td>
        <td class="n">${o.value ? `${((o.expired + o.due90) / o.value * 100).toFixed(1)}%` : '—'}</td></tr>`;
      if (open) {
        const prods = groupBy(o.lots, 'product').sort((a, b) => b.value - a.value);
        html += `<tr class="subhead"><td>Product</td><td class="n">Lots</td><td class="n">Qty</td>
          <td class="n">Value</td><td class="n">Expired</td><td class="n">≤ 90d</td>
          <td class="n">At risk</td><td class="n">Nearest</td></tr>`
          + prods.map((z) => `<tr class="sub"><td class="nm">${esc(shortName(z.name))}</td>
            <td class="n">${fmt(z.lines)}</td><td class="n">${qty(z.qty)}</td><td class="n">${fmt(z.value)}</td>
            <td class="n">${risky(z.expired)}</td><td class="n">${fmt(z.due90)}</td>
            <td class="n">${o.isWarehouse ? '—' : risky(z.atRisk)}</td>
            <td class="n">${daysBadge(z.nearest)}</td></tr>`).join('');
      }
      return html;
    }).join('') + `<tr class="tot"><td>Total</td><td class="n">${fmt(sum(shown, 'value') ? shown.length : 0)}</td>
      <td class="n">${qty(sum(shown, 'qty'))}</td><td class="n">${fmt(sum(shown, 'value'))}</td>
      <td class="n">${risky(sum(shown.filter((l) => l.daysLeft < 0), 'value'))}</td>
      <td class="n">${fmt(sum(shown.filter((l) => l.daysLeft >= 0 && l.daysLeft <= 90), 'value'))}</td>
      <td class="n">${risky(sum(shown, 'atRiskValue'))}</td><td class="n">—</td></tr>`;

  const prods = groupBy(shown, 'product').sort((a, b) => (b.atRisk - a.atRisk) || (b.value - a.value));
  $('xProd').innerHTML = !prods.length ? emptyRow(9, 'Nothing matches the current filters.')
    : prods.map((z) => {
      const open = openProd.has(z.name);
      let html = `<tr class="clk${open ? ' open' : ''}" data-prod="${esc(z.name)}">
        <td><div class="nm"><span class="car">▸</span> ${esc(shortName(z.name))}</div>${
        z.thin ? '<div class="sm2 thin">⚠ thin movement — rate unreliable</div>' : ''}</td>
        <td class="n">${fmt(z.lines)}</td><td class="n">${qty(z.qty)}</td><td class="n">${fmt(z.value)}</td>
        <td class="n">${z.companyRate === null ? '—' : qty(z.companyRate)}</td>
        <td class="n">${daysBadge(z.nearest)}</td>
        <td class="n">${risky(z.expired)}</td><td class="n">${fmt(z.due90)}</td>
        <td class="n">${risky(z.atRisk)}</td></tr>`;
      if (open) {
        html += `<tr class="subhead"><td>Branch · lot · expiry</td><td class="n">Qty</td><td class="n">Value</td>
          <td class="n">Rate/mo</td><td class="n">Cover</td><td class="n">Days left</td>
          <td class="n">At-risk qty</td><td class="n">At-risk value</td><td>Verdict</td></tr>`
          + [...z.lots].sort((a, b) => a.daysLeft - b.daysLeft).map((l) => `<tr class="sub">
            <td><div class="nm">${esc(l.location)}</div><div class="sm2 inv">${esc(l.lot)} · exp ${esc(l.expiry)}</div></td>
            <td class="n">${qty(l.qty)}</td><td class="n">${fmt(l.value)}</td>
            <td class="n">${l.rate === null ? '—' : qty(l.rate)}</td>
            <td class="n">${coverText(l.cover)}</td>
            <td class="n">${daysBadge(l.daysLeft)}</td>
            <td class="n">${qty(l.atRiskQty)}</td><td class="n">${risky(l.atRiskValue)}</td>
            <td><span class="vd ${l.verdict}">${esc(X.labels[l.verdict] || l.verdict)}</span></td></tr>`).join('');
      }
      return html;
    }).join('') + `<tr class="tot"><td>Total — ${fmt(prods.length)} products</td>
      <td class="n">${fmt(shown.length)}</td><td class="n">${qty(sum(shown, 'qty'))}</td>
      <td class="n">${fmt(sum(shown, 'value'))}</td><td class="n">—</td><td class="n">—</td>
      <td class="n">${risky(sum(shown.filter((l) => l.daysLeft < 0), 'value'))}</td>
      <td class="n">${fmt(sum(shown.filter((l) => l.daysLeft >= 0 && l.daysLeft <= 90), 'value'))}</td>
      <td class="n">${risky(sum(shown, 'atRiskValue'))}</td></tr>`;

  /* Urgent is urgent: scope applies, but a narrowed horizon or a search must not
     hide something already expired. */
  const act = scoped
    .filter((l) => l.daysLeft < 0 || (l.daysLeft <= 90 && l.atRiskValue >= 500))
    .sort((a, b) => (a.daysLeft - b.daysLeft) || (b.atRiskValue - a.atRiskValue));
  $('xActN').textContent = fmt(act.length);
  $('xAct').innerHTML = !act.length ? emptyRow(8, 'Nothing urgent under the current scope.')
    : act.slice(0, 60).map((l) => `<tr>
      <td><div class="nm">${esc(shortName(l.product))}</div><div class="sm2 inv">${esc(l.lot)} · exp ${esc(l.expiry)}</div></td>
      <td>${esc(l.location)}</td>
      <td class="n">${daysBadge(l.daysLeft)}</td>
      <td class="n">${qty(l.qty)}</td><td class="n">${fmt(l.value)}</td>
      <td class="n">${coverText(l.cover)}</td>
      <td class="n">${risky(l.atRiskValue)}</td>
      <td class="act">${esc(l.action)}</td></tr>`).join('');
}

/* ---- load and wire ---------------------------------------------------- */

async function load() {
  $('err').textContent = '';
  setStatus('Loading…', 'busy');
  $('load').disabled = true;
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, asOf: $('asOf').value });
    const res = await fetch(`/api/finance?${q}`, { headers: { 'X-Requested-With': 'fetch' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    DATA = json;
    render();
    setStatus('Ready', 'ok');
  } catch (e) {
    setStatus('Failed', '');
    $('err').textContent = e.message;
  } finally {
    $('load').disabled = false;
  }
}

function render() {
  const m = DATA.meta;
  $('hPeriod').textContent = `${shortDate(m.from)} → ${shortDate(m.to)}`;
  $('hNet').innerHTML = `${fmt(DATA.collections ? DATA.collections.totals.net : 0)}<small>EGP net</small>`;
  $('hAp').innerHTML = `${fmt(DATA.payables ? Math.abs(DATA.payables.totals.closing) : 0)}<small>EGP closing</small>`;
  $('hGap').innerHTML = `${fmt(DATA.recon ? DATA.recon.totals.gapPos : 0)}<small>EGP at cost</small>`;
  $('hRisk').innerHTML = `${fmt(DATA.expiry ? DATA.expiry.totals.atRisk : 0)}<small>EGP forecast</small>`;
  $('rangeline').innerHTML = `<strong>${esc(m.from)} → ${esc(m.to)}</strong> · stock as of <strong>${esc(m.asOf)}</strong>`
    + ` · ${Object.entries(m.sources).map(([k, v]) => `${k} <strong>${v.mode}</strong>`).join(' · ')}`;

  renderCollections(DATA.collections);
  renderPayables(DATA.payables);
  renderRecon(DATA.recon);
  renderExpiry(DATA.expiry);
}

Shell.mountTabs();

// Accordions and the per-panel search boxes, same behaviour as the sales report.
document.addEventListener('click', (e) => {
  const head = e.target.closest('.acc-h');
  if (head) { head.parentElement.classList.toggle('open'); return; }

  /* Any row marked `data-opens` toggles the `data-drill` row that matches it.
     Used by both the daily summary and the product reconciliation — the question
     underneath is the same one: which branches is this made of? */
  const row = e.target.closest('[data-opens]');
  if (!row) return;
  const open = row.classList.toggle('open');
  const drill = row.parentElement.querySelector(`[data-drill="${row.dataset.opens}"]`);
  if (drill) drill.hidden = !open;
});
document.addEventListener('input', (e) => {
  if (!e.target.classList.contains('searchbox')) return;
  const q = e.target.value.toLowerCase().trim();
  e.target.closest('.panel').querySelectorAll('[data-search-target]').forEach((n) => {
    n.style.display = !q || n.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

$('load').addEventListener('click', load);

/* Pins the tab strip under the control bar — see public/shell.js. This page
   used to omit the window.resize listener, so opening the sidebar never
   re-measured the bar and the strip drifted. */
Shell.stickyBar();

/* The range is whatever the loaded data covers — the server decides, because a
   finance snapshot is a fixed window and defaulting to today shows nothing. */
(async () => {
  try {
    const res = await fetch('/api/finance', { headers: { 'X-Requested-With': 'fetch' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    DATA = await res.json();
    if (DATA.error) throw new Error(DATA.error);
    $('from').value = DATA.meta.from;
    $('to').value = DATA.meta.to;
    $('asOf').value = DATA.meta.asOf;
    render();
    setStatus('Ready', 'ok');
  } catch (e) {
    setStatus('Failed', '');
    $('err').textContent = e.message;
  }
})();
