/* ============================================================
   Report 09 — Procurement & Products.

   Two halves that only look like one report:

     the money out    what was bought, from whom, what came back, what was paid
                      — Bill, BillLine, VendorPayment, PurchaseReturn
     the product      for one consumable: what it cost, what is on the shelf,
                      what sold, in which branch, by which doctor
                      — Invoice, InvoiceLine, StockQuant, BillLine

   THE SCOPE IS EVERY PAYABLE, AND THAT IS A DECISION, NOT AN OVERSIGHT.

   The source pack reports 29,401,633 across 32 vendors and counts only product
   purchases. `Bill` holds 52,168,665 across 73 suppliers, because it is the
   payables ledger: Camp Shizar Rent (2.33 M), Rent Strep (1.55 M), Advertising
   (5.87 M) and Expenses (12.49 M) are all in it. Mina asked for all of it.

   So the report does not filter — it BREAKS THE TOTAL DOWN, by the category
   prefix Odoo already puts on every purchase line, and the breakdown is
   asserted to sum back to `Bill.net` to the piastre. A figure 78% larger than
   the pack's with no explanation is indistinguishable from a bug; the same
   figure with `Injectables 28.4 M · Expenses 12.5 M · Advertising 5.9 M …`
   beside it is an answer.

   FOUR TOTALS IN THE SOURCE, NONE OF THEM STORED. The pack states its own net
   purchases as 29,401,633 (its KPI), 28,800,979 (its vendor table),
   27,441,676 (its categories) and 26,943,317 (its cash-back rows). This report
   derives one figure from `Bill` and states it; the disagreement is recorded in
   `DataUpload.notes` by the importer rather than quietly averaged away.

   RETURNS ARE SEEDED, AND SAY SO. There are zero negative `BillLine` rows in
   the cache, so the 11 rows in `PurchaseReturn` are the only record in
   existence of 3,047,191 of goods going back — 933,772 of it Bio Solutions,
   which is 12% of that vendor's year. `source` is `seed` until an export
   arrives, and every figure built on them carries that word.

   CASH BACK IS AN AGREEMENT, NOT A CALCULATION. 10%, and 15% for Eldawlia
   Pharma. Nothing in Odoo knows this, so it comes from `VendorTerm`, which is
   edited in Admin and is upserted rather than replaced on every import — the
   lesson the commission tables learned when a re-deploy silently reverted a
   band somebody had corrected.
   ============================================================ */

const { prisma } = require('./db.js');
const C = require('./consumables.js');

const num = (v) => (v == null ? 0 : Number(v));
/* `|| 0` is not redundant: rounding a value a hair below zero yields -0, and
   `Object.is(-0, 0)` is false — so an identity check on a difference that IS
   zero fails, which is exactly how the composition reconciliation first
   "failed" while being perfectly correct. */
const r2 = (v) => (Math.round((num(v) + Number.EPSILON) * 100) / 100) || 0;
const r3 = (v) => (Math.round((num(v) + Number.EPSILON) * 1000) / 1000) || 0;
const ymd = (d) => (d ? d.toISOString().slice(0, 10) : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * What kind of spend a purchase line is, from the category Odoo already put on
 * it. An ORDERED list: `Injection/Regenerative Medicine` must be tested against
 * the `Injection/` prefix before anything matches on the word "Medicine".
 *
 * `Consumables` is the group that answers "what does the pack mean by
 * purchases" — everything the clinic puts into a patient or through a device.
 * The rest is the difference between this report and that one.
 */
const SPEND_GROUPS = [
  { key: 'injectables', label: 'Injectables', consumable: true, test: (c) => /^injection\//i.test(c) },
  { key: 'devices', label: 'Device consumables', consumable: true, test: (c) => /^devices\//i.test(c) },
  { key: 'services', label: 'Service supplies', consumable: true, test: (c) => /^service\//i.test(c) },
  /* Odoo's catch-all. Stock, but nobody said which kind — it is 530,776 and
     naming it "Other" would bury it among the rent. */
  { key: 'unclassified', label: 'Stock, uncategorised', consumable: true, test: (c) => /^all$/i.test(c) },
  { key: 'expenses', label: 'Expenses', consumable: false, test: (c) => /^expenses$/i.test(c) },
  { key: 'advertising', label: 'Advertising', consumable: false, test: (c) => /^advertising$/i.test(c) },
  { key: 'assets', label: 'Fixed assets', consumable: false, test: (c) => /^fixed assets$/i.test(c) },
  { key: 'other', label: 'Other', consumable: false, test: () => true },
];

const groupOf = (category) => SPEND_GROUPS.find((g) => g.test(String(category || '')));

/**
 * The purchase ledger for a window, broken down every way the report needs.
 *
 * `reconciles` is the check that matters: the groups plus the bills that carry
 * no lines at all must equal `Bill.net` exactly. A category quietly dropping
 * out of the breakdown is the failure this catches, and it would otherwise show
 * up as a total that looks plausible and is short by one supplier.
 */
async function buildPurchases({ from, to }) {
  const W = { gte: new Date(from), lte: new Date(to) };

  const [bills, lines, billNet] = await Promise.all([
    prisma.bill.findMany({ where: { date: W }, select: { id: true, supplierName: true, date: true, net: true, gross: true, vat: true, branch: true } }),
    prisma.billLine.findMany({
      where: { bill: { date: W } },
      select: { billId: true, product: true, category: true, qty: true, unitPrice: true, subtotal: true, isBonus: true },
    }),
    prisma.bill.aggregate({ where: { date: W }, _sum: { net: true, gross: true, vat: true }, _count: true }),
  ]);

  const billById = new Map(bills.map((b) => [b.id, b]));
  const withLines = new Set(lines.map((l) => l.billId));

  /* ---- composition ---- */
  const groups = new Map(SPEND_GROUPS.map((g) => [g.key, {
    key: g.key, label: g.label, consumable: g.consumable, net: 0, lines: 0, qty: 0, categories: new Set(),
  }]));
  const byCategory = new Map();
  const byMonth = new Map();
  const byVendor = new Map();
  const byProduct = new Map();
  let bonusLines = 0;
  let bonusQty = 0;

  for (const l of lines) {
    const bill = billById.get(l.billId);
    const g = groupOf(l.category);
    const sub = num(l.subtotal);
    const G = groups.get(g.key);
    G.net += sub; G.lines += 1; G.qty += num(l.qty);
    if (l.category) G.categories.add(l.category);

    const ck = l.category || '(none)';
    const Cc = byCategory.get(ck) || { category: ck, group: g.key, net: 0, lines: 0, qty: 0, products: new Set() };
    Cc.net += sub; Cc.lines += 1; Cc.qty += num(l.qty); Cc.products.add(l.product);
    byCategory.set(ck, Cc);

    const pk = l.product;
    const P = byProduct.get(pk) || {
      product: pk, category: l.category, group: g.key, net: 0, qty: 0, lines: 0,
      bonusQty: 0, vendors: new Set(), firstDate: null, lastDate: null, prices: [],
    };
    P.net += sub; P.qty += num(l.qty); P.lines += 1;
    if (l.isBonus) P.bonusQty += num(l.qty);
    if (bill) {
      P.vendors.add(bill.supplierName);
      if (!P.firstDate || bill.date < P.firstDate) P.firstDate = bill.date;
      if (!P.lastDate || bill.date > P.lastDate) P.lastDate = bill.date;
      if (!l.isBonus && num(l.unitPrice) > 0) P.prices.push({ date: bill.date, unitPrice: num(l.unitPrice) });
    }
    byProduct.set(pk, P);

    if (l.isBonus) { bonusLines += 1; bonusQty += num(l.qty); }
  }

  for (const b of bills) {
    const m = ymd(b.date).slice(0, 7);
    const M = byMonth.get(m) || { month: m, label: MONTHS[Number(m.slice(5, 7)) - 1], net: 0, bills: 0, vendors: new Set() };
    M.net += num(b.net); M.bills += 1; M.vendors.add(b.supplierName);
    byMonth.set(m, M);

    const V = byVendor.get(b.supplierName) || {
      supplierName: b.supplierName, net: 0, gross: 0, vat: 0, bills: 0, lines: 0,
      firstDate: null, lastDate: null, categories: new Set(),
    };
    V.net += num(b.net); V.gross += num(b.gross); V.vat += num(b.vat); V.bills += 1;
    if (!V.firstDate || b.date < V.firstDate) V.firstDate = b.date;
    if (!V.lastDate || b.date > V.lastDate) V.lastDate = b.date;
    byVendor.set(b.supplierName, V);
  }
  for (const l of lines) {
    const bill = billById.get(l.billId);
    if (!bill) continue;
    const V = byVendor.get(bill.supplierName);
    V.lines += 1;
    if (l.category) V.categories.add(l.category);
  }

  /* Bills with no line detail at all. Their money is real and has to land
     somewhere, or the breakdown will not add up — and "the difference is 2,023"
     is a far better answer than a total that is quietly short. */
  const headerOnly = bills.filter((b) => !withLines.has(b.id));
  const headerOnlyNet = headerOnly.reduce((t, b) => t + num(b.net), 0);
  const lineNet = lines.reduce((t, l) => t + num(l.subtotal), 0);
  const net = num(billNet._sum.net);

  const composition = [...groups.values()]
    .map((g) => ({ ...g, net: r2(g.net), qty: r3(g.qty), categories: g.categories.size }))
    .filter((g) => g.lines > 0)
    .sort((a, b) => b.net - a.net);
  const consumableNet = composition.filter((g) => g.consumable).reduce((t, g) => t + g.net, 0);

  return {
    window: { from, to },
    totals: {
      net: r2(net),
      gross: r2(billNet._sum.gross),
      vat: r2(billNet._sum.vat),
      bills: billNet._count,
      lines: lines.length,
      vendors: byVendor.size,
      products: byProduct.size,
      bonusLines,
      bonusQty: r3(bonusQty),
      /* The pack's question, answered inside ours rather than instead of it. */
      consumableNet: r2(consumableNet),
      nonConsumableNet: r2(net - consumableNet - headerOnlyNet),
    },
    composition,
    /* THE IDENTITY A TEST ASSERTS: the composition sums to the line total, to
       the piastre. That is the check that catches a spend category quietly
       falling out of the breakdown, which would otherwise show up as a plausible
       total that is short by one supplier.
       `residual` is separate and is NOT part of that sum: it is the bill headers
       whose net no line accounts for — 4 bills carry no line detail at all, and
       a handful more are a piastre out. Folding it into a group would make the
       breakdown add up by hiding the very thing it is there to expose. */
    reconciles: {
      billNet: r2(net),
      lineNet: r2(lineNet),
      compositionNet: r2(composition.reduce((t, g) => t + g.net, 0)),
      /* Must be 0. */
      compositionGap: r2(composition.reduce((t, g) => t + g.net, 0) - lineNet),
      residual: r2(net - lineNet),
      headerOnlyNet: r2(headerOnlyNet),
      headerOnlyBills: headerOnly.length,
    },
    months: [...byMonth.values()]
      .map((m) => ({ ...m, net: r2(m.net), vendors: m.vendors.size }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    categories: [...byCategory.values()]
      .map((c) => ({ ...c, net: r2(c.net), qty: r3(c.qty), products: c.products.size }))
      .sort((a, b) => b.net - a.net),
    vendors: [...byVendor.values()]
      .map((v) => ({
        ...v, net: r2(v.net), gross: r2(v.gross), vat: r2(v.vat),
        firstDate: ymd(v.firstDate), lastDate: ymd(v.lastDate), categories: [...v.categories],
      }))
      .sort((a, b) => b.net - a.net),
    products: [...byProduct.values()]
      .map((p) => ({
        ...p, net: r2(p.net), qty: r3(p.qty), bonusQty: r3(p.bonusQty),
        vendors: [...p.vendors],
        firstDate: ymd(p.firstDate), lastDate: ymd(p.lastDate),
        unitCost: p.qty > 0 ? r2(p.net / p.qty) : null,
        prices: undefined,
        priceDrift: driftOf(p.prices),
      }))
      .sort((a, b) => b.net - a.net),
  };
}

/**
 * How a product's unit price moved over the window.
 *
 * First and last are by DATE, not by row order: purchase lines come back in id
 * order and a bill entered late for an early date would otherwise read as a
 * price rise that never happened.
 */
function driftOf(prices) {
  if (!prices || prices.length < 2) return null;
  const sorted = [...prices].sort((a, b) => a.date - b.date);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!(first.unitPrice > 0) || first.unitPrice === last.unitPrice) return null;
  return {
    first: r2(first.unitPrice), firstAt: ymd(first.date),
    last: r2(last.unitPrice), lastAt: ymd(last.date),
    pct: r2(((last.unitPrice - first.unitPrice) / first.unitPrice) * 100),
    observations: sorted.length,
  };
}

/**
 * Vendors, with what they owe back and what they were targeted at.
 *
 * Net purchase here is BEFORE returns and says so, then returns are subtracted
 * to give the basis cash back is actually due on. Doing it the other way round
 * — quietly netting first — is how a vendor's cash back ends up computed on
 * money that was refunded.
 */
async function buildVendors({ from, to }) {
  const pur = await buildPurchases({ from, to });
  const year = Number(to.slice(0, 4));
  const [terms, returns] = await Promise.all([
    prisma.vendorTerm.findMany({ where: { year } }),
    prisma.purchaseReturn.findMany(),
  ]);

  /* STRICT. A cash-back rate is an agreement with one named company, so the
     loose tiers are wrong here in a way they are not wrong for a quantity: at
     `prefix` and `contains` this matched 63 of 73 suppliers to one of 21
     agreements and produced 4,478,764 of cash back owed on rent and
     advertising. Only exact and squash — the tiers where the two names really
     are the same name — may put money on a vendor's row. */
  const TERM_TIERS = new Set(['exact', 'squash']);
  const termPool = C.poolOf(terms.map((t) => ({ name: t.supplierName, row: t })), 'name', 'name');
  const retBySupplier = new Map();
  for (const r of returns) {
    const cur = retBySupplier.get(r.supplierName) || { value: 0, rows: 0, sources: new Set() };
    cur.value += num(r.value); cur.rows += 1; cur.sources.add(r.source);
    retBySupplier.set(r.supplierName, cur);
  }
  const retPool = C.poolOf([...retBySupplier.keys()].map((n) => ({ name: n })), 'name', 'name');

  const claimedReturns = new Set();
  /* What each vendor actually sold us, so a vendor card can open to its own
     products rather than being a total with nothing behind it. Built from the
     purchase lines already loaded — the alternative was a second query per
     vendor, which on 73 vendors is 73 round trips to answer one click. */
  const linesByVendor = new Map();
  {
    const bills = await prisma.bill.findMany({
      where: { date: { gte: new Date(from), lte: new Date(to) } },
      select: { supplierName: true, lines: { select: { product: true, category: true, qty: true, unitPrice: true, subtotal: true, isBonus: true } } },
    });
    for (const b of bills) {
      const m = linesByVendor.get(b.supplierName) || new Map();
      for (const l of b.lines) {
        const cur = m.get(l.product) || {
          product: l.product, category: l.category, qty: 0, bonusQty: 0, net: 0, lines: 0,
        };
        cur.qty += num(l.qty);
        if (l.isBonus) cur.bonusQty += num(l.qty);
        cur.net += num(l.subtotal);
        cur.lines += 1;
        m.set(l.product, cur);
      }
      linesByVendor.set(b.supplierName, m);
    }
  }

  const rows = pur.vendors.map((v) => {
    const t = C.matchOne(v.supplierName, termPool);
    const term = t.hit && TERM_TIERS.has(t.rule) ? t.hit.row.row : null;
    const rm = C.matchOne(v.supplierName, retPool);
    const ret = rm.hit && TERM_TIERS.has(rm.rule) ? retBySupplier.get(rm.hit.name) : null;
    if (ret) claimedReturns.add(rm.hit.name);
    const returned = ret ? r2(ret.value) : 0;
    const netOfReturns = r2(v.net - returned);
    const rate = term && term.cashbackRate != null ? Number(term.cashbackRate) : null;
    const products = [...(linesByVendor.get(v.supplierName) || new Map()).values()]
      .map((x) => ({
        ...x,
        qty: r3(x.qty),
        bonusQty: r3(x.bonusQty),
        net: r2(x.net),
        /* Per unit of what was PAID for — bonus stock has no price, so counting
           it in the denominator drags the figure below anything ever paid. */
        unitCost: x.qty - x.bonusQty > 0 ? r2(x.net / (x.qty - x.bonusQty)) : null,
        bonusPct: x.qty - x.bonusQty > 0 ? r2((x.bonusQty / (x.qty - x.bonusQty)) * 100) : null,
      }))
      .sort((a, b) => b.net - a.net);

    return {
      ...v,
      products,
      returned,
      returnRows: ret ? ret.rows : 0,
      returnSource: ret ? [...ret.sources].join('/') : null,
      netOfReturns,
      cashbackRate: rate,
      cashbackBasis: term ? term.basisNote : null,
      /* Due on the net of returns, which is the point of computing both. */
      cashbackDue: rate == null ? null : r2(netOfReturns * rate),
      targetLabel: term ? term.targetLabel : null,
      targetAmount: term && term.targetAmount != null ? Number(term.targetAmount) : null,
      termMatch: term ? t.rule : null,
      termNearMiss: !term && t.hit ? `${t.hit.name} (${t.rule})` : null,
    };
  });

  const withRate = rows.filter((r) => r.cashbackRate != null);
  return {
    rows,
    totals: {
      net: pur.totals.net,
      returned: r2(rows.reduce((t, r) => t + r.returned, 0)),
      netOfReturns: r2(rows.reduce((t, r) => t + r.netOfReturns, 0)),
      cashbackDue: r2(withRate.reduce((t, r) => t + (r.cashbackDue || 0), 0)),
      vendorsWithRate: withRate.length,
      vendorsWithoutRate: rows.length - withRate.length,
      vendorsWithTarget: rows.filter((r) => r.targetLabel).length,
    },
    /* Returns whose supplier did not match a purchasing vendor in this window.
       They cannot be netted off anything, and dropping them silently would lose
       real money — so they are listed, and `returned` plus these equals the
       returns total. */
    orphanReturns: [...retBySupplier.entries()]
      .filter(([name]) => !claimedReturns.has(name))
      .map(([name, v]) => ({ supplierName: name, value: r2(v.value), rows: v.rows }))
      .sort((a, b) => b.value - a.value),
    terms: terms.length,
    note: 'Cash back is an agreed rate held in VendorTerm and edited in Admin — nothing in Odoo records it.',
  };
}

/** Goods sent back, and where the figures came from. */
async function buildReturns() {
  const rows = await prisma.purchaseReturn.findMany({ orderBy: { value: 'desc' } });
  if (!rows.length) {
    return { missing: true, reason: 'No returns are loaded. Seed them from the pack or upload an export in Admin → Uploads.' };
  }
  const sources = [...new Set(rows.map((r) => r.source))];
  const bySupplier = new Map();
  for (const r of rows) {
    const s = bySupplier.get(r.supplierName) || { supplierName: r.supplierName, value: 0, qty: 0, rows: 0 };
    s.value += num(r.value); s.qty += num(r.qty); s.rows += 1;
    bySupplier.set(r.supplierName, s);
  }
  return {
    rows: rows.map((r) => ({
      supplierName: r.supplierName, product: r.product, category: r.category,
      qty: r3(r.qty), unitCost: r.unitCost == null ? null : r2(r.unitCost),
      value: r2(r.value), date: ymd(r.date), source: r.source,
    })),
    bySupplier: [...bySupplier.values()].map((s) => ({ ...s, value: r2(s.value), qty: r3(s.qty) }))
      .sort((a, b) => b.value - a.value),
    totals: { rows: rows.length, value: r2(rows.reduce((t, r) => t + num(r.value), 0)), suppliers: bySupplier.size },
    sources,
    /* The pack carries no date on a return row, so seeded returns sit on the
       year rather than a month. Stated, because a monthly view of them would be
       an invention. */
    dated: rows.filter((r) => r.date).length,
    seeded: rows.filter((r) => r.source === 'seed').length,
  };
}

/** Cheques out, by vendor and month. */
async function buildPayments({ from, to }) {
  const W = { gte: new Date(from), lte: new Date(to) };
  const pays = await prisma.vendorPayment.findMany({ where: { date: W } });

  const byVendor = new Map();
  const byMonth = new Map();
  const byMethod = new Map();
  for (const p of pays) {
    const m = ymd(p.date).slice(0, 7);
    const V = byVendor.get(p.supplierName) || { supplierName: p.supplierName, amount: 0, count: 0, months: {} };
    V.amount += num(p.amount); V.count += 1;
    V.months[m] = r2((V.months[m] || 0) + num(p.amount));
    byVendor.set(p.supplierName, V);

    const M = byMonth.get(m) || { month: m, label: MONTHS[Number(m.slice(5, 7)) - 1], amount: 0, count: 0 };
    M.amount += num(p.amount); M.count += 1;
    byMonth.set(m, M);

    const k = p.method || p.journal || '—';
    const K = byMethod.get(k) || { method: k, amount: 0, count: 0 };
    K.amount += num(p.amount); K.count += 1;
    byMethod.set(k, K);
  }

  return {
    months: [...byMonth.values()].map((m) => ({ ...m, amount: r2(m.amount) })).sort((a, b) => a.month.localeCompare(b.month)),
    vendors: [...byVendor.values()].map((v) => ({ ...v, amount: r2(v.amount) })).sort((a, b) => b.amount - a.amount),
    methods: [...byMethod.values()].map((m) => ({ ...m, amount: r2(m.amount) })).sort((a, b) => b.amount - a.amount),
    totals: { amount: r2(pays.reduce((t, p) => t + num(p.amount), 0)), count: pays.length, vendors: byVendor.size },
    /* Payments are cash out and purchases are invoices in. They are NOT the
       same measure over the same window and the page must not imply they net:
       a cheque this month can settle a bill from three months ago. */
    note: 'Payments are cash leaving; purchases are invoices arriving. The two do not net within a window.',
  };
}

/**
 * One consumable, end to end — the tab the pack's `PDATA` cube drives.
 *
 * Purchases and stock on one side, sales by branch and by doctor on the other.
 * The doctor comes from `Invoice.specialistName`, which is the INVOICE HEADER:
 * `InvoiceLine` has no doctor column, so a doctor's figure here is every line
 * on an invoice she raised. Stated on the page, because the pack attributed at
 * line level for part of its year and the two are not the same cut.
 */
async function buildProduct({ from, to, odooId }) {
  const cat = await C.catalogue();
  const id = cat.canonical(Number(odooId));
  const prod = cat.byId.get(id);
  if (!prod) return { missing: true, reason: `Product ${odooId} is not in the consumable catalogue.` };

  const L = await C.links();
  const services = [...L.byService.entries()]
    .filter(([, v]) => cat.canonical(v.consumableOdooId) === id)
    .map(([sid, v]) => ({ serviceProductId: sid, serviceName: v.serviceName, matchRule: v.matchRule }));

  const Inventory = require('./inventory.js');
  const [stock, cost, lines] = await Promise.all([
    Inventory.stockAt(to),
    C.costBasis({ to }),
    services.length ? prisma.invoiceLine.findMany({
      where: {
        productId: { in: services.map((s) => s.serviceProductId) },
        invoice: {
          moveType: { in: ['out_invoice', 'out_refund'] },
          invoiceDate: { gte: new Date(from), lte: new Date(to) },
        },
      },
      select: {
        productId: true, quantity: true, priceSubtotal: true, priceTotal: true,
        invoice: { select: { invoiceDate: true, branchName: true, specialistName: true, moveType: true, odooId: true } },
      },
    }) : [],
  ]);

  const byBranch = new Map();
  const byDoctor = new Map();
  const byMonth = new Map();
  let doses = 0; let ex = 0; let inc = 0;
  const invoices = new Set();

  for (const l of lines) {
    const sign = l.invoice.moveType === 'out_refund' ? -1 : 1;
    const q = num(l.quantity) * sign;
    doses += q; ex += num(l.priceSubtotal) * sign; inc += num(l.priceTotal) * sign;
    invoices.add(l.invoice.odooId);

    const bk = l.invoice.branchName || 'Unassigned';
    const B = byBranch.get(bk) || { name: bk, doses: 0, units: 0, ex: 0, invoices: new Set(), doctors: new Map() };
    B.doses += q; B.ex += num(l.priceSubtotal) * sign; B.invoices.add(l.invoice.odooId);
    const dk = l.invoice.specialistName || 'No doctor';
    B.doctors.set(dk, r3((B.doctors.get(dk) || 0) + q));
    byBranch.set(bk, B);

    const D = byDoctor.get(dk) || { name: dk, doses: 0, units: 0, ex: 0, invoices: new Set(), branches: new Set() };
    D.doses += q; D.ex += num(l.priceSubtotal) * sign; D.invoices.add(l.invoice.odooId);
    D.branches.add(bk);
    byDoctor.set(dk, D);

    const m = ymd(l.invoice.invoiceDate).slice(0, 7);
    const M = byMonth.get(m) || { month: m, label: MONTHS[Number(m.slice(5, 7)) - 1], doses: 0, units: 0, ex: 0 };
    M.doses += q; M.ex += num(l.priceSubtotal) * sign;
    byMonth.set(m, M);
  }

  const per = prod.dosesPerUnit || 1;
  const fin = (o) => ({
    ...o, doses: r3(o.doses), units: r3(o.doses / per), ex: r2(o.ex),
    invoices: o.invoices ? o.invoices.size : undefined,
    doctors: o.doctors ? [...o.doctors.entries()].map(([n, q]) => ({ name: n, doses: q, units: r3(q / per) })).sort((a, b) => b.doses - a.doses) : undefined,
    branches: o.branches ? [...o.branches] : undefined,
  });

  const s = stock.byId.get(id) || { qty: 0, byLocation: [] };
  const c = cost.byId.get(id);
  const cu = cost.unverified.get(id);

  /* Purchases of this product, matched by name — the one place the report has
     to cross from an id to a string, and it says which rule got it there.
     RESTRICTED to the tiers that mean the same name, like every other money
     figure: at `contains`, "Exocell" swallows "DQ EXOCELL 10ML Vial" and one
     product's purchases land on another's card. A rejected near-match is
     reported rather than dropped, because "we found something and would not
     trust it" is worth knowing. */
  const pool = C.poolOf([{ name: prod.name, id }], 'name', 'id');
  const nearMisses = [];
  const bl = await prisma.billLine.findMany({
    where: { bill: { date: { gte: new Date(from), lte: new Date(to) } } },
    select: { product: true, qty: true, unitPrice: true, subtotal: true, isBonus: true, bill: { select: { date: true, supplierName: true } } },
  });
  const mine = [];
  for (const l of bl) {
    const m = C.matchOne(l.product, pool);
    if (!m.hit) continue;
    if (C.COST_TIERS.has(m.rule)) mine.push({ ...l, matchRule: m.rule });
    else nearMisses.push({ product: l.product, rule: m.rule, net: r2(l.subtotal) });
  }

  return {
    product: {
      odooId: id, name: prod.name, category: prod.category, unit: prod.unit,
      vendorName: prod.vendorName, dosesPerUnit: per,
    },
    services,
    linked: services.length > 0,
    stock: {
      asOf: ymd(stock.takenAt),
      doses: r3(s.qty), units: r3(s.qty / per),
      byLocation: s.byLocation.map((l) => ({ ...l, units: r3(l.qty / per) })),
      unitCost: c ? r2(c.unitCost) : null,
      costSource: c ? c.source : null,
      costRule: c ? c.matchRule || null : null,
      value: c ? r2(s.qty * c.unitCost) : null,
      unverifiedUnitCost: !c && cu ? r2(cu.unitCost) : null,
    },
    purchases: {
      lines: mine.length,
      qty: r3(mine.reduce((t, l) => t + num(l.qty), 0)),
      net: r2(mine.reduce((t, l) => t + num(l.subtotal), 0)),
      bonusQty: r3(mine.filter((l) => l.isBonus).reduce((t, l) => t + num(l.qty), 0)),
      vendors: [...new Set(mine.map((l) => l.bill.supplierName))],
      matchRules: [...new Set(mine.map((l) => l.matchRule))],
      rows: mine.map((l) => ({
        date: ymd(l.bill.date), supplierName: l.bill.supplierName,
        qty: r3(l.qty), unitPrice: r2(l.unitPrice), subtotal: r2(l.subtotal), isBonus: l.isBonus,
      })).sort((a, b) => String(a.date).localeCompare(String(b.date))),
      nearMisses,
    },
    sales: {
      doses: r3(doses), units: r3(doses / per), ex: r2(ex), inc: r2(inc), invoices: invoices.size,
      branches: [...byBranch.values()].map(fin).sort((a, b) => b.doses - a.doses),
      doctors: [...byDoctor.values()].map(fin).sort((a, b) => b.doses - a.doses),
      months: [...byMonth.values()].map((m) => ({ ...m, doses: r3(m.doses), units: r3(m.doses / per), ex: r2(m.ex) }))
        .sort((a, b) => a.month.localeCompare(b.month)),
    },
    doctorBasis: 'Invoice.specialistName — the invoice header. InvoiceLine has no doctor column, so a doctor\'s figure is every line on an invoice she raised.',
  };
}

/** Which feed each half of this report is reading, and how fresh it is. */
async function syncStatus() {
  const [bills, pays, lots, returns, terms, uploads, snap] = await Promise.all([
    prisma.bill.aggregate({ _count: true, _max: { date: true }, _min: { date: true } }),
    prisma.vendorPayment.aggregate({ _count: true, _max: { date: true } }),
    prisma.expiryLot.aggregate({ _count: true }),
    prisma.purchaseReturn.groupBy({ by: ['source'], _count: true, _sum: { value: true } }),
    prisma.vendorTerm.count(),
    prisma.dataUpload.findMany({ where: { kind: { in: ['consumables:seed', 'returns', 'returns:seed'] } }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.stockQuant.aggregate({ _max: { takenAt: true } }),
  ]);
  const src = await prisma.bill.groupBy({ by: ['source'], _count: true, _sum: { net: true } });

  return {
    bills: {
      count: bills._count, from: ymd(bills._min.date), to: ymd(bills._max.date),
      sources: src.map((s) => ({ source: s.source, bills: s._count, net: r2(s._sum.net) })),
    },
    payments: { count: pays._count, to: ymd(pays._max.date) },
    stock: { asOf: ymd(snap._max.takenAt) },
    expiryLots: lots._count,
    returns: returns.map((r) => ({ source: r.source, rows: r._count, value: r2(r._sum.value) })),
    vendorTerms: terms,
    loads: uploads.map((u) => ({ at: u.createdAt, kind: u.kind, filename: u.filename, rows: u.rowsWritten, notes: u.notes })),
  };
}

/** Everything but the per-product drill-down, which is fetched on demand. */
async function build({ from, to }) {
  const [purchases, vendors, returns, payments, sync, cat] = await Promise.all([
    buildPurchases({ from, to }),
    buildVendors({ from, to }),
    buildReturns(),
    buildPayments({ from, to }),
    syncStatus(),
    C.catalogue(),
  ]);
  return {
    from,
    to,
    purchases,
    vendors,
    returns,
    payments,
    sync,
    /* The bridge the Products tab needs. Purchase lines are keyed by NAME and
       the drill-down by Odoo id, so the page has to be able to turn one into
       the other before it can offer a link — and a row it cannot resolve must
       say why rather than opening an empty card. */
    catalogue: cat.rows.map((r) => ({ odooId: r.odooId, name: r.name, category: r.category, unit: r.unit })),
    groups: SPEND_GROUPS.map((g) => ({ key: g.key, label: g.label, consumable: g.consumable })),
  };
}

module.exports = {
  build, buildPurchases, buildVendors, buildReturns, buildPayments, buildProduct, syncStatus,
  SPEND_GROUPS, groupOf, driftOf, MONTHS,
};
