/* ============================================================
   The control bar every report shares.

   ONE COPY, for the reason nav.js exists: the bar was hand-written into eleven
   views and had drifted. NRS carried five presets and Export/Import; the other
   ten carried four presets in three different orders; four of them had an
   entity filter, one had a patient basis, and none of them had any way to
   trigger a sync. Eleven copies of a control strip is eleven places for the next
   button to be forgotten.

   WHAT IS SHARED, and now identical everywhere:

     the sidebar toggle (inserted by nav.js at the head of the row)
     the date presets, in ONE order
     From / To / Show
     a slot for whatever that page needs and no other page does
     the sync state — when the cache was last filled, and Sync now
     Admin · Sign out

   WHAT A PAGE STILL OWNS. `data-presets` picks which presets it offers, and
   anything inside `<div class="cbar-extra">` in the view is moved into the slot
   untouched. That is where the entity filter, the patient basis and NRS's
   Export/Import live — controls that belong to one report and would be noise on
   the other ten. The bar's SHAPE is shared; its contents are not forced.

   SYNC NOW REPLACED FOUR TABS. Reports 03, 05, 08 and 09 each had a tab whose
   whole job was to say when the data was last refreshed and offer a way to do
   it. That is a control, not a report: it belongs in the strip that is on screen
   the whole time, not behind a tab somebody has to remember to check. The
   provenance detail those tabs also carried — which source each feed reads,
   which mappings are unresolved — stays where it is actionable, in Admin.

   It posts to /api/refresh, which re-reads a date window from Odoo into the
   cache. That endpoint cannot write to Odoo — the MCP refuses writes outright —
   and it is rate-limited to four calls a minute, which is why the button
   disables itself while a sync is in flight rather than trusting the reader not
   to hammer it.
   ============================================================ */
(function () {
  'use strict';

  const bar = document.querySelector('.cbar');
  if (!bar) return;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ONE order, everywhere. The bar was carrying `ytd` first on Procurement and
     last on the other nine, so the same click landed on a different range
     depending on which report you were reading. */
  const PRESETS = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: '7d', label: 'Last 7d' },
    { key: 'mtd', label: 'Month to date' },
    { key: 'lastmonth', label: 'Last month' },
    { key: 'quarter', label: 'This quarter' },
    { key: 'ytd', label: 'Year to date' },
  ];

  const wanted = (bar.dataset.presets || 'mtd,lastmonth,quarter,ytd')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const on = bar.dataset.preset || wanted[0];

  /* The page's own controls, lifted out before the row is rebuilt. */
  const extra = bar.querySelector('.cbar-extra');
  const extraHtml = extra ? extra.innerHTML : '';

  bar.innerHTML = `<div class="cbar-row">
      <div class="seg" id="presets">${PRESETS.filter((p) => wanted.includes(p.key))
    .map((p) => `<button data-p="${p.key}"${p.key === on ? ' class="on"' : ''}>${esc(p.label)}</button>`)
    .join('')}</div>

      <label class="fld">From <input type="date" id="from"></label>
      <label class="fld">To <input type="date" id="to"></label>
      <button class="btn" id="load">Show</button>

      <span class="cbar-extra">${extraHtml}</span>

      <span class="cbar-spacer"></span>

      <span class="cstat" id="syncInfo" title="When the Odoo cache was last filled">
        <i class="dot" id="dot"></i><span id="status">…</span></span>
      <button class="btn ghost" id="syncNow" title="Re-read this date range from Odoo into the cache">Sync now</button>
      <a class="btn ghost" href="/admin">Admin</a>
      <form method="post" action="/auth/logout" style="display:inline">
        <button class="btn ghost" type="submit">Sign out</button>
      </form>
    </div>
    <div class="err" id="err"></div>`;

  /* ---- how fresh the cache is ------------------------------------------ */

  /* /api/health is open and cheap — a count and the last run — so the bar can
     say how old the data is without a page having to pass it through. */
  const ago = (iso) => {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  let health = null;

  async function readHealth() {
    try {
      const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      health = await res.json();
      paintHealth();
    } catch { /* the bar is not worth an error banner */ }
  }

  function paintHealth() {
    const info = $('syncInfo');
    if (!info || !health) return;
    const run = health.lastRun;
    const when = run && run.at ? ago(run.at) : null;
    /* The dot is the CACHE's state, not the page's — the page's own loader owns
       `#status` text while it is working, and overwriting it here would flicker
       "loading…" away mid-fetch. */
    info.title = run
      ? `Last sync ${String(run.at).slice(0, 16).replace('T', ' ')} · ${run.window} · ${run.status}`
        + ` · ${Number(health.invoices).toLocaleString('en-US')} invoices cached`
      : 'No successful sync has been recorded';
    const label = $('syncLabel');
    if (label) label.textContent = when ? `synced ${when}` : 'never synced';
  }

  /* The freshness text sits beside the page's own status rather than replacing
     it: one says what the page is doing, the other says how old the data is,
     and a reader needs both. */
  const cstat = $('syncInfo');
  if (cstat) {
    const span = document.createElement('span');
    span.id = 'syncLabel';
    span.className = 'cbar-sync';
    span.textContent = '';
    cstat.appendChild(span);
  }

  /* ---- Sync now --------------------------------------------------------- */

  const btn = $('syncNow');
  if (btn) {
    btn.addEventListener('click', async () => {
      const from = $('from') ? $('from').value : '';
      const to = $('to') ? $('to').value : '';
      if (!from || !to) return;
      if (from > to) { $('err').textContent = '"From" is after "To".'; return; }

      /* Disabled while in flight. /api/refresh allows four calls a minute and a
         re-read of a wide range is not quick, so a second click is either
         refused by the rate limit or duplicates work nobody asked for. */
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Syncing…';
      $('err').textContent = '';
      try {
        const res = await fetch('/api/refresh', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            /* The anti-CSRF header a plain form post cannot set. */
            'X-Requested-With': 'fetch',
          },
          /* NRS also wants the stock snapshot re-pulled with its range, which is
             why it used to have its own Refresh button. Declared on the bar
             rather than given a second button only that report has. */
          body: JSON.stringify(bar.dataset.syncStock ? { from, to, stock: true } : { from, to }),
        });
        if (res.status === 401) { location.href = '/auth/login'; return; }
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);

        $('err').innerHTML = `<span style="color:#9fe08a">Re-read ${esc(from)} → ${esc(to)} from Odoo`
          + `${json.invoices == null ? '' : ` — ${Number(json.invoices).toLocaleString('en-US')} invoices`}.</span>`;
        await readHealth();
        /* Then the page reloads its own data, through the hook it registered —
           the bar has no idea what this report reads. */
        await Shell.fireRefresh();
      } catch (e) {
        $('err').textContent = e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    });
  }

  readHealth();
  /* Ten minutes. Frequent enough that "synced 2h ago" is never a lie by much,
     rare enough that eleven open tabs are not a load. */
  setInterval(readHealth, 600000);
})();
