#!/bin/bash
# Scheduled sync. Keeps the cache current so the report is fresh before anyone
# opens it, and records a DaySnapshot each run — which is what turns "today
# moved after we first looked" into tracked history rather than a guess.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

case "$1" in
  hourly)  node scripts/sync.js --mtd --cron ;;
  # Late postings and corrections land days after the fact, so re-read the week.
  nightly) node scripts/sync.js --days 7 --stock --cron ;;
  *)       echo "usage: cron.sh hourly|nightly" >&2; exit 2 ;;
esac
