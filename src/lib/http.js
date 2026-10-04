/* ============================================================
   fetch with transport-level retry, shared by lib/oauth.js and lib/mcp.js.

   The first connection to the MCP after an idle spell dies with
   UND_ERR_CONNECT_TIMEOUT after ~10 s while the very next one answers in under
   a second — measured, not guessed. Retry only failures that never reached the
   server; an HTTP status is a real answer and is passed straight through, so a
   wrong password still reports itself immediately.

   UMD-ish so the same source runs under require() and inlined in a <script>.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HttpRetry = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const RETRYABLE = /TIMEOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket|network/i;

  async function fetchRetry(url, options, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await fetch(url, options);
      } catch (e) {
        last = e;
        const code = (e.cause && e.cause.code) || '';
        if (!RETRYABLE.test(`${code} ${e.message}`) || i === tries - 1) break;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    const code = (last.cause && last.cause.code) || last.message;
    let host = url;
    try { host = new URL(url).host; } catch { /* keep the raw string */ }
    throw new Error(`Could not reach ${host} (${code}). Check the connection and try again.`);
  }

  return { fetchRetry };
});
