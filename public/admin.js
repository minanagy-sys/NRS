/* ============================================================
   Admin screens.

   The editor's job is to make a sheet's arithmetic visible while it is being
   changed. The server refuses any sheet where a group target ≠ its doctors plus
   its unlisted figure — the defect the original report shipped — so the ledger
   here shows that same sum live, and Publish stays disabled until it balances.
   ============================================================ */

/* From public/fmt.js — one copy of these for every page. They had drifted
   apart by 2026-10-04 (two `pc`, two `esc`); see that file. */
const { $, fmt, escAll: esc } = Fmt;

const api = async (url, opts = {}) => {
  const headers = { 'X-Requested-With': 'fetch', Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(json.error || `HTTP ${res.status}`);
    e.problems = json.problems;
    throw e;
  }
  return json;
};

const fail = (e) => {
  $('err').innerHTML = esc(e.message) + (e.problems ? `<ul style="margin:6px 0 0 16px">${e.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '');
};
const clearErr = () => { $('err').textContent = ''; };

/* State shared by the editor and the importer: one sheet being worked on. */
let DRAFT = null;
let ODOO = { doctors: [], branches: [] };

/* ---- 01 · what needs doing -----------------------------------------------

   THE PANEL ADMIN OPENS ON. Everything it reports was already discoverable —
   the missing-month card on Periods, the coverage line on Contact Centre, the
   unlinked count on Inventory's cover tab — and every one of them needed
   somebody to go and look. On 2026-09-13 nobody had for thirteen days, while
   7.5 M of September revenue was scored against a sheet that did not exist.

   Ranked by `src/lib/admin-status.js`, which measures rather than guesses: a
   month with revenue already in it outranks one that has not started. Each row
   carries the figure that makes it matter and a button that goes to the fix. */

const SEV = {
  blocking: { label: 'Blocking', colour: '#b0503c', note: 'a report is showing nothing, or less than it should, right now' },
  overdue: { label: 'Overdue', colour: '#c98a2e', note: 'what is on screen is real, just old — or about to run out' },
  tidy: { label: 'Worth doing', colour: 'var(--taupe)', note: 'nothing is wrong today; these quietly shrink what a report can see' },
};

async function renderStatus() {
  const S = await api('/api/admin/status');

  let h = `<section>
    <div class="kicker">01 — Needs attention</div>
    <h2 class="title">${S.clean ? 'Nothing is waiting on you' : 'What needs you'}</h2>`;

  if (S.clean) {
    h += `<div class="ok-note"><strong>Every input is current.</strong> Target sheets cover this
      month and next, every hand-fed feed is inside its cadence, and every name and product
      resolves. Checked ${esc(new Date(S.at).toLocaleString('en-GB'))}.</div>`;
    $('status').innerHTML = `${h}</section>`;
    return;
  }

  h += `<p class="sub">Ten reports keep themselves current from Odoo. Everything below is fed by
      hand — a sheet somebody approves, a rate somebody negotiates, an export somebody
      downloads — and this is the only place that says when one has gone quiet.
      Checked ${esc(new Date(S.at).toLocaleString('en-GB'))}.</p>

    <p class="sub" style="margin-bottom:6px">Checked ${esc(new Date(S.at).toLocaleString('en-GB'))} —
      read live, never cached, because a stale list about stale data is no use.</p>`;

  /* THE FOUR COUNT CARDS WERE HERE and are gone at Mina's request. They restated
     what the list already shows, one card per severity, and the list is the
     thing anybody acts on: a row names the month, the money and the button. A
     card saying "2" names nothing.
     `S.counts` still travels in the payload and test/admin-status.test.js still
     asserts it adds up to the items — that check is what stops a summary and a
     list disagreeing. It simply is not drawn any more. */

  for (const it of S.items) {
    const sev = SEV[it.severity] || SEV.tidy;
    h += `<div class="listcard" style="border-left:4px solid ${sev.colour}">
      <div class="listcard-head">
        <h3>${esc(it.title)}</h3>
        <span class="sev ${it.severity === 'blocking' ? 'BLOCKER' : it.severity === 'overdue' ? 'HIGH' : 'LOW'}">${esc(sev.label)}</span>
      </div>
      <div class="pcard-body" style="padding:12px 18px 16px">
        <div style="font-size:13px;color:var(--ink);line-height:1.6"><strong>${esc(it.cost)}</strong></div>
        <div class="sm2" style="margin-top:6px;line-height:1.6">${esc(it.detail)}</div>
        <div class="row-actions" style="margin:12px 0 0">${actionsFor(it)}</div>
      </div>
    </div>`;
  }

  h += `<div class="tg-note">This list is computed from <code>src/lib/feeds.js</code>, which is
    where every hand-fed input declares what fills it, how often it should arrive and which
    reports go quiet without it. A feed nobody intends to keep feeding is retired by setting its
    cadence to null there — not by ignoring a row here forever.</div>`;

  $('status').innerHTML = `${h}</section>`;
}

/** The buttons on a status row. A row with no fix offers no button. */
function actionsFor(it) {
  const a = it.action || {};
  const out = [];

  if (it.key.startsWith('period:')) {
    if (a.resume) {
      out.push(`<button class="btn" data-resume="${esc(it.period)}">Resume the ${esc(it.period)} draft</button>`);
    } else if (a.carryFrom) {
      out.push(`<button class="btn" data-carry="${esc(a.carryFrom)}">Start ${esc(it.period)} from ${esc(a.carryFrom)}</button>`);
    }
    out.push(`<button class="btn ghost" data-goto="periods">Open Periods</button>`);
  } else if (a.tab) {
    out.push(`<button class="btn" data-goto="${esc(a.tab)}">Open ${esc(a.tab === 'data' ? 'Data' : a.tab === 'mapping' ? 'Mapping' : a.tab === 'commission' ? 'Commission' : 'Periods')}</button>`);
  }

  /* An Odoo or API feed has no button on purpose: nobody fixes it by hand, a
     timer does. Saying so beats a button that would do nothing. */
  if (!out.length) {
    out.push('<span class="hint" style="color:var(--muted);font-size:11.5px">Runs on a timer — nothing to do by hand.</span>');
  }
  return out.join('');
}

/* ---- 02 · the sheets that exist ---- */

/* Setting up a new month used to mean one of two things: leave here, pick the
   right range on the report, press Export, fill in Excel, come back and Import;
   or press "Start an empty sheet" and retype 73 names. Both work. Neither is
   something anyone does once a month without dreading it.

   So this panel now says which month is missing and offers the roster already
   carried across, with the targets — and only the targets — left blank. The
   workbook is still here for anyone who wants to fill it in offline or send it
   round for approval; it is one button instead of a trip to another page. */

async function renderPeriods() {
  const [list, drafts] = await Promise.all([
    api('/api/targets'),                              // newest first
    /* Unfinished months. A draft is not a sheet — no report reads one — but the
       calendar has to show it, or somebody starts the same month twice. */
    api('/api/targets/drafts').catch(() => []),
  ]);
  const have = new Set(list.map((p) => p.period));
  const newest = list[0] || null;

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  /* The month worth pointing at is the earliest one with no sheet: normally the
     month after the newest sheet, but if that is already in the past then the
     CURRENT month is the one the report is scoring nothing against, and saying
     "next up: September" in November would be answering a question nobody
     asked. */
  const after = newest ? Draft.nextPeriod(newest.period) : thisMonth;
  const wanted = after && after > thisMonth ? after : (have.has(thisMonth) ? after : thisMonth);
  const scoringNow = !have.has(thisMonth);

  $('periodsList').innerHTML = `<section>
    <div class="kicker">02 — Target sheets</div>
    <h2 class="title">One per month</h2>
    <p class="sub">Each sheet is the approved schedule for its month. The report scores whichever month the selected range ends in.</p>

    ${wanted && !have.has(wanted) ? nextMonthCard(wanted, newest, scoringNow && wanted === thisMonth) : ''}

    ${/* `newest` is the ROW here — nextMonthCard reads its doctor and branch
          counts — but the calendar only ever needs the period string, and
          handing it the object made every cell throw on `.slice`. */
    monthCalendar(list, drafts, thisMonth, newest ? newest.period : null)}

    ${list.length ? `<div class="tw"><table class="ltab"><thead><tr>
        <th>Period</th><th>Source</th><th class="n">Days</th><th class="n">Doctors</th><th class="n">Branches</th><th class="n">Published</th><th></th>
      </tr></thead><tbody>${list.map((p) => {
        const next = Draft.nextPeriod(p.period);
        return `<tr>
        <td class="nm">${esc(p.period)}${p.period === thisMonth ? ' <span class="pill">this month</span>' : ''}</td>
        <td>${esc(p.sourceLabel || '—')}</td>
        <td class="n">${p.daysInPeriod}</td>
        <td class="n">${fmt(p.doctors)}</td>
        <td class="n">${fmt(p.branches)}</td>
        <td class="n">${new Date(p.publishedAt).toLocaleDateString('en-GB')}</td>
        <td class="n" style="white-space:nowrap">
          <button class="btn ghost" data-edit="${esc(p.period)}">Edit</button>
          <button class="btn ghost" data-xlsx="${esc(p.period)}" title="Download next month's schedule as a workbook to fill in">Template</button>
          <button class="btn ${have.has(next) ? 'ghost' : ''}" data-carry="${esc(p.period)}"
            title="${have.has(next) ? `${next} already exists — this would replace it` : `Start ${next} with this roster, targets blank`}">Start ${esc(next)}${have.has(next) ? ' again' : ''}</button>
        </td>
      </tr>`;
      }).join('')}</tbody></table></div>`
      : `<div class="tg-note">No sheets yet. Import one under <strong>Import Excel</strong>, or seed the August 2026 sheet with <code>node scripts/seed-targets.js</code>.</div>`}

    <div class="row-actions">
      <button class="btn ghost" id="newSheet">Start an empty sheet</button>
      <span class="hint" style="color:var(--muted);font-size:11.5px">A blank sheet means typing every doctor by hand — use <strong>Start ${esc(wanted || 'next month')}</strong> above unless the roster is genuinely changing wholesale.</span>
    </div>
  </section>`;

  $('periodsList').querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openEditor(b.dataset.edit)));
  $('periodsList').querySelectorAll('[data-carry]').forEach((b) =>
    /* A calendar cell names the month it is FOR; the card does not, and starts
       whatever comes after the sheet it carries from. */
    b.addEventListener('click', () => startNextMonth(b.dataset.carry, have, b.dataset.for || null)));
  $('periodsList').querySelectorAll('[data-resume]').forEach((b) =>
    b.addEventListener('click', () => resumeDraft(b.dataset.resume)));
  $('periodsList').querySelectorAll('[data-xlsx]').forEach((b) =>
    b.addEventListener('click', () => downloadTemplate(b.dataset.xlsx, b)));

  $('newSheet').addEventListener('click', () => {
    /* It used to take today's month with no asking, which on 8 September
       silently aimed at a month that may already be published — and Publish
       replaces a period wholesale. Ask, and default to the one that is missing. */
    const period = (prompt('Which month? Use YYYY-MM.', wanted || thisMonth) || '').trim();
    if (!period) return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) { fail(new Error(`"${period}" is not a month. Use 2026-10.`)); return; }
    if (have.has(period) && !confirm(`${period} is already published. Publishing an empty sheet REPLACES it. Continue?`)) return;
    DRAFT = { period, daysInPeriod: daysIn(period), sourceLabel: '', groups: {}, doctors: [], branches: [] };
    renderEditor(); go('periods'); scrollToEditor();
  });
}

/**
 * A year of months, and what each one has.
 *
 * THE ANSWER TO "how do I add targets for a new month". The list of published
 * sheets answers "what exists"; it cannot answer "what is missing", because a
 * missing month is precisely the row that is not there. Twelve cells can.
 *
 *   published  a sheet exists and reports read it
 *   draft      somebody started it and stopped — no report reads it
 *   due        the month has started and has neither
 *   ahead      not started yet, so not a problem yet
 *
 * `due` and `ahead` are the same absence and deliberately look different: one
 * is money already unmeasured, the other is a diary entry, and colouring them
 * alike is how twelve amber squares teach somebody to ignore the row.
 */
function monthCalendar(list, drafts, thisMonth, newest) {
  const year = Number((newest || thisMonth).slice(0, 4));
  const have = new Set(list.map((p) => p.period));
  const draftAt = new Map((drafts || []).map((d) => [d.period, d]));

  const cells = [];
  for (let m = 1; m <= 12; m += 1) {
    const p = `${year}-${String(m).padStart(2, '0')}`;
    const label = new Date(`${p}-01T00:00:00Z`)
      .toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    const sheet = list.find((x) => x.period === p);
    const draft = draftAt.get(p);
    const state = sheet ? 'published' : draft ? 'draft' : (p <= thisMonth ? 'due' : 'ahead');
    const note = sheet ? `${fmt(sheet.doctors)} doctors`
      : draft ? `saved ${new Date(draft.savedAt).toISOString().slice(5, 10)}`
        : state === 'due' ? 'nothing set' : '—';

    cells.push(`<button class="mcell ${state}" ${sheet ? `data-edit="${esc(p)}"`
      : draft ? `data-resume="${esc(p)}"`
        : newest ? `data-carry="${esc(newest)}" data-for="${esc(p)}"` : 'disabled'}
        title="${esc(sheet ? `Published ${new Date(sheet.publishedAt).toLocaleDateString('en-GB')} — click to edit`
    : draft ? 'Unfinished draft — click to pick it back up'
      : newest ? `Start ${p} from ${newest}` : 'No sheet to carry from')}">
      <span class="mc-m">${esc(label)}</span>
      <span class="mc-s">${esc(state === 'ahead' ? '' : state)}</span>
      <span class="mc-n">${esc(note)}</span>
    </button>`);
  }

  const due = cells.filter((c) => c.includes('mcell due')).length;
  return `<h3 class="subtitle">${year} at a glance
      <span class="vat-tag">${have.size} published${draftAt.size ? ` · ${draftAt.size} draft` : ''}${due ? ` · ${due} due` : ''}</span></h3>
    <div class="mgrid">${cells.join('')}</div>
    <div class="tg-note">A <strong>draft</strong> is a month somebody started and stopped —
      the roster is carried and the numbers are not in yet. <strong>No report reads a draft.</strong>
      Publishing one replaces the month wholesale and clears the draft behind it.</div>`;
}

/** The call to action: which month has no sheet, and the two ways to make one. */
function nextMonthCard(period, newest, isCurrent) {
  const label = new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `<div class="recon bad" id="nextCard">
    <h4>${esc(period)} has no target sheet</h4>
    <div class="recon-line">
      <span>${esc(label)}${isCurrent ? ' — the month the report is scoring right now' : ''}</span>
      <span>${isCurrent
        ? 'Every range ending in it shows <strong>no approved target</strong>, on this report and on Doctors Performance.'
        : 'Set it up before the month starts and the pace bars work from day one.'}</span>
    </div>
    ${newest ? `<div class="row-actions" style="margin-bottom:0">
      <button class="btn" data-carry="${esc(newest.period)}">Start ${esc(period)} from ${esc(newest.period)}</button>
      <button class="btn ghost" data-xlsx="${esc(newest.period)}">Download the workbook instead</button>
      <span class="hint" style="color:var(--muted);font-size:11.5px">Carries ${fmt(newest.doctors)} doctors and ${fmt(newest.branches)} branch targets. Every monthly target comes across <strong>blank</strong> — last month's sits beside it as "prev".</span>
    </div>` : ''}
  </div>`;
}

/**
 * Start next month from a published sheet, in the editor, ready to type into.
 *
 * Deliberately NOT a one-click publish. It opens the editor with everything but
 * the numbers, because publishing is the step that changes what every pace bar
 * on the report means.
 */
async function startNextMonth(from, have, forPeriod) {
  clearErr();
  try {
    const sheet = await api(`/api/targets/${from}`);
    const draft = Draft.carryForward(sheet);
    if (!draft) throw new Error(`Could not work out the month after ${from}.`);

    /* A CALENDAR CELL NAMES THE MONTH IT IS FOR, and it need not be the one
       straight after the sheet being carried. Clicking November while the only
       sheet is August must produce November — `carryForward` always rolls
       forward by one, so the period is overridden here and the day count with
       it, or a 30-day month would inherit a 31-day divisor and every daily
       target would be quietly wrong. */
    if (forPeriod && forPeriod !== draft.period) {
      draft.period = forPeriod;
      draft.daysInPeriod = Draft.daysInPeriod(forPeriod);
      draft.sourceLabel = `Carried from ${from}`;
    }

    if (have && have.has(draft.period)
      && !confirm(`${draft.period} is already published. You can build it again here, but Publish will REPLACE the existing sheet. Continue?`)) return;
    DRAFT = draft;
    renderEditor();
    go('periods');
    scrollToEditor();
    $('err').innerHTML = `<span style="color:#9fe08a">${esc(draft.period)} started from ${esc(from)} — ${fmt(draft.doctors.length)} doctors and ${fmt(draft.branches.length)} branches carried, every target blank. Fill in the monthly targets, then <strong>Balance groups</strong>, then Publish.</span>`;
  } catch (e) { fail(e); }
}

/**
 * Next month's workbook, for filling in offline or sending round for approval.
 *
 * Fetched rather than linked, for the reason app.js states: the session cookie
 * is SameSite=Lax and would ride along on a top-level GET from any site, and an
 * error would arrive as a corrupt .xlsx instead of a message.
 *
 * `to` is the last day of the period being exported, not today: the workbook's
 * actuals columns are that month's, and on 8 September an unclamped window
 * would put September's invoices under August's heading. The route clamps as
 * well — this is not the only caller.
 */
async function downloadTemplate(period, btn) {
  clearErr();
  if (btn) btn.disabled = true;
  try {
    const to = `${period}-${String(Draft.daysInPeriod(period)).padStart(2, '0')}`;
    const res = await fetch(`/api/targets/${period}/next-month.xlsx?to=${encodeURIComponent(to)}`,
      { headers: { 'X-Requested-With': 'fetch' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const named = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const href = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href, download: named ? named[1] : `targets-${period}.xlsx` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    $('err').innerHTML = `<span style="color:#9fe08a">Downloaded. Fill in <strong>Monthly Target</strong>, then bring it back under <strong>03 Import Excel</strong>.</span>`;
  } catch (e) { fail(e); }
  finally { if (btn) btn.disabled = false; }
}

const daysIn = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Save what is in the editor, unfinished.
 *
 * A draft is NOT validated, deliberately. Half the targets blank is the normal
 * state ten minutes into a month, and refusing to save until it reconciles
 * would defeat the only thing this is for — letting somebody stop halfway
 * through seventy-three numbers and come back. Publishing still refuses
 * anything that does not cross-foot, and that is the gate that matters.
 */
async function saveDraft() {
  if (!DRAFT) return;
  clearErr();
  try {
    const out = await api(`/api/targets/${DRAFT.period}/draft`, {
      method: 'PUT', body: JSON.stringify(DRAFT),
    });
    const blank = DRAFT.doctors.filter((d) => d.needsTarget).length;
    $('err').innerHTML = `<span style="color:#9fe08a">Draft saved for ${esc(out.period)} —
      ${fmt(out.doctors)} doctors${blank ? `, ${blank} still without a target` : ''}. Nothing is
      published; no report reads it.</span>`;
    await renderPeriods();
  } catch (e) { fail(e); }
}

/** Pick a saved draft back up exactly where it was left. */
async function resumeDraft(period) {
  clearErr();
  try {
    const row = await api(`/api/targets/${period}/draft`);
    DRAFT = row.payload;
    renderEditor();
    go('periods');
    scrollToEditor();
    $('err').innerHTML = `<span style="color:#9fe08a">Resumed the ${esc(period)} draft, saved
      ${esc(new Date(row.savedAt).toLocaleString('en-GB'))}.</span>`;
  } catch (e) { fail(e); }
}

async function openEditor(period) {
  clearErr();
  const sheet = await api(`/api/targets/${period}`);
  DRAFT = {
    period: sheet.period,
    daysInPeriod: sheet.daysInPeriod,
    sourceLabel: sheet.sourceLabel || '',
    groups: JSON.parse(JSON.stringify(sheet.groups)),
    doctors: sheet.doctors.map((d) => ({ ...d })),
    branches: sheet.branches.map((b) => ({ ...b })),
  };
  renderEditor();
  go('periods');
  scrollToEditor();
}

/* ---- 02 · the editor, with the ledger always on screen ---- */

/* The ledger and the verdict both come from `public/draft.js`, which is the
   function PUT /api/targets/:period runs. This screen used to have its own
   reading of the same rules and the two disagreed — see Draft.problems for what
   that cost. Keeping the local name means nothing else here had to change. */
const reconcile = (draft) => Draft.ledger(draft);

/**
 * The ledger, on its own so a keystroke can refresh it without redrawing the
 * page.
 *
 * That is not a nicety. Every edit used to call renderEditor(), which replaces
 * the panel's innerHTML — so `change` firing as you tabbed out of a target box
 * destroyed the field you were tabbing INTO, and focus fell to the body. Typing
 * 73 targets meant 73 separate mouse clicks. The model still redraws in full
 * for anything structural (adding a group, removing a row); a number does not
 * need it.
 */
function ledgerHtml(draft) {
  const r = reconcile(draft);
  const n = draft.doctors.filter((d) => d.needsTarget).length;
  return `<div class="recon ${r.ok ? 'ok' : 'bad'}">
      <h4>Reconciliation</h4>
      ${r.lines.length ? r.lines.map((l) => `<div class="recon-line">
        <span>${esc(l.name)}${l.roster && l.people !== l.roster ? ` <span class="pill" style="background:rgba(176,80,60,.14);color:#b0503c">${l.people} of ${l.roster}</span>` : ''}</span>
        <span>${fmt(l.listed)} + ${fmt(l.unlisted)} = <span class="${l.ok ? 'ok' : 'bad'}">${fmt(l.sum)}</span> vs ${fmt(l.target)}</span>
      </div>`).join('') : '<div class="recon-line"><span>No groups yet</span><span>—</span></div>'}
      <div class="recon-line total"><span>Sheet total</span><span>${fmt(r.lines.reduce((s, l) => s + l.target, 0))}</span></div>
      ${/* The exact sentences the publish route would answer with, rather than
            "until every line balances" — which explained the group sums and
            nothing else, so a head-count mismatch disabled Publish with no
            stated reason anywhere on the screen. */
        r.problems.length ? `<div class="problem">The server would refuse this sheet:
          <ul style="margin:6px 0 0 16px">${r.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <div style="margin-top:6px"><strong>Balance groups</strong> settles the sums and the head counts in one click when there is no approved total to match.</div></div>`
        : !r.lines.length ? '<div class="problem">Nothing to publish yet. An empty sheet would replace the month with nothing, so Publish stays disabled until there is at least one group.</div>'
        : ''}
    </div>
    ${/* Reconciliation cannot catch this. Group targets are derived by summing
          the doctors, so a sheet where every target is still 0 balances
          perfectly — which is exactly what an unfilled exported template, or a
          month just carried across, is. Say so, rather than letting a green
          panel imply the work is done. */
      n ? `<div class="recon bad"><h4>${n} doctor${n === 1 ? ' has' : 's have'} no target yet</h4>
        <div class="recon-line"><span>Sitting at 0 and marked below${draft.carriedFrom ? ' — nothing was carried into the target column on purpose' : ''}.</span>
        <span>Reconciliation cannot flag this: group targets are the sum of their doctors, so a sheet of zeros balances.</span></div></div>` : ''}`;
}

function renderEditor() {
  if (!DRAFT) {
    $('editor').innerHTML = `<section><div class="kicker">Step 2 — Edit the sheet</div>
      <h2 class="title">Nothing open</h2><p class="sub">Pick a sheet under <strong>Target sheets</strong>, or import one.</p></section>`;
    return;
  }
  const r = reconcile(DRAFT);
  const groups = Object.keys(DRAFT.groups);

  let h = `<section>
    <div class="kicker">Step 2 — Edit the sheet</div>
    <h2 class="title">${esc(DRAFT.period)}</h2>
    <p class="sub">Group targets are the authority. Each one must equal the doctors listed under it plus the value held by roster members with no sales — that is the sum the report depends on, and the server rejects a sheet where it does not hold. No approved group total to transcribe? <strong>Balance groups</strong> sets each one to its doctors.</p>
    ${DRAFT.carriedFrom ? `<div class="ok-note">Carried from <strong>${esc(DRAFT.carriedFrom)}</strong>: ${DRAFT.doctors.length} doctors, ${Object.keys(DRAFT.groups).length} groups and ${DRAFT.branches.length} branch targets, with every monthly target left blank. Last month's figure is in the <strong>Prev month</strong> column.</div>` : ''}

    <div class="adm-grid">
      <div class="field"><label>Period</label><input id="fPeriod" value="${esc(DRAFT.period)}" placeholder="2026-09"></div>
      <div class="field"><label>Days in period</label><input id="fDays" type="number" min="28" max="31" value="${DRAFT.daysInPeriod}"><span class="hint">Daily targets derive from this: round(monthly ÷ days).</span></div>
      <div class="field"><label>Source label</label><input id="fSource" value="${esc(DRAFT.sourceLabel)}" placeholder="Approved Target Schedule — September 2026"></div>
    </div>

    <div id="ledger">${ledgerHtml(DRAFT)}</div>

    <div class="row-actions">
      <button class="btn" id="publish" ${r.ok ? '' : 'disabled'}>Publish sheet</button>
      <button class="btn ghost" id="saveDraft" title="Keep this unfinished — nothing is published">Save draft</button>
      <button class="btn ghost" id="balance" title="Set each group target to what its doctors add up to">Balance groups</button>
      <button class="btn ghost" id="addGroup">Add group</button>
      <button class="btn ghost" id="addDoctor">Add doctor</button>
      <button class="btn ghost" id="addBranch">Add branch</button>
      <span class="hint" style="color:var(--muted);font-size:11.5px">${DRAFT.doctors.filter((d) => d.hasSales !== false).length} listed · ${DRAFT.doctors.filter((d) => d.hasSales === false).length} with no sales · ${DRAFT.branches.length} branches</span>
    </div>

    <h3 class="subtitle">Groups</h3>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Group</th><th class="n">Target</th><th class="n">Roster</th><th class="n">No sales</th><th class="n">Value held</th><th></th>
    </tr></thead><tbody>${groups.map((g) => {
      const v = DRAFT.groups[g];
      return `<tr>
        <td class="nm">${esc(g)}</td>
        <td class="n"><input class="editable" data-g="${esc(g)}" data-f="target" value="${v.target}"></td>
        <td class="n"><input class="editable" data-g="${esc(g)}" data-f="rosterCount" value="${v.rosterCount}" style="width:70px"></td>
        <td class="n"><input class="editable" data-g="${esc(g)}" data-f="unlistedCount" value="${v.unlistedCount}" style="width:70px"></td>
        <td class="n"><input class="editable" data-g="${esc(g)}" data-f="unlistedTarget" value="${v.unlistedTarget}"></td>
        <td class="n"><button class="btn ghost" data-delg="${esc(g)}">Remove</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>

    <h3 class="subtitle">Doctors</h3>
    <input class="searchbox" id="docFilter" placeholder="Search doctor…">
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Doctor</th><th>Group</th><th class="n">Monthly target</th><th class="n">Per day</th><th class="n">Prev month</th><th></th>
    </tr></thead><tbody>${DRAFT.doctors.map((d, i) => `<tr data-search-target class="${d.hasSales === false ? 'muted-row' : ''}">
      <td><input class="editable" style="width:200px;text-align:left" data-d="${i}" data-f="name" value="${esc(d.name)}">${d.hasSales === false ? ' <span class="pill">no sales</span>' : ''}<span data-pill="${i}">${d.needsTarget ? ' <span class="pill" style="background:rgba(201,138,46,.18);color:#c98a2e">no target</span>' : ''}</span></td>
      <td><select data-d="${i}" data-f="group">
        <option value=""${!d.group ? ' selected' : ''}>—</option>
        ${groups.map((g) => `<option${g === d.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}
      </select></td>
      <td class="n"><input class="editable" data-d="${i}" data-f="monthlyTarget" value="${d.monthlyTarget}"></td>
      <td class="n" data-perday="${i}">${fmt(Math.round((d.monthlyTarget || 0) / (DRAFT.daysInPeriod || 31)))}</td>
      <td class="n"><input class="editable" data-d="${i}" data-f="prevMonth" value="${d.prevMonth ?? ''}"></td>
      <td class="n"><button class="btn ghost" data-deld="${i}">Remove</button></td>
    </tr>`).join('')}</tbody></table></div>

    <h3 class="subtitle">Branches</h3>
    <p class="sub">Daily figures come from <strong>Target 1</strong> only; Target 2 is a parallel slab scored against the same actual.</p>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Branch</th><th class="n">Target 1</th><th class="n">Target 2</th><th class="n">Per day</th><th></th>
    </tr></thead><tbody>${DRAFT.branches.map((b, i) => `<tr>
      <td><input class="editable" style="width:200px;text-align:left" data-b="${i}" data-f="name" value="${esc(b.name)}"></td>
      <td class="n"><input class="editable" data-b="${i}" data-f="target1" value="${b.target1}"></td>
      <td class="n"><input class="editable" data-b="${i}" data-f="target2" value="${b.target2 ?? ''}"></td>
      <td class="n" data-bperday="${i}">${fmt(Math.round((b.target1 || 0) / (DRAFT.daysInPeriod || 31)))}</td>
      <td class="n"><button class="btn ghost" data-delb="${i}">Remove</button></td>
    </tr>`).join('')}</tbody></table></div>
  </section>`;

  $('editor').innerHTML = h;
  wireEditor();
}

function wireEditor() {
  const p = $('editor');
  const redraw = () => renderEditor();

  const numOrNull = (v) => (String(v).trim() === '' ? null : Number(v));

  /* Everything the ledger says, refreshed without touching the field the cursor
     is in. Tabbing from one target to the next has to survive an edit — see
     ledgerHtml(). */
  const refresh = () => {
    const box = $('ledger');
    if (box) box.innerHTML = ledgerHtml(DRAFT);
    const pub = $('publish');
    if (pub) pub.disabled = !reconcile(DRAFT).ok;
  };

  p.querySelectorAll('[data-g]').forEach((el) => el.addEventListener('change', () => {
    DRAFT.groups[el.dataset.g][el.dataset.f] = Number(el.value) || 0;
    refresh();
  }));
  p.querySelectorAll('[data-d]').forEach((el) => el.addEventListener('change', () => {
    const i = Number(el.dataset.d);
    const d = DRAFT.doctors[i], f = el.dataset.f;
    d[f] = f === 'name' ? el.value : f === 'group' ? (el.value || null) : numOrNull(el.value);
    if (f === 'monthlyTarget') {
      // Typing a target answers the question the pill was asking, including a
      // deliberate 0 — that is a decision, not a gap.
      d.needsTarget = el.value.trim() === '';
      const pill = p.querySelector(`[data-pill="${i}"]`);
      if (pill) pill.innerHTML = d.needsTarget ? ' <span class="pill" style="background:rgba(201,138,46,.18);color:#c98a2e">no target</span>' : '';
      const per = p.querySelector(`[data-perday="${i}"]`);
      if (per) per.textContent = fmt(Math.round((d.monthlyTarget || 0) / (DRAFT.daysInPeriod || 31)));
    }
    refresh();
  }));
  p.querySelectorAll('[data-b]').forEach((el) => el.addEventListener('change', () => {
    const i = Number(el.dataset.b);
    const b = DRAFT.branches[i], f = el.dataset.f;
    b[f] = f === 'name' ? el.value : numOrNull(el.value);
    if (f === 'target1') {
      const per = p.querySelector(`[data-bperday="${i}"]`);
      if (per) per.textContent = fmt(Math.round((b.target1 || 0) / (DRAFT.daysInPeriod || 31)));
    }
  }));

  p.querySelectorAll('[data-delg]').forEach((b) => b.addEventListener('click', () => {
    delete DRAFT.groups[b.dataset.delg]; redraw();
  }));
  p.querySelectorAll('[data-deld]').forEach((b) => b.addEventListener('click', () => {
    DRAFT.doctors.splice(Number(b.dataset.deld), 1); redraw();
  }));
  p.querySelectorAll('[data-delb]').forEach((b) => b.addEventListener('click', () => {
    DRAFT.branches.splice(Number(b.dataset.delb), 1); redraw();
  }));

  $('fPeriod').addEventListener('change', (e) => { DRAFT.period = e.target.value.trim(); });
  $('fDays').addEventListener('change', (e) => { DRAFT.daysInPeriod = Number(e.target.value) || 31; redraw(); });
  $('fSource').addEventListener('change', (e) => { DRAFT.sourceLabel = e.target.value; });

  /* Group totals stay the authority — the server still refuses a sheet where
     one does not equal its doctors. This is for the case with no independent
     figure to transcribe, which is what the Excel path already does: `build`
     derives group totals from the rows and never reads them from the file. */
  $('saveDraft').addEventListener('click', saveDraft);

  $('balance').addEventListener('click', () => {
    const { changed } = Draft.balanceGroups(DRAFT);
    redraw();
    $('err').innerHTML = changed.length
      ? `<span style="color:#9fe08a">Balanced ${changed.length} group${changed.length === 1 ? '' : 's'} to their doctors: ${changed.map((c) => `${esc(c.name)} ${fmt(c.from)} → ${fmt(c.to)}`).join(' · ')}.</span>`
      : '<span style="color:#9fe08a">Every group already equals its doctors — nothing to change.</span>';
  });

  $('addGroup').addEventListener('click', () => {
    const name = prompt('Group name');
    if (!name) return;
    DRAFT.groups[name] = { target: 0, rosterCount: 0, unlistedCount: 0, unlistedTarget: 0 };
    redraw();
  });
  $('addDoctor').addEventListener('click', () => {
    DRAFT.doctors.push({ name: 'New doctor', group: Object.keys(DRAFT.groups)[0] || null, monthlyTarget: 0, prevMonth: null, hasSales: true });
    redraw();
  });
  $('addBranch').addEventListener('click', () => {
    DRAFT.branches.push({ name: 'New branch', target1: 0, target2: null });
    redraw();
  });

  $('publish').addEventListener('click', async () => {
    clearErr();
    try {
      const out = await api(`/api/targets/${DRAFT.period}`, { method: 'PUT', body: JSON.stringify(DRAFT) });
      $('err').innerHTML = `<span style="color:#9fe08a">Published ${esc(out.period)} — ${out.doctors} doctors, ${out.branches} branches.</span>`;
      await renderPeriods();
    } catch (e) { fail(e); }
  });
}

/* ---- 03 · import from the approved schedule ---- */

function renderImport() {
  $('import').innerHTML = `<section>
    <div class="kicker">Step 3 — Or bring one in from Excel</div>
    <h2 class="title">From the approved schedule</h2>
    <p class="sub">Read the workbook, say which column is which, then review the arithmetic before publishing. Nothing is saved until you publish from the editor.</p>

    <div class="drop" id="drop"><strong>Drop the .xlsx here</strong>or click to choose a file
      <input type="file" id="file" accept=".xlsx,.xls" hidden></div>
    <div id="parsed"></div>
  </section>`;

  const drop = $('drop'), file = $('file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readWorkbook(e.dataTransfer.files[0]);
  });
  file.addEventListener('change', () => file.files[0] && readWorkbook(file.files[0]));
}

async function readWorkbook(f, sheetName) {
  clearErr();
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    const out = await api('/api/targets/parse', { method: 'POST', body: JSON.stringify({ base64, sheet: sheetName }) });
    window.__WB = { base64, ...out };
    renderMapping(out);
  } catch (e) { fail(e); }
}

function renderMapping(wb) {
  const pick = (id, label, guess) => `<div class="field"><label>${label}</label>
    <select id="${id}"><option value="">—</option>${wb.columns.map((c) =>
      `<option${new RegExp(guess, 'i').test(c) ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;

  $('parsed').innerHTML = `
    <div class="ok-note">Read <strong>${esc(wb.sheet)}</strong> — ${fmt(wb.rowCount)} rows, ${wb.columns.length} columns.</div>
    <div class="field"><label>Worksheet</label><select id="wsPick">${wb.sheets.map((s) =>
      `<option${s === wb.sheet ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
    <h3 class="subtitle">Which column is which</h3>
    <div class="adm-grid">
      ${pick('cName', 'Doctor name', 'name|doctor|specialist')}
      ${pick('cGroup', 'Group', 'group|category|dept')}
      ${pick('cTarget', 'Monthly target', 'target|august|month')}
      ${pick('cPrev', 'Previous month (optional)', 'july|prev|last')}
    </div>
    <div class="field"><label>Period</label><input id="impPeriod" placeholder="2026-09" value="${new Date().toISOString().slice(0, 7)}"></div>
    <div class="row-actions"><button class="btn" id="buildDraft">Build a draft sheet</button></div>
    <h3 class="subtitle">First rows as read</h3>
    <div class="tw"><table class="ltab"><thead><tr>${wb.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${wb.sample.slice(0, 8).map((r) => `<tr>${wb.columns.map((c) =>
        `<td>${esc(r[c] === null ? '' : r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  $('wsPick').addEventListener('change', (e) => {
    const f = $('file').files[0];
    if (f) readWorkbook(f, e.target.value);
  });

  $('buildDraft').addEventListener('click', async () => {
    clearErr();
    const cols = { name: $('cName').value, group: $('cGroup').value, target: $('cTarget').value, prev: $('cPrev').value };
    if (!cols.name || !cols.target) { fail(new Error('Pick at least the name and monthly target columns.')); return; }

    // Re-read every row, not just the sample the preview showed.
    const full = await api('/api/targets/parse', { method: 'POST', body: JSON.stringify({ base64: window.__WB.base64, sheet: $('wsPick').value, all: true }) })
      .catch(() => null);
    const rows = (full && full.rows) || window.__WB.sample;

    const period = $('impPeriod').value.trim();
    const { doctors, groups, unreadable, blanks } = Draft.build(rows, cols);

    /* Branch targets are not in an imported file, and publishing replaces the
       whole period — so `branches: []` silently deleted every branch target on
       every import. scripts/import-schedule-md.js carries them forward for the
       same reason; do it here too, from the most recent published sheet. */
    const branches = await carriedBranches(period);

    DRAFT = { period, daysInPeriod: daysIn(period), sourceLabel: `Imported from ${$('wsPick').value}`, groups, doctors, branches: branches.rows };
    renderEditor();
    go('periods');
    scrollToEditor();

    const notes = [`Draft built from ${doctors.length} rows`];
    if (rows.length === (window.__WB.sample || []).length) notes.push('only the preview rows were available, check the count');
    if (branches.from) notes.push(`${branches.rows.length} branch targets carried forward from ${branches.from}`);
    if (blanks) notes.push(`${blanks} with no target yet`);
    if (unreadable.length) {
      notes.push(`${unreadable.length} target${unreadable.length === 1 ? '' : 's'} could not be read as a number: ${
        unreadable.slice(0, 5).map((u) => `${u.name} ("${u.value}")`).join(', ')}`);
    }
    $('err').innerHTML = `<span style="color:${unreadable.length ? '#c98a2e' : '#9fe08a'}">${
      esc(notes.join(' · '))}. Nothing is saved until you publish.</span>`;
  });
}

// One copy, shared with the report page's Import button.
const carriedBranches = (period) => Draft.carryBranches(api, period);

/* ---- 04 · name mapping ---- */

async function renderAliases() {
  const [aliases, names, periods] = await Promise.all([api('/api/aliases'), api('/api/odoo-names'), api('/api/targets')]);
  ODOO = names;

  // Which sheet names currently find nothing in Odoo — the ones worth mapping.
  let unresolved = { doctors: [], branches: [] };
  if (periods.length) {
    const sheet = await api(`/api/targets/${periods[0].period}`);
    const norm = (s) => String(s || '').toLowerCase().replace(/[.’'`,]/g, ' ')
      .replace(/^\s*(dr|doctor|prof|mr|mrs|ms)\s+/i, ' ').replace(/\s+/g, ' ').trim();
    const known = new Set(names.doctors.map((d) => norm(d.name)));
    const knownB = new Set(names.branches.map((b) => norm(b.name)));
    const mapped = new Set(aliases.map((a) => `${a.kind}:${a.scheduleName}`));
    unresolved.doctors = sheet.doctors.filter((d) => !known.has(norm(d.name)) && !mapped.has(`doctor:${d.name}`)).map((d) => d.name);
    unresolved.branches = sheet.branches.filter((b) => !knownB.has(norm(b.name)) && !mapped.has(`branch:${b.name}`)).map((b) => b.name);
  }

  const options = (kind) => (kind === 'doctor' ? ODOO.doctors : ODOO.branches)
    .map((n) => `<option value="${esc(n.name)}">${esc(n.name)} — ${fmt(n.ex)} over ${n.invoices} inv</option>`).join('');

  $('aliases').innerHTML = `<section>
    <div class="kicker">04 — Name mapping</div>
    <h2 class="title">Sheet name → Odoo name</h2>
    <p class="sub">Matching is exact, never by similarity: <code>Dr.Merna Masoud</code> and <code>Dr.Merna Ashraf</code> are one character apart and are different people. Anything the sheet spells differently needs an entry here or its revenue reads as zero.</p>

    ${(unresolved.doctors.length + unresolved.branches.length) ? `
      <div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${unresolved.doctors.length + unresolved.branches.length} name${unresolved.doctors.length + unresolved.branches.length === 1 ? '' : 's'} on the current sheet with nothing matching in Odoo.</strong>
        Either they genuinely did not invoice, or the spelling differs — pair them below.
      </div>
      ${[...unresolved.doctors.map((n) => ['doctor', n]), ...unresolved.branches.map((n) => ['branch', n])].map(([kind, n]) => `
        <div class="pair">
          <input value="${esc(n)}" readonly>
          <span class="arrow">→</span>
          <select data-new="${kind}" data-name="${esc(n)}"><option value="">choose the Odoo name…</option>${options(kind)}</select>
        </div>`).join('')}
      <div class="row-actions"><button class="btn" id="saveNew">Save these mappings</button></div>
    ` : '<div class="ok-note">Every name on the current sheet resolves.</div>'}

    <h3 class="subtitle">Existing mappings</h3>
    ${aliases.length ? `<div class="tw"><table class="ltab"><thead><tr>
        <th>Kind</th><th>Sheet name</th><th>Odoo name</th><th></th></tr></thead><tbody>${
      aliases.map((a) => `<tr>
        <td>${esc(a.kind)}</td><td class="nm">${esc(a.scheduleName)}</td><td>${esc(a.odooName)}</td>
        <td class="n"><button class="btn ghost" data-del-alias="${esc(a.kind)}|${esc(a.scheduleName)}">Remove</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="sub">None yet.</p>'}

    <h3 class="subtitle">Names Odoo uses</h3>
    <p class="sub">${ODOO.doctors.length} doctors and ${ODOO.branches.length} branches appear on invoices in the cache.</p>
  </section>`;

  const save = $('saveNew');
  if (save) save.addEventListener('click', async () => {
    clearErr();
    const list = [...$('aliases').querySelectorAll('[data-new]')]
      .filter((s) => s.value)
      .map((s) => ({ kind: s.dataset.new, scheduleName: s.dataset.name, odooName: s.value }));
    if (!list.length) { fail(new Error('Nothing chosen yet.')); return; }
    try {
      await api('/api/aliases', { method: 'PUT', body: JSON.stringify(list) });
      await renderAliases();
    } catch (e) { fail(e); }
  });

  $('aliases').querySelectorAll('[data-del-alias]').forEach((b) => b.addEventListener('click', async () => {
    const [kind, name] = b.dataset.delAlias.split('|');
    try {
      await api(`/api/aliases/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await renderAliases();
    } catch (e) { fail(e); }
  }));
}

/* ---- 05 · activity ---- */

async function renderAudit() {
  const rows = await api('/api/audit?limit=100');
  $('audit').innerHTML = `<section>
    <div class="kicker">06 — Activity</div>
    <h2 class="title">Who did what</h2>
    <p class="sub">Sign-ins, refreshes and every change to a target sheet or name mapping.</p>
    ${rows.length ? `<div class="tw"><table class="ltab"><thead><tr>
        <th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${
      rows.map((e) => `<tr>
        <td class="nm">${new Date(e.at).toLocaleString('en-GB')}</td>
        <td>${esc(e.actor || '—')}</td>
        <td>${esc(e.action)}</td>
        <td>${esc(e.detail || '')}</td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="sub">Nothing recorded yet.</p>'}
  </section>`;
}

/* ---- wiring ---- */

/* `editor` and `import` are sections of the Periods panel now, so they render
   with it rather than on a tab of their own. `mapping` and `data` hold two
   sections each for the same reason: the old strip made "Edit sheet" look like
   somewhere you go, when it is something you are already doing. */
/* ---- the plan: branch and doctor targets through 2027 ----

   The editor itself is `public/admin-plan.js`, which owns its own dirty map and
   binds directly to its nodes. This hands it the three things it must not
   rebuild: the fetch wrapper that redirects on a 401, a reload, and the two
   message helpers every other panel on this page uses. */

async function renderPlan() {
  try {
    await AdminPlan.render($('plan'), {
      api,
      doc: document,
      reload: async () => { await renderPlan(); },
      ok: (msg) => { $('err').innerHTML = `<span style="color:#9fe08a">${esc(msg)}</span>`; },
      fail,
    });
  } catch (e) {
    /* A plan that will not load must not take the Periods tab down with it —
       the target sheet editor above is the thing people come here for. */
    $('plan').innerHTML = `<section><h3 class="subtitle">The plan</h3>
      <div class="tg-note" style="border-left:3px solid #b0503c">Could not load the plan:
      ${esc(e.message)}</div></section>`;
  }
}

const LOADERS = {
  status: renderStatus,
  periods: async () => { await renderPeriods(); renderEditor(); renderImport(); await renderPlan(); },
  mapping: async () => { await renderAliases(); },
  audit: renderAudit,
};

/* /admin renders each panel on demand rather than up-front, so it hands Shell a
   loader hook rather than rendering everything at load.
 
   `go` stays a hoisted function declaration, not a const holding Shell's return
   value: renderPeriods, openEditor and renderMapping all call it from above this
   line, and a const would put it in the temporal dead zone. They only fire after
   load today, so a const happens to work — but it would fail the first time
   anything called go() during module evaluation, which is not a trap worth
   leaving behind. */
function go(id) { Shell.showPanel(id); }

/* The editor is a SECTION of Periods now, not a tab of its own, so opening a
   sheet has to put the reader in front of it rather than just switching panel —
   otherwise a click on Edit lands them at the top of the month list with the
   editor somewhere below the fold, looking like nothing happened. */
function scrollToEditor() {
  const el = $('editor');
  if (el && el.scrollIntoView) setTimeout(() => el.scrollIntoView({ block: 'start' }), 30);
}

Shell.mountTabs({
  onShow: async (id) => { clearErr(); if (LOADERS[id]) await LOADERS[id](); },
  onError: fail,
});

/* The status panel's buttons. Delegated, because the panel is rebuilt on every
   read and its rows come from the server rather than from a fixed list here. */
document.addEventListener('click', async (e) => {
  if (!e.target.closest) return;

  const goto = e.target.closest('[data-goto]');
  if (goto) {
    go(goto.dataset.goto);
    if (LOADERS[goto.dataset.goto]) await LOADERS[goto.dataset.goto]();
    return;
  }

  const resume = e.target.closest('[data-resume]');
  if (resume) { await resumeDraft(resume.dataset.resume); return; }

  /* `data-carry` also exists on the Periods list, where renderPeriods wires it
     directly. This catches the copy on the status panel, which has no wiring of
     its own — and guards against double-handling by checking the panel. */
  const carry = e.target.closest('[data-carry]');
  if (carry && carry.closest('#status')) {
    go('periods');
    await LOADERS.periods();
    await startNextMonth(carry.dataset.carry, null);
  }
});

document.addEventListener('input', (e) => {
  if (!e.target.classList.contains('searchbox')) return;
  const q = e.target.value.toLowerCase().trim();
  e.target.closest('.panel').querySelectorAll('[data-search-target]').forEach((n) => {
    n.style.display = !q || n.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

/* Pins the tab strip under the control bar — see public/shell.js. */
Shell.stickyBar();

(async () => {
  try {
    const me = await api('/auth/me');
    $('who').textContent = me.name || me.subject;
  } catch { /* the redirect already happened */ }
  try { await renderStatus(); } catch (e) { fail(e); }

  /* `/admin#uploads` — where the Contact Centre lock screen sends the person who
     can upload. Uploads is a section of the Data tab, not a tab of its own, so
     this opens Data, loads it, and scrolls the uploads into view. Without it
     the button lands on Status and the reader has to know where to look, on
     the one day of the week the report is closed until they find it. */
  if ((location.hash || '').replace('#', '') === 'uploads') {
    try {
      go('data');
      await LOADERS.data();
      const up = $('uploads');
      if (up && up.scrollIntoView) up.scrollIntoView({ block: 'start' });
    } catch (e) { fail(e); }
  }

  /* "Review in admin" on the report's Import dialog hands the draft over here
     rather than publishing it, so the careful path stays one click away. */
  const handed = sessionStorage.getItem('nrs-draft');
  if (handed) {
    sessionStorage.removeItem('nrs-draft');
    try {
      DRAFT = JSON.parse(handed);
      await renderPeriods();
      renderImport();
      renderEditor();
      go('periods');
      scrollToEditor();
      $('err').innerHTML = `<span style="color:#9fe08a">Draft handed over from the report — ${DRAFT.doctors.length} doctors for ${esc(DRAFT.period)}. Nothing is saved until you publish.</span>`;
    } catch { /* a malformed hand-off is not worth an error message */ }
  }
})();

/* ---- 06 · Commission Policy 2026 ----------------------------------------

   The branch side of the Targets tab is stored, not derived, so everything that
   decides what a branch is measured against is edited here: the monthly target,
   the 80/90/100 bands (globally and per branch-month), the departments, the
   branches, and which entity owns each one.

   Nothing on the report is stored, so a save here changes the report on its next
   refresh — there is no second place to keep in step. */

let COM = null;
const COM_DIRTY = {
  cells: new Map(), branches: new Map(), departments: new Map(), policy: new Map(), terms: new Map(),
  schemes: new Map(), doctors: new Map(),
};
const comKey = (branchId, month) => `${branchId}:${month}`;
const comClean = () => { for (const m of Object.values(COM_DIRTY)) m.clear(); };
const comCount = () => Object.values(COM_DIRTY).reduce((n, m) => n + m.size, 0);

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const asPct = (v) => (v === null || v === undefined ? '' : `${Math.round(Number(v) * 1000) / 10}`);
const fromPct = (s) => {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n / 100 : NaN;
};

/**
 * Cash-back rates and purchase targets, per supplier.
 *
 * POLICY, NOT DATA, which is why it is edited rather than computed: nothing in
 * Odoo records that Bio Solutions pays 10% back and Eldawlia Pharma pays 15%.
 * It sits under Commission because it is the same kind of thing as a band — a
 * negotiated number that decides money — and it is upserted, never replaced, so
 * a rate corrected here survives every deploy and every re-import.
 *
 * THE COLUMN THAT MATTERS MOST IS "NET PURCHASE". A term whose supplier raised
 * no bills is almost always a spelling difference: report 09 matches a term to a
 * supplier on the EXACT name only, because at looser matching 21 agreements
 * reached 63 of 73 suppliers and owed cash back on rent and advertising.
 */
function vendorTermsBlock() {
  const V = COM_TERMS;
  if (!V || V.__error) {
    return `<h3 class="subtitle">Vendor cash back</h3>
      <div class="problem">${esc((V && V.__error) || 'Not loaded.')}</div>`;
  }

  const rows = V.terms.slice().sort((a, b) => (b.net || 0) - (a.net || 0));
  const orphans = rows.filter((t) => !t.bills);

  let h = `<h3 class="subtitle">Vendor cash back and purchase targets — ${esc(String(V.year))}</h3>
    <p class="sub">A rate is a FRACTION: type <code>0.10</code> for 10%. Leave it empty for a
      supplier with no agreement — empty means "nobody agreed anything", which is not the same
      as 0% and report 09 prints the two differently. ${esc(V.matching)}</p>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Supplier</th><th class="n">Rate</th><th>Basis</th><th>Target</th>
      <th class="n">Target qty</th><th class="n">Net purchase</th><th class="n">Bills</th><th></th>
    </tr></thead><tbody>`;
  for (const t of rows) {
    h += `<tr${t.bills ? '' : ' class="muted-row"'}>
      <td class="nm">${esc(t.supplierName)}${t.source === 'admin' ? ' <span class="ctag">edited</span>' : ''}</td>
      <td class="n"><input class="editable" style="width:70px" data-vt="${esc(t.supplierName)}:cashbackRate" value="${t.cashbackRate == null ? '' : t.cashbackRate}" placeholder="none"></td>
      <td><input class="editable" style="width:150px;text-align:left" data-vt="${esc(t.supplierName)}:basisNote" value="${esc(t.basisNote || '')}" placeholder="&mdash;"></td>
      <td><input class="editable" style="width:190px;text-align:left" data-vt="${esc(t.supplierName)}:targetLabel" value="${esc(t.targetLabel || '')}" placeholder="&mdash;"></td>
      <td class="n"><input class="editable" style="width:80px" data-vt="${esc(t.supplierName)}:targetAmount" value="${t.targetAmount == null ? '' : t.targetAmount}" placeholder="&mdash;"></td>
      <td class="n">${t.net == null ? '<span style="color:#b0503c">no bills</span>' : fmt(t.net)}</td>
      <td class="n">${t.bills}</td>
      <td class="n"><button class="btn ghost" data-vtdel="${esc(t.supplierName)}">Remove</button></td>
    </tr>`;
  }
  h += '</tbody></table></div>';

  if (orphans.length) {
    h += `<div class="problem"><strong>${orphans.length} agreement${orphans.length === 1 ? '' : 's'} match no supplier that raised a bill this year</strong> &mdash; ${orphans.map((t) => esc(t.supplierName)).join(', ')}. Those earn nothing on report 09 whatever rate they carry, because the name has to match exactly. Correct the spelling to the name Odoo uses.</div>`;
  }

  h += `<div class="pair" style="margin-top:12px;grid-template-columns:2fr 1fr auto">
      <select id="vtName"><option value="">Add a rate for&hellip;</option>${V.suppliers
    .filter((sp) => !V.terms.some((t) => t.supplierName === sp.supplierName))
    .map((sp) => `<option value="${esc(sp.supplierName)}">${esc(sp.supplierName)} &middot; ${fmt(sp.net)}</option>`).join('')}</select>
      <input id="vtRate" placeholder="0.10">
      <button class="btn" id="vtAdd">Add</button>
    </div>
    <div class="row-actions"><button class="btn" id="comSaveTerms">Save cash-back changes</button>
      <span class="hint" style="color:var(--muted);font-size:11.5px">Upserted, never replaced &mdash; a re-import of the source pack leaves whatever is here exactly as you left it.</span></div>`;
  return h;
}

async function renderCommissionAdmin() {
  /* Both fetched here rather than inside the draw, because `drawCommission` is
     synchronous — and it stays that way: making a render function async to fetch
     one table is how a panel starts half-drawing. */
  [COM, COM_TERMS, SCH] = await Promise.all([
    api(`/api/commission?year=${COM_YEAR}`),
    api(`/api/vendor-terms?year=${COM_YEAR}`).catch((e) => ({ __error: e.message })),
    /* Doctor schemes are a different commission from the branch grid above and
       must not take the panel down with them if their table is empty. */
    api('/api/schemes').catch((e) => ({ __error: e.message, schemes: [], doctors: [], unassigned: [] })),
  ]);
  comClean();
  drawCommission();
}

let COM_YEAR = 2026;
let COM_TERMS = null;
let SCH = null;

function drawCommission() {
  const G = COM.grid;
  const bands = COM.resolved.bands;

  const policyField = (key, label, hint) => {
    const row = COM.policy.find((p) => p.key === key);
    if (!row) return '';
    return `<div class="field"><label>${esc(label)}</label>
      <input class="editable" style="width:100%;text-align:left" data-pol="${esc(key)}" value="${esc(row.value)}">
      <span class="hint">${esc(hint || row.note || '')}</span></div>`;
  };

  let h = `<section>
    <div class="kicker">03 — Commission</div>
    <h2 class="title">Commission Policy ${esc(COM.resolved.version || '')}</h2>
    <p class="sub">${G.branches.length} branches across ${Object.keys(G.areas).length} areas ·
      ${G.entities.map((e) => `<strong>${esc(e.entity)}</strong> ${fmt(e.branches)}`).join(' · ')} ·
      ${esc(String(COM_YEAR))} target <strong>${fmt(G.grandTotal)}</strong>${G.overrides ? ` · <strong>${fmt(G.overrides)}</strong> band override${G.overrides === 1 ? '' : 's'}` : ''}</p>
    <div class="recon"><h4>Editing is passphrase-gated</h4>
      <div class="row-actions">
        <input class="editable" style="width:220px;text-align:left" id="comPass" type="password" placeholder="Admin passphrase" autocomplete="off">
        <button class="btn ghost" id="comUnlock">Unlock editing</button>
        <span class="hint" id="comLock">Reads never need it. Every save below does.</span>
      </div></div>`;

  /* ---- the global bands, which every branch-month falls back to ---- */
  h += `<h3 class="subtitle">The bands, for every branch that has no override</h3>
    <p class="sub">Below the floor a branch pays <strong>nothing</strong>. These are shares written as percentages —
      ${asPct(bands.floor)} / ${asPct(bands.mid)} / ${asPct(bands.max)} today. They must rise in that order.</p>
    <div class="adm-grid">
      ${policyField('achievement_floor', 'Floor — below this, zero', 'Written as a share: 0.8 is 80%.')}
      ${policyField('band_mid_from', 'Mid band from', 'Pays (min+max)/2 of the tier.')}
      ${policyField('band_max_from', 'Max band from', 'Pays the tier maximum.')}
      ${policyField('service_bonus_cap', 'Service multiplier cap', 'The three bonuses multiply to 1.725; the policy caps the result.')}
      ${policyField('vat_divisor', 'VAT divisor', 'Net Collection ex-VAT = payment ÷ this, less credit notes.')}
    </div>
    <div class="row-actions"><button class="btn" id="comSavePolicy">Save the bands</button></div>`;

  /* ---- the grid ---- */
  h += `<h3 class="subtitle">Monthly targets — ${esc(String(COM_YEAR))}</h3>
    <p class="sub">Type over any figure. Changed cells turn amber and nothing is written until you save.
      A cell with an <span style="box-shadow:inset 0 -2px 0 #c98a2e;padding:0 3px">amber underline</span> uses its own bands instead of the policy — set those below.</p>
    <div class="tw"><table class="cgrid"><thead><tr><th>Branch</th>
      ${MONTH_ABBR.map((m) => `<th>${m}</th>`).join('')}<th>Year</th><th>vs annual</th></tr></thead><tbody>`;

  for (const b of G.branches) {
    h += `<tr class="${b.entity === 'ZAT' ? 'zat' : ''}"><td>${esc(b.name)}${b.entity === 'ZAT' ? '<span class="ctag">ZAT</span>' : ''}${b.active ? '' : '<span class="ctag">retired</span>'}</td>`;
    for (const c of b.months) {
      h += `<td><input class="editable${c.override ? ' ovr' : ''}" data-cell="${b.id}:${c.month}"
        title="${esc(b.name)} ${c.monthName}${c.override ? ` · own bands ${asPct(c.bands.floor)}/${asPct(c.bands.mid)}/${asPct(c.bands.max)}` : ''}"
        value="${c.target === null ? '' : Math.round(c.target)}"></td>`;
    }
    h += `<td style="text-align:right;font-size:11.5px;font-weight:700">${fmt(b.monthlySum)}</td>
      <td style="text-align:right;font-size:11px" class="${b.annualGap ? 'bad' : ''}">${b.annualGap ? (b.annualGap > 0 ? '+' : '') + fmt(b.annualGap) : '—'}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><td style="text-align:left">All ${G.branches.length}</td>
    ${G.monthTotals.map((t) => `<td>${fmt(Math.round(t / 1000))}k</td>`).join('')}
    <td>${fmt(G.grandTotal)}</td><td>${G.branches.some((b) => b.annualGap) ? 'see above' : '—'}</td></tr></tfoot></table></div>
    <div class="row-actions"><button class="btn" id="comSaveCells">Save target changes</button>
      <span class="hint" id="comCellCount">no changes yet</span></div>`;

  /* The annual-vs-monthly gap is the workbook's own inconsistency, surfaced
     rather than reconciled away — the resolution is Finance's to make. */
  const gapped = G.branches.filter((b) => b.annualGap);
  if (gapped.length) {
    h += `<div class="problem">${gapped.map((b) => `<strong>${esc(b.name)}</strong>: 12 months sum to ${fmt(b.monthlySum)} against a stated annual of ${fmt(b.annualTarget)} (${b.annualGap > 0 ? '+' : ''}${fmt(b.annualGap)})`).join('<br>')}
      <br>Carried straight from the source workbook, which disagrees with itself here. The monthly figures are what drive monthly commission.</div>`;
  }

  /* ---- per-branch-per-month band overrides ---- */
  h += `<h3 class="subtitle">Band overrides — one branch, one month</h3>
    <p class="sub">Use this to change the 80 or the 90 for a single branch in a single month without moving the policy for everyone.
      Leave a box empty to follow the policy again.</p>`;
  const overrides = [];
  for (const b of G.branches) for (const c of b.months) if (c.override) overrides.push({ b, c });
  h += `<div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th>Month</th>
      <th class="n">Floor %</th><th class="n">Mid %</th><th class="n">Max %</th><th></th></tr></thead><tbody>`;
  if (!overrides.length) {
    h += `<tr><td colspan="6" style="color:var(--muted);font-size:12.5px">Every branch-month follows the policy. Add one below.</td></tr>`;
  }
  for (const { b, c } of overrides) {
    h += `<tr><td class="nm">${esc(b.name)}</td><td>${esc(c.monthName)}</td>
      <td class="n"><input class="editable" data-band="${b.id}:${c.month}:floorPct" value="${asPct(c.floorPct)}" placeholder="${asPct(COM.resolved.bands.floor)}"></td>
      <td class="n"><input class="editable" data-band="${b.id}:${c.month}:midPct" value="${asPct(c.midPct)}" placeholder="${asPct(COM.resolved.bands.mid)}"></td>
      <td class="n"><input class="editable" data-band="${b.id}:${c.month}:maxPct" value="${asPct(c.maxPct)}" placeholder="${asPct(COM.resolved.bands.max)}"></td>
      <td class="n"><button class="btn ghost" data-clearband="${b.id}:${c.month}">Follow the policy</button></td></tr>`;
  }
  h += `</tbody></table></div>
    <div class="pair" style="margin-top:12px;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto">
      <select id="ovBranch">${G.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
      <select id="ovMonth">${MONTH_ABBR.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select>
      <input id="ovFloor" placeholder="Floor ${asPct(bands.floor)}">
      <input id="ovMid" placeholder="Mid ${asPct(bands.mid)}">
      <input id="ovMax" placeholder="Max ${asPct(bands.max)}">
      <button class="btn" id="comAddOverride">Set</button>
    </div>
    <div class="row-actions"><button class="btn" id="comSaveBands">Save override changes</button></div>`;

  /* ---- branches ---- */
  h += `<h3 class="subtitle">Branches and who owns them</h3>
    <p class="sub">The owning entity (الجهة المالكة) groups the report and drives nothing else; the area drives the Area Manager gate.
      Retiring a branch hides it without deleting its target history.</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Branch</th><th>Area</th><th>Owner</th><th>Odoo journal</th><th class="n">Annual target</th><th class="n">Active</th></tr></thead><tbody>`;
  const AREAS = [...new Set(G.branches.map((b) => b.area))];
  const ENTITIES = [...new Set(G.branches.map((b) => b.entity))];
  for (const b of G.branches) {
    h += `<tr><td><input class="editable" style="width:150px;text-align:left" data-br="${b.id}:name" value="${esc(b.name)}"></td>
      <td><input class="editable" style="width:80px;text-align:left" data-br="${b.id}:area" value="${esc(b.area)}" list="comAreas"></td>
      <td><input class="editable" style="width:110px;text-align:left" data-br="${b.id}:entity" value="${esc(b.entity)}" list="comEntities"></td>
      <td><input class="editable" style="width:100px;text-align:left" data-br="${b.id}:journalCode" value="${esc(b.journalCode || '')}" placeholder="unknown"></td>
      <td class="n"><input class="editable" data-br="${b.id}:annualTarget" value="${b.annualTarget === null ? '' : Math.round(b.annualTarget)}"></td>
      <td class="n"><input type="checkbox" data-bract="${b.id}" ${b.active ? 'checked' : ''}></td></tr>`;
  }
  h += `</tbody></table></div>
    <!-- Option tags closed explicitly. A browser closes them for you, so this
         rendered correctly and still failed a tag-balance check, the same shape
         already fixed in procurement.js. No backticks in this comment: it sits
         inside a template literal, and a pair of them ends the string and turns
         the next word into a bare identifier. -->
    <datalist id="comAreas">${AREAS.map((a) => `<option value="${esc(a)}"></option>`).join('')}</datalist>
    <datalist id="comEntities">${ENTITIES.map((e) => `<option value="${esc(e)}"></option>`).join('')}</datalist>
    <div class="pair" style="margin-top:12px;grid-template-columns:2fr 1fr 1fr 1fr auto">
      <input id="nbName" placeholder="New branch name">
      <input id="nbArea" placeholder="Area" list="comAreas">
      <input id="nbEntity" placeholder="Owner" list="comEntities">
      <input id="nbJournal" placeholder="Journal code">
      <button class="btn" id="comAddBranch">Add branch</button>
    </div>
    <div class="row-actions"><button class="btn" id="comSaveBranches">Save branch changes</button></div>`;

  /* ---- departments ---- */
  h += `<h3 class="subtitle">Departments (الأقسام) and their bonus multipliers</h3>
    <p class="sub">A department earns its multiplier when its own revenue reaches its own monthly target <em>and</em> its mix guardrail holds.
      Leave the multiplier empty for a department the policy attaches no bonus to. All three stack, then cap at ${esc(String(COM.resolved.multiplierCap))}×.</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Department</th><th class="n">Multiplier</th><th class="n">Mix floor %</th><th class="n">Mix cap %</th><th class="n">Group mix %</th><th>Condition</th></tr></thead><tbody>`;
  for (const d of G.departments) {
    h += `<tr><td><input class="editable" style="width:150px;text-align:left" data-dep="${d.id}:label" value="${esc(d.label)}"></td>
      <td class="n"><input class="editable" style="width:64px" data-dep="${d.id}:multiplier" value="${d.multiplier === null ? '' : d.multiplier}" placeholder="none"></td>
      <td class="n"><input class="editable" style="width:64px" data-dep="${d.id}:mixFloor" value="${asPct(d.mixFloor)}" placeholder="—"></td>
      <td class="n"><input class="editable" style="width:64px" data-dep="${d.id}:mixCap" value="${asPct(d.mixCap)}" placeholder="—"></td>
      <td class="n"><input class="editable" style="width:64px" data-dep="${d.id}:groupMix" value="${asPct(d.groupMix)}" placeholder="—"></td>
      <td style="font-size:11.5px;color:var(--muted)">${esc(d.condition || '—')}</td></tr>`;
  }
  h += `</tbody></table></div>
    <div class="pair" style="margin-top:12px;grid-template-columns:1fr 2fr 1fr auto">
      <input id="ndKey" placeholder="key (e.g. body)">
      <input id="ndLabel" placeholder="Department name">
      <input id="ndMult" placeholder="Multiplier">
      <button class="btn" id="comAddDept">Add department</button>
    </div>
    <div class="row-actions"><button class="btn" id="comSaveDepts">Save department changes</button></div>`;

  /* ---- vendor cash back and purchase targets (report 09) ---- */
  h += vendorTermsBlock();

  /* ---- the ladder, read-only for now ---- */
  h += `<h3 class="subtitle">The 14-tier pool ladder</h3>
    <p class="sub">Revenue picks the tier; the band picks which of its three pools pays. The pool is the whole 5-person team's total.</p>
    <div class="tw"><table class="ltab"><thead><tr><th>Tier</th><th>Revenue</th><th class="n">Min pool (${asPct(bands.floor)}–${Math.round(bands.mid * 100) - 1}%)</th><th class="n">Mid pool (${asPct(bands.mid)}–${Math.round(bands.max * 100) - 1}%)</th><th class="n">Max pool (≥${asPct(bands.max)}%)</th></tr></thead><tbody>`;
  for (const t of COM.tiers) {
    h += `<tr><td class="nm">${t.tierNo}</td><td style="font-size:12px">${esc(t.label)}</td>
      <td class="n">${fmt(t.pools.min)}</td><td class="n">${fmt(t.pools.mid)}</td><td class="n">${fmt(t.pools.max)}</td></tr>`;
  }
  h += `</tbody></table></div>
    <div class="tw" style="margin-top:14px"><table class="ltab"><thead><tr><th>Role</th><th class="n">Share of the pool</th><th class="n">On a 32,000 pool</th></tr></thead><tbody>
      ${COM.roles.map((r) => `<tr><td class="nm">${esc(r.name)}</td><td class="n">${asPct(r.sharePct)}%</td><td class="n">${fmt(32000 * r.sharePct)}</td></tr>`).join('')}
    </tbody></table></div>`;

  /* THE WORKBOOK'S 17 UNRESOLVED POLICY QUESTIONS WERE RENDERED HERE and are no
     longer drawn, at Mina's request.

     NOTHING WAS DELETED BEHIND IT. The rows are still in `CommissionNote`, the
     payload still carries them as `COM.notes.questions`, and
     `PUT /api/commission/notes/:id` still ticks one off — so putting the table
     back is this block again and nothing else. It was a go-live checklist
     sitting permanently under a screen used every month, which is a different
     job from the one this tab does.

     The three BLOCKERs it listed are real and unchanged: the ladder pool
     contradiction, the ladder column semantics, and the missing Body Contouring
     column. They are answered by Finance, not by this page. */

  h += drawSchemes();

  h += '</section>';

  /* The v3.2 editor lands in this placeholder, BELOW everything above it —
     `drawCommission` writes the panel wholesale, so anything composed into it
     beforehand would be wiped on the next redraw. `renderV32()` fills it. */
  h += '<div id="v32"></div>';

  $('commission').innerHTML = h;
  wireCommission();
  renderV32();
}

/* ---- the v3.2 policy editor ----
   Its own module for the same reason the plan grid is: `public/admin.js` is
   already past 2,100 lines. It is handed the four things it must not rebuild —
   the fetch wrapper with its 401 rule, a reload, and the two message helpers. */

async function renderV32() {
  const el = $('v32');
  if (!el) return;
  try {
    await AdminV32.render(el, {
      api,
      doc: document,
      reload: async () => { await renderCommissionAdmin(); },
      ok: (msg) => { $('err').innerHTML = `<span style="color:#9fe08a">${esc(msg)}</span>`; },
      fail,
    });
  } catch (e) {
    /* A policy that will not load must not take the rest of the tab with it —
       the branch grid and the schemes above are what people come here for. */
    el.innerHTML = `<h3 class="subtitle">Commission policy v3.2</h3>
      <div class="tg-note" style="border-left:3px solid #b0503c">Could not load the v3.2 policy:
      ${esc(e.message)}</div>`;
  }
}

/* ============================================================
   Doctor commission schemes.

   A DIFFERENT commission from everything above it on this page, and the
   heading says so rather than leaving a reader to work it out: the grid pays a
   BRANCH on cash collected against a monthly target; a scheme pays a DOCTOR a
   share of what they invoiced, with no target and no month.

   This is the answer to "where do I add a new doctor". The schemes themselves
   barely change; who is on them changes whenever somebody is hired.
   ============================================================ */
function drawSchemes() {
  if (!SCH || SCH.__error) {
    return `<h3 class="subtitle">Doctor commission schemes</h3>
      <div class="tg-note">Could not load the schemes: ${esc((SCH && SCH.__error) || 'no answer')}.</div>`;
  }
  const S = SCH.schemes || [];
  const D = SCH.doctors || [];
  const U = SCH.unassigned || [];

  const bandText = (b) => `${fmt(b.from)} – ${b.to == null ? 'above' : fmt(b.to)}`;

  let h = `<h3 class="subtitle">Doctor commission schemes</h3>
    <p class="sub">A different commission from the grid above. The grid pays a <strong>branch</strong> on cash
      collected against a monthly target; a scheme pays a <strong>doctor</strong> a share of what they invoiced,
      with no target and no month. ${S.length} scheme${S.length === 1 ? '' : 's'} ·
      ${D.length} doctor${D.length === 1 ? '' : 's'} assigned${U.length ? ` · <strong>${U.length} who invoiced and are on none</strong>` : ''}.</p>
    <p class="sub">A band is a <strong>lookup, not a ladder</strong>: a doctor billing 300,000 earns the 300,000 band's
      rate on the whole 300,000, not one rate on the first slice and another on the rest. Rates may be typed either
      way — 12 and 0.12 both mean 12%.</p>`;

  /* ---- the schemes ---- */
  for (const sc of S) {
    h += `<div class="listcard">
      <div class="listcard-head">
        <h3>${esc(sc.name)}</h3>
        <span class="sm2">${sc.hourlyRate == null ? 'hours are NOT counted' : `${fmt(sc.hourlyRate)} / hour`}${
      sc.fixedBasic ? ` · ${fmt(sc.fixedBasic)} fixed basic` : ''}</span>
      </div>
      <div class="pcard-body" style="padding:12px 18px 16px">
        <div class="adm-grid">
          <div class="field"><label>Hourly rate</label>
            <input class="editable" data-sch="${sc.id}:hourlyRate" value="${sc.hourlyRate == null ? '' : esc(String(sc.hourlyRate))}">
            <span class="hint">Blank means this scheme counts no working hours — which is not the same as zero an hour.</span></div>
          <div class="field"><label>Fixed basic</label>
            <input class="editable" data-sch="${sc.id}:fixedBasic" value="${sc.fixedBasic == null ? '' : esc(String(sc.fixedBasic))}">
            <span class="hint">Paid every month regardless of hours. Blank for none.</span></div>
        </div>
        <table class="ltab tight" style="margin-top:10px"><thead><tr>
          <th>Revenue from</th><th>to</th><th class="n">Rate %</th></tr></thead><tbody>
          ${sc.bands.length ? sc.bands.map((b, i) => `<tr>
            <td><input class="editable" style="width:110px" data-schband="${sc.id}:${i}:from" value="${esc(String(b.from))}"></td>
            <td><input class="editable" style="width:110px" data-schband="${sc.id}:${i}:to" value="${b.to == null ? '' : esc(String(b.to))}" placeholder="and above"></td>
            <td class="n"><input class="editable n" style="width:80px" data-schband="${sc.id}:${i}:rate" value="${esc((b.rate * 100).toFixed(2))}"></td>
          </tr>`).join('') : `<tr><td colspan="3"><span class="sm2">No bands are stated, so no rate is assumed —
            this scheme's commission has to be entered by hand.</span></td></tr>`}
          <tr>
            <td><input class="editable" style="width:110px" data-newband="${sc.id}:from" placeholder="from"></td>
            <td><input class="editable" style="width:110px" data-newband="${sc.id}:to" placeholder="and above"></td>
            <td class="n"><input class="editable n" style="width:80px" data-newband="${sc.id}:rate" placeholder="%"></td>
          </tr>
        </tbody></table>
        <div class="field" style="margin-top:8px"><label>Notes</label>
          <input class="editable" style="width:100%;text-align:left" data-sch="${sc.id}:notes" value="${esc(sc.notes || '')}"></div>
      </div>
    </div>`;
  }

  h += `<div class="row-actions">
    <button class="btn" id="schSave">Save the schemes</button>
    <span class="hint">Bands are checked as a set: two that overlap are refused, because the same revenue would
      earn two different rates. A <em>gap</em> is allowed and left alone — the workbook has one, and the report
      says so rather than inventing a rate inside it.</span></div>`;

  /* ---- a new scheme ---- */
  h += `<div class="recon" style="margin-top:14px"><h4>A new scheme</h4>
    <div class="adm-grid">
      <div class="field"><label>Name</label><input class="editable" style="text-align:left" id="nsName" placeholder="e.g. Dermatology 2027"></div>
      <div class="field"><label>Hourly rate</label><input class="editable" id="nsHourly" placeholder="blank = no hours"></div>
      <div class="field"><label>Fixed basic</label><input class="editable" id="nsFixed" placeholder="blank = none"></div>
    </div>
    <div class="row-actions"><button class="btn ghost" id="schAdd">Add the scheme</button>
      <span class="hint">It starts with no bands, which the report reads as "no rate is assumed" — add them above once it exists.</span></div>
  </div>`;

  /* ---- who is on which ---- */
  h += `<h3 class="subtitle">Who is on which</h3>
    <p class="sub">The withholding rate, the management fee and the bank details are this person's, not the scheme's.
      An <strong>agreed rate</strong> beats the band for that person every month until somebody clears it, so it
      demands a reason written beside it — ${D.filter((d) => d.rateOverride != null).length} people carry one today.</p>
    <div class="tw scrolly" style="--h:460px"><table class="ltab tight"><thead><tr>
      <th>Doctor</th><th>Scheme</th><th class="n">Hourly</th><th class="n">Mgmt fee</th><th class="n">Tax %</th>
      <th class="n">Agreed rate %</th><th>Why</th><th>Pay to</th></tr></thead><tbody>
      ${D.map((d) => `<tr>
        <td>${esc(d.doctorName)}</td>
        <td><select class="editable" data-doc="${esc(d.doctorName)}:schemeId">
          <option value=""${d.schemeId ? '' : ' selected'}>— none —</option>
          ${S.map((sc) => `<option value="${sc.id}"${sc.id === d.schemeId ? ' selected' : ''}>${esc(sc.name)}</option>`).join('')}
        </select></td>
        <td class="n"><input class="editable n" style="width:70px" data-doc="${esc(d.doctorName)}:hourlyRate" value="${d.hourlyRate == null ? '' : esc(String(d.hourlyRate))}" placeholder="${d.scheme && d.scheme.hourlyRate != null ? String(d.scheme.hourlyRate) : '—'}"></td>
        <td class="n"><input class="editable n" style="width:80px" data-doc="${esc(d.doctorName)}:mgmtFee" value="${d.mgmtFee == null ? '' : esc(String(d.mgmtFee))}"></td>
        <td class="n"><input class="editable n" style="width:60px" data-doc="${esc(d.doctorName)}:taxRate" value="${d.taxRate == null ? '' : esc((d.taxRate * 100).toFixed(2))}"></td>
        <td class="n"><input class="editable n" style="width:70px" data-doc="${esc(d.doctorName)}:rateOverride" value="${d.rateOverride == null ? '' : esc((d.rateOverride * 100).toFixed(2))}"></td>
        <td><input class="editable" style="width:100%;text-align:left" data-doc="${esc(d.doctorName)}:rateOverrideWhy" value="${esc(d.rateOverrideWhy || '')}" placeholder="${d.rateOverride == null ? '' : 'required'}"></td>
        <td><span class="sm2">${esc(d.payMethod || '—')}${d.bankAcc ? ` · ${esc(d.bankAcc)}` : ''}</span></td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="row-actions"><button class="btn" id="docSave">Save the doctors</button>
      <span class="hint">Hourly left blank follows the scheme's — the placeholder shows which. Tax and agreed rate are
        percentages: type 10 or 0.1.</span></div>`;

  /* ---- the ones nobody has put on a scheme ---- */
  h += `<h3 class="subtitle">Invoiced, and on no scheme</h3>`;
  if (!U.length) {
    h += '<div class="tg-note">Everyone who has invoiced is on a scheme.</div>';
  } else {
    h += `<p class="sub">These names appear on invoices in Odoo and match nobody here, so the report shows their
      revenue and <strong>no commission</strong>. That is the refusal working — a rate invented for them would be a
      payment nobody agreed. Add them below.</p>
      <div class="tw scrolly" style="--h:300px"><table class="ltab tight"><thead><tr>
        <th>Name, as Odoo spells it</th><th class="n">Invoiced ex-VAT</th><th>Last invoice</th><th>Put on</th></tr></thead><tbody>
        ${U.map((u) => `<tr>
          <td>${esc(u.name)}</td>
          <td class="n">${fmt(u.ex)}</td>
          <td><span class="sm2">${esc(u.lastInvoice || '—')}</span></td>
          <td><select class="editable" data-doc="${esc(u.name)}:schemeId">
            <option value="" selected>— none —</option>
            ${S.map((sc) => `<option value="${sc.id}">${esc(sc.name)}</option>`).join('')}
          </select></td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="row-actions"><button class="btn" id="docSave2">Save the new doctors</button>
        <span class="hint">Pick a scheme and save. Their hours, deductions and withholding arrive with the monthly
          payroll upload on the Data tab — nothing here infers them.</span></div>`;
  }

  return h;
}

function comMark(el, dirtyMap, key, value) {
  dirtyMap.set(key, value);
  el.classList.add('dirty');
  const n = comCount();
  const c = $('comCellCount');
  if (c) c.textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'no changes yet';
}

function wireCommission() {
  const P = $('commission');

  P.querySelectorAll('[data-cell]').forEach((el) => el.addEventListener('input', () => {
    const [branchId, month] = el.dataset.cell.split(':').map(Number);
    comMark(el, COM_DIRTY.cells, comKey(branchId, month), { branchId, month, target: el.value });
  }));
  P.querySelectorAll('[data-band]').forEach((el) => el.addEventListener('input', () => {
    const [branchId, month, field] = el.dataset.band.split(':');
    const k = `${branchId}:${month}:${field}`;
    comMark(el, COM_DIRTY.cells, k, { branchId: Number(branchId), month: Number(month), [field]: fromPct(el.value) });
  }));
  P.querySelectorAll('[data-br]').forEach((el) => el.addEventListener('input', () => {
    const [id, field] = el.dataset.br.split(':');
    const prev = COM_DIRTY.branches.get(id) || { id: Number(id) };
    comMark(el, COM_DIRTY.branches, id, { ...prev, [field]: el.value });
  }));
  P.querySelectorAll('[data-bract]').forEach((el) => el.addEventListener('change', () => {
    const id = el.dataset.bract;
    const prev = COM_DIRTY.branches.get(id) || { id: Number(id) };
    comMark(el, COM_DIRTY.branches, id, { ...prev, active: el.checked });
  }));
  P.querySelectorAll('[data-dep]').forEach((el) => el.addEventListener('input', () => {
    const [id, field] = el.dataset.dep.split(':');
    const prev = COM_DIRTY.departments.get(id) || { id: Number(id) };
    const val = /mix|group/i.test(field) ? fromPct(el.value) : el.value;
    comMark(el, COM_DIRTY.departments, id, { ...prev, [field]: val });
  }));
  P.querySelectorAll('[data-vt]').forEach((el) => el.addEventListener('input', () => {
    /* Split on the LAST colon: a supplier name may contain one, and splitting
       on the first would key the edit under half a company name. */
    const i = el.dataset.vt.lastIndexOf(':');
    const name = el.dataset.vt.slice(0, i);
    const field = el.dataset.vt.slice(i + 1);
    const prev = COM_DIRTY.terms.get(name) || { supplierName: name };
    comMark(el, COM_DIRTY.terms, name, { ...prev, [field]: el.value });
  }));
  P.querySelectorAll('[data-vtdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Remove the agreement for ${b.dataset.vtdel}? Report 09 will show it as having no rate, which is not the same as 0%.`)) return;
    clearErr();
    try {
      await api(`/api/vendor-terms/${COM_YEAR}/${encodeURIComponent(b.dataset.vtdel)}`, { method: 'DELETE' });
      await renderCommissionAdmin();
      $('err').innerHTML = '<span style="color:#9fe08a">Agreement removed.</span>';
    } catch (e) { fail(e); }
  }));
  P.querySelectorAll('[data-pol]').forEach((el) => el.addEventListener('input', () => {
    comMark(el, COM_DIRTY.policy, el.dataset.pol, { key: el.dataset.pol, value: el.value });
  }));

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  on('comUnlock', async () => {
    clearErr();
    try {
      await api('/auth/unlock', { method: 'POST', body: JSON.stringify({ passphrase: $('comPass').value }) });
      $('comPass').value = '';
      $('comLock').innerHTML = '<span style="color:var(--positive)">Editing unlocked for this session.</span>';
    } catch (e) { fail(e); }
  });

  on('comSavePolicy', () => comSave('policy', '/api/commission/policy',
    { settings: [...COM_DIRTY.policy.values()] }, 'The bands were saved.'));

  on('comSaveCells', () => comSave('cells', '/api/commission/targets',
    { year: COM_YEAR, cells: [...COM_DIRTY.cells.values()] }, 'Targets saved.'));

  on('comSaveBands', () => comSave('cells', '/api/commission/targets',
    { year: COM_YEAR, cells: [...COM_DIRTY.cells.values()] }, 'Band overrides saved.'));

  on('comSaveBranches', () => comSave('branches', '/api/commission/branches',
    { year: COM_YEAR, branches: [...COM_DIRTY.branches.values()] }, 'Branches saved.'));

  on('comSaveDepts', () => comSave('departments', '/api/commission/departments',
    { year: COM_YEAR, departments: [...COM_DIRTY.departments.values()] }, 'Departments saved.'));

  on('comSaveTerms', () => comSave('terms', '/api/vendor-terms',
    { year: COM_YEAR, terms: [...COM_DIRTY.terms.values()] }, 'Cash-back rates saved.'));

  on('vtAdd', async () => {
    clearErr();
    const supplierName = $('vtName').value;
    if (!supplierName) return fail(new Error('Pick a supplier.'));
    const raw = $('vtRate').value.trim();
    /* Refused rather than divided by a hundred on a guess: somebody typing 10
       meaning 10% would owe ten times the purchases back. The server refuses it
       too — this only saves the round trip. */
    const rate = raw === '' ? null : Number(raw);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
      return fail(new Error('A rate is a fraction between 0 and 1 — 0.10 for 10%.'));
    }
    try {
      await api('/api/vendor-terms', {
        method: 'PUT',
        body: JSON.stringify({ year: COM_YEAR, terms: [{ supplierName, cashbackRate: rate }] }),
      });
      await renderCommissionAdmin();
      $('err').innerHTML = `<span style="color:#9fe08a">Added ${esc(supplierName)}.</span>`;
    } catch (e) { fail(e); }
  });

  on('comAddOverride', async () => {
    clearErr();
    const branchId = Number($('ovBranch').value);
    const month = Number($('ovMonth').value);
    const cell = { branchId, month };
    for (const [f, id] of [['floorPct', 'ovFloor'], ['midPct', 'ovMid'], ['maxPct', 'ovMax']]) {
      const v = fromPct($(id).value);
      if (v !== null) cell[f] = v;
    }
    if (Object.keys(cell).length === 2) return fail(new Error('Give at least one of floor, mid or max.'));
    try {
      const out = await api('/api/commission/targets', { method: 'PUT', body: JSON.stringify({ year: COM_YEAR, cells: [cell] }) });
      COM.grid = out.grid; comClean(); drawCommission();
      $('err').innerHTML = '<span style="color:#9fe08a">Override set. That branch-month now uses its own bands.</span>';
    } catch (e) { fail(e); }
  });

  P.querySelectorAll('[data-clearband]').forEach((b) => b.addEventListener('click', async () => {
    clearErr();
    const [branchId, month] = b.dataset.clearband.split(':').map(Number);
    try {
      const out = await api('/api/commission/targets', {
        method: 'PUT',
        body: JSON.stringify({ year: COM_YEAR, cells: [{ branchId, month, floorPct: null, midPct: null, maxPct: null }] }),
      });
      COM.grid = out.grid; comClean(); drawCommission();
      $('err').innerHTML = '<span style="color:#9fe08a">That branch-month follows the policy again.</span>';
    } catch (e) { fail(e); }
  }));

  on('comAddBranch', async () => {
    clearErr();
    const b = {
      name: $('nbName').value, area: $('nbArea').value,
      entity: $('nbEntity').value, journalCode: $('nbJournal').value,
    };
    if (!b.name || !b.area || !b.entity) return fail(new Error('A new branch needs a name, an area and an owner.'));
    try {
      const out = await api('/api/commission/branches', { method: 'PUT', body: JSON.stringify({ year: COM_YEAR, branches: [b] }) });
      COM.grid = out.grid; comClean(); drawCommission();
      $('err').innerHTML = `<span style="color:#9fe08a">${esc(b.name)} added with no targets yet — fill its row in the grid.</span>`;
    } catch (e) { fail(e); }
  });

  on('comAddDept', async () => {
    clearErr();
    const d = { key: $('ndKey').value, label: $('ndLabel').value, multiplier: $('ndMult').value || null };
    if (!d.key || !d.label) return fail(new Error('A new department needs a key and a name.'));
    try {
      const out = await api('/api/commission/departments', { method: 'PUT', body: JSON.stringify({ year: COM_YEAR, departments: [d] }) });
      COM.grid = out.grid; comClean(); drawCommission();
      $('err').innerHTML = `<span style="color:#9fe08a">${esc(d.label)} added.</span>`;
    } catch (e) { fail(e); }
  });

  /* ---- doctor schemes ---- */

  /* A scheme's own fields. The bands are collected separately below because
     they are a LIST: saving one band means sending all of them, or the ones
     left out would be deleted by a save the person did not think they made. */
  P.querySelectorAll('[data-sch]').forEach((el) => el.addEventListener('input', () => {
    const [id, field] = el.dataset.sch.split(':');
    const prev = COM_DIRTY.schemes.get(id) || { id: Number(id) };
    comMark(el, COM_DIRTY.schemes, id, { ...prev, [field]: el.value });
  }));

  /* Touch ANY band cell and the whole band list for that scheme is gathered —
     see above. The blank row at the bottom becomes a new band if it is filled
     in, and is ignored if it is not. */
  const gatherBands = (id) => {
    const rows = new Map();
    P.querySelectorAll(`[data-schband^="${id}:"]`).forEach((c) => {
      const [, i, field] = c.dataset.schband.split(':');
      if (!rows.has(i)) rows.set(i, {});
      rows.get(i)[field] = c.value;
    });
    const list = [...rows.values()].filter((b) => String(b.rate).trim() !== '');
    const nb = {};
    P.querySelectorAll(`[data-newband^="${id}:"]`).forEach((c) => { nb[c.dataset.newband.split(':')[1]] = c.value; });
    if (String(nb.rate || '').trim() !== '') list.push(nb);
    return list;
  };
  /* `data-schband`, not `data-band`. BOTH SECTIONS USED `data-band` — the
     per-month band overrides above (`branchId:month:floorPct`) and these scheme
     bands (`schemeId:index:from`) — and both handlers bound to the bare
     selector. So typing a scheme's rate also wrote `{branchId: NaN, month: NaN}`
     into the TARGETS dirty map, and the next "Save the targets" would post it.
     Renaming one of them is the whole fix. */
  P.querySelectorAll('[data-schband],[data-newband]').forEach((el) => el.addEventListener('input', () => {
    const id = (el.dataset.schband || el.dataset.newband).split(':')[0];
    const prev = COM_DIRTY.schemes.get(id) || { id: Number(id) };
    comMark(el, COM_DIRTY.schemes, id, { ...prev, bands: gatherBands(id) });
  }));

  P.querySelectorAll('[data-doc]').forEach((el) => {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      /* The name carries a colon-free key, and the FIELD is the last segment —
         splitting on the first colon would cut a name like "Dr. X: locum" in
         half and save the change against a doctor who does not exist. */
      const raw = el.dataset.doc;
      const at = raw.lastIndexOf(':');
      const doctorName = raw.slice(0, at);
      const field = raw.slice(at + 1);
      const prev = COM_DIRTY.doctors.get(doctorName) || { doctorName };
      comMark(el, COM_DIRTY.doctors, doctorName, { ...prev, [field]: el.value });
    });
  });

  /* Schemes save one request each: they are separate records, and a scheme
     refused for overlapping bands must not take the other seven down with it. */
  on('schSave', async () => {
    clearErr();
    const list = [...COM_DIRTY.schemes.values()];
    if (!list.length) return fail(new Error('Nothing has changed.'));
    try {
      for (const sc of list) {
        const { id, ...body } = sc;
        await api(`/api/schemes/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      await renderCommissionAdmin();
      $('err').innerHTML = `<span style="color:#9fe08a">${list.length} scheme${list.length === 1 ? '' : 's'} saved. `
        + 'Every payslip is recalculated from them on the next refresh.</span>';
    } catch (e) { fail(e); }
  });

  on('schAdd', async () => {
    clearErr();
    const name = ($('nsName') || {}).value;
    if (!name) return fail(new Error('A new scheme needs a name.'));
    try {
      await api('/api/schemes', {
        method: 'POST',
        body: JSON.stringify({ name, hourlyRate: $('nsHourly').value, fixedBasic: $('nsFixed').value }),
      });
      await renderCommissionAdmin();
      $('err').innerHTML = `<span style="color:#9fe08a">${esc(name)} added. Give it its bands above — until it has `
        + 'them the report states that no rate is assumed rather than paying zero.</span>';
    } catch (e) { fail(e); }
  });

  const saveDoctors = async () => {
    clearErr();
    const list = [...COM_DIRTY.doctors.values()]
      /* A row touched and put back to "— none —" on somebody who was never
         assigned is not a change, and creating an empty record for them would
         move them out of the "on no scheme" list while changing nothing. */
      .filter((d) => Object.keys(d).length > 1);
    if (!list.length) return fail(new Error('Nothing has changed.'));
    try {
      const out = await api('/api/doctor-schemes', { method: 'PUT', body: JSON.stringify({ doctors: list }) });
      await renderCommissionAdmin();
      $('err').innerHTML = `<span style="color:#9fe08a">${list.length} doctor${list.length === 1 ? '' : 's'} saved, `
        + `${out.doctors.filter((d) => d.schemeId).length} now on a scheme.</span>`;
    } catch (e) { fail(e); }
  };
  on('docSave', saveDoctors);
  on('docSave2', saveDoctors);

  /* Nothing emits `data-note` while the unresolved-policy table is not drawn, so
     this binds to an empty list and costs nothing. Kept deliberately: putting
     the table back is then one render block, with its wiring already here. */
  P.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('change', async () => {
    clearErr();
    try {
      const out = await api(`/api/commission/notes/${el.dataset.note}`, {
        method: 'PUT', body: JSON.stringify({ resolved: el.checked }),
      });
      COM.notes = out.notes;
    } catch (e) { el.checked = !el.checked; fail(e); }
  }));
}

async function comSave(which, url, body, okMsg) {
  clearErr();
  const map = COM_DIRTY[which];
  if (!map.size) return fail(new Error('Nothing has changed.'));
  try {
    const out = await api(url, { method: 'PUT', body: JSON.stringify(body) });
    /* Reload rather than patch in place: a save can move a total, an annual gap
       or an override marker, and a half-refreshed grid is how you end up trusting
       a figure that is no longer there. */
    await renderCommissionAdmin();
    $('err').innerHTML = `<span style="color:#9fe08a">${esc(okMsg)}${out.updated ? ` ${fmt(out.updated)} cell${out.updated === 1 ? '' : 's'}.` : ''} The report picks this up on its next refresh.</span>`;
  } catch (e) { fail(e); }
}

LOADERS.commission = renderCommissionAdmin;

/* ============================================================
   07 · Uploads — the three feeds nothing sends us.

   `pbx`    the Grandstream export. Four of report 02's five tabs are a frozen
            snapshot of 1–18 August because this file has never arrived; when it
            does, those tabs start refreshing and their provenance line changes
            from `seed` to `upload` with no code change.
   `chat`   the omnichannel export. Chat was roughly seven in ten contacts in
            May, and the newest export on this project stops on 6 June, so the
            busiest channel in the contact centre is invisible today.
   `leads`  the CTA / organic lead sheet — the half of report 03's lead quality
            that Meta cannot see.

   Same three-step as the payables importer: inspect the file, review what it
   would do, then import. The middle step is not ceremony. No real Grandstream
   export has ever been seen on this project, so the column mapping below is a
   guess shown to somebody who can check it — and the review screen states which
   duration unit was assumed, because seconds versus `HH:MM:SS` is a factor of
   sixty on every occupancy figure and no column heading distinguishes them.
   ============================================================ */

const UPLOAD_KINDS = [
  {
    kind: 'pbx',
    title: 'PBX export',
    what: 'Grandstream UCM — queue and agent activity by day.',
    unblocks: 'Turns tabs 02–04 of the Contact Centre report from a frozen 1–18 August '
      + 'snapshot into something that refreshes.',
    accept: '.xlsx,.xls,.csv',
  },
  {
    kind: 'chat',
    title: 'Omnichannel export',
    what: 'Chat volume by day and channel, with bot-versus-human handling.',
    unblocks: 'The channel mix on report 02 — roughly seven in ten contacts, currently absent '
      + 'entirely rather than partially.',
    accept: '.xlsx,.xls,.csv',
  },
  {
    kind: 'leads',
    title: 'CTA / organic lead sheet',
    what: 'Leads that did not come through a Meta form.',
    unblocks: 'The organic half of Lead quality on report 03. Only the ten-digit mobile key is '
      + 'stored — never a name or a number.',
    accept: '.xlsx,.xls,.csv',
  },
  {
    kind: 'returns',
    title: 'Returns to suppliers',
    what: 'Goods sent back — supplier, product, quantity, value.',
    unblocks: 'Report 09 tab 04, and the cash-back basis on tab 03. There is not ONE negative '
      + 'purchase line in the whole cache, so the 11 rows carrying 3,047,191 are seeded from a '
      + 'frozen file and this replaces them. Unlike the others this needs no DATE column: a '
      + 'return is a fact about a product and a supplier, and the frozen rows have no date '
      + 'either. It replaces every uploaded return rather than a date range.',
    accept: '.xlsx,.xls,.csv',
  },
  {
    kind: 'payroll',
    title: 'Doctor payroll month',
    what: 'Hours, deductions, management fees and withholding — the Attendance and Basic '
      + 'worksheets of the monthly commission workbook.',
    unblocks: 'The payslips on Targets & Doctor Commission. Revenue and commission are derived '
      + 'from Odoo every month on their own; everything BELOW the commission line is here and '
      + 'is never inferred, so without this upload the tab shows the commission and states '
      + 'plainly that the payslip is unavailable. It asks which month it is for, because the '
      + 'sheet says who and never when, and it replaces that month only.',
    accept: '.xlsx,.xls,.csv',
  },
];

/**
 * Every input, how fresh it is, and what goes quiet without it.
 *
 * The table `src/lib/feeds.js` exists to make printable. Odoo and API feeds are
 * listed beside the hand-fed ones deliberately: the question a reader has is
 * "is this report current", and answering it only for the half somebody has to
 * remember leaves them checking the other half by feel.
 */
async function renderFeeds() {
  const { feeds } = await api('/api/admin/feeds');
  const late = feeds.filter((f) => f.late || f.empty);

  const state = (f) => (f.error ? '<span class="sev BLOCKER">error</span>'
    : f.empty ? '<span class="sev BLOCKER">never loaded</span>'
      : f.late ? `<span class="sev HIGH">${f.ageDays}d old</span>`
        : '<span class="sev LOW">current</span>');

  $('feeds').innerHTML = `<section>
    <div class="kicker">05 — Data</div>
    <h2 class="title">Where every figure comes from</h2>
    <p class="sub">Ten reports read from Odoo on a timer. The rest arrives because somebody sends
      it. ${late.length ? `<strong>${late.length} of ${feeds.length}</strong> are late or empty.`
    : `All ${feeds.length} are current.`}</p>

    <div class="tw"><table class="ltab"><thead><tr>
      <th>Feed</th><th>From</th><th>State</th><th class="n">Rows</th>
      <th>Expected</th><th>Goes quiet without it</th>
    </tr></thead><tbody>${feeds.map((f) => `<tr>
      <td class="nm">${esc(f.label)}<small style="display:block;color:var(--muted);font-size:10px">${esc(f.fills)}</small></td>
      <td><span class="ctag">${esc(f.source)}</span></td>
      <td>${state(f)}</td>
      <td class="n">${fmt(f.rows)}</td>
      <td style="font-size:11px;color:var(--muted)">${esc(f.cadence || 'no clock')}</td>
      <td style="font-size:11px">${esc(f.breaks)}</td>
    </tr>`).join('')}</tbody></table></div>

    <div class="tg-note">A feed with <strong>no clock</strong> is not chased by age — it is chased
      by what it is missing, which for the consumable catalogue is how many products have no
      service linked to them. Retiring a feed properly means setting its cadence to null in
      <code>src/lib/feeds.js</code>, not ignoring a row on tab 01 forever.</div>
  </section>`;
}

async function renderUploads() {
  const D = await api('/api/uploads');

  const held = (rows, label) => (rows && rows.length
    ? rows.map((r) => `<span class="sev ${r.source === 'upload' ? 'attended' : 'open'}">${esc(r.source)}</span>
        ${fmt(r.rows)} ${esc(label)}${r.from ? ` · ${esc(r.from)} → ${esc(r.to)}` : ''}`).join('<br>')
    : '<span style="color:var(--muted)">nothing loaded</span>');

  let h = `<section>
    <div id="ucmweekly"></div>
    <h3 class="subtitle" style="margin-top:26px">Bring a file in</h3>
    <p class="sub">Each of these fills a section of a report that currently shows an absence with a
      reason. Uploading one flips its provenance from <em>seed</em> to <em>upload</em> and the
      report starts reading it — no code change, and the seeded snapshot is left in place
      underneath so an import that turns out to be wrong can be removed without leaving a hole.</p>

    <div class="tw"><table class="ltab"><thead><tr>
      <th>Feed</th><th>What is held now</th></tr></thead><tbody>
      <tr><td><span class="nm">PBX day roll-up</span></td><td>${held(D.held.pbx, 'days')}</td></tr>
      <tr><td><span class="nm">Chat</span></td><td>${held(D.held.chat, 'day-channel rows')}</td></tr>
      <tr><td><span class="nm">Returns to suppliers</span></td><td>${held(D.held.returns, 'rows')}</td></tr>
      <tr><td><span class="nm">Leads</span></td><td>${D.held.leads.length
    ? D.held.leads.map((l) => `<span class="sev ${l.channel === 'organic' ? 'attended' : 'open'}">${esc(l.channel)}/${esc(l.source)}</span> ${fmt(l.rows)}`).join('<br>')
    : '<span style="color:var(--muted)">nothing loaded</span>'}</td></tr>
    </tbody></table></div>`;

  /* The Supermetrics allowance. Shown here because this is the page about where
     data comes from, and because the quota's failure mode is silent: spend it
     and report 03 simply stops refreshing. */
  if (D.api) {
    const A = D.api;
    const pctUsed = A.limit ? (A.used / A.limit) : 0;
    const tight = A.spendable < 10000;
    h += `<h3 class="subtitle">Supermetrics API allowance <span class="sm2">${esc(A.month)}</span></h3>
      <div class="fgrid">
        <div class="fstep"><div class="l">Rows used this month</div>
          <div class="v">${fmt(A.used)}</div>
          <div class="n">of ${fmt(A.limit)} · ${(pctUsed * 100).toFixed(1)}%<br>${fmt(A.queries)} quer${A.queries === 1 ? 'y' : 'ies'}</div></div>
        <div class="fstep${tight ? ' absent' : ''}"><div class="l">Spendable now</div>
          <div class="v">${fmt(A.spendable)}</div>
          <div class="n">${fmt(A.reserve)} held back for corrections${
      tight ? '<br><span class="why">running low</span>' : ''}</div></div>
        <div class="fstep"><div class="l">A full backfill costs</div>
          <div class="v">26,712</div>
          <div class="n">53% of a month — once, not twice</div></div>
        <div class="fstep"><div class="l">One day costs</div>
          <div class="v">~153</div>
          <div class="n">so a daily 3-day window<br>is about 13,800 a month</div></div>
      </div>
      <div class="tg-note">Rows pulled through the interactive Supermetrics connector do
        <strong>not</strong> draw on this allowance — only a server API key's traffic does.
        The scheduled sync is <code>scripts/sync-meta.js --days 3 --source api</code>, and it
        refuses to start a pull it cannot afford rather than stopping halfway.</div>`;
  }

  for (const k of UPLOAD_KINDS) {
    h += `<div class="listcard">
      <div class="listcard-head">
        <h3>${esc(k.title)}</h3>
        <button class="btn" data-upload="${esc(k.kind)}">Choose a file…</button>
      </div>
      <div class="pcard-body" style="padding:12px 18px 16px">
        <div class="sm2" style="line-height:1.6">${esc(k.what)}</div>
        <div class="sm2" style="margin-top:5px"><em>Unblocks:</em> ${esc(k.unblocks)}</div>
        <input type="file" data-uploadfile="${esc(k.kind)}" accept="${esc(k.accept)}" hidden>
      </div>
    </div>`;
  }

  h += `<h3 class="subtitle">Load history</h3>`;
  if (!D.loads.length) {
    h += '<div class="tg-note">Nothing has been loaded yet.</div>';
  } else {
    h += `<div class="tw scrolly" style="--h:340px"><table class="ltab tight"><thead><tr>
      <th>When</th><th>Kind</th><th>File</th><th>Range</th><th class="n">Rows</th><th>Notes</th><th>By</th>
      </tr></thead><tbody>
      ${D.loads.map((l) => `<tr>
        <td>${esc(l.at.replace('T', ' ').slice(0, 16))}</td>
        <td>${esc(l.kind)}</td>
        <td><span class="sm2">${esc(l.filename || '—')}</span></td>
        <td>${l.from ? `${esc(l.from)} → ${esc(l.to)}` : '—'}</td>
        <td class="n">${fmt(l.rows)}</td>
        <td><span class="sm2">${esc(l.notes || '')}</span></td>
        <td><span class="sm2">${esc(l.actor || '')}</span></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  /* The weekly UCM export goes FIRST in this panel: it is the upload that
     decides whether the Contact Centre report is open at all this week. */
  const ucmBox = document.getElementById('ucmweekly');
  if (ucmBox) {
    try {
      const gate = await api('/api/contact-centre/gate');
      AdminUcm.render(ucmBox, gate, {
        api,
        readBase64: (file) => new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1]);
          r.onerror = () => rej(new Error('Could not read that file.'));
          r.readAsDataURL(file);
        }),
        reload: () => renderUploads(),
      });
    } catch (e) {
      ucmBox.innerHTML = `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>The weekly UCM upload could not be loaded.</strong> ${esc(e.message)}</div>`;
    }
  }

  /* The extension map renders into its own container inside this panel — the
     same shape as the plan editor on Periods. Its own module for the same
     reason: a section bound through `document` cannot be fired by the test
     harness, and this one decides whose name appears against every call. */
  h += '<div id="extmap"></div></section>';
  $('uploads').innerHTML = h;

  try {
    const extData = await api('/api/pbx/extensions');
    AdminExt.render($('extmap'), extData, {
      api,
      data: () => extData,
      reload: () => renderUploads(),
    });
  } catch (e) {
    /* Named rather than silent: an empty space where the map should be reads
       as "there is no map". */
    const box = $('extmap');
    if (box) {
      box.innerHTML = `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>The phone extension map could not be loaded.</strong> ${esc(e.message)}</div>`;
    }
  }

  /* Delegated, because the cards are rebuilt on every load and the CSP forbids
     inline handlers. */
  for (const btn of document.querySelectorAll('[data-upload]')) {
    btn.addEventListener('click', () => {
      const input = document.querySelector(`[data-uploadfile="${btn.dataset.upload}"]`);
      if (input) input.click();
    });
  }
  for (const input of document.querySelectorAll('[data-uploadfile]')) {
    input.addEventListener('change', () => {
      if (input.files[0]) importUpload(input.dataset.uploadfile, input.files[0]);
    });
  }
}

/**
 * Inspect, review, import.
 *
 * The review step shows the column mapping and a sample row, and it is the step
 * that matters: the guesses are written for the field names a UCM report uses,
 * not for a file anyone has seen, so the person with the export is the only one
 * who can confirm the mapping is right.
 */
async function importUpload(kind, file) {
  clearErr();
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });

    let info = await api('/api/uploads/inspect', { method: 'POST', body: JSON.stringify({ base64 }) });

    if (info.sheets.length > 1) {
      const pick = prompt(
        `${file.name} has ${info.sheets.length} worksheets:\n\n`
        + info.worksheets.map((w, i) => `  ${i + 1}. ${w.name}${w.kind ? ` — looks like ${w.kind}` : ''}`).join('\n')
        + '\n\nWhich one? (name or number)',
        info.sheets[0],
      );
      if (!pick) return;
      const chosen = /^\d+$/.test(pick.trim())
        ? info.sheets[Number(pick.trim()) - 1]
        : info.sheets.find((n) => n.toLowerCase() === pick.trim().toLowerCase());
      if (!chosen) throw new Error(`No worksheet called "${pick}".`);
      info = await api('/api/uploads/inspect', { method: 'POST', body: JSON.stringify({ base64, sheet: chosen }) });
    }

    /* ---- the header may not be on row 1 ----
       Most uploads put it there and the guesser is right. A workbook with a
       merged banner above the header is the exception, and it announces itself
       the same way every time: the columns come back named "Column 1",
       "Column 2". Offering the correction here is the difference between a
       worksheet being importable and the server refusing it with a list of
       column names nobody recognises. */
    let headerRow = null;
    const looksBanner = info.columns.length > 2
      && info.columns.filter((c) => /^Column \d+$/.test(c)).length > info.columns.length / 2;
    if (looksBanner) {
      const sample = (info.sample || []).slice(0, 6)
        .map((r, i) => `  row ${i + 2}: ${Object.values(r).slice(0, 8).map((v) => (v == null ? '' : String(v))).join(' | ')}`)
        .join('\n');
      const ans = prompt(
        `Most of "${info.sheet}" has no column names — its header is probably not on row 1.\n\n`
        + `Row 1 reads: ${info.columns.slice(0, 8).join(' | ')}\n\n`
        + `The rows under it:\n${sample}\n\n`
        + 'Which row holds the headers? (a row number, or blank to use row 1)',
        '',
      );
      if (ans && /^\d+$/.test(ans.trim())) {
        headerRow = Number(ans.trim());
        info = await api('/api/uploads/inspect', {
          method: 'POST',
          body: JSON.stringify({ base64, sheet: info.sheet, headerRow }),
        });
      }
    }

    const cols = { ...(info.suggestions[kind] || {}) };
    let unmapped = Object.keys(cols).filter((r) => r !== 'guessed' && !cols[r]);

    /* ---- a column the guesser could not name, named by hand ----
       Only the REQUIRED roles are asked for. The optional ones are optional on
       purpose: an Attendance sheet legitimately has no deduction column, and
       asking about ten missing columns to import two is how a reviewer learns
       to click through the dialogs without reading them. */
    const NEEDED = { pbx: ['date'], chat: ['date'], leads: ['mobile'], returns: ['supplier'], payroll: ['doctor'] };
    for (const role of (NEEDED[kind] || [])) {
      if (cols[role]) continue;
      const list = info.columns.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
      const ans = prompt(
        `Nothing in "${info.sheet}" looks like the ${role} column.\n\n${list}\n\n`
        + `Which one is it? (name or number, blank to stop)`,
      );
      if (!ans) return;
      const pickCol = /^\d+$/.test(ans.trim())
        ? info.columns[Number(ans.trim()) - 1]
        : info.columns.find((c) => c.toLowerCase() === ans.trim().toLowerCase());
      if (!pickCol) throw new Error(`No column called "${ans}".`);
      cols[role] = pickCol;
      if (!cols.guessed) cols.guessed = [];
      cols.guessed.push(role);
    }
    unmapped = Object.keys(cols).filter((r) => r !== 'guessed' && !cols[r]);

    const mapped = (cols.guessed || []).map((r) => `  ${r} → ${cols[r]}`).join('\n');

    /* The mapping, in front of the person who can check it, before anything is
       read. A duration column is the one to look at twice. */
    const okMapping = confirm(
      `${file.name} · worksheet "${info.sheet}" · ${info.rowCount} rows\n\n`
      + `Columns found:\n  ${info.columns.join(', ')}\n\n`
      + `Mapped for ${kind}:\n${mapped || '  (nothing matched)'}\n`
      + (unmapped.length ? `\nNot found: ${unmapped.join(', ')}\n` : '')
      + (kind === 'returns'
        ? '\nA return is stored POSITIVE whatever sign the sheet uses, and its value is taken '
          + 'from the Value column — or from quantity x unit cost when Value is blank. Reading '
          + 'a unit price as the line total understates a 200-vial return by 199 vials.'
        : '\nDurations are read as SECONDS unless written as H:MM:SS — if this export uses '
          + 'minutes, every talk-time and occupancy figure would be 60x out, so check a sample '
          + 'row before continuing.')
      + '\n\nContinue?',
    );
    if (!okMapping) return;

    /* A payroll sheet says WHO and never WHEN. Asking here rather than
       defaulting to the current month is deliberate: payroll is usually loaded
       days into the NEXT month, so a default would file August's hours against
       September more often than not. */
    let period = null;
    if (kind === 'payroll') {
      const now = new Date();
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      period = prompt('Which month is this payroll sheet for? (YYYY-MM)',
        `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`);
      if (!period) return;
      period = period.trim();
      if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`"${period}" is not a month. Write it as 2026-08.`);
    }

    const dry = await api('/api/uploads/import', {
      method: 'POST',
      body: JSON.stringify({ base64, kind, sheet: info.sheet, headerRow, cols, filename: file.name, period, dryRun: true }),
    });

    const lines = [
      `${file.name} → ${kind}`,
      '',
      /* Returns may have no dates at all, and "0 day(s): null → null" reads as a
         broken import rather than as the normal shape for this feed. */
      dry.from
        ? `${dry.rows} rows across ${dry.days} day(s): ${dry.from} → ${dry.to}`
        : `${dry.rows} rows, none of them dated`,
    ];
    if (kind === 'pbx') {
      lines.push(`  ${dry.queueRows} queue rows, ${dry.agentRows} agent rows`);
      lines.push(`  ${dry.offered} offered · ${dry.answered} answered · ${dry.dials} dials`);
    }
    if (kind === 'chat') lines.push(`  ${dry.contacts} contacts across ${dry.channels.length} channel(s)`);
    if (kind === 'returns') {
      lines.push(`  ${fmt(dry.value)} across ${dry.suppliers} supplier(s), ${fmt(dry.qty)} units`);
      lines.push(`  ${dry.dated} of ${dry.rows} rows carry a date`);
      if (dry.existing) {
        lines.push(`  currently held: ${dry.existing.seed} seeded (${fmt(dry.existing.seedValue)})`
          + `, ${dry.existing.upload} uploaded (${fmt(dry.existing.uploadValue)})`);
      }
    }
    if (kind === 'payroll') {
      lines.push(`  ${dry.doctors} doctor(s) for ${dry.period} — ${fmt(dry.hours)} hours across ${dry.withHours} of them`);
      lines.push(`  ${dry.withDed} carry a deduction · ${dry.withMgmt} a management fee`);
      /* Named before the write, not discovered afterwards as a doctor with
         hours and no revenue. A name spelt differently from Odoo's matches
         nothing, silently. */
      /* The fixed basic masquerading as a management fee — see `preview`. */
      if (dry.doubled && dry.doubled.length) {
        lines.push('', `WARNING — ${dry.doubled.length} row(s) carry a management fee equal to that `
          + "doctor's fixed basic, which the payslip already pays. Importing as-is pays it twice:");
        for (const d of dry.doubled) lines.push(`  ${d.name}: ${fmt(d.amount)}`);
        lines.push('  Clear those cells in the sheet, or accept and correct the rows afterwards.');
      }
      if (dry.unknown && dry.unknown.length) {
        lines.push('', `${dry.unknown.length} name(s) are on no scheme here — their rows import `
          + 'but will not match a doctor until they are added in Commission:');
        lines.push(`  ${dry.unknown.slice(0, 12).join(', ')}${dry.unknown.length > 12 ? ' …' : ''}`);
      }
    }
    if (kind === 'leads') {
      lines.push(`  ${dry.distinctMobiles} distinct mobiles`);
      lines.push(`  ${dry.alsoInMetaLeads} of them already appear as Meta leads`);
    }
    if (dry.skippedCount) lines.push('', `${dry.skippedCount} row(s) skipped (blank, totals, or an unusable phone)`);
    if (dry.note) lines.push('', dry.note);
    lines.push('', 'Import?');

    if (!confirm(lines.join('\n'))) return;

    const out = await api('/api/uploads/import', {
      method: 'POST',
      body: JSON.stringify({ base64, kind, sheet: info.sheet, headerRow, cols, filename: file.name, period }),
    });
    await renderUploads();
    /* Payroll has no seeded snapshot standing behind it, so the sentence that
       reassures every other feed would be a false statement here. */
    const tail = out.replacedMonth
      ? ` Every payroll row for ${esc(out.period)} was replaced. Other months are untouched.`
      : `${out.replacedUploads ? ' Every previously uploaded return was replaced;' : ''} The seeded snapshot was left in place.`;
    $('err').innerHTML = `<span style="color:#9fe08a">Imported ${fmt(out.written)} ${esc(kind)} rows${
      out.from && !out.replacedMonth ? ` for ${esc(out.from)} → ${esc(out.to)}` : ''}.${tail}</span>`;
  } catch (e) { fail(e); }
}

LOADERS.data = async () => { await renderFeeds(); await renderUploads(); };
