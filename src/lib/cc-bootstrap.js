/* ============================================================
   `const DATA`, `const APPT` and `const CRM`, rebuilt from Postgres.

   The Contact Centre report runs the standalone dashboard's own script, the
   way the merged Targets & Commission report does — every render function and
   every layout unchanged, because re-implementing them drifts. That script
   opens with three constants holding 930 KB between them, and this builds the
   same three objects out of the tables
   `scripts/import-contact-centre-html.js` filled.

   THIS IS THE IMPORTER RUN BACKWARDS, and deliberately written to be read
   against it. The rows are POSITIONAL TUPLES: `APPT.R[i][13]` is the ZAT flag
   and nothing else, and the script reads it by index. Every tuple below is
   spelled out field by field in the importer's order rather than assembled
   from a loop, because a transposition in a loop is invisible and a
   transposition in a list is not.

   TWO FIELDS ARE DERIVED, NOT STORED, and the importer is why:

     `ownBooking` was written as `r[6] === 1`, the same source as `outcome`, so
     the tuple carries `outcome` and the flag follows from it.
     `revenue` is `r[8]`, which lands in a Decimal column and comes back as a
     string — it is forced to a number or the script's arithmetic turns into
     string concatenation.

   `test/cc-bootstrap.test.js` compares every array against the blob lifted out
   of the original file.
   ============================================================ */

const { prisma, num } = require('./db.js');

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const flag = (b) => (b ? 1 : 0);

/**
 * The lookup arrays, each one an index space the tuples point into.
 *
 * A hole would silently shift every tuple indexing past it, so a missing slot
 * becomes an empty string rather than `undefined` — a blank label is visible,
 * a shifted index is not.
 */
async function lookups() {
  const rows = await prisma.ccLookup.findMany({ orderBy: [{ kind: 'asc' }, { idx: 'asc' }] });
  const out = {};
  for (const r of rows) (out[r.kind] ||= [])[r.idx] = r.value;
  for (const k of Object.keys(out)) {
    for (let i = 0; i < out[k].length; i += 1) if (out[k][i] == null) out[k][i] = '';
  }
  return out;
}

async function build() {
  const [L, opps, appts, leads, acts, rebooks, emps] = await Promise.all([
    lookups(),
    prisma.ccOpportunity.findMany({ orderBy: { id: 'asc' } }),
    prisma.ccAppointment.findMany({ orderBy: { id: 'asc' } }),
    prisma.ccLead.findMany({ orderBy: { id: 'asc' } }),
    prisma.ccActivity.findMany({ orderBy: { id: 'asc' } }),
    prisma.ccRebooking.findMany({ orderBy: { id: 'asc' } }),
    prisma.ccEmployee.findMany({ orderBy: { name: 'asc' } }),
  ]);

  /* ---- DATA ----
     `R` and `H` are PARALLEL: the hash at `H[i]` belongs to the row at `R[i]`,
     and the script pairs them by position, so they are built in one pass. */
  const R = [];
  const H = [];
  for (const o of opps) {
    R.push([
      ymd(o.date),        // 0
      o.hour,             // 1
      o.personIdx,        // 2
      o.branchIdx,        // 3
      o.deptIdx,          // 4
      o.doctorIdx,        // 5
      o.outcome,          // 6  — `ownBooking` was derived from this
      flag(o.showed),     // 7
      Math.round(num(o.revenue)), // 8
      o.team,             // 9
      o.loginIdx,         // 10
    ]);
    H.push(o.phoneHash || '');
  }

  const DATA = {
    E: L.E || [], B: L.B || [], P: L.P || [], D: L.D || [], LG: L.LG || [], R, H,
  };

  /* ---- APPT ---- */
  const APPT = {
    BR: L.BR || [], DOC: L.DOC || [], PP: L.PP || [], CAT: L.CAT || [], FAM: L.FAM || [],
    R: appts.map((a) => [
      ymd(a.date),          // 0
      a.slotMinutes,        // 1
      a.branchIdx,          // 2
      a.doctorIdx,          // 3
      a.stateCode,          // 4
      a.sourceCode,         // 5
      a.bookerIdx,          // 6
      a.familyIdx,          // 7
      a.categoryIdx,        // 8
      a.serviceLines,       // 9
      flag(a.hadConfirmCall), // 10
      a.confirmByIdx,       // 11
      flag(a.isReschedule), // 12
      flag(a.isZat),        // 13
    ]),
    SNAP: '',
    RANGE: ['', ''],
  };
  /* The range is the real minimum and maximum, not the first and last row —
     the importer writes in id order, which is not date order. */
  if (appts.length) {
    const dates = appts.map((a) => ymd(a.date)).sort();
    APPT.RANGE = [dates[0], dates[dates.length - 1]];
  }
  /* The snapshot time is the one thing the row tables do not carry. The
     importer put it in the upload record's notes, as its first line
     ("snapshot 2026-10-03 18:15"), so it is read back from there.

     Left blank rather than invented if the upload record is gone: the page
     prints this as the "as at" time, and a plausible-looking timestamp there
     would misstate how fresh the data is. */
  const upload = await prisma.dataUpload.findFirst({
    where: { kind: 'cc:seed' },
    orderBy: { id: 'desc' },
  });
  const snap = upload && /^snapshot (.+)$/m.exec(upload.notes || '');
  if (snap) APPT.SNAP = snap[1].trim();

  /* ---- CRM ---- */
  const CRM = {
    U: L.U || [], PN: L.PN || [], Bs: L.Bs || [], Ty: L.Ty || [], OUT: L.OUT || [],
    A: acts.map((a) => [
      ymd(a.date),      // 0
      a.hour,           // 1
      a.typeIdx,        // 2
      a.loginIdx,       // 3
      a.state,          // 4
      a.outcomeIdx,     // 5
      a.branchIdx,      // 6
      flag(a.onCcOpp),  // 7
      a.personIdx,      // 8
    ]),
    L: leads.map((l) => [
      ymd(l.date),              // 0
      l.hour,                   // 1
      l.loginIdx,               // 2
      l.branchIdx,              // 3
      flag(l.booked),           // 4
      l.minutesToBooking,       // 5
      flag(l.duplicateOfCc),    // 6
      l.openerIdx,              // 7
      flag(l.employeeOverwritten), // 8
    ]),
    RB: rebooks.map((r) => [
      ymd(r.date),        // 0
      r.leadBranchIdx,    // 1
      r.rebookLoginIdx,   // 2
      r.rebookBranchIdx,  // 3
      flag(r.credited),   // 4
      r.agentIdx,         // 5
      r.team,             // 6
      r.personIdx,        // 7
    ]),
    EI: {},
    /* Employees sharing a name, as [name, how many]. The report's health panel
       lists these. Derived from the count carried on each row, because the
       table is keyed by name and cannot show the duplication by itself. */
    DUPN: emps.filter((e) => e.recordCount > 1).map((e) => [e.name, e.recordCount]),
  };

  /* `EI` is keyed by name, and its value is positional too. The last slot is
     the active flag as 1/0 — the script wrote `e.active?1:0`, and it is
     compared against numbers downstream, so a boolean would not do. */
  for (const e of emps) {
    CRM.EI[e.name] = [
      e.department || '',
      e.jobTitle || '',
      e.homeLogin || '',
      e.allowedIds || [],
      flag(e.active),
    ];
  }

  return { DATA, APPT, CRM };
}

module.exports = { build, lookups };
