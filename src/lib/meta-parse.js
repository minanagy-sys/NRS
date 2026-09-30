/* ============================================================
   Reading doctor, service and branch out of Meta campaign and ad names.

   This is an INFERENCE, and the whole module exists to keep it honest.

   The names are typed by whoever built the campaign, with no convention
   enforced: `Dr Poussy l Leads l July`, `Dr.Randa | leads | campaign l Aug l
   BodyContou`, `dr hussam messages july`, `MOA l Laser l Leads l Aug`,
   `SM-Laser-July`. Separators are spaces, dots, pipes, hyphens and a lowercase
   `l` standing in for a pipe. Doctor names are spelled more than one way —
   `Hossam` and `hussam` are the same person.

   Two rules make this safe rather than clever:

   1. ORDER IS LOAD-BEARING, most specific first. This is the same shape as the
      `Injection/Body Contouring` bug in target-tracker.js, where a prefix rule
      filed a body-contouring category as an injection and read the x1.25 card
      as 0.00%. Here the equivalent trap is `body contour` vs `filler`: the ad
      `body contour` belongs to a filler doctor, and a doctor-first or
      alphabetical rule set would mislabel it.

   2. NO GUESSING. Every field is nullable and an unrecognised name returns
      null. A wrong label is worse than a missing one, because a missing one is
      visible on the page and a wrong one is not.

   And one thing the names genuinely cannot answer, which took looking at the
   real data to see: AD-LEVEL service and branch must be INHERITED from the
   parent campaign. The ad named `offer` is Laser at Mall Of Arabia in one
   campaign and unlabelled at Alexandria in another; `lpg` and `onda` are body
   devices that sit in the `Nutrition` campaign and take its label. The ad name
   alone is not enough information, so `parseAd` takes the campaign's parse and
   fills its own gaps from it — recording which fields it inherited so the page
   can show what was inferred instead of asserting it.
   ============================================================ */

/* Doctors, keyed on how the campaigns actually spell them, mapped to the
   spelling Odoo uses on `Invoice.specialistName` so the two sides join. Where a
   doctor has more than one spelling in the wild, every spelling is listed —
   `IdentityAlias` is the right home for a mapping somebody maintains, but these
   are typos in ad names rather than a business naming scheme, so they belong
   with the parser that has to survive them. */
/* What sits between `dr` and the name, in one place because it is not guessable
   and every doctor rule needs the same answer. The observed set is a space
   (`Dr Poussy`), a dot (`Dr.Randa`), nothing (`drmai`) — and a BACKSLASH, in the
   lead form named `dr\poussy`, which is what the forms come back as from
   Meta. A rule that only allowed whitespace and a dot dropped that form's
   doctor, which is the entire content of the lead-form table. */
const SEP = '[\\s._|\\\\/-]*';
const doctor = (first, name) => ({ re: new RegExp(`\\bd${SEP}r\\.?${SEP}${first}\\b`, 'i'), name });

const DOCTORS = [
  doctor('poussy', 'Dr. Poussy Maher'),
  doctor('randa', 'Dr. Randa El Aguizy'),
  doctor('ghada', 'Dr. Ghada Amer'),
  doctor('mai', 'Dr. Mai mohsen'),
  doctor('nesma', 'Dr.Nesma Saad'),
  /* Both spellings, one doctor. Without the second the `dr hussam messages
     july` campaign and the `SM l Dr Hussam l July` campaign come back unlabelled
     and his spend disappears from the per-doctor table. */
  doctor('hossam', 'Dr.Hossam Shehab'),
  doctor('hussam', 'Dr.Hossam Shehab'),
];

/* Services. Ordered most specific first: `nose filler` and `lip filler` have to
   be tested before bare `filler`, and `body contour` before anything that might
   also match it. `Q-Switched Laser` and `deka` are both the laser family. */
const SERVICES = [
  { re: /body\s*contou?r/i, name: 'Body contouring' },
  { re: /\bskin\s*booster\b|\blip\s*booster\b/i, name: 'Skin booster' },
  { re: /\bnose\s+filler\b|\blip\s+filler\b|\bfull[-\s]?face\s+filler\b|\bfiller\b/i, name: 'Filler' },
  { re: /\bbotox\b/i, name: 'Botox' },
  { re: /\bpeptides?\b/i, name: 'Peptides' },
  { re: /\bderma(pen)?\b/i, name: 'Dermapen' },
  { re: /\bhydra\s*facial\b/i, name: 'HydraFacial' },
  { re: /\bq[-\s]?switched\b|\bdeka\b|\blaser\b/i, name: 'Laser / DEKA' },
  { re: /\bnutrition\b/i, name: 'Nutrition' },
];

/* Branches, mapped to the Odoo `branchName` spelling. `MOA` and `Madienaty` are
   the ad-side shorthands for names Odoo spells differently; `Alex` is a city
   rather than a branch and is kept as its own label because the campaign means
   "the Alexandria accounts", which spans two Odoo branches. */
const BRANCHES = [
  { re: /\bmoa\b|\bmall\s*of\s*arabia\b/i, name: 'Mall Of Arabia' },
  { re: /\bcity\s*stars\b|\bcitystars\b/i, name: 'City Stars' },
  { re: /\bmadienaty\b|\bmadinity\b|\bmadinty\b/i, name: 'Madinity' },
  { re: /\bcfc\b/i, name: 'CFC' },
  { re: /\balex(andria)?\b/i, name: 'Alexandria' },
  { re: /\broushdy\b|\brushdy\b/i, name: 'Roushdy' },
  { re: /\bmohandseen\b/i, name: 'Mohandseen' },
  { re: /\bzayed\b|\bzaied\b/i, name: 'Zayed' },
  { re: /\bloran\b/i, name: 'Loran' },
  { re: /\brehab\b/i, name: 'El Rehab' },
];

/* Meta's own objective codes, mapped to the words the report uses.
   VERIFIED against the live pull on 2026-09-04: for all 39 campaigns that spent
   in the frozen report's window, the report's label and Meta's code agree
   one-for-one — OUTCOME_LEADS/Leads, OUTCOME_TRAFFIC/Traffic,
   OUTCOME_ENGAGEMENT/Engagement.

   `Sales` and `Awareness` are here although the frozen report never shows
   them: OUTCOME_SALES is 1.15M of spend across the fifteen months and simply
   did not run in the report's nineteen days. The reports have to answer any
   range, and a range containing that spend must name its objective rather than
   file it under one of the three that happened to occur in August.

   Legacy codes are included because campaigns started before Meta's ODAX
   renaming still carry them. */
const OBJECTIVE_CODES = {
  OUTCOME_LEADS: 'Leads',
  OUTCOME_TRAFFIC: 'Traffic',
  OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_SALES: 'Sales',
  OUTCOME_AWARENESS: 'Awareness',
  OUTCOME_APP_PROMOTION: 'App promotion',
  /* pre-ODAX */
  LEAD_GENERATION: 'Leads',
  MESSAGES: 'Engagement',
  POST_ENGAGEMENT: 'Engagement',
  PAGE_LIKES: 'Engagement',
  LINK_CLICKS: 'Traffic',
  TRAFFIC: 'Traffic',
  CONVERSIONS: 'Sales',
  REACH: 'Awareness',
  BRAND_AWARENESS: 'Awareness',
  VIDEO_VIEWS: 'Awareness',
};

/** Meta's code → the report's word. An unknown code is returned AS-IS rather
 *  than dropped: seeing `OUTCOME_SOMETHING_NEW` on the page is how we find out
 *  Meta added one, whereas a null would silently empty the column. */
const objectiveOf = (code) => {
  const raw = String(code || '').trim();
  if (!raw) return null;
  return OBJECTIVE_CODES[raw.toUpperCase()] || raw;
};

/* The fallback, for when Meta gives us no objective at all: read it out of the
   name. `pv` and `profile visits` are the same thing; `sm` is a social-messaging
   campaign, which the report counts as engagement. */
const OBJECTIVES = [
  { re: /\bleads?\b/i, name: 'Leads' },
  { re: /\bprofile\s*visits?\b|\bpv\b/i, name: 'Traffic' },
  { re: /\bsm\b|\bmessages?\b/i, name: 'Engagement' },
];

const firstMatch = (list, text) => {
  for (const rule of list) if (rule.re.test(text)) return rule.name;
  return null;
};

/**
 * Parse a campaign name.
 *
 * `confidence` counts how many of the three dimensions resolved, so a caller can
 * tell "we know the doctor and nothing else" from "we know nothing" without
 * inspecting each field.
 */
function parseCampaign(name, objectiveHint) {
  const text = String(name || '');
  const doctor = firstMatch(DOCTORS, text);
  const service = firstMatch(SERVICES, text);
  const branch = firstMatch(BRANCHES, text);
  /* Meta's own objective field wins when we have it — it is a fact, and the
     name is a guess at the same thing. It arrives as a CODE (`OUTCOME_LEADS`),
     so it is translated rather than stored raw: `OUTCOME_LEADS` in a column
     headed "Objective" is Meta's internal vocabulary leaking onto a page the
     clinic reads. */
  const objective = objectiveOf(objectiveHint) || firstMatch(OBJECTIVES, text);
  return {
    doctor, service, branch, objective,
    confidence: [doctor, service, branch].filter(Boolean).length,
  };
}

/**
 * Parse an ad name, then fill its gaps from its campaign.
 *
 * `inherited` names the fields that came from the campaign rather than this ad,
 * which is what lets a page distinguish "this ad is about laser" from "this ad
 * is in a laser campaign". Without that distinction the per-ad service table
 * reads as if every ad name declared its own service, and a third of them do
 * not.
 */
function parseAd(name, campaignParse) {
  const text = String(name || '');
  const own = {
    doctor: firstMatch(DOCTORS, text),
    service: firstMatch(SERVICES, text),
    branch: firstMatch(BRANCHES, text),
  };
  const from = campaignParse || {};
  const inherited = [];
  const out = {};
  for (const field of ['doctor', 'service', 'branch']) {
    if (own[field]) { out[field] = own[field]; continue; }
    if (from[field]) { out[field] = from[field]; inherited.push(field); continue; }
    out[field] = null;
  }
  return {
    ...out,
    inherited,
    confidence: [out.doctor, out.service, out.branch].filter(Boolean).length,
  };
}

/** Parse a lead form name. The forms are named for the doctor and nothing else. */
function parseLeadForm(formName) {
  const text = String(formName || '');
  return { doctor: firstMatch(DOCTORS, text) };
}

module.exports = {
  parseCampaign, parseAd, parseLeadForm, objectiveOf,
  DOCTORS, SERVICES, BRANCHES, OBJECTIVES, OBJECTIVE_CODES,
};
