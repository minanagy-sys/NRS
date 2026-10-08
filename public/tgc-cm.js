/* ============================================================
   The Commission half: Summary, Doctors, Staff, Call center, Policy.

   WHAT IT PAYS ON. Branch teams are scored on CASH COLLECTED ex-VAT against the
   month's target; doctors on what they BILLED. That is why this half and the
   Targets half disagree, and why both say which basis every column is on. They
   are not two answers to one question.

   THE POOL IS A LOOKUP, NOT A LADDER. A branch lands in one of fourteen revenue
   tiers and one of five achievement levels, and the pool is the cell where they
   meet. Below the floor it pays nothing at all — there is no part-pool.

   THE CALL CENTRE REFUSES, AND MEANS IT. Odoo files every booking under one
   shared login, so `create_uid` identifies a desk, not a person. The scheme is
   shown as reference; the per-agent split is not computed, because the data
   cannot support it and a plausible number here becomes somebody's pay.

   THIS FILE DOES NOT COMPUTE COMMISSION. It renders what
   `/api/commission-month` returns, which is `src/lib/commission-v32.js` — the
   same engine the app already used. An earlier version of this page did the
   pool lookup and the doctor rates itself, and that was a mistake of the exact
   kind this codebase warns about elsewhere: `targets-live.js` takes care to use
   "the SAME call, not a second query that agrees today", and `audit.js`
   asserts the equality. Two implementations of a payment agree until the day
   they do not, and the day they do not, somebody is paid the wrong amount.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcCm = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;

  /**
   * ONE POLICY SHAPE, whichever answer it came from.
   *
   * `commission-v32.js` returns levels as `{level, fromPct}` with no tier
   * label; `/api/tgc/reference` returns `{level, from}` and builds the label
   * from the bounds. Rendering whichever arrived first put "NaN" in the From
   * column and left the Tier column blank — a policy table that reads as
   * broken is worse than one that is missing, because somebody will believe it.
   */
  function policyOf() {
    const src = (C.ST.cm && C.ST.cm.policy) || C.ST.ref.policy || {};
    const money = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : `${Math.round(v / 1e3)}K`);
    const label = (from, to) => (to == null ? `${money(from)}+` : from === 0 ? `< ${money(to)}` : `${money(from)} – ${money(to)}`);
    return {
      version: (C.ST.cm && C.ST.cm.version) || (C.ST.ref.policy || {}).version || null,
      levels: (src.levels || []).map((l) => ({
        level: l.level,
        from: l.from != null ? Number(l.from) : Number(l.fromPct),
      })),
      tiers: (src.tiers || []).map((t, i) => ({
        tierNo: t.tierNo != null ? t.tierNo : i + 1,
        from: Number(t.from),
        to: t.to == null ? null : Number(t.to),
        pools: (t.pools || []).map(Number),
        label: t.label || label(Number(t.from), t.to == null ? null : Number(t.to)),
      })),
      roles: (src.roles || []).map((r) => ({
        role: r.role, people: r.people, weight: Number(r.weight), notes: r.notes || '',
      })),
      totalWeight: src.totalWeight
        || (src.roles || []).reduce((t, r) => t + (r.people || 0) * Number(r.weight || 0), 0),
      /* These only ever come from the reference answer. */
      schemes: (C.ST.ref.policy || {}).schemes || [],
      gates: (C.ST.ref.policy || {}).gates || [],
      callCentre: (C.ST.ref.policy || {}).callCentre || {},
    };
  }

  /**
   * Branch rows for the chosen range, AS THE ENGINE SCORED THEM.
   *
   * `pool`, `level`, `tier` and the per-seat `split` are the server's, not this
   * file's. Scope is applied here because it is a view concern; nothing else is
   * recomputed.
   */
  function branchRows() {
    const cm = C.ST.cm;
    if (!cm || !cm.months) return [];
    const out = [];
    for (const m of cm.months) {
      for (const r of (m.branches || [])) {
        if (!C.inScope(r.branch)) continue;
        out.push({ ...r, name: r.branch, month: m.key });
      }
    }
    return out;
  }

  function summary() {
    const { fmt, esc } = C;
    const cm = C.ST.cm;
    const policy = policyOf();
    const rows = branchRows();
    const T = (cm && cm.totals) || {};

    C.$('cmTitle').textContent = 'What everyone earns';
    C.$('cmSub').textContent = `${C.ST.range.from} → ${C.ST.range.to} · branch teams on cash collected ex-VAT, doctors on what they billed.`;

    /* The engine says why it could not score, and that sentence is better than
       anything this file could infer from an empty array. */
    const msg = C.$('cmMsg');
    const why = (cm && (cm.missing || cm.note)) || (!rows.length
      ? 'No branch scored in this range. Branch pools are paid on cash received, so they stay at zero until the collections sync has run — the tiers and levels are the policy as published, not the reason the figures are empty.'
      : '');
    if (why) { msg.hidden = false; msg.innerHTML = `<strong>${esc(String(why))}</strong>`; } else msg.hidden = true;

    const atFloor = rows.filter((r) => r.pool > 0).length;
    C.$('cmKpi').innerHTML = [
      ['Collected', fmt(T.collected), 'cash in, ex-VAT'],
      ['Branch pools', fmt(T.branchPool), `${atFloor} of ${rows.length} earning`],
      ['Doctors', fmt(T.doctors), doctorPartsNote(T)],
      ['Policy', esc((cm && cm.version) || policy.version || '—'),
        `${(policy.levels || []).length} levels · ${(policy.tiers || []).length} tiers`],
    ].map(([l, v, sub]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${sub}</div></div>`).join('');

    /* One column per role, from the first row that has a split — the policy
       decides the seats, not this file. */
    const roleNames = (rows.find((r) => (r.split || []).length) || {}).split || (policy.roles || []).map((r) => ({ role: r.role }));
    C.$('cmBr').innerHTML = `<thead><tr><th>Branch</th><th>Collected</th><th>Paced</th><th>Target</th><th>Achieved</th>
      <th>Level</th><th>Tier</th><th>Pool</th>${roleNames.map((r) => `<th>${esc(r.role)} each</th>`).join('')}</tr></thead><tbody>${
      rows.map((r) => `<tr><td class="nm">${esc(r.branch)}<span class="m">${esc(C.brandOf(r.branch))}${r.closed ? '' : ' · month still running'}</span></td>
        <td>${fmt(r.collected)}</td><td>${fmt(r.paced)}</td><td>${r.target == null ? '—' : fmt(r.target)}</td>
        <td>${r.achievement == null ? '—' : C.pctb(r.achievement)}</td>
        <td>${r.level == null ? '—' : `${r.level}%`}</td>
        <td>${r.tier ? `tier ${r.tier.no}` : '—'}</td>
        <td class="t100">${fmt(r.pool)}</td>${
        roleNames.map((role) => {
          const hit = (r.split || []).find((x) => x.role === role.role);
          return `<td>${hit ? fmt(hit.each) : '—'}</td>`;
        }).join('')}</tr>`).join('')
      || `<tr><td class="nm" colspan="${8 + roleNames.length}">No branch scored in this range.</td></tr>`
    }<tr class="total"><td>Total</td><td>${fmt(T.collected)}</td><td></td><td></td><td></td><td></td><td></td>
      <td>${fmt(T.branchPool)}</td>${roleNames.map(() => '<td></td>').join('')}</tr></tbody>`;

    /* Doctors, on what they billed — a different basis, said so in the heading. */
    const dRows = docRows();
    C.$('cmDr').innerHTML = `<thead><tr><th>Doctor</th><th>Scheme</th><th>Billed ex-VAT</th><th>Rate</th><th>Commission</th></tr></thead><tbody>${
      dRows.slice(0, 40).map((d) => `<tr><td class="nm">${esc(d.name)}</td><td>${esc(d.scheme || '—')}</td>
        <td>${fmt(d.ex)}</td><td>${d.rate == null ? '—' : `${(d.rate * 100).toFixed(2)}%`}</td>
        <td>${d.commission == null ? '—' : fmt(d.commission)}</td></tr>`).join('')
      || '<tr><td class="nm" colspan="5">Nothing billed in this range.</td></tr>'
    }</tbody>`;

    /* Management gates: the engine's verdict and ITS reason. A gate that fails
       pays exactly zero and says which gate and why. */
    const gates = (cm && cm.months || []).flatMap((m) => m.management || []);
    C.$('cmMg').innerHTML = `<thead><tr><th>Role</th><th>Scope</th><th>Share</th><th>Qualifies</th><th>Pays</th><th>Why</th></tr></thead><tbody>${
      gates.map((g) => `<tr><td class="nm">${esc(g.role)}</td><td>${esc(g.scope || '')}</td>
        <td>${g.rate == null ? '—' : `${(g.rate * 100).toFixed(0)}%`}</td>
        <td>${g.pass ? 'yes' : 'no'}</td><td>${fmt(g.earned)}</td>
        <td class="nm">${esc(g.why || '')}</td></tr>`).join('')
      || '<tr><td colspan="6">No gates configured.</td></tr>'
    }</tbody>`;
  }

  /** What the doctor total is actually made of — it is not just commission. */
  function doctorPartsNote(T) {
    const p = T.doctorParts;
    if (!p) return 'billed ex-VAT';
    const bits = [];
    if (p.commission) bits.push(`${C.fmt(p.commission)} commission`);
    if (p.fixed) bits.push(`${C.fmt(p.fixed)} fixed`);
    if (p.hours) bits.push(`${C.fmt(p.hours)} hours`);
    if (p.fees) bits.push(`${C.fmt(p.fees)} fees`);
    const tail = p.withoutPayroll ? ` · ${p.withoutPayroll} without payroll` : '';
    return (bits.join(' + ') || 'nothing payable') + tail;
  }

  /** The engine's doctor rows, scope-filtered. */
  function docRows() {
    const cm = C.ST.cm;
    const rows = (cm && cm.doctors && cm.doctors.rows) || [];
    const list = C.scopeBranches();
    if (!list) return rows;
    return rows.filter((r) => (r.branches || []).some((b) => list.includes(b.name)));
  }

  function doctors() {
    const { fmt, esc } = C;
    const cm = C.ST.cm;
    const T = (cm && cm.totals) || {};
    const q = ((C.$('cmdQ') && C.$('cmdQ').value) || '').toLowerCase();
    const all = docRows();
    const shown = all.filter((r) => !q
      || r.name.toLowerCase().includes(q)
      || String(r.scheme || '').toLowerCase().includes(q));

    const missing = (cm && cm.doctors && cm.doctors.missing) || {};
    C.$('cmdSub').textContent = `${C.ST.range.from} → ${C.ST.range.to} · billed ex-VAT. `
      + 'A payslip needs a payroll month loaded — hours, deductions and tax are never inferred.';

    C.$('cmdKpi').innerHTML = [
      ['Doctors', String(shown.length), 'billing in this range'],
      ['Billed', fmt(C.S(shown.map((d) => d.ex))), 'ex-VAT'],
      ['Total payable', fmt(T.doctors), doctorPartsNote(T)],
      ['No rate', String(shown.filter((d) => d.rate == null).length), 'scheme missing or band gap'],
    ].map(([l, v, sub]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${sub}</div></div>`).join('');

    C.$('cmdT').innerHTML = `<thead><tr><th>Doctor</th><th>Scheme</th><th>Billed ex-VAT</th><th>Invoices</th>
      <th>Rate</th><th>Commission</th><th>Payslip</th></tr></thead><tbody>${
      shown.map((d) => `<tr><td class="nm">${esc(d.name)}${d.branches && d.branches.length
        ? `<span class="m">${esc(d.branches.map((b) => b.name).join(' · '))}</span>` : ''}</td>
        <td>${esc(d.scheme || '—')}</td><td>${fmt(d.ex)}</td><td>${d.invoices || '—'}</td>
        <td>${d.rate == null ? '—' : `${(d.rate * 100).toFixed(2)}%`}${
        d.rateFrom === 'override' ? '<span class="m">agreed rate</span>' : ''}</td>
        <td class="t100">${d.commission == null ? '—' : fmt(d.commission)}</td>
        <td>${d.payslip
          ? `<button class="btn ghost" data-slip="${esc(d.name)}">Open</button>`
          : '<span class="m">no payroll</span>'}</td></tr>`).join('')
      || '<tr><td class="nm" colspan="7">Nothing billed in this range.</td></tr>'
    }</tbody>`;

    C.$('cmdT').querySelectorAll('[data-slip]').forEach((b) => {
      b.addEventListener('click', () => openSlip(b.getAttribute('data-slip')));
    });

    const box = C.$('cmdQ');
    if (box && !box.dataset.wired) {
      box.dataset.wired = '1';
      box.addEventListener('input', doctors);
    }
  }

  /* ---- the payslip ----
     NO PAYROLL MONTH, NO PAYSLIP. Hours, deductions, Onda and tax are loaded,
     never inferred: a slip with those zeroed is not a smaller slip, it is a
     wrong one, and it is the document somebody is paid against. So the modal
     says what is missing rather than printing a confident total. */
  function openSlip(name) {
    const { fmt, esc } = C;
    const back = C.$('psBack');
    const row = docRows().find((r) => C.wn(r.name) === C.wn(name));
    const period = C.ST.range.to.slice(0, 7);

    if (row && row.slip) {
      C.$('psBody').innerHTML = root.Payslip
        ? root.Payslip.html(row, period)
        : slipFallback(row, period);
    } else {
      const billed = (C.rows('doctors').find((d) => C.wn(d.doctor) === C.wn(name)) || {}).ex || 0;
      C.$('psBody').innerHTML = `<div class="ps-head"><div><div class="ps-name" id="psTitle">${esc(name)}</div>
        <div class="ps-meta">${esc(period)}</div></div>
        <div class="ps-net">—<small>net pay</small></div></div>
        <div class="ps-h">Why this is blank</div>
        <div class="ps-line"><span>No payroll month is loaded for ${esc(period)}<span class="ps-sub">Hours, deductions, Onda and tax come from the payroll pack. They are never inferred — a slip with them zeroed would not be smaller, it would be wrong.</span></span></div>
        <div class="ps-h">What is known</div>
        <div class="ps-line"><span>Billed ex-VAT in this range</span><span class="ps-v">${fmt(billed)}</span></div>
        <div class="ps-line"><span>Range</span><span class="ps-v">${esc(C.ST.range.from)} → ${esc(C.ST.range.to)}</span></div>`;
    }
    back.hidden = false;
  }

  /** Used only if payslip.js is not on the page — same shape, fewer lines. */
  function slipFallback(r, period) {
    const { fmt, esc } = C;
    const s = r.slip || {};
    const line = (l, v) => `<div class="ps-line"><span>${esc(l)}</span><span class="ps-v">${fmt(v)}</span></div>`;
    return `<div class="ps-head"><div><div class="ps-name" id="psTitle">${esc(r.doctor || r.name)}</div>
      <div class="ps-meta">${esc(period)}</div></div>
      <div class="ps-net">${fmt(s.net)}<small>net pay</small></div></div>
      ${line('Commission', s.commission)}${line('Basic', s.basic)}${line('Deductions', s.ded)}
      ${line('Tax', s.tax)}${line('Net', s.net)}`;
  }

  function wireModal() {
    const back = C.$('psBack');
    if (!back || back.dataset.wired) return;
    back.dataset.wired = '1';
    const close = () => { back.hidden = true; };
    C.$('psClose').addEventListener('click', close);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !back.hidden) close(); });
    C.$('psPrint').addEventListener('click', () => window.print());
    /* Downloaded as HTML, not PDF: a PDF library would need a CSP exemption,
       and the slip has to open on a phone without one. */
    C.$('psDl').addEventListener('click', () => {
      const name = (C.$('psTitle') || {}).textContent || 'payslip';
      const blob = new Blob([`<!doctype html><meta charset="utf-8"><title>Payslip — ${name}</title>`
        + `<link rel="stylesheet" href="${location.origin}/assets/tgc.css">`
        + `<body style="padding:24px"><div class="ps-box">${C.$('psBody').innerHTML}</div>`], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `payslip-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${C.ST.range.to.slice(0, 7)}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function staff() {
    const { fmt, esc } = C;
    const rows = branchRows().filter((r) => r.pool > 0);
    const T = (C.ST.cm && C.ST.cm.totals) || {};

    C.$('cmsKpi').innerHTML = [
      ['Branches earning', String(rows.length), 'at or above the floor'],
      ['Total pools', fmt(T.branchPool), 'to split'],
      ['Seats', String(C.S(rows.flatMap((r) => (r.split || []).map((x) => x.seats || 0)))), 'the policy pays for'],
      ['Named', String(C.S(rows.flatMap((r) => (r.split || []).map((x) => (x.people || []).length)))), 'people on file'],
    ].map(([l, v, sub]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${sub}</div></div>`).join('');

    C.$('cmsBody').innerHTML = rows.length ? rows.map((r) => {
      /* SEATS AND NAMES ARE DIFFERENT COUNTS, and both matter: a branch can
         have two reception seats and one name entered, and the second share is
         still owed to somebody. The unnamed seat is drawn, not skipped. */
      const seatRows = (r.split || []).flatMap((sp) => {
        const seats = sp.seats || (sp.people || []).length || 0;
        return Array.from({ length: seats }, (_, i) => {
          const person = (sp.people || [])[i];
          return `<div class="doc-row"><div>
            <div class="doc-name">${person ? esc(person.name) : `${esc(sp.role)} ${i + 1}`}</div>
            <div class="doc-meta">${esc(sp.role)}${person ? '' : ' · no name on file'}</div></div>
            <div class="doc-amt">${fmt(sp.each)}<small>this range</small></div></div>`;
        });
      });
      const paid = C.S((r.split || []).map((sp) => (sp.each || 0) * (sp.seats || 0)));
      const off = Math.abs(paid - r.pool) > 1;
      return `<div class="branch-block"><div class="branch-head">
        <span><span class="bh-name">${esc(r.branch)}</span>
        <span class="bh-meta">${r.level == null ? '' : `${r.level}% level`}${r.tier ? ` · tier ${r.tier.no}` : ''}</span></span>
        <span class="bh-amt">${fmt(r.pool)}<small>pool</small></span></div>
        <div class="branch-body">${seatRows.join('')}
          ${off ? `<div class="tg-note">The shares come to ${fmt(paid)}, not ${fmt(r.pool)} — the seats do not account for the whole pool.</div>` : ''}
        </div></div>`;
    }).join('') : `<div class="tg-note"><strong>No branch reached the floor in this range.</strong> Nothing is payable, so there is nothing to split.${
      (C.ST.cm && C.ST.cm.missing) ? ` ${esc(String(C.ST.cm.missing))}` : ''}</div>`;
  }

  function callCentre() {
    const { fmt, esc } = C;
    const cc = policyOf().callCentre || {};
    C.$('cmcBody').innerHTML = `
      <div class="tg-note"><strong>This is the scheme, not a calculation.</strong> Odoo files every
      booking under one shared Call Center login, so the record identifies a desk rather than a
      person. Splitting the bonus per agent would mean inventing an attribution the data does not
      carry, and this is somebody's pay. The rates below are what was agreed; who earned what has to
      come from the call center's own records.</div>
      <h3 class="subtitle">Per booking<span class="vat-tag">EGP</span></h3>
      <div class="tg-tw"><table class="tg-t"><thead><tr><th>Patient type</th><th>Pays</th></tr></thead><tbody>${
      (cc.rates || []).map((r) => `<tr><td class="nm">${esc(r.patientType)}</td><td>${fmt(r.amount)}</td></tr>`).join('')
      || '<tr><td colspan="2">No rates configured.</td></tr>'}</tbody></table></div>
      <h3 class="subtitle">Show-rate bonus</h3>
      <div class="tg-tw"><table class="tg-t"><thead><tr><th>Show rate from</th><th>Team bonus</th></tr></thead><tbody>${
      (cc.showRates || []).map((s) => `<tr><td class="nm">${(s.from * 100).toFixed(0)}%</td><td>${fmt(s.bonus)}</td></tr>`).join('')
      || '<tr><td colspan="2">No bands configured.</td></tr>'}</tbody></table></div>
      <h3 class="subtitle">The team</h3>
      <div class="tg-tw"><table class="tg-t"><thead><tr><th>Name</th><th>Role</th><th>Brand</th></tr></thead><tbody>${
      (cc.team || []).map((m) => `<tr><td class="nm">${esc(m.name)}</td><td>${esc(m.role || '')}</td><td>${esc(m.entity || '')}</td></tr>`).join('')
      || '<tr><td colspan="3">No members configured.</td></tr>'}</tbody></table></div>`;
  }

  /* ---- the policy, section by section ----
     Six sections, the dashboard's own: the whole thing, the branch team, the
     doctors, the call center, the management layer and the general rules. The
     Section chips in the header choose one; "All teams" shows the lot. */
  const SECTION_OF = {
    all: ['branch', 'doctors', 'cc', 'mgmt', 'rules'],
    branch: ['branch'], doctors: ['doctors'], cc: ['cc'], mgmt: ['mgmt'], rules: ['rules'],
  };

  /** A cell that can be edited; `kind|i|field` is how the save finds it again. */
  const cell = (kind, i, field, value, w, text) => `<input class="cp-in${text ? ' tx' : ''}" type="text"${
    text ? '' : ' inputmode="numeric"'} data-kind="${kind}" data-i="${i}" data-field="${field}"
    value="${value == null ? '' : C.esc(String(value))}" style="min-width:${w || 74}px"
    aria-label="${kind} ${i + 1} ${field}">`;

  /** A row's delete control. Removing a row is a policy change like any other:
      it only takes effect on Save, and Save needs the passphrase. */
  const del = (kind, i) => `<td class="cp-x"><button type="button" class="cp-del"
    data-del="${kind}" data-i="${i}" title="Remove this row" aria-label="Remove row ${i + 1}">×</button></td>`;

  const addRow = (kind, label) => `<div class="cp-add"><button type="button" class="cp-addbtn"
    data-add="${kind}">+ Add row</button><span class="cp-addnote">${C.esc(label)}</span></div>`;

  /**
   * The worked example, computed from the policy rather than written out.
   *
   * The dashboard printed one by hand. Computing it means it can never describe
   * a policy that is no longer in force — which is the whole hazard of a worked
   * example sitting beside the numbers it is meant to illustrate.
   */
  function example(p) {
    const { fmt } = C;
    const tier = (p.tiers || []).find((t) => t.from <= 3_000_000 && (t.to == null || t.to > 3_000_000));
    if (!tier || !p.levels.length) return '';
    const top = p.levels.length - 1;
    const poolTop = Number(tier.pools[top]) || 0;
    const poolFloor = Number(tier.pools[0]) || 0;
    const W = p.totalWeight || 1;
    const share = (r) => `Each ${C.esc(r.role.toLowerCase())}: <b>${fmt((poolTop * r.weight) / W)}</b> (${((r.weight / W) * 100).toFixed(1)}%)`;

    /* The service bonuses multiply, up to the cap. */
    const mults = (p.departments || []).filter((d) => d.multiplier);
    const cap = (p.rules || []).find((r) => /cap/i.test(r.subject));
    const laser = mults.find((d) => /laser/i.test(d.label));
    const body = mults.find((d) => /body/i.test(d.label));

    return `<div class="cp-eg"><div class="cp-eg-h">Example</div>
      A branch collected ${C.fm(tier.from)} – ${tier.to == null ? 'more' : C.fm(tier.to)} and reached
      ${p.levels[top].level}% of its target: the pool is <b>${fmt(poolTop)}</b>.
      <ul>${(p.roles || []).map((r) => `<li>${share(r)}</li>`).join('')}</ul>
      At ${p.levels[0].level}% instead, the pool is <b>${fmt(poolFloor)}</b>.
      ${laser ? `If ${C.esc(laser.label.toLowerCase())} also met its target and mix, the pool becomes
        <b>${fmt(poolTop * laser.multiplier)}</b>` : ''}${body ? `; with ${C.esc(body.label.toLowerCase())} too,
        <b>${fmt(poolTop * laser.multiplier * body.multiplier)}</b>` : ''}.
      ${cap ? `<div class="cp-eg-cap">${C.esc(cap.subject)}: ${C.esc(cap.treatment)}</div>` : ''}</div>`;
  }

  /** Every person's share at every tier — derived, never typed. */
  function perPerson(p, limit) {
    const { fmt, esc } = C;
    const roles = p.roles || [];
    const lv = p.levels || [];
    if (!roles.length || !lv.length) return '';
    const W = p.totalWeight || 1;
    const lo = lv[0].level;
    const hi = lv[lv.length - 1].level;
    const rows = (p.tiers || []).filter((t) => t.pools.some((v) => Number(v) > 0));
    const shown = rows.slice(0, limit);
    const at = (t, idx, r) => ((Number(t.pools[idx]) || 0) * r.weight) / W;

    return `<h4 class="cp-h4">What each person gets · worked out from the pool and weights</h4>
      <p class="cp-desc">Team of ${roles.reduce((a, r) => a + r.people, 0)} with a total weight of ${W}.
      ${roles.map((r) => `${esc(r.role)}: ${((r.weight / W) * 100).toFixed(1)}% of the pool each`).join(' · ')}.</p>
      <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Tier</th>${
      roles.flatMap((r) => [`<th>${esc(r.role)} ${lo}%</th>`, `<th>${esc(r.role)} ${hi}%</th>`]).join('')
    }</tr></thead><tbody>${
      shown.map((t) => `<tr><td class="nm">${esc(t.label)}</td>${
        roles.flatMap((r) => [
          `<td>${fmt(at(t, 0, r))}</td>`,
          `<td class="t100">${fmt(at(t, lv.length - 1, r))}</td>`,
        ]).join('')}</tr>`).join('')
    }</tbody></table></div>
      ${rows.length > shown.length
    ? `<div class="lim-more"><button type="button" id="cpPpMore">Show more · ${rows.length - shown.length} more rows</button></div>`
    : ''}`;
  }

  function policy() {
    const { fmt, esc } = C;
    const p = policyOf();
    p.departments = (C.ST.ref.policy || {}).departments || [];
    p.rules = (C.ST.ref.policy || {}).rules || [];
    const version = p.version || 'v3.2 draft';
    const want = SECTION_OF[C.ST.policySection || 'all'] || SECTION_OF.all;
    const show = (k) => want.includes(k);

    C.$('cpNav').innerHTML = '';
    C.$('cpSt').textContent = `Version ${version}. Every number and name here can be changed — edit a cell, `
      + 'add or delete rows, then press Save policy. It needs the admin passphrase, because every figure '
      + 'here decides what somebody is paid.';

    const levels = p.levels || [];
    const parts = [];

    /* ---- the branch team ---- */
    if (show('branch')) {
      parts.push(`<div class="cp-sec"><h3 class="subtitle">Branch team (manager, reception, seniors, nurses / office)</h3>
        <p class="cp-desc">Each month the branch net collection picks the revenue tier, and achievement against
        the month target picks the level. Together they give one pool for the whole team, shared by weight.
        Below ${levels.length ? levels[0].level : 80}% nothing is paid, and the pool follows revenue, not headcount.</p>
        ${example(p)}

        <h4 class="cp-h4">Achievement levels</h4>
        <p class="cp-desc">The branch's net collection against its month target decides which level it reached;
        under the first level nothing is paid.</p>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Level</th><th>From achievement %</th><th></th></tr></thead><tbody>${
        levels.map((l, i) => `<tr><td class="nm">${cell('level', i, 'level', l.level, 70)}%</td>
          <td>${cell('level', i, 'from', (l.from * 100).toFixed(2))}</td>${del('level', i)}</tr>`).join('')
      }</tbody></table></div>${addRow('level', 'another achievement level')}

        <h4 class="cp-h4">Branch pool by revenue tier and level<span class="vat-tag">EGP, whole team</span></h4>
        <p class="cp-desc">The money for the whole branch team, by how much the branch collected (the tier) and
        how close it came to target (the level). Pick the row by revenue and the column by level.</p>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Tier</th><th>From EGP</th><th>To EGP</th>${
        levels.map((l) => `<th>Pool ${l.level}%</th>`).join('')}<th></th></tr></thead><tbody>${
        (p.tiers || []).map((t, i) => `<tr><td class="nm">${esc(t.label)}</td>
          <td>${cell('tier', i, 'from', Math.round(t.from), 92)}</td>
          <td>${cell('tier', i, 'to', t.to == null ? '' : Math.round(t.to), 92)}</td>${
          t.pools.map((v, j) => `<td>${cell('tier', i, `pool${j}`, Math.round(v), 82)}</td>`).join('')}${del('tier', i)}</tr>`).join('')
      }</tbody></table></div>${addRow('tier', 'another revenue tier')}

        <h4 class="cp-h4">Team per branch and weight per person</h4>
        <p class="cp-desc">Who is in the team and how the pool is shared. Each person gets pool × their weight ÷
        the team's total weight, so a higher weight means a bigger share.</p>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Role</th><th>People per branch</th>
          <th>Weight per person</th><th>Share</th><th>Notes</th><th></th></tr></thead><tbody>${
        (p.roles || []).map((r, i) => `<tr><td class="nm">${cell('role', i, 'role', r.role, 150, true)}</td>
          <td>${cell('role', i, 'people', r.people, 64)}</td>
          <td>${cell('role', i, 'weight', r.weight, 64)}</td>
          <td>${p.totalWeight ? `${((r.weight / p.totalWeight) * 100).toFixed(1)}%` : '—'}</td>
          <td>${cell('role', i, 'notes', r.notes || '', 190, true)}</td>${del('role', i)}</tr>`).join('')
      }<tr class="total"><td>Total weight</td><td>${(p.roles || []).reduce((a, r) => a + r.people, 0)}</td>
        <td>${p.totalWeight}</td><td>100%</td><td></td><td></td></tr></tbody></table></div>${addRow('role', 'another role')}

        <h4 class="cp-h4">Service bonuses (multiply the branch amounts)</h4>
        <p class="cp-desc">Extra on top of the branch pool when a service hits its own target and mix rule.
        Bonuses multiply together, up to the cap.</p>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Service</th><th>Multiplier ×</th>
          <th>Condition</th><th>Mix rule %</th></tr></thead><tbody>${
        (p.departments || []).map((d) => `<tr><td class="nm">${esc(d.label)}</td>
          <td>${d.multiplier == null ? '—' : d.multiplier}</td>
          <td class="nm">${esc(d.condition || '')}</td>
          <td>${d.mixFloor != null ? `${(d.mixFloor * 100).toFixed(0)}` : d.mixCap != null ? `${(d.mixCap * 100).toFixed(0)}` : '—'}</td></tr>`).join('')
        || '<tr><td colspan="4">No service bonuses configured.</td></tr>'
      }</tbody></table></div>

        ${perPerson(p, C.ST.ppLimit || 10)}
        </div>`);
    }

    /* ---- doctors ---- */
    if (show('doctors')) {
      parts.push(`<div class="cp-sec"><h3 class="subtitle">Doctors and specialists</h3>
        <p class="cp-desc">A rate is a LOOKUP on the whole month's billing, not a ladder — a doctor billing
        300,000 earns the band rate on all of it. Where the bands leave a gap nothing is paid, because a
        commission invented to fill a hole is a payment nobody agreed. Schemes are edited in Admin, where a
        change is checked against the people on them.</p>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Scheme</th><th>Bands</th><th>From → to</th>
          <th>Hourly</th><th>Fixed</th><th>Notes</th></tr></thead><tbody>${
        (p.schemes || []).map((sc) => `<tr><td class="nm">${esc(sc.name)}</td>
          <td>${(sc.bands || []).length}</td>
          <td class="nm">${(sc.bands || []).map((b) => `${C.fm(Number(b.from))}–${b.to == null ? '∞' : C.fm(Number(b.to))} @ ${(Number(b.rate) * 100).toFixed(1)}%`).join(' · ')}</td>
          <td>${sc.hourlyRate == null ? '—' : fmt(sc.hourlyRate)}</td>
          <td>${sc.fixedBasic == null ? '—' : fmt(sc.fixedBasic)}</td>
          <td class="nm">${esc(sc.notes || '')}</td></tr>`).join('')
      }</tbody></table></div></div>`);
    }

    /* ---- call center ---- */
    if (show('cc')) {
      const cc = p.callCentre || {};
      parts.push(`<div class="cp-sec"><h3 class="subtitle">Call center</h3>
        <div class="tg-note"><strong>Waiting for one change in Odoo.</strong> Every booking is saved under the
        shared "Call Center" login, so Odoo cannot tell which agent booked which patient. As soon as the
        appointment has a required "Booked by" field, this page fills in on its own: each agent's patients by
        type, her bonus, the team pool and the show-rate bonus, with a payslip for each agent.</div>
        <h4 class="cp-h4">How it will pay<span class="vat-tag">EGP each</span></h4>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Patient type</th><th>Pays</th><th>Note</th></tr></thead><tbody>${
        (cc.rates || []).map((r) => `<tr><td class="nm">${esc(r.patientType)}</td><td>${fmt(r.amount)}</td>
          <td class="nm">${esc(r.note || '')}</td></tr>`).join('') || '<tr><td colspan="3">No rates configured.</td></tr>'
      }</tbody></table></div>
        <h4 class="cp-h4">Show-rate bonus</h4>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Band</th><th>Show rate from</th><th>Team bonus</th></tr></thead><tbody>${
        (cc.showRates || []).map((r) => `<tr><td class="nm">${esc(r.label || '')}</td>
          <td>${(r.from * 100).toFixed(0)}%</td><td>${fmt(r.bonus)}</td></tr>`).join('') || '<tr><td colspan="3">No bands configured.</td></tr>'
      }</tbody></table></div>
        <h4 class="cp-h4">Team</h4>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Name</th><th>Role</th><th>Brand</th></tr></thead><tbody>${
        (cc.team || []).map((m) => `<tr><td class="nm">${esc(m.name)}</td><td>${esc(m.role || '')}</td>
          <td>${esc(m.entity || '')}</td></tr>`).join('') || '<tr><td colspan="3">No members configured.</td></tr>'
      }</tbody></table></div></div>`);
    }

    /* ---- management ---- */
    if (show('mgmt')) {
      parts.push(`<div class="cp-sec"><h3 class="subtitle">Management layer</h3>
        <p class="cp-desc">A share of the branch pools, earned only when enough branches clear the floor.
        A gate that fails pays exactly zero and the row says which gate and why.</p>
        <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Role</th><th>Share of pools</th>
          <th>Branches at floor</th><th>Or group achievement</th><th>Scope</th><th>Gate</th></tr></thead><tbody>${
        (p.gates || []).map((g) => `<tr><td class="nm">${esc(g.role)}</td><td>${(g.rate * 100).toFixed(0)}%</td>
          <td>${g.minBranches}</td><td>${g.groupAchievement == null ? '—' : `${(g.groupAchievement * 100).toFixed(0)}%`}</td>
          <td>${esc(g.scope || '')}</td><td class="nm">${esc(g.label || '')}</td></tr>`).join('')
        || '<tr><td colspan="6">No gates configured.</td></tr>'
      }</tbody></table></div></div>`);
    }

    /* ---- general rules ---- */
    if (show('rules')) {
      const byKind = {};
      for (const r of (p.rules || [])) (byKind[r.kind] ||= []).push(r);
      parts.push(`<div class="cp-sec"><h3 class="subtitle">General rules</h3>${
        Object.entries(byKind).map(([kind, rs]) => `<h4 class="cp-h4">${esc(kind)}</h4>
          <div class="tg-tw"><table class="tg-t cp-t"><thead><tr><th>Subject</th><th>Treatment</th><th>Affects</th></tr></thead><tbody>${
          rs.map((r) => `<tr><td class="nm">${esc(r.subject)}</td><td class="nm">${esc(r.treatment)}</td>
            <td class="nm">${esc(r.affects || '')}</td></tr>`).join('')}</tbody></table></div>`).join('')
        || '<p class="cp-desc">No rules recorded.</p>'
      }</div>`);
    }

    C.$('cpBody').innerHTML = parts.join('');

    const ppMore = C.$('cpPpMore');
    if (ppMore) ppMore.addEventListener('click', () => { C.ST.ppLimit = (C.ST.ppLimit || 10) + 10; policy(); });

    wirePolicyEdits(version, p);
  }

  /** Cells changed since the last save. */
  const POLICY_EDITS = new Map();

  /**
   * Rows added or removed since the last save.
   *
   * Held here rather than written straight through, because adding a tier and
   * saving are two different decisions: nothing reaches the database until the
   * passphrase is given, and until then the page can still be abandoned.
   */
  const POLICY_ADD = { level: [], tier: [], role: [] };
  const POLICY_DEL = { level: new Set(), tier: new Set(), role: new Set() };

  function wireAddDelete(p) {
    C.$('cpBody').querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        const kind = b.getAttribute('data-del');
        const i = Number(b.getAttribute('data-i'));
        if (POLICY_DEL[kind].has(i)) POLICY_DEL[kind].delete(i);
        else POLICY_DEL[kind].add(i);
        b.closest('tr').classList.toggle('cp-gone', POLICY_DEL[kind].has(i));
        markPolicy();
      });
    });

    C.$('cpBody').querySelectorAll('[data-add]').forEach((b) => {
      b.addEventListener('click', () => {
        const kind = b.getAttribute('data-add');
        /* A new row starts EMPTY, not as a copy — a duplicated tier that nobody
           edited is a silent second rule for the same revenue. */
        if (kind === 'level') p.levels.push({ level: '', from: 0 });
        if (kind === 'tier') p.tiers.push({ tierNo: (p.tiers.length || 0) + 1, from: '', to: '', pools: p.levels.map(() => 0), label: 'new tier' });
        if (kind === 'role') p.roles.push({ role: '', people: 1, weight: 1, notes: '' });
        POLICY_ADD[kind].push(true);
        policy();
      });
    });
  }

  function markPolicy() {
    const save = C.$('cpSave');
    if (!save) return;
    const edits = POLICY_EDITS.size;
    const dels = Object.values(POLICY_DEL).reduce((t, set) => t + set.size, 0);
    const n = edits + dels;
    save.textContent = n ? `Save policy (${n} change${n === 1 ? '' : 's'})` : 'Save policy';
    save.disabled = n === 0;
    if (dels) {
      C.$('cpSt').textContent = `${dels} row${dels === 1 ? '' : 's'} marked for removal. `
        + 'Nothing is written until Save policy, and Save needs the admin passphrase.';
    }
  }

  function wirePolicyEdits(version, p) {
    wireAddDelete(p);
    const st = C.$('cpSt');
    const save = C.$('cpSave');
    const mark = markPolicy;

    C.$('cpBody').querySelectorAll('.cp-in').forEach((el) => {
      const was = el.value;
      el.addEventListener('input', () => {
        const k = `${el.dataset.kind}|${el.dataset.i}|${el.dataset.field}`;
        if (el.value === was) POLICY_EDITS.delete(k); else POLICY_EDITS.set(k, el.value);
        el.classList.toggle('cp-dirty', POLICY_EDITS.has(k));
        mark();
      });
    });

    if (!save.dataset.wired) {
      save.dataset.wired = '1';
      save.addEventListener('click', () => savePolicy(version));
    }

    const exp = C.$('cpExp');
    if (exp && !exp.dataset.wired) {
      exp.dataset.wired = '1';
      exp.textContent = 'Export policy';
      exp.addEventListener('click', () => exportPolicy(p, version));
    }

    /* A policy WORKBOOK upload would need a server-side reader of its own, and
       there isn't one — so rather than pretend, the button says where it is. */
    const up = C.$('cpUp');
    const label = document.querySelector('label[for="cpUp"]');
    if (up) up.disabled = true;
    if (label && !label.dataset.wired) {
      label.dataset.wired = '1';
      label.textContent = 'Upload policy workbook — in Admin';
      label.addEventListener('click', () => { location.href = '/admin#policy'; });
    }
    const reset = C.$('cpReset');
    if (reset && !reset.dataset.wired) {
      reset.dataset.wired = '1';
      reset.addEventListener('click', () => { POLICY_EDITS.clear(); policy(); });
    }
    mark();
  }

  function exportPolicy(p, version) {
    const rows = [[`Nouvelage commission policy ${version}`], [], ['Levels'], ['Level %', 'From %']];
    (p.levels || []).forEach((l) => rows.push([l.level, (l.from * 100).toFixed(2)]));
    rows.push([], ['Tiers'], ['Tier', 'From', 'To', ...(p.levels || []).map((l) => `${l.level}%`)]);
    (p.tiers || []).forEach((t) => rows.push([t.label, t.from, t.to == null ? '' : t.to, ...t.pools]));
    rows.push([], ['Roles'], ['Role', 'People', 'Weight', 'Notes']);
    (p.roles || []).forEach((r) => rows.push([r.role, r.people, r.weight, r.notes || '']));
    const csv = rows.map((r) => r.map((c) => {
      const t = String(c == null ? '' : c);
      return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `nouvelage-commission-policy-${version.replace(/[^a-z0-9.]+/gi, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function savePolicy(version) {
    const st = C.$('cpSt');
    const p = policyOf();
    const read = (kind, i, field, fallback) => {
      const k = `${kind}|${i}|${field}`;
      return POLICY_EDITS.has(k) ? POLICY_EDITS.get(k) : fallback;
    };

    const levels = (p.levels || []).map((l, i) => ({
      level: Number(read('level', i, 'level', l.level)),
      from: Number(read('level', i, 'from', (l.from * 100).toFixed(2))) / 100,
    })).filter((_, i) => !POLICY_DEL.level.has(i));
    const tiers = (p.tiers || []).map((t, i) => ({
      tierNo: t.tierNo != null ? t.tierNo : i + 1,
      from: read('tier', i, 'from', Math.round(t.from)),
      to: read('tier', i, 'to', t.to == null ? '' : Math.round(t.to)),
      pools: t.pools.map((v, j) => read('tier', i, `pool${j}`, Math.round(v))),
    })).filter((_, i) => !POLICY_DEL.tier.has(i));
    const roles = (p.roles || []).map((r, i) => ({
      role: read('role', i, 'role', r.role),
      people: Number(read('role', i, 'people', r.people)),
      weight: Number(read('role', i, 'weight', r.weight)),
      notes: read('role', i, 'notes', r.notes || ''),
    })).filter((_, i) => !POLICY_DEL.role.has(i));

    const send = async (url, body) => fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body),
    });

    st.textContent = 'Saving…';
    const jobs = [['/api/policy/levels', { version, levels }],
      ['/api/policy/pools', { version, tiers }],
      ['/api/policy/roles', { version, roles }]];

    for (const [url, body] of jobs) {
      let res = await send(url, body);
      if (res.status === 403) {
        const pass = window.prompt('Admin passphrase to change the commission policy:');
        if (!pass) { st.textContent = 'Not saved — the passphrase is needed to change the policy.'; return; }
        const un = await fetch('/auth/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify({ passphrase: pass }),
        });
        if (!un.ok) { st.textContent = 'That passphrase was not accepted. Nothing was saved.'; return; }
        res = await send(url, body);
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) {
        /* The server's message names the tier and the column. It is better than
           anything this file could say, so it is shown as-is. */
        st.textContent = `Not saved: ${out.error || res.status}`;
        return;
      }
    }

    POLICY_EDITS.clear();
    Object.values(POLICY_DEL).forEach((set) => set.clear());
    st.textContent = 'Saved. Reloading the policy…';
    C.ST.cm = await C.api(`/api/commission-month?from=${C.ST.range.from}&to=${C.ST.range.to}`).catch(() => C.ST.cm);
    C.ST.ref = await C.api('/api/tgc/reference');
    render();
    C.$('cpSt').textContent = 'Saved. Every figure on this report now scores against the new policy.';
  }

  function render() {
    if (!C.ST.ref || !C.ST.per) return;
    summary();
    doctors();
    staff();
    callCentre();
    policy();
    wireModal();
  }

  return { render, openSlip, branchRows, docRows };
});
