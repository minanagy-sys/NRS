/* ============================================================
   The plan, year over year.

   Four years on twelve calendar positions, not forty-eight months on a
   timeline: the question is "is March always weak", and overlaying the years
   answers it where a continuous axis buries it.

   WHAT IS FROZEN AND WHAT IS LIVE IS MARKED, not blended. 2024 and 2025 come
   from the journal exports the plan was built on — the Odoo cache does not
   reach back that far and those figures will never update. 2026 is derived
   live. A chart that hides the seam is the chart that gets quoted.

   THE 2026 FORECAST IS DERIVED, NOT TYPED. The dashboard this is ported from
   carries three hardcoded figures for the last quarter of 2026. Copying them
   into this file would have made them true forever; the line here is the
   current run-rate carried forward, and it is labelled as a projection rather
   than drawn as though it had happened.

   Loaded as a plain <script> before the page's own, so `TgOv` is a global.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TgOv = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const C = (typeof module === 'object' && module.exports)
    ? require('./chartlet.js') : root.Chartlet;
  const { fmt, pc, esc } = F;

  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Which legend chips are switched off, by series index. Module state so a
     redraw after a toggle keeps the reader's choice. */
  const OFF = {};

  /** Monthly actual totals for one year, as twelve slots. */
  function actualYear(history, year) {
    const out = MN.map(() => null);
    let source = null;
    for (const r of history.rows) {
      const [y, m] = r.period.split('-').map(Number);
      if (y !== year) continue;
      out[m - 1] = r.total;
      source = r.source;
    }
    return { values: out, source };
  }

  /** Monthly plan totals for one year, summed across branches. */
  function targetYear(plan, year) {
    const out = MN.map(() => null);
    plan.months.forEach((k, mi) => {
      const [y, m] = k.split('-').map(Number);
      if (y !== year) return;
      let t = 0;
      let any = false;
      for (const row of plan.target) {
        if (row[mi] != null) { t += row[mi]; any = true; }
      }
      if (any) out[m - 1] = t;
    });
    return out;
  }

  /**
   * The run-rate projection for the rest of the current year.
   *
   * Built from the months that HAVE happened and stated as a projection. The
   * last month is excluded from the average when the range stops mid-month,
   * because a half-month of revenue read as a whole one drags the rate down and
   * makes the projection pessimistic in a way nobody notices.
   */
  function project(actual) {
    const done = actual.map((v, i) => [v, i]).filter(([v]) => v != null);
    if (done.length < 2) return { values: MN.map(() => null), from: null };
    const usable = done.slice(0, -1);
    const rate = usable.reduce((a, [v]) => a + v, 0) / usable.length;
    const lastIdx = done[done.length - 1][1];
    const out = MN.map(() => null);
    /* It starts AT the last actual month so the dashed line joins the solid one
       rather than floating away from it. */
    out[lastIdx] = actual[lastIdx];
    for (let i = lastIdx + 1; i < 12; i++) out[i] = Math.round(rate);
    return { values: out, from: MN[lastIdx], rate: Math.round(rate), months: usable.length };
  }

  function build(plan) {
    const H = plan.history;
    const P = plan.branches;
    const years = [...new Set(H.rows.map((r) => Number(r.period.slice(0, 4))))].sort();
    const planYears = [...new Set(P.months.map((k) => Number(k.slice(0, 4))))].sort();
    const thisYear = years[years.length - 1];
    const nextYear = planYears[planYears.length - 1];

    const series = [];
    for (const y of years) {
      const a = actualYear(H, y);
      series.push({
        name: `${y} actual`,
        values: a.values,
        frozen: a.source === 'frozen',
        colour: C.PALETTE[years.indexOf(y) % C.PALETTE.length],
      });
    }
    const cur = actualYear(H, thisYear);
    const proj = project(cur.values);
    if (proj.from) {
      series.push({
        name: `${thisYear} projected`, values: proj.values, dash: '5 4', colour: '#8a6e63', projection: proj,
      });
    }
    const tThis = targetYear(P, thisYear);
    if (tThis.some((v) => v != null)) {
      series.push({ name: `${thisYear} target`, values: tThis, marks: true, colour: '#b0503c' });
    }
    const tNext = targetYear(P, nextYear);
    if (nextYear !== thisYear && tNext.some((v) => v != null)) {
      series.push({ name: `${nextYear} plan`, values: tNext, colour: '#5e8d4a' });
      const floor = plan.policy && plan.policy.levels && plan.policy.levels.length
        ? plan.policy.levels[0].fromPct : 0.8;
      series.push({
        name: `${nextYear} at ${pc(floor, 0)}`,
        values: tNext.map((v) => (v == null ? null : Math.round(v * floor))),
        dash: '3 3',
        colour: '#C3A494',
      });
    }
    return { series, years, planYears, thisYear, nextYear, proj };
  }

  function html(plan) {
    if (!plan || !plan.branches || !plan.branches.months.length) {
      return `<section><div class="kicker">02 — Plan</div>
        <h2 class="title">No plan is stored</h2>
        <p class="sub">Import it with the targets workbook in <a href="/admin">Admin → Periods</a>,
        and this tab fills in.</p></section>`;
    }
    const B = build(plan);
    const shown = B.series.filter((_, i) => !OFF[i]);

    const yearTotal = (y) => {
      const r = plan.history.rows.filter((x) => x.period.startsWith(String(y)));
      return { total: r.reduce((a, x) => a + x.total, 0), months: r.length, frozen: r.some((x) => x.source === 'frozen') };
    };
    const planTotal = (y) => {
      const v = targetYear(plan.branches, y);
      return v.reduce((a, x) => a + (x || 0), 0);
    };

    let h = `<section>
      <div class="kicker">02 — Plan</div>
      <h2 class="title">${B.years[0]} to ${B.nextYear}, year over year</h2>
      <p class="sub">Four years laid over twelve calendar months, so a weak March shows as a weak
        March rather than disappearing into a long line. ${esc(plan.history.note)}</p>`;

    /* The KPI row: one card per year, actual or planned, each saying which. */
    h += '<div class="kpi-grid">';
    for (const y of B.years) {
      const t = yearTotal(y);
      h += `<div class="kpi"><div class="kpi-label">${y}${t.frozen ? ' · frozen' : ''}</div>
        <div class="kpi-value sm">${fmt(t.total)}</div>
        <div class="kpi-sub">${t.months} month${t.months === 1 ? '' : 's'} ·
          ${t.frozen ? 'from the journal exports' : 'derived from Odoo'}</div></div>`;
    }
    const np = planTotal(B.nextYear);
    if (np) {
      const prev = yearTotal(B.thisYear).total;
      h += `<div class="kpi accent"><div class="kpi-label">${B.nextYear} plan</div>
        <div class="kpi-value">${fmt(np)}</div>
        <div class="kpi-sub">${prev ? `${pc(np / prev - 1)} on ${B.thisYear} so far` : 'no prior year to compare'}</div></div>`;
    }
    h += '</div>';

    h += `<div class="chart-card"><div class="chartwrap">${C.lines({
      labels: MN, series: shown, title: `${B.years[0]}–${B.nextYear} by month`,
    })}</div>${C.legend(B.series.map((s, i) => ({ ...s, off: !!OFF[i] })), 'ov')}</div>`;

    if (B.proj && B.proj.from) {
      h += `<div class="tg-note"><strong>The dashed ${B.thisYear} line is a projection</strong>, not a
        figure: the average of the ${B.proj.months} complete month${B.proj.months === 1 ? '' : 's'} so far
        (${fmt(B.proj.rate)} a month) carried from ${esc(B.proj.from)} to December. It is derived here
        rather than typed, so it moves as the year does.</div>`;
    }

    /* THE NUMBERS BEHIND THE PICTURE. The chart has no crosshair tooltip — this
       is the replacement, and it shows every month of every series at once,
       which the tooltip never did. */
    h += `<h3 class="subtitle">The numbers behind it</h3>
      <div class="tw scrolly" style="--minw:${160 + B.series.length * 110}px;--h:460px">
      <table class="ltab tight sticky1"><thead><tr><th>Month</th>
        ${B.series.map((s) => `<th class="n">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>
      ${MN.map((lab, i) => `<tr><td class="nm">${lab}</td>
        ${B.series.map((s) => {
    const v = s.values[i];
    return `<td class="n">${v == null ? '<span class="sm2">—</span>' : fmt(v)}</td>`;
  }).join('')}</tr>`).join('')}
      </tbody><tfoot><tr><th>Year</th>
        ${B.series.map((s) => `<th class="n">${fmt(s.values.reduce((a, v) => a + (v || 0), 0))}</th>`).join('')}
      </tr></tfoot></table></div>`;

    return `${h}</section>`;
  }

  /** Legend toggles. Bound directly to the nodes, never delegated. */
  function wire(el, redraw) {
    if (!el || !el.querySelectorAll) return;
    C.wire(el, 'ov', OFF, redraw);
  }

  return { html, wire, build, project, OFF };
});
