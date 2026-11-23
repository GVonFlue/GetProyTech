// api/audit-report.js — step 3 of the free website teardown: the details form
// and the review.
// Body:   { token, name, company, email, phone, consent?, src?, fax, shot? }
// Answer: { ok, grade, score, needWork, reportUrl }
//      or { ok:false, error }   invalid (+fields) | bad_token | already_sent |
//                               site_limit | save_failed | (the gate's own errors)
//
// ORDER, and why:
//   1. The details are checked and the sealed result opened. A forged or old
//      token stops here, before anything costs money.
//   2. One teardown per email address a day, three per website a day: asked
//      first (peek records nothing), recorded only after the CRM has it, so a
//      failure does not lock anyone out.
//   3. The site is read again for its words (the token carries numbers only):
//      the same up-to-8 pages the scan read. ONE Claude call (Sonnet) reads
//      them all and judges what plain code can't: the first impression, trust,
//      buyer psychology, the journey a visitor takes. This is the only step
//      that spends on the model, and it runs only for someone who gave their
//      name, business, email and mobile. The fresh crawl's numbers are used
//      for the rule items too, so the words and the numbers describe the same
//      visit; if the site can't be read again, the token's numbers are used.
//   4. Claude's answer goes through the evidence guard and the never-claim
//      filter (./_rubric.js checkAi). An unusable answer is not an error: the
//      report goes out on the rule items alone and says so.
//   5. The report is scored with the one rubric and handed to the CRM
//      (/api/teardown-save), which stores it on the lead, sets the code and the
//      dates, and emails the visitor the link. THE SITE STORES NOTHING.
//
// THE SCREENSHOT comes back from the browser; it is used only if its SHA-256
// matches the hash sealed by /api/audit-speed, so nothing else can be swapped in.
//
// MOBILE IS REQUIRED, CONSENT IS NOT. Only the boolean true counts as consent,
// and the consent words sent to the CRM are ours (CONSENT_TEXT), not the page's.
//
// FAILS CLOSED: refuses, naming the variable, when the limiter's three
// (SUPABASE_URL, SUPABASE_ANON_KEY, SITE_LIMIT_SALT), AUDIT_SIGNING_KEY,
// SITE_LEAD_KEY or ANTHROPIC_API_KEY is unset.
import { open, cleanContact } from './_audit.js';
import { auditGate, peek, take, hashed, readSite, askClaude, saveTeardown, shotHash, SHOT_MAX } from './_audit-net.js';
import { ruleResults, checkAi, buildReport, topPainsOf, slugOf, aiSummary, cleanFacts, CONSENT_TEXT } from './_rubric.js';
import { cleanSite, cleanTools } from './_crawl.js';
import { mockSite, mockClaude, mockSave, MOCK_KEY } from './_audit-mock.js';

const KEYS = ['token', 'name', 'company', 'email', 'phone', 'consent', 'src', 'fax', 'shot'];
export const CAPS = { perDay: 25, perIp: 3, ipWindowMin: 60, perSite: 3, perEmail: 1 };
export const centralDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

/* ===== A CAPTCHA GOES HERE ================================================
   There is none today (decision: not yet). When one is added, verify its
   token here and return false to refuse; the page has a matching marked slot
   (#captchaSlot in audit.html). Nothing else needs to change.
   ======================================================================== */
async function verifyHuman(_req, _body) { return true; }

export function makeHandler({ crawl = readSite, claude = askClaude, save = saveTeardown, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    const gate = await auditGate(req, res, { name: 'audit-report', perIp: CAPS.perIp, windowMin: CAPS.ipWindowMin, perDay: CAPS.perDay, maxChars: SHOT_MAX + 6000, need: ['AUDIT_SIGNING_KEY', 'SITE_LEAD_KEY', 'ANTHROPIC_API_KEY'] });
    if (!gate.ok) return;
    const mock = !!gate.mock;
    const b = gate.body;
    const extra = Object.keys(b).filter(k => !KEYS.includes(k));
    if (extra.length) { res.status(400).json({ ok: false, error: 'invalid', fields: extra.slice(0, 5) }); return; }
    /* honeypot: answered like a success, does nothing */
    if (b.fax != null && String(b.fax).trim() !== '') { res.status(200).json({ ok: true, grade: null, score: null, needWork: 0, reportUrl: '' }); return; }
    if (!(await verifyHuman(req, b))) { res.status(400).json({ ok: false, error: 'invalid', fields: ['captcha'] }); return; }

    const contact = cleanContact(b);
    if (!contact.ok) { res.status(400).json({ ok: false, error: 'invalid', fields: contact.errors }); return; }
    const result = open(b.token, mock ? MOCK_KEY : process.env.AUDIT_SIGNING_KEY, now());
    if (!result) { res.status(400).json({ ok: false, error: 'bad_token' }); return; }

    const emailBucket = `site:audit-email:${hashed(contact.email)}`, siteBucket = `site:audit-report-host:${hashed(result.host)}`;
    if (!mock) {
      const sent = await peek(emailBucket, CAPS.perEmail, 60 * 24);
      if (sent === 'down') { res.status(503).json({ ok: false, error: 'limiter_unavailable' }); return; }
      if (sent === 'limit') { res.status(429).json({ ok: false, error: 'already_sent' }); return; }
      const site = await peek(siteBucket, CAPS.perSite, 60 * 24);
      if (site === 'down') { res.status(503).json({ ok: false, error: 'limiter_unavailable' }); return; }
      if (site === 'limit') { res.status(429).json({ ok: false, error: 'site_limit' }); return; }
    }

    const shot = typeof b.shot === 'string' && b.shot.length <= SHOT_MAX && result.shot && shotHash(b.shot) === result.shot ? b.shot : '';
    const read = await (mock ? mockSite : crawl)(result.host).catch(() => null);
    const pages = read && Array.isArray(read.pages) ? read.pages.filter(p => p && typeof p.text === 'string' && p.text) : [];
    /* the fresh numbers when the site was read again, else the sealed ones */
    const facts = (read && cleanFacts(read.facts)) || result.facts;
    const site = read ? (read.site ? cleanSite(read.site) : null) : result.site;
    const tools = read ? cleanTools(read.tools) : result.tools;
    const raw = pages.length ? await (mock ? mockClaude : claude)({ pages, summary: aiSummary({ site, tools, pages }), shot }).catch(() => null) : null;
    const ai = raw ? checkAi(raw, pages, { hadImage: !!shot }) : null;
    if (raw && !ai) console.error('[audit-report] the review answer was unusable; reporting on the rule items alone');

    const results = { ...ruleResults(facts, result, result.speed, site, tools), ...(ai ? ai.results : {}) };
    const builtOn = centralDate(now());
    const report = buildReport({ host: result.host, builtOn, results, ai, speed: result.speed, judgment: !!ai, pages, site, tools });
    const slug = slugOf(result.host);

    const saved = await (mock ? mockSave : save)({
      lead: { name: contact.name, email: contact.email, phone: contact.phone, company: contact.company, website: result.host,
        textConsent: { given: contact.consent, at: new Date(now()).toISOString(), ...(contact.consent ? { text: CONSENT_TEXT } : {}) } },
      teardown: { grade: report.grade, score: report.score, slug, topPains: topPainsOf(report), report, builtOn },
    });
    if (!saved.ok) { res.status(502).json({ ok: false, error: 'save_failed' }); return; }
    if (!mock) { await take(emailBucket, CAPS.perEmail, 60 * 24); await take(siteBucket, CAPS.perSite, 60 * 24); }

    res.status(200).json({ ok: true, grade: report.grade, score: report.score, needWork: report.needWork, reportUrl: saved.reportUrl });
  };
}
export default makeHandler();
