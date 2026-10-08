/* ============================================================
   04 — Service targets. What each service has to bring in, for the branch and
   the dates picked above.

   THE SPLIT IS PER BRANCH, NEVER POOLED. Each branch's target is multiplied by
   THAT branch's own service shape and only then summed. Pooling the shape first
   would hand a laser-led branch an injectables target it has no way to bill.

   TWO DIVISORS, DELIBERATELY DIFFERENT, because the dashboard used two and the
   figures have to match it:
     the header's "per day" divides the range total by the DAYS IN THE RANGE;
     each service card's "per day" divides by the DAYS IN THE MONTH, which is
       the rate that service has to hold all month, not just today.
   They disagree on a one-day range by design, and both are labelled.

   The 80% line on every card is the commission floor — below it a branch pool
   pays nothing at all, so it is the number people look for first.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcTs = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;
  const VIEW = { branch: '', limit: 12, openMain: true, openTiers: true };

  const tiers = () => ((C.ST.ref.policy || {}).levels || []).map((l) => l.level);
  const FLOOR = () => Math.min(...tiers()) / 100;

  /**
   * How a branch's month splits across the five service groups.
   * Falls back to the average across all branches when a branch has no shape of
   * its own — a new branch has no history to take one from, and a flat fifth
   * each would be worse than the house average.
   */
  function groupShare(branch, month) {
    const seas = (C.ST.ref && C.ST.ref.seasonality) || {};
    const own = (seas[branch] || {})[month];
    if (own) {
      const t = C.S(Object.values(own));
      if (t) return Object.fromEntries(Object.entries(own).map(([g, v]) => [g, v / t]));
    }
    const acc = {};
    let n = 0;
    for (const byMonth of Object.values(seas)) {
      const row = byMonth[month];
      if (!row) continue;
      const t = C.S(Object.values(row));
      if (!t) continue;
      n += 1;
      for (const [g, v] of Object.entries(row)) acc[g] = (acc[g] || 0) + v / t;
    }
    return n ? Object.fromEntries(Object.entries(acc).map(([g, v]) => [g, v / n])) : {};
  }

  /** The target for the chosen dates, split by group and by product type. */
  function split() {
    const names = C.branchNames().filter(C.inScope).filter((n) => !VIEW.branch || n === VIEW.branch);
    const byGroup = {};
    const byType = {};
    const typeOfGroup = {};

    for (const b of names) {
      const mix = ((C.ST.ref.mix || {})[b]) || {};
      for (const m of C.wMonths(C.ST.range.from, C.ST.range.to)) {
        const [s, e] = C.wClip(m, C.ST.range.from, C.ST.range.to);
        const target = C.bTarget(b, s, e);
        if (!target) continue;
        const share = groupShare(b, +m.slice(5, 7));
        for (const [g, sh] of Object.entries(share)) {
          const gt = target * sh;
          byGroup[g] = (byGroup[g] || 0) + gt;
          for (const [t, ts] of Object.entries(mix[g] || {})) {
            byType[t] = (byType[t] || 0) + gt * ts;
            (typeOfGroup[g] ||= new Set()).add(t);
          }
        }
      }
    }
    return { names, byGroup, byType, typeOfGroup };
  }

  /** Days in the range, and days in the month the range ends in. */
  function days() {
    const a = new Date(`${C.ST.range.from}T12:00:00`);
    const b = new Date(`${C.ST.range.to}T12:00:00`);
    const inRange = Math.round((b - a) / 86400000) + 1;
    const [y, m] = C.ST.range.to.split('-').map(Number);
    return { inRange, inMonth: new Date(y, m, 0).getDate() };
  }

  const rangeLabel = () => (C.ST.range.from === C.ST.range.to
    ? C.longDate(C.ST.range.from)
    : `${C.ST.range.from} → ${C.ST.range.to}`);

  function render() {
    if (!C.ST.ref) return;
    const { fmt, esc } = C;

    /* ---- controls: one branch, or all of them ---- */
    const sel = C.$('tsBr');
    sel.innerHTML = `<option value="">All branches</option>${
      C.branchNames().filter(C.inScope).map((n) => `<option value="${esc(n)}"${n === VIEW.branch ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
    sel.onchange = () => { VIEW.branch = sel.value; render(); };
    ['tsYear', 'tsPer', 'tsMode'].forEach((id) => { const el = C.$(id); if (el) el.hidden = true; });

    const { names, byGroup, byType, typeOfGroup } = split();
    const total = C.S(Object.values(byGroup));
    const D = days();
    const floor = FLOOR();
    const T = tiers();
    const where = VIEW.branch || (names.length === 1 ? names[0] : 'All branches');
    const biggest = Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0];

    C.$('tsLab').textContent = `${where} · ${rangeLabel()}`;

    /* ---- the four figures ---- */
    C.$('tsKpi').innerHTML = [
      [`Service target · ${rangeLabel()}`, fmt(total), `${where} · 100% tier`, true],
      ['Commission floor', C.fm(total * floor), `${Math.round(floor * 100)}% of target`],
      ['Biggest service', biggest ? biggest[0] : '—',
        biggest && total ? `${Math.round((biggest[1] / total) * 100)}% of the target` : ''],
      ['Per day', C.fm(D.inRange ? total / D.inRange : 0), `across ${D.inRange} day${D.inRange === 1 ? '' : 's'}`],
    ].map(([l, v, s, accent]) => `<div class="kpi${accent ? ' accent' : ''}">
      <div class="kpi-label">${esc(l)}</div><div class="kpi-value">${v}</div>
      <div class="kpi-sub">${esc(s)}</div></div>`).join('');

    /* ---- a card per service, with its product types underneath ---- */
    const groups = Object.entries(byGroup).sort((a, b) => b[1] - a[1]);
    C.$('tsCards').innerHTML = groups.map(([g, v]) => {
      const types = [...(typeOfGroup[g] || [])]
        .map((t) => [t, byType[t] || 0])
        .sort((a, b) => b[1] - a[1]);
      return `<div class="ts-card">
        <h4>${esc(g)}<small>${total ? `${((v / total) * 100).toFixed(1)}% of total` : ''}</small></h4>
        <div class="ts-sub">Target (100%)</div>
        <div class="ts-big">${fmt(v)}</div>
        <div class="ts-sub"><b>${Math.round(floor * 100)}% commission starts</b> · ${fmt(v * floor)}</div>
        <div class="ts-sub"><b>Per day</b> · ${fmt(v / D.inMonth)}</div>
        <div class="ts-bar"><i style="width:${total ? Math.min(100, (v / total) * 100).toFixed(1) : 0}%"></i></div>
        ${types.map(([t, tv]) => `<div class="ts-pt"><span>${esc(t)}</span>
          <span>${fmt(tv)} · ${v ? Math.round((tv / v) * 100) : 0}%</span></div>`).join('')}</div>`;
    }).join('') || '<div class="tg-note">No service shape for this selection.</div>';

    /* ---- the same thing as tiers, product types nested under their service ---- */
    const rows = [];
    for (const [g, v] of groups) {
      rows.push({ label: g, value: v, group: true });
      for (const t of [...(typeOfGroup[g] || [])].sort((a, b) => (byType[b] || 0) - (byType[a] || 0))) {
        rows.push({ label: t, value: byType[t] || 0, group: false });
      }
    }
    const shown = rows.slice(0, VIEW.limit);

    C.$('tsG').innerHTML = `<thead><tr><th>${esc(rangeLabel())}</th>${
      T.map((t) => `<th>${t}%</th>`).join('')}<th>Share</th></tr></thead><tbody>${
      shown.map((r) => `<tr${r.group ? ' class="grp"' : ''}><td${r.group ? '' : ' class="nm" style="padding-left:26px"'}>${esc(r.label)}</td>${
        T.map((t) => `<td${t === 100 ? ' class="t100"' : ''}>${fmt(r.value * (t / 100))}</td>`).join('')
      }<td>${total ? `<span class="pctb n">${((r.value / total) * 100).toFixed(1)}%</span>` : '—'}</td></tr>`).join('')
      || `<tr><td class="nm" colspan="${T.length + 2}">Nothing to split.</td></tr>`
    }<tr class="total"><td>Total</td>${
      T.map((t) => `<td>${fmt(total * (t / 100))}</td>`).join('')
    }<td><span class="pctb n">100%</span></td></tr></tbody>`;

    more(rows.length, shown.length);
  }

  function more(all, shown) {
    let box = C.$('tsMore');
    if (!box) {
      box = document.createElement('div');
      box.className = 'lim-more';
      box.id = 'tsMore';
      const t = C.$('tsG');
      if (t && t.parentElement && t.parentElement.after) t.parentElement.after(box);
    }
    const left = all - shown;
    box.hidden = left <= 0;
    if (left > 0) {
      box.innerHTML = `<button type="button" id="tsMoreBtn">Show more · ${left} more row${left === 1 ? '' : 's'}</button>`;
      const btn = C.$('tsMoreBtn');
      if (btn) btn.addEventListener('click', () => { VIEW.limit += 20; render(); });
    }
  }

  return { render, VIEW, groupShare, split };
});
