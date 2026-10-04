/* ============================================================
   The weekly Grandstream UCM CDR — read, checked, and stored.

   WHY THIS EXISTS. The Contact Centre report locks every Sunday until last
   week's phone data is uploaded. The file people upload is UCM → CDR → Export:
   a RAW call-detail record, one row per call LEG, several legs per call, tied
   together by `session`. The existing PBX upload (pbx-import.js) was built for
   aggregated queue/agent reports and, fed this file, read every column, said
   the file fitted, and planned ZERO records. A lock whose only key does not fit
   locks the report for good, so this is the key.

   PORTED, NOT REINVENTED. The parsing is the source page's own — buildCallsGS,
   buildCalls, toDT, toSec, statusCode, guessMap, the header scoring and the
   Grandstream recogniser — moved server-side because the CSP forbids the CDN
   SheetJS it used, and because a file that decides whether a whole report opens
   should be checked where it is stored. Where this differs from the source it
   says so in a comment.

   One call becomes `[date, hour, dir, ext, answered, wait, talk, hash, queue,
   status]`, exactly the source's tuple. The phone number never leaves this
   module: only SHA-256 of its last ten digits, first 12 hex, which is the same
   form CcOpportunity.phoneHash uses — so a call can be joined to an Odoo
   opportunity without either side holding the number.
   ============================================================ */

const crypto = require('crypto');
const Sheet = require('./sheet.js');
const { prisma } = require('./db.js');

/* ------------------------------------------------------------ the parsing */

/* The generic column map, verbatim from the source. [key, label, required, synonyms] */
const FIELDS = [
  ['start', 'Call start', 1, ['start', 'start time', 'starttime', 'calldate', 'call date', 'call time', 'date', 'time', 'start_time']],
  ['answer', 'Answer time', 0, ['answer', 'answer time', 'answertime', 'answer_time']],
  ['src', 'Caller number', 1, ['src', 'caller number', 'caller', 'from', 'source', 'callerid', 'caller id', 'calling number', 'caller_number']],
  ['dst', 'Callee number', 1, ['dst', 'callee number', 'callee', 'to', 'destination', 'called number', 'dest', 'callee_number']],
  ['disp', 'Status', 1, ['disposition', 'status', 'call status', 'result']],
  ['talk', 'Talk seconds', 0, ['billsec', 'talk duration', 'talk time', 'talk', 'talktime', 'talk_duration']],
  ['dur', 'Total duration', 0, ['duration', 'call duration', 'total duration', 'call_duration']],
  ['agent', 'Answered by', 0, ['dstanswer', 'answered by', 'dstchanext', 'dstchannel_ext', 'agent', 'extension', 'answered_by']],
  ['act', 'Action type', 0, ['action_type', 'action type', 'call type', 'lastapp']],
  ['sess', 'Call ID', 0, ['session', 'uniqueid', 'call id', 'callid', 'linkedid']],
];

/* The five headers that, together, mean "this is a Grandstream UCM CDR". */
const GS_HEADERS = ['cdr', 'session', 'call type', 'dest channel extension', 'call status'];

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
/* An internal number: an extension, five digits or fewer. */
const isInt = (s) => { const d = digits(s); return d.length > 0 && d.length <= 5; };
const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.toISOString().slice(0, 10);

function guessMap(head) {
  const h = head.map(norm);
  const m = {};
  for (const [k, , , syn] of FIELDS) {
    let i = -1;
    for (const s of syn) { i = h.indexOf(s); if (i >= 0) break; }
    m[k] = i;
  }
  return m;
}

/** Seconds from a number, an Excel day-fraction, `H:MM:SS` or `MM:SS`. */
function toSec(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1 ? Math.round(v * 86400) : Math.round(v);
  const s = String(v).trim();
  const p = s.split(':').map(Number);
  if (p.length === 3 && p.every(Number.isFinite)) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2 && p.every(Number.isFinite)) return p[0] * 60 + p[1];
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * A date-time as the CDR wrote it, kept in the CDR's own clock.
 *
 * NO TIMEZONE CONVERSION, on purpose and as in the source: the UCM writes local
 * Cairo time, and that is the clock every week boundary and every hour bucket
 * on the report is in. Converting it would move the 23:30 calls into tomorrow.
 * Accepts an Excel serial, `YYYY-MM-DD HH:MM[:SS]`, and day-first
 * `DD/MM/YYYY HH:MM[:SS] [am|pm]`.
 */
function toDT(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    if (Number.isNaN(d.getTime())) return null;
    return { d: iso(d), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { d: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, h: +m[4], m: +m[5], s: +(m[6] || 0) };
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let h = +m[4];
    if (m[7]) { const pm = /pm/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    return { d: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, h, m: +m[5], s: +(m[6] || 0) };
  }
  return null;
}

/* A date that is a real calendar date. toDT's regexes accept 2026-13-45. */
const realDate = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && iso(t) === d;
};

function statusCode(s) {
  s = String(s || '').toUpperCase();
  if (/NO ?ANSWER|NOANSWER|MISSED|ABANDON/.test(s)) return 1;
  if (/ANSWER/.test(s)) return 0;
  if (/BUSY/.test(s)) return 2;
  if (/FAIL|CONGEST|CHANUNAVAIL/.test(s)) return 3;
  return 4;
}

/**
 * Calls from a Grandstream CDR — the source's buildCallsGS, line for line.
 *
 * Legs are grouped by session. An inbound call is ANSWERED when a leg to an
 * agent extension (6000–6499) says ANSWERED, and the earliest such leg is the
 * agent. Otherwise it rang in a queue and nobody picked up (1), heard the
 * out-of-hours announcement (5), or ended in the IVR (6). Wait is answer time
 * minus queue entry, same day only.
 */
function buildCallsGS(head, body) {
  const hn = head.map(norm);
  const ix = (k) => hn.indexOf(k);
  const I = {
    cdr: ix('cdr'), src: ix('caller number'), dst: ix('callee number'), st: ix('start time'),
    an: ix('answer time'), talk: ix('talk time'), stat: ix('call status'), type: ix('call type'),
    dext: ix('dest channel extension'), act: ix('action type'), sess: ix('session'),
  };
  const S = new Map();
  for (const r of body) {
    const k = String(r[I.sess]);
    if (!S.has(k)) S.set(k, []);
    S.get(k).push(r);
  }
  const secs = (v) => { const t = toDT(v); return t ? (t.h * 3600 + t.m * 60 + t.s) : null; };
  const out = [];
  for (const legs of S.values()) {
    const mains = legs.filter((r) => r[I.cdr] === 'main_cdr');
    const m = mains[0] || legs[0];
    const type = String(m[I.type]);
    const t = toDT(legs.map((r) => r[I.st]).sort()[0]);
    if (!t || !realDate(t.d)) continue;
    if (type === 'Outbound') {
      const ext = digits(m[I.src]);
      const num = digits(m[I.dst]).slice(-10);
      const ok = String(m[I.stat]).toUpperCase() === 'ANSWERED';
      out.push([t.d, t.h, 2, ext, ok ? 1 : 0, -1, ok ? (toSec(m[I.talk]) || 0) : 0, num, '', ok ? 0 : 1]);
      continue;
    }
    if (type !== 'Inbound') continue;
    const num = digits(m[I.src]).slice(-10);
    const ql = legs.find((r) => /QUEUE\[\d+\]/.test(r[I.act])
      && String(r[I.dext]) === (String(r[I.act]).match(/QUEUE\[(\d+)\]/) || [])[1]);
    const q = (legs.map((r) => String(r[I.act]).match(/QUEUE\[(\d+)\]/)).find(Boolean) || [])[1] || '';
    const ag = legs.filter((r) => /^6[0-4]\d\d$/.test(String(r[I.dext]))
      && String(r[I.stat]).toUpperCase() === 'ANSWERED')
      .sort((a, b) => (String(a[I.an]) < String(b[I.an]) ? -1 : 1))[0];
    let st;
    let ext = '';
    let wait = -1;
    let talk = 0;
    if (ag) {
      st = 0;
      ext = String(ag[I.dext]);
      talk = toSec(ag[I.talk]) || 0;
      const a = secs(ag[I.an]);
      const b = secs((ql || legs.find((r) => /QUEUE/.test(r[I.act])) || m)[I.st]);
      if (a != null && b != null && a >= b) wait = a - b;
    } else if (q) st = 1;
    else if (legs.some((r) => /^ANNOUNCE/.test(r[I.act]))) st = 5;
    else st = 6;
    out.push([t.d, t.h, 1, ext, ag ? 1 : 0, wait, talk, num, q, st]);
  }
  return hashAll(out);
}

/** Calls from any other CDR, through the guessed column map — the source's buildCalls. */
function buildCalls(body, m) {
  const g = (r, k) => (m[k] >= 0 ? r[m[k]] : '');
  let groups;
  if (m.sess >= 0) {
    const mp = new Map();
    /* The source used Math.random() as the key for a leg with no session, so
       each stands alone. A counter does the same thing deterministically. */
    let n = 0;
    for (const r of body) {
      const k = String(g(r, 'sess')) || `__solo${n++}`;
      if (!mp.has(k)) mp.set(k, []);
      mp.get(k).push(r);
    }
    groups = [...mp.values()];
  } else groups = body.map((r) => [r]);

  const out = [];
  for (const legs of groups) {
    const first = legs[0];
    const t = toDT(g(first, 'start'));
    if (!t || !realDate(t.d)) continue;
    const src = g(first, 'src');
    const dst = legs.map((r) => g(r, 'dst')).find((x) => x !== '') || '';
    let dir = 0;
    if (!isInt(src) && digits(src).length >= 7) dir = 1;
    else if (isInt(src) && digits(dst).length >= 7) dir = 2;
    if (!dir) continue;
    const ansLeg = legs.find((r) => statusCode(g(r, 'disp')) === 0);
    const st = ansLeg ? 0 : Math.min(...legs.map((r) => statusCode(g(r, 'disp'))));
    const L2 = ansLeg || first;
    let ext = '';
    if (dir === 2) ext = digits(src);
    else {
      const a = digits(g(L2, 'agent'));
      ext = a && a.length <= 5 ? a : (isInt(g(L2, 'dst')) && ansLeg ? digits(g(L2, 'dst')) : '');
    }
    let wait = -1;
    if (ansLeg && m.answer >= 0) {
      const a = toDT(g(ansLeg, 'answer'));
      if (a && a.d === t.d) wait = Math.max(0, (a.h - t.h) * 3600 + (a.m - t.m) * 60 + (a.s - t.s));
    }
    const talk = ansLeg ? (toSec(g(ansLeg, 'talk')) ?? toSec(g(ansLeg, 'dur')) ?? 0) : 0;
    const q = (String(legs.map((r) => g(r, 'act')).join(' ')).match(/QUEUE\[(\d+)\]/i) || [])[1] || '';
    const num = digits(dir === 1 ? src : dst).slice(-10);
    out.push([t.d, t.h, dir, ext, st === 0 ? 1 : 0, wait, talk, num, q, st]);
  }
  return hashAll(out);
}

/* The number becomes its hash here and nowhere later. A number shorter than
   ten digits hashes to nothing rather than to the hash of a fragment. */
function hashAll(out) {
  for (const c of out) c[7] = c[7].length === 10 ? sha12(c[7]) : '';
  return out;
}

/**
 * Read a file into calls.
 *
 * Refuses rather than guessing when it cannot tell what the file is, and
 * refuses a file at the reader's row limit: sheet.js stops reading at
 * MAX_ROWS without saying so, and a week cut short on its last days would pass
 * the Friday check with a hole in it.
 */
function parse(buffer) {
  const located = Sheet.gridOf(buffer);
  const grid = (located.grid || []).map((r) => (r || []).map((c) => (c == null ? '' : c)));
  if (grid.length >= Sheet.MAX_ROWS) {
    throw new Error(`The file has ${Sheet.MAX_ROWS.toLocaleString('en-US')} rows or more, which is `
      + 'as far as the reader goes — the rest would be silently dropped. Export fewer days at a time.');
  }
  /* The header is the row, among the first fifteen, that names the most known
     columns — the source's own scoring, so a title row above it is skipped. */
  let hi = 0;
  let best = -1;
  for (let i = 0; i < Math.min(15, grid.length); i++) {
    const sc = Object.values(guessMap(grid[i])).filter((x) => x >= 0).length;
    if (sc > best) { best = sc; hi = i; }
  }
  if (!grid.length || best < 1) throw new Error('No header row this reader recognises.');
  const head = grid[hi].map(String);
  const body = grid.slice(hi + 1).filter((r) => r.some((c) => c !== ''));
  const hn = head.map(norm);

  if (GS_HEADERS.every((k) => hn.includes(k))) {
    return { format: 'grandstream', sheet: located.sheet, legs: body.length, calls: buildCallsGS(head, body) };
  }
  const m = guessMap(head);
  const missing = FIELDS.filter(([k, , req]) => req && m[k] < 0).map(([, label]) => label);
  if (missing.length) {
    throw new Error(`This is not a Grandstream UCM CDR, and these columns could not be found: `
      + `${missing.join(', ')}. Export it from UCM → CDR → Export, which this reads directly.`);
  }
  return { format: 'generic', sheet: located.sheet, legs: body.length, calls: buildCalls(body, m), map: m };
}

/* ----------------------------------------------------------------- weeks */

const addDays = (d, n) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
};
/** The Sunday that starts this date's week. Sunday to Saturday, as the source. */
const weekStartOf = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - t.getUTCDay());
  return iso(t);
};

/** What a file holds, without writing anything. */
function summarize(parsed, required) {
  const calls = parsed.calls;
  const ds = calls.map((c) => c[0]).sort();
  const byWeek = new Map();
  for (const c of calls) {
    const w = weekStartOf(c[0]);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(c);
  }
  const weeks = [...byWeek.entries()].sort().map(([start, rs]) => {
    const days = rs.map((r) => r[0]).sort();
    return {
      start,
      end: addDays(start, 6),
      calls: rs.length,
      inbound: rs.filter((r) => r[2] === 1).length,
      outbound: rs.filter((r) => r[2] === 2).length,
      first: days[0],
      last: days[days.length - 1],
    };
  });
  const req = required ? weeks.find((w) => w.start === required.from) : null;
  return {
    format: parsed.format,
    legs: parsed.legs,
    calls: calls.length,
    inbound: calls.filter((c) => c[2] === 1).length,
    outbound: calls.filter((c) => c[2] === 2).length,
    answered: calls.filter((c) => c[2] === 1 && c[4]).length,
    from: ds[0] || null,
    to: ds[ds.length - 1] || null,
    weeks,
    /* Whether this file would open the report — the same rule cc-gate applies. */
    required: required ? {
      ...required,
      calls: req ? req.calls : 0,
      reachesFriday: !!(req && req.last >= addDays(required.to, -1)),
    } : null,
  };
}

/* -------------------------------------------------------------- roll-ups */

/**
 * The day, queue, agent and hour figures the report reads, derived from calls.
 *
 * DEFINITIONS, matched to how the August pack's rows are read so the two
 * sources mean the same thing side by side:
 *
 *   PbxDay.inboundCalls is calls OFFERED TO A PERSON — reached a queue, or were
 *   answered. A call that ended in the IVR or heard the out-of-hours
 *   announcement was never offered to anybody, and counting it as unanswered
 *   blames the agents for the menu. The source page's answer rate uses the same
 *   denominator.
 *
 *   PbxAgentDay.offered is left at 0. The CDR says which agent ANSWERED, not
 *   which agents a call rang on the way, so an agent's answer rate is not in the
 *   data — and writing `offered = answered` would print 100% for everybody.
 *
 *   PbxHour counts EVERY inbound call, IVR and out-of-hours included, because
 *   the hourly chart is about when calls arrive, and the ones that arrive when
 *   nobody is there are the point of it.
 */
function rollups(calls) {
  const day = new Map();
  const queue = new Map();
  const agent = new Map();
  const hour = new Map();
  const get = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
  for (const [d, h, dir, ext, ans, , talk, , q, st] of calls) {
    const D = get(day, d, () => ({ date: d, inboundCalls: 0, inboundAnswered: 0, dials: 0 }));
    if (dir === 1) {
      const offered = !!q || !!ans;
      if (offered) D.inboundCalls += 1;
      if (ans) D.inboundAnswered += 1;
      if (q) {
        const Q = get(queue, `${q}|${d}`, () => ({ queue: q, date: d, offered: 0, answered: 0, abandoned: 0 }));
        Q.offered += 1;
        if (ans) Q.answered += 1; else Q.abandoned += 1;
      }
      const H = get(hour, `${d}|${h}`, () => ({ date: d, hour: h, calls: 0, answered: 0 }));
      H.calls += 1;
      if (ans) H.answered += 1;
      if (ans && ext) {
        const A = get(agent, `${ext}|${d}`, () => ({ ext, date: d, offered: 0, answered: 0, talkInSec: 0, dials: 0, connected: 0, talkOutSec: 0 }));
        A.answered += 1;
        A.talkInSec += talk || 0;
      }
    } else if (dir === 2) {
      D.dials += 1;
      if (ext) {
        const A = get(agent, `${ext}|${d}`, () => ({ ext, date: d, offered: 0, answered: 0, talkInSec: 0, dials: 0, connected: 0, talkOutSec: 0 }));
        A.dials += 1;
        if (ans) { A.connected += 1; A.talkOutSec += talk || 0; }
      }
    }
    void st;
  }
  return {
    days: [...day.values()],
    queues: [...queue.values()],
    agents: [...agent.values()],
    hours: [...hour.values()],
  };
}

/* ---------------------------------------------------------------- commit */

const D = (s) => new Date(`${s}T00:00:00Z`);

/**
 * Store the file, replacing every week it touches.
 *
 * WHOLE WEEKS, as the source did: a week in the file replaces everything held
 * for that week — its calls, and the day/queue/agent/hour roll-ups of all seven
 * of its days — including days the new file happens not to have. Re-uploading
 * a week can therefore never double it. Only `source: 'upload'` is touched; the
 * frozen August seed is never deleted, and preferUpload() already makes an
 * upload win over it for any day both cover.
 */
async function commit(parsed, { filename = null, actor = null } = {}) {
  const calls = parsed.calls;
  if (!calls.length) throw new Error('No inbound or outbound calls in this file.');
  const weekStarts = [...new Set(calls.map((c) => weekStartOf(c[0])))].sort();
  const allDays = weekStarts.flatMap((w) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w, i)));
  const span = { gte: D(allDays[0]), lte: D(allDays[allDays.length - 1]) };
  const inWeeks = { in: allDays.map(D) };
  const R = rollups(calls);
  const ds = calls.map((c) => c[0]).sort();

  return prisma.$transaction(async (tx) => {
    const log = await tx.dataUpload.create({
      data: {
        kind: 'ucm:upload',
        filename,
        actor,
        rangeFrom: D(ds[0]),
        rangeTo: D(ds[ds.length - 1]),
        rowsWritten: 0,
        notes: `${parsed.format} CDR · ${parsed.legs} legs → ${calls.length} calls · weeks ${weekStarts.join(', ')}`
          + ' · each week replaced whole',
      },
    });
    await tx.pbxCall.deleteMany({ where: { source: 'upload', weekStart: { in: weekStarts.map(D) } } });
    await tx.pbxDay.deleteMany({ where: { source: 'upload', date: inWeeks } });
    await tx.pbxQueueDay.deleteMany({ where: { source: 'upload', date: inWeeks } });
    await tx.pbxAgentDay.deleteMany({ where: { source: 'upload', date: inWeeks } });
    await tx.pbxHour.deleteMany({ where: { source: 'upload', date: inWeeks } });
    void span;

    const CH = 2000;
    const callRows = calls.map((c) => ({
      weekStart: D(weekStartOf(c[0])), date: D(c[0]), hour: c[1], direction: c[2], ext: c[3],
      answered: !!c[4], waitSec: c[5], talkSec: c[6] || 0, phoneHash: c[7] || null, queue: c[8],
      status: c[9], format: parsed.format, source: 'upload', uploadId: log.id,
    }));
    for (let i = 0; i < callRows.length; i += CH) await tx.pbxCall.createMany({ data: callRows.slice(i, i + CH) });
    await tx.pbxDay.createMany({ data: R.days.map((r) => ({ ...r, date: D(r.date), source: 'upload' })) });
    if (R.queues.length) await tx.pbxQueueDay.createMany({ data: R.queues.map((r) => ({ ...r, date: D(r.date), source: 'upload' })) });
    if (R.agents.length) await tx.pbxAgentDay.createMany({ data: R.agents.map((r) => ({ ...r, date: D(r.date), source: 'upload' })) });
    if (R.hours.length) await tx.pbxHour.createMany({ data: R.hours.map((r) => ({ ...r, date: D(r.date), source: 'upload' })) });

    const rowsWritten = callRows.length + R.days.length + R.queues.length + R.agents.length + R.hours.length;
    await tx.dataUpload.update({ where: { id: log.id }, data: { rowsWritten } });
    return { uploadId: log.id, weeks: weekStarts, calls: callRows.length, rowsWritten };
  }, { timeout: 120000 });
}

module.exports = {
  parse, summarize, rollups, commit,
  buildCallsGS, buildCalls, guessMap, toDT, toSec, statusCode, sha12,
  weekStartOf, addDays, FIELDS, GS_HEADERS,
};
