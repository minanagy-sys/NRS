/**
 * The payables export → edit → import loop.
 *
 * Works on a throwaway supplier of its own and removes it afterwards, so it can
 * assert against the real database without putting a single real row at risk.
 *
 *   node test/payables.test.js
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const Sheet = require('../src/lib/sheet.js');
const P = require('../src/lib/payables-import.js');
const E = require('../src/lib/export-payables.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const VENDOR = '~~roundtrip test vendor~~';
const cleanup = async () => {
  await prisma.bill.deleteMany({ where: { supplierName: VENDOR } });
  await prisma.vendorPayment.deleteMany({ where: { supplierName: VENDOR } });
  await prisma.supplier.deleteMany({ where: { name: VENDOR } });
};

(async () => {
  await cleanup();

  /* Fractional amounts are the whole point of this test. `882476.56` is really
     882476.55999999996 as a double, so matching a Decimal column against the JS
     number found nothing and the row was written a second time — 11 payments
     duplicated on the first real round trip, every one with cents. */
  const AMOUNTS = [882476.56, 721979.56, 94348.9, 75000, 0.01];

  const book = (kind, rows) => Sheet.write([{ name: kind, rows }]);
  const importSheet = async (kind, rows) => {
    const wb = Sheet.read(book(kind, rows), kind);
    const cols = P.resolveColumns(kind, wb.columns);
    const { records, problems } = P.plan(kind, wb.rows, cols);
    assert.strictEqual(problems.length, 0, `unreadable rows: ${problems.join('; ')}`);
    return P.commit(kind, records);
  };

  await check('a supplier and its payments import', async () => {
    await importSheet('balances', [E.HEADERS.balances, [VENDOR, 'supplies', 1000, 2500.75]]);
    await importSheet('payments', [
      E.HEADERS.payments,
      ...AMOUNTS.map((a, i) => [VENDOR, `2026-07-0${i + 1}`, a, 'CIB bank', `ref ${i}`, null]),
    ]);
    const n = await prisma.vendorPayment.count({ where: { supplierName: VENDOR } });
    assert.strictEqual(n, AMOUNTS.length);
  });

  await check('importing the same payments again does not double them', async () => {
    await importSheet('payments', [
      E.HEADERS.payments,
      ...AMOUNTS.map((a, i) => [VENDOR, `2026-07-0${i + 1}`, a, 'CIB bank', `ref ${i}`, null]),
    ]);
    const rows = await prisma.vendorPayment.findMany({ where: { supplierName: VENDOR } });
    assert.strictEqual(rows.length, AMOUNTS.length,
      `fractional amounts duplicated: ${rows.map((r) => Number(r.amount)).sort().join(', ')}`);
  });

  await check('two genuinely identical payments both survive', async () => {
    /* The snapshot really does hold 24 identical payments on one day, so the key
       is not unique and the delete must be done once per key, not once per row —
       otherwise a re-import collapses them into one. */
    await importSheet('payments', [
      E.HEADERS.payments,
      [VENDOR, '2026-07-20', 500.25, 'CIB bank', 'first', null],
      [VENDOR, '2026-07-20', 500.25, 'CIB bank', 'second', null],
    ]);
    const same = await prisma.vendorPayment.count({
      where: { supplierName: VENDOR, date: new Date('2026-07-20T00:00:00Z') },
    });
    assert.strictEqual(same, 2);
    // and again, to prove it is stable rather than merely additive
    await importSheet('payments', [
      E.HEADERS.payments,
      [VENDOR, '2026-07-20', 500.25, 'CIB bank', 'first', null],
      [VENDOR, '2026-07-20', 500.25, 'CIB bank', 'second', null],
    ]);
    assert.strictEqual(await prisma.vendorPayment.count({
      where: { supplierName: VENDOR, date: new Date('2026-07-20T00:00:00Z') },
    }), 2, 'a second import changed the count');
  });

  await check('bills match on their reference, and cents survive', async () => {
    const rows = [
      E.HEADERS.bills,
      [VENDOR, 'BILL/TEST/1', '2026-07-10', 11400.55, 10000.48, 1400.07, 'CFC'],
    ];
    await importSheet('bills', rows);
    await importSheet('bills', rows);
    const bills = await prisma.bill.findMany({ where: { supplierName: VENDOR } });
    assert.strictEqual(bills.length, 1, 'the same reference was imported twice');
    assert.strictEqual(Number(bills[0].gross), 11400.55);
    assert.strictEqual(Number(bills[0].vat), 1400.07);
  });

  await check('balances are updated, not duplicated', async () => {
    await importSheet('balances', [E.HEADERS.balances, [VENDOR, 'assets', 1000, 9999.99]]);
    const s = await prisma.supplier.findMany({ where: { name: VENDOR } });
    assert.strictEqual(s.length, 1);
    assert.strictEqual(Number(s[0].closing), 9999.99);
    assert.strictEqual(s[0].category, 'assets', 'the category should follow the sheet');
  });

  await check('the exported headings are the ones the importer detects', async () => {
    /* Export and import are two halves of one loop; if a heading is renamed on
       one side the loop breaks silently, so assert they still meet. */
    for (const kind of P.KINDS) {
      const wb = Sheet.read(book(kind, [E.HEADERS[kind]]), kind);
      const cols = P.resolveColumns(kind, wb.columns);
      assert.ok(P.covers(kind, cols),
        `${kind}: headings ${E.HEADERS[kind].join(', ')} do not cover what the import needs`);
      assert.strictEqual(P.kindFromSheetName(E.SHEETS[kind]), kind,
        `the worksheet name ${E.SHEETS[kind]} no longer identifies ${kind}`);
    }
  });

  await check('a real export re-imports without changing anything', async () => {
    /* Bill LINES are the ones to watch. This sheet carries none, so a bills
       import that replaced its rows would cascade every line item away — 2,545 of
       them went the first time, and only the bonus figures on another tab noticed. */
    const before = {
      suppliers: await prisma.supplier.count(),
      bills: await prisma.bill.count(),
      billLines: await prisma.billLine.count(),
      bonusLines: await prisma.billLine.count({ where: { isBonus: true } }),
      payments: await prisma.vendorPayment.count(),
      total: String((await prisma.vendorPayment.aggregate({ _sum: { amount: true } }))._sum.amount),
    };
    const { buffer } = await E.exportPayables({ source: 'snapshot' });
    for (const kind of P.KINDS) {
      const wb = Sheet.read(buffer, E.SHEETS[kind]);
      const cols = P.resolveColumns(kind, wb.columns);
      const { records } = P.plan(kind, wb.rows, cols);
      await P.commit(kind, records);
    }
    const after = {
      suppliers: await prisma.supplier.count(),
      bills: await prisma.bill.count(),
      billLines: await prisma.billLine.count(),
      bonusLines: await prisma.billLine.count({ where: { isBonus: true } }),
      payments: await prisma.vendorPayment.count(),
      total: String((await prisma.vendorPayment.aggregate({ _sum: { amount: true } }))._sum.amount),
    };
    assert.deepStrictEqual(after, before);
  });

  await cleanup();
  const left = await prisma.supplier.count({ where: { name: VENDOR } });
  console.log(left ? '  ✗ the test vendor was left behind' : '  ✓ the test vendor was removed');
  if (left) failures++;

  console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ payables survives export, editing and re-import\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n✗ ${e.stack || e.message}\n`);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
