// api/audit-scan.js — step 1 of the free website audit (/audit).
// Body:   { url }
// Answer: { ok, host, token, needWork, ran, checks:[{ id, name, ran }] }
//      or { ok:false, error }   bad_address | private | unreachable | blocked |
//                               not_html | host_limit | (the gate's own errors)
//
// It fetches ONE page, the homepage of the address given, the way a visitor's
// browser would, with a user agent that names us (./_audit-net.js has the
// rules that keep that fetch off private networks). The result goes back
// SEALED: the browser carries it to the next two routes and can neither read
// the details nor change them. Before the gate the visitor sees check names
// and a count, nothing more.
//
// FAILS CLOSED: with the rate limiter or AUDIT_SIGNING_KEY not configured it
// refuses and names the missing variables (auditGate).
import { validateUrl, seal, teaser, secretOk } from './_audit.js';
import { auditGate, scanSite, take, hashed } from './_audit-net.js';

const WHY = { private: 'private', bad_address: 'bad_address', not_html: 'not_html', http_status: 'blocked', too_many_redirects: 'unreachable', timeout: 'unreachable', tls: 'unreachable', network: 'unreachable' };

export function makeHandler({ scan = scanSite } = {}) {
  return async function handler(req, res) {
    const gate = await auditGate(req, res, { name: 'audit-scan', perIp: 5, windowMin: 10, perDay: 300, maxChars: 600, need: ['AUDIT_SIGNING_KEY'] });
    if (!gate.ok) return;
    if (!secretOk(process.env.AUDIT_SIGNING_KEY)) { console.error('[audit-scan] AUDIT_SIGNING_KEY is shorter than 32 characters'); res.status(503).json({ ok: false, error: 'not_configured', missing: ['AUDIT_SIGNING_KEY'] }); return; }

    const v = validateUrl(gate.body.url);
    if (!v.ok) { res.status(400).json({ ok: false, error: v.why === 'private_name' || v.why === 'ip_literal' ? 'private' : 'bad_address' }); return; }
    /* one site cannot be hammered through us: 5 audits of a host a day */
    const host = await take(`site:audit-host:${hashed(v.host)}`, 5, 60 * 24);
    if (host === 'down') { res.status(503).json({ ok: false, error: 'limiter_unavailable' }); return; }
    if (host === 'limit') { res.status(429).json({ ok: false, error: 'host_limit' }); return; }

    try {
      const r = await scan(v.host);
      if (!r.ok) { res.status(200).json({ ok: false, error: WHY[r.why] || 'unreachable' }); return; }
      res.status(200).json({ ok: true, host: v.host, token: seal(r.data, process.env.AUDIT_SIGNING_KEY), ...teaser(r.data.checks) });
    } catch (e) {
      console.error('[audit-scan]', String((e && e.message) || e).slice(0, 200));
      res.status(200).json({ ok: false, error: 'unreachable' });
    }
  };
}
export default makeHandler();
