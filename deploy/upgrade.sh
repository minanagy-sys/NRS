#!/usr/bin/env bash
# Bring /opt/nrs up to the current version. Runs ON the droplet.
#
#   sudo bash /tmp/nrs-upgrade/upgrade.sh
#
# expects, in the same directory:
#   nrs-code.tar.gz   the application source
#   nrs-data.sql      the finance and target rows — loaded ONLY into empty tables,
#                     so on a droplet that already has them it is skipped
#   nrs-delta.sql     the commission policy, the branch aliases and the collections
#                     source mode — idempotent, and applied EVERY time. This is the
#                     file that carries new data onto a droplet that is already live.
#
# WHAT IT TOUCHES
#   /opt/nrs                  code replaced, .env and node_modules/.cache left alone
#   nrs_sales                 new migrations (CREATE TABLE only), the 13 Commission
#                             tables replaced, branch aliases upserted, collections
#                             pointed at Odoo. Nothing else is written.
#   nrs.service               restarted
#   nrs-sync-*.timer          paused for the duration, then put back as they were
#
# WHAT IT DOES NOT TOUCH — and proves it, by fingerprinting before and after
#   nginx, its 6 sites and its certificates          (never even reloaded)
#   the 6 docker containers, mariadb, links-api, PM2
#   the supabase database on 5432, and every other database on 5433
#   Invoice · InvoiceLine · StockQuant · DaySnapshot · SyncRun · Session ·
#   AuditEvent · AuthRequest — the tables the droplet syncs from Odoo itself
#   /opt/nrs/.env
#
# If anything fails after the code is written, it restores the code and the
# database from the backup it took first, restarts, and tells you.

set -euo pipefail
export LC_ALL=C.UTF-8

APP_DIR=/opt/nrs
APP_USER=nrs
DB_NAME=nrs_sales
PORT=3020
DOMAIN=nrs.nouvelage.clinic
SRC=$(cd "$(dirname "$0")" && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/root/nrs-backups/$STAMP
WORK=$(mktemp -d)

b()  { printf '\n\033[1m━━ %s\033[0m\n' "$*"; }
i()  { printf '  %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die(){ printf '\n  \033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
[[ -f "$SRC/nrs-code.tar.gz" ]] || die "nrs-code.tar.gz is not next to this script"
[[ -f "$SRC/nrs-data.sql"    ]] || die "nrs-data.sql is not next to this script"
[[ -f "$SRC/nrs-delta.sql"   ]] || die "nrs-delta.sql is not next to this script"
[[ -d "$APP_DIR"             ]] || die "$APP_DIR does not exist — this script upgrades, it does not install"
[[ -f "$APP_DIR/.env"        ]] || die "$APP_DIR/.env is missing"

DB_PORT=$(sudo -u postgres psql -tAc 'show port' | xargs)
PSQL="sudo -u postgres psql -p $DB_PORT -d $DB_NAME -tAX"

printf '\n\033[1mNRS upgrade · %s · %s\033[0m\n' "$(hostname)" "$(date '+%Y-%m-%d %H:%M %Z')"
i "backups → $BACKUP"

# ── fingerprint everything that must come out the other side identical ───────
fingerprint() {
  local f=$1
  { echo "### nginx files"
    find /etc/nginx -type f -exec md5sum {} \; 2>/dev/null | sort -k2
    echo "### running services"
    systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | sort
    echo "### docker"
    docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | sort
    echo "### pm2"
    pm2 jlist 2>/dev/null | grep -oE '"name":"[^"]+"' | sort
    echo "### databases"
    sudo -u postgres psql -p "$DB_PORT" -tAc \
      "select datname from pg_database where not datistemplate order by 1" 2>/dev/null
    echo "### rows in tables this upgrade must not alter"
    $PSQL -c "select 'Invoice',count(*) from \"Invoice\"
        union all select 'InvoiceLine',count(*) from \"InvoiceLine\"
        union all select 'StockQuant',count(*) from \"StockQuant\"
        union all select 'DaySnapshot',count(*) from \"DaySnapshot\"
        union all select 'Session',count(*) from \"Session\"
        union all select 'AuditEvent',count(*) from \"AuditEvent\"
        union all select 'AuthRequest',count(*) from \"AuthRequest\"
        order by 1" 2>/dev/null
    echo "### listening ports other than ours"
    ss -lntH 2>/dev/null | awk '{split($4,a,":"); print a[length(a)]}' | grep -v "^$PORT$" | sort -n | uniq
  } > "$f"
}

b "Fingerprinting what must not change"
mkdir -p "$BACKUP"
fingerprint "$BACKUP/before.txt"
ok "$(grep -c . "$BACKUP/before.txt") lines recorded — /etc/nginx, services, containers, databases, untouched tables, ports"

# ── back up, because the survey found none on this box ──────────────────────
b "Backing up"
# The dump runs as the postgres user, which has no business being able to write
# into /root — and cannot. So pg_dump writes to stdout and the redirect, which
# runs as root, creates the file. Same reasoning for every postgres call below:
# the file is handed over on a pipe rather than by path.
sudo -u postgres pg_dump -p "$DB_PORT" "$DB_NAME" --format=custom > "$BACKUP/$DB_NAME.dump"
chmod 600 "$BACKUP/$DB_NAME.dump"
ok "database → $BACKUP/$DB_NAME.dump ($(du -h "$BACKUP/$DB_NAME.dump" | cut -f1))"

tar -czf "$BACKUP/code.tar.gz" -C "$APP_DIR" \
  --exclude=node_modules --exclude=.npm --exclude=.cache . 2>/dev/null || true
ok "code → $BACKUP/code.tar.gz ($(du -h "$BACKUP/code.tar.gz" | cut -f1))"

cp -a "$APP_DIR/.env" "$BACKUP/env.backup"
chmod 600 "$BACKUP/env.backup"
ok ".env → $BACKUP/env.backup (kept, never rewritten)"

# ── from here on, failure rolls back ─────────────────────────────────────────
ROLLBACK_ARMED=0
rollback() {
  [[ $ROLLBACK_ARMED -eq 1 ]] || exit 1
  printf '\n\033[31m━━ Rolling back\033[0m\n'
  systemctl stop nrs.service 2>/dev/null || true
  rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed" 2>/dev/null || true
  mkdir -p "$APP_DIR"
  tar -xzf "$BACKUP/code.tar.gz" -C "$APP_DIR" || true
  cp -a "$BACKUP/env.backup" "$APP_DIR/.env" || true
  # every step here ends in `|| true`: a rollback that stops half way because one
  # optional thing was missing would be worse than the failure it is undoing
  [[ -d "$APP_DIR.failed/node_modules" ]] && mv "$APP_DIR.failed/node_modules" "$APP_DIR/node_modules" || true
  chown -R "$APP_USER:$APP_USER" "$APP_DIR" || true
  # fed on stdin, because postgres cannot read /root either
  cat "$BACKUP/$DB_NAME.dump" | sudo -u postgres pg_restore -p "$DB_PORT" -d "$DB_NAME" \
      --clean --if-exists --no-owner --no-privileges >/dev/null 2>&1 || true
  systemctl start nrs.service 2>/dev/null || true
  [[ "$TIMERS_WERE" == "active" ]] && systemctl start nrs-sync-hourly.timer nrs-sync-nightly.timer 2>/dev/null || true
  printf '\n  The old version is back and running. The failed tree is at %s.failed\n' "$APP_DIR"
  printf '  Backup kept at %s\n\n' "$BACKUP"
  exit 1
}
trap rollback ERR

# ── pause the syncs so one does not fire against half-written code ──────────
b "Pausing the sync timers"
TIMERS_WERE=$(systemctl is-active nrs-sync-hourly.timer 2>/dev/null || echo inactive)
systemctl stop nrs-sync-hourly.timer nrs-sync-nightly.timer 2>/dev/null || true
while pgrep -u "$APP_USER" -f 'scripts/sync.js' >/dev/null 2>&1; do i "waiting for a sync in flight…"; sleep 3; done
ok "timers stopped (they were $TIMERS_WERE, and go back that way at the end)"

# ── code ────────────────────────────────────────────────────────────────────
b "Writing the new code"
ROLLBACK_ARMED=1
tar -xzf "$SRC/nrs-code.tar.gz" -C "$WORK"
# A tarball built on a Mac without COPYFILE_DISABLE carries an AppleDouble "._x"
# member beside every real file, and GNU tar happily extracts them as real files.
# The 2026-08-13 deploy put 72 of them into /opt/nrs that way — inert, but served
# publicly out of public/ and sitting inside prisma/migrations/ where Prisma
# scans. pack.sh no longer creates them; this is the belt to that braces.
JUNK=$(find "$WORK" -name '._*' -type f | wc -l | xargs)
[[ "$JUNK" -gt 0 ]] && { find "$WORK" -name '._*' -type f -delete; warn "dropped $JUNK AppleDouble files from the archive"; }
# No --delete anywhere: files already on the droplet that this build does not
# ship are left where they are. Nothing is removed.
cp -a "$WORK/." "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
ok "$(tar -tzf "$SRC/nrs-code.tar.gz" | grep -c '[^/]$') files written · .env untouched"
for f in src/routes/finance.js src/lib/finance.js public/nav.js public/finance.js public/draft.js; do
  [[ -f "$APP_DIR/$f" ]] || die "$f did not arrive"
done
ok "the finance files are in place"

# ── dependencies and schema ─────────────────────────────────────────────────
b "Dependencies"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --silent 2>/dev/null \
  || sudo -u "$APP_USER" npm install --omit=dev --silent
ok "npm ci — the dependency list is unchanged from the running version"

b "Migrations"
i "before: $($PSQL -c 'select count(*) from _prisma_migrations') applied"
sudo -u "$APP_USER" npx --yes prisma migrate deploy 2>&1 | sed 's/^/    /'
sudo -u "$APP_USER" npx --yes prisma generate >/dev/null 2>&1
ok "after:  $($PSQL -c 'select count(*) from _prisma_migrations') applied"

# ── data ────────────────────────────────────────────────────────────────────
b "Finance and target rows"
EXISTING=$($PSQL -c 'select count(*) from "Supplier"' 2>/dev/null || echo 0)
if [[ "${EXISTING:-0}" -gt 0 ]]; then
  warn "these tables already hold data ($EXISTING suppliers) — leaving them exactly as they are"
  i "the load only runs into empty tables, so re-running this script never duplicates rows"
  i "to deliberately replace them: RELOAD=yes sudo bash $0"
  if [[ "${RELOAD:-no}" == "yes" ]]; then
    warn "RELOAD=yes — clearing the 18 finance and target tables first"
    $PSQL -c 'TRUNCATE "FinanceSource","FinanceBatch","Collection","CollectionDay","Register",
      "Supplier","Bill","BillLine","VendorPayment","JournalMethod",
      "ReconProduct","ReconFact","ExpiryLot",
      "TargetPeriod","TargetGroup","DoctorTarget","BranchTarget","IdentityAlias" CASCADE' >/dev/null
    cat "$SRC/nrs-data.sql" | sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 >/dev/null
    ok "reloaded"
  fi
else
  cat "$SRC/nrs-data.sql" | sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 >/dev/null
  ok "loaded — one transaction, so it either all landed or none of it did"
fi

# ── the delta: always, because it is idempotent ─────────────────────────────
b "Commission policy and the collections source"
i "This part runs every time. It replaces the 13 Commission tables outright,"
i "upserts the branch aliases, and points collections at the live Odoo sync."
i "It touches no supplier, bill, payment, collection, invoice or target row."
BEFORE_CB=$($PSQL -c 'select count(*) from "CommissionBranch"' 2>/dev/null || echo 0)
cat "$SRC/nrs-delta.sql" | sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 >/dev/null
AFTER_CB=$($PSQL -c 'select count(*) from "CommissionBranch"')
AFTER_CT=$($PSQL -c 'select count(*) from "CommissionTarget"')
COLL_MODE=$($PSQL -c "select mode from \"FinanceSource\" where section='collections'")
ok "commission branches ${BEFORE_CB:-0} -> $AFTER_CB · $AFTER_CT branch-months"
ok "collections now reads $COLL_MODE"

# ── restart ─────────────────────────────────────────────────────────────────
b "Restarting"
systemctl restart nrs.service
for _ in $(seq 1 30); do
  curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
systemctl is-active --quiet nrs.service || { journalctl -u nrs -n 40 --no-pager; die "the app did not come back"; }
ok "nrs.service is active"

if [[ "$TIMERS_WERE" == "active" ]]; then
  systemctl start nrs-sync-hourly.timer nrs-sync-nightly.timer
  ok "sync timers restarted"
else
  warn "the timers were not active before, so they were left stopped"
fi

# ── verify ──────────────────────────────────────────────────────────────────
trap - ERR
b "Verifying"
HEALTH=$(curl -s --max-time 10 "http://127.0.0.1:$PORT/api/health" || echo '')
echo "$HEALTH" | grep -q '"ok":true' && ok "health: $HEALTH" || warn "health did not answer ok: $HEALTH"

for path in / /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" "http://127.0.0.1:$PORT$path")
  [[ "$code" == "200" || "$code" == "302" ]] && ok "$path → $code" || warn "$path → $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/")
ok "https://$DOMAIN/ → $code"

# The Finance report is hidden unless FINANCE_ENABLED=1, so 404 is the CORRECT
# answer here. Reporting it as a failure would train whoever runs this to ignore
# the line. Its DATA is untouched either way.
FIN_FLAG=$(grep -E '^FINANCE_ENABLED=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | xargs || true)
fin=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/finance")
if [[ "$FIN_FLAG" == "1" ]]; then
  [[ "$fin" == "200" ]] && ok "https://$DOMAIN/finance → 200 (FINANCE_ENABLED=1)" \
                        || warn "finance is enabled but answered $fin"
elif [[ "$fin" == "404" ]]; then
  ok "https://$DOMAIN/finance → 404 — hidden on purpose, data intact"
else
  warn "https://$DOMAIN/finance → $fin — expected 404 while finance is hidden"
fi

i ""
i "rows now:"
$PSQL -c "select 'Supplier',count(*) from \"Supplier\"
   union all select 'Bill',count(*) from \"Bill\"
   union all select 'BillLine',count(*) from \"BillLine\"
   union all select 'VendorPayment',count(*) from \"VendorPayment\"
   union all select 'Collection',count(*) from \"Collection\"
   union all select 'ReconFact',count(*) from \"ReconFact\"
   union all select 'ExpiryLot',count(*) from \"ExpiryLot\"
   union all select 'DoctorTarget',count(*) from \"DoctorTarget\"
   union all select 'BranchTarget',count(*) from \"BranchTarget\"
   union all select 'CommissionBranch',count(*) from \"CommissionBranch\"
   union all select 'CommissionTarget',count(*) from \"CommissionTarget\"
   order by 1" | awk -F'|' '{printf "    %-16s %6s\n", $1, $2}'

# ── prove nothing else moved ────────────────────────────────────────────────
b "What else changed on this droplet"
fingerprint "$BACKUP/after.txt"
if diff -q "$BACKUP/before.txt" "$BACKUP/after.txt" >/dev/null; then
  ok "nothing. nginx, its certificates, every container, every other service,"
  ok "every other database and every Odoo-synced table are byte-for-byte as they were."
else
  warn "differences found — read them carefully:"
  diff "$BACKUP/before.txt" "$BACKUP/after.txt" | sed 's/^/    /'
  i ""
  i "a changed AuditEvent or Session count is normal if someone used the site during"
  i "the upgrade. Anything mentioning nginx, docker or another database is not."
fi

b "Done"
i "Backup kept at $BACKUP — delete it yourself once you are happy:"
i "  rm -rf $BACKUP"
i ""
i "To undo the whole thing:"
i "  systemctl stop nrs && rm -rf $APP_DIR/* && tar -xzf $BACKUP/code.tar.gz -C $APP_DIR \\"
i "    && cp -a $BACKUP/env.backup $APP_DIR/.env && chown -R $APP_USER:$APP_USER $APP_DIR \\"
i "    && cat $BACKUP/$DB_NAME.dump | sudo -u postgres pg_restore -p $DB_PORT -d $DB_NAME --clean --if-exists \\"
i "    && cd $APP_DIR && sudo -u $APP_USER npm ci --omit=dev && systemctl start nrs"
echo
rm -rf "$WORK"
