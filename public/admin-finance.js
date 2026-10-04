/* ============================================================
   The finance side of /admin — Data sources, the Odoo payables sync, and the
   payables Excel export/import.

   LIFTED OUT OF public/admin.js ON 2026-08-19, verbatim, when Mina asked for the
   Finance report to be hidden. This file is NOT loaded by any page: admin.html
   does not reference it and the /api/finance routes are not registered unless
   FINANCE_ENABLED=1.

   It is kept because the repository has no commits, so deleting it would destroy
   working code with no way back. To restore the tab:
     1. FINANCE_ENABLED=1 in .env
     2. re-add the tab button and <div class="panel" id="sources"></div> to
        src/views/admin.html
     3. load this file from admin.html before admin.js
     4. add  sources: renderSources  back to the LOADERS map in admin.js
   ============================================================ */

/* ---- 06 · where each finance section reads from ---- */

const SECTION_LABEL = {
  collections: 'Collections', payables: 'Payables',
  recon: 'Sold vs Issued', expiry: 'Expiry Risk',
};

async function renderSources() {
  const { sections } = await api('/api/finance/sources');

  $('sources').innerHTML = `<section>
    <div class="kicker">06 — Data sources</div>
    <h2 class="title">Where each finance figure comes from</h2>
    <p class="sub">Switching a section changes what the report reads. It never deletes anything — the
      imported rows stay where they are, so you can switch back and the figures return.</p>
    <div class="tg-note"><strong>snapshot</strong> reads the imported extract ·
      <strong>odoo</strong> reads the live sync and ignores the import ·
      <strong>stitched</strong> reads the import before a cutover date and Odoo from it onward.</div>
    ${sections.map((s) => card(s)).join('')}
  </section>`;

  $('sources').querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => saveSource(b.dataset.save)));
  $('sources').querySelectorAll('[data-sync]').forEach((b) => b.addEventListener('click', () => syncSource(b.dataset.sync)));
  $('sources').querySelectorAll('[data-xlsout]').forEach((b) => b.addEventListener('click', () => exportPayables()));
  $('sources').querySelectorAll('[data-xls]').forEach((b) => b.addEventListener('click', () =>
    $('sources').querySelector(`[data-xlsfile="${b.dataset.xls}"]`).click()));
  $('sources').querySelectorAll('[data-xlsfile]').forEach((input) => input.addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';               // so picking the same file twice still fires
    if (f) importPayables(f);
  }));
  $('sources').querySelectorAll('[data-mode]').forEach((sel) => sel.addEventListener('change', () => {
    const wrap = $(`cut-${sel.dataset.mode}`);
    if (wrap) wrap.style.display = sel.value === 'stitched' ? '' : 'none';
  }));
}

function card(s) {
  const snap = s.batches.find((b) => b.source === 'snapshot');
  const live = s.batches.find((b) => b.source === 'odoo');
  const row = (label, batch, count) => `<div class="recon-line">
    <span>${label}</span>
    <span>${count ? `${fmt(count)} rows` : 'nothing loaded'}${batch ? ` · as of ${esc(batch.asOf)} · imported ${new Date(batch.importedAt).toLocaleDateString('en-GB')}` : ''}</span>
  </div>`;

  return `<div class="recon" style="margin-top:14px">
    <h4>${esc(SECTION_LABEL[s.section] || s.section)} — reading <strong>${esc(s.mode)}</strong>${s.cutover ? ` from ${esc(s.cutover)}` : ''}</h4>
    ${row('Imported snapshot', snap, s.counts.snapshot)}
    ${row('Live from Odoo', live, s.counts.odoo)}
    ${s.odooPossible ? '' : `<div class="problem">Odoo 18 holds no history for this section before 2026-08-01,
      so it cannot read Odoo alone. Stitched is the honest setting.</div>`}
    <div class="row-actions" style="margin-top:10px">
      <div class="field" style="margin:0">
        <label>Mode</label>
        <select data-mode="${esc(s.section)}" id="mode-${esc(s.section)}">
          ${['snapshot', 'odoo', 'stitched'].map((m) => `<option value="${m}"${m === s.mode ? ' selected' : ''}${m === 'odoo' && !s.odooPossible ? ' disabled' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin:0;display:${s.mode === 'stitched' ? '' : 'none'}" id="cut-${esc(s.section)}">
        <label>Odoo takes over</label>
        <input type="date" id="cutover-${esc(s.section)}" value="${esc(s.cutover || '')}">
      </div>
      <button class="btn" data-save="${esc(s.section)}">Apply</button>
      <button class="btn ghost" data-sync="${esc(s.section)}">Fetch from Odoo 18</button>
      ${s.section === 'payables' ? `<button class="btn ghost" data-xlsout="payables">Export Excel</button>
        <button class="btn ghost" data-xls="payables">Import Excel</button>
        <input type="file" data-xlsfile="payables" accept=".xlsx,.xls,.csv" hidden>` : ''}
    </div>
    ${s.section === 'payables' ? `<div class="recon-line" style="margin-top:8px">
      <span>Imported rows are merged, never replaced.</span>
      <span>An Excel import updates the suppliers it names and adds the ones it does not — everything already loaded stays.</span>
    </div>` : ''}
  </div>`;
}

async function saveSource(section) {
  clearErr();
  try {
    const mode = $(`mode-${section}`).value;
    const cutover = ($(`cutover-${section}`) || {}).value || null;
    const out = await api(`/api/finance/sources/${section}`, {
      method: 'PUT', body: JSON.stringify({ mode, cutover }),
    });
    await renderSources();
    $('err').innerHTML = `<span style="color:#9fe08a">${esc(SECTION_LABEL[section])} now reads
      <strong>${esc(out.mode)}</strong>${out.cutover ? ` from ${esc(out.cutover)}` : ''}. Nothing was deleted.</span>`;
  } catch (e) { fail(e); }
}

async function syncSource(section) {
  clearErr();
  const from = prompt(`Fetch ${SECTION_LABEL[section]} from Odoo 18 — from which date?`, '2026-08-01');
  if (!from) return;
  try {
    const r = await api(`/api/finance/sync/${section}`, {
      method: 'POST', body: JSON.stringify({ from, to: new Date().toISOString().slice(0, 10) }),
    });
    await renderSources();
    /* The report is the point: "found" versus "written" is what tells you whether
       Odoo actually has the history yet. */
    const bits = [
      `${fmt(r.billsWritten)} of ${fmt(r.billsFound)} bills`,
      `${fmt(r.paymentsWritten)} of ${fmt(r.paymentsFound)} payments`,
    ];
    if (r.earliestBill) bits.push(`earliest bill ${esc(r.earliestBill)}`);
    if (r.paymentsNoVendor) bits.push(`${fmt(r.paymentsNoVendor)} payments carry no vendor and could not be filed (${fmt(r.paymentTotalNoVendor)} EGP)`);
    if (r.suppliersCreated && r.suppliersCreated.length) bits.push(`${r.suppliersCreated.length} new supplier(s): ${r.suppliersCreated.slice(0, 5).map(esc).join(', ')}`);
    if (r.unmappedJournals && r.unmappedJournals.length) bits.push(`${r.unmappedJournals.length} journal(s) with no payment method mapped`);
    bits.push('balances were not synced — they stay as extracted');
    $('err').innerHTML = `<span style="color:#9fe08a">Odoo 18, ${esc(r.from)} to ${esc(r.to)}: ${bits.join(' · ')}.</span>`;
  } catch (e) { fail(e); }
}

/**
 * Download the stored payables as an editable workbook.
 *
 * Fetched rather than linked: the session cookie is SameSite=Lax, so a plain
 * <a download> would hand the whole supplier ledger to any site that linked it,
 * and an error would arrive as a corrupt .xlsx instead of a message.
 */
async function exportPayables() {
  clearErr();
  try {
    const res = await fetch('/api/finance/payables/export.xlsx', { headers: { 'X-Requested-With': 'fetch' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const named = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const href = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href, download: named ? named[1] : 'payables.xlsx' });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(href);
    $('err').innerHTML = '<span style="color:#9fe08a">Exported. Edit it, then Import Excel — '
      + 'each worksheet imports separately, so a full round trip is three imports.</span>';
  } catch (e) { fail(e); }
}

/**
 * Import a payables workbook. Reads it, asks what kind of sheet it is, shows what
 * would change, and only then merges it in.
 */
async function importPayables(file) {
  clearErr();
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });
    let info = await api('/api/finance/payables/inspect', { method: 'POST', body: JSON.stringify({ base64 }) });

    /* A workbook exported from here has three worksheets, so ask which one before
       asking what it is — the name usually answers the second question anyway. */
    if (info.sheets.length > 1) {
      const pick = prompt(
        `${file.name} has ${info.sheets.length} worksheets:\n\n`
        + info.worksheets.map((w, i) => `  ${i + 1}. ${w.name}${w.kind ? ` — ${w.kind}` : ''}`).join('\n')
        + '\n\nWhich one? (name or number)',
        info.sheets[0],
      );
      if (!pick) return;
      const chosen = /^\d+$/.test(pick.trim())
        ? info.sheets[Number(pick.trim()) - 1]
        : info.sheets.find((n) => n.toLowerCase() === pick.trim().toLowerCase());
      if (!chosen) throw new Error(`No worksheet called "${pick}".`);
      info = await api('/api/finance/payables/inspect', { method: 'POST', body: JSON.stringify({ base64, sheet: chosen }) });
    }

    const kind = await askKind(file, info);
    if (!kind) return;

    const dry = await api('/api/finance/payables/import', {
      method: 'POST', body: JSON.stringify({ base64, kind, sheet: info.sheet, dryRun: true }),
    });
    if (!confirm(summarise(file, kind, dry))) return;

    const out = await api('/api/finance/payables/import', {
      method: 'POST', body: JSON.stringify({ base64, kind, sheet: info.sheet }),
    });
    await renderSources();
    $('err').innerHTML = `<span style="color:#9fe08a">Imported ${fmt(out.written)} ${esc(kind)} rows across
      ${fmt(out.suppliers)} supplier(s)${out.suppliersNew.length ? `, ${out.suppliersNew.length} of them new` : ''}.
      Nothing was deleted.</span>`;
  } catch (e) { fail(e); }
}

/* Which of the three shapes this sheet is. Guessing would be worse than asking:
   a bills sheet read as balances would overwrite every closing figure. */
function askKind(file, info) {
  const options = ['balances', 'bills', 'payments'];
  const answer = prompt(
    `${file.name}\nWorksheet "${info.sheet}" · ${info.rowCount} rows\nColumns: ${info.columns.join(', ')}\n\n`
    + `What is this sheet?\n  balances — one row per supplier (opening / closing)\n`
    + `  bills — one row per vendor bill\n  payments — one row per payment out\n\n`
    + (info.likely ? `Looks like: ${info.likely}` : 'None of the three matched cleanly — check the columns.'),
    info.likely || 'balances',
  );
  const kind = String(answer || '').trim().toLowerCase();
  return options.includes(kind) ? kind : null;
}

function summarise(file, kind, dry) {
  const lines = [`${file.name} — import as ${kind}?`, '', `${dry.rows} rows`];
  if (dry.suppliersNew.length) lines.push(`${dry.suppliersNew.length} new supplier(s): ${dry.suppliersNew.slice(0, 6).join(', ')}`);
  lines.push(`${dry.suppliersExisting} supplier(s) already known — their rows are updated, not replaced`);
  if (kind === 'balances') {
    lines.push(`closing in the sheet: ${fmt(dry.closingTotal)}`, `currently stored for those suppliers: ${fmt(dry.closingBefore)}`);
  } else if (kind === 'bills') {
    lines.push(`purchases in the sheet: ${fmt(dry.grossTotal)}`, `${dry.replacing} bill(s) already imported under the same reference will be replaced`);
  } else {
    lines.push(`payments in the sheet: ${fmt(dry.amountTotal)}`, `${dry.replacing} identical payment(s) already imported will be replaced`);
  }
  if (dry.skippedCount) lines.push('', `${dry.skippedCount} row(s) skipped: ${dry.skipped.slice(0, 4).join('; ')}`);
  lines.push('', 'Nothing is deleted.');
  return lines.join('\n');
}
