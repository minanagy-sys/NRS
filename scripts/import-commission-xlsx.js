#!/usr/bin/env node
/**
 * Import Commission Policy 2026 v2.7 from its Excel workbook.
 *
 *   node scripts/import-commission-xlsx.js <file.xlsx>            # dry run
 *   node scripts/import-commission-xlsx.js <file.xlsx> --write    # commit
 *
 * The dry run is the default on purpose: this replaces the branch side of the
 * Target tab, so you get to read the reconciliation before anything is written.
 *
 * TWO KINDS OF DISAGREEMENT, treated very differently:
 *
 *   1. "Did I read the sheet correctly?" — every figure the workbook states for
 *      itself (its GROUP TOTAL rows, its per-branch Annual Sum column, its own
 *      row counts) is recomputed from the cells this script parsed. Any mismatch
 *      is a parse bug and it REFUSES TO WRITE.
 *
 *   2. "Is the workbook self-consistent?" — it is not, in six places, and sheet
 *      16 documents every one. CampShizar's months sum to 200 more than its
 *      annual; four service splits miss their annual by a few thousand; the
 *      cover says 245.5M where the branches say 245,449,732. Those are REPORTED
 *      and imported as-is. Blocking on them would mean never importing, and
 *      silently "fixing" them would mean inventing figures Finance never signed.
 */

const fs = require('fs');
const path = require('path');
const Sheet = require('../src/lib/sheet.js');
const { prisma } = require('../src/lib/db.js');

const file = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!file) {
  console.error('Usage: node scripts/import-commission-xlsx.js <file.xlsx> [--write]');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const YEAR = 2026;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- reading ---------- */

const norm = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const dec = (v) => (v === null ? null : Number(v).toFixed(2));

/** The grid for one sheet, with the header located by the column names it must
 *  carry rather than a fixed row number — the workbook's own README says the
 *  header is on row 4, but sheetRows() drops the blank row above it, so a
 *  hard-coded index would read the subtitle as a header. */
function table(sheetName, mustHave) {
  const { grid, sheets } = Sheet.gridOf(buf, sheetName);
  if (!sheets.includes(sheetName)) throw new Error(`No sheet named "${sheetName}". Found: ${sheets.join(', ')}`);
  const at = grid.findIndex((r) => r && mustHave.every((h) => r.some((c) => norm(c) === h)));
  if (at < 0) throw new Error(`${sheetName}: could not find a header row containing ${mustHave.join(' + ')}`);
  const cols = grid[at].map(norm);
  const idx = (name) => cols.indexOf(name);
  const rows = grid.slice(at + 1)
    .filter((r) => r && r.some((c) => norm(c) !== ''))
    .map((r) => ({ raw: r, get: (name) => r[idx(name)], cols }));
  return { cols, rows, idx };
}

const problems = [];   // parse disagreements — these block
const notes = [];      // the workbook's own inconsistencies — these are reported
const bad = (m) => problems.push(m);
const note = (m) => notes.push(m);

/* ---------- 01 policy config ---------- */
const cfgT = table('01_Policy_Config', ['Key', 'Value', 'Type']);
const policy = cfgT.rows
  .filter((r) => norm(r.get('Key')))
  .map((r) => ({
    key: norm(r.get('Key')),
    value: norm(r.get('Value')),
    type: norm(r.get('Type')) || 'string',
    note: norm(r.get('Description / Source note')) || null,
  }));
const cfg = Object.fromEntries(policy.map((p) => [p.key, p.value]));

/* ---------- 04 branches ---------- */
const brT = table('04_Branches', ['Branch', 'Area', 'Group', 'Odoo Journal Code']);
const ANNUAL_COL = brT.cols.find((c) => /Annual Target/i.test(c));
const branches = [];
let statedGroupAnnual = null;
brT.rows.forEach((r, i) => {
  const name = norm(r.get('Branch'));
  if (!name) return;
  if (/^GROUP TOTAL$/i.test(name)) { statedGroupAnnual = num(r.get(ANNUAL_COL)); return; }
  if (/^Journal codes|^HQ-level/i.test(name)) return; // trailing prose
  const code = norm(r.get('Odoo Journal Code'));
  branches.push({
    name,
    area: norm(r.get('Area')),
    entity: norm(r.get('Group')),
    journalCode: /^NOT IN SOURCE$|^\(unknown\)$/i.test(code) ? null : code || null,
    annualTarget: num(r.get(ANNUAL_COL)),
    sortOrder: i + 1,
  });
});
if (branches.length !== 11) bad(`04_Branches: parsed ${branches.length} branches, the sheet says 11`);
const annualSum = branches.reduce((s, b) => s + (b.annualTarget || 0), 0);
if (statedGroupAnnual !== null && Math.round(annualSum) !== Math.round(statedGroupAnnual)) {
  bad(`04_Branches: my branch annuals sum to ${annualSum.toLocaleString()}, its GROUP TOTAL row says ${statedGroupAnnual.toLocaleString()}`);
}
const stated = num(cfg.group_annual_target_stated);
if (stated && Math.round(stated) !== Math.round(annualSum)) {
  note(`the cover states EGP ${stated.toLocaleString()} but the 11 branch annuals sum to ${annualSum.toLocaleString()} (${(annualSum - stated).toLocaleString()}) — sheet 16 q8 says use the per-branch figures`);
}

/* ---------- 06 monthly targets (wide) ---------- */
const mtT = table('06_Monthly_Targets', ['Branch', 'Group', 'Jan', 'Dec']);
const SUM_COL = mtT.cols.find((c) => /Annual Sum/i.test(c));
const targets = [];              // { branch, month, target }
const monthTotalsStated = {};
mtT.rows.forEach((r) => {
  const name = norm(r.get('Branch'));
  if (!name) return;
  if (/^GROUP TOTAL$/i.test(name)) {
    MONTHS.forEach((m, i) => { monthTotalsStated[i + 1] = num(r.get(m)); });
    return;
  }
  if (!branches.some((b) => b.name === name)) { bad(`06_Monthly_Targets: "${name}" is not one of the 11 branches`); return; }
  let rowSum = 0;
  MONTHS.forEach((m, i) => {
    const v = num(r.get(m));
    if (v === null) { bad(`06_Monthly_Targets: ${name} has no ${m} target`); return; }
    rowSum += v;
    targets.push({ branch: name, month: i + 1, target: v });
  });
  const statedRow = num(r.get(SUM_COL));
  if (statedRow !== null && Math.round(rowSum) !== Math.round(statedRow)) {
    bad(`06_Monthly_Targets: ${name} months sum to ${rowSum.toLocaleString()} but its Annual Sum column says ${statedRow.toLocaleString()}`);
  }
  const br = branches.find((b) => b.name === name);
  if (br && br.annualTarget !== null && Math.round(rowSum) !== Math.round(br.annualTarget)) {
    note(`${name}: 12 monthly targets sum to ${rowSum.toLocaleString()} but sheet 04 states an annual of ${br.annualTarget.toLocaleString()} (${(rowSum - br.annualTarget) > 0 ? '+' : ''}${(rowSum - br.annualTarget).toLocaleString()}) — sheet 16 q9; the MONTHLY figures drive monthly commission`);
  }
});
if (targets.length !== 132) bad(`06_Monthly_Targets: built ${targets.length} branch-months, expected 11 x 12 = 132`);
for (const [m, statedTotal] of Object.entries(monthTotalsStated)) {
  if (statedTotal === null) continue;
  const mine = targets.filter((t) => t.month === Number(m)).reduce((s, t) => s + t.target, 0);
  if (Math.round(mine) !== Math.round(statedTotal)) {
    bad(`06_Monthly_Targets: ${MONTHS[m - 1]} column sums to ${mine.toLocaleString()} but its GROUP TOTAL row says ${statedTotal.toLocaleString()}`);
  }
}

/* cross-check the long form against the wide one — the workbook ships both, so
   disagreeing with itself here would be a real find */
const lgT = table('07_Monthly_Targets_Long', ['branch', 'year', 'month_no', 'monthly_target_egp']);
let longRows = 0;
for (const r of lgT.rows) {
  const name = norm(r.get('branch'));
  if (!name || !branches.some((b) => b.name === name)) continue;
  longRows++;
  const m = num(r.get('month_no'));
  const v = num(r.get('monthly_target_egp'));
  const wide = targets.find((t) => t.branch === name && t.month === m);
  if (!wide) { bad(`07 long form has ${name} month ${m} which the wide sheet does not`); continue; }
  if (Math.round(wide.target) !== Math.round(v)) {
    bad(`${name} ${MONTHS[m - 1]}: wide sheet says ${wide.target.toLocaleString()}, long sheet says ${v.toLocaleString()}`);
  }
}
if (longRows !== 132) bad(`07_Monthly_Targets_Long: ${longRows} branch-month rows, expected 132`);

/* ---------- 05 + 08 departments and splits ---------- */
const spT = table('05_Annual_Service_Split', ['Branch', 'Laser (EGP)', 'Injections (EGP)']);
const bonT = table('08_Service_Bonuses', ['Service Category', 'Multiplier']);
const bonus = {};
for (const r of bonT.rows) {
  const cat = norm(r.get('Service Category'));
  if (!cat || /^STACKING|^All 3|^Natural|^Revenue target|^Worked example|^Strategic/i.test(cat)) continue;
  bonus[cat] = {
    multiplier: num(r.get('Multiplier')),
    condition: norm(r.get('Condition to Earn')) || null,
    guardrail: norm(r.get('Mix Guardrail')) || null,
    groupMix: num(r.get('Group Mix Reference')),
  };
}
/* The data has 4 target buckets; the bonus rules name 3 categories, one of which
   (Body Contouring) has NO column anywhere. Sheet 16 q3 calls that a BLOCKER.
   So Body Contouring is created as a real department with its multiplier and no
   target data, rather than quietly folded into skin_dev — which would invent a
   target and hand out a 1.25x bonus against it. */
const departments = [
  { key: 'laser', label: 'Devices & Laser', col: 'Laser (EGP)', bonusName: 'Devices & Laser', mixFloor: 0.30 },
  { key: 'inj', label: 'Injections', col: 'Injections (EGP)', bonusName: 'Injections', mixCap: 0.50 },
  { key: 'skin_dev', label: 'Skin & Devices', col: 'Skin & Devices (EGP)', bonusName: null },
  { key: 'other', label: 'Skin & Other', col: 'Other (EGP)', bonusName: 'Skin & Other' },
  { key: 'body', label: 'Body Contouring', col: null, bonusName: 'Body Contouring' },
].map((d, i) => {
  const b = d.bonusName ? bonus[d.bonusName] : null;
  return {
    key: d.key, label: d.label, col: d.col, sortOrder: i + 1,
    multiplier: b && b.multiplier ? b.multiplier : null,
    mixFloor: d.mixFloor ?? null, mixCap: d.mixCap ?? null,
    groupMix: b ? b.groupMix : null,
    condition: b ? b.condition : null,
  };
});
if (!departments.find((d) => d.key === 'body').multiplier) bad('08_Service_Bonuses: Body Contouring has no multiplier');
note('Body Contouring carries a 1.25x multiplier but has NO target column in sheet 05 — imported with no target data rather than folded into Skin & Devices (sheet 16 q3, BLOCKER)');

const splits = [];
for (const r of spT.rows) {
  const name = norm(r.get('Branch'));
  if (!name || /^GROUP TOTAL$/i.test(name) || !branches.some((b) => b.name === name)) continue;
  const annual = num(r.get('Annual Target (EGP)'));
  let sum = 0;
  for (const d of departments) {
    if (!d.col) continue;
    const v = num(r.get(d.col));
    if (v === null) { bad(`05_Annual_Service_Split: ${name} has no ${d.col}`); continue; }
    sum += v;
    splits.push({ branch: name, department: d.key, annualTarget: v });
  }
  const statedSplitSum = num(r.get('Split Sum (EGP)'));
  if (statedSplitSum !== null && Math.round(sum) !== Math.round(statedSplitSum)) {
    bad(`05: ${name} splits sum to ${sum.toLocaleString()} but its Split Sum column says ${statedSplitSum.toLocaleString()}`);
  }
  if (annual !== null && Math.round(sum) !== Math.round(annual)) {
    note(`${name}: service splits sum to ${sum.toLocaleString()} against an annual target of ${annual.toLocaleString()} (${(sum - annual) > 0 ? '+' : ''}${(sum - annual).toLocaleString()}) — sheet 16 q10`);
  }
}

/* ---------- 02 ladder ---------- */
const ldT = table('02_Commission_Ladder', ['Tier #', 'Tier Label', 'Rev From (EGP)']);
const tiers = [];
for (const r of ldT.rows) {
  const no = num(r.get('Tier #'));
  if (no === null) continue;
  const to = norm(r.get('Rev To (EGP)'));
  tiers.push({
    tierNo: no, label: norm(r.get('Tier Label')),
    revFrom: num(r.get('Rev From (EGP)')),
    revTo: /^OPEN$/i.test(to) ? null : num(to),
    recepMin: num(r.get('recep_min')), recepMax: num(r.get('recep_max')),
    seniorMin: num(r.get('senior_min')), seniorMax: num(r.get('senior_max')),
    girlMin: num(r.get('girl_min')), girlMax: num(r.get('girl_max')),
  });
}
if (tiers.length !== 14) bad(`02_Commission_Ladder: parsed ${tiers.length} tiers, expected 14`);
for (const t of tiers) {
  const min = t.recepMin + t.seniorMin + t.girlMin;
  const max = t.recepMax + t.seniorMax + t.girlMax;
  const statedMin = num(ldT.rows.find((r) => num(r.get('Tier #')) === t.tierNo).get('Pool MIN (80-89%)'));
  const statedMax = num(ldT.rows.find((r) => num(r.get('Tier #')) === t.tierNo).get('Pool MAX (>=100%)'));
  if (statedMin !== null && Math.round(min) !== Math.round(statedMin)) bad(`tier ${t.tierNo}: components sum to a MIN of ${min} but the sheet says ${statedMin}`);
  if (statedMax !== null && Math.round(max) !== Math.round(statedMax)) bad(`tier ${t.tierNo}: components sum to a MAX of ${max} but the sheet says ${statedMax}`);
}
note('the ladder DATA gives the 3M-3.5M Max pool as 32,000 while the policy prose says 22,500 — sheet 16 q1, BLOCKER; the data is imported and test/commission-rules.test.js pins both numbers');

/* ---------- 03 roles ---------- */
const rlT = table('03_Team_Split', ['Order', 'Role', 'Share %']);
const roles = [];
for (const r of rlT.rows) {
  const name = norm(r.get('Role'));
  const share = num(r.get('Share %'));
  if (!name || /^TOTAL$/i.test(name) || share === null) continue;
  roles.push({ name, sharePct: share, sortOrder: num(r.get('Order')) || roles.length + 1 });
}
const roleSum = roles.reduce((s, r) => s + r.sharePct, 0);
if (roles.length !== 5) bad(`03_Team_Split: parsed ${roles.length} roles, expected 5`);
if (Math.abs(roleSum - 1) > 1e-9) bad(`03_Team_Split: role shares sum to ${roleSum}, not 1`);

/* ---------- 09/10/11 call centre ---------- */
const ccT = table('09_CallCenter_Rates', ['Bucket', 'Bonus (EGP)']);
const ccRates = []; let individualShare = null; let followUpRate = null; let followUpCap = null;
for (const r of ccT.rows) {
  const bucket = norm(r.get('Bucket'));
  const bonus = num(r.get('Bonus (EGP)'));
  /* The DISTRIBUTION block half way down sheet 09 carries its OWN sub-header
     (Bucket | Share | | How it is distributed), so "Share" is not one of the
     columns named in the sheet's main header and r.get('Share') is undefined.
     Take the first number on the row instead. */
  const firstNum = () => { for (let i = 1; i < r.raw.length; i++) { const v = num(r.raw[i]); if (v !== null) return v; } return null; };
  if (/^Individual Pool$/i.test(bucket)) { individualShare = firstNum(); continue; }
  if (/^Team Pool$/i.test(bucket)) continue;
  if (/^Per successful confirmation$/i.test(bucket)) { followUpRate = bonus; continue; }
  if (/^Monthly cap$/i.test(bucket)) { followUpCap = bonus; continue; }
  if (!bucket || bonus === null || /^DISTRIBUTION|^FOLLOW-UP|^Excluded from|^Bucket$/i.test(bucket)) continue;
  ccRates.push({ bucket, windowLabel: norm(r.get('Absence Window')) || null, bonus, note: norm(r.get('Condition / Note')) || null, sortOrder: ccRates.length + 1 });
}
if (ccRates.length !== 5) bad(`09_CallCenter_Rates: parsed ${ccRates.length} buckets, expected 5`);
if (individualShare !== 0.75) bad(`09: individual pool share parsed as ${individualShare}, expected 0.75`);
if (followUpRate !== 5 || followUpCap !== 1500) bad(`09: follow-up scheme parsed as ${followUpRate}/${followUpCap}, expected 5 capped at 1500`);

const tmT = table('10_CallCenter_Team', ['Name', 'Role', 'Bonus Scheme']);
const members = tmT.rows
  .filter((r) => norm(r.get('Name')) && !/^Source states/i.test(norm(r.get('Name'))))
  .map((r) => ({ name: norm(r.get('Name')), role: norm(r.get('Role')), serves: norm(r.get('Serves')) || null, scheme: norm(r.get('Bonus Scheme')) || null, status: norm(r.get('Status')) || 'Active' }));
if (members.length !== 13) bad(`10_CallCenter_Team: parsed ${members.length} people, the sheet says 13`);

const srT = table('11_ShowRate_KPI', ['Show-Rate Achieved', 'Threshold', 'Team Bonus (EGP)']);
const showBands = srT.rows
  .filter((r) => num(r.get('Threshold')) !== null && num(r.get('Team Bonus (EGP)')) !== null && num(r.get('Threshold')) > 0)
  .map((r) => ({ label: norm(r.get('Show-Rate Achieved')), threshold: num(r.get('Threshold')), bonus: num(r.get('Team Bonus (EGP)')) }));
if (showBands.length !== 2) bad(`11_ShowRate_KPI: parsed ${showBands.length} paying bands, expected 2`);

/* ---------- 12 gates ---------- */
const gtT = table('12_Management_Gates', ['Role', 'Count', 'Rate', 'Base']);
const gates = [];
for (const r of gtT.rows) {
  const role = norm(r.get('Role'));
  const rate = num(r.get('Rate'));
  if (!role || rate === null) continue;
  if (!/^Area Manager$|^Sales Director$/i.test(role)) continue;
  if (gates.some((g) => g.role === role)) continue;      // the worked examples repeat the label
  const logic = norm(r.get('Gate Logic (implementable)'));
  gates.push({
    role, headcount: num(r.get('Count')) || 1, rate, base: norm(r.get('Base')),
    scope: /Area Manager/i.test(role) ? 'area' : 'group',
    minBranches: /Area Manager/i.test(role) ? 2 : 6,
    groupPct: /Sales Director/i.test(role) ? 0.85 : null,
    gateLabel: norm(r.get('Performance Gate')) || null,
    gateLogic: logic || null,
  });
}
if (gates.length !== 2) bad(`12_Management_Gates: parsed ${gates.length} gate roles, expected Area Manager + Sales Director`);

/* ---------- 13 rules ---------- */
const rfT = table('13_Refund_Rules', ['Case', 'Treatment', 'Affects']);
const rules = rfT.rows
  .filter((r) => norm(r.get('Case')) && norm(r.get('Treatment')))
  .map((r, i) => {
    const subject = norm(r.get('Case'));
    const kind = /cutoff|Payment date/i.test(subject) ? 'timing'
      : /payroll|joiner|Leaver/i.test(subject) ? 'eligibility'
        : /CEO/i.test(subject) ? 'governance' : 'refund';
    return { kind, subject, treatment: norm(r.get('Treatment')), affects: norm(r.get('Affects')) || null, sortOrder: i + 1 };
  });

/* ---------- 15 + 16 notes ---------- */
const tcT = table('15_Test_Cases', ['ID', 'Scenario', 'Input', 'Expected Output']);
const tests = tcT.rows
  .filter((r) => /^T\d+$/i.test(norm(r.get('ID'))))
  .map((r) => ({ kind: 'test', ref: norm(r.get('ID')), title: norm(r.get('Scenario')), detail: norm(r.get('Input')), expected: norm(r.get('Expected Output')), severity: null, resolution: norm(r.get('Source')) || null }));
if (tests.length !== 18) bad(`15_Test_Cases: parsed ${tests.length} cases, expected 18`);

const oqT = table('16_Open_Questions', ['#', 'Severity', 'Issue']);
const questions = oqT.rows
  .filter((r) => num(r.get('#')) !== null)
  .map((r) => ({ kind: 'question', ref: String(num(r.get('#'))), severity: norm(r.get('Severity')), title: norm(r.get('Issue')), detail: norm(r.get('Evidence')), expected: null, resolution: norm(r.get('Suggested Resolution')) || null }));
if (questions.length !== 17) bad(`16_Open_Questions: parsed ${questions.length} items, expected 17`);

/* ---------- report ---------- */
const f = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
console.log(`\n\x1b[1mCommission Policy ${cfg.policy_version || '?'} — ${path.basename(file)}\x1b[0m`);
console.log(`  effective ${cfg.effective_from || '?'} · issued ${cfg.issue_date || '?'}\n`);

console.log('  parsed');
console.log(`    ${String(policy.length).padStart(4)}  policy settings`);
console.log(`    ${String(branches.length).padStart(4)}  branches   ${[...new Set(branches.map((b) => b.entity))].join(' + ')}   annual ${f(annualSum)}`);
console.log(`    ${String(targets.length).padStart(4)}  branch-months (${new Set(targets.map((t) => t.branch)).size} x 12)`);
console.log(`    ${String(departments.length).padStart(4)}  departments  ${departments.map((d) => d.label).join(' · ')}`);
console.log(`    ${String(splits.length).padStart(4)}  annual service splits`);
console.log(`    ${String(tiers.length).padStart(4)}  ladder tiers · ${roles.length} roles summing to ${roleSum}`);
console.log(`    ${String(ccRates.length).padStart(4)}  call centre buckets · ${members.length} people · ${showBands.length} show-rate bands`);
console.log(`    ${String(gates.length).padStart(4)}  management gates · ${rules.length} refund/eligibility rules`);
console.log(`    ${String(tests.length).padStart(4)}  test cases · ${questions.length} open questions`);

const byEntity = {};
for (const b of branches) byEntity[b.entity] = (byEntity[b.entity] || 0) + (b.annualTarget || 0);
console.log('\n  by owning entity');
for (const [e, v] of Object.entries(byEntity)) console.log(`    ${e.padEnd(12)} ${f(v).padStart(14)}`);

console.log('\n  per month, all 11 branches');
for (let m = 1; m <= 12; m++) {
  const mine = targets.filter((t) => t.month === m).reduce((s, t) => s + t.target, 0);
  console.log(`    ${MONTHS[m - 1]}  ${f(mine).padStart(14)}${monthTotalsStated[m] !== null && Math.round(mine) === Math.round(monthTotalsStated[m]) ? '  ✓ matches its own total row' : ''}`);
}

const blockers = questions.filter((q) => q.severity === 'BLOCKER');
if (blockers.length) {
  console.log(`\n  \x1b[33m${blockers.length} BLOCKER${blockers.length === 1 ? '' : 's'} the workbook raises against itself\x1b[0m`);
  for (const b of blockers) console.log(`    ${b.ref}. ${b.title}`);
}
if (notes.length) {
  console.log(`\n  \x1b[33mknown inconsistencies in the source — imported as-is, not silently corrected\x1b[0m`);
  for (const n of notes) console.log(`    · ${n}`);
}

if (problems.length) {
  console.log(`\n  \x1b[31m${problems.length} figure${problems.length === 1 ? '' : 's'} I parsed disagree with what the sheet states for itself:\x1b[0m`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  console.log('\n  \x1b[31mRefusing to write. This is a parse bug, not a source problem.\x1b[0m\n');
  prisma.$disconnect();
  process.exit(1);
}
console.log('\n  \x1b[32m✓ every figure the workbook states for itself reproduces from the cells I parsed\x1b[0m');

if (!WRITE) {
  console.log('\n  Dry run. Nothing written. Re-run with --write to commit.\n');
  prisma.$disconnect();
  process.exit(0);
}

/* ---------- writing ---------- */
(async () => {
  const idOf = {};
  await prisma.$transaction(async (tx) => {
    for (const p of policy) {
      await tx.commissionPolicy.upsert({ where: { key: p.key }, update: { value: p.value, type: p.type, note: p.note }, create: p });
    }
    for (const b of branches) {
      const row = await tx.commissionBranch.upsert({
        where: { name: b.name },
        update: { area: b.area, entity: b.entity, journalCode: b.journalCode, annualTarget: dec(b.annualTarget), sortOrder: b.sortOrder },
        create: { ...b, annualTarget: dec(b.annualTarget) },
      });
      idOf[b.name] = row.id;
    }
    const deptId = {};
    for (const d of departments) {
      const row = await tx.commissionDepartment.upsert({
        where: { key: d.key },
        update: { label: d.label, multiplier: d.multiplier, mixFloor: d.mixFloor, mixCap: d.mixCap, groupMix: d.groupMix, condition: d.condition, sortOrder: d.sortOrder },
        create: { key: d.key, label: d.label, multiplier: d.multiplier, mixFloor: d.mixFloor, mixCap: d.mixCap, groupMix: d.groupMix, condition: d.condition, sortOrder: d.sortOrder },
      });
      deptId[d.key] = row.id;
    }
    /* Targets are upserted, never deleted-then-inserted: an edited band override
       on a branch-month must survive a re-import of the same figures. */
    for (const t of targets) {
      await tx.commissionTarget.upsert({
        where: { branchId_year_month: { branchId: idOf[t.branch], year: YEAR, month: t.month } },
        update: { target: dec(t.target) },
        create: { branchId: idOf[t.branch], year: YEAR, month: t.month, target: dec(t.target) },
      });
    }
    for (const s of splits) {
      await tx.commissionSplit.upsert({
        where: { branchId_departmentId_year: { branchId: idOf[s.branch], departmentId: deptId[s.department], year: YEAR } },
        update: { annualTarget: dec(s.annualTarget) },
        create: { branchId: idOf[s.branch], departmentId: deptId[s.department], year: YEAR, annualTarget: dec(s.annualTarget) },
      });
    }
    for (const t of tiers) {
      const data = { label: t.label, revFrom: dec(t.revFrom), revTo: t.revTo === null ? null : dec(t.revTo), recepMin: dec(t.recepMin), recepMax: dec(t.recepMax), seniorMin: dec(t.seniorMin), seniorMax: dec(t.seniorMax), girlMin: dec(t.girlMin), girlMax: dec(t.girlMax) };
      await tx.commissionTier.upsert({ where: { tierNo: t.tierNo }, update: data, create: { tierNo: t.tierNo, ...data } });
    }
    for (const r of roles) {
      await tx.commissionRole.upsert({ where: { name: r.name }, update: { sharePct: r.sharePct, sortOrder: r.sortOrder }, create: r });
    }
    for (const r of ccRates) {
      await tx.callCenterRate.upsert({ where: { bucket: r.bucket }, update: { windowLabel: r.windowLabel, bonus: dec(r.bonus), note: r.note, sortOrder: r.sortOrder }, create: { ...r, bonus: dec(r.bonus) } });
    }
    for (const m of members) {
      await tx.callCenterMember.upsert({ where: { name: m.name }, update: { role: m.role, serves: m.serves, scheme: m.scheme, status: m.status }, create: m });
    }
    for (const b of showBands) {
      await tx.showRateBand.upsert({ where: { threshold: b.threshold }, update: { label: b.label, bonus: dec(b.bonus) }, create: { ...b, bonus: dec(b.bonus) } });
    }
    for (const g of gates) {
      await tx.managementGate.upsert({ where: { role: g.role }, update: g, create: g });
    }
    await tx.commissionRule.deleteMany({});
    await tx.commissionRule.createMany({ data: rules });
    for (const n of [...tests, ...questions]) {
      await tx.commissionNote.upsert({
        where: { kind_ref: { kind: n.kind, ref: n.ref } },
        update: { severity: n.severity, title: n.title, detail: n.detail, expected: n.expected, resolution: n.resolution },
        create: n,
      });
    }
  }, { timeout: 120000 });

  const counts = {
    policy: await prisma.commissionPolicy.count(),
    branches: await prisma.commissionBranch.count(),
    targets: await prisma.commissionTarget.count(),
    departments: await prisma.commissionDepartment.count(),
    splits: await prisma.commissionSplit.count(),
    tiers: await prisma.commissionTier.count(),
    roles: await prisma.commissionRole.count(),
    ccRates: await prisma.callCenterRate.count(),
    members: await prisma.callCenterMember.count(),
    showBands: await prisma.showRateBand.count(),
    gates: await prisma.managementGate.count(),
    rules: await prisma.commissionRule.count(),
    notes: await prisma.commissionNote.count(),
  };
  console.log('\n  written');
  for (const [k, v] of Object.entries(counts)) console.log(`    ${String(v).padStart(4)}  ${k}`);
  const wrote = await prisma.commissionTarget.aggregate({ _sum: { target: true }, where: { year: YEAR } });
  console.log(`\n  2026 target total in the database: ${f(Number(wrote._sum.target))}`);
  console.log(Math.round(Number(wrote._sum.target)) === Math.round(targets.reduce((s, t) => s + t.target, 0))
    ? '  \x1b[32m✓ equals what was parsed\x1b[0m\n' : '  \x1b[31m✗ does NOT equal what was parsed\x1b[0m\n');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('\n✗', e.message, '\n'); await prisma.$disconnect(); process.exit(1); });
