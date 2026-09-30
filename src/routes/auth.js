/* Sign in / out. The password is typed on the MCP's own page, never here. */

const Auth = require('../lib/auth.js');
const Gate = require('../lib/admin-gate.js');

module.exports = async function (app) {
  const redirectUri = `${app.config.PUBLIC_ORIGIN}/auth/callback`;

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: app.config.IS_HTTPS,
    path: '/',
  };

  app.get('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (req.user) return reply.redirect('/');
    try {
      // Only ever bounce back to a path on this site.
      const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
      const url = await Auth.beginLogin(redirectUri, next);
      return reply.redirect(url);
    } catch (e) {
      req.log.error(e);
      return reply.code(502).type('text/html').send(page('Could not start sign-in', e.message));
    }
  });

  app.get('/auth/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query;
    if (error) return reply.code(400).type('text/html').send(page('Sign-in was refused', desc || error));
    if (!code || !state) return reply.code(400).type('text/html').send(page('Sign-in incomplete', 'The MCP did not return a code.'));

    try {
      const { sessionId, expiresAt, returnTo, who } = await Auth.completeLogin({ code, state, redirectUri });
      reply.setCookie('sid', sessionId, { ...cookieOpts, expires: expiresAt });
      await app.audit({ ...req, user: { subject: who.subject } }, 'sign-in', who.displayName || who.subject);
      return reply.redirect(returnTo);
    } catch (e) {
      req.log.error(e);
      return reply.code(400).type('text/html').send(page('Sign-in failed', e.message));
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.user) await app.audit(req, 'sign-out');
    await Auth.signOut(req.cookies.sid);
    reply.clearCookie('sid', cookieOpts);
    return reply.redirect('/');
  });

  app.get('/auth/me', async (req, reply) => req.user
    ? { subject: req.user.subject, name: req.user.displayName, canWrite: !!req.user.canWrite,
        writesConfigured: !!Gate.configured() }
    : reply.code(401).send({ error: 'not signed in' }));

  /* Unlock editing for this session. Slow-limited: the passphrase is the only
     thing standing between a signed-in reader and the target sheets. */
  app.post('/auth/unlock', {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'fetch') return reply.code(403).send({ error: 'Missing X-Requested-With.' });
    if (!Gate.configured()) return reply.code(503).send({ error: 'ADMIN_PASSPHRASE is not set on the server.' });
    if (!Gate.matches((req.body || {}).passphrase)) {
      await app.audit(req, 'unlock-failed');
      return reply.code(403).send({ error: 'Wrong passphrase.' });
    }
    await Gate.grant(req.user.id);
    await app.audit(req, 'unlock');
    return { ok: true, canWrite: true };
  });

  app.post('/auth/lock', { preHandler: app.requireUser }, async (req) => {
    await Gate.revoke(req.user.id);
    await app.audit(req, 'lock');
    return { ok: true, canWrite: false };
  });
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, detail) => `<!doctype html><meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/app.css">
<div class="stage"><h3>${esc(title)}</h3><p>${esc(detail)}</p>
<p style="margin-top:18px"><a class="btn" href="/auth/login">Try again</a></p></div>`;
