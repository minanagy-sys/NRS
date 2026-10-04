/**
 * Report 09 — the composition identity, and who is owed cash back.
 *
 *   node test/procurement.test.js
 *
 * TWO THINGS ARE PINNED HERE BECAUSE BOTH FAILED SILENTLY WHILE THIS WAS BUILT.
 *
 * 1. THE COMPOSITION MUST SUM TO THE LINE TOTAL, EXACTLY. The report shows
 *    52,168,665 where the source pack showed 29,401,633, and the only thing
 *    making that difference an answer rather than a bug is the breakdown —
 *    Injectables 28.4 M, Expenses 12.5 M, Advertising 5.9 M. A spend category
 *    falling out of that breakdown would leave a plausible total short by one
 *    supplier, and nothing on the page would look wrong.
 *
 * 2. CASH BACK MAY ONLY REACH AN EXACTLY-NAMED VENDOR. Matched on the loose
 *    tiers, 21 agreements reached 63 of 73 suppliers and the report owed
 *    4,478,764 — including cash back on rent and advertising. Restricted to
 *    exact and squash it reaches 17 suppliers and 2,153,964, and Bio Solutions
 *    lands within 1.5% of the figure the pack states.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const P = require('../src/lib/procurement.js');
const C = require('../src/lib/consumables.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');

(async () => {
  console.log('\nthe spend groups');

  await check('the ordered rules put a prefixed category in its family, not in Other', () => {
    /* `Injection/Regenerative Medicine` must be tested against `Injection/`
       before anything can match on the word "Medicine". */
    assert.strictEqual(P.groupOf('Injection/Regenerative Medicine').key, 'injectables');
    assert.strictEqual(P.groupOf('Injection/Botox').key, 'injectables');
    assert.strictEqual(P.groupOf('Devices/DEKA Laser Hair Removal').key, 'devices');
    assert.strictEqual(P.groupOf('Service/Peeling').key, 'services');
    assert.strictEqual(P.groupOf('All').key, 'unclassified');
    assert.strictEqual(P.groupOf('Expenses').key, 'expenses');
    assert.strictEqual(P.groupOf('Advertising').key, 'advertising');
    assert.strictEqual(P.groupOf('Fixed Assets').key, 'assets');
  });

  await check('anything unrecognised lands in Other and is never dropped', () => {
    /* A category with no rule must still be counted somewhere, or the
       composition stops adding up the first time Odoo gains a category. */
    for (const c of ['Web development', 'Something New', '', null, undefined]) {
      const g = P.groupOf(c);
      assert.ok(g, `${c} matched no group at all`);
    }
    assert.strictEqual(P.groupOf('Web development').key, 'other');
    assert.strictEqual(P.groupOf(null).key, 'other');
  });

  await check('the consumable flag is what separates this report from the pack', () => {
    const cons = P.SPEND_GROUPS.filter((g) => g.consumable).map((g) => g.key);
    assert.deepStrictEqual(cons, ['injectables', 'devices', 'services', 'unclassified']);
    /* Rent and advertising are payables, not stock. Marking them consumable
       would make "Consumables" equal the whole ledger and say nothing. */
    assert.ok(!P.SPEND_GROUPS.find((g) => g.key === 'expenses').consumable);
    assert.ok(!P.SPEND_GROUPS.find((g) => g.key === 'advertising').consumable);
  });

  console.log('\nprice drift');

  await check('first and last are by DATE, not by row order', () => {
    /* A bill entered late for an early date would otherwise read as a price
       rise that never happened. */
    const d = P.driftOf([
      { date: new Date('2026-06-01'), unitPrice: 4500 },
      { date: new Date('2026-03-01'), unitPrice: 3000 },
    ]);
    assert.strictEqual(d.first, 3000, 'the March price is the first one');
    assert.strictEqual(d.last, 4500);
    assert.strictEqual(d.pct, 50);
  });

  await check('one observation, or a flat price, is not a drift', () => {
    assert.strictEqual(P.driftOf([{ date: new Date(), unitPrice: 100 }]), null);
    assert.strictEqual(P.driftOf([
      { date: new Date('2026-01-01'), unitPrice: 100 },
      { date: new Date('2026-02-01'), unitPrice: 100 },
    ]), null);
    assert.strictEqual(P.driftOf([]), null);
    assert.strictEqual(P.driftOf(null), null);
  });

  const bills = await prisma.bill.count();
  if (!bills) {
    console.log('\nNo bills loaded — skipping the live checks.\n');
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  }

  console.log('\nthe composition identity');

  const W = { from: '2026-01-01', to: '2026-08-31' };
  const pur = await P.buildPurchases(W);

  await check('THE GROUPS SUM TO THE LINE TOTAL, to the piastre', () => {
    assert.strictEqual(pur.reconciles.compositionGap, 0,
      `out by ${fmt(pur.reconciles.compositionGap)} — a category has fallen out of the breakdown`);
    const summed = pur.composition.reduce((t, g) => t + g.net, 0);
    assert.ok(Math.abs(summed - pur.reconciles.lineNet) < 0.01,
      `${fmt(summed)} vs ${fmt(pur.reconciles.lineNet)}`);
  });

  await check('the bill-header residual is stated SEPARATELY, never folded into a group', () => {
    /* Folding it in would make the sum balance by hiding the thing it exists to
       expose: 4 bills carry no line detail at all. */
    assert.ok(pur.reconciles.residual > 0, 'no residual at all — is every bill itemised now?');
    assert.ok(Math.abs(pur.reconciles.billNet - pur.reconciles.lineNet - pur.reconciles.residual) < 0.01);
    assert.ok(pur.reconciles.headerOnlyBills > 0);
  });

  await check('consumables plus everything else plus the residual is the ledger', () => {
    const t = pur.totals;
    const sum = t.consumableNet + t.nonConsumableNet + pur.reconciles.headerOnlyNet;
    assert.ok(Math.abs(sum - t.net) < 0.02, `${fmt(sum)} vs ledger ${fmt(t.net)}`);
  });

  await check('ours is broader than the pack, and the difference is nameable', () => {
    /* The whole justification for the scope decision. If injectables ever stop
       being close to the pack's figure, the two reports have diverged for a
       reason nobody has looked at. */
    const inj = pur.composition.find((g) => g.key === 'injectables');
    assert.ok(inj, 'no injectables group');
    assert.ok(Math.abs(inj.net - 29401633) / 29401633 < 0.10,
      `injectables ${fmt(inj.net)} is more than 10% from the pack's product total 29,401,633`);
    assert.ok(pur.totals.net > pur.totals.consumableNet,
      'the ledger is not broader than its consumable half — is the filter back?');
  });

  await check('a bonus line is counted as quantity and NEVER as price', () => {
    /* Free stock at a zero price drags a weighted average below anything ever
       paid. Same shape as counting a package as revenue. */
    assert.ok(pur.totals.bonusLines > 0, 'no bonus lines in this window');
    const withBonus = pur.products.filter((p) => p.bonusQty > 0);
    assert.ok(withBonus.length, 'no product has bonus stock');
    for (const p of withBonus) {
      assert.ok(p.qty >= p.bonusQty, `${p.product}: bonus ${p.bonusQty} exceeds total ${p.qty}`);
      if (p.priceDrift) assert.ok(p.priceDrift.first > 0, `${p.product} drifts from a zero price`);
    }
  });

  console.log('\ncash back reaches an exact name, or nobody');

  const ven = await P.buildVendors(W);

  await check('only exactly-named suppliers carry a rate', () => {
    /* MEASURED: at the loose tiers this was 63 of 73 suppliers and 4,478,764. */
    assert.ok(ven.totals.vendorsWithRate > 0, 'nobody has a rate — did the seed run?');
    assert.ok(ven.totals.vendorsWithRate < 30,
      `${ven.totals.vendorsWithRate} suppliers have a rate — the loose tiers are back`);
    for (const v of ven.rows.filter((x) => x.cashbackRate != null)) {
      assert.ok(['exact', 'squash'].includes(v.termMatch),
        `${v.supplierName} carries a rate matched by ${v.termMatch}`);
    }
  });

  await check('no rate is not the same as zero percent', () => {
    for (const v of ven.rows.filter((x) => x.cashbackRate == null)) {
      assert.strictEqual(v.cashbackDue, null,
        `${v.supplierName} has no agreement but is owed ${v.cashbackDue}`);
    }
  });

  await check('cash back is due on the figure AFTER returns', () => {
    for (const v of ven.rows.filter((x) => x.cashbackRate != null)) {
      const want = Math.round(v.netOfReturns * v.cashbackRate * 100) / 100;
      assert.ok(Math.abs(v.cashbackDue - want) < 0.02,
        `${v.supplierName}: ${v.cashbackDue} != ${v.netOfReturns} x ${v.cashbackRate}`);
      assert.ok(Math.abs(v.netOfReturns - (v.net - v.returned)) < 0.02, v.supplierName);
    }
  });

  await check('Bio Solutions lands within 2% of the pack, which is the return netting', () => {
    /* The pack: 7,037,737 net and 703,774 due. Ours is 7,863,509 before returns
       and 933,772 of returns, so the agreement is that netting them gets us
       there — and it does, to 1.5%. */
    const bio = ven.rows.find((v) => /^bio solutions$/i.test(v.supplierName));
    assert.ok(bio, 'Bio Solutions is not in this window');
    assert.ok(bio.returned > 900000, `only ${fmt(bio.returned)} of returns matched`);
    assert.ok(Math.abs(bio.netOfReturns - 7037737) / 7037737 < 0.02,
      `${fmt(bio.netOfReturns)} vs the pack's 7,037,737`);
    assert.ok(Math.abs(bio.cashbackDue - 703774) / 703774 < 0.02,
      `${fmt(bio.cashbackDue)} vs the pack's 703,774`);
  });

  await check('Eldawlia Pharma is the one vendor on 15%', () => {
    /* Stated in the pack's own note. If the seed ever flattens every rate to
       10% this is the only thing that would notice. */
    const el = ven.rows.find((v) => /eldawlia/i.test(v.supplierName) && v.cashbackRate != null);
    assert.ok(el, 'Eldawlia Pharma has no rate');
    assert.strictEqual(Number(el.cashbackRate), 0.15, `Eldawlia is on ${el.cashbackRate}`);
    const others = ven.rows.filter((v) => v.cashbackRate != null && !/eldawlia/i.test(v.supplierName));
    assert.ok(others.every((v) => Number(v.cashbackRate) === 0.10),
      `not everyone else is on 10%: ${others.filter((v) => Number(v.cashbackRate) !== 0.1).map((v) => v.supplierName).join(', ')}`);
  });

  console.log('\nreturns');

  const ret = await P.buildReturns();

  await check('every return either nets off a vendor or is listed as an orphan', () => {
    /* Silently dropping one would make the returns total on tab 04 disagree
       with the vendor table on tab 03. */
    assert.ok(!ret.missing, 'no returns loaded');
    const orphan = ven.orphanReturns.reduce((t, o) => t + o.value, 0);
    const accounted = ven.totals.returned + orphan;
    assert.ok(Math.abs(accounted - ret.totals.value) < 0.02,
      `${fmt(ven.totals.returned)} netted + ${fmt(orphan)} orphaned != ${fmt(ret.totals.value)}`);
  });

  await check('the seeded total is the pack\'s, and says it is seeded', () => {
    assert.ok(Math.abs(ret.totals.value - 3047190.56) < 1, `${fmt(ret.totals.value)}`);
    assert.ok(ret.sources.includes('seed'), `sources: ${ret.sources.join(',')}`);
    assert.strictEqual(ret.seeded, ret.totals.rows, 'some rows are not marked seeded');
    /* The pack carries no date on a return, so nothing may pretend to one. */
    assert.strictEqual(ret.dated, 0, 'a seeded return grew a date from somewhere');
  });

  await check('returns are stored POSITIVE, so no caller can double-negate them', () => {
    for (const r of ret.rows) {
      assert.ok(r.value >= 0, `${r.product} is stored negative`);
      assert.ok(r.qty >= 0, `${r.product} has negative quantity`);
    }
  });

  console.log('\nthe per-product cut');

  await check('a linked product resolves to its branches and doctors', async () => {
    const link = await C.links();
    const cat = await C.catalogue();
    const ids = [...new Set([...link.byService.values()].map((v) => cat.canonical(v.consumableOdooId)))];
    const metox = ids.find((i) => (cat.byId.get(i) || {}).name === 'Metox') || ids[0];
    const one = await P.buildProduct({ ...W, odooId: metox });
    assert.ok(!one.missing, one.reason);
    assert.ok(one.linked, 'the product is not linked');
    assert.ok(one.sales.branches.length > 0, 'no branch cut');
    assert.ok(one.sales.doctors.length > 0, 'no doctor cut');
    /* The branch and doctor cuts are the SAME sales read two ways and must
       agree — the check that catches a cut being built off a different filter. */
    const b = one.sales.branches.reduce((t, x) => t + x.doses, 0);
    const d = one.sales.doctors.reduce((t, x) => t + x.doses, 0);
    assert.ok(Math.abs(b - d) < 0.01, `branches ${b} vs doctors ${d}`);
    assert.ok(Math.abs(b - one.sales.doses) < 0.01, `cuts ${b} vs total ${one.sales.doses}`);
  });

  await check('a product with no link says so instead of showing zeros as fact', async () => {
    const all = await prisma.consumableLink.findMany({ where: { consumableOdooId: { not: null } } });
    const linked = new Set(all.map((l) => l.consumableOdooId));
    const cat = await C.catalogue();
    const orphan = cat.rows.find((r) => !linked.has(r.odooId));
    assert.ok(orphan, 'every catalogue product is linked');
    const one = await P.buildProduct({ ...W, odooId: orphan.odooId });
    assert.strictEqual(one.linked, false);
    assert.strictEqual(one.sales.doses, 0);
    assert.strictEqual(one.services.length, 0);
  });

  await check('a purchase line that only OVERLAPS the name is refused and reported', async () => {
    /* Exocell: the stock is in millilitres and the purchase is a 10 ML vial.
       Attributing it would put one product's spend on another's card. */
    const one = await P.buildProduct({ ...W, odooId: 39800 });
    if (one.missing) return;
    assert.strictEqual(one.purchases.lines, 0, 'a containment match was accepted');
    assert.ok(one.purchases.nearMisses.length > 0, 'the refusal was not reported');
    for (const n of one.purchases.nearMisses) {
      assert.ok(!C.COST_TIERS.has(n.rule), `${n.product} was refused despite matching by ${n.rule}`);
    }
  });

  await check('an unknown product id is a 404, not an empty card', async () => {
    const one = await P.buildProduct({ ...W, odooId: 999999999 });
    assert.strictEqual(one.missing, true);
    assert.ok(one.reason && one.reason.length > 10);
  });

  console.log('\npayments');

  await check('payments are not netted against purchases', async () => {
    const pay = await P.buildPayments(W);
    assert.ok(pay.totals.amount > 0);
    assert.ok(/do not net/i.test(pay.note), 'the note that stops the wrong reading is gone');
    const summed = pay.months.reduce((t, m) => t + m.amount, 0);
    assert.ok(Math.abs(summed - pay.totals.amount) < 0.02, `months ${fmt(summed)} vs ${fmt(pay.totals.amount)}`);
    const byVendor = pay.vendors.reduce((t, v) => t + v.amount, 0);
    assert.ok(Math.abs(byVendor - pay.totals.amount) < 0.02, 'the vendor cut does not sum to the total');
  });

  console.log(failures ? `\n${failures} failed\n` : '\n✓ report 09 adds up, and owes cash back only where somebody agreed to it\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
