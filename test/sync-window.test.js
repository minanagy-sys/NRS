/**
 * The database half of a sync, at the size that broke it.
 *
 *   node test/sync-window.test.js
 *
 * On 2026-10-07 every "Year to date → Sync now" on the live site failed. The
 * MCP had answered — the fetch took ~20 s and returned 43,568 invoices — and
 * then the delete that clears the window sent every one of those ids in a
 * single statement. Postgres allows 32,767 bind values; the statement was
 * refused, and the page said "Could not reach the MCP".
 *
 * This replays that write at the live size — 43,568 invoices, 94,586 lines —
 * in the year 2099, where nothing real lives, inside a transaction that is
 * ROLLED BACK at the end. Nothing it writes survives, whether it passes or not.
 */

const assert = require('assert');
const { prisma } = require('../src/lib/db.js');
const { replaceInvoiceWindow, explainSyncError } = require('../src/lib/sync.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label} — ${e.message.split('\n').filter(Boolean).pop()}`); }
};

const N_INV = 43568;          // the live year-to-date count on 2026-10-07
const N_LINES = 94586;
const BASE = 900000000;       // far above any real Odoo id
const FROM = '2099-01-01';
const TO = '2099-10-07';
const ROLLBACK = new Error('rollback — this test writes nothing');

const day = (i) => `2099-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
const invoices = Array.from({ length: N_INV }, (_, i) => ({
  id: BASE + i, name: `TEST/${i}`, invoice_date: day(i), move_type: 'out_invoice', state: 'posted',
  branch_id: [1, 'Test'], specialist_id: false, partner_id: false,
  amount_untaxed: 100, amount_total: 114, is_new_customer: false, journal_id: [1, 'Sales'],
}));
const lines = Array.from({ length: N_LINES }, (_, i) => ({
  id: BASE + i, move_id: [BASE + (i % N_INV), 'x'], product_id: false,
  quantity: 1, price_subtotal: 100, price_total: 114,
}));
const moveIds = invoices.map((m) => m.id);

(async () => {
  console.log(`\nthe window replace, at the live year-to-date size (${N_INV.toLocaleString()} invoices)`);

  await check('the OLD single-statement delete is refused by Postgres — the live failure, reproduced', async () => {
    let err = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.invoice.deleteMany({
          where: { OR: [{ invoiceDate: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T00:00:00Z`) } },
            { odooId: { in: moveIds } }] },
        });
        throw ROLLBACK;
      });
    } catch (e) { err = e; }
    assert.ok(err && err !== ROLLBACK, 'the old query ran — the limit was not reached, so this proves nothing');
    assert.ok(/bind variables|too many/i.test(err.message), `failed for another reason: ${err.message.slice(0, 120)}`);
  });

  let inside = null;
  let ms = 0;
  await check('the new replace writes every invoice and line in one transaction', async () => {
    const t = Date.now();
    try {
      await prisma.$transaction(async (tx) => {
        await replaceInvoiceWindow(tx, { from: FROM, to: TO, invoices, lines, byProduct: new Map(), moveIds });
        inside = {
          inv: await tx.invoice.count({ where: { odooId: { gte: BASE } } }),
          lines: await tx.invoiceLine.count({ where: { odooId: { gte: BASE } } }),
        };
        /* A second pass over the same window: the replace must REPLACE, never add. */
        await replaceInvoiceWindow(tx, { from: FROM, to: TO, invoices, lines, byProduct: new Map(), moveIds });
        inside.again = await tx.invoice.count({ where: { odooId: { gte: BASE } } });
        throw ROLLBACK;
      }, { timeout: 120_000 });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    ms = Date.now() - t;
    assert.strictEqual(inside.inv, N_INV);
    assert.strictEqual(inside.lines, N_LINES);
  });
  await check('  and running it twice replaces rather than doubling', async () => {
    assert.strictEqual(inside && inside.again, N_INV);
  });
  await check(`  inside the 120 s transaction limit and nginx's 180 s (took ${(ms / 1000).toFixed(1)} s for two passes)`, async () => {
    /* Only meaningful if the work actually ran — it passed vacuously in 0.0 s
       the first time, against a database that was not even up. */
    assert.ok(inside && inside.inv === N_INV, 'the replace never ran, so there is no time to judge');
    assert.ok(ms < 120000, `${ms} ms`);
  });

  await check('an invoice whose DATE moved out of the window is still cleared by its id', async () => {
    /* The reason the id delete exists: Odoo moved INV/2026/5479 from 1 Sep to
       16 Aug after it was cached, so a date-only delete missed the stale row and
       the insert died on the unique id. */
    try {
      await prisma.$transaction(async (tx) => {
        await tx.invoice.create({ data: { odooId: BASE + 1, name: 'STALE', invoiceDate: new Date('2098-12-31T00:00:00Z'),
          moveType: 'out_invoice', state: 'posted', amountUntaxed: 1, amountTotal: 1 } });
        await replaceInvoiceWindow(tx, { from: FROM, to: TO, invoices: invoices.slice(0, 5), lines: [], byProduct: new Map(), moveIds: moveIds.slice(0, 5) });
        const row = await tx.invoice.findUnique({ where: { odooId: BASE + 1 } });
        assert.strictEqual(row.name, 'TEST/1', 'the stale row survived, or the insert collided');
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  });

  await check('nothing from this test is left behind', async () => {
    assert.strictEqual(await prisma.invoice.count({ where: { odooId: { gte: BASE } } }), 0);
    assert.strictEqual(await prisma.invoiceLine.count({ where: { odooId: { gte: BASE } } }), 0);
  });

  console.log('\nwhat the reader is told');
  await check('a database error inside NRS is NOT reported as "could not reach the MCP"', async () => {
    const [code, msg] = explainSyncError(new Error('too many bind variables'));
    assert.strictEqual(code, 500);
    assert.ok(/inside NRS/.test(msg) && !/Could not reach/.test(msg), msg);
  });
  await check('  a dropped connection still is', async () => {
    const e = new Error('terminated'); e.kind = 'transport';
    assert.ok(/Could not reach the MCP/.test(explainSyncError(e)[1]));
  });
  await check('  an expired sign-in and an Odoo outage keep their own answers', async () => {
    assert.strictEqual(explainSyncError(Object.assign(new Error(), { kind: 'token' }))[0], 401);
    assert.strictEqual(explainSyncError(Object.assign(new Error(), { kind: 'odoo' }))[0], 503);
  });
  await check('  and every message says nothing was changed, except the sign-in one which needs none', async () => {
    for (const k of ['odoo', 'transport', 'mcp', undefined]) {
      assert.ok(/Nothing was changed/.test(explainSyncError(Object.assign(new Error(), { kind: k }))[1]), String(k));
    }
  });

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error('✗', e.stack || e.message); await prisma.$disconnect(); process.exit(1); });
