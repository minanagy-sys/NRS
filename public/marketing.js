/* Report 03 — Marketing.
 *
 * The only report in NRS about money going OUT, and the only one whose numbers
 * are partly inferred rather than recorded. Doctor, service and branch are read
 * out of campaign names somebody typed into Meta; the lead-to-patient link is a
 * phone-number join. Both are useful and neither is a fact, so the guiding rule
 * for every panel here is that an inference has to LOOK like one.
 *
 * Which means, concretely:
 *
 *   Every mix carries its own coverage. Only ~38% of this range's campaign spend
 *   names a service, so a service pie drawn from the named part alone would
 *   describe two-fifths of the money and read as though it described all of it.
 *   The unnamed share is a row in the chart, not a footnote.
 *
 *   Reach is never totalled. It counts people, so adding days double-counts
 *   anyone who saw an ad twice. The range gets impressions and the best single
 *   day's reach, labelled as one day.
 *
 *   An ad that inherited its service from its campaign says so, because the ad
 *   named `offer` is Laser at Mall Of Arabia in one campaign and unlabelled at
 *   Alexandria in another.
 *
 *   And where there is no data there is a reason and a remedy, never a zero.
 *   Four things are missing for four different reasons and each needs a
 *   different person to fix it, so "What exists" names them individually.
 *
 * The All / Nouvel Age / ZAT switch reloads rather than repainting: scope here
 * is an ad-account filter applied in SQL, unlike the other reports where it
 * filters branch rows already in the payload.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 1) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(d)}%`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;
let SCOPE = 'all';

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

/* Ten rows and then an inner scroll, which is how every long table in these
   reports behaves. */
const TALL = 'style="--h:360px"';

const bar = (v, max) =>
  `<div class="tr"><i style="width:${Math.min(100, max ? (v / max) * 100 : 0).toFixed(1)}%"></i></div>`;

/** A bar list, with the unnamed bucket rendered as itself rather than dropped. */
function blist(rows, { valueOf, labelOf, subOf, total }) {
  const max = rows.reduce((a, r) => Math.max(a, valueOf(r)), 0);
  return `<div class="blist">${rows.map((r) => {
    const v = valueOf(r);
    const label = labelOf(r);
    return `<div class="blist-row">
      <span class="nm"${label.muted ? ' style="color:var(--muted);font-style:italic"' : ''}>${esc(label.text)}</span>
      ${bar(v, max)}
      <span class="vv">${fmt(v)}${total ? `<small>${pc(v / total)}</small>` : ''}${subOf ? `<small>${esc(subOf(r))}</small>` : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

/**
 * The coverage note that sits under every mix.
 *
 * Deliberately worded as a limit on the CHART rather than as a data-quality
 * complaint: the campaigns are named the way they are named, and the reader's
 * question is "how much of the money does this picture describe".
 */
function coverageNote(cov, dimension, extra) {
  if (!cov || !cov.total) return '';
  const bad = (cov.share || 0) < 0.6;
  return `<div class="tg-note" style="border-left:3px solid ${bad ? '#c98a2e' : 'var(--line)'}">
    <strong>This describes ${pc(cov.share)} of the spend.</strong>
    ${fmt(cov.named)} of ${fmt(cov.total)} EGP ran under a name that states a ${esc(dimension)};
    the other <strong>${fmt(cov.unnamed)}</strong> did not, and appears below as
    <em>not named</em> rather than being left out. A campaign called
    <em>New Sales Ad</em> states nothing, which is a naming habit rather than a fault
    in the data.${extra ? ` ${extra}` : ''}</div>`;
}

/* ------------------------------------------------------ 01 · paid delivery --- */

function renderPaid(D) {
  const P = D.paid;
  const C = D.campaigns;
  const days = P.days;
  const maxCost = days.reduce((a, d) => Math.max(a, d.cost), 0);

  let h = `<section>
    <div class="kicker">01 — Paid delivery</div>
    <h2 class="title">${fmt(P.spend)} EGP across ${fmt(P.daysWithData)} day${P.daysWithData === 1 ? '' : 's'}</h2>
    <p class="sub">${esc(D.from)} → ${esc(D.to)}. Meta ads only — organic Instagram is tab 04, and
      anything that arrived by phone or DM has no source connected at all (tab 05).</p>

    <div class="kpi-grid six">
      <div class="tg-s tot"><div class="l">Spend</div><div class="p">${fmt(P.spend)}</div>
        <div class="n">${fmt(P.spend / (P.daysWithData || 1))} a day</div></div>
      <div class="tg-s"><div class="l">Results</div><div class="p">${fmt(P.results)}</div>
        <div class="n">${fmt(P.msgConversations)} messaging contacts<br>${fmt(P.onFbLeads)} on-Facebook leads</div></div>
      <div class="tg-s"><div class="l">Cost per result</div><div class="p">${fmt(P.costPerResult)}</div>
        <div class="n">msg ${fmt(P.costPerMessage)} · lead ${fmt(P.costPerFbLead)}</div></div>
      <div class="tg-s"><div class="l">Impressions</div><div class="p">${fmt(P.impressions)}</div>
        <div class="n">CPM ${fmt(P.cpm, 2)}</div></div>
      <div class="tg-s"><div class="l">Clicks</div><div class="p">${fmt(P.clicks)}</div>
        <div class="n">CTR ${pc(P.ctr, 2)} · ${fmt(P.costPerClick, 2)} each</div></div>
      <div class="tg-s"><div class="l">Best day's reach</div><div class="p">${P.peakReach ? fmt(P.peakReach.reach) : '—'}</div>
        <div class="n">${P.peakReach ? `on ${esc(P.peakReach.date)}<br>one day, not the range` : 'no reach recorded'}</div></div>
    </div>`;

  /* The reach caveat, stated once and prominently, because it is the figure a
     reader is most likely to want summed and the one that must not be. */
  h += `<div class="tg-note"><strong>Reach is not added up anywhere on this report.</strong>
    It counts people, not impressions: anyone who saw an ad on Monday and again on Tuesday is
    one person, so summing the days would count them twice — and the longer the range, the
    more it overstates. Impressions above <em>are</em> a total, because an impression is an
    event. Where a range needs one reach number, the best single day is shown and labelled.</div>`;

  if (P.daysWithData < P.daysInRange) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${fmt(P.daysInRange - P.daysWithData)} of ${fmt(P.daysInRange)} days in this range have
      no rows in the cache.</strong> That is a gap in what has been synced, not a fortnight
      with no advertising — run <code>scripts/sync-meta.js</code> for the range to fill it.</div>`;
  }

  h += `<h3 class="subtitle">Spend by day</h3>
    <div class="dbars">${days.map((d) => `<div class="dbar" title="${esc(d.date)} · ${fmt(d.cost)} EGP · ${fmt(d.results)} results">
      <div class="dbar-t"><i style="height:${maxCost ? (d.cost / maxCost) * 100 : 0}%"></i></div>
      <div class="dbar-d">${esc(d.date.slice(8))}</div>
      <div class="dbar-w">${esc(new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))}</div>
    </div>`).join('')}</div>`;

  h += `<h3 class="subtitle">By ad account</h3>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Account</th><th>Entity</th><th class="n">Spend</th><th class="n">Share</th>
      <th class="n">Results</th><th class="n">Cost / result</th><th class="n">Impressions</th></tr></thead><tbody>
      ${P.accounts.map((a) => `<tr>
        <td><span class="nm">${esc(a.name)}</span><div class="sm2">${esc(a.accountId)}</div></td>
        <td>${a.entity ? esc(a.entity) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="n">${fmt(a.cost)}</td>
        <td class="n">${pc(P.spend ? a.cost / P.spend : 0)}</td>
        <td class="n">${fmt(a.results)}</td>
        <td class="n">${fmt(a.results ? a.cost / a.results : null)}</td>
        <td class="n">${fmt(a.impressions)}</td></tr>`).join('')}
    </tbody></table></div>`;

  h += `<h3 class="subtitle">By objective <span class="sm2">as Meta reports it, translated</span></h3>
    <p class="sub">Meta returns codes — <code>OUTCOME_LEADS</code>, not <em>Leads</em>. The mapping is
      verified: for every campaign that spent in the source pack's window, Meta's code and the
      pack's own label agree one for one.</p>
    ${blist(C.objectives, {
    valueOf: (r) => r.cost,
    labelOf: (r) => ({ text: r.name || 'not stated', muted: !r.name }),
    total: P.spend,
  })}`;

  h += `<h3 class="subtitle">Campaigns <span class="sm2">${fmt(C.campaigns.length)} that spent in this range</span></h3>
    <div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>Campaign</th><th>Objective</th><th>Doctor</th><th>Service</th><th>Branch</th>
      <th class="n">Spend</th><th class="n">Results</th><th class="n">Cost / result</th></tr></thead><tbody>
      ${C.campaigns.map((c) => `<tr>
        <td><span class="nm">${esc(c.name)}</span><div class="sm2">${esc(c.account || '')}</div></td>
        <td>${esc(c.objective || '—')}</td>
        ${['doctor', 'service', 'branch'].map((k) => `<td>${c[k] ? esc(c[k])
    : '<span style="color:var(--muted)">not named</span>'}</td>`).join('')}
        <td class="n">${fmt(c.cost)}</td>
        <td class="n">${fmt(c.results)}</td>
        <td class="n">${fmt(c.costPerResult)}</td></tr>`).join('')}
    </tbody></table></div>`;

  $('paid').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------ 02 · doctors & services --- */

function renderDoctors(D) {
  const Dc = D.doctors;
  const A = D.ads;
  const spendTotal = A.coverage.service.total;

  let h = `<section>
    <div class="kicker">02 — Doctors and services</div>
    <h2 class="title">What each doctor's advertising cost, beside what they billed</h2>
    <p class="sub">Spend comes from campaign names; revenue comes from Odoo, ex-VAT and ex-package,
      the same cut the Commercial Sales report uses. The two are joined on the doctor's name.</p>

    <div class="tg-note"><strong>The right-hand column is not ROAS and must not be read as it.</strong>
      Nothing here shows that this revenue came from these ads: it is revenue billed by a doctor
      whose name appears in campaign names, in the same window. A patient who walked in from a
      recommendation counts in it exactly the same. Treat it as scale — "this doctor bills a lot
      per pound advertised" — and not as attribution.</div>`;

  h += `<div class="tw"><table class="ltab"><thead><tr>
      <th>Doctor</th><th class="n">Ad spend</th><th class="n">Results</th><th class="n">Cost / result</th>
      <th class="n">Revenue ex-VAT</th><th class="n">Invoices</th><th class="n">Revenue per EGP spent</th></tr></thead><tbody>
    ${Dc.doctors.filter((d) => d.cost || (d.revenueEx || 0) > 0).slice(0, 40).map((d) => `<tr>
      <td><span class="nm">${esc(d.name)}</span>${d.state === 'spend-only'
    ? '<div class="sm2" style="color:#b0503c">advertised, but no invoices under this name</div>'
    : (d.state === 'revenue-only' ? '<div class="sm2" style="color:var(--muted)">billed, but no campaign names them</div>' : '')}</td>
      <td class="n">${fmt(d.cost)}</td>
      <td class="n">${fmt(d.results)}</td>
      <td class="n">${fmt(d.costPerResult)}</td>
      <td class="n">${fmt(d.revenueEx)}</td>
      <td class="n">${fmt(d.invoices)}</td>
      <td class="n">${d.revenuePerPound === null ? '—' : fmt(d.revenuePerPound, 1)}</td></tr>`).join('')}
    </tbody></table></div>`;

  const m = Dc.matched;
  h += `<div class="tg-note">
    <strong>${fmt(m.spendMatched)} of ${fmt(m.spendTotal)} EGP</strong> of doctor-named spend
    (${pc(m.spendTotal ? m.spendMatched / m.spendTotal : 0)}) reaches a doctor who also has invoices
    in Odoo for this range.
    ${m.spendOnly.length ? `<br><strong>Advertised with no matching invoices:</strong>
      ${m.spendOnly.map(esc).join(' · ')} — either the doctor bills under a different spelling in
      Odoo, or they genuinely invoiced nothing in this window. Worth resolving in Admin → names
      before anyone reads a cost-per-patient from it.` : ''}
    ${m.revenueOnly ? `<br>${fmt(m.revenueOnly)} other names billed revenue and appear in no
      campaign name at all, which is normal — most doctors are not advertised individually.` : ''}
  </div>`;

  h += `<h3 class="subtitle">Service mix <span class="sm2">at ad level, where the naming is richest</span></h3>
    ${coverageNote(A.coverage.service, 'service',
    `Of the named part, <strong>${fmt(A.coverage.service.inherited)}</strong> is named only because its
     parent campaign was — the ad's own name says nothing.`)}
    ${blist(A.services, {
    valueOf: (r) => r.cost,
    labelOf: (r) => ({ text: r.name || 'not named in any name', muted: !r.name }),
    total: spendTotal,
  })}`;

  h += `<h3 class="subtitle">Ads <span class="sm2">${fmt(A.ads.length)} in this range</span></h3>
    <p class="sub">An <em>inherited</em> tag means the label came from the parent campaign, not from
      the ad's own name. The ad called <code>offer</code> is Laser at Mall Of Arabia in one campaign
      and unlabelled at Alexandria in another, so the ad name alone genuinely cannot say.</p>
    <div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>Ad</th><th>Campaign</th><th>Service</th><th>Doctor</th>
      <th class="n">Spend</th><th class="n">Results</th><th class="n">Cost / result</th></tr></thead><tbody>
    ${A.ads.slice(0, 200).map((a) => `<tr>
      <td><span class="nm">${esc(a.name)}</span></td>
      <td><span class="sm2">${esc(a.campaign || '—')}</span></td>
      <td>${a.service ? `${esc(a.service)}${a.inherited.includes('service')
    ? ' <span class="sev open">inherited</span>' : ''}`
    : '<span style="color:var(--muted)">not named</span>'}</td>
      <td>${a.doctor ? `${esc(a.doctor)}${a.inherited.includes('doctor')
    ? ' <span class="sev open">inherited</span>' : ''}`
    : '<span style="color:var(--muted)">not named</span>'}</td>
      <td class="n">${fmt(a.cost)}</td>
      <td class="n">${fmt(a.results)}</td>
      <td class="n">${fmt(a.costPerResult)}</td></tr>`).join('')}
    </tbody></table></div>`;

  $('doc').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------ 03 · lead quality --- */

function renderLeads(D) {
  const L = D.leads;
  const P = D.paid;

  let h = `<section>
    <div class="kicker">03 — Lead quality</div>
    <h2 class="title">${fmt(L.leads)} Meta leads, and what became of them</h2>
    <p class="sub">Joined to Odoo on the normalised mobile number — the same ten-digit key the
      Commercial report uses to match a booking to a patient. No lead's name or phone number is
      stored anywhere in this app; only the key.</p>`;

  if (L.window.note) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>Part of this range has no lead data, and never will.</strong>
      ${esc(L.window.note)}</div>`;
  }

  const step = (label, value, note, absent) => `<div class="fstep${absent ? ' absent' : ''}">
    <div class="l">${esc(label)}</div><div class="v">${absent ? 'no source' : fmt(value)}</div>
    <div class="n">${note}</div></div>`;

  h += `<div class="fgrid">
    ${step('Leads', L.leads, `${esc(L.window.earliestHeld || '—')} → ${esc(L.window.latestHeld || '—')} held`)}
    ${step('With a usable mobile', L.withKey, `${pc(L.rates.usable)} of leads<br>${fmt(L.unmatchable)} cannot ever be matched`)}
    ${step('Reached a booking', L.booked, `${pc(L.rates.booked)} of leads`)}
    ${step('Attended', L.attended, `${pc(L.rates.attended)} of leads`)}
    ${step('Invoiced', L.invoiced, `${pc(L.rates.invoiced)} of leads<br>${fmt(L.revenueEx)} EGP ex-VAT`)}
    ${step('Organic / CTA leads', null, 'the 811-row sheet has never been imported<br><span class="why">no source connected</span>', true)}
  </div>`;

  h += `<div class="tg-note"><strong>What the ${pc(L.rates.booked)} booking rate does and does not mean.</strong>
    It counts leads whose mobile number also appears on an appointment — at any date, including
    one made before the lead arrived, because a returning patient who fills in a form is still
    the same phone number. It therefore <em>overstates</em> new business and understates nothing.
    ${fmt(L.unmatchable)} lead${L.unmatchable === 1 ? '' : 's'} could not be normalised to ten
    digits and are outside every figure here — that is the ceiling on what any matching can ever
    reach, so it is shown rather than quietly removed from the denominator.</div>`;

  if (P.results && L.leads) {
    h += `<div class="tg-note">Meta counted <strong>${fmt(P.results)} results</strong> for this range
      (${fmt(P.msgConversations)} messaging contacts + ${fmt(P.onFbLeads)} on-Facebook leads) while
      <strong>${fmt(L.leads)}</strong> lead rows exist. The two are not the same thing and should not
      match: a messaging contact never becomes a lead row, only form submissions do. Compare
      on-Facebook leads to lead rows — ${fmt(P.onFbLeads)} against ${fmt(L.leads)} — and the gap is
      the accounts whose lead rows Facebook refuses us (tab 05).</div>`;
  }

  h += `<div class="twocol">
    <div class="pcard">
      <div class="pcard-head"><h4>By doctor</h4><span class="hint">from the form's name</span></div>
      <div class="pcard-body">${blist(L.byDoctor, {
    valueOf: (r) => r.leads,
    labelOf: (r) => ({ text: r.name || 'form not named for a doctor', muted: !r.name }),
    total: L.leads,
  })}</div>
    </div>
    <div class="pcard">
      <div class="pcard-head"><h4>By form</h4><span class="hint">top 12</span></div>
      <div class="pcard-body">${blist(L.byForm.slice(0, 12), {
    valueOf: (r) => r.leads,
    labelOf: (r) => ({ text: r.name || 'unnamed form', muted: !r.name }),
    total: L.leads,
  })}</div>
    </div>
  </div>`;

  $('lead').innerHTML = `${h}</section>`;
}

/* ----------------------------------------------------------- 04 · social --- */

function renderSocial(D) {
  const S = D.social;

  let h = `<section>
    <div class="kicker">04 — Social</div>
    <h2 class="title">Organic Instagram</h2>
    <p class="sub">Unpaid reach on the clinic accounts. Nothing here is attributable to a booking —
      Instagram gives no way to follow a viewer into Odoo — so it is read as audience, not as
      pipeline.</p>`;

  if (!S.profiles.length) {
    h += '<div class="tg-note">No Instagram data in this range.</div>';
  }

  h += '<div class="tg-sum">';
  for (const p of S.profiles) {
    h += `<div class="tg-s"><div class="l">${esc(p.name)}</div>
      <div class="p">${fmt(p.followers)}</div>
      <div class="n">followers as at ${esc(p.followersAsAt || '—')}
        ${p.followersOutsideRange ? '<br><em>a snapshot from outside this range</em>' : ''}
        <br>${fmt(p.views)} views · peak reach ${fmt(p.peakReach.reach)}</div></div>`;
  }
  h += '</div>';

  /* The follower figure is the one most likely to be misread as a range
     movement, so the explanation sits directly beneath it. */
  h += `<div class="tg-note"><strong>The follower count is a snapshot, not a series.</strong>
    Instagram returns a profile's follower total only for the most recent day of a query — of the
    ${fmt(S.profiles.reduce((a, p) => a + p.days, 0))} profile-days in this range it answered on
    ${S.profiles.filter((p) => !p.followersOutsideRange).length || 'none'} of them. So there is no
    follower history to difference and <em>growth across a range cannot be computed from it</em>.
    Treating the days it declined to answer as zeros would show the clinic falling to nothing and
    recovering. What is real is the total above, dated, plus the daily gains below.</div>`;

  h += `<h3 class="subtitle">New followers a day</h3>
    <div class="fgrid">`;
  for (const p of S.profiles) {
    h += `<div class="fstep${p.newFollowersCovered ? '' : ' absent'}">
      <div class="l">${esc(p.name)}</div>
      <div class="v">${p.newFollowers ? fmt(p.newFollowers) : 'not served'}</div>
      <div class="n">${p.newFollowersCovered
    ? `across all ${esc(p.newFollowersDays.split('/')[1])} days`
    : `Instagram answered on <strong>${esc(p.newFollowersDays)}</strong> days only
       <br><span class="why">it serves this metric for the last 30 days and no further</span>`}</div></div>`;
  }
  h += '</div>';

  if (S.absentProfiles.length) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${S.absentProfiles.length} doctor profiles are connected but not readable:</strong>
      ${S.absentProfiles.map(esc).join(' · ')}. The licence has no prioritised-account slot for them —
      verified refused, not missing. One click each at
      <code>hub.supermetrics.com/subscriptions/1743532#datasource-IGI</code> and the per-doctor
      organic section fills itself in.</div>`;
  }

  h += `<h3 class="subtitle">Posts <span class="sm2">${fmt(S.postCount)} in this range, best first</span></h3>
    <div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>Posted</th><th>Profile</th><th>Format</th><th>Caption</th>
      <th class="n">Views</th><th class="n">Reach</th></tr></thead><tbody>
    ${S.posts.map((p) => `<tr>
      <td>${esc(p.postedAt.slice(0, 10))}</td>
      <td>${esc(p.profile)}</td>
      <td>${esc(p.format || '—')}</td>
      <td><span class="sm2">${esc(p.caption || '—')}</span></td>
      <td class="n">${fmt(p.views)}</td>
      <td class="n">${fmt(p.reach)}</td></tr>`).join('')}
    </tbody></table></div>`;

  $('soc').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------ 05 · what exists --- */

function renderExists(D) {
  const V = D.provenance;

  let h = `<section>
    <div class="kicker">05 — What exists</div>
    <h2 class="title">Where every number on this report came from</h2>
    <p class="sub">This tab is what keeps the other five honest. A figure whose provenance is
      invisible is a figure nobody can challenge, so each table below says what loaded it and
      when — and the second half names what is missing, why, and who can fix it.</p>

    <div class="tw"><table class="ltab"><thead><tr>
      <th>Table</th><th>Rows in range</th><th>Source</th><th>Last loaded</th></tr></thead><tbody>
    ${V.tables.map((t) => `<tr>
      <td><span class="nm">${esc(t.label)}</span>${t.note ? `<div class="sm2">${esc(t.note)}</div>` : ''}</td>
      <td class="n">${fmt(t.rows)}</td>
      <td>${t.sources.length ? t.sources.map((s) => `<span class="sev ${s.source === 'live' ? 'attended' : 'open'}">${esc(s.source)}${s.channel ? `/${esc(s.channel)}` : ''}</span> ${fmt(s.rows)}`).join('<br>')
    : '<span style="color:var(--muted)">nothing loaded</span>'}</td>
      <td><span class="sm2">${t.sources.length && t.sources[0].loadedAt ? esc(t.sources[0].loadedAt.replace('T', ' ').slice(0, 16)) : '—'}</span></td></tr>`).join('')}
    </tbody></table></div>

    <div class="tg-note"><strong>“live” means it came from Meta or Instagram through Supermetrics;
      “seed” means it was imported from a frozen HTML report pack and is not refreshing.</strong>
      Every row in the database carries which, plus the moment it was loaded, so a stale panel can
      be told apart from a quiet week.</div>`;

  h += `<h3 class="subtitle">What is missing, and what would fix it</h3>
    <p class="sub">Six absences, six different causes. None of them is a bug in this report and
      each needs a different action — which is why they are listed separately rather than as one
      "data unavailable" note.</p>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Missing</th><th>Why</th><th>What fixes it</th></tr></thead><tbody>
    ${V.absent.map((a) => `<tr>
      <td><span class="nm">${esc(a.what)}</span></td>
      <td><span class="sm2">${esc(a.why)}</span></td>
      <td><span class="sm2">${esc(a.fix)}</span></td></tr>`).join('')}
    </tbody></table></div>`;

  h += `<h3 class="subtitle">Load history</h3>`;
  if (!V.uploads.length) {
    h += '<div class="tg-note">Nothing recorded yet.</div>';
  } else {
    h += `<div class="tw scrolly" ${TALL}><table class="ltab tight"><thead><tr>
      <th>When</th><th>Kind</th><th>Range</th><th class="n">Rows</th><th>Notes</th><th>By</th></tr></thead><tbody>
    ${V.uploads.map((u) => `<tr>
      <td>${esc(u.at.replace('T', ' ').slice(0, 16))}</td>
      <td>${esc(u.kind)}</td>
      <td>${u.from ? `${esc(u.from)} → ${esc(u.to)}` : '—'}</td>
      <td class="n">${fmt(u.rows)}</td>
      <td><span class="sm2">${esc(u.notes || '')}</span></td>
      <td><span class="sm2">${esc(u.actor || '')}</span></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  $('exi').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------- 06 · build sheet --- */


/* ------------------------------------------------------------------ paint --- */

function paint() {
  const D = DATA;
  const P = D.paid, L = D.leads;
  $('hPeriod').textContent = ` · ${D.from} → ${D.to}`;
  $('hSpend').textContent = fmt(P.spend);
  $('hRes').textContent = fmt(P.results);
  $('hCpr').textContent = fmt(P.costPerResult);
  $('hConv').textContent = L.leads ? pc(L.rates.booked) : '—';
  $('rangeline').innerHTML = `<strong>${fmt(P.spend)}</strong> EGP spent
    · <strong>${fmt(P.results)}</strong> results (${fmt(P.msgConversations)} msg + ${fmt(P.onFbLeads)} leads)
    · <strong>${fmt(P.costPerResult)}</strong> per result
    · <strong>${fmt(D.campaigns.campaigns.length)}</strong> campaigns
    · <strong>${fmt(L.leads)}</strong> lead rows
    ${D.scope === 'all' ? '' : ` · <strong>${esc(D.scope)}</strong> only`}
    ${L.window.covered ? '' : ' · <span style="color:#b0503c">leads cover part of the range</span>'}`;

  renderPaid(D); renderDoctors(D); renderLeads(D); renderSocial(D); renderExists(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, scope: SCOPE });
    DATA = await api(`/api/marketing?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.paid.spend)} spent`;
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
/* Scope RELOADS rather than repainting: unlike the other reports, where the
   filter hides branch rows already in the payload, here it is an ad-account
   filter applied in SQL. */
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
