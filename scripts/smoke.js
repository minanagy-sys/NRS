#!/usr/bin/env node
/**
 * Smoke test: every page and every API, as a SIGNED-IN user.
 *
 *   node scripts/smoke.js
 *
 * `npm test` proves the libraries and the page rendering, but neither touches
 * Fastify — so a broken route registration, a bad destructure in a handler or a
 * missing import passes the whole suite and only shows up in the browser. This
 * builds the real app and injects real requests through it.
 *
 * It signs in by adding a preHandler that fills `req.user`, rather than reading
 * a session token out of the database. `requireUser` only checks `req.user`, and
 * global preHandlers run before route-level ones, so this is the same code path
 * a cookie would take without handling anybody's credentials.
 *
 * It does NOT need the dev server running — it builds its own instance. So it
 * also answers the other question worth asking first: is the page broken, or is
 * nothing listening on 3020?
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));
process.chdir(ROOT);
const { build } = require(path.join(ROOT, 'src', 'server.js'));
const { prisma } = require(path.join(ROOT, 'src', 'lib', 'db.js'));

(async () => {
  const app = await build();
  app.log.level = 'silent';
  /* requireUser only checks req.user, which a global preHandler fills from the
     `sid` cookie. Global preHandlers run before route-level ones, so adding one
     here signs the probe in without touching a real session token. */
  app.addHook('preHandler', async (req) => {
    if (!req.user) req.user = { subject: 'probe', email: 'probe@local', name: 'probe' };
  });

  /* The pages too — a signed-in navigation must return the report, not signin. */
  /* Every live report. `/commission` was missing until 2026-10-04 — the page
     shipped and was never loaded here. */
  for (const u of ['/', '/targets', '/commission', '/commercial', '/commercial-sales', '/marketing', '/contact-centre', '/doctors', '/inventory', '/procurement', '/admin']) {
    const res = await app.inject({ method: 'GET', url: u });
    const title = (res.payload.match(/<title>([^<]*)<\/title>/) || [])[1] || '(none)';
    const tabs = (res.payload.match(/data-panel="/g) || []).length;
    const stamped = /\/assets\/[^"?]+\?v=/.test(res.payload);
    console.log(`  ${res.statusCode}  ${u.padEnd(20)} "${title}"  ${tabs} tabs  assets-stamped:${stamped}`);
  }
  console.log('');

  const urls = [
    '/api/commercial-sales?from=2026-08-01&to=2026-08-19',
    '/api/commercial-sales?from=2026-01-01&to=2026-09-03',
    '/api/targets-tracker?from=2026-08-01&to=2026-08-19',
    '/api/commercial-funnel?from=2026-08-01&to=2026-08-19',
    '/api/patients?from=2026-08-01&to=2026-08-19',
    '/api/report?from=2026-08-01&to=2026-08-19',
    /* Report 03, three ways: the source pack's own window, a range whose lead
       half is older than Meta's 90-day retention, and one entity scope — the
       scope here is an ad-account filter in SQL rather than a client-side
       repaint, so it is a distinct code path worth probing. */
    '/api/marketing?from=2026-08-01&to=2026-08-19',
    '/api/marketing?from=2025-06-01&to=2026-09-04',
    '/api/marketing?from=2026-08-01&to=2026-08-19&scope=ZAT',
    /* Report 02, four ways. It answers from three frozen snapshots with
       different windows, so each of these exercises a different combination:
       the PBX pack's window (phones full, CRM absent), the CRM window (the
       reverse), a range NEITHER reaches (every panel must refuse rather than
       answer zero), and one entity scope. */
    '/api/contact-centre?from=2026-08-01&to=2026-08-19',
    '/api/contact-centre?from=2026-09-01&to=2026-10-10',
    '/api/contact-centre?from=2025-01-01&to=2025-01-31',
    '/api/contact-centre?from=2026-08-01&to=2026-08-19&scope=ZAT',
    /* The extension map — what turns a call into a person. */
    '/api/pbx/extensions',
    /* What the weekly lock is waiting for. Always 200, locked or not. */
    '/api/contact-centre/gate',
    /* The uploads tab reads this to show what is held and what has been loaded. */
    '/api/uploads',
    /* The schemes behind every payslip, and the doctors on them. Admin draws
       three sections from this one answer; a 404 here is a Commission tab that
       renders its "could not load" branch and looks merely empty. */
    '/api/schemes',
    /* The plan: 2027 targets, the v3.2 pool grid and the frozen history. The
       Admin editor and the plan panels both read it, and it is the one endpoint
       with an ETag — a 500 here is a Periods tab that renders half. */
    '/api/targets-plan',
    /* The v3.2 policy the Commission tab edits. A 500 here is an Admin tab that
       renders its "could not load" branch and looks merely empty. */
    '/api/policy/v32',
    /* The Live panel and its lazy breakdown. The collected figure here must
       equal the Commission report's net collection — the audit asserts it. */
    '/api/targets-live?from=2026-08-01&to=2026-08-31',
    '/api/targets-live-branch?name=CFC&from=2026-08-01&to=2026-08-31',
    '/api/targets-actuals?year=2026',
    /* What everyone earns, on the v3.2 pool grid. */
    '/api/commission-month?from=2026-08-01&to=2026-08-31',
    /* Doctors Performance, two ways: a month with a target sheet and one
       without, since the targets tab takes a different path for each. */
    '/api/doctors?from=2026-08-01&to=2026-08-31',
    '/api/doctors?from=2026-09-01&to=2026-09-08',
    '/api/inventory?from=2026-08-01&to=2026-08-27',
    /* A window with no stock snapshot in it at all — the case that must refuse
       rather than draw zeros. */
    '/api/inventory?from=2026-01-01&to=2026-01-31',
    '/api/procurement?from=2026-01-01&to=2026-08-31',
    '/api/procurement/product/40012?from=2026-01-01&to=2026-08-31',
  ];
  let bad = 0;
  for (const u of urls) {
    const t = Date.now();
    const res = await app.inject({ method: 'GET', url: u, headers: { 'X-Requested-With': 'fetch' } });
    const ms = Date.now() - t;
    let note = '';
    if (res.statusCode === 200) {
      try {
        const j = res.json();
        note = j.error ? `error: ${j.error}` : `${(res.payload.length / 1024).toFixed(0)} KB · keys: ${Object.keys(j).slice(0, 6).join(',')}`;
        if (j.error) bad++;
      } catch (e) { note = `unparseable: ${e.message}`; bad++; }
    } else if (res.statusCode === 423 && u.startsWith('/api/contact-centre?')) {
      /* THE WEEKLY LOCK, working as designed: last week's UCM export is not in,
         so report 02 is closed for everybody. A pass ONLY if it is a well-formed
         lock — it names the week it is waiting for and carries NO figures. A
         423 that leaks a payload, or one that cannot say which week, is a
         failure. The audit checks the figures themselves with the lock off. */
      let j = null;
      try { j = res.json(); } catch { /* fall through to bad */ }
      const leaks = j && ['summary', 'phones', 'crm', 'appointments'].some((k) => k in j);
      if (j && j.locked && j.gate && j.gate.week && j.gate.week.from && !leaks) {
        note = `locked — waiting for ${j.gate.week.from} → ${j.gate.week.to} (${j.gate.reason}); no figures sent`;
      } else {
        bad++;
        note = `malformed lock: ${res.payload.slice(0, 200)}`;
      }
    } else {
      bad++;
      note = res.payload.slice(0, 300);
    }
    console.log(`  ${res.statusCode}  ${String(ms).padStart(5)}ms  ${u.split('?')[0].padEnd(26)} ${note}`);
  }
  /* ---------------------------------------------------------------------
     AND THEN THE SERVER THAT IS ACTUALLY RUNNING.

     Everything above builds its own Fastify instance, which is what makes it
     fast and independent — and is also how a real 404 got past the whole suite:
     the dev server on 3020 had been started before two routes existed, so
     `/contact-centre` and `/api/uploads` were 404 in the browser while every
     check here passed. A stale process is invisible to a test that does not
     look at it.

     So if something IS listening on the port, every route is probed there too.
     A 401 is a pass — the route exists and wants a session. Only a 404 means
     the running process does not know about it. Nothing is listening in CI, and
     then this section simply says so.
     --------------------------------------------------------------------- */
  const PORT = Number(process.env.PORT || 3020);
  const ROUTES = [
    '/', '/commercial-sales', '/targets', '/commission', '/commercial', '/marketing', '/contact-centre', '/doctors',
    '/inventory', '/procurement',
    '/api/report', '/api/commercial-sales', '/api/targets-tracker', '/api/commercial-funnel',
    '/api/patients', '/api/marketing', '/api/contact-centre', '/api/uploads', '/api/doctors',
    '/api/inventory', '/api/procurement', '/api/schemes', '/api/targets-plan', '/api/policy/v32', '/api/targets-live', '/api/targets-actuals', '/api/commission-month',
    '/api/pbx/extensions',
  ];
  let stale = 0, reachable = true;
  console.log(`  the running server on :${PORT}`);
  for (const u of ROUTES) {
    let code;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${u}`, {
        headers: { 'X-Requested-With': 'fetch' }, redirect: 'manual',
      });
      code = res.status;
    } catch {
      reachable = false;
      break;
    }
    if (code === 404) { stale++; bad++; console.log(`    \x1b[31m404 ${u} — the running process does not have this route\x1b[0m`); }
  }
  if (!reachable) {
    console.log(`    nothing listening on :${PORT} — skipped (start it with the dev server)`);
  } else if (stale) {
    console.log(`\n    \x1b[31m${stale} route(s) 404 on the running server though they exist in the code.\x1b[0m`);
    console.log('    Restart it: the config runs `node --watch`, so a restart is only needed');
    console.log('    if it was started some other way.');
  } else {
    console.log(`    all ${ROUTES.length} routes exist on the running process`);
  }
  console.log('');

  console.log(bad ? `\n  ${bad} endpoint(s) failed\n`
    : '\n  all endpoints answered with a usable payload (report 02 may be legitimately locked — see above)\n');
  await app.close();
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✗', e.stack, '\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
