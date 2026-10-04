/* ============================================================
   Commission v3.2 — what everyone earns.

   A DIFFERENT SHAPE FROM v2.8, which is why it is a different file. v2.8 pays
   each seat a share of a tier's min-to-max band. v3.2 pays the TEAM one pool,
   read out of a grid, and splits it by headcount and weight:

     collected ex-VAT, paced to a full month   picks the ROW   (14 revenue tiers)
     that revenue against the month target     picks the COLUMN (5 levels)
     the cell is the whole team's pool
     a person gets  pool x their weight / sum(people x weight)

   `src/lib/commission-rules.js` still implements v2.8 and its eighteen pinned
   workbook cases still pass. Which applies to a month is the stored policy
   version; nothing here touches that file.

   ---- THE PACE, AND WHY IT IS NOT ELAPSED DAYS ----

   A month in progress is judged at the rate it is running. Dividing by
   days-elapsed/days-in-month assumes every day earns the same, and they do not:
   measured on this clinic's own collections, Friday runs at 0.69 of an average
   day and Wednesday at 1.18. For 1-4 October that error is 8% — enough to move
   CFC from 91% of target to 83%, which is a different LEVEL and a pool of
   37,000 instead of 44,000. So the elapsed share is weighted by weekday, and
   the index is DERIVED from the collection history rather than typed in.

   ---- NOTHING IS PAYABLE UNTIL THE MONTH CLOSES ----

   A paced figure is a forecast. Every row carries `closed`, and the totals
   carry `payable` separately from `forecast`, because a number that is going to
   be paid and a number that might be are not the same number.
   ============================================================ */

const { prisma } = require('./db.js');
const Tracker = require('./target-tracker.js');
const Plan = require('./targets-plan.js');
const Commission = require('./commission.js');
const DoctorCommission = require('./doctor-commission.js');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const r0 = (v) => Math.round(Number(v || 0));
const key = (s) => String(s || '').trim().toLowerCase();
const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------ the weekday index */

let INDEX_CACHE = null;

/**
 * How much an average Monday, Tuesday … earns, relative to an average day.
 *
 * Derived from the clinic's own daily collections, not asserted. A day of the
 * week with no history at all falls back to 1 rather than 0 — a missing
 * observation is not a day that earns nothing.
 */
async function weekdayIndex() {
  if (INDEX_CACHE) return INDEX_CACHE;
  const rows = await prisma.$queryRawUnsafe(
    `select extract(dow from date)::int dow,
            sum(net)::float net,
            count(distinct date)::int days
       from "Collection"
      where source = 'odoo' and net > 0
      group by 1`,
  );
  const per = new Map(rows.filter((r) => r.days > 0).map((r) => [r.dow, r.net / r.days]));
  const vals = [...per.values()];
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const idx = {};
  for (let d = 0; d < 7; d++) idx[d] = mean && per.has(d) ? per.get(d) / mean : 1;
  INDEX_CACHE = { idx, basis: rows.reduce((a, r) => a + r.days, 0), mean: r0(mean) };
  return INDEX_CACHE;
}

/** For tests and scripts that change the underlying data. */
const resetIndex = () => { INDEX_CACHE = null; };

/**
 * The weighted share of a month that a range covers.
 *
 * Returns 1 for a whole month, so a closed month is never "paced" at all.
 */
function paceFraction(idx, year, month, lastDay) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const w = (d) => idx[new Date(Date.UTC(year, month - 1, d)).getUTCDay()] || 1;
  let covered = 0;
  let total = 0;
  for (let d = 1; d <= days; d++) {
    total += w(d);
    if (d <= lastDay) covered += w(d);
  }
  return { days, lastDay, frac: total ? covered / total : 0, closed: lastDay >= days };
}

/* --------------------------------------------------------------- the grid */

/** The highest level whose threshold the achievement reaches. */
function levelOf(achievement, levels) {
  if (achievement == null) return null;
  let hit = null;
  for (const l of levels) if (achievement >= l.fromPct) hit = l;
  return hit;
}

/** The revenue tier a figure lands in. */
function tierOf(revenue, tiers) {
  const v = Number(revenue || 0);
  return tiers.find((t) => v >= t.from && (t.to == null || v <= t.to)) || null;
}

/**
 * The pool for a revenue and a level.
 *
 * A level below the first threshold pays NOTHING — not the lowest column. That
 * is the floor the whole policy turns on, and reading the 80% column for a
 * branch at 61% would pay a team that did not qualify.
 */
function poolOf(revenue, level, tiers, levels) {
  const tier = tierOf(revenue, tiers);
  if (!tier) return { pool: 0, tier: null, why: `${r0(revenue)} matches no revenue tier.` };
  if (!level) return { pool: 0, tier, why: 'Below the floor, so nothing is payable.' };
  const i = levels.findIndex((l) => l.level === level.level);
  const col = Math.min(i < 0 ? 0 : i, tier.pools.length - 1);
  return { pool: Number(tier.pools[col]) || 0, tier, column: col };
}

/** One pool, split by headcount and weight. */
function splitPool(pool, roles, totalWeight) {
  const W = totalWeight || roles.reduce((a, r) => a + r.people * r.weight, 0);
  return roles.map((r) => ({
    role: r.role,
    people: r.people,
    weight: r.weight,
    each: W ? r2((pool * r.weight) / W) : 0,
    total: W ? r2((pool * r.weight * r.people) / W) : 0,
  }));
}

/* ------------------------------------------------------------------ build */

/** Every whole month a range touches — commission is earned per month. */
function monthsIn(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m, key: `${y}-${pad(m)}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * What everyone earns, for every month the range touches.
 *
 *   build({ from, to }) -> { months[], branches[], doctors, management, totals }
 */
async function build({ from, to }) {
  const [pol, { idx, basis }, planB, vatPolicy, staffRows] = await Promise.all([
    Plan.policy(), weekdayIndex(), Plan.branchPlan(), Commission.loadPolicy(),
    prisma.commissionStaff.findMany({ where: { active: true } }),
  ]);
  if (!pol || pol.missing) {
    return { missing: pol ? pol.missing : 'No v3.2 policy is stored.', months: [], branches: [] };
  }
  const VAT = Number(vatPolicy.vatDivisor) || 1.14;
  const months = monthsIn(from, to);
  const today = new Date().toISOString().slice(0, 10);

  const staffBy = new Map();
  for (const s of staffRows) {
    const k = `${s.branchId}:${key(s.role)}`;
    if (!staffBy.has(k)) staffBy.set(k, []);
    staffBy.get(k).push(s);
  }

  const out = [];
  for (const M of months) {
    const first = `${M.key}-01`;
    const dim = new Date(Date.UTC(M.year, M.month, 0)).getUTCDate();
    const last = `${M.key}-${pad(dim)}`;
    /* The month is measured to its end, or to today, or to the range's end —
       whichever comes first. A range that stops mid-month must not pace against
       days nobody has traded yet. */
    const end = [last, to, today].sort()[0];
    const lastDay = Number(end.slice(8, 10));
    const pace = paceFraction(idx, M.year, M.month, lastDay);

    const cash = await Tracker.collectionByBranch(first, end);
    const rows = [];
    for (const c of cash.rows || []) {
      const collected = r2(Number(c.net) / VAT);
      /* The month at the rate it is running. A closed month is itself. */
      const paced = pace.closed || !pace.frac ? collected : r2(collected / pace.frac);
      const bi = planB.branches.findIndex((b) => key(b.odooName) === key(c.branch)
        || key(b.name) === key(c.branch));
      const mi = planB.months.indexOf(M.key);
      const target = bi >= 0 && mi >= 0 ? planB.target[bi][mi] : null;
      const achievement = target ? r2(paced / target) : null;
      const level = levelOf(achievement, pol.levels);
      const { pool, tier, column, why } = poolOf(paced, level, pol.tiers, pol.levels);
      const split = splitPool(pool, pol.roles, pol.totalWeight);
      const branchId = bi >= 0 ? planB.branches[bi].id : null;

      rows.push({
        branch: c.branch,
        branchId,
        collected,
        paced,
        target: target == null ? null : r0(target),
        achievement,
        level: level ? level.level : null,
        tier: tier ? { no: tier.tierNo, from: tier.from, to: tier.to } : null,
        column,
        pool: r2(pool),
        why: why || null,
        closed: pace.closed,
        split: split.map((s) => ({
          ...s,
          /* `seats` is the HEADCOUNT the policy pays for; `people` is who is
             actually named. They are different counts and both are needed — a
             branch can have two reception seats and one name entered, and the
             second share is still owed to somebody. Overwriting one with the
             other lost the headcount and the staff panel drew nothing. */
          seats: s.people,
          people: (staffBy.get(`${branchId}:${key(s.role)}`) || []).map((p) => ({
            name: p.name, payMethod: p.payMethod, bankAcc: p.bankAcc,
          })),
        })),
      });
    }
    rows.sort((a, b) => b.pool - a.pool || b.collected - a.collected);

    /* ---- management gates ----
       A gate that fails pays exactly zero, and the row says which gate and why
       rather than printing a blank. */
    const gates = await prisma.managementGate.findMany({ orderBy: { role: 'asc' } });
    const areas = [...new Set(planB.branches.map((b) => b.area).filter(Boolean))];
    const earning = rows.filter((r) => r.pool > 0);
    const poolAll = rows.reduce((a, r) => a + r.pool, 0);
    const mgmt = [];
    for (const g of gates) {
      if (g.scope === 'area') {
        for (const area of areas) {
          const ids = new Set(planB.branches.filter((b) => b.area === area).map((b) => b.id));
          const mine = rows.filter((r) => ids.has(r.branchId));
          const hit = mine.filter((r) => r.pool > 0).length;
          const pass = hit >= (g.minBranches || 0);
          const pools = mine.reduce((a, r) => a + r.pool, 0);
          mgmt.push({
            role: g.role,
            scope: area,
            hit,
            need: g.minBranches || 0,
            pass,
            base: r2(pools),
            rate: Number(g.rate),
            earned: pass ? r2(pools * Number(g.rate)) : 0,
            why: pass ? null : `${hit} of ${g.minBranches} branches in ${area} reached a level.`,
          });
        }
      } else {
        const groupAch = rows.length && rows.every((r) => r.target != null)
          ? r2(rows.reduce((a, r) => a + r.paced, 0) / rows.reduce((a, r) => a + (r.target || 0), 0))
          : null;
        const byCount = earning.length >= (g.minBranches || 0);
        const byGroup = g.groupPct != null && groupAch != null && groupAch >= Number(g.groupPct);
        const pass = byCount || byGroup;
        mgmt.push({
          role: g.role,
          scope: 'group',
          hit: earning.length,
          need: g.minBranches || 0,
          groupAchievement: groupAch,
          groupNeed: g.groupPct == null ? null : Number(g.groupPct),
          pass,
          base: r2(poolAll),
          rate: Number(g.rate),
          earned: pass ? r2(poolAll * Number(g.rate)) : 0,
          why: pass ? null
            : `${earning.length} of ${g.minBranches} branches earned${
              g.groupPct != null ? `, and the group reached ${groupAch == null ? '—' : `${(groupAch * 100).toFixed(1)}%`} of ${(Number(g.groupPct) * 100).toFixed(0)}%` : ''}.`,
        });
      }
    }

    out.push({
      key: M.key,
      year: M.year,
      month: M.month,
      covers: { from: first, to: end },
      pace,
      branches: rows,
      management: mgmt,
      totals: {
        collected: r2(rows.reduce((a, r) => a + r.collected, 0)),
        paced: r2(rows.reduce((a, r) => a + r.paced, 0)),
        target: rows.reduce((a, r) => a + (r.target || 0), 0) || null,
        pool: r2(poolAll),
        earning: earning.length,
        branches: rows.length,
        management: r2(mgmt.reduce((a, g) => a + g.earned, 0)),
        gatesPassed: mgmt.filter((g) => g.pass).length,
        gates: mgmt.length,
      },
    });
  }

  /* Doctors are scored over the whole range by the lib that already does it —
     their commission is a rate on invoiced revenue and has no month grid. */
  const doctors = await DoctorCommission.build({ from, to });

  const branchPool = out.reduce((a, m) => a + m.totals.pool, 0);
  const management = out.reduce((a, m) => a + m.totals.management, 0);
  const payable = out.filter((m) => m.pace.closed);

  /* ---- WHAT A DOCTOR IS OWED IS NOT JUST THEIR COMMISSION ----
     It is commission plus the scheme's fixed basic plus the management fee, and
     plus hours where a payroll month exists. Reporting commission alone put the
     headline 280,000 light for October — the three fixed-basic schemes alone
     are 200,000 a month and are owed whatever anybody invoices.

     HOURS ARE NOT GUESSED. Where no payroll is loaded they are absent and the
     panel says so, rather than estimating from a schedule the way the source
     dashboard does — which its own payslip admits is an estimate. */
  const dRows = doctors.rows || [];
  const fixedTotal = dRows.reduce((a, r) => a + ((r.payslip && r.payslip.fixedBasic) || 0), 0);
  const feeTotal = dRows.reduce((a, r) => a + ((r.payslip && r.payslip.mgmt) || 0), 0);
  const hoursTotal = dRows.reduce((a, r) => a + ((r.payslip && r.payslip.hourlyBasic) || 0), 0);
  /* A doctor with no payroll month has no payslip at all, so their fixed basic
     and fee are not on it — taken from the scheme instead, which is where they
     were agreed and where they are known regardless of attendance. */
  const schemeFixed = dRows.reduce((a, r) => (r.payslip ? a
    : a + ((r.scheme && r.schemeFixedBasic) || 0)), 0);
  const commissionTotal = doctors.totals ? doctors.totals.commission : 0;
  const doctorTotal = r2(commissionTotal + fixedTotal + feeTotal + hoursTotal + schemeFixed);

  return {
    window: { from, to },
    version: pol.version,
    policy: { levels: pol.levels, tiers: pol.tiers, roles: pol.roles, totalWeight: pol.totalWeight },
    weekday: { index: idx, days: basis },
    months: out,
    doctors,
    totals: {
      branchPool: r2(branchPool),
      management: r2(management),
      doctors: r2(doctorTotal),
      doctorParts: {
        commission: r2(commissionTotal),
        hours: r2(hoursTotal),
        fixed: r2(fixedTotal + schemeFixed),
        fees: r2(feeTotal),
        /* Named so the panel can say what it does NOT know. */
        withoutPayroll: dRows.filter((r) => r.commission != null && !r.hasPayroll).length,
        hoursKnown: dRows.filter((r) => r.payslip).length,
      },
      all: r2(branchPool + management + doctorTotal),
      /* PAYABLE AND FORECAST, SEPARATE. A closed month is money owed; a running
         month is a projection, and adding them into one headline is how a
         forecast gets quoted as a commitment. */
      payable: r2(payable.reduce((a, m) => a + m.totals.pool + m.totals.management, 0) + doctorTotal),
      forecast: r2(out.filter((m) => !m.pace.closed).reduce((a, m) => a + m.totals.pool + m.totals.management, 0)),
      collected: r2(out.reduce((a, m) => a + m.totals.collected, 0)),
      months: out.length,
      openMonths: out.filter((m) => !m.pace.closed).length,
    },
    note: 'Commission is earned per month, so this covers every whole month the dates touch. '
      + 'A month still running is scored at the rate it is running — weighted by weekday, because '
      + 'a Friday is not a Wednesday — and nothing in it is payable until it closes.',
  };
}

module.exports = {
  build, weekdayIndex, resetIndex, paceFraction, levelOf, tierOf, poolOf, splitPool, monthsIn,
};
