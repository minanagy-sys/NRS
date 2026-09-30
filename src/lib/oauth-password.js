/* ============================================================
   Username + password -> MCP token, for UNATTENDED jobs only.

   The web app never uses this: people sign in through the MCP's own page and
   this process never sees a password. But a cron sync has no browser to
   redirect, and the MCP does not support the client-credentials or password
   grants, so the only way to mint a token headlessly is to drive the same login
   form a person would — GET /oauth/authorize for the session cookie, POST the
   credentials, then exchange the returned code.

   Give the cron account read-only Odoo rights; the token it mints can read
   everything that account can.
   ============================================================ */

const crypto = require('crypto');
const { fetchRetry } = require('./http.js');

const b64url = (b) => b.toString('base64url');

async function loginWithPassword({ base, user, password, redirectUri = 'http://localhost/oauth/callback' }) {
  const origin = String(base || 'https://mcp.nouvelageclinic.com').replace(/\/+$/, '');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const reg = await (await fetchRetry(`${origin}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Nouvelage Daily Sales — sync', redirect_uris: [redirectUri],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  })).json();
  if (!reg.client_id) throw new Error('The MCP refused to register the sync client.');

  const q = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp',
  });

  // The pending request lives in a session cookie planted by this GET.
  const page = await fetchRetry(`${origin}/oauth/authorize?${q}`);
  const cookie = (page.headers.getSetCookie ? page.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('The MCP did not start a login session.');

  const res = await fetchRetry(`${origin}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ email: user, password }).toString(),
    redirect: 'manual',
  });

  const location = res.headers.get('location');
  if (!location) {
    const body = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(/invalid|incorrect|wrong|denied/i.test(body)
      ? 'Wrong email or password for the Nouvelage MCP.'
      : `MCP login failed: ${body.slice(0, 160) || `HTTP ${res.status}`}`);
  }
  const code = new URL(location, origin).searchParams.get('code');
  if (!code) throw new Error('The MCP redirected without an authorization code.');

  const tok = await (await fetchRetry(`${origin}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: reg.client_id, code_verifier: verifier,
    }).toString(),
  })).json();
  if (!tok.access_token) throw new Error(`Token exchange failed: ${tok.error_description || tok.error || 'no access_token'}`);
  return { token: tok.access_token, expiresIn: tok.expires_in };
}

module.exports = { loginWithPassword };
