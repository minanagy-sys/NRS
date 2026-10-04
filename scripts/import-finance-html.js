#!/usr/bin/env node
/**
 * Import the Finance Suite report into Postgres as a snapshot.
 *
 *   node scripts/import-finance-html.js <file.html>            # show what it found
 *   node scripts/import-finance-html.js <file.html> --write     # load it
 *
 * The report states its own totals in its header, so nothing here is trusted on
 * faith: every figure this script derives is checked against the figure the
 * report publishes, and the rules in lib/finance-rules.js are re-run against all
 * 625 of its expiry rows and all 57 of its product pairs. A single disagreement
 * refuses the whole import — the same rule the target-sheet importer applies, for
 * the same reason.
 *
 * Idempotent per (section, source): a re-run replaces that section's snapshot and
 * leaves every other section, and anything sourced from Odoo, untouched.
 */

const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from systemd */ }

const { prisma } = require('../src/lib/db.js');
const F = require('../src/lib/finance-rules.js');
const H = require('../src/lib/finance-html.js');

const SOURCE = 'snapshot';
const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const day = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const problems = [];
const checks = [];
function expect(label, got, want, tol = 0.5) {
  const ok = want === null || want === undefined ? null : Math.abs(Number(got) - Number(want)) <= tol;
  checks.push({ label, got, want, ok });
  if (ok === false) problems.push(`${label}: ${money(got)} but the report says ${money(want)}`);
}

/* ------------------------------------------------------------- collections --- */

function readCollections(html) {
  const c = H.readCollections(html);
  const sum = (k) => c.rows.reduce((s, r) => s + r[k], 0);

  expect('collections · net', sum('net'), c.published.net);
  expect('collections · gross', sum('gross'), c.published.gross);
  expect('collections · refunds', sum('refunds'), c.published.refunds);
  expect('collections · package share', sum('packageShare'), c.published.packageShare);
  expect('collections · transactions', c.days.reduce((s, d) => s + d.txns, 0), c.published.txns);
  // The branch grid and the published day summary are two separate tables in the
  // report; if they disagree, one of the two was parsed wrong.
  expect('collections · branch rows = day summary', sum('net'), c.days.reduce((s, d) => s + d.net, 0));

  const group = {};
  for (const r of c.rows) {
    const k = F.availabilityOf(r.register);
    if (!k) { problems.push(`collections: register "${r.register}" is not classified in finance-rules`); continue; }
    group[k] = (group[k] || 0) + r.net;
  }
  expect('collections · same-day T+0', group.t0 || 0, c.published.t0);
  expect('collections · next-day T+1', group.t1 || 0, c.published.t1);
  expect('collections · on settlement', group.settlement || 0, c.published.settlement);

  return c;
}

/* ---------------------------------------------------------------- payables --- */

function readPayables(html) {
  const D = H.sliceObject(html, 'const DATA = ');
  const t = D.meta.totals;
  const bills = D.vendors.flatMap((v) => v.bills.map((b) => ({ ...b, vendor: v.name })));
  const lines = bills.flatMap((b) => b.products.map((p) => ({ ...p, bill: b })));
  const pays = D.vendors.flatMap((v) => v.payments.map((p) => ({ ...p, vendor: v.name })));

  expect('payables · suppliers', D.vendors.length, t.n_vendors, 0);
  expect('payables · bills', bills.length, t.n_bills, 0);
  expect('payables · payments', pays.length, t.n_pays, 0);
  expect('payables · opening balance', r2(D.vendors.reduce((s, v) => s + v.opening, 0)), t.opening_2025);
  expect('payables · closing balance', r2(D.vendors.reduce((s, v) => s + v.closing, 0)), t.closing_current);
  expect('payables · bills gross', r2(D.vendors.reduce((s, v) => s + v.bills_all, 0)), t.bills_all_gross);
  expect('payables · payments total', r2(D.vendors.reduce((s, v) => s + v.pays_all, 0)), t.pays_all);
  expect('payables · bills with bonus', bills.filter((b) => b.bs).length, t.n_bills_with_bonus, 0);
  expect('payables · bonus units', r2(bills.reduce((s, b) => s + b.bq, 0)), t.bonus_qty_total);

  // gross = net + VAT, per bill, to the cent.
  const vatOff = bills.filter((b) => Math.abs(b.g - (b.n + b.v)) > 0.01);
  expect('payables · gross = net + VAT', vatOff.length, 0, 0);

  /* The bonus rule is the one piece of business logic we re-derive rather than
     take from the file, so check our definition against its flag on every line. */
  const bonusOff = lines.filter((l) => F.isBonusLine({ qty: l.q, subtotal: l.v }) !== !!l.b);
  expect('payables · bonus rule agrees on every line', bonusOff.length, 0, 0);

  return { D, bills, lines, pays };
}

/* --------------------------------------------------------- sold vs issued --- */

function readRecon(html) {
  const R = H.sliceObject(html, 'window.__RECON__ = ');
  const sum = (o) => Object.values(o || {}).reduce((s, byDay) =>
    s + Object.values(byDay).reduce((a, x) => a + (Array.isArray(x) ? x[0] : x), 0), 0);
  const sumValue = (o) => Object.values(o || {}).reduce((s, byDay) =>
    s + Object.values(byDay).reduce((a, x) => a + x[1], 0), 0);

  let soldQty = 0, soldValue = 0, out = 0, back = 0, cost = 0, gapPos = 0, gapNeg = 0;
  for (const p of R.products) {
    const sq = sum(p.s), gq = sum(p.x), rq = sum(p.r), net = gq - rq, gap = sq - net;
    soldQty += sq; soldValue += sumValue(p.s); out += gq; back += rq; cost += net * p.uc;
    if (gap > 0) gapPos += gap * p.uc; else gapNeg += -gap * p.uc;
  }

  expect('recon · matched pairs', R.products.length, 57, 0);
  expect('recon · items with no twin', R.unmatched.length, 25, 0);
  expect('recon · units sold', r2(soldQty), 7925.1, 0.05);
  expect('recon · sold value ex-VAT', r2(soldValue), 5086316, 1);
  expect('recon · net issued units', r2(out - back), 6874.7, 0.05);
  expect('recon · net at cost', r2(cost), 1300815, 1);
  expect('recon · positive gap at cost', r2(gapPos), 239243, 1);
  expect('recon · negative gap at cost', r2(gapNeg), 32483, 1);

  /* Our matching rule has to reproduce the report's pairing exactly — and, just
     as importantly, must NOT pair any of the 25 items it left unmatched. */
  const unpaired = R.products.filter((p) => !F.itemsMatch(p.n, p.i));
  expect('recon · matching rule reproduces every pair', unpaired.length, 0, 0);
  const soldKeys = new Set(R.products.map((p) => F.normalizeItemName(p.n)));
  const overmatched = R.unmatched.filter((u) => soldKeys.has(F.normalizeItemName(u.n)));
  expect('recon · matching rule invents no pairs', overmatched.length, 0, 0);

  return R;
}

/* ------------------------------------------------------------------ expiry --- */

function readExpiry(html, asOf) {
  const X = H.sliceObject(html, 'window.__EXPIRY__ = ');

  expect('expiry · rows', X.rows.length, 625, 0);
  expect('expiry · lots', new Set(X.rows.map((r) => `${r.p}|${r.t}`)).size, 552, 0);
  expect('expiry · products', new Set(X.rows.map((r) => r.p)).size, 91, 0);
  expect('expiry · value at cost', r2(X.rows.reduce((s, r) => s + r.v, 0)), 8257090, 1);
  expect('expiry · expired value', r2(X.rows.filter((r) => r.d < 0).reduce((s, r) => s + r.v, 0)), 236613, 1);
  expect('expiry · warehouse value', r2(X.rows.filter((r) => r.w).reduce((s, r) => s + r.v, 0)), 2159874, 1);

  /* The whole reason the verdict is recomputed rather than stored: prove the
     rules reproduce the report on every row, measured from ITS as-of date. */
  let verdictOff = 0, atRiskOff = 0, daysOff = 0;
  for (const r of X.rows) {
    if (F.daysToExpiry(day(r.e), asOf) !== r.d) daysOff++;
    const v = F.expiryVerdict({ qty: r.q, daysLeft: r.d, rate: r.r, isWarehouse: !!r.w });
    if (v.verdict !== r.vd) verdictOff++;
    if (Math.abs(v.atRiskQty - r.rq) > 0.01) atRiskOff++;
  }
  expect('expiry · days to expiry match the as-of date', daysOff, 0, 0);
  expect('expiry · verdict reproduced on every row', verdictOff, 0, 0);
  expect('expiry · at-risk quantity reproduced', atRiskOff, 0, 0);

  return X;
}

/* ------------------------------------------------------------------- write --- */

async function write({ collections, payables, recon, expiry, asOf }) {
  const { D, bills, pays } = payables;

  return prisma.$transaction(async (tx) => {
    /* ---- collections ---- */
    await tx.collection.deleteMany({ where: { source: SOURCE } });
    await tx.collectionDay.deleteMany({ where: { source: SOURCE } });
    await tx.collection.createMany({
      data: collections.rows.map((r) => ({
        date: day(r.date), branch: r.branch, register: r.register,
        gross: r.gross, refunds: r.refunds, net: r.net, packageShare: r.packageShare,
        txns: 0, source: SOURCE,
      })),
    });
    await tx.collectionDay.createMany({
      data: collections.days.map((d) => ({
        date: day(d.date), gross: d.gross, refunds: d.refunds, net: d.net,
        packageShare: d.packageShare, txns: d.txns, source: SOURCE,
      })),
    });
    for (const name of collections.registers) {
      await tx.register.upsert({
        where: { name },
        update: { availability: F.availabilityOf(name) },
        create: { name, availability: F.availabilityOf(name), sortOrder: collections.registers.indexOf(name) },
      });
    }

    /* ---- payables ----
       Deleting the suppliers would cascade to their bills and payments whatever
       the source, so a re-import of this file silently destroyed rows synced from
       Odoo — five of six, the first time. Clear only what this file owns, and
       upsert the suppliers rather than replacing them. */
    await tx.bill.deleteMany({ where: { source: SOURCE } });
    await tx.vendorPayment.deleteMany({ where: { source: SOURCE } });
    for (const v of D.vendors) {
      const data = { category: v.category || null, opening: r2(v.opening), closing: r2(v.closing) };
      await tx.supplier.upsert({
        where: { name: v.name },
        update: data,
        create: { name: v.name, ...data, source: SOURCE },
      });
    }
    // Bills need their ids back so the lines can point at them.
    for (let i = 0; i < bills.length; i += 200) {
      await Promise.all(bills.slice(i, i + 200).map(async (b) => {
        const row = await tx.bill.create({
          data: {
            ref: b.id, supplierName: b.vendor, date: day(b.d),
            gross: r2(b.g), net: r2(b.n), vat: r2(b.v),
            branch: b.br || null, srcSystem: b.src || null, source: SOURCE,
          },
        });
        if (b.products.length) {
          await tx.billLine.createMany({
            data: b.products.map((p) => ({
              billId: row.id, product: p.p, category: p.c || null,
              qty: p.q, unitPrice: r2(p.u), subtotal: r2(p.v),
              isBonus: F.isBonusLine({ qty: p.q, subtotal: p.v }),
            })),
          });
        }
      }));
    }
    await tx.vendorPayment.createMany({
      data: pays.map((p) => ({
        supplierName: p.vendor, date: day(p.d), amount: r2(p.a),
        journal: p.j, ref: p.r || null, method: p.m || null, source: SOURCE,
      })),
    });
    // The journal -> method map, as config that can be corrected later.
    const byJournal = new Map();
    for (const p of pays) if (p.j && p.m) byJournal.set(p.j, p.m);
    for (const [journal, method] of byJournal) {
      await tx.journalMethod.upsert({ where: { journal }, update: { method }, create: { journal, method } });
    }

    /* ---- sold vs issued ---- */
    await tx.reconProduct.deleteMany({ where: { source: SOURCE } });
    const facts = [];
    const addFacts = (id, map, kind) => {
      for (const [branch, byDay] of Object.entries(map || {})) {
        for (const [d, v] of Object.entries(byDay)) {
          facts.push({
            reconProductId: id, branch, date: day(`${asOf.getUTCFullYear()}-${d}`),
            kind, qty: Array.isArray(v) ? v[0] : v, value: Array.isArray(v) ? r2(v[1]) : null,
          });
        }
      }
    };
    for (const p of recon.products) {
      const row = await tx.reconProduct.create({
        data: { label: p.n, soldName: p.n, stockName: p.i, unitCost: p.uc, matched: true, source: SOURCE },
      });
      addFacts(row.id, p.s, 'sold');
      addFacts(row.id, p.x, 'issued');
      addFacts(row.id, p.r, 'returned');
    }
    for (const u of recon.unmatched) {
      const row = await tx.reconProduct.create({
        data: { label: u.n, soldName: null, stockName: u.n, unitCost: u.uc, matched: false, source: SOURCE },
      });
      addFacts(row.id, u.x, 'issued');
      addFacts(row.id, u.r, 'returned');
    }
    for (let i = 0; i < facts.length; i += 500) {
      await tx.reconFact.createMany({ data: facts.slice(i, i + 500) });
    }

    /* ---- expiry ---- */
    await tx.expiryLot.deleteMany({ where: { source: SOURCE } });
    for (let i = 0; i < expiry.rows.length; i += 500) {
      await tx.expiryLot.createMany({
        data: expiry.rows.slice(i, i + 500).map((r) => ({
          location: r.l, isWarehouse: !!r.w, product: r.p, lot: r.t,
          expiry: day(r.e), qty: r.q, value: r2(r.v), unitCost: r2(r.u),
          rateMonthly: r.r === null ? null : r.r,
          companyRate: r.cm === null || r.cm === undefined ? null : r.cm,
          thinMovement: !!r.th, source: SOURCE,
        })),
      });
    }

    /* ---- provenance and the source switch ---- */
    const counts = {
      collections: collections.rows.length,
      payables: D.vendors.length,
      recon: recon.products.length + recon.unmatched.length,
      expiry: expiry.rows.length,
    };
    for (const [section, rowCount] of Object.entries(counts)) {
      await tx.financeBatch.deleteMany({ where: { section, source: SOURCE } });
      await tx.financeBatch.create({ data: { section, source: SOURCE, asOf, rowCount, label: 'Finance Suite Aug2026' } });
      /* Payables has nowhere else to come from — Odoo 18 went live 1 Aug 2026 and
         the Jan–Jul backfill was never loaded — so it is stitched at that seam by
         default. The other three can switch to Odoo wholesale. */
      const mode = section === 'payables' ? 'stitched' : 'snapshot';
      const cutover = section === 'payables' ? day('2026-08-01') : null;
      await tx.financeSource.upsert({
        where: { section }, update: {}, create: { section, mode, cutover },
      });
    }
    return counts;
  }, { timeout: 180_000 });
}

/* -------------------------------------------------------------------- main --- */

(async () => {
  const file = process.argv[2];
  const doWrite = process.argv.includes('--write');
  if (!file) {
    console.error('Usage: node scripts/import-finance-html.js <file.html> [--write]');
    process.exit(2);
  }

  const html = fs.readFileSync(file, 'utf8');
  /* The expiry day counts are measured from the day the report was built, and the
     nav states it. Read it rather than assuming today, or every verdict shifts. */
  const stamped = /class="rsw-date">([A-Z]{3}\s+\d{1,2},\s+\d{4})</.exec(html);
  const asOf = stamped ? new Date(`${stamped[1]} UTC`) : new Date();

  console.log(`\n\x1b[1m▸ ${path.basename(file)}\x1b[0m`);
  console.log(`  as of ${asOf.toISOString().slice(0, 10)}${stamped ? ` (from the report's own header)` : ' (today — the report carried no date)'}`);

  const collections = readCollections(html);
  const payables = readPayables(html);
  const recon = readRecon(html);
  const expiry = readExpiry(html, asOf);

  console.log('');
  for (const c of checks) {
    const mark = c.ok === null ? '\x1b[33m?\x1b[0m' : c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const want = c.ok === false ? `  \x1b[31mreport says ${money(c.want)}\x1b[0m` : '';
    console.log(`  ${mark} ${c.label.padEnd(46)} ${money(c.got).padStart(16)}${want}`);
  }

  if (problems.length) {
    console.error('\n\x1b[31m✗ the report does not reproduce, so nothing was imported:\x1b[0m');
    for (const p of problems) console.error(`    ${p}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log('\n  \x1b[32m✓ every figure matches the report, and the rules reproduce it row by row\x1b[0m');

  if (!doWrite) {
    console.log('\n  Nothing was written. Re-run with --write to import.\n');
    await prisma.$disconnect();
    return;
  }

  const counts = await write({ collections, payables, recon, expiry, asOf });
  console.log(`\n  \x1b[32m✓ imported\x1b[0m — ${counts.collections} collection rows · ${counts.payables} suppliers · `
    + `${counts.recon} recon items · ${counts.expiry} expiry lots`);
  console.log('  Payables is set to "stitched" at 2026-08-01; the rest read the snapshot.\n');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`\n\x1b[31m✗ ${e.stack || e.message}\x1b[0m\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
