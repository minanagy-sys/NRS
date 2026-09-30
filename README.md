# Nouvelage Daily Sales — web app

The daily sales report as a real application: sign in with your own Nouvelage
account, pick any date range, and read it from a Postgres cache that a scheduled
job fills from the **Nouvelage Odoo MCP**.

## Run it

```bash
cd ~/nouvelage-sales-webapp
npm install
createdb nouvelage_sales
cp .env.example .env          # then fill DATABASE_URL and TOKEN_KEY
npx prisma migrate deploy
node scripts/seed-targets.js  # imports the August 2026 sheet + name aliases
node scripts/sync.js --mtd    # fills the cache
npm start                     # http://localhost:3020
```

## How it fits together

```
browser ──► Fastify ──► Postgres          every report cut is a GROUP BY
              │
              └── OAuth ──► MCP           sign-in only; no password reaches this app
scripts/sync.js ──────────► MCP           the only thing that reads Odoo data
```

**Sign-in never sees a password.** `/auth/login` sends the browser to the MCP's
own login page (authorization code + PKCE, dynamic client registration) and the
callback exchanges the code for a token. The token is encrypted with AES-256-GCM
before it touches the database and never reaches the browser. Sessions are
`httpOnly` + `SameSite=Lax` cookies, `Secure` once `PUBLIC_ORIGIN` is https.

**The page never queries the MCP.** A month is roughly 5,700 invoices and 12,000
lines arriving as JSON inside a text block — far too slow per page load. The sync
writes them to Postgres once; everything after that is SQL.

**A window is replaced wholesale, never topped up.** Invoices get un-posted and
amended after the fact, so a partial update would leave stale rows behind.

## Verified against the source

`node test/report.test.js` pins the SQL against figures confirmed live on the MCP
and against the original hand-built report:

| | |
|---|---|
| 4 Aug 2026 | 640,408.31 ex · 666,800.43 inc · 163 invoices · 344 lines |
| Coverage | 12 branches · 30 doctors |
| Reconciliation | branch, doctor, day, product and category cuts each sum to 640,408.31 |
| Nesting | branch→doctor, branch→product and doctor→product each sum to their parent |
| Target sheet | 28,838,391 across a 73-person roster, every group cross-footing |

A day-by-day comparison of cache against Odoo for 1–10 August matched on all ten
days, invoice counts included.

**Those figures are a reference, not an assertion.** Odoo amends posted invoices after
the fact — which is why a synced window is replaced wholesale — so the test asserts the
property that catches a real bug (all five cuts reconciling to the same total, whatever
it currently is) and *reports* any drift from what was first verified. 4 Aug read
640,408.31 across nine consecutive pulls and then 640,415.31 on 12 Aug: same 163
invoices, one line fewer. `DaySnapshot` records every move and tab 07 surfaces it.

## What the report tells you that Odoo does not

**Tab 07, Data quality** collects what the original report wrote out by hand:

- invoices with no branch (120 in the first ten days of August, 785,695 ex-VAT)
  and no doctor (186)
- doctors holding more than one Odoo record — `Dr. Mai mohsen` and `Mai mohsen`
  are the same person; their figures are summed and the row says so
- days more than 3× the range average, which is usually a data-entry mistake.
  Two invoices dated 9 August briefly read 11,269,493 and 7,574,649 before being
  corrected to 3,065 and 2,521 — that is the class of thing this catches
- how much a day moved between pulls, from `DaySnapshot`

## Targets

`TargetGroup` holds the authoritative figure and `unlistedTarget` carries the
roster members with no sales, so **a group always equals its doctors plus that
number**. The original report claimed 73 doctors and 28,838,391 while rendering
52 rows summing to 26,627,883; `PUT /api/targets/:period` rejects any sheet that
does not reconcile, with the arithmetic in the error message.

The scoring rules live in `src/lib/rules.js`, shared with the standalone report,
so both score identically:

- `daily target = round(monthly ÷ days in period)` — branch dailies from Target 1 only
- `pace = elapsed days ÷ days in period`
- green ≥ 1.00 of expected, amber ≥ 0.85, red below — compared **unrounded**, so a
  row at 99.975% still displays 100% and still shows amber

Names resolve through `IdentityAlias`, never by similarity: `Dr.Merna Masoud` and
`Dr.Merna Ashraf` are one edit apart and are different people.

## Layout

```
src/server.js            Fastify, CSP, rate limits, session lookup
src/routes/auth.js       OAuth in and out
src/routes/report.js     /api/report, /api/refresh, /api/health
src/routes/admin.js      target sheets, xlsx parsing, aliases, audit
src/lib/report.js        every cut, as SQL
src/lib/targets.js       sheet + actuals -> scored rows
src/lib/sync.js          MCP -> Postgres
src/lib/auth.js          PKCE handshake, sessions
src/lib/crypto.js        AES-256-GCM for tokens at rest
src/lib/rules.js         the scoring rules — shared, one copy
src/lib/{mcp,http}.js    MCP client and retrying fetch
scripts/sync.js          the cron entry point
```

`src/lib/{rules,mcp,http,aggregate}.js` are the single copy; the older
`~/nouvelage-daily-sales-live` re-exports them rather than keeping its own.

## Scheduling

```bash
# every hour: the current month
0 * * * * cd ~/nouvelage-sales-webapp && node scripts/sync.js --mtd --cron
# nightly: the trailing week, to pick up late postings and corrections
30 2 * * * cd ~/nouvelage-sales-webapp && node scripts/sync.js --days 7 --stock --cron
```

An unattended job has no browser to redirect, and the MCP supports neither the
client-credentials nor the password grant, so `src/lib/oauth-password.js` drives
the same login form a person would, using `MCP_USER` / `MCP_PASSWORD` from the
environment. **Give that account read-only Odoo rights** — the token it mints can
read whatever the account can. Interactive sign-in never touches this path.

## Setting next month's targets

**Export** in the top bar downloads `nouvelage-targets-<next month>-template.xlsx`:
every doctor with their group, last month's figure in a **Previous** column, what
they actually invoiced — and the **Monthly Target column deliberately empty**. A
pre-filled template gets re-uploaded unchanged, and last month's targets become
this month's while looking like a decision was made.

Doctors who are invoicing with **no approved target** are in it too, with no group
and no previous figure, so they can be given one. They also now appear on the
Targets tab in the main table under *No approved target*, with a dash where the
target would be — outside every group total, so the sheet still cross-foots.

**Import** — next to Export — closes the loop: pick the filled-in file and it shows
exactly what it will write before writing anything.

```
Read nouvelage-targets-2026-09-template.xlsx

  Period      2026-09   (new — nothing published for it yet)
  Doctors     73 across 5 groups · Injectables, Laser + Injection, …
  Total       26,980,000 EGP ex-VAT
  Branches    9 carried forward from 2026-08
  2 doctors have no target and will be published at 0 — Dr. Mai mohsen, …

        [ Publish 2026-09 ]  [ Review in admin ]  [ Cancel ]
```

Re-importing a month that already exists turns the button red and says what it is
replacing. A target that cannot be read as a number (`TBC`, `3,25o,000`) removes the
Publish button entirely and names the row — a typo becoming a silent 0 is the one
outcome worth refusing. **Review in admin** hands the same draft to the editor instead.
Publishing needs the admin passphrase, and Import asks for it in place rather than
sending you elsewhere.

Or do it the long way: upload at `/admin` → **Import Excel**, review, publish. The four
column headings are chosen so the importer's auto-detection picks each one out
unambiguously and no manual mapping is needed; `test/export.test.js` reads those
regexes out of `public/admin.js` and fails if a heading ever stops matching
exactly one. (`Previous Month` cannot be used as a heading: it contains "month",
so it would be auto-mapped as the target.)

Rows left blank arrive at 0 and are flagged **no target** in the editor. That
warning is not decoration — group targets are derived by summing their doctors,
so a sheet where every target is still 0 reconciles perfectly and nothing else
would catch it. Branch targets are not in the file and are carried forward from
the last published sheet rather than deleted.

`src/lib/sheet.js` both reads and writes; the workbook it produces has the six
parts Excel needs (`[Content_Types].xml`, the root `_rels/.rels`, real
relationship `Type` URIs) so it opens without a repair prompt.

## Admin — `/admin`

Five screens, linked from the report's top bar.

- **Target sheets** — every published month, with a headcount and a source label.
- **Edit sheet** — a live reconciliation panel above the tables showing
  `doctors + unlisted = group target` for each group. **Publish stays disabled
  until every line balances**, and the server applies the same rule again, so the
  original report's defect cannot be reintroduced.
- **Import Excel** — drop the approved schedule, choose which column is the name,
  group, monthly target and previous month, and it builds a draft you review in
  the editor. Nothing is written until you publish.
- **Name mapping** — the sheet names with nothing matching in Odoo are listed
  first, each with a dropdown of the names Odoo actually uses and how much each
  invoiced, so pairing is a choice rather than typing from memory.
- **Activity** — sign-ins, refreshes and every target or alias change.

## Keeping it current

Two mechanisms, and you want both.

**Scheduled** — `scripts/cron.sh` runs the sync without anyone asking:

```bash
7  * * * *  .../scripts/cron.sh hourly   # this month, so the page is fresh before you open it
40 2 * * *  .../scripts/cron.sh nightly  # the trailing week + stock, to catch late postings
```

The nightly re-read matters: invoices are posted, amended and un-posted days after
the fact. It is also what fills `DaySnapshot`, so "how much did today move since we
first looked" becomes recorded history rather than a hand-written note.

**On demand** — the Refresh button re-reads the selected range immediately. It needs
no passphrase: it writes only to our cache and cannot touch Odoo, which refuses
writes outright. Rate-limited to 4/minute. Measured:

| range | time |
|---|---|
| one day | ~2 s |
| month to date (11 days, 1,853 invoices) | ~6 s |
| a full month (31 days, 4,806 invoices) | ~18 s |

The control bar always states the age of what you are reading — *synced 3 min ago* —
and turns amber past 90 minutes, so a stale figure never passes for a current one.

## Finance — `/finance`

A collapsible **sidebar** lists the reports vertically — Sales, Finance, and Admin under
Setup — with a panel toggle at the head of the control bar. Closed, it gives the width back;
the choice is remembered, and on a narrow screen it overlays instead of pushing.

**Adding a report is one entry** in the `REPORTS` array at the top of
[public/nav.js](public/nav.js). Nothing else — no page, no other file — needs touching.

The finance page has four sections, imported from the Finance Suite report:

| | What it measures | Source |
|---|---|---|
| **Collections** | customer receipts by day × branch × register, net of refunds, grouped by when the cash is usable (T+0 / T+1 / on settlement) | Odoo 18 |
| **Payables** | 154 suppliers, 1,139 bills, 1,646 payments, free-unit bonuses | **the old system** |
| **Sold vs Issued** | invoiced units against stock actually issued, net of returns, gap costed at cost | Odoo 18 |
| **Expiry Risk** | 625 lot lines, cover months against days-to-expiry, forecast waste | Odoo 18 |

**Odoo 18 went live 1 Aug 2026**, so three of these are ten-day reports and Payables is a
19-month one — because that history lives in the *previous* system and was never migrated.
There is a hard seam at 2026-08-01 and the page says so out loud.

**Where each section reads from is a setting, not a deploy.** `/admin` → **Data sources**:

- `snapshot` — the imported extract
- `odoo` — the live sync
- `stitched` — snapshot before a cutover date, Odoo from it onward

Switching never deletes: the imported rows stay, so flipping back restores the figures.
Payables refuses `odoo` outright, because Odoo 18 holds nothing before the cutover.

**Payables has two more buttons**, both on its card:

- **Fetch from Odoo 18** — a real sync of vendor bills and supplier payments into
  `source='odoo'`. It reports *found* versus *written*, which is the number that matters:
  as of 12 Aug 2026 Odoo returns 6 bills (earliest 2026-08-03) and 74 payments of which
  only 1 can be filed — the other 73 are petty-cash payments with no vendor attached, so
  they are counted and named rather than silently dropped. It also lists journals with no
  payment method mapped, and any supplier Odoo knows that the extract never saw.
  **Balances are deliberately not synced**: `opening + bills − payments` does not reproduce
  them, so they stay with the extract that has them while the movements come from Odoo.
- **Export Excel** — the stored payables as a workbook you can edit: `Balances`,
  `Bills` and `Payments` worksheets with the exact headings the importer reads back, plus
  a *How to use* sheet. Export → edit → import is lossless; `test/payables.test.js`
  round-trips a real export and asserts nothing moves.
- **Import Excel** — a workbook of **balances**, **bills** or **payments**. It reads the
  file, asks which of the three it is (guessing would let a bills sheet overwrite every
  closing balance), shows exactly what would change, and then **merges**: suppliers it
  names are updated, ones it does not are added, and nothing is deleted. Re-importing the
  same file replaces rather than doubles — bills match on reference, payments on
  supplier + date + amount. A cell that cannot be read as a number blocks the import and is
  named, rather than becoming a balance of zero.

**Derived values are recomputed, never stored.** Days-to-expiry, cover, the verdict and the
buckets all depend on when you look, so they come from `src/lib/finance-rules.js` at read
time — the same single-copy discipline `rules.js` has for target scoring. Two things are
stored *because* they cannot be derived: supplier opening/closing balances (the report's own
`opening + purchases − payments` does not reconcile to them — 60 of 154 suppliers break it
by 21 M in aggregate), and the payment method, which is a heuristic over journal names.

```bash
node scripts/import-finance-html.js <file.html>          # check it reproduces
node scripts/import-finance-html.js <file.html> --write  # load it
```

The importer refuses to write unless all 38 of its checks pass — every published headline,
plus the rules reproducing the source's verdict and at-risk figure on all 625 rows.

## Still to do

- The cache is shared while sign-in is per user, so two people with different Odoo
  permissions see the same numbers. Today that matches the old report; add branch
  scoping if managers should be limited to their own branch.
- Tokens last 30 days and the MCP issues no refresh token, so expiry means
  signing in again.
- The sync still runs as a personal account. Give it a dedicated read-only Odoo
  account so a server compromise leaks the smallest possible thing.
- Deployment: the app is only running locally so far.
