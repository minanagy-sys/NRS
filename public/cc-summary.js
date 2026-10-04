/* ============================================================
   01 — Executive summary.

   The contact centre's own opportunities: what came in, what was booked, who
   turned up, and what it was worth.

   THE NUMBER THIS PANEL EXISTS FOR is the credit gap. 1,435 patients were
   booked and arrived; 1,139 of those arrived on the booking the agent made.
   The 296 in between arrived some other way — rebooked by a branch, walked in,
   booked again later — and the agent who found them gets nothing for it. That
   is not a rounding difference, it is a fifth of the work.

   SHOW RATE EXCLUDES UPCOMING BOOKINGS from its denominator. A booking for
   next Tuesday has not failed to show up, and counting it as a miss would make
   every agent look worse the more they booked.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcSummary = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, bar, tone, windowBanner, emptyPanel, table, kpi, kpis } = F;

  function html(D) {
    const S = D && D.summary;
    if (!S || !S.window || !S.window.any) return emptyPanel('01 — Executive summary', 'Executive summary', S && S.window);
    const T = S.totals;
    const floor = S.floor || 0.75;

    let h = `<section>
      <div class="kicker">01 — Executive summary</div>
      <h2 class="title">${esc(S.window.from)} → ${esc(S.window.to)}</h2>
      <p class="sub">Contact-centre opportunities only. The branches' own follow-up is on the
        CRM panel.</p>
      ${windowBanner(S.window, 'Opportunities')}`;

    h += kpis([
      kpi('Opportunities', fmt(T.n), 'leads the contact centre worked', 'accent'),
      kpi('Booked', fmt(T.booked), `${pc(T.bookingRate)} of opportunities`),
      kpi('Showed', `<span class="${tone(T.showRate, floor)}">${pc(T.showRate)}</span>`,
        `${fmt(T.showed)} of ${fmt(T.past)} that have come due`),
      kpi('Revenue', fmt(T.revenue), 'EGP, indicative'),
      kpi('Credit lost', fmt(T.lostCredit), 'showed, but not on the agent\'s own booking'),
      kpi('Still upcoming', fmt(T.upcoming), 'not yet due, not counted as missed'),
    ]);

    /* Said in words, because a reader who sees 1,435 and 1,139 in two cards
       will not necessarily see that the gap is the point. */
    if (T.lostCredit > 0) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${fmt(T.showed)} patients were booked here and arrived. Only
        ${fmt(T.ownBooking)} arrived on the booking the agent made.</strong>
        The other ${fmt(T.lostCredit)} — ${pc(T.lostCredit / (T.showed || 1))} of them — came in
        some other way: rebooked by a branch, booked again later, or walked in. The work that
        found them was done here and is credited nowhere. The re-booking table on the CRM panel
        says where it went.</div>`;
    }

    h += `<div class="tg-note">${esc(S.revenueNote)}</div>`;

    /* ---- outcomes ---- */
    h += `<h3 class="subtitle">What happened to them</h3>`;
    const maxO = S.outcomes.reduce((m, o) => Math.max(m, o.n), 0);
    h += '<div class="dbars">';
    for (const o of S.outcomes) {
      h += `<div class="dbar"><div class="dbar-d">${esc(o.label)}</div>
        <div class="dbar-w">${bar(o.n, maxO)}</div>
        <div class="dbar-t">${fmt(o.n)} · ${pc(o.share)}</div></div>`;
    }
    h += '</div>';

    /* ---- when they arrive ---- */
    if (S.hours.length) {
      h += `<h3 class="subtitle">When the opportunities arrive</h3>
        <p class="sub">By the hour the opportunity was created, Cairo time.</p>`;
      const maxH = S.hours.reduce((m, x) => Math.max(m, x.n), 0);
      h += '<div class="dbars">';
      for (const x of S.hours) {
        h += `<div class="dbar"><div class="dbar-d">${String(x.hour).padStart(2, '0')}:00</div>
          <div class="dbar-w">${bar(x.n, maxH)}</div>
          <div class="dbar-t">${fmt(x.n)}</div></div>`;
      }
      h += '</div>';
    }

    h += `<h3 class="subtitle">Day by day</h3>
      ${table(S.days, [
    { k: 'date', h: 'Date' },
    { k: 'n', h: 'Opportunities', n: true, f: (r) => fmt(r.n) },
    { k: 'booked', h: 'Booked', n: true, f: (r) => fmt(r.booked) },
    { k: 'bookingRate', h: 'Booking rate', n: true, f: (r) => pc(r.bookingRate) },
    { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
    { k: 'showRate', h: 'Show rate', n: true, f: (r) => pc(r.showRate) },
    { k: 'revenue', h: 'Revenue', n: true, f: (r) => fmt(r.revenue) },
  ], {
    scroll: true,
    h: 420,
    foot: {
      date: 'All',
      n: fmt(T.n),
      booked: fmt(T.booked),
      bookingRate: pc(T.bookingRate),
      showed: fmt(T.showed),
      showRate: pc(T.showRate),
      revenue: fmt(T.revenue),
    },
  })}`;

    return `${h}</section>`;
  }

  function wire() { /* nothing interactive here */ }
  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render };
});
