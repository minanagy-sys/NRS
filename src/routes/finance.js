/* The finance page: collections, payables, sold-vs-issued and expiry risk. */

const fs = require('fs');
const path = require('path');
const Finance = require('../lib/finance.js');
const { iso } = require('../lib/rules.js');

const VIEW = path.join(__dirname, '..', 'views', 'finance.html');
const SIGNIN = path.join(__dirname, '..', 'views', 'signin.html');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

module.exports = async function (app) {
  app.get('/finance', async (req, reply) =>
    reply.type('text/html').send(fs.readFileSync(req.user ? VIEW : SIGNIN, 'utf8')));

  app.get('/api/finance', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    /* The default window is what the loaded data covers, not the current month:
       the finance snapshot is a fixed ten days, so defaulting to "today" would
       open on an empty page. The expiry as-of date defaults to the day its batch
       speaks for, which is what makes the day counts reproduce the source. */
    const covered = await coveredRange();
    const from = isDate(req.query.from) ? req.query.from : covered.from;
    const to = isDate(req.query.to) ? req.query.to : covered.to;
    if (from > to) return reply.code(400).send({ error: '"From" is after "To".' });

    const sections = String(req.query.sections || '').split(',').filter(Boolean);
    return Finance.buildFinance({
      from, to,
      asOf: isDate(req.query.asOf) ? req.query.asOf : (covered.asOf || iso(new Date())),
      sections: sections.length ? sections : undefined,
    });
  });
};

/** What the loaded data actually covers, so the page opens on something. */
async function coveredRange() {
  const { prisma } = require('../lib/db.js');
  const [span, batch] = await Promise.all([
    prisma.collection.aggregate({ _min: { date: true }, _max: { date: true } }),
    prisma.financeBatch.findFirst({ where: { section: 'expiry' }, orderBy: { importedAt: 'desc' } }),
  ]);
  const ymd = (d) => (d ? d.toISOString().slice(0, 10) : null);
  const today = iso(new Date());
  return {
    from: ymd(span._min.date) || `${today.slice(0, 7)}-01`,
    to: ymd(span._max.date) || today,
    asOf: batch ? ymd(batch.asOf) : null,
  };
}
