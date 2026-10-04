/* ============================================================
   The branch-commission summary — pace, tracker, and the sheet's own branches.

   These four sections all answer the SAME question — how are branches doing
   against the commission policy — and they all read the same two filters, so
   they live together rather than in four files that each need the filters
   passed in.

   THE FILTERS ARE MODULE STATE, SET FROM ONE PLACE. `setFilters` is the only
   way in, and the controller calls it immediately before rendering. That is a
   deliberate seam: the function bodies below are VERBATIM from `targets.js`,
   and rewriting every `SCOPE` and `MIXBRANCH` reference into an options object
   would have meant editing the inside of four long template literals by hand —
   the one kind of change that looks safe and silently moves a number.

   THE BODIES ARE INDENTED AS THEY WERE, one level shallower than this wrapper,
   for the reason recorded in `tg-dr.js`: re-indenting the source re-indents the
   HTML it emits, and byte-for-byte equality with the original is the only proof
   the move changed nothing.

   Loaded as a plain <script> before the page's own, so `CmSummary` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CmSummary = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  /* The entity switch (All / Nouvel Age / ZAT) and the service-mix branch
     picker. Mirrored from the controller through `setFilters`, never written
     from inside a renderer. */
  let SCOPE = 'all';
  let MIXBRANCH = 'all';
  const inScope = (b) => SCOPE === 'all' || b.entity === SCOPE;
  function setFilters(scope, mixBranch) {
    SCOPE = scope || 'all';
    MIXBRANCH = mixBranch || 'all';
  }

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

function sheetBranch(T) {

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

  return { setFilters, paceCards, paceSection, trackerSection, sheetBranch };
});
