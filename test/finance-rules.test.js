/**
 * The finance rules. Every constant in here was measured off the source report,
 * so these tests pin the boundaries rather than restating the code.
 *
 * The full-scale check — all 625 expiry rows and all 57 product pairs of the real
 * data — lives in scripts/import-finance-html.js, which refuses to write if the
 * rules stop reproducing the source. That keeps the check on the real data
 * permanently instead of freezing a fixture here.
 *
 *   node test/finance-rules.test.js
 */

const assert = require('assert');
const F = require('../src/lib/finance-rules.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const verdict = (o) => F.expiryVerdict(o).verdict;

/* ---- expiry verdicts ---- */

check('an expired lot is expired even in a warehouse', () => {
  // 12 of the source's 22 expired rows are warehouse rows, so the expiry test
  // has to come before the warehouse test.
  assert.strictEqual(verdict({ qty: 100, daysLeft: -89, rate: null, isWarehouse: true }), 'expired');
  assert.strictEqual(verdict({ qty: 100, daysLeft: -1, rate: 50, isWarehouse: false }), 'expired');
  assert.strictEqual(F.expiryVerdict({ qty: 100, daysLeft: -89, rate: null, isWarehouse: true }).atRiskQty, 100,
    'the whole lot is at risk once it has expired');
});

check('warehouse stock gets no forecast rather than a fabricated one', () => {
  const out = F.expiryVerdict({ qty: 24, daysLeft: 688, rate: null, isWarehouse: true });
  assert.strictEqual(out.verdict, 'wh_unknown');
  assert.strictEqual(out.atRiskQty, 0);
  assert.strictEqual(out.cover, null, 'no rate means no cover figure, not a zero one');
});

check('zero issuance is only called waste inside a year', () => {
  assert.strictEqual(verdict({ qty: 5, daysLeft: 355, rate: 0, isWarehouse: false }), 'no_move');
  assert.strictEqual(verdict({ qty: 5, daysLeft: 365, rate: 0, isWarehouse: false }), 'no_move', 'the boundary is inclusive');
  assert.strictEqual(verdict({ qty: 5, daysLeft: 366, rate: 0, isWarehouse: false }), 'watch');
  // A ten-day blank says nothing about a lot expiring in four years, so it is
  // parked rather than counted as loss — 265,028 EGP of the source's stock.
  assert.strictEqual(F.expiryVerdict({ qty: 5, daysLeft: 1543, rate: 0, isWarehouse: false }).atRiskQty, 0);
  assert.strictEqual(F.expiryVerdict({ qty: 5, daysLeft: 355, rate: 0, isWarehouse: false }).atRiskQty, 5);
});

check('enough runway is safe, and carries no at-risk value', () => {
  const out = F.expiryVerdict({ qty: 94.5, daysLeft: 690, rate: 14.4664, isWarehouse: false });
  assert.strictEqual(out.verdict, 'safe');
  assert.strictEqual(out.atRiskQty, 0);
  assert.ok(Math.abs(out.cover - 6.5323) < 0.001, `cover ${out.cover}`);
});

check('a surplus splits into partly at risk and will-not-be-used', () => {
  // 10 units, 1/month, 60 days: 2 consumed, 8 left -> 80% at risk.
  const part = F.expiryVerdict({ qty: 10, daysLeft: 60, rate: 1, isWarehouse: false });
  assert.strictEqual(part.verdict, 'part_waste');
  assert.ok(Math.abs(part.atRiskQty - 8) < 1e-9, `at risk ${part.atRiskQty}`);

  // 1000 units, 1/month, 60 days: 998 left -> 99.8%, past the write-off line.
  assert.strictEqual(verdict({ qty: 1000, daysLeft: 60, rate: 1, isWarehouse: false }), 'all_waste');
});

check('the write-off line is exactly 99% of the lot', () => {
  // Measured in the source: all-waste at 0.9933 and 0.9903, highest partial 0.9875.
  const at = (ratio) => {
    // choose rate so that (qty - rate*2) / qty === ratio  for daysLeft = 60
    const qty = 1000;
    return verdict({ qty, daysLeft: 60, rate: (qty * (1 - ratio)) / 2, isWarehouse: false });
  };
  assert.strictEqual(at(0.99), 'all_waste', 'exactly 99% is a write-off');
  assert.strictEqual(at(0.9875), 'part_waste');
  assert.strictEqual(at(0.9933), 'all_waste');
});

check('the month is a flat 30 days, not 30.4 or 365/12', () => {
  /* 10 units at 1/month with 300 days left consumes exactly 10 on a 30-day
     month and leaves nothing — the source agrees on every one of its 625 rows.
     A 30.4-day month would leave 0.13 units and call this partly at risk. */
  const out = F.expiryVerdict({ qty: 10, daysLeft: 300, rate: 1, isWarehouse: false });
  assert.strictEqual(out.verdict, 'safe');
  assert.strictEqual(out.atRiskQty, 0);
  assert.strictEqual(F.MONTH_DAYS, 30);
});

check('buckets land on their boundaries', () => {
  const b = F.bucketOf;
  assert.deepStrictEqual([b(-1), b(0), b(30), b(31), b(60), b(61), b(90), b(91), b(180), b(181)],
    ['expired', 'd30', 'd30', 'd60', 'd60', 'd90', 'd90', 'd180', 'd180', 'safe']);
  assert.strictEqual(F.BUCKETS.length, 6);
});

check('days to expiry is signed and calendar-based', () => {
  const asOf = new Date('2026-08-11T00:00:00Z');
  assert.strictEqual(F.daysToExpiry(new Date('2026-08-11T00:00:00Z'), asOf), 0);
  assert.strictEqual(F.daysToExpiry(new Date('2026-09-01T00:00:00Z'), asOf), 21);
  assert.strictEqual(F.daysToExpiry(new Date('2026-05-14T00:00:00Z'), asOf), -89, 'expired reads negative');
});

check('thin movement is fewer than three net units', () => {
  assert.strictEqual(F.isThinMovement(2.9), true);
  assert.strictEqual(F.isThinMovement(3), false);
  assert.strictEqual(F.isThinMovement(0), true);
});

check('the suggested action follows the verdict', () => {
  assert.match(F.suggestedAction({ daysLeft: -5, isWarehouse: false, verdict: 'expired' }), /write off/i);
  assert.match(F.suggestedAction({ daysLeft: 40, isWarehouse: true, verdict: 'wh_unknown' }), /branch that consumes/i);
  assert.match(F.suggestedAction({ daysLeft: 40, isWarehouse: false, verdict: 'no_move' }), /transfer/i);
});

/* ---- funds availability ---- */

check('registers group by when the cash is usable', () => {
  assert.strictEqual(F.availabilityOf('Cash'), 't0');
  assert.strictEqual(F.availabilityOf('bank cib'), 't0', 'matching is case-insensitive');
  assert.strictEqual(F.availabilityOf('Bank AAIB'), 't1');
  assert.strictEqual(F.availabilityOf('Waffarha'), 'settlement');
});

check('an unclassified register is surfaced, not silently bucketed', () => {
  // "Package payment method" had no movement in the source period and is
  // deliberately unmapped; a new register must not land in T+0 by default.
  assert.strictEqual(F.availabilityOf('Package payment method'), null);
  assert.strictEqual(F.availabilityOf('Some New Wallet'), null);
  const groups = F.AVAILABILITY.flatMap((g) => g.registers);
  assert.strictEqual(new Set(groups).size, groups.length, 'a register may not be in two groups');
});

/* ---- sold ↔ stock matching ---- */

check('a stock item matches its sellable twin', () => {
  assert.ok(F.itemsMatch('V-Hacker 2.5ML', 'INV V-Hacker 2.5ML'));
  assert.ok(F.itemsMatch('كانيولا فلير مقاس 18', 'INV كانيولا فلير مقاس 18'));
  assert.ok(F.itemsMatch('B DE Beaute 1ML', '[Body Filler] INV B DE Beaute 1ML'), 'a bracket tag is stripped');
  assert.ok(F.itemsMatch('Saypha Volume', 'INV Saypha Volume(فيلر هيالوروني علاجي لضمور الأنسجة)'),
    'the trailing description is stripped');
});

check('two different products never match', () => {
  assert.ok(!F.itemsMatch('IV Cannula size 22', 'INV IV Cannula size 18'));
  assert.ok(!F.itemsMatch('كانيولا فلير مقاس 18', 'INV كانيولا فلير مقاس 21'));
  assert.ok(!F.itemsMatch('', 'INV'), 'nothing matches nothing');
});

/* ---- the sold/issued gap ---- */

check('the gap cause turns on how big a share of sales it is', () => {
  // Sold 10, issued 5 -> gap 5, half of sales: nothing was deducted.
  assert.strictEqual(F.gapCause({ gap: 5, soldQty: 10 }), 'invoiced_not_issued');
  // Sold 10, issued 8 -> gap 2, a fifth: a partial issuance.
  assert.strictEqual(F.gapCause({ gap: 2, soldQty: 10 }), 'partial_issuance');
  assert.strictEqual(F.gapCause({ gap: 4, soldQty: 10 }), 'partial_issuance', '40% is not over the line');
  assert.strictEqual(F.gapCause({ gap: 4.1, soldQty: 10 }), 'invoiced_not_issued');
  assert.strictEqual(F.gapCause({ gap: -3, soldQty: 10 }), 'issued_no_sale');
  for (const k of Object.keys(F.GAP_CAUSES)) assert.ok(F.GAP_CAUSES[k].length > 10, `${k} needs a label`);
});

check('only gaps worth money are worth looking at', () => {
  assert.strictEqual(F.worthLookingAt(2999), false);
  assert.strictEqual(F.worthLookingAt(3000), true);
  assert.strictEqual(F.worthLookingAt(-5000), true, 'a negative gap counts too');
});

/* ---- bonus ---- */

check('a bonus line is a real quantity carrying no money', () => {
  assert.strictEqual(F.isBonusLine({ qty: 3, subtotal: 0 }), true);
  // 90 lines in the source have no price AND no quantity — empty rent lines,
  // not free goods.
  assert.strictEqual(F.isBonusLine({ qty: 0, subtotal: 0 }), false);
  // Two lines carry a real unit price discounted to nothing; still bonus.
  assert.strictEqual(F.isBonusLine({ qty: 3, subtotal: 0, unitPrice: 15000 }), true);
  assert.strictEqual(F.isBonusLine({ qty: 1, subtotal: 253440 }), false);
});

/* ---- Odoo journal -> register, for the live collections sync ---- */

/* Every journal name actually seen on paid customer payments in August 2026,
   read off Odoo. If a new branch journal appears, this list is where it fails
   first rather than in a total nobody re-checks. */
check('the branch cash journals all fold onto Cash', () => {
  for (const j of ['Cash-Alex Camp Chizar', 'Cash-CFC', 'Cash-City Stars', 'Cash-Mohandseen',
    'Cash-Mall Of Arabia', 'Cash-Zayed', 'Cash-El Rehab', 'Cash-Loran',
    'Cash Madinty The Strip', 'Cash Madinty', 'Cash 1-Alex Roshdy']) {
    assert.strictEqual(F.registerForJournal(j), 'Cash', j);
  }
});

check('the banks fold onto their own registers', () => {
  assert.strictEqual(F.registerForJournal('Bank Arab African International'), 'Bank AAIB');
  assert.strictEqual(F.registerForJournal('Bank CIB Egypt'), 'Bank CIB');
});

check('valu and InstaPay are recognised however they are spelt', () => {
  assert.strictEqual(F.registerForJournal('valu'), 'valu');
  assert.strictEqual(F.registerForJournal('Insta Pay ZAT'), 'InstaPay');
  assert.strictEqual(F.registerForJournal('InstaPay'), 'InstaPay');
});

/* The one that would silently misfile money. "Cash Waffarha" begins with "Cash",
   so if the generic Cash rule is tested first, settlement money becomes same-day
   cash and the T+0 figure is overstated. */
check('"Cash Waffarha" is Waffarha, NOT Cash', () => {
  assert.strictEqual(F.registerForJournal('Cash Waffarha'), 'Waffarha');
  assert.strictEqual(F.availabilityOf(F.registerForJournal('Cash Waffarha')), 'settlement',
    'Waffarha must settle later, not count as same-day cash');
  assert.strictEqual(F.availabilityOf(F.registerForJournal('Cash-CFC')), 't0');
});

check('every mapped register has an availability, so nothing lands unclassified', () => {
  const journals = ['Cash-CFC', 'Bank CIB Egypt', 'Bank Arab African International',
    'valu', 'Cash Waffarha', 'Insta Pay ZAT'];
  for (const j of journals) {
    const reg = F.registerForJournal(j);
    assert.ok(reg, `${j} has no register`);
    assert.ok(F.availabilityOf(reg), `${reg} has no availability group`);
  }
});

/* An unknown journal must return null, not a guess. Odoo really does carry
   journals named after people — Youseef, Pussy Maher, Asmaa Nassar — and folding
   those into Cash would put personal accounts into the same-day figure. */
check('an unrecognised journal returns null rather than guessing', () => {
  for (const j of ['Youseef', 'Pussy Maher', 'Asmaa Nassar', 'Bank', 'Package payment method', '', null]) {
    assert.strictEqual(F.registerForJournal(j), null, `${j} should not map`);
  }
});

console.log(failures ? `\n${failures} failed\n` : '\n✓ the finance rules reproduce the source report\n');
process.exit(failures ? 1 : 0);
