/* ============================================================
   02 — CRM.

   Every opportunity by every login, not just the contact centre's — roughly
   four times as many rows, and the only place the branches' own follow-up is
   visible at all.

   WHY THIS PANEL NAMES PEOPLE WHEN ODOO CANNOT. Nine logins cover sixty-seven
   people. `create_uid` names a desk. The name here comes from the `Employee:`
   line in the first "Record created" chatter message, which is the only place
   the person who actually opened the record is written down. Each login row
   opens to show who was sitting at it.

   THREE THINGS THIS PANEL REFUSES TO ANSWER, each for a different reason, and
   each said out loud rather than drawn as an empty table: lead source (the
   export has no such column), the person behind an activity (the field is
   empty on every row), and the person behind a re-booking (likewise). An empty
   table reads as "nobody did this". These mean "this export did not carry it".
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcCrm = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, dur, bar, windowBanner, emptyPanel, refusal, table, kpi, kpis } = F;

  const OPEN = new Set();

  function html(D) {
    const C = D && D.crm;
    if (!C || !C.window || !C.window.any) return emptyPanel('02 — CRM', 'CRM', C && C.window);
    const T = C.totals;

    let h = `<section>
      <div class="kicker">02 — CRM</div>
      <h2 class="title">${esc(C.window.from)} → ${esc(C.window.to)}</h2>
      <p class="sub">All nine logins, sixty-seven people. The calls themselves are not here —
        those are the phone system's, and they are on the Calls panel.</p>
      ${windowBanner(C.window, 'CRM opportunities')}`;

    h += kpis([
      kpi('Opportunities', fmt(T.leads), 'across every login', 'accent'),
      kpi('Booked', fmt(T.booked), `${pc(T.bookingRate)} of them`),
      kpi('Median time to book', dur(T.medianMinutesToBooking),
        `measured on ${fmt(T.measuredOn)} · ${fmt(T.neverBooked)} never booked`),
      kpi('Duplicates of a contact-centre lead', fmt(T.duplicates), pc(C.duplicates.share)),
      kpi('Employee field overwritten', fmt(T.overwritten), `${pc(T.overwritten / (T.leads || 1))} of rows`),
    ]);

    /* The median is two minutes, which looks wrong until you see the shape:
       most opportunities are created at the moment of booking. Said here so a
       reader does not spend ten minutes doubting it. */
    if (T.medianMinutesToBooking != null && T.medianMinutesToBooking <= 5) {
      h += `<div class="tg-note">The median is ${esc(dur(T.medianMinutesToBooking))} because most
        opportunities are created at the moment the booking is made — the record and the
        appointment are the same act. The ${fmt(T.neverBooked)} that never booked are excluded
        rather than counted as zero, which would be the fastest response in the dataset.</div>`;
    }

    /* ---- login -> person ---- */
    h += `<h3 class="subtitle">Who opened them</h3>
      <p class="sub">The login is the desk. Open a row to see the people who sat at it — taken
        from the stamp on the record, because Odoo itself only knows the desk.</p>`;
    const maxL = C.byLogin.reduce((m, l) => Math.max(m, l.n), 0);
    for (const l of C.byLogin) {
      const open = OPEN.has(l.login);
      h += `<div class="acc${open ? ' open' : ''}">
        <div class="acc-h" data-crmlogin="${esc(l.login)}" role="button" tabindex="0">
          <div class="acc-name">${esc(l.login)}
            <span class="sm2">${fmt(l.people.length)} ${l.people.length === 1 ? 'person' : 'people'}</span></div>
          <div class="acc-meta">${fmt(l.n)} opportunities · ${fmt(l.booked)} booked
            · ${pc(l.bookingRate)}</div>
        </div>
        <div class="trk"><i style="width:${maxL ? ((l.n / maxL) * 100).toFixed(1) : 0}%"></i></div>`;
      if (open) {
        h += `<div class="acc-b">${table(l.people, [
          { k: 'name', h: 'Person' },
          { k: 'n', h: 'Opportunities', n: true, f: (r) => fmt(r.n) },
          { k: 'booked', h: 'Booked', n: true, f: (r) => fmt(r.booked) },
          { k: 'bookingRate', h: 'Booking rate', n: true, f: (r) => pc(r.bookingRate) },
        ])}</div>`;
      }
      h += '</div>';
    }

    h += `<h3 class="subtitle">By person, across every login</h3>
      ${table(C.byOpener, [
    { k: 'name', h: 'Person' },
    { k: 'n', h: 'Opportunities', n: true, f: (r) => fmt(r.n) },
    { k: 'booked', h: 'Booked', n: true, f: (r) => fmt(r.booked) },
    { k: 'bookingRate', h: 'Booking rate', n: true, f: (r) => pc(r.bookingRate) },
  ], { scroll: true, h: 420 })}`;

    /* ---- activities ---- */
    const A = C.activities;
    if (A && A.available) {
      h += `<h3 class="subtitle">Activities</h3>`;
      if (!A.personAvailable) {
        h += refusal('These are broken down by login, not by person.', { why: A.why });
      }
      h += `<div class="tw" style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
        <div>${table(A.rows, [
    { k: 'login', h: A.grain === 'person' ? 'Person' : 'Login' },
    { k: 'n', h: 'Activities', n: true, f: (r) => fmt(r.n) },
    { k: 'done', h: 'Done', n: true, f: (r) => fmt(r.done) },
    { k: 'overdue', h: 'Overdue', n: true, f: (r) => fmt(r.overdue) },
  ])}</div>
        <div>${table(A.byType, [
    { k: 'type', h: 'Type' },
    { k: 'n', h: 'Activities', n: true, f: (r) => fmt(r.n) },
  ])}</div></div>`;

      h += `<h4 class="ps-h">Outcomes</h4><div class="tg-note">${esc(A.outcomeNote)}</div>`;
      const maxO = A.byOutcome.reduce((m, o) => Math.max(m, o.n), 0);
      h += '<div class="dbars">';
      for (const o of A.byOutcome) {
        h += `<div class="dbar"><div class="dbar-d">${esc(o.outcome)}</div>
          <div class="dbar-w">${bar(o.n, maxO)}</div>
          <div class="dbar-t">${fmt(o.n)}</div></div>`;
      }
      h += '</div>';
    }

    /* ---- re-booking: where the credit went ---- */
    const R = C.rebooking;
    if (R && R.available) {
      h += `<h3 class="subtitle">Where the credit went</h3>`;
      h += kpis([
        kpi('Patients re-booked elsewhere', fmt(R.lost), `${pc(R.lostShare)} of ${fmt(R.total)}`, 'accent'),
        kpi('Kept by the original booking', fmt(R.credited), pc(1 - (R.lostShare || 0))),
      ]);
      if (!R.personAvailable) {
        h += refusal('The column below names a login, not a person.', { why: R.why });
      }
      h += `<div class="tw" style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
        <div>${table(R.byBranch, [
    { k: 'branch', h: 'Lead branch' },
    { k: 'n', h: 'Lost', n: true, f: (r) => fmt(r.n) },
    { k: 'mostly', h: 'Mostly re-booked by' },
  ])}</div>
        <div>${table(R.byAgent, [
    { k: 'agent', h: 'Agent' },
    { k: 'n', h: 'Bookings', n: true, f: (r) => fmt(r.n) },
    { k: 'lost', h: 'Lost', n: true, f: (r) => fmt(r.lost) },
    { k: 'lostShare', h: 'Share', n: true, f: (r) => pc(r.lostShare) },
  ])}</div></div>`;
    }

    /* ---- duplicates ---- */
    h += `<h3 class="subtitle">Duplicate leads</h3>
      <div class="tg-note"><strong>${fmt(C.duplicates.n)} opportunities
        (${pc(C.duplicates.share)}) duplicate one the contact centre already had.</strong>
        ${esc(C.duplicates.rule)}</div>`;

    /* ---- lead source: a refusal ---- */
    h += `<h3 class="subtitle">Lead source</h3>
      ${refusal('Lead source cannot be reported from this export.', C.leadSource)}`;

    return `${h}</section>`;
  }

  function wire(el, ctx) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-crmlogin]').forEach((n) => {
      const toggle = () => {
        const k = n.dataset.crmlogin;
        if (OPEN.has(k)) OPEN.delete(k); else OPEN.add(k);
        ctx.redraw();
      };
      n.addEventListener('click', toggle);
      n.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render, OPEN };
});
