#!/usr/bin/env node
/* Seed reports 08 and 09 from the two frozen HTML packs.
 *
 *   node scripts/import-inventory-html.js
 *   node scripts/import-inventory-html.js --dry-run
 *   node scripts/import-inventory-html.js --inventory <file> --procurement <file>
 *
 * WHAT ONLY EXISTS IN THESE FILES
 *
 *   the consumable catalogue   which products are stock worth watching, in what
 *                              unit, and how many doses come out of one — Odoo
 *                              knows none of this
 *   the service → consumable   the join that ties a syringe leaving the fridge
 *     mapping                   to the visit that used it. Odoo invoices a
 *                              SERVICE and stocks a CONSUMABLE and nothing
 *                              connects them
 *   vendor cash-back and       somebody negotiated 10%, and 15% for Eldawlia.
 *     targets                   No system records an agreement
 *   returns to vendors         there are ZERO negative BillLine rows in the
 *                              cache, so these 11 rows are the only record of
 *                              3,047,191 of returns in existence
 *
 * WHY IT IS AN IMPORT AND NOT A FIXTURE — the same reason as
 * scripts/import-report-html.js: copying the numbers into a JS literal works
 * once and rots silently, while reading them out of the file is reproducible and
 * lands in the same tables a real export later replaces, with `source` flipping
 * from `seed` to `upload` and no report code changing.
 *
 * WHY IT PRINTS CONFLICTS RATHER THAN PICKING QUIETLY
 *
 * The purchasing pack states its own headline four different ways:
 *
 *     KPI "Net Purchases"        29,401,633
 *     its 32 vendor rows sum to  28,800,979
 *     its 7 category rows        27,441,676
 *     its 20 cash-back rows      26,943,317
 *
 * and its "Active Vendors" KPI says 31 while the table beneath it has 32 rows
 * and its own subtitle says 32. Returns are the one thing that reconciles
 * exactly — 3,047,191 in all three places it appears.
 *
 * None of those four totals is stored. This report derives its own from `Bill`,
 * which is why the disagreement is printed and filed in `DataUpload.notes`
 * rather than resolved: it is a property of the source, and a month from now
 * somebody will ask why our figure matches none of them.
 *
 * THE MATCHING IS TIERED AND RECORDS WHICH TIER IT USED
 *
 * Names drift between the two files and Odoo — "Saypha" against "Sypha",
 * "Platinium" against "Platinum", "Novuma 1.5 cc" against "Novuma1.5 cc", a
 * "[Exosomes] " category prefix on some service names and an "INV " prefix on
 * others. So a match is attempted exact, then with every non-alphanumeric
 * squashed out, then by prefix, then by containment, and `matchRule` records
 * which one landed. A link found by `contains` deserves a second look and one
 * found by `exact` does not; without recording it the two read identically.
 *
 * AND IT REFUSES RATHER THAN GUESSING. An entry whose consumable cannot be
 * found, or that matches more than one, is written as an UNRESOLVED row with
 * both ids null and the reason in `note`. It contributes to no figure anywhere.
 * A wrong link is worse than a missing one: it moves real units onto the wrong
 * product and both the inflated and the deflated number look plausible.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { prisma } = require('../src/lib/db.js');
const { sliceObject } = require('../src/lib/finance-html.js');
/* The matcher lives in the library, not here. Two copies of these rules is how
   the importer and the report end up disagreeing about which product a line is
   — and the report would be the one that looked wrong. */
const { norm, squash, match, poolOf } = require('../src/lib/consumables.js');

const DRY = process.argv.includes('--dry-run');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};

/* The packs arrive with a browser-added " (1)" / " (3)" in the filename, so the
   default is a search rather than a fixed path. */
function findPack(explicit, needle) {
  if (explicit) return explicit;
  const dir = path.join(os.homedir(), 'Downloads');
  const hit = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html') && f.includes(needle))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (!hit) throw new Error(`No "${needle}" pack in ~/Downloads — pass the path explicitly.`);
  return path.join(dir, hit.f);
}

const b = (s) => console.log(`\n\x1b[1m━━ ${s}\x1b[0m`);
const i = (s) => console.log(`  ${s}`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');

/* ---- the vendor behind a target label ------------------------------------- */

/* Targets are labelled "Eldawlia Pharma - Evetox" and
   "Cosmedix — Ultra deep, Redensity 2, RHA 3" — vendor, separator, products.
   Both dash characters appear, and one label uses neither. */
const vendorOf = (label) => String(label || '').split(/\s+[-—–]\s+/)[0].trim();

/** "Achieved 690 / 1,000 vials" -> 1000 */
function targetQty(nums) {
  for (const n of nums || []) {
    const m = /\/\s*([\d,]+)/.exec(String(n));
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  return null;
}

/** "10%" -> 0.10 */
function rateOf(text) {
  const m = /([\d.]+)\s*%/.exec(String(text || ''));
  return m ? Number(m[1]) / 100 : null;
}

(async () => {
  const invPath = findPack(arg('inventory'), 'Inventory_Performance');
  const procPath = findPack(arg('procurement'), 'Products_and_Procurement');

  console.log(`\n\x1b[1mSeeding reports 08 and 09${DRY ? ' — DRY RUN, nothing is written' : ''}\x1b[0m`);
  i(`inventory   ${invPath}`);
  i(`procurement ${procPath}`);

  const CFG = sliceObject(fs.readFileSync(invPath, 'utf8'), 'window.NVL_CFG=');
  const src = fs.readFileSync(procPath, 'utf8');
  const Q = sliceObject(src, 'const QDATA=');
  const LINK = sliceObject(src, 'const LINK=');

  const conflicts = [];

  /* ---- 1 · the consumable catalogue ------------------------------------- */
  b('The consumable catalogue');

  const entries = Object.entries(CFG.products);
  const aliases = entries.filter(([, p]) => p.m);
  const canon = entries.filter(([, p]) => !p.m);
  i(`${entries.length} entries — ${canon.length} products and ${aliases.length} merge aliases`);
  i(`${CFG.categ_ids.length} Odoo categories · force_products ${JSON.stringify(CFG.force_products || [])}`);
  const dosed = canon.filter(([, p]) => p.d != null).length;
  i(`${dosed} of ${canon.length} state a dose per unit; the rest are one dose per unit`);

  const consumables = canon.map(([id, p]) => ({
    odooId: Number(id),
    name: p.n,
    vendorName: p.v || null,
    category: p.c || null,
    unit: p.u || null,
    dosesPerUnit: p.d == null ? null : p.d,
    mergeIntoOdooId: null,
    source: 'seed',
  }));
  for (const [id, p] of aliases) {
    consumables.push({
      odooId: Number(id),
      /* An alias has no name of its own in the pack — only the id it defers to.
         Naming it after its target is what makes it readable in Admin, and
         `mergeIntoOdooId` is what keeps it out of every count. */
      name: `→ ${(CFG.products[p.m] || {}).n || p.m}`,
      vendorName: null,
      category: (CFG.products[p.m] || {}).c || null,
      unit: (CFG.products[p.m] || {}).u || null,
      dosesPerUnit: null,
      mergeIntoOdooId: Number(p.m),
      source: 'seed',
    });
  }

  const cats = [...new Set(consumables.map((c) => c.category).filter(Boolean))];
  i(`${cats.length} categories: ${cats.join(' · ')}`);

  /* How much of the catalogue our stock snapshot can actually see. A product
     the snapshot has never held cannot be given a cover figure, and saying so
     here is cheaper than wondering on the page. */
  const snap = await prisma.stockQuant.aggregate({ _max: { takenAt: true } });
  if (snap._max.takenAt) {
    const held = await prisma.stockQuant.findMany({
      where: { takenAt: snap._max.takenAt, productId: { in: consumables.map((c) => c.odooId) } },
      select: { productId: true },
      distinct: ['productId'],
    });
    ok(`${held.length} of ${consumables.length} appear in the ${snap._max.takenAt.toISOString().slice(0, 10)} stock snapshot`);
    if (held.length < consumables.length) {
      conflicts.push(`${consumables.length - held.length} catalogue products are absent from the latest StockQuant snapshot; they carry no cover figure.`);
    }
  } else {
    warn('no StockQuant snapshot at all — run scripts/sync.js --stock');
  }

  /* ---- 2 · service → consumable ----------------------------------------- */
  b('The service → consumable mapping');

  const consPool = poolOf(consumables.filter((c) => !c.mergeIntoOdooId), 'name', 'odooId');

  const invLines = await prisma.invoiceLine.groupBy({ by: ['productName', 'productId'] });
  const svcPool = poolOf(invLines.filter((r) => r.productName && r.productId), 'productName', 'productId');
  i(`${Object.keys(LINK).length} entries in the pack · ${svcPool.length} distinct invoiced service names in the cache`);

  const links = [];
  const unresolved = [];
  const byRule = {};
  const claimed = new Map();          // serviceProductId -> packLabel, first wins

  for (const [service, consName] of Object.entries(LINK)) {
    const c = match(consName, consPool);
    if (!c.hits.length) {
      unresolved.push({ packLabel: service, note: `Consumable "${consName}" is not in the catalogue.` });
      continue;
    }
    if (c.hits.length > 1) {
      unresolved.push({ packLabel: service, note: `Consumable "${consName}" matched ${c.hits.length} catalogue products by ${c.rule}; refusing to pick.` });
      continue;
    }
    const s = match(service, svcPool);
    if (!s.hits.length) {
      unresolved.push({ packLabel: service, note: `No invoiced service matches "${service}".` });
      continue;
    }
    byRule[c.rule] = (byRule[c.rule] || 0) + 1;
    for (const hit of s.hits) {
      /* One service cannot burn two different consumables. If two pack entries
         both claim it, the first is kept and the second is reported — silently
         overwriting would make the answer depend on object key order. */
      if (claimed.has(hit.id)) {
        if (claimed.get(hit.id) !== service) {
          conflicts.push(`Service ${hit.id} "${hit.name}" is claimed by both "${claimed.get(hit.id)}" and "${service}"; kept the first.`);
        }
        continue;
      }
      claimed.set(hit.id, service);
      links.push({
        serviceProductId: hit.id,
        serviceName: hit.name,
        packLabel: service,
        consumableOdooId: c.hits[0].id,
        matchRule: `${c.rule}/${s.rule}`,
        source: 'seed',
      });
    }
  }

  ok(`${links.length} links across ${Object.values(byRule).reduce((a, x) => a + x, 0)} pack entries — by rule: ${Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (unresolved.length) {
    warn(`${unresolved.length} entries left UNRESOLVED and stored as such — they count towards nothing:`);
    for (const u of unresolved) i(`    ${u.packLabel} — ${u.note}`);
    conflicts.push(`${unresolved.length} of ${Object.keys(LINK).length} service→consumable links are unresolved.`);
  }

  /* ---- 3 · vendor terms -------------------------------------------------- */
  b('Vendor cash back and targets');

  const YEAR = 2026;
  const terms = new Map();
  const put = (name, patch) => {
    const key = name.trim();
    if (!key) return;
    terms.set(key, { year: YEAR, supplierName: key, source: 'seed', ...(terms.get(key) || {}), ...patch });
  };
  for (const c of Q.cashback || []) put(c.name, { cashbackRate: rateOf(c.rate), basisNote: c.basis || null });
  for (const t of Q.targets || []) {
    put(vendorOf(t.name), { targetLabel: t.name, targetAmount: targetQty(t.nums) });
  }
  const rates = [...new Set((Q.cashback || []).map((c) => c.rate))];
  i(`${(Q.cashback || []).length} cash-back rows (rates: ${rates.join(', ')}) · ${(Q.targets || []).length} targets → ${terms.size} vendors`);
  i(`note kept verbatim: ${String(Q.cashbackNote || '').slice(0, 120)}…`);
  const noRate = [...terms.values()].filter((t) => t.cashbackRate == null).length;
  if (noRate) i(`${noRate} of them have a target but no agreed rate — left NULL, which is not 0%`);

  /* ---- 4 · returns to vendors ------------------------------------------- */
  b('Returns to vendors');

  const returns = (Q.returns || []).map((r) => ({
    date: null,                       // the pack carries no date on a return row
    supplierName: r.vendor,
    product: r.prod,
    category: null,
    qty: Number(String(r.qty).replace(/,/g, '')) || 0,
    unitCost: r.cost == null ? null : Number(r.cost),
    value: Number(r.val) || 0,
    source: 'seed',
  }));
  const retSum = returns.reduce((s, r) => s + r.value, 0);
  i(`${returns.length} rows · ${fmt(retSum)}`);

  const kpiRet = ((Q.kpis || []).find((k) => /return/i.test(k.lab)) || {}).ex;
  const venRet = (Q.vendors || []).reduce((s, v) => s + Math.abs(Number(((v.cells || [])[1] || {}).ex || 0)), 0);
  if (kpiRet != null && Math.abs(retSum - kpiRet) < 2 && Math.abs(venRet - kpiRet) < 2) {
    ok(`reconciles across all three places the pack states it: rows ${fmt(retSum)} · KPI ${fmt(kpiRet)} · vendor table ${fmt(venRet)}`);
  } else {
    warn(`returns do NOT reconcile: rows ${fmt(retSum)} · KPI ${fmt(kpiRet)} · vendor table ${fmt(venRet)}`);
    conflicts.push(`Returns disagree in the source: rows ${fmt(retSum)}, KPI ${fmt(kpiRet)}, vendor table ${fmt(venRet)}.`);
  }
  const noDate = returns.length;
  if (noDate) conflicts.push(`All ${noDate} seeded returns have no date — the pack does not carry one, so they land on the whole year rather than a month.`);

  /* ---- 5 · the pack against itself -------------------------------------- */
  b('What the pack says about itself, and where it disagrees');

  const kpi = (re) => ((Q.kpis || []).find((k) => re.test(k.lab)) || {}).ex;
  const totals = {
    'KPI Net Purchases': kpi(/net purchase/i),
    'its 32 vendor rows': (Q.vendors || []).reduce((s, v) => s + Number(((v.cells || [])[0] || {}).ex || 0), 0),
    'its 7 category rows': (Q.categories || []).reduce((s, c) => s + Number(c.net || 0), 0),
    'its 20 cash-back rows': (Q.cashback || []).reduce((s, c) => s + Number(c.net || 0), 0),
  };
  for (const [k, v] of Object.entries(totals)) i(`${k.padEnd(24)} ${fmt(v).padStart(12)}`);
  const spread = Math.max(...Object.values(totals)) - Math.min(...Object.values(totals));
  warn(`four totals, spread ${fmt(spread)} — none is stored; report 09 derives its own from Bill`);
  conflicts.push(`The pack states net purchases four ways: ${Object.entries(totals).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}. None stored.`);

  const activeKpi = kpi(/active vendor/i);
  if (activeKpi != null && (Q.vendors || []).length !== activeKpi) {
    warn(`"Active Vendors" KPI says ${activeKpi} but the table has ${(Q.vendors || []).length} rows, and the subtitle says ${(/(\d+) vendors/.exec(Q.sub || '') || [])[1]}`);
    conflicts.push(`Active vendors: KPI ${activeKpi} vs ${(Q.vendors || []).length} table rows.`);
  }

  /* Ours against theirs, so the difference is on the record from day one. */
  const mine = await prisma.bill.aggregate({
    where: { date: { gte: new Date('2026-01-01'), lte: new Date('2026-08-31') } },
    _sum: { net: true }, _count: true,
  });
  const vendorCount = (await prisma.bill.findMany({
    where: { date: { gte: new Date('2026-01-01'), lte: new Date('2026-08-31') } },
    select: { supplierName: true }, distinct: ['supplierName'],
  })).length;
  i('');
  i(`our Bill, Jan–Aug 2026:  ${fmt(mine._sum.net)} across ${vendorCount} suppliers, ${mine._count} bills`);
  i('BROADER ON PURPOSE: ours is every payable — rent, advertising and expenses included —');
  i('because that is the scope Mina chose. Report 09 states it and breaks the total down.');
  conflicts.push(`Scope: ours is all payables (${fmt(mine._sum.net)}, ${vendorCount} suppliers) against the pack's product-only ${fmt(totals['KPI Net Purchases'])}, 32 vendors. Chosen deliberately.`);

  /* ---- write ------------------------------------------------------------ */
  if (DRY) {
    b('Dry run');
    i(`would write ${consumables.length} consumables · ${links.length + unresolved.length} links (${unresolved.length} unresolved) · ${terms.size} vendor terms · ${returns.length} returns`);
    await prisma.$disconnect();
    return;
  }

  b('Writing');
  const notes = conflicts.map((c, n) => `${n + 1}. ${c}`).join('\n');

  await prisma.$transaction(async (tx) => {
    /* Seeded rows are replaced wholesale, upload rows are never touched: an
       import re-run must not duplicate the catalogue, and must not delete a
       returns export somebody uploaded afterwards. */
    await tx.consumableLink.deleteMany({ where: { source: 'seed' } });
    await tx.consumable.deleteMany({ where: { source: 'seed' } });
    await tx.purchaseReturn.deleteMany({ where: { source: 'seed' } });

    await tx.consumable.createMany({ data: consumables });
    await tx.consumableLink.createMany({ data: links });
    await tx.consumableLink.createMany({
      data: unresolved.map((u) => ({ ...u, source: 'seed' })),
    });
    await tx.purchaseReturn.createMany({ data: returns });

    /* Vendor terms are UPSERTED, never replaced. A rate somebody corrected in
       Admin is a decision; re-running this script must not undo it, which is
       exactly the mistake the commission delta made once. */
    for (const t of terms.values()) {
      await tx.vendorTerm.upsert({
        where: { year_supplierName: { year: t.year, supplierName: t.supplierName } },
        update: {},
        create: t,
      });
    }
  });

  await prisma.dataUpload.create({
    data: {
      kind: 'consumables:seed',
      filename: `${path.basename(invPath)} + ${path.basename(procPath)}`,
      rowsWritten: consumables.length + links.length + unresolved.length + terms.size + returns.length,
      notes,
      actor: 'import-inventory-html',
    },
  });

  ok(`${consumables.length} consumables (${aliases.length} aliases)`);
  ok(`${links.length} resolved links · ${unresolved.length} unresolved, stored and counted nowhere`);
  ok(`${terms.size} vendor terms upserted — existing rates left exactly as they were`);
  ok(`${returns.length} returns, ${fmt(retSum)}`);
  ok(`${conflicts.length} source conflicts recorded in DataUpload.notes`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`\n\x1b[31m✗ ${e.message}\x1b[0m\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
