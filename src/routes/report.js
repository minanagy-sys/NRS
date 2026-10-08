/* The report itself: JSON for the page, plus the on-demand refresh. */

const fs = require('fs');
const path = require('path');
const { prisma, ymd, dateOnly } = require('../lib/db.js');
const Report = require('../lib/report.js');
const Targets = require('../lib/targets.js');
const Sync = require('../lib/sync.js');
const Export = require('../lib/export-targets.js');
const Commission = require('../lib/commission.js');
const { iso } = require('../lib/rules.js');
const Gate = require('../lib/admin-gate.js');

const VIEW = path.join(__dirname, '..', 'views', 'report.html');
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

module.exports = async function (app) {
  /* Signed out, show our own page rather than bouncing straight to the MCP —
     landing on a screen headed "Connect Claude" with no explanation is
     disorienting, and it is the step people get stuck on. */
  app.get('/', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? VIEW : SIGNIN, 'utf8')));

  app.get('/api/report', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const from = isDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = isDate(req.query.to) ? req.query.to : today;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    const monthStart = `${to.slice(0, 7)}-01`;
    /* EVERY figure on this report is ex-package.
       A package is invoiced when it is SOLD, carries no VAT, and is a
       prepayment against visits that have not happened yet. Counting it as
       revenue flatters whichever branch sold packages that month, so two
       branches doing identical work rank differently — and the ranking is most
       of what this report is for. The exclusion therefore runs through every
       cut rather than sitting on one card, and `totals.excluded` carries what
       was taken out so the page can show its size. */
    const EX = { excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS };
    const [report, mtd] = await Promise.all([
      Report.buildReport(from, to, EX),
      from === monthStart ? null : Report.buildReport(monthStart, to, EX),
    ]);
    const mtdReport = mtd || report;

    // One inclusive day count, so a single day scores against one daily target.
    const rangeDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);

    const sheet = await Targets.loadPeriod(to.slice(0, 7));
    const targets = sheet
      ? Targets.score(sheet, { mtd: mtdReport, range: report, to, rangeDays })
      : { missing: true, period: to.slice(0, 7) };

    /* The commission view is scored HERE, off the same branch cut the rest of the
       report uses, rather than fetched separately by the browser — two round trips
       against a moving cache is how two tabs end up disagreeing about what a
       branch did. `mtdReport.branches` is month-to-date, which is what a monthly
       target must be measured against even when the selected range is narrower. */
    const [y, mo] = to.slice(0, 7).split('-').map(Number);
    const daysInPeriod = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    /* Net collections on the Sales overview, beside Revenue ex-VAT.
       The finance REPORT is hidden but its data and its libraries are not, and
       this reuses finance.js's own definition so the two can never disagree.
       It is a different measure from revenue — cash received inc-VAT, against
       invoiced ex-VAT — and it may cover fewer days, so the payload carries the
       window it actually covers and the card prints it. */
    const Finance = require('../lib/finance.js');
    const [stock, settling, lastSync, commission, collections, revenueExJournals] = await Promise.all([
      /* The range's own stock, not the newest in existence — see buildStock. */
      req.query.stock === '1' ? Report.buildStock(to) : null,
      Report.daySettling(from, to),
      prisma.syncRun.findFirst({ where: { status: 'ok' }, orderBy: { finishedAt: 'desc' } }),
      Commission.monthView(y, mo, mtdReport.branches, {
        dayNo: Number(to.slice(8, 10)), daysInPeriod,
      }).catch((e) => ({ error: e.message })),
      Finance.resolve()
        .then((cfg) => Finance.collectionsTotals(cfg.collections, { from, to }))
        .catch((e) => ({ error: e.message })),
      /* Kept for the Net collections card, which needs the all-invoice figure
         beside the ex-package one to show what the difference is. The rest of
         the payload is now ex-package throughout, so this is no longer the only
         place the exclusion happens — it is the place both bases appear side by
         side. */
      Report.revenueExcludingJournals(from, to).catch((e) => ({ error: e.message })),
    ]);

    return {
      meta: {
        from, to, monthStart, rangeDays,
        generatedAt: new Date().toISOString(),
        lastSyncAt: lastSync ? lastSync.finishedAt : null,
        coverage: await coverage(),
        user: { subject: req.user.subject, name: req.user.displayName },
      },
      report, mtd: mtdReport, targets, stock, settling, commission, collections, revenueExJournals,
    };
  });

  /* Re-reading Odoo into the cache is not an admin action: it changes no target
     sheet and cannot touch Odoo, which refuses writes outright. It only replaces
     a date window with what Odoo says right now — which is the point. Anyone
     signed in may do it; the rate limit stops it becoming a hammer. */
  app.post('/api/refresh', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = req.body || {};
    const today = iso(new Date());
    const from = isDate(body.from) ? body.from : `${today.slice(0, 7)}-01`;
    const to = isDate(body.to) ? body.to : today;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    // A refresh is a write; require the anti-CSRF header a form post cannot set.
    if (req.headers['x-requested-with'] !== 'fetch') {
      return reply.code(403).send({ error: 'Missing X-Requested-With.' });
    }

    try {
      const out = await Sync.syncRange({ token: req.user.token, from, to, trigger: 'manual', actor: req.user.subject });
      if (body.stock) out.stock = await Sync.syncStock({ token: req.user.token });
      await app.audit(req, 'refresh', `${from}..${to} — ${out.invoices} invoices`);
      return out;
    } catch (e) {
      req.log.error(e);
      /* Which layer failed changes what the reader should do about it, and
         saying "could not reach the MCP" during an Odoo outage sends them
         hunting through this app for a fault that is not here. The kind is
         safe to state; the detail still goes only to the log. */
      const said = Sync.explainSyncError(e, { again: 'Sync now' });
      return reply.code(said[0]).send({ error: said[1] });
    }
  });

  /* Next month's schedule as a workbook to fill in. A read, so no admin
     passphrase — it contains nothing the Targets tab does not already show. The
     X-Requested-With header is what stops it being a plain link: the session
     cookie is SameSite=Lax, which IS sent on a top-level GET from another site,
     so without this a link anywhere could pull the whole target sheet in one
     click. A cross-origin request cannot set the header. */
  app.get('/api/targets/:period/next-month.xlsx', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const period = req.params.period;
    if (!/^\d{4}-\d{2}$/.test(period)) return reply.code(400).send({ error: 'Period must look like 2026-08.' });
    if (req.headers['x-requested-with'] !== 'fetch') {
      return reply.code(403).send({ error: 'Missing X-Requested-With.' });
    }

    const sheet = await Targets.loadPeriod(period);
    if (!sheet) return reply.code(404).send({ error: `No target sheet for ${period}.` });

    const from = `${period}-01`;
    /* The actuals columns are labelled as THIS period's, so the window has to
       end inside it. Without the clamp a caller from a later month — Admin
       asking for the August template on 8 September, or a hand-typed `?to=` —
       would score August against invoices up to today, and "Invoiced to date"
       and "Achieved %" would carry a second month's sales under August's
       heading. The template is what next month's targets get set from, so an
       inflated actual is a decision made on a wrong number. */
    const [y, m] = period.split('-').map(Number);
    const periodEnd = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const asked = isDate(req.query.to) ? req.query.to : iso(new Date());
    const to = asked > periodEnd ? periodEnd : asked < from ? from : asked;
    const mtd = await Report.buildReport(from, to);
    const rangeDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);
    const scored = Targets.score(sheet, { mtd, range: mtd, to, rangeDays });

    const out = Export.nextMonthTemplate(sheet, scored);
    await app.audit(req, 'targets-export', `${period} → ${out.period}, ${out.rows.length - 1} doctors`);
    return reply
      .header('Content-Disposition', `attachment; filename="${out.filename}"`)
      .header('Cache-Control', 'no-store')
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(out.buffer);
  });

  app.get('/api/health', async () => {
    const [invoices, lastRun] = await Promise.all([
      prisma.invoice.count(),
      prisma.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    ]);
    return {
      ok: true,
      invoices,
      lastRun: lastRun && { at: lastRun.startedAt, status: lastRun.status, window: `${ymd(lastRun.fromDate)}..${ymd(lastRun.toDate)}` },
    };
  });
};

/** What range of dates the cache actually holds, so the page can say so. */
async function coverage() {
  const agg = await prisma.invoice.aggregate({ _min: { invoiceDate: true }, _max: { invoiceDate: true }, _count: true });
  return agg._count
    ? { from: ymd(agg._min.invoiceDate), to: ymd(agg._max.invoiceDate), invoices: agg._count }
    : null;
}
