/* ======================================================================
   What the Performance KPIs dashboard's script reaches for.

   `kpi-dash.js` is lines 188–446 of `Performance KPIs · Nouvelage.html`,
   copied with nothing changed. It was written to run as a Claude artifact, so
   it expects a `claude.use(...)` host this app does not have. This supplies
   one, then loads the script.

   UNLIKE THE OTHER TWO PORTS, THIS PAGE CARRIES NO DATA OF ITS OWN. Every
   figure is a live Odoo call; the constants in the script are KPI definitions
   — baselines and targets — not measurements. So there is no bootstrap of
   rebuilt tables here, only the Odoo proxy and the saved thresholds.

   WHERE IT DIFFERS, and why:

     THE EDITOR'S STORE. The artifact saves by rewriting its own HTML and
     calling `artifact.publish()`. There is no file to rewrite here, so the
     edited thresholds go to /api/kpi/config behind the writer gate, and are
     injected back into the `#cfg` element on load — which is exactly where the
     script reads them, so its own parsing is untouched.
   ====================================================================== */
(() => {
  const json = async (url, opts) => {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: {
        'X-Requested-With': 'fetch',
        ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...((opts || {}).headers),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* THE `code` MUST SURVIVE. The script classifies failures by it, and
         treats `no_access` as expected — an Odoo permission refusal is a fact
         about the reader, not a fault, so it is tolerated and the status stays
         "synced". Everything else degrades the header to "partly loaded".

         Throwing a plain Error here left `code` undefined, which is `!==
         'no_access'`, so a tolerated refusal reported itself as a half-broken
         page — and `errText` lost the sentence that said what to do about it.

         429 is this app's own rate limiter rather than anything Odoo said, so
         it is named separately: the page is fine, it was asked too quickly. */
      const err = new Error(body.error || `${res.status} ${res.statusText}`);
      err.code = body.code || (res.status === 429 ? 'rate_limited'
        : res.status === 401 ? 'not_logged_in' : 'server_unavailable');
      throw err;
    }
    return body;
  };

  /* ---------- the live Odoo path ----------
     The script calls `mcp.callTool(server, 'odoo_call_method', {model, method,
     args, kwargs})` and reads `payload`. That is forwarded to /api/kpi/odoo,
     which runs the same call with the reader's own token.

     The script already caches each result for five minutes against a key built
     from the arguments, so no caching is added here. */
  const mcp = {
    callTool: async (server, tool, args) =>
      json('/api/kpi/odoo', { method: 'POST', body: JSON.stringify({ tool, ...args }) }),
  };

  /* ---------- who is reading ----------
     `canEdit()` is read SYNCHRONOUSLY by the script —
     `if (u && u.canEdit && u.canEdit() === false)` — so it must return a plain
     boolean, not a promise. A promise is truthy and never `=== false`, which
     would have shown the Edit button to every reader. The value is resolved
     before this object is built. */
  function user(canWrite) {
    return {
      me: () => ({ id: '', name: '' }),
      canEdit: () => canWrite,
      isOwner: () => false,
    };
  }

  /* ---------- the editor's save ----------
     The script hands `artifact.publish(html)` a whole rewritten document with
     its `#cfg` blob replaced. Only that blob matters, so it is pulled back out
     and sent as JSON. Parsed with the same regex the script used to write it,
     against the string it actually produced — not re-derived from the DOM,
     which would miss an edit the script made but had not yet applied. */
  const artifact = {
    publish: async (html) => {
      const m = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html);
      if (!m) throw new Error('No settings block found in the page to save.');
      let cfg;
      try {
        cfg = JSON.parse(m[1].replace(/\\u003c/g, '<') || '{}');
      } catch {
        throw new Error('The settings block could not be read back.');
      }
      await json('/api/kpi/config', { method: 'PUT', body: JSON.stringify(cfg) });
    },
  };

  /* ---------- boot ----------
     The `#cfg` element is filled before the script runs, because the script
     reads it on its very first line. */
  (async () => {
    const [cfg, gate] = await Promise.all([
      json('/api/kpi/config').catch(() => ({})),
      json('/api/contact-centre/gate').catch(() => null),
    ]);

    const el = document.getElementById('cfg');
    if (el) el.textContent = JSON.stringify(cfg || {}).replace(/</g, '\\u003c');

    const canWrite = !!(gate && gate.canUpload);
    window.claude = {
      use: async (what) => {
        if (what === 'mcp') return mcp;
        if (what === 'user') return user(canWrite);
        /* Offered only to a writer. The script hides its Edit button when this
           is null, which is the behaviour wanted for a reader — rather than
           showing an editor whose Save the server would refuse. */
        if (what === 'artifact') return canWrite ? artifact : null;
        if (what === 'downloads') return downloads;
        return null;
      },
    };

    const s = document.createElement('script');
    s.src = '/assets/kpi-dash.js';
    document.body.appendChild(s);
  })();

  const downloads = {
    save: async ({ filename, data }) => {
      const blob = new Blob([data], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };
})();
