// api/_audit-net.js — everything the website audit does over the network.
// The rules live in ./_audit.js; this file is the fetching, the rate limiter
// and the three outside services. Underscore prefix: not a route.
//
// THE FETCH IS THE DANGEROUS PART. A visitor names an address and our server
// connects to it, so the server must never be talked into reaching a private
// network (a cloud metadata address, a database, another service's admin
// page). Four rules, each tested in tests/audit-net.test.mjs:
//   1. validateUrl() on EVERY hop: http/https, ports 80/443, a public host
//      name, never an IP address typed directly.
//   2. The DNS answer is checked inside the lookup the socket itself uses, so
//      the address that was checked is the address connected to. A name that
//      answers "public" once and "private" the next time gains nothing: there
//      is one lookup. If ANY address a name resolves to is private, refuse.
//   3. After the socket connects, its remote address is checked again.
//   4. Redirects are followed by hand, at most 5, each hop through 1 to 3.
// Plus caps: a deadline for the whole fetch, a byte cap on the DECOMPRESSED
// body, HTML only, no cookies, one page.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { ipOf } from './_guard.js';
import { keyedBucket, saltOk, saltOf } from './_bucket.js';
import { validateUrl, isPublicAddress, inspectHtml, headerChecks, speedChecks, USER_AGENT, LIMITS, SPEED_IDS } from './_audit.js';

/* ------------------------------------------------------------ guarded fetch */

const refuse = (code, msg) => Object.assign(new Error(msg || code), { code });
const systemResolve = host => dns.promises.lookup(host, { all: true, verbatim: true });

/** A `lookup` for http(s).request that resolves once, refuses unless EVERY
 *  answer is a public address, and hands the socket only what it checked. */
export function checkedLookup({ resolve = systemResolve, isPublic = isPublicAddress } = {}) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    Promise.resolve().then(() => resolve(hostname)).then(list => {
      const all = (Array.isArray(list) ? list : [list]).filter(a => a && a.address);
      if (!all.length) return cb(refuse('ENOTFOUND'));
      if (!all.every(a => isPublic(a.address))) return cb(refuse('EPRIVATE', 'resolves to a private address'));
      const want = options && options.family ? all.filter(a => a.family === options.family) : all;
      const use = want.length ? want : all;
      if (options && options.all) cb(null, use.map(a => ({ address: a.address, family: a.family })));
      else cb(null, use[0].address, use[0].family);
    }, e => cb(refuse((e && e.code) || 'ENOTFOUND')));
  };
}

const TLS_CODES = /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO/;
const whyOf = e => { const c = String((e && e.code) || ''); return c === 'EPRIVATE' ? 'private' : c === 'ETIMEOUT' ? 'timeout' : TLS_CODES.test(c) ? 'tls' : 'network'; };

function requestOnce(v, { deadline, maxBytes, wantBody, resolve, isPublic }) {
  return new Promise((done, fail) => {
    const left = deadline - Date.now();
    if (left <= 0) return fail(refuse('ETIMEOUT'));
    const mod = v.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, x) => { if (!settled) { settled = true; clearTimeout(timer); fn(x); } };
    const req = mod.request({
      protocol: v.protocol, hostname: v.host, port: v.port, path: v.path, method: 'GET', agent: false,
      lookup: checkedLookup({ resolve, isPublic }),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.8', 'accept-encoding': 'gzip, deflate, br' },
    });
    const timer = setTimeout(() => { req.destroy(refuse('ETIMEOUT')); }, left);
    /* rule 3: the address the socket actually reached */
    req.on('socket', s => s.once('connect', () => { if (!isPublic(s.remoteAddress)) req.destroy(refuse('EPRIVATE', 'connected to a private address')); }));
    req.on('error', e => finish(fail, e));
    req.on('response', res => {
      const status = res.statusCode || 0, headers = res.headers || {};
      if (!wantBody || (status >= 300 && status < 400) || status < 200 || status >= 400) { res.destroy(); return finish(done, { status, headers, body: '' }); }
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(String(headers['content-type'] || ''))) { res.destroy(); return finish(done, { status, headers, body: '', notHtml: true }); }
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      const unzip = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
      const stream = unzip ? res.pipe(unzip) : res;
      const chunks = []; let size = 0, truncated = false;
      const end = () => finish(done, { status, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
      stream.on('data', ch => {
        if (truncated) return;
        size += ch.length;
        if (size > maxBytes) { truncated = true; chunks.push(ch.subarray(0, ch.length - (size - maxBytes))); res.destroy(); if (unzip) unzip.destroy(); end(); }
        else chunks.push(ch);
      });
      stream.on('end', end);
      stream.on('error', e => (truncated || chunks.length ? end() : finish(fail, e)));
      res.on('error', e => (truncated || chunks.length ? end() : finish(fail, e)));
    });
    req.end();
  });
}

/** Fetch one page safely. { ok, status, headers, body, finalUrl, https,
 *  truncated, hops } or { ok:false, why }: bad_address | private | timeout |
 *  tls | network | too_many_redirects | not_html | http_status.
 *  `follow:false` asks one question of one address and reads no body.
 *  The options past `follow` exist for the tests; the routes pass none. */
export async function safeFetch(start, { timeoutMs = LIMITS.fetchMs, maxBytes = LIMITS.maxBytes, maxRedirects = LIMITS.maxRedirects, follow = true, ports, resolve, isPublic = isPublicAddress } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = start;
  for (let hop = 0; ; hop++) {
    const v = validateUrl(current, { maxChars: 2000, ...(ports ? { ports } : {}) });     // rule 1, every hop
    if (!v.ok) return { ok: false, why: v.why === 'private_name' || v.why === 'ip_literal' ? 'private' : 'bad_address', hops: hop };
    let r;
    try { r = await requestOnce(v, { deadline, maxBytes, wantBody: follow, resolve, isPublic }); }
    catch (e) { return { ok: false, why: whyOf(e), hops: hop }; }
    const location = r.headers.location;
    if (!follow) return { ok: true, status: r.status, headers: r.headers, location: typeof location === 'string' ? location : '', finalUrl: v.href, https: v.protocol === 'https:' };
    if (r.status >= 300 && r.status < 400 && typeof location === 'string' && location) {
      if (hop >= maxRedirects) return { ok: false, why: 'too_many_redirects', hops: hop };
      try { current = new URL(location, v.href).href; } catch { return { ok: false, why: 'bad_address', hops: hop }; }
      continue;
    }
    if (r.notHtml) return { ok: false, why: 'not_html', hops: hop };
    if (r.status < 200 || r.status >= 300) return { ok: false, why: 'http_status', status: r.status, hops: hop };
    return { ok: true, status: r.status, headers: r.headers, body: r.body, truncated: !!r.truncated, finalUrl: v.href, finalHost: v.host, https: v.protocol === 'https:', hops: hop };
  }
}

const baseOf = host => host.split('.').slice(-2).join('.');

/** The homepage scan: one page, plus one question of the plain-http address.
 *  { ok, data } (data is the unsealed result, speed checks "not run") or
 *  { ok:false, why }. `opts` is passed to safeFetch (tests only). */
export async function scanSite(host, opts = {}, now = Date.now()) {
  const forward = safeFetch(`http://${host}/`, { ...opts, follow: false, timeoutMs: LIMITS.redirectCheckMs });
  let page = await safeFetch(`https://${host}/`, opts);
  if (!page.ok && ['tls', 'network', 'timeout'].includes(page.why)) {
    const plain = await safeFetch(`http://${host}/`, { ...opts, timeoutMs: LIMITS.fallbackMs });
    if (plain.ok || plain.why === 'private') page = plain;
  }
  const fwd0 = await forward.catch(() => ({ ok: false }));
  if (!page.ok) return { ok: false, why: page.why };
  const isHttps = page.https;
  const checks = { https: isHttps ? { s: 'pass', c: 'ok' } : { s: 'fail', c: 'no_https' }, ...inspectHtml(page.body, { https: isHttps }), ...headerChecks(page.headers, { https: isHttps }) };
  checks.http_redirect = !isHttps ? { s: 'na', c: 'no_https' }
    : !fwd0.ok ? { s: 'na', c: 'no_answer' }
    : fwd0.status >= 300 && fwd0.status < 400 && /^https:\/\//i.test(fwd0.location) ? { s: 'pass', c: 'ok' }
    : fwd0.status >= 200 && fwd0.status < 400 ? { s: 'fail', c: 'stays_http' } : { s: 'na', c: 'no_answer' };
  for (const id of SPEED_IDS) checks[id] = { s: 'na', c: 'not_run' };
  return { ok: true, data: { v: 1, host, at: now, https: isHttps, fwd: baseOf(page.finalHost) !== baseOf(host), checks } };
}

/* -------------------------------------------------------------- PageSpeed */

/** One Google PageSpeed Insights lab run on a phone profile. Returns the
 *  three speed checks; a timeout or an error is "could not run", never a fail. */
export async function runPageSpeed(target, key, { timeoutMs = LIMITS.speedMs, fetchImpl = fetch } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const u = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
    const r = await fetchImpl(u, { signal: ctl.signal });
    if (!r.ok) { console.error('[audit-speed] PageSpeed answered', r.status); return speedChecks(null, 'error'); }
    const a = ((await r.json()).lighthouseResult || {}).audits || {};
    const num = id => (a[id] && typeof a[id].numericValue === 'number' ? a[id].numericValue : NaN);
    return speedChecks({ lcpMs: num('largest-contentful-paint'), cls: num('cumulative-layout-shift'), weightBytes: num('total-byte-weight') });
  } catch (e) {
    return speedChecks(null, e && e.name === 'AbortError' ? 'timeout' : 'error');
  } finally { clearTimeout(timer); }
}

/* ---------------------------------------------------- rate limits, CLOSED */

/* The audit routes spend money (PageSpeed, email) and fetch other people's
   servers, so they FAIL CLOSED: no limiter, no run. The site's shared guard
   (_guard.js) lets its form routes through instead; that is its choice for
   them, not this file's.

   The limiter is the CRM's public.site_hit() (SITE-HIT-MIGRATION.sql), called
   with the CRM's PUBLIC anon key, NEVER the service key: the service key is
   not read here under any name. site_hit counts a "site:" bucket and answers
   true (over, nothing recorded) or false (under, recorded), in one database
   call under a per-bucket lock, and deletes old rows itself. The anon key can
   do nothing else in that database. Read per call, not at import.

   EVERY BUCKET IS KEYED (_bucket.js, shared with _guard.js): the database
   sees "site:" + 40 hex of HMAC-SHA256 with SITE_LIMIT_SALT, never a
   readable name. Without the salt nobody can name the per-site or
   per-address counter, so an email address cannot be probed ("was it sent a
   report today?") and a daily cap cannot be filled from outside. The
   readable names (which already hash the host and the address, so no
   address is ever in a log) appear only in our logs. */
const supa = () => ({ url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '', key: process.env.SUPABASE_ANON_KEY || '' });
export const limiterMissing = () => { const s = supa(), m = []; if (!s.url) m.push('SUPABASE_URL'); if (!s.key) m.push('SUPABASE_ANON_KEY'); if (!saltOk(saltOf())) m.push('SITE_LIMIT_SALT'); return m; };
export const hashed = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

/** One call to site_hit() for the counter called `name` (readable; keyed
 *  before it leaves). 'ok' | 'limit' | 'down' (also: not configured, or
 *  site_hit's NULL, its table is full). `record: false` asks
 *  "is it at the limit?" and records nothing. The key goes on `apikey` only:
 *  a publishable key on Authorization is parsed as a JWT and refused. */
export async function hit(name, limit, windowMin, { record = true } = {}) {
  const s = supa();
  if (limiterMissing().length) return 'down';
  const bucket = keyedBucket(name);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${s.url.replace(/\/+$/, '')}/rest/v1/rpc/site_hit`, { method: 'POST', signal: ctl.signal,
      headers: { apikey: s.key, 'content-type': 'application/json' },
      body: JSON.stringify({ p_bucket: bucket, p_window_sec: Math.round(windowMin * 60), p_limit: limit, p_record: !!record }) });
    if (!r.ok) { console.error(`[audit] the limiter answered ${r.status} for ${name}`); return 'down'; }
    const over = await r.json();
    if (over === null) console.error(`[audit] the limiter's table is full; refusing ${name}`);
    return over === true ? 'limit' : over === false ? 'ok' : 'down';
  } catch { return 'down'; } finally { clearTimeout(timer); }
}
/** Counts, and records this hit when under the limit. */
export const take = (bucket, limit, windowMin) => hit(bucket, limit, windowMin);
/** Only asks whether the bucket is at the limit; records nothing. */
export const peek = (bucket, limit, windowMin) => hit(bucket, limit, windowMin, { record: false });

/** The gate every audit route calls first. It answers the request itself and
 *  returns { ok:false } unless: it is a POST, every variable in `need` and the
 *  limiter's own two are set (503 naming the missing ones), the body is small,
 *  and both the global daily cap and the per-IP limit have room. An unreadable
 *  limiter is a refusal, not a pass. */
export async function auditGate(req, res, { name, perIp, windowMin, perDay, maxChars, need = [] }) {
  const send = (code, body) => { res.status(code).json(body); return { ok: false }; };
  if (req.method === 'OPTIONS') { res.status(204).end(); return { ok: false }; }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { ok: false, error: 'method' }); }
  const missing = [...limiterMissing(), ...need.filter(k => !process.env[k])];
  if (missing.length) {
    console.error(`[${name}] refusing to run: not set on this project: ${missing.join(', ')}`);
    return send(503, { ok: false, error: 'not_configured', missing });
  }
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (raw.length > maxChars) return send(413, { ok: false, error: 'too_large' });
  const day = await take(`site:${name}:global`, perDay, 60 * 24);
  if (day === 'down') return send(503, { ok: false, error: 'limiter_unavailable' });
  if (day === 'limit') { console.error(`[${name}] DAILY CAP HIT`); return send(429, { ok: false, error: 'busy' }); }
  const ip = ipOf(req), one = await take(`site:${name}:ip:${ip}`, perIp, windowMin);
  if (one === 'down') return send(503, { ok: false, error: 'limiter_unavailable' });
  if (one === 'limit') { res.setHeader('retry-after', String(windowMin * 60)); return send(429, { ok: false, error: 'too_many' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return { ok: true, ip, body: body && typeof body === 'object' && !Array.isArray(body) ? body : {} };
}

/* ------------------------------------------------------- email and the CRM */

export const CRM_SITE_LEAD = 'https://proytech-crm.vercel.app/api/site-lead';
/** "Name <a@b.co>" or "a@b.co": what Resend takes as a sender. */
export const fromOk = v => typeof v === 'string' && /^(?:[^<>@\r\n]{1,80}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(v.trim());

/** Send through Resend. { ok } or { ok:false, status }. Never throws. */
export async function sendEmail({ to, subject, html, text }) {
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.AUDIT_FROM.trim(), to: [to], subject, html, text }) });
    if (!r.ok) console.error('[audit-report] Resend answered', r.status);
    return { ok: r.ok, status: r.status };
  } catch (e) { console.error('[audit-report] Resend unreachable'); return { ok: false, status: 0 }; }
}
/** Post the lead to the CRM's site-lead route with this site's intake key. */
export async function postLead(payload) {
  try {
    const r = await fetch(CRM_SITE_LEAD, { method: 'POST', headers: { authorization: `Bearer ${process.env.SITE_LEAD_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) console.error('[audit-report] LEAD NOT SAVED: the CRM answered', r.status);
    return { ok: r.ok, status: r.status };
  } catch (e) { console.error('[audit-report] LEAD NOT SAVED: the CRM could not be reached'); return { ok: false, status: 0 }; }
}
