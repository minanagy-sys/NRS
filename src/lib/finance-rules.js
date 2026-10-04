/* ============================================================
   The finance rules, in one place.

   Same idea as lib/rules.js does for the sales targets: the arithmetic that
   decides a verdict, a bucket or a match lives here once, so the page, the
   importer and the tests cannot disagree about it.

   Everything here was derived from the source report and then checked against
   all 625 of its expiry rows and all 57 of its product pairs — the constants are
   measured, not guessed, and the tests re-measure them.

   Deliberately recomputed rather than stored: days-to-expiry, cover, the verdict
   and the buckets all depend on *when you look*. Storing them would leave the
   report quietly asserting last month's answer.

   UMD-ish so the same source runs under require() and in a <script>.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinanceRules = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* A flat 30-day month. Checked against the source: 30 reproduces its at-risk
     figure on every row, while 30.4, 30.44 and 365/12 all miss. */
  const MONTH_DAYS = 30;

  /* Below this many net units issued in the window, the rate is a guess dressed
     as a number and the row is flagged so a human looks at it. */
  const THIN_MOVEMENT_UNITS = 3;

  /* A lot this close to fully unusable is called write-off rather than partial.
     Measured boundary in the source: all-waste at 0.9933 and 0.9903, the highest
     partial at 0.9875. */
  const ALL_WASTE_RATIO = 0.99;

  /* Zero issuance says nothing over a ten-day window, so it is only called waste
     when expiry is inside a year. Past that the row is parked, not counted. */
  const NO_MOVEMENT_HORIZON = 365;

  /* Reconciliation gaps below this are noise at this scale. */
  const LOOK_FIRST_EGP = 3000;

  /* A gap this large a share of what was sold is not a timing difference. */
  const NOT_ISSUED_SHARE = 0.4;

  /* ---------------------------------------------------------------- dates --- */

  /** Whole days from `asOf` to `expiry`. Negative means already expired. */
  function daysToExpiry(expiry, asOf) {
    const a = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
    const e = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
    return Math.round((e - a) / 86400000);
  }

  const BUCKETS = [
    { key: 'expired', label: 'Expired' },
    { key: 'd30', label: '≤ 30 days' },
    { key: 'd60', label: '31–60 days' },
    { key: 'd90', label: '61–90 days' },
    { key: 'd180', label: '91–180 days' },
    { key: 'safe', label: '> 180 days' },
  ];

  function bucketOf(daysLeft) {
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= 30) return 'd30';
    if (daysLeft <= 60) return 'd60';
    if (daysLeft <= 90) return 'd90';
    if (daysLeft <= 180) return 'd180';
    return 'safe';
  }

  /* -------------------------------------------------------------- verdicts --- */

  const VERDICTS = {
    expired: 'Expired',
    no_move: 'No movement — will expire',
    all_waste: 'Will not be used',
    part_waste: 'Partly at risk',
    safe: 'Will be consumed',
    wh_unknown: 'Warehouse — no rate',
    watch: 'No movement yet · expiry far off',
  };

  /**
   * Will this lot be used before it expires?
   *
   *   expiryVerdict({ qty, daysLeft, rate, isWarehouse })
   *     -> { verdict, atRiskQty, cover }
   *
   * `rate` is the monthly consumption rate at this location, or null where none
   * can be calculated. `cover` is months of runway, null when there is no rate.
   *
   * Order matters: an expired lot is expired whether or not it sits in a
   * warehouse — 12 of the source's 22 expired rows are warehouse rows.
   */
  function expiryVerdict({ qty, daysLeft, rate, isWarehouse }) {
    const q = Number(qty) || 0;
    const r = rate === null || rate === undefined ? null : Number(rate);
    const cover = r ? q / r : null;

    // Already gone. The whole lot is at risk and no forecast is needed.
    if (daysLeft < 0) return { verdict: 'expired', atRiskQty: q, cover };

    /* Warehouses issue to branches, not to patients, and those transfers are not
       posted in Odoo — so there is no denominator and no honest forecast. Say
       so rather than inventing a number. */
    if (isWarehouse || r === null) return { verdict: 'wh_unknown', atRiskQty: 0, cover: null };

    if (r === 0) {
      return daysLeft <= NO_MOVEMENT_HORIZON
        ? { verdict: 'no_move', atRiskQty: q, cover: null }
        : { verdict: 'watch', atRiskQty: 0, cover: null };
    }

    // Units that will still be on the shelf on the expiry date.
    const atRiskQty = Math.max(0, q - r * (daysLeft / MONTH_DAYS));
    if (atRiskQty <= 0) return { verdict: 'safe', atRiskQty: 0, cover };
    return {
      verdict: q > 0 && atRiskQty / q >= ALL_WASTE_RATIO ? 'all_waste' : 'part_waste',
      atRiskQty,
      cover,
    };
  }

  const isThinMovement = (netUnitsIssued) => Number(netUnitsIssued || 0) < THIN_MOVEMENT_UNITS;

  /** What to do about a lot, given its verdict. */
  function suggestedAction({ daysLeft, isWarehouse, verdict }) {
    if (daysLeft < 0) return 'Quarantine and write off — already expired';
    if (isWarehouse) return 'Push out to a branch that consumes it, now';
    if (verdict === 'no_move') return 'No issuance at this branch — transfer to a branch that uses it';
    return 'Transfer the surplus or promote the treatment';
  }

  /* --------------------------------------------------- funds availability --- */

  /* When the money is actually usable, which is a different question from which
     register took it. */
  const AVAILABILITY = [
    { key: 't0', label: 'Same-day — T+0', registers: ['Cash', 'InstaPay', 'Bank CIB'] },
    { key: 't1', label: 'Next-day — T+1', registers: ['Bank AAIB'] },
    { key: 'settlement', label: 'On settlement', registers: ['valu', 'Waffarha'] },
  ];

  /** null for a register nobody has classified — surfaced, never bucketed silently. */
  function availabilityOf(register) {
    const name = String(register || '').trim().toLowerCase();
    for (const g of AVAILABILITY) {
      if (g.registers.some((r) => r.toLowerCase() === name)) return g.key;
    }
    return null;
  }

  /* ---------------------------------------------- Odoo journal -> register ---

     The imported snapshot named six registers — Cash, Bank CIB, Bank AAIB, valu,
     Waffarha, InstaPay — and AVAILABILITY above is keyed on exactly those. Odoo
     names its journals per branch instead ("Cash-CFC", "Bank Arab African
     International", "Cash Madinty The Strip"), so a live sync has to fold ~20
     journals back onto those six or the availability split stops working.

     ORDER MATTERS and is the whole reason this is a list rather than an object:
     "Cash Waffarha" also starts with "Cash", so the Waffarha rule has to be
     tested first. Get that wrong and 16,100 EGP of settlement money is silently
     filed as same-day cash. */
  const REGISTER_RULES = [
    { re: /^cash\s*waffarha/i, register: 'Waffarha' },
    { re: /waffarha/i, register: 'Waffarha' },
    { re: /^bank\s+arab\s+african/i, register: 'Bank AAIB' },
    { re: /\bAAIB\b/i, register: 'Bank AAIB' },
    { re: /^bank\s+cib/i, register: 'Bank CIB' },
    { re: /\bCIB\b/i, register: 'Bank CIB' },
    { re: /insta\s*pay/i, register: 'InstaPay' },
    { re: /^valu\b/i, register: 'valu' },
    { re: /^cash\b/i, register: 'Cash' },
  ];

  /** The canonical register for an Odoo journal name, or null if no rule claims
   *  it. Null is deliberate: an unrecognised journal is reported and kept under
   *  its own name so the money still shows up, rather than being dropped or
   *  quietly folded into Cash. */
  function registerForJournal(journalName) {
    const name = String(journalName || '').trim();
    if (!name) return null;
    for (const r of REGISTER_RULES) if (r.re.test(name)) return r.register;
    return null;
  }

  /* ------------------------------------------------------ branch labels --- */

  /* Odoo's warehouse keys are not what anyone calls these places, and the source
     report shipped its own map for exactly that reason. Without it the same
     branch appears as "CFC" in one tab and "Cairo Festival City" in another,
     which reads as two branches.

     Config, not logic: if a branch is renamed or added this is the one place to
     change, and an unmapped name passes through untouched rather than vanishing. */
  const BRANCH_LABELS = {
    CFC: 'Cairo Festival City',
    'Madinity The Strip': 'Madinaty The Strip',
    Madinity: 'Madinaty',
    Roushdy: 'Roushdy (Alex)',
    Loran: 'Loran (Alex)',
    'Mall Of Arabia': 'Mall of Arabia',
    Mohandseen: 'Mohandessin',
    Zayed: 'Sheikh Zayed',
  };

  const branchLabel = (name) => BRANCH_LABELS[String(name || '').trim()] || name;

  /* --------------------------------------------- sold ↔ stock item matching --- */

  /**
   * Stock items are named `INV <product>`; their sellable twin carries the same
   * name without it. Strip the token, any `[bracket]` tag and the trailing
   * parenthetical description, then compare exactly.
   *
   * Never fuzzy: `Dr.Merna Masoud` and `Dr.Merna Ashraf` taught this codebase
   * once already that one edit apart can be two different things.
   */
  function normalizeItemName(s) {
    return String(s == null ? '' : s)
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\bINV\b/gi, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  const itemsMatch = (soldName, stockName) =>
    normalizeItemName(soldName) === normalizeItemName(stockName) && normalizeItemName(soldName) !== '';

  /* ------------------------------------------------------ the sold/issued gap --- */

  const GAP_CAUSES = {
    invoiced_not_issued: 'Invoiced without issuing stock — consumption understated',
    partial_issuance: 'Partial issuance — some units not deducted',
    issued_no_sale: 'Issued with no sale in window — wastage, sample, or package treatment',
  };

  /**
   * gap = units sold − units net issued.
   * Positive means invoiced but never taken off stock; negative means it left the
   * shelf with no matching sale.
   */
  function gapCause({ gap, soldQty }) {
    if (gap > 0) {
      return gap / Math.max(Number(soldQty) || 0, 1) > NOT_ISSUED_SHARE
        ? 'invoiced_not_issued' : 'partial_issuance';
    }
    return 'issued_no_sale';
  }

  const worthLookingAt = (gapAtCost) => Math.abs(Number(gapAtCost) || 0) >= LOOK_FIRST_EGP;

  /* ------------------------------------------------------------------ bonus --- */

  /* Free vendor units: a real quantity carrying no money. Checked against all
     2,545 lines of the source with zero exceptions — including two lines that
     carry a unit price but were discounted to nothing, and 90 zero-price lines
     that are NOT bonus because their quantity is zero too. */
  const isBonusLine = ({ qty, subtotal }) => Number(qty) > 0 && Number(subtotal) === 0;

  return {
    MONTH_DAYS, THIN_MOVEMENT_UNITS, ALL_WASTE_RATIO, NO_MOVEMENT_HORIZON,
    LOOK_FIRST_EGP, NOT_ISSUED_SHARE,
    daysToExpiry, BUCKETS, bucketOf,
    VERDICTS, expiryVerdict, isThinMovement, suggestedAction,
    AVAILABILITY, availabilityOf,
    REGISTER_RULES, registerForJournal,
    BRANCH_LABELS, branchLabel,
    normalizeItemName, itemsMatch,
    GAP_CAUSES, gapCause, worthLookingAt,
    isBonusLine,
  };
});
