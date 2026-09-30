/* Report 08 — Inventory Performance.
 *
 * Rebuilt from the frozen `Nouvelage_Inventory_Performance` pack, which held no
 * data of its own: its only payload was a catalogue of 106 products with the
 * unit each is counted in and the doses each yields, and every figure on the
 * page was computed live from Odoo when somebody opened it.
 *
 * THE ONE THING TO UNDERSTAND BEFORE READING ANY NUMBER HERE: Odoo stocks
 * DOSES, not units. Botox arrives as a 100-dose vial and is both stocked and
 * invoiced one dose at a time, so the snapshot says 7,286 of Metox where the
 * fridge holds 72.9 vials. Every quantity on this page is UNITS — vials,
 * syringes, pens — with the dose figure available beside it, because "7,286"
 * and "72.9" are the same stock and only one of them is countable.
 *
 * MONEY IS ON THE DOSE BASIS, not the unit one, because `BillLine.qty` counts
 * doses too: 6,000 Metox at 15 EGP is a price per dose. Value is doses × dose
 * price. Converting one side and not the other is a 100× error on every botox
 * product and no error at all on a syringe, which means it would look right
 * everywhere anyone would think to check it.
 *
 * AND THE HONEST LIMIT, stated on the Sync tab rather than buried here: there
 * are NO STOCK MOVES in the cache. The source pack showed opening → in → out →
 * closing per product, live from Odoo. We hold snapshots. So use is derived from
 * what was sold and receipts from what was bought, and the gap between those
 * and the next snapshot is shown as a reconciliation — it is wastage, breakage
 * and transfers, and presenting it as movement would hide it.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const TALL = 'style="--h:420px"';

/* One colour per band, so the same product reads the same way on every tab.
   `nolink` is grey on purpose — it is not a warning about the stock, it is an
   absence of information, and colouring it red would put 57 products in a
   state nobody can act on. */
const BAND_COLOUR = {
  exp: '#b0503c', cri: '#b0503c', war: '#c98a2e',
  ok: 'var(--positive)', wat: '#7a6a5f', unk: '#7a6a5f', nolink: '#9b8e85',
};
const band = (key, label) => `<span class="pill" style="background:${BAND_COLOUR[key] || '#7a6a5f'}22;color:${BAND_COLOUR[key] || '#7a6a5f'}">${esc(label)}</span>`;

/** The cache-floor banner, when the range reaches before the invoices do. */
const floorNote = (D) => (!D.clamped ? '' : `<div class="tg-note" style="border-left:3px solid #c98a2e">
  <strong>Range shortened.</strong> You asked from ${esc(D.clamped.asked)}, but the invoice cache
  starts ${esc(D.clamped.floor)} — a rate of use needs invoices, so the window starts there.</div>`);

/* ----------------------------------------------------------- 01 · overview */

/** One row of a bar list — the shape the packs use for every ranked cut. */
const barRow = (name, tag, meta, ex, incVal, pct) =>
  `<div class="bar-row" data-search-target>
    <div class="bar-top">
      <span class="bar-name">${name}${tag ? ` <span class="pill">${esc(tag)}</span>` : ''}</span>
      <span class="bar-val">${fmt(ex)}</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, Math.max(0.5, pct)).toFixed(1)}%"></div></div>
    <div class="bar-meta">${meta}${incVal == null ? '' : ` · ${fmt(incVal)} inc`}</div>
  </div>`;

/**
 * At a glance — the lot register, cut three ways, all reconciling to one total.
 *
 * THE STATUS MIX BELONGS HERE, not on the expiry tab. The source pack puts it
 * on the overview because it is the answer to "how bad is it": six numbers that
 * add to the whole book. The expiry tab is for chasing individual lots, and a
 * status summary at the top of it is a second headline nobody reads.
 */
function renderOverview(D) {
  const C = D.cover;
  const E = D.expiry;

  let h = `<section>`;

  /* The two things a reader must know before any figure on this report. */
  if (!E.missing) {
    const bad = E.states.find((sv) => sv.key === 'exp');
    if (bad) {
      h += `<div class="tg-note" style="border-left:3px solid #b0503c">
        <strong>${bad.lots} lots worth ${fmt(bad.value)} EGP ex-VAT (${fmt(bad.valueInc)} inc)
        have already expired.</strong> They are still carried on hand in the register at
        ${esc(E.asOf)}. Together with the critical and warning lots the at-risk book is
        <strong>${fmt(E.atRisk.value)} ex-VAT</strong> (${fmt(E.atRisk.valueInc)} inc) across
        ${E.atRisk.products} products — ${fmt(E.atRisk.share, 1)}% of stock value. Expired lots
        should be written off or returned; critical and warning lots should be pulled to the
        branches that sell them fastest.
        ${E.undateable.length ? `<br>${E.undateable.length} lot${E.undateable.length === 1 ? '' : 's'}
          cannot be aged: ${E.undateable.map((l) => `<strong>${esc(l.product)}</strong> at
          ${esc(l.location)}, ${fmt(l.qty, 1)} doses, ${fmt(l.value)} ex-VAT`).join('; ')}.
          The register string needs fixing so they age automatically.` : ''}</div>`;
    }
  }

  h += `<div class="tg-note"><strong>Two bases, deliberately not merged.</strong>
      Tabs 01–02 read the <strong>lot-level expiry register</strong>${E.missing ? ''
    : ` (${fmt(E.totals.lots)} lots, ${fmt(E.totals.products)} products,
        ${fmt(E.totals.value)} ex-VAT)`}. Tab 03 reads the <strong>movement ledger</strong>${D.ledger.missing ? ''
    : ` (${fmt(D.ledger.coverage.products)} SKUs, ${fmt(D.ledger.company.value)} ex-VAT at
        ${esc(D.ledger.closingAt)})`}. They carry different product masters and different
      cut-offs, so they are shown side by side rather than forced to cross-foot.
      <strong>All values are inventory cost, which is ex-VAT</strong>; every inc-VAT figure here
      is that cost grossed up at ${fmt((E.vat || 0.14) * 100)}% and is for reference only.</div>

    <div class="kicker">01 — At a glance</div>
    <h2 class="title">Stock in numbers</h2>
    <p class="sub">Lot-level register at ${esc(E.missing ? '—' : E.asOf)}. Status, location and
      product cuts all reconcile to the same total. Quantities are <strong>doses</strong>, the
      unit Odoo counts stock in.</p>`;

  if (E.missing) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>No expiry register is loaded</strong>, so the cuts below are unavailable. The
      movement ledger on tab 03 and the cover figures do not depend on it.</div>`;
  } else {
    h += `<div class="kpi-grid">
        <div class="kpi accent"><div class="kpi-label">Stock value ex-VAT</div>
          <div class="kpi-value">${fmt(E.totals.value)}<span class="kpi-unit">EGP</span></div>
          <div class="kpi-sub">Inc-VAT: <strong>${fmt(E.totals.valueInc)}</strong></div></div>
        <div class="kpi"><div class="kpi-label">Lots on hand</div>
          <div class="kpi-value">${fmt(E.totals.lots)}</div>
          <div class="kpi-sub">${E.totals.products} products ·
            <strong>${fmt(E.totals.qty, 1)}</strong> doses</div></div>
        <div class="kpi"><div class="kpi-label">At-risk value</div>
          <div class="kpi-value" style="color:#d97a3a">${fmt(E.atRisk.value)}</div>
          <div class="kpi-sub">${fmt(E.atRisk.valueInc)} inc ·
            <strong>${fmt(E.atRisk.share, 1)}%</strong> of stock</div></div>
        <div class="kpi"><div class="kpi-label">Already expired</div>
          <div class="kpi-value" style="color:#b0503c">${fmt((E.states.find((sv) => sv.key === 'exp') || {}).value)}</div>
          <div class="kpi-sub">${fmt((E.states.find((sv) => sv.key === 'exp') || {}).valueInc)} inc ·
            <strong>${(E.states.find((sv) => sv.key === 'exp') || {}).lots || 0}</strong> lots</div></div>
      </div>

      <h3 class="subtitle">Expiry status mix <span class="vat-tag">Cost ex-VAT</span></h3>
      <div class="cat-list">${E.states.map((sv) => `
        <div class="cat-item">
          <div class="ci-left"><div class="ci-name">${esc(sv.label)}</div>
            <div class="ci-meta">${sv.lots} lots · ${sv.products} products ·
              ${fmt(sv.qty, 1)} doses</div></div>
          <div class="ci-right"><div class="ci-amt">${fmt(sv.value)}</div>
            <div class="ci-inc">${fmt(sv.valueInc)} inc</div>
            <div class="ci-pct">${fmt(sv.share, 1)}%</div></div>
        </div>`).join('')}
        <div class="cat-item total">
          <div class="ci-left"><div class="ci-name">TOTAL</div>
            <div class="ci-meta">${fmt(E.totals.lots)} lots · ${E.totals.products} products ·
              ${fmt(E.totals.locations)} locations</div></div>
          <div class="ci-right"><div class="ci-amt">${fmt(E.totals.value)}</div>
            <div class="ci-inc">${fmt(E.totals.valueInc)} inc</div></div>
        </div>
      </div>

      <h3 class="subtitle">Stock value by location <span class="vat-tag">Ex-VAT</span></h3>
      <div class="bar-list">${E.locations.map((l) => barRow(
    esc(l.location),
    l.isWarehouse ? 'warehouse' : null,
    `${l.lots} lots · ${l.products} products · at risk <strong${l.atRiskShare >= 10
      ? ' style="color:#b0503c"' : ''}>${fmt(l.atRiskValue)}</strong> (${fmt(l.atRiskShare, 1)}%)`,
    l.value,
    l.valueInc,
    E.locations[0].value ? (l.value / E.locations[0].value) * 100 : 0,
  )).join('')}</div>
      <div class="tg-note">A branch holding a fifth of its value in at-risk lots is a different
        conversation from one holding one percent, and the total alone cannot start either.
        Warehouses are marked, because stock there has not been committed to a branch yet and is
        the easiest to move.</div>

      <h3 class="subtitle">Ten largest holdings <span class="vat-tag">Ex-VAT</span></h3>
      <div class="bar-list">${E.products.slice()
    .sort((a, b) => b.value - a.value).slice(0, 10).map((p) => barRow(
      esc(p.product),
      null,
      `${p.lotCount} lots · ${p.locations} locations · ${exPill(p.state, p.stateLabel)}${p.atRisk > 0
        ? ` · at risk <strong style="color:#b0503c">${fmt(p.atRiskValue)}</strong>` : ''}`,
      p.value,
      p.valueInc,
      E.products.slice().sort((a, b) => b.value - a.value)[0].value
        ? (p.value / E.products.slice().sort((a, b) => b.value - a.value)[0].value) * 100 : 0,
    )).join('')}</div>

      <div class="total-card"><div>
          <div class="lbl">All products</div>
          <div class="meta">${E.totals.products} products · ${fmt(E.totals.lots)} lots ·
            ${fmt(E.totals.locations)} locations · ${fmt(E.totals.value)} ex-VAT
            (${fmt(E.totals.valueInc)} inc)</div>
        </div><div class="amt">${fmt(E.totals.qty, 1)}<small>doses on hand</small></div></div>`;
  }

  /* ---- and the cover position, which is the other half of the question ---- */
  h += `<h3 class="subtitle">Cover position <span class="vat-tag">Movement ledger</span></h3>
    <div class="tg-note"><strong>Read cover, not quantity.</strong>
      ${fmt(C.short)} products are short — stock-out, critical or below
      ${C.rules.IDEAL_MONTHS} months. Cover is on-hand units divided by the monthly rate of use
      over the selected range.
      ${C.counts.nolink ? `<strong>${C.counts.nolink} are "Not linked"</strong> — the service
        mapping resolves ${C.linkCoverage.resolved} of ${C.linkCoverage.total} entries, and
        without a link no sale of that product is visible. They are NOT dormant.` : ''}
      ${C.rateIsThin ? `<strong>This range is ${C.rateBasisDays} days</strong>, which makes the
        monthly rate jumpy — widen it before acting.` : ''}</div>

    <div class="kpi-grid">${C.bands.filter((b) => b.count).map((b) => `
      <div class="kpi"><div class="kpi-label">${esc(b.label)}</div>
        <div class="kpi-value sm" style="color:${BAND_COLOUR[b.key]}">${fmt(b.count)}</div>
        <div class="kpi-sub">products</div></div>`).join('')}
    </div>

    ${valuationNote(C)}`;

  $('ov').innerHTML = `${h}</section>`;
}

/** What the value figure does and does not cover. Never a footnote in grey. */
function valuationNote(C) {
  const v = C.valued;
  let h = `<h3 class="subtitle">What the value figure covers</h3>
    <div class="tg-note">Every price is the weighted average actually paid, from purchase lines,
      per dose — the same unit Odoo counts stock in.
      <strong>${v.products} of ${C.rows.length}</strong> products are priced this way.`;
  if (v.unpriced) {
    h += ` <strong>${v.unpriced}</strong> holding ${fmt(v.unpricedUnits, 1)} units have no
      matchable purchase line and are left OUT of the total rather than valued at zero, which
      would quietly shrink it and read as a cheap product.`;
  }
  h += '</div>';
  if (v.unverifiedProducts) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${v.unverifiedProducts} products are priced but not counted</strong> —
      ${fmt(v.unverifiedTotal)} worth. Their purchase line matched only by containment, which
      crosses the unit boundary: Odoo stocks "Exocell" in millilitres and buys
      "DQ EXOCELL 10ML Vial" by the vial, and applying the vial price to a millilitre quantity
      valued one product at eleven times what it is worth. Shown, never summed.</div>`;
  }
  return h;
}

/* ------------------------------------------------------------- 02 · expiry */

/* The five status colours, exactly as the source pack's legend has them. Used
   for the left border of a card and the pill inside it, so a product reads the
   same on this tab and on Cover. */
const EX_COLOUR = {
  exp: '#b0503c', cri: '#d97a3a', war: '#c98a2e', wat: 'var(--taupe)',
  ok: '#5e8d4a', unk: 'var(--line-strong)',
};
const exPill = (state, label) =>
  `<span class="ex-pill ${esc(state)}"><span class="pc-stock-icon"></span>${esc(label)}</span>`;

/** "in 60 days" · "93 days ago" · "no date". What a person needs to hear. */
const whenDays = (d) => (d === null || d === undefined ? 'no expiry date'
  : d < 0 ? `${fmt(-d)} days ago` : d === 0 ? 'today' : `in ${fmt(d)} days`);

/**
 * The expiry register — one card per product, opening to every lot behind it.
 *
 * CARDS, NOT A TABLE, and the difference is the whole tab. A product-level
 * total is not something anybody can act on: you do not chase "430 units of ART
 * FILLER Lips", you chase four lots in four named branches with four different
 * dates. The first build of this report rendered the same figures as a flat
 * table and lost exactly that.
 *
 * Each expansion ends in a total row that reconciles to its own card, which is
 * how a reader knows the summary and the detail are the same data read twice
 * rather than two derivations that might drift.
 */
function renderExpiry(D) {
  const E = D.expiry;
  let h = `<section>
    <div class="kicker">02 — Sell-first priority</div>
    <h2 class="title">Expiry by product</h2>`;

  if (E.missing) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>No expiry lots are loaded.</strong> This tab reads <code>ExpiryLot</code>, which
      arrives from the finance pack rather than from Odoo. Nothing else on this report depends
      on it.</div></section>`;
    $('ex').innerHTML = h;
    return;
  }

  const t = E.thresholds.reduce((m, x) => ({ ...m, [x.key]: x.withinDays }), {});

  h += `<p class="sub">All <strong>${fmt(E.totals.products)} products</strong> in the register,
      worst expiry first (first-expiry-first-out), then largest quantity.
      <strong>Tap a product</strong> to see every lot behind it — location, expiry date, days
      remaining, quantity, and cost value ex-VAT and inc-VAT. Each expansion ends in a total
      that reconciles to the figure on the card.</p>

    <div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>This is a snapshot that does not refresh.</strong> ${fmt(E.totals.lots)} lots loaded
      from the finance pack (<code>${esc(E.sources.join(', '))}</code>), aged from
      <strong>${esc(E.asOf)}</strong>. A lot that has since arrived is not here, and one that has
      since been used still is.
      Critical is inside ${t.cri} days, warning inside ${t.war}, watch inside ${t.wat}.</div>`;

  if (E.undateable.length) {
    h += `<div class="tg-note" style="border-left:3px solid #b0503c">
      <strong>${E.undateable.length} lot${E.undateable.length === 1 ? '' : 's'} cannot be aged.</strong>
      ${E.undateable.map((l) => `${esc(l.product)} at ${esc(l.location)}, ${fmt(l.qty, 1)} units,
        ${fmt(l.value)} ex-VAT`).join(' · ')}. The register string needs fixing so they age
      automatically — until then they sit outside every window on this page.</div>`;
  }

  h += `<div class="search-row">
      <input class="search-input" id="expSearch" type="search"
        placeholder="Search product or location…" autocomplete="off">
      <div class="search-btns">
        <button class="expand-btn" data-exall="ex">Expand all</button>
        <button class="expand-btn" data-colall="ex">Collapse all</button>
      </div>
    </div>

    <div class="chip-row" id="expChips">${E.chips.map((c, i) => `
      <button class="f-chip${i === 0 ? ' on' : ''}" data-expf="${esc(c.key)}">${esc(c.label)}<span class="cn">${fmt(c.count)}</span></button>`).join('')}
    </div>

    <div class="total-card"><div>
        <div class="lbl">At-risk subtotal</div>
        <div class="meta">${fmt(E.atRisk.products)} products · ${fmt(E.atRisk.lots)} lots ·
          ${fmt(E.atRisk.value)} ex-VAT (${fmt(E.atRisk.valueInc)} inc) ·
          ${fmt(E.atRisk.share, 1)}% of stock value</div>
      </div><div class="amt">${fmt(E.atRisk.qty, 1)}<small>units at risk</small></div></div>`;

  /* ---- one card per product ---- */
  for (const p of E.products) {
    h += `<div class="prod-card" data-exp-card data-search-target
        data-flags="${esc(p.flags.join(' '))}"
        style="border-left:4px solid ${EX_COLOUR[p.state] || 'var(--taupe)'}">
      <div class="pc-top">
        <div class="pc-left">
          <span class="pc-rank">${p.rank}</span>
          <span class="pc-name">${esc(p.product)}</span>
          <span class="pc-chevron">&#9656;</span>
          <div>${exPill(p.state, p.stateLabel)}${p.thinMovement
    ? ' <span class="ex-pill unk">thin movement</span>' : ''}</div>
        </div>
        <div class="pc-right">
          <div class="pc-ex">${fmt(p.qty, 1)}</div>
          <div class="pc-inc">units on hand</div>
        </div>
      </div>
      <div class="pc-meta" style="flex-wrap:wrap">
        <span>${p.lotCount} lot${p.lotCount === 1 ? '' : 's'}</span>
        <span>Locations <strong>${p.locations}</strong></span>
        <span>Value <strong>${fmt(p.value)}</strong> ex · ${fmt(p.valueInc)} inc</span>
        <span>Share <strong>${fmt(p.share, 1)}%</strong></span>
        ${p.atRisk > 0 ? `<span>At risk <strong style="color:#b0503c">${fmt(p.atRisk, 1)}</strong>
          units · ${fmt(p.atRiskValue)} ex-VAT</span>` : ''}
        ${p.soonest ? `<span>Earliest <strong>${esc(p.soonest)}</strong> · ${esc(whenDays(p.soonestDays))}</span>` : ''}
      </div>
      <div class="pc-sellers">
        <div class="pc-sellers-title">
          <span>All <strong>${p.lotCount}</strong> lot${p.lotCount === 1 ? '' : 's'}</span>
          <span>Earliest expiry first &darr;</span>
        </div>`;

    for (const l of p.lots) {
      h += `<div class="lot-row">
        <div class="lot-info">
          <div class="lot-name">${esc(l.location)}${l.isWarehouse ? ' <span class="pill">warehouse</span>' : ''}</div>
          <div style="margin-top:3px">${exPill(l.state, l.stateLabel)}</div>
          <div class="lot-meta">${l.expiry ? `Expires ${esc(l.expiry)} · ${esc(whenDays(l.daysLeft))}` : 'No expiry recorded'}
            · ${fmt(l.value)} ex-VAT · ${fmt(l.valueInc)} inc${l.lot ? ` · lot ${esc(l.lot)}` : ''}
            ${l.unitCost ? ` · ${fmt(l.unitCost, 2)}/unit` : ''}</div>
        </div>
        <div class="lot-money">
          <div class="lot-ex">${fmt(l.qty, 1)}</div>
          <div class="lot-inc">units</div>
        </div>
      </div>`;
    }

    /* The reconciliation row. Its figures are summed from the lots above, not
       copied from the card, so the two agreeing is a fact rather than a claim. */
    h += `<div class="lot-row tot">
        <div class="lot-info">
          <div class="lot-name"><strong>Total — reconciles to card</strong></div>
          <div class="lot-meta">${p.locations} location${p.locations === 1 ? '' : 's'} ·
            <strong>${fmt(p.value)}</strong> ex-VAT · ${fmt(p.valueInc)} inc</div>
        </div>
        <div class="lot-money">
          <div class="lot-ex"><strong>${fmt(p.qty, 1)}</strong></div>
          <div class="lot-inc">units</div>
        </div>
      </div></div></div>`;
  }

  h += `<div class="total-card"><div>
      <div class="lbl">All products</div>
      <div class="meta">${fmt(E.totals.products)} products · ${fmt(E.totals.lots)} lots ·
        ${fmt(E.totals.locations)} locations · ${fmt(E.totals.value)} ex-VAT
        (${fmt(E.totals.valueInc)} inc)</div>
    </div><div class="amt">${fmt(E.totals.qty, 1)}<small>units on hand</small></div></div>`;

  /* The status mix and the warehouse split live on the OVERVIEW, where the pack
     puts them: they are the answer to "how bad is it", and a second headline at
     the foot of the tab you chase individual lots on is one nobody reads. What
     stays here is the note about the basis, because it governs every figure on
     this tab. */
  h += `<div class="tg-note">Every inc-VAT figure on this tab is the ex-VAT cost grossed up at
      ${fmt(E.vat * 100)}% and is shown for reference only — it is not a number anybody was
      invoiced. Quantities are <strong>doses</strong>, the unit Odoo counts stock in, which is
      also the unit each lot's cost is per. In warehouses ${fmt(E.split.warehouse)}, in branches
      ${fmt(E.split.branches)}. ${E.thinMovement.lots} lots worth ${fmt(E.thinMovement.value)}
      were flagged as thin movement at import.</div>`;

  $('ex').innerHTML = `${h}</section>`;
}

/* ---------------------------------------------------- 03 · movement ledger */

/** One `.mv` cell of a movement grid. */
const mv = (label, value, sub, kind) =>
  `<div class="mv${kind ? ` ${kind}` : ''}">
    <div class="mv-lbl">${label}</div>
    <div class="mv-val">${fmt(value, 1)}</div>
    ${sub ? `<div class="mv-sub">${sub}</div>` : ''}
  </div>`;

/**
 * Opening → in → out → closing, for the company and for every category.
 *
 * `Adjust` IS THE POINT OF THIS TAB, and it is the one column the source pack
 * reads from Odoo and we derive. We hold stock snapshots, not stock moves, so
 * the adjustment is the residual once receipts, sales and returns are taken off
 * the two counts:
 *
 *     adjust = closing − opening − receipts − bonus + sales + returns
 *
 * That makes the ledger cross-foot by construction, so cross-footing is not
 * evidence of anything and is not presented as such. What IS evidence is the
 * SIZE of the residual: it is write-offs, breakage, transfers between branches
 * and stock used without being billed, and on this window it is 370 units
 * against 423 of sales — a figure worth somebody's afternoon.
 */
function renderLedger(D) {
  const L = D.ledger;
  let h = `<section>
    <div class="kicker">03 — Movement ledger</div>
    <h2 class="title">Inventory analysis</h2>`;

  if (L.missing) {
    /* A ledger needs two counts. Inventing an opening balance from the closing
       one would cross-foot to zero movement — perfectly balanced, and empty. */
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>No ledger for this window.</strong> ${esc(L.reason)}
      A movement ledger needs an opening and a closing stock count, because the
      adjustment is what the two counts cannot explain — derived from one count it would
      always be zero.
      ${L.suggestion ? `Snapshots are held from <strong>${esc(L.suggestion.from)}</strong> to
        <strong>${esc(L.suggestion.to)}</strong>; pick a range inside that.` : ''}</div>`;
    if (L.have && L.have.length) {
      h += `<div class="tw"><table class="ltab tight"><thead><tr><th>Snapshot</th><th class="n">Rows</th></tr></thead>
        <tbody>${L.have.map((x) => `<tr><td class="nm">${esc(x.takenAt)}</td><td class="n">${fmt(x.rows)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    /* The cover cut does not need two counts, so it is still offered. */
    h += coverTable(D, 'Cover, from the latest count alone');
    $('cv').innerHTML = `${h}</section>`;
    return;
  }

  const c = L.company;
  h += `<p class="sub">Rebased to <strong>${esc(L.openingAt)} → ${esc(L.closingAt)}</strong> —
      ${L.window.days} days, ${fmt(L.window.months, 2)} of a month. Run rates are scaled to a full
      month; ideal stock is ${L.rules.IDEAL_MONTHS} months of that rate. Grouped by category.
      <strong>Tap a category</strong> for its own ledger, its stock-versus-ideal position, and
      every SKU inside it.</p>

    <div class="tg-note"><strong>Read cover, not quantity.</strong>
      <strong>${fmt(L.short)} SKUs</strong> are short — stock-out, critical or below ideal.
      <strong>${fmt(L.overstock.skus)} SKUs</strong> hold ${fmt(L.overstock.value)} EGP ex-VAT at
      four months of cover or more, which is where the cash is parked.</div>

    <div class="tg-note" style="border-left:3px solid #d97a3a">
      <strong>Opening comes from a real earlier count, and Adjust is what the two counts cannot
      explain.</strong> The source pack reads adjustments from Odoo's stock moves; this app caches
      snapshots, not moves. So <code>adjust = closing − opening − receipts − bonus + sales +
      returns</code>, which makes the ledger balance by construction — the balance proves nothing,
      but the <strong>size</strong> of the residual does. Over this window it is
      <strong>${fmt(Math.abs(c.adjust), 1)} units</strong> against ${fmt(c.sales, 1)} of sales:
      write-offs, breakage, transfers between branches, and stock used without being billed.
      Receipts are matched to ${fmt(L.coverage.receiptsMatched)} products out of
      ${fmt(L.coverage.billLines)} purchase lines, so part of the residual is simply a delivery
      whose product name we could not place.</div>

    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Ledger stock value ex-VAT</div>
        <div class="kpi-value">${fmt(c.value)}<span class="kpi-unit">EGP</span></div>
        <div class="kpi-sub">Inc-VAT: <strong>${fmt(c.valueInc)}</strong></div></div>
      <div class="kpi"><div class="kpi-label">SKUs tracked</div>
        <div class="kpi-value">${fmt(L.coverage.products)}</div>
        <div class="kpi-sub"><strong>${fmt(L.coverage.linked)}</strong> with a service link ·
          ${L.categories.length} categories</div></div>
      <div class="kpi"><div class="kpi-label">In hand vs ideal</div>
        <div class="kpi-value sm">${fmt(c.closing, 1)} / ${fmt(c.ideal, 1)}</div>
        <div class="kpi-sub"><strong>${c.idealPct == null ? '—' : `${fmt(c.idealPct)}%`}</strong>
          of the ${L.rules.IDEAL_MONTHS}-month target</div></div>
      <div class="kpi"><div class="kpi-label">Short of ideal</div>
        <div class="kpi-value" style="color:#d97a3a">${fmt(L.short)}</div>
        <div class="kpi-sub">SKUs under ${L.rules.BELOW} months cover</div></div>
    </div>

    <h3 class="subtitle">Company movement · ${esc(L.openingAt)} → ${esc(L.closingAt)}
      <span class="vat-tag">Units</span></h3>
    <div class="mv-grid" style="margin-bottom:18px">
      ${mv(`Opening · ${esc(L.openingAt)}`, c.opening)}
      ${mv('+ Purchase', c.receipts, `${fmt(c.receipts / (L.window.months || 1), 1)}/mo`, 'in')}
      ${mv('+ Bonus FOC', c.bonus, c.bonusPct == null ? 'no priced receipts' : `${fmt(c.bonusPct)}% bonus`, 'bonus')}
      ${mv('− Sales', c.sales, `${fmt(c.monthlyRate, 1)}/mo`, 'out')}
      ${mv(c.adjust < 0 ? '− Adjust' : '+ Adjust', Math.abs(c.adjust), 'unexplained', 'out')}
      ${mv('− Returns', c.returned, 'to supplier', 'out')}
      ${mv('= In Hand', c.closing, `${c.coverMonths == null ? '—' : `${fmt(c.coverMonths, 1)} mo`} cover`, 'hand')}
    </div>

    <div class="cat-list" style="margin-bottom:18px">
      <div class="cat-item total">
        <div class="ci-left"><div class="ci-name">STOCK VALUE AT ${esc(L.closingAt)}</div>
          <div class="ci-meta">${fmt(c.closing, 1)} units on hand · cost as recorded ·
            ${fmt(L.coverage.priced)} of ${fmt(L.coverage.products)} products priced</div></div>
        <div class="ci-right"><div class="ci-amt">${fmt(c.value)}</div>
          <div class="ci-inc">${fmt(c.valueInc)} inc</div></div>
      </div>
    </div>

    <div class="search-row">
      <input class="search-input" id="invSearch" type="search"
        placeholder="Search product, vendor or category…" autocomplete="off">
      <div class="search-btns">
        <button class="expand-btn" data-exall="cv">Expand all</button>
        <button class="expand-btn" data-colall="cv">Collapse all</button>
      </div>
    </div>

    <div class="inv-legend">${L.bands.filter((b) => b.count).map((b) => `
      <span class="lg"><b style="background:${BAND_COLOUR[b.key]}"></b>${esc(b.label)} · ${b.count}</span>`).join('')}
    </div>`;

  /* ---- one card per category ---- */
  for (const g of L.categories) {
    h += `<div class="inv-card ${esc(g.band)}" data-inv-card data-search-target>
      <div class="inv-head">
        <div class="inv-info">
          <div class="inv-name">${esc(g.category)}</div>
          <div class="inv-meta">
            ${exPill(g.band, g.bandLabel)}
            <span>${g.skus} SKU${g.skus === 1 ? '' : 's'}</span>
            <span>${g.coverMonths == null ? 'no cover figure' : `${fmt(g.coverMonths, 1)} mo cover`}</span>
            <span>avg <strong style="color:var(--espresso)">${fmt(g.monthlyRate, 1)}</strong> u/mo</span>
            <span>${fmt(g.value)} ex-VAT · ${fmt(g.valueInc)} inc</span>
          </div>
        </div>
        <div class="inv-amt">
          <div class="inv-amt-main">${fmt(g.closing, 1)}</div>
          <div class="inv-amt-sub">${esc(g.rows[0] ? g.rows[0].unit : 'units')} in hand</div>
        </div>
        <span class="inv-tog">&#9656;</span>
      </div>
      <div class="inv-body">
        <div class="mv-grid">
          ${mv(`Opening · ${esc(L.openingAt)}`, g.opening)}
          ${mv('+ Purchase', g.receipts, `${fmt(g.receipts / (L.window.months || 1), 1)}/mo`, 'in')}
          ${mv('+ Bonus FOC', g.bonus, g.bonusPct == null ? '—' : `${fmt(g.bonusPct)}% bonus`, 'bonus')}
          ${mv('− Sales', g.sales, `${fmt(g.monthlyRate, 1)}/mo`, 'out')}
          ${mv(g.adjust < 0 ? '− Adjust' : '+ Adjust', Math.abs(g.adjust), 'unexplained', 'out')}
          ${mv('− Returns', g.returned, 'to supplier', 'out')}
          ${mv('= In Hand', g.closing, `${g.coverMonths == null ? '—' : `${fmt(g.coverMonths, 1)} mo`} cover`, 'hand')}
        </div>

        <div class="ideal-row">
          <div class="ideal-title">
            <span>Stock vs ideal level</span>
            <span>Have <strong>${fmt(g.closing, 1)}</strong> · Ideal <strong>${fmt(g.ideal, 1)}</strong>
              ${g.idealPct == null ? '' : `(${fmt(g.idealPct)}%)`}</span>
          </div>
          <div class="ideal-bar">
            <div class="have" style="width:${Math.min(100, g.idealPct || 0).toFixed(1)}%"></div>
            <div class="mark" style="left:100.0%"></div>
          </div>
        </div>

        <div class="si-table"><table><thead><tr>
          <th>Product</th><th>Open</th><th>Purch</th><th>Bonus</th><th>Sales</th><th>Adjust</th>
          <th>Avg/mo</th><th>In hand</th><th>Cover</th><th>Ideal</th>
          <th>Stock value ex-VAT</th><th>Inc-VAT</th><th>Status</th>
        </tr></thead><tbody>${g.rows.map((r) => `<tr>
          <td class="prod-name">${esc(r.name)}${r.vendorName ? `<small>${esc(r.vendorName)}</small>` : ''}</td>
          <td>${fmt(r.opening, 1)}</td>
          <td>${fmt(r.receipts, 1)}</td>
          <td>${r.bonus ? fmt(r.bonus, 1) : '0'}</td>
          <td>${fmt(r.sales, 1)}</td>
          <td>${fmt(r.adjust, 1)}</td>
          <td>${fmt(r.monthlyRate, 1)}</td>
          <td class="hand">${fmt(r.closing, 1)}</td>
          <td>${r.coverMonths == null ? '—' : `${fmt(r.coverMonths, 1)}mo`}</td>
          <td>${fmt(r.ideal, 1)}</td>
          <td>${r.value == null ? '—' : fmt(r.value)}</td>
          <td>${r.valueInc == null ? '—' : fmt(r.valueInc)}</td>
          <td>${exPill(r.band, r.bandLabel)}</td>
        </tr>`).join('')}</tbody></table></div>
      </div></div>`;
  }

  h += valuationNote(D.cover);
  $('cv').innerHTML = `${h}</section>`;
}

/**
 * The flat cover table, kept for the case the ledger cannot run.
 *
 * Cover needs one count; the ledger needs two. When only one snapshot falls in
 * the window the ledger refuses, and offering nothing at all would be worse
 * than offering the half that is still true.
 */
function coverTable(D, title) {
  const C = D.cover;
  return `<h3 class="subtitle">${esc(title)}</h3>
    <div class="tg-note">Cover is <code>on-hand units ÷ (units used ÷ months)</code>, from the
      ${esc(C.snapshotAt || '—')} count. Ideal is ${C.rules.IDEAL_MONTHS} months.
      ${C.counts.nolink ? `<strong>${C.counts.nolink} products are "Not linked"</strong> — the
        service mapping resolves ${C.linkCoverage.resolved} of ${C.linkCoverage.total} entries,
        and without a link no sale of that product is visible.` : ''}</div>
    <input class="searchbox" id="cvFilter" placeholder="Search product or category…">
    <div class="tw scrolly" style="--h:420px"><table class="ltab"><thead><tr>
      <th>Product</th><th>Category</th><th></th>
      <th class="n">On hand</th><th class="n">Doses</th><th class="n">Used</th>
      <th class="n">Per month</th><th class="n">Cover</th><th class="n">Value</th>
    </tr></thead><tbody>${C.rows.map((r) => `<tr data-search-target>
      <td class="nm">${esc(r.name)}${r.dosesPerUnit > 1 ? ` <span class="vat-tag">${fmt(r.dosesPerUnit)}/unit</span>` : ''}</td>
      <td>${esc(r.category)}</td>
      <td>${exPill(r.band, r.bandLabel)}</td>
      <td class="n">${fmt(r.onHand, 1)}</td>
      <td class="n" style="color:var(--muted)">${fmt(r.onHandDoses, 1)}</td>
      <td class="n">${fmt(r.usedUnits, 1)}</td>
      <td class="n">${fmt(r.monthlyRate, 1)}</td>
      <td class="n"><strong>${r.coverMonths == null ? '—' : `${fmt(r.coverMonths, 1)}m`}</strong></td>
      <td class="n">${r.value == null ? (r.unverifiedValue == null ? '—'
    : `<span style="color:#c98a2e">(${fmt(r.unverifiedValue)})</span>`) : fmt(r.value)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

/* ------------------------------------------------------ 04 · at-risk sales */

/**
 * Consumption out of at-risk stock, attributed lot by lot.
 *
 * THE MARGIN IS WHY THIS TAB EXISTS. Cost cleared is what those lots were
 * carried at; revenue is what they were sold for. The gap is what would have
 * been lost had they been written off instead — the number that justifies
 * moving stock to the branch that sells it fastest.
 *
 * Everything here is in DOSES, because that is the basis the expiry register
 * and the lot costs are in. Drawing converted vials against a queue of doses
 * reported a 99.9% margin on Metox before it was caught: nine vials' worth of
 * revenue against nine doses' worth of cost.
 */
function renderAtRisk(D) {
  const A = D.atRisk;
  let h = `<section>
    <div class="kicker">04 — Consumption from at-risk stock</div>
    <h2 class="title">Sold from at-risk lots</h2>`;

  if (A.missing) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${esc(A.reason)}</strong> This tab needs both the expiry register and the sales,
      and only one of them is here.</div></section>`;
    $('ar').innerHTML = h;
    return;
  }

  if (!A.rows.length) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>Nothing to attribute.</strong> ${esc(A.note)}
      ${A.unmatched.length ? `${A.unmatched.length} at-risk register products worth
        ${fmt(A.totals.unmatchedValue)} could not be matched to a catalogue product, so no sale
        of them is visible.` : ''}</div></section>`;
    $('ar').innerHTML = h;
    return;
  }

  h += `<p class="sub">Sales over <strong>${esc(A.window.from)} → ${esc(A.window.to)}</strong> for
      products that held expired, critical or warning lots at the ${esc(A.asOf)} snapshot,
      attributed <strong>first-expiry-first-out</strong>. <strong>Tap a product</strong> to see
      every branch, doctor and invoice line behind it, and which lots each line drew from.</p>

    <div class="tg-note">${esc(A.note)} Cost is what the lot itself was carried at, not the
      product's average across the year. The gap between cost and revenue is the margin that
      would have been lost had these lots been written off instead of sold —
      <strong>${fmt(A.totals.margin)} EGP ex-VAT</strong> over this window.</div>`;

  /* The two-bar summary the pack leads with. */
  if (A.fromStates.length) {
    const top = Math.max(...A.fromStates.map((sv) => sv.ex), 1);
    h += `<div class="tg-sum">${A.fromStates.map((sv) => `
      <div class="tg-s">
        <div class="l">From ${esc(String(sv.label).toLowerCase())} lots</div>
        <div class="p">${fmt(sv.doses, 1)}</div>
        <div class="n">${fmt(sv.ex)} ex-VAT<br>${sv.lines} lines · ${sv.products} products</div>
        <div class="b"><i style="width:${((sv.ex / top) * 100).toFixed(1)}%"></i></div>
      </div>`).join('')}
      <div class="tg-s tot">
        <div class="l">Total recovered</div>
        <div class="p">${fmt(A.totals.rescuedDoses, 1)}</div>
        <div class="n">${fmt(A.totals.rescuedEx)} ex-VAT<br>${fmt(A.totals.rescuedExInc)} inc</div>
      </div>
    </div>`;
  }

  h += `<div class="kpi-grid" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-label">Doses cleared</div>
        <div class="kpi-value">${fmt(A.totals.rescuedDoses, 1)}</div>
        <div class="kpi-sub">${fmt(A.totals.soldLines)} invoice lines ·
          <strong>${A.totals.products}</strong> products</div></div>
      <div class="kpi"><div class="kpi-label">Cost value cleared</div>
        <div class="kpi-value sm">${fmt(A.totals.rescuedCost)}</div>
        <div class="kpi-sub">what those lots were carried at</div></div>
      <div class="kpi"><div class="kpi-label">Revenue ex-VAT</div>
        <div class="kpi-value sm">${fmt(A.totals.rescuedEx)}</div>
        <div class="kpi-sub">${fmt(A.totals.rescuedExInc)} inc</div></div>
      <div class="kpi"><div class="kpi-label">Margin on rescued stock</div>
        <div class="kpi-value sm" style="color:#5e8d4a">${fmt(A.totals.margin)}</div>
        <div class="kpi-sub"><strong>${A.totals.marginPct == null ? '—' : `${fmt(A.totals.marginPct)}%`}</strong>
          of revenue</div></div>
    </div>

    <div class="kpi-grid">
      <div class="kpi${A.totals.stillAtRisk > 0 ? ' accent' : ''}"><div class="kpi-label">Still sitting there</div>
        <div class="kpi-value sm" style="color:#b0503c">${fmt(A.totals.stillAtRisk, 1)}</div>
        <div class="kpi-sub">doses of at-risk stock the sales did not reach</div></div>
      <div class="kpi"><div class="kpi-label">Will not clear</div>
        <div class="kpi-value sm">${fmt(A.totals.willNotClearValue)}</div>
        <div class="kpi-sub">${A.totals.willNotClear} products, at the current rate</div></div>
      <div class="kpi"><div class="kpi-label">Not selling at all</div>
        <div class="kpi-value sm">${fmt(A.totals.noSalesValue)}</div>
        <div class="kpi-sub">${A.totals.noSales} products with no visible sale</div></div>
      <div class="kpi"><div class="kpi-label">Could not be matched</div>
        <div class="kpi-value sm">${fmt(A.totals.unmatchedValue)}</div>
        <div class="kpi-sub">${A.unmatched.length} register names not in the catalogue</div></div>
    </div>

    <div class="search-row">
      <input class="search-input" id="arSearch" type="search"
        placeholder="Search product, branch or doctor…" autocomplete="off">
      <div class="search-btns">
        <button class="expand-btn" data-exall="ar">Expand all</button>
        <button class="expand-btn" data-colall="ar">Collapse all</button>
      </div>
    </div>`;

  /* ---- one card per product, opening to branch → doctor → invoice line ----

     THE PACK'S OWN `.doc-card` INTERNALS, not the `.pc-*` ones used on the
     expiry tab. app.css scopes them as `.doc-card .rank`, `.doc-card .info`,
     `.doc-card .money` and so on, so a card built out of `.pc-top` gets the
     doc-card container and none of its children's styling — structurally fine
     and visually nothing like the source. */
  const totalEx = A.totals.rescuedEx || 1;
  A.rows.forEach((r, i) => {
    h += `<div class="doc-card" data-ar-card data-search-target
        style="border-left:4px solid ${EX_COLOUR[r.state] || 'var(--taupe)'}">
      <div class="rank${i === 0 ? ' top1' : ''}">${i + 1}</div>
      <div class="info">
        <div class="name">${esc(r.product)}<span class="doc-chevron">&#9656;</span></div>
        <div class="branches">${esc(r.branches.map((b) => b.name).join(', ')) || 'no branch sold it'}</div>
        <div class="lines">${r.soldLines} lines · ${fmt(r.rescuedDoses, 1)} of
          ${fmt(r.atRisk, 1)} at-risk doses cleared${r.soonest
    ? ` · earliest expiry ${esc(r.soonest)}` : ''}${r.stillAtRisk > 0
    ? ` · ${fmt(r.stillAtRisk, 1)} still there` : ''}</div>
        <div style="margin-top:6px">${exPill(r.state, r.stateLabel)}${r.willClear === false
    ? ' <span class="ex-pill exp">will not clear</span>'
    : r.willClear === true ? ' <span class="ex-pill ok">clears in time</span>'
      : ' <span class="ex-pill unk">no sales</span>'}${r.matchRule !== 'exact'
    ? ` <span class="vat-tag" title="register name &quot;${esc(r.lotName)}&quot;">matched by ${esc(r.matchRule)}</span>` : ''}</div>
        <div class="lines">Cost ${fmt(r.rescuedCost)} · margin
          <strong style="color:#5e8d4a">${fmt(r.margin)}</strong>${r.marginPct == null ? ''
    : ` (${fmt(r.marginPct)}%)`}</div>
      </div>
      <div class="money">
        <div class="ex">${fmt(r.rescuedEx)}</div>
        <div class="inc">${fmt(r.rescuedExInc)} inc</div>
        <div class="pct">${fmt((r.rescuedEx / totalEx) * 100, 1)}%</div>
      </div>
      <div class="dc-products">
        <div class="dc-products-title">
          <span>All <strong>${r.soldLines}</strong> lines · ${r.branches.length} branches</span>
          <span>By revenue &darr;</span>
        </div>`;

    for (const b of r.branches) {
      h += `<div class="lot-row" style="background:var(--cream);padding:8px 10px;border-radius:4px;margin-top:6px">
        <div class="lot-info">
          <div class="lot-name"><strong>${esc(b.name)}</strong></div>
          <div class="lot-meta">${b.lines} line${b.lines === 1 ? '' : 's'} ·
            ${fmt(b.units, 1)} units</div>
        </div>
        <div class="lot-money">
          <div class="lot-ex">${fmt(b.ex)}</div>
          <div class="lot-inc">ex-VAT</div>
        </div>
      </div>`;
      for (const d of b.doctors) {
        for (const line of d.lines) {
          h += `<div class="lot-row" style="padding-left:12px">
            <div class="lot-info">
              <div class="lot-name">${esc(d.name)}</div>
              <div class="lot-meta">${esc(line.date)} · ${esc(line.ref)} ·
                qty ${fmt(line.doses, 1)} doses${line.units !== line.doses
    ? ` (${fmt(line.units, 2)} units)` : ''}
                ${line.drawn.length
    ? `<br>Lots drawn: ${line.drawn.map((x) => `${esc(x.expiry || 'no date')} (${esc(x.state)}) &times;${fmt(x.qty, 1)}`).join(', ')}`
    : '<br>Drawn from healthy stock — not counted as a rescue'}</div>
            </div>
            <div class="lot-money">
              <div class="lot-ex">${fmt(line.ex)}</div>
              <div class="lot-inc">ex-VAT</div>
            </div>
          </div>`;
        }
      }
    }

    /* The reconciliation row, summed from the lines above rather than copied
       from the card — the two agreeing is then a fact, not a claim. */
    h += `<div class="lot-row tot">
        <div class="lot-info">
          <div class="lot-name"><strong>Total — reconciles to card</strong></div>
          <div class="lot-meta">${r.branches.length} branches ·
            ${fmt(r.rescuedDoses, 1)} doses drawn from at-risk lots</div>
        </div>
        <div class="lot-money">
          <div class="lot-ex"><strong>${fmt(r.branches.reduce((t, b) => t + b.ex, 0))}</strong></div>
          <div class="lot-inc">ex-VAT sold</div>
        </div>
      </div></div></div>`;
  });

  h += `<div class="total-card"><div>
      <div class="lbl">Total recovered</div>
      <div class="meta">${A.totals.products} products · ${fmt(A.totals.soldLines)} invoice lines ·
        cost ${fmt(A.totals.rescuedCost)} · margin ${fmt(A.totals.margin)}${A.totals.marginPct == null
    ? '' : ` (${fmt(A.totals.marginPct)}%)`}</div>
    </div><div class="amt">${fmt(A.totals.rescuedEx)}<small>EGP ex-VAT rescued</small></div></div>`;

  if (A.unmatched.length) {
    h += `<h3 class="subtitle">Register products not in the catalogue</h3>
      <div class="tg-note">${fmt(A.totals.unmatchedValue)} of at-risk stock whose register name
        matches no catalogue product. Listed rather than dropped: the money is real, it is simply
        not attributable, and adding it to a total would attribute it to the wrong product.</div>
      <div class="tw"><table class="ltab tight"><thead><tr>
        <th>Register product</th><th class="n">At risk</th><th class="n">Value ex</th>
        <th class="n">Inc</th><th>Why</th>
      </tr></thead><tbody>${A.unmatched.map((u) => `<tr>
        <td class="nm">${esc(u.product)}</td><td class="n">${fmt(u.atRisk, 1)}</td>
        <td class="n">${fmt(u.atRiskValue)}</td><td class="n">${fmt(u.atRiskValueInc)}</td>
        <td>${esc(u.why)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('ar').innerHTML = `${h}</section>`;
}


/* -------------------------------------------------------------------- boot */

function paint() {
  const D = DATA;
  $('hPeriod').textContent = `${D.from} → ${D.to}`;
  $('hHand').textContent = fmt(D.totals.onHand, 1);
  $('hHandUnit').textContent = `${fmt(D.totals.onHandDoses)} doses · ${fmt(D.totals.skus)} products`;
  $('hVal').textContent = fmt(D.totals.value);
  $('hValUnit').textContent = `${D.cover.valued.products} of ${D.cover.rows.length} products priced`;
  $('hShort').textContent = fmt(D.totals.short);
  $('hRisk').textContent = D.totals.atRiskValue == null ? '—' : fmt(D.totals.atRiskValue);
  $('rangeline').textContent = `Snapshot ${D.cover.snapshotAt || '—'} · use over ${D.cover.rateBasisDays} days`
    + ` · ${D.cover.linkCoverage.resolved}/${D.cover.linkCoverage.total} service links resolved`;

  renderOverview(D); renderExpiry(D); renderLedger(D); renderAtRisk(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    DATA = await api(`/api/inventory?${q}`);
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.totals.skus)} products · ${fmt(DATA.totals.short)} short`;
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
$('load').addEventListener('click', load);
/* Sync now, in the shared control bar, re-reads Odoo and then asks the page to
   reload — it cannot know what this report fetches. See public/cbar.js. */
Shell.onRefresh(load);

/* All the card and chip behaviour, delegated once. The panels are rebuilt on
   every range change, so anything bound to a node directly would need
   rewiring — and the CSP forbids the inline `onclick` the source packs use. */
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;

  const head = e.target.closest('.acc-h');
  if (head) { head.parentElement.classList.toggle('open'); return; }

  /* Expand / collapse everything on a panel. On 91 products it is the
     difference between reading the tab and clicking through it. */
  const exAll = e.target.closest('[data-exall]');
  if (exAll) {
    $(exAll.dataset.exall).querySelectorAll('.prod-card, .inv-card, .doc-card')
      .forEach((c) => c.classList.add('expanded'));
    return;
  }
  const colAll = e.target.closest('[data-colall]');
  if (colAll) {
    $(colAll.dataset.colall).querySelectorAll('.prod-card, .inv-card, .doc-card')
      .forEach((c) => c.classList.remove('expanded'));
    return;
  }

  /* The status chips. Filtering on `flags` rather than the product's own state,
     so "Expired" shows every product holding an expired lot — including one
     whose worst lot is expired but which is mostly fine. A product-state filter
     would hide the lot somebody has to go and deal with. */
  const chip = e.target.closest('[data-expf]');
  if (chip) {
    const want = chip.dataset.expf;
    chip.parentElement.querySelectorAll('[data-expf]')
      .forEach((c) => c.classList.toggle('on', c === chip));
    $('ex').querySelectorAll('[data-exp-card]').forEach((card) => {
      const flags = (card.dataset.flags || '').split(' ');
      card.style.display = want === 'all' || flags.includes(want) ? '' : 'none';
    });
    return;
  }

  /* A card opens from its HEAD, not from anywhere inside it. The source packs
     put the handler on the whole card, so a click on a lot row you were reading
     collapsed the thing you were reading it in. */
  const card = e.target.closest('.prod-card, .inv-card, .doc-card');
  if (card && !e.target.closest('.pc-sellers, .inv-body, .dc-products')) {
    card.classList.toggle('expanded');
  }
});

/* The search box filters rows in place — the same delegated handler the Sales
   report uses, so a rebuilt panel needs no rewiring. */
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('searchbox')) return;
  const q = e.target.value.toLowerCase().trim();
  e.target.closest('.panel').querySelectorAll('[data-search-target]').forEach((n) => {
    n.style.display = !q || n.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

Shell.mountTabs();
Shell.stickyBar();
preset('mtd');
load();
