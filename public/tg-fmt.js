/* ============================================================
   The Targets/Commission name for the shared helpers.

   This file used to define `$`, `fmt`, `pc` and `esc` itself — and its `pc`
   printed a missing rate as "0.0%". Since 2026-10-04 it is an alias of
   public/fmt.js, kept because a dozen tg-*, cm-* and admin-* modules and the
   tests `require('./tg-fmt.js')` or read `TgFmt`, and renaming every one of
   them buys nothing. There is no logic here to drift.

   In the browser it needs fmt.js loaded first; every view does that.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgFmt = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports) ? require('./fmt.js') : root.Fmt;
  const { $, fmt, pc, esc } = F;
  return { $, fmt, pc, esc };
});
