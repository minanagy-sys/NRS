/* ============================================================
   Importing the three things report 02 and report 03 have no feed for.

     pbx    the Grandstream UCM export — queue and agent activity by day. This
            is what turns four of report 02's five tabs from a frozen 1–18
            August snapshot into something that refreshes.
     chat   the omnichannel export. Chat was roughly seven in ten contacts in
            May and the newest export on the project stops on 6 June, so the
            busiest channel in the contact centre is currently invisible.
     leads  the CTA / organic lead sheet — the half of report 03's lead quality
            that does not come from Meta.
     returns goods sent back to a supplier. There is not ONE negative purchase
            line in the whole invoice cache, so report 09's returns are seeded
            from a frozen file and this is how a real export replaces them.

   THE SHAPE IS DELIBERATELY THE PAYABLES ONE. `inspect` → `resolveColumns` →
   `plan` → `preview` → `commit`, the same five functions with the same
   contracts, because the Admin page already knows how to drive that flow and a
   second upload idiom would mean a second set of edge cases. The
   inspect-then-review-then-import three-step is not ceremony either: nobody
   uploading a CDR export knows what columns it has, and the alternative to
   showing them is guessing.

   THREE RULES THAT DIFFER FROM PAYABLES, each for a reason:

   1. IT REPLACES BY DAY, IT DOES NOT MERGE. Payables merges because a supplier
      row is a running balance. A day of call records is a complete statement of
      that day, so re-importing a day replaces it — otherwise a corrected export
      adds its calls to the wrong ones instead of superseding them.

   2. IT WRITES `source = 'upload'`, NEVER OVER THE SEED. Seeded rows and
      uploaded rows live side by side under different sources, and report 02
      prints which it is reading. An upload covering 1–18 August does not delete
      the seed for those days; it stands beside it, and the report prefers
      `upload`. That way an import that turns out to be wrong can be deleted
      without leaving a hole where the snapshot used to be.

   3. LEADS KEEP NO IDENTITY. The sheet has names and phone numbers; what is
      stored is the ten-digit `mobileKey` and nothing else, exactly as with Meta
      leads. The phone is read to compute the key and then dropped, before the
      database.

   WHAT IS NOT KNOWN HERE, and is honest about it: no real Grandstream export
   has ever been seen on this project. The column patterns below are written for
   the field names a UCM CDR and queue report use, and `inspect` shows the
   sheet's actual columns beside the guesses so that whoever has the file can
   correct the mapping by hand in one screen rather than filing a bug. A refusal
   that lists the columns it found is useful; a silent zero is not.
   ============================================================ */

const Sheet = require('./sheet.js');
const { prisma, dateOnly, ymd } = require('./db.js');
const { mobileKey } = require('./patients.js');

const SOURCE = 'upload';
const KINDS = ['pbx', 'chat', 'leads', 'returns', 'payroll'];

/** A number from a cell. Blank is null, not zero — see `plan`. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[,\s]/g, '');
  if (!t || t === '-' || t === '—') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A duration in SECONDS from a cell.
 *
 * PBX exports are inconsistent about this in a way that silently changes every
 * derived figure by 60×: Grandstream writes talk time as `HH:MM:SS`, some
 * reports write plain seconds, and the frozen pack's own arrays are in minutes.
 * So a bare number is ambiguous and this treats it as seconds — which is what
 * every CDR export does — while `H:MM:SS` and `MM:SS` are parsed properly.
 * `inspect` shows a sample so the reader can see which one they have.
 */
function seconds(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const t = String(v).trim();
  const parts = t.split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts.map(Number);
    return [h, m, s].every(Number.isFinite) ? h * 3600 + m * 60 + s : null;
  }
  if (parts.length === 2) {
    const [m, s] = parts.map(Number);
    return [m, s].every(Number.isFinite) ? m * 60 + s : null;
  }
  return num(t);
}

/** A date from a cell. ISO, `YYYY-MM-DD HH:MM:SS`, `DD/MM/YYYY`, Excel serial. */
function asDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  }
  const s = String(v).trim();
  const iso = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return new Date(`${iso}T00:00:00Z`);
  /* `05/08/2026` is 5 August everywhere this clinic operates. Reading it as
     5 May would move a fortnight of calls into the wrong month, so
     day-first is assumed and stated rather than inferred per row. */
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s);
  if (dmy) {
    const [, dd, mm, yy] = dmy.map(Number);
    const out = new Date(Date.UTC(yy, mm - 1, dd));
    /* ROUND-TRIP CHECK, and it is not paranoia. `Date.UTC(2026, 30, 31)` does
       not fail — JavaScript rolls the overflow forward and hands back a
       perfectly valid day in 2028. So `31/31/2026`, which is a typo or a
       misread column, would import a day of calls into a month two years away
       and nothing anywhere would look wrong. An impossible date has to come
       back null. */
    if (out.getUTCFullYear() !== yy || out.getUTCMonth() !== mm - 1 || out.getUTCDate() !== dd) {
      return null;
    }
    return out;
  }
  return null;
}

/* Column guesses per kind. Ordered most specific first, and a column is never
   claimed twice — the rule the target importer learned when "August Target" and
   "July Target" both matched `target`. */
const GUESSES = {
  pbx: {
    date: /^(date|day|call\s*date|start\s*time|answered\s*time)/i,
    queue: /queue/i,
    ext: /^(ext|extension|agent\s*id|agent\s*no)/i,
    agentName: /^(agent|name|agent\s*name)/i,
    /* Grandstream calls these "Total Calls" / "Answered" on the queue report. */
    offered: /^(offered|total\s*calls|calls\s*offered|received)/i,
    answered: /^(answered|calls\s*answered|handled)/i,
    abandoned: /^(abandon|abandoned|lost|unanswered)/i,
    talkIn: /^(talk\s*(time|in)|in(bound)?\s*talk|duration\s*in)/i,
    dials: /^(dials|outbound\s*calls|calls\s*out|attempts)/i,
    connected: /^(connected|out(bound)?\s*answered|successful)/i,
    talkOut: /^(out(bound)?\s*talk|talk\s*out|duration\s*out)/i,
  },
  chat: {
    date: /^(date|day)/i,
    channel: /^(channel|source|platform)/i,
    /* Anchored so it does not claim a PBX export's "Total Calls" — which it
       did, making every queue report look like it might be a chat export. */
    contacts: /^(contacts|conversations|chats|sessions|total\s*(chats|contacts|conversations|sessions)?)$/i,
    bot: /^(bot|automated|handled\s*by\s*bot)/i,
    human: /^(human|agent|handled\s*by\s*(a\s*)?(human|agent))/i,
    firstResponse: /^(first\s*response|frt|response\s*time)/i,
  },
  returns: {
    date: /^(date|return\s*date|credit\s*date)/i,
    supplier: /^(supplier|vendor|company|from)/i,
    product: /^(product|item|description|material)/i,
    qty: /^(qty|quantity|units|returned)/i,
    unitCost: /^(unit\s*cost|cost|price|unit\s*price)/i,
    /* Anchored, so it cannot claim a "Unit Cost" column — `value` is the line
       total and reading a unit price as one understates a return by its
       quantity, which on 200 vials is 199 vials' worth of money. */
    value: /^(value|total|amount|net|line\s*total)$/i,
    category: /^(category|categ|type|group)/i,
  },
  /* The payroll month. Columns as Mina's own `_Doc comm <month>.xlsx` writes
     them on its Attendance and Basic worksheets — `Physician | Hours` — plus
     the deduction and fee columns the payslip needs. Nothing here is derivable
     from Odoo, which is the whole reason this kind exists. */
  payroll: {
    doctor: /^(physician|doctor|name|dr)\b/i,
    hours: /^(hours?|working\s*hours|total\s*hours)/i,
    ded: /^(deduction|ded)\b/i,
    dedReason: /^(reason|ded\s*reason)/i,
    onda: /^(onda|nurse)/i,
    mgmt: /^(management|mgmt)/i,
    /* A bare "%" is the withholding rate in the commission workbook's Basic
       worksheet, and it is the only percentage on that sheet. Matching it here
       saves the reviewer one hand-mapping; the two deduction columns on the
       same sheet are NOT guessed, because one of them is headed "complain" and
       a guess that reads a complaint as a deduction is worse than a prompt. */
    taxRate: /^(tax\s*rate|withholding|tax\s*%|%)$|^(tax\s*rate|withholding)/i,
    maint: /^(maint|maintenance)/i,
    gcell: /^(g\s*-?\s*cell|gcell)/i,
    adjustment: /^(adjust|correction|manual)/i,
    note: /^(note|notes|comment)/i,
  },
  leads: {
    date: /^(date|created|submitted|timestamp)/i,
    /* Read to compute the join key and then dropped — never stored. */
    phone: /^(phone|mobile|number|whats?app|tel)/i,
    formName: /^(form|source|campaign|cta)/i,
    doctor: /^(doctor|dr|specialist)/i,
  },
};

function resolveColumns(kind, columns) {
  const guesses = GUESSES[kind] || {};
  const out = { guessed: [] };
  const taken = new Set();
  for (const [role, re] of Object.entries(guesses)) {
    const hit = (columns || []).find((c) => !taken.has(c) && re.test(String(c).trim()));
    out[role] = hit || null;
    if (hit) { taken.add(hit); out.guessed.push(role); }
  }
  return out;
}

/** What each kind cannot be imported without. */
const NEEDS = {
  /* A PBX row needs a day and at least one thing that happened on it. Which
     columns are present decides whether it lands as queue activity, agent
     activity or both — a queue report has no extensions and an agent report has
     no queues, and both are legitimate uploads. */
  pbx: ['date'],
  chat: ['date', 'contacts'],
  leads: ['date', 'phone'],
  /* NO DATE. The frozen pack's own 11 returns carry none, and a real export may
     not either — a return is a fact about a product and a supplier, and the day
     it left is useful but not what makes it a return. Requiring one would have
     refused the only data that exists. */
  returns: ['supplier', 'product', 'value'],
  /* A NAME AND NOTHING ELSE IS ENOUGH. The Attendance worksheet is two columns;
     the Basic worksheet is one. Demanding hours would refuse a sheet that only
     carries deductions, and demanding all of them would refuse every real file —
     they arrive on separate tabs and are merged by doctor. */
  payroll: ['doctor'],
};

function covers(kind, cols) {
  return (NEEDS[kind] || []).every((r) => cols[r]);
}

const kindFromSheetName = (name) => {
  const n = String(name || '').trim().toLowerCase();
  if (/queue|agent|cdr|pbx|call/.test(n)) return 'pbx';
  if (/chat|whats?app|omni|messenger/.test(n)) return 'chat';
  if (/lead|cta|organic/.test(n)) return 'leads';
  if (/return|credit\s*note|sent\s*back/.test(n)) return 'returns';
  if (/attend|payroll|basic|hours|deduct/.test(n)) return 'payroll';
  return null;
};

/** Read a workbook and describe it. Nothing is written. */
function inspect(buffer, sheet, headerRow) {
  const wb = Sheet.read(buffer, sheet, headerRow);
  const suggestions = Object.fromEntries(KINDS.map((k) => [k, resolveColumns(k, wb.columns)]));
  const byName = kindFromSheetName(wb.sheet);
  const fits = KINDS.filter((k) => covers(k, suggestions[k]));
  return {
    sheets: wb.sheets,
    sheet: wb.sheet,
    rowCount: wb.rowCount,
    columns: wb.columns,
    /* A sample, because the one thing a reader must check by eye is whether a
       duration column is seconds or `HH:MM:SS` — the difference is 60× on every
       occupancy figure and no header name distinguishes them. */
    sample: wb.rows.slice(0, 12),
    suggestions,
    fits,
    likely: (byName && fits.includes(byName)) ? byName : (fits[0] || null),
    worksheets: wb.sheets.map((name) => ({ name, kind: kindFromSheetName(name) })),
  };
}

/* ------------------------------------------------------------------- plan */

/**
 * Turn rows into the records that would be written.
 *
 *   plan(kind, rows, cols) -> { records, skipped, problems }
 *
 * `problems` are rows that look like data and could not be read — a date that
 * will not parse, a phone that will not normalise. They BLOCK the import,
 * because the alternative is a day silently short of its calls.
 * `skipped` are rows that are not data at all — blank lines, a totals row —
 * and they are merely reported.
 */
function plan(kind, rows, cols, headerRow) {
  const records = [];
  const skipped = [];
  const problems = [];

  /* The row number a skip reports has to be the one in the margin of Excel, or
     "row 7: no name" sends somebody to the wrong line. With the header on row
     5, the first data row is 6 — not 2. */
  const base = (headerRow ? Number(headerRow) : 1) + 1;

  for (const [i, row] of (rows || []).entries()) {
    const at = `row ${i + base}`;
    const get = (role) => (cols[role] ? row[cols[role]] : undefined);

    const blank = Object.values(row).every((v) => v === null || v === undefined || v === '');
    if (blank) { skipped.push(`${at}: blank`); continue; }

    /* PAYROLL IS HANDLED BEFORE THE DATE CHECK TOO, and for the same reason
       written differently: a payroll row is a fact about a PERSON in a month,
       and the month comes from the upload, not from a column. The Attendance
       worksheet is literally two columns — `Physician | Hours` — so demanding a
       date would refuse the only file that exists. */
    if (kind === 'payroll') {
      const anyCell = Object.values(row).map((v) => String(v || '').toLowerCase()).join(' ');
      if (/\b(total|totals|sum|grand)\b/.test(anyCell)) {
        skipped.push(`${at}: looks like a totals row`);
        continue;
      }
      const doctor = String(get('doctor') || '').trim();
      if (!doctor) { skipped.push(`${at}: no name`); continue; }
      /* A header repeated inside the body — Mina's Attendance sheet opens with
         one — would otherwise import as a doctor called "Physician". */
      if (/^(physician|doctor|name)$/i.test(doctor)) {
        skipped.push(`${at}: a repeated header row`);
        continue;
      }

      /* 5, 0.05 and "5%" all mean the same withholding. Above 1 it is a
         percentage somebody typed; at or below 1 it is already a rate. */
      const pct = (v) => {
        const x = num(v);
        return x == null ? null : (x > 1 ? x / 100 : x);
      };

      records.push({
        doctorName: doctor,
        hours: num(get('hours')),
        ded: num(get('ded')),
        dedReason: String(get('dedReason') || '').trim() || null,
        onda: num(get('onda')),
        mgmt: num(get('mgmt')),
        taxRate: pct(get('taxRate')),
        maint: num(get('maint')),
        gcell: num(get('gcell')),
        adjustment: num(get('adjustment')),
        note: String(get('note') || '').trim() || null,
      });
      continue;
    }

    /* RETURNS ARE HANDLED BEFORE THE DATE CHECK, because they are the one kind
       that does not need one. The frozen pack's 11 returns carry no date at all
       and a real export may not either, so refusing them here — where every
       other kind is rightly refused — would reject the only returns data that
       exists. What a return cannot do without is a supplier, a product and a
       value; that is what NEEDS.returns asks for. */
    if (kind === 'returns') {
      const anyCell = Object.values(row).map((v) => String(v || '').toLowerCase()).join(' ');
      if (/\b(total|totals|sum|grand)\b/.test(anyCell)) {
        skipped.push(`${at}: looks like a totals row`);
        continue;
      }
      const supplier = String(get('supplier') || '').trim();
      const product = String(get('product') || '').trim();
      if (!supplier || !product) {
        skipped.push(`${at}: no supplier or no product`);
        continue;
      }
      const qty = num(get('qty'));
      const unitCost = num(get('unitCost'));
      let value = num(get('value'));
      if (value == null && qty != null && unitCost != null) {
        /* Derived, and only when both parts are there. Guessing a value from a
           quantity alone would invent money. */
        value = qty * unitCost;
      }
      if (value == null) {
        problems.push(`${at}: no value, and no quantity x unit cost to derive one from`);
        continue;
      }
      records.push({
        /* Stored POSITIVE whatever the sheet says. An export that writes
           returns as negatives and a caller that subtracts them would cancel
           out, and a return that increases a vendor's net purchase is the kind
           of wrong that reads as plausible. */
        date: asDate(get('date')),
        supplierName: supplier,
        product,
        category: cols.category ? (String(get('category') || '').trim() || null) : null,
        qty: Math.abs(qty || 0),
        unitCost: unitCost == null ? null : Math.abs(unitCost),
        value: Math.abs(value),
      });
      continue;
    }

    const d = asDate(get('date'));
    if (!d) {
      /* A totals footer has no date and the word "total" SOMEWHERE — not
         necessarily in the first column. The first real export tried against
         this had `Date` blank and `TOTAL` in the Queue column, which an
         only-look-at-the-first-cell rule read as a broken data row and let block
         the whole import. Any cell counts. */
      const anyCell = Object.values(row).map((v) => String(v || '').toLowerCase()).join(' ');
      if (/\b(total|totals|sum|grand|average|avg)\b/.test(anyCell)) {
        skipped.push(`${at}: looks like a totals row`);
        continue;
      }
      problems.push(`${at}: no readable date in "${cols.date}" (found ${JSON.stringify(get('date'))})`);
      continue;
    }

    if (kind === 'pbx') {
      const queue = cols.queue ? String(get('queue') || '').trim() : '';
      const ext = cols.ext ? String(get('ext') || '').trim() : '';
      if (!queue && !ext) {
        problems.push(`${at}: neither a queue nor an extension, so there is nothing to attribute`);
        continue;
      }
      records.push({
        kind: queue ? 'queue' : 'agent',
        date: d,
        queue: queue || null,
        ext: ext || null,
        agentName: cols.agentName ? (String(get('agentName') || '').trim() || null) : null,
        offered: num(get('offered')),
        answered: num(get('answered')),
        abandoned: num(get('abandoned')),
        talkInSec: seconds(get('talkIn')),
        dials: num(get('dials')),
        connected: num(get('connected')),
        talkOutSec: seconds(get('talkOut')),
      });
      continue;
    }

    if (kind === 'chat') {
      const contacts = num(get('contacts'));
      if (contacts === null) {
        problems.push(`${at}: no readable contact count in "${cols.contacts}"`);
        continue;
      }
      records.push({
        date: d,
        channel: cols.channel ? (String(get('channel') || '').trim() || 'unspecified') : 'unspecified',
        contacts,
        handledByBot: num(get('bot')) || 0,
        handledByHuman: num(get('human')) || 0,
        firstResponseSec: seconds(get('firstResponse')),
      });
      continue;
    }

    /* leads */
    const key = mobileKey(get('phone'));
    if (!key) {
      /* NOT a problem that blocks: a lead sheet legitimately contains rows whose
         number cannot be normalised (a landline, a foreign number, a typo), and
         those leads still happened. They are counted and reported so the
         unmatchable share is visible, which is the ceiling on what any
         lead-to-patient rate can ever reach. */
      skipped.push(`${at}: phone will not normalise to ten digits`);
      continue;
    }
    records.push({
      date: d,
      mobileKey: key,          // the raw number stops here
      formName: cols.formName ? (String(get('formName') || '').trim() || null) : null,
      doctor: cols.doctor ? (String(get('doctor') || '').trim() || null) : null,
    });
  }

  /* ---- hours arrive in DAYS, and it is measured, not assumed ----
     Excel stores a `[h]:mm` duration as a fraction of a day, and the sheet
     reader here deliberately parses no cell formats, so what lands is 2.328
     where the payslip says 55.87. 2.3280902778 x 24 = 55.8741666, exactly the
     pack's own figure for Dr Batoul Baradei — so the file really is in days.

     The decision is taken on the COLUMN's maximum rather than row by row, and
     that is the point: a column read half one way and half the other is wrong
     for half the people and looks right in the total. Nobody's MONTHLY hours
     are under a day, so a maximum below 24 can only be a day-fraction. The
     August file maxes at 8.02 (192 hours); a sheet already written in hours
     maxes in the hundreds and is left exactly as typed.

     `hoursBasis` travels out so the preview can SAY which reading it took.
     A conversion nobody can see is a conversion nobody can check. */
  if (kind === 'payroll') {
    const hours = records.map((r) => r.hours).filter((h) => h != null && h > 0);
    const max = hours.length ? Math.max(...hours) : 0;
    if (hours.length && max < 24) {
      for (const r of records) if (r.hours != null) r.hours = Math.round(r.hours * 24 * 100) / 100;
      records.hoursBasis = 'days';
    } else {
      records.hoursBasis = 'hours';
    }
    records.hoursMax = max;
  }

  return { records, skipped, problems };
}

/* ---------------------------------------------------------------- preview */

/** What committing would change, without changing it. */
async function preview(kind, records, opts = {}) {
  /* Only DATED rows build the span. `ymd(null)` is the string "null", and left
     in it sorted to the end and became the `to` date — a returns export where
     most rows carry no date would have reported its window as
     "2026-08-05 to null" across "2 days". Returns are the one kind that can
     legitimately arrive without a date, so this is where it shows. */
  const dates = records.map((r) => (r.date ? ymd(r.date) : null)).filter(Boolean).sort();
  const from = dates[0] || null;
  const to = dates[dates.length - 1] || null;
  const out = { kind, rows: records.length, from, to, days: new Set(dates).size };

  if (kind === 'pbx') {
    out.queueRows = records.filter((r) => r.kind === 'queue').length;
    out.agentRows = records.filter((r) => r.kind === 'agent').length;
    out.offered = records.reduce((t, r) => t + (r.offered || 0), 0);
    out.answered = records.reduce((t, r) => t + (r.answered || 0), 0);
    out.dials = records.reduce((t, r) => t + (r.dials || 0), 0);
    /* What is already there for those days, so the reader sees what an upload
       supersedes rather than discovering it afterwards. */
    if (from) {
      const [seedDays, upDays] = await Promise.all([
        prisma.pbxDay.count({ where: { source: 'seed', date: { gte: dateOnly(from), lte: dateOnly(to) } } }),
        prisma.pbxDay.count({ where: { source: SOURCE, date: { gte: dateOnly(from), lte: dateOnly(to) } } }),
      ]);
      out.existing = { seed: seedDays, upload: upDays };
      out.note = seedDays
        ? `${seedDays} of those days are currently seeded from the frozen report pack. The `
          + 'upload does NOT delete them — it lands beside them as `upload`, and the report '
          + 'prefers the upload. Delete the import and the snapshot is still there.'
        : null;
    }
  }

  if (kind === 'returns') {
    out.value = records.reduce((t, r) => t + (r.value || 0), 0);
    out.qty = records.reduce((t, r) => t + (r.qty || 0), 0);
    out.suppliers = [...new Set(records.map((r) => r.supplierName))].length;
    out.dated = records.filter((r) => r.date).length;
    const [seeded, uploaded] = await Promise.all([
      prisma.purchaseReturn.aggregate({ where: { source: 'seed' }, _count: true, _sum: { value: true } }),
      prisma.purchaseReturn.aggregate({ where: { source: SOURCE }, _count: true, _sum: { value: true } }),
    ]);
    out.existing = {
      seed: seeded._count, seedValue: Number(seeded._sum.value || 0),
      upload: uploaded._count, uploadValue: Number(uploaded._sum.value || 0),
    };
    /* THE ONE PLACE THIS DIFFERS FROM EVERY OTHER FEED. PBX and chat replace by
       DAY, because a day of call records is a complete statement of that day.
       Returns have no reliable date, so there is no day to replace by — an
       export of returns is a complete statement of ALL returns, and it replaces
       every uploaded row rather than a window of them. Merging instead would
       double a return each time the same export was loaded twice. */
    out.note = 'This REPLACES every previously uploaded return, not a date range — returns '
      + 'carry no reliable date, so an export is read as the complete list. '
      + (seeded._count
        ? `The ${seeded._count} rows seeded from the frozen pack (${Math.round(Number(seeded._sum.value || 0)).toLocaleString('en-US')}) are left in place; the report prefers the upload.`
        : 'Nothing is seeded.');
  }

  if (kind === 'payroll') {
    /* The month is NOT in the sheet — the Attendance worksheet is two columns
       wide — so it is chosen at upload time and echoed back here. A preview
       that did not name the month it is about to overwrite would be a preview
       of nothing. */
    const period = String(opts.period || '');
    out.period = period;
    out.doctors = records.length;
    out.withHours = records.filter((r) => r.hours != null).length;
    out.hours = Math.round(records.reduce((t, r) => t + (r.hours || 0), 0) * 100) / 100;
    /* Named, so the reader confirms the reading rather than trusting it. */
    out.hoursBasis = records.hoursBasis || 'hours';
    out.withDed = records.filter((r) => r.ded).length;
    out.withMgmt = records.filter((r) => r.mgmt != null).length;

    /* Who in this file the app has never heard of. A name typed differently
       from Odoo's — "Dr Mai" against "Mai Mohsen" — imports cleanly and then
       matches nothing, so it is named BEFORE the write, not discovered later
       as a doctor with hours and no revenue. */
    const known = new Set((await prisma.doctorScheme.findMany({ select: { doctorName: true } }))
      .map((d) => String(d.doctorName).trim().toLowerCase()));
    out.unknown = records
      .filter((r) => !known.has(String(r.doctorName).trim().toLowerCase()))
      .map((r) => r.doctorName);

    /* ---- the one way this upload can silently double somebody's pay ----
       The Basic worksheet lists Mai Mohsen's 100,000 and Poussy Maher's 50,000
       in its Management column, but those are the schemes' FIXED BASICS, not
       management fees. The payslip already adds the fixed basic; letting the
       same figure through as `mgmt` pays it twice. Measured on the August file:
       exactly two people. So it is checked, named, and left to the reader to
       decide — refusing the whole upload over two rows would be worse. */
    const schemed = await prisma.doctorScheme.findMany({
      where: { doctorName: { in: records.map((r) => r.doctorName) } },
      include: { scheme: true },
    });
    const fixed = new Map(schemed
      .filter((d) => d.scheme && d.scheme.fixedBasic != null)
      .map((d) => [String(d.doctorName).trim().toLowerCase(), Number(d.scheme.fixedBasic)]));
    out.doubled = records
      .filter((r) => r.mgmt != null
        && fixed.has(String(r.doctorName).trim().toLowerCase())
        && Math.abs(Number(r.mgmt) - fixed.get(String(r.doctorName).trim().toLowerCase())) < 1)
      .map((r) => ({ name: r.doctorName, amount: Number(r.mgmt) }));

    out.existing = { upload: await prisma.doctorPayrollMonth.count({ where: { period } }) };
    /* Replace-by-month, and for the returns reason written for a month: a
       payroll sheet is the complete statement of that month, so re-uploading a
       corrected one must supersede the old rows rather than sit beside them. */
    out.note = `This replaces every payroll row already stored for ${period || 'that month'}`
      + `${out.existing.upload ? ` — ${out.existing.upload} row(s)` : ' (there are none yet)'}. `
      + 'Other months are untouched.';
  }

  if (kind === 'chat') {
    out.contacts = records.reduce((t, r) => t + r.contacts, 0);
    out.channels = [...new Set(records.map((r) => r.channel))];
    /* Chat has never had a source, so anything at all is new. */
    out.existing = { upload: await prisma.chatDay.count() };
  }

  if (kind === 'leads') {
    out.leads = records.length;
    out.withKey = records.length;   // rows without a key never reach here
    out.existing = {
      organic: await prisma.metaLead.count({ where: { channel: 'organic' } }),
    };
    /* The whole point of the organic sheet is the half of lead quality Meta
       cannot see, so the overlap with Meta leads is worth knowing before import. */
    const keys = [...new Set(records.map((r) => r.mobileKey))];
    out.distinctMobiles = keys.length;
    out.alsoInMetaLeads = keys.length
      ? await prisma.metaLead.count({ where: { channel: 'ad', mobileKey: { in: keys.slice(0, 5000) } } })
      : 0;
  }

  return out;
}

/* ----------------------------------------------------------------- commit */

/**
 * Write the records.
 *
 * Replace-by-day within `source = 'upload'`: the days this file covers are
 * cleared of previous uploads and rewritten, and the seed is left alone. A day
 * of call records is a complete statement of that day, so a corrected export
 * must supersede the previous one rather than add to it.
 */
async function commit(kind, records, opts = {}) {
  if (!records.length) return { written: 0 };

  if (kind === 'payroll') {
    /* The month is the key here, not a date column — see `plan`. Refusing an
       unlabelled upload is the whole guard: a payroll sheet written into the
       wrong month is not a smaller error than one written nowhere. */
    const period = String(opts.period || '');
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new Error('A payroll import needs the month it is for, as YYYY-MM.');
    }
    return prisma.$transaction(async (tx) => {
      await tx.doctorPayrollMonth.deleteMany({ where: { period } });
      const written = await tx.doctorPayrollMonth.createMany({
        data: records.map((r) => ({
          period,
          doctorName: r.doctorName,
          hours: r.hours,
          ded: r.ded,
          dedReason: r.dedReason,
          onda: r.onda,
          mgmt: r.mgmt,
          taxRate: r.taxRate,
          maint: r.maint,
          gcell: r.gcell,
          adjustment: r.adjustment,
          note: r.note,
          source: SOURCE,
        })),
      });
      /* `from`/`to` so the DataUpload row this returns into records the month
         the way every other feed records its span. */
      return {
        written: written.count,
        period,
        from: `${period}-01`,
        to: `${period}-01`,
        replacedMonth: true,
      };
    });
  }

  if (kind === 'returns') {
    /* Replace every uploaded return, not a span — see `preview`. The seeded
       rows are untouched, exactly as an uploaded PBX day stands beside the
       seed, so an import that turns out to be wrong can be deleted without
       leaving a hole where the frozen figures used to be. */
    return prisma.$transaction(async (tx) => {
      await tx.purchaseReturn.deleteMany({ where: { source: SOURCE } });
      const written = await tx.purchaseReturn.createMany({
        data: records.map((r) => ({
          date: r.date || null,
          supplierName: r.supplierName,
          product: r.product,
          category: r.category || null,
          qty: r.qty,
          unitCost: r.unitCost,
          value: r.value,
          source: SOURCE,
        })),
      });
      return {
        written: written.count,
        value: records.reduce((t, r) => t + r.value, 0),
        replacedUploads: true,
      };
    });
  }

  const dates = records.map((r) => (r.date ? ymd(r.date) : null)).filter(Boolean).sort();
  if (!dates.length) throw new Error(`A ${kind} import needs at least one dated row.`);
  const from = dateOnly(dates[0]);
  const to = dateOnly(dates[dates.length - 1]);
  const span = { gte: from, lte: to };

  if (kind === 'pbx') {
    /* The day roll-up is DERIVED from the rows rather than read from a column,
       so it cannot disagree with them — the frozen pack's own headline
       disagreeing with its per-agent table is exactly the failure being
       avoided here. */
    const byDay = new Map();
    for (const r of records) {
      const k = ymd(r.date);
      if (!byDay.has(k)) byDay.set(k, { inboundCalls: 0, inboundAnswered: 0, dials: 0 });
      const d = byDay.get(k);
      if (r.kind === 'queue') {
        d.inboundCalls += r.offered || 0;
        d.inboundAnswered += r.answered || 0;
      }
      d.dials += r.dials || 0;
    }

    return prisma.$transaction(async (tx) => {
      await tx.pbxDay.deleteMany({ where: { source: SOURCE, date: span } });
      await tx.pbxQueueDay.deleteMany({ where: { source: SOURCE, date: span } });
      await tx.pbxAgentDay.deleteMany({ where: { source: SOURCE, date: span } });

      const dayRows = [...byDay.entries()].map(([d, v]) => ({
        date: dateOnly(d), ...v, source: SOURCE,
      }));
      const queueRows = records.filter((r) => r.kind === 'queue').map((r) => ({
        queue: r.queue, date: r.date,
        offered: r.offered || 0,
        answered: r.answered || 0,
        /* Derived when the export does not carry it, because offered minus
           answered is what abandoned means. */
        abandoned: r.abandoned !== null && r.abandoned !== undefined
          ? r.abandoned : Math.max(0, (r.offered || 0) - (r.answered || 0)),
        source: SOURCE,
      }));
      const agentRows = records.filter((r) => r.kind === 'agent').map((r) => ({
        ext: r.ext, agentName: r.agentName, date: r.date,
        offered: r.offered || 0, answered: r.answered || 0,
        talkInSec: r.talkInSec || 0,
        dials: r.dials || 0, connected: r.connected || 0,
        talkOutSec: r.talkOutSec || 0,
        source: SOURCE,
      }));

      const a = await tx.pbxDay.createMany({ data: dayRows });
      const b = queueRows.length ? await tx.pbxQueueDay.createMany({ data: queueRows }) : { count: 0 };
      const c = agentRows.length ? await tx.pbxAgentDay.createMany({ data: agentRows }) : { count: 0 };
      return { written: a.count + b.count + c.count, days: dayRows.length, from: dates[0], to: dates[dates.length - 1] };
    }, { timeout: 120000 });
  }

  if (kind === 'chat') {
    return prisma.$transaction(async (tx) => {
      await tx.chatDay.deleteMany({ where: { source: SOURCE, date: span } });
      const made = await tx.chatDay.createMany({
        data: records.map((r) => ({
          date: r.date, channel: r.channel, contacts: r.contacts,
          handledByBot: r.handledByBot, handledByHuman: r.handledByHuman,
          firstResponseSec: r.firstResponseSec, source: SOURCE,
        })),
        /* Two rows for the same day and channel in one sheet is the uploader's
           duplicate, not ours; the unique index refuses it and skipDuplicates
           keeps the first rather than failing the whole import. */
        skipDuplicates: true,
      });
      return { written: made.count, days: new Set(records.map((r) => ymd(r.date))).size };
    }, { timeout: 120000 });
  }

  /* leads — organic, alongside the Meta ones, distinguished by `channel`. */
  return prisma.$transaction(async (tx) => {
    await tx.metaLead.deleteMany({
      where: {
        source: SOURCE, channel: 'organic',
        createdAt: { gte: from, lte: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`) },
      },
    });
    const made = await tx.metaLead.createMany({
      data: records.map((r, i) => ({
        /* No lead id in the sheet, so one is derived from the day and the key.
           Deterministic on purpose: re-importing the same sheet produces the same
           ids rather than a second copy of every lead. */
        leadId: `organic:${ymd(r.date)}:${r.mobileKey}:${i}`,
        accountId: 'organic',
        createdAt: r.date,
        formName: r.formName,
        doctor: r.doctor,
        mobileKey: r.mobileKey,
        channel: 'organic',
        source: SOURCE,
      })),
      skipDuplicates: true,
    });
    return { written: made.count, from: dates[0], to: dates[dates.length - 1] };
  }, { timeout: 120000 });
}

module.exports = {
  KINDS, inspect, resolveColumns, plan, preview, commit, covers,
  kindFromSheetName, num, seconds, asDate, NEEDS, SOURCE,
};
