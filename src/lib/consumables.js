/* ============================================================
   The consumable catalogue, and the one copy of the name matching.

   Reports 08 and 09 both have to answer the same question — which stocked
   product is this row about — from four sources that spell it four ways:

     Consumable.name      the catalogue, from the pack   "Sypha  Volume"  (two spaces)
     InvoiceLine          the SERVICE as invoiced        "[Glowing] serviceDermaqual Tranex 1ML"
     BillLine.product     the purchase line              "Novuma 1.5 cc (علاج بيولوجي…)"
     ExpiryLot.product    the lot                        "L.C TX"

   Odoo joins none of them: an invoice sells a SERVICE (product 41542, "Allergan
   Botox one unit") and stock holds a CONSUMABLE (product 39773, "Allergan").
   Only `StockQuant.productId` and `InvoiceLine.productId` are ids we can trust,
   and even then the service id is not the consumable id — which is why
   `ConsumableLink` exists and why this module is the only place that decides
   what matches what.

   THE MATCHING IS TIERED AND SAYS WHICH TIER IT USED.

     exact      normalised names are equal
     squash     equal once every non-alphanumeric is removed
                ("Novuma 1.5 cc" = "Novuma1.5 cc")
     prefix     one squashed name starts the other
                ("Dermaqual Mesoglow" -> "[Glowing…] Dermaqual Mesoglow 1ML")
     contains   one squashed name is inside the other

   MEASURED: on the invoiced-service side this resolves 58 of the pack's 76
   mappings. The other 18 fail because the consumable itself is not in the
   catalogue — "Saypha" against the catalogue's "Sypha", "Platinium" against
   "Platinum" — and they are stored UNRESOLVED rather than forced. Tightening
   the rules further starts inventing links, and a wrong link moves real units
   onto the wrong product where both the inflated and the deflated figure look
   entirely plausible.

   AMBIGUITY IS A REFUSAL, NOT A COIN TOSS. `match` returns every hit; callers
   that need one answer refuse when there is more than one. The exception is the
   service side, where two hits are correct: Odoo genuinely lists "Metox Botox 1
   Unite" and "INV Botox Metox 1 Unite" as separate services for the same thing,
   and both must reach the same consumable.
   ============================================================ */

const { prisma } = require('./db.js');

/* Everything the four sources disagree about, removed before comparing. */
const strip = (x) => String(x == null ? '' : x).toLowerCase()
  .replace(/^\s*\[[^\]]*\]\s*/, '')   // a "[Exosomes] " category prefix
  .replace(/^\s*inv\s+/, '')          // "INV " marks a sale straight from stock
  .replace(/\bservice\b/g, ' ');      // "serviceDermaqual" -> "dermaqual"

const norm = (x) => strip(x).replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (x) => strip(x).replace(/[^a-z0-9]+/g, '');

/**
 * The tiers a MONEY figure may be built on.
 *
 * `contains` is deliberately absent — see `costBasis` for the measurement that
 * put it there. A quantity cut may use every tier; a value may not.
 */
const COST_TIERS = new Set(['exact', 'squash', 'prefix']);

/** The tiers, in order. Exported so a test can pin the order itself. */
const TIERS = [
  ['exact', (c, k, q) => c.k === k],
  ['squash', (c, k, q) => c.q === q],
  ['prefix', (c, k, q) => c.q.startsWith(q) || q.startsWith(c.q)],
  ['contains', (c, k, q) => c.q.includes(q) || q.includes(c.q)],
];

/**
 * Find `name` in `pool`, most exact tier first.
 *
 *   pool  [{ id, k: norm(name), q: squash(name), … }]
 *   ->    { hits: [...], rule: 'exact' | 'squash' | 'prefix' | 'contains' | 'none' }
 *
 * Never falls through to a later tier once an earlier one has hits, so a single
 * exact match always beats twenty containment matches.
 */
function match(name, pool) {
  const k = norm(name);
  const q = squash(name);
  if (!q) return { hits: [], rule: 'empty' };
  for (const [rule, test] of TIERS) {
    const hits = pool.filter((c) => test(c, k, q));
    if (hits.length) return { hits, rule };
  }
  return { hits: [], rule: 'none' };
}

/** Turn rows into a pool `match` can search. */
const poolOf = (rows, name = 'name', id = 'id') => rows.map((r) => ({
  id: r[id], name: r[name], k: norm(r[name]), q: squash(r[name]), row: r,
}));

/**
 * One name, one answer, or nothing.
 *
 * Ambiguity returns null with the reason: two candidates means the rules cannot
 * tell them apart, and picking the first would make the figure depend on row
 * order in the database.
 */
function matchOne(name, pool) {
  const m = match(name, pool);
  if (m.hits.length === 1) return { hit: m.hits[0], rule: m.rule };
  if (m.hits.length > 1) return { hit: null, rule: `${m.rule}-ambiguous`, count: m.hits.length };
  return { hit: null, rule: m.rule };
}

/* ---------------------------------------------------------------------- */

/**
 * The catalogue, with the merge aliases folded away.
 *
 *   -> { rows, byId, aliasOf, categories, units }
 *
 * `aliasOf` maps a duplicate Odoo id onto the id that survives. Odoo lists five
 * of these products twice; counting an alias as its own SKU is how a stock
 * figure quietly halves, and it is invisible on the page because both halves
 * look like plausible products.
 */
async function catalogue() {
  const all = await prisma.consumable.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  const aliasOf = new Map();
  for (const c of all) if (c.mergeIntoOdooId) aliasOf.set(c.odooId, c.mergeIntoOdooId);

  const rows = all.filter((c) => !c.mergeIntoOdooId).map((c) => ({
    odooId: c.odooId,
    name: c.name,
    vendorName: c.vendorName,
    category: c.category || 'Uncategorised',
    unit: c.unit || 'units',
    /* NULL means one unit is one dose. It is NOT zero — dividing by zero here
       would turn a real product into Infinity months of cover. */
    dosesPerUnit: c.dosesPerUnit == null ? 1 : Number(c.dosesPerUnit),
  }));

  return {
    rows,
    byId: new Map(rows.map((r) => [r.odooId, r])),
    aliasOf,
    /** An Odoo id, with an alias resolved to its survivor. */
    canonical: (id) => (aliasOf.has(id) ? aliasOf.get(id) : id),
    categories: [...new Set(rows.map((r) => r.category))].sort(),
    units: [...new Set(rows.map((r) => r.unit))].sort(),
    aliases: all.length - rows.length,
  };
}

/**
 * Which invoiced service burns which consumable.
 *
 *   -> { byService: Map<serviceProductId, {consumableOdooId, dosesPerService}>,
 *        resolved, unresolved: [{ packLabel, note }] }
 *
 * The unresolved list is returned, not swallowed. Every report that uses this
 * map prints how much of the pack's mapping it is actually working from,
 * because "18 of 76 links are missing" is the difference between a figure being
 * low and a figure being wrong.
 */
async function links() {
  const all = await prisma.consumableLink.findMany();
  const byService = new Map();
  const unresolved = [];
  for (const l of all) {
    if (l.serviceProductId && l.consumableOdooId) {
      byService.set(l.serviceProductId, {
        consumableOdooId: l.consumableOdooId,
        dosesPerService: l.dosesPerService == null ? null : Number(l.dosesPerService),
        matchRule: l.matchRule,
        serviceName: l.serviceName,
      });
    } else {
      unresolved.push({ packLabel: l.packLabel, note: l.note });
    }
  }
  return { byService, resolved: byService.size, unresolved, total: all.length };
}

/**
 * A unit cost per consumable, from what was actually paid for it.
 *
 *   costBasis({ to })
 *     -> { byId: Map<odooId, { unitCost, source, asOf, lines }>, coverage }
 *
 * `BillLine.product` is a NAME, not an id, so this is where the matcher earns
 * its keep. Two sources, preferred in this order:
 *
 *   purchase   the weighted average unit price across every matched purchase
 *              line — what the clinic paid, which is the basis the source pack
 *              uses ("effective cost per unit")
 *   lot        `ExpiryLot.unitCost`, a one-off snapshot, used only where no
 *              purchase line matched
 *
 * A consumable with neither gets NO cost and is counted in `coverage.priced` as
 * missing. It is left out of every value total rather than valued at zero: a
 * zero would silently shrink the stock value and look like a cheap product.
 *
 * ONLY THE FIRST THREE TIERS ARE TRUSTED FOR MONEY, and the reason is measured.
 * `contains` crosses the unit-of-measure boundary: Odoo stocks "Exocell" in ML
 * and buys "DQ EXOCELL 10ML Vial" by the vial, the names contain one another,
 * and the resulting price per vial applied to a quantity in ML valued 1,393 ml
 * of one product at 15,481,308 — 56% of the whole stock figure, and eleven
 * times what it is worth.
 *
 *     exact + squash          5,986,587   30 products
 *     + prefix                9,405,571   46 products   <- accepted
 *     + contains             27,558,890   58 products
 *     the source pack says    9,062,144
 *
 * So `prefix` is in and `contains` is out, on the evidence: the first three
 * tiers land within 3.8% of the pack, and the fourth is off by a factor of
 * three. A `contains` cost is still recorded — as `basisUnverified` — because
 * "we know what it cost but not in what unit" is worth showing; it is simply
 * kept out of every total.
 */
async function costBasis({ to } = {}) {
  const cat = await catalogue();
  const pool = poolOf(cat.rows, 'name', 'odooId');

  const where = to ? { bill: { date: { lte: new Date(to) } } } : {};
  const [lines, lots] = await Promise.all([
    prisma.billLine.findMany({
      where, select: { product: true, qty: true, unitPrice: true, subtotal: true, isBonus: true },
    }),
    prisma.expiryLot.findMany({ select: { product: true, unitCost: true, qty: true } }),
  ]);

  const agg = new Map();      // odooId -> { qty, value, lines }
  const unmatched = new Set();
  const unverified = new Map();
  for (const l of lines) {
    /* A bonus line is free stock. Its quantity is real but its price is zero,
       so including it in a weighted average drags the unit cost below what was
       ever paid — the same trap as counting a package as revenue. */
    if (l.isBonus) continue;
    const q = Number(l.qty);
    if (!q) continue;
    const m = matchOne(l.product, pool);
    if (!m.hit) { unmatched.add(l.product); continue; }
    const target = COST_TIERS.has(m.rule) ? agg : unverified;
    const a = target.get(m.hit.id) || { qty: 0, value: 0, lines: 0, rule: m.rule };
    a.qty += q;
    a.value += Number(l.subtotal || 0) || q * Number(l.unitPrice || 0);
    a.lines += 1;
    target.set(m.hit.id, a);
  }

  const byId = new Map();
  for (const [id, a] of agg) {
    if (a.qty > 0 && a.value > 0) {
      byId.set(id, { unitCost: a.value / a.qty, source: 'purchase', lines: a.lines, matchRule: a.rule });
    }
  }

  // Fall back to a lot's stated cost only where no purchase line was found.
  const lotAgg = new Map();
  for (const l of lots) {
    const m = matchOne(l.product, pool);
    /* The same tier rule as the purchase side. A lot matched by containment has
       the same unit-of-measure problem, and letting it in through the back door
       would undo the whole point of restricting the front one. */
    if (!m.hit || !COST_TIERS.has(m.rule) || byId.has(m.hit.id)) continue;
    const a = lotAgg.get(m.hit.id) || { qty: 0, value: 0 };
    a.qty += Number(l.qty || 0);
    a.value += Number(l.qty || 0) * Number(l.unitCost || 0);
    lotAgg.set(m.hit.id, a);
  }
  for (const [id, a] of lotAgg) {
    if (a.qty > 0 && a.value > 0) byId.set(id, { unitCost: a.value / a.qty, source: 'lot', lines: 0 });
  }

  const unverifiedIds = [...unverified.keys()]
    .filter((id) => !byId.has(id) && unverified.get(id).qty > 0 && unverified.get(id).value > 0);

  return {
    byId,
    coverage: {
      products: cat.rows.length,
      priced: byId.size,
      fromPurchases: [...byId.values()].filter((v) => v.source === 'purchase').length,
      fromLots: [...byId.values()].filter((v) => v.source === 'lot').length,
      /* Purchase-line names the catalogue does not know. Most are genuinely not
         consumables — rent, advertising, cannulas — so this is context, not a
         fault; it is reported so nobody has to guess whether it is one. */
      unmatchedPurchaseNames: unmatched.size,
      /* Priced by a rule too loose to trust the unit of. Reported, never summed. */
      basisUnverified: unverifiedIds.length,
    },
    /* Same shape as `byId`, so a page can show these beside the trusted ones
       and label them, rather than having to know they exist. */
    unverified: new Map(unverifiedIds.map((id) => {
      const a = unverified.get(id);
      return [id, { unitCost: a.value / a.qty, source: 'purchase', matchRule: a.rule, basisUnverified: true }];
    })),
  };
}

module.exports = { strip, norm, squash, TIERS, COST_TIERS, match, matchOne, poolOf, catalogue, links, costBasis };
