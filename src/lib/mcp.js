/* ============================================================
   Nouvelage Odoo MCP client — Streamable HTTP transport.

   Speaks to https://mcp.nouvelageclinic.com/mcp, the same MCP server the
   Claude connector uses. Exposes a session whose `callKw` signature matches
   what lib/aggregate.js expects, so the aggregation code is unchanged
   whether the data comes from raw Odoo JSON-RPC or from this MCP.

   Runs in Node and in the browser: the server sends
   `Access-Control-Allow-Origin: *` and allows the `authorization` and
   `mcp-session-id` request headers, so a plain HTML file can call it.

   What the browser CANNOT do is turn a password into a token — that step
   needs a session cookie, and the server does not send
   `Access-Control-Allow-Credentials`. So `login()` is Node-only; the
   browser must be handed a token that was minted elsewhere.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.McpClient = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Node resolves the shared helper by require; the browser build inlines
  // lib/http.js ahead of this file, which puts it on the global as HttpRetry.
  // `root` belongs to the wrapper, not to this factory — reach the global here.
  const globalScope = typeof globalThis !== 'undefined' ? globalThis : self;
  const { fetchRetry } = (typeof module === 'object' && module.exports)
    ? require('./http.js')
    : globalScope.HttpRetry;

  const DEFAULT_BASE = 'https://mcp.nouvelageclinic.com';

  /* Three quite different things can go wrong and they need different answers
     from the person reading the report, so every error carries which one it was:

       token      the MCP rejected our bearer token — sign in again
       transport  the MCP itself could not be reached — network or the server
       odoo       the MCP answered, but Odoo behind it did not — wait, not our bug

     Without this the app blamed itself for an Odoo outage. */
  function mcpError(message, kind) {
    const e = new Error(message);
    e.kind = kind;
    return e;
  }

  /** Does this failure text come from Odoo rather than from the MCP layer? */
  const fromOdoo = (text) => /odoo/i.test(String(text || ''));

  /** One MCP session: initialize once, then reuse the session id for every call. */
  async function connect({ base = DEFAULT_BASE, token }) {
    if (!token) throw new Error('An access token is required to reach the MCP.');
    const endpoint = base.replace(/\/+$/, '') + '/mcp';
    let sessionId = null;
    let nextId = 0;

    async function rpc(method, params, expectReply = true) {
      const headers = {
        'Content-Type': 'application/json',
        // The server may answer as JSON or as an SSE stream; accept both.
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + token,
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;

      const body = { jsonrpc: '2.0', method, params };
      if (expectReply) body.id = ++nextId;

      let res;
      try {
        res = await fetchRetry(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (e) {
        // fetchRetry has already exhausted its retries and named the host.
        throw mcpError(e.message, 'transport');
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;

      if (res.status === 401) throw mcpError('MCP rejected the token (401) — sign in again.', 'token');
      if (!expectReply) return null;
      if (!res.ok && res.status !== 200) throw mcpError(`MCP replied HTTP ${res.status}`, 'transport');

      /* Reading the body is network too. A connection the MCP drops half-way
         through a long reply throws HERE ("terminated: other side closed"),
         outside the try around fetchRetry, and used to escape with no kind at
         all — so the reader could not be told it was the connection. */
      let text;
      try {
        text = await res.text();
      } catch (e) {
        throw mcpError(`The MCP closed the connection mid-reply: ${e.message}`, 'transport');
      }
      const payload = parseBody(text);
      if (!payload) throw mcpError('MCP returned an empty reply.', 'transport');
      if (payload.error) {
        const m = payload.error.message || JSON.stringify(payload.error);
        throw mcpError(m, fromOdoo(m) ? 'odoo' : 'mcp');
      }
      return payload.result;
    }

    const info = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Nouvelage Daily Sales Report', version: '2.0' },
    });
    await rpc('notifications/initialized', undefined, false);

    /** Unwrap the tool result, which arrives as JSON inside a text content block. */
    async function callTool(name, args) {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result && result.isError) {
        const m = textOf(result) || `MCP tool ${name} failed.`;
        throw mcpError(m, fromOdoo(m) ? 'odoo' : 'mcp');
      }
      const raw = textOf(result);
      if (raw === '') return null;
      try { return JSON.parse(raw); } catch { /* a plain string — see below */ }

      /* Not every failure sets isError. When Odoo is unreachable, odoo_ping
         answers "❌ Odoo connection failed." as an ordinary successful result,
         so `await session.ping()` used to resolve and every caller concluded
         all was well. Real data from these tools is always JSON, so a bare
         string opening with the failure marker is a failure. */
      if (raw.startsWith('❌')) {
        throw mcpError(raw.replace(/^❌\s*/, ''), fromOdoo(raw) ? 'odoo' : 'mcp');
      }
      return raw;
    }

    return {
      base, serverInfo: info && info.serverInfo,
      callTool,
      /** The one method lib/aggregate.js depends on. */
      callKw: (model, method, args, kwargs) =>
        callTool('odoo_call_method', { model, method, args: args || [], kwargs: kwargs || {} }),
      ping: () => callTool('odoo_ping', {}),
    };
  }

  function textOf(result) {
    const parts = (result && result.content) || [];
    return parts.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
  }

  /** The Streamable HTTP transport may reply as plain JSON or as `data:` SSE frames. */
  function parseBody(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (trimmed[0] === '{') return JSON.parse(trimmed);
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
    }
    return null;
  }

  return { connect, DEFAULT_BASE };
});
