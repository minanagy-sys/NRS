/**
 * The campaign and ad name parser.
 *
 *   node test/meta-parse.test.js
 *
 * Doctor, service and branch on report 03 are READ OUT OF NAMES people typed
 * into Meta. That is an inference, and the last inference of this shape in this
 * codebase — a prefix rule over Odoo category names — filed
 * `Injection/Body Contouring` as an injection, which read the x1.25
 * strategic-priority card as 0.00% while inflating an injections share that was
 * already breaching its cap. Nothing about that was visible on the page.
 *
 * So every one of the 39 campaign names and 34 ad names from the source pack is
 * pinned here against the label the pack itself assigned, and the interesting
 * assertions are the ones about what the parser must NOT do: not guess, not
 * reorder, and not pretend an ad name carries information it does not.
 */

const assert = require('assert');
const P = require('../src/lib/meta-parse.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  \u2713 ${label}`); }
  catch (e) { failures++; console.log(`  \u2717 ${label} \u2014 ${e.message}`); }
};

/* Verbatim from FAC and FAA in 03_Marketing_Meta_Aug1_19.html, with the
   doctor/service/branch the pack assigned to each. */
const CAMPAIGNS = [
  { name: "Dr Poussy l Leads l July", obj: "Leads", doctor: "Dr. Poussy Maher", service: null, branch: null },
  { name: "MOA l Laser l Leads l July", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "Mall Of Arabia" },
  { name: "Nutrition l July l Leads", obj: "Leads", doctor: null, service: "Nutrition", branch: null },
  { name: "Pv | Nouvelage | July", obj: "Traffic", doctor: null, service: null, branch: null },
  { name: "Alex l Leads l July", obj: "Leads", doctor: null, service: null, branch: "Alexandria" },
  { name: "CityStars l Laser l July l Leads", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "City Stars" },
  { name: "Dr.Randa | leads | campaign l July", obj: "Leads", doctor: "Dr. Randa El Aguizy", service: null, branch: null },
  { name: "Dr Ghada l Leads l July", obj: "Leads", doctor: "Dr. Ghada Amer", service: null, branch: null },
  { name: "Dr.Mai l Leads l July", obj: "Leads", doctor: "Dr. Mai mohsen", service: null, branch: null },
  { name: "pv|nouvelage|june", obj: "Traffic", doctor: null, service: null, branch: null },
  { name: "Madienaty  l Laser l July l Leads", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "Madinity" },
  { name: "Laser - Leads 2", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: null },
  { name: "Zat l Leadsl- Aug l Campaign", obj: "Leads", doctor: null, service: null, branch: null },
  { name: "Dr Mai l profile visits l July", obj: "Traffic", doctor: "Dr. Mai mohsen", service: null, branch: null },
  { name: "CFC l Laser l July l Leads", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "CFC" },
  { name: "Zat - Leads - June Campaign", obj: "Leads", doctor: null, service: null, branch: null },
  { name: "SM-Laser-July", obj: "Engagement", doctor: null, service: "Laser / DEKA", branch: null },
  { name: "Dr Hossam l Leads l July", obj: "Leads", doctor: "Dr.Hossam Shehab", service: null, branch: null },
  { name: "Dr Poussy l SM l July", obj: "Engagement", doctor: "Dr. Poussy Maher", service: null, branch: null },
  { name: "Dr.Randa | leads | campaign l Aug l BodyContouring", obj: "Leads", doctor: "Dr. Randa El Aguizy", service: "Body contouring", branch: null },
  { name: "dr hussam messages july", obj: "Engagement", doctor: "Dr.Hossam Shehab", service: null, branch: null },
  { name: "Dr Poussy l SM l Aug l New", obj: "Engagement", doctor: "Dr. Poussy Maher", service: null, branch: null },
  { name: "SM l Dr Hussam l July", obj: "Engagement", doctor: "Dr.Hossam Shehab", service: null, branch: null },
  { name: "Alex l Leads l Aug", obj: "Leads", doctor: null, service: null, branch: "Alexandria" },
  { name: "CityStars l Laser l Aug l Leads", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "City Stars" },
  { name: "Nutrition l Aug l Leads", obj: "Leads", doctor: null, service: "Nutrition", branch: null },
  { name: "MOA l Laser l Leads l Aug", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "Mall Of Arabia" },
  { name: "Pv | Nouvelage | Aug", obj: "Traffic", doctor: null, service: null, branch: null },
  { name: "Dr Poussy l Leads l Aug", obj: "Leads", doctor: "Dr. Poussy Maher", service: null, branch: null },
  { name: "Dr Ghada l Leads l Aug", obj: "Leads", doctor: "Dr. Ghada Amer", service: null, branch: null },
  { name: "Madienaty  l Laser l Aug l Leads", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "Madinity" },
  { name: "CFC l Laser l Aug l Leads", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: "CFC" },
  { name: "Dr.Randa | leads | campaign l Aug", obj: "Leads", doctor: "Dr. Randa El Aguizy", service: null, branch: null },
  { name: "Dr Nesma l Zat l Aug l Profile Visits", obj: "Engagement", doctor: "Dr.Nesma Saad", service: null, branch: null },
  { name: "Dr Nesma l Zat l Aug l SM", obj: "Engagement", doctor: "Dr.Nesma Saad", service: null, branch: null },
  { name: "Dr.Mai l Leads l Aug", obj: "Leads", doctor: "Dr. Mai mohsen", service: null, branch: null },
  { name: "Dr.Randa | leads | campaign l Aug l BodyContouring New", obj: "Leads", doctor: "Dr. Randa El Aguizy", service: "Body contouring", branch: null },
  { name: "Laser - Leads 2 – Aug", obj: "Leads", doctor: null, service: "Laser / DEKA", branch: null },
  { name: "SM-Laser l Aug", obj: "Engagement", doctor: null, service: "Laser / DEKA", branch: null }
];

const ADS = [
  { ad: "malak koura", camp: "Pv | Nouvelage | July", doctor: null, service: null, branch: null },
  { ad: "Laser l Hair Removel", camp: "MOA l Laser l Leads l July", doctor: null, service: "Laser / DEKA", branch: "Mall Of Arabia" },
  { ad: "Laser l Hair Removel", camp: "CityStars l Laser l July l Leads", doctor: null, service: "Laser / DEKA", branch: "City Stars" },
  { ad: "offer", camp: "Alex l Leads l July", doctor: null, service: null, branch: "Alexandria" },
  { ad: "lpg", camp: "Nutrition l July l Leads", doctor: null, service: "Nutrition", branch: null },
  { ad: "filler", camp: "Dr.Randa | leads | campaign l July", doctor: "Dr. Randa El Aguizy", service: "Filler", branch: null },
  { ad: "derma", camp: "Dr Poussy l Leads l July", doctor: "Dr. Poussy Maher", service: "Dermapen", branch: null },
  { ad: "Laser l Hair Removel", camp: "Madienaty  l Laser l July l Leads", doctor: null, service: "Laser / DEKA", branch: "Madinity" },
  { ad: "new video", camp: "Dr Ghada l Leads l July", doctor: "Dr. Ghada Amer", service: null, branch: null },
  { ad: "peptides", camp: "Dr Poussy l Leads l July", doctor: "Dr. Poussy Maher", service: "Peptides", branch: null },
  { ad: "lip booster", camp: "Dr.Mai l Leads l July", doctor: "Dr. Mai mohsen", service: "Skin booster", branch: null },
  { ad: "nose filler", camp: "Dr.Randa | leads | campaign l July", doctor: "Dr. Randa El Aguizy", service: "Filler", branch: null },
  { ad: "onda", camp: "Nutrition l July l Leads", doctor: null, service: "Nutrition", branch: null },
  { ad: "offer", camp: "MOA l Laser l Leads l July", doctor: null, service: "Laser / DEKA", branch: "Mall Of Arabia" },
  { ad: "deka", camp: "CityStars l Laser l July l Leads", doctor: null, service: "Laser / DEKA", branch: "City Stars" },
  { ad: "offer2", camp: "CFC l Laser l July l Leads", doctor: null, service: "Laser / DEKA", branch: "CFC" },
  { ad: "peptides", camp: "Dr Ghada l Leads l July", doctor: "Dr. Ghada Amer", service: "Peptides", branch: null },
  { ad: "Q-Switched Laser", camp: "Dr.Mai l Leads l July", doctor: "Dr. Mai mohsen", service: "Laser / DEKA", branch: null },
  { ad: "body contour", camp: "Dr.Randa | leads | campaign l Aug l BodyContouring", doctor: "Dr. Randa El Aguizy", service: "Body contouring", branch: null },
  { ad: "Full-face filler", camp: "dr hussam messages july", doctor: "Dr.Hossam Shehab", service: "Filler", branch: null },
  { ad: "new full filler", camp: "Dr Hossam l Leads l July", doctor: "Dr.Hossam Shehab", service: "Filler", branch: null },
  { ad: "filler b&a 2", camp: "Dr Poussy l SM l Aug l New", doctor: "Dr. Poussy Maher", service: "Filler", branch: null },
  { ad: "lip filler 1", camp: "Dr Poussy l SM l July", doctor: "Dr. Poussy Maher", service: "Filler", branch: null },
  { ad: "botox", camp: "Dr.Mai l Leads l July", doctor: "Dr. Mai mohsen", service: "Botox", branch: null },
  { ad: "offer", camp: "Alex l Leads l Aug", doctor: null, service: null, branch: "Alexandria" },
  { ad: "Laser l Hair Removel", camp: "MOA l Laser l Leads l Aug", doctor: null, service: "Laser / DEKA", branch: "Mall Of Arabia" },
  { ad: "Laser l Hair Removel", camp: "CityStars l Laser l Aug l Leads", doctor: null, service: "Laser / DEKA", branch: "City Stars" },
  { ad: "Laser l Hair Removel", camp: "Madienaty  l Laser l Aug l Leads", doctor: null, service: "Laser / DEKA", branch: "Madinity" },
  { ad: "derma", camp: "Dr Poussy l Leads l Aug", doctor: "Dr. Poussy Maher", service: "Dermapen", branch: null },
  { ad: "filler", camp: "Dr.Randa | leads | campaign l Aug", doctor: "Dr. Randa El Aguizy", service: "Filler", branch: null },
  { ad: "lpg", camp: "Nutrition l Aug l Leads", doctor: null, service: "Nutrition", branch: null },
  { ad: "offer", camp: "CFC l Laser l Aug l Leads", doctor: null, service: "Laser / DEKA", branch: "CFC" },
  { ad: "new video", camp: "Dr Ghada l Leads l Aug", doctor: "Dr. Ghada Amer", service: null, branch: null },
  { ad: "deka", camp: "CityStars l Laser l Aug l Leads", doctor: null, service: "Laser / DEKA", branch: "City Stars" }
];

const byName = new Map(CAMPAIGNS.map((c) => [c.name, c]));

(async () => {
  console.log(`\nevery campaign name resolves as the source pack labelled it (${CAMPAIGNS.length})`);
  let campMismatch = [];
  for (const c of CAMPAIGNS) {
    const got = P.parseCampaign(c.name, c.obj);
    for (const field of ['doctor', 'service', 'branch']) {
      if ((got[field] || null) !== (c[field] || null)) {
        campMismatch.push(`${c.name} \u00b7 ${field}: got ${got[field]} want ${c[field]}`);
      }
    }
  }
  check(`all ${CAMPAIGNS.length} campaigns match on doctor, service and branch`, () => {
    assert.strictEqual(campMismatch.length, 0, `\n        ${campMismatch.join('\n        ')}`);
  });

  console.log(`\nevery ad resolves, inheriting from its campaign where its own name is silent (${ADS.length})`);
  let adMismatch = [];
  for (const a of ADS) {
    const parent = P.parseCampaign(a.camp || '', null);
    const got = P.parseAd(a.ad, parent);
    for (const field of ['doctor', 'service', 'branch']) {
      if ((got[field] || null) !== (a[field] || null)) {
        adMismatch.push(`${a.ad} (in ${a.camp}) \u00b7 ${field}: got ${got[field]} want ${a[field]}`);
      }
    }
  }
  check(`all ${ADS.length} ads match on doctor, service and branch`, () => {
    assert.strictEqual(adMismatch.length, 0, `\n        ${adMismatch.join('\n        ')}`);
  });

  console.log('\nthe orderings that are load-bearing');

  /* The equivalent of the Body Contouring trap: this ad belongs to a filler
     doctor and a filler-heavy campaign, and `filler` must not win. */
  await check('"body contour" is body contouring, not filler', () => {
    assert.strictEqual(P.parseAd('body contour', {}).service, 'Body contouring');
  });
  await check('"nose filler" and "lip filler" are Filler, not something narrower', () => {
    assert.strictEqual(P.parseAd('nose filler', {}).service, 'Filler');
    assert.strictEqual(P.parseAd('lip filler 1', {}).service, 'Filler');
  });
  await check('"lip booster" is Skin booster, NOT Filler', () => {
    /* Both words appear in the filler family; the specific rule has to be first
       or a booster is sold as a filler. */
    assert.strictEqual(P.parseAd('lip booster', {}).service, 'Skin booster');
  });
  await check('"Q-Switched Laser" and "deka" are both the laser family', () => {
    assert.strictEqual(P.parseAd('Q-Switched Laser', {}).service, 'Laser / DEKA');
    assert.strictEqual(P.parseAd('deka', {}).service, 'Laser / DEKA');
  });

  console.log('\none doctor, spelled two ways');
  await check('Hossam and hussam are the same doctor', () => {
    assert.strictEqual(P.parseCampaign('Dr Hossam l Leads l July').doctor, 'Dr.Hossam Shehab');
    assert.strictEqual(P.parseCampaign('dr hussam messages july').doctor, 'Dr.Hossam Shehab');
    assert.strictEqual(P.parseCampaign('SM l Dr Hussam l July').doctor, 'Dr.Hossam Shehab');
  });
  await check('every separator the campaigns actually use is handled', () => {
    for (const n of ['Dr Poussy l Leads', 'Dr.Randa | leads | campaign', 'Dr.Mai l Leads l Aug',
      'Dr Nesma l Zat l Aug l SM']) {
      assert.ok(P.parseCampaign(n).doctor, `no doctor from "${n}"`);
    }
  });
  await check('the doctor names match the spelling Odoo uses', () => {
    /* If these drift, the per-doctor cost table joins to nothing and shows a
       dash for every row while the money sits in Odoo under another spelling. */
    const wanted = new Set(['Dr. Poussy Maher', 'Dr. Randa El Aguizy', 'Dr. Ghada Amer',
      'Dr. Mai mohsen', 'Dr.Nesma Saad', 'Dr.Hossam Shehab']);
    for (const d of P.DOCTORS) assert.ok(wanted.has(d.name), `unexpected doctor spelling: ${d.name}`);
  });

  console.log('\ninheritance \u2014 what an ad name genuinely cannot tell you');
  await check('"offer" takes its service and branch from whichever campaign it sits in', () => {
    const moa = P.parseAd('offer', P.parseCampaign('MOA l Laser l Leads l Aug'));
    const alex = P.parseAd('offer', P.parseCampaign('Alex l Leads l Aug'));
    assert.strictEqual(moa.service, 'Laser / DEKA');
    assert.strictEqual(moa.branch, 'Mall Of Arabia');
    assert.strictEqual(alex.service, null, 'the Alexandria campaign names no service');
    assert.strictEqual(alex.branch, 'Alexandria');
  });
  await check('"lpg" and "onda" are body devices that inherit Nutrition from their campaign', () => {
    const nut = P.parseCampaign('Nutrition l Aug l Leads');
    assert.strictEqual(P.parseAd('lpg', nut).service, 'Nutrition');
    assert.strictEqual(P.parseAd('onda', nut).service, 'Nutrition');
  });
  await check('an inherited field is REPORTED as inherited, not passed off as the ad\'s own', () => {
    const r = P.parseAd('offer', P.parseCampaign('CFC l Laser l Aug l Leads'));
    assert.ok(r.inherited.includes('service'), 'service came from the campaign and must say so');
    assert.ok(r.inherited.includes('branch'));
    const own = P.parseAd('body contour', P.parseCampaign('Dr.Randa | leads | campaign l Aug l BodyContou'));
    assert.ok(!own.inherited.includes('service'), 'this ad names its own service');
  });

  console.log('\nit refuses to guess');
  await check('an unrecognised name returns null on every field, not a nearest match', () => {
    for (const n of ['malak koura', 'new video', 'offer2', 'zzz unknown thing', '', null, undefined]) {
      const r = P.parseAd(n, {});
      assert.strictEqual(r.doctor, null, `${n} \u2192 doctor ${r.doctor}`);
      assert.strictEqual(r.service, null, `${n} \u2192 service ${r.service}`);
      assert.strictEqual(r.branch, null, `${n} \u2192 branch ${r.branch}`);
    }
  });
  await check('a campaign that names nothing resolves to nothing', () => {
    const r = P.parseCampaign('Pv | Nouvelage | Aug');
    assert.strictEqual(r.doctor, null);
    assert.strictEqual(r.service, null);
    assert.strictEqual(r.branch, null);
    assert.strictEqual(r.confidence, 0);
  });
  await check('a partial name gives only what it says', () => {
    const r = P.parseCampaign('Dr Ghada l Leads l Aug');
    assert.strictEqual(r.doctor, 'Dr. Ghada Amer');
    assert.strictEqual(r.service, null, 'this campaign names no service');
    assert.strictEqual(r.branch, null);
    assert.strictEqual(r.confidence, 1);
  });

  console.log('\nthe objective');
  await check('Meta\'s own objective wins over the name', () => {
    /* The field is a fact; the name is a guess at the same thing. */
    assert.strictEqual(P.parseCampaign('Dr Mai l profile visits l July', 'Leads').objective, 'Leads');
  });
  await check("Meta's codes are translated, not printed raw", () => {
    /* `OUTCOME_LEADS` in a column headed "Objective" is Meta's internal
       vocabulary leaking onto a page the clinic reads. Verified against the live
       pull: for all 39 campaigns that spent in the frozen report's window, the
       report's label and Meta's code agree one-for-one. */
    const via = (code) => P.parseCampaign('Dr Mai l x l Aug', code).objective;
    assert.strictEqual(via('OUTCOME_LEADS'), 'Leads');
    assert.strictEqual(via('OUTCOME_TRAFFIC'), 'Traffic');
    assert.strictEqual(via('OUTCOME_ENGAGEMENT'), 'Engagement');
    /* Never ran in the report's nineteen days, but 1.15M of spend across the
       fifteen months — a range containing it must name it. */
    assert.strictEqual(via('OUTCOME_SALES'), 'Sales');
    assert.strictEqual(via('OUTCOME_AWARENESS'), 'Awareness');
    /* Campaigns started before Meta's ODAX renaming still carry the old codes. */
    assert.strictEqual(via('MESSAGES'), 'Engagement');
    assert.strictEqual(via('LEAD_GENERATION'), 'Leads');
  });
  await check('a code we have never seen is shown, not swallowed', () => {
    /* Returning null would silently empty the column and we would never learn
       that Meta added an objective. */
    assert.strictEqual(P.parseCampaign('x', 'OUTCOME_SOMETHING_NEW').objective,
      'OUTCOME_SOMETHING_NEW');
  });
  await check('and the name is used when Meta gives none', () => {
    assert.strictEqual(P.parseCampaign('Dr Mai l profile visits l July', null).objective, 'Traffic');
    assert.strictEqual(P.parseCampaign('Pv | Nouvelage | Aug', '').objective, 'Traffic');
    assert.strictEqual(P.parseCampaign('Dr Poussy l SM l Aug l New', null).objective, 'Engagement');
  });

  console.log('\nlead forms');
  await check('the real form names resolve to their doctor', () => {
    assert.strictEqual(P.parseLeadForm('dr mai').doctor, 'Dr. Mai mohsen');
    assert.strictEqual(P.parseLeadForm('dr\\poussy').doctor, 'Dr. Poussy Maher');
    assert.strictEqual(P.parseLeadForm('Dr.RANDA ELAGUIZY- modified-copy').doctor, 'Dr. Randa El Aguizy');
  });
  await check('an unnamed form gives no doctor', () => {
    assert.strictEqual(P.parseLeadForm('Untitled form').doctor, null);
    assert.strictEqual(P.parseLeadForm(null).doctor, null);
  });

  console.log(failures ? `\n\u001b[31m${failures} failed\u001b[0m\n` : '\n\u001b[32mall passed\u001b[0m\n');
  process.exit(failures ? 1 : 0);
})();
