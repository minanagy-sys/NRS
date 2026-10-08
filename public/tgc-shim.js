/* ============================================================
   What the dashboard script expects to find already there.

   `public/tgc-dash.js` is lines 454–1366 of the standalone dashboard, copied
   without a character changed. That was the point: every earlier attempt at
   this page RE-IMPLEMENTED each panel, and each one came out a little
   different — a hundred small differences is a different page.

   Running the original unchanged means supplying the four things it reaches
   for, and nothing else:

     D, TGT              the two constants it opens with, rebuilt from Postgres
     claude.use('mcp')   its Odoo reads, answered from the invoice cache
     claude.use('db')    where it keeps the target sheet and the policy
     claude.use('downloads')   saving a file

   THE PAGE STILL NEVER TALKS TO THE MCP. `callTool` below posts to this app,
   which answers in SQL. Only the SHAPE is Odoo's, because that is what the
   script destructures.

   Chart.js and SheetJS are the one real compromise. The original loads both
   from a CDN; the CSP here forbids that and neither can be fetched offline, so
   they get thin stand-ins over the app's own SVG charts and server-side
   workbook writer. Eight call sites, listed at each one.
   ============================================================ */
(function () {
  'use strict';

  const WITH = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };

  async function api(url, body) {
    const res = await fetch(url, body
      ? { method: 'POST', headers: WITH, body: JSON.stringify(body) }
      : { headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
    if (res.status === 401) { location.href = '/auth/login'; throw new Error('signed out'); }
    const out = await res.json().catch(() => ({ error: `${res.status}` }));
    if (!res.ok || out.error) throw new Error(out.error || `${res.status}`);
    return out;
  }

  /* ---- claude.use('mcp') ----
     One method, `callTool`, with the signature the script calls it by. The
     `cache` option it passes is honoured: the same query inside its stale
     window is answered from memory rather than re-asked, which is what keeps a
     date change from firing twenty-seven requests. */
  const CACHE = new Map();

  const mcp = {
    async callTool(server, tool, params, opts) {
      const key = JSON.stringify(params);
      const ttl = (opts && opts.cache && opts.cache.staleTime) || 0;
      const hit = CACHE.get(key);
      if (hit && ttl && Date.now() - hit.at < ttl) return hit.value;
      const value = await api('/api/tgc/odoo', params);
      CACHE.set(key, { at: Date.now(), value });
      return value;
    },
  };

  /* ---- claude.use('db') ----
     The script keeps two documents here: `targets/current` and `policy/current`.
     Reads come from the app's own endpoints; a WRITE is deliberately refused.

     Refused rather than silently dropped, because saving a target or a policy
     is a publish: it has to reconcile, it has to be audited, and it needs the
     passphrase. Admin does all three. A write that appeared to succeed here and
     changed nothing would be the worst of the options. */
  const db = {
    async get(doc) {
      if (doc === 'targets/current') {
        const b = await api('/api/tgc/bootstrap');
        return { branches: b.TGT.branches, doctors: b.TGT.doctors, updated: null };
      }
      if (doc === 'policy/current') {
        const ref = await api('/api/tgc/reference');
        return { policy: ref.policy, updated: ref.policy.version || null };
      }
      return null;
    },
    async set() {
      throw new Error('Saving here is disabled. Targets and the policy are published in Admin, '
        + 'where the sheet has to reconcile, the change is audited and the passphrase is required.');
    },
  };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
      /* The script asks for .xlsx; what this produces is CSV, because the
         workbook writer here is server-side and takes a different shape.
         Renaming it is the honest half: a file that opens as a spreadsheet but
         claims to be xlsx is the kind of thing that wastes somebody's morning. */
      const named = blob.type.startsWith('text/csv')
        ? String(filename || 'download').replace(/\.xlsx?$/i, '.csv')
        : filename;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = named || filename || 'download';
      a.click();
      URL.revokeObjectURL(a.href);
      return { ok: true };
    },
  };

  window.claude = window.claude || {};
  window.claude.use = async (what) => {
    if (what === 'mcp') return mcp;
    if (what === 'db') return db;
    if (what === 'downloads') return downloads;
    return null;
  };

  /* ============================================================
     Chart.js, drawn as SVG.

     The CSP forbids the CDN the original loads, so this draws the same two
     charts from the SAME config object. Delegating to the app's generic
     chartlet was the first attempt and it came out wrong: chartlet picks its
     own palette, has no dashes, no point markers and no curve, while this
     config specifies all four per dataset — `borderColor`, `borderDash`,
     `pointRadius`, `tension`, and a `showLine:false` series drawn as diamonds
     only. Reading the config is the only way the chart matches.
     ============================================================ */

  /** Catmull-Rom through the points, as Chart.js's `tension` does. */
  function curve(pts, tension) {
    if (pts.length < 2) return '';
    if (!tension) return `M${pts.map((p) => `${p[0]},${p[1]}`).join('L')}`;
    const t = tension * 0.5;
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      d += `C${(p1[0] + (p2[0] - p0[0]) * t).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) * t).toFixed(1)}`
        + ` ${(p2[0] - (p3[0] - p1[0]) * t).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) * t).toFixed(1)}`
        + ` ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  /** A diamond for `pointStyle:'rectRot'`, a circle otherwise. */
  function marker(x, y, r, style, colour) {
    if (!r) return '';
    if (style === 'rectRot') {
      return `<polygon points="${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}" fill="${colour}"/>`;
    }
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${colour}"/>`;
  }

  const cssVar = (n, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || fallback;
  };

  function lineChart(cfg, width, height) {
    const data = cfg.data || {};
    const labels = data.labels || [];
    const sets = (data.datasets || []).filter((d) => !d.hidden);
    const L = 54;
    const R = 16;
    const T = 16;
    const B = 34;
    const w = width - L - R;
    const h = height - T - B;

    const vals = sets.flatMap((d) => (d.data || []).filter((v) => v != null && isFinite(v)));
    if (!vals.length) return '';
    const hi = Math.max(...vals);
    const lo = Math.min(0, Math.min(...vals));
    /* Round the top to a whole 5M so the axis reads 5M, 10M, … as the original
       does, rather than to whatever the maximum happens to be. */
    const step = hi > 2e6 ? 5e6 : hi > 2e5 ? 5e5 : 5e4;
    const top = Math.ceil(hi / step) * step;
    const bottom = lo < 0 ? Math.floor(lo / step) * step : 0;
    const x = (i) => L + (labels.length > 1 ? (i * w) / (labels.length - 1) : w / 2);
    const y = (v) => T + h - ((v - bottom) / (top - bottom || 1)) * h;

    const grid = cssVar('--line', 'rgba(88,56,44,.14)');
    const tx = cssVar('--muted', '#8a6e63');

    let g = '';
    for (let v = bottom; v <= top + 1; v += step) {
      g += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${L + w}" y2="${y(v).toFixed(1)}" stroke="${grid}" stroke-width="1"/>`
        + `<text x="${L - 8}" y="${(y(v) + 3.5).toFixed(1)}" font-size="10" fill="${tx}" text-anchor="end">${v / 1e6}M</text>`;
    }
    labels.forEach((lab, i) => {
      g += `<text x="${x(i).toFixed(1)}" y="${(T + h + 18).toFixed(1)}" font-size="10.5" fill="${tx}" text-anchor="middle">${String(lab)}</text>`;
    });

    let body = '';
    for (const d of sets) {
      const colour = d.borderColor || '#58382C';
      const rad = d.pointRadius == null ? 2 : d.pointRadius;
      /* A null breaks the line rather than joining across it — the 2026 series
         stops in August on purpose, and a line carried to December would claim
         figures that do not exist. */
      const runs = [];
      let run = [];
      (d.data || []).forEach((v, i) => {
        if (v == null || !isFinite(v)) { if (run.length) runs.push(run); run = []; return; }
        run.push([x(i), y(v)]);
      });
      if (run.length) runs.push(run);

      if (d.showLine !== false) {
        const dash = d.borderDash && d.borderDash.length ? ` stroke-dasharray="${d.borderDash.join(',')}"` : '';
        for (const r of runs) {
          body += `<path d="${curve(r, d.tension || 0)}" fill="none" stroke="${colour}"`
            + ` stroke-width="${d.borderWidth == null ? 2 : d.borderWidth}"${dash}`
            + ' stroke-linecap="round" stroke-linejoin="round"/>';
        }
      }
      for (const r of runs) for (const p of r) body += marker(p[0].toFixed(1), p[1].toFixed(1), rad, d.pointStyle, colour);
    }

    const legend = `<div class="ck-leg">${sets.map((d) => `<span class="ck-leg-i">
      <i style="background:${d.borderColor || '#58382C'}${d.borderDash && d.borderDash.length ? ';opacity:.65' : ''}"></i>${
      String(d.label || '')}</span>`).join('')}</div>`;

    /* `interaction:{mode:'index'}` in the config means hovering anywhere over a
       month reads out EVERY series at that month, not just the line under the
       cursor. The geometry needed to do that is here and nowhere else, so it is
       handed back with the markup rather than recomputed later. */
    const hover = {
      xs: labels.map((_, i) => x(i)),
      labels,
      rows: sets.map((d) => ({
        label: String(d.label || ''),
        colour: d.borderColor || '#58382C',
        data: (d.data || []).map((v) => (v == null || !isFinite(v) ? null : Number(v))),
      })),
      plot: { L, T, w, h },
    };

    return { html: legend + `<svg viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMidYMid meet">${g}${body}
      <line class="ck-cross" x1="0" y1="${T}" x2="0" y2="${T + h}" stroke="currentColor" stroke-width="1" opacity="0"/></svg>`, hover, width, height };
  }

  /** The stacked bar on Branch targets, from the same config. */
  function barChart(cfg, width, height) {
    const data = cfg.data || {};
    const labels = data.labels || [];
    const sets = (data.datasets || []).filter((d) => !d.hidden);
    const L = 54;
    const R = 16;
    const T = 16;
    const B = 38;
    const w = width - L - R;
    const h = height - T - B;
    const totals = labels.map((_, i) => sets.reduce((t, d) => t + (Number((d.data || [])[i]) || 0), 0));
    const hi = Math.max(...totals, 0);
    if (!hi) return '';
    const step = hi > 2e6 ? 5e6 : 5e5;
    const top = Math.ceil(hi / step) * step;
    const y = (v) => T + h - (v / top) * h;
    const bw = Math.max(4, (w / Math.max(labels.length, 1)) * 0.62);
    const grid = cssVar('--line', 'rgba(88,56,44,.14)');
    const tx = cssVar('--muted', '#8a6e63');

    let g = '';
    for (let v = 0; v <= top + 1; v += step) {
      g += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${L + w}" y2="${y(v).toFixed(1)}" stroke="${grid}" stroke-width="1"/>`
        + `<text x="${L - 8}" y="${(y(v) + 3.5).toFixed(1)}" font-size="10" fill="${tx}" text-anchor="end">${v / 1e6}M</text>`;
    }
    let body = '';
    const centres = [];
    labels.forEach((lab, i) => {
      const cx = L + ((i + 0.5) * w) / Math.max(labels.length, 1);
      centres.push(cx);
      let acc = 0;
      for (const d of sets) {
        const v = Number((d.data || [])[i]) || 0;
        if (v <= 0) continue;
        const y0 = y(acc + v);
        const y1 = y(acc);
        body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}"`
          + ` height="${Math.max(0, y1 - y0).toFixed(1)}" fill="${d.backgroundColor || d.borderColor || '#58382C'}"/>`;
        acc += v;
      }
      g += `<text x="${cx.toFixed(1)}" y="${(T + h + 20).toFixed(1)}" font-size="9.5" fill="${tx}" text-anchor="middle">${String(lab)}</text>`;
    });

    const legend = `<div class="ck-leg">${sets.map((d) => `<span class="ck-leg-i">
      <i style="background:${d.backgroundColor || d.borderColor || '#58382C'}"></i>${String(d.label || '')}</span>`).join('')}</div>`;

    /* The config asks for the key at the BOTTOM on this chart — twelve branch
       names above a stacked bar would push the bars off the card. */
    const atBottom = (((cfg.options || {}).plugins || {}).legend || {}).position === 'bottom';

    /* Every colour gets a figure, which is the whole point of a stack: the
       question is "what made up that month", and a tooltip naming one branch
       answers a question nobody asked. Chart.js defaults a bar to `nearest`,
       so this is a deliberate departure from the default — and the one the
       chart is for. */
    const hover = {
      xs: centres,
      labels,
      total: true,
      rows: sets.map((d) => ({
        label: String(d.label || ''),
        colour: d.backgroundColor || d.borderColor || '#58382C',
        data: (d.data || []).map((v) => (Number(v) || 0)),
      })),
      plot: { L, T, w, h },
    };

    const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMidYMid meet">${g}${body}
      <line class="ck-cross" x1="0" y1="${T}" x2="0" y2="${T + h}" stroke="currentColor" stroke-width="1" opacity="0"/></svg>`;
    return { html: atBottom ? svg + legend : legend + svg, hover, width, height };
  }

  function Chart(target, config) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return { destroy() {} };

    /**
     * THE CANVAS HAS TO SURVIVE.
     *
     * The script finds its chart by `$('trend')` on every redraw. Writing the
     * SVG into the canvas's parent replaced the canvas along with everything
     * else, so the first render worked and every one after was a silent no-op —
     * which is how the Overview became an empty box.
     */
    const canvas = el.tagName === 'CANVAS' ? el : null;
    const parent = canvas ? canvas.parentElement : el;
    if (!parent) return { destroy() {} };
    let holder = parent.querySelector(':scope > .ck-holder');
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'ck-holder';
      parent.appendChild(holder);
    }
    if (canvas) canvas.style.display = 'none';

    const height = parent.clientHeight > 80 ? parent.clientHeight : 320;
    const draw = (config || {}).type === 'bar' ? barChart : lineChart;
    const out = draw(config || {}, 1100, height);
    if (typeof out === 'string') {
      holder.innerHTML = out;
    } else {
      holder.innerHTML = out.html;
      wireHover(holder, out, config);
    }
    return { destroy() { holder.innerHTML = ''; }, update() {} };
  }

  /**
   * The read-out on hover.
   *
   * Chart.js is asked for `mode:'index', intersect:false`, which means pointing
   * anywhere in a month reports every series for that month — not only the line
   * the cursor happens to touch. That is the useful behaviour on a chart with
   * seven overlapping lines, so it is what this does.
   *
   * The figures are formatted the way the original's tooltip callback formats
   * them: `label: 1,234,567`. A series with no value that month is left out
   * rather than shown as zero — 2026 genuinely stops in August.
   */
  function wireHover(holder, drawn, config) {
    const svg = holder.querySelector('svg');
    if (!svg || !drawn.hover || !drawn.hover.xs.length) return;
    const tip = document.createElement('div');
    tip.className = 'ck-tip';
    tip.hidden = true;
    holder.appendChild(tip);
    const cross = svg.querySelector('.ck-cross');
    const { xs, labels, rows, plot } = drawn.hover;
    const money = (v) => Math.round(v).toLocaleString('en-US');

    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      /* The SVG is scaled to the holder, so a client pixel is not a viewBox
         unit. Everything below is in viewBox units. */
      const vx = ((ev.clientX - box.left) / box.width) * drawn.width;
      const vy = ((ev.clientY - box.top) / box.height) * drawn.height;
      if (vy < plot.T - 8 || vy > plot.T + plot.h + 8) { hide(); return; }

      let best = 0;
      for (let i = 1; i < xs.length; i += 1) {
        if (Math.abs(xs[i] - vx) < Math.abs(xs[best] - vx)) best = i;
      }
      /* A branch with nothing that month is left out rather than listed at 0 —
         Golden Square does not start until April 2027, and a row of zeros for
         it every month is noise in a twelve-row tooltip. */
      const present = rows.filter((r) => r.data[best] != null && r.data[best] !== 0);
      if (!present.length) { hide(); return; }

      cross.setAttribute('x1', xs[best]);
      cross.setAttribute('x2', xs[best]);
      cross.setAttribute('opacity', '.28');
      tip.hidden = false;
      const total = drawn.hover.total
        ? `<div class="ck-tip-r ck-tip-t"><i style="background:transparent"></i>
           <span>Total</span><b>${money(present.reduce((t, r) => t + r.data[best], 0))}</b></div>`
        : '';
      tip.innerHTML = `<div class="ck-tip-h">${String(labels[best])}</div>${
        present.map((r) => `<div class="ck-tip-r"><i style="background:${r.colour}"></i>
          <span>${r.label}</span><b>${money(r.data[best])}</b></div>`).join('')}${total}`;

      /* Keep it inside the card: flip to the left of the cursor once it would
         run off the right edge. */
      const px = (xs[best] / drawn.width) * box.width;
      const flip = px > box.width - tip.offsetWidth - 24;
      tip.style.left = `${Math.max(4, flip ? px - tip.offsetWidth - 14 : px + 14)}px`;
      tip.style.top = `${Math.max(4, ((ev.clientY - box.top)) - 12)}px`;
    };
    const hide = () => { tip.hidden = true; if (cross) cross.setAttribute('opacity', '0'); };

    svg.addEventListener('mousemove', move);
    svg.addEventListener('mouseleave', hide);
    /* Touch gets the same read-out; a tap is a hover on a phone. */
    svg.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    svg.addEventListener('touchend', hide);
  }

  Chart.defaults = { font: {}, plugins: {}, color: '' };
  window.Chart = window.Chart || Chart;

  /* ---- SheetJS, as far as six calls need ----
     Reading a workbook goes to the server, which already parses xlsx for the
     Admin importer. Writing one produces a CSV per sheet: the app's real
     workbook writer is server-side and takes a different shape, and a CSV that
     opens is better than a .xlsx that needs repairing. The filename says which
     it is, so nobody is misled about what they downloaded. */
  /**
   * SheetJS, as far as this script uses it — and it uses more than it looks.
   *
   * `buildWorkbook()` does not hand over rows: it builds a real cell grid,
   * addresses cells by name (`ws['C4']`), and writes `SUM()` FORMULAS into the
   * total columns. A shim that only knew `table_to_sheet` threw, and the
   * handler reported "Could not save the file" — correctly, but without saying
   * which part was missing.
   *
   * So: `aoa_to_sheet`, `encode_col` and `encode_range` are real, and `write`
   * serialises the grid. The output is CSV rather than xlsx, because the app's
   * own workbook writer is server-side and takes a different shape — and the
   * FORMULAS ARE EVALUATED here, because a CSV carrying the text "SUM(C2:N2)"
   * in its total column is worse than no total at all.
   *
   * The filename says .csv. Nobody should open a download expecting one format
   * and find another.
   */
  const colName = (i) => {
    let n = i;
    let s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };
  const colIndex = (name) => [...name].reduce((t, ch) => t * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

  const XLSX = {
    utils: {
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      book_append_sheet(wb, ws, name) {
        wb.SheetNames.push(name);
        wb.Sheets[name] = ws;
      },
      encode_col: colName,
      encode_range: (r) => `${colName(r.s.c)}${r.s.r + 1}:${colName(r.e.c)}${r.e.r + 1}`,
      /** Array-of-arrays to an addressed sheet, as SheetJS does it. */
      aoa_to_sheet(aoa) {
        const ws = {};
        let maxC = 0;
        aoa.forEach((row, r) => {
          (row || []).forEach((v, c) => {
            if (v === null || v === undefined || v === '') return;
            ws[`${colName(c)}${r + 1}`] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
            if (c > maxC) maxC = c;
          });
        });
        ws['!ref'] = `A1:${colName(maxC)}${aoa.length || 1}`;
        return ws;
      },
      table_to_sheet(table) {
        const rows = [...table.querySelectorAll('tr')]
          .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
        return XLSX.utils.aoa_to_sheet(rows);
      },
      sheet_to_json(ws, opts) {
        const rows = sheetRows(ws);
        if (opts && opts.header === 1) return rows;
        const [head, ...rest] = rows;
        return rest.map((r) => Object.fromEntries((head || []).map((h, i) => [h, r[i]])));
      },
    },
    /** Reading a workbook is the server's job — it already parses xlsx for Admin. */
    read() {
      const pending = window.__tgcPendingWorkbook;
      if (pending && pending.SheetNames) return pending;
      return { SheetNames: [], Sheets: {} };
    },
    write(wb) {
      const parts = wb.SheetNames.map((n) => {
        const rows = sheetRows(wb.Sheets[n], true);
        return `# ${n}\n${rows.map((r) => r.map(csvCell).join(',')).join('\n')}`;
      });
      return new Blob([parts.join('\n\n')], { type: 'text/csv;charset=utf-8' });
    },
  };

  const csvCell = (c) => {
    const t = String(c == null ? '' : c);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };

  /** An addressed sheet back to rows, optionally evaluating SUM() formulas. */
  function sheetRows(ws, evaluate) {
    if (!ws) return [];
    let maxR = 0;
    let maxC = 0;
    for (const k of Object.keys(ws)) {
      if (k.startsWith('!')) continue;
      const m = k.match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      maxC = Math.max(maxC, colIndex(m[1]));
      maxR = Math.max(maxR, Number(m[2]));
    }
    const value = (addr) => {
      const cell = ws[addr];
      if (!cell) return '';
      if (cell.f && evaluate) return sumFormula(ws, cell.f);
      return cell.v == null ? '' : cell.v;
    };
    const out = [];
    for (let r = 1; r <= maxR; r += 1) {
      const row = [];
      for (let c = 0; c <= maxC; c += 1) row.push(value(`${colName(c)}${r}`));
      out.push(row);
    }
    return out;
  }

  /**
   * Evaluate `SUM(C2:N2)`.
   *
   * The totals in the target workbook are formulas, and Excel would compute
   * them. A CSV cannot, so a column reading "SUM(C2:N2)" would be the one
   * column a reader actually checks and the one that says nothing. Only SUM
   * over a single rectangular range appears in this workbook; anything else
   * returns blank rather than a wrong number.
   */
  function sumFormula(ws, f) {
    const m = String(f).match(/^SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/i);
    if (!m) return '';
    const [, c1, r1, c2, r2] = m;
    let total = 0;
    for (let c = colIndex(c1); c <= colIndex(c2); c += 1) {
      for (let r = Number(r1); r <= Number(r2); r += 1) {
        const cell = ws[`${colName(c)}${r}`];
        if (cell && cell.t === 'n' && typeof cell.v === 'number') total += cell.v;
      }
    }
    return total;
  }

  window.XLSX = window.XLSX || XLSX;

  /* ---- "Sync now" has to mean something different here ----
     In the dashboard this came from, the page read Odoo directly, so its Sync
     button simply re-asked Odoo — `wLoad()`, nothing more. Here the figures
     live in Postgres and the page reads THAT, so re-asking the cache returns
     precisely what is already on screen: the button appeared to do nothing,
     because it genuinely did nothing.

     So the click is intercepted. The server pulls Odoo into the cache for the
     range on screen FIRST; only then does the script's own handler run, and by
     then there is something new for it to find. The in-memory answer cache is
     dropped at the same time, or the script would be handed the figures it was
     given before the pull.

     Capture phase, and the original handler is left in place: this adds a step
     in front of the dashboard's behaviour rather than replacing it. */
  function wireSync() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('#gSyncNow');
      if (!btn || btn.dataset.pulling) return;

      e.preventDefault();
      e.stopPropagation();
      btn.dataset.pulling = '1';
      const status = document.getElementById('gSync');
      const dot = document.getElementById('gDot');
      const said = status && status.textContent;
      const from = (document.getElementById('gFrom') || {}).value;
      const to = (document.getElementById('gTo') || {}).value;
      if (status) status.textContent = 'pulling from Odoo…';

      try {
        const res = await fetch('/api/refresh', {
          method: 'POST', headers: WITH, body: JSON.stringify({ from, to }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.error) {
          /* The endpoint words its failures by layer — an expired sign-in reads
             differently from Odoo being down — so its sentence is shown rather
             than a generic one. */
          if (dot) dot.className = 'dot off';
          if (status) status.textContent = out.error || `sync failed (${res.status})`;
          return;
        }
        /* Invoices alone leave the whole commission half at zero, because
           branch pools are paid on CASH. An empty `Collection` reads exactly
           like "nobody earned anything", so the cash is pulled in the same
           click rather than left for somebody to remember. */
        let cash = null;
        if (status) status.textContent = 'pulling collections…';
        try {
          const res2 = await fetch('/api/tgc/sync-collections', {
            method: 'POST', headers: WITH, body: JSON.stringify({ from, to }),
          });
          const out2 = await res2.json().catch(() => ({}));
          cash = (res2.ok && !out2.error) ? out2 : { error: out2.error || `${res2.status}` };
        } catch (err2) {
          cash = { error: err2.message };
        }

        CACHE.clear();
        if (status) {
          const inv = out.invoices == null ? null : `${Number(out.invoices).toLocaleString()} invoices`;
          const money = cash && cash.error
            ? 'collections failed'
            : (cash && cash.rowsWritten != null ? `${Number(cash.rowsWritten).toLocaleString()} collection rows` : null);
          const bits = [inv, money].filter(Boolean);
          status.textContent = bits.length ? `synced · ${bits.join(' · ')}` : 'synced just now';
        }
      } catch (err) {
        if (dot) dot.className = 'dot off';
        if (status) status.textContent = `sync failed: ${err.message}`;
        return;
      } finally {
        delete btn.dataset.pulling;
      }

      /* Now let the dashboard do what it always did. */
      if (typeof btn.onclick === 'function') btn.onclick(e);
      else if (status && said) status.textContent = said;
    }, true);
  }

  /* ---- the two constants, then the script ----
     `D` and `TGT` have to be global before tgc-dash.js runs, because it reads
     them at the top level. The script tag for it is added only once they are
     here; loading it with `defer` in the markup would race. */
  (async function boot() {
    try {
      const b = await api('/api/tgc/bootstrap');
      window.D = b.D;
      window.TGT = b.TGT;
    } catch (e) {
      const bar = document.getElementById('gSum') || document.body;
      bar.textContent = `Could not load the plan: ${e.message}`;
      return;
    }
    const s = document.createElement('script');
    s.src = '/assets/tgc-dash.js';
    s.onload = () => {
      wireSync();
      /* FILTER GROUPS BELONG TO A PANEL, AND ONLY A TAB CLICK SORTS THEM OUT.
         `gSyncPage()` hides every group whose `data-for` is not the open panel,
         and the script only wires it to tab clicks — so on first paint the
         Target plan's Show, Doctors grouped, Tier and Branch sit under What's
         happening, which has just one filter of its own. Clicking the tab fixed
         it, which is why it looked like clicking BROKE it. Run it once here. */
      if (typeof window.gSyncPage === 'function') window.gSyncPage();
      else {
        const act = (document.querySelector('.panel.active') || {}).id;
        document.querySelectorAll('#prow .fgrp').forEach((g) => {
          g.hidden = g.dataset.for !== act;
        });
      }
    };
    document.body.appendChild(s);
  })();
})();
