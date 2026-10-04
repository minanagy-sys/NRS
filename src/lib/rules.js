/* ============================================================
   The target-sheet rules, in one place.

   These are the pieces that were wrong or duplicated before: date formatting,
   the colour bands, the derived daily target, and name resolution. Keeping them
   here means the page, the tests and (later) any server-side rendering all read
   the same definitions instead of their own copies.

   UMD-ish so the same source runs under require() and inlined in a <script>.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* Format from LOCAL components. toISOString() converts to UTC, so local
     midnight in Cairo (UTC+3) becomes 21:00 the previous day — which made every
     date preset fetch one day early. */
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /* Colour bands, reproduced from the original report: green at or above the
     expected figure, amber down to 85% of it, red below. `actual` and `expected`
     must be raw — the original has a row displaying 100% in amber because it is
     really 99.975%, and rounding before comparing loses that. */
  const AMBER_FLOOR = 0.85;
  const toneOf = (actual, expected) => {
    if (!expected) return 'r';
    const ratio = actual / expected;
    return ratio >= 1 ? 'g' : ratio >= AMBER_FLOOR ? 'a' : 'r';
  };

  /** Derived, never stored — a 30-day month must not need a re-import. */
  const dailyTarget = (monthly, days) => Math.round((monthly || 0) / (days || 31));

  /* The sheet and Odoo spell some names differently ("Dr Dina Ghoneim" on the
     sheet, "DR. Dina Ghonem" in Odoo). Resolution is explicit: normalise obvious
     noise, then consult the alias map. No fuzzy matching — a near-miss guess can
     attribute revenue to the wrong doctor silently, and "Dr.Merna Masoud" and
     "Dr.Merna Ashraf" are one edit apart but different people. */
  /* Any punctuation becomes a space, so "Al-Kabbash" and "Al Kabbash" — or
     "DR.Reem" and "DR. Reem" — land on the same key. That is typographic noise,
     not ambiguity: it cannot merge two different people the way a fuzzy
     distance can, because the letters still have to agree. */
  const normName = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/gi, ' ')
    .replace(/^\s*(dr|doctor|prof|mr|mrs|ms)\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /* Odoo can hold more than one record for the same person — "Dr. Mai mohsen"
     with 887,717 alongside "Mai mohsen" with 987 — which is why the target sheet
     carries a hand-written "merged 2 records" note. Keeping one and discarding
     the rest silently deleted a doctor's entire month, so duplicates are summed. */
  function mergeRows(rows) {
    const out = { ...rows[0] };
    for (const r of rows.slice(1)) {
      for (const k of ['ex', 'inc', 'qty', 'invoices', 'lines']) {
        if (typeof r[k] === 'number') out[k] = (out[k] || 0) + r[k];
      }
      if (Array.isArray(r.branches)) out.branches = [...new Set([...(out.branches || []), ...r.branches])];
    }
    // Round the sums back, since ex/inc arrive already rounded to cents.
    for (const k of ['ex', 'inc', 'qty']) {
      if (typeof out[k] === 'number') out[k] = Math.round(out[k] * 100) / 100;
    }
    out.mergedFrom = rows.length > 1 ? rows.map((r) => r.name) : undefined;
    return out;
  }

  /** Index rows by normalised name; resolve sheet names through the aliases. */
  function matcher(rows, aliases) {
    const grouped = new Map();
    for (const r of rows) {
      const k = normName(r.name);
      (grouped.get(k) || grouped.set(k, []).get(k)).push(r);
    }
    const byName = new Map();
    for (const [k, list] of grouped) byName.set(k, mergeRows(list));
    return (sheetName) => {
      const direct = byName.get(normName(sheetName));
      if (direct) return { row: direct, via: null };
      const alias = aliases && aliases[sheetName];
      if (alias) {
        const row = byName.get(normName(alias));
        if (row) return { row, via: alias };
      }
      return { row: null, via: null };
    };
  }

  return { iso, toneOf, dailyTarget, normName, matcher, AMBER_FLOOR };
});
