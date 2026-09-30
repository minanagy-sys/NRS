/* ============================================================
   Who is allowed to CHANGE things.

   Roles would be the right answer, but they need a verified identity and the
   MCP supplies none — no userinfo endpoint, no id_token, no claims on the
   token, and Odoo's own "who am I" calls are refused because the connector is
   read-only. Keying roles to a name we cannot verify would look like security
   without being any.

   So the gate is a secret instead of an identity: ADMIN_PASSPHRASE, entered
   once per session. Anyone who signs in can READ the report; only someone who
   knows the passphrase can change a target sheet or a name mapping.

   Its limits, stated plainly: it is shared, so it identifies no individual and
   the audit log can only record which session acted, not which person. When the
   MCP can tell us who signed in, replace this with real per-user roles.

   Note this gate protects OUR database only. Odoo itself cannot be written to
   at all — the MCP refuses write, create and unlink outright, which we verified
   rather than assumed.
   ============================================================ */

const crypto = require('crypto');
const { prisma } = require('./db.js');

const configured = () => String(process.env.ADMIN_PASSPHRASE || '');

/** Constant-time compare, so a wrong guess leaks nothing through timing. */
function matches(given) {
  const want = Buffer.from(configured());
  const got = Buffer.from(String(given || ''));
  if (!want.length || want.length !== got.length) {
    // Still burn a comparison so the failure takes the same shape.
    crypto.timingSafeEqual(want.length ? want : Buffer.alloc(1), want.length ? want : Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(want, got);
}

/** Mark this session as holding the passphrase. */
const grant = (sessionId) =>
  prisma.session.update({ where: { id: sessionId }, data: { canWrite: true } });

const revoke = (sessionId) =>
  prisma.session.update({ where: { id: sessionId }, data: { canWrite: false } }).catch(() => {});

/**
 * preHandler for every route that writes. Read routes never use it, so the
 * report and the admin screens stay visible to anyone signed in.
 */
function requireWriter(app) {
  return async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in first.' });
    if (!configured()) {
      return reply.code(503).send({
        error: 'Changes are disabled: ADMIN_PASSPHRASE is not set on the server.',
      });
    }
    if (!req.user.canWrite) {
      return reply.code(403).send({
        error: 'This session may read but not change anything. Unlock editing with the admin passphrase.',
        needsPassphrase: true,
      });
    }
  };
}

module.exports = { matches, grant, revoke, requireWriter, configured };
