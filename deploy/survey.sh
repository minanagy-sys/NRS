#!/usr/bin/env bash
# What is on this droplet, before anything is changed.
#
#   sudo bash survey.sh
#
# STRICTLY READ-ONLY. It starts nothing, stops nothing, installs nothing and
# writes nothing — the only state it touches is a temp file it deletes. Run it,
# read it, and decide from there.
#
# It exists because this droplet is shared: nginx already serves other sites,
# Postgres has more than one cluster, and there are containers and PM2 processes
# that have nothing to do with this app. Knowing exactly what is there is the
# difference between an additive upgrade and an outage.

set -uo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8
unset LC_CTYPE LANGUAGE 2>/dev/null || true

APP_DIR=/opt/nrs
APP_USER=nrs
DB_NAME=nrs_sales
PORT=3020
DOMAIN=nrs.nouvelage.clinic

b() { printf '\n\033[1m━━ %s\033[0m\n' "$*"; }
i() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
none() { printf '  \033[2m— %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run with sudo — some of this needs root to read." >&2; exit 1; }

printf '\n\033[1mNRS droplet survey · %s · %s\033[0m\n' "$(hostname)" "$(date '+%Y-%m-%d %H:%M %Z')"
printf '\033[2mRead-only. Nothing below changes anything.\033[0m\n'

# ─────────────────────────────────────────────────────────────── the machine
b "The machine"
i "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") · kernel $(uname -r)"
i "up $(uptime -p 2>/dev/null | sed 's/^up //') · load$(cut -d' ' -f1-3 /proc/loadavg | sed 's/^/ /')"
i "memory: $(free -h | awk '/^Mem:/{print $3" used of "$2", "$7" available"}')"
echo
df -h / /var /opt 2>/dev/null | awk 'NR==1{print "  "$0} NR>1 && !seen[$1]++{print "  "$0}'
FREE_MB=$(df -Pm / | awk 'NR==2{print $4}')
(( FREE_MB < 2048 )) && warn "only ${FREE_MB} MB free on / — an upgrade wants headroom for node_modules"

# ──────────────────────────────────────────────────────────────────── ports
b "What is listening"
ss -lntpH 2>/dev/null | awk '{
  split($4,a,":"); port=a[length(a)];
  proc=$0; sub(/.*users:\(\("/,"",proc); sub(/".*/,"",proc);
  printf "  %-6s %-22s %s\n", port, $4, proc
}' | sort -n -k1 | uniq

# ──────────────────────────────────────────────────────────────────── nginx
b "nginx"
if command -v nginx >/dev/null; then
  i "$(nginx -v 2>&1)"
  if nginx -t >/dev/null 2>&1; then i "config test: OK"; else warn "config test FAILS right now — fix before deploying anything"; nginx -t 2>&1 | sed 's/^/    /'; fi
  echo
  i "sites-enabled:"
  for f in /etc/nginx/sites-enabled/*; do
    [[ -e "$f" ]] || continue
    names=$(grep -hoE '^\s*server_name\s+[^;]+' "$f" 2>/dev/null | sed 's/.*server_name\s*//' | tr '\n' ' ')
    printf '    %-24s %s\n' "$(basename "$f")" "${names:-（no server_name）}"
  done
  echo
  i "certificates:"
  if command -v certbot >/dev/null; then
    certbot certificates 2>/dev/null | awk '/Certificate Name:|Domains:|Expiry Date:/{gsub(/^ +/,"");print "    "$0}' || none "certbot listed nothing"
  else
    none "certbot not installed"
  fi
  echo
  i "total files under /etc/nginx: $(find /etc/nginx -type f 2>/dev/null | wc -l) — install.sh fingerprints every one of these before and after"
else
  none "nginx is not installed"
fi

# ────────────────────────────────────────────────────────────────── systemd
b "systemd — this app"
for unit in nrs.service nrs-sync-hourly.timer nrs-sync-nightly.timer; do
  if systemctl list-unit-files "$unit" >/dev/null 2>&1 && systemctl cat "$unit" >/dev/null 2>&1; then
    printf '    %-26s %-10s %-10s %s\n' "$unit" \
      "$(systemctl is-enabled "$unit" 2>/dev/null)" \
      "$(systemctl is-active "$unit" 2>/dev/null)" \
      "$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null | cut -c1-25)"
  else
    none "$unit is not installed"
  fi
done
echo
i "next scheduled runs:"
systemctl list-timers 'nrs-*' --no-pager 2>/dev/null | sed -n '1,4p' | sed 's/^/    /' || none "no nrs timers"

b "systemd — everything else running"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
  | awk '{print "    "$1}' | grep -vE 'systemd-|dbus|cron|ssh|rsyslog|polkit|udev|getty|user@' | head -25

# ────────────────────────────────────────────────────────────────── docker
b "Docker"
if command -v docker >/dev/null; then
  docker ps --format '    {{.Names}}  ·  {{.Image}}  ·  up {{.RunningFor}}  ·  {{.Ports}}' 2>/dev/null | head -20 \
    || warn "docker is installed but not answering"
  i "containers running: $(docker ps -q 2>/dev/null | wc -l) · stopped: $(docker ps -aq -f status=exited 2>/dev/null | wc -l)"
else
  none "docker is not installed"
fi

# ───────────────────────────────────────────────────────────────────── pm2
b "PM2"
if command -v pm2 >/dev/null; then
  pm2 list --no-color 2>/dev/null | sed 's/^/    /' | head -20
else
  for u in root $(ls /home 2>/dev/null); do
    if sudo -u "$u" -H pm2 list --no-color >/dev/null 2>&1; then
      i "pm2 belongs to user $u:"
      sudo -u "$u" -H pm2 list --no-color 2>/dev/null | sed 's/^/    /' | head -20
    fi
  done || none "pm2 not found"
fi

# ──────────────────────────────────────────────────────────────── postgres
b "PostgreSQL"
if command -v psql >/dev/null; then
  i "client $(psql --version | awk '{print $3}')"
  if command -v pg_lsclusters >/dev/null; then
    i "clusters:"
    pg_lsclusters 2>/dev/null | sed 's/^/    /'
  fi
  DB_PORT=$(sudo -u postgres psql -tAc 'show port' 2>/dev/null | xargs)
  if [[ -n "$DB_PORT" ]]; then
    i "the Debian cluster answers on port $DB_PORT"
    [[ "$DB_PORT" != "5432" ]] && warn "port 5432 is something else (a container) — the app must use $DB_PORT"
    echo
    i "databases:"
    sudo -u postgres psql -p "$DB_PORT" -tAF'|' -c \
      "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by pg_database_size(datname) desc" \
      2>/dev/null | awk -F'|' '{printf "    %-28s %s\n", $1, $2}'

    if sudo -u postgres psql -p "$DB_PORT" -tAc "select 1 from pg_database where datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
      echo
      i "$DB_NAME — rows per table:"
      sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -tAF'|' -c "
        select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc" 2>/dev/null \
        | awk -F'|' '{printf "    %-22s %10s\n", $1, $2}'
      echo
      i "migrations already applied:"
      sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -tAF'|' -c \
        "select migration_name, to_char(finished_at,'YYYY-MM-DD HH24:MI') from _prisma_migrations order by finished_at" 2>/dev/null \
        | awk -F'|' '{printf "    %-42s %s\n", $1, $2}' || none "no _prisma_migrations table"
      echo
      i "this version adds 3 more, all of them CREATE TABLE only:"
      i "  20260812125054_finance_tables · 20260812125331_collection_day · 20260812155723_recon_label_thin_movement"
      i "  no existing table is altered or dropped by any of them"
    else
      warn "database $DB_NAME does not exist on this cluster"
    fi
  else
    warn "could not ask Postgres which port it uses"
  fi
else
  none "psql is not installed"
fi

# ─────────────────────────────────────────────────────────────────── the app
b "The app at $APP_DIR"
if [[ -d "$APP_DIR" ]]; then
  i "owner $(stat -c '%U:%G' "$APP_DIR") · size $(du -sh "$APP_DIR" 2>/dev/null | cut -f1)"
  i "node $(node -v 2>/dev/null) · npm $(npm -v 2>/dev/null)"
  [[ -f "$APP_DIR/package.json" ]] && i "package: $(node -p "require('$APP_DIR/package.json').name+' '+(require('$APP_DIR/package.json').version||'')" 2>/dev/null)"
  echo
  i "top level:"
  ls -1 "$APP_DIR" 2>/dev/null | sed 's/^/    /'
  echo
  i "does it already have the finance code?"
  for f in src/routes/finance.js src/lib/finance.js public/nav.js public/finance.js; do
    [[ -f "$APP_DIR/$f" ]] && i "    present: $f" || none "   missing: $f  (this upgrade adds it)"
  done
  echo
  if [[ -f "$APP_DIR/.env" ]]; then
    i ".env is $(stat -c '%a %U:%G' "$APP_DIR/.env") — settings present (values NOT shown):"
    grep -oE '^[A-Z_]+' "$APP_DIR/.env" 2>/dev/null | sed 's/^/      /'
  else
    warn "$APP_DIR/.env is missing"
  fi
  echo
  i "most recent files (has anything been edited on the server?):"
  find "$APP_DIR" -type f -newermt '-30 days' \
    -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '    %TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null \
    | sort -r | head -8
else
  warn "$APP_DIR does not exist — this would be a first install, not an upgrade"
fi

# ─────────────────────────────────────────────────────────────── is it alive
b "Is it serving"
curl -s -o /dev/null -w "    localhost:$PORT/api/health → HTTP %{http_code} in %{time_total}s\n" --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || warn "nothing answered on $PORT"
curl -s --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | head -c 300 | sed 's/^/    /'; echo
curl -s -o /dev/null -w "    https://$DOMAIN → HTTP %{http_code}\n" --max-time 15 "https://$DOMAIN" 2>/dev/null || warn "the public URL did not answer"

b "Recent app log"
journalctl -u nrs.service -n 12 --no-pager -o cat 2>/dev/null | sed 's/^/    /' | cut -c1-160 || none "no journal for nrs.service"

b "Errors in the last day"
journalctl -u nrs.service --since '-1 day' -p err --no-pager -o cat 2>/dev/null | tail -8 | sed 's/^/    /' | cut -c1-160
[[ -z "$(journalctl -u nrs.service --since '-1 day' -p err --no-pager -o cat 2>/dev/null)" ]] && none "none"

# ────────────────────────────────────────────────────────────────── firewall
b "Firewall"
if command -v ufw >/dev/null; then ufw status 2>/dev/null | sed 's/^/    /' | head -12; else none "ufw not installed"; fi

b "Backups present?"
ls -lh /root/*.sql /root/*.dump /var/backups/*.sql* 2>/dev/null | sed 's/^/    /' | head -6 || none "no obvious database dumps in /root or /var/backups"

printf '\n\033[1m━━ Summary\033[0m\n'
i "Nothing above was modified."
i "If you are happy with what you see, the upgrade is: copy the code, run 3 additive"
i "migrations, restart nrs. No nginx file, no other site, no container and no other"
i "database is touched."
echo
