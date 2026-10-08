/* `const DATA`, `const APPT` and `const CRM`, rebuilt from Postgres, against
 * the originals.
 *
 *   node test/cc-bootstrap.test.js
 *
 * The Contact Centre report runs the standalone dashboard's own script rather
 * than a re-implementation of it, for the reason the merged Targets report
 * does: re-implementing drifted panel by panel, and a hundred small drifts is
 * a different page.
 *
 * That script opens with three constants. `src/lib/cc-bootstrap.js` rebuilds
 * them from the tables the import filled, and this proves the rebuild is the
 * same data — against `data/cc-*.json`, the blob lifted out of the original
 * file.
 *
 * EVERY ROW IS COMPARED, NOT A SAMPLE AND NOT A TOTAL. These are positional
 * tuples: `APPT.R[i][13]` is the ZAT flag and `[12]` is the reschedule flag,
 * both 0/1, and swapping them changes every number on the page while keeping
 * every count and every sum identical. Totals cannot see a transposition, so
 * the rows are compared element by element.
 */
const pathRoot = require('path').join(__dirname, '..');
const Bootstrap = require(`${pathRoot}/src/lib/cc-bootstrap.js`);
const { prisma } = require(`${pathRoot}/src/lib/db.js`);

const DATA0 = require(`${pathRoot}/data/cc-DATA.json`);
const APPT0 = require(`${pathRoot}/data/cc-APPT.json`);
const CRM0 = require(`${pathRoot}/data/cc-CRM.json`);

let fails = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Two arrays of tuples, compared element by element.
 *
 * Reports the first row that differs and which slot, because "R differs" on
 * 3,638 rows of 14 columns is not a usable thing to be told.
 */
function sameRows(label, got, want) {
  if (got.length !== want.length) {
    ok(label, false, `${got.length} rows vs ${want.length}`);
    return;
  }
  for (let i = 0; i < want.length; i += 1) {
    const a = got[i];
    const b = want[i];
    if (a.length !== b.length) {
      ok(label, false, `row ${i} has ${a.length} fields, expected ${b.length}`);
      return;
    }
    for (let j = 0; j < b.length; j += 1) {
      if (JSON.stringify(a[j]) !== JSON.stringify(b[j])) {
        ok(label, false, `row ${i} slot ${j}: ${JSON.stringify(a[j])} vs ${JSON.stringify(b[j])}`);
        return;
      }
    }
  }
  ok(`${label} — all ${want.length} rows identical`, true);
}

const sameList = (label, got, want) => ok(
  `${label} — ${want.length} entries identical`,
  JSON.stringify(got) === JSON.stringify(want),
  `${JSON.stringify(got).slice(0, 120)} vs ${JSON.stringify(want).slice(0, 120)}`,
);

async function main() {
  console.log('DATA, APPT and CRM, rebuilt from Postgres\n');
  const { DATA, APPT, CRM } = await Bootstrap.build();

  console.log('DATA — the lookups the tuples index into:');
  for (const k of ['E', 'B', 'P', 'D', 'LG']) sameList(`DATA.${k}`, DATA[k], DATA0[k]);

  console.log('\nDATA — the rows:');
  sameRows('DATA.R', DATA.R, DATA0.R);
  sameList('DATA.H', DATA.H, DATA0.H);
  ok('DATA.H is parallel to DATA.R', DATA.H.length === DATA.R.length,
    `${DATA.H.length} vs ${DATA.R.length}`);

  console.log('\nAPPT — the lookups:');
  for (const k of ['BR', 'DOC', 'PP', 'CAT', 'FAM']) sameList(`APPT.${k}`, APPT[k], APPT0[k]);

  console.log('\nAPPT — the rows and the window:');
  sameRows('APPT.R', APPT.R, APPT0.R);
  sameList('APPT.RANGE', APPT.RANGE, APPT0.RANGE);
  ok(`APPT.SNAP is ${APPT0.SNAP}`, APPT.SNAP === APPT0.SNAP, JSON.stringify(APPT.SNAP));

  console.log('\nCRM — the lookups:');
  for (const k of ['U', 'PN', 'Bs', 'Ty', 'OUT', 'DUPN']) sameList(`CRM.${k}`, CRM[k], CRM0[k]);

  console.log('\nCRM — the rows:');
  sameRows('CRM.A', CRM.A, CRM0.A);
  sameRows('CRM.L', CRM.L, CRM0.L);
  sameRows('CRM.RB', CRM.RB, CRM0.RB);

  console.log('\nCRM.EI — the employee index, keyed by name:');
  const namesGot = Object.keys(CRM.EI).sort();
  const namesWant = Object.keys(CRM0.EI).sort();
  sameList(`CRM.EI keys (${namesWant.length})`, namesGot, namesWant);
  let eiBad = null;
  for (const n of namesWant) {
    if (JSON.stringify(CRM.EI[n]) !== JSON.stringify(CRM0.EI[n])) {
      eiBad = `${n}: ${JSON.stringify(CRM.EI[n])} vs ${JSON.stringify(CRM0.EI[n])}`;
      break;
    }
  }
  ok('every employee record identical', !eiBad, eiBad);

  /* ---- the two flags a sum cannot tell apart ----
     Slots 12 and 13 of an appointment are both 0/1. If the rebuild swapped
     them, every count and every total above would still pass. */
  console.log('\nThe flags a total cannot distinguish:');
  const col = (rows, j) => rows.reduce((t, r) => t + (r[j] ? 1 : 0), 0);
  ok(`APPT reschedules = ${col(APPT0.R, 12)}`, col(APPT.R, 12) === col(APPT0.R, 12),
    `${col(APPT.R, 12)} vs ${col(APPT0.R, 12)}`);
  ok(`APPT ZAT rows = ${col(APPT0.R, 13)}`, col(APPT.R, 13) === col(APPT0.R, 13),
    `${col(APPT.R, 13)} vs ${col(APPT0.R, 13)}`);
  ok(`APPT confirm calls = ${col(APPT0.R, 10)}`, col(APPT.R, 10) === col(APPT0.R, 10),
    `${col(APPT.R, 10)} vs ${col(APPT0.R, 10)}`);
  ok(`opportunities shown = ${col(DATA0.R, 7)}`, col(DATA.R, 7) === col(DATA0.R, 7),
    `${col(DATA.R, 7)} vs ${col(DATA0.R, 7)}`);
  ok(`leads booked = ${col(CRM0.L, 4)}`, col(CRM.L, 4) === col(CRM0.L, 4),
    `${col(CRM.L, 4)} vs ${col(CRM0.L, 4)}`);

  /* Revenue comes back out of a Decimal column as a string; the script adds it
     with `+`, so a string would concatenate rather than sum. */
  const rev = (rows) => rows.reduce((t, r) => t + r[8], 0);
  console.log('\nRevenue survives the Decimal round-trip as a number:');
  ok('every revenue is a number, not a string', DATA.R.every((r) => typeof r[8] === 'number'));
  ok(`total revenue = ${rev(DATA0.R).toLocaleString()}`, rev(DATA.R) === rev(DATA0.R),
    `${rev(DATA.R)} vs ${rev(DATA0.R)}`);

  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exitCode = fails ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
