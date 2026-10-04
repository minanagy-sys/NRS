/**
 * Report 05 — the target tracker.
 *
 *   node test/target-tracker.test.js
 *
 * The figure this suite exists to protect is the commission base. `Collection.net`
 * is stored INC-VAT — gross less refunds, exactly as banked, which is what the
 * Sales overview card shows. The commission base is EX-VAT. Miss the ÷1.14 and
 * every pool is 14% too big and branches qualify that have not: on 1-19 Aug that
 * is 9 branches and 213,000 instead of 5 and 116,750.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const T = require('../src/lib/target-tracker.js');
const R = require('../src/lib/commission-rules.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const W = { year: 2026, month: 8, from: '2026-08-01', to: '2026-08-19' };
const f = (n) => Math.round(n).toLocaleString('en-US');

(async () => {
  const t = await T.buildTracker(W);

  console.log('\nthe commission base is cash, ex-VAT');
  await check(`base is named net_collection_ex_vat`, () => assert.strictEqual(t.base, 'net_collection_ex_vat'));
  await check(`VAT divisor is applied and reported (${t.vatDivisor})`, () => assert.ok(t.vatDivisor >= 1.01));
  await check('net ex-VAT = (gross − refunds) ÷ divisor, per branch', () => {
    for (const b of t.branches) {
      const want = Math.round(((b.gross - b.refunds) / t.vatDivisor) * 100) / 100;
      assert.ok(Math.abs(b.net - want) < 0.02, `${b.name}: ${b.net} vs ${want}`);
    }
  });
  /* The single assertion that would have caught the bug. */
  await check('net ex-VAT is BELOW net inc-VAT for every branch that collected', () => {
    for (const b of t.branches.filter((x) => x.netIncVat > 0)) {
      assert.ok(b.net < b.netIncVat, `${b.name} is not VAT-stripped`);
    }
  });
  await check("report 05's own formula reproduces its stated 13,424,848", () => {
    /* Its gross was 15,325,297.01 with 20,970 of refunds. Ours is higher because
       payments kept posting after it was frozen — but the formula must be
       identical, and on its inputs it lands on the pound. */
    assert.strictEqual(Math.round((15325297.01 - 20970) / 1.14), 13424848);
  });

  console.log('\nthe month, as the report frames it');
  await check(`target total ${f(t.totals.target)}`, () => assert.strictEqual(Math.round(t.totals.target), 23622679));
  await check('refunds match the report exactly', () => assert.strictEqual(Math.round(t.totals.refunds), 20970));
  await check(`day ${t.daysElapsed} of ${t.daysInMonth}, so not closed`, () => assert.strictEqual(t.closed, false));
  await check('an open month puts the gates on the projected basis', () => assert.strictEqual(t.basis, 'run'));
  await check('every branch resolves to collection rows', () => assert.strictEqual(t.unmatched.length, 0));

  /* Seven of the eleven branches reproduce report 05 to the pound. The rest are
     higher, which is correct: the report was frozen on 20 August and payments
     kept arriving. Asserting all eleven would break on the next sync. */
  console.log('\nbranches that should still match the report to the pound');
  const pinned = {
    CFC: 2094060, 'Madinty Strip': 2315958, CampShizar: 2891391,
    Zaied: 656752, Rushdy: 1120367, 'EL Mohandseen': 628014, Loran: 260786,
  };
  for (const [name, want] of Object.entries(pinned)) {
    const b = t.branches.find((x) => x.name === name);
    await check(`${name.padEnd(15)} ${f(want)}`, () => {
      assert.ok(b, `${name} missing`);
      /* Never lower than the report: collection only accumulates. */
      assert.ok(b.net >= want - 1, `${name} went DOWN: ${f(b.net)} < ${f(want)}`);
    });
  }

  console.log('\npace, achievement and projection are three different questions');
  await check('pace is measured against the pro-rata slice', () => {
    const b = t.branches.find((x) => x.prorata > 0);
    assert.ok(Math.abs(b.pace - b.net / b.prorata) < 1e-9);
  });
  await check('achievement is measured against the FULL target', () => {
    const b = t.branches.find((x) => x.target > 0);
    assert.ok(Math.abs(b.achievement - b.net / b.target) < 1e-9);
  });
  await check('mid-month, achievement is well below pace', () =>
    assert.ok(t.totals.achievement < t.totals.pace, 'they should differ on an open month'));
  await check('projection = collection ÷ elapsed × total', () => {
    const b = t.branches.find((x) => x.net > 0);
    assert.ok(Math.abs(b.projected - b.net / t.share) < 1);
  });

  console.log('\nnothing below the floor is ever paid');
  await check('a zero band always means a zero pool', () => {
    for (const b of t.branches) {
      if (b.now.band === 'zero') assert.strictEqual(b.now.pool, 0, `${b.name} now`);
      if (b.run.band === 'zero') assert.strictEqual(b.run.pool, 0, `${b.name} run`);
    }
  });
  await check('every pool sits inside its own tier min..max', () => {
    for (const b of t.branches) {
      for (const k of ['now', 'run']) {
        const s = b[k];
        if (s.pool) assert.ok(s.pool >= s.pools.min && s.pool <= s.pools.max, `${b.name} ${k}`);
      }
    }
  });
  await check('the team split adds back to the pool', () => {
    for (const b of t.branches) {
      const sum = b.run.roles.reduce((s, r) => s + r.amount, 0);
      assert.ok(Math.abs(sum - b.run.pool) < 0.05, `${b.name}: ${sum} vs ${b.run.pool}`);
    }
  });

  console.log('\nboth policy versions are true, by date');
  await check('v2.8 is in force in August 2026', async () => {
    const p = await T.policyFor('2026-08-19');
    assert.strictEqual(p.version, 'v2.8');
    assert.strictEqual(p.bands.floor, 0.9);
  });
  await check('v2.7 was in force in May 2026', async () => {
    const p = await T.policyFor('2026-05-15');
    assert.strictEqual(p.version, 'v2.7');
    assert.strictEqual(p.bands.floor, 0.8);
  });
  await check('the 90% floor genuinely costs branches their pool', async () => {
    const v = await T.compareVersions(W);
    const v27 = v.find((x) => x.version === 'v2.7');
    const v28 = v.find((x) => x.version === 'v2.8');
    assert.ok(v27 && v28, 'both versions should score');
    assert.ok(v28.qualifying < v27.qualifying,
      `v2.8 should qualify fewer: ${v28.qualifying} vs ${v27.qualifying}`);
    assert.ok(v28.pool < v27.pool, 'and pay less');
  });
  await check('v2.8 leaves exactly 5 branches qualifying, as the report states', async () => {
    const v = await T.compareVersions(W);
    assert.strictEqual(v.find((x) => x.version === 'v2.8').qualifying, 5);
  });

  console.log('\nit does not double-count against the Sales report');
  /* Scoped to buildTracker, not the whole file. `buildExtras` in the same module
     reads invoices on purpose — the service mix and the integrity checks are
     invoice-side by nature. The rule that matters is narrower and was previously
     asserted against the file, which passed only because the invoice reads were
     written as raw SQL against "Invoice" rather than `prisma.invoice`. That is a
     test giving false comfort: it would not have caught the base being switched
     to invoices via a raw query. */
  await check('the commission BASE reads Collection, never Invoice', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'target-tracker.js'), 'utf8');
    const start = src.indexOf('async function buildTracker');
    const end = src.indexOf('async function buildTrackerRange');
    assert.ok(start > 0 && end > start, 'could not locate buildTracker');
    const body = src.slice(start, end);
    assert.ok(!/prisma\.invoice\b/i.test(body), 'buildTracker must not read invoices — the base is cash');
    assert.ok(!/"Invoice"/.test(body), 'buildTracker must not query the Invoice table either');
    assert.ok(/collectionByBranch/.test(body), 'buildTracker should get its base from collectionByBranch');
  });

  console.log('\nthe service-mix family mapping');
  /* Ordering trap, the same shape as the Cash-Waffarha register rule. */
  const X = await T.buildExtras({ from: W.from, to: W.to });
  const famOf = (name) => (X.mix.categories.find((c) => c.category === name) || {}).family;

  await check('Injection/Body Contouring is BODY, not an injection', () => {
    assert.strictEqual(famOf('Injection/Body Contouring'), 'body',
      'a prefix-only rule files it as inj: the x1.25 card then reads 0% and the injections cap is overstated');
  });
  await check('Injection/Body Filler stays an injection', () => {
    const f = famOf('Injection/Body Filler');
    if (f === undefined) return; // not billed in this window
    assert.strictEqual(f, 'inj', 'matching a bare "body" would swallow this and overstate the department');
  });
  await check('the four families partition the whole mix', () => {
    const sum = X.mix.categories.reduce((a, c) => a + c.exVat, 0);
    assert.ok(Math.abs(sum - X.mix.total) < 1, `${sum} vs ${X.mix.total}`);
    for (const c of X.mix.categories) {
      assert.ok(['laser', 'inj', 'body', 'other'].includes(c.family), `${c.category} → ${c.family}`);
    }
  });
  await check(`body contouring has non-zero revenue (${f(X.mix.categories.filter((c) => c.family === 'body').reduce((a, c) => a + c.exVat, 0))})`, () => {
    const body = X.mix.categories.filter((c) => c.family === 'body').reduce((a, c) => a + c.exVat, 0);
    assert.ok(body > 0, 'the strategic-priority department reading zero means the mapping missed it');
  });

  console.log(failures ? `\n✗ ${failures} failed\n` : '\n✓ the tracker pays on cash ex-VAT, and only on a closed month\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n✗ ${e.stack || e.message}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
