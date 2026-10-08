/* Report 02 — Contact Centre.
 *
 * Same shape as the other report routes: one HTML GET with the signed-out
 * fallback, one /api behind requireUser.
 *
 * The unusual thing about this report is that it answers from THREE frozen
 * snapshots with different windows — the phones for 1–18 August, the CRM for
 * September, the appointments reaching forward to 10 October — and none of them
 * is the range the reader picked. The payload therefore carries `coverage` and
 * `ccCoverage` at the top level and a `window` on every section, so each panel
 * states which window it is describing instead of presenting one range and
 * meaning another.
 *
 * ONE WRITE LIVES HERE: the extension map. It is the only thing on this report
 * anybody edits, and it is what lets the agents table print a name — the phone
 * export carries a first name and no Odoo employee at all. Behind requireWriter
 * and the X-Requested-With guard, like every other write in this project.
 */

const fs = require('fs');
const path = require('path');
const CC = require('../lib/contact-centre.js');
const Gate2 = require('../lib/cc-gate.js');
const UCM = require('../lib/ucm-cdr.js');
const CcBootstrap = require('../lib/cc-bootstrap.js');
const Mcp = require('../lib/mcp.js');
const Gate = require('../lib/admin-gate.js');
const { prisma } = require('../lib/db.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const SCOPES = new Set(['all', 'Nouvel Age', 'ZAT']);
const TEAMS = new Set(['cc', 'branch', 'other']);

const guard = (req, reply) =>
  req.headers['x-requested-with'] === 'fetch' ? null : reply.code(403).send({ error: 'Missing X-Requested-With.' });

const str = (v, label, max = 120) => {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw new Error(`${label} is too long (limit ${max}).`);
  return s;
};

module.exports = async function (app) {
  app.get('/contact-centre', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? view('contact-centre') : SIGNIN, 'utf8')));

  app.get('/api/contact-centre', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });
    const scope = SCOPES.has(req.query.scope) ? req.query.scope : 'all';

    /* THE WEEKLY LOCK. Checked before a single figure is computed, and when it
       is shut the response carries NO figures at all — a modal over data the
       browser already holds is a suggestion, not a lock. 423 Locked rather than
       403: nothing is wrong with who is asking, only with what has not arrived
       yet. `canUpload` tells the page which of two messages to show. */
    if (app.config.contactCentreGate !== false) {
      const gate = await Gate2.state();
      if (gate.locked) {
        return reply.code(423).send({ locked: true, gate, canUpload: !!(req.user && req.user.canWrite) });
      }
    }

    return CC.build({ from, to, scope, today });
  });

  /* What the lock is waiting for. Read by the page's lock screen and by Admin. */
  app.get('/api/contact-centre/gate', { preHandler: app.requireUser }, async (req) => ({
    ...(await Gate2.state()),
    enforced: app.config.contactCentreGate !== false,
    canUpload: !!(req.user && req.user.canWrite),
  }));

  /* ---------- the weekly UCM upload ---------- */

  /* A week of CDR legs is around 10,000 rows — two to three megabytes once it is
     base64 inside JSON, past Fastify's 1 MB default. 25 MB is a month with room,
     and sheet.js refuses past its own row limit long before that. */
  const UPLOAD = { preHandler: [app.requireUser, Gate.requireWriter(app)], bodyLimit: 25 * 1024 * 1024 };

  const readUpload = (req) => {
    const b = req.body || {};
    if (!b.base64) throw new Error('Send the file as base64.');
    return { buffer: Buffer.from(String(b.base64), 'base64'), filename: str(b.filename, 'File name', 200) || null };
  };

  /** What the file holds and whether it would open the report. Writes nothing. */
  app.post('/api/ucm/preview', UPLOAD, async (req, reply) => {
    if (guard(req, reply)) return reply;
    try {
      const { buffer } = readUpload(req);
      const parsed = UCM.parse(buffer);
      const gate = await Gate2.state();
      return { ...UCM.summarize(parsed, gate.week), gate };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * Store it. Re-parses rather than trusting a preview the browser sends back:
   * what is written is what the server read, not what a client claims it read.
   */
  app.post('/api/ucm/import', UPLOAD, async (req, reply) => {
    if (guard(req, reply)) return reply;
    let parsed;
    let filename;
    try {
      ({ filename } = readUpload(req));
      parsed = UCM.parse(readUpload(req).buffer);
      if (!parsed.calls.length) throw new Error('No inbound or outbound calls in this file.');
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    const out = await UCM.commit(parsed, { filename, actor: (req.user && (req.user.email || req.user.subject)) || null });
    await app.audit(req, 'ucm-upload', `${filename || 'file'}: ${out.calls} calls, weeks ${out.weeks.join(', ')}`);
    return { ...out, gate: await Gate2.state() };
  });

  /* ---------- the ported dashboard ----------
     The page runs the standalone Contact Centre dashboard's own script
     unchanged (public/cc-dash.js). These three endpoints are what that script
     reaches for, mapped onto this project's tables. See public/cc-shim.js. */

  /** `DATA`, `APPT` and `CRM` — the three constants the script opens expecting. */
  app.get('/api/cc/bootstrap', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async () => CcBootstrap.build());

  /**
   * The phone data, in the shape the script's store adapter reads.
   *
   * The script keeps this in a document store: `ucm_weeks`, `ucm_calls` and an
   * extension map. Here it is `PbxCall` and `PbxExtension`, which is why the
   * shim serves a store rather than letting the script fall back to its own
   * in-memory one — that fallback accepts an upload and loses it on reload.
   */
  app.get('/api/cc/ucm', { preHandler: app.requireUser }, async () => {
    const [calls, weeks, ext] = await Promise.all([
      prisma.pbxCall.findMany({ orderBy: [{ date: 'asc' }, { hour: 'asc' }] }),
      prisma.dataUpload.findMany({ where: { kind: 'ucm:upload' }, orderBy: { id: 'asc' } }),
      prisma.pbxExtension.findMany({ orderBy: { ext: 'asc' } }),
    ]);

    /* One row per week, built from the calls themselves rather than from the
       upload log: the gate asks how far the stored calls actually reach, and
       an upload that was accepted but wrote a short week would otherwise
       report the week it was filed under.

       `end` IS THE WEEK'S LAST DAY, `last` IS THE LAST DAY WITH CALLS, and
       they are deliberately not the same field. The page prints
       "start → end" and appends "(calls to <last>)" only when `last` falls
       short of `end` — so collapsing the two would make a week that stopped on
       Thursday render as a complete week ending Thursday, which is precisely
       the gap the caption exists to show. The gate reads `last` for the same
       reason. */
    const addDays = (s, n) => {
      const d = new Date(`${s}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const byWeek = new Map();
    for (const c of calls) {
      const id = iso(c.weekStart);
      const w = byWeek.get(id) || { id, start: id, end: addDays(id, 6), last: id, inbound: 0, outbound: 0 };
      const d = iso(c.date);
      if (d > w.last) w.last = d;
      if (c.direction === 1) w.inbound += 1; else w.outbound += 1;
      byWeek.set(id, w);
    }
    /* Which upload a week came from, matched by overlap rather than by start
       date: an upload's range runs from its first CALL to its last, so a file
       covering three weeks starts inside only one of them, and a file that
       happens to begin mid-week starts inside none. The latest overlapping
       upload wins, because a week re-uploaded is replaced whole. */
    for (const w of byWeek.values()) {
      const u = weeks.filter((x) => x.rangeFrom && x.rangeTo
        && iso(x.rangeFrom) <= w.last && iso(x.rangeTo) >= w.start).pop();
      if (u) { w.file = u.filename || ''; w.uploadedAt = u.createdAt; }
    }

    return {
      weeks: [...byWeek.values()],
      /* The ten columns of PbxCall are the script's call tuple, in order. */
      calls: calls.map((c) => [
        iso(c.date), c.hour, c.direction, c.ext, c.answered ? 1 : 0,
        c.waitSec, c.talkSec, c.phoneHash || '', c.queue, c.status,
      ]),
      ext: ext.map((e) => [e.ext, e.phoneName || '', e.odooEmployee || '', e.team || 'other', e.branch || '']),
    };
  });

  /**
   * The script's live Odoo pull, proxied.
   *
   * It calls `odoo_search_records` through the MCP and reads `payload.records`.
   * Only that one tool is forwarded, and only with the caller's own token — a
   * general "run any MCP tool" endpoint behind a session cookie is a much
   * larger thing to expose than this page needs.
   */
  app.post('/api/cc/odoo', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const token = req.user && req.user.token;
    if (!token) return reply.code(401).send({ error: 'Sign in again to pull from Odoo.' });
    const b = req.body || {};
    if (b.tool && b.tool !== 'odoo_search_records') {
      return reply.code(400).send({ error: `Only odoo_search_records is forwarded, not ${b.tool}.` });
    }
    try {
      const session = await Mcp.connect({ base: process.env.MCP_BASE_URL, token });
      const payload = await session.callTool('odoo_search_records', {
        model: str(b.model, 'Model', 80),
        domain: Array.isArray(b.domain) ? b.domain : [],
        fields: Array.isArray(b.fields) ? b.fields : [],
        limit: Math.min(Number(b.limit) || 2000, 2000),
        offset: Number(b.offset) || 0,
        order: str(b.order, 'Order', 60) || 'id asc',
      });
      return { payload };
    } catch (e) {
      /* The script shows whatever message comes back, so the layer that failed
         is named rather than flattened into "could not pull". */
      return reply.code(e.kind === 'odoo' ? 502 : 503).send({ error: e.message, kind: e.kind || 'mcp' });
    }
  });

  /* ---------- the extension map ---------- */

  app.get('/api/pbx/extensions', { preHandler: app.requireUser }, async () => {
    const [raw, cdr] = await Promise.all([
      prisma.pbxExtension.findMany({ orderBy: { ext: 'asc' } }),
      /* The name the PHONE SYSTEM has for each extension, so the editor can show
         the two side by side. Without it a disagreement is invisible: the map
         looks perfectly consistent with itself. */
      prisma.pbxAgentDay.findMany({
        where: { date: null }, select: { ext: true, agentName: true },
      }),
    ]);
    const cdrBy = new Map(cdr.map((c) => [c.ext, c.agentName]));
    const rows = raw.map((r) => ({ ...r, cdrName: cdrBy.get(r.ext) || null }));
    /* The Odoo employee list the editor picks from, so a name is CHOSEN rather
       than typed — a typo here silently unmaps an extension. */
    const employees = await prisma.ccEmployee.findMany({
      where: { active: true }, select: { name: true, department: true }, orderBy: { name: 'asc' },
    });
    return { rows, employees, teams: [...TEAMS] };
  });

  /**
   * Save the map.
   *
   * Replaces the rows it is given and leaves the rest alone, so two people
   * editing different extensions do not overwrite each other. An extension not
   * already in the map is rejected rather than created: the list comes from the
   * phone system, and inventing one here would produce a row no call ever
   * matches.
   */
  app.put('/api/pbx/extensions', { preHandler: [app.requireUser, Gate.requireWriter(app)] }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return reply.code(400).send({ error: 'Nothing to save.' });
    if (rows.length > 200) return reply.code(400).send({ error: 'Too many rows in one save.' });

    const known = new Set((await prisma.pbxExtension.findMany({ select: { ext: true } })).map((e) => e.ext));
    const updates = [];
    try {
      for (const r of rows) {
        const ext = str(r.ext, 'Extension', 12);
        if (!ext) throw new Error('An extension number is missing.');
        if (!known.has(ext)) {
          throw new Error(`Extension ${ext} is not in the map. The list comes from the phone `
            + 'system export, so adding one here would create a row no call ever matches.');
        }
        const team = str(r.team, 'Team', 12) || 'other';
        if (!TEAMS.has(team)) throw new Error(`"${team}" is not one of ${[...TEAMS].join(', ')}.`);
        updates.push(prisma.pbxExtension.update({
          where: { ext },
          data: {
            phoneName: str(r.phoneName, 'Name on the phone'),
            odooEmployee: str(r.odooEmployee, 'Odoo employee'),
            team,
            branch: str(r.branch, 'Branch'),
            source: 'upload',
          },
        }));
      }
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }

    await prisma.$transaction(updates);
    await app.audit(req, 'pbx-extensions', `${updates.length} extension${updates.length === 1 ? '' : 's'}`);
    return { saved: updates.length };
  });
};
