/* ============================================================
   The page shell every NRS report shares.

   Two things lived in triplicate before this file existed — the tab switcher and
   the sticky-bar measurement — once each in app.js, finance.js and admin.js, with
   three small differences between them that were accidents rather than decisions:
   app.js scrolled with `behavior:'instant'`, finance.js scrolled without it, and
   finance.js was missing the `window.resize` listener, so nav.js's synthetic
   resize (which it dispatches precisely so the bar re-measures when the sidebar
   opens) did nothing on the finance page.

   Adding three more reports meant three more copies. This is the one copy.

   Loaded as a plain <script> before the page's own script, so `Shell` is a
   global rather than a module — the server's CSP forbids inline script, and every
   page already loads its JS the same way.
   ============================================================ */
(function (root) {
  'use strict';

  /** Show one panel, hide the rest, and put the reader back at the top.
   *
   *  `data-panel` on the button must equal the panel element's `id` — every page
   *  resolves it with getElementById, so a mismatch shows a blank page rather
   *  than an error.
   */
  function showPanel(id) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.panel === id));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
    /* 'instant' matters: a smooth scroll from the bottom of a long table reads as
       the page lurching, and on the target tab it animates past every group. */
    root.scrollTo({ top: 0, behavior: 'instant' });
  }

  /** Wire the tab strip.
   *
   *  `onShow(id)` is optional and may be async — /admin renders each panel on
   *  demand rather than up-front, so it needs a hook and a place to report a
   *  failure. Returns the same `go(id)` the handler uses, because /admin also
   *  switches tabs programmatically when a draft is handed over from the report.
   */
  function mountTabs(opts) {
    const o = opts || {};
    const go = (id) => showPanel(id);
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', async () => {
        go(btn.dataset.panel);
        if (typeof o.onShow !== 'function') return;
        try { await o.onShow(btn.dataset.panel); }
        catch (e) { if (typeof o.onError === 'function') o.onError(e); else throw e; }
      });
    });
    return go;
  }

  /* ---- the reload hook the shared control bar needs ----

     `Sync now` and `Show` live in cbar.js, which is one file shared by eleven
     pages and therefore cannot reach any page's own `load()`. A page registers
     itself here instead. The alternative was `location.reload()`, which works
     and throws away whatever range the reader had picked — the bar sets from/to
     from a preset on boot, not from the URL. */
  let refreshCb = null;

  /** A page says how to reload itself. Called by the shared bar. */
  function onRefresh(fn) { refreshCb = typeof fn === 'function' ? fn : null; }

  /** Reload the current page's data. Returns whatever the page's loader does. */
  function fireRefresh() {
    if (!refreshCb) return Promise.resolve();
    try { return Promise.resolve(refreshCb()); } catch (e) { return Promise.reject(e); }
  }

  /** Publish the control bar's height as --cbarH.
   *
   *  app.css pins the tab strip with `top:var(--cbarH,0px)`. Without this both
   *  the bar and the strip stick at 0 and overlap the moment the page scrolls —
   *  which is exactly the bug every one of the standalone commercial reports has,
   *  since they pin `.topbar` and `.subtabs-wrap` both at `top:0`.
   *
   *  The bar wraps to two or three rows on a narrow window and changes height
   *  when the sidebar opens, so this is measured, never assumed. ResizeObserver
   *  catches the wrap; the resize listener catches nav.js's synthetic event.
   */
  function stickyBar(selector) {
    const bar = document.querySelector(selector || '.cbar');
    if (!bar) return () => {};
    const sync = () => document.documentElement.style
      .setProperty('--cbarH', `${Math.round(bar.getBoundingClientRect().height)}px`);
    new ResizeObserver(sync).observe(bar);
    root.addEventListener('resize', sync);
    sync();
    return sync;
  }

  root.Shell = { mountTabs, showPanel, stickyBar, onRefresh, fireRefresh };
})(typeof self !== 'undefined' ? self : this);
