/* ============================================================
   00 — What's happening.

   The live panel: a range, the money in it, and every branch against its share
   of the plan. Three things make it different from a plain total.

   TWO NUMBERS, TWO JOBS. Collected is the cash that came in; billed is what was
   invoiced ex-VAT. The commission policy pays on the first, the target sheet
   measures the second, and they are not the same money. Both are shown, each
   labelled, because a reader comparing them needs to be told which is which
   rather than left to work it out.

   A FUTURE DATE IS A PLAN, NOT AN EMPTY DAY. Ask for tomorrow and the panel
   shows the target and who is rostered, not zeros.

   THE TARGET FOR A PART-MONTH IS WEIGHTED. Four days is not 4/30 of the month
   when two of them were Fridays.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcWh = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;

  /** Which branches are expanded. Kept across redraws so a reload does not close them. */
  const OPEN = new Set();
  /**
   * What each expanded branch actually contains, keyed by branch and range.
   *
   * FETCHED WHEN OPENED, NOT UP FRONT. A reader expands one or two of twelve,
   * and each one is a second query; loading all of them to serve the two that
   * get looked at is the sort of cost that only shows on the slowest connection
   * in the clinic. The project already had this endpoint and this reasoning —
   * `/api/targets-live-branch` exists for exactly it.
   *
   * Before this, every card rendered the SAME global doctor list, so expanding
   * CFC showed doctors who had never billed there.
   */
  const DETAIL = new Map();
  const detailKey = (name) => `${name}|${C.ST.range.from}|${C.ST.range.to}`;
  const VIEW = { by: 'branch', brand: '', allSvc: false, sort: 'billed', branch: '' };

  function hero() {
    const { ST, fmt, longDate } = C;
    const { from, to } = ST.range;
    const one = from === to;
    const future = from > ST.today;
    const billed = C.billedTotal();
    const collected = C.collectedTotal();
    const target = C.S(C.branchNames().filter(C.inScope)
      .filter((b) => !VIEW.brand || C.brandOf(b) === VIEW.brand)
      .filter((b) => !VIEW.branch || b === VIEW.branch)
      .map((b) => C.bTarget(b))) * C.tierOf();

    C.$('whHero').innerHTML = future
      ? `${fmt(target)}<em>planned · ${one ? longDate(from) : `${from} → ${to}`}</em>`
      : `${fmt(collected || billed)}<em>${collected ? 'collected' : 'billed'} ex-VAT · ${one ? longDate(from) : `${from} → ${to}`}</em>`;

    C.$('whSub').textContent = future
      ? (one
        ? 'Plan for the day: the target and who is on shift, from the approved schedule.'
        : 'Plan for these days: targets for the same days. Actuals appear as the days happen.')
      : 'Collected is the cash that came in. Billed is what was invoiced, ex-VAT. They are different money.';

    const ach = target ? (collected || billed) / target : null;
    C.$('whKpi').innerHTML = [
      ['Collected', fmt(collected), 'cash in, ex-VAT'],
      ['Billed', fmt(billed), 'invoiced, ex-VAT'],
      ['Target', fmt(target), one ? 'this day, weighted' : 'these days, weighted'],
      ['Achieved', future ? '—' : `${ach == null ? '—' : `${(ach * 100).toFixed(0)}%`}`, 'against target'],
    ].map(([l, v, s]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`).join('');
  }

  /** One branch card: the money, the target, the percentage badge, and a roster
      or doctor list underneath when it is opened. */
  function branchCard(name, billed, collected, target, future) {
    const { fmt, esc } = C;
    const ach = target ? (collected || billed) / target : null;
    const open = OPEN.has(name);
    const shifts = future ? C.onShift(name, C.ST.range.from) : [];

    const body = future
      ? (shifts.length
        ? shifts.map((s) => `<div class="doc-row"><div><div class="doc-name">${esc(s.doctor)}</div>
            <div class="doc-meta">${esc(s.department || '')} · ${esc(s.from)}–${esc(s.to)} · ${s.hours}h</div></div>
            <div class="doc-amt">${fmt(C.docDay(s.doctor, C.ST.range.from, Number(s.hours) || 0))}<small>planned</small></div></div>`).join('')
        : '<div class="doc-row"><div class="doc-meta">Nobody is rostered here on this day.</div></div>')
      : detailBody(name);

    return `<div class="branch-block${open ? '' : ' collapsed'}" data-branch="${esc(name)}">
      <button class="branch-head" type="button" data-toggle="${esc(name)}">
        <span><span class="bh-name">${esc(name)}</span><span class="bh-meta">${esc(C.brandOf(name))}</span></span>
        <span class="wh-nums">
          <span class="wh-col"><span class="wh-l">${future ? 'Planned' : 'Collected'}</span><span class="wh-big">${fmt(future ? target : collected)}</span></span>
          <span class="wh-col"><span class="wh-l">${future ? 'On shift' : 'Billed'}</span><span class="wh-mid">${future ? shifts.length : fmt(billed)}</span></span>
          ${future ? '' : `<span class="wh-pct ${C.cls(ach)}">${ach == null ? '—' : `${(ach * 100).toFixed(0)}%`}</span>`}
        </span>
        <span class="toggle">▾</span>
      </button>
      <div class="branch-body">${body}</div></div>`;
  }

  /** One branch's doctors and services, or why they are not there yet. */
  function detailBody(name) {
    const { fmt, esc } = C;
    const d = DETAIL.get(detailKey(name));
    if (!d) return '<div class="doc-row"><div class="doc-meta">Loading this branch…</div></div>';
    if (d.error) return `<div class="doc-row"><div class="doc-meta">Could not load this branch: ${esc(d.error)}</div></div>`;
    const docs = d.doctors || [];
    const fams = d.families || [];
    if (!docs.length && !fams.length) {
      return '<div class="doc-row"><div class="doc-meta">Nothing billed here in this range.</div></div>';
    }
    return docs.map((x) => `<div class="doc-row"><div><div class="doc-name">${esc(x.name)}</div>
        <div class="doc-meta">${x.invoices ? `${x.invoices} invoices` : ''}</div></div>
        <div class="doc-amt">${fmt(x.ex)}<small>billed ex-VAT</small></div></div>`).join('')
      + (fams.length
        ? `<div class="doc-row"><div class="doc-name" style="opacity:.7">Services</div></div>${
          fams.map((f) => `<div class="doc-row"><div><div class="doc-name">${esc(f.label)}</div>
            <div class="doc-meta">${f.share == null ? '' : `${(f.share * 100).toFixed(0)}% of this branch`}</div></div>
            <div class="doc-amt">${fmt(f.ex)}<small>billed ex-VAT</small></div></div>`).join('')}`
        : '');
  }

  /** Pull one branch, by the name ODOO files it under, then redraw that card. */
  async function loadDetail(planName, sources) {
    const k = detailKey(planName);
    if (DETAIL.has(k)) return;
    DETAIL.set(k, null);
    const ask = (sources && sources.length ? sources : [planName]);
    try {
      const parts = await Promise.all(ask.map((n) => C.api(
        `/api/targets-live-branch?name=${encodeURIComponent(n)}&from=${C.ST.range.from}&to=${C.ST.range.to}`,
      )));
      /* A branch can be filed under more than one spelling; merge them rather
         than show whichever answered last. */
      const merged = { doctors: [], families: [], total: 0 };
      for (const p of parts) {
        merged.total += Number(p.total) || 0;
        (p.doctors || []).forEach((d) => merged.doctors.push(d));
        (p.families || []).forEach((f) => merged.families.push(f));
      }
      merged.doctors.sort((a, b) => b.ex - a.ex);
      merged.families.sort((a, b) => b.ex - a.ex);
      DETAIL.set(k, merged);
    } catch (e) {
      DETAIL.set(k, { error: e.message });
    }
    branches();
  }

  function branches() {
    const future = C.ST.range.from > C.ST.today;
    const billedBy = new Map(C.rows('branches').map((r) => [r.branch, r.ex]));
    const cashBy = new Map(((C.ST.per && C.ST.per.collected) || []).map((r) => [r.branch, r.net]));
    const names = C.branchNames().filter(C.inScope)
      .filter((n) => !VIEW.brand || C.brandOf(n) === VIEW.brand)
      .filter((n) => !VIEW.branch || n === VIEW.branch);

    const ordered = [...names].sort((a, b) => {
      if (VIEW.sort === 'name') return a.localeCompare(b);
      if (VIEW.sort === 'ach') {
        const ra = C.bTarget(a) ? (billedBy.get(a) || 0) / C.bTarget(a) : -1;
        const rb = C.bTarget(b) ? (billedBy.get(b) || 0) / C.bTarget(b) : -1;
        return rb - ra;
      }
      return (billedBy.get(b) || 0) - (billedBy.get(a) || 0);
    });

    C.$('whBr').innerHTML = ordered.map((n) => branchCard(
      n, billedBy.get(n) || 0, cashBy.get(n) || 0, C.bTarget(n) * C.tierOf(), future,
    )).join('') || '<div class="tg-note">No branches in this scope.</div>';

    C.$('whBr').querySelectorAll('[data-toggle]').forEach((b) => {
      b.addEventListener('click', () => {
        const n = b.getAttribute('data-toggle');
        if (OPEN.has(n)) OPEN.delete(n);
        else {
          OPEN.add(n);
          const row = (C.rows('branches') || []).find((x) => x.branch === n);
          if (C.ST.range.from <= C.ST.today) loadDetail(n, row && row.sources);
        }
        branches();
      });
    });
  }

  function tables() {
    const { fmt, esc } = C;
    const docs = C.rows('doctors');
    const total = C.S(docs.map((d) => d.ex));
    C.$('whDoc').innerHTML = `<thead><tr><th>Doctor</th><th>Billed ex-VAT</th><th>Invoices</th><th>Share</th></tr></thead><tbody>${
      docs.slice(0, 40).map((d) => `<tr><td class="nm">${esc(d.doctor)}</td><td>${fmt(d.ex)}</td><td>${d.invoices || '—'}</td><td>${total ? `${((d.ex / total) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')
      || '<tr><td class="nm" colspan="4">Nothing billed in this range.</td></tr>'
    }<tr class="total"><td>Total</td><td>${fmt(total)}</td><td></td><td>100%</td></tr></tbody>`;

    const svc = C.rows('products');
    const st = C.S(svc.map((s) => s.ex));
    C.$('whSvc').innerHTML = `<thead><tr><th>Service</th><th>Billed ex-VAT</th><th>Share</th></tr></thead><tbody>${
      (VIEW.allSvc ? svc : svc.slice(0, 15)).map((s) => `<tr><td class="nm">${esc(s.name)}</td><td>${fmt(s.ex)}</td><td>${st ? `${((s.ex / st) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')
      || '<tr><td class="nm" colspan="3">Nothing billed in this range.</td></tr>'
    }<tr class="total"><td>Total</td><td>${fmt(st)}</td><td>100%</td></tr></tbody>`;
  }

  /** "See more" on the service table. The count is stated rather than implied,
      because a silently truncated list reads as a complete one. */
  function svcMore() {
    const btn = C.$('whSvcLoad');
    const svc = C.rows('products');
    btn.hidden = svc.length <= 15;
    btn.textContent = VIEW.allSvc ? 'Show the top 15 only' : `Show all ${svc.length} services`;
    if (!btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => { VIEW.allSvc = !VIEW.allSvc; render(); });
    }
  }

  /** How the branch cards are ordered. */
  function sortChips() {
    const slot = C.$('whSortSlot');
    slot.innerHTML = [['billed', 'By billed'], ['ach', 'By achieved'], ['name', 'A–Z']]
      .map(([v, l]) => `<button class="chip${v === VIEW.sort ? ' on' : ''}" data-sort="${v}">${l}</button>`).join('');
    slot.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      VIEW.sort = b.getAttribute('data-sort');
      render();
    }));
  }

  /** The note that says where the figures came from — a range the sync has not
      reached is served from imported history, and saying so beats a short month
      reading as a bad one. */
  function provenance() {
    const src = C.ST.per && C.ST.per.sources;
    const el = C.$('whMsg');
    if (!src) { el.hidden = true; return; }

    /* A branch Odoo spells differently from the approved sheet. Its money is in
       the total and on no card, which is the one thing worse than it being
       missing from both — so it is named, with the amount, and the fix is
       stated rather than implied. */
    const un = src.unmatched || [];
    if (un.length) {
      el.hidden = false;
      const total = C.S(un.map((u) => u.ex));
      el.innerHTML = `<strong>${un.length} branch ${un.length === 1 ? 'name does' : 'names do'} not match the approved sheet`
        + ` — ${C.fmt(total)} ex-VAT.</strong> `
        + un.map((u) => `${C.esc(u.name)} (${C.fmt(u.ex)})`).join(', ')
        + `. The money is counted in the totals above but sits under Odoo's spelling rather than the plan's, `
        + `so those branches score against no target. Pair the names in `
        + `<a href="/admin#aliases">Admin → Name mapping</a> — they are not matched by similarity, `
        + `because two names one letter apart can be two different places.`;
      return;
    }

    if (!src.partial) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<strong>Part of this range predates the live cache.</strong> `
      + `${src.history.from} → ${src.history.to} is served from the imported history `
      + `(the same figures the standalone dashboard carried); `
      + `${src.live ? `${src.live.from} → ${src.live.to} is live from the Odoo cache.` : 'nothing in this range is live yet.'}`;
  }

  /* The panel's own date row. It mirrors the bar in the header rather than
     competing with it: typing here and pressing Show moves the whole page, so
     the two can never disagree about which range is on screen. */
  function dateRow(reload) {
    const from = C.$('whFrom');
    const to = C.$('whTo');
    from.value = C.ST.range.from;
    to.value = C.ST.range.to;
    const show = C.$('whShow');
    if (show && !show.dataset.wired) {
      show.dataset.wired = '1';
      show.addEventListener('click', () => {
        if (!from.value || !to.value || from.value > to.value) return;
        const gf = C.$('gFrom');
        const gt = C.$('gTo');
        if (gf && gt) { gf.value = from.value; gt.value = to.value; }
        if (typeof reload === 'function') reload(from.value, to.value);
      });
    }

    /* Presets, the same seven the header offers. */
    const presets = C.$('whPreset');
    if (presets && !presets.dataset.wired) {
      presets.dataset.wired = '1';
      presets.innerHTML = [['today', 'Today'], ['yday', 'Yesterday'], ['l7', 'Last 7'],
        ['mtd', 'This month'], ['lm', 'Last month'], ['ytd', 'This year']]
        .map(([v, l]) => `<button class="chip" data-p="${v}">${l}</button>`).join('');
      presets.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
        const hit = document.querySelector(`#gSeg [data-p="${b.dataset.p}"]`);
        if (hit) hit.click();
      }));
    }
  }

  /** Brand. Both trading names bill into the same cache, and a ZAT reader
      wants ZAT's branches only. */
  function brandChips() {
    const el = C.$('whBrand');
    const brands = [...new Set(C.branchNames().map(C.brandOf))];
    el.innerHTML = [['', 'Both'], ...brands.map((b) => [b, b])]
      .map(([v, l]) => `<button class="chip${v === VIEW.brand ? ' on' : ''}" data-brand="${C.esc(v)}">${C.esc(l)}</button>`).join('');
    el.querySelectorAll('[data-brand]').forEach((b) => b.addEventListener('click', () => {
      VIEW.brand = b.getAttribute('data-brand');
      render();
    }));
  }

  /** Branches or doctors. The doctor view drops the branch cards, because the
      same money would otherwise be shown twice under two headings. */
  function viewToggle() {
    const slot = C.$('whViewSlot');
    slot.innerHTML = [['branch', 'Branches'], ['doctor', 'Doctors']]
      .map(([v, l]) => `<button class="chip${v === VIEW.by ? ' on' : ''}" data-by="${v}">${l}</button>`).join('');
    slot.querySelectorAll('[data-by]').forEach((b) => b.addEventListener('click', () => {
      VIEW.by = b.getAttribute('data-by');
      render();
    }));
    C.$('whViewTag').textContent = VIEW.by === 'branch'
      ? 'tap a branch for its doctors'
      : 'everyone with billing in these days';
    C.$('whBr').hidden = VIEW.by !== 'branch';
    C.$('whDocSec').hidden = VIEW.by === 'branch';
  }

  /**
   * The forecast. Measured on FINISHED days only — the first of the month to
   * yesterday — weighted by weekday, then scaled to the whole month. Today is
   * left out because a day in progress always reads as a collapse, and on the
   * 1st there is nothing to measure yet, so it says so.
   */
  function forecast() {
    const box = C.$('whFc');
    const month = C.ST.range.to.slice(0, 7);
    const running = C.monthStart(month) <= C.ST.today && C.ST.today <= C.monthEnd(month);
    if (!running || C.ST.scope.type !== 'all') { box.hidden = true; return; }

    const done = C.billedTotal();
    const paced = C.fcPace(done, month);
    const target = C.S(C.branchNames().filter(C.inScope)
      .map((n) => C.branchPlan(n)[month] || 0));
    box.hidden = false;
    if (paced == null) {
      box.innerHTML = '<div class="fc-top"><div><span class="fc-tag">Forecast</span>'
        + '<div class="fc-title">The forecast starts tomorrow</div>'
        + '<div class="fc-sub">It is measured on finished days, and this month has none yet.</div></div></div>';
      return;
    }
    const ach = target ? paced / target : null;
    box.innerHTML = `<div class="fc-top"><div><span class="fc-tag">Forecast · admins only</span>
      <div class="fc-title">Where ${month} lands at this pace</div>
      <div class="fc-sub">Measured on the days that have finished, weighted by weekday.</div></div>
      <div><div class="fc-big">${C.fmt(paced)}</div>
      <div class="fc-sub">against a target of ${C.fmt(target)}${ach == null ? '' : ` · ${(ach * 100).toFixed(0)}%`}</div></div></div>`;
  }

  function render(reload) {
    if (!C.ST.ref || !C.ST.per) return;
    dateRow(reload);
    brandChips();
    viewToggle();
    sortChips();
    svcMore();
    hero();
    provenance();
    forecast();
    branches();
    tables();
    C.$('whSync').textContent = C.ST.per.sources.cache.invoices
      ? `cache holds ${C.ST.per.sources.cache.invoices.toLocaleString()} invoices, to ${C.ST.per.sources.cache.hi}`
      : 'the live cache is empty';
  }

  const reset = () => { OPEN.clear(); DETAIL.clear(); };

  return { render, reset, OPEN, VIEW };
});
