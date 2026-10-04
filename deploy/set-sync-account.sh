#!/usr/bin/env bash
# Give the scheduled sync an account, then fill the cache.
#
#   sudo bash set-sync-account.sh
#
# The password is read with terminal echo off and handed to python on stdin, so
# it never appears on screen, never enters shell history, and never shows in the
# process list. Only /opt/nrs/.env holds it, mode 600.

set -euo pipefail
export LC_ALL=C.UTF-8

APP_DIR=/opt/nrs
ENV_FILE="$APP_DIR/.env"

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE not found — run deploy/install.sh first." >&2; exit 1; }

echo
echo "  The scheduled sync has no browser to redirect, so it signs in with a"
echo "  password. Use a dedicated read-only Odoo account if you have one."
echo

read -r -p "  MCP user (email): " MCP_U
[[ -n "$MCP_U" ]] || { echo "  Nothing entered; no changes made." >&2; exit 1; }
read -r -s -p "  MCP password: " MCP_P; echo
[[ -n "$MCP_P" ]] || { echo "  Nothing entered; no changes made." >&2; exit 1; }

# The program goes in a file and the VALUES go on stdin. Piping data into
# `python3 -` while also using a heredoc makes both compete for stdin: bash lets
# the heredoc win, so readline() returned nothing and the credentials were
# written empty — which is exactly why the MCP rejected them.
PYPROG=$(mktemp)
trap 'rm -f "$PYPROG"' EXIT
cat > "$PYPROG" <<'PY'
import sys
path = sys.argv[1]
user = sys.stdin.readline().rstrip('\n')
password = sys.stdin.readline().rstrip('\n')
if not user or not password:
    sys.exit('  \u2717 nothing arrived on stdin; .env left untouched')

def quote(v):
    # Understood both by systemd's EnvironmentFile and by Node's loadEnvFile.
    return '"' + v.replace('\\', '\\\\').replace('"', '\\"') + '"'

lines = open(path).read().splitlines()
seen, out = set(), []
for line in lines:
    if line.startswith('MCP_USER='):
        out.append(f'MCP_USER={quote(user)}'); seen.add('MCP_USER')
    elif line.startswith('MCP_PASSWORD='):
        out.append(f'MCP_PASSWORD={quote(password)}'); seen.add('MCP_PASSWORD')
    else:
        out.append(line)
for key, val in (('MCP_USER', user), ('MCP_PASSWORD', password)):
    if key not in seen:
        out.append(f'{key}={quote(val)}')
open(path, 'w').write('\n'.join(out) + '\n')
print(f'  \u2713 written to .env (user {len(user)} chars, password {len(password)} chars)')
PY

printf '%s\n%s\n' "$MCP_U" "$MCP_P" | python3 "$PYPROG" "$ENV_FILE"

unset MCP_P
chown nrs:nrs "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "  ✓ .env is $(stat -c '%a %U:%G' "$ENV_FILE")"

echo
echo "▸ Restarting the app"
systemctl restart nrs
sleep 2
systemctl is-active --quiet nrs && echo "  ✓ running" || { journalctl -u nrs -n 20 --no-pager; exit 1; }

echo
echo "▸ Verifying the credentials before trusting the timers with them"
cd "$APP_DIR"
sudo -u nrs node -e '
process.loadEnvFile(".env");
const { loginWithPassword } = require("./src/lib/oauth-password.js");
loginWithPassword({ base: process.env.MCP_BASE_URL, user: process.env.MCP_USER, password: process.env.MCP_PASSWORD })
  .then((r) => console.log(`  ✓ signed in — token good for ${Math.round(r.expiresIn / 86400)} days`))
  .catch((e) => { console.error(`  ✗ ${e.message}`); process.exit(1); });
' || { echo "  Saved, but the MCP refused them. Re-run this script to correct." >&2; exit 1; }

echo
echo "▸ Filling the cache — July and August, plus stock"
sudo -u nrs node scripts/sync.js --from 2026-07-01 --to "$(date +%F)" --stock

echo
echo "▸ What the cache now holds"
sudo -u nrs node -e '
process.loadEnvFile(".env");
const { prisma } = require("./src/lib/db.js");
(async () => {
  const inv = await prisma.invoice.aggregate({ _min: { invoiceDate: true }, _max: { invoiceDate: true }, _count: true });
  const [lines, stock, sheets] = await Promise.all([
    prisma.invoiceLine.count(), prisma.stockQuant.count(), prisma.targetPeriod.count(),
  ]);
  const d = (x) => (x ? x.toISOString().slice(0, 10) : "—");
  console.log(`  ${inv._count} invoices · ${d(inv._min.invoiceDate)} → ${d(inv._max.invoiceDate)}`);
  console.log(`  ${lines} lines · ${stock} stock rows · ${sheets} target sheet(s)`);
  await prisma.$disconnect();
})();
'
echo
echo "  Next runs:"; systemctl list-timers 'nrs-sync*' --no-pager | head -4 | sed 's/^/    /'
echo
echo "  https://nrs.nouvelage.clinic"
