/* ============================================================
   Appointments — the middle of the commercial funnel.

   `states` is the whole report. Three groups, and the third is the interesting
   one:

     ATTENDED  the patient came      done · done_with_due · payment_received ·
                                     checked_in · in_process
     LOST      they did not          cancel · rescheduled · no_show
     OPEN      nobody recorded       pending · confirm · assessment · waiting ·
                                     waiting_for_advance_payment ·
                                     discount_approval

   OPEN is not "did not attend". 1,773 of 7,655 bookings in 1-19 August sit in
   `pending` with no outcome written back, which is 23% of the month missing from
   every attendance measure — including the one the commission policy pays a
   10,000/20,000 team bonus on. Counting them as no-shows would understate the
   show rate; counting them as attended would overstate it. They are reported as
   their own number, and the show rate is given twice: once on all bookings, once
   on the ones that were actually resolved.
   ============================================================ */

const { prisma } = require('./db.js');

/* Odoo 18 went live on this date. Everything before it is migrated data, and the
   migration set every historical appointment to `done`: January, February and
   March hold exactly one state between them, 12,344 bookings, all "attended".
   That is not a 100% show rate, it is an import default, and a funnel computed
   across the cutover reads as a collapse in performance on 1 August when in fact
   it is the first month with real outcomes.

   So the show rate is refused before this date rather than reported. `reportable`
   carries the verdict and `preCutover` counts what was excluded, because a silent
   filter is how a report ends up quietly answering a different question than the
   one on its heading. */
const ODOO18_LIVE = '2026-08-01';

const ATTENDED = ['done', 'done_with_due', 'payment_received', 'checked_in', 'in_process'];
const LOST = ['cancel', 'rescheduled', 'no_show'];
const OPEN = ['pending', 'confirm', 'assessment', 'waiting', 'waiting_for_advance_payment', 'discount_approval', 'medical_info'];

/* The show rate the commission policy assumes when it pays its attendance bonus.
   Named and exported so the page, the sync script and the tests all quote the
   same figure — the policy PDF is the only source for it. */
const POLICY_FLOOR = 0.75;

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
/* Anything unlisted falls to OPEN, deliberately: an unrecognised state is a
   booking whose outcome we do not know, and OPEN is the group that is reported
   separately rather than folded into a rate. It must never fall to ATTENDED —
   a new Odoo state would then silently inflate the show rate. `no_show` is the
   reason this is spelled out: it is a real state with zero rows in August, so it
   sat in OPEN unnoticed while meaning the opposite of unresolved. */
const group = (state) => (ATTENDED.includes(state) ? 'attended' : LOST.includes(state) ? 'lost' : 'open');

/** Booked, attended, lost and unresolved for a window, plus the same per branch
 *  and per specialist. */

/** Unresolved bookings by service category. */
async function openByService({ effFrom, to }) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(c.cat, '(no service recorded)') AS category, COUNT(*)::int AS count
      FROM "Appointment" a
      LEFT JOIN LATERAL unnest(
        CASE WHEN cardinality(a.categories) > 0 THEN a.categories ELSE ARRAY[NULL]::text[] END
      ) AS c(cat) ON TRUE
     WHERE a.date >= $1::date AND a.date <= $2::date AND a.states = ANY($3::text[])
     GROUP BY 1 ORDER BY 2 DESC`, effFrom, to, OPEN);

  const total = await prisma.appointment.count({
    where: {
      date: { gte: new Date(`${effFrom}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      states: { in: OPEN },
    },
  });
  const noService = (rows.find((r) => r.category === '(no service recorded)') || {}).count || 0;
  return {
    total,
    noService,
    noServiceShare: total ? noService / total : 0,
    /* A booking with two categories appears under both, so these add above the
       total. Stated, not normalised. */
    overlapping: true,
    rows: rows.map((r) => ({ category: r.category, count: r.count, share: total ? r.count / total : 0 })),
  };
}


/** Whether the unresolved queue can actually be worked. */
async function openQuality({ effFrom, to }) {
  const where = {
    date: { gte: new Date(`${effFrom}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    states: { in: OPEN },
  };
  const [total, withMobile, withService] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.count({ where: { ...where, mobileKey: { not: null } } }),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "Appointment"
        WHERE date >= $1::date AND date <= $2::date AND states = ANY($3::text[])
          AND cardinality(categories) > 0`, effFrom, to, OPEN).then((r) => (r[0] || {}).n || 0),
  ]);
  return {
    total, withMobile, withService,
    mobileShare: total ? withMobile / total : 0,
    serviceShare: total ? withService / total : 0,
  };
}

async function buildFunnel({ from, to }) {
  /* Clamp to the cutover rather than filtering silently: the caller asked for a
     window and gets told what was actually measured. */
  const effFrom = from < ODOO18_LIVE ? ODOO18_LIVE : from;
  const reportable = to >= ODOO18_LIVE;
  const where = { date: { gte: new Date(`${effFrom}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } };
  const preCutover = effFrom === from ? 0 : await prisma.appointment.count({
    where: { date: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${ODOO18_LIVE}T00:00:00Z`) } },
  });

  const [byState, byBranch, bySpecialist, byCreator, byCancel, total] = await Promise.all([
    prisma.appointment.groupBy({ by: ['states'], where, _count: true }),
    prisma.appointment.groupBy({ by: ['branchName', 'states'], where, _count: true }),
    /* Branch is on these two cuts ONLY so the entity filter can reach them. It is
       not decoration: without it the specialist and creator tables sit in a panel
       whose branch table filters, and they do not — switching to ZAT left every
       doctor and every booking desk on screen unchanged, which reads as a broken
       control rather than as "these are group-wide". */
    prisma.appointment.groupBy({ by: ['specialistName', 'branchName', 'states'], where, _count: true }),
    prisma.appointment.groupBy({ by: ['createdBy', 'branchName'], where, _count: true }),
    prisma.appointment.groupBy({ by: ['cancelReason'], where: { ...where, states: 'cancel' }, _count: true }),
    prisma.appointment.count({ where }),
  ]);

  const states = byState.map((s) => ({ state: s.states, group: group(s.states), count: s._count }))
    .sort((a, b) => b.count - a.count);
  const tally = (rows) => rows.reduce((acc, r) => {
    acc.booked += r.count; acc[r.group] += r.count; return acc;
  }, { booked: 0, attended: 0, lost: 0, open: 0 });
  const totals = tally(states);

  /* Two honest denominators rather than one flattering number. */
  const showRate = totals.booked ? totals.attended / totals.booked : 0;
  const resolved = totals.attended + totals.lost;
  const showRateResolved = resolved ? totals.attended / resolved : 0;

  const roll = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const name = r[key] || 'Unassigned';
      const g = group(r.states);
      const cur = m.get(name) || { name, booked: 0, attended: 0, lost: 0, open: 0 };
      cur.booked += r._count; cur[g] += r._count;
      m.set(name, cur);
    }
    return [...m.values()].map((x) => ({
      ...x,
      showRate: x.booked ? x.attended / x.booked : 0,
      openShare: x.booked ? x.open / x.booked : 0,
    })).sort((a, b) => b.booked - a.booked);
  };

  return {
    from, to, booked: total,
    /* What was measured, which is not always what was asked for. */
    measuredFrom: effFrom,
    cutover: ODOO18_LIVE,
    reportable,
    preCutover,
    totals, showRate, showRateResolved,
    /* The policy's KPI floor, so the page can say how far off it is. */
    policyFloor: POLICY_FLOOR,
    states,
    /* Unresolved bookings split by the service they were booked for, with the
       share carrying no service reported rather than divided away: 36% of open
       bookings have no category against 0% of attended ones, which is itself the
       finding — the bookings nobody finished are the bookings nobody filled in. */
    openByService: await openByService({ from, to: to, effFrom }),
    /* How workable the unresolved queue is. Report 04 leads its unresolved
       section with these three, and they are the difference between "a report"
       and "a call list": a row with no mobile cannot be chased, and a row with no
       service cannot be prepared for. */
    openQuality: await openQuality({ effFrom, to }),
    branches: roll(byBranch, 'branchName'),
    /* Aggregated for the unfiltered view, and kept per-branch beside it so a
       scope can re-aggregate. A specialist working across both entities appears
       under each, which is the truth about that specialist. */
    specialists: roll(bySpecialist, 'specialistName'),
    specialistRows: bySpecialist.map((r) => ({
      name: r.specialistName || 'Unassigned',
      branch: r.branchName || 'Unassigned',
      group: group(r.states),
      count: r._count,
    })),
    creators: byCreator.reduce((acc, c) => {
      const name = c.createdBy || 'Unassigned';
      const hit = acc.find((x) => x.name === name);
      if (hit) hit.count += c._count; else acc.push({ name, count: c._count });
      return acc;
    }, []).sort((a, b) => b.count - a.count),
    creatorRows: byCreator.map((c) => ({
      name: c.createdBy || 'Unassigned',
      branch: c.branchName || 'Unassigned',
      count: c._count,
    })),
    cancelReasons: byCancel.map((c) => ({ reason: c.cancelReason || '(none given)', count: c._count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** The unresolved queue — the bookings with no outcome, and what is missing from
 *  them. `mobileKey` is the last ten digits only; nothing here exposes a number. */
/**
 * The unresolved queue.
 *
 * `reveal` decides whether patient names and full mobile numbers come back.
 * Default is masked, and callers have to ask for the rest — because most things
 * that want this list want the SHAPE of it (how many, which branch, which
 * service) and have no business holding the contact details.
 *
 * The one caller that does ask is the Commercial report's call list, and there
 * the mobile is the entire point: a queue of 2,369 bookings nobody can ring is a
 * report, not a work item. Report 04 makes the same call and prints its own
 * warning beside the table; this returns `sensitive: true` so the page has to
 * carry that warning rather than choosing not to.
 *
 * The mobile is rendered back to Egypt's local form — `mobileKey` is the
 * normalised ten digits, and 01090573746 is what somebody dials.
 */
async function buildPending({ from, to, branch, reveal = false, take = 3000 }) {
  const where = {
    date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    states: { in: OPEN },
    ...(branch && branch !== 'all' ? { branchName: branch } : {}),
  };
  const [rows, total, noMobile, noSpecialist] = await Promise.all([
    prisma.appointment.findMany({
      where,
      select: {
        odooId: true, date: true, states: true, branchName: true,
        specialistName: true, createdBy: true, createdAt: true, mobileKey: true,
        invoiceTotal: true, categories: true,
        ...(reveal ? { partnerName: true, name: true } : {}),
      },
      orderBy: [{ date: 'asc' }, { odooId: 'asc' }],
      take,
    }),
    prisma.appointment.count({ where }),
    prisma.appointment.count({ where: { ...where, mobileKey: null } }),
    prisma.appointment.count({ where: { ...where, specialistName: null } }),
  ]);
  return {
    total, returned: rows.length, noMobile, noSpecialist,
    sensitive: !!reveal,
    rows: rows.map((r) => {
      const out = {
        odooId: r.odooId,
        date: r.date.toISOString().slice(0, 10),
        states: r.states,
        branchName: r.branchName,
        specialistName: r.specialistName,
        createdBy: r.createdBy,
        createdAt: r.createdAt ? r.createdAt.toISOString().slice(0, 16).replace('T', ' ') : null,
        invoiceTotal: r.invoiceTotal === null ? null : Number(r.invoiceTotal),
        /* Empty is common and is not the same as "no service": 36% of unresolved
           bookings carry none at all. */
        service: (r.categories || []).join(', ') || null,
      };
      if (reveal) {
        out.patient = r.partnerName || r.name || null;
        out.mobile = r.mobileKey ? `0${r.mobileKey}` : null;
      } else {
        out.mobileTail = r.mobileKey ? `\u2022\u2022\u2022 ${r.mobileKey.slice(-4)}` : null;
      }
      return out;
    }),
  };
}

module.exports = { buildFunnel, buildPending, openByService, openQuality, ATTENDED, LOST, OPEN, group, POLICY_FLOOR, ODOO18_LIVE };
