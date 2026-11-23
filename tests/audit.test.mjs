// tests/audit.test.mjs — the website audit's rules. Plain node, no network:
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../api/_audit.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const NOW = Date.UTC(2026, 10, 23, 16, 0, 0);
const all = (s, extra = {}) => Object.fromEntries(A.CHECK_IDS.map(id => [id, { s, c: s === 'pass' ? 'ok' : s === 'fail' ? 'missing' : 'not_run', ...extra }]));
const result = (checks, more = {}) => ({ v: 1, host: 'example.com', at: NOW, https: true, fwd: false, checks, ...more });

/* ---- which addresses may be fetched ---- */
test('validateUrl: accepts a public host name and audits its root', () => {
  for (const [input, host] of [['example.com', 'example.com'], ['https://Example.com/pricing?x=1', 'example.com'], ['http://www.example.co.uk', 'www.example.co.uk'], ['example.com.', 'example.com'], ['  example.com  ', 'example.com']]) {
    const v = A.validateUrl(input);
    assert.equal(v.ok, true, input); assert.equal(v.host, host);
  }
  assert.equal(A.validateUrl('example.com').protocol, 'https:');
});
test('validateUrl: refuses everything that is not a public web address', () => {
  const bad = ['', 'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.com',
    'http://127.0.0.1', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:10.0.0.1]/', 'http://[fd00::1]/',
    'http://localhost', 'http://localhost./', 'intranet', 'http://printer.local', 'http://db.internal', 'http://router.lan', 'http://thing.home.arpa', 'http://x.test', 'http://a.onion',
    'http://example.com:8080', 'https://example.com:22', 'http://user:pass@example.com', 'http://exa mple.com', 'http://-bad.com', 'http://bad-.com', 'x'.repeat(400) + '.com'];
  for (const input of bad) assert.equal(A.validateUrl(input).ok, false, JSON.stringify(input));
  assert.equal(A.validateUrl(null).ok, false); assert.equal(A.validateUrl({}).ok, false);
});
test('isPublicAddress: private, loopback, link-local, metadata and reserved ranges are refused', () => {
  const priv = ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1', '2002:a00:1::1', '2001:0::1', '100::1',
    '', 'not-an-ip', '999.1.1.1', null, undefined];
  for (const ip of priv) assert.equal(A.isPublicAddress(ip), false, String(ip));
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8']) assert.equal(A.isPublicAddress(ip), true, ip);
});

/* ---- reading the homepage ---- */
const GOOD = `<!doctype html><html><head><title>Reed Roofing | Roof repair in Wichita KS</title>
<meta name="description" content="Roof repair and replacement in Wichita. Free estimates, licensed and insured, call today.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<h1>Roof repair in Wichita</h1><p>${'We fix roofs. '.repeat(30)}</p>
<a href="tel:3165550142">Call (316) 555-0142</a> <a href="mailto:hi@reed.com">Email</a>
<a class="btn" href="/quote">Get a free quote</a> <a href="https://maps.app.goo.gl/abc123">Find us on Google</a>
<img src="https://cdn.example.com/a.jpg"><script src="https://cdn.example.com/a.js"></script></body></html>`;
test('inspectHtml: a complete homepage passes every HTML check', () => {
  const c = A.inspectHtml(GOOD, { https: true });
  for (const id of ['title', 'description', 'viewport', 'h1', 'tel', 'write', 'cta', 'gbp', 'mixed']) assert.equal(c[id].s, 'pass', id);
});
test('inspectHtml: what is missing fails, with a code and a number, never the site\'s own words', () => {
  const bare = `<html><head><title>Hi</title></head><body><h1>One</h1><h1>Two</h1><p>${'word '.repeat(60)}</p><img src="http://old.example.com/a.jpg"><link rel="stylesheet" href="http://old.example.com/a.css"></body></html>`;
  const c = A.inspectHtml(bare, { https: true });
  assert.deepEqual(c.title, { s: 'fail', c: 'short', n: 2 });
  assert.deepEqual(c.description, { s: 'fail', c: 'missing' });
  assert.deepEqual(c.viewport, { s: 'fail', c: 'missing' });
  assert.deepEqual(c.h1, { s: 'fail', c: 'many', n: 2 });
  assert.deepEqual(c.mixed, { s: 'fail', c: 'found', n: 2 });
  for (const id of ['tel', 'write', 'cta', 'gbp']) assert.deepEqual(c[id], { s: 'fail', c: 'none' }, id);
  for (const v of Object.values(c)) assert.deepEqual(Object.keys(v).filter(k => !['s', 'c', 'n'].includes(k)), []);
});
test('inspectHtml: a page built in the browser is "could not check", not a fail', () => {
  const c = A.inspectHtml('<html><head><title>My Business Website Title</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>', { https: true });
  for (const id of ['h1', 'tel', 'write', 'cta', 'gbp']) assert.deepEqual(c[id], { s: 'na', c: 'js' }, id);
  assert.equal(c.title.s, 'pass');
});
test('inspectHtml: text inside scripts and comments is not read as content; no https means mixed content does not apply', () => {
  const c = A.inspectHtml(`<html><body><!-- <h1>x</h1> <a href="tel:1">call</a> --><script>var a='<a href="tel:1">Call now</a>'</script><p>${'word '.repeat(60)}</p></body></html>`, { https: false });
  assert.equal(c.h1.s, 'fail'); assert.equal(c.tel.s, 'fail'); assert.equal(c.cta.s, 'fail');
  assert.deepEqual(c.mixed, { s: 'na', c: 'no_https' });
});
test('headerChecks and speedChecks', () => {
  assert.equal(A.headerChecks({ 'strict-transport-security': 'max-age=1', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'self'" }, { https: true }).headers.s, 'pass');
  assert.deepEqual(A.headerChecks({}, { https: true }), { hsts: { s: 'fail', c: 'missing' }, headers: { s: 'fail', c: 'missing', n: 2 } });
  assert.deepEqual(A.headerChecks({}, { https: false }).hsts, { s: 'na', c: 'no_https' });
  const s = A.speedChecks({ lcpMs: 4200.4, cls: 0.02, weightBytes: 5 * 1024 * 1024 });
  assert.deepEqual(s, { lcp: { s: 'fail', c: 'slow', n: 4200 }, cls: { s: 'pass', c: 'ok', n: 20 }, weight: { s: 'fail', c: 'heavy', n: 5120 } });
  assert.deepEqual(A.speedChecks(null, 'timeout'), { lcp: { s: 'na', c: 'timeout' }, cls: { s: 'na', c: 'timeout' }, weight: { s: 'na', c: 'timeout' } });
  assert.equal(A.speedChecks({ lcpMs: NaN, cls: 0, weightBytes: 1000 }).lcp.s, 'na');
});

/* ---- the grading rule ---- */
const graded = (pass, fail, na = 0) => { const c = all('na'); A.CHECK_IDS.forEach((id, i) => { c[id] = i < pass ? { s: 'pass', c: 'ok' } : i < pass + fail ? { s: 'fail', c: 'missing' } : { s: 'na', c: 'not_run' }; }); assert.equal(pass + fail + na, A.CHECK_IDS.length); return A.gradeOf(c); };
test('gradeOf: the share of the checks that ran which passed, at the documented lines', () => {
  assert.equal(A.CHECK_IDS.length, 16);
  assert.equal(graded(16, 0).grade, 'A');
  assert.equal(graded(15, 1).grade, 'A');      // 93.75%
  assert.equal(graded(14, 2).grade, 'B');      // 87.5%
  assert.equal(graded(13, 3).grade, 'B');      // 81.25%
  assert.equal(graded(12, 4).grade, 'C');      // 75%
  assert.equal(graded(11, 5).grade, 'D');      // 68.75%
  assert.equal(graded(10, 6).grade, 'D');      // 62.5%
  assert.equal(graded(9, 7).grade, 'F');       // 56.25%
  assert.equal(graded(0, 16).grade, 'F');
  assert.deepEqual(graded(12, 4), { grade: 'C', passed: 12, ran: 16, needWork: 4, notRun: [] });
});
test('gradeOf: exactly on a line gets the higher grade (9 of 10 is an A, 8 of 10 a B, 7 a C, 6 a D)', () => {
  assert.equal(graded(9, 1, 6).grade, 'A'); assert.equal(graded(8, 2, 6).grade, 'B');
  assert.equal(graded(7, 3, 6).grade, 'C'); assert.equal(graded(6, 4, 6).grade, 'D'); assert.equal(graded(5, 5, 6).grade, 'F');
});
test('gradeOf: a check that could not run is left out and named, never counted as a fail', () => {
  const g = graded(13, 0, 3);                  // the three speed checks did not run
  assert.equal(g.grade, 'A'); assert.equal(g.ran, 13); assert.equal(g.needWork, 0);
  assert.deepEqual(g.notRun, ['lcp', 'cls', 'weight']);
  assert.equal(graded(13, 0, 3).grade, graded(16, 0).grade, 'the same site, with and without the speed test, gets the same grade');
  assert.notEqual(graded(13, 0, 3).grade, graded(13, 3).grade, 'not running is not the same as failing');
});
test('gradeOf: with nothing run there is no grade at all, not an F', () => {
  assert.deepEqual(A.gradeOf(all('na')), { grade: null, passed: 0, ran: 0, needWork: 0, notRun: A.CHECK_IDS });
  assert.equal(A.gradeOf(undefined).grade, null);
});
test('the stated rule matches the code', () => {
  for (const s of ['90%', '80%', '70%', '60%', 'could not run is left out']) assert.ok(A.GRADE_RULE.includes(s), s);
});
test('teaser: names and a count only: no status per check, no codes, no grade', () => {
  const c = all('pass'); c.title = { s: 'fail', c: 'long', n: 90 }; c.lcp = { s: 'na', c: 'timeout' };
  const t = A.teaser(c);
  assert.equal(t.needWork, 1); assert.equal(t.ran, 15);
  assert.deepEqual(Object.keys(t).sort(), ['checks', 'needWork', 'ran']);
  for (const x of t.checks) assert.deepEqual(Object.keys(x).sort(), ['id', 'name', 'ran']);
  assert.equal(t.checks.find(x => x.id === 'lcp').ran, false);
});

/* ---- the sealed result ---- */
test('seal/open: round trip; altered, forged, re-keyed and expired tokens do not open', () => {
  const r = result(all('pass'));
  const tok = A.seal(r, SECRET);
  assert.deepEqual(A.open(tok, SECRET, NOW + 1000), r);
  assert.ok(!tok.includes('example'), 'the token is not readable');
  assert.equal(A.open(tok, SECRET + 'x', NOW), null, 'another key');
  for (const i of [0, 5, 14, 20, 30, tok.length - 1]) {
    const flipped = tok.slice(0, i) + (tok[i] === 'A' ? 'B' : 'A') + tok.slice(i + 1);
    assert.equal(A.open(flipped, SECRET, NOW), null, 'altered at ' + i);
  }
  assert.equal(A.open(tok, SECRET, NOW + A.LIMITS.tokenMaxAgeMs + 1), null, 'too old');
  assert.equal(A.open(tok, SECRET, NOW - 10 * 60000), null, 'from the future');
  for (const junk of ['', 'abc', null, undefined, {}, 'a'.repeat(7000), Buffer.from(JSON.stringify(r)).toString('base64url')]) assert.equal(A.open(junk, SECRET, NOW), null);
  assert.equal(A.secretOk('short'), false); assert.equal(A.secretOk(SECRET), true);
});
test('sanitizeResult: only the fixed vocabulary survives, even from a correctly sealed token', () => {
  const dirty = result({ ...all('pass'), title: { s: 'fail', c: 'long', n: 90, text: '<b>BUY PILLS</b>' }, h1: { s: 'pass', c: 'Visit evil.com NOW', n: 'lots' }, extra: { s: 'fail', c: 'x' } }, { note: 'click http://evil.example', host: 'example.com' });
  const clean = A.open(A.seal(dirty, SECRET), SECRET, NOW);
  assert.deepEqual(Object.keys(clean).sort(), ['at', 'checks', 'fwd', 'host', 'https', 'v']);
  assert.deepEqual(Object.keys(clean.checks), A.CHECK_IDS);
  assert.deepEqual(clean.checks.title, { s: 'fail', c: 'long', n: 90 });
  assert.deepEqual(clean.checks.h1, { s: 'pass', c: 'ok' });
  assert.ok(!JSON.stringify(clean).includes('evil') && !JSON.stringify(clean).includes('PILLS'));
  assert.equal(A.open(A.seal(result(all('pass'), { host: '10.0.0.1' }), SECRET), SECRET, NOW), null, 'a host that is not a public name');
  assert.equal(A.open(A.seal(result(all('pass'), { host: 'Example.com/<script>' }), SECRET), SECRET, NOW), null);
});

/* ---- the visitor ---- */
test('cleanContact: mobile is required and is 10 digits; email is required; consent is only the boolean true', () => {
  const ok = A.cleanContact({ name: ' Jo  Reed ', email: 'Jo@Reed.com', phone: '(316) 555-0142' });
  assert.deepEqual(ok, { ok: true, errors: [], name: 'Jo Reed', email: 'jo@reed.com', phone: '3165550142', consent: false });
  assert.equal(A.cleanContact({ name: 'Jo', email: 'jo@reed.com', phone: '+1 316 555 0142' }).phone, '3165550142');
  assert.deepEqual(A.cleanContact({}).errors, ['name', 'email', 'phone']);
  assert.deepEqual(A.cleanContact({ name: 'Jo', email: 'jo@reed.com', phone: '555-0142' }).errors, ['phone']);
  assert.deepEqual(A.cleanContact({ name: 'Jo', email: 'jo@reed.com', phone: '' }).errors, ['phone']);
  assert.deepEqual(A.cleanContact({ name: 'Jo', email: 'jo@reed', phone: '3165550142' }).errors, ['email']);
  assert.deepEqual(A.cleanContact({ name: 'Jo', email: 'a@b.co, c@d.co', phone: '3165550142' }).errors, ['email'], 'one address only');
  assert.equal(A.cleanContact({ name: 'Jo', email: 'jo@reed.com', phone: '3165550142', consent: true }).consent, true);
  for (const c of ['true', 'yes', 1, 'on']) { const r = A.cleanContact({ name: 'Jo', email: 'jo@reed.com', phone: '3165550142', consent: c }); assert.equal(r.consent, false); assert.deepEqual(r.errors, ['consent']); }
  assert.equal(A.cleanContact({ name: 'Jo', email: 'jo@reed.com', phone: '3165550142', consent: false }).consent, false);
});
test('bookLink: /book?src=audit-<their tag>, cut to 24 characters, or /book?src=audit', () => {
  assert.equal(A.bookLink(''), 'https://getproytech.com/book?src=audit');
  assert.equal(A.bookLink(undefined), 'https://getproytech.com/book?src=audit');
  assert.equal(A.bookLink('ig'), 'https://getproytech.com/book?src=audit-ig');
  assert.equal(A.bookLink('FB Nov!!'), 'https://getproytech.com/book?src=audit-fbnov');
  const long = A.bookLink('abcdefghijklmnopqrstuvwxyz');
  assert.equal(long, 'https://getproytech.com/book?src=audit-abcdefghijklmnopqr'); assert.equal(long.split('src=')[1].length, 24);
  assert.equal(A.bookLink('"><script>'), 'https://getproytech.com/book?src=audit-script');
});

/* ---- the lead ---- */
const SITE_LEAD_KEYS = ['kind', 'source', 'form', 'name', 'email', 'phone', 'message', 'page', 'fields'];   // proytech-crm api/site-lead.js LEAD_KEYS
const contact = (consent = false) => ({ name: 'Jo Reed', email: 'jo@reed.com', phone: '3165550142', consent });
test('leadPayload: fits the CRM route exactly as it works today', () => {
  const c = all('pass'); c.title = { s: 'fail', c: 'long', n: 90 }; c.lcp = { s: 'na', c: 'timeout' };
  const p = A.leadPayload({ contact: contact(false), result: result(c), src: 'IG-Nov' });
  assert.deepEqual(Object.keys(p), ['kind', 'source', 'form', 'name', 'email', 'phone', 'page', 'message']);
  for (const k of Object.keys(p)) assert.ok(SITE_LEAD_KEYS.includes(k), k);
  assert.equal(p.kind, 'lead'); assert.equal(p.source, 'Website audit'); assert.equal(p.form, 'audit');
  assert.equal(p.phone, '3165550142', 'the number goes to the CRM either way');
  assert.equal(p.page, 'getproytech.com/audit?src=ig-nov (audited example.com)');
  assert.match(p.message, /Website audit of example\.com\./); assert.match(p.message, /Grade A \(14 of 15 checks passed\)/);
  assert.match(p.message, /Needs work: Page title\./); assert.match(p.message, /Could not check: Main content appears quickly\./);
  assert.match(p.message, /Link tag: ig-nov\./); assert.match(p.message, /Text consent box: NOT ticked \(do not text this number\)\./);
  assert.ok(p.message.length <= 2000 && p.page.length <= 200);
});
test('leadPayload: says when the box was ticked; no tag reads "none"; the later fields are one flag away', () => {
  const p = A.leadPayload({ contact: contact(true), result: result(all('pass')), src: '' });
  assert.match(p.message, /Text consent box: TICKED\./); assert.match(p.message, /Link tag: none\./);
  assert.equal(p.page, 'getproytech.com/audit (audited example.com)');
  assert.equal(A.SEND_STRUCTURED_FIELDS, false, 'the CRM refuses unknown fields today');
  const later = A.leadPayload({ contact: contact(true), result: result(all('pass')), src: 'ig' }, true);
  assert.deepEqual(later.fields, { src: 'ig', website: 'example.com', textConsent: true });
});

/* ---- the email ---- */
const variants = () => {
  const mixed = all('pass'); Object.assign(mixed, { title: { s: 'fail', c: 'long', n: 90 }, description: { s: 'fail', c: 'short', n: 12 }, h1: { s: 'fail', c: 'many', n: 3 }, mixed: { s: 'fail', c: 'found', n: 1 }, headers: { s: 'fail', c: 'missing', n: 1 }, lcp: { s: 'fail', c: 'slow', n: 6400 }, cls: { s: 'fail', c: 'shifts', n: 300 }, weight: { s: 'fail', c: 'heavy', n: 9000 } });
  const noHttps = all('fail'); Object.assign(noHttps, { https: { s: 'fail', c: 'no_https' }, http_redirect: { s: 'na', c: 'no_https' }, hsts: { s: 'na', c: 'no_https' }, mixed: { s: 'na', c: 'no_https' }, title: { s: 'fail', c: 'missing' }, description: { s: 'fail', c: 'missing' }, h1: { s: 'fail', c: 'none' } });
  const js = all('pass'); for (const id of ['h1', 'tel', 'write', 'cta', 'gbp']) js[id] = { s: 'na', c: 'js' }; for (const id of A.SPEED_IDS) js[id] = { s: 'na', c: 'timeout' }; js.http_redirect = { s: 'na', c: 'no_answer' };
  const odd = all('fail', { c: 'some_new_code', n: 7 });
  return { allPass: all('pass', { n: 40 }), allFail: all('fail', { n: 2 }), nothingRan: all('na'), mixed, noHttps, js, odd };
};
const render = (checks, more = {}) => A.renderReport({ result: result(checks, more.result), firstName: more.name ?? 'Jo Reed', src: more.src ?? 'ig' });

/* THE "MUST NOT CLAIM" LIST. A grade is allowed; presenting it as official is not. */
const MUST_NOT_CLAIM = [
  [/hack|malware|infect|virus|compromis|breach/i, 'that the site is hacked or infected'],
  [/\bsafe\b|\bsafely\b|is secure\b|fully secure|100% secure|protected from/i, 'that the site is safe'],
  [/\brank|\bseo\b|traffic|penali[sz]|algorithm/i, 'rankings, traffic or search penalties'],
  [/revenue|\bsales\b|lost |losing|costing|\$\s?\d|per month|per year/i, 'money lost'],
  [/\bADA\b|WCAG|accessib|complian|lawsuit|legal/i, 'accessibility or legal compliance'],
  [/you (have|do not have|don't have) (no |a )?google (business )?profile|no google (business )?profile/i, 'whether a Google profile exists'],
  [/\bAI\b|ChatGPT|Perplexity|Gemini/i, 'anything about AI search'],
  [/review|star rating|\bstars\b|facebook|instagram|social media/i, 'reviews or social pages'],
  [/competitor|other businesses|industry average|compared (to|with)/i, 'comparisons with competitors'],
  [/official|certif|accredit|verified by|approved by|guarantee/i, 'an official or certified grade'],
  [/google('s)? (grade|score|rating)|graded by google|google (says|rates|scored|graded)|pagespeed (score|grade)/i, 'a grade that is Google\'s'],
  [/your (whole |entire )?(site|website) (is|was|has)\b|every page|all (of )?your pages|site-wide/i, 'pages other than the homepage'],
  [/your customers (see|wait|experience|leave)|visitors (leave|bounce|give up)/i, 'what their customers experience'],
];
test('the report makes none of the claims on the must-not-claim list, in any variant', () => {
  for (const [name, checks] of Object.entries(variants())) {
    const r = render(checks, { result: { fwd: name === 'mixed' } });
    for (const body of [r.html.replace(/<[^>]*>/g, ' '), r.text, r.subject]) for (const [re, what] of MUST_NOT_CLAIM) {
      const m = re.exec(body);
      assert.equal(m, null, `${name}: claims ${what}: "${m && body.slice(Math.max(0, m.index - 40), m.index + 60)}"`);
    }
  }
});
test('every sentence a check can produce is on that list\'s right side too', () => {
  for (const chk of A.CHECKS) {
    const lines = [chk.name, chk.fix, chk.pass(40, 'ok'), ...['missing', 'short', 'long', 'many', 'none', 'found', 'slow', 'shifts', 'heavy', 'no_https', 'stays_http'].map(c => chk.fail(3, c)), ...Object.values(chk.na || {})];
    for (const line of lines) for (const [re, what] of MUST_NOT_CLAIM) assert.equal(re.test(line), false, `${chk.id}: "${line}" claims ${what}`);
  }
});
test('the report says what it is: the grade and its rule, whose score it is, the date, the address, an automated outside check', () => {
  const r = render(variants().mixed);
  for (const body of [r.html, r.text]) {
    assert.ok(body.includes(A.GRADE_RULE.replace(/'/g, body === r.html ? '&#39;' : "'")) || body.includes(A.GRADE_RULE), 'the one-line rule');
    assert.match(body, /ProyTech(&#39;|')s own score for these checks on the homepage of example\.com on November 23, 2026/);
    assert.match(body, /does not come from Google or any rating body/);
    assert.match(body, /automated outside check/i);
    assert.match(body, /example\.com/); assert.match(body, /November 23, 2026/);
    assert.match(body, /https:\/\/getproytech\.com\/book\?src=audit-ig/);
  }
  assert.equal(r.grade.grade, 'F'); assert.match(r.html, />F<\/div>/);
  assert.equal(r.subject, 'Your website report for example.com');
});
test('a check that could not run is named in the report and kept out of the grade', () => {
  const r = render(variants().js);
  assert.equal(r.grade.grade, 'A'); assert.equal(r.grade.ran, 7);
  assert.match(r.text, /WHAT WE COULD NOT CHECK/);
  assert.match(r.text, /Speed could not be measured today\./);
  assert.match(r.text, /built in the browser by a script/);
  assert.match(r.text, /7 of the 7 checks that ran passed/);
  const none = render(variants().nothingRan);
  assert.equal(none.grade.grade, null); assert.match(none.text, /there is no grade/); assert.doesNotMatch(none.html, />F<\/div>/);
});
test('nothing a visitor types reaches the email except their first name, escaped', () => {
  const r = A.renderReport({ result: result(all('pass')), firstName: '<script>alert(1)</script> Reed "the roofer" jo@reed.com 316-555-0142', src: '"><img src=x onerror=alert(1)>' });
  assert.ok(!r.html.includes('<script') && !r.html.includes('<img') && !r.html.includes('onerror=alert'));
  assert.match(r.html, /Your website report, script</);
  for (const typed of ['Reed', 'roofer', 'jo@reed.com', '316-555-0142', 'alert(1)']) assert.ok(!r.html.includes(typed) && !r.text.includes(typed), typed);
  assert.match(r.html, /book\?src=audit-imgsrcxonerroraler"/);
  const plain = A.renderReport({ result: result(all('pass')), firstName: "O'Neil-Smith Jr", src: '' });
  assert.match(plain.html, /Your website report, O&#39;Neil-Smith</); assert.match(plain.text, /Your website report, O'Neil-Smith\n/);
  for (const nameless of ['', '12345', '!!!', null]) assert.match(A.renderReport({ result: result(all('pass')), firstName: nameless, src: '' }).text, /^Your website report\n/);
  assert.equal(A.firstNameOf('x'.repeat(80)).length, 30);
});
test('every link in the email is ours: the /book button and nothing else', () => {
  for (const checks of Object.values(variants())) {
    const hrefs = [...render(checks).html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(hrefs, ['https://getproytech.com/book?src=audit-ig']);
    assert.equal(/<img|<script|<iframe|<form|\ssrc=/i.test(render(checks).html), false);
  }
});

/* ---- the page ---- */
test('audit.html: states the same grade rule, keeps the consent box optional and unticked, and promises no text', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../audit.html', import.meta.url), 'utf8');
  assert.ok(html.includes(A.GRADE_RULE), 'the rule on the page is the rule in the code');
  const box = /<input type="checkbox" id="g_consent"[^>]*>/.exec(html);
  assert.ok(box, 'the consent box'); assert.doesNotMatch(box[0], /checked|required/);
  assert.doesNotMatch(html, /js-sms-consent|data-consent-gate/, 'nothing gates the button on the box');
  assert.match(html, /I agree to receive text messages from ProyTech at the number provided, including replies to my inquiry, appointment reminders, follow ups, and occasional offers\. Consent is not a condition of purchase\./);
  const words = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<div class="sms-consent-wrap">[\s\S]*?<\/div>/, ' ').replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(words, /we(?:'ll| will) text|text you|by text|text message/i);
  assert.match(html, /id="captchaSlot"/); assert.match(html, /\?mock=1/);
});
