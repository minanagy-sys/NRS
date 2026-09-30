/* ============================================================
   Target sheet -> scored rows.

   The arithmetic itself lives in lib/rules.js, shared with the standalone
   report, so both score identically. This module only supplies the data and
   assembles the answer.
   ============================================================ */

const { prisma, num } = require('./db.js');
const { toneOf, dailyTarget, matcher, normName } = require('./rules.js');

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

async function loadPeriod(period) {
  const p = await prisma.targetPeriod.findUnique({
    where: { period },
    include: { groups: true, doctorTargets: true, branchTargets: true },
  });
  if (!p) return null;

  const aliases = await prisma.identityAlias.findMany();
  const asMap = (kind) => Object.fromEntries(
    aliases.filter((a) => a.kind === kind).map((a) => [a.scheduleName, a.odooName]));

  return {
    period: p.period,
    daysInPeriod: p.daysInPeriod,
    sourceLabel: p.sourceLabel,
    groups: Object.fromEntries(p.groups.map((g) => [g.name, {
      target: num(g.target), rosterCount: g.rosterCount,
      unlistedCount: g.unlistedCount, unlistedTarget: num(g.unlistedTarget),
    }])),
    doctors: p.doctorTargets.map((d) => ({
      name: d.scheduleName, group: d.groupName,
      monthlyTarget: num(d.monthlyTarget), prevMonth: d.prevMonth === null ? null : num(d.prevMonth),
      hasSales: d.hasSales,
    })),
    branches: p.branchTargets.map((b) => ({
      name: b.scheduleName, target1: num(b.target1),
      target2: b.target2 === null ? null : num(b.target2),
    })),
    aliases: { doctors: asMap('doctor'), branches: asMap('branch') },
  };
}

/**
 * Score a sheet against actuals.
 * `mtd` covers the 1st of the month to `to`; `range` is the selected window.
 */
function score(sheet, { mtd, range, to, rangeDays }) {
  const days = sheet.daysInPeriod || 31;
  const dayNo = Number(String(to).slice(8, 10));
  const paceFraction = dayNo / days;

  const findMtd = matcher(mtd.doctors, sheet.aliases.doctors);
  const findRange = matcher(range.doctors, sheet.aliases.doctors);

  /* Roster members with no sales are already counted inside each group's
     unlistedTarget. Scoring them as rows too would add their value a second
     time — which is how 28,838,391 turns into 30,460,940. They are listed
     separately so the names are not lost. */
  const scored = sheet.doctors.filter((d) => d.hasSales !== false);
  const noSales = sheet.doctors.filter((d) => d.hasSales === false);

  const rows = scored.map((t) => {
    const m = findMtd(t.name), r = findRange(t.name);
    const mtdRow = m.row || { ex: 0, invoices: 0 };
    const rangeRow = r.row || { ex: 0, invoices: 0 };
    const perDay = dailyTarget(t.monthlyTarget, days);
    const rangeTarget = perDay * rangeDays;

    return {
      ...t,
      perDay,
      rangeTarget,
      mtdEx: r2(mtdRow.ex), mtdInvoices: mtdRow.invoices,
      rangeEx: r2(rangeRow.ex),
      // Colour on the raw ratio; the percentage shown is rounded separately.
      mtdTone: toneOf(mtdRow.ex, t.monthlyTarget * paceFraction),
      rangeTone: toneOf(rangeRow.ex, rangeTarget),
      mtdPct: t.monthlyTarget ? (mtdRow.ex / t.monthlyTarget) * 100 : 0,
      rangePct: rangeTarget ? (rangeRow.ex / rangeTarget) * 100 : 0,
      via: m.via || r.via || null,
      mergedFrom: (m.row && m.row.mergedFrom) || (r.row && r.row.mergedFrom) || null,
      matched: !!(m.row || r.row),
    };
  });

  const findBMtd = matcher(mtd.branches, sheet.aliases.branches);
  const findBRange = matcher(range.branches, sheet.aliases.branches);
  const branchRows = sheet.branches.map((b) => {
    const m = findBMtd(b.name), r = findBRange(b.name);
    const mtdEx = m.row ? m.row.ex : 0;
    const rangeEx = r.row ? r.row.ex : 0;
    const rangeTarget = dailyTarget(b.target1, days) * rangeDays;
    return {
      ...b,
      mtdEx: r2(mtdEx), rangeEx: r2(rangeEx), rangeTarget,
      rangeTone: toneOf(rangeEx, rangeTarget),
      tone1: toneOf(mtdEx, b.target1 * paceFraction),
      tone2: toneOf(mtdEx, (b.target2 || 0) * paceFraction),
      pct1: b.target1 ? (mtdEx / b.target1) * 100 : 0,
      pct2: b.target2 ? (mtdEx / b.target2) * 100 : 0,
      via: m.via || r.via || null,
      matched: !!(m.row || r.row),
    };
  });

  // Group targets are authoritative; listed doctors plus unlisted equals the group.
  const groupNames = [...new Set(scored.map((d) => d.group || 'Other'))];
  const groups = groupNames.map((name) => {
    const info = sheet.groups[name] || {};
    const list = rows.filter((r) => (r.group || 'Other') === name).sort((a, b) => b.mtdEx - a.mtdEx);
    return {
      name,
      rows: list,
      target: info.target ?? list.reduce((s, r) => s + r.monthlyTarget, 0),
      rosterCount: info.rosterCount ?? list.length,
      unlistedCount: info.unlistedCount ?? 0,
      unlistedTarget: info.unlistedTarget ?? 0,
      mtdEx: r2(list.reduce((s, r) => s + r.mtdEx, 0)),
    };
  });

  const sheetTotal = groups.reduce((s, g) => s + g.target, 0);
  /* Compare the way the matcher does. A looser comparison here listed doctors
     as "absent from the sheet" while they were on it and being scored — Odoo
     writes "DR. Nada Tarek" where the schedule says "Dr Nada Tarek", and
     "Dr. Azza Awad " carries a trailing space. Only normName sees through that,
     so anything short of it accuses the schedule of gaps it does not have. */
  const matchedKeys = new Set(rows.filter((r) => r.matched)
    .flatMap((r) => [r.name, r.via, ...(r.mergedFrom || [])])
    .filter(Boolean).map(normName));

  return {
    period: sheet.period,
    daysInPeriod: days,
    dayNo,
    pacePct: paceFraction * 100,
    sourceLabel: sheet.sourceLabel,
    groups,
    branches: branchRows,
    sheetTotal,
    rosterCount: groups.reduce((s, g) => s + g.rosterCount, 0),
    listedCount: rows.length,
    unlistedTotal: r2(groups.reduce((s, g) => s + g.unlistedTarget, 0)),
    mtdTotal: r2(rows.reduce((s, r) => s + r.mtdEx, 0)),
    rangeTotal: r2(rows.reduce((s, r) => s + r.rangeEx, 0)),
    rangeTargetTotal: rows.reduce((s, r) => s + r.rangeTarget, 0),
    noSales: noSales.map((d) => ({ name: d.name, monthlyTarget: d.monthlyTarget })),
    unresolved: rows.filter((r) => !r.matched).map((r) => r.name),
    duplicates: rows.filter((r) => r.mergedFrom).map((r) => r.mergedFrom),
    // Doctors invoicing but absent from the sheet.
    offSheet: range.doctors.filter((d) => !matchedKeys.has(normName(d.name))),
  };
}

module.exports = { loadPeriod, score };
