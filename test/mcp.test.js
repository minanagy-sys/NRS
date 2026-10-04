/**
 * The MCP client's failure handling. Reaching the server successfully is not the
 * same as getting an answer, and the three ways this can go wrong need to stay
 * distinguishable — the app blamed itself for an Odoo outage once already.
 *
 *   node test/mcp.test.js
 */

const assert = require('assert');
const Mcp = require('../src/lib/mcp.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message}`); }
};

/**
 * Stand in for the MCP. `reply` decides what the tools/call answer looks like;
 * initialize always succeeds, because that is the case worth testing past.
 */
function stubMcp(reply, { status = 200 } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const headers = { get: (k) => (k === 'mcp-session-id' ? 'sid-1' : null) };
    if (body.method === 'initialize') {
      return { ok: true, status: 200, headers, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'stub' } } }) };
    }
    if (body.id === undefined) return { ok: true, status: 202, headers, text: async () => '' };
    return { ok: status < 400, status, headers, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }) };
  };
  return () => { globalThis.fetch = real; };
}

const connect = () => Mcp.connect({ base: 'https://mcp.example', token: 't' });

/** Run fn and return the error it throws, failing if it resolves instead. */
async function thrown(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected a throw, got a resolved value');
}

(async () => {
  await check('a JSON tool result comes back parsed', async () => {
    const restore = stubMcp({ result: { content: [{ type: 'text', text: '[{"id":7}]' }] } });
    try {
      const s = await connect();
      assert.deepStrictEqual(await s.callKw('account.move', 'search_read', [[]]), [{ id: 7 }]);
    } finally { restore(); }
  });

  /* The bug this file exists for: odoo_ping answers "❌ Odoo connection failed."
     as an ordinary result with no isError, so ping() resolved and every caller
     concluded Odoo was healthy while it was flat on its back. */
  await check('a ❌ text result throws instead of resolving', async () => {
    const restore = stubMcp({ result: { content: [{ type: 'text', text: '❌ Odoo connection failed.' }] } });
    try {
      const s = await connect();
      const e = await thrown(() => s.ping());
      assert.match(e.message, /Odoo connection failed/);
      assert.strictEqual(e.kind, 'odoo', 'must be attributed to Odoo, not to us');
    } finally { restore(); }
  });

  await check('an ordinary non-JSON string still comes through', async () => {
    const restore = stubMcp({ result: { content: [{ type: 'text', text: 'pong' }] } });
    try {
      const s = await connect();
      assert.strictEqual(await s.ping(), 'pong');
    } finally { restore(); }
  });

  await check('isError mentioning Odoo is attributed to Odoo', async () => {
    const restore = stubMcp({ result: { isError: true, content: [{ type: 'text', text: 'Error: Odoo RPC error: Odoo Server Error' }] } });
    try {
      const s = await connect();
      const e = await thrown(() => s.callKw('account.move', 'search_read', [[]]));
      assert.strictEqual(e.kind, 'odoo');
    } finally { restore(); }
  });

  await check('isError with no mention of Odoo stays an MCP fault', async () => {
    const restore = stubMcp({ result: { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] } });
    try {
      const s = await connect();
      const e = await thrown(() => s.callKw('account.move', 'search_read', [[]]));
      assert.strictEqual(e.kind, 'mcp');
    } finally { restore(); }
  });

  await check('a 401 is a token fault, so the answer is "sign in again"', async () => {
    const restore = stubMcp({ result: {} }, { status: 401 });
    try {
      const s = await connect();
      const e = await thrown(() => s.callKw('account.move', 'search_read', [[]]));
      assert.strictEqual(e.kind, 'token');
    } finally { restore(); }
  });

  await check('an unreachable server is a transport fault', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
    try {
      const e = await thrown(() => connect());
      assert.strictEqual(e.kind, 'transport');
      assert.match(e.message, /mcp\.example/);
    } finally { globalThis.fetch = real; }
  });

  await check('a JSON-RPC error naming Odoo is attributed to Odoo', async () => {
    const restore = stubMcp({ error: { message: 'Odoo Server Error' } });
    try {
      const s = await connect();
      const e = await thrown(() => s.callKw('account.move', 'search_read', [[]]));
      assert.strictEqual(e.kind, 'odoo');
    } finally { restore(); }
  });

  console.log(failures ? `\n${failures} failed\n` : '\n✓ the MCP client reports which layer failed\n');
  process.exit(failures ? 1 : 0);
})();
