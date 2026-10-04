/* The two new report pages, rendered against REAL API payloads under a DOM shim.
 *
 *   node test/render.test.js
 *
 * These pages are ~600 lines of template strings, and template strings fail in
 * two ways that no server-side test catches: an unbalanced tag, which silently
 * swallows the rest of a panel, and an `undefined` reaching the page because a
 * field was renamed. Both render a page that looks finished and has a green
 * status dot. So this walks the actual payloads through the actual page code and
 * asserts the markup balances and contains no `undefined` or `NaN`.
 *
 * It also pins the four cases where these pages are supposed to REFUSE rather
 * than draw: a pre-cutover range with no real outcomes, a year-to-date range
 * that must be clamped, an incomplete journal, and a window where "new patient"
 * cannot be proven. Every one of those would otherwise render a confident,
 * wrong number.
 *
 * The point is not to test the DOM — it is to prove that every render function
 * survives the actual data (nulls, empty arrays, absent journals, the cutover
 * clamp) and produces markup whose tags balance. A page that throws halfway
 * through leaves a half-drawn panel and a green status dot.
 */
const path = require('path').join(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const { prisma } = require(`${path}/src/lib/db.js`);
const Appointments = require(`${path}/src/lib/appointments.js`);
const Report = require(`${path}/src/lib/report.js`);
const Patients = require(`${path}/src/lib/patients.js`);

const fmtNum = (n) => Math.round(Number(n)).toLocaleString('en-US');
const Payslip = require(`${path}/public/payslip.js`);

/** The page's own `esc`, so a name carrying an ampersand — "Randa & Poussy" is
 *  a real scheme — is looked for as it was WRITTEN into the HTML, not as it was
 *  typed. Checking for the raw string would fail on exactly the scheme whose
 *  escaping is worth checking. */
const esc0 = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

let csLast = null;
let fails = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* A DOM just real enough: elements record innerHTML, and querySelectorAll
   returns empty lists so the control wiring is a no-op. */
/* A DOM just real enough to CLICK.
 *
 * `querySelectorAll` returning [] was enough to prove panels render, and that is
 * exactly why the broken entity filter survived: a control nothing ever clicks
 * cannot be observed to do nothing. So selectors the pages actually query are
 * backed by real nodes whose handlers fire, and `nodes(sel)` hands them to a
 * test. `SCOPE` is a module-level `let` inside the vm script and therefore NOT a
 * sandbox property — clicking the button is the only way in from outside. */
function fakeNode(dataset) {
  const handlers = {};
  return {
    dataset,
    className: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(ev, fn) { (handlers[ev] ||= []).push(fn); },
    /* DISPATCH OVER A COPY, the way a real browser does.
       These stub nodes OUTLIVE a repaint — the page replaces innerHTML and the
       browser throws the old nodes and their listeners away, but this harness
       hands back the same object every time, so each repaint binds another
       listener to it. Iterating the live array then meant a handler that asks
       for a repaint appended to the very array being walked, and `for...of`
       re-checks length every step: one click span an infinite loop at 100% CPU
       and the suite never finished. Copying first also matches DOM dispatch,
       which snapshots the listener list before calling any of them. */
    fire(ev) { for (const fn of [...(handlers[ev] || [])]) fn({ target: this }); },
  };
}

function makeDom(ids, selectors = {}) {
  const els = {};
  const sel = {};
  for (const id of ids) {
    els[id] = {
      innerHTML: '', textContent: '', className: '', value: '2026-08-01',
      dataset: {}, addEventListener() {}, disabled: false,
      /* admin.js wires its panels with `$('periods').querySelectorAll(...)`,
         not through the document, so an element that cannot be queried leaves
         every button in that panel unclicked — the same blind spot that let the
         broken entity filter through. */
      querySelectorAll: (q) => sel[q] || [],
      querySelector: (q) => (sel[q] || [])[0] || null,
    };
  }
  for (const [q, list] of Object.entries(selectors)) sel[q] = list.map(fakeNode);
  return {
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: (q) => sel[q] || [],
      addEventListener() {},
      documentElement: { style: { setProperty() {} } },
    },
    els,
    nodes: (q) => sel[q] || [],
  };
}

function runPage(file, payload, ids, selectors) {
  const { document, els, nodes } = makeDom(ids, selectors);
  const timers = [];
  const sandbox = {
    document,
    console,
    location: { search: '', href: '' },
    /* URL-aware when the caller passes a map. The Targets page calls
       `/api/targets-simulate` as well as its own endpoint, and answering both
       with the same object hands the simulator a tracker payload — which fails
       on `.toFixed` and renders the error path, exactly as it should. */
    fetch: async (url) => {
      const u = String(url).split('?')[0];
      const body = (payload && payload.__byUrl && u in payload.__byUrl)
        ? payload.__byUrl[u] : payload;
      return { ok: true, status: 200, json: async () => body };
    },
    /* `onRefresh` is what a page uses to tell the shared control bar how to
       reload itself (see public/cbar.js). Missing from the stub, every page
       throws on its last line and every panel is empty. */
    Shell: { mountTabs() {}, stickyBar() {}, showPanel() {}, onRefresh() {}, fireRefresh() {} },
    /* app.js (the Sales report) reaches for a few more globals than the newer
       pages: the shared rules module, the draft helper and the target-sheet
       dialog. Stubbed rather than skipped, because leaving the main report out
       of this harness is what let two of its panels go unchecked. */
    Rules: require(`${path}/public/rules.js`),
    Draft: { load: () => null, save() {}, clear() {}, has: () => false },
    /* The "Target vs achieved" section moved into `public/target-view.js` so
       NRS and the Targets report draw the SAME markup rather than two copies.
       Missing from this stub, app.js throws inside renderTargets and every
       panel after it — products, stock, data — renders empty. */
    TargetView: require(`${path}/public/target-view.js`),
    /* The payslip is a module now, so the harness can draw one directly —
       see the assertions in the targets block. */
    Payslip: require(`${path}/public/payslip.js`),
    dlg: { open() {}, close() {}, note() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    alert() {}, confirm: () => false, prompt: () => null,
    URLSearchParams: global.URLSearchParams,
    Date, Number, Math, JSON, String, Object, Array, RegExp, isNaN,
    ResizeObserver: class { observe() {} },
    setTimeout, Promise,
    /* CAPTURED, NOT SCHEDULED. A real `setInterval` would keep the test process
       alive and fire a reload mid-assertion; this records what the page asked
       for so a test can check the period and invoke the callback deliberately —
       which is the only way to prove the loop's guards actually guard. */
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* A LIST, in <script> order, because a page is no longer one file. The
     modules declare globals the page's own script then uses, so running them
     in the wrong order throws exactly the way the browser would — which makes
     this an assertion that the view's script tags are ordered correctly, not
     just a loader. A bare string still works, so the other ten pages are
     untouched. */
  /* public/fmt.js first, INSIDE the sandbox, the way every view loads it:
     evaluated here its `$` resolves the sandbox's `document`. A require()d copy
     would resolve Node's, where there is none. */
  for (const f of ['fmt.js', ...[].concat(file)]) {
    vm.runInContext(fs.readFileSync(`${path}/public/${f}`, 'utf8'), sandbox, { filename: f });
  }
  return { els, sandbox, nodes, timers };
}

/* Tag balance: the cheap check that catches an unclosed <div> or a stray </div>,
   which is exactly what a hand-built template string gets wrong. */
function balanced(html) {
  const stack = [];
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'i']);
  const re = /<(\/?)([a-z][a-z0-9]*)[^>]*?(\/?)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, self] = m;
    const t = tag.toLowerCase();
    if (VOID.has(t) || self) continue;
    if (close) {
      if (stack.pop() !== t) return `mismatched </${t}>`;
    } else stack.push(t);
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

/* The Sales payload comes from a ROUTE rather than a lib function, so this
   harness needs a real Fastify to ask. Built once, lazily, and only for that. */
let __app = null;
async function get2(url) {
  if (!__app) {
    const { build } = require(`${path}/src/server.js`);
    __app = await build();
    __app.log.level = 'silent';
    __app.addHook('preHandler', async (req) => {
      if (!req.user) req.user = { subject: 'render', email: 'render@local' };
    });
  }
  const res = await __app.inject({ method: 'GET', url, headers: { 'X-Requested-With': 'fetch' } });
  if (res.statusCode !== 200) throw new Error(`${url} answered ${res.statusCode}`);
  return res.json();
}

(async () => {
  const W = { from: '2026-08-01', to: '2026-08-19' };

  /* ---------------------------------------------------- commercial ---- */
  console.log('\ncommercial.js against the real August payload');
  const [funnel, revenue] = await Promise.all([
    Appointments.buildFunnel(W),
    Report.revenueExcludingJournals(W.from, W.to, Report.EXCLUDED_REVENUE_JOURNALS),
  ]);
  const Patients0 = require(`${path}/src/lib/patients.js`);
  const Finance0 = require(`${path}/src/lib/finance.js`);
  const Tracker0 = require(`${path}/src/lib/target-tracker.js`);
  const pending = await Appointments.buildPending({ ...W, reveal: true, take: 200 });
  const patientFunnel = await Patients0.buildPatientFunnel(W);
  /* The ratios tab divides by cash and by the commission projection, so the
     payload has to carry both — an earlier version of this payload did not, and
     the two ratios that depend on them rendered as "—" while the real page
     computed them fine. A test payload that is thinner than the route's response
     tests a page nobody runs. */
  const collections0 = await Finance0.resolve()
    .then((cfg) => Finance0.collectionsTotals(cfg, W)).catch(() => null);
  const range0 = await Tracker0.buildTrackerRange(W);
  const cPayload = {
    ...W, funnel, revenue,
    pending: {
      total: pending.total, returned: pending.rows.length,
      noMobile: pending.noMobile, sensitive: pending.sensitive, rows: pending.rows,
    },
    patientFunnel,
    collections: collections0 && !collections0.error ? collections0 : null,
    /* Mirrors the route exactly. It used to mirror `range.latest` instead, which
       is the last month — the same mismatch that made the chain print "cash vs
       revenue 4.3%" on a quarter. A payload shaped differently from the route's
       tests a page nobody runs. */
    tracker: range0.latest ? {
      net: range0.totals.netTotal, netAttributed: range0.totals.net,
      unattributedNet: range0.totals.unattributedNet,
      gross: range0.totals.gross, refunds: range0.totals.refunds,
      txns: range0.totals.txns, pool: range0.totals.pool,
      closed: range0.totals.closed, monthsCovered: range0.totals.monthsCovered,
      latestProjected: range0.latest.totals.projected,
      latestPoolRun: range0.latest.totals.poolRun,
      policyVersion: range0.latest.policy.version,
    } : null,
    /* Steps 0 and 0b, mirroring the route now that the Meta cache answers them.
       They were dashed "no source" boxes for as long as nothing reached NRS, and
       a test payload still carrying that shape would go on passing while the
       real page drew something else entirely. */
    chain: await (async () => {
      const Mk = require(`${path}/src/lib/marketing.js`);
      const [pt, lt] = await Promise.all([Mk.buildPaid(W), Mk.buildLeadQuality(W)]);
      return {
        spend: pt.spend > 0 ? {
          spend: pt.spend, results: pt.results, msgConversations: pt.msgConversations,
          onFbLeads: pt.onFbLeads, costPerResult: pt.costPerResult,
          daysWithData: pt.daysWithData, daysInRange: pt.daysInRange,
        } : null,
        leads: lt.leads > 0 ? {
          leads: lt.leads, withKey: lt.withKey, booked: lt.booked,
          attended: lt.attended, invoiced: lt.invoiced, window: lt.window,
        } : null,
      };
    })(),
    /* Only what is STILL missing. The PBX is the last one left. */
    missingSteps: [
      { key: 'calls', st: 'Step 1', step: 'Conversations', source: 'PBX call logs', reason: 'The PBX is not a source NRS reads.' },
    ],
  };
  const cIds = ['funnel', 'ratios', 'bybranch', 'hPeriod', 'hBook', 'hAtt', 'hShow', 'hPend',
    'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load'];
  const c = runPage('commercial.js', cPayload, cIds);
  await new Promise((r) => setTimeout(r, 60));

  for (const p of ['funnel', 'ratios', 'bybranch']) {
    const html = c.els[p].innerHTML;
    ok(`panel ${p} rendered (${html.length} chars)`, html.length > 400, `only ${html.length}`);
    ok(`panel ${p} tags balance`, !balanced(html), balanced(html));
    ok(`panel ${p} has no literal undefined/NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,40}(undefined|NaN).{0,40}/) || [])[0]);
  }
  /* Report 04's chain: six steps, six arrows, three of them unreachable and
     drawn in place. Counting the step blocks rather than the phrase "no source",
     because the surrounding prose uses that phrase too. */
  const fnl = c.els.funnel.innerHTML;
  /* Seven, not six: report 04 numbers them 0, 0b, 1, 2, 3, 4, 5. */
  /* Two more steps than report 04 had, because Steps 0 and 0b are drawn rather
     than dashed. Counted against the payload instead of a magic number, so
     connecting the PBX later moves this on its own. */
  const ODOO_STEPS = 4;   // booked, attended, invoiced, net collection
  const wantSteps = ODOO_STEPS + (cPayload.chain.spend ? 1 : 0) + (cPayload.chain.leads ? 1 : 0)
    + cPayload.missingSteps.length;
  ok(`${wantSteps} chain steps (${(fnl.match(/class="fn-step /g) || []).length})`,
    (fnl.match(/class="fn-step /g) || []).length === wantSteps,
    `expected ${wantSteps}`);
  ok(`an arrow between each pair (${(fnl.match(/class="fn-arrow"/g) || []).length})`,
    (fnl.match(/class="fn-arrow"/g) || []).length >= 5);
  /* One dashed step left, not three. Steps 0 and 0b were "no source" boxes for
     as long as nothing reached NRS; the Meta cache answers both now, so the only
     unreachable step is the PBX conversation count. The absent ones must still
     be drawn IN PLACE — a chain that silently drops its missing step claims the
     top of the funnel is not there rather than not measured. */
  ok('the one remaining unreachable step is drawn in place, not dropped',
    (fnl.match(/class="fn-step absent"/g) || []).length === 1,
    `${(fnl.match(/class="fn-step absent"/g) || []).length} absent steps`);
  ok('  and it is the PBX one', /PBX call logs/.test(fnl));
  ok('the cost side of the chain is now real, with its own figures',
    /Meta ad spend/.test(fnl) && /per result/.test(fnl));
  /* The prose has to move with the chain. It said "this chain has no cost side
     yet" for as long as that was true; leaving it there would have contradicted
     the step drawn directly beneath it. */
  ok('  and the intro no longer claims the chain has no cost side',
    !/no cost side/.test(fnl));
  ok('  and Step 0b states that a lead-to-booking match counts returning patients',
    /counts returning patients too/.test(fnl));
  ok('report 04\'s step labels, in order', (() => {
    const want = ['Step 0', 'Step 0b', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5'];
    let at = 0;
    for (const w of want) { const i = fnl.indexOf(`>${w}<`, at); if (i < 0) return false; at = i; }
    return true;
  })());
  ok('the chain ends on the commission base', /Net collection ex-VAT/.test(fnl));
  ok('step 5 names the payment count and the refunds',
    /payments less [\d,]+ refunds/.test(fnl));
  /* Both show rates survived the move to the ratios card. */
  ok('both show rates are stated on the ratios card',
    c.els.ratios.innerHTML.includes('44.1%') && c.els.ratios.innerHTML.includes('63.8%'));
  ok('hero show rate filled', c.els.hShow.textContent === '44.1%', c.els.hShow.textContent);
  ok('status is not "failed"', c.els.status.textContent !== 'failed', c.els.err.textContent);

  /* Report 04's sections, on the tabs report 04 puts them on: the funnel tab is
     just the step chain, and the leaks plus the whole unresolved queue live on
     the ratios tab. */
  ok('where the chain leaks drawn on RATIOS', /Where the chain leaks/.test(c.els.ratios.innerHTML));
  ok('unresolved appointments drawn on RATIOS', /no recorded outcome/.test(c.els.ratios.innerHTML));
  ok('unresolved by service drawn on RATIOS', /Unresolved by service/.test(c.els.ratios.innerHTML));
  ok('unresolved by branch drawn on RATIOS', /Unresolved by branch/.test(c.els.ratios.innerHTML));
  /* Matched on the section HEADINGS, not on the phrase: the chain's own closing
     note legitimately mentions appointments with no recorded outcome, and an
     assertion that trips on the prose it is not testing is a false alarm. */
  ok('the funnel tab is the step chain only',
    !/<h3 class="subtitle">Where the chain leaks/.test(c.els.funnel.innerHTML)
    && !/<h3 class="subtitle">Appointments with no recorded outcome/.test(c.els.funnel.innerHTML));

  /* The eight ratio cards, in report 04's shape. */
  const rat = c.els.ratios.innerHTML;
  /* Scoped to the FIRST grid: the ratios panel also carries the unresolved
     queue's own four cards further down, so counting every .kpi on the panel
     counts twelve and says nothing about the eight ratios. */
  const firstGrid = (() => {
    const i = rat.indexOf('<div class="kpi-grid">');
    return i < 0 ? '' : rat.slice(i, rat.indexOf('</div>\n    <div class="tg-note">', i) + 1 || i + 6000);
  })();
  ok(`  eight ratio cards (${(firstGrid.match(/class="kpi[ "]/g) || []).length})`,
    (firstGrid.match(/class="kpi[ "]/g) || []).length === 8);
  ok('  all eight of report 04\'s labels present', [
    'Conversations per booking', 'Show rate', 'Invoices per visit',
    'Revenue per conversation', 'Revenue per visit', 'Cash vs revenue',
    'Avg ticket', 'Commission cost',
  ].every((l) => rat.includes(l)));
  /* The two PBX ratios must be visible holes, not silently dropped and not
     silently filled with a number that has no source. */
  ok('  the two PBX ratios render as holes',
    (rat.match(/class="kpi absent"/g) || []).length === 2);
  ok('  and say the PBX is why', /PBX/.test(rat));
  ok('  the accent is on a ratio that HAS a source', (() => {
    const i = rat.indexOf('class="kpi accent"');
    if (i < 0) return false;
    const card = rat.slice(i, i + 500);
    return !/no source/.test(card);
  })(), 'the accent card is empty');
  ok('  the six answerable ratios all have a value',
    (rat.match(/class="kpi-value">(?!no source|—)/g) || []).length >= 6);
  ok('  cash vs revenue is computed', /Collected ex-VAT ÷ revenue ex-package/.test(rat));
  ok('  commission cost comes from the tracker', /[Pp]rojected pools ÷/.test(rat));
  ok('repeated versus new with sales drawn', /Repeated versus new/.test(c.els.bybranch.innerHTML));
  ok('repeat share of SALES is shown, not only of patients',
    /Repeat share of sales/.test(c.els.bybranch.innerHTML));
  ok('ticket gap shown', /Ticket · new/.test(c.els.bybranch.innerHTML));

  /* The call list. It deliberately carries names and dialable mobiles now — a
     queue nobody can ring is a report, not a work item — so the assertions guard
     the things that make that defensible rather than pretending it is masked. */
  const rr = c.els.ratios.innerHTML;
  ok('the call list has report 04\'s eight columns', [
    '<th>Patient</th>', '<th>Mobile</th>', '<th>Service</th>',
    'Appointment date', '<th>Branch</th>', '<th>Doctor</th>',
    'Booked by', '>Created<',
  ].every((t) => rr.includes(t)));
  ok('mobiles are dialable local numbers', /class="mob">0[0-9]{10}</.test(rr));
  ok('a missing mobile shows a dash, not a blank cell', /class="mob none">—</.test(rr));
  ok('a missing service says "not recorded"', /class="nosvc">not recorded</.test(rr));
  ok('the branch chip row is present and alphabetical', (() => {
    const chips = [...rr.matchAll(/data-pd="([^"]*)"/g)].map((m) => m[1]);
    if (chips.length < 3 || chips[0] !== 'all') return false;
    const rest = chips.slice(1);
    return rest.every((x, i) => i === 0 || rest[i - 1].localeCompare(x) <= 0);
  })());
  ok('the CSV link carries the range', /unresolved\.csv\?from=2026-08-01&(amp;)?to=2026-08-19/.test(rr));
  /* The row cap, and the note that admits it. */
  ok('the table is capped, not the whole queue',
    (rr.match(/class="mob/g) || []).length <= 200, 'more than 200 rows rendered');
  ok('the note says how many rows the card holds vs the CSV',
    /card holds the first [\d,]+ rows[\s\S]{0,60}CSV holds all\s+[\d,]+/.test(rr));
  /* The list scrolls inside its own card rather than running down the page, and
     the header stays put while it does — a 200-row table with a header that
     scrolls away is a table you cannot read halfway down. */
  ok('the call list scrolls inside the card', /class="tw scrolly"/.test(rr));
  ok('and only that table does — the rollups are not caged',
    (rr.match(/class="tw scrolly"/g) || []).length === 1);
  /* The warning has to travel with the data. */
  ok('the sensitivity banner is rendered beside the list', /class="pii"/.test(rr));
  ok('the banner names what is in it',
    /patient names and mobile numbers/.test(rr));
  /* And the two rollups. */
  ok('unresolved by branch is ordered by size, not alphabetically', (() => {
    const i = rr.indexOf('<h4>Unresolved by branch</h4>');
    const seg = rr.slice(i, i + 3000);
    const vals = [...seg.matchAll(/class="vv">([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    return vals.length > 1 && vals.every((v, k) => k === 0 || vals[k - 1] >= v);
  })());
  ok('unresolved by service flags the no-service rows',
    /no service recorded/.test(rr));

  /* The cutover clamp, drawn. */
  console.log('\ncommercial.js on a year-to-date range (the cutover clamp)');
  const ytd = await Appointments.buildFunnel({ from: '2026-01-01', to: '2026-08-19' });
  const c2 = runPage('commercial.js', { ...cPayload, funnel: ytd, from: '2026-01-01' }, cIds);
  await new Promise((r) => setTimeout(r, 60));
  ok('the clamp is stated on the page', /Measured from 2026-08-01/.test(c2.els.funnel.innerHTML));
  /* Computed, not hard-coded: the count grows every time an earlier month is
     backfilled, and a frozen expectation here would fail for the right reason
     and look like the wrong one. */
  ok(`the excluded count is shown (${ytd.preCutover.toLocaleString('en-US')})`,
    c2.els.funnel.innerHTML.includes(ytd.preCutover.toLocaleString('en-US')));
  ok('it does NOT print the misleading pooled rate',
    !/8[0-9]\.\d%/.test(c2.els.funnel.innerHTML.slice(0, 4000)));

  /* A range with no measurable bookings at all. */
  console.log('\ncommercial.js on a pre-cutover range (nothing measurable)');
  const pre = await Appointments.buildFunnel({ from: '2026-02-01', to: '2026-03-31' });
  const c3 = runPage('commercial.js', { ...cPayload, funnel: pre }, cIds);
  await new Promise((r) => setTimeout(r, 60));
  ok('says there is no funnel rather than drawing zeros',
    /No measurable bookings/.test(c3.els.funnel.innerHTML));
  ok('ratios refuses too', /Nothing to divide/.test(c3.els.ratios.innerHTML));
  ok('branch table refuses too', /Nothing to compare/.test(c3.els.bybranch.innerHTML));
  for (const p of ['funnel', 'ratios', 'bybranch']) {
    ok(`${p} still balances when refusing`, !balanced(c3.els[p].innerHTML), balanced(c3.els[p].innerHTML));
  }

  /* Missing journal → blank, not zero. */
  console.log('\ncommercial.js when the journal is incomplete');
  const c4 = runPage('commercial.js', {
    ...cPayload, revenue: { ...revenue, known: false, coverage: 0.62 },
  }, cIds);
  await new Promise((r) => setTimeout(r, 60));
  /* Step 4 refuses rather than printing a wrong ex-package figure, and the two
     ratios that divide by it go blank instead of zero. */
  ok('step 4 says packages cannot be excluded',
    /packages cannot be excluded/.test(c4.els.funnel.innerHTML));
  ok('prints the coverage as a percentage', /62\.0%/.test(c4.els.funnel.innerHTML));
  ok('the revenue step shows a dash, not a number',
    /class="v">—<\/div>/.test(c4.els.funnel.innerHTML));
  ok('no stray object rendered', !/\[object/.test(c4.els.funnel.innerHTML));
  ok('the ratios that divide by revenue go blank, not zero', (() => {
    const r = c4.els.ratios.innerHTML;
    return /Revenue per visit[\s\S]{0,300}class="kpi-value">—/.test(r);
  })());

  /* ------------------------------------------------------ patients ---- */
  console.log('\npatients.js against the real August payload');
  const [tiers, mix, retention, serviceMix, homeBranch, pFunnel, acquisition, churn] = await Promise.all([
    Patients.buildTiers({ asOf: W.to, basis: 'report01' }),
    Patients.buildMix(W),
    Patients.buildRetention({ asOf: W.to }),
    Patients.buildServiceMix({ ...W, basis: 'report01' }),
    Patients.buildHomeBranch({ asOf: W.to, basis: 'report01' }),
    Patients.buildPatientFunnel(W),
    Patients.buildAcquisition(W),
    Patients.buildChurnDetail({ asOf: W.to, months: 6 }),
  ]);
  const pPayload = {
    ...W,
    basis: tiers.basis, alternatives: tiers.alternatives, coverage: tiers.coverage,
    basisCovered: tiers.basisCovered, tiers: tiers.tiers,
    patients: tiers.patients.length, total: tiers.total,
    top: tiers.patients.slice(0, 50).map((p) => ({
      name: p.name, exVat: p.exVat, invoices: p.invoices, tier: p.tier,
      firstInvoice: p.firstInvoice, lastInvoice: p.lastInvoice,
    })),
    mix, retention, serviceMix, homeBranch, funnel: pFunnel, acquisition, churn,
  };
  const pIds = ['tiers', 'retention', 'mix', 'acq', 'churn', 'hPeriod', 'hPat', 'hNew', 'hRep', 'hTk',
    'hSub', 'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load'];
  const p1 = runPage('patients.js', pPayload, pIds);
  await new Promise((r) => setTimeout(r, 60));

  for (const p of ['tiers', 'retention', 'mix', 'acq', 'churn']) {
    const html = p1.els[p].innerHTML;
    ok(`panel ${p} rendered (${html.length} chars)`, html.length > 400, `only ${html.length}`);
    ok(`panel ${p} tags balance`, !balanced(html), balanced(html));
    ok(`panel ${p} has no literal undefined/NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,40}(undefined|NaN).{0,40}/) || [])[0]);
  }
  ok('status is not "failed"', p1.els.status.textContent !== 'failed', p1.els.err.textContent);
  ok('no mobile number anywhere in the patients page',
    !/\b1[0125]\d{8}\b/.test(p1.els.tiers.innerHTML + p1.els.mix.innerHTML),
    'a ten-digit mobile-shaped number reached the page');
  ok('the tier basis is named on the page', /2026 year to date/.test(p1.els.tiers.innerHTML));
  ok('service mix columns match the tier names',
    ['VIP', 'Premium', 'Silver', 'Bronze'].every((n) => p1.els.mix.innerHTML.includes(n)));
  ok('churn marks the beyond-cache buckets', /beyond cache/.test(p1.els.churn.innerHTML));

  /* The five sections report 01 has that local was missing. */
  ok('home branch table drawn', /Patient category per branch/.test(p1.els.tiers.innerHTML));
  ok('patient funnel drawn', /Patient funnel/.test(p1.els.retention.innerHTML));
  ok('funnel per branch drawn', /Funnel per branch/.test(p1.els.retention.innerHTML));
  ok('acquisition per service drawn', /first-time patients/.test(p1.els.acq.innerHTML));
  ok('churned patients drawn', /Churned patients/.test(p1.els.churn.innerHTML));
  ok('churned by last service drawn', /Churned by last service/.test(p1.els.churn.innerHTML));
  ok('churned by branch drawn', /Churned by branch/.test(p1.els.churn.innerHTML));

  /* The figures report 01 states, reproduced. Ranges, because invoices keep
     arriving — a hard equality here would fail for the right reason every sync. */
  ok(`patient funnel reproduces report 01 (new ${pFunnel.firstTime} vs 1,254)`,
    Math.abs(pFunnel.firstTime - 1254) <= 30, `${pFunnel.firstTime}`);
  ok(`repeated reproduces report 01 (${pFunnel.repeated} vs 1,636)`,
    Math.abs(pFunnel.repeated - 1636) <= 30, `${pFunnel.repeated}`);
  ok(`not-returned share reproduces report 01 (${(pFunnel.onceShareOfNew * 100).toFixed(1)}% vs 85.0%)`,
    Math.abs(pFunnel.onceShareOfNew - 0.85) <= 0.02, `${pFunnel.onceShareOfNew}`);
  ok(`churn reproduces report 01 (${churn.churned} vs 2,415)`,
    Math.abs(churn.churned - 2415) <= 40, `${churn.churned}`);
  ok('the funnel buckets sum to the patients billed',
    pFunnel.firstTime + pFunnel.repeated === pFunnel.total,
    `${pFunnel.firstTime}+${pFunnel.repeated} vs ${pFunnel.total}`);
  ok('once is a subset of new, never added to it',
    pFunnel.once <= pFunnel.firstTime, `${pFunnel.once} > ${pFunnel.firstTime}`);
  ok('acquisition counts DISTINCT first-timers, not category appearances',
    Math.abs(acquisition.patients - pFunnel.firstTime) <= 2,
    `${acquisition.patients} vs ${pFunnel.firstTime}`);

  /* The unprovable-new case, which is the one that lies if unguarded. */
  console.log('\npatients.js when "new" cannot be proven');
  /* Both provability flags have to be stubbed: buildMix answers "absent from the
     whole cache" and buildPatientFunnel answers "absent from this year". The hero
     "New" reads the funnel, because that is report 01's definition. */
  const p2 = runPage('patients.js', {
    ...pPayload,
    mix: { ...mix, provable: false, new: 0, unknown: mix.new + mix.unknown, coverage: { ...mix.coverage, from: '2026-08-01' } },
    funnel: { ...pFunnel, provable: false, coverage: { ...pFunnel.coverage, from: '2026-08-01' } },
  }, pIds);
  await new Promise((r) => setTimeout(r, 60));
  ok('refuses to call anyone new', /Nobody can be called new/.test(p2.els.retention.innerHTML));
  ok('the funnel says "new" is not provable either',
    /not provable/.test(p2.els.retention.innerHTML));
  ok('hero new shows a dash, not 0', p2.els.hNew.textContent === '—', p2.els.hNew.textContent);
  ok('rangeline says new is not provable', /new not provable/.test(p2.els.rangeline.innerHTML));

  /* The other tier basis. */
  console.log('\npatients.js on the rolling-twelve-month basis');
  const t6 = await Patients.buildTiers({ asOf: W.to, basis: 'report06' });
  const s6 = await Patients.buildServiceMix({ ...W, basis: 'report06' });
  const p3 = runPage('patients.js', {
    ...pPayload, basis: t6.basis, alternatives: t6.alternatives, tiers: t6.tiers,
    basisCovered: t6.basisCovered, total: t6.total, patients: t6.patients.length,
    top: t6.patients.slice(0, 50).map((x) => ({ name: x.name, exVat: x.exVat, invoices: x.invoices, tier: x.tier, firstInvoice: x.firstInvoice, lastInvoice: x.lastInvoice })),
    serviceMix: s6,
  }, pIds);
  await new Promise((r) => setTimeout(r, 60));
  ok('names the rolling window', /rolling twelve months/.test(p3.els.tiers.innerHTML));
  ok('warns the cache is too short for it', !t6.basisCovered
    ? /cache only starts/.test(p3.els.tiers.innerHTML) : true,
  `basisCovered=${t6.basisCovered}`);
  ok('the fifth tier appears', /Occasional/.test(p3.els.tiers.innerHTML));
  for (const p of ['tiers', 'mix']) {
    ok(`${p} balances on the alternate basis`, !balanced(p3.els[p].innerHTML), balanced(p3.els[p].innerHTML));
  }


  /* ------------------------------------------------------- targets ---- */
  const Tracker = require(`${path}/src/lib/target-tracker.js`);
  /* The page's scripts in the order `src/views/targets.html` loads them, minus
     the shared shell. Listing them here rather than reading the view keeps the
     test honest about what it is exercising — and the sweep further down
     already asserts that every view's script tags exist on disk. */
  /* TWO PAGES NOW, one payload. `/targets` scores doctors against the approved
     sheet in invoiced revenue; `/commission` scores branches against the policy
     in collected cash. They were one report and the page had to apologise for
     it on screen. Both are driven from the SAME `/api/targets-tracker` answer,
     so a range can never mean two different things across them — and running
     both here, in one loop, is what proves it.

     Each list is the view's script tags in order, minus the shared shell. The
     sweep further down already asserts those files exist on disk. */
  const planForTargets = await get2('/api/targets-plan');
  const TARGETS_FILES = ['tg-fmt.js', 'chartlet.js', 'tg-wh.js', 'tg-ac.js', 'tg-ov.js',
    'tg-tb.js', 'tg-ts.js', 'tg-dr.js', 'targets.js'];
  const COMMISSION_FILES = ['tg-fmt.js', 'payslip.js', 'cm-v32.js', 'cm-doctors.js',
    'cm-summary.js', 'cm-gates.js', 'commission.js'];
  const tIds = ['wh', 'ov', 'ac', 'tb', 'ts', 'doc', 'hPeriod', 'hTarget', 'hTargetU', 'hAch',
    'hPace', 'hPaceU', 'hDocs', 'hDocsU', 'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load'];
  const comIds = ['cm', 'cmd', 'cms', 'cmc', 'gates', 'dlg', 'dlgTitle', 'dlgBody', 'dlgActions',
    'hPeriod', 'hNet', 'hPace', 'hQual', 'hQualU', 'hPool', 'hPoolU', 'rangeline', 'err', 'dot', 'status',
    'from', 'to', 'load'];

  /* Every range shape the report now accepts, including the ones that used to be
     refused outright and the ones whose data cannot be attributed. */
  const RANGES = [
    { label: 'one partial month', from: '2026-08-01', to: '2026-08-19' },
    { label: 'one closed month', from: '2026-08-01', to: '2026-08-31' },
    { label: 'a quarter', from: '2026-07-01', to: '2026-09-03' },
    { label: 'year to date', from: '2026-01-01', to: '2026-09-03' },
    { label: 'straddling months', from: '2026-07-15', to: '2026-08-20' },
    { label: 'pre-cutover only', from: '2026-03-01', to: '2026-05-31' },
    { label: 'a single day', from: '2026-08-14', to: '2026-08-14' },
  ];

  for (const R of RANGES) {
    console.log(`\ntargets.js · ${R.label} (${R.from} → ${R.to})`);
    const range = await Tracker.buildTrackerRange({ from: R.from, to: R.to });
    const extras = await Tracker.buildExtras({ from: R.from, to: R.to });
    /* The tracker half stays hand-built, so every assertion below keeps testing
       the exact `range`/`extras` this loop constructed. The two NEW tabs read
       `targets` and `commission`, which only the route produces — so those are
       fetched FOR THIS RANGE and merged on, rather than replacing the payload
       and quietly moving every figure the older checks are written against. */
    const served = await get2(`/api/targets-tracker?from=${R.from}&to=${R.to}`);
    const payload = {
      ...(range.latest || {}),
      range,
      extras,
      versions: null,
      targets: served.targets,
      commission: served.commission,
    };
    /* The simulator is a second endpoint and needs its own answer, or it is
       handed a tracker payload and renders its error path. */
    const b0 = (payload.branches || [])[0];
    payload.__byUrl = {
      /* `/targets` fetches the tracker AND the plan in parallel. Answered with
         the tracker payload, every plan panel renders its "no plan" branch —
         which passes every structural check while testing nothing. */
      '/api/targets-plan': planForTargets,
      '/api/targets-tracker': payload,
      '/api/targets-live': await get2(`/api/targets-live?from=${R.from}&to=${R.to}`),
      '/api/targets-actuals': await get2(`/api/targets-actuals?year=${R.to.slice(0, 4)}`),
      '/api/targets-live-branch': await get2('/api/targets-live-branch'
        + `?name=${encodeURIComponent('CFC')}&from=${R.from}&to=${R.to}`),
      /* The v3.2 scoring. Answered with the tracker payload, every panel on
         /commission draws its "no policy" branch and passes every check. */
      '/api/commission-month': await get2(`/api/commission-month?from=${R.from}&to=${R.to}`),
    };
    if (b0) {
      payload.__byUrl['/api/targets-simulate'] = await get2(`/api/targets-simulate?branchId=${b0.branchId}`
        + `&year=${payload.year}&month=${payload.month}&net=${Math.round(b0.net)}&mults=`);
    }
    const t = runPage(TARGETS_FILES, payload, tIds);
    const c = runPage(COMMISSION_FILES, payload, comIds);
    await new Promise((r) => setTimeout(r, 80));

    /* `els` reads from whichever page owns the panel, so every assertion below
       keeps testing the same markup it always did — the panels moved pages, not
       shape. Proved separately: all 28 moved panel renders are byte-identical
       to the single-page version they came from. */
    const els = { ...t.els, ...c.els };

    for (const pn of ['wh', 'ov', 'ac', 'tb', 'ts', 'doc', 'cm', 'cmd', 'cms', 'cmc', 'gates']) {
      const html = els[pn].innerHTML;
      /* A REFUSAL IS A RENDER. Several of these ranges have no target sheet —
         pre-cutover months never had one — and tab 01 correctly answers with
         "No target sheet for 2026-05" in about 230 characters. Demanding 300
         would fail the page for doing the right thing, so the floor applies
         only when there is something to draw. */
      const refusing = /No target sheet for/.test(html);
      ok(`  ${pn} rendered`, refusing || html.length > 300,
        `only ${html.length}${refusing ? ' (refusal)' : ''}`);
      ok(`  ${pn} balances`, !balanced(html), balanced(html));
      ok(`  ${pn} no undefined/NaN`, !/undefined|NaN/.test(html),
        (html.match(/.{0,50}(undefined|NaN).{0,50}/) || [])[0]);
    }
    ok('  targets status not failed', t.els.status.textContent !== 'failed', t.els.err.textContent);
    ok('  commission status not failed', c.els.status.textContent !== 'failed', c.els.err.textContent);

    /* Multi-month must announce itself, and never silently average. */
    if (range.multi) {
      ok(`  says ${range.totals.monthsCovered} months scored separately`,
        els.gates.innerHTML.includes('scored separately'));
    }
    /* The unattributable case is the one that used to print eleven failing branches. */
    if (range.latest && !range.latest.branchScoringPossible) {
      ok('  refuses per-branch scoring rather than showing zeros',
        /not possible<\/strong> for this range|not possible/.test(els.gates.innerHTML));
    }
    /* The four previously-missing sections. */
    if (extras.daily.days.length) {
      ok('  daily collection drawn', /Daily collection/.test(els.gates.innerHTML));
      ok('  daily bars present', (els.gates.innerHTML.match(/class="dbar"/g) || []).length === extras.daily.days.length);
    }
    ok('  regional roll-up drawn', /Regional roll-up/.test(els.gates.innerHTML));

    /* The tracker's six-card header row, and the trap inside it. These sections
       moved from the Summary tab to Branch tracker when Summary became the v3.2
       answer — the assertions are unchanged, they just read the panel the
       content now lives in. */
    const pace = els.gates.innerHTML;
    ok('  the six-card KPI row drawn', /kpi-grid six/.test(pace));
    ok(`  exactly six cards (${(pace.match(/class="kpi[ "]/g) || []).length})`,
      (pace.match(/class="kpi[ "]/g) || []).length === 6);
    ok('  net collection is the accent card', /class="kpi accent"/.test(pace));
    ok('  all six labels present',
      /Net collection/.test(pace) && /target<\/div>/.test(pace) && /Pace vs pro-rata/.test(pace)
      && /Branches &ge;/.test(pace) && /Branch pools/.test(pace) && /Payments captured/.test(pace));
    ok('  gross-less-refunds sub-line present', /gross less .* refunds/.test(pace));
    ok('  pro-rata sub-line names the day count',
      new RegExp(`pro-rata ${range.latest.daysElapsed}/${range.latest.daysInMonth}`).test(pace));

    /* The correctness point: the headline row must show PAYABLE, never projected.
       An earlier version showed the run-rate count and projected pool here, which
       reads as money already earned. */
    const L = range.latest;
    const withT = L.branches.filter((b) => b.target);
    const payableQual = withT.filter((b) => b.achievement >= L.policy.bands.floor).length;
    const payablePool = L.branches.reduce((a, b) => a + b.now.pool, 0);
    ok(`  branches card shows PAYABLE count ${payableQual}/${withT.length}, not run-rate ${L.totals.qualifyRun}`,
      pace.includes(`>${payableQual} / ${withT.length}<`),
      `expected ${payableQual} / ${withT.length}`);
    if (!L.closed) {
      ok('  mid-month says nothing is payable', /Nothing payable mid-month/.test(pace));
      ok('  mid-month says no branch can reach the floor',
        /No branch can reach/.test(pace));
      ok(`  the projected pool ${L.totals.poolRun} is NOT in the headline row`,
        L.totals.poolRun === payablePool
        || !pace.slice(pace.indexOf('kpi-grid six'), pace.indexOf('</div></div>', pace.indexOf('Payments captured')))
          .includes(fmtNum(L.totals.poolRun)),
        `projected pool leaked into the KPI row`);
    }
    ok('  service mix drawn', /Service mix/.test(els.gates.innerHTML));
    ok('  by-doctor split drawn', /By doctor/.test(els.gates.innerHTML));
    ok('  multiplier eligibility drawn', /Multiplier eligibility/.test(els.gates.innerHTML));
    ok('  data integrity drawn', /Data integrity/.test(els.gates.innerHTML));

    /* ---- the plan panels ----
       All three read `/api/targets-plan` and nothing else, so they are the same
       on every range — asserted once, on the first pass, rather than seven
       times against identical markup. */
    if (R === RANGES[0]) {
      const PL = planForTargets;

      /* ---- the v3.2 commission ----
         The arithmetic the whole policy turns on: collected paced to a full
         month picks a revenue tier, achievement against target picks a level,
         the cell is the pool, and a person gets their weight's share. Checked
         against the payload rather than against a remembered number. */
      const V = payload.__byUrl['/api/commission-month'];
      const cm = els.cm.innerHTML;
      if (V && !V.missing) {
        ok('  cm scores on the stored v3.2 policy', cm.includes(esc0(V.version)), V.version);
        /* The grid renders its revenue bounds abbreviated (0.5M), so the POOL
           figures are what to look for — and they are the stronger check: they
           are the numbers somebody is actually paid. */
        ok('    and draws the pool grid it read the figure out of',
          /The pool grid/.test(cm)
          && V.policy.tiers.filter((t) => t.pools.some((v) => v))
            .every((t) => t.pools.filter(Boolean).every((v) => cm.includes(fmtNum(v)))),
          'a pool figure from the grid is missing from the table');

        const rowsV = V.months.flatMap((m) => m.branches);
        /* Every pool must be the cell the tier and level point at — not a
           number near it. This is the assertion that catches an off-by-one in
           the column index, which would pay every branch one level too much. */
        const wrong = rowsV.filter((b) => {
          const tier = V.policy.tiers.find((t) => b.paced >= t.from && (t.to == null || b.paced <= t.to));
          if (!tier) return b.pool !== 0;
          if (b.level == null) return b.pool !== 0;
          const col = V.policy.levels.findIndex((l) => l.level === b.level);
          return Math.abs(b.pool - tier.pools[Math.min(col, tier.pools.length - 1)]) > 0.01;
        });
        ok(`    every pool is the cell its tier and level point at (${rowsV.length} rows)`,
          wrong.length === 0,
          wrong.slice(0, 2).map((b) => `${b.branch}: ${b.pool}`).join(' · '));

        /* A branch below the floor earns nothing — not the lowest column. */
        const floorPct = V.policy.levels[0].fromPct;
        const belowPaid = rowsV.filter((b) => b.achievement != null && b.achievement < floorPct && b.pool > 0);
        ok('    a branch below the floor earns exactly zero, not the lowest column',
          belowPaid.length === 0,
          belowPaid.map((b) => `${b.branch} ${b.pool}`).join(', '));

        /* The split must account for the pool, or a branch pays out more or
           less than it earned and nobody notices until payroll. */
        const offSplit = rowsV.filter((b) => b.pool > 0 && Math.abs(
          b.split.reduce((a, x) => a + x.each * Math.max(x.seats || 0, x.people.length), 0) - b.pool) > 1);
        ok('    and the per-person shares add back up to it',
          offSplit.length === 0,
          offSplit.slice(0, 2).map((b) => b.branch).join(', '));

        /* A failed gate pays zero and says which gate. */
        const gatesV = V.months.flatMap((m) => m.management);
        ok('    a failed gate pays zero and names the reason',
          gatesV.filter((g) => !g.pass).every((g) => g.earned === 0 && g.why),
          gatesV.filter((g) => !g.pass && (!g.why || g.earned)).map((g) => g.role).join(', '));

        /* Payable and forecast are never summed into one headline. */
        if (V.totals.openMonths) {
          ok('    a running month is labelled a forecast, not quoted as owed',
            /is a forecast/.test(cm) && /forecast at current pace/.test(cm));
        }

        /* Staff and call centre. */
        const cms = els.cms.innerHTML;
        ok('  cms lists people or seats for every earning branch',
          V.months.flatMap((m) => m.branches).filter((b) => b.pool > 0)
            .every((b) => cms.includes(esc0(b.branch)))
          || !rowsV.some((b) => b.pool > 0));
        const cmc = els.cmc.innerHTML;
        ok('  cmc refuses rather than printing zeros',
          /no agent against a booking/i.test(cmc) && !/\b0\.00\b/.test(cmc));
        ok('    and names the one field that would fix it',
          /Booked by/.test(cmc));
      }

      /* ---- Live ----
         The identity that matters most on this page: the cash it reports is the
         same cash the Commission report pays on. Asserted here against the
         tracker payload the other page is rendered from, and again in
         scripts/audit.js against the libs. */
      const wh = els.wh.innerHTML;
      const LV = payload.__byUrl['/api/targets-live'];
      ok('  wh collected equals the tracker net for the same range',
        Math.abs(LV.totals.collected - payload.range.totals.net) < 1,
        `live ${Math.round(LV.totals.collected)} vs tracker ${Math.round(payload.range.totals.net)}`);
      ok('    and the panel prints that figure, not a rounded cousin',
        wh.includes(fmtNum(LV.totals.collected)), fmtNum(LV.totals.collected));
      ok('    collected and billed are labelled as different bases',
        /commission base/.test(wh) && /ex-package/.test(wh));
      ok(`    one openable row per branch (${LV.branches.length})`,
        (wh.match(/data-whbranch=/g) || []).length === LV.branches.length,
        `${(wh.match(/data-whbranch=/g) || []).length} rows`);
      if (LV.flags.proRata) {
        ok('    a part-month says its plan figure is pro-rated by days',
          /pro-rated by days/.test(wh));
      }

      /* ---- Actuals ---- */
      const ac = els.ac.innerHTML;
      const AC = payload.__byUrl['/api/targets-actuals'];
      ok(`  ac draws ${AC.months.length} month(s) of ${AC.year}`,
        (ac.match(/<tr><td class="nm">/g) || []).length >= AC.months.length);
      ok('    a month with no prior year shows an em dash, never 0%',
        !AC.months.some((m) => m.prior == null) || /<span class="sm2">—<\/span>/.test(ac));
      if (AC.months.some((m) => m.priorSource === 'frozen') && !AC.months.some((m) => m.source === 'frozen')) {
        ok('    and a growth figure that crosses the frozen line says so',
          /crosses a change of source/.test(ac));
      }

      /* Plan. The chart is inline SVG because the CSP forbids loading Chart.js,
         and the companion table is what replaces its tooltip. */
      const ov = els.ov.innerHTML;
      ok('  ov draws the trend as inline SVG', /<svg class="ck-svg"/.test(ov));
      ok('    one polyline per unbroken run, never across a gap',
        (ov.match(/<polyline/g) || []).length >= 4,
        `${(ov.match(/<polyline/g) || []).length} polylines`);
      ok('    the legend is real buttons, not painted into the canvas',
        (ov.match(/data-ck="ov:/g) || []).length >= 4);
      ok('    and the numbers behind the picture are on the page',
        /The numbers behind it/.test(ov) && (ov.match(/<tr>/g) || []).length >= 12);
      ok('    the frozen years are labelled frozen, not blended with the live ones',
        /frozen/.test(ov), 'nothing says which half will never update');
      ok('    the projection is named a projection',
        !/projected/.test(ov) || /is a projection/.test(ov));

      /* Branch targets. The tier chips are the panel's reason to exist. */
      const tb = els.tb.innerHTML;
      ok(`  tb draws every branch (${PL.branches.branches.length})`,
        PL.branches.branches.every((b) => tb.includes(esc0(b.name))));
      ok('    with a chip per policy level',
        PL.policy.levels.every((l) => tb.includes(`data-tbtier="${l.level}"`)),
        PL.policy.levels.map((l) => l.level).join(','));
      ok('    the stacked chart caps its series and names the remainder',
        /Other \(\d+ branch/.test(tb) || PL.branches.branches.length <= 6);
      ok('    and the exact figures sit under it',
        (tb.match(/<table class="ltab/g) || []).length >= 1);

      /* Service targets. The split must reconcile to the plan it came from. */
      const ts = els.ts.innerHTML;
      ok('  ts splits the plan by department',
        PL.mix.departments.every((d) => ts.includes(esc0(d.label))),
        PL.mix.departments.map((d) => d.label).join(', '));
      ok('    and says the split is derived, not agreed',
        /Nobody agreed these figures/.test(ts));
      if (PL.mix.unmapped.length) {
        ok(`    the ${PL.mix.unmapped.length} department(s) the mapping never returns are named`,
          /never receives any revenue/.test(ts));
      }

      /* Doctors: the approved sheet AND the plan, as two sections. */
      const doc = els.doc.innerHTML;
      ok('  doc carries the plan beside the approved sheet',
        /The plan <span class="vat-tag">/.test(doc));
      ok('    with a chip per doctor group',
        PL.doctors.groups.every((g) => doc.includes(`data-drplangroup="${esc0(g)}"`)),
        PL.doctors.groups.join(', '));
    }

    /* ---- the five-minute loop, and its two guards ----
       A background reload is the kind of thing that works in testing and then
       hammers the server from eleven tabs nobody is looking at. Both guards are
       fired here rather than trusted. */
    if (R === RANGES[0]) {
      const tm = t.timers.find((x) => x.ms >= 60000);
      ok('  the live loop is registered, at five minutes',
        !!tm && tm.ms === 300000, tm ? `${tm.ms}ms` : 'no interval registered');
      if (tm) {
        let reloads = 0;
        const realFetch = t.sandbox.fetch;
        t.sandbox.fetch = async (...a) => { reloads += 1; return realFetch(...a); };

        t.sandbox.document.hidden = true;
        tm.fn();
        ok('    it does nothing while the tab is hidden', reloads === 0, `${reloads} fetches`);

        t.sandbox.document.hidden = false;
        t.sandbox.document.querySelectorAll = (q) => (q === '.panel.active' ? [{ id: 'ov' }] : []);
        t.sandbox.document.querySelector = (q) => (q === '.panel.active' ? { id: 'ov' } : null);
        tm.fn();
        ok('    nor while the reader is on another panel', reloads === 0, `${reloads} fetches`);

        t.sandbox.document.querySelector = (q) => (q === '.panel.active' ? { id: 'wh' } : null);
        tm.fn();
        await new Promise((r2) => setTimeout(r2, 40));
        ok('    but it does reload when Live is open and the tab is visible',
          reloads > 0, 'the loop fired nothing');
        t.sandbox.fetch = realFetch;
      }
    }

    /* ---- the payslip, tested for the first time ----
       It used to be three functions inside targets.js reached only through a
       document-level click handler, and `fakeNode` has no `closest` — so the
       document a doctor is actually paid against was the one thing on this page
       nothing could check. As `public/payslip.js` it is a plain function, and
       the two paths that matter are the two it has: a person with a payroll
       month, and a person without. */
    {
      const C = payload.commission;
      const rows = (C && C.rows) || [];
      const paid = rows.find((r) => r.payslip);
      const unpaid = rows.find((r) => r.commission != null && !r.payslip);
      if (paid) {
        const h = Payslip.html(paid, C.period);
        ok(`  payslip draws for ${paid.name}`, h.length > 600, `${h.length} chars`);
        ok('    its tags balance', !balanced(h), balanced(h));
        ok('    no undefined or NaN on a pay document',
          !/undefined|NaN/.test(h), (h.match(/.{0,40}(undefined|NaN).{0,40}/) || [])[0]);
        ok('    the net it shows is the net that was computed',
          h.includes(fmtNum(paid.payslip.net)), fmtNum(paid.payslip.net));
        /* The build-up must reconcile on the face of it, or the document is
           internally inconsistent in front of the person being paid. */
        const p = paid.payslip;
        ok('    gross = taxable salary + management fee + adjustment',
          Math.abs(p.total - (p.tsal + p.mgmt + p.adjustment)) < 0.02,
          `${p.total} vs ${p.tsal + p.mgmt + p.adjustment}`);
      }
      if (unpaid) {
        const h = Payslip.html(unpaid, C.period);
        ok(`  payslip REFUSES the build-up for ${unpaid.name}, who has no payroll month`,
          /cannot be shown/.test(h) && !/Net payable/.test(h));
        ok('    but still states the commission that IS known',
          h.includes(fmtNum(unpaid.commission)));
      }
    }
    ok('  call centre layer drawn', /Call centre layer/.test(els.gates.innerHTML));
    /* The Policy & logic tab is gone — dropped at Mina's request along with the
       three other tabs whose content was provenance rather than performance.
       The commission POLICY itself is unaffected: it is stored, editable in
       Admin, and scored by the same functions this file already checks. */

    /* Long tables scroll inside their card; short ones are left to render.
       Caging an 11-row table into a 320px window is a five-row keyhole and worse
       than not caging it, so the rule is "can greatly exceed the window", not
       "is a table". */
    const allPanels = ['wh', 'ov', 'ac', 'tb', 'ts', 'doc', 'cm', 'cmd', 'cms', 'cmc', 'gates']
      .map((pn) => els[pn].innerHTML).join('');
    /* ---- the CSP, pinned ----
       `src/server.js` sets scriptSrc 'self', styleSrc 'self' and connectSrc
       'self'. The dashboard these panels were ported from loads Chart.js and
       SheetJS from cdnjs and keeps its CSS in a <style> block — all three would
       be dropped silently, giving a page that renders and does nothing. These
       are one line each and they are the guard that survives the next port. */
    ok('  no inline <style> survived the port',
      !/<style[\s>]/i.test(allPanels),
      (allPanels.match(/.{0,60}<style[\s>].{0,60}/i) || [])[0]);
    ok('  no inline <script> either',
      !/<script[\s>]/i.test(allPanels),
      (allPanels.match(/.{0,60}<script[\s>].{0,60}/i) || [])[0]);
    ok('  and no CDN reference',
      !/cdnjs|jsdelivr|unpkg|cdn\.|chart\.js|xlsx\.full/i.test(allPanels),
      (allPanels.match(/.{0,50}(cdnjs|jsdelivr|unpkg|chart\.js|xlsx\.full).{0,50}/i) || [])[0]);

    const caged = (allPanels.match(/tw scrolly/g) || []).length;
    /* A FIXED CEILING WAS THE WRONG RULE and kept breaking as panels landed —
       it went 6, 12, 16 and would have gone on going up, which is a number
       being fitted to the code rather than a rule. The intent is: long tables
       scroll inside their card, short ones are left alone. So the floor stays,
       and the ceiling is relative — if EVERY table is caged, somebody has
       started caging five-row tables into a keyhole. */
    const allTables = (allPanels.match(/class="tw/g) || []).length;
    ok(`  long tables are caged, short ones are not (${caged} of ${allTables})`,
      caged >= 3 && caged < allTables, `${caged} of ${allTables} caged`);
    ok('  every caged table declares a min-width, so its row height is stable',
      (allPanels.match(/tw scrolly" style="--minw:\d+px/g) || []).length === caged);
    ok('  the two-line tables get a taller window so ten of THEIR rows fit',
      /--minw:\d+px;--h:400px/.test(allPanels));
    /* A caged table that keeps its total in a tfoot would scroll that total out of
       sight, and it is the one row a reader is looking for. So IF any caged table
       has a tfoot, app.css must pin it — checked against the stylesheet, not
       against a string, which is what an earlier version of this assertion did
       and therefore always failed. */
    ok('  a caged total row is pinned to the bottom', (() => {
      const cagedHasFoot = /<div class="tw scrolly"[^>]*>[\s\S]{0,20000}?<tfoot/.test(allPanels);
      if (!cagedHasFoot) return true;
      const css = fs.readFileSync(`${path}/public/app.css`, 'utf8');
      return /\.tw\.scrolly tfoot th,\.tw\.scrolly tfoot td\{position:sticky;bottom:0/.test(css);
    })(), 'a caged table has a tfoot but app.css does not pin it');
    /* Body Contouring must never render as an earned multiplier. */
    ok('  untestable multiplier shows n/a, never pass',
      !/Body Contouring[\s\S]{0,200}>pass</.test(els.gates.innerHTML));
  }


  /* ---------------------------------------------- commercial sales ---- */
  /* Report 01 as its own report. The Sales report at `/` is a separate page and
     is not touched by any of this — that separation is the point of the tab, so
     the last assertion here pins it. */
  const Finance = require(`${path}/src/lib/finance.js`);
  const csIds = ['ov', 'br', 'mix', 'pat', 'hPeriod', 'hRev', 'hInv', 'hTk', 'hPat',
    'hSub', 'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load'];

  for (const R of [
    { label: 'one partial month', from: '2026-08-01', to: '2026-08-19' },
    { label: 'a quarter', from: '2026-07-01', to: '2026-09-03' },
    { label: 'year to date', from: '2026-01-01', to: '2026-09-03' },
    { label: 'a single day', from: '2026-08-14', to: '2026-08-14' },
  ]) {
    console.log(`\ncommercial-sales.js · ${R.label} (${R.from} → ${R.to})`);
    const [rep, exPkg, cuts, ex2, coll, fn2, ti, pf, ac, ch, hb, sm] = await Promise.all([
      Report.buildReport(R.from, R.to),
      Report.revenueExcludingJournals(R.from, R.to, Report.EXCLUDED_REVENUE_JOURNALS),
      Report.revenueCutsExcludingJournals(R.from, R.to, Report.EXCLUDED_REVENUE_JOURNALS),
      Tracker.buildExtras({ from: R.from, to: R.to }),
      Finance.resolve().then((c) => Finance.collectionsTotals(c, { from: R.from, to: R.to })).catch(() => null),
      Appointments.buildFunnel({ from: R.from, to: R.to }),
      Patients0.buildTiers({ asOf: R.to, basis: 'report01' }),
      Patients0.buildPatientFunnel({ from: R.from, to: R.to }),
      Patients0.buildAcquisition({ from: R.from, to: R.to }),
      Patients0.buildChurnDetail({ asOf: R.to, months: 6 }),
      Patients0.buildHomeBranch({ asOf: R.to, basis: 'report01' }),
      Patients0.buildServiceMix({ from: R.from, to: R.to, basis: 'report01' }),
    ]);
    const { refundList, branchDoctors, branchProducts, doctorProducts, products, ...rest } = rep;
    const csPayload = {
      from: R.from, to: R.to, report: rest, exPackage: exPkg, cuts, mix: ex2.mix,
      collections: coll && !coll.error ? coll : null,
      appointments: {
        booked: fn2.booked, attended: fn2.totals.attended, open: fn2.totals.open,
        showRate: fn2.showRate, reportable: fn2.reportable,
        measuredFrom: fn2.measuredFrom, cutover: fn2.cutover, preCutover: fn2.preCutover,
      },
      patients: {
        basis: ti.basis, alternatives: ti.alternatives, coverage: ti.coverage,
        basisCovered: ti.basisCovered, tiers: ti.tiers,
        count: ti.patients.length, total: ti.total,
        top: ti.patients.slice(0, 50).map((p) => ({
          name: p.name, exVat: p.exVat, invoices: p.invoices, tier: p.tier,
          firstInvoice: p.firstInvoice, lastInvoice: p.lastInvoice,
        })),
        funnel: pf, acquisition: ac, churn: ch, homeBranch: hb, serviceMix: sm,
      },
    };
    csLast = csPayload;
    const cs = runPage('commercial-sales.js', csPayload, csIds);
    await new Promise((r) => setTimeout(r, 80));

    for (const pn of ['ov', 'br', 'mix', 'pat']) {
      const html = cs.els[pn].innerHTML;
      ok(`  ${pn} rendered`, html.length > 400, `only ${html.length}`);
      ok(`  ${pn} balances`, !balanced(html), balanced(html));
      ok(`  ${pn} no undefined/NaN`, !/undefined|NaN/.test(html),
        (html.match(/.{0,50}(undefined|NaN).{0,50}/) || [])[0]);
    }
    ok('  status not failed', cs.els.status.textContent !== 'failed', cs.els.err.textContent);

    /* Report 01's own four tabs, all present. */
    ok('  branch ranking drawn', /Branch ranking/.test(cs.els.ov.innerHTML));
    ok('  branch performance drawn', /one row each/.test(cs.els.br.innerHTML));
    ok('  retention / new / ticket strips drawn',
      /Retention rate/.test(cs.els.br.innerHTML) && /Average ticket/.test(cs.els.br.innerHTML));
    /* Report 01's Service mix shape, and the direction of the drill. */
    const mixH = cs.els.mix.innerHTML;
    ok('  the four policy-gate cards drawn',
      /Devices &amp; laser/.test(mixH) && /Injections/.test(mixH)
      && /Body contouring/.test(mixH) && /Service &amp; other/.test(mixH));
    ok('  body contouring is the accent card', /class="kpi accent"/.test(mixH));
    ok('  the gate verdicts are computed, not just shares',
      /floor <strong>/.test(mixH) && /cap <strong>/.test(mixH)
      && /(short|met)</.test(mixH) && /(over|inside)</.test(mixH));
    ok('  top categories is a CLICKABLE bar list',
      /class="blist" id="catBars"/.test(mixH)
      && (mixH.match(/<button[^>]*data-cat=/g) || []).length > 1);
    ok('  the click affordance is stated',
      /click a category for its branch and doctor split/.test(mixH));
    ok('  category slicer drawn', /Category slicer/.test(mixH));
    ok('  by branch and by doctor are two side-by-side panels',
      /class="twocol"/.test(mixH)
      && /<h4>By branch<\/h4>/.test(mixH) && /<h4>By doctor<\/h4>/.test(mixH));
    /* The direction: the slicer must show ONE category split across branches,
       not one branch split across categories. An earlier version had it inverted,
       which answers a different question and loses the point of the tab. */
    const topCat = ex2.mix.categories[0];
    ok(`  the slicer drills a CATEGORY (${topCat.category}), not a branch`,
      mixH.includes(`<span class="tag">${topCat.category.replace(/&/g, '&amp;')}</span>`),
      'the selected category is not named on the slicer heading');
    ok('  the branch panel lists branches, not categories', (() => {
      const seg = mixH.slice(mixH.indexOf('<h4>By branch</h4>'), mixH.indexOf('<h4>By doctor</h4>'));
      const names = ex2.mix.branches.map((b) => b.branch);
      return names.some((n) => seg.includes(n)) && !seg.includes(topCat.category);
    })());
    ok('  all-categories table has report 01\'s columns',
      /Bucket/.test(mixH) && /Lines/.test(mixH) && /Per line/.test(mixH));
    ok('  every category is in the table, not just the top 12',
      (mixH.match(/<td class="nm">/g) || []).length >= ex2.mix.categories.length);
    /* The patient list scrolls inside its card, the same as the call list. Its
     min-width is narrower because it has one fewer column, and forcing the call
     list's 1020px on it would add a sideways scroll that buys nothing. */
    ok('  the patient list scrolls inside its card',
      /class="tw scrolly" style="--minw:820px"/.test(cs.els.pat.innerHTML));
    ok('  only the long table is caged, not the short rollups',
      (cs.els.pat.innerHTML.match(/tw scrolly/g) || []).length === 1);
    ok('  it uses the same row metrics as the call list, so "ten rows" means the same',
      /tw scrolly[^>]*><table class="ltab tight"/.test(cs.els.pat.innerHTML));

  ok('  patient tiers, funnel, acquisition, churn all on tab 04',
      /Patient category/.test(cs.els.pat.innerHTML) && /Patient funnel/.test(cs.els.pat.innerHTML)
      && /Acquisition per service/.test(cs.els.pat.innerHTML) && /Churned patients/.test(cs.els.pat.innerHTML));

    /* Revenue is ex-package everywhere, and the branch cuts must reconcile to
       the headline — if they drift, the ranking is ranking a different number
       from the one in the hero. */
    const sumB = cuts.branches.reduce((a, b) => a + b.ex, 0);
    ok(`  branch cuts reconcile to the ex-package headline (${Math.round(sumB).toLocaleString('en-US')})`,
      Math.abs(sumB - exPkg.ex) < 1, `${sumB} vs ${exPkg.ex}`);
    ok('  doctor cuts reconcile too',
      Math.abs(cuts.doctors.reduce((a, d) => a + d.ex, 0) - exPkg.ex) < 1);

    /* PII: report 01 shipped 2,890 names and mobiles. This must not. */
    const all = cs.els.ov.innerHTML + cs.els.br.innerHTML + cs.els.mix.innerHTML + cs.els.pat.innerHTML;
    ok('  no mobile number anywhere on the report', !/\b1[0125]\d{8}\b/.test(all));
    ok('  the patient list is capped, not the full extract',
      (cs.els.pat.innerHTML.match(/<td class="nm">/g) || []).length < 300);
  }

  /* The separation Mina asked for: nothing in this work writes to the Sales page. */
  const salesJs = fs.readFileSync(`${path}/public/app.js`, 'utf8');
  ok('the Sales report does not read any Commercial Sales endpoint',
    !/commercial-sales/.test(salesJs));
  ok('Commercial Sales does not read the Sales report endpoint',
    !/\/api\/report/.test(fs.readFileSync(`${path}/public/commercial-sales.js`, 'utf8')));


  /* ------------------------------------------- the entity scope filter ---- */
  /* This is the assertion that was missing. The All / Nouvel Age / ZAT switch
     tested branch names against /zat/i, and NO Odoo branch is named for ZAT —
     its two are "Madinity" and "El Rehab". So ZAT emptied every table and Nouvel
     Age was byte-identical to All: a control that looked wired up and filtered
     nothing. Rendering alone could never catch that; only comparing the three
     scopes to each other can. */
  console.log('\nthe All / Nouvel Age / ZAT filter actually filters');

  const ents = await Tracker.branchEntities();
  ok('the mapping knows both entities', ents.entities.length === 2, ents.entities.join(','));
  ok('ZAT is Madinity and El Rehab, not a name containing "zat"', (() => {
    const k = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
    return ents.map[k('Madinity')] === 'ZAT' && ents.map[k('El Rehab')] === 'ZAT'
      && !Object.keys(ents.map).some((n) => /zat/.test(n));
  })(), JSON.stringify(ents.counts));

  /* Drive each page through all three scopes by clicking the real handlers is
     not possible under the shim, so SCOPE is set through the module's own
     sandbox before a repaint — the same variable the buttons write. */
  const SCOPE_BTNS = { '#scope button': [{ scope: 'all' }, { scope: 'Nouvel Age' }, { scope: 'ZAT' }] };
  const scopeSweep = async (file, payload, ids, panels) => {
    const out = {};
    for (const scope of ['all', 'Nouvel Age', 'ZAT']) {
      const run = runPage(file, payload, ids, SCOPE_BTNS);
      await new Promise((r) => setTimeout(r, 80));
      /* Click the real button, through the real handler. */
      const btn = run.nodes('#scope button').find((b) => b.dataset.scope === scope);
      if (!btn) throw new Error(`no scope button for ${scope} in ${file}`);
      btn.fire('click');
      out[scope] = panels.map((pn) => run.els[pn].innerHTML).join('');
    }
    return out;
  };

  for (const [file, payload, ids, panels] of [
    ['commercial.js', { ...cPayload, entities: ents }, cIds, ['bybranch']],
    ['commercial-sales.js', { ...csLast, entities: ents }, csIds, ['ov', 'br', 'mix', 'pat']],
  ]) {
    const got = await scopeSweep(file, payload, ids, panels);
    const label = file.replace('.js', '');

    ok(`  ${label}: Nouvel Age differs from All`,
      got['Nouvel Age'] !== got.all,
      'the two scopes render identically — the filter is not filtering');
    ok(`  ${label}: ZAT differs from All`, got.ZAT !== got.all);
    ok(`  ${label}: ZAT differs from Nouvel Age`, got.ZAT !== got['Nouvel Age']);
    ok(`  ${label}: ZAT is not empty`, got.ZAT.length > 300, `${got.ZAT.length} chars`);
    /* The specific branches, named. */
    ok(`  ${label}: ZAT shows El Rehab`, /El Rehab/.test(got.ZAT));
    ok(`  ${label}: ZAT hides a Nouvel Age branch`, !/Alex Camp Chizar/.test(got.ZAT));
    ok(`  ${label}: Nouvel Age shows Alex Camp Chizar`, /Alex Camp Chizar/.test(got['Nouvel Age']));
    ok(`  ${label}: Nouvel Age hides El Rehab`, !/El Rehab/.test(got['Nouvel Age']));
    /* And the unclaimed branches are declared, not silently dropped — asserted
       against whether this payload actually HAS an unmapped branch, rather than
       assuming one. The ex-package cuts for August have none: the Unassigned
       revenue there is entirely package-journal invoices, which this report
       excludes, so the correct behaviour is no note at all. */
    const k2 = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
    const named = new Set(Object.keys(ents.map));
    const payloadBranches = [
      ...(payload.funnel ? payload.funnel.branches.map((b) => b.name) : []),
      ...(payload.cuts ? payload.cuts.branches.map((b) => b.name) : []),
    ].filter(Boolean);
    const orphans = [...new Set(payloadBranches.filter((n) => !named.has(k2(n))))];
    if (orphans.length) {
      ok(`  ${label}: a named scope declares the ${orphans.length} branch(es) it hides`,
        /hidden by this filter/.test(got.ZAT) && /hidden by this filter/.test(got['Nouvel Age']),
        `unmapped: ${orphans.join(', ')}`);
    } else {
      ok(`  ${label}: no unmapped branch in this payload, so no note`,
        !/hidden by this filter/.test(got.ZAT),
        'a note appeared with nothing to report');
    }
    ok(`  ${label}: All never talks about hiding`, !/hidden by this filter/.test(got.all));

    /* Every table in a filtered panel must respond, not just the branch one.
       This is what was actually broken: the branch table filtered while the
       creator, specialist and by-doctor tables beside it did not, because those
       rollups carried no branch. A panel where two of three tables ignore the
       control reads as a broken control. */
    for (const marker of (label === 'commercial'
      ? ['Who created the bookings', 'By specialist']
      : ['All categories', 'By doctor'])) {
      const cut = (h) => {
        const i = h.indexOf(marker);
        return i < 0 ? null : h.slice(i, i + 4000);
      };
      const a = cut(got.all), z = cut(got.ZAT);
      ok(`  ${label}: "${marker}" responds to the scope`,
        a !== null && z !== null && a !== z,
        a === null ? `marker "${marker}" not rendered` : 'identical under All and ZAT');
    }
  }

  /* ----------------------------------------------------- marketing ---- */
  console.log('\nmarketing.js — report 03, against real payloads');

  const Marketing = require(`${path}/src/lib/marketing.js`);
  const mIds = ['paid', 'doc', 'lead', 'soc', 'exi', 'bld', 'hPeriod', 'hSpend', 'hRes',
    'hCpr', 'hConv', 'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load'];
  const mSel = {
    '#presets button': [{ p: 'mtd' }, { p: 'lastmonth' }],
    '#scope button': [{ scope: 'all' }, { scope: 'Nouvel Age' }, { scope: 'ZAT' }],
  };

  const mPayload = async (W2, scope = 'all') => {
    const [paid, campaigns, ads, doctors, leads, social, provenance] = await Promise.all([
      Marketing.buildPaid({ ...W2, scope }), Marketing.buildCampaigns({ ...W2, scope }),
      Marketing.buildAds({ ...W2, scope }), Marketing.buildDoctors({ ...W2, scope }),
      Marketing.buildLeadQuality({ ...W2, scope }), Marketing.buildSocial({ ...W2, scope }),
      Marketing.buildProvenance(W2),
    ]);
    return {
      ...W2, scope, paid, campaigns, ads, doctors, leads, social, provenance,
      entities: { accounts: Marketing.ENTITY_BY_ACCOUNT, profiles: Marketing.ENTITY_BY_PROFILE },
    };
  };

  const mAug = await mPayload(W);
  const m = runPage('marketing.js', mAug, mIds, mSel);
  await new Promise((r) => setTimeout(r, 60));

  const PANELS = { paid: '01 Paid delivery', doc: '02 Doctors & services', lead: '03 Lead quality',
    soc: '04 Social', exi: '05 What exists' };
  for (const [id, label] of Object.entries(PANELS)) {
    const html = m.els[id].innerHTML;
    ok(`${label} renders`, html.length > 400, `${html.length} chars`);
    ok(`  ${label} tags balance`, balanced(html) === null, balanced(html));
    /* An `undefined` in a template string renders as the literal word and looks
       like a label. A NaN looks like a number that failed. */
    ok(`  ${label} has no undefined or NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  }

  /* The figures the source pack pins, on the page rather than in the payload. */
  ok('the hero shows the pack\'s spend and results',
    m.els.hSpend.textContent === fmtNum(466114.05) && m.els.hRes.textContent === '4,565',
    `${m.els.hSpend.textContent} / ${m.els.hRes.textContent}`);

  /* The four refusals this report is built around. Each of these is a sentence
     that must survive on the page, because each is a number a reader would
     otherwise compute wrongly in their head. */
  ok('reach is explicitly never totalled', /not added up anywhere/.test(m.els.paid.innerHTML));
  ok('every mix states the share of spend it describes',
    /This describes .*% of the spend/.test(m.els.doc.innerHTML));
  ok('an inherited label is marked as inherited',
    /inherited<\/span>/.test(m.els.doc.innerHTML));
  ok('the doctor ratio refuses the name ROAS',
    /not ROAS/.test(m.els.doc.innerHTML) && !/\bROAS\b(?!.{0,40}not)/.test(m.els.doc.innerHTML.replace(/not ROAS/g, '')));
  ok('the follower count is called a snapshot',
    /snapshot, not a series/.test(m.els.soc.innerHTML));
  ok('the refused doctor profiles are named with their remedy',
    /not readable/.test(m.els.soc.innerHTML) && /datasource-IGI/.test(m.els.soc.innerHTML));
  /* The Build sheet tab is gone, dropped with the three other provenance tabs.
     What it listed — who owns which missing feed — is a project note, not a
     figure, and it does not belong on a report that refreshes. */

  /* The scope control. It RELOADS here rather than repainting, so the proof is
     that clicking it re-requests with the scope in the query string — the
     failure mode that shipped twice on the other reports was a control that
     looked wired and filtered nothing. */
  const asked = [];
  m.sandbox.fetch = async (url) => {
    asked.push(url);
    return { ok: true, status: 200, json: async () => mAug };
  };
  m.nodes('#scope button')[2].fire('click');
  await new Promise((r) => setTimeout(r, 60));
  ok('clicking ZAT re-requests the API with scope=ZAT',
    asked.some((u) => /scope=ZAT/.test(u)), asked.join(' | ') || 'no request made');

  /* A scope really does change the numbers — the SQL filter, not just the URL. */
  const mZat = await mPayload(W, 'ZAT');
  ok('the ZAT scope returns less spend than All',
    mZat.paid.spend > 0 && mZat.paid.spend < mAug.paid.spend,
    `ZAT ${mZat.paid.spend} vs all ${mAug.paid.spend}`);

  /* A range whose lead half predates Meta's 90-day retention. The page must say
     so rather than quoting a conversion rate over a denominator that is missing
     most of itself. */
  const mOld = await mPayload({ from: '2026-01-01', to: '2026-03-31' });
  const mo = runPage('marketing.js', mOld, mIds, mSel);
  await new Promise((r) => setTimeout(r, 60));
  ok('a range older than lead retention says so instead of drawing a rate',
    /never will/.test(mo.els.lead.innerHTML), 'no warning on a pre-retention range');
  ok('  and its panels still render and balance',
    Object.keys(PANELS).every((id) => mo.els[id].innerHTML.length > 300
      && balanced(mo.els[id].innerHTML) === null));
  ok('  with no undefined leaking through the empty case',
    Object.keys(PANELS).every((id) => !/undefined|NaN/.test(mo.els[id].innerHTML)));

  /* ------------------------------------------------ contact centre ---- */
  console.log('\ncontact-centre.js — report 02, eight panels and three windows');

  const CC = require(`${path}/src/lib/contact-centre.js`);
  /* IN <script> ORDER, the way contact-centre.html loads them. Passing the list
     rather than injecting requires makes this an assertion that the view's tags
     are ordered correctly: a panel module listed after the controller would
     throw here exactly as it would in the browser. Omit one and its panel draws
     the controller's "could not be drawn" branch, which passes every structural
     check below while testing nothing — that has happened three times on this
     project. */
  const ccFiles = ['cc-fmt.js', 'cc-appointments.js', 'cc-summary.js', 'cc-crm.js',
    'cc-calls.js', 'cc-agents.js', 'cc-timing.js', 'cc-branches.js', 'cc-quality.js',
    'cc-gate.js', 'contact-centre.js'];
  const ccmIds = ['pa', 'ov', 'pc', 'pu', 'ag', 'tm', 'br', 'dq',
    'hPeriod', 'hOpp', 'hBook', 'hShow', 'hCredit',
    'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load', 'ccgate'];
  const CC_PANELS = {
    pa: '00 Appointments', ov: '01 Executive summary', pc: '02 CRM', pu: '03 Calls',
    ag: '04 Agents', tm: '05 Timing', br: '06 Branches', dq: '07 Data quality',
  };

  /* TWO BUILDS, BECAUSE THE SNAPSHOTS DO NOT OVERLAP. The phones are 1–18
     August; the CRM is September into October. Neither range exercises all
     eight panels, and a single build would leave half of them asserting against
     a refusal. */
  const ccAug = await CC.build({ ...W, today: '2026-10-04' });
  const ccSep = await CC.build({ from: '2026-09-01', to: '2026-10-10', scope: 'all', today: '2026-10-04' });
  /* The expandable rows are seeded from the PAYLOAD rather than from a branch
     name typed here: this harness's nodes are stubs, so a name that matches
     nothing in the data expands nothing and the assertion fails for the wrong
     reason a month after somebody renames a branch. */
  const ccSel = {
    '#presets button': [{ p: 'mtd' }],
    '#scope button': [{ scope: 'all' }, { scope: 'Nouvel Age' }, { scope: 'ZAT' }],
    '[data-apbranch]': [{ apbranch: ccSep.appointments.branches[0].branch }],
    '[data-crmlogin]': [{ crmlogin: ccSep.crm.byLogin[0].login }],
  };
  const cc1 = runPage(ccFiles, ccAug, ccmIds, ccSel);
  const cc2 = runPage(ccFiles, ccSep, ccmIds, ccSel);
  await new Promise((r) => setTimeout(r, 60));

  for (const [id, label] of Object.entries(CC_PANELS)) {
    for (const [tag, run] of [['August', cc1], ['September', cc2]]) {
      const html = run.els[id].innerHTML;
      ok(`${label} renders on the ${tag} range`, html.length > 300, `${html.length} chars`);
      ok(`  ${label} (${tag}) tags balance`, balanced(html) === null, balanced(html));
      ok(`  ${label} (${tag}) has no undefined or NaN`, !/undefined|NaN/.test(html),
        (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
      ok(`  ${label} (${tag}) was drawn by its module, not the error branch`,
        !/could not be drawn/.test(html),
        (html.match(/.{0,120}could not be drawn.{0,160}/) || [])[0]);
    }
  }

  /* ---- the August pack, still on the page, now on the Calls panel ---- */
  ok('the Calls panel reproduces the pack: 2,919 offered and 2,456 answered',
    /2,919/.test(cc1.els.pu.innerHTML) && /2,456/.test(cc1.els.pu.innerHTML));
  ok('  the two entity sides are shown adding up to the aggregate',
    /483/.test(cc1.els.pu.innerHTML) && /add up to the total/.test(cc1.els.pu.innerHTML));
  ok('  the outbound contradiction is stated rather than resolved',
    /disagrees with itself/.test(cc1.els.pu.innerHTML)
    && /7,888/.test(cc1.els.pu.innerHTML) && /4,404/.test(cc1.els.pu.innerHTML));
  ok('  the hourly chart says it covers the whole snapshot window, not the range',
    /summed over the whole of/.test(cc1.els.pu.innerHTML));
  ok('  occupancy is labelled an assumption, with the shift length',
    /not measurements/.test(cc1.els.pu.innerHTML) && /12-hour shift/.test(cc1.els.pu.innerHTML));

  /* The extension map is why this table can name anybody, and the one conflict
     in it must be surfaced rather than silently resolved. */
  ok('the agents table names people from the extension map',
    /Fatma El Sayed Eissa/.test(cc1.els.pu.innerHTML),
    'no Odoo employee name on the Calls panel');
  ok('  an extension the phone system and the map disagree about is flagged',
    /disagrees?\b/.test(cc1.els.pu.innerHTML) && /6008/.test(cc1.els.pu.innerHTML),
    'the 6008 name conflict is not surfaced');

  /* ---- the credit gap: the number this report exists for ---- */
  const T = ccSep.summary.totals;
  ok('the credit gap is stated in words, not left to be subtracted',
    /arrived on the booking the agent made/.test(cc2.els.ov.innerHTML)
    && cc2.els.ov.innerHTML.includes(T.lostCredit.toLocaleString('en-US')),
    `payload says ${T.lostCredit} lost; the panel does not say it`);
  ok('  show rate excludes bookings that have not come due',
    T.past === T.booked - T.upcoming && T.showRate === Math.round((T.showed / T.past) * 100) / 100);

  /* ---- the three refusals, each by name ---- */
  ok('lead source blames the export, not Odoo alone',
    /does not carry the Source/.test(cc2.els.pc.innerHTML)
    && /looks like a measurement and is not/.test(cc2.els.pc.innerHTML),
    'lead source is not refused in the snapshot\'s own terms');
  ok('  activities are labelled by login, because the person is not in the export',
    /broken down by login, not by person/.test(cc2.els.pc.innerHTML));
  ok('  re-booking names a login and says so',
    /names a login, not a person/.test(cc2.els.pc.innerHTML));
  ok('  confirmation-call coverage is stated as the finding it is',
    /confirmation call recorded against them/.test(cc2.els.pa.innerHTML),
    'the 4.6% confirmation finding is missing');

  /* ---- a range neither snapshot reaches: every panel refuses ---- */
  const ccNone = await CC.build({ from: '2025-01-01', to: '2025-01-31', scope: 'all', today: '2026-10-04' });
  const cc3 = runPage(ccFiles, ccNone, ccmIds, ccSel);
  await new Promise((r) => setTimeout(r, 60));
  for (const id of ['pa', 'ov', 'pc', 'pu', 'ag', 'tm', 'br']) {
    const html = cc3.els[id].innerHTML;
    ok(`a range nothing covers: ${CC_PANELS[id]} refuses rather than showing zero`,
      /rather than zero/.test(html) || /does not touch it/.test(html)
      || /Nothing to show/.test(html),
      html.slice(0, 160));
    ok(`  ${CC_PANELS[id]} still balances`, balanced(html) === null, balanced(html));
  }
  ok('  and no panel leaks an undefined on that range',
    Object.keys(CC_PANELS).every((id) => !/undefined|NaN/.test(cc3.els[id].innerHTML)),
    Object.keys(CC_PANELS).map((id) =>
      (cc3.els[id].innerHTML.match(/.{0,40}(undefined|NaN).{0,40}/) || [])[0]).filter(Boolean)[0]);

  /* ---- an opened branch fetches nothing and simply expands ---- */
  const apRow = cc2.nodes('[data-apbranch]')[0];
  if (apRow) {
    const before = cc2.els.pa.innerHTML.length;
    apRow.fire('click');
    await new Promise((r) => setTimeout(r, 30));
    ok('opening a branch on Appointments expands it in place',
      cc2.els.pa.innerHTML.length > before,
      'the panel did not grow when a branch was opened');
  } else {
    ok('opening a branch on Appointments expands it in place', false, 'no branch row rendered');
  }

  /* The CRM login row is the one that turns a shared desk into named people —
     the whole reason this panel exists. */
  const lgRow = cc2.nodes('[data-crmlogin]')[0];
  if (lgRow) {
    lgRow.fire('click');
    await new Promise((r) => setTimeout(r, 30));
    const who = ccSep.crm.byLogin[0].people[0].name;
    ok('opening a CRM login names the people who sat at it',
      cc2.els.pc.innerHTML.includes(esc0(who).replace(/&#39;/g, "'")),
      `expected ${who} inside the opened row`);
  } else {
    ok('opening a CRM login names the people who sat at it', false, 'no login row rendered');
  }

  /* ---- THE WEEKLY LOCK ----
     The server answers 423 with no figures. The page must show the lock card,
     draw NOTHING in any panel, and tell an uploader where to go and everybody
     else that it opens by itself. */
  const lockBody = {
    locked: true,
    canUpload: false,
    gate: {
      locked: true, today: '2026-10-04', week: { from: '2026-09-27', to: '2026-10-03' },
      held: null, needsUntil: '2026-10-02', reason: 'missing', lastUpload: null, locksAgain: '2026-10-11',
    },
  };
  const lockFetch = (body) => async () => ({ ok: false, status: 423, json: async () => body });
  const ccL = runPage(ccFiles, null, ccmIds, ccSel);
  ccL.sandbox.fetch = lockFetch(lockBody);
  ccL.nodes('#scope button')[0].fire('click');
  await new Promise((r) => setTimeout(r, 60));
  const lockHtml = ccL.els.ccgate.innerHTML;
  ok('a locked week draws the lock card', /Upload last week's UCM/.test(lockHtml), lockHtml.slice(0, 120));
  ok('  naming the week it is waiting for', /27 Sep/.test(lockHtml) && /3 Oct/.test(lockHtml));
  ok('  in the source page\'s own Arabic', /الصفحة دي بتفتح/.test(lockHtml));
  ok('  a reader who cannot upload is told it opens once the admin uploads', /الأدمن يرفعه/.test(lockHtml)
    && !/Admin → Uploads/.test(lockHtml));
  ok('  and no panel draws anything behind it',
    Object.keys(CC_PANELS).every((id) => ccL.els[id].innerHTML === ''),
    Object.keys(CC_PANELS).filter((id) => ccL.els[id].innerHTML !== '').join(', '));
  ok('  tags balance', balanced(lockHtml) === null, balanced(lockHtml));

  const ccU = runPage(ccFiles, null, ccmIds, ccSel);
  ccU.sandbox.fetch = lockFetch({ ...lockBody, canUpload: true,
    gate: { ...lockBody.gate, reason: 'short', held: { calls: 812, first: '2026-09-27', last: '2026-09-30' } } });
  ccU.nodes('#scope button')[0].fire('click');
  await new Promise((r) => setTimeout(r, 60));
  const lockUpHtml = ccU.els.ccgate.innerHTML;
  ok('an uploader is sent to Admin → Uploads, with the export to take',
    /href="\/admin#uploads"/.test(lockUpHtml) && /CDR → Export/.test(lockUpHtml));
  ok('  a SHORT week says where it stops, not that nothing was uploaded',
    /its last call is/.test(lockUpHtml) && /30 Sep/.test(lockUpHtml) && /812/.test(lockUpHtml));

  /* The scope control reloads with the scope in the query string. */
  const ccAsked = [];
  cc1.sandbox.fetch = async (url) => {
    ccAsked.push(url);
    return { ok: true, status: 200, json: async () => ccAug };
  };
  cc1.nodes('#scope button')[2].fire('click');
  await new Promise((r) => setTimeout(r, 60));
  ok('clicking ZAT re-requests report 02 with scope=ZAT',
    ccAsked.some((u) => /scope=ZAT/.test(u)), ccAsked.join(' | ') || 'no request made');

  /* ------------------------------------------------------ sales (app.js) ---- */
  console.log('\napp.js — the Sales report, the one page this harness had never run');

  const salesPayload = await get2('/api/report?from=2026-08-01&to=2026-08-19');
  const salesIds = ['overview', 'branches', 'doctors', 'targets', 'products', 'stock', 'data',
    'hPeriod', 'hSub', 'hEx', 'hInc', 'hLines', 'hCov', 'rangeline', 'err', 'dot', 'status',
    'from', 'to', 'load', 'refresh', 'export', 'import', 'importFile',
    'dlg', 'dlgTitle', 'dlgBody', 'dlgActions', 'dlgPass', 'dlgPassErr', 'tgFlat', 'tgSort'];
  const sales = runPage('app.js', salesPayload, salesIds, {
    '#presets button': [{ p: 'mtd' }],
    '[data-acc], [data-search-target], [data-tg]': [],
  });
  await new Promise((r) => setTimeout(r, 120));

  const SALES_PANELS = ['overview', 'branches', 'doctors', 'targets', 'products', 'stock', 'data'];
  for (const id of SALES_PANELS) {
    const html = sales.els[id].innerHTML;
    ok(`Sales panel ${id} renders`, html.length > 200, `${html.length} chars`);
    ok(`  Sales panel ${id} tags balance`, balanced(html) === null, balanced(html));
    ok(`  Sales panel ${id} has no undefined or NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  }
  /* innerHTML, not textContent: this page writes its hero cards as markup
     (`12,345<small>EGP</small>`), and the DOM shim does not derive text from
     HTML. Reading the wrong one made this look like an empty hero. */
  /* The Products tab expands into doctors, mirroring the Doctors tab. The rows
     are the SAME rollup read backwards, so the assertion that matters is not
     that the accordion exists but that a doctor named under a product also
     appears on the Doctors tab under that product. */
  ok('every product on the Products tab is an accordion, not a flat row',
    (sales.els.products.innerHTML.match(/class="acc" data-acc/g) || []).length
      === salesPayload.report.products.length,
    `${(sales.els.products.innerHTML.match(/class="acc" data-acc/g) || []).length} accordions`
    + ` for ${salesPayload.report.products.length} products`);
  ok('  and each one lists the doctors who invoiced it',
    /Doctors who invoiced it/.test(sales.els.products.innerHTML),
    'no doctor table inside the product accordions');
  {
    /* Computed the way the page computes it, over every product. */
    const R2 = salesPayload.report;
    const by = new Map();
    for (const [doctor, prods] of Object.entries(R2.doctorProducts || {})) {
      for (const p of prods) {
        if (!by.has(p.name)) by.set(p.name, []);
        by.get(p.name).push({ doctor, ...p });
      }
    }
    const off = R2.products.filter((p) => {
      const named = (by.get(p.name) || []).reduce((s, d) => s + d.ex, 0);
      return Math.abs(p.ex - named) > 0.01;
    });
    ok('  every product total equals the sum of its doctor rows',
      off.length === 0,
      off.slice(0, 3).map((p) => p.name).join(', '));
  }
  ok('  and the top product\'s biggest doctor is named first',
    (() => {
      const R2 = salesPayload.report;
      const top = R2.products[0];
      if (!top) return true;
      const list = Object.entries(R2.doctorProducts || {})
        .flatMap(([doctor, ps]) => ps.filter((x) => x.name === top.name).map((x) => ({ doctor, ...x })))
        .sort((a, b) => b.ex - a.ex);
      if (!list.length) return true;
      const body = sales.els.products.innerHTML;
      const at = body.indexOf(top.name);
      return at >= 0 && body.indexOf(list[0].doctor, at) > at;
    })(), 'the doctor ranking under a product is not biggest-first');

  /* ------------------------------------------------ doctors (own report) ---- */
  /* It began as NRS tab 08 and was moved out to its own report. The move
     changed one thing that matters: its targets section now scores the sheet
     itself instead of reading the NRS payload, so the assertion that earns its
     keep is that the two still agree. */
  console.log('\ndoctors.js — Doctors Performance, its own report');

  const Doctors = require(`${path}/src/lib/doctors.js`);
  const docmIds = ['tg', 'tk', 'ij', 'hPeriod', 'hEx', 'hPerCust', 'hSyr', 'hDocs',
    'rangeline', 'err', 'dot', 'status', 'from', 'to', 'load'];
  const docSel = { '#presets button': [{ p: 'mtd' }] };

  for (const [label, W2] of [
    ['the month with a target sheet', { from: '2026-08-01', to: '2026-08-31' }],
    ['a month with NO target sheet', { from: '2026-09-01', to: '2026-09-08' }],
  ]) {
    const payload = await Doctors.build(W2);
    const pg = runPage('doctors.js', payload, docmIds, docSel);
    await new Promise((r) => setTimeout(r, 80));

    for (const [id, name] of [['tg', '01 Targets'], ['tk', '02 Ticket size'], ['ij', '03 Injectables']]) {
      const html = pg.els[id].innerHTML;
      ok(`${label} · ${name} renders`, html.length > 300, `${html.length} chars`);
      ok(`  ${label} · ${name} tags balance`, balanced(html) === null, balanced(html));
      ok(`  ${label} · ${name} has no undefined or NaN`, !/undefined|NaN/.test(html),
        (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
    }

    if (payload.sheet.loaded) {
      ok(`${label} · the schedule total is on the page`,
        pg.els.tg.innerHTML.includes(payload.targets.sheetTotal.toLocaleString('en-US')),
        'the sheet total is missing');
      ok(`  ${label} · every group is named`,
        payload.targets.groups.every((g) => pg.els.tg.innerHTML.includes(g.name)));
    } else {
      /* A doctor at 0% of a target that does not exist is a false accusation. */
      ok(`${label} · refuses to score against a sheet that does not exist`,
        /No target to score against/.test(pg.els.tg.innerHTML),
        'it scored a month with no sheet');
      ok(`  ${label} · and says the other two tabs are unaffected`,
        /unaffected/.test(pg.els.tg.innerHTML));
    }

    ok(`${label} · both ticket definitions appear, labelled`,
      /Per customer/.test(pg.els.tk.innerHTML) && /Per invoice/.test(pg.els.tk.innerHTML));
    ok(`  ${label} · and it says which one the pack uses`,
      /DISTINCT CUSTOMERS/.test(pg.els.tk.innerHTML));
    ok(`  ${label} · the five families are each named`,
      ['Filler', 'Skinbooster', 'Rich PL', 'V-Hacker', 'Calcium']
        .every((f) => pg.els.ij.innerHTML.includes(f)));
    ok(`  ${label} · the header-attribution caveat is on the page`,
      /invoice HEADER/.test(pg.els.ij.innerHTML));
    ok(`  ${label} · the report did not fail`, pg.els.status.textContent !== 'failed',
      pg.els.err.textContent);
  }

  /* The identity the move put at risk: this report scores the sheet itself, and
     the NRS Targets tab scores it from its own route. Same function, same
     inputs — so the same answer, or one of them is wrong. */
  {
    const own = await Doctors.scoreTargets({ from: '2026-08-01', to: '2026-08-31' });
    const nrs = (await get2('/api/report?from=2026-08-01&to=2026-08-31')).targets;
    ok('the standalone report and the NRS Targets tab score the sheet identically',
      !own.missing && !nrs.missing
      && own.sheetTotal === nrs.sheetTotal
      && Math.abs(own.mtdTotal - nrs.mtdTotal) < 0.02
      && own.groups.length === nrs.groups.length,
      `own ${own.sheetTotal}/${own.mtdTotal} vs NRS ${nrs.sheetTotal}/${nrs.mtdTotal}`);
  }

  ok('the Sales hero carries the range revenue',
    /\d/.test(sales.els.hEx.innerHTML) && /EGP/.test(sales.els.hEx.innerHTML),
    `hEx innerHTML is "${sales.els.hEx.innerHTML}"`);
  ok('  and the invoice count beside the line count is a number, not "undefined"',
    /\d/.test(sales.els.hLines.innerHTML) && !/undefined/.test(sales.els.hLines.innerHTML),
    sales.els.hLines.innerHTML);
  ok('the Sales report did not fail', sales.els.status.textContent !== 'failed',
    sales.els.err.textContent);

  /* ------------------------------------------------- admin · uploads ---- */
  console.log('\nadmin.js — the 07 Uploads panel');

  /* This panel is the one a person actually hit as a blank white area: the tab
     existed in the view, the JS was served, and the endpoint behind it was 404
     on the running process. Rendering it here means an empty panel fails a test
     rather than being discovered in a browser. */
  const RealDraft = require(`${path}/public/draft.js`);
  const upPayload = await get2('/api/uploads');
  const admPayloads = {};
  for (const u of ['/api/admin/status', '/api/admin/feeds', '/api/targets',
    '/api/targets/drafts', '/api/uploads', '/api/aliases', '/api/odoo-names',
    '/api/audit', '/api/targets/2026-08', '/api/commission', '/api/vendor-terms',
    /* Doctor schemes. Left out, `drawSchemes` draws its "could not load" branch
       and every assertion below it would pass against an error message. */
    '/api/schemes',
    /* The plan grid, for the same reason. */
    '/api/targets-plan',
    /* And the v3.2 policy the Commission tab now edits. */
    '/api/policy/v32',
    /* The phone extension map on the Uploads tab. Left out, the map draws its
       "could not be loaded" branch. */
    '/api/pbx/extensions',
    /* What the weekly lock is waiting for, drawn at the top of Uploads. */
    '/api/contact-centre/gate']) {
    admPayloads[u] = await get2(u);
  }
  admPayloads['/auth/me'] = { subject: 'render', name: 'render' };
  /* The six-tab Admin. `periodsList`, `feeds` and `links` are the sub-sections
     that used to be tabs of their own; `drop` and `file` are created by
     renderImport's own markup, so the shim has to know them or the panel throws
     halfway and renders a stub. */
  const upIds = ['status', 'periods', 'periodsList', 'editor', 'import', 'plan', 'commission', 'v32',
    'mapping', 'aliases', 'links', 'data', 'feeds', 'uploads', 'audit',
    'who', 'err', 'newSheet', 'drop', 'file',
    /* The extension map's own container inside the Uploads panel. */
    'extmap',
    /* And the weekly UCM card's, at the top of it. */
    'ucmweekly'];
  let onShow = null;
  const upDom = makeDom(upIds, {
    '.tab': [], '.panel': [],
    '[data-upload]': [], '[data-uploadfile]': [],
    /* The extension map's inputs and its save button, so the editor can be
       driven rather than merely drawn. */
    '[data-extfield]': [{ ext: '6008', extfield: 'odooEmployee' }],
    '#extSave': [{}], '#extNote': [{}],
  });
  const upSandbox = {
    /* The plan editor is its own module, loaded by admin.html before admin.js.
       Missing from this stub, `renderPlan` throws and the Periods tab shows its
       "could not load" branch — which passes every check while testing nothing. */
    AdminPlan: require(`${path}/public/admin-plan.js`),
    /* The v3.2 policy editor, its own module loaded before admin.js. Missing
       from this stub, `renderV32` throws into its catch and the Commission tab
       shows "could not load" — which passes every structural check below while
       testing nothing. */
    AdminV32: require(`${path}/public/admin-v32.js`),
    /* The phone extension map, its own module loaded by admin.html before
       admin.js. Missing from this stub, renderUploads throws into its catch and
       the Uploads tab shows "could not be loaded" — which passes every
       structural check while testing nothing. */
    AdminExt: require(`${path}/public/admin-ext.js`),
    /* The weekly UCM card — the upload that opens the Contact Centre report. */
    AdminUcm: require(`${path}/public/admin-ucm.js`),
    CcFmt: require(`${path}/public/cc-fmt.js`),
    TgFmt: require(`${path}/public/tg-fmt.js`),
    document: upDom.document,
    console,
    location: { search: '', href: '', pathname: '/admin' },
    /* URL-aware now: the six panels read six different endpoints, and one
       payload for all of them renders six versions of the Uploads tab. */
    fetch: async (url) => {
      const u = String(url).split('?')[0];
      return { ok: true, status: 200, json: async () => (u in admPayloads ? admPayloads[u] : upPayload) };
    },
    /* Capture the tab hook so the panel can be asked to render, the same way a
       click would ask it. */
    Shell: { mountTabs: (o) => { onShow = o && o.onShow; return () => {}; }, stickyBar() {}, showPanel() {}, onRefresh() {}, fireRefresh() {} },
    URLSearchParams: global.URLSearchParams,
    Date, Number, Math, JSON, String, Object, Array, RegExp, isNaN, Boolean, Set, Map, Error,
    ResizeObserver: class { observe() {} },
    setTimeout, Promise, FileReader: class {},
    Draft: RealDraft,
    Rules: require(`${path}/public/rules.js`),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    alert() {}, confirm: () => true, prompt: () => null,
  };
  upSandbox.window = upSandbox;
  upSandbox.globalThis = upSandbox;
  vm.createContext(upSandbox);
  try {
    vm.runInContext(fs.readFileSync(`${path}/public/fmt.js`, 'utf8'), upSandbox, { filename: 'fmt.js' });
    vm.runInContext(fs.readFileSync(`${path}/public/admin.js`, 'utf8'), upSandbox, { filename: 'admin.js' });
    /* Every tab, through its own loader — the panels render on demand, so one
       that throws is invisible unless something asks for it. */
    /* `commission` was never driven here, which is how an unclosed <option> in
       its datalists survived: a panel nothing asks for cannot fail a check. */
    for (const tab of ['periods', 'data', 'mapping', 'commission', 'audit']) {
      try { if (onShow) await onShow(tab); } catch (e) { ok(`admin tab ${tab} renders`, false, e.message); }
    }
    await new Promise((r) => setTimeout(r, 150));
  } catch (e) {
    ok('admin.js runs under the shim', false, e.message);
  }
  /* ---- the six panels ---- */
  for (const [id, label] of [['status', 'Needs attention'], ['periodsList', 'Periods'],
    ['feeds', 'Data · freshness'], ['uploads', 'Data · uploads'],
    ['aliases', 'Mapping'], ['commission', 'Commission'], ['audit', 'Activity']]) {
    const html = upDom.els[id].innerHTML;
    ok(`admin · ${label} renders`, html.length > 400, `${html.length} chars`);
    ok(`  ${label} tags balance`, balanced(html) === null, balanced(html));
    ok(`  ${label} has no undefined or NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  }

  /* The landing panel is the whole point: it must NAME the missing month and
     carry the money riding on it, not just say a sheet is absent. */
  {
    const st = upDom.els.status.innerHTML;
    const payload = admPayloads['/api/admin/status'];
    const period = payload.items.find((i) => i.key.startsWith('period:'));
    if (period) {
      ok('  the status panel names the missing month', st.includes(period.title), period.title);
      ok('  and carries what it costs, not just that it is missing',
        st.includes(period.cost.slice(0, 40)), period.cost.slice(0, 60));
      ok('  with a button that goes to the fix',
        /data-carry=|data-resume=/.test(st), 'no action button on a period row');
    }
    ok('  every row on it offers an action or says why there is none',
      (st.match(/class="listcard"/g) || []).length === payload.items.length,
      `${(st.match(/class="listcard"/g) || []).length} cards for ${payload.items.length} items`);
  }

  /* Two things Mina asked to be taken off the page. Both are display-only
     removals — the counts still travel in the status payload and the 35
     CommissionNote rows are still in the database with their route — so these
     assert the PAGE, not the data. */
  {
    const st = upDom.els.status.innerHTML;
    ok('  the severity count cards are gone from Needs attention',
      (st.match(/class="kpi[ "]/g) || []).length === 0,
      `${(st.match(/class="kpi[ "]/g) || []).length} count cards still drawn`);
    ok('  but the list of problems and the checked-at line stay',
      (st.match(/class="listcard"/g) || []).length > 0 && /Checked/.test(st),
      'the list itself went with the cards');
    ok('  the unresolved-policy table is gone from Commission',
      !/Unresolved in the source policy/.test(upDom.els.commission.innerHTML),
      'the policy checklist is still drawn');
    ok('  and the rest of Commission is untouched',
      /Vendor cash back/.test(upDom.els.commission.innerHTML)
      && /pool ladder/.test(upDom.els.commission.innerHTML),
      'something else went with it');
  }

  /* ---- the doctor schemes, which is where a new doctor is added ----
     Two commissions share this panel and nothing else, so the checks are about
     the SEPARATION as much as the content: a reader who confuses the branch
     grid with a doctor's share pays somebody twice. */
  {
    const cm = upDom.els.commission.innerHTML;
    const S = admPayloads['/api/schemes'];
    ok('  the doctor schemes section is drawn', /Doctor commission schemes/.test(cm));
    ok(`  all ${S.schemes.length} schemes appear`,
      S.schemes.every((sc) => cm.includes(esc0(sc.name))),
      S.schemes.filter((sc) => !cm.includes(esc0(sc.name))).map((sc) => sc.name).join(', '));
    ok('  it says outright that this is a different commission from the grid',
      /different commission from the grid/.test(cm));
    ok('  and that a band is a lookup, not a ladder',
      /lookup, not a ladder/.test(cm));
    ok(`  every one of the ${S.doctors.length} assigned doctors is listed`,
      S.doctors.every((d) => cm.includes(esc0(d.doctorName))),
      S.doctors.filter((d) => !cm.includes(esc0(d.doctorName))).slice(0, 3).map((d) => d.doctorName).join(', '));
    /* A scheme that counts no hours must not be drawn as zero an hour — that is
       the one distinction the whole `hourlyRate: null` convention exists for. */
    const noHours = S.schemes.filter((sc) => sc.hourlyRate == null);
    ok(`  the ${noHours.length} schemes that count no hours say so, rather than showing 0/hour`,
      (cm.match(/hours are NOT counted/g) || []).length === noHours.length,
      `${(cm.match(/hours are NOT counted/g) || []).length} said so`);
    /* The eight agreed rates are the reason `rateOverride` exists. */
    const over = S.doctors.filter((d) => d.rateOverride != null);
    ok(`  the ${over.length} agreed rates are shown as agreed rates, with their reason`,
      over.every((d) => cm.includes(esc0(d.rateOverrideWhy || ''))),
      'a reason is missing from the table');
    ok('  and a new scheme can be added without leaving the page', /id="nsName"/.test(cm));
    /* The list that answers "who did we hire and forget". */
    ok('  doctors who invoiced and are on no scheme are named',
      /Invoiced, and on no scheme/.test(cm));
    if (S.unassigned.length) {
      ok(`    all ${S.unassigned.length} of them, with a scheme picker on each row`,
        (cm.match(/data-doc="[^"]*:schemeId"/g) || []).length === S.doctors.length + S.unassigned.length,
        `${(cm.match(/data-doc="[^"]*:schemeId"/g) || []).length} pickers`);
      ok('    and it says why they earn nothing rather than showing a zero',
        /no commission<\/strong>/.test(cm));
    }
  }

  /* ---- the plan grid, below the sheet editor ----
     It is its own module with its own fetch, so the failure mode worth guarding
     is the quiet one: `renderPlan` catches, draws "could not load", and every
     check above still passes. These assert the GRID, not the panel. */
  {
    const pl = upDom.els.plan.innerHTML;
    const P = admPayloads['/api/targets-plan'];
    ok('  the plan grid is drawn, not its error branch',
      /<h3 class="subtitle">The plan/.test(pl) && !/Could not load the plan/.test(pl),
      pl.slice(0, 160));
    ok(`    one editable cell per branch-month (${P.totals.branchMonths})`,
      (pl.match(/data-plan="branches:/g) || []).length === P.totals.branchMonths,
      `${(pl.match(/data-plan="branches:/g) || []).length} cells`);
    ok(`    and per doctor-month (${P.totals.doctorMonths})`,
      (pl.match(/data-plan="doctors:/g) || []).length === P.totals.doctorMonths,
      `${(pl.match(/data-plan="doctors:/g) || []).length} cells`);
    ok('    the planned total is stated', pl.includes(fmtNum(P.totals.plannedTarget)),
      fmtNum(P.totals.plannedTarget));
    ok('    both grids offer to carry a month forward',
      /id="cyBGo"/.test(pl) && /id="cyDGo"/.test(pl));
    ok('    and carrying refuses to overwrite unless asked',
      /id="cyBOver"/.test(pl) && /Replace what is already there/.test(pl));
    /* The pool grid is shown here so somebody setting a target can see what the
       achievement actually pays — read-only, and it says where to edit it. */
    if (P.policy && !P.policy.missing) {
      ok(`    the ${P.policy.version} pool grid is shown beside the targets`,
        pl.includes(esc0(P.policy.version))
        && (pl.match(/<tr><td class="nm">/g) || []).length >= P.policy.tiers.length);
      ok('    with each role\'s share of a pool',
        P.policy.roles.every((r) => pl.includes(`${(r.share * 100).toFixed(1)}%`)),
        P.policy.roles.map((r) => `${r.role} ${(r.share * 100).toFixed(1)}%`).join(' · '));
    }
    ok('    the plan tags balance', balanced(pl) === null, balanced(pl));
    ok('    and it has no undefined or NaN',
      !/undefined|NaN/.test(pl), (pl.match(/.{0,50}(undefined|NaN).{0,50}/) || [])[0]);
  }

  /* ---- the v3.2 policy editor, below the v2.8 sections ----
     The figures in this panel are what branch teams are paid, so the counts are
     tied to the payload rather than to remembered numbers — a grid that renders
     thirteen rows for a fourteen-tier policy would otherwise pass. */
  {
    /* The editor fills a placeholder INSIDE the commission panel's markup. In a
       browser that is one tree; under the shim `innerHTML` is a string and its
       children are not queryable, so the module writes into its own stub and
       the two are asserted separately. */
    const host = upDom.els.commission.innerHTML;
    const cm = upDom.els.v32.innerHTML;
    const V = admPayloads['/api/policy/v32'];
    const P = V.policy;
    ok('  the v3.2 editor is drawn, not its error branch',
      /Commission policy <span class="vat-tag">/.test(cm) && !/Could not load the v3.2/.test(cm),
      (cm.match(/.{0,80}Could not load the v3\.2.{0,80}/) || [])[0]);
    ok('    into a placeholder below the v2.8 sections it does not replace',
      /pool ladder[\s\S]*<div id="v32">/.test(host),
      'the v3.2 placeholder is not below the v2.8 ladder');
    ok(`    one input per achievement level (${P.levels.length})`,
      (cm.match(/data-v32level=/g) || []).length === P.levels.length);
    ok('    the first level is marked as the floor', /the floor<\/span>/.test(cm));
    ok(`    the pool grid is ${P.tiers.length} tiers by ${P.levels.length} levels, every cell editable`,
      (cm.match(/data-v32pool="\d+:p\d+"/g) || []).length === P.tiers.length * P.levels.length,
      `${(cm.match(/data-v32pool="\d+:p\d+"/g) || []).length} cells`);
    ok('    with its bounds editable too',
      (cm.match(/data-v32pool="\d+:(from|to)"/g) || []).length === P.tiers.length * 2);
    ok(`    a row per role, with its share worked out (${P.roles.length})`,
      (cm.match(/data-v32share=/g) || []).length === P.roles.length
      && P.roles.every((r) => cm.includes(`${((r.weight / P.totalWeight) * 100).toFixed(1)}%`)),
      P.roles.map((r) => `${r.role} ${((r.weight / P.totalWeight) * 100).toFixed(1)}%`).join(' · '));
    ok(`    and a staff card per branch (${V.branches.length})`,
      (cm.match(/data-v32add=/g) || []).length === V.branches.length);
    ok('    every table has a Save button',
      ['v32SaveLevels', 'v32SavePools', 'v32SaveRoles', 'v32SaveStaff']
        .every((id) => cm.includes(`id="${id}"`)));
    /* `data-band` is already used by TWO sections of this page with different
       meanings, and both handlers bind to the bare selector. The v3.2 editor
       must not add a third collision. */
    ok('    its attributes do not collide with the two that already do',
      !/data-band=/.test(cm),
      'the v3.2 editor reuses data-band');
    ok('    the panel still balances with it in', balanced(cm) === null, balanced(cm));
  }

  /* The calendar answers the question the list of published sheets cannot:
     which month is MISSING is precisely the row that is not there. */
  {
    const pl = upDom.els.periodsList.innerHTML;
    ok('  the year calendar draws twelve months',
      (pl.match(/class="mcell/g) || []).length === 12,
      `${(pl.match(/class="mcell/g) || []).length} cells`);
    ok('  and a started month with no sheet is marked due, not merely absent',
      /mcell due/.test(pl), 'no due cell — a missing month looks like a future one');
    ok('  a published month is marked published', /mcell published/.test(pl));
  }

  const upHtml = upDom.els.uploads.innerHTML;
  ok('  its tags balance', balanced(upHtml) === null, balanced(upHtml));
  ok('  it has no undefined or NaN', !/undefined|NaN/.test(upHtml),
    (upHtml.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  ok('  it offers all three feeds', ['pbx', 'chat', 'leads']
    .every((k) => upHtml.includes(`data-upload="${k}"`)), 'a feed is missing its button');
  ok('  and states what is currently held, seed included',
    /seed/.test(upHtml) && /PBX day roll-up/.test(upHtml));

  /* The weekly UCM card: the upload that opens the Contact Centre report. It
     must say, before anything else, whether the report is open or locked and
     which week it is waiting for — compared against the live gate payload, so
     this holds whichever state the local database is in. */
  const ucmHtml = upDom.els.ucmweekly.innerHTML;
  const gNow = admPayloads['/api/contact-centre/gate'];
  ok('the weekly UCM card is drawn at the top of Uploads', /Weekly UCM export/.test(ucmHtml),
    ucmHtml.slice(0, 160) || 'empty');
  ok('  it states whether the Contact Centre report is open or locked',
    gNow.locked ? /LOCKED for everyone/.test(ucmHtml) : /report is open/.test(ucmHtml));
  ok('  and offers the file picker', /id="ucmPick"/.test(ucmHtml) && /accept="\.csv,\.xlsx,\.xls"/.test(ucmHtml));
  ok('  its tags balance', balanced(ucmHtml) === null, balanced(ucmHtml));

  /* ------------------------------------- inventory · report 08 ---- */
  console.log('\ninventory.js against the real payload');

  const invIds = ['from', 'to', 'load', 'dot', 'status', 'err', 'rangeline', 'hPeriod',
    'hHand', 'hHandUnit', 'hVal', 'hValUnit', 'hShort', 'hRisk', 'ov', 'ex', 'cv', 'ar'];
  /* 10 → 27 August, because that window holds TWO stock snapshots and the
     movement ledger needs an opening count and a closing one. A window with one
     is refused, which is checked separately below. */
  const invPayload = await get2('/api/inventory?from=2026-08-10&to=2026-08-27');
  const inv = runPage('inventory.js', invPayload, invIds, { '#presets button': [{ p: 'mtd' }] });
  /* `load()` is async, so the panels are empty until its fetch resolves — the
     same wait every other page in this harness needs. */
  await new Promise((r) => setTimeout(r, 120));

  for (const [panel, what] of [['ov', 'Overview'], ['ex', 'Expiry'], ['cv', 'Cover'],
    ['ar', 'At-risk sales']]) {
    const html = inv.els[panel].innerHTML;
    ok(`  ${what} renders`, html.length > 300, `${html.length} chars`);
    ok(`  ${what} tags balance`, balanced(html) === null, balanced(html));
    ok(`  ${what} has no undefined or NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  }
  ok('the inventory report did not fail', inv.els.status.textContent !== 'failed',
    inv.els.err.textContent);

  /* The claim the whole report rests on, asserted on the rendered page rather
     than only in the library: the headline is UNITS, and units are fewer than
     the doses Odoo stores. Reading the snapshot as units overstates it 4.6x. */
  ok('  the hero shows converted units, not the raw dose count',
    Number(String(inv.els.hHand.textContent).replace(/,/g, '')) < invPayload.totals.onHandDoses,
    `${inv.els.hHand.textContent} vs ${fmtNum(invPayload.totals.onHandDoses)} doses`);
  ok('  and says how many doses that is', /doses/.test(inv.els.hHandUnit.textContent),
    inv.els.hHandUnit.textContent);

  /* "Not linked" must be a visible state, not silently folded into Dormant. */
  ok('  unlinked products are named on the page as unlinked',
    /Not linked/.test(inv.els.ov.innerHTML) && /Not linked/.test(inv.els.cv.innerHTML),
    'the nolink band is not shown');
  ok('  the value note says what it refused and why',
    /never summed|left OUT/.test(inv.els.ov.innerHTML),
    'the page does not say the value figure is partial');
  ok('  the expiry tab says its snapshot does not refresh',
    /does not refresh/.test(inv.els.ex.innerHTML), 'the staleness warning is gone');

  /* THE STRUCTURE, not just the figures. The first build of this tab rendered a
     flat table: the same numbers, and none of the lots behind them. A product
     total is not actionable — you chase four lots in four named branches. */
  {
    const ex = inv.els.ex.innerHTML;
    const cards = (ex.match(/data-exp-card/g) || []).length;
    ok('  every product is an expandable card, not a table row',
      cards === invPayload.expiry.products.length && cards > 10,
      `${cards} cards for ${invPayload.expiry.products.length} products`);
    const lotRows = (ex.match(/class="lot-row"/g) || []).length;
    const lots = invPayload.expiry.products.reduce((t, p) => t + p.lotCount, 0);
    ok('  and opens to every lot behind it',
      lotRows === lots && lotRows > 100, `${lotRows} lot rows for ${lots} lots`);
    ok('  each expansion ends in a total that reconciles to its card',
      (ex.match(/class="lot-row tot"/g) || []).length === cards,
      'a product expansion has no reconciliation row');
    ok('  the status chips are offered with their counts',
      /data-expf="all"/.test(ex) && /data-expf="risk"/.test(ex) && /class="cn"/.test(ex),
      'the filter chips are missing');
    ok('  expand-all and collapse-all are there, for 91 products',
      /data-exall="ex"/.test(ex) && /data-colall="ex"/.test(ex), 'the bulk toggles are missing');
    ok('  every value carries its inc-VAT figure beside it',
      /inc<\/div>|inc<\/span>| inc</.test(ex) && /grossed up/.test(ex),
      'the inc-VAT pairing the pack shows is absent');
    ok('  a lot says how long it has in words, not just a date',
      /days ago|in \d+ days|days<\/|today/.test(ex), 'no days-remaining wording');
  }
  /* The sync-status tab is gone — its job is the shared bar's Sync now, and the
     limitation it stated belongs with the ledger that has it. */
  ok('  the ledger says no stock moves are cached, and that Adjust is the residual',
    /snapshots, not moves/i.test(inv.els.cv.innerHTML)
    && /residual/i.test(inv.els.cv.innerHTML),
    'the movement limitation is not stated anywhere');
  ok('  and it opens on a real earlier count, not the closing one',
    !invPayload.ledger.missing
    && invPayload.ledger.openingAt !== invPayload.ledger.closingAt,
    invPayload.ledger.missing ? invPayload.ledger.reason
      : `${invPayload.ledger.openingAt} → ${invPayload.ledger.closingAt}`);

  /* And the refusal, on a window with one snapshot in it. Deriving an opening
     balance from the closing count makes the ledger cross-foot to zero movement
     — balanced, and empty of information. */
  {
    const one = await get2('/api/inventory?from=2026-01-01&to=2026-01-31');
    const invOne = runPage('inventory.js', one, invIds, { '#presets button': [{ p: 'mtd' }] });
    await new Promise((r) => setTimeout(r, 120));
    ok('  a window with one snapshot refuses the ledger and says why',
      /No ledger for this window/.test(invOne.els.cv.innerHTML)
      && balanced(invOne.els.cv.innerHTML) === null,
      balanced(invOne.els.cv.innerHTML) || 'the refusal is missing');
    ok('  and still offers the cover cut, which needs only one count',
      /Cover, from the latest count alone/.test(invOne.els.cv.innerHTML),
      'the half that is still true was withheld');
  }

  /* A window with no snapshot in it at all — the refusal, not a wall of zeros. */
  const invEmpty = runPage('inventory.js',
    { ...invPayload, expiry: { missing: true, asOf: '2026-01-31' }, atRisk: { missing: true, reason: 'No expiry lots are loaded.' } },
    invIds, { '#presets button': [{ p: 'mtd' }] });
  await new Promise((r) => setTimeout(r, 120));
  ok('  with no expiry data it refuses instead of drawing zeros',
    /No expiry lots are loaded/.test(invEmpty.els.ex.innerHTML)
    && balanced(invEmpty.els.ex.innerHTML) === null,
    balanced(invEmpty.els.ex.innerHTML) || 'the refusal is missing');
  ok('  and the at-risk tab says which half it is missing',
    /only one of them is here/.test(invEmpty.els.ar.innerHTML),
    'the at-risk refusal does not say what is absent');

  /* ------------------------------------- procurement · report 09 ---- */
  console.log('\nprocurement.js against the real payload');

  const procIds = ['from', 'to', 'load', 'dot', 'status', 'err', 'rangeline', 'hPeriod',
    'hNet', 'hNetUnit', 'hCons', 'hRet', 'hRetUnit', 'hCb', 'hCbUnit',
    'ov', 'pr', 'vs', 'rt', 'pu', 'prDetail'];
  const procPayload = await get2('/api/procurement?from=2026-01-01&to=2026-08-31');
  const proc = runPage('procurement.js', procPayload, procIds, { '#presets button': [{ p: 'ytd' }] });
  await new Promise((r) => setTimeout(r, 120));

  for (const [panel, what] of [['ov', 'Overview'], ['pr', 'Products'], ['vs', 'Vendors'],
    ['rt', 'Returns'], ['pu', 'Purchasing']]) {
    const html = proc.els[panel].innerHTML;
    ok(`  ${what} renders`, html.length > 300, `${html.length} chars`);
    ok(`  ${what} tags balance`, balanced(html) === null, balanced(html));
    ok(`  ${what} has no undefined or NaN`, !/undefined|NaN/.test(html),
      (html.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  }
  ok('the procurement report did not fail', proc.els.status.textContent !== 'failed',
    proc.els.err.textContent);

  /* The scope decision has to be legible on the page, or a figure 78% above the
     source pack's is indistinguishable from a bug. */
  ok('  the page states it counts every payable, not only products',
    /Every payable|every payable/.test(proc.els.ov.innerHTML),
    'the scope is not stated on the overview');
  ok('  and names the pack\'s figure beside its own',
    /29,401,633/.test(proc.els.ov.innerHTML),
    'the page does not say what the source pack counted');
  ok('  the composition says whether it balances',
    /adds up exactly|out by/.test(proc.els.ov.innerHTML),
    'the reconciliation verdict is not rendered');
  ok('  the returns tab says the rows are seeded',
    /seeded/.test(proc.els.rt.innerHTML), 'the seed provenance is not stated');
  /* PAYMENTS LIVE ON TAB 03 NOW, under their own sub-tab — they were on both
     tabs, the same figures rendered twice, which is how two tabs start
     disagreeing after somebody edits one. What tab 05 keeps is the warning in
     the form that matters there: a month is when the invoice was raised. */
  ok('  purchasing says a month is when the invoice was raised, not paid',
    /when the INVOICE was raised/i.test(proc.els.pu.innerHTML),
    'the note that stops a wrong reading is gone');
  ok('  and purchasing is split into the four cuts the pack uses',
    ['mon', 'cat', 'price', 'tgt'].every((k) => proc.els.pu.innerHTML.includes(`data-psub="${k}"`)),
    'the purchasing sub-tabs are missing');
  ok('  payments are not duplicated onto the purchasing tab',
    !/Paid out|How it was paid/.test(proc.els.pu.innerHTML),
    'payments are rendered on two tabs');
  /* Every product is LISTED; only the ones in the stock catalogue are openable,
     because rent and advertising have no stock or sales to drill into. Offering
     a row and then apologising for it is worse than greying it. */
  {
    const pr = proc.els.pr.innerHTML;
    const known = new Set(procPayload.catalogue.map((c) => String(c.name).toLowerCase()));
    const openable = procPayload.purchases.products
      .filter((p) => known.has(String(p.product).toLowerCase())).length;
    ok('  every product is listed',
      (pr.match(/class="il-row"/g) || []).length === procPayload.purchases.products.length,
      `${(pr.match(/class="il-row"/g) || []).length} rows for ${procPayload.purchases.products.length} products`);
    ok('  and the ones with stock behind them are the openable ones',
      (pr.match(/data-prod=/g) || []).length === openable && openable > 0,
      `${(pr.match(/data-prod=/g) || []).length} openable, expected ${openable}`);
    ok('  the picker and the period chips are offered',
      /id="prodIn"/.test(pr) && /id="prodList"/.test(pr) && /data-period="ytd"/.test(pr)
      && /id="cApply"/.test(pr), 'the product controls are missing');
  }

  /* A cash-back figure on the page must be a rate somebody agreed, and the page
     has to say how many suppliers that is — 63 was the wrong answer. */
  /* The vendors tab is three readings of one payload, behind sub-tabs. The
     default view is Purchases, so cash back lives one click away — asserted by
     clicking, because a sub-tab that renders nothing is the failure here. */
  {
    const vs = proc.els.vs.innerHTML;
    ok('  vendors are expandable cards with their products behind them',
      (vs.match(/class="prod-card"/g) || []).length === procPayload.vendors.rows.length,
      `${(vs.match(/class="prod-card"/g) || []).length} cards for ${procPayload.vendors.rows.length} vendors`);
    ok('  each vendor card ends in a total that reconciles to it',
      (vs.match(/class="lot-row tot"/g) || []).length === procPayload.vendors.rows.length,
      'a vendor card has no reconciliation row');
    ok('  the three sub-tabs are offered',
      /data-vsub="score"/.test(vs) && /data-vsub="cash"/.test(vs) && /data-vsub="pay"/.test(vs),
      'the vendor sub-tabs are missing');
    ok('  cash back is fewer than 30 suppliers, not 63',
      procPayload.vendors.totals.vendorsWithRate < 30 && procPayload.vendors.totals.vendorsWithRate > 0,
      `${procPayload.vendors.totals.vendorsWithRate} suppliers carry a rate`);
  }

  /* --------------------------------- one control bar, eleven pages ---- */
  console.log('\nthe control bar is shared, not copied');

  /* THE POINT OF public/cbar.js. The bar was hand-written into ten views and had
     already drifted: NRS carried five presets and an Export/Import pair, the
     others carried four in three different orders, and none of them had any way
     to trigger a sync. This is the check that stops the eleventh copy. */
  {
    const REPORTS = ['report', 'doctors', 'inventory', 'procurement', 'marketing',
      'targets', 'commission', 'commercial', 'commercial-sales', 'contact-centre', 'patients'];
    const bad = [];
    for (const name of REPORTS) {
      const view = fs.readFileSync(`${path}/src/views/${name}.html`, 'utf8');
      const bar = /<div class="cbar"([^>]*)>([\s\S]*?)\n<\/div>/.exec(view);
      if (!bar) { bad.push(`${name}: no .cbar at all`); continue; }
      if (!/data-presets="/.test(bar[1])) bad.push(`${name}: does not declare its presets`);
      /* Anything but a `.cbar-extra` inside means the bar is hand-written again. */
      const inner = bar[2].replace(/<!--[\s\S]*?-->/g, '').trim();
      if (inner && !/^<div class="cbar-extra">[\s\S]*<\/div>$/.test(inner)) {
        bad.push(`${name}: hand-written markup inside .cbar`);
      }
      if (!view.includes('/assets/cbar.js')) bad.push(`${name}: does not load cbar.js`);
      /* And nobody may keep their own copy of the controls the bar now owns. */
      for (const id of ['id="presets"', 'id="from"', 'id="to"', 'id="load"',
        'id="dot"', 'id="status"', 'id="err"', 'id="refresh"']) {
        if (view.includes(id)) bad.push(`${name}: still hand-writes ${id}`);
      }
    }
    ok(`all ${REPORTS.length} reports declare the shared bar instead of writing one`,
      bad.length === 0, bad.join(' · '));

    const cbar = fs.readFileSync(`${path}/public/cbar.js`, 'utf8');
    ok('  the bar offers Sync now, and it posts to /api/refresh',
      /id="syncNow"/.test(cbar) && /'\/api\/refresh'/.test(cbar),
      'Sync now is not wired');
    ok('  it sends the anti-CSRF header the endpoint requires',
      /X-Requested-With/.test(cbar), 'the refresh would be refused with 403');
    ok('  it disables itself while a sync is in flight',
      /btn\.disabled = true/.test(cbar), 'four calls a minute is the limit');
    ok('  and it asks the page to reload through the hook, not location.reload',
      /Shell\.fireRefresh\(\)/.test(cbar) && !/location\.reload/.test(cbar),
      'a reload would throw away the range the reader picked');

    /* Every page must have registered that hook, or Sync now re-reads Odoo and
       leaves the reader looking at the figures from before it. */
    const unhooked = [];
    for (const f of ['app', 'doctors', 'inventory', 'procurement', 'marketing', 'targets',
      'commission', 'commercial', 'commercial-sales', 'contact-centre', 'patients']) {
      const src = fs.readFileSync(`${path}/public/${f}.js`, 'utf8');
      if (!src.includes('Shell.onRefresh')) unhooked.push(f);
    }
    ok('  and every page tells it how to reload', unhooked.length === 0,
      `no hook in: ${unhooked.join(', ')}`);

    /* The four tabs it replaced are gone, and gone from the strip too. */
    const dropped = [
      ['inventory', 'sy'], ['procurement', 'sy'], ['marketing', 'bld'], ['targets', 'policy'],
    ];
    const survivors = dropped.filter(([name, pid]) => {
      const view = fs.readFileSync(`${path}/src/views/${name}.html`, 'utf8');
      return view.includes(`data-panel="${pid}"`) || view.includes(`class="panel" id="${pid}"`);
    });
    ok('  the four provenance tabs are gone, button and panel',
      survivors.length === 0, survivors.map((x) => x.join('/')).join(' · '));
  }

  /* ------------------------------- every class we emit has a rule ---- */
  console.log('\nnothing on reports 08 and 09 renders unstyled');

  /* THE CHECK THAT SHOULD HAVE EXISTED FROM THE FIRST PORT. 89 CSS rules were
     brought over from the source packs by listing the classes wanted — and the
     list said `mv-grid`, `mv-lbl`, `mv-val`, `mv-sub` and forgot the bare `.mv`
     that holds them. The movement ledger came out structurally perfect and
     looked nothing like the pack: seven runs of naked text in a grid, no boxes,
     no green on receipts, no red on issues. `.lot-ex`, `.lot-inc` and the
     `nolink` pill went the same way.
     Listing classes by hand cannot catch that. Asking the rendered markup does. */
  {
    const css = fs.readFileSync(`${path}/public/app.css`, 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
    const panels = [
      ...['ov', 'ex', 'cv', 'ar'].map((id) => ['inventory', inv.els[id].innerHTML]),
      ...['ov', 'pr', 'vs', 'rt', 'pu'].map((id) => ['procurement', proc.els[id].innerHTML]),
    ];
    const used = new Map();
    for (const [report, html] of panels) {
      for (const m of html.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].trim().split(/\s+/)) if (c) used.set(c, report);
      }
    }
    const orphans = [...used.keys()].filter((c) => !defined.has(c)).sort();
    ok(`all ${used.size} classes the two reports emit have a rule in app.css`,
      orphans.length === 0, `unstyled: ${orphans.join(' ')}`);

    /* And the movement cells specifically, because that is the one that got
       away — the grid is meaningless without the box and its three tints. */
    for (const sel of ['.mv{', '.mv.in{', '.mv.bonus{', '.mv.out{', '.mv.hand{',
      '.lot-ex{', '.lot-inc{', '.ideal-bar', '.si-table', '.inv-legend']) {
      ok(`  ${sel.replace('{', '')} is styled`, css.includes(sel), `${sel} has no rule`);
    }
  }

  /* ------------------------------------- admin · 01 target sheets ---- */
  console.log('\nadmin.js — starting a new month from the 01 panel');

  /* The whole reason this panel changed: adding next month meant leaving for the
     report, picking the right range, exporting, filling in Excel and coming
     back. What has to be true now is that the panel NAMES the missing month and
     that its button actually loads a carried draft into the editor — a button
     that renders and does nothing is the failure this harness exists for. */
  const periodList = await get2('/api/targets');
  const augSheet = await get2('/api/targets/2026-08');
  const planPayload = await get2('/api/targets-plan');
  const v32Payload = await get2('/api/policy/v32');

  const admIds = ['status', 'periods', 'periodsList', 'editor', 'import', 'plan', 'v32', 'mapping', 'aliases',
    'links', 'data', 'feeds', 'audit', 'commission', 'uploads',
    'who', 'err', 'newSheet', 'publish', 'saveDraft', 'balance', 'addGroup', 'addDoctor',
    'addBranch', 'ledger', 'fPeriod', 'fDays', 'fSource', 'docFilter', 'drop', 'file'];
  const admDom = makeDom(admIds, {
    '.tab': [], '.panel': [],
    '[data-edit]': [], '[data-xlsx]': [],
    '[data-carry]': [{ carry: '2026-08' }],
    '[data-g]': [], '[data-d]': [], '[data-b]': [],
    '[data-delg]': [], '[data-deld]': [], '[data-delb]': [],
  });
  let admShow = null;
  const admSandbox = {
    /* The plan editor is its own module, loaded by admin.html before admin.js.
       Missing from this stub, `renderPlan` throws and the Periods tab shows its
       "could not load" branch — which passes every check while testing nothing. */
    AdminPlan: require(`${path}/public/admin-plan.js`),
    /* The v3.2 policy editor, its own module loaded before admin.js. Missing
       from this stub, `renderV32` throws into its catch and the Commission tab
       shows "could not load" — which passes every structural check below while
       testing nothing. */
    AdminV32: require(`${path}/public/admin-v32.js`),
    /* The phone extension map, its own module loaded by admin.html before
       admin.js. Missing from this stub, renderUploads throws into its catch and
       the Uploads tab shows "could not be loaded" — which passes every
       structural check while testing nothing. */
    AdminExt: require(`${path}/public/admin-ext.js`),
    /* The weekly UCM card — the upload that opens the Contact Centre report. */
    AdminUcm: require(`${path}/public/admin-ucm.js`),
    CcFmt: require(`${path}/public/cc-fmt.js`),
    TgFmt: require(`${path}/public/tg-fmt.js`),
    document: admDom.document,
    console,
    location: { search: '', href: '', pathname: '/admin' },
    fetch: async (url) => {
      const u = String(url).split('?')[0];
      /* `/api/targets/drafts` MUST answer with an array. Returning `{}` made
         the calendar's `(drafts || []).map` throw, which took the whole panel
         down — an empty object is not an empty list. */
      const body = u === '/api/targets' ? periodList
        : u === '/api/targets/drafts' ? []
          : u === '/api/targets/2026-08' ? augSheet
            /* The Periods tab draws the plan grid below the sheet editor, and
               `{}` makes it throw — which takes the editor above it down too. */
            : u === '/api/targets-plan' ? planPayload
              : u === '/api/policy/v32' ? v32Payload
                : {};
      return { ok: true, status: 200, json: async () => body };
    },
    Shell: { mountTabs: (o) => { admShow = o && o.onShow; return () => {}; }, stickyBar() {}, showPanel() {}, onRefresh() {}, fireRefresh() {} },
    URLSearchParams: global.URLSearchParams,
    Date, Number, Math, JSON, String, Object, Array, RegExp, isNaN, Boolean, Set, Map, Error,
    ResizeObserver: class { observe() {} },
    setTimeout, Promise, FileReader: class {},
    Draft: RealDraft,
    Rules: require(`${path}/public/rules.js`),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    alert() {}, confirm: () => true, prompt: () => null,
  };
  admSandbox.window = admSandbox;
  admSandbox.globalThis = admSandbox;
  vm.createContext(admSandbox);
  try {
    vm.runInContext(fs.readFileSync(`${path}/public/fmt.js`, 'utf8'), admSandbox, { filename: 'fmt.js' });
    vm.runInContext(fs.readFileSync(`${path}/public/admin.js`, 'utf8'), admSandbox, { filename: 'admin.js' });
    if (admShow) await admShow('periods');
    await new Promise((r) => setTimeout(r, 60));
  } catch (e) {
    ok('admin.js runs under the shim', false, e.message);
  }

  const pHtml = admDom.els.periodsList.innerHTML;
  ok('the 01 panel renders', pHtml.length > 400, `${pHtml.length} chars`);
  ok('  its tags balance', balanced(pHtml) === null, balanced(pHtml));
  ok('  it has no undefined or NaN', !/undefined|NaN/.test(pHtml),
    (pHtml.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
  ok('  it NAMES the month with no sheet instead of leaving it to be noticed',
    /has no target sheet/.test(pHtml), 'no missing-month card');
  ok('  and offers to start it from the newest published sheet',
    /data-carry="2026-08"/.test(pHtml) && /Start 2026-09/.test(pHtml),
    'no carry-forward button for 2026-09');
  ok('  the workbook is still one click away, without leaving for the report',
    /data-xlsx="2026-08"/.test(pHtml), 'no template button');
  ok('  every published row can be edited, templated and rolled forward',
    periodList.every((r) => pHtml.includes(`data-edit="${r.period}"`)
      && pHtml.includes(`data-xlsx="${r.period}"`)
      && pHtml.includes(`data-carry="${r.period}"`)),
    `${periodList.length} sheets listed, actions: edit ${(pHtml.match(/data-edit=/g) || []).length}`);
  ok('  and is reachable from the calendar as well as the table',
    /* Two ways in on purpose: the table is the ledger of what exists, the
       calendar is where you notice what does not. Counting `data-edit` and
       expecting it to equal the sheet count assumed only one. */
    periodList.every((r) => (pHtml.match(new RegExp(`data-edit="${r.period}"`, 'g')) || []).length >= 2),
    'a published month appears in the table but not the calendar');

  /* Click it. This is the half that a rendering check cannot see. */
  const carryBtn = admDom.nodes('[data-carry]')[0];
  if (carryBtn) carryBtn.fire('click');
  await new Promise((r) => setTimeout(r, 60));
  const eHtml = admDom.els.editor.innerHTML;
  ok('clicking it opens the editor on 2026-09, not on the month it came from',
    /<h2 class="title">2026-09<\/h2>/.test(eHtml), (eHtml.match(/<h2 class="title">[^<]*/) || [])[0]);
  ok('  the roster came with it', new RegExp(`${augSheet.doctors.length} listed`).test(eHtml),
    `expected ${augSheet.doctors.length} listed`);
  ok('  and the branch targets did too', new RegExp(`${augSheet.branches.length} branches`).test(eHtml),
    `expected ${augSheet.branches.length} branches`);
  ok('  every target arrived BLANK and the editor says how many',
    new RegExp(`${augSheet.doctors.length} doctors have no target yet`).test(eHtml),
    'the blank-target count is missing or wrong');
  ok('  last month\'s figure is on the row as reference, not as the target',
    /Prev month/.test(eHtml) && new RegExp(`value="${augSheet.doctors[0].monthlyTarget}"`).test(eHtml),
    'the previous figure did not carry');
  ok('  Balance groups is offered, since a carried sheet has no group totals',
    /id="balance"/.test(eHtml), 'no balance button');
  ok('  the ledger has the container a keystroke refreshes, so it cannot freeze',
    /id="ledger"/.test(eHtml) && /Reconciliation/.test(eHtml),
    'no #ledger — refresh() would silently do nothing while someone typed');
  ok('  and the carried sheet reconciles, so nothing blocks the first keystroke',
    !/The server would refuse this sheet/.test(eHtml),
    (eHtml.match(/<li>[^<]*/g) || []).slice(0, 3).join(' | '));
  ok('  the editor\'s tags balance and it has no undefined',
    balanced(eHtml) === null && !/undefined|NaN/.test(eHtml),
    balanced(eHtml) || (eHtml.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);

  /* ------------------------------- the workbook window is clamped ---- */
  console.log('\nthe target template covers its own month and no more');

  {
    const Sheet = require(`${path}/src/lib/sheet.js`);
    const grab = async (q) => {
      const res = await __app.inject({
        method: 'GET', url: `/api/targets/2026-08/next-month.xlsx${q}`,
        headers: { 'X-Requested-With': 'fetch' },
      });
      if (res.statusCode !== 200) throw new Error(`answered ${res.statusCode}`);
      const read = Sheet.read(res.rawPayload);
      return read.rows.reduce((t, r) => t + (Number(r['Invoiced to date']) || 0), 0);
    };
    /* On 8 September, Admin asking for August's template with no `to` used to
       score August against every invoice up to today — September's sales under
       August's heading, in the column next month's targets get set from. */
    const [clamped, asked, over] = await Promise.all([
      grab(''), grab('?to=2026-08-31'), grab('?to=2026-12-31'),
    ]);
    ok('a window running past the month is pulled back to its last day',
      Math.abs(clamped - asked) < 0.02 && Math.abs(over - asked) < 0.02,
      `default ${fmtNum(clamped)} · asked ${fmtNum(asked)} · to=Dec ${fmtNum(over)}`);
    ok('  and the actuals are a real figure, not zero', asked > 0, `${fmtNum(asked)}`);
  }

  console.log(fails ? `\n\x1b[31m${fails} failed\x1b[0m\n` : '\n\x1b[32mall render checks passed\x1b[0m\n');
  if (__app) await __app.close();
  await prisma.$disconnect();
  process.exit(fails ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
