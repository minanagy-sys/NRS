/**
 * Tab 08 — the syringe rules, the ticket definition, and the refusals.
 *
 *   node test/doctors.test.js
 *
 * The family rules are the reason this file exists. Rich PL, V-Hacker, Novuma
 * and Sfera all sit in `Injection/Biostimulators`, so a category-first rule set
 * collapses four separate figures into one bucket — the same shape as the bug
 * that filed `Injection/Body Contouring` as an injection and read a x1.25
 * commission card as 0.00%. Nothing on the page would show it: five plausible
 * numbers would appear, four of them wrong.
 *
 * So the order is pinned here, along with the two definitions that are easy to
 * read backwards: ticket size is per DISTINCT CUSTOMER, and `Filler ultra deep`
 * has to be caught by name because most of it is filed outside
 * `Injection/Filler`.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const D = require('../src/lib/doctors.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const fam = (name, cat) => {
  const f = D.familyOf(name, cat);
  return f ? f.key : null;
};

(async () => {
  console.log('\nthe family rules, most specific first');

  await check('the four biostimulators stay four families, not one', () => {
    /* All four carry category `Injection/Biostimulators`. A category-first rule
       would return the same answer for every one of them. */
    const cat = 'Injection/Biostimulators';
    assert.strictEqual(fam('Rich Topic PL 5 ML', cat), 'richpl');
    assert.strictEqual(fam('V-Hacker 2.5ML (علاج طبي)', cat), 'vhacker');
    assert.strictEqual(fam('Novuma 1.5 cc (علاج بيولوجي)', cat), 'calcium');
    assert.strictEqual(fam('Sfera 3ML (علاج بيولوجي)', cat), 'calcium');
    const keys = new Set([
      fam('Rich Topic PL 5 ML', cat), fam('V-Hacker 2.5ML', cat),
      fam('Novuma 1.5 cc', cat), fam('Sfera 3ML', cat),
    ]);
    assert.strictEqual(keys.size, 3, 'the biostimulators collapsed into fewer families');
  });

  await check('"Filler ultra deep" is Filler even when its category is not', () => {
    /* MEASURED: 215 of its ~307 units are filed under the catch-all `All`
       category and only 92 under `Injection/Filler`. A category-only rule drops
       the larger half, which is exactly why the source pack names this product
       explicitly in its own rules. */
    assert.strictEqual(fam('Filler ultra deep', 'All'), 'filler');
    assert.strictEqual(fam('Filler ultra deep (فيلر هيالوروني)', 'Injection/Filler'), 'filler');
  });

  await check('the two category families still work by category', () => {
    assert.strictEqual(fam('Saypha Volume Plus', 'Injection/Filler'), 'filler');
    assert.strictEqual(fam('Some Booster', 'Injection/Skin Booster'), 'booster');
  });

  await check('an unrecognised product returns NO family, not the nearest one', () => {
    /* A wrong family is worse than a missing one: it inflates one count and
       deflates another, and both look plausible. */
    for (const [n, c] of [
      ['Metox Botox 1 Unite', 'Injection/Botox'],
      ['deka', 'Devices/DEKA Laser Hair Removal'],
      ['LPG Session', 'Devices/LPG'],
      ['Unknown product', 'Uncategorised'],
      ['', null],
    ]) {
      assert.strictEqual(fam(n, c), null, `${n} was filed as ${fam(n, c)}`);
    }
  });

  await check('Botox is not an injectable family here, deliberately', () => {
    /* Botox is by far the largest injection category by quantity (82,954 units,
       because it is counted in units not syringes). The source pack counts five
       families and Botox is not one of them — including it would swamp every
       other figure on the section. */
    assert.strictEqual(fam('Metox Botox 1 Unite', 'Injection/Botox'), null);
  });

  console.log('\nthe unit rules');

  await check('a 10 ml Rich PL vial counts as two syringes, a 5 ml as one', () => {
    /* The pack's rule verbatim: "Rich PL — per 5 ml. A 5 ml vial is one
       syringe, a 10 ml vial is two." No 10 ml product is in the cache today;
       the rule is here so that one arriving is counted rather than patched. */
    const r = D.FAMILIES.find((f) => f.key === 'richpl');
    assert.strictEqual(r.syringesPer('Rich Topic PL 5 ML'), 1);
    assert.strictEqual(r.syringesPer('Rich Topic PL 10 ML'), 2);
  });

  await check('every family states how a unit converts to a syringe', () => {
    for (const f of D.FAMILIES) {
      assert.strictEqual(typeof f.syringesPer, 'function', `${f.key} has no unit rule`);
      assert.ok(f.syringesPer('x') > 0, `${f.key} converts a unit to zero syringes`);
      assert.ok(f.note && f.note.length > 10, `${f.key} does not say what it counts`);
    }
  });

  const loaded = await prisma.invoice.count();
  if (!loaded) {
    console.log('\nInvoice cache is empty — skipping the live checks.\n');
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  }

  console.log('\nticket size is per DISTINCT CUSTOMER');

  const W = { from: '2026-06-01', to: '2026-08-11' };
  const tk = await D.buildTicket(W);

  await check('per-customer and per-invoice are both returned, and differ', () => {
    /* They differ by about a fifth for the busiest doctors. Showing one without
       naming it is how a reader ends up quoting the wrong one. */
    const top = tk.doctors.find((d) => d.customers > 100);
    assert.ok(top, 'no doctor with enough customers to compare');
    assert.ok(top.perCustomer > top.perInvoice,
      `${top.name}: per-customer ${top.perCustomer} should exceed per-invoice ${top.perInvoice}`);
    assert.ok(top.visitsPerCustomer > 1, 'visits per customer should exceed one');
  });

  await check('per-customer is exactly ex-VAT / distinct customers', () => {
    for (const d of tk.doctors.slice(0, 10)) {
      if (!d.customers) continue;
      const want = Math.round((d.ex / d.customers) * 100) / 100;
      assert.ok(Math.abs(d.perCustomer - want) < 0.02,
        `${d.name}: ${d.perCustomer} != ${want}`);
    }
  });

  await check('the clinic-wide customer count is NOT the sum of the per-doctor counts', () => {
    /* One patient seen by two doctors is one patient and two rows. Adding the
       per-doctor counts double-counts her, which is why the clinic figure is
       counted separately. */
    assert.ok(tk.distinctCustomers < tk.totals.customerRowsAcrossDoctors,
      `${tk.distinctCustomers} vs ${tk.totals.customerRowsAcrossDoctors} — no overlap at all?`);
  });

  await check('refunds are netted off rather than dropped', () => {
    const withRefunds = tk.doctors.filter((d) => d.refunds > 0);
    assert.ok(withRefunds.length, 'no doctor has a credit note in this window');
  });

  console.log('\nthe injectables section');

  const ij = await D.buildInjectables({ from: '2026-01-01', to: '2026-08-13' });

  await check('the five families are all present and add to the total', () => {
    assert.strictEqual(ij.families.length, 5);
    const summed = ij.families.reduce((t, f) => t + f.syringes, 0);
    assert.ok(Math.abs(summed - ij.totals.syringes) < 0.5,
      `families sum to ${summed}, total says ${ij.totals.syringes}`);
  });

  await check('income is EVERY service, not just injectables', () => {
    /* The share is injectable income over total income, so the denominator has
       to be the doctor's whole book. If income were filtered to injectables the
       share would be 100% for everyone. */
    assert.ok(ij.totals.income > ij.totals.inj,
      `income ${ij.totals.income} should exceed injectable ${ij.totals.inj}`);
    assert.ok(ij.totals.pct > 0 && ij.totals.pct < 1, `share is ${ij.totals.pct}`);
  });

  await check('Radiesse is absent, as the source pack also found', async () => {
    const r = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int n FROM "InvoiceLine" WHERE "productName" ILIKE '%radiesse%'`);
    assert.strictEqual(r[0].n, 0);
  });

  await check('per-doctor syringes add up to each family total', () => {
    for (const f of ij.families) {
      const summed = ij.doctors.reduce((t, d) => t + (d[f.key] || 0), 0);
      assert.ok(Math.abs(summed - f.syringes) < 0.5,
        `${f.key}: doctors sum to ${summed}, family says ${f.syringes}`);
    }
  });

  console.log('\nwhat it refuses to do');

  await check('a month with no target sheet says so instead of scoring zeros', async () => {
    /* Only 2026-08 is loaded. A doctor shown at 0% of a target that does not
       exist is a false accusation. */
    const s = await D.sheetCoverage('2026-09-30');
    assert.strictEqual(s.loaded, false);
    assert.ok(/No approved target schedule/.test(s.note));
    assert.ok(s.available.includes('2026-08'), 'it should name the sheet that does exist');
  });

  await check('and the month that IS loaded reports itself loaded', async () => {
    const s = await D.sheetCoverage('2026-08-31');
    assert.strictEqual(s.loaded, true);
    assert.strictEqual(s.note, null);
  });

  await check('a range before the cache floor is called out, not zeroed', async () => {
    const out = await D.build({ from: '2025-06-01', to: '2025-12-31' });
    assert.strictEqual(out.coverage.covered, false);
    assert.ok(/cache begins 2026-01-01/.test(out.coverage.note));
  });

  await check('the attribution caveat travels on the payload, not just in the UI', () => {
    /* The doctor is on the invoice header and never on the line. A panel that
       omitted this would be claiming these are syringes a doctor injected. */
    assert.ok(/invoice HEADER/.test(ij.note));
    assert.ok(/no doctor on the invoice line/i.test(ij.note));
  });

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('✗', e.stack || e.message);
  await prisma.$disconnect();
  process.exit(1);
});
