// api/_audit-mock.js — canned stand-ins for the teardown's outside services,
// used only when MOCK=1 outside production (_audit-net.js mockOn). Nothing here
// touches the network. Underscore prefix: not a route.
import { ruleFacts } from './_rubric.js';
import { visibleText } from './_html.js';
import { pageExtras, siteFactsOf, detectStack, parseRobots, stackOf } from './_crawl.js';

/* the signing key in mock mode only (a real key is required otherwise) */
export const MOCK_KEY = 'mock-signing-key-mock-signing-key-0001';

export const MOCK_HTML = `<!doctype html><html><head><title>Acme Roofing | Wichita Roof Repair</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<header><nav><a href="/">Home</a><a href="/about">About</a><a href="/services">Services</a><a href="/roofing">Roofing</a><a href="/gutters">Gutters</a><a href="/siding">Siding</a><a href="/gallery">Gallery</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav></header>
<h1>Acme Roofing</h1><p>We are a trusted, dedicated team committed to quality service.</p>
<p>Family owned since 1998. Over 2,400 roofs replaced across Wichita and Derby.</p>
<p>Our crews are licensed and insured, and we back every roof with a 10-year workmanship warranty.</p>
<p>Call us at (316) 555-0142 or (316) 555-0199.</p>
<img src="/a.jpg"><img src="/b.jpg" alt="Crew on a roof">
<footer>© 2021 Acme Roofing</footer>
<script src="https://www.googletagmanager.com/gtag/js?id=G-MOCK123"></script></body></html>`;

const SERVICES_HTML = `<!doctype html><html><head><title>Acme Roofing | Wichita Roof Repair</title></head><body>
<h1>Our Services</h1><p>Roof repair, roof replacement, gutters and siding for homes in Wichita.</p>
<p>Storm damage? We work with your insurance company from the first call to the final inspection.</p>
<p>Call (316) 555-0142 for a free estimate.</p></body></html>`;
const CONTACT_HTML = `<!doctype html><html><head><title>Contact Acme Roofing</title><meta name="description" content="Contact Acme Roofing in Wichita."></head><body>
<h1>Contact us</h1><p>We usually reply within one business day.</p>
<form class="wpcf7-form"><input name="first-name"><input name="last-name"><input type="email" name="email"><input type="tel" name="phone"><input name="address"><input name="city"><select name="service"><option>Roof</option></select><textarea name="message"></textarea><button>Send</button></form>
</body></html>`;
export const MOCK_PAGES = [
  { path: '/', kind: 'home', html: MOCK_HTML },
  { path: '/services', kind: 'services', html: SERVICES_HTML },
  { path: '/contact', kind: 'contact', html: CONTACT_HTML },
];

/** What the crawl would learn from the mock site: facts, site facts, tools, pages. */
export function mockCrawl(year = 2026) {
  const recs = MOCK_PAGES.map(p => ({ ...p, f: ruleFacts(p.html, { year }), x: pageExtras(p.html, {}) }));
  const stack = detectStack(recs.map(r => r.html));
  const site = siteFactsOf({ pages: recs, found: 8, counts: { services: 4, about: 1, contact: 1, areas: 0, faq: 0, reviews: 0, work: 1 }, links: { tested: 6, broken: 1 },
    robots: parseRobots('User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: GPTBot\nDisallow: /\n'), sitemap: { urls: 14 }, llms: 0, dns: { mx: 1, spf: 1, dmarc: 0 }, stack });
  return { facts: recs[0].f, site, tools: stack.tools, pages: recs.map((r, i) => ({ path: r.path, kind: r.kind, words: r.x.words, text: visibleText(r.html, i ? 4500 : 9000) })) };
}

export const mockScan = async host => { const c = mockCrawl(); return { ok: true, data: { v: 3, host, at: Date.now(), https: true, redirect: 'pass', fwd: false, facts: c.facts, site: c.site, tools: c.tools, speed: null, shot: '' }, pages: c.pages.map(p => p.path), stack: stackOf(c.site, c.tools) }; };
export const mockSpeed = async () => ({ lcpMs: 4700, cls: 0.02, weightBytes: 3.6 * 1048576, fontOk: true, tapOk: false, shot: '' });
export const mockSite = async () => mockCrawl();
/** The homepage's words alone (older tests and tools). */
export const mockText = async () => mockCrawl().pages[0].text;
export const mockClaude = async () => JSON.stringify({
  items: {
    fi_what: { status: 'partial', quote: 'Acme Roofing', note: 'Your headline is your name; what you do and where comes further down.' },
    fi_action: { status: 'miss', quote: 'Call us at (316) 555-0142', note: 'The only way to act sits at the bottom of the page.' },
    fi_headline: { status: 'miss', quote: 'Acme Roofing', note: 'Your headline is only the business name.' },
    t_facts: { status: 'partial', quote: 'Family owned since 1998', note: 'Good facts, but below the first screen.' },
    t_cred: { status: 'pass', quote: 'licensed and insured', note: 'Your licence and insurance are stated plainly.' },
    t_specific: { status: 'miss', quote: 'committed to quality service', note: 'There are no customer reviews to read anywhere on the pages we checked.' },
    ps_problem: { status: 'partial', quote: 'Storm damage?', note: 'Your services page names storm damage, but the homepage never names a problem.' },
    ps_outcome: { status: 'miss', quote: 'Roof repair, roof replacement, gutters and siding', note: 'You list services rather than the result a homeowner wants.' },
    ps_why_you: { status: 'partial', quote: '10-year workmanship warranty', note: 'The warranty sets you apart, but it is buried mid-page.' },
    ps_risk: { status: 'pass', quote: 'free estimate', note: 'Your services page offers a free estimate.' },
    ps_urgency: { status: 'miss', quote: 'We usually reply within one business day.', note: 'Nothing gives a homeowner a reason to call this week.' },
    cp_objections: { status: 'miss', quote: 'committed to quality service', note: 'Price, timing and what happens next are not answered.' },
    g_nap: { status: 'pass', quote: 'Over 2,400 roofs replaced across Wichita', note: 'Your service and city appear together.' },
    p_areas: { status: 'partial', quote: 'across Wichita and Derby', note: 'You name two towns once, with no list of the areas you serve.' },
  },
  working: [
    { text: "You've been in business since 1998, which builds trust.", quote: 'Family owned since 1998' },
    { text: 'You back every roof with a 10-year workmanship warranty.', quote: '10-year workmanship warranty' },
    { text: 'You show real volume: over 2,400 roofs replaced.', quote: 'Over 2,400 roofs replaced' },
  ],
  journey: [
    { text: 'A visitor lands on your name as the headline and has to scroll to learn you do roofs.', quote: 'Acme Roofing' },
    { text: 'They meet a stock line before any proof, so the first impression is generic.', quote: 'We are a trusted, dedicated team committed to quality service.' },
    { text: 'The strongest proof, 2,400 roofs and a 10-year warranty, sits mid-page.', quote: 'Over 2,400 roofs replaced across Wichita and Derby.' },
    { text: 'Ready to act, they find two phone numbers and wonder which one to call.', quote: 'Call us at (316) 555-0142 or (316) 555-0199.' },
    { text: 'On the contact page, an eight-field form slows down anyone ready to book.', quote: 'We usually reply within one business day.' },
  ],
});
export const mockSave = async () => ({ ok: true, token: 'mock', reportUrl: 'https://www.getproytech.com/report?t=mocktoken0001' });
