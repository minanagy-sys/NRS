/* ============================================================
   Every finance cut, straight out of Postgres.

   Four sections that share nothing but a page: collections (customer receipts by
   register), payables (supplier balances, bills and payments), sold-vs-issued
   (invoice lines against stock moves) and expiry risk (lot-tracked stock).

   Each section reads whichever source it is set to — see resolve() below. The
   arithmetic that decides a verdict, a bucket or a grouping lives in
   lib/finance-rules.js, never here, so the page and the importer cannot disagree
   about it.
   ============================================================ */

const { prisma, num } = require('./db.js');
const F = require('./finance-rules.js');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const N = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const SECTIONS = ['collections', 'payables', 'recon', 'expiry'];

/**
 * Which rows a section may read.
 *
 * `snapshot` and `odoo` are one source each. `stitched` reads the snapshot before
 * the cutover and Odoo from it onward — the honest setting for payables, whose
 * history predates Odoo 18 entirely.
 *
 * Undated tables (suppliers, product pairs, registers) have no date to stitch on,
 * so they follow the mode's primary source: the snapshot unless the section has
 * been moved wholly to Odoo.
 */
async function resolve() {
  const rows = await prisma.financeSource.findMany();
  const bySection = Object.fromEntries(rows.map((r) => [r.section, r]));
  const out = {};
  for (const section of SECTIONS) {
    const s = bySection[section] || { mode: 'snapshot', cutover: null };
    out[section] = {
      mode: s.mode,
      cutover: s.cutover ? ymd(s.cutover) : null,
      primary: s.mode === 'odoo' ? 'odoo' : 'snapshot',
    };
  }
  return out;
}

/**
 * A SQL predicate over `source` and a date column, honouring the mode.
 * `srcCol` is spelled out so a joined query can qualify it — patching the column
 * names into the finished string afterwards was one careless regex away from
 * corrupting a date literal.
 */
function sourceWhere(cfg, dateCol, srcCol = 'source') {
  if (cfg.mode === 'snapshot') return `${srcCol} = 'snapshot'`;
  if (cfg.mode === 'odoo') return `${srcCol} = 'odoo'`;
  const c = cfg.cutover || '1970-01-01';
  return `((${srcCol} = 'snapshot' AND ${dateCol} < DATE '${c}')`
    + ` OR (${srcCol} = 'odoo' AND ${dateCol} >= DATE '${c}'))`;
}

const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);

/* ------------------------------------------------------------- collections --- */

/* Just the collections totals, for the Sales overview card.
 *
 * The full buildCollections() below returns days, registers, branches and two
 * grids — far too much work to run on every report load for one KPI. This shares
 * its `cfg` and its sourceWhere() predicate, so the figure on the Sales tab is
 * the same definition the finance report used and cannot drift from it.
 *
 * It also reports the window it ACTUALLY covers, which matters: the imported
 * snapshot stops on 2026-08-10, so a report showing 1-20 August would otherwise
 * put 10 days of collections next to 20 days of revenue and invite the reader to
 * divide one by the other.
 */
async function collectionsTotals(cfg, { from, to }) {
  const where = sourceWhere(cfg, 'date');
  const rows = await q(
    `SELECT COALESCE(SUM(gross),0) AS gross,
            COALESCE(SUM(refunds),0) AS refunds,
            COALESCE(SUM(net),0) AS net,
            COALESCE(SUM("packageShare"),0) AS packages,
            COUNT(DISTINCT branch)::int AS branches,
            COUNT(DISTINCT date)::int AS days,
            MIN(date) AS "firstDay",
            MAX(date) AS "lastDay"
       FROM "Collection"
      WHERE ${where} AND date >= $1::date AND date <= $2::date`, from, to);
  const r = rows[0] || {};
  const n = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
  const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return {
    mode: cfg.mode,
    gross: n(r.gross), refunds: n(r.refunds), net: n(r.net), packages: n(r.packages),
    branches: r.branches || 0,
    days: r.days || 0,
    firstDay: ymd(r.firstDay), lastDay: ymd(r.lastDay),
    /* true when the collections data does not reach the end of the requested
       range — the card says so rather than looking like a shortfall */
    coversRange: !!r.lastDay && ymd(r.lastDay) >= to && ymd(r.firstDay) <= from,
    requestedFrom: from, requestedTo: to,
  };
}

async function buildCollections(cfg, { from, to }) {
  const where = sourceWhere(cfg, 'date');
  const range = `date >= $1::date AND date <= $2::date`;

  const [days, byRegister, byBranch, grid, branchGrid, published] = await Promise.all([
    q(`SELECT date, gross, refunds, net, "packageShare", txns FROM "CollectionDay"
       WHERE ${sourceWhere(cfg, 'date')} AND ${range} ORDER BY date`, from, to),
    q(`SELECT register, SUM(net) net, SUM("packageShare") pkg, SUM(refunds) refunds
       FROM "Collection" WHERE ${where} AND ${range} GROUP BY register`, from, to),
    q(`SELECT branch, SUM(net) net, SUM("packageShare") pkg, SUM(refunds) refunds
       FROM "Collection" WHERE ${where} AND ${range} GROUP BY branch ORDER BY 2 DESC`, from, to),
    q(`SELECT date, register, SUM(net) net, SUM("packageShare") pkg, SUM(refunds) refunds
       FROM "Collection" WHERE ${where} AND ${range} GROUP BY date, register ORDER BY date`, from, to),
    q(`SELECT branch, date, register, net, "packageShare" pkg, refunds
       FROM "Collection" WHERE ${where} AND ${range} ORDER BY branch, date`, from, to),
    q(`SELECT SUM(gross) gross, SUM(refunds) refunds, SUM(net) net, SUM("packageShare") pkg, SUM(txns) txns
       FROM "CollectionDay" WHERE ${sourceWhere(cfg, 'date')} AND ${range}`, from, to),
  ]);

  const registers = byRegister
    .map((r) => ({ name: r.register, availability: F.availabilityOf(r.register), net: r2(N(r.net)), pkg: r2(N(r.pkg)) }))
    .sort((a, b) => b.net - a.net);

  /* Group by when the money is usable, not by which register took it. A register
     nobody has classified is reported as such rather than dropped into T+0. */
  /* Registers keep the order the rules declare them in, not the order their
     totals happen to fall in — the grid reads as fixed columns, and a quiet day
     for one register should not move it across the table. */
  const availability = F.AVAILABILITY.map((g) => {
    const present = g.registers.filter((name) => registers.some((r) => r.name === name));
    return {
      key: g.key,
      label: g.label,
      registers: present,
      net: r2(present.reduce((s, name) => s + (registers.find((r) => r.name === name) || { net: 0 }).net, 0)),
    };
  }).filter((g) => g.registers.length);
  const unclassified = registers.filter((r) => !r.availability);

  const p = published[0] || {};
  const byDayRegister = {};
  for (const row of grid) {
    const d = ymd(row.date);
    (byDayRegister[d] || (byDayRegister[d] = {}))[row.register] = { net: r2(N(row.net)), pkg: r2(N(row.pkg)), refunds: r2(N(row.refunds)) };
  }
  const perBranch = {};
  for (const row of branchGrid) {
    const b = (perBranch[row.branch] || (perBranch[row.branch] = { name: row.branch, days: {} }));
    const d = ymd(row.date);
    (b.days[d] || (b.days[d] = {}))[row.register] = { net: r2(N(row.net)), pkg: r2(N(row.pkg)), refunds: r2(N(row.refunds)) };
  }

  return {
    totals: {
      gross: r2(N(p.gross)), refunds: r2(N(p.refunds)), net: r2(N(p.net)),
      packageShare: r2(N(p.pkg)), txns: N(p.txns),
      branches: byBranch.length,
    },
    days: days.map((d) => ({
      date: ymd(d.date), gross: r2(N(d.gross)), refunds: r2(N(d.refunds)),
      net: r2(N(d.net)), packageShare: r2(N(d.packageShare)), txns: N(d.txns),
    })),
    registers, availability, unclassified: unclassified.map((r) => r.name),
    branches: byBranch.map((b) => ({ name: b.branch, net: r2(N(b.net)), pkg: r2(N(b.pkg)), refunds: r2(N(b.refunds)) })),
    byDayRegister,
    perBranch: Object.values(perBranch).sort((a, b) => {
      const an = byBranch.find((x) => x.branch === a.name), bn = byBranch.find((x) => x.branch === b.name);
      return N(bn && bn.net) - N(an && an.net);
    }),
  };
}

/* ---------------------------------------------------------------- payables --- */

async function buildPayables(cfg) {
  const bw = sourceWhere(cfg, 'date');
  const bwBill = sourceWhere(cfg, 'b.date', 'b.source');
  const primary = `s.source = '${cfg.primary}'`;

  const [totals, suppliers, byYear, monthly, categories, topProducts, methods, monthlyMethods, bonusVendors, bonusProducts] =
    await Promise.all([
      /* Counted over the same set the list below shows, or the KPI would say 154
         while the table listed 155. */
      q(`SELECT SUM(opening) opening, SUM(closing) closing, COUNT(*) n FROM "Supplier" s
         WHERE ${primary}
            OR EXISTS (SELECT 1 FROM "Bill" b WHERE b."supplierName" = s.name AND ${bwBill})
            OR EXISTS (SELECT 1 FROM "VendorPayment" v WHERE v."supplierName" = s.name
                       AND ${sourceWhere(cfg, 'v.date', 'v.source')})`),
      q(`SELECT s.name, s.category, s.opening, s.closing,
           COALESCE(b25.gross,0) bills25, COALESCE(b26.gross,0) bills26,
           COALESCE(p25.amount,0) pays25, COALESCE(p26.amount,0) pays26,
           COALESCE(b25.n,0)+COALESCE(b26.n,0) nbills, COALESCE(p25.n,0)+COALESCE(p26.n,0) npays
         FROM "Supplier" s
         LEFT JOIN (SELECT "supplierName", SUM(gross) gross, COUNT(*) n FROM "Bill"
                    WHERE ${bw} AND EXTRACT(YEAR FROM date)=2025 GROUP BY 1) b25 ON b25."supplierName"=s.name
         LEFT JOIN (SELECT "supplierName", SUM(gross) gross, COUNT(*) n FROM "Bill"
                    WHERE ${bw} AND EXTRACT(YEAR FROM date)=2026 GROUP BY 1) b26 ON b26."supplierName"=s.name
         LEFT JOIN (SELECT "supplierName", SUM(amount) amount, COUNT(*) n FROM "VendorPayment"
                    WHERE ${bw} AND EXTRACT(YEAR FROM date)=2025 GROUP BY 1) p25 ON p25."supplierName"=s.name
         LEFT JOIN (SELECT "supplierName", SUM(amount) amount, COUNT(*) n FROM "VendorPayment"
                    WHERE ${bw} AND EXTRACT(YEAR FROM date)=2026 GROUP BY 1) p26 ON p26."supplierName"=s.name
         /* A supplier Odoo knows about but the snapshot never saw still has to
            appear, or its bills would show up under a name that is not in the
            list. Balances stay at zero for those until a ledger source has them. */
         WHERE ${primary}
            OR EXISTS (SELECT 1 FROM "Bill" b WHERE b."supplierName" = s.name AND ${bwBill})
            OR EXISTS (SELECT 1 FROM "VendorPayment" v WHERE v."supplierName" = s.name
                       AND ${sourceWhere(cfg, 'v.date', 'v.source')})
         ORDER BY ABS(s.closing) DESC`),
      q(`SELECT y, SUM(gross) gross, SUM(net) net, SUM(vat) vat, SUM(nb) bills, 0::numeric paid, SUM(nv) vendors FROM (
           SELECT EXTRACT(YEAR FROM date) y, gross, net, vat, 1 nb, 0 nv FROM "Bill" WHERE ${bw}
         ) t GROUP BY y ORDER BY y`),
      q(`SELECT EXTRACT(YEAR FROM date) y, EXTRACT(MONTH FROM date) m,
                SUM(gross) bills, 0::numeric pays, COUNT(*) nb FROM "Bill" WHERE ${bw} GROUP BY 1,2
         UNION ALL
         SELECT EXTRACT(YEAR FROM date) y, EXTRACT(MONTH FROM date) m,
                0::numeric bills, SUM(amount) pays, COUNT(*) nb FROM "VendorPayment" WHERE ${bw} GROUP BY 1,2`),
      q(`SELECT l.category name, SUM(l.subtotal) value, COUNT(DISTINCT l.product) products,
                COUNT(DISTINCT b."supplierName") vendors
         FROM "BillLine" l JOIN "Bill" b ON b.id=l."billId"
         WHERE ${bwBill} AND l.category IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT l.product name, MIN(l.category) category, SUM(l.subtotal) value,
                SUM(CASE WHEN l."isBonus" THEN 0 ELSE l.qty END) qtyPaid,
                SUM(CASE WHEN l."isBonus" THEN l.qty ELSE 0 END) qtyBonus,
                COUNT(DISTINCT l."billId") bills, COUNT(DISTINCT b."supplierName") vendors
         FROM "BillLine" l JOIN "Bill" b ON b.id=l."billId"
         WHERE ${bwBill}
         GROUP BY 1 ORDER BY 3 DESC LIMIT 20`),
      q(`SELECT COALESCE(method,'Unclassified') name, COUNT(*) n, SUM(amount) amount
         FROM "VendorPayment" WHERE ${bw} GROUP BY 1 ORDER BY 3 DESC`),
      q(`SELECT TO_CHAR(date,'YYYY-MM') ym, COALESCE(method,'Unclassified') method,
                SUM(amount) amount, COUNT(*) n
         FROM "VendorPayment" WHERE ${bw} GROUP BY 1,2 ORDER BY 1`),
      q(`SELECT b."supplierName" name, MIN(s.category) category,
                COUNT(DISTINCT b.id) bills,
                SUM(CASE WHEN l."isBonus" THEN l.qty ELSE 0 END) bonusQty,
                SUM(CASE WHEN l."isBonus" THEN 0 ELSE l.qty END) paidQty,
                SUM(l.subtotal) value
         FROM "BillLine" l JOIN "Bill" b ON b.id=l."billId" JOIN "Supplier" s ON s.name=b."supplierName"
         WHERE ${bwBill}
         GROUP BY 1 HAVING SUM(CASE WHEN l."isBonus" THEN l.qty ELSE 0 END) > 0
         ORDER BY 4 DESC`),
      q(`SELECT l.product name, MIN(l.category) category, MIN(b."supplierName") supplier,
                SUM(CASE WHEN l."isBonus" THEN l.qty ELSE 0 END) bonusQty,
                SUM(CASE WHEN l."isBonus" THEN 0 ELSE l.qty END) paidQty
         FROM "BillLine" l JOIN "Bill" b ON b.id=l."billId"
         WHERE ${bwBill}
         GROUP BY 1 HAVING SUM(CASE WHEN l."isBonus" THEN l.qty ELSE 0 END) > 0
         ORDER BY 4 DESC LIMIT 30`),
    ]);

  // Payments per year, for the year comparison, kept separate so bills and
  // payments are never summed into one another by accident.
  const paysByYear = await q(`SELECT EXTRACT(YEAR FROM date) y, SUM(amount) amount, COUNT(*) n
    FROM "VendorPayment" WHERE ${bw} GROUP BY 1 ORDER BY 1`);
  const vendorsByYear = await q(`SELECT EXTRACT(YEAR FROM date) y, COUNT(DISTINCT "supplierName") n
    FROM "Bill" WHERE ${bw} GROUP BY 1 ORDER BY 1`);

  const heat = {};
  for (const r of monthly) {
    const y = String(N(r.y)), m = N(r.m);
    const row = (heat[y] || (heat[y] = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, bills: 0, pays: 0 }))))[m - 1];
    row.bills += r2(N(r.bills));
    row.pays += r2(N(r.pays));
  }

  const t = totals[0] || {};
  const payByYear = Object.fromEntries(paysByYear.map((r) => [N(r.y), r]));
  const venByYear = Object.fromEntries(vendorsByYear.map((r) => [N(r.y), N(r.n)]));

  const methodsTotal = methods.reduce((s, m) => s + N(m.amount), 0);

  return {
    totals: {
      opening: r2(N(t.opening)), closing: r2(N(t.closing)), suppliers: N(t.n),
      bills: r2(byYear.reduce((s, y) => s + N(y.gross), 0)),
      payments: r2(paysByYear.reduce((s, y) => s + N(y.amount), 0)),
    },
    suppliers: suppliers.map((s) => ({
      name: s.name, category: s.category, opening: r2(N(s.opening)), closing: r2(N(s.closing)),
      bills25: r2(N(s.bills25)), bills26: r2(N(s.bills26)),
      pays25: r2(N(s.pays25)), pays26: r2(N(s.pays26)),
      nbills: N(s.nbills), npays: N(s.npays),
    })),
    years: byYear.map((y) => ({
      year: N(y.y), gross: r2(N(y.gross)), net: r2(N(y.net)), vat: r2(N(y.vat)),
      bills: N(y.bills), paid: r2(N((payByYear[N(y.y)] || {}).amount)),
      pays: N((payByYear[N(y.y)] || {}).n), vendors: venByYear[N(y.y)] || 0,
    })),
    heatmap: heat,
    categories: categories.map((c) => ({
      name: c.name, value: r2(N(c.value)), products: N(c.products), vendors: N(c.vendors),
    })),
    topProducts: topProducts.map((p) => ({
      name: p.name, category: p.category, value: r2(N(p.value)),
      qtyPaid: r2(N(p.qtypaid)), qtyBonus: r2(N(p.qtybonus)), bills: N(p.bills), vendors: N(p.vendors),
    })),
    methods: methods.map((m) => ({
      name: m.name, n: N(m.n), amount: r2(N(m.amount)),
      share: methodsTotal ? r2((N(m.amount) / methodsTotal) * 100) : 0,
    })),
    monthlyMethods: monthlyMethods.map((m) => ({ ym: m.ym, method: m.method, amount: r2(N(m.amount)), n: N(m.n) })),
    bonusVendors: bonusVendors.map((v) => ({
      name: v.name, category: v.category, bills: N(v.bills),
      bonusQty: r2(N(v.bonusqty)), paidQty: r2(N(v.paidqty)), value: r2(N(v.value)),
      ratio: N(v.paidqty) ? r2((N(v.bonusqty) / N(v.paidqty)) * 100) : null,
    })),
    bonusProducts: bonusProducts.map((p) => ({
      name: p.name, category: p.category, supplier: p.supplier,
      bonusQty: r2(N(p.bonusqty)), paidQty: r2(N(p.paidqty)),
      ratio: N(p.paidqty) ? r2((N(p.bonusqty) / N(p.paidqty)) * 100) : null,
    })),
  };
}

/* --------------------------------------------------------- sold vs issued --- */

async function buildRecon(cfg, { from, to }) {
  const primary = `p.source = '${cfg.primary}'`;
  const range = `f.date >= $1::date AND f.date <= $2::date`;

  const [rows, byBranch, perProductBranch, retMeta] = await Promise.all([
    q(`SELECT p.id, p.label, p."soldName", p."stockName", p."unitCost", p.matched,
              SUM(CASE WHEN f.kind='sold' THEN f.qty ELSE 0 END) soldQty,
              SUM(CASE WHEN f.kind='sold' THEN COALESCE(f.value,0) ELSE 0 END) soldValue,
              SUM(CASE WHEN f.kind='issued' THEN f.qty ELSE 0 END) issuedQty,
              SUM(CASE WHEN f.kind='returned' THEN f.qty ELSE 0 END) returnedQty
       FROM "ReconProduct" p JOIN "ReconFact" f ON f."reconProductId"=p.id
       WHERE ${primary} AND ${range}
       GROUP BY p.id ORDER BY 8 DESC`, from, to),
    q(`SELECT f.branch,
              SUM(CASE WHEN f.kind='sold' THEN f.qty ELSE 0 END) soldQty,
              SUM(CASE WHEN f.kind='sold' THEN COALESCE(f.value,0) ELSE 0 END) soldValue,
              SUM(CASE WHEN f.kind='issued' THEN f.qty*p."unitCost" ELSE 0 END) issuedCost,
              SUM(CASE WHEN f.kind='returned' THEN f.qty*p."unitCost" ELSE 0 END) returnedCost,
              SUM(CASE WHEN f.kind='issued' THEN f.qty ELSE 0 END) issuedQty,
              SUM(CASE WHEN f.kind='returned' THEN f.qty ELSE 0 END) returnedQty
       FROM "ReconProduct" p JOIN "ReconFact" f ON f."reconProductId"=p.id
       WHERE ${primary} AND p.matched AND ${range}
       GROUP BY f.branch ORDER BY 3 DESC`, from, to),
    /* The same cut one level down, so a product row can open onto the branches
       behind it — where a gap actually lives. */
    q(`SELECT p.id, f.branch,
              SUM(CASE WHEN f.kind='sold' THEN f.qty ELSE 0 END) soldQty,
              SUM(CASE WHEN f.kind='sold' THEN COALESCE(f.value,0) ELSE 0 END) soldValue,
              SUM(CASE WHEN f.kind='issued' THEN f.qty ELSE 0 END) issuedQty,
              SUM(CASE WHEN f.kind='returned' THEN f.qty ELSE 0 END) returnedQty
       FROM "ReconProduct" p JOIN "ReconFact" f ON f."reconProductId"=p.id
       WHERE ${primary} AND ${range}
       GROUP BY p.id, f.branch`, from, to),
    q(`SELECT COUNT(*) rows, SUM(f.qty) qty, SUM(f.qty*p."unitCost") cost
       FROM "ReconProduct" p JOIN "ReconFact" f ON f."reconProductId"=p.id
       WHERE ${primary} AND f.kind='returned' AND ${range}`, from, to),
  ]);

  // product id -> its branch rows, so each product carries its own breakdown
  const branchesOf = new Map();
  for (const b of perProductBranch) {
    (branchesOf.get(N(b.id)) || branchesOf.set(N(b.id), []).get(N(b.id))).push(b);
  }

  const shape = (r) => {
    const soldQty = r2(N(r.soldqty)), issued = N(r.issuedqty), returned = N(r.returnedqty);
    const net = r2(issued - returned), uc = N(r.unitCost);
    const gap = r2(soldQty - net);

    const branches = (branchesOf.get(N(r.id)) || []).map((b) => {
      const sq = r2(N(b.soldqty)), iq = N(b.issuedqty), rq = N(b.returnedqty);
      const bnet = r2(iq - rq), bgap = r2(sq - bnet);
      return {
        name: F.branchLabel(b.branch), soldQty: sq, soldValue: r2(N(b.soldvalue)),
        issuedQty: r2(iq), returnedQty: r2(rq), netQty: bnet, netCost: r2(bnet * uc),
        gapQty: bgap, gapCost: r2(bgap * uc),
      };
    }).sort((a, b) => b.soldValue - a.soldValue || b.netCost - a.netCost);

    return {
      label: r.label, soldName: r.soldName, stockName: r.stockName, matched: r.matched,
      unitCost: uc, soldQty, soldValue: r2(N(r.soldvalue)),
      issuedQty: r2(issued), returnedQty: r2(returned), netQty: net,
      netCost: r2(net * uc), gapQty: gap, gapCost: r2(gap * uc),
      cause: r.matched ? F.gapCause({ gap, soldQty }) : null,
      branches,
    };
  };

  const all = rows.map(shape);
  const matched = all.filter((r) => r.matched);
  const unmatched = all.filter((r) => !r.matched && r.netQty !== 0).sort((a, b) => b.netCost - a.netCost);

  const totals = matched.reduce((a, r) => ({
    soldQty: a.soldQty + r.soldQty, soldValue: a.soldValue + r.soldValue,
    issuedQty: a.issuedQty + r.issuedQty, returnedQty: a.returnedQty + r.returnedQty,
    netCost: a.netCost + r.netCost,
    gapPos: a.gapPos + (r.gapCost > 0 ? r.gapCost : 0),
    gapNeg: a.gapNeg + (r.gapCost < 0 ? -r.gapCost : 0),
  }), { soldQty: 0, soldValue: 0, issuedQty: 0, returnedQty: 0, netCost: 0, gapPos: 0, gapNeg: 0 });
  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
  totals.netQty = r2(totals.issuedQty - totals.returnedQty);
  totals.pairs = matched.length;
  totals.noTwin = unmatched.length;

  const rm = retMeta[0] || {};
  return {
    totals,
    products: matched,
    unmatched,
    lookFirst: matched.filter((r) => F.worthLookingAt(r.gapCost)).sort((a, b) => Math.abs(b.gapCost) - Math.abs(a.gapCost)),
    branches: byBranch.map((b) => {
      const sold = r2(N(b.soldvalue)), cost = r2(N(b.issuedcost) - N(b.returnedcost));
      return {
        name: F.branchLabel(b.branch), soldQty: r2(N(b.soldqty)), soldValue: sold,
        netQty: r2(N(b.issuedqty) - N(b.returnedqty)), netCost: cost,
        gapQty: r2(N(b.soldqty) - (N(b.issuedqty) - N(b.returnedqty))),
        costRatio: sold ? r2((cost / sold) * 100) : null,
      };
    }),
    /* `rows` counts branch-day cells carrying a return, NOT stock moves — the
       snapshot is aggregated, so the underlying move count (127 in the source
       period) is not recoverable from it. Costed at the period-average unit
       cost, which the source notes runs ~2.8% under the FIFO layer valuation. */
    returns: { rows: N(rm.rows), qty: r2(N(rm.qty)), cost: r2(N(rm.cost)) },
    causes: F.GAP_CAUSES,
  };
}

/* ------------------------------------------------------------------ expiry --- */

async function buildExpiry(cfg, { asOf }) {
  const rows = await q(`SELECT location, "isWarehouse", product, lot, expiry, qty, value,
      "unitCost", "rateMonthly", "companyRate", "thinMovement"
    FROM "ExpiryLot" WHERE source = '${cfg.primary}' ORDER BY expiry`);

  /* The verdict, the day count and the bucket all come from the rules at read
     time. Storing them would leave the page asserting the day the data landed. */
  const lots = rows.map((r) => {
    const daysLeft = F.daysToExpiry(new Date(r.expiry), asOf);
    const qty = N(r.qty);
    const rate = r.rateMonthly === null ? null : N(r.rateMonthly);
    const v = F.expiryVerdict({ qty, daysLeft, rate, isWarehouse: r.isWarehouse });
    const unitCost = N(r.unitCost);
    return {
      location: F.branchLabel(r.location), isWarehouse: r.isWarehouse, product: r.product, lot: r.lot,
      expiry: ymd(r.expiry), daysLeft, qty: r2(qty), value: r2(N(r.value)), unitCost,
      rate, companyRate: r.companyRate === null ? null : N(r.companyRate),
      thinMovement: r.thinMovement,
      cover: v.cover === null ? null : r2(v.cover),
      atRiskQty: r2(v.atRiskQty),
      /* When the whole lot is at risk its at-risk value IS its value. Recomputing
         it as qty × unitCost instead lands a rounding cent or two above the
         stored value, which reads as "more at risk than it is worth". */
      atRiskValue: v.atRiskQty >= qty ? r2(N(r.value)) : r2(v.atRiskQty * unitCost),
      verdict: v.verdict, bucket: F.bucketOf(daysLeft),
      action: F.suggestedAction({ daysLeft, isWarehouse: r.isWarehouse, verdict: v.verdict }),
    };
  });

  const sum = (rs, k) => r2(rs.reduce((s, r) => s + r[k], 0));
  const verdicts = {};
  for (const l of lots) verdicts[l.verdict] = (verdicts[l.verdict] || 0) + 1;

  /* The lots go out flat and the page groups them.
     Horizon, scope and search have to re-filter without a round trip, and every
     table regroups when they change — so shipping pre-rolled locations and
     products would mean computing each aggregate twice, once here for the first
     paint and again in the browser for every click. The verdict, day count,
     bucket and at-risk figure are still decided here; the page only sums. */
  return {
    asOf: ymd(asOf),
    lots,
    buckets: F.BUCKETS,
    labels: F.VERDICTS,
    verdicts,
    /* Unfiltered reference totals, so a filtered view can always say what it is a
       slice of. */
    totals: {
      lines: lots.length,
      lots: new Set(lots.map((l) => `${l.product}|${l.lot}`)).size,
      products: new Set(lots.map((l) => l.product)).size,
      value: sum(lots, 'value'),
      expired: sum(lots.filter((l) => l.daysLeft < 0), 'value'),
      due90: sum(lots.filter((l) => l.daysLeft >= 0 && l.daysLeft <= 90), 'value'),
      atRisk: sum(lots, 'atRiskValue'),
      atRisk90: sum(lots.filter((l) => l.daysLeft <= 90), 'atRiskValue'),
      warehouse: sum(lots.filter((l) => l.isWarehouse), 'value'),
      warehouseExpired: sum(lots.filter((l) => l.isWarehouse && l.daysLeft < 0), 'value'),
      parked: sum(lots.filter((l) => l.verdict === 'watch'), 'value'),
    },
  };
}

/* -------------------------------------------------------------------- main --- */

/**
 * The whole finance page.
 *
 * `from`/`to` bound the dated sections (collections, sold-vs-issued); payables
 * spans its whole history and expiry is a point-in-time snapshot, so neither is
 * cut by the range.
 */
async function buildFinance({ from, to, asOf, sections = SECTIONS }) {
  const cfg = await resolve();
  const at = asOf instanceof Date ? asOf : new Date(`${asOf}T00:00:00Z`);

  const batches = await prisma.financeBatch.findMany({ orderBy: { importedAt: 'desc' } });
  const wanted = (s) => sections.includes(s);

  const [collections, payables, recon, expiry] = await Promise.all([
    wanted('collections') ? buildCollections(cfg.collections, { from, to }) : null,
    wanted('payables') ? buildPayables(cfg.payables) : null,
    wanted('recon') ? buildRecon(cfg.recon, { from, to }) : null,
    wanted('expiry') ? buildExpiry(cfg.expiry, { asOf: at }) : null,
  ]);

  return {
    meta: {
      from, to, asOf: ymd(at),
      sources: cfg,
      batches: batches.map((b) => ({
        section: b.section, source: b.source, asOf: ymd(b.asOf),
        importedAt: b.importedAt, rowCount: b.rowCount, label: b.label,
      })),
    },
    collections, payables, recon, expiry,
  };
}

module.exports = { buildFinance, buildCollections, collectionsTotals, buildPayables, buildRecon, buildExpiry, resolve, SECTIONS };
