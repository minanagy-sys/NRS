/* ============================================================
   02 — Branch targets.

   EACH COLUMN IS A COMMISSION TIER, NOT A MONTH. The question this table
   answers is "how much does this branch have to bill in the dates above to
   reach 80, 85, 90, 95, 100 per cent" — because the pool it earns is decided by
   which of those it clears. A grid of months answers a different question, and
   was the wrong shape.

   The targets are WEIGHTED, so a range landing on two Fridays carries less than
   the same count of Tuesdays, and the running month's shortfall is carried into
   the days that remain — both in `targetAdj`, in tgc-core.

   Summary totals each branch over the whole range. Month by month opens it out:
   every branch per month, or one branch per month when a branch is picked.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcTb = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;
  const VIEW = { mode: 'summary', brand: '', one: '', limit: 10 };

  const tiers = () => ((C.ST.ref.policy || {}).levels || []).map((l) => l.level);

  /** The branches in play: scope, then brand, then the single-branch pick. */
  function branches() {
    return C.branchNames()
      .filter(C.inScope)
      .filter((n) => !VIEW.brand || C.brandOf(n) === VIEW.brand)
      .filter((n) => !VIEW.one || n === VIEW.one);
  }

  const rangeLabel = () => (C.ST.range.from === C.ST.range.to
    ? C.longDate(C.ST.range.from)
    : `${C.ST.range.from} → ${C.ST.range.to}`);

  function controls() {
    const { esc } = C;
    C.$('tbMode').innerHTML = [['summary', 'Summary'], ['month', 'Month by month']]
      .map(([v, l]) => `<button class="chip${v === VIEW.mode ? ' on' : ''}" data-mode="${v}">${l}</button>`).join('');
    C.$('tbMode').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      VIEW.mode = b.getAttribute('data-mode');
      VIEW.limit = 10;
      render();
    }));

    const one = C.$('tbOne');
    one.hidden = false;
    one.innerHTML = `<option value="">All branches</option>${
      C.branchNames().filter(C.inScope).map((n) => `<option value="${esc(n)}"${n === VIEW.one ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
    one.onchange = () => { VIEW.one = one.value; render(); };

    const brands = [...new Set(C.branchNames().map(C.brandOf))];
    C.$('tbBrand').innerHTML = [['', 'All'], ...brands.map((b) => [b, b])]
      .map(([v, l]) => `<button class="chip${v === VIEW.brand ? ' on' : ''}" data-brand="${esc(v)}">${esc(l)}</button>`).join('');
    C.$('tbBrand').querySelectorAll('[data-brand]').forEach((b) => b.addEventListener('click', () => {
      VIEW.brand = b.getAttribute('data-brand');
      render();
    }));

    /* The year chips, the tier chips and the period select belonged to the old
       month-grid shape. The tiers ARE the columns now, and the dates come from
       the bar above, so none of them has anything left to pick. */
    ['tbYear', 'tbTier', 'tbPer', 'tbDay'].forEach((id) => {
      const el = C.$(id);
      if (el) el.hidden = true;
    });
  }

  /** One row: the target restated at each tier, and its share of the total. */
  function row(label, meta, target, total, T) {
    const { fmt, esc } = C;
    return `<tr><td class="nm">${esc(label)}${meta ? `<span class="m">${esc(meta)}</span>` : ''}</td>${
      T.map((t) => `<td${t === 100 ? ' class="t100"' : ''}>${fmt(target * (t / 100))}</td>`).join('')
    }<td>${total ? `<span class="pctb n">${((target / total) * 100).toFixed(1)}%</span>` : '—'}</td></tr>`;
  }

  function render() {
    if (!C.ST.ref) return;
    const { fmt, esc } = C;
    controls();

    const T = tiers();
    const names = branches();
    const oneDay = C.ST.range.from === C.ST.range.to;

    C.$('tbTitle').textContent = oneDay
      ? `${C.wkName(C.ST.range.from)} target by branch`
      : 'Targets by branch';

    const rows = VIEW.mode === 'summary'
      ? names.map((n) => ({ label: n, meta: C.brandOf(n), target: C.bTarget(n) }))
        .sort((a, b) => b.target - a.target)
      : C.wMonths(C.ST.range.from, C.ST.range.to).flatMap((m) => {
        const [s, e] = C.wClip(m, C.ST.range.from, C.ST.range.to);
        return names.map((n) => ({
          label: VIEW.one ? m : `${n} · ${m}`,
          meta: VIEW.one ? '' : C.brandOf(n),
          target: C.bTarget(n, s, e),
        })).filter((r) => r.target);
      });

    const total = C.S(rows.map((r) => r.target));
    const shown = rows.slice(0, VIEW.limit);

    C.$('tbT').innerHTML = `<thead><tr><th>${esc(VIEW.mode === 'summary'
      ? rangeLabel()
      : (VIEW.one || 'Branch · month'))}</th>${
      T.map((t) => `<th>${t}%</th>`).join('')}<th>Share</th></tr></thead><tbody>${
      shown.map((r) => row(r.label, r.meta, r.target, total, T)).join('')
      || `<tr><td class="nm" colspan="${T.length + 2}">Nothing matches this filter.</td></tr>`
    }<tr class="total"><td>Total</td>${
      T.map((t) => `<td>${fmt(total * (t / 100))}</td>`).join('')
    }<td><span class="pctb n">100%</span></td></tr></tbody>`;

    more(rows.length, shown.length);
    carryNote(total);
    chart();
  }

  /**
   * When the running month is behind, these targets are NOT the plain plan —
   * they carry the shortfall into the days that remain. A reader comparing this
   * against the approved sheet has to be told that, or the difference looks
   * like an error in one of them.
   */
  function carryNote(total) {
    const cu = C.ST.per && C.ST.per.catchUp;
    let el = C.$('tbCarry');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tg-note';
      el.id = 'tbCarry';
      const t = C.$('tbT');
      if (t && t.parentElement && t.parentElement.before) t.parentElement.before(el);
    }
    if (!cu || !cu.upto) { el.hidden = true; return; }
    const done = C.S(Object.values(cu.byBranch || {}));
    const planned = C.S(C.branchNames().filter(C.inScope).map((n) => C.branchPlan(n)[cu.month] || 0));
    const behind = planned - done;
    el.hidden = false;
    el.innerHTML = `<strong>These targets carry ${cu.month}'s shortfall.</strong> `
      + `${C.fmt(done)} of ${C.fmt(planned)} is billed to ${cu.upto}, so the `
      + `${C.fmt(Math.max(0, behind))} still owed is spread across the days that are left — `
      + `weighted, so a Friday carries less than a Tuesday. Against the approved sheet alone `
      + `the figure would be lower; this is what the rest of the month actually has to do.`;
  }

  /** "Show more · N more rows". The count is stated — a silently truncated list
      reads as a complete one. */
  function more(all, shown) {
    let box = C.$('tbMore');
    if (!box) {
      box = document.createElement('div');
      box.className = 'lim-more';
      box.id = 'tbMore';
      const t = C.$('tbT');
      if (t && t.parentElement && t.parentElement.after) t.parentElement.after(box);
    }
    const left = all - shown;
    box.hidden = left <= 0;
    if (left > 0) {
      box.innerHTML = `<button type="button" id="tbMoreBtn">Show more · ${left} more row${left === 1 ? '' : 's'}</button>`;
      const btn = C.$('tbMoreBtn');
      if (btn) btn.addEventListener('click', () => { VIEW.limit += 20; render(); });
    }
  }

  /** The whole plan as a stacked bar, branch by branch. Hidden when the page is
      scoped to one branch — a single stack is not a comparison. */
  function chart() {
    const el = C.$('tbChart');
    if (!el || !root.Chartlet || !root.Chartlet.stack) return;
    if (C.ST.scope.type !== 'all') { el.innerHTML = ''; return; }
    const names = branches();
    const months = [...new Set(names.flatMap((n) => Object.keys(C.branchPlan(n))))].sort();
    if (!months.length) return;
    const drawn = root.Chartlet.stack({
      labels: months.map((m) => `${m.slice(5)} ${m.slice(2, 4)}`),
      height: 320,
      width: 1100,
      topN: 12,
      series: names.map((n) => ({ name: n, values: months.map((m) => C.branchPlan(n)[m] || 0) })),
    });
    const markup = drawn && drawn.svg ? drawn.svg : drawn;
    const legend = root.Chartlet.legend
      ? root.Chartlet.legend(names.map((n) => ({ name: n })), 'tbLegend') : '';
    el.outerHTML = `<div id="tbChart">${markup}${legend}</div>`;
  }

  return { render, VIEW };
});
