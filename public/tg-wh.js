/* ============================================================
   Live — what is happening right now.

   TWO NUMBERS THAT ARE NOT THE SAME NUMBER, and the panel says so in the first
   card rather than leaving a reader to find the gap: COLLECTED is cash received
   ex-VAT, which is what the commission policy pays on; BILLED is invoiced
   ex-VAT ex-package, which is what the target sheet measures. A clinic can bill
   21 M and collect 19.6 M in the same month and neither figure is wrong.

   The collected total here is the same figure the Commission report calls net
   collection — the same server call, and `scripts/audit.js` asserts the two are
   equal on every run.

   A BRANCH'S BREAKDOWN IS FETCHED WHEN IT IS OPENED. Eleven branches, and a
   reader opens one or two. Loading all eleven to serve the two that get
   expanded is the kind of cost that only shows on the slowest connection in the
   clinic.

   Loaded as a plain <script> before the page's own, so `TgWh` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgWh = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  /* Which branch rows are open, and what came back for them. Module state so a
     repaint on the five-minute loop does not close what somebody is reading. */
  const OPEN = new Set();
  const DETAIL = new Map();

  const tone = (a, floor) => {
    if (a == null) return '';
    if (a >= 1) return 'g';
    if (a >= floor) return 'a';
    return 'r';
  };

  function html(live) {
    if (!live || !live.totals) {
      return `<section><div class="kicker">01 — Live</div>
        <h2 class="title">Nothing to show yet</h2></section>`;
    }
    const T = live.totals;
    const floor = T.floorPct || 0.8;

    let h = `<section>
      <div class="kicker">01 — Live</div>
      <h2 class="title">${esc(live.window.from)} → ${esc(live.window.to)}</h2>
      <p class="sub">${esc(live.note)}</p>`;

    h += `<div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Collected ex-VAT</div>
        <div class="kpi-value">${fmt(T.collected)}</div>
        <div class="kpi-sub">cash received ÷ ${T.vatDivisor} · the commission base${
  T.unattributed ? ` · ${fmt(T.unattributed)} with no branch` : ''}</div></div>
      <div class="kpi"><div class="kpi-label">Billed ex-VAT</div>
        <div class="kpi-value sm">${fmt(T.billed)}</div>
        <div class="kpi-sub">${fmt(T.invoices)} invoices · ex-package</div></div>
      <div class="kpi"><div class="kpi-label">Against plan</div>
        <div class="kpi-value sm ${tone(T.achievement, floor)}">${T.achievement == null ? '—' : pc(T.achievement)}</div>
        <div class="kpi-sub">${T.target ? `${fmt(T.target)} planned${live.flags.proRata ? `, pro-rata ${live.window.covered}/${live.window.days} days` : ''}` : 'no plan for this range'}</div></div>
      <div class="kpi"><div class="kpi-label">Branches at ${pc(floor, 0)}</div>
        <div class="kpi-value sm">${T.atFloor} / ${T.branchesWithTarget}</div>
        <div class="kpi-sub">the floor the policy pays from${
  T.notOpen ? ` · ${T.notOpen} not open yet, not counted` : ''}</div></div>
    </div>`;

    if (!live.flags.branchScoringPossible) {
      h += `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>${pc(live.flags.unattributedShare)} of the cash carries no branch.</strong>
        Per-branch scoring is not possible for this range — the money was collected, but it cannot
        be attributed, so every branch below reads as near-zero against its target. Those are not
        failing branches.</div>`;
    }
    if (T.unassignedBilled) {
      h += `<div class="tg-note"><strong>${fmt(T.unassignedBilled)} of billed revenue carries no
        branch on the invoice.</strong> It is listed below under <em>Unassigned</em> and scored
        against nothing — there is no target for revenue nobody owns. Without the row the branch
        figures would quietly sum to less than the total above them.</div>`;
    }
    if (live.flags.proRata) {
      h += `<div class="tg-note">The plan figure is <strong>pro-rated by days</strong> —
        ${live.window.covered} of ${live.window.days} — not weighted by weekday. A month is not
        evenly spread, so a part-month reading slightly ahead or behind is the shape of the
        calendar as much as the trading.</div>`;
    }

    /* ---- the branches, each openable ---- */
    h += `<h3 class="subtitle">Branches <span class="vat-tag">collected ex-VAT</span></h3>`;
    for (const b of live.branches) {
      const open = OPEN.has(b.branch);
      const d = DETAIL.get(b.branch);
      const pctOf = b.target ? Math.min(100, (b.collected / b.target) * 100) : 0;
      h += `<div class="acc${open ? ' open' : ''}">
        <div class="acc-h" data-whbranch="${esc(b.branch)}" role="button" tabindex="0">
          <div class="acc-name">${esc(b.branch)}
            ${b.entity ? `<span class="sm2">${esc(b.entity)}</span>` : ''}
            ${b.unassigned ? '<span class="pill">no branch on the invoice</span>'
    : b.notOpen ? '<span class="pill">not open yet</span>'
      : b.noCash ? '<span class="pill">no cash collected</span>' : ''}</div>
          <div class="acc-meta">
            <span class="${tone(b.achievement, floor)}">${b.achievement == null ? '—' : pc(b.achievement)}</span>
            · ${fmt(b.collected)}${b.target ? ` of ${fmt(b.target)}` : ''}</div>
        </div>
        <div class="trk"><i style="width:${pctOf.toFixed(1)}%"></i></div>`;
      if (open) {
        h += '<div class="acc-b">';
        if (!d) {
          h += '<div class="sm2">Loading…</div>';
        } else {
          h += `<table class="ltab tight"><thead><tr><th>Service</th><th class="n">Billed ex-VAT</th>
            <th class="n">Share</th></tr></thead><tbody>
            ${d.families.map((f) => `<tr><td class="nm">${esc(f.label)}</td>
              <td class="n">${fmt(f.ex)}</td><td class="n">${pc(f.share)}</td></tr>`).join('')}
            </tbody></table>`;
          if (d.doctors.length) {
            h += `<h4 class="ps-h">Doctors in this branch</h4>
              <table class="ltab tight"><thead><tr><th>Doctor</th><th class="n">Billed ex-VAT</th>
                <th class="n">Invoices</th></tr></thead><tbody>
                ${d.doctors.slice(0, 12).map((x) => `<tr><td class="nm">${esc(x.name)}</td>
                  <td class="n">${fmt(x.ex)}</td><td class="n">${fmt(x.invoices)}</td></tr>`).join('')}
              </tbody></table>`;
          }
        }
        h += '</div>';
      }
      h += '</div>';
    }

    /* ---- doctors ---- */
    h += `<h3 class="subtitle">Doctors <span class="vat-tag">billed ex-VAT</span></h3>
      <div class="tw scrolly" style="--minw:460px;--h:420px"><table class="ltab tight"><thead><tr>
        <th>Doctor</th><th class="n">Billed ex-VAT</th><th class="n">Invoices</th>
        <th class="n">Share</th></tr></thead><tbody>
      ${live.doctors.map((d) => `<tr><td class="nm">${esc(d.name)}</td>
        <td class="n">${fmt(d.ex)}</td><td class="n">${fmt(d.invoices)}</td>
        <td class="n">${T.billed ? pc(d.ex / T.billed) : '—'}</td></tr>`).join('')}
      </tbody><tfoot><tr><th>All</th><th class="n">${fmt(T.billed)}</th>
        <th class="n">${fmt(T.invoices)}</th><th class="n">100.0%</th></tr></tfoot></table></div>`;

    return `${h}</section>`;
  }

  /**
   * Open and close a branch.
   *
   * Bound directly to the nodes. Opening fetches ONCE and caches — collapsing
   * and reopening costs nothing, which is the behaviour the test asserts.
   */
  function wire(el, ctx) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('[data-whbranch]').forEach((n) => {
      n.addEventListener('click', async () => {
        const name = n.dataset.whbranch;
        if (OPEN.has(name)) { OPEN.delete(name); ctx.redraw(); return; }
        OPEN.add(name);
        ctx.redraw();
        if (DETAIL.has(name)) return;
        try {
          const q = new URLSearchParams({ name, from: ctx.from(), to: ctx.to() });
          DETAIL.set(name, await ctx.api(`/api/targets-live-branch?${q}`));
        } catch {
          /* A branch that will not load must not empty the panel around it. */
          DETAIL.set(name, { families: [], doctors: [] });
        }
        ctx.redraw();
      });
    });
  }

  /** The range changed, so every cached breakdown is about the wrong window. */
  function reset() { DETAIL.clear(); }

  return { html, wire, reset, OPEN, DETAIL };
});
