/* ============================================================
   Pull invoices, lines and stock from the MCP into Postgres.

   The page never queries the MCP: a month is roughly 5,700 invoices and 12,000
   lines arriving as JSON inside a text block, which is far too slow to do on
   every load. Sync once, then every cut is a GROUP BY.

   Invoices get un-posted after the fact — 3 August read 886,298 over 174
   invoices on 8 August and 873,427 over 173 two days later — so a window is
   always replaced wholesale, never merely topped up.
   ============================================================ */

const Mcp = require('./mcp.js');
const { prisma, dateOnly, num } = require('./db.js');

const CHUNK = 500;
const nameOf = (v) => (Array.isArray(v) ? v[1] : null);
const idOf = (v) => (Array.isArray(v) ? v[0] : null);

/* The mobile join key. Imported, never reimplemented: two copies of this rule
   drifting apart is precisely how 594 patients got counted twice. */
const { mobileKey } = require('./patients.js');
const money = (v) => (v === false || v === null || v === undefined ? null : num(v).toFixed(2));

async function fetchInvoices(session, from, to) {
  return session.callKw('account.move', 'search_read', [[
    ['state', '=', 'posted'],
    ['move_type', 'in', ['out_invoice', 'out_refund']],
    ['invoice_date', '>=', from],
    ['invoice_date', '<=', to],
  ], [
    'id', 'name', 'invoice_date', 'move_type', 'state', 'branch_id', 'specialist_id',
    'partner_id', 'amount_untaxed', 'amount_total', 'is_new_customer', 'journal_id',
  ]], { limit: 0, order: 'invoice_date asc, id asc' });
}

async function fetchLines(session, moveIds) {
  const out = [];
  for (let i = 0; i < moveIds.length; i += 800) {
    const rows = await session.callKw('account.move.line', 'search_read', [[
      ['move_id', 'in', moveIds.slice(i, i + 800)],
      ['display_type', '=', 'product'],
    ], ['id', 'move_id', 'product_id', 'quantity', 'price_subtotal', 'price_total']], { limit: 0 });
    out.push(...rows);
  }
  return out;
}

/**
 * Replace everything in [from, to] with what the MCP reports right now.
 * Returns { invoices, lines, days }.
 */
async function syncRange({ token, from, to, trigger = 'manual', actor = null }) {
  const run = await prisma.syncRun.create({
    data: { fromDate: dateOnly(from), toDate: dateOnly(to), trigger, actor },
  });

  try {
    const session = await Mcp.connect({ base: process.env.MCP_BASE_URL, token });
    const invoices = await fetchInvoices(session, from, to);
    const moveIds = invoices.map((m) => m.id);
    const lines = moveIds.length ? await fetchLines(session, moveIds) : [];

    const productIds = [...new Set(lines.map((l) => idOf(l.product_id)).filter(Boolean))];
    const products = productIds.length
      ? await session.callKw('product.product', 'read', [productIds, ['id', 'display_name', 'categ_id']])
      : [];
    const byProduct = new Map(products.map((p) => [p.id, p]));

    await prisma.$transaction(async (tx) => {
      /* Wholesale replacement: an invoice that was un-posted must disappear, and
         deleting the parent cascades to its lines.

         The delete matches the ids we are about to write as WELL as the date
         window, and that second clause is load-bearing rather than defensive.
         Odoo corrects invoice dates after the fact — the premise this whole cache
         is built on. When a correction moves a date ACROSS the window boundary the
         old row sits outside the range being cleared, survives it, and the insert
         then dies on the odooId unique constraint, taking the entire sync down.

         Seen for real on 2026-09-01: INV/2026/5479 and INV/2026/5358 were held at
         2026-09-01 while Odoo had already moved them to 16 and 9 August, so a
         1-31 August sync failed outright. Deleting by date alone cannot reach
         them, because the stale date is the very thing that is wrong. */
      const fetchedIds = invoices.map((m) => m.id);
      await tx.invoice.deleteMany({
        where: {
          OR: [
            { invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) } },
            ...(fetchedIds.length ? [{ odooId: { in: fetchedIds } }] : []),
          ],
        },
      });

      for (let i = 0; i < invoices.length; i += CHUNK) {
        await tx.invoice.createMany({
          data: invoices.slice(i, i + CHUNK).map((m) => ({
            odooId: m.id,
            name: m.name || '',
            invoiceDate: dateOnly(m.invoice_date),
            moveType: m.move_type,
            state: m.state,
            branchId: idOf(m.branch_id),
            branchName: nameOf(m.branch_id),
            specialistId: idOf(m.specialist_id),
            specialistName: nameOf(m.specialist_id),
            partnerId: idOf(m.partner_id),
            partnerName: nameOf(m.partner_id),
            amountUntaxed: m.amount_untaxed ?? 0,
            amountTotal: m.amount_total ?? 0,
            isNewCustomer: !!m.is_new_customer,
            /* "Package sale journal" is 7.1% of August revenue and carries no VAT
               at all — packages are invoiced when SOLD, not when delivered. Kept
               on the row so a report can exclude them and compare revenue with
               collections on a like basis. */
            journalId: idOf(m.journal_id),
            journalName: nameOf(m.journal_id),
          })),
        });
      }

      const known = new Set(moveIds);
      const lineRows = lines
        .filter((l) => known.has(idOf(l.move_id) ?? l.move_id))
        .map((l) => {
          const p = byProduct.get(idOf(l.product_id));
          return {
            odooId: l.id,
            invoiceOdooId: idOf(l.move_id) ?? l.move_id,
            productId: idOf(l.product_id),
            productName: p ? p.display_name : nameOf(l.product_id),
            categoryId: p ? idOf(p.categ_id) : null,
            categoryName: p ? nameOf(p.categ_id) : null,
            quantity: l.quantity ?? 0,
            priceSubtotal: l.price_subtotal ?? 0,
            priceTotal: l.price_total ?? 0,
          };
        });

      for (let i = 0; i < lineRows.length; i += CHUNK) {
        await tx.invoiceLine.createMany({ data: lineRows.slice(i, i + CHUNK) });
      }
    }, { timeout: 120_000 });

    // One row per day per pull — this is what turns "154 invoices when first
    // pulled, 186 now" from a hand-written note into tracked history.
    const byDay = new Map();
    for (const m of invoices) {
      if (m.move_type !== 'out_invoice') continue;
      const d = String(m.invoice_date).slice(0, 10);
      const acc = byDay.get(d) || { invoices: 0, ex: 0, inc: 0 };
      acc.invoices += 1; acc.ex += num(m.amount_untaxed); acc.inc += num(m.amount_total);
      byDay.set(d, acc);
    }
    if (byDay.size) {
      await prisma.daySnapshot.createMany({
        data: [...byDay].map(([d, v]) => ({
          date: dateOnly(d), invoices: v.invoices,
          amountUntaxed: v.ex.toFixed(2), amountTotal: v.inc.toFixed(2),
        })),
      });
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'ok', invoices: invoices.length, lines: lines.length },
    });
    return { runId: run.id, invoices: invoices.length, lines: lines.length, days: byDay.size };
  } catch (e) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'failed', error: String(e.message || e).slice(0, 800) },
    });
    throw e;
  }
}

/** Stock is a point-in-time snapshot, so each run is stamped and kept. */
async function syncStock({ token, scanLimit = 400 }) {
  const session = await Mcp.connect({ base: process.env.MCP_BASE_URL, token });
  const takenAt = new Date();

  const grouped = await session.callKw('stock.quant', 'read_group', [
    [['location_id.usage', '=', 'internal']],
    ['quantity:sum'], ['product_id', 'location_id'],
  ], { lazy: false, limit: 0 });

  const productIds = [...new Set(grouped.map((g) => idOf(g.product_id)).filter(Boolean))].slice(0, scanLimit);
  const info = productIds.length
    ? await session.callKw('product.product', 'read', [productIds, ['id', 'display_name', 'categ_id', 'uom_id']])
    : [];
  const byId = new Map(info.map((p) => [p.id, p]));

  const rows = grouped
    .filter((g) => byId.has(idOf(g.product_id)))
    .map((g) => {
      const p = byId.get(idOf(g.product_id));
      return {
        takenAt,
        productId: p.id,
        productName: p.display_name,
        categoryName: nameOf(p.categ_id),
        uom: nameOf(p.uom_id),
        locationId: idOf(g.location_id),
        locationName: nameOf(g.location_id) || '—',
        quantity: num(g.quantity).toFixed(3),
      };
    });

  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.stockQuant.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
  }
  return { takenAt, rows: rows.length, products: byId.size, scanned: grouped.length };
}


/* --------------------------------------------------------- appointments ---
 *
 * Bookings, so the funnel has a middle. Until this existed the show rate could
 * not be computed at all: report 05 said "attendance join not pulled" and
 * report 06 listed the appointment model as an open question.
 *
 * Replaced wholesale for the window, matched on the ids being written as WELL as
 * the date — the same correction the invoice sync needed, because Odoo moves
 * appointment dates after the fact too and a delete-by-date alone would leave a
 * stale row behind and then collide on the primary key.
 */
async function syncAppointments({ token, from, to, base = process.env.MCP_BASE_URL }) {
  const session = await Mcp.connect({ base, token });
  const rows = await session.callKw('appointment', 'search_read', [[
    ['date', '>=', from], ['date', '<=', to],
  ], [
    'id', 'name', 'date', 'states', 'cancel_reason', 'branch_id', 'specialist_id',
    'partner_id', 'create_uid', 'create_date', 'invoice_total', 'appointment_due_amount',
    'is_rescheduled', 'mobile', 'category_ids', 'has_laser_service',
  ]], { limit: 0, order: 'date asc, id asc' });

  /* Resolve service category ids to names in ONE read rather than per booking.
     7,655 bookings reference a few dozen categories, so a read per booking would
     be thousands of round trips for the same handful of names. */
  const catIds = [...new Set(rows.flatMap((a) => a.category_ids || []))];
  const catName = new Map();
  for (let i = 0; i < catIds.length; i += 200) {
    const chunk = catIds.slice(i, i + 200);
    for (const c of await session.callKw('service.category', 'read', [chunk, ['name']], {})) {
      catName.set(c.id, c.name);
    }
  }

  const data = rows.map((a) => ({
    odooId: a.id,
    name: a.name || null,
    date: dateOnly(a.date),
    states: a.states || 'unknown',
    cancelReason: a.cancel_reason || null,
    branchId: idOf(a.branch_id),
    branchName: nameOf(a.branch_id),
    specialistId: idOf(a.specialist_id),
    specialistName: nameOf(a.specialist_id),
    partnerId: idOf(a.partner_id),
    partnerName: nameOf(a.partner_id),
    createUid: idOf(a.create_uid),
    createdBy: nameOf(a.create_uid),
    createdAt: a.create_date ? new Date(`${String(a.create_date).replace(' ', 'T')}Z`) : null,
    mobileKey: mobileKey(a.mobile),
    invoiceTotal: money(a.invoice_total),
    dueAmount: money(a.appointment_due_amount),
    isRescheduled: !!a.is_rescheduled,
    categories: (a.category_ids || []).map((id) => catName.get(id)).filter(Boolean),
    hasLaser: !!a.has_laser_service,
  }));

  let written = 0;
  await prisma.$transaction(async (tx) => {
    const ids = data.map((d) => d.odooId);
    await tx.appointment.deleteMany({
      where: {
        OR: [
          { date: { gte: dateOnly(from), lte: dateOnly(to) } },
          ...(ids.length ? [{ odooId: { in: ids } }] : []),
        ],
      },
    });
    for (let i = 0; i < data.length; i += CHUNK) {
      const made = await tx.appointment.createMany({ data: data.slice(i, i + CHUNK) });
      written += made.count;
    }
  }, { timeout: 120000 });

  const A = require('./appointments.js');
  const counts = data.reduce((acc, d) => { acc[A.group(d.states)] += 1; return acc; },
    { attended: 0, lost: 0, open: 0 });
  return {
    from, to, found: rows.length, written, ...counts,
    showRate: rows.length ? counts.attended / rows.length : 0,
    withoutMobile: data.filter((d) => !d.mobileKey).length,
    withoutCategory: data.filter((d) => !d.categories.length).length,
    categoriesSeen: catName.size,
    branches: new Set(data.map((d) => d.branchName).filter(Boolean)).size,
  };
}

module.exports = { syncRange, syncStock, syncAppointments };
