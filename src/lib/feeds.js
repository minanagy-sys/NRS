/* ============================================================
   Every input the reports read, and where it comes from.

   THE GAP THIS FILLS. Ten reports read from Odoo on a timer and refresh
   themselves. A different set of inputs arrives by hand — a target sheet
   somebody approves, a rate somebody negotiates, an export somebody
   downloads — and until this file existed the app had no idea any of them
   should ever arrive again. Measured on 2026-09-13: the PBX export stopped on
   18 August, the chat export had never been loaded at all, supplier bills
   stopped on 10 August, and no target sheet existed for a September that was
   already thirteen days old with 7,571,773 of revenue booked into it.

   None of that was a bug. Every one of those reports states its own coverage
   honestly. But "honest about being stale" and "someone knows it is stale" are
   different things, and only the first was true.

   So: one table of record. Each feed declares what fills it, how often that is
   supposed to happen, and WHICH REPORTS GO QUIET WITHOUT IT — that last field
   is the one that turns "PbxDay is 26 days old" into "four tabs of the Contact
   Centre report are showing August". `admin-status.js` reads this and nothing
   else; there is no second list.

   WHAT `cadence` MEANS, and what it does not. It is how often the feed is
   EXPECTED to arrive, not a promise anybody made. A feed past its cadence is
   surfaced in Admin, and that is all — nothing is blocked, no report changes
   its behaviour, and a deliberate decision to stop feeding something is
   recorded by setting `cadence: null` rather than by ignoring a warning
   forever.
   ============================================================ */

const { prisma } = require('./db.js');

/** Odoo-derived feeds keep themselves current; the rest are people. */
const ODOO = 'odoo';
const API = 'api';
const HAND = 'hand';

/**
 * The feeds, in the order Admin should worry about them.
 *
 * `count` returns the row count and the span the feed covers, so a feed can be
 * late in two different ways — nothing new has arrived, or nothing was ever
 * there. Those need different sentences and the status panel writes both.
 */
const FEEDS = [
  /* ---- the target schedule: the one with a deadline ---- */
  {
    key: 'targets',
    label: 'Approved target schedule',
    source: HAND,
    /* Monthly, and unlike every other feed here it has a DATE it is late by:
       a sheet published halfway through its own month has already failed at the
       thing it is for. `admin-status.js` scores it against the calendar, not
       against this number, which is why it is stated as a month. */
    cadence: { every: 'month', graceDays: 0 },
    fills: 'TargetPeriod · DoctorTarget · TargetGroup · BranchTarget',
    breaks: 'The Targets tab of NRS, and the whole Targets tab of Doctors Performance',
    howTo: 'Admin → Periods → start the month, fill in the numbers, publish',
    async state() {
      const rows = await prisma.targetPeriod.findMany({
        select: { period: true, publishedAt: true }, orderBy: { period: 'asc' },
      });
      return {
        rows: rows.length,
        periods: rows.map((r) => r.period),
        latest: rows.length ? rows[rows.length - 1].period : null,
        lastAt: rows.length ? rows[rows.length - 1].publishedAt : null,
      };
    },
  },

  /* ---- the uploads, in the order they went stale ---- */
  {
    key: 'pbx',
    label: 'PBX day roll-up',
    source: HAND,
    cadence: { every: 'week', graceDays: 10 },
    fills: 'PbxDay · PbxHour · PbxQueueDay · PbxAgentDay',
    breaks: 'Queues, Agents, Outbound and the hourly split on Contact Centre',
    howTo: 'Admin → Data → PBX export',
    async state() {
      const agg = await prisma.pbxDay.aggregate({
        _count: true, _min: { date: true }, _max: { date: true },
      });
      return { rows: agg._count, from: agg._min.date, to: agg._max.date, lastAt: agg._max.date };
    },
  },
  {
    key: 'chat',
    label: 'Omnichannel chat export',
    source: HAND,
    cadence: { every: 'week', graceDays: 10 },
    fills: 'ChatDay',
    breaks: 'The channel mix on Contact Centre — roughly seven contacts in ten',
    howTo: 'Admin → Data → Omnichannel export',
    async state() {
      const agg = await prisma.chatDay.aggregate({
        _count: true, _min: { date: true }, _max: { date: true },
      });
      return { rows: agg._count, from: agg._min.date, to: agg._max.date, lastAt: agg._max.date };
    },
  },
  {
    key: 'payroll',
    label: 'Doctor payroll month',
    source: HAND,
    cadence: { every: 'month', graceDays: 20 },
    fills: 'DoctorPayrollMonth',
    breaks: 'The payslips on Targets & Doctor Commission. Revenue and commission still derive '
      + 'from Odoo without it; hours, deductions, management fees and withholding do not, and '
      + 'the tab says so rather than showing a payslip short of half its lines.',
    howTo: 'Admin → Data → Doctor payroll month',
    async state() {
      const agg = await prisma.doctorPayrollMonth.aggregate({
        _count: true, _min: { period: true }, _max: { period: true, updatedAt: true },
      });
      /* The span is a MONTH, not a date — "2026-08" widened to its first and
         last day rather than left as a bare string, so it reads the same way as
         every other feed's range instead of needing its own column. */
      const day = (p, end) => (p ? new Date(`${p}-${end ? '28' : '01'}T00:00:00Z`) : null);
      return {
        rows: agg._count,
        from: day(agg._min.period, false),
        to: day(agg._max.period, true),
        /* Freshness is when it was UPLOADED, not which month it covers: a
           August sheet loaded yesterday is current, and the same sheet still
           sitting there in December is not. */
        lastAt: agg._max.updatedAt,
      };
    },
  },
  {
    key: 'payables',
    label: 'Supplier bills',
    source: HAND,
    cadence: { every: 'month', graceDays: 14 },
    fills: 'Bill · BillLine · Supplier · VendorPayment',
    breaks: 'Every figure on Procurement — purchases, vendors, cash back, price moves',
    howTo: 'Admin → Data → payables workbook',
    async state() {
      const agg = await prisma.bill.aggregate({
        _count: true, _min: { date: true }, _max: { date: true },
      });
      return { rows: agg._count, from: agg._min.date, to: agg._max.date, lastAt: agg._max.date };
    },
  },
  {
    key: 'expiry',
    label: 'Expiry lot register',
    source: HAND,
    cadence: { every: 'month', graceDays: 14 },
    fills: 'ExpiryLot',
    breaks: 'Overview, Expiry and At-risk sales on Inventory — three tabs of four',
    howTo: 'Admin → Data → expiry register',
    async state() {
      const agg = await prisma.expiryLot.aggregate({ _count: true, _sum: { value: true } });
      const load = await prisma.dataUpload.findFirst({
        where: { kind: 'expiry' }, orderBy: { createdAt: 'desc' },
      });
      return {
        rows: agg._count,
        value: Number(agg._sum.value || 0),
        /* The register carries no date of its own — a lot's expiry is not when
           the file was made — so freshness has to come from the load ledger. */
        lastAt: load ? load.createdAt : null,
        neverLoggedALoad: !load && agg._count > 0,
      };
    },
  },
  {
    key: 'catalogue',
    label: 'Consumable catalogue and service links',
    source: HAND,
    /* Rarely, and only when the clinic starts using a new product — so it is
       not chased on a clock. It is surfaced by its UNRESOLVED COUNT instead,
       which is the thing that actually degrades. */
    cadence: null,
    fills: 'Consumable · ConsumableLink',
    breaks: 'Cover and the movement ledger on Inventory — without a link no sale of a product is visible',
    howTo: 'Admin → Mapping → consumable links, or re-upload the inventory pack',
    async state() {
      const [products, linkRows] = await Promise.all([
        prisma.consumable.findMany({ select: { odooId: true } }),
        prisma.consumableLink.findMany({ select: { consumableOdooId: true } }),
      ]);
      /* Intersected in JS, not with `notIn`: a link whose product id is null is
         a link to nothing, and handing nulls to `notIn` makes Prisma reject the
         whole query rather than ignore them.

         MANY SERVICES SHARE ONE PRODUCT — a dozen botox procedures all draw on
         the same vial — so `links - distinct products` is not a defect count,
         it is the normal shape. Dangling means a link pointing at a product id
         the catalogue does not have. */
      const have = new Set(products.map((p) => p.odooId));
      const linked = new Set(linkRows.map((l) => l.consumableOdooId).filter((x) => x != null));
      return {
        rows: products.length,
        links: linkRows.length,
        dangling: linkRows.filter((l) => l.consumableOdooId == null || !have.has(l.consumableOdooId)).length,
        unlinked: products.filter((p) => !linked.has(p.odooId)).length,
      };
    },
  },

  /* ---- the metered API ---- */
  {
    key: 'meta',
    label: 'Meta and Instagram',
    source: API,
    cadence: { every: 'day', graceDays: 2 },
    fills: 'MetaDay · MetaCampaign · MetaAd · MetaLead · IgProfileDay · IgPost',
    breaks: 'Every tab of Marketing',
    howTo: 'nrs-meta.timer runs nightly at 03:20 — nothing to do by hand',
    async state() {
      const agg = await prisma.metaDay.aggregate({ _count: true, _max: { date: true } });
      return { rows: agg._count, to: agg._max.date, lastAt: agg._max.date };
    },
  },

  /* ---- the ones that look after themselves, listed so the picture is whole ---- */
  {
    key: 'invoices',
    label: 'Invoices and lines',
    source: ODOO,
    cadence: { every: 'day', graceDays: 1 },
    fills: 'Invoice · InvoiceLine',
    breaks: 'Every report',
    howTo: 'nrs-sync-hourly.timer — nothing to do by hand',
    async state() {
      const agg = await prisma.invoice.aggregate({
        _count: true, _min: { invoiceDate: true }, _max: { invoiceDate: true },
      });
      return { rows: agg._count, from: agg._min.invoiceDate, to: agg._max.invoiceDate, lastAt: agg._max.invoiceDate };
    },
  },
  {
    key: 'stock',
    label: 'Stock snapshots',
    source: ODOO,
    cadence: { every: 'day', graceDays: 1 },
    fills: 'StockQuant',
    breaks: 'Cover and the movement ledger on Inventory, and the Stock tab of NRS',
    howTo: 'nrs-sync-hourly.timer — nothing to do by hand',
    async state() {
      const agg = await prisma.stockQuant.aggregate({ _count: true, _max: { takenAt: true } });
      const snaps = await prisma.stockQuant.findMany({
        distinct: ['takenAt'], select: { takenAt: true },
      });
      return { rows: agg._count, snapshots: snaps.length, lastAt: agg._max.takenAt };
    },
  },
  {
    key: 'collections',
    label: 'Collections',
    source: ODOO,
    cadence: { every: 'day', graceDays: 1 },
    fills: 'Collection · CollectionDay',
    breaks: 'The pace and pool figures on Targets — its base is cash, not invoices',
    howTo: 'nrs-sync-hourly.timer — nothing to do by hand',
    async state() {
      const agg = await prisma.collection.aggregate({
        _count: true, _min: { date: true }, _max: { date: true },
      });
      return { rows: agg._count, from: agg._min.date, to: agg._max.date, lastAt: agg._max.date };
    },
  },
];

const DAY = 86400000;

/** Days between two dates, floored. Null in, null out. */
function daysSince(at, now) {
  if (!at) return null;
  const ms = now.getTime() - new Date(at).getTime();
  return Math.floor(ms / DAY);
}

/** How many days a cadence allows before a feed counts as late. */
function allowance(cadence) {
  if (!cadence) return null;
  const base = { day: 1, week: 7, month: 31 }[cadence.every] || 31;
  return base + (cadence.graceDays || 0);
}

/**
 * Read every feed and say whether it is late.
 *
 *   read() -> [{ key, label, source, rows, lastAt, ageDays, late, why, ... }]
 *
 * `late` is only ever true for a feed with a cadence AND a reading to compare.
 * A feed that has never received anything is NOT "late" — it is `empty`, which
 * is a different sentence and a different fix, and collapsing the two produces
 * "chat is 0 days late" for something nobody has ever sent.
 */
async function read(now = new Date()) {
  const out = [];
  for (const f of FEEDS) {
    let state = {};
    let error = null;
    try { state = await f.state(); } catch (e) { error = e.message; }

    const allow = allowance(f.cadence);
    const ageDays = daysSince(state.lastAt, now);
    const empty = !error && (state.rows || 0) === 0;
    const late = !error && !empty && allow != null && ageDays != null && ageDays > allow;

    out.push({
      key: f.key,
      label: f.label,
      source: f.source,
      cadence: f.cadence ? `${f.cadence.every}${f.cadence.graceDays ? ` +${f.cadence.graceDays}d grace` : ''}` : null,
      allowanceDays: allow,
      fills: f.fills,
      breaks: f.breaks,
      howTo: f.howTo,
      ...state,
      lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
      ageDays,
      empty,
      late,
      error,
      /* One sentence, written here so every caller says the same thing. */
      why: error ? `Could not be read: ${error}`
        : empty ? 'Nothing has ever been loaded.'
          : allow == null ? 'No cadence — chased by what it is missing, not by a clock.'
            : late ? `${ageDays} days old; expected every ${f.cadence.every}.`
              : `${ageDays == null ? 'current' : `${ageDays} days old`}, within its cadence.`,
    });
  }
  return out;
}

module.exports = { FEEDS, read, daysSince, allowance, ODOO, API, HAND };
