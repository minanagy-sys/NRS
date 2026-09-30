/* ============================================================
   Reading an uploaded target schedule.

   This used to hand the file to `xlsx`, whose npm release is stuck at 0.18.5
   with two unfixable high-severity advisories — prototype pollution and a ReDoS
   that would freeze the whole event loop — and it was reachable by anyone who
   could sign in. Parsing an untrusted file with an unmaintained dependency is
   the one combination worth avoiding outright.

   .xlsx is a zip of XML, and the shape we need is a rectangle of cells. Node
   unzips it natively, so this reads both .xlsx and .csv with no dependency at
   all, in a few hundred lines we can actually audit.

   Deliberately narrow: cell values only. No formulas, no macros, no styles, no
   external references — none of which a target sheet needs.
   ============================================================ */

const zlib = require('zlib');

const MAX_BYTES = 12 * 1024 * 1024; // a target schedule is a few hundred rows
const MAX_ROWS = 20000;

/* ------------------------------------------------------------------ zip --- */

/** Read the central directory rather than scanning local headers. */
function unzip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no zip directory).');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra field with its own lengths.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    try {
      files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch { /* a member we cannot read is a member we do not need */ }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (b) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * Build a zip from `{ path: text }`. Deflated members, local headers, central
 * directory, EOCD — the mirror of `unzip` above, and the only part of writing an
 * .xlsx that is about bytes rather than XML.
 */
function zipOf(parts) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10); cd.writeUInt32LE(sum, 16); cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(parts).length, 8);
  eocd.writeUInt16LE(Object.keys(parts).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/* ------------------------------------------------------------------ xml --- */

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&'); // last, so &amp;lt; does not become <

/** Shared strings table: cells reference it by index. */
function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.toString('utf8').split('<si>').slice(1)) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]));
    out.push(parts.join(''));
  }
  return out;
}

/** "BC12" -> 54 (zero-based column). */
function colOf(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** One worksheet -> array of row arrays. */
function sheetRows(xml, strings) {
  const rows = [];
  const text = xml.toString('utf8');
  for (const rowXml of text.split('<row').slice(1)) {
    if (rows.length >= MAX_ROWS) break;
    const cells = [];
    /* The self-closing form MUST come first in this alternation. Regex
       alternation is left-to-right, so with `<c…>…</c>` leading, an empty cell
       like `<c r="C2" s="2"/>` matched that branch instead: `[^>]*` ate the
       slash and the lazy body ran on to the NEXT `</c>`, swallowing the cell
       after it and reporting its value under the empty cell's column.

       Excel writes exactly that form for a styled-but-empty cell, which is what
       every column of a blank fill-in template becomes once it has been opened
       and saved. Measured before the swap: a row whose target was left blank and
       whose previous-month figure was 3,250,000 parsed as
       `{"Monthly Target":3250000,"Previous":null}` — last month's number
       silently promoted to next month's target. */
    for (const m of rowXml.matchAll(/<c([^>]*?)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = m[1] !== undefined ? m[1] : m[2];
      const body = m[3] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      const at = ref ? colOf(ref) : cells.length;

      let value = null;
      if (type === 'inlineStr') {
        const parts = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]));
        value = parts.join('') || null;
      } else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) {
          value = type === 's' ? (strings[Number(v)] ?? null)
            : type === 'str' ? decodeEntities(v)
              : v === '' ? null : Number(v);
          if (typeof value === 'number' && Number.isNaN(value)) value = decodeEntities(v);
        }
      }
      while (cells.length < at) cells.push(null);
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/* ------------------------------------------------------------------ csv --- */

/** RFC 4180: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const push = () => { row.push(field === '' ? null : maybeNumber(field)); field = ''; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === ',') { push(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      push(); rows.push(row); row = [];
      if (rows.length >= MAX_ROWS) return rows;
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  return rows;
}

const maybeNumber = (s) => {
  const t = s.trim().replace(/,/g, '');
  if (t === '' || !/^-?\d*\.?\d+$/.test(t)) return s.trim();
  return Number(t);
};

/* ----------------------------------------------------------------- api --- */

/**
 * Read a workbook or CSV.
 * Returns { sheets: [name], sheet, columns: [header], rows: [{header: value}] }.
 */
/* Locating a worksheet and decoding its cells is the same work whether the
   caller wants tidy objects or the raw grid, so it lives here once. */
function locate(buffer, wanted) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected a file.');
  if (buffer.length > MAX_BYTES) throw new Error(`File is too large (limit ${MAX_BYTES / 1048576} MB).`);
  if (!buffer.length) throw new Error('File is empty.');

  // A zip starts "PK"; anything else we treat as text.
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!isZip) return { grid: parseCsv(buffer.toString('utf8')), sheets: ['(csv)'], sheet: '(csv)' };

  const files = unzip(buffer);
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook.');

  // Sheet name -> r:id -> target path.
  const names = [...workbook.toString('utf8').matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)]
    .map((m) => ({ name: decodeEntities(m[1]), rid: m[2] }));
  const relsXml = (files.get('xl/_rels/workbook.xml.rels') || Buffer.alloc(0)).toString('utf8');
  const rels = Object.fromEntries(
    [...relsXml.matchAll(/<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)]
      .map((m) => [m[1], m[2].replace(/^\/?xl\//, '').replace(/^\//, '')]));

  if (!names.length) throw new Error('The workbook has no worksheets.');
  const chosen = names.find((s) => s.name === wanted) || names[0];
  const path = `xl/${rels[chosen.rid] || `worksheets/sheet1.xml`}`;
  const sheetXml = files.get(path) || files.get('xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error(`Could not read worksheet "${chosen.name}".`);

  return {
    grid: sheetRows(sheetXml, sharedStrings(files.get('xl/sharedStrings.xml'))),
    sheets: names.map((s) => s.name),
    sheet: chosen.name,
  };
}

function read(buffer, wanted, headerRow) {
  const located = locate(buffer, wanted);
  return shape(located.grid, located.sheets, located.sheet, headerRow);
}

/** The raw 2-D grid, with NO header guessing.
 *
 *  shape() takes the first non-empty row as the header, which is right for a
 *  target sheet somebody uploads but wrong for a workbook that carries a title
 *  on row 1 and the real header on row 4 — the commission policy does exactly
 *  that, so read() would name every column after the title. An importer that
 *  knows its own layout should take the grid and slice it itself. */
function gridOf(buffer, wanted) {
  return locate(buffer, wanted);
}

/** First non-empty row is the header; the rest become objects. */
function shape(grid, sheets, sheet, headerRow) {
  /* `headerRow` is a ONE-BASED sheet row, the number the person reading the
     file in Excel can see in the margin. It exists because the first non-empty
     row is the header in most uploads and emphatically not in all of them: the
     commission workbook's Basic worksheet carries a merged "Deductions /
     Total" banner on row 2 and its real header on row 5, and guessing would
     name every column after the banner. Told which row, this reads it; told
     nothing, it behaves exactly as before. */
  const headerAt = headerRow
    ? Number(headerRow) - 1
    : grid.findIndex((r) => r.some((c) => c !== null && String(c).trim() !== ''));
  if (headerAt < 0 || !grid[headerAt]) return { sheets, sheet, columns: [], rows: [], rowCount: 0 };

  const seen = new Map();
  const columns = grid[headerAt].map((c, i) => {
    let name = c === null ? `Column ${i + 1}` : String(c).trim() || `Column ${i + 1}`;
    // Duplicate headers would silently overwrite each other.
    if (seen.has(name)) { const n = seen.get(name) + 1; seen.set(name, n); name = `${name} (${n})`; }
    else seen.set(name, 1);
    return name;
  });

  const rows = [];
  for (const r of grid.slice(headerAt + 1)) {
    if (!r.some((c) => c !== null && String(c).trim() !== '')) continue;
    const o = Object.create(null); // no prototype: an uploaded header cannot reach Object.prototype
    columns.forEach((name, i) => { o[name] = r[i] === undefined ? null : r[i]; });
    rows.push(o);
  }
  return { sheets, sheet, columns, rows, rowCount: rows.length };
}

/* ---------------------------------------------------------------- write --- */

/* Excel is far stricter about what it will open than this reader is about what
   it will parse. A workbook missing [Content_Types].xml or the root _rels/.rels
   parses fine here and makes Excel offer to "repair" the file, which is a dialog
   nobody should have to see. So write the six parts a real workbook has, with
   real relationship Type URIs and real namespaces. */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Characters XML forbids outright; one of them makes the whole file unopenable.
const stripControl = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // eslint-disable-line no-control-regex
const esc = (s) => stripControl(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 0 -> A, 25 -> Z, 26 -> AA. */
function colName(n) {
  let s = '';
  for (let i = n + 1; i > 0;) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Excel rejects these outright, and silently truncates past 31 characters. */
function sheetNameOf(raw, taken) {
  let n = stripControl(raw == null ? '' : String(raw))
    .replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  if (!n) n = 'Sheet';
  let candidate = n;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    candidate = n.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Write a workbook.
 *
 *   write([{ name, rows, cols }], { shared })  ->  Buffer
 *
 *   rows  array of arrays; each cell is string | number | null
 *   cols  optional per-column `{ width, money }`; `money` gives the whole column
 *         the thousands format, so a figure the user types later formats itself
 *
 * Mirrors `read`: cell values only, no formulas, no macros, no external refs.
 */
function write(sheets, { shared = false } = {}) {
  const list = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
  if (!list.length) throw new Error('Nothing to write.');

  const taken = new Set();
  const strings = [];
  const stringId = (s) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };

  const prepared = list.map((s) => {
    const rows = s.rows || [];
    if (rows.length > MAX_ROWS) throw new Error(`Too many rows (limit ${MAX_ROWS}).`);
    return { name: sheetNameOf(s.name, taken), rows, cols: s.cols || [], header: s.header !== false };
  });

  const worksheets = prepared.map(({ rows, cols, header }) => {
    const width = Math.max(1, ...rows.map((r) => r.length));
    const body = rows.map((row, r) => {
      const cells = row.map((v, c) => {
        /* An empty cell is written by leaving it out entirely — never as
           `<c r="C2" s="2"/>`. Excel treats an absent cell as a blank the user
           can type into, the column style still formats whatever they type, and
           this reader pads from the `r=` refs so it comes back as null. */
        if (v === null || v === undefined || v === '') return '';
        const ref = `${colName(c)}${r + 1}`;
        if (typeof v === 'number' && Number.isFinite(v)) {
          const s = header && r === 0 ? ' s="1"' : cols[c] && cols[c].money ? ' s="2"' : '';
          return `<c r="${ref}"${s}><v>${v}</v></c>`;
        }
        const text = stripControl(String(v));
        const s = header && r === 0 ? ' s="1"' : '';
        // xml:space matters: Odoo really does store names like "Dr. Azza Awad "
        // with a trailing space, and losing it breaks the name match on re-import.
        return shared
          ? `<c r="${ref}"${s} t="s"><v>${stringId(text)}</v></c>`
          : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');

    const colXml = cols.length
      ? `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}"${c.money ? ' style="2"' : ''} customWidth="1"/>`).join('')}</cols>`
      : '';

    // Child order is fixed by the schema; out of order is itself a repair prompt.
    return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">`
      + `<dimension ref="A1:${colName(width - 1)}${Math.max(1, rows.length)}"/>`
      + `<sheetViews><sheetView workbookViewId="0">`
      + (header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '')
      + `</sheetView></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="15"/>${colXml}<sheetData>${body}</sheetData></worksheet>`;
  });

  const parts = {};
  parts['_rels/.rels'] = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  parts['xl/workbook.xml'] = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>`
    // `name` must precede `r:id`: that is the order read() looks for.
    + prepared.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + `</sheets></workbook>`;

  const styleRid = prepared.length + 1;
  parts['xl/_rels/workbook.xml.rels'] = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + prepared.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${styleRid}" Type="${NS_REL}/styles" Target="styles.xml"/>`
    + (shared ? `<Relationship Id="rId${styleRid + 1}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>` : '')
    + `</Relationships>`;

  worksheets.forEach((xml, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = xml; });

  /* Both reserved fills must be present — a styles.xml with only `none` is one
     of the commonest causes of the repair dialog. numFmtId 3 is the built-in
     #,##0, so no custom <numFmts> is needed, and colours are literal because we
     ship no theme part to reference. */
  parts['xl/styles.xml'] = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
    + `<fonts count="2"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>`
    + `<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>`
    + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  if (shared) {
    parts['xl/sharedStrings.xml'] = `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">`
      + strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + `</sst>`;
  }

  const type = (p, t) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${t}+xml"/>`;
  parts['[Content_Types].xml'] = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + type('xl/workbook.xml', 'sheet.main')
    + prepared.map((_, i) => type(`xl/worksheets/sheet${i + 1}.xml`, 'worksheet')).join('')
    + type('xl/styles.xml', 'styles')
    + (shared ? type('xl/sharedStrings.xml', 'sharedStrings') : '')
    + `</Types>`;

  return zipOf(parts);
}

// `unzip` and `zipOf` are exported for the tests: one to look inside what write()
// produced, the other to assemble archives write() would never emit.
module.exports = { read, write, gridOf, zipOf, unzip, MAX_ROWS };
