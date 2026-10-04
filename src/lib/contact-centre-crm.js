/* ============================================================
   Contact Centre — the half that is about people.

   The PBX half of this report (src/lib/contact-centre.js) can say 2,456 calls
   were answered and cannot say by whom. Five shared Odoo logins stand between
   67 real people and every record they touch, so `create_uid` names a desk, not
   a person. These sections read the frozen October snapshot, which got past
   that by taking the `Employee:` line out of the first "Record created" chatter
   message on each record.

   EVERY FIGURE HERE IS FROZEN. The snapshot covers 1–30 September for
   opportunities, 1 September – 3 October for leads, and 26 September – 10
   October for appointments — three different windows, and each section says
   which one it is answering for rather than quietly intersecting them.

   WHAT IT REFUSES. Five things the export structurally does not carry: lead
   source, the person behind an activity, the person behind a re-booking, the
   branch-follow-up team, and the system booking source. Each is refused BY NAME
   with the reason, because an empty table reads as "nobody did this" when it
   means "this export did not carry it". The seeder measures all five and
   records them in DataUpload.notes; nothing here is hardcoded.
   ============================================================ */

const { prisma } = require('./db.js');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const day = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00.000Z`);

/** Null on a zero denominator, never 0 — "no bookings yet" is not "0%". */
const pct = (a, b) => (b ? r2(a / b) : null);

/* The policy show-rate floor the page colours against. The commission policy
   pays from it, which is why it is a constant and not a style choice. */
const FLOOR = 0.75;

/* Brand membership by branch NAME, from the file's own ZATB at line 500. It is
   not an Odoo company field: ZAT branches sit on the same company, which is why
   the snapshot's own notice says ZAT opportunities are absent. Golden Square is
   here because the file lists it; it has no revenue until April 2027. */
const ZAT_BRANCHES = new Set(['Madinity', 'El Rehab', 'Golden Square']);

/* ------------------------------------------------------- the lookups ------ */

/**
 * Every lookup array, as kind -> [name].
 *
 * Loaded once per build and passed down. The records are index-compressed and
 * meaningless without this, so a missing lookup is a refusal rather than a row
 * of nulls.
 */
async function lookups() {
  const rows = await prisma.ccLookup.findMany({ orderBy: [{ kind: 'asc' }, { idx: 'asc' }] });
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.kind)) by.set(r.kind, []);
    by.get(r.kind)[r.idx] = r.value;
  }
  const name = (kind, idx) => {
    if (idx == null || idx < 0) return null;
    const arr = by.get(kind);
    return (arr && arr[idx]) || null;
  };
  return { by, name, loaded: rows.length > 0 };
}

/* ------------------------------------------------------ the windows ------- */

/**
 * What the seeded snapshot covers, per dataset.
 *
 * Three different spans, deliberately kept apart. Intersecting them would give
 * one window that is wrong for all three — appointments run a week past the
 * last opportunity, because the point of a confirmation-call report is the
 * bookings that have not happened yet.
 */
async function ccCoverage() {
  const [opp, appt, lead, upload] = await Promise.all([
    prisma.ccOpportunity.aggregate({ _min: { date: true }, _max: { date: true }, _count: { _all: true } }),
    prisma.ccAppointment.aggregate({ _min: { date: true }, _max: { date: true }, _count: { _all: true } }),
    prisma.ccLead.aggregate({ _min: { date: true }, _max: { date: true }, _count: { _all: true } }),
    prisma.dataUpload.findFirst({ where: { kind: 'cc:seed' }, orderBy: { createdAt: 'desc' } }),
  ]);
  const span = (a) => (a._count._all
    ? { from: ymd(a._min.date), to: ymd(a._max.date), rows: a._count._all }
    : { from: null, to: null, rows: 0 });
  return {
    opportunities: span(opp),
    appointments: span(appt),
    leads: span(lead),
    /* The page the snapshot came from hardcodes "Snapshot 1 Oct" in two places
       and is wrong by two days. This is the real timestamp, from the import. */
    snapshot: upload ? (/snapshot ([0-9: -]+)/.exec(upload.notes || '') || [])[1] || null : null,
    loadedAt: upload ? upload.createdAt : null,
    notes: upload ? (upload.notes || '').split('\n').filter((l) => l.startsWith('GAP ')) : [],
  };
}

/**
 * The asked-for range against what one dataset actually holds.
 *
 * Same contract as the PBX `overlap()`: `{any, from, to, full, note}`, and
 * `any:false` means the report draws a sentence rather than a chart of zeros.
 */
function ccWindow(from, to, span, what) {
  if (!span.from || !span.to) {
    return { any: false, from: null, to: null, full: false, note: `No ${what} have been loaded.` };
  }
  const lo = from > span.from ? from : span.from;
  const hi = to < span.to ? to : span.to;
  if (lo > hi) {
    return {
      any: false, from: null, to: null, full: false,
      note: `The snapshot holds ${what} for ${span.from} → ${span.to} and this range does not `
        + 'touch it. Nothing can be said for these dates — the export does not cover them, so a '
        + 'zero here would be a claim that nothing happened.',
    };
  }
  const full = lo === from && hi === to;
  return {
    any: true,
    from: lo,
    to: hi,
    full,
    note: full ? null
      : `The snapshot holds ${what} for ${span.from} → ${span.to}, so these figures are for `
        + `${lo} → ${hi} rather than the ${from} → ${to} you asked for.`,
  };
}

/* ------------------------------------------------- 01 · the summary ------- */

/**
 * The opportunity aggregate, from the file's `agg()` at line 506.
 *
 * TWO THINGS HERE ARE NOT THE OBVIOUS CHOICE AND BOTH ARE DELIBERATE.
 *
 * The show-rate denominator is `booked − upcoming`, not `booked`. A booking for
 * next Tuesday has not failed to show up; counting it as a miss would make
 * every agent look worse the more they booked.
 *
 * `showed` is a PATIENT match and it BEATS the appointment status. If the
 * patient was found on any attended visit on or after the opportunity was
 * created, they showed — even if this particular booking says cancelled,
 * because a patient who rebooked and walked in did not fail to arrive.
 * `ownBooking` is the stricter test: the booking itself was attended. The gap
 * between the two is credit the agent lost, and it is the single most useful
 * number on this page.
 */
function aggregate(rows) {
  const a = {
    n: 0, booked: 0, noBooking: 0, upcoming: 0, showed: 0,
    cancelled: 0, noShow: 0, revenue: 0, ownBooking: 0,
  };
  for (const r of rows) {
    a.n += 1;
    if (r.outcome === 0) { a.noBooking += 1; continue; }
    a.booked += 1;
    if (r.showed) { a.showed += 1; a.revenue += Number(r.revenue || 0); }
    else if (r.outcome === 4) a.upcoming += 1;
    else if (r.outcome === 3) a.cancelled += 1;
    else a.noShow += 1;
    if (r.outcome === 1) a.ownBooking += 1;
  }
  a.past = a.booked - a.upcoming;
  a.bookingRate = pct(a.booked, a.n);
  a.showRate = pct(a.showed, a.past);
  a.revenue = r2(a.revenue);
  /* Named rather than left for a reader to subtract. */
  a.lostCredit = a.showed - a.ownBooking;
  return a;
}

/** Every opportunity in range, with its names resolved. */
async function opportunityRows({ from, to, scope, L }) {
  const rows = await prisma.ccOpportunity.findMany({
    where: { date: { gte: day(from), lte: day(to) } },
    orderBy: { date: 'asc' },
  });
  return rows.map((r) => ({
    ...r,
    dateStr: ymd(r.date),
    person: L.name('E', r.personIdx),
    branch: L.name('B', r.branchIdx),
    dept: L.name('P', r.deptIdx),
    doctor: L.name('D', r.doctorIdx),
    login: L.name('LG', r.loginIdx),
  })).filter((r) => scopeOk(r.branch, scope));
}

function scopeOk(branch, scope) {
  if (!scope || scope === 'all') return true;
  const isZat = ZAT_BRANCHES.has(branch);
  return scope === 'ZAT' ? isZat : !isZat;
}

async function summary({ from, to, scope = 'all', cov, L }) {
  const win = ccWindow(from, to, cov.opportunities, 'contact-centre opportunities');
  if (!win.any) return { window: win, totals: null, outcomes: [], hours: [], days: [] };

  const rows = await opportunityRows({ from: win.from, to: win.to, scope, L });
  const totals = aggregate(rows);

  const OUTCOMES = [
    [0, 'No booking'], [1, 'Attended'], [2, 'Not closed'], [3, 'Cancelled'], [4, 'Upcoming'],
  ];
  const outcomes = OUTCOMES.map(([code, label]) => {
    const n = rows.filter((r) => r.outcome === code).length;
    return { code, label, n, share: pct(n, rows.length) };
  });

  const byHour = new Map();
  const byDay = new Map();
  for (const r of rows) {
    byHour.set(r.hour, (byHour.get(r.hour) || 0) + 1);
    if (!byDay.has(r.dateStr)) byDay.set(r.dateStr, []);
    byDay.get(r.dateStr).push(r);
  }

  return {
    window: win,
    totals,
    outcomes,
    hours: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, n]) => ({ hour, n })),
    days: [...byDay.entries()].sort().map(([date, rs]) => ({ date, ...aggregate(rs) })),
    floor: FLOOR,
    /* The EGP figure is the patient's invoice total on matched visits, not this
       booking's line. It is directional and the page says so rather than
       printing it as revenue somebody could reconcile. */
    revenueNote: 'Indicative. It is the invoice total on the visits the patient was matched to, '
      + 'not the value of this booking.',
  };
}

/* ------------------------------------------------------ 02 · the CRM ------ */

async function crm({ from, to, scope = 'all', cov, L }) {
  const win = ccWindow(from, to, cov.leads, 'CRM opportunities');
  if (!win.any) {
    return {
      window: win, totals: null, byLogin: [], byOpener: [],
      activities: null, rebooking: null, leadSource: null, duplicates: null,
    };
  }

  const [leads, acts, rebs] = await Promise.all([
    prisma.ccLead.findMany({ where: { date: { gte: day(win.from), lte: day(win.to) } } }),
    prisma.ccActivity.findMany({ where: { date: { gte: day(win.from), lte: day(win.to) } } }),
    prisma.ccRebooking.findMany({ where: { date: { gte: day(win.from), lte: day(win.to) } } }),
  ]);

  const kept = leads.filter((l) => scopeOk(L.name('Bs', l.branchIdx), scope));

  /* MEDIAN, not mean. The tail runs past 41,000 minutes — a lead opened in
     September and booked in October — and one of those drags a mean into
     nonsense. `-1` is "never booked" and is excluded rather than treated as
     zero, which would be the fastest response in the dataset. */
  const lags = kept.filter((l) => l.minutesToBooking >= 0)
    .map((l) => l.minutesToBooking).sort((a, b) => a - b);
  const median = lags.length
    ? (lags.length % 2 ? lags[(lags.length - 1) / 2]
      : Math.round((lags[lags.length / 2 - 1] + lags[lags.length / 2]) / 2))
    : null;

  const booked = kept.filter((l) => l.booked).length;
  const totals = {
    leads: kept.length,
    booked,
    bookingRate: pct(booked, kept.length),
    medianMinutesToBooking: median,
    measuredOn: lags.length,
    neverBooked: kept.length - lags.length,
    duplicates: kept.filter((l) => l.duplicateOfCc).length,
    overwritten: kept.filter((l) => l.employeeOverwritten).length,
  };

  /* A login is a desk; the opener is a person. Both are reported, and the
     expandable login row is the only place the two are shown as the same
     thing from different angles. */
  const loginMap = new Map();
  for (const l of kept) {
    const login = L.name('U', l.loginIdx) || `login ${l.loginIdx}`;
    if (!loginMap.has(login)) loginMap.set(login, { login, n: 0, booked: 0, people: new Map() });
    const e = loginMap.get(login);
    e.n += 1;
    if (l.booked) e.booked += 1;
    const who = L.name('PN', l.openerIdx) || 'Unstamped';
    if (!e.people.has(who)) e.people.set(who, { name: who, n: 0, booked: 0 });
    const p = e.people.get(who);
    p.n += 1;
    if (l.booked) p.booked += 1;
  }
  const byLogin = [...loginMap.values()].map((e) => ({
    login: e.login,
    n: e.n,
    booked: e.booked,
    bookingRate: pct(e.booked, e.n),
    people: [...e.people.values()].map((p) => ({ ...p, bookingRate: pct(p.booked, p.n) }))
      .sort((a, b) => b.n - a.n),
  })).sort((a, b) => b.n - a.n);

  const openerMap = new Map();
  for (const l of kept) {
    const who = L.name('PN', l.openerIdx) || 'Unstamped';
    if (!openerMap.has(who)) openerMap.set(who, { name: who, n: 0, booked: 0 });
    const p = openerMap.get(who);
    p.n += 1;
    if (l.booked) p.booked += 1;
  }
  const byOpener = [...openerMap.values()]
    .map((p) => ({ ...p, bookingRate: pct(p.booked, p.n) }))
    .sort((a, b) => b.n - a.n);

  return {
    window: win,
    totals,
    byLogin,
    byOpener,
    activities: activityBlock(acts, L),
    rebooking: rebookingBlock(rebs, L),
    leadSource: leadSourceBlock(kept),
    duplicates: {
      n: totals.duplicates,
      share: pct(totals.duplicates, kept.length),
      rule: 'The same Odoo patient had a contact-centre opportunity in the previous 30 days. '
        + 'Keyed on the patient record, not on the phone number — two numbers for one patient '
        + 'read as one person, and one number reused by a family does not.',
    },
  };
}

/**
 * Activities, broken down by LOGIN rather than by person.
 *
 * Not a choice. `personIdx` is -1 on every row of this export, so the person
 * behind an activity is not in the data. Labelling the column "Person" and
 * filling it with login names — which is what the source page does — turns a
 * missing field into a claim about who did the work.
 */
function activityBlock(acts, L) {
  if (!acts.length) return { available: false, why: 'No activities in this range.', rows: [] };
  const named = acts.filter((a) => a.personIdx >= 0).length;
  const byLogin = new Map();
  const byType = new Map();
  const byOutcome = new Map();
  for (const a of acts) {
    const login = L.name('U', a.loginIdx) || `login ${a.loginIdx}`;
    if (!byLogin.has(login)) byLogin.set(login, { login, n: 0, done: 0, overdue: 0, open: 0 });
    const e = byLogin.get(login);
    e.n += 1;
    if (a.state === 2) e.done += 1; else if (a.state === 1) e.overdue += 1; else e.open += 1;
    const t = L.name('Ty', a.typeIdx) || 'Unknown';
    byType.set(t, (byType.get(t) || 0) + 1);
    const o = L.name('OUT', a.outcomeIdx) || 'Not recorded';
    byOutcome.set(o, (byOutcome.get(o) || 0) + 1);
  }
  return {
    available: true,
    total: acts.length,
    /* Stated rather than implied, so the column header can be trusted. */
    grain: named ? 'person' : 'login',
    personAvailable: named > 0,
    why: named ? null
      : 'The person behind each activity is not in this export — the field is empty on every '
        + 'one of these rows — so this is broken down by the shared login that logged it, not '
        + 'by who logged it.',
    rows: [...byLogin.values()].sort((a, b) => b.n - a.n),
    byType: [...byType.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
    byOutcome: [...byOutcome.entries()].map(([outcome, n]) => ({ outcome, n }))
      .sort((a, b) => b.n - a.n),
    outcomeNote: 'Outcomes are bucketed by matching words in free text, across English, Arabic '
      + 'and Franco-Arabic, including common misspellings. It is a best effort over something '
      + 'that was written more than sixty different ways, and it is not a measurement. A fixed '
      + 'picklist in Odoo would replace the guessing.',
  };
}

/**
 * Who lost the credit.
 *
 * `credited: false` means the patient attended on an appointment that was NOT
 * one of the ones linked to the agent's opportunity — somebody re-booked them
 * and the original agent's number went down.
 */
function rebookingBlock(rebs, L) {
  if (!rebs.length) return { available: false, why: 'No re-bookings in this range.', rows: [] };
  const credited = rebs.filter((r) => r.credited).length;
  const lost = rebs.length - credited;
  const named = rebs.filter((r) => r.personIdx >= 0).length;

  const byBranch = new Map();
  for (const r of rebs.filter((x) => !x.credited)) {
    const b = L.name('Bs', r.leadBranchIdx) || 'No branch';
    if (!byBranch.has(b)) byBranch.set(b, { branch: b, n: 0, who: new Map() });
    const e = byBranch.get(b);
    e.n += 1;
    const w = L.name('PN', r.personIdx) || L.name('U', r.rebookLoginIdx) || 'Unstamped';
    e.who.set(w, (e.who.get(w) || 0) + 1);
  }

  const byAgent = new Map();
  for (const r of rebs) {
    const a = L.name('E', r.agentIdx) || `agent ${r.agentIdx}`;
    if (!byAgent.has(a)) byAgent.set(a, { agent: a, n: 0, lost: 0 });
    const e = byAgent.get(a);
    e.n += 1;
    if (!r.credited) e.lost += 1;
  }

  return {
    available: true,
    total: rebs.length,
    credited,
    lost,
    lostShare: pct(lost, rebs.length),
    personAvailable: named > 0,
    why: named ? null
      : 'Who re-booked is not in this export — the field is empty on every row — so the column '
        + 'below names the shared login, not the person.',
    byBranch: [...byBranch.values()].map((e) => ({
      branch: e.branch,
      n: e.n,
      mostly: [...e.who.entries()].sort((a, b) => b[1] - a[1])[0][0],
    })).sort((a, b) => b.n - a.n),
    byAgent: [...byAgent.values()].map((e) => ({ ...e, lostShare: pct(e.lost, e.n) }))
      .sort((a, b) => b.lost - a.lost),
  };
}

/**
 * Lead source — a refusal, and an honest one about why.
 *
 * The source page draws a red three-step remediation list here that reads as a
 * finding about Odoo. Part of it is: the Source, Medium and Campaign fields
 * really are empty in Odoo. But the rest is an artefact — this export does not
 * carry those columns at all, so even a perfectly tagged Odoo would show
 * nothing here. Reporting "0 sources used" as if measured would be wrong twice.
 */
function leadSourceBlock(leads) {
  return {
    available: false,
    measured: false,
    rows: leads.length,
    why: 'This export does not carry the Source, Medium or Campaign columns, so nothing about '
      + 'lead source can be read from it — including whether Odoo is tagging them. The page it '
      + 'came from shows "0 sources used" here, which looks like a measurement and is not.',
    alsoTrue: 'Separately, and from the Odoo side: the only sources defined are Odoo\'s own '
      + 'defaults — Facebook, Newsletter, LinkedIn — and none of them matches how patients '
      + 'actually arrive.',
    fix: 'Define the real sources in Odoo, make the field mandatory on lead creation, then '
      + 're-export with the Source, Medium and Campaign columns included.',
  };
}

/* ------------------------------------------- 00 · the appointments -------- */

const AP_STATE = ['Showed', 'Confirmed', 'Pending', 'Cancelled', 'Rescheduled', 'No show', 'Other'];
const AP_SOURCE = ['Contact centre', 'Branch', 'System'];

/**
 * The appointment aggregate, from the file's `apAgg()` at line 1017.
 *
 * RESCHEDULED ROWS ARE NOT COUNTED. A reschedule is one booking that moved, and
 * counting both halves double-counts the patient. They are reported separately
 * so the number is visible rather than silently dropped.
 *
 * TWO SHOW METRICS, and which one applies depends on the range. For a range
 * entirely in the past, `showRate = showed ÷ past`. For a range reaching into
 * the future, that denominator would include appointments that have not
 * happened, so `arrivedRate = showed ÷ (booked − cancelled)` is used instead
 * and labelled "arrived so far". Reporting one as the other is how a report
 * about next week reads as a catastrophe.
 */
function apAggregate(rows, today) {
  const a = {
    n: 0, rescheduled: 0, contactCentre: 0, branch: 0, system: 0,
    showed: 0, cancelled: 0, noShow: 0, upcoming: 0, notClosed: 0,
    confirmed: 0, pending: 0, withCall: 0, past: 0,
  };
  for (const r of rows) {
    if (r.stateCode === 4) { a.rescheduled += 1; continue; }
    a.n += 1;
    if (r.sourceCode === 0) a.contactCentre += 1;
    else if (r.sourceCode === 1) a.branch += 1;
    else a.system += 1;
    const d = ymd(r.date);
    if (r.stateCode === 0) a.showed += 1;
    else if (r.stateCode === 3) a.cancelled += 1;
    else if (r.stateCode === 5) a.noShow += 1;
    else if (r.stateCode === 1 || r.stateCode === 2) { if (d >= today) a.upcoming += 1; else a.notClosed += 1; }
    if (r.stateCode === 1) a.confirmed += 1;
    if (r.stateCode === 2) a.pending += 1;
    if (r.hadConfirmCall) a.withCall += 1;
    if (d < today && r.stateCode !== 3) a.past += 1;
  }
  a.showRate = pct(a.showed, a.past);
  a.arrivedRate = pct(a.showed, a.n - a.cancelled);
  a.confirmRate = pct(a.confirmed, a.confirmed + a.pending);
  a.cancelRate = pct(a.cancelled, a.n);
  a.callRate = pct(a.withCall, a.n);
  return a;
}

async function appointments({ from, to, scope = 'all', cov, L, today }) {
  const win = ccWindow(from, to, cov.appointments, 'appointments');
  if (!win.any) {
    return { window: win, totals: null, branches: [], families: [], doctors: [], confirmation: null };
  }

  const raw = await prisma.ccAppointment.findMany({
    where: { date: { gte: day(win.from), lte: day(win.to) } },
    orderBy: { date: 'asc' },
  });
  const rows = raw.filter((r) => (scope === 'all' ? true : (scope === 'ZAT') === r.isZat));
  const totals = apAggregate(rows, today);
  /* Which of the two show metrics the page should print, decided here rather
     than in the client, so every reader of this payload makes the same call. */
  totals.reachesFuture = win.to >= today;
  totals.showMetric = totals.reachesFuture ? 'arrivedRate' : 'showRate';

  const group = (keyOf, label) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r) || '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.entries()].map(([k, rs]) => ({ [label]: k, ...apAggregate(rs, today) }))
      .sort((a, b) => b.n - a.n);
  };

  /* Half-hour slots from 09:00, 26 of them — the clinic day as the source page
     draws it. A booking outside that window lands in `offGrid` rather than
     being dropped. */
  const SLOT0 = 9 * 60;
  const SLOTS = 26;
  const heat = new Map();
  let offGrid = 0;
  for (const r of rows) {
    if (r.slotMinutes < 0) { offGrid += 1; continue; }
    const col = Math.floor((r.slotMinutes - SLOT0) / 30);
    if (col < 0 || col >= SLOTS) { offGrid += 1; continue; }
    const b = L.name('BR', r.branchIdx) || '—';
    if (!heat.has(b)) heat.set(b, new Array(SLOTS).fill(0));
    heat.get(b)[col] += 1;
  }

  return {
    window: win,
    totals,
    sources: AP_SOURCE.map((label, code) => {
      const n = rows.filter((r) => r.stateCode !== 4 && r.sourceCode === code).length;
      return { code, label, n, share: pct(n, totals.n) };
    }),
    states: AP_STATE.map((label, code) => ({
      code, label, n: rows.filter((r) => r.stateCode === code).length,
    })),
    branches: group((r) => L.name('BR', r.branchIdx), 'branch'),
    families: group((r) => L.name('FAM', r.familyIdx), 'family'),
    doctors: group((r) => L.name('DOC', r.doctorIdx), 'doctor').slice(0, 20),
    bookers: group((r) => L.name('PP', r.bookerIdx), 'booker').slice(0, 20),
    heat: {
      slot0: SLOT0,
      slots: SLOTS,
      offGrid,
      rows: [...heat.entries()].map(([branch, cells]) => ({ branch, cells }))
        .sort((a, b) => b.cells.reduce((s, c) => s + c, 0) - a.cells.reduce((s, c) => s + c, 0)),
    },
    confirmation: confirmationBlock(rows, totals, today),
  };
}

/**
 * Do confirmation calls work, and are they happening at all.
 *
 * The second question answers first: 168 of 3,638 is under five per cent. That
 * has two readings and the page gives both rather than picking the one that
 * blames the branches.
 */
function confirmationBlock(rows, totals, today) {
  const due = rows.filter((r) => r.stateCode !== 4 && ymd(r.date) < today && r.stateCode !== 3);
  const withCall = due.filter((r) => r.hadConfirmCall);
  const without = due.filter((r) => !r.hadConfirmCall);
  const sh = (rs) => pct(rs.filter((r) => r.stateCode === 0).length, rs.length);
  return {
    coverage: totals.callRate,
    withCall: { n: withCall.length, showRate: sh(withCall) },
    withoutCall: { n: without.length, showRate: sh(without) },
    /* Only worth reading as a comparison when both sides have enough rows to
       mean anything. 168 across eleven branches does not. */
    comparable: withCall.length >= 30 && without.length >= 30,
    note: totals.callRate != null && totals.callRate < 0.2
      ? `Only ${Math.round(totals.callRate * 1000) / 10}% of bookings have a confirmation call `
        + 'recorded against them. Either the branches are not confirming, or they are confirming '
        + 'and not recording it — and from here those two look identical. Until the call is '
        + 'logged on the appointment, no number on this card can settle which.'
      : null,
  };
}

/* ------------------------------------------------- 04 · the people -------- */

/** Per contact-centre agent: volume, booking rate, show rate against the floor. */
async function people({ from, to, scope = 'all', cov, L }) {
  const win = ccWindow(from, to, cov.opportunities, 'contact-centre opportunities');
  if (!win.any) return { window: win, agents: [], floor: FLOOR };

  const rows = await opportunityRows({ from: win.from, to: win.to, scope, L });
  const m = new Map();
  for (const r of rows) {
    const k = r.person || `person ${r.personIdx}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return {
    window: win,
    floor: FLOOR,
    agents: [...m.entries()].map(([name, rs]) => ({ name, ...aggregate(rs) }))
      .sort((a, b) => b.n - a.n),
  };
}

/* ------------------------------------------------- 05 · the timing -------- */

/* Saturday first — the clinic week, not the calendar one. */
const WEEKDAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const weekdayOf = (d) => (d.getUTCDay() + 1) % 7;

async function timing({ from, to, scope = 'all', cov, L }) {
  const win = ccWindow(from, to, cov.opportunities, 'contact-centre opportunities');
  if (!win.any) return { window: win, weekdays: [], heat: [], hours: [] };

  const rows = await opportunityRows({ from: win.from, to: win.to, scope, L });
  const HOURS = [];
  for (let h = 9; h <= 22; h += 1) HOURS.push(h);

  const heat = WEEKDAYS.map((label, i) => ({
    weekday: label,
    cells: HOURS.map((h) => rows.filter((r) => weekdayOf(r.date) === i && r.hour === h).length),
  }));

  return {
    window: win,
    hours: HOURS,
    heat,
    weekdays: WEEKDAYS.map((label, i) => {
      const rs = rows.filter((r) => weekdayOf(r.date) === i);
      return { weekday: label, ...aggregate(rs) };
    }),
  };
}

/* --------------------------------------- 06 · branches and doctors -------- */

async function branches({ from, to, scope = 'all', cov, L }) {
  const win = ccWindow(from, to, cov.opportunities, 'contact-centre opportunities');
  if (!win.any) return { window: win, branches: [], doctors: [] };

  const rows = await opportunityRows({ from: win.from, to: win.to, scope, L });
  const group = (keyOf, label, limit) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r) || '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    const out = [...m.entries()].map(([k, rs]) => ({ [label]: k, ...aggregate(rs) }))
      .sort((a, b) => b.n - a.n);
    return limit ? out.slice(0, limit) : out;
  };
  return {
    window: win,
    branches: group((r) => r.branch, 'branch'),
    doctors: group((r) => r.doctor, 'doctor', 15),
    departments: group((r) => r.dept, 'department'),
  };
}

/* ------------------------------------------- 07 · the data quality -------- */

/**
 * Who is working under somebody else's login, and which HR records make that
 * impossible to tell.
 *
 * The cross-login check is the useful one: a person whose HR home login is
 * "Front Office" opening leads under "Call Center" means neither report can be
 * trusted to attribute their work, and it is invisible from inside Odoo.
 */
async function quality({ from, to, cov, L }) {
  const win = ccWindow(from, to, cov.leads, 'CRM opportunities');
  const [emps, leads] = await Promise.all([
    prisma.ccEmployee.findMany(),
    win.any
      ? prisma.ccLead.findMany({ where: { date: { gte: day(win.from), lte: day(win.to) } } })
      : [],
  ]);
  const byName = new Map(emps.map((e) => [e.name, e]));

  const cross = new Map();
  let unstamped = 0;
  for (const l of leads) {
    const who = L.name('PN', l.openerIdx);
    const login = L.name('U', l.loginIdx) || `login ${l.loginIdx}`;
    if (!who) { unstamped += 1; continue; }
    const e = byName.get(who);
    if (!e || !e.homeLogin || e.homeLogin === login) continue;
    const k = `${who}|${login}`;
    if (!cross.has(k)) cross.set(k, { person: who, used: login, home: e.homeLogin, n: 0 });
    cross.get(k).n += 1;
  }

  /* Normalised the way the source page does: lowercase, drop a leading "dr.",
     keep letters only. It is what makes "Dr. Mohamed Ali" and "mohamed ali"
     the same person and "Mohamed Aly" a near-duplicate worth a human look. */
  const norm = (s) => String(s).toLowerCase().replace(/^dr\.?\s*/, '').replace(/[^a-z؀-ۿ]/g, '');
  const seen = new Map();
  for (const e of emps) {
    const k = norm(e.name);
    if (!k) continue;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(e.name);
  }

  const issues = [];
  for (const e of emps) {
    const why = [];
    if (!e.department) why.push('no department');
    if (!e.jobTitle) why.push('no job title');
    if (!e.homeLogin) why.push('no home login');
    if (e.name.trim().length <= 4) why.push('name is four characters or fewer — test or junk');
    if (why.length) issues.push({ name: e.name, active: e.active, why: why.join(' · ') });
  }
  const nearDuplicates = [...seen.values()].filter((v) => v.length > 1)
    .map((names) => ({ names: [...new Set(names)] })).filter((d) => d.names.length > 1);

  return {
    window: win,
    totals: {
      employees: emps.length,
      active: emps.filter((e) => e.active).length,
      crossLoginRows: [...cross.values()].reduce((s, c) => s + c.n, 0),
      crossLoginPeople: new Set([...cross.values()].map((c) => c.person)).size,
      unstamped,
      overwritten: leads.filter((l) => l.employeeOverwritten).length,
      leads: leads.length,
    },
    crossLogin: [...cross.values()].sort((a, b) => b.n - a.n),
    issues: issues.sort((a, b) => a.name.localeCompare(b.name)),
    nearDuplicates,
    /* Stated as policy rather than measured, because they are decisions
       somebody has to take in Odoo, not findings in the data. */
    agenda: [
      {
        what: 'Type of Call is not mandatory',
        why: 'An activity can be logged with no type, so the breakdown by type is incomplete by '
          + 'exactly as much as nobody filled in.',
        fix: 'Make the field required on the activity form.',
      },
      {
        what: 'Call In and Call Out do not exist as activity types',
        why: 'Direction is the first thing anybody asks of a call log and Odoo cannot answer it.',
        fix: 'Add the two types, then stop accepting the generic Call.',
      },
      {
        what: 'Outcomes are free text',
        why: 'The same result is written more than sixty different ways, so every outcome figure '
          + 'on this report is a guess made by matching words.',
        fix: 'A fixed picklist, and no free-text fallback.',
      },
      {
        what: 'Shared logins',
        why: 'Five logins cover sixty-seven people, so Odoo itself cannot attribute any record '
          + 'to a person. Everything on this report that names somebody reads it out of a '
          + 'chatter message instead.',
        fix: 'An individual Odoo login per person.',
      },
    ],
  };
}

module.exports = {
  lookups, ccCoverage, ccWindow, aggregate, apAggregate,
  summary, crm, appointments, people, timing, branches, quality,
  FLOOR, ZAT_BRANCHES, WEEKDAYS,
};
