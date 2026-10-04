/* ============================================================
   Patients — tiers, new versus returning, retention.

   THE MOBILE KEY

   One function, `mobileKey`, and everything else in the commercial reports
   depends on it. It is the only field that joins a booking to a lead to a call:
   Odoo's partner id exists on invoices and appointments, but a Meta lead and a
   PBX call log have nothing but a phone number, typed by whoever answered.

   The rule is: digits only, then peel the 00 escape, the 20 country code and any
   trunk zero until EXACTLY ten digits remain, then require those ten to begin
   with 1. Anything that will not reduce to ten is REJECTED rather than trimmed to
   fit. Egyptian mobiles are ten digits beginning 10, 11, 12 or 15, so a landline,
   a truncated number, a foreign number and a note typed into the phone field all
   come back null.

   Returning null matters more than normalising. The June audit found 594 patients
   counted as new who were already known, because `01012345678`, `+201012345678`
   and `1012345678` were three different keys. Loosening the rule to salvage
   near-misses recreates that: a nine-digit fragment matched against a ten-digit
   key merges two real people, which is worse than losing one.

   THE TIER BASIS

   The reports disagree, and this does not resolve it silently. Report 01 ranks on
   2026-YTD spend at 150,000 / 75,000 / 25,000. Report 06's config says rolling
   twelve months at 250,000 / 100,000 / 50,000 / 20,000. Different windows AND
   different thresholds, so the same patient lands in different tiers under each.
   Report 01's is the default because the live numbers everyone has seen were
   computed on it; the other is selectable, and `basis` is returned with the
   result so a page can say which one it is showing.

   Both are computed on the invoice cache, which is not the same as all of Odoo.
   `coverage` reports what the cache actually holds and `basisCovered` says
   whether that reaches the start of the requested window — a YTD tier computed
   from two months of data is wrong, not approximate, and it must not be
   presentable without the caveat attached.

   PII

   Nothing here returns a full mobile number. `mobileKey` is for joining inside
   the server; anything that reaches a page or a CSV carries `mobileTail` only.
   Report 01 shipped 2,890 real names and mobiles inside a downloadable HTML file
   and warned, in its own footer, against sharing itself.
   ============================================================ */

const { prisma } = require('./db.js');

const VAT_DIVISOR = 1.14;
const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const day = (s) => new Date(`${s}T00:00:00Z`);

/**
 * The join key. Ten digits starting 1, or null.
 *
 * Deliberately strict: null is a usable answer everywhere it is consumed, and a
 * wrong key silently merges two patients into one.
 */
function mobileKey(value) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  let d = String(value).replace(/\D/g, '');
  if (!d) return null;

  /* Peel known prefixes — the 00 international escape, the 20 country code, a
     local trunk zero — until ten digits remain. Looped rather than applied once
     because they combine in every order the front desk can type: 0020…, +20 0…,
     0 20 1…

     Then require EXACTLY ten digits. Not the last ten. That distinction is the
     whole bug this replaced: +971 50 123 4567 is twelve digits with no Egyptian
     prefix to peel, and taking its last ten yields 1501234567, a perfectly
     well-formed Egyptian key beginning 15. A UAE patient silently became an
     Egyptian one, and nothing downstream could tell — it is the 594-duplicate
     failure again, running in the opposite direction and merging two real people
     instead of splitting one. Anything that will not peel down to ten is refused. */
  for (let i = 0; i < 4 && d.length > 10; i++) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('20')) d = d.slice(2);
    else if (d.startsWith('0')) d = d.replace(/^0+/, '');
    else break;
  }
  return /^1\d{9}$/.test(d) ? d : null;
}

/** For display and for CSVs. Never the full number. */
const mobileTail = (value) => {
  const k = mobileKey(value);
  return k ? `••• ${k.slice(-4)}` : null;
};

/* ------------------------------------------------------------------ tiers --- */

/**
 * The two bases, kept side by side rather than merged.
 *
 * `window: 'ytd'` measures from 1 January of the as-of year; `'rolling12'` from
 * twelve months before the as-of date.
 */
const TIER_BASES = {
  /* Report 01, and what every figure circulated so far was computed on. */
  report01: {
    key: 'report01',
    label: '2026 year to date',
    window: 'ytd',
    source: 'Report 01 · Sales, Aug 1-19',
    tiers: [
      { name: 'VIP', from: 150000 },
      { name: 'Premium', from: 75000 },
      { name: 'Silver', from: 25000 },
      { name: 'Bronze', from: 0 },
    ],
  },
  /* Report 06's handover config. Higher thresholds on a longer window, so it is
     not simply a stricter version of the above — it is a different question. */
  report06: {
    key: 'report06',
    label: 'rolling twelve months',
    window: 'rolling12',
    source: 'Report 06 · Data and logic handover',
    tiers: [
      { name: 'VIP', from: 250000 },
      { name: 'Premium', from: 100000 },
      { name: 'Silver', from: 50000 },
      { name: 'Bronze', from: 20000 },
      { name: 'Occasional', from: 0 },
    ],
  },
};

const tierFor = (basis, exVat) => {
  for (const t of basis.tiers) if (exVat >= t.from) return t.name;
  return basis.tiers[basis.tiers.length - 1].name;
};

/** What the invoice cache actually holds, so nothing claims more than it has. */
async function coverage() {
  const r = await prisma.invoice.aggregate({
    where: { state: 'posted' },
    _min: { invoiceDate: true },
    _max: { invoiceDate: true },
    _count: true,
  });
  const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
  return { from: iso(r._min.invoiceDate), to: iso(r._max.invoiceDate), invoices: r._count };
}

/**
 * Per-patient spend and tier.
 *
 * Refunds (`out_refund`) are subtracted, not ignored — a patient whose treatment
 * was refunded has not spent that money, and leaving it in promotes people into
 * tiers they did not buy into.
 */
async function buildTiers({ asOf, basis = 'report01' } = {}) {
  const b = TIER_BASES[basis];
  if (!b) throw new Error(`Unknown tier basis "${basis}". Known: ${Object.keys(TIER_BASES).join(', ')}`);

  const cov = await coverage();
  const end = asOf || cov.to;
  if (!end) return { basis: b, coverage: cov, basisCovered: false, patients: [], tiers: [], total: 0 };

  const start = b.window === 'ytd'
    ? `${end.slice(0, 4)}-01-01`
    : (() => { const d = day(end); d.setUTCFullYear(d.getUTCFullYear() - 1); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

  /* The caveat, computed rather than assumed: does the cache reach back far
     enough for the window this basis asks for? */
  const basisCovered = !!cov.from && cov.from <= start;

  const rows = await prisma.$queryRawUnsafe(`
    SELECT "partnerId"                                   AS patient_id,
           MIN("partnerName")                            AS name,
           SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountUntaxed" ELSE "amountUntaxed" END) AS ex_vat,
           SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountTotal"   ELSE "amountTotal"   END) AS inc_vat,
           COUNT(*)                                      AS invoices,
           MIN("invoiceDate")                            AS first_invoice,
           MAX("invoiceDate")                            AS last_invoice
      FROM "Invoice"
     WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
     GROUP BY "partnerId"
     HAVING SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountUntaxed" ELSE "amountUntaxed" END) > 0
     ORDER BY ex_vat DESC
  `, start, end);

  const patients = rows.map((r) => ({
    patientId: Number(r.patient_id),
    name: r.name || null,
    exVat: r2(r.ex_vat),
    incVat: r2(r.inc_vat),
    invoices: Number(r.invoices),
    firstInvoice: r.first_invoice.toISOString().slice(0, 10),
    lastInvoice: r.last_invoice.toISOString().slice(0, 10),
    tier: tierFor(b, r2(r.ex_vat)),
  }));

  const total = patients.reduce((a, p) => a + p.exVat, 0);
  const tiers = b.tiers.map((t) => {
    const inTier = patients.filter((p) => p.tier === t.name);
    const spend = r2(inTier.reduce((a, p) => a + p.exVat, 0));
    return {
      name: t.name,
      from: t.from,
      patients: inTier.length,
      exVat: spend,
      patientShare: patients.length ? inTier.length / patients.length : 0,
      spendShare: total ? spend / total : 0,
      avgSpend: inTier.length ? r2(spend / inTier.length) : 0,
    };
  });

  return {
    basis: { key: b.key, label: b.label, source: b.source, window: b.window, from: start, to: end },
    alternatives: Object.values(TIER_BASES).filter((x) => x.key !== b.key).map((x) => ({ key: x.key, label: x.label })),
    coverage: cov,
    basisCovered,
    patients,
    tiers,
    total: r2(total),
  };
}

/* --------------------------------------------------- new vs returning --- */

/**
 * New versus returning, decided by first-ever invoice in the cache — not by
 * Odoo's `isNewCustomer` flag, which is set at invoice time and never revisited,
 * so a patient invoiced twice on the same day can be flagged new on both.
 *
 * `firstEverBefore` is the honest part: a patient is only provably new if the
 * cache reaches back far enough to prove they were absent. Where it does not,
 * they are counted as `unknown` rather than quietly counted as new — which is
 * what the drifting 1,254+1,636 versus 1,268+1,648 splits across the reports
 * look like from the inside.
 */
async function buildMix({ from, to } = {}) {
  const cov = await coverage();
  if (!cov.from) return { from, to, patients: 0, new: 0, returning: 0, unknown: 0, coverage: cov };

  const rows = await prisma.$queryRawUnsafe(`
    WITH win AS (
      SELECT "partnerId", MIN("invoiceDate") AS first_in_window,
             SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountUntaxed" ELSE "amountUntaxed" END) AS ex_vat
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY "partnerId"
    ), ever AS (
      SELECT "partnerId", MIN("invoiceDate") AS first_ever
        FROM "Invoice" WHERE state = 'posted' GROUP BY "partnerId"
    )
    SELECT w."partnerId", w.ex_vat, w.first_in_window, e.first_ever
      FROM win w JOIN ever e ON e."partnerId" = w."partnerId"
  `, from, to);

  /* A patient is provably new only if their first invoice anywhere in the cache
     falls inside the window AND the cache starts before the window does. */
  const cacheStartsEarlier = cov.from < from;
  const out = { new: 0, returning: 0, unknown: 0, newExVat: 0, returningExVat: 0, unknownExVat: 0 };
  for (const r of rows) {
    const firstEver = r.first_ever.toISOString().slice(0, 10);
    const ex = r2(r.ex_vat);
    const bucket = firstEver >= from
      ? (cacheStartsEarlier ? 'new' : 'unknown')
      : 'returning';
    out[bucket] += 1;
    out[`${bucket}ExVat`] = r2(out[`${bucket}ExVat`] + ex);
  }

  return {
    from, to,
    patients: rows.length,
    ...out,
    coverage: cov,
    /* True when every patient could be classified — the only state in which the
       new/returning split is a measurement rather than an estimate. */
    provable: cacheStartsEarlier,
  };
}

/* ------------------------------------------------------------ retention --- */

/**
 * Months since each patient's last invoice, bucketed. Churn is a claim about
 * absence, so it is only as good as the cache depth and says so.
 */
async function buildRetention({ asOf } = {}) {
  const cov = await coverage();
  const end = asOf || cov.to;
  if (!end) return { asOf: end, coverage: cov, buckets: [], patients: 0 };

  const rows = await prisma.$queryRawUnsafe(`
    SELECT "partnerId",
           MAX("invoiceDate") AS last_invoice,
           COUNT(*)           AS invoices
      FROM "Invoice"
     WHERE state = 'posted' AND "invoiceDate" <= $1::date
     GROUP BY "partnerId"
  `, end);

  const months = (last) => {
    const a = day(end), b = new Date(last);
    return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  };
  const DEFS = [
    { name: 'Active · within 30 days', max: 0 },
    { name: '1-3 months', max: 3 },
    { name: '4-6 months', max: 6 },
    { name: '7-12 months', max: 12 },
    { name: 'Over a year', max: Infinity },
  ];

  const buckets = DEFS.map((d) => ({ ...d, patients: 0, repeatPatients: 0 }));
  for (const r of rows) {
    const m = months(r.last_invoice);
    const i = DEFS.findIndex((d) => m <= d.max);
    const b = buckets[i === -1 ? buckets.length - 1 : i];
    b.patients += 1;
    if (Number(r.invoices) > 1) b.repeatPatients += 1;
  }

  const depthMonths = cov.from ? months(day(cov.from)) : 0;
  return {
    asOf: end,
    coverage: cov,
    /* The buckets beyond the cache depth cannot be populated honestly: a patient
       "absent for over a year" is indistinguishable from one the cache has never
       seen. The page shows this so the tail is not read as churn. */
    depthMonths,
    buckets: buckets.map((b) => ({
      ...b, max: b.max === Infinity ? null : b.max,
      beyondCache: b.max !== Infinity && b.max > depthMonths,
      share: rows.length ? b.patients / rows.length : 0,
    })),
    patients: rows.length,
  };
}


/* ---------------------------------------------------------- service mix --- */

/**
 * What each tier actually buys.
 *
 * The tier comes from the basis window (YTD by default) but the lines come from
 * the requested range, which is the point: it answers "what did our VIPs buy
 * this month", not "what have VIPs ever bought". A patient's tier is a property
 * of the year; their basket is a property of the month.
 *
 * Package lines are kept and labelled rather than excluded. They are a real thing
 * a patient bought — it is only *revenue* comparisons against attendance that
 * have to strip them, and this is not one.
 */
async function buildServiceMix({ from, to, basis = 'report01' } = {}) {
  const b = TIER_BASES[basis];
  if (!b) throw new Error(`Unknown tier basis "${basis}". Known: ${Object.keys(TIER_BASES).join(', ')}`);

  const cov = await coverage();
  if (!cov.from) return { from, to, basis: b.key, categories: [], tiers: [], total: 0 };

  const end = to;
  const start = b.window === 'ytd'
    ? `${end.slice(0, 4)}-01-01`
    : (() => { const d = day(end); d.setUTCFullYear(d.getUTCFullYear() - 1); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

  /* One pass: rank each patient on the basis window, then attribute the lines
     they bought inside the requested range. Done in SQL because pulling 38,000
     invoices and 80,000 lines into Node to group them would be the same query
     written slower. */
  const rows = await prisma.$queryRawUnsafe(`
    WITH spend AS (
      SELECT "partnerId",
             SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountUntaxed" ELSE "amountUntaxed" END) AS ytd
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY "partnerId"
    )
    SELECT COALESCE(l."categoryName", '(uncategorised)') AS category,
           s.ytd                                        AS ytd,
           SUM(CASE WHEN i."moveType" = 'out_refund' THEN -l."priceSubtotal" ELSE l."priceSubtotal" END) AS ex_vat,
           COUNT(*)::int                                AS lines,
           COUNT(DISTINCT i."partnerId")::int           AS patients
      FROM "InvoiceLine" l
      JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
      JOIN spend s     ON s."partnerId" = i."partnerId"
     WHERE i.state = 'posted' AND i."invoiceDate" >= $3::date AND i."invoiceDate" <= $4::date
     GROUP BY 1, 2
  `, start, end, from, to);

  /* Bucket by tier in JS, since tierFor is the single place the thresholds live
     and duplicating them into a CASE expression is how the two drift apart. */
  const byCat = new Map();
  const byTier = new Map();
  let total = 0;
  for (const r of rows) {
    const tier = tierFor(b, r2(r.ytd));
    const ex = r2(r.ex_vat);
    total += ex;

    if (!byCat.has(r.category)) byCat.set(r.category, { category: r.category, exVat: 0, lines: 0, tiers: {} });
    const c = byCat.get(r.category);
    c.exVat = r2(c.exVat + ex);
    c.lines += Number(r.lines);
    c.tiers[tier] = r2((c.tiers[tier] || 0) + ex);

    if (!byTier.has(tier)) byTier.set(tier, { tier, exVat: 0, lines: 0, categories: 0 });
    const t = byTier.get(tier);
    t.exVat = r2(t.exVat + ex);
    t.lines += Number(r.lines);
    t.categories += 1;
  }

  total = r2(total);
  const categories = [...byCat.values()]
    .map((c) => ({ ...c, share: total ? c.exVat / total : 0 }))
    .sort((a, b2) => b2.exVat - a.exVat);
  const tiers = b.tiers.map((t) => byTier.get(t.name) || { tier: t.name, exVat: 0, lines: 0, categories: 0 })
    .map((t) => ({ ...t, share: total ? t.exVat / total : 0 }));

  return { from, to, basis: { key: b.key, label: b.label, from: start, to: end }, categories, tiers, total };
}


/* ------------------------------------------------------- home branch --- */

/**
 * Tier by home branch, where home branch is where the patient bills MOST — not
 * where they were first seen and not where they were last seen. A patient who
 * lives near CFC but had one laser session in Alexandria belongs to CFC, and
 * both alternatives would put them in the wrong column.
 */
async function buildHomeBranch({ asOf, basis = 'report01' } = {}) {
  const b = TIER_BASES[basis];
  if (!b) throw new Error(`Unknown tier basis "${basis}".`);
  const cov = await coverage();
  const end = asOf || cov.to;
  if (!end) return { branches: [], tierNames: [], patients: 0 };

  const start = b.window === 'ytd' ? `${end.slice(0, 4)}-01-01`
    : (() => { const d2 = day(end); d2.setUTCFullYear(d2.getUTCFullYear() - 1); d2.setUTCDate(d2.getUTCDate() + 1); return d2.toISOString().slice(0, 10); })();

  const rows = await prisma.$queryRawUnsafe(`
    WITH per AS (
      SELECT "partnerId", COALESCE("branchName", 'Unassigned') AS branch,
             SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountUntaxed" ELSE "amountUntaxed" END) AS ex
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY 1, 2
    ), tot AS (
      SELECT "partnerId", SUM(ex) AS ytd FROM per GROUP BY 1 HAVING SUM(ex) > 0
    ), ranked AS (
      SELECT p."partnerId", p.branch, p.ex, t.ytd,
             ROW_NUMBER() OVER (PARTITION BY p."partnerId" ORDER BY p.ex DESC, p.branch ASC) AS rn
        FROM per p JOIN tot t ON t."partnerId" = p."partnerId"
    )
    SELECT branch, ytd FROM ranked WHERE rn = 1
  `, start, end);

  const byBranch = new Map();
  for (const r of rows) {
    const tier = tierFor(b, r2(r.ytd));
    if (!byBranch.has(r.branch)) byBranch.set(r.branch, { branch: r.branch, patients: 0, exVat: 0, tiers: {} });
    const x = byBranch.get(r.branch);
    x.patients += 1;
    x.exVat = r2(x.exVat + r2(r.ytd));
    x.tiers[tier] = (x.tiers[tier] || 0) + 1;
  }
  const branches = [...byBranch.values()].sort((a, c) => c.patients - a.patients);
  return {
    basis: { key: b.key, label: b.label, from: start, to: end },
    tierNames: b.tiers.map((t) => t.name),
    branches,
    patients: rows.length,
  };
}

/* ------------------------------------------------- the patient funnel --- */

/**
 * New / repeated / once, on report 01's own definitions:
 *   new       — first invoice of the basis year falls inside the window
 *   repeated  — billed earlier in the year and came back
 *   once      — new AND exactly one invoice, i.e. has not returned yet
 *
 * `once` is the number worth watching: report 01 found 85% of new patients had
 * not come back, which is a retention problem dressed up as an acquisition win.
 *
 * Split by branch too, because a branch-level `once` rate is actionable while a
 * group-level one is only interesting.
 */
async function buildPatientFunnel({ from, to } = {}) {
  const cov = await coverage();
  if (!cov.from) return { from, to, total: 0, branches: [], provable: false };
  const yearStart = `${to.slice(0, 4)}-01-01`;
  /* Provable only if the cache reaches the start of the year the window sits in
     — otherwise "first invoice of 2026" is really "first invoice NRS holds". */
  const provable = cov.from <= yearStart;

  const rows = await prisma.$queryRawUnsafe(`
    WITH yr AS (
      SELECT "partnerId", MIN("invoiceDate") AS first_this_year
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY 1
    ), win AS (
      SELECT i."partnerId",
             COUNT(*)::int AS invoices_in_window,
             SUM(CASE WHEN i."moveType" = 'out_refund' THEN -i."amountUntaxed" ELSE i."amountUntaxed" END) AS ex,
             MIN(COALESCE(i."branchName", 'Unassigned')) AS branch
        FROM "Invoice" i
       WHERE i.state = 'posted' AND i."invoiceDate" >= $3::date AND i."invoiceDate" <= $4::date
       GROUP BY 1
    ), allyr AS (
      SELECT "partnerId", COUNT(*)::int AS invoices_this_year
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY 1
    )
    SELECT w."partnerId", w.invoices_in_window, w.ex, w.branch,
           y.first_this_year, a.invoices_this_year
      FROM win w
      JOIN yr y ON y."partnerId" = w."partnerId"
      JOIN allyr a ON a."partnerId" = w."partnerId"
  `, yearStart, to, from, to);

  /* Report 01's three figures are NOT three disjoint buckets, and reading them as
     such is the trap. Its "New 1,254" is every first-timer; its "Once 1,066" is a
     SUBSET of those — first-timers who have not come back. So the disjoint pair is
     `newReturned` (came in fresh and returned) and `once`, and the headline "new"
     is their sum. Naming the disjoint bucket `new` made it 191, which looks like a
     collapse in acquisition next to the report's 1,254 and is really the same
     number cut a different way. */
  const bucketOf = (r) => {
    const firstInWindow = r.first_this_year.toISOString().slice(0, 10) >= from;
    if (!firstInWindow) return 'repeated';
    return Number(r.invoices_this_year) <= 1 ? 'once' : 'newReturned';
  };

  const tally = { newReturned: 0, repeated: 0, once: 0, newReturnedExVat: 0, repeatedExVat: 0, onceExVat: 0 };
  const byBranch = new Map();
  for (const r of rows) {
    const bkt = bucketOf(r);
    tally[bkt] += 1;
    tally[`${bkt}ExVat`] = r2(tally[`${bkt}ExVat`] + r2(r.ex));
    if (!byBranch.has(r.branch)) {
      byBranch.set(r.branch, {
        branch: r.branch, total: 0, newReturned: 0, repeated: 0, once: 0,
        exVat: 0, newReturnedExVat: 0, repeatedExVat: 0, onceExVat: 0,
      });
    }
    const x = byBranch.get(r.branch);
    x.total += 1; x[bkt] += 1;
    x.exVat = r2(x.exVat + r2(r.ex));
    x[`${bkt}ExVat`] = r2(x[`${bkt}ExVat`] + r2(r.ex));
  }
  const firstTime = tally.newReturned + tally.once;
  return {
    from, to, provable, coverage: cov, yearStart,
    total: rows.length,
    ...tally,
    /* The report-01 headline: every patient whose first invoice of the year falls
       in this window, whether or not they came back. */
    firstTime,
    firstTimeExVat: r2(tally.newReturnedExVat + tally.onceExVat),
    onceShareOfNew: firstTime ? tally.once / firstTime : 0,
    branches: [...byBranch.values()].map((x) => {
      const firstTime = x.newReturned + x.once;
      const firstTimeExVat = r2(x.newReturnedExVat + x.onceExVat);
      return {
        ...x,
        firstTime, firstTimeExVat,
        onceShare: firstTime ? x.once / firstTime : 0,
        repeatShare: x.total ? x.repeated / x.total : 0,
        /* Report 04's two derived reads. The repeat share of SALES is the one that
           matters commercially — a branch can be half new patients and still take
           most of its money from returning ones. */
        repeatSalesShare: x.exVat ? x.repeatedExVat / x.exVat : 0,
        ticketNew: firstTime ? r2(firstTimeExVat / firstTime) : 0,
        ticketRepeated: x.repeated ? r2(x.repeatedExVat / x.repeated) : 0,
        /* Report 04's direction: NEW minus repeated. It comes out positive across
           every branch — a first visit is the bigger ticket, and the returning
           visit is the cheaper one. That is the opposite of the usual assumption
           and it is why the sign is pinned to the report's wording rather than
           left to whichever subtraction was typed first. */
        ticketGap: r2((firstTime ? firstTimeExVat / firstTime : 0) - (x.repeated ? x.repeatedExVat / x.repeated : 0)),
      };
    }).sort((a, c) => c.exVat - a.exVat),
  };
}

/* ------------------------------------------------------- acquisition --- */

/** What a first-time patient bought first, by category — the acquisition mix. */
async function buildAcquisition({ from, to } = {}) {
  const yearStart = `${to.slice(0, 4)}-01-01`;
  const rows = await prisma.$queryRawUnsafe(`
    WITH yr AS (
      SELECT "partnerId", MIN("invoiceDate") AS first_this_year
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY 1
    ), firsts AS (
      /* The patient's earliest invoice inside the window, and only for patients
         whose first invoice of the year is IN the window — i.e. genuinely new. */
      SELECT i."partnerId", MIN(i."odooId") AS first_invoice
        FROM "Invoice" i JOIN yr y ON y."partnerId" = i."partnerId"
       WHERE i.state = 'posted' AND i."invoiceDate" >= $3::date AND i."invoiceDate" <= $4::date
         AND y.first_this_year >= $3::date
         AND i."invoiceDate" = y.first_this_year
       GROUP BY 1
    )
    SELECT COALESCE(l."categoryName", '(uncategorised)') AS category,
           COUNT(DISTINCT f."partnerId")::int AS patients,
           SUM(l."priceSubtotal")::float      AS ex_vat
      FROM firsts f
      JOIN "InvoiceLine" l ON l."invoiceOdooId" = f.first_invoice
     GROUP BY 1 ORDER BY 2 DESC
  `, yearStart, to, from, to);

  /* Distinct first-timers, queried rather than summed over the category rows: a
     patient whose first invoice carried three categories appears in three of
     them, so summing gave 2,576 "first-timers" against a real 1,253 and every
     share was halved. */
  const distinct = await prisma.$queryRawUnsafe(`
    WITH yr AS (
      SELECT "partnerId", MIN("invoiceDate") AS first_this_year
        FROM "Invoice"
       WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date
       GROUP BY 1
    )
    SELECT COUNT(*)::int AS n FROM yr WHERE first_this_year >= $3::date
  `, yearStart, to, from);
  const patients = (distinct[0] || {}).n || 0;
  const total = r2(rows.reduce((a, r) => a + Number(r.ex_vat || 0), 0));
  return {
    from, to, patients, total,
    /* A patient whose first invoice has several lines counts under each category,
       so these shares are of line-appearances and sum above 100%. Said here
       rather than silently normalised, because "what did they come in for" has
       no single answer when they bought three things at once. */
    overlapping: true,
    categories: rows.map((r) => ({
      category: r.category,
      patients: r.patients,
      exVat: r2(r.ex_vat),
      share: patients ? r.patients / patients : 0,
      perPatient: r.patients ? r2(Number(r.ex_vat) / r.patients) : 0,
    })),
  };
}

/* ------------------------------------------------------------- churn --- */

/**
 * Churned = no invoice in the last N months (report 01 uses six).
 *
 * Only answerable where the cache is deeper than the silence being claimed: a
 * patient "quiet for six months" against a five-month cache is indistinguishable
 * from one NRS has never seen. `provable` says which case this is.
 */
async function buildChurnDetail({ asOf, months = 6 } = {}) {
  const cov = await coverage();
  const end = asOf || cov.to;
  if (!end) return { asOf: end, churned: 0, provable: false, coverage: cov };

  const cut = new Date(`${end}T00:00:00Z`);
  cut.setUTCMonth(cut.getUTCMonth() - months);
  const cutoff = cut.toISOString().slice(0, 10);
  const depth = cov.from
    ? (new Date(`${end}T00:00:00Z`).getUTCFullYear() - new Date(`${cov.from}T00:00:00Z`).getUTCFullYear()) * 12
      + (new Date(`${end}T00:00:00Z`).getUTCMonth() - new Date(`${cov.from}T00:00:00Z`).getUTCMonth())
    : 0;
  const provable = depth > months;

  const rows = await prisma.$queryRawUnsafe(`
    WITH last AS (
      SELECT "partnerId", MAX("invoiceDate") AS last_invoice
        FROM "Invoice" WHERE state = 'posted' AND "invoiceDate" <= $1::date
       GROUP BY 1
    ), churned AS (
      SELECT "partnerId" FROM last WHERE last_invoice < $2::date
    )
    SELECT COALESCE(i."branchName", 'Unassigned') AS branch,
           COUNT(DISTINCT i."partnerId")::int    AS patients,
           SUM(CASE WHEN i."moveType" = 'out_refund' THEN -i."amountUntaxed" ELSE i."amountUntaxed" END)::float AS ex_vat
      FROM "Invoice" i JOIN churned c ON c."partnerId" = i."partnerId"
     WHERE i.state = 'posted' AND i."invoiceDate" >= $3::date AND i."invoiceDate" <= $1::date
     GROUP BY 1 ORDER BY 2 DESC
  `, end, cutoff, `${end.slice(0, 4)}-01-01`);

  const svc = await prisma.$queryRawUnsafe(`
    WITH last AS (
      SELECT "partnerId", MAX("invoiceDate") AS last_invoice
        FROM "Invoice" WHERE state = 'posted' AND "invoiceDate" <= $1::date GROUP BY 1
    ), churned AS (
      SELECT l2."partnerId", l2.last_invoice FROM last l2 WHERE l2.last_invoice < $2::date
    ), lastinv AS (
      SELECT c."partnerId", MAX(i."odooId") AS inv
        FROM churned c JOIN "Invoice" i
          ON i."partnerId" = c."partnerId" AND i."invoiceDate" = c.last_invoice AND i.state = 'posted'
       GROUP BY 1
    )
    SELECT COALESCE(l."categoryName", '(uncategorised)') AS category,
           COUNT(DISTINCT li."partnerId")::int AS patients
      FROM lastinv li JOIN "InvoiceLine" l ON l."invoiceOdooId" = li.inv
     GROUP BY 1 ORDER BY 2 DESC
  `, end, cutoff);

  const totals = await prisma.$queryRawUnsafe(`
    WITH last AS (
      SELECT "partnerId", MAX("invoiceDate") AS last_invoice
        FROM "Invoice" WHERE state = 'posted' AND "invoiceDate" <= $1::date GROUP BY 1
    )
    SELECT COUNT(*)::int AS churned,
           (SELECT COUNT(*)::int FROM last) AS all_patients
      FROM last WHERE last_invoice < $2::date
  `, end, cutoff);

  const t = totals[0] || { churned: 0, all_patients: 0 };
  const revenue = r2(rows.reduce((a, r) => a + Number(r.ex_vat || 0), 0));
  return {
    asOf: end, months, cutoff, coverage: cov, cacheDepthMonths: depth, provable,
    churned: t.churned,
    allPatients: t.all_patients,
    share: t.all_patients ? t.churned / t.all_patients : 0,
    revenue,
    perPatient: t.churned ? r2(revenue / t.churned) : 0,
    branches: rows.map((r) => ({ branch: r.branch, patients: r.patients, exVat: r2(r.ex_vat) })),
    lastService: svc.map((r) => ({ category: r.category, patients: r.patients })),
  };
}


module.exports = {
  mobileKey, mobileTail, coverage,
  buildTiers, buildMix, buildRetention, buildServiceMix,
  buildHomeBranch, buildPatientFunnel, buildAcquisition, buildChurnDetail,
  TIER_BASES, VAT_DIVISOR,
};
