/* ============================================================
   The Commission Policy 2026 v2.7 rules, in one place.

   Same discipline as lib/rules.js and lib/finance-rules.js: the arithmetic that
   turns a month's collection into a pool, a multiplier and a gate lives here
   once, so the page, the importer and the tests cannot disagree about it.

   Every constant and every branch of every rule was read out of
   Nouvelage_Commission_Policy_2026_v2.7.xlsx, and test/commission-rules.test.js
   re-derives all 18 of the workbook's own test cases (sheet 15) from it.

   Deliberately recomputed rather than stored: achievement %, the tier, the pool,
   the multiplier and every gate depend on the target and the bands *as they are
   right now*. Mina can edit a target or move a band, so a stored pool would be
   the report quietly asserting yesterday's answer.

   UMD-ish so the same source runs under require() and in a <script>.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommissionRules = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;

  /* ---------- the commission base ---------- */

  /* Policy 01: vat_divisor 1.14, base = (Payment / 1.14) - CreditNotes_exVAT.
     Not invoiced, not gross: cash actually banked, after refunds, before tax.
     The divisor is a policy knob, so it is passed in rather than hard-coded at
     the call sites — but it defaults to the published 1.14. */
  const VAT_DIVISOR = 1.14;

  const netCollection = (paymentIncVat, creditNotesExVat = 0, divisor = VAT_DIVISOR) =>
    r2(n(paymentIncVat) / (Number(divisor) || VAT_DIVISOR) - n(creditNotesExVat));

  /* ---------- achievement and the bands ---------- */

  /* The published defaults. Every one of these is overridable per branch per
     month, which is the whole point of CommissionTarget.floorPct/midPct/maxPct. */
  const BANDS = { floor: 0.8, mid: 0.9, max: 1.0 };

  /* Bands are >=, strictly. Sheet 16 question 16 asks whether 89.6% is a Min or
     a Mid and answers "no rounding" — so 0.896 is Min, not Mid. Round here and
     the policy silently pays a band it did not earn. */
  const achievement = (net, target) => (n(target) > 0 ? n(net) / n(target) : 0);

  const BAND_LABELS = { zero: 'below floor', min: 'Min', mid: 'Mid', max: 'Max' };

  function bandOf(achieved, bands = BANDS) {
    const b = { ...BANDS, ...(bands || {}) };
    const a = n(achieved);
    if (a >= b.max) return 'max';
    if (a >= b.mid) return 'mid';
    if (a >= b.floor) return 'min';
    return 'zero';
  }

  /* The bands a specific branch-month actually uses: its own overrides where set,
     the policy default everywhere else. A null override must fall through — it
     means "not set", and coercing it to 0 would put every branch permanently in
     the Max band. */
  function bandsFor(row, defaults = BANDS) {
    const d = { ...BANDS, ...(defaults || {}) };
    const pick = (v, fallback) => (v === null || v === undefined || v === '' ? fallback : Number(v));
    return {
      floor: pick(row && row.floorPct, d.floor),
      mid: pick(row && row.midPct, d.mid),
      max: pick(row && row.maxPct, d.max),
    };
  }

  /* True when this branch-month is not simply following the policy. The UI marks
     these, because an invisible override is how a policy quietly stops applying. */
  const hasOverride = (row) =>
    !!row && [row.floorPct, row.midPct, row.maxPct].some((v) => v !== null && v !== undefined && v !== '');

  /* ---------- the 14-tier ladder ---------- */

  /* rev_from inclusive, rev_to exclusive; the top tier is open-ended (revTo null).
     Sheet 02's own note says so, and it matters at the boundaries: exactly
     3,000,000 is tier 8, not tier 7. */
  function tierOf(net, tiers) {
    const v = n(net);
    const sorted = [...(tiers || [])].sort((a, b) => n(a.revFrom) - n(b.revFrom));
    for (const t of sorted) {
      const from = n(t.revFrom);
      const to = t.revTo === null || t.revTo === undefined || t.revTo === '' ? Infinity : n(t.revTo);
      if (v >= from && v < to) return t;
    }
    return sorted.length && v >= n(sorted[sorted.length - 1].revFrom) ? sorted[sorted.length - 1] : null;
  }

  /* Pool MIN/MAX are the sums of the three source components; MID is the
     arithmetic mean of them. Sheet 02 and the README both state that the source
     document's own renderer computes mid = (min+max)/2, so it is reproduced
     rather than invented.

     Sheet 16 question 1 is a BLOCKER against this: the policy prose says the
     3M-3.5M Max pool is 22,500 while these components sum to 32,000. We follow
     the DATA, report the conflict, and the test pins both numbers so nobody
     "fixes" it silently. */
  function poolsOf(tier) {
    if (!tier) return { min: 0, mid: 0, max: 0 };
    const min = r2(n(tier.recepMin) + n(tier.seniorMin) + n(tier.girlMin));
    const max = r2(n(tier.recepMax) + n(tier.seniorMax) + n(tier.girlMax));
    return { min, mid: r2((min + max) / 2), max };
  }

  const poolForBand = (tier, band) => (band === 'zero' ? 0 : poolsOf(tier)[band] || 0);

  /* ---------- service mini-bonuses ---------- */

  /* Stack multiplicatively, then hard-cap. The natural product of all three is
     1.20 x 1.15 x 1.25 = 1.725, and the policy caps it at 1.60 — so the cap is
     not decoration, it binds whenever all three are earned. */
  const MULTIPLIER_CAP = 1.6;

  /* A category is earned when its revenue reaches its own monthly target AND its
     mix guardrail holds. Injections carry a CAP (<= 50% of mix) rather than a
     floor, which is deliberate: sheet 16 question 14 flags that hitting the
     target and staying under the cap can conflict, and confirms it is intended. */
  function departmentEarned(dept, revenue, categoryTarget, mixShare) {
    if (!dept || dept.multiplier === null || dept.multiplier === undefined) return false;
    if (!(n(revenue) >= n(categoryTarget)) || n(categoryTarget) <= 0) return false;
    if (dept.mixFloor !== null && dept.mixFloor !== undefined && !(n(mixShare) >= n(dept.mixFloor))) return false;
    if (dept.mixCap !== null && dept.mixCap !== undefined && !(n(mixShare) <= n(dept.mixCap))) return false;
    return true;
  }

  function serviceMultiplier(earnedDepartments, cap = MULTIPLIER_CAP) {
    const raw = (earnedDepartments || []).reduce((m, d) => m * (n(d.multiplier) || 1), 1);
    const limit = Number(cap) || MULTIPLIER_CAP;
    return { raw: Math.round(raw * 1e6) / 1e6, applied: Math.min(raw, limit), capped: raw > limit };
  }

  /* ---------- the team split ---------- */

  /* Applied to the pool AFTER multipliers — sheet 03's own subtitle. Rounding is
     per role to whole piastres; the test checks the parts still sum to the pool. */
  function splitPool(pool, roles) {
    return (roles || [])
      .slice()
      .sort((a, b) => n(a.sortOrder) - n(b.sortOrder))
      .map((role) => ({ role: role.name, sharePct: n(role.sharePct), amount: r2(n(pool) * n(role.sharePct)) }));
  }

  /* ---------- the management gates ---------- */

  /* Area Manager: at least `minBranches` of his area at or above the floor, then
     8% of the SUM of that area's pools. Below the bar he earns nothing even if
     one branch paid its team well — worked example B in sheet 12. */
  function areaGate(branchResults, { rate, minBranches = 2, floor = BANDS.floor } = {}) {
    const rows = branchResults || [];
    const hits = rows.filter((b) => n(b.achievement) >= n(floor)).length;
    const poolSum = r2(rows.reduce((s, b) => s + n(b.pool), 0));
    const passed = hits >= n(minBranches);
    return { hits, of: rows.length, poolSum, passed, amount: passed ? r2(poolSum * n(rate)) : 0 };
  }

  /* Sales Director: EITHER >= minBranches of the 11 at the floor OR group
     collection >= groupPct of the group target. Sheet 15 T8/T9 pin that each
     limb passes on its own. */
  function directorGate(branchResults, { rate, minBranches = 6, groupPct = 0.85, floor = BANDS.floor } = {}) {
    const rows = branchResults || [];
    const hits = rows.filter((b) => n(b.achievement) >= n(floor)).length;
    const poolSum = r2(rows.reduce((s, b) => s + n(b.pool), 0));
    const groupNet = rows.reduce((s, b) => s + n(b.net), 0);
    const groupTarget = rows.reduce((s, b) => s + n(b.target), 0);
    const groupAchieved = groupTarget > 0 ? groupNet / groupTarget : 0;
    const byCount = hits >= n(minBranches);
    const byGroup = groupAchieved >= n(groupPct);
    const passed = byCount || byGroup;
    return {
      hits, of: rows.length, poolSum, groupNet: r2(groupNet), groupTarget: r2(groupTarget),
      groupAchieved, byCount, byGroup, passed, amount: passed ? r2(poolSum * n(rate)) : 0,
    };
  }

  /* ---------- call centre ---------- */

  /* Gross = sum(count x bucket rate). Standard rebooks inside 6 months pay 0 —
     the policy calls that the patient's own habit, not call-centre work. */
  function callCenterGross(countsByBucket, rates) {
    const byBucket = new Map((rates || []).map((r) => [r.bucket, n(r.bonus)]));
    let gross = 0;
    const lines = [];
    for (const [bucket, count] of Object.entries(countsByBucket || {})) {
      const rate = byBucket.has(bucket) ? byBucket.get(bucket) : 0;
      const amount = r2(n(count) * rate);
      gross += amount;
      lines.push({ bucket, count: n(count), rate, amount });
    }
    return { gross: r2(gross), lines };
  }

  /* 75% follows the agent who booked the patient, 25% is split equally across the
     team. Shares are policy knobs, not literals. */
  function callCenterSplit(gross, individualShare = 0.75) {
    const ind = r2(n(gross) * n(individualShare));
    return { individual: ind, team: r2(n(gross) - ind) };
  }

  const followUpBonus = (confirmations, rate = 5, cap = 1500) =>
    Math.min(r2(n(confirmations) * n(rate)), n(cap));

  /* Highest band wins — never 10,000 + 20,000. Sheet 11 says so explicitly and
     T17 pins 87% paying exactly 20,000. */
  function showRateBonus(rate, bands) {
    const eligible = (bands || [])
      .filter((b) => n(rate) >= n(b.threshold))
      .sort((a, b) => n(b.threshold) - n(a.threshold));
    return eligible.length ? { bonus: n(eligible[0].bonus), band: eligible[0].label || null } : { bonus: 0, band: null };
  }

  /* ---------- one branch-month, end to end ---------- */

  /* The README's calc order, in order, so the sequence lives in one place:
     net -> achievement -> floor check -> tier -> band pool -> multipliers -> split. */
  function branchMonth({ net, target, bands, tiers, roles, earnedDepartments, multiplierCap }) {
    const b = { ...BANDS, ...(bands || {}) };
    const achieved = achievement(net, target);
    const band = bandOf(achieved, b);
    const tier = tierOf(net, tiers);
    const pools = poolsOf(tier);
    const basePool = poolForBand(tier, band);
    const mult = serviceMultiplier(band === 'zero' ? [] : earnedDepartments || [], multiplierCap);
    const pool = r2(basePool * mult.applied);
    return {
      net: r2(net), target: r2(target), achievement: achieved, bands: b, band,
      bandLabel: BAND_LABELS[band],
      tierNo: tier ? tier.tierNo : null, tierLabel: tier ? tier.label : null,
      pools, basePool, multiplier: mult, pool,
      roles: splitPool(pool, roles),
    };
  }

  /* ---------- presentation ---------- */

  /* Reuses the sales report's own vocabulary so a branch reads the same way on
     both tabs: at or above pace is green, within reach amber, below red. */
  function bandTone(band) {
    if (band === 'max') return 'g';
    if (band === 'mid') return 'g';
    if (band === 'min') return 'a';
    return 'r';
  }

  const ENTITIES = ['Nouvel Age', 'ZAT'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = (m) => MONTHS[Number(m) - 1] || String(m);

  return {
    VAT_DIVISOR, BANDS, BAND_LABELS, MULTIPLIER_CAP, ENTITIES, MONTHS, monthName,
    netCollection, achievement, bandOf, bandsFor, hasOverride,
    tierOf, poolsOf, poolForBand,
    departmentEarned, serviceMultiplier, splitPool,
    areaGate, directorGate,
    callCenterGross, callCenterSplit, followUpBonus, showRateBonus,
    branchMonth, bandTone,
  };
});
