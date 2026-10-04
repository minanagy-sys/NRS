/* ============================================================
   03 — Calls.

   The phone system's own numbers, and the only panel here that is not about
   Odoo. It answers for a DIFFERENT WINDOW from every other panel — the PBX
   export is 1–18 August 2026 and the CRM snapshot is September into October —
   so the banner at the top is not decoration.

   THE ANSWER RATE'S DENOMINATOR IS CALLS THAT REACHED A QUEUE, not all inbound.
   A call that died in the IVR was never offered to anybody, and counting it as
   unanswered blames the agents for the menu. Those are reported separately.

   THE HOURLY CHART IS A TYPICAL DAY, not the range. The export carries an
   hour-of-day profile aggregated over its whole window, not an hour-by-day
   series, and the server says so in `grain` rather than letting the client
   imply otherwise.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcCalls = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { fmt, pc, esc, mmss, bar, windowBanner, table, kpi, kpis } = F;

  /**
   * What is loaded, how stale it is, and where to fix it.
   *
   * The source page did this with a modal that BLOCKED the whole report until
   * somebody uploaded last week's export. That nags the one person who opens
   * the page, who is usually not the person with the file, and it stops a
   * reader who only wanted to look at August. This says the same thing without
   * standing in the way — but it must still say where the file goes, because a
   * refusal that does not name the remedy is just a dead end.
   */
  function loadState(D, today) {
    const cov = D && D.coverage;
    if (!cov || !cov.to) {
      return `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>No call data has ever been loaded.</strong> The phone system has no feed into
        NRS — the export is uploaded by hand. Admin → Uploads takes the file straight from
        UCM → CDR → Export.</div>`;
    }
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${cov.to}T00:00:00Z`)) / 86400000);
    const held = (cov.spans || []).map((sp) =>
      `${esc(sp.from)} → ${esc(sp.to)} (${fmt(sp.days)} days, ${esc(sp.source)})`).join('; ');
    if (days <= 7) {
      return `<div class="tg-note">Calls loaded: ${held}.</div>`;
    }
    return `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>The newest call data is ${fmt(days)} days old.</strong> Loaded: ${held}. Every week
      that is not uploaded is a week this panel cannot answer for — and the booking panels
      alongside it keep going, so the gap is easy to miss. The file comes from
      UCM → CDR → Export and goes in Admin → Uploads.</div>`;
  }

  function html(D) {
    const P = D && D.phones;
    const win = P && P.window;
    if (!P || !win || !win.any) {
      /* Not a bare refusal: it names what IS held and where the missing file
         goes, which is the only useful half of the modal this replaced. */
      return `<section>
        <div class="kicker">03 — Calls</div>
        <h2 class="title">No calls for this range</h2>
        ${windowBanner(win, 'Calls')}
        ${loadState(D, (D && D.today) || '')}
        <div class="tg-note"><strong>Nothing is shown here rather than zero.</strong>
          A zero would be a claim that the phones did not ring. What is true is that the export
          does not cover these dates.</div>
      </section>`;
    }
    const Q = D.queues;
    const AG = D.agents;
    const OB = D.outbound;
    const HR = D.hours;

    let h = `<section>
      <div class="kicker">03 — Calls</div>
      <h2 class="title">${esc(win.from)} → ${esc(win.to)}</h2>
      <p class="sub">Every inbound call and every dial, from the phone system's own export.
        Uploaded in Admin; there is no live feed.</p>
      ${windowBanner(win, 'Calls')}
      ${loadState(D, D.today || '')}`;

    h += kpis([
      kpi('Inbound', fmt(P.inbound), 'calls that reached the switchboard', 'accent'),
      kpi('Answered', fmt(P.answered), `${pc(P.answerRate)} of calls offered to a queue`),
      kpi('Abandoned', fmt(P.inbound - P.answered), 'rang out or hung up'),
      kpi('Dials', fmt(P.dials), 'outbound attempts'),
      kpi('Connected', fmt(OB.connected), `${pc(OB.connected / (P.dials || 1))} of dials`),
      kpi('Out of hours', fmt(HR.outOfHours.calls), esc(HR.outOfHours.hours)),
    ]);

    /* The contradiction in the source pack, carried rather than resolved. */
    if (OB.packClaim && OB.packClaim.dials && OB.packClaim.dials !== OB.packClaim.stored) {
      h += `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>The export disagrees with itself about outbound.</strong> Its summary says
        ${fmt(OB.packClaim.dials)} dials; its own per-agent rows sum to
        ${fmt(OB.packClaim.stored)}. The stored figure is the one used everywhere here, because
        it is the one that reconciles. Neither has been corrected — picking silently is how a
        report starts lying.</div>`;
    }

    /* ---- the hourly profile ---- */
    if (HR.list.length) {
      h += `<h3 class="subtitle">A typical day</h3>
        <p class="sub">${esc(HR.note || '')}</p>`;
      const maxH = HR.list.reduce((m, x) => Math.max(m, x.calls), 0);
      h += '<div class="dbars">';
      for (const x of HR.list) {
        h += `<div class="dbar"><div class="dbar-d">${String(x.hour).padStart(2, '0')}:00</div>
          <div class="dbar-w">${bar(x.calls, maxH)}</div>
          <div class="dbar-t">${fmt(x.calls)} · ${fmt(x.answered)} answered</div></div>`;
      }
      h += '</div>';
      if (HR.outOfHours.calls) {
        h += `<div class="tg-note"><strong>${fmt(HR.outOfHours.calls)} calls arrived when nobody
          was on the phones</strong> (${esc(HR.outOfHours.hours)}), and
          ${fmt(HR.outOfHours.answered)} of them were answered.</div>`;
      }
    }

    /* ---- agents, now with names ---- */
    if (AG && AG.agents.length) {
      const conflicts = AG.agents.filter((a) => a.nameConflict);
      h += `<h3 class="subtitle">Agents</h3>
        <p class="sub">Names come from the extension map, which is edited in Admin. The phone
          export itself carries only a first name, and no Odoo employee at all.</p>`;
      if (conflicts.length) {
        h += `<div class="tg-note" style="border-left:3px solid #b0503c">
          <strong>${conflicts.length === 1 ? 'One extension disagrees' : `${conflicts.length} extensions disagree`}
          with the phone system about who sits there.</strong>
          ${conflicts.map((a) => `Extension ${esc(a.ext)} is <em>${esc(a.cdrName)}</em> in the phone
            export and <em>${esc(a.phoneName)}</em> in the map`).join('; ')}. Every call on
          ${conflicts.length === 1 ? 'it' : 'them'} is attributed to whichever one you believe,
          so one of the two needs correcting in Admin before these rows mean anything.</div>`;
      }
      h += table(AG.agents, [
        { k: 'ext', h: 'Ext' },
        { k: 'name', h: 'Agent' },
        { k: 'odooEmployee', h: 'In Odoo', f: (r) => (r.odooEmployee ? esc(r.odooEmployee) : '<span class="sm2">unmapped</span>') },
        /* Blank, not 0, for answers that came from a weekly CDR: it says who
           answered a call, not who it rang, so "offered" is not in the data. */
        { k: 'offered', h: 'Offered', n: true, f: (r) => (r.offered || !r.answersWithoutOffer ? fmt(r.offered) : '—') },
        { k: 'answered', h: 'Answered', n: true, f: (r) => fmt(r.answered) },
        { k: 'answerRate', h: 'Answer rate', n: true, f: (r) => pc(r.answerRate) },
        { k: 'ahtInSec', h: 'Avg talk in', n: true, f: (r) => mmss(r.ahtInSec) },
        { k: 'dials', h: 'Dials', n: true, f: (r) => fmt(r.dials) },
        { k: 'connected', h: 'Connected', n: true, f: (r) => fmt(r.connected) },
      ], { scroll: true, minw: 840, h: 420 });
      if (AG.agents.some((a) => a.answersWithoutOffer)) {
        h += `<div class="tg-note">Answers from the weekly UCM export have no "offered" figure:
          the call log says which agent answered a call, not which agents it rang before that. The
          answer rate is worked out only on the days that do carry it, and is blank where none do.</div>`;
      }
      const unmapped = AG.agents.filter((a) => !a.odooEmployee).length;
      if (unmapped) {
        h += `<div class="tg-note">${fmt(unmapped)} of ${fmt(AG.agents.length)} extensions have no
          Odoo employee against them, so their calls cannot be joined to anything this person did
          in the CRM. The map is in Admin.</div>`;
      }
      if (AG.assumptionNote) {
        h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
          <strong>Occupancy and adherence are not measurements.</strong> ${esc(AG.assumptionNote)}</div>`;
      }
    }

    /* ---- queues ---- */
    if (Q && Q.queues.length) {
      h += `<h3 class="subtitle">Queues</h3>
        ${table(Q.queues, [
    { k: 'queue', h: 'Queue' },
    { k: 'offered', h: 'Offered', n: true, f: (r) => fmt(r.offered) },
    { k: 'answered', h: 'Answered', n: true, f: (r) => fmt(r.answered) },
    { k: 'abandoned', h: 'Abandoned', n: true, f: (r) => fmt(r.abandoned) },
    { k: 'abandonRate', h: 'Abandon rate', n: true, f: (r) => pc(r.abandonRate) },
  ])}`;
      if (Q.entities) {
        h += `<div class="tg-note">Nouvel Age ${fmt(Q.entities.nouvelAge.offered)} +
          ZAT ${fmt(Q.entities.zat.offered)} = ${fmt(Q.entities.nouvelAge.offered + Q.entities.zat.offered)},
          which is every call offered. Both sides add up to the total rather than leaving the
          small queues out.</div>`;
      }
    }

    /* ---- the daily series ---- */
    h += `<h3 class="subtitle">Day by day</h3>
      ${table(P.days, [
    { k: 'date', h: 'Date' },
    { k: 'inbound', h: 'Inbound', n: true, f: (r) => fmt(r.inbound) },
    { k: 'answered', h: 'Answered', n: true, f: (r) => fmt(r.answered) },
    { k: 'dials', h: 'Dials', n: true, f: (r) => fmt(r.dials) },
    { k: 'source', h: 'Source' },
  ], { scroll: true, h: 380 })}`;

    return `${h}</section>`;
  }

  function wire() { /* nothing interactive */ }
  function render(el, D, ctx) { el.innerHTML = html(D); wire(el, ctx); }

  return { html, wire, render };
});
