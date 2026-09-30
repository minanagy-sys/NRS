/* Doctors Performance — its own report.
 *
 * Rebuilt from the three usable tabs of the frozen
 * `Doctors_Performance_Report.html` pack. Its fourth tab was that file's own
 * Odoo self-refresh wiring and is deliberately not here: NRS loads through
 * scripts/sync.js and reports on that load in its own Data quality tab.
 *
 * TWO DEFINITIONS FROM THE PACK CARRY THE WHOLE REPORT, and both are easy to
 * read backwards:
 *
 *   TICKET SIZE IS PER DISTINCT CUSTOMER. The pack says so outright — "Average
 *   ticket = income ex-VAT / distinct customers, per doctor". Read as
 *   per-invoice it is a different number: Dr. Mai mohsen is 17,099 a customer
 *   and 13,785 an invoice over the same window. BOTH appear here, labelled,
 *   because per-invoice is what a reader assumes "ticket" means.
 *
 *   SYRINGES ARE COUNTED BY UNIT RULE, not by quantity — Rich PL per 5 ml,
 *   V-Hacker per 2.5 ml. The rules live in src/lib/doctors.js with a test file,
 *   because four of the five families share one Odoo category and a
 *   category-first rule collapses them into one bucket.
 *
 * AND ONE THING THIS REPORT CANNOT DO, said on the page rather than hidden in a
 * comment: the doctor is on the invoice HEADER and never on the line. These are
 * syringes on invoices billed under a doctor's name, not syringes she is
 * recorded as having injected.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 1) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(d)}%`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

/* Ten rows then an inner scroll, as every long table in these reports behaves. */
const TALL = 'style="--h:360px"';

/* Green at or above pace, amber within AMBER_FLOOR of it, red below — the same
   thresholds `Rules.toneOf` applies server-side, so the two never disagree
   about what counts as behind. */
const tone = (actual, expected) => {
  if (!expected) return 'n';
  const ratio = actual / expected;
  return ratio >= 1 ? 'g' : ratio >= Rules.AMBER_FLOOR ? 'a' : 'r';
};

const trk = (p, pace) =>
  `<div class="trk"><i style="width:${Math.min(100, p).toFixed(1)}%"></i>${
    pace === undefined ? '' : `<u style="left:${Math.min(100, pace).toFixed(1)}%"></u>`}</div>`;

/** The cache-floor banner, when a range reaches before the invoices do. */
function floorNote(D) {
  if (!D.coverage || D.coverage.covered) return '';
  return `<div class="tg-note" style="border-left:3px solid #c98a2e">
    <strong>Part of this range is outside the cache.</strong> ${esc(D.coverage.note)}</div>`;
}

/* ------------------------------------------------------------ 01 · targets */

function renderTargets(D) {
  const T = D.targets;

  let h = `<section>
    <div class="kicker">01 — Targets</div>
    <h2 class="title">Target vs achieved</h2>
    <p class="sub">The approved schedule read doctor-first, by group. ${esc(D.from)} to ${esc(D.to)},
      ex-VAT and ex-package.</p>
    ${floorNote(D)}`;

  if (!D.sheet.loaded || !T || T.missing) {
    /* A doctor shown at 0% of a target that does not exist is a false
       accusation, not a low number. The panel refuses rather than drawing a
       column of zeros. */
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>No target to score against.</strong> ${esc(D.sheet.note || 'No sheet for this period.')}
      Tabs 02 and 03 do not depend on the schedule and are unaffected.</div></section>`;
    $('tg').innerHTML = h;
    return;
  }

  h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Schedule total</div>
        <div class="kpi-value">${fmt(T.sheetTotal)}<span class="kpi-unit">EGP</span></div>
        <div class="kpi-sub">${T.rosterCount} on the roster · ${T.listedCount} with sales</div></div>
      <div class="kpi"><div class="kpi-label">Achieved month to date</div>
        <div class="kpi-value">${fmt(T.mtdTotal)}</div>
        <div class="kpi-sub">${pc(T.sheetTotal ? T.mtdTotal / T.sheetTotal : null)} of the schedule</div></div>
      <div class="kpi"><div class="kpi-label">Pace</div>
        <div class="kpi-value">${T.pacePct.toFixed(1)}%</div>
        <div class="kpi-sub">day ${T.dayNo} of ${T.daysInPeriod}</div></div>
      <div class="kpi"><div class="kpi-label">Groups</div>
        <div class="kpi-value">${T.groups.length}</div>
        <div class="kpi-sub">${esc(T.sourceLabel || 'imported sheet')}</div></div>
    </div>
    <div class="tg-note">Green is at or above pace, amber within
      ${Math.round(Rules.AMBER_FLOOR * 100)}% of it, red below. This is the same scoring the
      NRS Targets tab shows — one function, invoked from both, so the two pages cannot
      disagree about the same sheet.</div>`;

  for (const g of T.groups) {
    const t = tone(g.mtdEx, g.target * (T.pacePct / 100));
    h += `<div class="acc" data-acc><div class="acc-h"><span class="car">▸</span>
        <div><div class="acc-name">${esc(g.name)}</div>
          <div class="acc-meta">${g.rows.length} doctor${g.rows.length === 1 ? '' : 's'} with sales
            · roster ${g.rosterCount}${g.unlistedCount
    ? ` · ${g.unlistedCount} unlisted worth ${fmt(g.unlistedTarget)}` : ''}</div></div>
        <div class="cv"><b class="${t}">${pc(g.target ? g.mtdEx / g.target : null)}</b>
          <small>${fmt(g.mtdEx)} of ${fmt(g.target)}</small></div></div>
      <div class="acc-b"><div class="tw"><table class="ltab tight"><thead><tr>
        <th>Doctor</th><th class="n">Target</th><th class="n">Daily</th><th class="n">Achieved</th>
        <th class="n">Of target</th><th style="min-width:90px"></th></tr></thead><tbody>
        ${g.rows.map((r) => `<tr>
          <td><span class="nm">${esc(r.name)}</span><div class="sm2">${
    r.mtdInvoices || 0} invoices${r.via ? ` · matched as ${esc(r.via)}` : ''}${
    r.matched ? '' : ' · no Odoo match'}</div></td>
          <td class="n">${fmt(r.monthlyTarget)}</td>
          <td class="n">${fmt(r.perDay)}</td>
          <td class="n">${fmt(r.mtdEx)}</td>
          <td class="n"><b class="${r.mtdTone}">${r.mtdPct.toFixed(1)}%</b></td>
          <td>${trk(r.mtdPct, T.pacePct)}</td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  }

  /* The two lists that must never be quietly dropped. A doctor on the sheet
     whose name does not resolve is not a doctor at 0%; a doctor billing with no
     target is revenue nobody set a target for. */
  if ((T.unresolved || []).length || (T.offSheet || []).length) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">`;
    if ((T.unresolved || []).length) {
      h += `<strong>${T.unresolved.length} on the sheet with no Odoo match:</strong>
        ${T.unresolved.map((x) => esc(x.name || x)).join(' · ')}. They are not scored above —
        pair them in Admin → Name mapping and they appear.<br>`;
    }
    if ((T.offSheet || []).length) {
      h += `<strong>${T.offSheet.length} billed without being on the sheet:</strong>
        ${T.offSheet.slice(0, 12).map((x) => esc(x.name || x)).join(' · ')}.`;
    }
    h += `</div>`;
  }

  $('tg').innerHTML = `${h}</section>`;
}

/* -------------------------------------------------------- 02 · ticket size */

function renderTicket(D) {
  const TK = D.ticket;
  const shown = TK.doctors.filter((d) => d.ex > 0);
  const perCust = TK.distinctCustomers ? TK.totals.ex / TK.distinctCustomers : 0;
  const perInv = TK.totals.invoices ? TK.totals.ex / TK.totals.invoices : 0;
  const maxPerCust = shown.reduce((a, d) => Math.max(a, d.perCustomer || 0), 0);

  let h = `<section>
    <div class="kicker">02 — Ticket size</div>
    <h2 class="title">Revenue per customer</h2>
    <p class="sub">${esc(D.from)} to ${esc(D.to)}. Ex-VAT and ex-package, with credit notes netted
      off rather than dropped — a refund is money leaving.</p>
    ${floorNote(D)}
    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Average per customer</div>
        <div class="kpi-value">${fmt(perCust)}<span class="kpi-unit">EGP</span></div>
        <div class="kpi-sub">clinic-wide · ${fmt(TK.distinctCustomers)} distinct customers</div></div>
      <div class="kpi"><div class="kpi-label">Average per invoice</div>
        <div class="kpi-value">${fmt(perInv)}</div>
        <div class="kpi-sub">${fmt(TK.totals.invoices)} invoices</div></div>
      <div class="kpi"><div class="kpi-label">Visits per customer</div>
        <div class="kpi-value">${fmt(TK.distinctCustomers ? TK.totals.invoices / TK.distinctCustomers : 0, 2)}</div>
        <div class="kpi-sub">invoices ÷ distinct customers</div></div>
      <div class="kpi"><div class="kpi-label">Doctors billing</div>
        <div class="kpi-value">${fmt(shown.length)}</div>
        <div class="kpi-sub">with revenue in this range</div></div>
    </div>
    <div class="tg-note">${esc(TK.note)}</div>

    <h3 class="subtitle">By doctor <span class="sm2">ranked by revenue</span></h3>
    <div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>Doctor</th><th class="n">Ex-VAT</th><th class="n">Customers</th><th class="n">Invoices</th>
      <th class="n">Per customer</th><th style="min-width:90px"></th>
      <th class="n">Per invoice</th><th class="n">Visits / customer</th></tr></thead><tbody>
      ${shown.map((d) => `<tr>
        <td><span class="nm">${esc(d.name)}</span>${d.refunds
    ? `<div class="sm2">${d.refunds} credit note${d.refunds === 1 ? '' : 's'} netted off</div>` : ''}</td>
        <td class="n">${fmt(d.ex)}</td>
        <td class="n">${fmt(d.customers)}</td>
        <td class="n">${fmt(d.invoices)}</td>
        <td class="n"><strong>${fmt(d.perCustomer)}</strong></td>
        <td>${trk(maxPerCust ? (d.perCustomer / maxPerCust) * 100 : 0)}</td>
        <td class="n">${fmt(d.perInvoice)}</td>
        <td class="n">${fmt(d.visitsPerCustomer, 2)}</td></tr>`).join('')}
    </tbody></table></div>`;

  if (!shown.length) h += '<div class="tg-note">No invoices in this range.</div>';
  $('tk').innerHTML = `${h}</section>`;
}

/* -------------------------------------------------------- 03 · injectables */

function renderInjectables(D) {
  const IJ = D.injectables;
  const inj = IJ.doctors.filter((d) => d.syringes > 0);
  const maxSyr = inj.reduce((a, d) => Math.max(a, d.syringes), 0);

  let h = `<section>
    <div class="kicker">03 — Injectables</div>
    <h2 class="title">Injectables and income by doctor</h2>
    <p class="sub">Filler, skinbooster, Rich PL, V-Hacker and calcium biostimulators — syringes
      used, total income earned across every service, and what share of that income these five
      carry. ${esc(D.from)} to ${esc(D.to)}.</p>
    ${floorNote(D)}
    <div class="fgrid">
      ${IJ.families.map((f) => `<div class="fstep"><div class="l">${esc(f.label)}</div>
        <div class="v">${fmt(f.syringes, 0)}</div>
        <div class="n">${f.share === null ? '' : `${pc(f.share, 0)} of syringes`}<br>${fmt(f.ex)} EGP
          <br><span class="sm2">${esc(f.note)}</span></div></div>`).join('')}
      <div class="fstep"><div class="l">Injectable share of income</div>
        <div class="v">${pc(IJ.totals.pct, 0)}</div>
        <div class="n">${fmt(IJ.totals.inj)} of ${fmt(IJ.totals.income)}<br>
          <span class="sm2">every service, not only injectables</span></div></div>
    </div>
    <div class="tg-note">${esc(IJ.note)}</div>

    <h3 class="subtitle">By doctor <span class="sm2">ranked by injectable income</span></h3>
    <div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>Doctor</th><th class="n">Filler</th><th class="n">Booster</th><th class="n">Rich PL</th>
      <th class="n">V-Hacker</th><th class="n">Calcium</th><th class="n">Syringes</th>
      <th style="min-width:80px"></th>
      <th class="n">Income</th><th class="n">Injectable</th><th class="n">Share</th>
      </tr></thead><tbody>
      ${inj.map((d) => `<tr>
        <td><span class="nm">${esc(d.name)}</span></td>
        <td class="n">${fmt(d.filler, 0)}</td>
        <td class="n">${fmt(d.booster, 0)}</td>
        <td class="n">${fmt(d.richpl, 0)}</td>
        <td class="n">${fmt(d.vhacker, 0)}</td>
        <td class="n">${fmt(d.calcium, 0)}</td>
        <td class="n"><strong>${fmt(d.syringes, 0)}</strong></td>
        <td>${trk(maxSyr ? (d.syringes / maxSyr) * 100 : 0)}</td>
        <td class="n">${fmt(d.income)}</td>
        <td class="n">${fmt(d.inj)}</td>
        <td class="n">${pc(d.pct, 0)}</td></tr>`).join('')}
    </tbody></table></div>`;

  if (!inj.length) h += '<div class="tg-note">No injectable lines in this range.</div>';
  $('ij').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------------------ paint */

function paint() {
  const D = DATA;
  const TK = D.ticket;
  const perCust = TK.distinctCustomers ? TK.totals.ex / TK.distinctCustomers : 0;

  $('hPeriod').textContent = ` · ${D.from} → ${D.to}`;
  $('hEx').textContent = fmt(TK.totals.ex);
  $('hPerCust').textContent = fmt(perCust);
  $('hSyr').textContent = fmt(D.injectables.totals.syringes, 0);
  $('hDocs').textContent = fmt(TK.doctors.filter((d) => d.ex > 0).length);
  $('rangeline').innerHTML = `<strong>${fmt(TK.totals.ex)}</strong> ex-VAT ex-package
    · <strong>${fmt(TK.distinctCustomers)}</strong> distinct customers
    · <strong>${fmt(perCust)}</strong> per customer
    · <strong>${fmt(D.injectables.totals.syringes, 0)}</strong> syringes
    · <strong>${pc(D.injectables.totals.pct, 0)}</strong> of income is injectable
    ${D.sheet.loaded ? '' : ' · <span style="color:#b0503c">no target sheet for this period</span>'}`;

  renderTargets(D); renderTicket(D); renderInjectables(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    DATA = await api(`/api/doctors?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.ticket.doctors.filter((d) => d.ex > 0).length)} doctors`;
  } catch (e) {
    $('dot').className = 'dot bad';
    $('status').textContent = 'failed';
    $('err').textContent = e.message;
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
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
    $('from').value = `${y}-01-01`; $('to').value = iso(now);
  } else {
    $('from').value = `${iso(now).slice(0, 7)}-01`; $('to').value = iso(now);
  }
}

document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
  preset(b.dataset.p); load();
}));
$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

/* The group accordions on tab 01. Delegated, so rebuilding the panel on every
   range change needs no rewiring. */
document.addEventListener('click', (e) => {
  const head = e.target.closest && e.target.closest('.acc-h');
  if (head) head.parentElement.classList.toggle('open');
});

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
