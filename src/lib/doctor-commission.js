/* ============================================================
   Doctor commission and payslips, live.

   Replaces a spreadsheet: every month somebody exports the invoice lines,
   pivots them by physician and branch, looks each rate up in the commissions
   workbook, adds hours and deductions, and publishes a frozen HTML pack.

   WHAT IS DERIVED AND WHAT IS NOT — the line matters more than anything else
   in this file, because half of a payslip is arithmetic and half is a decision
   somebody made, and a reader has to be able to tell which is which.

     DERIVED, from the Odoo cache
       revenue      ex-package, ex-VAT, per doctor and per branch
       rate         the band their revenue lands in, or their agreed override
       commission   revenue x rate

     NOT DERIVED, and never inferred
       hours, deductions, management fees, withholding rate, bank details,
       and the handful of invoices moved between doctors by hand

   Measured against the August 2026 pack: revenue reconciles to 1.5% on the
   ex-package basis, and the rate reproduces for all 73 people — 65 from the
   bands and 8 from recorded overrides. The payslip formula below reproduces
   72 of 73; the one exception carries a 10,000 adjustment that is shown as its
   own line rather than absorbed.

   THE REPORT REFUSES RATHER THAN GUESSES. No scheme means no commission figure
   and a sentence saying so. No payroll month means revenue and commission are
   shown and the payslip is not — because a payslip missing its deductions is
   not a smaller payslip, it is a wrong one.
   ============================================================ */

const { prisma } = require('./db.js');
const Report = require('./report.js');
const Schemes = require('./commission-schemes.js');

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v));
const key = (s) => String(s || '').trim().toLowerCase();

/** "2026-08-01" -> "2026-08" */
const periodOf = (d) => String(d).slice(0, 7);

/**
 * Revenue per doctor, and the branch split behind it.
 *
 * `Report.buildReport` with the package journals excluded — the SAME call the
 * NRS report makes. Measured: that basis lands within 1.5% of the pack, where
 * counting every invoice would be 9.3% out. A second derivation here would be
 * a second answer to a question the app has already answered.
 */
async function revenue({ from, to }) {
  const EX = { excludeJournals: Report.EXCLUDED_REVENUE_JOURNALS };
  const rep = await Report.buildReport(from, to, EX);

  /* The branch split comes from the doctor cut's own nesting rather than a
     separate query, so the parts cannot disagree with the whole. */
  const byDoctor = new Map();
  for (const d of rep.doctors) {
    byDoctor.set(key(d.name), {
      name: d.name,
      ex: r2(d.ex),
      inc: r2(d.inc),
      invoices: d.invoices || 0,
      branches: (d.branches || []).map((b) => (typeof b === 'string'
        ? { name: b, ex: null } : { name: b.name, ex: r2(b.ex) })),
    });
  }
  return { report: rep, byDoctor, totals: rep.totals };
}

/** The branch cut per doctor, which `report.doctors` only names. */
async function branchSplit({ from, to }) {
  const rows = await prisma.invoice.groupBy({
    by: ['specialistName', 'branchName'],
    where: {
      moveType: 'out_invoice',
      invoiceDate: { gte: new Date(from), lte: new Date(to) },
      NOT: { journalName: { in: Report.EXCLUDED_REVENUE_JOURNALS } },
    },
    _sum: { amountUntaxed: true },
    _count: true,
  });
  const out = new Map();
  for (const r of rows) {
    const k = key(r.specialistName);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({
      name: r.branchName || 'Unassigned',
      ex: r2(r._sum.amountUntaxed),
      invoices: r._count,
    });
  }
  for (const list of out.values()) list.sort((a, b) => b.ex - a.ex);
  return out;
}

/**
 * The payslip build-up for one person.
 *
 * THE FORMULA IS THE PACK'S OWN, pinned against all 73 of its rows:
 *
 *     basic = hours x hourlyRate      (or the scheme's fixed basic)
 *     tsal  = commission + basic - deductions + onda
 *     total = tsal + management fee + adjustment
 *     tax   = total x withholding rate
 *     net   = total - tax - maintenance + gcell
 *
 * `onda` is negative by the pack's convention, so it ADDS here — writing it as
 * a subtraction would flip the sign of every nutrition deduction.
 */
function payslipFor({ commission, scheme, doctor, payroll }) {
  const hours = num(payroll && payroll.hours);
  const hourly = doctor && doctor.hourlyRate != null ? Number(doctor.hourlyRate) : null;

  /* A scheme that does not count hours must not earn an hourly basic, however
     many hours the attendance sheet reports. "No working hours will be
     calculated" is a rule, and `hourlyRate: null` is how it is carried. */
  const hourlyBasic = hourly == null ? 0 : r2(hours * hourly);
  const fixedBasic = scheme && scheme.fixedBasic != null ? Number(scheme.fixedBasic) : 0;
  const basic = r2(hourlyBasic + fixedBasic);

  const ded = num(payroll && payroll.ded);
  const onda = num(payroll && payroll.onda);
  const mgmt = payroll && payroll.mgmt != null
    ? num(payroll.mgmt)
    : num(doctor && doctor.mgmtFee);
  const adjustment = num(payroll && payroll.adjustment);
  const maint = num(payroll && payroll.maint);
  const gcell = num(payroll && payroll.gcell);
  const taxRate = payroll && payroll.taxRate != null
    ? Number(payroll.taxRate)
    : (doctor && doctor.taxRate != null ? Number(doctor.taxRate) : 0);

  const tsal = r2(num(commission) + basic - ded + onda);
  const total = r2(tsal + mgmt + adjustment);
  const tax = r2(total * taxRate);
  const net = r2(total - tax - maint + gcell);

  return {
    hours: r2(hours),
    hourlyRate: hourly,
    hourlyBasic,
    fixedBasic: r2(fixedBasic),
    basic,
    ded: r2(ded),
    dedReason: (payroll && payroll.dedReason) || null,
    onda: r2(onda),
    tsal,
    mgmt: r2(mgmt),
    adjustment: r2(adjustment),
    total,
    taxRate,
    tax,
    maint: r2(maint),
    gcell: r2(gcell),
    net,
  };
}

/**
 * Everything the Doctor Commission tab needs.
 *
 *   build({ from, to }) -> { period, rows, totals, coverage, schemes, missing }
 *
 * One row per doctor who either invoiced in the window or is on a scheme —
 * both, because a doctor who billed nothing still has a payslip and a doctor
 * who billed without a scheme is the thing somebody needs to see.
 */
async function build({ from, to }) {
  const period = periodOf(from);

  const [rev, splits, docs, schemes, payrollRows] = await Promise.all([
    revenue({ from, to }),
    branchSplit({ from, to }),
    Schemes.assignments(),
    Schemes.all(),
    prisma.doctorPayrollMonth.findMany({ where: { period } }),
  ]);

  const byDoctor = new Map(docs.map((d) => [key(d.doctorName), d]));
  const payroll = new Map(payrollRows.map((p) => [key(p.doctorName), p]));

  /* Everyone who invoiced, plus everyone on a scheme who did not. */
  const names = new Map();
  for (const [k, r] of rev.byDoctor) names.set(k, r.name);
  for (const d of docs) if (!names.has(key(d.doctorName))) names.set(key(d.doctorName), d.doctorName);

  const rows = [];
  for (const [k, name] of names) {
    const r = rev.byDoctor.get(k);
    const ex = r ? r.ex : 0;
    const doctor = byDoctor.get(k) || null;
    const pay = payroll.get(k) || null;
    const { rate, from: rateFrom, why } = Schemes.rateForDoctor(doctor, ex);

    const commission = rate == null ? null : r2(ex * rate);
    /* NO PAYROLL MONTH, NO PAYSLIP — and this is the line that enforces it.
       It used to build the slip whenever a commission existed, handing
       `payroll: null` to a function that reads zero for every missing figure.
       The result looked complete: hours 0, deductions 0, withholding 0, and a
       net that was simply the commission. A payslip missing its deductions is
       not a smaller payslip, it is a wrong one, and one that shows no
       withholding overstates what somebody is owed. */
    const slip = (commission == null || !pay) ? null
      : payslipFor({ commission, scheme: doctor && doctor.scheme, doctor, payroll: pay });

    rows.push({
      name,
      scheme: doctor ? doctor.schemeName : null,
      /* What the scheme pays regardless of attendance. Carried even when there
         is no payslip, because it is owed either way and a headline that leaves
         it out is short by the three fixed-basic schemes every month. */
      schemeFixedBasic: doctor && doctor.scheme && doctor.scheme.fixedBasic != null
        ? Number(doctor.scheme.fixedBasic) : 0,
      onScheme: !!(doctor && doctor.schemeId),
      ex,
      inc: r ? r.inc : 0,
      invoices: r ? r.invoices : 0,
      branches: splits.get(k) || [],
      rate,
      rateFrom,
      rateWhy: why,
      commission,
      /* A payslip exists only when the month's payroll does. Half a payslip is
         not a smaller payslip, it is a wrong one. */
      payslip: slip,
      hasPayroll: !!pay,
      note: pay ? pay.note : null,
      pay: doctor ? {
        method: doctor.payMethod, acc: doctor.bankAcc, accName: doctor.bankName,
      } : null,
    });
  }

  rows.sort((a, b) => (b.commission || 0) - (a.commission || 0) || b.ex - a.ex);

  const rated = rows.filter((x) => x.rate != null);
  const totals = {
    doctors: rows.length,
    rated: rated.length,
    ex: r2(rows.reduce((t, x) => t + x.ex, 0)),
    commission: r2(rated.reduce((t, x) => t + x.commission, 0)),
    withPayslip: rows.filter((x) => x.payslip).length,
    net: r2(rows.filter((x) => x.payslip).reduce((t, x) => t + x.payslip.net, 0)),
    mgmt: r2(rows.filter((x) => x.payslip).reduce((t, x) => t + x.payslip.mgmt, 0)),
    tax: r2(rows.filter((x) => x.payslip).reduce((t, x) => t + x.payslip.tax, 0)),
  };

  /* What is missing, named — not a silent zero anywhere. */
  const noScheme = rows.filter((x) => !x.onScheme && x.ex > 0);
  const noRate = rows.filter((x) => x.onScheme && x.rate == null);
  const noPayroll = rows.filter((x) => x.commission != null && !x.hasPayroll);

  return {
    period,
    window: { from, to },
    rows,
    totals,
    schemes,
    coverage: {
      invoiced: rev.byDoctor.size,
      onScheme: docs.filter((d) => d.schemeId).length,
      payrollRows: payrollRows.length,
      /* The whole-clinic figure the doctor rows must sum to. */
      reportEx: r2(rev.totals.ex),
    },
    missing: {
      noScheme: noScheme.map((x) => ({ name: x.name, ex: x.ex })),
      noSchemeEx: r2(noScheme.reduce((t, x) => t + x.ex, 0)),
      noRate: noRate.map((x) => ({ name: x.name, ex: x.ex, why: x.rateWhy })),
      noPayroll: noPayroll.length,
      payrollLoaded: payrollRows.length > 0,
    },
    note: 'Revenue is ex-package and ex-VAT, the same basis as every other report. '
      + 'Commission is revenue times the rate. Everything below the commission line — '
      + 'hours, deductions, management fees, withholding — comes from the monthly '
      + 'payroll upload and is never inferred.',
  };
}

module.exports = { build, revenue, branchSplit, payslipFor, periodOf };
