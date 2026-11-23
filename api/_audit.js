// api/_audit.js — the website audit's RULES. Pure: no network, no clock of its
// own, no environment. Everything here runs in plain Node (tests/audit*.test.mjs).
// The underscore prefix keeps Vercel from exposing it as a route.
//
//   validateUrl / isPublicAddress   which addresses the teardown may fetch at all
//   teaser                          what shows before the details form
//   seal / open                     the result the browser carries between routes
//   cleanContact                    the details form
//
// The rubric, the scoring and the report live in ./_rubric.js.
//
// WHAT THE CARRIED RESULT MAY HOLD: the host, the time, the scan's facts (small
// whole numbers and yes/no, for the homepage and for the site), the tools found
// (indexes into our own table), PageSpeed's numbers and the screenshot's hash.
// Never text from the audited site and never text a visitor typed.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ruleResults, teaserMisses, cleanFacts } from './_rubric.js';
import { cleanSite, cleanTools } from './_crawl.js';

export const SITE_ORIGIN = 'https://getproytech.com';
export const USER_AGENT = 'ProyTechWebsiteAudit/1.0 (+https://getproytech.com/audit)';
export const LIMITS = {
  fetchMs: 8000,            // the homepage, redirects included
  pageMs: 6000,             // each of the other pages read
  textMs: 5000,             // robots.txt, llms.txt, the sitemap
  linkMs: 4000,             // "is this link there?"
  dnsMs: 2500,              // the domain's email records
  pageBytes: 1536 * 1024,
  textBytes: 512 * 1024,
  fallbackMs: 5000,         // the plain-http retry when https does not answer
  redirectCheckMs: 4000,    // "does http forward to https"
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  speedMs: 50000,           // PageSpeed, inside a 60-second function
  tokenMaxAgeMs: 2 * 3600 * 1000,
  urlChars: 300,
};

/* ---------------------------------------------------------------- addresses */

const BLOCKED_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'invalid', 'example', 'onion', 'arpa'];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A visitor's address -> the one thing we fetch: the homepage of a public
 *  host name. { ok, host, href } or { ok:false, why }.
 *  Refused: anything but http/https, a port other than 80/443, a user:pass@,
 *  an IP address in any spelling (the URL parser normalises 2130706433 and
 *  0x7f.1 to dotted form first), single-word names, and reserved suffixes. */
export function validateUrl(input, { ports = [80, 443], maxChars = LIMITS.urlChars } = {}) {
  let s = typeof input === 'string' ? input.trim() : '';
  if (!s || s.length > maxChars || /[\s\u0000-\u001f]/.test(s)) return { ok: false, why: 'bad_address' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { ok: false, why: 'bad_address' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: 'bad_scheme' };
  if (u.username || u.password) return { ok: false, why: 'bad_address' };
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!ports.includes(port)) return { ok: false, why: 'bad_port' };
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || isIP(host)) return { ok: false, why: 'ip_literal' };
  if (host.length > 253) return { ok: false, why: 'bad_address' };
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(l => LABEL.test(l))) return { ok: false, why: 'bad_address' };
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld) || BLOCKED_SUFFIXES.includes(tld)) return { ok: false, why: 'private_name' };
  /* `path` matters only for redirect hops (a homepage that forwards to /en/);
     a visitor's own address is always audited at the root, see the routes. */
  const path = (u.pathname || '/') + (u.search || '');
  return { ok: true, host, protocol: u.protocol, port, path, href: `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${path}` };
}

const v4 = ip => ip.split('.').map(Number);
const inV4 = (a, base, bits) => { const n = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0, b = v4(base), m = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; return bits === 0 || (n >>> (32 - bits)) === (m >>> (32 - bits)); };
const V4_BLOCKED = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];

/** An IPv6 address as 8 numbers, or null. Handles '::' and a dotted tail. */
export function expandV6(ip) {
  let s = String(ip).toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) { const a = v4(dotted[1]); if (a.some(n => !(n >= 0 && n <= 255))) return null; s = s.slice(0, dotted.index) + ((a[0] << 8) | a[1]).toString(16) + ':' + ((a[2] << 8) | a[3]).toString(16); }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8 || !parts.every(p => /^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map(p => parseInt(p, 16));
}

/** May the audit connect to this IP address? Only a public, routable one.
 *  Anything it cannot parse is refused. */
export function isPublicAddress(ip) {
  const fam = isIP(String(ip || ''));
  if (fam === 4) { const a = v4(ip); return !V4_BLOCKED.some(([b, n]) => inV4(a, b, n)); }
  if (fam !== 6) return false;
  const g = expandV6(ip);
  if (!g) return false;
  const embedded = () => isPublicAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0xffff ? embedded() : false;   // ::ffff:a.b.c.d, and ::/96 (::, ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b) return false;            // NAT64
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false;   // discard
  if (g[0] === 0x2001 && (g[1] === 0xdb8 || g[1] === 0)) return false;          // documentation, Teredo
  if (g[0] === 0x2002) return false;                             // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false;                  // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false;   // link and site local
  if ((g[0] & 0xff00) === 0xff00) return false;                  // multicast
  return true;
}

/* ------------------------------------------------------------- the result */


/** What the visitor sees before the details form: how many items need work
 *  among those checked so far, and a few headline misses by name. No grade. */
export function teaser(result) {
  const r = ruleResults(result.facts, result, result.speed, result.site, result.tools);
  const checked = Object.values(r).filter(x => x.s !== 'na');
  return { needWork: checked.filter(x => x.s !== 'pass').length, checked: checked.length, misses: teaserMisses(r) };
}
/* ------------------------------------------------------- the carried result */

/** Rebuild a result from the fixed vocabulary only: a validated host, a time,
 *  the scan's facts (small numbers, ./_rubric.js cleanFacts and ./_crawl.js
 *  cleanSite), the tool indexes, PageSpeed's numbers and the screenshot's hash.
 *  Anything else is dropped. v3 is the whole-site scan; older tokens do not open. */
export function sanitizeResult(r) {
  if (!r || typeof r !== 'object' || r.v !== 3) return null;
  const v = validateUrl(typeof r.host === 'string' ? r.host : '');
  if (!v.ok || v.host !== r.host || !Number.isFinite(r.at)) return null;
  const facts = cleanFacts(r.facts);
  if (!facts) return null;
  let speed = null;
  if (r.speed && typeof r.speed === 'object') {
    const num = x => (Number.isFinite(x) && x >= 0 && x < 1e9 ? x : NaN);
    const yn = x => (x === true || x === false ? x : null);
    speed = { lcpMs: num(r.speed.lcpMs), cls: num(r.speed.cls), weightBytes: num(r.speed.weightBytes), fontOk: yn(r.speed.fontOk), tapOk: yn(r.speed.tapOk) };
  }
  const shot = typeof r.shot === 'string' && /^[0-9a-f]{64}$/.test(r.shot) ? r.shot : '';
  return { v: 3, host: v.host, at: r.at, https: r.https === true, redirect: ['pass', 'fail', 'na'].includes(r.redirect) ? r.redirect : 'na', fwd: r.fwd === true, facts, site: cleanSite(r.site), tools: cleanTools(r.tools), speed, shot };
}

const keyOf = secret => createHash('sha256').update('proytech-audit-v2:' + String(secret)).digest();
export const secretOk = s => typeof s === 'string' && s.length >= 32;

/** Seal a result so the browser can carry it between routes without being able
 *  to read or change it: AES-256-GCM, which signs as it encrypts. A token that
 *  was altered, or made with another key, does not open. */
export function seal(result, secret) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(result), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
/** The sealed result, verified, sanitized and not too old; or null. */
export function open(token, secret, now) {
  try {
    if (typeof token !== 'string' || token.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', keyOf(secret), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const r = sanitizeResult(JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')));
    if (!r || now - r.at > LIMITS.tokenMaxAgeMs || r.at - now > 5 * 60000) return null;
    return r;
  } catch { return null; }
}

/* ----------------------------------------------------------------- visitor */

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
/** The link's ?src= tag, the CRM's own rule (src/lib/nucleus.js cleanSrc). */
export const cleanSrc = v => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const ctl = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** The details form -> clean values or the names of the wrong ones.
 *  Name, business and email are required. Mobile is required and is 10 digits. Consent is true only for the boolean
 *  true: a required number is not consent, and neither is any string. */
export function cleanContact(b) {
  const x = b && typeof b === 'object' ? b : {}, errors = [];
  const name = ctl(x.name, 120), company = ctl(x.company, 120), email = ctl(x.email, 200).toLowerCase();
  let phone = (typeof x.phone === 'string' ? x.phone : '').replace(/\D/g, '');
  if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
  if (!name) errors.push('name');
  if (!company) errors.push('company');
  if (!EMAIL.test(email)) errors.push('email');
  if (phone.length !== 10) errors.push('phone');
  if (x.consent != null && typeof x.consent !== 'boolean') errors.push('consent');
  return { ok: !errors.length, errors, name, company, email, phone, consent: x.consent === true };
}
