// tests/audit-net.test.mjs — the audit's fetch, rate limiter and three routes.
// Plain node. The only sockets opened are to a throwaway server on 127.0.0.1;
// Supabase, PageSpeed, Anthropic and the CRM are stubbed.
//   node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import * as A from '../api/_audit.js';
import * as N from '../api/_audit-net.js';
import { keyedBucket } from '../api/_bucket.js';
import { makeHandler as makeScan } from '../api/audit-scan.js';
import { makeHandler as makeSpeed } from '../api/audit-speed.js';
import { makeHandler as makeReport, CAPS } from '../api/audit-report.js';
import { ruleFacts, CONSENT_TEXT } from '../api/_rubric.js';
import { MOCK_HTML, mockSite, mockClaude, mockCrawl } from '../api/_audit-mock.js';

/* ---- a local server standing in for "a website" ---- */
const seen = [];
const page = `<html><head><title>A perfectly fine title</title></head><body><h1>Hello</h1>${'<p>words words words</p>'.repeat(20)}</body></html>`;
const server = http.createServer((req, res) => {
  seen.push(req.url);
  const html = body => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  if (req.url === '/') return html(page);
  if (req.url === '/ua') return html(`<html><body>${req.headers['user-agent']}|${req.headers.cookie || 'no-cookie'}</body></html>`);
  if (req.url === '/to-private') { res.writeHead(302, { location: `http://internal.example.org:${port}/secret` }); return res.end(); }
  if (req.url === '/to-ip') { res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }); return res.end(); }
  if (req.url === '/to-metadata') { res.writeHead(302, { location: `http://169.254.169.254:${port}/latest/meta-data/` }); return res.end(); }
  if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
  if (req.url === '/to-port') { res.writeHead(302, { location: 'http://site.example.org:22/' }); return res.end(); }
  if (req.url === '/hop/ok') { res.writeHead(301, { location: '/landing?x=1' }); return res.end(); }
  if (req.url === '/landing?x=1') return html('<html><body>landed</body></html>');
  if (req.url.startsWith('/loop/')) { res.writeHead(302, { location: '/loop/' + (Number(req.url.slice(6)) + 1) }); return res.end(); }
  if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); const chunk = 'x'.repeat(64 * 1024); let n = 0; const go = () => { if (n++ > 200 || res.destroyed) return res.end(); res.write(chunk, go); }; return go(); }
  if (req.url === '/bomb') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61))); }
  if (req.url === '/gzip') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(page)); }
  if (req.url === '/slow') return;                                  // never answers
  if (req.url === '/drip') { res.writeHead(200, { 'content-type': 'text/html' }); const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write('x')), 20); return; }
  if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF'); }
  if (req.url === '/403') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('no'); }
  if (req.url === '/secret') return html('SECRET');
  res.writeHead(404); res.end();
});
let port;
test.before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });

/* In these tests ONE name is allowed to mean the local server, standing in for
   a public site. Every other rule is the real one. */
const names = { 'site.example.org': '127.0.0.1', 'internal.example.org': '10.0.0.5' };
const resolve = async host => { if (!names[host]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return [{ address: names[host], family: 4 }]; };
const isPublic = ip => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' ? true : A.isPublicAddress(ip);
const opts = () => ({ resolve, isPublic, ports: [port] });
const at = path => `http://site.example.org:${port}${path}`;

/* ---- rule 2: the DNS answer is checked where the socket gets it ---- */
const lookup = (o, host = 'x.example.org', options = {}) => new Promise(r => N.checkedLookup(o)(host, options, (err, address, family) => r({ err, address, family })));
test('checkedLookup: a name that resolves to a private address is refused', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.10', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    const r = await lookup({ resolve: async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }] });
    assert.equal(r.err && r.err.code, 'EPRIVATE', ip); assert.equal(r.address, undefined);
  }
});
test('checkedLookup: if ANY answer is private the name is refused (no picking the public one)', async () => {
  const r = await lookup({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] });
  assert.equal(r.err.code, 'EPRIVATE');
});
test('checkedLookup: a public name resolves once and the socket gets exactly what was checked', async () => {
  let calls = 0;
  const flip = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);   // "public first, private after"
  const one = await lookup({ resolve: flip });
  assert.equal(one.err, null); assert.equal(one.address, '93.184.216.34'); assert.equal(one.family, 4); assert.equal(calls, 1);
  const many = await lookup({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }] }, 'x.example.org', { all: true });
  assert.deepEqual(many.address, [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }]);
  assert.equal((await lookup({ resolve: async () => [] })).err.code, 'ENOTFOUND');
  assert.equal((await lookup({ resolve: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } })).err.code, 'ENOTFOUND');
});

/* ---- the fetch, with the REAL rules ---- */
test('safeFetch with the real rules never connects to this machine', async () => {
  seen.length = 0;
  for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://2130706433/', 'ftp://example.com/']) {
    const r = await N.safeFetch(u, { timeoutMs: 1500 });
    assert.equal(r.ok, false, u); assert.ok(['private', 'bad_address'].includes(r.why), u + ' ' + r.why);
  }
  // a real-looking name that resolves to loopback: stopped by the lookup, before any connection
  const r = await N.safeFetch(at('/'), { resolve, ports: [port], timeoutMs: 1500 });
  assert.deepEqual([r.ok, r.why], [false, 'private']);
  assert.equal(seen.length, 0, 'the local server was never reached');
});
test('safeFetch: the connected address is checked again after the socket opens', async () => {
  seen.length = 0;
  let asked = 0;
  // the lookup's check says yes, the post-connect check says no
  const r = await N.safeFetch(at('/'), { resolve, ports: [port], isPublic: ip => (++asked === 1 ? true : A.isPublicAddress(ip)) });
  assert.deepEqual([r.ok, r.why], [false, 'private']); assert.ok(asked >= 2);
  assert.equal(seen.length, 0, 'the request was dropped before it was sent');
});
test('safeFetch: fetches one page as a visitor would, naming us, with no cookies', async () => {
  const r = await N.safeFetch(at('/ua'), opts());
  assert.equal(r.ok, true);
  assert.match(r.body, /ProyTechWebsiteAudit\/1\.0 \(\+https:\/\/getproytech\.com\/audit\)\|no-cookie/);
  const z = await N.safeFetch(at('/gzip'), opts());
  assert.equal(z.ok, true); assert.match(z.body, /A perfectly fine title/);
});

/* ---- rule 4: every redirect hop is checked again ---- */
test('safeFetch: a redirect to a private name, an IP address, the metadata address, a file or another port is refused at that hop', async () => {
  for (const [path, why] of [['/to-private', 'private'], ['/to-ip', 'private'], ['/to-metadata', 'private'], ['/to-file', 'bad_address'], ['/to-port', 'bad_address']]) {
    seen.length = 0;
    const r = await N.safeFetch(at(path), opts());
    assert.deepEqual([r.ok, r.why, r.hops], [false, why, 1], path);
    assert.deepEqual(seen, [path], 'only the first hop was fetched');
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});
test('safeFetch: follows an ordinary redirect, keeping its path; stops after 5', async () => {
  const ok = await N.safeFetch(at('/hop/ok'), opts());
  assert.equal(ok.ok, true); assert.equal(ok.hops, 1); assert.match(ok.body, /landed/);
  seen.length = 0;
  const loop = await N.safeFetch(at('/loop/0'), opts());
  assert.deepEqual([loop.ok, loop.why], [false, 'too_many_redirects']);
  assert.equal(seen.length, A.LIMITS.maxRedirects + 1);
});

/* ---- the caps ---- */
test('safeFetch: the body is cut at the byte cap, compressed or not', async () => {
  const big = await N.safeFetch(at('/big'), { ...opts(), maxBytes: 100 * 1024 });
  assert.equal(big.ok, true); assert.equal(big.truncated, true); assert.equal(big.body.length, 100 * 1024);
  const bomb = await N.safeFetch(at('/bomb'), { ...opts(), maxBytes: 100 * 1024 });   // 8 MB of "a" in a few KB of gzip
  assert.equal(bomb.ok, true); assert.equal(bomb.truncated, true); assert.equal(bomb.body.length, 100 * 1024);
  assert.equal(A.LIMITS.maxBytes, 2 * 1024 * 1024);
});
test('safeFetch: the time cap covers a server that never answers, one that drips, and the whole redirect chain', async () => {
  for (const path of ['/slow', '/drip']) {
    const t0 = Date.now(), r = await N.safeFetch(at(path), { ...opts(), timeoutMs: 300 });
    assert.deepEqual([r.ok, r.why], [false, 'timeout'], path);
    assert.ok(Date.now() - t0 < 1500, path + ' gave up on time');
  }
  assert.equal(A.LIMITS.fetchMs, 8000);
});
test('safeFetch: only HTML is read; an error page is not a page', async () => {
  assert.deepEqual((r => [r.ok, r.why])(await N.safeFetch(at('/pdf'), opts())), [false, 'not_html']);
  assert.deepEqual((r => [r.ok, r.why])(await N.safeFetch(at('/403'), opts())), [false, 'http_status']);
  const q = await N.safeFetch(at('/hop/ok'), { ...opts(), follow: false });
  assert.deepEqual([q.ok, q.status, q.location, q.body], [true, 301, '/landing?x=1', undefined]);
});
test('scanSite: one homepage, read into checks; an unreachable or private site is an error, not a report', async () => {
  // https://site.example.org/ cannot be reached here (port 443 is not in the allowed test ports), so the scan
  // refuses rather than inventing a result
  const r = await N.scanSite('site.example.org', opts());
  assert.equal(r.ok, false);
  const p = await N.scanSite('internal.example.org', { resolve, timeoutMs: 800 });
  assert.equal(p.ok, false);
});

/* ---- PageSpeed ---- */
const psi = audits => ({ ok: true, json: async () => ({ lighthouseResult: { audits } }) });
const SHOT = 'data:image/jpeg;base64,' + 'QUJD'.repeat(50);
test('runPageSpeed: the lab numbers, text size and tap targets, the screenshot; works without a key; a timeout or error is null, never a fail', async () => {
  let asked = '';
  const good = await N.runPageSpeed('https://example.com/', 'KEY', { fetchImpl: async u => { asked = u; return psi({ 'largest-contentful-paint': { numericValue: 1800 }, 'cumulative-layout-shift': { numericValue: 0.25 }, 'total-byte-weight': { numericValue: 1024 * 1024 }, 'font-size': { score: 1 }, 'tap-targets': { score: 0.5 }, 'final-screenshot': { details: { data: SHOT } } }); } });
  assert.deepEqual(good, { lcpMs: 1800, cls: 0.25, weightBytes: 1048576, fontOk: true, tapOk: false, shot: SHOT });
  assert.match(asked, /url=https%3A%2F%2Fexample\.com%2F&strategy=mobile&category=performance&category=seo&key=KEY$/);
  await N.runPageSpeed('https://example.com/', '', { fetchImpl: async u => { asked = u; return psi({}); } });
  assert.ok(!asked.includes('key='), 'keyless when no key is set');
  const odd = await N.runPageSpeed('https://example.com/', '', { fetchImpl: async () => psi({ 'final-screenshot': { details: { data: 'javascript:alert(1)' } } }) });
  assert.equal(odd.shot, '', 'only an image data: URL is kept'); assert.equal(odd.tapOk, null, 'an audit Lighthouse did not run is unknown, not a fail');
  const slow = await N.runPageSpeed('https://example.com/', 'KEY', { timeoutMs: 50, fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.equal(slow, null);
  const orig = console.error; console.error = () => {};
  try { for (const bad of [async () => ({ ok: false, status: 429 }), async () => { throw new Error('down'); }]) assert.equal(await N.runPageSpeed('https://example.com/', 'KEY', { fetchImpl: bad }), null); }
  finally { console.error = orig; }
});

/* ---- the routes ---- */
const SECRET = 'test-secret-test-secret-test-secret-1234';
/* a test value, not a secret */
const SALT = 'test-salt-test-salt-test-salt-0001';
const K = name => keyedBucket(name, SALT);
const KEYED = /^site:[0-9a-f]{40}$/;
const HOST_BUCKET = () => K('site:audit-host:' + N.hashed('example.com'));
const EMAIL_BUCKET = () => K('site:audit-email:' + N.hashed('jo@reed.com'));
const SITE_BUCKET = () => K('site:audit-report-host:' + N.hashed('example.com'));
const ENV_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_LIMIT_SALT', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AUDIT_SIGNING_KEY', 'PAGESPEED_API_KEY', 'RESEND_API_KEY', 'AUDIT_FROM', 'SITE_LEAD_KEY', 'ANTHROPIC_API_KEY', 'MOCK', 'VERCEL_ENV'];
/* test values, not secrets */
const FULL = { SUPABASE_URL: 'https://db.example.org', SUPABASE_ANON_KEY: 'anon-public', SITE_LIMIT_SALT: SALT, AUDIT_SIGNING_KEY: SECRET, SITE_LEAD_KEY: 'pts_test', ANTHROPIC_API_KEY: 'sk-test' };
const realFetch = globalThis.fetch;
/** Run `fn` with exactly `env` set and fetch replaced. Returns what was fetched. */
async function world(env, fn, { hits = () => 0, limiter = 'up' } = {}) {
  const old = {}; for (const k of ENV_KEYS) { old[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const calls = [], errors = [], origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (u.includes('/rest/v1/')) {
      /* plays the CRM's public.site_hit(): true = over (nothing recorded) */
      if (limiter === 'down') return { ok: false, status: 500, json: async () => ({}) };
      if (!u.endsWith('/rest/v1/rpc/site_hit') || call.method !== 'POST') return { ok: false, status: 404, json: async () => ({}) };
      if (!/^site:[A-Za-z0-9:._-]{1,195}$/.test(call.body.p_bucket)) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hits(call.body.p_bucket) >= call.body.p_limit };
    }
    return { ok: false, status: 599, json: async () => ({}) };   // nothing else may be reached from a test
  };
  try { await fn(calls, errors); } finally { globalThis.fetch = realFetch; console.error = origErr; for (const k of ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  return calls;
}
function call(handler, body, { method = 'POST', ip = '203.0.113.9' } = {}) {
  return new Promise(resolve => {
    const out = { status: 0, headers: {}, body: undefined };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; resolve(out); return res; }, end() { resolve(out); return res; }, setHeader(k, v) { out.headers[k.toLowerCase()] = v; } };
    Promise.resolve(handler({ method, body, headers: { 'x-forwarded-for': ip } }, res)).catch(e => resolve({ status: 599, body: { thrown: String(e) } }));
  });
}
const outside = calls => calls.filter(c => !c.url.includes('/rest/v1/'));
const lim = calls => calls.filter(c => c.url.includes('/rest/v1/'));
const CRAWL = mockCrawl(2026);
const scanned = (more = {}) => ({ ok: true, data: { v: 3, host: 'example.com', at: Date.now(), https: true, redirect: 'pass', fwd: false, facts: CRAWL.facts, site: CRAWL.site, tools: CRAWL.tools, speed: null, shot: '', ...more }, pages: CRAWL.pages.map(p => p.path), stack: { platform: 'WordPress', tools: [{ name: 'Calendly', kind: 'booking' }], email: 'Google Workspace' } });
const token = (more = {}) => A.seal(scanned(more).data, SECRET);
const person = (more = {}) => ({ token: token(), name: 'Jo Reed', company: 'Reed Roofing', email: 'jo@reed.com', phone: '(316) 555-0142', src: 'ig', fax: '', ...more });
const never = async () => { throw new Error('this must not run'); };
const REPORT_URL = 'https://www.getproytech.com/report?t=abcDEF123456';
/** the report route with its three outside services stubbed, recording what each was given */
function reportWith({ crawl = async () => MOCK_SITE, claude = async () => MOCK_ANSWER, save = async () => ({ ok: true, token: 'abcDEF123456', reportUrl: REPORT_URL }) } = {}) {
  const seen = { crawl: [], claude: [], save: [] };
  const h = makeReport({ crawl: async h => { seen.crawl.push(h); return crawl(h); }, claude: async a => { seen.claude.push(a); return claude(a); }, save: async p => { seen.save.push(p); return save(p); }, now: () => Date.now() });
  return { h, seen };
}
const blocked = () => makeReport({ crawl: never, claude: never, save: never });
const MOCK_SITE = await mockSite(), MOCK_ANSWER = await mockClaude();

test('FAIL CLOSED: with the rate limiter not configured, all three routes refuse, name the variables, and touch nothing', async () => {
  for (const [name, handler, body] of [['scan', makeScan({ scan: never }), { url: 'example.com' }], ['speed', makeSpeed({ speed: never }), { token: token() }], ['report', blocked(), person()]]) {
    const env = { ...FULL }; delete env.SUPABASE_URL; delete env.SUPABASE_ANON_KEY; delete env.SITE_LIMIT_SALT;
    const calls = await world(env, async (c, errors) => {
      const r = await call(handler, body);
      assert.equal(r.status, 503, name); assert.equal(r.body.ok, false); assert.equal(r.body.error, 'not_configured');
      assert.deepEqual(r.body.missing, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_LIMIT_SALT'], name);
      assert.match(errors.join('\n'), /SUPABASE_URL, SUPABASE_ANON_KEY, SITE_LIMIT_SALT/);
    });
    assert.equal(calls.length, 0, name + ' made no network call at all');
  }
});
test('FAIL CLOSED: each route names its own missing variable; nothing falls back; email and PageSpeed keys are not needed', async () => {
  const cases = [
    ['scan', makeScan({ scan: never }), { url: 'example.com' }, ['AUDIT_SIGNING_KEY']],
    ['speed', makeSpeed({ speed: never }), { token: token() }, ['AUDIT_SIGNING_KEY']],
    ['report', blocked(), person(), ['AUDIT_SIGNING_KEY']],
    ['report', blocked(), person(), ['SITE_LEAD_KEY']],
    ['report', blocked(), person(), ['ANTHROPIC_API_KEY']],
    ['report', blocked(), person(), ['SITE_LEAD_KEY', 'ANTHROPIC_API_KEY']],
  ];
  for (const [name, handler, body, drop] of cases) {
    const env = { ...FULL }; for (const k of drop) delete env[k];
    const calls = await world(env, async () => { const r = await call(handler, body); assert.equal(r.status, 503, name); assert.deepEqual(r.body.missing, drop, name); });
    assert.equal(calls.length, 0);
  }
  await world({ ...FULL, AUDIT_SIGNING_KEY: 'short' }, async () => { const r = await call(makeScan({ scan: never }), { url: 'example.com' }); assert.equal(r.status, 503); assert.deepEqual(r.body.missing, ['AUDIT_SIGNING_KEY']); });
  /* FULL has no PAGESPEED_API_KEY, RESEND_API_KEY or AUDIT_FROM, and every route runs */
  await world(FULL, async () => {
    assert.equal((await call(makeSpeed({ speed: async () => null }), { token: token() })).status, 200);
    assert.equal((await call(reportWith().h, person())).status, 200);
  });
});
test('FAIL CLOSED: a limiter that cannot be read is a refusal, not a pass', async () => {
  for (const [handler, body] of [[makeScan({ scan: never }), { url: 'example.com' }], [makeSpeed({ speed: never }), { token: token() }], [blocked(), person()]]) {
    await world(FULL, async () => { const r = await call(handler, body); assert.equal(r.status, 503); assert.equal(r.body.error, 'limiter_unavailable'); }, { limiter: 'down' });
  }
});
test('caps: 25 reports a day in all, 3 per IP an hour, 3 per website a day, 1 per email a day; scan and speed 300 a day, 5 per IP', async () => {
  assert.deepEqual(CAPS, { perDay: 25, perIp: 3, ipWindowMin: 60, perSite: 3, perEmail: 1 });
  const cases = [
    [() => makeScan({ scan: never }), { url: 'example.com' }, 'site:audit-scan:global', 300, 'busy'], [() => makeScan({ scan: never }), { url: 'example.com' }, 'site:audit-scan:ip:203.0.113.9', 5, 'too_many'],
    [() => makeSpeed({ speed: never }), { token: token() }, 'site:audit-speed:global', 300, 'busy'], [() => makeSpeed({ speed: never }), { token: token() }, 'site:audit-speed:ip:203.0.113.9', 5, 'too_many'],
    [blocked, person(), 'site:audit-report:global', 25, 'busy'], [blocked, person(), 'site:audit-report:ip:203.0.113.9', 3, 'too_many'],
  ];
  for (const [mk, body, bucket, limit, error] of cases) {
    const calls = await world(FULL, async () => { const r = await call(mk(), body); assert.equal(r.status, 429, bucket); assert.equal(r.body.error, error); }, { hits: b => (b === K(bucket) ? limit : 0) });
    assert.equal(outside(calls).length, 0, bucket + ': nothing outside was reached');
  }
  await world(FULL, async () => { const r = await call(makeScan({ scan: never }), { url: 'example.com' }); assert.equal(r.status, 429); assert.equal(r.body.error, 'host_limit'); }, { hits: b => (b === HOST_BUCKET() ? 5 : 0) });
  await world(FULL, async () => { const r = await call(blocked(), person()); assert.equal(r.status, 429); assert.equal(r.body.error, 'already_sent'); }, { hits: b => (b === EMAIL_BUCKET() ? 1 : 0) });
  await world(FULL, async () => { const r = await call(blocked(), person()); assert.equal(r.status, 429); assert.equal(r.body.error, 'site_limit'); }, { hits: b => (b === SITE_BUCKET() ? 3 : 0) });
  /* the report's global window is a day; its IP window an hour */
  const calls = await world(FULL, async () => { await call(reportWith().h, person()); });
  const w = Object.fromEntries(lim(calls).map(c => [c.body.p_bucket, [c.body.p_window_sec, c.body.p_limit]]));
  assert.deepEqual(w[K('site:audit-report:global')], [86400, 25]); assert.deepEqual(w[K('site:audit-report:ip:203.0.113.9')], [3600, 3]);
  assert.deepEqual(w[SITE_BUCKET()], [86400, 3]); assert.deepEqual(w[EMAIL_BUCKET()], [86400, 1]);
});
test('gate: POST only, and oversized bodies are refused before anything runs', async () => {
  await world(FULL, async calls => {
    assert.equal((await call(makeScan({ scan: never }), {}, { method: 'GET' })).status, 405);
    assert.equal((await call(makeScan({ scan: never }), { url: 'a'.repeat(700) + '.com' })).status, 413);
    assert.equal((await call(blocked(), person({ shot: 'x'.repeat(N.SHOT_MAX + 7000) }))).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('audit-scan: refuses private and malformed addresses before fetching; returns a sealed result, a count and the headline misses', async () => {
  await world(FULL, async () => {
    for (const [url, error] of [['http://127.0.0.1/', 'private'], ['http://169.254.169.254/', 'private'], ['localhost', 'bad_address'], ['http://db.internal/', 'private'], ['ftp://example.com', 'bad_address'], ['', 'bad_address'], [42, 'bad_address']]) {
      const r = await call(makeScan({ scan: never }), { url });
      assert.equal(r.status, 400, String(url)); assert.equal(r.body.error, error, String(url));
    }
    let scannedHost = '';
    const r = await call(makeScan({ scan: async h => { scannedHost = h; return scanned(); } }), { url: 'https://Example.com/some/page?x=1' });
    assert.equal(r.status, 200); assert.equal(scannedHost, 'example.com', 'the homepage of the host, whatever path was typed');
    assert.deepEqual(Object.keys(r.body).sort(), ['checked', 'host', 'misses', 'needWork', 'ok', 'pages', 'stack', 'token']);
    assert.deepEqual(r.body.pages, ['/', '/services', '/contact']);
    assert.deepEqual(r.body.stack, { platform: 'WordPress', tools: ['Calendly'], email: 'Google Workspace' }, 'names only, for the progress screen');
    const sealed = A.open(r.body.token, SECRET, Date.now());
    assert.equal(sealed.site.pagesChecked, 3); assert.ok(!JSON.stringify(sealed).includes('/services'), 'no path in the token');
    assert.equal(r.body.grade, undefined, 'no grade before the details');
    assert.ok(r.body.misses.length >= 1 && r.body.misses.length <= 4);
    assert.equal(A.open(r.body.token, SECRET, Date.now()).facts.phones, 2);
    for (const [why, error] of [['private', 'private'], ['timeout', 'unreachable'], ['http_status', 'blocked'], ['not_html', 'not_html']]) {
      const bad = await call(makeScan({ scan: async () => ({ ok: false, why }) }), { url: 'example.com' });
      assert.deepEqual([bad.status, bad.body.ok, bad.body.error, bad.body.token], [200, false, error, undefined]);
    }
  });
});

test('audit-speed: only for a sealed scan; seals the numbers and the screenshot\'s hash; a failed test still returns a result', async () => {
  await world(FULL, async () => {
    for (const bad of ['', 'garbage', A.seal(scanned().data, 'another-secret-another-secret-another-1'), token().slice(0, -2) + 'AA']) {
      const r = await call(makeSpeed({ speed: never }), { token: bad });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_token');
    }
    let target = '';
    const ok = await call(makeSpeed({ speed: async t => { target = t; return { lcpMs: 5000, cls: 0, weightBytes: 1000, fontOk: true, tapOk: true, shot: SHOT }; } }), { token: token() });
    assert.equal(target, 'https://example.com/'); assert.equal(ok.body.speedRan, true); assert.equal(ok.body.shot, SHOT);
    const opened = A.open(ok.body.token, SECRET, Date.now());
    assert.equal(opened.speed.lcpMs, 5000); assert.equal(opened.shot, N.shotHash(SHOT)); assert.ok(!JSON.stringify(opened).includes('base64'));
    for (const speed of [async () => null, async () => { throw new Error('boom'); }]) {
      const r = await call(makeSpeed({ speed }), { token: token() });
      assert.deepEqual([r.status, r.body.ok, r.body.speedRan, r.body.shot], [200, true, false, '']);
      assert.equal(A.open(r.body.token, SECRET, Date.now()).speed, null);
    }
  });
});

test('audit-report: ONE review call, then the CRM gets exactly the agreed payload; the visitor gets the grade and the link', async () => {
  const { h, seen } = reportWith();
  const calls = await world(FULL, async () => {
    const r = await call(h, person({ consent: true }));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['grade', 'needWork', 'ok', 'reportUrl', 'score']);
    assert.equal(r.body.reportUrl, REPORT_URL); assert.match(r.body.grade, /^[A-F]$/);
  });
  assert.deepEqual(seen.crawl, ['example.com']); assert.equal(seen.claude.length, 1); assert.equal(seen.save.length, 1);
  assert.deepEqual(seen.claude[0].pages.map(p => p.path), ['/', '/services', '/contact'], 'the review reads every page');
  assert.match(seen.claude[0].summary, /Pages read: \/ \(home/);
  const p = seen.save[0];
  assert.deepEqual(Object.keys(p).sort(), ['lead', 'teardown']);
  assert.deepEqual(Object.keys(p.lead).sort(), ['company', 'email', 'name', 'phone', 'textConsent', 'website']);
  assert.deepEqual([p.lead.name, p.lead.company, p.lead.email, p.lead.phone, p.lead.website], ['Jo Reed', 'Reed Roofing', 'jo@reed.com', '3165550142', 'example.com']);
  assert.deepEqual(Object.keys(p.lead.textConsent).sort(), ['at', 'given', 'text']);
  assert.equal(p.lead.textConsent.given, true); assert.equal(p.lead.textConsent.text, CONSENT_TEXT); assert.ok(!Number.isNaN(Date.parse(p.lead.textConsent.at)));
  assert.deepEqual(Object.keys(p.teardown).sort(), ['builtOn', 'grade', 'report', 'score', 'slug', 'topPains']);
  assert.equal(p.teardown.slug, 'example'); assert.match(p.teardown.builtOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.teardown.topPains.length, 3); assert.equal(p.teardown.grade, p.teardown.report.grade); assert.equal(p.teardown.score, p.teardown.report.score);
  assert.equal(p.teardown.report.judgment, true); assert.equal(p.teardown.report.v, 2);
  assert.equal(p.teardown.report.journey.length, 5); assert.deepEqual(p.teardown.report.pages.map(x => x.path), ['/', '/services', '/contact']);
  assert.ok(JSON.stringify(p).length < 60000, 'fits the CRM\'s 60,000-character cap');
  assert.ok(!JSON.stringify(p).includes('"src"'), 'the contract has no src field');
  /* the email and website buckets are peeked first and recorded after the CRM has it */
  const order = lim(calls).map(c => [c.body.p_bucket, c.body.p_record]);
  assert.deepEqual(order.slice(2), [[EMAIL_BUCKET(), false], [SITE_BUCKET(), false], [EMAIL_BUCKET(), true], [SITE_BUCKET(), true]]);
});
test('audit-report: an unticked box is "not given" with no wording; only the boolean true is consent', async () => {
  for (const [consent, status] of [[undefined, 200], [false, 200], ['true', 400], [1, 400]]) {
    const { h, seen } = reportWith();
    await world(FULL, async () => {
      const r = await call(h, person(consent === undefined ? {} : { consent }));
      assert.equal(r.status, status, String(consent));
      if (status === 200) { assert.equal(seen.save[0].lead.textConsent.given, false); assert.equal(seen.save[0].lead.textConsent.text, undefined); }
      else { assert.deepEqual(r.body.fields, ['consent']); assert.equal(seen.claude.length, 0); }
    });
  }
});
test('audit-report: an unusable review is not an error: the report goes out on the rule items and says so', async () => {
  for (const claude of [async () => 'Sure! Here is my review: the site is great.', async () => null, async () => '{"items": "nope"}']) {
    const { h, seen } = reportWith({ claude });
    await world(FULL, async () => { const r = await call(h, person()); assert.equal(r.status, 200); });
    const rep = seen.save[0].teardown.report;
    assert.equal(rep.judgment, false);
    for (const it of rep.items.filter(i => ['fi_what', 'fi_action', 't_facts', 'cp_objections'].includes(i.id))) assert.equal(it.status, 'na', it.id);
    assert.ok(rep.grade, 'still graded on the rule items');
  }
  /* the site could not be read again: no review call at all, and the sealed numbers grade it */
  const { h, seen } = reportWith({ crawl: async () => null });
  await world(FULL, async () => { assert.equal((await call(h, person())).status, 200); });
  assert.equal(seen.claude.length, 0); assert.equal(seen.save[0].teardown.report.judgment, false);
  assert.equal(seen.save[0].teardown.report.items.find(i => i.id === 'j_form').status, 'partial', 'site facts from the token');
});
test('audit-report: an invented quote in the review is dropped before the CRM sees it', async () => {
  const lie = JSON.stringify({ items: { t_facts: { status: 'pass', quote: 'Over 9,000 five-star reviews', note: 'Huge social proof.' }, fi_what: { status: 'pass', quote: 'Acme Roofing', note: 'You say what you do. Your site was hacked.' } }, working: [{ text: 'You have 9,000 reviews.', quote: 'Over 9,000 five-star reviews' }] });
  const { h, seen } = reportWith({ claude: async () => lie });
  await world(FULL, async () => { assert.equal((await call(h, person())).status, 200); });
  const s = JSON.stringify(seen.save[0]);
  assert.ok(!s.includes('9,000') && !/hacked/i.test(s));
});
test('audit-report: the screenshot is used only if its hash was sealed by the speed step', async () => {
  const sealed = token({ shot: N.shotHash(SHOT) });
  for (const [shot, used] of [[SHOT, true], [SHOT.replace('QUJD', 'QUJE'), false], ['', false]]) {
    const { h, seen } = reportWith();
    await world(FULL, async () => { assert.equal((await call(h, person({ token: sealed, shot }))).status, 200); });
    assert.equal(seen.claude[0].shot, used ? SHOT : '', String(used));
  }
  const { h, seen } = reportWith();
  await world(FULL, async () => { await call(h, person({ shot: SHOT })); });
  assert.equal(seen.claude[0].shot, '', 'no hash sealed, no screenshot');
});
test('audit-report: a forged, altered or expired result, a bad field or the honeypot spends nothing', async () => {
  for (const [body, error] of [[person({ token: 'garbage' }), 'bad_token'], [person({ token: token({ at: Date.now() - A.LIMITS.tokenMaxAgeMs - 1000 }) }), 'bad_token'], [person({ evil: 1 }), 'invalid'], [person({ company: '' }), 'invalid'], [person({ phone: '555' }), 'invalid']]) {
    const calls = await world(FULL, async () => { const r = await call(blocked(), body); assert.equal(r.status, 400, error); assert.equal(r.body.error, error); });
    assert.equal(outside(calls).length, 0);
  }
  await world(FULL, async () => { const r = await call(blocked(), person({ fax: 'buy pills' })); assert.equal(r.status, 200); assert.equal(r.body.reportUrl, ''); });
});
test('audit-report: if the CRM does not take it, the visitor is told and is NOT locked out', async () => {
  const { h } = reportWith({ save: async () => ({ ok: false, status: 500 }) });
  const calls = await world(FULL, async () => { const r = await call(h, person()); assert.equal(r.status, 502); assert.equal(r.body.error, 'save_failed'); });
  assert.ok(!lim(calls).some(c => (c.body.p_bucket === EMAIL_BUCKET() || c.body.p_bucket === SITE_BUCKET()) && c.body.p_record), 'nothing recorded for the email or the site');
});

test('saveTeardown: Bearer SITE_LEAD_KEY to the CRM; refuses an answer whose link is not our report page; never throws', async () => {
  const old = process.env.SITE_LEAD_KEY; process.env.SITE_LEAD_KEY = 'pts_test';
  const orig = console.error; console.error = () => {};
  try {
    let got;
    const ok = await N.saveTeardown({ a: 1 }, { fetchImpl: async (u, init) => { got = { u, init }; return { ok: true, status: 200, json: async () => ({ ok: true, token: 'tok', reportUrl: REPORT_URL }) }; } });
    assert.deepEqual(ok, { ok: true, token: 'tok', reportUrl: REPORT_URL });
    assert.equal(got.u, 'https://proytech-crm.vercel.app/api/teardown-save'); assert.equal(got.init.method, 'POST');
    assert.equal(got.init.headers.authorization, 'Bearer pts_test'); assert.deepEqual(JSON.parse(got.init.body), { a: 1 });
    for (const url of ['https://evil.example/report?t=abcdefgh', 'javascript:alert(1)', 'https://www.getproytech.com/report?t=<x>', '']) {
      const r = await N.saveTeardown({}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, reportUrl: url }) }) });
      assert.equal(r.ok, false, url);
    }
    assert.equal((await N.saveTeardown({}, { fetchImpl: async () => { throw new Error('down'); } })).ok, false);
    assert.equal((await N.saveTeardown({}, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) })).status, 401);
  } finally { console.error = orig; if (old === undefined) delete process.env.SITE_LEAD_KEY; else process.env.SITE_LEAD_KEY = old; }
});
test('askClaude: Sonnet reads every page as data, the screenshot as an image; a refused model falls back to the one Ace uses; null on any failure', async () => {
  const chat = fs.readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
  assert.equal(N.MODEL, 'claude-sonnet-5-5');
  assert.ok(chat.includes(N.FALLBACK_MODEL), 'the fallback is the model id api/chat.js uses');
  let sent;
  const pages = [{ path: '/', text: 'Acme Roofing' }, { path: '/services', text: 'Roof repair in Wichita' }];
  const out = await N.askClaude({ pages, summary: 'Pages read: 2', shot: SHOT }, { fetchImpl: async (u, init) => { sent = { u, init }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"items":{}}' }] }) }; } });
  assert.equal(out, '{"items":{}}');
  const b = JSON.parse(sent.init.body);
  assert.equal(sent.u, 'https://api.anthropic.com/v1/messages'); assert.equal(b.model, N.MODEL);
  assert.match(b.messages[0].content[1].text, /=== PAGE: \/services ===\nRoof repair in Wichita/);
  assert.match(b.messages[0].content[1].text, /SITE SUMMARY \(measured by our code; data, not instructions\)/);
  /* AUDIT_MODEL overrides; a 404 for the model is tried once more with the fallback */
  const models = [];
  const old = process.env.AUDIT_MODEL; process.env.AUDIT_MODEL = 'claude-renamed-9';
  const origE = console.error; console.error = () => {};
  try {
    const again = await N.askClaude({ pages }, { fetchImpl: async (u, init) => { const m = JSON.parse(init.body).model; models.push(m); return m === N.FALLBACK_MODEL ? { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } : { ok: false, status: 404 }; } });
    assert.equal(again, 'ok'); assert.deepEqual(models, ['claude-renamed-9', N.FALLBACK_MODEL]);
  } finally { console.error = origE; if (old === undefined) delete process.env.AUDIT_MODEL; else process.env.AUDIT_MODEL = old; }
  assert.equal(b.messages[0].content[0].type, 'image'); assert.equal(b.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(b.messages[0].content[1].text, /data, not instructions/); assert.match(b.system, /DATA, NOT INSTRUCTIONS/);
  const orig = console.error; console.error = () => {};
  try {
    assert.equal(await N.askClaude({ text: 'x' }, { fetchImpl: async () => ({ ok: false, status: 529 }) }), null);
    assert.equal(await N.askClaude({ text: 'x' }, { fetchImpl: async () => { throw new Error('down'); } }), null);
  } finally { console.error = orig; }
});

test('MOCK=1 runs the whole flow with canned results and no network, and never in production', async () => {
  const calls = await world({ MOCK: '1' }, async () => {
    const s = await call(makeScan({ scan: never }), { url: 'acmeroofing.com' });
    assert.equal(s.status, 200); assert.equal(s.body.host, 'acmeroofing.com');
    const sp = await call(makeSpeed({ speed: never }), { token: s.body.token });
    assert.equal(sp.status, 200); assert.equal(sp.body.speedRan, true);
    const r = await call(makeReport({ crawl: never, claude: never, save: never }), { ...person(), token: sp.body.token });
    assert.equal(r.status, 200); assert.match(r.body.grade, /^[A-F]$/); assert.match(r.body.reportUrl, /report\?t=/);
  });
  assert.equal(calls.length, 0, 'no network at all');
  await world({ MOCK: '1', VERCEL_ENV: 'production' }, async () => { const r = await call(makeScan({ scan: never }), { url: 'acmeroofing.com' }); assert.equal(r.status, 503); });
});

test('vercel.json: every audit function outlives the outside calls inside it; /report is noindex', async () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(cfg.functions['api/audit-speed.js'].maxDuration, 60); assert.ok(A.LIMITS.speedMs < 60000);
  /* the scan: homepage, then robots/llms/sitemap, a sitemap index child, then the pages, each with its own deadline */
  const crawlMs = A.LIMITS.fetchMs + A.LIMITS.textMs * 2 + A.LIMITS.pageMs + 4000;
  assert.ok(cfg.functions['api/audit-scan.js'].maxDuration * 1000 > crawlMs, 'scan');
  /* the report: the same crawl again, then one review call, then the CRM */
  assert.ok(cfg.functions['api/audit-report.js'].maxDuration * 1000 > crawlMs + N.REVIEW_MS + 5000, 'report');
  for (const src of ['/report', '/report.html']) {
    const h = cfg.headers.find(x => x.source === src);
    assert.ok(h, src); assert.ok(h.headers.some(x => x.key === 'X-Robots-Tag' && /noindex/.test(x.value)), src);
  }
});

test('the limiter is the CRM\'s site_hit() on the ANON key: the service key is never read or sent', async () => {
  const env = { ...FULL, SUPABASE_SERVICE_KEY: 'svc-secret', SUPABASE_SERVICE_ROLE_KEY: 'svc-secret' }; delete env.SUPABASE_ANON_KEY;
  let calls = await world(env, async () => { const r = await call(makeScan({ scan: never }), { url: 'example.com' }); assert.equal(r.status, 503); assert.deepEqual(r.body.missing, ['SUPABASE_ANON_KEY']); });
  assert.equal(calls.length, 0);
  calls = await world({ ...FULL, SUPABASE_SERVICE_KEY: 'svc-secret' }, async () => { await call(makeScan({ scan: async () => scanned() }), { url: 'example.com' }, { ip: 'fe80::1%eth0' }); });
  const l = lim(calls);
  assert.equal(l.length, 3, 'global, per IP, per host');
  for (const c of l) {
    assert.equal(c.url, 'https://db.example.org/rest/v1/rpc/site_hit'); assert.equal(c.method, 'POST');
    assert.deepEqual(Object.keys(c.headers).sort(), ['apikey', 'content-type']); assert.equal(c.headers.apikey, 'anon-public');
    assert.match(c.body.p_bucket, KEYED); assert.equal(c.body.p_record, true);
  }
  assert.deepEqual(l.map(c => [c.body.p_bucket, c.body.p_window_sec, c.body.p_limit]),
    [[K('site:audit-scan:global'), 86400, 300], [K('site:audit-scan:ip:fe80::1%eth0'), 600, 5], [HOST_BUCKET(), 86400, 5]]);
  assert.ok(!JSON.stringify(calls).includes('svc-secret'));
  for (const f of ['_audit-net.js', 'audit-scan.js', 'audit-speed.js', 'audit-report.js']) {
    assert.ok(!/SUPABASE_SERVICE/.test(fs.readFileSync(new URL('../api/' + f, import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), f);
  }
});
test('a limiter answer that is not a plain true/false is a refusal, not a pass', async () => {
  for (const answer of [null, 'false', 0, {}]) {
    await world(FULL, async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => answer });
      const out = await call(makeScan({ scan: never }), { url: 'example.com' });
      assert.equal(out.status, 503, JSON.stringify(answer)); assert.equal(out.body.error, 'limiter_unavailable');
    });
  }
});
test('KEYED: every audit bucket is site: + 40 hex; the same name under two salts is two buckets', async () => {
  assert.notEqual(keyedBucket('site:audit-scan:global', SALT), keyedBucket('site:audit-scan:global', SALT.replace('0001', '0002')));
  const sent = async salt => lim(await world({ ...FULL, SITE_LIMIT_SALT: salt }, async () => { await call(reportWith().h, person()); })).map(c => c.body.p_bucket);
  const a = await sent(SALT), b = await sent(SALT.replace('0001', '0002'));
  assert.equal(a.length, 6, 'global, per IP, email and site asked, then recorded');
  for (const x of [...a, ...b]) assert.match(x, KEYED);
  assert.ok(!a.some(x => b.includes(x)), 'a different salt shares no bucket');
});
test('KEYED: an email address cannot be probed — neither it nor its plain hash reaches the database', async () => {
  const calls = await world(FULL, async () => { await call(reportWith().h, person()); });
  const toDb = JSON.stringify(lim(calls));
  for (const x of ['jo@reed.com', N.hashed('jo@reed.com'), 'audit-email', 'example.com', N.hashed('example.com'), '203.0.113.9', SALT]) assert.ok(!toDb.includes(x), x + ' reached the database');
  assert.ok(toDb.includes(EMAIL_BUCKET()));
});
test('MISSING SALT: all three routes refuse with not_configured naming SITE_LIMIT_SALT, and touch nothing', async () => {
  for (const salt of [undefined, '', 'too-short']) {
    for (const [handler, body] of [[makeScan({ scan: never }), { url: 'example.com' }], [makeSpeed({ speed: never }), { token: token() }], [blocked(), person()]]) {
      const env = { ...FULL }; if (salt === undefined) delete env.SITE_LIMIT_SALT; else env.SITE_LIMIT_SALT = salt;
      const calls = await world(env, async (c, errors) => {
        const r = await call(handler, body);
        assert.equal(r.status, 503); assert.equal(r.body.error, 'not_configured'); assert.deepEqual(r.body.missing, ['SITE_LIMIT_SALT']);
        assert.match(errors.join('\n'), /SITE_LIMIT_SALT/);
      });
      assert.equal(calls.length, 0);
    }
  }
});
test('FULL TABLE: site_hit\'s NULL is limiter_unavailable on every route, and is logged by readable name', async () => {
  for (const [handler, body] of [[makeScan({ scan: never }), { url: 'example.com' }], [makeSpeed({ speed: never }), { token: token() }], [blocked(), person()]]) {
    await world(FULL, async (c, errors) => {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => null });
      const r = await call(handler, body);
      assert.equal(r.status, 503); assert.equal(r.body.error, 'limiter_unavailable');
      assert.match(errors.join('\n'), /table is full; refusing site:audit-(scan|speed|report):global/);
    });
  }
});
