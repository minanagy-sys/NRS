/* ============================================================
   Payables out as a workbook, in exactly the shape the importer reads back.

   Three worksheets, one per kind, with the headings `payables-import.js` detects
   — so the loop is export → edit in Excel → import, with no column mapping in
   between. The worksheet NAMES carry the kind, so the import knows what each
   sheet is without anyone having to say.

   Unlike the target template this one is NOT blanked. A payables sheet is edited,
   not filled from nothing: you export what is stored, correct the rows that are
   wrong, and import it back over the top.
   ============================================================ */

const Sheet = require('./sheet.js');
const { prisma, num, ymd } = require('./db.js');

/* These must stay in step with the guesses in payables-import.js. The round-trip
   test asserts that every one of them is detected, so a rename that breaks the
   loop fails the suite rather than the user. */
const HEADERS = {
  balances: ['Supplier', 'Category', 'Opening', 'Closing'],
  bills: ['Vendor', 'Bill number', 'Date', 'Gross inc-VAT', 'Net ex-VAT', 'VAT', 'Branch'],
  payments: ['Vendor', 'Date', 'Amount', 'Bank account', 'Memo', 'Method'],
};

const SHEETS = { balances: 'Balances', bills: 'Bills', payments: 'Payments' };

const n2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

/**
 * Build the workbook.
 *
 *   exportPayables({ source, from, to }) -> { buffer, filename, counts }
 *
 * `source` picks which rows to take — the imported snapshot by default, since
 * that is the set anyone would be correcting. Bills and payments are bounded by
 * a date range so an edit session is not handed nineteen months at once.
 */
async function exportPayables({ source = 'snapshot', from = null, to = null } = {}) {
  const dateWhere = from && to ? { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } } : {};

  const [suppliers, bills, payments] = await Promise.all([
    prisma.supplier.findMany({ where: { source }, orderBy: { name: 'asc' } }),
    prisma.bill.findMany({ where: { source, ...dateWhere }, orderBy: [{ date: 'asc' }, { ref: 'asc' }] }),
    prisma.vendorPayment.findMany({ where: { source, ...dateWhere }, orderBy: [{ date: 'asc' }, { supplierName: 'asc' }] }),
  ]);

  const balanceRows = [HEADERS.balances, ...suppliers.map((s) => [
    s.name, s.category || null, n2(s.opening), n2(s.closing),
  ])];

  const billRows = [HEADERS.bills, ...bills.map((b) => [
    b.supplierName, b.ref, ymd(b.date), n2(b.gross), n2(b.net), n2(b.vat), b.branch || null,
  ])];

  const paymentRows = [HEADERS.payments, ...payments.map((p) => [
    p.supplierName, ymd(p.date), n2(p.amount), p.journal, p.ref || null, p.method || null,
  ])];

  const money = { width: 16, money: true };
  const buffer = Sheet.write([
    { name: SHEETS.balances, rows: balanceRows, cols: [{ width: 34 }, { width: 16 }, money, money] },
    { name: SHEETS.bills, rows: billRows, cols: [{ width: 34 }, { width: 20 }, { width: 13 }, money, money, money, { width: 18 }] },
    { name: SHEETS.payments, rows: paymentRows, cols: [{ width: 34 }, { width: 13 }, money, { width: 30 }, { width: 24 }, { width: 16 }] },
    {
      name: 'How to use',
      header: false,
      cols: [{ width: 100 }],
      rows: [
        ['Payables — exported to edit and import back'],
        [''],
        [`Source: ${source === 'odoo' ? 'live from Odoo' : 'the imported snapshot'}`
          + (from && to ? ` · bills and payments from ${from} to ${to}` : ' · all dates')],
        [''],
        ['1. Edit the rows you need to correct, or add new ones at the bottom.'],
        ['2. Upload the file at /admin, Data sources, Payables, Import Excel.'],
        ['3. The import asks which worksheet to read. Each one imports separately,'],
        ['   so a full round trip is three imports: Balances, then Bills, then Payments.'],
        [''],
        ['Importing MERGES. A supplier already stored keeps its row and is updated;'],
        ['one that is not there is added. Nothing is ever deleted, so removing a row'],
        ['from this file does NOT remove it from the report.'],
        [''],
        ['Bills are matched on their bill number, payments on supplier + date + amount,'],
        ['so importing the same file twice does not double anything.'],
        [''],
        ['Do not rename the column headings or insert a row above them — the import'],
        ['finds the columns by name and reads the first row as the headings.'],
        [''],
        ['Opening and closing balances are ledger figures. They are NOT recalculated'],
        ['from the bills and payments, so correcting a bill will not move a balance —'],
        ['edit the Balances sheet for that.'],
      ],
    },
  ]);

  const stamp = to || ymd(new Date());
  return {
    buffer,
    filename: `nouvelage-payables-${stamp}.xlsx`,
    counts: { suppliers: suppliers.length, bills: bills.length, payments: payments.length },
  };
}

module.exports = { exportPayables, HEADERS, SHEETS };
