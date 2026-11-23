// tests/audit-net.test.mjs — the audit's fetch, rate limiter and three routes.
// Plain node. The only sockets opened are to a throwaway server on 127.0.0.1;
// Supabase, PageSpeed, Resend and the CRM are a stubbed fetch.
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import * as A from '../api/_audit.js';
import * as N from '../api/_audit-net.js';
import { makeHandler as makeScan } from '../api/audit-scan.js';
import { makeHandler as makeSpeed } from '../api/audit-speed.js';
import { makeHandler as makeReport } from '../api/audit-report.js';

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
test('runPageSpeed: reads the three lab numbers; a timeout or an error is "could not run", never a fail', async () => {
  let asked = '';
  const good = await N.runPageSpeed('https://example.com/', 'KEY', { fetchImpl: async u => { asked = u; return psi({ 'largest-contentful-paint': { numericValue: 1800 }, 'cumulative-layout-shift': { numericValue: 0.25 }, 'total-byte-weight': { numericValue: 1024 * 1024 } }); } });
  assert.deepEqual(good, { lcp: { s: 'pass', c: 'ok', n: 1800 }, cls: { s: 'fail', c: 'shifts', n: 250 }, weight: { s: 'pass', c: 'ok', n: 1024 } });
  assert.match(asked, /url=https%3A%2F%2Fexample\.com%2F&strategy=mobile&category=performance&key=KEY$/);
  const slow = await N.runPageSpeed('https://example.com/', 'KEY', { timeoutMs: 50, fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  for (const id of A.SPEED_IDS) assert.deepEqual(slow[id], { s: 'na', c: 'timeout' });
  const orig = console.error; console.error = () => {};
  try {
    for (const bad of [async () => ({ ok: false, status: 429 }), async () => { throw new Error('down'); }, async () => psi({})]) {
      const r = await N.runPageSpeed('https://example.com/', 'KEY', { fetchImpl: bad });
      for (const id of A.SPEED_IDS) assert.equal(r[id].s, 'na', id);
    }
  } finally { console.error = orig; }
});

/* ---- the routes ---- */
const SECRET = 'test-secret-test-secret-test-secret-1234';
const ENV_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AUDIT_SIGNING_KEY', 'PAGESPEED_API_KEY', 'RESEND_API_KEY', 'AUDIT_FROM', 'SITE_LEAD_KEY'];
const FULL = { SUPABASE_URL: 'https://db.example.org', SUPABASE_ANON_KEY: 'anon-public', AUDIT_SIGNING_KEY: SECRET, PAGESPEED_API_KEY: 'psi', RESEND_API_KEY: 're_x', AUDIT_FROM: 'ProyTech <audit@getproytech.com>', SITE_LEAD_KEY: 'pts_x' };
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
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'x' }) };
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
const goodChecks = () => Object.fromEntries(A.CHECK_IDS.map(id => [id, A.SPEED_IDS.includes(id) ? { s: 'na', c: 'not_run' } : { s: 'pass', c: 'ok' }]));
const scanned = (over = {}) => ({ ok: true, data: { v: 1, host: 'example.com', at: Date.now(), https: true, fwd: false, checks: { ...goodChecks(), ...over } } });
const token = (over = {}) => A.seal(scanned(over).data, SECRET);
const person = (more = {}) => ({ token: token(), name: 'Jo Reed', email: 'jo@reed.com', phone: '(316) 555-0142', src: 'ig', fax: '', ...more });
const neverScan = async () => { throw new Error('the scan must not run'); };

test('FAIL CLOSED: with the rate limiter not configured, all three routes refuse, name the variables, and touch nothing', async () => {
  for (const [name, handler, body] of [['scan', makeScan({ scan: neverScan }), { url: 'example.com' }], ['speed', makeSpeed({ speed: neverScan }), { token: token() }], ['report', makeReport({ email: neverScan, lead: neverScan }), person()]]) {
    const env = { ...FULL }; delete env.SUPABASE_URL; delete env.SUPABASE_ANON_KEY;
    const calls = await world(env, async (c, errors) => {
      const r = await call(handler, body);
      assert.equal(r.status, 503, name); assert.equal(r.body.ok, false); assert.equal(r.body.error, 'not_configured');
      assert.deepEqual(r.body.missing, ['SUPABASE_URL', 'SUPABASE_ANON_KEY'], name);
      assert.match(errors.join('\n'), /SUPABASE_URL, SUPABASE_ANON_KEY/);
    });
    assert.equal(calls.length, 0, name + ' made no network call at all');
  }
});
test('FAIL CLOSED: each route names its own missing variable; nothing falls back', async () => {
  const cases = [
    ['scan', makeScan({ scan: neverScan }), { url: 'example.com' }, ['AUDIT_SIGNING_KEY']],
    ['speed', makeSpeed({ speed: neverScan }), { token: token() }, ['PAGESPEED_API_KEY']],
    ['report', makeReport({ email: neverScan, lead: neverScan }), person(), ['RESEND_API_KEY']],
    ['report', makeReport({ email: neverScan, lead: neverScan }), person(), ['AUDIT_FROM']],
    ['report', makeReport({ email: neverScan, lead: neverScan }), person(), ['SITE_LEAD_KEY']],
    ['report', makeReport({ email: neverScan, lead: neverScan }), person(), ['RESEND_API_KEY', 'AUDIT_FROM']],
  ];
  for (const [name, handler, body, drop] of cases) {
    const env = { ...FULL }; for (const k of drop) delete env[k];
    const calls = await world(env, async () => { const r = await call(handler, body); assert.equal(r.status, 503, name); assert.deepEqual(r.body.missing, drop, name); });
    assert.equal(calls.length, 0);
  }
  await world({ ...FULL, AUDIT_FROM: 'not an address' }, async () => { const r = await call(makeReport({ email: neverScan, lead: neverScan }), person()); assert.equal(r.status, 503); assert.deepEqual(r.body.missing, ['AUDIT_FROM']); });
  await world({ ...FULL, AUDIT_SIGNING_KEY: 'short' }, async () => { const r = await call(makeScan({ scan: neverScan }), { url: 'example.com' }); assert.equal(r.status, 503); assert.deepEqual(r.body.missing, ['AUDIT_SIGNING_KEY']); });
});
test('FAIL CLOSED: a limiter that cannot be read is a refusal, not a pass', async () => {
  for (const [handler, body] of [[makeScan({ scan: neverScan }), { url: 'example.com' }], [makeSpeed({ speed: neverScan }), { token: token() }], [makeReport({ email: neverScan, lead: neverScan }), person()]]) {
    await world(FULL, async () => { const r = await call(handler, body); assert.equal(r.status, 503); assert.equal(r.body.error, 'limiter_unavailable'); }, { limiter: 'down' });
  }
});
test('rate limits: the daily caps and per-IP limits are the agreed numbers', async () => {
  const cases = [
    [makeScan({ scan: neverScan }), { url: 'example.com' }, 'site:audit-scan:global', 300, 'busy'], [makeScan({ scan: neverScan }), { url: 'example.com' }, 'site:audit-scan:ip:203.0.113.9', 5, 'too_many'],
    [makeSpeed({ speed: neverScan }), { token: token() }, 'site:audit-speed:global', 300, 'busy'], [makeSpeed({ speed: neverScan }), { token: token() }, 'site:audit-speed:ip:203.0.113.9', 5, 'too_many'],
    [makeReport({ email: neverScan, lead: neverScan }), person(), 'site:audit-report:global', 200, 'busy'], [makeReport({ email: neverScan, lead: neverScan }), person(), 'site:audit-report:ip:203.0.113.9', 3, 'too_many'],
  ];
  for (const [handler, body, bucket, limit, error] of cases) {
    await world(FULL, async () => { const r = await call(handler, body); assert.equal(r.status, 429, bucket); assert.equal(r.body.error, error); }, { hits: b => (b === bucket ? limit : 0) });
    // one under the limit gets past this bucket (and then fails later for its own reasons, never with 429 from it)
    await world(FULL, async () => { const r = await call(handler, body); assert.notEqual(r.body && r.body.error, error, bucket + ' at limit-1'); }, { hits: b => (b === bucket ? limit - 1 : 0) }).catch(() => {});
  }
  await world(FULL, async () => { const r = await call(makeScan({ scan: neverScan }), { url: 'example.com' }); assert.equal(r.status, 429); assert.equal(r.body.error, 'host_limit'); }, { hits: b => (b.startsWith('site:audit-host:') ? 5 : 0) });
  await world(FULL, async () => { const r = await call(makeReport({ email: neverScan, lead: neverScan }), person()); assert.equal(r.status, 429); assert.equal(r.body.error, 'already_sent'); }, { hits: b => (b.startsWith('site:audit-email:') ? 1 : 0) });
});
test('gate: POST only, and oversized bodies are refused before anything runs', async () => {
  await world(FULL, async calls => {
    assert.equal((await call(makeScan({ scan: neverScan }), {}, { method: 'GET' })).status, 405);
    assert.equal((await call(makeScan({ scan: neverScan }), { url: 'a'.repeat(700) + '.com' })).status, 413);
    assert.equal((await call(makeReport({ email: neverScan, lead: neverScan }), person({ name: 'x'.repeat(9000) }))).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('audit-scan: refuses private and malformed addresses before fetching; returns a sealed result and a teaser', async () => {
  await world(FULL, async () => {
    for (const [url, error] of [['http://127.0.0.1/', 'private'], ['http://169.254.169.254/', 'private'], ['localhost', 'bad_address'], ['http://db.internal/', 'private'], ['ftp://example.com', 'bad_address'], ['', 'bad_address'], [42, 'bad_address']]) {
      const r = await call(makeScan({ scan: neverScan }), { url });
      assert.equal(r.status, 400, String(url)); assert.equal(r.body.error, error, String(url));
    }
    let scannedHost = '';
    const r = await call(makeScan({ scan: async h => { scannedHost = h; return scanned({ title: { s: 'fail', c: 'long', n: 90 } }); } }), { url: 'https://Example.com/some/page?x=1' });
    assert.equal(r.status, 200); assert.equal(scannedHost, 'example.com', 'the homepage of the host, whatever path was typed');
    assert.deepEqual(Object.keys(r.body).sort(), ['checks', 'host', 'needWork', 'ok', 'ran', 'token']);
    assert.equal(r.body.needWork, 1); assert.equal(r.body.grade, undefined, 'no grade before the gate');
    assert.ok(!JSON.stringify(r.body.checks).includes('long'), 'no details before the gate');
    assert.equal(A.open(r.body.token, SECRET, Date.now()).checks.title.c, 'long');
    for (const [why, error] of [['private', 'private'], ['timeout', 'unreachable'], ['http_status', 'blocked'], ['not_html', 'not_html']]) {
      const bad = await call(makeScan({ scan: async () => ({ ok: false, why }) }), { url: 'example.com' });
      assert.deepEqual([bad.status, bad.body.ok, bad.body.error, bad.body.token], [200, false, error, undefined]);
    }
  });
});

test('audit-speed: only for a sealed scan; a timeout still returns a result with speed "could not run"', async () => {
  await world(FULL, async () => {
    for (const bad of ['', 'garbage', A.seal(scanned().data, 'another-secret-another-secret-another-1'), token().slice(0, -2) + 'AA']) {
      const r = await call(makeSpeed({ speed: neverScan }), { token: bad });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_token');
    }
    let target = '';
    const ok = await call(makeSpeed({ speed: async t => { target = t; return A.speedChecks({ lcpMs: 5000, cls: 0, weightBytes: 1000 }); } }), { token: token() });
    assert.equal(target, 'https://example.com/'); assert.equal(ok.body.speedRan, true); assert.equal(ok.body.needWork, 1); assert.equal(ok.body.ran, 16);
    assert.equal(A.open(ok.body.token, SECRET, Date.now()).checks.lcp.n, 5000);
    for (const speed of [async () => A.speedChecks(null, 'timeout'), async () => { throw new Error('boom'); }, async () => null]) {
      const r = await call(makeSpeed({ speed }), { token: token() });
      assert.deepEqual([r.status, r.body.ok, r.body.speedRan, r.body.needWork, r.body.ran], [200, true, false, 0, 13]);
      const opened = A.open(r.body.token, SECRET, Date.now());
      for (const id of A.SPEED_IDS) assert.equal(opened.checks[id].s, 'na');
      assert.equal(A.gradeOf(opened.checks).grade, 'A', 'a missing speed test does not lower the grade');
    }
  });
});

test('audit-report: emails the report through Resend and posts the lead to the CRM as it works today', async () => {
  const calls = await world(FULL, async () => {
    const r = await call(makeReport(), person({ token: token({ title: { s: 'fail', c: 'long', n: 90 } }), consent: true }));
    assert.deepEqual(r.body, { ok: true, grade: 'A', needWork: 1, ran: 13, notRun: ['Main content appears quickly', 'Page holds still while loading', 'Page weight'] });
  });
  const [mail, lead] = outside(calls);
  assert.equal(outside(calls).length, 2);
  assert.equal(mail.url, 'https://api.resend.com/emails'); assert.equal(mail.headers.authorization, 'Bearer re_x');
  assert.deepEqual(Object.keys(mail.body), ['from', 'to', 'subject', 'html', 'text']);
  assert.equal(mail.body.from, 'ProyTech <audit@getproytech.com>'); assert.deepEqual(mail.body.to, ['jo@reed.com']);
  assert.equal(mail.body.subject, 'Your website report for example.com');
  assert.match(mail.body.html, /Your website report, Jo</);
  for (const typed of ['Reed', 'jo@reed.com', '3165550142', '555-0142']) assert.ok(!mail.body.html.includes(typed) && !mail.body.text.includes(typed), typed);
  assert.equal(lead.url, 'https://proytech-crm.vercel.app/api/site-lead'); assert.equal(lead.headers.authorization, 'Bearer pts_x');
  assert.deepEqual(Object.keys(lead.body), ['kind', 'source', 'form', 'name', 'email', 'phone', 'page', 'message']);
  assert.equal(lead.body.source, 'Website audit'); assert.equal(lead.body.name, 'Jo Reed'); assert.equal(lead.body.phone, '3165550142');
  assert.match(lead.body.page, /audit\?src=ig \(audited example\.com\)/); assert.match(lead.body.message, /Text consent box: TICKED\./);
  const email = calls.filter(c => c.body && String(c.body.p_bucket).startsWith('site:audit-email:'));
  assert.deepEqual(email.map(c => [c.body.p_limit, c.body.p_window_sec, c.body.p_record]), [[1, 86400, false], [1, 86400, true]], 'asked before the send, recorded after it');
  assert.ok(calls.indexOf(email[0]) < calls.indexOf(mail) && calls.indexOf(mail) < calls.indexOf(email[1]));
});
test('audit-report: the number is required and goes to the CRM either way; an unticked box is said in words and is not consent', async () => {
  await world(FULL, async () => {
    const sent = [];
    const h = makeReport({ email: async () => ({ ok: true }), lead: async p => { sent.push(p); return { ok: true }; } });
    for (const phone of ['', '555-0142', undefined]) { const r = await call(h, person({ phone })); assert.equal(r.status, 400); assert.deepEqual(r.body, { ok: false, error: 'invalid', fields: ['phone'] }); }
    assert.deepEqual((await call(h, person({ email: 'nope' }))).body.fields, ['email']);
    assert.deepEqual((await call(h, person({ consent: 'yes' }))).body.fields, ['consent']);
    assert.equal(sent.length, 0);
    for (const consent of [undefined, false]) await call(h, person(consent === undefined ? {} : { consent }));
    assert.equal(sent.length, 2);
    for (const p of sent) { assert.equal(p.phone, '3165550142'); assert.match(p.message, /Text consent box: NOT ticked \(do not text this number\)\./); assert.equal(p.fields, undefined); }
  });
});
test('audit-report: a forged, altered or expired result sends nothing; neither does anything the browser adds', async () => {
  const stale = A.seal({ ...scanned().data, at: Date.now() - A.LIMITS.tokenMaxAgeMs - 1000 }, SECRET);
  const plain = Buffer.from(JSON.stringify(scanned().data)).toString('base64url');
  const calls = await world(FULL, async () => {
    const h = makeReport();
    for (const bad of ['', 'garbage', plain, stale, token().slice(0, 40) + 'AAAA' + token().slice(44), A.seal(scanned().data, 'another-secret-another-secret-another-1')]) {
      const r = await call(h, person({ token: bad }));
      assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_token');
    }
    for (const extra of [{ html: '<b>hi</b>' }, { subject: 'Buy now' }, { to: 'victim@example.org' }, { message: 'spam' }, { checks: {} }]) {
      const r = await call(h, person(extra));
      assert.equal(r.status, 400); assert.deepEqual(r.body, { ok: false, error: 'invalid', fields: Object.keys(extra) });
    }
  });
  assert.equal(outside(calls).length, 0, 'no email and no lead');
});
test('audit-report: honeypot, failed email, failed CRM', async () => {
  let calls = await world(FULL, async () => { const r = await call(makeReport(), person({ fax: '555' })); assert.deepEqual(r.body, { ok: true, grade: null, needWork: 0, ran: 0, notRun: [] }); });
  assert.equal(outside(calls).length, 0, 'a filled honeypot looks like success and does nothing');

  let leads = 0;
  calls = await world(FULL, async () => {
    const r = await call(makeReport({ email: async () => ({ ok: false, status: 500 }), lead: async () => { leads++; return { ok: true }; } }), person());
    assert.equal(r.status, 502); assert.deepEqual(r.body, { ok: false, error: 'email_failed' });
  });
  assert.equal(leads, 0, 'no lead without a report, so a retry cannot duplicate one');
  assert.ok(!calls.some(c => c.method === 'POST' && c.body && String(c.body.bucket).startsWith('site:audit-email:')), 'a failed send does not use up the address\'s one report');

  await world(FULL, async (c, errors) => {
    const r = await call(makeReport({ email: async () => ({ ok: true }), lead: async () => ({ ok: false, status: 502 }) }), person());
    assert.equal(r.status, 200); assert.equal(r.body.ok, true);
    assert.match(errors.join('\n'), /LEAD NOT SAVED for an audit of example\.com/);
  });
});
test('the speed function has its 60 seconds, and the test inside it stops first', async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(cfg.functions['api/audit-speed.js'].maxDuration, 60);
  assert.ok(A.LIMITS.speedMs < 60000);
});

test('the limiter is the CRM\'s site_hit() on the ANON key: the service key is never read or sent', async () => {
  /* the service key alone does not configure the limiter */
  const env = { ...FULL, SUPABASE_SERVICE_KEY: 'svc-secret', SUPABASE_SERVICE_ROLE_KEY: 'svc-secret' }; delete env.SUPABASE_ANON_KEY;
  let calls = await world(env, async () => { const r = await call(makeScan({ scan: neverScan }), { url: 'example.com' }); assert.equal(r.status, 503); assert.deepEqual(r.body.missing, ['SUPABASE_ANON_KEY']); });
  assert.equal(calls.length, 0);
  /* configured: every limiter call is POST rpc/site_hit, the key on apikey only, buckets site_hit accepts */
  calls = await world({ ...FULL, SUPABASE_SERVICE_KEY: 'svc-secret' }, async () => { await call(makeScan({ scan: async () => scanned() }), { url: 'example.com' }, { ip: 'fe80::1%eth0' }); });
  const lim = calls.filter(c => c.url.includes('/rest/v1/'));
  assert.equal(lim.length, 3, 'global, per IP, per host');
  for (const c of lim) {
    assert.equal(c.url, 'https://db.example.org/rest/v1/rpc/site_hit'); assert.equal(c.method, 'POST');
    assert.deepEqual(Object.keys(c.headers).sort(), ['apikey', 'content-type']); assert.equal(c.headers.apikey, 'anon-public');
    assert.match(c.body.p_bucket, /^site:[A-Za-z0-9:._-]{1,195}$/); assert.equal(c.body.p_record, true);
  }
  assert.deepEqual(lim.map(c => [c.body.p_bucket.replace(/[0-9a-f]{32}$/, 'H'), c.body.p_window_sec, c.body.p_limit]),
    [['site:audit-scan:global', 86400, 300], ['site:audit-scan:ip:fe80::1_eth0', 600, 5], ['site:audit-host:H', 86400, 5]]);
  assert.ok(!JSON.stringify(calls).includes('svc-secret'));
  for (const f of ['_audit-net.js', 'audit-scan.js', 'audit-speed.js', 'audit-report.js']) {
    assert.ok(!/SUPABASE_SERVICE/.test(fs.readFileSync(new URL('../api/' + f, import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), f);
  }
});
test('a limiter answer that is not a plain true/false is a refusal, not a pass', async () => {
  const old = globalThis.fetch;
  for (const answer of [null, 'false', 0, {}]) {
    const r = await world(FULL, async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => answer });
      const out = await call(makeScan({ scan: neverScan }), { url: 'example.com' });
      assert.equal(out.status, 503, JSON.stringify(answer)); assert.equal(out.body.error, 'limiter_unavailable');
    });
  }
  globalThis.fetch = old;
});
