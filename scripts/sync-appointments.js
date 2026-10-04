#!/usr/bin/env node
/**
 * Pull bookings from Odoo 18 into the Appointment table.
 *
 *   node scripts/sync-appointments.js                            # this month so far
 *   node scripts/sync-appointments.js --from 2026-08-01 --to 2026-08-19
 *   node scripts/sync-appointments.js --from 2026-08-01 --to 2026-08-19 --states
 *
 * `--states` prints the full state breakdown, which is worth reading once: the
 * attendance figure everybody quotes is only as good as the mapping in
 * src/lib/appointments.js, and that mapping is a judgement about eleven Odoo
 * states, not a fact.
 *
 * The thing to know before trusting any show rate out of this: on 1–19 Aug,
 * 1,773 of 7,655 bookings have no outcome at all — still `pending` weeks after
 * the date. They are not "did not attend", so this reports two denominators and
 * says which is which rather than picking the flattering one.
 */

process.loadEnvFile(require('path').join(__dirname, '..', '.env'));

const { syncAppointments } = require('../src/lib/sync.js');
const { prisma } = require('../src/lib/db.js');
const A = require('../src/lib/appointments.js');

const iso = (d) => d.toISOString().slice(0, 10);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const f = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');
const pct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;

async function token() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const user = process.env.MCP_USER, password = process.env.MCP_PASSWORD;
  if (!user || !password) throw new Error('Set MCP_TOKEN, or MCP_USER and MCP_PASSWORD.');
  const { loginWithPassword } = require('../src/lib/oauth-password.js');
  const { token: t } = await loginWithPassword({ base: process.env.MCP_BASE_URL, user, password });
  return t;
}

(async () => {
  const today = iso(new Date());
  /* FORWARD BOOKINGS. `to` used to default to today, so the cache held nothing
     after this morning — and a confirmation-call report is ENTIRELY about the
     bookings that have not happened yet. Measured on 2026-10-04: the Appointment
     table had 0 of the 670 bookings already made for 5–10 October, while every
     past day reconciled exactly (325 = 325, 374 = 374, 400 = 400). The whole
     gap was the future.
     45 days matches the look-ahead the contact-centre snapshot itself uses when
     it matches a patient to a visit. Pass --ahead 0 for the old behaviour. */
  const ahead = Number(arg('ahead', 45));
  if (!Number.isFinite(ahead) || ahead < 0 || ahead > 365) {
    throw new Error('--ahead must be a whole number of days between 0 and 365.');
  }
  const horizon = iso(new Date(Date.now() + ahead * 86400000));
  const to = arg('to', horizon);
  const from = arg('from', `${today.slice(0, 7)}-01`);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) throw new Error('Dates must be YYYY-MM-DD.');
  if (from > to) throw new Error('"from" is after "to".');

  console.log(`\n\x1b[1mSyncing bookings · ${from} to ${to}\x1b[0m`);
  if (to > today) console.log(`  including ${ahead} days ahead — bookings not yet due\n`);
  const out = await syncAppointments({ token: await token(), from, to });

  console.log(`\n  ${f(out.found)} bookings found · ${f(out.written)} rows written across ${out.branches} branches\n`);
  console.log(`    attended   ${f(out.attended).padStart(7)}   ${pct(out.attended / (out.found || 1))} of all bookings`);
  console.log(`    lost       ${f(out.lost).padStart(7)}   cancelled or rescheduled`);
  console.log(`    open       ${f(out.open).padStart(7)}   no outcome recorded`);

  const funnel = await A.buildFunnel({ from, to });
  console.log(`\n  show rate  \x1b[1m${pct(funnel.showRate)}\x1b[0m on every booking`
    + `   ·   \x1b[1m${pct(funnel.showRateResolved)}\x1b[0m on resolved bookings only`);
  if (out.open) {
    console.log(`  the gap is the ${f(out.open)} open bookings — ${pct(out.open / (out.found || 1))} of the window`
      + ' has no outcome, so the true rate sits between the two.');
  }
  if (funnel.showRate < A.POLICY_FLOOR) {
    console.log(`  \x1b[33mboth are under the ${pct(A.POLICY_FLOOR)} the commission policy assumes.\x1b[0m`);
  }

  if (arg('states', false)) {
    console.log('\n  state breakdown:');
    for (const s of funnel.states) {
      console.log(`    ${s.state.padEnd(28)} ${String(s.count).padStart(6)}  ${pct(s.count / (out.found || 1)).padStart(6)}  → ${A.group(s.state)}`);
    }
    if (funnel.cancelReasons.length) {
      console.log('\n  cancel reasons:');
      for (const r of funnel.cancelReasons) console.log(`    ${(r.reason || '—').padEnd(28)} ${String(r.count).padStart(6)}`);
    }
  }

  if (out.withoutMobile) {
    console.log(`\n  \x1b[33m${f(out.withoutMobile)} booking${out.withoutMobile === 1 ? '' : 's'} with no usable mobile`
      + ` — ${pct(out.withoutMobile / (out.found || 1))} cannot be joined to a patient, a lead or a call.\x1b[0m`);
  }
  console.log('');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`\n\x1b[31m✗ ${e.kind ? `[${e.kind}] ` : ''}${e.message}\x1b[0m\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
