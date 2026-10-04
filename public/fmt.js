/* ============================================================
   The four helpers every page uses — one copy.

   `$`, `fmt`, `pc` and `esc` used to be declared at the top of eleven page
   files, plus two shared modules (tg-fmt.js, cc-fmt.js), in copies that had
   already drifted apart by 2026-10-04:

     · TWO `pc`. Four pages printed a missing rate as "—"; Commercial,
       Commercial Sales, Patients and every Targets panel printed it as "0.0%".
       A missing figure and a zero are different answers, and the "0.0%" copy
       was telling readers a rate was zero when it did not exist.
     · TWO `esc`. Admin, NRS and Finance escaped apostrophes; the rest did not.
       Both are kept, under names that say which is which (see below).
     · `fmt('abc')` printed "NaN" on ten pages and "—" on Finance.

   One file means one behaviour, and the next change happens once.

   WHY `$` RESOLVES `document` WHEN CALLED, NOT WHEN LOADED: under the test
   harness this file is also `require`d by modules evaluated outside the vm
   sandbox, where there is no `document` at all. Pages evaluated inside the
   sandbox load it there, so `document` is the sandbox's.

   Loaded FIRST by every view, so `Fmt` is a global before anything needs it.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fmt = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const $ = (id) => document.getElementById(id);

  const missing = (v) => v === null || v === undefined || Number.isNaN(Number(v));

  /**
   * A number for reading. Missing renders as an em dash, never 0 — "we have
   * no figure" and "the figure is zero" are different claims.
   */
  const fmt = (n, d = 0) => (missing(n) ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

  /** A share as a percentage. `pc(0.8)` → "80.0%"; `pc(null)` → "—", not "0.0%". */
  const pc = (v, d = 1) => (missing(v) ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

  /**
   * Escape for HTML text and DOUBLE-quoted attributes.
   *
   * Apostrophes are left alone: every attribute in these pages is
   * double-quoted (checked on 2026-10-04 — not one single-quoted attribute
   * holds an interpolation), and a doctor called O'Brien should read that way.
   */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * Escape everything, apostrophes included (`&#39;`).
   *
   * The form NRS, Admin and Finance were written with. Kept rather than folded
   * into `esc` because their tests look for names exactly as these pages wrote
   * them, and a page that changes its own output to tidy up a helper is the
   * kind of change nobody asked for.
   */
  const escAll = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return { $, fmt, pc, esc, escAll };
});
