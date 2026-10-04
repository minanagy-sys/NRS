/* ============================================================
   Management gates and the pool simulator.

   One module because the five functions below are mutually recursive and there
   is no honest seam between them: `renderGates` draws the payout table and the
   simulator; `runSim` fetches a scored month and calls `renderGates` back;
   `wireSim` binds the controls that call `runSim`. Splitting them would mean
   inventing a callback boundary that exists only to satisfy a file count.

   A GATE THAT FAILS PAYS EXACTLY ZERO, and the table says which gate failed and
   why rather than printing a blank — a missing figure and a figure of nothing
   are different claims about somebody's pay.

   THE SIMULATOR IS A SECOND REQUEST, deliberately. It asks the server to score
   a hypothetical month rather than scoring one in the browser, so there is
   still exactly one implementation of the commission rules and it is not this
   one.

   `SIM`, the entity filter and `api` are module state set from one place —
   `setFilters` and `setApi` — for the reason recorded in `cm-summary.js`: the
   bodies are VERBATIM, and rewriting their references by hand is the kind of
   change that looks safe and silently moves a number. The bodies are also
   indented as they were, one level shallower than this wrapper, so the HTML
   they emit is byte-for-byte what it was.

   Loaded as a plain <script> before the page's own, so `CmGates` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CmGates = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;
  const $ = (id) => document.getElementById(id);

  let SCOPE = 'all';
  const inScope = (b) => SCOPE === 'all' || b.entity === SCOPE;
  function setFilters(scope) { SCOPE = scope || 'all'; }

  /* What the simulator is currently asking about, and the answer it got. */
  const SIM = { branch: null, net: null, mult: {} };
  let SIMRUN = null;

  /* The page's own fetch wrapper, injected rather than rebuilt: it redirects to
     sign-in on a 401, and a second copy of that rule would be a second place to
     forget it. */
  let api = async () => { throw new Error('CmGates.setApi was never called'); };
  function setApi(fn) { api = fn; }

  /* Markup the page wants kept above the payout table.
     `renderGates` writes the panel WHOLESALE, and `runSim` calls it back when
     the simulator answers — so anything the controller composed into the panel
     beforehand was silently wiped a few hundred milliseconds after it appeared.
     The prefix is the seam: set once, re-emitted on every redraw. */
  let PREFIX = '';
  function setPrefix(html) { PREFIX = html || ''; }

function payoutSection(T) {
  const basis = T.closed ? 'now' : 'run';
  const rows = T.branches.filter(inScope);
  let h = `<section><div class="kicker">05 — Payout &amp; gates</div>
    <h2 class="title">Who earns, and what gates it</h2>
    <p class="sub">A gate that fails pays <strong>zero</strong> however well an individual branch did.
      ${T.closed ? 'Evaluated on the closed month.'
    : `Evaluated on the <strong>projected</strong> month — on day ${T.daysElapsed} no branch has reached a full-month target, so judging the gates on today's total would report "failed" everywhere.`}</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Area</th><th>Branches</th><th class="n">At the floor</th>
      <th class="n">Combined pools</th><th class="n">Gate</th><th class="n">Earns</th></tr></thead><tbody>`;
  for (const a of T.areas) {
    h += `<tr><td class="nm">${esc(a.area)}</td>
      <td style="font-size:11.5px;color:var(--muted)">${a.branches.map(esc).join(' · ')}</td>
      <td class="n tcell"><b class="${a.passed ? 'g' : 'r'}">${a.hits} of ${a.of}</b><small>needs 2</small></td>
      <td class="n">${fmt(a.poolSum)}</td>
      <td class="n"><span class="pill" style="background:${a.passed ? 'rgba(94,141,74,.14)' : 'rgba(176,80,60,.14)'};color:${a.passed ? '#5e8d4a' : '#b0503c'}">${a.passed ? 'passed' : 'failed'}</span></td>
      <td class="n tcell"><b class="${a.passed ? 'g' : 'r'}">${fmt(a.amount)}</b><small>8% of pools</small></td></tr>`;
  }
  if (T.director) {
    const d = T.director;
    h += `<tr><td class="nm">Sales Director</td><td style="font-size:11.5px;color:var(--muted)">all ${d.of} branches</td>
      <td class="n tcell"><b class="${d.byCount ? 'g' : 'r'}">${d.hits} of ${d.of}</b><small>needs 6</small></td>
      <td class="n">${fmt(d.poolSum)}</td>
      <td class="n"><span class="pill" style="background:${d.passed ? 'rgba(94,141,74,.14)' : 'rgba(176,80,60,.14)'};color:${d.passed ? '#5e8d4a' : '#b0503c'}">${d.passed ? 'passed' : 'failed'}</span>
        <div class="sm2" style="text-align:right">${d.byCount ? 'on branch count' : d.byGroup ? `on group ${pc(d.groupAchieved)}` : `group ${pc(d.groupAchieved)}, needs 85%`}</div></td>
      <td class="n tcell"><b class="${d.passed ? 'g' : 'r'}">${fmt(d.amount)}</b><small>5% of pools</small></td></tr>`;
  }
  h += `</tbody></table></div>`;

  h += `<h3 class="subtitle">The team split, branch by branch</h3>
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th class="n">Pool</th>
      ${T.roles.map((r) => `<th class="n">${esc(r.name)}</th>`).join('')}</tr></thead><tbody>`;
  for (const b of rows.filter((x) => x[basis].pool)) {
    h += `<tr><td class="nm">${esc(b.name)}</td><td class="n"><b>${fmt(b[basis].pool)}</b></td>
      ${b[basis].roles.map((r) => `<td class="n">${fmt(r.amount)}</td>`).join('')}</tr>`;
  }
  if (!rows.some((x) => x[basis].pool)) {
    h += `<tr><td colspan="${T.roles.length + 2}" style="color:var(--muted);font-size:12.5px">No branch qualifies, so there is nothing to split.</td></tr>`;
  }
  h += `</tbody></table></div>`;

  /* The call-centre layer. Report 05 lists it as a table of tiers with a reason
     each, and the reasons are the useful part: this is not "not built yet", it
     is blocked on data that does not exist. */
  h += `<h3 class="subtitle">Call centre layer <span class="sm2">not computed</span></h3>
    <p class="sub">The policy pays the call centre per patient outcome. None of it can be
      credited from what NRS holds, and each row says which specific thing is missing rather
      than showing a zero that reads as "nobody earned anything".</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Tier</th><th class="n">Rate</th>
      <th class="n">Credited</th><th>Why not</th></tr></thead><tbody>
      <tr><td class="nm">NEW patient · invoiced</td><td class="n">30</td><td class="n">0</td>
        <td class="sub" style="margin:0">Odoo's new-patient flag overstated new patients by ~44% in June:
          deleted historical invoices make a returning patient look new. NRS decides new-versus-returning
          from first invoice in the cache instead, but the cache starts 2026-01-01, so anyone whose first
          visit predates that is unprovable. See the Patients report.</td></tr>
      <tr><td class="nm">Reactivated · 6&ndash;12 months</td><td class="n">15</td><td class="n">0</td>
        <td class="sub" style="margin:0">Needs invoice history back to 2023 plus mobile de-duplication.
          NRS holds 2026 only.</td></tr>
      <tr><td class="nm">Reactivated · 1&ndash;2 years</td><td class="n">10</td><td class="n">0</td>
        <td class="sub" style="margin:0">Same gap, further back.</td></tr>
      <tr><td class="nm">Per-agent attribution</td><td class="n">&mdash;</td><td class="n">0</td>
        <td class="sub" style="margin:0">Every call-centre booking is entered under one shared login, so
          <code>create_uid</code> identifies the desk and never a person. The bonus is per agent, so it
          cannot be split from this field at all — not a history problem, a design one.</td></tr>
    </tbody></table></div>
    <div class="tg-note" style="border-left:3px solid #c98a2e"><strong>Nothing above is a zero
      you can act on.</strong> Three rows need history NRS does not have; the fourth needs a
      field Odoo does not populate per person. Crediting any of them would be inventing numbers.</div>`;

  return `${h}</section>`;
}

async function runSim(T) {
  const rows = T.branches.filter(inScope);
  if (!SIM.branch || !rows.some((b) => b.name === SIM.branch)) {
    const first = rows[0];
    if (!first) return;
    SIM.branch = first.name;
    SIM.net = Math.round(first.net);
  }
  const br = rows.find((b) => b.name === SIM.branch);
  const q = new URLSearchParams({
    branchId: br.branchId, year: T.year, month: T.month,
    net: Math.max(0, Math.round(Number(SIM.net) || 0)),
    mults: Object.keys(SIM.mult).filter((k) => SIM.mult[k]).join(','),
  });
  try {
    SIMRUN = await api(`/api/targets-simulate?${q}`);
    renderGates(T);
  } catch (e) {
    $('gates').innerHTML = PREFIX + payoutSection(T)
      + `<section><h3 class="subtitle">Could not score that</h3>
         <p class="sub">${esc(e.message)}</p></section>`;
  }
}

function wireSim(T) {
  const rows = T.branches.filter(inScope);
  const br = rows.find((b) => b.name === SIM.branch);
  if (!br) return;
  const nb = $('simBranch');
  if (nb) nb.addEventListener('change', () => { SIM.branch = nb.value; SIM.net = null; runSim(T); });
  const nn = $('simNet');
  if (nn) nn.addEventListener('change', () => { SIM.net = nn.value; runSim(T); });
  const rb = $('simReset');
  if (rb) rb.addEventListener('click', () => { SIM.net = Math.round(br.net); runSim(T); });
  document.querySelectorAll('#gates [data-mult]').forEach((cb) => cb.addEventListener('change', () => {
    SIM.mult[cb.dataset.mult] = cb.checked; runSim(T);
  }));
}

function renderGates(T) {
  const rows = T.branches.filter(inScope);
  const br = rows.find((b) => b.name === SIM.branch);
  $('gates').innerHTML = PREFIX + payoutSection(T) + (SIMRUN && br ? simSection(T, br) : '');
  wireSim(T);
}

function simSection(T, br) {
  const r = SIMRUN;
  const rows = T.branches.filter(inScope);
  const actual = Math.round(br.net);

  let h = `<section><div class="kicker">06 — Simulator</div>
    <h2 class="title">What would that <em>pay</em></h2>
    <p class="sub">Pick a branch, type a net collection ex-VAT, and policy
      <strong>${esc(r.policyVersion || '—')}</strong> runs on it server-side: band, ladder tier,
      base pool, multipliers, the &times;${r.multiplierCap.toFixed(2)} cap and the per-title split.
      It opens on the branch's real figure for ${esc(T.from)} → ${esc(T.to)}, so the first thing you
      see is what the range has actually produced.</p>

    <div class="tg-tools">
      <select class="tg-sort" id="simBranch">
        ${rows.map((b) => `<option value="${esc(b.name)}"${b.name === SIM.branch ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
      </select>
      <label class="fld">Net collection ex-VAT
        <input type="number" id="simNet" value="${Math.round(Number(SIM.net) || 0)}" step="50000" min="0"></label>
      <button class="btn ghost" id="simReset">Load actual (${fmt(actual)})</button>
    </div>
    <div class="tg-tools" style="margin-top:6px">
      ${r.departments.map((dp) => `<label class="tg-flat"><input type="checkbox" data-mult="${esc(dp.key)}"${SIM.mult[dp.key] ? ' checked' : ''}> ${esc(dp.label)} &times;${dp.multiplier}</label>`).join('')}
    </div>

    <div class="tg-sum">
      <div class="tg-s"><div class="l">Achievement</div><div class="p">${pc(r.achievement)}</div>
        <div class="n">${fmt(r.net)}<br>of ${fmt(r.target)} target</div>
        <div class="b"><i style="width:${Math.min(100, r.achievement * 100).toFixed(1)}%"></i>
          <u style="left:${(r.bands.floor * 100).toFixed(0)}%"></u></div></div>
      <div class="tg-s"><div class="l">Band</div><div class="p">${esc(r.band === 'zero' ? 'none' : r.band)}</div>
        <div class="n">${esc(r.bandLabel || '')}<br>floor ${pc(r.bands.floor, 0)} · mid ${pc(r.bands.mid, 0)} · max ${pc(r.bands.max, 0)}</div></div>
      <div class="tg-s"><div class="l">Ladder tier</div><div class="p">${r.tierNo || '—'}</div>
        <div class="n">${esc(r.tierLabel || '—')}<br>base pool ${fmt(r.basePool)}</div></div>
      <div class="tg-s inj"><div class="l">Final pool</div><div class="p">${fmt(r.pool)}</div>
        <div class="n">${r.multiplier && r.multiplier.applied > 1
    ? `&times;${r.multiplier.applied.toFixed(2)} applied${r.multiplier.capped ? ` <b class="r">(capped from &times;${r.multiplier.raw.toFixed(3)})</b>` : ''}`
    : 'no multiplier'}</div></div>
    </div>`;

  if (r.band === 'zero') {
    const need = r.target * r.bands.floor;
    h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>Nothing is payable at
      ${pc(r.achievement)}.</strong> ${pc(r.bands.floor, 0)} of target is the first paying point under
      ${esc(r.policyVersion || 'this policy')}, which needs ${fmt(need)} — a further
      ${fmt(Math.max(0, need - r.net))}. Multipliers do not apply below the band, so ticking them
      changes nothing here.</div>`;
  } else if (!r.basePool) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>The band is met but the
      ladder rung pays nothing.</strong> ${esc(r.tierLabel || 'This rung')} carries a zero pool in all
      three bands — the policy's own floor for small collections. Raise the figure to the next rung to
      see a pool.</div>`;
  }

  if (r.roles && r.roles.length && r.pool) {
    h += `<h3 class="subtitle">Per-title split</h3>
      <div class="tw"><table class="ltab"><thead><tr><th>Role</th><th class="n">Share</th><th class="n">Amount</th></tr></thead><tbody>
        ${r.roles.map((x) => `<tr><td class="nm">${esc(x.name || x.role)}</td><td class="n">${pc(x.sharePct || x.share, 0)}</td><td class="n">${fmt(x.amount)}</td></tr>`).join('')}
      </tbody><tfoot><tr><th>Total</th><th class="n">100%</th><th class="n">${fmt(r.roles.reduce((a, x) => a + x.amount, 0))}</th></tr></tfoot></table></div>`;
  }

  h += `<div class="tg-note">Scored by the same code as the real month, against
    ${esc(String(T.year))}-${String(T.month).padStart(2, '0')}'s stored target. Edit the ladder, the
    bands or the split in Admin and this moves with them.</div></section>`;
  return h;

  /* Re-bind after each repaint, since the panel is replaced wholesale. */
}

  return { setFilters, setApi, setPrefix, SIM, renderGates, runSim, wireSim, payoutSection, simSection };
});
