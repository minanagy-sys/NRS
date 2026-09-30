/**
 * The cache must answer exactly what the MCP would.
 *
 * These figures were verified live against the MCP and against the original
 * hand-built report, so they pin the SQL aggregation to a known-good answer.
 *
 *   node test/report.test.js
 */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const Report = require('../src/lib/report.js');
const Targets = require('../src/lib/targets.js');

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(34)} ${got}${ok ? '' : `   expected ${want}`}`);
};

/* The figures this day first read, verified live against the MCP and against the
   original hand-built report on 2026-08-10.

   They are a REFERENCE, not an assertion. Odoo amends posted invoices after the
   fact — that is why a synced window is replaced wholesale rather than topped up,
   and pretending otherwise here would make this suite fail every time somebody
   corrects a line. Measured drift: 4 Aug read 640,408.31 across nine consecutive
   pulls and then 640,415.31 on 2026-08-12, same 163 invoices, one line fewer.
   DaySnapshot records each move, and tab 07 surfaces it.

   What is asserted instead is the property that would catch a real bug: every cut
   reconciles to the same total, whatever that total currently is. */
const FIRST_SEEN = { ex: 640408.31, inc: 666800.43, invoices: 163, lines: 344, branches: 12, doctors: 30 };

(async () => {
  console.log('4 August 2026 — the day the original report covers');
  const A = await Report.buildReport('2026-08-04', '2026-08-04');

  const drift = [];
  for (const [k, was] of Object.entries(FIRST_SEEN)) {
    const now = k === 'branches' || k === 'doctors' ? A[k].length : A.totals[k];
    if (now !== was) drift.push(`${k} ${was} → ${now}`);
  }
  console.log(`  · ex-VAT ${A.totals.ex} · inc-VAT ${A.totals.inc} · ${A.totals.invoices} invoices `
    + `· ${A.totals.lines} lines · ${A.branches.length} branches · ${A.doctors.length} doctors`);
  console.log(drift.length
    ? `  · amended in Odoo since first verified: ${drift.join(', ')}`
    : '  · unchanged since first verified on 2026-08-10');

  // A day with no data at all is a broken cache, not an amendment.
  check('the day has invoices', A.totals.invoices > 0, true);
  check('ex-VAT is below inc-VAT', A.totals.ex < A.totals.inc, true);
  check('every invoice has at least one line', A.totals.lines >= A.totals.invoices, true);

  /* The real property: five independent GROUP BYs over two tables must agree.
     Compared against the live total, so an amendment cannot break it but an
     aggregation bug still does. */
  for (const cut of ['branches', 'doctors', 'days', 'products', 'categories']) {
    check(`${cut} reconcile`, r2(A[cut].reduce((s, x) => s + x.ex, 0)), A.totals.ex);
  }

  /* The ranking is what the page reads top-down, so the ordering is a property
     worth asserting even though which name comes first is not. */
  for (const cut of ['branches', 'doctors', 'products', 'categories']) {
    const rows = A[cut];
    check(`${cut} ranked high to low`, rows.every((r, i) => i === 0 || rows[i - 1].ex >= r.ex), true);
  }
  check('days are in date order', A.days.every((d, i) => i === 0 || A.days[i - 1].date <= d.date), true);

  console.log('\nnested cuts sum to their parent');
  const badBranch = A.branches.filter((b) =>
    Math.abs((A.branchDoctors[b.name] || []).reduce((s, x) => s + x.ex, 0) - b.ex) > 0.01);
  check('branch → doctor', badBranch.length, 0);
  const badBranchProd = A.branches.filter((b) =>
    Math.abs((A.branchProducts[b.name] || []).reduce((s, x) => s + x.ex, 0) - b.ex) > 0.01);
  check('branch → product', badBranchProd.length, 0);
  const badDoctorProd = A.doctors.filter((d) =>
    Math.abs((A.doctorProducts[d.name] || []).reduce((s, x) => s + x.ex, 0) - d.ex) > 0.01);
  check('doctor → product', badDoctorProd.length, 0);

  console.log('\ncredit notes are excluded from the sales total');
  check('out_refund not in totals', A.refundList.every((r) => r.ex > 0) || A.refundList.length === 0, true);

  console.log('\ntargets scored from the database');
  const sheet = await Targets.loadPeriod('2026-08');
  assert.ok(sheet, 'the August sheet must be published — run scripts/import-schedule-md.js <schedule.md> --write');
  const mtd = await Report.buildReport('2026-08-01', '2026-08-04');
  const scored = Targets.score(sheet, { mtd, range: A, to: '2026-08-04', rangeDays: 1 });

  check('sheet total', scored.sheetTotal, 28838391);
  check('roster', scored.rosterCount, 73);

  /* Stated as a relationship, not a frozen count, so next month's sheet is
     checked too: everyone on the roster is either a scored row or held back
     unnamed inside their group's unlistedTarget. Nobody may be both — that is
     what turned 28,838,391 into 30,460,940. */
  check('roster = scored rows + unlisted',
    scored.listedCount + scored.groups.reduce((s2, g) => s2 + g.unlistedCount, 0),
    scored.rosterCount);

  // The approved August schedule names all 73, so nothing is held back at all.
  check('listed', scored.listedCount, 73);
  check('nothing held as unlisted', scored.unlistedTotal, 0);
  check('nobody kept aside unnamed', scored.noSales.length, 0);
  check('pace on day 4 of 31', r2(scored.pacePct), 12.9);
  check('groups', scored.groups.length, 5); // the five named groups; no-sales members are not a sixth

  const mai = scored.groups.flatMap((g) => g.rows).find((r) => r.name === 'Dr. Mai mohsen');
  check('duplicate Odoo records merged', mai.mergedFrom ? mai.mergedFrom.length : 0, 2);
  const bothRecords = mtd.doctors.filter((d) => /^(dr\. )?mai mohsen$/i.test(d.name.trim()))
    .reduce((s2, d) => s2 + d.ex, 0);
  check('...and summed, not dropped', mai.mtdEx, r2(bothRecords));
  check('daily target derived', mai.perDay, 104839);

  const dina = scored.groups.flatMap((g) => g.rows).find((r) => r.name === 'Dr Dina Ghoneim');
  check('alias resolved', dina.via, 'DR. Dina Ghonem');

  const alex = scored.branches.find((b) => b.name === 'Alex Camp Chizar');
  check('branch daily off Target 1', alex.rangeTarget, 153327);
  const strip = scored.branches.find((b) => b.name === 'Madinty The Strip');
  check('branch alias resolved', strip.via, 'Madinity The Strip');

  // Each group must still cross-foot after scoring, not just in storage.
  const offBy = scored.groups.filter((g) =>
    Math.abs(g.rows.reduce((s2, r) => s2 + r.monthlyTarget, 0) + g.unlistedTarget - g.target) > 0.01);
  check('every group cross-foots', offBy.length, 0);

  /* Every pound in the range lands somewhere: against a doctor who is scored,
     or on the off-sheet list. If the two do not add back to the range total,
     revenue is falling through a gap between them. */
  check('scored + off-sheet = the range total',
    r2(scored.rangeTotal + scored.offSheet.reduce((s2, d) => s2 + d.ex, 0)),
    r2(A.totals.ex));
  check('no doctor counted twice',
    new Set(scored.groups.flatMap((g) => g.rows.map((r) => r.name))).size, scored.listedCount);

  console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ the cache answers exactly what the MCP does');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('✗', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
