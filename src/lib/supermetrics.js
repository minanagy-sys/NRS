/* ============================================================
   Supermetrics client.

   ONE query shape, TWO transports. That is the whole point of this module.

   The query object here — `ds_id`, `ds_accounts`, `fields`, the date range,
   `filters`, `settings` — is the payload the Supermetrics Query API takes AND,
   field for field, the argument list of the `data_query` MCP tool. So the
   bootstrap path (rows pulled through an interactive MCP session, which is how
   report 03 has data today) and the unattended path (a server API key, once the
   subscription exists) build the *same* query and hand the *same* normalised
   rows to the same writer. Nothing downstream can tell them apart, which is
   what makes the bootstrap disposable rather than a second implementation to
   keep in step.

   WHAT IS VERIFIED AND WHAT IS NOT, stated plainly because the difference
   matters when this first runs for real:

     verified  the query shape, the field ids, the account ids, and the numbers
               they return — every figure below was pulled and reconciled
               against the frozen report pack (466,114 spend, 4,565 results).
     verified  the async pattern: a query answers either with rows or with a
               `schedule_id` to poll. The lead-level pull takes minutes.
     verified  the prioritised-account refusal, which is a LICENCE QUOTA and not
               an error in our request — `act_1675236640073425` and the four
               doctor Instagram profiles are connected and readable, they are
               simply not in the licence's prioritised list.
     verified  the REST contract, against the published docs on 2026-09-07:
               POST api.supermetrics.com/enterprise/v2/query/data/json, the query
               object at the top level, the key in an `Authorization: Bearer`
               header, and the filter field spelled `filter`. Correcting those
               three details is the whole reason to check documentation before a
               first call rather than after it — each was wrong in the version
               written from memory, and each fails on the first request.
     NOT       an actual round trip. No server key has been issued yet, so
               nothing here has spoken to api.supermetrics.com. The first real
               call is `scripts/verify-supermetrics.js --source api`, which
               proves it against the frozen figures rather than my say-so.

   Never let this module be called per web request. Supermetrics polls, the lead
   query took minutes, and the other reports answer any range in under a second.
   It fills Postgres; the pages read Postgres.
   ============================================================ */

const { fetchRetry } = require('./http.js');

/* The Query API. Overridable because the endpoint is the one part of the
   contract we have not been able to exercise (see above). */
const DEFAULT_BASE = 'https://api.supermetrics.com';
const QUERY_PATH = '/enterprise/v2/query/data/json';

/* Data source ids, as Supermetrics names them. `FA` is Facebook/Meta Ads and
   `IGI` is Instagram Insights. */
const DS = { META_ADS: 'FA', INSTAGRAM: 'IGI' };

/* The three ad accounts that carry spend in the report window, plus the two
   that do not answer, kept here rather than in the script so the reason each is
   listed survives. Names are Supermetrics' own. */
const AD_ACCOUNTS = [
  { id: 'act_822787769703389', name: 'Doctors', state: 'active' },
  { id: 'act_420792247234306', name: 'Backup', state: 'active' },
  { id: 'act_1423050112053946', name: 'Zat l EGP 2025', state: 'active' },
  /* Connected and ACTIVE on Meta — Supermetrics refuses it for want of a
     prioritised slot. Left in the list deliberately: the sync must report it as
     refused, not quietly omit an account somebody is spending money on. */
  { id: 'act_1675236640073425', name: 'Zat', state: 'not-prioritised' },
];

/* The Instagram profiles that belong to THIS client.
   Named explicitly because the Supermetrics connection carries sixteen, and the
   other ten are other clients of the agency — AMS, Mega Masr, MWG, Q Store,
   You Real Estate, Sun International. A query for "all accounts" would put
   another client's reach onto a Nouvelage report. */
const IG_PROFILES = [
  { id: '17841401920364985', name: 'Nouvel Âge Aesthetic Clinics', state: 'active', kind: 'clinic' },
  { id: '17841471301948724', name: 'Zat Aesthetic clinics', state: 'active', kind: 'clinic' },
  /* The doctors' own profiles. Whether these answer depends on the licence's
     prioritised-account quota, so the sync reports them refused rather than
     leaving the per-doctor organic section silently empty. */
  { id: '17841401689022656', name: 'Dr. Ghada Amer', state: 'active', kind: 'doctor' },
  { id: '17841400491558072', name: 'Dr.Poussy Maher Hanna', state: 'active', kind: 'doctor' },
  { id: '17841444044579815', name: 'Randa El Aguizy', state: 'active', kind: 'doctor' },
  { id: '17841401982350302', name: 'Dr. Merna Ashraf El-Saadany', state: 'active', kind: 'doctor' },
];

/* Field ids, VERIFIED against `field_discovery` on 2026-09-04 — not guessed.
   Several are not what a reasonable person would guess, which is exactly why
   they are pinned here in one place:

     Date                              the date dimension, capital D
     Clicks                            clicks (all), capital C
     profile / profileID               the ad ACCOUNT's name and id
     adcampaign_name / adcampaign_id   the campaign's
     new_messaging_conversations       "New messaging contacts" — report 03's 2,239
     onsite_conversion.lead_grouped    "On-Facebook leads" — report 03's 2,326

   Each entry is [supermetrics field id, the key we use downstream], so the
   writer never has to know Supermetrics' spelling and there is exactly one
   place to correct when Supermetrics renames something.

   Dimensions come before metrics because the API requires that order.

   `reach` is flagged is_non_aggregatable BY SUPERMETRICS: it is people, not
   events, so daily reach rows MUST NOT be summed into a range total — the same
   person seen on Monday and Tuesday is one person, and adding the days counts
   them twice. It is stored per day and the report says so rather than printing
   a number that overstates itself the longer the range gets. */
const FIELDS = {
  day: [
    ['profileID', 'account_id'], ['profile', 'account_name'], ['Date', 'date'],
    ['cost', 'cost'], ['impressions', 'impressions'], ['reach', 'reach'],
    ['Clicks', 'clicks'],
    ['new_messaging_conversations', 'conversations'],
    ['onsite_conversion.lead_grouped', 'on_fb_leads'],
  ],
  /* Campaigns and ads are pulled PER DAY. A row meaning "1-19 August" can never
     be re-cut into 1-10, and the reports have to answer whatever range the
     reader picks. */
  campaign: [
    ['profileID', 'account_id'], ['profile', 'account_name'], ['Date', 'date'],
    ['adcampaign_id', 'campaign_id'], ['adcampaign_name', 'campaign_name'],
    ['campaignobjective', 'objective'], ['campaign_start_date', 'campaign_start'],
    ['campaign_daily_budget', 'budget'],
    ['cost', 'cost'], ['impressions', 'impressions'], ['Clicks', 'clicks'],
    ['new_messaging_conversations', 'conversations'],
    ['onsite_conversion.lead_grouped', 'on_fb_leads'],
  ],
  ad: [
    ['profileID', 'account_id'], ['profile', 'account_name'], ['Date', 'date'],
    ['ad_id', 'ad_id'], ['ad_name', 'ad_name'], ['adcampaign_name', 'campaign_name'],
    ['cost', 'cost'], ['impressions', 'impressions'], ['Clicks', 'clicks'],
    ['new_messaging_conversations', 'conversations'],
    ['onsite_conversion.lead_grouped', 'on_fb_leads'],
  ],
  /* Lead level. `lead_phone_number` comes back as `+201066566593`, which
     patients.js -> mobileKey already normalises. The raw number never reaches
     Postgres — see the MetaLead comment in schema.prisma. */
  lead: [
    ['profileID', 'account_id'], ['lead_id', 'lead_id'],
    ['lead_created_time', 'lead_created_time'],
    ['lead_form_name', 'lead_form_name'],
    ['lead_phone_number', 'lead_phone_number'],
  ],
  /* Instagram Insights groups its fields into report_types and every field in
     one query must share one. `AccountInfoDim` is the only type carrying the
     lifetime follower count alongside the daily reach/views/new-followers, so
     it is the one that answers the Social tab in a single pull. */
  igProfile: [
    ['account_id', 'profile_id'], ['username', 'profile_name'], ['date', 'date'],
    ['followers_count', 'followers_count'],
    ['reach', 'reach'], ['profile_views', 'views'],
  ],
  /* New followers is a SEPARATE PULL, and not by choice: asking for it
     alongside the rest is refused outright —

       "New followers" metric only supports querying data for the last 30 days
       excluding the current day

     — which takes the whole query down with it, history included. So the long
     series comes back without it and this fills in the recent month. Rows older
     than thirty days therefore carry a follower TOTAL but no daily gain, and
     that is a limit of Instagram's API rather than a gap in the sync. */
  igNewFollowers: [
    ['account_id', 'profile_id'], ['username', 'profile_name'], ['date', 'date'],
    ['follower_count', 'follower_count_gained'],
  ],
  igPost: [
    ['account_id', 'profile_id'], ['username', 'profile_name'],
    ['media_id', 'post_id'], ['timestamp', 'post_created_time'],
    ['media_type', 'post_type'], ['media_caption', 'post_caption'],
    ['media_permalink', 'post_permalink'],
    ['media_views', 'views'], ['media_reach', 'reach'],
  ],
};

/* INSTAGRAM TAKES NO `report_type`, and sending one is fatal on the REST API.
   `data_source_discovery` says it plainly: `has_report_type_selection: false`.
   The MCP tool accepts the key and ignores it, which is why it was here — the
   bootstrap pulled 922 profile-days and 299 posts with a report_type that did
   nothing. The REST API rejects any unknown setting key outright with
   `SETTING_KEY_INVALID`, so the first live sync died on the Instagram step
   after the ad and lead pulls had already succeeded.

   Which report you get is decided by the FIELDS you ask for, not by a setting.
   Verified against the live API: the profile and post field lists both return
   the right rows with no settings at all.

   The only settings Instagram Insights actually has are
   `exclude_invalid_accounts` and `comments_maximum_count`. The first is worth
   sending — a disabled profile in the account list otherwise fails the whole
   query rather than being skipped. */
const IG_SETTINGS = { exclude_invalid_accounts: true };

/** The `fields` value to send for one of the lists above. */
const ids = (list) => list.map((f) => f[0]);

/** Is this one of the FIELDS lists (pairs) rather than a bare list of ids? */
const isPairs = (f) => Array.isArray(f) && f.length > 0 && Array.isArray(f[0]);
const fieldIds = (f) => {
  if (isPairs(f)) return ids(f);
  return Array.isArray(f) ? f.slice() : String(f).split(',');
};

/**
 * Rename a row object's keys from Supermetrics' spelling to ours.
 *
 * Applied immediately after `rowsToObjects`, so nothing downstream — not the
 * writer, not the bootstrap capture on disk — carries a Supermetrics field id.
 */
function normalise(list, rows) {
  return rows.map((r) => {
    const o = {};
    for (const [from, to] of list) o[to] = r[from];
    return o;
  });
}

/* ------------------------------------------------------------------ errors */

/** Kinds a caller can act on differently. */
const KINDS = {
  AUTH: 'auth',                   // the key is wrong or the licence has lapsed
  NOT_PRIORITISED: 'not-prioritised', // a quota on our subscription, not our bug
  /* Facebook — not Supermetrics — is withholding the data: the connection lacks
     the scopes lead retrieval needs. VERIFIED 2026-09-04: lead rows come back
     for `act_822787769703389` and `act_420792247234306` and are refused for
     `act_1423050112053946`, same query, same window. So it is per-account and
     fixed by re-authorising that account's Facebook connection with the scopes
     the error names, NOT by anything in this code. */
  PERMISSIONS: 'permissions',
  QUOTA: 'quota',                 // row or request limits
  TRANSPORT: 'transport',         // never reached Supermetrics
  API: 'api',                     // Supermetrics answered with a refusal
};

class SuperAPIError extends Error {
  constructor(message, kind, detail) {
    super(message);
    this.name = 'SuperAPIError';
    this.kind = kind || KINDS.API;
    if (detail) this.detail = detail;
  }
}

/* The refusal we hit constantly, given a name so callers stop treating it as a
   generic failure. It is the reason the spare Zat account and all four doctor
   Instagram profiles are empty, and the fix is a click on the subscription page
   rather than a change here — so the message says where to click. */
const PRIORITISE_AT = (teamLicence) =>
  `hub.supermetrics.com/subscriptions/${teamLicence || '<licence>'}`;

function classify(message, teamLicence) {
  const m = String(message || '');
  if (/not\s+prioriti[sz]ed|prioriti[sz]ed\s+account|not\s+in\s+the\s+prioriti/i.test(m)) {
    return new SuperAPIError(
      `${m.trim()} — this is a licence quota, not a bad request. Add the account at `
      + `${PRIORITISE_AT(teamLicence)} (#datasource-FA for ad accounts, `
      + '#datasource-IGI for Instagram profiles).',
      KINDS.NOT_PRIORITISED, m);
  }
  /* Tested before AUTH: this message also contains an authorization URL, and
     the generic "sign in again" answer would be wrong — nobody's key has
     expired, a specific ad account's Facebook connection is missing scopes. */
  if (/grant\s+extended\s+permissions|extended\s+permissions/i.test(m)) {
    return new SuperAPIError(
      `${m.trim().split('(authorization URL')[0].trim()} — Facebook is withholding `
      + 'this, not Supermetrics. Re-authorise that ad account\'s Facebook data '
      + 'source in Supermetrics with the scopes the error lists (lead retrieval '
      + 'needs the pages_* and ads_management ones). Spend and results for the '
      + 'same account are unaffected; only lead-level rows are refused.',
      KINDS.PERMISSIONS, m);
  }
  if (/unauthori[sz]ed|invalid\s+api\s*key|expired|licen[cs]e/i.test(m)) {
    return new SuperAPIError(m, KINDS.AUTH, m);
  }
  if (/quota|rate\s*limit|too\s+many|row\s+limit/i.test(m)) {
    return new SuperAPIError(m, KINDS.QUOTA, m);
  }
  return new SuperAPIError(m, KINDS.API, m);
}

/* ------------------------------------------------------------------- query */

/**
 * Build a query. The single place that knows the payload shape, so the MCP
 * bootstrap and the REST client cannot drift.
 *
 * Returns a plain object that is BOTH the REST `json` payload and the MCP
 * `data_query` arguments — the two contracts are the same field list, which is
 * why one builder can serve both.
 */
function buildQuery({ dsId, accounts, fields, from, to, filters, maxRows, settings, timezone }) {
  if (!dsId) throw new SuperAPIError('A data source id is required.', KINDS.API);
  if (!from || !to) throw new SuperAPIError('A start and end date are required.', KINDS.API);
  const q = {
    ds_id: dsId,
    date_range_type: 'custom',
    start_date: from,
    end_date: to,
    /* Accepts either a bare list of field ids or one of the FIELDS lists (pairs
       of [supermetrics id, our key]) — `ids()` flattens the latter, so a caller
       passes `FIELDS.day` and never has to restate Supermetrics' spelling. */
    fields: fieldIds(fields),
  };
  if (accounts && accounts.length) {
    q.ds_accounts = Array.isArray(accounts) ? accounts.slice() : [accounts];
  }
  /* `filter`, singular — the REST contract's spelling. The MCP tool calls the
     same thing `filters`, so callers may pass either and this normalises it. */
  if (filters) q.filter = filters;
  /* Default well above any single day's row count. Left explicit because the
     silent default is 1,000 and the ad-level pull crosses that — a truncated
     result looks exactly like a quiet fortnight. */
  q.max_rows = maxRows || 100000;
  if (settings) q.settings = settings;
  /* Africa/Cairo, not UTC. A UTC day boundary moves spend and leads between
     days by two or three hours, which is invisible in a monthly total and
     wrong in every daily chart. */
  q.timezone = timezone || 'Africa/Cairo';
  return q;
}

/**
 * Turn Supermetrics' rows into objects keyed by the field ids WE ASKED FOR.
 *
 * Keyed on the requested ids, never on row 0's display names: those are
 * human-facing labels which Supermetrics is free to reword — it returns
 * "Cost" for `cost` and "Clicks (all)" for `Clicks` — and its own tool
 * documentation says to map by `requested_field_ids` for that reason. A report
 * that silently loses a column when a label is reworded is a failure this
 * codebase has already been bitten by.
 *
 * Row 0 IS that label row in every response shape we have seen, so it is
 * dropped — but only after checking it really is labels. Dropping a row of real
 * data would take a day's spend out of the report and leave nothing behind to
 * show it had gone.
 */
function rowsToObjects(requestedFields, rows) {
  const ids_ = Array.isArray(requestedFields)
    ? requestedFields.slice() : String(requestedFields).split(',');
  const body = Array.isArray(rows) ? rows.slice() : [];
  if (body.length && looksLikeLabels(body[0], ids_)) body.shift();
  return body.map((r) => {
    const o = {};
    ids_.forEach((id, i) => { o[id] = r[i]; });
    return o;
  });
}

/* A label row has no number and no date anywhere in it. A data row from these
   queries always has at least one — even a zero-spend day carries `0` and a
   date — so this cannot mistake data for labels. */
function looksLikeLabels(row, ids_) {
  if (!Array.isArray(row) || row.length !== ids_.length) return false;
  return !row.some((c) => typeof c === 'number'
    || (typeof c === 'string' && /^\s*(\d{4}-\d{2}-\d{2}|-?[\d,]+(\.\d+)?)\s*$/.test(c) && c.trim() !== ''));
}

/* --------------------------------------------------------------- transport */

/* ------------------------------------------------------------- metering */

/* The subscription allows 50,000 API rows a month, and ONE full backfill of
   this app's Meta history is 26,712 of them — 53% of the month in a single
   command. Two of those and the month is spent, at which point report 03 stops
   refreshing and nothing on any page says why.

   MEASURED, so the budget is not guesswork:
     full backfill (15 months)      26,712 rows
     one day of activity               ~153 rows
     daily 3-day window                13,800 rows/month
     daily 7-day window                32,200 rows/month
     daily 3-day + weekly 14-day       22,387 rows/month   <- the recommendation

   Queries served through the interactive MCP connector do NOT draw on this
   allowance: 28k rows were pulled through it while the hub still read
   0 / 50,000. Only the server key's traffic is metered here.

   The budget is enforced BEFORE a query runs rather than reported after, because
   the failure it prevents is silent — a quota exhausted mid-month looks exactly
   like a quiet fortnight. */
const MONTHLY_ROW_LIMIT = 50000;
/* Stop short of the ceiling. The last few thousand rows are what lets somebody
   re-pull a day that was wrong, which is precisely when the quota matters. */
const DEFAULT_RESERVE = 5000;

const monthOf = (d) => d.toISOString().slice(0, 7);

/** Rows already drawn this calendar month, and what is left. */
async function usage(prisma, { limit = MONTHLY_ROW_LIMIT, reserve = DEFAULT_RESERVE, now } = {}) {
  const month = monthOf(now || new Date());
  const agg = await prisma.apiQuery.aggregate({
    where: { api: 'supermetrics', month, ok: true },
    _sum: { rows: true }, _count: { _all: true },
  });
  const used = agg._sum.rows || 0;
  return {
    month,
    used,
    queries: agg._count._all,
    limit,
    reserve,
    remaining: Math.max(0, limit - used),
    spendable: Math.max(0, limit - reserve - used),
  };
}

/** Record one query's cost. Failures are recorded too — they cost a call. */
async function record(prisma, { dsId, label, rows, ms, ok = true, error, now }) {
  return prisma.apiQuery.create({
    data: {
      api: 'supermetrics',
      dsId: dsId || null,
      label: label || null,
      rows: rows || 0,
      ms: ms == null ? null : Math.round(ms),
      month: monthOf(now || new Date()),
      ok,
      error: error ? String(error).slice(0, 500) : null,
    },
  });
}

/**
 * The unattended client. Needs a server API key, which the current
 * `CNCT`/`CLAUDE` licence does not issue — so this is the path that goes live
 * with the API-tier subscription, and `verify-supermetrics.js` is what proves
 * it once it does.
 */
function client({
  apiKey, teamId, licenceId, base = DEFAULT_BASE, pollMs = 3000, maxWaitMs = 900000,
  /* Pass a Prisma client to meter and enforce. Without one the client still
     works — the tests and a one-off probe should not need a database — but it
     will not guard the quota, and `sync-meta.js` always passes it. */
  prisma = null, rowLimit = MONTHLY_ROW_LIMIT, reserve = DEFAULT_RESERVE,
}) {
  if (!apiKey) {
    throw new SuperAPIError(
      'SUPERMETRICS_API_KEY is not set.\n'
      + 'The subscription does carry an API row allowance (50,000 a month), so a key can be '
      + 'issued — find it in the Supermetrics hub under Manage > API queries, or on the '
      + 'subscription page, then put it in .env as SUPERMETRICS_API_KEY. It is a credential: '
      + 'it belongs in .env (which is gitignored) and nowhere else.\n'
      + 'Until then, `scripts/sync-meta.js --source bootstrap` fills the cache from a capture '
      + 'and costs nothing against the allowance.', KINDS.AUTH);
  }
  const endpoint = base.replace(/\/+$/, '') + QUERY_PATH;

  /**
   * One POST to the query endpoint.
   *
   * CORRECTED AGAINST THE PUBLISHED CONTRACT on 2026-09-07, having been written
   * from memory before a key existed. Three things were wrong, and each would
   * have failed on the first real call:
   *
   *   the body was wrapped as `{ json: {...} }`. The documented POST puts the
   *   query object at the TOP LEVEL;
   *
   *   the key went in the body as `api_key`. It goes in an `Authorization:
   *   Bearer` header instead — the API accepts either, and a header keeps the
   *   credential out of anything that logs a body;
   *
   *   the filter field was `filters`. The REST contract spells it `filter`
   *   (singular). The MCP tool spells it `filters`, which is where the wrong
   *   name came from.
   *
   * The endpoint itself was right: POST /enterprise/v2/query/data/json.
   */
  async function request(payload) {
    const body = { ...payload };
    if (teamId) body.team_id = teamId;
    let res;
    try {
      res = await fetchRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          /* Never in the URL and never in a logged body. */
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SuperAPIError(e.message, KINDS.TRANSPORT);
    }
    const text = await res.text();
    let payloadOut = null;
    try { payloadOut = JSON.parse(text); } catch {
      throw new SuperAPIError(
        `Supermetrics replied HTTP ${res.status} with a non-JSON body.`, KINDS.TRANSPORT,
        text.slice(0, 400));
    }
    if (res.status === 401 || res.status === 403) {
      throw classify(errorTextOf(payloadOut) || `HTTP ${res.status}`, licenceId);
    }
    const err = errorTextOf(payloadOut);
    if (err) throw classify(err, licenceId);
    return payloadOut;
  }

  /**
   * Run a query to completion.
   *
   * Either rows come back, or a `schedule_id` does and we poll for them. The
   * poll has a deadline: an async query that never finishes must fail loudly,
   * because the alternative is a sync job that hangs forever and a report that
   * silently shows last week.
   */
  async function query(spec) {
    const q = buildQuery(spec);

    /* THE GUARD, before the call rather than after it. `spec.estimatedRows`
       lets a caller that knows the shape of its pull (days x accounts) be
       refused before spending anything; without it the check is still made
       against what is already drawn. */
    if (prisma) {
      const u = await usage(prisma, { limit: rowLimit, reserve, now: new Date() });
      const need = Number(spec.estimatedRows) || 1;
      if (u.spendable < need) {
        throw new SuperAPIError(
          `Supermetrics API budget: ${u.used.toLocaleString('en-US')} of `
          + `${u.limit.toLocaleString('en-US')} rows used this month (${u.month}), `
          + `${u.reserve.toLocaleString('en-US')} held in reserve, so `
          + `${u.spendable.toLocaleString('en-US')} are spendable and this pull needs `
          + `about ${need.toLocaleString('en-US')}. Narrow the window — a full backfill `
          + 'is 26,712 rows and a single day is about 153.',
          KINDS.QUOTA);
      }
    }

    const started = Date.now();
    let out;
    try {
      out = await request(q);
    } catch (e) {
      if (prisma) {
        await record(prisma, {
          dsId: spec.dsId, label: spec.label, rows: 0,
          ms: Date.now() - started, ok: false, error: e.message,
        }).catch(() => {});
      }
      throw e;
    }
    let scheduleId = scheduleIdOf(out);

    while (scheduleId && !rowsOf(out)) {
      if (Date.now() - started > maxWaitMs) {
        throw new SuperAPIError(
          `Supermetrics query ${scheduleId} did not finish within `
          + `${Math.round(maxWaitMs / 1000)}s.`, KINDS.API);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      out = await request({ schedule_id: scheduleId });
      const status = String((out && out.meta && out.meta.status) || '').toLowerCase();
      if (status === 'failed' || status === 'error') {
        throw classify(errorTextOf(out) || `query ${scheduleId} failed`, licenceId);
      }
      scheduleId = scheduleIdOf(out) || scheduleId;
    }

    const rows = rowsOf(out) || [];
    /* Rows as SUPERMETRICS counted them — before our own dedup and drops, since
       that is what the allowance is charged on. */
    if (prisma) {
      await record(prisma, {
        dsId: spec.dsId, label: spec.label, rows: rows.length,
        ms: Date.now() - started, ok: true,
      }).catch(() => {});
    }
    return {
      rows: isPairs(spec.fields)
        ? normalise(spec.fields, rowsToObjects(q.fields, rows))
        : rowsToObjects(q.fields, rows),
      raw: rows,
      fields: q.fields,
      /* How long it took and how many rows arrived, so a sync log can show a
         truncation for what it is. */
      meta: { ms: Date.now() - started, rowCount: rows.length, scheduleId: scheduleId || null },
    };
  }

  return { query, buildQuery, endpoint, usage: () => usage(prisma, { limit: rowLimit, reserve }) };
}

/* Supermetrics has moved these around between versions; read every shape we
   have seen rather than pinning one and breaking on the next. */
const rowsOf = (o) => (o && (o.data || (o.response && o.response.data))) || null;
const scheduleIdOf = (o) => (o && (o.schedule_id
  || (o.meta && o.meta.schedule_id)
  || (o.response && o.response.schedule_id))) || null;

/**
 * The human-readable half of a Supermetrics error.
 *
 * `description` FIRST, and that ordering is the whole point. The API answers a
 * prioritised-account refusal like this:
 *
 *   { code: "QUERY_ERROR", message: "QUERY_ERROR",
 *     description: "This query is trying to pull data from 4 views that are not
 *                   listed as a prioritised accounts..." }
 *
 * `message` is a duplicate of the code. Reading it first threw away the only
 * sentence that says what went wrong, so `classify()` saw "QUERY_ERROR",
 * could not recognise a refusal it handles routinely, and killed a sync that
 * had already pulled the ads and the leads successfully. Ten minutes of
 * "QUERY_ERROR" for a condition the code has a named branch for.
 */
function errorTextOf(o) {
  if (!o) return null;
  const e = o.error || (o.meta && o.meta.error) || (o.response && o.response.error);
  if (!e) return null;
  if (typeof e === 'string') return e;
  /* The code is kept alongside the description: it is useless on its own and
     useful in a log line beside the text. */
  const text = e.description || e.message || JSON.stringify(e);
  const code = e.code && e.code !== e.message ? ` [${e.code}]` : '';
  return e.description && e.code ? `${text}${code}` : text;
}

module.exports = {
  client, buildQuery, rowsToObjects, normalise, ids, fieldIds, classify,
  usage, record, MONTHLY_ROW_LIMIT, DEFAULT_RESERVE,
  SuperAPIError, KINDS, DS, FIELDS, IG_SETTINGS, AD_ACCOUNTS, IG_PROFILES,
  DEFAULT_BASE, QUERY_PATH,
};
