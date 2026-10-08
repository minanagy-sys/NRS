/* ============================================================
   Targets & Commission — the controller.

   One report, two halves. The switch above the tabs chooses which half you are
   in; the tab strip underneath is the intersection of that half's panels with
   the ones the current scope can answer. Narrow to a single doctor and Branch
   targets disappears, because there is no such thing as a doctor's branch
   target — it is not hidden to tidy up, it is hidden because the question does
   not apply.

   THE OLD /commission URL LANDS HERE, on #commission. That is why the hash is
   read on boot.
   ============================================================ */
(function () {
  'use strict';

  const C = window.TgcCore;
  const { $, ST } = C;

  /* Which panels belong to which half. `dp` is in the markup and deliberately
     not here: the day plan folded into What's happening, and two ways to ask
     the same question is one too many. */
  /* The tab strip, in the dashboard's order and numbering — What's happening,
     Actuals, Branch targets, Target plan, Service targets, Doctors, Target
     file, Overview. The markup declares them in a different order; the strip is
     rebuilt from this list rather than reordered by hand, so the numbers and
     the sequence cannot drift apart. */
  const TAB_ORDER = [
    ['wh', '00', "What's happening"],
    ['ac', '01', 'Actuals'],
    ['tb', '02', 'Branch targets'],
    ['tp', '03', 'Target plan'],
    ['ts', '04', 'Service targets'],
    ['dr', '05', 'Doctors'],
    ['tf', '06', 'Target file'],
    ['ov', '07', 'Overview'],
  ];
  const CM_ORDER = [
    ['cm', '01', 'Summary'],
    ['cmd', '02', 'Doctors'],
    ['cms', '03', 'Staff'],
    ['cmc', '04', 'Call center'],
    ['cp', '05', 'Policy'],
  ];

  const PAGES = {
    t: TAB_ORDER.map((t) => t[0]),
    c: CM_ORDER.map((t) => t[0]),
  };

  /**
   * Which controls belong to which tab, and what to call them in the header.
   *
   * The dashboard put every filter in the header bar and showed only the group
   * belonging to the open tab, rather than repeating a control row inside each
   * panel. The elements are the ones the panels already populate — they are
   * MOVED here rather than duplicated, so there is still one of each and the
   * wiring that fills them does not have to know where they ended up.
   */
  /**
   * Which controls ride in the header bar for each panel, and under what label
   * — the groups the dashboard showed, in its order.
   *
   * They sit in the HEADER rather than inside the panel because the dates sit
   * there too: changing "which tier" is the same kind of question as "which
   * days", and both re-state every figure below.
   */
  const FILTERS = {
    wh: [['Brand', 'whBrand'], ['Show', 'whViewSlot'], ['Doctors grouped', 'whSortSlot'],
      ['Tier', 'gTierWh'], ['Branch', 'whBranch']],
    ac: [['Show', 'acMode'], ['Tier', 'gTierAc']],
    tp: [['Show', 'tpShow'], ['Tier', 'gTierTp']],
    tb: [['View', 'tbMode'], ['Branch', 'tbOne'], ['Brand', 'tbBrand']],
    ts: [['Branch', 'tsBr']],
    dr: [['View', 'drMode'], ['Branch', 'drBr'], ['Doctor', 'drOne']],
    cp: [['Section', 'cpSection']],
    cmd: [['Search', 'cmdQ']],
  };

  /**
   * The tier pickers. One per panel that offers it, all reading and writing the
   * SAME `ST.tier`, so a reader who sets 90% on Actuals and switches to the
   * plan is still reading 90% — three independent pickers would let the two
   * views disagree without anyone noticing.
   */
  const TIER_IDS = ['gTierWh', 'gTierAc', 'gTierTp'];

  function tierChips() {
    const levels = ((ST.ref && ST.ref.policy && ST.ref.policy.levels) || []).map((l) => l.level);
    for (const id of TIER_IDS) {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tg-chips';
        el.id = id;
        document.body.appendChild(el);
      }
      el.innerHTML = levels.map((l) => `<button class="chip${l === ST.tier ? ' on' : ''}" data-tier="${l}">${l}%</button>`).join('');
      el.querySelectorAll('[data-tier]').forEach((b) => b.addEventListener('click', () => {
        ST.tier = Number(b.getAttribute('data-tier'));
        tierChips();
        repaint();
      }));
    }
  }

  /**
   * The header controls the dashboard shows that have no home in the markup:
   * the tier pickers, What's happening's branch select, the Target plan's Show
   * switch and the Policy section chips. Built detached; `placeFilters` moves
   * each into its labelled group.
   */
  function ensureControls() {
    tierChips();

    const mk = (id, tag, cls) => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement(tag);
        if (cls) el.className = cls;
        el.id = id;
        document.body.appendChild(el);
      }
      return el;
    };

    /* What's happening: one branch, or all of them. */
    const wb = mk('whBranch', 'select');
    const names = C.branchNames().filter(C.inScope);
    const cur = (window.TgcWh && window.TgcWh.VIEW.branch) || '';
    wb.innerHTML = `<option value="">All branches</option>${
      names.map((n) => `<option value="${C.esc(n)}"${n === cur ? ' selected' : ''}>${C.esc(n)}</option>`).join('')}`;
    if (!wb.dataset.wired) {
      wb.dataset.wired = '1';
      wb.addEventListener('change', () => {
        if (window.TgcWh) window.TgcWh.VIEW.branch = wb.value;
        repaint();
      });
    }

    /* Target plan: branches or doctors. */
    const tp = mk('tpShow', 'div', 'tg-chips');
    tp.innerHTML = [['branch', 'Branches'], ['doctor', 'Doctors']]
      .map(([v, l]) => `<button class="chip${(ST.planShow || 'branch') === v ? ' on' : ''}" data-show="${v}">${l}</button>`).join('');
    tp.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
      ST.planShow = b.getAttribute('data-show');
      ensureControls();
      repaint();
    }));

    /* Policy: which part of it to read. */
    const SECTIONS = [['all', 'All teams'], ['branch', 'Branch team'], ['doctors', 'Doctors and specialists'],
      ['cc', 'Call center'], ['mgmt', 'Management layer'], ['rules', 'General rules']];
    const cp = mk('cpSection', 'div', 'tg-chips');
    cp.innerHTML = SECTIONS.map(([v, l]) => `<button class="chip${(ST.policySection || 'all') === v ? ' on' : ''}" data-sec="${v}">${l}</button>`).join('');
    cp.querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', () => {
      ST.policySection = b.getAttribute('data-sec');
      ensureControls();
      repaint();
    }));
  }

  /* Which panels a scope can answer. `all` means every panel in the half. */
  const TABS_FOR = {
    all: null,
    area: ['wh', 'tb', 'tp', 'ts', 'dr', 'cm', 'cmd', 'cms'],
    branch: ['wh', 'tb', 'tp', 'ts', 'dr', 'cm', 'cmd', 'cms'],
    doctor: ['wh', 'tp', 'dr', 'cm', 'cmd'],
  };

  const PANELS = {
    /* The panel's own date row moves the whole page rather than just itself, so
       the header bar and the panel can never show different ranges. */
    wh: () => window.TgcWh.render((from, to) => {
      $('gSeg').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      load();
    }),
    ov: () => window.TgcOv.render(),
    ac: () => window.TgcAc.render(),
    tb: () => window.TgcTb.render(),
    ts: () => window.TgcTs.render(),
    dr: () => window.TgcDr.render(),
    tf: () => window.TgcTf.render(),
    tp: () => planGrid(),
    cm: () => window.TgcCm.render(),
    cmd: () => window.TgcCm.render(),
    cms: () => window.TgcCm.render(),
    cmc: () => window.TgcCm.render(),
    cp: () => window.TgcCm.render(),
  };

  /* ---- the tab strip ----
     The commission half needs five tabs the markup does not carry, because the
     page it came from built them at runtime. Same here, once. */
  /**
   * Rebuild the tab strip from TAB_ORDER and CM_ORDER.
   *
   * The markup declares the tabs in the order the panels happen to sit in the
   * document, which is not the order they are read in. Rebuilding beats
   * reordering by hand: the number and the position come from one list, so a
   * tab cannot end up labelled 05 in fourth place.
   */
  function buildTabs() {
    const tabs = $('tabs');
    const mk = (id, n, label) => {
      const b = document.createElement('button');
      b.className = 'tab';
      b.dataset.panel = id;
      b.innerHTML = `<span class="tab-num">${n}</span>${label}`;
      b.addEventListener('click', () => show(id));
      return b;
    };
    tabs.innerHTML = '';
    [...TAB_ORDER, ...CM_ORDER].forEach(([id, n, label]) => tabs.appendChild(mk(id, n, label)));

    /* The kicker at the top of each panel carries its own number, written into
       the markup before the strip was reordered. Restated from the same list,
       so a panel headed "06 — Overview" cannot sit behind a tab numbered 07. */
    [...TAB_ORDER, ...CM_ORDER].forEach(([id, n, label]) => {
      const panel = document.getElementById(id);
      const kicker = panel && panel.querySelector('.kicker');
      if (kicker) kicker.textContent = `${n} — ${label}`;
    });
  }

  /* ---- the filters live in the header, not in the panels ----
     Each control is MOVED out of its panel into a labelled group under the
     date bar, and only the open tab's group is shown. One of each control
     still exists, so the code that populates them is unchanged and cannot
     drift from the copy on screen. */
  function placeFilters() {
    const prow = $('prow');
    if (!prow) return;
    ensureControls();
    for (const [panel, controls] of Object.entries(FILTERS)) {
      let group = prow.querySelector(`.fgrp[data-for="${panel}"]`);
      if (!group) {
        group = document.createElement('div');
        group.className = 'fgrp';
        group.dataset.for = panel;
        prow.appendChild(group);
      }
      for (const [label, id] of controls) {
        const el = document.getElementById(id);
        /* Already moved by an earlier render — re-wrapping it would leave the
           first wrapper behind as an empty labelled box. */
        if (!el || prow.contains(el)) continue;
        const cell = document.createElement('div');
        cell.className = 'fgrp';
        cell.dataset.for = panel;
        const tag = document.createElement('span');
        tag.className = 'fl';
        tag.textContent = label;
        cell.appendChild(tag);
        cell.appendChild(el);
        el.hidden = false;
        prow.appendChild(cell);
      }
      if (!group.childNodes.length) group.remove();
    }
    syncFilters();
  }

  /**
   * Export the open panel's tables.
   *
   * CSV from a Blob rather than a workbook built in the browser: the page the
   * dashboard came from used SheetJS off a CDN, which this app's CSP forbids
   * outright. Where a real workbook is the point — the target file — Export
   * goes to the server endpoint that already writes one.
   */
  function downloadCsv(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const cell = (td) => {
      const t = (td.innerText || '').replace(/\s+/g, ' ').trim();
      return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const parts = [];
    panel.querySelectorAll('table').forEach((table, i) => {
      if (i) parts.push('');
      table.querySelectorAll('tr').forEach((tr) => {
        parts.push([...tr.children].map(cell).join(','));
      });
    });
    if (!parts.length) return;
    const blob = new Blob([parts.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nouvelage-${panelId}-${ST.range.from}-${ST.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Show only the open tab's groups. */
  function syncFilters() {
    const active = document.querySelector('.panel.active');
    const id = active ? active.id : '';
    $('prow').querySelectorAll('.fgrp').forEach((g) => { g.hidden = g.dataset.for !== id; });
    /* Two panels have no date range to speak of — the target file and the
       policy are documents, not a window onto a period — so the bar above
       them is noise. */
    $('gbar').hidden = id === 'tf' || id === 'cp';
  }

  function show(id) {
    $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === id));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
    try {
      if (PANELS[id]) PANELS[id]();
    } catch (e) {
      console.error(`panel ${id}`, e);
    }
    /* After the panel has drawn — its render is what creates the chips the
       header is about to show, and the sections the folds attach to. */
    placeFilters();
    collapsible();
  }

  /** A tab is visible when its half is showing AND the scope can answer it. */
  function applyTabs() {
    const allow = TABS_FOR[ST.scope.type];
    $('tabs').querySelectorAll('.tab').forEach((t) => {
      const id = t.dataset.panel;
      if (id === 'dp') { t.hidden = true; return; }
      t.hidden = !(PAGES[ST.page].includes(id) && (!allow || allow.includes(id)));
    });
    const active = document.querySelector('.panel.active');
    if (!active || !PAGES[ST.page].includes(active.id) || (allow && !allow.includes(active.id))) {
      const first = [...$('tabs').querySelectorAll('.tab')].find((t) => !t.hidden);
      if (first) show(first.dataset.panel);
    }
  }

  function showPage(p) {
    ST.page = p;
    $('pswitch').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    applyTabs();
  }

  /**
   * The target plan, now to the end of the plan — every branch against every
   * month, with the doctors under each group.
   *
   * READ ONLY HERE, deliberately. Editing a target is a publish: the sheet has
   * to reconcile, the change has to be audited, and it needs the passphrase.
   * All three live in Admin, and a second editable grid on a reporting page
   * would have to re-implement every one of those refusals to be safe.
   */
  function planGrid() {
    if (!ST.ref) return;
    const { esc, fmt } = C;
    const branches = (ST.ref.branches || []).filter((b) => C.inScope(b.name));
    const months = [...new Set(branches.flatMap((b) => Object.keys(C.branchPlan(b.name))))].sort()
      .filter((m) => m >= ST.today.slice(0, 7));

    $('tpSub').textContent = months.length
      ? `${months[0]} to ${months[months.length - 1]} · ${branches.length} branches. Change a cell, then Save plan.`
      : 'The plan does not reach past today.';

    const colTot = months.map((m) => C.S(branches.map((b) => C.branchPlan(b.name)[m] || 0)));
    $('tpT').innerHTML = `<thead><tr><th>Branch</th>${
      months.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead><tbody>${
      branches.map((b) => {
        const row = months.map((m) => C.branchPlan(b.name)[m] || 0);
        return `<tr data-branch="${b.id}"><td class="nm">${esc(b.name)}<span class="m">${esc(b.brand)}</span></td>${
          months.map((m, i) => `<td><input class="tp-in" type="text" inputmode="numeric"
            data-branch="${b.id}" data-month="${m}" value="${row[i] ? Math.round(row[i]) : ''}"
            aria-label="${esc(b.name)} ${m}"></td>`).join('')
        }<td class="t100" data-total="${b.id}">${fmt(C.S(row))}</td></tr>`;
      }).join('') || `<tr><td class="nm" colspan="${months.length + 2}">Nothing in scope.</td></tr>`
    }<tr class="total"><td>Total</td>${colTot.map((v) => `<td>${fmt(v)}</td>`).join('')}
      <td>${fmt(C.S(colTot))}</td></tr></tbody>`;

    wirePlanEdits(months);
  }

  /** Cells changed since the last save, keyed branchId|period. */
  const PLAN_EDITS = new Map();

  function wirePlanEdits(months) {
    const save = $('tpSave');
    const undo = $('tpUndo');
    const st = $('tpSt');

    const mark = () => {
      const n = PLAN_EDITS.size;
      save.hidden = n === 0;
      undo.hidden = n === 0;
      save.textContent = n ? `Save plan (${n} cell${n === 1 ? '' : 's'})` : 'Save plan';
      if (n) st.textContent = 'Unsaved changes. Saving a target changes what people are paid against, so it needs the admin passphrase.';
    };

    $('tpT').querySelectorAll('.tp-in').forEach((input) => {
      if (input.dataset.wired) return;
      input.dataset.wired = '1';
      const was = input.value;
      input.addEventListener('input', () => {
        const key = `${input.dataset.branch}|${input.dataset.month}`;
        /* BLANK IS NOT ZERO. A month with no target and a month whose target is
           nothing are different claims — the writer deletes on blank, and the
           report colours them differently. */
        if (input.value.trim() === was.trim()) PLAN_EDITS.delete(key);
        else PLAN_EDITS.set(key, input.value.trim());
        input.classList.toggle('chg', PLAN_EDITS.has(key));
        mark();
      });
    });

    if (!save.dataset.wired) {
      save.dataset.wired = '1';
      save.addEventListener('click', () => savePlan());
      undo.addEventListener('click', () => { PLAN_EDITS.clear(); planGrid(); $('tpSt').textContent = 'Changes discarded.'; });
    }
    mark();
  }

  async function savePlan() {
    const st = $('tpSt');
    const cells = [...PLAN_EDITS.entries()].map(([k, v]) => {
      const [branchId, period] = k.split('|');
      return {
        branchId: Number(branchId),
        year: Number(period.slice(0, 4)),
        month: Number(period.slice(5, 7)),
        target: v.replace(/[, ]/g, ''),
      };
    });
    if (!cells.length) return;

    st.textContent = 'Saving…';
    const put = async () => fetch('/api/plan/targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ cells }),
    });

    let res = await put();
    if (res.status === 403) {
      /* Ask for the passphrase HERE rather than sending the reader to Admin and
         losing the edits they just made. */
      const pass = window.prompt('Admin passphrase to publish this change:');
      if (!pass) { st.textContent = 'Not saved — the passphrase is needed to change a target.'; return; }
      const un = await fetch('/auth/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ passphrase: pass }),
      });
      if (!un.ok) { st.textContent = 'That passphrase was not accepted. Nothing was saved.'; return; }
      res = await put();
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      st.textContent = `Not saved: ${body.error || res.status}`;
      return;
    }
    PLAN_EDITS.clear();
    st.textContent = `Saved ${cells.length} cell${cells.length === 1 ? '' : 's'}. Reloading the plan…`;
    ST.ref = await C.api('/api/tgc/reference');
    planGrid();
    heroStats();
    st.textContent = `Saved ${cells.length} cell${cells.length === 1 ? '' : 's'}.`;
  }

  /* ---- the global bar: presets, a date range, scope ---- */
  const PRESETS = [
    ['today', 'Today'], ['yday', 'Yesterday'], ['l7', 'Last 7'],
    ['mtd', 'This month'], ['lm', 'Last month'], ['ytd', 'This year'],
  ];

  function presetRange(p) {
    const d = new Date(`${ST.today}T12:00:00`);
    const y = d.getFullYear();
    const m = d.getMonth();
    const iso = C.iso;
    const back = (n) => { const x = new Date(d); x.setDate(x.getDate() - n); return iso(x); };
    return {
      today: [ST.today, ST.today],
      yday: [back(1), back(1)],
      l7: [back(6), ST.today],
      mtd: [iso(new Date(y, m, 1)), ST.today],
      lm: [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
      ytd: [iso(new Date(y, 0, 1)), ST.today],
    }[p];
  }

  function buildBar() {
    $('gbar').innerHTML = `
      <span class="gl">Range</span>
      <div class="seg" id="gSeg">${PRESETS.map(([k, l]) => `<button data-p="${k}">${l}</button>`).join('')}</div>
      <div class="gdates"><input type="date" id="gFrom" aria-label="From"><span class="arrow">→</span><input type="date" id="gTo" aria-label="To"></div>
      <button class="gbtn pri" id="gShow">Show</button>
      <div class="gsum" id="gSum"></div>`;

    $('gact').innerHTML = `
      <select id="gScope" aria-label="Viewing as"></select>
      <div class="gstat"><span class="dot off" id="gDot"></span><span id="gSync">loading…</span></div>
      <button class="gbtn" id="gSyncNow"><span class="ic">↻</span>Sync now</button>
      <button class="gbtn" id="gExp"><span class="ic">↓</span>Export</button>`;

    /* Sync now pulls the open range from Odoo through the app's own endpoint —
       the page never talks to the MCP itself. */
    $('gSyncNow').addEventListener('click', async () => {
      const btn = $('gSyncNow');
      btn.disabled = true;
      $('gSync').textContent = 'syncing…';
      $('gSum').textContent = `Pulling ${ST.range.from} → ${ST.range.to} from Odoo…`;
      try {
        const res = await fetch('/api/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify({ from: ST.range.from, to: ST.range.to }),
        });
        const out = await res.json().catch(() => ({}));

        /* THE ANSWER HAS TO BE READ. `fetch` resolves on 401 and 503 just as
           happily as on 200, so awaiting it and reloading made a failed sync
           look like a sync that changed nothing — which is the worst of the
           three outcomes, because the reader carries on believing the figures
           are fresh. The endpoint words its errors by layer (an expired
           sign-in, Odoo not answering, the MCP unreachable) precisely so they
           can be shown; so they are. */
        if (!res.ok || out.error) {
          $('gDot').className = 'dot off';
          $('gSync').textContent = 'sync failed';
          $('gSum').innerHTML = `<b>Nothing was synced.</b> ${C.esc(out.error || `The server answered ${res.status}.`)}`;
          return;
        }

        await load();
        $('gSync').textContent = syncStatus();
        const n = out.invoices == null ? null : out.invoices;
        $('gSum').innerHTML = `<b>Synced ${C.esc(ST.range.from)} → ${C.esc(ST.range.to)}</b>`
          + `${n == null ? '' : ` · ${n.toLocaleString()} invoice${n === 1 ? '' : 's'} pulled`}`
          + `${out.lines == null ? '' : ` · ${Number(out.lines).toLocaleString()} lines`}`;
      } catch (e) {
        $('gDot').className = 'dot off';
        $('gSync').textContent = 'sync failed';
        $('gSum').innerHTML = `<b>Nothing was synced.</b> ${C.esc(e.message)}`;
      } finally { btn.disabled = false; }
    });

    /* Export hands the open panel's tables to the server, which already knows
       how to write a workbook Excel opens without a repair prompt. */
    $('gExp').addEventListener('click', () => {
      const active = document.querySelector('.panel.active');
      const id = active ? active.id : 'wh';
      if (id === 'tf') { location.href = `/api/targets/${ST.range.to.slice(0, 7)}/next-month.xlsx`; return; }
      downloadCsv(id);
    });

    $('gSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const [from, to] = presetRange(b.dataset.p);
      $('gFrom').value = from;
      $('gTo').value = to;
      $('gSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      load();
    }));
    $('gShow').addEventListener('click', () => {
      $('gSeg').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      load();
    });
  }

  function buildScope() {
    const sel = $('gScope');
    const esc = C.esc;
    const areas = C.areas();
    sel.innerHTML = `<option value="all|">Viewing as: owner, everything</option>`
      + (areas.length ? `<optgroup label="Area">${areas.map((a) => `<option value="area|${esc(a)}">${esc(a)}</option>`).join('')}</optgroup>` : '')
      + `<optgroup label="Branch">${C.branchNames().map((b) => `<option value="branch|${esc(b)}">${esc(b)}</option>`).join('')}</optgroup>`
      + `<optgroup label="Doctor">${Object.keys(ST.ref.doctorPlan || {}).sort().map((d) => `<option value="doctor|${esc(d)}">${esc(d)}</option>`).join('')}</optgroup>`;
    sel.onchange = () => {
      const [type, value] = sel.value.split('|');
      ST.scope = { type, value: value || '' };
      badge();
      applyTabs();
      repaint();
      syncFilters();
    };
  }

  /** The scope badge under the title, and the body class the CSS keys off. */
  function badge() {
    let el = document.getElementById('scopeBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scopeBadge';
      el.className = 'scope-badge';
      document.querySelector('.header-sub').after(el);
    }
    const on = ST.scope.type !== 'all';
    document.body.classList.toggle('scoped', on);
    el.hidden = !on;
    if (on) el.innerHTML = `${C.esc(ST.scope.type)} view · <b>${C.esc(ST.scope.value)}</b>`;
  }

  /* ---- the header figures ---- */
  /**
   * The four figures in the header, as the dashboard stated them: what 2026 has
   actually done, where it is expected to close, what Q4 has to be, and 2027.
   *
   * None of them move with the date range — they are the year, not the window —
   * which is why they sit above the range bar rather than inside it.
   */
  function heroStats() {
    const Ov = window.TgcOv;
    if (!Ov) return;
    const a26 = Ov.actualYear(2026);
    const close = Ov.close2026(a26);
    const ytd = C.S(a26.map((v) => v || 0));
    const names = C.branchNames().filter(C.inScope);
    const planFor = (keys) => C.S(keys.map((k) => C.S(names.map((n) => C.branchPlan(n)[k] || 0))));
    const TQ = planFor(['2026-10', '2026-11', '2026-12']);
    const T27 = planFor(Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`));

    const live = ST.per && ST.per.sources && ST.per.sources.cache.invoices;
    $('heroStats').innerHTML = [
      ['2026 to date', C.fm(ytd), live ? 'ex-VAT actual · cache live' : 'ex-VAT actual'],
      ['2026 expected', C.fm(close.total), 'trend forecast'],
      ['Q4 2026 target', C.fm(TQ), 'Oct – Dec · 100%'],
      ['2027 target', C.fm(T27), '100% tier'],
    ].map(([l, v, s]) => `<div class="hero-stat"><div class="lbl">${C.esc(l)}</div>
      <div class="val">${v}<small>${C.esc(s)}</small></div></div>`).join('');
  }

  function repaint() {
    heroStats();
    const active = document.querySelector('.panel.active');
    if (active && PANELS[active.id]) {
      try { PANELS[active.id](); } catch (e) { console.error(e); }
    }
    /* The panel that is already open on first paint never goes through
       `show()` — the markup ships it with `class="panel active"` — so the
       filters and the folds have to be applied here as well, or the header
       stays empty and the sections stay unfoldable until somebody clicks a
       second tab. */
    placeFilters();
    collapsible();
  }

  /**
   * How current the figures are, in the dashboard's own words.
   *
   * "Live from the cache" was my phrasing and it was the wrong promise: the
   * page reads Postgres, and Postgres is exactly as fresh as the last sync.
   * A reader needs the AGE, not the architecture — so this says "synced 4 min
   * ago", or "not synced yet" when the cache is empty, which is what the
   * dashboard said.
   */
  function syncStatus() {
    const cache = ST.per && ST.per.sources && ST.per.sources.cache;
    if (!cache || !cache.invoices) return 'not synced yet';
    const last = cache.lastSync;
    if (!last || !last.at) return `cache holds ${cache.invoices.toLocaleString()} invoices`;
    const mins = Math.round((Date.now() - new Date(last.at).getTime()) / 60000);
    if (mins < 1) return 'synced just now';
    if (mins < 60) return `synced ${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `synced ${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    return `synced ${Math.round(hrs / 24)} day${Math.round(hrs / 24) === 1 ? '' : 's'} ago`;
  }

  /**
   * Every section heading folds what sits under it, until the next heading.
   *
   * A generic pass rather than markup, exactly as the dashboard did it: the
   * headings are not written to be collapsible, they are MADE collapsible, so a
   * panel gaining a section gets the behaviour without anybody remembering to
   * add it.
   *
   * The open/closed state is remembered per heading, because a reader who folds
   * the commission tier table away is saying "not this, every time" — reopening
   * it on every visit ignores them.
   *
   * Clicks that land on a control inside the heading are left alone; a chip row
   * sitting beside a title should not fold the section when it is used.
   */
  const UIST = (() => {
    try { return JSON.parse(localStorage.getItem('nv_ui') || '{}'); } catch { return {}; }
  })();
  const uiSave = () => { try { localStorage.setItem('nv_ui', JSON.stringify(UIST)); } catch { /* private mode */ } };

  function collapsible() {
    document.querySelectorAll('.panel h3.subtitle').forEach((h) => {
      if (h.dataset.coll) return;
      const body = document.createElement('div');
      body.className = 'coll-body';
      let n = h.nextElementSibling;
      while (n && !(n.tagName === 'H3' && n.classList.contains('subtitle')) && !n.classList.contains('coll-body')) {
        const next = n.nextElementSibling;
        body.appendChild(n);
        n = next;
      }
      h.after(body);
      h.dataset.coll = '1';
      h.classList.add('coll');
      h.setAttribute('role', 'button');
      h.tabIndex = 0;

      const key = `${(h.closest('.panel') || {}).id}|${h.textContent.trim().slice(0, 40)}`;
      const set = (closed) => {
        h.classList.toggle('closed', closed);
        body.classList.toggle('closed', closed);
        h.setAttribute('aria-expanded', String(!closed));
      };
      set(Boolean(UIST[`c:${key}`]));

      const toggle = (e) => {
        if (e.target.closest('button:not(.coll),select,input,.chip,a')) return;
        const closed = !h.classList.contains('closed');
        set(closed);
        UIST[`c:${key}`] = closed;
        uiSave();
      };
      h.addEventListener('click', toggle);
      h.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      });
    });
  }

  /* ---- loading ---- */
  async function load() {
    const from = $('gFrom').value;
    const to = $('gTo').value;
    if (!from || !to) return;
    if (from > to) { $('gSum').textContent = 'The range starts after it ends.'; return; }
    ST.range = { from, to };
    $('gDot').className = 'dot off';
    $('gSync').textContent = 'loading…';
    try {
      /* Two answers, one range. The commission half is scored by the app's own
         engine — this page renders it, it does not recompute it. */
      const [per, cm] = await Promise.all([
        C.api(`/api/tgc/period?from=${from}&to=${to}`),
        C.api(`/api/commission-month?from=${from}&to=${to}`).catch((e) => ({ missing: e.message })),
      ]);
      ST.per = per;
      ST.cm = cm;
      $('gDot').className = 'dot';
      const src = ST.per.sources;
      $('gSync').textContent = syncStatus();
      $('gSum').innerHTML = `<b>${C.fmt(ST.per.totals.billed)}</b> billed ex-VAT · ${ST.per.totals.invoices || 0} invoices`;
      repaint();
    } catch (e) {
      $('gSync').textContent = 'could not load';
      $('gSum').textContent = e.message;
    }
  }

  async function boot() {
    buildTabs();
    buildBar();

    const [from, to] = presetRange('mtd');
    $('gFrom').value = from;
    $('gTo').value = to;
    $('gSeg').querySelector('[data-p="mtd"]').classList.add('on');

    try {
      ST.ref = await C.api('/api/tgc/reference');
    } catch (e) {
      $('gSum').textContent = `Could not load the plan: ${e.message}`;
      return;
    }
    buildScope();
    badge();

    /* /commission redirects here with #commission, which is the whole reason
       the old URL could be kept rather than broken. */
    if (location.hash === '#commission') showPage('c');
    else showPage('t');

    $('pswitch').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => showPage(b.dataset.p));
    });

    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
