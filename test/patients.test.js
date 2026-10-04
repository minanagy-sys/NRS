/**
 * Patients — the mobile key, the tier bases, and the honesty flags.
 *
 *   node test/patients.test.js
 *
 * The first block is the important one. `mobileKey` is the only field that joins
 * a booking to a lead to a call, and the June audit counted 594 patients as new
 * who were already known because `01012345678`, `+201012345678` and `1012345678`
 * were three different keys. Every one of those forms is asserted to collapse to
 * the same ten digits here.
 *
 * The second half of that block is the half that gets loosened under pressure.
 * A nine-digit fragment matched against ten-digit keys does not "nearly" join —
 * it merges two real people, and no report downstream can tell that happened.
 * Every rejection case below is a case someone will eventually want to salvage.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const P = require('../src/lib/patients.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};
const pct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;
const f = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');

(async () => {
  console.log('\nthe mobile key · every form of one number collapses to one key');

  /* The exact failure the June audit found. */
  await check('the three forms that caused 594 false new patients agree', () => {
    const forms = ['01012345678', '+201012345678', '1012345678', '00201012345678',
      '201012345678', '0101 234 5678', '(010) 1234-5678', '010-1234-5678'];
    const keys = forms.map(P.mobileKey);
    assert.deepStrictEqual([...new Set(keys)], ['1012345678'],
      `got ${JSON.stringify(keys)}`);
  });

  await check('all four Egyptian mobile prefixes are accepted', () => {
    for (const p of ['10', '11', '12', '15']) {
      const n = `0${p}12345678`;
      assert.strictEqual(P.mobileKey(n), `${p}12345678`, n);
    }
  });

  await check('whitespace, punctuation and unicode digits-adjacent noise are stripped', () => {
    assert.strictEqual(P.mobileKey('  +20 (0)10 1234 5678  '), '1012345678');
    assert.strictEqual(P.mobileKey('tel: 01012345678'), '1012345678');
    assert.strictEqual(P.mobileKey('01012345678 / home'), '1012345678');
  });

  console.log('\n  and every near-miss is rejected, not salvaged');

  await check('a nine-digit fragment is rejected', () => {
    assert.strictEqual(P.mobileKey('101234567'), null);
    assert.strictEqual(P.mobileKey('0101234567'), null);
  });

  await check('a landline is rejected', () => {
    assert.strictEqual(P.mobileKey('0223456789'), null, 'Cairo landline');
    assert.strictEqual(P.mobileKey('023456789'), null);
  });

  await check('a number not starting 1 after normalising is rejected', () => {
    assert.strictEqual(P.mobileKey('0912345678'), null);
    assert.strictEqual(P.mobileKey('9123456789'), null);
  });

  await check('empty, missing and non-string values are rejected', () => {
    for (const v of ['', '   ', null, undefined, false, {}, [], 'no phone', '-']) {
      assert.strictEqual(P.mobileKey(v), null, JSON.stringify(v));
    }
  });

  /* A number too long is ambiguous: taking the last ten of an eleven-digit
     foreign number invents an Egyptian patient. The rule keeps the last ten only
     after the known prefixes are stripped, so a genuinely foreign number with a
     different country code fails the 1-prefix test. */
  await check('a foreign number is not coerced into an Egyptian key', () => {
    assert.strictEqual(P.mobileKey('+44 7700 900123'), null, 'UK mobile');
    assert.strictEqual(P.mobileKey('+971501234567'), null, 'UAE mobile');
  });

  await check('numbers differing only in the last digit stay distinct', () => {
    assert.notStrictEqual(P.mobileKey('01012345678'), P.mobileKey('01012345679'));
  });

  console.log('\nthe masked form · nothing downstream carries a full number');

  await check('mobileTail is ••• plus four digits, or null', () => {
    assert.strictEqual(P.mobileTail('01012345678'), '••• 5678');
    assert.strictEqual(P.mobileTail('bad'), null);
    assert.strictEqual(P.mobileTail(null), null);
  });

  await check('mobileTail never contains the first six digits', () => {
    const tail = P.mobileTail('01012345678');
    assert.ok(!tail.includes('101234'), tail);
    assert.strictEqual(tail.replace(/\D/g, '').length, 4);
  });

  /* ------------------------------------------------------------------ */

  const cov = await P.coverage();
  if (!cov.invoices) {
    console.log('\n  – no invoices cached; run scripts/sync.js');
    console.log(failures ? `\n${failures} failed\n` : '\nall passed (pure functions only)\n');
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  }

  console.log(`\nthe tier bases · cache holds ${f(cov.invoices)} invoices, ${cov.from} → ${cov.to}`);

  await check('both bases are declared, with their sources', () => {
    for (const k of ['report01', 'report06']) {
      const b = P.TIER_BASES[k];
      assert.ok(b, k);
      assert.ok(b.source && b.label, `${k} needs a label and a source`);
      assert.ok(b.tiers.length >= 4, k);
    }
  });

  /* The two bases genuinely disagree, and a test that let them converge would
     hide the whole reason both exist. */
  await check('the two bases use different windows AND different thresholds', () => {
    const a = P.TIER_BASES.report01, b = P.TIER_BASES.report06;
    assert.notStrictEqual(a.window, b.window);
    assert.notStrictEqual(a.tiers[0].from, b.tiers[0].from);
  });

  await check('tier thresholds descend, so the first match wins correctly', () => {
    for (const b of Object.values(P.TIER_BASES)) {
      for (let i = 1; i < b.tiers.length; i++) {
        assert.ok(b.tiers[i - 1].from > b.tiers[i].from, `${b.key}: ${b.tiers[i].name}`);
      }
      assert.strictEqual(b.tiers[b.tiers.length - 1].from, 0, `${b.key} needs a catch-all at 0`);
    }
  });

  const t = await P.buildTiers({ basis: 'report01' });

  await check(`report01 basis resolves to a window (${t.basis.from} → ${t.basis.to})`, () => {
    assert.strictEqual(t.basis.from.slice(5), '01-01', 'YTD must start on 1 January');
    assert.strictEqual(t.basis.from.slice(0, 4), t.basis.to.slice(0, 4));
  });

  await check(`every patient is in exactly one tier (${f(t.patients.length)} patients)`, () => {
    const names = new Set(P.TIER_BASES.report01.tiers.map((x) => x.name));
    for (const p of t.patients) assert.ok(names.has(p.tier), `${p.patientId}: ${p.tier}`);
    const sum = t.tiers.reduce((a, x) => a + x.patients, 0);
    assert.strictEqual(sum, t.patients.length, `${sum} vs ${t.patients.length}`);
  });

  await check('tier spend sums back to the total', () => {
    const sum = t.tiers.reduce((a, x) => a + x.exVat, 0);
    assert.ok(Math.abs(sum - t.total) < 1, `${f(sum)} vs ${f(t.total)}`);
  });

  await check('each patient sits above their tier threshold and below the next', () => {
    const tiers = P.TIER_BASES.report01.tiers;
    for (const p of t.patients) {
      const i = tiers.findIndex((x) => x.name === p.tier);
      assert.ok(p.exVat >= tiers[i].from, `${p.tier} at ${f(p.exVat)} < ${f(tiers[i].from)}`);
      if (i > 0) assert.ok(p.exVat < tiers[i - 1].from, `${p.tier} at ${f(p.exVat)} belongs in ${tiers[i - 1].name}`);
    }
  });

  await check('ex-VAT is below inc-VAT for every patient', () => {
    for (const p of t.patients) {
      assert.ok(p.exVat <= p.incVat + 0.01, `${p.patientId}: ex ${p.exVat} > inc ${p.incVat}`);
    }
  });

  await check('shares are fractions, and each set sums to 1', () => {
    const ps = t.tiers.reduce((a, x) => a + x.patientShare, 0);
    const ss = t.tiers.reduce((a, x) => a + x.spendShare, 0);
    assert.ok(Math.abs(ps - 1) < 1e-6, `patientShare sums to ${ps}`);
    assert.ok(Math.abs(ss - 1) < 1e-6, `spendShare sums to ${ss}`);
  });

  await check('an unknown basis is refused, not defaulted', async () => {
    await assert.rejects(() => P.buildTiers({ basis: 'whatever' }), /Unknown tier basis/);
  });

  /* The flag that decides whether the tier table may be shown as fact. */
  console.log(`\nthe honesty flags · basisCovered = ${t.basisCovered}`);

  await check('basisCovered reflects the cache, not the request', () => {
    const want = !!cov.from && cov.from <= t.basis.from;
    assert.strictEqual(t.basisCovered, want,
      `cache starts ${cov.from}, basis wants ${t.basis.from}`);
  });

  await check('the alternative basis is offered alongside', () => {
    assert.ok(t.alternatives.some((a) => a.key === 'report06'));
  });

  const mix = await P.buildMix({ from: '2026-08-01', to: '2026-08-19' });
  console.log(`\nnew versus returning · 1-19 Aug, provable = ${mix.provable}`);

  await check(`the buckets sum to the patients (${f(mix.patients)})`, () => {
    assert.strictEqual(mix.new + mix.returning + mix.unknown, mix.patients);
  });

  /* This is the assertion that stops a two-month cache from reporting everyone
     as new — the shape of the reports' own drifting 1,254 / 1,268 splits. */
  await check('nobody is called new unless the cache proves they were absent', () => {
    if (!mix.provable) {
      assert.strictEqual(mix.new, 0,
        `cache starts ${mix.coverage.from}, window starts ${mix.from} — ${mix.new} counted as new anyway`);
      assert.ok(mix.unknown > 0, 'unprovable patients must land in unknown');
    } else {
      assert.strictEqual(mix.unknown, 0, 'a provable window should classify everyone');
    }
  });

  await check('returning patients have an invoice before the window', () => {
    assert.ok(mix.returning > 0, 'August cannot be all-new; a zero here is a join failure');
  });

  const ret = await P.buildRetention({});
  console.log(`\nretention · cache is ${ret.depthMonths} months deep`);

  await check(`the buckets sum to the patients (${f(ret.patients)})`, () => {
    const sum = ret.buckets.reduce((a, b) => a + b.patients, 0);
    assert.strictEqual(sum, ret.patients);
  });

  await check('buckets beyond the cache depth are flagged, not presented as churn', () => {
    for (const b of ret.buckets) {
      if (b.max !== null && b.max > ret.depthMonths) {
        assert.strictEqual(b.beyondCache, true, `${b.name} should be flagged`);
      }
    }
  });

  await check('repeat patients never exceed patients in any bucket', () => {
    for (const b of ret.buckets) assert.ok(b.repeatPatients <= b.patients, b.name);
  });

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.message, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
