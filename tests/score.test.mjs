// tests/score.test.mjs — the Business Nucleus Score: api/score.js, score.html
// and the handoff into book.html. Plain node, no dependencies; the CRM is a
// stubbed fetch. The key below is a test value, not a secret.
//
// What is asserted:
//   the key     read from CRM_SCORE_SITE_KEY only; unset or malformed, the
//               visitor is told to try again later and NOTHING is sent; it is
//               never in the page, the repo, a response or a log
//   what goes   exactly the answers by id, the contact details, the fixed
//               source, src as its own field and the consent; never a number,
//               a track or anything else the browser added
//   what comes  the result and nothing else (no lead id, no echo)
//   the trap    the honeypot and a missing answer send nothing
//   no script   a plain form post gets an HTML page back
//   the page    posts to /api/score without JavaScript, asks the nine
//               questions by the CRM's ids, words the consent box as /book
//               does, tracks two listed events, and puts nothing personal in
//               a URL: the handoff to /book is sessionStorage, read once
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import handler, { KEY_ENV, CRM_URL, SOURCE, FORM, HONEYPOT, QUESTIONS, CONSENT_TEXT, LATER, siteKey, payload, cleanResult, resultHtml } from '../api/score.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const KEY = 'pts_' + 'k'.repeat(43);
const ANSWERS = { leads: 'one_source', speed: 'same_day', followup: 'one_try', website: 'few', reviews: 'under_10', booking: 'link', revenue: '250k_1m', teamSize: '2_5', want: 'website_system' };
const SUB = (o = {}) => ({ firstName: 'Sam', lastName: 'Reed', phone: '(316) 555-0101', email: 'Sam@Reed.test', src: 'IG-Post', fax: '', textConsent: true, ...ANSWERS, ...o });
const RESULT = { total: 44, band: 'At risk', weak: [{ label: 'Reviews', line: 'Too few reviews.' }, { label: 'Follow-up', line: 'Leads are lost.' }, { label: 'Speed to answer', line: 'Leads wait.' }], track: { name: 'growth_os', label: 'Growth OS' } };
const ENV_KEYS = [KEY_ENV, 'SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_LIMIT_SALT'];
const realFetch = globalThis.fetch;

/** Run one request with exactly `env` set and the CRM played by `crm`. */
async function hit(body, { env = { [KEY_ENV]: KEY }, crm = () => ({ status: 200, json: { ok: true, id: 'lead-123', attached: false, result: RESULT } }), type = 'application/json' } = {}) {
  const old = {}; for (const k of ENV_KEYS) { old[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const calls = [], logs = [], origErr = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const a = crm(call);
    if (a.throws) throw new Error('ECONNRESET');
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
  const res = { code: 0, body: null, html: null, headers: {} };
  res.status = c => { res.code = c; return res; }; res.json = b => { res.body = b; return res; }; res.send = h => { res.html = h; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; }; res.end = () => res;
  try { await handler({ method: 'POST', headers: { 'content-type': type, 'x-forwarded-for': '10.1.1.1' }, socket: {}, body }, res); }
  finally { console.error = origErr; globalThis.fetch = realFetch; for (const k of ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  return { res, calls, logs, all: JSON.stringify([res.body, res.html, logs]) };
}

test('THE KEY UNSET: "try again later", and nothing is sent anywhere', async () => {
  for (const env of [{}, { [KEY_ENV]: '' }, { [KEY_ENV]: '   ' }, { [KEY_ENV]: 'not-a-site-key' }, { [KEY_ENV]: 'pts_short' }]) {
    const w = await hit(SUB(), { env });
    assert.equal(w.res.code, 503);
    assert.deepEqual(w.res.body, { ok: false, error: LATER });
    assert.equal(w.calls.length, 0, 'a request left the function with no key');
    assert.ok(w.logs.some(l => l.includes(KEY_ENV)), 'the log names the missing setting');
  }
  assert.match(LATER, /try again later/i);
  assert.equal(KEY_ENV, 'CRM_SCORE_SITE_KEY');
  assert.equal(siteKey({ [KEY_ENV]: ` ${KEY}\n` }), KEY, 'a pasted trailing newline does not break a good key');
});

test('THE KEY: sent only as the bearer to the CRM, never in a response or a log', async () => {
  const w = await hit(SUB());
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].url, CRM_URL);
  assert.equal(CRM_URL, 'https://proytech-crm.vercel.app/api/site-lead');
  assert.equal(w.calls[0].method, 'POST');
  assert.equal(w.calls[0].headers.authorization, 'Bearer ' + KEY);
  assert.ok(!JSON.stringify(w.calls[0].body).includes(KEY), 'the key is in the body');
  assert.ok(!w.all.includes(KEY) && !w.all.includes('pts_'), 'the key reached a response or a log');
  for (const bad of [{ status: 500, json: { error: 'x' } }, { status: 401, json: { ok: false, error: 'Unknown or revoked site key.' } }, { throws: true }]) {
    const f = await hit(SUB(), { crm: () => bad });
    assert.ok(!f.all.includes(KEY), 'the key reached a response or a log on failure');
  }
});

test('THE KEY IS NOT IN THE PAGE OR THE REPO', () => {
  for (const f of ['score.html', 'api/score.js', 'book.html', 'js/analytics.js']) assert.doesNotMatch(read(f), /pts_[A-Za-z0-9_-]{20,}/, f);
  assert.doesNotMatch(read('score.html'), /CRM_SCORE_SITE_KEY|site-lead|authorization/i, 'the page knows nothing about the key or the CRM door');
  assert.match(read('api/score.js'), /String\(env\[KEY_ENV\] \|\| ''\)/);
});

test('WHAT GOES TO THE CRM: answers by id, contact details, the fixed source, src and consent, and nothing else', async () => {
  const w = await hit(SUB());
  assert.deepEqual(w.calls[0].body, {
    kind: 'lead', source: 'Business Nucleus Score', form: 'score', page: '/score',
    name: 'Sam Reed', email: 'sam@reed.test', phone: '(316) 555-0101',
    score: ANSWERS, src: 'ig-post', textConsent: true, consentText: CONSENT_TEXT,
  });
  assert.equal(SOURCE, 'Business Nucleus Score'); assert.equal(FORM, 'score');
  assert.deepEqual(QUESTIONS, ['leads', 'speed', 'followup', 'website', 'reviews', 'booking', 'revenue', 'teamSize', 'want']);
});

test('THE PAGE CANNOT SEND A SCORE: a number, a track or a source in the request goes nowhere', async () => {
  const w = await hit(SUB({ total: 100, score: { total: 100 }, band: 'Strong', track: 'empire_os', source: 'Google Ads', kind: 'count', result: RESULT, consentText: 'I agree to anything' }));
  const b = w.calls[0].body;
  assert.deepEqual(Object.keys(b).sort(), ['consentText', 'email', 'form', 'kind', 'name', 'page', 'phone', 'score', 'source', 'src', 'textConsent']);
  assert.deepEqual(b.score, ANSWERS, 'only the nine answers are in score');
  assert.equal(b.source, 'Business Nucleus Score'); assert.equal(b.kind, 'lead'); assert.equal(b.consentText, CONSENT_TEXT);
  assert.ok(!/100|Strong|empire_os|Google Ads/.test(JSON.stringify(b)));
  assert.doesNotMatch(read('api/score.js'), /\bpoints\s*[:=]|\+=|reduce\(/, 'this function does no arithmetic on answers');
});

test('CONSENT: wording goes only beside a yes; unticked is a plain no', async () => {
  for (const v of [false, undefined, '', '0', 'no']) {
    const b = (await hit(SUB({ textConsent: v }))).calls[0].body;
    assert.equal(b.textConsent, false); assert.ok(!('consentText' in b), 'wording was sent beside a no');
  }
  for (const v of [true, '1', 'on']) assert.equal((await hit(SUB({ textConsent: v }))).calls[0].body.textConsent, true);
});

test('src rides as its own cleaned field; absent, it is empty, never a guess', async () => {
  assert.equal((await hit(SUB({ src: '<b>Text_1</b> and more words here' }))).calls[0].body.src, 'btext_1bandmorewordshere');
  assert.equal((await hit(SUB({ src: undefined }))).calls[0].body.src, '');
});

test('WHAT COMES BACK: the result and nothing else', async () => {
  const w = await hit(SUB());
  assert.equal(w.res.code, 200);
  assert.deepEqual(w.res.body, { ok: true, result: RESULT });
  assert.ok(!w.all.includes('lead-123'), 'the lead id reached the browser');
  assert.ok(!/reed\.test|555-0101/i.test(JSON.stringify(w.res.body)), 'contact details were echoed');
  assert.equal(w.res.headers['cache-control'], 'no-store');
  const noisy = await hit(SUB(), { crm: () => ({ status: 200, json: { ok: true, id: 'x', result: { ...RESULT, answers: ANSWERS, email: 'a@b.test', weak: [...RESULT.weak, { label: 'Fourth', line: 'x' }, { label: '', line: 'y' }] } } }) });
  assert.deepEqual(noisy.res.body.result, RESULT, 'extra fields and a fourth weak area were passed through');
  assert.equal(cleanResult({ ...RESULT, total: 144 }), null);
  assert.equal(cleanResult({ ...RESULT, track: { name: '<script>' } }), null);
});

test('A MISSING ANSWER, A BAD EMAIL OR PHONE: 400 naming it, nothing sent', async () => {
  for (const [over, field] of [[{ speed: '' }, 'speed'], [{ want: undefined }, 'want'], [{ revenue: '$1M a year' }, 'revenue'], [{ email: 'sam at reed' }, 'email'], [{ phone: '555-0101' }, 'phone'], [{ firstName: ' ' }, 'firstName'], [{ lastName: '' }, 'lastName']]) {
    const w = await hit(SUB(over));
    assert.equal(w.res.code, 400, field);
    assert.ok(w.res.body.fields.includes(field), field);
    assert.equal(w.calls.length, 0, field + ': something was sent');
  }
  assert.equal(payload(SUB({ phone: '+1 (316) 555-0101' })).ok, true, 'a leading 1 is fine');
});

test('THE HONEYPOT, as on /book: answered like a success, nothing sent, no result', async () => {
  assert.equal(HONEYPOT, 'fax');
  const w = await hit(SUB({ fax: '316-555-0000' }));
  assert.equal(w.res.code, 200); assert.deepEqual(w.res.body, { ok: true, result: null }); assert.equal(w.calls.length, 0);
  assert.match(read('score.html'), /<div class="hp" aria-hidden="true"><label for="s_fax">Fax<\/label><input type="text" id="s_fax" name="fax" tabindex="-1" autocomplete="off"><\/div>/);
});

test('THE CRM SAYS NO: its named fields are passed on; anything else is "try again later"', async () => {
  const bad = await hit(SUB(), { crm: () => ({ status: 400, json: { ok: false, error: 'Unknown or missing answer: speed.', fields: ['speed', '<img>', 'email'] } }) });
  assert.equal(bad.res.code, 400); assert.deepEqual(bad.res.body.fields, ['speed', 'email']);
  for (const crm of [() => ({ status: 500, json: {} }), () => ({ status: 401, json: { ok: false } }), () => ({ status: 429, json: { ok: false } }), () => ({ status: 200, json: { ok: true } }), () => ({ status: 200, json: null }), () => ({ throws: true })]) {
    const w = await hit(SUB(), { crm });
    assert.equal(w.res.code, 502); assert.deepEqual(w.res.body, { ok: false, error: LATER });
  }
});

test('RATE LIMITED with the site\'s own guard, before anything else', () => {
  const s = read('api/score.js');
  assert.match(s, /import \{ guard, sweep \} from '\.\/_guard\.js';/);
  const h = s.indexOf('export default async function handler');
  assert.ok(s.indexOf("await guard(req, res, { name: 'score'", h) > h && s.indexOf("await guard(req, res, { name: 'score'", h) < s.indexOf('siteKey()', h));
  assert.match(s, /if \(!gate\.ok\) return;/);
});

test('JAVASCRIPT OFF: a plain form post gets an HTML page back', async () => {
  const form = 'application/x-www-form-urlencoded';
  const w = await hit(SUB({ textConsent: '1', src: 'ig' }), { type: form });
  assert.equal(w.res.code, 200); assert.equal(w.res.body, null);
  assert.match(w.res.headers['content-type'], /text\/html/);
  assert.match(w.res.html, />44<small[^>]*> out of 100<\/small>/);
  assert.ok(['Reviews', 'Follow-up', 'Speed to answer', 'Growth OS', 'At risk'].every(t => w.res.html.includes(t)));
  assert.match(w.res.html, /<a class="btn btn-o" href="\/book\?src=ig">Book your Nucleus Session<\/a>/);
  assert.ok(!/reed\.test|555-0101|Sam/i.test(w.res.html), 'the page echoes who they are');
  assert.equal(w.calls[0].body.textConsent, true);
  const off = await hit(SUB(), { type: form, env: {} });
  assert.equal(off.res.code, 503); assert.ok(off.res.html.includes(LATER)); assert.equal(off.calls.length, 0);
  const miss = await hit(SUB({ speed: '' }), { type: form });
  assert.equal(miss.res.code, 400); assert.match(miss.res.html, /Some answers are missing/); assert.match(miss.res.html, /href="\/score"/);
  assert.ok(!resultHtml({ ...RESULT, band: '<img src=x onerror=alert(1)>', weak: [{ label: '<b>x</b>', line: '"q"' }] }, 'ig').includes('<img'), 'CRM text is escaped');
  assert.match(resultHtml(RESULT, ''), /href="\/book\?src=score"/, 'no src: the link says it came from the score');
});

/* ---- the page ---------------------------------------------------------------- */
/* The answer ids the CRM knows (proytech-crm src/lib/nucleusscore.js
   SCORE_DEFAULTS, lib/nucleus REVENUE_RANGES and WANTS). Two repos cannot
   share a file, so the list is pinned here: change one, change the other.
   A drift is not silent in production either: the CRM refuses an unknown id
   by question name. */
const IDS = {
  leads: ['word_of_mouth', 'one_source', 'two_sources', 'tracked'],
  speed: ['five_min', 'hour', 'same_day', 'next_day', 'never'],
  followup: ['let_go', 'one_try', 'by_hand', 'sequence'],
  website: ['none', 'nothing', 'few', 'steady'],
  reviews: ['under_10', 'some', 'many', 'automatic'],
  booking: ['call', 'back_forth', 'link', 'online'],
  revenue: ['under_50k', '50k_250k', '250k_1m', '1m_3m', '3m_10m', 'over_10m'],
  teamSize: ['just_me', '2_5', '6_15', '16_50', 'over_50'],
  want: ['website', 'website_system', 'scale'],
};
const page = read('score.html');
const inline = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));

test('THE PAGE: nine questions, by the CRM\'s ids, each answerable without JavaScript', () => {
  assert.match(page, /<form id="scoreForm" method="post" action="\/api\/score" autocomplete="on">/);
  const got = {};
  for (const m of page.matchAll(/<input type="radio" name="([A-Za-z]+)" value="([a-z0-9_]+)" required>/g)) (got[m[1]] = got[m[1]] || []).push(m[2]);
  assert.deepEqual(got, IDS);
  assert.deepEqual(Object.keys(got), QUESTIONS, 'the page and the function agree on the questions, in order');
  assert.equal((page.match(/<fieldset class="field" data-q="/g) || []).length, 9);
  for (const n of ['firstName', 'lastName', 'phone', 'email']) assert.match(page, new RegExp(`name="${n}"[^>]* required>`), n);
  assert.match(page, /<button type="submit" class="book-btn" id="scoreBtn">Show my score<\/button>/);
  assert.doesNotMatch(page, /\b\d+ ?(points|pts)\b/i, 'no points are printed on the page');
  assert.doesNotThrow(() => new Function(inline), 'the page script parses');
  assert.match(inline, new RegExp('var QUESTIONS = ' + JSON.stringify(QUESTIONS).replace(/[[\]]/g, '\\$&') + ';'));
});

test('THE PAGE: the same team sizes and revenue ranges as /book, so the handoff lands', () => {
  const book = read('book.html');
  for (const id of IDS.revenue) assert.ok(book.includes(`['${id}',`), id);
  for (const id of IDS.teamSize) assert.ok(book.includes(`['${id}',`), id);
  for (const id of IDS.want) assert.ok(book.includes(`['${id}',`), id);
});

test('THE CONSENT BOX: worded exactly as /book words it, optional here, and that wording is what is sent', () => {
  const words = html => html.match(/<span>(I agree to receive text messages[\s\S]*?)<\/span><\/label>/)[1];
  const plain = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(words(page), words(read('book.html')), 'score.html and book.html word the box differently');
  assert.equal(plain(words(page)), CONSENT_TEXT, 'the wording sent to the CRM is not the wording on the page');
  assert.match(page, /<input type="checkbox" class="js-score-consent" name="textConsent" value="1"> <span>I agree/);
  assert.doesNotMatch(page, /js-sms-consent|data-consent-gate/, 'pt-site.js would make the box compulsory');
});

test('THE RESULT IS SHOWN ONLY AFTER CONTACT DETAILS: it exists nowhere on the page until the server answers', () => {
  assert.match(page, /<div class="score-out" id="scoreResult" hidden tabindex="-1">/);
  assert.match(page, /<span id="rTotal"><\/span>/);
  const show = inline.indexOf('function show(r){');
  assert.ok(show > 0);
  assert.equal(inline.split('show(').length - 1, 2, 'show() is defined once and called once');
  assert.match(inline, /if \(x\.status === 200 && j\.ok && j\.result\) return show\(j\.result\);/);
  assert.ok(inline.indexOf('if (!check()) return;') < inline.indexOf("fetch('/api/score'"), 'the form is checked before anything is posted');
  assert.doesNotMatch(inline, /innerHTML|insertAdjacentHTML|document\.write/, 'CRM text is set as text, never as markup');
});

test('NO PERSONAL DATA IN URLS: only src goes in the link to /book', () => {
  const hrefs = [...inline.matchAll(/setAttribute\('href', ([^;]+)\);/g)].map(m => m[1]);
  assert.deepEqual(hrefs, ["'/book?src=' + (src || 'score')"]);
  assert.doesNotMatch(inline, /location\.(href|assign|replace|search *=)|history\.(push|replace)State|window\.open/);
  assert.doesNotMatch(inline, /encodeURIComponent|URLSearchParams\(\{|[?&](name|email|phone|revenue|team|want|firstName|lastName)=/);
  assert.match(inline, /fetch\('\/api\/score', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}, body: JSON\.stringify\(body\) \}\)/);
  assert.match(page, /<a class="book-btn" id="rBook" href="\/book\?src=score">Book your Nucleus Session<\/a>/);
  assert.doesNotMatch(page.slice(page.indexOf('id="rBook"') - 40, page.indexOf('id="rBook"') + 120), /target=/, 'a new tab would not share sessionStorage');
  assert.match(inline, /var src = \(params\.get\('src'\) \|\| ''\)\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9_-\]\/g, ''\)\.slice\(0, 24\);/);
});

test('THE HANDOFF TO /book: sessionStorage for this tab, read once, then cleared', () => {
  assert.match(inline, /sessionStorage\.setItem\(HANDOFF, JSON\.stringify\(\{ firstName: val\('firstName'\), lastName: val\('lastName'\), phone: val\('phone'\), email: val\('email'\),\s+revenue: picked\('revenue'\), team: picked\('teamSize'\), lookingFor: picked\('want'\) \}\)\);/);
  assert.doesNotMatch(inline, /localStorage|document\.cookie/);
  const book = read('book.html');
  assert.match(book, /var HANDOFF = 'nucleus-score-handoff-v1', HANDOFF_KEYS = \['firstName','lastName','phone','email','revenue','team','lookingFor'\];/);
  assert.match(inline, /var HANDOFF = 'nucleus-score-handoff-v1';/);
  const get = book.indexOf('sessionStorage.getItem(HANDOFF)'), rm = book.indexOf('sessionStorage.removeItem(HANDOFF)'), use = book.indexOf('HANDOFF_KEYS.forEach');
  assert.ok(get > 0 && rm > get && use > rm, 'it must be removed before it is used');
  assert.equal(book.split('sessionStorage.getItem(HANDOFF)').length - 1, 1, 'read once');
  assert.match(book, /if \(typeof handed\[k\] === 'string' && handed\[k\] && !saved\.a\[k\]\) saved\.a\[k\] = handed\[k\]\.slice\(0, 160\);/, 'a field the booking form already holds is kept');
  assert.doesNotMatch(book.slice(get - 900, use + 300), /consent\.checked *= *true/, 'the consent box is never pre-ticked');
  for (const k of ['firstName', 'lastName', 'phone', 'email', 'revenue', 'team', 'lookingFor']) assert.ok(book.includes(`'${k}'`), k + ' is a booking form field');
  assert.doesNotMatch(book, /params\.get\('(name|email|phone|revenue|team|want|firstName|lastName)'\)/, '/book must not read personal data from the URL');
});

test('ANALYTICS: "Score started" and "Score completed", by listed names, once each, with no data', async () => {
  const { EVENTS } = await import('../js/analytics.js');
  assert.equal(EVENTS.scoreStarted, 'Score started'); assert.equal(EVENTS.scoreCompleted, 'Score completed');
  assert.equal(inline.split("countOnce('Score started')").length - 1, 1);
  assert.equal(inline.split("countOnce('Score completed')").length - 1, 1);
  assert.ok(inline.indexOf("countOnce('Score completed')") > inline.indexOf('function show(r){') && inline.indexOf("countOnce('Score completed')") < inline.indexOf('var busy = false;'), 'completed: inside show(), which only a returned score calls');
  assert.match(inline, /function countOnce\(name\)\{\s+if \(counted\[name\]\) return;\s+counted\[name\] = true;\s+try \{ if \(window\.ptTrack\) window\.ptTrack\(name\); \} catch\(e\)\{\}/);
  assert.equal(page.split('<script type="module" src="/js/analytics.js"></script>').length - 1, 1);
});

test('THE SITE: /score is in the sitemap, and the page is the site\'s own shell', () => {
  assert.match(read('sitemap.xml'), /<loc>https:\/\/getproytech\.com\/score<\/loc>/);
  assert.match(page, /<link rel="canonical" href="https:\/\/getproytech\.com\/score">/);
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  for (const piece of ['<link rel="stylesheet" href="/css/pt-site.css?v=3">', '<nav class="nav" id="nav">', '<footer>', '<script src="/js/pt-site.js?v=3"></script>']) assert.ok(page.includes(piece), piece);
});
