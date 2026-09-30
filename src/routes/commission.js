/* The Commission Policy 2026 — reads for the Targets tab, writes for the editor.
 *
 * Everything editable that Mina asked for lives behind these routes: the target
 * itself, the 80/90/100 bands per branch per month, the departments, the
 * branches, and which entity owns a branch. Writes are batched because the thing
 * being edited is a grid — saving 132 cells one request at a time would be both
 * slow and non-atomic.
 *
 * Every write is gated by ADMIN_PASSPHRASE through the same Gate the target
 * sheets use, and audited. Reads only need a signed-in user. */

const { prisma } = require('../lib/db.js');
const Gate = require('../lib/admin-gate.js');
const Commission = require('../lib/commission.js');
const R = require('../lib/commission-rules.js');
const Schemes = require('../lib/commission-schemes.js');

const guard = (req, reply) =>
  req.headers['x-requested-with'] === 'fetch' ? null : reply.code(403).send({ error: 'Missing X-Requested-With.' });

const YEAR_MIN = 2020;
const YEAR_MAX = 2100;

const asYear = (v, fallback = Commission.YEAR_DEFAULT) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX ? n : fallback;
};

/** A band is a share, so 0-2 covers every sane policy and nothing else.
 *  null is meaningful and must survive: it means "follow the policy default". */
function band(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error(`${label} must be a share between 0 and 2, or blank to follow the policy.`);
  return Number(n.toFixed(4));
}

function money(v, label) {
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number, and not negative.`);
  return n.toFixed(2);
}

/** A money-ish figure that is allowed to be blank, and blank is NOT zero:
 *  `hourlyRate: null` carries "no working hours are counted on this scheme",
 *  which zero would quietly turn into "counted, at nothing an hour". */
function rate(v, label, max) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} must be between 0 and ${max.toLocaleString('en-US')}, or blank.`);
  return Number(n.toFixed(2));
}

/** A percentage written either way. 10 and 0.1 are the same withholding, and
 *  somebody will type each — but 10 as a SHARE would be 1000%, so the reading
 *  is fixed here rather than guessed per screen. */
function share(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const raw = Number(String(v).replace(/[%,\s]/g, ''));
  if (!Number.isFinite(raw) || raw < 0) throw new Error(`${label} must be a percentage.`);
  const n = raw > 1 ? raw / 100 : raw;
  if (n > 1) throw new Error(`${label} cannot be more than 100%.`);
  return Number(n.toFixed(4));
}

/**
 * A scheme's bands, checked as a SET.
 *
 * Ordered by where they start, then walked: a band that starts below the end of
 * the one before it OVERLAPS, and an overlap means the rate depends on which
 * band the lookup finds first — the same revenue paying two different rates
 * depending on the order rows happen to be stored in. That is refused.
 *
 * A GAP is allowed and reported. The workbook has one (Exclusive leaves
 * 1,000,000-1,300,000 undefined) and the report already refuses to invent a
 * rate inside it. Closing it here would be this file deciding a commission.
 */
function bands(list) {
  if (!Array.isArray(list)) throw new Error('Bands must be a list.');
  const out = list.map((b, i) => {
    const from = Number(String(b.from === '' || b.from === null || b.from === undefined ? 0 : b.from).replace(/,/g, ''));
    const to = (b.to === '' || b.to === null || b.to === undefined) ? null : Number(String(b.to).replace(/,/g, ''));
    const r = share(b.rate, `Band ${i + 1} rate`);
    if (!Number.isFinite(from) || from < 0) throw new Error(`Band ${i + 1} starts at something that is not a number.`);
    if (to !== null && (!Number.isFinite(to) || to < from)) throw new Error(`Band ${i + 1} ends below where it starts.`);
    if (r === null) throw new Error(`Band ${i + 1} has no rate.`);
    return { from, to, rate: r };
  }).sort((a, b) => a.from - b.from);

  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    if (prev.to === null) throw new Error('Only the last band may be open-ended.');
    if (out[i].from <= prev.to) {
      throw new Error(`Bands overlap: ${prev.from.toLocaleString('en-US')}-${prev.to.toLocaleString('en-US')} `
        + `and ${out[i].from.toLocaleString('en-US')} both cover ${out[i].from.toLocaleString('en-US')}. `
        + 'The same revenue would earn two different rates.');
    }
  }
  return out;
}

const str = (v, label, max = 120) => {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) throw new Error(`${label} cannot be empty.`);
  if (s.length > max) throw new Error(`${label} is too long (limit ${max}).`);
  return s;
};

module.exports = async function (app) {
  const requireWriter = [app.requireUser, Gate.requireWriter(app)];

  /* ---------- reads ---------- */

  /** Everything the editor needs in one trip. */
  app.get('/api/commission', { preHandler: app.requireUser }, async (req) => {
    const year = asYear(req.query.year);
    const [grid, policy, tiers, roles, gates, rules, callCenter, notes] = await Promise.all([
      Commission.targetGrid(year), Commission.loadPolicy(), Commission.loadTiers(),
      Commission.loadRoles(), Commission.loadGates(), Commission.loadRules(),
      Commission.loadCallCenter(), Commission.loadNotes(),
    ]);
    return {
      grid,
      policy: policy.rows,
      resolved: { bands: policy.bands, vatDivisor: policy.vatDivisor, multiplierCap: policy.multiplierCap, baseDefinition: policy.baseDefinition, version: policy.version },
      tiers: tiers.map((t) => ({
        ...t,
        revFrom: Number(t.revFrom), revTo: t.revTo === null ? null : Number(t.revTo),
        recepMin: Number(t.recepMin), recepMax: Number(t.recepMax),
        seniorMin: Number(t.seniorMin), seniorMax: Number(t.seniorMax),
        girlMin: Number(t.girlMin), girlMax: Number(t.girlMax),
        pools: R.poolsOf(t),
      })),
      roles: roles.map((r) => ({ ...r, sharePct: Number(r.sharePct) })),
      gates: gates.map((g) => ({ ...g, rate: Number(g.rate), groupPct: g.groupPct === null ? null : Number(g.groupPct) })),
      rules, callCenter, notes,
    };
  });

  /** One scored month. Actuals come from the cache, so this and the sales report
   *  are reading the same invoices. */
  app.get('/api/commission/:year/:month', { preHandler: app.requireUser }, async (req, reply) => {
    const year = asYear(req.params.year, 0);
    const month = Number(req.params.month);
    if (!year || !Number.isInteger(month) || month < 1 || month > 12) {
      return reply.code(400).send({ error: 'Give a year and a month from 1 to 12.' });
    }
    const first = new Date(Date.UTC(year, month - 1, 1));
    const last = new Date(Date.UTC(year, month, 0));
    const rows = await prisma.invoice.groupBy({
      by: ['branchName'],
      where: { invoiceDate: { gte: first, lte: last } },
      _sum: { amountUntaxed: true },
      _count: true,
    });
    const actuals = rows.map((r) => ({
      name: r.branchName || 'Unassigned',
      ex: Number(r._sum.amountUntaxed || 0),
      invoices: r._count,
    }));
    /* How far into the month the cache actually reaches — not today's date, which
       would understate every branch whenever the sync is behind. */
    const newest = await prisma.invoice.aggregate({ _max: { invoiceDate: true }, where: { invoiceDate: { gte: first, lte: last } } });
    const dayNo = newest._max.invoiceDate ? new Date(newest._max.invoiceDate).getUTCDate() : 0;
    return Commission.monthView(year, month, actuals, { dayNo, daysInPeriod: last.getUTCDate() });
  });

  /* ---------- writes ---------- */

  /** Batch-save target cells. Each entry may carry a new target, new band
   *  overrides, or both; a band sent as null CLEARS the override and the cell
   *  goes back to following the policy. */
  app.put('/api/commission/targets', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const body = req.body || {};
    const year = asYear(body.year);
    const cells = Array.isArray(body.cells) ? body.cells : [];
    if (!cells.length) return reply.code(400).send({ error: 'No cells to save.' });
    if (cells.length > 600) return reply.code(400).send({ error: 'Too many cells in one save.' });

    const ids = new Set((await prisma.commissionBranch.findMany({ select: { id: true } })).map((b) => b.id));
    let updated = 0;
    try {
      const planned = cells.map((c) => {
        const branchId = Number(c.branchId);
        const month = Number(c.month);
        if (!ids.has(branchId)) throw new Error(`Branch ${branchId} does not exist.`);
        if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`Month ${c.month} is not 1-12.`);
        const data = {};
        if (c.target !== undefined) data.target = money(c.target, 'Target');
        if (c.floorPct !== undefined) data.floorPct = band(c.floorPct, 'Floor %');
        if (c.midPct !== undefined) data.midPct = band(c.midPct, 'Mid %');
        if (c.maxPct !== undefined) data.maxPct = band(c.maxPct, 'Max %');
        if (c.note !== undefined) data.note = c.note ? String(c.note).slice(0, 240) : null;
        if (!Object.keys(data).length) throw new Error('A cell was sent with nothing to change.');
        /* A floor above the mid, or a mid above the max, would silently make a
           band unreachable. Catch it here rather than let it pay the wrong pool. */
        const eff = { ...R.bandsFor({ floorPct: data.floorPct, midPct: data.midPct, maxPct: data.maxPct }, undefined) };
        if (data.floorPct !== undefined || data.midPct !== undefined || data.maxPct !== undefined) {
          if (!(eff.floor <= eff.mid && eff.mid <= eff.max)) {
            throw new Error(`Bands must rise: floor ${eff.floor} ≤ mid ${eff.mid} ≤ max ${eff.max}.`);
          }
        }
        return { branchId, month, data };
      });

      await prisma.$transaction(async (tx) => {
        for (const p of planned) {
          await tx.commissionTarget.upsert({
            where: { branchId_year_month: { branchId: p.branchId, year, month: p.month } },
            update: p.data,
            create: { branchId: p.branchId, year, month: p.month, target: p.data.target ?? '0.00', ...p.data },
          });
          updated++;
        }
      });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    await app.audit(req, 'commission-targets', `${year}: ${updated} cell${updated === 1 ? '' : 's'}`);
    return { ok: true, updated, grid: await Commission.targetGrid(year) };
  });

  /** Branches — rename, move area, change the owning entity, set the journal
   *  code, or retire one. Retiring sets active=false rather than deleting: a
   *  delete would cascade its whole target history away. */
  app.put('/api/commission/branches', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const rows = Array.isArray(req.body && req.body.branches) ? req.body.branches : [];
    if (!rows.length) return reply.code(400).send({ error: 'No branches to save.' });
    try {
      await prisma.$transaction(async (tx) => {
        for (const b of rows) {
          const data = {};
          if (b.name !== undefined) data.name = str(b.name, 'Branch name');
          if (b.area !== undefined) data.area = str(b.area, 'Area', 40);
          if (b.entity !== undefined) data.entity = str(b.entity, 'Owning entity', 40);
          if (b.journalCode !== undefined) data.journalCode = b.journalCode ? String(b.journalCode).trim().slice(0, 40) : null;
          if (b.annualTarget !== undefined) data.annualTarget = money(b.annualTarget, 'Annual target');
          if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder) || 0;
          if (b.active !== undefined) data.active = !!b.active;
          if (b.id) await tx.commissionBranch.update({ where: { id: Number(b.id) }, data });
          else {
            if (!data.name || !data.area || !data.entity) throw new Error('A new branch needs a name, an area and an owning entity.');
            await tx.commissionBranch.create({ data: { annualTarget: '0.00', ...data } });
          }
        }
      });
    } catch (e) {
      return reply.code(400).send({ error: /Unique constraint/.test(e.message) ? 'That branch name is already taken.' : e.message });
    }
    await app.audit(req, 'commission-branches', `${rows.length} row${rows.length === 1 ? '' : 's'}`);
    return { ok: true, grid: await Commission.targetGrid(asYear(req.body.year)) };
  });

  /** Departments (الأقسام) — label, multiplier, mix guardrails. */
  app.put('/api/commission/departments', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const rows = Array.isArray(req.body && req.body.departments) ? req.body.departments : [];
    if (!rows.length) return reply.code(400).send({ error: 'No departments to save.' });
    try {
      await prisma.$transaction(async (tx) => {
        for (const dp of rows) {
          const data = {};
          if (dp.label !== undefined) data.label = str(dp.label, 'Department name', 60);
          if (dp.multiplier !== undefined) {
            if (dp.multiplier === null || dp.multiplier === '') data.multiplier = null;
            else {
              const m = Number(dp.multiplier);
              if (!Number.isFinite(m) || m < 1 || m > 5) throw new Error('A multiplier must be between 1 and 5, or blank for no bonus.');
              data.multiplier = Number(m.toFixed(3));
            }
          }
          if (dp.mixFloor !== undefined) data.mixFloor = band(dp.mixFloor, 'Mix floor');
          if (dp.mixCap !== undefined) data.mixCap = band(dp.mixCap, 'Mix cap');
          if (dp.groupMix !== undefined) data.groupMix = band(dp.groupMix, 'Group mix');
          if (dp.sortOrder !== undefined) data.sortOrder = Number(dp.sortOrder) || 0;
          if (dp.active !== undefined) data.active = !!dp.active;
          if (data.mixFloor !== null && data.mixFloor !== undefined && data.mixCap !== null && data.mixCap !== undefined
            && data.mixFloor > data.mixCap) throw new Error('A mix floor cannot sit above its cap.');
          if (dp.id) await tx.commissionDepartment.update({ where: { id: Number(dp.id) }, data });
          else {
            const key = String(dp.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
            if (!key) throw new Error('A new department needs a key.');
            await tx.commissionDepartment.create({ data: { key, label: data.label || key, ...data } });
          }
        }
      });
    } catch (e) {
      return reply.code(400).send({ error: /Unique constraint/.test(e.message) ? 'That department key already exists.' : e.message });
    }
    await app.audit(req, 'commission-departments', `${rows.length} row${rows.length === 1 ? '' : 's'}`);
    return { ok: true, grid: await Commission.targetGrid(asYear(req.body.year)) };
  });

  /** The global policy knobs, including the 80/90/100 defaults every branch-month
   *  falls back to. */
  app.put('/api/commission/policy', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const rows = Array.isArray(req.body && req.body.settings) ? req.body.settings : [];
    if (!rows.length) return reply.code(400).send({ error: 'Nothing to save.' });
    const known = new Set((await prisma.commissionPolicy.findMany({ select: { key: true } })).map((r) => r.key));
    try {
      /* Check the three bands together, after applying the edit, so you cannot
         save a floor above the mid in two separate requests either. */
      const next = Object.fromEntries((await prisma.commissionPolicy.findMany()).map((r) => [r.key, r.value]));
      for (const s of rows) {
        if (!known.has(s.key)) throw new Error(`Unknown setting "${s.key}".`);
        next[s.key] = String(s.value ?? '');
      }
      const f = (k, dflt) => (next[k] === undefined || next[k] === '' ? dflt : Number(next[k]));
      const floor = f('achievement_floor', 0.8), mid = f('band_mid_from', 0.9), max = f('band_max_from', 1);
      if (![floor, mid, max].every((v) => Number.isFinite(v) && v >= 0 && v <= 2)) throw new Error('The bands must be shares between 0 and 2.');
      if (!(floor <= mid && mid <= max)) throw new Error(`Bands must rise: floor ${floor} ≤ mid ${mid} ≤ max ${max}.`);
      const cap = f('service_bonus_cap', 1.6);
      if (!Number.isFinite(cap) || cap < 1) throw new Error('The service bonus cap cannot be below 1.');
      const vat = f('vat_divisor', 1.14);
      if (!Number.isFinite(vat) || vat < 1 || vat > 2) throw new Error('The VAT divisor must be between 1 and 2.');

      await prisma.$transaction(async (tx) => {
        for (const s of rows) {
          await tx.commissionPolicy.update({ where: { key: s.key }, data: { value: String(s.value ?? '') } });
        }
      });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    await app.audit(req, 'commission-policy', rows.map((r) => r.key).join(', '));
    const policy = await Commission.loadPolicy();
    return { ok: true, policy: policy.rows, resolved: { bands: policy.bands, vatDivisor: policy.vatDivisor, multiplierCap: policy.multiplierCap } };
  });

  /* ================================================================
     Doctor commission schemes — a DIFFERENT commission from everything
     above, and they are kept apart on purpose.

       The grid above pays a BRANCH on net cash collected against a monthly
       target. These schemes pay a DOCTOR a share of what they invoiced, with
       no target and no bands per month.

     They share this file because a reader looking for "where is commission
     edited" should find one place, and they share nothing else — not a table,
     not a rule, not a number.
     ================================================================ */

  /** The eight schemes and the 73 people on them, in one trip. */
  app.get('/api/schemes', { preHandler: app.requireUser }, async () => {
    const [schemes, doctors] = await Promise.all([Schemes.all(), Schemes.assignments()]);
    /* The doctors Odoo knows about who are on NO scheme. This is the list that
       matters every month: a new doctor invoices from their first day and earns
       nothing until somebody puts them on a scheme, and nothing else in the app
       would say so. */
    const billed = await prisma.invoice.groupBy({
      by: ['specialistName'],
      where: { moveType: 'out_invoice', specialistName: { not: null } },
      _sum: { amountUntaxed: true },
      _max: { invoiceDate: true },
    });
    const have = new Set(doctors.map((d) => String(d.doctorName).trim().toLowerCase()));
    const unassigned = billed
      .filter((b) => !have.has(String(b.specialistName).trim().toLowerCase()))
      .map((b) => ({
        name: b.specialistName,
        ex: Math.round(Number(b._sum.amountUntaxed || 0)),
        lastInvoice: b._max.invoiceDate ? b._max.invoiceDate.toISOString().slice(0, 10) : null,
      }))
      .sort((a, b) => b.ex - a.ex);
    return { schemes, doctors, unassigned };
  });

  /**
   * Save a scheme — its bands, its hourly rate, its fixed basic.
   *
   * THE BANDS ARE VALIDATED AS A SET, not one at a time, because every way of
   * getting them wrong is a relationship between two of them: a band that
   * starts below the one before it, or two that overlap, pays a rate that
   * depends on which one the lookup happens to find first. The workbook's own
   * gap (Exclusive, 1,000,000-1,300,000) is ALLOWED through and reported,
   * because it is real and the report already refuses to guess inside it —
   * silently closing it here would invent a rate nobody agreed.
   */
  app.put('/api/schemes/:id', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const id = Number(req.params.id);
    const b = req.body || {};
    const data = {};
    try {
      if (b.name !== undefined) data.name = str(b.name, 'Scheme name', 60);
      if (b.notes !== undefined) data.notes = String(b.notes || '').slice(0, 1000) || null;
      if (b.hourlyRate !== undefined) data.hourlyRate = rate(b.hourlyRate, 'Hourly rate', 5000);
      if (b.fixedBasic !== undefined) data.fixedBasic = rate(b.fixedBasic, 'Fixed basic', 1e7);
      if (b.active !== undefined) data.active = !!b.active;
      if (b.bands !== undefined) data.bands = bands(b.bands);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    if (!Object.keys(data).length) return reply.code(400).send({ error: 'Nothing to save.' });

    const row = await prisma.commissionScheme.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'No such scheme.' });
    try {
      await prisma.commissionScheme.update({ where: { id }, data });
    } catch (e) {
      return reply.code(400).send({ error: /Unique constraint/.test(e.message) ? 'A scheme by that name already exists.' : e.message });
    }
    await app.audit(req, 'scheme', `${row.name}: ${Object.keys(data).join(', ')}`);
    return { ok: true, schemes: await Schemes.all() };
  });

  /** A new scheme. Starts with no bands, which the report reads as "no rate is
   *  assumed" rather than as zero — see `commission-schemes.js`. */
  app.post('/api/schemes', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const b = req.body || {};
    let data;
    try {
      data = {
        name: str(b.name, 'Scheme name', 60),
        bands: b.bands ? bands(b.bands) : [],
        hourlyRate: b.hourlyRate === undefined ? null : rate(b.hourlyRate, 'Hourly rate', 5000),
        fixedBasic: b.fixedBasic === undefined ? null : rate(b.fixedBasic, 'Fixed basic', 1e7),
        notes: String(b.notes || '').slice(0, 1000) || null,
        sortOrder: Number(b.sortOrder) || 99,
      };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    let made;
    try {
      made = await prisma.commissionScheme.create({ data });
    } catch (e) {
      return reply.code(400).send({ error: /Unique constraint/.test(e.message) ? 'A scheme by that name already exists.' : e.message });
    }
    await app.audit(req, 'scheme-new', made.name);
    return { ok: true, id: made.id, schemes: await Schemes.all() };
  });

  /**
   * Put a doctor on a scheme, or change what is theirs alone.
   *
   * `rateOverride` is the field to be careful with: it BEATS the band for that
   * person, every month, until somebody clears it. So it demands a reason in
   * the same request — eight people carry one today and each says why, and an
   * override with no reason is indistinguishable next August from a typo.
   */
  app.put('/api/doctor-schemes', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const rows = Array.isArray(req.body && req.body.doctors) ? req.body.doctors : [];
    if (!rows.length) return reply.code(400).send({ error: 'No doctors to save.' });
    try {
      await prisma.$transaction(async (tx) => {
        for (const d of rows) {
          const name = str(d.doctorName, 'Doctor name', 120);
          const data = {};
          if (d.schemeId !== undefined) {
            data.schemeId = d.schemeId === null || d.schemeId === '' ? null : Number(d.schemeId);
            if (data.schemeId !== null && !Number.isInteger(data.schemeId)) throw new Error(`${name}: that is not a scheme.`);
          }
          if (d.hourlyRate !== undefined) data.hourlyRate = rate(d.hourlyRate, `${name} hourly rate`, 5000);
          if (d.mgmtFee !== undefined) data.mgmtFee = rate(d.mgmtFee, `${name} management fee`, 1e7);
          if (d.taxRate !== undefined) data.taxRate = share(d.taxRate, `${name} withholding rate`);
          if (d.payMethod !== undefined) data.payMethod = String(d.payMethod || '').slice(0, 60) || null;
          if (d.bankAcc !== undefined) data.bankAcc = String(d.bankAcc || '').slice(0, 80) || null;
          if (d.bankName !== undefined) data.bankName = String(d.bankName || '').slice(0, 120) || null;
          if (d.active !== undefined) data.active = !!d.active;
          if (d.rateOverride !== undefined) {
            const r = share(d.rateOverride, `${name} rate override`);
            /* A rate that beats the scheme for one person, forever, with no
               note saying why, is a number nobody can check next year. */
            if (r !== null && !String(d.rateOverrideWhy || '').trim()) {
              throw new Error(`${name}: an agreed rate needs a reason written beside it.`);
            }
            data.rateOverride = r;
            data.rateOverrideWhy = r === null ? null : String(d.rateOverrideWhy).slice(0, 600);
          }
          await tx.doctorScheme.upsert({
            where: { doctorName: name },
            update: data,
            create: { doctorName: name, ...data },
          });
        }
      });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    await app.audit(req, 'doctor-schemes', `${rows.length} doctor${rows.length === 1 ? '' : 's'}`);
    return { ok: true, doctors: await Schemes.assignments() };
  });

  /** Mark one of the workbook's 17 open questions resolved, so the blocker count
   *  on the page reflects decisions actually taken. */
  app.put('/api/commission/notes/:id', { preHandler: requireWriter }, async (req, reply) => {
    if (guard(req, reply)) return reply;
    const id = Number(req.params.id);
    const resolved = !!(req.body && req.body.resolved);
    const note = await prisma.commissionNote.findUnique({ where: { id } });
    if (!note) return reply.code(404).send({ error: 'No such note.' });
    await prisma.commissionNote.update({
      where: { id },
      data: { resolved, resolution: req.body && req.body.resolution !== undefined ? String(req.body.resolution).slice(0, 600) : note.resolution },
    });
    await app.audit(req, 'commission-note', `${note.kind} ${note.ref} → ${resolved ? 'resolved' : 'reopened'}`);
    return { ok: true, notes: await Commission.loadNotes() };
  });
};
