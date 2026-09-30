#!/usr/bin/env node
/**
 * Map a name on the approved schedule to the name Odoo actually uses.
 *
 *   node scripts/set-alias.js doctor "Dr. Mai Sofar" "Dr. Mai Soffar"
 *   node scripts/set-alias.js branch "Alex Roshdy" "Roushdy"
 *   node scripts/set-alias.js --list
 *   node scripts/set-alias.js --remove doctor "Dr. Mai Sofar"
 *
 * Names are never paired by similarity — `Dr.Merna Masoud` and `Dr.Merna Ashraf`
 * are one edit apart and are different people. Every alias is a decision someone
 * made, which is why this refuses an Odoo name that has never invoiced: that is
 * almost always a typo rather than a mapping. /admin does the same job with a
 * dropdown of real Odoo names; this is for the server.
 */

const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may come from systemd */ }

const { prisma } = require('../src/lib/db.js');
const { normName } = require('../src/lib/rules.js');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const rest = args.filter((a) => !a.startsWith('--'));

(async () => {
  if (has('--list') || !rest.length) {
    const all = await prisma.identityAlias.findMany({ orderBy: [{ kind: 'asc' }, { scheduleName: 'asc' }] });
    if (!all.length) console.log('  no aliases');
    for (const a of all) console.log(`  ${a.kind.padEnd(7)} "${a.scheduleName}" → "${a.odooName}"`);
    return;
  }

  const [kind, scheduleName, odooName] = rest;
  if (!['doctor', 'branch'].includes(kind)) throw new Error('kind must be "doctor" or "branch"');

  if (has('--remove')) {
    const { count } = await prisma.identityAlias.deleteMany({ where: { kind, scheduleName } });
    console.log(count ? `  removed "${scheduleName}"` : `  no alias for "${scheduleName}"`);
    return;
  }
  if (!odooName) throw new Error('Usage: set-alias.js <doctor|branch> "<schedule name>" "<odoo name>"');

  // Prove the target exists before pointing anything at it.
  const field = kind === 'doctor' ? 'specialistName' : 'branchName';
  const seen = await prisma.invoice.groupBy({
    by: [field], _sum: { amountUntaxed: true }, where: { [field]: { not: null } },
  });
  const hit = seen.find((r) => normName(r[field]) === normName(odooName));
  if (!hit) {
    const near = seen.map((r) => r[field])
      .filter((n) => normName(n).split(' ').some((w) => normName(odooName).includes(w)))
      .slice(0, 5);
    throw new Error(`Odoo has never invoiced under "${odooName}".${near.length ? `\n    Did you mean: ${near.join(' | ')}` : ''}`);
  }

  const a = await prisma.identityAlias.upsert({
    where: { kind_scheduleName: { kind, scheduleName } },
    update: { odooName: hit[field] },
    create: { kind, scheduleName, odooName: hit[field] },
  });
  console.log(`  ✓ ${a.kind} "${a.scheduleName}" → "${a.odooName}" (${Math.round(Number(hit._sum.amountUntaxed)).toLocaleString()} ex-VAT in the cache)`);
})().then(() => prisma.$disconnect(), async (e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
