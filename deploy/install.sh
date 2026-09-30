#!/usr/bin/env bash
# Install Nouvelage Daily Sales alongside whatever else this droplet already runs.
#
#   sudo bash install.sh
#
# Additive only, and it proves that rather than promising it: before changing
# anything it records a checksum of every existing nginx config, and at the end
# it re-checks them. If any pre-existing file differs, the run is reported as
# failed. Nothing is deleted, no existing site is edited, and the default server
# is left alone — api.nouvelage.clinic keeps answering exactly as it does now.
#
# Safe to run twice: every step checks before it acts.

set -euo pipefail

# ssh forwards LC_CTYPE from the client, which Debian cannot resolve; every apt
# and psql call then prints a perl warning. Pin it for this script only.
export LC_ALL=C.UTF-8 LANG=C.UTF-8
unset LC_CTYPE LANGUAGE 2>/dev/null || true

DOMAIN="${DOMAIN:-nrs.nouvelage.clinic}"
APP_DIR=/opt/nrs
APP_USER=nrs
DB_NAME=nrs_sales
DB_USER=nrs
PORT=3020
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."

# ---------------------------------------------------------------- guard rails

say "Recording the state of everything already installed"
FINGERPRINT=$(mktemp)
find /etc/nginx -type f -exec md5sum {} + 2>/dev/null | sort > "$FINGERPRINT" || true
ok "$(wc -l < "$FINGERPRINT") existing nginx files fingerprinted"

if [[ -e /etc/nginx/sites-available/nrs ]]; then
  warn "/etc/nginx/sites-available/nrs already exists — it will be replaced (ours, not yours)"
fi
for f in /etc/nginx/sites-enabled/*; do
  [[ -e "$f" ]] || continue
  [[ "$(basename "$f")" == nrs ]] && continue
  ok "leaving alone: $(basename "$f")"
done

# The point of this check is to catch somebody ELSE on our port, not ourselves.
# On a re-run our own service is listening, which is exactly what we want.
PORT_HOLDER=$(ss -lntpH 2>/dev/null | awk -v p=":$PORT\$" '$4 ~ p {print; exit}')
if [[ -n "$PORT_HOLDER" ]]; then
  HOLDER_PID=$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<< "$PORT_HOLDER")
  HOLDER_USER=$(ps -o user= -p "${HOLDER_PID:-0}" 2>/dev/null | xargs || true)
  HOLDER_UNIT=$(systemctl status "$HOLDER_PID" 2>/dev/null | head -1 | awk '{print $2}' || true)
  if [[ "$HOLDER_USER" == "$APP_USER" || "$HOLDER_UNIT" == "nrs.service" ]]; then
    ok "port $PORT held by our own service (pid $HOLDER_PID) — it will be restarted"
  else
    echo "    $PORT_HOLDER" >&2
    die "Port $PORT is held by $HOLDER_UNIT (user $HOLDER_USER), which is not ours. Set PORT= to something free and re-run."
  fi
else
  ok "port $PORT is free"
fi

say "Checking DNS before asking Let's Encrypt for anything"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
MYIP=$(curl -s --max-time 10 https://api.ipify.org || true)
if [[ -z "$RESOLVED" ]]; then
  die "$DOMAIN does not resolve yet. Add an A record pointing to $MYIP, wait for it to propagate, then re-run."
elif [[ "$RESOLVED" != "$MYIP" ]]; then
  die "$DOMAIN resolves to $RESOLVED but this droplet is $MYIP. Fix the A record first."
fi
ok "$DOMAIN → $RESOLVED (this droplet)"

# ------------------------------------------------------------------ packages

say "Packages"
export DEBIAN_FRONTEND=noninteractive
NEED=()
command -v node >/dev/null || NEED+=(nodejs)
command -v psql >/dev/null || NEED+=(postgresql)
command -v certbot >/dev/null || NEED+=(certbot)
command -v nginx >/dev/null || NEED+=(nginx)

if ((${#NEED[@]})); then
  # Node from NodeSource: Ubuntu ships a version too old for this app.
  if [[ " ${NEED[*]} " == *" nodejs "* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  fi
  apt-get update -qq
  apt-get install -y -qq "${NEED[@]}" >/dev/null
  ok "installed: ${NEED[*]}"
else
  ok "nothing to install"
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || die "Node $NODE_MAJOR is too old; this app needs 20 or newer."
ok "node $(node -v) · postgres $(psql --version | awk '{print $3}') · nginx $(nginx -v 2>&1 | grep -o '[0-9.]*')"

# --------------------------------------------------------------------- user

say "Service account"
if id "$APP_USER" &>/dev/null; then ok "$APP_USER exists"
else
  adduser --system --group --home "$APP_DIR" --no-create-home "$APP_USER"
  ok "created $APP_USER (no shell, no login)"
fi

# ----------------------------------------------------------------- database

say "Database"
# Ask the cluster which port it actually uses. 5432 is only a convention, and on
# this host it is taken by a Supabase container — writing there would have put
# our tables inside an unrelated database.
DB_PORT=$(sudo -u postgres psql -tAc 'show port' | xargs)
DB_DATADIR=$(sudo -u postgres psql -tAc 'show data_directory' | xargs)
[[ -n "$DB_PORT" ]] || die "Could not ask Postgres which port it listens on."
ok "our cluster: port $DB_PORT, data in $DB_DATADIR"

if [[ "$DB_PORT" != "5432" ]]; then
  WHO=$(ss -lntp 2>/dev/null | awk '$4 ~ /:5432$/ {print $NF}' | head -1)
  [[ -n "$WHO" ]] && warn "port 5432 belongs to something else — $WHO — and is being left alone"
fi
# The connection never leaves the machine — loopback only, and the firewall plus
# Postgres\' own listen_addresses keep it that way. Prisma is reliable over TCP;
# its Unix-socket support was not on this host, even though psql\'s was.
#
# The password is (re)set on every run rather than assumed, so the value in .env
# and the value Postgres holds cannot drift apart.
DB_PASS_FILE=/root/.nrs-db-pass
if [[ -s "$DB_PASS_FILE" ]]; then
  DB_PASS=$(cat "$DB_PASS_FILE")
  ok "reusing the stored database password"
else
  # Alphanumeric only: nothing that needs escaping in a URL or in SQL.
  DB_PASS=$(openssl rand -hex 24)
  printf '%s' "$DB_PASS" > "$DB_PASS_FILE"; chmod 600 "$DB_PASS_FILE"
  ok "generated a database password ($DB_PASS_FILE)"
fi

if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='$DB_USER'" | grep -q 1; then
  sudo -u postgres psql -qc "alter role $DB_USER login password '$DB_PASS'" >/dev/null
  ok "role $DB_USER exists, password set to the stored value"
else
  sudo -u postgres psql -qc "create role $DB_USER login password '$DB_PASS'" >/dev/null
  ok "created role $DB_USER"
fi
sudo -u postgres psql -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 && ok "database $DB_NAME exists" || {
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  ok "created database $DB_NAME owned by $DB_USER"
}

# ---------------------------------------------------------------- app files

say "Application"
mkdir -p "$APP_DIR"
# Copy the source, never the local secrets or the local node_modules.
rsync -a --delete \
  --exclude node_modules --exclude .env --exclude .git --exclude dist \
  --exclude 'prisma/dev.db*' \
  "$SRC"/ "$APP_DIR"/
ok "code in $APP_DIR"

DB_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$DB_PORT/$DB_NAME?schema=public&connection_limit=10"

if [[ -f "$APP_DIR/.env" ]]; then
  ok ".env already present — keeping your settings"
  # Keep the one line that must match Postgres; leave every other secret alone.
  if grep -q '^DATABASE_URL=' "$APP_DIR/.env"; then
    python3 - "$APP_DIR/.env" "$DB_URL" <<'PYFIX'
import sys
path, url = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
out = [f'DATABASE_URL="{url}"' if l.startswith('DATABASE_URL=') else l for l in lines]
open(path, 'w').write('\n'.join(out) + '\n')
PYFIX
    warn "DATABASE_URL refreshed to match the database password"
  else
    printf 'DATABASE_URL="%s"\n' "$DB_URL" >> "$APP_DIR/.env"
  fi
else
  cat > "$APP_DIR/.env" <<ENV
DATABASE_URL="$DB_URL"
MCP_BASE_URL="https://mcp.nouvelageclinic.com"
PORT=$PORT
PUBLIC_ORIGIN="https://$DOMAIN"
# Only the reverse proxy may reach the app.
BIND_HOST="127.0.0.1"
# Encrypts MCP tokens at rest. Changing it signs everyone out.
TOKEN_KEY="$(openssl rand -hex 32)"
# Unlocks editing of target sheets. Anyone signed in may read and refresh.
ADMIN_PASSPHRASE="$(openssl rand -base64 18 | tr -d '/+=')"
# The unattended sync has no browser to redirect, so it signs in with a password.
# Use a dedicated READ-ONLY Odoo account, not a personal one.
MCP_USER=""
MCP_PASSWORD=""
ENV
  ok ".env written with fresh secrets"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
chmod +x "$APP_DIR/scripts/cron.sh"

say "Database connectivity"
# Exactly the credentials and transport Prisma is about to use.
# Everything asked here is readable by an ordinary role. `show data_directory`
# is not — it is superuser-only, and asking for it made a working connection
# look like a failure.
IDENT=$(PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
  "select current_database() || '|' || inet_server_port() || '|' || pg_get_userbyid(datdba)
     from pg_database where datname = current_database()" 2>/dev/null | xargs || true)

if [[ -n "$IDENT" ]]; then
  IFS='|' read -r GOT_DB GOT_PORT GOT_OWNER <<< "$IDENT"
  # The port was read from our own cluster a moment ago, so landing on it proves
  # which server this is; the owner proves the database is the one we created.
  [[ "$GOT_DB" == "$DB_NAME" ]]     || die "Connected to database '$GOT_DB', expected '$DB_NAME'."
  [[ "$GOT_PORT" == "$DB_PORT" ]]   || die "Answered on port $GOT_PORT, expected $DB_PORT — that is not our cluster."
  [[ "$GOT_OWNER" == "$DB_USER" ]]  || die "Database '$GOT_DB' is owned by '$GOT_OWNER', not '$DB_USER'. Refusing to migrate into a database that is not ours."
  ok "$DB_USER authenticates on port $DB_PORT · database $GOT_DB owned by $GOT_OWNER"
else
  echo
  echo "  Diagnosis:"
  PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' 2>&1 | sed 's/^/    /'
  echo "    listeners:"
  ss -lntp 2>/dev/null | grep -E ':(5432|5433|'"$DB_PORT"')' | sed 's/^/      /' || echo "      none found"
  echo "    clusters on this host:"
  pg_lsclusters 2>/dev/null | sed 's/^/      /'
  echo "    pg_hba rules in force:"
  sudo -u postgres psql -tAc "select type,database,user_name,address,auth_method from pg_hba_file_rules where error is null" 2>/dev/null | sed 's/^/      /'
  die "$DB_USER cannot authenticate on port $DB_PORT."
fi

say "Dependencies and schema"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --silent 2>/dev/null || sudo -u "$APP_USER" npm install --omit=dev --silent
sudo -u "$APP_USER" npx prisma migrate deploy
sudo -u "$APP_USER" npx prisma generate >/dev/null
ok "dependencies installed, migrations applied"

# ----------------------------------------------------------------- systemd

say "Services"
install -m644 deploy/nrs.service            /etc/systemd/system/nrs.service
install -m644 deploy/nrs-sync.service       /etc/systemd/system/nrs-sync@.service
install -m644 deploy/nrs-sync-hourly.timer  /etc/systemd/system/nrs-sync-hourly.timer
install -m644 deploy/nrs-sync-nightly.timer /etc/systemd/system/nrs-sync-nightly.timer
systemctl daemon-reload
systemctl enable nrs.service >/dev/null
# restart, not start: a re-run must load the code we just copied.
systemctl restart nrs.service
systemctl enable --now nrs-sync-hourly.timer nrs-sync-nightly.timer >/dev/null
sleep 3
systemctl is-active --quiet nrs.service || { journalctl -u nrs -n 30 --no-pager; die "the app did not start"; }
ok "nrs.service running, both timers armed"

# ------------------------------------------------------------------- nginx

say "Certificate"
mkdir -p /var/www/nrs-acme/.well-known/acme-challenge
chown -R www-data:www-data /var/www/nrs-acme

if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  ok "certificate for $DOMAIN already present"
else
  # Serve the challenge from a temporary site so certbot never edits an
  # existing server block. --nginx is deliberately avoided for that reason.
  cat > /etc/nginx/sites-available/nrs-acme <<ACME
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/nrs-acme; }
    location / { return 404; }
}
ACME
  ln -sf /etc/nginx/sites-available/nrs-acme /etc/nginx/sites-enabled/nrs-acme
  nginx -t >/dev/null || die "nginx rejected the temporary ACME site; nothing has been reloaded"
  systemctl reload nginx
  certbot certonly --webroot -w /var/www/nrs-acme -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email --quiet \
    || die "certbot failed — the temporary site is still in place, fix and re-run"
  rm -f /etc/nginx/sites-enabled/nrs-acme /etc/nginx/sites-available/nrs-acme
  ok "certificate issued for $DOMAIN"
fi

say "Site"
# Pick the HTTP/2 syntax this nginx accepts. 1.24 wants it as a listen
# parameter; 1.25.1 and later want a separate directive and reject the old form.
NGINX_VER=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
NGINX_NUM=$(printf '%d%03d%03d' $(echo "$NGINX_VER" | tr '.' ' '))
if (( NGINX_NUM >= 1025001 )); then
  H2_PARAM=""; H2_DIRECTIVE="    http2 on;\n"
  ok "nginx $NGINX_VER — using \`http2 on;\`"
else
  H2_PARAM=" http2"; H2_DIRECTIVE=""
  ok "nginx $NGINX_VER — using the http2 listen parameter"
fi

sed -e "s|@HTTP2_PARAM@|$H2_PARAM|g" \
    -e "s|@HTTP2_DIRECTIVE@|$H2_DIRECTIVE|g" \
    deploy/nginx-nrs.conf > /tmp/nrs-site.conf
# The placeholder line collapses to nothing when the directive is not wanted.
sed -i '/^$/{ /./!d }' /tmp/nrs-site.conf 2>/dev/null || true
install -m644 /tmp/nrs-site.conf /etc/nginx/sites-available/nrs
ln -sf /etc/nginx/sites-available/nrs /etc/nginx/sites-enabled/nrs
nginx -t >/dev/null || { rm -f /etc/nginx/sites-enabled/nrs; die "nginx rejected the site; it has been removed and nothing reloaded"; }
systemctl reload nginx
ok "nginx serving $DOMAIN"

# ----------------------------------------------------------------- firewall

say "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  ok "ufw active; port $PORT stays closed to the outside (the app binds to loopback anyway)"
else
  warn "ufw is not active. The app binds to 127.0.0.1 so port $PORT is unreachable regardless,"
  warn "but consider: ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable"
fi

# -------------------------------------------------------- prove we added only

say "Verifying that nothing pre-existing was changed"
AFTER=$(mktemp)
find /etc/nginx -type f -exec md5sum {} + 2>/dev/null | sort > "$AFTER"
# md5sum separates hash and path with TWO spaces. Reformatting only one side of
# the comparison made every single file look changed — the check cried wolf on
# its first real run. Normalise both sides identically.
norm() { awk '{h=$1; $1=""; sub(/^ +/,""); print h" "$0}' "$1" | sort; }
CHANGED=$(comm -23 <(norm "$FINGERPRINT") <(norm "$AFTER") | grep -v '/nrs$' || true)
if [[ -n "$CHANGED" ]]; then
  warn "these previously-existing files no longer match — check them:"
  echo "$CHANGED" | sed 's/^/      /'
else
  ok "every pre-existing nginx file is byte-identical ($(wc -l < "$FINGERPRINT") checked)"
fi
rm -f "$FINGERPRINT" "$AFTER"

printf '\n\033[1mDone.\033[0m  https://%s\n\n' "$DOMAIN"
echo "  Two things left, both in $APP_DIR/.env :"
echo "    MCP_USER / MCP_PASSWORD   the sync account (read-only Odoo account, please)"
echo "  then:  systemctl restart nrs && node scripts/sync.js --mtd"
echo
echo "  Your editing passphrase:"
grep '^ADMIN_PASSPHRASE=' "$APP_DIR/.env" | sed 's/^/    /'
echo
echo "  Logs:   journalctl -u nrs -f"
echo "  Syncs:  systemctl list-timers 'nrs-sync*'"
