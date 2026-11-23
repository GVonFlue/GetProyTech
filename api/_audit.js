// api/_audit.js — the website audit's RULES. Pure: no network, no clock of its
// own, no environment. Everything here runs in plain Node (tests/audit*.test.mjs).
// The underscore prefix keeps Vercel from exposing it as a route.
//
//   validateUrl / isPublicAddress   which addresses the audit may fetch at all
//   inspectHtml / headerChecks      what is read off the homepage
//   gradeOf                         the one grading rule
//   seal / open                     the result the browser carries between routes
//   renderReport                    the email
//   leadPayload                     what goes to the CRM's site-lead route
//
// WHAT A CHECK RESULT MAY HOLD: a status, a short code from a fixed list, and
// one number. Never text from the audited site and never text a visitor typed.
// The email is assembled from fixed sentences chosen by those codes, so a page
// title or a form field cannot put words into an email we send.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export const SITE_ORIGIN = 'https://getproytech.com';
export const USER_AGENT = 'ProyTechWebsiteAudit/1.0 (+https://getproytech.com/audit)';
export const LIMITS = {
  fetchMs: 8000,            // the homepage, redirects included
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

/* ------------------------------------------------------------------- checks */

export const AREAS = ['Secure connection', 'Search basics', 'On a phone', 'Contact and next step', 'Speed'];
const jsNote = 'Your homepage is built in the browser by a script, so our outside check could not read this part.';
const speedNote = 'Speed could not be measured today.';
const secs = ms => (Math.round(ms / 100) / 10).toFixed(1);
const mb = kb => (Math.round(kb / 102.4) / 10).toFixed(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* id, area, name, then the fixed sentences. `n` is the check's one number. */
export const CHECKS = [
  { id: 'https', area: 0, name: 'Loads over https',
    pass: () => 'Your homepage loads over https, the padlock connection.',
    fail: () => 'Your homepage did not load over https when we tried, so browsers can label it "Not secure".',
    fix: 'Turn on https for your domain. Most hosts include it.' },
  { id: 'http_redirect', area: 0, name: 'Old http address forwards to https',
    pass: () => 'The plain http address forwards to the https one.',
    fail: () => 'The plain http address still answers without forwarding to https.',
    fix: 'Forward every http address to https.',
    na: { no_answer: 'The plain http address did not answer us, so we could not check this.', no_https: 'This only applies once https is on.' } },
  { id: 'hsts', area: 0, name: 'Tells browsers to always use https',
    pass: () => 'Your site tells browsers to always use https (the HSTS header).',
    fail: () => 'Your site does not send the header that tells browsers to always use https (HSTS).',
    fix: 'Add the Strict-Transport-Security header.',
    na: { no_https: 'This only applies once https is on.' } },
  { id: 'mixed', area: 0, name: 'Nothing loads over plain http',
    pass: () => 'Nothing on the homepage is loaded over plain http.',
    fail: n => `${plural(n, 'item', 'items')} on the homepage (images, scripts or styles) ${n === 1 ? 'is' : 'are'} loaded over plain http.`,
    fix: 'Change those addresses to https.',
    na: { no_https: 'This only applies once https is on.' } },
  { id: 'headers', area: 0, name: 'Common protective headers',
    pass: () => 'Two common protective headers are set (X-Content-Type-Options and a framing rule).',
    fail: n => `${n} of 2 common protective headers ${n === 1 ? 'is' : 'are'} not set (X-Content-Type-Options and a framing rule). That is a setting to tidy up, not a sign that anything is wrong today.`,
    fix: 'Ask your host or developer to add them.' },
  { id: 'title', area: 1, name: 'Page title',
    pass: n => `Your homepage has a title, ${n} characters long.`,
    fail: (n, c) => c === 'missing' ? 'Your homepage has no title. The title is the headline a search result usually shows.'
      : c === 'short' ? `Your homepage title is only ${plural(n, 'character', 'characters')} long.`
      : `Your homepage title is ${n} characters long, so a search result will likely cut it off.`,
    fix: 'Write a title of about 10 to 65 characters that says what you do and where.' },
  { id: 'description', area: 1, name: 'Page description',
    pass: n => `Your homepage has a description, ${n} characters long.`,
    fail: (n, c) => c === 'missing' ? 'Your homepage has no description. That is the short text a search result can show under the title.'
      : c === 'short' ? `Your homepage description is only ${plural(n, 'character', 'characters')} long.`
      : `Your homepage description is ${n} characters long, so a search result will likely cut it off.`,
    fix: 'Write a description of about 50 to 165 characters.' },
  { id: 'h1', area: 1, name: 'One main heading',
    pass: () => 'Your homepage has one main heading.',
    fail: (n, c) => c === 'many' ? `We found ${n} main headings (h1) on your homepage. One is clearer.` : 'We found no main heading (h1) on your homepage.',
    fix: 'Use one main heading that says what you do.', na: { js: jsNote } },
  { id: 'viewport', area: 2, name: 'Set up for phone screens',
    pass: () => 'Your homepage tells phones to fit the page to the screen (the viewport tag).',
    fail: () => 'Your homepage is missing the tag that tells phones to fit the page to the screen (the viewport tag).',
    fix: 'Add the viewport tag.' },
  { id: 'tel', area: 3, name: 'Tap-to-call link',
    pass: () => 'We found a tap-to-call phone link on your homepage.',
    fail: () => 'We did not find a tap-to-call phone link on your homepage.',
    fix: 'Make your phone number a link people can tap.', na: { js: jsNote } },
  { id: 'write', area: 3, name: 'A way to write to you',
    pass: () => 'We found a form or an email link on your homepage.',
    fail: () => 'We did not find a form or an email link on your homepage.',
    fix: 'Add a short contact form.', na: { js: jsNote } },
  { id: 'cta', area: 3, name: 'A clear next step',
    pass: () => 'We found a button or link asking visitors to take a next step (call, book, get a quote).',
    fail: () => 'We did not find a button or link with wording like call, book or get a quote on your homepage.',
    fix: 'Add one clear button near the top.', na: { js: jsNote } },
  { id: 'gbp', area: 3, name: 'Link to your Google Business profile',
    pass: () => 'Your homepage links to (or embeds) a Google Maps or Business profile.',
    fail: () => 'We did not find a link to a Google Maps or Business profile on your homepage. You may still have a profile. We only looked for the link.',
    fix: 'Link to your profile from the homepage.', na: { js: jsNote } },
  { id: 'lcp', area: 4, name: 'Main content appears quickly',
    pass: n => `In our test the main content appeared in ${secs(n)} seconds.`,
    fail: n => `In our test the main content took ${secs(n)} seconds to appear. Google's guideline is 2.5 seconds or less.`,
    fix: 'Shrink large images and remove scripts the page does not need.', na: {} },
  { id: 'cls', area: 4, name: 'Page holds still while loading',
    pass: () => 'The page stayed steady while it loaded in our test.',
    fail: () => 'Parts of the page jumped around while it loaded in our test.',
    fix: 'Give images and embeds a set size.', na: {} },
  { id: 'weight', area: 4, name: 'Page weight',
    pass: n => `The homepage weighed ${mb(n)} MB in our test.`,
    fail: n => `The homepage weighed ${mb(n)} MB in our test. We look for 3 MB or less.`,
    fix: 'Compress images and drop files the page does not use.', na: {} },
];
export const CHECK_IDS = CHECKS.map(c => c.id);
export const SPEED_IDS = ['lcp', 'cls', 'weight'];
export const THRESHOLDS = { titleMin: 10, titleMax: 65, descMin: 50, descMax: 165, lcpMs: 2500, cls: 0.1, weightKb: 3000 };

const P = (n) => (n == null ? { s: 'pass', c: 'ok' } : { s: 'pass', c: 'ok', n });
const F = (c, n) => (n == null ? { s: 'fail', c } : { s: 'fail', c, n });
const NA = c => ({ s: 'na', c });

const decode = s => String(s).replace(/&(amp|lt|gt|quot|#39|#x27|apos|nbsp);/gi, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", apos: "'", nbsp: ' ' })[e.toLowerCase()]);
const textOf = html => decode(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export function attrsOf(tag) {
  const out = {}, re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m; while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
const openTags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map(m => attrsOf(m[1]));
const pairs = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi'))].map(m => ({ a: attrsOf(m[1]), inner: m[2] }));

const NEXT_STEP = /\b(call|book|schedule|quote|estimate|contact|get started|request|appointment|consultation|sign up|buy|order|shop|reserve|donate|apply)\b/i;
const GOOGLE_PROFILE = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|g\.co\/kgs|business\.google\.com|share\.google)/i;

/** The checks read off the homepage's HTML. `https` is whether the page that
 *  answered was https. Returns { id: {s, c, n?} } for the HTML checks only. */
export function inspectHtml(rawHtml, { https }) {
  const raw = String(rawHtml || '');
  const scripts = (raw.match(/<script\b/gi) || []).length;
  const html = raw.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const out = {};

  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const tl = t ? textOf(t[1]).length : 0;
  out.title = !tl ? F('missing') : tl < THRESHOLDS.titleMin ? F('short', tl) : tl > THRESHOLDS.titleMax ? F('long', tl) : P(tl);

  const metas = openTags(html, 'meta');
  const d = metas.find(m => (m.name || '').toLowerCase() === 'description');
  const dl = d ? (d.content || '').replace(/\s+/g, ' ').trim().length : 0;
  out.description = !dl ? F('missing') : dl < THRESHOLDS.descMin ? F('short', dl) : dl > THRESHOLDS.descMax ? F('long', dl) : P(dl);

  const vp = metas.find(m => (m.name || '').toLowerCase() === 'viewport');
  out.viewport = vp && /width\s*=\s*device-width/i.test(vp.content || '') ? P() : F('missing');

  /* a page with almost no words and a script is assembled in the browser:
     what is not in the HTML was not read, which is different from "not there" */
  const body = /<body\b[^>]*>([\s\S]*)/i.exec(html);
  const words = textOf(body ? body[1] : html).length;
  const js = words < 150 && scripts > 0;

  const links = pairs(html, 'a'), buttons = pairs(html, 'button'), inputs = openTags(html, 'input');
  const hrefs = links.map(l => (l.a.href || '').trim());
  const h1 = pairs(html, 'h1').filter(h => textOf(h.inner)).length;
  const tel = hrefs.some(h => /^tel:/i.test(h));
  const forms = pairs(html, 'form').some(f => /<textarea\b/i.test(f.inner) || /type\s*=\s*["']?(email|tel)\b/i.test(f.inner) || /name\s*=\s*["']?[^"'>\s]*(email|phone|message)/i.test(f.inner));
  const write = forms || hrefs.some(h => /^mailto:/i.test(h));
  const cta = [...links, ...buttons].some(x => NEXT_STEP.test(textOf(x.inner))) || inputs.some(i => /^(submit|button)$/i.test(i.type || '') && NEXT_STEP.test(i.value || ''));
  const gbp = hrefs.some(h => GOOGLE_PROFILE.test(h)) || openTags(html, 'iframe').some(i => GOOGLE_PROFILE.test(i.src || ''));
  const found = (ok, code) => (ok ? P() : js ? NA('js') : F(code));
  out.h1 = h1 === 1 ? P() : h1 > 1 ? F('many', h1) : js ? NA('js') : F('none');
  out.tel = found(tel, 'none'); out.write = found(write, 'none'); out.cta = found(cta, 'none'); out.gbp = found(gbp, 'none');

  if (!https) out.mixed = NA('no_https');
  else {
    const insecure = ['img', 'script', 'iframe', 'source', 'video', 'audio', 'embed'].flatMap(n => openTags(raw, n)).filter(a => /^http:\/\//i.test((a.src || '').trim())).length
      + openTags(raw, 'link').filter(a => /stylesheet/i.test(a.rel || '') && /^http:\/\//i.test((a.href || '').trim())).length;
    out.mixed = insecure ? F('found', insecure) : P();
  }
  return out;
}

/** The checks read off the response headers of the page that answered. */
export function headerChecks(headers, { https }) {
  const h = headers || {};
  const framing = !!h['x-frame-options'] || /frame-ancestors/i.test(String(h['content-security-policy'] || ''));
  const missing = (h['x-content-type-options'] ? 0 : 1) + (framing ? 0 : 1);
  return {
    hsts: !https ? NA('no_https') : h['strict-transport-security'] ? P() : F('missing'),
    headers: missing ? F('missing', missing) : P(),
  };
}

/** PageSpeed's lab numbers -> the three speed checks. `m` is
 *  { lcpMs, cls, weightBytes } or null when the test did not come back. */
export function speedChecks(m, why = 'error') {
  if (!m) return { lcp: NA(why), cls: NA(why), weight: NA(why) };
  const one = (v, ok, fail, n) => (Number.isFinite(v) ? (ok ? P(n) : F(fail, n)) : NA('error'));
  const kb = Math.round(m.weightBytes / 1024);
  return {
    lcp: one(m.lcpMs, m.lcpMs <= THRESHOLDS.lcpMs, 'slow', Math.round(m.lcpMs)),
    cls: one(m.cls, m.cls <= THRESHOLDS.cls, 'shifts', Math.round(m.cls * 1000)),
    weight: one(m.weightBytes, kb <= THRESHOLDS.weightKb, 'heavy', kb),
  };
}

/* -------------------------------------------------------------------- grade */

export const GRADE_RULE = 'How the grade works: it is the share of the checks that ran which passed. A is 90% or more, B is 80%, C is 70%, D is 60%, and F is anything lower. A check that could not run is left out.';

/** THE GRADING RULE, the only one. Of the checks that RAN (passed or failed),
 *  the share that passed: A >= 90%, B >= 80%, C >= 70%, D >= 60%, else F.
 *  A check that could not run is not a fail: it is left out and named in
 *  `notRun`. With nothing run there is no grade (null), never an F. */
export function gradeOf(checks) {
  const c = checks || {};
  const ran = CHECK_IDS.filter(id => c[id] && (c[id].s === 'pass' || c[id].s === 'fail'));
  const passed = ran.filter(id => c[id].s === 'pass').length;
  const notRun = CHECK_IDS.filter(id => !ran.includes(id));
  const share = ran.length ? passed / ran.length : 0;
  const grade = !ran.length ? null : share >= 0.9 ? 'A' : share >= 0.8 ? 'B' : share >= 0.7 ? 'C' : share >= 0.6 ? 'D' : 'F';
  return { grade, passed, ran: ran.length, needWork: ran.length - passed, notRun };
}

/** What the browser may see before the gate: each check's name and whether it
 *  ran, and how many need work. No details and no grade. */
export function teaser(checks) {
  const g = gradeOf(checks);
  return { needWork: g.needWork, ran: g.ran, checks: CHECKS.map(c => ({ id: c.id, name: c.name, ran: !g.notRun.includes(c.id) })) };
}

/* ------------------------------------------------------- the carried result */

/** Rebuild a result from the fixed vocabulary only: a validated host, a time,
 *  and for each known check a status, a lowercase code and one number. Any
 *  other key, and any other kind of value, is dropped. */
export function sanitizeResult(r) {
  if (!r || typeof r !== 'object') return null;
  const v = validateUrl(typeof r.host === 'string' ? r.host : '');
  if (!v.ok || v.host !== r.host || !Number.isFinite(r.at)) return null;
  const checks = {};
  for (const id of CHECK_IDS) {
    const c = r.checks && r.checks[id];
    if (!c || !['pass', 'fail', 'na'].includes(c.s)) { checks[id] = NA('not_run'); continue; }
    const one = { s: c.s, c: typeof c.c === 'string' && /^[a-z_]{1,20}$/.test(c.c) ? c.c : 'ok' };
    if (Number.isFinite(c.n) && c.n >= 0 && c.n < 1e9) one.n = Math.round(c.n);
    checks[id] = one;
  }
  return { v: 1, host: v.host, at: r.at, https: r.https === true, fwd: r.fwd === true, checks };
}

const keyOf = secret => createHash('sha256').update('proytech-audit-v1:' + String(secret)).digest();
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
/** Where the report's button goes: /book?src=audit-<their tag>, 24 characters. */
export const bookLink = src => { const t = cleanSrc(src); return `${SITE_ORIGIN}/book?src=${(t ? 'audit-' + t : 'audit').slice(0, 24)}`; };
/** THE ONLY THING A VISITOR TYPES THAT REACHES THE EMAIL: the first word of
 *  their name, letters only, 30 characters. The template escapes it as well. */
export const firstNameOf = name => { const m = /[\p{L}][\p{L}'-]*/u.exec(String(name == null ? '' : name)); return m ? m[0].slice(0, 30) : ''; };

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const ctl = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** The gate's fields -> clean values or the names of the wrong ones.
 *  Mobile is required and is 10 digits. Consent is true only for the boolean
 *  true: a required number is not consent, and neither is any string. */
export function cleanContact(b) {
  const x = b && typeof b === 'object' ? b : {}, errors = [];
  const name = ctl(x.name, 120), email = ctl(x.email, 200).toLowerCase();
  let phone = (typeof x.phone === 'string' ? x.phone : '').replace(/\D/g, '');
  if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
  if (!name) errors.push('name');
  if (!EMAIL.test(email)) errors.push('email');
  if (phone.length !== 10) errors.push('phone');
  if (x.consent != null && typeof x.consent !== 'boolean') errors.push('consent');
  return { ok: !errors.length, errors, name, email, phone, consent: x.consent === true };
}

/* -------------------------------------------------------------------- lead */

/* The CRM's site-lead route accepts, today, exactly: kind, source, form, name,
   email, phone, message, page, fields{timeline,address,lane}. So the link tag,
   the audited address and the consent answer travel as TEXT in page/message.
   When the CRM adds fields.src, fields.website and a consent field, set this
   to true: that one line is the whole change on this side. */
export const SEND_STRUCTURED_FIELDS = false;

/** The body for POST <crm>/api/site-lead. */
export function leadPayload({ contact, result, src }, structured = SEND_STRUCTURED_FIELDS) {
  const g = gradeOf(result.checks), tag = cleanSrc(src);
  const name = id => CHECKS.find(c => c.id === id).name;
  const failing = CHECK_IDS.filter(id => result.checks[id].s === 'fail').map(name);
  const message = [
    `Website audit of ${result.host}.`,
    g.grade ? `Grade ${g.grade} (${g.passed} of ${g.ran} checks passed).` : 'No checks could run.',
    failing.length ? `Needs work: ${failing.join('; ')}.` : '',
    g.notRun.length ? `Could not check: ${g.notRun.map(name).join('; ')}.` : '',
    `Link tag: ${tag || 'none'}.`,
    `Text consent box: ${contact.consent ? 'TICKED' : 'NOT ticked (do not text this number)'}.`,
  ].filter(Boolean).join(' ').slice(0, 2000);
  const body = {
    kind: 'lead', source: 'Website audit', form: 'audit',
    name: contact.name, email: contact.email, phone: contact.phone,
    page: `getproytech.com/audit${tag ? '?src=' + tag : ''} (audited ${result.host})`.slice(0, 200),
    message,
  };
  if (structured) body.fields = { src: tag, website: result.host, textConsent: contact.consent };
  return body;
}

/* ------------------------------------------------------------------ report */

const C = { blue: '#1338DE', orange: '#FB6926', navy: '#000110', ink: '#111528', muted: '#5B6478', tint: '#F1F4FE', line: '#DCE2F5', good: '#167A3E', goodbg: '#E6F4EC', warn: '#9A5B00', warnbg: '#FFF2DC', bad: '#B3261E', badbg: '#FDE7E5' };
const FONT = "font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif";
const sentence = (chk, r) => r.s === 'pass' ? chk.pass(r.n, r.c) : r.s === 'fail' ? chk.fail(r.n, r.c)
  : (chk.na && chk.na[r.c]) || (SPEED_IDS.includes(chk.id) ? speedNote : 'This check could not run today.');
const pill = s => { const [bg, fg, t] = s === 'pass' ? [C.goodbg, C.good, 'Good'] : s === 'fail' ? [C.badbg, C.bad, 'Needs work'] : [C.warnbg, C.warn, 'Could not check']; return `<span style="font-family:'Courier New',monospace;font-size:12px;padding:3px 8px;border-radius:999px;white-space:nowrap;background:${bg};color:${fg}">${t}</span>`; };
export const dateLabel = at => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(at));

/** The email. Built from `result` (fixed codes and numbers), the visitor's
 *  first name (escaped) and the link tag (a slug). Nothing else gets in.
 *  The layout is the previews reports': verdict box, labelled areas, what
 *  needs work with its fix, what is already working, the orange band. */
export function renderReport({ result, firstName, src }) {
  const g = gradeOf(result.checks), host = result.host, when = dateLabel(result.at), link = bookLink(src);
  const hello = firstNameOf(firstName);
  const row = id => { const chk = CHECKS.find(c => c.id === id), r = result.checks[id]; return { chk, r, text: sentence(chk, r) }; };
  const rows = CHECK_IDS.map(row), fails = rows.filter(x => x.r.s === 'fail'), passes = rows.filter(x => x.r.s === 'pass'), nas = rows.filter(x => x.r.s === 'na');
  const speedRan = SPEED_IDS.some(id => result.checks[id].s !== 'na');
  const verdict = g.grade
    ? `${g.passed} of the ${g.ran} checks that ran passed. ${g.needWork ? `${plural(g.needWork, 'check needs', 'checks need')} work.` : 'Nothing we checked needs work.'}`
    : 'None of our checks could run on this address today, so there is no grade.';
  const scoreLabel = `This grade is ProyTech's own score for these checks on the homepage of ${host} on ${when}. It does not come from Google or any rating body.`;
  const notes = [
    result.fwd ? 'Your address forwards to a different website, so these checks describe the page it lands on.' : '',
    speedRan ? 'The speed numbers come from one lab test on a simulated phone through Google PageSpeed Insights. A real visit can be faster or slower.' : speedNote + ' The rest of the report does not depend on it.',
  ].filter(Boolean);

  const item = x => `<tr><td style="padding:14px 0;border-top:1px solid ${C.line}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="${FONT};font-size:16px;font-weight:700;color:${C.ink}">${esc(x.chk.name)}</td><td align="right">${pill(x.r.s)}</td></tr></table><div style="${FONT};font-size:15px;line-height:1.55;color:${C.ink};margin-top:6px">${esc(x.text)}</div>${x.r.s === 'fail' ? `<div style="${FONT};font-size:15px;font-weight:600;margin-top:6px;color:${C.ink}"><span style="color:${C.blue}">The fix:</span> ${esc(x.chk.fix)}</div>` : ''}</td></tr>`;
  const section = (title, list) => !list.length ? '' : `<tr><td style="padding:34px 0 6px;${FONT};font-size:24px;font-weight:700;color:${C.ink}">${esc(title)}</td></tr>${list.map(item).join('')}`;
  const byArea = AREAS.map((a, i) => { const list = rows.filter(x => x.chk.area === i), ran = list.filter(x => x.r.s !== 'na'); const s = !ran.length ? 'na' : ran.every(x => x.r.s === 'pass') ? 'pass' : 'fail'; return `<tr><td style="padding:10px 14px;border:1px solid ${C.line};border-radius:10px;${FONT};font-size:15px;font-weight:600;color:${C.ink}">${esc(a)}</td><td style="padding:10px 0 10px 10px" align="right">${pill(s)}</td></tr><tr><td colspan="2" style="height:8px;line-height:8px;font-size:0">&nbsp;</td></tr>`; }).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your website report</title></head>
<body style="margin:0;background:#ffffff;color:${C.ink};${FONT};font-size:16px;line-height:1.6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff"><tr><td align="center" style="padding:12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;border:6px solid ${C.blue};border-radius:22px">
<tr><td style="background:${C.navy};padding:16px 24px;border-radius:14px 14px 0 0;${FONT};font-size:20px;font-weight:700;color:#ffffff">ProyTech</td></tr>
<tr><td style="padding:34px 24px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-family:'Courier New',monospace;font-size:13px;color:${C.blue};letter-spacing:1px">WEBSITE REPORT · ${esc(host)} · ${esc(when)}</td></tr>
<tr><td style="${FONT};font-size:32px;line-height:1.1;font-weight:700;padding:10px 0 12px;color:${C.ink}">Your website report${hello ? ', ' + esc(hello) : ''}</td></tr>
<tr><td style="${FONT};font-size:17px;color:${C.muted}">An automated outside check of the homepage of ${esc(host)}, run on ${esc(when)}. We looked at it the way a visitor's browser does. We did not log in and we did not look at any other page.</td></tr>
<tr><td style="padding-top:26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.tint};border:1px solid ${C.line};border-radius:16px"><tr>
<td width="110" style="padding:22px 0 22px 22px" valign="top"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="100" height="100" style="background:${C.orange};border-radius:18px;color:#ffffff;${FONT}"><div style="font-size:52px;line-height:1;font-weight:700">${g.grade || '–'}</div><div style="font-size:12px;font-weight:600">ProyTech score</div></td></tr></table></td>
<td style="padding:22px;${FONT};font-size:17px;color:${C.ink}" valign="middle">${esc(verdict)}<div style="font-size:13px;color:${C.muted};margin-top:10px">${esc(scoreLabel)}</div><div style="font-size:13px;color:${C.muted};margin-top:6px">${esc(GRADE_RULE)}</div></td></tr></table></td></tr>
<tr><td style="padding-top:18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${byArea}</table></td></tr>
${notes.map(n => `<tr><td style="${FONT};font-size:14px;color:${C.muted};padding-top:6px">${esc(n)}</td></tr>`).join('')}
${section('What needs work', fails)}
${section("What's already working", passes)}
${section('What we could not check', nas)}
<tr><td style="padding-top:40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.orange};border-radius:18px"><tr><td style="padding:28px">
<div style="${FONT};font-size:24px;line-height:1.15;font-weight:700;color:#ffffff">Want to know what to fix first?</div>
<div style="${FONT};font-size:16px;color:#ffffff;margin:8px 0 18px">The Nucleus Session is a free 15 to 30 minute call on Google Meet. You leave knowing your next three moves.</div>
<a href="${esc(link)}" style="display:inline-block;background:#ffffff;color:${C.ink};${FONT};font-size:16px;font-weight:700;text-decoration:none;border-radius:999px;padding:13px 22px">Book your free Nucleus Session</a>
</td></tr></table></td></tr>
<tr><td style="${FONT};font-size:13px;color:${C.muted};padding-top:26px">Prepared by ProyTech. This was an automated outside check of one page, the homepage of ${esc(host)}, on ${esc(when)}. It reports what our checker found on that day and nothing about the rest of your site or your business. You asked for this report at getproytech.com/audit.</td></tr>
</table></td></tr></table></td></tr></table></body></html>`;

  const lines = [
    `Your website report${hello ? ', ' + hello : ''}`,
    `An automated outside check of the homepage of ${host}, run on ${when}.`, '',
    g.grade ? `ProyTech score: ${g.grade}. ${verdict}` : verdict, scoreLabel, GRADE_RULE, ...notes, '',
    ...(fails.length ? ['WHAT NEEDS WORK', ...fails.flatMap(x => [`- ${x.chk.name}: ${x.text}`, `  The fix: ${x.chk.fix}`]), ''] : []),
    ...(passes.length ? ["WHAT'S ALREADY WORKING", ...passes.map(x => `- ${x.chk.name}: ${x.text}`), ''] : []),
    ...(nas.length ? ['WHAT WE COULD NOT CHECK', ...nas.map(x => `- ${x.chk.name}: ${x.text}`), ''] : []),
    `Book your free Nucleus Session: ${link}`, '',
    `Prepared by ProyTech. An automated outside check of one page on ${when}.`,
  ];
  return { subject: `Your website report for ${host}`, html, text: lines.join('\n'), grade: g };
}
