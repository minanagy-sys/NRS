/* ============================================================
   Admin — the phone extension map.

   WHY THIS IS AN EDITOR AND NOT A SEED. The Contact Centre report can only put
   a name against a call because of this table. The phone export carries a first
   name ("Nada") and no Odoo employee at all, so without the map the agents
   table is eleven numbers. People move desks, and when they do every call is
   attributed to whoever used to sit there until somebody fixes it here.

   THE CONFLICT ROW IS THE POINT. Where the phone system and this map disagree
   about who sits at an extension — extension 6008 is "Rana Magdy" in the export
   and "Mariam zat" here — one of them is out of date and every call on it is
   attributed to a guess. Those rows are flagged and sorted to the top, because
   a disagreement nobody is shown is a disagreement nobody resolves.

   An extension cannot be ADDED here. The list comes from the phone system; one
   invented in this table would be a row no call ever matches.

   Loaded as a plain <script> before admin.js, so `AdminExt` is a global. Bound
   to its own nodes rather than delegated from `document`, so the test harness
   can fire them.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminExt = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, esc } = F;

  /* ext -> the fields the user has changed. Only these are sent, so two people
     editing different extensions do not overwrite each other. */
  const DIRTY = new Map();

  const conflicts = (r) => {
    if (!r.phoneName || !r.cdrName) return false;
    const first = (s) => String(s).trim().split(/\s+/)[0].toLowerCase();
    return first(r.phoneName) !== first(r.cdrName);
  };

  function html(D) {
    if (!D || !D.rows) {
      return `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>The extension map could not be loaded.</strong></div>`;
    }
    const rows = [...D.rows].sort((a, b) => {
      const ca = conflicts(a) ? 0 : 1;
      const cb = conflicts(b) ? 0 : 1;
      return ca - cb || String(a.ext).localeCompare(String(b.ext));
    });
    const bad = rows.filter(conflicts);
    const unmapped = rows.filter((r) => !r.odooEmployee).length;

    let h = `<h3 class="subtitle" style="margin-top:26px">Phone extensions</h3>
      <p class="sub">What turns a call into a person. ${fmt(rows.length)} extensions;
        ${fmt(rows.length - unmapped)} are matched to an Odoo employee. An extension with no
        employee still shows its calls — it just cannot be joined to anything that person did in
        the CRM.</p>`;

    if (bad.length) {
      h += `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>${bad.length === 1 ? 'One extension disagrees' : `${bad.length} extensions disagree`}
        with the phone system about who sits there.</strong>
        ${bad.map((r) => `Extension ${esc(r.ext)} is <em>${esc(r.cdrName)}</em> in the export and
          <em>${esc(r.phoneName)}</em> here`).join('; ')}. Until one of them is corrected, every
        call on ${bad.length === 1 ? 'it is' : 'them is'} attributed to a guess. They are at the
        top of the table.</div>`;
    }

    const emp = D.employees || [];
    const teams = D.teams || ['cc', 'branch', 'other'];

    h += `<div class="tw scrolly" style="--minw:860px;--h:460px"><table class="ltab tight">
      <thead><tr><th>Ext</th><th>In the export</th><th>Name on the phone</th>
        <th>Odoo employee</th><th>Team</th><th>Branch</th></tr></thead><tbody>
      ${rows.map((r) => `<tr${conflicts(r) ? ' style="background:rgba(176,80,60,.08)"' : ''}>
        <td class="nm">${esc(r.ext)}${conflicts(r) ? ' <span class="pill">disagrees</span>' : ''}</td>
        <td><span class="sm2">${esc(r.cdrName || '—')}</span></td>
        <td><input data-extfield="phoneName" data-ext="${esc(r.ext)}" value="${esc(r.phoneName)}"></td>
        <td><select data-extfield="odooEmployee" data-ext="${esc(r.ext)}">
          <option value=""${r.odooEmployee ? '' : ' selected'}>— unmapped —</option>
          ${emp.map((e) => `<option value="${esc(e.name)}"${e.name === r.odooEmployee ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}
        </select></td>
        <td><select data-extfield="team" data-ext="${esc(r.ext)}">
          ${teams.map((t) => `<option value="${esc(t)}"${t === r.team ? ' selected' : ''}>${esc(t)}</option>`).join('')}
        </select></td>
        <td><input data-extfield="branch" data-ext="${esc(r.ext)}" value="${esc(r.branch)}"></td>
      </tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:12px">
        <button id="extSave" class="btn" disabled>Save the map</button>
        <span class="sm2" id="extNote">Nothing changed yet.</span>
      </div>`;
    return h;
  }

  /**
   * Bound to the inputs themselves.
   *
   * The Odoo employee is a SELECT rather than a text box on purpose: a typo in
   * a free-text field unmaps an extension silently, and the symptom — calls
   * that stop joining to a person — looks nothing like the cause.
   */
  function wire(el, ctx) {
    if (!el || !el.querySelectorAll) return;
    const note = el.querySelector('#extNote');
    const save = el.querySelector('#extSave');
    const touch = () => {
      if (save) save.disabled = DIRTY.size === 0;
      if (note) {
        note.textContent = DIRTY.size
          ? `${DIRTY.size} extension${DIRTY.size === 1 ? '' : 's'} changed, not saved yet.`
          : 'Nothing changed yet.';
      }
    };
    el.querySelectorAll('[data-extfield]').forEach((n) => {
      n.addEventListener('change', () => {
        const ext = n.dataset.ext;
        if (!DIRTY.has(ext)) DIRTY.set(ext, { ext });
        DIRTY.get(ext)[n.dataset.extfield] = n.value;
        touch();
      });
    });
    if (save) {
      save.addEventListener('click', async () => {
        if (!DIRTY.size) return;
        /* Send the WHOLE row, not just the changed field: the server replaces
           the row it is given, and a partial body would blank the rest. */
        const current = new Map((ctx.data().rows || []).map((r) => [r.ext, r]));
        const rows = [...DIRTY.entries()].map(([ext, changed]) => ({ ...(current.get(ext) || {}), ...changed, ext }));
        try {
          await ctx.api('/api/pbx/extensions', { method: 'PUT', body: JSON.stringify({ rows }) });
          DIRTY.clear();
          await ctx.reload();
        } catch (e) {
          if (note) note.textContent = e.message;
        }
      });
    }
    touch();
  }

  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render, DIRTY };
});
