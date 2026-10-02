// api/growth-plan.js — receives "Book your free Growth Plan" requests from /book.
// ENV (Vercel → Settings → Environment Variables):
//   GROWTH_PLAN_WEBHOOK_URL = Google Apps Script web-app URL (or any JSON webhook) that stores the request
// Falls back to SHEETS_WEBHOOK_URL if set. If nothing is configured, returns stored:false
// and the page falls back to opening an email, so no request is ever lost silently.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const b = req.body || {};
  if (b.company) return res.status(200).json({ ok: true, stored: true }); // honeypot
  const s = (v, n) => String(v || '').trim().slice(0, n);
  const r = {
    type: 'growth_plan_request',
    name: s(b.name, 120), phone: s(b.phone, 40), email: s(b.email, 160),
    business: s(b.business, 160), industry: s(b.industry, 80), revenue: s(b.revenue, 40),
    team: s(b.team, 40), problem: s(b.problem, 1000), when: s(b.when, 120),
    source: s(b.source, 60) || 'book-page', submitted_at: new Date().toISOString()
  };
  if (!r.name || (!r.email && r.phone.replace(/\D/g, '').length < 10)) return res.status(400).json({ ok: false, error: 'missing' });
  const url = process.env.GROWTH_PLAN_WEBHOOK_URL || process.env.SHEETS_WEBHOOK_URL;
  if (!url) return res.status(200).json({ ok: true, stored: false });
  try {
    const out = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(r) });
    return res.status(200).json({ ok: true, stored: out.ok });
  } catch (e) {
    console.error('growth plan webhook failed', e);
    return res.status(200).json({ ok: true, stored: false });
  }
}
