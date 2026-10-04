#!/usr/bin/env node
/* Seed the 2027 plan, the v3.2 commission policy and the 2024–25 history from
 * the Targets Q4 2026 – 2027 dashboard.
 *
 *   node scripts/import-targets-html.js "~/Downloads/Targets Q4 2026 – 2027 · Nouvelage.html"
 *   node scripts/import-targets-html.js --write <file>
 *   node scripts/import-targets-html.js --write --force <file>
 *
 * Dry run by default. Nothing is written without `--write`.
 *
 * WHY THIS IS AN IMPORT AND NOT A FIXTURE. Three of the four things it carries
 * exist nowhere else: the 2026-10 → 2027-12 branch and doctor targets are a
 * decision somebody made in a spreadsheet, the v3.2 pool grid is a policy
 * nobody has typed into this database, and 2024–25 monthly actuals predate the
 * Odoo sync by two years. Copying them into a JS literal would work once and
 * rot silently; reading them out of the file means the seed is reproducible and
 * the moment a real export arrives it lands in the same tables.
 *
 * IT SEEDS, IT DOES NOT OVERWRITE. Every write is `ON CONFLICT DO NOTHING` in
 * spirit — a row that already exists is left exactly as whoever edited it in
 * Admin left it. Re-seeding on purpose is `--force`, a different and deliberate
 * act. This matters more here than usual: the whole point of Phase 3 is that
 * these figures become editable, and an importer that reasserts the file every
 * time would make the editor a lie.
 *
 * IT PRINTS CONTRADICTIONS AND REFUSES TO PICK QUIETLY. The file disagrees with
 * itself and with Odoo in several measurable places; each one is reported with
 * both numbers rather than resolved by this script.
 */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const fs = require('fs');
const { prisma } = require('../src/lib/db.js');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
/* `--only 2026-10,2026-11,2026-12` scopes a --force rewrite to named months.
   Without it, --force reasserts the file over every cell including 2027 and the
   policy — which is a much bigger act than "the Q4 plan was revised", and not
   one anybody should perform by accident while doing the smaller one. */
const ONLY_AT = args.indexOf('--only');
const ONLY = ONLY_AT >= 0 && args[ONLY_AT + 1]
  ? new Set(args[ONLY_AT + 1].split(',').map((x) => x.trim())) : null;
/* The value after `--only` is that flag's argument, not the filename. Matching
   it against the parsed Set instead of its position read "2026-10,2026-11" as a
   path and refused to start. */
const FILE = args.find((a, i) => !a.startsWith('--') && i !== ONLY_AT + 1)
  || `${process.env.HOME}/Downloads/Targets Q4 2026 – 2027 · Nouvelage.html`;

const f = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const problems = [];
const note = (msg) => problems.push(msg);

/**
 * Pull the `const NAME = {...}` literals off the data line.
 *
 * The file puts `const D={...};const TGT={...};` on ONE line of 585 KB, so a
 * line-based read gets both at once and a greedy regex gets neither. Split on
 * the declarations themselves and bracket-match each.
 */
function constants(src) {
  const out = {};
  const re = /const\s+([A-Z_$][\w$]*)\s*=\s*([[{])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === '[' || c === '{') depth += 1;
      else if (c === ']' || c === '}') {
        depth -= 1;
        if (depth === 0) {
          try { out[m[1]] = JSON.parse(src.slice(start, i + 1)); } catch { /* not data */ }
          break;
        }
      }
    }
  }
  return out;
}

(async () => {
  console.log(`\n${WRITE ? 'WRITING' : 'DRY RUN — nothing is saved'}${FORCE ? ' · FORCE' : ''}\n`);
  if (!fs.existsSync(FILE)) throw new Error(`No such file: ${FILE}`);
  const src = fs.readFileSync(FILE, 'utf8');
  const C = constants(src);
  for (const need of ['D', 'TGT', 'POLICY_DEFAULT']) {
    if (!C[need]) throw new Error(`\`const ${need}\` is not in that file — is it the right dashboard?`);
  }
  const { D, TGT, POLICY_DEFAULT: P } = C;
  /* `sections` is a LIST of {id, tables:[{id, cols, rows}]}, not an object
     keyed by id — reaching for `P.branch.levels` gets undefined and the whole
     policy silently imports as nothing. */
  const sect = (id) => (P.sections || []).find((x) => x.id === id) || { tables: [] };
  const table = (sid, tid) => (sect(sid).tables || []).find((t) => t.id === tid) || { cols: [], rows: [] };
  console.log(`  read ${FILE.split('/').pop()}`);
  console.log(`    ${TGT.branches.length} branches · ${TGT.doctors.length} doctors · policy ${P.version}\n`);

  /* ---- 1 · branch targets, into the table that already holds 2026 ---- */
  const branches = await prisma.commissionBranch.findMany({ select: { id: true, name: true } });
  const aliases = await prisma.identityAlias.findMany({ where: { kind: 'branch' } });

  /* RESOLVE THROUGH ODOO FROM BOTH SIDES, and this is the part that is easy to
     get backwards. `CommissionBranch.name` is a SCHEDULE name ("CampShizar",
     "MOA", "Zaied") — the same vocabulary as `IdentityAlias.scheduleName`, not
     Odoo's. The plan file uses a third spelling again ("Alex Camp Chizar",
     "Mall of Arabia", "Zayed"). So neither side can be looked up in the other
     directly; both are pushed through the alias table to the Odoo name and
     matched there, case-insensitively — "MOA" resolves to "Mall Of Arabia" and
     the plan says "Mall of Arabia".

     Resolving one side only reported nine of twelve branches as unknown,
     including three that have been in this database since August. */
  const alias = new Map(aliases.map((a) => [a.scheduleName.trim().toLowerCase(), a.odooName]));
  const odooOf = (n) => String(alias.get(String(n).trim().toLowerCase()) || n).trim().toLowerCase();
  const byOdoo = new Map(branches.map((b) => [odooOf(b.name), b.id]));
  const resolve = (n) => byOdoo.get(odooOf(n)) || null;

  const existing = new Set((await prisma.commissionTarget.findMany({ select: { branchId: true, year: true, month: true } }))
    .map((t) => `${t.branchId}:${t.year}:${t.month}`));

  const cells = [];
  const unresolved = new Map();
  for (const row of TGT.branches) {
    const id = resolve(row.branch);
    if (!id) {
      unresolved.set(row.branch, Object.values(row.m).reduce((a, b) => a + (+b || 0), 0));
      continue;
    }
    for (const [period, v] of Object.entries(row.m)) {
      if (ONLY && !ONLY.has(period)) continue;
      /* A ZERO IN THE FILE IS "NOT OPEN YET", NOT A TARGET OF NOTHING.
         Golden Square opens in April 2027 and the plan carries explicit 0s for
         the seven months before it — importing those as rows put four cells of
         zero into 2026 for a branch that does not exist yet, and a stored zero
         is a branch measured against nothing rather than a branch not measured.
         The report colours the two differently and the Admin grid leaves a
         blank cell blank, so the distinction has to survive the import. */
      if (!Number(v)) continue;
      const [y, mo] = period.split('-').map(Number);
      const key = `${id}:${y}:${mo}`;
      if (existing.has(key) && !FORCE) continue;
      cells.push({ branchId: id, year: y, month: mo, target: Number(v) });
    }
  }
  const years = [...new Set(cells.map((c) => c.year))].sort();
  console.log(`  BRANCH TARGETS  ${cells.length} new cell(s) across ${years.join(', ') || '—'}`);
  console.log(`                  ${existing.size} already stored and left exactly as they are`);
  if (unresolved.size) {
    note(`${unresolved.size} branch name(s) in the plan match no branch in Odoo`);
    console.log('\n    THESE BRANCHES RESOLVE TO NOTHING — their targets are not imported:');
    for (const [n, total] of [...unresolved].sort((a, b) => b[1] - a[1])) {
      console.log(`      "${n}" — ${f(total)} of plan over the file's months`);
    }
    console.log('    Add an alias in Admin → Mapping, or a branch, and re-run.');
  }

  /* ---- 2 · doctor targets ---- */
  const haveDoc = new Set((await prisma.doctorPlanMonth.findMany({ select: { doctorName: true, period: true } }))
    .map((d) => `${d.doctorName}:${d.period}`));
  const docRows = [];
  for (const row of TGT.doctors) {
    for (const [period, v] of Object.entries(row.m)) {
      if (ONLY && !ONLY.has(period)) continue;
      if (!Number(v)) continue;          // see the branch loop — 0 means "no target set"
      if (haveDoc.has(`${row.name}:${period}`) && !FORCE) continue;
      docRows.push({ doctorName: row.name, period, groupName: row.group || null, target: Number(v) });
    }
  }
  const docPeriods = [...new Set(docRows.map((r) => r.period))].sort();
  console.log(`\n  DOCTOR TARGETS  ${docRows.length} new row(s) · ${TGT.doctors.length} doctors`
    + `${docPeriods.length ? ` · ${docPeriods[0]} → ${docPeriods[docPeriods.length - 1]}` : ''}`);
  console.log(`                  ${haveDoc.size} already stored and left alone`);

  /* A doctor on the plan who matches nothing in Odoo earns a target nobody can
     be measured against. Named here rather than discovered next quarter. */
  const billed = new Set((await prisma.invoice.groupBy({
    by: ['specialistName'], where: { moveType: 'out_invoice', specialistName: { not: null } },
  })).map((b) => String(b.specialistName).trim().toLowerCase()));
  const schemed = new Set((await prisma.doctorScheme.findMany({ select: { doctorName: true } }))
    .map((d) => d.doctorName.trim().toLowerCase()));
  const ghosts = TGT.doctors
    .map((d) => d.name)
    .filter((n) => !billed.has(n.trim().toLowerCase()) && !schemed.has(n.trim().toLowerCase()));
  if (ghosts.length) {
    note(`${ghosts.length} doctor(s) on the plan match no invoice and no scheme`);
    console.log(`\n    ON THE PLAN, UNKNOWN TO ODOO AND TO THE SCHEMES — ${ghosts.length}:`);
    for (const n of ghosts.slice(0, 12)) console.log(`      ${n}`);
    if (ghosts.length > 12) console.log(`      …and ${ghosts.length - 12} more`);
  }

  /* ---- 3 · the v3.2 policy: levels and the pool grid ---- */
  const VERSION = P.version || 'v3.2';
  const levelRows = (table('branch', 'levels').rows || []).map((r) => ({
    version: VERSION, level: Math.round(Number(String(r[0]).replace(/[^\d.]/g, ''))),
    fromPct: Number(r[1]) / 100,
  })).filter((r) => Number.isFinite(r.level) && Number.isFinite(r.fromPct));

  const poolRows = (table('branch', 'pool').rows || []).map((r, i) => ({
    version: VERSION,
    tierNo: i + 1,
    revFrom: Number(String(r[1]).replace(/[^\d.]/g, '')) || 0,
    revTo: String(r[2]).trim() === '' || /above/i.test(String(r[2])) ? null
      : Number(String(r[2]).replace(/[^\d.]/g, '')),
    pools: r.slice(3).map((v) => Number(String(v).replace(/[^\d.]/g, '')) || 0),
  }));
  console.log(`\n  POLICY ${VERSION}      ${levelRows.length} achievement level(s) · ${poolRows.length} revenue tier(s)`);
  if (levelRows.length && poolRows.length) {
    const widths = [...new Set(poolRows.map((p) => p.pools.length))];
    if (widths.length !== 1 || widths[0] !== levelRows.length) {
      note(`the pool grid is ${widths.join('/')} wide but there are ${levelRows.length} levels`);
      console.log(`    THE GRID DOES NOT MATCH THE LEVELS: rows are ${widths.join('/')} wide,`);
      console.log(`    and there are ${levelRows.length} levels. A pool would be read from the wrong column.`);
    }
    console.log(`                  ${levelRows.map((l) => `${l.level}%@${(l.fromPct * 100).toFixed(0)}`).join(' · ')}`);
    const top = poolRows[poolRows.length - 1];
    console.log(`                  tier 1 from ${f(poolRows[0].revFrom)} → pools ${poolRows[0].pools.map(f).join(' / ')}`);
    console.log(`                  tier ${top.tierNo} from ${f(top.revFrom)} → pools ${top.pools.map(f).join(' / ')}`);
  }

  /* The role weights v3.2 splits by. Their own rows, not columns on
     `CommissionRole`: that table is five SEATS summing to 100%, this is four
     ROLE TYPES with a headcount each — seven people including a nurse role the
     v2.8 seats do not have. Three of the four names match no seat. */
  const roleRows = (table('branch', 'roles').rows || []).map((r, i) => ({
    version: VERSION,
    role: String(r[0]).trim(),
    people: Math.round(Number(r[1])) || 0,
    weight: Number(r[2]) || 0,
    notes: String(r[3] || '').trim() || null,
    sortOrder: i + 1,
  })).filter((r) => r.role);
  const haveRoles = new Set((await prisma.commissionRoleWeight.findMany({ where: { version: VERSION }, select: { role: true } }))
    .map((r) => r.role));
  const W = roleRows.reduce((a, r) => a + r.people * r.weight, 0);
  console.log(`\n  ROLE WEIGHTS    ${roleRows.length} role type(s) · ${roleRows.reduce((a, r) => a + r.people, 0)} people`);
  for (const r of roleRows) {
    const share = W ? (r.weight / W) : 0;
    console.log(`                  ${r.role.padEnd(24)} ${String(r.people).padStart(2)} x ${String(r.weight).padStart(4)}`
      + `  → ${(share * 100).toFixed(1)}% of the pool each${haveRoles.has(r.role) ? '  (already stored)' : ''}`);
  }
  if (W) console.log(`                  total weight ${W}`);
  /* The shares must account for the whole pool, or a branch pays out more or
     less than it earned and nobody notices until payroll. */
  const covered = roleRows.reduce((a, r) => a + r.people * r.weight, 0) / (W || 1);
  if (Math.abs(covered - 1) > 0.0001) {
    note(`the role weights account for ${(covered * 100).toFixed(1)}% of a pool, not 100%`);
  }

  /* ---- 4 · 2024–25 history ---- */
  const CUTOFF = '2026-01';
  const hist = [];
  const add = (kind, bag) => {
    for (const [period, byName2] of Object.entries(bag || {})) {
      if (period >= CUTOFF) continue;          // 2026 onward is derived, never stored
      for (const [name, ex] of Object.entries(byName2)) {
        hist.push({ period, kind, name, ex: Number(ex) || 0, source: 'seed' });
      }
    }
  };
  add('branch', D.act); add('group', D.actg); add('product', D.actp);
  const haveHist = await prisma.historyMonth.count();
  const histPeriods = [...new Set(hist.map((h) => h.period))].sort();
  console.log(`\n  HISTORY         ${hist.length} row(s) · ${histPeriods[0] || '—'} → ${histPeriods[histPeriods.length - 1] || '—'}`);
  console.log(`                  everything from ${CUTOFF} on is DERIVED from Odoo and not stored`);
  console.log(`                  ${haveHist} row(s) already stored`);

  /* The one cross-check worth making: where the file's history and the Odoo
     cache overlap they must agree, or one of the two is wrong about a year. */
  const overlap = Object.keys(D.act || {}).filter((p) => p >= CUTOFF);
  if (overlap.length) {
    const rows = await prisma.$queryRawUnsafe(
      `select to_char("invoiceDate", 'YYYY-MM') m, round(sum("amountUntaxed")::numeric)::bigint ex
         from "Invoice" where "moveType" = 'out_invoice' group by 1`,
    );
    const odoo = new Map(rows.map((r) => [r.m, Number(r.ex)]));
    const bad = [];
    for (const p of overlap) {
      const file = Object.values(D.act[p]).reduce((a, b) => a + (+b || 0), 0);
      const live = odoo.get(p);
      if (live == null) continue;
      const gap = Math.abs(file - live) / (live || 1);
      if (gap > 0.05) bad.push(`${p}: file ${f(file)} vs Odoo ${f(live)} (${(gap * 100).toFixed(1)}%)`);
    }
    console.log(`\n  OVERLAP CHECK   ${overlap.length} month(s) exist in both the file and Odoo`);
    if (bad.length) {
      note(`${bad.length} overlapping month(s) differ by more than 5%`);
      console.log('    THESE DISAGREE — the file is a snapshot and Odoo has moved since:');
      for (const b of bad) console.log(`      ${b}`);
      console.log('    Not imported either way: 2026 is derived live. Shown so the gap is known.');
    } else {
      console.log('                  all within 5% — the file and the cache tell the same story');
    }
  }

  /* ---- write ---- */
  if (!WRITE) {
    console.log(`\n  ${problems.length ? `${problems.length} thing(s) to look at:` : 'Nothing contradictory found.'}`);
    for (const p of problems) console.log(`    · ${p}`);
    console.log('\n  Nothing was saved. Re-run with --write.\n');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const c of cells) {
      await tx.commissionTarget.upsert({
        where: { branchId_year_month: { branchId: c.branchId, year: c.year, month: c.month } },
        update: FORCE ? { target: c.target } : {},
        create: c,
      });
    }
    for (const d of docRows) {
      await tx.doctorPlanMonth.upsert({
        where: { doctorName_period: { doctorName: d.doctorName, period: d.period } },
        update: FORCE ? { target: d.target, groupName: d.groupName } : {},
        create: d,
      });
    }
    for (const l of levelRows) {
      await tx.commissionLevel.upsert({
        where: { version_level: { version: l.version, level: l.level } },
        update: FORCE ? { fromPct: l.fromPct } : {},
        create: l,
      });
    }
    for (const p of poolRows) {
      await tx.commissionPool.upsert({
        where: { version_tierNo: { version: p.version, tierNo: p.tierNo } },
        update: FORCE ? { revFrom: p.revFrom, revTo: p.revTo, pools: p.pools } : {},
        create: p,
      });
    }
    for (const r of roleRows) {
      await tx.commissionRoleWeight.upsert({
        where: { version_role: { version: r.version, role: r.role } },
        update: FORCE ? { people: r.people, weight: r.weight, notes: r.notes, sortOrder: r.sortOrder } : {},
        create: r,
      });
    }
    for (const h of hist) {
      await tx.historyMonth.upsert({
        where: { period_kind_name: { period: h.period, kind: h.kind, name: h.name } },
        update: FORCE ? { ex: h.ex } : {},
        create: h,
      });
    }
  }, { timeout: 120000 });

  console.log('\n  written:');
  console.log(`    CommissionTarget  ${await prisma.commissionTarget.count()}`);
  console.log(`    DoctorPlanMonth   ${await prisma.doctorPlanMonth.count()}`);
  console.log(`    CommissionLevel   ${await prisma.commissionLevel.count()}`);
  console.log(`    CommissionPool    ${await prisma.commissionPool.count()}`);
  console.log(`    HistoryMonth      ${await prisma.historyMonth.count()}`);
  if (problems.length) {
    console.log(`\n  ${problems.length} thing(s) still to look at:`);
    for (const p of problems) console.log(`    · ${p}`);
  }
  console.log('');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('\n✗', e.message, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
