// api/audit-scan.js — step 1 of the free website teardown (/audit).
// Body:   { url }
// Answer: { ok, host, token, needWork, checked, misses:[names], pages:[paths], stack }
//      or { ok:false, error }   bad_address | private | unreachable | blocked |
//                               not_html | host_limit | (the gate's own errors)
//
// It reads the site the way a visitor's browser would, with a user agent that
// names us: the homepage, then up to 7 more of its pages, its robots.txt,
// sitemap and llms.txt, and the domain's email records (./_audit-net.js
// crawlSite; the rules that keep every fetch off private networks are there).
// The rubric's rule items are read off what came back. NO AI HERE: this step
// is free. `pages` (the paths read) and `stack` (what the site runs on, in
// names from OUR tables) go back for the progress screen only; they are not
// in the token.
// The result goes back SEALED: the browser carries it to the next two routes
// and can neither read the details nor change them. Before the details form
// the visitor sees a count and a few item names, no grade.
//
// FAILS CLOSED: with the rate limiter or AUDIT_SIGNING_KEY not configured it
// refuses and names the missing variables (auditGate).
import { validateUrl, seal, teaser, secretOk } from './_audit.js';
import { auditGate, scanSite, take, hashed } from './_audit-net.js';
import { mockScan, MOCK_KEY } from './_audit-mock.js';

const WHY = { private: 'private', bad_address: 'bad_address', not_html: 'not_html', http_status: 'blocked', too_many_redirects: 'unreachable', timeout: 'unreachable', tls: 'unreachable', network: 'unreachable' };

export function makeHandler({ scan = scanSite } = {}) {
  return async function handler(req, res) {
    const gate = await auditGate(req, res, { name: 'audit-scan', perIp: 5, windowMin: 10, perDay: 300, maxChars: 600, need: ['AUDIT_SIGNING_KEY'] });
    if (!gate.ok) return;
    const key = gate.mock ? MOCK_KEY : process.env.AUDIT_SIGNING_KEY;
    if (!secretOk(key)) { console.error('[audit-scan] AUDIT_SIGNING_KEY is shorter than 32 characters'); res.status(503).json({ ok: false, error: 'not_configured', missing: ['AUDIT_SIGNING_KEY'] }); return; }

    const v = validateUrl(gate.body.url);
    if (!v.ok) { res.status(400).json({ ok: false, error: v.why === 'private_name' || v.why === 'ip_literal' ? 'private' : 'bad_address' }); return; }
    if (!gate.mock) {
      /* one site cannot be hammered through us: 5 scans of a host a day */
      const host = await take(`site:audit-host:${hashed(v.host)}`, 5, 60 * 24);
      if (host === 'down') { res.status(503).json({ ok: false, error: 'limiter_unavailable' }); return; }
      if (host === 'limit') { res.status(429).json({ ok: false, error: 'host_limit' }); return; }
    }

    try {
      const r = await (gate.mock ? mockScan : scan)(v.host);
      if (!r.ok) { res.status(200).json({ ok: false, error: WHY[r.why] || 'unreachable' }); return; }
      const pages = (Array.isArray(r.pages) ? r.pages : []).slice(0, 8).map(p => String(p).slice(0, 120));
      const st = r.stack && typeof r.stack === 'object' ? r.stack : null;
      const stack = st ? { platform: String(st.platform || ''), tools: (st.tools || []).slice(0, 12).map(t => String(t.name)), email: String(st.email || '') } : null;
      res.status(200).json({ ok: true, host: v.host, token: seal(r.data, key), ...teaser(r.data), pages, stack });
    } catch (e) {
      console.error('[audit-scan]', String((e && e.message) || e).slice(0, 200));
      res.status(200).json({ ok: false, error: 'unreachable' });
    }
  };
}
export default makeHandler();
