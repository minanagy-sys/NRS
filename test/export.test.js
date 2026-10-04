/**
 * The export → fill in → re-import loop.
 *
 * The whole point of the template is that a month's targets can be set once and
 * published without anyone retyping 77 names, so the tests here follow the file
 * all the way round: build it, read it back the way the importer does, map the
 * columns the way the browser does, build the draft, and hand the result to the
 * very validator the publish route runs.
 *
 *   node test/export.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Sheet = require('../src/lib/sheet.js');
const Export = require('../src/lib/export-targets.js');
const Draft = require('../public/draft.js');
const { validate } = require('../src/routes/admin.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

/* ---- a sheet and a scoring shaped like the real ones ---- */

const SHEET = {
  period: '2026-08',
  daysInPeriod: 31,
  sourceLabel: 'Approved Target Schedule — August 2026',
  doctors: [
    { name: 'Dr. Mai mohsen', group: 'Injectables', monthlyTarget: 3250000, prevMonth: 2738549, hasSales: true },
    { name: 'Dr. Poussy Maher', group: 'Injectables', monthlyTarget: 2500000, prevMonth: 2151209, hasSales: true },
    { name: 'Mayada Khaled', group: 'Therapist', monthlyTarget: 2211, prevMonth: 2211, hasSales: true },
  ],
  branches: [
    { name: 'Alex Camp Chizar', target1: 4753125, target2: 9468700 },
    { name: 'Loran', target1: 658125, target2: 1311051 },
  ],
  groups: {},
  aliases: { doctors: {}, branches: {} },
};

const SCORED = {
  groups: [
    {
      name: 'Injectables',
      target: 5750000,
      rows: [
        { name: 'Dr. Mai mohsen', group: 'Injectables', monthlyTarget: 3250000, mtdEx: 1927973.23, mtdInvoices: 109, mtdPct: 59.32 },
        { name: 'Dr. Poussy Maher', group: 'Injectables', monthlyTarget: 2500000, mtdEx: 830000, mtdInvoices: 40, mtdPct: 33.2 },
      ],
    },
    {
      name: 'Therapist',
      target: 2211,
      rows: [{ name: 'Mayada Khaled', group: 'Therapist', monthlyTarget: 2211, mtdEx: 0, mtdInvoices: 0, mtdPct: 0 }],
    },
  ],
  // Invoicing with no approved target — plus the no-doctor bucket, which must
  // NOT reach the template: you cannot set next month's target for "no doctor".
  offSheet: [
    { name: 'Unassigned', ex: 1449597.1, inc: 1500000, invoices: 205, branches: ['Loran'] },
    { name: 'DR. Shimaa Zeinelden', ex: 5585.61, inc: 5800, invoices: 2, branches: ['Loran'] },
    { name: 'Therapist. Mariam', ex: 14796.85, inc: 15000, invoices: 8, branches: ['CFC'] },
  ],
};

const built = Export.nextMonthTemplate(SHEET, SCORED);

/* ---- the file itself ---- */

check('the month rolls forward', () => {
  assert.strictEqual(Export.nextPeriod('2026-08'), '2026-09');
  assert.strictEqual(Export.nextPeriod('2026-12'), '2027-01', 'December must roll the year');
  assert.strictEqual(built.filename, 'nouvelage-targets-2026-09-template.xlsx');
});

const wb = Sheet.read(built.buffer);

check('the Targets sheet is first, so the importer defaults to it', () => {
  assert.deepStrictEqual(wb.sheets, ['Targets 2026-09', 'Branches', 'How to use']);
  assert.strictEqual(wb.sheet, 'Targets 2026-09');
});

check('the headings are the ones the importer looks for', () =>
  assert.deepStrictEqual(wb.columns, Export.HEADERS));

check('every doctor is carried, and the no-doctor bucket is not', () => {
  const names = wb.rows.map((r) => r.Doctor);
  assert.deepStrictEqual(names, [
    'Dr. Mai mohsen', 'Dr. Poussy Maher', 'Mayada Khaled',
    'DR. Shimaa Zeinelden', 'Therapist. Mariam',
  ]);
  assert.ok(!names.includes('Unassigned'), '"Unassigned" is not a person and cannot hold a target');
});

check('every Monthly Target is blank — that is the point of a template', () =>
  assert.ok(wb.rows.every((r) => r['Monthly Target'] === null),
    `filled: ${JSON.stringify(wb.rows.filter((r) => r['Monthly Target'] !== null))}`));

check('last month travels in Previous, not in the target column', () => {
  assert.strictEqual(wb.rows[0].Previous, 3250000);
  assert.strictEqual(wb.rows[0]['Invoiced to date'], 1927973.23);
  assert.strictEqual(wb.rows[0].Invoices, 109);
});

check('doctors with no target arrive with no group and no previous', () => {
  const row = wb.rows.find((r) => r.Doctor === 'DR. Shimaa Zeinelden');
  assert.strictEqual(row.Group, null);
  assert.strictEqual(row.Previous, null);
  assert.strictEqual(row['Invoiced to date'], 5585.61, 'what they have billed still shows');
});

check('branch targets ride along for reference', () => {
  const b = Sheet.read(built.buffer, 'Branches');
  assert.deepStrictEqual(b.columns, ['Branch', 'Target 1', 'Target 2']);
  assert.strictEqual(b.rows.length, 2);
  assert.strictEqual(b.rows[0]['Target 1'], 4753125);
});

/* ---- the pin that stops the round trip breaking silently ---- */

check('each heading is matched by exactly one of the importer\'s guesses', () => {
  /* Read the regexes out of the importer rather than restating them, so that
     loosening a guess fails here instead of quietly re-mapping a column.
     renderMapping marks EVERY match selected and a single-select keeps the
     last, so "matches exactly one" is the only safe property. */
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const guesses = Object.fromEntries(
    [...admin.matchAll(/pick\('c(\w+)',\s*'[^']*',\s*'([^']*)'\)/g)].map((m) => [m[1], m[2]]));
  assert.strictEqual(Object.keys(guesses).length, 4,
    `expected four column guesses in public/admin.js, found ${JSON.stringify(Object.keys(guesses))}`);

  for (const [role, want] of [['Name', 'Doctor'], ['Group', 'Group'], ['Target', 'Monthly Target'], ['Prev', 'Previous']]) {
    const re = new RegExp(guesses[role], 'i');
    const hits = Export.HEADERS.filter((h) => re.test(h));
    assert.deepStrictEqual(hits, [want],
      `/${guesses[role]}/i matches ${JSON.stringify(hits)} — it must match only "${want}"`);
  }
});

/* ---- the Import button resolves the columns with no mapping screen ---- */

check('our own headings resolve exactly, with nothing guessed', () => {
  const c = Draft.resolveColumns(wb.columns);
  assert.strictEqual(c.name, 'Doctor');
  assert.strictEqual(c.group, 'Group');
  assert.strictEqual(c.target, 'Monthly Target');
  assert.strictEqual(c.prev, 'Previous');
  assert.deepStrictEqual(c.guessed, [], 'an exported sheet needs no guessing at all');
});

check('a hand-made sheet does not hand last month\'s column to the target', () => {
  /* Both headings contain "target", and the admin screen's last-match-wins would
     pick "July Target" as the monthly target — publishing last month's numbers.
     Claiming each column once, least-ambiguous role first, is what prevents it. */
  const c = Draft.resolveColumns(['Doctor', 'Group', 'August Target', 'July Target']);
  assert.strictEqual(c.target, 'August Target');
  assert.strictEqual(c.prev, 'July Target');
  // Doctor and Group are exact hits; only the two target columns were guessed.
  assert.deepStrictEqual(c.guessed.sort(), ['prev', 'target']);
});

check('a sheet with no target column is refused, not guessed at', () => {
  const c = Draft.resolveColumns(['Reference', 'Notes']);
  assert.strictEqual(c.name, null);
  assert.strictEqual(c.target, null);
});

check('the period comes off the worksheet name or the filename', () => {
  assert.strictEqual(Draft.periodFrom('Targets 2026-09'), '2026-09');
  assert.strictEqual(Draft.periodFrom('nouvelage-targets-2026-09-template.xlsx'), '2026-09');
  assert.strictEqual(Draft.periodFrom('Targets 2026-13'), null, 'month 13 is not a month');
  assert.strictEqual(Draft.periodFrom('Sheet1'), null);
});

check('Import reads back exactly what Export wrote, end to end', () => {
  // What the button does: resolve, build, and check nothing was lost.
  const c = Draft.resolveColumns(wb.columns);
  const d = Draft.build(wb.rows, c);
  assert.strictEqual(d.doctors.length, wb.rows.length);
  assert.strictEqual(Draft.periodFrom(wb.sheet), '2026-09');
});

/* ---- fill it in and import it ---- */

const COLS = { name: 'Doctor', group: 'Group', target: 'Monthly Target', prev: 'Previous' };

check('an untouched template imports as every doctor, all needing a target', () => {
  const d = Draft.build(wb.rows, COLS);
  assert.strictEqual(d.doctors.length, 5, 'the old filter dropped all of these');
  assert.strictEqual(d.blanks, 5);
  assert.ok(d.doctors.every((x) => x.needsTarget && x.monthlyTarget === 0));
  assert.strictEqual(d.doctors[0].prevMonth, 3250000);
});

check('blank, zero and unreadable are three different things', () => {
  const d = Draft.build([
    { Doctor: 'Blank', Group: 'G', 'Monthly Target': null },
    { Doctor: 'Zero', Group: 'G', 'Monthly Target': 0 },
    { Doctor: 'Typo', Group: 'G', 'Monthly Target': '3,25o,000' },
    { Doctor: 'Commas', Group: 'G', 'Monthly Target': '1,250,000' },
    { Doctor: '  ', Group: 'G', 'Monthly Target': 5 },
  ], COLS);

  assert.deepStrictEqual(d.doctors.map((x) => x.name), ['Blank', 'Zero', 'Typo', 'Commas'],
    'a nameless row is the only one dropped');
  assert.strictEqual(d.doctors[0].needsTarget, true, 'blank still needs a decision');
  assert.strictEqual(d.doctors[1].needsTarget, false, 'a deliberate 0 IS a decision');
  assert.strictEqual(d.doctors[1].monthlyTarget, 0);
  assert.deepStrictEqual(d.unreadable, [{ name: 'Typo', value: '3,25o,000' }],
    'a typo must be named, never silently read as zero');
  assert.strictEqual(d.doctors[3].monthlyTarget, 1250000, 'thousands separators survive');
});

check('a filled-in template publishes — the validator finds nothing wrong', () => {
  const filled = wb.rows.map((r, i) => ({ ...r, Group: r.Group || 'Laser-led', 'Monthly Target': (i + 1) * 100000 }));
  const d = Draft.build(filled, COLS);
  const body = {
    daysInPeriod: 30,
    sourceLabel: 'Imported from Targets 2026-09',
    groups: d.groups,
    doctors: d.doctors,
    branches: SHEET.branches,
  };
  assert.deepStrictEqual(validate(body), [], 'the publish route would reject this sheet');
  assert.strictEqual(d.blanks, 0);
  // Group targets are derived, so they must equal their doctors exactly.
  const total = Object.values(d.groups).reduce((s, g) => s + g.target, 0);
  assert.strictEqual(total, d.doctors.reduce((s, x) => s + x.monthlyTarget, 0));
});

/* ---- the journey as it actually happens: Excel re-saves the file ---- */

check('a template Excel has opened and saved still imports correctly', () => {
  /* Excel materialises styled-but-empty cells as `<c r="C2" s="2"/>`. Before the
     alternation in sheetRows() was fixed, that swallowed the following cell and
     put Previous into Monthly Target — publishing last month's numbers as next
     month's, invisibly. This rebuilds the file the way Excel would and walks the
     whole chain over it. */
  const rows = [
    Export.HEADERS,
    ['Dr. Mai mohsen', 'Injectables', null, 3250000],
    ['Dr. Poussy Maher', 'Injectables', 2750000, 2500000],
  ];
  const cells = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const ref = String.fromCharCode(65 + c) + (r + 1);
    if (v === null || v === undefined) return `<c r="${ref}" s="2"/>`;      // <- Excel's blank
    if (typeof v === 'number') return `<c r="${ref}" s="2"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  }).join('')}</row>`).join('');

  const resaved = Sheet.zipOf({
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="Targets 2026-09" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${cells}</sheetData></worksheet>`,
  });

  const back = Sheet.read(resaved);
  assert.deepStrictEqual(back.columns, Export.HEADERS);
  assert.strictEqual(back.rows[0]['Monthly Target'], null, 'the blank stayed blank');
  assert.strictEqual(back.rows[0].Previous, 3250000, 'and did not swallow the next cell');
  assert.strictEqual(back.rows[1]['Monthly Target'], 2750000, 'the filled-in figure survives');

  const d = Draft.build(back.rows, COLS);
  assert.strictEqual(d.doctors.length, 2);
  assert.strictEqual(d.doctors[0].needsTarget, true);
  assert.strictEqual(d.doctors[1].monthlyTarget, 2750000);
});

/* ---- the other way round the loop: no Excel at all ----

   The Admin screen can now start next month from a published sheet directly,
   which is the same job the workbook does. So the same things have to hold, and
   the two roll-forwards have to agree about what next month is called. */

console.log('\ncarrying a month forward in the Admin editor');

check('the client and the workbook agree about what next month is', () => {
  /* Two copies of the roll-forward exist because one runs in a browser before
     any file exists. If they ever disagree, a template named 2026-09 would be
     imported over a sheet the screen called something else. */
  for (const p of ['2026-01', '2026-07', '2026-08', '2026-11', '2026-12', '2027-12']) {
    assert.strictEqual(Draft.nextPeriod(p), Export.nextPeriod(p), p);
  }
  assert.strictEqual(Draft.nextPeriod('2026-12'), '2027-01', 'December must roll the year');
  assert.strictEqual(Draft.nextPeriod('2026-13'), null, 'a month that does not exist is not a month');
  assert.strictEqual(Draft.nextPeriod('nonsense'), null);
});

check('days in the period are right where it matters', () => {
  assert.strictEqual(Draft.daysInPeriod('2026-09'), 30);
  assert.strictEqual(Draft.daysInPeriod('2026-02'), 28);
  assert.strictEqual(Draft.daysInPeriod('2028-02'), 29, 'a leap February');
  assert.strictEqual(Draft.daysInPeriod('2026-12'), 31);
});

const carried = Draft.carryForward(SHEET);

check('the roster, the groups and the branches all come across', () => {
  assert.strictEqual(carried.period, '2026-09');
  assert.strictEqual(carried.daysInPeriod, 30);
  assert.strictEqual(carried.doctors.length, SHEET.doctors.length);
  assert.deepStrictEqual(carried.doctors.map((d) => d.name), SHEET.doctors.map((d) => d.name));
  assert.deepStrictEqual(carried.doctors.map((d) => d.group), SHEET.doctors.map((d) => d.group));
  assert.strictEqual(carried.branches.length, SHEET.branches.length);
  assert.strictEqual(carried.branches[0].target1, 4753125, 'branch figures are not blanked');
});

check('NOT ONE TARGET comes across — the same rule the workbook states', () => {
  /* This is the whole point. A month that arrives pre-filled gets published
     unchanged, and last month becomes this month while looking like a decision
     was made. The old figure goes to `prevMonth`, where it is reference. */
  assert.ok(carried.doctors.every((d) => d.monthlyTarget === 0), 'a target was carried');
  assert.ok(carried.doctors.every((d) => d.needsTarget === true), 'a row was not flagged as blank');
  assert.deepStrictEqual(carried.doctors.map((d) => d.prevMonth), SHEET.doctors.map((d) => d.monthlyTarget));
  assert.ok(Object.values(carried.groups).every((g) => g.target === 0), 'a group total was carried');
});

check('a carried sheet reconciles at zero, so the ledger cannot imply it is done', () => {
  /* It balances — 0 = 0 — which is exactly why `needsTarget` has to exist. The
     editor shows the count; reconciliation is structurally unable to. */
  assert.deepStrictEqual(validate({ groups: carried.groups, doctors: carried.doctors }), []);
  assert.strictEqual(carried.doctors.filter((d) => d.needsTarget).length, carried.doctors.length);
});

check('filling it in and balancing gives a sheet the publish route accepts', () => {
  const draft = JSON.parse(JSON.stringify(carried));
  draft.doctors.forEach((d, i) => { d.monthlyTarget = (i + 1) * 100000; d.needsTarget = false; });
  // Before balancing, every group total is still 0 and the sheet must NOT pass.
  assert.ok(validate({ groups: draft.groups, doctors: draft.doctors }).length,
    'a sheet with typed doctors and zero group totals was accepted');

  const { changed } = Draft.balanceGroups(draft);
  assert.ok(changed.length, 'nothing was reported as changed');
  assert.deepStrictEqual(validate({ groups: draft.groups, doctors: draft.doctors }), []);
  assert.strictEqual(draft.groups.Injectables.target, 100000 + 200000);
  assert.strictEqual(draft.groups.Injectables.rosterCount, 2, 'head count has to be balanced too');
});

check('balancing counts the value held for roster members with no sales', () => {
  /* The invariant is doctors + unlistedTarget = group target, and unlisted is
     real money for people held on the roster. Dropping it would balance the
     panel and publish a group short by whatever they were holding. */
  const draft = {
    doctors: [{ name: 'A', group: 'G', monthlyTarget: 500000, hasSales: true }],
    groups: { G: { target: 0, rosterCount: 0, unlistedCount: 2, unlistedTarget: 300000 } },
  };
  Draft.balanceGroups(draft);
  assert.strictEqual(draft.groups.G.target, 800000);
  assert.strictEqual(draft.groups.G.rosterCount, 3, '1 listed + 2 unlisted');
  assert.deepStrictEqual(validate(draft), []);
});

check('balancing an already-correct sheet reports no change and alters nothing', () => {
  const draft = {
    doctors: [{ name: 'A', group: 'G', monthlyTarget: 500000, hasSales: true }],
    groups: { G: { target: 500000, rosterCount: 1, unlistedCount: 0, unlistedTarget: 0 } },
  };
  const { changed } = Draft.balanceGroups(draft);
  assert.deepStrictEqual(changed, []);
  assert.strictEqual(draft.groups.G.target, 500000);
});

check('a doctor whose group was never listed gets one, rather than failing to publish', () => {
  /* The publish validator refuses "assigned to X, which has no group entry".
     Carrying a sheet must not be the thing that introduces that. */
  const odd = { ...SHEET, groups: {}, doctors: [{ name: 'Dr. New', group: 'Aesthetics', monthlyTarget: 10, hasSales: true }] };
  const c = Draft.carryForward(odd);
  assert.ok(c.groups.Aesthetics, 'the group was not created');
  assert.deepStrictEqual(validate({ groups: c.groups, doctors: c.doctors }), []);
});

/* A sheet that publishes cleanly, for the comparisons below. */
const SHEET_OK = (() => {
  const d = Draft.carryForward(SHEET);
  d.doctors.forEach((x, i) => { x.monthlyTarget = (i + 1) * 1000; x.needsTarget = false; });
  Draft.balanceGroups(d);
  return { groups: d.groups, doctors: d.doctors };
})();

/* ---- the editor's ledger and the publish route are one function ---- */

console.log('\nthe ledger says what the server would say');

check('the route validator IS Draft.problems, not a second copy of it', () => {
  /* If this ever stops holding, the editor can show a balanced ledger for a
     sheet the server refuses — which is what it did. */
  assert.deepStrictEqual(validate(SHEET_OK), Draft.problems(SHEET_OK));
  const broken = { groups: { G: { target: 999, rosterCount: 1 } }, doctors: [{ name: 'A', group: 'G', monthlyTarget: 1 }] };
  assert.deepStrictEqual(validate(broken), Draft.problems(broken));
  assert.ok(validate(broken).length, 'a broken sheet produced no problems');
});

check('a "no sales" doctor with a target no longer reads as balanced', () => {
  /* THE DORMANT DIVERGENCE. The editor skipped these rows when summing a group;
     the server never has. Nobody on the August sheet is marked that way, so the
     two agreed by luck rather than by rule. */
  const draft = {
    groups: { G: { target: 500000, rosterCount: 2, unlistedCount: 0, unlistedTarget: 0 } },
    doctors: [
      { name: 'A', group: 'G', monthlyTarget: 500000, hasSales: true },
      { name: 'B', group: 'G', monthlyTarget: 250000, hasSales: false },
    ],
  };
  const led = Draft.ledger(draft);
  assert.strictEqual(led.ok, false, 'the ledger called it balanced');
  assert.strictEqual(led.lines[0].listed, 750000, 'the no-sales row was skipped again');
  assert.ok(validate(draft).length, 'the server would have accepted it?');
  assert.strictEqual(led.problems.length, validate(draft).length);
});

check('a head-count mismatch disables Publish, and says why', () => {
  /* Remove one doctor from a carried sheet and rosterCount stops matching. The
     group sums still balance, so the old ledger stayed green — and the click
     failed. */
  const draft = Draft.carryForward(SHEET);
  draft.doctors.forEach((d) => { d.monthlyTarget = 1000; d.needsTarget = false; });
  Draft.balanceGroups(draft);
  assert.strictEqual(Draft.ledger(draft).ok, true, 'a balanced carried sheet should publish');

  draft.doctors.pop();                       // somebody has left
  const led = Draft.ledger(draft);
  assert.strictEqual(led.ok, false, 'a stale roster count read as balanced');
  assert.ok(led.problems.some((x) => /people accounted for/.test(x)), led.problems.join(' | '));
  assert.ok(led.lines.some((l) => l.roster && l.people !== l.roster), 'no line shows the gap');

  Draft.balanceGroups(draft);                // Balance fixes the count too
  assert.strictEqual(Draft.ledger(draft).ok, true, 'Balance groups did not settle the head count');
});

check('a nameless row is refused by the ledger, not only by the server', () => {
  const draft = {
    groups: { G: { target: 100, rosterCount: 2, unlistedCount: 0, unlistedTarget: 0 } },
    doctors: [{ name: 'A', group: 'G', monthlyTarget: 100 }, { name: '', group: 'G', monthlyTarget: 0 }],
  };
  const led = Draft.ledger(draft);
  assert.strictEqual(led.ok, false);
  assert.ok(led.problems.some((x) => /no name/.test(x)), led.problems.join(' | '));
});

check('an empty sheet is refused by the EDITOR, though the validator allows it', () => {
  /* "No groups and no doctors" is not self-contradictory, so `problems` finds
     nothing wrong with it — but publishing it would replace a month with
     nothing, which is why `ok` needs the second limb. */
  assert.deepStrictEqual(Draft.problems({ groups: {}, doctors: [] }), []);
  assert.strictEqual(Draft.ledger({ groups: {}, doctors: [] }).ok, false);
});

console.log(failures ? `\n${failures} failed\n` : '\n✓ a target sheet survives export, Excel and re-import\n');
process.exit(failures ? 1 : 0);
