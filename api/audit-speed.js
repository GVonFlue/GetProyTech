// api/audit-speed.js — step 2 of the free website audit: the speed test.
// Body:   { token }                      (the sealed result from /api/audit-scan)
// Answer: { ok, token, speedRan, needWork, ran, checks:[{ id, name, ran }] }
//
// One Google PageSpeed Insights lab run on a phone profile, for the address
// inside the sealed result (so this route cannot be pointed at an address the
// scan did not accept). It can take most of a minute: vercel.json gives this
// function 60 seconds and the test itself 50.
//
// A TIMEOUT IS NOT A FAIL. If PageSpeed does not come back, the three speed
// checks are marked "could not run", the report says "speed could not be
// measured today", and everything else still goes out. If this whole function
// is cut off, the page carries on with the token it already has.
//
// FAILS CLOSED like the other audit routes (auditGate): no limiter, no
// AUDIT_SIGNING_KEY or no PAGESPEED_API_KEY means it refuses and names them.
import { open, seal, teaser, SPEED_IDS } from './_audit.js';
import { auditGate, runPageSpeed } from './_audit-net.js';

export function makeHandler({ speed = runPageSpeed } = {}) {
  return async function handler(req, res) {
    const gate = await auditGate(req, res, { name: 'audit-speed', perIp: 5, windowMin: 10, perDay: 300, maxChars: 6500, need: ['AUDIT_SIGNING_KEY', 'PAGESPEED_API_KEY'] });
    if (!gate.ok) return;
    const result = open(gate.body.token, process.env.AUDIT_SIGNING_KEY, Date.now());
    if (!result) { res.status(400).json({ ok: false, error: 'bad_token' }); return; }

    let checks;
    try { checks = await speed(`${result.https ? 'https' : 'http'}://${result.host}/`, process.env.PAGESPEED_API_KEY); }
    catch { checks = null; }
    for (const id of SPEED_IDS) result.checks[id] = (checks && checks[id]) || { s: 'na', c: 'error' };
    res.status(200).json({ ok: true, token: seal(result, process.env.AUDIT_SIGNING_KEY), speedRan: SPEED_IDS.some(id => result.checks[id].s !== 'na'), ...teaser(result.checks) });
  };
}
export default makeHandler();
