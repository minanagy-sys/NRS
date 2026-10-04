#!/usr/bin/env node
/**
 * Pull customer receipts from Odoo 18 into the Collection table.
 *
 *   node scripts/sync-collections.js                       # this month so far
 *   node scripts/sync-collections.js --from 2026-08-01 --to 2026-08-31
 *   node scripts/sync-collections.js --from 2026-08-01 --compare
 *
 * `--compare` reads the imported snapshot for the same window and prints both
 * side by side without writing, which is how you see whether the snapshot has
 * gone stale before you replace it.
 *
 * After a successful sync this switches the collections section to read `odoo`,
 * because a synced section that nothing reads is just a slower snapshot. The
 * snapshot rows are left untouched, so `snapshot` remains a one-field revert.
 */

process.loadEnvFile(require('path').join(__dirname, '..', '.env'));

const { syncCollections } = require('../src/lib/finance-sync.js');
const { prisma } = require('../src/lib/db.js');

const iso = (d) => d.toISOString().slice(0, 10);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const f = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');

async function token() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const user = process.env.MCP_USER, password = process.env.MCP_PASSWORD;
  if (!user || !password) throw new Error('Set MCP_TOKEN, or MCP_USER and MCP_PASSWORD.');
  const { loginWithPassword } = require('../src/lib/oauth-password.js');
  const { token: t } = await loginWithPassword({ base: process.env.MCP_BASE_URL, user, password });
  return t;
}

(async () => {
  const today = iso(new Date());
  const to = arg('to', today);
  const from = arg('from', `${to.slice(0, 7)}-01`);
  const compare = !!arg('compare', false);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) throw new Error('Dates must be YYYY-MM-DD.');
  if (from > to) throw new Error('"from" is after "to".');

  const snap = await prisma.collection.aggregate({
    where: { source: 'snapshot', date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
    _sum: { gross: true, refunds: true, net: true }, _count: true,
  });

  if (compare) {
    console.log(`\n\x1b[1mSnapshot vs Odoo · ${from} to ${to}\x1b[0m\n`);
    const R = require('../src/lib/finance-rules.js');
    const Mcp = require('../src/lib/mcp.js');
    const session = await Mcp.connect({ base: process.env.MCP_BASE_URL, token: await token() });
    const grab = (t) => session.callKw('account.payment', 'search_read', [[
      ['partner_type', '=', 'customer'], ['payment_type', '=', t], ['state', '=', 'paid'],
      ['date', '>=', from], ['date', '<=', to],
    ], ['amount', 'journal_id', 'branch_id']], { limit: 0 });
    const [inb, outb] = await Promise.all([grab('inbound'), grab('outbound')]);
    const og = inb.reduce((a, p) => a + p.amount, 0), or = outb.reduce((a, p) => a + p.amount, 0);
    const sg = Number(snap._sum.gross || 0), sr = Number(snap._sum.refunds || 0), sn = Number(snap._sum.net || 0);
    const line = (label, a, b) => {
      const d = b - a;
      const pctv = a ? ((b / a - 1) * 100).toFixed(1) : '—';
      console.log(`  ${label.padEnd(10)} snapshot ${f(a).padStart(12)}   odoo ${f(b).padStart(12)}   ${(d >= 0 ? '+' : '') + f(d)} (${d >= 0 ? '+' : ''}${pctv}%)`);
    };
    line('gross', sg, og);
    line('refunds', sr, or);
    line('net', sn, og - or);
    console.log(`\n  ${snap._count} snapshot rows · ${inb.length} inbound + ${outb.length} outbound payments in Odoo`);
    console.log('\n  Nothing written. Drop --compare to sync.\n');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n\x1b[1mSyncing customer receipts · ${from} to ${to}\x1b[0m`);
  const out = await syncCollections({ token: await token(), from, to });

  console.log(`\n  ${f(out.inbound)} inbound + ${f(out.outbound)} outbound paid customer payments`);
  console.log(`  ${f(out.rowsWritten)} rows written across ${out.branches} branches and ${out.days} days\n`);
  console.log(`    gross    ${f(out.gross).padStart(12)}`);
  console.log(`    refunds  ${f(out.refunds).padStart(12)}`);
  console.log(`    net      ${f(out.net).padStart(12)}`);

  if (snap._count) {
    const sn = Number(snap._sum.net || 0);
    const d = out.net - sn;
    console.log(`\n  the imported snapshot held ${f(sn)} net for this window — Odoo is ${(d >= 0 ? '+' : '') + f(d)}`
      + (sn ? ` (${d >= 0 ? '+' : ''}${((out.net / sn - 1) * 100).toFixed(1)}%)` : ''));
    console.log('  the snapshot rows were NOT touched; switch back any time with source mode "snapshot"');
  }

  if (out.unmappedJournals.length) {
    console.log(`\n  \x1b[33m${out.unmappedJournals.length} journal${out.unmappedJournals.length === 1 ? '' : 's'} with no register rule — kept under their own name, not folded into Cash:\x1b[0m`);
    for (const u of out.unmappedJournals) console.log(`    ${u.journal.padEnd(30)} ${String(u.count).padStart(4)} payments  ${f(u.amount).padStart(10)}`);
    console.log('    Add a rule to REGISTER_RULES in src/lib/finance-rules.js to fold these into a register.');
  }
  if (out.noBranch.count) {
    console.log(`\n  \x1b[33m${out.noBranch.count} payment${out.noBranch.count === 1 ? '' : 's'} with no branch_id — ${f(out.noBranch.amount)} filed as "Unassigned"\x1b[0m`);
  }
  if (!out.packageShareSynced) {
    console.log('\n  packageShare is 0 for Odoo rows: it needs each payment reconciled to a');
    console.log('  package-sale invoice, which the payment record does not carry. Not guessed.');
  }

  /* Point the section at what was just synced. */
  const before = await prisma.financeSource.findUnique({ where: { section: 'collections' } });
  await prisma.financeSource.upsert({
    where: { section: 'collections' },
    update: { mode: 'odoo', cutover: null },
    create: { section: 'collections', mode: 'odoo' },
  });
  console.log(`\n  collections now reads \x1b[32modoo\x1b[0m (was ${before ? before.mode : 'unset'})\n`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`\n\x1b[31m✗ ${e.kind ? `[${e.kind}] ` : ''}${e.message}\x1b[0m\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
