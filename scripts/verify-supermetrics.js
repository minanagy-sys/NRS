#!/usr/bin/env node
/* Prove the Meta feed still means what it meant.
 *
 *   node scripts/verify-supermetrics.js                    # against the cache
 *   node scripts/verify-supermetrics.js --source api       # against a live pull
 *   node scripts/verify-supermetrics.js --source capture --file data/meta-bootstrap.json
 *
 * WHAT THIS CATCHES THAT NOTHING ELSE DOES.
 *
 * `npm test` proves the code is right about the data it has. This proves the
 * DATA is still the data — that Supermetrics has not renamed a field, changed a
 * currency, dropped an account or redefined a metric underneath us. Every one of
 * those failures publishes a plausible number rather than an error, which is
 * the only kind worth building a separate check for:
 *
 *   a RENAMED FIELD comes back as nulls, so a metric silently becomes zero and
 *   the report shows a quiet fortnight;
 *   a CURRENCY SWITCH multiplies or divides spend by ~50 with no other symptom,
 *   and Supermetrics offers cost in EGP, USD, EUR, GBP and SEK under names that
 *   differ by three characters;
 *   a DROPPED ACCOUNT removes a third of the spend and looks like a slow month;
 *   a REDEFINED METRIC is the worst — `new_messaging_conversations` and
 *   `new_messaging_conversations_7d` are different questions with almost the
 *   same name, and picking the wrong one changes "results" by hundreds.
 *
 * So it compares against the frozen report pack, which is an artefact nobody
 * can edit: 1–19 August 2026, spend 466,114.05 to the piastre, split across
 * three named accounts, with 2,239 messaging contacts and 2,326 on-Facebook
 * leads. If a pull reproduces those, the field ids, the currency, the account
 * list and the metric definitions are all still what they were.
 *
 * It exits non-zero on a mismatch, so it belongs in front of anything that
 * publishes.
 */

const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* ok */ }

const { prisma } = require('../src/lib/db.js');
const S = require('../src/lib/supermetrics.js');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const f = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const i = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

/* The reference window and its figures, from the frozen pack. Not configurable:
   the whole point is that they cannot drift. */
const REF = {
  from: '2026-08-01',
  to: '2026-08-19',
  spend: 466114.05,
  msgConversations: 2239,
  onFbLeads: 2326,
  results: 4565,
  accounts: {
    '822787769703389': { name: 'Nouvel Age Clinics l Doctors', spend: 167590.69 },
    '420792247234306': { name: 'Nouvel Age l Backup', spend: 250615.53 },
    '1423050112053946': { name: 'Zat l EGP 2025 !', spend: 47907.83 },
  },
  campaigns: 39,
};

let fails = 0, checks = 0;
const ok = (label, cond, detail, why) => {
  checks++;
  if (cond) { console.log(`  ✓ ${label}`); return; }
  fails++;
  console.log(`  \x1b[31m✗ ${label}\x1b[0m`);
  if (detail) console.log(`      ${detail}`);
  if (why) console.log(`      \x1b[33mlikely cause:\x1b[0m ${why}`);
};

/* ------------------------------------------------------------- the sources */

/** Day rows for the reference window, out of Postgres. */
async function fromCache() {
  const rows = await prisma.metaDay.findMany({
    where: {
      source: 'live',
      date: { gte: new Date(`${REF.from}T00:00:00Z`), lte: new Date(`${REF.to}T00:00:00Z`) },
    },
    select: {
      accountId: true, accountName: true, cost: true, impressions: true,
      reach: true, clicks: true, msgConversations: true, onFbLeads: true,
    },
  });
  const campaigns = await prisma.metaCampaign.groupBy({
    by: ['name'],
    where: {
      source: 'live',
      date: { gte: new Date(`${REF.from}T00:00:00Z`), lte: new Date(`${REF.to}T00:00:00Z`) },
    },
  });
  return {
    where: 'the Postgres cache',
    rows: rows.map((r) => ({
      account_id: r.accountId, account_name: r.accountName,
      cost: Number(r.cost), impressions: r.impressions, reach: r.reach,
      clicks: r.clicks, conversations: r.msgConversations, on_fb_leads: r.onFbLeads,
    })),
    campaigns: campaigns.length,
  };
}

/** Day rows straight from Supermetrics. The path that goes live with the key. */
async function fromApi() {
  const api = S.client({
    apiKey: process.env.SUPERMETRICS_API_KEY,
    teamId: process.env.SUPERMETRICS_TEAM_ID,
    licenceId: process.env.SUPERMETRICS_LICENCE_ID,
    /* METERED, like every other real call.
       This was missed when the meter was added, and the omission is the kind
       that matters: the first live run of this script pulled two windows and
       recorded 0 rows, so the local budget said 0 used while Supermetrics had
       already charged for them. A meter that some callers bypass is worse than
       no meter, because it is trusted. */
    prisma,
  });
  const accounts = S.AD_ACCOUNTS.filter((a) => a.state === 'active').map((a) => a.id);
  const day = await api.query({
    dsId: S.DS.META_ADS, accounts, fields: S.FIELDS.day, from: REF.from, to: REF.to,
  });
  const camp = await api.query({
    dsId: S.DS.META_ADS, accounts, fields: S.FIELDS.campaign, from: REF.from, to: REF.to,
  });
  return {
    where: 'a live Supermetrics pull',
    rows: day.rows,
    campaigns: new Set(camp.rows.map((r) => r.campaign_name)).size,
  };
}

/** A bootstrap capture on disk — the same rows the MCP session produced. */
function fromCapture(file) {
  const p = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
  const inWindow = (r) => r.date && r.date >= REF.from && r.date <= REF.to;
  return {
    where: `the capture ${path.basename(p)}`,
    rows: (cap.days || []).filter(inWindow),
    campaigns: new Set((cap.campaigns || []).filter(inWindow).map((r) => r.campaign_name)).size,
  };
}

/* ------------------------------------------------------------------- main */

(async () => {
  const mode = String(arg('source', 'db'));
  const src = mode === 'api' ? await fromApi()
    : mode === 'capture' ? fromCapture(String(arg('file') || 'data/meta-bootstrap.json'))
      : await fromCache();

  console.log(`\nverifying ${src.where} against the frozen pack · ${REF.from} → ${REF.to}\n`);

  const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
  const sum = (key) => src.rows.reduce((t, r) => t + n(r[key]), 0);

  ok(`${src.rows.length} day rows arrived`, src.rows.length > 0,
    'nothing came back at all',
    'the window, the account list or the credential — not a field name');
  if (!src.rows.length) {
    console.log(`\n\x1b[31m  ${fails} of ${checks} checks failed\x1b[0m\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  /* Spend, to the piastre. This one check covers the currency, the field id and
     the account list at once — any of the three going wrong moves it. */
  const spend = sum('cost');
  ok(`spend is ${f(REF.spend)}`, Math.abs(spend - REF.spend) < 0.02,
    `got ${f(spend)}, expected ${f(REF.spend)} — a difference of ${f(spend - REF.spend)}`,
    Math.abs(spend / REF.spend - 1) > 0.5
      ? 'a CURRENCY SWITCH. `cost` is account currency; `cost_usd`, `cost_eur`, `cost_gbp` and '
        + '`cost_sek` differ from it by three characters and by a factor of ~50.'
      : 'an account added or dropped, or a restatement inside Meta\'s attribution window');

  /* The two lead shapes separately, because their names are nearly identical
     and mean different things. */
  ok(`messaging contacts are ${i(REF.msgConversations)}`,
    sum('conversations') === REF.msgConversations,
    `got ${i(sum('conversations'))}, expected ${i(REF.msgConversations)}`,
    '`new_messaging_conversations` ("New messaging contacts") may have been swapped for '
    + '`new_messaging_conversations_7d` ("Messaging conversations started") — a different '
    + 'question with almost the same name');
  ok(`on-Facebook leads are ${i(REF.onFbLeads)}`,
    sum('on_fb_leads') === REF.onFbLeads,
    `got ${i(sum('on_fb_leads'))}, expected ${i(REF.onFbLeads)}`,
    '`onsite_conversion.lead_grouped` renamed, or lead attribution redefined');
  ok(`results are ${i(REF.results)}`,
    sum('conversations') + sum('on_fb_leads') === REF.results,
    `got ${i(sum('conversations') + sum('on_fb_leads'))}`,
    'one of the two halves above');

  /* Per account, which is what catches a dropped or renamed account while the
     total happens to land close enough. */
  const byAcct = new Map();
  for (const r of src.rows) {
    const id = String(r.account_id || '').replace(/^act_/, '');
    if (!byAcct.has(id)) byAcct.set(id, { name: r.account_name, spend: 0 });
    byAcct.get(id).spend += n(r.cost);
  }
  for (const [id, want] of Object.entries(REF.accounts)) {
    const got = byAcct.get(id);
    ok(`${want.name} spent ${f(want.spend)}`,
      !!got && Math.abs(got.spend - want.spend) < 0.02,
      got ? `got ${f(got.spend)} as "${got.name}"` : `account ${id} did not answer`,
      got ? 'a restatement, or this account\'s currency' : 'the account was removed from the '
        + 'connection, or lost its prioritised slot on the licence');
  }
  const extra = [...byAcct.keys()].filter((id) => !REF.accounts[id]);
  ok('no unexpected account appeared', extra.length === 0,
    `also answered: ${extra.map((id) => `${id} (${byAcct.get(id).name})`).join(', ')}`,
    'an account was added to the connection. That is not necessarily wrong — but its spend is '
    + 'now inside every total on report 03, and somebody should have decided that.');

  /* A field that still exists but returns nothing looks exactly like a quiet
     fortnight, so every metric is checked for being present at all. */
  for (const key of ['impressions', 'reach', 'clicks']) {
    ok(`${key} is populated`, src.rows.some((r) => n(r[key]) > 0),
      `every row has ${key} = 0 or null`,
      `the \`${key}\` field id was renamed — a renamed field returns nulls rather than an error`);
  }

  ok(`${REF.campaigns} campaigns spent in the window`, src.campaigns === REF.campaigns,
    `got ${src.campaigns}, expected ${REF.campaigns}`,
    'campaigns renamed (they are matched by name), or the campaign grain changed');

  /* Reach must not be summable to a range total. Asserted here because the
     temptation to add it up outlives any one person's memory of why not. */
  const reachSum = sum('reach');
  ok('daily reach sums to more than the biggest day, i.e. it is per-day and non-additive',
    reachSum > Math.max(...src.rows.map((r) => n(r.reach))),
    'reach looks pre-aggregated',
    'if reach became a window figure, report 03\'s per-day reach and its "best day" card are '
    + 'both wrong');

  console.log(fails
    ? `\n\x1b[31m  ${fails} of ${checks} checks failed — do not publish from this feed until they are explained\x1b[0m\n`
    : `\n\x1b[32m  all ${checks} checks passed — field ids, currency, account list and metric definitions are unchanged\x1b[0m\n`);
  await prisma.$disconnect();
  process.exit(fails ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n✗ ${e.kind ? `[${e.kind}] ` : ''}${e.message}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
