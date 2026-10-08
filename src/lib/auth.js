/* ============================================================
   Sign-in against the Nouvelage MCP — OAuth 2.1 authorization code + PKCE.

   The browser is sent to the MCP's own login page and comes back with a code,
   so this app never sees a password. That is the whole reason for running on a
   real domain: the redirect the flow needs cannot land on a file:// page.

   Tokens last 30 days and the MCP issues no refresh token, so expiry means
   signing in again.
   ============================================================ */

const crypto = require('crypto');
const { fetchRetry } = require('./http.js');
const { prisma } = require('./db.js');
const { encrypt, decrypt, randomId } = require('./crypto.js');

const b64url = (buf) => buf.toString('base64url');
const SESSION_DAYS = 30;

const base = () => (process.env.MCP_BASE_URL || 'https://mcp.nouvelageclinic.com').replace(/\/+$/, '');

async function postJson(url, body) {
  const res = await fetchRetry(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

async function postForm(url, fields) {
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return res.json();
}

/**
 * Step 1 — register a client, stash the PKCE verifier, and return the URL to
 * send the browser to.
 */
async function beginLogin(redirectUri, returnTo) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const reg = await postJson(`${base()}/oauth/register`, {
    client_name: 'Nouvelage Daily Sales',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  if (!reg.client_id) throw new Error('The MCP refused to register this application.');

  const state = randomId(24);
  await prisma.authRequest.create({
    data: { state, verifier, clientId: reg.client_id, redirect: returnTo || '/' },
  });

  const q = new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state,
  });
  return `${base()}/oauth/authorize?${q}`;
}

/**
 * Step 2 — swap the returned code for a token and open a session.
 * Returns { sessionId, expiresAt, returnTo }.
 */
async function completeLogin({ code, state, redirectUri }) {
  const pending = await prisma.authRequest.findUnique({ where: { state } });
  if (!pending) throw new Error('This sign-in link has already been used or has expired.');
  // One-shot: consume it whether or not the exchange succeeds.
  await prisma.authRequest.delete({ where: { state } });

  // A stale handshake is a replay risk, not just untidy.
  if (Date.now() - pending.createdAt.getTime() > 10 * 60 * 1000) {
    throw new Error('This sign-in took too long. Please try again.');
  }

  const tok = await postForm(`${base()}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  if (!tok.access_token) {
    throw new Error(`Sign-in failed: ${tok.error_description || tok.error || 'the MCP returned no token'}`);
  }

  const who = identify();
  const now = Date.now();
  const tokenExpiresAt = new Date(now + (Number(tok.expires_in) || SESSION_DAYS * 86400) * 1000);
  const sessionId = randomId(32);

  await prisma.session.create({
    data: {
      id: sessionId,
      subject: who.subject,
      displayName: who.displayName,
      tokenCipher: encrypt(tok.access_token),
      tokenExpiresAt,
      // The session cannot outlive the token it wraps.
      expiresAt: new Date(Math.min(now + SESSION_DAYS * 86400 * 1000, tokenExpiresAt.getTime())),
    },
  });

  return { sessionId, expiresAt: tokenExpiresAt, returnTo: pending.redirect || '/', who };
}

/* The MCP tells us nothing about who signed in: no userinfo endpoint, no
   id_token, no claims on the token, and Odoo's own "who am I" methods are
   blocked because the connector is read-only. The previous version papered over
   this by reading Odoo user id 2, which labelled every single visitor
   "Administrator" and made the audit log actively misleading.

   So we do not guess. Each session gets an opaque handle: actions stay
   correlatable to one sign-in without inventing a person. Give the MCP a
   userinfo endpoint and this becomes a real name. */
function identify() {
  return { subject: `mcp:${randomId(6)}`, displayName: null };
}

/** Look up a live session and hand back its decrypted token. */
async function currentSession(sessionId) {
  if (!sessionId) return null;
  const s = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!s) return null;
  if (s.expiresAt <= new Date()) {
    await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  // Cheap liveness stamp; skip the write when it would change nothing.
  if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  /* A token this process cannot decrypt is a SIGNED-OUT user, not a server
     fault. It happens whenever TOKEN_KEY changes — which `.env.example` says
     signs everyone out — and whenever two checkouts of this app share one
     database with different keys, which is easier to do than it sounds.
     Throwing here turned that into a 500 on every page: AES-GCM fails the auth
     tag and Node reports "Unsupported state or unable to authenticate data",
     which reads like a crash rather than "sign in again". */
  let token;
  try {
    token = decrypt(s.tokenCipher);
  } catch {
    return null;
  }
  return { id: s.id, subject: s.subject, displayName: s.displayName, canWrite: s.canWrite, token };
}

const signOut = (sessionId) =>
  sessionId ? prisma.session.delete({ where: { id: sessionId } }).catch(() => {}) : Promise.resolve();

/** Drop expired sessions and abandoned handshakes. */
async function sweep() {
  const now = new Date();
  const [sessions, requests] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lte: now } } }),
    prisma.authRequest.deleteMany({ where: { createdAt: { lte: new Date(now - 30 * 60 * 1000) } } }),
  ]);
  return { sessions: sessions.count, requests: requests.count };
}

module.exports = { beginLogin, completeLogin, currentSession, signOut, sweep, base };
