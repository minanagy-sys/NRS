/* ============================================================
   Admin → Uploads → the weekly UCM export.

   THE KEY TO THE CONTACT CENTRE LOCK. Every Sunday the report closes for
   everyone until last week's UCM CDR is uploaded here. This card says, before
   anything else on the page, whether the report is open or locked and which
   week it is waiting for — because the person who can fix it is the person
   reading this screen.

   TWO STEPS, NEVER ONE. Choosing a file shows what is in it — calls, dials,
   which weeks, and whether it would open the report — and writes nothing.
   Only "Save" stores it. A weekly file that turns out to be the wrong week is
   the commonest mistake there is, and it should be caught on the preview, not
   discovered on Monday.

   The server re-reads the file on save rather than trusting the preview the
   browser saw, so what is stored is what the server parsed.

   Loaded before admin.js, so `AdminUcm` is a global. Bound to its own nodes.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminUcm = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { esc, fmt } = F;

  const nice = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  }) : '—');

  /* The file waiting to be saved, between preview and save. */
  let PENDING = null;

  function statusHtml(g) {
    if (!g || !g.week) return '';
    const wk = `${esc(nice(g.week.from))} → ${esc(nice(g.week.to))}`;
    if (!g.locked) {
      return `<div class="tg-note" style="border-left:3px solid #5e8d4a">
        <strong>The Contact Centre report is open.</strong> ${wk} is uploaded
        (${fmt(g.held.calls)} calls, ${esc(nice(g.held.first))} → ${esc(nice(g.held.last))}).
        It locks again on ${esc(nice(g.locksAgain))} until the following week is in.</div>`;
    }
    const why = g.reason === 'short' && g.held
      ? `What is held for that week stops on ${esc(nice(g.held.last))}; it has to reach at least
         ${esc(nice(g.needsUntil))}. Export the whole week again — it replaces what is there.`
      : 'Nobody has uploaded it yet.';
    return `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>The Contact Centre report is LOCKED for everyone until ${wk} is uploaded.</strong>
      ${why}${g.enforced === false ? ' <em>(The lock is switched off on this server.)</em>' : ''}</div>`;
  }

  function previewHtml(p) {
    if (!p) return '';
    const r = p.required;
    const opens = r && r.calls && r.reachesFriday;
    let verdict;
    if (opens) {
      verdict = `<div class="tg-note" style="border-left:3px solid #5e8d4a"><strong>This file opens the
        report.</strong> ${fmt(r.calls)} calls fall inside ${esc(nice(r.from))} → ${esc(nice(r.to))}.</div>`;
    } else if (r && r.calls) {
      verdict = `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>This file covers part of
        the week but will not open the report</strong> — its last call that week is before
        ${esc(nice(r.to))}'s Friday. You can still save it.</div>`;
    } else {
      verdict = `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>This file is not the week
        the report is waiting for.</strong> It covers ${esc(p.from)} → ${esc(p.to)}; the report needs
        ${esc(r ? `${r.from} → ${r.to}` : 'last week')}. Saving it still stores those weeks, but the report
        stays locked.</div>`;
    }
    return `<div class="tw"><table class="ltab tight"><thead><tr><th>Week</th><th class="n">Calls</th>
        <th class="n">Inbound</th><th class="n">Dials</th><th>First</th><th>Last</th></tr></thead><tbody>
      ${p.weeks.map((w) => `<tr><td class="nm">${esc(nice(w.start))} → ${esc(nice(w.end))}</td>
        <td class="n">${fmt(w.calls)}</td><td class="n">${fmt(w.inbound)}</td><td class="n">${fmt(w.outbound)}</td>
        <td>${esc(nice(w.first))}</td><td>${esc(nice(w.last))}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="sm2" style="margin:6px 0 10px">${esc(p.format === 'grandstream' ? 'Grandstream UCM CDR recognised' : 'Generic CDR — columns matched by name')}
        · ${fmt(p.legs)} rows → ${fmt(p.calls)} calls · ${fmt(p.inbound)} inbound (${fmt(p.answered)} answered)
        · ${fmt(p.outbound)} dials. Each week in the file replaces whatever was uploaded for it before.</div>
      ${verdict}
      <div class="row" style="margin-top:10px"><button class="btn" id="ucmSave">Save</button>
        <button class="btn ghost" id="ucmCancel">Cancel</button></div>`;
  }

  function html(g) {
    return `<h3 class="subtitle" style="margin-top:0">Weekly UCM export</h3>
      <p class="sub">The phone system's call log, every Sunday, for the week just ended
        (Sunday → Saturday). From the UCM: <em>CDR → Export</em>, CSV or Excel.</p>
      ${statusHtml(g)}
      <div class="row" style="margin:10px 0">
        <button class="btn" id="ucmPick">Choose the export…</button>
        <input type="file" id="ucmFile" accept=".csv,.xlsx,.xls" hidden>
        <span class="sm2" id="ucmMsg"></span>
      </div>
      <div id="ucmPreview"></div>`;
  }

  /**
   * ctx: { api, readBase64(file), reload() }
   * Every server call goes through ctx.api so it carries X-Requested-With and
   * the 401 redirect, like every other Admin request.
   */
  function wire(el, ctx) {
    if (!el || !el.querySelector) return;
    const pick = el.querySelector('#ucmPick');
    const input = el.querySelector('#ucmFile');
    const msg = el.querySelector('#ucmMsg');
    const box = el.querySelector('#ucmPreview');
    const say = (t) => { if (msg) msg.textContent = t; };

    if (pick && input) pick.addEventListener('click', () => input.click());
    if (input) {
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        say(`Reading ${file.name}…`);
        try {
          const base64 = await ctx.readBase64(file);
          const p = await ctx.api('/api/ucm/preview', {
            method: 'POST', body: JSON.stringify({ base64, filename: file.name }),
          });
          PENDING = { base64, filename: file.name };
          say('');
          box.innerHTML = previewHtml(p);
          wirePreview(el, ctx);
        } catch (e) {
          PENDING = null;
          box.innerHTML = '';
          say(e.message);
        }
      });
    }
  }

  function wirePreview(el, ctx) {
    const save = el.querySelector('#ucmSave');
    const cancel = el.querySelector('#ucmCancel');
    const msg = el.querySelector('#ucmMsg');
    if (cancel) cancel.addEventListener('click', () => { PENDING = null; el.querySelector('#ucmPreview').innerHTML = ''; });
    if (save) {
      save.addEventListener('click', async () => {
        if (!PENDING) return;
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          const out = await ctx.api('/api/ucm/import', {
            method: 'POST', body: JSON.stringify(PENDING),
          });
          PENDING = null;
          await ctx.reload();
          const m = el.querySelector('#ucmMsg') || msg;
          if (m) {
            m.textContent = `Saved ${fmt(out.calls)} calls for ${out.weeks.length} week${out.weeks.length === 1 ? '' : 's'}.`
              + (out.gate && !out.gate.locked ? ' The Contact Centre report is open.' : ' The report is still locked — see above.');
          }
        } catch (e) {
          save.disabled = false;
          save.textContent = 'Save';
          if (msg) msg.textContent = e.message;
        }
      });
    }
  }

  function render(el, g, ctx) { if (!el) return; el.innerHTML = html(g); wire(el, ctx); }

  return { html, render, previewHtml, statusHtml };
});
