/* ============================================================
   `const D` and `const TGT`, rebuilt from Postgres.

   WHY THIS EXISTS. The merged report runs the standalone dashboard's own
   script — every render function, every layout, unchanged — rather than a
   re-implementation of it. Re-implementing was the mistake: each panel drifted
   a little from the original, and a hundred small drifts is a different page.

   That script opens with two constants holding 584 KB of data. This builds the
   same two objects out of the tables `scripts/import-artifact-plan.js` filled,
   so the script finds exactly what it expects and nothing above line 454 has to
   change.

   THE SHAPES ARE NOT NEGOTIABLE. `D.TG[branch]` must be twelve arrays of five
   in `D.G` order; `D.act[period][branch]` must be a number; `TGT.branches[i].m`
   must be keyed "YYYY-MM". The script indexes these positionally in places, so
   a plausible-looking variation is a silent wrong answer rather than an error.
   `test/tgc-bootstrap.test.js` compares every key against the original file.
   ============================================================ */

const { prisma, num } = require('./db.js');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * The brand token the dashboard script compares against.
 *
 * The script hardcodes its chips as `[['Nouvelage','Nouvelage'],['ZAT','ZAT']]`
 * and filters with `r.brand === bf`. This database spells the same entity
 * "Nouvel Age", with a space — so picking Nouvelage matched no branch at all
 * and the whole table collapsed to a zero Total, while ZAT happened to work.
 *
 * Matched on letters only rather than swapped by hand, so "Nouvel Age",
 * "NouvelAge" and "nouvelage" all land on the one token the script knows.
 * An entity that matches neither is passed through untouched: inventing a
 * brand for it would hide it from both filters instead of one.
 */
const BRAND_TOKENS = ['Nouvelage', 'ZAT'];
const brandToken = (entity) => {
  const flat = String(entity || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return BRAND_TOKENS.find((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '') === flat) || entity;
};

/** The five service groups, in the order `D.TG`'s inner arrays use. */
const GROUPS = ['Laser', 'Injectables', 'Body Contouring', 'Skin & Facials', 'Visits & Other'];
/** The doctor cohorts on the approved sheet. */
const DOCTOR_GROUPS = ['Injectables', 'Laser + Injection', 'Laser-led', 'Nutrition', 'Therapist', 'Not in approved schedule'];

async function build() {
  const [
    branches, targets, docPlan, profiles, slots,
    seasonality, mix, weekdays, history, days, docDays,
  ] = await Promise.all([
    prisma.commissionBranch.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.commissionTarget.findMany({ include: { branch: { select: { name: true } } } }),
    prisma.doctorPlanMonth.findMany({ orderBy: [{ doctorName: 'asc' }, { period: 'asc' }] }),
    prisma.doctorProfile.findMany({ orderBy: { name: 'asc' } }),
    prisma.doctorRosterSlot.findMany({ orderBy: [{ doctorName: 'asc' }, { dow: 'asc' }] }),
    prisma.planSeasonality.findMany(),
    prisma.planProductMix.findMany(),
    prisma.weekdayWeight.findMany({ orderBy: { dow: 'asc' } }),
    prisma.historyMonth.findMany({ orderBy: { period: 'asc' } }),
    prisma.historyDay.findMany({ orderBy: { date: 'asc' } }),
    prisma.historyDayDoctor.findMany({ orderBy: { date: 'asc' } }),
  ]);

  /* ---- the approved sheet: TGT ---- */
  const branchM = {};
  for (const t of targets) {
    const name = t.branch?.name;
    if (!name) continue;
    (branchM[name] ||= {})[`${t.year}-${String(t.month).padStart(2, '0')}`] = r2(num(t.target));
  }
  const brandOf = Object.fromEntries(branches.map((b) => [b.name, brandToken(b.entity)]));

  const TGT = {
    branches: branches.map((b) => ({
      branch: b.name,
      brand: brandToken(b.entity),
      m: branchM[b.name] || {},
    })),
    doctors: [],
  };

  const docM = {};
  const docGroup = {};
  for (const d of docPlan) {
    (docM[d.doctorName] ||= {})[d.period] = r2(num(d.target));
    if (d.groupName) docGroup[d.doctorName] = d.groupName;
  }
  TGT.doctors = Object.keys(docM).sort().map((name) => ({
    name,
    group: docGroup[name] || null,
    m: docM[name],
  }));

  /* ---- history: D.act / D.actg / D.actp, keyed period -> name -> number ---- */
  const act = {};
  const actg = {};
  const actp = {};
  for (const h of history) {
    const bucket = h.kind === 'branch' ? act : h.kind === 'group' ? actg : actp;
    (bucket[h.period] ||= {})[h.name] = r2(num(h.ex));
  }

  /* ---- D.dly: date -> branch -> number ---- */
  const dly = {};
  for (const d of days) (dly[ymd(d.date)] ||= {})[d.name] = r2(num(d.ex));

  /* ---- D.ddoc: date -> [doctor, branch, ex, invoices, productType] ----
     A 5-tuple, positional, exactly as the script destructures it. */
  const ddoc = {};
  for (const r of docDays) {
    (ddoc[ymd(r.date)] ||= []).push([
      r.doctorName, r.branchName, r2(num(r.ex)), r.invoices || 0, r.productType,
    ]);
  }

  /* ---- D.TG: branch -> 12 months -> 5 groups, in GROUPS order ---- */
  const TG = {};
  for (const s of seasonality) {
    const rows = (TG[s.branchName] ||= Array.from({ length: 12 }, () => GROUPS.map(() => 0)));
    const gi = GROUPS.indexOf(s.groupName);
    if (gi >= 0) rows[s.month - 1][gi] = r2(num(s.ex));
  }

  /* ---- D.TP: branch -> group -> type -> share ---- */
  const TP = {};
  for (const m of mix) {
    ((TP[m.branchName] ||= {})[m.groupName] ||= {})[m.productType] = num(m.share);
  }

  /* ---- D.wd: the weekday weights, back in the script's Monday-first keys ---- */
  const wd = {};
  for (const w of weekdays) wd[w.dow] = num(w.weight);

  /* ---- D.docs and D.rosterB ----
     `roster` is keyed by JavaScript's getDay(); each entry is
     [branch, hours, from, to, department], positional. */
  const rosterByDoctor = {};
  const rosterB = {};
  for (const s of slots) {
    const entry = [s.branchName, num(s.hours), s.startTime, s.endTime, s.department];
    ((rosterByDoctor[s.doctorName] ||= {})[s.dow] ||= []).push(entry);
    ((rosterB[s.branchName] ||= {})[s.dow] ||= []).push([s.doctorName, num(s.hours), s.startTime, s.endTime, s.department]);
  }

  const docs = profiles.map((p) => ({
    name: p.name,
    group: p.groupName,
    dep: p.department,
    branches: p.branches || [],
    mix: p.mix || {},
    roster: rosterByDoctor[p.name] || {},
  }));

  /* ---- the plan totals the header reads ---- */
  const months27 = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`);
  const monthTot = months27.map((k) => r2(Object.values(branchM).reduce((t, m) => t + (m[k] || 0), 0)));
  const T = {};
  for (const [name, m] of Object.entries(branchM)) T[name] = months27.map((k) => r2(m[k] || 0));

  /* `bshare`: each branch's share of the 2026 actual, which the script uses to
     spread a figure it only knows in total. */
  const a26 = {};
  for (const [period, byBranch] of Object.entries(act)) {
    if (!period.startsWith('2026')) continue;
    for (const [b, v] of Object.entries(byBranch)) a26[b] = (a26[b] || 0) + v;
  }
  const a26Total = Object.values(a26).reduce((t, v) => t + v, 0) || 1;
  const bshare = Object.fromEntries(Object.entries(a26).map(([b, v]) => [b, v / a26Total]));

  const D = {
    months27,
    total: r2(monthTot.reduce((t, v) => t + v, 0) / 1e6),
    monthTot,
    T,
    TG,
    TP,
    G: GROUPS,
    act,
    actg,
    actp,
    dly,
    wd,
    docs,
    branches: branches.map((b) => b.name),
    bshare,
    ddoc,
    groups: DOCTOR_GROUPS,
    brand: brandOf,
    t26aug_total: r2(Object.values(act['2026-08'] || {}).reduce((t, v) => t + v, 0)),
    rosterB,
  };

  return { D, TGT };
}

module.exports = { build, GROUPS, DOCTOR_GROUPS, brandToken };
