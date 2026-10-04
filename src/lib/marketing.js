/* ============================================================
   Report 03 — Marketing. The read side.

   Reads the Meta and Instagram cache that `scripts/sync-meta.js` fills, joins it
   to what Odoo already holds, and answers any range in one round of queries.
   Nothing here calls Supermetrics: that path polls for minutes and the other
   reports answer in under a second.

   FOUR THINGS THIS MODULE REFUSES TO DO, each because the data will not support
   it and a page that pretended otherwise would be lying quietly:

   1. IT NEVER SUMS REACH. Supermetrics flags reach `is_non_aggregatable` because
      it counts people: the same person seen on Monday and Tuesday is one person.
      Fifteen months of daily reach adds to 25.8M against a 226,093 follower
      base, which is the giveaway. So a range gets impressions (an event count,
      which does add up) and the single best day's reach, labelled as one day.

   2. IT NEVER MERGES META'S TWO LEAD SHAPES. `msgConversations` (messaging
      contacts) and `onFbLeads` (on-Facebook leads) are reported separately and
      their sum is called "results", which is what the frozen pack calls it:
      2,239 + 2,326 = 4,565.

   3. IT NEVER HIDES HOW MUCH SPEND IS UNLABELLED. Only ~30% of campaign spend
      names a service in its campaign name and ~55% at ad level. Every mix
      carries its own coverage share, because a pie chart that quietly omits a
      third of the money is worse than no pie chart.

   4. IT NEVER QUOTES A LEAD RATE OVER A RANGE THE LEADS DO NOT COVER. Meta
      retains lead-level rows for a rolling 90 days and nothing recovers the
      rest, so a range starting before our earliest stored lead reports the
      shortfall instead of dividing by a denominator that is missing most of
      itself.
   ============================================================ */

const { prisma, num } = require('./db.js');
const { AD_ACCOUNTS, IG_PROFILES } = require('./supermetrics.js');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const day = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00.000Z`);
/* Lead and post timestamps are instants, not dates, so a range's last day has
   to run to its final millisecond or every report loses its own end date. */
const endOfDay = (s) => new Date(`${String(s).slice(0, 10)}T23:59:59.999Z`);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
/* The wall-clock text of an instant, for binding against a `timestamp without
   time zone` column. See the note in buildLeadQuality for why this exists. */
const isoLocal = (d) => d.toISOString().slice(0, 23);

/* Which entity each ad account and Instagram profile belongs to.
 *
 * The All / Nouvel Age / ZAT switch works off the ACCOUNT here, not off the
 * branch parsed out of a campaign name — only 15% of spend names a branch at
 * all, so a branch-based filter would drop most of the money out of both named
 * scopes and look like a collapse in spend. The account is a fact. */
const ENTITY_BY_ACCOUNT = {
  822787769703389: 'Nouvel Age',   // Nouvel Age Clinics l Doctors
  420792247234306: 'Nouvel Age',   // Nouvel Age l Backup
  1423050112053946: 'ZAT',         // Zat l EGP 2025
  1675236640073425: 'ZAT',         // Zat — refused by the licence, listed for when it is not
};
const ENTITY_BY_PROFILE = {
  17841401920364985: 'Nouvel Age', // nouvelageclinics
  17841471301948724: 'ZAT',        // zataestheticclinics
};

const entityOfAccount = (id) => ENTITY_BY_ACCOUNT[String(id)] || null;

/** The `accountId` list a scope covers, or null for "all of them". */
function accountsForScope(scope) {
  if (!scope || scope === 'all') return null;
  return Object.entries(ENTITY_BY_ACCOUNT)
    .filter(([, e]) => e === scope).map(([id]) => id);
}
function profilesForScope(scope) {
  if (!scope || scope === 'all') return null;
  return Object.entries(ENTITY_BY_PROFILE)
    .filter(([, e]) => e === scope).map(([id]) => id);
}

/** A `where` for the day/campaign/ad tables. */
const scopeWhere = (scope, source = 'live') => {
  const ids = accountsForScope(scope);
  return { source, ...(ids ? { accountId: { in: ids } } : {}) };
};

/* ------------------------------------------------------------ 01 · paid --- */

/**
 * Paid delivery: what was spent, what came back, and per day.
 *
 * `results` is the sum of Meta's two lead shapes and both halves are kept, so
 * the total and the split are both true. Costs-per are computed here rather
 * than in the page so that a zero denominator is decided once — `null`, not
 * `Infinity`, and the page prints a dash.
 */
async function buildPaid({ from, to, scope = 'all' }) {
  const where = { ...scopeWhere(scope), date: { gte: day(from), lte: day(to) } };

  const [agg, rows, byAccount] = await Promise.all([
    prisma.metaDay.aggregate({
      where,
      _sum: { cost: true, impressions: true, clicks: true, msgConversations: true, onFbLeads: true },
      _count: { _all: true },
    }),
    prisma.metaDay.groupBy({
      by: ['date'], where, orderBy: { date: 'asc' },
      _sum: { cost: true, impressions: true, reach: true, clicks: true, msgConversations: true, onFbLeads: true },
    }),
    prisma.metaDay.groupBy({
      by: ['accountId', 'accountName'], where,
      _sum: { cost: true, impressions: true, clicks: true, msgConversations: true, onFbLeads: true },
    }),
  ]);

  const s = agg._sum;
  const spend = r2(num(s.cost));
  const msg = s.msgConversations || 0;
  const fb = s.onFbLeads || 0;
  const results = msg + fb;
  const per = (n) => (n ? r2(spend / n) : null);

  const days = rows.map((r) => ({
    date: ymd(r.date),
    cost: r2(num(r._sum.cost)),
    impressions: r._sum.impressions || 0,
    /* Carried per day and never added. See the header. */
    reach: r._sum.reach || 0,
    clicks: r._sum.clicks || 0,
    msgConversations: r._sum.msgConversations || 0,
    onFbLeads: r._sum.onFbLeads || 0,
    results: (r._sum.msgConversations || 0) + (r._sum.onFbLeads || 0),
  }));

  /* The one honest reach figure for a range: the best single day, labelled as a
     single day. */
  const peak = days.reduce((best, d) => (d.reach > (best ? best.reach : -1) ? d : best), null);

  return {
    spend,
    impressions: s.impressions || 0,
    clicks: s.clicks || 0,
    msgConversations: msg,
    onFbLeads: fb,
    results,
    ctr: s.impressions ? r2((s.clicks || 0) / s.impressions) : null,
    cpm: s.impressions ? r2((spend / s.impressions) * 1000) : null,
    costPerResult: per(results),
    costPerMessage: per(msg),
    costPerFbLead: per(fb),
    costPerClick: per(s.clicks || 0),
    days,
    /* Days the cache actually holds inside the range, so a partly-synced range
       cannot masquerade as a quiet fortnight. */
    daysWithData: rows.length,
    daysInRange: Math.round((day(to) - day(from)) / 86400000) + 1,
    peakReach: peak ? { date: peak.date, reach: peak.reach } : null,
    accounts: byAccount.map((a) => ({
      accountId: a.accountId,
      name: a.accountName,
      entity: entityOfAccount(a.accountId),
      cost: r2(num(a._sum.cost)),
      impressions: a._sum.impressions || 0,
      clicks: a._sum.clicks || 0,
      results: (a._sum.msgConversations || 0) + (a._sum.onFbLeads || 0),
    })).sort((x, y) => y.cost - x.cost),
  };
}

/* ------------------------------------------------- 02 · campaigns & ads --- */

/** Sum the metric columns of grouped campaign/ad rows into one plain object. */
const foldMetrics = (r) => ({
  cost: r2(num(r._sum.cost)),
  impressions: r._sum.impressions || 0,
  clicks: r._sum.clicks || 0,
  msgConversations: r._sum.msgConversations || 0,
  onFbLeads: r._sum.onFbLeads || 0,
  results: (r._sum.msgConversations || 0) + (r._sum.onFbLeads || 0),
});

const withCosts = (x) => ({
  ...x,
  costPerResult: x.results ? r2(x.cost / x.results) : null,
  costPerClick: x.clicks ? r2(x.cost / x.clicks) : null,
});

/**
 * Coverage: how much of the spend a parsed dimension actually names.
 *
 * Returned beside every mix so the reader can see the size of the "not named"
 * slice rather than looking at a chart of the named part and assuming it is
 * everything. This is the number that stops report 03 overstating itself.
 */
function coverageOf(rows, field) {
  let total = 0, named = 0;
  for (const r of rows) {
    total += r.cost;
    if (r[field]) named += r.cost;
  }
  return {
    total: r2(total),
    named: r2(named),
    unnamed: r2(total - named),
    share: total ? r2(named / total) : null,
  };
}

/** Roll grouped rows up by one parsed dimension, keeping the unnamed bucket. */
function rollBy(rows, field) {
  const m = new Map();
  for (const r of rows) {
    const k = r[field] || null;
    if (!m.has(k)) m.set(k, { name: k, cost: 0, impressions: 0, clicks: 0, msgConversations: 0, onFbLeads: 0, results: 0 });
    const x = m.get(k);
    x.cost = r2(x.cost + r.cost);
    x.impressions += r.impressions;
    x.clicks += r.clicks;
    x.msgConversations += r.msgConversations;
    x.onFbLeads += r.onFbLeads;
    x.results += r.results;
  }
  return [...m.values()].map(withCosts).sort((a, b) => b.cost - a.cost);
}

async function buildCampaigns({ from, to, scope = 'all' }) {
  const where = { ...scopeWhere(scope), date: { gte: day(from), lte: day(to) } };

  const [byCampaign, byObjective] = await Promise.all([
    prisma.metaCampaign.groupBy({
      by: ['name', 'objective', 'doctor', 'service', 'branch', 'accountKey'], where,
      _sum: { cost: true, impressions: true, clicks: true, msgConversations: true, onFbLeads: true },
    }),
    prisma.metaCampaign.groupBy({
      by: ['objective'], where,
      _sum: { cost: true, impressions: true, clicks: true, msgConversations: true, onFbLeads: true },
    }),
  ]);

  const campaigns = byCampaign.map((r) => withCosts({
    name: r.name,
    objective: r.objective,
    doctor: r.doctor,
    service: r.service,
    branch: r.branch,
    account: r.accountKey,
    ...foldMetrics(r),
  })).sort((a, b) => b.cost - a.cost);

  return {
    campaigns,
    objectives: byObjective.map((r) => withCosts({ name: r.objective, ...foldMetrics(r) }))
      .sort((a, b) => b.cost - a.cost),
    coverage: {
      doctor: coverageOf(campaigns, 'doctor'),
      service: coverageOf(campaigns, 'service'),
      branch: coverageOf(campaigns, 'branch'),
    },
  };
}

async function buildAds({ from, to, scope = 'all' }) {
  const where = { ...scopeWhere(scope), date: { gte: day(from), lte: day(to) } };

  const grouped = await prisma.metaAd.groupBy({
    by: ['name', 'campaignName', 'doctor', 'service', 'branch', 'inherited'], where,
    _sum: { cost: true, impressions: true, clicks: true, msgConversations: true, onFbLeads: true },
  });

  const ads = grouped.map((r) => withCosts({
    name: r.name,
    campaign: r.campaignName,
    doctor: r.doctor,
    service: r.service,
    branch: r.branch,
    /* Which of the three came from the parent campaign rather than this ad's own
       name. The page shows an inference as an inference. */
    inherited: r.inherited || [],
    ...foldMetrics(r),
  })).sort((a, b) => b.cost - a.cost);

  /* How much of the labelled spend is labelled only because its campaign was.
     Without this the service mix reads as if every ad declared its own service,
     and a fifth of the money is there on inheritance alone. */
  const inheritedSpend = r2(ads.filter((a) => a.inherited.includes('service'))
    .reduce((t, a) => t + a.cost, 0));

  return {
    ads,
    services: rollBy(ads, 'service'),
    coverage: {
      service: { ...coverageOf(ads, 'service'), inherited: inheritedSpend },
      doctor: coverageOf(ads, 'doctor'),
      branch: coverageOf(ads, 'branch'),
    },
  };
}

/* -------------------------------------------- 03 · doctors and services --- */

/**
 * Spend per doctor beside the revenue that doctor billed.
 *
 * The join is on the doctor's NAME, mapped by meta-parse.js to the spelling
 * Odoo uses on `Invoice.specialistName`. Two things are deliberately visible
 * rather than smoothed over:
 *
 * - A doctor with spend and no revenue row, and a doctor with revenue and no
 *   spend, both appear. Dropping either would turn a real gap into a tidy table.
 * - The revenue is ex-package (the same cut the Commercial Sales report uses),
 *   because a package is invoiced when SOLD and would credit a month's
 *   marketing with cash collected against future visits.
 *
 * And the ratio is NOT called ROAS. Nothing here proves the revenue came from
 * the ads: it is revenue billed by a doctor whose name appears in campaign
 * names, in the same window. `revenuePerPound` is that arithmetic and no more.
 */
async function buildDoctors({ from, to, scope = 'all' }) {
  const where = { ...scopeWhere(scope), date: { gte: day(from), lte: day(to) } };

  const [byDoctorCampaign, revenue] = await Promise.all([
    prisma.metaCampaign.groupBy({
      by: ['doctor'], where,
      _sum: { cost: true, impressions: true, clicks: true, msgConversations: true, onFbLeads: true },
    }),
    require('./report.js').revenueCutsExcludingJournals(from, to),
  ]);

  const spendBy = new Map();
  for (const r of byDoctorCampaign) {
    if (!r.doctor) continue;
    spendBy.set(r.doctor, withCosts({ name: r.doctor, ...foldMetrics(r) }));
  }
  const revBy = new Map(revenue.doctors.map((d) => [d.name, d]));

  const names = [...new Set([...spendBy.keys(), ...revBy.keys()])];
  const doctors = names.map((name) => {
    const s = spendBy.get(name) || null;
    const rev = revBy.get(name) || null;
    return {
      name,
      cost: s ? s.cost : null,
      results: s ? s.results : null,
      costPerResult: s ? s.costPerResult : null,
      revenueEx: rev ? rev.ex : null,
      invoices: rev ? rev.invoices : null,
      ticket: rev ? rev.ticket : null,
      revenuePerPound: s && s.cost && rev ? r2(rev.ex / s.cost) : null,
      /* Named so a page can say which side of the join is missing instead of
         printing two dashes that look like a rendering fault. */
      state: s && rev ? 'both' : (s ? 'spend-only' : 'revenue-only'),
    };
  }).sort((a, b) => (b.cost || 0) - (a.cost || 0) || (b.revenueEx || 0) - (a.revenueEx || 0));

  const withSpend = doctors.filter((d) => d.cost);
  return {
    doctors,
    /* The share of paid spend that reaches a doctor we can also find in Odoo.
       Everything else is spend whose doctor is either unnamed in the campaign or
       spelled in a way the parser does not know. */
    matched: {
      spendMatched: r2(withSpend.filter((d) => d.state === 'both').reduce((t, d) => t + d.cost, 0)),
      spendTotal: r2(withSpend.reduce((t, d) => t + d.cost, 0)),
      spendOnly: withSpend.filter((d) => d.state === 'spend-only').map((d) => d.name),
      revenueOnly: doctors.filter((d) => d.state === 'revenue-only').length,
    },
  };
}

/* ------------------------------------------------------ 04 · lead quality --- */

/**
 * Meta leads, and what became of them.
 *
 * The chain is lead → booking → attended → invoiced, joined on `mobileKey`:
 * the normalised ten digits that `patients.js` owns and that `Appointment`
 * carries for exactly this purpose. One SQL statement, because four round trips
 * on the same CTE is four chances for the definitions to drift apart.
 *
 * `window` reports what Meta actually gave us against what was asked for. Leads
 * live for a rolling 90 days at source, so a range starting earlier is not a
 * quiet zero — it is a range whose lead half cannot be answered, and the page
 * has to say which.
 */
async function buildLeadQuality({ from, to, scope = 'all' }) {
  const ids = accountsForScope(scope);
  const gte = day(from), lte = endOfDay(to);

  /* THE BOUNDS GO IN AS TEXT AND ARE CAST TO `::timestamp`, and that is not
     stylistic.

     `MetaLead.createdAt` is `timestamp WITHOUT time zone` and this database's
     session runs `Africa/Cairo`. A JS Date handed to a raw query binds as
     `timestamptz`, so Postgres shifts the comparison by the offset: the same
     1-19 August window counted 2,029 leads bound as Dates and 2,014 bound as
     text. Prisma's typed queries (`count`, `groupBy`) convert correctly, so the
     raw chain silently disagreed with the panel beside it by fifteen leads —
     which is exactly the kind of gap nobody finds by reading a page. */
  const chain = await prisma.$queryRawUnsafe(`
    WITH l AS (
      SELECT "leadId", "mobileKey", "doctor", "formName", "createdAt"
        FROM "MetaLead"
       WHERE "createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp
         AND ($3::text[] IS NULL OR "accountId" = ANY($3::text[]))
    ),
    keys AS (SELECT DISTINCT "mobileKey" FROM l WHERE "mobileKey" IS NOT NULL),
    booked AS (
      SELECT DISTINCT a."mobileKey", a."partnerId"
        FROM "Appointment" a JOIN keys k ON k."mobileKey" = a."mobileKey"
    ),
    attended AS (
      SELECT DISTINCT a."mobileKey"
        FROM "Appointment" a JOIN keys k ON k."mobileKey" = a."mobileKey"
       WHERE a.states = 'done'
    )
    SELECT (SELECT COUNT(*) FROM l)::int                                   AS leads,
           (SELECT COUNT(*) FROM keys)::int                                AS with_key,
           (SELECT COUNT(*) FROM booked)::int                              AS booked,
           (SELECT COUNT(*) FROM attended)::int                            AS attended,
           (SELECT COUNT(DISTINCT i."partnerId") FROM "Invoice" i
             WHERE i.state = 'posted' AND i."moveType" = 'out_invoice'
               AND i."partnerId" IN (SELECT "partnerId" FROM booked WHERE "partnerId" IS NOT NULL))::int AS invoiced,
           (SELECT COALESCE(SUM(i."amountUntaxed"), 0)::float FROM "Invoice" i
             WHERE i.state = 'posted' AND i."moveType" = 'out_invoice'
               AND i."invoiceDate" >= $1::timestamp::date AND i."invoiceDate" <= $2::timestamp::date
               AND i."partnerId" IN (SELECT "partnerId" FROM booked WHERE "partnerId" IS NOT NULL))    AS revenue_ex,
           (SELECT MIN("createdAt") FROM "MetaLead")                       AS earliest_held,
           (SELECT MAX("createdAt") FROM "MetaLead")                       AS latest_held
  `, isoLocal(gte), isoLocal(lte), ids);

  const c = chain[0];
  const [byDoctor, byForm] = await Promise.all([
    prisma.metaLead.groupBy({
      by: ['doctor'],
      where: { createdAt: { gte, lte }, ...(ids ? { accountId: { in: ids } } : {}) },
      _count: { _all: true },
    }),
    prisma.metaLead.groupBy({
      by: ['formName'],
      where: { createdAt: { gte, lte }, ...(ids ? { accountId: { in: ids } } : {}) },
      _count: { _all: true },
    }),
  ]);

  const leads = c.leads;
  const rate = (n) => (leads ? r2(n / leads) : null);
  const earliest = c.earliest_held ? ymd(c.earliest_held) : null;

  return {
    leads,
    withKey: c.with_key,
    /* The ceiling on what can ever be matched. A conversion rate quoted without
       it has quietly shrunk its own denominator. */
    unmatchable: leads - c.with_key,
    booked: c.booked,
    attended: c.attended,
    invoiced: c.invoiced,
    revenueEx: r2(c.revenue_ex),
    rates: {
      usable: rate(c.with_key),
      booked: rate(c.booked),
      attended: rate(c.attended),
      invoiced: rate(c.invoiced),
    },
    byDoctor: byDoctor.map((r) => ({ name: r.doctor, leads: r._count._all }))
      .sort((a, b) => b.leads - a.leads),
    byForm: byForm.map((r) => ({ name: r.formName, leads: r._count._all }))
      .sort((a, b) => b.leads - a.leads),
    /* Meta keeps lead rows for a rolling 90 days. Everything before our earliest
       stored lead is gone at source and no licence recovers it, so a range that
       starts earlier gets told how much of itself is unanswerable rather than a
       rate computed over the part that survived. */
    window: {
      requestedFrom: from,
      requestedTo: to,
      earliestHeld: earliest,
      latestHeld: c.latest_held ? ymd(c.latest_held) : null,
      covered: !earliest || from >= earliest,
      note: earliest && from < earliest
        ? `Meta keeps lead-level rows for about 90 days. The earliest lead we hold is `
          + `${earliest}, so ${from} → ${earliest} has no lead data and never will — `
          + 'it was already gone at source. The counts below cover the part of this '
          + 'range that leads exist for.'
        : null,
    },
  };
}

/* ----------------------------------------------------------- 05 · social --- */

/**
 * Organic Instagram.
 *
 * Follower count is a running total, so a range shows the LAST day's value and
 * the change across the range — never a sum, which would add the same followers
 * once per day. New followers only exists for Instagram's thirty-day window and
 * is reported as available/absent rather than as zero.
 */
async function buildSocial({ from, to, scope = 'all' }) {
  const ids = profilesForScope(scope);
  const where = {
    source: 'live',
    date: { gte: day(from), lte: day(to) },
    ...(ids ? { profileId: { in: ids } } : {}),
  };

  const [rows, posts] = await Promise.all([
    prisma.igProfileDay.findMany({
      where, orderBy: { date: 'asc' },
      select: { profileId: true, profileName: true, date: true, followers: true, newFollowers: true, reach: true, views: true },
    }),
    prisma.igPost.findMany({
      where: {
        source: 'live',
        postedAt: { gte: day(from), lte: endOfDay(to) },
        ...(ids ? { profileId: { in: ids } } : {}),
      },
      orderBy: { views: 'desc' },
      select: { profileName: true, postedAt: true, format: true, caption: true, permalink: true, views: true, reach: true },
    }),
  ]);

  /* FOLLOWER COUNT IS A SNAPSHOT, NOT A SERIES.
     Instagram returns `followers_count` only on the LAST day of the queried
     window — 460 of the 461 days we hold carry 0, not because the account had
     no followers but because Instagram did not answer for that day. So there is
     no follower history to difference, and "growth across the range" cannot be
     computed from this field at all. Treating the 0s as real would have shown
     the clinic dropping from 226,093 to nothing and then back.

     What IS honest: the latest total we hold, labelled with its date, and the
     daily gains from the separate thirty-day pull. */
  const byProfile = new Map();
  for (const r of rows) {
    if (!byProfile.has(r.profileId)) {
      byProfile.set(r.profileId, {
        profileId: r.profileId,
        name: r.profileName,
        entity: ENTITY_BY_PROFILE[r.profileId] || null,
        days: 0,
        firstDay: ymd(r.date),
        lastDay: ymd(r.date),
        followers: null,
        followersAsAt: null,
        newFollowers: 0,
        daysWithGain: 0,
        views: 0,
        peakReach: { date: ymd(r.date), reach: r.reach },
      });
    }
    const p = byProfile.get(r.profileId);
    p.days += 1;
    p.lastDay = ymd(r.date);
    p.views += r.views;
    /* Only a non-zero reading is a reading. */
    if (r.followers > 0) { p.followers = r.followers; p.followersAsAt = ymd(r.date); }
    if (r.newFollowers > 0) { p.newFollowers += r.newFollowers; p.daysWithGain += 1; }
    if (r.reach > p.peakReach.reach) p.peakReach = { date: ymd(r.date), reach: r.reach };
  }

  /* When the range does not include the day Instagram answered on, fall back to
     the newest total we hold anywhere and say which day it is from. A stale
     figure that is labelled is useful; an unlabelled one is a trap. */
  for (const p of byProfile.values()) {
    if (p.followers !== null) continue;
    const latest = await prisma.igProfileDay.findFirst({
      where: { profileId: p.profileId, followers: { gt: 0 } },
      orderBy: { date: 'desc' },
      select: { followers: true, date: true },
    });
    if (latest) {
      p.followers = latest.followers;
      p.followersAsAt = ymd(latest.date);
      p.followersOutsideRange = true;
    }
  }

  const profiles = [...byProfile.values()].map((p) => ({
    ...p,
    /* True only when Instagram gave a gain for every day in the range. Summing
       the days it did answer and calling it the range's total would understate
       any range longer than thirty days without saying so. */
    newFollowersCovered: p.days > 0 && p.daysWithGain >= p.days,
    newFollowersDays: `${p.daysWithGain}/${p.days}`,
  })).sort((a, b) => (b.followers || 0) - (a.followers || 0));

  /* The profiles we know about and did NOT get: the doctors' own accounts,
     refused for a prioritised-account slot. Named here so the panel can show an
     absence with a reason rather than an empty table. */
  const held = new Set(profiles.map((p) => p.profileId));
  const absent = IG_PROFILES
    .filter((p) => p.kind === 'doctor' && !held.has(p.id))
    .map((p) => p.name);

  return {
    profiles,
    posts: posts.slice(0, 50).map((p) => ({
      profile: p.profileName,
      postedAt: p.postedAt.toISOString(),
      format: p.format,
      /* Enough of the caption to recognise the post, not the whole essay. */
      caption: p.caption ? p.caption.slice(0, 160) : null,
      permalink: p.permalink,
      views: p.views,
      reach: p.reach,
    })),
    postCount: posts.length,
    absentProfiles: absent,
  };
}

/* ------------------------------------------------- 06 · what exists --- */

/**
 * Provenance, per table: where the rows came from, when they were loaded, and
 * what the range is missing.
 *
 * This is the tab that keeps the rest of the report honest. Half of what report
 * 02 shows is seeded from a frozen HTML pack and some of what report 03 wants
 * has no source at all, so every panel elsewhere prints the provenance of its
 * own numbers and this one lists them together.
 */
async function buildProvenance({ from, to }) {
  const gte = day(from), lte = day(to);
  const rangeOnly = { date: { gte, lte } };

  const [metaDay, campaign, ad, lead, igDay, igPost, uploads] = await Promise.all([
    prisma.metaDay.groupBy({ by: ['source'], where: rangeOnly, _count: { _all: true }, _max: { loadedAt: true } }),
    prisma.metaCampaign.groupBy({ by: ['source'], where: rangeOnly, _count: { _all: true }, _max: { loadedAt: true } }),
    prisma.metaAd.groupBy({ by: ['source'], where: rangeOnly, _count: { _all: true }, _max: { loadedAt: true } }),
    prisma.metaLead.groupBy({
      by: ['source', 'channel'],
      where: { createdAt: { gte, lte: endOfDay(to) } },
      _count: { _all: true }, _max: { loadedAt: true },
    }),
    prisma.igProfileDay.groupBy({ by: ['source'], where: rangeOnly, _count: { _all: true }, _max: { loadedAt: true } }),
    prisma.igPost.groupBy({
      by: ['source'], where: { postedAt: { gte, lte: endOfDay(to) } },
      _count: { _all: true }, _max: { loadedAt: true },
    }),
    prisma.dataUpload.findMany({ orderBy: { createdAt: 'desc' }, take: 12 }),
  ]);

  const fold = (label, groups, note) => ({
    label,
    note: note || null,
    sources: groups.map((g) => ({
      source: g.source,
      channel: g.channel || null,
      rows: g._count._all,
      loadedAt: g._max.loadedAt ? g._max.loadedAt.toISOString() : null,
    })).sort((a, b) => b.rows - a.rows),
    rows: groups.reduce((t, g) => t + g._count._all, 0),
  });

  return {
    tables: [
      fold('Paid delivery, by day', metaDay),
      fold('Campaigns', campaign, 'Doctor, service and branch are read out of the campaign name — an inference, never a fact.'),
      fold('Ads', ad, 'Service and branch are inherited from the parent campaign where the ad name is silent.'),
      fold('Meta leads', lead, 'Meta keeps lead-level rows for about 90 days; older leads are gone at source.'),
      fold('Instagram profile days', igDay, 'New followers exist only for the last 30 days — Instagram will not serve them for older windows.'),
      fold('Instagram posts', igPost),
    ],
    uploads: uploads.map((u) => ({
      kind: u.kind,
      filename: u.filename,
      from: u.rangeFrom ? ymd(u.rangeFrom) : null,
      to: u.rangeTo ? ymd(u.rangeTo) : null,
      rows: u.rowsWritten,
      notes: u.notes,
      actor: u.actor,
      at: u.createdAt.toISOString(),
    })),
    /* What is known to be missing and why, with the remedy rather than a shrug.
       These are measured refusals, not guesses — see the plan file. */
    absent: [
      {
        what: 'The spare Zat ad account (act_1675236640073425)',
        why: 'Not on the licence\'s prioritised-account list. It is connected and ACTIVE on Meta.',
        fix: 'Add it at hub.supermetrics.com/subscriptions/1743532#datasource-FA',
      },
      {
        what: 'Instagram for the four doctors',
        why: 'Same prioritised-account quota. Verified refused on 2026-09-04.',
        fix: 'Add the profiles at hub.supermetrics.com/subscriptions/1743532#datasource-IGI',
      },
      {
        what: 'Leads from Zat l EGP 2025 (act_1423050112053946)',
        why: 'Facebook withholds lead rows for that account for want of permission scopes. Its spend and results are unaffected.',
        fix: 'Re-authorise that account\'s Facebook data source in Supermetrics with the scopes the error lists.',
      },
      {
        what: 'Leads older than about 90 days',
        why: 'Meta does not retain them. A query for 1-30 June returned rows from 6 June only.',
        fix: 'Nothing recovers them. Keep syncing — every 90 days without a sync loses that history permanently.',
      },
      {
        what: 'Organic and CTA leads',
        why: 'No source connected. The 811-row sheet has never been imported.',
        fix: 'The Admin uploads tab, once the sheet is provided.',
      },
      {
        what: 'Three ad accounts (Alexandria, Greater Cairo, Cairo)',
        why: 'DISABLED by Meta — "flagged for unusual activity, all ads paused".',
        fix: 'A Meta account matter, not a data one.',
      },
    ],
  };
}

module.exports = {
  buildPaid, buildCampaigns, buildAds, buildDoctors, buildLeadQuality,
  buildSocial, buildProvenance,
  ENTITY_BY_ACCOUNT, ENTITY_BY_PROFILE, accountsForScope, profilesForScope,
  coverageOf, rollBy,
};
