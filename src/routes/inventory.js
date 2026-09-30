/* Report 08 — Inventory Performance.
 *
 * Same shape as routes/doctors.js: one HTML GET with the signed-out fallback,
 * one /api behind requireUser.
 */

const fs = require('fs');
const path = require('path');
const Inventory = require('../lib/inventory.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

module.exports = async function (app) {
  app.get('/inventory', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? view('inventory') : SIGNIN, 'utf8')));

  app.get('/api/inventory', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    return Inventory.build({ from, to });
  });
};
