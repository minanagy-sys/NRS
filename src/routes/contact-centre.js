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
