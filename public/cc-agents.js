/* ============================================================
   04 — Agents.

   The contact centre's ten people, by what they actually produced: how many
   opportunities they worked, how many they booked, and how many of those
   patients turned up.

   SHOW RATE IS SCORED AGAINST THE POLICY FLOOR of 75%, which is the commission
   policy's figure and not a style choice — the same floor the Targets report
   pays from. Green at or above target, amber within reach, red below.

   THE CREDIT COLUMN IS THE ONE WORTH READING. An agent can book well and still
   show a low "own booking" count, which means their patients are arriving on
   somebody else's appointment. That is a process problem, not a performance
   one, and the two look identical in any table that reports only bookings.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcAgents = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, bar, tone, windowBanner, emptyPanel, table } = F;

  function html(D) {
    const P = D && D.people;
    if (!P || !P.window || !P.window.any) return emptyPanel('04 — Agents', 'Agents', P && P.window);
    const floor = P.floor || 0.75;

    let h = `<section>
      <div class="kicker">04 — Agents</div>
      <h2 class="title">${esc(P.window.from)} → ${esc(P.window.to)}</h2>
      <p class="sub">The contact centre's own people. The phone extensions are on the Calls
        panel — they are a different list, and only nine of them map to a person.</p>
      ${windowBanner(P.window, 'Agents')}`;

    h += table(P.agents, [
      { k: 'name', h: 'Agent' },
      { k: 'n', h: 'Opportunities', n: true, f: (r) => fmt(r.n) },
      { k: 'booked', h: 'Booked', n: true, f: (r) => fmt(r.booked) },
      { k: 'bookingRate', h: 'Booking rate', n: true, f: (r) => pc(r.bookingRate) },
      { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
      { k: 'showRate', h: 'Show rate', n: true, f: (r) => `<span class="${tone(r.showRate, floor)}">${pc(r.showRate)}</span>` },
      { k: 'ownBooking', h: 'On own booking', n: true, f: (r) => fmt(r.ownBooking) },
      { k: 'lostCredit', h: 'Credit lost', n: true, f: (r) => fmt(r.lostCredit) },
      { k: 'revenue', h: 'Revenue', n: true, f: (r) => fmt(r.revenue) },
    ], { scroll: true, minw: 860, h: 440 });

    /* The floor drawn, so a reader sees who is under it without reading down a
       column of percentages. */
    h += `<h3 class="subtitle">Show rate against the ${pc(floor, 0)} floor</h3>
      <p class="sub">The policy floor the commission pays from. The marker is the floor, not
        the average.</p><div class="dbars">`;
    for (const a of P.agents) {
      h += `<div class="dbar"><div class="dbar-d">${esc(a.name)}</div>
        <div class="dbar-w">${bar(a.showRate || 0, 1)}</div>
        <div class="dbar-t ${tone(a.showRate, floor)}">${pc(a.showRate)}
          <span class="sm2">of ${fmt(a.past)}</span></div></div>`;
    }
    h += '</div>';

    const below = P.agents.filter((a) => a.showRate != null && a.showRate < floor);
    if (below.length) {
      h += `<div class="tg-note"><strong>${below.length} of ${P.agents.length} are below the
        floor.</strong> ${esc(below.map((a) => a.name).join(', '))}. A low show rate on a high
        booking count is usually the patient arriving somewhere else rather than not arriving —
        check the credit-lost column before reading it as a performance figure.</div>`;
    }

    return `${h}</section>`;
  }

  function wire() { /* nothing interactive */ }
  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render };
});
