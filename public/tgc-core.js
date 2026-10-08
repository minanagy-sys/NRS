/* ============================================================
   Targets & Commission — the shared half.

   The store, the formatters and every piece of arithmetic more than one panel
   needs. Ported from the standalone dashboard, where the same functions sat in
   one 900-line inline script; the expressions are unchanged, because the two
   reports have to agree to the pound and the surest way to guarantee that is
   not to retype the maths.

   THE WEEKDAY WEIGHT IS THE IDEA THAT MATTERS. A Friday earns about 0.60 of a
   Tuesday. Spreading a monthly target evenly across elapsed days therefore
   overstates a week that has just had a Friday in it, and understates one that
   has not. Every pace, catch-up and forecast figure here divides by the weights
   rather than by the day count. The dashboard stored them Sunday-first under
   JavaScript's `getDay()`; the database stores them Monday-first, which is what
   the column says, so `wdw` converts and nothing else needs to know.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgcCore = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const F = (typeof module === 'object' && module.exports) ? require('./fmt.js') : root.Fmt;
  const $ = (id) => document.getElementById(id);

  /* ---- formatters, byte-for-byte the dashboard's ----
     en-US for numbers and en-GB for dates, deliberately: the figures are read
     as 1,234,567 and the days as "Monday 28 September 2026". */
  const fmt = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US'));
  const fm = (v) => {
    const a = Math.abs(v);
    return a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${Math.round(v / 1e3)}K` : `${Math.round(v)}`;
  };
  const pct = (v) => (isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : '—');
  const longDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const wkName = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' });
  const esc = F ? F.esc : (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const S = (a) => a.reduce((t, n) => t + (Number(n) || 0), 0);
  /** Names match on their letters only: "Dr.Merna Masoud" and "merna masoud". */
  const wn = (s) => String(s || '').toLowerCase().replace(/^dr\.?\s*/, '').replace(/[^a-z]/g, '');
  const iso = (d) => {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  };

  /* ---- the store ---- */
  const ST = {
    ref: null,       // /api/tgc/reference
    per: null,       // /api/tgc/period for the current range
    cm: null,        // /api/commission-month
    range: { from: '', to: '' },
    today: iso(new Date()),
    scope: { type: 'all', value: '' },
    /* Which achievement tier the figures are stated at. Shared by What's
       happening, Actuals and the Target plan, because a reader comparing them
       is comparing one tier across three views — three separate pickers would
       let them drift apart without anyone noticing. */
    tier: 100,
    page: 't',
    err: '',
  };

  async function api(url) {
    const r = await fetch(url, { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
    if (r.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
    const j = await r.json().catch(() => ({ error: `${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
    return j;
  }

  /* ---- weekday weights ----
     `wdw` takes a JavaScript getDay() (0 = Sunday) and reads the Monday-first
     row the database stores, which is the `(js+6)%7` shift the dashboard
     applied inline. */
  const wdw = (js) => {
    const w = (ST.ref && ST.ref.weekday) || {};
    const v = w[(js + 6) % 7];
    return v == null ? 1 : Number(v);
  };

  /** Total weekday weight across [a, b], inclusive. A single day is its own weight. */
  function wWeight(a, b) {
    let t = 0;
    for (let d = new Date(`${a}T12:00:00`); iso(d) <= b; d.setDate(d.getDate() + 1)) t += wdw(d.getDay());
    return t;
  }
  /** The whole of month "YYYY-MM". */
  function wMW(k) {
    const y = +k.slice(0, 4);
    const m = +k.slice(5) - 1;
    return wWeight(iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0)));
  }
  /** Month k clipped to [a, b]. */
  function wClip(k, a, b) {
    const y = +k.slice(0, 4);
    const m = +k.slice(5) - 1;
    let s = iso(new Date(y, m, 1));
    let e = iso(new Date(y, m + 1, 0));
    if (s < a) s = a;
    if (e > b) e = b;
    return [s, e];
  }
  /** Every month "YYYY-MM" the range touches. */
  function wMonths(a, b) {
    const out = [];
    let y = +a.slice(0, 4);
    let m = +a.slice(5, 7);
    const ey = +b.slice(0, 4);
    const em = +b.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  /**
   * A monthly target map scored across an arbitrary range, weighted by weekday.
   * Four days of a month is not 4/30 of its target if two of them were Fridays.
   */
  function wTarget(m, a, b) {
    return wMonths(a, b).reduce((t, k) => {
      const v = +m[k] || 0;
      if (!v) return t;
      const [s, e] = wClip(k, a, b);
      return t + (v * wWeight(s, e)) / wMW(k);
    }, 0);
  }
  /** The share of month k that [a, b] covers, by weight. */
  const gW = (k, a, b) => {
    const [s, e] = wClip(k, a, b);
    return wWeight(s, e) / wMW(k);
  };

  /* ---- the RAG bands ----
     Compared UNROUNDED, so a row at 99.975% displays 100% and still shows
     amber. The rounding is a display decision; the colour is not. */
  const AMBER = 0.85;
  const cls = (a) => (a == null || !isFinite(a) ? '' : a >= 1 ? 'g' : a >= AMBER ? 'a' : 'r');
  const pctb = (a, extra) => `<span class="pctb ${cls(a)}${extra || ''}">${a == null || !isFinite(a) ? '—' : `${(a * 100).toFixed(0)}%`}</span>`;

  /* ---- the plan ---- */
  const branchPlan = (name) => (ST.ref && ST.ref.branchPlan[name]) || {};
  const doctorPlan = (name) => (ST.ref && ST.ref.doctorPlan[name]) || {};
  const brandOf = (name) => {
    const b = (ST.ref && ST.ref.branches || []).find((x) => x.name === name);
    return b ? b.brand : 'Nouvelage';
  };
  const branchNames = () => (ST.ref ? ST.ref.branches.map((b) => b.name) : []);

  /**
   * A target for a range, with the running month's SHORTFALL CARRIED FORWARD.
   *
   * The even split keeps reporting a target a branch has already missed. Once
   * four days of a month are gone and only half the money arrived, the honest
   * number for the remaining days is not "the month ÷ days" — it is what is
   * actually left, spread across the weekday weight of the days that remain.
   *
   *   past      the finished days, at their plain weighted share
   *   remaining max(0, month target − billed so far), across the rest
   *
   * Applied ONLY to the month that is running, and only when the server sent
   * month-to-date figures for it. Closed months and future months keep the
   * plain weighted split, because there is nothing to redistribute.
   */
  function targetAdj(plan, a, b, doneByKey) {
    const cu = ST.per && ST.per.catchUp;
    return wMonths(a, b).reduce((t, k) => {
      const MT = +plan[k] || 0;
      if (!MT) return t;
      const [s, e] = wClip(k, a, b);

      const running = cu && cu.upto && k === cu.month && e >= ST.today;
      if (!running) return t + (MT * wWeight(s, e)) / wMW(k);

      const past = s < ST.today ? (wWeight(s, cu.upto) / wMW(k)) * MT : 0;
      const done = Number(doneByKey) || 0;
      const rem = Math.max(0, MT - done);
      const fs = s < ST.today ? ST.today : s;
      const w = wWeight(ST.today, monthEnd(k));
      return t + past + (w ? (rem * wWeight(fs, e)) / w : 0);
    }, 0);
  }

  /** A branch's target for the current range. */
  const bTarget = (name, a, b) => targetAdj(
    branchPlan(name), a || ST.range.from, b || ST.range.to,
    ((ST.per && ST.per.catchUp && ST.per.catchUp.byBranch) || {})[name],
  );
  /* Doctors have no month-to-date cut of their own yet, so they keep the plain
     weighted split rather than a redistribution built on a figure this page
     does not have. Stating that beats quietly using the wrong denominator. */
  const dTarget = (name, a, b) => wTarget(doctorPlan(name), a || ST.range.from, b || ST.range.to);

  /* ---- the roster ----
     A doctor's monthly target is divided by their ROSTERED HOURS, not by the
     days in the month: a 13-hour Saturday carries more target than a 6-hour
     Tuesday. Falls back to a flat per-day split when the roster says nothing,
     which is the dashboard's behaviour and the only honest one — a doctor with
     no shifts on file still has a target. */
  function monthHours(name, y, m) {
    const roster = (ST.ref && ST.ref.rosterByDoctor[name]) || {};
    const n = new Date(y, m + 1, 0).getDate();
    let h = 0;
    for (let i = 1; i <= n; i++) {
      (roster[new Date(y, m, i).getDay()] || []).forEach((x) => { h += Number(x.hours) || 0; });
    }
    return h;
  }
  function docDay(name, ds, hours) {
    const y = +ds.slice(0, 4);
    const m = +ds.slice(5, 7) - 1;
    const t = +doctorPlan(name)[ds.slice(0, 7)] || 0;
    const mh = monthHours(name, y, m);
    return mh ? (t * hours) / mh : t / new Date(y, m + 1, 0).getDate();
  }
  /** Who is on shift at a branch on a given date. */
  function onShift(branch, ds) {
    const dow = new Date(`${ds}T12:00:00`).getDay();
    const byBranch = (ST.ref && ST.ref.rosterByBranch[branch]) || {};
    return (byBranch[dow] || []).slice();
  }

  /* ---- the forecast ----
     Measured on FINISHED days only — the first of the month to yesterday —
     weighted by weekday, then scaled to the whole month. Today is excluded
     because a day in progress always reads as a collapse. */
  const monthStart = (k) => `${k}-01`;
  const monthEnd = (k) => iso(new Date(+k.slice(0, 4), +k.slice(5, 7), 0));
  const yesterday = () => {
    const d = new Date(`${ST.today}T12:00:00`);
    d.setDate(d.getDate() - 1);
    return iso(d);
  };
  function fcPace(done, k) {
    const s = monthStart(k);
    const y = yesterday();
    if (y < s) return null;           // the 1st: there is nothing finished yet
    const wd = wWeight(s, y);
    const wa = wMW(k);
    return wd ? (done * wa) / wd : null;
  }

  /* ---- scope ----
     All, an area manager's region, one branch, or one doctor. Narrowing the
     scope also narrows which tabs make sense, which the controller applies. */
  function scopeBranches() {
    const sc = ST.scope;
    if (sc.type === 'all') return null;
    if (sc.type === 'branch') return [sc.value];
    if (sc.type === 'area') {
      return (ST.ref.branches || []).filter((b) => b.area === sc.value).map((b) => b.name);
    }
    if (sc.type === 'doctor') {
      const d = (ST.ref.doctors || []).find((x) => wn(x.name) === wn(sc.value));
      return d ? d.branches : [];
    }
    return null;
  }
  const inScope = (branch) => {
    const list = scopeBranches();
    return !list || list.includes(branch);
  };
  const areas = () => [...new Set((ST.ref ? ST.ref.branches : []).map((b) => b.area).filter(Boolean))];

  /* ---- period rows, filtered by scope ---- */
  const rows = (which) => {
    const all = (ST.per && ST.per[which]) || [];
    if (which !== 'branches') return all;
    return all.filter((r) => inScope(r.branch));
  };
  const billedTotal = () => S(rows('branches').map((r) => r.ex));
  const collectedTotal = () => S(((ST.per && ST.per.collected) || [])
    .filter((r) => inScope(r.branch)).map((r) => r.net));

  return {
    ST, $, api, esc,
    fmt, fm, pct, longDate, wkName, S, wn, iso,
    wdw, wWeight, wMW, wClip, wMonths, wTarget, gW,
    cls, pctb, AMBER, targetAdj, tierOf: () => (ST.tier || 100) / 100,
    branchPlan, doctorPlan, brandOf, branchNames, bTarget, dTarget,
    monthHours, docDay, onShift,
    monthStart, monthEnd, yesterday, fcPace,
    scopeBranches, inScope, areas, rows, billedTotal, collectedTotal,
  };
});
