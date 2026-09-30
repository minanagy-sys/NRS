#!/usr/bin/env node
/* Turn Supermetrics MCP query results into a capture file for sync-meta.js.

     node scripts/mcp-capture.js --out data/meta-bootstrap.json <result-file>...

   THE BOOTSTRAP, AND WHY IT IS A SCRIPT AND NOT A PASTE.

   The rows for report 03 arrive today through an interactive Supermetrics MCP
   session, because the licence we have (`CNCT`, `app_id: CLAUDE`) is scoped to
   that connector and issues no server key. Those results land on disk as JSON
   files. This turns them into the one shape `sync-meta.js --source bootstrap`
   loads.

   It exists as a checked-in script rather than a one-off transformation so that
   the bootstrap is repeatable by someone who is not me: the mapping from
   Supermetrics' field ids to our keys is the same `FIELDS` table the API client
   uses, so the two paths cannot drift, and re-running it is a command rather
   than an afternoon.

   TWO RESPONSE SHAPES, both handled, because the MCP returns either:

     plain       `data.data` is an array of arrays.
     compressed  `data.data` is a STRING — a YAML-ish block of
                 `  - [13,]: a,b,c` lines holding CSV.

   In both, the first row is DISPLAY NAMES ("Clicks (all)", "Cost"), not field
   ids. Columns are mapped by `requested_field_ids`, which is what Supermetrics'
   own tool documentation says to do — a label is free to be reworded and a
   report that loses a column when one is would lose it silently. */

const fs = require('fs');
const path = require('path');
const S = require('../src/lib/supermetrics.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
}

/** Parse one CSV line the way the compressed block writes it. */
function csvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  /* The compressed form writes a JSON null as the bare word `null`; an empty
     cell is an empty string. Keeping them apart matters because `null` on a
     metric means "Meta reported nothing", which is not the same claim as zero. */
  return out.map((c) => {
    const t = c.trim();
    return t === 'null' ? null : c;
  });
}

/** Rows out of either response shape, labels row included. */
function rowsOf(result) {
  const d = result.data && result.data.data;
  if (Array.isArray(d)) return d;
  if (typeof d === 'string') {
    const rows = [];
    for (const line of d.split('\n')) {
      const m = /^\s*-\s*\[\d+,?\]:\s*(.*)$/.exec(line);
      if (m) rows.push(csvLine(m[1]));
    }
    return rows;
  }
  throw new Error('Neither an array nor a compressed string in data.data');
}

/* Which of our pulls a file holds, decided by its OWN `requested_field_ids`
   rather than by its filename or the order it was given on the command line.
   Mislabelling an ad pull as a campaign pull would write ad names into the
   campaign table, and every total would still look plausible. */
const KINDS = {
  days: 'day', campaigns: 'campaign', ads: 'ad',
  leads: 'lead', igProfileDays: 'igProfile', igPosts: 'igPost',
  /* Its own pull because Instagram will not serve new followers for any window
     older than thirty days, and asking for it alongside the follower total
     takes the whole query down. */
  igNewFollowers: 'igNewFollowers',
};

function identify(fieldIds) {
  const got = fieldIds.join('|');
  for (const [key, fieldsName] of Object.entries(KINDS)) {
    if (S.ids(S.FIELDS[fieldsName]).join('|') === got) return key;
  }
  return null;
}

(async () => {
  const outPath = String(arg('out') || 'data/meta-bootstrap.json');
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--')
    && a !== outPath && /\.(txt|json)$/.test(a));
  if (!files.length) throw new Error('Give one or more MCP result files.');

  const cap = { capturedFor: null, capturedVia: 'supermetrics-mcp', sources: [] };
  for (const f of files) {
    const result = JSON.parse(fs.readFileSync(f, 'utf8'));
    const inner = result.data || {};
    if (inner.status && inner.status !== 'completed') {
      throw new Error(`${path.basename(f)} is "${inner.status}", not completed`);
    }
    const fieldIds = inner.requested_field_ids;
    if (!Array.isArray(fieldIds)) {
      throw new Error(`${path.basename(f)} carries no requested_field_ids — `
        + 'without them the columns can only be guessed, and a guess here is a '
        + 'wrong number rather than a missing one.');
    }
    const kind = identify(fieldIds);
    if (!kind) {
      throw new Error(`${path.basename(f)} does not match any pull in FIELDS.\n`
        + `  it has: ${fieldIds.join(',')}`);
    }
    const raw = rowsOf(result);
    const objects = S.rowsToObjects(fieldIds, raw);
    const rows = S.normalise(S.FIELDS[KINDS[kind]], objects);
    cap[kind] = (cap[kind] || []).concat(rows);
    cap.sources.push({ kind, file: path.basename(f), rows: rows.length });
    console.log(`  ${kind.padEnd(15)} ${String(rows.length).padStart(7)} rows  ${path.basename(f)}`);
  }

  /* The window the capture actually covers, read off the rows rather than taken
     on trust from whoever ran it: sync-meta deletes by date range before it
     inserts, so a capture that claims a wider window than it holds would clear
     days it cannot refill. */
  const dates = [];
  for (const key of Object.keys(KINDS)) {
    for (const r of cap[key] || []) {
      const d = r.date || r.lead_created_time || r.post_created_time;
      if (d && /^\d{4}-\d{2}-\d{2}/.test(String(d))) dates.push(String(d).slice(0, 10));
    }
  }
  if (dates.length) {
    cap.capturedFor = { from: dates.reduce((a, b) => (a < b ? a : b)),
      to: dates.reduce((a, b) => (a > b ? a : b)) };
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cap));
  const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
  console.log(`\n→ ${outPath}  (${mb} MB)`);
  if (cap.capturedFor) console.log(`  covers ${cap.capturedFor.from} → ${cap.capturedFor.to}`);
})().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
