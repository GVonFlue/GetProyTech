// tests/crawl.test.mjs — the whole-site crawl: which pages are read, what
// robots.txt, the sitemap, the stack and the email records say, the site
// facts that come out, and the crawl itself against a throwaway local site
// that tries to lead the crawler somewhere it must not go.
//   node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as C from '../api/_crawl.js';
import * as N from '../api/_audit-net.js';
import * as A from '../api/_audit.js';
import * as R from '../api/_rubric.js';

/* ------------------------------------------------------------- the links */
const HOME = `<html><head><title>Reed Roofing</title></head><body>
<header><nav><a href="/">Home</a><a href="/services/">Services</a><a href="/about-us">About</a><a href="/contact">Contact</a><a href="/old-page">Old</a></nav></header>
<a href="/roof-repair">Roof repair</a><a href="https://www.reedroofing.com/gutter-cleaning">Gutters</a><a href="/services#top">Again</a>
<a href="/privacy-policy">Privacy</a><a href="/wp-admin/">Admin</a><a href="/files/menu.pdf">Menu</a><a href="/blog/how-to-fix-a-leak">Post</a><a href="/2024/05/news">Dated</a>
<a href="mailto:hi@reedroofing.com">Email</a><a href="tel:3165550142">Call</a><a href="https://facebook.com/reed">FB</a><a href="https://evil.example/contact">Elsewhere</a>
<a href="http://reedroofing.com:8080/admin">Odd port</a><a href="javascript:alert(1)">JS</a></body></html>`;

test('linksOf: same-site pages only, one per path, menu links marked; files, admin, policies, posts, other sites and odd ports left out', () => {
  const l = C.linksOf(HOME, 'https://reedroofing.com/', 'reedroofing.com');
  assert.deepEqual(l.map(x => x.path).sort(), ['/about-us', '/contact', '/gutter-cleaning', '/old-page', '/roof-repair', '/services'].sort());
  assert.equal(l.find(x => x.path === '/services').nav, true); assert.equal(l.find(x => x.path === '/roof-repair').nav, false);
  assert.equal(l.find(x => x.path === '/gutter-cleaning').url, 'https://www.reedroofing.com/gutter-cleaning', 'www and bare are the same site');
  assert.equal(C.baseOf('shop.reed.co.uk'), 'reed.co.uk'); assert.equal(C.baseOf('www.reedroofing.com'), 'reedroofing.com');
});

test('pickPages: contact, services, about first (services up to 3), menu links before the rest, and counts what the site HAS', () => {
  const links = C.linksOf(HOME, 'https://reedroofing.com/', 'reedroofing.com');
  const sm = ['https://reedroofing.com/siding-repair', 'https://reedroofing.com/service-areas', 'https://reedroofing.com/faq', 'https://other.com/x', 'https://reedroofing.com/terms'];
  const p = C.pickPages(links, sm, 'reedroofing.com');
  assert.ok(p.picked.length <= 7);
  assert.equal(p.picked[0].kind, 'contact');
  assert.ok(p.picked.slice(0, 4).some(x => x.kind === 'about'), 'about early');
  assert.ok(p.picked.filter(x => x.kind === 'services').length <= 3);
  for (const k of ['contact', 'services', 'about', 'areas', 'faq']) assert.ok(p.picked.some(x => x.kind === k), k + ' is read');
  assert.ok(!p.picked.some(x => /terms|other\.com/.test(x.url)));
  assert.equal(p.counts.services, 4, '/services, /roof-repair, /gutter-cleaning, /siding-repair');
  assert.equal(p.counts.areas, 1); assert.equal(p.counts.about, 1);
  assert.equal(p.found, 9);
});

/* ------------------------------------------------------ robots, sitemap */
test('parseRobots: "Disallow: /" for everyone, or per AI crawler by its own group; an Allow: / undoes it; sitemaps listed', () => {
  const r = C.parseRobots('# hi\nUser-agent: *\nDisallow: /wp-admin/\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\nAllow: /\n\nSitemap: https://reedroofing.com/sitemap_index.xml');
  assert.equal(r.blockAll, 0);
  assert.deepEqual(C.aiBlockedNames(r.aiBlocked), ['GPTBot (OpenAI)', 'ClaudeBot (Anthropic)']);
  assert.deepEqual(r.sitemaps, ['https://reedroofing.com/sitemap_index.xml']);
  const all = C.parseRobots('User-agent: *\nDisallow: /');
  assert.equal(all.blockAll, 1); assert.equal(C.aiBlockedNames(all.aiBlocked).length, C.AI_BOTS.length, 'with no group of their own, "*" applies');
  const own = C.parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: Google-Extended\nAllow: /');
  assert.ok(!C.aiBlockedNames(own.aiBlocked).includes('Google-Extended (Google Gemini)'), 'its own group wins over "*"');
  assert.deepEqual(C.parseRobots(''), { blockAll: 0, aiBlocked: 0, sitemaps: [] });
});
test('parseSitemap and looksLikeHtml: a urlset, an index, and a homepage pretending to be a file', () => {
  const s = C.parseSitemap('<?xml version="1.0"?><urlset><url><loc> https://reedroofing.com/ </loc></url><url><loc><![CDATA[https://reedroofing.com/a&amp;b]]></loc></url></urlset>');
  assert.deepEqual(s, { index: false, locs: ['https://reedroofing.com/', 'https://reedroofing.com/a&b'] });
  assert.equal(C.parseSitemap('<sitemapindex><sitemap><loc>https://x.com/page-sitemap.xml</loc></sitemap></sitemapindex>').index, true);
  assert.equal(C.parseSitemap('<!doctype html><html><body>404</body></html>'), null);
  assert.ok(C.looksLikeHtml('<!DOCTYPE html><html>')); assert.ok(C.looksLikeHtml('\n<html lang="en">')); assert.ok(!C.looksLikeHtml('User-agent: *\nDisallow:'));
});

/* -------------------------------------------------------------- the stack */
test('detectStack: the platform and the tools, from the page code and headers, names from our tables only', () => {
  const html = '<link href="/wp-content/themes/x.css"><script src="https://widgets.leadconnectorhq.com/loader.js" data-widget-id="abcdef0123456789abcdef01"></script><a href="https://calendly.com/reed">Book</a><script>fbq("init","123")</script><div class="wpcf7">';
  const st = C.detectStack([html]);
  assert.equal(C.PLATFORMS[st.platform].name, 'WordPress');
  const names = st.tools.map(i => C.TOOLS[i].name);
  for (const n of ['GoHighLevel', 'GoHighLevel web chat', 'Calendly', 'Meta pixel', 'Contact Form 7']) assert.ok(names.includes(n), n);
  assert.equal(C.PLATFORMS[C.detectStack(['<p>hi</p>'], [{ 'x-wix-request-id': '1' }]).platform].name, 'Wix', 'a header can name the platform');
  assert.equal(C.detectStack(['<p>plain</p>']).platform, 0);
  const s = C.stackOf({ platform: st.platform, mx: 1 }, [...st.tools, 999, 'x']);
  assert.equal(s.platform, 'WordPress'); assert.equal(s.email, 'Google Workspace'); assert.equal(s.tools.length, st.tools.length);
});
test('email records: who hosts the mail, SPF, and whether DMARC only watches or acts', () => {
  assert.equal(C.MX_PROVIDERS[C.mxProvider([{ exchange: 'aspmx.l.google.com' }])], 'Google Workspace');
  assert.equal(C.MX_PROVIDERS[C.mxProvider([{ exchange: 'reed-com.mail.protection.outlook.com' }])], 'Microsoft 365');
  assert.equal(C.mxProvider([]), 0); assert.equal(C.MX_PROVIDERS[C.mxProvider(['mx.example.net'])], 'Another email provider');
  assert.equal(C.spfOf([['v=spf1 include:_spf.google.com ', '~all']]), 1); assert.equal(C.spfOf([['google-site-verification=x']]), 0);
  assert.equal(C.dmarcOf([['v=DMARC1; p=none; rua=mailto:x@y.com']]), 1); assert.equal(C.dmarcOf([['v=DMARC1; p=reject']]), 2); assert.equal(C.dmarcOf([]), 0);
});

/* ------------------------------------------------------------- per page */
test('pageExtras: words, noindex (tag or header), the lead form\'s fields, full business data, an FAQ', () => {
  const page = `<html><head><title> Contact  Reed </title><meta name="robots" content="noindex,follow">
<script type="application/ld+json">{"@type":"RoofingContractor","telephone":"316","address":{"@type":"PostalAddress"}}</script></head><body>
<h2>Frequently asked questions</h2>
<form><input type="hidden" name="t"><input name="name"><input type="email" name="email"><input type="tel" name="phone"><textarea name="message"></textarea><input type="submit"></form>
<form><input type="email" name="newsletter"><button>Join</button></form>
<p>Call (316) 555-0142 or 316.555.0199</p><a href="/contact">Get a quote</a></body></html>`;
  const x = C.pageExtras(page, {});
  assert.equal(x.noindex, 1); assert.equal(x.formFields, 4, 'hidden and submit are not fields; a one-box newsletter is not a lead form');
  assert.equal(x.schemaFull, 1); assert.equal(x.faq, 1); assert.equal(x.contactLink, 1);
  assert.deepEqual([...x.phones].sort(), ['3165550142', '3165550199']); assert.equal(x.titleKey, 'contact reed');
  assert.equal(C.pageExtras('<body><p>ok</p></body>', { 'x-robots-tag': 'noindex' }).noindex, 1);
});

test('siteFactsOf: shared titles, thin pages (the contact page excused), pages with a way in, phones across the site', () => {
  const f = html => R.ruleFacts(html, { year: 2026 });
  const page = (title, body, kind) => { const h = `<html><head><title>${title}</title></head><body>${body}</body></html>`; return { kind, f: f(h), x: C.pageExtras(h, {}) }; };
  const long = '<p>' + 'word '.repeat(320) + '</p>';
  const pages = [page('Reed', `<h1>Reed Roofing in Wichita</h1>${long}<a href="tel:3165550142">Call</a>`, 'home'), page('Reed', `<h1>Services</h1><p>short</p>`, 'services'), page('Contact', '<h1>Contact</h1><p>(316) 555-0199</p><a href="/book">Book now</a>', 'contact')];
  const s = C.siteFactsOf({ pages, found: 12, counts: { services: 3, about: 1 }, links: { tested: 5, broken: 1 }, robots: null, sitemap: { urls: 20 }, llms: 0, dns: { mx: 1, spf: 1, dmarc: 2 }, stack: { platform: 13 } });
  assert.equal(s.pagesChecked, 3); assert.equal(s.dupTitles, 2);
  assert.equal(s.thinBase, 2); assert.equal(s.thinPages, 1, 'the contact page is not held to 300 words');
  assert.equal(s.reachPages, 2); assert.equal(s.phonesAll, 2); assert.equal(s.servicePages, 3); assert.equal(s.aboutPage, 1);
  assert.equal(s.robotsFound, 0); assert.equal(s.sitemapUrls, 20); assert.equal(s.dmarc, 2);
  assert.deepEqual(Object.keys(s).sort(), [...C.SITE_KEYS].sort());
  for (const v of Object.values(s)) assert.equal(typeof v, 'number');
});

/* ------------------------------------- the rubric reads the site facts */
const site = (more = {}) => ({ ...Object.fromEntries(C.SITE_KEYS.map(k => [k, 0])), pagesChecked: 5, thinBase: 4, robotsFound: 1, mx: 1, ...more });
const HOMEF = R.ruleFacts('<html><head><title>Reed Roofing | Wichita</title></head><body><h1>Roof repair in Wichita KS</h1><p>hello</p></body></html>', { year: 2026 });
const res = (s, tools = []) => R.ruleResults(HOMEF, { https: true, redirect: 'pass' }, null, s, tools);

test('rubric v2: site facts become fixed sentences with numbers and our own names, never the site\'s words', () => {
  let r = res(site({ reachPages: 5, ctaPages: 2, formFields: 9, servicePages: 1, brokenLinks: 2, linksTested: 8, dupTitles: 3, aiBlocked: 0b00101, spf: 1, dmarc: 1 }));
  assert.equal(r.j_reach.s, 'pass'); assert.equal(r.j_every_cta.s, 'miss'); assert.match(r.j_every_cta.ev, /Only 2 of the 5 pages/);
  assert.equal(r.j_form.s, 'miss'); assert.equal(r.p_services.s, 'partial'); assert.equal(r.p_links.s, 'miss'); assert.match(r.p_links.ev, /2 of the 8 links we tested are broken/);
  assert.equal(r.g_titles_unique.s, 'miss');
  assert.equal(r.ai_crawlers.s, 'partial'); assert.equal(r.ai_crawlers.ev, 'Your robots.txt blocks GPTBot (OpenAI) and ClaudeBot (Anthropic).');
  assert.equal(r.bh_email.s, 'partial'); assert.equal(r.bh_instant.s, 'miss');
  assert.equal(r.bh_capture.s, 'partial', 'a form with nothing behind it'); assert.match(r.bh_capture.ev, /may land only in an inbox/);
  assert.equal(res(site()).bh_capture.s, 'miss', 'no form, no booking, no CRM');
  const tools = [C.TOOLS.findIndex(t => t.name === 'Calendly'), C.TOOLS.findIndex(t => t.name === 'Meta pixel')];
  r = res(site({ robotsBlockAll: 1 }), tools);
  assert.equal(r.g_indexable.s, 'miss'); assert.equal(r.ai_crawlers.s, 'miss');
  assert.equal(r.bh_capture.s, 'pass'); assert.match(r.bh_capture.ev, /Calendly/); assert.equal(r.bh_instant.s, 'pass'); assert.equal(r.bh_pixel.s, 'pass');
  r = res(site({ robotsFound: 0, mx: 0 }));
  assert.equal(r.ai_crawlers.s, 'pass', 'no robots.txt blocks nobody'); assert.equal(r.bh_email.s, 'na', 'no email on the domain is not a miss');
  for (const x of Object.values(r)) assert.ok(R.claimsOk(x.ev), x.ev);
  /* one page read: the multi-page checks are "not checked", not passes */
  r = res(site({ pagesChecked: 1 }));
  for (const id of ['j_reach', 'j_every_cta', 'g_titles_unique', 'g_desc_all', 'g_h1_all']) assert.equal(r[id].s, 'na', id);
});

test('evidence guard v2: a quote counts on whichever page it is really on; the page is found by us, not taken from the answer', () => {
  const pages = [{ path: '/', text: 'Reed Roofing. Roofs done right.' }, { path: '/services', text: 'We fix storm damage in Derby and Wichita.' }];
  const out = R.checkAi(JSON.stringify({ items: { ps_problem: { status: 'pass', quote: 'storm damage in Derby', note: 'Your services page names storm damage.', page: '/' }, p_areas: { status: 'pass', quote: 'Andover and Wichita', note: 'x' } },
    working: [], journey: [{ text: 'A visitor lands on a slogan.', quote: 'Roofs done right.' }, { text: 'Made up.', quote: 'Free pizza Fridays' }] }), pages, { hadImage: false });
  assert.equal(out.results.ps_problem.page, '/services', 'the page the quote is on, not the page the answer named');
  assert.equal(out.results.p_areas.s, 'na', 'a quote on no page does not count');
  assert.deepEqual(out.journey.map(j => j.page), ['/']);
  assert.ok(R.checkAi('Here you go:\n```json\n{"items":{}}\n```\nHope that helps', pages, { hadImage: false }), 'the JSON is read out of a fenced answer');
});

test('buildReport v2: pages, stack and journey; no per-item fix; it fits the CRM\'s cap even when every line is long', () => {
  const long = 'x'.repeat(400);
  const results = Object.fromEntries(R.ITEMS.map(i => [i.id, { s: 'miss', ev: long, quote: long, page: '/' + 'p'.repeat(200) }]));
  const ai = { working: Array(5).fill({ text: long, quote: long, page: '/a' }), journey: Array(5).fill({ text: long, quote: long, page: '/b' }) };
  const rep = R.buildReport({ host: 'reed.com', builtOn: '2026-11-23', results, ai, speed: null, judgment: true, pages: Array(9).fill({ path: '/' + 'q'.repeat(300), kind: 'services', words: 500 }), site: site({ platform: 13 }), tools: [0] });
  assert.ok(JSON.stringify(rep).length <= R.REPORT_MAX);
  assert.equal(rep.items.length, R.ITEMS.length); assert.ok(rep.items.every(i => !('fix' in i)));
  assert.equal(rep.pages.length, 8); assert.equal(rep.stack.platform, 'WordPress'); assert.deepEqual(rep.stack.tools, [{ name: 'GoHighLevel', kind: 'crm' }]);
  assert.equal(rep.top.length, 3); assert.ok(rep.top.every(t => t.fix));
});

/* --------------------------------------------- the crawl, over the wire */
let port, hits = [];
const pageHtml = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="d"></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(body); };
  const h = b => send(200, 'text/html; charset=utf-8', b);
  const o = `http://site.example.org:${port}`;
  switch (req.url) {
    case '/gallery':                       // the homepage again, under another address
    case '/': return h(pageHtml('Reed Roofing | Wichita', `<header><nav><a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/old">Old</a><a href="/sneaky">Sneaky</a></nav></header>
      <h1>Roof repair in Wichita</h1><a href="tel:3165550142">Call</a><a href="${o}/gallery">Gallery</a><a href="http://internal.example.org:${port}/admin">Internal</a>
      <script src="https://calendly.com/assets/external/widget.js"></script>`));
    case '/services': return h(pageHtml('Services | Reed', `<h1>Services</h1><p>${'Roof repair and replacement. '.repeat(60)}</p><a href="/contact">Get a quote</a>`));
    case '/about': return h(pageHtml('About | Reed', '<h1>About</h1><p>Since 1998.</p>'));
    case '/contact': return h(pageHtml('Contact | Reed', '<h1>Contact</h1><form><input name="name"><input type="email" name="email"><input type="tel" name="phone"><textarea name="message"></textarea></form>'));
    case '/sneaky': res.writeHead(302, { location: `http://internal.example.org:${port}/secret` }); return res.end();
    case '/old': return send(404, 'text/html', 'gone');
    case '/robots.txt': return send(200, 'text/plain', `User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${o}/sitemap.xml\n`);
    case '/sitemap.xml': return send(200, 'application/xml', `<urlset><url><loc>${o}/</loc></url><url><loc>${o}/services</loc></url><url><loc>${o}/faq</loc></url></urlset>`);
    case '/faq': return h(pageHtml('FAQ | Reed', '<h1>FAQ</h1><h2>Frequently asked questions</h2><p>How long does a roof take? Two days.</p>'));
    case '/llms.txt': return h(pageHtml('Reed Roofing | Wichita', '<p>homepage again</p>'));   // a homepage pretending to be llms.txt
    case '/secret': return h('SECRET');
    default: return send(404, 'text/html', 'nf');
  }
});
test.before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });
const names = { 'site.example.org': '127.0.0.1', 'internal.example.org': '10.0.0.5' };
const resolve = async h => { if (!names[h]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return [{ address: names[h], family: 4 }]; };
const isPublic = ip => (ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' ? true : A.isPublicAddress(ip));
const dnsImpl = () => ({ mx: async () => [{ exchange: 'aspmx.l.google.com' }], txt: async d => (d.startsWith('_dmarc.') ? [] : [['v=spf1 -all']]) });

test('crawlFrom: reads the pages a buyer visits, the robots, sitemap and email records; never follows a link to a private address', async () => {
  hits = [];
  const opts = { resolve, isPublic, ports: [port] };
  const home = await N.safeFetch(`http://site.example.org:${port}/`, opts);
  assert.ok(home.ok);
  const c = await N.crawlFrom(home, 'site.example.org', { ...opts, dnsImpl, now: Date.UTC(2026, 10, 23) });
  const paths = c.pages.map(p => p.path);
  assert.equal(paths[0], '/');
  for (const p of ['/contact', '/services', '/about', '/faq']) assert.ok(paths.includes(p), p + ' was read');
  assert.ok(!paths.includes('/gallery'), 'a page that is the homepage again is not counted as its own page');
  assert.ok(!hits.includes('/secret'), 'the redirect to a private address was refused');
  assert.ok(!hits.includes('/admin'), 'a link to a private host was never fetched');
  assert.ok(c.pages.length <= C.PAGE_LIMIT);
  const s = c.site;
  assert.equal(s.robotsFound, 1); assert.deepEqual(C.aiBlockedNames(s.aiBlocked), ['GPTBot (OpenAI)']);
  assert.equal(s.sitemapFound, 1); assert.equal(s.sitemapUrls, 3); assert.equal(s.llms, 0, 'a homepage served as llms.txt is not an llms.txt');
  assert.equal(s.mx, 1); assert.equal(s.spf, 1); assert.equal(s.dmarc, 0);
  assert.equal(s.formFields, 4); assert.equal(s.faqAny, 1); assert.equal(s.aboutPage, 1);
  assert.ok(s.linksTested >= 2 && s.brokenLinks >= 1, 'the menu link to /old is broken');
  assert.ok(c.tools.map(i => C.TOOLS[i].name).includes('Calendly'));
  assert.ok(c.pages.find(p => p.path === '/services').text.includes('Roof repair and replacement'));
  for (const v of Object.values(s)) assert.equal(typeof v, 'number', 'site facts are numbers only');
});

test('crawlFrom: if the crawl itself breaks, the homepage alone is reported, never an error', async () => {
  const orig = console.error; console.error = () => {};
  try {
    const c = await N.crawlFrom({ ok: true, body: pageHtml('Reed', '<h1>Hi there friend</h1>'), finalUrl: 'not a url', headers: {} }, 'reed.com', { dnsImpl });
    assert.equal(c.site, null); assert.deepEqual(c.pages.map(p => p.path), ['/']); assert.equal(c.facts.h1Count, 1);
  } finally { console.error = orig; }
});

test('emailDns: a slow or failing lookup is "none found", never a hang or a throw', async () => {
  const slow = () => ({ mx: () => new Promise(() => {}), txt: async () => { throw new Error('SERVFAIL'); } });
  const t0 = Date.now();
  assert.deepEqual(await N.emailDns('reed.com', slow), { mx: 0, spf: 0, dmarc: 0 });
  assert.ok(Date.now() - t0 < A.LIMITS.dnsMs + 1500);
  assert.deepEqual(await N.emailDns('www.reed.com', () => { throw new Error('no dns'); }), { mx: 0, spf: 0, dmarc: 0 });
});
