/* Report — Performance KPIs.
 *
 * Same shape as the other report routes: one HTML GET with the signed-out
 * fallback, the rest behind requireUser.
 *
 * THIS REPORT HOLDS NO DATA OF ITS OWN. Every figure on it is a live Odoo
 * call made while the page is open — there is no cache table behind it and
 * nothing to sync. What IS stored is the handful of thresholds somebody set:
 * where each KPI stood when it was measured, what counts as fully met, and the
 * commission ladder beside it. Those are the only writes here.
 *
 * The page runs the standalone dashboard's own script unchanged
 * (public/kpi-dash.js); see public/kpi-shim.js for what is mapped onto what.
 */

const fs = require('fs');
const path = require('path');
const Mcp = require('../lib/mcp.js');
const Gate = require('../lib/admin-gate.js');
const { prisma, num } = require('../lib/db.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');

const guard = (req, reply) =>
  req.headers['x-requested-with'] === 'fetch' ? null : reply.code(403).send({ error: 'Missing X-Requested-With.' });

const str = (v, label, max = 400) => {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw new Error(`${label} is too long (limit ${max}).`);
  return s;
};

/** A finite number or null — never NaN, which would reach the page as `null` anyway. */
const fin = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* The Odoo methods /api/kpi/odoo may call: every one of them reads. */
const READ_METHODS = new Set([
  'read_group', 'search_count', 'search_read', 'read', 'search', 'fields_get', 'name_search',
]);

module.exports = async function (app) {
  app.get('/performance-kpis', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? view('performance-kpis') : SIGNIN, 'utf8')));

  /**
   * The saved thresholds, in the shape the script's own `#cfg` blob uses.
   *
   * Absent rows are simply left out rather than sent as nulls: the script
   * assigns over its built-in defaults field by field and skips anything
   * `null`, so an empty table means "use the defaults", which is what an
   * un-edited report should do.
   */
  app.get('/api/kpi/config', { preHandler: app.requireUser }, async () => {
    const [kpis, levels] = await Promise.all([
      prisma.kpiThreshold.findMany(),
      prisma.kpiLevel.findMany({ orderBy: { idx: 'asc' } }),
    ]);
    const out = {};
    if (kpis.length) {
      out.kpi = kpis.map((k) => {
        const row = { id: k.id };
        if (k.base != null) row.base = num(k.base);
        if (k.t100 != null) row.t100 = num(k.t100);
        if (k.why) row.why = k.why;
        return row;
      });
    }
    if (levels.length) {
      out.lev = levels.map((l) => ({
        n: l.name, ar: l.nameAr, t: l.scope, a: l.fromLabel, b: l.toLabel,
        v: num(l.value), k: l.kpiRef, d: l.detail,
      }));
    }
    return out;
  });

  /**
   * Save them. Behind the writer gate, like every other write in this project.
   *
   * Replaces both lists whole, because that is what the editor sends: it reads
   * every field off the page, so a partial merge would resurrect a value
   * somebody had just cleared.
   */
  app.put('/api/kpi/config', {
    preHandler: [app.requireUser, Gate.requireWriter(app)],
  }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const b = req.body || {};
    const kpi = Array.isArray(b.kpi) ? b.kpi : [];
    const lev = Array.isArray(b.lev) ? b.lev : [];
    if (!kpi.length && !lev.length) return reply.code(400).send({ error: 'Nothing to save.' });
    if (kpi.length > 50 || lev.length > 50) return reply.code(400).send({ error: 'Too many rows in one save.' });

    let writes;
    try {
      writes = [
        ...kpi.map((k) => {
          const id = str(k.id, 'KPI id', 40);
          if (!id) throw new Error('A KPI is missing its id.');
          const data = { base: fin(k.base), t100: fin(k.t100), why: str(k.why, 'Reason') || null };
          return prisma.kpiThreshold.upsert({ where: { id }, create: { id, ...data }, update: data });
        }),
        ...lev.map((l, idx) => {
          const data = {
            name: str(l.n, 'Name'), nameAr: str(l.ar, 'Arabic name'), scope: str(l.t, 'Scope', 40),
            fromLabel: str(l.a, 'Today'), toLabel: str(l.b, 'Target'),
            value: fin(l.v) || 0, kpiRef: str(l.k, 'KPI reference', 80), detail: str(l.d, 'Detail', 2000),
          };
          return prisma.kpiLevel.upsert({ where: { idx }, create: { idx, ...data }, update: data });
        }),
      ];
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }

    await prisma.$transaction(writes);
    await app.audit(req, 'kpi-config', `${kpi.length} KPI${kpi.length === 1 ? '' : 's'}, ${lev.length} level${lev.length === 1 ? '' : 's'}`);
    return { saved: writes.length };
  });

  /**
   * The report's Odoo calls, proxied.
   *
   * The script asks for `odoo_call_method` and reads `payload`. Only that one
   * tool is forwarded, and only with the caller's own token — the MCP refuses
   * write, create and unlink outright, so this cannot change anything in Odoo,
   * but a general "run any tool" endpoint behind a session cookie is still a
   * much larger thing to expose than this page needs.
   */
  app.post('/api/kpi/odoo', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const token = req.user && req.user.token;
    if (!token) return reply.code(401).send({ error: 'Sign in again to read from Odoo.' });
    const b = req.body || {};
    if (b.tool && b.tool !== 'odoo_call_method') {
      return reply.code(400).send({ error: `Only odoo_call_method is forwarded, not ${b.tool}.` });
    }
    /* READ METHODS ONLY. `odoo_call_method` runs whatever method it is
       given, and the MCP is verified to refuse write, create and unlink —
       nobody has verified it refuses the dozens of OTHER methods that change
       Odoo: action_post, action_cancel, button_cancel, message_post,
       action_archive, toggle_active, copy... This project only ever READS
       Odoo, so the allow-list is the guarantee rather than the MCP's goodwill.
       The KPI page itself uses read_group and search_count. (2026-10-07) */
    const method = str(b.method, 'Method', 60);
    if (!READ_METHODS.has(method)) {
      return reply.code(400).send({ error: `Only read methods are forwarded to Odoo, not ${method || '(none)'}.` });
    }
    try {
      const session = await Mcp.connect({ base: process.env.MCP_BASE_URL, token });
      const payload = await session.callKw(
        str(b.model, 'Model', 80),
        method,
        Array.isArray(b.args) ? b.args : [],
        b.kwargs && typeof b.kwargs === 'object' ? b.kwargs : {},
      );
      return { payload };
    } catch (e) {
      /* The script switches on `code`, so the shape it expects is preserved
         rather than flattened into one message. */
      return reply.code(e.kind === 'odoo' ? 502 : 503)
        .send({ error: e.message, code: e.kind === 'odoo' ? 'no_access' : 'server_unavailable' });
    }
  });
};
