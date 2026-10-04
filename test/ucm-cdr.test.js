/**
 * The weekly UCM upload, and the lock it opens.
 *
 *   node test/ucm-cdr.test.js
 *
 * WHY THIS FILE EXISTS. The Contact Centre report locks every Sunday until last
 * week's UCM export is uploaded. If the importer misreads that file, the lock
 * either never opens (the report is gone for good) or opens on a file that is
 * not the right week (the lock means nothing). Both failures are silent from
 * the outside, so both are pinned here.
 *
 * Everything written goes into a test week in 2030 — no real upload can ever
 * share it — and is deleted in `finally`, whether the assertions pass or not.
 */

const assert = require('assert');
const crypto = require('crypto');
const { prisma } = require('../src/lib/db.js');
const U = require('../src/lib/ucm-cdr.js');
const G = require('../src/lib/cc-gate.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const HEAD = 'cdr,session,call type,caller number,callee number,start time,answer time,talk time,call status,dest channel extension,action type';
const csv = (rows) => Buffer.from([HEAD, ...rows].join('\n'));

/* One of each kind of call the Grandstream parser distinguishes. */
const sample = (d1, d2, d5) => csv([
  `main_cdr,s1,Inbound,01001234567,6514,${d1} 10:00:00,,0,ANSWERED,,QUEUE[6514]`,
  `sub_cdr,s1,Inbound,01001234567,6006,${d1} 10:00:05,${d1} 10:00:20,95,ANSWERED,6006,DIAL`,
  `main_cdr,s2,Inbound,01112223334,6514,${d1} 11:00:00,,0,NO ANSWER,,QUEUE[6514]`,
  `main_cdr,s3,Inbound,01223334445,6500,${d1} 23:10:00,,0,ANSWERED,,ANNOUNCE`,
  `main_cdr,s4,Outbound,6009,01005556667,${d2} 12:00:00,${d2} 12:00:09,40,ANSWERED,,DIAL`,
  `main_cdr,s5,Outbound,6009,01005556668,${d5} 13:00:00,,0,NO ANSWER,,DIAL`,
]);

(async () => {
  console.log('\nreading a Grandstream UCM CDR');

  const p = U.parse(sample('2026-09-28', '2026-09-29', '2026-10-02'));

  await check('the file is recognised as Grandstream, not mapped by guesswork', async () => {
    assert.strictEqual(p.format, 'grandstream');
    assert.strictEqual(p.legs, 6);
    assert.strictEqual(p.calls.length, 5, 'six legs, five calls — s1 has two legs');
  });
  await check('an answered call names the agent, the queue, the wait and the talk', async () => {
    const c = p.calls.find((x) => x[3] === '6006');
    assert.deepStrictEqual([c[0], c[1], c[2], c[4], c[5], c[6], c[8], c[9]],
      ['2026-09-28', 10, 1, 1, 20, 95, '6514', 0]);
  });
  await check('a call that rang in a queue and was not picked up is status 1, not answered', async () => {
    const c = p.calls.find((x) => x[1] === 11);
    assert.strictEqual(c[4], 0);
    assert.strictEqual(c[9], 1);
  });
  await check('the out-of-hours announcement is its own status, not an abandoned call', async () => {
    const c = p.calls.find((x) => x[1] === 23);
    assert.strictEqual(c[9], 5);
  });
  await check('outbound: the extension dialled, connected or not', async () => {
    const out = p.calls.filter((x) => x[2] === 2);
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((x) => x[3] === '6009'));
    assert.deepStrictEqual(out.map((x) => x[4]).sort(), [0, 1]);
  });
  await check('the number is never kept — only SHA-256 of its last ten digits, 12 hex', async () => {
    const c = p.calls.find((x) => x[3] === '6006');
    const want = crypto.createHash('sha256').update('1001234567').digest('hex').slice(0, 12);
    assert.strictEqual(c[7], want);
    assert.ok(!JSON.stringify(p.calls).includes('1001234567'), 'a raw number survived parsing');
  });

  console.log('\nthe roll-ups the report reads');
  const R = U.rollups(p.calls);
  await check('a call that never reached a person is not "offered" — IVR and out-of-hours are excluded', async () => {
    const d = R.days.find((x) => x.date === '2026-09-28');
    assert.strictEqual(d.inboundCalls, 2, 'answered + abandoned-in-queue, not the 23:10 announcement');
    assert.strictEqual(d.inboundAnswered, 1);
  });
  await check('  but the hourly profile keeps it — that is when nobody was there', async () => {
    assert.ok(R.hours.some((h) => h.date === '2026-09-28' && h.hour === 23 && h.calls === 1));
  });
  await check('the queue adds up: offered = answered + abandoned', async () => {
    const q = R.queues.find((x) => x.queue === '6514');
    assert.strictEqual(q.offered, q.answered + q.abandoned);
    assert.deepStrictEqual([q.offered, q.answered, q.abandoned], [2, 1, 1]);
  });
  await check('an agent\'s "offered" stays 0 — the CDR says who answered, not who it rang', async () => {
    const a = R.agents.find((x) => x.ext === '6006');
    assert.strictEqual(a.offered, 0);
    assert.strictEqual(a.answered, 1);
  });

  console.log('\nrefusing what it cannot read');
  await check('a file with no recognisable header is refused, not imported as nothing', async () => {
    assert.throws(() => U.parse(Buffer.from('a,b,c\n1,2,3\n')), /No header row/);
  });
  await check('a non-Grandstream CDR missing a required column names the column', async () => {
    assert.throws(() => U.parse(Buffer.from('start time,caller number,status\n2026-09-28 10:00,0100,ANSWERED\n')),
      /Callee number/);
  });
  await check('a generic CDR with the right columns is read', async () => {
    const g = U.parse(Buffer.from([
      'calldate,src,dst,disposition,billsec,dstanswer',
      '2026-09-28 10:00:00,01001234567,6514,ANSWERED,60,6006',
      '2026-09-28 10:05:00,6009,01005556667,NO ANSWER,0,',
    ].join('\n')));
    assert.strictEqual(g.format, 'generic');
    assert.strictEqual(g.calls.length, 2);
    assert.strictEqual(g.calls.find((c) => c[2] === 1)[3], '6006');
  });
  await check('an impossible date is dropped rather than stored as a real day', async () => {
    const bad = U.parse(csv(['main_cdr,x1,Outbound,6009,01005556667,2026-13-45 12:00:00,,0,ANSWERED,,DIAL']));
    assert.strictEqual(bad.calls.length, 0);
  });

  /* ------------------------------------------------------------------
     The lock, end to end, in a week nobody will ever upload for real.
     ------------------------------------------------------------------ */
  console.log('\nthe weekly lock');

  const W0 = U.weekStartOf('2030-01-09');          // a Sunday in 2030
  const day = (n) => U.addDays(W0, n);             // 0 = Sunday … 6 = Saturday
  const today = U.addDays(W0, 7);                  // the next Sunday: W0 is now "last week"
  const written = [];

  const cleanup = async () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(`${day(i)}T00:00:00Z`));
    await prisma.pbxCall.deleteMany({ where: { weekStart: new Date(`${W0}T00:00:00Z`) } });
    for (const m of ['pbxDay', 'pbxQueueDay', 'pbxAgentDay', 'pbxHour']) {
      await prisma[m].deleteMany({ where: { source: 'upload', date: { in: days } } });
    }
    if (written.length) await prisma.dataUpload.deleteMany({ where: { id: { in: written } } });
  };

  try {
    await cleanup();

    await check('the required week is the last complete Sunday–Saturday', async () => {
      assert.deepStrictEqual(G.requiredWeek(today), { from: W0, to: day(6) });
      assert.deepStrictEqual(G.requiredWeek(U.addDays(today, 6)), { from: W0, to: day(6) },
        'Saturday still wants the same week');
      assert.deepStrictEqual(G.requiredWeek(U.addDays(today, 7)).from, today,
        'the next Sunday moves on');
    });

    await check('with nothing uploaded the report is locked, and says "missing"', async () => {
      const s = await G.state({ today });
      assert.strictEqual(s.locked, true);
      assert.strictEqual(s.reason, 'missing');
      assert.strictEqual(s.held, null);
    });

    /* A week that stops on Wednesday: something is in, but not the week. */
    const short = U.parse(sample(day(1), day(2), day(3)));
    written.push((await U.commit(short, { filename: 'short.csv', actor: 'test' })).uploadId);
    await check('a week that stops before Friday stays locked, and says "short"', async () => {
      const s = await G.state({ today });
      assert.strictEqual(s.locked, true);
      assert.strictEqual(s.reason, 'short');
      assert.strictEqual(s.held.last, day(3));
    });

    /* The whole week, last call on Friday. */
    const full = U.parse(sample(day(1), day(3), day(5)));
    const out = await U.commit(full, { filename: 'full.csv', actor: 'test' });
    written.push(out.uploadId);
    await check('a week reaching Friday OPENS the report', async () => {
      const s = await G.state({ today });
      assert.strictEqual(s.locked, false, JSON.stringify(s));
      assert.strictEqual(s.held.last, day(5));
    });
    await check('  and re-uploading the week REPLACED it — the short upload is gone, not added', async () => {
      const n = await prisma.pbxCall.count({ where: { weekStart: new Date(`${W0}T00:00:00Z`) } });
      assert.strictEqual(n, 5, `${n} calls held; a doubled week would be 10`);
      const wed = await prisma.pbxDay.count({ where: { source: 'upload', date: new Date(`${day(3)}T00:00:00Z`) } });
      assert.strictEqual(wed, 1, 'Wednesday has one day row, not two');
    });
    await check('  and the same file again changes nothing', async () => {
      written.push((await U.commit(full, { filename: 'full-again.csv', actor: 'test' })).uploadId);
      const n = await prisma.pbxCall.count({ where: { weekStart: new Date(`${W0}T00:00:00Z`) } });
      assert.strictEqual(n, 5);
    });
    await check('  and the following Sunday it locks again, for the next week', async () => {
      const s = await G.state({ today: U.addDays(today, 7) });
      assert.strictEqual(s.locked, true);
      assert.strictEqual(s.week.from, today);
    });
    await check('the upload is on record, with the weeks it replaced', async () => {
      const log = await prisma.dataUpload.findUnique({ where: { id: out.uploadId } });
      assert.strictEqual(log.kind, 'ucm:upload');
      assert.ok(log.notes.includes(W0), log.notes);
      assert.ok(log.rowsWritten > 5);
    });
  } finally {
    await cleanup();
  }

  /* ------------------------------------------------------------------
     The route: the server enforces the lock, not the page.
     ------------------------------------------------------------------ */
  console.log('\nthe server enforces it');
  const { build } = require('../src/server.js');
  const app = await build();
  app.log.level = 'silent';
  app.addHook('preHandler', async (req) => { if (!req.user) req.user = { subject: 'test', email: 't@local' }; });
  const now = await G.state();
  const res = await app.inject({ method: 'GET', url: '/api/contact-centre?from=2026-09-01&to=2026-09-30', headers: { 'X-Requested-With': 'fetch' } });
  const body = res.json();
  await check(`with the week ${now.locked ? 'missing' : 'in'}, the API answers ${now.locked ? '423' : '200'}`, async () => {
    assert.strictEqual(res.statusCode, now.locked ? 423 : 200);
  });
  if (now.locked) {
    await check('  a locked answer carries NO figures — there is nothing under the card to uncover', async () => {
      for (const k of ['summary', 'phones', 'crm', 'appointments', 'agents', 'quality']) {
        assert.ok(!(k in body), `${k} leaked through the lock`);
      }
      assert.strictEqual(body.gate.week.from, now.week.from);
      assert.strictEqual(body.canUpload, false, 'a reader without the passphrase is not told to upload');
    });
  }
  await check('the gate endpoint answers 200 either way and names the week', async () => {
    const g = await app.inject({ method: 'GET', url: '/api/contact-centre/gate', headers: { 'X-Requested-With': 'fetch' } });
    assert.strictEqual(g.statusCode, 200);
    assert.strictEqual(g.json().week.from, now.week.from);
  });
  await check('uploading needs the admin passphrase', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/ucm/import',
      headers: { 'X-Requested-With': 'fetch', 'content-type': 'application/json' },
      payload: { base64: sample('2026-09-28', '2026-09-29', '2026-10-02').toString('base64') },
    });
    assert.ok([403, 503].includes(r.statusCode), `got ${r.statusCode}`);
  });
  await app.close();

  const off = await build({ contactCentreGate: false });
  off.log.level = 'silent';
  off.addHook('preHandler', async (req) => { if (!req.user) req.user = { subject: 'test', email: 't@local' }; });
  await check('the lock can be switched off in-process only — the audit\'s build sees figures', async () => {
    const r = await off.inject({ method: 'GET', url: '/api/contact-centre?from=2026-09-01&to=2026-09-30', headers: { 'X-Requested-With': 'fetch' } });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.json().summary, 'no figures with the lock off');
  });
  await off.close();

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('✗', e.stack || e.message);
  await prisma.$disconnect();
  process.exit(1);
});
