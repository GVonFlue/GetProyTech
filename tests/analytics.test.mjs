// tests/analytics.test.mjs — Vercel Web Analytics (js/analytics.js) and the
// lead source stamp on the Ace chat door (api/chat.js).
//
// What is asserted:
//   pinned      the vendored loader is @vercel/analytics 2.0.1, byte for byte
//   production  nothing loads and nothing is sent off getproytech.com
//   no PII      the five events carry a name and nothing else, and a name
//               outside the list is dropped
//   coverage    every public page loads the module exactly once; every event
//               name a page uses is in the list
//   source      an Ace lead's source is the fixed door name whatever the
//               browser sends; ?src= rides along as its own, cleaned field
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { leadPayload, ACE_SOURCE, cleanSrc } from '../api/chat.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const VENDOR = 'js/vendor/vercel-analytics-2.0.1.js';
/* sha256 of node_modules/@vercel/analytics@2.0.1/dist/index.mjs as published */
const VENDOR_SHA256 = 'c3026b63c92ab1b612eddc0e58264edc02421f32e2d11f71ecd0e6dd3b22c829';
const TAG = '<script type="module" src="/js/analytics.js"></script>';

test('PINNED: the vendored loader is @vercel/analytics 2.0.1, unmodified below its header', () => {
  const s = read(VENDOR).replace(/\r\n/g, '\n');   // git may check it out with CRLF
  const body = s.slice(s.indexOf('*/\n') + 3);
  assert.equal(createHash('sha256').update(body).digest('hex'), VENDOR_SHA256);
  assert.match(body, /var version = "2\.0\.1";/);
  assert.ok(read('js/analytics.js').includes("from './vendor/vercel-analytics-2.0.1.js'"));
});

/* A fake browser: enough of window/document/location for inject() and track(). */
async function load(hostname) {
  const added = [];
  const g = globalThis;
  const saved = { window: g.window, document: g.document, location: g.location };
  g.window = g;
  g.location = { hostname, search: '' };
  g.document = { head: { querySelector: () => null, appendChild: el => added.push(el) }, createElement: () => ({ dataset: {} }) };
  delete g.va; delete g.vaq; delete g.ptTrack; delete g.PT_EVENTS;
  const mod = await import('../js/analytics.js?host=' + encodeURIComponent(hostname) + '&n=' + Math.random());
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } };
  return { mod, added, restore, queue: () => (g.vaq || []).slice() };
}

test('PRODUCTION ONLY: a preview, localhost or file:// page loads nothing and sends nothing', async () => {
  for (const host of ['getproytech-git-branch.vercel.app', 'getproytech.vercel.app', 'localhost', '', 'getproytech.com.evil.example']) {
    const w = await load(host);
    try {
      assert.equal(w.added.length, 0, host + ' loaded the script');
      globalThis.ptTrack('Booking started');
      assert.equal(globalThis.va, undefined, host + ' queued an event');
    } finally { w.restore(); }
  }
});

test('PRODUCTION: getproytech.com and www load Vercel\'s script once, in production mode', async () => {
  for (const host of ['getproytech.com', 'www.getproytech.com']) {
    const w = await load(host);
    try {
      assert.equal(w.added.length, 1);
      assert.equal(w.added[0].src, '/_vercel/insights/script.js');
      assert.equal(w.added[0].dataset.sdkv, '2.0.1');
      assert.equal(globalThis.vam, 'production');
    } finally { w.restore(); }
  }
});

test('NO PERSONAL DATA: the five events go out as a name only; any other name is dropped', async () => {
  const w = await load('www.getproytech.com');
  try {
    assert.deepEqual(Object.values(w.mod.EVENTS), ['Booking started', 'Booking completed', 'Teardown started', 'Score started', 'Score completed']);
    for (const n of Object.values(w.mod.EVENTS)) globalThis.ptTrack(n, { email: 'jo@reed.com' });
    globalThis.ptTrack('Booking Started');      // a typo
    globalThis.ptTrack('Lead email jo@reed.com');
    assert.deepEqual(w.queue(), Object.values(w.mod.EVENTS).map(name => ['event', { name, options: undefined }]));
  } finally { w.restore(); }
});

const publicPages = () => [
  ...fs.readdirSync(new URL('../', import.meta.url)).filter(f => f.endsWith('.html')),
  ...fs.readdirSync(new URL('../sponsors/', import.meta.url)).filter(f => f.endsWith('.html')).map(f => 'sponsors/' + f),
];

test('COVERAGE: every public page loads js/analytics.js exactly once, in <head>', () => {
  const pages = publicPages();
  assert.ok(pages.length >= 40, 'found ' + pages.length + ' pages');
  for (const p of pages) {
    const s = read(p);
    assert.equal(s.split(TAG).length - 1, 1, p);
    assert.ok(s.indexOf(TAG) < s.search(/<\/head>/i), p + ': the tag is not in <head>');
  }
});

test('COVERAGE: booking started, booking completed and teardown started are wired, by listed names only', async () => {
  const { EVENTS } = await import('../js/analytics.js');
  const listed = Object.values(EVENTS);
  const book = read('book.html'), audit = read('audit.html');
  assert.match(book, /if \(n === 1\) countOnce\('Booking started'\);/, 'started: leaving step 1');
  const d = book.indexOf('function done(j){'), c = book.indexOf("countOnce('Booking completed');");
  assert.ok(d > 0 && c > d && c < book.indexOf('\n  }', d), 'completed: inside done(), which only a confirmed booking calls');
  assert.match(book, /function countOnce\(name\)\{\s+if \(MOCK \|\| counted\[name\]\) return;/, 'never from ?mock=1, once per page');
  assert.ok(audit.indexOf("window.ptTrack('Teardown started')") > audit.indexOf('function run(){'), 'teardown: in run()');
  assert.match(audit, /if \(!MOCK\) try \{ if \(window\.ptTrack\) window\.ptTrack\('Teardown started'\); \}/);
  for (const p of publicPages()) {
    const s = read(p);
    for (const m of s.matchAll(/(?:ptTrack|countOnce)\(('[^']*'|[^)]*)\)/g)) {
      if (m[1] === 'name') continue;                        // countOnce's own body
      const name = m[1].replace(/^'|'$/g, '');
      assert.ok(listed.includes(name), `${p} uses an unlisted event: ${m[0]}`);
      assert.ok(!m[0].includes(','), `${p} sends data with an event: ${m[0]}`);
    }
  }
});

test('SOURCE: an Ace lead is "Ace chat" whatever the browser sends; ?src= rides as its own field', () => {
  const lead = { name: 'Jo Reed', phone: '3165550142', email: 'jo@reed.com', notes: 'wants a site' };
  const now = new Date('2026-11-25T12:00:00Z');
  const p = leadPayload(lead, [{ role: 'user', content: 'hi' }], 'Coffee-Card_2', now);
  assert.equal(ACE_SOURCE, 'Ace chat');
  assert.equal(p.source, 'Ace chat');
  assert.equal(p.src, 'coffee-card_2');
  assert.equal(p.type, 'ace');
  assert.equal(p.submitted_at, '2026-11-25T12:00:00.000Z');
  assert.equal(leadPayload(lead, [], undefined, now).src, '', 'no tag: an empty field, never a guess');
  assert.equal(leadPayload({ ...lead, source: 'Google Ads' }, [], 'x', now).source, 'Ace chat', 'the browser cannot set the source');
  assert.equal(cleanSrc('<script>alert(1)</script>-a-very-long-tag-name'), 'scriptalert1script-a-ver');
  assert.equal(cleanSrc({ toString: () => 'x' }), '');
});

test('SOURCE: both Ace front ends send the page\'s ?src=, and the route passes it to the lead', () => {
  assert.match(read('ace.js'), /JSON\.stringify\(\{ messages: history, leadCaptured: leadCaptured, src: new URLSearchParams\(location\.search\)\.get\('src'\) \|\| '' \}\)/);
  assert.match(read('ace.html'), /JSON\.stringify\(\{messages:aceHistory,src:new URLSearchParams\(location\.search\)\.get\('src'\)\|\|''\}\)/);
  const chat = read('api/chat.js');
  assert.match(chat, /let \{ messages, leadCaptured, src \} = req\.body \|\| \{\};/);
  assert.match(chat, /captured = await fireLead\(lead, trimmed, src\);/);
  assert.match(chat, /const payload = leadPayload\(lead, messages, src\);/);
});
