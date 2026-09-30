#!/usr/bin/env node
/* Fill the cache from the MCP.

     node scripts/sync.js --from 2026-08-01 --to 2026-08-10 [--stock]
     node scripts/sync.js --mtd            # 1st of this month to today
     node scripts/sync.js --days 7         # trailing week, to catch late postings

   Needs a token. Either MCP_TOKEN in the environment, or MCP_USER/MCP_PASSWORD
   for the cron account — the interactive app never uses passwords, but an
   unattended job has no browser to redirect. */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const { prisma } = require('../src/lib/db.js');
const { syncRange, syncStock } = require('../src/lib/sync.js');
const { iso } = require('../src/lib/rules.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
}

async function token() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const user = process.env.MCP_USER, password = process.env.MCP_PASSWORD;
  if (!user || !password) {
    throw new Error('Set MCP_TOKEN, or MCP_USER and MCP_PASSWORD for the unattended account.');
  }
  // The password grant is unsupported, so this drives the same form the browser
  // would — see lib/oauth-password.js for why it exists at all.
  const { loginWithPassword } = require('../src/lib/oauth-password.js');
  const { token: t } = await loginWithPassword({ base: process.env.MCP_BASE_URL, user, password });
  return t;
}

(async () => {
  const today = iso(new Date());
  let from = arg('from'), to = arg('to') || today;

  if (arg('mtd')) { from = `${today.slice(0, 7)}-01`; to = today; }
  if (arg('days')) {
    const n = Number(arg('days')) || 7;
    const d = new Date(); d.setDate(d.getDate() - (n - 1));
    from = iso(d); to = today;
  }
  if (!from) { from = `${today.slice(0, 7)}-01`; }

  console.log(`syncing ${from} → ${to} …`);
  const t = await token();
  const started = Date.now();

  const out = await syncRange({ token: t, from, to, trigger: arg('cron') ? 'cron' : 'manual', actor: process.env.MCP_USER || 'script' });
  console.log(`✓ ${out.invoices} invoices · ${out.lines} lines · ${out.days} days  (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  if (arg('stock')) {
    const s = await syncStock({ token: t });
    console.log(`✓ stock: ${s.rows} rows across ${s.products} products (scanned ${s.scanned})`);
  }

  /* Customer receipts, on the same window as the invoices. The Sales overview
     shows net collections beside revenue, so leaving it on a frozen import while
     the invoices refresh hourly is how the two silently drift apart — the 11
     August snapshot was already 12.3% short by the 19th.

     It only runs while the collections section is actually reading `odoo`: if
     somebody has switched back to the snapshot deliberately, an hourly job should
     not keep overwriting rows nothing reads. A failure here is reported and does
     NOT fail the invoice sync, which is the job that matters most. */
  const collCfg = await prisma.financeSource.findUnique({ where: { section: 'collections' } });
  if (collCfg && collCfg.mode !== 'snapshot') {
    try {
      const { syncCollections } = require('../src/lib/finance-sync.js');
      const c = await syncCollections({ token: t, from, to });
      console.log(`✓ collections: ${c.rowsWritten} rows · net ${Math.round(c.net).toLocaleString('en-US')}`
        + ` from ${c.inbound} receipts across ${c.branches} branches`
        + (c.unmappedJournals.length ? ` · ${c.unmappedJournals.length} unmapped journal(s)` : ''));
    } catch (e) {
      console.error(`! collections sync failed (${e.kind || 'error'}): ${e.message}`);
      console.error('  the invoice sync above still succeeded.');
    }
  }

  /* Bookings, on the same window. The funnel and the show rate are the only
     things in the reports that cannot be recomputed after the fact — Odoo
     overwrites `states` in place, so a booking left `pending` and later marked
     done is indistinguishable from one that was always done unless we keep
     pulling. Same containment as collections: it is reported and does not fail
     the invoice sync. */
  try {
    const { syncAppointments } = require('../src/lib/sync.js');
    const a = await syncAppointments({ token: t, from, to });
    console.log(`\u2713 appointments: ${a.written} bookings \u00b7 ${a.attended} attended`
      + ` \u00b7 ${a.open} still open \u00b7 show rate ${(a.showRate * 100).toFixed(1)}%`);
  } catch (e) {
    console.error(`! appointment sync failed (${e.kind || 'error'}): ${e.message}`);
    console.error('  the invoice sync above still succeeded.');
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('✗', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
