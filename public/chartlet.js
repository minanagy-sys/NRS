/* ============================================================
   Charts, as inline SVG, in the house style.

   WHY NOT A CHART LIBRARY. `src/server.js` sets `scriptSrc: 'self'` and
   `connectSrc: 'self'`, so there is no CDN to load one from, and this project
   has deliberately carried no charting dependency: every report until now draws
   with CSS bars. The dashboard this is ported from loads Chart.js 4.4.1 from
   cdnjs, which simply would not execute here.

   THE CSP SHAPES THE MARKUP, not just the loading:

     · NO `<style>` ELEMENT inside the SVG. `styleSrc: 'self'` drops it and the
       chart renders unstyled — lines with no colour on a page that looks fine.
       So every colour, width and dash is a PRESENTATION ATTRIBUTE.
     · `style="…"` attributes are legal (`styleSrcAttr`) and used only where a
       length is genuinely computed.
     · EVERY ELEMENT IS SELF-CLOSED or explicitly closed. `balanced()` in
       test/render.test.js treats a short list of tags as void and nothing else,
       so an unclosed `<circle>` fails the suite — which makes the tag checker
       free structural validation of the chart.

   THE LEGEND IS HTML, NOT SVG. Real buttons: keyboard-reachable, screen-reader
   addressable, and clickable through the test harness. A canvas legend is none
   of those.

   WHAT A READER LOSES against Chart.js: the crosshair tooltip and animated
   transitions. Every chart here is drawn with a companion table underneath, so
   the figures are legible without hovering — which is more than the tooltip
   gave, since it only ever showed one month at a time.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Chartlet = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const F = (typeof module === 'object' && module.exports)
    ? require('./tg-fmt.js') : root.TgFmt;
  const { esc } = F;

  /* The brand palette, with hex fallbacks that are what the tests exercise:
     the harness has no `getComputedStyle`, so the fallback is the value that
     can silently drift from base.css and therefore the one worth pinning. */
  const cssVar = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch { return fallback; }
  };
  const PALETTE = [
    '#58382C', '#C3A494', '#9e6e4a', '#5e8d4a', '#c98a2e', '#b0503c',
    '#7a5142', '#8a6e63', '#4a6d8d', '#6d4a8d',
  ];

  /** Round axis tops: 0, 10M, 20M… rather than 0, 8.4M, 16.8M. */
  function niceTicks(max, n = 5) {
    if (!(max > 0)) return [0, 1];
    const raw = max / (n - 1);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const out = [];
    for (let v = 0; v <= max + step * 0.0001; v += step) out.push(v);
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
  }

  const shortMoney = (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${Math.round(v / 1e6)}M`;
    if (a >= 1e3) return `${Math.round(v / 1e3)}K`;
    return String(Math.round(v));
  };

  /**
   * A multi-series line chart.
   *
   * `series` is `[{ name, values:[…|null], colour?, dash?, marks? }]`. A null
   * BREAKS the line rather than being drawn as zero — a year with no figure yet
   * and a year of nothing are different claims, and joining across the gap
   * draws a segment that was never measured.
   */
  function lines({ labels = [], series = [], height = 300, width = 760, title = '' } = {}) {
    const L = 52;
    const R = 14;
    const T = 14;
    const B = 30;
    const w = width - L - R;
    const h = height - T - B;
    const vals = series.flatMap((s) => (s.values || []).filter((v) => v != null && Number.isFinite(v)));
    const max = vals.length ? Math.max(...vals) : 0;
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const x = (i) => L + (labels.length > 1 ? (i * w) / (labels.length - 1) : w / 2);
    const y = (v) => T + h - (v / top) * h;

    let g = '';
    for (const t of ticks) {
      g += `<line x1="${L}" y1="${y(t).toFixed(1)}" x2="${L + w}" y2="${y(t).toFixed(1)}" stroke="#E8DFD8" stroke-width="1" />`
        + `<text x="${L - 7}" y="${(y(t) + 3).toFixed(1)}" font-size="9" fill="#8A7A70" text-anchor="end">${esc(shortMoney(t))}</text>`;
    }
    labels.forEach((lab, i) => {
      g += `<text x="${x(i).toFixed(1)}" y="${height - 10}" font-size="9.5" fill="#8A7A70" text-anchor="middle">${esc(lab)}</text>`;
    });

    let body = '';
    series.forEach((s, si) => {
      const colour = s.colour || PALETTE[si % PALETTE.length];
      const vs = s.values || [];
      if (s.marks) {
        /* A series drawn as points, not a line — the plan's own targets sit on
           twelve months with nothing between them to interpolate. */
        vs.forEach((v, i) => {
          if (v == null || !Number.isFinite(v)) return;
          const cx = x(i);
          const cy = y(v);
          body += `<path d="M ${cx.toFixed(1)} ${(cy - 4).toFixed(1)} L ${(cx + 4).toFixed(1)} ${cy.toFixed(1)} `
            + `L ${cx.toFixed(1)} ${(cy + 4).toFixed(1)} L ${(cx - 4).toFixed(1)} ${cy.toFixed(1)} Z" `
            + `fill="${colour}" ><title>${esc(s.name)} ${esc(labels[i] || '')}</title></path>`;
        });
        return;
      }
      /* ONE POLYLINE PER UNBROKEN RUN. A single polyline over the whole series
         would draw straight through every gap. */
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          body += `<polyline fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"`
            + `${s.dash ? ` stroke-dasharray="${esc(s.dash)}"` : ''} points="${run.join(' ')}" >`
            + `<title>${esc(s.name)}</title></polyline>`;
        } else if (run.length === 1) {
          const [cx, cy] = run[0].split(',');
          body += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${colour}" ><title>${esc(s.name)}</title></circle>`;
        }
        run = [];
      };
      vs.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) { flush(); return; }
        run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      });
      flush();
    });

    return `<svg class="ck-svg" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMidYMid meet">`
      + `<title>${esc(title || 'Chart')}</title>${g}${body}</svg>`;
  }

  /**
   * A stacked column chart, with a deliberate ceiling on how many series it
   * will draw.
   *
   * THE SOURCE STACKS TWELVE BRANCHES IN FOURTEEN NEAR-IDENTICAL BROWNS, and
   * the result cannot be read: no reader can tell the seventh colour from the
   * ninth, and the legend is a wall. Reproducing that faithfully would be
   * reproducing a chart nobody can use. The largest `topN` are drawn in
   * separable colours and the rest collapse into one "Other" band whose tooltip
   * names them. The exact figures live in the table under the chart.
   */
  function stack({ labels = [], series = [], height = 300, width = 760, topN = 6, title = '' } = {}) {
    const ranked = series.slice().sort((a, b) => {
      const sa = (a.values || []).reduce((t, v) => t + (v || 0), 0);
      const sb = (b.values || []).reduce((t, v) => t + (v || 0), 0);
      return sb - sa;
    });
    const keep = ranked.slice(0, topN);
    const rest = ranked.slice(topN);
    const drawn = keep.slice();
    if (rest.length) {
      drawn.push({
        name: `Other (${rest.length} branch${rest.length === 1 ? '' : 'es'})`,
        colour: '#C3A494',
        detail: rest.map((r) => r.name).join(', '),
        values: labels.map((_, i) => rest.reduce((t, r) => t + ((r.values || [])[i] || 0), 0)),
      });
    }

    const L = 52;
    const R = 14;
    const T = 14;
    const B = 30;
    const w = width - L - R;
    const h = height - T - B;
    const totals = labels.map((_, i) => drawn.reduce((t, s) => t + ((s.values || [])[i] || 0), 0));
    const ticks = niceTicks(Math.max(0, ...totals));
    const top = ticks[ticks.length - 1] || 1;
    const band = labels.length ? w / labels.length : w;
    const bw = Math.max(4, Math.min(34, band * 0.62));

    let g = '';
    for (const t of ticks) {
      const ty = T + h - (t / top) * h;
      g += `<line x1="${L}" y1="${ty.toFixed(1)}" x2="${L + w}" y2="${ty.toFixed(1)}" stroke="#E8DFD8" stroke-width="1" />`
        + `<text x="${L - 7}" y="${(ty + 3).toFixed(1)}" font-size="9" fill="#8A7A70" text-anchor="end">${esc(shortMoney(t))}</text>`;
    }

    let body = '';
    labels.forEach((lab, i) => {
      const cx = L + band * i + band / 2;
      let acc = 0;
      drawn.forEach((s, si) => {
        const v = (s.values || [])[i] || 0;
        if (!v) return;
        const y0 = T + h - ((acc + v) / top) * h;
        const y1 = T + h - (acc / top) * h;
        acc += v;
        body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}"`
          + ` height="${Math.max(0, y1 - y0).toFixed(1)}" fill="${s.colour || PALETTE[si % PALETTE.length]}" >`
          + `<title>${esc(s.name)}${s.detail ? ` — ${esc(s.detail)}` : ''}: ${esc(shortMoney(v))}</title></rect>`;
      });
      /* Every other label, when they would otherwise collide. */
      if (labels.length <= 14 || i % 2 === 0) {
        g += `<text x="${cx.toFixed(1)}" y="${height - 10}" font-size="9" fill="#8A7A70" text-anchor="middle">${esc(lab)}</text>`;
      }
    });

    return {
      svg: `<svg class="ck-svg" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMidYMid meet">`
        + `<title>${esc(title || 'Chart')}</title>${g}${body}</svg>`,
      drawn,
    };
  }

  /**
   * The legend, as real buttons.
   *
   * `id` namespaces the `data-ck` attribute so two charts on one panel do not
   * toggle each other's series.
   */
  function legend(series, id) {
    return `<div class="tg-chips" id="${esc(id)}Legend">${series.map((s, i) => `<button
      class="tg-chip${s.off ? '' : ' on'}" data-ck="${esc(id)}:${i}"
      style="border-left:4px solid ${esc(s.colour || PALETTE[i % PALETTE.length])}"
      ${s.detail ? `title="${esc(s.detail)}"` : ''}>${esc(s.name)}</button>`).join('')}</div>`;
  }

  /** Toggle a series and redraw. Bound directly, never delegated. */
  function wire(el, id, state, redraw) {
    el.querySelectorAll(`[data-ck^="${id}:"]`).forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.ck.split(':')[1]);
        state[i] = !state[i];
        redraw();
      });
    });
  }

  return { lines, stack, legend, wire, niceTicks, shortMoney, PALETTE, cssVar };
});
