/* ============================================================
   NRS tab 08 — Doctors Performance.

   Three sections rebuilt from the frozen `Doctors_Performance_Report.html`
   pack: its target schedule, its ticket-size analysis and its year-to-date
   injectables. The pack's own fourth tab (its Odoo self-refresh wiring) is
   deliberately not here — NRS loads through scripts/sync.js and reports on that
   load in tab 07.

   TWO DEFINITIONS FROM THE PACK, both load-bearing and both easy to get wrong:

   1. TICKET SIZE IS PER DISTINCT CUSTOMER, not per invoice. The pack says so
      outright — "Average ticket = income ex-VAT / distinct customers, per
      doctor" — and its own record set is one row per (doctor, day, customer).
      Reading it as per-invoice changes every figure on that section: Dr. Mai
      mohsen is 15,746 an invoice and 17,099 a customer over the same window.
      BOTH are returned here and both are labelled, because the per-invoice one
      is the number a reader assumes they are looking at.

   2. SYRINGES ARE COUNTED BY UNIT RULE, not by quantity. Verbatim: "Rich PL —
      per 5 ml. A 5 ml vial is one syringe, a 10 ml vial is two. V-Hacker — per
      2.5 ml. Each 2.5 ml counts as one. Calcium — Novuma and Sfera. Filler —
      the Injection/Filler family including Filler ultra deep."

   WHY THE FAMILY RULES ARE AN ORDERED LIST WITH A TEST FILE, and not a `CASE`
   in the SQL: this is the same shape as the bug that filed
   `Injection/Body Contouring` as an injection and read a x1.25 commission card
   as 0.00%. Rich PL, V-Hacker, Novuma and Sfera all sit in
   `Injection/Biostimulators`, so a category-first rule set puts all four in one
   bucket and loses the four separate figures the section exists to show. The
   product name has to be tested before the category, and the order has to be
   pinned by a test rather than by whoever edits it next.

   AND ONE THING MEASURED RATHER THAN ASSUMED: `Filler ultra deep` exists under
   TWO categories — 215 units under the catch-all `All` and 92.38 under
   `Injection/Filler`. That is precisely why the pack names it: a
   category-only Filler rule silently drops the larger half.

   WHAT THIS MODULE CANNOT DO, stated because the panel says it too:
     - the doctor is on the invoice HEADER (`Invoice.specialistName`), never on
       the line. `InvoiceLine` has no doctor column at all. The pack used
       line-level attribution for 3 April to 31 July; every per-product figure
       here is header-attributed instead, so a doctor's injectable count is
       "syringes on invoices billed under her name", not "syringes she injected".
     - nothing here can be cash-based. `Collection` carries a branch and a
       register and no doctor.
   ============================================================ */

const { prisma, num } = require('./db.js');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/* The Odoo journal a package is invoiced under. Imported rather than restated:
   the Sales report is ex-package throughout and this tab is part of it. */
const { EXCLUDED_REVENUE_JOURNALS } = require('./report.js');

/* The earliest invoice the cache holds. A range reaching before this is not
   empty — it is unanswerable, and the panel says which. */
const CACHE_FLOOR = '2026-01-01';

/* ------------------------------------------------------ injectable families */

/**
 * The five families, MOST SPECIFIC FIRST. Order is load-bearing — see the
 * header. Each rule answers two questions: does this line belong to the family,
 * and how many syringes is one unit of quantity.
 *
 * `syringesPer` is 1 for every family we have data for, and that is a
 * measurement rather than a shortcut: the products are named for their unit
 * ("Rich Topic PL 5 ML", "V-Hacker 2.5ML", "Novuma 1.5 cc", "Sfera 3ML"), so
 * one unit of quantity already means one syringe. The field exists because the
 * pack's rule allows a 10 ml Rich PL vial to count as two, and if such a
 * product ever appears the rule for it belongs here rather than in a patch.
 */
const FAMILIES = [
  {
    key: 'richpl',
    label: 'Rich PL',
    note: 'counted per 5 ml — a 5 ml vial is one syringe, a 10 ml vial two',
    /* Named before any category rule: it lives in Injection/Biostimulators
       alongside V-Hacker, Novuma and Sfera, and a category-first rule would
       collapse all four. */
    test: (name) => /\brich\s*(topic\s*)?pl\b/i.test(name),
    syringesPer: (name) => (/\b10\s*ml\b/i.test(name) ? 2 : 1),
  },
  {
    key: 'vhacker',
    label: 'V-Hacker',
    note: 'counted per 2.5 ml — each 2.5 ml is one',
    test: (name) => /\bv[-\s]?hacker\b/i.test(name),
    syringesPer: () => 1,
  },
  {
    key: 'calcium',
    label: 'Calcium — Novuma + Sfera',
    note: 'Novuma and Sfera. Radiesse recorded no sales in 2026 and none is in the cache.',
    test: (name) => /\bnovuma\b|\bsfera\b/i.test(name),
    syringesPer: () => 1,
  },
  {
    key: 'filler',
    label: 'Filler',
    note: 'the Injection/Filler family, including Filler ultra deep',
    /* The name half is not decoration. `Filler ultra deep` is filed under the
       catch-all `All` category for 215 of its 307 units, so a category-only
       rule drops most of it. */
    test: (name, category) => /^injection\/filler$/i.test(String(category || ''))
      || /\bultra\s*deep\b/i.test(name),
    syringesPer: () => 1,
  },
  {
    key: 'booster',
    label: 'Skinbooster',
    note: 'the Injection/Skin Booster family',
    test: (name, category) => /^injection\/skin\s*booster$/i.test(String(category || '')),
    syringesPer: () => 1,
  },
];

/**
 * Which family a line belongs to, or null.
 *
 * Returns null rather than guessing. A line that matches nothing is not an
 * injectable, and an unrecognised product landing in the largest family is the
 * failure this ordering exists to prevent.
 */
function familyOf(productName, categoryName) {
  const name = String(productName || '');
  for (const f of FAMILIES) {
    if (f.test(name, categoryName)) return f;
  }
  return null;
}

/* --------------------------------------------------------- 01 · the sheet */

/**
 * The target schedule, as the panel needs it.
 *
 * DELIBERATELY NOT A SECOND SCORING. Tab 04 already receives
 * `Targets.score(...)` in the payload, and this tab reads the same object. Two
 * derivations of one sheet is two chances to disagree about the same number,
 * and the two tabs sit one click apart.
 *
 * So this function only reports what the sheet COVERS — the caller passes the
 * already-scored object through.
 */
async function sheetCoverage(to) {
  const period = String(to).slice(0, 7);
  const [have, all] = await Promise.all([
    prisma.targetPeriod.findUnique({ where: { period } }),
    prisma.targetPeriod.findMany({ select: { period: true }, orderBy: { period: 'asc' } }),
  ]);
  return {
    period,
    loaded: !!have,
    available: all.map((p) => p.period),
    /* One sheet exists today (2026-08). Any other month has no targets to score
       against, and the panel must say that rather than draw a row of zeros —
       a doctor at 0% of a target that does not exist is a false accusation. */
    note: have ? null
      : `No approved target schedule is loaded for ${period}. `
        + (all.length
          ? `The only period on file is ${all.map((p) => p.period).join(', ')}. `
            + 'Import the sheet in Admin to score this month.'
          : 'No target sheet has been imported at all.'),
  };
}

/* -------------------------------------------------------- 02 · ticket size */

/**
 * Revenue per customer, per doctor.
 *
 * `perCustomer` is the pack's definition and the headline. `perInvoice` is
 * returned beside it because it is the figure a reader assumes "average ticket"
 * means, and the two differ by a fifth for the busiest doctors — showing one
 * without naming it invites the wrong reading.
 *
 * Refunds are netted off rather than dropped: a credit note is money leaving,
 * and a doctor whose refunds are excluded looks better than she is.
 */
async function buildTicket({ from, to }) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(i."specialistName", 'Unassigned')  AS doctor,
           SUM(CASE WHEN i."moveType" = 'out_refund'
                    THEN -i."amountUntaxed" ELSE i."amountUntaxed" END)::float8 AS ex,
           COUNT(DISTINCT i."partnerId")::int          AS customers,
           COUNT(*)::int                               AS invoices,
           COUNT(*) FILTER (WHERE i."moveType" = 'out_refund')::int AS refunds
      FROM "Invoice" i
     WHERE i.state = 'posted'
       AND i."moveType" IN ('out_invoice', 'out_refund')
       AND i."invoiceDate" BETWEEN $1::date AND $2::date
       AND (i."journalName" IS NULL OR NOT (i."journalName" = ANY($3::text[])))
     GROUP BY 1
     ORDER BY ex DESC`, from, to, EXCLUDED_REVENUE_JOURNALS);

  const doctors = rows.map((r) => ({
    name: r.doctor,
    ex: r2(r.ex),
    customers: r.customers,
    invoices: r.invoices,
    refunds: r.refunds,
    /* The pack's definition. */
    perCustomer: r.customers ? r2(r.ex / r.customers) : null,
    /* What a reader usually means by "average ticket". Both, labelled. */
    perInvoice: r.invoices ? r2(r.ex / r.invoices) : null,
    /* How many times an average customer came back in the window. */
    visitsPerCustomer: r.customers ? r2(r.invoices / r.customers) : null,
  }));

  const totals = doctors.reduce((a, d) => ({
    ex: a.ex + d.ex, customers: a.customers + d.customers, invoices: a.invoices + d.invoices,
  }), { ex: 0, customers: 0, invoices: 0 });

  return {
    doctors,
    totals: {
      ex: r2(totals.ex),
      /* NOT summable across doctors: one patient seen by two doctors is one
         patient and two rows. The clinic-wide figure is counted separately. */
      customerRowsAcrossDoctors: totals.customers,
      invoices: totals.invoices,
    },
    /* The honest clinic-wide denominator, counted once. */
    distinctCustomers: await distinctCustomers(from, to),
    note: 'Average ticket is income ex-VAT divided by DISTINCT CUSTOMERS, which is the pack\'s '
      + 'definition. Per-invoice is shown beside it because the two differ materially. Summing '
      + 'the per-doctor customer counts double-counts anyone seen by two doctors, so the '
      + 'clinic-wide figure is counted separately rather than added up.',
  };
}

async function distinctCustomers(from, to) {
  const r = await prisma.$queryRawUnsafe(`
    SELECT COUNT(DISTINCT i."partnerId")::int AS n
      FROM "Invoice" i
     WHERE i.state = 'posted' AND i."moveType" IN ('out_invoice', 'out_refund')
       AND i."invoiceDate" BETWEEN $1::date AND $2::date
       AND (i."journalName" IS NULL OR NOT (i."journalName" = ANY($3::text[])))`,
  from, to, EXCLUDED_REVENUE_JOURNALS);
  return r[0] ? r[0].n : 0;
}

/* --------------------------------------------------------- 03 · injectables */

/**
 * Injectable syringes and income per doctor, for whatever range is selected.
 *
 * The pack freezes this at 1 Jan - 13 Aug. This follows the report's date
 * picker instead, because a section that contradicts the range in the control
 * bar above it is a section nobody can read safely.
 *
 * Two figures per doctor and they are different questions: `income` is every
 * line she billed across every service, and `inj` is only the injectable
 * families. The share is the second over the first — which is why `income` is
 * not filtered to injectables.
 */
async function buildInjectables({ from, to }) {
  /* Lines are classified in JS, not SQL, so the family rules live in ONE place
     with a test file. The row count here is a few tens of thousands at most. */
  const lines = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(i."specialistName", 'Unassigned') AS doctor,
           l."productName"  AS product,
           l."categoryName" AS category,
           SUM(l.quantity)::float8      AS qty,
           SUM(l."priceSubtotal")::float8 AS ex
      FROM "InvoiceLine" l
      JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
     WHERE i.state = 'posted' AND i."moveType" = 'out_invoice'
       AND i."invoiceDate" BETWEEN $1::date AND $2::date
       AND (i."journalName" IS NULL OR NOT (i."journalName" = ANY($3::text[])))
     GROUP BY 1, 2, 3`, from, to, EXCLUDED_REVENUE_JOURNALS);

  const byDoctor = new Map();
  const familyTotals = Object.fromEntries(FAMILIES.map((f) => [f.key, { syringes: 0, ex: 0 }]));
  let incomeAll = 0, injAll = 0;

  for (const l of lines) {
    if (!byDoctor.has(l.doctor)) {
      byDoctor.set(l.doctor, {
        name: l.doctor,
        income: 0,
        inj: 0,
        syringes: 0,
        ...Object.fromEntries(FAMILIES.map((f) => [f.key, 0])),
      });
    }
    const d = byDoctor.get(l.doctor);
    const ex = Number(l.ex) || 0;
    d.income += ex;
    incomeAll += ex;

    const fam = familyOf(l.product, l.category);
    if (!fam) continue;
    /* Quantity times the family's unit rule. */
    const syr = (Number(l.qty) || 0) * fam.syringesPer(String(l.product || ''));
    d[fam.key] += syr;
    d.syringes += syr;
    d.inj += ex;
    injAll += ex;
    familyTotals[fam.key].syringes += syr;
    familyTotals[fam.key].ex += ex;
  }

  const doctors = [...byDoctor.values()]
    .map((d) => ({
      ...d,
      income: r2(d.income),
      inj: r2(d.inj),
      syringes: r2(d.syringes),
      ...Object.fromEntries(FAMILIES.map((f) => [f.key, r2(d[f.key])])),
      pct: d.income ? r2(d.inj / d.income) : null,
    }))
    /* Ranked by injectable income, which is what the section is about. */
    .sort((a, b) => b.inj - a.inj);

  const syringesAll = Object.values(familyTotals).reduce((t, f) => t + f.syringes, 0);

  return {
    doctors,
    families: FAMILIES.map((f) => ({
      key: f.key,
      label: f.label,
      note: f.note,
      syringes: r2(familyTotals[f.key].syringes),
      ex: r2(familyTotals[f.key].ex),
      share: syringesAll ? r2(familyTotals[f.key].syringes / syringesAll) : null,
    })).sort((a, b) => b.syringes - a.syringes),
    totals: {
      syringes: r2(syringesAll),
      income: r2(incomeAll),
      inj: r2(injAll),
      pct: incomeAll ? r2(injAll / incomeAll) : null,
    },
    /* The attribution caveat, on the payload so the panel cannot omit it. */
    note: 'The doctor comes from the invoice HEADER — Odoo keeps no doctor on the invoice line, '
      + 'so these are syringes on invoices billed under a doctor\'s name rather than syringes '
      + 'she is recorded as having injected. The frozen pack used line-level attribution for '
      + '3 April to 31 July, which is one reason its figures and these differ slightly.',
  };
}

/* ------------------------------------------------------------------- build */

/**
 * The approved schedule, scored.
 *
 * CALLS `Targets.score` WITH THE SAME INPUTS `src/routes/report.js` USES, and
 * that precision is the whole point. This report and the NRS Targets tab must
 * agree about the same sheet, and they only do so while both hand the same
 * function the same arguments: the month-to-date cut for `mtd`, the selected
 * range for `range`, and an inclusive day count for `rangeDays`. Getting
 * `mtd` wrong here — passing the range twice, say — would score every doctor
 * against a different fraction of her month and the two pages would quietly
 * disagree.
 *
 * `scripts/audit.js` compares the two, so a drift shows up as a failed check
 * rather than as two screens somebody has to reconcile by eye.
 */
async function scoreTargets({ from, to }) {
  const Targets = require('./targets.js');
  const Report = require('./report.js');

  const sheet = await Targets.loadPeriod(String(to).slice(0, 7));
  if (!sheet) return { missing: true, period: String(to).slice(0, 7) };

  const monthStart = `${String(to).slice(0, 7)}-01`;
  const EX = { excludeJournals: EXCLUDED_REVENUE_JOURNALS };
  const [range, mtd] = await Promise.all([
    Report.buildReport(from, to, EX),
    from === monthStart ? null : Report.buildReport(monthStart, to, EX),
  ]);
  /* One INCLUSIVE day count, so a single day scores against one daily target —
     the same arithmetic routes/report.js does. */
  const rangeDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);

  return Targets.score(sheet, { mtd: mtd || range, range, to, rangeDays });
}

/** Everything the report needs, for one range. */
async function build({ from, to }) {
  const [ticket, injectables, sheet, targets] = await Promise.all([
    buildTicket({ from, to }),
    buildInjectables({ from, to }),
    sheetCoverage(to),
    scoreTargets({ from, to }),
  ]);

  return {
    from,
    to,
    ticket,
    injectables,
    sheet,
    targets,
    /* How much of the asked-for range the invoice cache can actually speak
       about. A range starting in 2025 is not a quiet year — it is outside the
       cache, and the pack's own year-on-year comparisons cannot be rebuilt. */
    coverage: {
      floor: CACHE_FLOOR,
      covered: from >= CACHE_FLOOR,
      note: from >= CACHE_FLOOR ? null
        : `The invoice cache begins ${CACHE_FLOOR}. ${from} to ${CACHE_FLOOR} holds no invoices `
          + 'at all, so nothing before that date is included in the figures below.',
    },
  };
}

module.exports = {
  build, buildTicket, buildInjectables, sheetCoverage, scoreTargets, familyOf,
  FAMILIES, CACHE_FLOOR,
};
