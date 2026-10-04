/* ============================================================
   Reading the Finance Suite HTML.

   The report is a single self-contained file holding four sections in three
   different shapes: two of them are `window.__X__ = {...}` blobs, one is a
   `const DATA = {...}` blob, and the collections section has no JavaScript at
   all — every figure is baked into `<tr><td>` markup. So this module does two
   different jobs: slice JSON out by brace-matching, and parse the collections
   tables out of the HTML.

   Kept separate from the import script so the parsing can be tested on its own.
   ============================================================ */

/** Pull a balanced `{...}` literal out of the source, starting at `marker`. */
function sliceObject(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`Could not find "${marker}" in the file.`);
  const start = src.indexOf('{', at + marker.length - 1);
  if (start < 0) throw new Error(`"${marker}" is not followed by an object.`);

  // Brace-count, but skip anything inside a string — product names contain braces
  // and quotes, and a naive scan would stop in the wrong place.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error(`"${marker}" has an unbalanced object.`);
}

/** "1,205,365" -> 1205365 · "—" -> 0 · "− 18,970 refund" -> 18970 */
function money(text) {
  const t = String(text == null ? '' : text).replace(/,/g, '').trim();
  if (!t || /^[—–-]$/.test(t)) return 0;
  const m = /\d+(\.\d+)?/.exec(t);
  return m ? Number(m[0]) : 0;
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '');

/**
 * One collections cell. The plain number is the net figure; the marker spans
 * carry the package share (`◆`, a share OF the net, not an addition to it) and
 * any refund already deducted from it.
 */
function readCell(td) {
  const pkg = /class="pkl"[^>]*>([^<]*)</.exec(td);
  const refund = /class="rfl"[^>]*>([^<]*)</.exec(td);
  const bare = String(td).replace(/<span[\s\S]*?<\/span>/g, '');
  return {
    net: money(stripTags(bare)),
    packageShare: pkg ? money(pkg[1]) : 0,
    refunds: refund ? money(refund[1]) : 0,
  };
}

const tableRows = (chunk) => {
  const body = chunk.slice(chunk.indexOf('<tbody>'), chunk.indexOf('</tbody>'));
  return body.split('<tr').slice(1)
    .map((tr) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]));
};

/**
 * Read the collections section.
 *
 *   readCollections(html, year, month) -> { days, rows, registers, published }
 *
 * `rows` is one entry per day × branch × register. `days` is the published
 * company daily summary, which is the only place the transaction count exists.
 * `published` holds the header figures, used to refuse an import that does not
 * reproduce them.
 */
function readCollections(html, year = 2026, month = 8) {
  const from = html.indexOf('id="view-col"');
  const to = html.indexOf('id="view-ap"');
  if (from < 0 || to < 0) throw new Error('The collections section is not in this file.');
  const section = html.slice(from, to);

  const dateOf = (text) => {
    const m = /(\d+)/.exec(stripTags(text));
    return m ? `${year}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null;
  };

  /* ---- the company daily summary: Day | Gross | Refunds | Net | ◆ | Txns ---- */
  const sumAt = section.indexOf('Company Daily Summary');
  const summary = section.slice(sumAt, section.indexOf('</table>', sumAt));
  const days = [];
  for (const tds of tableRows(summary)) {
    const date = dateOf(tds[0] || '');
    if (!date || tds.length < 6) continue;
    days.push({
      date,
      gross: money(stripTags(tds[1])),
      refunds: money(stripTags(tds[2])),
      net: money(stripTags(tds[3])),
      packageShare: money(stripTags(tds[4])),
      txns: Math.round(money(stripTags(tds[5]))),
    });
  }

  /* ---- the per-branch cards ----
     The company-wide "All Branches" table is also wrapped in `.c-bcard`, so the
     cards are taken from after the Branch Detail heading. Counting from the top
     of the section instead double-counts every figure exactly once — 7,539,452
     becomes 15,078,904. */
  const detailAt = section.indexOf('Branch Detail');
  if (detailAt < 0) throw new Error('The branch detail section is missing.');
  const cards = section.slice(detailAt).split('<div class="c-bcard">').slice(1);

  const rows = [];
  const registers = new Map();
  for (const card of cards) {
    const nameM = /class="nm">([^<]*)</.exec(card);
    if (!nameM) continue;
    const branch = nameM[1].trim();

    /* The header has two rows: a group band, then the registers. Take the one
       that starts with the Day cell. Subtotal columns carry `st`, and the last
       two are always the day net and the package share — none of them is a
       register, but all of them occupy a cell in every body row. */
    const thead = card.slice(card.indexOf('<thead>'), card.indexOf('</thead>'));
    const regRow = thead.slice(thead.indexOf('>Day<'));
    const columns = [...regRow.matchAll(/<th class="n( st)?"[^>]*>([^<]*)</g)].map((m) => ({
      name: m[2].trim(),
      value: !m[1] && !/^Day net$/i.test(m[2].trim()) && !/Packages/.test(m[2]),
    }));
    columns.forEach((c, i) => { if (c.value && !registers.has(c.name)) registers.set(c.name, i); });

    for (const tds of tableRows(card)) {
      const date = dateOf(tds[0] || '');
      if (!date) continue; // the card's own total row
      columns.forEach((col, i) => {
        if (!col.value) return;
        const c = readCell(tds[i + 1] || '');
        if (!c.net && !c.packageShare && !c.refunds) return;
        rows.push({ date, branch, register: col.name, ...c, gross: c.net + c.refunds });
      });
    }
  }

  /* ---- the header figures, for the reconciliation gate ----
     Each is `<span>Label</span><span class="v">Value</span>`, so the value comes
     AFTER its label. Reading backwards silently returns the neighbouring
     figure, which is worse than returning nothing. */
  const head = section.slice(0, section.indexOf('Company Daily Summary'));
  const headline = (label) => {
    const at = head.indexOf(label);
    if (at < 0) return null;
    const after = head.slice(at, at + 400);
    const m = /class="(?:v|v neg)"[^>]*>\s*[−–-]?\s*([\d,]+)/.exec(after);
    return m ? money(m[1]) : null;
  };
  const availability = (label) => {
    const at = head.indexOf(label);
    if (at < 0) return null;
    const m = /class="v"[^>]*>\s*([\d,]+)/.exec(head.slice(at, at + 400));
    return m ? money(m[1]) : null;
  };

  return {
    days,
    rows,
    registers: [...registers.keys()],
    published: {
      gross: headline('Gross customer receipts'),
      refunds: headline('Customer refunds'),
      packageShare: headline('of which package sales'),
      txns: headline('Receipt transactions'),
      net: headline('Net collections'),
      t0: availability('Same-day funds'),
      t1: availability('Next-day funds'),
      settlement: availability('On settlement'),
    },
  };
}

module.exports = { sliceObject, readCollections, money, readCell };
