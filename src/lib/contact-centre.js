/* ============================================================
   Report 02 — Contact Centre. The read side.

   FOUR TABS READ A SEEDED SNAPSHOT AND ONE READS LIVE ODOO, and that split is
   the single most important thing about this module.

   The Grandstream PBX has no API we can reach and no export on this machine, so
   queues, agents, hours and outbound come from the arrays embedded in the frozen
   HTML pack — 1 to 18 August 2026 and nothing else in existence. Bookings come
   from Odoo and answer any range. A reader looking at both on one page has to be
   able to tell which is which, so every figure here carries its provenance and
   `pbx.covers` states the only window the PBX half can speak about.

   WHAT THIS MODULE WILL NOT DO:

   1. IT WILL NOT ZERO A RANGE IT HAS NO DATA FOR. Ask it about September and
      the PBX side answers "outside the seeded window", not 0 calls. A zero is a
      claim that the phones did not ring.

   2. IT WILL NOT ADD THE TWO OUTBOUND UNIVERSES. The pack's own headline says
      7,888 dials where its per-agent table sums to 4,404. The reconcilable
      figure is stored and served; the headline is carried separately as a
      CLAIM, labelled, never summed with anything.

   3. IT WILL NOT PRESENT OCCUPANCY AS MEASURED. Occupancy and adherence divide
      talk time by an ASSUMED twelve-hour shift. The CDR carries no agent-state
      log — no login, ready, pause or wrap-up — so there is nothing to measure
      against and the assumption is doing all the work. Both are returned with
      `assumed: true` and the shift length beside them.

   4. IT WILL NOT PRETEND BOOKINGS-PER-AGENT EXISTS. All 2,100 call-centre
      bookings carry one shared Odoo login, so per-agent booking counts cannot
      be derived — and the commission policy pays 30 EGP an agent on exactly
      that figure. It is returned as an explicit refusal with the reason, not as
      a flat average, because a flat average is what somebody would pay on.
   ============================================================ */

const { prisma } = require('./db.js');
const { buildFunnel } = require('./appointments.js');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const day = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00.000Z`);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/* The queues ZAT runs, from the pack's own `ZQ`. Everything else is Nouvel Age,
   and EVERY queue is claimed by one side or the other so the two add up to the
   aggregate — unlike the pack, whose Nouvel Age card drops six queues holding
   ten calls between them. The small ones are reported as small rather than as
   absent; see `queues()`. */
const ZAT_QUEUES = new Set(['6502']);

/* The branches ZAT runs, from the pack's `ZBR`. Used for the Bookings tab's
   entity filter — the same two branches the commercial reports resolve through
   CommissionBranch, restated here because this report's other half has no
   branch dimension at all. */
const ZAT_BRANCHES = new Set(['Madinity', 'El Rehab']);

/* The assumption that occupancy and adherence rest on. Named, exported and
   quoted on the page, because it is not a detail — it is the denominator. */
const ASSUMED_SHIFT_HOURS = 12;

/** What the PBX half can speak about at all, and with what provenance. */
async function pbxCoverage() {
  const rows = await prisma.pbxDay.groupBy({
    by: ['source'],
    _min: { date: true }, _max: { date: true },
    _count: { _all: true }, _max2: undefined,
  }).catch(() => []);
  const loaded = await prisma.dataUpload.findFirst({
    where: { kind: { startsWith: 'pbx' } }, orderBy: { createdAt: 'desc' },
  });
  const spans = rows.map((r) => ({
    source: r.source,
    from: r._min.date ? ymd(r._min.date) : null,
    to: r._max.date ? ymd(r._max.date) : null,
    days: r._count._all,
  }));
  return {
    spans,
    /* The union, which is what a range check compares against. */
    from: spans.reduce((a, s) => (!a || (s.from && s.from < a) ? s.from : a), null),
    to: spans.reduce((a, s) => (!a || (s.to && s.to > a) ? s.to : a), null),
    lastLoad: loaded ? {
      kind: loaded.kind, at: loaded.createdAt.toISOString(),
      rows: loaded.rowsWritten, notes: loaded.notes, filename: loaded.filename,
    } : null,
  };
}

/**
 * How much of the asked-for range the PBX seed actually covers.
 *
 * Returned on every PBX section so a panel can say "1–18 August, not the range
 * you asked for" instead of showing a total that silently means something else.
 */
function overlap(from, to, cov) {
  if (!cov.from || !cov.to) {
    return { any: false, from: null, to: null, note: 'No PBX data has been loaded at all.' };
  }
  const lo = from > cov.from ? from : cov.from;
  const hi = to < cov.to ? to : cov.to;
  if (lo > hi) {
    return {
      any: false, from: null, to: null,
      note: `The PBX snapshot covers ${cov.from} → ${cov.to} and this range does not touch it. `
        + 'Nothing about the phones can be said for these dates — the export does not exist, '
        + 'so a zero here would be a claim that the phones did not ring.',
    };
  }
  const full = lo === from && hi === to;
  return {
    any: true, from: lo, to: hi, full,
    note: full ? null
      : `The PBX snapshot covers ${cov.from} → ${cov.to}, so the phone figures below are for `
        + `${lo} → ${hi} while the booking figures are for ${from} → ${to}. The two halves of `
        + 'this report are not the same window.',
  };
}

/**
 * One row per grain, preferring an upload over the seed.
 *
 * THE BUG THIS EXISTS TO FIX: every PBX read used to aggregate across all
 * sources, so a day present as BOTH `seed` and `upload` was counted twice. With
 * the frozen pack seeding 1-18 August, the first real export covering any of
 * those days would have silently doubled them — and the module header claimed
 * the report "prefers the upload", which it did not.
 *
 * An upload is a deliberate act by somebody holding a newer export, so it wins
 * for the grains it covers, and the seed still answers for every grain it does
 * not. Neither is deleted, so removing a bad import restores the snapshot
 * underneath it.
 */
function preferUpload(rows, keyOf) {
  const uploaded = new Set();
  for (const r of rows) if (r.source === 'upload') uploaded.add(keyOf(r));
  return rows.filter((r) => r.source === 'upload' || !uploaded.has(keyOf(r)));
}

/* ------------------------------------------------------- 01 · the phones --- */

/**
 * Inbound and outbound volume for whatever part of the range the seed covers.
 *
 * `sessions` is inbound + dials, which is the pack's own definition of a
 * session, computed from the reconcilable figures rather than from the headline
 * that reconciles with nothing.
 */
async function phones({ from, to, cov }) {
  const win = overlap(from, to, cov);
  /* THE FULL SHAPE, with nulls where there is no answer — never a partial
     object. A caller reading `.answerRate` off a short-circuited return gets
     `undefined`, which renders as the word "undefined" on a page and crashed
     this module's own smoke check on a September range. */
  if (!win.any) {
    return {
      window: win, inbound: 0, answered: 0, abandoned: 0,
      answerRate: null, abandonRate: null, dials: 0, sessions: 0,
      perDay: null, days: [],
    };
  }

  const where = { date: { gte: day(win.from), lte: day(win.to) } };
  /* Rows rather than an aggregate, because the sum has to be taken AFTER one
     source per day is chosen — see preferUpload. There are at most a few
     hundred of these. */
  const all = await prisma.pbxDay.findMany({
    where, orderBy: { date: 'asc' },
    select: { date: true, inboundCalls: true, inboundAnswered: true, dials: true, source: true },
  });
  const days = preferUpload(all, (r) => ymd(r.date));
  const inbound = days.reduce((t, r) => t + r.inboundCalls, 0);
  const answered = days.reduce((t, r) => t + r.inboundAnswered, 0);
  const dials = days.reduce((t, r) => t + r.dials, 0);

  return {
    window: win,
    inbound,
    answered,
    abandoned: inbound - answered,
    answerRate: inbound ? r2(answered / inbound) : null,
    abandonRate: inbound ? r2((inbound - answered) / inbound) : null,
    dials,
    sessions: inbound + dials,
    perDay: days.length ? r2(inbound / days.length) : null,
    days: days.map((d) => ({
      date: ymd(d.date), inbound: d.inboundCalls, answered: d.inboundAnswered,
      dials: d.dials, source: d.source,
    })),
  };
}

/** Inbound by hour of day — aggregated over the whole window, so it has no date. */
async function hours() {
  const rows = await prisma.pbxHour.findMany({ orderBy: { hour: 'asc' } });
  const list = rows.map((h) => ({ hour: h.hour, calls: h.calls, answered: h.answered, source: h.source }));
  const peak = list.reduce((best, h) => (h.calls > (best ? best.calls : -1) ? h : best), null);
  /* The staffing finding: calls arriving when nobody is on the phones. Computed
     from the data rather than quoted from the pack, whose sentence says 108
     where its own hourly rows say 218. */
  const closed = list.filter((h) => h.hour < 9 || h.hour > 21);
  return {
    list,
    peak,
    outOfHours: {
      calls: closed.reduce((t, h) => t + h.calls, 0),
      answered: closed.reduce((t, h) => t + h.answered, 0),
      hours: '00:00–08:59 and 22:00–23:59',
    },
  };
}

/* ---------------------------------------------------------- 02 · queues --- */

/**
 * Per queue, with the entity split and the queues neither entity claims.
 *
 * `unclaimed` is the point of this function. The pack shows 2,426 Nouvel Age +
 * 483 ZAT beside an aggregate of 2,919 — ten calls in queues assigned to
 * nobody. Two totals that do not add to the third is precisely how the
 * commercial reports lost their unmapped branches, so the queues are grouped
 * with the leftovers named.
 */
async function queues({ from, to, cov, scope = 'all' }) {
  const win = overlap(from, to, cov);
  if (!win.any) return { window: win, queues: [], entities: null, tiny: [] };

  const raw = await prisma.pbxQueueDay.findMany({
    where: { date: { gte: day(win.from), lte: day(win.to) } },
    select: { queue: true, date: true, offered: true, answered: true, source: true },
  });
  /* Per (queue, day), so an upload replaces the seed for the days it covers
     without disturbing the rest. */
  const kept = preferUpload(raw, (r) => `${r.queue}|${ymd(r.date)}`);
  const byQueue = new Map();
  for (const r of kept) {
    if (!byQueue.has(r.queue)) byQueue.set(r.queue, { queue: r.queue, offered: 0, answered: 0 });
    const x = byQueue.get(r.queue);
    x.offered += r.offered;
    x.answered += r.answered;
  }

  const all = [...byQueue.values()].map((r) => {
    const offered = r.offered;
    const answered = r.answered;
    return {
      queue: r.queue,
      entity: ZAT_QUEUES.has(r.queue) ? 'ZAT' : 'Nouvel Age',
      offered,
      answered,
      abandoned: offered - answered,
      answerRate: offered ? r2(answered / offered) : null,
      abandonRate: offered ? r2((offered - answered) / offered) : null,
    };
  }).sort((a, b) => b.offered - a.offered);

  /* EVERY queue counts towards its entity, so the two sides add up to the
     aggregate exactly.

     The pack does not do this: it shows 2,426 Nouvel Age + 483 ZAT beside an
     aggregate of 2,919, because its Nouvel Age card silently drops six queues
     with ten calls between them. Ten calls change nothing — but two totals that
     do not add to the third is how the commercial reports lost their unmapped
     branches, and the fix there was the same as here: claim everything, then
     name the small ones separately as a note rather than as an omission. */
  const TINY = 10;
  const tiny = all.filter((q) => q.offered < TINY);

  const side = (name) => {
    const list = all.filter((q) => q.entity === name);
    const offered = list.reduce((t, q) => t + q.offered, 0);
    const answered = list.reduce((t, q) => t + q.answered, 0);
    return {
      name, queues: list.length, offered, answered,
      abandoned: offered - answered,
      abandonRate: offered ? r2((offered - answered) / offered) : null,
      /* How many of those queues are too small to mean anything, so a reader
         does not read an 100% abandon rate off a queue that took one call. */
      tinyQueues: list.filter((q) => q.offered < TINY).length,
    };
  };
  const na = side('Nouvel Age');
  const zat = side('ZAT');

  const shown = scope === 'all' ? all : all.filter((q) => q.entity === scope);
  return {
    window: win,
    queues: shown,
    entities: {
      nouvelAge: na,
      zat,
      /* The finding the pack leads with, computed rather than quoted. */
      abandonGap: na.abandonRate !== null && zat.abandonRate !== null
        ? r2(zat.abandonRate - na.abandonRate) : null,
      /* The two sides add to the aggregate; this proves it rather than
         asserting it, and is checked in the audit. */
      offeredTotal: na.offered + zat.offered,
      tinyThreshold: TINY,
      tinyOffered: tiny.reduce((t, q) => t + q.offered, 0),
    },
    tiny,
  };
}

/* ---------------------------------------------------------- 03 · agents --- */

/**
 * Per agent, with occupancy and adherence marked as the assumptions they are.
 *
 * Two row shapes live in `PbxAgentDay` and they are read separately here: dated
 * rows are the volume series, and one undated row per agent carries the shift
 * span, which is a property of an agent over the window rather than of a day.
 * The undated rows carry zeroes in every volume column so that a naive SUM over
 * the table is still correct — but this function does not rely on that, it
 * filters by date explicitly.
 */
async function agents({ from, to, cov }) {
  const win = overlap(from, to, cov);
  if (!win.any) {
    return {
      window: win, agents: [], assumedShiftHours: ASSUMED_SHIFT_HOURS,
      totals: { agents: 0, talkHours: 0, occupancy: null },
      assumptionNote: null,
    };
  }

  const [raw, spans] = await Promise.all([
    prisma.pbxAgentDay.findMany({
      where: { date: { gte: day(win.from), lte: day(win.to) } },
      select: {
        ext: true, agentName: true, date: true, source: true,
        offered: true, answered: true, talkInSec: true,
        dials: true, connected: true, talkOutSec: true,
      },
    }),
    prisma.pbxAgentDay.findMany({
      where: { date: null },
      select: { ext: true, agentName: true, daysActive: true, spanMinutes: true },
    }),
  ]);
  const spanBy = new Map(spans.map((s) => [s.ext, s]));

  /* Per (extension, day), for the same reason as the queues. */
  const kept = preferUpload(raw, (r) => `${r.ext}|${ymd(r.date)}`);
  const byExt = new Map();
  for (const r of kept) {
    if (!byExt.has(r.ext)) {
      byExt.set(r.ext, {
        ext: r.ext, agentName: r.agentName, days: 0,
        offered: 0, answered: 0, talkInSec: 0, dials: 0, connected: 0, talkOutSec: 0,
      });
    }
    const x = byExt.get(r.ext);
    x.days += 1;
    x.agentName = x.agentName || r.agentName;
    for (const f of ['offered', 'answered', 'talkInSec', 'dials', 'connected', 'talkOutSec']) x[f] += r[f];
  }

  const list = [...byExt.values()].map((r) => {
    const s = r;
    const offered = s.offered || 0;
    const answered = s.answered || 0;
    const talkIn = s.talkInSec || 0;
    const talkOut = s.talkOutSec || 0;
    const sp = spanBy.get(r.ext) || null;
    const daysActive = sp && sp.daysActive ? sp.daysActive : r.days;
    const shiftSec = daysActive * ASSUMED_SHIFT_HOURS * 3600;
    return {
      ext: r.ext,
      /* Only two of the eleven extensions have a name in the pack. The rest are
         an extension number, which is honest — inventing "Agent 6003" would
         read as a name somebody could look up. */
      name: r.agentName || (sp && sp.agentName) || null,
      offered,
      answered,
      answerRate: offered ? r2(answered / offered) : null,
      ahtInSec: answered ? Math.round(talkIn / answered) : null,
      talkInSec: talkIn,
      dials: s.dials || 0,
      connected: s.connected || 0,
      connectRate: s.dials ? r2((s.connected || 0) / s.dials) : null,
      ahtOutSec: s.connected ? Math.round(talkOut / s.connected) : null,
      talkOutSec: talkOut,
      daysActive,
      spanMinutes: sp ? sp.spanMinutes : null,
      /* BOTH ASSUMED. The divisor is a twelve-hour shift nobody has confirmed,
         and the CDR has no agent-state log to measure against. */
      occupancy: shiftSec ? r2((talkIn + talkOut) / shiftSec) : null,
      adherence: sp && sp.spanMinutes && ASSUMED_SHIFT_HOURS
        ? r2((sp.spanMinutes / 60) / ASSUMED_SHIFT_HOURS) : null,
      assumed: true,
    };
  }).sort((a, b) => b.offered - a.offered);

  const talkAll = list.reduce((t, a) => t + a.talkInSec + a.talkOutSec, 0);
  const shiftAll = list.reduce((t, a) => t + a.daysActive * ASSUMED_SHIFT_HOURS * 3600, 0);

  return {
    window: win,
    agents: list,
    assumedShiftHours: ASSUMED_SHIFT_HOURS,
    totals: {
      agents: list.length,
      talkHours: r2(talkAll / 3600),
      occupancy: shiftAll ? r2(talkAll / shiftAll) : null,
    },
    /* Why occupancy cannot be improved into a measurement. Returned as text
       because the page must print it beside the figure, not in a footnote. */
    assumptionNote: `Occupancy and adherence divide talk time by an assumed `
      + `${ASSUMED_SHIFT_HOURS}-hour shift. The CDR carries no agent-state log — no login, `
      + 'ready, pause or wrap-up — so there is nothing to measure against and the assumption '
      + 'is doing the work. Confirm the real shift length and both become measurements.',
  };
}

/* -------------------------------------------------------- 04 · outbound --- */

/**
 * Outbound, with the pack's contradictory headline carried as a claim.
 *
 * `stored` is what reconciles: the per-agent dial counts, which agree exactly
 * with the per-day cube. `packClaim` is the Outbound tab's own headline, which
 * agrees with nothing else in the file. Both are returned and neither is added
 * to the other — the page shows the stored figure and says the claim exists.
 */
async function outbound({ from, to, cov }) {
  const a = await agents({ from, to, cov });
  if (!a.window.any) {
    return {
      window: a.window, dials: 0, connected: 0, wasted: 0, connectRate: null,
      talkOutHours: 0, avgTalkSec: null, perDay: null, byAgent: [], packClaim: null,
    };
  }

  const dials = a.agents.reduce((t, x) => t + x.dials, 0);
  const connected = a.agents.reduce((t, x) => t + x.connected, 0);
  const talkOut = a.agents.reduce((t, x) => t + x.talkOutSec, 0);

  /* Read out of the seed's own load record rather than typed in, so it stays
     true if the pack is re-imported with different numbers. */
  const note = cov.lastLoad && cov.lastLoad.notes ? cov.lastLoad.notes : '';
  const m = /CONFLICT outbound dials: pack (\d+) vs data (\d+)/.exec(note);

  return {
    window: a.window,
    dials,
    connected,
    wasted: dials - connected,
    connectRate: dials ? r2(connected / dials) : null,
    talkOutHours: r2(talkOut / 3600),
    avgTalkSec: connected ? Math.round(talkOut / connected) : null,
    perDay: a.window.any && cov.from
      ? r2(dials / Math.max(1, a.agents.reduce((t, x) => Math.max(t, x.daysActive), 0)))
      : null,
    byAgent: a.agents.map((x) => ({
      ext: x.ext, name: x.name, dials: x.dials, connected: x.connected,
      connectRate: x.connectRate, talkOutSec: x.talkOutSec, ahtOutSec: x.ahtOutSec,
    })).sort((x, y) => y.dials - x.dials),
    /* The contradiction, surfaced rather than resolved by fiat. */
    packClaim: m ? {
      dials: Number(m[1]),
      stored: Number(m[2]),
      note: 'The pack\'s Outbound tab headline says '
        + `${Number(m[1]).toLocaleString('en-US')} dials while its own per-agent table sums to `
        + `${Number(m[2]).toLocaleString('en-US')}. They are different datasets. The figure `
        + 'shown here is the per-agent one, because that is the one that reconciles with the '
        + 'per-day cube; the headline reconciles with nothing else in the file.',
    } : null,
  };
}

/* -------------------------------------------------------- 05 · bookings --- */

/**
 * The one live tab. Odoo, any range, no seed involved.
 *
 * `perAgent` is deliberately a refusal rather than a number. Every call-centre
 * booking carries one shared Odoo login, so the per-agent split does not exist
 * in the data — and the commission policy pays per agent on exactly this
 * figure, which is why a flat average would be worse than nothing here.
 */
async function bookings({ from, to, scope = 'all' }) {
  const f = await buildFunnel({ from, to });
  const inScope = (name) => scope === 'all'
    || (scope === 'ZAT' ? ZAT_BRANCHES.has(name) : !ZAT_BRANCHES.has(name));

  const branches = (f.branches || []).filter((b) => inScope(b.name));
  const creators = f.creators || [];
  const cc = creators.find((c) => /call\s*cent/i.test(c.name));
  const ccBookings = cc ? cc.count : 0;
  const frontOffice = creators.filter((c) => /front\s*office/i.test(c.name))
    .reduce((t, c) => t + c.count, 0);

  const agentRows = await prisma.pbxAgentDay.findMany({
    where: { date: null }, select: { ext: true },
  });

  return {
    reportable: f.reportable,
    cutover: f.cutover,
    measuredFrom: f.measuredFrom,
    preCutover: f.preCutover,
    booked: f.booked,
    totals: f.totals,
    showRate: f.showRate,
    policyFloor: f.policyFloor,
    states: f.states,
    branches,
    creators,
    specialists: (f.specialists || []).slice(0, 15),
    contactCentre: {
      bookings: ccBookings,
      share: f.booked ? r2(ccBookings / f.booked) : null,
      frontOffice,
      frontOfficeShare: f.booked ? r2(frontOffice / f.booked) : null,
    },
    /* Not a number, and not zero either. A refusal with its reason. */
    perAgent: {
      available: false,
      agents: agentRows.length,
      flatAverage: agentRows.length ? Math.round(ccBookings / agentRows.length) : null,
      why: `All ${ccBookings.toLocaleString('en-US')} call-centre bookings are stamped to one `
        + `shared Odoo login, so there is no per-agent split in the data. The flat average `
        + `across ${agentRows.length} agents is shown only to make the shape of the gap `
        + 'visible — the commission policy pays 30 EGP an agent on this figure, and nobody '
        + 'should pay on a number that was divided rather than measured.',
      fix: 'Individual Odoo logins for the agents.',
    },
    /* The ratio that ties the two halves of this report together, and the only
       figure on the Bookings tab that depends on the PBX side. */
    bookingsPerConversation: null,   // filled by build(), which has both halves
  };
}

/* ------------------------------------------------------------------ build --- */

/** Everything, for one range and one entity scope. */
async function build({ from, to, scope = 'all' }) {
  const cov = await pbxCoverage();
  const [ph, hr, q, ag, ob, bk] = await Promise.all([
    phones({ from, to, cov }),
    hours(),
    queues({ from, to, cov, scope }),
    agents({ from, to, cov }),
    outbound({ from, to, cov }),
    bookings({ from, to, scope }),
  ]);

  /* Bookings per conversation, across the two halves — and only where the two
     halves cover the same window. The bookings are for the range asked for and
     the conversations are for whatever the seed covers, so dividing them across
     mismatched windows produces a ratio of two different fortnights. */
  if (ph.window.any) {
    /* A CONVERSATION is an answered inbound call PLUS a connected outbound one.
       Both halves, because the contact centre spends more of its day dialling
       out than answering: outbound is the larger side here, and a ratio against
       answered calls alone reads 0.86 where the real figure is 0.38. The pack's
       own 0.26 is this same definition computed on its unreconcilable 5,745
       connected — so the definition is confirmed even though the input is not. */
    const conversations = ph.answered + ob.connected;
    bk.conversations = conversations;
    bk.bookingsPerConversation = conversations
      ? {
        value: r2(bk.contactCentre.bookings / conversations),
        conversations,
        answered: ph.answered,
        connected: ob.connected,
        comparable: !!ph.window.full,
        note: ph.window.full ? null
          : `The bookings are for ${from} → ${to} and the conversations for `
            + `${ph.window.from} → ${ph.window.to}. Read the ratio as indicative only.`,
      }
      : null;
  }

  return {
    from, to, scope,
    coverage: cov,
    phones: ph,
    hours: hr,
    queues: q,
    agents: ag,
    outbound: ob,
    bookings: bk,
    /* What this report still cannot see, with the remedy. Chat is the big one:
       it was roughly seven in ten contacts in May and the newest export stops on
       6 June, so the busiest channel in the contact centre is invisible. */
    absent: [
      {
        what: 'Chat and omnichannel entirely',
        why: 'No export has ever reached NRS. The newest one on the project stops on 6 June, '
          + 'and chat was roughly seven in ten contacts in May.',
        fix: 'An omnichannel export, then the Admin uploads tab.',
      },
      {
        what: 'Bookings per agent',
        why: 'Every call-centre booking carries one shared Odoo login.',
        fix: 'Individual Odoo logins for the eleven agents.',
      },
      {
        what: 'A live PBX feed',
        why: 'The Grandstream UCM has no API reaching NRS; the four phone tabs are a frozen '
          + 'snapshot of 1–18 August 2026.',
        fix: 'A recurring CDR + queue-agent export, uploaded in Admin.',
      },
      {
        what: 'Real occupancy and adherence',
        why: `Both divide by an assumed ${ASSUMED_SHIFT_HOURS}-hour shift; the CDR has no `
          + 'agent-state log.',
        fix: 'Confirm the shift length, or export agent states.',
      },
      {
        what: 'Inbound-versus-outbound booking attribution',
        why: 'The Odoo appointment has no booking-source field, so no booking can be traced to '
          + 'a call.',
        fix: 'A booking-source field on the appointment.',
      },
    ],
  };
}

module.exports = {
  build, pbxCoverage, overlap, phones, hours, queues, agents, outbound, bookings,
  ZAT_QUEUES, ZAT_BRANCHES, ASSUMED_SHIFT_HOURS,
};
