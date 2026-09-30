/* ============================================================
   Importing payables from a spreadsheet.

   Three kinds of sheet, because a payables workbook is one of three things and
   guessing which would be worse than asking:

     balances  one row per supplier — opening and closing, the figures that
               cannot be derived from anything else
     bills     one row per vendor bill
     payments  one row per payment out

   Everything MERGES. A supplier already imported keeps its row and gets updated;
   a bill already imported is matched on its reference and replaced. Nothing is
   deleted, because the data already loaded took real work to assemble and an
   import is meant to add to it, not start over.

   Writes land as `source = 'snapshot'` — this is imported data, the same kind the
   HTML extract produced, and the section's mode already knows what to do with it.
   ============================================================ */

const Sheet = require('./sheet.js');
const { prisma, dateOnly, ymd } = require('./db.js');
const F = require('./finance-rules.js');

const SOURCE = 'snapshot';

/* Decimal columns must be matched with a string, never a JS number.
   `882476.56` is really `882476.55999999996` as a double, so
   `deleteMany({ amount: 882476.56 })` matched nothing and the row was written a
   second time — 11 payments duplicated on the first export/import round trip,
   every one of them with a fractional amount. */
const dec = (n) => Number(n).toFixed(2);
const KINDS = ['balances', 'bills', 'payments'];

/** A number from a cell: strips separators, currency marks and stray spaces. */
function money(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[,\s]/g, '').replace(/^EGP/i, '').replace(/[()]/g, (m) => (m === '(' ? '-' : ''));
  if (!t || t === '-' || t === '—') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A date from a cell. Accepts ISO, `YYYY-MM-DD HH:MM:SS`, and Excel serials. */
function asDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    // Excel's epoch is 1899-12-30; anything below 20000 is not a plausible date.
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  }
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
}

/* Column guesses per kind. The first pattern that hits an unclaimed column wins,
   and a column is never claimed twice — the same rule the target importer learned
   the hard way when "August Target" and "July Target" both matched "target". */
const GUESSES = {
  balances: {
    name: /^supplier$|^vendor$|supplier|vendor|name|المورد/i,
    category: /category|type|class|الفئة/i,
    opening: /opening|b\/?f|brought|افتتاحي/i,
    closing: /closing|balance|ختامي|الرصيد/i,
  },
  bills: {
    supplier: /^supplier$|^vendor$|supplier|vendor|المورد/i,
    ref: /^bill$|ref|number|invoice no|document|رقم/i,
    date: /date|تاريخ/i,
    gross: /gross|inc.?vat|total|إجمالي/i,
    net: /net|ex.?vat|subtotal|صافي/i,
    vat: /vat|tax|ضريبة/i,
    branch: /branch|cost ?cent|فرع/i,
  },
  payments: {
    supplier: /^supplier$|^vendor$|supplier|vendor|المورد/i,
    date: /date|تاريخ/i,
    amount: /amount|paid|payment|total|مبلغ/i,
    journal: /journal|bank|account|حساب/i,
    ref: /ref|memo|note|description|بيان/i,
    method: /method|طريقة/i,
  },
};

/**
 * Work out which column is which, claiming each at most once.
 * Returns `{ <role>: columnName | null, guessed: [roles] }`.
 */
function resolveColumns(kind, columns) {
  const guesses = GUESSES[kind] || {};
  const out = { guessed: [] };
  const taken = new Set();
  for (const [role, re] of Object.entries(guesses)) {
    const hit = (columns || []).find((c) => !taken.has(c) && re.test(String(c)));
    out[role] = hit || null;
    if (hit) { taken.add(hit); out.guessed.push(role); }
  }
  return out;
}

/* A workbook exported from here names its worksheets Balances / Bills /
   Payments, so the kind does not have to be guessed from the columns. */
const kindFromSheetName = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return KINDS.find((k) => n === k || n.startsWith(k)) || null;
};

/** Does this column map cover what the kind needs? */
function covers(kind, cols) {
  const need = kind === 'balances' ? ['name', 'closing']
    : ['supplier', 'date', kind === 'bills' ? 'gross' : 'amount'];
  return need.every((r) => cols[r]);
}

/** Read a workbook and describe it, without touching the database. */
function inspect(buffer, sheet) {
  const wb = Sheet.read(buffer, sheet);
  const suggestions = Object.fromEntries(KINDS.map((k) => [k, resolveColumns(k, wb.columns)]));
  /* Name first, columns second: a sheet called "Bills" is bills even if its
     headings would also satisfy another kind. */
  const byName = kindFromSheetName(wb.sheet);
  const fits = KINDS.filter((k) => covers(k, suggestions[k]));
  return {
    sheets: wb.sheets,
    sheet: wb.sheet,
    rowCount: wb.rowCount,
    columns: wb.columns,
    sample: wb.rows.slice(0, 12),
    suggestions,
    fits,
    likely: (byName && fits.includes(byName)) ? byName : (fits[0] || null),
    /* Every worksheet with the kind its name implies, so a three-sheet export can
       be walked without re-uploading to find out what is in it. */
    worksheets: wb.sheets.map((name) => ({ name, kind: kindFromSheetName(name) })),
  };
}

/**
 * Turn rows into the records we would write, and say what would change.
 *
 *   plan(kind, rows, cols) -> { records, skipped, problems }
 *
 * Nothing is written here — the caller decides after showing the summary.
 */
function plan(kind, rows, cols) {
  const records = [];
  const skipped = [];
  const problems = [];

  for (const [i, row] of (rows || []).entries()) {
    const at = `row ${i + 2}`; // +2: one for the header, one for 1-based counting
    const nameCol = kind === 'balances' ? cols.name : cols.supplier;
    const name = String(row[nameCol] == null ? '' : row[nameCol]).trim();
    if (!name) { skipped.push(`${at}: no supplier name`); continue; }

    if (kind === 'balances') {
      const opening = money(row[cols.opening]);
      const closing = money(row[cols.closing]);
      if (opening === null && closing === null) { skipped.push(`${at}: ${name} has neither balance`); continue; }
      records.push({
        name,
        category: cols.category ? (String(row[cols.category] || '').trim().toLowerCase() || null) : null,
        opening: opening === null ? 0 : opening,
        closing: closing === null ? 0 : closing,
      });
      continue;
    }

    const date = asDate(row[cols.date]);
    if (!date) { problems.push(`${at}: ${name} — could not read the date "${row[cols.date]}"`); continue; }

    if (kind === 'bills') {
      const gross = money(row[cols.gross]);
      const net = money(row[cols.net]);
      const vat = money(row[cols.vat]);
      if (gross === null && net === null) { problems.push(`${at}: ${name} — no amount`); continue; }
      /* Whichever two of gross / net / VAT are present decide the third, rather
         than assuming a rate. Only when just one is given is it taken as both. */
      const g = gross !== null ? gross : net + (vat || 0);
      const n = net !== null ? net : g - (vat || 0);
      records.push({
        name,
        ref: String(row[cols.ref] == null ? '' : row[cols.ref]).trim() || `${name} ${date.toISOString().slice(0, 10)}`,
        date,
        gross: g,
        net: n,
        vat: vat !== null ? vat : g - n,
        branch: cols.branch ? (String(row[cols.branch] || '').trim() || null) : null,
      });
      continue;
    }

    // payments
    const amount = money(row[cols.amount]);
    if (amount === null) { problems.push(`${at}: ${name} — no amount`); continue; }
    records.push({
      name,
      date,
      amount: Math.abs(amount), // stored unsigned; the minus is presentation
      journal: cols.journal ? (String(row[cols.journal] || '').trim() || '(no journal)') : '(no journal)',
      ref: cols.ref ? (String(row[cols.ref] || '').trim() || null) : null,
      method: cols.method ? (String(row[cols.method] || '').trim() || null) : null,
    });
  }

  return { records, skipped, problems };
}

/**
 * What this import would change against what is already stored.
 * Shown before anything is written, so "merge" is a promise you can check.
 */
async function preview(kind, records) {
  const names = [...new Set(records.map((r) => r.name))];
  const known = new Set((await prisma.supplier.findMany({
    where: { name: { in: names } }, select: { name: true },
  })).map((s) => s.name));

  const out = {
    kind,
    rows: records.length,
    suppliersNew: names.filter((n) => !known.has(n)),
    suppliersExisting: names.filter((n) => known.has(n)).length,
  };

  if (kind === 'balances') {
    out.closingTotal = records.reduce((s, r) => s + r.closing, 0);
    out.openingTotal = records.reduce((s, r) => s + r.opening, 0);
    const before = await prisma.supplier.aggregate({ where: { name: { in: names } }, _sum: { closing: true } });
    out.closingBefore = Number(before._sum.closing || 0);
  } else if (kind === 'bills') {
    out.grossTotal = records.reduce((s, r) => s + r.gross, 0);
    const refs = records.map((r) => r.ref);
    out.replacing = await prisma.bill.count({ where: { source: SOURCE, ref: { in: refs } } });
  } else {
    out.amountTotal = records.reduce((s, r) => s + r.amount, 0);
    /* Payments carry no reliable reference, so a re-import of the same file would
       double them. Same supplier, same date, same amount is treated as the same
       payment and replaced. */
    out.replacing = await prisma.vendorPayment.count({
      where: {
        source: SOURCE,
        OR: records.map((r) => ({ supplierName: r.name, date: dateOnly(r.date), amount: dec(r.amount) })),
      },
    });
  }
  return out;
}

/** Write the records. Merges: updates what exists, adds what does not, deletes nothing. */
async function commit(kind, records) {
  const names = [...new Set(records.map((r) => r.name))];

  return prisma.$transaction(async (tx) => {
    // Every kind needs its suppliers to exist first.
    for (const name of names) {
      await tx.supplier.upsert({
        where: { name },
        update: {},
        create: { name, category: null, opening: 0, closing: 0, source: SOURCE },
      });
    }

    let written = 0;
    if (kind === 'balances') {
      for (const r of records) {
        await tx.supplier.update({
          where: { name: r.name },
          data: { opening: r.opening, closing: r.closing, ...(r.category ? { category: r.category } : {}) },
        });
        written++;
      }
    } else if (kind === 'bills') {
      /* Updated in place, never deleted and rewritten. A bill owns its line items
         and this sheet carries none, so replacing the row would cascade its lines
         away — 2,545 of them, the first time a real export was imported back. */
      for (const r of records) {
        const data = {
          date: dateOnly(r.date), gross: r.gross, net: r.net, vat: r.vat,
          branch: r.branch, srcSystem: 'excel',
        };
        await tx.bill.upsert({
          where: { source_ref_supplierName: { source: SOURCE, ref: r.ref, supplierName: r.name } },
          update: data,
          create: { ref: r.ref, supplierName: r.name, source: SOURCE, ...data },
        });
      }
      written = records.length;
    } else {
      /* A payment has no reliable reference, so "the same payment" is supplier +
         date + amount. Two genuinely identical payments on one day are ordinary —
         two petty-cash runs of the same amount — so the key is cleared once and
         every row is then written, keeping however many the file holds. */
      const methods = new Map((await tx.journalMethod.findMany()).map((j) => [j.journal, j.method]));
      const cleared = new Set();
      for (const r of records) {
        const key = `${r.name}|${ymd(r.date)}|${r.amount}`;
        if (cleared.has(key)) continue;
        cleared.add(key);
        await tx.vendorPayment.deleteMany({
          where: { source: SOURCE, supplierName: r.name, date: dateOnly(r.date), amount: dec(r.amount) },
        });
      }
      await tx.vendorPayment.createMany({
        data: records.map((r) => ({
          supplierName: r.name, date: dateOnly(r.date), amount: r.amount,
          journal: r.journal, ref: r.ref,
          // Fall back to the journal→method map when the sheet does not say.
          method: r.method || methods.get(r.journal) || null,
          source: SOURCE,
        })),
      });
      written = records.length;
    }

    await tx.financeBatch.create({
      data: {
        section: 'payables', source: SOURCE, asOf: dateOnly(new Date()),
        rowCount: written, label: `Excel · ${kind}`,
      },
    });
    return { written, suppliers: names.length };
  }, { timeout: 120_000 });
}

module.exports = { KINDS, inspect, resolveColumns, plan, preview, commit, money, asDate, kindFromSheetName, covers };
