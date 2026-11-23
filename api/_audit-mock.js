// api/_audit-mock.js — canned stand-ins for the teardown's outside services,
// used only when MOCK=1 outside production (_audit-net.js mockOn). Nothing here
// touches the network. Underscore prefix: not a route.
import { ruleFacts } from './_rubric.js';

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
<footer>© 2021 Acme Roofing</footer></body></html>`;

export const mockScan = async host => ({ ok: true, data: { v: 2, host, at: Date.now(), https: true, redirect: 'pass', fwd: false, facts: ruleFacts(MOCK_HTML, { year: 2026 }), speed: null, shot: '' } });
export const mockSpeed = async () => ({ lcpMs: 4700, cls: 0.02, weightBytes: 3.6 * 1048576, fontOk: true, tapOk: false, shot: '' });
export const mockText = async () => 'Acme Roofing\nWe are a trusted, dedicated team committed to quality service.\nFamily owned since 1998. Over 2,400 roofs replaced across Wichita and Derby.\nOur crews are licensed and insured, and we back every roof with a 10-year workmanship warranty.\nCall us at (316) 555-0142 or (316) 555-0199.\n© 2021 Acme Roofing';
export const mockClaude = async () => JSON.stringify({
  items: {
    fi_what: { status: 'partial', quote: 'Acme Roofing', note: 'Your headline is your name; what you do and where comes further down.' },
    fi_action: { status: 'miss', quote: 'Call us at (316) 555-0142', note: 'The only way to act sits at the bottom of the page.' },
    fi_headline: { status: 'miss', quote: 'Acme Roofing', note: 'Your headline is only the business name.' },
    t_facts: { status: 'partial', quote: 'Family owned since 1998', note: 'Good facts, but below the first screen.' },
    t_cred: { status: 'pass', quote: 'licensed and insured', note: 'Your licence and insurance are stated plainly.' },
    cp_objections: { status: 'miss', quote: 'committed to quality service', note: 'Price, timing and what happens next are not answered.' },
    g_nap: { status: 'pass', quote: 'Over 2,400 roofs replaced across Wichita', note: 'Your service and city appear together.' },
  },
  working: [
    { text: "You've been in business since 1998, which builds trust.", quote: 'Family owned since 1998' },
    { text: 'You back every roof with a 10-year workmanship warranty.', quote: '10-year workmanship warranty' },
    { text: 'You show real volume: over 2,400 roofs replaced.', quote: 'Over 2,400 roofs replaced' },
  ],
});
export const mockSave = async () => ({ ok: true, token: 'mock', reportUrl: 'https://www.getproytech.com/report?t=mocktoken0001' });
