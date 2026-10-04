/* ============================================================
   Nouvelage daily sales — page.

   All figures arrive scored from /api/report; this file only draws them. The
   arithmetic lives in src/lib/rules.js on the server (and in public/rules.js
   here for the couple of client-side date helpers), so the page cannot compute
   a different answer from the API.
   ============================================================ */

/* From public/fmt.js — one copy of these for every page. They had drifted
   apart by 2026-10-04 (two `pc`, two `esc`); see that file. */
const { $, fmt, escAll: esc } = Fmt;
const pct = (a, b) => (!b ? 0 : (a / b) * 100);
const { iso } = Rules;

let DATA = null;

const prettyDate = (s) =>
  new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function setStatus(text, state) {
  $('status').textContent = text;
  $('dot').className = 'dot' + (state ? ' ' + state : '');
}

/* ---- 01 overview ---- */
function renderOverview(R, meta, C, X) {
  const single = meta.from === meta.to;
  const top = (arr) => (arr[0] || { name: '—', ex: 0 });
  const avg = R.totals.invoices ? R.totals.ex / R.totals.invoices : 0;
  /* What the report left out, when it left anything out. Present only when the
     payload was built with the exclusion AND the journal is known for every
     invoice in the range — an "ex-package" label over a window we cannot
     classify would be a claim rather than a fact. */
  const EXCL = R.totals.excluded && R.totals.excluded.known && R.totals.excluded.invoices
    ? R.totals.excluded : null;

  /* Net collections sits beside revenue because Mina asked for it there, and in
     the same brown, but the two are NOT the same measure: revenue is invoiced
     ex-VAT, collections are cash received inc-VAT.

     It is filtered to the selected range exactly like every other figure on this
     tab. That was true from the start and did not look it, because the imported
     snapshot stops on 10 August so 1-20 and 1-10 return the same number. The
     window it covered was only mentioned when it fell short. Now the card ALWAYS
     prints the days it counted, so widening or narrowing the range visibly moves
     it — and when the data runs out before the range does, that line says so
     instead of leaving the reader to assume a collections shortfall. */
  const hasColl = C && !C.error && C.net > 0;
  const shortRange = (a, b) => {
    const d = (x) => new Date(`${x}T00:00:00Z`);
    const day = (x) => d(x).getUTCDate();
    const mon = (x) => d(x).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    if (a === b) return `${day(a)} ${mon(a)}`;
    return mon(a) === mon(b) ? `${day(a)}–${day(b)} ${mon(b)}` : `${day(a)} ${mon(a)} – ${day(b)} ${mon(b)}`;
  };
  /* ONE card, not two: net collections is the headline and the revenue figures sit
     under it. Mina asked for exactly that shape.

     The two revenue lines are labelled "Revenue ex-VAT" and "Revenue inc-VAT" in
     full rather than a bare "Ex-VAT / Inc-VAT". Sharing a card with a collections
     headline already invites the reader to treat them as the same quantity, and
     they are not — one is cash banked, the other is what was invoiced. The labels
     are the only thing stopping that misreading.

     With no collections data the card falls back to being the original Revenue
     Ex-VAT card. Revenue is the primary number of the whole report and must never
     disappear because a different source is empty. */
  const headCard = hasColl
    ? `<div class="kpi accent coll">
        <div class="kpi-label">Net collections</div>
        <div class="kpi-value">${fmt(C.net)}<span class="kpi-unit">EGP</span></div>
        <div class="kpi-sub">
          <div class="cmeta">gross <strong>${fmt(C.gross)}</strong>${
      /* The branch count and the covered range came off at Mina's request: when
         collections reach the whole range they say nothing the reader needs, and
         the card is stronger without them. The SHORTFALL line stays, because
         that one is the opposite of noise — without it a card covering ten days
         of a twenty-five day range just looks like collections collapsed. */
      C.coversRange
        ? ''
        : `<br><span class="short">only ${C.days} of ${meta.rangeDays} days — no data after ${shortRange(C.lastDay, C.lastDay)}</span>`
    }</div>
          ${(() => {
      /* The revenue lines beside collections drop the package-sale journal, so
         the two sit on a comparable basis. They are LABELLED, because they
         deliberately disagree with the top bar and every other tab — those keep
         counting every posted invoice, which is what was actually invoiced.

         If the journal is not known for every invoice in the range (anything
         synced before the column existed), fall back to the full figures rather
         than quietly publishing a 7%-too-high "comparable" number. */
      const ok = X && !X.error && X.known;
      const ex = ok ? X.ex : R.totals.ex;
      const inc = ok ? X.inc : R.totals.inc;
      const note = ok && X.removedEx
        ? `<div class="kv sub"><span>excludes ${esc(X.journals.join(', '))}</span><b>−${fmt(X.removedEx)}</b></div>`
        : '';
      return `<div class="kv"><span>Revenue ex-VAT${ok ? '<i>excl. packages</i>' : ''}</span><b>${fmt(ex)}</b></div>
          <div class="kv"><span>Revenue inc-VAT${ok ? '<i>excl. packages</i>' : ''}</span><b>${fmt(inc)}</b></div>
          ${note}`;
    })()}
        </div></div>`
    : `<div class="kpi accent"><div class="kpi-label">Revenue Ex-VAT</div><div class="kpi-value">${fmt(R.totals.ex)}<span class="kpi-unit">EGP</span></div><div class="kpi-sub">Inc-VAT: <strong>${fmt(R.totals.inc)}</strong></div></div>`;

  let h = `<section>
    <div class="kicker">01 — At a glance</div>
    <h2 class="title">${single ? 'Day' : 'Period'} in numbers</h2>
    <p class="sub">Posted <code>out_invoice</code> from Odoo 18, invoice-dated ${single ? prettyDate(meta.from) : `${prettyDate(meta.from)} to ${prettyDate(meta.to)}`}. Branch, doctor, product and category cuts all reconcile to the same total.${
  EXCL ? ` <strong>Every figure on this report is ex-package</strong> — ${fmt(EXCL.invoices)} package
    invoice${EXCL.invoices === 1 ? '' : 's'} worth <strong>${fmt(EXCL.ex)}</strong> are excluded from
    every tab, every ranking and every total.` : ''
}</p>
    <div class="kpi-grid">
      ${headCard}
      <div class="kpi"><div class="kpi-label">Invoices</div><div class="kpi-value">${fmt(R.totals.invoices)}</div><div class="kpi-sub">${fmt(R.totals.lines)} lines · avg <strong>${fmt(avg)}</strong></div></div>
      <div class="kpi"><div class="kpi-label">Top Branch</div><div class="kpi-value sm">${esc(top(R.branches).name)}</div><div class="kpi-sub"><strong>${fmt(top(R.branches).ex)}</strong> · ${pct(top(R.branches).ex, R.totals.ex).toFixed(1)}%</div></div>
      <div class="kpi"><div class="kpi-label">Top Doctor</div><div class="kpi-value sm">${esc(top(R.doctors).name)}</div><div class="kpi-sub"><strong>${fmt(top(R.doctors).ex)}</strong> · ${pct(top(R.doctors).ex, R.totals.ex).toFixed(1)}%</div></div>
    </div>`;

  if (hasColl) {
    /* Now that all three figures share one card the note matters more, not less:
       the reader can see them stacked and the temptation to divide one by the
       other is right there. */
    const exOK = X && !X.error && X.known && X.removedEx;
    h += `<p class="sub" style="margin-top:-8px">In that first card, <strong>net collections</strong> is cash actually received — customer receipts less refunds, inc-VAT, posted to the branch and register on each voucher. The two <strong>revenue</strong> lines under it are what was <strong>invoiced</strong>${
      exOK ? `, on the same ex-package basis as the rest of the report — <strong>${esc(X.journals.join(', '))}</strong> is out of both, ${fmt(X.removedInvoices)} invoices worth ${fmt(X.removedEx)}, which carry no VAT and are invoiced when a package is sold rather than delivered` : ''
    }. Different measures on different bases, so one is not a percentage of the other.${
      C.coversRange ? '' : ` Collections cover <strong>${prettyDate(C.firstDay)} to ${prettyDate(C.lastDay)}</strong> — ${C.days} of the ${meta.rangeDays} days in this range — while the revenue lines cover all ${meta.rangeDays}.`
    }</p>`;
  }

  if (!single && R.days.length > 1) {
    const max = Math.max(...R.days.map((d) => d.ex));
    h += `<h3 class="subtitle">By day <span class="vat-tag">Ex-VAT</span></h3><div class="bar-list">`;
    for (const d of R.days) {
      h += `<div class="bar-row"><div class="bar-top"><div><div class="bar-name">${new Date(d.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</div><div class="bar-meta">${d.invoices} invoices · ${pct(d.ex, R.totals.ex).toFixed(1)}%</div></div><div class="bar-val">${fmt(d.ex)}<small>${fmt(d.inc)} inc</small></div></div><div class="bar-track"><div class="bar-fill" style="width:${pct(d.ex, max).toFixed(1)}%"></div></div></div>`;
    }
    h += `</div>`;
  }

  h += barList('Branch ranking', R.branches, R.totals.ex, (b) => `${b.invoices} invoices · ${b.doctors} doctors · ${pct(b.ex, R.totals.ex).toFixed(1)}%`);
  h += barList('Doctor ranking', R.doctors.slice(0, 20), R.totals.ex, (b) => `${b.invoices} invoices · ${pct(b.ex, R.totals.ex).toFixed(1)}%`);
  h += barList('Category mix', R.categories, R.totals.ex, (b) => `${fmt(b.qty, 1)} qty · ${b.lines} lines · ${pct(b.ex, R.totals.ex).toFixed(1)}%`);

  if (R.refundList.length) {
    h += `<h3 class="subtitle">Credit notes <span class="vat-tag">Ex-VAT</span></h3><div class="tw"><table class="ltab"><thead><tr><th>Document</th><th>Branch</th><th>Doctor</th><th class="n">Ex-VAT</th></tr></thead><tbody>`;
    for (const r of R.refundList) {
      h += `<tr><td><div class="nm">${esc(r.name)}</div><div class="sm2">${r.date} · ${esc(r.partner)}</div></td><td>${esc(r.branch)}</td><td>${esc(r.doctor)}</td><td class="n ret-tag">${fmt(r.ex)}</td></tr>`;
    }
    h += `</tbody></table></div>`;
  }

  h += `</section>`;
  $('overview').innerHTML = h;
}

function barList(title, rows, total, meta) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.ex)) || 1;
  let h = `<h3 class="subtitle">${title} <span class="vat-tag">Ex-VAT</span></h3><div class="bar-list">`;
  for (const r of rows) {
    h += `<div class="bar-row"><div class="bar-top"><div><div class="bar-name">${esc(r.name)}</div><div class="bar-meta">${meta(r)}</div></div><div class="bar-val">${fmt(r.ex)}<small>${fmt(r.inc)} inc</small></div></div><div class="bar-track"><div class="bar-fill" style="width:${pct(r.ex, max).toFixed(1)}%"></div></div></div>`;
  }
  return h + `</div>`;
}

/* ---- 02 drill-down: branch → doctors + products ---- */
function renderBranches(R) {
  let h = `<section>
    <div class="kicker">02 — Drill-down</div>
    <h2 class="title">Branch by branch</h2>
    <p class="sub">Every branch with its doctors and the products they invoiced. Tap a branch to open it.</p>
    <input class="searchbox" id="branchSearch" placeholder="Search branch, doctor or product…">`;

  for (const b of R.branches) {
    const docs = R.branchDoctors[b.name] || [];
    const prods = R.branchProducts[b.name] || [];
    h += `<div class="acc" data-acc><div class="acc-h"><span class="car">▸</span>
        <div><div class="acc-name">${esc(b.name)}</div><div class="acc-meta">${b.invoices} invoices · ${b.doctors} doctors · ${pct(b.ex, R.totals.ex).toFixed(1)}% of period</div></div>
        <div class="cv"><b>${fmt(b.ex)}</b><small>${fmt(b.inc)} inc-VAT</small></div></div>
      <div class="acc-b">
        ${miniTable('Doctors', ['Doctor', 'Invoices', 'Ex-VAT', 'Share'], docs.map((d) => [
          `<div class="nm">${esc(d.name)}</div>`, fmt(d.invoices), fmt(d.ex), pct(d.ex, b.ex).toFixed(1) + '%',
        ]))}
        ${miniTable('Products', ['Product', 'Qty', 'Ex-VAT', 'Share'], prods.slice(0, 40).map((p) => [
          `<div class="nm">${esc(p.name)}</div><div class="sm2">${p.lines} lines</div>`, fmt(p.qty, 1), fmt(p.ex), pct(p.ex, b.ex).toFixed(1) + '%',
        ]))}
      </div></div>`;
  }
  h += `</section>`;
  $('branches').innerHTML = h;
}

function miniTable(caption, heads, rows) {
  if (!rows.length) return '';
  let h = `<div style="padding:10px 14px 14px"><div class="kicker" style="margin-bottom:8px">${caption}</div><div class="tw"><table class="ltab"><thead><tr>` +
    heads.map((x, i) => `<th${i ? ' class="n"' : ''}>${x}</th>`).join('') + `</tr></thead><tbody>`;
  for (const r of rows) {
    h += '<tr>' + r.map((c, i) => `<td${i ? ' class="n"' : ''}>${c}</td>`).join('') + '</tr>';
  }
  return h + `</tbody></table></div></div>`;
}

/* ---- 03 doctors ---- */
function renderDoctors(R) {
  let h = `<section>
    <div class="kicker">03 — Doctors</div>
    <h2 class="title">Doctor performance</h2>
    <p class="sub">Ranked by ex-VAT revenue for the selected duration, with the product mix behind each number.</p>
    <input class="searchbox" id="docSearch" placeholder="Search doctor or product…">`;

  for (const d of R.doctors) {
    const prods = R.doctorProducts[d.name] || [];
    h += `<div class="acc" data-acc><div class="acc-h"><span class="car">▸</span>
        <div><div class="acc-name">${esc(d.name)}</div><div class="acc-meta">${d.invoices} invoices · ${esc((d.branches || []).join(', ')) || '—'} · ${pct(d.ex, R.totals.ex).toFixed(1)}% of period</div></div>
        <div class="cv"><b>${fmt(d.ex)}</b><small>${fmt(d.inc)} inc-VAT</small></div></div>
      <div class="acc-b">${miniTable('Products invoiced', ['Product', 'Qty', 'Ex-VAT', 'Share'], prods.slice(0, 60).map((p) => [
        `<div class="nm">${esc(p.name)}</div><div class="sm2">${p.lines} lines · ${p.invoices} invoices</div>`,
        fmt(p.qty, 1), fmt(p.ex), pct(p.ex, d.ex).toFixed(1) + '%',
      ]))}</div></div>`;
  }
  $('doctors').innerHTML = h + `</section>`;
}

/* ---- 05 products ---- */

/**
 * Doctors per product — the Doctors tab's rollup, read the other way round.
 *
 * INVERTED FROM `doctorProducts` RATHER THAN QUERIED SEPARATELY, and that is
 * the point: the Doctors tab expands a doctor into their products from exactly
 * this object, so reading it backwards means the two tabs cannot disagree about
 * who invoiced what. A second SQL rollup would be a second definition, and the
 * first time a filter changed on one side only, one tab would quietly say
 * something the other contradicts.
 *
 * It also costs nothing: the payload already carries it, so opening a product
 * is a lookup rather than a request.
 */
function doctorsByProduct(R) {
  const out = new Map();
  for (const [doctor, prods] of Object.entries(R.doctorProducts || {})) {
    for (const p of prods) {
      if (!out.has(p.name)) out.set(p.name, []);
      out.get(p.name).push({ doctor, ...p });
    }
  }
  /* Biggest contributor first, like every other ranking on this report. */
  for (const list of out.values()) list.sort((a, b) => b.ex - a.ex);
  return out;
}

function renderProducts(R) {
  const byProduct = doctorsByProduct(R);

  let h = `<section>
    <div class="kicker">05 — Products</div>
    <h2 class="title">Product &amp; category mix</h2>
    <p class="sub">${R.products.length} SKUs invoiced across ${R.categories.length} categories in this duration.
      Click a product to see which doctors invoiced it.</p>
    <input class="searchbox" id="prodSearch" placeholder="Search product or category…">`;

  for (const p of R.products) {
    const docs = byProduct.get(p.name) || [];
    /* The doctor rows come from the same line-level grouping as the product
       total, so they add up to it exactly — measured across all 115 products in
       the range, every one reconciles, and an invoice with no specialist is not
       a gap either: it appears as a doctor row named "Unassigned".

       The remainder row below therefore never fires today. It stays because the
       two rollups are only guaranteed to agree while they share a definition,
       and if one ever stops, the difference belongs on the screen rather than
       hidden between a header figure and the table under it. */
    const named = docs.reduce((s, d) => s + d.ex, 0);
    const gap = Math.round((p.ex - named) * 100) / 100;

    const rows = docs.slice(0, 60).map((d) => [
      `<div class="nm">${esc(d.doctor)}</div><div class="sm2">${d.lines} lines · ${d.invoices} invoices</div>`,
      fmt(d.qty, 1), fmt(d.ex), pct(d.ex, p.ex).toFixed(1) + '%',
    ]);
    if (Math.abs(gap) > 0.01) {
      rows.push([
        '<div class="nm" style="color:var(--muted)">not attributed to a doctor</div>'
        + '<div class="sm2">the invoice header carries no specialist</div>',
        '—', fmt(gap), pct(gap, p.ex).toFixed(1) + '%',
      ]);
    }

    h += `<div class="acc" data-acc><div class="acc-h"><span class="car">▸</span>
        <div><div class="acc-name">${esc(p.name)}</div>
          <div class="acc-meta">${esc(p.category)} · ${fmt(p.qty, 1)}${p.uom ? ` ${esc(p.uom)}` : ''}
            · ${p.lines} lines · ${p.invoices} invoices · ${pct(p.ex, R.totals.ex).toFixed(1)}% of period</div></div>
        <div class="cv"><b>${fmt(p.ex)}</b><small>${fmt(p.inc)} inc-VAT</small></div></div>
      <div class="acc-b">${rows.length
    ? miniTable(`Doctors who invoiced it · ${docs.length}`, ['Doctor', 'Qty', 'Ex-VAT', 'Share'], rows)
    : '<div style="padding:12px 14px" class="sm2">No doctor rows for this product in this range.</div>'
}</div></div>`;
  }

  h += barList('Categories', R.categories, R.totals.ex, (c) => `${fmt(c.qty, 1)} qty · ${c.lines} lines · ${pct(c.ex, R.totals.ex).toFixed(1)}%`);
  $('products').innerHTML = h + `</section>`;
}

/* ---- 06 stock ---- */
function renderStock(json) {
  const stock = json.stock;
  if (!stock) {
    $('stock').innerHTML = `<section><div class="kicker">06 — Stock</div><h2 class="title">Stock on hand</h2><p class="sub">Stock was not requested. Tick <strong>Include stock on hand</strong> in the Connection drawer and fetch again.</p></section>`;
    return;
  }
  if (stock.error) {
    $('stock').innerHTML = `<section><div class="kicker">06 — Stock</div><h2 class="title">Stock on hand</h2><p class="sub">Could not read <code>stock.quant</code>: ${esc(stock.error)}</p></section>`;
    return;
  }

  const rows = stock.rows || [];
  const cut = stock.truncated || {};
  const soldIds = new Set(json.report.products.map((p) => p.productId).filter(Boolean));
  const totQty = rows.reduce((s, r) => s + r.qty, 0);
  const low = rows.filter((r) => r.qty > 0 && r.qty <= 10).length;
  const soldToday = rows.filter((r) => soldIds.has(r.productId)).length;

  let h = `<section>
    <div class="kicker">06 — Stock by product</div>
    <h2 class="title">Stock on hand · Odoo 18</h2>
    <p class="sub">${rows.length} SKUs · ${fmt(totQty, 1)} total quantity in internal locations, in each product's saved unit of measure. Tap a product for its location breakdown.</p>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">SKUs</div><div class="kpi-value">${fmt(rows.length)}</div><div class="kpi-sub"><strong>${fmt(totQty, 0)}</strong> total qty</div></div>
      <div class="kpi"><div class="kpi-label">Low stock</div><div class="kpi-value">${fmt(low)}</div><div class="kpi-sub">1–10 total qty</div></div>
      <div class="kpi"><div class="kpi-label">Moved in range</div><div class="kpi-value">${fmt(soldToday)}</div><div class="kpi-sub">of these SKUs invoiced</div></div>
      <div class="kpi"><div class="kpi-label">Reserved</div><div class="kpi-value">${fmt(rows.reduce((s, r) => s + r.reserved, 0), 0)}</div><div class="kpi-sub">across all SKUs</div></div>
    </div>
    ${cut.hitScanLimit || cut.droppedFromDetail
      ? `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>Partial view.</strong> ${cut.hitScanLimit ? `The scan stopped at the ${fmt(cut.scanned)} largest SKUs — smaller ones are not counted above. ` : ''}${cut.droppedFromDetail ? `${fmt(cut.droppedFromDetail)} scanned SKUs are omitted below; only those sold in this range plus the largest ${fmt(cut.shown)} get a location breakdown.` : ''}</div>`
      : ''}
    <input class="searchbox" id="stockSearch" placeholder="Search product or category…">`;

  for (const r of rows) {
    h += `<div class="acc" data-acc><div class="acc-h"><span class="car">▸</span>
      <div><div class="acc-name">${esc(r.name)}</div><div class="acc-meta">${esc(r.category)}${soldIds.has(r.productId) ? ' · <span class="pill">sold in range</span>' : ''}</div></div>
      <div class="cv"><b>${fmt(r.qty, 1)}</b><small>${esc(r.uom || '')} · ${r.locations.length} locations</small></div></div>
      <div class="acc-b">${miniTable('Stock by location', ['Location', 'Qty'], r.locations.map((l) => [esc(l.name), fmt(l.qty, 1)]))}</div></div>`;
  }
  $('stock').innerHTML = h + `</section>`;
}


/* ---- 04 targets — everything here is already scored by the server ---- */

/* ---- sorting tab 04's doctor table ----

   The server already sorts each group by MTD descending. This is the reader's
   own ordering on top of it, applied in the browser so it is instant and needs
   no round trip.

   Two things worth knowing about the shape:

   · Sorting happens WITHIN each group by default, because the group totals are
     authoritative — the whole sheet has to keep cross-footing, and reordering
     across groups would leave the INJECTABLES header sitting above a Laser
     doctor. "One flat list" is the deliberate escape hatch for the question that
     spans groups: who has the biggest target of anyone.

   · A doctor published at 0 has no target to measure. They sort LAST on every
     percentage key rather than first, because 0-of-0 is not an achievement of
     0% — it is the absence of a target, and floating them to the top of "who is
     behind" would bury the doctors who really are. */
/* The sort options, the ordering and the whole "Target vs achieved" section
   now live in `public/target-view.js`, because tab 01 of the Targets & Doctor
   Commission report has to be the same section — not a second table that
   agrees with this one until somebody edits one of them. This page still owns
   where it goes and what follows it. */

function renderTargets(T, K) {
  /* The commission card goes INSIDE the section, which is where it has always
     been — passed in rather than appended after, so the markup is unchanged. */
  const h = TargetView.html(T, {
    kicker: '04 — Targets', Rules, append: (!T || T.missing) ? '' : renderCommission(K),
  });
  if (!T || T.missing) { $('targets').innerHTML = h; return; }

  $('targets').innerHTML = h;

  TargetView.wire(() => renderTargets(T, K), document);
}

/* ---- the branch side of tab 04, from Commission Policy 2026 v2.7 ----

   This replaced the old two-slab "Target 1 / Target 2" table. The policy has one
   target per branch per month, an owning entity, an area, achievement bands and a
   14-tier pool ladder, so a two-column view could not express it.

   Read-only here by design: the sales report is where you look, /admin is where
   you change. Every number below is computed at read time from the stored target
   and the stored bands, so editing either shows up on the next refresh. */
function renderCommission(K) {
  if (!K) return '';
  if (K.error) {
    return `<h3 class="subtitle">Branch targets — Commission Policy</h3>
      <div class="tg-note" style="border-left:3px solid #b0503c">The commission targets could not be read: ${esc(K.error)}</div>`;
  }
  if (!K.branches || !K.branches.length) {
    return `<h3 class="subtitle">Branch targets — Commission Policy</h3>
      <p class="sub">No commission targets are loaded. Import the policy workbook with
      <code>node scripts/import-commission-xlsx.js &lt;file.xlsx&gt; --write</code>.</p>`;
  }

  const pc = (v) => `${(v * 100).toFixed(1)}%`;
  const partial = K.partial;

  /* The band a branch is IN right now against the full-month target, versus the
     band it is TRACKING to. Mid-month the second is the honest one, and leading
     with the first would show every branch failing until about the 25th. */
  let h = `<h3 class="subtitle">Branch targets — Commission Policy ${esc(K.policy.version || '')}</h3>
    <div class="tg-note" style="border-left:3px solid ${K.base === 'net_collection_ex_vat' ? '#5e8d4a' : '#c98a2e'}">
      <strong>${K.base === 'net_collection_ex_vat' ? 'Net Collection ex-VAT' : 'Measured on invoiced ex-VAT, not the policy base'}</strong>
      — ${esc(K.baseNote)}
    </div>
    <div class="tg-sum">
      <div class="tg-s inj"><div class="l">${partial ? 'Group vs pro-rata target' : 'Group vs monthly target'}</div>
        <div class="p">${pc(partial ? K.paceGroupAchievement : K.groupAchievement)}</div>
        <div class="n">${fmt(K.actualTotal)}<br>of ${fmt(partial ? K.proRataTotal : K.targetTotal)}</div>
        <div class="b"><i style="width:${Math.min(100, (partial ? K.paceGroupAchievement : K.groupAchievement) * 100).toFixed(1)}%"></i><u style="left:100%"></u></div></div>
      <div class="tg-s las"><div class="l">Branches at or above the ${pc(K.policy.bands.floor)} floor</div>
        <div class="p">${partial ? K.paceHits : K.hits} <span style="font-size:13px;color:var(--muted)">of ${K.branches.length}</span></div>
        <div class="n">${partial ? 'on pace' : 'on the closed month'}<br>below the floor pays nothing</div></div>
      <div class="tg-s tot"><div class="l">${partial ? `Day ${K.dayNo} of ${K.daysInPeriod}` : 'Month complete'}</div>
        <div class="p">${partial ? pc(K.paceShare) : '100%'}</div>
        <div class="n">${K.monthName} ${K.year} · full-month target<br>${fmt(K.targetTotal)}</div></div>
    </div>`;

  if (partial) {
    h += `<div class="tg-note"><strong>${K.monthName} is still open.</strong> The bands the policy actually pays on are
      measured against the <em>full</em> monthly target at month end — on day ${K.dayNo} of ${K.daysInPeriod} that reads
      ${K.hits} of ${K.branches.length} above the floor. <strong>Tracking to</strong> below is the band each branch reaches
      if the rest of the month runs at the same daily rate.</div>`;
  }

  const overrides = K.branches.filter((b) => b.override).length;
  if (overrides) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e"><strong>${overrides} branch${overrides === 1 ? '' : 'es'} ${overrides === 1 ? 'is' : 'are'} not on the policy bands this month</strong>
      — marked <span class="pill">override</span> below. The policy default is ${pc(K.policy.bands.floor)} / ${pc(K.policy.bands.mid)} / ${pc(K.policy.bands.max)}.</div>`;
  }
  if (K.unmatched && K.unmatched.length) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c"><strong>${K.unmatched.length} branch${K.unmatched.length === 1 ? '' : 'es'} on the policy with no invoices in Odoo</strong>
      — ${K.unmatched.map(esc).join(' · ')}. If one of them did invoice, the policy spells its name differently from Odoo and needs an alias in /admin.</div>`;
  }

  h += `<div class="tw"><table class="ltab"><thead><tr>
      <th>Branch</th><th>Owner</th><th class="n">Monthly target</th>
      <th class="n">${partial ? 'vs pro-rata' : 'Achievement'}</th>
      <th class="n">${partial ? 'Tracking to' : 'Band'}</th>
      <th class="n">Tier${partial ? ' (projected)' : ''}</th><th class="n">Pool ${partial ? '(projected)' : ''}</th></tr></thead><tbody>`;

  const byEntity = {};
  for (const b of K.branches) (byEntity[b.entity] ||= []).push(b);

  for (const [entity, rows] of Object.entries(byEntity)) {
    const tt = rows.reduce((s, b) => s + (b.target || 0), 0);
    const aa = rows.reduce((s, b) => s + b.net, 0);
    h += `<tr style="background:var(--cream)"><td colspan="7" style="padding:9px 12px">
      <strong style="color:var(--espresso);font-size:11px;letter-spacing:.1em;text-transform:uppercase">${esc(entity)}</strong>
      <span style="font-size:11px;color:var(--muted)"> · ${rows.length} branch${rows.length === 1 ? '' : 'es'} · target ${fmt(tt)} · ${fmt(aa)} (${pc(tt ? aa / tt : 0)})</span></td></tr>`;

    for (const b of rows) {
      /* Mid-month every displayed figure comes from the projected month, so the
         band, the tier and the pool on one row cannot contradict each other. */
      const P = partial && b.projected ? b.projected : null;
      const shownBand = P ? P.band : b.band;
      const shownTone = partial ? b.paceTone : b.tone;
      const ach = partial ? b.paceAchievement : b.achievement;
      const against = partial ? b.proRataTarget : b.target;
      const tierNo = P ? P.tierNo : b.tierNo;
      const tierLabel = P ? P.tierLabel : b.tierLabel;
      const pool = P ? P.pool : b.pool;
      const pools = P ? P.pools : b.pools;
      h += `<tr><td><div class="nm">${esc(b.name)}${b.via ? ` <span class="pill" title="Resolved through an alias">→ ${esc(b.via)}</span>` : ''}${b.override ? ' <span class="pill" style="background:rgba(201,138,46,.14);color:#c98a2e" title="This branch-month does not use the policy bands">override</span>' : ''}${!b.matched ? ' <span class="pill" style="background:rgba(176,80,60,.14);color:#b0503c">no invoices</span>' : ''}</div>
          <div class="sm2">${esc(b.area)}${b.journalCode ? ` · ${esc(b.journalCode)}` : ' · <span title="Not named in the policy source — confirm in Odoo">journal unknown</span>'} · ${fmt(b.invoices)} inv</div></td>
        <td class="nm" style="font-size:12px">${esc(b.entity)}</td>
        <td class="n tcell"><b>${fmt(b.target)}</b><small>${partial ? `${fmt(b.proRataTarget)} by day ${K.dayNo}` : `${pc(b.bands.floor)} floor = ${fmt(b.target * b.bands.floor)}`}</small></td>
        <td class="n tcell"><b class="${shownTone}">${pc(ach)}</b><small>${fmt(b.net)} / ${fmt(against)}</small>
          <div class="trk"><i style="width:${Math.min(100, ach * 100).toFixed(1)}%"></i><u style="left:${Math.min(100, b.bands.floor * 100).toFixed(1)}%"></u></div></td>
        <td class="n tcell"><b class="${shownTone}">${shownBand === 'zero' ? '—' : esc(shownBand.toUpperCase())}</b><small>${shownBand === 'zero' ? 'below the floor' : `${pc(b.bands[shownBand === 'max' ? 'max' : shownBand === 'mid' ? 'mid' : 'floor'])} band`}</small></td>
        <td class="n tcell"><b>${tierNo ? tierNo : '—'}</b><small>${esc(tierLabel || 'under tier 1')}${P ? ` · on ${fmt(P.net)}` : ''}</small></td>
        <td class="n tcell"><b class="${pool ? '' : 'r'}">${pool ? fmt(pool) : '0'}</b><small>${pool ? `min ${fmt(pools.min)} · mid ${fmt(pools.mid)} · max ${fmt(pools.max)}` : 'below the floor — no pool'}</small></td></tr>`;
    }
  }
  h += `</tbody></table></div>`;

  /* The gates. These are the part people get wrong: a branch can pay its team
     well and its Area Manager still earns nothing. */
  if (K.areas && K.areas.length) {
    h += `<h3 class="subtitle">Management gates</h3>
      <p class="sub">A gate that fails pays <strong>zero</strong>, however well an individual branch did.
        ${K.gateBasis === 'projected'
    ? `Evaluated on the <strong>projected</strong> month — on day ${K.dayNo} of ${K.daysInPeriod} no branch has reached a full-month target yet, so judging the gates on today's total would just report "failed" everywhere.`
    : 'Evaluated on the closed month — these are the real figures.'}</p>
      <div class="tw"><table class="ltab"><thead><tr><th>Area</th><th>Branches</th><th class="n">At the floor</th><th class="n">Combined pools</th><th class="n">Gate</th><th class="n">Earns</th></tr></thead><tbody>`;
    for (const a of K.areas) {
      h += `<tr><td class="nm">${esc(a.area)}</td>
        <td style="font-size:11.5px;color:var(--muted)">${a.branches.map(esc).join(' · ')}</td>
        <td class="n tcell"><b class="${a.passed ? 'g' : 'r'}">${a.hits} of ${a.of}</b><small>needs 2</small></td>
        <td class="n">${fmt(a.poolSum)}</td>
        <td class="n"><span class="pill" style="background:${a.passed ? 'rgba(94,141,74,.14)' : 'rgba(176,80,60,.14)'};color:${a.passed ? '#5e8d4a' : '#b0503c'}">${a.passed ? 'passed' : 'failed'}</span></td>
        <td class="n tcell"><b class="${a.passed ? 'g' : 'r'}">${fmt(a.amount)}</b><small>8% of pools</small></td></tr>`;
    }
    if (K.director) {
      const d = K.director;
      h += `<tr><td class="nm">Sales Director</td>
        <td style="font-size:11.5px;color:var(--muted)">all ${d.of} branches</td>
        <td class="n tcell"><b class="${d.byCount ? 'g' : 'r'}">${d.hits} of ${d.of}</b><small>needs 6</small></td>
        <td class="n">${fmt(d.poolSum)}</td>
        <td class="n"><span class="pill" style="background:${d.passed ? 'rgba(94,141,74,.14)' : 'rgba(176,80,60,.14)'};color:${d.passed ? '#5e8d4a' : '#b0503c'}">${d.passed ? 'passed' : 'failed'}</span>
          <div class="sm2" style="text-align:right">${d.byCount ? 'on branch count' : d.byGroup ? `on group ${pc(d.groupAchieved)}` : `group ${pc(d.groupAchieved)}, needs 85%`}</div></td>
        <td class="n tcell"><b class="${d.passed ? 'g' : 'r'}">${fmt(d.amount)}</b><small>5% of pools</small></td></tr>`;
    }
    h += `</tbody></table></div>`;
  }

  h += `<p class="sub" style="margin-top:14px">Targets, the ${pc(K.policy.bands.floor)} / ${pc(K.policy.bands.mid)} / ${pc(K.policy.bands.max)} bands, the departments,
    the branches and their owning entity are all editable in <a href="/admin" style="color:var(--espresso)">/admin → Commission</a>.
    Nothing on this tab is stored — every figure is recomputed from the target and the bands as they stand right now.</p>`;
  return h;
}

/* ---- 07 data quality — what the original report wrote out by hand ---- */

function renderData(json) {
  const R = json.report, T = json.targets, m = json.meta;
  const unbranded = R.branches.find((b) => b.name === 'Unassigned');
  const noDoctor = R.doctors.find((d) => d.name === 'Unassigned');
  const big = R.days.length > 1
    ? R.days.filter((d) => d.ex > 3 * (R.totals.ex / R.days.length)) : [];

  const card = (label, value, sub) =>
    `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value sm">${value}</div><div class="kpi-sub">${sub}</div></div>`;

  let h = `<section>
    <div class="kicker">07 — Data quality</div>
    <h2 class="title">What to check in Odoo</h2>
    <p class="sub">Facts about the source data, surfaced rather than left in a footnote.</p>
    <div class="kpi-grid">
      ${card('Invoices with no branch', unbranded ? fmt(unbranded.invoices) : '0',
             unbranded ? `<strong>${fmt(unbranded.ex)}</strong> · ${pct(unbranded.ex, R.totals.ex).toFixed(1)}% of the range` : 'all assigned')}
      ${card('Invoices with no doctor', noDoctor ? fmt(noDoctor.invoices) : '0',
             noDoctor ? `<strong>${fmt(noDoctor.ex)}</strong>` : 'all assigned')}
      ${card('Duplicate doctor records', T && T.duplicates ? fmt(T.duplicates.length) : '—',
             T && T.duplicates && T.duplicates.length ? T.duplicates.map((d) => esc(d.join(' + '))).join('<br>') : 'none found')}
      ${card('Credit notes', fmt(R.totals.refunds.count), `<strong>${fmt(R.totals.refunds.ex)}</strong> ex-VAT`)}
    </div>`;

  if (big.length) {
    h += `<h3 class="subtitle">Days far above the norm</h3>
      <p class="sub">More than three times the average day in this range — usually a data-entry mistake rather than a record day.</p>
      <div class="tw"><table class="ltab"><thead><tr><th>Day</th><th class="n">Invoices</th><th class="n">Ex-VAT</th><th class="n">× average</th></tr></thead><tbody>${
        big.map((d) => `<tr><td class="nm">${d.date}</td><td class="n">${fmt(d.invoices)}</td><td class="n">${fmt(d.ex)}</td><td class="n">${(d.ex / (R.totals.ex / R.days.length)).toFixed(1)}×</td></tr>`).join('')
      }</tbody></table></div>`;
  }

  if (json.settling && json.settling.length) {
    h += `<h3 class="subtitle">Days that moved after the first pull</h3>
      <p class="sub">Invoices get posted late and un-posted after the fact, so a day is not final when you first look at it.</p>
      <div class="tw"><table class="ltab"><thead><tr><th>Day</th><th class="n">First pull</th><th class="n">Latest</th><th class="n">Moved by</th></tr></thead><tbody>${
        json.settling.map((s) => `<tr><td class="nm">${s.date}</td><td class="n">${fmt(s.first.invoices)} · ${fmt(s.first.ex)}</td><td class="n">${fmt(s.latest.invoices)} · ${fmt(s.latest.ex)}</td><td class="n ${s.movedBy < 0 ? 'ret-tag' : ''}">${s.movedBy >= 0 ? '+' : ''}${fmt(s.movedBy)} · ${s.invoiceDelta >= 0 ? '+' : ''}${s.invoiceDelta} inv</td></tr>`).join('')
      }</tbody></table></div>`;
  }

  h += `<h3 class="subtitle">Cache</h3><div class="tw"><table class="ltab"><tbody>
    <tr><td class="nm">Holds</td><td>${m.coverage ? `${m.coverage.from} → ${m.coverage.to} · ${fmt(m.coverage.invoices)} invoices` : 'nothing yet'}</td></tr>
    <tr><td class="nm">Last sync</td><td>${m.lastSyncAt ? new Date(m.lastSyncAt).toLocaleString('en-GB') : 'never'}</td></tr>
    <tr><td class="nm">Signed in as</td><td>${esc(m.user.name || m.user.subject)}</td></tr>
    </tbody></table></div>`;

  $('data').innerHTML = h + `</section>`;
}

/* ------------------------------------------------------------ wiring --- */

function render(json) {
  DATA = json;
  const { report: R, meta } = json;
  const single = meta.from === meta.to;

  $('hPeriod').textContent = single ? prettyDate(meta.from) : `${prettyDate(meta.from)} → ${prettyDate(meta.to)}`;
  $('hSub').textContent = `Posted out_invoice · cached from the Nouvelage Odoo MCP · last synced ${meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('en-GB') : 'never'}`;
  /* The hero says ex-package on the two revenue cards. It is the most-read
     number on the app and it changed basis — an unlabelled figure that quietly
     dropped 7% would be read as a bad month. */
  const exPkg = R.totals.excluded && R.totals.excluded.known && R.totals.excluded.invoices;
  $('hEx').innerHTML = `${fmt(R.totals.ex)}<small>EGP${exPkg ? ' · ex-package' : ''}</small>`;
  $('hInc').innerHTML = `${fmt(R.totals.inc)}<small>EGP${exPkg ? ' · ex-package' : ''}</small>`;
  $('hLines').innerHTML = `${fmt(R.totals.lines)}<small>${fmt(R.totals.invoices)} invoices</small>`;
  $('hCov').innerHTML = `${R.branches.length} · ${R.doctors.length}<small>branches · doctors</small>`;

  /* How old is what you are looking at? Minutes matter when someone is
     watching the day fill up. */
  const ageMin = meta.lastSyncAt ? Math.round((Date.now() - Date.parse(meta.lastSyncAt)) / 60000) : null;
  const ageText = ageMin === null ? 'never synced'
    : ageMin < 1 ? 'synced just now'
      : ageMin < 60 ? `synced ${ageMin} min ago`
        : ageMin < 1440 ? `synced ${Math.round(ageMin / 60)} h ago`
          : `synced ${Math.round(ageMin / 1440)} d ago`;
  const stale = ageMin === null || ageMin > 90;
  $('dot').className = 'dot ' + (stale ? '' : 'ok');
  $('status').textContent = ageText;
  $('status').title = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('en-GB') : '';

  $('rangeline').innerHTML =
    `<span${stale ? ' class="ret-tag"' : ''}><strong>${ageText}</strong>${stale ? ' — press Refresh for the current figures' : ''}</span>` +
    `<span><strong>${single ? prettyDate(meta.from) : `${meta.from} → ${meta.to}`}</strong>${single ? '' : ` · ${R.days.length} day${R.days.length === 1 ? '' : 's'} with sales`}</span>` +
    `<span>Ex-VAT <strong>${fmt(R.totals.ex)}</strong> · Inc-VAT <strong>${fmt(R.totals.inc)}</strong>${
      exPkg ? ' · <strong>ex-package</strong>' : ''}</span>` +
    `<span><strong>${fmt(R.totals.invoices)}</strong> invoices · <strong>${fmt(R.totals.lines)}</strong> lines</span>` +
    (R.totals.refunds.count ? `<span class="ret-tag"><strong>${R.totals.refunds.count}</strong> credit notes · ${fmt(R.totals.refunds.ex)}</span>` : '');

  renderOverview(R, meta, json.collections, json.revenueExJournals);
  renderBranches(R);
  renderDoctors(R);
  renderTargets(json.targets, json.commission);
  renderProducts(R);
  renderStock(json);
  renderData(json);
}

async function load({ stock = false } = {}) {
  $('err').textContent = '';
  setStatus('Loading…', 'busy');
  $('load').disabled = true;
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, stock: stock ? '1' : '0' });
    const res = await fetch(`/api/report?${q}`, { headers: { Accept: 'application/json' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    render(json); // render() sets the status line to the data's age
  } catch (e) {
    setStatus('Failed', '');
    $('err').textContent = e.message;
  } finally {
    $('load').disabled = false;
  }
}

/* The Refresh button that lived here is now `Sync now` in the shared control
   bar — one copy for all eleven reports, in public/cbar.js. This page asked for
   `stock: true` with its re-read, which the bar carries as `data-sync-stock` on
   the `.cbar` element rather than as a second button only NRS has. */

/* Next month's target sheet, as a file to fill in. Fetched rather than linked:
   a plain <a download> would send the session cookie on a top-level GET from any
   site (it is SameSite=Lax), and an error would arrive as a corrupt .xlsx
   instead of a message. */
async function exportTemplate() {
  const T = DATA && DATA.targets;
  if (!T || T.missing) {
    $('err').textContent = 'There is no target sheet for this month to build next month from.';
    return;
  }
  $('err').textContent = '';
  $('export').disabled = true;
  try {
    const res = await fetch(`/api/targets/${T.period}/next-month.xlsx?to=${encodeURIComponent(DATA.meta.to)}`,
      { headers: { 'X-Requested-With': 'fetch' } });
    if (res.status === 401) { location.href = '/auth/login'; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    const named = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const href = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href, download: named ? named[1] : 'targets.xlsx' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  } catch (e) {
    $('err').textContent = e.message;
  } finally {
    $('export').disabled = false;
  }
}

/* ---- importing a filled-in target sheet ---------------------------------- */

/** Fetch JSON with the headers every write on this app requires. */
async function apiJson(url, opts = {}) {
  const headers = { 'X-Requested-With': 'fetch', Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('Signed out.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(json.error || `HTTP ${res.status}`);
    e.problems = json.problems;
    e.needsPassphrase = json.needsPassphrase;
    throw e;
  }
  return json;
}

const dlg = {
  open(title, bodyHtml, actions) {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = bodyHtml;
    $('dlgActions').innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      // Explicit, so the primary action cannot fall through to ghost.
      b.className = a.kind === 'primary' ? 'btn' : a.kind === 'danger' ? 'btn danger' : 'btn ghost';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      $('dlgActions').appendChild(b);
    }
    $('dlg').hidden = false;
  },
  note(html) { $('dlgBody').insertAdjacentHTML('beforeend', html); },
  close() { $('dlg').hidden = true; },
};

/**
 * Run `step`, and if the server says it needs the admin passphrase, ask for it
 * here and run it again. Writes stay gated — an import replaces a whole month,
 * which is exactly what the gate is for.
 */
function withPassphrase(step) {
  return step().catch((e) => {
    if (!e.needsPassphrase) throw e;
    return new Promise((resolve, reject) => {
      dlg.open('Editing is locked', `<p class="sub">Publishing a target sheet needs the admin passphrase.</p>
        <input type="password" id="dlgPass" placeholder="Admin passphrase" autocomplete="current-password">
        <div class="sheet-stop" id="dlgPassErr" hidden></div>`, [
        { label: 'Unlock and continue', kind: 'primary', onClick: async () => {
          try {
            await apiJson('/auth/unlock', { method: 'POST', body: JSON.stringify({ passphrase: $('dlgPass').value }) });
            resolve(await step());
          } catch (err) {
            const box = $('dlgPassErr');
            if (box) { box.textContent = err.message; box.hidden = false; }
            else reject(err);
          }
        } },
        { label: 'Cancel', onClick: () => { dlg.close(); reject(new Error('Cancelled.')); } },
      ]);
      setTimeout(() => $('dlgPass') && $('dlgPass').focus(), 30);
    });
  });
}

async function importSheet(file) {
  $('err').textContent = '';
  $('import').disabled = true;
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });

    const wb = await withPassphrase(() => apiJson('/api/targets/parse', {
      method: 'POST', body: JSON.stringify({ base64, all: true }),
    }));

    const cols = Draft.resolveColumns(wb.columns);
    if (!cols.name || !cols.target) {
      throw new Error(`Could not find the doctor and target columns. The sheet has: ${wb.columns.join(', ')}.`);
    }

    const rows = wb.rows || wb.sample || [];
    const built = Draft.build(rows, cols);
    if (!built.doctors.length) throw new Error('No named rows in that sheet.');

    // The worksheet is named "Targets 2026-09"; the filename carries it too.
    const period = Draft.periodFrom(wb.sheet) || Draft.periodFrom(file.name)
      || Draft.periodFrom(DATA && DATA.targets && DATA.targets.period);
    if (!period) throw new Error('Could not tell which month this sheet is for. Rename the worksheet "Targets 2026-09".');

    const [branches, published] = await Promise.all([
      Draft.carryBranches(apiJson, period),
      apiJson('/api/targets').catch(() => []),
    ]);
    confirmImport({ file, wb, built, period, branches, existing: published.find((p) => p.period === period) });
  } catch (e) {
    if (e.message !== 'Cancelled.') $('err').textContent = e.message;
  } finally {
    $('import').disabled = false;
  }
}

function confirmImport({ file, wb, built, period, branches, existing }) {
  const total = built.doctors.reduce((s, d) => s + d.monthlyTarget, 0);
  const groups = Object.keys(built.groups);
  const blanks = built.doctors.filter((d) => d.needsTarget);

  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  let body = `<p class="sub">${esc(file.name)} · worksheet ${esc(wb.sheet)}</p><table class="sheet-rows">`;
  body += row('Period', existing
    ? `<b>${esc(period)}</b> — <span style="color:var(--tg-red)">replaces the sheet published ${new Date(existing.publishedAt).toLocaleDateString('en-GB')}</span>, ${fmt(existing.doctors)} doctors`
    : `<b>${esc(period)}</b> — new, nothing published for it yet`);
  body += row('Doctors', `<b>${fmt(built.doctors.length)}</b> across ${groups.length} group${groups.length === 1 ? '' : 's'} · ${esc(groups.join(', '))}`);
  body += row('Total', `<b>${fmt(total)}</b> EGP ex-VAT`);
  body += row('Branches', branches.from
    ? `${fmt(branches.rows.length)} carried forward from ${esc(branches.from)}`
    : '<span style="color:var(--tg-red)">none — this sheet will have no branch targets</span>');
  body += '</table>';

  /* Reconciliation genuinely cannot catch a sheet of zeros: group targets are the
     sum of their doctors, so it balances perfectly. This warning is the only
     thing standing between a blank cell and a published target of nothing. */
  if (blanks.length) {
    body += `<div class="sheet-warn"><strong>${blanks.length} doctor${blanks.length === 1 ? ' has' : 's have'} no target</strong> and will be published at 0 —
      ${blanks.slice(0, 8).map((d) => esc(d.name)).join(', ')}${blanks.length > 8 ? `, and ${blanks.length - 8} more` : ''}.</div>`;
  }
  if (cols_guessed(wb, built)) body += cols_guessed(wb, built);

  // A typo silently becoming a target of 0 is the one thing worth refusing.
  const stop = built.unreadable.length;
  if (stop) {
    body += `<div class="sheet-stop"><strong>${stop} target${stop === 1 ? '' : 's'} could not be read as a number.</strong>
      Fix ${built.unreadable.slice(0, 6).map((u) => `${esc(u.name)} ("${esc(u.value)}")`).join(', ')} in the sheet and import again.</div>`;
  }

  const draft = {
    period, daysInPeriod: daysInPeriod(period),
    // A CSV's worksheet is literally named "(csv)"; the filename says more.
    sourceLabel: `Imported from ${/^\(csv\)$/.test(wb.sheet) ? file.name : wb.sheet}`,
    groups: built.groups,
    doctors: built.doctors.map(({ needsTarget, ...d }) => d),
    branches: branches.rows,
  };

  const actions = [];
  if (!stop) {
    actions.push({
      label: existing ? `Replace ${period}` : `Publish ${period}`,
      kind: existing ? 'danger' : 'primary',
      onClick: async () => {
        try {
          await withPassphrase(() => apiJson(`/api/targets/${period}`, { method: 'PUT', body: JSON.stringify(draft) }));
          dlg.close();
          // After the reload, not before: load() clears this line on its way in.
          await load({ stock: true });
          $('err').innerHTML = `<span style="color:#9fe08a">Published ${esc(period)} — ${fmt(draft.doctors.length)} doctors, ${fmt(total)} ex-VAT${
            branches.rows.length ? `, ${fmt(branches.rows.length)} branch targets carried forward` : ''}.</span>`;
        } catch (e) {
          if (e.message === 'Cancelled.') return;
          dlg.note(`<div class="sheet-stop">${esc(e.message)}${e.problems
            ? `<ul style="margin:6px 0 0 16px">${e.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`);
        }
      },
    });
  }
  actions.push({
    label: 'Review in admin',
    onClick: () => {
      sessionStorage.setItem('nrs-draft', JSON.stringify(draft));
      location.href = '/admin#editor';
    },
  });
  actions.push({ label: 'Cancel', onClick: dlg.close });

  dlg.open(stop ? 'That sheet needs a correction first' : 'Ready to publish', body, actions);
}

/** Only worth saying when the headings were not the ones Export writes. */
function cols_guessed(wb, built) {
  const cols = Draft.resolveColumns(wb.columns);
  if (!cols.guessed.length) return '';
  const label = { name: 'doctor', group: 'group', target: 'monthly target', prev: 'previous' };
  return `<div class="sheet-warn">These columns were matched by name, not exactly as Export writes them:
    ${cols.guessed.map((r) => `${label[r]} → <strong>${esc(cols[r])}</strong>`).join(', ')}.
    Check they are right, or use Review in admin.</div>`;
}

const daysInPeriod = (p) => new Date(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0).getDate();

function applyPreset(p) {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let a = t, b = t;
  if (p === 'yesterday') { a = b = new Date(t - 864e5); }
  else if (p === '7d') { a = new Date(t - 6 * 864e5); }
  else if (p === 'mtd') { a = new Date(t.getFullYear(), t.getMonth(), 1); }
  else if (p === 'lastmonth') {
    a = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    b = new Date(t.getFullYear(), t.getMonth(), 0);
  }
  $('from').value = iso(a);
  $('to').value = iso(b);
}

Shell.mountTabs();

document.addEventListener('click', (e) => {
  const head = e.target.closest('.acc-h');
  if (head) head.parentElement.classList.toggle('open');
});

document.addEventListener('input', (e) => {
  if (!e.target.classList.contains('searchbox')) return;
  const q = e.target.value.toLowerCase().trim();
  e.target.closest('.panel').querySelectorAll('[data-acc], [data-search-target], [data-tg]').forEach((n) => {
    n.style.display = !q || n.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

document.querySelectorAll('#presets button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
    applyPreset(b.dataset.p);
    load({ stock: true });
  });
});
['from', 'to'].forEach((id) => $(id).addEventListener('change', () =>
  document.querySelectorAll('#presets button').forEach((x) => x.classList.remove('on'))));

$('load').addEventListener('click', () => load({ stock: true }));
/* Sync now, in the shared bar, re-reads Odoo and then asks the page to reload —
   it has no idea what this report fetches. See public/cbar.js. */
Shell.onRefresh(() => load({ stock: true }));
$('export').addEventListener('click', exportTemplate);
$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  // Reset first, so picking the same file twice still fires a change.
  e.target.value = '';
  if (f) importSheet(f);
});
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) dlg.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('dlg').hidden) dlg.close(); });

/* Pins the tab strip under the control bar — see public/shell.js. */
Shell.stickyBar();

applyPreset('mtd');
load({ stock: true });
