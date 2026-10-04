/* ============================================================
   Reading the Commission Policy out of the database.

   Every cut is a query plus src/lib/commission-rules.js — nothing derived is
   stored, so editing a target or moving a band changes the answer immediately
   and no stale pool survives anywhere.

   One honesty note runs through the whole file. The policy's commission base is
   Net Collection ex-VAT — cash actually banked, (payment / 1.14) less credit
   notes. What this app currently syncs from Odoo is INVOICED ex-VAT. They are
   different numbers, so achievement, band, tier and pool are computed against
   the base that is actually available and every payload says which one that was
   in `base`. The UI prints it. Presenting an invoiced-based pool as a payable
   commission figure would be the single most expensive mistake this report
   could make.
   ============================================================ */

const { prisma, num } = require('./db.js');
const R = require('./commission-rules.js');

const YEAR_DEFAULT = 2026;
const d = (v) => (v === null || v === undefined ? null : Number(v));
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/* ---------- loaders ---------- */

async function loadPolicy() {
  const rows = await prisma.commissionPolicy.findMany({ orderBy: { key: 'asc' } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const f = (k, fallback) => (map[k] === undefined || map[k] === '' ? fallback : Number(map[k]));
  return {
    rows,
    map,
    vatDivisor: f('vat_divisor', R.VAT_DIVISOR),
    bands: { floor: f('achievement_floor', 0.8), mid: f('band_mid_from', 0.9), max: f('band_max_from', 1) },
    multiplierCap: f('service_bonus_cap', R.MULTIPLIER_CAP),
    baseDefinition: map.base_definition || null,
    version: map.policy_version || null,
    effectiveFrom: map.effective_from || null,
  };
}

const loadBranches = () => prisma.commissionBranch.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
const loadDepartments = () => prisma.commissionDepartment.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] });
const loadTiers = () => prisma.commissionTier.findMany({ orderBy: { tierNo: 'asc' } });
const loadRoles = () => prisma.commissionRole.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
const loadGates = () => prisma.managementGate.findMany({ orderBy: { role: 'asc' } });
const loadRules = () => prisma.commissionRule.findMany({ orderBy: [{ sortOrder: 'asc' }] });

async function loadCallCenter() {
  const [rates, members, bands] = await Promise.all([
    prisma.callCenterRate.findMany({ orderBy: [{ sortOrder: 'asc' }] }),
    prisma.callCenterMember.findMany({ orderBy: [{ role: 'asc' }, { name: 'asc' }] }),
    prisma.showRateBand.findMany({ orderBy: { threshold: 'asc' } }),
  ]);
  return {
    rates: rates.map((r) => ({ ...r, bonus: d(r.bonus) })),
    members,
    showBands: bands.map((b) => ({ ...b, threshold: d(b.threshold), bonus: d(b.bonus) })),
    byRole: members.reduce((m, x) => { (m[x.role] ||= []).push(x.name); return m; }, {}),
  };
}

async function loadNotes() {
  const rows = await prisma.commissionNote.findMany({ orderBy: [{ kind: 'asc' }, { id: 'asc' }] });
  const rank = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return {
    tests: rows.filter((r) => r.kind === 'test'),
    questions: rows.filter((r) => r.kind === 'question')
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || Number(a.ref) - Number(b.ref)),
    openBlockers: rows.filter((r) => r.kind === 'question' && r.severity === 'BLOCKER' && !r.resolved).length,
  };
}

/* ---------- the target grid ---------- */

/* The 11 x 12 view behind the Targets tab and the editor: one row per branch,
   twelve months across, plus the entity and area that own it. Band overrides
   travel with each cell so the UI can mark the ones that no longer follow the
   policy, and `bands` is always the RESOLVED pair — override where set, policy
   default everywhere else. */
async function targetGrid(year = YEAR_DEFAULT) {
  const [policy, branches, rows, departments, splits] = await Promise.all([
    loadPolicy(), loadBranches(),
    prisma.commissionTarget.findMany({ where: { year }, orderBy: [{ branchId: 'asc' }, { month: 'asc' }] }),
    loadDepartments(),
    prisma.commissionSplit.findMany({ where: { year } }),
  ]);

  const byBranch = new Map();
  for (const t of rows) {
    if (!byBranch.has(t.branchId)) byBranch.set(t.branchId, new Map());
    byBranch.get(t.branchId).set(t.month, t);
  }
  const splitByBranch = new Map();
  for (const s of splits) {
    if (!splitByBranch.has(s.branchId)) splitByBranch.set(s.branchId, new Map());
    splitByBranch.get(s.branchId).set(s.departmentId, d(s.annualTarget));
  }

  const gridRows = branches.map((b) => {
    const cells = [];
    let sum = 0;
    for (let m = 1; m <= 12; m++) {
      const t = byBranch.get(b.id) && byBranch.get(b.id).get(m);
      const target = t ? d(t.target) : null;
      if (target !== null) sum += target;
      cells.push({
        month: m, monthName: R.monthName(m),
        id: t ? t.id : null,
        target,
        bands: R.bandsFor(t || {}, policy.bands),
        override: R.hasOverride(t || {}),
        floorPct: t ? d(t.floorPct) : null,
        midPct: t ? d(t.midPct) : null,
        maxPct: t ? d(t.maxPct) : null,
        note: t ? t.note : null,
      });
    }
    const mySplits = splitByBranch.get(b.id) || new Map();
    return {
      id: b.id, name: b.name, area: b.area, entity: b.entity,
      journalCode: b.journalCode, active: b.active,
      annualTarget: d(b.annualTarget),
      months: cells,
      monthlySum: r2(sum),
      /* Sheet 16 q9: CampShizar's months sum to 200 more than its stated annual.
         Surfaced per row rather than reconciled away, because the resolution is
         Finance's to make and the monthly figures are what drive commission. */
      annualGap: b.annualTarget === null ? null : r2(sum - d(b.annualTarget)),
      splits: departments.map((dep) => ({
        departmentId: dep.id, key: dep.key, label: dep.label,
        annualTarget: mySplits.has(dep.id) ? mySplits.get(dep.id) : null,
      })),
      splitSum: r2([...mySplits.values()].reduce((s, v) => s + v, 0)),
    };
  });

  const monthTotals = [];
  for (let m = 1; m <= 12; m++) {
    monthTotals.push(r2(gridRows.reduce((s, r) => s + (r.months[m - 1].target || 0), 0)));
  }
  const entities = {};
  for (const r of gridRows) {
    entities[r.entity] ||= { entity: r.entity, branches: 0, annual: 0, monthly: 0 };
    entities[r.entity].branches++;
    entities[r.entity].annual = r2(entities[r.entity].annual + (r.annualTarget || 0));
    entities[r.entity].monthly = r2(entities[r.entity].monthly + r.monthlySum);
  }
  const areas = {};
  for (const r of gridRows) (areas[r.area] ||= []).push(r.name);

  return {
    year, policy: { version: policy.version, effectiveFrom: policy.effectiveFrom, bands: policy.bands, baseDefinition: policy.baseDefinition },
    branches: gridRows,
    departments: departments.map((x) => ({ ...x, multiplier: d(x.multiplier), mixFloor: d(x.mixFloor), mixCap: d(x.mixCap), groupMix: d(x.groupMix) })),
    monthTotals,
    grandTotal: r2(monthTotals.reduce((s, v) => s + v, 0)),
    annualTotal: r2(gridRows.reduce((s, r) => s + (r.annualTarget || 0), 0)),
    entities: Object.values(entities),
    areas,
    overrides: gridRows.reduce((n2, r) => n2 + r.months.filter((c) => c.override).length, 0),
  };
}

/* ---------- one month, scored against whatever actual we have ---------- */

/* `actuals` is [{ name, ex }] straight off the sales report's branch cut, so the
   two tabs cannot disagree about what a branch did. Names are resolved through
   IdentityAlias (kind 'branch') because the policy spells them differently from
   Odoo — CityStars vs City Stars, Zaied vs Zayed, MOA vs Mall Of Arabia. */
async function monthView(year, month, actuals = [], opts = {}) {
  const [policy, branches, tiers, roles, gates, departments, aliasRows, targetRows, splits] = await Promise.all([
    loadPolicy(), loadBranches(), loadTiers(), loadRoles(), loadGates(), loadDepartments(),
    prisma.identityAlias.findMany({ where: { kind: 'branch' } }),
    prisma.commissionTarget.findMany({ where: { year, month } }),
    prisma.commissionSplit.findMany({ where: { year } }),
  ]);

  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const actualByKey = new Map();
  for (const a of actuals) actualByKey.set(key(a.name), a);
  const aliasTo = new Map(aliasRows.map((a) => [key(a.scheduleName), a.odooName]));

  const targetOf = new Map(targetRows.map((t) => [t.branchId, t]));
  const splitByBranch = new Map();
  for (const s of splits) {
    if (!splitByBranch.has(s.branchId)) splitByBranch.set(s.branchId, new Map());
    splitByBranch.get(s.branchId).set(s.departmentId, d(s.annualTarget));
  }

  const base = opts.base || 'invoiced_ex_vat';

  /* Achievement against a FULL-month target is meaningless on the 13th. The
     policy pays on a closed month, so the band is the closed-month answer, but
     the page also needs the pro-rata read or every branch looks like it is
     failing for the first three weeks. Both are returned; the UI leads with
     pace while the month is still open. */
  const daysInPeriod = Number(opts.daysInPeriod) || 0;
  const dayNo = Number(opts.dayNo) || 0;
  const partial = daysInPeriod > 0 && dayNo > 0 && dayNo < daysInPeriod;
  const paceShare = partial ? dayNo / daysInPeriod : 1;

  const rows = [];
  const unmatched = [];

  for (const b of branches) {
    if (!b.active) continue;
    const t = targetOf.get(b.id) || null;
    /* ---- A BRANCH WITH NO TARGET FOR THIS MONTH IS NOT SCORED ----
       Golden Square was added in October 2026 with a plan that starts in April
       2027. Scored anyway it appeared as a twelfth branch at 0% in every 2026
       month, and — worse — landed in `unmatched`, which the Commission report
       shows as "1 branch unmatched" in red. It is not unmatched; it has nothing
       to match yet. It does not drag the totals (they sum targets, and its is
       zero) but it does raise a false alarm and inflate every per-branch count.

       A branch that has no row in `CommissionTarget` for the month is skipped
       entirely. One that has a row of zero is a deliberate zero and is still
       scored, which is the distinction the plan editor keeps. */
    if (!t) continue;
    const target = d(t.target);
    const bands = R.bandsFor(t || {}, policy.bands);

    /* direct hit, then alias, then nothing */
    let hit = actualByKey.get(key(b.name));
    let via = null;
    if (!hit && aliasTo.has(key(b.name))) {
      const odoo = aliasTo.get(key(b.name));
      hit = actualByKey.get(key(odoo));
      if (hit) via = odoo;
    }
    if (!hit) unmatched.push(b.name);

    const actual = hit ? r2(hit.ex) : 0;

    /* Category revenue is not available per department from the sales cut, so no
       multiplier is claimed. Passing [] rather than guessing keeps the pool at
       its band value instead of inventing a 1.25x nobody earned. */
    const scored = R.branchMonth({
      net: actual, target: target || 0, bands, tiers, roles,
      earnedDepartments: [], multiplierCap: policy.multiplierCap,
    });

    const mySplits = splitByBranch.get(b.id) || new Map();
    const proRataTarget = target === null ? null : r2(target * paceShare);
    const paceAchievement = proRataTarget ? actual / proRataTarget : 0;

    /* Mid-month, `scored` is the closed-month answer computed on a partial month:
       the band is almost always "below floor" and the tier is whatever tier a
       third of a month's revenue falls in. Both are true and both are useless on
       the 13th, and showing "tracking to MID" beside a zero pool from the same row
       is worse than useless — it reads as a contradiction.

       So when the month is open we also run the whole calculation on the month
       PROJECTED at the current daily rate: projected net -> projected tier ->
       projected band -> projected pool. It is a forecast and the UI says so, but
       it is at least internally consistent. */
    const projected = partial && paceShare > 0
      ? R.branchMonth({
        net: r2(actual / paceShare), target: target || 0, bands, tiers, roles,
        earnedDepartments: [], multiplierCap: policy.multiplierCap,
      })
      : null;
    rows.push({
      ...scored,
      branchId: b.id, name: b.name, area: b.area, entity: b.entity,
      journalCode: b.journalCode,
      matched: !!hit, via, invoices: hit ? hit.invoices : 0,
      override: R.hasOverride(t || {}),
      hasTarget: target !== null,
      tone: R.bandTone(scored.band),
      proRataTarget,
      paceAchievement,
      /* the whole month as forecast from the current daily rate — clearly named */
      projected: projected && {
        net: projected.net, band: projected.band, bandLabel: projected.bandLabel,
        tierNo: projected.tierNo, tierLabel: projected.tierLabel,
        pools: projected.pools, pool: projected.pool, roles: projected.roles,
      },
      projectedBand: projected ? projected.band : scored.band,
      paceTone: R.bandTone(projected ? projected.band : scored.band),
      categoryTargets: departments.map((dep) => ({
        key: dep.key, label: dep.label,
        multiplier: d(dep.multiplier),
        /* flat annual/12 — sheet 16 q4 says the derivation is unconfirmed, so the
           method is named in the payload rather than assumed silently */
        monthlyTarget: mySplits.has(dep.id) ? r2(mySplits.get(dep.id) / 12) : null,
      })),
    });
  }

  /* Gates, on the same basis as everything else. Mid-month the closed-month
     numbers put every area at 0 hits and every gate "failed", which is arithmetic
     rather than information — on day 13 nobody has hit a full-month target. So
     while the month is open the gates are evaluated on the PROJECTED month and
     `gateBasis` says so; once it closes they are evaluated on the real thing. */
  const gateRows = rows.map((r) => (r.projected
    ? { name: r.name, area: r.area, achievement: r.paceAchievement, pool: r.projected.pool, net: r.projected.net, target: r.target }
    : { name: r.name, area: r.area, achievement: r.achievement, pool: r.pool, net: r.net, target: r.target }));

  const amGate = gates.find((g) => g.scope === 'area') || null;
  const dirGate = gates.find((g) => g.scope === 'group') || null;
  const areaResults = [];
  if (amGate) {
    const byArea = {};
    for (const r of gateRows) (byArea[r.area] ||= []).push(r);
    for (const [area, members] of Object.entries(byArea)) {
      areaResults.push({
        area, branches: members.map((m) => m.name),
        ...R.areaGate(members, { rate: d(amGate.rate), minBranches: amGate.minBranches, floor: policy.bands.floor }),
      });
    }
  }
  const director = dirGate
    ? R.directorGate(gateRows, { rate: d(dirGate.rate), minBranches: dirGate.minBranches, groupPct: d(dirGate.groupPct), floor: policy.bands.floor })
    : null;

  const targetTotal = r2(rows.reduce((s, r) => s + (r.target || 0), 0));
  const actualTotal = r2(rows.reduce((s, r) => s + r.net, 0));

  const proRataTotal = r2(rows.reduce((s, r) => s + (r.proRataTarget || 0), 0));

  return {
    year, month, monthName: R.monthName(month),
    base,
    partial, dayNo, daysInPeriod, paceShare,
    proRataTotal,
    paceGroupAchievement: proRataTotal > 0 ? r2(rows.reduce((s, r) => s + r.net, 0)) / proRataTotal : 0,
    paceHits: rows.filter((r) => r.paceAchievement >= policy.bands.floor).length,
    /* The single most important sentence on the page. */
    baseNote: base === 'net_collection_ex_vat'
      ? 'Net Collection ex-VAT, the policy base.'
      : 'Measured on INVOICED ex-VAT. The policy base is Net Collection ex-VAT — (payment ÷ 1.14) less credit notes — which this app does not yet sync. Bands, tiers and pools below are indicative, not payable.',
    policy: { version: policy.version, bands: policy.bands, multiplierCap: policy.multiplierCap, baseDefinition: policy.baseDefinition },
    branches: rows,
    targetTotal,
    actualTotal,
    groupAchievement: targetTotal > 0 ? actualTotal / targetTotal : 0,
    poolTotal: r2(rows.reduce((s, r) => s + r.pool, 0)),
    projectedPoolTotal: r2(rows.reduce((s, r) => s + (r.projected ? r.projected.pool : r.pool), 0)),
    hits: rows.filter((r) => r.achievement >= policy.bands.floor).length,
    areas: areaResults,
    director,
    gateBasis: partial ? 'projected' : 'actual',
    gates: gates.map((g) => ({ ...g, rate: d(g.rate), groupPct: d(g.groupPct) })),
    roles: roles.map((r) => ({ ...r, sharePct: d(r.sharePct) })),
    unmatched,
    tiers: tiers.map((t) => ({ ...t, revFrom: d(t.revFrom), revTo: d(t.revTo), pools: R.poolsOf(t) })),
  };
}

module.exports = {
  YEAR_DEFAULT,
  loadPolicy, loadBranches, loadDepartments, loadTiers, loadRoles, loadGates, loadRules,
  loadCallCenter, loadNotes,
  targetGrid, monthView,
};
