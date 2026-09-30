/* ============================================================
   The next month's target schedule, as a workbook to fill in.

   Every doctor on the current schedule, plus every doctor who is invoicing
   without one, each with what they have actually billed so far. The Monthly
   Target column is deliberately EMPTY: a template that arrives pre-filled gets
   re-uploaded unchanged, and last month's targets become this month's while
   looking like a decision was made.

   The column headings are not free choice. The importer at /admin guesses which
   column is which by matching the heading against four regexes, and marks every
   match selected — so in a single-select the LAST match wins. Each heading below
   matches exactly one of them, which is what makes the re-import need no manual
   mapping at all. `HEADERS` is exported so a test can pin that against the
   regexes as they actually appear in public/admin.js.

   In particular "Previous Month" cannot be used: it contains "month", so it
   matches the monthly-target guess, and it sits to the right of "Monthly
   Target", so it would win — mapping last month's figures in as next month's
   targets. For the same reason no month name may appear in any heading; the
   month goes in the worksheet name and the filename, where it belongs.
   ============================================================ */

const Sheet = require('./sheet.js');

/* report.js files invoices with no doctor under this name. It belongs in the
   report — 1.4 M with nobody attached is worth seeing — but not here: you cannot
   set next month's target for "no doctor", and a row inviting someone to try is
   worse than no row. */
const UNASSIGNED = 'Unassigned';

const HEADERS = ['Doctor', 'Group', 'Monthly Target', 'Previous', 'Invoiced to date', 'Invoices', 'Achieved %'];

const COLS = [
  { width: 32 }, { width: 20 }, { width: 16, money: true }, { width: 16, money: true },
  { width: 17, money: true }, { width: 11 }, { width: 12 },
];

/** "2026-08" -> "2026-09". */
function nextPeriod(period) {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Build the template.
 *
 *   nextMonthTemplate(sheet, scored) -> { buffer, filename, period, rows }
 *
 * `sheet` is loadPeriod()'s output — the authoritative roster, including anyone
 * held back with no sales. `scored` is score()'s, which supplies the actuals and
 * the off-schedule doctors.
 */
function nextMonthTemplate(sheet, scored) {
  const period = nextPeriod(sheet.period);

  // Actuals live on the scored rows; index them so the roster stays the driver.
  const actual = new Map();
  for (const g of scored.groups || []) {
    for (const r of g.rows) actual.set(r.name, r);
  }

  const rows = [HEADERS.slice()];
  const add = (name, group, previous, ex, invoices, pct) => rows.push([
    name,
    group || null,
    null, // Monthly Target — the one the user fills in
    previous == null ? null : round2(previous),
    ex ? round2(ex) : null,
    invoices || null,
    pct ? round2(pct) : null,
  ]);

  /* Group order follows the scored groups, so the workbook reads the same way
     the Targets tab does; anyone on the roster but not in a scored group (held
     back with no sales) still has to appear, or the template would quietly drop
     them from next month. */
  const written = new Set();
  for (const g of scored.groups || []) {
    for (const r of g.rows) {
      add(r.name, r.group || g.name, r.monthlyTarget, r.mtdEx, r.mtdInvoices, r.mtdPct);
      written.add(r.name);
    }
  }
  for (const d of sheet.doctors || []) {
    if (written.has(d.name)) continue;
    const r = actual.get(d.name);
    add(d.name, d.group, d.monthlyTarget, r && r.mtdEx, r && r.mtdInvoices, r && r.mtdPct);
    written.add(d.name);
  }

  /* The doctors this whole feature exists for: invoicing with no approved
     target. No group and no previous figure, because they have neither. */
  const offSheet = (scored.offSheet || [])
    .filter((d) => !written.has(d.name) && d.name !== UNASSIGNED);
  for (const d of offSheet) add(d.name, null, null, d.ex, d.invoices, null);

  const branchRows = [['Branch', 'Target 1', 'Target 2']];
  for (const b of sheet.branches || []) {
    branchRows.push([b.name, b.target1 == null ? null : round2(b.target1), b.target2 == null ? null : round2(b.target2)]);
  }

  const buffer = Sheet.write([
    // Targets must be first: read() with no worksheet named picks sheet one, and
    // that is what the importer does.
    { name: `Targets ${period}`, rows, cols: COLS },
    { name: 'Branches', rows: branchRows, cols: [{ width: 24 }, { width: 16, money: true }, { width: 16, money: true }] },
    { name: 'How to use', rows: howTo(sheet, period, offSheet.length), cols: [{ width: 100 }], header: false },
  ]);

  return { buffer, filename: `nouvelage-targets-${period}-template.xlsx`, period, rows };
}

function howTo(sheet, period, offSheetCount) {
  return [
    [`Target schedule for ${period}`],
    [''],
    [`Carried over from ${period === sheet.period ? sheet.period : sheet.period} (${sheet.sourceLabel || 'the published sheet'}).`],
    [''],
    ['1. Fill in the "Monthly Target" column on the Targets sheet. It is empty on purpose.'],
    ['2. "Previous" is what each doctor was targeted at last month, for reference only.'],
    ['3. "Invoiced to date", "Invoices" and "Achieved %" are last month\'s actuals. The'],
    ['   import ignores these three columns, so you can change or delete them freely.'],
    [''],
    offSheetCount
      ? [`${offSheetCount} doctor(s) at the bottom have no group and no previous target: they`]
      : ['Every doctor on the sheet already has a group.'],
    offSheetCount
      ? ['   are invoicing without an approved target. Give them a group and a target, or']
      : [''],
    offSheetCount ? ['   delete the row to leave them off the schedule.'] : [''],
    [''],
    ['4. Save as .xlsx and upload it at /admin, "Import Excel". Review it in the editor,'],
    ['   then Publish.'],
    [''],
    ['Do NOT insert a title row above the headings, and do not rename the four columns'],
    ['Doctor, Group, Monthly Target and Previous — the import finds them by name, and the'],
    ['first row of the sheet is read as the headings.'],
    [''],
    ['Branch targets are on the Branches sheet for reference. They are not imported from'],
    ['here; the ones already published carry forward automatically.'],
  ];
}

module.exports = { nextMonthTemplate, nextPeriod, HEADERS };
