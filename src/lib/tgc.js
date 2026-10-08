/* ============================================================
   Targets & Commission — the merged report's data layer.

   One report replaced two, and this file is what the merged page reads. It
   exists because the page it was ported from read Odoo live from the browser:
   twenty-four `read_group` calls, re-issued on every date change. That is not
   how this app works — the page never queries the MCP, every figure is SQL —
   so each of those calls had to become a query here.

   TWO BASES, NEVER MIXED. Collected is cash received ex-VAT and is what the
   commission policy pays on. Billed is invoiced ex-VAT and is what the target
   sheet measures. The ported page labelled every column with which one it was;
   so does this, and `basis` rides along on every row so the client cannot
   guess wrong.

   THE CACHE DOES NOT REACH BACK FAR ENOUGH, AND THAT IS HANDLED HERE. `Invoice`
   holds what the sync has pulled — at the time of writing, days, not years.
   The report asks about 2026 as a whole. So a window is served from the live
   cache where the cache covers it and from the imported history where it does
   not, and `sources` on the answer says which parts came from where. Silently
   returning a tenth of a year because the sync has not run is the one outcome
   worth refusing.
   ============================================================ */

const { prisma, num } = require('./db.js');
const Tracker = require('./target-tracker.js');
const Report = require('./report.js');

/* REFUNDS ARE SUBTRACTED HERE, not by storing them negative. The cache keeps
   Odoo's absolute `amount_untaxed` — every other report (Patients, Targets
   tracker, Doctors, Procurement) negates `out_refund` itself, and all 43,000
   stored invoices follow that. Summing invoices and credit notes together
   without the sign ADDED the refunds: September came out high by exactly twice
   them. Switching the sync to `amount_untaxed_signed` instead (tried 2026-10-08)
   would have fixed this file and broken those four, so the sign lives in these
   queries, the same way it does everywhere else. */
const SIGNED_EX = `case when "moveType" = 'out_refund' then -"amountUntaxed" else "amountUntaxed" end`;
const SIGNED_LINE = `case when i."moveType" = 'out_refund' then -l."priceSubtotal" else l."priceSubtotal" end`;

/**
 * Journals whose invoices are NOT revenue comparable to collections.
 *
 * The Package Sale journal is the one that matters: a package is invoiced when
 * it is SOLD, carries no VAT at all, and the cash arrives on a different day
 * from the treatment it pays for. Counting it here inflated September by
 * 1,410,739 across 149 invoices and made the live figure disagree with every
 * other revenue number in the app.
 *
 * Taken from `report.js` rather than restated, so there is one list.
 */
const EXCLUDED = Report.EXCLUDED_REVENUE_JOURNALS || ['Package sale journal'];
const exclusion = (alias) => (EXCLUDED.length
  ? `and (${alias}."journalName" is null or ${alias}."journalName" not in (${EXCLUDED.map((j) => `'${j.replace(/'/g, "''")}'`).join(', ')}))`
  : '');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const key = (s) => String(s || '').trim().toLowerCase();
const monthOf = (d) => String(d).slice(0, 7);

/**
 * The day the live cache starts, how much is in it, and WHEN IT WAS LAST
 * FILLED.
 *
 * The last point matters more than it looks: the page reads Postgres, and
 * Postgres is only as current as the last sync. Saying "live" without saying
 * "as of when" lets a reader take a three-day-old figure for this morning's.
 */
async function cacheSpan() {
  const [row] = await prisma.$queryRawUnsafe(
    `select min("invoiceDate")::text lo, max("invoiceDate")::text hi, count(*)::int n from "Invoice"`,
  );
  const last = await prisma.syncRun.findFirst({
    where: { status: 'ok' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true, fromDate: true, toDate: true, invoices: true },
  }).catch(() => null);
  return {
    lo: row?.lo || null,
    hi: row?.hi || null,
    invoices: row?.n || 0,
    lastSync: last ? {
      at: last.startedAt,
      from: last.fromDate ? last.fromDate.toISOString().slice(0, 10) : null,
      to: last.toDate ? last.toDate.toISOString().slice(0, 10) : null,
      invoices: last.invoices == null ? null : Number(last.invoices),
    } : null,
  };
}

/**
 * Odoo's branch spelling, resolved to the plan's.
 *
 * THE TOTAL WAS RIGHT AND THE ROWS WERE WRONG, which is the worst way for this
 * to fail. Odoo writes "Madinity The Strip", "Roushdy", "Mall Of Arabia"; the
 * approved sheet says "Madinty The Strip", "Alex Roshdy", "Mall of Arabia". The
 * page summed every row for its headline and then looked each branch up by the
 * PLAN's name, so 1.2M of real revenue — 36% of a six-day range — was in the
 * total and absent from four cards.
 *
 * Two kinds of difference, treated differently on purpose:
 *
 *   Case and punctuation only ("Mall Of Arabia") are resolved here. There is
 *   one branch it can be, and refusing to see it helps nobody.
 *
 *   Anything else ("Madinity" vs "Madinty") is NOT guessed. `IdentityAlias` is
 *   where a human states that two spellings are one branch, exactly as
 *   `rules.js` does for doctors — "Dr.Merna Masoud" and "Dr.Merna Ashraf" are
 *   one edit apart and are different people. Unresolved names are returned
 *   under `unmatched` with their money, so the page can say what it could not
 *   place instead of quietly dropping it.
 */
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function branchResolver() {
  const [branches, aliases] = await Promise.all([
    prisma.commissionBranch.findMany({ select: { name: true } }),
    prisma.identityAlias.findMany({ where: { kind: 'branch' } }).catch(() => []),
  ]);
  const byNorm = new Map(branches.map((b) => [normName(b.name), b.name]));
  /* An alias maps the sheet's spelling to Odoo's, so it is read in reverse. */
  for (const a of aliases) {
    if (a.odooName && a.scheduleName) byNorm.set(normName(a.odooName), a.scheduleName);
  }
  const unmatched = new Map();
  const resolve = (odooName) => {
    if (!odooName) return odooName;
    const hit = byNorm.get(normName(odooName));
    if (hit) return hit;
    unmatched.set(odooName, true);
    return odooName;
  };
  return { resolve, unmatched };
}

/** Every day in [from, to], inclusive, as "YYYY-MM-DD". */
function daysBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Every month touched by [from, to], as "YYYY-MM". */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/* ------------------------------------------------------------ reference --- */

/**
 * Everything on the page that a date change does not move: the plan, the
 * policy, the roster, the seasonal shape, the frozen history.
 *
 * Sent in one answer rather than six because the page needs all of it before it
 * can draw anything, and six round trips on a clinic connection is the
 * difference between a page that appears and a page that assembles itself.
 */
async function reference() {
  const [branches, targets, docPlan, profiles, slots, seasonality, mix, weekdays, history] = await Promise.all([
    prisma.commissionBranch.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.commissionTarget.findMany({ include: { branch: { select: { name: true } } } }),
    prisma.doctorPlanMonth.findMany({ orderBy: [{ doctorName: 'asc' }, { period: 'asc' }] }),
    prisma.doctorProfile.findMany({ orderBy: { name: 'asc' } }),
    prisma.doctorRosterSlot.findMany({ orderBy: [{ doctorName: 'asc' }, { dow: 'asc' }] }),
    prisma.planSeasonality.findMany(),
    prisma.planProductMix.findMany(),
    prisma.weekdayWeight.findMany({ orderBy: { dow: 'asc' } }),
    prisma.historyMonth.findMany({ orderBy: { period: 'asc' } }),
  ]);

  /* The branch plan as a grid: branch -> "YYYY-MM" -> target. The page totals
     it in several directions, so a grid beats a row list. */
  const branchPlan = {};
  for (const t of targets) {
    const name = t.branch?.name;
    if (!name) continue;
    const period = `${t.year}-${String(t.month).padStart(2, '0')}`;
    (branchPlan[name] ||= {})[period] = r2(num(t.target));
  }

  const doctorPlan = {};
  const doctorGroup = {};
  for (const d of docPlan) {
    (doctorPlan[d.doctorName] ||= {})[d.period] = r2(num(d.target));
    if (d.groupName) doctorGroup[d.doctorName] = d.groupName;
  }

  /* The roster, indexed both ways the page asks for it: by doctor for the
     doctor panels, by branch for the day plan. Same 285 rows either way. */
  const rosterByDoctor = {};
  const rosterByBranch = {};
  for (const s of slots) {
    const entry = {
      branch: s.branchName,
      hours: num(s.hours),
      from: s.startTime,
      to: s.endTime,
      department: s.department,
    };
    ((rosterByDoctor[s.doctorName] ||= {})[s.dow] ||= []).push(entry);
    ((rosterByBranch[s.branchName] ||= {})[s.dow] ||= []).push({ ...entry, doctor: s.doctorName });
  }

  const seasonalityByBranch = {};
  for (const s of seasonality) {
    ((seasonalityByBranch[s.branchName] ||= {})[s.month] ||= {})[s.groupName] = r2(num(s.ex));
  }

  const mixByBranch = {};
  for (const m of mix) {
    ((mixByBranch[m.branchName] ||= {})[m.groupName] ||= {})[m.productType] = num(m.share);
  }

  /* `D.wd` was Monday-first; so is the stored row. The client indexes it with a
     real calendar date, so it converts rather than this file guessing. */
  const weekday = {};
  for (const w of weekdays) weekday[w.dow] = num(w.weight);

  const historyByKind = { branch: {}, group: {}, product: {} };
  for (const h of history) {
    if (!historyByKind[h.kind]) historyByKind[h.kind] = {};
    (historyByKind[h.kind][h.period] ||= {})[h.name] = r2(num(h.ex));
  }

  const policy = await loadPolicy();
  const span = await cacheSpan();

  return {
    branches: branches.map((b) => ({
      /* The plan writer addresses cells by branch id, not by name. */
      id: b.id,
      name: b.name,
      area: b.area,
      entity: b.entity,
      brand: b.entity,
      active: b.active,
      journalCode: b.journalCode,
    })),
    branchPlan,
    doctorPlan,
    doctorGroup,
    doctors: profiles.map((p) => ({
      name: p.name,
      group: p.groupName,
      department: p.department,
      branches: p.branches,
      mix: p.mix,
    })),
    rosterByDoctor,
    rosterByBranch,
    seasonality: seasonalityByBranch,
    mix: mixByBranch,
    weekday,
    history: historyByKind,
    policy,
    cache: span,
    groups: ['Laser', 'Injectables', 'Body Contouring', 'Skin & Facials', 'Visits & Other'],
    doctorGroups: ['Injectables', 'Laser + Injection', 'Laser-led', 'Nutrition', 'Therapist', 'Not in approved schedule'],
  };
}

/**
 * The v3.2 commission policy as the page needs it: the five achievement levels,
 * the fourteen revenue tiers and their pools, what each role weighs, the two
 * management gates, the doctor schemes and the call-centre rates.
 */
async function loadPolicy() {
  const [levels, pools, roles, gates, schemes, doctorSchemes, ccRates, ccTeam, showRates, rules] = await Promise.all([
    prisma.commissionLevel.findMany({ orderBy: { level: 'asc' } }),
    prisma.commissionPool.findMany({ orderBy: { tierNo: 'asc' } }),
    prisma.commissionRoleWeight.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.managementGate.findMany(),
    prisma.commissionScheme.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.doctorScheme.findMany(),
    prisma.callCenterRate.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.callCenterMember.findMany(),
    prisma.showRateBand.findMany({ orderBy: { threshold: 'asc' } }),
    prisma.commissionRule.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);

  /* The service bonuses: a multiplier on the branch pool when a category hits
     its own target AND its share of the mix. They are POLICY, not data — Odoo
     records no such thing — so they are stored and shown here. */
  const departments = await prisma.commissionDepartment.findMany({
    where: { active: true }, orderBy: { sortOrder: 'asc' },
  }).catch(() => []);

  const totalWeight = roles.reduce((t, r) => t + (r.people || 0) * num(r.weight), 0);

  /* The tier label the policy workbook prints — "500K – 750K", "6M+" — rebuilt
     from the bounds rather than stored, so it can never disagree with them. */
  const money = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : `${Math.round(v / 1e3)}K`);
  const tierLabel = (from, to) => (to === null ? `${money(from)}+` : from === 0 ? `< ${money(to)}` : `${money(from)} – ${money(to)}`);

  return {
    version: levels.length ? levels[levels.length - 1].version : null,
    levels: levels.map((l) => ({ level: l.level, from: num(l.fromPct), version: l.version })),
    tiers: pools.map((p) => ({
      label: tierLabel(num(p.revFrom), p.revTo === null ? null : num(p.revTo)),
      tierNo: p.tierNo,
      from: num(p.revFrom),
      to: p.revTo === null ? null : num(p.revTo),
      pools: Array.isArray(p.pools) ? p.pools.map(Number) : [],
    })),
    roles: roles.map((r) => ({ role: r.role, people: r.people, weight: num(r.weight), notes: r.notes || '' })),
    totalWeight,
    gates: gates.map((g) => ({
      role: g.role,
      rate: num(g.rate),
      minBranches: g.minBranches || 0,
      groupAchievement: g.groupPct === null ? null : num(g.groupPct),
      scope: g.scope || '',
      label: g.gateLabel || '',
    })),
    schemes: schemes.map((s) => ({
      id: s.id,
      name: s.name,
      bands: Array.isArray(s.bands) ? s.bands : [],
      hourlyRate: s.hourlyRate === null ? null : num(s.hourlyRate),
      fixedBasic: s.fixedBasic === null ? null : num(s.fixedBasic),
      notes: s.notes || '',
    })),
    doctorSchemes: doctorSchemes.map((d) => ({
      doctorName: d.doctorName,
      schemeId: d.schemeId,
      rateOverride: d.rateOverride === null ? null : num(d.rateOverride),
    })),
    callCentre: {
      rates: ccRates.map((r) => ({ patientType: r.bucket, amount: num(r.bonus), note: r.note || '' })),
      team: ccTeam.map((m) => ({ name: m.name, role: m.role, entity: m.serves || '' })),
      showRates: showRates.map((s) => ({ from: num(s.threshold), bonus: num(s.bonus), label: s.label })),
    },
    rules: rules.map((r) => ({ kind: r.kind, subject: r.subject, treatment: r.treatment, affects: r.affects || '' })),
    departments: departments.map((d) => ({
      key: d.key,
      label: d.label,
      multiplier: d.multiplier === null ? null : num(d.multiplier),
      mixFloor: d.mixFloor === null ? null : num(d.mixFloor),
      mixCap: d.mixCap === null ? null : num(d.mixCap),
      groupMix: d.groupMix === null ? null : num(d.groupMix),
      condition: d.condition || '',
    })),
  };
}

/* --------------------------------------------------------------- period --- */

/**
 * What actually happened in a window.
 *
 * The answer is assembled from two places and says so. Days the live cache
 * covers are read from `Invoice`/`InvoiceLine`; days before it are read from
 * the imported history, which carries the same cuts at day granularity for
 * 2026 and at month granularity before that. A window spanning the join is
 * served from both, and `sources` reports the split so the page can say
 * "part of this range predates the cache" rather than quietly under-reporting.
 */
async function period(from, to) {
  const span = await cacheSpan();
  const cacheLo = span.lo;

  /* Where the window sits relative to the cache. */
  const liveFrom = cacheLo && to >= cacheLo ? (from > cacheLo ? from : cacheLo) : null;
  const liveTo = liveFrom ? to : null;
  const histTo = cacheLo && from < cacheLo ? (to < cacheLo ? to : prevDay(cacheLo)) : (cacheLo ? null : to);
  const histFrom = histTo ? from : null;

  const [live, hist, collected, names] = await Promise.all([
    liveFrom ? liveCut(liveFrom, liveTo) : emptyCut(),
    histFrom ? historyCut(histFrom, histTo) : emptyCut(),
    collectedCut(from, to),
    branchResolver(),
  ]);

  /* Odoo's spelling resolved to the plan's, BEFORE anything is summed, so the
     headline and the rows are built from the same keys. */
  const rekey = (map) => {
    const out = new Map();
    for (const [name, row] of map) {
      const k = names.resolve(name);
      const prev = out.get(k) || { ex: 0, invoices: 0, sources: [] };
      prev.ex += row.ex;
      prev.invoices += row.invoices;
      /* The spelling the invoices are actually filed under. The per-branch
         drilldown queries Odoo by name, so asking for the plan's "Madinty The
         Strip" would return an empty panel for a branch that billed 669,664. */
      if (!prev.sources.includes(name)) prev.sources.push(name);
      out.set(k, prev);
    }
    return out;
  };

  const branches = rekey(mergeMaps(live.branches, hist.branches));
  collected.rows.forEach((r) => { r.branch = names.resolve(r.branch); });
  const doctors = mergeMaps(live.doctors, hist.doctors);
  const products = mergeMaps(live.products, hist.products);
  const groups = mergeMaps(live.groups, hist.groups);

  const billed = sumValues(branches, 'ex');
  const invoices = sumValues(branches, 'invoices');

  return {
    window: { from, to },
    basis: { billed: 'invoiced ex-VAT', collected: 'cash received ex-VAT' },
    sources: {
      live: liveFrom ? { from: liveFrom, to: liveTo } : null,
      history: histFrom ? { from: histFrom, to: histTo } : null,
      cache: span,
      /* True when the reader is looking at a range the sync has not reached.
         The page prints this rather than letting a short cache read as a bad
         month. */
      partial: Boolean(histFrom),
      /* Branch spellings that match nothing in the plan, with what they billed.
         Named rather than dropped: money that is in the total and on no row is
         the failure this field exists to make visible. */
      unmatched: [...names.unmatched.keys()].map((n) => ({
        name: n,
        ex: r2([...branches.entries()].filter(([k]) => k === n).reduce((t, [, v]) => t + v.ex, 0)),
      })),
    },
    totals: {
      billed: r2(billed),
      invoices,
      collected: r2(collected.total),
      collectedRows: collected.rows.length,
    },
    branches: toRows(branches, 'branch'),
    doctors: toRows(doctors, 'doctor'),
    products: toRows(products, 'product'),
    groups: toRows(groups, 'group'),
    collected: collected.rows,
    catchUp: await catchUp(to),
  };
}

/**
 * Month-to-date, to YESTERDAY, for the month a range ends in — but only while
 * that month is still running.
 *
 * This is what lets the report answer "what does a branch have to bill for the
 * REST of the month" rather than "what was this month's target divided evenly".
 * Once a branch is behind, the even split keeps reporting a target it has
 * already missed; the remaining days have to carry the shortfall or the number
 * is a comfort rather than a plan.
 *
 * Yesterday, not today: a day in progress always reads as a collapse, and
 * folding it in would make every morning look like a disaster.
 */
async function catchUp(to) {
  const today = new Date().toISOString().slice(0, 10);
  const month = monthOf(to);
  if (month !== monthOf(today)) return null;

  const first = `${month}-01`;
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  if (yesterday < first) return { month, upto: null, byBranch: {}, note: 'The month has no finished days yet.' };

  const [names, rows] = await Promise.all([
    branchResolver(),
    prisma.$queryRawUnsafe(
      `select coalesce("branchName", '(no branch)') name, sum(${SIGNED_EX})::float ex
         from "Invoice"
        where state = 'posted' and "moveType" in ('out_invoice', 'out_refund')
          and "invoiceDate" between $1::date and $2::date
          ${exclusion('"Invoice"')}
        group by 1`,
      first, yesterday,
    ),
  ]);

  const byBranch = {};
  for (const r of rows) {
    const k = names.resolve(r.name);
    byBranch[k] = r2((byBranch[k] || 0) + (Number(r.ex) || 0));
  }
  return { month, from: first, upto: yesterday, byBranch };
}

const prevDay = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

const emptyCut = () => ({ branches: new Map(), doctors: new Map(), products: new Map(), groups: new Map() });

function bump(map, name, ex, invoices) {
  if (!name) return;
  const row = map.get(name) || { ex: 0, invoices: 0 };
  row.ex += Number(ex) || 0;
  row.invoices += Number(invoices) || 0;
  map.set(name, row);
}

function mergeMaps(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) {
    const row = out.get(k) || { ex: 0, invoices: 0 };
    row.ex += v.ex;
    row.invoices += v.invoices;
    out.set(k, row);
  }
  return out;
}

const sumValues = (map, field) => [...map.values()].reduce((t, r) => t + (r[field] || 0), 0);

const toRows = (map, label) => [...map.entries()]
  .map(([name, r]) => ({
    [label]: name,
    name,
    ex: r2(r.ex),
    invoices: r.invoices,
    /* Present on branch rows only; the drilldown uses it verbatim. */
    ...(r.sources ? { sources: r.sources } : {}),
  }))
  .sort((a, b) => b.ex - a.ex);

/**
 * The live cut: invoiced ex-VAT out of the Odoo cache, by branch, by doctor and
 * by product category. Package-sale journals are excluded the same way the rest
 * of the app excludes them — they are invoiced when sold, carry no VAT, and are
 * not comparable to collections.
 */
async function liveCut(from, to) {
  const out = emptyCut();

  const byBranch = await prisma.$queryRawUnsafe(
    `select coalesce("branchName", '(no branch)') name,
            sum(${SIGNED_EX})::float ex,
            count(*)::int invoices
       from "Invoice"
      where state = 'posted'
        and "moveType" in ('out_invoice', 'out_refund')
        and "invoiceDate" between $1::date and $2::date
        ${exclusion('"Invoice"')}
      group by 1`,
    from, to,
  );
  byBranch.forEach((r) => bump(out.branches, r.name, r.ex, r.invoices));

  const byDoctor = await prisma.$queryRawUnsafe(
    `select coalesce("specialistName", '(no doctor)') name,
            sum(${SIGNED_EX})::float ex,
            count(*)::int invoices
       from "Invoice"
      where state = 'posted'
        and "moveType" in ('out_invoice', 'out_refund')
        and "invoiceDate" between $1::date and $2::date
        ${exclusion('"Invoice"')}
      group by 1`,
    from, to,
  );
  byDoctor.forEach((r) => bump(out.doctors, r.name, r.ex, r.invoices));

  const byProduct = await prisma.$queryRawUnsafe(
    `select coalesce(l."categoryName", 'Other') name,
            sum(${SIGNED_LINE})::float ex,
            count(*)::int invoices
       from "InvoiceLine" l
       join "Invoice" i on i."odooId" = l."invoiceOdooId"
      where i.state = 'posted'
        and i."moveType" in ('out_invoice', 'out_refund')
        and i."invoiceDate" between $1::date and $2::date
        ${exclusion('i')}
      group by 1`,
    from, to,
  );
  byProduct.forEach((r) => {
    bump(out.products, r.name, r.ex, r.invoices);
    bump(out.groups, Tracker.familyOf ? Tracker.familyOf(r.name) : r.name, r.ex, r.invoices);
  });

  return out;
}

/**
 * The history cut: the same four shapes, out of the tables the artifact import
 * filled. Days are available for 2026; before that only months are, so a
 * partial month at the start of a range is apportioned by nothing at all — the
 * whole month is counted when the range touches it, which is why
 * `sources.history` is reported and the page labels those months.
 */
async function historyCut(from, to) {
  const out = emptyCut();

  const days = await prisma.$queryRawUnsafe(
    `select name, sum(ex)::float ex from "HistoryDay"
      where date between $1::date and $2::date group by 1`,
    from, to,
  );
  days.forEach((r) => bump(out.branches, r.name, r.ex, 0));

  const docDays = await prisma.$queryRawUnsafe(
    `select "doctorName" name, sum(ex)::float ex, sum(invoices)::int invoices
       from "HistoryDayDoctor" where date between $1::date and $2::date group by 1`,
    from, to,
  );
  docDays.forEach((r) => bump(out.doctors, r.name, r.ex, r.invoices));

  const prodDays = await prisma.$queryRawUnsafe(
    `select "productType" name, sum(ex)::float ex, sum(invoices)::int invoices
       from "HistoryDayDoctor" where date between $1::date and $2::date group by 1`,
    from, to,
  );
  prodDays.forEach((r) => bump(out.products, r.name, r.ex, r.invoices));

  /* Months the daily table does not cover — anything before 2026 — come from
     the monthly cuts, and only when the range covers the whole month. A half
     month of 2025 is not something this data can answer, and inventing a
     pro-rata would make it look like it could. */
  const covered = new Set(days.map((d) => d.name));
  const wholeMonths = monthsBetween(monthOf(from), monthOf(to)).filter((m) => {
    const first = `${m}-01`;
    const last = `${m}-${String(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
    return from <= first && to >= last && m < '2026-01';
  });

  if (wholeMonths.length) {
    const rows = await prisma.historyMonth.findMany({ where: { period: { in: wholeMonths } } });
    for (const r of rows) {
      if (r.kind === 'branch') bump(out.branches, r.name, num(r.ex), 0);
      if (r.kind === 'product') bump(out.products, r.name, num(r.ex), 0);
      if (r.kind === 'group') bump(out.groups, r.name, num(r.ex), 0);
    }
  }
  if (!covered.size && !wholeMonths.length) return out;

  return out;
}

/**
 * Cash in, by branch. The SAME call the Targets and Commission reports already
 * use — not a second query that agrees today — because the two totals have to
 * be the same money and `scripts/audit.js` asserts it.
 */
async function collectedCut(from, to) {
  try {
    const cash = await Tracker.collectionByBranch(from, to);
    const rows = (cash?.rows || []).map((r) => ({
      branch: r.branch,
      net: r2(r.net),
      gross: r2(r.gross),
      refunds: r2(r.refunds),
      txns: r.txns || 0,
    }));
    return { rows, total: rows.reduce((t, r) => t + r.net, 0) };
  } catch {
    /* No collections loaded is a real state, not an error — the report says so
       on the page rather than failing the whole request. */
    return { rows: [], total: 0 };
  }
}

module.exports = {
  reference, period, loadPolicy, cacheSpan, monthsBetween, daysBetween,
  /* Exported for tgc-odoo.js, which must hand the dashboard the SAME spelling
     this file does. One resolver, or the two disagree and a branch silently
     reads zero against a real target. */
  branchResolver,
};
