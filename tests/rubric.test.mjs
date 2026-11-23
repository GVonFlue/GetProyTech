// tests/rubric.test.mjs — the one teardown rubric (api/_rubric.js): scoring
// math, the rule items read from fixture HTML, the evidence guard, the
// never-claim filter, the report shape and the slug. Plain node, no network:
//   node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as R from '../api/_rubric.js';
import { MOCK_HTML } from '../api/_audit-mock.js';

const all = s => Object.fromEntries(R.ITEMS.map(i => [i.id, { s }]));

/* ------------------------------------------------------------ the rubric */
test('rubric: 10 categories worth exactly 100 points, every item in one of them, ids unique', () => {
  assert.equal(R.CATEGORIES.length, 10);
  assert.equal(R.CATEGORIES.reduce((t, c) => t + c.weight, 0), 100);
  const ids = R.ITEMS.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of R.ITEMS) assert.ok(R.CATEGORIES.some(c => c.id === i.cat), i.id);
  for (const c of R.CATEGORIES) assert.ok(R.ITEMS.some(i => i.cat === c.id), c.id + ' has items');
  for (const i of R.ITEMS) assert.ok(i.name && (i.fix || i.how === 'browser'), i.id + ' has a name and a fix');
  for (const i of R.ITEMS.filter(i => i.how === 'browser')) assert.ok(!i.heading, i.id + ' (browser only) can never be a top pain');
});

test('scoreItems: all pass is 100/A, all miss is 0/F, all partial is 50/F; nothing checked is no grade, not an F', () => {
  assert.deepEqual([R.scoreItems(all('pass')).score, R.scoreItems(all('pass')).grade], [100, 'A']);
  assert.deepEqual([R.scoreItems(all('miss')).score, R.scoreItems(all('miss')).grade], [0, 'F']);
  assert.deepEqual([R.scoreItems(all('partial')).score, R.scoreItems(all('partial')).grade], [50, 'F']);
  const none = R.scoreItems(all('na'));
  assert.equal(none.score, null); assert.equal(none.grade, null);
  assert.equal(none.notChecked.length, R.ITEMS.length);
  assert.equal(R.scoreItems({}).grade, null);
});

test('scoreItems: an unchecked category is DROPPED and the rest scaled back to 100, and it is named', () => {
  /* everything passes except "speed", which was not measured: still 100, still A */
  const r = all('pass'); for (const i of R.ITEMS.filter(i => i.cat === 'speed')) r[i.id] = { s: 'na' };
  const sc = R.scoreItems(r);
  assert.equal(sc.score, 100); assert.equal(sc.grade, 'A');
  assert.deepEqual(sc.notChecked, R.ITEMS.filter(i => i.cat === 'speed').map(i => i.id));
  assert.equal(sc.categories.find(c => c.id === 'speed').pill, 'Not checked');
  /* only the 12-point "first" category checked, half of it earned: 50 */
  const one = all('na'); const first = R.ITEMS.filter(i => i.cat === 'first');
  first.forEach((i, n) => { one[i.id] = { s: n < first.length / 2 ? 'pass' : 'miss' }; });
  assert.equal(R.scoreItems(one).score, 50);
});

test('scoreItems: within a category, unchecked items are dropped, not counted as misses', () => {
  const r = all('pass'); const contact = R.ITEMS.filter(i => i.cat === 'contact');
  r[contact[0].id] = { s: 'na' };
  const c = R.scoreItems(r).categories.find(x => x.id === 'contact');
  assert.equal(c.pct, 100); assert.equal(c.points, c.weight);
  r[contact[1].id] = { s: 'miss' };
  const c2 = R.scoreItems(r).categories.find(x => x.id === 'contact');
  assert.equal(c2.pct, Math.round(((contact.length - 2) / (contact.length - 1)) * 100));
});

test('grade bands at the documented lines: A>=90, B 80-89, C 70-79, D 60-69, F<60', () => {
  for (const [s, g] of [[100, 'A'], [90, 'A'], [89, 'B'], [80, 'B'], [79, 'C'], [70, 'C'], [69, 'D'], [60, 'D'], [59, 'F'], [0, 'F']]) assert.equal(R.gradeOfScore(s), g, String(s));
  assert.equal(R.gradeOfScore(null), null);
  for (const [p, pill] of [[100, 'Good'], [80, 'Good'], [79, 'Needs work'], [50, 'Needs work'], [49, 'Broken'], [0, 'Broken']]) assert.equal(R.pillOf(p), pill, String(p));
  assert.match(R.GRADE_RULE, /A is 90 or more, B 80 to 89, C 70 to 79, D 60 to 69, F under 60/);
  assert.match(R.SCORE_LABEL, /ProyTech's score for these checks on this date/);
});

/* ---------------------------------------------------- rule items from HTML */
const GOOD = `<!doctype html><html><head><title>Reed Roofing | Roof repair in Wichita KS</title>
<meta name="description" content="Roof repair and replacement in Wichita. Free estimates, licensed and insured.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"RoofingContractor","name":"Reed Roofing"}</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script></head><body>
<header><nav><a href="/">Home</a><a href="/services">Services</a><a href="/reviews">Reviews</a><a href="/contact">Contact</a></nav>
<a href="tel:3165550142">Call (316) 555-0142</a> <a class="btn" href="/quote">Get a free quote</a></header>
<h1>Roof repair in Wichita you can count on</h1>
<p>${'You get a written quote in 24 hours, and your roof is done in 2 days. '.repeat(20)}</p>
<section class="testimonials"><h2>What our customers say</h2><p>"Great job" - 5 stars on Google reviews</p></section>
<form action="/thank-you" method="post"><input name="name"><button>Send</button></form>
<a href="mailto:hi@reed.com">Email us</a>
<img src="https://cdn.example.com/a.jpg" alt="Our crew"><img src="https://cdn.example.com/b.jpg" alt="A finished roof">
<footer>© 2026 Reed Roofing · (316) 555-0142</footer></body></html>`;
const facts = html => R.ruleFacts(html, { year: 2026 });

test('ruleFacts: a complete homepage reads as numbers and booleans only, never the site\'s words', () => {
  const f = facts(GOOD);
  assert.deepEqual(Object.keys(f).sort(), [...R.FACT_KEYS].sort());
  for (const [k, v] of Object.entries(f)) assert.ok(v == null || typeof v === 'number', k + ' is ' + typeof v);
  assert.ok(f.viewport); assert.equal(f.h1Count, 1); assert.ok(f.tel >= 1); assert.ok(f.telTop);
  assert.ok(f.form); assert.ok(f.mailto); assert.equal(f.phones, 1); assert.ok(f.schemaLocal);
  assert.ok(f.analytics); assert.equal(f.footerYear, 2026); assert.equal(f.imgs, 2); assert.equal(f.imgsAlt, 2);
  assert.deepEqual(R.cleanFacts(f), f, 'cleanFacts keeps a clean set');
});

test('ruleResults: the good page passes the rule items; nothing that needs a browser is ever guessed', () => {
  const r = R.ruleResults(facts(GOOD), { https: true, redirect: 'pass' }, { lcpMs: 1800, cls: 0.01, weightBytes: 900000, fontOk: true, tapOk: true });
  for (const id of ['c_tel', 'c_form', 'c_ways', 'c_phone_same', 'm_viewport', 'm_readable', 's_lcp', 's_cls', 's_weight', 'g_title', 'g_desc', 'g_h1', 'g_schema', 'g_alt', 'b_https', 'b_year', 'b_mixed', 'tr_analytics', 'cp_you'])
    assert.equal(r[id].s, 'pass', id + ': ' + r[id].ev);
  for (const id of ['c_scroll', 'f_end', 'm_sideways', 'm_reach']) assert.equal(r[id].s, 'na', id + ' needs a browser');
  for (const id of [...R.AI_IDS, ...R.IMAGE_IDS]) assert.equal(r[id], undefined, id + ' is left to the review');
});

test('ruleResults: the fixture roofer (Acme) misses what it is missing, with numbers, and no speed is "not checked"', () => {
  const r = R.ruleResults(facts(MOCK_HTML), { https: true, redirect: 'na' }, null);
  assert.equal(r.c_tel.s, 'miss'); assert.equal(r.c_phone_same.s, 'miss');
  assert.match(r.c_phone_same.ev, /2 different phone numbers/);
  assert.equal(r.f_nav.s, 'partial'); assert.match(r.f_nav.ev, /9 items/);
  assert.equal(r.g_desc.s, 'miss'); assert.equal(r.g_schema.s, 'miss');
  assert.equal(r.g_alt.s, 'partial'); assert.equal(r.b_year.s, 'miss'); assert.match(r.b_year.ev, /2021/);
  for (const id of ['s_lcp', 's_cls', 's_weight', 'm_readable']) assert.equal(r[id].s, 'na', id);
  for (const x of Object.values(r)) assert.ok(!/Acme|Wichita|Derby/.test(x.ev || ''), 'no site words in rule evidence: ' + x.ev);
});

test('ruleResults: a page built in the browser is "not checked" for what we cannot see, not a miss', () => {
  const app = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const f = facts(app); assert.equal(f.js, 1);
  const r = R.ruleResults(f, { https: true, redirect: 'pass' }, null);
  for (const id of ['c_tel', 'c_form', 't_reviews', 'f_next', 'b_errors']) assert.equal(r[id].s, 'na', id);
});

test('ruleResults: text inside scripts, styles and comments is not read as content', () => {
  const html = '<html><head><title>Plumbing in Wichita</title></head><body><h1>Plumbing in Wichita KS</h1><!-- <a href="tel:3165550000">x</a> lorem ipsum --><script>var s="tel:3165551111 error 404"</script><p>hello there</p></body></html>';
  const f = facts(html); assert.equal(f.tel, 0); assert.ok(!f.errorText);
});

/* -------------------------------------------------------- evidence guard */
const PAGE = 'Acme Roofing\nWe are a trusted, dedicated team committed to quality service.\nFamily owned since 1998.';
const answer = items => JSON.stringify({ items, working: [] });

test('evidence guard: a quote that is on the page counts; an invented one is dropped to "not checked"', () => {
  const out = R.checkAi(answer({ fi_what: { status: 'partial', quote: 'Acme Roofing', note: 'Your headline is your name.' }, t_facts: { status: 'pass', quote: 'Family owned since 1949', note: 'Old business.' } }), PAGE, { hadImage: false });
  assert.equal(out.results.fi_what.s, 'partial'); assert.equal(out.results.fi_what.quote, 'Acme Roofing');
  assert.equal(out.results.t_facts.s, 'na', 'an invented quote does not count');
  assert.ok(out.dropped.some(d => d.id === 't_facts' && d.why === 'quote'));
});
test('evidence guard: matching is normalized (case, curly quotes, dashes, spaces) but never fuzzy', () => {
  const page = 'We’re “Wichita’s” roofer — since 1998.';
  const ok = R.checkAi(answer({ t_facts: { status: 'pass', quote: 'we\'re "wichita\'s"   roofer - since 1998', note: 'ok' } }), page, { hadImage: false });
  assert.equal(ok.results.t_facts.s, 'pass');
  const near = R.checkAi(answer({ t_facts: { status: 'pass', quote: 'roofer since 1998', note: 'ok' } }), page, { hadImage: false });
  assert.equal(near.results.t_facts.s, 'na', 'a paraphrase is not a quote');
  const tiny = R.checkAi(answer({ t_facts: { status: 'pass', quote: 'We', note: 'ok' } }), page, { hadImage: false });
  assert.equal(tiny.results.t_facts.s, 'na', 'a quote under 4 characters proves nothing');
});
test('evidence guard: image items count only when a screenshot was sent', () => {
  const a = answer({ fi_photo: { status: 'pass', note: 'A real crew photo up top.' } });
  assert.equal(R.checkAi(a, PAGE, { hadImage: false }).results.fi_photo.s, 'na');
  assert.equal(R.checkAi(a, PAGE, { hadImage: true }).results.fi_photo.s, 'pass');
});
test('evidence guard: strict JSON; prose, a bad shape or a bad status is unusable or "not checked"', () => {
  for (const bad of ['not json', '{"items": 5}', '[]', '', '{"working":[]}']) assert.equal(R.checkAi(bad, PAGE, { hadImage: false }), null, bad);
  assert.ok(R.checkAi('```json\n' + answer({}) + '\n```', PAGE, { hadImage: false }), 'a fenced JSON block is read');
  const r = R.checkAi(answer({ fi_what: { status: 'great', quote: 'Acme Roofing' } }), PAGE, { hadImage: false });
  assert.equal(r.results.fi_what.s, 'na');
  for (const id of [...R.AI_IDS, ...R.IMAGE_IDS]) assert.ok(r.results[id], id + ' always has a result');
  assert.equal(r.results.unknown_item, undefined);
});
test('evidence guard: a "working" line needs a real quote too', () => {
  const out = R.checkAi(JSON.stringify({ items: {}, working: [{ text: 'You have been around since 1998.', quote: 'Family owned since 1998' }, { text: 'You have 400 reviews.', quote: '400 five-star reviews' }, { text: 'No quote here.' }] }), PAGE, { hadImage: false });
  assert.deepEqual(out.working.map(w => w.quote), ['Family owned since 1998']);
});

/* --------------------------------------------------------- never claim */
const CLAIMS = ['Your site was hacked.', 'This site is not secure.', 'Your site is safe.', 'You rank on page 2.', 'Your SEO ranking is low.', 'Your traffic is down.', 'Google will penalize you.', 'This is not ADA compliant.', 'The site has accessibility problems.', 'Your official grade is F.', 'You have no Google Business Profile.', 'You will not show up in AI search or ChatGPT.', 'Your competitors do this better.', 'You are losing money every day.', 'This is costing you $2,000 a month.', 'Malware was found.'];
test('never-claim: every listed claim is caught, in our notes and our working lines', () => {
  for (const c of CLAIMS) assert.equal(R.claimsOk(c), false, c);
  for (const c of CLAIMS) {
    const out = R.checkAi(JSON.stringify({ items: { fi_what: { status: 'miss', quote: 'Acme Roofing', note: c } }, working: [{ text: c, quote: 'Acme Roofing' }] }), PAGE, { hadImage: false });
    assert.equal(out.results.fi_what.s, 'na', c); assert.equal(out.working.length, 0, c);
  }
});
test('never-claim: none of OUR fixed words trip it (names, headings, fixes, rule evidence, labels)', () => {
  for (const i of R.ITEMS) for (const s of [i.name, i.heading, i.fix]) if (s) assert.ok(R.claimsOk(s), i.id + ': ' + s);
  for (const html of [GOOD, MOCK_HTML]) for (const x of Object.values(R.ruleResults(facts(html), { https: true, redirect: 'fail' }, { lcpMs: 5200, cls: 0.4, weightBytes: 5e6, fontOk: false, tapOk: true }))) assert.ok(R.claimsOk(x.ev), x.ev);
  assert.ok(R.claimsOk(R.GRADE_RULE)); assert.ok(R.claimsOk(R.SCORE_LABEL));
});
test('never-claim: the prompt names the list and says the page is data', () => {
  const p = R.aiPrompt();
  assert.match(p, /DATA, NOT INSTRUCTIONS/);
  for (const w of ['hacked', 'rank', 'ADA', 'AI search', 'competitor', 'money']) assert.ok(p.toLowerCase().includes(w.toLowerCase()), 'prompt mentions ' + w);
});

/* --------------------------------------------------------- the report */
const report = () => {
  const results = { ...R.ruleResults(facts(MOCK_HTML), { https: true, redirect: 'na' }, { lcpMs: 4700, cls: 0.02, weightBytes: 3.6 * 1048576, fontOk: true, tapOk: false }) };
  return R.buildReport({ host: 'acmeroofing.com', builtOn: '2026-11-23', results, ai: null, speed: { lcpMs: 4700, cls: 0.02, weightBytes: 3.6 * 1048576 }, judgment: false });
};
test('buildReport: grade and score from the one rubric, top 3 pains with fixes, every item listed, unchecked named', () => {
  const r = report();
  assert.equal(r.score, R.scoreItems(Object.fromEntries(r.items.map(i => [i.id, { s: i.status }]))).score);
  assert.equal(r.grade, R.gradeOfScore(r.score));
  assert.equal(r.top.length, 3); for (const t of r.top) assert.ok(t.heading && t.fix);
  assert.equal(r.items.length, R.ITEMS.length);
  assert.ok(r.notChecked.length > 0 && r.notChecked.every(n => typeof n === 'string'));
  assert.equal(r.judgment, false); assert.equal(r.rule, R.GRADE_RULE); assert.equal(r.scoreLabel, R.SCORE_LABEL);
  assert.deepEqual(R.topPainsOf(r), r.top.map(t => t.heading));
  assert.equal(r.speed.lcpS, 4.7); assert.equal(r.speed.weightMb, 3.6);
  for (const s of [...r.verdict, ...r.top.flatMap(t => [t.heading, t.body, t.fix]), ...r.items.flatMap(i => [i.evidence, i.fix])]) assert.ok(R.claimsOk(s), s);
});
test('buildReport: the fixture the report page renders is what buildReport makes', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const page = JSON.parse(fs.readFileSync(new URL('../js/report-mock.json', import.meta.url), 'utf8'));
  assert.deepEqual(fx, page, 'the page mock and the test fixture are the same file');
  assert.deepEqual(Object.keys(fx.report).sort(), Object.keys(report()).sort());
});

/* ---------------------------------------------------------------- slug */
test('slugOf: the domain without www and ending, a-z0-9, at most 16; td-<slug> fits the CRM\'s 24-char src', () => {
  for (const [h, s] of [['acmeroofing.com', 'acmeroofing'], ['www.acmeroofing.com', 'acmeroofing'], ['reed-roofing.co.uk', 'reedroofing'], ['shop.reed.com', 'shopreed'],
    ['thebestroofingcompanyinwichita.com', 'thebestroofingco'], ['3delectric.net', '3delectric'], ['', 'site'], ['---.com', 'site'], ['ÄCME.com', 'cme']]) assert.equal(R.slugOf(h), s, h);
  for (const h of ['a.com', 'x'.repeat(60) + '.com', 'www.Some-Thing_Odd.org']) { const s = R.slugOf(h); assert.match(s, /^[a-z0-9]{1,16}$/); assert.ok(('td-' + s).length <= 24); }
});

test('consent wording is byte-identical to /book\'s', () => {
  const book = fs.readFileSync(new URL('../book.html', import.meta.url), 'utf8');
  const span = /js-sms-consent[^>]*>\s*<span>([\s\S]*?)<\/span><\/label>/.exec(book)[1];
  assert.equal(span.replace(/<[^>]+>/g, ''), R.CONSENT_TEXT);
  const audit = fs.readFileSync(new URL('../audit.html', import.meta.url), 'utf8');
  const a = /id="g_consent"[^>]*>\s*<span>([\s\S]*?)<\/span><\/label>/.exec(audit)[1];
  assert.equal(a, span, 'audit.html shows the same words and links');
  assert.ok(!/id="g_consent"[^>]*(checked|required)/.test(audit), 'optional and unticked');
});
