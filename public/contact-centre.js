/* Report 02 — Contact Centre.
 *
 * ONE PAGE, THREE WINDOWS, and the whole design follows from that.
 *
 * The phones are a frozen snapshot of 1–18 August 2026: the Grandstream PBX has
 * no feed reaching NRS, and the export is uploaded by hand in Admin. The CRM is
 * a second frozen snapshot — opportunities for September, leads to 3 October,
 * appointments reaching forward to 10 October, because the point of a
 * confirmation-call report is the bookings that have not happened yet. So a
 * reader looking at "2,919 calls" and "12,386 opportunities" on the same screen
 * is looking at two different fortnights, and EVERY PANEL PRINTS ITS OWN WINDOW
 * rather than inheriting the page's.
 *
 * Ask this report about a range nothing covers and the panels say the export
 * does not reach those dates. They do not say zero. A zero is a claim that
 * nothing happened, and it is the one wrong answer that looks like data.
 *
 * WHAT THIS PAGE CAN DO THAT ODOO CANNOT: name people. Nine shared logins cover
 * sixty-seven of them, so `create_uid` names a desk. Every name here was read
 * out of the `Employee:` line in a chatter message instead.
 *
 * THREE THINGS IT REFUSES TO ANSWER, each said out loud where it would
 * otherwise be drawn as an empty table: lead source (this export has no such
 * column — which is NOT the same as Odoo having no sources, and the panel
 * separates the two), the person behind an activity, and the person behind a
 * re-booking. The last two are empty on every row of the export.
 *
 * This file is the controller only. The eight panels are their own modules so
 * each can be rendered and asserted on its own — the lesson from payslip.js,
 * which was untestable for months because it was reachable only through a
 * document-level handler the harness cannot fire.
 */

/* From public/fmt.js — one copy of these for every page. They had drifted
   apart by 2026-10-04 (two `pc`, two `esc`); see that file. */
const { $, fmt, pc, esc } = Fmt;

let DATA = null;
let SCOPE = 'all';

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

/* panel id -> module. The order here is the order the tabs are drawn in. */
const PANELS = [
  ['pa', () => CcAppointments],
  ['ov', () => CcSummary],
  ['pc', () => CcCrm],
  ['pu', () => CcCalls],
  ['ag', () => CcAgents],
  ['tm', () => CcTiming],
  ['br', () => CcBranches],
  ['dq', () => CcQuality],
];

/* What a panel's wire() gets: enough to ask for a repaint without reaching for
   the module's own state or for `document`. */
const ctx = { redraw: () => paint(), api, from: () => $('from').value, to: () => $('to').value };

/* ------------------------------------------------------------------ paint --- */

function paint() {
  const D = DATA;
  if (!D) return;
  const S = D.summary;
  const A = D.appointments;
  const P = D.phones;
  const T = S && S.totals;
  const AT = A && A.totals;

  $('hPeriod').textContent = ` · ${D.from} → ${D.to}`;
  $('hOpp').textContent = T ? fmt(T.n) : '—';
  $('hBook').textContent = T ? pc(T.bookingRate) : '—';
  $('hShow').textContent = T ? pc(T.showRate) : '—';
  $('hCredit').textContent = T ? fmt(T.lostCredit) : '—';

  /* The rangeline says which window each half is answering for, because the
     control bar above it says something different from both. */
  const bits = [];
  if (T) bits.push(`<strong>${fmt(T.n)}</strong> opportunities for ${esc(S.window.from)} → ${esc(S.window.to)}`);
  if (AT) bits.push(`<strong>${fmt(AT.n)}</strong> appointments for ${esc(A.window.from)} → ${esc(A.window.to)}`);
  if (P && P.window.any) bits.push(`<strong>${fmt(P.inbound)}</strong> calls for ${esc(P.window.from)} → ${esc(P.window.to)}`);
  else bits.push('<span style="color:#b0503c">no phone data for this range</span>');
  if (D.scope !== 'all') bits.push(`<strong>${esc(D.scope)}</strong> only`);
  $('rangeline').innerHTML = bits.join(' · ');

  for (const [id, mod] of PANELS) {
    const el = $(id);
    const m = mod();
    if (!el || !m) continue;
    /* A panel that throws must not empty the seven around it. */
    try {
      m.render(el, D, ctx);
    } catch (e) {
      el.innerHTML = `<section><div class="kicker">Panel failed</div>
        <h2 class="title">This panel could not be drawn</h2>
        <div class="tg-note" style="border-left:3px solid #b0503c">${esc(e.message)}</div></section>`;
    }
  }
}

/**
 * The week is not in, so the report is closed. Nothing is drawn behind the
 * card — the server sent no figures — and every panel and hero figure is
 * cleared, so a previous load's numbers cannot sit under it looking current.
 */
function locked(L) {
  DATA = null;
  for (const [id] of PANELS) { const el = $(id); if (el) el.innerHTML = ''; }
  for (const id of ['hOpp', 'hBook', 'hShow', 'hCredit']) $(id).textContent = '—';
  $('rangeline').textContent = 'Locked until last week\'s UCM export is uploaded.';
  CcGate.render($('ccgate'), L);
  $('dot').className = 'dot bad';
  $('status').textContent = 'locked';
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, scope: SCOPE });
    /* Read by hand rather than through api(): a 423 is not an error to print in
       red, it is the weekly lock, and it carries what the lock screen needs. */
    const res = await fetch(`/api/contact-centre?${q}`,
      { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    const json = await res.json().catch(() => ({}));
    if (res.status === 423 && json.locked) { locked(json); return; }
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    $('ccgate').innerHTML = '';
    DATA = json;
    paint();
    $('dot').className = 'dot ok';
    const n = DATA.summary && DATA.summary.totals ? DATA.summary.totals.n : 0;
    $('status').textContent = `${fmt(n)} opportunities`;
  } catch (e) {
    $('dot').className = 'dot bad';
    $('status').textContent = 'failed';
    $('err').textContent = e.message;
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
function preset(p) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (p === 'lastmonth') {
    $('from').value = iso(new Date(Date.UTC(y, m - 1, 1)));
    $('to').value = iso(new Date(Date.UTC(y, m, 0)));
  } else if (p === 'quarter') {
    $('from').value = iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)));
    $('to').value = iso(now);
  } else if (p === 'ytd') {
    $('from').value = `${y}-01-01`; $('to').value = iso(now);
  } else {
    $('from').value = `${iso(now).slice(0, 7)}-01`; $('to').value = iso(now);
  }
}

document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
  preset(b.dataset.p); load();
}));
/* Reloads rather than repaints: the queue filter is a SQL scope and the branch
   filter is a name list, both applied server-side. */
document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#scope button').forEach((x) => x.classList.toggle('on', x === b));
  SCOPE = b.dataset.scope;
  load();
}));
$('load').addEventListener('click', load);
Shell.onRefresh(load);

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
