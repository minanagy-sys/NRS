#!/usr/bin/env node
/* Set each branch's annual target to the sum of its twelve monthly cells.
 *
 *   node scripts/sync-annual-targets.js              # dry run, prints both columns
 *   node scripts/sync-annual-targets.js --write
 *   node scripts/sync-annual-targets.js --year 2027 --write
 *
 * WHY THIS EXISTS. `CommissionTarget` holds a figure per branch per month;
 * `CommissionBranch.annualTarget` holds one figure for the year. Nothing kept
 * them in step. Importing the revised Q4 2026 plan moved 33 monthly cells and
 * left every annual where it was, so all eleven branches ended up disagreeing
 * with themselves by 2,275,917 in total — which shows on the Admin grid as a
 * gap on every row and reads as a fault.
 *
 * IT RETIRES A GUARD, DELIBERATELY. `test/commission.test.js` carried
 * CampShizar's +200 annual gap with the note "sheet 16 q9 — do not reconcile
 * this away without Finance". This reconciles exactly that. Mina took the
 * decision on 2026-10-04: the annual has behaved as a roll-up of the months
 * everywhere else, and eleven branches disagreeing with themselves is worse
 * than one 200 EGP curiosity. The test now pins the gap at ZERO rather than
 * losing the check — if the two ever drift again the suite says so.
 *
 * IT PRINTS BOTH COLUMNS BEFORE IT WRITES. The annual is a figure somebody
 * agreed, and replacing it with a derived one should never happen unseen.
 */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const { prisma } = require('../src/lib/db.js');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const YEAR = (() => {
  const i = args.indexOf('--year');
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 2026;
})();

const f = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

(async () => {
  console.log(`\n${WRITE ? 'WRITING' : 'DRY RUN — nothing is saved'} · ${YEAR}\n`);

  const [branches, cells] = await Promise.all([
    prisma.commissionBranch.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.commissionTarget.groupBy({
      by: ['branchId'], where: { year: YEAR }, _sum: { target: true }, _count: true,
    }),
  ]);
  const sumBy = new Map(cells.map((c) => [c.branchId, { sum: Number(c._sum.target || 0), months: c._count }]));

  console.log('branch                  months      monthly sum        annual now             gap');
  const changes = [];
  let gapTotal = 0;
  for (const b of branches) {
    const got = sumBy.get(b.id);
    if (!got) {
      console.log(`  ${b.name.padEnd(22)}${'—'.padStart(5)}${'no cells for this year'.padStart(40)}`);
      continue;
    }
    const annual = Number(b.annualTarget || 0);
    const gap = got.sum - annual;
    gapTotal += gap;
    console.log(`  ${b.name.padEnd(22)}${String(got.months).padStart(5)}${f(got.sum).padStart(17)}`
      + `${f(annual).padStart(18)}${(gap ? f(gap) : '—').padStart(16)}`);
    /* A branch whose months do not cover the year is NOT rolled forward: a
       partial year summed into an annual target would quietly halve it. */
    if (got.months < 12) {
      console.log(`  ${''.padEnd(22)}     ↳ only ${got.months} of 12 months — left alone`);
      continue;
    }
    if (Math.abs(gap) < 0.005) continue;
    changes.push({ id: b.id, name: b.name, from: annual, to: got.sum });
  }

  console.log(`\n  ${changes.length} branch(es) would change · total gap ${f(gapTotal)}`);

  if (!WRITE) {
    console.log('\n  Nothing was saved. Re-run with --write.\n');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(changes.map((c) => prisma.commissionBranch.update({
    where: { id: c.id }, data: { annualTarget: c.to },
  })));

  /* Read it back rather than trusting the write — the whole point of the script
     is that these two figures agree, so proving it is one query. */
  const after = await prisma.commissionBranch.findMany({ orderBy: { sortOrder: 'asc' } });
  const still = [];
  for (const b of after) {
    const got = sumBy.get(b.id);
    if (!got || got.months < 12) continue;
    if (Math.abs(got.sum - Number(b.annualTarget || 0)) >= 0.005) still.push(b.name);
  }
  console.log(`\n  ${changes.length} written. Branches still disagreeing: ${still.length ? still.join(', ') : 'none'}\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('\n✗', e.message, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
