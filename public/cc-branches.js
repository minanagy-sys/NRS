/* ============================================================
   06 — Branches and doctors.

   Where the contact centre's bookings go, and to whom.

   A BRANCH WITH NO NAME IS SHOWN AS ITSELF. The lookup carries "No branch" and
   "Older lead" as real values rather than nulls, and they stay on the table:
   dropping them would make the rows sum to less than the total above them,
   which is exactly how the commercial reports lost their unmapped branches.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcBranches = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, tone, windowBanner, emptyPanel, table } = F;

  function html(D) {
    const B = D && D.branches;
    if (!B || !B.window || !B.window.any) return emptyPanel('06 — Branches & doctors', 'Branches and doctors', B && B.window);
    const floor = (D.summary && D.summary.floor) || 0.75;

    const cols = (keyLabel, key) => [
      { k: key, h: keyLabel },
      { k: 'n', h: 'Opportunities', n: true, f: (r) => fmt(r.n) },
      { k: 'booked', h: 'Booked', n: true, f: (r) => fmt(r.booked) },
      { k: 'bookingRate', h: 'Booking rate', n: true, f: (r) => pc(r.bookingRate) },
      { k: 'showed', h: 'Showed', n: true, f: (r) => fmt(r.showed) },
      { k: 'showRate', h: 'Show rate', n: true, f: (r) => `<span class="${tone(r.showRate, floor)}">${pc(r.showRate)}</span>` },
      { k: 'revenue', h: 'Revenue', n: true, f: (r) => fmt(r.revenue) },
    ];

    const T = D.summary && D.summary.totals;
    let h = `<section>
      <div class="kicker">06 — Branches &amp; doctors</div>
      <h2 class="title">${esc(B.window.from)} → ${esc(B.window.to)}</h2>
      <p class="sub">Where the contact centre's bookings landed.</p>
      ${windowBanner(B.window, 'Branches')}`;

    h += `<h3 class="subtitle">Branches</h3>
      ${table(B.branches, cols('Branch', 'branch'), {
    scroll: true,
    h: 420,
    foot: T ? {
      branch: 'All',
      n: fmt(T.n),
      booked: fmt(T.booked),
      bookingRate: pc(T.bookingRate),
      showed: fmt(T.showed),
      showRate: pc(T.showRate),
      revenue: fmt(T.revenue),
    } : null,
  })}`;

    const noBranch = B.branches.find((b) => /no branch|older lead/i.test(b.branch));
    if (noBranch) {
      h += `<div class="tg-note"><strong>${fmt(noBranch.n)} opportunities carry no branch.</strong>
        They are on the table rather than dropped, so the rows still sum to the total beneath
        them. An opportunity with no branch is not a branch with no opportunities.</div>`;
    }

    h += `<h3 class="subtitle">Departments</h3>
      ${table(B.departments, cols('Department', 'department'))}`;

    h += `<h3 class="subtitle">Doctors</h3>
      <p class="sub">The fifteen busiest, by the doctor on the first linked appointment.</p>
      ${table(B.doctors, cols('Doctor', 'doctor'), { scroll: true, h: 420 })}`;

    return `${h}</section>`;
  }

  function wire() { /* nothing interactive */ }
  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render };
});
