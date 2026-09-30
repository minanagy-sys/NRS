/**
 * Excluding a sales journal from the comparable-revenue figure.
 *
 *   node test/journal.test.js
 *
 * Two things this pins, both of which would be silent if they broke:
 *   · the exclusion is REPORTED as unknown until every invoice in the range
 *     carries a journal, so a partially-synced window cannot publish a figure
 *     that is 7% too high while looking authoritative
 *   · the report's own revenue is untouched — the exclusion is one number in one
 *     card, not a redefinition of revenue
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const Report = require('../src/lib/report.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const FROM = '2026-08-01', TO = '2026-08-31';
const inWindow = {
  invoiceDate: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T00:00:00Z`) },
  moveType: 'out_invoice',
};

(async () => {
  const x = await Report.revenueExcludingJournals(FROM, TO);
  const all = await prisma.invoice.aggregate({ where: inWindow, _sum: { amountUntaxed: true, amountTotal: true }, _count: true });
  const pkg = await prisma.invoice.aggregate({
    where: { ...inWindow, journalName: { in: Report.EXCLUDED_REVENUE_JOURNALS } },
    _sum: { amountUntaxed: true, amountTotal: true }, _count: true,
  });

  console.log('\nthe excluded journal');
  await check('it is the package sale journal, named once in one place',
    () => assert.deepStrictEqual(Report.EXCLUDED_REVENUE_JOURNALS, ['Package sale journal']));

  if (!pkg._count) {
    console.log('  (no package-sale invoices in this window — sync 1-31 Aug 2026 to exercise the rest)');
  } else {
    await check(`${pkg._count} invoices carry it`, () => assert.ok(pkg._count > 0));
    /* Packages are prepayments, not taxed sales. If VAT ever appears on them the
       premise for excluding them from a collections comparison has changed. */
    await check('they carry no VAT at all — ex equals inc', () => assert.strictEqual(
      Number(pkg._sum.amountUntaxed).toFixed(2), Number(pkg._sum.amountTotal).toFixed(2)));
  }

  console.log('\nthe arithmetic');
  await check('excluded ex = all ex − package ex', () => assert.strictEqual(
    x.ex.toFixed(2), (Number(all._sum.amountUntaxed || 0) - Number(pkg._sum.amountUntaxed || 0)).toFixed(2)));
  await check('excluded inc = all inc − package inc', () => assert.strictEqual(
    x.inc.toFixed(2), (Number(all._sum.amountTotal || 0) - Number(pkg._sum.amountTotal || 0)).toFixed(2)));
  await check('the excluded figure is never above the full one', () => assert.ok(x.ex <= Number(all._sum.amountUntaxed || 0) + 0.01));
  await check('it reports how much it removed', () => assert.strictEqual(
    x.removedEx.toFixed(2), Number(pkg._sum.amountUntaxed || 0).toFixed(2)));

  console.log('\nit refuses to look confident on partial data');
  await check('known is true only when every invoice has a journal', async () => {
    const missing = await prisma.invoice.count({ where: { ...inWindow, journalName: null } });
    assert.strictEqual(x.known, missing === 0, `${missing} invoices have no journal but known=${x.known}`);
  });
  await check('coverage is the share that do', async () => {
    const withJ = await prisma.invoice.count({ where: { ...inWindow, journalName: { not: null } } });
    assert.strictEqual(Math.round(x.coverage * 1000), Math.round((all._count ? withJ / all._count : 1) * 1000));
  });

  console.log('\nthe default call is unchanged, and the opt-in changes everything');
  await check('buildReport still counts every posted invoice by default', async () => {
    /* Commercial Sales and the tests call it this way. The exclusion must stay
       opt-in, or a caller that never asked for it silently changes basis. */
    const r = await Report.buildReport(FROM, TO);
    assert.strictEqual(r.totals.ex.toFixed(2), Number(all._sum.amountUntaxed || 0).toFixed(2),
      'the exclusion leaked into the default report total');
    assert.strictEqual(r.totals.excluded, null, 'a default build should not claim an exclusion');
  });
  await check('and with excludeJournals, EVERY cut drops the package journal', async () => {
    /* This is what the Sales report asks for. The property that matters is not
       that the total is smaller — it is that branch, doctor, day, product and
       category still reconcile TO that smaller total. A report whose total
       excludes packages while its branch rows do not is a report that no longer
       adds up, and nothing on the page would show it. */
    const r = await Report.buildReport(FROM, TO, { excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS });
    assert.strictEqual(r.totals.ex.toFixed(2), x.ex.toFixed(2),
      'the report total disagrees with revenueExcludingJournals');
    assert.strictEqual(r.totals.invoices, x.invoices);
    for (const cut of ['branches', 'doctors', 'days', 'products', 'categories']) {
      const summed = r[cut].reduce((s, row) => s + row.ex, 0);
      assert.ok(Math.abs(summed - r.totals.ex) < 0.02,
        `${cut} sums to ${summed.toFixed(2)} against a total of ${r.totals.ex.toFixed(2)}`);
    }
  });
  await check('  and it reports what it removed, so the page can show it', async () => {
    const r = await Report.buildReport(FROM, TO, { excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS });
    assert.ok(r.totals.excluded, 'nothing was reported as excluded');
    assert.strictEqual(r.totals.excluded.ex.toFixed(2), x.removedEx.toFixed(2));
    assert.strictEqual(r.totals.excluded.invoices, x.removedInvoices);
    /* `known` is what stops an "ex-package" label appearing over a window whose
       journals were never synced. */
    assert.strictEqual(r.totals.excluded.known, x.known);
  });
  await check('  an invoice with NO journal is kept, not dropped', async () => {
    /* A journal we cannot read is not evidence of a package. Dropping it would
       understate the report rather than merely mislabel it — and this is the
       same choice revenueExcludingJournals makes, so the two agree. */
    const r = await Report.buildReport(FROM, TO, { excludeJournals: ['No Such Journal'] });
    assert.strictEqual(r.totals.ex.toFixed(2), Number(all._sum.amountUntaxed || 0).toFixed(2),
      'excluding a journal that matches nothing changed the total');
  });
  await check('and so the two figures genuinely differ', () => {
    if (!pkg._count) return;
    assert.ok(Math.abs(Number(all._sum.amountUntaxed) - x.ex) > 1, 'nothing was excluded');
  });

  console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ the package journal exclusion is opt-in, complete, and reconciles\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n✗ ${e.stack || e.message}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
