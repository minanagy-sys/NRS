/* Report 09 — Procurement & Products.
 *
 * Two endpoints rather than one. The overview cuts are cheap and always wanted;
 * the per-product drill-down reads every purchase line and every invoice line
 * for one product and is only wanted when somebody opens a row. Loading all 101
 * of them up front would put the whole cube in the payload to answer a question
 * nobody asked yet.
 */

const fs = require('fs');
const path = require('path');
const Procurement = require('../lib/procurement.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

module.exports = async function (app) {
  app.get('/procurement', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? view('procurement') : SIGNIN, 'utf8')));

  const range = (req) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 4)}-01-01`;
    return { from, to };
  };

  app.get('/api/procurement', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { from, to } = range(req);
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });
    return Procurement.build({ from, to });
  });

  app.get('/api/procurement/product/:odooId', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const odooId = Number(req.params.odooId);
    if (!Number.isInteger(odooId) || odooId <= 0) {
      return reply.code(400).send({ error: 'Product id must be a positive integer.' });
    }
    const { from, to } = range(req);
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });
    const out = await Procurement.buildProduct({ from, to, odooId });
    return out.missing ? reply.code(404).send({ error: out.reason }) : out;
  });
};
