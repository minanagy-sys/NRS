/* ======================================================================
   What the Contact Centre dashboard's script reaches for.

   `cc-dash.js` is lines 473–1191 of `Contact Centre · Nouvelage.html`, copied
   with nothing changed. It was written to run as a Claude artifact, so it
   expects things this app does not have: three data constants already defined
   as globals, a `claude.use(...)` host, and SheetJS on a CDN that the content
   security policy forbids.

   This file supplies those, then loads the script. The arrangement is the
   point: the script is never edited, so the page cannot drift from the
   original the way a re-implementation did.

   WHERE IT DELIBERATELY DIFFERS, and why — these are the only two:

     THE STORE. The script falls back to an in-memory store when there is no
     host, which accepts a weekly upload and loses it on reload. It is served
     the real one instead, over /api/cc/ucm.

     THE UPLOAD. The script parses the CDR file in the browser. This project
     already parses the same file server-side — `src/lib/ucm-cdr.js` has the
     same two `buildCalls`/`buildCallsGS` flows — behind the writer gate, the
     audit log, and a re-parse that refuses to trust what a browser sends. The
     file is posted there instead of being parsed here. Keeping the browser
     copy would have meant shipping a second parser to disagree with the first.
   ====================================================================== */
(() => {
  const json = async (url, opts) => {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'X-Requested-With': 'fetch', ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}), ...((opts || {}).headers) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* THE `code` MUST SURVIVE. The script chooses its message from it — the
         live pull's catch names the connector to reconnect, or says Odoo
         refused the call — and a plain Error with no `code` falls through all
         of those to a generic failure that tells the reader nothing to do. */
      const err = new Error(body.error || `${res.status} ${res.statusText}`);
      err.code = body.code || (body.kind === 'odoo' ? 'tool_error'
        : res.status === 429 ? 'rate_limited'
          : res.status === 401 ? 'not_logged_in' : 'server_not_connected');
      throw err;
    }
    return body;
  };

  /* ---------- the store ----------
     The script asks for `ucm_weeks`, `ucm_calls` and `ucm_settings/extensions`
     through a document-store interface. Everything is fetched once into the
     three collections it reads, so its `ucmLoad()` runs unchanged. */
  function store(ucm) {
    const weeks = (ucm.weeks || []).map((w) => ({ id: w.id, v: w }));
    /* The script re-joins `ucm_calls` docs by parsing each one's `r`, so the
       whole set is handed over as a single document rather than re-chunked
       into the 2,500-row pieces the original store needed. */
    const calls = ucm.calls && ucm.calls.length
      ? [{ id: 'all', v: { r: JSON.stringify(ucm.calls) } }] : [];
    const ext = { map: JSON.stringify(ucm.ext || []) };

    const docsOf = (rows) => ({ docs: rows.map((d) => ({ id: d.id, data: () => d.v })) });
    return {
      collection: (p) => ({
        get: async () => docsOf(p === 'ucm_weeks' ? weeks : p === 'ucm_calls' ? calls : []),
        /* Writing a week or a chunk through here belongs to the script's own
           `saveCalls`, which the replaced `readFile` never reaches. It throws
           rather than resolving quietly: a no-op `set` would let an upload
           report "UCM saved" and keep nothing, which is the one failure this
           page must never produce. */
        doc: (id) => ({
          get: async () => ({ exists: false, data: () => null }),
          set: async () => { throw new Error(`Calls are saved through /api/ucm/import, not ${p}/${id}.`); },
          delete: async () => { throw new Error(`Calls are saved through /api/ucm/import, not ${p}/${id}.`); },
        }),
      }),
      doc: (p) => ({
        get: async () => ({ exists: p === 'ucm_settings/extensions', data: () => ext }),
        /* The extension map is the one thing this page writes. It goes to the
           endpoint that already owns it, which refuses an extension the phone
           system never reported rather than creating a row no call matches. */
        set: async (v) => {
          if (p !== 'ucm_settings/extensions') return;
          const rows = JSON.parse(v.map).map(([e, phoneName, odooEmployee, team, branch]) =>
            ({ ext: e, phoneName, odooEmployee, team, branch }));
          await json('/api/pbx/extensions', { method: 'PUT', body: JSON.stringify({ rows }) });
          ext.map = v.map;
        },
        delete: async () => {},
      }),
    };
  }

  /* ---------- who is reading ----------
     Read from the gate endpoint, which already reports this page's writer
     capability and is the same answer the server will enforce on the upload.

     `isOwner` is the one mapping that is not literal. A session here carries
     no owner flag, and the script uses `isOwner` for exactly one thing: who
     may dismiss the weekly lock. This app already has an authority on whether
     that lock binds — the `contactCentreGate` config, reported as `enforced` —
     so that is what it is mapped to. With the gate on, as it is in normal
     running, nobody may dismiss it. */
  async function user() {
    const g = await json('/api/contact-centre/gate').catch(() => null);
    if (!g) return null;
    const canWrite = !!g.canUpload;
    const mayDismissLock = g.enforced === false;
    return {
      me: async () => ({ id: '', name: '' }),
      can: async (what) => (what === 'data.write' ? canWrite : true),
      canEdit: async () => canWrite,
      isOwner: async () => mayDismissLock,
    };
  }

  /* ---------- the live Odoo pull ----------
     `callTool(server, tool, args)` is forwarded to /api/cc/odoo, which calls
     the one tool with the reader's own token and hands back `payload` exactly
     as the script expects to find it. */
  const mcp = {
    callTool: async (server, tool, args) =>
      json('/api/cc/odoo', { method: 'POST', body: JSON.stringify({ tool, ...args }) }),
  };

  /* ---------- downloads ----------
     The export builds a CSV string and calls `save({filename, data})`. */
  const downloads = {
    save: async ({ filename, data }) => save(filename, data),
  };
  function save(name, content) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- the upload ----------
     The script's own reader is replaced wholesale. Its mapping screen exists
     to tell a browser-side parser which column is which; the server works that
     out itself and reports what it found, so the file is sent straight there
     and the answer is shown in the same step element. */
  function readFileViaServer(file, host) {
    const step = (host || document).querySelector('#ucmStep');
    const show = (html) => { if (step) step.innerHTML = html; };
    show('<p class="g-sub">Reading the file…</p>');
    const fr = new FileReader();
    fr.onerror = () => show('<p class="g-err">The file could not be read.</p>');
    fr.onload = async () => {
      const base64 = btoa(Array.from(new Uint8Array(fr.result), (b) => String.fromCharCode(b)).join(''));
      try {
        const pv = await json('/api/ucm/preview', { method: 'POST', body: JSON.stringify({ base64, filename: file.name }) });
        const n = (v) => Math.round(v || 0).toLocaleString('en-US');
        show(`<p class="g-sub" style="margin:16px 0 0"><b>${file.name}</b> · ${n(pv.legs)} rows read as `
          + `${n(pv.calls)} calls (${pv.format}).</p>`
          + `<div id="mpSum"></div><div class="g-act"><button class="btn solid" id="mpSave">Save</button></div><div id="mpMsg"></div>`);
        step.querySelector('#mpSave').onclick = async () => {
          step.querySelector('#mpMsg').innerHTML = '<p class="g-sub">Saving…</p>';
          try {
            const out = await json('/api/ucm/import', { method: 'POST', body: JSON.stringify({ base64, filename: file.name }) });
            step.querySelector('#mpMsg').innerHTML = `<p class="g-ok">${n(out.calls)} calls saved.</p>`;
            setTimeout(() => window.location.reload(), 700);
          } catch (e) {
            step.querySelector('#mpMsg').innerHTML = `<p class="g-err">${e.message}</p>`;
          }
        };
      } catch (e) {
        show(`<p class="g-err">${e.message}</p>`);
      }
    };
    fr.readAsArrayBuffer(file);
  }

  /* ---------- boot ----------
     The constants must exist before cc-dash.js is evaluated, so the script tag
     is added only after they are in place. */
  (async () => {
    let boot;
    let ucm = { weeks: [], calls: [], ext: [] };
    try {
      [boot, ucm] = await Promise.all([
        json('/api/cc/bootstrap'),
        json('/api/cc/ucm').catch(() => ({ weeks: [], calls: [], ext: [] })),
      ]);
    } catch (e) {
      document.body.insertAdjacentHTML('afterbegin',
        `<div class="notice" style="margin:16px">The contact centre data did not load — ${e.message}</div>`);
      return;
    }

    window.DATA = boot.DATA;
    window.APPT = boot.APPT;
    window.CRM = boot.CRM;

    const db = store(ucm);
    const u = await user();
    window.claude = {
      use: async (what) => {
        if (what === 'db') return db;
        if (what === 'user') return u;
        if (what === 'downloads') return downloads;
        if (what === 'mcp') return mcp;
        return null;
      },
    };

    const s = document.createElement('script');
    s.src = '/assets/cc-dash.js';
    /* The script's `readFile` is replaced rather than its file input: that
       input is built when the upload panel renders, which has not happened
       yet, and it is reached from two places (the picker and the drop zone).
       Both call `readFile(...)` by name, and cc-dash.js is a classic script,
       so its top-level declaration is a property of `window` and reassigning
       it here is what those two call sites resolve at click time. */
    s.onload = () => { window.readFile = (f, host) => readFileViaServer(f, host); };
    document.body.appendChild(s);
  })();
})();
