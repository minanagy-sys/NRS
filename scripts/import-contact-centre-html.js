#!/usr/bin/env node
/* Seed the contact centre v2 tables from the standalone HTML snapshot.
 *
 *   node scripts/import-contact-centre-html.js --dry-run "~/Downloads/Contact Centre · Nouvelage.html"
 *   node scripts/import-contact-centre-html.js "~/Downloads/Contact Centre · Nouvelage.html"
 *
 * WHY A SEEDER AND NOT A SYNC. The snapshot answers a question Odoo will not
 * answer directly: who actually did this. Five shared logins stand between 67
 * people and every record they touch, and the only way through is the
 * `Employee:` line in the first "Record created" chatter message. The page
 * already did that work against nine Odoo models; re-deriving it live is a
 * different and much larger job. This imports the answer it reached.
 *
 * IT REFUSES RATHER THAN GUESSES, the way import-report-html.js refuses when
 * the per-day cube disagrees with its own summaries. An index that falls
 * outside its lookup, a row of the wrong width, an appointment outside the
 * snapshot's own declared range — any of those and nothing is written, because
 * a half-decoded row is indistinguishable from a real one once it is in a
 * table.
 *
 * IT RECORDS RATHER THAN REFUSES five things the snapshot structurally cannot
 * carry. Those are not corruption, they are the export's shape, and they land
 * verbatim in DataUpload.notes so the report can refuse them by name instead of
 * drawing an empty table that reads as "nobody did this".
 */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const fs = require('fs');
const { prisma } = require('../src/lib/db.js');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const f = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * Pull one `const NAME = {...}` / `[...]` literal out of the file.
 *
 * Bracket-matched rather than regex-terminated, for the same reason the PBX
 * seeder is: the blocks contain nested objects and bilingual captions, and a
 * non-greedy `[\s\S]*?]` stops at the first inner bracket and silently
 * truncates 12,386 rows to one.
 */
function literal(src, name) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([[{])`).exec(src);
  if (!m) throw new Error(`${name} not found in the file`);
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return parse(src.slice(start, i + 1), name);
    }
  }
  throw new Error(`${name} is not closed`);
}

/* Most of these are JSON; DEF_EXT is single-quoted JavaScript. Rather than
   rewriting quotes with a regex — which corrupts any name containing an
   apostrophe — evaluate it as the literal it is, with NO globals at all. */
function parse(text, name) {
  try { return JSON.parse(text); } catch { /* not JSON */ }
  try {
    return require('vm').runInNewContext(`(${text})`, Object.create(null), { timeout: 2000 });
  } catch (e) {
    throw new Error(`${name} is neither JSON nor a plain literal: ${e.message}`);
  }
}

/* ---- refusals ------------------------------------------------------------ */

const problems = [];
function refuse(what) { problems.push(what); }

/** Every index in a column must resolve inside its lookup, or the decode is a
 *  guess dressed as a figure. */
function checkIdx(rows, col, lookup, label, { allowNeg = false } = {}) {
  const max = lookup.length - 1;
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i][col];
    if (allowNeg && v === -1) continue;
    if (!Number.isInteger(v) || v < 0 || v > max) {
      refuse(`${label}: row ${i} has index ${v}, outside 0..${max}`);
      return;
    }
  }
}

function checkWidth(rows, width, label) {
  const bad = rows.findIndex((r) => r.length !== width);
  if (bad >= 0) refuse(`${label}: row ${bad} is ${rows[bad].length} wide, expected ${width}`);
}

const D = (s) => new Date(`${s}T00:00:00Z`);

(async () => {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Give the path to the Contact Centre HTML');
  const path = file.replace(/^~/, process.env.HOME);
  const src = fs.readFileSync(path, 'utf8');

  console.log(`\n${DRY ? 'DRY RUN — nothing is saved' : 'WRITING'} · ${path.split('/').pop()}\n`);

  const DATA = literal(src, 'DATA');
  const APPT = literal(src, 'APPT');
  const CRM = literal(src, 'CRM');
  const EXT = literal(src, 'DEF_EXT');

  /* ---- the lookups --------------------------------------------------------
     Flattened into one table because they are all (index -> string) and are
     only ever read by index. */
  const LOOKUPS = {
    E: DATA.E, B: DATA.B, P: DATA.P, D: DATA.D, LG: DATA.LG || [],
    BR: APPT.BR, DOC: APPT.DOC, PP: APPT.PP, CAT: APPT.CAT, FAM: APPT.FAM,
    U: CRM.U, PN: CRM.PN, Bs: CRM.Bs, Ty: CRM.Ty, OUT: CRM.OUT,
  };
  for (const [k, v] of Object.entries(LOOKUPS)) {
    if (!Array.isArray(v) || !v.length) refuse(`lookup ${k} is missing or empty`);
  }

  /* ---- widths -------------------------------------------------------------
     The file's own schema comment at line 462 names TEN fields. The rows are
     ELEVEN wide — index 10 is the login, added after the comment was written.
     Pinned here so a regenerated pack that really is 10 wide stops the import
     rather than silently shifting every column by one. */
  checkWidth(DATA.R, 11, 'DATA.R');
  checkWidth(APPT.R, 14, 'APPT.R');
  const leadWidth = CRM.L.length ? CRM.L[0].length : 0;
  checkWidth(CRM.L, leadWidth, 'CRM.L');
  checkWidth(CRM.A, 9, 'CRM.A');
  checkWidth(CRM.RB, 8, 'CRM.RB');

  /* ---- indices ---- */
  checkIdx(DATA.R, 2, LOOKUPS.E, 'DATA.R person');
  checkIdx(DATA.R, 3, LOOKUPS.B, 'DATA.R branch');
  checkIdx(DATA.R, 4, LOOKUPS.P, 'DATA.R dept');
  checkIdx(DATA.R, 5, LOOKUPS.D, 'DATA.R doctor');
  checkIdx(DATA.R, 10, LOOKUPS.LG, 'DATA.R login');
  checkIdx(APPT.R, 2, LOOKUPS.BR, 'APPT.R branch');
  checkIdx(APPT.R, 3, LOOKUPS.DOC, 'APPT.R doctor');
  checkIdx(APPT.R, 6, LOOKUPS.PP, 'APPT.R booker');
  checkIdx(APPT.R, 7, LOOKUPS.FAM, 'APPT.R family');
  checkIdx(APPT.R, 8, LOOKUPS.CAT, 'APPT.R category');
  checkIdx(APPT.R, 11, LOOKUPS.PP, 'APPT.R confirmed by', { allowNeg: true });
  checkIdx(CRM.L, 2, LOOKUPS.U, 'CRM.L login');
  checkIdx(CRM.L, 3, LOOKUPS.Bs, 'CRM.L branch');
  checkIdx(CRM.L, 7, LOOKUPS.PN, 'CRM.L opener');
  checkIdx(CRM.A, 2, LOOKUPS.Ty, 'CRM.A type');
  checkIdx(CRM.A, 3, LOOKUPS.U, 'CRM.A login');
  checkIdx(CRM.A, 5, LOOKUPS.OUT, 'CRM.A outcome', { allowNeg: true });
  checkIdx(CRM.A, 6, LOOKUPS.Bs, 'CRM.A branch');
  checkIdx(CRM.A, 8, LOOKUPS.PN, 'CRM.A person', { allowNeg: true });
  checkIdx(CRM.RB, 1, LOOKUPS.Bs, 'CRM.RB lead branch');
  checkIdx(CRM.RB, 2, LOOKUPS.U, 'CRM.RB rebook login', { allowNeg: true });
  /* -1 on exactly the 1,139 credited rows: a booking that was never re-booked
     has no re-booking login and no re-booking branch. */
  checkIdx(CRM.RB, 3, LOOKUPS.Bs, 'CRM.RB rebook branch', { allowNeg: true });
  checkIdx(CRM.RB, 5, LOOKUPS.E, 'CRM.RB agent');
  checkIdx(CRM.RB, 7, LOOKUPS.PN, 'CRM.RB person', { allowNeg: true });

  /* ---- the appointments must sit inside the range the file itself declares -- */
  const [rFrom, rTo] = APPT.RANGE || [];
  if (!rFrom || !rTo) refuse('APPT.RANGE is missing');
  else {
    const out = APPT.R.filter((r) => r[0] < rFrom || r[0] > rTo);
    if (out.length) refuse(`APPT.R: ${out.length} rows outside the declared range ${rFrom} → ${rTo}`);
  }

  /* ---- H must be parallel to R, or the phone join is attached to the wrong
          opportunities and every matched call is attributed to a stranger. */
  const H = DATA.H || [];
  if (H.length !== DATA.R.length) refuse(`DATA.H is ${H.length} long, DATA.R is ${DATA.R.length}`);

  if (problems.length) {
    console.error('✗ REFUSED — nothing was written:\n');
    for (const p of problems) console.error(`   ${p}`);
    console.error('');
    await prisma.$disconnect();
    process.exit(1);
  }

  /* ---- what the snapshot structurally cannot carry -------------------------
     Measured here rather than asserted, so a fresher export that DOES carry
     them stops producing the note by itself. */
  const notes = [];
  const allMinusOne = (rows, c) => rows.length && rows.every((r) => r[c] === -1);
  if (leadWidth < 10) {
    notes.push(`GAP lead source — CRM.L rows are ${leadWidth} fields wide; source and campaign `
      + 'are not in this export. The lead-source section reports this, not "0 sources used".');
  }
  if (allMinusOne(CRM.A, 8)) {
    notes.push(`GAP activity person — CcActivity.personIdx is -1 on all ${f(CRM.A.length)} rows. `
      + 'The activities table can only be broken down by login.');
  }
  if (allMinusOne(CRM.RB, 7)) {
    notes.push(`GAP rebooker person — CcRebooking.personIdx is -1 on all ${f(CRM.RB.length)} rows. `
      + '"Mostly re-booked by" can only name a login.');
  }
  const teams = new Set(DATA.R.map((r) => r[9]));
  if (teams.size === 1) {
    notes.push(`GAP team split — CcOpportunity.team is ${[...teams][0]} on all ${f(DATA.R.length)} `
      + 'rows. The branch-follow-up toggle has nothing to show.');
  }
  if (!APPT.R.some((r) => r[5] === 2)) {
    notes.push('GAP booking source — APPT.R never uses source 2 (system). Only contact centre '
      + 'and branch appear.');
  }
  const withCall = APPT.R.filter((r) => r[10]).length;
  notes.push(`confirmation calls ${f(withCall)} of ${f(APPT.R.length)} appointments `
    + `(${((withCall / APPT.R.length) * 100).toFixed(1)}%).`);

  /* ---- the figures, re-derived from the decoded rows ---- */
  /* TWO SHOW COUNTS, AND THEY ARE NOT THE SAME NUMBER. The report's own agg()
     skips opportunities that produced no booking BEFORE testing the show flag,
     so its 1,435 counts patients who were booked and arrived. The raw flag is
     on 1,576 rows — 141 more — because a patient can be matched to a visit
     through an opportunity that never booked anything. Both are printed, and
     labelled, because printing one as the other overstates the contact centre
     by 141 patients and 687,548 EGP. */
  const O_NB = 0;
  const booked = DATA.R.filter((r) => r[6] !== O_NB).length;
  const own = DATA.R.filter((r) => r[6] === 1).length;
  const showedBooked = DATA.R.filter((r) => r[6] !== O_NB && r[7]).length;
  const revenueBooked = DATA.R.filter((r) => r[6] !== O_NB && r[7])
    .reduce((s, r) => s + (r[8] || 0), 0);
  const showed = DATA.R.filter((r) => r[7]).length;
  const revenue = DATA.R.reduce((s, r) => s + (r[8] || 0), 0);

  console.log('  lookups          ', Object.entries(LOOKUPS).map(([k, v]) => `${k}:${v.length}`).join(' '));
  console.log('  opportunities    ', f(DATA.R.length), `· booked ${f(booked)}`
    + ` · showed ${f(showedBooked)} of those · own booking ${f(own)}`);
  console.log('  revenue (EGP)    ', f(revenueBooked), '— on booked-and-showed, indicative');
  console.log('  also matched     ', f(showed - showedBooked), 'patients arrived through an '
    + `opportunity that booked nothing (${f(revenue - revenueBooked)} EGP), counted nowhere above`);
  console.log('  appointments     ', f(APPT.R.length), `· ${rFrom} → ${rTo} · snapshot ${APPT.SNAP}`);
  console.log('  leads            ', f(CRM.L.length), `· booked ${f(CRM.L.filter((r) => r[4]).length)}`);
  console.log('  activities       ', f(CRM.A.length));
  console.log('  re-bookings      ', f(CRM.RB.length), `· credited ${f(CRM.RB.filter((r) => r[6 - 0] !== undefined && r[4] === 1).length)}`);
  console.log('  HR directory     ', f(Object.keys(CRM.EI || {}).length));
  console.log('  extensions       ', f(EXT.length), `· cc ${EXT.filter((r) => r[3] === 'cc').length}`
    + ` · branch ${EXT.filter((r) => r[3] === 'branch').length}`
    + ` · with an Odoo name ${EXT.filter((r) => r[2]).length}`);
  console.log('\n  notes recorded:');
  for (const n of notes) console.log(`   · ${n}`);

  if (DRY) {
    console.log('\n  Nothing was saved. Re-run without --dry-run.\n');
    await prisma.$disconnect();
    return;
  }

  /* ---- the write ----------------------------------------------------------
     One transaction, scoped to source 'seed' throughout: a re-import replaces
     the seed and leaves anything else alone. */
  const lookupRows = [];
  for (const [kind, arr] of Object.entries(LOOKUPS)) {
    arr.forEach((value, idx) => lookupRows.push({ kind, idx, value: String(value) }));
  }

  const opps = DATA.R.map((r, i) => ({
    date: D(r[0]), hour: r[1], personIdx: r[2], branchIdx: r[3], deptIdx: r[4], doctorIdx: r[5],
    outcome: r[6], showed: !!r[7], ownBooking: r[6] === 1, revenue: r[8] || 0, team: r[9],
    loginIdx: r[10], phoneHash: H[i] || null,
  }));

  const appts = APPT.R.map((r) => ({
    date: D(r[0]), slotMinutes: r[1], branchIdx: r[2], doctorIdx: r[3], stateCode: r[4],
    sourceCode: r[5], bookerIdx: r[6], familyIdx: r[7], categoryIdx: r[8], serviceLines: r[9],
    hadConfirmCall: !!r[10], confirmByIdx: r[11], isReschedule: !!r[12], isZat: !!r[13],
  }));

  const leads = CRM.L.map((r) => ({
    date: D(r[0]), hour: r[1], loginIdx: r[2], branchIdx: r[3], booked: !!r[4],
    minutesToBooking: r[5], duplicateOfCc: !!r[6], openerIdx: r[7], employeeOverwritten: !!r[8],
  }));

  const acts = CRM.A.map((r) => ({
    date: D(r[0]), hour: r[1], typeIdx: r[2], loginIdx: r[3], state: r[4],
    outcomeIdx: r[5], branchIdx: r[6], onCcOpp: !!r[7], personIdx: r[8],
  }));

  const rebs = CRM.RB.map((r) => ({
    date: D(r[0]), leadBranchIdx: r[1], rebookLoginIdx: r[2], rebookBranchIdx: r[3],
    credited: r[4] === 1, agentIdx: r[5], team: r[6], personIdx: r[7],
  }));

  const emps = Object.entries(CRM.EI || {}).map(([name, v]) => ({
    name,
    department: String(v[0] || ''),
    jobTitle: String(v[1] || ''),
    homeLogin: String(v[2] || ''),
    allowedIds: Array.isArray(v[3]) ? v[3].filter(Number.isInteger) : [],
    active: v[4] !== false && v[4] !== 0,
  }));

  const exts = EXT.map((r) => ({
    ext: String(r[0]), phoneName: String(r[1] || ''), odooEmployee: String(r[2] || ''),
    team: String(r[3] || 'other'), branch: String(r[4] || ''),
  }));

  const rowsWritten = lookupRows.length + opps.length + appts.length + leads.length
    + acts.length + rebs.length + emps.length + exts.length;

  await prisma.$transaction([
    prisma.ccLookup.deleteMany({ where: { source: 'seed' } }),
    prisma.ccOpportunity.deleteMany({ where: { source: 'seed' } }),
    prisma.ccAppointment.deleteMany({ where: { source: 'seed' } }),
    prisma.ccLead.deleteMany({ where: { source: 'seed' } }),
    prisma.ccActivity.deleteMany({ where: { source: 'seed' } }),
    prisma.ccRebooking.deleteMany({ where: { source: 'seed' } }),
    prisma.ccEmployee.deleteMany({ where: { source: 'seed' } }),
    prisma.pbxExtension.deleteMany({ where: { source: 'seed' } }),
    prisma.ccLookup.createMany({ data: lookupRows }),
    prisma.ccOpportunity.createMany({ data: opps }),
    prisma.ccAppointment.createMany({ data: appts }),
    prisma.ccLead.createMany({ data: leads }),
    prisma.ccActivity.createMany({ data: acts }),
    prisma.ccRebooking.createMany({ data: rebs }),
    prisma.ccEmployee.createMany({ data: emps }),
    prisma.pbxExtension.createMany({ data: exts }),
    prisma.dataUpload.create({
      data: {
        kind: 'cc:seed',
        filename: path.split('/').pop(),
        rangeFrom: D(DATA.R.map((r) => r[0]).sort()[0]),
        rangeTo: D(CRM.L.map((r) => r[0]).sort().pop()),
        rowsWritten,
        actor: 'scripts/import-contact-centre-html.js',
        notes: [`snapshot ${APPT.SNAP}`, `appointments ${rFrom} → ${rTo}`, ...notes].join('\n'),
      },
    }),
  ], { timeout: 120000 });

  console.log(`\n  ${f(rowsWritten)} rows written.\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('\n✗', e.message, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
