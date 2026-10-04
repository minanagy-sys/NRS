/* ============================================================
   "Target vs achieved" — one renderer, two reports.

   It was 113 lines inside `public/app.js`, drawing the NRS Targets tab. Mina
   asked for the same section, in the same shape, as tab 01 of the new Targets &
   Doctor Commission report. Copying it would have produced two versions of a
   table whose colouring rules, sort options and refusal text all have to agree
   — and they would have agreed exactly until the first time somebody edited
   one of them.

   So it moved here whole. `app.js` and `targets.js` both call `html()` and put
   the result where they want it; NRS appends its commission card afterwards,
   and the new report does not. THE MARKUP IS THE SAME OBJECT, not the same
   idea, which is the only version of "same shape" that survives a year.

   The sort preference is shared too, under one localStorage key: a reader who
   sorts by "furthest behind" on one page means it on the other.

   Loaded as a plain <script> before the page's own, so `TargetView` is a global
   — the CSP forbids inline script and every page already loads its JS this way.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TargetView = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (a, b) => (b ? (a / b) * 100 : 0);

  const TG_SORTS = [
    { key: 'mtd', label: 'MTD achieved — high to low', pick: (r) => r.mtdEx, dir: -1 },
    { key: 'target-desc', label: 'Monthly target — high to low', pick: (r) => r.monthlyTarget, dir: -1 },
    { key: 'target-asc', label: 'Monthly target — low to high', pick: (r) => r.monthlyTarget, dir: 1 },
    { key: 'pct-desc', label: 'vs target % — best first', pick: (r) => (r.monthlyTarget ? r.mtdPct : null), dir: -1 },
    { key: 'pct-asc', label: 'vs target % — furthest behind first', pick: (r) => (r.monthlyTarget ? r.mtdPct : null), dir: 1 },
    { key: 'range-desc', label: 'Selected range — high to low', pick: (r) => r.rangeEx, dir: -1 },
    { key: 'inv-desc', label: 'Invoices — most first', pick: (r) => r.mtdInvoices, dir: -1 },
    { key: 'name', label: 'Doctor name — A to Z', pick: (r) => r.name, dir: 1 },
  ];
  const TG_SORT_KEY = 'nrs-tgsort';
  /* Same reason as `wire`: under the harness this module has no `localStorage`
     either, and an unguarded read throws before the first sort can be read. */
  /* Through `window`, never the bare global: Node 26 ships its own global
     `localStorage` that prints an ExperimentalWarning the moment it is touched,
     so `typeof localStorage` under `require` reached for it. In a browser
     `window.localStorage` is the same object; the try covers a browser that
     blocks storage and throws on the getter. */
  const store = () => {
    try { return (typeof window !== 'undefined' && window.localStorage) || null; } catch { return null; }
  };

  const sortState = () => {
    let saved = {};
    try { saved = JSON.parse((store() || {}).getItem(TG_SORT_KEY) || '{}'); } catch { /* first run */ }
    const sort = TG_SORTS.some((s) => s.key === saved.sort) ? saved.sort : 'mtd';
    return { sort, flat: !!saved.flat };
  };
  const sortSave = (st) => {
    try { (store() || {}).setItem(TG_SORT_KEY, JSON.stringify(st)); } catch { /* private window */ }
  };

  function sortRows(rows, key) {
    const spec = TG_SORTS.find((s) => s.key === key) || TG_SORTS[0];
    return [...rows].sort((a, b) => {
      const x = spec.pick(a), y = spec.pick(b);
      /* null means "no target to measure" — always last, whichever way we sort */
      if (x === null && y === null) return String(a.name).localeCompare(String(b.name));
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === 'string') return spec.dir * x.localeCompare(y);
      if (x === y) return String(a.name).localeCompare(String(b.name)); // stable, readable ties
      return spec.dir * (x - y);
    });
  }

  /**
   * The section, as HTML.
   *
   *   html(T, { kicker: '01 — Target vs achieved', Rules })
   *
   * Returns a string and writes nothing, so the caller decides where it goes
   * and what follows it.
   */
  function html(T, opts) {
    const o = opts || {};
    const kicker = o.kicker || '04 — Targets';
    /* Anything the caller wants INSIDE the section, after the tables. NRS puts
       its commission card here; the new report passes nothing. Appending it
       after the returned string instead would move it outside `</section>`,
       which is a different document — caught by diffing the rendered markup
       against what NRS drew before this file existed. */
    const append = o.append || '';
    const Rules = o.Rules || { AMBER_FLOOR: 0.85 };
    if (!T || T.missing) {
      return `<section><div class="kicker">${esc(kicker)}</div>
        <h2 class="title">No target sheet for ${esc(T ? T.period : 'this month')}</h2>
        <p class="sub">Import the Approved Target Schedule for this period and the tab fills in.</p></section>`;
    }

    const SORT = sortState();

  const bar = (p, pace) =>
    `<div class="trk"><i style="width:${Math.min(100, p).toFixed(1)}%"></i><u style="left:${Math.min(100, pace).toFixed(1)}%"></u></div>`;

  let h = `<section>
    <div class="kicker">${esc(kicker)}</div>
    <h2 class="title">Target vs achieved</h2>
    <div class="tg-sum">
      <div class="tg-s inj"><div class="l">MTD vs monthly target</div><div class="p">${pct(T.mtdTotal, T.sheetTotal).toFixed(1)}%</div><div class="n">${fmt(T.mtdTotal)}<br>of ${fmt(T.sheetTotal)}</div><div class="b"><i style="width:${Math.min(100, pct(T.mtdTotal, T.sheetTotal)).toFixed(1)}%"></i><u style="left:${Math.min(100, T.pacePct).toFixed(1)}%"></u></div></div>
      <div class="tg-s las"><div class="l">Range vs pro-rata target</div><div class="p">${pct(T.rangeTotal, T.rangeTargetTotal).toFixed(1)}%</div><div class="n">${fmt(T.rangeTotal)}<br>of ${fmt(T.rangeTargetTotal)}</div><div class="b"><i style="width:${Math.min(100, pct(T.rangeTotal, T.rangeTargetTotal)).toFixed(1)}%"></i><u style="left:100%"></u></div></div>
      <div class="tg-s tot"><div class="l">Day ${T.dayNo} of ${T.daysInPeriod}</div><div class="p">${T.pacePct.toFixed(1)}%</div><div class="n">straight-line pace<br>${T.listedCount} of ${T.rosterCount} invoicing</div></div>
    </div>
    <div class="tg-note">Targets from <strong>${esc(T.sourceLabel || 'the imported sheet')}</strong>. Green = at or above pace · amber within ${Math.round(Rules.AMBER_FLOOR * 100)}% of it · red below. Daily target is <code>round(monthly ÷ ${T.daysInPeriod})</code>.</div>
    ${T.duplicates.length ? `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>${T.duplicates.length} doctor${T.duplicates.length === 1 ? ' has' : 's have'} more than one record in Odoo</strong> — ${T.duplicates.map((d) => esc(d.join(' + '))).join(' · ')}. Summed here; worth merging in Odoo so every report agrees.</div>` : ''}
    ${T.unresolved.length ? `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>${T.unresolved.length} doctor${T.unresolved.length === 1 ? '' : 's'} on the sheet with no invoices in this period</strong> — ${T.unresolved.map(esc).join(' · ')}. If one of them clearly did invoice, the sheet spells the name differently from Odoo and needs an alias.</div>` : ''}
    <div class="tg-tools">
      <input class="searchbox" id="tgSearch" placeholder="Search doctor…">
      <label class="tg-sort"><span>Sort</span>
        <select id="tgSort">${TG_SORTS.map((o) => `<option value="${o.key}"${o.key === SORT.sort ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      </label>
      <label class="tg-flat"><input type="checkbox" id="tgFlat"${SORT.flat ? ' checked' : ''}><span>One flat list</span></label>
    </div>
    <div class="tw"><table class="ltab"><thead><tr><th>Doctor</th><th class="n">Selected range</th><th class="n">MTD vs target</th><th class="n">Monthly target</th></tr></thead><tbody>`;

  /* Flat mode collapses the groups into one list so a sort can answer questions
     that cross them. The group name moves onto each row, because without it you
     cannot tell an Injectables doctor from a Laser one. */
  const groupsToRender = SORT.flat
    ? [{ name: null, rows: sortRows(T.groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.name }))), SORT.sort) }]
    : T.groups.map((g) => ({ ...g, rows: sortRows(g.rows, SORT.sort) }));

  for (const g of groupsToRender) {
    if (g.name) {
      h += `<tr style="background:var(--cream)"><td colspan="4" style="padding:9px 12px"><strong style="color:var(--espresso);font-size:11px;letter-spacing:.1em;text-transform:uppercase">${esc(g.name)}</strong><span style="font-size:11px;color:var(--muted)"> · ${g.rows.length}${g.unlistedCount ? ` of ${g.rosterCount}` : ''} invoicing · target ${fmt(g.target)} · MTD ${fmt(g.mtdEx)} (${pct(g.mtdEx, g.target).toFixed(1)}%)${g.unlistedCount ? ` · ${g.unlistedCount} with no sales holding ${fmt(g.unlistedTarget)}` : ''}</span></td></tr>`;
    } else {
      h += `<tr style="background:var(--cream)"><td colspan="4" style="padding:9px 12px"><strong style="color:var(--espresso);font-size:11px;letter-spacing:.1em;text-transform:uppercase">All ${g.rows.length} invoicing doctors</strong><span style="font-size:11px;color:var(--muted)"> · sorted by ${esc((TG_SORTS.find((o) => o.key === SORT.sort) || TG_SORTS[0]).label.toLowerCase())} · group totals are hidden in this view</span></td></tr>`;
    }

    for (const r of g.rows) {
      /* A doctor published at 0 is on the sheet but carries no number, which is
         a different thing from missing it badly. toneOf reads 0-of-0 as red, so
         say "no target" here rather than colouring them as failing — and leave
         toneOf alone, because branch Target 2 relies on that behaviour. */
      const noTarget = !r.monthlyTarget;
      h += `<tr data-tg><td><div class="nm">${esc(r.name)}${r.via ? ` <span class="pill" title="Resolved through an alias">→ ${esc(r.via)}</span>` : ''}${r.mergedFrom ? ` <span class="pill" title="${esc(r.mergedFrom.join(' + '))}">merged ${r.mergedFrom.length}</span>` : ''}${!r.matched ? ' <span class="pill" style="background:rgba(201,138,46,.14);color:#c98a2e">no invoices</span>' : ''}${noTarget ? ' <span class="pill" style="background:rgba(176,80,60,.14);color:#b0503c">no target</span>' : ''}</div><div class="sm2">${SORT.flat && r.group ? `<strong>${esc(r.group)}</strong> · ` : ''}${r.mtdInvoices} inv MTD${r.prevMonth ? ` · ${fmt(r.prevMonth)} prev month` : ''}</div></td>
        <td class="n tcell">${noTarget ? `<b>${fmt(r.rangeEx)}</b><small>invoiced ex-VAT</small>`
        : `<b class="${r.rangeTone}">${r.rangePct.toFixed(0)}%</b><small>${fmt(r.rangeEx)} / ${fmt(r.rangeTarget)}</small>`}</td>
        <td class="n tcell">${noTarget ? '<b>—</b><small>no target to measure</small>'
        : `<b class="${r.mtdTone}">${r.mtdPct.toFixed(1)}%</b><small>${fmt(r.mtdEx)} / ${fmt(r.monthlyTarget)}</small>${bar(r.mtdPct, T.pacePct)}`}</td>
        <td class="n tcell">${noTarget ? '<b>—</b><small>published at zero</small>'
        : `<b>${fmt(r.monthlyTarget)}</b><small>${fmt(r.perDay)} / day</small>`}</td></tr>`;
    }
  }

  /* Doctors invoicing with no approved target, in the same table so they are
     seen and searchable rather than stranded in a footnote below the branches.
     They deliberately enter no group total: the group figures are authoritative
     and the sheet has to keep cross-footing, so this section sits outside them. */
  if (T.offSheet.length) {
    const invoiced = T.offSheet.reduce((s, d) => s + d.ex, 0);
    h += `<tr style="background:var(--cream)"><td colspan="4" style="padding:9px 12px"><strong style="color:#b0503c;font-size:11px;letter-spacing:.1em;text-transform:uppercase">No approved target</strong><span style="font-size:11px;color:var(--muted)"> · ${T.offSheet.length} invoicing · ${fmt(invoiced)} in this range · not counted in any group total. <strong>Export</strong> gives them a target for next month.</span></td></tr>`;

    /* These carry no target, so only the value and name keys mean anything here.
       Anything else falls back to value descending rather than pretending to
       honour a sort it cannot express. */
    const offSorted = SORT.sort === 'name'
      ? [...T.offSheet].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      : SORT.sort === 'inv-desc'
        ? [...T.offSheet].sort((a, b) => b.invoices - a.invoices)
        : [...T.offSheet].sort((a, b) => b.ex - a.ex);
    for (const d of offSorted) {
      h += `<tr data-tg><td><div class="nm">${esc(d.name)} <span class="pill" style="background:rgba(176,80,60,.14);color:#b0503c">no target</span></div><div class="sm2">${fmt(d.invoices)} inv${d.branches && d.branches.length ? ` · ${esc(d.branches.slice(0, 3).join(', '))}` : ''}</div></td>
        <td class="n tcell"><b>${fmt(d.ex)}</b><small>invoiced ex-VAT</small></td>
        <td class="n tcell"><b>—</b><small>no target to measure</small></td>
        <td class="n tcell"><b>—</b><small>not on the schedule</small></td></tr>`;
    }
  }

  h += `</tbody></table></div>`;

  if (T.unlistedTotal) {
    const namedSum = T.noSales.reduce((s, d) => s + d.monthlyTarget, 0);
    h += `<h3 class="subtitle">On the sheet, no sales this month</h3>
      <p class="sub">${T.rosterCount - T.listedCount} roster members hold <strong>${fmt(T.unlistedTotal)}</strong> of the ${fmt(T.sheetTotal)} sheet total. ${T.noSales.length} are named in the source; the remaining ${fmt(T.unlistedTotal - namedSum)} across ${T.rosterCount - T.listedCount - T.noSales.length} is not attributed to anyone in it.</p>
      <div class="tw"><table class="ltab"><thead><tr><th>Doctor</th><th class="n">Monthly target</th></tr></thead><tbody>${
        T.noSales.map((d) => `<tr><td class="nm">${esc(d.name)}</td><td class="n">${fmt(d.monthlyTarget)}</td></tr>`).join('')
      }</tbody></table></div>`;
  }


    return `${h}${append}</section>`;
  }

  /**
   * Wire the sort and flat controls.
   *
   * `redraw` is the page's own re-render, because the two pages put this
   * section in different elements. It re-renders from the payload in memory
   * rather than refetching: the ordering is a reader's preference, not new
   * data, and a round trip against a cache that moves under you would change
   * the figures as well as the order.
   */
  function wire(redraw, doc) {
    /* `doc` rather than the global. This file is a <script> in the browser but
       a `require` under the test harness, where it sits OUTSIDE the sandbox and
       cannot see its `document` — reaching for the global threw "document is
       not defined" and took every panel after Targets down with it. */
    const d = doc || (typeof document === 'undefined' ? null : document);
    if (!d) return;
    const sel = d.getElementById('tgSort');
    if (sel) sel.addEventListener('change', () => { sortSave({ ...sortState(), sort: sel.value }); redraw(); });
    const flat = d.getElementById('tgFlat');
    if (flat) flat.addEventListener('change', () => { sortSave({ ...sortState(), flat: flat.checked }); redraw(); });
  }

  return { html, wire, SORTS: TG_SORTS, sortState, sortSave, sortRows };
});
