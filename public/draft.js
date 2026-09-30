/* ============================================================
   Turning parsed spreadsheet rows into a draft target sheet.

   Split out of the Import screen so it can be tested in Node against a workbook
   this app actually generated, rather than only by hand in a browser. There is
   one copy: the page loads it as a script, the tests require() it.

   The rule that matters here: a row is kept because it names somebody, not
   because it already has a number. The old filter was
   `r[name] && Number(r[target])`, which quietly dropped every row whose target
   was blank — and the export exists precisely to hand back a sheet where EVERY
   target is blank, so importing one would have produced an empty sheet. It also
   dropped a deliberate 0, which is a real decision somebody may want to record.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Draft = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** A number, or null for "nothing there". Distinguishes blank from zero. */
  function numOr(v) {
    if (v === null || v === undefined) return null;
    const t = String(v).replace(/,/g, '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

  /**
   * Rows + a column map -> the doctors and groups of a draft sheet.
   *
   *   build(rows, { name, group, target, prev })
   *     -> { doctors, groups, unreadable, blanks }
   *
   * `unreadable` names the rows whose target was present but not a number —
   * "TBC", or a typo like "3,25o,000". Those must be reported rather than
   * silently read as zero, or a slip becomes a target nobody chose.
   */
  function build(rows, cols) {
    const doctors = [];
    const unreadable = [];

    for (const r of rows || []) {
      const name = String(r[cols.name] == null ? '' : r[cols.name]).trim();
      if (!name) continue;

      const raw = r[cols.target];
      const target = numOr(raw);
      const blank = isBlank(raw);
      if (target === null && !blank) unreadable.push({ name, value: String(raw).trim() });

      doctors.push({
        name,
        group: cols.group ? String(r[cols.group] || '').trim() || null : null,
        monthlyTarget: target === null ? 0 : target,
        prevMonth: cols.prev ? numOr(r[cols.prev]) : null,
        hasSales: true,
        // Editor-only. PUT /api/targets/:period maps its fields explicitly, so
        // this never reaches the database.
        needsTarget: target === null,
      });
    }

    /* Group totals are derived, never read from the file: the server rejects a
       sheet whose groups do not equal their doctors, and deriving them is the
       only way that holds by construction. */
    const groups = {};
    for (const d of doctors) {
      const g = d.group || 'Other';
      if (!groups[g]) groups[g] = { target: 0, rosterCount: 0, unlistedCount: 0, unlistedTarget: 0 };
      groups[g].target += d.monthlyTarget;
      groups[g].rosterCount += 1;
    }

    return { doctors, groups, unreadable, blanks: doctors.filter((d) => d.needsTarget).length };
  }

  /* ---------------------------------------------------------------------- */

  /** What the export writes. An exact hit needs no guessing at all. */
  const HEADINGS = { name: 'Doctor', group: 'Group', target: 'Monthly Target', prev: 'Previous' };

  /* The same guesses the /admin mapping screen offers, for a sheet somebody
     typed themselves rather than exported from here. */
  const GUESS = {
    name: /name|doctor|specialist/i,
    group: /group|category|dept/i,
    prev: /july|prev|last/i,
    target: /target|august|month/i,
  };

  /**
   * Work out which column is which.
   *
   *   resolveColumns(['Doctor','Group','Monthly Target','Previous'])
   *     -> { name, group, target, prev, guessed: [] }
   *
   * Exact headings win outright. Anything left over falls back to the guesses,
   * in order, and a column already claimed cannot be claimed twice — without
   * that, a sheet headed "August Target" and "July Target" hands BOTH to the
   * target role (each contains "target", and the last match wins), so next
   * month's targets would silently come from last month's column.
   */
  function resolveColumns(columns) {
    const cols = { name: null, group: null, target: null, prev: null };
    const guessed = [];
    const taken = new Set();

    for (const role of Object.keys(cols)) {
      const exact = (columns || []).find((c) => c === HEADINGS[role]);
      if (exact) { cols[role] = exact; taken.add(exact); }
    }
    // Least ambiguous first; `target` last, because its guess is the broadest.
    for (const role of ['name', 'group', 'prev', 'target']) {
      if (cols[role]) continue;
      const hits = (columns || []).filter((c) => !taken.has(c) && GUESS[role].test(c));
      if (!hits.length) continue;
      cols[role] = hits[hits.length - 1];
      taken.add(cols[role]);
      guessed.push(role);
    }
    return { ...cols, guessed };
  }

  /**
   * "2026-08" -> "2026-09".
   *
   * The same roll-forward `src/lib/export-targets.js` uses for the workbook
   * name, and test/export.test.js pins the two against each other. It lives
   * here as well because the Admin screen has to name next month before any
   * file exists — and December has to roll the year, which is the one case a
   * hand-written `+1` gets wrong.
   */
  function nextPeriod(period) {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period || ''));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }

  /** Days in a period, for the daily-target divisor. */
  function daysInPeriod(period) {
    const [y, m] = String(period).split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /**
   * Next month's sheet, carried from a published one.
   *
   *   carryForward(sheet) -> { period, daysInPeriod, sourceLabel, groups, doctors, branches }
   *
   * THE TARGETS COME ACROSS BLANK, and that is the whole design. The roster,
   * the groups and the branch figures are the tedious part — 73 names and 9
   * branches — and they are what carries. The numbers do not: a month that
   * arrives pre-filled gets published unchanged, and last month's targets
   * become this month's while looking like a decision was made. That is the
   * same rule `export-targets.js` states about the workbook, applied to the
   * screen that replaces it.
   *
   * Each doctor's old target lands in `prevMonth`, so the figure is on screen
   * beside the empty box rather than in another tab.
   *
   * Group targets start at 0 too, which reconciles against 0 doctors — so the
   * ledger is green on a sheet that is not filled in yet. `needsTarget` is what
   * the editor shows instead, and it is set on every row here.
   */
  function carryForward(sheet) {
    const period = nextPeriod(sheet.period);
    if (!period) return null;

    const doctors = (sheet.doctors || []).map((d) => ({
      name: d.name,
      group: d.group || null,
      monthlyTarget: 0,
      // Last month's target, for reference — the workbook's "Previous" column.
      prevMonth: d.monthlyTarget == null ? null : Number(d.monthlyTarget),
      hasSales: d.hasSales !== false,
      needsTarget: true,
    }));

    /* Groups keep their names, their roster head-count and whatever value was
       held for members with no sales — but not their totals, which have to be
       whatever the new doctor numbers add up to. */
    const groups = {};
    for (const [name, g] of Object.entries(sheet.groups || {})) {
      groups[name] = {
        target: 0,
        rosterCount: Number(g.rosterCount || 0),
        unlistedCount: Number(g.unlistedCount || 0),
        unlistedTarget: 0,
      };
    }
    /* A doctor whose group was never listed would fail the publish validator
       with "assigned to X, which has no group entry". Carrying the sheet must
       not be the thing that introduces that, so any such group is created. */
    for (const d of doctors) {
      const g = d.group || 'Other';
      if (!groups[g]) groups[g] = { target: 0, rosterCount: 0, unlistedCount: 0, unlistedTarget: 0 };
    }

    return {
      period,
      daysInPeriod: daysInPeriod(period),
      sourceLabel: `Carried from ${sheet.period}`,
      groups,
      doctors,
      branches: (sheet.branches || []).map((b) => ({ name: b.name, target1: b.target1, target2: b.target2 ?? null })),
      carriedFrom: sheet.period,
    };
  }

  /**
   * Set each group's target to what its doctors actually add up to.
   *
   *   balanceGroups(draft) -> { changed: [{ name, from, to }] }
   *
   * The published sheet states group totals independently, and the server
   * refuses a sheet where a total does not equal its doctors — that is the
   * defect the original report shipped and the check stays. This does not
   * weaken it: it is for the case where there is no independent figure to
   * transcribe because the sheet is being typed here, which is exactly what
   * the Excel path already does (`build` derives group totals from the rows and
   * never reads them from the file). Typing an approved total by hand still
   * gets checked against the doctors, as before.
   *
   * `rosterCount` is brought along, because the validator counts heads too:
   * doctors in the group plus the unlisted count.
   */
  function balanceGroups(draft) {
    const listed = {};
    const heads = {};
    for (const d of draft.doctors || []) {
      const g = d.group || 'Other';
      listed[g] = (listed[g] || 0) + Number(d.monthlyTarget || 0);
      heads[g] = (heads[g] || 0) + 1;
    }
    const changed = [];
    for (const g of Object.keys(listed)) {
      if (!draft.groups[g]) draft.groups[g] = { target: 0, rosterCount: 0, unlistedCount: 0, unlistedTarget: 0 };
    }
    for (const [name, g] of Object.entries(draft.groups)) {
      const want = (listed[name] || 0) + Number(g.unlistedTarget || 0);
      const wantHeads = (heads[name] || 0) + Number(g.unlistedCount || 0);
      if (Math.abs(Number(g.target || 0) - want) > 0.01 || Number(g.rosterCount || 0) !== wantHeads) {
        changed.push({ name, from: Number(g.target || 0), to: want });
      }
      g.target = want;
      g.rosterCount = wantHeads;
    }
    return { changed };
  }

  /**
   * Everything wrong with a sheet, as sentences. Empty means it will publish.
   *
   *   problems({ groups, doctors }) -> string[]
   *
   * THIS IS THE PUBLISH VALIDATOR ITSELF, not a copy of it: PUT
   * /api/targets/:period delegates to this function, so the editor's ledger and
   * the server's refusal cannot disagree. It moved here because they DID
   * disagree, in two ways that both ended the same — a green panel, an enabled
   * Publish button, and an error dialog after the click:
   *
   *   1. The ledger skipped doctors marked "no sales" when summing a group;
   *      the server has always counted them. Nobody on the August sheet is
   *      marked that way, so the difference was dormant rather than fixed.
   *   2. The ledger never checked HEAD COUNT at all. Remove one doctor from a
   *      carried sheet and `rosterCount` no longer matches the rows under the
   *      group — which the server rejects and the ledger called balanced.
   *
   * `Balance groups` settles both, which is why it brings rosterCount along.
   *
   * An empty sheet passes here, deliberately: "no groups and no doctors" is
   * not self-contradictory. It is the EDITOR that refuses to publish one,
   * because doing so would replace a month with nothing.
   */
  function problems(b) {
    const out = [];
    if (!b || typeof b !== 'object') return ['Body must be an object.'];
    if (!b.groups || typeof b.groups !== 'object') out.push('groups is required.');
    if (!Array.isArray(b.doctors)) out.push('doctors must be an array.');
    if (out.length) return out;

    const listed = {};
    for (const d of b.doctors) {
      if (!d.name) out.push('A doctor row has no name.');
      if (!Number.isFinite(Number(d.monthlyTarget))) out.push(`${d.name}: monthlyTarget must be a number.`);
      const g = d.group || 'Other';
      listed[g] = (listed[g] || 0) + Number(d.monthlyTarget || 0);
    }

    for (const [name, g] of Object.entries(b.groups)) {
      const sum = (listed[name] || 0) + Number(g.unlistedTarget || 0);
      if (Math.abs(sum - Number(g.target)) > 0.01) {
        out.push(`${name}: doctors (${(listed[name] || 0).toLocaleString()}) + unlisted (${Number(g.unlistedTarget || 0).toLocaleString()}) = ${sum.toLocaleString()}, but the group target is ${Number(g.target).toLocaleString()}.`);
      }
      const heads = b.doctors.filter((d) => (d.group || 'Other') === name).length + Number(g.unlistedCount || 0);
      if (g.rosterCount && heads !== Number(g.rosterCount)) {
        out.push(`${name}: ${heads} people accounted for but rosterCount says ${g.rosterCount}.`);
      }
    }
    for (const g of Object.keys(listed)) {
      if (!b.groups[g]) out.push(`Doctors are assigned to "${g}" but it has no group entry.`);
    }
    return out;
  }

  /**
   * The same arithmetic, laid out per group so the editor can show it.
   *
   *   ledger({ groups, doctors }) -> { lines, problems, ok }
   *
   * `ok` is `problems` being empty AND there being something to publish — it is
   * NOT computed from the lines, because a line can balance while the sheet is
   * still refused (head count, a nameless row). Deriving it from the lines is
   * what let the two screens drift apart in the first place.
   */
  function ledger(draft) {
    const listed = {};
    const heads = {};
    for (const d of (draft && draft.doctors) || []) {
      const g = d.group || 'Other';
      listed[g] = (listed[g] || 0) + Number(d.monthlyTarget || 0);
      heads[g] = (heads[g] || 0) + 1;
    }
    const lines = Object.entries((draft && draft.groups) || {}).map(([name, g]) => {
      const sum = (listed[name] || 0) + Number(g.unlistedTarget || 0);
      const people = (heads[name] || 0) + Number(g.unlistedCount || 0);
      return {
        name,
        listed: listed[name] || 0,
        unlisted: Number(g.unlistedTarget || 0),
        sum,
        target: Number(g.target || 0),
        people,
        roster: Number(g.rosterCount || 0),
        ok: Math.abs(sum - Number(g.target || 0)) <= 0.01
          && (!g.rosterCount || people === Number(g.rosterCount)),
      };
    });
    const found = problems(draft);
    return { lines, problems: found, ok: found.length === 0 && lines.length > 0 };
  }

  /** "Targets 2026-09" or a filename -> "2026-09". */
  function periodFrom(text) {
    const m = /(\d{4})-(0[1-9]|1[0-2])/.exec(String(text || ''));
    return m ? `${m[1]}-${m[2]}` : null;
  }

  /**
   * The branch targets to keep when publishing `period`.
   *
   * Publishing replaces a period wholesale, and an imported file has no branches
   * in it, so without this every import deletes all nine. `api` is a function
   * that fetches a URL and resolves to parsed JSON.
   */
  async function carryBranches(api, period) {
    try {
      const published = await api('/api/targets');
      const periods = published.map((p) => p.period).sort();
      const from = [...periods].reverse().find((p) => p <= period) || periods[periods.length - 1];
      if (!from) return { from: null, rows: [] };
      const sheet = await api(`/api/targets/${from}`);
      const rows = (sheet.branches || []).map((b) => ({ name: b.name, target1: b.target1, target2: b.target2 }));
      return rows.length ? { from, rows } : { from: null, rows: [] };
    } catch {
      // Never block an import on this; the summary states what will be saved.
      return { from: null, rows: [] };
    }
  }

  return { build, numOr, resolveColumns, periodFrom, carryBranches, nextPeriod, daysInPeriod, carryForward, balanceGroups, problems, ledger, HEADINGS };
});
