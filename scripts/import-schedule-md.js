#!/usr/bin/env node
/**
 * Import an Approved Target Schedule from the markdown the schedule is issued in.
 *
 *   node scripts/import-schedule-md.js <file.md>            # show what would change
 *   node scripts/import-schedule-md.js <file.md> --write    # publish it
 *
 * The document states its own arithmetic — a subtotal per group, a doctor count
 * per group, and a grand total with a roster count — so nothing here is trusted
 * on faith. Every figure parsed is checked against the figure the document
 * declares, and a single disagreement refuses the whole import. That is the same
 * rule `PUT /api/targets/:period` applies, for the same reason: the previous
 * report claimed 73 doctors and 28,838,391 while showing 52 rows summing to
 * 26,627,883, and nothing caught it.
 *
 * Branch targets are not in this document, so the ones already published for the
 * period are carried forward rather than dropped. Aliases live in their own
 * table and are untouched.
 */

const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from systemd */ }

const { prisma, num } = require('../src/lib/db.js');
const { normName } = require('../src/lib/rules.js');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const money = (s) => {
  const t = String(s).replace(/\*|,|\s|\+/g, '');
  if (!t || t === '—' || t === '-' || t === '–') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** The schedule annotates a name with "●" for revised and "· Alex" for branch. */
const cleanName = (s) => String(s)
  .replace(/\*/g, '')
  .replace(/●/g, '')
  .replace(/\s*·\s*Alex\s*$/i, '')
  .replace(/\s+/g, ' ')
  .trim();

const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (line) => /^\|[\s:|-]+\|$/.test(line);

/**
 * Group headings come in two shapes. The ordinary one is a markdown heading.
 * The other is a stray two-cell table, and a page break has split its count
 * across the cells ("Laser-led | 1" then "9 DOCTORS"), so digits separated by
 * whitespace are rejoined. That guess is never load-bearing: the count it
 * produces is checked against the rows actually parsed, and a mismatch aborts.
 */
function groupHeading(line) {
  const flat = line
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[|*#]/g, ' ')
    .replace(/(\d)\s+(\d)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(.+?)\s+(\d+)\s+DOCTORS$/i.exec(flat);
  if (!m) return null;
  const name = m[1].trim();
  return name ? { name, declaredCount: Number(m[2]) } : null;
}

function parse(md) {
  const lines = md.split('\n');
  const groups = [];
  let current = null;

  const headerTotals = (() => {
    // |73|46|28,838,391|+5,439,209|
    for (let i = 0; i < lines.length; i++) {
      if (!/DOCTORS.*ON|SCHEDULE/i.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (isRule(lines[j]) || !lines[j].trim().startsWith('|')) continue;
        const c = cells(lines[j]);
        if (c.length >= 3 && money(c[0]) && money(c[2])) {
          return { roster: money(c[0]), revised: money(c[1]), total: money(c[2]) };
        }
      }
    }
    return null;
  })();

  const period = (() => {
    const m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i
      .exec(md);
    if (!m) return null;
    return `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
  })();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const head = groupHeading(line);
    // A heading line is never a doctor row; a doctor row has four cells.
    if (head && !(line.startsWith('|') && cells(line).length >= 4)) {
      const existing = groups.find((g) => g.name === head.name);
      current = existing || { name: head.name, declaredCount: head.declaredCount, rows: [], subtotal: null };
      if (!existing) groups.push(current);
      continue;
    }

    if (!current || !line.startsWith('|') || isRule(line)) continue;
    const c = cells(line);
    if (c.length < 3) continue;

    const label = c[0].replace(/\*/g, '').trim();
    if (/^DOCTOR$/i.test(label)) continue;
    if (/^Subtotal$/i.test(label)) {
      const sub = money(c[2]);
      // Continuation tables repeat the subtotal; they must agree.
      if (current.subtotal !== null && sub !== current.subtotal) {
        throw new Error(`${current.name}: two different subtotals, ${current.subtotal} and ${sub}`);
      }
      current.subtotal = sub;
      continue;
    }

    const august = money(c[2]);
    if (august === null) continue;
    current.rows.push({ name: cleanName(c[0]), prevMonth: money(c[1]), monthlyTarget: august });
  }

  return { period, headerTotals, groups: groups.filter((g) => g.rows.length) };
}

/** Refuse anything that does not agree with the document's own arithmetic. */
function verify({ headerTotals, groups }) {
  const problems = [];
  let total = 0, roster = 0;

  for (const g of groups) {
    const sum = g.rows.reduce((s, r) => s + r.monthlyTarget, 0);
    if (g.subtotal === null) problems.push(`${g.name}: no subtotal in the document`);
    else if (Math.abs(sum - g.subtotal) > 0.01) {
      problems.push(`${g.name}: rows sum to ${sum.toLocaleString()} but the subtotal says ${g.subtotal.toLocaleString()}`);
    }
    if (g.declaredCount != null && g.declaredCount !== g.rows.length) {
      problems.push(`${g.name}: ${g.rows.length} rows parsed but the heading says ${g.declaredCount} doctors`);
    }
    const dupes = g.rows.map((r) => normName(r.name))
      .filter((n, i, a) => a.indexOf(n) !== i);
    if (dupes.length) problems.push(`${g.name}: the same doctor appears twice — ${dupes.join(', ')}`);

    total += g.subtotal ?? sum;
    roster += g.rows.length;
  }

  if (headerTotals) {
    if (Math.abs(total - headerTotals.total) > 0.01) {
      problems.push(`groups add to ${total.toLocaleString()} but the document's total is ${headerTotals.total.toLocaleString()}`);
    }
    if (roster !== headerTotals.roster) {
      problems.push(`${roster} doctors parsed but the document says ${headerTotals.roster}`);
    }
  }

  const across = groups.flatMap((g) => g.rows.map((r) => normName(r.name)))
    .filter((n, i, a) => a.indexOf(n) !== i);
  if (across.length) problems.push(`the same doctor is in two groups — ${[...new Set(across)].join(', ')}`);

  return { problems, total, roster };
}

(async () => {
  const file = process.argv[2];
  const write = process.argv.includes('--write');
  if (!file) {
    console.error('Usage: node scripts/import-schedule-md.js <file.md> [--write]');
    process.exit(2);
  }

  const parsed = parse(fs.readFileSync(file, 'utf8'));
  const periodArg = process.argv.indexOf('--period');
  const period = periodArg > -1 ? process.argv[periodArg + 1] : parsed.period;
  if (!period) throw new Error('Could not tell which month this schedule is for; pass --period YYYY-MM.');

  const { problems, total, roster } = verify(parsed);

  console.log(`\n\x1b[1m▸ ${path.basename(file)} → ${period}\x1b[0m`);
  for (const g of parsed.groups) {
    console.log(`  ${g.name.padEnd(20)} ${String(g.rows.length).padStart(3)} doctors  ${(g.subtotal ?? 0).toLocaleString().padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(roster).padStart(3)} doctors  ${total.toLocaleString().padStart(12)}`);

  if (problems.length) {
    console.error('\n\x1b[31m✗ the document does not add up, so nothing was imported:\x1b[0m');
    for (const p of problems) console.error(`    ${p}`);
    process.exit(1);
  }
  console.log('  \x1b[32m✓ every subtotal, doctor count and the grand total agree with the document\x1b[0m');

  /* ---- what this changes ---- */
  const before = await prisma.targetPeriod.findUnique({
    where: { period }, include: { groups: true, doctorTargets: true, branchTargets: true },
  });
  const wasByName = new Map((before?.doctorTargets || []).map((d) => [normName(d.scheduleName), d]));
  const incoming = parsed.groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.name })));

  const added = [], changed = [], regrouped = [];
  for (const r of incoming) {
    const was = wasByName.get(normName(r.name));
    if (!was) { added.push(r); continue; }
    if (num(was.monthlyTarget) !== r.monthlyTarget) changed.push({ ...r, from: num(was.monthlyTarget) });
    else if (was.groupName !== r.group) regrouped.push({ ...r, from: was.groupName });
  }
  const dropped = (before?.doctorTargets || [])
    .filter((d) => !incoming.some((r) => normName(r.name) === normName(d.scheduleName)));

  const show = (label, list, fmt) => {
    if (!list.length) return;
    console.log(`\n  \x1b[1m${label} (${list.length})\x1b[0m`);
    for (const x of list) console.log(`    ${fmt(x)}`);
  };
  show('New on the schedule', added, (r) => `${r.name.padEnd(30)} ${r.group.padEnd(18)} ${r.monthlyTarget.toLocaleString()}`);
  show('Target changed', changed, (r) => `${r.name.padEnd(30)} ${r.from.toLocaleString()} → ${r.monthlyTarget.toLocaleString()}`);
  show('Now carries a group', regrouped, (r) => `${r.name.padEnd(30)} ${r.from === null ? 'held as unlisted' : r.from} → ${r.group}`);
  show('No longer on the schedule', dropped, (d) => `${d.scheduleName.padEnd(30)} was ${num(d.monthlyTarget).toLocaleString()}`);

  if (before) {
    const held = before.groups.reduce((s, g) => s + num(g.unlistedTarget), 0);
    console.log(`\n  unlisted remainder ${held.toLocaleString()} → 0 · every doctor is now named`);
    console.log(`  ${before.branchTargets.length} branch targets carried forward (this document has none)`);
  }

  /* ---- does each name reach Odoo? ---- */
  const actuals = await prisma.invoice.groupBy({
    by: ['specialistName'], _sum: { amountUntaxed: true }, where: { specialistName: { not: null } },
  });
  const odoo = new Map(actuals.map((a) => [normName(a.specialistName), a]));
  const aliases = Object.fromEntries((await prisma.identityAlias.findMany({ where: { kind: 'doctor' } }))
    .map((a) => [a.scheduleName, a.odooName]));
  const unmatched = incoming.filter((r) =>
    !odoo.has(normName(r.name)) && !(aliases[r.name] && odoo.has(normName(aliases[r.name]))));
  if (unmatched.length) {
    console.log(`\n  \x1b[33m${unmatched.length} with no invoices in the cache\x1b[0m — either they have not invoiced yet, or the name needs mapping at /admin:`);
    for (const r of unmatched) console.log(`    ${r.name.padEnd(30)} ${r.group.padEnd(18)} ${r.monthlyTarget.toLocaleString()}`);
  }

  if (!write) {
    console.log('\n  Nothing was written. Re-run with --write to publish.\n');
    await prisma.$disconnect();
    return;
  }

  /* ---- publish ---- */
  const daysInPeriod = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
  const sourceLabel = (/^#\s*\*{0,2}(.+?)\*{0,2}\s*$/m.exec(fs.readFileSync(file, 'utf8')) || [])[1]
    ?.replace(/\*/g, '').trim() || `Approved Target Schedule — ${period}`;
  const branches = (before?.branchTargets || []).map((b) => ({
    scheduleName: b.scheduleName, target1: b.target1, target2: b.target2,
  }));

  await prisma.$transaction(async (tx) => {
    await tx.targetPeriod.deleteMany({ where: { period } });
    await tx.targetPeriod.create({
      data: {
        period, daysInPeriod, sourceLabel,
        groups: {
          create: parsed.groups.map((g) => ({
            name: g.name,
            target: g.subtotal,
            rosterCount: g.rows.length,
            // Every roster member is named now, so nothing is held back.
            unlistedCount: 0,
            unlistedTarget: 0,
          })),
        },
        doctorTargets: {
          // hasSales gates whether a row is scored, not whether it invoiced. With
          // no unlisted remainder left there is nothing to double-count, so every
          // row scores; the ones with no invoices show as such on the page.
          create: incoming.map((r) => ({
            scheduleName: r.name, groupName: r.group,
            monthlyTarget: r.monthlyTarget, prevMonth: r.prevMonth, hasSales: true,
          })),
        },
        branchTargets: { create: branches },
      },
    });
  });

  console.log(`\n  \x1b[32m✓ published ${period}\x1b[0m — ${roster} doctors, ${total.toLocaleString()} ex-VAT, ${branches.length} branch targets kept\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`\n\x1b[31m✗ ${e.message}\x1b[0m\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
