/* Doctors Performance — its own report.
 *
 * Same shape as routes/marketing.js and routes/contact-centre.js: one HTML GET
 * with the signed-out fallback, one /api behind requireUser.
 *
 * It began as tab 08 of the NRS report and was moved out at Mina's request. The
 * move matters for one figure: its targets section used to read the `targets`
 * object already in the NRS payload, and now it scores the sheet itself through
 * `Doctors.scoreTargets` — the SAME `Targets.score` with the SAME inputs. One
 * implementation invoked twice cannot disagree; two implementations would, and
 * `scripts/audit.js` compares the two pages to keep it that way.
 */

const fs = require('fs');
const path = require('path');
const Doctors = require('../lib/doctors.js');
const { iso } = require('../lib/rules.js');

const view = (name) => path.join(__dirname, '..', 'views', `${name}.html`);
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

module.exports = async function (app) {
  app.get('/doctors', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? view('doctors') : SIGNIN, 'utf8')));

  app.get('/api/doctors', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const today = iso(new Date());
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    return Doctors.build({ from, to });
  });
};
