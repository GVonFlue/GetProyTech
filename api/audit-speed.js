// api/audit-speed.js — step 2 of the free website teardown: the speed test.
// Body:   { token }                      (the sealed result from /api/audit-scan)
// Answer: { ok, token, speedRan, needWork, checked, misses, shot }
//
// One Google PageSpeed Insights lab run on a phone profile (performance and
// SEO), for the address inside the sealed result, so this route cannot be
// pointed at an address the scan did not accept. It can take most of a
// minute: vercel.json gives this function 60 seconds and the test itself 50.
//
// THE SCREENSHOT. PageSpeed's phone screenshot goes back to the browser as
// `shot` (a data: URL) so the details step can hand it to the review; only its
// SHA-256 is sealed into the token, so the review route can tell that the same
// image came back and nothing else was swapped in.
//
// A TIMEOUT IS NOT A FAIL. If PageSpeed does not come back, the speed items
// are "could not measure" and everything else still goes ahead. PAGESPEED_API_KEY
// is optional: without it Google's keyless quota is used.
//
// FAILS CLOSED like the other routes (auditGate): no limiter or no
// AUDIT_SIGNING_KEY means it refuses and names them.
import { open, seal, teaser } from './_audit.js';
import { auditGate, runPageSpeed, shotHash } from './_audit-net.js';
import { mockSpeed, MOCK_KEY } from './_audit-mock.js';

export function makeHandler({ speed = runPageSpeed } = {}) {
  return async function handler(req, res) {
    const gate = await auditGate(req, res, { name: 'audit-speed', perIp: 5, windowMin: 10, perDay: 300, maxChars: 6500, need: ['AUDIT_SIGNING_KEY'] });
    if (!gate.ok) return;
    const key = gate.mock ? MOCK_KEY : process.env.AUDIT_SIGNING_KEY;
    const result = open(gate.body.token, key, Date.now());
    if (!result) { res.status(400).json({ ok: false, error: 'bad_token' }); return; }

    let sp = null;
    try { sp = await (gate.mock ? mockSpeed : speed)(`${result.https ? 'https' : 'http'}://${result.host}/`, process.env.PAGESPEED_API_KEY || ''); }
    catch { sp = null; }
    const shot = sp && sp.shot ? sp.shot : '';
    result.speed = sp ? { lcpMs: sp.lcpMs, cls: sp.cls, weightBytes: sp.weightBytes, fontOk: sp.fontOk, tapOk: sp.tapOk } : null;
    result.shot = shotHash(shot);
    res.status(200).json({ ok: true, token: seal(result, key), speedRan: !!(sp && Number.isFinite(sp.lcpMs)), ...teaser(result), shot });
  };
}
export default makeHandler();
