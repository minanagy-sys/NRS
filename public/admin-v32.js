/* ============================================================
   The v3.2 commission policy editor — the figures people are paid on.

   WHAT IT EDITS, and why it sits BELOW the v2.8 sections rather than replacing
   them. Both policies are stored on purpose: a month already paid under v2.8
   keeps the answer it was paid on, and `CommissionPolicyVersion.effectiveFrom`
   decides which applies to a month. The v2.8 tier ladder above is read-only and
   always has been — it is written by seed scripts, not by anybody here.

   FOUR TABLES, AND THE GRID IS THE ONE WITH MONEY IN IT:

     Levels      the five achievement thresholds. The first is the floor the
                 whole policy turns on; below it a team earns nothing at all,
                 not a smaller pool.
     Pool grid   14 revenue tiers x 5 level columns. One wrong cell pays a whole
                 branch team wrongly for a month.
     Weights     headcount and weight per role. Changing ANY weight re-cuts
                 EVERYBODY's share, not just that role's — so the resulting
                 percentage is shown beside each row, live, as it is typed.
     Staff       who is actually in each team. Without it a payslip can only say
                 "Reception 1": the share is right and nobody can be paid from
                 it.

   BOUND DIRECTLY TO ITS NODES, never delegated from `document` — the test
   harness's fake DOM has no `closest`, so a delegated handler is one nothing
   can prove works.

   ATTRIBUTE NAMES ARE PREFIXED `v32`. `data-band` is already used by two
   different sections of this page with two different meanings — band overrides
   and scheme bands — and both handlers bind to the bare selector, so typing in
   one writes a bogus entry into the other's dirty map. Not a mistake to repeat.

   Loaded as a plain <script> before `admin.js`, so `AdminV32` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminV32 = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { fmt, pc, esc } = F;

  let DATA = null;
  const DIRTY = { levels: new Map(), pools: new Map(), roles: new Map(), staff: new Map() };
  const ADDED = [];
  const dirtyCount = () => Object.values(DIRTY).reduce((n, m) => n + m.size, 0) + ADDED.length;
  const clean = () => { for (const m of Object.values(DIRTY)) m.clear(); ADDED.length = 0; };

  const money = (v) => (v ? fmt(v) : '—');

  function html(d) {
    if (!d || !d.policy || d.policy.missing) {
      return `<h3 class="subtitle">Commission policy v3.2</h3>
        <div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>${esc((d && d.policy && d.policy.missing) || 'No v3.2 policy is stored.')}</strong>
        Import it with <code>node scripts/import-targets-html.js --write</code>.</div>`;
    }
    const P = d.policy;
    const W = P.totalWeight || 1;

    let h = `<h3 class="subtitle">Commission policy <span class="vat-tag">${esc(P.version)}</span></h3>
      <p class="sub">The policy in force, and the one <a href="/commission">Commission &amp; Payslips</a>
        scores on. The v2.8 ladder above is a different generation of the same agreement, kept
        because a month already paid under it keeps the answer it was paid on.
        <strong>Collected picks the row, achievement picks the column</strong>, and the cell is the
        whole team's pool.</p>
      <div class="status" id="v32St">${dirtyCount() ? `${dirtyCount()} unsaved change(s)` : 'no changes yet'}</div>`;

    /* ---- levels ---- */
    h += `<h3 class="subtitle">Achievement levels</h3>
      <p class="cp-desc">The column a branch reads, by how much of its month target it collected.
        The <strong>first row is the floor</strong>: below it a team earns nothing at all, not a
        smaller pool. They must rise, or the higher one can never be reached.</p>
      <table class="ltab tight" style="max-width:420px"><thead><tr>
        <th>Level</th><th class="n">From achievement</th></tr></thead><tbody>
      ${P.levels.map((l, i) => `<tr>
        <td class="nm">${l.level}%${i === 0 ? ' <span class="sm2">the floor</span>' : ''}</td>
        <td class="n"><input class="editable n" style="width:80px" data-v32level="${i}:fromPct"
          value="${(l.fromPct * 100).toFixed(2)}" inputmode="decimal"> %</td></tr>`).join('')}
      </tbody></table>
      <div class="row-actions"><button class="btn" id="v32SaveLevels">Save the levels</button></div>`;

    /* ---- the pool grid ---- */
    h += `<h3 class="subtitle">The pool grid</h3>
      <p class="cp-desc">${P.tiers.length} revenue tiers by ${P.levels.length} levels. Every figure
        here is a whole team's pool for one month. A higher level may not pay less than a lower
        one, and two tiers may not share a range.</p>
      <div class="tw scrolly" style="--minw:${260 + P.levels.length * 110}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr>
        <th>Collected ex-VAT</th>
        ${P.levels.map((l) => `<th class="n">${l.level}%</th>`).join('')}</tr></thead><tbody>
      ${P.tiers.map((t, ti) => `<tr>
        <td class="nm"><input class="editable n" style="width:92px" data-v32pool="${ti}:from"
            value="${t.from}" inputmode="numeric"> –
          <input class="editable n" style="width:92px" data-v32pool="${ti}:to"
            value="${t.to == null ? '' : t.to}" placeholder="and above" inputmode="numeric"></td>
        ${t.pools.map((v, ci) => `<td class="n"><input class="editable n" style="width:84px"
          data-v32pool="${ti}:p${ci}" value="${v}" inputmode="numeric"></td>`).join('')}
      </tr>`).join('')}
      </tbody></table></div>
      <div class="row-actions"><button class="btn" id="v32SavePools">Save the grid</button>
        <span class="hint" style="color:var(--muted);font-size:11.5px">A blank "to" on the last row
        means "and above". Leave the bounds touching — 0–500,000 then 500,000 — exactly as they
        are; an exact boundary reads the lower tier.</span></div>`;

    /* ---- role weights ---- */
    h += `<h3 class="subtitle">Who shares a pool</h3>
      <p class="cp-desc">A person earns <strong>pool &times; their weight &divide; the total weight</strong>.
        Changing any weight re-cuts <em>everybody's</em> share, not just that role's — the resulting
        percentage is shown beside each row so a typo is visible before it is saved.</p>
      <table class="ltab tight" style="max-width:700px"><thead><tr>
        <th>Role</th><th class="n">People</th><th class="n">Weight each</th>
        <th class="n">Share each</th><th>Notes</th></tr></thead><tbody>
      ${P.roles.map((r, i) => `<tr>
        <td class="nm">${esc(r.role)}</td>
        <td class="n"><input class="editable n" style="width:58px" data-v32role="${i}:people"
          value="${r.people}" inputmode="numeric"></td>
        <td class="n"><input class="editable n" style="width:70px" data-v32role="${i}:weight"
          value="${r.weight}" inputmode="decimal"></td>
        <td class="n" data-v32share="${i}">${pc(r.weight / W, 1)}</td>
        <td><input class="editable" style="width:100%;text-align:left" data-v32role="${i}:notes"
          value="${esc(r.notes || '')}"></td></tr>`).join('')}
      </tbody><tfoot><tr><th>Total weight</th>
        <th class="n" id="v32W">${P.roles.reduce((a, r) => a + r.people * r.weight, 0)}</th>
        <th class="n"></th><th class="n">100.0%</th><th></th></tr></tfoot></table>
      <div class="row-actions"><button class="btn" id="v32SaveRoles">Save the weights</button></div>`;

    /* ---- staff ---- */
    const byBranch = new Map(d.branches.map((b) => [b.id, []]));
    for (const s of d.staff) if (byBranch.has(s.branchId)) byBranch.get(s.branchId).push(s);
    const named = d.staff.length;
    const seats = d.branches.length * P.roles.reduce((a, r) => a + r.people, 0);

    h += `<h3 class="subtitle">The staff list
        <span class="vat-tag">${named} of about ${seats} seats named</span></h3>
      <p class="cp-desc">Who is actually in each branch team. The share is right without this —
        the pool is split by role, not by person — but a payslip addressed to "Reception 1" cannot
        be paid to anybody. Appears on <a href="/commission">Commission &amp; Payslips → Staff</a>.</p>`;

    for (const b of d.branches) {
      const mine = byBranch.get(b.id) || [];
      h += `<div class="listcard">
        <div class="listcard-head"><h3>${esc(b.name)}</h3>
          <span class="sm2">${esc(b.area)} · ${esc(b.entity)} ·
            ${mine.length} named</span></div>
        <div class="pcard-body" style="padding:10px 16px 14px">
        <table class="ltab tight"><thead><tr><th>Name</th><th>Role</th><th>Pay to</th>
          <th>Account</th><th class="n"></th></tr></thead><tbody>
        ${mine.map((s) => `<tr>
          <td><input class="editable" style="width:100%;text-align:left" data-v32staff="${s.id}:name" value="${esc(s.name)}"></td>
          <td><input class="editable" style="width:100%;text-align:left" data-v32staff="${s.id}:role" value="${esc(s.role)}"></td>
          <td><input class="editable" style="width:100%;text-align:left" data-v32staff="${s.id}:payMethod" value="${esc(s.payMethod || '')}"></td>
          <td><input class="editable" style="width:100%;text-align:left" data-v32staff="${s.id}:bankAcc" value="${esc(s.bankAcc || '')}"></td>
          <td class="n"><button class="btn ghost" data-v32del="${s.id}">Remove</button></td></tr>`).join('')
  || '<tr><td colspan="5"><span class="sm2">Nobody is named for this branch yet.</span></td></tr>'}
        </tbody></table>
        <div class="row-actions">
          <input class="editable" style="width:150px;text-align:left" data-v32new="${b.id}:name" placeholder="Name">
          <select class="editable" data-v32new="${b.id}:role" style="width:150px">
            ${P.roles.map((r) => `<option value="${esc(r.role)}">${esc(r.role)}</option>`).join('')}
          </select>
          <input class="editable" style="width:110px;text-align:left" data-v32new="${b.id}:payMethod" placeholder="Pay to">
          <input class="editable" style="width:140px;text-align:left" data-v32new="${b.id}:bankAcc" placeholder="Account">
          <button class="btn ghost" data-v32add="${b.id}">Add</button>
        </div></div></div>`;
    }
    h += `<div class="row-actions"><button class="btn" id="v32SaveStaff">Save the staff list</button></div>`;

    return h;
  }

  function wire(el, ctx) {
    if (!el || !el.querySelectorAll) return;
    const $ = (id) => el.querySelector(`#${id}`) || (ctx.doc && ctx.doc.getElementById(id));
    const st = () => {
      const n = dirtyCount();
      const s = $('v32St');
      if (s) s.textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'no changes yet';
    };
    const mark = (map, key, value, node) => {
      map.set(key, value);
      if (node.classList) node.classList.add('dirty');
      st();
    };

    el.querySelectorAll('[data-v32level]').forEach((n) => n.addEventListener('input', () => {
      mark(DIRTY.levels, n.dataset.v32level, n.value, n);
    }));
    el.querySelectorAll('[data-v32pool]').forEach((n) => n.addEventListener('input', () => {
      mark(DIRTY.pools, n.dataset.v32pool, n.value, n);
    }));
    el.querySelectorAll('[data-v32staff]').forEach((n) => n.addEventListener('input', () => {
      mark(DIRTY.staff, n.dataset.v32staff, n.value, n);
    }));

    /* The weights redraw their own share column as they are typed: the whole
       point of showing it is that a wrong weight is visible BEFORE saving. */
    const roleNodes = () => [...el.querySelectorAll('[data-v32role]')];
    const repaintShares = () => {
      const P = DATA.policy;
      const rows = P.roles.map((r, i) => {
        const get = (f) => {
          const node = roleNodes().find((n) => n.dataset.v32role === `${i}:${f}`);
          return node ? node.value : r[f];
        };
        return { people: Number(get('people')) || 0, weight: Number(get('weight')) || 0 };
      });
      const W = rows.reduce((a, r) => a + r.people * r.weight, 0);
      const tot = $('v32W');
      if (tot) tot.textContent = String(Math.round(W * 100) / 100);
      rows.forEach((r, i) => {
        const cell = el.querySelector(`[data-v32share="${i}"]`);
        if (cell) cell.textContent = W ? pc(r.weight / W, 1) : '—';
      });
    };
    roleNodes().forEach((n) => n.addEventListener('input', () => {
      mark(DIRTY.roles, n.dataset.v32role, n.value, n);
      repaintShares();
    }));

    el.querySelectorAll('[data-v32add]').forEach((n) => n.addEventListener('click', () => {
      const branchId = Number(n.dataset.v32add);
      const read = (f) => {
        const node = el.querySelector(`[data-v32new="${branchId}:${f}"]`);
        return node ? String(node.value || '').trim() : '';
      };
      const name = read('name');
      if (!name) return ctx.fail(new Error('A new person needs a name.'));
      ADDED.push({ branchId, name, role: read('role'), payMethod: read('payMethod'), bankAcc: read('bankAcc') });
      st();
      return ctx.ok(`${name} will be added when you save the staff list.`);
    }));
    el.querySelectorAll('[data-v32del]').forEach((n) => n.addEventListener('click', async () => {
      try {
        await ctx.api('/api/commission/staff', {
          method: 'PUT', body: JSON.stringify({ staff: [{ id: Number(n.dataset.v32del), remove: true }] }),
        });
        await ctx.reload();
        ctx.ok('Removed.');
      } catch (e) { ctx.fail(e); }
    }));

    const save = async (what) => {
      const P = DATA.policy;
      const val = (map, key, fallback) => (map.has(key) ? map.get(key) : fallback);
      let url;
      let body;
      if (what === 'levels') {
        url = '/api/policy/levels';
        body = {
          version: P.version,
          levels: P.levels.map((l, i) => ({ level: l.level, fromPct: val(DIRTY.levels, `${i}:fromPct`, l.fromPct * 100) })),
        };
      } else if (what === 'pools') {
        url = '/api/policy/pools';
        body = {
          version: P.version,
          tiers: P.tiers.map((t, ti) => ({
            tierNo: t.tierNo,
            from: val(DIRTY.pools, `${ti}:from`, t.from),
            to: val(DIRTY.pools, `${ti}:to`, t.to == null ? '' : t.to),
            pools: t.pools.map((v, ci) => val(DIRTY.pools, `${ti}:p${ci}`, v)),
          })),
        };
      } else if (what === 'roles') {
        url = '/api/policy/roles';
        body = {
          version: P.version,
          roles: P.roles.map((r, i) => ({
            role: r.role,
            people: val(DIRTY.roles, `${i}:people`, r.people),
            weight: val(DIRTY.roles, `${i}:weight`, r.weight),
            notes: val(DIRTY.roles, `${i}:notes`, r.notes || ''),
            sortOrder: i + 1,
          })),
        };
      } else {
        url = '/api/commission/staff';
        const edited = new Map();
        for (const [k, v] of DIRTY.staff) {
          const at = k.lastIndexOf(':');
          const id = Number(k.slice(0, at));
          if (!edited.has(id)) {
            const was = DATA.staff.find((s) => s.id === id) || {};
            edited.set(id, { id, branchId: was.branchId, name: was.name, role: was.role, payMethod: was.payMethod, bankAcc: was.bankAcc });
          }
          edited.get(id)[k.slice(at + 1)] = v;
        }
        body = { staff: [...edited.values(), ...ADDED] };
        if (!body.staff.length) return ctx.fail(new Error('Nothing has changed.'));
      }
      if (what !== 'staff' && !DIRTY[what].size) return ctx.fail(new Error('Nothing has changed.'));
      try {
        await ctx.api(url, { method: 'PUT', body: JSON.stringify(body) });
        clean();
        await ctx.reload();
        return ctx.ok(`${what === 'staff' ? 'The staff list' : `The ${what}`} saved. Every figure on `
          + 'Commission & Payslips is recalculated from them.');
      } catch (e) { return ctx.fail(e); }
    };
    for (const [id, what] of [['v32SaveLevels', 'levels'], ['v32SavePools', 'pools'],
      ['v32SaveRoles', 'roles'], ['v32SaveStaff', 'staff']]) {
      const b = $(id);
      if (b) b.addEventListener('click', () => save(what));
    }
  }

  async function render(el, ctx) {
    DATA = await ctx.api('/api/policy/v32');
    el.innerHTML = html(DATA);
    wire(el, ctx);
    return DATA;
  }

  return { render, html, wire, clean, dirtyCount };
});
