/* ============================================================
   05 — Timing.

   When the work arrives, so staffing can be argued from the shape of the week
   rather than from whoever complained most recently.

   THE WEEK STARTS ON SATURDAY. It is the clinic week, not the calendar one,
   and a chart that opens on Monday puts the quietest day of the Egyptian week
   in the middle of the busy run.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcTiming = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, windowBanner, emptyPanel, table, heat } = F;

  function html(D) {
    const T = D && D.timing;
    if (!T || !T.window || !T.window.any) return emptyPanel('05 — Timing', 'Timing', T && T.window);

    let h = `<section>
      <div class="kicker">05 — Timing</div>
      <h2 class="title">${esc(T.window.from)} → ${esc(T.window.to)}</h2>
      <p class="sub">When opportunities arrive, by weekday and hour. The week runs Saturday to
        Friday.</p>
      ${windowBanner(T.window, 'Timing')}`;

    h += `<h3 class="subtitle">The week, hour by hour</h3>
      ${heat(T.heat.map((r) => ({ label: r.weekday, cells: r.cells })),
    T.hours.map((x) => `${String(x).padStart(2, '0')}`), { minw: 760, h: 360 })}`;

    const busiest = [...T.weekdays].sort((a, b) => b.n - a.n)[0];
    const quietest = [...T.weekdays].filter((d) => d.n).sort((a, b) => a.n - b.n)[0];
    if (busiest && quietest && busiest.n) {
      h += `<div class="tg-note"><strong>${esc(busiest.weekday)} carries ${fmt(busiest.n)}
        opportunities and ${esc(quietest.weekday)} carries ${fmt(quietest.n)}</strong> —
        ${((busiest.n / (quietest.n || 1))).toFixed(1)} times as many. Staffing the two the same
        way is a decision; it should at least be a deliberate one.</div>`;
    }

    h += `<h3 class="subtitle">By weekday</h3>
      ${table(T.weekdays, [
    { k: 'weekday', h: 'Weekday' },
    { k: 'n', h: 'Opportunities', n: true, f: (r) => fmt(r.n) },
    { k: 'booked', h: 'Booked', n: true, f: (r) => fmt(r.booked) },
    { k: 'bookingRate', h: 'Booking rate', n: true, f: (r) => pc(r.bookingRate) },
    { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
    { k: 'showRate', h: 'Show rate', n: true, f: (r) => pc(r.showRate) },
  ])}`;

    return `${h}</section>`;
  }

  function wire() { /* nothing interactive */ }
  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render };
});
