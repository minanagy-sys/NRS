/**
 * The uploaded-file parser. It replaced `xlsx`, whose npm release carries two
 * unfixable high-severity advisories, so it has to handle real workbooks and
 * refuse malformed ones without taking the process down.
 *
 *   node test/sheet.test.js
 */

const assert = require('assert');
const Sheet = require('../src/lib/sheet.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

/* Build a real .xlsx through the shipping writer, so these tests exercise the
   code that actually produces the export rather than a lookalike beside it.
   `zipOf` comes from the same module and is used below to assemble deliberately
   broken archives the writer would never emit. */
const { zipOf } = Sheet;
const makeXlsx = (sheetName, grid, { shared = true } = {}) =>
  Sheet.write([{ name: sheetName, rows: grid, header: false }], { shared });

const zipNames = (buf) => [...Sheet.unzip(buf).keys()];
const zipEntry = (buf, name) => (Sheet.unzip(buf).get(name) || Buffer.alloc(0)).toString('utf8');

/* ---- a realistic target schedule ---- */

const GRID = [
  ['Doctor', 'Group', 'August Target', 'July Actual'],
  ['Dr. Mai mohsen', 'Injectables', 3250000, 2738549],
  ['Dr. Poussy Maher', 'Injectables', 2500000, 2151209],
  ['Dr Dina Ghoneim', 'Laser-led', 500000, null],
];

const wb = Sheet.read(makeXlsx('Targets', GRID));
check('reads an .xlsx', () => {
  assert.deepStrictEqual(wb.sheets, ['Targets']);
  assert.strictEqual(wb.sheet, 'Targets');
  assert.strictEqual(wb.rowCount, 3);
});
check('header row becomes the columns', () =>
  assert.deepStrictEqual(wb.columns, ['Doctor', 'Group', 'August Target', 'July Actual']));
check('numbers stay numbers', () => {
  assert.strictEqual(wb.rows[0]['August Target'], 3250000);
  assert.strictEqual(typeof wb.rows[0]['August Target'], 'number');
});
check('shared strings resolve', () => assert.strictEqual(wb.rows[1].Doctor, 'Dr. Poussy Maher'));
check('empty cells are null, not undefined', () => assert.strictEqual(wb.rows[2]['July Actual'], null));

check('inline strings work too', () => {
  const inline = Sheet.read(makeXlsx('S', GRID, { shared: false }));
  assert.strictEqual(inline.rows[0].Doctor, 'Dr. Mai mohsen');
});

check('special characters survive the round trip exactly', () => {
  // The builder escapes these on the way in; the parser must return the original.
  const g = [['Name'], ['A & B'], ['5 < 6'], ['Dr. O\u2019Brien'], ['&amp; literally']];
  const out = Sheet.read(makeXlsx('S', g));
  assert.strictEqual(out.rows[0].Name, 'A & B');
  assert.strictEqual(out.rows[1].Name, '5 < 6');
  assert.strictEqual(out.rows[2].Name, 'Dr. O\u2019Brien');
  // Decoding must not run twice, or this becomes "& literally".
  assert.strictEqual(out.rows[3].Name, '&amp; literally');
});

check('duplicate headers do not overwrite each other', () => {
  const out = Sheet.read(makeXlsx('S', [['Target', 'Target'], [1, 2]]));
  assert.deepStrictEqual(out.columns, ['Target', 'Target (2)']);
  assert.strictEqual(out.rows[0].Target, 1);
  assert.strictEqual(out.rows[0]['Target (2)'], 2);
});

check('rows carry no prototype, so a header cannot pollute Object.prototype', () => {
  const out = Sheet.read(makeXlsx('S', [['__proto__', 'constructor'], ['x', 'y']]));
  assert.strictEqual(Object.getPrototypeOf(out.rows[0]), null);
  assert.strictEqual({}.x, undefined, 'Object.prototype was touched');
});

check('gaps in the middle of a row keep their column', () => {
  const out = Sheet.read(makeXlsx('S', [['A', 'B', 'C'], ['a', null, 'c']]));
  assert.strictEqual(out.rows[0].A, 'a');
  assert.strictEqual(out.rows[0].B, null);
  assert.strictEqual(out.rows[0].C, 'c');
});

/* ---- CSV ---- */

check('reads CSV', () => {
  const csv = Sheet.read(Buffer.from('Doctor,Target\nDr. Mai mohsen,3250000\n', 'utf8'));
  assert.strictEqual(csv.rows[0].Doctor, 'Dr. Mai mohsen');
  assert.strictEqual(csv.rows[0].Target, 3250000);
});
check('CSV quoting, doubled quotes and commas in numbers', () => {
  const csv = Sheet.read(Buffer.from('Name,Target\n"Smith, John",\"3,250,000\"\n"He said ""hi""",1\n', 'utf8'));
  assert.strictEqual(csv.rows[0].Name, 'Smith, John');
  assert.strictEqual(csv.rows[0].Target, 3250000);
  assert.strictEqual(csv.rows[1].Name, 'He said "hi"');
});

/* ---- what Excel hands back, and what we hand it ---- */

check('a self-closing empty cell does not swallow the next one', () => {
  /* Excel writes a styled-but-empty cell as `<c r="C2" s="2"/>`, and a fill-in
     template is nothing but styled empty cells. With the alternation the other
     way round, `[^>]*` ate the slash and the lazy body ran to the NEXT `</c>`,
     reporting the following cell's value under this one's column — silently
     promoting last month's figure to next month's target. Do not "simplify"
     the regex in sheetRows() back. */
  const row = `<row r="1"><c r="A1" t="inlineStr"><is><t>Doctor</t></is></c><c r="B1" t="inlineStr"><is><t>Target</t></is></c><c r="C1" t="inlineStr"><is><t>Previous</t></is></c></row>`
    + `<row r="2"><c r="A2" t="inlineStr"><is><t>Dr. Mai</t></is></c><c r="B2" s="2"/><c r="C2"><v>3250000</v></c></row>`;
  const buf = zipOf({
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${row}</sheetData></worksheet>`,
  });
  const out = Sheet.read(buf);
  assert.strictEqual(out.rows[0].Target, null, 'the empty cell must stay empty');
  assert.strictEqual(out.rows[0].Previous, 3250000, 'and must not eat the cell after it');
});

check('the writer never emits a self-closing cell of its own', () => {
  const xml = zipEntry(Sheet.write([{ name: 'S', rows: [['A', 'B'], ['x', null]] }]), 'xl/worksheets/sheet1.xml');
  assert.ok(!/<c[^>]*\/>/.test(xml), `writer emitted a self-closing cell: ${xml}`);
  // The blank at B2 must be absent, not written empty. (A1:B2 still appears in
  // the dimension ref, so look for the cell specifically.)
  assert.ok(!/<c r="B2"/.test(xml), 'a blank must be left out entirely');
  assert.ok(/<c r="A2"/.test(xml), 'but the cell beside it must still be there');
});

check('a trailing space survives, because Odoo has names that end in one', () => {
  const out = Sheet.read(Sheet.write([{ name: 'S', rows: [['Doctor'], ['Dr. Azza Awad ']], header: false }]));
  assert.strictEqual(out.rows[0].Doctor, 'Dr. Azza Awad ');
});

check('control characters are stripped rather than made unopenable', () => {
  const out = Sheet.read(Sheet.write([{ name: 'S', rows: [['Doctor'], ['Bad\u0000Name\u0007']], header: false }]));
  assert.strictEqual(out.rows[0].Doctor, 'BadName');
});

check('worksheet order is preserved and sheet one is the default', () => {
  const buf = Sheet.write([
    { name: 'Targets 2026-09', rows: [['Doctor'], ['A']], header: false },
    { name: 'Branches', rows: [['Branch'], ['Loran']], header: false },
  ]);
  assert.deepStrictEqual(Sheet.read(buf).sheets, ['Targets 2026-09', 'Branches']);
  assert.strictEqual(Sheet.read(buf).columns[0], 'Doctor', 'no name given means sheet one');
  assert.strictEqual(Sheet.read(buf, 'Branches').columns[0], 'Branch');
});

check('sheet names Excel would reject are made safe and kept unique', () => {
  const buf = Sheet.write([
    { name: 'Targets: 2026/09 [draft] with a very long tail indeed', rows: [['A']], header: false },
    { name: 'Targets: 2026/09 [draft] with a very long tail indeed', rows: [['B']], header: false },
  ]);
  const [one, two] = Sheet.read(buf).sheets;
  assert.ok(!/[[\]:*?/\\]/.test(one), `illegal character left in "${one}"`);
  assert.ok(one.length <= 31 && two.length <= 31, 'Excel truncates past 31 characters');
  assert.notStrictEqual(one, two, 'two sheets may not share a name');
});

check('the package has the parts Excel needs, and each is declared', () => {
  /* Our own reader is happy without these; Excel offers to "repair" the file.
     This is the closest a test can get to opening it. */
  const buf = Sheet.write([{ name: 'S', rows: [['A'], [1]] }]);
  const names = zipNames(buf);
  assert.deepStrictEqual(names.sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);

  for (const rels of ['_rels/.rels', 'xl/_rels/workbook.xml.rels']) {
    for (const tag of zipEntry(buf, rels).match(/<Relationship [^>]*>/g) || []) {
      assert.ok(/Type="http/.test(tag), `${rels}: relationship with no Type — ${tag}`);
    }
  }
  assert.ok(/relationships\/officeDocument/.test(zipEntry(buf, '_rels/.rels')),
    'the package must point at the workbook');

  const types = zipEntry(buf, '[Content_Types].xml');
  for (const m of types.matchAll(/PartName="\/([^"]+)"/g)) {
    assert.ok(names.includes(m[1]), `[Content_Types].xml declares ${m[1]}, which is not in the file`);
  }
  for (const n of names) {
    if (n.endsWith('.rels') || n === '[Content_Types].xml') continue;
    assert.ok(types.includes(`PartName="/${n}"`), `${n} is in the file but undeclared`);
  }

  const styles = zipEntry(buf, 'xl/styles.xml');
  assert.ok(/<fills count="2">/.test(styles), 'both reserved fills are required');
  assert.ok(!/theme=/.test(styles), 'no theme part ships, so nothing may reference one');
});

/* ---- malformed input must fail cleanly, never hang or crash ---- */

for (const [label, input] of [
  ['empty file', Buffer.alloc(0)],
  ['random bytes claiming to be a zip', Buffer.concat([Buffer.from('PK'), Buffer.alloc(200, 7)])],
  ['zip with no workbook', zipOf({ 'hello.txt': 'nothing here' })],
  ['truncated zip', makeXlsx('S', GRID).subarray(0, 80)],
]) {
  check(`${label} is refused, not fatal`, () => {
    assert.throws(() => Sheet.read(input), /./);
  });
}

check('an oversized file is refused before parsing', () => {
  assert.throws(() => Sheet.read(Buffer.alloc(13 * 1024 * 1024)), /too large/);
});

check('a pathological cell does not hang the parser', () => {
  // The ReDoS advisory against xlsx was exactly this shape.
  const nasty = 'a'.repeat(200000) + '<'.repeat(5000);
  const started = Date.now();
  Sheet.read(makeXlsx('S', [['Name'], [nasty]]));
  const ms = Date.now() - started;
  assert.ok(ms < 3000, `took ${ms}ms`);
});

console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ the parser handles real workbooks and refuses bad input');
process.exit(failures ? 1 : 0);
