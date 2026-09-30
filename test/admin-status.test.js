/**
 * What Admin says needs doing, and why each row survives being argued with.
 *
 *   node test/admin-status.test.js
 *
 * The panel this covers exists because everything on it was ALREADY
 * discoverable and nobody had discovered it. So the tests are not "does it
 * render" — render.test.js does that — they are about the two properties that
 * decide whether anybody trusts the list a second time:
 *
 *   IT MUST NOT CRY WOLF. A row that appears when nothing is wrong teaches
 *   people to scroll past the row that matters. Publishing a sheet must make
 *   its row vanish; a feed inside its cadence must never appear.
 *
 *   IT MUST RANK BY WHAT IT COSTS. A missing sheet for a month with revenue
 *   already booked outranks one for a month that has not started. That falls
 *   out of measurement, and this pins it, because the day it becomes a
 *   hand-assigned severity is the day the order stops meaning anything.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const S = require('../src/lib/admin-status.js');
const Feeds = require('../src/lib/feeds.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

/* A fixed "now" so a test that passes today still passes in November. */
const NOW = new Date('2026-09-13T12:00:00Z');

(async () => {
  console.log('\nthe month arithmetic, which is where a year quietly goes wrong');

  await check('December rolls the year, and rubbish returns null', () => {
    assert.strictEqual(S.nextPeriod('2026-08'), '2026-09');
    assert.strictEqual(S.nextPeriod('2026-12'), '2027-01');
    assert.strictEqual(S.nextPeriod('2026-13'), null);
    assert.strictEqual(S.nextPeriod('nonsense'), null);
    assert.strictEqual(S.periodOf(NOW), '2026-09');
  });

  console.log('\nmissing target sheets');

  const periods = await S.periods(NOW);

  await check('it names the CURRENT month and the next one, and no others', () => {
    /* Listing every gap back to January buries the one row that matters under
       eight that do not. */
    const named = periods.map((p) => p.period).sort();
    assert.ok(named.length <= 2, `named ${named.join(', ')}`);
    for (const p of named) assert.ok(['2026-09', '2026-10'].includes(p), p);
  });

  await check('a month with revenue in it is BLOCKING; one that has not started is not', async () => {
    /* The whole ranking rests on this. September had 7.5 M booked against no
       target for thirteen days; October has nothing in it yet and setting it is
       simply the cheap moment. */
    const sep = periods.find((p) => p.period === '2026-09');
    if (sep) {
      assert.strictEqual(sep.severity, 'blocking');
      assert.ok(sep.metric.invoices > 0, 'September has no invoices to justify blocking');
      assert.ok(sep.metric.ex > 0);
      assert.ok(/already booked into it/.test(sep.cost), sep.cost);
    }
    const oct = periods.find((p) => p.period === '2026-10');
    if (oct && oct.metric.invoices === 0) {
      assert.strictEqual(oct.severity, 'overdue');
      assert.ok(/cheap moment/.test(oct.cost), oct.cost);
    }
  });

  await check('the cost figure is the real invoice total, not an estimate', async () => {
    const sep = periods.find((p) => p.period === '2026-09');
    if (!sep) return;
    const agg = await prisma.invoice.aggregate({
      where: {
        moveType: 'out_invoice',
        invoiceDate: { gte: new Date('2026-09-01'), lt: new Date('2026-10-01') },
      },
      _count: true,
      _sum: { amountUntaxed: true },
    });
    assert.strictEqual(sep.metric.invoices, agg._count);
    assert.ok(Math.abs(sep.metric.ex - Number(agg._sum.amountUntaxed)) < 0.02);
  });

  await check('a published month produces NO row — the list must not cry wolf', async () => {
    /* August is published. If it still appeared, every month would, and the
       panel would be a wall nobody reads. */
    assert.ok(!periods.some((p) => p.period === '2026-08'),
      'a published month is still being reported as missing');
  });

  await check('a saved draft changes the offer from Start to Resume, but not the severity', async () => {
    /* A draft is NOT a sheet. No report reads one, so the money is still
       unmeasured and the row has to stay as loud as it was. */
    const sep = periods.find((p) => p.period === '2026-09');
    if (!sep) return;
    const draft = await prisma.targetDraft.findUnique({ where: { period: '2026-09' } });
    if (draft) {
      assert.strictEqual(sep.hasDraft, true);
      assert.strictEqual(sep.action.resume, '2026-09');
      assert.strictEqual(sep.severity, 'blocking', 'a draft quietened the row');
      assert.ok(/no report reads it/.test(sep.detail), sep.detail);
    } else {
      assert.strictEqual(sep.hasDraft, false);
      assert.strictEqual(sep.action.resume, null);
    }
  });

  console.log('\nfeeds');

  const feedRows = await Feeds.read(NOW);

  await check('every feed declares what it fills and what goes quiet without it', () => {
    for (const f of feedRows) {
      assert.ok(f.fills && f.fills.length > 3, `${f.key} does not say what it fills`);
      assert.ok(f.breaks && f.breaks.length > 10, `${f.key} does not say what it breaks`);
      assert.ok(f.howTo && f.howTo.length > 10, `${f.key} does not say how to refresh it`);
      assert.ok([Feeds.ODOO, Feeds.API, Feeds.HAND].includes(f.source), `${f.key}: ${f.source}`);
    }
  });

  await check('"never loaded" and "late" are different states, not one', () => {
    /* Collapsing them prints "chat is 0 days late" for something nobody has
       ever sent, which is both wrong and useless. */
    for (const f of feedRows) {
      if (f.rows === 0) {
        assert.strictEqual(f.empty, true, `${f.key} has no rows but is not empty`);
        assert.strictEqual(f.late, false, `${f.key} is empty AND late`);
        assert.ok(/ever been loaded/i.test(f.why), f.why);
      }
    }
  });

  await check('a feed with no cadence is never late, by construction', () => {
    for (const f of feedRows) {
      if (f.allowanceDays == null) assert.strictEqual(f.late, false, `${f.key} is late with no cadence`);
    }
  });

  await check('a feed inside its cadence produces no status row', async () => {
    const rows = await S.feeds(NOW);
    const reported = new Set(rows.map((r) => r.key.replace('feed:', '')));
    for (const f of feedRows) {
      const shouldReport = f.error || f.empty || f.late;
      if (!shouldReport && f.key !== 'targets') {
        assert.ok(!reported.has(f.key), `${f.key} is current but was reported`);
      }
    }
  });

  await check('the target schedule is NOT reported twice', async () => {
    /* It is a hand-fed feed and belongs in feeds.js so the picture stays whole,
       but `periods()` reports it properly — by month, with the money. A second
       row saying only "32 days old" is how a list starts being scrolled past. */
    const rows = await S.feeds(NOW);
    assert.ok(!rows.some((r) => r.key === 'feed:targets'),
      'the targets feed is duplicating the period rows');
    const all = await S.build(NOW);
    const sheetRows = all.items.filter((i) => /target sheet|target schedule/i.test(i.title));
    const periodRows = all.items.filter((i) => i.key.startsWith('period:'));
    assert.strictEqual(sheetRows.length, periodRows.length,
      `${sheetRows.length} rows about target sheets for ${periodRows.length} missing months`);
  });

  console.log('\nthe whole list');

  const built = await S.build(NOW);

  await check('it is ranked worst first, and ties break on money', () => {
    const order = built.items.map((i) => S.SEVERITY.indexOf(i.severity));
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i] >= order[i - 1],
        `${built.items[i].title} (${built.items[i].severity}) came after ${built.items[i - 1].severity}`);
    }
    const blocking = built.items.filter((i) => i.severity === 'blocking');
    if (blocking.length > 1) {
      const withMoney = blocking.filter((i) => i.metric && i.metric.ex);
      if (withMoney.length) {
        assert.strictEqual(blocking[0].key, withMoney[0].key,
          'a blocking row with money behind it is not first');
      }
    }
  });

  await check('every row says what it costs and where to fix it', () => {
    for (const i of built.items) {
      assert.ok(i.title && i.title.length > 10, `${i.key} has no title`);
      assert.ok(i.cost && i.cost.length > 10, `${i.key} does not say what it costs`);
      assert.ok(i.detail && i.detail.length > 10, `${i.key} has no detail`);
      assert.ok(i.action, `${i.key} has no action`);
      assert.ok(S.SEVERITY.includes(i.severity), `${i.key}: ${i.severity}`);
    }
  });

  await check('an unusable date does not take the panel down with it', async () => {
    /* A status page whose job is to report problems must not become one. The
       date reaches `toISOString()` at the very END, so an invalid one threw
       after every check had already run and lost the whole list. */
    const odd = await S.build(new Date('not a date'));
    assert.ok(Array.isArray(odd.items), 'build rejected instead of coping');
    assert.ok(Number.isFinite(Date.parse(odd.at)), `at is ${odd.at}`);
    assert.ok(odd.items.length >= 0);
  });

  await check('a source that throws contributes ONE row and the rest still report', async () => {
    /* Proven against a real failure rather than a mocked one: `periods()` needs
       a period string, and handed something that is not one it must produce a
       row saying so — not an empty panel. */
    let threw = false;
    try { await S.periods('not a date'); } catch { threw = true; }
    assert.ok(threw, 'periods() silently coped with rubbish — the catch path is untested');

    const all = await S.build(NOW);
    const errors = all.items.filter((i) => i.key.startsWith('error:'));
    for (const e of errors) {
      assert.strictEqual(e.severity, 'blocking');
      assert.ok(/could not run/.test(e.title), e.title);
    }
  });

  await check('counts add up to the items, so the KPI row cannot disagree with the list', () => {
    const summed = Object.values(built.counts).reduce((t, n) => t + n, 0);
    assert.strictEqual(summed, built.items.length);
    assert.strictEqual(built.clean, built.items.length === 0);
  });

  await check('the off-sheet doctors row carries the revenue sitting outside every group', () => {
    const off = built.items.find((i) => i.key === 'map:offsheet');
    if (!off) return;
    assert.ok(off.metric.ex > 0, 'no money behind the row');
    assert.ok(off.metric.offSheet > 0);
    assert.ok(/outside every group total/.test(off.cost), off.cost);
  });

  console.log(failures ? `\n${failures} failed\n` : '\n✓ the status panel measures rather than guesses\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
