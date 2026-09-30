/* ============================================================
   Aggregation shared by the Node server and the standalone HTML.
   Pure logic — it never performs I/O itself; every Odoo call goes
   through `session.callKw(model, method, args, kwargs)`, supplied by the
   caller (Node uses HTTP+cookie, the browser uses fetch+credentials). Written as a UMD-ish module so the same
   source runs under `require()` and inlined in a <script> tag.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Aggregate = api;
})(typeof self !== 'undefined' ? self : this, function () {


const nameOf = (v, fallback) => (Array.isArray(v) ? v[1] : fallback);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

async function fetchInvoices(session, from, to, moveType) {
  const domain = [
    ['state', '=', 'posted'],
    ['move_type', '=', moveType],
    ['invoice_date', '>=', from],
    ['invoice_date', '<=', to],
  ];
  return session.callKw('account.move', 'search_read', [domain, [
    'id', 'name', 'invoice_date', 'branch_id', 'specialist_id', 'partner_id',
    'amount_untaxed', 'amount_total', 'is_new_customer', 'invoice_user_id',
  ]], { limit: 0, order: 'invoice_date asc, id asc' });
}

async function fetchLines(session, moveIds) {
  const out = [];
  for (let i = 0; i < moveIds.length; i += 800) {
    const chunk = moveIds.slice(i, i + 800);
    const rows = await session.callKw('account.move.line', 'search_read', [[
      ['move_id', 'in', chunk],
      ['display_type', '=', 'product'],
    ], ['id', 'move_id', 'product_id', 'quantity', 'price_subtotal', 'price_total']], { limit: 0 });
    out.push(...rows);
  }
  return out;
}

function bucket(map, key, label) {
  if (!map.has(key)) map.set(key, { key, name: label, ex: 0, inc: 0, qty: 0, invoices: new Set(), lines: 0 });
  return map.get(key);
}

const finish = (map, extra = () => ({})) =>
  [...map.values()]
    .map((b) => ({ name: b.name, ex: round2(b.ex), inc: round2(b.inc), qty: round2(b.qty), invoices: b.invoices.size, lines: b.lines, ...extra(b) }))
    .sort((a, b) => b.ex - a.ex);

async function buildReport(session, from, to) {
  const [invoices, refunds] = await Promise.all([
    fetchInvoices(session, from, to, 'out_invoice'),
    fetchInvoices(session, from, to, 'out_refund'),
  ]);

  const moveIds = invoices.map((m) => m.id);
  const lines = moveIds.length ? await fetchLines(session, moveIds) : [];

  const productIds = [...new Set(lines.map((l) => (Array.isArray(l.product_id) ? l.product_id[0] : null)).filter(Boolean))];
  const products = productIds.length
    ? await session.callKw('product.product', 'read', [productIds, ['id', 'display_name', 'categ_id', 'uom_id']])
    : [];
  const prodById = new Map(products.map((p) => [p.id, p]));

  const moveById = new Map(invoices.map((m) => [m.id, m]));

  /* headline */
  const totals = {
    ex: round2(invoices.reduce((s, m) => s + m.amount_untaxed, 0)),
    inc: round2(invoices.reduce((s, m) => s + m.amount_total, 0)),
    invoices: invoices.length,
    lines: lines.length,
    newCustomers: invoices.filter((m) => m.is_new_customer).length,
    refunds: { count: refunds.length, ex: round2(refunds.reduce((s, m) => s + m.amount_untaxed, 0)) },
  };

  /* branch / doctor / day — from invoice headers (authoritative, matches Odoo) */
  const branches = new Map(), doctors = new Map(), days = new Map(), branchDoctors = new Map();
  for (const m of invoices) {
    const bName = nameOf(m.branch_id, 'Unassigned');
    const dName = nameOf(m.specialist_id, 'Unassigned');
    for (const [map, key] of [[branches, bName], [doctors, dName], [days, m.invoice_date]]) {
      const b = bucket(map, key, key);
      b.ex += m.amount_untaxed; b.inc += m.amount_total; b.invoices.add(m.id);
    }
    const bd = bucket(branchDoctors, `${bName}||${dName}`, dName);
    bd.ex += m.amount_untaxed; bd.inc += m.amount_total; bd.invoices.add(m.id);
    bd.branch = bName;
    branches.get(bName).doctorSet = (branches.get(bName).doctorSet || new Set()).add(dName);
    doctors.get(dName).branchSet = (doctors.get(dName).branchSet || new Set()).add(bName);
  }

  /* product / category — from lines */
  const prods = new Map(), cats = new Map(), branchProducts = new Map(), doctorProducts = new Map();
  for (const l of lines) {
    const move = moveById.get(Array.isArray(l.move_id) ? l.move_id[0] : l.move_id);
    if (!move) continue;
    const p = prodById.get(Array.isArray(l.product_id) ? l.product_id[0] : 0);
    const pName = p ? p.display_name : nameOf(l.product_id, 'Unknown product');
    const cName = p ? nameOf(p.categ_id, 'Uncategorised') : 'Uncategorised';
    const bName = nameOf(move.branch_id, 'Unassigned');
    const dName = nameOf(move.specialist_id, 'Unassigned');

    for (const [map, key, label] of [
      [prods, pName, pName],
      [cats, cName, cName],
      [branchProducts, `${bName}||${pName}`, pName],
      [doctorProducts, `${dName}||${pName}`, pName],
    ]) {
      const b = bucket(map, key, label);
      b.ex += l.price_subtotal; b.inc += l.price_total; b.qty += l.quantity;
      b.lines += 1; b.invoices.add(move.id);
      if (map === branchProducts) b.branch = bName;
      if (map === doctorProducts) b.doctor = dName;
      if (map === prods) { b.category = cName; b.uom = p ? nameOf(p.uom_id, '') : ''; b.productId = p ? p.id : null; }
    }
  }

  const nest = (map, field) => {
    const out = {};
    for (const b of map.values()) {
      (out[b[field]] ||= []).push({ name: b.name, ex: round2(b.ex), inc: round2(b.inc), qty: round2(b.qty), invoices: b.invoices.size, lines: b.lines });
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => b.ex - a.ex);
    return out;
  };

  return {
    totals,
    branches: finish(branches, (b) => ({ doctors: b.doctorSet ? b.doctorSet.size : 0 })),
    doctors: finish(doctors, (b) => ({ branches: b.branchSet ? [...b.branchSet] : [] })),
    days: [...days.values()].map((b) => ({ date: b.name, ex: round2(b.ex), inc: round2(b.inc), invoices: b.invoices.size })).sort((a, b) => a.date.localeCompare(b.date)),
    products: finish(prods, (b) => ({ category: b.category, uom: b.uom, productId: b.productId })),
    categories: finish(cats),
    branchDoctors: nest(branchDoctors, 'branch'),
    branchProducts: nest(branchProducts, 'branch'),
    doctorProducts: nest(doctorProducts, 'doctor'),
    refundList: refunds.map((m) => ({
      name: m.name, date: m.invoice_date, branch: nameOf(m.branch_id, '—'),
      doctor: nameOf(m.specialist_id, '—'), partner: nameOf(m.partner_id, '—'),
      ex: round2(m.amount_untaxed), inc: round2(m.amount_total),
    })).sort((a, b) => b.ex - a.ex),
  };
}

const STOCK_SCAN_LIMIT = 400;   // SKUs read from stock.quant, largest first
const STOCK_DETAIL_LIMIT = 150; // of those, how many get a location breakdown

async function buildStock(session, topProductIds) {
  const grouped = await session.callKw('stock.quant', 'read_group', [
    [['location_id.usage', '=', 'internal']],
    ['quantity:sum', 'reserved_quantity:sum'],
    ['product_id'],
  ], { lazy: false, limit: STOCK_SCAN_LIMIT, orderby: 'quantity desc' });

  const ids = grouped.map((g) => (Array.isArray(g.product_id) ? g.product_id[0] : null)).filter(Boolean);
  const wanted = new Set([...ids.slice(0, STOCK_DETAIL_LIMIT), ...(topProductIds || [])]);
  // A truncated list must not read as the whole warehouse.
  const truncated = {
    scanned: grouped.length,
    shown: wanted.size,
    hitScanLimit: grouped.length >= STOCK_SCAN_LIMIT,
    droppedFromDetail: Math.max(0, ids.length - STOCK_DETAIL_LIMIT),
  };
  const detail = wanted.size
    ? await session.callKw('stock.quant', 'read_group', [
        [['location_id.usage', '=', 'internal'], ['product_id', 'in', [...wanted]]],
        ['quantity:sum'],
        ['product_id', 'location_id'],
      ], { lazy: false, limit: 0 })
    : [];

  const info = wanted.size
    ? await session.callKw('product.product', 'read', [[...wanted], ['id', 'display_name', 'categ_id', 'uom_id']])
    : [];
  const byId = new Map(info.map((p) => [p.id, p]));

  const rows = new Map();
  for (const g of grouped) {
    const id = Array.isArray(g.product_id) ? g.product_id[0] : null;
    if (!id || !wanted.has(id)) continue;
    const p = byId.get(id);
    rows.set(id, {
      productId: id,
      name: p ? p.display_name : nameOf(g.product_id, '—'),
      category: p ? nameOf(p.categ_id, '—') : '—',
      uom: p ? nameOf(p.uom_id, '') : '',
      qty: round2(g.quantity || 0),
      reserved: round2(g.reserved_quantity || 0),
      locations: [],
    });
  }
  for (const d of detail) {
    const id = Array.isArray(d.product_id) ? d.product_id[0] : null;
    const row = rows.get(id);
    if (!row) continue;
    row.locations.push({ name: nameOf(d.location_id, '—'), qty: round2(d.quantity || 0) });
  }
  for (const r of rows.values()) r.locations.sort((a, b) => b.qty - a.qty);
  return { rows: [...rows.values()].sort((a, b) => b.qty - a.qty), truncated };
}

  return { buildReport, buildStock };
});
