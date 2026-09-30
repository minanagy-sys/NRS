/* ============================================================
   The report sidebar.

   One vertical list, because reports get added and a horizontal switch runs out
   of room. Adding one is a single entry in REPORTS below — nothing else in this
   file or in any page needs to change.

   Shared by every page: the markup is injected here rather than repeated in
   three views, so the list cannot go out of step with itself.
   ============================================================ */
(function () {
  const icon = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  /* ---- add a report here, and only here ---- */
  const REPORTS = [
    {
      href: '/', label: 'NRS', hint: 'Doctors, branches, targets',
      icon: icon('<line x1="4" y1="20" x2="4" y2="12"/><line x1="10" y1="20" x2="10" y2="5"/><line x1="16" y1="20" x2="16" y2="9"/><line x1="21" y1="20" x2="3" y2="20"/>'),
    },
    {
      href: '/doctors', label: 'Doctors Performance', hint: 'Targets, ticket size, injectables',
      /* A stethoscope. Sits next to NRS because it is the doctor-level detail of
         the same invoices — moved out of an NRS tab at Mina's request. */
      icon: icon('<path d="M5 4v5a4 4 0 0 0 8 0V4"/><path d="M9 13v3a4 4 0 0 0 8 0v-2"/><circle cx="18" cy="9" r="2"/>'),
    },
    {
      href: '/commercial-sales', label: 'Commercial Sales', hint: 'Revenue ex-package, mix, patients',
      /* Report 01, as its own report. Distinct from Sales above: that one is all
         invoices by doctor and target, this one is ex-package with the mix and the
         patient half. They are NOT merged — Mina asked for both, separately. */
      icon: icon('<path d="M4 18h16"/><path d="M6 18V9l4-4 4 3 4-5v15"/><circle cx="10" cy="5" r="1.2"/>'),
    },
    {
      /* HIDDEN 2026-08-19 at Mina's request. The report, its four sections and all
         7,300-odd rows of finance data are untouched — only the way in is gone.
         To bring it back: set enabled to true here AND set FINANCE_ENABLED=1 in
         .env, because the server stops registering the routes without it. */
      enabled: false,
      href: '/finance', label: 'Finance', hint: 'Collections, payables, stock',
      icon: icon('<path d="M3 7h14a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V6a2 2 0 0 1 2-2h9"/><circle cx="16" cy="13.5" r="1.3"/>'),
    },
    {
      href: '/targets', label: 'Targets & Doctor Commission', hint: 'Targets, branches, payslips',
      /* A dial at three-quarters — pace against target is what this report is. */
      icon: icon('<path d="M12 20a8 8 0 1 1 8-8"/><line x1="12" y1="12" x2="17.5" y2="7.5"/><circle cx="12" cy="12" r="1.4"/>'),
    },
    {
      href: '/commercial', label: 'Commercial', hint: 'The funnel, end to end',
      icon: icon('<path d="M4 5h16l-6 7v6l-4 2v-8Z"/>'),
    },
    {
      href: '/marketing', label: 'Marketing', hint: 'Meta spend, leads, organic',
      /* A megaphone: this is the only report about money going OUT. */
      icon: icon('<path d="M4 10v4l9 4V6Z"/><path d="M13 9.5a3 3 0 0 1 0 5"/><path d="M17 7a7 7 0 0 1 0 10"/>'),
    },
    {
      href: '/inventory', label: 'Inventory Performance', hint: 'Cover, expiry, at-risk',
      /* Boxes on a shelf. Sits after Contact Centre because it is the first
         report about what the clinic HOLDS rather than what it sold. */
      icon: icon('<path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5Z"/><path d="M3 8.5 12 13l9-4.5"/><path d="M12 13v7"/>'),
    },
    {
      href: '/procurement', label: 'Procurement & Products', hint: 'Purchases, vendors, cash back',
      /* A delivery box with an arrow in. The only report about money going out
         to suppliers, as distinct from Marketing's money going out to Meta. */
      icon: icon('<path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="M2.5 6h19l-1.5 3H4Z"/><path d="M12 20v-7"/><path d="m9.5 15.5 2.5-2.5 2.5 2.5"/>'),
    },
    {
      href: '/contact-centre', label: 'Contact Centre', hint: 'Queues, agents, bookings',
      /* A headset: this is the only report about the phones. */
      icon: icon('<path d="M5 13v-1a7 7 0 0 1 14 0v1"/><path d="M5 13h2.2a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V14a1 1 0 0 1 1-1Z"/><path d="M19 13h-2.2a1 1 0 0 0-1 1v3.5a1 1 0 0 0 1 1H18a2 2 0 0 0 2-2V14a1 1 0 0 0-1-1Z"/>'),
    },
    {
      /* HIDDEN 2026-09-03. Its four panels are now tab 04 of Commercial Sales,
         which is where report 01 keeps them — a standalone Patients entry beside
         it would list the same tiers, funnel, acquisition and churn twice. The
         page, its route and /api/patients are all still live and unchanged: set
         enabled to true to put the sidebar entry back. */
      enabled: false,
      href: '/patients', label: 'Patients', hint: 'Tiers, retention, service mix',
      icon: icon('<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.2"/><path d="M15 20a4.4 4.4 0 0 1 5.5-3.6"/>'),
    },
  ].filter((r) => r.enabled !== false);

  const SETUP = [
    {
      href: '/admin', label: 'Admin', hint: 'Targets, names, data sources',
      icon: icon('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>'),
    },
  ];

  const PANEL_ICON = icon('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="10" y1="4" x2="10" y2="20"/>');

  const KEY = 'nrs-nav';
  const root = document.documentElement;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* The active entry is the longest href that prefixes the current path, so
     /admin#commission still lights up Admin and a future /sales/x lights Sales. */
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isOn = (href) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'));

  const link = (r) => `<a href="${esc(r.href)}"${isOn(r.href) ? ' class="on" aria-current="page"' : ''}>
    <span class="ic">${r.icon}</span>
    <span class="tx"><span class="lb">${esc(r.label)}</span><span class="ht">${esc(r.hint)}</span></span></a>`;

  const nav = document.createElement('aside');
  nav.className = 'sidenav';
  nav.id = 'sidenav';
  nav.innerHTML = `
    <div class="sidenav-top">
      <span class="sidenav-brand">Nouvelage</span>
      <span class="sidenav-sub">Odoo 18</span>
    </div>
    <nav class="sidenav-list">
      <div class="sidenav-h">Reports</div>
      ${REPORTS.map(link).join('')}
      <div class="sidenav-h">Setup</div>
      ${SETUP.map(link).join('')}
    </nav>
    <div class="sidenav-foot">More reports land here as they are built.</div>`;

  const scrim = document.createElement('div');
  scrim.className = 'sidenav-scrim';

  document.body.insertBefore(scrim, document.body.firstChild);
  document.body.insertBefore(nav, document.body.firstChild);

  /* The toggle goes at the head of the control bar, where the panel icon sits in
     every other app that has one. */
  const toggle = document.createElement('button');
  toggle.className = 'navtoggle';
  toggle.type = 'button';
  toggle.innerHTML = PANEL_ICON;

  const bar = document.querySelector('.cbar-row');
  if (bar) bar.insertBefore(toggle, bar.firstChild);
  else document.body.insertBefore(toggle, nav);

  /* Narrow screens have no room to give up, so the sidebar overlays there and
     starts closed whatever the stored preference says. */
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;

  function apply(open) {
    root.classList.toggle('nav-closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Close sidebar' : 'Open sidebar';
    toggle.setAttribute('aria-label', toggle.title);
    // The tabs strip pins under the control bar, whose height can change when the
    // bar rewraps at a new width. Let the existing observer re-measure.
    window.dispatchEvent(new Event('resize'));
  }

  /* The stored state has to land before the first paint is animated, or every
     page load slides the sidebar in as though someone had just clicked it. */
  root.classList.add('nav-still');
  let open = narrow() ? false : localStorage.getItem(KEY) !== 'closed';
  apply(open);
  requestAnimationFrame(() => root.classList.remove('nav-still'));

  const set = (v) => {
    open = v;
    if (!narrow()) localStorage.setItem(KEY, v ? 'open' : 'closed');
    apply(v);
  };

  toggle.addEventListener('click', () => set(!open));
  scrim.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && narrow()) set(false);
  });
  // Coming back to a wide window should restore the stored preference.
  window.matchMedia('(max-width: 900px)').addEventListener('change', (e) => {
    apply(e.matches ? false : localStorage.getItem(KEY) !== 'closed');
    open = e.matches ? false : localStorage.getItem(KEY) !== 'closed';
  });
})();
