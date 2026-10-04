/**
 * Report 02 — the seeded snapshot, the live half, and the seam between them.
 *
 *   node test/contact-centre.test.js
 *
 * The first block reproduces the frozen pack out of Postgres. The interesting
 * blocks are the other three, because each pins a rule that is invisible when
 * it breaks:
 *
 *   an UPLOAD REPLACES THE SEED for the days it covers and is never added to
 *   it. Every PBX read used to aggregate across sources, so a day present as
 *   both would have been counted twice — and with the pack seeding 1–18 August,
 *   the first real export touching those days would have doubled them silently;
 *
 *   a RANGE OUTSIDE THE SNAPSHOT REFUSES rather than answering zero, while the
 *   bookings half keeps working. That asymmetry is the design of this report;
 *
 *   the IMPORTER'S UNITS. A duration column read as minutes when it is seconds
 *   is 60× on every occupancy figure, and no column heading distinguishes them.
 *
 * The upload-preference test writes rows and removes them in a `finally`, so a
 * failure cannot leave fabricated calls in the database.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const CC = require('../src/lib/contact-centre.js');
const U = require('../src/lib/pbx-import.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const W = { from: '2026-08-01', to: '2026-08-19' };

(async () => {
  const seeded = await prisma.pbxDay.count({ where: { source: 'seed' } });
  if (!seeded) {
    console.log('\nNo PBX seed loaded — run scripts/import-report-html.js first. Skipping.\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log('\nthe frozen pack, reproduced out of Postgres');

  const D = await CC.build(W);
  await check('2,919 calls offered and 2,456 answered', () => {
    assert.strictEqual(D.phones.inbound, 2919);
    assert.strictEqual(D.phones.answered, 2456);
  });
  await check('4,404 dials and 3,025 connected', () => {
    /* The reconcilable figures. The pack's own Outbound headline says 7,888 and
       5,745, which agrees with nothing else in the file. */
    assert.strictEqual(D.phones.dials, 4404);
    assert.strictEqual(D.outbound.connected, 3025);
  });
  await check('the pack\'s contradictory outbound headline is carried as a claim, not a total', () => {
    assert.ok(D.outbound.packClaim, 'the claim was dropped');
    assert.strictEqual(D.outbound.packClaim.dials, 7888);
    assert.strictEqual(D.outbound.packClaim.stored, 4404);
    /* And it is nowhere in the arithmetic. */
    assert.strictEqual(D.phones.sessions, 2919 + 4404);
  });
  await check('218 calls arrive out of hours, and none is answered', () => {
    /* The pack's prose says 108; its own hourly rows say 218. */
    assert.strictEqual(D.hours.outOfHours.calls, 218);
    assert.strictEqual(D.hours.outOfHours.answered, 0);
  });

  console.log('\nthe entity split adds up, unlike the pack\'s own cards');

  await check('Nouvel Age + ZAT equals every queue', () => {
    const E = D.queues.entities;
    assert.strictEqual(E.nouvelAge.offered + E.zat.offered, E.offeredTotal);
    assert.strictEqual(E.offeredTotal, D.phones.inbound);
  });
  await check('ZAT is the one queue the pack names, at 483 calls', () => {
    assert.strictEqual(D.queues.entities.zat.offered, 483);
  });
  await check('ZAT abandons more on the same phone system', () => {
    const E = D.queues.entities;
    assert.ok(E.zat.abandonRate > E.nouvelAge.abandonRate);
    assert.ok(E.abandonGap > 0.1, `gap is ${E.abandonGap}`);
  });

  console.log('\nthe two windows are kept apart');

  await check('the phone half reports its own narrower window', () => {
    /* The pack is titled 1–19 August; its per-day cube stops on the 18th. */
    assert.strictEqual(D.phones.window.from, '2026-08-01');
    assert.strictEqual(D.phones.window.to, '2026-08-18');
    assert.strictEqual(D.phones.window.full, false);
    assert.ok(/not the same window/.test(D.phones.window.note));
  });
  await check('the bookings half covers the range that was asked for', () => {
    assert.ok(D.bookings.booked > 0);
    /* Report 04's figure for the same window, so the two reports agree. */
    const F = require('../src/lib/appointments.js');
    return F.buildFunnel(W).then((f) => assert.strictEqual(D.bookings.booked, f.booked));
  });
  await check('a range outside the snapshot refuses instead of answering zero', async () => {
    const S = await CC.build({ from: '2026-09-01', to: '2026-09-04' });
    assert.strictEqual(S.phones.window.any, false);
    assert.ok(/does not touch it/.test(S.phones.window.note));
    /* And the live half still answers. */
    assert.ok(S.bookings.booked > 0, 'the live half went missing with the seeded half');
  });

  console.log('\nan upload replaces the seed, and is never added to it');

  const DAY = new Date('2026-08-05T00:00:00Z');
  let seedDay = null;
  try {
    seedDay = await prisma.pbxDay.findFirst({ where: { source: 'seed', date: DAY } });
    await prisma.pbxDay.create({
      data: { date: DAY, inboundCalls: 999, inboundAnswered: 900, dials: 111, source: 'upload' },
    });
    await prisma.pbxQueueDay.create({
      data: { queue: '6514', date: DAY, offered: 999, answered: 900, abandoned: 99, source: 'upload' },
    });

    await check('the upload wins for the day it covers', async () => {
      const one = await CC.build({ from: '2026-08-05', to: '2026-08-05' });
      assert.strictEqual(one.phones.inbound, 999,
        `got ${one.phones.inbound}; the seed's ${seedDay.inboundCalls} was added to the upload's 999`);
    });
    await check('  and the seed still answers for the days it does not', async () => {
      const wide = await CC.build(W);
      /* 2,919 with 5 August swapped: minus the seed's calls, plus the upload's. */
      const expected = 2919 - seedDay.inboundCalls + 999;
      assert.strictEqual(wide.phones.inbound, expected,
        `got ${wide.phones.inbound}, expected ${expected}`);
    });
    await check('  the queue table prefers per (queue, day), not wholesale', async () => {
      const one = await CC.build({ from: '2026-08-05', to: '2026-08-05' });
      const q = one.queues.queues.find((x) => x.queue === '6514');
      assert.strictEqual(q.offered, 999);
      /* Other queues that day are still the seed's. */
      const other = one.queues.queues.find((x) => x.queue === '6502');
      assert.ok(!other || other.offered < 999);
    });
    await check('  and the seed row was not deleted, so a bad import can be undone', async () => {
      const still = await prisma.pbxDay.findFirst({ where: { source: 'seed', date: DAY } });
      assert.ok(still, 'the seed row is gone');
      assert.strictEqual(still.inboundCalls, seedDay.inboundCalls);
    });
  } finally {
    await prisma.pbxDay.deleteMany({ where: { source: 'upload', date: DAY } });
    await prisma.pbxQueueDay.deleteMany({ where: { source: 'upload', date: DAY } });
  }

  console.log('\nthe importer\'s units and refusals');

  await check('a duration is read as seconds, and H:MM:SS is parsed', () => {
    /* 60x on every occupancy figure if this is wrong, and no heading says which. */
    assert.strictEqual(U.seconds('3:12:40'), 3 * 3600 + 12 * 60 + 40);
    assert.strictEqual(U.seconds('41:05'), 41 * 60 + 5);
    assert.strictEqual(U.seconds(125), 125);
    assert.strictEqual(U.seconds(''), null);
    assert.strictEqual(U.seconds(null), null);
  });
  await check('a date is read day-first, as it is written here', () => {
    /* `05/08/2026` is 5 August. Reading it as 5 May moves a fortnight of calls
       into the wrong month. */
    assert.strictEqual(U.asDate('05/08/2026').toISOString().slice(0, 10), '2026-08-05');
    assert.strictEqual(U.asDate('2026-08-05').toISOString().slice(0, 10), '2026-08-05');
    assert.strictEqual(U.asDate('2026-08-05 14:22:01').toISOString().slice(0, 10), '2026-08-05');
    assert.strictEqual(U.asDate('rubbish'), null);
  });
  await check('a totals footer is skipped wherever its label sits', () => {
    /* The first export tried against this had `Date` blank and `TOTAL` in the
       second column, and an only-check-the-first-cell rule let it block the
       whole import. */
    const cols = { date: 'Date', queue: 'Queue', offered: 'Calls', answered: 'Ans' };
    const { records, skipped, problems } = U.plan('pbx', [
      { Date: '2026-08-20', Queue: '6514', Calls: 10, Ans: 9 },
      { Date: '', Queue: 'TOTAL', Calls: 10, Ans: 9 },
    ], cols);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(problems.length, 0, `blocked by: ${problems[0]}`);
    assert.ok(/totals row/.test(skipped[0] || ''));
  });
  await check('an unreadable date BLOCKS rather than being skipped', () => {
    /* A day silently short of its calls is worse than an import that refused. */
    const cols = { date: 'Date', queue: 'Queue', offered: 'Calls' };
    const { problems } = U.plan('pbx', [{ Date: '31/31/2026', Queue: '6514', Calls: 10 }], cols);
    assert.strictEqual(problems.length, 1);
    assert.ok(/no readable date/.test(problems[0]));
  });
  await check('an organic lead keeps only its ten-digit key', () => {
    const { records, skipped } = U.plan('leads', [
      { Date: '2026-08-20', Phone: '+201066566593', Form: 'CTA', 'Full name': 'Someone Real' },
      { Date: '2026-08-20', Phone: 'not a phone', Form: 'DM', 'Full name': 'Bad Row' },
    ], { date: 'Date', phone: 'Phone', formName: 'Form' });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].mobileKey, '1066566593');
    /* Nothing identifying survived the plan step. */
    const asText = JSON.stringify(records[0]);
    assert.ok(!/Someone Real/.test(asText), 'a lead name reached the record');
    assert.ok(!/\+?20106656/.test(asText), 'a raw phone number reached the record');
    /* An unusable number is reported, not silently dropped — it is the ceiling
       on what any lead-to-patient rate can reach. */
    assert.ok(/will not normalise/.test(skipped[0] || ''));
  });

  console.log('\nprovenance');

  await check('every PBX row says which source it came from', async () => {
    for (const model of ['pbxDay', 'pbxQueueDay', 'pbxAgentDay', 'pbxHour']) {
      const bad = await prisma[model].count({ where: { source: '' } });
      assert.strictEqual(bad, 0, `${model} has ${bad} rows with no source`);
    }
  });
  await check('the seed recorded what it did, including the pack\'s contradictions', async () => {
    const load = await prisma.dataUpload.findFirst({
      where: { kind: 'pbx:seed' }, orderBy: { createdAt: 'desc' },
    });
    assert.ok(load, 'no load record for the seed');
    assert.ok(/CONFLICT outbound dials/.test(load.notes), 'the conflicts were not recorded');
    assert.ok(/7888/.test(load.notes) && /4404/.test(load.notes));
  });


  /* ------------------------------------------------------------------
     THE HOURLY DOUBLE-COUNT.

     hours() used to read the whole PbxHour table with no window filter and no
     preferUpload, while every other PBX function did both. With one seed that
     was correct. This writes a second window beside the seed and asserts the
     total does not grow — the assertion the old code fails.
     ------------------------------------------------------------------ */
  console.log('\nthe hourly profile is one window, not a sum of all of them');

  /* THE REALISTIC SHAPE: a weekly UCM upload writes DATED hour rows. One for
     5 August — a day the seed's whole-window profile already counts — must not
     be added on top of it. (Until 2026-10-04 this test used an undated upload
     row, a shape no upload produces any more.) */
  const beforeHours = await CC.hours({ ...W, cov: await CC.pbxCoverage() });
  const baseCalls = beforeHours.list.reduce((t, h) => t + h.calls, 0);
  let hourRow = null;
  try {
    hourRow = await prisma.pbxHour.create({
      data: { date: new Date('2026-08-05T00:00:00Z'), hour: 12, calls: 9999, answered: 9999, source: 'upload' },
    });
    const after = await CC.hours({ ...W, cov: await CC.pbxCoverage() });
    const afterCalls = after.list.reduce((t, h) => t + h.calls, 0);
    await check('a dated upload for a day the seed profile already counts is NOT added on top', async () => {
      assert.strictEqual(afterCalls, baseCalls,
        `the hourly total moved by ${afterCalls - baseCalls}; 5 August would be counted twice`);
    });
    await check('  and the out-of-hours figure is not double-counted either', async () => {
      assert.strictEqual(after.outOfHours.calls, beforeHours.outOfHours.calls);
    });
  } finally {
    /* Removed whether or not the assertions passed, so a failure cannot leave
       9,999 fabricated calls in the database. */
    if (hourRow) await prisma.pbxHour.delete({ where: { id: hourRow.id } });
  }

  /* It said "a typical day" until 2026-10-04, which was wrong: the seed's hour
     rows are TOTALS over the whole window (4,183 calls), not an average day. */
  await check('the seed\'s hourly profile says it is the whole window, not the range', async () => {
    const h = await CC.hours({ ...W, cov: await CC.pbxCoverage() });
    assert.strictEqual(h.grain, 'window-total');
    assert.ok(/not the range above/.test(h.note || ''), 'the grain is not stated in words');
  });
  await check('  and a range the seed does not touch does NOT borrow its hourly profile', async () => {
    const h = await CC.hours({ from: '2026-09-27', to: '2026-10-03', cov: await CC.pbxCoverage() });
    const seedOnly = h.list.filter((x) => x.source === 'seed').length;
    assert.strictEqual(seedOnly, 0, `${seedOnly} August hour rows counted inside a September week`);
  });

  /* ------------------------------------------------------------------
     THE PEOPLE HALF.
     ------------------------------------------------------------------ */
  const ccSeeded = await prisma.ccOpportunity.count({ where: { source: 'seed' } });
  if (ccSeeded) {
    console.log('\nthe contact-centre snapshot, reproduced out of Postgres');

    const S = await CC.build({ from: '2026-09-01', to: '2026-10-10', scope: 'all', today: '2026-10-04' });

    await check('the opportunity aggregate reproduces the source page exactly', async () => {
      const T = S.summary.totals;
      assert.strictEqual(T.n, 2955, `n is ${T.n}`);
      assert.strictEqual(T.booked, 2388, `booked is ${T.booked}`);
      /* 1,435 and NOT 1,576. The page's own agg() skips opportunities that
         booked nothing before testing the show flag, so 141 patients who
         arrived through an opportunity that never booked are excluded. Pinned
         because the looser count is the easy mistake and it overstates the
         contact centre by 141 patients. */
      assert.strictEqual(T.showed, 1435, `showed is ${T.showed}`);
      assert.strictEqual(T.ownBooking, 1139, `ownBooking is ${T.ownBooking}`);
      assert.strictEqual(Math.round(T.revenue), 6487562, `revenue is ${T.revenue}`);
    });

    await check('the show-rate denominator excludes bookings not yet due', async () => {
      const T = S.summary.totals;
      assert.strictEqual(T.past, T.booked - T.upcoming);
      assert.ok(T.upcoming > 0, 'no upcoming bookings in range — this test proves nothing');
    });

    await check('the credit gap is carried as a figure, not left to be subtracted', async () => {
      const T = S.summary.totals;
      assert.strictEqual(T.lostCredit, T.showed - T.ownBooking);
      assert.strictEqual(T.lostCredit, 296, `lostCredit is ${T.lostCredit}`);
    });

    await check('appointments exclude rescheduled rows from every total', async () => {
      const A = S.appointments.totals;
      assert.ok(A.rescheduled > 0, 'no rescheduled rows in range');
      const rows = await prisma.ccAppointment.count({
        where: { date: { gte: new Date('2026-09-26T00:00:00Z'), lte: new Date('2026-10-10T00:00:00Z') } },
      });
      assert.strictEqual(A.n + A.rescheduled, rows, `${A.n} + ${A.rescheduled} != ${rows}`);
    });

    await check('a range reaching the future uses "arrived so far", not show rate', async () => {
      assert.strictEqual(S.appointments.totals.showMetric, 'arrivedRate');
      const past = await CC.build({ from: '2026-09-26', to: '2026-09-30', scope: 'all', today: '2026-10-04' });
      assert.strictEqual(past.appointments.totals.showMetric, 'showRate');
    });

    await check('median time to booking ignores the never-booked rather than counting them zero', async () => {
      const T = S.crm.totals;
      assert.strictEqual(T.measuredOn + T.neverBooked, T.leads);
      assert.strictEqual(T.measuredOn, T.booked, 'measured on a different set from the booked one');
    });

    /* The three refusals. Each is a field the export does not carry, and each
       would otherwise render as an empty table that reads "nobody did this". */
    await check('lead source refuses, and blames the export rather than Odoo alone', async () => {
      assert.strictEqual(S.crm.leadSource.available, false);
      assert.strictEqual(S.crm.leadSource.measured, false);
      assert.ok(/does not carry the Source/.test(S.crm.leadSource.why));
      assert.ok(S.crm.leadSource.alsoTrue, 'the separate Odoo finding is not stated');
    });
    await check('  activities are labelled by login because the person is not in the export', async () => {
      assert.strictEqual(S.crm.activities.personAvailable, false);
      assert.strictEqual(S.crm.activities.grain, 'login');
      assert.ok(/not in this export/.test(S.crm.activities.why));
    });
    await check('  re-booking says it can only name a login', async () => {
      assert.strictEqual(S.crm.rebooking.personAvailable, false);
      assert.strictEqual(S.crm.rebooking.credited + S.crm.rebooking.lost, S.crm.rebooking.total);
    });

    await check('a range neither snapshot reaches refuses on every section', async () => {
      const none = await CC.build({ from: '2025-01-01', to: '2025-01-31', scope: 'all', today: '2026-10-04' });
      for (const k of ['summary', 'crm', 'appointments', 'people', 'timing', 'branches']) {
        assert.strictEqual(none[k].window.any, false, `${k} answered for a range it does not hold`);
        assert.ok(/does not touch it/.test(none[k].window.note || ''), `${k} gives no reason`);
      }
    });

    await check('the seeder recorded what the snapshot cannot carry', async () => {
      const load = await prisma.dataUpload.findFirst({
        where: { kind: 'cc:seed' }, orderBy: { createdAt: 'desc' },
      });
      assert.ok(load, 'no load record for the contact-centre seed');
      assert.ok(/GAP lead source/.test(load.notes), 'the lead-source gap was not recorded');
      assert.ok(/GAP activity person/.test(load.notes));
      assert.ok(/snapshot 2026-10-03 18:15/.test(load.notes), 'the real snapshot time was not recorded');
    });

    await check('the extension map names every extension the call data holds', async () => {
      const exts = await prisma.pbxAgentDay.findMany({ distinct: ['ext'], select: { ext: true } });
      const map = new Map((await prisma.pbxExtension.findMany()).map((e) => [e.ext, e]));
      const missing = exts.filter((e) => !map.has(e.ext)).map((e) => e.ext);
      assert.strictEqual(missing.length, 0, `not in the map: ${missing.join(', ')}`);
    });

    await check('  and an extension the phone system disagrees about is flagged, not resolved', async () => {
      const A = await CC.build({ ...W, today: '2026-10-04' });
      const bad = A.agents.agents.filter((a) => a.nameConflict);
      assert.strictEqual(bad.length, 1, `expected one conflict, found ${bad.length}`);
      assert.strictEqual(bad[0].ext, '6008');
      assert.ok(bad[0].cdrName && bad[0].phoneName && bad[0].cdrName !== bad[0].phoneName);
    });
  } else {
    console.log('\nNo contact-centre snapshot loaded — run scripts/import-contact-centre-html.js. Skipping that half.');
  }

  console.log(failures ? `\n[31m${failures} failed[0m\n` : '\n[32mall passed[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('✗', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
