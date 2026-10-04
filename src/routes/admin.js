/* Target sheets and name aliases — the two things Odoo has no place for. */

const fs = require('fs');
const path = require('path');
const Sheet = require('../lib/sheet.js');
const { prisma, num, ymd, dateOnly } = require('../lib/db.js');
const Gate = require('../lib/admin-gate.js');

const VIEW = path.join(__dirname, '..', 'views', 'admin.html');

const isPeriod = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** How many rows each finance section holds, per source, so the switch is informed. */
async function rowCounts() {
  const one = async (table, section) => {
    const rows = await table.groupBy({ by: ['source'], _count: true });
    const out = { section, snapshot: 0, odoo: 0 };
    for (const r of rows) out[r.source] = r._count;
    return out;
  };
  const [c, p, r, x] = await Promise.all([
    one(prisma.collection, 'collections'),
    one(prisma.supplier, 'payables'),
    one(prisma.reconProduct, 'recon'),
    one(prisma.expiryLot, 'expiry'),
  ]);
  return { collections: c, payables: p, recon: r, expiry: x };
}
const guard = (req, reply) =>
  req.headers['x-requested-with'] === 'fetch' ? null : reply.code(403).send({ error: 'Missing X-Requested-With.' });

module.exports = async function (app) {
  const requireWriter = [app.requireUser, Gate.requireWriter(app)];

  app.get('/admin', { preHandler: app.requireUser }, async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(VIEW, 'utf8')));

  /* The names Odoo actually uses, so pairing an alias is a choice from a list
     rather than typing and hoping. Drawn from the cache, which is what the
     report matches against. */
  app.get('/api/odoo-names', { preHandler: app.requireUser }, async () => {
    const [doctors, branches] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['specialistName'],
        where: { moveType: 'out_invoice', specialistName: { not: null } },
        _sum: { amountUntaxed: true }, _count: true,
      }),
      prisma.invoice.groupBy({
        by: ['branchName'],
        where: { moveType: 'out_invoice', branchName: { not: null } },
        _sum: { amountUntaxed: true }, _count: true,
      }),
    ]);
    const shape = (rows, field) => rows
      .map((r) => ({ name: r[field], invoices: r._count, ex: Math.round(num(r._sum.amountUntaxed)) }))
      .sort((a, b) => b.ex - a.ex);
    return { doctors: shape(doctors, 'specialistName'), branches: shape(branches, 'branchName') };
  });

  /* Dry-run the same validator the save uses, so the editor can show whether a
     sheet reconciles before anyone commits it. */
  app.post('/api/targets/validate', { preHandler: app.requireUser }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const problems = validate(req.body || {});
    return { ok: problems.length === 0, problems };
  });

  app.delete('/api/targets/:period', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const gone = await prisma.targetPeriod.deleteMany({ where: { period: req.params.period } });
    if (!gone.count) return reply.code(404).send({ error: `No sheet for ${req.params.period}.` });
    await app.audit(req, 'targets-delete', req.params.period);
    return { ok: true, deleted: req.params.period };
  });

  app.delete('/api/aliases/:kind/:scheduleName', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const { kind, scheduleName } = req.params;
    const gone = await prisma.identityAlias.deleteMany({ where: { kind, scheduleName: decodeURIComponent(scheduleName) } });
    if (!gone.count) return reply.code(404).send({ error: 'No such alias.' });
    await app.audit(req, 'alias-delete', `${kind}: ${scheduleName}`);
    return { ok: true };
  });

  app.get('/api/targets/:period', { preHandler: app.requireUser }, async (req, reply) => {
    const sheet = await require('../lib/targets.js').loadPeriod(req.params.period);
    return sheet || reply.code(404).send({ error: `No target sheet for ${req.params.period}.` });
  });

  app.get('/api/targets', { preHandler: app.requireUser }, async () => {
    const periods = await prisma.targetPeriod.findMany({
      orderBy: { period: 'desc' },
      include: { _count: { select: { doctorTargets: true, branchTargets: true } } },
    });
    return periods.map((p) => ({
      period: p.period, daysInPeriod: p.daysInPeriod, sourceLabel: p.sourceLabel,
      publishedAt: p.publishedAt, doctors: p._count.doctorTargets, branches: p._count.branchTargets,
    }));
  });

  /**
   * Replace one period's sheet. Rejects anything that does not cross-foot, so the
   * defect the original report shipped — 52 rows summing to 26,627,883 under a
   * stated 28,838,391 — cannot be re-introduced through this door.
   */
  app.put('/api/targets/:period', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const period = req.params.period;
    if (!isPeriod(period)) return reply.code(400).send({ error: 'Period must look like 2026-08.' });

    const b = req.body || {};
    const problems = validate(b);
    if (problems.length) return reply.code(400).send({ error: 'The sheet does not reconcile.', problems });

    const saved = await prisma.$transaction(async (tx) => {
      await tx.targetPeriod.deleteMany({ where: { period } });
      return tx.targetPeriod.create({
        data: {
          period,
          daysInPeriod: b.daysInPeriod || daysIn(period),
          sourceLabel: b.sourceLabel || null,
          groups: { create: Object.entries(b.groups).map(([name, g]) => ({
            name, target: g.target, rosterCount: g.rosterCount,
            unlistedCount: g.unlistedCount || 0, unlistedTarget: g.unlistedTarget || 0,
          })) },
          doctorTargets: { create: b.doctors.map((d) => ({
            scheduleName: d.name, groupName: d.group || null,
            monthlyTarget: d.monthlyTarget, prevMonth: d.prevMonth ?? null,
            hasSales: d.hasSales !== false,
          })) },
          branchTargets: { create: (b.branches || []).map((x) => ({
            scheduleName: x.name, target1: x.target1, target2: x.target2 ?? null,
          })) },
        },
        include: { _count: { select: { doctorTargets: true, branchTargets: true, groups: true } } },
      });
    });

    /* The draft has served its purpose. Left behind it becomes a second copy of
       a published month, free to drift, and the editor would offer to resume it
       over the real sheet. */
    const hadDraft = await prisma.targetDraft.deleteMany({ where: { period } });

    await app.audit(req, 'targets-replace', `${period}: ${saved._count.doctorTargets} doctors`);
    return {
      ok: true,
      period,
      doctors: saved._count.doctorTargets,
      branches: saved._count.branchTargets,
      draftCleared: hadDraft.count > 0,
    };
  });

  /* ---- the finance endpoints, HIDDEN 2026-08-19 ----

     Six routes lived here rather than in routes/finance.js: the Data sources
     screen, the Odoo payables sync, and the payables Excel export and import.
     Hiding the report meant these had to go too — /api/finance/payables/export.xlsx
     was still handing the whole payables workbook to any signed-in user.

     Gated, not deleted: the repository has no commits, so a delete is permanent.
     FINANCE_ENABLED=1 brings all six back exactly as they were. */
  if (process.env.FINANCE_ENABLED === '1') {

    app.get('/api/finance/sources', { preHandler: app.requireUser }, async () => {
      const Finance = require('../lib/finance.js');
      const [cfg, batches, counts] = await Promise.all([
        Finance.resolve(),
        prisma.financeBatch.findMany({ orderBy: { importedAt: 'desc' } }),
        rowCounts(),
      ]);
      return {
        sections: Finance.SECTIONS.map((section) => ({
          section,
          ...cfg[section],
          counts: counts[section] || { snapshot: 0, odoo: 0 },
          batches: batches.filter((b) => b.section === section).map((b) => ({
            source: b.source, asOf: ymd(b.asOf), importedAt: b.importedAt,
            rowCount: b.rowCount, label: b.label,
          })),
          /* Payables has nowhere else to come from: Odoo 18 went live 2026-08-01 and
             the earlier history was never migrated into it. Say so in the UI rather
             than offering a switch that would empty the section. */
          odooPossible: section !== 'payables',
        })),
      };
    });

    app.put('/api/finance/sources/:section', { preHandler: requireWriter }, async (req, reply) => {
      const stop = guard(req, reply); if (stop) return stop;
      const Finance = require('../lib/finance.js');
      const { section } = req.params;
      if (!Finance.SECTIONS.includes(section)) return reply.code(400).send({ error: `Unknown section "${section}".` });

      const mode = String((req.body || {}).mode || '');
      if (!['snapshot', 'odoo', 'stitched'].includes(mode)) {
        return reply.code(400).send({ error: 'Mode must be snapshot, odoo or stitched.' });
      }
      const cutover = (req.body || {}).cutover || null;
      if (mode === 'stitched' && !isDate(cutover)) {
        return reply.code(400).send({ error: 'A stitched section needs a cutover date — the day Odoo takes over.' });
      }
      if (section === 'payables' && mode === 'odoo') {
        return reply.code(400).send({
          error: 'Payables cannot read Odoo alone: Odoo 18 holds nothing before 2026-08-01. Use stitched.',
        });
      }

      const saved = await prisma.financeSource.upsert({
        where: { section },
        update: { mode, cutover: mode === 'stitched' ? dateOnly(cutover) : null },
        create: { section, mode, cutover: mode === 'stitched' ? dateOnly(cutover) : null },
      });
      await app.audit(req, 'finance-source', `${section} -> ${mode}${saved.cutover ? ` at ${ymd(saved.cutover)}` : ''}`);
      return { ok: true, section, mode, cutover: saved.cutover ? ymd(saved.cutover) : null };
    });

    /* Pull a finance section from Odoo 18. Payables is real; the other three still
       read their snapshot, and say so rather than failing vaguely. */
    app.post('/api/finance/sync/:section', {
      preHandler: requireWriter,
      config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
    }, async (req, reply) => {
      const stop = guard(req, reply); if (stop) return stop;
      const { section } = req.params;

      if (section !== 'payables') {
        return reply.code(501).send({
          error: `Syncing ${section} from Odoo is not built yet — it still reads its imported snapshot.`,
        });
      }

      const body = req.body || {};
      const to = isDate(body.to) ? body.to : new Date().toISOString().slice(0, 10);
      const from = isDate(body.from) ? body.from : '2026-08-01';
      if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

      try {
        const out = await require('../lib/finance-sync.js')
          .syncPayables({ token: req.user.token, from, to });
        await app.audit(req, 'finance-sync', `payables ${from}..${to}: ${out.bills} bills, ${out.payments} payments`);
        return { ok: true, ...out };
      } catch (e) {
        req.log.error(e);
        /* Which layer failed changes what to do about it — the same distinction the
           sales Refresh draws, so an Odoo outage is never read as a missing feature. */
        const said = {
          token: [401, 'Your sign-in has expired. Sign out, sign in again, then try once more.'],
          odoo: [503, 'The MCP is up but Odoo is not answering it. Nothing was changed — try again shortly.'],
        }[e.kind] || [502, 'Could not reach the MCP. The server log has the detail.'];
        return reply.code(said[0]).send({ error: said[1] });
      }
    });

    /* ---- payables to and from a spreadsheet ---- */

    /**
     * The stored payables as an editable workbook, in the shape the importer reads.
     * A read, so no passphrase — but it still needs `X-Requested-With`, because the
     * session cookie is SameSite=Lax and a bare link on any site would otherwise
     * pull the whole supplier ledger on one click.
     */
    app.get('/api/finance/payables/export.xlsx', {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    }, async (req, reply) => {
      if (req.headers['x-requested-with'] !== 'fetch') {
        return reply.code(403).send({ error: 'Missing X-Requested-With.' });
      }
      const source = req.query.source === 'odoo' ? 'odoo' : 'snapshot';
      const from = isDate(req.query.from) ? req.query.from : null;
      const to = isDate(req.query.to) ? req.query.to : null;
      if (from && to && from > to) return reply.code(400).send({ error: '"From" is after "To".' });

      const out = await require('../lib/export-payables.js').exportPayables({ source, from, to });
      await app.audit(req, 'payables-export',
        `${source}: ${out.counts.suppliers} suppliers, ${out.counts.bills} bills, ${out.counts.payments} payments`);
      return reply
        .header('Content-Disposition', `attachment; filename="${out.filename}"`)
        .header('Cache-Control', 'no-store')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(out.buffer);
    });

    /** Read the workbook and describe it. Nothing is written. */
    app.post('/api/finance/payables/inspect', { preHandler: requireWriter }, async (req, reply) => {
      const stop = guard(req, reply); if (stop) return stop;
      const b = req.body || {};
      if (!b.base64) return reply.code(400).send({ error: 'Send the workbook as base64.' });
      try {
        return require('../lib/payables-import.js').inspect(Buffer.from(b.base64, 'base64'), b.sheet);
      } catch (e) {
        return reply.code(400).send({ error: `Could not read the file: ${e.message}` });
      }
    });

    /**
     * Import supplier balances, bills or payments.
     * `dryRun` returns what would change; without it the rows are merged in.
     */
    app.post('/api/finance/payables/import', { preHandler: requireWriter }, async (req, reply) => {
      const stop = guard(req, reply); if (stop) return stop;
      const P = require('../lib/payables-import.js');
      const b = req.body || {};
      if (!b.base64) return reply.code(400).send({ error: 'Send the workbook as base64.' });
      if (!P.KINDS.includes(b.kind)) {
        return reply.code(400).send({ error: `Say what the sheet is: ${P.KINDS.join(', ')}.` });
      }

      let wb;
      try {
        wb = Sheet.read(Buffer.from(b.base64, 'base64'), b.sheet);
      } catch (e) {
        return reply.code(400).send({ error: `Could not read the file: ${e.message}` });
      }

      const cols = b.cols || P.resolveColumns(b.kind, wb.columns);
      const need = b.kind === 'balances' ? ['name'] : ['supplier', 'date', b.kind === 'bills' ? 'gross' : 'amount'];
      const missing = need.filter((k) => !cols[k]);
      if (missing.length) {
        return reply.code(400).send({
          error: `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. The sheet has: ${wb.columns.join(', ')}.`,
        });
      }

      const { records, skipped, problems } = P.plan(b.kind, wb.rows, cols);
      if (!records.length) {
        return reply.code(400).send({ error: 'Nothing usable in that sheet.', problems: problems.concat(skipped).slice(0, 20) });
      }
      /* A cell that cannot be read is refused rather than silently zeroed — a typo
         becoming a balance of nothing is the one outcome worth blocking. */
      if (problems.length) {
        return reply.code(400).send({
          error: `${problems.length} row${problems.length === 1 ? '' : 's'} could not be read. Fix them and import again.`,
          problems: problems.slice(0, 20),
        });
      }

      const summary = await P.preview(b.kind, records);
      summary.skipped = skipped.slice(0, 20);
      summary.skippedCount = skipped.length;
      if (b.dryRun) return { ok: true, dryRun: true, ...summary };

      const out = await P.commit(b.kind, records);
      await app.audit(req, 'payables-import', `${b.kind}: ${out.written} rows, ${out.suppliers} suppliers`);
      return { ok: true, ...summary, ...out };
    });
  }

  /* -------------------------------------------------- 07 · data uploads --- */

  /* The three feeds report 02 and report 03 have no connection for: the
     Grandstream PBX export, the omnichannel export, and the CTA/organic lead
     sheet. Same inspect → review → import three-step as payables, and for the
     same reason: nobody uploading a CDR export knows what columns it has, and
     the alternative to showing them is guessing.

     Behind `requireWriter`, like every other write on this page. */

  /** Read the workbook and describe it. Nothing is written. */
  app.post('/api/uploads/inspect', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const b = req.body || {};
    if (!b.base64) return reply.code(400).send({ error: 'Send the workbook as base64.' });
    try {
      return require('../lib/pbx-import.js')
        .inspect(Buffer.from(b.base64, 'base64'), b.sheet, b.headerRow);
    } catch (e) {
      return reply.code(400).send({ error: `Could not read the file: ${e.message}` });
    }
  });

  /**
   * Import PBX activity, chat volume or organic leads.
   * `dryRun` returns what would change; without it the rows are written.
   */
  app.post('/api/uploads/import', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const U = require('../lib/pbx-import.js');
    const b = req.body || {};
    if (!b.base64) return reply.code(400).send({ error: 'Send the workbook as base64.' });
    if (!U.KINDS.includes(b.kind)) {
      return reply.code(400).send({ error: `Say what the sheet is: ${U.KINDS.join(', ')}.` });
    }

    let wb;
    try {
      /* `headerRow` because not every workbook puts its header on row 1 — the
         commission workbook's Basic worksheet carries a banner on row 2 and its
         real header on row 5. Named by the reviewer, never guessed. */
      wb = Sheet.read(Buffer.from(b.base64, 'base64'), b.sheet, b.headerRow);
    } catch (e) {
      return reply.code(400).send({ error: `Could not read the file: ${e.message}` });
    }

    /* The reviewer may correct the column mapping by hand, which is the point of
       showing it — no real Grandstream export has been seen on this project, so
       the guesses are guesses. */
    /* A payroll sheet says WHO, never WHEN — the Attendance worksheet is two
       columns wide. The month comes from the uploader, and is demanded here
       rather than defaulted to "this month", because a payroll sheet filed
       against the wrong month is not a smaller mistake than one refused. */
    if (b.kind === 'payroll' && !/^\d{4}-\d{2}$/.test(String(b.period || ''))) {
      return reply.code(400).send({ error: 'Say which month this payroll sheet is for, as YYYY-MM.' });
    }

    const cols = b.cols || U.resolveColumns(b.kind, wb.columns);
    const missing = (U.NEEDS[b.kind] || []).filter((k) => !cols[k]);
    if (missing.length) {
      return reply.code(400).send({
        error: `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. `
          + `The sheet has: ${wb.columns.join(', ')}.`,
      });
    }

    const { records, skipped, problems } = U.plan(b.kind, wb.rows, cols, b.headerRow);
    if (!records.length) {
      return reply.code(400).send({
        error: 'Nothing usable in that sheet.',
        problems: problems.concat(skipped).slice(0, 20),
      });
    }
    /* A row that looks like data and cannot be read BLOCKS the import: a day
       silently short of its calls is worse than an import that refused. */
    if (problems.length) {
      return reply.code(400).send({
        error: `${problems.length} row${problems.length === 1 ? '' : 's'} could not be read. `
          + 'Fix them and import again.',
        problems: problems.slice(0, 20),
      });
    }

    const summary = await U.preview(b.kind, records, { period: b.period });
    summary.skipped = skipped.slice(0, 20);
    summary.skippedCount = skipped.length;
    if (b.dryRun) return { ok: true, dryRun: true, ...summary };

    const out = await U.commit(b.kind, records, { period: b.period });
    /* Recorded in the same place the Meta syncs and the PBX seed record
       themselves, so one table answers "where did this number come from". */
    await prisma.dataUpload.create({
      data: {
        kind: `${b.kind}:upload`,
        filename: b.filename || null,
        rangeFrom: out.from ? new Date(`${out.from}T00:00:00Z`) : null,
        rangeTo: out.to ? new Date(`${out.to}T00:00:00Z`) : null,
        rowsWritten: out.written,
        notes: [
          `${out.written} rows from ${b.filename || 'an upload'}`,
          summary.skippedCount ? `${summary.skippedCount} rows skipped` : null,
          summary.note ? summary.note.replace(/\s+/g, ' ') : null,
        ].filter(Boolean).join(' | '),
        actor: req.user && req.user.email,
      },
    });
    await app.audit(req, 'data-upload', `${b.kind}: ${out.written} rows`);
    return { ok: true, ...summary, ...out };
  });

  /** What has been uploaded, newest first — the provenance both reports print. */
  app.get('/api/uploads', { preHandler: app.requireUser }, async () => {
    const [loads, pbx, chat, organic, returns] = await Promise.all([
      prisma.dataUpload.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
      prisma.pbxDay.groupBy({ by: ['source'], _count: { _all: true }, _min: { date: true }, _max: { date: true } }),
      prisma.chatDay.groupBy({ by: ['source'], _count: { _all: true }, _min: { date: true }, _max: { date: true } }),
      prisma.metaLead.groupBy({ by: ['channel', 'source'], _count: { _all: true } }),
      /* Report 09's returns. Grouped by source for the same reason as the PBX
         days: which of `seed` and `upload` a figure is reading is the first
         thing anybody asks about it. */
      prisma.purchaseReturn.groupBy({ by: ['source'], _count: { _all: true }, _min: { date: true }, _max: { date: true } }),
    ]);
    const span = (g) => g.map((x) => ({
      source: x.source,
      rows: x._count._all,
      from: x._min.date ? x._min.date.toISOString().slice(0, 10) : null,
      to: x._max.date ? x._max.date.toISOString().slice(0, 10) : null,
    }));
    /* The API allowance, beside the uploads, because both answer the same
       question: what is feeding these reports and how much of it is left. The
       subscription allows 50,000 rows a month and one full backfill is 26,712 —
       a number worth seeing before somebody runs it twice. */
    const S = require('../lib/supermetrics.js');
    const api = await S.usage(prisma).catch(() => null);

    return {
      api,
      loads: loads.map((l) => ({
        kind: l.kind, filename: l.filename, rows: l.rowsWritten,
        from: l.rangeFrom ? l.rangeFrom.toISOString().slice(0, 10) : null,
        to: l.rangeTo ? l.rangeTo.toISOString().slice(0, 10) : null,
        notes: l.notes, actor: l.actor, at: l.createdAt.toISOString(),
      })),
      held: {
        pbx: span(pbx),
        chat: span(chat),
        returns: span(returns),
        leads: organic.map((x) => ({ channel: x.channel, source: x.source, rows: x._count._all })),
      },
    };
  });

  /* ---- what needs doing ---- */

  /**
   * The Admin landing panel: every input that has gone quiet, ranked.
   *
   * A READ, so no passphrase — it changes nothing and reports only what any
   * signed-in reader can already work out by visiting four tabs and knowing
   * what to look for. The point is that they no longer have to.
   *
   * Not cached. It runs four aggregate queries and the answer must be true at
   * the moment it is read: a panel that says "September has no sheet" ten
   * minutes after somebody published one is worse than no panel.
   */
  app.get('/api/admin/status', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async () => require('../lib/admin-status.js').build());

  /** Every feed and how fresh it is, for the Data tab. */
  app.get('/api/admin/feeds', { preHandler: app.requireUser }, async () =>
    ({ feeds: await require('../lib/feeds.js').read() }));

  /* ---- drafts: a sheet somebody is still working on ---- */

  app.get('/api/targets/:period/draft', { preHandler: app.requireUser }, async (req, reply) => {
    if (!isPeriod(req.params.period)) return reply.code(400).send({ error: 'Period must look like 2026-09.' });
    const row = await prisma.targetDraft.findUnique({ where: { period: req.params.period } });
    return row || reply.code(404).send({ error: `No draft for ${req.params.period}.` });
  });

  app.get('/api/targets/drafts', { preHandler: app.requireUser }, async () =>
    prisma.targetDraft.findMany({
      select: { period: true, savedAt: true, actor: true, note: true },
      orderBy: { period: 'asc' },
    }));

  /**
   * Save a draft. Writes, so it is gated like every other write here.
   *
   * A draft is NOT validated. It is work in progress by definition — half the
   * targets blank is the normal state ten minutes in — and refusing to save it
   * until it reconciles would defeat the entire purpose, which is letting
   * somebody stop halfway. `PUT /api/targets/:period` still refuses anything
   * that does not cross-foot, and that is the gate that matters.
   */
  app.put('/api/targets/:period/draft', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const period = req.params.period;
    if (!isPeriod(period)) return reply.code(400).send({ error: 'Period must look like 2026-09.' });

    const b = req.body || {};
    if (!Array.isArray(b.doctors) || !b.groups) {
      return reply.code(400).send({ error: 'A draft needs doctors and groups, even empty ones.' });
    }

    const saved = await prisma.targetDraft.upsert({
      where: { period },
      update: { payload: b, actor: req.user.subject, note: b.note || null },
      create: { period, payload: b, actor: req.user.subject, note: b.note || null },
    });
    await app.audit(req, 'draft-save', `${period}: ${b.doctors.length} doctors`);
    return { ok: true, period, savedAt: saved.savedAt, doctors: b.doctors.length };
  });

  app.delete('/api/targets/:period/draft', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const gone = await prisma.targetDraft.deleteMany({ where: { period: req.params.period } });
    if (!gone.count) return reply.code(404).send({ error: `No draft for ${req.params.period}.` });
    await app.audit(req, 'draft-delete', req.params.period);
    return { ok: true, deleted: req.params.period };
  });

  /** Parse an uploaded xlsx into the sheet shape without saving it, so it can be reviewed. */
  app.post('/api/targets/parse', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const b = req.body || {};
    if (!b.base64) return reply.code(400).send({ error: 'Send the workbook as base64.' });
    try {
      const out = Sheet.read(Buffer.from(b.base64, 'base64'), b.sheet);
      return {
        sheets: out.sheets, sheet: out.sheet, rowCount: out.rowCount, columns: out.columns,
        sample: out.rows.slice(0, 20),
        // The preview only needs a sample; building the draft needs everything.
        rows: b.all ? out.rows : undefined,
      };
    } catch (e) {
      return reply.code(400).send({ error: `Could not read the file: ${e.message}` });
    }
  });

  /* ---------------------------------------- vendor terms (report 09) --- */

  /* Cash-back rates and purchase targets. POLICY, NOT DATA: nothing in Odoo
     records that Bio Solutions pays 10% back and Eldawlia Pharma pays 15%, so
     it is stored and edited here. Reads are open to anyone signed in; writes
     need the passphrase, like every other figure that changes what somebody
     gets paid. */
  app.get('/api/vendor-terms', { preHandler: app.requireUser }, async (req) => {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const [terms, suppliers] = await Promise.all([
      prisma.vendorTerm.findMany({ where: { year }, orderBy: { supplierName: 'asc' } }),
      /* Every supplier that raised a bill this year, so a rate can be added to
         one that has none rather than only edited on one that has. */
      prisma.bill.groupBy({
        by: ['supplierName'],
        where: { date: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } },
        _sum: { net: true }, _count: true,
      }),
    ]);
    const byName = new Map(suppliers.map((s) => [s.supplierName, s]));
    return {
      year,
      terms: terms.map((t) => ({
        id: t.id, supplierName: t.supplierName,
        cashbackRate: t.cashbackRate == null ? null : Number(t.cashbackRate),
        basisNote: t.basisNote,
        targetLabel: t.targetLabel,
        targetAmount: t.targetAmount == null ? null : Number(t.targetAmount),
        source: t.source,
        /* What the rate would be applied to, so a wrong name is visible as a
           supplier with an agreement and no purchases. */
        net: byName.has(t.supplierName) ? Number(byName.get(t.supplierName)._sum.net) : null,
        bills: byName.has(t.supplierName) ? byName.get(t.supplierName)._count : 0,
      })),
      suppliers: suppliers
        .map((s) => ({ supplierName: s.supplierName, net: Number(s._sum.net), bills: s._count }))
        .sort((a, b) => b.net - a.net),
      /* The report matches a term to a supplier on the EXACT name only — see
         lib/procurement.js. Surfaced here because "why is this vendor owed
         nothing" is almost always a spelling difference. */
      matching: 'A term reaches a supplier only when the two names match exactly. '
        + 'Loosely matched, 21 agreements reached 63 of 73 suppliers and owed cash back on rent.',
    };
  });

  app.put('/api/vendor-terms', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const b = req.body || {};
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      return reply.code(400).send({ error: 'Give a year.' });
    }
    const list = Array.isArray(b.terms) ? b.terms : null;
    if (!list) return reply.code(400).send({ error: 'Send an array of terms.' });

    const problems = [];
    const clean = [];
    for (const t of list) {
      const name = String(t.supplierName || '').trim();
      if (!name) { problems.push('A term has no supplier name.'); continue; }
      /* A RATE IS A FRACTION, NOT A PERCENTAGE. Somebody typing 10 meaning 10%
         would owe ten times the purchases back, so anything above 1 is refused
         rather than divided by a hundred on a guess. */
      let rate = null;
      if (t.cashbackRate !== null && t.cashbackRate !== undefined && String(t.cashbackRate) !== '') {
        rate = Number(t.cashbackRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
          problems.push(`${name}: a cash-back rate must be between 0 and 1 (0.10 for 10%), got ${t.cashbackRate}.`);
          continue;
        }
      }
      let amount = null;
      if (t.targetAmount !== null && t.targetAmount !== undefined && String(t.targetAmount) !== '') {
        amount = Number(t.targetAmount);
        if (!Number.isFinite(amount) || amount < 0) {
          problems.push(`${name}: a target must be a positive number, got ${t.targetAmount}.`);
          continue;
        }
      }
      clean.push({
        year,
        supplierName: name,
        cashbackRate: rate,
        basisNote: t.basisNote === undefined ? undefined : (String(t.basisNote || '').trim() || null),
        targetLabel: t.targetLabel === undefined ? undefined : (String(t.targetLabel || '').trim() || null),
        targetAmount: amount,
        source: 'admin',
      });
    }
    if (problems.length) return reply.code(400).send({ error: 'Some terms were refused.', problems });

    for (const t of clean) {
      const { year: y, supplierName, ...rest } = t;
      const update = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      await prisma.vendorTerm.upsert({
        where: { year_supplierName: { year: y, supplierName } },
        update,
        create: { year: y, supplierName, ...update },
      });
    }
    await app.audit(req, 'vendor-terms', `${year}: ${clean.length} terms`);
    return { ok: true, saved: clean.length };
  });

  app.delete('/api/vendor-terms/:year/:supplierName', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const gone = await prisma.vendorTerm.deleteMany({
      where: { year: Number(req.params.year), supplierName: decodeURIComponent(req.params.supplierName) },
    });
    if (!gone.count) return reply.code(404).send({ error: 'No such term.' });
    await app.audit(req, 'vendor-term-delete', `${req.params.year} ${req.params.supplierName}`);
    return { ok: true };
  });

  /* ---- aliases ---- */

  app.get('/api/aliases', { preHandler: app.requireUser }, async () =>
    prisma.identityAlias.findMany({ orderBy: [{ kind: 'asc' }, { scheduleName: 'asc' }] }));

  app.put('/api/aliases', { preHandler: requireWriter }, async (req, reply) => {
    const stop = guard(req, reply); if (stop) return stop;
    const list = Array.isArray(req.body) ? req.body : (req.body && req.body.aliases);
    if (!Array.isArray(list)) return reply.code(400).send({ error: 'Send an array of aliases.' });

    for (const a of list) {
      if (!a.kind || !a.scheduleName || !a.odooName) {
        return reply.code(400).send({ error: 'Each alias needs kind, scheduleName and odooName.' });
      }
      await prisma.identityAlias.upsert({
        where: { kind_scheduleName: { kind: a.kind, scheduleName: a.scheduleName } },
        update: { odooName: a.odooName, odooId: a.odooId ?? null },
        create: { kind: a.kind, scheduleName: a.scheduleName, odooName: a.odooName, odooId: a.odooId ?? null },
      });
    }
    await app.audit(req, 'aliases-upsert', `${list.length} entries`);
    return { ok: true, saved: list.length };
  });

  app.get('/api/audit', { preHandler: app.requireUser }, async (req) =>
    prisma.auditEvent.findMany({ orderBy: { at: 'desc' }, take: Math.min(Number(req.query.limit) || 50, 200) }));
};

/**
 * The invariant the original report could not satisfy.
 *
 * ONE COPY, and it lives in `public/draft.js` so the Admin editor runs THIS
 * function rather than its own reading of the same rules. It had its own, and
 * the two disagreed: the editor did not check head count at all and skipped
 * doctors marked "no sales" when summing a group, so it could show a balanced
 * ledger and an enabled Publish button for a sheet this route refuses. The
 * failure mode was an error dialog after the click, on work already typed in.
 *
 * Still exported under this name: the round-trip test asserts that a sheet
 * built from an exported template satisfies the very validator the publish
 * route enforces, and that is the point of the indirection, not a detour
 * around it.
 */
const validate = (b) => require('../../public/draft.js').problems(b);

const daysIn = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/* Exported so the round-trip test can assert that a sheet built from an exported
   template satisfies the very same rule this route enforces, rather than a
   second copy of it that could drift. */
module.exports.validate = validate;
