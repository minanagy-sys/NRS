#!/usr/bin/env node
/* Import the August 2026 sheet and the name aliases that were established by
   checking the schedule against live Odoo. Idempotent: re-running replaces.

   node scripts/seed-targets.js [path/to/targets.json] */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const fs = require('fs');
const path = require('path');
const { prisma } = require('../src/lib/db.js');

const SRC = process.argv[2] || path.join(process.env.HOME, 'nouvelage-daily-sales-live', 'targets.json');

(async () => {
  const t = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const period = t.period;

  // Refuse to import a sheet that does not cross-foot — the same rule the API applies.
  const listed = {};
  for (const d of t.doctors) listed[d.group] = (listed[d.group] || 0) + (d.monthly_target || 0);
  for (const [name, g] of Object.entries(t.groups)) {
    const sum = (listed[name] || 0) + g.unlisted_target;
    if (Math.abs(sum - g.target) > 0.01) {
      throw new Error(`${name} does not reconcile: ${sum} vs ${g.target}`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.targetPeriod.deleteMany({ where: { period } });
    await tx.targetPeriod.create({
      data: {
        period,
        daysInPeriod: t.days_in_period,
        sourceLabel: t.source,
        groups: { create: Object.entries(t.groups).map(([name, g]) => ({
          name, target: g.target, rosterCount: g.roster_count,
          unlistedCount: g.unlisted_count, unlistedTarget: g.unlisted_target,
        })) },
        doctorTargets: {
          create: [
            ...t.doctors.map((d) => ({
              scheduleName: d.name, groupName: d.group,
              monthlyTarget: d.monthly_target, prevMonth: d.july_actual ?? null, hasSales: true,
            })),
            // The roster members the original report hid. They carry no group in the
            // source, so they are stored flagged rather than guessed into one.
            ...(t.named_no_sales?.doctors || []).map((d) => ({
              scheduleName: d.name, groupName: null,
              monthlyTarget: d.monthly_target, hasSales: false,
            })),
          ],
        },
        branchTargets: { create: t.branches.map((b) => ({
          scheduleName: b.name, target1: b.target1, target2: b.target2 ?? null,
        })) },
      },
    });
  });

  const aliases = [
    ...Object.entries(t.aliases?.doctors || {}).map(([scheduleName, odooName]) => ({ kind: 'doctor', scheduleName, odooName })),
    ...Object.entries(t.aliases?.branches || {}).map(([scheduleName, odooName]) => ({ kind: 'branch', scheduleName, odooName })),
  ];
  for (const a of aliases) {
    await prisma.identityAlias.upsert({
      where: { kind_scheduleName: { kind: a.kind, scheduleName: a.scheduleName } },
      update: { odooName: a.odooName },
      create: a,
    });
  }

  const total = Object.values(t.groups).reduce((s, g) => s + g.target, 0);
  console.log(`✓ ${period}: ${t.doctors.length} invoicing + ${(t.named_no_sales?.doctors || []).length} named with no sales`);
  console.log(`  ${t.branches.length} branches · ${aliases.length} aliases · sheet total ${total.toLocaleString()}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('✗', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
