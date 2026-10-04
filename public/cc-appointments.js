/* ============================================================
   00 — Appointments.

   The panel that opens the report, because it is the only one about bookings
   that have not happened yet. Everything else here is a post-mortem; this is
   the list of people the clinic is expecting.

   WHICH SHOW RATE. There are two, and the server picks. For a range entirely
   in the past, showed ÷ past. For a range reaching into the future, that
   denominator would include appointments nobody has had yet, so it becomes
   showed ÷ (booked − cancelled), labelled "arrived so far". Printing one as
   the other is how a report about next week reads as a catastrophe.

   RESCHEDULED BOOKINGS ARE NOT IN THE TOTALS. A reschedule is one booking that
   moved, and counting both halves double-counts the patient. The number is
   shown on its own so it is visible rather than silently dropped.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcAppointments = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, clock, tone, windowBanner, emptyPanel, table, kpi, kpis, heat } = F;

  /* Which branch rows are open. Module state so a repaint does not close what
     somebody is reading. */
  const OPEN = new Set();

  function html(D) {
    const A = D && D.appointments;
    if (!A || !A.window || !A.window.any) return emptyPanel('00 — Appointments', 'Appointments', A && A.window);
    const T = A.totals;
    const floor = (D.summary && D.summary.floor) || 0.75;
    const showVal = T.showMetric === 'arrivedRate' ? T.arrivedRate : T.showRate;
    const showLbl = T.showMetric === 'arrivedRate' ? 'Arrived so far' : 'Show rate';
    const showSub = T.showMetric === 'arrivedRate'
      ? `of ${fmt(T.n - T.cancelled)} not cancelled · the range reaches the future`
      : `of ${fmt(T.past)} that have passed`;

    let h = `<section>
      <div class="kicker">00 — Appointments</div>
      <h2 class="title">${esc(A.window.from)} → ${esc(A.window.to)}</h2>
      <p class="sub">Every appointment in the book, where it came from, and whether anybody
        rang to confirm it.</p>
      ${windowBanner(A.window, 'Appointments')}`;

    h += kpis([
      kpi('Appointments', fmt(T.n), `${fmt(T.rescheduled)} rescheduled, counted separately`, 'accent'),
      kpi('Booked by the contact centre', fmt(T.contactCentre), `${pc(T.contactCentre / (T.n || 1))} of the book`),
      kpi('Booked by a branch', fmt(T.branch), `${pc(T.branch / (T.n || 1))} of the book`),
      kpi(showLbl, `<span class="${tone(showVal, floor)}">${pc(showVal)}</span>`, showSub),
      kpi('Confirmed', pc(T.confirmRate), `${fmt(T.confirmed)} of ${fmt(T.confirmed + T.pending)} still open`),
      kpi('Cancelled', pc(T.cancelRate), `${fmt(T.cancelled)} appointments`),
      kpi('Upcoming', fmt(T.upcoming), 'still to happen'),
    ]);

    /* The confirmation-call finding, first because it is the one that is
       actionable and the one nobody is looking at. */
    const C = A.confirmation;
    if (C) {
      h += `<h3 class="subtitle">Confirmation calls</h3>`;
      if (C.note) {
        h += `<div class="tg-note" style="border-left:3px solid #b0503c">
          <strong>${esc(C.note)}</strong></div>`;
      }
      h += kpis([
        kpi('Coverage', pc(C.coverage), 'of bookings have a call logged'),
        kpi('Showed, with a call', pc(C.withCall.showRate), `${fmt(C.withCall.n)} appointments`),
        kpi('Showed, without one', pc(C.withoutCall.showRate), `${fmt(C.withoutCall.n)} appointments`),
      ]);
      if (C.comparable && C.withCall.showRate != null && C.withoutCall.showRate != null) {
        const gap = C.withCall.showRate - C.withoutCall.showRate;
        h += `<div class="tg-note">On the bookings that have already come due, a confirmation
          call moved the show rate by <strong>${pc(Math.abs(gap))}</strong>
          ${gap >= 0 ? 'upwards' : 'downwards'}. ${Math.abs(gap) < 0.03
    ? 'That is close enough to nothing that it is not evidence either way — but it is measured '
      + 'on 98 calls, and the question is worth asking again once confirming is actually logged.'
    : 'Measured on the appointments that have passed, so it is a result rather than a forecast.'}</div>`;
      }
    }

    /* ---- branches, each openable ---- */
    h += `<h3 class="subtitle">Branches</h3>`;
    const maxB = A.branches.reduce((m, b) => Math.max(m, b.n), 0);
    for (const b of A.branches) {
      const open = OPEN.has(b.branch);
      const v = T.showMetric === 'arrivedRate' ? b.arrivedRate : b.showRate;
      h += `<div class="acc${open ? ' open' : ''}">
        <div class="acc-h" data-apbranch="${esc(b.branch)}" role="button" tabindex="0">
          <div class="acc-name">${esc(b.branch)}</div>
          <div class="acc-meta"><span class="${tone(v, floor)}">${pc(v)}</span>
            · ${fmt(b.n)} booked · ${fmt(b.contactCentre)} by the contact centre</div>
        </div>
        <div class="trk"><i style="width:${maxB ? ((b.n / maxB) * 100).toFixed(1) : 0}%"></i></div>`;
      if (open) {
        h += `<div class="acc-b">${table([b], [
          { k: 'n', h: 'Booked', n: true, f: (r) => fmt(r.n) },
          { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
          { k: 'cancelled', h: 'Cancelled', n: true, f: (r) => fmt(r.cancelled) },
          { k: 'upcoming', h: 'Upcoming', n: true, f: (r) => fmt(r.upcoming) },
          { k: 'confirmed', h: 'Confirmed', n: true, f: (r) => fmt(r.confirmed) },
          { k: 'pending', h: 'Pending', n: true, f: (r) => fmt(r.pending) },
          { k: 'withCall', h: 'With a call', n: true, f: (r) => fmt(r.withCall) },
          { k: 'confirmRate', h: 'Confirm rate', n: true, f: (r) => pc(r.confirmRate) },
        ])}</div>`;
      }
      h += '</div>';
    }

    /* ---- the day, half-hour by half-hour ---- */
    if (A.heat && A.heat.rows.length) {
      const headers = [];
      for (let i = 0; i < A.heat.slots; i += 1) headers.push(clock(A.heat.slot0 + i * 30));
      h += `<h3 class="subtitle">When they are booked</h3>
        <p class="sub">Half-hour slots from ${esc(clock(A.heat.slot0))}. ${A.heat.offGrid
    ? `${fmt(A.heat.offGrid)} bookings carry no slot or fall outside the clinic day and are not on this grid.`
    : ''}</p>
        ${heat(A.heat.rows.map((r) => ({ label: r.branch, cells: r.cells })), headers, { minw: 980 })}`;
    }

    h += `<h3 class="subtitle">Service families</h3>
      ${table(A.families, [
    { k: 'family', h: 'Family' },
    { k: 'n', h: 'Booked', n: true, f: (r) => fmt(r.n) },
    { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
    { k: 'cancelled', h: 'Cancelled', n: true, f: (r) => fmt(r.cancelled) },
    { k: 'cancelRate', h: 'Cancel rate', n: true, f: (r) => pc(r.cancelRate) },
  ])}`;

    h += `<h3 class="subtitle">Doctors</h3>
      ${table(A.doctors, [
    { k: 'doctor', h: 'Doctor' },
    { k: 'n', h: 'Booked', n: true, f: (r) => fmt(r.n) },
    { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
    { k: 'upcoming', h: 'Upcoming', n: true, f: (r) => fmt(r.upcoming) },
    { k: 'cancelRate', h: 'Cancel rate', n: true, f: (r) => pc(r.cancelRate) },
  ], { scroll: true, h: 380 })}`;

    h += `<h3 class="subtitle">Who booked them</h3>
      <p class="sub">From the PIN stamp on the booking, not from the Odoo login — which is why
        this names people rather than five shared desks.</p>
      ${table(A.bookers, [
    { k: 'booker', h: 'Booked by' },
    { k: 'n', h: 'Booked', n: true, f: (r) => fmt(r.n) },
    { k: 'contactCentre', h: 'Contact centre', n: true, f: (r) => fmt(r.contactCentre) },
    { k: 'branch', h: 'Branch', n: true, f: (r) => fmt(r.branch) },
    { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
  ], { scroll: true, h: 380 })}`;

    return `${h}</section>`;
  }

  /** Open and close a branch. Bound to the nodes, not delegated from document. */
  function wire(el, ctx) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-apbranch]').forEach((n) => {
      const toggle = () => {
        const k = n.dataset.apbranch;
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
