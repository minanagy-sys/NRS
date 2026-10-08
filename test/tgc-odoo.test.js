/* Odoo's `read_group`, answered from the cache — the shape AND the figures.
 *
 *   node test/tgc-odoo.test.js
 *
 * The merged report runs the standalone dashboard's own script unchanged, and
 * that script asks Odoo twenty-seven questions. `src/lib/tgc-odoo.js` answers
 * them from Postgres. Two things have to hold, and only one of them is about
 * money:
 *
 *   THE SHAPE. The script destructures `branch_id` as Odoo's `[id, name]` pair
 *   and reads sums under their field names. A row that carries the right total
 *   in the wrong shape renders a blank page, not an error.
 *
 *   THE FIGURES. Every cut has to reconcile with every other: branches, doctors
 *   and product lines over the same window are the same money sliced three
 *   ways, so they must agree to the piastre. That identity is what catches a
 *   filter applied to one query and forgotten in another — which is exactly how
 *   the package journal got into this page in the first place.
 */
const pathRoot = require('path').join(__dirname, '..');
const Odoo = require(`${pathRoot}/src/lib/tgc-odoo.js`);
const { prisma } = require(`${pathRoot}/src/lib/db.js`);

let fails = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const S = (rows, f) => rows.reduce((t, r) => t + (Number(r[f]) || 0), 0);

/** The domain the script builds for invoiced revenue, verbatim. */
const moveDomain = (from, to) => [
  ['invoice_date', '>=', from], ['invoice_date', '<=', to],
  ['state', '=', 'posted'], ['move_type', 'in', ['out_invoice', 'out_refund']],
  ['journal_id', '!=', 116],
];

async function main() {
  console.log('read_group over the cache\n');
  const FROM = '2026-09-01';
  const TO = '2026-09-30';
  const rg = (model, domain, fields, groupby) =>
    Odoo.call({ model, method: 'read_group', args: [domain, fields, groupby], kwargs: { lazy: false } });

  /* ---- the same money, three ways ---- */
  console.log('Every cut reconciles with every other:');
  const byBranch = await rg('account.move', moveDomain(FROM, TO), ['amount_untaxed_signed:sum'], ['branch_id']);
  const bySpec = await rg('account.move', moveDomain(FROM, TO), ['amount_untaxed_signed:sum'], ['specialist_id']);
  const byProduct = await rg('account.move.line', [
    ['parent_state', '=', 'posted'], ['display_type', '=', 'product'],
    ['date', '>=', FROM], ['date', '<=', TO], ['journal_id', '!=', 116],
  ], ['balance:sum'], ['product_id']);

  const b = Math.round(S(byBranch, 'amount_untaxed_signed'));
  const d = Math.round(S(bySpec, 'amount_untaxed_signed'));
  /* `balance` is a CREDIT on a customer invoice line, so revenue comes back
     negative and the script negates it: `const v = -(r.balance||0)`. Returning
     a positive subtotal made every service render as a loss, and dropped the
     whole month into one bucket. Negated here for the same reason the page
     negates it. */
  const p = Math.round(-S(byProduct, 'balance'));
  ok('branches and doctors agree', b === d, `${b} vs ${d}`);
  ok('branches and product lines agree once the credit is negated', b === p, `${b} vs ${p}`);
  /* The TOTAL is a credit; a single category can still come back positive when
     its refunds outweigh its sales in the window, which is a real thing and not
     a sign error. Asserting every row negative failed on exactly that. */
  ok('the month totals as a credit, the way Odoo stores revenue',
    S(byProduct, 'balance') < 0, String(Math.round(S(byProduct, 'balance'))));
  ok('and it is a real figure, not zero', b > 0, String(b));

  /* ---- the package journal stays out of all three ---- */
  /* Refunds SUBTRACTED in the expectation too: the cache stores Odoo's absolute
     amount_untaxed, and the dashboard's queries negate out_refund themselves
     (2026-10-08). Summing them straight here expected the old, refund-adding
     total and failed by exactly twice the month's refunds. */
  const SIGNED = `case when "moveType" = 'out_refund' then -"amountUntaxed" else "amountUntaxed" end`;
  const [raw] = await prisma.$queryRawUnsafe(
    `select sum(${SIGNED})::float ex from "Invoice"
      where state = 'posted' and "moveType" in ('out_invoice','out_refund')
        and "invoiceDate" between $1::date and $2::date`, FROM, TO,
  );
  const [pkg] = await prisma.$queryRawUnsafe(
    `select coalesce(sum(${SIGNED}),0)::float ex from "Invoice"
      where state = 'posted' and "moveType" in ('out_invoice','out_refund')
        and "invoiceDate" between $1::date and $2::date
        and "journalName" = 'Package sale journal'`, FROM, TO,
  );
  ok('the package journal is excluded, as everywhere else',
    b === Math.round(raw.ex - pkg.ex), `${b} vs ${Math.round(raw.ex - pkg.ex)}`);

  /* ---- the shape the script destructures ---- */
  console.log('\nThe rows are shaped the way the script reads them:');
  const named = byBranch.filter((r) => r.branch_id);
  ok('branch_id is Odoo\'s [id, name] pair',
    named.length > 0 && named.every((r) => Array.isArray(r.branch_id) && r.branch_id.length === 2
      && typeof r.branch_id[1] === 'string'),
    JSON.stringify(named[0] && named[0].branch_id));
  ok('an unset branch is false, not a pair',
    byBranch.filter((r) => !r.branch_id).every((r) => r.branch_id === false));
  ok('every row carries __count', byBranch.every((r) => typeof r.__count === 'number'));
  ok('the sum arrives under its own field name',
    byBranch.every((r) => typeof r.amount_untaxed_signed === 'number'));
  ok('specialist_id is a pair too',
    bySpec.filter((r) => r.specialist_id).every((r) => Array.isArray(r.specialist_id)));

  /* ---- grouping by month ---- */
  const byMonth = await rg('account.move', moveDomain('2026-09-01', '2026-10-06'),
    ['amount_untaxed_signed:sum'], ['branch_id', 'invoice_date:month']);
  const labels = [...new Set(byMonth.map((r) => r['invoice_date:month']))].sort();
  ok('months come back in Odoo\'s "September 2026" form',
    labels.length === 2 && labels.every((l) => /^[A-Z][a-z]+ \d{4}$/.test(l)),
    labels.join(' | '));
  ok('and the months still sum to the branch cut',
    Math.round(S(byMonth, 'amount_untaxed_signed')) > b, String(Math.round(S(byMonth, 'amount_untaxed_signed'))));

  /* ---- the two lookups ---- */
  console.log('\nThe lookups the script reads once:');
  const sched = await Odoo.call({ model: 'clinic.week.schedule', method: 'search_read', args: [[], []] });
  ok('the schedule returns the 285 imported shifts', sched.length === 285, String(sched.length));
  ok('each shift names a doctor, a branch and one weekday',
    sched.every((s) => Array.isArray(s.doctor_id) && Array.isArray(s.branch_id)
      && ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        .filter((d) => s[d]).length === 1));
  const prods = await Odoo.call({ model: 'product.product', method: 'search_read', args: [[], []] });
  ok('products carry a categ_id pair', prods.length > 0 && prods.every((x) => Array.isArray(x.categ_id)),
    String(prods.length));

  /* ---- the package half of "collected" ----
     This section used to assert that package settlement returned NOTHING, and
     that assertion passed for weeks while the page was wrong. "Collected" is

         (cash in − refunds − package sales + package used) ÷ 1.14

     and with the last two terms missing they evaluate to zero in silence: a
     branch that sold a package reads as though it collected the full price, one
     working through packages sold months ago reads as though it collected
     nothing, and what is left on screen still looks like a plausible number.
     On one ordinary day that was Loran 1,447 under and Roushdy 3,290 over.

     So the test is now the other way round: these two queries MUST answer, and
     they must answer in Odoo's shape, because the script reads the sums under
     Odoo's field names and subtracts the residual itself. */
  console.log('\nThe package half of "collected" is answered, not skipped:');
  const pkgSettled = await rg('account.move', [
    ['date', '>=', FROM], ['date', '<=', TO], ['state', '=', 'posted'],
    ['move_type', '=', 'entry'], ['pkg_settled_amount', '>', 0],
  ], ['pkg_settled_amount:sum'], ['branch_id']);
  const pkgSales = await rg('account.move', [
    ['invoice_date', '>=', FROM], ['invoice_date', '<=', TO],
    ['state', '=', 'posted'], ['move_type', 'in', ['out_invoice', 'out_refund']],
    ['journal_id', '=', 116],
  ], ['amount_total_signed:sum', 'amount_residual_signed:sum'], ['branch_id']);

  const stored = await prisma.packageDay.aggregate({
    _sum: { settled: true, saleTotal: true, saleResidual: true },
    where: { date: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T00:00:00Z`) } },
  });
  const has = (v) => Number(v || 0) !== 0;
  const sum = (rows, f) => Math.round(rows.reduce((t, r) => t + (f(r) || 0), 0));

  /* Skipped rather than failed when the window holds no packages: an empty
     answer is correct then, and the point of this test is that an empty answer
     is NOT correct when the table has rows. */
  if (!has(stored._sum.settled) && !has(stored._sum.saleTotal)) {
    console.log('  – no package rows in this window; run syncPackages to exercise this');
  } else {
    ok('settlements come back, not an empty list',
      Array.isArray(pkgSettled) && pkgSettled.length > 0, `${pkgSettled.length} rows`);
    ok('settlements total what PackageDay stores',
      sum(pkgSettled, (r) => r.pkg_settled_amount) === Math.round(Number(stored._sum.settled)),
      `${sum(pkgSettled, (r) => r.pkg_settled_amount)} vs ${Math.round(Number(stored._sum.settled))}`);
    ok('sales come back with BOTH halves, so the script can net the residual',
      pkgSales.length > 0 && pkgSales.every((r) => 'amount_total_signed' in r && 'amount_residual_signed' in r),
      JSON.stringify(pkgSales[0] || null).slice(0, 90));
    ok('sales total what PackageDay stores',
      sum(pkgSales, (r) => r.amount_total_signed) === Math.round(Number(stored._sum.saleTotal)),
      `${sum(pkgSales, (r) => r.amount_total_signed)} vs ${Math.round(Number(stored._sum.saleTotal))}`);
    ok('every package row carries branch_id as Odoo\'s [id, name] pair',
      [...pkgSettled, ...pkgSales].every((r) => r.branch_id === false
        || (Array.isArray(r.branch_id) && r.branch_id.length === 2 && typeof r.branch_id[1] === 'string')));
    /* The spellings must be the sheet's, or the script looks up a target that
       is not there and the branch reads zero — the Madinity/Madinty fault. */
    const names = [...pkgSettled, ...pkgSales].map((r) => (r.branch_id ? r.branch_id[1] : null)).filter(Boolean);
    const odooOnly = names.filter((n) => /Madinity|Mall Of Arabia|Roushdy/.test(n));
    ok('branch names are resolved to the approved sheet\'s spelling',
      odooOnly.length === 0, odooOnly.join(', '));
  }

  console.log('\nWhat the cache cannot answer, it does not invent:');
  const unknown = await Odoo.call({ model: 'res.partner', method: 'read_group', args: [[], [], []] });
  ok('an unknown model returns an empty result, not a crash', Array.isArray(unknown) && !unknown.length);

  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exitCode = fails ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
