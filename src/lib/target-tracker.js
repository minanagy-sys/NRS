/* ============================================================
   Report 05 — the target tracker.

   The commission base is NET CASH COLLECTED ex-VAT, less refunds. Not invoiced
   revenue. Report 05 states the Odoo query and it is exactly what
   finance-sync.js already pulls hourly:

       account.payment
         partner_type = 'customer'
         state        = 'paid'        <- Odoo 18 renamed 'posted' to 'paid'
         payment_type = 'inbound'
       net_ex_vat = (inbound_paid - customer_refunds) / 1.14

   So this file reads Collection rows rather than Invoice rows, and none of the
   revenue figures on the Sales report feed it.

   Two readings of the same month, and the difference matters:

     PACE       net collection / (target x elapsed/total)   "are we on track"
     PROJECTION net collection / elapsed * total            "where we land"

   Pools are only ever paid on a CLOSED month. Mid-month both readings are a
   forecast, and the page says so — report 05's own status line is "mid-month ·
   nothing payable yet", which is the honest thing to carry over.
   ============================================================ */

const { prisma } = require('./db.js');
const R = require('./commission-rules.js');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const d = (v) => (v === null || v === undefined ? null : Number(v));
const dateOf = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00.000Z`);

/** The policy in force on a given date — the latest version effective on or
 *  before it. Falls back to the global CommissionPolicy knobs when no version
 *  row exists, so this never invents a floor of zero. */
async function policyFor(onDate) {
  const rows = await prisma.commissionPolicyVersion.findMany({ orderBy: { effectiveFrom: 'asc' } });
  const asOf = dateOf(onDate);
  const inForce = rows.filter((r) => r.effectiveFrom <= asOf).pop() || null;
  if (!inForce) {
    return {
      version: null, bands: { ...R.BANDS }, all: [],
      note: 'No policy version stored; using the published defaults.',
    };
  }
  return {
    version: inForce.version,
    effectiveFrom: inForce.effectiveFrom.toISOString().slice(0, 10),
    note: inForce.note,
    bands: { floor: d(inForce.achievementFloor), mid: d(inForce.midFrom), max: d(inForce.maxFrom) },
    all: rows.map((r) => ({
      version: r.version,
      effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
      bands: { floor: d(r.achievementFloor), mid: d(r.midFrom), max: d(r.maxFrom) },
      note: r.note,
    })),
  };
}

/** Net collection per branch for a window, from whichever source the collections
 *  section is configured to read. Same predicate the finance section uses, so
 *  the two can never disagree about what a branch collected. */
async function collectionByBranch(from, to) {
  const Finance = require('./finance.js');
  const cfg = (await Finance.resolve()).collections;
  const mode = cfg.mode === 'odoo' ? "source = 'odoo'"
    : cfg.mode === 'snapshot' ? "source = 'snapshot'"
      : `((source = 'snapshot' AND date < DATE '${cfg.cutover || '1970-01-01'}')`
        + ` OR (source = 'odoo' AND date >= DATE '${cfg.cutover || '1970-01-01'}'))`;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT branch,
            COALESCE(SUM(gross),0)   AS gross,
            COALESCE(SUM(refunds),0) AS refunds,
            COALESCE(SUM(net),0)     AS net,
            COALESCE(SUM(txns),0)::int AS txns
       FROM "Collection"
      WHERE ${mode} AND date >= $1::date AND date <= $2::date
      GROUP BY branch`, from, to);

  /* Money that exists but cannot be attributed to a branch.
     Odoo 18 went live 2026-08-01 and payments migrated from the old system carry
     no `branch_id`, so 592 of 593 pre-August collection rows sit under
     "Unassigned" — 59.1M of real cash with nowhere to put it. Branch scoring for
     those months is not merely incomplete, it is impossible, and a tracker that
     silently drops the row reports every branch at 0% of target for a month that
     actually collected 19.2M. So it is returned as its own figure and the caller
     is expected to say so. */
  const UNATTRIBUTED = /^unassigned$|^$/i;
  const attributed = rows.filter((r) => !UNATTRIBUTED.test(String(r.branch || '').trim()));
  const orphan = rows.filter((r) => UNATTRIBUTED.test(String(r.branch || '').trim()));
  const sum = (list, k) => r2(list.reduce((a, x) => a + Number(x[k] || 0), 0));
  const totalNet = sum(rows, 'net');
  const orphanNet = sum(orphan, 'net');

  return {
    mode: cfg.mode,
    rows: attributed,
    unattributed: {
      net: orphanNet,
      gross: sum(orphan, 'gross'),
      txns: orphan.reduce((a, x) => a + Number(x.txns || 0), 0),
      share: totalNet ? orphanNet / totalNet : 0,
      totalNet,
    },
  };
}

/** One month of the tracker.
 *
 *  `from`/`to` bound the elapsed part of the month; `daysInMonth` is the whole
 *  of it. A closed month is one where `to` reaches the last day — only then is
 *  anything payable.
 */
async function buildTracker({ year, month, from, to }) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  const daysInMonth = last.getUTCDate();
  const start = from || first.toISOString().slice(0, 10);
  const end = to || last.toISOString().slice(0, 10);
  const elapsed = Math.min(daysInMonth, Number(end.slice(8, 10)));
  const closed = elapsed >= daysInMonth;

  const [policy, cfgPolicy, coll, branches, targets, tiers, roles, gates, departments] = await Promise.all([
    policyFor(end),
    R.VAT_DIVISOR && require('./commission.js').loadPolicy(),
    collectionByBranch(start, end),
    prisma.commissionBranch.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }] }),
    prisma.commissionTarget.findMany({ where: { year, month } }),
    prisma.commissionTier.findMany({ orderBy: { tierNo: 'asc' } }),
    prisma.commissionRole.findMany({ orderBy: [{ sortOrder: 'asc' }] }),
    prisma.managementGate.findMany(),
    prisma.commissionDepartment.findMany({ orderBy: [{ sortOrder: 'asc' }] }),
  ]);

  /* Collection rows carry Odoo's branch spelling; CommissionBranch carries the
     policy's. IdentityAlias is the existing bridge and the only place the
     mapping lives. */
  const aliases = await prisma.identityAlias.findMany({ where: { kind: 'branch' } });
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const collByKey = new Map(coll.rows.map((r) => [key(r.branch), r]));
  const aliasTo = new Map(aliases.map((a) => [key(a.scheduleName), a.odooName]));

  const targetOf = new Map(targets.map((t) => [t.branchId, t]));
  const share = elapsed / daysInMonth;
  const vatDivisor = (cfgPolicy && cfgPolicy.vatDivisor) || R.VAT_DIVISOR;

  const rows = branches.map((b) => {
    const t = targetOf.get(b.id) || null;
    const target = t ? d(t.target) : null;
    /* Per-branch band overrides still win over the version's defaults — a branch
       allowed a different floor for one month keeps it. */
    const bands = R.bandsFor(t || {}, policy.bands);

    let hit = collByKey.get(key(b.name));
    let via = null;
    if (!hit && aliasTo.has(key(b.name))) {
      const odoo = aliasTo.get(key(b.name));
      hit = collByKey.get(key(odoo));
      if (hit) via = odoo;
    }
    /* Collection.net is (gross - refunds) INC-VAT — that is what the imported
       snapshot meant by "net customer receipts" and what syncCollections stores.
       The commission base is EX-VAT: report 05's own query is
       `(inbound_paid - customer_refunds) / 1.14`, and applying it to that
       report's gross reproduces its 13,424,848 to the pound.

       Dividing here rather than at write time keeps one meaning per column: the
       Collection table stays cash-as-banked, which is what the Sales overview
       card shows, and the VAT strip belongs to the commission reading of it.
       Skipping it would overstate every pool by 14% and let branches qualify
       that have not — 9 instead of 5 on this window. */
    const gross = hit ? r2(hit.gross) : 0;
    const refunds = hit ? r2(hit.refunds) : 0;
    const netIncVat = hit ? r2(hit.net) : 0;
    const net = r2(netIncVat / vatDivisor);

    const prorata = target === null ? null : r2(target * share);
    const projected = share > 0 ? r2(net / share) : 0;

    /* Achievement is the closed-month question: net against the FULL target.
       Pace answers "on track" against the elapsed slice. Projection answers
       "where does this land". All three are reported because report 05 leads
       with pace and pays on achievement, and conflating them is how a branch
       reads 92.7% and expects a pool it has not earned. */
    const achievement = target ? net / target : 0;
    const pace = prorata ? net / prorata : 0;
    const achievementProjected = target ? projected / target : 0;

    const scoreOn = (value, achieved) => {
      const band = R.bandOf(achieved, bands);
      const tier = R.tierOf(value, tiers);
      const pools = R.poolsOf(tier);
      const pool = R.poolForBand(tier, band);
      return {
        band, bandLabel: R.BAND_LABELS[band], tierNo: tier ? tier.tierNo : null,
        tierLabel: tier ? tier.label : null, pools, pool,
        roles: R.splitPool(pool, roles),
      };
    };

    return {
      branchId: b.id, name: b.name, area: b.area, entity: b.entity,
      via, matched: !!hit,
      target, gross, refunds, netIncVat, net, txns: hit ? hit.txns : 0,
      prorata, projected,
      achievement, pace, achievementProjected,
      bands, override: R.hasOverride(t || {}),
      /* now = what is true today · run = where the month lands on this rate */
      now: scoreOn(net, achievement),
      run: scoreOn(projected, achievementProjected),
      tone: R.bandTone(R.bandOf(achievement, bands)),
      paceTone: R.bandTone(R.bandOf(pace, bands)),
    };
  });

  const sum = (f) => r2(rows.reduce((s, x) => s + (f(x) || 0), 0));
  const targetTotal = sum((x) => x.target);
  const netTotal = sum((x) => x.net);
  const projectedTotal = sum((x) => x.projected);

  /* Gates run on the same basis as the pools they read, and mid-month that has
     to be the projected one or every gate reports "failed" because no branch has
     reached a full-month target on day 19. */
  const basis = closed ? 'now' : 'run';
  const gateRows = rows.map((x) => ({
    name: x.name, area: x.area,
    achievement: closed ? x.achievement : x.achievementProjected,
    pool: x[basis].pool, net: closed ? x.net : x.projected, target: x.target,
  }));
  const am = gates.find((g) => g.scope === 'area') || null;
  const dir = gates.find((g) => g.scope === 'group') || null;

  const byArea = {};
  for (const g of gateRows) (byArea[g.area] ||= []).push(g);
  const areas = am ? Object.entries(byArea).map(([area, members]) => ({
    area, branches: members.map((m) => m.name),
    ...R.areaGate(members, { rate: d(am.rate), minBranches: am.minBranches, floor: policy.bands.floor }),
  })) : [];
  const director = dir
    ? R.directorGate(gateRows, {
      rate: d(dir.rate), minBranches: dir.minBranches,
      groupPct: d(dir.groupPct), floor: policy.bands.floor,
    })
    : null;

  return {
    year, month, from: start, to: end,
    daysElapsed: elapsed, daysInMonth, closed,
    /* Published unrounded on purpose: this is the divisor behind every projected
       figure, and a share rounded to 0.613 does not reproduce them — it puts a
       branch out by about 1,400 EGP. Anyone checking the arithmetic should get
       the same answer we did. */
    share,
    source: coll.mode,
    basis,
    base: 'net_collection_ex_vat',
    vatDivisor,
    baseNote: `Net cash collected ex-VAT, less customer refunds — the commission base: `
      + `(inbound paid − refunds) ÷ ${vatDivisor}. Not invoiced revenue: the Sales report `
      + `counts what was billed, this counts what was banked.`,
    policy,
    branches: rows,
    departments: departments.map((x) => ({ ...x, multiplier: d(x.multiplier), mixFloor: d(x.mixFloor), mixCap: d(x.mixCap) })),
    roles: roles.map((x) => ({ ...x, sharePct: d(x.sharePct) })),
    tiers: tiers.map((t) => ({ ...t, revFrom: d(t.revFrom), revTo: d(t.revTo), pools: R.poolsOf(t) })),
    totals: {
      target: targetTotal, gross: sum((x) => x.gross), refunds: sum((x) => x.refunds),
      netIncVat: sum((x) => x.netIncVat),
      net: netTotal, projected: projectedTotal,
      txns: rows.reduce((s, x) => s + x.txns, 0),
      achievement: targetTotal ? netTotal / targetTotal : 0,
      pace: targetTotal ? netTotal / r2(targetTotal * share) : 0,
      achievementProjected: targetTotal ? projectedTotal / targetTotal : 0,
      poolNow: sum((x) => x.now.pool),
      poolRun: sum((x) => x.run.pool),
      qualifyNow: rows.filter((x) => x.now.band !== 'zero').length,
      qualifyRun: rows.filter((x) => x.run.band !== 'zero').length,
    },
    areas, director,
    unmatched: rows.filter((x) => !x.matched).map((x) => x.name),
    /* Cash with no branch_id. When this is most of the month, every per-branch
       figure below is a floor and not a measurement. */
    unattributed: coll.unattributed,
    branchScoringPossible: coll.unattributed.share < 0.5,
  };
}

/** The same month scored on every stored policy version, so the difference
 *  between v2.7 and v2.8 is visible rather than asserted. */
async function compareVersions({ year, month, from, to }) {
  const versions = await prisma.commissionPolicyVersion.findMany({ orderBy: { effectiveFrom: 'asc' } });
  const out = [];
  for (const v of versions) {
    const bands = { floor: d(v.achievementFloor), mid: d(v.midFrom), max: d(v.maxFrom) };
    const t = await buildTracker({ year, month, from, to });
    /* Re-score the branches we already computed rather than re-querying: only
       the bands change, and the collection figures are identical. */
    const rescored = t.branches.map((b) => {
      const band = R.bandOf(t.closed ? b.achievement : b.achievementProjected, bands);
      const tier = R.tierOf(t.closed ? b.net : b.projected, t.tiers);
      return { name: b.name, band, pool: band === 'zero' ? 0 : R.poolsOf(tier)[band] || 0 };
    });
    out.push({
      version: v.version, effectiveFrom: v.effectiveFrom.toISOString().slice(0, 10),
      bands, note: v.note,
      qualifying: rescored.filter((r) => r.band !== 'zero').length,
      pool: r2(rescored.reduce((s, r) => s + r.pool, 0)),
      branches: rescored,
    });
  }
  return out;
}


/* ---------------------------------------------------------- any range --- */

/**
 * The tracker over an arbitrary date range.
 *
 * Commission is monthly by definition — a branch is measured against ONE month's
 * target, and the band, the ladder tier and the pool all come out of that single
 * comparison. So an arbitrary range is not "the tracker with different dates": it
 * is a sum of month slices, and that is how this computes it. July 15 to
 * August 20 becomes half of July scored against July's target plus two thirds of
 * August scored against August's, and the pools add up the way the payroll would
 * add them up.
 *
 * What it deliberately does NOT do is pool the collection across the range and
 * compare it to the summed target. That reads as one big month and it is wrong in
 * both directions: a branch that smashed July and collapsed in August would show
 * as mid-band on the average and earn a pool it never qualified for in either
 * month, while genuine month-on-month movement disappears.
 *
 * Every slice reports `partial`, because a month clipped by the range is measured
 * against its FULL target and will therefore look like it is failing. That is the
 * honest reading of "how is this month going", and it needs saying rather than
 * hiding.
 */
async function buildTrackerRange({ from, to }) {
  const monthsBetween = (a, b) => {
    const out = [];
    let y = Number(a.slice(0, 4)), m = Number(a.slice(5, 7));
    const endY = Number(b.slice(0, 4)), endM = Number(b.slice(5, 7));
    /* Guard rather than loop forever if the caller inverts the range. */
    while (y < endY || (y === endY && m <= endM)) {
      out.push({ year: y, month: m });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      if (out.length > 120) break;
    }
    return out;
  };

  const slices = monthsBetween(from, to);
  const months = [];
  for (const { year, month } of slices) {
    const mFirst = `${year}-${String(month).padStart(2, '0')}-01`;
    const mLast = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const sliceFrom = from > mFirst ? from : mFirst;
    const sliceTo = to < mLast ? to : mLast;
    const t = await buildTracker({ year, month, from: sliceFrom, to: sliceTo });
    months.push({
      ...t,
      key: `${year}-${String(month).padStart(2, '0')}`,
      partial: sliceFrom !== mFirst || sliceTo !== mLast,
      coversFrom: sliceFrom,
      coversTo: sliceTo,
    });
  }

  /* Roll the branches up across slices. Net and target add; the pool adds because
     each month's pool was scored on its own month. Achievement is recomputed on
     the summed figures purely as a headline — it is labelled as a blend on the
     page and is never what sets a band. */
  const byBranch = new Map();
  for (const m of months) {
    for (const b of m.branches) {
      if (!byBranch.has(b.name)) {
        byBranch.set(b.name, {
          name: b.name, entity: b.entity, matched: b.matched,
          net: 0, target: 0, pool: 0, monthsQualified: 0, monthsScored: 0,
        });
      }
      const x = byBranch.get(b.name);
      x.net = r2(x.net + (b.net || 0));
      x.target = r2(x.target + (b.target || 0));
      const scored = m.closed ? b.now : b.run;
      x.pool = r2(x.pool + ((scored && scored.pool) || 0));
      x.monthsScored += 1;
      if (scored && scored.band !== 'zero') x.monthsQualified += 1;
    }
  }
  const branches = [...byBranch.values()].map((b) => ({
    ...b,
    achievementBlended: b.target ? b.net / b.target : 0,
  })).sort((a, b) => b.net - a.net);

  const last = months[months.length - 1] || null;
  return {
    from, to,
    multi: months.length > 1,
    months,
    branches,
    totals: {
      net: r2(branches.reduce((s, b) => s + b.net, 0)),
      target: r2(branches.reduce((s, b) => s + b.target, 0)),
      pool: r2(branches.reduce((s, b) => s + b.pool, 0)),
      /* The cash side rolled up over the WHOLE range, not just the last month.
         Anything that shows a range-wide revenue figure beside a collection
         figure has to read these: the Commercial chain was handed the last
         month's cash next to the range's revenue and printed "cash vs revenue
         4.3%" on a quarter whose real figure is 52.8%. */
      gross: r2(months.reduce((a, m) => a + m.totals.gross, 0)),
      refunds: r2(months.reduce((a, m) => a + m.totals.refunds, 0)),
      txns: months.reduce((a, m) => a + m.totals.txns, 0),
      /* ALL the cash, ex-VAT, whether or not a branch can be attached to it.
         `net` above is the sum of the branch rows and is the right base for
         per-branch scoring; it is the WRONG figure for a group-level total,
         because pre-August payments carry no branch_id and drop out of it. The
         Commercial chain is group-level and read `net`, so on a March–May range
         it printed "cash received against revenue 0.0%" beside 43.8M of revenue.
         The cash was there; only its branch was missing. */
      netTotal: r2(months.reduce((a, m) => a
        + (m.unattributed ? m.unattributed.totalNet : m.totals.netIncVat) / R.VAT_DIVISOR, 0)),
      unattributedNet: r2(months.reduce((a, m) => a
        + (m.unattributed ? m.unattributed.net : 0) / R.VAT_DIVISOR, 0)),
      /* Closed only when EVERY month in the range is, because a range ending
         mid-month has nothing payable however many closed months precede it. */
      closed: months.length > 0 && months.every((m) => m.closed),
      monthsCovered: months.length,
      partialMonths: months.filter((m) => m.partial).length,
    },
    /* The single-month payload the existing panels already know how to draw. The
       page shows this for the last month in the range, so a multi-month view still
       has a full tracker underneath it rather than only a summary. */
    latest: last,
  };
}


/* ------------------------------------------------- the missing cuts --- */

/**
 * The daily collection series, the service mix per branch, the multiplier
 * eligibility that follows from it, and the integrity checks.
 *
 * These are four sections report 05 carries that NRS had no data for. They are
 * grouped into one call because they share a range and the page shows them
 * together, and separating them would mean four round trips for one screen.
 */
async function buildExtras({ from, to }) {
  const Finance = require('./finance.js');
  const cfg = (await Finance.resolve()).collections;
  const mode = cfg.mode === 'odoo' ? "source = 'odoo'"
    : cfg.mode === 'snapshot' ? "source = 'snapshot'"
      : `((source = 'snapshot' AND date < DATE '${cfg.cutover || '1970-01-01'}')`
        + ` OR (source = 'odoo' AND date >= DATE '${cfg.cutover || '1970-01-01'}'))`;

  const [dayRows, mixRows, revRow, pkgRow, departments] = await Promise.all([
    /* Daily net, ex-VAT, so the weekly rhythm is visible. */
    prisma.$queryRawUnsafe(
      `SELECT date, SUM(net)::float AS net, SUM(gross)::float AS gross,
              SUM(refunds)::float AS refunds, SUM(txns)::int AS txns
         FROM "CollectionDay"
        WHERE ${mode} AND date >= $1::date AND date <= $2::date
        GROUP BY date ORDER BY date`, from, to),

    /* Category revenue per branch, from invoice lines. `branchName` on the
       invoice is the branch that billed it. */
    prisma.$queryRawUnsafe(
      `SELECT COALESCE(i."branchName", 'Unassigned')      AS branch,
              COALESCE(l."categoryName", '(uncategorised)') AS category,
              SUM(CASE WHEN i."moveType" = 'out_refund' THEN -l."priceSubtotal" ELSE l."priceSubtotal" END)::float AS ex_vat,
              COUNT(*)::int AS lines
         FROM "InvoiceLine" l
         JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
        WHERE i.state = 'posted' AND i."invoiceDate" >= $1::date AND i."invoiceDate" <= $2::date
        GROUP BY 1, 2`, from, to),

    prisma.$queryRawUnsafe(
      `SELECT SUM(CASE WHEN "moveType" = 'out_refund' THEN -"amountUntaxed" ELSE "amountUntaxed" END)::float AS ex_vat,
              COUNT(*)::int AS invoices,
              SUM(CASE WHEN "journalName" IS NULL THEN 1 ELSE 0 END)::int AS no_journal,
              SUM(CASE WHEN "branchName" IS NULL THEN 1 ELSE 0 END)::int AS no_branch
         FROM "Invoice"
        WHERE state = 'posted' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date`, from, to),

    prisma.$queryRawUnsafe(
      `SELECT SUM("amountUntaxed")::float AS ex_vat, SUM("amountTotal")::float AS inc_vat,
              COUNT(*)::int AS invoices
         FROM "Invoice"
        WHERE state = 'posted' AND "journalName" = 'Package sale journal'
          AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date`, from, to),

    prisma.commissionDepartment.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
  ]);

  /* -------- daily series -------- */
  const days = dayRows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    /* CollectionDay.net is inc-VAT, same as Collection.net. The commission base
       is ex-VAT, so the series is divided here too — otherwise the daily chart
       and the headline disagree by 14% and the chart looks wrong. */
    net: r2(Number(r.net) / R.VAT_DIVISOR),
    netIncVat: r2(r.net),
    txns: r.txns,
  }));
  const netVals = days.map((d2) => d2.net).sort((a, b) => a - b);
  const daily = {
    days,
    txns: days.reduce((a, d2) => a + d2.txns, 0),
    best: days.length ? days.reduce((a, b) => (b.net > a.net ? b : a)) : null,
    worst: days.length ? days.reduce((a, b) => (b.net < a.net ? b : a)) : null,
    median: netVals.length
      ? r2(netVals.length % 2
        ? netVals[(netVals.length - 1) / 2]
        : (netVals[netVals.length / 2 - 1] + netVals[netVals.length / 2]) / 2)
      : 0,
    peak: days.reduce((a, d2) => Math.max(a, d2.net), 0),
  };

  /* -------- service mix, and what it means for multipliers -------- */
  /* Odoo category names are prefixed by family: "Injection/Filler",
     "Devices/DEKA Laser Hair Removal". The policy's departments are those
     families, so the prefix IS the mapping — no name list to maintain. */
  /* Odoo category names are `Family/Leaf` — "Injection/Filler",
     "Devices/DEKA Laser Hair Removal". The policy's departments are mostly those
     families, so the prefix IS the mapping and there is no name list to maintain.
     Body Contouring is the exception and the order below is load-bearing.

     `Injection/Body Contouring` is 109,838 in August. On a prefix-only rule it
     files as an injection, which does two things wrong at once: the x1.25
     strategic-priority card reads 0.00% when the category has real revenue, and
     that revenue is added to the injections share that is already breaching its
     50% cap. So the LEAF is tested for body contouring first.

     `Injection/Body Filler` deliberately stays an injection — it is a filler
     placed on the body, not body contouring, and report 01's own 105,806 figure
     matches Body Contouring alone rather than the two summed. Matching on a bare
     "body" would swallow it and overstate the department by 54%. */
  const familyOf = (category) => {
    const parts = String(category).split('/');
    const leaf = (parts[parts.length - 1] || '').trim().toLowerCase();
    const head = (parts[0] || '').trim().toLowerCase();
    if (/body\s*contour/.test(leaf)) return 'body';
    if (head.startsWith('device') || head.includes('laser')) return 'laser';
    if (head.startsWith('inject')) return 'inj';
    if (head.startsWith('body')) return 'body';
    return 'other';
  };

  const branchMix = new Map();
  const catTotals = new Map();
  let mixTotal = 0;
  for (const r of mixRows) {
    const ex = r2(r.ex_vat);
    mixTotal += ex;
    if (!branchMix.has(r.branch)) branchMix.set(r.branch, { branch: r.branch, exVat: 0, families: {}, categories: [] });
    const b = branchMix.get(r.branch);
    b.exVat = r2(b.exVat + ex);
    const fam = familyOf(r.category);
    b.families[fam] = r2((b.families[fam] || 0) + ex);
    b.categories.push({ category: r.category, exVat: ex, lines: r.lines, family: fam });
    const ct = catTotals.get(r.category) || { exVat: 0, lines: 0 };
    ct.exVat = r2(ct.exVat + ex);
    ct.lines += Number(r.lines);
    catTotals.set(r.category, ct);
  }

  const depByKey = new Map(departments.map((x) => [x.key, x]));
  const branches = [...branchMix.values()].map((b) => {
    b.categories.sort((x, y) => y.exVat - x.exVat);
    const share = (k) => (b.exVat ? (b.families[k] || 0) / b.exVat : 0);
    /* The eligibility test, spelled out per department so the page can show the
       reason and not just a tick. A floor is a minimum share; a cap is a
       maximum. A department with neither has no mix test at all. */
    const tests = departments.filter((dep) => dep.multiplier).map((dep) => {
      const sh = share(dep.key);
      const floor = dep.mixFloor === null ? null : d(dep.mixFloor);
      const cap = dep.mixCap === null ? null : d(dep.mixCap);
      const passFloor = floor === null ? true : sh >= floor;
      const passCap = cap === null ? true : sh <= cap;
      /* A department with neither a floor nor a cap has NO mix test stored, and
         `pass` is null rather than true. Body Contouring is the case: it carries
         a x1.25 multiplier whose real gate is "category revenue >= its monthly
         category target", and those per-category targets are not in the data.
         Returning true would render as PASS and tell a reader the multiplier was
         earned when nothing was tested — and it would do it most confidently for
         the branch with zero body revenue. */
      const untestable = floor === null && cap === null;
      return {
        key: dep.key, label: dep.label, multiplier: d(dep.multiplier),
        share: sh, floor, cap,
        pass: untestable ? null : (passFloor && passCap),
        condition: dep.condition || null,
        reason: untestable
          ? (dep.condition
            ? `No mix floor or ceiling in the policy — it is gated on "${dep.condition}", and per-category targets are not stored.`
            : 'No mix test stored for this department.')
          : !passFloor ? `${(sh * 100).toFixed(1)}% is under the ${(floor * 100).toFixed(0)}% floor`
            : !passCap ? `${(sh * 100).toFixed(1)}% is over the ${(cap * 100).toFixed(0)}% ceiling`
              : `${(sh * 100).toFixed(1)}% is inside the band`,
      };
    });
    return { ...b, share: mixTotal ? b.exVat / mixTotal : 0, tests };
  }).sort((a, b) => b.exVat - a.exVat);

  /* Per-doctor mix — report 01's "By doctor" slicer. `specialistName` on the
     invoice is the doctor credited with it. Kept alongside the branch cut because
     report 01 offers both from the same category selection. */
  const docRows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(i."specialistName", 'Unassigned')     AS doctor,
            COALESCE(i."branchName", 'Unassigned')         AS branch,
            COALESCE(l."categoryName", '(uncategorised)')  AS category,
            SUM(CASE WHEN i."moveType" = 'out_refund' THEN -l."priceSubtotal" ELSE l."priceSubtotal" END)::float AS ex_vat,
            COUNT(*)::int AS lines
       FROM "InvoiceLine" l
       JOIN "Invoice" i ON i."odooId" = l."invoiceOdooId"
      WHERE i.state = 'posted' AND i."invoiceDate" >= $1::date AND i."invoiceDate" <= $2::date
      GROUP BY 1, 2, 3`, from, to);

  const docMix = new Map();
  for (const r of docRows) {
    const ex = r2(r.ex_vat);
    if (!docMix.has(r.doctor)) docMix.set(r.doctor, { doctor: r.doctor, exVat: 0, categories: [] });
    const dd = docMix.get(r.doctor);
    dd.exVat = r2(dd.exVat + ex);
    /* Branch rides on every row so the entity filter can reach the by-doctor
       cuts. Without it those tables sit beside a branch table that filters and
       do not, which reads as a broken control. A doctor billing at both entities
       appears under each — that is the truth about that doctor. */
    dd.categories.push({
      category: r.category, branch: r.branch, exVat: ex, lines: r.lines,
      family: familyOf(r.category),
    });
  }
  const doctors = [...docMix.values()].map((dd) => {
    dd.categories.sort((a, b) => b.exVat - a.exVat);
    return { ...dd, share: mixTotal ? dd.exVat / mixTotal : 0 };
  }).sort((a, b) => b.exVat - a.exVat);

  const categories = [...catTotals.entries()]
    .map(([category, ct]) => ({
      category, exVat: ct.exVat, lines: ct.lines,
      family: familyOf(category),
      share: mixTotal ? ct.exVat / mixTotal : 0,
      /* Revenue per line — report 01's last column, and the one that separates a
         3.6M category sold 2,078 times from a 3.5M one sold 183 times. */
      perLine: ct.lines ? r2(ct.exVat / ct.lines) : 0,
    }))
    .sort((a, b) => b.exVat - a.exVat);

  /* -------- integrity -------- */
  const rev = revRow[0] || {};
  const pkg = pkgRow[0] || {};
  const coll = await collectionByBranch(from, to);
  const collNetEx = r2((coll.unattributed.totalNet) / R.VAT_DIVISOR);
  const revEx = r2(rev.ex_vat || 0);
  const pkgEx = r2(pkg.ex_vat || 0);

  const checks = [
    {
      check: 'Collection ex-VAT vs revenue ex-VAT',
      value: `${Math.round(collNetEx).toLocaleString('en-US')} vs ${Math.round(revEx).toLocaleString('en-US')}`,
      delta: revEx ? collNetEx / revEx - 1 : 0,
      reading: 'Cash banked against what was invoiced. They are different quantities and never tie: '
        + 'a package is cash today and revenue later, and an invoice unpaid at the cut-off is revenue with no cash.',
      severity: Math.abs(revEx ? collNetEx / revEx - 1 : 0) > 0.15 ? 'HIGH' : 'LOW',
    },
    {
      check: 'Package sales in the window',
      value: `${Math.round(pkgEx).toLocaleString('en-US')} over ${pkg.invoices || 0} invoices`,
      reading: r2(pkg.ex_vat || 0) === r2(pkg.inc_vat || 0)
        ? 'Zero VAT on every package invoice, which is what a prepayment looks like — it sits in the cash base but is a liability, not revenue.'
        : 'Some package invoices carry VAT, which contradicts treating them as prepayments. Worth checking.',
      severity: pkgEx && revEx && pkgEx / revEx > 0.05 ? 'MEDIUM' : 'LOW',
    },
    {
      check: 'Payments with no branch',
      value: `${Math.round(coll.unattributed.net).toLocaleString('en-US')} across ${coll.unattributed.txns} payments`,
      delta: coll.unattributed.share,
      reading: coll.unattributed.share > 0.5
        ? 'Most of this range predates the Odoo 18 cutover, and migrated payments carry no branch_id. '
          + 'Per-branch scoring is impossible here — the branch figures are a floor, not a measurement.'
        : 'Immaterial; the branch split holds.',
      severity: coll.unattributed.share > 0.5 ? 'BLOCKER' : coll.unattributed.share > 0.02 ? 'MEDIUM' : 'LOW',
    },
    {
      check: 'Invoices with no journal',
      value: `${rev.no_journal || 0} of ${rev.invoices || 0}`,
      reading: (rev.no_journal || 0) === 0
        ? 'Every invoice carries its journal, so packages can be excluded cleanly.'
        : 'Invoices synced before the journal field was added have none. Revenue ex-package cannot be computed for those; re-sync the range.',
      severity: (rev.no_journal || 0) === 0 ? 'LOW' : 'HIGH',
    },
    {
      check: 'Invoices with no branch',
      value: `${rev.no_branch || 0} of ${rev.invoices || 0}`,
      reading: (rev.no_branch || 0) / (rev.invoices || 1) > 0.05
        ? 'A material share of invoices is unattributed, so branch revenue understates.'
        : 'Immaterial.',
      severity: (rev.no_branch || 0) / (rev.invoices || 1) > 0.05 ? 'MEDIUM' : 'LOW',
    },
  ];

  return {
    from, to,
    daily,
    mix: { total: r2(mixTotal), branches, doctors, categories, departments: departments.map((x) => ({ key: x.key, label: x.label, multiplier: x.multiplier === null ? null : d(x.multiplier), mixFloor: x.mixFloor === null ? null : d(x.mixFloor), mixCap: x.mixCap === null ? null : d(x.mixCap) })) },
    integrity: {
      checks, collectionNetExVat: collNetEx, revenueExVat: revEx, packageExVat: pkgEx,
      revenueInvoices: rev.invoices || 0, packageInvoices: pkg.invoices || 0,
    },
  };
}


/* ------------------------------------------------- the entity mapping --- */

/**
 * Which entity each Odoo branch name belongs to.
 *
 * The All / Nouvel Age / ZAT switch cannot be answered from a branch name, and
 * guessing from one is how it silently broke: no Odoo branch name contains the
 * string "zat", so a `/zat/i` test returned nothing under ZAT and everything
 * under Nouvel Age — a control that looked wired up and filtered nothing. ZAT's
 * two branches are called **Madinity** and **El Rehab**.
 *
 * The truth lives in `CommissionBranch.entity`, and `IdentityAlias` (kind
 * `branch`) bridges the policy's spelling to Odoo's — "Madinty EastHub" is
 * Odoo's "Madinity". Both directions are indexed so a caller can pass whichever
 * name it holds.
 *
 * `unmapped` matters: "Unassigned" and "HQ" appear on invoices and belong to no
 * entity, so any page that filters by entity is hiding them and has to say so
 * rather than quietly shrinking its own total.
 */
async function branchEntities() {
  const [branches, aliases] = await Promise.all([
    prisma.commissionBranch.findMany({ orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }] }),
    prisma.identityAlias.findMany({ where: { kind: 'branch' } }),
  ]);
  const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliasTo = new Map(aliases.map((a) => [key(a.scheduleName), a.odooName]));

  /* Keyed on the normalised name so "Madinty Strip", "Madinity The Strip" and
     "madinitythestrip" all resolve — the same normalisation buildTracker uses. */
  const map = {};
  for (const b of branches) {
    map[key(b.name)] = b.entity;
    const odoo = aliasTo.get(key(b.name));
    if (odoo) map[key(odoo)] = b.entity;
  }
  return {
    map,
    entities: [...new Set(branches.map((b) => b.entity))],
    /* So a page can name what it cannot place. */
    counts: branches.reduce((a, b) => { a[b.entity] = (a[b.entity] || 0) + 1; return a; }, {}),
  };
}

module.exports = { buildTracker, buildTrackerRange, buildExtras, branchEntities, compareVersions, policyFor, collectionByBranch };
