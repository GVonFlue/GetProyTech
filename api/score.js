// api/score.js — the Business Nucleus Score (getproytech.com/score).
//
// The page posts the quiz here. This function forwards it to the CRM's
// existing website-lead door (proytech-crm api/site-lead.js) with the site
// key, and hands the page back the result the CRM worked out.
//
// THE SITE KEY IS READ FROM THE ENVIRONMENT AND NOWHERE ELSE. It is never in
// the page, never in this repo, never in a response and never in a log.
//   Vercel -> Settings -> Environment Variables:
//     CRM_SCORE_SITE_KEY = an INTAKE key made in the CRM (Settings -> Site keys)
// With it unset (or not shaped like a site key) every submission is answered
// "try again later" and NOTHING IS SENT anywhere.
//
// THIS FUNCTION DOES NOT SCORE. It sends which answer was picked for each
// question (ids). The CRM holds the points and the cut-offs in its settings,
// works out the score, the weak areas and the track, and saves the lead.
// Nothing here can send a number: the body below is built key by key.
//
// TWO KINDS OF CALLER, ONE ANSWER:
//   the page's script   JSON in, JSON out: { ok, result:{ total, band, weak, track } }
//   a plain form post   (JavaScript off) form fields in, a small HTML page out
// The result is only ever returned in answer to a submission that carried a
// name, an email and a phone, so the page cannot show it earlier.
//
// What comes back to the browser is the result and nothing else: no lead id,
// no echo of what was typed.
//
// Rate limited with the site's own guard (./_guard.js), and it carries the
// same honeypot as /book (a hidden "fax" field a person never fills).
import { guard, sweep } from './_guard.js';
import { cleanSrc } from './chat.js';

export const KEY_ENV = 'CRM_SCORE_SITE_KEY';
export const CRM_URL = 'https://proytech-crm.vercel.app/api/site-lead';   // the same CRM /book posts to
export const SOURCE = 'Business Nucleus Score';
export const FORM = 'score';
export const HONEYPOT = 'fax';
/* the nine questions, by the id the CRM knows them by (its lib/nucleusscore.js) */
export const QUESTIONS = Object.freeze(['leads', 'speed', 'followup', 'website', 'reviews', 'booking', 'revenue', 'teamSize', 'want']);
/* The consent box's wording, exactly as score.html shows it and as /book
   words it. Sent to the CRM beside a yes, so "they agreed" can always be
   answered with "to what". tests/score.test.mjs holds the three together. */
export const CONSENT_TEXT = 'I agree to receive text messages from ProyTech at the number provided, including replies to my inquiry, appointment reminders, follow ups, and occasional offers. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms.';
export const LATER = 'The score is not available right now. Please try again later.';

const S = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ticked = v => v === true || v === 'true' || v === '1' || v === 'on';

/** The site key, or '' when it is unset or not shaped like one. */
export const siteKey = (env = process.env) => { const k = String(env[KEY_ENV] || '').trim(); return /^pts_[A-Za-z0-9_-]{30,80}$/.test(k) ? k : ''; };

/** What is sent to the CRM for one submission, or the names of what is
 *  missing. Built key by key: nothing the browser sent rides along, so a
 *  score, a track or a source typed into the request goes nowhere.
 *  -> { ok, body, fields } */
export function payload(b) {
  const src = b && typeof b === 'object' ? b : {};
  const fields = [];
  const first = S(src.firstName, 59), last = S(src.lastName, 60);
  const name = [first, last].filter(Boolean).join(' ');
  const email = S(src.email, 160).toLowerCase(), phone = S(src.phone, 40);
  if (!first) fields.push('firstName');
  if (!last) fields.push('lastName');
  if (!EMAIL.test(email)) fields.push('email');
  if (phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length !== 10) fields.push('phone');
  const score = {};
  for (const q of QUESTIONS) { const v = S(src[q], 40); if (SLUG.test(v)) score[q] = v; else fields.push(q); }
  const yes = ticked(src.textConsent);
  const body = { kind: 'lead', source: SOURCE, form: FORM, page: '/score', name, email, phone, score, src: cleanSrc(src.src), textConsent: yes, ...(yes ? { consentText: CONSENT_TEXT } : {}) };
  return { ok: !fields.length, body, fields };
}

/** Only the four things the page shows, each checked and capped: what the
 *  CRM answers is not passed through whole. null when it is not a result. */
export function cleanResult(r) {
  if (!r || typeof r !== 'object' || !Number.isInteger(r.total) || r.total < 0 || r.total > 100) return null;
  const t = r.track && typeof r.track === 'object' ? r.track : {};
  if (!SLUG.test(String(t.name || ''))) return null;
  return {
    total: r.total, band: S(r.band, 40),
    weak: (Array.isArray(r.weak) ? r.weak : []).slice(0, 3).map(w => ({ label: S(w && w.label, 60), line: S(w && w.line, 200) })).filter(w => w.label && w.line),
    track: { name: String(t.name), label: S(t.label, 80) },
  };
}

/* ---- the page for a visitor with JavaScript off ---------------------------- */
const TRACK_PITCH = {
  website: 'The place to start is a website that brings in leads.',
  growth_os: 'You need more than a website: Growth OS is your site plus the Business Suite that runs your leads, follow-up and customers.',
  empire_os: 'A company your size needs a real plan first. Empire OS is the full operating system and AI team.',
};
export function page(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | ProyTech</title><link rel="stylesheet" href="/css/pt-site.css?v=3"></head><body><main><section class="sec sec-dark" style="min-height:100vh"><div class="wrap" style="max-width:680px">${inner}</div></section></main></body></html>`;
}
export function resultHtml(r, src) {
  const weak = r.weak.length
    ? `<h2 class="h2" style="font-size:1.3rem">Your three weakest areas</h2><ol>${r.weak.map(w => `<li style="margin:10px 0"><b>${esc(w.label)}.</b> ${esc(w.line)}</li>`).join('')}</ol>`
    : '<p>No weak area: full marks everywhere.</p>';
  return page('Your Business Nucleus Score', `<p class="eyebrow">Your Business Nucleus Score</p><h1 style="font-size:4rem;margin:10px 0">${r.total}<small style="font-size:1.2rem"> out of 100</small></h1><p class="lede">${esc(r.band)}</p>${weak}
<h2 class="h2" style="font-size:1.3rem">Where to start: ${esc(r.track.label)}</h2><p>${esc(TRACK_PITCH[r.track.name] || '')}</p>
<p style="margin-top:26px"><a class="btn btn-o" href="/book?src=${esc(cleanSrc(src) || 'score')}">Book your Nucleus Session</a></p>`);
}
export const messageHtml = (text, back = true) => page('Business Nucleus Score', `<h1 style="font-size:1.8rem">Business Nucleus Score</h1><p class="lede">${esc(text)}</p>${back ? '<p style="margin-top:26px"><a class="btn btn-o" href="/score">Back to the questions</a></p>' : ''}`);

export default async function handler(req, res) {
  const gate = await guard(req, res, { name: 'score', perIp: 10, windowMin: 10, perDay: 1000, maxChars: 4000 });
  if (!gate.ok) return;
  sweep();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const asJson = /application\/json/i.test(String((req.headers && req.headers['content-type']) || ''));
  res.setHeader('Cache-Control', 'no-store');
  const out = (code, json, html) => (asJson ? res.status(code).json(json) : (res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.status(code).send(html)));

  try {
    /* a bot filled the hidden field: answered like a success, nothing sent */
    if (S(b[HONEYPOT], 10)) return out(200, { ok: true, result: null }, messageHtml('Thanks. We have your answers.', false));

    const key = siteKey();
    if (!key) {
      console.error(`[score] ${KEY_ENV} is not set on this project (or is not a site key): nothing was sent to the CRM`);
      return out(503, { ok: false, error: LATER }, messageHtml(LATER));
    }
    const p = payload(b);
    if (!p.ok) return out(400, { ok: false, error: 'Some answers are missing.', fields: p.fields }, messageHtml('Some answers are missing. Go back, answer every question and fill in your name, mobile number and email.'));

    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12000);
    let r, j = null;
    try {
      r = await fetch(CRM_URL, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(p.body) });
      j = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }

    if (r.status === 400) {
      const fields = (j && Array.isArray(j.fields) ? j.fields : []).filter(f => typeof f === 'string' && SLUG.test(f.toLowerCase())).slice(0, 12);
      return out(400, { ok: false, error: 'Some answers could not be read.', fields }, messageHtml('Some answers could not be read. Go back and check your answers, your mobile number and your email.'));
    }
    const result = r.ok && j && j.ok ? cleanResult(j.result) : null;
    if (!result) {
      console.error(`[score] the CRM did not return a result (status ${r.status})`);
      return out(502, { ok: false, error: LATER }, messageHtml(LATER));
    }
    return out(200, { ok: true, result }, resultHtml(result, p.body.src));
  } catch (e) {
    console.error('[score]', String((e && e.name) || 'error'));
    return out(502, { ok: false, error: LATER }, messageHtml(LATER));
  }
}
