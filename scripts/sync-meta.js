#!/usr/bin/env node
/* Fill the Meta and Instagram cache.

     node scripts/sync-meta.js --from 2026-08-01 --to 2026-08-19 --source bootstrap \
       --file data/meta-bootstrap-2026-08.json
     node scripts/sync-meta.js --mtd --source api

   TWO SOURCES, ONE WRITER.

     --source api        the unattended path: a server Supermetrics API key.
                         Needs SUPERMETRICS_API_KEY, which the current
                         CNCT/CLAUDE connector licence does NOT issue — an
                         API-tier subscription does. Until then it fails
                         immediately and says so rather than half-filling the
                         cache.

     --source bootstrap  rows captured through an interactive Supermetrics MCP
                         session and written to a JSON file. This is how report
                         03 has data today. It is deliberately a FILE and not a
                         live call: the MCP is a per-session transport between
                         Claude and Supermetrics, so a cron job cannot speak it,
                         and pretending otherwise would leave the report
                         depending on somebody running a chat.

   Both normalise to the same rows and call src/lib/meta-sync.js, so switching
   from one to the other changes nothing a page can see. `source` is stamped on
   every row either way, and every panel prints which it is reading. */

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* ok */ }

const fs = require('fs');
const path = require('path');
const { prisma } = require('../src/lib/db.js');
const { iso } = require('../src/lib/rules.js');
const S = require('../src/lib/supermetrics.js');
const W = require('../src/lib/meta-sync.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
}

const fmt = (x) => Number(x || 0).toLocaleString('en-US');

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const maxDate = (a, b) => (a > b ? a : b);

/** Split a range into calendar months, clipped to the range's own ends. */
function months(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    out.push([first < from ? from : first, last > to ? to : last]);
    if (last >= to) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 240) break;   // 20 years; a runaway guard, never reached
  }
  return out;
}

/* --------------------------------------------------------- the two sources */

/**
 * Read a capture file.
 *
 * Validated rather than trusted: a capture is a hand-made artefact, and one
 * with a silently empty `days` array would load, report success, and leave the
 * report showing zero spend on a month that cost 466,114.
 */
function fromBootstrap(file) {
  const p = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(p)) throw new Error(`No capture file at ${p}`);
  const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
  const need = ['days', 'campaigns', 'ads'];
  const missing = need.filter((k) => !Array.isArray(cap[k]) || cap[k].length === 0);
  if (missing.length) {
    throw new Error(`Capture ${path.basename(p)} has no ${missing.join(', ')} — `
      + 'refusing to load a partial pull over a working cache.');
  }
  return cap;
}

/** Pull everything for the window through the API. */
async function fromApi({ from, to }) {
  const api = S.client({
    apiKey: process.env.SUPERMETRICS_API_KEY,
    teamId: process.env.SUPERMETRICS_TEAM_ID,
    licenceId: process.env.SUPERMETRICS_LICENCE_ID,
    /* Metered and enforced — the allowance is 50,000 rows a month and one full
       backfill is 26,712 of them. See the metering block in lib/supermetrics.js. */
    prisma,
  });

  /* What this window will cost, before spending it. ~153 rows a day measured
     over the last 30 days of real activity; the day/campaign/ad/lead grains all
     scale with the window, so one number per day is close enough to refuse an
     obviously ruinous pull. */
  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const estimate = spanDays * 153;
  const before = await S.usage(prisma);
  console.log(`  budget: ${fmt(before.used)} of ${fmt(before.limit)} rows used this month`
    + ` · ${fmt(before.spendable)} spendable · this window is about ${fmt(estimate)}`);
  if (estimate > before.spendable) {
    throw new Error(`This window needs about ${fmt(estimate)} rows and only ${fmt(before.spendable)} `
      + `are spendable this month (${fmt(before.used)} already used of ${fmt(before.limit)}, `
      + `${fmt(before.reserve)} held back for corrections). Narrow it with --days.`);
  }
  const accounts = S.AD_ACCOUNTS.filter((a) => a.state === 'active').map((a) => a.id);
  /* The Supermetrics connection carries sixteen Instagram profiles and most
     belong to OTHER CLIENTS — AMS, Mega Masr, MWG, Q Store, You Real Estate.
     Pulling "all accounts" would put another agency's reach on a Nouvelage
     report, so the profiles are named explicitly.

     CLINICS AND DOCTORS ARE PULLED SEPARATELY, for the same reason the leads
     are chunked: the four doctor profiles are refused for a prioritised-account
     slot, and one query covering all six returns NOTHING rather than the two
     that are allowed. Asking twice gets the clinics' data and records the
     refusal. */
  const igClinics = S.IG_PROFILES.filter((p) => p.state === 'active' && p.kind === 'clinic').map((p) => p.id);
  const igDoctors = S.IG_PROFILES.filter((p) => p.state === 'active' && p.kind === 'doctor').map((p) => p.id);
  const refused = [];

  /* The ONLY window Instagram serves new-follower counts for: the last 30 days,
     EXCLUDING the current day. Both halves are enforced here, because getting
     either wrong fails the query outright — the first live sync asked through
     today and was told so in as many words. */
  const gainTo = addDays(to, -1);
  const gainFloor = addDays(to, -30);

  /* Each pull is attempted separately and a prioritised-account refusal is
     reported, not fatal. Three of five accounts and none of the doctor profiles
     are readable on the current licence, and a run that aborted on the first
     refusal would load nothing at all. */
  const pull = async (label, spec) => {
    try {
      const out = await api.query(spec);
      console.log(`  ${label}: ${fmt(out.meta.rowCount)} rows (${(out.meta.ms / 1000).toFixed(1)}s)`);
      return out.rows;
    } catch (e) {
      /* Two refusals are expected and neither is a bug in this code: a
         prioritised-account quota on our subscription, and Facebook withholding
         lead rows from an account whose connection lacks the scopes. Both are
         recorded and skipped so the rest of the sync completes; anything else
         is a real failure and stops the run. */
      if (e.kind === S.KINDS.NOT_PRIORITISED || e.kind === S.KINDS.PERMISSIONS) {
        refused.push(`${label}: ${e.message}`);
        console.error(`  ! ${label} refused — ${e.message}`);
        return [];
      }
      throw e;
    }
  };

  const days = await pull('days', { dsId: S.DS.META_ADS, accounts, fields: S.FIELDS.day, from, to, estimatedRows: spanDays * 3 });
  const campaigns = await pull('campaigns', { dsId: S.DS.META_ADS, accounts, fields: S.FIELDS.campaign, from, to });
  const ads = await pull('ads', { dsId: S.DS.META_ADS, accounts, fields: S.FIELDS.ad, from, to });

  /* LEADS ARE PULLED ONE ACCOUNT AND ONE MONTH AT A TIME, and that is not
     over-engineering — it is what the refusals actually look like.

     MEASURED on 2026-09-04, all with the identical query:
       act_822787769703389   Aug 1-19  ✓ 1,138 rows
       act_420792247234306   Aug 1-19  ✓
       act_1423050112053946  Aug 1-19  ✗ "grant extended permissions"
       both working accounts, 15 months ✗ same message
       act_822787769703389   June only ✓

     So a refusal is a property of the (account, window) pair, not of the
     request. Asking for everything at once therefore returns NOTHING when any
     part of it is refused — which is how a report ends up showing zero leads on
     a month that had thousands. Asking in small pieces gets every piece that
     is allowed and names the ones that are not. */
  const leads = [];
  for (const acct of accounts) {
    for (const [mFrom, mTo] of months(from, to)) {
      const rows = await pull(`leads ${acct.replace(/^act_/, '')} ${mFrom.slice(0, 7)}`,
        { dsId: S.DS.META_ADS, accounts: [acct], fields: S.FIELDS.lead, from: mFrom, to: mTo });
      leads.push(...rows);
    }
  }

  const igProfileDays = await pull('ig profiles · clinics', {
    dsId: S.DS.INSTAGRAM, accounts: igClinics, fields: S.FIELDS.igProfile, from, to,
    settings: S.IG_SETTINGS,
  });
  /* Expected to be refused until somebody adds them to the prioritised list.
     Attempted anyway, every run, so the refusal is recorded with today's date
     rather than remembered from a note — and so it starts working by itself the
     day the slot is granted. */
  const igDoctorDays = igDoctors.length ? await pull('ig profiles · doctors', {
    dsId: S.DS.INSTAGRAM, accounts: igDoctors, fields: S.FIELDS.igProfile, from, to,
    settings: S.IG_SETTINGS,
  }) : [];
  /* New followers, only where Instagram will serve it: the last thirty days,
     excluding today. Asked for over a wider window it refuses and takes the
     history query down with it, so the window is clamped here rather than
     hoped for. */
  const gainFrom = maxDate(from, gainFloor);
  /* Non-fatal on purpose. It is an enrichment on top of a follower total that
     already arrived, and by this point the spend, the ads and the leads are all
     in hand — losing them to a metric-window quibble would be the wrong trade.
     The clamp above should prevent it either way. */
  let igNewFollowers = [];
  if (gainFrom <= gainTo) {
    try {
      igNewFollowers = await pull('ig new followers', {
        dsId: S.DS.INSTAGRAM, accounts: igClinics, fields: S.FIELDS.igNewFollowers,
        from: gainFrom, to: gainTo, settings: S.IG_SETTINGS,
      });
    } catch (e) {
      refused.push(`ig new followers: ${e.message}`);
      console.error(`  ! ig new followers skipped — ${e.message}`);
    }
  } else {
    console.log(`  · ig new followers: this range is outside Instagram's 30-day window`);
  }
  const igPosts = await pull('ig posts', {
    dsId: S.DS.INSTAGRAM, accounts: igClinics, fields: S.FIELDS.igPost, from, to,
    settings: S.IG_SETTINGS,
  });

  const after = await S.usage(prisma);
  console.log(`  budget after: ${fmt(after.used)} of ${fmt(after.limit)} rows used`
    + ` (${fmt(after.used - before.used)} this run) · ${fmt(after.spendable)} spendable`);

  return {
    days, campaigns, ads, leads,
    igProfileDays: igProfileDays.concat(igDoctorDays),
    igNewFollowers, igPosts, refused,
  };
}

/* -------------------------------------------------------------------- main */

(async () => {
  const today = iso(new Date());
  let from = arg('from'), to = arg('to') || today;
  if (arg('mtd')) { from = `${today.slice(0, 7)}-01`; to = today; }
  /* `--days N` is the shape the scheduled run should use: a trailing window,
     because Meta restates the last few days and a one-day pull would keep the
     first, wrong version. Three days costs ~13,800 rows a month; seven costs
     32,200 of a 50,000 allowance, which leaves no room to re-pull anything. */
  if (arg('days')) {
    const n = Math.max(1, Number(arg('days')) || 3);
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (n - 1));
    from = iso(d);
    to = today;
  }
  if (!from) {
    throw new Error('Give a window: --days 3 for the scheduled run, --from/--to for a '
      + 'specific range, or --mtd. There is deliberately no default: an accidental full '
      + 'backfill costs 26,712 of the 50,000 rows this subscription allows each month.');
  }

  const mode = String(arg('source', 'bootstrap'));
  /* The row's provenance, not the transport's name: an API pull and an MCP
     bootstrap are both live Meta data, and a page that said "bootstrap" would be
     telling the reader about our plumbing instead of about the number. */
  const source = mode === 'seed' ? 'seed' : 'live';

  console.log(`meta sync ${from} → ${to}  ·  ${mode} → source="${source}"`);

  const cap = mode === 'api'
    ? await fromApi({ from, to })
    : fromBootstrap(String(arg('file') || 'data/meta-bootstrap.json'));

  const d = await W.writeMetaDays({ rows: cap.days, from, to, source });
  console.log(`✓ days: ${fmt(d.written)} rows`);

  const c = await W.writeCampaigns({ rows: cap.campaigns, from, to, source });
  console.log(`✓ campaigns: ${fmt(c.written)} across ${c.accounts} account(s)`);

  const a = await W.writeAds({ rows: cap.ads, campaignRows: cap.campaigns, from, to, source });
  console.log(`✓ ads: ${fmt(a.written)} across ${a.accounts} account(s)`);

  let l = { written: 0, dropped: 0, withKey: 0 };
  if (cap.leads && cap.leads.length) {
    l = await W.writeLeads({ rows: cap.leads, from, to, source });
    /* `withKey` is the ceiling on how many leads can EVER be matched to a
       patient. Quoting a conversion rate without it quotes a denominator that
       has quietly shrunk. */
    console.log(`✓ leads: ${fmt(l.written)} rows · ${fmt(l.withKey)} with a usable mobile`
      + ` · ${fmt(l.dropped)} unmatchable`
      /* Meta keeps lead-level rows for 90 days only, so the window it answers
         with is routinely narrower than the one asked for. Printing both is how
         somebody notices that 2025 leads are simply not obtainable. */
      + (l.covered ? ` · Meta returned ${l.covered.from} → ${l.covered.to}` : ''));
  } else {
    console.log('· leads: none in this capture');
  }

  let ig = { written: 0 }, igp = { written: 0 };
  if (cap.igProfileDays && cap.igProfileDays.length) {
    ig = await W.writeIgProfileDays({
      rows: cap.igProfileDays, gains: cap.igNewFollowers || [], from, to, source,
    });
    console.log(`✓ instagram profile-days: ${fmt(ig.written)} rows`
      + ` · ${fmt((cap.igNewFollowers || []).length)} carrying a daily follower gain`);
  }
  if (cap.igPosts && cap.igPosts.length) {
    igp = await W.writeIgPosts({ rows: cap.igPosts, from, to, source });
    console.log(`✓ instagram posts: ${fmt(igp.written)} rows`);
  }

  /* What is missing, named. The spare Zat ad account and the four doctor
     Instagram profiles are refused for a prioritised-account slot, and that is a
     click on the subscription page rather than a bug here — so the run says so
     every time instead of leaving a quiet hole in the report. */
  const refused = (cap.refused || []).slice();
  if (refused.length) {
    console.log('\nrefused by the licence, and therefore absent from the report:');
    for (const r of refused) console.log(`  · ${r}`);
  }

  const total = d.written + c.written + a.written + l.written + ig.written + igp.written;
  await W.recordLoad({
    kind: `meta:${mode}`,
    from,
    to,
    rowsWritten: total,
    notes: [
      `days=${d.written} campaigns=${c.written} ads=${a.written}`,
      `leads=${l.written} (withKey=${l.withKey}, dropped=${l.dropped})`,
      `ig=${ig.written}/${igp.written}`,
      refused.length ? `refused: ${refused.join(' | ')}` : null,
    ].filter(Boolean).join(' · '),
    actor: process.env.MCP_USER || 'script',
  });

  console.log(`\n${fmt(total)} rows written`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`✗ ${e.kind ? `[${e.kind}] ` : ''}${e.message}`);
  await prisma.$disconnect();
  process.exit(1);
});
