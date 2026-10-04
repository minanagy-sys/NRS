/* ============================================================
   What needs doing, ranked, with the figure that makes each one matter.

   ADMIN OPENED ON A LIST OF TARGET SHEETS and said nothing about anything else.
   Everything that had gone quiet was discoverable — the Contact Centre report
   states its own coverage, the Inventory cover tab counts its unlinked
   products, the missing-month card sits on the periods tab — but every one of
   them required somebody to go and look. On 2026-09-13 nobody had, for
   thirteen days, while 7,571,773 of September revenue was scored against a
   target sheet that did not exist.

   So this is the one place that answers "what needs me". Four sources, one
   ranked list, and every row carries three things:

     WHAT is wrong, in a sentence
     WHAT IT COSTS — the measured figure, because "no September sheet" is
       ignorable and "7.5 M scored against nothing" is not
     WHERE TO FIX IT — a tab, and where it exists, the exact control

   SEVERITY IS MEASURED, NOT ASSIGNED. A missing sheet for a month with revenue
   already in it outranks one for a month that has not started, because the
   first is money already unmeasured and the second is a diary entry. The rank
   falls out of the numbers rather than from a table of guesses, which is what
   stops this becoming a wall of amber that everybody scrolls past.
   ============================================================ */

const { prisma } = require('./db.js');
const Feeds = require('./feeds.js');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v));

/* Ordered worst first. `blocking` means a report is showing nothing or lying by
   omission right now; `overdue` means it will become that; `tidy` is work worth
   doing that costs nothing today. */
const SEVERITY = ['blocking', 'overdue', 'tidy'];
const rank = (s) => SEVERITY.indexOf(s);

/** "2026-09" for a Date. */
const periodOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** "2026-09" -> "2026-10", December rolling the year. */
function nextPeriod(p) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(p || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

const monthName = (p) => new Date(`${p}-01T00:00:00Z`)
  .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Every target period that ought to exist and does not.
 *
 * Only ever the CURRENT month and the NEXT one. A report cannot score a month
 * that has not started and nobody sets targets a year out, so listing every
 * gap back to January would bury the one row that matters under eight that do
 * not.
 */
async function periods(now) {
  const items = [];
  const thisP = periodOf(now);
  const nextP = nextPeriod(thisP);

  const [published, drafts] = await Promise.all([
    prisma.targetPeriod.findMany({ select: { period: true }, orderBy: { period: 'asc' } }),
    prisma.targetDraft.findMany({ select: { period: true, savedAt: true } }),
  ]);
  const have = new Set(published.map((p) => p.period));
  const draftOf = new Map(drafts.map((d) => [d.period, d]));
  const newest = published.length ? published[published.length - 1].period : null;

  for (const [p, when] of [[thisP, 'current'], [nextP, 'next']]) {
    if (have.has(p)) continue;

    /* The figure that makes it real: revenue already booked into a month with
       no target. For next month this is zero and the row says so rather than
       pretending there is a cost. */
    const agg = await prisma.invoice.aggregate({
      where: {
        moveType: 'out_invoice',
        invoiceDate: { gte: new Date(`${p}-01`), lt: new Date(`${nextPeriod(p)}-01`) },
      },
      _count: true,
      _sum: { amountUntaxed: true },
    });
    const ex = r2(agg._sum.amountUntaxed);
    const draft = draftOf.get(p);

    items.push({
      key: `period:${p}`,
      severity: when === 'current' && agg._count > 0 ? 'blocking' : 'overdue',
      title: `${monthName(p)} has no approved target sheet`,
      cost: agg._count
        ? `${ex.toLocaleString('en-US')} EGP ex-VAT across ${agg._count.toLocaleString('en-US')} invoices is already booked into it, and none of it is scored against anything.`
        : 'Nothing is booked into it yet — setting it now is the cheap moment.',
      detail: draft
        ? `A draft was saved ${new Date(draft.savedAt).toISOString().slice(0, 10)}. It has not been published, so no report reads it.`
        : newest
          ? `Start it from ${newest}: the roster, the groups and the branch figures carry across and every target arrives blank.`
          : 'No sheet has ever been published, so there is nothing to carry from.',
      metric: { invoices: agg._count, ex },
      hasDraft: !!draft,
      period: p,
      action: { tab: 'periods', carryFrom: newest, resume: draft ? p : null },
    });
  }
  return items;
}

/** Feeds past their declared cadence, or never fed at all. */
async function feeds(now) {
  const rows = await Feeds.read(now);
  return rows
    /* `targets` is deliberately skipped. It IS a hand-fed feed and it belongs in
       feeds.js so the picture of every input stays whole — but `periods()`
       already reports it, by month and with the revenue riding on it. Two rows
       for one problem, one of which only says "32 days old", is how a list
       starts being scrolled past. */
    .filter((f) => f.key !== 'targets')
    .filter((f) => f.error || f.empty || f.late)
    .map((f) => ({
      key: `feed:${f.key}`,
      /* A feed nobody has ever sent is blocking — the report section it fills
         is absent, not stale. A late one is overdue: what is on screen is real,
         just old. */
      severity: f.error ? 'blocking' : f.empty ? 'blocking' : 'overdue',
      title: f.empty ? `${f.label} has never been loaded`
        : f.error ? `${f.label} could not be read`
          : `${f.label} is ${f.ageDays} days old`,
      cost: f.breaks,
      detail: `${f.why} ${f.howTo}.`,
      metric: { rows: f.rows, ageDays: f.ageDays, allowanceDays: f.allowanceDays },
      source: f.source,
      action: { tab: f.source === Feeds.HAND ? 'data' : null, feed: f.key },
    }));
}

/**
 * Mappings that resolve to nothing.
 *
 * None of these break a page. They quietly shrink what a page can see, which is
 * worse — an unlinked consumable does not error, it reports "Not linked" and
 * leaves its sales invisible.
 */
async function mappings() {
  const items = [];

  /* ---- consumables with no service behind them ---- */
  const [products, linkRows] = await Promise.all([
    prisma.consumable.findMany({ select: { odooId: true, name: true } }),
    prisma.consumableLink.findMany({ select: { consumableOdooId: true } }),
  ]);
  const have = new Set(products.map((p) => p.odooId));
  const linked = new Set(linkRows.map((l) => l.consumableOdooId).filter((x) => x != null));
  const unlinked = products.filter((p) => !linked.has(p.odooId));
  const dangling = linkRows.filter((l) => l.consumableOdooId == null || !have.has(l.consumableOdooId)).length;

  if (unlinked.length) {
    items.push({
      key: 'map:consumables',
      severity: 'tidy',
      title: `${unlinked.length} consumables have no service linked to them`,
      cost: 'Inventory cannot see a single sale of these products, so their cover reads as unknown and the movement ledger cannot explain what left the shelf.',
      detail: `${products.length} products, ${linkRows.length} links${dangling ? `, ${dangling} of which point at a product the catalogue does not have` : ''}. `
        + `Examples: ${unlinked.slice(0, 4).map((p) => p.name).join(', ')}.`,
      metric: { unlinked: unlinked.length, products: products.length, links: linkRows.length, dangling },
      action: { tab: 'mapping' },
    });
  }

  /* ---- doctors on the sheet that no Odoo name matches, and the reverse ----

     Scored with `Targets.score`, which is the function the reports use. It
     already resolves aliases and returns `unresolved` and `offSheet`; matching
     names again here would be a second copy of the rules, free to disagree with
     the report it is supposed to be describing. */
  const Targets = require('./targets.js');
  const Report = require('./report.js');
  const latest = await prisma.targetPeriod.findFirst({
    select: { period: true }, orderBy: { period: 'desc' },
  });
  if (latest) {
    const sheet = await Targets.loadPeriod(latest.period);
    const from = `${latest.period}-01`;
    const to = `${latest.period}-${new Date(Date.UTC(
      Number(latest.period.slice(0, 4)), Number(latest.period.slice(5, 7)), 0,
    )).getUTCDate()}`;
    const mtd = await Report.buildReport(from, to, {
      excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS,
    });
    const scored = Targets.score(sheet, {
      mtd, range: mtd, to, rangeDays: Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1,
    });

    if (scored.unresolved && scored.unresolved.length) {
      items.push({
        key: 'map:doctors',
        severity: 'tidy',
        title: `${scored.unresolved.length} doctors on the ${latest.period} sheet match no Odoo name`,
        cost: 'Their target counts inside the group total but nothing they invoice is measured against it, so the group reads as behind when it may not be.',
        detail: `Pair each to an Odoo name in Mapping. ${scored.unresolved.slice(0, 4).map((u) => u.name || u).join(', ')}`
          + `${scored.unresolved.length > 4 ? `, and ${scored.unresolved.length - 4} more` : ''}.`,
        metric: { unresolved: scored.unresolved.length, onSheet: sheet.doctors.length },
        action: { tab: 'mapping' },
      });
    }

    /* The reverse: invoicing with no approved target. Their revenue is real and
       sits in no group total, so every group percentage is computed over a
       smaller book than the clinic actually billed. */
    const offSheet = (scored.offSheet || []).filter((d) => d.name !== 'Unassigned');
    if (offSheet.length) {
      const ex = r2(offSheet.reduce((t, d) => t + num(d.ex), 0));
      items.push({
        key: 'map:offsheet',
        severity: 'tidy',
        title: `${offSheet.length} doctors invoiced in ${latest.period} with no approved target`,
        cost: `${ex.toLocaleString('en-US')} EGP ex-VAT sits outside every group total.`,
        detail: 'Either give them a target on the next sheet — Export carries them across — or record that they are deliberately off it. '
          + offSheet.slice(0, 4).map((d) => d.name).join(', ') + '.',
        metric: { offSheet: offSheet.length, ex },
        action: { tab: 'periods' },
      });
    }
  }

  return items;
}

/** The commission year, which runs out all at once rather than gradually. */
async function commission(now) {
  const items = [];
  const year = now.getUTCFullYear();
  const [thisYear, nextYear, branches] = await Promise.all([
    prisma.commissionTarget.count({ where: { year } }),
    prisma.commissionTarget.count({ where: { year: year + 1 } }),
    prisma.commissionBranch.count({ where: { active: true } }),
  ]);

  /* Raised in the last quarter, not in January: a year of branch targets is a
     budgeting exercise, and flagging it eleven months early trains people to
     ignore the panel. */
  const monthsLeft = 12 - (now.getUTCMonth() + 1);
  if (thisYear > 0 && nextYear === 0 && monthsLeft <= 3) {
    items.push({
      key: `commission:${year + 1}`,
      severity: 'overdue',
      title: `No commission targets for ${year + 1}`,
      cost: `The Targets report scores ${branches} branches against a monthly figure. On 1 January it will have none.`,
      detail: `${year} holds ${thisYear} branch-months. ${monthsLeft} month${monthsLeft === 1 ? '' : 's'} left to set ${year + 1}.`,
      metric: { thisYear, nextYear, branches, monthsLeft },
      action: { tab: 'commission' },
    });
  }
  return items;
}

/**
 * The plan and the payslips.
 *
 * Three things that go quiet rather than loud, each one found the hard way:
 *
 *   A branch with no 2027 target reads as a branch at 0% of plan, which looks
 *   like a failing branch rather than a missing decision.
 *
 *   A doctor on the plan whose name reaches no invoice and no scheme earns a
 *   target nobody can be measured against. Names here are never paired by
 *   similarity — "Dr.Merna Masoud" and "Dr.Merna Ashraf" are one edit apart and
 *   are different people.
 *
 *   A doctor with commission and no payroll row gets no payslip. For the three
 *   on schemes that do not count hours, nobody records attendance BY DESIGN, so
 *   they are missing from the file every single month and the tab shows 1.4 M
 *   of commission with no payslip behind it. The fix is a row in the payroll
 *   sheet, which is why this says so rather than quietly paying them.
 */
async function planChecks(now) {
  const items = [];
  const year = now.getUTCFullYear();

  /* ---- branches with nothing planned for next year ---- */
  const [branches, planned] = await Promise.all([
    prisma.commissionBranch.findMany({ where: { active: true }, select: { id: true, name: true } }),
    prisma.commissionTarget.groupBy({ by: ['branchId'], where: { year: year + 1 }, _count: true }),
  ]);
  const have = new Map(planned.map((p) => [p.branchId, p._count]));
  const bare = branches.filter((b) => !have.get(b.id));
  if (branches.length && have.size && bare.length) {
    items.push({
      key: 'plan:branches',
      severity: 'overdue',
      title: `${bare.length} branch${bare.length === 1 ? ' has' : 'es have'} no ${year + 1} target`,
      cost: `${have.size} of ${branches.length} branches are planned. The rest will score as 0% of plan, `
        + 'which reads as a failing branch rather than a missing decision.',
      detail: bare.map((b) => b.name).join(', '),
      metric: { planned: have.size, branches: branches.length, bare: bare.length },
      action: { tab: 'periods' },
    });
  }

  /* ---- plan doctors who reach nothing ---- */
  const [planDocs, billed, schemed] = await Promise.all([
    prisma.doctorPlanMonth.findMany({ distinct: ['doctorName'], select: { doctorName: true } }),
    prisma.invoice.groupBy({ by: ['specialistName'], where: { moveType: 'out_invoice', specialistName: { not: null } } }),
    prisma.doctorScheme.findMany({ select: { doctorName: true } }),
  ]);
  const known = new Set([
    ...billed.map((b) => String(b.specialistName).trim().toLowerCase()),
    ...schemed.map((d) => d.doctorName.trim().toLowerCase()),
  ]);
  const ghosts = planDocs.map((d) => d.doctorName).filter((n) => !known.has(n.trim().toLowerCase()));
  if (planDocs.length && ghosts.length) {
    items.push({
      key: 'plan:doctors',
      severity: ghosts.length > 5 ? 'overdue' : 'soon',
      title: `${ghosts.length} doctor${ghosts.length === 1 ? '' : 's'} on the plan match no Odoo name`,
      cost: 'They carry a target nobody can be measured against, and they will never appear on a '
        + 'target-vs-achieved row.',
      detail: ghosts.slice(0, 10).join(', ') + (ghosts.length > 10 ? `, and ${ghosts.length - 10} more` : ''),
      metric: { planned: planDocs.length, unmatched: ghosts.length },
      action: { tab: 'mapping' },
    });
  }

  /* ---- commission earned with no payroll row behind it ---- */
  /* THE LATEST MONTH ACTUALLY LOADED, not the current one. Keyed to the calendar
     month this fired on nothing at all: payroll arrives days into the following
     month, so the current month is empty almost all of the time and the check
     slept through every month that had a gap in it. */
  const latestPay = await prisma.doctorPayrollMonth.findFirst({
    orderBy: { period: 'desc' }, select: { period: true },
  });
  const period = latestPay ? latestPay.period : null;
  const [payroll, assigned] = await Promise.all([
    period
      ? prisma.doctorPayrollMonth.findMany({ where: { period }, select: { doctorName: true } })
      : Promise.resolve([]),
    prisma.doctorScheme.findMany({
      where: { active: true, schemeId: { not: null } },
      include: { scheme: { select: { hourlyRate: true, fixedBasic: true } } },
    }),
  ]);
  if (payroll.length) {
    const paid = new Set(payroll.map((p) => p.doctorName.trim().toLowerCase()));
    /* The ones whose scheme does not count hours are the ones nobody thinks to
       put in an attendance sheet — named separately, because for them the
       absence is systematic rather than an oversight. */
    const missing = assigned.filter((d) => !paid.has(d.doctorName.trim().toLowerCase()));
    const noHours = missing.filter((d) => d.scheme && d.scheme.hourlyRate == null
      && d.scheme.fixedBasic != null);
    if (noHours.length) {
      items.push({
        key: `payroll:nohours:${period}`,
        severity: 'overdue',
        title: `${noHours.length} doctor${noHours.length === 1 ? '' : 's'} on a no-hours scheme `
          + `${noHours.length === 1 ? 'is' : 'are'} missing from the ${period} payroll`,
        cost: 'Their schemes do not count hours, so nobody records their attendance and they are '
          + 'absent from the file every month — which means no payslip at all, however much '
          + 'commission they earned.',
        detail: `${noHours.map((d) => d.doctorName).join(', ')}. Add them to the payroll sheet with `
          + 'hours left blank, so deductions and adjustments have somewhere to live.',
        metric: { period, missing: noHours.length, loaded: payroll.length },
        action: { tab: 'data' },
      });
    }
  }

  return items;
}

/**
 * Everything, ranked.
 *
 *   build() -> { at, items, counts, clean }
 *
 * A source that throws contributes one row saying so rather than taking the
 * panel down with it — a status page whose job is to report problems must not
 * be the thing that hides one.
 */
async function build(at = new Date()) {
  /* A panel whose job is to report problems must not become one. An unusable
     date reaching `toISOString()` at the end throws AFTER every check has run,
     losing the whole list to a bad argument. */
  const now = Number.isFinite(new Date(at).getTime()) ? new Date(at) : new Date();

  const sources = [
    ['periods', periods], ['feeds', feeds], ['mappings', mappings], ['commission', commission],
    ['plan', planChecks],
  ];
  const items = [];
  for (const [name, fn] of sources) {
    try {
      items.push(...await fn(now));
    } catch (e) {
      items.push({
        key: `error:${name}`,
        severity: 'blocking',
        title: `The ${name} check could not run`,
        cost: 'Whatever it would have found is not on this list.',
        detail: e.message,
        metric: {},
        action: {},
      });
    }
  }

  items.sort((a, b) => rank(a.severity) - rank(b.severity)
    || num(b.metric && b.metric.ex) - num(a.metric && a.metric.ex)
    || String(a.key).localeCompare(String(b.key)));

  const counts = Object.fromEntries(SEVERITY.map((s) => [s, items.filter((i) => i.severity === s).length]));
  return {
    at: now.toISOString(),
    items,
    counts,
    clean: items.length === 0,
  };
}

module.exports = { build, periods, feeds, mappings, commission, nextPeriod, periodOf, SEVERITY };
