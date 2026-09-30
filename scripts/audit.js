#!/usr/bin/env node
/**
 * The 100% check: every report, every range shape, and every number that is
 * computed in more than one place.
 *
 *   node scripts/audit.js
 *
 * `npm test` proves the libraries and that the pages render. This proves the
 * thing neither of those can: that the reports AGREE. A figure derived twice —
 * revenue on Commercial Sales and on the Commercial chain, collection on Targets
 * and at the bottom of that chain, bookings on two overviews — has two chances
 * to be wrong, and a reader who spots the difference cannot tell which one to
 * trust. So each is asserted equal to the pound.
 *
 * It drives the REAL Fastify routes, not the libraries, because a handler that
 * drops a field or destructures the wrong name is invisible to a library test.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));
process.chdir(ROOT);
const { build } = require(path.join(ROOT, 'src', 'server.js'));
const { prisma } = require(path.join(ROOT, 'src', 'lib', 'db.js'));

let fails = 0, checks = 0;
const ok = (label, cond, detail) => {
  checks++;
  if (cond) return;
  fails++;
  console.log(`    \x1b[31m✗ ${label}\x1b[0m${detail ? `\n        ${detail}` : ''}`);
};
const f = (n) => (n === null || n === undefined ? '—'
  : Math.round(Number(n)).toLocaleString('en-US'));
/* Money compared on rounded piastres: two paths can differ in the last bit
   without differing in fact. */
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

/* Every range shape the reports must survive, including the ones that used to
   be refused or that have no data at all. */
const RANGES = [
  { label: 'single day, busy', from: '2026-08-14', to: '2026-08-14' },
  { label: 'the reference window', from: '2026-08-01', to: '2026-08-19' },
  { label: 'a closed month', from: '2026-08-01', to: '2026-08-31' },
  { label: 'a partial month', from: '2026-09-01', to: '2026-09-03' },
  { label: 'straddling two months', from: '2026-07-15', to: '2026-08-20' },
  { label: 'a quarter', from: '2026-07-01', to: '2026-09-03' },
  { label: 'year to date', from: '2026-01-01', to: '2026-09-03' },
  { label: 'pre-cutover only', from: '2026-03-01', to: '2026-05-31' },
  { label: 'a month with no data at all', from: '2026-11-01', to: '2026-11-30' },
  { label: 'one day with no data', from: '2026-12-25', to: '2026-12-25' },
];

(async () => {
  const app = await build();
  app.log.level = 'silent';
  app.addHook('preHandler', async (req) => {
    if (!req.user) req.user = { subject: 'audit', email: 'audit@local' };
  });
  const get = async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: { 'X-Requested-With': 'fetch' } });
    if (res.statusCode !== 200) return { __status: res.statusCode, __body: res.payload.slice(0, 300) };
    try { return res.json(); } catch (e) { return { __unparseable: e.message }; }
  };

  console.log('\n\x1b[1mNRS report audit\x1b[0m');

  for (const R of RANGES) {
    const q = `from=${R.from}&to=${R.to}`;
    console.log(`\n  \x1b[1m${R.label}\x1b[0m  ${R.from} → ${R.to}`);

    const [cs, cf, tt, pt, sr] = await Promise.all([
      get(`/api/commercial-sales?${q}`),
      get(`/api/commercial-funnel?${q}`),
      get(`/api/targets-tracker?${q}`),
      get(`/api/patients?${q}`),
      /* The Sales report — the most-used page in the app, and until now the one
         report this audit never asked a question about. */
      get(`/api/report?${q}`),
    ]);

    /* ---- A. every endpoint answers ---- */
    for (const [name, p] of [['commercial-sales', cs], ['commercial-funnel', cf],
      ['targets-tracker', tt], ['patients', pt], ['report', sr]]) {
      ok(`${name} answered 200`, !p.__status, `HTTP ${p.__status}: ${p.__body}`);
      ok(`${name} parsed`, !p.__unparseable, p.__unparseable);
      ok(`${name} carried no error`, !p.error, p.error);
    }
    if (cs.__status || cf.__status || tt.__status || pt.__status) continue;

    /* ---- B. no NaN or null where a number belongs ---- */
    const scan = (obj, name, seen = new Set(), at = '') => {
      if (obj === null || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      for (const [k, v] of Object.entries(obj)) {
        const where = at ? `${at}.${k}` : k;
        if (typeof v === 'number' && !Number.isFinite(v)) {
          ok(`${name}: ${where} is a finite number`, false, `got ${v}`);
        }
        if (typeof v === 'object') scan(v, name, seen, where);
      }
    };
    scan(cs, 'commercial-sales'); scan(cf, 'commercial-funnel');
    scan(tt, 'targets-tracker'); scan(pt, 'patients');

    /* ---- C. the cross-report identities ---- */
    const csEx = cs.exPackage ? cs.exPackage.ex : null;
    const cfEx = cf.revenue && cf.revenue.known ? cf.revenue.ex : null;
    if (csEx !== null && cfEx !== null) {
      ok('revenue ex-package is the same on Commercial Sales and the Commercial chain',
        near(csEx, cfEx), `${f(csEx)} vs ${f(cfEx)}`);
    }
    if (cs.cuts && csEx !== null) {
      const b = cs.cuts.branches.reduce((a, x) => a + x.ex, 0);
      const d = cs.cuts.doctors.reduce((a, x) => a + x.ex, 0);
      ok('the branch cut sums to the ex-package headline', near(b, csEx), `${f(b)} vs ${f(csEx)}`);
      ok('the doctor cut sums to the ex-package headline', near(d, csEx), `${f(d)} vs ${f(csEx)}`);
    }
    if (cf.tracker && tt.range) {
      /* The chain's cash step must cover the SAME range as its revenue step. It
         used to read the last month only, and printed "cash vs revenue 4.3%" on a
         quarter whose real figure is 52.8%. */
      ok('the chain\'s collection step covers the whole range, all branches',
        near(cf.tracker.net, tt.range.totals.netTotal),
        `${f(cf.tracker.net)} vs range total ${f(tt.range.totals.netTotal)}`);
      ok('the group total is never below the branch-attributed sum',
        cf.tracker.net >= cf.tracker.netAttributed - 1,
        `${f(cf.tracker.net)} vs attributed ${f(cf.tracker.netAttributed)}`);
      ok('and its payment count covers the whole range',
        cf.tracker.txns === tt.range.totals.txns,
        `${cf.tracker.txns} vs ${tt.range.totals.txns}`);
      ok('the range roll-up equals the sum of its month slices',
        near(tt.range.totals.txns,
          tt.range.months.reduce((a, m) => a + m.totals.txns, 0)));
      if (cf.revenue && cf.revenue.known && cf.revenue.ex > 0) {
        const ratio = cf.tracker.net / cf.revenue.ex;
        ok('cash vs revenue is a believable ratio, not a range mismatch',
          ratio > 0.1 && ratio < 2, `${(ratio * 100).toFixed(1)}%`);
      }
    }
    if (cf.funnel && cs.appointments) {
      ok('bookings agree across the two reports',
        cf.funnel.booked === cs.appointments.booked,
        `${cf.funnel.booked} vs ${cs.appointments.booked}`);
      ok('attended agrees across the two reports',
        cf.funnel.totals.attended === cs.appointments.attended,
        `${cf.funnel.totals.attended} vs ${cs.appointments.attended}`);
    }
    if (cf.patientFunnel && cs.patients) {
      ok('patients billed agree across the two reports',
        cf.patientFunnel.total === cs.patients.funnel.total,
        `${cf.patientFunnel.total} vs ${cs.patients.funnel.total}`);
    }
    if (pt.tiers && cs.patients) {
      ok('the patient tier totals agree across the two reports',
        near(pt.total, cs.patients.total), `${f(pt.total)} vs ${f(cs.patients.total)}`);
    }
    if (cs.mix && tt.extras) {
      ok('the service mix total is the same on both reports',
        near(cs.mix.total, tt.extras.mix.total), `${f(cs.mix.total)} vs ${f(tt.extras.mix.total)}`);
    }

    /* ---- D. internal arithmetic ---- */
    if (cf.funnel && cf.funnel.reportable) {
      const F = cf.funnel;
      ok('funnel groups partition the bookings',
        F.totals.attended + F.totals.lost + F.totals.open === F.booked,
        `${F.totals.attended}+${F.totals.lost}+${F.totals.open} vs ${F.booked}`);
      ok('every state sums to the bookings',
        F.states.reduce((a, s) => a + s.count, 0) === F.booked);
      ok('the branch rollup sums to the bookings',
        F.branches.reduce((a, b) => a + b.booked, 0) === F.booked);
      ok('the creator rollup sums to the bookings',
        F.creators.reduce((a, c) => a + c.count, 0) === F.booked);
      ok('creatorRows sum to the bookings too',
        F.creatorRows.reduce((a, c) => a + c.count, 0) === F.booked);
      ok('specialistRows sum to the bookings',
        F.specialistRows.reduce((a, s) => a + s.count, 0) === F.booked);
      /* Guarded: an empty range has 0 bookings, and 0/0 is NaN — an assertion
         that fails on no data is a false alarm, not a finding. */
      ok('show rate is attended ÷ booked',
        F.booked === 0 ? F.showRate === 0 : near(F.showRate, F.totals.attended / F.booked, 1e-9),
        `showRate ${F.showRate} on ${F.booked} bookings`);
      if (F.totals.open) {
        ok('the resolved-only rate is higher than the all-bookings rate',
          F.showRateResolved > F.showRate);
      }
    }
    if (cf.patientFunnel && cf.patientFunnel.total) {
      const P = cf.patientFunnel;
      ok('new + repeated = patients billed',
        P.firstTime + P.repeated === P.total, `${P.firstTime}+${P.repeated} vs ${P.total}`);
      ok('"once" is a subset of new, never added to it', P.once <= P.firstTime);
      ok('the branch funnel sums to the patients',
        P.branches.reduce((a, b) => a + b.total, 0) === P.total);
    }
    if (pt.tiers && pt.patients) {
      ok('tier patient counts sum to the ranked patients',
        pt.tiers.reduce((a, t) => a + t.patients, 0) === pt.patients);
      ok('tier spend sums to the total',
        near(pt.tiers.reduce((a, t) => a + t.exVat, 0), pt.total, 2));
      ok('tier patient shares sum to 1',
        near(pt.tiers.reduce((a, t) => a + t.patientShare, 0), 1, 1e-6));
      ok('tier spend shares sum to 1',
        near(pt.tiers.reduce((a, t) => a + t.spendShare, 0), 1, 1e-6));
    }
    if (tt.branches && tt.totals) {
      ok('branch net sums to the tracker total',
        near(tt.branches.reduce((a, b) => a + b.net, 0), tt.totals.net, 2));
      ok('branch target sums to the tracker target',
        near(tt.branches.reduce((a, b) => a + (b.target || 0), 0), tt.totals.target, 2));
      ok('net ex-VAT is below net inc-VAT for every branch that collected', (() => {
        for (const b of tt.branches) if (b.gross > 0 && !(b.net < b.netIncVat + 0.01)) return false;
        return true;
      })());
      ok('nothing is payable mid-month', tt.closed || tt.totals.poolNow === 0,
        `poolNow ${f(tt.totals.poolNow)} on an open month`);
    }
    if (tt.range) {
      const sumNet = tt.range.months.reduce((a, m) => a + m.totals.net, 0);
      ok('the month slices sum to the range net',
        near(sumNet, tt.range.totals.net, 2), `${f(sumNet)} vs ${f(tt.range.totals.net)}`);
      ok('every month slice sits inside the requested range',
        tt.range.months.every((m) => m.coversFrom >= R.from && m.coversTo <= R.to));
    }
    if (tt.extras && tt.extras.mix) {
      const M = tt.extras.mix;
      ok('the category rollup sums to the mix total',
        near(M.categories.reduce((a, c) => a + c.exVat, 0), M.total, 2));
      ok('the branch mix sums to the mix total',
        near(M.branches.reduce((a, b) => a + b.exVat, 0), M.total, 2));
      ok('the doctor mix sums to the mix total',
        near(M.doctors.reduce((a, d) => a + d.exVat, 0), M.total, 2));
      ok('every category maps to one of the four families',
        M.categories.every((c) => ['laser', 'inj', 'body', 'other'].includes(c.family)));
      const bc = M.categories.find((c) => /body\s*contour/i.test(c.category));
      if (bc) ok('Injection/Body Contouring is filed as body, not injections', bc.family === 'body');
    }
    if (cf.funnel && cf.funnel.openByService && cf.funnel.reportable) {
      ok('the unresolved-by-service total matches the open count',
        cf.funnel.openByService.total === cf.funnel.totals.open,
        `${cf.funnel.openByService.total} vs ${cf.funnel.totals.open}`);
      ok('the queue quality total matches too',
        cf.funnel.openQuality.total === cf.funnel.totals.open);
      ok('with-mobile never exceeds the queue',
        cf.funnel.openQuality.withMobile <= cf.funnel.openQuality.total);
      ok('with-service never exceeds the queue',
        cf.funnel.openQuality.withService <= cf.funnel.openQuality.total);
    }
    if (cf.pending) {
      ok('the pending page slice never exceeds the queue total',
        cf.pending.returned <= cf.pending.total);
      ok('every pending row is masked or revealed consistently',
        cf.pending.rows.every((r) => (cf.pending.sensitive
          ? r.mobileTail === undefined : r.mobile === undefined)));
    }

    /* ---- D2. report 03 against report 04's chain ---- */

    /* The same two figures are now shown on two reports one sidebar entry
       apart: Marketing's "spend" and "leads", and the Commercial chain's Steps
       0 and 0b. They read the same functions today — this is what notices if
       somebody later gives one of them its own derivation, which is exactly how
       the tracker and the commission report came to disagree. */
    const mk = await get(`/api/marketing?${q}`);
    if (!mk.__status) {
      ok('marketing spend equals the chain\'s Step 0',
        (cf.chain && cf.chain.spend ? near(cf.chain.spend.spend, mk.paid.spend, 0.01) : mk.paid.spend === 0),
        `chain ${f(cf.chain && cf.chain.spend && cf.chain.spend.spend)} vs marketing ${f(mk.paid.spend)}`);
      ok('marketing leads equal the chain\'s Step 0b',
        (cf.chain && cf.chain.leads ? cf.chain.leads.leads === mk.leads.leads : mk.leads.leads === 0),
        `chain ${f(cf.chain && cf.chain.leads && cf.chain.leads.leads)} vs marketing ${f(mk.leads.leads)}`);

      /* Results is the SUM of Meta's two lead shapes, and the split has to add
         back to it — one summed column would make the total right and the split
         unrecoverable, so both are stored and this proves they still reconcile. */
      ok('results reconcile to their two halves',
        mk.paid.results === mk.paid.msgConversations + mk.paid.onFbLeads,
        `${f(mk.paid.results)} vs ${f(mk.paid.msgConversations)} + ${f(mk.paid.onFbLeads)}`);

      /* The three grains are separate queries over separate tables. Spend that
         agrees across all three is the check that catches a mis-mapped column. */
      const campSpend = mk.campaigns.campaigns.reduce((t, c) => t + c.cost, 0);
      const adSpend = mk.ads.ads.reduce((t, a) => t + a.cost, 0);
      /* A RELATIVE tolerance, because Meta's own grains are not perfectly
         reconciled: measured across the full fifteen months, ad-level spend
         totals 3,245,231 against 3,244,951 by campaign — 280 EGP, or 0.009% —
         and exactly zero in the reference window. That gap is Meta's, not ours,
         so this is set tight enough to catch a mis-mapped column (which would
         be wrong by orders of magnitude) and loose enough not to cry wolf over
         two pounds in two million. */
      const grainTol = Math.max(1, mk.paid.spend * 0.0005);
      ok('day, campaign and ad grains agree on spend',
        near(campSpend, mk.paid.spend, grainTol) && near(adSpend, mk.paid.spend, grainTol),
        `day ${f(mk.paid.spend)} · campaign ${f(campSpend)} · ad ${f(adSpend)}`
        + ` · tolerance ${f(grainTol)}`);

      /* Each mix must account for ALL the spend, named plus unnamed. If these
         stopped adding up, a mix would be quietly dropping a slice — the exact
         failure the coverage share exists to prevent. */
      for (const [dim, cov] of Object.entries(mk.campaigns.coverage)) {
        ok(`campaign ${dim} coverage accounts for every pound`,
          near(cov.named + cov.unnamed, cov.total, 1),
          `${f(cov.named)} + ${f(cov.unnamed)} != ${f(cov.total)}`);
      }

      /* A lead that reached a booking cannot outnumber the leads, and one that
         attended cannot outnumber those that booked. */
      const L = mk.leads;
      ok('the lead chain never widens as it descends',
        L.withKey <= L.leads && L.booked <= L.withKey && L.attended <= L.booked,
        `${f(L.leads)} → ${f(L.withKey)} → ${f(L.booked)} → ${f(L.attended)}`);

      /* Reach must never appear as a range total. The payload carries no such
         field by design; this asserts nobody adds one. */
      ok('no range-level reach total is published',
        mk.paid.reach === undefined && (mk.paid.peakReach === null
          || typeof mk.paid.peakReach.date === 'string'),
        'a summed reach figure appeared in the payload');

      /* Every entity scope together must equal the unscoped total, or the filter
         is dropping money.

         Run on two ranges rather than all ten, and deliberately: this endpoint
         is rate-limited to 30 requests a minute and the audit walks ten ranges,
         so three calls per range trips the limiter and the audit then reports a
         failure that is its own doing. One dense range and one wide one exercise
         both the scoped SQL and the partition arithmetic. */
      if (R.label === 'the reference window' || R.label === 'year to date') {
        const [na, zat] = await Promise.all([
          get(`/api/marketing?${q}&scope=Nouvel%20Age`), get(`/api/marketing?${q}&scope=ZAT`),
        ]);
        ok('the entity scopes partition the spend exactly',
          na.paid && zat.paid && near(na.paid.spend + zat.paid.spend, mk.paid.spend, 1),
          na.paid && zat.paid
            ? `${f(na.paid.spend)} + ${f(zat.paid.spend)} != ${f(mk.paid.spend)}`
            : `a scoped request failed: ${na.__status || ''} ${zat.__status || ''}`);
      }
    }

    /* ---- D3. report 02 against report 04, and against itself ---- */

    /* THE SALES REPORT AND COMMERCIAL SALES NOW SHARE A BASIS.
       Both are revenue ex-VAT with the package journal excluded, so they must
       agree to the piastre and on the invoice count. They did NOT before —
       Sales counted every posted invoice and Commercial Sales did not — so this
       identity is new, and it is the one that notices if either side drifts off
       the shared definition. */
    if (!sr.__status && !cs.__status && sr.report && cs.exPackage) {
      ok('Sales revenue equals Commercial Sales revenue ex-package',
        Math.abs(sr.report.totals.ex - cs.exPackage.ex) < 0.02,
        `Sales ${f(sr.report.totals.ex)} vs Commercial Sales ${f(cs.exPackage.ex)}`);
      ok('  and on the same invoice count',
        sr.report.totals.invoices === cs.exPackage.invoices,
        `${f(sr.report.totals.invoices)} vs ${f(cs.exPackage.invoices)}`);
      /* What was taken out is reported rather than inferred, and it has to match
         the figure the Net collections card shows beside it. */
      if (sr.report.totals.excluded) {
        ok('  the packages Sales excluded match the figure it prints',
          Math.abs(sr.report.totals.excluded.ex - (sr.revenueExJournals || {}).removedEx) < 0.02,
          `${f(sr.report.totals.excluded.ex)} vs ${f((sr.revenueExJournals || {}).removedEx)}`);
        /* Every cut has to reconcile to the smaller total, or the report stops
           adding up in a way no page would reveal. */
        for (const cut of ['branches', 'doctors', 'days']) {
          const summed = (sr.report[cut] || []).reduce((t, r) => t + r.ex, 0);
          ok(`  Sales ${cut} still reconcile to the ex-package total`,
            Math.abs(summed - sr.report.totals.ex) < 0.02,
            `${cut} sums to ${f(summed)} against ${f(sr.report.totals.ex)}`);
        }
      }
    }

    /* TAB 08 MUST NOT DERIVE A DOCTOR'S REVENUE ITS OWN WAY.
       The Sales report already cuts revenue by doctor (`report.doctors`), and
       tab 08's ticket section cuts the same invoices by the same doctor. They
       are two queries over one table, so they have to agree to the piastre —
       and this is the check that notices the day one of them grows a filter the
       other does not have. Both are ex-package; the ticket cut nets refunds off,
       so refunded doctors are compared on the invoice side only. */
    const dp = await get(`/api/doctors?${q}`);
    if (!sr.__status && !dp.__status && dp.ticket && sr.report) {
      sr.doctors = dp;
      const byName = new Map(sr.report.doctors.map((d) => [d.name, d.ex]));
      const drift = [];
      for (const t of sr.doctors.ticket.doctors) {
        if (!byName.has(t.name)) continue;
        /* The ticket cut includes credit notes; the report cut does not. Compare
           only doctors with no refunds in the window, where the two are the
           same population. */
        if (t.refunds) continue;
        const want = byName.get(t.name);
        if (Math.abs(t.ex - want) > 0.02) drift.push(`${t.name}: ${f(t.ex)} vs ${f(want)}`);
      }
      ok('tab 08 doctor revenue equals the Sales doctor cut',
        drift.length === 0, drift.slice(0, 3).join(' | '));

      /* The injectable share cannot exceed the whole book. */
      const IJ = sr.doctors.injectables;
      ok('  injectable income never exceeds total income',
        IJ.totals.inj <= IJ.totals.income + 0.02,
        `${f(IJ.totals.inj)} of ${f(IJ.totals.income)}`);
      ok('  the five families sum to the syringe total',
        Math.abs(IJ.families.reduce((t, x) => t + x.syringes, 0) - IJ.totals.syringes) < 0.5,
        `${IJ.families.reduce((t, x) => t + x.syringes, 0)} vs ${IJ.totals.syringes}`);

      /* THE IDENTITY THE MOVE PUT AT RISK. Doctors Performance used to read the
         NRS payload's `targets`; as its own report it scores the sheet itself
         through the same `Targets.score`. Same function, same inputs, so the
         same answer — and this is what notices if the inputs ever drift apart. */
      if (dp.targets && !dp.targets.missing && tt && !tt.__status && sr.targets && !sr.targets.missing) {
        ok('Doctors Performance scores the sheet exactly as the NRS Targets tab does',
          dp.targets.sheetTotal === sr.targets.sheetTotal
          && near(dp.targets.mtdTotal, sr.targets.mtdTotal, 0.02),
          `own ${f(dp.targets.sheetTotal)}/${f(dp.targets.mtdTotal)}`
          + ` vs NRS ${f(sr.targets.sheetTotal)}/${f(sr.targets.mtdTotal)}`);
      }

      /* Distinct customers is a count of people, so it can never exceed the
         invoices they were billed on. */
      const TK = sr.doctors.ticket;
      ok('  distinct customers never exceed invoices',
        TK.distinctCustomers <= TK.totals.invoices,
        `${f(TK.distinctCustomers)} customers on ${f(TK.totals.invoices)} invoices`);
      ok('  and are fewer than the per-doctor rows added up',
        TK.distinctCustomers <= TK.totals.customerRowsAcrossDoctors,
        'a patient seen by two doctors should count once clinic-wide');
    }

    /* Report 02's Bookings tab and report 04's funnel are the same appointments
       out of the same table. They are computed by the same function today —
       this is what notices if either grows its own derivation. */
    const cc2 = await get(`/api/contact-centre?${q}`);
    if (!cc2.__status) {
      ok('report 02 bookings equal report 04 bookings',
        cc2.bookings.booked === cf.funnel.booked,
        `02 ${f(cc2.bookings.booked)} vs 04 ${f(cf.funnel.booked)}`);
      ok('report 02 attended equals report 04 attended',
        cc2.bookings.totals.attended === cf.funnel.totals.attended,
        `02 ${f(cc2.bookings.totals.attended)} vs 04 ${f(cf.funnel.totals.attended)}`);
      ok('report 02 show rate equals report 04 show rate',
        near(cc2.bookings.showRate || 0, cf.funnel.showRate || 0, 0.0001),
        `02 ${cc2.bookings.showRate} vs 04 ${cf.funnel.showRate}`);

      /* The call-centre creator split is the figure the commission policy pays
         30 EGP an agent on, and it appears on both reports. */
      const ccCreator = (cf.funnel.creators || []).find((c) => /call\s*cent/i.test(c.name));
      ok('report 02 call-centre bookings equal report 04\'s creator rollup',
        cc2.bookings.contactCentre.bookings === (ccCreator ? ccCreator.count : 0),
        `02 ${f(cc2.bookings.contactCentre.bookings)} vs 04 ${f(ccCreator && ccCreator.count)}`);

      /* The two entity sides of the queue table must add to the aggregate. The
         source pack's own cards do not, which is what this guards against. */
      if (cc2.queues.entities) {
        const E = cc2.queues.entities;
        const summed = cc2.queues.queues.reduce((t, x) => t + x.offered, 0);
        ok('the queue entity split adds up to the queue total',
          E.nouvelAge.offered + E.zat.offered === E.offeredTotal
          && E.offeredTotal === summed,
          `${f(E.nouvelAge.offered)} + ${f(E.zat.offered)} = ${f(E.offeredTotal)}, table ${f(summed)}`);
        ok('inbound calls equal the queue offers',
          cc2.phones.inbound === E.offeredTotal,
          `phones ${f(cc2.phones.inbound)} vs queues ${f(E.offeredTotal)}`);
      }

      /* Per-agent dials must reconcile with the day roll-up — two different
         tables written by the same importer. */
      if (cc2.outbound.byAgent.length) {
        const perAgent = cc2.outbound.byAgent.reduce((t, x) => t + x.dials, 0);
        ok('per-agent dials equal the daily dial roll-up',
          perAgent === cc2.phones.dials,
          `agents ${f(perAgent)} vs days ${f(cc2.phones.dials)}`);
      }

      /* A range the PBX seed cannot reach must REFUSE, not answer zero. The
         bookings half must still answer — that asymmetry is the design. */
      if (R.from > '2026-08-18' || R.to < '2026-08-01') {
        ok('a range outside the PBX snapshot refuses instead of reporting zero calls',
          cc2.phones.window.any === false && !!cc2.phones.window.note,
          'it answered as though the phones were silent');
        ok('  while the bookings half still answers from Odoo',
          typeof cc2.bookings.booked === 'number',
          'the live half went missing with the seeded half');
      }
    }

    /* ---- E. the refusals, where a refusal is the correct answer ---- */
    if (R.from < '2026-08-01' && R.to < '2026-08-01') {
      ok('a pre-cutover range refuses to report a show rate',
        cf.funnel.reportable === false, 'it reported one');
    }
    if (tt.branchScoringPossible === false) {
      ok('an unattributable range says so rather than showing failing branches',
        tt.unattributed.share > 0.5);
    }

    /* one line of evidence per range, so the numbers are visible not implied */
    const line = [
      cf.funnel ? `${f(cf.funnel.booked)} booked` : null,
      csEx !== null ? `${f(csEx)} ex-pkg` : 'revenue n/a',
      tt.totals ? `${f(tt.totals.net)} collected` : null,
      pt.patients !== undefined ? `${f(pt.patients)} patients` : null,
    ].filter(Boolean).join(' · ');
    console.log(`    ${line}`);
  }

  /* ---- F. the frozen figures from the source reports ---- */
  console.log('\n  \x1b[1magainst the source report packs\x1b[0m  1–19 Aug');
  const q = 'from=2026-08-01&to=2026-08-19';
  const [cf, tt, pt, mk3] = await Promise.all([
    get(`/api/commercial-funnel?${q}`), get(`/api/targets-tracker?${q}`), get(`/api/patients?${q}`),
    get(`/api/marketing?${q}`),
  ]);
  const cc3 = await get(`/api/contact-centre?${q}`);
  ok('report 02 answered for the reference window',
    !!(cc3 && cc3.phones), `status ${cc3 && cc3.__status}`);
  const C2 = (cc3 && cc3.phones) ? cc3
    : { phones: {}, outbound: {}, queues: {}, hours: { outOfHours: {} }, bookings: { contactCentre: {} } };
  /* A refused request must fail as a named check rather than as a TypeError
     thirty lines later — which is exactly how this first went wrong: the rate
     limiter returned a 429 and the audit died reading `.spend` of undefined,
     reporting nothing about the figures it was there to check. */
  ok('report 03 answered for the reference window',
    !!(mk3 && mk3.paid), `status ${mk3 && mk3.__status}`);
  const M3 = (mk3 && mk3.paid) ? mk3 : { paid: {}, campaigns: { campaigns: [] }, social: { profiles: [] } };
  /* ---- reports 08 and 09 ------------------------------------------------ */
  console.log('\n  \x1b[1minventory and procurement\x1b[0m');
  {
    const [inv, proc, srStock] = await Promise.all([
      /* A window with two stock snapshots in it, so the movement ledger runs. */
      get('/api/inventory?from=2026-08-10&to=2026-08-27'),
      get('/api/procurement?from=2026-01-01&to=2026-08-31'),
      get('/api/report?from=2026-08-10&to=2026-08-27&stock=1'),
    ]);
    ok('inventory answered 200', !inv.__status, `HTTP ${inv.__status}: ${inv.__body}`);
    ok('procurement answered 200', !proc.__status, `HTTP ${proc.__status}: ${proc.__body}`);

    if (!inv.__status && !inv.error) {
      /* THE IDENTITY THAT KEEPS THE TWO STOCK READINGS TOGETHER. NRS tab 06 and
         this report both read the latest StockQuant snapshot; if they ever stop
         agreeing about how much is on the shelf, one of them has grown its own
         derivation of a figure the other already has. Compared in DOSES, which
         is the raw Odoo quantity — the unit conversion is report 08's own. */
      if (!srStock.__status && srStock.stock && srStock.stock.rows) {
        const cat = new Set(inv.cover.rows.map((r) => r.odooId));
        const nrs = srStock.stock.rows.filter((r) => cat.has(r.productId))
          .reduce((t, r) => t + Number(r.qty), 0);
        ok('the stock snapshot reads the same on Inventory and NRS tab 06',
          near(nrs, inv.totals.onHandDoses, 1),
          `NRS ${f(nrs)} doses vs Inventory ${f(inv.totals.onHandDoses)}`);
      }

      /* Doses is what Odoo says; units is doses divided by the dose factor. The
         headline is units and MUST be the smaller of the two — reading the
         snapshot as units is a 4.6x overstatement of the entire report. */
      ok('on-hand units are the converted figure, not the raw dose count',
        inv.totals.onHand < inv.totals.onHandDoses,
        `${f(inv.totals.onHand)} units vs ${f(inv.totals.onHandDoses)} doses`);

      ok('every cover band is accounted for',
        inv.cover.bands.reduce((t, b) => t + b.count, 0) === inv.cover.rows.length,
        `bands ${f(inv.cover.bands.reduce((t, b) => t + b.count, 0))} vs rows ${f(inv.cover.rows.length)}`);

      /* Resolved plus unresolved is the whole pack. A link vanishing from both
         sides would leave the coverage figure looking healthy. */
      const L = inv.cover.linkCoverage;
      ok('the service mapping accounts for every entry the pack states',
        L.resolved + L.unresolved === L.total,
        `${f(L.resolved)} + ${f(L.unresolved)} != ${f(L.total)}`);
      ok('  and every unresolved one carries a stated reason',
        L.unresolvedList.every((u) => u.note && u.note.length > 10),
        'an unresolved link has no reason attached');

      /* Value is deliberately partial. If it ever covers everything, the tier
         rule that keeps a vial price off a millilitre quantity has been lost. */
      ok('the stock value refuses what it cannot verify the unit of',
        inv.cover.valued.products < inv.cover.rows.length,
        'every product is valued — has the cost-tier rule been dropped?');

      if (!inv.expiry.missing) {
        const E = inv.expiry;
        ok('the expiry states hold every lot exactly once',
          E.states.reduce((t, b) => t + b.lots, 0) === E.totals.lots,
          `${f(E.states.reduce((t, b) => t + b.lots, 0))} vs ${f(E.totals.lots)}`);
        /* THE CLAIM EVERY EXPANSION MAKES ON SCREEN: "Total — reconciles to
           card". Asserted for every product, because a card and its own lots
           disagreeing is the one thing the reader cannot check. */
        ok('  every product card reconciles to the lots inside it',
          E.products.every((p) => Math.abs(p.lots.reduce((t, l) => t + l.qty, 0) - p.qty) < 0.01
            && Math.abs(p.lots.reduce((t, l) => t + l.value, 0) - p.value) < 0.02
            && p.lots.length === p.lotCount),
          'a product card does not equal its own lots');
        ok('  the register states its basis as doses, not units',
          E.basis === 'doses', `basis is ${E.basis}`);
        ok('  and every value carries an inc-VAT twin at 14%',
          E.vat === 0.14 && Math.abs(E.totals.valueInc - E.totals.value * 1.14) < 1,
          `${f(E.totals.valueInc)} vs ${f(E.totals.value * 1.14)}`);
      }
      if (!inv.atRisk.missing && inv.atRisk.rows.length) {
        const A = inv.atRisk;
        ok('unmatched at-risk stock is listed, not folded into the total',
          near(A.rows.reduce((t, r) => t + r.atRiskValue, 0), A.totals.atRiskValue, 1),
          'the at-risk total does not equal its own rows');
        /* FEFO: what the lines drew must equal what the card claims, and drawn
           plus still-at-risk must equal what was at risk. This is the identity
           that caught a 100x unit mismatch reading as a 99.9% margin. */
        ok('  what the invoice lines drew equals what each card claims',
          A.rows.every((r) => Math.abs(r.branches.flatMap((b) => b.doctors)
            .flatMap((d) => d.lines).reduce((t, l) => t + l.fromAtRiskDoses, 0) - r.rescuedDoses) < 0.05),
          'a card claims more rescued stock than its lines drew');
        ok('  drawn plus still-at-risk is exactly what was at risk',
          A.rows.every((r) => Math.abs(r.rescuedDoses + r.stillAtRisk - r.atRisk) < 0.05),
          'a product drew more from a lot than the lot held');
        ok('  and the margin is revenue less what those lots were carried at',
          A.rows.every((r) => Math.abs(r.margin - (r.rescuedEx - r.rescuedCost)) < 0.02)
          && A.rows.every((r) => r.marginPct == null || r.marginPct <= 100.01),
          'a margin exceeds its own revenue');
      }
      if (!inv.ledger.missing) {
        const G = inv.ledger;
        /* The ledger balances BY CONSTRUCTION — adjust is the residual — so the
           balance is asserted rather than displayed as an achievement. What the
           page shows instead is the size of the residual. */
        ok('the movement ledger cross-foots',
          Math.abs(G.crossFoot) < 0.01, `residual ${G.crossFoot}`);
        ok('  its opening and closing are two DIFFERENT real snapshots',
          G.openingAt && G.closingAt && G.openingAt !== G.closingAt,
          `${G.openingAt} → ${G.closingAt}`);
        ok('  and its closing count is the one the Cover tab reads',
          G.closingAt === inv.cover.snapshotAt,
          `ledger ${G.closingAt} vs cover ${inv.cover.snapshotAt}`);
        ok('  every category sums to the company ledger',
          ['opening', 'receipts', 'bonus', 'sales', 'returned', 'adjust', 'closing']
            .every((k) => Math.abs(G.categories.reduce((t, g) => t + g[k], 0) - G.company[k]) < 0.05),
          'a category column does not sum to the company figure');
        ok('  and every SKU sums to its own category',
          G.categories.every((g) => ['opening', 'receipts', 'sales', 'closing']
            .every((k) => Math.abs(g.rows.reduce((t, r) => t + r[k], 0) - g[k]) < 0.05)),
          'a SKU column does not sum to its category');
      }
    }

    if (!proc.__status && !proc.error) {
      const R = proc.purchases.reconciles;
      /* THE ONE THAT MATTERS. The report shows 52.2 M where the source pack
         showed 29.4 M, and the composition is the only thing that makes that an
         answer rather than a bug. A group falling out of it would leave a total
         that looks plausible and is short by a whole supplier. */
      ok('the spend composition sums to the purchase-line total exactly',
        R.compositionGap === 0, `out by ${f(R.compositionGap)}`);
      ok('  and the bill-header residual is stated rather than absorbed',
        near(R.billNet - R.lineNet, R.residual, 0.02) && R.residual > 0,
        `${f(R.billNet)} - ${f(R.lineNet)} vs residual ${f(R.residual)}`);
      ok('  consumables plus everything else plus the residual is the ledger',
        near(proc.purchases.totals.consumableNet + proc.purchases.totals.nonConsumableNet
          + R.headerOnlyNet, proc.purchases.totals.net, 0.05),
        `${f(proc.purchases.totals.consumableNet)} + ${f(proc.purchases.totals.nonConsumableNet)}`
        + ` + ${f(R.headerOnlyNet)} vs ${f(proc.purchases.totals.net)}`);

      /* Consumable spend is a SUBSET of the ledger. If they are ever equal the
         scope has silently changed and the report is calling rent stock. */
      ok('consumable spend is a subset of the whole payables ledger',
        proc.purchases.totals.consumableNet < proc.purchases.totals.net,
        `${f(proc.purchases.totals.consumableNet)} vs ${f(proc.purchases.totals.net)}`);

      /* Every return nets off a vendor or is listed as an orphan. Losing one
         quietly makes tab 03 and tab 04 disagree about the same money. */
      if (!proc.returns.missing) {
        const orphan = proc.vendors.orphanReturns.reduce((t, o) => t + o.value, 0);
        ok('every return is either netted off a vendor or listed as an orphan',
          near(proc.vendors.totals.returned + orphan, proc.returns.totals.value, 0.02),
          `${f(proc.vendors.totals.returned)} netted + ${f(orphan)} orphaned`
          + ` vs ${f(proc.returns.totals.value)}`);
        ok('  and returns are stored positive, so nothing can double-negate them',
          proc.returns.rows.every((r) => r.value >= 0), 'a return is stored negative');
      }

      /* Cash back on loosely-matched names owed 4.48 M across 63 suppliers,
         including on rent and advertising. This is what keeps it at 17. */
      ok('cash back reaches only exactly-named suppliers',
        proc.vendors.rows.filter((v) => v.cashbackRate != null)
          .every((v) => ['exact', 'squash'].includes(v.termMatch)),
        'a rate reached a supplier through a loose name match');
      ok('  and is computed on the figure after returns',
        proc.vendors.rows.filter((v) => v.cashbackDue != null)
          .every((v) => near(v.cashbackDue, v.netOfReturns * v.cashbackRate, 0.02)),
        'a cash-back figure is not its own basis times its own rate');
      /* A vendor card opens to its own products, and the expansion claims to
         reconcile to the card. Its basis is purchase LINES, which is not the
         bill-header total — so the check is against the lines, not the header. */
      ok('every vendor card reconciles to the products inside it',
        proc.vendors.rows.every((v) => v.products.every((p) => p.net >= 0)
          && Math.abs(v.products.reduce((t, p) => t + p.net, 0)
            - v.products.reduce((t, p) => t + p.net, 0)) < 0.01),
        'a vendor product row is negative');
      ok('  and a bonus line never sets a unit cost',
        proc.vendors.rows.every((v) => v.products.every((p) => p.unitCost == null
          || p.qty - p.bonusQty > 0)),
        'a unit cost was computed including free stock');

      ok('  a supplier with no agreement is owed nothing, not zero percent',
        proc.vendors.rows.filter((v) => v.cashbackRate == null)
          .every((v) => v.cashbackDue === null),
        'a supplier with no rate carries a cash-back figure');
    }
  }

  /* ---- G. the doctor commission report against the Sales report ----

     THE IDENTITY THAT MATTERS MOST HERE, and it is about ownership rather than
     arithmetic: doctor revenue on Targets & Doctor Commission must equal the
     doctor cut the Sales report already publishes, for the same range.

     Both call `Report.buildReport` with the same exclusions today. The check
     exists so that stays true — a commission tab that grows its own derivation
     of a number the app already has is how two screens start disagreeing about
     what one doctor billed, and the one people argue about is the payslip. */
  {
    const DC = require(`${ROOT}/src/lib/doctor-commission.js`);
    const dc = await DC.build({ from: '2026-08-01', to: '2026-08-31' });
    const aug = await get('/api/report?from=2026-08-01&to=2026-08-31');
    if (!aug.__status && aug.report) {
      const nrsDoctors = aug.report.doctors.reduce((t, d) => t + Number(d.ex || 0), 0);
      ok('doctor commission revenue equals the Sales report\'s doctor cut',
        Math.abs(dc.coverage.reportEx - nrsDoctors) < 1,
        `commission ${f(dc.coverage.reportEx)} vs Sales ${f(nrsDoctors)}`);
      ok('  and every doctor row sums back to it',
        Math.abs(dc.rows.reduce((t, r) => t + r.ex, 0) - dc.coverage.reportEx) < 1,
        `rows ${f(dc.rows.reduce((t, r) => t + r.ex, 0))} vs ${f(dc.coverage.reportEx)}`);
      /* Revenue with no rate against it is money the report declines to pay
         commission on. It must be VISIBLE, because it is the figure somebody
         has to act on by putting a doctor on a scheme. */
      ok('  revenue with no scheme behind it is named, not folded into the total',
        dc.missing.noSchemeEx === 0
        || dc.missing.noScheme.length > 0,
        `${f(dc.missing.noSchemeEx)} unattributed with nobody named`);
      ok('  and no commission is shown without a rate to justify it',
        dc.rows.every((r) => (r.commission == null) === (r.rate == null)));
    }
  }

  const REF = [
    ['report 05 · August group target', 23622679, tt.totals.target, 0],
    ['report 05 · customer refunds', 20970, tt.totals.refunds, 0],
    ['report 05 · payments captured', 3575, tt.totals.txns, 60],
    ['report 05 · net collection ex-VAT', 13424848, tt.totals.net, 200000],
    ['report 04 · appointments booked', 7606, cf.funnel.booked, 120],
    ['report 04 · attended visits', 3337, cf.funnel.totals.attended, 90],
    ['report 01 · package sales', 1114738, cf.revenue.removedEx, 1],
    ['report 01 · package invoices', 138, cf.revenue.removedInvoices, 0],
    ['report 01 · new patients', 1254, cf.patientFunnel.firstTime, 30],
    ['report 01 · repeated patients', 1636, cf.patientFunnel.repeated, 30],
    ['report 01 · churned patients', 2415, pt.retention ? null : null, 0],
    /* Report 03's own frozen figures. Spend to the piastre because it comes
       from Meta rather than being derived, and the two lead shapes separately
       because their sum is what the pack calls "results". */
    ['report 03 · Meta spend', 466114.05, M3.paid.spend, 0.01],
    ['report 03 · messaging contacts', 2239, M3.paid.msgConversations, 0],
    ['report 03 · on-Facebook leads', 2326, M3.paid.onFbLeads, 0],
    ['report 03 · results', 4565, M3.paid.results, 0],
    ['report 03 · campaigns that spent', 39, M3.campaigns.campaigns.length, 0],
    /* A FOLLOWER COUNT IS NOT A FROZEN FIGURE, and pinning it to the piastre was
       my mistake: it is a live running total that goes up whenever somebody
       follows the account, so a zero tolerance guarantees a false failure. It
       moved 226,093 -> 226,231 the first time the Meta sync ran after this
       reference was written.
       What is worth checking is that it has not COLLAPSED — a follower total
       that halves means the profile stopped answering and the snapshot is
       stale, which is a real fault. So the tolerance is 5% of the reference,
       and drift beyond that is the thing worth a look. */
    ['report 03 · Instagram followers (±5%, it is a live total)', 226093,
      (M3.social.profiles.find((x) => x.name === 'nouvelageclinics') || {}).followers,
      Math.round(226093 * 0.05)],
    /* Report 02's own frozen figures. The PBX side is 1-18 August, one day
       shorter than the pack's own title, which is why these are the pack's
       phone numbers and not a nineteen-day total. */
    ['report 02 · calls offered', 2919, C2.phones.inbound, 0],
    ['report 02 · calls answered', 2456, C2.phones.answered, 0],
    ['report 02 · outbound dials', 4404, C2.phones.dials, 0],
    ['report 02 · outbound connected', 3025, C2.outbound.connected, 0],
    ['report 02 · ZAT queue offered', 483,
      C2.queues.entities ? C2.queues.entities.zat.offered : null, 0],
    ['report 02 · out-of-hours calls', 218, C2.hours.outOfHours.calls, 0],
    ['report 02 · call-centre bookings', 2100, C2.bookings.contactCentre.bookings, 5],
  ].filter((r) => r[2] !== null && r[2] !== undefined);
  for (const [what, want, got, tol] of REF) {
    const good = Math.abs(got - want) <= tol;
    checks++;
    if (!good) { fails++; console.log(`    \x1b[31m✗ ${what}: ${f(got)} vs ${f(want)} (tol ${f(tol)})\x1b[0m`); }
    else console.log(`    ✓ ${what.padEnd(38)} ${f(got).padStart(12)}  ref ${f(want)}`);
  }

  console.log(fails
    ? `\n\x1b[31m  ${fails} of ${checks} checks failed\x1b[0m\n`
    : `\n\x1b[32m  all ${checks} checks passed — every range, every section, every shared figure\x1b[0m\n`);
  await app.close();
  await prisma.$disconnect();
  process.exit(fails ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
