/**
 * Report 08 — the dose conversion, the bands, and the refusals.
 *
 *   node test/inventory.test.js
 *
 * THE DOSE CONVERSION IS WHY THIS FILE EXISTS. Odoo stocks botox by the dose
 * and a report that reads the snapshot as units is 4.6× out on the headline and
 * 100× out on one product — and every syringe on the page is still correct,
 * which means the error hides in exactly the places nobody spot-checks. The
 * conversion is pinned here in both directions, along with the rule that a
 * money figure stays on the dose basis because `BillLine.qty` counts doses too.
 *
 * The bands are pinned because they are the report's whole claim, and the
 * ordering is load-bearing: "Not linked" has to win over "Dormant" or 57
 * products with no service mapping get reported as having no demand.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const I = require('../src/lib/inventory.js');
const C = require('../src/lib/consumables.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

(async () => {
  console.log('\nthe bands, most urgent first');

  await check('the pack\'s constants are the ones in force', () => {
    /* Changing any of these changes what "short" means on every screen, so they
       are asserted rather than trusted to a literal in the render code. */
    assert.strictEqual(I.IDEAL_MONTHS, 2.0);
    assert.strictEqual(I.CRIT, 1.0);
    assert.strictEqual(I.BELOW, 2.0);
    assert.strictEqual(I.HEAL, 4.0);
    assert.strictEqual(I.NOM_DAYS, 30);
  });

  await check('"Not linked" beats "Dormant", which is the whole point of the order', () => {
    /* An unlinked product has no visible sales BY CONSTRUCTION. Filing it as
       dormant would report an absence of information as an absence of demand,
       and dormant is a state somebody acts on. */
    assert.strictEqual(I.bandOf(0, 0, 400, false).key, 'nolink');
    assert.strictEqual(I.bandOf(0, 0, 400, true).key, 'unk');
    assert.strictEqual(I.BANDS.findIndex((b) => b.key === 'nolink') <
      I.BANDS.findIndex((b) => b.key === 'unk'), true);
  });

  await check('a linked product with sales and no stock is a stock-out, not dormant', () => {
    assert.strictEqual(I.bandOf(0, 15, 0, true).key, 'exp');
    /* And with no sales it is dormant even at zero stock: nothing is waiting. */
    assert.strictEqual(I.bandOf(0, 0, 0, true).key, 'unk');
  });

  await check('the four cover bands split exactly where the constants say', () => {
    const at = (cover) => I.bandOf(cover, 10, 10, true).key;
    assert.strictEqual(at(0.9), 'cri', 'under a month is critical');
    assert.strictEqual(at(1.0), 'war', 'exactly one month is no longer critical');
    assert.strictEqual(at(1.9), 'war');
    assert.strictEqual(at(2.0), 'ok', 'the ideal itself is healthy, not below it');
    assert.strictEqual(at(4.0), 'ok', 'the top of healthy is inclusive');
    assert.strictEqual(at(4.1), 'wat', 'past it is overstock');
  });

  await check('"short" is the three bands somebody has to do something about', () => {
    assert.deepStrictEqual([...I.SHORT].sort(), ['cri', 'exp', 'war']);
    /* Overstock and dormant are problems too, but not ORDERING problems, and
       counting them as short would put 31 products on a purchase list. */
    assert.ok(!I.SHORT.has('wat') && !I.SHORT.has('unk') && !I.SHORT.has('nolink'));
  });

  console.log('\nthe name matcher, and what it refuses');

  await check('the tiers run exact, squash, prefix, contains — in that order', () => {
    assert.deepStrictEqual(C.TIERS.map((t) => t[0]), ['exact', 'squash', 'prefix', 'contains']);
  });

  await check('a single exact match beats twenty containment matches', () => {
    /* Falling through to a later tier once an earlier one has hits would let
       "Botox" drag in every botox product ever bought. */
    const pool = C.poolOf([
      { id: 1, name: 'Metox' }, { id: 2, name: 'Metox Botox 1 Unite' }, { id: 3, name: 'INV Metox' },
    ], 'name', 'id');
    const m = C.match('Metox', pool);
    assert.strictEqual(m.rule, 'exact');
    /* "INV Metox" normalises to "metox" too — both are exact, and that is
       correct: Odoo lists the same thing twice and both must resolve. */
    assert.deepStrictEqual(m.hits.map((h) => h.id).sort(), [1, 3]);
  });

  await check('spelling drift is caught by squash but a real typo is not', () => {
    const pool = C.poolOf([{ id: 1, name: 'Novuma1.5 cc' }, { id: 2, name: 'Sypha Volume' }], 'name', 'id');
    assert.strictEqual(C.matchOne('Novuma 1.5 cc', pool).rule, 'squash');
    /* "Saypha" against "Sypha" is a different word. It stays unresolved, which
       is why 18 of the pack's 76 links are stored as refusals. */
    const miss = C.matchOne('Saypha Volume', pool);
    assert.strictEqual(miss.hit, null, `matched anyway by ${miss.rule}`);
  });

  await check('ambiguity is a refusal, never the first row', () => {
    const pool = C.poolOf([{ id: 1, name: 'Pbserum High' }, { id: 2, name: 'Pbserum High Kit' }], 'name', 'id');
    const m = C.matchOne('Pbserum', pool);
    assert.strictEqual(m.hit, null);
    assert.ok(/ambiguous/.test(m.rule), m.rule);
  });

  await check('MONEY may not be built on a containment match', () => {
    /* MEASURED: allowing it valued 1,393 ml of Exocell at 15,481,308 — 56% of
       the whole stock figure and eleven times what it is worth — because Odoo
       stocks it in millilitres and buys "DQ EXOCELL 10ML Vial" by the vial. */
    assert.ok(C.COST_TIERS.has('exact') && C.COST_TIERS.has('squash') && C.COST_TIERS.has('prefix'));
    assert.ok(!C.COST_TIERS.has('contains'), 'containment must not carry a price');
  });

  const loaded = await prisma.consumable.count();
  if (!loaded) {
    console.log('\nCatalogue is empty — run scripts/import-inventory-html.js. Skipping live checks.\n');
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  }

  console.log('\nthe catalogue, live');

  const cat = await C.catalogue();

  await check('the merge aliases are folded away, not counted as products', () => {
    /* Odoo lists five of these twice. Counting an alias as its own SKU halves a
       stock figure, and both halves look like plausible products. */
    assert.strictEqual(cat.aliases, 5, `${cat.aliases} aliases`);
    assert.strictEqual(cat.rows.length, 101, `${cat.rows.length} products`);
    for (const [alias, target] of cat.aliasOf) {
      assert.notStrictEqual(alias, target, 'an alias points at itself');
      assert.strictEqual(cat.canonical(alias), target);
      assert.ok(cat.byId.has(target), `alias ${alias} points at ${target}, which is not a product`);
      assert.ok(!cat.byId.has(alias), `alias ${alias} is also listed as a product`);
    }
  });

  await check('a missing dose factor is ONE, never zero', () => {
    /* Zero would make cover Infinity for 63 products, and Infinity reads as
       "plenty" on a page. */
    for (const r of cat.rows) {
      assert.ok(r.dosesPerUnit > 0, `${r.name} has dosesPerUnit ${r.dosesPerUnit}`);
    }
    const botox = cat.rows.filter((r) => r.category === 'Botox');
    assert.ok(botox.length >= 4, 'the botox family is missing');
    assert.ok(botox.some((b) => b.dosesPerUnit >= 100), 'no multi-dose botox vial in the catalogue');
  });

  console.log('\nthe dose conversion');

  const cover = await I.buildCover({ from: '2026-08-01', to: '2026-08-27' });

  await check('on hand is UNITS and doses is what Odoo said, and they differ 4.6x overall', () => {
    const units = cover.rows.reduce((t, r) => t + r.onHand, 0);
    const doses = cover.rows.reduce((t, r) => t + r.onHandDoses, 0);
    assert.ok(doses > units * 3, `doses ${doses} vs units ${units} — the conversion did not happen`);
    /* MEASURED against the source pack's own headline of 4,081.9 units. */
    assert.ok(Math.abs(units - 4081.9) / 4081.9 < 0.10,
      `${units.toFixed(1)} units is more than 10% from the pack's 4,081.9`);
  });

  await check('a 100-dose vial converts, a one-dose syringe does not', () => {
    const multi = cover.rows.filter((r) => r.dosesPerUnit > 1 && r.onHandDoses > 0);
    assert.ok(multi.length, 'no multi-dose product holds stock');
    for (const r of multi) {
      assert.ok(Math.abs(r.onHand - r.onHandDoses / r.dosesPerUnit) < 0.01,
        `${r.name}: ${r.onHand} != ${r.onHandDoses}/${r.dosesPerUnit}`);
      assert.ok(r.onHand < r.onHandDoses, `${r.name} did not shrink`);
    }
    const single = cover.rows.filter((r) => r.dosesPerUnit === 1 && r.onHandDoses > 0);
    for (const r of single.slice(0, 20)) {
      assert.strictEqual(r.onHand, r.onHandDoses, `${r.name} was converted when it should not be`);
    }
  });

  await check('VALUE stays on the dose basis, because the purchase price is per dose', () => {
    /* 6,000 Metox at 15 EGP is a dose price. Multiplying converted units by it
       would divide the value of every multi-dose product by its dose factor. */
    /* `unitCost` and `monthlyRate` are rounded for display and `value` is not,
       so the comparison is relative — a 100× basis error is what this is for,
       not a rounding artefact in the second decimal. */
    for (const r of cover.rows.filter((x) => x.value != null && x.dosesPerUnit > 1)) {
      const want = r.onHandDoses * r.unitCost;
      /* 1% relative: `unitCost` is rounded to the piastre for display, which on
         a 2 EGP dose price is a tenth of a percent all by itself. */
      assert.ok(want === 0 || Math.abs(r.value - want) / want < 0.01,
        `${r.name}: value ${r.value} is not doses ${r.onHandDoses} x ${r.unitCost}`);
      /* And the unit-basis version must be wrong by the dose factor, which is
         the actual claim: the two are not interchangeable. */
      assert.ok(Math.abs(r.value - r.onHand * r.unitCost) > want * 0.1,
        `${r.name}: value is the same either way — is dosesPerUnit really ${r.dosesPerUnit}?`);
    }
  });

  await check('cover is units over units, never units over doses', () => {
    for (const r of cover.rows.filter((x) => x.coverMonths != null && x.monthlyRate > 0)) {
      const want = r.onHand / r.monthlyRate;
      /* Absolute OR relative: `coverMonths` is rounded to two places, which on
         a cover of 0.39 months is already 1% of the value. Either tolerance
         catches a dose/unit mix-up, which is off by the dose factor. */
      const gap = Math.abs(r.coverMonths - want);
      assert.ok(want === 0 ? r.coverMonths === 0 : gap < 0.01 || gap / want < 0.01,
        `${r.name}: cover ${r.coverMonths} != ${r.onHand}/${r.monthlyRate}`);
      /* The error worth catching: doses over the same rate, which for a
         100-dose vial reads as a hundred months of cover. Skipped at zero
         stock, where both readings are zero and prove nothing. */
      if (r.dosesPerUnit > 1 && want > 0) {
        assert.ok(Math.abs(r.coverMonths - r.onHandDoses / r.monthlyRate) > want * 0.1,
          `${r.name}: cover looks like it used doses`);
      }
    }
  });

  await check('the stock value lands within 10% of the pack, having refused what it cannot verify', () => {
    /* The pack says 9,062,144 on a snapshot taken a different day. Ours is on
       the first three match tiers only; letting `contains` in made it
       27,558,890. */
    const v = cover.valued.total;
    assert.ok(Math.abs(v - 9062144) / 9062144 < 0.10, `${v} is more than 10% from 9,062,144`);
    assert.ok(cover.valued.unverifiedProducts > 0, 'nothing was refused — is the tier rule still on?');
    assert.ok(cover.valued.unverifiedTotal > 0);
  });

  console.log('\nwhat the report refuses to say');

  await check('every band is populated by a rule, and the counts add to the catalogue', () => {
    const summed = cover.bands.reduce((t, b) => t + b.count, 0);
    assert.strictEqual(summed, cover.rows.length, `bands sum to ${summed}, rows are ${cover.rows.length}`);
  });

  await check('unlinked products are counted, and it is not a small number', () => {
    assert.ok(cover.counts.nolink > 0, 'no product is unlinked — did the seed change?');
    const unlinkedRows = cover.rows.filter((r) => !r.linked);
    assert.strictEqual(unlinkedRows.length, cover.counts.nolink);
    for (const r of unlinkedRows) {
      assert.strictEqual(r.usedUnits, 0, `${r.name} is unlinked but has usage`);
      assert.strictEqual(r.band, 'nolink');
    }
  });

  await check('the unresolved links are reported rather than quietly dropped', () => {
    const L = cover.linkCoverage;
    assert.ok(L.unresolved > 0, 'nothing unresolved — the refusal path is untested');
    assert.strictEqual(L.resolved + L.unresolved, L.total);
    for (const u of L.unresolvedList) {
      assert.ok(u.note && u.note.length > 10, `an unresolved link has no reason: ${JSON.stringify(u)}`);
    }
  });

  await check('a range before the invoice cache is clamped and SAYS so', () => {
    return I.build({ from: '2025-01-01', to: '2026-08-27' }).then((r) => {
      assert.ok(r.clamped, 'a 2025 range was not clamped');
      assert.strictEqual(r.from, I.CACHE_FLOOR);
      assert.strictEqual(r.clamped.asked, '2025-01-01');
    });
  });

  await check('the expiry states partition the lots — every lot in exactly one', async () => {
    const e = await I.buildExpiry({ to: '2026-09-09' });
    assert.ok(!e.missing, 'no expiry lots loaded');
    const summed = e.states.reduce((t, b) => t + b.lots, 0);
    assert.strictEqual(summed, e.totals.lots, `states hold ${summed} of ${e.totals.lots} lots`);
    const value = e.states.reduce((t, b) => t + b.value, 0);
    assert.ok(Math.abs(value - e.totals.value) < 1, `state value ${value} != total ${e.totals.value}`);
    /* And every product's lots sum to its own card, which is what the expansion
       claims on screen — "Total, reconciles to card". */
    for (const p of e.products) {
      const q = p.lots.reduce((t, l) => t + l.qty, 0);
      const v = p.lots.reduce((t, l) => t + l.value, 0);
      assert.ok(Math.abs(q - p.qty) < 0.01, `${p.product}: lots ${q} vs card ${p.qty}`);
      assert.ok(Math.abs(v - p.value) < 0.02, `${p.product}: lots ${v} vs card ${p.value}`);
      assert.strictEqual(p.lotCount, p.lots.length);
    }
  });

  await check('a product\'s state is its WORST lot, never an average', async () => {
    /* One expired lot among nine good ones is an expired lot somebody has to
       deal with. Averaging would file it as OK. */
    const e = await I.buildExpiry({ to: '2026-09-09' });
    const rank = (k) => I.EXPIRY_STATES.findIndex((sv) => sv.key === k);
    for (const p of e.products) {
      const worst = Math.min(...p.lots.filter((l) => l.state !== 'unk').map((l) => rank(l.state)));
      if (Number.isFinite(worst)) {
        assert.strictEqual(rank(p.state), worst,
          `${p.product} is ${p.state} but holds a ${I.EXPIRY_STATES[worst].key} lot`);
      }
    }
  });

  await check('the register is in DOSES, and the payload says so', async () => {
    /* ExpiryLot.qty sits in the same basis as StockQuant and BillLine — an
       Evetox lot is 268 at 25 EGP, a price per dose. Calling it "units" is what
       made the at-risk margin read 99.9%. */
    const e = await I.buildExpiry({ to: '2026-09-09' });
    assert.strictEqual(e.basis, 'doses');
    for (const p of e.products.slice(0, 20)) {
      for (const l of p.lots) {
        if (l.unitCost > 0 && l.qty > 0) {
          assert.ok(Math.abs(l.value - l.qty * l.unitCost) / l.value < 0.02,
            `${p.product}: ${l.value} != ${l.qty} x ${l.unitCost}`);
        }
      }
    }
  });

  await check('every value carries an inc-VAT twin at exactly 14%', async () => {
    const e = await I.buildExpiry({ to: '2026-09-09' });
    assert.strictEqual(e.vat, 0.14);
    assert.ok(Math.abs(e.totals.valueInc - e.totals.value * 1.14) < 1);
    for (const p of e.products.slice(0, 20)) {
      assert.ok(Math.abs(p.valueInc - p.value * 1.14) < 0.05, p.product);
    }
  });

  await check('at-risk stock that cannot be matched is listed, not folded into a total', async () => {
    const a = await I.buildAtRisk({ from: '2026-08-01', to: '2026-08-27' });
    assert.ok(!a.missing);
    assert.ok(a.unmatched.length > 0, 'nothing unmatched — the refusal path is untested');
    /* The unmatched value must NOT be inside atRiskValue: it belongs to no
       catalogue product, and adding it would attribute it to the wrong one. */
    const rowsSum = a.rows.reduce((t, r) => t + r.atRiskValue, 0);
    assert.ok(Math.abs(rowsSum - a.totals.atRiskValue) < 1);
    assert.ok(a.totals.unmatchedValue > 0);
  });

  console.log('\nFEFO, and the margin on rescued stock');

  const AR = await I.buildAtRisk({ from: '2026-07-01', to: '2026-08-01' });

  await check('sales are drawn against lots in DOSES, not converted units', async () => {
    /* The bug this pins: the lot queue is in doses (the register's basis) and a
       converted-unit sale drawn against it reported 9 vials of revenue against 9
       doses of cost — a 99.9% margin on Metox. */
    for (const r of AR.rows) {
      const drawn = r.branches
        .flatMap((b) => b.doctors).flatMap((d) => d.lines)
        .reduce((t, l) => t + l.fromAtRiskDoses, 0);
      assert.ok(Math.abs(drawn - r.rescuedDoses) < 0.05,
        `${r.product}: lines drew ${drawn} but the card says ${r.rescuedDoses}`);
      /* And no line may draw more than it sold. */
      for (const b of r.branches) {
        for (const d of b.doctors) {
          for (const l of d.lines) {
            assert.ok(l.fromAtRiskDoses <= l.doses + 0.001,
              `${r.product} ${l.ref}: drew ${l.fromAtRiskDoses} of ${l.doses}`);
          }
        }
      }
    }
  });

  await check('a lot is never drawn beyond what it held', async () => {
    for (const r of AR.rows) {
      const perLot = new Map();
      r.branches.flatMap((b) => b.doctors).flatMap((d) => d.lines)
        .flatMap((l) => l.drawn)
        .forEach((x) => {
          const k = `${x.expiry}|${x.location}`;
          perLot.set(k, (perLot.get(k) || 0) + x.qty);
        });
      assert.ok(r.rescuedDoses <= r.atRisk + 0.05,
        `${r.product}: drew ${r.rescuedDoses} from ${r.atRisk} at risk`);
      assert.ok(Math.abs(r.rescuedDoses + r.stillAtRisk - r.atRisk) < 0.05,
        `${r.product}: ${r.rescuedDoses} drawn + ${r.stillAtRisk} left != ${r.atRisk} at risk`);
    }
  });

  await check('the margin is revenue minus what those lots were carried at', async () => {
    for (const r of AR.rows) {
      assert.ok(Math.abs(r.margin - (r.rescuedEx - r.rescuedCost)) < 0.02, r.product);
      if (r.rescuedEx > 0) {
        assert.ok(r.marginPct != null && r.marginPct <= 100.01,
          `${r.product}: margin ${r.marginPct}% of revenue`);
      }
    }
    assert.ok(Math.abs(AR.totals.margin - (AR.totals.rescuedEx - AR.totals.rescuedCost)) < 0.05);
  });

  await check('branch and doctor cuts are the same sales read twice', () => {
    for (const r of AR.rows) {
      const b = r.branches.reduce((t, x) => t + x.ex, 0);
      const d = r.branches.flatMap((x) => x.doctors).reduce((t, x) => t + x.ex, 0);
      assert.ok(Math.abs(b - d) < 0.05, `${r.product}: branches ${b} vs doctors ${d}`);
      const lines = r.branches.flatMap((x) => x.doctors).flatMap((x) => x.lines).length;
      assert.strictEqual(lines, r.soldLines, r.product);
    }
  });

  console.log('\nthe movement ledger');

  await check('a window with one snapshot is REFUSED, not given a fake opening', async () => {
    /* Deriving opening from closing makes the ledger cross-foot to zero
       movement — perfectly balanced and empty of information. */
    const one = await I.buildLedger({ from: '2026-01-01', to: '2026-01-31' });
    assert.strictEqual(one.missing, true);
    assert.ok(one.reason && one.reason.length > 20, one.reason);
  });

  const LG = await I.buildLedger({ from: '2026-08-10', to: '2026-08-27' });

  await check('the ledger cross-foots, because Adjust is the residual', () => {
    assert.ok(!LG.missing, LG.reason);
    assert.ok(Math.abs(LG.crossFoot) < 0.01, `residual ${LG.crossFoot}`);
    const c = LG.company;
    const want = c.opening + c.receipts + c.bonus - c.sales - c.returned + c.adjust;
    assert.ok(Math.abs(want - c.closing) < 0.01, `${want} != ${c.closing}`);
  });

  await check('opening and closing are REAL snapshots, not the dates asked for', () => {
    assert.ok(LG.openingAt && LG.closingAt);
    assert.notStrictEqual(LG.openingAt, LG.closingAt);
    /* And closing must equal the same count the Cover tab reads. */
    assert.strictEqual(LG.closingAt, cover.snapshotAt);
  });

  await check('every category sums to the company ledger', () => {
    for (const k of ['opening', 'receipts', 'bonus', 'sales', 'returned', 'adjust', 'closing']) {
      const summed = LG.categories.reduce((t, g) => t + g[k], 0);
      assert.ok(Math.abs(summed - LG.company[k]) < 0.05,
        `${k}: categories ${summed} vs company ${LG.company[k]}`);
    }
    const rows = LG.categories.reduce((t, g) => t + g.rows.length, 0);
    assert.strictEqual(rows, LG.rows.length);
  });

  await check('and every SKU sums to its own category', () => {
    for (const g of LG.categories) {
      for (const k of ['opening', 'receipts', 'sales', 'closing']) {
        const summed = g.rows.reduce((t, r) => t + r[k], 0);
        assert.ok(Math.abs(summed - g[k]) < 0.05, `${g.category} ${k}: ${summed} vs ${g[k]}`);
      }
    }
  });

  await check('a product that will not clear before it expires is flagged as such', async () => {
    const a = await I.buildAtRisk({ from: '2026-01-01', to: '2026-08-27' });
    for (const r of a.rows) {
      if (r.monthsToClear == null || r.monthsLeft == null) {
        assert.strictEqual(r.willClear, null, `${r.product} claims a verdict with no figures`);
      } else {
        assert.strictEqual(r.willClear, r.monthsToClear <= r.monthsLeft, r.product);
      }
    }
  });

  console.log(failures ? `\n${failures} failed\n` : '\n✓ report 08 counts doses as doses and units as units\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
