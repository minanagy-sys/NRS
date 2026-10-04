#!/usr/bin/env node
/**
 * Is Odoo answering the MCP right now?
 *
 *   node scripts/odoo-up.js
 *   node scripts/odoo-up.js --watch     # re-check every 30 s until it comes back
 *
 * The MCP being up and Odoo being up are different questions, and the report can
 * only be refreshed when both are. This answers them separately, so an outage is
 * attributed to the right place instead of to this app. Read-only.
 */

process.loadEnvFile(require('path').join(__dirname, '..', '.env'));

const Mcp = require('../src/lib/mcp.js');
const { loginWithPassword } = require('../src/lib/oauth-password.js');

const base = process.env.MCP_BASE_URL || Mcp.DEFAULT_BASE;
const stamp = () => new Date().toTimeString().slice(0, 8);

/** Returns { up, layer, detail } — layer says which one to go and look at. */
async function probe() {
  let token;
  try {
    ({ token } = await loginWithPassword({ base, user: process.env.MCP_USER, password: process.env.MCP_PASSWORD }));
  } catch (e) {
    return { up: false, layer: 'sign-in', detail: e.message };
  }

  let session;
  try {
    session = await Mcp.connect({ base, token });
  } catch (e) {
    return { up: false, layer: e.kind === 'odoo' ? 'Odoo' : 'the MCP', detail: e.message };
  }

  try {
    // A count is the cheapest question that still has to reach the database.
    const n = await session.callKw('account.move', 'search_count', [[['state', '=', 'posted']]], {});
    return { up: true, layer: 'Odoo', detail: `${Number(n).toLocaleString('en-US')} posted invoices` };
  } catch (e) {
    return { up: false, layer: e.kind === 'odoo' ? 'Odoo' : 'the MCP', detail: e.message };
  }
}

(async () => {
  const watch = process.argv.includes('--watch');
  for (;;) {
    const r = await probe();
    if (r.up) {
      console.log(`${stamp()}  \x1b[32m✓ Odoo is answering\x1b[0m — ${r.detail}`);
      console.log('        Press Refresh in the report and the figures will catch up.');
      process.exit(0);
    }
    console.log(`${stamp()}  \x1b[31m✗ ${r.layer} is not answering\x1b[0m — ${r.detail}`);
    if (!watch) {
      console.log('        The cached figures in the report are the last good pull and are still correct.');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
})();
