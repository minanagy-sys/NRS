/**
 * Every one of the 18 test cases the policy workbook writes for itself
 * (sheet 15_Test_Cases), re-derived from src/lib/commission-rules.js.
 *
 * Pure arithmetic — no database, no server.
 *
 *   node test/commission-rules.test.js
 */

const assert = require('assert');
const C = require('../src/lib/commission-rules.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};
const eq = (label, got, want) => check(`${label.padEnd(50)} ${typeof want === 'number' ? want.toLocaleString('en-US') : want}`,
  () => assert.strictEqual(got, want));

/* The real ladder rows the two examples touch, verbatim from sheet 02. */
const TIERS = [
  { tierNo: 7, label: '2.5M – 3M', revFrom: 2500000, revTo: 3000000, recepMin: 10000, recepMax: 15000, seniorMin: 5000, seniorMax: 8000, girlMin: 2500, girlMax: 3500 },
  { tierNo: 8, label: '3M – 3.5M', revFrom: 3000000, revTo: 3500000, recepMin: 12000, recepMax: 18000, seniorMin: 6000, seniorMax: 10000, girlMin: 3000, girlMax: 4000 },
  { tierNo: 14, label: '6M+', revFrom: 6000000, revTo: null, recepMin: 25000, recepMax: 35000, seniorMin: 12500, seniorMax: 17000, girlMin: 6000, girlMax: 7500 },
];
const ROLES = [
  { name: 'Branch Manager', sharePct: 0.30, sortOrder: 1 },
  { name: 'Senior 1', sharePct: 0.20, sortOrder: 2 },
  { name: 'Senior 2', sharePct: 0.20, sortOrder: 3 },
  { name: 'Reception / Billing 1', sharePct: 0.15, sortOrder: 4 },
  { name: 'Reception / Billing 2', sharePct: 0.15, sortOrder: 5 },
];
const DEPTS = {
  laser: { key: 'laser', multiplier: 1.2, mixFloor: 0.3, mixCap: null },
  inj: { key: 'inj', multiplier: 1.15, mixFloor: null, mixCap: 0.5 },
  body: { key: 'body', multiplier: 1.25, mixFloor: null, mixCap: null },
  other: { key: 'other', multiplier: null, mixFloor: null, mixCap: null },
};

console.log('\nT1 — branch pool split across the 5-person team');
{
  const parts = C.splitPool(22500, ROLES);
  eq('Branch Manager', parts[0].amount, 6750);
  eq('Senior 1', parts[1].amount, 4500);
  eq('Senior 2', parts[2].amount, 4500);
  eq('Reception / Billing 1', parts[3].amount, 3375);
  eq('Reception / Billing 2', parts[4].amount, 3375);
  eq('the five parts still sum to the pool', parts.reduce((s, p) => s + p.amount, 0), 22500);
}

console.log('\nT2 — below the 80% floor is zero for everyone');
{
  const r = C.branchMonth({ net: 2_340_000, target: 3_000_000, tiers: TIERS, roles: ROLES, earnedDepartments: [DEPTS.laser] });
  eq('achievement', Math.round(r.achievement * 100), 78);
  eq('band', r.band, 'zero');
  eq('pool', r.pool, 0);
  check('every role gets zero', () => assert.ok(r.roles.every((x) => x.amount === 0)));
  check('a missed floor also kills the multiplier', () => assert.strictEqual(r.multiplier.applied, 1));
}

console.log('\nT3 — 95% achievement on the 3M–3.5M tier pays the Mid pool');
{
  const r = C.branchMonth({ net: 3_192_000, target: 3_360_000, tiers: TIERS, roles: ROLES });
  eq('band', r.band, 'mid');
  eq('tier', r.tierLabel, '3M – 3.5M');
  eq('Min pool  = 12,000+6,000+3,000', r.pools.min, 21000);
  eq('Max pool  = 18,000+10,000+4,000', r.pools.max, 32000);
  eq('Mid pool  = (min+max)/2', r.pools.mid, 26500);
  eq('pool paid', r.pool, 26500);
}

console.log('\nT4 / T5 — service multipliers stack, then hard-cap at 1.60');
{
  const two = C.serviceMultiplier([DEPTS.laser, DEPTS.body]);
  eq('Devices x Body Contouring = 1.50', two.applied, 1.5);
  eq('22,500 applied', Math.round(22500 * two.applied), 33750);
  check('two bonuses do not hit the cap', () => assert.strictEqual(two.capped, false));

  const three = C.serviceMultiplier([DEPTS.laser, DEPTS.inj, DEPTS.body]);
  eq('natural product 1.20 x 1.15 x 1.25', three.raw, 1.725);
  eq('capped to', three.applied, 1.6);
  eq('22,500 x 1.60', Math.round(22500 * three.applied), 36000);
  check('and it reports that it capped', () => assert.strictEqual(three.capped, true));
}

console.log('\nthe mix guardrails decide whether a category is earned at all');
{
  check('Devices earns at target and >= 30% of mix',
    () => assert.strictEqual(C.departmentEarned(DEPTS.laser, 100, 100, 0.31), true));
  check('Devices misses below the 30% mix floor',
    () => assert.strictEqual(C.departmentEarned(DEPTS.laser, 100, 100, 0.29), false));
  check('Injections earns under the 50% cap',
    () => assert.strictEqual(C.departmentEarned(DEPTS.inj, 100, 100, 0.49), true));
  check('Injections misses over the 50% cap — the worked example',
    () => assert.strictEqual(C.departmentEarned(DEPTS.inj, 100, 100, 0.51), false));
  check('a category short of its own target never earns',
    () => assert.strictEqual(C.departmentEarned(DEPTS.laser, 99, 100, 0.9), false));
  check('a category with no multiplier never earns',
    () => assert.strictEqual(C.departmentEarned(DEPTS.other, 999, 1, 0.9), false));
}

console.log('\nT6 / T7 — the Area Manager gate');
{
  const passing = [
    { achievement: 1.05, pool: 22500 }, { achievement: 0.95, pool: 18750 }, { achievement: 0.78, pool: 0 },
  ];
  const g = C.areaGate(passing, { rate: 0.08, minBranches: 2 });
  eq('branches at or above the floor', g.hits, 2);
  eq('combined pools', g.poolSum, 41250);
  check('gate passes', () => assert.strictEqual(g.passed, true));
  eq('AM earns 8% of 41,250', g.amount, 3300);

  const failing = [
    { achievement: 1.05, pool: 22500 }, { achievement: 0.75, pool: 0 }, { achievement: 0.70, pool: 0 },
  ];
  const f = C.areaGate(failing, { rate: 0.08, minBranches: 2 });
  eq('only one branch hit', f.hits, 1);
  check('gate fails', () => assert.strictEqual(f.passed, false));
  eq('AM earns nothing even though CFC paid its team 22,500', f.amount, 0);
}

console.log('\nT8 / T9 / T10 — the Sales Director gate has two independent limbs');
{
  const mk = (hits, groupPct) => Array.from({ length: 11 }, (_, i) => ({
    achievement: i < hits ? 0.9 : 0.5, pool: 1000,
    net: groupPct * 1_000_000, target: 1_000_000,
  }));
  const opts = { rate: 0.05, minBranches: 6, groupPct: 0.85 };

  const t8 = C.directorGate(mk(6, 0.70), opts);
  check('T8 — 6 of 11 at the floor passes on branch count', () => assert.strictEqual(t8.byCount, true));
  check('T8 — and not on the group %', () => assert.strictEqual(t8.byGroup, false));
  eq('T8 — pays 5% of all pools', t8.amount, 550);

  const t9 = C.directorGate(mk(4, 0.87), opts);
  check('T9 — 4 of 11 fails the count limb', () => assert.strictEqual(t9.byCount, false));
  check('T9 — but 87% of group target passes', () => assert.strictEqual(t9.byGroup, true));
  eq('T9 — pays 5% of all pools', t9.amount, 550);

  const t10 = C.directorGate(mk(4, 0.70), opts);
  check('T10 — both limbs fail', () => assert.strictEqual(t10.passed, false));
  eq('T10 — Director earns nothing', t10.amount, 0);
}

console.log('\nT11 / T12 — the VAT base and refunds');
{
  eq('T11 — 114,000 received, no credit notes', C.netCollection(114000, 0), 100000);
  eq('T12 — 1,000 refunded out of a 5,000 invoice', C.netCollection(5000 * 1.14, 1000), 4000);
  eq('a refund is deducted ex-VAT, not gross', C.netCollection(114000, 1000), 99000);
}

console.log('\nT13 / T14 / T15 — call centre');
{
  const RATES = [
    { bucket: 'NEW patient', bonus: 30 }, { bucket: 'Re-activated 6-12 months', bonus: 15 },
    { bucket: 'Re-activated 1-2 years', bonus: 15 }, { bucket: 'Re-activated > 2 years', bonus: 30 },
    { bucket: 'Standard rebook', bonus: 0 },
  ];
  const g = C.callCenterGross({
    'NEW patient': 10, 'Re-activated 6-12 months': 4, 'Re-activated 1-2 years': 2,
    'Re-activated > 2 years': 3, 'Standard rebook': 8,
  }, RATES);
  eq('T13 — gross 10x30 + 4x15 + 2x15 + 3x30 + 8x0', g.gross, 480);
  const s = C.callCenterSplit(g.gross, 0.75);
  eq('T13 — individual 75%', s.individual, 360);
  eq('T13 — team 25%', s.team, 120);
  eq('T13 — the split loses nothing', s.individual + s.team, 480);

  eq('T14 — a patient who never got invoiced contributes nothing',
    C.callCenterGross({ 'NEW patient': 0 }, RATES).gross, 0);
  eq('T15 — a repeat mobile is a Standard rebook, worth zero',
    C.callCenterGross({ 'Standard rebook': 1 }, RATES).gross, 0);
  eq('an unknown bucket is worth zero, never NaN',
    C.callCenterGross({ 'Made up bucket': 99 }, RATES).gross, 0);
}

console.log('\nT16 / T17 — the follow-up cap and the show-rate band');
{
  eq('T16 — 400 confirmations x 5 = 2,000, capped', C.followUpBonus(400, 5, 1500), 1500);
  eq('under the cap it pays what it earns', C.followUpBonus(100, 5, 1500), 500);

  const BANDS = [
    { label: '>= 75%', threshold: 0.75, bonus: 10000 },
    { label: '>= 85%', threshold: 0.85, bonus: 20000 },
  ];
  eq('T17 — 87% pays the top band only', C.showRateBonus(0.87, BANDS).bonus, 20000);
  eq('80% pays the lower band', C.showRateBonus(0.80, BANDS).bonus, 10000);
  eq('74% pays nothing', C.showRateBonus(0.74, BANDS).bonus, 0);
  eq('exactly 85% takes the top band', C.showRateBonus(0.85, BANDS).bonus, 20000);
}

console.log('\nband edges — no rounding, which sheet 16 q16 asks for explicitly');
{
  eq('79.9% is below the floor', C.bandOf(0.799), 'zero');
  eq('exactly 80% is Min', C.bandOf(0.80), 'min');
  eq('89.6% is still Min, NOT rounded up to Mid', C.bandOf(0.896), 'min');
  eq('exactly 90% is Mid', C.bandOf(0.90), 'mid');
  eq('99.9% is still Mid', C.bandOf(0.999), 'mid');
  eq('exactly 100% is Max', C.bandOf(1.00), 'max');
}

console.log('\nper-branch-per-month overrides, which is what Mina asked for');
{
  eq('no override falls through to the policy default', C.bandsFor({ floorPct: null }).floor, 0.8);
  eq('an override replaces just that band', C.bandsFor({ floorPct: 0.7 }).floor, 0.7);
  eq('and leaves the others alone', C.bandsFor({ floorPct: 0.7 }).mid, 0.9);
  check('a null override is not treated as zero', () => assert.notStrictEqual(C.bandsFor({ midPct: null }).mid, 0));
  check('an override is visible to the UI', () => assert.strictEqual(C.hasOverride({ floorPct: 0.7 }), true));
  check('and a clean row reports none', () => assert.strictEqual(C.hasOverride({ floorPct: null, midPct: null, maxPct: null }), false));

  /* 78% is zero under the policy, but pays Min if this branch-month is allowed a
     70% floor — the whole point of the override. */
  const r = C.branchMonth({ net: 2_340_000, target: 3_000_000, bands: { floor: 0.7 }, tiers: TIERS, roles: ROLES });
  eq('78% with a 70% floor override pays the Min pool', r.band, 'min');
}

console.log('\ntier boundaries — rev_from inclusive, rev_to exclusive');
{
  eq('2,999,999 is the 2.5M–3M tier', C.tierOf(2999999, TIERS).tierNo, 7);
  eq('exactly 3,000,000 crosses into 3M–3.5M', C.tierOf(3000000, TIERS).tierNo, 8);
  eq('3,499,999 is still 3M–3.5M', C.tierOf(3499999, TIERS).tierNo, 8);
  eq('the 6M+ tier is open-ended', C.tierOf(99_000_000, TIERS).tierNo, 14);
  check('below every tier there is no tier', () => assert.strictEqual(C.tierOf(10, TIERS), null));
  check('and no tier means no pool, not a crash', () => assert.deepStrictEqual(C.poolsOf(null), { min: 0, mid: 0, max: 0 }));
}

console.log('\nthe BLOCKER in sheet 16 question 1, pinned so nobody "fixes" it quietly');
{
  const t8 = TIERS.find((t) => t.tierNo === 8);
  eq('the ladder DATA gives the 3M–3.5M Max pool as', C.poolsOf(t8).max, 32000);
  check('which contradicts the policy prose value of 22,500', () => {
    assert.notStrictEqual(C.poolsOf(t8).max, 22500,
      'if this ever equals 22,500 the ladder data changed — re-read sheet 16 q1 before trusting it');
  });
}

console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ all 18 of the policy\'s own test cases reproduce\n');
process.exit(failures ? 1 : 0);
