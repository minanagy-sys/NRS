/**
 * The finance sections, read back out of Postgres.
 *
 * Every figure below is one the source report published for itself, so this pins
 * the whole chain — HTML parsing, import, schema, SQL and the rules — against a
 * document that was signed off. If a number here moves, either the data changed
 * or we broke something.
 *
 *   node test/finance.test.js
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const Finance = require('../src/lib/finance.js');

let failures = 0;
const check = (label, got, want, tol = 1) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : got === want;
  if (!ok) failures++;
  const shown = typeof got === 'number' ? got.toLocaleString('en-US', { maximumFractionDigits: 2 }) : got;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(40)} ${String(shown).padStart(16)}${ok ? '' : `   expected ${want}`}`);
};

(async () => {
  const loaded = await prisma.expiryLot.count();
  if (!loaded) {
    console.log('\n  – no finance data loaded; run scripts/import-finance-html.js first\n');
    await prisma.$disconnect();
    return;
  }

  /* The as-of date is the day the source speaks for. Passing today instead would
     move every day count and verdict — which is the point of recomputing them,
     but it would stop these figures being comparable to the published ones. */
  const batch = await prisma.financeBatch.findFirst({ where: { section: 'expiry' }, orderBy: { importedAt: 'desc' } });
  const asOf = batch.asOf.toISOString().slice(0, 10);
  const d = await Finance.buildFinance({ from: '2026-08-01', to: '2026-08-10', asOf });

  console.log('\ncollections — net of customer refunds, per register');
  /* Pinned against an explicit SNAPSHOT cfg, not the configured one. Collections
     now reads `odoo` by default, and Odoo is live: for this same window it says
     8,448,561 where the 11-August snapshot said 7,539,452, because receipts kept
     arriving. Asserting the published figures through the resolved config would
     make this suite fail every time somebody syncs — the same trap the payables
     block below already avoids. */
  const SNAP = { mode: 'snapshot', cutover: null, primary: 'snapshot' };
  const C = await Finance.buildCollections(SNAP, { from: '2026-08-01', to: '2026-08-10' });
  check('net', C.totals.net, 7539452);
  check('gross', C.totals.gross, 7558422);
  check('refunds', C.totals.refunds, 18970);
  check('package share', C.totals.packageShare, 456537);
  check('receipts', C.totals.txns, 1761, 0);
  check('branches', C.totals.branches, 11, 0);
  check('gross − refunds = net', C.totals.gross - C.totals.refunds, C.totals.net);
  check('day summary sums to net', C.days.reduce((s, x) => s + x.net, 0), C.totals.net);
  for (const [key, want] of [['t0', 2428786], ['t1', 4999056], ['settlement', 111610]]) {
    check(`availability ${key}`, C.availability.find((a) => a.key === key).net, want);
  }
  check('availability sums to net', C.availability.reduce((s, a) => s + a.net, 0), C.totals.net);
  check('every register classified', C.unclassified.length, 0, 0);

  /* The live Odoo source, checked for shape rather than for a fixed total —
     the total moves every time a receipt is posted, which is the whole reason
     the sync exists. */
  const odooRows = await prisma.collection.count({ where: { source: 'odoo' } });
  if (odooRows) {
    const O = await Finance.buildCollections({ mode: 'odoo', cutover: null, primary: 'odoo' },
      { from: '2026-08-01', to: '2026-08-10' });
    check('odoo: gross − refunds = net', O.totals.gross - O.totals.refunds, O.totals.net);
    check('odoo: day summary sums to net', O.days.reduce((s, x) => s + x.net, 0), O.totals.net);
    /* Every pound has to be visible somewhere: the classified availability groups
       plus any register with no rule must add back to the total. `unclassified`
       is a list of NAMES, so the amounts come from `registers`. Odoo really does
       carry a journal called "Youseef" holding 4,600 — this is the assertion that
       stops it quietly vanishing from the T+0/T+1 split. */
    const unclassifiedNet = O.unclassified.reduce((sum, name) => {
      const reg = O.registers.find((r) => r.name === name);
      return sum + (reg ? reg.net : 0);
    }, 0);
    check('odoo: availability + unclassified = net',
      O.availability.reduce((s, a) => s + a.net, 0) + unclassifiedNet, O.totals.net);
    /* Odoo should not be BELOW a snapshot frozen weeks ago; if it is, the sync is
       dropping receipts rather than finding late ones. */
    check('odoo is not lower than the frozen snapshot', O.totals.net >= C.totals.net, true);
    check('odoo covers the same 11 branches at least', O.totals.branches >= 11, true);
  } else {
    console.log('  (no odoo collections synced — run scripts/sync-collections.js)');
  }

  /* Three independent views of the same day: the published summary, the
     day×register grid, and the per-branch drill-down that opens under a day row.
     They are built from different shapes, so if any two disagree the page is
     showing a number it cannot justify. */
  const order = C.availability.flatMap((g) => g.registers);
  const dayDisagreements = C.days.filter((day) => {
    let branchNet = 0, branchPkg = 0;
    for (const b of C.perBranch) {
      const cells = b.days[day.date] || {};
      for (const r of order) { branchNet += (cells[r] || {}).net || 0; branchPkg += (cells[r] || {}).pkg || 0; }
    }
    const gridNet = Object.values(C.byDayRegister[day.date] || {}).reduce((s, c) => s + c.net, 0);
    return Math.abs(branchNet - day.net) > 0.5
      || Math.abs(gridNet - day.net) > 0.5
      || Math.abs(branchPkg - day.packageShare) > 0.5;
  });
  check('summary, grid and branch drill-down agree every day', dayDisagreements.length, 0, 0);

  console.log('\npayables — balances are extracted, never derived');
  /* Pinned against the SNAPSHOT, not against whatever the section is currently
     set to read. Payables ships as `stitched`, so once anyone syncs Odoo the
     blended totals move — correctly — and pinning those would make this suite
     fail the first time the feature is used. */
  const P = await Finance.buildPayables({ mode: 'snapshot', cutover: null, primary: 'snapshot' });
  check('suppliers', P.totals.suppliers, 154, 0);
  check('opening balance', P.totals.opening, -9387632.86);
  check('closing balance', P.totals.closing, -43165065.77);
  check('purchases inc-VAT', P.totals.bills, 170849616.56);
  check('payments', P.totals.payments, 225724765.31);
  check('2025 purchases', P.years.find((y) => y.year === 2025).gross, 115400716.03);
  check('2026 purchases', P.years.find((y) => y.year === 2026).gross, 55448900.53);
  check('2025 payments', P.years.find((y) => y.year === 2025).paid, 160056062.77);
  /* The report states closing = opening + purchases − payments and it does NOT
     hold. Pin the gap so nobody "fixes" the balances into agreement later. */
  const implied = P.totals.opening + P.totals.bills - P.totals.payments;
  check('the stated equation really does not hold', Math.abs(implied - P.totals.closing) > 1000000, true);
  check('suppliers granting free units', P.bonusVendors.length > 0, true);

  /* Stitching must ADD Odoo's movements to the snapshot's, never replace them —
     and the supplier count must match the list, or the KPI contradicts the table
     right beneath it. */
  const blended = await Finance.buildPayables({ mode: 'stitched', cutover: '2026-08-01', primary: 'snapshot' });
  check('stitched keeps every snapshot purchase', blended.totals.bills >= P.totals.bills, true);
  check('stitched keeps every snapshot payment', blended.totals.payments >= P.totals.payments, true);
  check('stitched keeps the extracted balances', blended.totals.closing, P.totals.closing);
  check('the supplier count matches the list', blended.totals.suppliers, blended.suppliers.length, 0);
  check('and so does the snapshot one', P.totals.suppliers, P.suppliers.length, 0);

  console.log('\nsold vs issued — compared in units, costed at cost');
  const R = d.recon;
  check('paired products', R.totals.pairs, 57, 0);
  check('stock items with no twin', R.totals.noTwin, 25, 0);
  check('units sold', R.totals.soldQty, 7925.1, 0.05);
  check('sold value ex-VAT', R.totals.soldValue, 5086316);
  check('net issued units', R.totals.netQty, 6874.7, 0.05);
  check('net issued at cost', R.totals.netCost, 1300815);
  check('invoiced but not issued', R.totals.gapPos, 239243);
  check('issued but not sold', R.totals.gapNeg, 32483);
  check('issued − returned = net', R.totals.issuedQty - R.totals.returnedQty, R.totals.netQty, 0.01);
  check('branches covered', R.branches.length, 11, 0);
  for (const r of R.products) {
    if (r.gapCost === 0) continue;
    assert.ok(R.causes[r.cause], `${r.label} has no cause label`);
  }

  console.log('\nexpiry — verdicts recomputed from the as-of date');
  const X = d.expiry;
  check('as-of date', X.asOf, asOf);
  check('lines', X.totals.lines, 625, 0);
  check('lots', X.totals.lots, 552, 0);
  check('products', X.totals.products, 91, 0);
  check('value at cost', X.totals.value, 8257090);
  check('already expired', X.totals.expired, 236613);
  check('warehouse value', X.totals.warehouse, 2159874);
  check('expired sitting in warehouses', X.totals.warehouseExpired, 218933);
  check('parked — no movement, expiry far off', X.totals.parked, 265028);
  // The verdict distribution the source published, reproduced from stored inputs.
  for (const [v, want] of [['safe', 376], ['part_waste', 103], ['watch', 63],
    ['wh_unknown', 36], ['no_move', 23], ['expired', 22], ['all_waste', 2]]) {
    check(`verdict ${v}`, X.verdicts[v] || 0, want, 0);
  }
  /* The page groups the lots itself so the filters can re-slice them without a
     round trip, so these assert over the flat list — the same data it draws. */
  check('lots sent flat for filtering', X.lots.length, X.totals.lines, 0);
  const byBucket = {};
  for (const l of X.lots) byBucket[l.bucket] = (byBucket[l.bucket] || 0) + l.value;
  check('buckets sum to the total value',
    Object.values(byBucket).reduce((s, v) => s + v, 0), X.totals.value);
  check('every lot lands in a known bucket',
    X.lots.filter((l) => !X.buckets.some((b) => b.key === l.bucket)).length, 0, 0);
  check('locations', new Set(X.lots.map((l) => l.location)).size, 13, 0);
  check('warehouse locations', new Set(X.lots.filter((l) => l.isWarehouse).map((l) => l.location)).size, 2, 0);

  // Warehouses must carry no forecast at all — not a zero, an absence.
  check('no warehouse lot invents a rate',
    X.lots.filter((l) => l.isWarehouse && l.daysLeft >= 0 && l.rate !== null).length, 0, 0);
  /* An expired lot is wholly at risk, so its at-risk value is exactly its value —
     never a rounding cent more, which would read as worth-less-than-at-risk. */
  check('no lot is worth less than its at-risk value',
    X.lots.filter((l) => l.atRiskValue > l.value + 0.001).length, 0, 0);
  check('every lot carries a verdict label',
    X.lots.filter((l) => !X.labels[l.verdict]).length, 0, 0);

  console.log('\nsource switching');
  check('payables is stitched, not snapshot', d.meta.sources.payables.mode, 'stitched');
  check('and its cutover is the Odoo 18 go-live', d.meta.sources.payables.cutover, '2026-08-01');

  /* Recomputed, not stored: moving the as-of date forward must move the day
     counts and the verdicts with it. */
  console.log('\nthe verdict follows the date it is read on');
  const later = await Finance.buildExpiry({ mode: 'snapshot', cutover: null, primary: 'snapshot' },
    { asOf: new Date('2027-08-11T00:00:00Z') });
  check('a year later, more has expired', later.totals.expired > X.totals.expired, true);
  check('and fewer lots are safe', (later.verdicts.safe || 0) < X.verdicts.safe, true);
  check('total value is unchanged', later.totals.value, X.totals.value);

  console.log(failures ? `\n✗ ${failures} check(s) failed\n` : '\n✓ the finance sections reproduce the published report\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n✗ ${e.stack || e.message}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
