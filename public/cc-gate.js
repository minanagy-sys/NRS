/* ============================================================
   The Contact Centre lock screen.

   Shown when the server answers 423: last week's UCM export has not been
   uploaded, so the report is closed for everybody — the rule Mina set, and the
   one the source page enforced with its #gate modal.

   TWO MESSAGES, chosen by who is looking. Somebody who can upload is told
   exactly which week to export and sent to Admin → Uploads. Everybody else is
   told nobody has uploaded it yet and that the page opens by itself once they
   do — the source page's own Arabic, kept word for word, because it is the
   sentence the team already knows.

   There is no "skip". The source let the page's owner skip for themselves;
   Mina asked for nobody to see it until the file is in.

   NOTHING BEHIND IT. The server sent no figures, so there is nothing under this
   card for anybody to uncover from the console.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcGate = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./cc-fmt.js') : root.CcFmt;
  const { esc, fmt } = F;

  /* "Sun 27 Sep", the way the source page printed a week. */
  const nice = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });

  function html(L) {
    const g = (L && L.gate) || {};
    const w = g.week || {};
    const canUpload = !!(L && L.canUpload);

    /* A SHORT upload is a different instruction from a missing one. */
    let state = '';
    if (g.reason === 'short' && g.held) {
      state = `<div class="cc-lock-note">An export for this week is in, but its last call is
        ${esc(nice(g.held.last))} — it needs to reach at least ${esc(nice(g.needsUntil))}.
        ${fmt(g.held.calls)} calls are held for the week. Export the whole week again and
        upload it; it replaces what is there.</div>`;
    }

    const action = canUpload
      ? `<a class="cc-lock-btn" href="/admin#uploads">Upload it in Admin → Uploads</a>
         <div class="cc-lock-hint">From the phone system: UCM → CDR → Export, for
           ${esc(nice(w.from))} → ${esc(nice(w.to))}. CSV or Excel.</div>`
      : `<div class="cc-lock-ar" dir="rtl" lang="ar">لسه محدش رفع ملف الأسبوع ده. الصفحة هتفتح أول ما الأدمن يرفعه.</div>`;

    return `<div class="cc-lock" role="dialog" aria-modal="true" aria-labelledby="ccLockTitle">
      <div class="cc-lock-card">
        <div class="cc-lock-eyebrow">Nouvelage · Contact Centre · UCM</div>
        <h2 id="ccLockTitle">Upload last week's UCM</h2>
        <div class="cc-lock-ar" dir="rtl" lang="ar">الصفحة دي بتفتح بعد ما ملف UCM بتاع الأسبوع اللي فات يترفع. الملف بيترفع كل يوم حد الصبح.</div>
        <div class="cc-lock-week">${esc(nice(w.from))} → ${esc(nice(w.to))}</div>
        ${state}
        ${action}
        <div class="cc-lock-foot">The report locks every Sunday until the previous week is uploaded,
          then stays open until the next Sunday${g.locksAgain ? ` (${esc(nice(g.locksAgain))})` : ''}.</div>
      </div>
    </div>`;
  }

  function render(el, L) { if (el) el.innerHTML = html(L); }

  return { html, render, nice };
});
