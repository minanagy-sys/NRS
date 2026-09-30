/**
 * The commission policy as it sits in the database, and the four things it must
 * let you change.
 *
 * Works on a throwaway branch and month of its own where it needs to write, and
 * removes them afterwards, so it can assert against the real imported policy
 * without putting a single real figure at risk.
 *
 *   node test/commission.test.js
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const C = require('../src/lib/commission.js');
const R = require('../src/lib/commission-rules.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};
/* Compare EXACTLY, and only round for display. Rounding before comparing is how
   `floor 0.8` prints as "1" and quietly passes for 0.9 too — an assertion that
   cannot fail is worse than no assertion. Money is compared to the piastre. */
const show = (v) => (typeof v !== 'number' ? String(v)
  : Number.isInteger(v) ? v.toLocaleString('en-US')
    : Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v));
const eq = async (label, got, want) => check(
  `${label.padEnd(52)} ${show(want)}`,
  () => {
    if (typeof want === 'number' && !Number.isInteger(want)) {
      assert.ok(Math.abs(got - want) < 1e-9, `expected ${want}, got ${got}`);
    } else {
      assert.strictEqual(got, want);
    }
  });

const TEST_BRANCH = '~~commission test branch~~';
const cleanup = async () => {
  await prisma.commissionBranch.deleteMany({ where: { name: TEST_BRANCH } });
};

(async () => {
  await cleanup();

  console.log('\nthe workbook, as imported');
  const g = await C.targetGrid(2026);
  await eq('branches', g.branches.length, 11);
  await eq('branch-months', g.branches.reduce((s, b) => s + b.months.filter((m) => m.target !== null).length, 0), 132);
  await eq('2026 target total', g.grandTotal, 245449932);
  await eq('annual total from sheet 04', g.annualTotal, 245449732);
  await eq('Nouvel Age branches', g.entities.find((e) => e.entity === 'Nouvel Age').branches, 9);
  await eq('ZAT branches', g.entities.find((e) => e.entity === 'ZAT').branches, 2);
  await eq('areas', Object.keys(g.areas).length, 4);
  await eq('August, all 11 branches', g.monthTotals[7], 23622679);
  await eq('departments', g.departments.length, 5);

  /* The workbook disagrees with itself here and the resolution is Finance's, so
     the gap is carried and surfaced rather than reconciled away. If this ever
     goes to zero somebody has silently "corrected" the source. */
  await check('CampShizar still carries its +200 annual gap', () => {
    const b = g.branches.find((x) => x.name === 'CampShizar');
    assert.strictEqual(Math.round(b.annualGap), 200, 'sheet 16 q9 — do not reconcile this away without Finance');
  });
  await check('and it is the only branch with a gap', () => {
    assert.deepStrictEqual(g.branches.filter((b) => b.annualGap).map((b) => b.name), ['CampShizar']);
  });

  console.log('\nthe policy constants');
  const p = await C.loadPolicy();
  await eq('floor', p.bands.floor, 0.8);
  await eq('mid', p.bands.mid, 0.9);
  await eq('max', p.bands.max, 1);
  await eq('multiplier cap', p.multiplierCap, 1.6);
  await eq('VAT divisor', p.vatDivisor, 1.14);

  const tiers = await C.loadTiers();
  await eq('ladder tiers', tiers.length, 14);
  await check('the top tier is open-ended', () => assert.strictEqual(tiers[13].revTo, null));
  await eq('the 3M-3.5M Max pool is the DATA value, not the prose one',
    R.poolsOf(tiers.find((t) => t.tierNo === 8)).max, 32000);

  const roles = await C.loadRoles();
  await eq('roles', roles.length, 5);
  await eq('their shares sum to', roles.reduce((s, r) => s + Number(r.sharePct), 0), 1);

  const cc = await C.loadCallCenter();
  await eq('call centre buckets', cc.rates.length, 5);
  await eq('call centre people', cc.members.length, 13);
  await eq('show-rate bands', cc.showBands.length, 2);
  const notes = await C.loadNotes();
  await eq('the workbook\'s own test cases', notes.tests.length, 18);
  await eq('its open questions', notes.questions.length, 17);
  await eq('of which BLOCKERs still open', notes.openBlockers, 3);

  console.log('\nscoring a month against real actuals');
  const rows = await prisma.invoice.groupBy({
    by: ['branchName'],
    where: { invoiceDate: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T00:00:00Z') } },
    _sum: { amountUntaxed: true }, _count: true,
  });
  const actuals = rows.map((r) => ({ name: r.branchName || 'Unassigned', ex: Number(r._sum.amountUntaxed || 0), invoices: r._count }));
  const v = await C.monthView(2026, 8, actuals, { dayNo: 31, daysInPeriod: 31 });

  /* Every policy branch has to reach Odoo through an alias or by name. An
     unmatched branch scores zero and would silently drag the group down. */
  await eq('policy branches with no Odoo match', v.unmatched.length, 0);
  await eq('August target', v.targetTotal, 23622679);
  await check('the target total equals the grid for the same month',
    () => assert.strictEqual(Math.round(v.targetTotal), Math.round(g.monthTotals[7])));
  await check('a closed month is not treated as partial', () => assert.strictEqual(v.partial, false));
  await check('so the gates run on the real figures', () => assert.strictEqual(v.gateBasis, 'actual'));
  await eq('areas evaluated', v.areas.length, 4);
  await check('every branch carries a band and a tone', () =>
    assert.ok(v.branches.every((b) => b.band && b.tone)));
  await check('nothing below the floor is paid a pool', () =>
    assert.ok(v.branches.filter((b) => b.band === 'zero').every((b) => b.pool === 0)));
  await check('every pool sits inside its own tier min..max', () =>
    assert.ok(v.branches.every((b) => b.pool === 0 || (b.pool >= b.pools.min && b.pool <= b.pools.max))));
  await check('the role split of every pool adds back to the pool', () =>
    assert.ok(v.branches.every((b) => Math.abs(b.roles.reduce((s, r) => s + r.amount, 0) - b.pool) < 0.05)));

  console.log('\nan open month is projected, and consistently');
  const mid = await C.monthView(2026, 8, actuals, { dayNo: 10, daysInPeriod: 31 });
  await check('it reports itself partial', () => assert.strictEqual(mid.partial, true));
  await check('gates move to the projected basis', () => assert.strictEqual(mid.gateBasis, 'projected'));
  await check('every branch carries a projection', () => assert.ok(mid.branches.every((b) => b.projected)));
  await check('the projected band matches the projected pool', () => {
    for (const b of mid.branches) {
      const expected = b.projected.band === 'zero' ? 0 : b.projected.pools[b.projected.band];
      assert.strictEqual(b.projected.pool, expected, `${b.name}: band ${b.projected.band} but pool ${b.projected.pool}`);
    }
  });
  await check('a pro-rata target is smaller than the monthly one', () =>
    assert.ok(mid.branches.every((b) => b.proRataTarget < b.target)));

  console.log('\nthe four things that have to be editable');
  const cfc = await prisma.commissionBranch.findFirst({ where: { name: 'CFC' } });
  const before = await prisma.commissionTarget.findUnique({
    where: { branchId_year_month: { branchId: cfc.id, year: 2026, month: 8 } },
  });

  await check('1 — the target itself', async () => {
    await prisma.commissionTarget.update({ where: { id: before.id }, data: { target: '9999999.00' } });
    const after = await C.targetGrid(2026);
    assert.strictEqual(after.branches.find((b) => b.name === 'CFC').months[7].target, 9999999);
    await prisma.commissionTarget.update({ where: { id: before.id }, data: { target: before.target } });
  });

  await check('2 — the 80 or the 90, on one branch in one month', async () => {
    await prisma.commissionTarget.update({ where: { id: before.id }, data: { floorPct: 0.7 } });
    const one = await C.monthView(2026, 8, actuals, { dayNo: 31, daysInPeriod: 31 });
    const row = one.branches.find((b) => b.name === 'CFC');
    assert.strictEqual(row.bands.floor, 0.7, 'the override did not reach the scoring');
    assert.strictEqual(row.override, true, 'the override is not flagged for the UI');
    const others = one.branches.filter((b) => b.name !== 'CFC');
    assert.ok(others.every((b) => b.bands.floor === 0.8), 'the override leaked to another branch');
    await prisma.commissionTarget.update({ where: { id: before.id }, data: { floorPct: null } });
    const back = await C.monthView(2026, 8, actuals, { dayNo: 31, daysInPeriod: 31 });
    assert.strictEqual(back.branches.find((b) => b.name === 'CFC').bands.floor, 0.8, 'clearing the override did not restore the policy');
  });

  await check('3 — a branch, its area and its owning entity', async () => {
    const created = await prisma.commissionBranch.create({
      data: { name: TEST_BRANCH, area: 'Cairo', entity: 'ZAT', annualTarget: '1200000.00', sortOrder: 99 },
    });
    let grid = await C.targetGrid(2026);
    assert.strictEqual(grid.branches.length, 12, 'a new branch did not appear');
    assert.strictEqual(grid.entities.find((e) => e.entity === 'ZAT').branches, 3);
    await prisma.commissionBranch.update({ where: { id: created.id }, data: { entity: 'Nouvel Age' } });
    grid = await C.targetGrid(2026);
    assert.strictEqual(grid.entities.find((e) => e.entity === 'ZAT').branches, 2, 'the entity change did not take');
    /* Retiring must not delete: the cascade would take its whole target history. */
    await prisma.commissionTarget.create({ data: { branchId: created.id, year: 2026, month: 1, target: '100000.00' } });
    await prisma.commissionBranch.update({ where: { id: created.id }, data: { active: false } });
    const scored = await C.monthView(2026, 1, [], { dayNo: 31, daysInPeriod: 31 });
    assert.ok(!scored.branches.some((b) => b.name === TEST_BRANCH), 'a retired branch is still being scored');
    assert.strictEqual(await prisma.commissionTarget.count({ where: { branchId: created.id } }), 1,
      'retiring a branch destroyed its target history');
    await prisma.commissionBranch.delete({ where: { id: created.id } });
  });

  await check('4 — a department and its multiplier', async () => {
    const dep = await prisma.commissionDepartment.findUnique({ where: { key: 'laser' } });
    await prisma.commissionDepartment.update({ where: { id: dep.id }, data: { multiplier: 1.4 } });
    const grid = await C.targetGrid(2026);
    assert.strictEqual(grid.departments.find((d) => d.key === 'laser').multiplier, 1.4);
    await prisma.commissionDepartment.update({ where: { id: dep.id }, data: { multiplier: dep.multiplier } });
  });

  console.log('\nnothing was left behind');
  await cleanup();
  const left = await prisma.commissionBranch.count({ where: { name: TEST_BRANCH } });
  const overrides = await prisma.commissionTarget.count({
    where: { OR: [{ floorPct: { not: null } }, { midPct: { not: null } }, { maxPct: { not: null } }] },
  });
  const total = await prisma.commissionTarget.aggregate({ _sum: { target: true }, where: { year: 2026 } });
  await eq('the test branch is gone', left, 0);
  await eq('no band overrides left set', overrides, 0);
  await eq('the 2026 total is untouched', Number(total._sum.target), 245449932);

  console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ the commission policy reads back exactly as imported, and stays editable\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n✗ ${e.stack || e.message}\n`);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
