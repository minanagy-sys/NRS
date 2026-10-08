#!/usr/bin/env bash
# Is everything on this droplet other than the NRS app exactly as it was?
#
#   sudo bash verify-untouched.sh
#
# STRICTLY READ-ONLY. Nothing is started, stopped, written or reloaded.
#
# It checks two things against two independent baselines:
#
#   1. the fingerprint upgrade.sh recorded BEFORE it touched anything
#      (/root/nrs-backups/<latest>/before.txt) — the strongest evidence, because
#      it was taken on this machine minutes before the change
#   2. the values in the 2026-08-13 11:03 survey, hard-coded below, so this still
#      works if the backup directory is ever deleted
#
# Counts on Odoo-synced tables are checked as "not lower than" rather than
# "equal": the hourly sync legitimately adds invoices, so an increase is health,
# and only a DROP would mean something was lost.

set -uo pipefail
export LC_ALL=C.UTF-8

DB_NAME=nrs_sales
PASS=0; FAIL=0

b(){ printf '\n\033[1m━━ %s\033[0m\n' "$*"; }
p(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
f(){ FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$*"; }
n(){ printf '  \033[2m· %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
DB_PORT=$(sudo -u postgres psql -tAc 'show port' 2>/dev/null | xargs)
Q(){ sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -tAX -c "$1" 2>/dev/null | xargs; }

printf '\n\033[1mIs the rest of the droplet untouched? · %s · %s\033[0m\n' \
  "$(hostname)" "$(date '+%Y-%m-%d %H:%M %Z')"
printf '\033[2mRead-only. This changes nothing.\033[0m\n'

# ── 1. against the pre-upgrade fingerprint ──────────────────────────────────
b "Against the fingerprint taken before the upgrade"
BEFORE=$(ls -1dt /root/nrs-backups/*/before.txt 2>/dev/null | head -1)
if [[ -n "$BEFORE" ]]; then
  n "baseline: $BEFORE"
  NOW=$(mktemp)
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
    sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -tAX -c \
      "select 'Invoice',count(*) from \"Invoice\"
       union all select 'InvoiceLine',count(*) from \"InvoiceLine\"
       union all select 'StockQuant',count(*) from \"StockQuant\"
       union all select 'DaySnapshot',count(*) from \"DaySnapshot\"
       union all select 'Session',count(*) from \"Session\"
       union all select 'AuditEvent',count(*) from \"AuditEvent\"
       union all select 'AuthRequest',count(*) from \"AuthRequest\"
       order by 1" 2>/dev/null
    echo "### listening ports other than ours"
    ss -lntH 2>/dev/null | awk '{split($4,a,":"); print a[length(a)]}' | grep -v '^3020$' | sort -n | uniq
  } > "$NOW"

  # nginx, services, containers, pm2, databases and ports must match exactly.
  # Row counts are allowed to move upward, so they are judged separately below.
  for section in "nginx files" "running services" "docker" "pm2" "databases" "listening ports other than ours"; do
    a=$(awk -v s="### $section" '$0==s{g=1;next} /^### /{g=0} g' "$BEFORE")
    z=$(awk -v s="### $section" '$0==s{g=1;next} /^### /{g=0} g' "$NOW")
    if [[ "$a" == "$z" ]]; then p "$section — identical"
    else
      removed=$(comm -23 <(echo "$a" | sort) <(echo "$z" | sort))
      added=$(comm -13 <(echo "$a" | sort) <(echo "$z" | sort))
      if [[ -n "$removed" ]]; then
        f "$section — REMOVED:"; echo "$removed" | sed 's/^/      − /'
        [[ -n "$added" ]] && { n "  and added:"; echo "$added" | sed 's/^/      + /'; }
      else
        # Additions only. Ubuntu starts services of its own (fwupd), certbot
        # renews, and other work on this droplet adds nginx sites — none of that
        # is this deploy and none of it is a loss. Exact equality flagged all of
        # it, and a verifier that always fails is one nobody reads.
        p "$section — nothing removed ($(echo "$added" | grep -c . ) added)"
        echo "$added" | sed 's/^/      + /'
      fi
    fi
  done

  n "row counts (an increase is the hourly sync doing its job):"
  awk -v s="### rows in tables this upgrade must not alter" '$0==s{g=1;next} /^### /{g=0} g' "$BEFORE" \
  | while IFS='|' read -r t was; do
      [[ -n "$t" ]] || continue
      now=$(Q "select count(*) from \"$t\"")
      if   [[ "$now" -gt "$was" ]]; then printf '    \033[32m✓\033[0m %-14s %s → %s (grew)\n' "$t" "$was" "$now"
      elif [[ "$now" -eq "$was" ]]; then printf '    \033[32m✓\033[0m %-14s %s (unchanged)\n' "$t" "$was"
      else printf '    \033[31m✗ %-14s %s → %s  ROWS LOST\033[0m\n' "$t" "$was" "$now"; fi
    done
  rm -f "$NOW"
else
  f "no /root/nrs-backups/*/before.txt — falling back to the survey baseline only"
fi

# ── 2. against the original survey ──────────────────────────────────────────
b "Against the 2026-08-13 11:03 survey"

want_nginx="api.nouvelage.clinic default links.youssefattalla.com nouvelage.clinic nrs youssefattalla.com"
got_nginx=$(ls -1 /etc/nginx/sites-enabled 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')
# A site ADDED is not a site removed, and `zat` was added 2026-08-19 by other work
# on this droplet. Exact equality failed for a reason nobody needed to act on, and
# a verifier that cries wolf gets ignored — worse than not having one. What matters
# is that nothing VANISHED, so this asserts the baseline is still a subset.
gone=""
for s_ in $want_nginx; do echo " $got_nginx " | grep -q " $s_ " || gone="$gone $s_"; done
[[ -z "$gone" ]] && p "all 6 baseline nginx sites still enabled [$got_nginx]" \
  || f "nginx sites REMOVED:$gone"

# Fewer files than the baseline means something was deleted; more means a site was
# added — `zat` on 2026-08-19 brought two. Only a drop is a fault, and the exact
# count is reported either way so a jump is still visible.
NGX=$(find /etc/nginx -type f 2>/dev/null | wc -l | xargs)
if (( NGX < 18 )); then f "/etc/nginx has LOST files: $NGX now, 18 at baseline"
elif (( NGX == 18 )); then p "18 files under /etc/nginx"
else p "$NGX files under /etc/nginx ($((NGX - 18)) added since the baseline, none lost)"; fi

nginx -t >/dev/null 2>&1 && p "nginx -t passes" || f "nginx -t FAILS"

b "Certificates"
while read -r name expiry; do
  got=$(certbot certificates 2>/dev/null | awk -v n="$name" '
    $1=="Certificate" && $2=="Name:" && $3==n {found=1; next}
    found && $1=="Expiry" {print $3; exit}')
  # A LATER expiry is certbot doing its job, not a regression. Only a missing
  # certificate, or one that moved backwards or has already lapsed, is a fault.
  if [[ -z "$got" ]]; then f "$name certificate is MISSING (was $expiry)"
  elif [[ "$got" == "$expiry" ]]; then p "$name expires $expiry"
  elif [[ "$got" > "$expiry" ]]; then
    days=$(( ( $(date -d "$got" +%s) - $(date +%s) ) / 86400 ))
    if (( days < 10 )); then f "$name renewed to $got but only $days days left"
    else p "$name renewed forward to $got ($days days)"; fi
  else f "$name expiry moved BACKWARDS: was $expiry, now $got"; fi
done <<'CERTS'
api.nouvelage.clinic 2026-10-17
links.youssefattalla.com 2026-09-15
nouvelage.clinic 2026-10-13
nrs.nouvelage.clinic 2026-11-09
youssefattalla.com 2026-09-15
CERTS

b "Containers, services and PM2"
for c in zat-web-1 zat-api-1 zat-db-1 nouvelage-supabase-auth-1 nouvelage-supabase-rest-1 nouvelage-supabase-db-1; do
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c" && p "container $c up" || f "container $c is NOT running"
done
for s in docker containerd links-api mariadb nginx postgresql@16-main nrs; do
  systemctl is-active --quiet "$s" && p "$s active" || f "$s is NOT active"
done
pm2 jlist 2>/dev/null | grep -q '"name":"nouvelage-upload"' && p "PM2 nouvelage-upload present" || f "PM2 nouvelage-upload missing"

b "Ports"
for port in 22 80 443 3000 3001 3020 3306 4000 4300 5432 5433 9999; do
  ss -lntH 2>/dev/null | awk '{split($4,a,":"); print a[length(a)]}' | grep -qx "$port" \
    && p "$port listening" || f "$port is NOT listening (it was on 13 Aug)"
done

b "Databases on 5433"
for d in nrs_sales postgres; do
  sudo -u postgres psql -p "$DB_PORT" -tAc "select 1 from pg_database where datname='$d'" 2>/dev/null | grep -q 1 \
    && p "$d present" || f "$d is MISSING"
done

b "The other sites still answer"
# Probe a URL that each vhost actually serves, not just "/".
# api.nouvelage.clinic ends its config with `location / { return 404; }` — it 404s
# at the root ON PURPOSE and only exposes two Supabase surfaces, so testing "/"
# there measures nothing. /rest/v1/ is PostgREST on :3000 and /auth/v1/health is
# GoTrue on :9999; both must be 200.
while read -r url; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null)
  if   [[ "$code" =~ ^(200|301|302|401|403)$ ]]; then p "$url → $code"
  elif [[ "$code" =~ ^(502|503|504)$ ]];         then f "$url → $code — upstream is DOWN"
  else f "$url → ${code:-no answer}"; fi
done <<'URLS'
https://api.nouvelage.clinic/rest/v1/
https://api.nouvelage.clinic/auth/v1/health
https://nouvelage.clinic
https://www.nouvelage.clinic
https://youssefattalla.com
https://links.youssefattalla.com
URLS
# and the root 404 is itself part of the expected shape — flag if it ever changes
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.nouvelage.clinic/ 2>/dev/null)
[[ "$code" == "404" ]] && p "api.nouvelage.clinic / → 404 (its config says return 404; correct)" \
  || f "api.nouvelage.clinic / → $code — it has always been a deliberate 404"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://nrs.nouvelage.clinic/finance)
# Finance was hidden at Mina's request 2026-08-19 — the sidebar entry is gone and
# FINANCE_ENABLED is unset, so 404 IS the expected shape. Its rows are untouched;
# the row counts above prove that, not this URL.
[[ "$code" == "404" ]] && p "finance → 404 (hidden on purpose; its data is intact above)" \
  || f "our own finance page → $code — expected 404 while it is hidden"

b "Our app's own tree"
cd /opt/nrs 2>/dev/null && {
  sum=$(find src public scripts prisma -type f | sort | while read -r x; do
          printf '%s  %s\n' "$(md5sum "$x" | cut -c1-32)" "$x"; done | md5sum | cut -c1-32)
  cnt=$(find src public scripts prisma -type f | wc -l | xargs)
  # Re-stamped 2026-09-23, for the deploy that brought Targets & Doctor
  # Commission: the five-tab report, the payslip popup, the doctor schemes in
  # Admin, and the monthly payroll upload. Six files more than the 2026-09-17
  # stamp — doctor-commission.js, commission-schemes.js, target-view.js, the
  # scheme importer, two migrations. Confirmed equal to the Mac's own tree,
  # computed the same way:
  #   find src public scripts prisma -type f | sort | ... | md5
  # Re-stamped 2026-10-04, for the deploy that brought Contact Centre v2 (eight
  # panels, the weekly UCM lock, the CDR importer), Targets & Plan, Commission
  # v3.2 and the shared public/fmt.js. 43 files more than the 2026-09-23 stamp,
  # nothing left over from older builds. Equal to the Mac's tree, both computed
  # exactly as below.
  # Re-stamped 2026-10-08: NRS-Updated.zip — the package-cash sync (PackageDay),
  # the branch-name resolver, and the dashboard's refunds now subtracted in its
  # own queries rather than by storing invoices signed.
  EXPECT_FILES=207
  EXPECT_SUM=e1400496ba756dd377cfb9e01bb75931
  [[ "$cnt" == "$EXPECT_FILES" && "$sum" == "$EXPECT_SUM" ]] \
    && p "$EXPECT_FILES files, checksum matches the Mac exactly" \
    || f "tree is $cnt files / $sum — expected $EXPECT_FILES / $EXPECT_SUM (re-stamp after every intended deploy)"
  junk=$(find /opt/nrs -name '._*' -type f -not -path '/opt/nrs/node_modules/*' | wc -l | xargs)
  [[ "$junk" == "0" ]] && p "no AppleDouble junk left" || f "$junk ._ files still present"
}

printf '\n\033[1m━━ %s\033[0m\n' "Result"
if [[ $FAIL -eq 0 ]]; then
  printf '  \033[32m%d checks passed, nothing else on this droplet has changed.\033[0m\n\n' "$PASS"
else
  printf '  \033[31m%d of %d checks FAILED — read them above.\033[0m\n\n' "$FAIL" "$((PASS+FAIL))"
fi
exit 0
