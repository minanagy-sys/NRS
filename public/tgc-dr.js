/* ============================================================
   05 — Doctors.

   SAME SHAPE AS BRANCH TARGETS: each column is a commission tier, because the
   question is "what does she have to bill to reach 90%", not "what did March
   look like".

   HER DAY FOLLOWS HER SHIFTS. A doctor's monthly target is divided by her
   ROSTERED HOURS, not by the days in the month — a 13-hour Saturday carries
   more than a 6-hour Tuesday. A doctor with no shifts on file falls back to a
   flat per-day split, which is the only honest answer when the roster is
   silent: she still has a target.

   Grouped by the cohort on the approved sheet, with the head count and the
   group total on the heading, so a group can be checked against the sheet
   without adding up its rows.

   Names resolve on their letters only — "Dr.Merna Masoud" and "Dr.Merna
   Ashraf" are one edit apart and are two different people, so nothing here
   matches by similarity.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcDr = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;
  const VIEW = { mode: 'summary', branch: '', one: '', limit: 25 };

  const tiers = () => ((C.ST.ref.policy || {}).levels || []).map((l) => l.level);

  /** Billed per doctor in the range, keyed on the normalised name. */
  function billed() {
    const out = new Map();
    for (const r of C.rows('doctors')) {
      const k = C.wn(r.doctor);
      const prev = out.get(k) || { ex: 0, invoices: 0, name: r.doctor };
      prev.ex += r.ex;
      prev.invoices += r.invoices || 0;
      out.set(k, prev);
    }
    return out;
  }

  function controls() {
    const { esc } = C;
    C.$('drMode').innerHTML = [['summary', 'Summary'], ['month', 'Month by month']]
      .map(([v, l]) => `<button class="chip${v === VIEW.mode ? ' on' : ''}" data-mode="${v}">${l}</button>`).join('');
    C.$('drMode').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      VIEW.mode = b.getAttribute('data-mode');
      VIEW.limit = 25;
      render();
    }));

    const br = C.$('drBr');
    br.innerHTML = `<option value="">All branches</option>${
      C.branchNames().filter(C.inScope).map((n) => `<option value="${esc(n)}"${n === VIEW.branch ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
    br.onchange = () => { VIEW.branch = br.value; render(); };

    const one = C.$('drOne');
    one.hidden = false;
    one.innerHTML = `<option value="">All doctors</option>${
      Object.keys(C.ST.ref.doctorPlan || {}).sort()
        .map((n) => `<option value="${esc(n)}"${n === VIEW.one ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
    one.onchange = () => { VIEW.one = one.value; render(); };

    /* The group chips, the tier chips and the period select drove the old flat
       list. Groups are headings now and the tiers are the columns. */
    ['drYear', 'drTier', 'drPer'].forEach((id) => {
      const el = C.$(id);
      if (el) el.hidden = true;
    });
  }

  /** Every doctor on the sheet, with what she billed and what she owes. */
  function rows() {
    const paid = billed();
    const profiles = new Map((C.ST.ref.doctors || []).map((d) => [C.wn(d.name), d]));
    const scopeList = C.scopeBranches();

    const inScope = (name) => {
      const p = profiles.get(C.wn(name));
      const brs = (p && p.branches) || [];
      if (scopeList && !brs.some((b) => scopeList.includes(b))) return false;
      if (VIEW.branch && !brs.includes(VIEW.branch)) return false;
      if (VIEW.one && C.wn(name) !== C.wn(VIEW.one)) return false;
      return true;
    };

    const out = Object.keys(C.ST.ref.doctorPlan || {}).filter(inScope).map((name) => {
      const hit = paid.get(C.wn(name));
      const p = profiles.get(C.wn(name)) || {};
      const target = C.dTarget(name);
      const ex = hit ? hit.ex : 0;
      return {
        name,
        group: C.ST.ref.doctorGroup[name] || p.group || 'Not in approved schedule',
        branches: p.branches || [],
        target,
        ex,
        invoices: hit ? hit.invoices : 0,
        ach: target ? ex / target : null,
      };
    });

    /* Billing with no approved target: shown, under their own heading, outside
       every group total — so the sheet still cross-foots. */
    const known = new Set(Object.keys(C.ST.ref.doctorPlan || {}).map(C.wn));
    const extra = [...paid.entries()].filter(([k]) => !known.has(k)).map(([, v]) => ({
      name: v.name, group: 'No approved target', branches: [], target: null,
      ex: v.ex, invoices: v.invoices, ach: null,
    })).filter((r) => !VIEW.one || C.wn(r.name) === C.wn(VIEW.one));

    return { out, extra };
  }

  function render() {
    if (!C.ST.ref) return;
    const { fmt, esc } = C;
    controls();

    const T = tiers();
    const { out, extra } = rows();
    const oneDay = C.ST.range.from === C.ST.range.to;
    const head = oneDay ? C.longDate(C.ST.range.from) : `${C.ST.range.from} → ${C.ST.range.to}`;

    /* Grouped by cohort, each heading carrying its head count and total — so a
       group reconciles against the approved sheet without adding up its rows. */
    const groups = [...new Set(out.map((r) => r.group))].sort();
    const body = [];
    let shownCount = 0;
    let truncated = 0;

    for (const g of groups) {
      const members = out.filter((r) => r.group === g).sort((a, b) => b.target - a.target);
      const gTotal = C.S(members.map((r) => r.target || 0));
      body.push(`<tr class="grp"><td>${esc(g)}<span class="m">${members.length} people · target ${fmt(gTotal)}</span></td>
        <td></td><td></td>${T.map(() => '<td></td>').join('')}</tr>`);
      for (const r of members) {
        if (shownCount >= VIEW.limit) { truncated += 1; continue; }
        shownCount += 1;
        body.push(docRow(r, T));
      }
    }
    for (const r of extra) {
      if (shownCount >= VIEW.limit) { truncated += 1; continue; }
      shownCount += 1;
      body.push(docRow(r, T));
    }
    if (extra.length) {
      body.splice(body.length - Math.min(extra.length, shownCount), 0,
        `<tr class="grp"><td>No approved target<span class="m">${extra.length} billing without one</span></td>
         <td></td><td></td>${T.map(() => '<td></td>').join('')}</tr>`);
    }

    const total = C.S(out.map((r) => r.target || 0));
    const exTotal = C.S(out.concat(extra).map((r) => r.ex));

    C.$('drT').innerHTML = `<thead><tr><th>Doctor · ${esc(head)}</th><th>Actual</th><th>Achieved</th>${
      T.map((t) => `<th>${t}% · target</th>`).join('')}</tr></thead><tbody>${
      body.join('') || `<tr><td class="nm" colspan="${T.length + 3}">No doctors in this scope.</td></tr>`
    }<tr class="total"><td>All doctors</td><td>${fmt(exTotal)}</td><td></td>${
      T.map((t) => `<td>${fmt(total * (t / 100))}</td>`).join('')}</tr></tbody>`;

    more(truncated);
  }

  function docRow(r, T) {
    const { fmt, esc } = C;
    return `<tr><td class="nm">${esc(r.name)}${r.branches.length
      ? `<span class="m">${esc(r.branches.join(' · '))}</span>` : ''}</td>
      <td>${r.ex ? fmt(r.ex) : '—'}</td>
      <td>${r.ach == null ? '—' : C.pctb(r.ach)}</td>${
      T.map((t) => `<td${t === 100 ? ' class="t100"' : ''}>${r.target == null ? '—' : fmt(r.target * (t / 100))}</td>`).join('')
    }</tr>`;
  }

  function more(left) {
    let box = C.$('drMore');
    if (!box) {
      box = document.createElement('div');
      box.className = 'lim-more';
      box.id = 'drMore';
      const t = C.$('drT');
      if (t && t.parentElement && t.parentElement.after) t.parentElement.after(box);
    }
    box.hidden = left <= 0;
    if (left > 0) {
      box.innerHTML = `<button type="button" id="drMoreBtn">Show more · ${left} more row${left === 1 ? '' : 's'}</button>`;
      const btn = C.$('drMoreBtn');
      if (btn) btn.addEventListener('click', () => { VIEW.limit += 40; render(); });
    }
  }

  return { render, VIEW };
});
