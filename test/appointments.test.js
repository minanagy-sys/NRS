/**
 * Appointments — the funnel middle and the show rate.
 *
 *   node test/appointments.test.js
 *
 * Two things this suite exists to protect.
 *
 * First, the state mapping. Every attendance figure in the reports is a sum over
 * three groups, and the groups are a judgement about thirteen Odoo states, not a
 * fact. `no_show` is why: it is a real state with zero rows in August, so it sat
 * in OPEN — meaning "no outcome recorded" — while meaning the exact opposite.
 * Nothing printed was wrong, and nothing would have been until the first no-show
 * was logged, at which point the resolved-only rate would have quietly risen.
 *
 * Second, the two denominators. 2,369 of 7,655 bookings in 1-19 August have no
 * outcome. 44.1% on all bookings and 63.8% on resolved ones are both defensible
 * and 19.7 points apart; the commission policy assumes 75%. A single number here
 * would be a choice dressed as a measurement, so both are published and the tests
 * assert the relationship between them rather than either value.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const A = require('../src/lib/appointments.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const W = { from: '2026-08-01', to: '2026-08-19' };
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/* Every state Odoo's `appointment.states` selection offers, from report 06's
   handover. If Odoo adds one, this list goes stale and the last test in the
   first block is what says so. */
const ODOO_STATES = [
  'no_show', 'pending', 'cancel', 'confirm', 'checked_in', 'assessment', 'waiting',
  'discount_approval', 'waiting_for_advance_payment', 'in_process', 'medical_info',
  'payment_received', 'done', 'done_with_due', 'rescheduled',
];

(async () => {
  console.log('\nthe state mapping');

  await check('every Odoo state maps to exactly one group', () => {
    for (const s of ODOO_STATES) {
      const g = A.group(s);
      assert.ok(['attended', 'lost', 'open'].includes(g), `${s} → ${g}`);
      const hits = [A.ATTENDED, A.LOST, A.OPEN].filter((list) => list.includes(s)).length;
      assert.strictEqual(hits, 1, `${s} appears in ${hits} lists, not 1`);
    }
  });

  /* The assertion that would have caught the bug. */
  await check('no_show is LOST, not OPEN', () => {
    assert.strictEqual(A.group('no_show'), 'lost');
  });

  await check('cancel and rescheduled are LOST', () => {
    assert.strictEqual(A.group('cancel'), 'lost');
    assert.strictEqual(A.group('rescheduled'), 'lost');
  });

  await check('done, done_with_due and payment_received are ATTENDED', () => {
    for (const s of ['done', 'done_with_due', 'payment_received']) {
      assert.strictEqual(A.group(s), 'attended', s);
    }
  });

  await check('pending is OPEN — it is not a no-show', () => {
    assert.strictEqual(A.group('pending'), 'open');
  });

  /* An unknown state must never land in ATTENDED: that is the one group where a
     new Odoo state would silently inflate a published rate. */
  await check('an unrecognised state falls to OPEN, never ATTENDED', () => {
    assert.strictEqual(A.group('some_state_odoo_adds_in_2027'), 'open');
    assert.strictEqual(A.group(''), 'open');
    assert.strictEqual(A.group(undefined), 'open');
  });

  await check(`no state is missing from the mapping (${ODOO_STATES.length} known)`, () => {
    const mapped = new Set([...A.ATTENDED, ...A.LOST, ...A.OPEN]);
    const extra = [...mapped].filter((s) => !ODOO_STATES.includes(s));
    assert.strictEqual(extra.length, 0, `mapped but unknown to Odoo: ${extra.join(', ')}`);
    const missing = ODOO_STATES.filter((s) => !mapped.has(s));
    assert.strictEqual(missing.length, 0, `Odoo states with no explicit group: ${missing.join(', ')}`);
  });

  /* ------------------------------------------------------------------ */

  const rows = await prisma.appointment.count({
    where: { date: { gte: new Date(`${W.from}T00:00:00Z`), lte: new Date(`${W.to}T00:00:00Z`) } },
  });
  if (!rows) {
    console.log('\n  – no appointments cached for 1-19 Aug; run scripts/sync-appointments.js');
    console.log(failures ? `\n${failures} failed\n` : '\nall passed (mapping only)\n');
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  }

  const t = await A.buildFunnel(W);

  console.log(`\nthe funnel · ${t.booked.toLocaleString('en-US')} bookings, 1-19 Aug`);

  await check('the three groups sum to the bookings', () => {
    const sum = t.totals.attended + t.totals.lost + t.totals.open;
    assert.strictEqual(sum, t.booked, `${sum} vs ${t.booked}`);
  });

  await check('every state count sums to the bookings', () => {
    const sum = t.states.reduce((a, s) => a + s.count, 0);
    assert.strictEqual(sum, t.booked);
  });

  await check(`showRate is attended ÷ all bookings (${pct(t.showRate)})`, () => {
    const want = t.totals.attended / t.booked;
    assert.ok(Math.abs(t.showRate - want) < 1e-9, `${t.showRate} vs ${want}`);
  });

  await check(`showRateResolved excludes the open ones (${pct(t.showRateResolved)})`, () => {
    const want = t.totals.attended / (t.totals.attended + t.totals.lost);
    assert.ok(Math.abs(t.showRateResolved - want) < 1e-9, `${t.showRateResolved} vs ${want}`);
  });

  /* The relationship, not the values — the values move with every sync. */
  await check('resolved rate ≥ all-bookings rate while any booking is open', () => {
    if (!t.totals.open) return;
    assert.ok(t.showRateResolved > t.showRate,
      `resolved ${pct(t.showRateResolved)} should exceed all ${pct(t.showRate)}`);
  });

  await check('the open bookings are reported, not absorbed', () => {
    assert.ok(t.totals.open > 0, 'August has open bookings; a zero here means they were folded away');
    const share = t.totals.open / t.booked;
    assert.ok(share > 0.2, `open share ${pct(share)} — was expecting the ~23-31% the window actually has`);
  });

  await check(`the policy floor is stated (${pct(A.POLICY_FLOOR)}) and both rates are under it`, () => {
    assert.strictEqual(t.policyFloor, A.POLICY_FLOOR);
    assert.ok(t.showRate < t.policyFloor);
    assert.ok(t.showRateResolved < t.policyFloor,
      'if this ever passes, the KPI has been met on the generous denominator — say so explicitly');
  });

  console.log('\nthe cuts');

  await check('branch rollup sums back to the bookings', () => {
    const sum = t.branches.reduce((a, b) => a + b.booked, 0);
    assert.strictEqual(sum, t.booked);
  });

  await check('each branch\'s groups sum to its own bookings', () => {
    for (const b of t.branches) {
      assert.strictEqual(b.attended + b.lost + b.open, b.booked, b.name);
    }
  });

  await check('creator counts sum to the bookings', () => {
    const sum = t.creators.reduce((a, c) => a + c.count, 0);
    assert.strictEqual(sum, t.booked);
  });

  await check('branches and specialists are sorted by volume', () => {
    for (const list of [t.branches, t.specialists]) {
      for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].booked >= list[i].booked);
    }
  });

  console.log('\nthe pending queue');

  const q = await A.buildPending(W);

  await check('the queue is exactly the OPEN bookings', () => {
    assert.strictEqual(q.rows.length, t.totals.open, `${q.rows.length} vs ${t.totals.open}`);
  });

  /* PII. Report 01 embedded 2,890 real names and mobiles; this list must not
     become the same thing by accident. */
  await check('no row carries a full mobile number', () => {
    for (const r of q.rows) {
      assert.strictEqual(r.mobileKey, undefined, 'mobileKey leaked into the queue');
      if (r.mobileTail) {
        assert.ok(/^••• \d{4}$/.test(r.mobileTail), `not masked: ${r.mobileTail}`);
      }
    }
  });

  await check('every queued booking is genuinely unresolved', () => {
    for (const r of q.rows) assert.strictEqual(A.group(r.states), 'open', `${r.states} in the queue`);
  });

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.message, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
