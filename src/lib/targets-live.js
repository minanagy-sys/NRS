/* ============================================================
   Live — what is happening right now, against the plan.

   THE ONE IDENTITY THIS FILE MUST NOT BREAK: the collected total here has to
   equal the Commission report's net collection for the same range, to the
   piastre. They are the same money. So the cash side is `collectionByBranch`
   from `target-tracker.js` — the SAME call, not a second query that agrees
   today — and `scripts/audit.js` asserts the equality on every run.

   TWO BASES ON ONE PANEL, LABELLED. Collected is cash received ex-VAT, which is
   what the commission policy pays on. Billed is invoiced ex-VAT ex-package,
   which is what the target sheet measures. They are different numbers about
   different things and a reader comparing them needs to be told that, not left
   to notice the gap.

   WHAT IS LAZY AND WHY. The per-branch service breakdown is a second query per
   branch, and a reader opens one or two of eleven. Loading all of them to serve
   the two that get expanded is the sort of cost that only shows up on the
   slowest connection in the clinic.
   ============================================================ */

const { prisma } = require('./db.js');
const Report = require('./report.js');
const Tracker = require('./target-tracker.js');
const Plan = require('./targets-plan.js');
const Commission = require('./commission.js');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const r0 = (v) => Math.round(Number(v || 0));
const key = (s) => String(s || '').trim().toLowerCase();
const monthOf = (d) => String(d).slice(0, 7);

/** Days in the month a date falls in, and how many of them the range covers. */
function monthShare(from, to) {
  const [y, m] = from.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = Number(from.slice(8, 10));
  const last = monthOf(from) === monthOf(to) ? Number(to.slice(8, 10)) : days;
  const covered = Math.max(0, last - first + 1);
  return { days, covered, share: days ? covered / days : 0, sameMonth: monthOf(from) === monthOf(to) };
}

/**
 * The branch target for a range, from the plan.
 *
 * A range inside one month is PRO-RATED by days; a range spanning months sums
 * whole months. It is not weighted by weekday the way the source dashboard
 * does: that needs a seasonality index derived from history, and inventing one
 * here would make every daily figure depend on an assumption nobody has agreed.
 * Flat pro-rata is stated on the panel so the reader knows which it is.
 */
function targetFor(planBranches, odooName, from, to) {
  const bi = planBranches.branches.findIndex((b) => key(b.odooName) === key(odooName)
    || key(b.name) === key(odooName));
  if (bi < 0) return { target: null, basis: null };
  const months = planBranches.months.filter((k) => k >= monthOf(from) && k <= monthOf(to));
  if (!months.length) return { target: null, basis: null };
  const share = monthShare(from, to);
  let total = 0;
  let any = false;
  for (const k of months) {
    const mi = planBranches.months.indexOf(k);
    const v = planBranches.target[bi][mi];
    if (v == null) continue;
    any = true;
    total += share.sameMonth ? v * share.share : v;
  }
  return {
    target: any ? r0(total) : null,
    basis: share.sameMonth ? `${share.covered} of ${share.days} days` : `${months.length} whole months`,
  };
}

/**
 * The headline and the per-branch rows.
 *
 *   build({ from, to }) -> { window, totals, branches[], doctors[], flags }
 */
async function build({ from, to }) {
  const [cash, rep, planBranches, floor, pol, everBilled] = await Promise.all([
    Tracker.collectionByBranch(from, to),
    Report.buildReport(from, to, { excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS }),
    Plan.branchPlan(),
    Plan.policy(),
    Commission.loadPolicy(),
    /* Which branches have EVER invoiced. "Not open yet" has to mean "has never
       traded", not "did not trade in the window being looked at" — scoped to
       the range, a May-2027 view marked all twelve branches not-open because
       the cache holds no 2027 data, and "0 of 0 at the floor" told nobody
       anything. */
    prisma.invoice.groupBy({ by: ['branchName'], where: { moveType: 'out_invoice' } }),
  ]);
  const hasTraded = new Set(everBilled.map((b) => key(b.branchName)).filter(Boolean));

  /* ---- EX-VAT, AND THAT IS THE WHOLE IDENTITY ----
     `Collection.net` is cash as received, inclusive of VAT. The commission base
     is that figure divided by the VAT divisor, counting only what a branch can
     be credited with. Reading the raw total here put this panel 2,751,409 above
     the Commission report for August — 14% of the month, which is exactly the
     VAT, and which would have read as a reconciliation problem rather than a
     unit error. The divisor is the stored policy's, not a literal 1.14. */
  const VAT = Number(pol.vatDivisor) || 1.14;
  const exVat = (v) => r2(Number(v || 0) / VAT);

  const entities = await Tracker.branchEntities();
  const floorPct = floor && floor.levels && floor.levels.length ? floor.levels[0].fromPct : 0.8;

  /* Billed, per branch, from the same report the rest of the app reads. */
  const billed = new Map();
  for (const b of rep.branches || []) billed.set(key(b.name), { ex: r2(b.ex), invoices: b.invoices || 0 });

  const rows = [];
  /* `rows`, `unattributed.net`, `unattributed.totalNet` — the shape
     `collectionByBranch` actually returns. Guessing at `branches`/`total`/
     `orphan` read undefined and every branch collected zero, which rendered as
     eleven failing branches rather than as an error. */
  for (const c of cash.rows || []) {
    const name = c.branch;
    const t = targetFor(planBranches, name, from, to);
    const bill = billed.get(key(name)) || { ex: 0, invoices: 0 };
    rows.push({
      branch: name,
      entity: (entities.map || {})[key(name).replace(/[^a-z0-9]/g, '')] || null,
      collected: exVat(c.net),
      gross: exVat(c.gross),
      refunds: exVat(c.refunds),
      txns: c.txns || 0,
      billed: bill.ex,
      invoices: bill.invoices,
      target: t.target,
      targetBasis: t.basis,
      achievement: t.target ? r2(exVat(c.net) / t.target) : null,
      atFloor: t.target ? exVat(c.net) / t.target >= floorPct : null,
    });
  }
  /* A branch with a target and no cash is the row that matters most, and a
     collection-only list would leave it out entirely. */
  for (const b of planBranches.branches) {
    if (rows.some((r) => key(r.branch) === key(b.odooName) || key(r.branch) === key(b.name))) continue;
    const t = targetFor(planBranches, b.odooName, from, to);
    if (t.target == null) continue;
    const bill = billed.get(key(b.odooName)) || { ex: 0, invoices: 0 };
    /* ---- NOT OPEN YET IS NOT THE SAME AS FAILING ----
       Golden Square has a plan from April 2027 and no Odoo counterpart until it
       opens. Counted as an ordinary branch it reads 0% and turns "3 of 11 at
       the floor" into "3 of 12" — denying a manager's gate on a branch that
       does not exist. A branch with a target, no cash AND no invoices has not
       traded at all, which is different from one that traded and collected
       nothing; it keeps its row so the plan is visible, and is left out of the
       counts. The moment it bills ANYTHING, ever, it becomes an ordinary
       branch — which is why this asks the whole cache and not this window. */
    const notOpen = !hasTraded.has(key(b.odooName)) && !hasTraded.has(key(b.name));
    rows.push({
      branch: b.odooName,
      entity: b.entity,
      collected: 0,
      gross: 0,
      refunds: 0,
      txns: 0,
      billed: bill.ex,
      invoices: bill.invoices,
      target: t.target,
      targetBasis: t.basis,
      achievement: notOpen ? null : 0,
      atFloor: notOpen ? null : false,
      noCash: true,
      notOpen,
    });
  }

  /* ---- REVENUE THAT BELONGS TO NO BRANCH, CARRIED RATHER THAN DROPPED ----
     `Report.buildReport` already returns an `Unassigned` row — 160 invoices and
     992,537 of billed revenue with a null branch. This file built its rows from
     COLLECTIONS, so that row had nowhere to land and simply vanished: the
     panel's branch rows summed to 992,537 less than the panel's own billed
     total, with nothing saying so. It is carried as its own row, flagged, and
     scored against nothing — there is no target for revenue nobody owns. */
  const UNASSIGNED = /^unassigned$|^$/i;
  const orphanBilled = (rep.branches || []).filter((b) => UNASSIGNED.test(String(b.name || '').trim()));
  for (const o of orphanBilled) {
    if (!o.ex) continue;
    rows.push({
      branch: 'Unassigned',
      entity: null,
      collected: 0,
      gross: 0,
      refunds: 0,
      txns: 0,
      billed: r2(o.ex),
      invoices: o.invoices || 0,
      target: null,
      targetBasis: null,
      achievement: null,
      atFloor: null,
      unassigned: true,
    });
  }

  rows.sort((a, b) => b.collected - a.collected || b.billed - a.billed);

  const doctors = (rep.doctors || []).map((d) => ({
    name: d.name, ex: r2(d.ex), invoices: d.invoices || 0,
  })).sort((a, b) => b.ex - a.ex);

  /* A branch that has not opened has a target but is not yet measurable. */
  const withTarget = rows.filter((r) => r.target && !r.notOpen);
  const targetTotal = withTarget.reduce((a, r) => a + r.target, 0);

  return {
    window: { from, to, ...monthShare(from, to) },
    totals: {
      /* `cash.total` is the WHOLE collection including what no branch claims —
         the per-branch rows cannot sum to it, and the audit asserts against
         this figure rather than the sum. */
      /* ATTRIBUTED, EX-VAT — the same figure the Commission report calls net
         collection, so the two pages cannot disagree about one month's cash. */
      collected: r2(rows.reduce((a, r) => a + r.collected, 0)),
      collectedIncVat: r2(cash.unattributed.totalNet - cash.unattributed.net),
      unattributed: exVat(cash.unattributed.net),
      vatDivisor: VAT,
      billed: r2(rep.totals.ex),
      invoices: rep.totals.invoices,
      target: targetTotal || null,
      achievement: targetTotal ? r2(rows.reduce((a, r) => a + r.collected, 0) / targetTotal) : null,
      atFloor: withTarget.filter((r) => r.atFloor).length,
      branchesWithTarget: withTarget.length,
      /* Named so the panel can say "and one not open yet" rather than quietly
         showing a smaller denominator than the branch list below it. */
      notOpen: rows.filter((r) => r.notOpen).length,
      unassignedBilled: r2(rows.filter((r) => r.unassigned).reduce((a, r) => a + r.billed, 0)),
      floorPct,
    },
    branches: rows,
    doctors,
    flags: {
      /* Said out loud rather than left to be inferred from a small number. */
      unattributedShare: r2(cash.unattributed.share),
      branchScoringPossible: cash.unattributed.share < 0.2,
      planned: planBranches.branches.length,
      proRata: monthShare(from, to).sameMonth && monthShare(from, to).covered < monthShare(from, to).days,
    },
    note: 'Collected is cash received ex-VAT — the basis the commission policy pays on. Billed is '
      + 'invoiced ex-VAT and ex-package — the basis the target sheet measures. They answer '
      + 'different questions and are not expected to match.',
  };
}

/**
 * One branch, broken down — fetched when somebody expands the row.
 *
 * Service departments use the SAME mapping as the commission multipliers, via
 * `Tracker.familyOf`. Doctors are the branch's own cut of the doctor split.
 */
async function branch({ name, from, to }) {
  const [lines, docs] = await Promise.all([
    prisma.$queryRawUnsafe(
      `select l."categoryName" category, l."productName" product,
              round(sum(l."priceSubtotal")::numeric)::bigint ex, count(*)::int n
         from "InvoiceLine" l join "Invoice" i on i."odooId" = l."invoiceOdooId"
        where i."moveType" = 'out_invoice' and i."branchName" = $1
          and i."invoiceDate" >= $2::date and i."invoiceDate" <= $3::date
        group by 1, 2 order by 3 desc`, name, from, to,
    ),
    prisma.invoice.groupBy({
      by: ['specialistName'],
      where: {
        moveType: 'out_invoice',
        branchName: name,
        invoiceDate: { gte: new Date(from), lte: new Date(to) },
        NOT: { journalName: { in: Report.EXCLUDED_REVENUE_JOURNALS } },
      },
      _sum: { amountUntaxed: true },
      _count: true,
    }),
  ]);

  const byFam = new Map();
  let total = 0;
  for (const l of lines) {
    const fam = Tracker.familyOf(l.category);
    const ex = Number(l.ex) || 0;
    total += ex;
    if (!byFam.has(fam)) byFam.set(fam, { key: fam, ex: 0, products: [] });
    const f = byFam.get(fam);
    f.ex += ex;
    f.products.push({ product: l.product || l.category, ex, n: l.n });
  }
  const departments = await prisma.commissionDepartment.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  const label = Object.fromEntries(departments.map((d) => [d.key, d.label]));

  return {
    branch: name,
    window: { from, to },
    total: r0(total),
    families: [...byFam.values()]
      .map((f) => ({
        key: f.key,
        label: label[f.key] || f.key,
        ex: r0(f.ex),
        share: total ? r2(f.ex / total) : 0,
        products: f.products.sort((a, b) => b.ex - a.ex).slice(0, 8),
      }))
      .sort((a, b) => b.ex - a.ex),
    doctors: docs
      .map((d) => ({ name: d.specialistName || 'Unassigned', ex: r0(d._sum.amountUntaxed), invoices: d._count }))
      .sort((a, b) => b.ex - a.ex),
  };
}

/**
 * Actuals by month, with the prior year beside them.
 *
 * The prior year comes from `HistoryMonth` before 2026 and from the invoice
 * cache after, and the row says which — a growth figure against a frozen
 * journal export is a different claim from one against live data.
 */
async function actuals({ year }) {
  const y = Number(year);
  const hist = await Plan.history();
  const plan = await Plan.branchPlan();

  const rowsFor = (yy) => hist.rows.filter((r) => r.period.startsWith(String(yy)));
  const cur = rowsFor(y);
  const prev = rowsFor(y - 1);
  const prevByMonth = new Map(prev.map((r) => [r.period.slice(5), r]));

  const planFor = (period) => {
    const mi = plan.months.indexOf(period);
    if (mi < 0) return null;
    let t = 0;
    let any = false;
    for (const row of plan.target) if (row[mi] != null) { t += row[mi]; any = true; }
    return any ? r0(t) : null;
  };

  const months = cur.map((r) => {
    const p = prevByMonth.get(r.period.slice(5));
    return {
      period: r.period,
      billed: r0(r.total),
      source: r.source,
      prior: p ? r0(p.total) : null,
      priorSource: p ? p.source : null,
      growth: p && p.total ? r2(r.total / p.total - 1) : null,
      target: planFor(r.period),
      branches: r.branches,
    };
  });

  /* Every branch that appears in any month of the year, so a branch that opened
     mid-year is listed with the months it was absent rather than dropped. */
  const names = [...new Set(cur.flatMap((r) => Object.keys(r.branches)))].sort();
  const byBranch = names.map((n) => {
    const total = cur.reduce((a, r) => a + (r.branches[n] || 0), 0);
    const priorTotal = prev.reduce((a, r) => a + (r.branches[n] || 0), 0);
    return {
      branch: n,
      billed: r0(total),
      prior: prev.length ? r0(priorTotal) : null,
      growth: priorTotal ? r2(total / priorTotal - 1) : null,
      months: cur.filter((r) => r.branches[n]).length,
    };
  }).sort((a, b) => b.billed - a.billed);

  const total = byBranch.reduce((a, b) => a + b.billed, 0);
  for (const b of byBranch) b.share = total ? r2(b.billed / total) : 0;

  return {
    year: y,
    months,
    byBranch,
    totals: {
      billed: r0(total),
      prior: prev.length ? r0(prev.reduce((a, r) => a + r.total, 0)) : null,
      target: months.reduce((a, m) => a + (m.target || 0), 0) || null,
      monthsWithData: cur.length,
    },
    frozenBefore: hist.frozenBefore,
    note: hist.note,
  };
}

module.exports = { build, branch, actuals, targetFor, monthShare };
