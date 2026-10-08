#!/usr/bin/env node
/**
 * Build dist/nrs-delta.sql — the rows the droplet cannot produce for itself.
 *
 *   node deploy/make-delta.js
 *
 * WHY A DELTA AND NOT nrs-data.sql
 *
 * upgrade.sh loads nrs-data.sql only into EMPTY tables, guarded on Supplier
 * having no rows. That guard is right — it stops a re-run duplicating finance
 * data — but the droplet already has 155 suppliers, so the file is skipped
 * entirely and anything new inside it would never arrive. This delta is the
 * opposite: small, idempotent, and always run.
 *
 * IT SEEDS, IT DOES NOT OVERWRITE.
 *
 * The first version of this file DELETEd the commission tables and re-inserted
 * them. That was fine while the tab was read-only and became destructive the
 * moment the editor worked: on 2026-09-01 Mina saved a mid band of 0.95 through
 * /admin, and a re-deploy would have silently put it back to 0.90. Every insert
 * below now ends in ON CONFLICT DO NOTHING, so a row that already exists is left
 * exactly as the person editing it left it, and only genuinely new rows land.
 *
 * Re-seeding from the workbook on purpose is a different, deliberate action:
 *   node scripts/import-commission-xlsx.js <file.xlsx> --write
 *
 * WHAT IT CARRIES, and nothing else
 *   · the 13 Commission tables — inserted if absent, never modified if present
 *   · the branch aliases the commission branch names need to reach Odoo
 *   · the collections source mode, moved to `odoo` ONLY if still on `snapshot`
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *   Supplier · Bill · BillLine · VendorPayment · Collection · CollectionDay ·
 *   ReconProduct · ReconFact · ExpiryLot · Invoice · InvoiceLine · StockQuant ·
 *   DaySnapshot · Session · TargetPeriod and the doctor/branch targets.
 *   The droplet's Collection rows come from its OWN Odoo sync — shipping mine
 *   would overwrite its history with a copy of my laptop's.
 */

const fs = require('fs');
const path = require('path');
const { prisma } = require('../src/lib/db.js');

const OUT = path.join(__dirname, '..', 'dist', 'nrs-delta.sql');

/* Ordered parent-first for inserts; deletes run in reverse. */
const TABLES = [
  'CommissionPolicy', 'CommissionBranch', 'CommissionDepartment',
  'CommissionTarget', 'CommissionSplit',
  'CommissionTier', 'CommissionRole',
  'CallCenterRate', 'CallCenterMember', 'ShowRateBand',
  'ManagementGate', 'CommissionRule', 'CommissionNote',
  /* Added 2026-09-03 with the table itself. Leaving it out shipped a droplet that
     had the table and no rows, and `policyFor` then falls back to the published
     defaults — floor 0.80, which is v2.7. The policy in force is v2.8 at 0.90, so
     the live commission report was scoring eligibility ten points too low and
     qualifying branches that had not. A new table in the schema has to be added
     here in the same change, or the delta silently ships an empty one. */
  'CommissionPolicyVersion',
  /* Added 2026-09-23 with the doctor commission report. A DIFFERENT commission
     from the twelve tables above — those pay a BRANCH on cash collected against
     a monthly target, these pay a DOCTOR a share of what they invoiced — but
     they belong in this file for exactly the same reason: the droplet cannot
     produce one row of them. The schemes were transcribed from a workbook and
     the 73 assignments read out of a payslip pack, neither of which exists on
     the server.

     CommissionScheme FIRST, because DoctorScheme.schemeId is a foreign key to
     it and the ids inserted here are this laptop's. ON CONFLICT DO NOTHING, as
     everywhere in this file, so a rate somebody edits in Admin on the droplet
     survives every later deploy.

     DoctorPayrollMonth travels too, and it is the one that would be easy to
     leave out: hours, deductions and withholding are uploaded by hand, so
     August exists on this Mac and nowhere else. Without it the live report
     would show the commission and state plainly that no payslip is available —
     correct, and not what anybody wants to open the tab and find. */
  'CommissionScheme', 'DoctorScheme', 'DoctorPayrollMonth',
  /* Added 2026-10-04 with the Targets & Plan port and Commission v3.2. The
     droplet cannot produce one row of these: the 2027 plan, the 2024–25 history
     and the v3.2 levels, pool grid and role weights were all transcribed from
     files that exist only on this Mac. CommissionStaff is empty today and is
     listed so the first names entered here travel with the next deploy. */
  'CommissionLevel', 'CommissionPool', 'CommissionRoleWeight', 'CommissionStaff',
  'DoctorPlanMonth', 'HistoryMonth',
  /* And Contact Centre v2: the frozen October snapshot and the phone
     extension map. Seeded from `Contact Centre · Nouvelage.html`, which is not
     on the server. PbxCall is NOT here — the weekly UCM upload fills it on the
     droplet itself, and shipping this Mac's (empty) table would carry nothing. */
  /* NOT CcOpportunity, CcAppointment, CcLead, CcActivity or CcRebooking —
     removed 2026-10-07 after a rehearsal caught the next deploy DOUBLING every
     one of them on the live site. Their only key is an autoincrement id, and a
     re-seed hands out new ids (2,956 upward instead of 1 upward), so
     ON CONFLICT DO NOTHING saw nothing to conflict with and added a second
     copy of the whole snapshot. The droplet has carried this frozen snapshot
     since 2026-10-04; there is nothing new to send. A future re-seed is a
     deliberate act and runs ON the droplet, with the seeder:
       node scripts/import-contact-centre-html.js <file.html>
     The three left here are keyed by name, so they cannot double. */
  'CcLookup', 'CcEmployee', 'PbxExtension',
];
/* Tables whose id is a serial and therefore needs its sequence moved on. */
const SEQS = [
  'CommissionBranch', 'CommissionDepartment', 'CommissionTarget', 'CommissionSplit',
  'CommissionRole', 'CallCenterRate', 'CallCenterMember', 'ShowRateBand',
  'ManagementGate', 'CommissionRule', 'CommissionNote',
  /* The three doctor-commission tables. Without a setval here the droplet's
     next new scheme would be handed id 1, which is already taken. */
  'CommissionScheme', 'DoctorScheme', 'DoctorPayrollMonth',
  /* The 2026-10-04 additions. Any without an integer id is skipped by
     hasSerialId() below, so listing one too many cannot break the file. */
  'CommissionLevel', 'CommissionPool', 'CommissionRoleWeight', 'CommissionStaff',
  'DoctorPlanMonth', 'HistoryMonth',
  'CcLookup', 'CcEmployee', 'PbxExtension',
];

/* A Postgres ARRAY column (CcEmployee.allowedIds is int[]). The JSON branch
   below would write '[1,2]', which Postgres rejects for an array — it wants
   '{1,2}'. Decided by the column's real type, read from the database, so a Json
   column holding an array (CommissionScheme.bands) still goes out as JSON. */
const arrLit = (v) => `'{${v.map((x) => (typeof x === 'number' ? String(x)
  : `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',').replace(/'/g, "''")}}'`;

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object' && typeof v.toFixed === 'function') return `'${v.toString()}'`; // Prisma Decimal
  /* A JSON COLUMN, and the reason this branch exists at all: `String([{...}])`
     is "[object Object]", which Postgres rejects as json — loudly, which is the
     only good thing about it. CommissionScheme.bands is the first Json column
     to travel in this file. The literal is left untyped so Postgres casts it to
     whatever the column actually is, json or jsonb. */
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

(async () => {
  const out = [];
  out.push('-- Nouvelage commission delta. Idempotent: safe to run as often as you like.');
  out.push('-- Replaces the 13 Commission tables, upserts branch aliases, points');
  out.push('-- collections at Odoo. Touches nothing else.');
  out.push('BEGIN;');
  out.push('');

  /* Column order comes from the database itself, so a schema change cannot leave
     this file quietly writing values into the wrong columns. */
  const arrayCols = {};
  const colsOf = async (table) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1
        ORDER BY ordinal_position`, table);
    arrayCols[table] = new Set(rows.filter((r) => r.data_type === 'ARRAY').map((r) => r.column_name));
    return rows.map((r) => r.column_name);
  };

  out.push('-- NO deletes: this file seeds, it never overwrites an edit');
  out.push('');

  let total = 0;
  /* Remembered so the sequence step can tell which tables actually have an
     integer id, rather than trusting a hand-kept list. */
  const colsSeen = {};
  for (const t of TABLES) {
    const cols = await colsOf(t);
    colsSeen[t] = cols;
    const rows = await prisma.$queryRawUnsafe(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}" ORDER BY 1`);
    if (!rows.length) { out.push(`-- ${t}: no rows`); out.push(''); continue; }
    total += rows.length;
    out.push(`-- ${t}: ${rows.length} rows`);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      out.push(`INSERT INTO "${t}" (${colList}) VALUES`);
      /* No conflict target: ON CONFLICT DO NOTHING with none given ignores ANY
         unique violation, which is what we want across thirteen tables whose
         natural keys differ (key, name, tierNo, branchId+year+month, kind+ref). */
      const val = (c, v) => (arrayCols[t].has(c) && Array.isArray(v) ? arrLit(v) : lit(v));
      out.push(chunk.map((r) => `  (${cols.map((c) => val(c, r[c])).join(', ')})`).join(',\n')
        + '\nON CONFLICT DO NOTHING;');
    }
    out.push('');
  }

  out.push('-- move the id sequences past the rows just inserted');
  /* Only tables that actually HAVE an integer `id` get a setval. SEQS was a
     hand-kept list, and the first table added to it without one —
     CommissionPolicyVersion, whose primary key is the version string — made the
     whole delta abort on `column "id" does not exist`. Deriving it from the rows
     that were just read means the list cannot disagree with the schema again. */
  const hasSerialId = (t) => (colsSeen[t] || []).includes('id');
  const seqTables = SEQS.filter((t) => {
    if (hasSerialId(t)) return true;
    console.log(`  – ${t} has no integer id, so no sequence to move`);
    return false;
  });
  for (const t of seqTables) {
    /* GREATEST so a droplet that has added rows of its own keeps its higher
       sequence — moving it backwards would hand out ids that are already taken.
     *
     * THIS RAN AND DID NOTHING FOR THREE DEPLOYS. The old version looked the
     * sequence up in `pg_sequences` by `split_part(pg_get_serial_sequence(...),
     * '.', 2)`, which yields `"CommissionScheme_id_seq"` WITH the quotes, while
     * `pg_sequences.sequencename` holds it without them. The join matched
     * nothing, the statement returned zero rows, and `psql -q` printed nothing
     * — so every sequence stayed at 1 while explicit ids were inserted above
     * it. Nobody noticed because nothing on the droplet had added a row to
     * these tables yet; the first "Add the scheme" or "Add a department" would
     * have failed on a duplicate key.
     *
     * `pg_sequence_last_value` takes the sequence as a regclass, so there is no
     * name to re-quote and nothing to get wrong. Verified: it returns the new
     * value rather than an empty result. */
    out.push(`SELECT setval(s::regclass,`
      + ` GREATEST(COALESCE((SELECT MAX(id) FROM "${t}"), 1),`
      + ` COALESCE(pg_sequence_last_value(s::regclass), 1)), true)`
      + ` FROM pg_get_serial_sequence('"${t}"', 'id') AS s;`);
  }
  out.push('');

  /* The Contact Centre snapshot's provenance row. The report reads its snapshot
     time and its GAP notes from here — without it the page cannot say what the
     export does not carry. Inserted WITHOUT an id (the droplet has its own
     DataUpload history and ids), and only if no cc:seed row exists yet, so a
     re-run never adds a second one. */
  const ccSeed = await prisma.dataUpload.findFirst({ where: { kind: 'cc:seed' }, orderBy: { createdAt: 'desc' } });
  if (ccSeed) {
    out.push('-- the Contact Centre snapshot record, once');
    out.push(`INSERT INTO "DataUpload" ("kind", "filename", "rangeFrom", "rangeTo", "rowsWritten", "notes", "actor", "createdAt")`
      + ` SELECT ${lit(ccSeed.kind)}, ${lit(ccSeed.filename)}, ${lit(ccSeed.rangeFrom)}, ${lit(ccSeed.rangeTo)},`
      + ` ${lit(ccSeed.rowsWritten)}, ${lit(ccSeed.notes)}, ${lit(ccSeed.actor)}, ${lit(ccSeed.createdAt)}`
      + ` WHERE NOT EXISTS (SELECT 1 FROM "DataUpload" WHERE "kind" = 'cc:seed');`);
    out.push('');
  }

  /* Branch aliases: the commission workbook spells branches differently from
     Odoo (CityStars vs City Stars, Zaied vs Zayed, MOA vs Mall Of Arabia).
     Upserted, never deleted — the droplet may hold aliases this laptop does not. */
  const aliases = await prisma.identityAlias.findMany({ where: { kind: 'branch' }, orderBy: { scheduleName: 'asc' } });
  out.push(`-- ${aliases.length} branch aliases, upserted so existing ones are kept`);
  for (const a of aliases) {
    out.push(`INSERT INTO "IdentityAlias" ("kind", "scheduleName", "odooName", "odooId")`
      + ` VALUES (${lit(a.kind)}, ${lit(a.scheduleName)}, ${lit(a.odooName)}, ${lit(a.odooId)})`
      + ` ON CONFLICT ("kind", "scheduleName") DO NOTHING;`);
  }
  out.push('');

  /* The Sales overview reads net collections through this. Left on `snapshot` the
     card would show the frozen 11-August import — 12.3% short and falling
     further behind every day. */
  out.push('-- point collections at the live Odoo sync');
  /* Only if it is still on `snapshot`, the pre-feature default. Somebody who has
     deliberately switched back should not be overridden by a deploy. */
  out.push(`INSERT INTO "FinanceSource" ("section", "mode", "cutover", "updatedAt")`
    + ` VALUES ('collections', 'odoo', NULL, NOW())`
    + ` ON CONFLICT ("section") DO UPDATE SET "mode" = 'odoo', "cutover" = NULL, "updatedAt" = NOW()`
    + ` WHERE "FinanceSource"."mode" = 'snapshot';`);
  out.push('');
  out.push('COMMIT;');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.join('\n') + '\n');
  console.log(`  ${total} commission rows · ${aliases.length} branch aliases · 1 source switch`);
  console.log(`  → ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('✗', e.message); await prisma.$disconnect().catch(() => {}); process.exit(1); });
