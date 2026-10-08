/* The merged Targets & Commission page, rendered against REAL payloads.
 *
 *   node test/tgc.test.js
 *
 * The page is a dozen panels of template strings fed by two endpoints. Template
 * strings fail in two ways no server test catches: an unbalanced tag, which
 * silently swallows the rest of a panel, and an `undefined` reaching the page
 * because a field was renamed. Both render something that looks finished.
 *
 * So this walks the actual `Tgc.reference()` and `Tgc.period()` output through
 * the actual panel code under a DOM shim, and asserts every panel produced
 * balanced markup with no `undefined`, `NaN` or `[object Object]` in it.
 *
 * It also pins the two figures that must not drift: the approved plan as this
 * database holds it, and September 2026 as the standalone dashboard reported it.
 * The whole point of the merge was that the numbers do not change.
 */
const pathRoot = require('path').join(__dirname, '..');
const Tgc = require(`${pathRoot}/src/lib/tgc.js`);
const { prisma } = require(`${pathRoot}/src/lib/db.js`);

let fails = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ---- a DOM just real enough to render into ---- */
function makeDom() {
  const store = new Map();
  const node = (id) => {
    if (store.has(id)) return store.get(id);
    const n = {
      id,
      _html: '',
      textContent: '',
      hidden: false,
      value: '',
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      style: {},
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, before() {}, after() {}, remove() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
      get outerHTML() { return this._html; },
      set outerHTML(v) { this._html = String(v); },
    };
    store.set(id, n);
    return n;
  };
  const doc = {
    getElementById: node,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => node(`tmp${Math.random()}`),
    addEventListener() {},
    readyState: 'complete',
    body: { classList: { toggle() {} } },
  };
  return { doc, store, node };
}

/** Tags balance, and nothing undefined leaked into the markup. */
function checkHtml(label, html) {
  if (!html) { ok(`${label} rendered`, false, 'empty'); return; }
  const opens = (html.match(/<(div|table|tbody|thead|tr|td|th|span|button|section|h3|h4)\b/g) || []).length;
  const closes = (html.match(/<\/(div|table|tbody|thead|tr|td|th|span|button|section|h3|h4)>/g) || []).length;
  ok(`${label} tags balance`, opens === closes, `${opens} open, ${closes} close`);
  const bad = ['undefined', 'NaN', '[object Object]'].filter((s) => html.includes(s));
  ok(`${label} has no leaked values`, bad.length === 0, bad.join(', '));
}

async function main() {
  console.log('Targets & Commission — merged page\n');

  const ref = await Tgc.reference();
  const per = await Tgc.period('2026-09-01', '2026-09-30');

  /* ---- the figures that must not move ---- */
  console.log('The approved plan, unchanged by the merge:');
  const planYear = (y) => Object.values(ref.branchPlan)
    .reduce((t, m) => t + Object.entries(m).filter(([k]) => k.startsWith(y))
      .reduce((s, [, v]) => s + v, 0), 0);
  ok('branch plan 2026 is 253,574,662', Math.round(planYear('2026')) === 253574662, String(Math.round(planYear('2026'))));
  ok('branch plan 2027 is 315,936,762', Math.round(planYear('2027')) === 315936762, String(Math.round(planYear('2027'))));
  const docYear = (y) => Object.values(ref.doctorPlan)
    .reduce((t, m) => t + Object.entries(m).filter(([k]) => k.startsWith(y))
      .reduce((s, [, v]) => s + v, 0), 0);
  ok('doctor plan 2027 is 306,786,773', Math.round(docYear('2027')) === 306786773, String(Math.round(docYear('2027'))));

  /* A month the live cache does not reach is served from the imported history,
     and must still be the dashboard's own figure. September used to sit here;
     once it was synced it became live data, which is the point of the merge —
     so the history pin moved to a month the sync has not touched. */
  console.log('\nA pre-cache month still reads from the imported history:');
  const aug = await Tgc.period('2026-08-01', '2026-08-31');
  ok('August is 21,316,311', Math.round(aug.totals.billed) === 21316311, String(Math.round(aug.totals.billed)));
  ok('served from history, and says so', aug.sources.partial === true);
  ok('Alex Camp Chizar leads it at 4,708,499',
    aug.branches[0].branch === 'Alex Camp Chizar' && Math.round(aug.branches[0].ex) === 4708499,
    `${aug.branches[0].branch} ${Math.round(aug.branches[0].ex)}`);

  /* ---- package sales are NOT revenue comparable to collections ----
     A package is invoiced when it is SOLD, carries no VAT, and its cash arrives
     on a different day from the treatment. Counting it inflated September by
     1,410,739 across 149 invoices and made this page disagree with every other
     revenue figure in the app. The exclusion list is report.js's, not a second
     copy. */
  console.log('\nThe package journal is excluded, as everywhere else:');
  const Report = require(`${pathRoot}/src/lib/report.js`);
  ok('report.js still names the journal', (Report.EXCLUDED_REVENUE_JOURNALS || []).includes('Package sale journal'),
    JSON.stringify(Report.EXCLUDED_REVENUE_JOURNALS));
  const sep = await Tgc.period('2026-09-01', '2026-09-30');
  const [withPkg] = await prisma.$queryRawUnsafe(
    `select sum("amountUntaxed")::float ex from "Invoice"
      where state = 'posted' and "moveType" in ('out_invoice','out_refund')
        and "invoiceDate" between '2026-09-01' and '2026-09-30'`,
  );
  const [pkgOnly] = await prisma.$queryRawUnsafe(
    `select coalesce(sum("amountUntaxed"),0)::float ex from "Invoice"
      where state = 'posted' and "moveType" in ('out_invoice','out_refund')
        and "invoiceDate" between '2026-09-01' and '2026-09-30'
        and "journalName" = 'Package sale journal'`,
  );
  ok('the reported month equals everything minus the packages',
    Math.round(sep.totals.billed) === Math.round(withPkg.ex - pkgOnly.ex),
    `${Math.round(sep.totals.billed)} vs ${Math.round(withPkg.ex - pkgOnly.ex)}`);
  ok('and the packages were actually there to exclude', Math.round(pkgOnly.ex) > 0,
    String(Math.round(pkgOnly.ex)));

  console.log('\nReference data the artifact carried:');
  ok('285 roster slots across 74 doctors',
    Object.values(ref.rosterByDoctor).reduce((t, byDow) => t + Object.values(byDow).reduce((s, a) => s + a.length, 0), 0) === 285
    && Object.keys(ref.rosterByDoctor).length === 74);
  ok('seven weekday weights, Friday lightest',
    Object.keys(ref.weekday).length === 7
    && Math.min(...Object.values(ref.weekday)) === ref.weekday[4],
    JSON.stringify(ref.weekday));
  ok('five service groups have a seasonal shape',
    Object.values(ref.seasonality).every((byMonth) => Object.values(byMonth).every((g) => Object.keys(g).length >= 1)));
  ok('policy has 5 levels and 14 tiers',
    ref.policy.levels.length === 5 && ref.policy.tiers.length === 14,
    `${ref.policy.levels.length}/${ref.policy.tiers.length}`);

  /* ---- every panel renders ---- */
  console.log('\nPanels:');
  const { doc, store } = makeDom();
  global.document = doc;
  global.window = global;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  global.self = global;

  const Core = require(`${pathRoot}/public/tgc-core.js`);
  Core.ST.ref = ref;
  Core.ST.per = per;
  Core.ST.range = { from: '2026-09-01', to: '2026-09-30' };
  Core.ST.today = '2026-10-06';
  global.TgcCore = Core;

  const panels = {
    wh: require(`${pathRoot}/public/tgc-wh.js`),
    ov: require(`${pathRoot}/public/tgc-ov.js`),
    ac: require(`${pathRoot}/public/tgc-ac.js`),
    tb: require(`${pathRoot}/public/tgc-tb.js`),
    ts: require(`${pathRoot}/public/tgc-ts.js`),
    dr: require(`${pathRoot}/public/tgc-dr.js`),
    tf: require(`${pathRoot}/public/tgc-tf.js`),
    cm: require(`${pathRoot}/public/tgc-cm.js`),
  };

  for (const [name, mod] of Object.entries(panels)) {
    try {
      mod.render();
      ok(`${name} renders without throwing`, true);
    } catch (e) {
      ok(`${name} renders without throwing`, false, e.message);
    }
  }

  /* The markup each panel actually produced. */
  const written = [...store.entries()].filter(([, n]) => n._html && n._html.length > 40);
  ok('panels wrote markup', written.length > 8, `${written.length} elements written`);
  for (const [id, n] of written) checkHtml(id, n._html);

  /* ---- branch names resolve, and what cannot resolve is NAMED ----
     Odoo writes "Madinity The Strip" and "Roushdy"; the sheet says "Madinty The
     Strip" and "Alex Roshdy". The page used to sum every row for its headline
     and then look each branch up by the plan's name, so the total was right and
     four cards read zero. The identity below is what catches that. */
  console.log('\nBranch rows reconcile with the headline:');
  const oct = await Tgc.period('2026-10-01', '2026-10-06');
  const rowSum = oct.branches.reduce((t, b) => t + b.ex, 0);
  ok('every branch row is in the total',
    Math.round(rowSum) === Math.round(oct.totals.billed),
    `rows ${Math.round(rowSum)} vs total ${Math.round(oct.totals.billed)}`);
  ok('a case-only difference resolves (Mall Of Arabia)',
    oct.branches.some((b) => b.branch === 'Mall of Arabia'),
    oct.branches.map((b) => b.branch).join(', '));
  ok('a real spelling difference is reported, not guessed',
    (oct.sources.unmatched || []).some((u) => u.name === 'Madinity The Strip'),
    JSON.stringify(oct.sources.unmatched));
  ok('every unmatched name carries its money',
    (oct.sources.unmatched || []).every((u) => u.ex > 0),
    JSON.stringify(oct.sources.unmatched));

  /* ---- the filters are actually on the page ----
     Every one of these ships `hidden` in the markup the page was ported from,
     so "it renders" and "you can see it" are different claims. The tier chips
     went missing exactly this way: populated on one panel, never unhidden on
     the other. */
  console.log('\nFilters are visible, not just present:');
  const filters = [
    ['tbBrand', 'branch brand'], ['tbMode', 'summary/month-by-month'], ['tbOne', 'single branch'],
    ['drMode', 'doctor summary/month'], ['drBr', 'doctor branch'], ['drOne', 'single doctor'],
    ['acMode', 'like-for-like'], ['acPer', 'actuals period'],
    ['tsBr', 'service branch'],
    ['whBrand', 'live brand'], ['whSortSlot', 'branch card sort'], ['whViewSlot', 'branches/doctors'],
  ];
  for (const [id, what] of filters) {
    const n = store.get(id);
    ok(`${what} (#${id}) is populated and shown`,
      Boolean(n) && n.hidden !== true && String(n._html || '').length > 10,
      !n ? 'never touched' : n.hidden === true ? 'left hidden' : `only ${String(n._html || '').length} chars`);
  }

  /* Branch targets put the TIERS in the columns. The old month grid answered a
     different question, so the controls that drove it are deliberately off. */
  const tbHtml = String((store.get('tbT') || {})._html || '');
  ok('branch targets has a column per policy tier',
    ref.policy.levels.every((l) => tbHtml.includes(`<th>${l.level}%</th>`)),
    tbHtml.slice(0, 200));
  ok('branch targets carries a Share column', tbHtml.includes('<th>Share</th>'));
  for (const dead of ['tbTier', 'tbPer', 'tbYear']) {
    const n = store.get(dead);
    ok(`#${dead} is off — the tiers are the columns now`, !n || n.hidden === true);
  }

  /* Doctors carry the same tier columns as Branch targets, and group headings
     that state their own head count and total. */
  const drHtml = String((store.get('drT') || {})._html || '');
  ok('doctors has a column per policy tier',
    ref.policy.levels.every((l) => drHtml.includes(`<th>${l.level}% · target</th>`)),
    drHtml.slice(0, 220));
  ok('doctors are grouped with a head count', /class="grp"[\s\S]{0,120}people · target/.test(drHtml));
  ok('doctors shows Actual and Achieved', drHtml.includes('<th>Actual</th>') && drHtml.includes('<th>Achieved</th>'));

  /* ---- the two importers read a workbook the same way ----
     `admin.js` and the Target file tab both auto-detect the four columns. They
     are separate code, so the patterns are pinned to be IDENTICAL — two
     importers that disagree about which column is the target would publish two
     different sheets from one file. */
  console.log('\nThe Target file importer matches Admin:');
  const fs2 = require('fs');
  const adminSrc = fs2.readFileSync(`${pathRoot}/public/admin.js`, 'utf8');
  const adminGuess = Object.fromEntries([...adminSrc.matchAll(/pick\('c(\w+)',\s*'[^']*',\s*'([^']*)'\)/g)]
    .map((m) => [m[1].toLowerCase(), m[2]]));
  const Tf = require(`${pathRoot}/public/tgc-tf.js`);
  for (const [k, want] of Object.entries(adminGuess)) {
    ok(`the "${k}" column pattern is the same in both`, Tf.GUESS[k] === want,
      `tgc-tf has ${JSON.stringify(Tf.GUESS[k])}, admin.js has ${JSON.stringify(want)}`);
  }

  /* ---- the commission half is the app's engine, not a second one ----
     This page used to do its own pool lookup and its own doctor rates. Two
     implementations of a payment agree until the day they do not. These pin
     that the page now renders `commission-v32.js` and that its arithmetic
     holds. */
  console.log('\nCommission comes from the shared engine:');
  const V = require(`${pathRoot}/src/lib/commission-v32.js`);
  const built = await V.build({ from: '2026-10-01', to: '2026-10-06' });
  ok('the engine answers for the range', Boolean(built && built.months), String(built && built.note));
  const dr = (built.doctors && built.doctors.rows) || [];
  ok('doctor rows are scored', dr.length > 0, `${dr.length} rows`);
  const rated = dr.filter((r) => r.rate != null && r.commission != null);
  ok('commission is rate x billed, to the piastre',
    rated.every((r) => Math.abs(r.commission - r.ex * r.rate) < 0.02),
    JSON.stringify(rated.slice(0, 1)));
  ok('a rate of 0.5 means 50%, not 0.5%',
    rated.every((r) => r.rate <= 1),
    JSON.stringify(rated.filter((r) => r.rate > 1).slice(0, 2)));
  /* The total is NOT just commission — fixed pay, hours and fees are in it,
     and reporting commission alone once left October 280,000 light. */
  const parts = built.totals.doctorParts || {};
  ok('the doctor total includes more than commission',
    Math.abs(built.totals.doctors - (parts.commission + parts.hours + parts.fixed + parts.fees)) < 1,
    JSON.stringify(built.totals));
  ok('doctors without a payroll month are counted, not hidden',
    typeof parts.withoutPayroll === 'number', JSON.stringify(parts));

  /* ---- one policy shape, whichever answer it came from ----
     The engine returns `fromPct` and no tier label; the reference returns
     `from` and builds one. Rendering whichever arrived first printed NaN in
     the From column. */
  console.log('\nThe policy renders from either source:');
  const Cm = require(`${pathRoot}/public/tgc-cm.js`);
  for (const [which, payload] of [['the engine', built], ['the reference', null]]) {
    Core.ST.cm = payload;
    Cm.render();
    const html = String((store.get('cpBody') || {})._html || '');
    ok(`${which}: no NaN in the policy table`, !html.includes('NaN'),
      html.slice(html.indexOf('NaN') - 60, html.indexOf('NaN') + 10));
    ok(`${which}: tiers are labelled`, /< 500K|500K/.test(html), html.slice(0, 80));
  }
  Core.ST.cm = built;

  /* ---- the branch targets ARE the dashboard's, to the pound ----
     Tuesday 6 October 2026, every branch, weighted by weekday, catch-up off —
     which is the state the dashboard's own screenshot was taken in, because it
     had no Odoo connection and so never loaded month-to-date. With live data
     the same formula carries October's shortfall into the days that remain and
     reads higher; that is the real data showing through, not a different sum. */
  console.log('\nBranch targets match the dashboard exactly:');
  Core.ST.ref = ref;
  Core.ST.per = await Tgc.period('2026-10-06', '2026-10-06');
  Core.ST.range = { from: '2026-10-06', to: '2026-10-06' };
  Core.ST.today = '2026-10-06';
  Core.ST.per.catchUp = null;
  const want = {
    'Madinty The Strip': 146019, 'City Stars': 140131, 'Alex Camp Chizar': 139065,
    CFC: 139065, 'Mall of Arabia': 69533, 'Alex Roshdy': 52149,
    Zayed: 34766, Mohandseen: 34766, 'El Rehab': 17383, Madinty: 17383,
  };
  for (const [name, figure] of Object.entries(want)) {
    const got = Math.round(Core.bTarget(name));
    ok(`${name} is ${figure.toLocaleString()}`, got === figure, String(got));
  }
  const dayTotal = Core.S(Core.branchNames().map((n) => Core.bTarget(n)));
  ok('the day totals 807,644', Math.round(dayTotal) === 807644, String(Math.round(dayTotal)));
  ok('the 80% tier is 646,115', Math.round(dayTotal * 0.8) === 646115, String(Math.round(dayTotal * 0.8)));

  /* The doctor side of the same day, from the same sheet. Her target follows
     her ROSTERED HOURS, so these are not the branch figures split evenly. */
  console.log('\nDoctor targets match the dashboard exactly:');
  const wantDr = {
    'Dr. Mai mohsen': 83772, 'Dr. Poussy Maher': 74731, 'Dr. Randa El Aguizy': 62855,
    'Dr. Ghada Amer': 56105, 'Dr.Merna Ashraf': 39051, 'Dr. Marian Adel': 37063,
  };
  for (const [name, figure] of Object.entries(wantDr)) {
    const got = Math.round(Core.dTarget(name));
    ok(`${name} is ${figure.toLocaleString()}`, got === figure, String(got));
  }
  const drTotal = Core.S(Object.keys(ref.doctorPlan).map((n) => Core.dTarget(n)));
  ok('all doctors total 807,644 — the same day as the branches',
    Math.round(drTotal) === 807644, String(Math.round(drTotal)));

  /* Service targets take their dates from the bar above, like every other
     panel — the year chips and the period select had nothing left to pick. */
  for (const dead of ['tsYear', 'tsPer', 'tsMode']) {
    const n = store.get(dead);
    ok(`#${dead} is off — the dates come from the bar above`, !n || n.hidden === true);
  }

  /* The service split of the same day, per branch then summed — never pooled,
     or a laser-led branch gets an injectables target it cannot bill. */
  console.log('\nService targets match the dashboard exactly:');
  const Ts = require(`${pathRoot}/public/tgc-ts.js`);
  const sp = Ts.split();
  const svcTotal = Core.S(Object.values(sp.byGroup));
  ok('the service split totals the same day: 807,644',
    Math.round(svcTotal) === 807644, String(Math.round(svcTotal)));
  const wantSvc = {
    Injectables: 481068, Laser: 250833, 'Skin & Facials': 39558,
    'Body Contouring': 26843, 'Visits & Other': 9342,
  };
  for (const [g, figure] of Object.entries(wantSvc)) {
    ok(`${g} is ${figure.toLocaleString()}`, Math.round(sp.byGroup[g]) === figure,
      String(Math.round(sp.byGroup[g])));
  }
  ok('the 80% commission floor on Injectables is 384,854',
    Math.round(sp.byGroup.Injectables * 0.8) === 384854);
  const wantType = { 'DEKA Laser Hair Removal': 242525, Filler: 138106, 'Skin Booster': 86768, Biostimulators: 83658 };
  for (const [t, figure] of Object.entries(wantType)) {
    ok(`${t} is ${figure.toLocaleString()}`, Math.round(sp.byType[t]) === figure,
      String(Math.round(sp.byType[t])));
  }

  /* And with month-to-date loaded, the shortfall IS carried — the number must
     move, or the catch-up is decoration. */
  const withCu = await Tgc.period('2026-10-06', '2026-10-06');
  Core.ST.per = withCu;
  const carried = Core.S(Core.branchNames().map((n) => Core.bTarget(n)));
  ok('catch-up raises the target once the month is behind',
    withCu.catchUp ? carried > dayTotal : true,
    `${Math.round(carried)} vs ${Math.round(dayTotal)}`);

  /* ---- the weekday weighting is applied, not decorative ---- */
  console.log('\nThe weighting is doing something:');
  const flat = 30;
  const fri = Core.wWeight('2026-01-02', '2026-01-02');   // a Friday
  const tue = Core.wWeight('2026-01-06', '2026-01-06');   // a Tuesday
  ok('a Friday weighs less than a Tuesday', fri < tue, `${fri} vs ${tue}`);
  const whole = Core.wMW('2026-01');
  ok('a month of weights is near its day count', Math.abs(whole - 31) < 6, String(whole));

  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exitCode = fails ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
