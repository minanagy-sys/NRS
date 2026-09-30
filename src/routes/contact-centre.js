/* Report 02 — Contact Centre.
 *
 * Same shape as the other report routes: one HTML GET with the signed-out
 * fallback, one /api behind requireUser.
 *
 * The unusual thing about this report is that FOUR of its five tabs read a
 * frozen snapshot and one reads live Odoo. The payload therefore carries
 * `coverage` — the window the PBX seed actually holds — at the top level, so
 * every panel can state which of the two windows it is describing instead of
 * presenting one range and meaning another.
 */

const fs = require('fs');
const path = require('path');
const CC = require('../lib/contact-centre.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const SCOPES = new Set(['all', 'Nouvel Age', 'ZAT']);

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

    return CC.build({ from, to, scope });
  });
};
