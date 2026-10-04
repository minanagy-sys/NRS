/* Report 04 — the commercial view.
 *
 * The chain from a booking to cash. Everything arrives from
 * /api/commercial-funnel already grouped, so this file draws and does not decide.
 *
 * Two things it does differently from the source pack.
 *
 * The funnel here STARTS at "booked", and says so. The saved report drew a
 * five-step funnel from impressions down to revenue, with the top two steps
 * transcribed from a Supermetrics export and a PBX report that NRS cannot reach.
 * Drawing them from frozen numbers would make the conversion rates look
 * computed when they are stale, so the missing steps are drawn as empty rows
 * with the reason attached. An absent step you can see beats a plausible one
 * you cannot check.
 *
 * And the show rate is given twice. 2,369 of 7,655 August bookings have no
 * outcome recorded, so 44.1% (of everything booked) and 63.8% (of what was
 * resolved) are both true and 19.7 points apart. The source pack printed one.
 */

/* From public/fmt.js — one copy of these for every page. They had drifted
   apart by 2026-10-04 (two `pc`, two `esc`); see that file. */
const { $, fmt, pc, esc } = Fmt;

let DATA = null;
let SCOPE = 'all';
let PDBRANCH = 'all';

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

/* The chain, in order, with the unreachable steps kept in place rather than
   dropped — the gap is the finding. Shared because report 04 draws the chain on
   the funnel tab and computes the biggest leak from it on the ratios tab; two
   copies would drift the moment a step was added. */
function funnelSteps(D) {
  const F = D.funnel, rev = D.revenue;
  const C = D.chain || {};
  return [
    /* Steps 0 and 0b are real now. They were dashed "no source" boxes for as
       long as nothing reached NRS; the Meta cache answers both, and the figures
       come from the same functions report 03 uses so the two pages cannot
       disagree. Whatever is still missing stays in place as an absent step. */
    ...(C.spend ? [{ step: 'Meta ad spend', value: C.spend.spend, unit: 'EGP, paid', of: null, money: true }] : []),
    ...(C.spend ? [{ step: 'Results', value: C.spend.results, unit: 'messages + leads', of: null }] : []),
    ...(C.leads ? [{ step: 'Meta leads', value: C.leads.leads, unit: 'form submissions', of: null }] : []),
    ...D.missingSteps.map((m) => ({ ...m, absent: true })),
    { step: 'Booked', value: F.booked, unit: 'appointments', of: null },
    { step: 'Attended', value: F.totals.attended, unit: 'visits', of: F.booked },
    { step: 'Invoiced', value: rev.known ? rev.invoices : null, unit: 'invoices', of: F.totals.attended },
    { step: 'Revenue ex-VAT', value: rev.known ? rev.ex : null, unit: 'EGP, packages excluded', of: null, money: true },
  ];
}

/* ------------------------------------------------------------- 01 funnel --- */

/* Report 04's chain: six steps, an arrow between each pair carrying the
 * conversion, and the commission base at the bottom.
 *
 * Three of the six have no live source — Meta spend, the lead sheet, and the PBX
 * conversation count — and they are the top three. They are drawn as dashed
 * steps in place, not omitted, because a chain that starts at "booked" claims
 * the top of the funnel is not there rather than not measured. The cost side of
 * this report does not exist yet and the page has to say so where the cost would
 * be, not in a footnote.
 *
 * Step 5 reads the Targets report's own commission base rather than deriving a
 * collection figure here. Two reports disagreeing about the bottom of the funnel
 * is worse than one of them not showing it.
 */
function renderFunnel(D) {
  const F = D.funnel;
  const rev = D.revenue;
  const TR = D.tracker;
  const days = (() => {
    const x = new Date(`${F.measuredFrom}T00:00:00Z`), y = new Date(`${F.to}T00:00:00Z`);
    return Math.max(1, Math.round((y - x) / 86400000) + 1);
  })();

  /* Who booked: the call centre against everyone else. The desks share one
     login, so this splits channel and not person — see the branch tab. */
  const cc = (F.creators || []).filter((c) => /call\s*cent/i.test(c.name))
    .reduce((a, c) => a + c.count, 0);
  const branchBooked = F.booked - cc;

  const M = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : fmt(v));
  const step = (o) => `<div class="fn-step ${o.absent ? 'absent' : `stage-${o.stage}`}">
    <div class="fn-left"><div class="st">${esc(o.st)}</div>
      <div class="nm">${o.nm}</div>
      <div class="ds">${o.ds}</div></div>
    <div class="fn-right"><div class="v">${o.v}</div><div class="p">${o.p}</div></div></div>`;
  const arrow = (t) => `<div class="fn-arrow">&darr; ${t}</div>`;

  let h = `<section>
    <div class="kicker">01 — The chain</div>
    <h2 class="title">From a ringing phone to <em>cash in the bank</em></h2>
    <p class="sub">One chain, ${esc(F.measuredFrom)} → ${esc(F.to)}. Bookings, attendance, revenue
      and cash all come from Odoo 18; ad spend and leads come from Meta through the Marketing
      report, so the two pages cannot disagree about them. The phone is still the one step with
      no source — it is drawn in place rather than dropped, because a chain that starts at
      "booked" claims the top of the funnel is not there rather than not measured.</p>`;

  if (!F.reportable) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>No measurable bookings in this range.</strong> Odoo 18 went live on
      ${esc(F.cutover)}; everything before it is migrated data with every appointment set to
      <code>done</code>, so there is no chain to draw.</div></section>`;
    $('funnel').innerHTML = h;
    return;
  }
  if (F.preCutover) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>Measured from ${esc(F.cutover)}, not ${esc(F.from)}.</strong>
      ${fmt(F.preCutover)} earlier bookings are excluded: the migration set them all to
      <code>done</code>, so including them would report a show rate near 82% and make
      1 August look like a collapse when it is the first month with real outcomes.</div>`;
  }

  h += '<div class="funnel">';

  /* The top of the chain, in report 04's order. Each of the three is drawn as a
     real step where a source now answers and as a dashed one where it does not,
     so the shape of the chain is the same and the gaps are still visible. */
  const CH = D.chain || {};

  if (CH.spend) {
    h += step({
      stage: 0, st: 'Step 0', nm: 'Meta ad spend',
      ds: `<strong>${fmt(CH.spend.results)}</strong> results —
        ${fmt(CH.spend.msgConversations)} messaging contacts + ${fmt(CH.spend.onFbLeads)} on-Facebook leads
        · <strong>${fmt(CH.spend.costPerResult)}</strong> per result${
  CH.spend.daysWithData < CH.spend.daysInRange
    ? ` · <span style="color:#b0503c">${fmt(CH.spend.daysInRange - CH.spend.daysWithData)} of
        ${fmt(CH.spend.daysInRange)} days not synced</span>` : ''}`,
      v: fmt(CH.spend.spend), p: 'EGP, paid Meta',
    });
    h += arrow(`<strong>${fmt(CH.spend.costPerResult)}</strong> per result`);
  }

  if (CH.leads) {
    const w = CH.leads.window || {};
    h += step({
      stage: 0, st: 'Step 0b', nm: 'Meta leads',
      ds: `<strong>${fmt(CH.leads.withKey)}</strong> with a usable mobile
        · <strong>${fmt(CH.leads.booked)}</strong> reached a booking
        · <strong>${fmt(CH.leads.attended)}</strong> attended${
  w.covered === false
    ? ` · <span style="color:#b0503c">only ${esc(w.earliestHeld || '')} onward — Meta keeps
        lead data for about 90 days</span>` : ''}`,
      v: fmt(CH.leads.leads), p: 'form submissions',
    });
    h += arrow(`<strong>${pc(CH.leads.leads ? CH.leads.booked / CH.leads.leads : 0)}</strong>
      of leads reach a booking — a phone-number match, so it counts returning patients too`);
  }

  for (const key of ['spend', 'leads', 'calls']) {
    const m = D.missingSteps.find((x) => x.key === key);
    if (!m) continue;
    h += step({
      absent: true, st: m.st || 'Step', nm: esc(m.step),
      ds: `Needs <strong>${esc(m.source)}</strong>. ${esc(m.reason)}`,
      v: 'no source', p: 'not measured',
    });
    h += arrow('no conversion can be computed across a missing step');
  }

  h += step({
    stage: 2, st: 'Step 2', nm: 'Appointments booked',
    ds: `<strong>${fmt(cc)}</strong> by the contact centre · <strong>${fmt(branchBooked)}</strong> by branches and front office`,
    v: fmt(F.booked), p: 'all channels',
  });
  h += arrow(`show rate <strong>${pc(F.showRate)}</strong> · ${fmt(F.totals.open)} still unresolved`);

  h += step({
    stage: 3, st: 'Step 3', nm: 'Attended visits',
    ds: 'Done, payment received, checked in or in process',
    v: fmt(F.totals.attended), p: `${fmt(F.totals.attended / days)} per day`,
  });
  const perVisit = rev.known && F.totals.attended ? rev.invoices / F.totals.attended : null;
  h += arrow(perVisit === null
    ? 'the invoice join cannot be computed — the journal is incomplete on this range'
    : `<strong>${pc(perVisit)}</strong> of visits produce an invoice`);

  h += step({
    stage: 3, st: 'Step 4',
    nm: `Revenue ex-VAT <span style="font-size:10px;opacity:.75">· ex-package</span>`,
    ds: rev.known
      ? `${fmt(rev.invoices)} service invoices · avg ticket ${fmt(rev.invoices ? rev.ex / rev.invoices : 0)}`
        + ` · <strong>${fmt(rev.removedEx)}</strong> of package sales excluded as a liability`
      : `The journal is on only ${pc(rev.coverage)} of invoices in this range, so packages cannot be excluded.`,
    v: rev.known ? M(rev.ex) : '—',
    p: rev.known ? `${fmt(rev.ex)} EGP` : 'journal incomplete',
  });

  if (TR) {
    const cashVs = rev.known && rev.ex ? (TR.net / rev.ex) : null;
    h += arrow(cashVs === null
      ? 'cash against revenue cannot be computed without the journal'
      : `cash received against revenue <strong>${pc(cashVs)}</strong> · part of it is package prepayment`);
    /* Most of the cash before the Odoo 18 cutover has no branch on it. The chain
       is group-level so it counts all of it, but the Targets report scores per
       branch and will look empty for the same range — saying so here stops that
       reading as two reports disagreeing. */
    const orphanShare = TR.net ? TR.unattributedNet / TR.net : 0;
    h += step({
      stage: 4, st: 'Step 5', nm: 'Net collection ex-VAT',
      ds: `The commission base · <strong>${fmt(TR.txns)}</strong> payments less ${fmt(TR.refunds)} refunds`
        + (orphanShare > 0.02
          ? `<br><strong>${pc(orphanShare)}</strong> of it carries no branch, so the Targets report cannot score branches on this range`
          : ''),
      v: M(TR.net), p: `${fmt(TR.net)} EGP`,
    });
  } else {
    h += arrow('the collection step could not be read for this range');
  }
  h += '</div>';

  /* The two notes report 04 closes the chain with, both recomputed. */
  if (rev.known) {
    h += `<div class="tg-note"><strong>Revenue on this chain excludes package sales.</strong>
      ${fmt(rev.removedEx)} across ${fmt(rev.removedInvoices)} package invoices is cash received
      against sessions not yet delivered — a liability, not revenue, converting as sessions are
      used. The collection step is deliberately left whole: the cash genuinely arrived and the
      policy still measures commission on it. So step 5 sits high relative to step 4 because part
      of that cash belongs to revenue not yet earned.</div>`;
  }
  h += `<div class="tg-note"><strong>Where the chain holds and where it does not.</strong>
    ${fmt(F.booked)} bookings, ${fmt(F.totals.attended)} attended visits${rev.known ? `, ${fmt(rev.invoices)} invoices` : ''}${TR ? `, ${fmt(TR.net)} collected` : ''}.
    Two joints are weak and both are visible above: the top of the chain has no spend or contact
    data at all, and the booking-to-visit joint has <strong>${fmt(F.totals.open)}</strong>
    appointments with no recorded outcome — ${pc(F.totals.open / (F.booked || 1))} of everything
    booked. The ratios tab works that queue.</div>
  </section>`;

  $('funnel').innerHTML = h;
}

/* ------------------------------------------------------------- 02 ratios --- */

/* Report 04's ratios tab, in its own shape: eight cards, then where the chain
 * leaks, then the unresolved queue in full.
 *
 * Two of the eight need the PBX conversation count — "conversations per booking"
 * and "revenue per conversation" — and NRS has no PBX feed. They keep their
 * positions and render as an explicit hole rather than being dropped, for the
 * same reason the funnel's missing steps do: a six-card grid would read as the
 * complete set of ratios, and these two are the ones that price the top of the
 * funnel.
 *
 * Report 04 makes "revenue per conversation" its accent card. Here the accent
 * moves to "revenue per visit" — same numerator, a denominator that exists. An
 * accent card drawing the eye to a blank is worse than one drawing it to the
 * nearest true thing, and the note under the grid says the substitution happened.
 */
function renderRatios(D) {
  const F = D.funnel;
  const rev = D.revenue;
  const C = D.collections;
  const TR = D.tracker;

  if (!F.reportable) {
    $('ratios').innerHTML = `<section><div class="kicker">02 — The ratios</div>
      <h2 class="title">Nothing to divide</h2>
      <p class="sub">No measurable bookings in this range — see the funnel tab.</p></section>`;
    return;
  }

  const attended = F.totals.attended;
  const days = (() => {
    const a = new Date(`${F.measuredFrom}T00:00:00Z`), b = new Date(`${F.to}T00:00:00Z`);
    return Math.max(1, Math.round((b - a) / 86400000) + 1);
  })();
  const collEx = C ? C.net / 1.14 : null;

  /* The eight, in report 04's order. `value: null` means no source. */
  const CARDS = [
    {
      label: 'Conversations per booking', value: null, unit: '',
      sub: 'Needs the PBX conversation count, which NRS has no feed for.',
      absent: true,
    },
    {
      /* Report 04 prints one show rate and notes the queue distorts it. Both
         denominators go in the sub-line instead: 44.1% of everything booked and
         63.8% of what was actually resolved are 19.7 points apart, and which one
         you mean is a choice, not a rounding. The card keeps report 04's headline
         so the tab still reads the same. */
      label: 'Show rate', value: (F.showRate * 100).toFixed(1), unit: '%',
      sub: `Policy KPI floor <strong>${pc(F.policyFloor, 0)}</strong> · `
        + `<span class="${F.showRate >= F.policyFloor ? 'up' : 'down'}">`
        + `${F.showRate >= F.policyFloor ? 'met' : 'below'}</span><br>`
        + `<strong>${pc(F.showRateResolved)}</strong> of resolved bookings only — `
        + `the ${fmt(F.totals.open)} with no outcome distort it`,
    },
    {
      label: 'Invoices per visit',
      value: rev.known && attended ? (rev.invoices / attended).toFixed(2) : null, unit: '',
      sub: 'Service invoices only · packages excluded',
    },
    {
      label: 'Revenue per conversation', value: null, unit: '',
      sub: 'Revenue ex-package ÷ voice conversations — the PBX half is missing.',
      absent: true,
    },
    {
      label: 'Revenue per visit',
      value: rev.known && attended ? fmt(rev.ex / attended) : null, unit: 'EGP',
      sub: 'True unit economics · ex-package', accent: true,
    },
    {
      label: 'Cash vs revenue',
      value: collEx !== null && rev.known && rev.ex ? ((collEx / rev.ex) * 100).toFixed(1) : null, unit: '%',
      sub: 'Collected ex-VAT ÷ revenue ex-package',
    },
    {
      label: 'Avg ticket',
      value: rev.known && rev.invoices ? fmt(rev.ex / rev.invoices) : null, unit: 'EGP',
      sub: rev.known ? `${fmt(rev.invoices)} service invoices` : 'journal incomplete',
    },
    {
      /* Two denominators, and which one is honest depends on the range. A single
         OPEN month has to divide the projected pool by the projected collection,
         because neither has landed. Anything closed, or spanning months, divides
         the pools actually earned by the cash actually banked — and both sides
         must cover the SAME range, which is why this reads the range roll-up
         rather than the last month's. */
      label: 'Commission cost',
      value: (() => {
        if (!TR) return null;
        const single = TR.monthsCovered === 1;
        if (!TR.closed && single && TR.latestProjected) {
          return ((TR.latestPoolRun / TR.latestProjected) * 100).toFixed(2);
        }
        return TR.net ? ((TR.pool / TR.net) * 100).toFixed(2) : null;
      })(), unit: '%',
      sub: (() => {
        if (!TR) return 'The tracker did not answer for this range.';
        const single = TR.monthsCovered === 1;
        if (!TR.closed && single) {
          return `Projected pools ÷ projected collection · policy ${esc(TR.policyVersion || '—')}`;
        }
        return `Pools ÷ collection over ${TR.monthsCovered === 1 ? 'the month' : `all ${TR.monthsCovered} months`}`
          + ` · policy ${esc(TR.policyVersion || '—')}`;
      })(),
    },
  ];

  let h = `<section>
    <div class="kicker">02 — The ratios</div>
    <h2 class="title">${fmt(days)} day${days === 1 ? '' : 's'} in <em>eight numbers</em></h2>
    <p class="sub">Every ratio below is computed from the same sources as the funnel. These are the
      numbers to watch month over month; the absolute values matter less than their direction.</p>
    <div class="kpi-grid">`;
  for (const c of CARDS) {
    const cls = c.absent ? 'kpi absent' : c.accent ? 'kpi accent' : 'kpi';
    h += `<div class="${cls}">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${c.value === null ? (c.absent ? 'no source' : '—') : c.value}${
  c.value !== null && c.unit ? `<span class="kpi-unit">${esc(c.unit)}</span>` : ''}</div>
      <div class="kpi-sub">${c.sub}</div></div>`;
  }
  h += `</div>
    <div class="tg-note"><strong>Two of the eight have no source.</strong> Both divide by the PBX
      conversation count, and no PBX feed reaches NRS — so they are shown as holes rather than
      dropped, because a six-card grid would read as the whole set. Report 04 makes
      <em>revenue per conversation</em> its headline card; the accent here sits on
      <em>revenue per visit</em> instead — the same numerator over a denominator that exists.</div>`;

  /* Where the chain leaks. The biggest single drop between two measurable steps —
     the one place a point of improvement is worth most. Computed only across
     steps that HAVE numbers, so a missing Meta step cannot masquerade as the
     worst leak in the funnel. */
  if (F.reportable) {
    const measured = funnelSteps(D).filter((x) => !x.absent && x.of && x.value !== null);
    if (measured.length) {
      const worst = measured.reduce((a, b) => ((b.value / b.of) < (a.value / a.of) ? b : a));
      const lost = worst.of - worst.value;
      h += `<h3 class="subtitle">Where the chain leaks</h3>
        <div class="tg-note" style="border-left:3px solid #b0503c">
          <strong>${esc(worst.of === F.booked ? 'Booked' : 'Attended')} → ${esc(worst.step)}
          loses ${fmt(lost)}</strong> — only ${pc(worst.value / worst.of)} carry through, the
          weakest measurable step in the chain. ${D.missingSteps.length} earlier step${D.missingSteps.length === 1 ? '' : 's'}
          ${D.missingSteps.length === 1 ? 'has' : 'have'} no source, so a bigger leak may sit
          above this one and simply not be visible yet.</div>`;
    }
  }

  /* The unresolved queue, in report 04's own shape: branch chips, the call list
     with a CSV button, then the two rollups.

     This table carries patient names and dialable mobile numbers. That is a
     deliberate change from the masked version this page used to show — a queue of
     thousands of bookings nobody can ring is a report about a problem, not the
     list somebody works through. Report 04 makes the same call and prints the
     same warning beside it, which is why the banner below is part of the section
     rather than a footnote at the bottom of the page. */
  const P = D.pending, OS = F.openByService, OQ = F.openQuality;
  if (P && P.total) {
    /* Alphabetical, like report 04's chip row — the chips are for finding your own
       branch, and a list ordered by how badly it is doing makes that a search.
       The rollup below IS ordered by size, where ranking is the point. */
    const branches = [...F.branches].filter((b) => inScope(b.name) && b.open > 0)
      .map((b) => b.name).sort((x, y) => x.localeCompare(y));
    if (PDBRANCH !== 'all' && !branches.includes(PDBRANCH)) PDBRANCH = 'all';
    const rows = P.rows.filter((r) => inScope(r.branchName)
      && (PDBRANCH === 'all' || r.branchName === PDBRANCH));

    h += `<h3 class="subtitle">Appointments with no recorded outcome
        <span class="tag">${fmt(P.total)} rows · Odoo 18</span></h3>
      <p class="sub">Booked, the date passed, and nobody wrote back what happened — not attended,
        not cancelled, not rescheduled.
        ${OQ ? `${fmt(OQ.withMobile)} of them (${pc(OQ.mobileShare)}) have a reachable mobile, so this is
          a working call list rather than a report.` : ''}</p>`;

    if (OQ) {
      const half = F.booked ? (F.totals.attended + OQ.total / 2) / F.booked : 0;
      h += `<div class="kpi-grid">
        <div class="kpi accent"><div class="kpi-label">Unresolved appointments</div>
          <div class="kpi-value">${fmt(OQ.total)}</div>
          <div class="kpi-sub">${pc(OQ.total / (F.booked || 1))} of everything booked in the window</div></div>
        <div class="kpi"><div class="kpi-label">With a mobile</div>
          <div class="kpi-value">${fmt(OQ.withMobile)}</div>
          <div class="kpi-sub">${pc(OQ.mobileShare)} callable today</div></div>
        <div class="kpi"><div class="kpi-label">With a service recorded</div>
          <div class="kpi-value">${fmt(OQ.withService)}</div>
          <div class="kpi-sub"><span class="down">${pc(1 - OQ.serviceShare)}</span> have no service on the booking at all</div></div>
        <div class="kpi"><div class="kpi-label">Show-rate effect if half attended</div>
          <div class="kpi-value">${(half * 100).toFixed(1)}<span class="kpi-unit">%</span></div>
          <div class="kpi-sub">against ${pc(F.showRate)} today and a ${pc(F.policyFloor, 0)} policy floor</div></div>
      </div>`;
    }

    h += '<div class="chips" id="pdFilter">'
      + `<button type="button" class="chip${PDBRANCH === 'all' ? ' on' : ''}" data-pd="all">All</button>`
      + branches.map((b) => `<button type="button" class="chip${PDBRANCH === b ? ' on' : ''}" data-pd="${esc(b)}">${esc(b)}</button>`).join('')
      + '</div>';

    const csvQ = new URLSearchParams({ from: D.from, to: D.to });
    if (PDBRANCH !== 'all') csvQ.set('branch', PDBRANCH);

    h += `<div class="listcard">
      <div class="listcard-head">
        <h3>Unresolved appointments · <b>${fmt(PDBRANCH === 'all' ? P.total : rows.length)}</b>${
  PDBRANCH === 'all' ? '' : ` <span class="sm2">${esc(PDBRANCH)}</span>`}</h3>
        <a class="btn ghost" href="/api/commercial/unresolved.csv?${csvQ}">Download CSV</a>
      </div>
      <div class="tw scrolly"><table class="ltab tight"><thead><tr>
        <th>Patient</th><th>Mobile</th><th>Service</th><th class="n">Appointment date</th>
        <th>Branch</th><th>Doctor</th><th>Booked by</th><th class="n">Created</th>
      </tr></thead><tbody>`;
    for (const r of rows) {
      h += `<tr><td class="nm">${esc(r.patient || '—')}</td>
        <td>${r.mobile ? `<span class="mob">${esc(r.mobile)}</span>` : '<span class="mob none">—</span>'}</td>
        <td>${r.service ? esc(r.service) : '<span class="nosvc">not recorded</span>'}</td>
        <td class="n">${esc(r.date)}</td>
        <td>${esc(r.branchName || 'Unassigned')}</td>
        <td>${esc(r.specialistName || '—')}</td>
        <td>${esc(r.createdBy || '—')}</td>
        <td class="n">${esc(r.createdAt || '—')}</td></tr>`;
    }
    if (!rows.length) {
      h += '<tr><td colspan="8" style="color:var(--muted);font-size:12.5px">Nothing unresolved for this branch in the range.</td></tr>';
    }
    h += `</tbody></table></div></div>
      <div class="tg-note">The card holds the first ${fmt(P.returned)} rows — scroll inside it;
        the CSV holds all ${fmt(P.total)} with patient, mobile, service, appointment date, branch,
        doctor, who created it and when. Filter by branch first if you want to hand a branch its
        own list — the file is named for the branch so two managers cannot be given each
        other's.</div>`;

    if (P.sensitive) {
      h += `<div class="pii"><strong>This list contains patient names and mobile numbers.</strong>
        It is a call list for the team who will work it, not a document to circulate. Everything
        here is behind this app's sign-in; the CSV, once downloaded, is not. Filter by branch and
        send each manager only their own file rather than forwarding the whole export.</div>`;
    }

    h += '<div class="twocol">';
    const brRows = [...F.branches].filter((b) => inScope(b.name) && b.open > 0)
      .sort((x, y) => y.open - x.open);
    const brMax = brRows.reduce((m, b) => Math.max(m, b.open), 0);
    h += `<div class="pcard"><div class="pcard-head"><h4>Unresolved by branch</h4>
        <span class="hint">of its own bookings</span></div>
      <div class="pcard-body">${brRows.length ? `<div class="blist">${brRows.map((b) => `
        <div class="blist-row"><span class="nm" title="${esc(b.name)}">${esc(b.name)}</span>
          <span class="tr"><i style="width:${Math.min(100, brMax ? (b.open / brMax) * 100 : 0).toFixed(1)}%"></i></span>
          <span class="vv">${fmt(b.open)}<small>${pc(b.open / (b.booked || 1))}</small></span></div>`).join('')}</div>`
    : '<div class="empty">Nothing unresolved in scope.</div>'}</div></div>`;

    const svcRows = OS ? OS.rows.slice(0, 12) : [];
    const svcMax = svcRows.reduce((m, r) => Math.max(m, r.count), 0);
    h += `<div class="pcard"><div class="pcard-head"><h4>Unresolved by service</h4>
        <span class="hint">of all unresolved</span></div>
      <div class="pcard-body">${svcRows.length ? `<div class="blist">${svcRows.map((r) => `
        <div class="blist-row"><span class="nm" title="${esc(r.category)}">${esc(r.category)}</span>
          <span class="tr"><i style="width:${Math.min(100, svcMax ? (r.count / svcMax) * 100 : 0).toFixed(1)}%${
  /no service/i.test(r.category) ? ';background:#b0503c' : ''}"></i></span>
          <span class="vv">${fmt(r.count)}<small>${pc(r.share)}</small></span></div>`).join('')}</div>`
    : '<div class="empty">No service breakdown available.</div>'}</div></div>`;
    h += '</div>';

    if (OS && OS.noService) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${fmt(OS.noService)} of the ${fmt(OS.total)} have no service recorded on the
        booking.</strong> That is the same gap in a different place: an appointment with no outcome
        <em>and</em> no service is not really a booking, it is a placeholder. Whoever clears this
        queue should be told to record both — the service field is what makes the row usable for
        the acquisition analysis on Commercial Sales.</div>`;
    }
  }

  h += '</section>';
  $('ratios').innerHTML = h;
}

/* ---------------------------------------------------------- 03 by branch --- */

function renderByBranch(D) {
  const F = D.funnel;
  if (!F.reportable) {
    $('bybranch').innerHTML = `<section><div class="kicker">03 — Branch by branch</div>
      <h2 class="title">Nothing to compare</h2>
      <p class="sub">No measurable bookings in this range — see the funnel tab.</p></section>`;
    return;
  }

  const rows = F.branches.filter((b) => inScope(b.name));
  const hidden = hiddenNote(F.branches.map((b) => b.name));
  const tot = rows.reduce((a, b) => ({
    booked: a.booked + b.booked, attended: a.attended + b.attended,
    lost: a.lost + b.lost, open: a.open + b.open,
  }), { booked: 0, attended: 0, lost: 0, open: 0 });

  let h = `<section>
    <div class="kicker">03 — Branch by branch</div>
    <h2 class="title">${rows.length} branch${rows.length === 1 ? '' : 'es'}</h2>
    <p class="sub">Sorted by bookings. The unresolved column is the one to read first:
      a branch with a low show rate and a high open share has a bookkeeping problem,
      not necessarily an attendance problem.</p>
    ${hidden}
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Booked</th><th class="n">Attended</th>
      <th class="n">Show rate</th><th class="n">Lost</th><th class="n">Unresolved</th><th class="n">Open share</th></tr></thead><tbody>`;
  for (const b of rows) {
    const open = b.open / (b.booked || 1);
    h += `<tr><td>${esc(b.name || 'Unassigned')}</td>
      <td class="n">${fmt(b.booked)}</td><td class="n">${fmt(b.attended)}</td>
      <td class="n">${pc(b.attended / (b.booked || 1))}</td>
      <td class="n">${fmt(b.lost)}</td><td class="n">${fmt(b.open)}</td>
      <td class="n"><span class="sev ${open > 0.4 ? 'lost' : open > 0.25 ? 'open' : 'attended'}">${pc(open)}</span></td></tr>`;
  }
  h += `</tbody><tfoot><tr><th>Total</th><th class="n">${fmt(tot.booked)}</th>
    <th class="n">${fmt(tot.attended)}</th><th class="n">${pc(tot.attended / (tot.booked || 1))}</th>
    <th class="n">${fmt(tot.lost)}</th><th class="n">${fmt(tot.open)}</th>
    <th class="n">${pc(tot.open / (tot.booked || 1))}</th></tr></tfoot></table></div>`;

  /* Who books, not who performs — the distinction the policy gets wrong. */
  /* Re-aggregated from the per-branch rows so the entity filter reaches this
     table too. It previously read F.creators, which is group-wide, so switching
     to ZAT left every booking desk on screen while the branch table above it
     shrank to two rows. */
  const creators = Object.values(F.creatorRows
    .filter((r) => inScope(r.branch))
    .reduce((acc, r) => {
      (acc[r.name] ||= { name: r.name, count: 0 }).count += r.count;
      return acc;
    }, {})).sort((a, b) => b.count - a.count);
  const creatorTot = creators.reduce((a, c) => a + c.count, 0);

  if (creators.length) {
    h += `<h3 class="subtitle">Who created the bookings</h3>
      <p class="sub">This is the login that entered the booking, which is a desk and not a
        person: the call centre shares one account. It is enough to split call-centre
        bookings from branch-entered ones, and not enough to attribute a booking to
        an individual agent — which is why the policy's per-agent reactivation bonus
        cannot be computed from this.</p>
      <div class="tw"><table class="ltab"><thead><tr><th>Created by</th><th class="n">Bookings</th><th class="n">Share</th></tr></thead><tbody>`;
    for (const c of creators.slice(0, 15)) {
      h += `<tr><td>${esc(c.name)}</td><td class="n">${fmt(c.count)}</td><td class="n">${pc(c.count / (creatorTot || 1))}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }

  const specialists = Object.values(F.specialistRows
    .filter((r) => inScope(r.branch))
    .reduce((acc, r) => {
      const x = (acc[r.name] ||= { name: r.name, booked: 0, attended: 0, lost: 0, open: 0 });
      x.booked += r.count; x[r.group] += r.count;
      return acc;
    }, {})).sort((a, b) => b.booked - a.booked);

  if (specialists.length) {
    h += `<h3 class="subtitle">By specialist</h3>
      <div class="tw"><table class="ltab"><thead><tr><th>Specialist</th><th class="n">Booked</th><th class="n">Attended</th>
        <th class="n">Show rate</th><th class="n">Unresolved</th></tr></thead><tbody>`;
    for (const s of specialists.slice(0, 25)) {
      h += `<tr><td>${esc(s.name || 'Unassigned')}</td><td class="n">${fmt(s.booked)}</td>
        <td class="n">${fmt(s.attended)}</td><td class="n">${pc(s.attended / (s.booked || 1))}</td>
        <td class="n">${fmt(s.open)}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }

  /* Report 04's last section. The two derived reads it leads with are the repeat
     share of SALES — not of patients — and the ticket gap. */
  const PF = D.patientFunnel;
  if (PF && PF.branches.length) {
    const pfRows = PF.branches.filter((b) => inScope(b.branch));
    h += `<h3 class="subtitle">Repeated versus new, with the sales attached
        <span class="sm2">invoiced ex-VAT</span></h3>
      <p class="sub">A branch can be half new patients and still take most of its money from
        returning ones, so the share of <em>patients</em> and the share of <em>sales</em> are
        two different questions. Both are here.</p>
      <div class="tw"><table class="ltab tight"><thead><tr><th>Branch</th><th class="n">Billed</th>
        <th class="n">New</th><th class="n">Repeated</th><th class="n">Repeat share of patients</th>
        <th class="n">Repeat share of sales</th><th class="n">Ticket · new</th>
        <th class="n">Ticket · repeated</th><th class="n">Gap</th></tr></thead><tbody>`;
    for (const b of pfRows) {
      h += `<tr><td class="nm">${esc(b.branch)}</td><td class="n">${fmt(b.total)}</td>
        <td class="n">${fmt(b.firstTime)}</td><td class="n">${fmt(b.repeated)}</td>
        <td class="n">${pc(b.repeatShare)}</td>
        <td class="n"><strong>${pc(b.repeatSalesShare)}</strong></td>
        <td class="n">${fmt(b.ticketNew)}</td><td class="n">${fmt(b.ticketRepeated)}</td>
        <td class="n"><b class="${b.ticketGap >= 0 ? 'g' : 'r'}">${b.ticketGap >= 0 ? '+' : ''}${fmt(b.ticketGap)}</b></td></tr>`;
    }
    h += '</tbody></table></div>';

    const gaps = pfRows.filter((b) => b.total >= 20);
    const positive = gaps.filter((b) => b.ticketGap > 0).length;
    if (gaps.length) {
      h += `<div class="tg-note"${positive === gaps.length ? ' style="border-left:3px solid #c98a2e"' : ''}>
        <strong>${positive === gaps.length
    ? 'A first visit is the bigger ticket at every branch.'
    : `${positive} of ${gaps.length} branches take more per new patient than per returning one.`}</strong>
        The gap is stated as report 04 states it, new minus repeated, and it comes out positive —
        which is the opposite of the usual assumption that returning patients are worth more.
        Read alongside the Patients report: ${PF.firstTime ? pc(PF.onceShareOfNew) : '—'} of new
        patients have not come back, so the expensive first visit is mostly not being followed by
        a second one.</div>`;
    }
  }

  h += '</section>';
  $('bybranch').innerHTML = h;
}

/* ------------------------------------------------------------------ boot --- */

function paint() {
  const D = DATA, F = D.funnel;
  $('hPeriod').textContent = `${F.measuredFrom} → ${F.to}`;
  $('hBook').textContent = fmt(F.booked);
  $('hAtt').textContent = fmt(F.totals.attended);
  $('hShow').textContent = F.reportable ? pc(F.showRate) : '—';
  $('hPend').textContent = fmt(F.totals.open);
  $('rangeline').innerHTML = `<strong>${F.reportable ? `${fmt(F.booked)} bookings` : 'not measurable'}</strong>
    · show rate <strong>${F.reportable ? pc(F.showRate) : '—'}</strong> of booked,
      <strong>${F.reportable ? pc(F.showRateResolved) : '—'}</strong> of resolved
    · <strong>${fmt(F.totals.open)}</strong> unresolved
    · revenue ${D.revenue.known ? `<strong>${fmt(D.revenue.ex)}</strong> ex-VAT` : '<span style="color:#b0503c">journal incomplete</span>'}
    · <span style="color:#b0503c">${D.missingSteps.length} funnel step(s) have no source</span>`;
  renderFunnel(D); renderRatios(D); renderByBranch(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    DATA = await api(`/api/commercial-funnel?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.funnel.booked)} bookings`;
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
/* Delegated: the chips live inside a panel that is rebuilt on every repaint. */
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-pd]') : null;
  if (!t) return;
  PDBRANCH = t.dataset.pd;
  if (DATA) renderRatios(DATA);
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
