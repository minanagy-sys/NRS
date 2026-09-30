/* Report 01's patient half — tiers, retention and service mix.
 *
 * Everything arrives from /api/patients already ranked and bucketed, so this
 * file draws and does not decide. Three things it does deliberately differently
 * from the source pack.
 *
 * It never shows a patient list. The source report embedded 2,890 real names and
 * Egyptian mobile numbers inside a downloadable HTML file, and warned in its own
 * footer against sharing itself. The API sends tier rollups and a bounded fifty
 * top spenders with no contact detail at all, so there is nothing here to leak.
 *
 * The tier basis is a control, not a constant. Report 01 ranks on year-to-date
 * spend at 150k/75k/25k; report 06's config says rolling twelve months at
 * 250k/100k/50k/20k. Different windows AND different thresholds, so the same
 * patient lands in different tiers under each. Both are selectable and the one in
 * force is named on every panel that depends on it.
 *
 * And "new" requires proof. A patient is only new if the invoice cache reaches
 * back far enough to show they were absent before the window. Where it does not,
 * they are counted as unknown — which is the honest version of the drifting
 * 1,254 / 1,268 new-patient splits the source reports disagree on.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 1) => `${((Number(v) || 0) * 100).toFixed(d)}%`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;
let BASIS = 'report01';

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

/* The caveat block, reused wherever a number depends on the basis window. */
const basisNote = (D) => `<div class="tg-note"${D.basisCovered ? '' : ' style="border-left:3px solid #b0503c"'}>
  <strong>Ranked on ${esc(D.basis.label)}</strong> — ${esc(D.basis.from)} to ${esc(D.basis.to)},
  from ${esc(D.basis.source || 'the report config')}.
  ${D.basisCovered
    ? `The invoice cache covers ${esc(D.coverage.from)} to ${esc(D.coverage.to)}, so this window is complete.`
    : `<strong>The cache only starts on ${esc(D.coverage.from)}</strong>, which is after this
       window begins. Every tier below is computed on less history than its own
       definition asks for, so a patient who spent early in the window is ranked
       too low. Treat the ranking as indicative until the range is backfilled.`}
  ${D.alternatives.length ? `The other definition in circulation is <em>${esc(D.alternatives[0].label)}</em>
    — switch with the control above to see how much the tiers move.` : ''}</div>`;

/* ------------------------------------------------------------- 01 tiers --- */

function renderTiers(D) {
  let h = `<section>
    <div class="kicker">01 — Tiers</div>
    <h2 class="title">${fmt(D.patients)} patients, ${fmt(D.total)} ex-VAT</h2>
    <p class="sub">Refunds are subtracted before ranking, so a patient whose treatment was
      refunded is not promoted on money they got back.</p>
    ${basisNote(D)}
    <div class="tg-sum">`;

  for (const t of D.tiers) {
    h += `<div class="tg-s${t.name === 'VIP' ? ' inj' : ''}">
      <div class="l">${esc(t.name)}${t.from ? ` · from ${fmt(t.from)}` : ''}</div>
      <div class="p">${fmt(t.patients)}</div>
      <div class="n">${pc(t.patientShare)} of patients<br><strong>${pc(t.spendShare)}</strong> of spend</div>
      <div class="b"><i style="width:${Math.min(100, t.spendShare * 100).toFixed(1)}%"></i></div></div>`;
  }
  h += '</div>';

  /* The concentration read, which is the whole reason to tier at all. */
  const top = D.tiers[0];
  if (top && top.patients) {
    const ratio = top.patientShare ? top.spendShare / top.patientShare : 0;
    h += `<div class="tg-note"><strong>${esc(top.name)} is ${pc(top.patientShare)} of patients and
      ${pc(top.spendShare)} of spend</strong> — ${ratio.toFixed(1)}× their share of the list.
      Average ticket ${fmt(top.avgSpend)} against ${fmt(D.patients ? D.total / D.patients : 0)} across everyone.</div>`;
  }

  h += `<h3 class="subtitle">Tier by tier</h3>
    <div class="tw"><table class="ltab"><thead><tr><th>Tier</th><th class="n">From</th><th class="n">Patients</th>
      <th class="n">Share of patients</th><th class="n">Spend ex-VAT</th><th class="n">Share of spend</th>
      <th class="n">Average</th></tr></thead><tbody>`;
  for (const t of D.tiers) {
    h += `<tr><td class="nm">${esc(t.name)}</td><td class="n">${t.from ? fmt(t.from) : '—'}</td>
      <td class="n">${fmt(t.patients)}</td><td class="n">${pc(t.patientShare)}</td>
      <td class="n">${fmt(t.exVat)}</td><td class="n">${pc(t.spendShare)}</td>
      <td class="n">${fmt(t.avgSpend)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>All</th><th class="n"></th><th class="n">${fmt(D.patients)}</th>
    <th class="n">100.0%</th><th class="n">${fmt(D.total)}</th><th class="n">100.0%</th>
    <th class="n">${fmt(D.patients ? D.total / D.patients : 0)}</th></tr></tfoot></table></div>`;

  if (D.top.length) {
    h += `<h3 class="subtitle">Top ${D.top.length} by spend</h3>
      <p class="sub">Names only — no mobile numbers, no addresses, and the list is capped at
        ${D.top.length} rather than sending every patient to the browser.</p>
      <div class="tw scrolly" style="--minw:820px"><table class="ltab tight"><thead><tr><th class="n">#</th><th>Patient</th><th>Tier</th>
        <th class="n">Spend ex-VAT</th><th class="n">Invoices</th><th class="n">First</th><th class="n">Last</th></tr></thead><tbody>`;
    D.top.forEach((p, i) => {
      h += `<tr><td class="n">${i + 1}</td><td class="nm">${esc(p.name || '—')}</td>
        <td><span class="sev ${p.tier === 'VIP' ? 'attended' : p.tier === 'Premium' ? 'open' : 'lost'}">${esc(p.tier)}</span></td>
        <td class="n">${fmt(p.exVat)}</td><td class="n">${fmt(p.invoices)}</td>
        <td class="n">${esc(p.firstInvoice)}</td><td class="n">${esc(p.lastInvoice)}</td></tr>`;
    });
    h += '</tbody></table></div>';
  }

  /* Tier by home branch. Home branch is where the patient bills MOST — not where
     they were first seen and not where they were last seen. A patient who lives
     by CFC and had one session in Alexandria belongs to CFC, and both
     alternatives would file them in the wrong column. */
  const HB = D.homeBranch;
  if (HB && HB.branches.length) {
    h += `<h3 class="subtitle">Patient category per branch <span class="sm2">home branch = where they bill most</span></h3>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Branch</th>
        ${HB.tierNames.map((n) => `<th class="n">${esc(n)}</th>`).join('')}
        <th class="n">Patients</th><th class="n">Spend ex-VAT</th><th class="n">Average</th></tr></thead><tbody>`;
    for (const b of HB.branches) {
      h += `<tr><td class="nm">${esc(b.branch)}</td>
        ${HB.tierNames.map((n) => `<td class="n">${b.tiers[n] ? fmt(b.tiers[n]) : '—'}</td>`).join('')}
        <td class="n"><strong>${fmt(b.patients)}</strong></td><td class="n">${fmt(b.exVat)}</td>
        <td class="n">${fmt(b.patients ? b.exVat / b.patients : 0)}</td></tr>`;
    }
    const tot = HB.branches.reduce((a, b) => ({ p: a.p + b.patients, e: a.e + b.exVat }), { p: 0, e: 0 });
    h += `</tbody><tfoot><tr><th>All</th>
      ${HB.tierNames.map((n) => `<th class="n">${fmt(HB.branches.reduce((a, b) => a + (b.tiers[n] || 0), 0))}</th>`).join('')}
      <th class="n">${fmt(tot.p)}</th><th class="n">${fmt(tot.e)}</th>
      <th class="n">${fmt(tot.p ? tot.e / tot.p : 0)}</th></tr></tfoot></table></div>`;
  }

  h += '</section>';
  $('tiers').innerHTML = h;
}

/* ------------------------------------------------- 02 new vs returning --- */

function renderMix(D) {
  const M = D.mix;
  const known = M.new + M.returning;

  let h = `<section>
    <div class="kicker">02 — New vs returning</div>
    <h2 class="title">${fmt(M.patients)} patients billed</h2>
    <p class="sub">${esc(M.from)} → ${esc(M.to)}. Decided by first invoice anywhere in the cache,
      not by Odoo's <code>isNewCustomer</code> flag — that flag is written at invoice time
      and never revisited, so a patient invoiced twice in a day is flagged new on both.</p>`;

  if (!M.provable) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>Nobody can be called new in this range.</strong> The cache starts on
      ${esc(M.coverage.from)}, which is not before ${esc(M.from)}, so a patient's first
      invoice appearing inside the window proves nothing — it may simply be the first
      one NRS holds. All ${fmt(M.unknown)} are counted as unknown rather than quietly
      counted as new, which is what makes a two-month cache report a 100% new-patient
      rate. Backfill earlier months to resolve this.</div>`;
  }

  h += `<div class="tg-sum">
    <div class="tg-s inj"><div class="l">New</div><div class="p">${fmt(M.new)}</div>
      <div class="n">${known ? pc(M.new / M.patients) : '—'} of patients<br>${fmt(M.newExVat)} ex-VAT</div>
      <div class="b"><i style="width:${Math.min(100, (M.new / (M.patients || 1)) * 100).toFixed(1)}%"></i></div></div>
    <div class="tg-s"><div class="l">Returning</div><div class="p">${fmt(M.returning)}</div>
      <div class="n">${pc(M.returning / (M.patients || 1))} of patients<br>${fmt(M.returningExVat)} ex-VAT</div>
      <div class="b"><i style="width:${Math.min(100, (M.returning / (M.patients || 1)) * 100).toFixed(1)}%"></i></div></div>
    <div class="tg-s"><div class="l">Unknown</div><div class="p">${fmt(M.unknown)}</div>
      <div class="n">${pc(M.unknown / (M.patients || 1))} of patients<br>cache does not reach back far enough</div>
      <div class="b"><i style="width:${Math.min(100, (M.unknown / (M.patients || 1)) * 100).toFixed(1)}%"></i></div></div>
  </div>`;

  const avgNew = M.new ? M.newExVat / M.new : 0;
  const avgRet = M.returning ? M.returningExVat / M.returning : 0;
  if (avgNew && avgRet) {
    h += `<h3 class="subtitle">What each is worth</h3>
      <div class="tw"><table class="ltab"><thead><tr><th></th><th class="n">Patients</th>
        <th class="n">Spend ex-VAT</th><th class="n">Share of spend</th><th class="n">Average ticket</th></tr></thead><tbody>
        <tr><td class="nm">New</td><td class="n">${fmt(M.new)}</td><td class="n">${fmt(M.newExVat)}</td>
          <td class="n">${pc(M.newExVat / ((M.newExVat + M.returningExVat + M.unknownExVat) || 1))}</td>
          <td class="n">${fmt(avgNew)}</td></tr>
        <tr><td class="nm">Returning</td><td class="n">${fmt(M.returning)}</td><td class="n">${fmt(M.returningExVat)}</td>
          <td class="n">${pc(M.returningExVat / ((M.newExVat + M.returningExVat + M.unknownExVat) || 1))}</td>
          <td class="n">${fmt(avgRet)}</td></tr>
      </tbody></table></div>
      <div class="tg-note"><strong>A returning patient is worth ${(avgRet / avgNew).toFixed(2)}× a new one
        per visit here.</strong> That ratio is the number to watch against acquisition cost —
        which needs ad spend, and ad spend is a Supermetrics figure NRS cannot read yet.</div>`;
  }

  /* Report 01's patient funnel. Its three figures are NOT disjoint: "New" is every
     first-timer and "Once" is a subset of those who have not come back. Drawn in
     that shape, because presenting them as three buckets makes "new" look like a
     collapse when it is the same number cut differently. */
  const F = D.funnel;
  if (F && F.total) {
    h += `<h3 class="subtitle">Patient funnel</h3>
      <p class="sub">First invoice of ${esc(F.yearStart.slice(0, 4))} falling inside the window makes a
        patient new. <strong>Once</strong> is a subset of new, not a fourth group: new patients with a
        single invoice all year, who have not come back yet.</p>
      <div class="tg-sum">
        <div class="tg-s inj"><div class="l">New</div><div class="p">${fmt(F.firstTime)}</div>
          <div class="n">${pc(F.firstTime / F.total)} of patients billed<br>first ${esc(F.yearStart.slice(0, 4))} invoice is in this window</div>
          <div class="b"><i style="width:${Math.min(100, (F.firstTime / F.total) * 100).toFixed(1)}%"></i></div></div>
        <div class="tg-s"><div class="l">Repeated</div><div class="p">${fmt(F.repeated)}</div>
          <div class="n">${pc(F.repeated / F.total)} of patients billed<br>billed earlier in the year and came back</div>
          <div class="b"><i style="width:${Math.min(100, (F.repeated / F.total) * 100).toFixed(1)}%"></i></div></div>
        <div class="tg-s"><div class="l">Once <span class="sm2">of the new</span></div><div class="p">${fmt(F.once)}</div>
          <div class="n"><strong>${pc(F.onceShareOfNew)}</strong> of new patients<br>one invoice, no return yet</div>
          <div class="b"><i style="width:${Math.min(100, F.onceShareOfNew * 100).toFixed(1)}%;background:#b0503c"></i></div></div>
      </div>
      <div class="tg-note"${F.onceShareOfNew > 0.7 ? ' style="border-left:3px solid #b0503c"' : ''}>
        <strong>${pc(F.onceShareOfNew)} of new patients have not returned.</strong>
        That is a retention number wearing an acquisition number's clothes: the branches
        below are winning first visits and losing second ones, and the cost of the first
        visit only pays back on the second.</div>`;

    if (!F.provable) {
      h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>"New" is not provable
        for this range.</strong> The cache starts ${esc(F.coverage.from)}, after
        ${esc(F.yearStart)}, so "first invoice of the year" is really "first invoice NRS
        holds". Backfill to ${esc(F.yearStart)} to make this a measurement.</div>`;
    }

    if (F.branches.length) {
      h += `<h3 class="subtitle">Funnel per branch</h3>
        <p class="sub">Sorted by the share of new patients who have not come back — worst first,
          because that is where the money is leaking.</p>
        <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Billed</th>
          <th class="n">New</th><th class="n">Repeated</th><th class="n">Repeat share</th>
          <th class="n">Once</th><th class="n">Not returned</th></tr></thead><tbody>`;
      const sorted = [...F.branches].sort((a, b) => b.onceShare - a.onceShare);
      for (const b of sorted) {
        h += `<tr><td class="nm">${esc(b.branch)}</td><td class="n">${fmt(b.total)}</td>
          <td class="n">${fmt(b.firstTime)}</td><td class="n">${fmt(b.repeated)}</td>
          <td class="n">${pc(b.repeatShare)}</td><td class="n">${fmt(b.once)}</td>
          <td class="n"><span class="sev ${b.onceShare > 0.85 ? 'lost' : b.onceShare > 0.7 ? 'open' : 'attended'}">${pc(b.onceShare)}</span></td></tr>`;
      }
      h += '</tbody></table></div>';
    }
  }

  h += '</section>';
  $('retention').innerHTML = h;
}

/* ------------------------------------------------------- 04 acquisition --- */

function renderAcquisition(D) {
  const A = D.acquisition;
  if (!A || !A.patients) {
    $('acq').innerHTML = `<section><div class="kicker">04 — Acquisition</div>
      <h2 class="title">No first-time patients in this range</h2>
      <p class="sub">Nobody's first invoice of the year falls inside ${esc(D.from)} → ${esc(D.to)}.</p></section>`;
    return;
  }

  let h = `<section>
    <div class="kicker">04 — Acquisition</div>
    <h2 class="title">${fmt(A.patients)} first-time patients, and what they came in for</h2>
    <p class="sub">Categories on each new patient's <em>first</em> invoice of the year. This is the
      door they walked through, not everything they have since bought.</p>
    <div class="tg-note"><strong>The shares add to more than 100%, deliberately.</strong>
      A first invoice with three categories on it counts in all three — "what did they come
      in for" has no single answer when they bought three things at once. Normalising it away
      would invent a primary service the invoice does not name.</div>
    <div class="tw"><table class="ltab"><thead><tr><th>First service category</th>
      <th class="n">New patients</th><th class="n">Share of new</th>
      <th class="n">Their first-invoice revenue</th><th class="n">Per patient</th></tr></thead><tbody>`;
  for (const c of A.categories.slice(0, 25)) {
    h += `<tr><td class="nm">${esc(c.category)}</td><td class="n">${fmt(c.patients)}</td>
      <td class="n">${pc(c.share)}</td><td class="n">${fmt(c.exVat)}</td>
      <td class="n">${fmt(c.perPatient)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>All first invoices</th><th class="n">${fmt(A.patients)}</th>
    <th class="n">distinct</th><th class="n">${fmt(A.total)}</th>
    <th class="n">${fmt(A.patients ? A.total / A.patients : 0)}</th></tr></tfoot></table></div>`;

  const cheap = A.categories.filter((c) => c.patients >= 20).sort((a, b) => a.perPatient - b.perPatient)[0];
  const rich = A.categories.filter((c) => c.patients >= 20).sort((a, b) => b.perPatient - a.perPatient)[0];
  if (cheap && rich && cheap.category !== rich.category) {
    h += `<div class="tg-note"><strong>${esc(rich.category)}</strong> brings in
      ${fmt(rich.perPatient)} per new patient against <strong>${fmt(cheap.perPatient)}</strong> for
      ${esc(cheap.category)} — a ${(rich.perPatient / (cheap.perPatient || 1)).toFixed(1)}× spread on
      the first visit. Which door they come through is worth as much as how many come through it,
      and the retention figures on the previous tab decide whether either pays back.</div>`;
  }

  h += '</section>';
  $('acq').innerHTML = h;
}

/* ------------------------------------------------------- 03 service mix --- */

function renderServiceMix(D) {
  const S = D.serviceMix;
  const tierNames = D.tiers.map((t) => t.name);

  let h = `<section>
    <div class="kicker">03 — Service mix</div>
    <h2 class="title">${fmt(S.total)} ex-VAT across ${S.categories.length} categories</h2>
    <p class="sub">Tiers come from the ranking window; the basket comes from the selected range.
      That is on purpose — it answers what this month's VIPs bought this month, not what
      VIPs have ever bought. Package lines are kept here and labelled, because a package is
      something a patient really bought; it is only revenue-against-attendance comparisons
      that have to strip them.</p>`;

  if (S.tiers.length) {
    h += '<div class="tg-sum">';
    for (const t of S.tiers) {
      h += `<div class="tg-s${t.tier === 'VIP' ? ' inj' : ''}"><div class="l">${esc(t.tier)}</div>
        <div class="p">${pc(t.share)}</div>
        <div class="n">${fmt(t.exVat)} ex-VAT<br>${fmt(t.lines)} lines</div>
        <div class="b"><i style="width:${Math.min(100, t.share * 100).toFixed(1)}%"></i></div></div>`;
    }
    h += '</div>';
  }

  h += `<h3 class="subtitle">Category by tier</h3>
    <div class="tw"><table class="ltab tight"><thead><tr><th>Category</th>
      ${tierNames.map((n) => `<th class="n">${esc(n)}</th>`).join('')}
      <th class="n">Total</th><th class="n">Share</th></tr></thead><tbody>`;
  for (const c of S.categories) {
    h += `<tr><td class="nm">${esc(c.category)}</td>
      ${tierNames.map((n) => `<td class="n">${c.tiers[n] ? fmt(c.tiers[n]) : '—'}</td>`).join('')}
      <td class="n"><strong>${fmt(c.exVat)}</strong></td><td class="n">${pc(c.share)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>All</th>
    ${tierNames.map((n) => {
    const t = S.tiers.find((x) => x.tier === n);
    return `<th class="n">${t ? fmt(t.exVat) : '—'}</th>`;
  }).join('')}
    <th class="n">${fmt(S.total)}</th><th class="n">100.0%</th></tr></tfoot></table></div>
  </section>`;
  $('mix').innerHTML = h;
}

/* ---------------------------------------------------------- 04 churn --- */

function renderChurn(D) {
  const R = D.retention;

  let h = `<section>
    <div class="kicker">04 — Churn &amp; recency</div>
    <h2 class="title">${fmt(R.patients)} patients, by how long since their last invoice</h2>
    <p class="sub">As of ${esc(R.asOf)}. The cache is ${R.depthMonths} months deep, which sets a
      hard limit on what can be called churn.</p>
    <div class="tg-note"><strong>Absence is only measurable inside the cache.</strong>
      A patient shown as absent for longer than ${R.depthMonths} months is
      indistinguishable from one NRS has never seen, so those buckets are marked rather
      than counted as lapsed. Churn is a claim about what did <em>not</em> happen, and it
      is only as trustworthy as the history behind it.</div>
    <div class="tw"><table class="ltab"><thead><tr><th>Bucket</th><th class="n">Patients</th>
      <th class="n">Share</th><th class="n">Of those, repeat</th><th class="n">Repeat share</th>
      <th>Reliability</th></tr></thead><tbody>`;
  for (const b of R.buckets) {
    h += `<tr><td class="nm">${esc(b.name)}</td><td class="n">${fmt(b.patients)}</td>
      <td class="n">${pc(b.share)}</td><td class="n">${fmt(b.repeatPatients)}</td>
      <td class="n">${pc(b.repeatPatients / (b.patients || 1))}</td>
      <td>${b.beyondCache
    ? '<span class="sev lost">beyond cache</span>'
    : '<span class="sev attended">measurable</span>'}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>All</th><th class="n">${fmt(R.patients)}</th><th class="n">100.0%</th>
    <th class="n">${fmt(R.buckets.reduce((a, b) => a + b.repeatPatients, 0))}</th>
    <th class="n">${pc(R.buckets.reduce((a, b) => a + b.repeatPatients, 0) / (R.patients || 1))}</th>
    <th></th></tr></tfoot></table></div>`;

  const active = R.buckets[0];
  if (active) {
    h += `<div class="tg-note"><strong>${pc(active.share)} of patients are active</strong> —
      last invoiced in the same month as ${esc(R.asOf)}. The reactivation bonus in the
      commission policy pays on bringing patients out of the later buckets, but it pays
      per agent, and the booking record only identifies the desk that entered the
      booking. That attribution does not exist in the data yet.</div>`;
  }

  /* Report 01's churn definition: no invoice in the last six months. Distinct from
     the recency buckets above — those describe everyone, this names the dormant. */
  const C = D.churn;
  if (C && C.allPatients) {
    h += `<h3 class="subtitle">Churned patients <span class="sm2">no invoice in the last ${C.months} months</span></h3>
      <div class="tg-sum">
        <div class="tg-s"><div class="l">Churned</div><div class="p">${fmt(C.churned)}</div>
          <div class="n">${pc(C.share)} of all ${fmt(C.allPatients)} patients<br>last invoice before ${esc(C.cutoff)}</div>
          <div class="b"><i style="width:${Math.min(100, C.share * 100).toFixed(1)}%;background:#b0503c"></i></div></div>
        <div class="tg-s"><div class="l">Their revenue this year</div><div class="p">${fmt(C.revenue)}</div>
          <div class="n">what these patients were worth<br>before going quiet</div></div>
        <div class="tg-s"><div class="l">Average per churned patient</div><div class="p">${fmt(C.perPatient)}</div>
          <div class="n">the value of winning one back</div></div>
      </div>`;

    if (!C.provable) {
      h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>A ${C.months}-month
        silence cannot be proven against a ${C.cacheDepthMonths}-month cache.</strong> A patient with
        no invoice since ${esc(C.cutoff)} is indistinguishable from one NRS has never seen, so this
        count is an upper bound, not a measurement.</div>`;
    } else {
      h += `<div class="tg-note">The cache is ${C.cacheDepthMonths} months deep against a
        ${C.months}-month test, so every patient here was genuinely present and then genuinely
        stopped — the silence is measured, not assumed.</div>`;
    }

    if (C.lastService.length) {
      h += `<h3 class="subtitle">Churned by last service</h3>
        <p class="sub">The categories on each churned patient's final invoice — what they were
          having done when they stopped coming.</p>
        <div class="tw"><table class="ltab"><thead><tr><th>Last service category</th>
          <th class="n">Churned patients</th><th class="n">Share</th></tr></thead><tbody>`;
      for (const r of C.lastService.slice(0, 20)) {
        h += `<tr><td class="nm">${esc(r.category)}</td><td class="n">${fmt(r.patients)}</td>
          <td class="n">${pc(r.patients / (C.churned || 1))}</td></tr>`;
      }
      h += `</tbody></table></div>
        <p class="sub">As on the Acquisition tab, a final invoice with several categories counts in
          each, so these shares add above 100%.</p>`;
    }

    if (C.branches.length) {
      h += `<h3 class="subtitle">Churned by branch</h3>
        <div class="tw"><table class="ltab"><thead><tr><th>Branch</th>
          <th class="n">Churned patients</th><th class="n">Their revenue</th>
          <th class="n">Per patient</th></tr></thead><tbody>`;
      for (const b of C.branches) {
        h += `<tr><td class="nm">${esc(b.branch)}</td><td class="n">${fmt(b.patients)}</td>
          <td class="n">${fmt(b.exVat)}</td>
          <td class="n">${fmt(b.patients ? b.exVat / b.patients : 0)}</td></tr>`;
      }
      h += `</tbody><tfoot><tr><th>All</th>
        <th class="n">${fmt(C.branches.reduce((a, b) => a + b.patients, 0))}</th>
        <th class="n">${fmt(C.revenue)}</th><th class="n">${fmt(C.perPatient)}</th></tr></tfoot></table></div>
        <p class="sub">A patient billed at more than one branch appears under each, so the branch
          rows add above the headline count.</p>`;
    }
  }

  h += '</section>';
  $('churn').innerHTML = h;
}

/* ------------------------------------------------------------------ boot --- */

function paint() {
  const D = DATA, M = D.mix;
  $('hPeriod').textContent = `${D.from} → ${D.to}`;
  $('hPat').textContent = fmt(M.patients);
  /* The hero "New" uses the patient funnel's first-timer count — report 01's own
     definition — not buildMix's, which answers a different question (absent from
     the whole cache, versus absent from this year). */
  $('hNew').textContent = D.funnel && D.funnel.provable ? fmt(D.funnel.firstTime) : '—';
  $('hRep').textContent = pc(M.returning / (M.patients || 1));
  const spend = M.newExVat + M.returningExVat + M.unknownExVat;
  $('hTk').textContent = fmt(M.patients ? spend / M.patients : 0);
  $('hSub').textContent = `Ranked on ${D.basis.label}. ${D.basisCovered
    ? 'The cache covers the full ranking window.'
    : 'The cache does not reach the start of the ranking window — see the caveat on Tiers.'}`;
  $('rangeline').innerHTML = `<strong>${fmt(D.patients)}</strong> patients ranked
    · basis <strong>${esc(D.basis.label)}</strong> ${esc(D.basis.from)}→${esc(D.basis.to)}
    · cache <strong>${esc(D.coverage.from)}→${esc(D.coverage.to)}</strong> (${fmt(D.coverage.invoices)} invoices)
    · ${M.provable ? `<strong>${fmt(M.new)}</strong> new` : '<span style="color:#b0503c">new not provable</span>'}
    · <strong>${fmt(D.total)}</strong> ex-VAT`;
  renderTiers(D); renderMix(D); renderServiceMix(D); renderAcquisition(D); renderChurn(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, basis: BASIS });
    DATA = await api(`/api/patients?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.patients)} patients`;
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
/* The basis change re-ranks every patient, so it is a reload rather than a repaint. */
document.querySelectorAll('#basis button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#basis button').forEach((x) => x.classList.toggle('on', x === b));
  BASIS = b.dataset.basis;
  load();
}));
$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
