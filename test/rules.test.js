/**
 * Guards for the three defects this cleanup pass fixed. Each one shipped once;
 * none of them announced itself, so each gets a test.
 *
 *   node test/logic.test.js
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { toneOf, dailyTarget, matcher } = require('../src/lib/rules.js');

/* ---- A1 · dates must come from local components, never toISOString ---- */

function checkDates(tz) {
  const out = execFileSync(process.execPath, ['-e', `
    const { iso } = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'rules.js'))});
    const now = new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const pad = (n) => String(n).padStart(2, '0');
    console.log(JSON.stringify({
      today: iso(t),
      expected: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
      monthStart: iso(new Date(t.getFullYear(), t.getMonth(), 1)),
      expectedMonth: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01',
    }));
  `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });

  const r = JSON.parse(out);
  assert.strictEqual(r.today, r.expected, `${tz}: "Today" resolved to ${r.today}, not ${r.expected}`);
  assert.strictEqual(r.monthStart, r.expectedMonth, `${tz}: month start was ${r.monthStart}`);
}

// Africa/Cairo is east of UTC — the timezone that produced the original bug.
// Pacific/Kiritimati (+14) and Pacific/Niue (-11) bracket the extremes.
for (const tz of ['Africa/Cairo', 'UTC', 'Pacific/Kiritimati', 'Pacific/Niue']) checkDates(tz);

/* ---- A2 · colour thresholds, on the unrounded ratio ---- */

assert.strictEqual(toneOf(100, 100), 'g', 'exactly on target is green');
assert.strictEqual(toneOf(101, 100), 'g');
assert.strictEqual(toneOf(85, 100), 'a', 'the amber floor is inclusive');
assert.strictEqual(toneOf(84.9, 100), 'r');
assert.strictEqual(toneOf(0, 100), 'r');
assert.strictEqual(toneOf(5, 0), 'r', 'no target means nothing to be green against');

// The row from the original that displays 100% but is really 99.975% — it is
// amber there, and rounding before colouring would wrongly turn it green.
assert.strictEqual(toneOf(8063, 8065), 'a', '99.975% must stay amber');
assert.strictEqual(Math.round((8063 / 8065) * 100), 100, 'and still display as 100%');

/* ---- A3 · daily targets are derived, not stored ---- */

assert.strictEqual(dailyTarget(3250000, 31), 104839);
assert.strictEqual(dailyTarget(250000, 31), 8065, 'rounds up');
assert.strictEqual(dailyTarget(150000, 31), 4839);
assert.strictEqual(dailyTarget(4753125, 31), 153327, 'branch daily comes off Target 1');
assert.strictEqual(dailyTarget(3100000, 30), 103333, 'a 30-day month needs no re-import');

/* ---- A5 · name resolution is explicit, never a guess ---- */

const rows = [
  { name: 'DR. Reem Al Kabbash', ex: 10 },
  { name: 'Dr.Merna Masoud', ex: 20 },
  { name: 'Dr.Merna Ashraf', ex: 30 },
  { name: 'DR. Dina Ghonem', ex: 40 },
];
const find = matcher(rows, { 'Dr Dina Ghoneim': 'DR. Dina Ghonem' });

// Punctuation and spacing are noise the normaliser absorbs.
assert.strictEqual(find('DR.Reem Al-Kabbash').row.ex, 10, 'hyphen vs space must not matter');
assert.strictEqual(find('Reem Al Kabbash').row.ex, 10, 'a missing title must not matter');

// A real spelling difference is resolved only by an explicit alias.
assert.strictEqual(find('Dr Dina Ghoneim').row.ex, 40);
assert.strictEqual(find('Dr Dina Ghoneim').via, 'DR. Dina Ghonem', 'the alias used is reported');

// The case that rules fuzzy matching out: one edit apart, different people.
assert.strictEqual(find('Dr.Merna Masoud').row.ex, 20);
assert.strictEqual(find('Dr Merna Massoud').row, null, 'no silent near-miss guess');
assert.strictEqual(find('Dr. Nobody At All').row, null);

// Odoo holds two records for Dr. Mai mohsen — 887,717.74 over 54 invoices and
// 987.36 over 1. Keeping only one silently deleted the top doctor's whole month.
const dupRows = [
  { name: 'Dr. Mai mohsen', ex: 887717.74, inc: 900000, invoices: 54, branches: ['Alex Camp Chizar'] },
  { name: 'Mai mohsen', ex: 987.36, inc: 992.27, invoices: 1, branches: ['Roushdy'] },
];
const merged = matcher(dupRows, {})('Dr. Mai mohsen').row;
assert.strictEqual(merged.ex, 888705.1, 'duplicate Odoo records are summed, not dropped');
assert.strictEqual(merged.invoices, 55);
assert.deepStrictEqual(merged.branches, ['Alex Camp Chizar', 'Roushdy'], 'branches are unioned');
assert.deepStrictEqual(merged.mergedFrom, ['Dr. Mai mohsen', 'Mai mohsen'], 'the merge is reported, not silent');
assert.strictEqual(matcher([dupRows[0]], {})('Dr. Mai mohsen').row.mergedFrom, undefined,
  'a single record carries no merge flag');

console.log('✓ dates are timezone-proof · colours match the original · names resolve explicitly');
