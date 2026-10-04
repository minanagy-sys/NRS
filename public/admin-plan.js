/* ============================================================
   The plan editor — branch and doctor targets, 2026 through 2027.

   THE QUESTION THIS EXISTS TO ANSWER is the one Mina asked first and most
   often: how do I set next month's targets without typing seventy-three
   numbers. So the grid is editable cell by cell for the corrections, and
   "carry a month forward" with an uplift does the bulk of it in one action.

   A BLANK CELL DELETES. It does not write zero — a month nobody set a target
   for and a month whose target is nothing are different claims, and only one of
   them means somebody forgot. The route honours the same distinction.

   CARRYING REFUSES TO OVERWRITE unless asked. Copying October onto a November
   that already has figures is the one mistake here that would be silent, so it
   is a refusal with a count in it rather than a confirm dialog nobody reads.

   Lifted into its own file rather than added to `public/admin.js`, which is
   already 2,100 lines. Loaded as a plain <script> before it, so `AdminPlan` is
   a global — the CSP forbids inline script.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminPlan = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, esc } = F;

  /* Cells the reader has changed but not saved, keyed grid:row:month. */
  const DIRTY = { branches: new Map(), doctors: new Map() };
  let PLAN = null;

  const dirtyCount = () => DIRTY.branches.size + DIRTY.doctors.size;
  const clean = () => { DIRTY.branches.clear(); DIRTY.doctors.clear(); };

  /** A month label a human reads: "2027-03" -> "Mar 27". */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLab = (k) => {
    const [y, m] = String(k).split('-').map(Number);
    return `${MON[m - 1]} ${String(y).slice(2)}`;
  };

  /**
   * One editable grid.
   *
   * The first column is sticky because a 24-month row is wider than any screen
   * and a number with no name against it is unreadable. Row and column totals
   * are rendered, not editable: they are the check that the typing added up.
   */
  function grid(kind, rows, months, values, rowLabel) {
    if (!rows.length) {
      return `<div class="tg-note">Nothing stored yet for ${kind === 'branches' ? 'branches' : 'doctors'}.</div>`;
    }
    const colTotal = months.map((_, mi) => rows.reduce((a, _r, ri) => a + (values[ri][mi] || 0), 0));
    const grand = colTotal.reduce((a, b) => a + b, 0);

    return `<div class="tw scrolly" style="--minw:${160 + months.length * 92}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr>
        <th>${kind === 'branches' ? 'Branch' : 'Doctor'}</th>
        ${months.map((k) => `<th class="n">${esc(mLab(k))}</th>`).join('')}
        <th class="n">Total</th></tr></thead><tbody>
      ${rows.map((r, ri) => {
    const tot = values[ri].reduce((a, b) => a + (b || 0), 0);
    return `<tr><td class="nm">${esc(rowLabel(r))}</td>
          ${months.map((k, mi) => `<td class="n"><input class="editable n" style="width:84px"
            data-plan="${kind}:${ri}:${mi}" value="${values[ri][mi] == null ? '' : values[ri][mi]}"
            inputmode="numeric" aria-label="${esc(rowLabel(r))} ${esc(k)}"></td>`).join('')}
          <td class="n"><strong>${fmt(tot)}</strong></td></tr>`;
  }).join('')}
      </tbody><tfoot><tr><th>All</th>
        ${colTotal.map((t) => `<th class="n">${fmt(t)}</th>`).join('')}
        <th class="n">${fmt(grand)}</th></tr></tfoot></table></div>`;
  }

  /** The carry-forward control, one per grid. */
  function carry(kind, months) {
    const last = months[months.length - 1] || '';
    const [y, m] = String(last).split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    return `<div class="recon" style="margin-top:12px">
      <h4>Add a month from the one before it</h4>
      <div class="adm-grid">
        <div class="field"><label>Copy from</label>
          <input class="editable" id="cy${kind}From" value="${esc(last)}" placeholder="2027-12"></div>
        <div class="field"><label>Into</label>
          <input class="editable" id="cy${kind}To" value="${esc(next)}" placeholder="2028-01"></div>
        <div class="field"><label>Uplift %</label>
          <input class="editable" id="cy${kind}Up" value="0" placeholder="0">
          <span class="hint">10 raises every figure by a tenth. Negative lowers it.</span></div>
      </div>
      <div class="row-actions">
        <label class="tg-flat"><input type="checkbox" id="cy${kind}Over"> Replace what is already there</label>
        <button class="btn ghost" id="cy${kind}Go">Carry forward</button>
        <span class="hint">Without the tick, a month that already has figures is refused rather
          than quietly overwritten.</span>
      </div></div>`;
  }

  function html(plan) {
    const B = plan.branches;
    const D = plan.doctors;
    const P = plan.policy;

    let h = `<section>
      <h3 class="subtitle">The plan <span class="vat-tag">targets, not actuals</span></h3>
      <p class="sub">Branch and doctor targets, month by month. Everything here is a decision
        somebody made — nothing on this page is derived from Odoo. Edit a cell and press Save;
        leave a cell <strong>blank</strong> to say no target was set, which is not the same as a
        target of zero.</p>
      <div class="status" id="planSt">${dirtyCount() ? `${dirtyCount()} unsaved change(s)` : 'no changes yet'}</div>`;

    h += `<h3 class="subtitle">Branches</h3>
      <p class="cp-desc">${B.branches.length} branches · ${B.months.length} months ·
        <strong>${fmt(plan.totals.plannedTarget)}</strong> planned in total. These are the same rows
        the commission report scores against, so a change here moves a branch's achievement.</p>
      ${grid('branches', B.branches, B.months, B.target, (r) => r.name)}
      <div class="row-actions"><button class="btn" id="planSaveB">Save the branch grid</button></div>
      ${carry('B', B.months)}`;

    h += `<h3 class="subtitle">Doctors</h3>
      <p class="cp-desc">${D.doctors.length} doctors · ${D.months.length} months. Separate from the
        monthly approved sheet, which has its own publish and reconcile steps — this is the plan,
        and it runs to the end of 2027.</p>
      ${grid('doctors', D.doctors, D.months, D.target, (r) => r.name)}
      <div class="row-actions"><button class="btn" id="planSaveD">Save the doctor grid</button></div>
      ${carry('D', D.months)}`;

    /* The policy, shown rather than edited here: it is read by the commission
       report and belongs beside the rest of the policy on tab 03. Drawn so the
       person setting targets can see what a given achievement actually pays. */
    if (P && !P.missing) {
      h += `<h3 class="subtitle">What a pool pays <span class="vat-tag">${esc(P.version)}</span></h3>
        <p class="cp-desc">Revenue picks the row, achievement picks the column, and the cell is the
          whole team's pool for the month. Split ${P.roles.map((r) => `${esc(r.role)} &times;${r.people} at ${(r.share * 100).toFixed(1)}%`).join(' · ')}.
          Editable on <a href="#" data-gotab="commission">Commission</a>.</p>
        <div class="tw scrolly" style="--minw:560px;--h:380px"><table class="ltab tight"><thead><tr>
          <th>Collected ex-VAT</th>${P.levels.map((l) => `<th class="n">${l.level}%</th>`).join('')}
          </tr></thead><tbody>
          ${P.tiers.map((t) => `<tr><td class="nm">${fmt(t.from)}${t.to == null ? '+' : ` – ${fmt(t.to)}`}</td>
            ${t.pools.map((v) => `<td class="n">${v ? fmt(v) : '<span class="sm2">—</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>`;
    } else if (P && P.missing) {
      h += `<h3 class="subtitle">What a pool pays</h3>
        <div class="tg-note" style="border-left:3px solid #b0503c"><strong>${esc(P.missing)}</strong>
        Import it with <code>node scripts/import-targets-html.js --write</code>.</div>`;
    }

    return `${h}</section>`;
  }

  /**
   * Bind the grid.
   *
   * Bound DIRECTLY to the nodes, not delegated from `document`. The test
   * harness's fake DOM has no `closest`, so a delegated handler is a handler
   * nothing can prove works — which is exactly how a dead `renderTracker` call
   * survived in the Targets page for weeks.
   */
  function wire(el, ctx) {
    const $ = (id) => el.querySelector(`#${id}`) || (ctx.doc && ctx.doc.getElementById(id));
    const st = () => {
      const n = dirtyCount();
      const s = $('planSt');
      if (s) s.textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'no changes yet';
    };

    el.querySelectorAll('[data-plan]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const [kind, ri, mi] = inp.dataset.plan.split(':');
        DIRTY[kind].set(`${ri}:${mi}`, inp.value);
        inp.classList.add('dirty');
        st();
      });
    });

    const save = async (kind) => {
      const map = DIRTY[kind];
      if (!map.size) return ctx.fail(new Error('Nothing has changed.'));
      const src = kind === 'branches' ? PLAN.branches : PLAN.doctors;
      const cells = [...map.entries()].map(([k, v]) => {
        const [ri, mi] = k.split(':').map(Number);
        const period = src.months[mi];
        if (kind === 'branches') {
          const [y, m] = period.split('-').map(Number);
          return { branchId: src.branches[ri].id, year: y, month: m, target: v };
        }
        return { doctorName: src.doctors[ri].name, period, target: v };
      });
      try {
        await ctx.api(kind === 'branches' ? '/api/plan/targets' : '/api/plan/doctors', {
          method: 'PUT', body: JSON.stringify({ cells }),
        });
        map.clear();
        await ctx.reload();
        ctx.ok(`${cells.length} ${kind === 'branches' ? 'branch' : 'doctor'} cell${cells.length === 1 ? '' : 's'} saved.`);
      } catch (e) { ctx.fail(e); }
    };
    const sb = $('planSaveB'); if (sb) sb.addEventListener('click', () => save('branches'));
    const sd = $('planSaveD'); if (sd) sd.addEventListener('click', () => save('doctors'));

    for (const [tag, kind] of [['B', 'branches'], ['D', 'doctors']]) {
      const go = $(`cy${tag}Go`);
      if (!go) continue;
      go.addEventListener('click', async () => {
        try {
          const out = await ctx.api('/api/plan/carry', {
            method: 'POST',
            body: JSON.stringify({
              kind,
              from: $(`cy${tag}From`).value.trim(),
              to: $(`cy${tag}To`).value.trim(),
              uplift: $(`cy${tag}Up`).value.trim(),
              overwrite: $(`cy${tag}Over`).checked,
            }),
          });
          await ctx.reload();
          ctx.ok(`${out.written} target${out.written === 1 ? '' : 's'} carried into ${$(`cy${tag}To`).value.trim()}.`);
        } catch (e) { ctx.fail(e); }
      });
    }
  }

  /** Fetch, draw, bind. The one call `admin.js` makes. */
  async function render(el, ctx) {
    PLAN = await ctx.api('/api/targets-plan');
    el.innerHTML = html(PLAN);
    wire(el, ctx);
    return PLAN;
  }

  return { render, html, wire, clean, dirtyCount };
});
