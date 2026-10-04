/**
 * The Meta cache — what was loaded, and what must never be in it.
 *
 *   node test/meta-sync.test.js
 *
 * Two kinds of assertion, and the second kind is the reason this file exists.
 *
 * The first kind reproduces the frozen report pack out of Postgres: spend
 * 466,114.05 for 1-19 August, 2,239 messaging contacts, 2,326 on-Facebook
 * leads, and the same total arriving three independent ways — by day, by
 * campaign and by ad. Three grains agreeing to the piastre is the check that
 * catches a mis-mapped column, because a wrong field id would have to be wrong
 * identically in three separately-built queries to survive it.
 *
 * The second kind asserts the things that are invisible when they break: that
 * no lead's phone number or name reached the database, that an inference is
 * recorded as an inference, and that a row Meta gave us without a date was
 * dropped rather than written as an Invalid Date. None of those would show up
 * on a page. All of them would matter.
 *
 * These read the cache rather than filling it, so they assume
 * `scripts/sync-meta.js` has run. When it has not, they say so and skip instead
 * of failing — an empty cache is not a broken writer.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

/* 1-19 August 2026, the window the frozen pack covers. */
const W = { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-19T00:00:00Z') };
const LIVE = 'live';
const money = (v) => Number(v || 0);

(async () => {
  const loaded = await prisma.metaDay.count({ where: { source: LIVE } });
  if (!loaded) {
    console.log('\nMeta cache is empty — run scripts/sync-meta.js first. Skipping.\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log('\nthe frozen report pack, reproduced out of Postgres');

  const day = await prisma.metaDay.aggregate({
    where: { source: LIVE, date: W },
    _sum: { cost: true, msgConversations: true, onFbLeads: true },
  });
  await check('1-19 August spend is 466,114.05', () => {
    assert.strictEqual(money(day._sum.cost).toFixed(2), '466114.05');
  });
  await check('messaging contacts 2,239 and on-Facebook leads 2,326', () => {
    /* Stored apart on purpose: the report's "results" is their sum, and one
       summed column would make the total right and the split unrecoverable. */
    assert.strictEqual(day._sum.msgConversations, 2239);
    assert.strictEqual(day._sum.onFbLeads, 2326);
    assert.strictEqual(day._sum.msgConversations + day._sum.onFbLeads, 4565);
  });

  const camp = await prisma.metaCampaign.aggregate({
    where: { source: LIVE, date: W }, _sum: { cost: true },
  });
  const ad = await prisma.metaAd.aggregate({
    where: { source: LIVE, date: W }, _sum: { cost: true },
  });
  await check('day, campaign and ad grains agree to the piastre', () => {
    assert.strictEqual(money(camp._sum.cost).toFixed(2), '466114.05');
    assert.strictEqual(money(ad._sum.cost).toFixed(2), '466114.05');
  });

  const byAcct = await prisma.metaDay.groupBy({
    by: ['accountName'], where: { source: LIVE, date: W }, _sum: { cost: true },
  });
  const acct = Object.fromEntries(byAcct.map((r) => [r.accountName, money(r._sum.cost).toFixed(2)]));
  await check('Backup 250,615.53 / Doctors 167,590.69 / Zat 47,907.83', () => {
    assert.strictEqual(acct['Nouvel Age l Backup'], '250615.53');
    assert.strictEqual(acct['Nouvel Age Clinics l Doctors'], '167590.69');
    assert.strictEqual(acct['Zat l EGP 2025 !'], '47907.83');
  });

  console.log('\nany range, not just the pack’s nineteen days');

  await check('the cache reaches back before August', async () => {
    /* The whole point of pulling fifteen months: a report that can only answer
       1-19 August is a screenshot, not a report. */
    const first = await prisma.metaDay.findFirst({
      where: { source: LIVE }, orderBy: { date: 'asc' }, select: { date: true },
    });
    const iso = first.date.toISOString().slice(0, 10);
    assert.ok(iso < '2026-08-01', `earliest cached day is ${iso}`);
  });
  await check('campaigns and ads are per-day, so a sub-range is answerable', async () => {
    /* A campaign row meaning "1-19 August" could never be re-cut into 1-10. */
    const half = await prisma.metaCampaign.aggregate({
      where: { source: LIVE, date: { gte: W.gte, lte: new Date('2026-08-10T00:00:00Z') } },
      _sum: { cost: true },
    });
    const cost = money(half._sum.cost);
    assert.ok(cost > 0, 'no campaign rows in the first ten days');
    assert.ok(cost < 466114.05, 'ten days cost as much as nineteen: the rows are not per-day');
    const undated = await prisma.metaAd.count({ where: { source: LIVE, date: null } });
    assert.strictEqual(undated, 0, `${undated} ad rows carry no date`);
  });

  console.log('\nwhat must never be in the database');

  await check('no lead carries a phone number or a name', async () => {
    /* The phone arrives in the query because it is the only way to compute the
       key, and it is dropped before the write. This asserts the schema gives it
       nowhere to live in the first place. */
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'MetaLead'`);
    const names = cols.map((c) => c.column_name.toLowerCase());
    for (const banned of ['phone', 'phonenumber', 'mobile', 'fullname', 'name', 'email']) {
      assert.ok(!names.includes(banned), `MetaLead has a "${banned}" column`);
    }
    assert.ok(names.includes('mobilekey'), 'MetaLead should carry mobileKey');
  });
  await check('every stored mobileKey is ten digits starting with 1', async () => {
    const bad = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n FROM "MetaLead"
       WHERE "mobileKey" IS NOT NULL AND "mobileKey" !~ '^1[0-9]{9}$'`);
    assert.strictEqual(bad[0].n, 0, `${bad[0].n} keys are not ten digits`);
  });
  await check('an inherited service is recorded as inherited', async () => {
    /* Whether a label came from the ad or from its parent campaign is the
       difference between a fact and an inference, and the page can only show
       that difference if the row records it. */
    const inh = await prisma.metaAd.count({
      where: { source: LIVE, date: W, inherited: { has: 'service' } },
    });
    assert.ok(inh > 0, 'no ad inherited a service, which the real data contradicts');
    const wrong = await prisma.metaAd.count({
      where: { source: LIVE, inherited: { has: 'service' }, service: null },
    });
    assert.strictEqual(wrong, 0, `${wrong} rows claim to inherit a service they do not have`);
  });
  await check('an undated day row could not be stored even by mistake', async () => {
    /* Supermetrics returns one undated row per account with every metric null,
       and `dateOnly('')` makes an Invalid Date. The writer drops those rows —
       but the stronger guarantee is that the column will not accept one, so
       that is what is asserted. `MetaCampaign.date` and `MetaAd.date` are
       nullable on purpose, because rows seeded from the frozen HTML pack really
       are window roll-ups with no day to claim; those are checked above for
       having no undated LIVE rows. */
    const col = await prisma.$queryRawUnsafe(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'MetaDay' AND column_name = 'date'`);
    assert.strictEqual(col[0].is_nullable, 'NO', 'MetaDay.date should be NOT NULL');
    const undatedLive = await prisma.metaCampaign.count({ where: { source: LIVE, date: null } });
    assert.strictEqual(undatedLive, 0, `${undatedLive} live campaign rows carry no date`);
  });
  await check('objectives are the report’s words, not Meta’s codes', async () => {
    const objs = await prisma.metaCampaign.groupBy({ by: ['objective'], where: { source: LIVE } });
    for (const o of objs) {
      if (o.objective === null) continue;
      assert.ok(!/^OUTCOME_/.test(o.objective),
        `"${o.objective}" is Meta's internal vocabulary, not the report's`);
    }
  });

  console.log('\nInstagram');

  await check('both clinic profiles are held, and only ours', async () => {
    /* The Supermetrics connection carries sixteen profiles and ten belong to
       other clients of the agency. One of those appearing here would put
       another client's reach on a Nouvelage report. */
    const names = (await prisma.igProfileDay.groupBy({ by: ['profileName'] }))
      .map((r) => r.profileName).sort();
    assert.deepStrictEqual(names, ['nouvelageclinics', 'zataestheticclinics']);
  });
  await check('follower counts are within 5% of 226,093 and 4,732 — they are live totals', async () => {
    /* NOT pinned to the digit, and that was a real mistake here: a follower
       count goes up whenever somebody follows the account, so an exact
       assertion fails the first time the sync runs. It moved 226,093 -> 226,231
       within a day.
       What is worth asserting is that it has not COLLAPSED. A follower total
       that halves means the profile stopped answering and the row is stale,
       which is a fault; one that drifts by a few hundred is the account
       working. */
    for (const [name, ref] of [['nouvelageclinics', 226093], ['zataestheticclinics', 4732]]) {
      const last = await prisma.igProfileDay.findFirst({
        where: { profileName: name, followers: { gt: 0 } },
        orderBy: { date: 'desc' }, select: { followers: true, date: true },
      });
      assert.ok(last, `${name} has no follower reading at all`);
      const drift = Math.abs(last.followers - ref) / ref;
      assert.ok(drift <= 0.05,
        `${name} at ${last.followers} is ${(drift * 100).toFixed(1)}% from ${ref}`);
    }
  });
  await check('new followers exist only inside Instagram’s thirty-day window', async () => {
    /* Older rows carry a follower TOTAL and no daily gain. That is Instagram
       refusing to say, not a sync that missed them — so it must read as absent
       rather than as a day when nobody followed. */
    const withGain = await prisma.igProfileDay.findMany({
      where: { newFollowers: { gt: 0 } }, orderBy: { date: 'asc' }, take: 1,
      select: { date: true },
    });
    assert.ok(withGain.length, 'no daily follower gains stored at all');
    const earliest = withGain[0].date.toISOString().slice(0, 10);
    assert.ok(earliest >= '2026-08-01',
      `a follower gain is stored for ${earliest}, outside the window Instagram serves`);
  });

  console.log('\nthe API row allowance');

  const S = require('../src/lib/supermetrics.js');
  await check('the limit and reserve are the measured ones, not guesses', () => {
    assert.strictEqual(S.MONTHLY_ROW_LIMIT, 50000);
    assert.ok(S.DEFAULT_RESERVE > 0 && S.DEFAULT_RESERVE < S.MONTHLY_ROW_LIMIT);
  });
  await check('usage reports what is spendable, holding the reserve back', async () => {
    const u = await S.usage(prisma);
    assert.strictEqual(u.spendable, Math.max(0, u.limit - u.reserve - u.used));
    assert.strictEqual(u.remaining, Math.max(0, u.limit - u.used));
    assert.ok(/^\d{4}-\d{2}$/.test(u.month));
  });
  await check('a pull larger than the budget is REFUSED before it spends anything', async () => {
    /* The failure this prevents is silent. A quota exhausted mid-month looks
       exactly like a quiet fortnight on report 03, so the guard runs before the
       request rather than reporting after it. */
    const month = new Date().toISOString().slice(0, 7);
    let created = null;
    try {
      created = await prisma.apiQuery.create({
        data: { api: 'supermetrics', label: 'test-budget-guard', rows: 46000, month },
      });
      const api = S.client({ apiKey: 'test-only-never-sent', prisma });
      let threw = null;
      try {
        await api.query({
          dsId: 'FA', accounts: ['act_1'], fields: S.FIELDS.day,
          from: '2025-06-01', to: '2026-09-06', estimatedRows: 40000,
        });
      } catch (e) { threw = e; }
      assert.ok(threw, 'the pull was not refused');
      assert.strictEqual(threw.kind, S.KINDS.QUOTA, `refused as ${threw.kind}`);
      assert.ok(/rows used this month/.test(threw.message));
    } finally {
      if (created) await prisma.apiQuery.delete({ where: { id: created.id } });
    }
  });
  await check('  and the guard leaves no usage of its own behind', async () => {
    const stray = await prisma.apiQuery.count({ where: { label: 'test-budget-guard' } });
    assert.strictEqual(stray, 0, `${stray} test rows left in the meter`);
  });

  console.log('\nprovenance');

  await check('every row says where it came from', async () => {
    for (const model of ['metaDay', 'metaCampaign', 'metaAd', 'metaLead']) {
      const n = await prisma[model].count({ where: { source: '' } });
      assert.strictEqual(n, 0, `${model} has ${n} rows with no source`);
    }
  });

  console.log(failures ? `\n[31m${failures} failed[0m\n` : '\n[32mall passed[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('✗', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
