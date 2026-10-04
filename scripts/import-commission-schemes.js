#!/usr/bin/env node
/* Seed the commission schemes, and assign the doctors the payslip pack names.
 *
 *   node scripts/import-commission-schemes.js                 # dry run
 *   node scripts/import-commission-schemes.js --write
 *   node scripts/import-commission-schemes.js --write --pack ~/Downloads/x.html
 *
 * TWO SOURCES, AND THEY DISAGREE ABOUT WHO EXISTS.
 *
 *   `Nouvel Age Commissions.xlsx` states the RULES — eight schemes, their
 *   bands, hourly rates and management fees. Transcribed into
 *   `src/lib/commission-schemes.js` SEED rather than parsed, because the
 *   workbook writes them nine different ways across nine worksheets ("0 - 700K",
 *   "1.5M and above", "17% (no target limit)") and a parser for that is a
 *   parser for one file, not for a format.
 *
 *   The payslip pack states WHO IS ON WHICH — 73 people, each with a `scheme`,
 *   a `tax_rate`, a management fee and a bank account. That is a fact about
 *   August, and it is read from the file rather than typed.
 *
 * IT NEVER OVERWRITES AN EDIT. Schemes and assignments are upserted on first
 * sight only: once a rate has been changed in Admin, a re-run leaves it alone.
 * Re-seeding on purpose is `--force`, which is a different, deliberate act.
 */

const fs = require('fs');
const path = require('path');
const { prisma } = require('../src/lib/db.js');
const Schemes = require('../src/lib/commission-schemes.js');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
const packAt = (() => {
  const i = args.indexOf('--pack');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const guess = path.join(process.env.HOME || '', 'Downloads',
    'Nouvelage_commissions_payslips_Aug-2026.html');
  return fs.existsSync(guess) ? guess : null;
})();

const n = (v) => Math.round(Number(v || 0)).toLocaleString('en-US');

/** The people and their schemes, out of the payslip pack. */
function readPack(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = /const DATA = (\{[\s\S]*?\});\n/.exec(src);
  if (!m) throw new Error('No `const DATA = {...}` in that file.');
  return JSON.parse(m[1]);
}

(async () => {
  console.log(`\n${WRITE ? 'WRITING' : 'DRY RUN — nothing is saved'}\n`);

  /* ---- 1 · the schemes ---- */
  const existing = await prisma.commissionScheme.findMany({ select: { name: true } });
  const have = new Set(existing.map((s) => s.name));
  let added = 0;
  let left = 0;

  for (const s of Schemes.SEED) {
    if (have.has(s.name) && !FORCE) {
      left += 1;
      console.log(`  · ${s.name.padEnd(20)} already stored — left exactly as it is`);
      continue;
    }
    const bandText = s.bands.length
      ? s.bands.map((b) => `${n(b.from)}–${b.to == null ? 'above' : n(b.to)} ${(b.rate * 100).toFixed(1)}%`).join(' · ')
      : 'no bands stated';
    console.log(`  ${have.has(s.name) ? '↻' : '+'} ${s.name.padEnd(20)} ${bandText}`);
    console.log(`    ${' '.repeat(20)} hourly ${s.hourlyRate == null ? 'NOT counted' : s.hourlyRate}`
      + `${s.fixedBasic ? ` · fixed basic ${n(s.fixedBasic)}` : ''}`);
    if (WRITE) {
      await prisma.commissionScheme.upsert({
        where: { name: s.name },
        update: FORCE ? {
          bands: s.bands, hourlyRate: s.hourlyRate, fixedBasic: s.fixedBasic ?? null,
          notes: s.notes, sortOrder: s.sortOrder,
        } : {},
        create: {
          name: s.name, bands: s.bands, hourlyRate: s.hourlyRate,
          fixedBasic: s.fixedBasic ?? null, notes: s.notes, sortOrder: s.sortOrder,
        },
      });
    }
    added += 1;
  }
  console.log(`\n  ${added} scheme(s) written, ${left} left untouched\n`);

  /* ---- 2 · who is on which ---- */
  if (!packAt) {
    console.log('  No payslip pack found, so no doctor was assigned. Pass --pack <file>.\n');
    await prisma.$disconnect();
    return;
  }

  const D = readPack(packAt);
  console.log(`  reading ${path.basename(packAt)} — ${D.people.length} people, ${D.period.label}\n`);

  /* On a DRY RUN the schemes have not been written, so looking them up in the
     database reports every single person as unassignable — a preview that is
     false every time is a preview nobody runs. Resolve against SEED instead
     when nothing is being saved. */
  const schemeRows = await prisma.commissionScheme.findMany({ select: { id: true, name: true } });
  const schemeId = new Map(schemeRows.map((s) => [s.name.toLowerCase(), s.id]));
  if (!WRITE) {
    for (const s of Schemes.SEED) {
      if (!schemeId.has(s.name.toLowerCase())) schemeId.set(s.name.toLowerCase(), -1);
    }
  }
  const already = new Set((await prisma.doctorScheme.findMany({ select: { doctorName: true } }))
    .map((d) => d.doctorName));

  const unknown = new Map();
  const overrides = [];
  let assigned = 0;
  let kept = 0;

  for (const p of D.people) {
    const id = schemeId.get(String(p.scheme || '').trim().toLowerCase());
    if (!id) {
      unknown.set(p.scheme, (unknown.get(p.scheme) || 0) + 1);
      continue;
    }
    if (already.has(p.name) && !FORCE) { kept += 1; continue; }

    /* WHERE THE PACK'S OWN RATE DISAGREES WITH THE BAND, the pack wins and the
       disagreement is recorded as an override rather than smoothed away. Our
       bands reproduce 65 of 73 exactly; the other eight are real agreements —
       Noura Maged's 35% is written in the workbook, Ghada Amer was paid 17% on
       revenue the workbook leaves with no band at all. Storing the difference
       is what makes those eight answerable instead of just wrong. */
    const band = Schemes.rateFor(Schemes.SEED.find((x) => x.name.toLowerCase()
      === String(p.scheme || '').trim().toLowerCase()) || {}, p.rev);
    const differs = band.rate == null || Math.abs(band.rate - p.rate) > 0.0001;
    const why = band.rate == null
      ? `The scheme gives no rate here — ${band.why} The pack paid ${(p.rate * 100).toFixed(2)}%.`
      : `Scheme band is ${(band.rate * 100).toFixed(2)}%; ${(p.rate * 100).toFixed(2)}% was agreed for this person.`;
    if (differs) overrides.push(`${p.name} → ${(p.rate * 100).toFixed(2)}%`);

    if (WRITE) {
      await prisma.doctorScheme.upsert({
        where: { doctorName: p.name },
        update: FORCE ? {
          schemeId: id, mgmtFee: p.mgmt || null, taxRate: p.tax_rate || null,
          payMethod: p.pay || null, bankAcc: p.acc || null, bankName: p.acc_name || null,
          /* The override belongs on BOTH paths. It was on `create` only, so a
             `--force` re-run updated everything except the eight rates that are
             the whole reason the field exists — and reported them as written. */
          rateOverride: differs ? p.rate : null,
          rateOverrideWhy: differs ? why : null,
        } : {},
        create: {
          doctorName: p.name,
          schemeId: id,
          mgmtFee: p.mgmt || null,
          taxRate: p.tax_rate || null,
          payMethod: p.pay || null,
          /* The bank account travels because the pack already holds it and the
             payslip needs it. It is not derived from anything and will not be
             re-derived — an edit in Admin stands. */
          bankAcc: p.acc || null,
          bankName: p.acc_name || null,
          rateOverride: differs ? p.rate : null,
          rateOverrideWhy: differs ? why : null,
        },
      });
    }
    assigned += 1;
  }

  console.log(`  ${assigned} doctor(s) assigned, ${kept} already had one and were left alone`);
  if (overrides.length) {
    console.log(`\n  ${overrides.length} carry a rate the scheme band does not give, recorded as overrides:`);
    for (const o of overrides) console.log(`    ${o}`);
  }
  if (unknown.size) {
    console.log(`\n  SCHEMES NAMED IN THE PACK THAT DO NOT EXIST HERE — those people are unassigned:`);
    for (const [name, count] of unknown) console.log(`    "${name}" — ${count} people`);
  }

  /* ---- 3 · the management fees the workbook lists, for anyone the pack missed ---- */
  let fees = 0;
  for (const f of Schemes.MGMT_FEES) {
    const row = await prisma.doctorScheme.findFirst({
      where: { doctorName: { contains: f.doctorName, mode: 'insensitive' } },
    });
    if (!row) {
      /* Silent on a dry run: nobody is assigned yet BY DESIGN, so reporting
         four orphaned fees every time is noise, not a finding. */
      if (WRITE) console.log(`  · management fee for "${f.doctorName}" has nobody to attach to`);
      continue;
    }
    if (row.mgmtFee != null && !FORCE) continue;
    if (WRITE) {
      await prisma.doctorScheme.update({ where: { id: row.id }, data: { mgmtFee: f.mgmtFee } });
    }
    fees += 1;
  }
  if (fees) console.log(`  ${fees} management fee(s) set from the workbook`);

  if (!WRITE) console.log('\n  Nothing was saved. Re-run with --write.');
  console.log('');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('\n✗', e.message, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
