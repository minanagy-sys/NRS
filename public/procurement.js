/* Report 09 — Procurement & Products.
 *
 * Rebuilt from the frozen `Nouvelage_Products_and_Procurement_YTD2026` pack,
 * whose own subtitle says where it came from: "sourced from the YTD
 * purchase-invoice detail file (Jan–Jul 2026)" — a spreadsheet that stopped
 * refreshing. This reads `Bill`, `BillLine`, `VendorPayment` and `Invoice`
 * instead, so it moves.
 *
 * THE SCOPE IS EVERY PAYABLE, WHICH IS NOT WHAT THE PACK COUNTED.
 *
 * The pack reports 29,401,633 from 32 vendors and counts only products. `Bill`
 * holds 52,168,665 from 73, because rent, advertising, expenses and fixed
 * assets are payables too. Mina asked for all of it, so nothing is filtered out
 * — instead the total is BROKEN DOWN by the category prefix Odoo already puts
 * on every line, and the breakdown is asserted to sum back to the line total
 * exactly. A figure 78% above the pack's with no explanation is
 * indistinguishable from a bug; the same figure with the composition beside it
 * is an answer.
 *
 * CASH BACK IS AN AGREEMENT AND ONLY EXACT NAMES GET ONE. 10%, and 15% for
 * Eldawlia Pharma, held in `VendorTerm` and edited in Admin. Matched loosely it
 * put an agreement on 63 of 73 suppliers and owed 4.48 M of cash back on rent
 * and advertising; only the tiers where the two names really are the same name
 * may put money on a vendor's row, which leaves 17.
 *
 * RETURNS ARE SEEDED AND SAY SO on every figure built on them. There is not one
 * negative purchase line in the cache, so 11 rows carrying 3,047,191 are the
 * only record of goods going back that exists anywhere we can read.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 1) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(d)}%`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;
const PRODUCT_CACHE = new Map();

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
  if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

const TALL = 'style="--h:420px"';
const bar = (pct, colour) => `<div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%${colour ? `;background:${colour}` : ''}"></div></div>`;

/* ----------------------------------------------------------- 01 · overview */

/**
 * One month of the purchase rhythm.
 *
 * Drawn with `.bar-list`, which the Commercial and Marketing reports already
 * use, rather than the source pack's vertical columns. Two reasons: it needs no
 * new CSS, and a horizontal bar carries the month name, the figure and the bill
 * count on one line where a column has to hide two of the three at this width.
 */
const barCol = (label, value, top, sub) =>
  `<div class="bar-row">
    <div class="bar-top">
      <span class="bar-name">${esc(label)}</span>
      <span class="bar-val">${fmt(value)}</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${top ? Math.max(0.5, (value / top) * 100).toFixed(1) : 0}%"></div></div>
    ${sub ? `<div class="bar-meta">${esc(sub)}</div>` : ''}
  </div>`;

function renderOverview(D) {
  const P = D.purchases;
  const R = P.reconciles;
  const top = P.months.length ? Math.max(...P.months.map((m) => m.net)) : 0;
  const topProd = P.products.slice(0, 12);
  const topVen = D.vendors.rows.slice(0, 12);

  let h = `<section>
    <div class="kicker">01 — Overview</div>
    <h2 class="title">Purchasing performance</h2>
    <p class="sub">${esc(D.from)} to ${esc(D.to)}, ex-VAT. <strong>Every payable</strong>, not
      only products — the composition below says what the total is made of.</p>

    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Purchases ex-VAT</div>
        <div class="kpi-value">${fmt(P.totals.net)}</div>
        <div class="kpi-sub">${fmt(P.totals.bills)} bills · ${fmt(P.totals.vendors)} suppliers</div></div>
      <div class="kpi"><div class="kpi-label">Consumables</div>
        <div class="kpi-value">${fmt(P.totals.consumableNet)}</div>
        <div class="kpi-sub">${pc(P.totals.net ? P.totals.consumableNet / P.totals.net : null)} of it — stock the clinic uses</div></div>
      <div class="kpi"><div class="kpi-label">Everything else</div>
        <div class="kpi-value">${fmt(P.totals.nonConsumableNet)}</div>
        <div class="kpi-sub">rent, advertising, expenses, assets</div></div>
      <div class="kpi"><div class="kpi-label">Returned</div>
        <div class="kpi-value" style="color:#b0503c">${D.returns.missing ? '—' : fmt(D.returns.totals.value)}</div>
        <div class="kpi-sub">${D.returns.missing ? 'none loaded'
    : `${D.returns.totals.rows} rows · ${pc(P.totals.net ? D.returns.totals.value / P.totals.net : null)} of purchases`}</div></div>
    </div>

    <div class="tg-note"><strong>The source pack counted 29,401,633 across 32 vendors.</strong>
      This counts ${fmt(P.totals.net)} across ${fmt(P.totals.vendors)} because it reads the whole
      payables ledger, which is what was asked for. The difference is almost entirely rent,
      advertising and expenses, and it is itemised below rather than left as a puzzle.</div>

    <div class="kicker" style="margin-top:22px">The buying rhythm</div>
    <h2 class="title">Purchases, month by month</h2>
    <div class="leg"><span><i class="buy"></i>Purchases · before returns</span>
      <span>bill count shown per month</span></div>
    <div class="bars"><div class="bar-list">${P.months.map((m) => barCol(m.label, m.net, top, `${m.bills} bills`)).join('')}</div></div>

    <h3 class="subtitle">What the money was for</h3>
    <div class="cat-list">${P.composition.map((g) => `
      <div class="cat-item">
        <div class="ci-left"><div class="ci-name">${esc(g.label)}${g.consumable
    ? ' <span class="ex-pill ok">stock</span>' : ''}</div>
          <div class="ci-meta">${fmt(g.lines)} lines · ${g.categories} categories ·
            ${fmt(g.qty, 1)} units</div></div>
        <div class="ci-right"><div class="ci-amt">${fmt(g.net)}</div>
          <div class="ci-pct">${pc(R.lineNet ? g.net / R.lineNet : null)}</div></div>
      </div>`).join('')}
      <div class="cat-item total">
        <div class="ci-left"><div class="ci-name">TOTAL PURCHASE LINES</div>
          <div class="ci-meta">${fmt(P.totals.lines)} lines · ${fmt(P.totals.products)} products</div></div>
        <div class="ci-right"><div class="ci-amt">${fmt(R.compositionNet)}</div></div>
      </div>
    </div>

    <div class="tg-note"${R.compositionGap === 0 ? '' : ' style="border-left:3px solid #b0503c"'}>
      <strong>${R.compositionGap === 0 ? 'The breakdown adds up exactly.'
    : `The breakdown is out by ${fmt(R.compositionGap)}.`}</strong>
      Groups total ${fmt(R.compositionNet)} against ${fmt(R.lineNet)} of purchase lines.
      A further <strong>${fmt(R.residual)}</strong> sits on bill headers that no line accounts for
      (${R.headerOnlyBills} bills carry no line detail at all), which is why the ledger total is
      ${fmt(R.billNet)}. That residual is kept OUT of the groups on purpose: folding it into one
      would make the sum balance by hiding the thing it exists to show.</div>

    <div class="kicker" style="margin-top:22px">Biggest movers</div>
    <h2 class="title">Top products <span class="hint">tap to open the product</span></h2>
    <div class="bar-list">${topProd.map((p, i) => `
      <div class="bar-row" data-prod="${esc(p.product)}" style="cursor:pointer">
        <div class="bar-top">
          <span class="bar-name"><span class="pc-rank">${i + 1}</span> ${esc(p.product)}</span>
          <span class="bar-val">${fmt(p.net)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${topProd[0].net ? ((p.net / topProd[0].net) * 100).toFixed(1) : 0}%"></div></div>
        <div class="bar-meta">${esc(p.category || '—')} · ${fmt(p.qty, 1)} units${p.bonusQty
    ? ` · +${fmt(p.bonusQty, 1)} bonus` : ''} · ${esc(p.vendors.slice(0, 2).join(', '))}${p.priceDrift
    ? ` · <span style="color:${p.priceDrift.pct > 0 ? '#b0503c' : '#5e8d4a'}">${p.priceDrift.pct > 0 ? '▲' : '▼'} ${fmt(Math.abs(p.priceDrift.pct), 1)}%</span>` : ''}</div>
      </div>`).join('')}
    </div>

    <div class="kicker" style="margin-top:22px">Where the money goes</div>
    <h2 class="title">Top vendors <span class="hint">tap to open the vendor</span></h2>
    <div class="bar-list">${topVen.map((v, i) => `
      <div class="bar-row" data-ven="${esc(v.supplierName)}" style="cursor:pointer">
        <div class="bar-top">
          <span class="bar-name"><span class="pc-rank">${i + 1}</span> ${esc(v.supplierName)}</span>
          <span class="bar-val">${fmt(v.net)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${topVen[0].net ? ((v.net / topVen[0].net) * 100).toFixed(1) : 0}%"></div></div>
        <div class="bar-meta">${v.bills} bills · ${v.products.length} products${v.returned
    ? ` · <span style="color:#b0503c">−${fmt(v.returned)} returned</span>` : ''}${v.cashbackRate != null
    ? ` · cash back ${pc(v.cashbackRate, 0)} = ${fmt(v.cashbackDue)}` : ''}</div>
      </div>`).join('')}
    </div>

    <div class="note" id="ovNote">Every figure on this tab is ex-VAT and before returns unless it
      says otherwise. Tapping a product opens tab 02; tapping a vendor opens tab 03.</div>`;

  $('ov').innerHTML = `${h}</section>`;
}

/* ----------------------------------------------------------- 02 · products */

/* The period chips the pack offers, as offsets from the report's own range. */
const PERIODS = [
  { key: 'ytd', label: 'Year to date' },
  { key: 'q', label: 'This quarter' },
  { key: 'mtd', label: 'Month to date' },
  { key: 'last', label: 'Last month' },
];

function renderProducts(D) {
  const P = D.purchases;
  const consumable = new Set(D.groups.filter((g) => g.consumable).map((g) => g.key));
  const inCatalogue = new Set(Object.keys(DATA.catalogueByName || {}));

  let h = `<section>
    <div class="kicker">02 — Products</div>
    <h2 class="title">One product, end to end</h2>
    <p class="sub">Pick a product to see what it cost, what is on the shelf, what sold, in which
      branch and by which doctor. ${fmt(P.products.length)} products bought in
      ${esc(D.from)} → ${esc(D.to)}.</p>

    <div class="controls">
      <div class="ctl-lbl">Product</div>
      <input class="prod-input" id="prodIn" list="prodList"
        placeholder="Type to search a product…" autocomplete="off">
      <datalist id="prodList">${P.products
    .filter((p) => inCatalogue.has(String(p.product).toLowerCase()))
    .map((p) => `<option value="${esc(p.product)}"></option>`).join('')}</datalist>
      <div class="ctl-lbl" style="margin-top:14px">Period</div>
      <div class="chips" id="chips">${PERIODS.map((x) => `
        <button class="chip" data-period="${x.key}">${esc(x.label)}</button>`).join('')}
      </div>
      <div class="ctl-lbl" style="margin-top:14px">Custom range</div>
      <div class="custrange">
        <input type="date" id="cFrom" value="${esc(D.from)}">
        <span class="cr-to">→</span>
        <input type="date" id="cTo" value="${esc(D.to)}">
        <button id="cApply">Apply</button>
      </div>
    </div>

    <div id="prDetail"></div>

    <div class="list-wrap">
      <div class="list-head"><h2>All products</h2>
        <span class="cnt" id="listCnt">${fmt(P.products.length)} bought · ${inCatalogue.size} in the stock catalogue</span></div>
      <input class="list-search" id="listSearch" placeholder="Filter the list…" autocomplete="off">
      <div class="ilist" id="ilist">${P.products.map((p) => {
    const known = inCatalogue.has(String(p.product).toLowerCase());
    return `<div class="il-row" data-search-target${known ? ` data-prod="${esc(p.product)}"` : ''}
        ${known ? 'style="cursor:pointer"' : 'style="opacity:.6"'}>
        <div class="il-left">
          <div class="il-name">${esc(p.product)}${known ? ' <span class="pc-chevron">&#9656;</span>'
      : ' <span class="ex-pill unk">not stock</span>'}</div>
          <div class="il-meta">${esc(p.category || '—')} · ${fmt(p.qty, 1)} units${p.bonusQty
      ? ` · +${fmt(p.bonusQty, 1)} bonus` : ''} · ${esc(p.vendors.slice(0, 2).join(', '))}${p.vendors.length > 2 ? ` +${p.vendors.length - 2}` : ''}
            ${p.priceDrift ? ` · <span style="color:${p.priceDrift.pct > 0 ? '#b0503c' : '#5e8d4a'}">${p.priceDrift.pct > 0 ? '▲' : '▼'} ${fmt(Math.abs(p.priceDrift.pct), 1)}% ${esc(p.priceDrift.firstAt)} → ${esc(p.priceDrift.lastAt)}</span>` : ''}</div>
        </div>
        <div class="il-right">
          <div class="il-amt">${fmt(p.net)}</div>
          <div class="il-sub">${p.unitCost == null ? '—' : `${fmt(p.unitCost, 2)}/unit`}</div>
        </div>
      </div>`;
  }).join('')}</div>
    </div>

    <div class="tg-note">A row is only openable when the product is in the <strong>stock
      catalogue</strong> — the ${inCatalogue.size} consumables the source pack listed. Everything
      else on a bill (rent, advertising, a device part) has no stock or sales to show, so it is
      shown greyed rather than offered and then apologised for.
      <strong>A bonus line is free stock</strong> — real quantity, zero price — and is left out of
      every unit cost, because averaging it in drags the figure below anything ever paid.</div>`;

  $('pr').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------------ 03 · vendors */

let VEN_SUB = 'score';

function renderVendors(D) {
  const V = D.vendors;
  const sub = VEN_SUB;

  let h = `<section>
    <div class="kicker">03 — Vendors</div>
    <h2 class="title">Suppliers, cash back and payments</h2>

    <div class="subtabs" id="vnSub">
      <button class="${sub === 'score' ? 'active' : ''}" data-vsub="score">Purchases</button>
      <button class="${sub === 'cash' ? 'active' : ''}" data-vsub="cash">Cash back</button>
      <button class="${sub === 'pay' ? 'active' : ''}" data-vsub="pay">Payments</button>
    </div>`;

  if (sub === 'score') {
    h += `<p class="sub">${esc(D.from)} to ${esc(D.to)}, ex-VAT and before returns.
        <strong>Tap a vendor</strong> for every product it sold us.</p>
      <div class="search-row">
        <input class="search-input" id="vnSearch" type="search"
          placeholder="Search supplier or product…" autocomplete="off">
        <div class="search-btns">
          <button class="expand-btn" data-exall="vs">Expand all</button>
          <button class="expand-btn" data-colall="vs">Collapse all</button>
        </div>
      </div>`;

    V.rows.forEach((v, i) => {
      h += `<div class="prod-card" data-search-target>
        <div class="pc-top">
          <div class="pc-left">
            <span class="pc-rank">${i + 1}</span>
            <span class="pc-name">${esc(v.supplierName)}</span>
            <span class="pc-chevron">&#9656;</span>
            <div>${v.cashbackRate != null
    ? `<span class="ex-pill ok">cash back ${pc(v.cashbackRate, 0)}</span>` : ''}${v.returned
    ? ' <span class="ex-pill exp">has returns</span>' : ''}</div>
          </div>
          <div class="pc-right">
            <div class="pc-ex">${fmt(v.net)}</div>
            <div class="pc-inc">ex-VAT</div>
          </div>
        </div>
        <div class="pc-meta" style="flex-wrap:wrap">
          <span>${v.bills} bills · ${v.lines} lines · ${v.products.length} products</span>
          <span>${esc(v.firstDate || '')} → ${esc(v.lastDate || '')}</span>
          ${v.returned ? `<span>Returned <strong style="color:#b0503c">−${fmt(v.returned)}</strong>
            · net ${fmt(v.netOfReturns)}</span>` : ''}
          ${v.cashbackDue != null ? `<span>Cash back <strong>${fmt(v.cashbackDue)}</strong></span>` : ''}
          ${v.targetLabel ? `<span>${esc(v.targetLabel)}</span>` : ''}
        </div>
        <div class="pc-sellers">
          <div class="pc-sellers-title">
            <span>All <strong>${v.products.length}</strong> products</span>
            <span>By spend &darr;</span>
          </div>
          ${v.products.map((p) => `<div class="lot-row">
            <div class="lot-info">
              <div class="lot-name">${esc(p.product)}</div>
              <div class="lot-meta">${esc(p.category || '—')} · ${fmt(p.qty, 1)} units${p.bonusQty
    ? ` · +${fmt(p.bonusQty, 1)} bonus (${fmt(p.bonusPct)}%)` : ''} ·
                ${p.lines} line${p.lines === 1 ? '' : 's'}${p.unitCost == null ? ''
    : ` · ${fmt(p.unitCost, 2)}/unit paid`}</div>
            </div>
            <div class="lot-money">
              <div class="lot-ex">${fmt(p.net)}</div>
              <div class="lot-inc">ex-VAT</div>
            </div>
          </div>`).join('')}
          <div class="lot-row tot">
            <div class="lot-info">
              <div class="lot-name"><strong>Total — reconciles to card</strong></div>
              <div class="lot-meta">${v.lines} lines across ${v.products.length} products</div>
            </div>
            <div class="lot-money">
              <div class="lot-ex"><strong>${fmt(v.products.reduce((t, p) => t + p.net, 0))}</strong></div>
              <div class="lot-inc">ex-VAT</div>
            </div>
          </div>
        </div>
      </div>`;
    });

    h += `<div class="tg-note">A vendor's card total is its purchase LINES; the headline is its
      bill headers. Where the two differ, the bills carry money no line itemises — see the
      residual on tab 01.</div>`;
  }

  if (sub === 'cash') {
    const withRate = V.rows.filter((v) => v.cashbackRate != null);
    const near = V.rows.filter((v) => v.termNearMiss);
    h += `<p class="sub">Cash back is due on the figure <strong>after returns</strong>.
        Rates are agreements held in <code>VendorTerm</code> and edited in
        <a href="/admin#commission">Admin → Commission</a> — nothing in Odoo records them.</p>

      <div class="kpi-grid">
        <div class="kpi accent"><div class="kpi-label">Cash back due</div>
          <div class="kpi-value">${fmt(V.totals.cashbackDue)}</div>
          <div class="kpi-sub">${V.totals.vendorsWithRate} suppliers with an agreed rate</div></div>
        <div class="kpi"><div class="kpi-label">Net of returns</div>
          <div class="kpi-value sm">${fmt(V.totals.netOfReturns)}</div>
          <div class="kpi-sub">the basis it is due on</div></div>
        <div class="kpi"><div class="kpi-label">No agreement</div>
          <div class="kpi-value sm">${V.totals.vendorsWithoutRate}</div>
          <div class="kpi-sub">not 0% — nobody recorded a rate</div></div>
        <div class="kpi"><div class="kpi-label">With a target</div>
          <div class="kpi-value sm">${V.totals.vendorsWithTarget}</div>
          <div class="kpi-sub">volume agreements</div></div>
      </div>

      <div class="tw"><table class="ltab"><thead><tr>
        <th>Supplier</th><th class="n">Net purchase</th><th class="n">Returned</th>
        <th class="n">Net of returns</th><th class="n">Rate</th><th class="n">Cash back</th>
        <th>Basis</th><th>Target</th>
      </tr></thead><tbody>${withRate.map((v) => `<tr>
        <td class="nm">${esc(v.supplierName)}</td>
        <td class="n">${fmt(v.net)}</td>
        <td class="n">${v.returned ? `<span style="color:#b0503c">−${fmt(v.returned)}</span>` : '—'}</td>
        <td class="n">${fmt(v.netOfReturns)}</td>
        <td class="n">${pc(v.cashbackRate, 0)}</td>
        <td class="n"><strong>${fmt(v.cashbackDue)}</strong></td>
        <td>${esc(v.cashbackBasis || '—')}</td>
        <td>${esc(v.targetLabel || '')}${v.targetAmount ? ` <span class="vat-tag">${fmt(v.targetAmount)}</span>` : ''}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td class="nm"><strong>Total</strong></td>
        <td class="n">${fmt(withRate.reduce((t, v) => t + v.net, 0))}</td>
        <td class="n">−${fmt(withRate.reduce((t, v) => t + v.returned, 0))}</td>
        <td class="n">${fmt(withRate.reduce((t, v) => t + v.netOfReturns, 0))}</td>
        <td></td><td class="n"><strong>${fmt(V.totals.cashbackDue)}</strong></td>
        <td colspan="2"></td></tr></tfoot></table></div>`;

    if (near.length) {
      h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
        <strong>${near.length} suppliers nearly matched an agreement and were refused.</strong>
        Only an exact name may carry a rate: matched loosely, 21 agreements reached 63 of
        ${V.rows.length} suppliers and owed cash back on rent and advertising.
        ${near.slice(0, 6).map((v) => `${esc(v.supplierName)} → ${esc(v.termNearMiss)}`).join(' · ')}.
        Fix the spelling in Admin if one of these is genuinely the same company.</div>`;
    }
    if (V.orphanReturns.length) {
      h += `<div class="tg-note"><strong>Returns with no matching supplier in this window:</strong>
        ${V.orphanReturns.map((o) => `${esc(o.supplierName)} ${fmt(o.value)}`).join(' · ')}.
        They cannot be netted off anything, and dropping them would make tab 04 disagree with
        this one.</div>`;
    }
  }

  if (sub === 'pay') {
    const Y = D.payments;
    const top = Y.months.length ? Math.max(...Y.months.map((m) => m.amount)) : 0;
    h += `<p class="sub">Cash leaving the bank, ${esc(D.from)} to ${esc(D.to)}.</p>
      <div class="tg-note"><strong>${esc(Y.note)}</strong> ${fmt(Y.totals.amount)} left the bank
        against ${fmt(D.purchases.totals.net)} of invoices arriving. A cheque this month can
        settle a bill from three months ago, so the two are not expected to agree.</div>

      <div class="leg"><span><i class="buy"></i>Paid · by month</span>
        <span>payment count shown per month</span></div>
      <div class="bars"><div class="bar-list">${Y.months.map((m) => barCol(m.label, m.amount, top, `${m.count} paid`)).join('')}</div></div>

      <h3 class="subtitle">By supplier</h3>
      <div class="tw scrolly" style="--h:420px"><table class="ltab"><thead><tr>
        <th>Supplier</th><th class="n">Paid</th><th class="n">Payments</th><th class="n">Purchased</th>
      </tr></thead><tbody>${Y.vendors.map((v) => {
      const bought = (V.rows.find((x) => x.supplierName === v.supplierName) || {}).net;
      return `<tr>
        <td class="nm">${esc(v.supplierName)}</td>
        <td class="n">${fmt(v.amount)}</td><td class="n">${v.count}</td>
        <td class="n">${bought == null ? '<span style="color:var(--muted)">nothing this window</span>' : fmt(bought)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>

      <h3 class="subtitle">How it was paid</h3>
      <div class="tw"><table class="ltab tight"><thead><tr>
        <th>Method</th><th class="n">Amount</th><th class="n">Count</th>
      </tr></thead><tbody>${Y.methods.map((m) => `<tr>
        <td class="nm">${esc(m.method)}</td><td class="n">${fmt(m.amount)}</td><td class="n">${m.count}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('vs').innerHTML = `${h}</section>`;
}

/* ------------------------------------------------------------ 04 · returns */

function renderReturns(D) {
  const R = D.returns;
  let h = `<section>
    <div class="kicker">04 — Returns</div>
    <h2 class="title">Sent back to suppliers</h2>
    <p class="sub">Deducted from net purchases before cash back is calculated on tab 03.</p>`;

  if (R.missing) {
    h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>${esc(R.reason)}</strong></div></section>`;
    $('rt').innerHTML = h;
    return;
  }

  h += `<div class="tg-note" style="border-left:3px solid #c98a2e">
      <strong>There is not one negative purchase line in the cache.</strong> These
      ${R.totals.rows} rows carrying ${fmt(R.totals.value)} are the only record of goods going
      back that exists anywhere this app can read — ${R.seeded} of them seeded from the source
      pack (<code>${esc(R.sources.join(', '))}</code>).
      ${R.dated === 0 ? 'None carries a date, because the pack does not record one, so they sit on the whole window rather than a month — a monthly view of them would be an invention.' : ''}
      Upload a real export in <a href="/admin#uploads">Admin → Uploads</a> and every figure
      built on them switches over with no code change.</div>

    <div class="kpi-grid">
      <div class="kpi accent"><div class="kpi-label">Returned</div>
        <div class="kpi-value">${fmt(R.totals.value)}</div>
        <div class="kpi-sub">${R.totals.rows} rows · ${R.totals.suppliers} suppliers</div></div>
      <div class="kpi"><div class="kpi-label">Share of purchases</div>
        <div class="kpi-value sm">${pc(D.purchases.totals.net ? R.totals.value / D.purchases.totals.net : null)}</div>
        <div class="kpi-sub">of ${fmt(D.purchases.totals.net)} bought</div></div>
    </div>

    <h3 class="subtitle">By supplier</h3>
    <div class="tw"><table class="ltab"><thead><tr>
      <th>Supplier</th><th class="n">Value</th><th class="n">Units</th><th class="n">Rows</th><th style="width:30%"></th>
    </tr></thead><tbody>${R.bySupplier.map((s) => `<tr>
      <td class="nm">${esc(s.supplierName)}</td>
      <td class="n"><strong>${fmt(s.value)}</strong></td>
      <td class="n">${fmt(s.qty, 1)}</td><td class="n">${s.rows}</td>
      <td>${bar(R.bySupplier[0].value ? (s.value / R.bySupplier[0].value) * 100 : 0, '#b0503c')}</td>
    </tr>`).join('')}</tbody></table></div>

    <h3 class="subtitle">Every row</h3>
    <div class="tw scrolly" style="--h:320px"><table class="ltab"><thead><tr>
      <th>Product</th><th>Supplier</th><th class="n">Units</th><th class="n">Unit cost</th>
      <th class="n">Value</th><th>Date</th><th>Source</th>
    </tr></thead><tbody>${R.rows.map((r) => `<tr>
      <td class="nm">${esc(r.product)}</td><td>${esc(r.supplierName)}</td>
      <td class="n">${fmt(r.qty, 1)}</td><td class="n">${fmt(r.unitCost, 2)}</td>
      <td class="n">${fmt(r.value)}</td><td>${esc(r.date || '—')}</td>
      <td><span class="pill">${esc(r.source)}</span></td>
    </tr>`).join('')}</tbody></table></div>`;

  $('rt').innerHTML = `${h}</section>`;
}

/* --------------------------------------------------------- 05 · purchasing */

let PUR_SUB = 'mon';

/**
 * Purchasing, in the four cuts the source pack splits it into.
 *
 * PAYMENTS ARE NOT HERE. They were, and they were also on tab 03 under its own
 * Payments sub-tab — the same figures rendered twice, which is how two tabs
 * start disagreeing after somebody edits one. The pack puts payments under
 * Vendors and keeps this tab about what was BOUGHT, so that is where they live.
 */
function renderPurchasing(D) {
  const P = D.purchases;
  const sub = PUR_SUB;
  const drift = P.products.filter((p) => p.priceDrift)
    .sort((a, b) => Math.abs(b.priceDrift.pct) - Math.abs(a.priceDrift.pct));
  const targets = D.vendors.rows.filter((v) => v.targetLabel);

  let h = `<section>
    <div class="kicker">05 — Purchasing</div>
    <h2 class="title">What was bought, four ways</h2>

    <div class="subtabs" id="puSub">
      <button class="${sub === 'mon' ? 'active' : ''}" data-psub="mon">By month</button>
      <button class="${sub === 'cat' ? 'active' : ''}" data-psub="cat">By category</button>
      <button class="${sub === 'price' ? 'active' : ''}" data-psub="price">Price moves</button>
      <button class="${sub === 'tgt' ? 'active' : ''}" data-psub="tgt">2026 targets</button>
    </div>`;

  if (sub === 'mon') {
    const top = P.months.length ? Math.max(...P.months.map((m) => m.net)) : 0;
    h += `<p class="sub">Purchase invoices by the month they were raised, ex-VAT and before
        returns. ${esc(D.from)} to ${esc(D.to)}.</p>
      <div class="leg"><span><i class="buy"></i>Purchases · before returns</span>
        <span>bill count shown per month</span></div>
      <div class="bars"><div class="bar-list">${P.months.map((m) => barCol(m.label, m.net, top, `${m.bills} bills · ${m.vendors} suppliers`)).join('')}</div></div>

      <div class="cat-list">${P.months.map((m) => `
        <div class="cat-item">
          <div class="ci-left"><div class="ci-name">${esc(m.label)} <span class="vat-tag">${esc(m.month)}</span></div>
            <div class="ci-meta">${m.bills} bills · ${m.vendors} suppliers</div></div>
          <div class="ci-right"><div class="ci-amt">${fmt(m.net)}</div>
            <div class="ci-pct">${pc(P.totals.net ? m.net / P.totals.net : null)}</div></div>
        </div>`).join('')}
        <div class="cat-item total">
          <div class="ci-left"><div class="ci-name">TOTAL</div>
            <div class="ci-meta">${fmt(P.totals.bills)} bills · ${fmt(P.totals.vendors)} suppliers</div></div>
          <div class="ci-right"><div class="ci-amt">${fmt(P.totals.net)}</div></div>
        </div>
      </div>
      <div class="tg-note">A month here is when the INVOICE was raised, not when it was paid —
        payments are on tab 03 under Payments, and a cheque this month can settle a bill from
        three months ago.</div>`;
  }

  if (sub === 'cat') {
    const top = P.categories.length ? P.categories[0].net : 0;
    h += `<p class="sub">Every purchase category Odoo puts on a line, largest first.
        ${fmt(P.categories.length)} categories across ${fmt(P.totals.lines)} lines.</p>
      <div class="bar-list">${P.categories.map((c) => barRowP(
    esc(c.category),
    (D.groups.find((g) => g.key === c.group) || {}).label || c.group,
    `${c.lines} lines · ${c.products} products · ${fmt(c.qty, 1)} units`,
    c.net,
    top ? (c.net / top) * 100 : 0,
    P.reconciles.lineNet ? c.net / P.reconciles.lineNet : null,
  )).join('')}</div>
      <div class="tg-note">The groups on tab 01 are these categories rolled up by their prefix —
        <code>Injection/</code>, <code>Devices/</code>, <code>Service/</code> — and the two sum to
        the same ${fmt(P.reconciles.lineNet)} of purchase lines.</div>`;
  }

  if (sub === 'price') {
    h += `<p class="sub">Products bought at more than one unit price over the window,
        biggest move first. ${drift.length} of ${fmt(P.products.length)} products moved.</p>
      <div class="tg-note">First and last are by DATE, not by row order: a bill entered late for
        an early date would otherwise read as a price rise that never happened. Bonus lines are
        excluded, since their price is zero by definition.</div>`;
    if (!drift.length) {
      h += '<div class="tg-note">No product was bought at two different prices in this window.</div>';
    } else {
      h += `<div class="tw scrolly" style="--h:460px"><table class="ltab"><thead><tr>
          <th>Product</th><th>Category</th><th class="n">First</th><th>On</th>
          <th class="n">Last</th><th>On</th><th class="n">Move</th><th class="n">Buys</th>
          <th class="n">Spend</th>
        </tr></thead><tbody>${drift.map((p) => `<tr>
          <td class="nm">${esc(p.product)}</td>
          <td>${esc(p.category || '—')}</td>
          <td class="n">${fmt(p.priceDrift.first, 2)}</td><td>${esc(p.priceDrift.firstAt)}</td>
          <td class="n">${fmt(p.priceDrift.last, 2)}</td><td>${esc(p.priceDrift.lastAt)}</td>
          <td class="n" style="color:${p.priceDrift.pct > 0 ? '#b0503c' : '#5e8d4a'}">
            ${p.priceDrift.pct > 0 ? '▲' : '▼'} ${fmt(Math.abs(p.priceDrift.pct), 1)}%</td>
          <td class="n">${p.priceDrift.observations}</td>
          <td class="n">${fmt(p.net)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    }
  }

  if (sub === 'tgt') {
    h += `<p class="sub">Volume agreements with suppliers — "1,000 vials", not a money figure —
        held in <code>VendorTerm</code> beside the cash-back rate and edited in
        <a href="/admin#commission">Admin → Commission</a>.</p>
      <div class="tg-note">The source pack tracked achievement against these from its own
        quantity file, which this app does not hold. What is shown is the agreement itself and
        the purchases against that supplier, so the gap is visible without being invented.</div>`;
    if (!targets.length) {
      h += '<div class="tg-note">No vendor target is stored for this year.</div>';
    } else {
      const top = Math.max(...targets.map((v) => v.net), 1);
      h += `<div class="bar-list">${targets.map((v) => barRowP(
    esc(v.targetLabel),
    v.supplierName,
    `${v.bills} bills · target ${fmt(v.targetAmount)}${v.cashbackRate != null
      ? ` · cash back ${pc(v.cashbackRate, 0)} = ${fmt(v.cashbackDue)}` : ''}`,
    v.net,
    (v.net / top) * 100,
    null,
  )).join('')}</div>`;
    }
  }

  $('pu').innerHTML = `${h}</section>`;
}

/** A bar row with a tag and an optional share. */
const barRowP = (name, tag, meta, ex, pct, share) =>
  `<div class="bar-row" data-search-target>
    <div class="bar-top">
      <span class="bar-name">${name}${tag ? ` <span class="pill">${esc(tag)}</span>` : ''}</span>
      <span class="bar-val">${fmt(ex)}</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, Math.max(0.5, pct)).toFixed(1)}%"></div></div>
    <div class="bar-meta">${meta}${share == null ? '' : ` · ${pc(share)}`}</div>
  </div>`;


/* -------------------------------------------------------------------- boot */

function paint() {
  const D = DATA;
  $('hPeriod').textContent = `${D.from} → ${D.to}`;
  $('hNet').textContent = fmt(D.purchases.totals.net);
  $('hNetUnit').textContent = `${fmt(D.purchases.totals.bills)} bills · ${fmt(D.purchases.totals.vendors)} suppliers`;
  $('hCons').textContent = fmt(D.purchases.totals.consumableNet);
  $('hRet').textContent = D.returns.missing ? '—' : fmt(D.returns.totals.value);
  $('hRetUnit').textContent = D.returns.missing ? 'none loaded'
    : `${D.returns.totals.rows} rows · ${D.returns.seeded ? 'seeded' : 'uploaded'}`;
  $('hCb').textContent = fmt(D.vendors.totals.cashbackDue);
  $('hCbUnit').textContent = `${D.vendors.totals.vendorsWithRate} suppliers with an agreed rate`;
  $('rangeline').textContent = `${fmt(D.purchases.totals.lines)} purchase lines`
    + ` · breakdown ${D.purchases.reconciles.compositionGap === 0 ? 'balances exactly' : `out by ${fmt(D.purchases.reconciles.compositionGap)}`}`
    + ` · ${fmt(D.purchases.reconciles.residual)} on bill headers with no lines`;

  renderOverview(D); renderProducts(D); renderVendors(D);
  renderReturns(D); renderPurchasing(D);
}

async function load() {
  $('err').textContent = '';
  $('dot').className = 'dot';
  $('status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    DATA = await api(`/api/procurement?${q}`);
    /* The purchase table is keyed by product NAME and the drill-down by Odoo id,
       so the bridge is built once here rather than per click. */
    DATA.catalogueByName = {};
    for (const c of DATA.catalogue || []) DATA.catalogueByName[String(c.name).toLowerCase()] = c.odooId;
    paint();
    $('dot').className = 'dot ok';
    $('status').textContent = `${fmt(DATA.purchases.totals.vendors)} suppliers`;
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
  } else if (p === 'mtd') {
    $('from').value = `${iso(now).slice(0, 7)}-01`; $('to').value = iso(now);
  } else {
    $('from').value = `${y}-01-01`; $('to').value = iso(now);
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

/* Everything clickable, delegated once — the panels are rebuilt on every range
   change, and the CSP forbids the inline `onclick` the source pack uses. */
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;

  /* Vendor sub-tabs. Kept in a module variable rather than re-fetched: the
     three views are three readings of one payload we already have. */
  const vsub = e.target.closest('[data-vsub]');
  if (vsub) { VEN_SUB = vsub.dataset.vsub; renderVendors(DATA); return; }

  const psub = e.target.closest('[data-psub]');
  if (psub) { PUR_SUB = psub.dataset.psub; renderPurchasing(DATA); return; }

  /* A vendor on the overview jumps to its card on tab 03, opened. Landing on a
     tab and leaving the reader to find the row again is most of the friction in
     a report like this. */
  const ven = e.target.closest('[data-ven]');
  if (ven) {
    VEN_SUB = 'score';
    renderVendors(DATA);
    Shell.showPanel('vs');
    const name = ven.dataset.ven;
    const card = [...$('vs').querySelectorAll('.prod-card')]
      .find((c) => (c.querySelector('.pc-name') || {}).textContent === name);
    if (card) {
      card.classList.add('expanded');
      if (card.scrollIntoView) card.scrollIntoView({ block: 'center' });
    }
    return;
  }

  /* A product row anywhere opens the drill-down on tab 02. */
  const open = e.target.closest('[data-prod]');
  if (open) {
    Shell.showPanel('pr');
    const box = $('prodIn');
    if (box) box.value = open.dataset.prod;
    openProduct(open.dataset.prod);
    return;
  }

  /* Period chips and the custom range. Both reload, because the server does the
     cutting — a client-side filter would need the whole year in the payload. */
  const chip = e.target.closest('[data-period]');
  if (chip) { preset(chip.dataset.period === 'q' ? 'quarter' : chip.dataset.period === 'last' ? 'lastmonth' : chip.dataset.period); load(); return; }
  if (e.target.id === 'cApply') {
    const f = $('cFrom').value;
    const t = $('cTo').value;
    if (f && t && f <= t) { $('from').value = f; $('to').value = t; load(); }
    else $('err').textContent = 'Give a range that starts before it ends.';
    return;
  }

  const exAll = e.target.closest('[data-exall]');
  if (exAll) {
    $(exAll.dataset.exall).querySelectorAll('.prod-card')
      .forEach((c) => c.classList.add('expanded'));
    return;
  }
  const colAll = e.target.closest('[data-colall]');
  if (colAll) {
    $(colAll.dataset.colall).querySelectorAll('.prod-card')
      .forEach((c) => c.classList.remove('expanded'));
    return;
  }

  const head = e.target.closest('.acc-h');
  if (head) { head.parentElement.classList.toggle('open'); return; }

  /* A card opens from its head, not from inside it — a click on a product row
     you were reading must not collapse the card you were reading it in. */
  const card = e.target.closest('.prod-card');
  if (card && !e.target.closest('.pc-sellers, [data-prod]')) {
    card.classList.toggle('expanded');
  }
});

/* The product picker. `change` rather than `input`, so it fires when a datalist
   option is chosen and not on every keystroke. */
document.addEventListener('change', (e) => {
  if (e.target.id === 'prodIn' && e.target.value.trim()) openProduct(e.target.value.trim());
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.classList) return;
  if (!el.classList.contains('searchbox') && !el.classList.contains('search-input')
    && !el.classList.contains('list-search')) return;
  const q = el.value.toLowerCase().trim();
  const panel = el.closest('.panel');
  if (!panel) return;
  let shown = 0;
  panel.querySelectorAll('[data-search-target]').forEach((n) => {
    const hit = !q || n.textContent.toLowerCase().includes(q);
    n.style.display = hit ? '' : 'none';
    if (hit) shown += 1;
  });
  /* The count beside "All products" follows the filter — a list that says 197
     while showing 3 is a list nobody trusts. */
  const cnt = panel.querySelector('#listCnt');
  if (cnt && q) cnt.textContent = `${fmt(shown)} shown of ${fmt(DATA.purchases.products.length)}`;
  else if (cnt) cnt.textContent = `${fmt(DATA.purchases.products.length)} bought`
    + ` · ${Object.keys(DATA.catalogueByName || {}).length} in the stock catalogue`;
});

Shell.mountTabs();
Shell.stickyBar();
preset('ytd');
load();
