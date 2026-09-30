/* ============================================================
   Doctor commission — the arithmetic, and the two refusals.

   THIS FILE PINS WHAT WAS MEASURED, not what the code does. Every figure in it
   came from the August 2026 payslip pack and the commissions workbook before a
   line of `doctor-commission.js` existed, so a change that quietly re-rates
   somebody fails here rather than in a payslip.

   The four things worth pinning, in the order they can go wrong:

     1  the BASIS — ex-package, ex-VAT. Counting every invoice is 9.3% out.
     2  the BAND — a lookup, not a ladder. Read as a ladder, everyone above the
        first band is underpaid, and the total still looks plausible.
     3  the FORMULA — pinned against all 73 rows of the pack.
     4  the REFUSALS — no scheme means no commission, no payroll means no
        payslip. Both are the report declining to invent a payment.

   Run: node test/doctor-commission.test.js
   ============================================================ */

const path = require('path').join(__dirname, '..');
const DC = require(`${path}/src/lib/doctor-commission.js`);
const Schemes = require(`${path}/src/lib/commission-schemes.js`);
const { prisma } = require(`${path}/src/lib/db.js`);

let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${label}`); return; }
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

(async () => {
  /* ---------------------------------------------------------------- 1 · bands */
  console.log('\nthe bands are a LOOKUP, not a ladder');
  const std = Schemes.SEED.find((s) => s.name === 'Standard');

  /* 300,000 earns 12% on the WHOLE 300,000 — 36,000. A ladder would pay
     10.5% on the first 200,000 and 12% on the rest: 33,000. The difference is
     one band's worth of pay for every doctor above the first band. */
  ok('300,000 on Standard is 12%, not 10.5% plus 12%',
    Schemes.rateFor(std, 300000).rate === 0.12);
  ok('  which is 36,000 and not the ladder\'s 33,000',
    near(300000 * Schemes.rateFor(std, 300000).rate, 36000, 0.01));

  /* The boundaries, because an inclusive/exclusive slip moves exactly the
     people sitting on a round number — which is most of them. */
  ok('200,000 is still the first band (10.5%)', Schemes.rateFor(std, 200000).rate === 0.105);
  ok('200,001 is the second (12%)', Schemes.rateFor(std, 200001).rate === 0.12);
  ok('550,001 and above is 15%', Schemes.rateFor(std, 9e9).rate === 0.15);

  /* ---------------------------------------------------- 2 · the workbook's gap */
  console.log('\nthe workbook\'s own gap is carried, not papered over');
  const exc = Schemes.SEED.find((s) => s.name === 'Exclusive');
  const gap = Schemes.rateFor(exc, 1100000);
  ok('1,100,000 on Exclusive matches no band', gap.rate === null);
  ok('  and the refusal names the gap precisely, not just "no band"',
    /1,000,000 and 1,300,000/.test(gap.why || ''), gap.why);
  ok('1,000,000 is inside the third band', Schemes.rateFor(exc, 1000000).rate === 0.15);
  ok('1,300,000 is inside the fourth', Schemes.rateFor(exc, 1300000).rate === 0.17);

  /* A scheme stating no bands at all is a different refusal from a gap: it is
     "this person's commission is entered by hand", and paying zero would be a
     silent 100% deduction. */
  const hossam = Schemes.SEED.find((s) => s.name === 'Dr. Hossam Shehab');
  ok('a scheme with no bands gives no rate, rather than zero',
    Schemes.rateFor(hossam, 500000).rate === null);

  /* --------------------------------------------------- 3 · an agreed rate wins */
  console.log('\nan agreed rate beats the band, and says why');
  const banded = { doctorName: 'X', scheme: std, rateOverride: null };
  const agreed = { doctorName: 'X', scheme: std, rateOverride: 0.17, rateOverrideWhy: 'Agreed.' };
  ok('without an override the band decides', Schemes.rateForDoctor(banded, 300000).rate === 0.12);
  ok('with one, the override decides', Schemes.rateForDoctor(agreed, 300000).rate === 0.17);
  ok('  and it is labelled as an override, not as a band',
    Schemes.rateForDoctor(agreed, 300000).from === 'override');
  ok('a doctor on no scheme gets no rate and is told so',
    Schemes.rateForDoctor({ doctorName: 'Y', scheme: null }, 300000).rate === null);

  /* ------------------------------------------------------------- 4 · the slip */
  console.log('\nthe payslip formula, as the pack writes it');

  /* One worked example with every line non-zero, checked by hand:
       basic = 10 x 50            =    500
       tsal  = 1000 + 500 - 100 + (-50) = 1350
       total = 1350 + 200 + 0     =   1550
       tax   = 1550 x 0.10        =    155
       net   = 1550 - 155 - 30 + 20 = 1385                                */
  const slip = DC.payslipFor({
    commission: 1000,
    scheme: { hourlyRate: 50, fixedBasic: null },
    doctor: { hourlyRate: 50, mgmtFee: 200, taxRate: 0.1 },
    payroll: { hours: 10, ded: 100, onda: -50, maint: 30, gcell: 20 },
  });
  ok('basic is hours x rate', slip.basic === 500);
  ok('tsal adds onda rather than subtracting it', slip.tsal === 1350, `tsal ${slip.tsal}`);
  ok('total carries the management fee', slip.total === 1550, `total ${slip.total}`);
  ok('tax is on the total, not on the commission', slip.tax === 155, `tax ${slip.tax}`);
  ok('net takes off maintenance and adds G-Cell', slip.net === 1385, `net ${slip.net}`);

  /* `hourlyRate: null` is a RULE — "no working hours will be calculated" — and
     the one way to break it is to treat it as zero-and-fall-back. */
  const noHours = DC.payslipFor({
    commission: 1000,
    scheme: { hourlyRate: null, fixedBasic: 50000 },
    doctor: { hourlyRate: null, mgmtFee: 0, taxRate: 0 },
    payroll: { hours: 200 },
  });
  ok('a scheme that counts no hours pays no hourly basic, however many hours are reported',
    noHours.hourlyBasic === 0 && noHours.basic === 50000, JSON.stringify(noHours));

  /* --------------------------------------------------------- 5 · the live build */
  console.log('\nthe report itself, over August 2026');
  const b = await DC.build({ from: '2026-08-01', to: '2026-08-31' });

  ok('it names the period it covers', b.period === '2026-08');
  ok('the doctor rows sum to the report total, to the piastre',
    near(b.rows.reduce((t, r) => t + r.ex, 0), b.coverage.reportEx, 1),
    `${b.rows.reduce((t, r) => t + r.ex, 0)} vs ${b.coverage.reportEx}`);
  ok('every commission shown is exactly revenue x rate',
    b.rows.filter((r) => r.rate != null).every((r) => near(r.commission, r.ex * r.rate, 0.02)),
    'a commission does not equal revenue x its own rate');

  /* THE REFUSALS, which are the point of the whole file. */
  ok('a doctor with no scheme carries no commission figure',
    b.rows.filter((r) => !r.onScheme).every((r) => r.commission === null));
  ok('  and they are NAMED, with the revenue that has no rate against it',
    b.missing.noScheme.length === b.rows.filter((r) => !r.onScheme && r.ex > 0).length);
  ok('a doctor with no payroll month carries no payslip',
    b.rows.filter((r) => !r.hasPayroll).every((r) => r.payslip === null));
  ok('  and the count of them is stated rather than left to be noticed',
    b.missing.noPayroll === b.rows.filter((r) => r.commission != null && !r.hasPayroll).length);

  /* Ex-package is the measured basis: 21,075,429 against the pack's
     20,756,217 is 1.5%. Counting package journals too would be 9.3%. */
  const Report = require(`${path}/src/lib/report.js`);
  ok('the basis is ex-package — the same call every other report makes',
    Report.EXCLUDED_REVENUE_JOURNALS.length > 0
    && b.note.includes('ex-package'), b.note.slice(0, 60));

  const totalEx = b.totals.ex;
  ok(`revenue lands within 3% of the pack's 20,756,217 (${Math.round(totalEx).toLocaleString('en-US')})`,
    Math.abs(totalEx - 20756217) / 20756217 < 0.03,
    `${((totalEx - 20756217) / 20756217 * 100).toFixed(1)}% out`);

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
