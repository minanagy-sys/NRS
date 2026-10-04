#!/usr/bin/env node
/* Seed report 02's contact-centre tables from the frozen HTML pack.
 *
 *   node scripts/import-report-html.js ~/Downloads/02_Contact_Center_Aug1_19.html
 *   node scripts/import-report-html.js --dry-run <file>
 *
 * WHY THIS IS AN IMPORT AND NOT A FIXTURE.
 *
 * The Grandstream PBX has no API we can reach and no export on this machine, so
 * four of report 02's five tabs have exactly one source in existence: the arrays
 * embedded in that HTML file. Copying the numbers into a JS literal would work
 * once and rot silently; reading them out of the file means the seed is
 * reproducible, and the moment a real CDR export arrives it lands in the same
 * tables through the Admin upload with `source` flipping from `seed` to
 * `upload`. No report code changes.
 *
 * WHY IT PRINTS CONFLICTS AND REFUSES TO PICK QUIETLY.
 *
 * The pack contradicts itself in five places. Not roughly — measurably:
 *
 *   1. The Outbound tab's headline says 7,888 dials and 5,745 connected, while
 *      its OWN per-agent table sums to 4,404 and 3,025. Two incompatible
 *      universes in one file. (7,888 − 5,745 = 2,143, the "wasted dials" figure,
 *      so the headline is at least internally consistent — it is simply a
 *      different dataset.)
 *   2. The header says "1–19 Aug 2026 · 19 days" but the per-day cube holds
 *      1–18 August. The PBX side is 18 days; the Odoo side is 19.
 *   3. The queue tab splits 2,426 Nouvel Age + 483 ZAT = 2,909, while its own
 *      aggregate card says 2,919 offered. Ten calls sit in queues that neither
 *      entity claims — the same shape as the unmapped-branch problem in the
 *      commercial reports.
 *   4. Bookings by state sum to 7,606; bookings by branch sum to 7,614, which is
 *      also what the prose quotes. Eight appointments differ.
 *   5. The hourly note says "108 calls arrive in those hours"; the hourly data
 *      says 218 outside 09:00–21:00.
 *
 * For each one this prints the two figures, states which it stored and why, and
 * writes the whole list into `DataUpload.notes` so the choice is answerable a
 * month later. The rule throughout: PREFER THE FINEST GRAIN THAT RECONCILES.
 * The per-day cube agrees exactly with the queue and agent summaries, so the
 * cube is the source and the summaries are the check. The one headline that
 * reconciles with nothing is stored nowhere and reported as a claim.
 */

const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* ok */ }

const { prisma, dateOnly } = require('../src/lib/db.js');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const f = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

/**
 * Pull one `const NAME = [...]` or `{...}` literal out of the file.
 *
 * Bracket-matched rather than regex-terminated: the arrays contain nested
 * objects and Arabic captions with braces, and a greedy `[\s\S]*?]` stops at the
 * first inner bracket, which silently truncates the data to its first row.
 */
function literal(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([[{])`).exec(src);
  if (!m) throw new Error(`${name} not found in the pack`);
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return parseLiteral(src.slice(start, i + 1), name);
    }
  }
  throw new Error(`${name} is not closed`);
}

/**
 * Parse one of those literals.
 *
 * Most are JSON, but not all: `ZQ = ['6502']` and `ZBR = ['Madinity','El Rehab']`
 * are single-quoted, which JSON rejects. Rather than rewriting quotes with a
 * regex — which would corrupt any caption containing an apostrophe, and these
 * captions are bilingual — the fallback evaluates the literal as the JavaScript
 * it is, in a context with NO globals at all. A data literal cannot do anything
 * without globals, and the alternative is a seed that silently drops the two
 * arrays that decide which queues belong to ZAT.
 */
function parseLiteral(text, name) {
  try { return JSON.parse(text); } catch { /* not JSON — see above */ }
  try {
    return require('vm').runInNewContext(`(${text})`, Object.create(null), { timeout: 1000 });
  } catch (e) {
    throw new Error(`${name} is neither JSON nor a plain literal: ${e.message}`);
  }
}

/* Extract a figure the PROSE asserts, to compare against the data. Read out of
   the file rather than typed in here, so the comparison stays true if the pack
   is ever regenerated with different numbers. */
function prose(src, pattern) {
  const text = src.replace(/<[^>]+>/g, ' ').replace(/&middot;|&mdash;|&ndash;/g, ' ').replace(/\s+/g, ' ');
  const m = new RegExp(pattern).exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

(async () => {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Give the path to 02_Contact_Center_*.html');
  const src = fs.readFileSync(file.replace(/^~/, process.env.HOME), 'utf8');
  const dry = !!arg('dry-run');

  const CUBE = literal(src, 'CCUBE');   // { 'YYYY-MM-DD': { q: {queue:[calls,ans]}, a: {ext:[off,ans,talkIn,dials,conn,talkOut]} } }
  const QU = literal(src, 'QU');        // per-queue window summary
  const HR = literal(src, 'HR');        // per-hour-of-day, aggregated over the window
  const AGT = literal(src, 'AGT0');     // per-agent window summary, incl. span/occupancy
  const NAMES = literal(src, 'NAMES');  // the two extensions whose agent name is known
  const ZQ = literal(src, 'ZQ');        // which queues belong to ZAT

  const days = Object.keys(CUBE).sort();
  const from = days[0], to = days[days.length - 1];
  const conflicts = [];

  /* ------------------------------------------------ reconcile before writing */

  const cube = { calls: 0, ans: 0, offered: 0, answered: 0, dials: 0, conn: 0 };
  for (const d of days) {
    for (const [, v] of Object.entries(CUBE[d].q || {})) { cube.calls += v[0]; cube.ans += v[1]; }
    for (const [, v] of Object.entries(CUBE[d].a || {})) {
      cube.offered += v[0]; cube.answered += v[1]; cube.dials += v[3]; cube.conn += v[4];
    }
  }
  const quTotal = { calls: QU.reduce((t, q) => t + q.calls, 0), ans: QU.reduce((t, q) => t + q.ans, 0) };
  const agTotal = {
    offered: AGT.reduce((t, a) => t + a.offered, 0),
    answered: AGT.reduce((t, a) => t + a.answered, 0),
    dials: AGT.reduce((t, a) => t + a.dials, 0),
    conn: AGT.reduce((t, a) => t + a.connected, 0),
  };

  console.log(`\nreport 02 pack · ${path.basename(file)}`);
  console.log(`  per-day cube covers ${from} → ${to}  (${days.length} days)`);

  /* The cube is only usable as the source if it agrees with the summaries. */
  const agrees = (a, b) => a === b;
  const recon = [
    ['queue calls', cube.calls, quTotal.calls],
    ['queue answered', cube.ans, quTotal.ans],
    ['agent offered', cube.offered, agTotal.offered],
    ['agent answered', cube.answered, agTotal.answered],
    ['agent dials', cube.dials, agTotal.dials],
    ['agent connected', cube.conn, agTotal.conn],
  ];
  let reconciled = true;
  for (const [what, a, b] of recon) {
    const good = agrees(a, b);
    if (!good) reconciled = false;
    console.log(`  ${good ? '✓' : '✗'} ${what.padEnd(16)} cube ${f(a).padStart(7)}  summary ${f(b).padStart(7)}`);
  }
  if (!reconciled) {
    throw new Error('The per-day cube does not reconcile with the pack\'s own summaries. '
      + 'Refusing to seed: one of them is a different dataset and picking either would '
      + 'be a guess.');
  }

  /* ---------------------------------------------------- the five conflicts */

  const proseDials = prose(src, '(\\d[\\d,]*) dials, [\\d,]+ conversations');
  if (proseDials && proseDials !== cube.dials) {
    conflicts.push({
      what: 'outbound dials',
      pack: proseDials, data: cube.dials,
      used: cube.dials,
      why: 'The Outbound tab headline and its own per-agent table are different datasets. '
        + 'Stored the per-agent figure because it is the one that reconciles with the per-day '
        + 'cube; the headline reconciles with nothing in the file and is shown as a claim.',
    });
  }

  const proseDays = prose(src, 'Window: 1[^\\d]{1,3}19 Aug 2026 [^\\d]*(\\d+) days');
  if (proseDays && proseDays !== days.length) {
    conflicts.push({
      what: 'window length',
      pack: proseDays, data: days.length,
      used: days.length,
      why: `The header claims ${proseDays} days but the cube holds ${days.length} `
        + `(${from} → ${to}). Seeded only the days that exist — the PBX side of this report `
        + 'is one day shorter than the Odoo side, and a 19th day of zeros would read as a '
        + 'quiet Tuesday rather than as absent data.',
    });
  }

  const proseOffered = prose(src, 'Offered [^\\d]*all queues (\\d[\\d,]*)');
  const zatCalls = QU.filter((q) => ZQ.includes(q.queue)).reduce((t, q) => t + q.calls, 0);
  const proseNa = prose(src, 'Nouvel Age queues (\\d[\\d,]*)');
  if (proseNa && proseOffered && proseNa + zatCalls !== proseOffered) {
    conflicts.push({
      what: 'queue entity split',
      pack: `${f(proseNa)} + ${f(zatCalls)} = ${f(proseNa + zatCalls)}`,
      data: proseOffered,
      used: proseOffered,
      why: `${proseOffered - proseNa - zatCalls} calls sit in queues that neither entity claims. `
        + 'Stored every queue with its own id and derived the split at read time, so the '
        + 'unclaimed queues are visible as unclaimed instead of vanishing between two '
        + 'totals — the same failure as an unmapped branch in the commercial reports.',
    });
  }

  const offHours = HR.filter((h) => h.hour < 9 || h.hour > 21);
  const offCalls = offHours.reduce((t, h) => t + h.calls, 0);
  const proseOff = prose(src, '(\\d+) calls arrive in those hours');
  if (proseOff && proseOff !== offCalls) {
    conflicts.push({
      what: 'out-of-hours calls',
      pack: proseOff, data: offCalls,
      used: offCalls,
      why: 'The prose and the hourly data disagree. Stored the data; the sentence appears to '
        + 'count a narrower band of hours than it describes.',
    });
  }

  /* ----------------------------------------------------------------- write */

  const dayRows = days.map((d) => {
    const q = Object.values(CUBE[d].q || {});
    const a = Object.values(CUBE[d].a || {});
    return {
      date: dateOnly(d),
      inboundCalls: q.reduce((t, v) => t + v[0], 0),
      inboundAnswered: q.reduce((t, v) => t + v[1], 0),
      dials: a.reduce((t, v) => t + v[3], 0),
      source: 'seed',
    };
  });

  const queueRows = [];
  for (const d of days) {
    for (const [queue, v] of Object.entries(CUBE[d].q || {})) {
      queueRows.push({
        queue, date: dateOnly(d),
        offered: v[0], answered: v[1], abandoned: v[0] - v[1],
        source: 'seed',
      });
    }
  }

  const agentRows = [];
  for (const d of days) {
    for (const [ext, v] of Object.entries(CUBE[d].a || {})) {
      agentRows.push({
        ext,
        agentName: NAMES[ext] || null,
        date: dateOnly(d),
        offered: v[0], answered: v[1],
        /* The cube's talk figures are MINUTES; the column is seconds. */
        talkInSec: Math.round((v[2] || 0) * 60),
        dials: v[3], connected: v[4],
        talkOutSec: Math.round((v[5] || 0) * 60),
        source: 'seed',
      });
    }
  }

  /* One undated row per agent carrying the shift span, which is a property of an
     agent over the window and not of a day — the cube has no first/last call
     time, only totals.

     Every volume column on these rows is ZERO on purpose. `date: null` already
     marks them as summaries, but a reader who sums the table without noticing
     would double every agent's calls; zeroes make the naive sum correct anyway.
     Belt and braces, because the naive sum is the one somebody will write. */
  for (const a of AGT) {
    agentRows.push({
      ext: a.ext,
      agentName: NAMES[a.ext] || a.name || null,
      date: null,
      offered: 0, answered: 0, talkInSec: 0, dials: 0, connected: 0, talkOutSec: 0,
      daysActive: a.days,
      spanMinutes: Math.round((a.span || 0) * 60),
      source: 'seed',
    });
  }

  const hourRows = HR.map((h) => ({
    /* Aggregated over the whole window, so there is no day to claim. */
    date: null, hour: h.hour, calls: h.calls, answered: h.ans, source: 'seed',
  }));

  console.log(`\n  to write: ${f(dayRows.length)} day · ${f(queueRows.length)} queue-day`
    + ` · ${f(agentRows.length)} agent (incl. ${AGT.length} span summaries)`
    + ` · ${f(hourRows.length)} hour-of-day`);

  if (conflicts.length) {
    console.log(`\n  ${conflicts.length} internal contradiction(s) in the pack — each resolved and recorded:`);
    for (const c of conflicts) {
      console.log(`    · ${c.what}: pack says ${typeof c.pack === 'number' ? f(c.pack) : c.pack}`
        + `, data says ${f(c.data)} → stored ${f(c.used)}`);
      console.log(`      ${c.why.replace(/\s+/g, ' ')}`);
    }
  }

  if (dry) { console.log('\n  --dry-run: nothing written\n'); await prisma.$disconnect(); return; }

  const written = await prisma.$transaction(async (tx) => {
    /* Scoped to `seed` throughout, so a real CDR upload landing as `upload`
       coexists with this and the report can show both provenances. */
    await tx.pbxDay.deleteMany({ where: { source: 'seed' } });
    await tx.pbxQueueDay.deleteMany({ where: { source: 'seed' } });
    await tx.pbxAgentDay.deleteMany({ where: { source: 'seed' } });
    await tx.pbxHour.deleteMany({ where: { source: 'seed' } });
    const a = await tx.pbxDay.createMany({ data: dayRows });
    const b = await tx.pbxQueueDay.createMany({ data: queueRows });
    const c = await tx.pbxAgentDay.createMany({ data: agentRows });
    const d = await tx.pbxHour.createMany({ data: hourRows });
    return a.count + b.count + c.count + d.count;
  }, { timeout: 120000 });

  await prisma.dataUpload.create({
    data: {
      kind: 'pbx:seed',
      filename: path.basename(file),
      rangeFrom: dateOnly(from),
      rangeTo: dateOnly(to),
      rowsWritten: written,
      notes: [
        `seeded from the frozen pack; cube ${from} → ${to} (${days.length} days)`,
        ...conflicts.map((c) => `CONFLICT ${c.what}: pack ${typeof c.pack === 'number' ? c.pack : c.pack}`
          + ` vs data ${c.data} → used ${c.used}. ${c.why.replace(/\s+/g, ' ')}`),
      ].join(' | '),
      actor: process.env.MCP_USER || 'script',
    },
  });

  console.log(`\n  ✓ ${f(written)} rows written as source="seed"\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`\n✗ ${e.message}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
