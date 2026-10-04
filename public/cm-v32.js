/* ============================================================
   What everyone earns — the v3.2 commission, drawn.

   THREE POPULATIONS, PAID THREE DIFFERENT WAYS, and the panel keeps them apart
   because adding them up without saying so is how a forecast becomes a quoted
   commitment:

     BRANCH TEAMS   collected ex-VAT, paced to a full month, picks a tier and a
                    level; the cell is the team's pool; a person gets their
                    weight's share of it.
     DOCTORS        a rate on what they invoiced, plus the scheme's fixed basic,
                    plus a management fee, plus hours where payroll exists.
     MANAGEMENT     a percentage of the branch pools, but only if a gate passes.
                    A failed gate pays exactly zero, and the row says which gate.

   NOTHING IS PAYABLE UNTIL A MONTH CLOSES. A running month is scored at the
   rate it is running and labelled a forecast on every row that carries one. The
   headline separates payable from forecast rather than summing them.

   Loaded as a plain <script> before the page's own, so `CmV32` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CmV32 = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const mName = (m) => `${MONTHS[(m.month || 1) - 1]} ${m.year}`;
  const short = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${Math.round(v / 1e3)}K`;
    return fmt(v);
  };
  const tierLab = (t) => (t ? `${short(t.from)} – ${t.to == null ? 'above' : short(t.to)}` : '—');
  const tone = (a, floor) => (a == null ? '' : (a >= 1 ? 'g' : (a >= floor ? 'a' : 'r')));

  /* ---------------------------------------------------------- 01 summary */

  function summary(C) {
    if (!C || C.missing) {
      return `<section><div class="kicker">Commission — Summary</div>
        <h2 class="title">No v3.2 policy is stored</h2>
        <div class="tg-note" style="border-left:3px solid #b0503c">${esc((C && C.missing) || 'Nothing to score with.')}
        Import it with <code>node scripts/import-targets-html.js --write</code>.</div></section>`;
    }
    const T = C.totals;
    const floor = C.policy.levels.length ? C.policy.levels[0].fromPct : 0.8;
    const open = T.openMonths > 0;

    let h = `<section>
      <div class="kicker">Commission — Summary</div>
      <h2 class="title">What everyone earns · ${C.months.map(mName).join(', ') || '—'}</h2>
      <p class="sub">${esc(C.note)}</p>`;

    h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Total commission</div>
        <div class="kpi-value">${fmt(T.all)}</div>
        <div class="kpi-sub"><span class="pill">${T.collected ? pc(T.all / T.collected) : '—'}</span>
          of collected${open ? ' · includes forecast' : ' · all payable'}</div></div>
      <div class="kpi"><div class="kpi-label">Branch teams</div>
        <div class="kpi-value sm">${short(T.branchPool)}</div>
        <div class="kpi-sub">${C.months.reduce((a, m) => a + m.totals.earning, 0)} of
          ${C.months.reduce((a, m) => a + m.totals.branches, 0)} branch-months earn</div></div>
      <div class="kpi"><div class="kpi-label">Doctors</div>
        <div class="kpi-value sm">${short(T.doctors)}</div>
        <div class="kpi-sub">commission, fixed and fees${
  T.doctorParts.hours ? ', hours' : ' · no hours without payroll'}</div></div>
      <div class="kpi"><div class="kpi-label">Management</div>
        <div class="kpi-value sm">${short(T.management)}</div>
        <div class="kpi-sub">${C.months.reduce((a, m) => a + m.totals.gatesPassed, 0)} of
          ${C.months.reduce((a, m) => a + m.totals.gates, 0)} gates passed</div></div>
    </div>`;

    if (open) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${fmt(T.payable)} is payable; ${fmt(T.forecast)} is a forecast.</strong>
        ${T.openMonths} month${T.openMonths === 1 ? ' is' : 's are'} still running, scored at the
        rate ${T.openMonths === 1 ? 'it is' : 'they are'} running. Nothing in a running month is
        owed until it closes.</div>`;
    }

    /* ---- the branch teams ---- */
    for (const M of C.months) {
      h += `<h3 class="subtitle">Branch teams · ${mName(M)}
        <span class="vat-tag">collected ex-VAT</span></h3>
        <p class="cp-desc">Collected against the month target gives the <strong>level</strong>;
          collected gives the <strong>revenue tier</strong>; the cell where they meet is the team's
          pool, shared by weight. ${M.pace.closed
    ? 'This month is closed, so these are payable.'
    : `Day ${M.pace.lastDay} of ${M.pace.days} — each figure is paced to a full month, weighted by
       weekday, and is a forecast.`}</p>
        <div class="tw scrolly" style="--minw:${820 + C.policy.roles.length * 110}px;--h:460px">
        <table class="ltab tight sticky1"><thead><tr>
          <th>Branch</th><th class="n">Collected</th><th class="n">Month target</th>
          <th class="n">Achieved</th><th class="n">Level</th><th class="n">Revenue tier</th>
          <th class="n">Pool</th>
          ${C.policy.roles.map((r) => `<th class="n">${esc(r.role)} each</th>`).join('')}
        </tr></thead><tbody>
        ${M.branches.map((b) => `<tr>
          <td class="nm">${esc(b.branch)}
            <span class="sm2">${esc(mName(M))}${b.closed ? '' : ' · forecast at current pace'}</span></td>
          <td class="n">${fmt(b.collected)}${b.closed ? '' : `<span class="sm2">pace ${fmt(b.paced)}</span>`}</td>
          <td class="n">${b.target == null ? '<span class="sm2">no target</span>' : fmt(b.target)}</td>
          <td class="n"><span class="pill ${tone(b.achievement, floor)}">${b.achievement == null ? '—' : pc(b.achievement, 0)}</span></td>
          <td class="n">${b.level == null ? '<span class="sm2">below the floor</span>' : `${b.level}%`}</td>
          <td class="n"><span class="sm2">${esc(tierLab(b.tier))}</span></td>
          <td class="n"><strong>${fmt(b.pool)}</strong></td>
          ${C.policy.roles.map((r) => {
    const s = b.split.find((x) => x.role === r.role);
    return `<td class="n">${s && s.each ? fmt(s.each) : '<span class="sm2">—</span>'}</td>`;
  }).join('')}
        </tr>`).join('')}
        </tbody><tfoot><tr><th>All</th>
          <th class="n">${fmt(M.totals.collected)}</th>
          <th class="n">${M.totals.target == null ? '—' : fmt(M.totals.target)}</th>
          <th class="n"></th><th class="n"></th><th class="n"></th>
          <th class="n">${fmt(M.totals.pool)}</th>
          ${C.policy.roles.map(() => '<th class="n"></th>').join('')}
        </tr></tfoot></table></div>`;

      /* A branch below the floor earns nothing, and the reason is worth one
         line — "below the floor" on its own reads like a missing number. */
      const bare = M.branches.filter((b) => !b.pool && b.target);
      if (bare.length) {
        h += `<div class="tg-note">${bare.length} branch${bare.length === 1 ? '' : 'es'} earned nothing:
          ${bare.map((b) => `<strong>${esc(b.branch)}</strong> at ${b.achievement == null ? '—' : pc(b.achievement, 0)}`).join(', ')}.
          The policy pays from ${pc(floor, 0)} of target; below that the pool is zero, not small.</div>`;
      }

      /* ---- management, per month ---- */
      h += `<h3 class="subtitle">Management · ${mName(M)}</h3>
        <div class="tw scrolly" style="--minw:720px;--h:320px"><table class="ltab tight"><thead><tr>
          <th>Role</th><th>Scope</th><th class="n">Branches earning</th><th class="n">Needs</th>
          <th class="n">Rate</th><th class="n">Base pool</th><th class="n">Earned</th>
        </tr></thead><tbody>
        ${M.management.map((g) => `<tr>
          <td class="nm">${esc(g.role)}</td>
          <td>${esc(g.scope)}</td>
          <td class="n">${g.hit}</td>
          <td class="n">${g.need || '—'}${g.groupNeed ? ` <span class="sm2">or ${pc(g.groupNeed, 0)} group</span>` : ''}</td>
          <td class="n">${pc(g.rate, 0)}</td>
          <td class="n">${fmt(g.base)}</td>
          <td class="n">${g.pass ? `<strong>${fmt(g.earned)}</strong>`
    : `<span class="sm2">0 — ${esc(g.why || 'the gate did not pass')}</span>`}</td>
        </tr>`).join('')}
        </tbody></table></div>`;
    }

    /* ---- the grid itself, so a reader can see where a pool came from ---- */
    h += `<h3 class="subtitle">The pool grid <span class="vat-tag">${esc(C.version)}</span></h3>
      <p class="cp-desc">Collected picks the row, achievement picks the column. Split
        ${C.policy.roles.map((r) => `${esc(r.role)} &times;${r.people} at ${pc(r.share, 1)}`).join(' · ')}.</p>
      <div class="tw scrolly" style="--minw:560px;--h:400px"><table class="ltab tight"><thead><tr>
        <th>Collected ex-VAT</th>${C.policy.levels.map((l) => `<th class="n">${l.level}%</th>`).join('')}
      </tr></thead><tbody>
      ${C.policy.tiers.map((t) => `<tr><td class="nm">${esc(tierLab(t))}</td>
        ${t.pools.map((v) => `<td class="n">${v ? fmt(v) : '<span class="sm2">—</span>'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;

    return `${h}</section>`;
  }

  /* ------------------------------------------------------------ 03 staff */

  function staff(C) {
    if (!C || C.missing) return '<section><h2 class="title">No policy stored</h2></section>';
    let h = `<section>
      <div class="kicker">Commission — Staff</div>
      <h2 class="title">Branch staff, person by person</h2>
      <p class="sub">Each person's share of their branch's pool, from the headcount and weights in
        the policy. Real names appear where somebody has entered them in
        <a href="/admin">Admin → Commission</a>; where they have not, the seat is shown instead —
        the share is right either way, but a payslip addressed to "Reception 1" cannot be paid.</p>`;

    let named = 0;
    let seats = 0;
    for (const M of C.months) {
      const earning = M.branches.filter((b) => b.pool > 0);
      h += `<h3 class="subtitle">${mName(M)}
        <span class="vat-tag">${earning.length} branch${earning.length === 1 ? '' : 'es'} earning</span></h3>`;
      if (!earning.length) {
        h += `<div class="tg-note">No branch reached the floor in ${esc(mName(M))}, so no staff
          commission is due. That is a zero, not a gap.</div>`;
        continue;
      }
      for (const b of earning) {
        h += `<div class="acc open"><div class="acc-h">
          <div class="acc-name">${esc(b.branch)}</div>
          <div class="acc-meta">pool <strong>${fmt(b.pool)}</strong> ·
            ${b.level}% of ${fmt(b.target)}${b.closed ? '' : ' · forecast'}</div></div>
          <div class="acc-b"><table class="ltab tight"><thead><tr>
            <th>Person</th><th>Role</th><th class="n">Weight</th><th class="n">Share</th>
            <th class="n">Amount</th></tr></thead><tbody>`;
        for (const s of b.split) {
          for (let i = 0; i < Math.max(s.people.length, s.seats || 0); i++) {
            const p = s.people[i];
            if (p) named += 1; else seats += 1;
            h += `<tr><td class="nm">${p ? esc(p.name)
              : `<span class="sm2">${esc(s.role)} ${i + 1}</span>`}</td>
              <td>${esc(s.role)}</td><td class="n">${s.weight}</td>
              <td class="n">${C.policy.totalWeight ? pc(s.weight / C.policy.totalWeight, 1) : '—'}</td>
              <td class="n">${fmt(s.each)}</td></tr>`;
          }
        }
        const paid = b.split.reduce((a, s) => a + s.each * Math.max(s.people.length, s.seats || 0), 0);
        h += `</tbody><tfoot><tr><th>Pool</th><th></th><th class="n"></th><th class="n"></th>
          <th class="n">${fmt(b.pool)}</th></tr></tfoot></table>`;
        /* The shares must account for the pool. A weight typo shows here and
           nowhere else until payroll. */
        if (Math.abs(paid - b.pool) > 1) {
          h += `<div class="tg-note" style="border-left:3px solid #b0503c">
            <strong>These shares total ${fmt(paid)}, not ${fmt(b.pool)}.</strong>
            The headcount or the weights do not account for the whole pool.</div>`;
        }
        h += '</div></div>';
      }
    }
    if (seats) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${seats} seat${seats === 1 ? '' : 's'} ${seats === 1 ? 'has' : 'have'} no name.</strong>
        ${named} ${named === 1 ? 'person is' : 'people are'} named. Add the rest in
        <a href="/admin">Admin → Commission → Staff list</a> and these become payslips.</div>`;
    }
    return `${h}</section>`;
  }

  /* ------------------------------------------------------ 04 call centre */

  /**
   * A refusal, with the reason and the fix.
   *
   * The policy has a full call-centre scheme — a bonus per booked patient by
   * recency, a 75/25 individual-to-team split, show-rate bonuses and a
   * follow-up rate. None of it can be computed, because Odoo files every
   * booking under one shared "Call Center" login and no field records who took
   * it. Showing a table of zeros would read as "nobody earned anything".
   */
  function callCentre(C, policy) {
    const P = policy || {};
    return `<section>
      <div class="kicker">Commission — Call centre</div>
      <h2 class="title">Not computable yet, and why</h2>
      <div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>Odoo records no agent against a booking.</strong> Every appointment is created by one
        shared <code>Call Center</code> login, so there is no field to attribute a booking to the
        person who took it. The policy below is real and agreed; what is missing is the data to
        apply it, and a table of zeros here would read as "nobody earned anything" rather than
        "nobody can be measured".
        <br><br>The fix is one field in Odoo — a "Booked by" on the appointment — after which this
        panel computes from the same policy with no change to it.
      </div>
      <h3 class="subtitle">The scheme, as agreed</h3>
      <div class="tw scrolly" style="--minw:520px;--h:300px"><table class="ltab tight"><thead><tr>
        <th>Rule</th><th class="n">Value</th></tr></thead><tbody>
        ${(P.rates || []).map((r) => `<tr><td class="nm">${esc(r.bucket)}</td>
          <td class="n">${fmt(r.bonus)}</td></tr>`).join('')
  || '<tr><td colspan="2"><span class="sm2">No call-centre rates are stored.</span></td></tr>'}
      </tbody></table></div>
      ${(P.members || []).length ? `<h3 class="subtitle">The team</h3>
        <div class="tw scrolly" style="--minw:460px;--h:320px"><table class="ltab tight"><thead><tr>
          <th>Name</th><th>Role</th><th>Serves</th><th>Status</th></tr></thead><tbody>
          ${P.members.map((m) => `<tr><td class="nm">${esc(m.name)}</td><td>${esc(m.role || '—')}</td>
            <td>${esc(m.serves || '—')}</td><td>${esc(m.status || '—')}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <p class="sub" style="margin-top:12px">The queue and booking figures that DO exist are on
        <a href="/contact-centre">Contact Centre</a> — they just cannot be attributed to a person.</p>
    </section>`;
  }

  return { summary, staff, callCentre };
});
