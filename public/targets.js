/* Targets & Plan — doctors against the approved target schedule.
 *
 * WHAT THIS REPORT MEASURES, and why it is not the Commission page. The sheet
 * Finance publishes each month sets a target per doctor, in INVOICED revenue
 * ex-VAT and ex-package. The Commission report measures something else: branches
 * against the commission policy, in CASH COLLECTED. Two agreements, two bases,
 * and they are not expected to agree. They shared a page for a while and the
 * page had to spend a paragraph apologising for it.
 *
 * The 2027 plan panels — Live, Plan, Actuals, Branch targets, Service targets —
 * land here next. Today it is the two panels that read the published sheet.
 *
 * Everything arrives already scored by /api/targets-tracker, so the page decides
 * nothing: no second copy of the rules in the browser.
 */

const { $, fmt, pc, esc } = TgFmt;

let DATA = null;
/* The plan — 2027 targets, the policy and the frozen history. Fetched ONCE and
   kept: nothing in it moves when the date range does, and the endpoint is
   ETagged precisely so a reader pays for it once. */
let PLAN = null;
let LIVE = null;
let AC = null;
let AC_YEAR = null;

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

/* ------------------------------------------------- 01 · target vs achieved --

   THE SAME SECTION NRS DRAWS, not a copy of it. `public/target-view.js` holds
   the markup and both pages call it — see that file for why a second table with
   the same colouring rules and sort options would have agreed exactly until the
   first time somebody edited one of them. */

function tvaHtml() {
  const T = DATA && DATA.targets;
  return TargetView.html(T, {
    kicker: '06 — Target vs achieved',
    Rules,
    append: `<div class="tg-note" style="margin-top:16px">This report scores the
      <strong>approved target schedule</strong> — doctors against the monthly sheet published in
      Admin, in invoiced revenue. <strong>Commission &amp; Payslips</strong> scores something else
      entirely: <strong>branches against collected cash</strong>, on the commission policy. Two
      different agreements, two different bases, and they are not expected to agree.</div>`,
  });
}

/* THE APPROVED SHEET AND THE PLAN, ON ONE TAB. Three sections, in the order a
   reader needs them: the sheet scored against actuals, the same doctors flat,
   then the multi-year plan. They were separate tabs and the separation taught
   nobody anything — they are all "how are doctors doing against a number". */
function renderDocTargets() {
  $('doc').innerHTML = tvaHtml()
    + TgDr.html(DATA && DATA.targets, DATA && DATA.commission)
    + (PLAN ? TgDr.planHtml(PLAN) : '');
  TargetView.wire(renderDocTargets, document);
  TgDr.wirePlan($('doc'), renderDocTargets);
}

function renderWh() {
  if (!LIVE) return;
  $('wh').innerHTML = TgWh.html(LIVE);
  TgWh.wire($('wh'), {
    api, redraw: renderWh, from: () => $('from').value, to: () => $('to').value,
  });
}

function renderAc() {
  const years = PLAN ? [...new Set(PLAN.history.months.map((m) => Number(m.slice(0, 4))))].sort() : [];
  $('ac').innerHTML = TgAc.html(AC, years);
  TgAc.wire($('ac'), async (y) => {
    AC_YEAR = y;
    AC = await api(`/api/targets-actuals?year=${y}`);
    renderAc();
  });
}

/* ---- the plan panels ----

   All three read the SAME `/api/targets-plan` answer and nothing else, so they
   are redrawn by a chip rather than refetched. Each binds its own controls
   directly to its own panel — a delegated handler on `document` is one the test
   harness cannot fire, which is how a dead call survived here for weeks. */

function renderOv() {
  if (!PLAN) return;
  $('ov').innerHTML = TgOv.html(PLAN);
  TgOv.wire($('ov'), renderOv);
}

function renderTb() {
  if (!PLAN) return;
  $('tb').innerHTML = TgTb.html(PLAN);
  TgTb.wire($('tb'), renderTb);
}

function renderTs() {
  if (!PLAN) return;
  $('ts').innerHTML = TgTs.html(PLAN);
  TgTs.wire($('ts'), renderTs);
}

function paint() {
  const T = LIVE && LIVE.totals;
  if (!T) {
    $('hPeriod').textContent = DATA ? ` ${DATA.from} → ${DATA.to}` : '';
    for (const id of ['hTarget', 'hAch', 'hPace', 'hDocs']) $(id).textContent = '—';
    $('rangeline').textContent = 'Loading…';
  } else {
    const floor = T.floorPct || 0.8;
    $('hPeriod').textContent = ` ${LIVE.window.from} → ${LIVE.window.to}`;
    $('hTarget').textContent = fmt(T.collected);
    $('hAch').textContent = fmt(T.billed);
    $('hPace').textContent = T.achievement == null ? '—' : pc(T.achievement);
    $('hPaceU').textContent = T.target ? `of ${fmt(T.target)} planned` : 'no plan for this range';
    $('hDocs').textContent = `${T.atFloor} / ${T.branchesWithTarget}`;
    $('hDocsU').textContent = `at ${pc(floor, 0)}, the floor the policy pays from`;
    const S = DATA && DATA.targets;
    $('rangeline').innerHTML = `<strong>${LIVE.window.covered} of ${LIVE.window.days} days</strong>
      · collected <strong>ex-VAT ÷ ${T.vatDivisor}</strong> · billed <strong>ex-package</strong>
      · ${fmt(LIVE.branches.length)} branches · ${fmt(LIVE.doctors.length)} doctors${
  S && !S.missing ? ` · sheet <strong>${esc(S.period)}</strong>` : ' · <span style="color:#c98a2e">no approved sheet</span>'}`;
  }

  renderWh();
  renderDocTargets();
  renderOv();
  renderAc();
  renderTb();
  renderTs();
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    /* The plan is fetched once and the tracker on every range change. In
       parallel the first time, because the plan is 26 KB behind an ETag and
       waiting for it in series would add its round trip to every page load. */
    /* Three answers in parallel. The plan is fetched once behind its ETag; the
       tracker and the live figures follow the range. */
    const [tracker, plan, live] = await Promise.all([
      api(`/api/targets-tracker?${q}`),
      PLAN ? Promise.resolve(PLAN) : api('/api/targets-plan'),
      api(`/api/targets-live?${q}`),
    ]);
    DATA = tracker;
    PLAN = plan;
    LIVE = live;
    /* Every cached branch breakdown is about the window that just changed. */
    TgWh.reset();
    if (!AC) {
      AC_YEAR = AC_YEAR || Number($('to').value.slice(0, 4));
      AC = await api(`/api/targets-actuals?year=${AC_YEAR}`);
    }
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

/* The entity switch is in the shared bar. The sheet has no entity column, so it
   filters nothing HERE yet — it starts working when the branch panels land. It
   is wired rather than removed so the control does not sit on the page doing
   nothing silently. */
document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#scope button').forEach((x) => x.classList.toggle('on', x === b));
  if (DATA) paint();
}));

$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

/* ---- the five-minute loop ----
   Guarded twice, and both guards matter. `document.hidden` stops eleven open
   tabs from each polling in the background; the active-panel check stops a
   reader studying the 2027 plan from having the page rebuilt under them. */
setInterval(() => {
  try {
    if (document.hidden) return;
    const active = document.querySelector('.panel.active');
    if (!active || active.id !== 'wh') return;
    load();
  } catch { /* a page with no document is a test harness, not a browser */ }
}, 300000);

document.addEventListener('visibilitychange', () => {
  /* Coming back to a tab that sat hidden through two intervals should show the
     current figure, not the one from before lunch. */
  const active = document.querySelector('.panel.active');
  if (!document.hidden && active && active.id === 'wh' && LIVE) load();
});

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
