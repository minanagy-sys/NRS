/* Commission & Payslips — the branch pool, the doctor pack and the gates.
 *
 * Everything here arrives already scored by /api/targets-tracker, so the page
 * decides nothing about bands, tiers or pools. One payload, no second copy of
 * the rules in the browser.
 *
 * WHY THIS IS A SEPARATE REPORT FROM TARGETS. The two measure different things
 * on different bases: Targets scores doctors against the approved target sheet
 * in INVOICED ex-VAT revenue; this scores branches against the commission
 * policy in CASH COLLECTED ex-VAT. They are two agreements, and they are not
 * expected to agree. They shared a page for a while and the page had to spend a
 * paragraph apologising for it; two URLs say the same thing structurally.
 *
 * The panels themselves live in `cm-summary.js`, `cm-doctors.js`, `cm-gates.js`
 * and `payslip.js`. This file is the controller: state, fetch, paint, wiring.
 */

const { $, fmt, pc, esc } = TgFmt;

let DATA = null;
let SCOPE = 'all';
let MIXBRANCH = 'all';
/* The v3.2 scoring — what everyone earns. A second answer from a second
   endpoint, because it is a different policy generation from the tracker. */
let V32 = null;

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const inScope = (b) => SCOPE === 'all' || b.entity === SCOPE;

const openPayslip = (name) => {
  const C = DATA && DATA.commission;
  if (!C || C.error) return;
  Payslip.open(C.rows, C.period, name, document);
};

function paint() {
  const T = DATA;
  const rows = T.branches.filter(inScope);
  $('hPeriod').textContent = `${T.from} → ${T.to}`;
  $('hNet').textContent = fmt(rows.reduce((s, b) => s + b.net, 0));
  if (V32 && V32.totals) {
    /* The headline is the v3.2 answer, because that is what tab 01 shows. The
       two older figures stay in the two cards beside it. */
    $('hPool').textContent = fmt(V32.totals.all);
    $('hPoolU').textContent = V32.totals.openMonths
      ? `EGP · ${fmt(V32.totals.payable)} payable, the rest forecast`
      : 'EGP · all payable';
  }
  const prorata = rows.reduce((s, b) => s + (b.prorata || 0), 0);
  $('hPace').textContent = pc(prorata ? rows.reduce((s, b) => s + b.net, 0) / prorata : 0);
  /* PAYABLE, not projected. The run-rate count and the projected pool are real
     and useful, but they belong on the Summary panel where each is labelled a
     forecast — in the header they would read as money already earned. Mid-month
     both of these are zero, and that is the correct headline. */
  const withTarget = rows.filter((b) => b.target);
  $('hQual').textContent = `${withTarget.filter((b) => b.achievement >= T.policy.bands.floor).length} / ${withTarget.length}`;
  $('hQualU').textContent = T.closed ? 'on the closed month' : `nothing can reach ${pc(T.policy.bands.floor, 0)} on day ${T.daysElapsed}`;
  $('hPool').textContent = fmt(rows.reduce((s, b) => s + b.now.pool, 0));
  $('hPoolU').textContent = T.closed ? 'EGP · payable' : 'EGP · nothing payable mid-month';
  $('rangeline').innerHTML = `<strong>${T.closed ? 'closed' : `day ${T.daysElapsed} of ${T.daysInMonth}`}</strong>
    · policy <strong>${esc(T.policy.version || '—')}</strong> · eligibility <strong>${pc(T.policy.bands.floor, 0)}</strong>
    · base <strong>net collection ex-VAT</strong> · source <strong>${esc(T.source)}</strong>
    · ${fmt(T.totals.txns)} payments${T.unmatched.length ? ` · <span style="color:#b0503c">${T.unmatched.length} branch(es) unmatched</span>` : ''}`;

  /* Two banners that decide how everything below should be read.

     The first: a range spanning months is a SUM of months, not one long month.
     The second, and the more dangerous one: for any range before the Odoo 18
     cutover the cash exists but carries no branch_id, so every per-branch figure
     collapses toward zero while the money was really collected. Without this the
     report shows June as eleven branches at 0.1% of target. */
  let banner = '';
  const R2 = T.range;
  if (R2 && R2.multi) {
    banner += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${R2.totals.monthsCovered} months in this range, scored separately.</strong>
      A branch is measured against one month's target, so the pools below are each month's
      pool added together — not one comparison of pooled cash against a pooled target, which
      would let a strong month carry a failing one into a band it never reached.
      ${R2.totals.partialMonths ? `${R2.totals.partialMonths} month${R2.totals.partialMonths === 1 ? ' is' : 's are'} clipped by the range and measured against the FULL month target, so ${R2.totals.partialMonths === 1 ? 'it' : 'they'} will read as behind.` : ''}
      <div class="tw" style="margin-top:10px"><table class="ltab tight"><thead><tr><th>Month</th>
        <th class="n">Covers</th><th class="n">Collected ex-VAT</th><th class="n">Target</th>
        <th class="n">Achievement</th><th class="n">Qualifying</th><th class="n">Pool</th></tr></thead><tbody>
        ${R2.months.map((m) => {
    const qual = m.branches.filter((b) => b[m.closed ? 'now' : 'run'].band !== 'zero').length;
    const pool = m.branches.reduce((a, b) => a + b[m.closed ? 'now' : 'run'].pool, 0);
    return `<tr><td class="nm">${esc(m.key)}${m.partial ? ' <span class="sm2">partial</span>' : ''}</td>
          <td class="n">${esc(m.coversFrom.slice(8))}–${esc(m.coversTo.slice(8))}</td>
          <td class="n">${fmt(m.totals.net)}</td><td class="n">${fmt(m.totals.target)}</td>
          <td class="n">${pc(m.totals.achievement)}</td>
          <td class="n">${qual} / ${m.branches.length}</td><td class="n">${fmt(pool)}</td></tr>`;
  }).join('')}
      </tbody><tfoot><tr><th>Range</th><th class="n"></th><th class="n">${fmt(R2.totals.net)}</th>
        <th class="n">${fmt(R2.totals.target)}</th>
        <th class="n">${pc(R2.totals.target ? R2.totals.net / R2.totals.target : 0)}</th>
        <th class="n"></th><th class="n">${fmt(R2.totals.pool)}</th></tr></tfoot></table></div>
      <p class="sub" style="margin-top:8px">The panels below show
        <strong>${esc(T.from)} → ${esc(T.to)}</strong>, the last month in the range.</p></div>`;
  }

  const U = T.unattributed;
  if (U && U.share > 0.02) {
    const blocking = !T.branchScoringPossible;
    banner += `<div class="tg-note" style="border-left:3px solid ${blocking ? '#b0503c' : '#c98a2e'}">
      <strong>${fmt(U.net)} of collected cash has no branch — ${pc(U.share)} of this range.</strong>
      Odoo 18 went live 2026-08-01 and payments migrated from the old system carry no
      <code>branch_id</code>.
      ${blocking
    ? 'Per-branch scoring is <strong>not possible</strong> for this range: the money was really collected, but it cannot be attributed, so every branch below reads as near-zero against target. Those are not failing branches — they are unattributable months. Pick a range from August onward to score branches.'
    : 'The branch split below is materially complete; this residue is filed as Unassigned.'}</div>`;
  }

  /* The panels read the entity switch and the mix picker. Pushed in here, once,
     immediately before anything is drawn — so there is exactly one moment at
     which a module's copy and this page's can disagree, and it is this line. */
  CmSummary.setFilters(SCOPE, MIXBRANCH);
  CmGates.setFilters(SCOPE);

  /* 01 Summary is the v3.2 answer — the pool grid, the teams, the gates. The
     older tracker sections keep their own tab rather than being deleted: they
     score the SAME branches on the v2.8 policy with its version history, which
     is the only place that comparison exists. */
  $('cm').innerHTML = V32 ? CmV32.summary(V32) : '<section><h2 class="title">Loading…</h2></section>';
  $('cmd').innerHTML = CmDoctors.html(T.commission);
  $('cms').innerHTML = V32 ? CmV32.staff(V32) : '';
  $('cmc').innerHTML = CmV32.callCentre(V32, (V32 && V32.callCentre) || {});

  /* Banners belong at the top of the tracker panel: they qualify the branch
     figures, not the doctor ones. */
  CmGates.setPrefix(banner + CmSummary.paceSection(T) + CmSummary.trackerSection(T)
    + CmSummary.sheetBranch(T.targets));
  CmGates.renderGates(T);
  CmGates.runSim(T).catch(() => {});
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    if (new URLSearchParams(location.search).get('versions') === '1') q.set('versions', '1');
    const [tracker, v32] = await Promise.all([
      api(`/api/targets-tracker?${q}`),
      api(`/api/commission-month?${q}`),
    ]);
    DATA = tracker;
    V32 = v32;
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${DATA.policy.version || 'policy'} · ${DATA.source}`;
  } catch (e) {
    $('dot').className = 'dot bad';
    $('status').textContent = 'failed';
    $('err').textContent = e.message;
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
/* Any range. An earlier version refused anything spanning two months, because
   commission is scored against ONE month's target — a correct instinct built as
   a wall. The range is now sliced into months server-side, each scored against
   its own target, and the pools added the way payroll adds them, so a quarter
   or a year is a legitimate question again. */
function preset(p) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (p === 'lastmonth') {
    $('from').value = iso(new Date(Date.UTC(y, m - 1, 1)));
    $('to').value = iso(new Date(Date.UTC(y, m, 0)));
  } else if (p === 'quarter') {
    $('from').value = iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)));
    $('to').value = iso(now);
  } else if (p === 'ytd') {
    $('from').value = `${y}-01-01`;
    $('to').value = iso(now);
  } else {
    $('from').value = `${iso(now).slice(0, 7)}-01`; $('to').value = iso(now);
  }
}

document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
  preset(b.dataset.p); load();
}));

/* The mix filter lives inside a panel that is replaced wholesale on every
   repaint, so it is delegated from the document rather than bound to the node. */
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'mixBranch') {
    MIXBRANCH = e.target.value;
    if (DATA) paint();
  }
});

/* The payslip, the CSV and the modal. Delegated, because the Doctors panel is
   rebuilt on every range change and its rows come from the payload rather than
   a fixed list here. */
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;

  const slip = e.target.closest('[data-slip]');
  if (slip) { openPayslip(slip.dataset.slip); return; }

  if (e.target.id === 'comCsv') {
    const C = DATA && DATA.commission;
    if (C && !C.error) CmDoctors.csv(C, document);
    return;
  }

  /* Clicking the backdrop closes; clicking inside the card does not. */
  if (e.target.id === 'dlg') $('dlg').hidden = true;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('dlg').hidden) $('dlg').hidden = true;
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.classList) return;
  if (!el.classList.contains('searchbox') && !el.classList.contains('search-input')) return;
  const q = el.value.toLowerCase().trim();
  const panel = el.closest('.panel');
  if (!panel) return;
  panel.querySelectorAll('[data-search-target]').forEach((n) => {
    n.style.display = !q || n.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#scope button').forEach((x) => x.classList.toggle('on', x === b));
  SCOPE = b.dataset.scope;
  if (DATA) paint();
}));

$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

/* The simulator fetches a scored month of its own. It gets THIS wrapper rather
   than building one, so the 401-to-sign-in rule has exactly one home. */
CmGates.setApi(api);

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
