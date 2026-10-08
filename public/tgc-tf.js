/* ============================================================
   06 — Target file. Where the numbers came from, and how to change them.

   EXPORT builds the workbook on the server. The dashboard this page came from
   built it in the browser with SheetJS off a CDN; the CSP here allows neither,
   and the app already writes a workbook Excel opens without a repair prompt.

   IMPORT ASKS FOR THE PASSPHRASE IN PLACE rather than sending you to Admin and
   losing the file you just picked. It shows exactly what it will write before
   writing anything, and it REFUSES rather than guessing:

     a target that cannot be read as a number removes the Publish button and
     names the row, because a typo becoming a silent 0 is the one outcome worth
     refusing;

     a sheet whose groups do not equal their doctors is rejected by the server
     with the arithmetic in the message, and that message is shown as-is.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcTf = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const C = (typeof module === 'object' && module.exports) ? require('./tgc-core.js') : root.TgcCore;

  /**
   * How the four columns are recognised.
   *
   * THE SAME PATTERNS `public/admin.js` USES — the headings on the exported
   * template are chosen so each matches exactly one of them, which is why no
   * manual mapping is needed. `test/export.test.js` already asserts that for
   * admin.js; `test/tgc.test.js` asserts this copy is identical to it, so the
   * two importers cannot drift into reading the same file differently.
   */
  const GUESS = {
    name: 'name|doctor|specialist',
    group: 'group|category|dept',
    target: 'target|august|month',
    prev: 'july|prev|last',
  };

  /** What the file turned into, between picking it and publishing it. */
  let DRAFT = null;

  const num = (v) => {
    const s = String(v == null ? '' : v).replace(/[, ]/g, '').trim();
    if (s === '') return null;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  };

  function render() {
    if (!C.ST.ref) return;
    const { fmt } = C;
    const names = C.branchNames();
    const years = [...new Set(names.flatMap((n) => Object.keys(C.branchPlan(n)).map((k) => k.slice(0, 4))))].sort();
    const total = (y) => C.S(names.map((n) => C.S(Object.entries(C.branchPlan(n))
      .filter(([k]) => k.startsWith(y)).map(([, v]) => v))));
    const docs = Object.keys(C.ST.ref.doctorPlan || {}).length;

    C.$('tfKpi').innerHTML = [
      ...years.map((y) => [y, fmt(total(y)), 'branch plan, ex-VAT']),
      ['Doctors', String(docs), 'on the approved sheet'],
      ['Branches', String(names.length), 'in the plan'],
    ].map(([l, v, s]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`).join('');

    wireExport();
    wireImport();
    if (!DRAFT) {
      C.$('stX').textContent = `The plan on this page is the approved sheet as published: `
        + `${years.map((y) => `${y} ${fmt(total(y))}`).join(' · ')}.`;
    }
  }

  function wireExport() {
    const exp = C.$('expX');
    if (!exp || exp.dataset.wired) return;
    exp.dataset.wired = '1';
    exp.addEventListener('click', () => {
      /* The template is for the month AFTER the one on screen — the point of it
         is setting next month, with this month's figures beside it. */
      const [y, m] = C.ST.range.to.slice(0, 7).split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      location.href = `/api/targets/${next}/next-month.xlsx`;
    });
  }

  function wireImport() {
    const input = C.$('upX');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    input.disabled = false;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) readFile(file);
      input.value = '';
    });
    const reset = C.$('rsX');
    if (reset) {
      reset.hidden = false;
      reset.textContent = 'Discard this file';
      reset.addEventListener('click', () => { DRAFT = null; render(); });
    }
  }

  const b64 = (buf) => {
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  async function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body),
    });
  }

  /** Ask once, in place, and only when the server says it is needed. */
  async function unlock(st) {
    const pass = window.prompt('Admin passphrase — reading and publishing a target sheet both need it:');
    if (!pass) { st.textContent = 'Stopped: the passphrase is needed to read a target sheet.'; return false; }
    const r = await post('/auth/unlock', { passphrase: pass });
    if (!r.ok) { st.textContent = 'That passphrase was not accepted. Nothing was read or written.'; return false; }
    return true;
  }

  async function readFile(file) {
    const st = C.$('stX');
    st.textContent = `Reading ${file.name}…`;
    if (/\.numbers$/i.test(file.name)) {
      st.textContent = 'Numbers files cannot be read. Export it as .xlsx or .csv first.';
      return;
    }

    const base64 = b64(await file.arrayBuffer());
    let res = await post('/api/targets/parse', { base64, all: true });
    if (res.status === 403) {
      if (!(await unlock(st))) return;
      res = await post('/api/targets/parse', { base64, all: true });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) { st.textContent = `Could not read it: ${body.error || res.status}`; return; }

    build(file.name, body);
  }

  /** Turn the parsed rows into the sheet the publisher expects, or say why not. */
  function build(filename, parsed) {
    const st = C.$('stX');
    const cols = parsed.columns || [];
    const find = (k) => cols.find((c) => new RegExp(GUESS[k], 'i').test(c));
    const cName = find('name');
    const cTarget = find('target');
    const cGroup = find('group');
    const cPrev = find('prev');

    if (!cName || !cTarget) {
      st.textContent = `${filename}: could not find a name column and a target column. `
        + `The headings read: ${cols.join(', ')}.`;
      return;
    }

    const rows = (parsed.rows || []).filter((r) => String(r[cName] || '').trim()
      && !/^total$/i.test(String(r[cName]).trim()));

    const bad = [];
    const doctors = [];
    for (const r of rows) {
      const v = num(r[cTarget]);
      if (Number.isNaN(v)) { bad.push({ name: String(r[cName]).trim(), raw: String(r[cTarget]) }); continue; }
      doctors.push({
        name: String(r[cName]).trim(),
        group: cGroup ? String(r[cGroup] || '').trim() || null : null,
        monthlyTarget: v == null ? 0 : v,
        prevMonth: cPrev ? (num(r[cPrev]) ?? null) : null,
        hasSales: true,
      });
    }

    /* Groups are DERIVED by summing their doctors, so the sheet reconciles by
       construction — the server checks it again anyway, and the original
       report's defect was a sheet that did not. */
    const groups = {};
    for (const d of doctors) {
      const g = d.group || 'Ungrouped';
      groups[g] ||= { target: 0, rosterCount: 0, unlistedCount: 0, unlistedTarget: 0 };
      groups[g].target += d.monthlyTarget;
      groups[g].rosterCount += 1;
    }

    DRAFT = { filename, doctors, groups, bad, period: guessPeriod(filename, cTarget) };
    preview();
  }

  /** The month the sheet is for: from the filename, else the target heading. */
  function guessPeriod(filename, heading) {
    const inName = String(filename).match(/(\d{4})-(0[1-9]|1[0-2])/);
    if (inName) return `${inName[1]}-${inName[2]}`;
    const inHead = String(heading).match(/(\d{4})-(0[1-9]|1[0-2])/);
    if (inHead) return `${inHead[1]}-${inHead[2]}`;
    const [y, m] = C.ST.range.to.slice(0, 7).split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  /** What it will write, before it writes anything. */
  function preview() {
    const { fmt, esc } = C;
    const d = DRAFT;
    const st = C.$('stX');
    const total = C.S(d.doctors.map((x) => x.monthlyTarget));
    const groupNames = Object.keys(d.groups);
    const zero = d.doctors.filter((x) => !x.monthlyTarget);

    st.innerHTML = `<div class="tg-note" style="margin-top:10px">
      <strong>Read ${esc(d.filename)}</strong><br>
      Period <b>${esc(d.period)}</b> · ${d.doctors.length} doctors across ${groupNames.length} group${groupNames.length === 1 ? '' : 's'}
      — ${esc(groupNames.join(', '))}<br>
      Total <b>${fmt(total)}</b> EGP ex-VAT
      ${zero.length ? `<br>${zero.length} doctor${zero.length === 1 ? '' : 's'} would be published at 0 — ${esc(zero.slice(0, 4).map((x) => x.name).join(', '))}${zero.length > 4 ? '…' : ''}` : ''}
      ${d.bad.length
    ? `<br><span class="dn"><b>${d.bad.length} target${d.bad.length === 1 ? '' : 's'} cannot be read as a number</b> — `
      + `${esc(d.bad.slice(0, 4).map((x) => `${x.name} ("${x.raw}")`).join(', '))}${d.bad.length > 4 ? '…' : ''}. `
      + 'Nothing can be published until those are corrected: a typo becoming a silent 0 is the one outcome worth refusing.</span>'
    : ''}
      <div class="tools" style="margin-top:12px">
        ${d.bad.length ? '' : `<button class="btn" id="tfPublish">Publish ${esc(d.period)}</button>`}
        <button class="btn ghost" id="tfAdmin">Review in admin</button>
        <button class="btn ghost" id="tfCancel">Cancel</button>
      </div></div>`;

    const pub = C.$('tfPublish');
    if (pub) pub.addEventListener('click', publish);
    C.$('tfAdmin').addEventListener('click', () => { location.href = '/admin#import'; });
    C.$('tfCancel').addEventListener('click', () => { DRAFT = null; render(); });
  }

  async function publish() {
    const st = C.$('stX');
    const d = DRAFT;
    const body = {
      daysInPeriod: null,
      sourceLabel: `Imported from ${d.filename}`,
      groups: d.groups,
      doctors: d.doctors,
      /* Branch targets are not in this file and are CARRIED FORWARD rather than
         deleted — the publish replaces the period wholesale, so sending nothing
         would silently drop them. */
      branches: await carriedBranches(),
    };

    st.textContent = 'Checking the sheet reconciles…';
    const check = await post('/api/targets/validate', body);
    const checked = await check.json().catch(() => ({}));
    if (!checked.ok) {
      st.innerHTML = `<div class="tg-note"><strong>The sheet does not reconcile, so nothing was written.</strong><br>`
        + `${(checked.problems || []).map((p) => C.esc(String(p))).join('<br>')}</div>`;
      return;
    }

    let res = await fetch(`/api/targets/${d.period}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body),
    });
    if (res.status === 403) {
      if (!(await unlock(st))) return;
      res = await fetch(`/api/targets/${d.period}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(body),
      });
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) {
      st.innerHTML = `<div class="tg-note"><strong>Not published: ${C.esc(out.error || String(res.status))}</strong>`
        + `${(out.problems || []).map((p) => `<br>${C.esc(String(p))}`).join('')}</div>`;
      return;
    }
    DRAFT = null;
    C.ST.ref = await C.api('/api/tgc/reference');
    render();
    C.$('stX').textContent = `Published ${out.period || ''}. The report now reads the new sheet.`;
  }

  /** The branch targets on the most recent published sheet, if there is one. */
  async function carriedBranches() {
    try {
      const list = await C.api('/api/targets');
      const latest = (list.periods || list || []).map((p) => p.period || p).sort().pop();
      if (!latest) return [];
      const sheet = await C.api(`/api/targets/${latest}`);
      return (sheet.branches || sheet.branchTargets || []).map((b) => ({
        name: b.scheduleName || b.name,
        target1: b.target1,
        target2: b.target2 ?? null,
      }));
    } catch {
      return [];
    }
  }

  return { render, GUESS };
});
