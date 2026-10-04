#!/usr/bin/env bash
# Everything running on this droplet, and which project each piece belongs to.
#
#   sudo bash inventory.sh
#
# STRICTLY READ-ONLY. Nothing is started, stopped, written or reloaded.
#
# survey.sh answers "what is the state of the NRS app". This answers the wider
# question: which domains exist, what serves each one, which process is behind
# it, where its code lives, and which database it uses — so nothing on this box
# is a mystery next time something needs deploying.

set -uo pipefail
export LC_ALL=C.UTF-8

b(){ printf '\n\033[1m━━ %s\033[0m\n' "$*"; }
n(){ printf '  \033[2m%s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
DB_PORT=$(sudo -u postgres psql -tAc 'show port' 2>/dev/null | xargs)

printf '\n\033[1mWhat is on this droplet · %s · %s\033[0m\n' "$(hostname)" "$(date '+%Y-%m-%d %H:%M %Z')"
printf '\033[2mRead-only. Nothing here changes anything.\033[0m\n'

# ── who owns each port ──────────────────────────────────────────────────────
b "Ports → process → where its code lives"
ss -lntpH 2>/dev/null | while read -r _ _ _ local _ users; do
  port=${local##*:}
  pid=$(sed -E 's/.*pid=([0-9]+).*/\1/' <<<"$users")
  [[ "$pid" =~ ^[0-9]+$ ]] || { printf '  %-6s %-18s %s\n' "$port" "?" "$users"; continue; }
  name=$(ps -o comm= -p "$pid" 2>/dev/null)
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-58)
  unit=$(ps -o unit= -p "$pid" 2>/dev/null | xargs)
  printf '  %-6s %-14s %-34s %s\n' "$port" "${name:-?}" "${cwd:-—}" "${unit:-$cmd}"
done | sort -n -k1 -u

# ── every domain, and what answers for it ───────────────────────────────────
b "Domains → what serves them"
for f in /etc/nginx/sites-enabled/*; do
  [[ -e "$f" ]] || continue
  names=$(grep -hoE '^[[:space:]]*server_name[[:space:]]+[^;]+' "$f" | sed -E 's/.*server_name[[:space:]]*//' | tr '\n' ' ' | tr -s ' ')
  printf '\n  \033[1m%s\033[0m\n' "$(basename "$f")"
  printf '    names   %s\n' "${names:-（none）}"
  # static roots
  grep -hoE '^[[:space:]]*root[[:space:]]+[^;]+' "$f" | sed -E 's/.*root[[:space:]]*//' | sort -u | while read -r r; do
    [[ -d "$r" ]] && printf '    static  %s  (%s)\n' "$r" "$(du -sh "$r" 2>/dev/null | cut -f1)" \
                  || printf '    static  %s  \033[31m(MISSING)\033[0m\n' "$r"
  done
  # proxied upstreams, with the location that reaches them
  awk '/location[[:space:]]/{loc=$2} /proxy_pass/{gsub(/;/,"",$2); print "    proxy   " loc "  →  " $2}' "$f" | sort -u
  # explicit returns, which is how api.nouvelage.clinic 404s its root on purpose
  awk '/location[[:space:]]/{loc=$2} /^[[:space:]]*return[[:space:]]/{gsub(/;/,"",$0); sub(/^[[:space:]]*/,"",$0); print "    rule    " loc "  →  " $0}' "$f" | sort -u | head -4
  cert=$(grep -hoE 'ssl_certificate[[:space:]]+[^;]+' "$f" | head -1 | sed -E 's/.*live\/([^/]+)\/.*/\1/')
  [[ -n "$cert" ]] && printf '    tls     %s\n' "$cert"
done

# ── docker ──────────────────────────────────────────────────────────────────
b "Docker containers → compose project and directory"
if command -v docker >/dev/null; then
  docker ps -q 2>/dev/null | while read -r id; do
    docker inspect "$id" --format '  {{.Name}}
    image   {{.Config.Image}}
    project {{index .Config.Labels "com.docker.compose.project"}}
    dir     {{index .Config.Labels "com.docker.compose.project.working_dir"}}
    ports   {{range $p, $c := .NetworkSettings.Ports}}{{$p}} {{end}}
    state   {{.State.Status}}, started {{.State.StartedAt}}' 2>/dev/null | sed 's|^  /|  |'
  done
else n "docker not installed"; fi

# ── pm2 ─────────────────────────────────────────────────────────────────────
b "PM2 apps"
if command -v pm2 >/dev/null; then
  pm2 jlist 2>/dev/null | tr ',' '\n' | grep -E '"(name|pm_cwd|pm_exec_path|status)":' \
    | sed -E 's/.*"(name|pm_cwd|pm_exec_path|status)":"?([^",]*)"?.*/  \1  \2/' || n "none"
else n "pm2 not installed"; fi

# ── systemd units that are not part of the base OS ──────────────────────────
b "Custom systemd units"
for u in $(systemctl list-unit-files --type=service,timer --state=enabled --no-pager --no-legend 2>/dev/null | awk '{print $1}'); do
  case "$u" in
    systemd-*|dbus*|cron*|ssh*|rsyslog*|polkit*|udev*|getty*|user@*|apport*|multipathd*|unattended*|ModemManager*|e2scrub*|networkd*|snapd*|man-db*|logrotate*|fstrim*|apt-daily*|dpkg*|motd*|console-setup*|keyboard*|blk-availability*|lvm2*|open-iscsi*|plymouth*|setvtrgb*|sysstat*|udisks2*|packagekit*|containerd*|docker*) continue;;
  esac
  exec_line=$(systemctl cat "$u" 2>/dev/null | grep -m1 -E '^(ExecStart|OnCalendar)=' | cut -c1-70)
  wd=$(systemctl show "$u" -p WorkingDirectory --value 2>/dev/null)
  printf '  %-26s %-10s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)" "${wd:-}"
  [[ -n "$exec_line" ]] && printf '    %s\n' "$exec_line"
done

# ── databases ───────────────────────────────────────────────────────────────
b "Databases"
n "PostgreSQL 16, port $DB_PORT (the Debian cluster)"
sudo -u postgres psql -p "$DB_PORT" -tAF'|' -c \
  "select datname, pg_size_pretty(pg_database_size(datname)),
          (select count(*) from pg_stat_user_tables) from pg_database
   where not datistemplate order by pg_database_size(datname) desc" 2>/dev/null \
  | awk -F'|' '{printf "    %-24s %10s\n", $1, $2}'
n "port 5432 is the Supabase container's own Postgres — separate cluster"
if command -v docker >/dev/null; then
  docker exec nouvelage-supabase-db-1 psql -U postgres -tAF'|' -c \
    "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database
     where not datistemplate order by 1" 2>/dev/null \
    | awk -F'|' '{printf "    %-24s %10s\n", $1, $2}' || n "    (could not query it; that is fine)"
fi
if command -v mysql >/dev/null; then
  n "MariaDB on 3306"
  mysql -N -B -e "select schema_name from information_schema.schemata" 2>/dev/null | sed 's/^/    /' || n "    (needs credentials)"
fi

# ── code on disk ────────────────────────────────────────────────────────────
b "Code directories"
for d in /opt/* /var/www/*; do
  [[ -d "$d" ]] || continue
  git=""
  [[ -d "$d/.git" ]] && git="git: $(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  printf '  %-34s %6s  %-12s %s\n' "$d" "$(du -sh "$d" 2>/dev/null | cut -f1)" "$(stat -c '%U' "$d")" "$git"
done

b "Disk and memory"
df -h / | awk 'NR==2{print "  / "$3" used of "$2", "$4" free ("$5")"}'
free -h | awk '/^Mem:/{print "  memory "$3" used of "$2", "$7" available"}'
echo
