#!/usr/bin/env node
/* ============================================================
   Nouvelage daily sales — web app.

   Sign-in is OAuth against the Nouvelage MCP, so no password ever reaches this
   process. Reports are served from Postgres, which a scheduled sync fills; the
   MCP is only touched by the sync itself.
   ============================================================ */

// Node loads .env natively — no dependency needed. Absent in production, where
// the environment is set properly.
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* not present */ }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Fastify = require('fastify');

const { prisma } = require('./lib/db.js');
const Auth = require('./lib/auth.js');

const PORT = Number(process.env.PORT || 3020);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const IS_HTTPS = PUBLIC_ORIGIN.startsWith('https://');

/**
 * @param {object} [opts]
 * @param {boolean} [opts.contactCentreGate=true] The weekly lock on report 02.
 *   ONLY settable in-process, never from a request or the environment: an env
 *   switch could be left on in a droplet's .env and quietly unlock the report
 *   for good. `scripts/audit.js` turns it off because it checks figures, not
 *   access — a Sunday with no upload would otherwise fail sixteen pinned report
 *   02 figures for a reason that has nothing to do with whether they are right.
 */
async function build({ contactCentreGate = true } = {}) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info', transport: undefined },
    trustProxy: true,
  });

  /* A DELETE carries no body, but a browser fetch may still announce JSON.
     Fastify rejects that by default; treat empty as {}. */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });

  await app.register(require('@fastify/cookie'));
  await app.register(require('@fastify/formbody'));

  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Fonts are self-hosted so the policy needs no external origins at all.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        /* Bar widths, progress fills and pace markers are inline style
           attributes computed from the data. Without this they are dropped and
           every bar renders empty. Attributes cannot execute script, and inline
           <style> blocks and all inline script stay forbidden. */
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        /* Helmet adds upgrade-insecure-requests by default. Over plain http it
           tells the browser to refetch every stylesheet and script from https,
           which on localhost has no listener — Safari therefore loaded the page
           and silently fetched none of its assets, rendering it unstyled while
           the server saw no requests at all. Chrome exempts localhost, which is
           why it only showed up in Safari. Send it only when we are on https. */
        upgradeInsecureRequests: IS_HTTPS ? [] : null,
      },
    },
    hsts: IS_HTTPS ? { maxAge: 15552000, includeSubDomains: true } : false,
  });

  await app.register(require('@fastify/rate-limit'), {
    global: false,
    max: 30,
    timeWindow: '1 minute',
  });

  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/assets/',
  });

  /* Every asset URL carries a stamp derived from the files themselves. Safari
     was reusing 404s it had cached from a window when the stylesheets were
     genuinely missing, and never revalidating them — the page rendered with no
     styling and the server saw no requests at all. A changed URL cannot match a
     stale cache entry, so editing any asset retires the old one everywhere.

     Pages themselves are never cached, so the new stamp always reaches the
     browser. */
  const assetStamp = stampOf(path.join(__dirname, '..', 'public'));
  app.log.info(`asset stamp ${assetStamp}`);

  app.addHook('onSend', async (req, reply, payload) => {
    const type = String(reply.getHeader('content-type') || '');
    if (!type.includes('text/html')) return payload;
    reply.header('Cache-Control', 'no-store, must-revalidate');
    if (typeof payload !== 'string') return payload;
    const stamped = payload.replace(/(href|src)="(\/assets\/[^"?]+)"/g, `$1="$2?v=${assetStamp}"`);
    reply.header('Content-Length', Buffer.byteLength(stamped));
    return stamped;
  });

  /* Every request knows who it is, if anyone. */
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    const sid = req.cookies.sid;
    if (!sid) return;
    const s = await Auth.currentSession(sid);
    if (s) req.user = s;
  });

  app.decorate('requireUser', async (req, reply) => {
    if (req.user) return;
    // An API call wants a status it can act on; only a page navigation should be
    // bounced to the login screen.
    const wantsJson = req.url.startsWith('/api/')
      || (req.headers.accept || '').includes('application/json');
    if (wantsJson) return reply.code(401).send({ error: 'Sign in first.' });
    return reply.redirect(`/auth/login?next=${encodeURIComponent(req.url)}`);
  });

  app.decorate('audit', (req, action, detail) =>
    prisma.auditEvent.create({
      data: { actor: req.user ? req.user.subject : null, action, detail: detail ? String(detail).slice(0, 500) : null, ip: req.ip },
    }).catch(() => {}));

  app.decorate('config', { PUBLIC_ORIGIN, IS_HTTPS, PORT, contactCentreGate });

  await app.register(require('./routes/auth.js'));
  await app.register(require('./routes/report.js'));
  /* The Finance report is HIDDEN as of 2026-08-19, at Mina's request. Nothing was
     deleted: src/routes/finance.js, src/lib/finance*.js, the views and all ~7,300
     rows of finance data are exactly as they were. Not registering the route is
     what makes /finance and /api/finance/* unreachable, so hiding the sidebar
     link alone would not have been enough — anyone could still type the URL.
     Put FINANCE_ENABLED=1 in .env to turn the whole thing back on. */
  if (process.env.FINANCE_ENABLED === '1') {
    await app.register(require('./routes/finance.js'));
    app.log.info('finance report enabled');
  }
  await app.register(require('./routes/commercial.js'));
  await app.register(require('./routes/marketing.js'));
  await app.register(require('./routes/contact-centre.js'));
  await app.register(require('./routes/doctors.js'));
  await app.register(require('./routes/performance-kpis.js'));
  await app.register(require('./routes/inventory.js'));
  await app.register(require('./routes/procurement.js'));
  await app.register(require('./routes/commission.js'));
  await app.register(require('./routes/admin.js'));

  app.setNotFoundHandler((req, reply) => reply.code(404).type('text/plain').send('Not found'));

  return app;
}

if (require.main === module) {
  build()
    .then(async (app) => {
      /* Behind nginx/Caddy on a droplet, listening on every interface leaves
         http://<ip>:PORT reachable in the clear, bypassing TLS. Default to
         loopback and let a managed platform, which needs 0.0.0.0, opt in. */
      const host = process.env.BIND_HOST || '127.0.0.1';
      await app.listen({ port: PORT, host });
      app.log.info(`listening on ${host}:${PORT}`);
      app.log.info(`Nouvelage daily sales — ${PUBLIC_ORIGIN}`);
      // Expired sessions and abandoned handshakes, hourly.
      setInterval(() => Auth.sweep().catch(() => {}), 3600_000).unref();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

/** A short digest of every asset's size and mtime — changes when any of them does. */
function stampOf(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const st = fs.statSync(full);
      h.update(`${full}:${st.size}:${st.mtimeMs}`);
    }
  };
  try { walk(dir); } catch { return 'dev'; }
  return h.digest('hex').slice(0, 10);
}

module.exports = { build };
