/* ============================================================
   Writing Meta and Instagram rows into Postgres.

   The single writer for BOTH sources. `scripts/sync-meta.js --source api` (the
   server key) and `--source bootstrap` (rows captured through an interactive
   MCP session) normalise to the same row objects and call the same functions
   here, so the day the subscription lands nothing downstream changes and there
   is no second copy of the write rules to keep in step.

   Three rules hold throughout:

   1. DELETE THEN INSERT, scoped to (range, source). Meta restates: spend for
      yesterday is not final, a campaign gets renamed, an ad's attribution
      window closes late. Upserting row by row leaves the restated ones behind
      and the totals drift the way the 11 August collections snapshot drifted
      12.3% in eight days. Scoping the delete by `source` is what lets a seeded
      row and a live row coexist without one erasing the other.

   2. `source` AND `loadedAt` ON EVERY ROW. A figure whose provenance is
      invisible is a figure nobody can challenge, and half of what these two
      reports show starts life seeded from a frozen HTML pack.

   3. NO IDENTIFYING LEAD DATA. `MetaLead` gets the ten-digit join key and
      never the raw +20 number or the name — the phone arrives in the query
      because that is the only way to compute the key, and it is dropped here,
      before the database. The unresolved call list makes the opposite call for
      the opposite reason: it exists to be phoned.
   ============================================================ */

const { prisma, dateOnly } = require('./db.js');
const { mobileKey } = require('./patients.js');
const { parseCampaign, parseAd, parseLeadForm } = require('./meta-parse.js');

const CHUNK = 1000;

/* Supermetrics sends numbers as strings, blanks as '' and zeroes as '0.00'.
   `Number('')` is 0, which is right here — a metric absent for a day genuinely
   is zero — but `Number(undefined)` is NaN, which Postgres rejects on an Int
   column, so the guard is not decorative. */
const n = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const x = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const int = (v) => Math.round(n(v));
/* Decimal(14,2) takes a string without losing the last piastre to a float. */
const money = (v) => n(v).toFixed(2);
const str = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

/** An account id with or without Meta's `act_` prefix — one spelling in the DB. */
const acctId = (v) => String(v || '').replace(/^act_/, '');

/* Supermetrics returns rows with an EMPTY date — three of them in the 15-month
   day pull, one per account, carrying nulls for every metric. They are the
   account's own row with no day attached. `dateOnly('')` makes an Invalid Date
   and Postgres rejects the whole insert, so a row without a real day is dropped
   here rather than taking the sync down with it. */
const day = (v) => {
   const t = String(v == null ? '' : v).trim();
   return /^\d{4}-\d{2}-\d{2}/.test(t) ? dateOnly(t.slice(0, 10)) : null;
};

/**
 * The span to clear before inserting: the requested window UNION the days the
 * rows actually carry.
 *
 * Both halves are necessary, and the union is not belt-and-braces — each half
 * alone is a real failure that happened:
 *
 *   requested only  the day pull for "2025-06-01 → 2026-09-04" also returns
 *                   zero-spend rows going back to January 2025, because
 *                   Supermetrics answers with the account's whole series. Those
 *                   rows insert, sit outside the delete window, and the next
 *                   load dies on the (accountId, date, source) unique
 *                   constraint. This is exactly how this function failed the
 *                   first time it was run against a real capture.
 *   coverage only   a day whose spend was retracted returns NO row, so nothing
 *                   clears the stale one and the report keeps showing money
 *                   that Meta no longer reports.
 *
 * `MetaLead` deliberately does NOT use this — see the comment there: its
 * history cannot be re-fetched, so it clears coverage only.
 */
function spanFor(from, to, dates) {
  const stamps = dates.filter(Boolean).map((d) => d.getTime());
  const lo = Math.min(dateOnly(from).getTime(), ...stamps);
  const hi = Math.max(dateOnly(to).getTime(), ...stamps);
  return { gte: new Date(lo), lte: new Date(hi) };
}

/** Insert in chunks; `createMany` on tens of thousands of rows at once is how a sync OOMs. */
async function insertChunked(tx, model, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const made = await tx[model].createMany({ data: rows.slice(i, i + CHUNK) });
    written += made.count;
  }
  return written;
}

/* --------------------------------------------------------------- day level */

/**
 * Daily spend and results per ad account.
 *
 * `conversations` and `on_fb_leads` are stored apart. Report 03's "results" is
 * their sum — 2,239 + 2,326 = 4,565 — and adding them here would make the total
 * right and the split unrecoverable.
 */
async function writeMetaDays({ rows, from, to, source = 'live', accountName }) {
  const data = rows.map((r) => ({
    accountId: acctId(r.account_id || r.accountId),
    accountName: str(r.account_name || r.accountName || accountName) || 'unknown',
    date: day(r.date),
    cost: money(r.cost),
    impressions: int(r.impressions),
    /* Stored, but NEVER summed across days downstream: Supermetrics flags reach
       is_non_aggregatable because it counts people, and the same person seen on
       Monday and Tuesday is one person. A range "total reach" built by adding
       these overstates itself the longer the range. */
    reach: int(r.reach),
    clicks: int(r.clicks),
    msgConversations: int(r.conversations),
    onFbLeads: int(r.on_fb_leads),
    source,
  })).filter((d) => d.accountId && d.date);

  return prisma.$transaction(async (tx) => {
    await tx.metaDay.deleteMany({
      where: { source, date: spanFor(from, to, data.map((d) => d.date)) },
    });
    return { written: await insertChunked(tx, 'metaDay', data) };
  }, { timeout: 300000 });
}

/* ---------------------------------------------------------- campaign level */

/**
 * Campaigns for the window, with doctor / service / branch read out of the name.
 *
 * The parse is an INFERENCE and every one of the three is nullable. It is
 * applied on the way in rather than at read time so that a name the parser does
 * not recognise is visible in the table as a null — countable, reportable — and
 * not re-guessed differently by each panel that happens to render it.
 */
async function writeCampaigns({ rows, from, to, source = 'live', accountName }) {
  const data = rows.map((r) => {
    const name = str(r.campaign_name || r.name) || '(unnamed)';
    const p = parseCampaign(name, r.objective);
    return {
      campaignId: str(r.campaign_id),
      accountId: acctId(r.account_id || r.accountId),
      accountKey: str(r.account_name || r.accountName || accountName) || 'unknown',
      name,
      objective: p.objective || null,
      date: day(r.date),
      startDate: day(r.campaign_start),
      budgetDaily: r.budget === null || r.budget === undefined || r.budget === ''
        ? null : money(r.budget),
      cost: money(r.cost),
      impressions: int(r.impressions),
      clicks: int(r.clicks),
      msgConversations: int(r.conversations),
      onFbLeads: int(r.on_fb_leads),
      doctor: p.doctor,
      service: p.service,
      branch: p.branch,
      source,
    };
  }).filter((d) => d.accountId && d.date);

  return prisma.$transaction(async (tx) => {
    /* Scoped to the accounts this pull covered AND the days it covered. Both
       halves matter: without the account scope a single-account refresh wipes
       the other two, and without the day scope a one-week refresh wipes the
       year. */
    const accounts = [...new Set(data.map((d) => d.accountId))];
    if (accounts.length) {
      await tx.metaCampaign.deleteMany({
        where: {
          source,
          accountId: { in: accounts },
          date: spanFor(from, to, data.map((d) => d.date)),
        },
      });
    }
    return { written: await insertChunked(tx, 'metaCampaign', data), accounts: accounts.length };
  }, { timeout: 300000 });
}

/* --------------------------------------------------------------- ad level */

/**
 * Ads, each resolved from its own name first and then from its campaign.
 *
 * Inheritance is not a nicety: the ad named `offer` is Laser at Mall Of Arabia
 * in one campaign and unlabelled at Alexandria in another, and `lpg`/`onda` are
 * body devices sitting in the Nutrition campaign. `inherited` records which
 * fields were filled from the parent so the page can show an inference as an
 * inference.
 */
async function writeAds({ rows, campaignRows = [], from, to, source = 'live' }) {
  /* Parse each campaign name once. Ads share campaigns heavily — 34 ads across
     39 campaigns in the source pack — and the parse is pure. */
  const parsed = new Map();
  const parseFor = (campaignName) => {
    const key = String(campaignName || '');
    if (!parsed.has(key)) {
      const hint = campaignRows.find((c) => String(c.campaign_name || c.name || '') === key);
      parsed.set(key, parseCampaign(key, hint && hint.objective));
    }
    return parsed.get(key);
  };

  const data = rows.map((r) => {
    const name = str(r.ad_name || r.name) || '(unnamed)';
    const campaignName = str(r.campaign_name) || '';
    const p = parseAd(name, parseFor(campaignName));
    return {
      adId: str(r.ad_id),
      accountId: acctId(r.account_id || r.accountId),
      campaignName,
      name,
      date: day(r.date),
      cost: money(r.cost),
      impressions: int(r.impressions),
      clicks: int(r.clicks),
      msgConversations: int(r.conversations),
      onFbLeads: int(r.on_fb_leads),
      doctor: p.doctor,
      service: p.service,
      branch: p.branch,
      inherited: p.inherited,
      source,
    };
  }).filter((d) => d.accountId && d.date);

  return prisma.$transaction(async (tx) => {
    const accounts = [...new Set(data.map((d) => d.accountId))];
    if (accounts.length) {
      await tx.metaAd.deleteMany({
        where: {
          source,
          accountId: { in: accounts },
          date: spanFor(from, to, data.map((d) => d.date)),
        },
      });
    }
    return { written: await insertChunked(tx, 'metaAd', data), accounts: accounts.length };
  }, { timeout: 300000 });
}

/* ------------------------------------------------------------ lead level */

/**
 * Leads, reduced to a join key.
 *
 * Returns `dropped` — leads whose phone number would not normalise — because
 * that count is the honest ceiling on how many leads can ever be matched to a
 * patient, and a lead-to-patient rate quoted without it is quoting a
 * denominator it has quietly shrunk.
 */
async function writeLeads({ rows, from, to, source = 'live', channel = 'ad' }) {
  let dropped = 0;
  const seen = new Set();
  const data = [];
  for (const r of rows) {
    const leadId = str(r.lead_id || r.leadId);
    if (!leadId) { dropped++; continue; }
    /* A lead can appear twice when a pull overlaps a previous window; `leadId`
       is the primary key and createMany would throw on the second one. */
    if (seen.has(leadId)) continue;
    seen.add(leadId);
    const key = mobileKey(r.lead_phone_number || r.phone || r.mobileKey);
    if (!key) dropped++;
    const formName = str(r.lead_form_name || r.formName);
    data.push({
      leadId,
      accountId: acctId(r.account_id || r.accountId),
      createdAt: new Date(r.lead_created_time || r.createdAt),
      formName,
      doctor: parseLeadForm(formName).doctor,
      mobileKey: key,   // the raw number and `lead_full_name` stop here
      channel,
      source,
    });
  }

  /* THE DELETE IS SCOPED TO WHAT ACTUALLY CAME BACK, not to what was asked for,
     and that distinction is the difference between a working report and
     permanent data loss.

     MEASURED on 2026-09-04: Meta retains lead-level rows for a ROLLING 90 DAYS.
     A query for 1-30 June returned rows beginning 6 June and nothing earlier;
     a query whose window lies entirely before that is refused outright. So the
     rows in this table older than 90 days CANNOT BE RE-FETCHED — once they
     leave Meta's window, our copy is the only copy.

     A nightly `--from 2025-06-01` refresh would therefore delete fifteen months
     of leads and re-insert three, and no error would appear anywhere. Deleting
     only across the span the incoming rows cover makes the sync additive over
     time: old leads accumulate and survive, new ones replace themselves. */
  const stamps = data.map((d) => d.createdAt.getTime()).filter((t) => !Number.isNaN(t));
  const covered = stamps.length
    ? { gte: new Date(Math.min(...stamps)), lte: new Date(Math.max(...stamps)) }
    : null;

  const written = await prisma.$transaction(async (tx) => {
    /* No rows means nothing to replace. An empty pull — a refused account, a
       window Meta no longer holds — must never be allowed to clear the table. */
    if (covered) {
      await tx.metaLead.deleteMany({ where: { source, channel, createdAt: covered } });
    }
    return insertChunked(tx, 'metaLead', data);
  }, { timeout: 120000 });

  return {
    written, dropped, withKey: data.filter((d) => d.mobileKey).length,
    /* Reported so the sync log shows the window Meta really answered with,
       which is not always the one it was asked for. */
    covered: covered && { from: covered.gte.toISOString().slice(0, 10),
      to: covered.lte.toISOString().slice(0, 10) },
  };
}

/* ------------------------------------------------------------- Instagram */

/**
 * Instagram profile days, assembled from TWO pulls.
 *
 * `rows` is the long history (follower total, reach, views) and `gains` is the
 * last thirty days of new-follower counts, which Instagram refuses to serve for
 * any older window. They are merged on (profile, day) here so the table has one
 * row per profile-day either way — and a day outside the thirty simply has no
 * gain, which the report shows as absent rather than as zero. Zero would be a
 * claim that nobody followed that day; absent is the truth, which is that
 * Instagram will not say.
 */
async function writeIgProfileDays({ rows, gains = [], from, to, source = 'live' }) {
  const gainBy = new Map();
  for (const g of gains) {
    const d = day(g.date);
    if (!d) continue;
    gainBy.set(`${String(g.profile_id || g.profileId || '')}|${d.toISOString().slice(0, 10)}`,
      g.follower_count_gained);
  }
  const data = rows.map((r) => ({
    profileId: String(r.profile_id || r.profileId || ''),
    profileName: str(r.profile_name || r.profileName) || 'unknown',
    date: day(r.date),
    followers: int(r.followers_count),
    newFollowers: int(gainBy.get(`${String(r.profile_id || r.profileId || '')}|`
      + `${(day(r.date) || new Date(0)).toISOString().slice(0, 10)}`)),
    reach: int(r.reach),
    views: int(r.views),
    source,
  })).filter((d) => d.profileId && d.date);

  return prisma.$transaction(async (tx) => {
    await tx.igProfileDay.deleteMany({
      where: { source, date: spanFor(from, to, data.map((d) => d.date)) },
    });
    return { written: await insertChunked(tx, 'igProfileDay', data) };
  }, { timeout: 120000 });
}

async function writeIgPosts({ rows, from, to, source = 'live' }) {
  const data = rows.map((r) => ({
    postId: str(r.post_id),
    profileId: String(r.profile_id || r.profileId || ''),
    profileName: str(r.profile_name || r.profileName) || 'unknown',
    postedAt: new Date(r.post_created_time || r.postedAt),
    format: str(r.post_type),
    caption: str(r.post_caption),
    permalink: str(r.post_permalink),
    views: int(r.views),
    reach: int(r.reach),
    source,
  })).filter((d) => d.profileId && !Number.isNaN(d.postedAt.getTime()));

  return prisma.$transaction(async (tx) => {
    await tx.igPost.deleteMany({
      where: {
        source,
        postedAt: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T23:59:59.999Z`),
        },
      },
    });
    return { written: await insertChunked(tx, 'igPost', data) };
  }, { timeout: 120000 });
}

/** Log what a load did, so a figure's history is answerable a month later. */
async function recordLoad({ kind, from, to, rowsWritten, notes, actor }) {
  return prisma.dataUpload.create({
    data: {
      kind,
      rangeFrom: from ? dateOnly(from) : null,
      rangeTo: to ? dateOnly(to) : null,
      rowsWritten: rowsWritten || 0,
      notes: notes || null,
      actor: actor || null,
    },
  });
}

module.exports = {
  writeMetaDays, writeCampaigns, writeAds, writeLeads,
  writeIgProfileDays, writeIgPosts, recordLoad,
  /* exported for the tests */ _coerce: { n, int, money, str, acctId, day },
};
