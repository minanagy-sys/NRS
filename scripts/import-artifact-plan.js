#!/usr/bin/env node
/* ============================================================
   Import the reference data the standalone Targets dashboard carried inside
   itself, into Postgres.

   `Targets Q4 2026 – 2027 · Nouvelage.html` was a Claude artifact: it read Odoo
   live in the browser and shipped everything else as a 584 KB `const D` on one
   line. The merged report reads Postgres instead, so that constant has to land
   in tables.

   What this does NOT import: the approved target sheet. `const TGT` in that
   file and `CommissionTarget` + `DoctorPlanMonth` in this database are the same
   numbers — 253,574,662 and 315,936,762 for branches, 149,255,643 and
   306,786,773 for doctors — and were compared before this script was written.
   Re-importing it could only introduce a difference. The script verifies the
   match and refuses if it has drifted.

   Everything written here is tagged `source = 'artifact'`, so a later live sync
   can tell seeded history from data it pulled itself.

     node scripts/import-artifact-plan.js --file "~/Downloads/Targets ….html"
     node scripts/import-artifact-plan.js --dry-run
   ============================================================ */

const fs = require('fs');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* not present */ }

const { prisma } = require('../src/lib/db.js');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'artifact-D.json');

/* The approved sheet, as this database already holds it. The import refuses if
   the file disagrees by more than a pound — a mismatch means one of the two has
   moved and a human has to say which. */
const APPROVED = {
  branches: { 2026: 253574662, 2027: 315936762 },
  doctors: { 2026: 149255643, 2027: 306786773 },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const DRY = process.argv.includes('--dry-run');

/**
 * Pull `const D` and `const TGT` off the one line that holds them. Both are
 * plain JSON despite being written as JavaScript, so this parses rather than
 * evaluates — nothing from a downloaded file should ever reach `eval`.
 */
function readArtifact(file) {
  if (file.endsWith('.json')) {
    const D = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tgtFile = file.replace(/artifact-D\.json$/, 'artifact-TGT.json');
    const TGT = fs.existsSync(tgtFile) ? JSON.parse(fs.readFileSync(tgtFile, 'utf8')) : null;
    return { D, TGT };
  }
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('const D={'));
  if (!line) throw new Error(`No "const D={…}" line in ${file}`);
  const cut = line.indexOf('const TGT=');
  if (cut < 0) throw new Error('Found const D but not const TGT — is this the right file?');
  const D = JSON.parse(line.slice('const D='.length, cut).replace(/;\s*$/, ''));
  const TGT = JSON.parse(line.slice(cut + 'const TGT='.length).replace(/;\s*$/, ''));
  return { D, TGT };
}

const sum = (a) => a.reduce((t, n) => t + n, 0);
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Total a `[{m:{"2027-03":n}}]` roster for one year. */
function yearTotal(rows, year) {
  return sum(rows.map((r) => sum(Object.keys(r.m).filter((k) => k.startsWith(year)).map((k) => +r.m[k] || 0))));
}

/**
 * The sheet in the file against the sheet in the database. A difference here is
 * not something to resolve automatically: it means the approved figures moved
 * after this database was seeded, or the file is a different revision.
 */
function verifyApproved(TGT) {
  if (!TGT) return ['Target sheet not present in the source — skipped the check.'];
  const notes = [];
  for (const [kind, rows] of [['branches', TGT.branches], ['doctors', TGT.doctors]]) {
    for (const year of ['2026', '2027']) {
      const got = Math.round(yearTotal(rows, year));
      const want = APPROVED[kind][year];
      if (Math.abs(got - want) > 1) {
        throw new Error(
          `The approved sheet has moved. ${kind} ${year}: the file says ${got.toLocaleString()}, `
          + `this database was seeded from ${want.toLocaleString()}. Nothing was written. `
          + `Reconcile the sheet first — the plan is not something to guess at.`,
        );
      }
      notes.push(`${kind} ${year} matches at ${want.toLocaleString()}`);
    }
  }
  return notes;
}

async function main() {
  const file = arg('file', DEFAULT_FILE).replace(/^~/, process.env.HOME || '~');
  const { D, TGT } = readArtifact(file);

  console.log(`Reading ${file}`);
  verifyApproved(TGT).forEach((n) => console.log(`  ✓ ${n}`));

  /* ---- monthly history: branch, group and product cuts ----
     `HistoryMonth` already holds 2024 and 2025 from the journal exports. The
     artifact reaches to 2026-09, which is exactly the stretch the Odoo cache
     does not cover, so the new months are the point of this import. Rows are
     written with source='artifact' and the existing seed rows are left alone —
     re-running overwrites only what this script owns. */
  const monthly = [];
  const cuts = [['act', 'branch'], ['actg', 'group'], ['actp', 'product']];
  for (const [key, kind] of cuts) {
    for (const [period, byName] of Object.entries(D[key] || {})) {
      for (const [name, ex] of Object.entries(byName)) {
        if (!ex) continue;
        monthly.push({ period, kind, name, ex: round2(ex), source: 'artifact' });
      }
    }
  }

  /* ---- daily history by branch ---- */
  const days = [];
  for (const [date, byBranch] of Object.entries(D.dly || {})) {
    for (const [name, ex] of Object.entries(byBranch)) {
      if (ex == null) continue;
      days.push({ date: new Date(`${date}T00:00:00Z`), name, ex: round2(ex), source: 'artifact' });
    }
  }

  /* ---- daily history by doctor ----
     Each entry is [doctor, branch, amount, invoiceCount, productType]. The same
     (day, doctor, branch, type) can appear more than once when a doctor billed
     the same type at two moments, so they are summed rather than overwritten —
     the primary key would otherwise drop all but the last. */
  const docDayMap = new Map();
  for (const [date, rows] of Object.entries(D.ddoc || {})) {
    for (const [doctorName, branchName, ex, invoices, productType] of rows) {
      const key = `${date}|${doctorName}|${branchName}|${productType || 'Other'}`;
      const prev = docDayMap.get(key);
      if (prev) { prev.ex += Number(ex) || 0; prev.invoices += Number(invoices) || 0; continue; }
      docDayMap.set(key, {
        date: new Date(`${date}T00:00:00Z`),
        doctorName,
        branchName,
        productType: productType || 'Other',
        ex: Number(ex) || 0,
        invoices: Number(invoices) || 0,
        source: 'artifact',
      });
    }
  }
  const docDays = [...docDayMap.values()].map((r) => ({ ...r, ex: round2(r.ex) }));

  /* ---- the plan's seasonal shape: branch × calendar month × service group ----
     `D.TG[branch]` is twelve arrays of five, the five being `D.G` in order. */
  const groups = D.G || [];
  const seasonality = [];
  for (const [branchName, months] of Object.entries(D.TG || {})) {
    months.forEach((byGroup, i) => {
      byGroup.forEach((ex, gi) => {
        if (!ex) return;
        seasonality.push({ branchName, month: i + 1, groupName: groups[gi] || `Group ${gi}`, ex: round2(ex) });
      });
    });
  }

  /* ---- product mix within each service group ---- */
  const mix = [];
  for (const [branchName, byGroup] of Object.entries(D.TP || {})) {
    for (const [groupName, byType] of Object.entries(byGroup)) {
      for (const [productType, share] of Object.entries(byType)) {
        if (!share) continue;
        mix.push({ branchName, groupName, productType, share: Number(Number(share).toFixed(6)) });
      }
    }
  }

  /* ---- weekday weights ----
     The artifact keyed these by `(jsDay + 6) % 7`, i.e. Monday first, so that
     `D.wd[4]` is Friday. Stored here under the same Monday-first convention,
     which is what the model documents: 0 = Monday … 6 = Sunday. */
  const weekdays = Object.entries(D.wd || {}).map(([dow, weight]) => ({
    dow: Number(dow),
    weight: Number(Number(weight).toFixed(4)),
  }));

  /* ---- doctors: cohort, branches, service mix, and the weekly roster ----
     `roster` is keyed by JavaScript's `getDay()` (0 = Sunday), which is a
     different convention to the weekday weights above and is kept as-is because
     the roster is matched against a real calendar date, not a weight table. */
  const profiles = [];
  const slots = [];
  for (const d of D.docs || []) {
    if (!d.name) continue;
    profiles.push({
      name: d.name,
      groupName: d.group || null,
      department: d.dep || null,
      branches: Array.isArray(d.branches) ? d.branches : [],
      mix: d.mix || null,
      source: 'artifact',
    });
    for (const [dow, entries] of Object.entries(d.roster || {})) {
      for (const [branchName, hours, startTime, endTime, department] of entries || []) {
        slots.push({
          doctorName: d.name,
          dow: Number(dow),
          branchName: branchName || '',
          hours: Number(hours) || 0,
          startTime: startTime || '',
          endTime: endTime || '',
          department: department || '',
          source: 'artifact',
        });
      }
    }
  }

  const plan = [
    ['HistoryMonth (2026 months)', monthly.length],
    ['HistoryDay', days.length],
    ['HistoryDayDoctor', docDays.length],
    ['PlanSeasonality', seasonality.length],
    ['PlanProductMix', mix.length],
    ['WeekdayWeight', weekdays.length],
    ['DoctorProfile', profiles.length],
    ['DoctorRosterSlot', slots.length],
  ];
  console.log('\nTo write:');
  plan.forEach(([what, n]) => console.log(`  ${String(n).padStart(6)}  ${what}`));

  if (DRY) { console.log('\n--dry-run: nothing written.'); return; }

  /* One transaction: a half-imported reference set would score every figure on
     the report slightly wrong, which is worse than not importing at all. */
  await prisma.$transaction(async (tx) => {
    await tx.historyMonth.deleteMany({ where: { source: 'artifact' } });
    await tx.historyMonth.createMany({ data: monthly, skipDuplicates: true });

    await tx.historyDay.deleteMany({ where: { source: 'artifact' } });
    await tx.historyDay.createMany({ data: days, skipDuplicates: true });

    await tx.historyDayDoctor.deleteMany({ where: { source: 'artifact' } });
    await tx.historyDayDoctor.createMany({ data: docDays, skipDuplicates: true });

    await tx.planSeasonality.deleteMany({});
    await tx.planSeasonality.createMany({ data: seasonality, skipDuplicates: true });

    await tx.planProductMix.deleteMany({});
    await tx.planProductMix.createMany({ data: mix, skipDuplicates: true });

    await tx.weekdayWeight.deleteMany({});
    await tx.weekdayWeight.createMany({ data: weekdays, skipDuplicates: true });

    await tx.doctorRosterSlot.deleteMany({ where: { source: 'artifact' } });
    await tx.doctorProfile.deleteMany({ where: { source: 'artifact' } });
    await tx.doctorProfile.createMany({ data: profiles, skipDuplicates: true });
    await tx.doctorRosterSlot.createMany({ data: slots, skipDuplicates: true });
  }, { timeout: 120000 });

  /* ---- what landed, read back rather than assumed ---- */
  const months = await prisma.historyMonth.groupBy({ by: ['kind'], _count: true });
  const span = await prisma.$queryRawUnsafe(
    `select min(period) lo, max(period) hi from "HistoryMonth"`,
  );
  const dayspan = await prisma.$queryRawUnsafe(
    `select min(date)::text lo, max(date)::text hi, count(*)::int n from "HistoryDay"`,
  );
  console.log('\nWritten:');
  months.forEach((m) => console.log(`  HistoryMonth ${m.kind}: ${m._count} rows`));
  console.log(`  HistoryMonth spans ${span[0].lo} → ${span[0].hi}`);
  console.log(`  HistoryDay ${dayspan[0].n} rows, ${dayspan[0].lo} → ${dayspan[0].hi}`);
}

main()
  .catch((e) => { console.error(`\n${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
