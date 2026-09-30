/* Report 02 — Contact Centre.
 *
 * ONE PAGE, TWO WINDOWS, and the whole design follows from that.
 *
 * The phones are a frozen snapshot of 1–18 August 2026: the Grandstream PBX has
 * no feed reaching NRS, and the arrays inside the source HTML pack are the only
 * copy of that data in existence. The bookings are live Odoo and answer any
 * range. So a reader looking at "2,919 calls" and "7,655 bookings" on the same
 * screen is looking at eighteen days beside nineteen, and every panel that
 * touches the PBX prints its own window rather than inheriting the page's.
 *
 * Ask this report about September and the phone tabs say the export does not
 * exist for those dates. They do not say zero. A zero is a claim that the
 * phones did not ring, and it is the one wrong answer that looks like data.
 *
 * Three figures on this page are ASSUMPTIONS wearing the clothes of
 * measurements, and each is labelled where it appears:
 *
 *   occupancy and adherence divide talk time by a twelve-hour shift nobody has
 *   confirmed, against a CDR with no agent-state log to check;
 *
 *   the outbound headline in the source pack (7,888 dials) disagrees with the
 *   pack's own per-agent table (4,404) — the reconcilable figure is shown and
 *   the claim is stated;
 *
 *   bookings per agent does not exist at all, because all 2,100 call-centre
 *   bookings carry one shared Odoo login. The commission policy pays 30 EGP an
 *   agent on that figure, so the flat average is shown crossed-through with the
 *   reason rather than as a number anyone could act on.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 1) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(d)}%`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* Seconds, as a person reads a call length. */
const mmss = (s) => (s === null || s === undefined ? '—'
  : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);
const hhmm = (mins) => (mins === null || mins === undefined ? '—'
  : `${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, '0')}m`);

let DATA = null;
let SCOPE = 'all';

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const TALL = 'style="--h:360px"';

const bar = (v, max) =>
  `<div class="tr"><i style="width:${Math.min(100, max ? (v / max) * 100 : 0).toFixed(1)}%"></i></div>`;

/**
 * The banner every PBX panel opens with.
 *
 * Not a footnote and not optional: without it a panel showing 2,919 calls under
 * a control bar reading "1–19 August" is telling the reader something untrue,
 * and it is untrue in the direction that flatters the answer rate.
 */
function windowBanner(win, what) {
  if (!win) return '';
  if (!win.any) {
    return `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>No phone data for this range.</strong> ${esc(win.note || '')}</div>`;
  }
  if (win.full) {
    return `<div class="tg-note"><strong>${esc(what)} for ${esc(win.from)} → ${esc(win.to)}</strong>,
      from the frozen PBX snapshot — the only export of this data that exists.</div>`;
  }
  return `<div class="tg-note" style="border-left:3px solid #c98a2e">
    <strong>These are ${esc(win.from)} → ${esc(win.to)}, not the range above.</strong>
    ${esc(win.note || '')}</div>`;
}

/** A panel that has nothing to draw, saying why. */
function emptyPanel(id, kicker, title, win) {
  $(id).innerHTML = `<section>
    <div class="kicker">${esc(kicker)}</div>
    <h2 class="title">${esc(title)}</h2>
    ${windowBanner(win, title)}
    <div class="tg-note"><strong>Nothing is shown here rather than zero.</strong>
      The Grandstream PBX has no feed into NRS: these four tabs are a snapshot of
      1–18 August 2026 imported from the source report pack. Any other range has no phone
      data at all, and drawing zeroes would say the phones were silent.</div>
  </section>`;
}

/* --------------------------------------------------- 01 · executive summary --- */

function renderOverview(D) {
  const P = D.phones, B = D.bookings, A = D.agents, O = D.outbound;

  let h = `<section>
    <div class="kicker">01 — Executive summary</div>
    <h2 class="title">${P.window.any ? `${fmt(P.sessions)} sessions on the phones` : 'The bookings half only'}</h2>
    <p class="sub">Voice only — chat and DMs have never reached NRS, and chat was roughly seven
      in ten contacts in May. The phones and the bookings are two different windows; each card
      below says which one it is.</p>
    ${windowBanner(P.window, 'The phone figures are')}`;

  h += `<div class="kpi-grid six">
    <div class="tg-s tot"><div class="l">Sessions</div><div class="p">${fmt(P.sessions)}</div>
      <div class="n">${fmt(P.inbound)} inbound + ${fmt(P.dials)} dials</div></div>
    <div class="tg-s"><div class="l">Inbound answered</div><div class="p">${pc(P.answerRate)}</div>
      <div class="n">${fmt(P.answered)} of ${fmt(P.inbound)}<br>${fmt(P.abandoned)} abandoned</div></div>
    <div class="tg-s"><div class="l">Outbound connected</div><div class="p">${pc(O.connectRate)}</div>
      <div class="n">${fmt(O.connected)} of ${fmt(O.dials)}<br>${fmt(O.wasted)} wasted dials</div></div>
    <div class="tg-s"><div class="l">Bookings</div><div class="p">${fmt(B.booked)}</div>
      <div class="n">${fmt(B.contactCentre.bookings)} by the contact centre (${pc(B.contactCentre.share)})<br>
        <em>live Odoo, ${esc(D.from)} → ${esc(D.to)}</em></div></div>
    <div class="tg-s"><div class="l">Show rate</div><div class="p">${pc(B.showRate)}</div>
      <div class="n">${fmt(B.totals.attended)} attended<br>policy floor is ${pc(B.policyFloor)}</div></div>
    <div class="tg-s"><div class="l">Bookings per conversation</div>
      <div class="p">${B.bookingsPerConversation ? fmt(B.bookingsPerConversation.value, 2) : '—'}</div>
      <div class="n">${B.bookingsPerConversation
    ? `${fmt(B.bookingsPerConversation.conversations)} conversations<br>answered + connected`
    : 'needs both halves'}</div></div>
  </div>`;

  if (B.bookingsPerConversation && !B.bookingsPerConversation.comparable) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>The bookings-per-conversation ratio spans two windows.</strong>
      ${esc(B.bookingsPerConversation.note)}</div>`;
  }

  /* The occupancy figure, with its assumption attached rather than beneath it. */
  if (P.window.any) {
    h += `<h3 class="subtitle">Where the time goes</h3>
      <div class="fgrid">
        <div class="fstep"><div class="l">Talk time, all agents</div>
          <div class="v">${fmt(A.totals.talkHours, 1)}</div><div class="n">hours across ${fmt(A.agents.length)} agents</div></div>
        <div class="fstep absent"><div class="l">Occupancy</div>
          <div class="v">${pc(A.totals.occupancy)}</div>
          <div class="n">against an <strong>assumed</strong> ${fmt(A.assumedShiftHours)}-hour shift
            <br><span class="why">not measured — the CDR has no agent-state log</span></div></div>
        <div class="fstep"><div class="l">Peak hour</div>
          <div class="v">${D.hours.peak ? `${String(D.hours.peak.hour).padStart(2, '0')}:00` : '—'}</div>
          <div class="n">${D.hours.peak ? `${fmt(D.hours.peak.calls)} calls, ${fmt(D.hours.peak.answered)} answered` : ''}</div></div>
        <div class="fstep"><div class="l">Out of hours</div>
          <div class="v">${fmt(D.hours.outOfHours.calls)}</div>
          <div class="n">calls in ${esc(D.hours.outOfHours.hours)}<br>
            <strong>${fmt(D.hours.outOfHours.answered)}</strong> of them answered</div></div>
      </div>`;
  }

  h += `<h3 class="subtitle">Inbound by hour <span class="sm2">every day of the snapshot, added</span></h3>`;
  if (!D.hours.list.length) {
    h += '<div class="tg-note">No hourly data loaded.</div>';
  } else {
    const maxH = D.hours.list.reduce((a, x) => Math.max(a, x.calls), 0);
    h += `<div class="dbars">${D.hours.list.map((x) => `<div class="dbar"
        title="${String(x.hour).padStart(2, '0')}:00 · ${fmt(x.calls)} calls · ${fmt(x.answered)} answered">
        <div class="dbar-t"><i style="height:${maxH ? (x.calls / maxH) * 100 : 0}%"></i></div>
        <div class="dbar-d">${String(x.hour).padStart(2, '0')}</div>
        <div class="dbar-w">${x.answered ? pc(x.answered / x.calls, 0) : '0%'}</div>
      </div>`).join('')}</div>
      <p class="sub">The second line is the share answered in that hour. Nothing is answered
        before 09:00 or after 21:00 — <strong>${fmt(D.hours.outOfHours.calls)}</strong> calls
        arrive in those hours and none of them is picked up.</p>`;
  }

  if (P.days.length) {
    h += `<h3 class="subtitle">Daily volume</h3>
      <div class="tw"><table class="ltab tight"><thead><tr>
        <th>Date</th><th class="n">Inbound</th><th class="n">Answered</th><th class="n">Answer rate</th>
        <th class="n">Dials</th><th>Source</th></tr></thead><tbody>
      ${P.days.map((d) => `<tr><td>${esc(d.date)}</td>
        <td class="n">${fmt(d.inbound)}</td><td class="n">${fmt(d.answered)}</td>
        <td class="n">${pc(d.inbound ? d.answered / d.inbound : null)}</td>
        <td class="n">${fmt(d.dials)}</td>
        <td><span class="sev ${d.source === 'seed' ? 'open' : 'attended'}">${esc(d.source)}</span></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  h += absentBlock(D);
  $('ov').innerHTML = `${h}</section>`;
}

/** What this report cannot see, with the remedy. Shown on the summary tab. */
function absentBlock(D) {
  return `<h3 class="subtitle">What this report cannot see</h3>
    <p class="sub">Five absences, five different causes, five different people who can fix them.</p>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Missing</th><th>Why</th><th>What fixes it</th></tr></thead><tbody>
    ${D.absent.map((a) => `<tr>
      <td><span class="nm">${esc(a.what)}</span></td>
      <td><span class="sm2">${esc(a.why)}</span></td>
      <td><span class="sm2">${esc(a.fix)}</span></td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ------------------------------------------------------------- 02 · queues --- */

function renderQueues(D) {
  const Q = D.queues;
  if (!Q.window.any) return emptyPanel('q', '02 — Queues', 'Queues', Q.window);
  const E = Q.entities;
  const maxQ = Q.queues.reduce((a, q) => Math.max(a, q.offered), 0);

  let h = `<section>
    <div class="kicker">02 — Queues</div>
    <h2 class="title">${fmt(E.offeredTotal)} calls offered across ${fmt(Q.queues.length)} queues</h2>
    ${windowBanner(Q.window, 'Queue figures are')}`;

  h += `<div class="tg-sum">
    <div class="tg-s tot"><div class="l">Nouvel Age queues</div><div class="p">${fmt(E.nouvelAge.offered)}</div>
      <div class="n">${fmt(E.nouvelAge.answered)} answered<br>abandon ${pc(E.nouvelAge.abandonRate)}</div></div>
    <div class="tg-s"><div class="l">ZAT queue${E.zat.queues === 1 ? '' : 's'}</div><div class="p">${fmt(E.zat.offered)}</div>
      <div class="n">${fmt(E.zat.answered)} answered<br>abandon ${pc(E.zat.abandonRate)}</div></div>
    <div class="tg-s"><div class="l">Abandon gap</div><div class="p">${E.abandonGap === null ? '—' : `${(E.abandonGap * 100).toFixed(1)}`}</div>
      <div class="n">percentage points<br>ZAT worse on the same phone system</div></div>
    <div class="tg-s"><div class="l">Calls lost</div><div class="p">${fmt(E.nouvelAge.abandoned + E.zat.abandoned)}</div>
      <div class="n">nobody answered<br>across ${fmt(Q.window.from === Q.window.to ? 1 : D.phones.days.length)} days</div></div>
  </div>`;

  h += `<div class="tg-note"><strong>Both sides add up to the total, deliberately.</strong>
    ${fmt(E.nouvelAge.offered)} + ${fmt(E.zat.offered)} = ${fmt(E.offeredTotal)}. The source pack
    shows 2,426 + 483 against an aggregate of 2,919, because its Nouvel Age card quietly drops six
    queues holding ten calls between them. Ten calls change no conclusion — but two totals that do
    not add to the third is exactly how the commercial reports lost their unmapped branches, so
    every queue here is claimed by one side and the small ones are flagged as small instead.</div>`;

  h += `<h3 class="subtitle">By queue</h3>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Queue</th><th>Entity</th><th class="n">Offered</th><th></th>
      <th class="n">Answered</th><th class="n">Abandoned</th><th class="n">Abandon rate</th></tr></thead><tbody>
    ${Q.queues.map((q) => {
    const tiny = q.offered < E.tinyThreshold;
    return `<tr>
      <td><span class="nm">${esc(q.queue)}</span>${tiny
    ? '<div class="sm2">too few calls to read a rate from</div>' : ''}</td>
      <td>${esc(q.entity)}</td>
      <td class="n">${fmt(q.offered)}</td>
      <td style="min-width:90px">${bar(q.offered, maxQ)}</td>
      <td class="n">${fmt(q.answered)}</td>
      <td class="n">${fmt(q.abandoned)}</td>
      <td class="n">${tiny ? `<span style="color:var(--muted)">${pc(q.abandonRate)}</span>` : pc(q.abandonRate)}</td>
    </tr>`;
  }).join('')}
    </tbody></table></div>`;

  if (Q.tiny.length) {
    h += `<div class="tg-note"><strong>${Q.tiny.length} queues took fewer than
      ${fmt(E.tinyThreshold)} calls each</strong> (${fmt(E.tinyOffered)} between them). Their
      abandon rates are shown greyed: a queue that took one unanswered call reads as 100%
      abandoned, which is arithmetic rather than a finding.</div>`;
  }

  $('q').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------------- 03 · agents --- */

function renderAgents(D) {
  const A = D.agents;
  if (!A.window.any) return emptyPanel('ag', '03 — Agents', 'Agents', A.window);
  const B = D.bookings;

  let h = `<section>
    <div class="kicker">03 — Agents</div>
    <h2 class="title">${fmt(A.agents.length)} extensions on the phones</h2>
    ${windowBanner(A.window, 'Agent figures are')}`;

  /* The two assumptions, stated before the table that contains them. */
  h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
    <strong>Occupancy and adherence in this table are not measurements.</strong>
    ${esc(A.assumptionNote)}</div>`;

  h += `<div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>Ext</th><th>Name</th><th class="n">Offered</th><th class="n">Answered</th>
      <th class="n">Answer rate</th><th class="n">AHT in</th><th class="n">Dials</th>
      <th class="n">Connected</th><th class="n">AHT out</th><th class="n">Talk</th>
      <th class="n">Days</th><th class="n">Occupancy</th></tr></thead><tbody>
    ${A.agents.map((a) => `<tr>
      <td><span class="nm">${esc(a.ext)}</span></td>
      <td>${a.name ? esc(a.name) : '<span style="color:var(--muted)">not in the export</span>'}</td>
      <td class="n">${fmt(a.offered)}</td>
      <td class="n">${fmt(a.answered)}</td>
      <td class="n">${pc(a.answerRate)}</td>
      <td class="n">${mmss(a.ahtInSec)}</td>
      <td class="n">${fmt(a.dials)}</td>
      <td class="n">${fmt(a.connected)}</td>
      <td class="n">${mmss(a.ahtOutSec)}</td>
      <td class="n">${hhmm((a.talkInSec + a.talkOutSec) / 60)}</td>
      <td class="n">${fmt(a.daysActive)}</td>
      <td class="n"><span style="color:var(--muted)">${pc(a.occupancy)}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="sub">Only two of the ${fmt(A.agents.length)} extensions carry a name in the export.
      The rest are shown as extension numbers — inventing "Agent 6003" would read as a name
      somebody could look up.</p>`;

  /* The refusal. Rendered as a card so it sits where a number would. */
  h += `<h3 class="subtitle">Bookings per agent</h3>
    <div class="fgrid">
      <div class="fstep absent"><div class="l">Bookings per agent</div>
        <div class="v">cannot be derived</div>
        <div class="n"><span class="why">all ${fmt(B.perAgent.agents ? B.contactCentre.bookings : 0)}
          call-centre bookings carry one shared Odoo login</span></div></div>
      <div class="fstep"><div class="l">Call-centre bookings</div>
        <div class="v">${fmt(B.contactCentre.bookings)}</div>
        <div class="n">${pc(B.contactCentre.share)} of all bookings</div></div>
      <div class="fstep"><div class="l">Agents sharing that login</div>
        <div class="v">${fmt(B.perAgent.agents)}</div>
        <div class="n">every booking looks identical in Odoo</div></div>
      <div class="fstep absent"><div class="l">Flat average would be</div>
        <div class="v">${fmt(B.perAgent.flatAverage)}</div>
        <div class="n"><span class="why">each — which nobody should pay on</span></div></div>
    </div>
    <div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>This is the one figure on the report that the commission policy actually pays
      against.</strong> ${esc(B.perAgent.why)} <strong>Fix:</strong> ${esc(B.perAgent.fix)}</div>`;

  $('ag').innerHTML = `${h}</section>`;
}

/* ----------------------------------------------------------- 04 · outbound --- */

function renderOutbound(D) {
  const O = D.outbound;
  if (!O.window.any) return emptyPanel('out', '04 — Outbound', 'Outbound', O.window);
  const maxD = O.byAgent.reduce((a, x) => Math.max(a, x.dials), 0);

  let h = `<section>
    <div class="kicker">04 — Outbound</div>
    <h2 class="title">${fmt(O.dials)} dials, ${fmt(O.connected)} connected</h2>
    ${windowBanner(O.window, 'Outbound figures are')}`;

  /* The contradiction, before the numbers rather than after them. */
  if (O.packClaim) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>The source pack disagrees with itself here, and this panel shows the smaller
      figure.</strong> ${esc(O.packClaim.note)}</div>`;
  }

  h += `<div class="kpi-grid six">
    <div class="tg-s tot"><div class="l">Dials</div><div class="p">${fmt(O.dials)}</div>
      <div class="n">${fmt(O.perDay)} per active day</div></div>
    <div class="tg-s"><div class="l">Connected</div><div class="p">${fmt(O.connected)}</div>
      <div class="n">${pc(O.connectRate)} connection rate</div></div>
    <div class="tg-s"><div class="l">Wasted dials</div><div class="p">${fmt(O.wasted)}</div>
      <div class="n">no answer, busy or failed</div></div>
    <div class="tg-s"><div class="l">Outbound talk</div><div class="p">${fmt(O.talkOutHours, 1)}</div>
      <div class="n">hours<br>avg ${mmss(O.avgTalkSec)} per connected call</div></div>
  </div>`;

  h += `<h3 class="subtitle">Dials and connection rate by extension</h3>
    <p class="sub">The spread is the finding. The best and worst extensions use the same dialler
      on the same lists, so a gap this wide is a list problem or a time-of-day problem rather
      than an effort one.</p>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Ext</th><th>Name</th><th class="n">Dials</th><th></th><th class="n">Connected</th>
      <th class="n">Connection rate</th><th class="n">Talk</th><th class="n">AHT</th></tr></thead><tbody>
    ${O.byAgent.map((x) => `<tr>
      <td><span class="nm">${esc(x.ext)}</span></td>
      <td>${x.name ? esc(x.name) : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="n">${fmt(x.dials)}</td>
      <td style="min-width:90px">${bar(x.dials, maxD)}</td>
      <td class="n">${fmt(x.connected)}</td>
      <td class="n">${pc(x.connectRate)}</td>
      <td class="n">${hhmm(x.talkOutSec / 60)}</td>
      <td class="n">${mmss(x.ahtOutSec)}</td></tr>`).join('')}
    </tbody></table></div>`;

  $('out').innerHTML = `${h}</section>`;
}

/* ----------------------------------------------------------- 05 · bookings --- */

function renderBookings(D) {
  const B = D.bookings;

  let h = `<section>
    <div class="kicker">05 — Bookings</div>
    <h2 class="title">From a call to a patient in a chair</h2>
    <p class="sub">The one tab on this report that is live. Every appointment dated
      ${esc(D.from)} → ${esc(D.to)} in Odoo, cut by who created it, which branch it belongs to
      and which doctor it was booked with.</p>
    <div class="tg-note"><strong>Live Odoo, the full range</strong> — unlike the four phone tabs,
      which are a frozen snapshot of 1–18 August. This tab moves when you change the dates.</div>`;

  if (!B.reportable) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>No measurable bookings in this range.</strong> Odoo 18 went live on
      ${esc(B.cutover)}; everything before it is migrated data with every appointment set to
      <code>done</code>, so there is no show rate to report.</div></section>`;
    $('bk').innerHTML = h;
    return;
  }
  if (B.preCutover) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>Measured from ${esc(B.cutover)}, not ${esc(D.from)}.</strong>
      ${fmt(B.preCutover)} earlier bookings are excluded: the migration set them all to
      <code>done</code>, so including them would report a show rate near 82%.</div>`;
  }

  h += `<div class="kpi-grid six">
    <div class="tg-s tot"><div class="l">Booked</div><div class="p">${fmt(B.booked)}</div>
      <div class="n">all channels</div></div>
    <div class="tg-s"><div class="l">By the contact centre</div><div class="p">${fmt(B.contactCentre.bookings)}</div>
      <div class="n">${pc(B.contactCentre.share)} of all bookings</div></div>
    <div class="tg-s"><div class="l">By front office</div><div class="p">${fmt(B.contactCentre.frontOffice)}</div>
      <div class="n">${pc(B.contactCentre.frontOfficeShare)} · across shared logins</div></div>
    <div class="tg-s"><div class="l">Attended</div><div class="p">${fmt(B.totals.attended)}</div>
      <div class="n">show rate ${pc(B.showRate)} · floor ${pc(B.policyFloor)}</div></div>
    <div class="tg-s"><div class="l">Still pending</div><div class="p">${fmt(B.totals.open)}</div>
      <div class="n">${pc(B.booked ? B.totals.open / B.booked : null)} with no outcome recorded</div></div>
    <div class="tg-s"><div class="l">Bookings per conversation</div>
      <div class="p">${B.bookingsPerConversation ? fmt(B.bookingsPerConversation.value, 2) : '—'}</div>
      <div class="n">${B.bookingsPerConversation
    ? `${fmt(B.bookingsPerConversation.conversations)} conversations`
    : 'no phone data for this range'}</div></div>
  </div>`;

  h += `<h3 class="subtitle">Who created the bookings</h3>
    ${(() => {
    const max = B.creators.reduce((a, c) => Math.max(a, c.count), 0);
    return `<div class="blist">${B.creators.map((c) => `<div class="blist-row">
        <span class="nm">${esc(c.name)}</span>${bar(c.count, max)}
        <span class="vv">${fmt(c.count)}<small>${pc(B.booked ? c.count / B.booked : null)}</small></span>
      </div>`).join('')}</div>`;
  })()}
    <p class="sub">Each of these is a shared Odoo login, not a person. That is why bookings per
      agent cannot be derived — see tab 03.</p>`;

  h += `<h3 class="subtitle">By branch</h3>
    <div class="tw scrolly" ${TALL}><table class="ltab"><thead><tr>
      <th>Branch</th><th class="n">Booked</th><th class="n">Attended</th><th class="n">Show rate</th>
      <th class="n">Lost</th><th class="n">Still open</th></tr></thead><tbody>
    ${B.branches.map((b) => `<tr>
      <td><span class="nm">${esc(b.name)}</span></td>
      <td class="n">${fmt(b.booked)}</td>
      <td class="n">${fmt(b.attended)}</td>
      <td class="n">${pc(b.showRate)}</td>
      <td class="n">${fmt(b.lost)}</td>
      <td class="n">${fmt(b.open)}</td></tr>`).join('')}
    </tbody></table></div>`;

  if (B.specialists && B.specialists.length) {
    h += `<h3 class="subtitle">By doctor <span class="sm2">top ${fmt(B.specialists.length)}</span></h3>
      <div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
        <th>Doctor</th><th class="n">Booked</th><th class="n">Attended</th>
        <th class="n">Show rate</th></tr></thead><tbody>
      ${B.specialists.map((s) => `<tr>
        <td><span class="nm">${esc(s.name)}</span></td>
        <td class="n">${fmt(s.booked)}</td>
        <td class="n">${fmt(s.attended)}</td>
        <td class="n">${pc(s.showRate)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  $('bk').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------------------ paint --- */

function paint() {
  const D = DATA;
  const P = D.phones, B = D.bookings;
  $('hPeriod').textContent = ` · ${D.from} → ${D.to}`;
  $('hSess').textContent = P.window.any ? fmt(P.sessions) : '—';
  $('hAns').textContent = pc(P.answerRate);
  $('hBook').textContent = fmt(B.booked);
  $('hShow').textContent = pc(B.showRate);
  $('rangeline').innerHTML = `<strong>${fmt(B.booked)}</strong> bookings
    · <strong>${fmt(B.contactCentre.bookings)}</strong> by the contact centre
    · <strong>${pc(B.showRate)}</strong> show rate
    ${P.window.any
    ? `· <strong>${fmt(P.inbound)}</strong> inbound and <strong>${fmt(P.dials)}</strong> dials
       for ${esc(P.window.from)} → ${esc(P.window.to)}`
    : '· <span style="color:#b0503c">no phone data for this range</span>'}
    ${D.scope === 'all' ? '' : ` · <strong>${esc(D.scope)}</strong> only`}`;

  renderOverview(D); renderQueues(D); renderAgents(D); renderOutbound(D); renderBookings(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, scope: SCOPE });
    DATA = await api(`/api/contact-centre?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.bookings.booked)} bookings`;
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
/* Reloads rather than repaints: the queue filter is a SQL scope and the booking
   filter is a branch list, both applied server-side. */
document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#scope button').forEach((x) => x.classList.toggle('on', x === b));
  SCOPE = b.dataset.scope;
  load();
}));
$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
