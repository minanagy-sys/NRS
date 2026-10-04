/* ============================================================
   The weekly lock on the Contact Centre report.

   THE RULE, as Mina set it and as the source page enforced it: every Sunday
   the report locks for EVERYONE until last week's UCM export has been uploaded
   in Admin. Once it is, the report is open all week, until the next Sunday
   locks it again. The point is not access control — it is that the weekly
   upload actually happens, because a report nobody can open gets noticed in a
   way that a stale one does not.

   THE WEEK is Sunday to Saturday, Cairo time. The REQUIRED week is always the
   last complete one: on any day from Sunday 4 to Saturday 10 October it is
   Sunday 27 September → Saturday 3 October.

   "UPLOADED" means the same thing the source page meant: calls exist for that
   week AND the latest of them reaches at least the FRIDAY. One day of slack,
   because an export taken on Saturday afternoon is still the right file, and
   a lock that refuses it would only teach people to wait.

   DECIDED HERE, ENFORCED BY THE SERVER. The source page hid the report behind a
   modal while still loading every figure into the browser; anybody could close
   it from the console. Here the API refuses with 423 and sends no figures at
   all while the week is missing.

   NO SKIP. The source let the page's owner "skip for now" for themselves. Mina
   asked for nobody to see it until the file is in, so there is no bypass — the
   person who can open it is the person who uploads.
   ============================================================ */

const { prisma } = require('./db.js');
const { weekStartOf, addDays } = require('./ucm-cdr.js');

const iso = (d) => d.toISOString().slice(0, 10);
const D = (s) => new Date(`${s}T00:00:00Z`);

/** Today on the clinic's calendar, not the server's. The droplet runs UTC. */
function cairoToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(now);
}

/** The last complete Sunday–Saturday week before the one `today` is in. */
function requiredWeek(today) {
  const ws = weekStartOf(today);
  return { from: addDays(ws, -7), to: addDays(ws, -1) };
}

/**
 * Is the report open, and if not, why.
 *
 * `today` is injectable so a test can stand on any day of any week; the route
 * always passes Cairo's real today.
 */
async function state({ today = cairoToday() } = {}) {
  const week = requiredWeek(today);
  const [held, last] = await Promise.all([
    prisma.pbxCall.aggregate({
      where: { weekStart: D(week.from), source: 'upload' },
      _min: { date: true }, _max: { date: true }, _count: { _all: true },
    }),
    prisma.dataUpload.findFirst({ where: { kind: 'ucm:upload' }, orderBy: { createdAt: 'desc' } }),
  ]);
  const n = held._count._all;
  const first = n ? iso(held._min.date) : null;
  const lastDay = n ? iso(held._max.date) : null;
  const friday = addDays(week.to, -1);
  const open = n > 0 && lastDay >= friday;

  let reason = null;
  if (!n) reason = 'missing';
  else if (!open) reason = 'short';

  return {
    locked: !open,
    today,
    week,
    /* What IS held for that week, so a short upload can be told apart from a
       missing one — "it stops on Wednesday" is a different instruction from
       "nobody uploaded it". */
    held: n ? { calls: n, first, last: lastDay } : null,
    needsUntil: friday,
    reason,
    lastUpload: last ? {
      at: last.createdAt,
      filename: last.filename,
      from: last.rangeFrom ? iso(last.rangeFrom) : null,
      to: last.rangeTo ? iso(last.rangeTo) : null,
    } : null,
    /* The day it locks again, so the Admin screen can say "open until …". */
    locksAgain: addDays(weekStartOf(today), 7),
  };
}

module.exports = { state, requiredWeek, cairoToday };
