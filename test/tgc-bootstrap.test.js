/* `const D` and `const TGT`, rebuilt from Postgres, against the originals.
 *
 *   node test/tgc-bootstrap.test.js
 *
 * The merged report runs the standalone dashboard's own script rather than a
 * re-implementation of it, because re-implementing drifted: each panel came out
 * a little different, and a hundred small differences is a different page.
 *
 * That script opens with two constants. `src/lib/tgc-bootstrap.js` rebuilds
 * them from the tables the import filled, and this proves the rebuild is the
 * same data — field by field, against `data/artifact-*.json`, which is the
 * blob lifted out of the original file.
 *
 * THE SHAPES MATTER AS MUCH AS THE TOTALS. `D.TG[branch]` is indexed
 * positionally as twelve arrays of five in `D.G` order, and `D.ddoc[date]` as
 * 5-tuples. A plausible-looking variation is a silently wrong page, not an
 * error, so the structure is asserted and not just the sums.
 */
const pathRoot = require('path').join(__dirname, '..');
const Bootstrap = require(`${pathRoot}/src/lib/tgc-bootstrap.js`);
const { prisma } = require(`${pathRoot}/src/lib/db.js`);

const D0 = require(`${pathRoot}/data/artifact-D.json`);
const T0 = require(`${pathRoot}/data/artifact-TGT.json`);

let fails = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const S = (a) => a.reduce((t, v) => t + (Number(v) || 0), 0);
const round = (v) => Math.round(Number(v) || 0);

/**
 * The fields the dashboard's logic actually reads. Counted out of the file
 * itself: `D.monthTot`, `D.T`, `D.total`, `D.bshare` and `D.t26aug_total` are
 * never referenced below line 454 — leftovers from an earlier revision, which
 * is why the blob's 300,000,001 disagrees with the approved sheet's
 * 315,936,762 and why that disagreement has never mattered.
 */
const USED = ['act', 'actg', 'actp', 'dly', 'ddoc', 'docs', 'rosterB', 'TG', 'TP', 'G', 'wd', 'groups', 'brand'];

async function main() {
  console.log('D and TGT, rebuilt from Postgres\n');
  const { D, TGT } = await Bootstrap.build();

  console.log('Every field the logic reads is present:');
  for (const k of USED) {
    ok(`D.${k}`, D[k] != null && (Array.isArray(D[k]) ? D[k].length : Object.keys(D[k]).length) > 0,
      JSON.stringify(D[k] == null ? null : typeof D[k]));
  }

  console.log('\nThe same size as the original:');
  const sizeOf = (v) => (Array.isArray(v) ? v.length : Object.keys(v).length);
  for (const k of USED) {
    ok(`D.${k} has ${sizeOf(D0[k])} entries`, sizeOf(D[k]) === sizeOf(D0[k]),
      `${sizeOf(D[k])} vs ${sizeOf(D0[k])}`);
  }

  console.log('\nThe same figures:');
  ok('2026-09 actual is 13,989,481',
    round(S(Object.values(D.act['2026-09']))) === round(S(Object.values(D0.act['2026-09']))));
  ok('the CFC seasonal shape totals the same',
    round(S(D.TG.CFC.flat())) === round(S(D0.TG.CFC.flat())),
    `${round(S(D.TG.CFC.flat()))} vs ${round(S(D0.TG.CFC.flat()))}`);
  ok('the weekday weights are byte-identical',
    JSON.stringify(D.wd) === JSON.stringify(D0.wd), JSON.stringify(D.wd));
  ok('the service groups are in the same order',
    D.G.join('|') === D0.G.join('|'), D.G.join('|'));

  const yearOf = (rows, y) => round(S(rows.map((r) => S(Object.keys(r.m)
    .filter((k) => k.startsWith(y)).map((k) => r.m[k])))));
  ok('TGT branches 2027 is 315,936,762',
    yearOf(TGT.branches, '2027') === yearOf(T0.branches, '2027') && yearOf(TGT.branches, '2027') === 315936762,
    String(yearOf(TGT.branches, '2027')));
  ok('TGT doctors 2027 is 306,786,773',
    yearOf(TGT.doctors, '2027') === yearOf(T0.doctors, '2027') && yearOf(TGT.doctors, '2027') === 306786773,
    String(yearOf(TGT.doctors, '2027')));

  /* ---- the brand token the script filters on ----
     It hardcodes `[['Nouvelage','Nouvelage'],['ZAT','ZAT']]` and compares with
     `r.brand === bf`. This database spells the entity "Nouvel Age", so the
     Nouvelage chip matched nothing and the whole table collapsed to a zero
     Total — while ZAT happened to work, which is what made it look like a data
     problem rather than a spelling one. */
  console.log('\nThe brand filter matches the tokens the script uses:');
  const brands = [...new Set(TGT.branches.map((b) => b.brand))].sort();
  ok('every branch carries Nouvelage or ZAT, nothing else',
    brands.length === 2 && brands.join('|') === 'Nouvelage|ZAT', brands.join('|'));
  ok('9 Nouvelage and 3 ZAT',
    TGT.branches.filter((b) => b.brand === 'Nouvelage').length === 9
    && TGT.branches.filter((b) => b.brand === 'ZAT').length === 3,
    JSON.stringify(brands.map((x) => [x, TGT.branches.filter((b) => b.brand === x).length])));
  ok('D.brand agrees with TGT.branches',
    TGT.branches.every((b) => D.brand[b.branch] === b.brand));
  ok('a spaced spelling still lands on the token',
    Bootstrap.brandToken('Nouvel Age') === 'Nouvelage'
    && Bootstrap.brandToken('NouvelAge') === 'Nouvelage'
    && Bootstrap.brandToken('zat') === 'ZAT');
  ok('an unknown entity is passed through, not invented',
    Bootstrap.brandToken('Something Else') === 'Something Else');

  console.log('\nThe shapes the script indexes positionally:');
  ok('D.TG[branch] is 12 months of 5 groups',
    Object.values(D.TG).every((b) => b.length === 12 && b.every((m) => m.length === 5)));
  ok('D.ddoc[date] entries are 5-tuples',
    Object.values(D.ddoc).every((rows) => rows.every((r) => Array.isArray(r) && r.length === 5)));
  ok('D.docs carry name, group, branches, mix and roster',
    D.docs.every((d) => 'name' in d && 'group' in d && Array.isArray(d.branches) && d.mix && d.roster));
  ok('D.rosterB[branch][dow] entries are 5-tuples',
    Object.values(D.rosterB).every((byDow) => Object.values(byDow)
      .every((rows) => rows.every((r) => Array.isArray(r) && r.length === 5))));
  ok('TGT rows carry branch/name, brand/group and m',
    TGT.branches.every((b) => b.branch && b.m) && TGT.doctors.every((d) => d.name && d.m));

  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exitCode = fails ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
