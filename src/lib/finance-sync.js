/* ============================================================
   Pull payables from Odoo 18 into the finance tables.

   Written for the day the backfill lands. Odoo 18 went live 1 Aug 2026 and the
   supplier history before that was never migrated into it, so today this returns
   a handful of August bills and says so — which is exactly the thing worth
   knowing before switching a section over to it.

   Rows land as `source = 'odoo'` beside the imported snapshot. Nothing is
   deleted: a section reads whichever source its mode says, so a sync that comes
   back thin can be ignored by leaving the mode alone.

   What this does NOT sync is the opening and closing balances. They are ledger
   figures that the report's own `opening + bills − payments` does not reproduce,
   so inventing them from the movements would be worse than leaving them to the
   extract that has them. Under `stitched` the balances keep coming from the
   snapshot while the movements come from here, which is the honest split.
   ============================================================ */

const Mcp = require('./mcp.js');
const { prisma, dateOnly, num } = require('./db.js');

const CHUNK = 400;
const nameOf = (v) => (Array.isArray(v) ? v[1] : null);
const idOf = (v) => (Array.isArray(v) ? v[0] : null);
const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

/**
 * Sync vendor bills and supplier payments for a date window.
 *
 *   syncPayables({ token, from, to }) -> a report of what Odoo actually had
 *
 * The report is the point: it says how much history exists so the decision to
 * switch a section over is made on evidence rather than hope.
 */
async function syncPayables({ token, from, to, base = process.env.MCP_BASE_URL }) {
  const session = await Mcp.connect({ base, token });

  const bills = await session.callKw('account.move', 'search_read', [[
    ['move_type', 'in', ['in_invoice', 'in_refund']],
    ['state', '=', 'posted'],
    ['invoice_date', '>=', from],
    ['invoice_date', '<=', to],
  ], ['id', 'name', 'invoice_date', 'partner_id', 'amount_untaxed', 'amount_tax', 'amount_total', 'move_type']],
  { limit: 0, order: 'invoice_date asc, id asc' });

  const moveIds = bills.map((b) => b.id);
  const lines = [];
  for (let i = 0; i < moveIds.length; i += 200) {
    const got = await session.callKw('account.move.line', 'search_read', [[
      ['move_id', 'in', moveIds.slice(i, i + 200)],
      ['display_type', '=', 'product'],
    ], ['id', 'move_id', 'product_id', 'quantity', 'price_unit', 'price_subtotal']], { limit: 0 });
    lines.push(...got);
  }

  // Product categories, so a line can be grouped the way the snapshot's are.
  const productIds = [...new Set(lines.map((l) => idOf(l.product_id)).filter(Boolean))];
  const products = productIds.length
    ? await session.callKw('product.product', 'read', [productIds, ['id', 'display_name', 'categ_id']])
    : [];
  const catOf = new Map(products.map((p) => [p.id, nameOf(p.categ_id)]));

  /* `state` on a payment is paid | draft | in_process | canceled | rejected —
     not the `posted` an account.move uses. Only settled money counts. */
  const payments = await session.callKw('account.payment', 'search_read', [[
    ['partner_type', '=', 'supplier'],
    ['payment_type', '=', 'outbound'],
    ['state', '=', 'paid'],
    ['date', '>=', from],
    ['date', '<=', to],
  ], ['id', 'name', 'date', 'partner_id', 'amount', 'journal_id', 'memo', 'payment_reference']],
  { limit: 0, order: 'date asc, id asc' });

  /* Every bill and payment needs a supplier row to hang off. A partner Odoo knows
     about but the snapshot never saw is created with zero balances and flagged as
     Odoo-sourced, so it appears rather than breaking the write. */
  const partners = new Map();
  for (const b of bills) if (nameOf(b.partner_id)) partners.set(nameOf(b.partner_id), true);
  for (const p of payments) if (nameOf(p.partner_id)) partners.set(nameOf(p.partner_id), true);

  const billsWithVendorList = bills.filter((b) => nameOf(b.partner_id));
  const paymentsWithVendor = payments.filter((p) => nameOf(p.partner_id));

  const known = new Set((await prisma.supplier.findMany({ select: { name: true } })).map((s) => s.name));
  const created = [...partners.keys()].filter((n) => !known.has(n));

  const journalMethods = await prisma.journalMethod.findMany();
  const methodOf = new Map(journalMethods.map((j) => [j.journal, j.method]));

  await prisma.$transaction(async (tx) => {
    for (const name of created) {
      await tx.supplier.create({ data: { name, category: null, opening: 0, closing: 0, source: 'odoo' } });
    }

    // Wholesale replacement of the window, the same rule the sales sync follows:
    // bills get amended and un-posted after the fact.
    await tx.bill.deleteMany({
      where: { source: 'odoo', date: { gte: dateOnly(from), lte: dateOnly(to) } },
    });
    await tx.vendorPayment.deleteMany({
      where: { source: 'odoo', date: { gte: dateOnly(from), lte: dateOnly(to) } },
    });

    const linesByMove = new Map();
    for (const l of lines) {
      const mid = idOf(l.move_id) ?? l.move_id;
      (linesByMove.get(mid) || linesByMove.set(mid, []).get(mid)).push(l);
    }

    for (const b of bills) {
      if (!nameOf(b.partner_id)) continue; // a bill with no vendor cannot be filed
      const sign = b.move_type === 'in_refund' ? -1 : 1;
      const row = await tx.bill.create({
        data: {
          ref: b.name || `move:${b.id}`,
          supplierName: nameOf(b.partner_id),
          date: dateOnly(b.invoice_date),
          gross: r2(sign * num(b.amount_total)),
          net: r2(sign * num(b.amount_untaxed)),
          vat: r2(sign * num(b.amount_tax)),
          branch: null,
          srcSystem: 'odoo18',
          source: 'odoo',
        },
      });
      const own = linesByMove.get(b.id) || [];
      if (own.length) {
        await tx.billLine.createMany({
          data: own.map((l) => ({
            billId: row.id,
            product: nameOf(l.product_id) || '(no product)',
            category: catOf.get(idOf(l.product_id)) || null,
            qty: num(l.quantity),
            unitPrice: r2(num(l.price_unit)),
            subtotal: r2(sign * num(l.price_subtotal)),
            // Free goods: a real quantity carrying no money.
            isBonus: num(l.quantity) > 0 && r2(num(l.price_subtotal)) === 0,
          })),
        });
      }
    }

    /* A petty-cash payment often carries no vendor at all — it settles an expense,
       not a supplier account. Payables is supplier-centric, so those cannot be
       filed here; they are counted and reported rather than quietly dropped. */
    const withVendor = payments.filter((p) => nameOf(p.partner_id));
    const payRows = withVendor
      .map((p) => ({
        supplierName: nameOf(p.partner_id),
        date: dateOnly(p.date),
        amount: r2(num(p.amount)),
        journal: nameOf(p.journal_id) || '(no journal)',
        ref: p.payment_reference || p.memo || null,
        // The method is a label over the journal name, never an Odoo field.
        method: methodOf.get(nameOf(p.journal_id)) || null,
        source: 'odoo',
      }));
    for (let i = 0; i < payRows.length; i += CHUNK) {
      await tx.vendorPayment.createMany({ data: payRows.slice(i, i + CHUNK) });
    }

    await tx.financeBatch.deleteMany({ where: { section: 'payables', source: 'odoo' } });
    await tx.financeBatch.create({
      data: {
        section: 'payables', source: 'odoo', asOf: dateOnly(to),
        rowCount: billsWithVendorList.length + paymentsWithVendor.length,
        label: `Odoo 18 · ${from}..${to}`,
      },
    });
  }, { timeout: 120_000 });

  const billsWithVendor = billsWithVendorList.length;
  const paysWithVendor = paymentsWithVendor.length;
  const earliest = bills.length ? String(bills[0].invoice_date).slice(0, 10) : null;
  const unmapped = [...new Set(payments.map((p) => nameOf(p.journal_id)).filter((j) => j && !methodOf.has(j)))];

  return {
    from, to,
    /* `found` is what Odoo returned; `written` is what could be filed against a
       supplier. Reporting only the first number would have claimed 74 payments
       while storing one. */
    billsFound: bills.length,
    billsWritten: billsWithVendor,
    billsNoVendor: bills.length - billsWithVendor,
    billLines: lines.length,
    paymentsFound: payments.length,
    paymentsWritten: paysWithVendor,
    paymentsNoVendor: payments.length - paysWithVendor,
    suppliersCreated: created,
    earliestBill: earliest,
    billTotal: r2(bills.reduce((s, b) => s + (b.move_type === 'in_refund' ? -1 : 1) * num(b.amount_total), 0)),
    paymentTotal: r2(payments.filter((p) => nameOf(p.partner_id)).reduce((s, p) => s + num(p.amount), 0)),
    paymentTotalNoVendor: r2(payments.filter((p) => !nameOf(p.partner_id)).reduce((s, p) => s + num(p.amount), 0)),
    unmappedJournals: unmapped,
    /* Balances are deliberately not synced — see the note at the top of this file. */
    balancesSynced: false,
  };
}

/* ---------------------------------------------------------- collections ---
 *
 * Customer receipts, live from Odoo 18, into the same Collection table the
 * imported snapshot filled — so the Sales overview card and the collections
 * section read one shape whichever source is in play.
 *
 * WHY THIS EXISTS: the snapshot was frozen on 2026-08-11 and is already 12.3%
 * short. For 1-10 August it says 7,539,452 where Odoo now says 8,448,561 —
 * 930,079 EGP of receipts were posted after it was taken, and every one of the
 * eleven branches is higher. Payments arriving late is normal here; a frozen
 * snapshot silently under-reporting collections for the rest of the year is not.
 *
 * WHAT MAPS TO WHAT
 *   gross     inbound  paid customer payments
 *   refunds   outbound paid customer payments — money going back to a patient
 *   net       gross - refunds
 *   branch    payment.branch_id (clinic.branch) — real attribution, not journal
 *             name parsing. Only 1 payment in 3,911 lacks it.
 *   register  journal folded onto the six canonical registers by
 *             finance-rules.registerForJournal, so the T+0/T+1/settlement split
 *             keeps working
 *   txns      count of inbound payments
 *
 * `state` must be 'paid'. A payment is paid | draft | in_process | canceled |
 * rejected — NOT the 'posted' an account.move uses. In the 1-20 August window
 * that distinction is 181 payments; counting them would inflate collections with
 * money nobody has received.
 *
 * packageShare is NOT synced. The snapshot carried it as "the share OF net
 * settled against package-sale invoices", which needs each payment reconciled
 * back to its invoice and that invoice identified as a package sale. Odoo has a
 * "Package sale journal" and a "Package payment method", but neither is on the
 * payment, and guessing would put a fabricated number in a column the report
 * describes precisely. It stays 0 under source='odoo' and the caller is told.
 */
async function syncCollections({ token, from, to, base = process.env.MCP_BASE_URL }) {
  const R = require('./finance-rules.js');
  const session = await Mcp.connect({ base, token });

  const fetch = (paymentType) => session.callKw('account.payment', 'search_read', [[
    ['partner_type', '=', 'customer'],
    ['payment_type', '=', paymentType],
    ['state', '=', 'paid'],
    ['date', '>=', from],
    ['date', '<=', to],
  ], ['id', 'date', 'amount', 'journal_id', 'branch_id']],
  { limit: 0, order: 'date asc, id asc' });

  const [inbound, outbound] = await Promise.all([fetch('inbound'), fetch('outbound')]);

  /* One bucket per (date, branch, register) — the table's own unique key. */
  const buckets = new Map();
  const unmappedJournals = new Map();
  const noBranch = { count: 0, amount: 0 };
  const NO_BRANCH = 'Unassigned';

  const put = (p, field) => {
    const journal = nameOf(p.journal_id);
    const mapped = R.registerForJournal(journal);
    if (!mapped && journal) {
      const seen = unmappedJournals.get(journal) || { count: 0, amount: 0 };
      unmappedJournals.set(journal, { count: seen.count + 1, amount: r2(seen.amount + p.amount) });
    }
    /* An unrecognised journal keeps its own name rather than being dropped or
       folded into Cash: the money still appears, under a register the UI shows as
       unclassified, and the caller gets told which journals need a rule. */
    const register = mapped || journal || '(no journal)';
    const branch = nameOf(p.branch_id) || NO_BRANCH;
    if (!nameOf(p.branch_id)) { noBranch.count++; noBranch.amount = r2(noBranch.amount + p.amount); }
    const date = String(p.date).slice(0, 10);
    const key = `${date}|${branch}|${register}`;
    const b = buckets.get(key) || { date, branch, register, gross: 0, refunds: 0, txns: 0 };
    b[field] = r2(b[field] + p.amount);
    if (field === 'gross') b.txns += 1;
    buckets.set(key, b);
  };

  for (const p of inbound) put(p, 'gross');
  for (const p of outbound) put(p, 'refunds');

  const rows = [...buckets.values()].map((b) => ({
    date: dateOnly(b.date),
    branch: b.branch,
    register: b.register,
    gross: r2(b.gross).toFixed(2),
    refunds: r2(b.refunds).toFixed(2),
    net: r2(b.gross - b.refunds).toFixed(2),
    packageShare: '0.00',
    txns: b.txns,
    source: 'odoo',
  }));

  const grossTotal = r2(inbound.reduce((a, p) => a + p.amount, 0));
  const refundTotal = r2(outbound.reduce((a, p) => a + p.amount, 0));

  /* CollectionDay is a per-day rollup that buildCollections reads for its TOTALS
     and its day summary, while the registers, branches and grids come from
     Collection. Writing one without the other is why the first run of this sync
     produced a section whose grids showed 8,443,961 and whose headline said 0.
     Rolled up here from the same buckets, so the two cannot disagree. */
  const dayRoll = new Map();
  for (const b of buckets.values()) {
    const d = dayRoll.get(b.date) || { date: b.date, gross: 0, refunds: 0, txns: 0 };
    d.gross = r2(d.gross + b.gross);
    d.refunds = r2(d.refunds + b.refunds);
    d.txns += b.txns;
    dayRoll.set(b.date, d);
  }
  const dayRows = [...dayRoll.values()].map((d) => ({
    date: dateOnly(d.date),
    gross: r2(d.gross).toFixed(2),
    refunds: r2(d.refunds).toFixed(2),
    net: r2(d.gross - d.refunds).toFixed(2),
    packageShare: '0.00',
    txns: d.txns,
    source: 'odoo',
  }));

  /* Replace only the Odoo rows in this window, in one transaction. The snapshot
     rows are a different `source` and are never touched, so switching back to
     them stays possible — and a re-sync of the same window cannot double a
     single piastre. */
  let written = 0;
  await prisma.$transaction(async (tx) => {
    await tx.collection.deleteMany({
      where: { source: 'odoo', date: { gte: dateOnly(from), lte: dateOnly(to) } },
    });
    await tx.collectionDay.deleteMany({
      where: { source: 'odoo', date: { gte: dateOnly(from), lte: dateOnly(to) } },
    });
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const made = await tx.collection.createMany({ data: slice });
      written += made.count;
    }
    await tx.collectionDay.createMany({ data: dayRows });
    await tx.financeBatch.create({
      data: {
        section: 'collections', source: 'odoo', asOf: dateOnly(to),
        rowCount: written, label: `Odoo customer payments ${from}..${to}`,
      },
    });
  }, { timeout: 120000 });

  return {
    from, to,
    paymentsFound: inbound.length + outbound.length,
    inbound: inbound.length,
    outbound: outbound.length,
    rowsWritten: written,
    dayRowsWritten: dayRows.length,
    gross: grossTotal,
    refunds: refundTotal,
    net: r2(grossTotal - refundTotal),
    branches: new Set(rows.map((r) => r.branch)).size,
    days: new Set(rows.map((r) => String(r.date.toISOString()).slice(0, 10))).size,
    /* Reported, never hidden: a journal with no rule, and receipts with no branch. */
    unmappedJournals: [...unmappedJournals.entries()]
      .map(([journal, v]) => ({ journal, ...v }))
      .sort((a, b) => b.amount - a.amount),
    noBranch,
    packageShareSynced: false,
  };
}

/** The package journal. Odoo id, not a name — names get edited, ids do not. */
const PACKAGE_JOURNAL = 116;

/**
 * Pull package sales and settlements into `PackageDay`.
 *
 * WITHOUT THIS EVERY BRANCH'S "COLLECTED" IS WRONG. The targets report does not
 * read cash in; it reads
 *
 *     (cash in − refunds − package sales + package used) ÷ 1.14
 *
 * because a package is paid up front and delivered over months. With these two
 * terms missing they silently evaluate to zero, so a branch that sold a package
 * today looks like it collected the whole price, and one working through
 * packages sold months ago looks like it collected nothing. On one ordinary day
 * that put Loran 1,447 under and Roushdy 3,290 over.
 *
 * Deliberately a SEPARATE function from syncCollections rather than another
 * query inside it: these are invoices and journal entries, not payments, and
 * folding them in would mean one failure takes out both.
 */
async function syncPackages({ token, from, to, base = process.env.MCP_BASE_URL }) {
  const session = await Mcp.connect({ base, token });

  const [sales, settlements] = await Promise.all([
    /* Package invoices. `amount_residual_signed` is the unpaid part, which the
       report nets off — an unpaid package has taken no cash, so it should not
       be deducted from what the branch collected. */
    session.callKw('account.move', 'search_read', [[
      ['invoice_date', '>=', from],
      ['invoice_date', '<=', to],
      ['state', '=', 'posted'],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['journal_id', '=', PACKAGE_JOURNAL],
    ], ['id', 'invoice_date', 'branch_id', 'amount_total_signed', 'amount_residual_signed']],
    { limit: 0, order: 'invoice_date asc, id asc' }),

    /* Settlements are journal ENTRIES, not invoices: the accounting move that
       recognises a slice of a package as it is delivered. */
    session.callKw('account.move', 'search_read', [[
      ['date', '>=', from],
      ['date', '<=', to],
      ['state', '=', 'posted'],
      ['move_type', '=', 'entry'],
      ['pkg_settled_amount', '>', 0],
    ], ['id', 'date', 'branch_id', 'pkg_settled_amount']],
    { limit: 0, order: 'date asc, id asc' }),
  ]);

  const NO_BRANCH = 'Unassigned';
  const buckets = new Map();
  const bucket = (date, branch) => {
    const key = `${date}|${branch}`;
    const b = buckets.get(key)
      || { date, branch, saleTotal: 0, saleResidual: 0, settled: 0, sales: 0, settlements: 0 };
    buckets.set(key, b);
    return b;
  };

  const noBranch = { sales: 0, settlements: 0, amount: 0 };
  for (const m of sales) {
    const branch = nameOf(m.branch_id) || NO_BRANCH;
    if (!nameOf(m.branch_id)) { noBranch.sales += 1; noBranch.amount = r2(noBranch.amount + (m.amount_total_signed || 0)); }
    const b = bucket(String(m.invoice_date).slice(0, 10), branch);
    b.saleTotal = r2(b.saleTotal + (m.amount_total_signed || 0));
    b.saleResidual = r2(b.saleResidual + (m.amount_residual_signed || 0));
    b.sales += 1;
  }
  for (const m of settlements) {
    const branch = nameOf(m.branch_id) || NO_BRANCH;
    if (!nameOf(m.branch_id)) { noBranch.settlements += 1; }
    const b = bucket(String(m.date).slice(0, 10), branch);
    b.settled = r2(b.settled + (m.pkg_settled_amount || 0));
    b.settlements += 1;
  }

  const rows = [...buckets.values()].map((b) => ({
    date: dateOnly(b.date),
    branchName: b.branch,
    saleTotal: r2(b.saleTotal).toFixed(2),
    saleResidual: r2(b.saleResidual).toFixed(2),
    settled: r2(b.settled).toFixed(2),
    sales: b.sales,
    settlements: b.settlements,
    source: 'odoo',
  }));

  /* Replace only this window's Odoo rows, as syncCollections does, so a
     re-sync cannot double anything. */
  let written = 0;
  await prisma.$transaction(async (tx) => {
    await tx.packageDay.deleteMany({
      where: { source: 'odoo', date: { gte: dateOnly(from), lte: dateOnly(to) } },
    });
    for (let i = 0; i < rows.length; i += CHUNK) {
      const made = await tx.packageDay.createMany({ data: rows.slice(i, i + CHUNK) });
      written += made.count;
    }
  }, { timeout: 120000 });

  const sum = (arr, f) => r2(arr.reduce((a, x) => a + (f(x) || 0), 0));
  return {
    from,
    to,
    salesFound: sales.length,
    settlementsFound: settlements.length,
    rowsWritten: written,
    saleTotal: sum(sales, (m) => m.amount_total_signed),
    saleResidual: sum(sales, (m) => m.amount_residual_signed),
    settled: sum(settlements, (m) => m.pkg_settled_amount),
    branches: new Set(rows.map((r) => r.branchName)).size,
    noBranch,
  };
}

module.exports = { syncPayables, syncCollections, syncPackages };

