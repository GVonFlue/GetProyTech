// tests/report-page.test.mjs — /report (report.html + js/report.js) and the
// view ping (js/td-ping.js). Runs js/report.js against a tiny fake DOM: every
// string reaches the page as text, the code card swaps after its Central-time
// end date, and only our own booking link is ever linked.
//   node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../js/report.js', import.meta.url), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/report.json', import.meta.url), 'utf8'));

/* a DOM just big enough for report.js: elements, text nodes, attributes. No
   HTML parser at all, so if anything tried to parse markup it would show. */
class Node { constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.className = ''; this._text = ''; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { throw new Error('innerHTML was used'); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  set href(v) { this.attrs.href = String(v); } get href() { return this.attrs.href; }
  all() { return [this, ...this.children.flatMap(c => (c.all ? c.all() : []))]; } }
class Text { constructor(t) { this._t = String(t); } get textContent() { return this._t; } }
function makeDoc() {
  const root = new Node('main');
  return { root, title: '', getElementById: id => (id === 'root' ? root : null), createElement: t => new Node(t), createTextNode: t => new Text(t), body: new Node('body') };
}
function load() { const ctx = { globalThis: {}, Intl, URLSearchParams, Date, Number, String, Array, Object, JSON, RegExp, Math, encodeURIComponent }; ctx.globalThis = ctx; vm.runInNewContext(src, ctx); return ctx.TD; }
const TD = load();
const NOV = (d, h = 12) => Date.UTC(2026, 10, d, h, 0, 0);

test('report.js never writes HTML: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval', () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!code.includes(bad), bad);
});

test('render: the fixture draws the grade, the score, the top 3, every category and the offer', () => {
  const doc = makeDoc(); TD.render(doc, fixture, NOV(23));
  const text = doc.root.textContent;
  assert.ok(text.includes('Your website report, Acme Roofing'));
  assert.ok(text.includes('43 / 100'));
  for (const t of fixture.report.top) { assert.ok(text.includes(t.heading), t.heading); assert.ok(text.includes(t.fix)); }
  for (const c of fixture.report.categories) assert.ok(text.includes(c.name), c.name);
  for (const s of ["Let's go over it together", "Book 15 minutes with me and I'll walk you through the fix for every item on this list, in the order that brings in the most calls first. Useful whether we work together or not.", 'Book your call',
    '$500 off our standard website. $1,499 becomes $999, plus $149 a month for hosting and care. Good through December 7, 2026.', "Mention it on the call and we'll get started right away.", fixture.code]) assert.ok(text.includes(s), s);
  assert.ok(text.includes(fixture.report.scoreLabel));
  const btn = doc.root.all().find(n => n.className === 'btn');
  assert.equal(btn.href, 'https://www.getproytech.com/book?src=td-acmeroofing');
});

test('render v2: the pages read, what the site runs on, the visitor\'s journey with each quote\'s page, and no fix outside the top 3', () => {
  const doc = makeDoc(); TD.render(doc, fixture, NOV(23));
  const text = doc.root.textContent, r = fixture.report;
  assert.equal(r.v, 2);
  assert.ok(text.includes('We read 3 pages of your site'));
  for (const s of ['What we looked at', 'The pages we read', '/services', '/contact', 'What your site runs on', 'Contact Form 7', 'Email: Google Workspace', 'How a first-time visitor moves through your site']) assert.ok(text.includes(s), s);
  for (const j of r.journey) { assert.ok(text.includes(j.text), j.text); assert.ok(text.includes(j.quote), j.quote); }
  assert.ok(text.includes('12 areas, 100 points'), 'the v2 grading rule');
  assert.equal(r.items.filter(i => i.fix).length, 0, 'per-item fixes are for the call');
  assert.ok(r.items.some(i => i.page === '/services'), 'a finding says which page it is on');
});

test('render: a report saved before v2 still draws, with the homepage wording', () => {
  const d = JSON.parse(JSON.stringify(fixture));
  delete d.report.v; delete d.report.journey; delete d.report.pages; delete d.report.stack; delete d.report.checked;
  const doc = makeDoc(); TD.render(doc, d, NOV(23));
  const text = doc.root.textContent;
  assert.ok(text.includes('We went through your homepage'));
  assert.ok(text.includes("Book 15 minutes with me and I'll walk you through every finding and how we'd fix it."));
  assert.ok(!text.includes('What we looked at'));
});

test('render: markup in any string from the CRM shows as text and never becomes an element', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const d = JSON.parse(JSON.stringify(fixture));
  d.business = evil; d.report.verdict = [evil]; d.report.top[0].heading = evil; d.report.items[0].quote = evil; d.report.working[0] = { text: evil, quote: evil, page: evil }; d.report.journey[0] = { text: evil, quote: evil, page: evil }; d.report.pages[1] = { path: evil, kind: evil, words: 3 }; d.report.stack.tools[0] = { name: evil, kind: 'forms' }; d.code = evil.slice(0, 40);
  const doc = makeDoc(); TD.render(doc, d, NOV(23));
  assert.ok(doc.root.textContent.includes('<script>alert(2)</script>'));
  const tags = new Set(doc.root.all().map(n => n.tagName));
  for (const t of ['img', 'script', 'iframe']) assert.ok(!tags.has(t), t + ' was created');
});

test('render: a booking link that is not ours is replaced with ours', () => {
  for (const u of ['javascript:alert(1)', 'https://evil.example/book?src=td-x', 'https://www.getproytech.com/book?src=td-x&next=//evil', '']) {
    const d = { ...fixture, bookUrl: u }; const doc = makeDoc(); TD.render(doc, d, NOV(23));
    assert.equal(doc.root.all().find(n => n.className === 'btn').href, 'https://www.getproytech.com/book?src=td-report', u);
  }
});

test('code card: good through its date in Central time, expired from the next Central day, with the agreed words', () => {
  /* codeExpires 2026-12-07: 11:30pm Central on Dec 7 is 05:30 UTC Dec 8, still good */
  assert.equal(TD.codeExpired('2026-12-07', Date.UTC(2026, 11, 8, 5, 30)), false);
  assert.equal(TD.codeExpired('2026-12-07', Date.UTC(2026, 11, 8, 6, 30)), true, '12:30am Central on Dec 8');
  assert.equal(TD.codeExpired('', NOV(23)), true); assert.equal(TD.codeExpired('soon', NOV(23)), true);
  const doc = makeDoc(); TD.render(doc, fixture, Date.UTC(2026, 11, 9, 18));
  const card = doc.root.all().find(n => n.className === 'code').textContent;
  assert.equal(card, "This code expired on December 7, 2026. You can still book a call and we'll go over your report.");
  assert.ok(!doc.root.textContent.includes(fixture.code), 'the expired code itself is not shown');
  assert.equal(doc.root.all().find(n => n.className === 'btn').href, fixture.bookUrl, 'the call is still offered');
});

test('render: no speed and no review are said plainly, not drawn as zeros', () => {
  const d = JSON.parse(JSON.stringify(fixture)); d.report.speed = null; d.report.judgment = false;
  const doc = makeDoc(); TD.render(doc, d, NOV(23));
  const t = doc.root.textContent;
  assert.ok(t.includes('Speed could not be measured today, so it was left out of the grade.'));
  assert.ok(t.includes('Our written review of your copy and layout could not run this time'));
  assert.ok(!/\b0s\b/.test(t));
});

test('boot: 410 is "expired", 404 is "not found", a bad token never reaches the network, ?t=mock reads the local file', async () => {
  const run = async (search, answer) => {
    const doc = makeDoc(); const asked = [];
    const win = { document: doc, location: { search }, fetch: async u => { asked.push(u); return answer(u); } };
    TD.boot(win); await new Promise(r => setTimeout(r, 10));
    return { text: doc.root.textContent, asked };
  };
  let r = await run('?t=abcdefgh1234', async () => ({ status: 410, ok: false }));
  assert.ok(r.text.includes('This report has expired.')); assert.equal(r.asked[0], 'https://proytech-crm.vercel.app/api/teardown-report?t=abcdefgh1234');
  r = await run('?t=abcdefgh1234', async () => ({ status: 404, ok: false }));
  assert.ok(r.text.includes("We couldn't find that report."));
  r = await run('?t=<script>', async () => { throw new Error('must not fetch'); });
  assert.equal(r.asked.length, 0); assert.ok(r.text.includes("We couldn't find that report."));
  r = await run('?t=mock', async () => ({ status: 200, ok: true, json: async () => fixture }));
  assert.deepEqual(r.asked, ['/js/report-mock.json']); assert.ok(r.text.includes('Acme Roofing'));
});

test('report.html: noindex, no referrer, loads report.js and the view ping', () => {
  const html = fs.readFileSync(new URL('../report.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.ok(html.includes('src="/js/report.js') && html.includes('src="/js/td-ping.js'));
});

test('td-ping: once per load, slug or token only, to the CRM; on every hand-built report and on no preview homepage', () => {
  const ping = fs.readFileSync(new URL('../js/td-ping.js', import.meta.url), 'utf8');
  assert.ok(ping.includes("'https://proytech-crm.vercel.app/api/teardown-view'"));
  assert.ok(ping.includes('sendBeacon') && ping.includes('__tdPinged'));
  assert.ok(!/cookie|localStorage|email/i.test(ping.replace(/\/\*[\s\S]*?\*\//g, '')));
  /* run it twice in one page: one beacon, with the slug from the meta tag */
  const beacons = [];
  const page = slug => ({ window: {}, location: { search: '' }, document: { querySelector: () => (slug ? { content: slug } : null) }, navigator: { sendBeacon: (u, b) => { beacons.push(u); return true; } }, Blob: class { constructor(p) { this.p = p; } }, URLSearchParams, JSON, fetch: () => { throw new Error('beacon first'); } });
  const ctx = page('acmeroofing'); ctx.window = ctx; vm.runInNewContext(ping, ctx); vm.runInNewContext(ping, ctx);
  assert.equal(beacons.length, 1);
  const none = page(''); none.window = none; vm.runInNewContext(ping, none); assert.equal(beacons.length, 1, 'no slug, no token: no ping');
  const dir = new URL('../previews/', import.meta.url);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  const reports = files.filter(f => f.endsWith('-report.html'));
  assert.ok(reports.length >= 25);
  for (const f of reports) {
    const h = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.ok(h.includes(`<meta name="td-slug" content="${f.replace('-report.html', '')}">`), f);
    assert.equal(h.split('/js/td-ping.js').length - 1, 1, f + ' loads the ping once');
  }
  for (const f of files.filter(f => !f.endsWith('-report.html'))) assert.ok(!fs.readFileSync(new URL(f, dir), 'utf8').includes('td-ping'), f + ' is a preview homepage');
});

test('render: a page weight measured without Google\'s speed test shows the weight, never "null"', () => {
  const d = JSON.parse(JSON.stringify(fixture));
  d.report.speed = { lcpS: null, cls: null, weightMb: 11.1, fullMb: 38 };
  const doc = makeDoc(); TD.render(doc, d, NOV(23));
  const text = doc.root.textContent;
  assert.ok(text.includes('11.1 MB') && text.includes('38 MB')); assert.ok(!/null/.test(text));
  assert.ok(text.includes('load time was left out of the grade'));
});

test('boot: a hand-built report draws its own inline data, and stops after its preview-expires day', () => {
  const page = fs.readFileSync(new URL('../previews/visionary-report.html', import.meta.url), 'utf8');
  const meta = n => (new RegExp(`<meta name="${n}" content="([^"]+)"`).exec(page) || [])[1];
  assert.equal(meta('robots'), 'noindex, nofollow'); assert.equal(meta('td-slug'), 'visionary');
  assert.equal(meta('code-expires'), '2026-12-07'); assert.equal(meta('preview-expires'), '2026-12-23');
  assert.ok(page.includes('/js/td-ping.js'));
  const json = /<script type="application\/json" id="td-data">([\s\S]*?)<\/script>/.exec(page)[1];
  assert.ok(!json.includes('<'), 'no raw < inside the inline JSON');
  const data = JSON.parse(json);
  const boot = (expires, nowMs) => {
    const doc = makeDoc(), inline = { textContent: json };
    doc.getElementById = id => (id === 'root' ? doc.root : id === 'td-data' ? inline : null);
    doc.querySelector = () => ({ content: expires });
    const realNow = Date.now; Date.now = () => nowMs;
    try { TD.boot({ document: doc, location: { search: '' }, fetch: () => { throw new Error('no fetch for inline reports'); } }); } finally { Date.now = realNow; }
    return doc.root.textContent;
  };
  const live = boot('2026-12-23', NOV(24));
  assert.ok(live.includes('Your website report, Visionary Carpet & Upholstery Cleaning'));
  assert.ok(live.includes('TEARDOWN-VISIONARY')); assert.equal(data.report.grade, 'C');
  assert.ok(boot('2026-12-23', Date.UTC(2026, 11, 24, 18)).includes('This report has expired.'));
});

test('render: the code card uses the report\'s own offer numbers, and falls back to the standard offer', () => {
  const d = JSON.parse(JSON.stringify(fixture)); d.monthly = 79;
  let doc = makeDoc(); TD.render(doc, d, NOV(23));
  assert.ok(doc.root.textContent.includes('$500 off our standard website. $1,499 becomes $999, plus $79 a month for hosting and care.'));
  d.monthly = 'abc'; d.codePrice = 5000;
  doc = makeDoc(); TD.render(doc, d, NOV(23));
  assert.ok(doc.root.textContent.includes('$1,499 becomes $999, plus $149 a month'), 'odd values fall back to the standard offer');
  const page = fs.readFileSync(new URL('../previews/visionary-report.html', import.meta.url), 'utf8');
  assert.equal(JSON.parse(/id="td-data">([\s\S]*?)<\/script>/.exec(page)[1]).monthly, 79, 'Leo\'s report carries $79 a month');
});
