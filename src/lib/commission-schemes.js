/* ============================================================
   The eight commission schemes, and how a doctor's revenue turns into a rate.

   THEY ARE NOT VARIATIONS ON ONE RULE, and the workbook makes that plain:

     Standard        four bands, 10.5% → 15%, hourly 50
     Exclusive       four bands, 12% → 17%, hourly 60
     Randa & Poussy  four bands, 16% → 18%, 50,000 fixed, NO hours
     Mai Mohsen      flat 17%, no target at all, 100,000 basic, NO hours
     Team Mai        a nineteen-step target ladder
     Nutrition       15%, plus 50% on plans, less a 5% nurse deduction
     Skincare        a 50/50 split, NO hours
     Dr. Hossam      his own arrangement

   So the shape has to hold a band list AND a flat rate AND "hours are not
   counted here" without flattening them into one. A scheme that does not count
   hours carries `hourlyRate: null` — not zero, because zero is a rate somebody
   chose and null is a rule somebody wrote.

   HOW A BAND IS READ, and this is the part that is easy to get backwards. The
   workbook writes Standard as `0–200,000 → 10.5%` then `200,001–350,000 → 12%`.
   That is a LOOKUP, not a ladder: a doctor billing 300,000 earns 12% on the
   whole 300,000, not 10.5% on the first 200,000 and 12% on the rest. The
   payslip pack confirms it — every `com` in it is exactly `rev × rate` to the
   piastre, with one rate per person. Treating it as marginal would understate
   every doctor above the first band.
   ============================================================ */

const { prisma } = require('./db.js');

const num = (v) => (v == null ? null : Number(v));
const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

/**
 * The bands exactly as the workbook states them, used to seed the database
 * once and then never read again — Admin owns them after that.
 *
 * Kept in the code as well as the database for one reason: it is the only
 * written record of what the rates were on the day they were imported, and a
 * rate somebody edits in Admin should be diffable against where it started.
 */
const SEED = [
  {
    name: 'Standard',
    sortOrder: 1,
    hourlyRate: 50,
    bands: [
      { from: 0, to: 200000, rate: 0.105 },
      { from: 200001, to: 350000, rate: 0.12 },
      { from: 350001, to: 550000, rate: 0.14 },
      { from: 550001, to: null, rate: 0.15 },
    ],
    notes: '50% of visit revenue to the doctor until they reach 12% commission; '
      + 'after 12% no visits are counted.',
  },
  {
    name: 'Exclusive',
    sortOrder: 2,
    hourlyRate: 60,
    bands: [
      { from: 0, to: 350000, rate: 0.12 },
      { from: 350001, to: 550000, rate: 0.14 },
      { from: 550001, to: 1000000, rate: 0.15 },
      { from: 1300000, to: null, rate: 0.17 },
    ],
    /* THE WORKBOOK'S OWN GAP, carried rather than papered over: the third band
       ends at 1,000,000 and the fourth begins at 1,300,000. Revenue between the
       two matches no band. `rateFor` reports that as unrated instead of
       guessing which neighbour was meant. */
    notes: 'Ghada Amer, Nesma Saad and Merna Ashraf are listed at 60/hour. '
      + 'NOTE: the workbook leaves 1,000,000–1,300,000 with no band.',
  },
  {
    name: 'Randa & Poussy',
    sortOrder: 3,
    hourlyRate: null,
    fixedBasic: 50000,
    bands: [
      { from: 0, to: 700000, rate: 0.16 },
      { from: 700001, to: 1199000, rate: 0.165 },
      { from: 1200000, to: 1499000, rate: 0.17 },
      { from: 1500000, to: null, rate: 0.18 },
    ],
    notes: '50,000 per month per doctor. Licence fees included. No working hours counted.',
  },
  {
    name: 'Mai Mohsen',
    sortOrder: 4,
    hourlyRate: null,
    fixedBasic: 100000,
    bands: [{ from: 0, to: null, rate: 0.17 }],
    notes: '17% with no target limit. 100,000 basic. No working hours counted.',
  },
  {
    name: 'Team Mai',
    sortOrder: 5,
    hourlyRate: 50,
    bands: [
      { from: 0, to: 299999, rate: 0.05 },
      { from: 300000, to: 349999, rate: 0.06 },
      { from: 350000, to: 399999, rate: 0.07 },
      { from: 400000, to: 449999, rate: 0.08 },
      { from: 450000, to: 499999, rate: 0.09 },
      { from: 500000, to: null, rate: 0.10 },
    ],
    notes: 'Omnia, Menna, Esraa, Nouran and Dr Amal at 50/hour.',
  },
  {
    name: 'Nutrition',
    sortOrder: 6,
    hourlyRate: null,
    bands: [{ from: 0, to: null, rate: 0.15 }],
    notes: '15% on nutrition, 50% on nutrition plans. Nurse Onda deduction is 5% '
      + "of the doctor's commission. Nora Maged is 35% after consumables.",
  },
  {
    name: 'Skincare',
    sortOrder: 7,
    hourlyRate: null,
    bands: [{ from: 0, to: null, rate: 0.50 }],
    notes: '50/50 split. No working hours counted. Enas device maintenance and '
      + 'HIFU cartridges covered by the clinic.',
  },
  {
    name: 'Dr. Hossam Shehab',
    sortOrder: 8,
    hourlyRate: null,
    bands: [],
    notes: 'His own arrangement. No bands were stated in the workbook, so no rate '
      + 'is assumed — his commission has to be entered.',
  },
];

/** The monthly management fees, as the workbook lists them. */
const MGMT_FEES = [
  { doctorName: 'Ghada Amer', mgmtFee: 8000 },
  { doctorName: 'Marian Adel', mgmtFee: 5500 },
  { doctorName: 'Asmaa El Fawal', mgmtFee: 5000 },
  { doctorName: 'Hadeer Mohamed', mgmtFee: 6000 },
];

/**
 * The rate for one DOCTOR — their override if they have one, else their band.
 *
 * The override is checked first and deliberately: an agreed exception is not a
 * band that happens to be wrong, it is a different agreement, and letting the
 * band win would quietly re-rate the eight people who have one.
 */
function rateForDoctor(doctor, revenue) {
  if (!doctor) return { rate: null, band: null, from: null, why: 'No doctor record.' };
  if (doctor.rateOverride != null) {
    return {
      rate: Number(doctor.rateOverride),
      band: null,
      from: 'override',
      why: doctor.rateOverrideWhy || 'An agreed rate for this person, not the scheme band.',
    };
  }
  if (!doctor.scheme) {
    return { rate: null, band: null, from: null, why: `${doctor.doctorName} is on no scheme.` };
  }
  const hit = rateFor(doctor.scheme, revenue);
  return { ...hit, from: hit.rate == null ? null : 'band' };
}

/**
 * The rate for a revenue figure under one scheme.
 *
 *   rateFor(scheme, 300000) -> { rate: 0.12, band: {...} }
 *   rateFor(scheme, 1100000) -> { rate: null, why: '...' }
 *
 * A LOOKUP, NOT A LADDER — see the header. And it REFUSES rather than guessing:
 * revenue that falls in no band returns a null rate with the reason, because
 * Exclusive really does leave 1,000,000–1,300,000 undefined and a commission
 * invented to fill that hole is a payment nobody agreed.
 */
function rateFor(scheme, revenue) {
  const bands = Array.isArray(scheme && scheme.bands) ? scheme.bands : [];
  if (!bands.length) {
    return { rate: null, band: null, why: `${scheme ? scheme.name : 'No scheme'} states no bands.` };
  }
  const rev = Number(revenue || 0);
  const hit = bands.find((b) => rev >= Number(b.from)
    && (b.to == null || rev <= Number(b.to)));
  if (!hit) {
    /* Name the gap precisely. "No band" sends somebody to the workbook; "falls
       between 1,000,000 and 1,300,000" tells them which line to fix. */
    const below = bands.filter((b) => b.to != null && rev > Number(b.to)).pop();
    const above = bands.find((b) => rev < Number(b.from));
    return {
      rate: null,
      band: null,
      why: below && above
        ? `${scheme.name} has no band between ${Number(below.to).toLocaleString('en-US')} and ${Number(above.from).toLocaleString('en-US')} — ${rev.toLocaleString('en-US')} falls in the gap.`
        : `${rev.toLocaleString('en-US')} matches no band on ${scheme.name}.`,
    };
  }
  return { rate: Number(hit.rate), band: hit, why: null };
}

/** Every scheme, with its bands parsed and sorted. */
async function all() {
  const rows = await prisma.commissionScheme.findMany({ orderBy: { sortOrder: 'asc' } });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    bands: (Array.isArray(s.bands) ? s.bands : []).slice()
      .sort((a, b) => Number(a.from) - Number(b.from)),
    hourlyRate: num(s.hourlyRate),
    fixedBasic: num(s.fixedBasic),
    notes: s.notes,
    active: s.active,
    sortOrder: s.sortOrder,
  }));
}

/**
 * Doctor → scheme, with the per-person overrides already applied.
 *
 * `hourlyRate` falls back to the scheme's, `null` staying `null` all the way
 * down: a scheme that does not count hours must not inherit a rate from
 * anywhere, or "no working hours will be calculated" silently becomes 50/hour.
 */
async function assignments() {
  const [rows, schemes] = await Promise.all([
    prisma.doctorScheme.findMany({ orderBy: { doctorName: 'asc' } }),
    all(),
  ]);
  const byId = new Map(schemes.map((s) => [s.id, s]));
  return rows.map((d) => {
    const scheme = d.schemeId ? byId.get(d.schemeId) : null;
    return {
      doctorName: d.doctorName,
      schemeId: d.schemeId,
      schemeName: scheme ? scheme.name : null,
      scheme,
      hourlyRate: d.hourlyRate != null ? num(d.hourlyRate) : (scheme ? scheme.hourlyRate : null),
      hourlyFrom: d.hourlyRate != null ? 'doctor' : (scheme && scheme.hourlyRate != null ? 'scheme' : null),
      rateOverride: num(d.rateOverride),
      rateOverrideWhy: d.rateOverrideWhy,
      mgmtFee: num(d.mgmtFee),
      taxRate: num(d.taxRate),
      payMethod: d.payMethod,
      bankAcc: d.bankAcc,
      bankName: d.bankName,
      active: d.active,
    };
  });
}

/** Indexed by lower-cased name, which is how the revenue side arrives. */
async function index() {
  const rows = await assignments();
  return new Map(rows.map((d) => [String(d.doctorName).trim().toLowerCase(), d]));
}

module.exports = { SEED, MGMT_FEES, rateFor, rateForDoctor, all, assignments, index, r2 };
