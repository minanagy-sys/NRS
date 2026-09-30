#!/usr/bin/env bash
# Why did Refresh fail? The browser is told only "could not reach the MCP" on
# purpose — the detail would leak internals to anyone signed in. This prints the
# detail, which is already recorded in SyncRun.error, and then reproduces the
# failure against the very token the Refresh button uses.
#
#   sudo bash diagnose-refresh.sh
#
# Read-only: it queries Postgres and calls the MCP's own read methods. It writes
# nothing to the database, to .env, or to Odoo.

set -euo pipefail
export LC_ALL=C.UTF-8

APP_DIR=/opt/nrs
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "$APP_DIR/.env not found." >&2; exit 1; }

PROG=$(mktemp /tmp/nrs-diag-XXXXXX.js)
chmod 644 "$PROG"
trap 'rm -f "$PROG"' EXIT

cat > "$PROG" <<'JS'
process.chdir('/opt/nrs');
process.loadEnvFile('.env');

const crypto = require('crypto');
const { prisma } = require('/opt/nrs/src/lib/db.js');
const Mcp = require('/opt/nrs/src/lib/mcp.js');
const { decrypt } = require('/opt/nrs/src/lib/crypto.js');

const line = (s) => console.log(s);
const head = (s) => console.log(`\n\x1b[1m▸ ${s}\x1b[0m`);
const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '—');
// Never print a token. A fingerprint is enough to tell two tokens apart.
const fp = (t) => `${t.length} chars · sha256 ${crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)}`;

(async () => {
  head('The last 8 sync attempts — this is the real error');
  const runs = await prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 8 });
  if (!runs.length) line('  no sync has ever run');
  for (const r of runs) {
    const win = `${when(r.fromDate).slice(0, 10)}..${when(r.toDate).slice(0, 10)}`;
    const mark = r.status === 'ok' ? '\x1b[32m✓\x1b[0m' : r.status === 'failed' ? '\x1b[31m✗\x1b[0m' : '·';
    line(`  ${mark} ${when(r.startedAt)}  ${r.trigger.padEnd(8)} ${win}  ${r.status}  ${r.invoices} inv`);
    if (r.error) line(`      \x1b[31m${r.error}\x1b[0m`);
  }

  head('Signed-in sessions');
  const sessions = await prisma.session.findMany({ orderBy: { lastSeenAt: 'desc' } });
  if (!sessions.length) line('  none — nobody is signed in');
  for (const s of sessions) {
    line(`  ${s.subject}  signed in ${when(s.createdAt)}  last seen ${when(s.lastSeenAt)}`);
    line(`      token expires ${when(s.tokenExpiresAt)} · session expires ${when(s.expiresAt)} · canWrite ${s.canWrite}`);
  }

  /* The decisive test. Refresh uses the signed-in browser session's own token;
     the timers mint their own from MCP_USER/MCP_PASSWORD. If the second works
     and the first does not, the fault is in the interactive token, not the
     network, not DNS, not the firewall. */
  head('Test 1 — the token the Refresh button actually uses');
  const newest = sessions[0];
  if (!newest) {
    line('  skipped: no session to test');
  } else {
    let token;
    try {
      token = decrypt(newest.tokenCipher);
      line(`  decrypted ok — ${fp(token)}`);
    } catch (e) {
      line(`  \x1b[31m✗ cannot decrypt the stored token: ${e.message}\x1b[0m`);
      line('    TOKEN_KEY in .env no longer matches the key the token was sealed with.');
    }
    if (token) await probe(token);
  }

  head('Test 2 — the token the timers use (MCP_USER / MCP_PASSWORD)');
  if (!process.env.MCP_USER || !process.env.MCP_PASSWORD) {
    line('  skipped: MCP_USER / MCP_PASSWORD not set in .env');
  } else {
    line(`  user ${process.env.MCP_USER} · password ${process.env.MCP_PASSWORD.length} chars`);
    try {
      const { loginWithPassword } = require('/opt/nrs/src/lib/oauth-password.js');
      const r = await loginWithPassword({
        base: process.env.MCP_BASE_URL,
        user: process.env.MCP_USER,
        password: process.env.MCP_PASSWORD,
      });
      line(`  \x1b[32m✓\x1b[0m minted a token — ${fp(r.token)} · valid ${Math.round(r.expiresIn / 86400)} days`);
      await probe(r.token);
    } catch (e) {
      line(`  \x1b[31m✗ ${e.message}\x1b[0m`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(`\n\x1b[31m✗ ${e.stack || e.message}\x1b[0m`); process.exit(1); });

/** Walk the same three steps a refresh does, reporting which one breaks. */
async function probe(token) {
  const base = process.env.MCP_BASE_URL;
  let session;
  try {
    session = await Mcp.connect({ base, token });
    line(`    initialize      \x1b[32mok\x1b[0m — ${session.serverInfo ? session.serverInfo.name : 'no serverInfo'}`);
  } catch (e) {
    line(`    initialize      \x1b[31mFAILED — ${e.message}\x1b[0m`);
    return;
  }
  try {
    await session.ping();
    line('    odoo_ping       \x1b[32mok\x1b[0m');
  } catch (e) {
    line(`    odoo_ping       \x1b[31mFAILED — ${e.message}\x1b[0m`);
  }
  try {
    // The first call a refresh makes, narrowed to one day so it is cheap.
    const today = new Date().toISOString().slice(0, 10);
    const rows = await session.callKw('account.move', 'search_read', [[
      ['state', '=', 'posted'],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_date', '>=', today],
      ['invoice_date', '<=', today],
    ], ['id', 'invoice_date', 'amount_untaxed']], { limit: 5 });
    line(`    search_read     \x1b[32mok\x1b[0m — ${Array.isArray(rows) ? rows.length : 0} rows for ${today}`);
  } catch (e) {
    line(`    search_read     \x1b[31mFAILED — ${e.message}\x1b[0m`);
  }
}
JS

cd "$APP_DIR"
sudo -u nrs node "$PROG" || true

echo
printf '\n\033[1m▸ What the server logged\033[0m\n'
journalctl -u nrs --since '-2h' --no-pager 2>/dev/null \
  | grep -Ei 'error|fail|refresh|mcp|ECONN|ETIMEDOUT|ENOTFOUND|certificate' \
  | tail -30 | sed 's/^/  /' || echo '  nothing matching in the last 2 hours'

printf '\n\033[1m▸ Can this droplet reach the MCP at all\033[0m\n'
sudo -u nrs curl -s -o /dev/null -w '  HTTPS to mcp.nouvelageclinic.com → HTTP %{http_code} in %{time_total}s\n' \
  --max-time 20 https://mcp.nouvelageclinic.com/mcp -X POST \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  || echo '  ✗ could not connect'
echo
