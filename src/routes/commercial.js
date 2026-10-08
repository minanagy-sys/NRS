/* The commercial reports: Targets, Commercial view, Patients.
 *
 * Ported from the standalone HTML packs in ~/Downloads (01, 04, 05). Those files
 * carry their data frozen in a <script> block and say so themselves; these
 * routes read Odoo through the same cache the Sales report uses, so a range
 * change is a real query rather than a clamped label.
 *
 * Same shape as routes/finance.js: one HTML GET per page with the signed-out
 * fallback baked in, and one /api per page behind requireUser. */

const fs = require('fs');
const path = require('path');
const Tracker = require('../lib/target-tracker.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Serve a page, or the sign-in screen — never a redirect to the MCP, which
 *  report.js notes is disorienting as a first impression. */
const page = (app, url, name) => app.get(url, async (req, reply) =>
  reply.type('text/html').send(fs.readFileSync(req.user ? view(name) : SIGNIN, 'utf8')));

module.exports = async function (app) {
  page(app, '/targets', 'targets');
  /* MERGED 2026-10-06. Targets and Commission were two reports; they are now
     two halves of one, switched by the control above the tabs. They always
     measured different things on different bases — doctors against the approved
     sheet in INVOICED revenue, branches against the policy in CASH COLLECTED,
     and they are not expected to agree — which was the argument for keeping
     them apart. Putting them under one switch with the basis on every column
     makes that difference visible instead of merely separate.

     The old URL is kept and redirected rather than dropped: it is in people's
     bookmarks, and the page it pointed at is still here, one click away. */
  app.get('/commission', async (req, reply) => reply.redirect('/targets#commission', 301));
  page(app, '/commercial', 'commercial');
  page(app, '/patients', 'patients');
  page(app, '/commercial-sales', 'commercial-sales');

  /* --------------------------------------------- targets & commission --- */

  /**
   * `const D` and `const TGT`, rebuilt from Postgres.
   *
   * The merged report runs the standalone dashboard's own script rather than a
   * re-implementation of it, and that script opens with two constants holding
   * 584 KB of plan, history and roster. This is the same two objects, built
   * from the tables the import filled, so nothing above line 454 of that script
   * has to change.
   */
  app.get('/api/tgc/bootstrap', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-cache');

    /* TODAY IS REFRESHED BEFORE THE PAGE IS BUILT, and only today.
       The page reads `Collection` out of Postgres rather than asking Odoo, so
       a day still in progress is stale the moment a payment lands — which is
       exactly how Loran came to show nothing here while the Odoo-connected
       copy showed 41,587. Closed days cannot change, so re-pulling them would
       be waste; the open day is the only volatile one.

       Failure is deliberately swallowed. A page that still renders yesterday's
       closed figures is far better than one that 500s because Odoo blinked,
       and the header already tells the reader when it last synced. */
    const today = iso(new Date());
    if (req.user && req.user.token) {
      const { syncCollections, syncPackages } = require('../lib/finance-sync.js');
      /* BOTH, or the figure is wrong. "Collected" is
         (cash in − refunds − package sales + package used) ÷ 1.14, so pulling
         the payments without the packages produces a number that looks fine
         and is not. They run together and fail independently. */
      await Promise.all([
        syncCollections({ token: req.user.token, from: today, to: today })
          .catch((e) => req.log.warn({ err: e }, 'bootstrap: today\'s collections did not refresh')),
        syncPackages({ token: req.user.token, from: today, to: today })
          .catch((e) => req.log.warn({ err: e }, 'bootstrap: today\'s packages did not refresh')),
      ]);
    }

    return require('../lib/tgc-bootstrap.js').build();
  });

  /**
   * Pull customer receipts into `Collection`.
   *
   * WITHOUT THIS THE WHOLE COMMISSION HALF IS ZERO. Branch pools are paid on
   * cash collected ex-VAT, and the page reads that from `Collection`; an empty
   * table is not "nobody earned anything", it is "nobody has loaded the cash
   * yet", and the two look identical on screen.
   *
   * It runs on the signed-in user's own token, exactly as `/api/refresh` does —
   * the unattended path needs MCP_USER/MCP_PASSWORD in the environment, which a
   * person clicking Sync does not have and should not need.
   */
  app.post('/api/tgc/sync-collections', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'fetch') {
      return reply.code(403).send({ error: 'Missing X-Requested-With.' });
    }
    const today = iso(new Date());
    const to = isDate(req.body && req.body.to) ? req.body.to : today;
    const from = isDate(req.body && req.body.from) ? req.body.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: 'The range starts after it ends.' });

    try {
      const { syncCollections, syncPackages } = require('../lib/finance-sync.js');
      const { prisma } = require('../lib/db.js');
      /* Packages alongside the payments — see the note in /api/tgc/bootstrap.
         Pressing Sync and getting only half the formula refreshed would be
         worse than not pressing it, because the page would then claim to be
         up to date. */
      const [out, pkg] = await Promise.all([
        syncCollections({ token: req.user.token, from, to }),
        syncPackages({ token: req.user.token, from, to })
          .catch((e) => ({ error: e.message })),
      ]);
      out.packages = pkg;

      /* POINT THE SECTION AT WHAT WAS JUST SYNCED.
         `collectionByBranch` filters on the configured source, and the section
         ships reading `snapshot`. Writing `odoo` rows without flipping it left
         168 real collection rows in the table that every query excluded — the
         cash was there, the commission read zero, and nothing said why.
         `scripts/sync-collections.js` has always done this; the endpoint called
         the library directly and skipped it. The snapshot rows are untouched,
         so `snapshot` remains a one-field revert. */
      const before = await prisma.financeSource.findUnique({ where: { section: 'collections' } });
      await prisma.financeSource.upsert({
        where: { section: 'collections' },
        update: { mode: 'odoo', cutover: null },
        create: { section: 'collections', mode: 'odoo' },
      });

      await app.audit(req, 'sync-collections', `${from}..${to} — source ${before ? before.mode : 'unset'} → odoo`);
      return { ...out, source: 'odoo', wasSource: before ? before.mode : null };
    } catch (e) {
      req.log.error(e);
      /* Which layer failed changes what the reader should do, so the kind is
         stated and the detail stays in the log. */
      const said = {
        token: [401, 'Your sign-in has expired. Sign out, sign in again, then Sync.'],
        odoo: [503, 'The MCP is up but Odoo is not answering it. The figures already shown are the last good pull.'],
      }[e.kind] || [502, 'Could not reach the MCP for collections. The server log has the detail.'];
      return reply.code(said[0]).send({ error: said[1] });
    }
  });

  /**
   * Odoo's `read_group` and `search_read`, answered from the invoice cache.
   *
   * THE PAGE STILL NEVER REACHES THE MCP. This is SQL; only the shape of the
   * answer is Odoo's, because the script that asks destructures `branch_id` as
   * a `[id, name]` pair and reads sums under their field names. Keeping the
   * call sites intact is what lets every panel stay byte-identical to the
   * dashboard it came from.
   *
   * A read, but POST: the query is a domain, and a domain does not belong in a
   * URL — it is long, it is nested, and it would end up in access logs. The
   * `X-Requested-With` header is required for the same reason the other writes
   * require it.
   */
  app.post('/api/tgc/odoo', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'fetch') {
      return reply.code(403).send({ error: 'Missing X-Requested-With.' });
    }
    const b = req.body || {};
    if (!b.model || !b.method) return reply.code(400).send({ error: 'Which model and method?' });
    try {
      const rows = await require('../lib/tgc-odoo.js').call(b);
      return { payload: rows };
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'Could not read the cache for that query.' });
    }
  });

  /**
   * Everything the merged report needs that a date change does not move: the
   * plan, the policy, the roster, the seasonal shape, the frozen history.
   *
   * ETagged for the same reason `/api/targets-plan` is — every figure in it is
   * a decision somebody made, so it changes when somebody saves and at no other
   * time. Unlike that one the tag is cheap to compute here, because the answer
   * is assembled from tables whose row counts and timestamps are the tag.
   */
  app.get('/api/tgc/reference', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const Tgc = require('../lib/tgc.js');
    reply.header('Cache-Control', 'private, no-cache');
    return Tgc.reference();
  });

  /**
   * What actually happened in a window — billed by branch, doctor, product and
   * service group, and cash collected by branch.
   *
   * Served from the live cache where the sync has reached and from the imported
   * history where it has not, with `sources` saying which. A reader asking for
   * March 2026 gets March 2026, not the silence of an empty cache.
   */
  app.get('/api/tgc/period', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const Tgc = require('../lib/tgc.js');
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: 'The range starts after it ends.' });
    return Tgc.period(from, to);
  });

  /* ------------------------------------------------------------- plan --- */

  /**
   * The 2027 plan, the v3.2 policy and the frozen history.
   *
   * ETAGGED, which none of the other endpoints are, and for a reason that only
   * applies here: everything in this answer is a decision somebody made in
   * Admin, so it changes when somebody saves and at no other time. A sync does
   * not move it, and neither does changing the date range. A reader who opens
   * the report five times a day should pay for it once.
   *
   * The tag is built from row counts and the newest `updatedAt` across every
   * table behind it — a count alone would miss an edited cell, a timestamp
   * alone would miss a deletion.
   */
  app.get('/api/targets-plan', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const Plan = require('../lib/targets-plan.js');
    const tag = await Plan.etag();
    reply.header('ETag', tag);
    /* `no-cache` rather than `no-store`: the browser MAY keep it, but has to
       ask before reusing it. That is what makes the 304 below possible. */
    reply.header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    return Plan.build();
  });

  /* ------------------------------------------------------- commission --- */

  /**
   * What everyone earns, on the v3.2 policy.
   *
   * Named hyphenated rather than `/api/commission/...`, which belongs to the
   * Admin editor: a reader should not have to work out whether an endpoint
   * reports or edits.
   */
  app.get('/api/commission-month', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });
    const V = require('../lib/commission-v32.js');
    const Commission = require('../lib/commission.js');
    const [built, rates, members] = await Promise.all([
      V.build({ from, to }),
      Commission.loadCallCenter ? Commission.loadCallCenter() : Promise.resolve(null),
      Promise.resolve(null),
    ]);
    return { ...built, callCentre: rates || null };
  });

  /* ------------------------------------------------------------- live --- */

  /**
   * What is happening right now, against the plan.
   *
   * THE COLLECTED TOTAL HERE EQUALS `/api/targets-tracker`'s net collection for
   * the same range, to the piastre, because both come from the same call. The
   * audit asserts it on every run — the two pages describing one month's cash
   * differently is the single worst thing this report could do.
   */
  app.get('/api/targets-live', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });
    return require('../lib/targets-live.js').build({ from, to });
  });

  /**
   * One branch, broken down. Fetched when a reader expands the row.
   *
   * THE BRANCH IS A QUERY PARAMETER, NOT A PATH SEGMENT, deliberately: the test
   * harness keys its fetch stub on the path alone, so `/api/targets-live/branch/1`
   * would need a stub per branch while this needs one.
   */
  app.get('/api/targets-live-branch', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const name = String(req.query.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Which branch?' });
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    return require('../lib/targets-live.js').branch({ name, from, to });
  });

  /** A year of actuals with the prior year beside them. */
  app.get('/api/targets-actuals', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    if (year < 2000 || year > 2100) return reply.code(400).send({ error: 'That is not a year.' });
    return require('../lib/targets-live.js').actuals({ year });
  });

  /* ---------------------------------------------------------- targets --- */

  app.get('/api/targets-tracker', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    /* Default to the month the range ends in, and to today inside it — the
       tracker is a "where are we this month" report, so opening it on a closed
       month would bury the only question it exists to answer. */
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    /* Any range, not one month. Commission is monthly by definition, so the range
       is sliced into months, each scored against its own target, and the pools
       added — which is how payroll adds them. The earlier version refused
       anything spanning two months; that was a correct instinct implemented as a
       wall, and it stopped the report answering "how did the quarter go". */
    const range = await Tracker.buildTrackerRange({ from, to });

    /* The version comparison re-scores every branch, so it stays opt-in and only
       runs on the last month in the range — comparing policies is a question
       about one month's rules, not a range. */
    const l = range.latest;
    const versions = req.query.versions === '1' && l
      ? await Tracker.compareVersions({ year: l.year, month: l.month, from: l.coversFrom, to: l.coversTo })
      : null;

    /* The daily series, the service mix, the multiplier eligibility that follows
       from it, and the integrity checks — four sections report 05 carries that
       NRS had no data for. Computed over the WHOLE range, not just the last
       month, because they are the parts that genuinely span one. */
    const extras = await Tracker.buildExtras({ from, to });

    /* ---- what the two new tabs need ----

       Tab 01 scores the TARGET SHEET, which is a different thing from the
       branch commission this route was built for: doctors against an approved
       monthly schedule, not branches against a collection target. It is scored
       here rather than fetched separately by the page so the two cannot end up
       describing different months — and through `Targets.score` with the same
       inputs `routes/report.js` uses, so the section is the same section NRS
       draws, not a second reading of it.

       Tab 04 is doctor commission, which nothing in this app had before. */
    const Targets = require('../lib/targets.js');
    const Report = require('../lib/report.js');
    const DoctorCommission = require('../lib/doctor-commission.js');

    const monthStart = `${to.slice(0, 7)}-01`;
    const EX = { excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS };
    const [sheet, rangeRep, mtdRep] = await Promise.all([
      Targets.loadPeriod(to.slice(0, 7)),
      Report.buildReport(from, to, EX),
      from === monthStart ? null : Report.buildReport(monthStart, to, EX),
    ]);
    const rangeDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);
    const targets = sheet
      ? Targets.score(sheet, { mtd: mtdRep || rangeRep, range: rangeRep, to, rangeDays })
      : { missing: true, period: to.slice(0, 7) };

    const commission = await DoctorCommission.build({ from, to })
      .catch((e) => ({ error: e.message }));

    /* The single-month payload stays at the top level so every existing panel
       keeps working unchanged; the range summary rides alongside it. */
    return { ...(l || {}), range, extras, versions, targets, commission, meta: { from, to, rangeDays } };
  });

  /* The pool simulator. It runs `commission-rules.branchMonth` — the SAME
     function that scores the real month — on a hypothetical collection. Doing it
     server-side rather than in the browser is the whole point: a second copy of
     the ladder and the band logic in page JS would drift from the stored policy
     the first time a tier changed, and the simulator would then quietly disagree
     with the tracker sitting next to it. */
  app.get('/api/targets-simulate', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const R = require('../lib/commission-rules.js');
    const { prisma } = require('../lib/db.js');

    const net = Number(req.query.net);
    if (!Number.isFinite(net) || net < 0) return reply.code(400).send({ error: 'net must be a non-negative number.' });
    const branchId = Number(req.query.branchId);
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return reply.code(400).send({ error: 'year and month are required.' });
    }

    const [branch, target, tiers, roles, departments, policy] = await Promise.all([
      prisma.commissionBranch.findUnique({ where: { id: branchId } }),
      prisma.commissionTarget.findFirst({ where: { branchId, year, month } }),
      prisma.commissionTier.findMany({ orderBy: { tierNo: 'asc' } }),
      prisma.commissionRole.findMany({ orderBy: [{ sortOrder: 'asc' }] }),
      prisma.commissionDepartment.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      Tracker.policyFor(`${year}-${String(month).padStart(2, '0')}-28`),
    ]);
    if (!branch) return reply.code(400).send({ error: 'Unknown branch.' });

    const cfg = await require('../lib/commission.js').loadPolicy();
    const wanted = String(req.query.mults || '').split(',').filter(Boolean);
    const earnedDepartments = departments.filter((x) => x.multiplier && wanted.includes(x.key));

    const scored = R.branchMonth({
      net,
      target: target ? Number(target.target) : 0,
      bands: R.bandsFor(target || {}, policy.bands),
      tiers, roles, earnedDepartments,
      multiplierCap: (cfg && cfg.multiplierCap) || R.MULTIPLIER_CAP,
    });

    return {
      branch: { id: branch.id, name: branch.name, entity: branch.entity, area: branch.area },
      year, month,
      policyVersion: policy.version,
      multiplierCap: (cfg && cfg.multiplierCap) || R.MULTIPLIER_CAP,
      departments: departments.filter((x) => x.multiplier)
        .map((x) => ({ key: x.key, label: x.label, multiplier: Number(x.multiplier) })),
      ...scored,
    };
  });

  /* ------------------------------------------------------- commercial --- */

  /* The funnel, as much of it as exists. Odoo holds bookings, attendance and
     invoices; the two steps before them — Meta impressions through to leads, and
     leads through to answered calls — live in Supermetrics and the PBX, neither
     of which is connected. The response says so in `missingSteps` rather than
     leaving the page to imply a funnel that starts at "booked". */
  app.get('/api/commercial-funnel', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    const Appointments = require('../lib/appointments.js');
    const Report = require('../lib/report.js');

    const Patients = require('../lib/patients.js');

    const Finance = require('../lib/finance.js');
    /* The top of the chain. Report 04 drew Steps 0 and 0b as dashed "no source"
       boxes because nothing reached NRS; the Meta cache now answers both, so
       they are read from the SAME functions report 03 uses rather than
       recomputed here. Two derivations of one figure is two chances to
       disagree, and the two reports sit one sidebar entry apart. */
    const Marketing = require('../lib/marketing.js');

    const [entities, funnel, revenue, pending, patientFunnel, collections, tracker, paidTop, leadTop] = await Promise.all([
      Tracker.branchEntities(),
      Appointments.buildFunnel({ from, to }),
      Report.revenueExcludingJournals(from, to, Report.EXCLUDED_REVENUE_JOURNALS),
      /* The unresolved queue as a working call list — names and dialable mobiles,
         200 rows on the page and the rest in the CSV, exactly as report 04 does
         it. Without the mobile this is a report about a problem instead of the
         list somebody works through. The page carries the warning. */
      Appointments.buildPending({ from, to, reveal: true, take: 200 }),
      Patients.buildPatientFunnel({ from, to }),
      /* Cash, for "cash vs revenue" — the ratio report 04 uses to say whether
         what was invoiced actually arrived. */
      Finance.resolve().then((cfg) => Finance.collectionsTotals(cfg, { from, to })).catch(() => null),
      /* And the commission projection, for "commission cost". It is the only
         ratio on the tab that comes from report 05 rather than this one, so it is
         read from the tracker rather than recomputed here. */
      Tracker.buildTrackerRange({ from, to }).then((r) => (r.latest ? {
        /* RANGE totals, not the last month's. The chain's other steps are all
           range-wide, so a last-month cash figure beside them is not a small
           inconsistency — it printed "cash vs revenue 4.3%" on a quarter whose
           real figure is 52.8%. The commission base still comes from the Targets
           report rather than being derived here, so the two cannot disagree. */
        /* The group-level figure: all cash ex-VAT, attributed or not. The chain
           is a group funnel, so a branch-attributed sum understates it by
           whatever has no branch_id — which before August is everything. */
        net: r.totals.netTotal,
        netAttributed: r.totals.net,
        unattributedNet: r.totals.unattributedNet,
        gross: r.totals.gross,
        refunds: r.totals.refunds,
        txns: r.totals.txns,
        pool: r.totals.pool,
        closed: r.totals.closed,
        monthsCovered: r.totals.monthsCovered,
        /* Per-month, for the commission-cost ratio on a single open month where a
           projection is the honest denominator. */
        latestProjected: r.latest.totals.projected,
        latestPoolRun: r.latest.totals.poolRun,
        policyVersion: r.latest.policy.version,
      } : null)).catch(() => null),
      Marketing.buildPaid({ from, to }),
      Marketing.buildLeadQuality({ from, to }),
    ]);

    return {
      from, to,
      /* The All / Nouvel Age / ZAT switch. It cannot be derived from a branch
         name — no Odoo branch is called "ZAT" — so the mapping is sent with the
         payload rather than guessed in the browser. */
      entities,
      funnel,
      revenue,
      pending: {
        total: pending.total, returned: pending.rows.length,
        noMobile: pending.noMobile, sensitive: pending.sensitive,
        rows: pending.rows,
      },
      patientFunnel,
      collections: collections && !collections.error ? collections : null,
      tracker,
      /* Named, not silently absent. Each entry is a step the report will show as
         an empty row with the reason attached — the source HTML transcribed
         numbers here that nothing can reproduce. */
      /* Keyed, because the page has to place each one at a specific point in the
         chain. Matching on the source text was how an earlier version did it, and
         "the lead sheet".split(' ')[0] is "the", which matches everything. */
      /* Steps 0 and 0b, now that they exist. Only the shape the chain needs —
         the full picture is report 03. `null` where the cache has nothing for
         this range, which keeps the dashed "no source" box for ranges we have
         genuinely not synced instead of drawing a confident zero. */
      chain: {
        spend: paidTop.spend > 0 ? {
          spend: paidTop.spend,
          results: paidTop.results,
          msgConversations: paidTop.msgConversations,
          onFbLeads: paidTop.onFbLeads,
          costPerResult: paidTop.costPerResult,
          daysWithData: paidTop.daysWithData,
          daysInRange: paidTop.daysInRange,
        } : null,
        leads: leadTop.leads > 0 ? {
          leads: leadTop.leads,
          withKey: leadTop.withKey,
          booked: leadTop.booked,
          attended: leadTop.attended,
          invoiced: leadTop.invoiced,
          /* Meta keeps lead rows for ~90 days. A range reaching further back is
             partly unanswerable and the chain has to say so rather than let the
             step read as the whole range. */
            window: leadTop.window,
        } : null,
      },
      /* What is STILL missing, computed rather than asserted. This list was
         hard-coded when none of the three had a source; two of them now do, and
         a hard-coded "Supermetrics is not connected" would have gone on
         claiming otherwise on a page sitting beside the report that proves it. */
      missingSteps: [
        ...(paidTop.spend > 0 ? [] : [{
          key: 'spend', st: 'Step 0', step: 'Meta ad spend',
          source: 'Meta Ads via Supermetrics',
          reason: 'No Meta rows cached for this range — run scripts/sync-meta.js to fill it.',
        }]),
        ...(leadTop.leads > 0 ? [] : [{
          key: 'leads', st: 'Step 0b', step: 'Meta leads',
          source: 'Meta lead ads via Supermetrics',
          reason: 'No lead rows cached for this range. Meta keeps lead-level data for about '
            + '90 days, so a range older than that cannot be filled at all.',
        }]),
        {
          key: 'calls', st: 'Step 1', step: 'Conversations',
          source: 'PBX call logs',
          reason: 'The PBX export is not a source NRS reads, so contact volume is unknown.',
        },
      ],
    };
  });

  /* The whole queue as a CSV — report 04's "Download CSV", which is the point of
     the list: a manager gets their branch's rows and works them.

     It is a download of patient names and phone numbers, so it is behind the same
     login as everything else and the filename carries the range and the branch,
     which is what stops one branch's file being mistaken for another's. */
  app.get('/api/commercial/unresolved.csv', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });
    const branch = req.query.branch && req.query.branch !== 'all' ? String(req.query.branch) : null;

    const Appointments = require('../lib/appointments.js');
    const q = await Appointments.buildPending({ from, to, branch, reveal: true, take: 20000 });

    /* Excel opens a bare comma file in the system encoding and mangles the Arabic
       patient names, so the BOM is not decoration. And a leading `=`, `+` or `-`
       in a cell is executed as a formula, so those are prefixed with a quote. */
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      let t = String(v);
      if (/^[=+\-@]/.test(t)) t = `'${t}`;
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ['Patient', 'Mobile', 'Service', 'Appointment date', 'State',
      'Branch', 'Doctor', 'Booked by', 'Created'];
    const lines = [head.join(',')];
    for (const r of q.rows) {
      lines.push([r.patient, r.mobile, r.service, r.date, r.states,
        r.branchName, r.specialistName, r.createdBy, r.createdAt].map(cell).join(','));
    }

    const slug = (branch || 'all-branches').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await app.audit(req, 'export.unresolved', `${from}..${to} ${slug} ${q.rows.length} rows`);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition',
      `attachment; filename="unresolved-${slug}-${from}-to-${to}.csv"`);
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  });

  /* --------------------------------------------------- commercial sales --- */

  /* Report 01, as its own report. It is NOT merged into the Sales report at `/`:
     that one stays exactly as it is. This is the same underlying cache read a
     different way — ex-package revenue as the headline, a category slicer that
     cuts by branch and by doctor, and the patient half on its own tab. */
  app.get('/api/commercial-sales', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    const Report = require('../lib/report.js');
    const Patients = require('../lib/patients.js');
    const Appointments = require('../lib/appointments.js');
    const Finance = require('../lib/finance.js');

    const basis = req.query.basis === 'report06' ? 'report06' : 'report01';
    const churnMonths = Math.min(24, Math.max(1, Number(req.query.churn) || 6));

    const [entities, report, exPkg, cuts, extras, coll, funnel, tiers, patFunnel, acquisition, churn, homeBranch, serviceMix] =
      await Promise.all([
        Tracker.branchEntities(),
        Report.buildReport(from, to),
        Report.revenueExcludingJournals(from, to, Report.EXCLUDED_REVENUE_JOURNALS),
        Report.revenueCutsExcludingJournals(from, to, Report.EXCLUDED_REVENUE_JOURNALS),
        Tracker.buildExtras({ from, to }),
        Finance.resolve().then((cfg) => Finance.collectionsTotals(cfg, { from, to })).catch(() => null),
        Appointments.buildFunnel({ from, to }),
        Patients.buildTiers({ asOf: to, basis }),
        Patients.buildPatientFunnel({ from, to }),
        Patients.buildAcquisition({ from, to }),
        Patients.buildChurnDetail({ asOf: to, months: churnMonths }),
        Patients.buildHomeBranch({ asOf: to, basis }),
        Patients.buildServiceMix({ from, to, basis }),
      ]);

    /* buildReport carries `refundList`, which holds patient names. It is not
       needed by any panel here, so it is dropped rather than shipped. */
    const { refundList, branchDoctors, branchProducts, doctorProducts, products, ...rest } = report;

    return {
      from, to,
      entities,
      report: rest,
      exPackage: exPkg,
      cuts,
      mix: extras.mix,
      collections: coll && !coll.error ? coll : null,
      appointments: {
        booked: funnel.booked, attended: funnel.totals.attended, open: funnel.totals.open,
        showRate: funnel.showRate, reportable: funnel.reportable,
        measuredFrom: funnel.measuredFrom, cutover: funnel.cutover, preCutover: funnel.preCutover,
      },
      patients: {
        basis: tiers.basis, alternatives: tiers.alternatives, coverage: tiers.coverage,
        basisCovered: tiers.basisCovered, tiers: tiers.tiers,
        count: tiers.patients.length, total: tiers.total,
        top: tiers.patients.slice(0, 50).map((p) => ({
          name: p.name, exVat: p.exVat, invoices: p.invoices, tier: p.tier,
          firstInvoice: p.firstInvoice, lastInvoice: p.lastInvoice,
        })),
        funnel: patFunnel, acquisition, churn, homeBranch, serviceMix,
      },
    };
  });

  /* --------------------------------------------------------- patients --- */

  app.get('/api/patients', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    const Patients = require('../lib/patients.js');
    const basis = req.query.basis === 'report06' ? 'report06' : 'report01';

    const churnMonths = Math.min(24, Math.max(1, Number(req.query.churn) || 6));

    const [tiers, mix, retention, serviceMix, homeBranch, funnel, acquisition, churn] = await Promise.all([
      Patients.buildTiers({ asOf: to, basis }),
      Patients.buildMix({ from, to }),
      Patients.buildRetention({ asOf: to }),
      Patients.buildServiceMix({ from, to, basis }),
      Patients.buildHomeBranch({ asOf: to, basis }),
      Patients.buildPatientFunnel({ from, to }),
      Patients.buildAcquisition({ from, to }),
      Patients.buildChurnDetail({ asOf: to, months: churnMonths }),
    ]);

    /* The per-patient list is where the PII is. The page needs the distribution,
       not 17,000 names, so only the tier rollups and a bounded top-spenders cut
       cross the wire — and that cut carries no contact detail at all. */
    const top = tiers.patients.slice(0, 50).map((p) => ({
      name: p.name, exVat: p.exVat, invoices: p.invoices, tier: p.tier,
      firstInvoice: p.firstInvoice, lastInvoice: p.lastInvoice,
    }));

    return {
      from, to,
      basis: tiers.basis,
      alternatives: tiers.alternatives,
      coverage: tiers.coverage,
      basisCovered: tiers.basisCovered,
      tiers: tiers.tiers,
      patients: tiers.patients.length,
      total: tiers.total,
      top,
      mix,
      retention,
      serviceMix,
      homeBranch,
      funnel,
      acquisition,
      churn,
    };
  });
};
