/* ============================================================
   Report 08 — Inventory Performance.

   Four questions, and the order matters: how much stock is there, how much of
   it is about to expire, how long will it last, and did any of the at-risk
   stock actually sell.

   READ COVER, NOT QUANTITY. That is the source pack's own instruction and it is
   the whole point of the report: 92,917 units sit in HQ and 1,423 in Alex, and
   neither number says whether anything is about to run out. Cover — months of
   stock at the current rate of use — does.

   THE BANDS ARE THE PACK'S, VERBATIM, and they are constants rather than
   literals scattered through the render code because every one of them is a
   business decision somebody may want to change:

       IDEAL_MONTHS 2.0   what "enough" means
       CRIT         1.0   under a month left
       BELOW        2.0   under the ideal
       HEAL         4.0   above this is money sitting still
       NOM_DAYS      30   a month, for turning a range into a monthly rate

   WHERE EACH FIGURE COMES FROM, because three different sources are in play and
   a card that does not say which is a card nobody can check:

     on hand      StockQuant, the latest snapshot at or before the end date.
                  A SNAPSHOT, not a ledger. HELD IN DOSES, NOT UNITS — see below.
     used         InvoiceLine, through ConsumableLink, divided by doses per
                  unit. This is what was SOLD, which is the only proxy for
                  consumption we have.
     value        the weighted average purchase price — see lib/consumables.js
     expiry       ExpiryLot, a one-off import that does not refresh

   WHAT THIS CANNOT DO, and says so on the page rather than implying otherwise:
   THERE ARE NO STOCK MOVES IN THE CACHE. The pack shows opening → in → out →
   closing per product from Odoo `stock.move`, live. We hold snapshots. So
   "used" here is sales-derived, "received" is purchase-derived, and the
   difference between (opening + received − used) and the next snapshot is
   reported as a RECONCILIATION rather than presented as movement. That gap is
   real information — it is wastage, breakage, transfers and unbilled use — and
   dressing it up as a movement figure would hide exactly the thing worth
   seeing.
   ODOO STOCKS DOSES, NOT UNITS, and the difference is 4.6×. Botox is bought as
   a 100-dose vial and both stocked and invoiced one dose at a time, so the
   snapshot says 7,286 of Metox where the fridge holds 72.9 vials. Every
   quantity here therefore travels twice:

       onHandDoses   exactly what Odoo says, and the basis every MONEY figure
                     uses, because `BillLine.qty` is in the same unit (6,000
                     Metox at 15 EGP is a dose price, not a vial price)
       onHandUnits   doses ÷ dosesPerUnit — vials, syringes, pens. What a person
                     counting the fridge would say, and what the headline shows

   MEASURED: converted, our snapshot totals 4,153.3 units against the source
   pack's 4,081.9 — 1.7% apart, on a snapshot taken a different day. Unconverted
   it is 18,705.7, which would have been the headline.
   ============================================================ */

const { prisma } = require('./db.js');
const C = require('./consumables.js');

const IDEAL_MONTHS = 2.0;
const NOM_DAYS = 30;
const CRIT = 1.0;
const BELOW = 2.0;
const HEAL = 4.0;

/** The invoice cache starts here; nothing before it can be a rate of use. */
const CACHE_FLOOR = '2026-01-01';

/**
 * The bands, most urgent first. An ORDERED RULE LIST, like the injectable
 * families in lib/doctors.js, for the same reason: the tests overlap, so the
 * order is the definition. `unk` last because "we have never sold this" must
 * not be reported as healthy — a dormant product with 400 units of stock is not
 * fine, it is money that stopped moving.
 */
const BANDS = [
  /* FIRST, because it is not a verdict about the stock — it is a verdict about
     us. 57 of the 101 catalogue products have no resolved service link, so no
     sale of them is visible and no rate of use can be computed. Filing those as
     "Dormant" would report 57 products as having no demand when what we
     actually have is no way to see it, and a dormant product is something you
     act on. */
  { key: 'nolink', label: 'Not linked', test: (cover, used, hand, linked) => !linked },
  { key: 'exp', label: 'Stock-out', test: (cover, used, hand) => used > 0 && hand <= 0 },
  { key: 'unk', label: 'Dormant', test: (cover, used) => !(used > 0) },
  { key: 'cri', label: 'Critical', test: (cover) => cover < CRIT },
  { key: 'war', label: 'Below ideal', test: (cover) => cover < BELOW },
  { key: 'ok', label: 'Healthy', test: (cover) => cover <= HEAL },
  { key: 'wat', label: 'Overstock', test: () => true },
];

const bandOf = (cover, used, hand, linked = true) =>
  BANDS.find((b) => b.test(cover, used, hand, linked)) || BANDS[BANDS.length - 1];

/** Short is the three bands that need doing something about. */
const SHORT = new Set(['exp', 'cri', 'war']);

/* HQ/Stock and ALXWH/Stock. Named by id because the label is a free-text Odoo
   field: renaming a location must not silently reclassify its stock as a
   branch's, which is what a name test would do. */
const WAREHOUSE_LOCATION_IDS = new Set([8, 555]);

const num = (v) => (v == null ? 0 : Number(v));
/* `|| 0` is not redundant: rounding a value a hair below zero yields -0, and
   `Object.is(-0, 0)` is false — so an identity check on a difference that IS
   zero fails, which is exactly how the composition reconciliation first
   "failed" while being perfectly correct. */
const r2 = (v) => (Math.round((num(v) + Number.EPSILON) * 100) / 100) || 0;
const r3 = (v) => (Math.round((num(v) + Number.EPSILON) * 1000) / 1000) || 0;
const ymd = (d) => (d ? d.toISOString().slice(0, 10) : null);
const days = (from, to) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);

/**
 * On hand per consumable, at the last snapshot at or before `to`.
 *
 * Deliberately NOT the newest snapshot: asking for July and being shown
 * September's stock would make the whole report unreadable, and it is the kind
 * of wrong that looks right.
 */
async function stockAt(to) {
  const latest = await prisma.stockQuant.aggregate({
    where: to ? { takenAt: { lte: new Date(`${to}T23:59:59.999Z`) } } : {},
    _max: { takenAt: true },
  });
  const takenAt = latest._max.takenAt;
  if (!takenAt) return { takenAt: null, byId: new Map(), locations: [] };

  const quants = await prisma.stockQuant.findMany({ where: { takenAt } });
  const cat = await C.catalogue();

  const byId = new Map();
  const locations = new Map();
  for (const q of quants) {
    // An alias's stock belongs to the product that survives, not to itself.
    const id = cat.canonical(q.productId);
    if (!cat.byId.has(id)) continue;
    const row = byId.get(id) || { odooId: id, qty: 0, reserved: 0, byLocation: [] };
    row.qty += num(q.quantity);
    row.reserved += num(q.reserved);
    row.byLocation.push({
      location: q.locationName,
      locationId: q.locationId,
      warehouse: WAREHOUSE_LOCATION_IDS.has(q.locationId),
      qty: r3(q.quantity),
    });
    byId.set(id, row);

    const L = locations.get(q.locationId) || {
      locationId: q.locationId, name: q.locationName,
      warehouse: WAREHOUSE_LOCATION_IDS.has(q.locationId), qty: 0, skus: 0,
    };
    L.qty += num(q.quantity);
    L.skus += 1;
    locations.set(q.locationId, L);
  }
  for (const r of byId.values()) {
    r.qty = r3(r.qty);
    r.byLocation.sort((a, b) => b.qty - a.qty);
  }

  return {
    takenAt,
    byId,
    locations: [...locations.values()].map((l) => ({ ...l, qty: r3(l.qty) }))
      .sort((a, b) => b.qty - a.qty),
  };
}

/**
 * Units of each consumable used over the window, from what was invoiced.
 *
 *   -> { byId: Map<odooId, { units, doses, services }>, linkCoverage }
 *
 * `units = doses / dosesPerUnit`. Dysport is bought as a 500-unit vial and
 * invoiced one unit at a time, so 287 units invoiced is 0.574 vials off the
 * shelf — reading the invoiced quantity as vials would overstate consumption
 * 500-fold and put every botox product in permanent stock-out.
 *
 * Only linked services count. An unlinked service is not consumption of zero,
 * it is consumption we cannot attribute, and `linkCoverage` says how much of
 * the mapping is in place so the shortfall is visible rather than assumed away.
 */
async function usage({ from, to }) {
  const cat = await C.catalogue();
  const L = await C.links();

  const rows = await prisma.invoiceLine.groupBy({
    by: ['productId'],
    where: {
      productId: { in: [...L.byService.keys()] },
      invoice: {
        moveType: { in: ['out_invoice', 'out_refund'] },
        invoiceDate: { gte: new Date(from), lte: new Date(to) },
      },
    },
    _sum: { quantity: true },
  });

  const byId = new Map();
  for (const r of rows) {
    const link = L.byService.get(r.productId);
    if (!link) continue;
    const id = cat.canonical(link.consumableOdooId);
    const prod = cat.byId.get(id);
    if (!prod) continue;
    const doses = num(r._sum.quantity) * (link.dosesPerService == null ? 1 : link.dosesPerService);
    const cur = byId.get(id) || { odooId: id, doses: 0, units: 0, services: 0 };
    cur.doses += doses;
    cur.units += doses / (prod.dosesPerUnit || 1);
    cur.services += 1;
    byId.set(id, cur);
  }
  for (const r of byId.values()) { r.doses = r3(r.doses); r.units = r3(r.units); }

  return {
    byId,
    /* Every catalogue product a resolved link points at, whether it sold or
       not. `byId` only holds the ones with sales, so it cannot tell the
       difference between "nothing sold" and "nothing visible". */
    linkedProducts: [...new Set([...L.byService.values()].map((v) => cat.canonical(v.consumableOdooId)))],
    linkCoverage: {
      resolved: L.resolved, unresolved: L.unresolved.length, total: L.total,
      unresolvedList: L.unresolved,
    },
  };
}

/**
 * Cover per product — the report's headline cut.
 *
 * Monthly rate is units ÷ (range days ÷ 30), so a 10-day window and a 90-day
 * window produce comparable figures. A range shorter than a fortnight makes the
 * rate jumpy, so `rateBasisDays` travels with the answer and the page says it.
 */
async function buildCover({ from, to }) {
  const cat = await C.catalogue();
  const [stock, used, cost] = await Promise.all([stockAt(to), usage({ from, to }), C.costBasis({ to })]);
  const span = days(from, to);
  const months = span / NOM_DAYS;

  const linked = new Set(used.linkedProducts);
  const rows = cat.rows.map((p) => {
    const s = stock.byId.get(p.odooId) || { qty: 0, byLocation: [] };
    const u = used.byId.get(p.odooId) || { units: 0, doses: 0 };
    /* Both sides of the cover ratio are in UNITS. Mixing them — units of stock
       over doses of use, or the reverse — is a 100× error on every botox
       product and a 1× error on every syringe, so it would look correct in
       exactly the places anyone would spot-check it. */
    const handUnits = s.qty / (p.dosesPerUnit || 1);
    const rate = months > 0 ? u.units / months : 0;
    const cover = rate > 0 ? handUnits / rate : (handUnits > 0 ? Infinity : 0);
    const band = bandOf(cover, u.units, handUnits, linked.has(p.odooId));
    const c = cost.byId.get(p.odooId);
    const cu = cost.unverified.get(p.odooId);
    return {
      odooId: p.odooId,
      name: p.name,
      category: p.category,
      vendorName: p.vendorName,
      unit: p.unit,
      dosesPerUnit: p.dosesPerUnit,
      linked: linked.has(p.odooId),
      /* Doses is the raw Odoo figure; units is what the fridge holds. */
      onHandDoses: r3(s.qty),
      onHand: r3(handUnits),
      warehouse: r3(s.byLocation.filter((l) => l.warehouse).reduce((t, l) => t + l.qty, 0) / (p.dosesPerUnit || 1)),
      branches: r3(s.byLocation.filter((l) => !l.warehouse).reduce((t, l) => t + l.qty, 0) / (p.dosesPerUnit || 1)),
      byLocation: s.byLocation,
      usedUnits: r3(u.units),
      usedDoses: r3(u.doses),
      monthlyRate: r3(rate),
      /* Infinity is honest — stock with no sales has no cover — but it cannot
         be sent as JSON, so it travels as null and the page prints "—". */
      coverMonths: Number.isFinite(cover) ? r2(cover) : null,
      band: band.key,
      bandLabel: band.label,
      unitCost: c ? r2(c.unitCost) : null,
      costSource: c ? c.source : null,
      costRule: c ? (c.matchRule || null) : null,
      /* Cost is per DOSE, because that is the unit `BillLine.qty` counts in, so
         the value is doses × cost. Multiplying converted units by a dose price
         is the same 100× mistake in the other direction. */
      value: c ? r2(s.qty * c.unitCost) : null,
      /* Priced, but by a rule too loose to be sure what unit the price is in.
         Shown beside the trusted figures and labelled; never added to them. */
      unverifiedUnitCost: !c && cu ? r2(cu.unitCost) : null,
      unverifiedValue: !c && cu ? r2(s.qty * cu.unitCost) : null,
      toIdeal: rate > 0 ? r3(Math.max(0, rate * IDEAL_MONTHS - handUnits)) : null,
    };
  });

  const order = BANDS.map((b) => b.key);
  rows.sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band)
    || (b.value || 0) - (a.value || 0));

  const counts = {};
  for (const b of BANDS) counts[b.key] = rows.filter((r) => r.band === b.key).length;

  return {
    rows,
    counts,
    bands: BANDS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] })),
    short: rows.filter((r) => SHORT.has(r.band)).length,
    rules: { IDEAL_MONTHS, NOM_DAYS, CRIT, BELOW, HEAL },
    rateBasisDays: span,
    /* A fortnight is the point below which one busy day moves a product two
       bands. Stated rather than silently smoothed. */
    rateIsThin: span < 14,
    snapshotAt: ymd(stock.takenAt),
    locations: stock.locations,
    valued: {
      products: rows.filter((r) => r.value != null).length,
      total: r2(rows.reduce((t, r) => t + (r.value || 0), 0)),
      unpriced: rows.filter((r) => r.value == null && r.unverifiedValue == null && r.onHand > 0).length,
      unpricedUnits: r3(rows.filter((r) => r.value == null && r.unverifiedValue == null)
        .reduce((t, r) => t + r.onHand, 0)),
      unverifiedProducts: rows.filter((r) => r.unverifiedValue != null).length,
      unverifiedTotal: r2(rows.reduce((t, r) => t + (r.unverifiedValue || 0), 0)),
    },
    costCoverage: cost.coverage,
    linkCoverage: used.linkCoverage,
  };
}

/* VAT is 14% and every value in the expiry register is COST, which is ex-VAT.
   The source pack shows both figures side by side on every row and labels the
   inc-VAT one "for reference only" — it is the ex-VAT cost grossed up, not a
   number anybody was invoiced. Kept because the pack's readers compare against
   inc-VAT figures elsewhere, and dropping half of every pair would make them
   do the arithmetic in their heads. */
const VAT = 0.14;
const inc = (v) => r2(num(v) * (1 + VAT));

/**
 * The six expiry states, most urgent first.
 *
 * An ORDERED list for the same reason the cover bands are: the tests overlap,
 * so the order IS the definition. `unk` sits at the end rather than being
 * skipped — a lot whose expiry string cannot be parsed is not fine, it is a lot
 * nobody can age, and the source pack names one by hand for exactly that
 * reason ("Pbserum Medium Kit … expiry written as 10_2028").
 *
 * MEASURED against the pack at its own as-of date of 2026-08-01: these
 * thresholds give 21/26/21/178/379 lots against its 24/21/26/186/385. The three
 * closest buckets are within a handful, and we hold 625 lots against its 643 —
 * so the thresholds are stated rather than tuned. Moving the boundary to make
 * one bucket agree pushes another out by the same amount, which is fitting a
 * rule to a number instead of reading it.
 */
const EXPIRY_STATES = [
  { key: 'unk', label: 'No expiry date', days: null },
  { key: 'exp', label: 'Expired', days: 0 },
  { key: 'cri', label: 'Critical', days: 90 },
  { key: 'war', label: 'Warning', days: 180 },
  { key: 'wat', label: 'Watch', days: 365 },
  { key: 'ok', label: 'OK', days: Infinity },
];

/** At risk is the three states worth acting on this quarter. */
const AT_RISK = new Set(['exp', 'cri', 'war']);

/**
 * The state of one lot at a given date, plus how long it has.
 *
 * `daysLeft` is negative for an expired lot rather than clamped to zero: "93
 * days ago" is what a person needs to hear, and zero would read as "today".
 */
function expiryStateOf(expiry, at) {
  if (!expiry) return { key: 'unk', label: 'No expiry date', daysLeft: null };
  const daysLeft = Math.round((expiry.getTime() - at.getTime()) / 864e5);
  const state = daysLeft < 0 ? EXPIRY_STATES[1]
    : EXPIRY_STATES.slice(2).find((sv) => daysLeft < sv.days) || EXPIRY_STATES[5];
  return { key: state.key, label: state.label, daysLeft };
}

/**
 * The lot-level expiry register, product by product, lot by lot.
 *
 * SELL-FIRST PRIORITY, which is what the tab is for: worst expiry first, then
 * largest quantity, so the top of the list is the thing to move today. Each
 * product carries EVERY lot behind it — location, expiry, days left, quantity
 * and value — because a product-level total is not something anybody can act
 * on: you cannot chase "430 units of ART FILLER Lips", you chase four lots in
 * four named branches. Each lot list ends in a total that reconciles to its own
 * card, which is the check that the expansion and the headline are the same
 * data read twice.
 *
 * `ExpiryLot` is `source='snapshot'` and does not refresh, so `asOf` is the
 * import rather than today. A page that implied otherwise would have somebody
 * chasing a lot that expired weeks ago.
 */
async function buildExpiry({ to }) {
  /* THE REGISTER IS IN DOSES. `ExpiryLot.qty` sits in the same basis as
     StockQuant and BillLine — an Evetox lot is 268 at 25 EGP, which is a price
     per dose, not per vial — so `value = qty x unitCost` is right as it stands
     and the QUANTITY must not be called "units". Two thirds of the register's
     products do not match the consumable catalogue at all, so most of them have
     no dose factor to convert with even in principle; doses is not a
     compromise here, it is the only basis the register has. */
  const asOf = to;
  const at = new Date(asOf);

  const lots = await prisma.expiryLot.findMany({ orderBy: { expiry: 'asc' } });
  if (!lots.length) return { missing: true, asOf };

  const states = new Map(EXPIRY_STATES.map((sv) => [sv.key, {
    key: sv.key, label: sv.label, lots: 0, qty: 0, value: 0, products: new Set(),
  }]));

  const byProduct = new Map();
  for (const l of lots) {
    const st = expiryStateOf(l.expiry, at);
    const S = states.get(st.key);
    S.lots += 1; S.qty += num(l.qty); S.value += num(l.value); S.products.add(l.product);

    const p = byProduct.get(l.product) || {
      product: l.product, lots: [], qty: 0, value: 0, warehouse: 0, branches: 0,
      thinMovement: false, soonest: null, atRisk: 0, atRiskValue: 0,
      locations: new Set(), worst: 'ok', worstRank: 99,
    };
    p.lots.push({
      location: l.location,
      isWarehouse: l.isWarehouse,
      lot: l.lot,
      expiry: ymd(l.expiry),
      daysLeft: st.daysLeft,
      state: st.key,
      stateLabel: st.label,
      qty: r3(l.qty),
      value: r2(l.value),
      valueInc: inc(l.value),
      unitCost: r2(l.unitCost),
      thinMovement: l.thinMovement,
    });
    p.qty += num(l.qty); p.value += num(l.value);
    p.locations.add(l.location);
    if (l.isWarehouse) p.warehouse += num(l.qty); else p.branches += num(l.qty);
    if (l.thinMovement) p.thinMovement = true;
    if (l.expiry && (!p.soonest || l.expiry < p.soonest)) p.soonest = l.expiry;
    if (AT_RISK.has(st.key)) { p.atRisk += num(l.qty); p.atRiskValue += num(l.value); }
    /* A product's own state is its WORST lot, not an average: one expired lot
       among nine good ones is an expired lot somebody has to deal with. */
    const rank = EXPIRY_STATES.findIndex((sv) => sv.key === st.key);
    if (rank < p.worstRank && st.key !== 'unk') { p.worstRank = rank; p.worst = st.key; }
    byProduct.set(l.product, p);
  }

  const totals = { lots: lots.length, qty: 0, value: 0 };
  for (const l of lots) { totals.qty += num(l.qty); totals.value += num(l.value); }

  const products = [...byProduct.values()].map((p) => ({
    product: p.product,
    /* Earliest expiry first, so the expansion reads as a queue of work. */
    lots: p.lots.sort((a, x) => {
      if (a.expiry === x.expiry) return x.qty - a.qty;
      if (!a.expiry) return 1;
      if (!x.expiry) return -1;
      return a.expiry.localeCompare(x.expiry);
    }),
    lotCount: p.lots.length,
    locations: p.locations.size,
    qty: r3(p.qty),
    value: r2(p.value),
    valueInc: inc(p.value),
    warehouse: r3(p.warehouse),
    branches: r3(p.branches),
    atRisk: r3(p.atRisk),
    atRiskValue: r2(p.atRiskValue),
    atRiskValueInc: inc(p.atRiskValue),
    soonest: ymd(p.soonest),
    soonestDays: p.soonest ? Math.round((p.soonest.getTime() - at.getTime()) / 864e5) : null,
    thinMovement: p.thinMovement,
    state: p.worstRank === 99 ? 'unk' : p.worst,
    stateLabel: (EXPIRY_STATES.find((sv) => sv.key === (p.worstRank === 99 ? 'unk' : p.worst)) || {}).label,
    share: totals.value ? r2((p.value / totals.value) * 100) : 0,
    /* Every state present in this product's lots, so a filter chip can show a
       product whose worst lot is fine but which still holds one expired one. */
    flags: [...new Set(p.lots.map((l) => l.state))]
      .concat(p.atRisk > 0 ? ['risk'] : []),
  }));

  /* SELL-FIRST: worst state, then soonest expiry, then biggest quantity. */
  const rank = (k) => EXPIRY_STATES.findIndex((sv) => sv.key === k);
  products.sort((a, b) => rank(a.state) - rank(b.state)
    || String(a.soonest || '9999').localeCompare(String(b.soonest || '9999'))
    || b.qty - a.qty);
  products.forEach((p, i) => { p.rank = i + 1; });

  const atRiskProducts = products.filter((p) => p.atRisk > 0);

  /* By LOCATION, which is the cut the overview leads with: a branch holding
     19% of its value in at-risk lots is a different conversation from one
     holding 1%, and the total alone cannot start either. */
  const byLocation = new Map();
  for (const l of lots) {
    const st = expiryStateOf(l.expiry, at);
    const L2 = byLocation.get(l.location) || {
      location: l.location, isWarehouse: l.isWarehouse, lots: 0, qty: 0, value: 0,
      atRisk: 0, atRiskValue: 0, products: new Set(),
    };
    L2.lots += 1; L2.qty += num(l.qty); L2.value += num(l.value);
    L2.products.add(l.product);
    if (AT_RISK.has(st.key)) { L2.atRisk += num(l.qty); L2.atRiskValue += num(l.value); }
    byLocation.set(l.location, L2);
  }

  return {
    asOf,
    vat: VAT,
    /* Named in the payload so no page can quietly relabel it. */
    basis: 'doses',
    locations: [...byLocation.values()].map((l) => ({
      location: l.location,
      isWarehouse: l.isWarehouse,
      lots: l.lots,
      products: l.products.size,
      qty: r3(l.qty),
      value: r2(l.value),
      valueInc: inc(l.value),
      atRisk: r3(l.atRisk),
      atRiskValue: r2(l.atRiskValue),
      atRiskShare: l.value ? r2((l.atRiskValue / l.value) * 100) : 0,
    })).sort((a, b) => b.value - a.value),
    states: [...states.values()].map((sv) => ({
      key: sv.key, label: sv.label, lots: sv.lots,
      qty: r3(sv.qty), value: r2(sv.value), valueInc: inc(sv.value),
      products: sv.products.size,
      share: totals.value ? r2((sv.value / totals.value) * 100) : 0,
    })).filter((sv) => sv.lots > 0),
    /* The filter chips the pack offers, with their counts, so the page does not
       have to know the band list to draw them. */
    chips: [{ key: 'all', label: 'All', count: products.length },
      { key: 'risk', label: 'At risk', count: atRiskProducts.length }]
      .concat(EXPIRY_STATES.map((sv) => ({
        key: sv.key,
        label: sv.label,
        count: products.filter((p) => p.flags.includes(sv.key)).length,
      })).filter((c) => c.count > 0)),
    products,
    totals: {
      ...totals, qty: r3(totals.qty), value: r2(totals.value), valueInc: inc(totals.value),
      products: products.length, locations: new Set(lots.map((l) => l.location)).size,
    },
    atRisk: {
      products: atRiskProducts.length,
      lots: atRiskProducts.reduce((t, p) => t + p.lots.filter((l) => AT_RISK.has(l.state)).length, 0),
      qty: r3(atRiskProducts.reduce((t, p) => t + p.atRisk, 0)),
      value: r2(atRiskProducts.reduce((t, p) => t + p.atRiskValue, 0)),
      valueInc: inc(atRiskProducts.reduce((t, p) => t + p.atRiskValue, 0)),
      share: totals.value
        ? r2((atRiskProducts.reduce((t, p) => t + p.atRiskValue, 0) / totals.value) * 100) : 0,
    },
    split: {
      warehouse: r2(lots.filter((l) => l.isWarehouse).reduce((t, l) => t + num(l.value), 0)),
      branches: r2(lots.filter((l) => !l.isWarehouse).reduce((t, l) => t + num(l.value), 0)),
    },
    thinMovement: {
      lots: lots.filter((l) => l.thinMovement).length,
      value: r2(lots.filter((l) => l.thinMovement).reduce((t, l) => t + num(l.value), 0)),
    },
    /* Lots nobody can age. Named, because an unparseable expiry string is a
       register that needs fixing, not a lot that is fine. */
    undateable: lots.filter((l) => !l.expiry).map((l) => ({
      product: l.product, location: l.location, lot: l.lot,
      qty: r3(l.qty), value: r2(l.value),
    })),
    sources: [...new Set(lots.map((l) => l.source))],
    thresholds: EXPIRY_STATES.filter((sv) => sv.days !== null && Number.isFinite(sv.days))
      .map((sv) => ({ key: sv.key, label: sv.label, withinDays: sv.days })),
  };
}

/**
 * The movement ledger — opening, in, out, closing, per category and per SKU.
 *
 * THE SOURCE PACK ROLLS ITS OPENING BALANCE BACK OUT OF ODOO. It says so:
 * "Opening = stock on hand at 26 Aug + August sales + adjustments + supplier
 * returns − August receipts, so the ledger cross-foots exactly." It can do that
 * because it reads `stock.move` live and therefore knows the adjustments.
 *
 * WE DO NOT CACHE STOCK MOVES, so this does the honest version instead: it
 * takes opening from a REAL EARLIER SNAPSHOT and derives the adjustment as the
 * residual.
 *
 *     adjust = closing − opening − receipts + sales + returns
 *
 * That residual is not a rounding error and it is not noise — it is write-offs,
 * breakage, inter-branch transfers and stock used without being billed, and it
 * is the single most interesting column on the tab. Deriving it as a plug and
 * LABELLING it as unexplained is truthful; calling it "Adjust" as though it had
 * been read from somewhere would not be.
 *
 * It follows that the ledger needs TWO snapshots inside the window, and refuses
 * when it has one. A window with a single snapshot has no opening balance, and
 * inventing one from the closing figure would produce a ledger that cross-foots
 * to zero movement by construction — perfectly balanced and completely empty of
 * information.
 */
async function buildLedger({ from, to }) {
  const cat = await C.catalogue();

  const snaps = await prisma.stockQuant.groupBy({
    by: ['takenAt'], _count: true, orderBy: { takenAt: 'asc' },
  });
  if (!snaps.length) return { missing: true, reason: 'No stock snapshots are loaded at all.' };

  const fromEnd = new Date(`${from}T23:59:59.999Z`);
  const toEnd = new Date(`${to}T23:59:59.999Z`);
  /* Opening is the last snapshot AT OR BEFORE the start of the window, so the
     ledger opens with what was actually on the shelf when the period began. */
  const open = [...snaps].reverse().find((x) => x.takenAt <= fromEnd);
  const close = [...snaps].reverse().find((x) => x.takenAt <= toEnd);

  if (!open || !close || open.takenAt.getTime() === close.takenAt.getTime()) {
    return {
      missing: true,
      reason: open && close && open.takenAt.getTime() === close.takenAt.getTime()
        ? `Only one stock snapshot falls in ${from} to ${to} (${ymd(close.takenAt)}). A ledger needs an opening and a closing count.`
        : `No stock snapshot at or before ${from}. The earliest held is ${ymd(snaps[0].takenAt)}.`,
      have: snaps.map((x) => ({ takenAt: ymd(x.takenAt), rows: x._count })),
      /* The window that WOULD work, so the reader has somewhere to go. */
      suggestion: snaps.length > 1
        ? { from: ymd(snaps[0].takenAt), to: ymd(snaps[snaps.length - 1].takenAt) } : null,
    };
  }

  const [openRows, closeRows, used, cost, bills, returns] = await Promise.all([
    prisma.stockQuant.findMany({ where: { takenAt: open.takenAt }, select: { productId: true, quantity: true } }),
    prisma.stockQuant.findMany({ where: { takenAt: close.takenAt }, select: { productId: true, quantity: true } }),
    usage({ from, to }),
    C.costBasis({ to }),
    prisma.billLine.findMany({
      where: { bill: { date: { gte: new Date(from), lte: new Date(to) } } },
      select: { product: true, qty: true, isBonus: true },
    }),
    prisma.purchaseReturn.findMany(),
  ]);

  const doses = (rows) => {
    const m = new Map();
    for (const q of rows) {
      const id = cat.canonical(q.productId);
      if (!cat.byId.has(id)) continue;
      m.set(id, (m.get(id) || 0) + num(q.quantity));
    }
    return m;
  };
  const openBy = doses(openRows);
  const closeBy = doses(closeRows);

  /* Receipts and returns are matched by NAME, on the trusted tiers only — the
     same rule as every money figure, because a `contains` match here would put
     one product's deliveries on another's ledger line. */
  const pool = C.poolOf(cat.rows, 'name', 'odooId');
  const recvBy = new Map();
  const bonusBy = new Map();
  for (const l of bills) {
    const m = C.matchOne(l.product, pool);
    if (!m.hit || !C.COST_TIERS.has(m.rule)) continue;
    const t = l.isBonus ? bonusBy : recvBy;
    t.set(m.hit.id, (t.get(m.hit.id) || 0) + num(l.qty));
  }
  const retBy = new Map();
  for (const r of returns) {
    const m = C.matchOne(r.product, pool);
    if (!m.hit || !C.COST_TIERS.has(m.rule)) continue;
    retBy.set(m.hit.id, (retBy.get(m.hit.id) || 0) + num(r.qty));
  }

  const span = days(from, to);
  const months = span / NOM_DAYS;

  const rows = cat.rows.map((p) => {
    const per = p.dosesPerUnit || 1;
    const u = (v) => (v || 0) / per;
    const opening = u(openBy.get(p.odooId));
    const closing = u(closeBy.get(p.odooId));
    const receipts = u(recvBy.get(p.odooId));
    const bonus = u(bonusBy.get(p.odooId));
    const sales = (used.byId.get(p.odooId) || { units: 0 }).units;
    const returned = u(retBy.get(p.odooId));
    /* The plug. Positive means stock appeared that no receipt explains;
       negative means it left without a sale, a return or a receipt reversal. */
    const adjust = closing - (opening + receipts + bonus - sales - returned);
    const rate = months > 0 ? sales / months : 0;
    const ideal = rate * IDEAL_MONTHS;
    const cover = rate > 0 ? closing / rate : (closing > 0 ? Infinity : 0);
    const linked = used.linkedProducts.includes(p.odooId);
    const band = bandOf(cover, sales, closing, linked);
    const c = cost.byId.get(p.odooId);
    const closingDoses = num(closeBy.get(p.odooId));

    return {
      odooId: p.odooId,
      name: p.name,
      vendorName: p.vendorName,
      category: p.category,
      unit: p.unit,
      dosesPerUnit: per,
      linked,
      opening: r3(opening),
      receipts: r3(receipts),
      bonus: r3(bonus),
      sales: r3(sales),
      returned: r3(returned),
      adjust: r3(adjust),
      closing: r3(closing),
      closingDoses: r3(closingDoses),
      monthlyRate: r3(rate),
      ideal: r3(ideal),
      coverMonths: Number.isFinite(cover) ? r2(cover) : null,
      band: band.key,
      bandLabel: band.label,
      unitCost: c ? r2(c.unitCost) : null,
      value: c ? r2(closingDoses * c.unitCost) : null,
      valueInc: c ? inc(closingDoses * c.unitCost) : null,
      /* Bonus as a share of what was paid for, which is what the pack shows. */
      bonusPct: receipts > 0 ? r2((bonus / receipts) * 100) : null,
    };
  });

  /* ---- roll up by category ---- */
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.category) || {
      category: r.category, skus: 0, activeSkus: 0,
      opening: 0, receipts: 0, bonus: 0, sales: 0, returned: 0, adjust: 0, closing: 0,
      ideal: 0, value: 0, valueInc: 0, rows: [],
    };
    g.skus += 1;
    if (r.sales > 0 || r.receipts > 0) g.activeSkus += 1;
    for (const k of ['opening', 'receipts', 'bonus', 'sales', 'returned', 'adjust', 'closing', 'ideal']) {
      g[k] += r[k];
    }
    g.value += r.value || 0;
    g.valueInc += r.valueInc || 0;
    g.rows.push(r);
    groups.set(r.category, g);
  }

  const order = BANDS.map((b) => b.key);
  const cats = [...groups.values()].map((g) => {
    const rate = months > 0 ? g.sales / months : 0;
    const cover = rate > 0 ? g.closing / rate : (g.closing > 0 ? Infinity : 0);
    const anyLinked = g.rows.some((r) => r.linked);
    const band = bandOf(cover, g.sales, g.closing, anyLinked);
    return {
      ...g,
      rows: g.rows.sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band)
        || (b.value || 0) - (a.value || 0)),
      opening: r3(g.opening), receipts: r3(g.receipts), bonus: r3(g.bonus),
      sales: r3(g.sales), returned: r3(g.returned), adjust: r3(g.adjust),
      closing: r3(g.closing), ideal: r3(g.ideal),
      value: r2(g.value), valueInc: r2(g.valueInc),
      monthlyRate: r3(rate),
      coverMonths: Number.isFinite(cover) ? r2(cover) : null,
      band: band.key,
      bandLabel: band.label,
      bonusPct: g.receipts > 0 ? r2((g.bonus / g.receipts) * 100) : null,
      /* Stock against two months of the run rate, as a percentage, for the bar. */
      idealPct: g.ideal > 0 ? r2((g.closing / g.ideal) * 100) : null,
    };
  }).sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band) || b.value - a.value);

  const sum = (k) => r3(rows.reduce((t, r) => t + r[k], 0));
  const company = {
    opening: sum('opening'), receipts: sum('receipts'), bonus: sum('bonus'),
    sales: sum('sales'), returned: sum('returned'), adjust: sum('adjust'),
    closing: sum('closing'), ideal: sum('ideal'),
    value: r2(rows.reduce((t, r) => t + (r.value || 0), 0)),
    valueInc: r2(rows.reduce((t, r) => t + (r.valueInc || 0), 0)),
  };
  company.monthlyRate = r3(months > 0 ? company.sales / months : 0);
  company.coverMonths = company.monthlyRate > 0 ? r2(company.closing / company.monthlyRate) : null;
  company.bonusPct = company.receipts > 0 ? r2((company.bonus / company.receipts) * 100) : null;
  company.idealPct = company.ideal > 0 ? r2((company.closing / company.ideal) * 100) : null;

  /* THE CROSS-FOOT. True by construction because `adjust` is the residual — so
     it is asserted rather than displayed as an achievement, and what the page
     shows instead is the SIZE of the residual, which is the real finding. */
  const crossFoot = r3(company.opening + company.receipts + company.bonus
    - company.sales - company.returned + company.adjust - company.closing);

  return {
    window: { from, to, days: span, months: r2(months) },
    openingAt: ymd(open.takenAt),
    closingAt: ymd(close.takenAt),
    /* The snapshots bound the ledger, not the dates asked for — stated, because
       a reader comparing this with the Cover tab needs to know why the two
       windows differ. */
    snapshotWindow: { from: ymd(open.takenAt), to: ymd(close.takenAt) },
    company,
    crossFoot,
    categories: cats,
    rows,
    bands: BANDS.map((b) => ({
      key: b.key, label: b.label, count: rows.filter((r) => r.band === b.key).length,
    })),
    short: rows.filter((r) => SHORT.has(r.band)).length,
    overstock: {
      skus: rows.filter((r) => r.band === 'wat').length,
      value: r2(rows.filter((r) => r.band === 'wat').reduce((t, r) => t + (r.value || 0), 0)),
    },
    rules: { IDEAL_MONTHS, NOM_DAYS, CRIT, BELOW, HEAL },
    /* How much of the movement we can see at all, so the residual is read in
       context rather than as a scandal. */
    coverage: {
      linked: rows.filter((r) => r.linked).length,
      products: rows.length,
      priced: rows.filter((r) => r.value != null).length,
      receiptsMatched: recvBy.size,
      billLines: bills.length,
    },
  };
}

/**
 * Did the at-risk stock sell — and what was the margin on rescuing it?
 *
 * The question the expiry tab cannot answer alone. A product with 200 units
 * expiring in six weeks and brisk sales is a supply problem; the same product
 * with no sales is a write-off waiting to happen, and the two need opposite
 * responses.
 *
 * SALES ARE ATTRIBUTED TO LOTS FIRST-EXPIRY-FIRST-OUT, which is what the source
 * pack does and what a clinic ought to do: the oldest lot goes first, so a sale
 * today clears the lot that expires soonest. Each invoice line therefore carries
 * the lots it drew from — "30/9/2026 (critical) ×25" — and that is the whole
 * point, because it is the difference between "this product is selling" and
 * "the expiring lot in Loran is selling".
 *
 * THE MARGIN IS THE FIGURE THAT MAKES THE CASE. Cost cleared is what those lots
 * were carried at; revenue is what they were sold for. The gap is what would
 * have been lost had they been written off instead, and it is the number that
 * justifies moving stock between branches.
 *
 * The lot join is by NAME — `ExpiryLot` carries no product id — so it uses the
 * same tiered matcher as everything else and reports what it could not place.
 */
async function buildAtRisk({ from, to }) {
  const exp = await buildExpiry({ to });
  if (exp.missing) return { missing: true, reason: 'No expiry lots are loaded.' };

  const cat = await C.catalogue();
  const L = await C.links();
  const cost = await C.costBasis({ to });
  const pool = C.poolOf(cat.rows, 'name', 'odooId');

  /* Which catalogue product each at-risk register product is, and its lots. */
  const targets = [];
  const unmatched = [];
  for (const p of exp.products) {
    if (p.atRisk <= 0) continue;
    const m = C.matchOne(p.product, pool);
    if (!m.hit) {
      unmatched.push({
        product: p.product, atRisk: p.atRisk, atRiskValue: p.atRiskValue,
        atRiskValueInc: p.atRiskValueInc, why: m.rule,
      });
      continue;
    }
    targets.push({ odooId: m.hit.id, matchRule: m.rule, register: p });
  }
  if (!targets.length) {
    return {
      rows: [],
      unmatched,
      fromStates: [],
      totals: {
        products: 0, atRiskValue: 0, soldLines: 0, soldUnits: 0, rescuedUnits: 0,
        rescuedCost: 0, rescuedEx: 0, margin: 0, marginPct: null, stillAtRisk: 0,
        willNotClear: 0, willNotClearValue: 0, noSales: 0, noSalesValue: 0,
        unmatchedValue: r2(unmatched.reduce((t, u) => t + u.atRiskValue, 0)),
      },
      window: { from, to, days: days(from, to) },
      asOf: exp.asOf,
      note: 'No at-risk product could be matched to the consumable catalogue.',
    };
  }

  /* Every service that burns one of those products. */
  const serviceOf = new Map();
  for (const [sid, v] of L.byService) {
    const id = cat.canonical(v.consumableOdooId);
    if (targets.some((t) => t.odooId === id)) serviceOf.set(sid, { id, dosesPerService: v.dosesPerService });
  }

  const lines = serviceOf.size ? await prisma.invoiceLine.findMany({
    where: {
      productId: { in: [...serviceOf.keys()] },
      invoice: {
        moveType: 'out_invoice',      // a refund is not a rescue
        invoiceDate: { gte: new Date(from), lte: new Date(to) },
      },
    },
    select: {
      productId: true, quantity: true, priceSubtotal: true,
      invoice: { select: { name: true, invoiceDate: true, branchName: true, specialistName: true } },
    },
    orderBy: { odooId: 'asc' },
  }) : [];

  /* Grouped by product, in DATE order — FEFO only means anything if the sales
     are drawn in the order they actually happened. */
  const byProduct = new Map();
  for (const l of lines) {
    const svc = serviceOf.get(l.productId);
    if (!svc) continue;
    const prod = cat.byId.get(svc.id);
    if (!prod) continue;
    const doses = num(l.quantity) * (svc.dosesPerService == null ? 1 : svc.dosesPerService);
    const units = doses / (prod.dosesPerUnit || 1);
    const cur = byProduct.get(svc.id) || [];
    cur.push({
      date: ymd(l.invoice.invoiceDate),
      ref: l.invoice.name,
      branch: l.invoice.branchName || 'Unassigned',
      doctor: l.invoice.specialistName || 'No doctor',
      /* Both bases travel: doses for the lot arithmetic, units for the reader. */
      doses: r3(doses),
      units: r3(units),
      ex: r2(l.priceSubtotal),
    });
    byProduct.set(svc.id, cur);
  }
  for (const arr of byProduct.values()) arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const span = days(from, to);
  const months = span / NOM_DAYS;
  const rows = [];

  for (const t of targets) {
    const prod = cat.byId.get(t.odooId);
    const sales = byProduct.get(t.odooId) || [];
    const c = cost.byId.get(t.odooId);
    const per = prod.dosesPerUnit || 1;

    /* A running queue of the AT-RISK lots only, earliest expiry first. A sale
       that runs past them came out of stock nobody was worried about, and not
       counting it as a rescue is the whole discipline here. */
    const queue = t.register.lots
      .filter((l) => AT_RISK.has(l.state))
      .map((l) => ({ ...l, left: l.qty }));

    let drawnUnits = 0;
    let drawnCost = 0;
    let rescuedEx = 0;
    const detail = sales.map((line) => {
      /* DOSES, not units. `ExpiryLot.qty` is in the same basis as StockQuant and
         BillLine — Evetox lots are 268 at 25 EGP each, which is a dose price —
         so the queue, the sale and the lot cost are all doses. Drawing converted
         vials against a queue of doses is a 100x mismatch that showed up as a
         99.9% margin on Metox: nine vials' worth of revenue against nine doses'
         worth of cost. */
      let need = line.doses;
      const drawn = [];
      while (need > 0.0001 && queue.length) {
        const lot = queue[0];
        const take = Math.min(need, lot.left);
        if (take > 0.0001) {
          drawn.push({
            expiry: lot.expiry, state: lot.state, stateLabel: lot.stateLabel,
            location: lot.location, qty: r3(take),
          });
          /* A lot states its own cost per dose, which is the right basis: it is
             what THAT delivery was carried at, not the product's weighted
             average across the year. */
          const unitCost = lot.unitCost || (c ? c.unitCost : 0);
          drawnCost += take * unitCost;
          drawnUnits += take;
          /* Revenue apportioned by the share of the line that came from an
             at-risk lot, so a line half-filled from healthy stock counts half
             its revenue as rescued. Counting all of it would overstate the
             margin on exactly the lines that matter least. */
          rescuedEx += line.ex * (take / (line.doses || 1));
        }
        lot.left -= take;
        need -= take;
        if (lot.left <= 0.0001) queue.shift();
      }
      return { ...line, drawn, fromAtRiskDoses: r3(drawn.reduce((s, d) => s + d.qty, 0)) };
    });

    /* Branch, then doctor inside it — the shape the pack expands into. */
    const branches = new Map();
    for (const d of detail) {
      const B = branches.get(d.branch)
        || { name: d.branch, lines: 0, units: 0, ex: 0, doctors: new Map() };
      B.lines += 1; B.units += d.units; B.ex += d.ex;
      const D2 = B.doctors.get(d.doctor) || { name: d.doctor, lines: [], units: 0, ex: 0 };
      D2.lines.push(d); D2.units += d.units; D2.ex += d.ex;
      B.doctors.set(d.doctor, D2);
      branches.set(d.branch, B);
    }

    const soldUnits = detail.reduce((s, d) => s + d.units, 0);
    const rate = months > 0 ? soldUnits / months : 0;

    rows.push({
      odooId: t.odooId,
      product: prod.name,
      lotName: t.register.product,
      matchRule: t.matchRule,
      category: prod.category,
      unit: prod.unit,
      state: t.register.state,
      stateLabel: t.register.stateLabel,
      atRisk: t.register.atRisk,
      atRiskValue: t.register.atRiskValue,
      atRiskValueInc: t.register.atRiskValueInc,
      soonest: t.register.soonest,
      soonestDays: t.register.soonestDays,
      thinMovement: t.register.thinMovement,
      soldUnits: r3(soldUnits),
      soldLines: detail.length,
      soldEx: r2(detail.reduce((s, d) => s + d.ex, 0)),
      rescuedDoses: r3(drawnUnits),
      rescuedUnits: r3(drawnUnits / per),
      rescuedCost: r2(drawnCost),
      rescuedEx: r2(rescuedEx),
      rescuedExInc: inc(rescuedEx),
      margin: r2(rescuedEx - drawnCost),
      marginPct: rescuedEx > 0 ? r2(((rescuedEx - drawnCost) / rescuedEx) * 100) : null,
      /* What is still sitting there once the sales were drawn off. */
      stillAtRisk: r3(queue.reduce((s, l) => s + l.left, 0)),
      monthsToClear: rate > 0 ? r2(t.register.atRisk / rate) : null,
      monthsLeft: t.register.soonestDays == null ? null : r2(t.register.soonestDays / NOM_DAYS),
      branches: [...branches.values()].map((b) => ({
        name: b.name, lines: b.lines, units: r3(b.units), ex: r2(b.ex),
        doctors: [...b.doctors.values()].map((d) => ({
          name: d.name, units: r3(d.units), ex: r2(d.ex),
          lines: d.lines.map((x) => ({
            date: x.date, ref: x.ref, units: x.units, doses: x.doses, ex: x.ex,
            fromAtRiskDoses: x.fromAtRiskDoses, drawn: x.drawn,
          })),
        })).sort((a, b2) => b2.ex - a.ex),
      })).sort((a, b) => b.ex - a.ex),
    });
  }

  for (const r of rows) {
    r.willClear = r.monthsToClear != null && r.monthsLeft != null
      ? r.monthsToClear <= r.monthsLeft : null;
  }
  rows.sort((a, b) => b.rescuedEx - a.rescuedEx || b.atRiskValue - a.atRiskValue);

  const willNot = rows.filter((r) => r.willClear === false);
  const noSales = rows.filter((r) => r.soldUnits <= 0);
  const byState = (key) => {
    const hit = rows.filter((r) => r.state === key);
    return {
      key,
      label: (EXPIRY_STATES.find((sv) => sv.key === key) || {}).label,
      units: r3(hit.reduce((t, r) => t + r.rescuedUnits, 0)),
      doses: r3(hit.reduce((t, r) => t + r.rescuedDoses, 0)),
      ex: r2(hit.reduce((t, r) => t + r.rescuedEx, 0)),
      lines: hit.reduce((t, r) => t + r.soldLines, 0),
      products: hit.length,
    };
  };

  const totals = {
    products: rows.length,
    atRiskValue: r2(rows.reduce((t, r) => t + r.atRiskValue, 0)),
    atRiskValueInc: r2(rows.reduce((t, r) => t + r.atRiskValueInc, 0)),
    soldUnits: r3(rows.reduce((t, r) => t + r.soldUnits, 0)),
    soldLines: rows.reduce((t, r) => t + r.soldLines, 0),
    rescuedDoses: r3(rows.reduce((t, r) => t + r.rescuedDoses, 0)),
    rescuedUnits: r3(rows.reduce((t, r) => t + r.rescuedUnits, 0)),
    rescuedCost: r2(rows.reduce((t, r) => t + r.rescuedCost, 0)),
    rescuedEx: r2(rows.reduce((t, r) => t + r.rescuedEx, 0)),
    rescuedExInc: r2(rows.reduce((t, r) => t + r.rescuedExInc, 0)),
    stillAtRisk: r3(rows.reduce((t, r) => t + r.stillAtRisk, 0)),
    willNotClear: willNot.length,
    willNotClearValue: r2(willNot.reduce((t, r) => t + r.atRiskValue, 0)),
    noSales: noSales.length,
    noSalesValue: r2(noSales.reduce((t, r) => t + r.atRiskValue, 0)),
    unmatchedValue: r2(unmatched.reduce((t, u) => t + u.atRiskValue, 0)),
  };
  totals.margin = r2(totals.rescuedEx - totals.rescuedCost);
  totals.marginPct = totals.rescuedEx > 0 ? r2((totals.margin / totals.rescuedEx) * 100) : null;

  return {
    rows,
    unmatched,
    /* The states, split, as the pack's summary bars show them. */
    fromStates: ['exp', 'cri', 'war'].map(byState).filter((x) => x.products > 0),
    totals,
    window: { from, to, days: span },
    asOf: exp.asOf,
    note: 'Sales are drawn against lots first-expiry-first-out. Revenue is apportioned by the '
      + 'share of each line that came from an at-risk lot, so a line half-filled from healthy '
      + 'stock counts half its revenue as rescued.',
  };
}
/**
 * What is feeding this report and how fresh each part is.
 *
 * Kept because the three sources refresh at three different rates — the stock
 * snapshot hourly on the droplet, the expiry lots never, the invoice cache with
 * every sync — and a reader comparing two cards has no other way to know that.
 */
async function syncStatus() {
  const [snaps, lastRun, lots, invoices, uploads] = await Promise.all([
    prisma.stockQuant.groupBy({ by: ['takenAt'], _count: true, orderBy: { takenAt: 'desc' }, take: 12 }),
    prisma.syncRun.findFirst({ where: { status: 'ok' }, orderBy: { finishedAt: 'desc' } }),
    prisma.expiryLot.aggregate({ _count: true, _max: { expiry: true } }),
    prisma.invoice.aggregate({ _count: true, _max: { invoiceDate: true }, _min: { invoiceDate: true } }),
    prisma.dataUpload.findMany({ where: { kind: { startsWith: 'consumables' } }, orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);
  const L = await C.links();
  const cat = await C.catalogue();

  return {
    stock: {
      snapshots: snaps.map((s) => ({ takenAt: ymd(s.takenAt), rows: s._count })),
      latest: snaps.length ? ymd(snaps[0].takenAt) : null,
      /* The honest headline of this tab: a snapshot is not a ledger. */
      note: 'StockQuant is a snapshot of on-hand quantity. No stock moves are cached, so nothing here is a movement figure.',
    },
    lastSync: lastRun ? { at: lastRun.finishedAt, window: `${ymd(lastRun.fromDate)}..${ymd(lastRun.toDate)}` } : null,
    expiry: { lots: lots._count, source: 'snapshot', refreshes: false },
    invoices: { count: invoices._count, from: ymd(invoices._min.invoiceDate), to: ymd(invoices._max.invoiceDate) },
    catalogue: { products: cat.rows.length, aliases: cat.aliases, categories: cat.categories.length },
    links: { resolved: L.resolved, unresolved: L.unresolved.length, total: L.total, list: L.unresolved },
    seeds: uploads.map((u) => ({ at: u.createdAt, filename: u.filename, rows: u.rowsWritten, notes: u.notes })),
  };
}

/** Everything the page needs, in one round trip. */
async function build({ from, to }) {
  const floored = from < CACHE_FLOOR ? CACHE_FLOOR : from;
  const [cover, expiry, atRisk, ledger, sync] = await Promise.all([
    buildCover({ from: floored, to }),
    buildExpiry({ to }),
    buildAtRisk({ from: floored, to }),
    buildLedger({ from: floored, to }),
    syncStatus(),
  ]);

  return {
    from: floored,
    to,
    /* Stated, not silently applied: a range reaching before the cache floor
       gives a rate of use over a period we have no invoices for. */
    clamped: floored !== from ? { asked: from, floor: CACHE_FLOOR } : null,
    cover,
    expiry,
    atRisk,
    ledger,
    sync,
    totals: {
      onHand: r3(cover.rows.reduce((t, r) => t + r.onHand, 0)),
      onHandDoses: r3(cover.rows.reduce((t, r) => t + r.onHandDoses, 0)),
      value: cover.valued.total,
      skus: cover.rows.filter((r) => r.onHand > 0).length,
      short: cover.short,
      atRiskValue: atRisk.missing ? null : atRisk.totals.atRiskValue,
    },
  };
}

module.exports = {
  build, buildCover, buildExpiry, buildAtRisk, buildLedger, syncStatus, stockAt, usage,
  EXPIRY_STATES, AT_RISK, expiryStateOf, VAT, inc,
  BANDS, bandOf, SHORT, IDEAL_MONTHS, NOM_DAYS, CRIT, BELOW, HEAL,
  WAREHOUSE_LOCATION_IDS, CACHE_FLOOR,
};
