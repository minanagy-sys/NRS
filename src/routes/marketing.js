/* Report 03 — Marketing.
 *
 * Same shape as routes/commercial.js: one HTML GET with the signed-out fallback
 * baked in, and one /api behind requireUser.
 *
 * ONE endpoint rather than six. Every panel on this report reads the same range
 * and the same entity scope, the six builders together are a handful of indexed
 * aggregates, and six endpoints would mean six chances for two panels to be
 * looking at different windows — which is precisely the bug class this report is
 * about. The payload is assembled once and the page renders tabs from it.
 */

const fs = require('fs');
const path = require('path');
const M = require('../lib/marketing.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/* The three the control bar offers. Anything else is treated as "all" rather
   than as an error: a scope is a view, and a typo in a query string should not
   turn a report into a 400. */
const SCOPES = new Set(['all', 'Nouvel Age', 'ZAT']);

module.exports = async function (app) {
  app.get('/marketing', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? view('marketing') : SIGNIN, 'utf8')));

  app.get('/api/marketing', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    const scope = SCOPES.has(req.query.scope) ? req.query.scope : 'all';

    /* Run together: they touch different tables and none depends on another's
       result, so the page waits for the slowest rather than for the sum. */
    const [paid, campaigns, ads, doctors, leads, social, provenance] = await Promise.all([
      M.buildPaid({ from, to, scope }),
      M.buildCampaigns({ from, to, scope }),
      M.buildAds({ from, to, scope }),
      M.buildDoctors({ from, to, scope }),
      M.buildLeadQuality({ from, to, scope }),
      M.buildSocial({ from, to, scope }),
      M.buildProvenance({ from, to }),
    ]);

    return {
      from, to, scope,
      paid, campaigns, ads, doctors, leads, social, provenance,
      /* Which entity each account belongs to, shipped so the page can label a
         row rather than re-deriving a mapping it would then own a second copy
         of. */
      entities: { accounts: M.ENTITY_BY_ACCOUNT, profiles: M.ENTITY_BY_PROFILE },
    };
  });
};
