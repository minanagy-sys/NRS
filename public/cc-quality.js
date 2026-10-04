/* ============================================================
   07 — Data quality.

   Not a list of typos. These are the reasons the other seven panels have to
   work as hard as they do, and each one is a decision somebody can take in
   Odoo this week.

   THE CROSS-LOGIN CHECK IS THE USEFUL ONE. A person whose HR record says they
   work under "Front Office", opening leads under "Call Center", means neither
   report can attribute their work — and it is invisible from inside Odoo,
   because Odoo only ever sees the login.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcQuality = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, windowBanner, table, kpi, kpis } = F;

  function html(D) {
    const Q = D && D.quality;
    if (!Q) return '';
    const T = Q.totals;

    let h = `<section>
      <div class="kicker">07 — Data quality</div>
      <h2 class="title">What stops this report being simpler</h2>
      <p class="sub">Every item here is a change somebody can make in Odoo. None of them is a
        reporting problem.</p>
      ${windowBanner(Q.window, 'Data quality')}`;

    h += kpis([
      kpi('People in HR', fmt(T.employees), `${fmt(T.active)} active`, 'accent'),
      kpi('Working under another login', fmt(T.crossLoginPeople),
        `${fmt(T.crossLoginRows)} records affected`),
      kpi('Employee field overwritten', fmt(T.overwritten),
        `${pc(T.overwritten / (T.leads || 1))} of opportunities`),
      kpi('Records with no stamp', fmt(T.unstamped), 'nobody can be named at all'),
    ]);

    h += `<h3 class="subtitle">The agenda</h3>`;
    for (const a of Q.agenda) {
      h += `<div class="tg-note"><strong>${esc(a.what)}</strong><br>${esc(a.why)}
        <br><br><em>To fix it:</em> ${esc(a.fix)}</div>`;
    }

    if (Q.crossLogin.length) {
      h += `<h3 class="subtitle">Working under somebody else's login</h3>
        <p class="sub">The person's HR record names one login; these records were opened under
          another.</p>
        ${table(Q.crossLogin, [
    { k: 'person', h: 'Person' },
    { k: 'home', h: 'Should be' },
    { k: 'used', h: 'Actually used' },
    { k: 'n', h: 'Records', n: true, f: (r) => fmt(r.n) },
  ], { scroll: true, h: 320 })}`;
    }

    if (Q.nearDuplicates.length) {
      h += `<h3 class="subtitle">Names that may be the same person</h3>
        <p class="sub">Matched after lowercasing, dropping a leading "Dr." and keeping letters
          only. A human has to decide; this only finds the candidates.</p>
        ${table(Q.nearDuplicates.map((d) => ({ names: d.names.join('  ·  ') })), [
    { k: 'names', h: 'Possibly the same person' },
  ], { scroll: true, h: 260 })}`;
    }

    if (Q.issues.length) {
      h += `<h3 class="subtitle">HR records to fix</h3>
        <p class="sub">${fmt(Q.issues.length)} of ${fmt(T.employees)} records are missing
          something the attribution depends on.</p>
        ${table(Q.issues, [
    { k: 'name', h: 'Name' },
    { k: 'active', h: 'Active', f: (r) => (r.active ? 'yes' : 'archived') },
    { k: 'why', h: 'What is missing' },
  ], { scroll: true, h: 420 })}`;
    }

    return `${h}</section>`;
  }

  function wire() { /* nothing interactive */ }
  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render };
});
