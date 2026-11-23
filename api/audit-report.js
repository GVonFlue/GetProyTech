// api/audit-report.js — step 3 of the free website audit: the gate.
// Body:   { token, name, email, phone, consent?, src?, fax }
// Answer: { ok, grade, needWork, ran, notRun:[names] }
//      or { ok:false, error }   invalid (+fields) | bad_token | already_sent |
//                               email_failed | (the gate's own errors)
//
// It emails the report (Resend) and posts the lead to the CRM (site-lead).
//
// WHAT THE EMAIL IS MADE OF. Only the sealed result this server produced
// (fixed codes and numbers), the first word of the visitor's name (escaped),
// and the link tag (a slug). The browser never sends report content, and a
// token that was altered or forged does not open, so this route cannot be
// used to send somebody words of the sender's choosing.
//
// ORDER: the email first, then the lead. An email that fails is an error the
// visitor sees and can retry, and no lead is written (the CRM route always
// creates a NEW lead, so "lead first" would duplicate on every retry). A lead
// that fails after the email went is logged loudly as LEAD NOT SAVED.
//
// MOBILE IS REQUIRED, CONSENT IS NOT. The number always goes to the CRM. The
// consent box is separate and optional: only the boolean true counts, and the
// lead's message says in words whether it was ticked.
//
// FAILS CLOSED: refuses, naming the variable, when any of the limiter's two,
// AUDIT_SIGNING_KEY, RESEND_API_KEY, AUDIT_FROM or SITE_LEAD_KEY is unset.
// It never falls back to another sender and never drops the lead quietly.
import { open, cleanContact, renderReport, leadPayload, gradeOf, CHECKS } from './_audit.js';
import { auditGate, peek, take, hashed, sendEmail, postLead, fromOk } from './_audit-net.js';

const KEYS = ['token', 'name', 'email', 'phone', 'consent', 'src', 'fax'];

/* ===== A CAPTCHA GOES HERE ================================================
   There is none today (decision: not yet). When one is added, verify its
   token here and return false to refuse; the page has a matching marked slot
   (#captchaSlot in audit.html) and would send the token as one more body key
   (add it to KEYS above). Nothing else needs to change.
   ======================================================================== */
async function verifyHuman(_req, _body) { return true; }

export function makeHandler({ email = sendEmail, lead = postLead } = {}) {
  return async function handler(req, res) {
    const gate = await auditGate(req, res, { name: 'audit-report', perIp: 3, windowMin: 60, perDay: 200, maxChars: 8000, need: ['AUDIT_SIGNING_KEY', 'RESEND_API_KEY', 'AUDIT_FROM', 'SITE_LEAD_KEY'] });
    if (!gate.ok) return;
    if (!fromOk(process.env.AUDIT_FROM)) { console.error('[audit-report] AUDIT_FROM is not a sender address ("Name <you@domain>")'); res.status(503).json({ ok: false, error: 'not_configured', missing: ['AUDIT_FROM'] }); return; }
    const b = gate.body;
    const extra = Object.keys(b).filter(k => !KEYS.includes(k));
    if (extra.length) { res.status(400).json({ ok: false, error: 'invalid', fields: extra.slice(0, 5) }); return; }
    /* honeypot: answered like a success, does nothing */
    if (b.fax != null && String(b.fax).trim() !== '') { res.status(200).json({ ok: true, grade: null, needWork: 0, ran: 0, notRun: [] }); return; }
    if (!(await verifyHuman(req, b))) { res.status(400).json({ ok: false, error: 'invalid', fields: ['captcha'] }); return; }

    const contact = cleanContact(b);
    if (!contact.ok) { res.status(400).json({ ok: false, error: 'invalid', fields: contact.errors }); return; }
    const result = open(b.token, process.env.AUDIT_SIGNING_KEY, Date.now());
    if (!result) { res.status(400).json({ ok: false, error: 'bad_token' }); return; }

    /* one report per email address per day. Asked now (peek records nothing),
       recorded only after the email really went, so a failed send does not
       lock the address out. */
    const bucket = `site:audit-email:${hashed(contact.email)}`;
    const sent = await peek(bucket, 1, 60 * 24);
    if (sent === 'down') { res.status(503).json({ ok: false, error: 'limiter_unavailable' }); return; }
    if (sent === 'limit') { res.status(429).json({ ok: false, error: 'already_sent' }); return; }

    const report = renderReport({ result, firstName: contact.name, src: b.src });
    const mail = await email({ to: contact.email, subject: report.subject, html: report.html, text: report.text });
    if (!mail.ok) { res.status(502).json({ ok: false, error: 'email_failed' }); return; }
    await take(bucket, 1, 60 * 24);

    const saved = await lead(leadPayload({ contact, result, src: b.src }));
    if (!saved.ok) console.error(`[audit-report] LEAD NOT SAVED for an audit of ${result.host}: the report was emailed but the CRM has no lead`);

    const g = gradeOf(result.checks);
    res.status(200).json({ ok: true, grade: g.grade, needWork: g.needWork, ran: g.ran, notRun: g.notRun.map(id => CHECKS.find(c => c.id === id).name) });
  };
}
export default makeHandler();
