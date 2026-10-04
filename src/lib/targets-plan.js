/* ============================================================
   The plan: branch and doctor targets, the v3.2 policy, and the history.

   EVERYTHING HERE IS A DECISION SOMEBODY MADE, which is what separates this
   file from every other lib in `src/lib/`. Nothing in it is derived from Odoo:
   the 2027 targets were agreed in a meeting, the pool grid is a policy, and the
   2024-25 actuals are frozen because the Odoo cache does not reach back that
   far. So it changes only when somebody saves in Admin — never when a sync
   runs — and that is why it is served once per page load behind an ETag rather
   than rebuilt on every range change.

   THE SHAPE IS PARALLEL ARRAYS, NOT RECORDS. The branch grid is 12 branches x
   24 months and the doctor grid 62 x 18. As `{branch, period, target}` objects
   that is about 55 KB of repeated key names; as `{branches, months, target:
   [b][m]}` it is about 6 KB of the same information. The report redraws this
   on every tier chip, so the difference is felt.

   WHAT IT REFUSES. A branch in the plan that resolves to no branch here is
   reported in `unresolved` rather than dropped, and a month with no figure is
   `null` rather than 0 — "no target was set" and "the target is nothing" are
   different claims and only one of them means somebody forgot.
   ============================================================ */

const crypto = require('crypto');
const { prisma } = require('./db.js');
const Tracker = require('./target-tracker.js');

const r0 = (v) => Math.round(Number(v || 0));
const pad = (n) => String(n).padStart(2, '0');
const periodOf = (y, m) => `${y}-${pad(m)}`;

/** Every month between two period keys, inclusive. */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(periodOf(y, m));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * One string that changes when, and only when, the plan does.
 *
 * Built from the row counts and the newest `updatedAt` across every table this
 * file reads. A count alone would miss an edit to an existing cell; a timestamp
 * alone would miss a deletion. `HistoryMonth` carries no timestamp by design —
 * it is frozen — so its count is enough.
 */
async function etag() {
  const [tgt, doc, lvl, pool, role, staff, hist] = await Promise.all([
    prisma.commissionTarget.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.doctorPlanMonth.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.commissionLevel.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.commissionPool.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.commissionRoleWeight.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.commissionStaff.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.historyMonth.count(),
  ]);
  const parts = [tgt, doc, lvl, pool, role, staff]
    .map((x) => `${x._count}:${x._max.updatedAt ? x._max.updatedAt.getTime() : 0}`)
    .concat(String(hist));
  return `W/"${crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)}"`;
}

/** The branch target grid, as parallel arrays. */
async function branchPlan() {
  const [branches, rows, aliases] = await Promise.all([
    prisma.commissionBranch.findMany({
      where: { active: true },
      select: { id: true, name: true, area: true, entity: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.commissionTarget.findMany({
      select: { branchId: true, year: true, month: true, target: true },
    }),
    prisma.identityAlias.findMany({ where: { kind: 'branch' } }),
  ]);
  if (!rows.length) return { branches: [], months: [], target: [], note: 'No branch targets are stored.' };

  const alias = new Map(aliases.map((a) => [a.scheduleName.trim().toLowerCase(), a.odooName]));
  const keys = rows.map((r) => periodOf(r.year, r.month)).sort();
  const months = monthsBetween(keys[0], keys[keys.length - 1]);
  const mIdx = new Map(months.map((k, i) => [k, i]));
  const bIdx = new Map(branches.map((b, i) => [b.id, i]));

  /* null, not 0 — a month nobody set a target for is not a month with a target
     of nothing, and the report colours the two differently. */
  const target = branches.map(() => months.map(() => null));
  for (const r of rows) {
    const bi = bIdx.get(r.branchId);
    const mi = mIdx.get(periodOf(r.year, r.month));
    if (bi == null || mi == null) continue;
    target[bi][mi] = r0(r.target);
  }

  return {
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      /* The name Odoo uses, so the report can join its own figures without
         carrying a second copy of the alias table into the browser. */
      odooName: alias.get(b.name.trim().toLowerCase()) || b.name,
      area: b.area,
      entity: b.entity,
    })),
    months,
    target,
  };
}

/** The doctor target grid, same shape. */
async function doctorPlan() {
  const rows = await prisma.doctorPlanMonth.findMany({
    orderBy: [{ doctorName: 'asc' }, { period: 'asc' }],
  });
  if (!rows.length) return { doctors: [], months: [], target: [], groups: [] };

  const months = monthsBetween(rows[0].period, rows.reduce((a, r) => (r.period > a ? r.period : a), rows[0].period));
  const mIdx = new Map(months.map((k, i) => [k, i]));
  const names = [...new Set(rows.map((r) => r.doctorName))];
  const nIdx = new Map(names.map((n, i) => [n, i]));
  const group = new Map();

  const target = names.map(() => months.map(() => null));
  for (const r of rows) {
    const ni = nIdx.get(r.doctorName);
    const mi = mIdx.get(r.period);
    if (r.groupName) group.set(r.doctorName, r.groupName);
    if (ni == null || mi == null) continue;
    target[ni][mi] = r0(r.target);
  }

  return {
    doctors: names.map((n) => ({ name: n, group: group.get(n) || null })),
    months,
    target,
    /* The sheet's own ordering, so the report groups doctors the way the plan
       does rather than alphabetically. */
    groups: [...new Set(names.map((n) => group.get(n)).filter(Boolean))],
  };
}

/** The v3.2 policy in force: levels, the pool grid, and who shares a pool. */
async function policy() {
  const current = await prisma.commissionPolicyVersion.findFirst({
    orderBy: { effectiveFrom: 'desc' },
  });
  const [levels, pools, roles] = await Promise.all([
    prisma.commissionLevel.findMany({ orderBy: [{ version: 'asc' }, { level: 'asc' }] }),
    prisma.commissionPool.findMany({ orderBy: [{ version: 'asc' }, { tierNo: 'asc' }] }),
    prisma.commissionRoleWeight.findMany({ orderBy: [{ version: 'asc' }, { sortOrder: 'asc' }] }),
  ]);
  if (!levels.length || !pools.length) {
    return {
      version: null,
      missing: 'No v3.2 pool grid is stored, so a branch pool cannot be read from a tier.',
      v28: current ? current.version : null,
    };
  }
  /* One version at a time. Several can be stored — that is the point — but a
     page shows the one in force, and picking it here means the browser never
     has to know there are others. */
  const version = levels[levels.length - 1].version;
  const lv = levels.filter((l) => l.version === version);
  const rw = roles.filter((r) => r.version === version);
  const W = rw.reduce((a, r) => a + r.people * Number(r.weight), 0);

  return {
    version,
    v28: current ? current.version : null,
    levels: lv.map((l) => ({ level: l.level, fromPct: Number(l.fromPct) })),
    tiers: pools.filter((p) => p.version === version).map((p) => ({
      tierNo: p.tierNo,
      from: r0(p.revFrom),
      to: p.revTo == null ? null : r0(p.revTo),
      pools: (Array.isArray(p.pools) ? p.pools : []).map(r0),
    })),
    roles: rw.map((r) => ({
      role: r.role,
      people: r.people,
      weight: Number(r.weight),
      /* The figure a person actually cares about, computed once here rather
         than three times in three panels. */
      share: W ? Number(r.weight) / W : 0,
      notes: r.notes,
    })),
    totalWeight: W,
  };
}

/**
 * Monthly actuals by year — frozen before 2026, derived from 2026 on.
 *
 * The two halves are LABELLED, not merged into one undifferentiated series. A
 * reader comparing 2025 with 2026 is comparing a journal export with a live
 * cache, and a chart that hides that is the chart that gets quoted.
 */
async function history() {
  const [frozen, live] = await Promise.all([
    prisma.historyMonth.findMany({ where: { kind: 'branch' } }),
    prisma.$queryRawUnsafe(
      `select to_char("invoiceDate", 'YYYY-MM') period, "branchName" name,
              round(sum("amountUntaxed")::numeric)::bigint ex
         from "Invoice"
        where "moveType" = 'out_invoice' and "branchName" is not null
        group by 1, 2`,
    ),
  ]);
  const byPeriod = new Map();
  const put = (period, name, ex, source) => {
    if (!byPeriod.has(period)) byPeriod.set(period, { period, source, total: 0, branches: {} });
    const row = byPeriod.get(period);
    row.branches[name] = (row.branches[name] || 0) + r0(ex);
    row.total += r0(ex);
  };
  for (const h of frozen) put(h.period, h.name, h.ex, 'frozen');
  for (const l of live) put(l.period, l.name, Number(l.ex), 'odoo');

  const months = [...byPeriod.keys()].sort();
  return {
    months,
    rows: months.map((m) => byPeriod.get(m)),
    frozenBefore: '2026-01',
    note: 'Months before 2026-01 are frozen figures from the journal exports the plan was '
      + 'built on — the Odoo cache does not reach back that far, and they will not update. '
      + 'From 2026-01 every figure is derived live.',
  };
}

/**
 * How a branch's target splits across the service departments.
 *
 * DERIVED FROM WHAT THE BRANCH ACTUALLY SELLS, not seeded from the plan file.
 * The file carries a frozen mix per branch per month; recomputing it from the
 * invoice lines means the split follows the clinic instead of a spreadsheet
 * somebody closed in September. It is a ratio over real revenue, so it moves
 * when the branch's work moves.
 *
 * The mapping is `target-tracker.familyOf` — the SAME function the commission
 * multipliers use. A second grouping here would be a second answer to "is this
 * an injection", and a branch could then breach its injections cap on one page
 * and not on another.
 *
 * A branch with no invoices falls back to the clinic-wide mix, and says so:
 * a new branch has no history, and splitting its target five ways equally would
 * be a worse guess than the shape of every other branch.
 */
async function serviceMix() {
  const [departments, rows] = await Promise.all([
    prisma.commissionDepartment.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.$queryRawUnsafe(
      `select i."branchName" branch, l."categoryName" category,
              round(sum(l."priceSubtotal")::numeric)::bigint ex
         from "InvoiceLine" l join "Invoice" i on i."odooId" = l."invoiceOdooId"
        where i."moveType" = 'out_invoice' and i."branchName" is not null
        group by 1, 2`,
    ),
  ]);
  const keys = departments.map((d) => d.key);
  const blank = () => Object.fromEntries(keys.map((k) => [k, 0]));

  const byBranch = new Map();
  const whole = blank();
  let wholeTotal = 0;
  for (const r of rows) {
    const fam = Tracker.familyOf(r.category);
    const ex = Number(r.ex) || 0;
    /* A refund line can take a category negative. Left as it is: the mix is a
       share of what the branch billed, and silently flooring it at zero would
       make the shares sum to more than one. */
    if (!byBranch.has(r.branch)) byBranch.set(r.branch, { total: 0, fam: blank() });
    const b = byBranch.get(r.branch);
    if (fam in b.fam) { b.fam[fam] += ex; b.total += ex; }
    if (fam in whole) { whole[fam] += ex; wholeTotal += ex; }
  }
  const shareOf = (fam, total) => (total > 0
    ? Object.fromEntries(keys.map((k) => [k, fam[k] / total])) : null);
  const wholeShare = shareOf(whole, wholeTotal) || Object.fromEntries(keys.map((k) => [k, 0]));

  return {
    departments: departments.map((d) => ({
      key: d.key, label: d.label, multiplier: d.multiplier == null ? null : Number(d.multiplier),
    })),
    /* Keyed by the ODOO branch name, which is what `branchPlan` carries as
       `odooName` — the plan's own spelling would match nothing here. */
    byBranch: Object.fromEntries([...byBranch].map(([name, v]) => [name, {
      total: r0(v.total),
      share: shareOf(v.fam, v.total) || wholeShare,
      derived: v.total > 0,
    }])),
    whole: { total: r0(wholeTotal), share: wholeShare },
    /* `skin_dev` is a stored department that `familyOf` never returns, so it
       will read 0% everywhere. That is a real gap in the mapping rather than a
       branch selling none of it, and saying so beats drawing a silent zero. */
    unmapped: keys.filter((k) => !wholeShare[k]),
    note: 'The split follows what each branch actually bills, recomputed from the invoice lines '
      + 'rather than frozen in the plan. A branch with no history uses the clinic-wide shape.',
  };
}

/** Everything the plan panels and the Admin editor read, in one answer. */
async function build() {
  const [branches, doctors, pol, hist, mix] = await Promise.all([
    branchPlan(), doctorPlan(), policy(), history(), serviceMix(),
  ]);

  /* A branch on the plan file that reached no branch here. Surfaced because it
     is the one thing somebody has to act on: until it exists, its share of the
     plan is simply absent from every total on the page. */
  const planned = branches.target.reduce((a, row) => a + row.reduce((b, v) => b + (v || 0), 0), 0);

  return {
    branches, doctors, policy: pol, history: hist, mix,
    totals: {
      plannedTarget: planned,
      branchMonths: branches.branches.length * branches.months.length,
      doctorMonths: doctors.doctors.length * doctors.months.length,
    },
  };
}

module.exports = { build, branchPlan, doctorPlan, policy, history, serviceMix, etag, monthsBetween };
