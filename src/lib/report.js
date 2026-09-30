/* ============================================================
   Every report cut, straight out of Postgres.

   Same shape the browser report used, so the rendering carries over unchanged:
   branch / doctor / day come from invoice headers (branch_id and specialist_id
   live on account.move, not on the line), while product and category come from
   the lines. Both reconcile to the same ex-VAT total.
   ============================================================ */

const { prisma, num, ymd, dateOnly } = require('./db.js');

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const UNASSIGNED = 'Unassigned';

/**
 * Header-level cuts: one GROUP BY per dimension over the invoice table.
 *
 * `journals` — when given — is the list of journals to LEAVE OUT of every cut.
 * It is threaded through rather than applied afterwards because a report whose
 * total excludes packages but whose branch rows do not is a report that no
 * longer adds up, and the branch/doctor/day/product cuts reconciling to one
 * total is the property this file exists to preserve.
 */
async function headerCuts(from, to, journals = null) {
  const where = {
    invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) },
    moveType: 'out_invoice',
    ...(journals && journals.length
      ? { OR: [{ journalName: null }, { journalName: { notIn: journals } }] }
      : {}),
  };

  const [byBranch, byDoctor, byDay, byPair, totals] = await Promise.all([
    prisma.invoice.groupBy({ by: ['branchName'], where, _sum: { amountUntaxed: true, amountTotal: true }, _count: true }),
    prisma.invoice.groupBy({ by: ['specialistName'], where, _sum: { amountUntaxed: true, amountTotal: true }, _count: true }),
    prisma.invoice.groupBy({ by: ['invoiceDate'], where, _sum: { amountUntaxed: true, amountTotal: true }, _count: true }),
    prisma.invoice.groupBy({ by: ['branchName', 'specialistName'], where, _sum: { amountUntaxed: true, amountTotal: true }, _count: true }),
    prisma.invoice.aggregate({ where, _sum: { amountUntaxed: true, amountTotal: true }, _count: true }),
  ]);

  const shape = (rows, field) => rows
    .map((r) => ({
      name: r[field] || UNASSIGNED,
      ex: r2(num(r._sum.amountUntaxed)),
      inc: r2(num(r._sum.amountTotal)),
      invoices: r._count,
    }))
    .sort((a, b) => b.ex - a.ex);

  const branches = shape(byBranch, 'branchName');
  const doctors = shape(byDoctor, 'specialistName');

  // Doctor counts per branch and branch lists per doctor come from the pair cut,
  // so they cannot disagree with the totals above.
  const perBranch = {}, doctorBranches = {};
  for (const p of byPair) {
    const b = p.branchName || UNASSIGNED, d = p.specialistName || UNASSIGNED;
    (perBranch[b] ||= []).push({
      name: d, ex: r2(num(p._sum.amountUntaxed)), inc: r2(num(p._sum.amountTotal)), invoices: p._count,
    });
    (doctorBranches[d] ||= new Set()).add(b);
  }
  for (const k of Object.keys(perBranch)) perBranch[k].sort((a, b) => b.ex - a.ex);
  for (const b of branches) b.doctors = (perBranch[b.name] || []).length;
  for (const d of doctors) d.branches = [...(doctorBranches[d.name] || [])];

  return {
    branches,
    doctors,
    branchDoctors: perBranch,
    days: byDay
      .map((r) => ({ date: ymd(r.invoiceDate), ex: r2(num(r._sum.amountUntaxed)), inc: r2(num(r._sum.amountTotal)), invoices: r._count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    totals: {
      ex: r2(num(totals._sum.amountUntaxed)),
      inc: r2(num(totals._sum.amountTotal)),
      invoices: totals._count,
    },
  };
}

/* Line-level cuts need the invoice's branch and doctor, which live on the parent,
   so these are raw SQL joins rather than Prisma groupBy. */

/* The journal filter, as one fragment shared by every line query below.
   `$3` is either NULL (keep everything) or the list of journals to leave out.

   An invoice whose journal is NULL is KEPT, deliberately and consistently with
   revenueExcludingJournals: a journal we cannot read is not evidence of a
   package, and dropping revenue we failed to classify would understate the
   report rather than merely mislabel it. `journalCoverage` reports how much of
   the window can actually be classified, so a page can say when that assumption
   is doing real work. */
const JOURNAL_FILTER = `
     AND ($3::text[] IS NULL OR i."journalName" IS NULL
          OR NOT (i."journalName" = ANY($3::text[])))`;

const lineCut = (dim) => `
  SELECT ${dim} AS name,
         SUM(l."priceSubtotal")::float8 AS ex,
         SUM(l."priceTotal")::float8    AS inc,
         SUM(l.quantity)::float8        AS qty,
         COUNT(*)::int                  AS lines,
         COUNT(DISTINCT i."odooId")::int AS invoices
    FROM "InvoiceLine" l
    JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
   WHERE i."invoiceDate" BETWEEN $1::date AND $2::date
     AND i."moveType" = 'out_invoice'${JOURNAL_FILTER}
   GROUP BY 1
   ORDER BY ex DESC`;

async function lineCuts(from, to, journals = null) {
  const q = (sql) => prisma.$queryRawUnsafe(sql, from, to, journals && journals.length ? journals : null);

  const [products, categories, branchProducts, doctorProducts, lineCount] = await Promise.all([
    q(`
      SELECT COALESCE(l."productName", 'Unknown product') AS name,
             MAX(COALESCE(l."categoryName", 'Uncategorised')) AS category,
             MAX(l."productId") AS "productId",
             SUM(l."priceSubtotal")::float8 AS ex, SUM(l."priceTotal")::float8 AS inc,
             SUM(l.quantity)::float8 AS qty, COUNT(*)::int AS lines,
             COUNT(DISTINCT i."odooId")::int AS invoices
        FROM "InvoiceLine" l JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
       WHERE i."invoiceDate" BETWEEN $1::date AND $2::date AND i."moveType" = 'out_invoice'${JOURNAL_FILTER}
       GROUP BY 1 ORDER BY ex DESC`),
    q(lineCut(`COALESCE(l."categoryName", 'Uncategorised')`)),
    q(`
      SELECT COALESCE(i."branchName", '${UNASSIGNED}') AS branch,
             COALESCE(l."productName", 'Unknown product') AS name,
             SUM(l."priceSubtotal")::float8 AS ex, SUM(l."priceTotal")::float8 AS inc,
             SUM(l.quantity)::float8 AS qty, COUNT(*)::int AS lines,
             -- The distinct invoices behind those lines. The products rollup
             -- above has always carried this and these two did not, so the Sales
             -- report's Doctors tab rendered the literal word "undefined" where
             -- an invoice count belongs, under every product of every doctor:
             -- 1,099 rows of it, on the most-used page in the app. Kept as a SQL
             -- comment rather than a JS one because this string is a template
             -- literal, and a backtick inside it ends the query.
             COUNT(DISTINCT i."odooId")::int AS invoices
        FROM "InvoiceLine" l JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
       WHERE i."invoiceDate" BETWEEN $1::date AND $2::date AND i."moveType" = 'out_invoice'${JOURNAL_FILTER}
       GROUP BY 1, 2 ORDER BY ex DESC`),
    q(`
      SELECT COALESCE(i."specialistName", '${UNASSIGNED}') AS doctor,
             COALESCE(l."productName", 'Unknown product') AS name,
             SUM(l."priceSubtotal")::float8 AS ex, SUM(l."priceTotal")::float8 AS inc,
             SUM(l.quantity)::float8 AS qty, COUNT(*)::int AS lines,
             COUNT(DISTINCT i."odooId")::int AS invoices
        FROM "InvoiceLine" l JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
       WHERE i."invoiceDate" BETWEEN $1::date AND $2::date AND i."moveType" = 'out_invoice'${JOURNAL_FILTER}
       GROUP BY 1, 2 ORDER BY ex DESC`),
    q(`
      SELECT COUNT(*)::int AS n FROM "InvoiceLine" l JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
       WHERE i."invoiceDate" BETWEEN $1::date AND $2::date AND i."moveType" = 'out_invoice'${JOURNAL_FILTER}`),
  ]);

  const round = (rows) => rows.map((r) => ({ ...r, ex: r2(r.ex), inc: r2(r.inc), qty: r2(r.qty) }));
  const nest = (rows, key) => {
    const out = {};
    for (const r of round(rows)) {
      const { [key]: owner, ...rest } = r;
      (out[owner] ||= []).push(rest);
    }
    return out;
  };

  return {
    products: round(products),
    categories: round(categories),
    branchProducts: nest(branchProducts, 'branch'),
    doctorProducts: nest(doctorProducts, 'doctor'),
    lines: lineCount[0] ? lineCount[0].n : 0,
  };
}

async function refunds(from, to, journals = null) {
  const rows = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) },
      moveType: 'out_refund',
      /* A refunded package belongs to the same excluded journal as the sale, so
         leaving it in while its sale is gone would show a credit note against
         revenue this report no longer counts. */
      ...(journals ? { OR: [{ journalName: null }, { journalName: { notIn: journals } }] } : {}),
    },
    orderBy: { amountUntaxed: 'desc' },
  });
  return rows.map((m) => ({
    name: m.name, date: ymd(m.invoiceDate), branch: m.branchName || '—',
    doctor: m.specialistName || '—', partner: m.partnerName || '—',
    ex: r2(num(m.amountUntaxed)), inc: r2(num(m.amountTotal)),
  }));
}

/**
 * The whole report for one window.
 *
 * `opts.excludeJournals` leaves those journals out of EVERY cut — total, branch,
 * doctor, day, product, category, line count and refunds alike. It is off by
 * default, so a caller that does not ask keeps the all-invoice behaviour.
 *
 * The Sales report asks for it, because a package is invoiced when it is SOLD,
 * carries no VAT, and is a prepayment against visits that have not happened.
 * Counting it as revenue flatters whichever branch sold packages that month and
 * makes two branches with identical work rank differently. What was removed
 * comes back as `totals.excluded`, so the page can show the size of the thing it
 * is leaving out rather than quietly shrinking.
 */
async function buildReport(from, to, opts = {}) {
  const journals = opts.excludeJournals && opts.excludeJournals.length
    ? opts.excludeJournals : null;
  const window = { invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) } };

  const [head, lines, credits, newCustomers, excluded, withJournal, allCount] = await Promise.all([
    headerCuts(from, to, journals),
    lineCuts(from, to, journals),
    refunds(from, to, journals),
    prisma.invoice.count({
      where: {
        ...window, moveType: 'out_invoice', isNewCustomer: true,
        ...(journals ? { OR: [{ journalName: null }, { journalName: { notIn: journals } }] } : {}),
      },
    }),
    /* What the exclusion actually removed, so it can be stated rather than
       inferred from a gap between two reports. */
    journals
      ? prisma.invoice.aggregate({
        where: { ...window, moveType: 'out_invoice', journalName: { in: journals } },
        _sum: { amountUntaxed: true, amountTotal: true }, _count: true,
      })
      : null,
    /* How much of the window can be classified at all. Nothing is stored for
       invoices synced before the journal column existed, and an exclusion over
       a window with no journals reads as "no packages this month" when it means
       "we cannot tell". */
    journals
      ? prisma.invoice.count({ where: { ...window, moveType: 'out_invoice', journalName: { not: null } } })
      : null,
    journals
      ? prisma.invoice.count({ where: { ...window, moveType: 'out_invoice' } })
      : null,
  ]);

  return {
    totals: {
      ...head.totals,
      lines: lines.lines,
      newCustomers,
      refunds: { count: credits.length, ex: r2(credits.reduce((s, r) => s + r.ex, 0)) },
      /* Absent entirely when nothing was excluded, so a page cannot print an
         "ex-package" label over an all-invoice figure. */
      excluded: journals ? {
        journals,
        ex: r2(num(excluded._sum.amountUntaxed)),
        inc: r2(num(excluded._sum.amountTotal)),
        invoices: excluded._count,
        known: allCount === 0 || withJournal === allCount,
        coverage: allCount ? withJournal / allCount : 1,
      } : null,
    },
    branches: head.branches,
    doctors: head.doctors,
    days: head.days,
    branchDoctors: head.branchDoctors,
    products: lines.products,
    categories: lines.categories,
    branchProducts: lines.branchProducts,
    doctorProducts: lines.doctorProducts,
    refundList: credits,
  };
}

/** Latest stock snapshot, rolled up per product with its locations. */
/**
 * On-hand stock, from the snapshot that was current AT THE END OF THE RANGE.
 *
 * It used to take the newest snapshot in existence and ignore the range
 * entirely, which meant reading NRS for August showed September's shelves on
 * tab 06 — and disagreed with report 08, which has always honoured the range.
 * The audit caught it the day a snapshot first landed outside its window; until
 * then the two happened to be the same row and the defect was invisible.
 *
 * `to` is optional so the old call still works, but every caller passes it.
 */
async function buildStock(to) {
  const where = to ? { takenAt: { lte: new Date(`${String(to).slice(0, 10)}T23:59:59.999Z`) } } : {};
  const latest = await prisma.stockQuant.aggregate({ where, _max: { takenAt: true } });
  const takenAt = latest._max.takenAt;
  if (!takenAt) return null;

  const quants = await prisma.stockQuant.findMany({ where: { takenAt }, orderBy: { quantity: 'desc' } });
  const byProduct = new Map();
  for (const q of quants) {
    const row = byProduct.get(q.productId) || {
      productId: q.productId, name: q.productName, category: q.categoryName || '—',
      uom: q.uom || '', qty: 0, reserved: 0, locations: [],
    };
    row.qty += num(q.quantity);
    row.reserved += num(q.reserved);
    row.locations.push({ name: q.locationName, qty: r2(num(q.quantity)) });
    byProduct.set(q.productId, row);
  }
  const rows = [...byProduct.values()].map((r) => ({ ...r, qty: r2(r.qty), reserved: r2(r.reserved) }))
    .sort((a, b) => b.qty - a.qty);
  for (const r of rows) r.locations.sort((a, b) => b.qty - a.qty);

  return { takenAt, rows, truncated: { scanned: rows.length, shown: rows.length, hitScanLimit: false, droppedFromDetail: 0 } };
}

/** How a day's figure moved between pulls — the settling the original noted by hand. */
async function daySettling(from, to) {
  const snaps = await prisma.daySnapshot.findMany({
    where: { date: { gte: dateOnly(from), lte: dateOnly(to) } },
    orderBy: [{ date: 'asc' }, { pulledAt: 'asc' }],
  });
  const byDay = new Map();
  for (const s of snaps) {
    const d = ymd(s.date);
    (byDay.get(d) || byDay.set(d, []).get(d)).push({
      pulledAt: s.pulledAt, invoices: s.invoices, ex: r2(num(s.amountUntaxed)),
    });
  }
  return [...byDay].filter(([, v]) => v.length > 1).map(([date, pulls]) => ({
    date,
    first: pulls[0],
    latest: pulls[pulls.length - 1],
    movedBy: r2(pulls[pulls.length - 1].ex - pulls[0].ex),
    invoiceDelta: pulls[pulls.length - 1].invoices - pulls[0].invoices,
  }));
}

/* Journals whose invoices are real money but not comparable to collections.
 *
 * "Package sale journal" is the only one today: a package is invoiced when it is
 * SOLD, the treatments are delivered over the following months, and the invoice
 * carries NO VAT at all — ex-VAT and inc-VAT come back identical. In August 2026
 * that is 219 invoices and 1,615,842, or 7.1% of revenue.
 *
 * This does NOT change the report's own revenue anywhere. Every tab, the top bar
 * and all target scoring keep counting every posted invoice, because that is what
 * was invoiced and the cuts have to keep reconciling. The figure below exists for
 * one place only — the two revenue lines under Net collections on the overview —
 * where the reader is looking at cash received and needs a like-for-like
 * comparison. It is labelled there, so it can never be mistaken for the headline.
 */
const EXCLUDED_REVENUE_JOURNALS = ['Package sale journal'];

async function revenueExcludingJournals(from, to, journals = EXCLUDED_REVENUE_JOURNALS) {
  const where = {
    invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) },
    moveType: 'out_invoice',
  };
  const [all, excluded] = await Promise.all([
    prisma.invoice.aggregate({ where, _sum: { amountUntaxed: true, amountTotal: true }, _count: true }),
    prisma.invoice.aggregate({
      where: { ...where, journalName: { in: journals } },
      _sum: { amountUntaxed: true, amountTotal: true }, _count: true,
    }),
  ]);
  /* Nothing is stored for invoices synced before the journal column existed, so
     `known` says whether the answer can be trusted yet. Reporting a 0 exclusion
     as if it were a real "no packages this month" would quietly overstate the
     comparable figure by 7%. */
  const withJournal = await prisma.invoice.count({ where: { ...where, journalName: { not: null } } });
  const n = (v) => r2(num(v));
  return {
    journals,
    ex: n(Number(all._sum.amountUntaxed || 0) - Number(excluded._sum.amountUntaxed || 0)),
    inc: n(Number(all._sum.amountTotal || 0) - Number(excluded._sum.amountTotal || 0)),
    invoices: all._count - excluded._count,
    removedEx: n(excluded._sum.amountUntaxed || 0),
    removedInc: n(excluded._sum.amountTotal || 0),
    removedInvoices: excluded._count,
    known: all._count === 0 || withJournal === all._count,
    coverage: all._count ? withJournal / all._count : 1,
  };
}


/**
 * The same exclusion, cut by branch and by doctor.
 *
 * Report 01 ranks branches on revenue ex-VAT *ex-package*, which is a different
 * ordering from all-invoice revenue: packages are 7.1% of the month and they are
 * not spread evenly, so a branch that sold a lot of them ranks higher than it
 * earned. Doctors get the same treatment for the mix slicer, where "Unassigned"
 * turns out to be exactly the package total — a package carries no specialist.
 */
async function revenueCutsExcludingJournals(from, to, journals = EXCLUDED_REVENUE_JOURNALS) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT COALESCE("branchName", 'Unassigned')     AS branch,
           COALESCE("specialistName", 'Unassigned') AS doctor,
           SUM("amountUntaxed")::float              AS ex,
           SUM("amountTotal")::float                AS inc,
           COUNT(*)::int                            AS invoices
      FROM "Invoice"
     WHERE state = 'posted' AND "moveType" = 'out_invoice'
       AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       AND ("journalName" IS NULL OR NOT ("journalName" = ANY($3::text[])))
     GROUP BY 1, 2`, from, to, journals);

  const roll = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      if (!m.has(k)) m.set(k, { name: k, ex: 0, inc: 0, invoices: 0 });
      const x = m.get(k);
      x.ex = r2(x.ex + Number(r.ex || 0));
      x.inc = r2(x.inc + Number(r.inc || 0));
      x.invoices += r.invoices;
    }
    return [...m.values()]
      .map((x) => ({ ...x, ticket: x.invoices ? r2(x.ex / x.invoices) : 0 }))
      .sort((a, b) => b.ex - a.ex);
  };
  return { journals, branches: roll('branch'), doctors: roll('doctor') };
}

module.exports = {
  EXCLUDED_REVENUE_JOURNALS, revenueExcludingJournals, revenueCutsExcludingJournals, buildReport, buildStock, daySettling };
