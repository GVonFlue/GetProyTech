// tests/audit.test.mjs — the teardown's carried result, the visitor, and the
// page. Plain node, no network:
//   node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../api/_audit.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const NOW = Date.UTC(2026, 10, 23, 16, 0, 0);
import { FACT_KEYS } from '../api/_rubric.js';
import { SITE_KEYS } from '../api/_crawl.js';
import { mockCrawl } from '../api/_audit-mock.js';
const CRAWL = mockCrawl(2026), FACTS = CRAWL.facts;
const result = (more = {}) => ({ v: 3, host: 'example.com', at: NOW, https: true, redirect: 'pass', fwd: false, facts: { ...FACTS }, site: { ...CRAWL.site }, tools: [...CRAWL.tools], speed: null, shot: '', ...more });

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

/* ---- the sealed result ---- */
test('seal/open: round trip; altered, forged, re-keyed and expired tokens do not open', () => {
  const r = result();
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
  assert.equal(A.open(A.seal({ ...r, v: 1 }, SECRET), SECRET, NOW), null, 'an old v1 token does not open');
  assert.equal(A.open(A.seal({ ...r, v: 2 }, SECRET), SECRET, NOW), null, 'a homepage-only v2 token does not open either');
  assert.equal(A.secretOk('short'), false); assert.equal(A.secretOk(SECRET), true);
});
test('sanitizeResult: only numbers, booleans and a hash survive, even from a correctly sealed token', () => {
  const dirty = result({ note: 'click http://evil.example', facts: { ...FACTS, title: '<b>BUY PILLS</b>', words: 'lots' }, site: { ...CRAWL.site, path: '/evil', pagesChecked: 'eight', platform: 999, aiBlocked: 1e4 }, tools: [37, 'Calendly', 999, -1, 37], speed: { lcpMs: 2000, cls: 0.1, weightBytes: 1e6, fontOk: true, tapOk: 'yes', html: '<x>' }, shot: 'not-a-hash', redirect: 'evil' });
  const clean = A.open(A.seal(dirty, SECRET), SECRET, NOW);
  assert.ok(clean, 'opens');
  assert.deepEqual(Object.keys(clean).sort(), ['at', 'facts', 'fwd', 'host', 'https', 'redirect', 'shot', 'site', 'speed', 'tools', 'v']);
  assert.deepEqual(Object.keys(clean.facts).sort(), [...FACT_KEYS].sort());
  assert.deepEqual(Object.keys(clean.site).sort(), [...SITE_KEYS].sort());
  for (const v of Object.values(clean.site)) assert.ok(typeof v === 'number');
  assert.equal(clean.site.pagesChecked, 0); assert.ok(clean.site.platform < 30); assert.ok(clean.site.aiBlocked < 32);
  assert.deepEqual(clean.tools, [37], 'only known tool indexes, once each');
  for (const v of Object.values(clean.facts)) assert.ok(v == null || typeof v === 'number');
  assert.deepEqual(clean.speed, { lcpMs: 2000, cls: 0.1, weightBytes: 1e6, fontOk: true, tapOk: null });
  assert.equal(clean.shot, ''); assert.equal(clean.redirect, 'na');
  assert.ok(!JSON.stringify(clean).includes('evil') && !JSON.stringify(clean).includes('PILLS'));
  assert.equal(A.open(A.seal(result({ shot: 'a'.repeat(64) }), SECRET), SECRET, NOW).shot, 'a'.repeat(64), 'a sha-256 hex survives');
  assert.equal(A.open(A.seal(result({ host: '10.0.0.1' }), SECRET), SECRET, NOW), null, 'a host that is not a public name');
  assert.equal(A.open(A.seal(result({ host: 'Example.com/<script>' }), SECRET), SECRET, NOW), null);
});

/* ---- step 1: what the visitor sees for free ---- */
test('teaser: a count and the headline misses (names from our list), no grade, no evidence, no site words', () => {
  const t = A.teaser(result());
  assert.deepEqual(Object.keys(t).sort(), ['checked', 'misses', 'needWork']);
  assert.ok(t.checked > 0 && t.needWork > 0 && t.needWork <= t.checked);
  assert.ok(t.misses.length >= 1 && t.misses.length <= 4);
  for (const m of t.misses) assert.ok(typeof m === 'string' && !/Acme|Wichita|555/.test(m), m);
});

/* ---- the visitor ---- */
test('cleanContact: name, business, email and a 10-digit mobile are required; consent is only the boolean true', () => {
  const ok = A.cleanContact({ name: ' Jo  Reed ', company: ' Reed Roofing ', email: 'Jo@Reed.com', phone: '(316) 555-0142' });
  assert.deepEqual(ok, { ok: true, errors: [], name: 'Jo Reed', company: 'Reed Roofing', email: 'jo@reed.com', phone: '3165550142', consent: false });
  const base = { name: 'Jo', company: 'Reed', email: 'jo@reed.com', phone: '3165550142' };
  assert.equal(A.cleanContact({ ...base, phone: '+1 316 555 0142' }).phone, '3165550142');
  assert.deepEqual(A.cleanContact({}).errors, ['name', 'company', 'email', 'phone']);
  assert.deepEqual(A.cleanContact({ ...base, company: '  ' }).errors, ['company']);
  assert.deepEqual(A.cleanContact({ ...base, phone: '555-0142' }).errors, ['phone']);
  assert.deepEqual(A.cleanContact({ ...base, email: 'jo@reed' }).errors, ['email']);
  assert.deepEqual(A.cleanContact({ ...base, email: 'a@b.co, c@d.co' }).errors, ['email'], 'one address only');
  assert.equal(A.cleanContact({ ...base, consent: true }).consent, true);
  for (const c of ['true', 'yes', 1, 'on']) { const r = A.cleanContact({ ...base, consent: c }); assert.equal(r.consent, false); assert.deepEqual(r.errors, ['consent']); }
  assert.equal(A.cleanContact({ ...base, name: 'Jo\u0000\u0007 Reed' }).name, 'Jo Reed', 'control characters removed');
});

/* ---- the page ---- */
test('audit.html: teardown copy, the grade rule and whose score it is, four required fields, consent optional and unticked', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../audit.html', import.meta.url), 'utf8');
  assert.match(html, /free website teardown/i);
  assert.match(html, /A is 90 or more, B 80 to 89, C 70 to 79, D 60 to 69, F below 60/);
  assert.match(html, /The grade is ProyTech’s score for these checks on ' \+ state.host \+ ' on this date/);
  assert.match(html, /up to 8 pages/); assert.match(html, /12 areas/);
  assert.ok(!/One page only/.test(html), 'the old one-page promise is gone');
  assert.match(html, /\$500 off/);
  for (const id of ['g_name', 'g_company', 'g_email', 'g_phone']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/id="g_consent"[^>]*(checked|required)/.test(html));
  assert.ok(!/RESEND|resend\.com/i.test(html));
  assert.ok(!/innerHTML/.test(html.slice(html.indexOf('<script>\n(function(){'))), 'the flow writes text only');
  assert.ok(html.indexOf('body.shot = state.shot') > html.indexOf("company: $('g_company')"), 'the screenshot goes with the details');
});
