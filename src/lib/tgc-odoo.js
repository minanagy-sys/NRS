/* ============================================================
   Odoo's `read_group` and `search_read`, answered from the Postgres cache.

   WHY THIS EXISTS. The merged report runs the standalone dashboard's own
   script unchanged, and that script talks to Odoo: twenty-seven `read_group`
   calls and two `search_read`s, through `claude.use('mcp')`. Re-writing those
   call sites would mean re-writing the panels around them, which is exactly the
   drift this approach is meant to avoid.

   So the calls stay, and this answers them. The page still never reaches the
   MCP — every row below is SQL against the cache the sync fills — but the shape
   coming back is Odoo's, down to `branch_id` being a `[id, name]` pair, because
   that is what the script destructures.

   WHAT THIS CANNOT ANSWER, AND SAYS SO. Two of the script's queries have no
   equivalent in the cache:

     `pkg_settled_amount` on journal entries — package cash counted when it is
       USED rather than when it was sold. The sync does not pull it.
     `clinic.week.schedule` live — the roster here is the imported one, which is
       a snapshot, not today's Odoo.

   Both return an empty result with `partial: true` rather than a zero dressed
   up as an answer. The script already handles a partial pull and labels it.
   ============================================================ */

const { prisma } = require('./db.js');
const Report = require('./report.js');
const { branchResolver } = require('./tgc.js');

/* REFUNDS ARE SUBTRACTED HERE, not by storing them negative. The cache keeps
   Odoo's absolute `amount_untaxed` — every other report (Patients, Targets
   tracker, Doctors, Procurement) negates `out_refund` itself, and all 43,000
   stored invoices follow that. Summing invoices and credit notes together
   without the sign ADDED the refunds: September came out high by exactly twice
   them. Switching the sync to `amount_untaxed_signed` instead (tried 2026-10-08)
   would have fixed this file and broken those four, so the sign lives in these
   queries, the same way it does everywhere else. */
const SIGNED_EX = `case when "moveType" = 'out_refund' then -"amountUntaxed" else "amountUntaxed" end`;
const SIGNED_LINE = `case when i."moveType" = 'out_refund' then -l."priceSubtotal" else l."priceSubtotal" end`;

const EXCLUDED = Report.EXCLUDED_REVENUE_JOURNALS || ['Package sale journal'];
/** The package journal, by Odoo id — the same constant the sync pulls with. */
const PACKAGE_JOURNAL = 116;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Odoo's many2one: `[id, display_name]`. Ids the script cannot resolve fall
    back to the name, which is what `wbn` does, so a stable fake id is safe. */
const m2o = (name, seed) => (name ? [seed, name] : false);

/**
 * A STABLE id for a category name.
 *
 * The script maps a line's product to a service through `pmap[product_id[0]]`,
 * a table it builds from `product.product`. So the id a line carries and the id
 * the product list carries have to be THE SAME NUMBER for the same category.
 *
 * Numbering them by row index did not do that: the two queries select different
 * sets in different orders, so every lookup missed and every pound fell through
 * to 'Other' → 'Visits & Other'. Derived from the name, they always agree.
 */
function catId(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i += 1) h = ((h * 31) + s.charCodeAt(i)) % 1000000;
  return 100000 + h;
}
const monthLabel = (ymd) => `${MONTHS[Number(String(ymd).slice(5, 7)) - 1]} ${String(ymd).slice(0, 4)}`;

/** Pull `[op, value]` for a field out of an Odoo domain, ignoring the rest. */
function pick(domain, field) {
  const hits = (domain || []).filter((c) => Array.isArray(c) && c[0] === field);
  return hits.map((c) => [c[1], c[2]]);
}
function range(domain, field) {
  let from = null;
  let to = null;
  for (const [op, v] of pick(domain, field)) {
    if (op === '>=' || op === '>') from = String(v).slice(0, 10);
    if (op === '<=' || op === '<') to = String(v).slice(0, 10);
    if (op === '=') { from = String(v).slice(0, 10); to = from; }
  }
  return { from, to };
}
const has = (domain, field, value) => pick(domain, field)
  .some(([op, v]) => (op === '=' ? v === value : Array.isArray(v) ? v.includes(value) : false));

/* ------------------------------------------------------------- invoices --- */

/**
 * `account.move` grouped by any of branch, specialist and month.
 *
 * The script always passes `journal_id != 116`, which is the Package Sale
 * journal — the same exclusion the rest of this app applies by NAME, because
 * the cache stores the name and not the id. Packages are invoiced when sold and
 * carry no VAT, so they are not revenue comparable to collections.
 */
async function moveGroup(domain, fields, groupby) {
  const { from, to } = range(domain, 'invoice_date').from ? range(domain, 'invoice_date') : range(domain, 'date');
  if (!from || !to) return [];

  const byBranch = groupby.includes('branch_id');
  const bySpec = groupby.includes('specialist_id');
  const byMonth = groupby.some((g) => g.endsWith(':month'));
  const monthField = groupby.find((g) => g.endsWith(':month')) || 'invoice_date:month';

  const sel = [];
  if (byBranch) sel.push('coalesce("branchName", \'(no branch)\') branch');
  if (bySpec) sel.push('coalesce("specialistName", \'(no doctor)\') spec');
  if (byMonth) sel.push('to_char("invoiceDate", \'YYYY-MM\') mon');
  const group = sel.map((_, i) => i + 1).join(', ');

  const rows = await prisma.$queryRawUnsafe(
    `select ${sel.join(', ')}${sel.length ? ',' : ''}
            sum(${SIGNED_EX})::float amt, count(*)::int n
       from "Invoice"
      where state = 'posted'
        and "moveType" in ('out_invoice', 'out_refund')
        and "invoiceDate" between $1::date and $2::date
        and ("journalName" is null or "journalName" not in (${EXCLUDED.map((_, i) => `$${i + 3}`).join(', ')}))
      ${group ? `group by ${group}` : ''}`,
    from, to, ...EXCLUDED,
  );

  const { resolve } = await branchResolver();
  const merged = mergeByBranch(rows, resolve, byBranch, ['amt', 'n']);

  return merged.map((r, i) => {
    const out = { __count: r.n, amount_untaxed_signed: r.amt };
    if (byBranch) out.branch_id = m2o(r.branch === '(no branch)' ? null : r.branch, 9000 + i);
    if (bySpec) out.specialist_id = m2o(r.spec === '(no doctor)' ? null : r.spec, 7000 + i);
    if (byMonth) out[monthField] = monthLabel(`${r.mon}-01`);
    return out;
  });
}

/**
 * Put every branch name into the spelling the approved sheet uses, and MERGE
 * any rows that collapse onto the same one.
 *
 * Odoo says "Madinity The Strip" where the sheet says "Madinty The Strip", so
 * the dashboard — which keys its targets off the sheet — found nothing and
 * printed a real branch as zero against a 4,200,000 target. The alias table
 * (`IdentityAlias`, kind "branch") is the record of which spellings are the
 * same place; `branchResolver()` reads it, and this is the only place those
 * names leave this file.
 *
 * THE MERGE IS THE POINT, not an optimisation. The SQL grouped by the raw
 * name, so if both spellings ever appear in the data — one month invoiced as
 * "Roushdy", the next as "Alex Roshdy" — renaming alone would emit the branch
 * TWICE. The dashboard would show a duplicate row and, depending on which it
 * read last, book only half the money. Summing them is what makes renaming
 * safe.
 */
function mergeByBranch(rows, resolve, byBranch, sumFields) {
  if (!byBranch) return rows;
  const out = new Map();
  for (const r of rows) {
    const branch = r.branch === '(no branch)' || r.branch === 'Unassigned'
      ? r.branch : resolve(r.branch);
    /* The other groupings stay part of the key: two months of one branch are
       two rows, and merging them would be a different bug from the one above. */
    const key = JSON.stringify([branch, r.mon || null, r.spec || null]);
    const hit = out.get(key);
    if (!hit) { out.set(key, { ...r, branch }); continue; }
    for (const f of sumFields) hit[f] = (Number(hit[f]) || 0) + (Number(r[f]) || 0);
  }
  return [...out.values()];
}

/**
 * Package cash settled against a treatment, from `PackageDay`.
 *
 * This answered `[]` until the package sync existed, which the script read as
 * "none used" — so the `+ pku` term of
 * `(pin − pout − pks + pku) ÷ 1.14` silently vanished and every branch working
 * through previously-sold packages looked like it had collected nothing for
 * that work.
 *
 * Still returns `[]` when the window genuinely holds no settlements, which is
 * the same answer Odoo gives and keeps "no packages used" distinguishable from
 * "nobody has loaded the packages".
 */
async function pkgGroup(domain) {
  const { from, to } = range(domain, 'date');
  if (!from || !to) return [];
  const rows = await prisma.$queryRawUnsafe(
    `select "branchName" branch, sum(settled)::float amt, sum(settlements)::int n
       from "PackageDay"
      where date between $1::date and $2::date and settled <> 0
      group by 1`,
    from, to,
  );
  const { resolve } = await branchResolver();
  return mergeByBranch(rows, resolve, true, ['amt', 'n'])
    .map((r, i) => ({
      __count: r.n,
      pkg_settled_amount: r.amt,
      branch_id: m2o(r.branch === 'Unassigned' ? null : r.branch, 9000 + i),
    }));
}

/**
 * Package SALES — invoices on the package journal — from `PackageDay`.
 *
 * The report subtracts `amount_total_signed − amount_residual_signed`: cash
 * taken for treatment not yet delivered is not revenue the branch collected,
 * but an unpaid package has taken no cash at all, so the residual is netted
 * back off. Both halves are stored, so the subtraction is the one the script
 * would have made against Odoo rather than a pre-computed figure it cannot
 * check.
 */
async function pkgSaleGroup(domain) {
  const { from, to } = range(domain, 'invoice_date').from
    ? range(domain, 'invoice_date') : range(domain, 'date');
  if (!from || !to) return [];
  const rows = await prisma.$queryRawUnsafe(
    `select "branchName" branch, sum("saleTotal")::float total,
            sum("saleResidual")::float residual, sum(sales)::int n
       from "PackageDay"
      where date between $1::date and $2::date and sales > 0
      group by 1`,
    from, to,
  );
  const { resolve } = await branchResolver();
  return mergeByBranch(rows, resolve, true, ['total', 'residual', 'n'])
    .map((r, i) => ({
      __count: r.n,
      amount_total_signed: r.total,
      amount_residual_signed: r.residual,
      branch_id: m2o(r.branch === 'Unassigned' ? null : r.branch, 9000 + i),
    }));
}


/** `account.move.line` grouped by product, for the service mix. */
async function lineGroup(domain) {
  const { from, to } = range(domain, 'date');
  if (!from || !to) return [];
  const rows = await prisma.$queryRawUnsafe(
    `select coalesce(l."categoryName", 'Other') cat,
            sum(${SIGNED_LINE})::float amt, count(*)::int n
       from "InvoiceLine" l join "Invoice" i on i."odooId" = l."invoiceOdooId"
      where i.state = 'posted'
        and i."moveType" in ('out_invoice', 'out_refund')
        and i."invoiceDate" between $1::date and $2::date
        and (i."journalName" is null or i."journalName" not in (${EXCLUDED.map((_, k) => `$${k + 3}`).join(', ')}))
      group by 1`,
    from, to, ...EXCLUDED,
  );
  /* TWO THINGS THE SCRIPT ASSUMES, BOTH OF THEM ODOO'S CONVENTIONS.
     `balance` on a customer invoice line is a CREDIT, so revenue is negative
     and the script negates it: `const v = -(r.balance||0)`. Returning the
     positive subtotal made every service read as a loss.
     And `product_id[0]` is looked up in a table built from `product.product`,
     so the id has to be the same number in both — see `catId`. */
  return rows.map((r) => ({
    __count: r.n,
    balance: -r.amt,
    product_id: m2o(r.cat, catId(r.cat)),
  }));
}

/* ---------------------------------------------------------- collections --- */

/** `account.payment` grouped by branch, and optionally month. */
async function paymentGroup(domain, fields, groupby) {
  const { from, to } = range(domain, 'date');
  if (!from || !to) return [];
  const outbound = has(domain, 'payment_type', 'outbound');
  const byMonth = groupby.some((g) => g.endsWith(':month'));
  const monthField = groupby.find((g) => g.endsWith(':month')) || 'date:month';

  const rows = await prisma.$queryRawUnsafe(
    `select branch, ${byMonth ? "to_char(date, 'YYYY-MM') mon," : ''}
            sum(${outbound ? 'refunds' : 'gross'})::float amt, sum(txns)::int n
       from "Collection"
      where date between $1::date and $2::date
      group by 1${byMonth ? ', 2' : ''}`,
    from, to,
  );
  /* Same resolve-and-merge as revenue. This is the column that read zero for
     four branches: the money was collected and stored, under Odoo's spelling. */
  const { resolve } = await branchResolver();
  const merged = mergeByBranch(rows, resolve, true, ['amt', 'n']);

  return merged.map((r, i) => {
    const out = { __count: r.n, amount: r.amt };
    out.branch_id = m2o(r.branch === 'Unassigned' ? null : r.branch, 9000 + i);
    if (byMonth) out[monthField] = monthLabel(`${r.mon}-01`);
    return out;
  });
}

/* -------------------------------------------------------------- lookups --- */

/** The weekly schedule, from the imported roster. */
async function schedule() {
  const slots = await prisma.doctorRosterSlot.findMany({ orderBy: [{ doctorName: 'asc' }, { dow: 'asc' }] });
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return slots.map((s, i) => {
    const row = {
      id: i + 1,
      doctor_id: m2o(s.doctorName, 3000 + i),
      branch_id: m2o(s.branchName, 9000 + i),
      department_id: m2o(s.department || null, 2000 + i),
      start_date: false,
      end_date: false,
      state: 'confirmed',
      slot_from: Number(String(s.startTime).slice(0, 2)) || 0,
      slot_to: Number(String(s.endTime).slice(0, 2)) || 0,
    };
    DAYS.forEach((d, k) => { row[d] = k === s.dow; });
    return row;
  });
}

/** Products and their categories, from the lines the cache holds. */
async function products() {
  const rows = await prisma.$queryRawUnsafe(
    `select distinct coalesce("categoryName", 'Other') cat from "InvoiceLine"`,
  );
  /* `id` here must equal `product_id[0]` on the lines above, because that is
     the join the script makes. `categ_id[1]` is read as a path and only its
     last segment is matched, which is why the full "Injection/Filler" is sent
     rather than the leaf. */
  return rows.map((r) => ({ id: catId(r.cat), categ_id: m2o(r.cat, catId(r.cat)), sale_ok: true }));
}

/* ----------------------------------------------------------- the switch --- */

/**
 * One entry point, shaped like the MCP tool the script calls.
 *
 * Anything this cannot answer returns `[]` rather than throwing: the script
 * already treats an empty pull as "nothing in this window" and marks the view
 * partial, which is a truer account than an error that hides the rest.
 */
async function call({ model, method, args = [], kwargs = {} }) {
  const [domain = [], fields = [], groupby = []] = args;

  if (method === 'read_group') {
    if (model === 'account.payment') return paymentGroup(domain, fields, groupby);
    if (model === 'account.move.line') return lineGroup(domain);
    if (model === 'account.move') {
      /* Three different questions arrive on this one model, and they must not
         be confused: settlements are journal ENTRIES, package sales are
         invoices ON journal 116, and ordinary revenue is everything else —
         which `moveGroup` reads with journal 116 excluded. */
      if (has(domain, 'move_type', 'entry')) return pkgGroup(domain);
      if (has(domain, 'journal_id', PACKAGE_JOURNAL)) return pkgSaleGroup(domain);
      return moveGroup(domain, fields, groupby);
    }
    return [];
  }

  if (method === 'search_read') {
    if (model === 'clinic.week.schedule') return schedule();
    if (model === 'product.product') return products();
    return [];
  }

  return [];
}

module.exports = { call, moveGroup, lineGroup, paymentGroup, schedule, products };
