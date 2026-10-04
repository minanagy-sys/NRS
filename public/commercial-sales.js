/* Report 01 — Commercial Sales.
 *
 * Its own report, deliberately NOT merged into the Sales report at `/`. That one
 * answers "what did we invoice today, by doctor and by target" and it is
 * untouched. This one answers report 01's question instead: what did we earn once
 * packages are taken out, what mix produced it, and who paid for it.
 *
 * Three things it does differently from the Sales report next door, and the
 * differences are the reason it exists rather than being folded in.
 *
 * Revenue here is ex-package throughout. A package is invoiced when it is SOLD,
 * carries no VAT and is a prepayment — so including it flatters whichever branch
 * sold packages that month and makes the ranking a different ranking. The Sales
 * report shows all invoices; this one shows the comparable figure and says so on
 * every panel.
 *
 * The category slicer cuts by branch AND by doctor from one selection, which is
 * report 01's own framing and the cut that says who actually drives a category.
 *
 * And the patient half is a tab here rather than a separate report, because that
 * is where report 01 keeps it.
 */

/* From public/fmt.js — one copy of these for every page. They had drifted
   apart by 2026-10-04 (two `pc`, two `esc`); see that file. */
const { $, fmt, pc, esc } = Fmt;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

let DATA = null;
let SCOPE = 'all';
let SLICE = { value: null };

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

/* The All / Nouvel Age / ZAT switch, resolved from the mapping the API sends.
 *
 * This used to test the branch name against /zat/i, on the assumption that ZAT's
 * branches were named for it. They are not: they are **Madinity** and **El
 * Rehab**, and no Odoo branch name contains the string "zat" at all. So the
 * control looked wired up and filtered nothing — ZAT emptied every table and
 * Nouvel Age was identical to All. The entity actually lives on
 * CommissionBranch, bridged to Odoo's spelling by IdentityAlias, and
 * `Tracker.branchEntities()` ships that map with the payload.
 *
 * A branch the map does not know ("Unassigned", "HQ") belongs to no entity and
 * is therefore hidden by BOTH named scopes. That is the honest answer, but it
 * silently shrinks the totals, so `hiddenNote()` says what a scope is leaving
 * out rather than letting the reader assume they are seeing everything. */
const entKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const entityOf = (name) => {
  const m = DATA && DATA.entities ? DATA.entities.map : null;
  return m ? (m[entKey(name)] || null) : null;
};
const inScope = (name) => SCOPE === 'all' || entityOf(name) === SCOPE;

/* Names in the current payload that no entity claims. */
function unmappedBranches(names) {
  return [...new Set(names.filter((n) => n && !entityOf(n)))];
}
function hiddenNote(names) {
  if (SCOPE === 'all') return '';
  const orphans = unmappedBranches(names);
  if (!orphans.length) return '';
  return `<div class="tg-note" style="border-left:3px solid #c98a2e">
    <strong>${orphans.length} branch${orphans.length === 1 ? '' : 'es'} hidden by this filter:</strong>
    ${orphans.map(esc).join(' · ')}. ${orphans.length === 1 ? 'It belongs' : 'They belong'} to no
    entity in the commission table, so neither <em>Nouvel Age</em> nor <em>ZAT</em> claims
    ${orphans.length === 1 ? 'it' : 'them'} — switch to <em>All</em> to include
    ${orphans.length === 1 ? 'it' : 'them'}.</div>`;
}


/* The policy's four department labels, hoisted above every render that uses them
   — renderOverview is declared before the mix panel and would otherwise depend on
   `load()` awaiting before it runs. */
const FAMLBL = { laser: 'Devices & laser', inj: 'Injections', body: 'Body contouring', other: 'Service & other' };

const bar = (v, max, colour) =>
  `<div class="b"><i style="width:${Math.min(100, max ? (v / max) * 100 : 0).toFixed(1)}%${colour ? `;background:${colour}` : ''}"></i></div>`;

/* --------------------------------------------------------- 01 overview --- */

function renderOverview(D) {
  const X = D.exPackage;
  const R = D.report;
  const A = D.appointments;
  const C = D.collections;
  const P = D.patients;
  const days = R.days.length || 1;
  const branches = D.cuts.branches.filter((b) => inScope(b.name));
  const maxB = branches.reduce((a, b) => Math.max(a, b.ex), 0);
  const hidden = hiddenNote(D.cuts.branches.map((b) => b.name));

  let h = `<section>
    <div class="kicker">01 — At a glance</div>
    <h2 class="title">${fmt(days)} day${days === 1 ? '' : 's'} in numbers</h2>
    <p class="sub">${esc(D.from)} → ${esc(D.to)}. Every revenue figure on this report is
      <strong>ex-VAT and ex-package</strong> unless a label says otherwise.</p>

    <div class="tg-sum">
      <div class="tg-s inj"><div class="l">Revenue ex-VAT · ex-package</div><div class="p">${fmt(X.ex)}</div>
        <div class="n">${fmt(X.invoices)} invoices<br>${fmt(X.inc)} inc-VAT</div></div>
      <div class="tg-s"><div class="l">Package sales · liability</div><div class="p">${fmt(X.removedEx)}</div>
        <div class="n">${fmt(X.removedInvoices)} invoices, zero VAT<br>cash today, revenue later</div></div>
      <div class="tg-s"><div class="l">Collected ex-VAT</div><div class="p">${C ? fmt(C.net / 1.14) : '—'}</div>
        <div class="n">${C ? `${fmt(C.net)} inc-VAT banked<br>across ${C.days} day${C.days === 1 ? '' : 's'}` : 'collections not available'}</div></div>
      <div class="tg-s"><div class="l">Invoiced per day</div><div class="p">${fmt(X.ex / days)}</div>
        <div class="n">${fmt(X.invoices / days, 1)} invoices a day<br>average ticket ${fmt(X.invoices ? X.ex / X.invoices : 0)}</div></div>
    </div>

    <div class="tg-sum">
      <div class="tg-s"><div class="l">Branches billing</div><div class="p">${fmt(branches.length)}</div>
        <div class="n">of ${fmt(D.cuts.branches.length)} in the data</div></div>
      <div class="tg-s"><div class="l">Patients billed</div><div class="p">${fmt(P.funnel.total)}</div>
        <div class="n">${P.funnel.provable ? `${fmt(P.funnel.firstTime)} new · ${fmt(P.funnel.repeated)} returning` : 'new/returning not provable'}</div></div>
      <div class="tg-s"><div class="l">Appointments booked</div><div class="p">${A.reportable ? fmt(A.booked) : '—'}</div>
        <div class="n">${A.reportable ? `${fmt(A.attended)} attended · ${pc(A.showRate)} show rate` : `not measurable before ${esc(A.cutover)}`}</div></div>
      <div class="tg-s"><div class="l">Still unresolved</div><div class="p">${A.reportable ? fmt(A.open) : '—'}</div>
        <div class="n">${A.reportable ? `${pc(A.open / (A.booked || 1))} with no outcome` : '—'}</div></div>
    </div>`;

  if (!X.known) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>The ex-package figure
      cannot be trusted for this range.</strong> Only ${pc(X.coverage)} of invoices carry a journal
      name, and packages cannot be excluded without it. Re-sync the range to backfill it.</div>`;
  }

  /* The mix headline, because report 01 leads the overview with it. */
  const fam = { laser: 0, inj: 0, body: 0, other: 0 };
  for (const b of D.mix.branches.filter((x) => inScope(x.branch))) {
    for (const c of b.categories) fam[c.family] = (fam[c.family] || 0) + c.exVat;
  }
  const famTot = Object.values(fam).reduce((a, b) => a + b, 0);
  h += `<h3 class="subtitle">The mix behind it</h3>
    <p class="sub">All invoice lines in the range, packages included — a package line is still a
      thing somebody bought, and this is a mix question rather than a revenue one.</p>
    <div class="tg-sum">`;
  for (const k of ['laser', 'inj', 'body', 'other']) {
    h += `<div class="tg-s${k === 'laser' ? ' inj' : ''}"><div class="l">${esc(FAMLBL[k])}</div>
      <div class="p">${pc(famTot ? fam[k] / famTot : 0)}</div>
      <div class="n">${fmt(fam[k])} ex-VAT</div>
      ${bar(fam[k], famTot)}</div>`;
  }
  h += '</div>';

  /* Branch ranking — the panel report 01 puts directly under the KPIs. */
  h += `${hidden}<h3 class="subtitle">Branch ranking <span class="sm2">revenue ex-VAT · ex-package</span></h3>
    <div class="tw"><table class="ltab"><thead><tr><th>#</th><th>Branch</th>
      <th class="n">Revenue ex-VAT</th><th class="n">Share</th><th class="n">Invoices</th>
      <th class="n">Average ticket</th><th>Against the leader</th></tr></thead><tbody>`;
  const totB = branches.reduce((a, b) => a + b.ex, 0);
  branches.forEach((b, i) => {
    h += `<tr><td class="n">${i + 1}</td><td class="nm">${esc(b.name)}</td>
      <td class="n">${fmt(b.ex)}</td><td class="n">${pc(totB ? b.ex / totB : 0)}</td>
      <td class="n">${fmt(b.invoices)}</td><td class="n">${fmt(b.ticket)}</td>
      <td style="min-width:110px">${bar(b.ex, maxB)}</td></tr>`;
  });
  h += `</tbody><tfoot><tr><th></th><th>All in scope</th><th class="n">${fmt(totB)}</th>
    <th class="n">100.0%</th><th class="n">${fmt(branches.reduce((a, b) => a + b.invoices, 0))}</th>
    <th class="n">${fmt(branches.reduce((a, b) => a + b.invoices, 0) ? totB / branches.reduce((a, b) => a + b.invoices, 0) : 0)}</th>
    <th></th></tr></tfoot></table></div>
    <div class="tg-note"><strong>This ranking is not the same as the one on the Sales report.</strong>
      That one ranks on all invoices; this one takes packages out, and packages are
      ${pc(X.ex + X.removedEx ? X.removedEx / (X.ex + X.removedEx) : 0)} of the range and not spread
      evenly — so a branch that sold a lot of them places higher there than it earned here.</div>
  </section>`;
  $('ov').innerHTML = h;
}

/* ------------------------------------------------- 02 branch performance --- */

function renderBranches(D) {
  const rows = D.cuts.branches.filter((b) => inScope(b.name));
  const hidden = hiddenNote(D.cuts.branches.map((b) => b.name));
  const PF = D.patients.funnel;
  const byBranch = new Map(PF.branches.map((b) => [b.branch, b]));
  const totEx = rows.reduce((a, b) => a + b.ex, 0);

  let h = `<section>
    <div class="kicker">02 — Branch performance</div>
    <h2 class="title">${rows.length} branch${rows.length === 1 ? '' : 'es'}, one row each</h2>
    <p class="sub">Revenue ex-package, the patients behind it, and how many of them came back.
      Retention here is the share of a branch's billed patients who had already been billed
      earlier this year — not a promise about the future.</p>
    ${hidden}
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Revenue ex-VAT</th>
      <th class="n">Share</th><th class="n">Invoices</th><th class="n">Average ticket</th>
      <th class="n">Patients</th><th class="n">New</th><th class="n">Retention</th>
      <th class="n">Not returned</th></tr></thead><tbody>`;
  for (const b of rows) {
    const p = byBranch.get(b.name);
    h += `<tr><td class="nm">${esc(b.name)}</td><td class="n">${fmt(b.ex)}</td>
      <td class="n">${pc(totEx ? b.ex / totEx : 0)}</td><td class="n">${fmt(b.invoices)}</td>
      <td class="n">${fmt(b.ticket)}</td>
      <td class="n">${p ? fmt(p.total) : '—'}</td>
      <td class="n">${p ? fmt(p.firstTime) : '—'}</td>
      <td class="n">${p ? `<span class="sev ${p.repeatShare >= 0.6 ? 'attended' : p.repeatShare >= 0.45 ? 'open' : 'lost'}">${pc(p.repeatShare)}</span>` : '—'}</td>
      <td class="n">${p ? pc(p.onceShare) : '—'}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>All in scope</th><th class="n">${fmt(totEx)}</th><th class="n">100.0%</th>
    <th class="n">${fmt(rows.reduce((a, b) => a + b.invoices, 0))}</th><th class="n"></th>
    <th class="n">${fmt(PF.total)}</th><th class="n">${fmt(PF.firstTime)}</th>
    <th class="n">${pc(PF.total ? PF.repeated / PF.total : 0)}</th>
    <th class="n">${pc(PF.onceShareOfNew)}</th></tr></tfoot></table></div>`;

  /* Report 01's three ranked strips. */
  const strips = [
    { key: 'retention', label: 'Retention rate', sub: 'share of billed patients who had been billed earlier this year',
      pick: (b) => { const p = byBranch.get(b.name); return p ? p.repeatShare : null; }, asPct: true },
    { key: 'new', label: 'New patients', sub: 'first invoice of the year falling in this range',
      pick: (b) => { const p = byBranch.get(b.name); return p ? p.firstTime : null; }, asPct: false },
    { key: 'ticket', label: 'Average ticket', sub: 'revenue ex-package ÷ invoices',
      pick: (b) => b.ticket, asPct: false },
  ];
  for (const st of strips) {
    const vals = rows.map((b) => ({ name: b.name, v: st.pick(b) })).filter((x) => x.v !== null);
    if (!vals.length) continue;
    vals.sort((a, b) => b.v - a.v);
    const max = vals[0].v;
    h += `<h3 class="subtitle">${esc(st.label)} <span class="sm2">${esc(st.sub)}</span></h3>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Branch</th>
        <th class="n">${esc(st.label)}</th><th></th></tr></thead><tbody>`;
    for (const x of vals) {
      h += `<tr><td class="nm">${esc(x.name)}</td>
        <td class="n">${st.asPct ? pc(x.v) : fmt(x.v)}</td>
        <td style="min-width:130px">${bar(x.v, max)}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }

  h += `<div class="tg-note"><strong>Doctor-level revenue is on the Service mix tab, not here.</strong>
    Report 01 noted it was missing because the invoice-line model did not appear to carry a
    specialist. It does — <code>specialistName</code> is on the invoice — so the by-doctor cut is
    real and sits with the category slicer, where it answers who drives which service.</div>
  </section>`;
  $('br').innerHTML = h;
}

/* ------------------------------------------------------ 03 service mix --- */

/* Report 01's shape, and the direction of the drill matters.
 *
 * You pick a CATEGORY and see how it splits across branches and doctors. An
 * earlier version of this panel had it the other way round — pick a branch, see
 * its categories — which answers a different question and loses the one the tab
 * exists for: "Biostimulators is 22% of revenue on 182 lines; who is actually
 * selling it?"
 *
 * The four cards at the top are the policy gates, computed against the stored
 * floors and caps rather than transcribed: devices short of its 30% floor and
 * injections over its 50% cap is the finding, and it has to move when the mix
 * moves.
 */


function blistRow(label, value, share, max, opts = {}) {
  const w = Math.min(100, max ? (value / max) * 100 : 0);
  const tag = opts.click ? 'button' : 'div';
  const attrs = opts.click
    ? ` type="button" data-cat="${esc(opts.click)}"${opts.on ? ' class="blist-row on' : ' class="blist-row'}${opts.fam ? ` fam-${esc(opts.fam)}"` : '"'}`
    : ` class="blist-row${opts.fam ? ` fam-${esc(opts.fam)}` : ''}"`;
  return `<${tag}${attrs}>
    <span class="nm" title="${esc(label)}">${esc(label)}</span>
    <span class="tr"><i style="width:${w.toFixed(1)}%"></i></span>
    <span class="vv">${fmt(value)}${share === null ? '' : `<small>${pc(share)}</small>`}</span>
  </${tag}>`;
}

function renderMix(D) {
  const M = D.mix;
  const branchOpts = M.branches.filter((b) => inScope(b.branch));

  /* Every figure on this tab is derived from the IN-SCOPE branches, not from the
     group rollup. Reading M.categories directly left the category list, the gate
     cards and the all-categories table identical under every scope while the
     branch table beside them filtered — the same dead-control problem as the
     by-doctor cut below. Under ALL this reduces to the group rollup, so the
     unfiltered view is unchanged. */
  const catMap = new Map();
  for (const b of branchOpts) {
    for (const c of b.categories) {
      const x = catMap.get(c.category)
        || { category: c.category, exVat: 0, lines: 0, family: c.family };
      x.exVat = r2(x.exVat + c.exVat);
      x.lines += c.lines || 0;
      catMap.set(c.category, x);
    }
  }
  const mixTotal = r2([...catMap.values()].reduce((a, c) => a + c.exVat, 0));
  const cats = [...catMap.values()].map((c) => ({
    ...c,
    share: mixTotal ? c.exVat / mixTotal : 0,
    perLine: c.lines ? r2(c.exVat / c.lines) : 0,
  })).sort((a, b) => b.exVat - a.exVat);

  /* Doctors, re-aggregated over in-scope branches only. */
  const doctors = M.doctors.map((d) => {
    const kept = d.categories.filter((c) => inScope(c.branch));
    const ex = r2(kept.reduce((a, c) => a + c.exVat, 0));
    const byCat = new Map();
    for (const c of kept) {
      const x = byCat.get(c.category) || { category: c.category, exVat: 0, lines: 0, family: c.family };
      x.exVat = r2(x.exVat + c.exVat); x.lines += c.lines || 0;
      byCat.set(c.category, x);
    }
    return {
      doctor: d.doctor, exVat: ex,
      share: mixTotal ? ex / mixTotal : 0,
      categories: [...byCat.values()].sort((a, b) => b.exVat - a.exVat),
    };
  }).filter((d) => d.exVat > 0).sort((a, b) => b.exVat - a.exVat);

  /* Family shares, and the gate each one is measured against. */
  const fam = { laser: 0, inj: 0, body: 0, other: 0 };
  for (const c of cats) fam[c.family] = r2((fam[c.family] || 0) + c.exVat);
  const famTot = Object.values(fam).reduce((a, b) => a + b, 0);
  const depByKey = new Map((M.departments || []).map((d) => [d.key, d]));

  let h = `<section>
    <div class="kicker">03 — Service mix</div>
    <h2 class="title">Face, body, hair, <em>machines</em></h2>
    <p class="sub">Every posted invoice line in the range grouped by product category, ex-VAT.
      This is the mix that decides the service multipliers in the commission policy.</p>
    <div class="kpi-grid">`;

  for (const k of ['laser', 'inj', 'other', 'body']) {
    const dep = depByKey.get(k);
    const share = famTot ? fam[k] / famTot : 0;
    const floor = dep && dep.mixFloor !== null && dep.mixFloor !== undefined ? dep.mixFloor : null;
    const cap = dep && dep.mixCap !== null && dep.mixCap !== undefined ? dep.mixCap : null;
    let gate = '';
    if (floor !== null) {
      gate = ` · floor <strong>${pc(floor, 0)}</strong> · <span class="${share >= floor ? 'up' : 'down'}">${share >= floor ? 'met' : 'short'}</span>`;
    } else if (cap !== null) {
      gate = ` · cap <strong>${pc(cap, 0)}</strong> · <span class="${share <= cap ? 'up' : 'down'}">${share <= cap ? 'inside' : 'over'}</span>`;
    } else if (dep && dep.multiplier) {
      gate = ` · the <strong>&times;${dep.multiplier}</strong> strategic priority`;
    }
    h += `<div class="kpi${k === 'body' ? ' accent' : ''}">
      <div class="kpi-label">${esc(FAMLBL[k])}</div>
      <div class="kpi-value">${(share * 100).toFixed(share < 0.01 ? 2 : 1)}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">${fmt(fam[k])}${gate}</div></div>`;
  }
  h += '</div>';

  /* The finding, computed. Report 01 states it in prose for August; this recomputes
     it so it stays true — or stops being said — when the mix changes. */
  const lz = depByKey.get('laser'), ij = depByKey.get('inj');
  const lShare = famTot ? fam.laser / famTot : 0, iShare = famTot ? fam.inj / famTot : 0;
  const lShort = lz && lz.mixFloor !== null && lShare < lz.mixFloor;
  const iOver = ij && ij.mixCap !== null && iShare > ij.mixCap;
  if (lShort || iOver) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>The mix is the wrong shape against the policy's own gates.</strong>
      ${iOver ? `Injections at ${pc(iShare)} breach the ${pc(ij.mixCap, 0)} cap` : ''}
      ${lShort && iOver ? ' and ' : ''}${lShort ? `devices at ${pc(lShare)} miss the ${pc(lz.mixFloor, 0)} floor` : ''},
      so on these numbers no branch earns a service multiplier on group mix.
      Body contouring — the category the policy pays most for — is
      <strong>${pc(famTot ? fam.body / famTot : 0, 2)}</strong> of revenue across the group.</div>`;
  }

  /* Top categories, clickable. */
  const maxC = cats.reduce((a, c) => Math.max(a, c.exVat), 0);
  if (!SLICE.value && cats.length) SLICE.value = cats[0].category;
  h += `<h3 class="subtitle">Top categories
      <span class="tag">click a category for its branch and doctor split</span></h3>
    <div class="blist" id="catBars">`;
  for (const c of cats.slice(0, 12)) {
    h += blistRow(c.category, c.exVat, c.share, maxC,
      { click: c.category, on: c.category === SLICE.value, fam: c.family });
  }
  h += '</div>';

  /* The slicer: the selected category, split by branch and by doctor. */
  const pick = SLICE.value;
  const cat = cats.find((c) => c.category === pick) || null;
  const byBranch = branchOpts
    .map((b) => ({ name: b.branch, ex: (b.categories.find((x) => x.category === pick) || {}).exVat || 0 }))
    .filter((x) => x.ex > 0).sort((a, b) => b.ex - a.ex);
  const byDoctor = doctors
    .map((d) => ({ name: d.doctor, ex: (d.categories.find((x) => x.category === pick) || {}).exVat || 0 }))
    .filter((x) => x.ex > 0).sort((a, b) => b.ex - a.ex);
  const bTot = byBranch.reduce((a, x) => a + x.ex, 0);
  const dTot = byDoctor.reduce((a, x) => a + x.ex, 0);
  const bMax = byBranch.reduce((a, x) => Math.max(a, x.ex), 0);
  const dMax = byDoctor.reduce((a, x) => Math.max(a, x.ex), 0);

  h += `<h3 class="subtitle">Category slicer
      <span class="tag">${cat ? esc(cat.category) : 'pick a category above'}</span></h3>
    <div class="twocol">
      <div class="pcard"><div class="pcard-head"><h4>By branch</h4><span class="hint">ex-VAT</span></div>
        <div class="pcard-body">${byBranch.length
    ? `<div class="blist">${byBranch.map((x) => blistRow(x.name, x.ex, bTot ? x.ex / bTot : 0, bMax)).join('')}</div>`
    : '<div class="empty">No branch billed this category in the range.</div>'}</div></div>
      <div class="pcard"><div class="pcard-head"><h4>By doctor</h4><span class="hint">top 8 · ex-VAT</span></div>
        <div class="pcard-body">${byDoctor.length
    ? `<div class="blist">${byDoctor.slice(0, 8).map((x) => blistRow(x.name, x.ex, dTot ? x.ex / dTot : 0, dMax)).join('')}</div>`
    : '<div class="empty">No doctor is credited with this category.</div>'}</div></div>
    </div>`;

  if (cat) {
    const topB = byBranch[0], topD = byDoctor[0];
    const unassigned = byDoctor.find((x) => x.name === 'Unassigned');
    h += `<div class="tg-note"><strong>${esc(cat.category)}</strong> is ${pc(cat.share)} of the mix —
      ${fmt(cat.exVat)} over ${fmt(cat.lines)} line${cat.lines === 1 ? '' : 's'},
      ${fmt(cat.perLine)} each.
      ${topB ? `Its biggest branch is <strong>${esc(topB.name)}</strong> at ${pc(bTot ? topB.ex / bTot : 0)} of it` : ''}${topD && topD.name !== 'Unassigned' ? `, and <strong>${esc(topD.name)}</strong> is credited with ${pc(dTot ? topD.ex / dTot : 0)}` : ''}.
      ${unassigned ? `<br><strong>${pc(dTot ? unassigned.ex / dTot : 0)} of it has no doctor</strong> — that is the package journal, which is invoiced at the point of sale and carries no specialist.` : ''}
      ${byBranch.length === 1 ? '<br>Only one branch sells it at all, so the group mix figure above is really that branch\'s mix.' : ''}</div>`;
  }

  /* All categories, report 01's own columns. */
  h += `<h3 class="subtitle">All categories <span class="tag">ex-VAT · ${esc(D.from)} → ${esc(D.to)}</span></h3>
    <div class="tw"><table class="ltab"><thead><tr><th>Category</th><th>Bucket</th>
      <th class="n">Lines</th><th class="n">Revenue</th><th class="n">Share</th>
      <th class="n">Per line</th></tr></thead><tbody>`;
  for (const c of cats) {
    h += `<tr><td class="nm">${esc(c.category)}</td>
      <td><span class="sev ${c.family === 'laser' ? 'open' : c.family === 'inj' ? 'attended' : 'lost'}">${esc(FAMLBL[c.family] || c.family)}</span></td>
      <td class="n">${fmt(c.lines)}</td><td class="n"><strong>${fmt(c.exVat)}</strong></td>
      <td class="n">${pc(c.share)}</td><td class="n">${fmt(c.perLine)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>${cats.length} categories</th><th></th>
    <th class="n">${fmt(cats.reduce((a, c) => a + c.lines, 0))}</th>
    <th class="n">${fmt(mixTotal)}</th><th class="n">100.0%</th>
    <th class="n">${fmt(cats.reduce((a, c) => a + c.lines, 0) ? mixTotal / cats.reduce((a, c) => a + c.lines, 0) : 0)}</th>
    </tr></tfoot></table></div>
  </section>`;
  $('mix').innerHTML = h;

  /* Re-bind: the panel is replaced wholesale on each repaint. */
  document.querySelectorAll('#catBars [data-cat]').forEach((b) => b.addEventListener('click', () => {
    SLICE.value = b.dataset.cat;
    renderMix(D);
  }));
}

/* --------------------------------------------------------- 04 patients --- */

function renderPatients(D) {
  const P = D.patients;
  const F = P.funnel;
  const C = P.churn;
  const A = P.acquisition;
  const HB = P.homeBranch;

  let h = `<section>
    <div class="kicker">04 — Patients</div>
    <h2 class="title">Who they are, and who stopped coming</h2>
    <p class="sub">Ranked on ${esc(P.basis.label)} — ${esc(P.basis.from)} to ${esc(P.basis.to)}.
      ${P.basisCovered
    ? `The invoice cache covers ${esc(P.coverage.from)} to ${esc(P.coverage.to)}, so this window is complete.`
    : `<strong>The cache starts ${esc(P.coverage.from)}</strong>, after this window begins, so patients who
       spent early are ranked too low.`}</p>

    <div class="tg-sum">
      <div class="tg-s inj"><div class="l">Patients billed in range</div><div class="p">${fmt(F.total)}</div>
        <div class="n">${F.provable ? `${fmt(F.firstTime)} new · ${fmt(F.repeated)} returning` : 'split not provable'}</div></div>
      <div class="tg-s"><div class="l">Patients ranked ${esc(P.basis.label)}</div><div class="p">${fmt(P.count)}</div>
        <div class="n">${fmt(P.total)} ex-VAT across the ranking window</div></div>
      <div class="tg-s"><div class="l">${esc((P.tiers[0] || {}).name || 'Top tier')}</div><div class="p">${fmt((P.tiers[0] || {}).patients)}</div>
        <div class="n">${pc((P.tiers[0] || {}).spendShare)} of spend from ${pc((P.tiers[0] || {}).patientShare)} of patients</div></div>
      <div class="tg-s"><div class="l">Churned</div><div class="p">${fmt(C.churned)}</div>
        <div class="n">${pc(C.share)} with no invoice in ${C.months} months<br>worth ${fmt(C.revenue)} this year</div></div>
    </div>`;

  /* Tiers. */
  h += `<h3 class="subtitle">Patient category <span class="sm2">${esc(P.basis.label)} spend ex-VAT</span></h3>
    <div class="tw"><table class="ltab"><thead><tr><th>Tier</th><th class="n">From</th>
      <th class="n">Patients</th><th class="n">Share of patients</th><th class="n">Spend ex-VAT</th>
      <th class="n">Share of spend</th><th class="n">Average</th></tr></thead><tbody>`;
  for (const t of P.tiers) {
    h += `<tr><td class="nm">${esc(t.name)}</td><td class="n">${t.from ? fmt(t.from) : '—'}</td>
      <td class="n">${fmt(t.patients)}</td><td class="n">${pc(t.patientShare)}</td>
      <td class="n">${fmt(t.exVat)}</td><td class="n">${pc(t.spendShare)}</td>
      <td class="n">${fmt(t.avgSpend)}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>All</th><th class="n"></th><th class="n">${fmt(P.count)}</th>
    <th class="n">100.0%</th><th class="n">${fmt(P.total)}</th><th class="n">100.0%</th>
    <th class="n">${fmt(P.count ? P.total / P.count : 0)}</th></tr></tfoot></table></div>`;

  /* Home branch. */
  if (HB && HB.branches.length) {
    h += `<h3 class="subtitle">Patient category per branch <span class="sm2">home branch = where they bill most</span></h3>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Branch</th>
        ${HB.tierNames.map((n) => `<th class="n">${esc(n)}</th>`).join('')}
        <th class="n">Patients</th><th class="n">Spend ex-VAT</th></tr></thead><tbody>`;
    for (const b of HB.branches.filter((x) => inScope(x.branch))) {
      h += `<tr><td class="nm">${esc(b.branch)}</td>
        ${HB.tierNames.map((n) => `<td class="n">${b.tiers[n] ? fmt(b.tiers[n]) : '—'}</td>`).join('')}
        <td class="n"><strong>${fmt(b.patients)}</strong></td><td class="n">${fmt(b.exVat)}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }

  /* The funnel. */
  h += `<h3 class="subtitle">Patient funnel</h3>
    <p class="sub"><strong>Once</strong> is a subset of new, not a fourth group: new patients with a
      single invoice all year, who have not come back yet.</p>
    <div class="tg-sum">
      <div class="tg-s inj"><div class="l">New</div><div class="p">${fmt(F.firstTime)}</div>
        <div class="n">${pc(F.total ? F.firstTime / F.total : 0)} of patients billed</div>
        ${bar(F.firstTime, F.total)}</div>
      <div class="tg-s"><div class="l">Repeated</div><div class="p">${fmt(F.repeated)}</div>
        <div class="n">${pc(F.total ? F.repeated / F.total : 0)} billed earlier this year</div>
        ${bar(F.repeated, F.total)}</div>
      <div class="tg-s"><div class="l">Once <span class="sm2">of the new</span></div><div class="p">${fmt(F.once)}</div>
        <div class="n"><strong>${pc(F.onceShareOfNew)}</strong> of new have not returned</div>
        ${bar(F.once, F.firstTime, '#b0503c')}</div>
    </div>
    <div class="tg-note"${F.onceShareOfNew > 0.7 ? ' style="border-left:3px solid #b0503c"' : ''}>
      <strong>${pc(F.onceShareOfNew)} of new patients have not returned.</strong> That is a retention
      number wearing an acquisition number's clothes — the first visit is also the bigger ticket, so
      the money is being spent winning visits that are not being followed by a second one.</div>`;

  /* Acquisition. */
  if (A && A.patients) {
    h += `<h3 class="subtitle">Acquisition per service <span class="sm2">what the new patient bought first</span></h3>
      <p class="sub">Categories on each new patient's first invoice of the year. Shares add above
        100% by design: a first invoice with three categories counts in all three.</p>
      <div class="tw"><table class="ltab"><thead><tr><th>First service category</th>
        <th class="n">New patients</th><th class="n">Share of new</th>
        <th class="n">First-invoice revenue</th><th class="n">Per patient</th></tr></thead><tbody>`;
    for (const c of A.categories.slice(0, 15)) {
      h += `<tr><td class="nm">${esc(c.category)}</td><td class="n">${fmt(c.patients)}</td>
        <td class="n">${pc(c.share)}</td><td class="n">${fmt(c.exVat)}</td>
        <td class="n">${fmt(c.perPatient)}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }

  /* Churn. */
  h += `<h3 class="subtitle">Churned patients <span class="sm2">no invoice in the last ${C.months} months</span></h3>
    <div class="tg-sum">
      <div class="tg-s"><div class="l">Churned</div><div class="p">${fmt(C.churned)}</div>
        <div class="n">${pc(C.share)} of ${fmt(C.allPatients)}<br>last invoice before ${esc(C.cutoff)}</div>
        ${bar(C.churned, C.allPatients, '#b0503c')}</div>
      <div class="tg-s"><div class="l">Their revenue this year</div><div class="p">${fmt(C.revenue)}</div>
        <div class="n">what they were worth before going quiet</div></div>
      <div class="tg-s"><div class="l">Reactivation value</div><div class="p">${fmt(C.perPatient)}</div>
        <div class="n">average per churned patient</div></div>
    </div>`;
  if (!C.provable) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>A ${C.months}-month silence
      cannot be proven against a ${C.cacheDepthMonths}-month cache.</strong> This is an upper bound.</div>`;
  }
  if (C.lastService.length) {
    h += `<h4 class="subtitle">Churned by last service</h4>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Last service category</th>
        <th class="n">Churned patients</th><th class="n">Share</th></tr></thead><tbody>`;
    for (const r of C.lastService.slice(0, 15)) {
      h += `<tr><td class="nm">${esc(r.category)}</td><td class="n">${fmt(r.patients)}</td>
        <td class="n">${pc(r.patients / (C.churned || 1))}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }
  if (C.branches.length) {
    h += `<h4 class="subtitle">Churned by branch</h4>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Branch</th>
        <th class="n">Churned patients</th><th class="n">Their revenue</th>
        <th class="n">Per patient</th></tr></thead><tbody>`;
    for (const b of C.branches.filter((x) => inScope(x.branch))) {
      h += `<tr><td class="nm">${esc(b.branch)}</td><td class="n">${fmt(b.patients)}</td>
        <td class="n">${fmt(b.exVat)}</td>
        <td class="n">${fmt(b.patients ? b.exVat / b.patients : 0)}</td></tr>`;
    }
    h += `</tbody></table></div>
      <p class="sub">A patient billed at more than one branch appears under each, so these rows add
        above the headline count.</p>`;
  }

  /* The extract. Report 01 shipped 2,890 real names and mobiles inside a
     downloadable file and warned against sharing itself; this is the same
     information need met with fifty names and no contact detail. */
  if (P.top.length) {
    h += `<h3 class="subtitle">Top ${P.top.length} by spend</h3>
      <div class="tg-note"><strong>There is no patient extract on this report.</strong>
        The source pack embedded ${fmt(2890)} patient records with names and mobile numbers in the
        file itself. This sends ${P.top.length} names, no mobiles, no addresses — enough to act on a
        VIP list, not enough to leak a database.</div>
      <div class="tw scrolly" style="--minw:820px"><table class="ltab tight"><thead><tr><th class="n">#</th><th>Patient</th>
        <th>Tier</th><th class="n">Spend ex-VAT</th><th class="n">Invoices</th>
        <th class="n">First</th><th class="n">Last</th></tr></thead><tbody>`;
    P.top.forEach((p, i) => {
      h += `<tr><td class="n">${i + 1}</td><td class="nm">${esc(p.name || '—')}</td>
        <td><span class="sev ${p.tier === 'VIP' ? 'attended' : p.tier === 'Premium' ? 'open' : 'lost'}">${esc(p.tier)}</span></td>
        <td class="n">${fmt(p.exVat)}</td><td class="n">${fmt(p.invoices)}</td>
        <td class="n">${esc(p.firstInvoice)}</td><td class="n">${esc(p.lastInvoice)}</td></tr>`;
    });
    h += '</tbody></table></div>';
  }

  h += '</section>';
  $('pat').innerHTML = h;
}

/* ------------------------------------------------------------------ boot --- */

function paint() {
  const D = DATA, X = D.exPackage, P = D.patients;
  $('hPeriod').textContent = `${D.from} → ${D.to}`;
  $('hRev').textContent = fmt(X.ex);
  $('hInv').textContent = fmt(X.invoices);
  $('hTk').textContent = fmt(X.invoices ? X.ex / X.invoices : 0);
  $('hPat').textContent = fmt(P.funnel.total);
  $('rangeline').innerHTML = `<strong>${fmt(X.ex)}</strong> ex-VAT ex-package
    · <strong>${fmt(X.removedEx)}</strong> packages excluded (${fmt(X.removedInvoices)} invoices)
    · <strong>${fmt(X.invoices)}</strong> invoices
    · <strong>${fmt(P.funnel.total)}</strong> patients
    · <strong>${D.mix.categories.length}</strong> categories
    ${X.known ? '' : ' · <span style="color:#b0503c">journal incomplete</span>'}`;
  renderOverview(D); renderBranches(D); renderMix(D); renderPatients(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    DATA = await api(`/api/commercial-sales?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.exPackage.ex)} ex-package`;
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
document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#scope button').forEach((x) => x.classList.toggle('on', x === b));
  SCOPE = b.dataset.scope;
  SLICE = { value: null };
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
