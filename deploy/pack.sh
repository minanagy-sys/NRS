#!/usr/bin/env bash
# Build the two files the droplet needs. Runs HERE, on the Mac. Changes nothing
# anywhere — it only reads the local database and the working tree.
#
#   bash deploy/pack.sh
#
# Produces, in ./dist:
#   nrs-code.tar.gz   the application source (no node_modules, no .env, no secrets)
#   nrs-data.sql      the finance and target rows, and nothing else
#
# The data file is deliberately narrow. The droplet already syncs Invoice,
# InvoiceLine, StockQuant and DaySnapshot from Odoo itself and has more stock
# rows than this Mac does — overwriting those would be a downgrade. So the dump
# carries only the tables the droplet has no way to produce: the finance
# snapshot, and the August targets.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=dist
mkdir -p "$OUT"

# The database this Mac reads. Taken from .env so there is one source of truth.
# Prisma's `?schema=public` is not a libpq parameter, so pg_dump rejects the URI
# outright — strip the query string.
DB_URL=$(grep -E '^DATABASE_URL' .env | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//; s/\?.*$//')
[[ -n "$DB_URL" ]] || { echo "No DATABASE_URL in .env" >&2; exit 1; }

PG_BIN=$(dirname "$(command -v pg_dump)")

# Finance (13 tables, all created by the three new migrations) and targets
# (5 tables that exist on the droplet but are empty).
TABLES=(
  FinanceSource FinanceBatch
  Collection CollectionDay Register
  Supplier Bill BillLine VendorPayment JournalMethod
  ReconProduct ReconFact ExpiryLot
  TargetPeriod TargetGroup DoctorTarget BranchTarget IdentityAlias
)
# Every one of these has a serial id, so the sequence position has to travel too
# or the droplet's next insert reuses an id that is already taken. pg_dump does
# emit a schema-qualified setval for each owned sequence, so there is nothing to
# add here — a rehearsal proved that hand-appending them fails anyway, because
# pg_dump sets search_path to '' and an unqualified "Table" no longer resolves.

echo "▸ dumping $(( ${#TABLES[@]} )) tables"
ARGS=(); for t in "${TABLES[@]}"; do ARGS+=(--table="public.\"$t\""); done

"$PG_BIN/pg_dump" "$DB_URL" --data-only --no-owner --no-privileges --no-comments \
  --column-inserts=false --format=plain "${ARGS[@]}" > "$OUT/.raw.sql" 2>/dev/null \
  || "$PG_BIN/pg_dump" "$DB_URL" --data-only --no-owner --no-privileges --no-comments \
       --format=plain "${ARGS[@]}" > "$OUT/.raw.sql"

# This Mac runs Postgres 18; the droplet runs 16. Newer pg_dump emits SET options
# that 16 has never heard of (transaction_timeout arrived in 17) and the restore
# aborts on the very first line. Drop the ones 16 does not know; they are all
# session defaults we do not depend on.
grep -vE "^SET (transaction_timeout|default_toast_compression)" "$OUT/.raw.sql" > "$OUT/.body.sql"

{
  echo "-- Nouvelage finance + targets, data only."
  echo "-- Restored inside one transaction: it all lands, or none of it does."
  echo "BEGIN;"
  cat "$OUT/.body.sql"
  echo "COMMIT;"
} > "$OUT/nrs-data.sql"
rm -f "$OUT/.raw.sql" "$OUT/.body.sql"

SEQ_COUNT=$(grep -c 'pg_catalog.setval' "$OUT/nrs-data.sql" || true)
[[ "$SEQ_COUNT" -ge 14 ]] || { echo "Only $SEQ_COUNT sequences carried — expected 14" >&2; exit 1; }

# The delta is the file that matters for an UPGRADE. nrs-data.sql only loads into
# empty tables, so on a droplet that already holds finance data it is skipped
# entirely — anything new inside it would never arrive. See deploy/make-delta.js.
echo "▸ building the commission delta"
node "$(dirname "$0")/make-delta.js"

# ── the three new reports' own data ─────────────────────────────────────────
#
# The 13 tables the 2026-09-04 and 2026-09-06 migrations create hold everything
# reports 02 (Contact Centre) and 03 (Marketing) read, and the droplet has no
# way to produce any of it:
#
#   MetaDay · MetaCampaign · MetaAd · MetaLead · IgProfileDay · IgPost
#         Supermetrics, against a licence that expires 2026-09-17
#   PbxDay · PbxHour · PbxQueueDay · PbxAgentDay · ChatDay · DataUpload
#         the Grandstream and omnichannel exports, uploaded by hand
#   ApiQuery
#         the row meter. It has to travel or the droplet believes it has the
#         whole 50,000-row month to itself while this Mac has already spent
#         part of it — they share one licence, not one each.
#
# META LEADS ARE THE REASON THIS FILE IS NOT OPTIONAL. Meta keeps roughly 90
# days of lead history and nothing recovers what falls off the back. The 8,503
# rows here reach further back than Meta will hand out again.
#
# It is NOT in nrs-data.sql because that file is guarded on Supplier being
# empty, and the droplet has 155 suppliers, so it is skipped there entirely.
# One guard, on MetaCampaign: all 13 tables arrive from the same migration, so
# they are either all fresh or all already loaded.
REPORT_TABLES=(
  MetaDay MetaCampaign MetaAd MetaLead IgProfileDay IgPost
  PbxDay PbxHour PbxQueueDay PbxAgentDay ChatDay DataUpload ApiQuery
)
echo "▸ dumping ${#REPORT_TABLES[@]} report tables"
RARGS=(); for t in "${REPORT_TABLES[@]}"; do RARGS+=(--table="public.\"$t\""); done
"$PG_BIN/pg_dump" "$DB_URL" --data-only --no-owner --no-privileges --no-comments \
  --format=plain "${RARGS[@]}" > "$OUT/.rraw.sql"
grep -vE "^SET (transaction_timeout|default_toast_compression)" "$OUT/.rraw.sql" > "$OUT/.rbody.sql"
{
  echo "-- Reports 02 and 03: Meta, Instagram, PBX, chat, uploads, API meter."
  echo "-- Data only, one transaction. Load ONLY into empty tables."
  echo "BEGIN;"
  cat "$OUT/.rbody.sql"
  echo "COMMIT;"
} > "$OUT/nrs-reports.sql"
rm -f "$OUT/.rraw.sql" "$OUT/.rbody.sql"

# A dump that carries no MetaLead rows would deploy silently and leave report 03
# with an empty lead-quality section, so it is checked rather than assumed.
LEADS=$(awk '/^COPY public."MetaLead"/{f=1;next} /^\\\.$/{f=0} f{n++} END{print n+0}' "$OUT/nrs-reports.sql")
[[ "$LEADS" -gt 8000 ]] || { echo "Only $LEADS MetaLead rows carried — expected 8,000+" >&2; exit 1; }

# ── the catalogue reports 08 and 09 are built on ────────────────────────────
#
# Four tables, 242 rows, and the droplet cannot produce one of them:
#
#   Consumable      the 106-product stock catalogue, with its dose-per-unit rule
#   ConsumableLink  which SERVICE burns which product, and how many doses —
#                   without it no sale of a consumable is visible at all
#   VendorTerm      the agreed cash-back rates and volume targets. Nothing in
#                   Odoo records a cash-back agreement; it is a negotiation.
#   PurchaseReturn  stock sent back to a supplier. Odoo shows no negative
#                   purchase lines here, so returns exist only in this table.
#
# A SECOND FILE, NOT AN ADDITION TO nrs-reports.sql, and the reason matters:
# that file is guarded on MetaCampaign being empty, and the droplet has held
# 4,530 of them since the 2026-09-08 deploy. Anything added to it now would be
# skipped in silence and reports 08 and 09 would come up empty on the droplet
# while working perfectly here. Its own guard, on its own table.
CATALOGUE_TABLES=(Consumable ConsumableLink VendorTerm PurchaseReturn)
echo "▸ dumping ${#CATALOGUE_TABLES[@]} catalogue tables"
CARGS=(); for t in "${CATALOGUE_TABLES[@]}"; do CARGS+=(--table="public.\"$t\""); done
"$PG_BIN/pg_dump" "$DB_URL" --data-only --no-owner --no-privileges --no-comments \
  --format=plain "${CARGS[@]}" > "$OUT/.craw.sql"
grep -vE "^SET (transaction_timeout|default_toast_compression)" "$OUT/.craw.sql" > "$OUT/.cbody.sql"
{
  echo "-- Reports 08 and 09: the consumable catalogue, its service links,"
  echo "-- the vendor terms and the purchase returns. Load ONLY into empty tables."
  echo "BEGIN;"
  cat "$OUT/.cbody.sql"
  echo "COMMIT;"
} > "$OUT/nrs-catalogue.sql"
rm -f "$OUT/.craw.sql" "$OUT/.cbody.sql"

# Without the links the inventory report shows every product as "Not linked" and
# every cover figure as unknown — a page that renders perfectly and says nothing.
LINKS=$(awk '/^COPY public."ConsumableLink"/{f=1;next} /^\\\.$/{f=0} f{n++} END{print n+0}' "$OUT/nrs-catalogue.sql")
[[ "$LINKS" -gt 90 ]] || { echo "Only $LINKS ConsumableLink rows carried — expected 90+" >&2; exit 1; }

echo "▸ packing the source"
# --exclude .env is the important one. node_modules is rebuilt on the droplet
# with npm ci, so shipping it would only mean 350 MB of the wrong architecture.
#
# --no-xattrs and COPYFILE_DISABLE matter more than they look. macOS stamps every
# file with a com.apple.provenance xattr, and bsdtar stores those as pax extended
# headers. GNU tar on Ubuntu cannot read them, so it warns once per file — 186
# lines of noise on the first deploy — and counts each header as an entry, which
# made the script report 186 files written when there are only 85.
export COPYFILE_DISABLE=1
tar --no-xattrs -czf "$OUT/nrs-code.tar.gz" \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./dist' \
  --exclude='./.npm' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='./prisma/dev.db*' \
  -C . package.json package-lock.json prisma public scripts src test deploy README.md .env.example

echo
echo "  $(ls -lh "$OUT/nrs-code.tar.gz" | awk '{print $5}')  $OUT/nrs-code.tar.gz"
echo "  $(ls -lh "$OUT/nrs-data.sql"    | awk '{print $5}')  $OUT/nrs-data.sql     (fresh installs only)"
  echo "  $(ls -lh "$OUT/nrs-delta.sql"   | awk '{print $5}')  $OUT/nrs-delta.sql    (always applied)"
echo "  $(ls -lh "$OUT/nrs-reports.sql" | awk '{print $5}')  $OUT/nrs-reports.sql  (reports 02/03, empty tables only)"
echo "  $(ls -lh "$OUT/nrs-catalogue.sql" | awk '{print $5}')  $OUT/nrs-catalogue.sql (reports 08/09, empty tables only)"
echo
echo "  rows in the dump:"
grep -cE '^[0-9]' "$OUT/nrs-data.sql" >/dev/null 2>&1 || true
awk '/^COPY /{t=$2; gsub(/public\.|"/,"",t); n=0; next} /^\\\.$/{if(t){printf "    %-16s %6d\n", t, n; t=""}} t{n++}' "$OUT/nrs-data.sql"
echo
echo "  no .env and no node_modules are in either file:"
tar -tzf "$OUT/nrs-code.tar.gz" | grep -E '(^|/)\.env$|node_modules' && echo "    ✗ SOMETHING LEAKED" || echo "    ✓ clean"
