// api/lead.js — receives leads from Ace Express and fans them out.
//
// ENV VARS (Vercel → Settings → Environment Variables):
//   SHEETS_WEBHOOK_URL  = your Google Apps Script web-app URL (writes to Sheet + emails you)
//   GHL_WEBHOOK_URL     = (optional, later) GoHighLevel inbound-webhook URL — triggers the instant SMS
//
// If a destination isn't configured it's skipped, so the site keeps working
// while pieces come online.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};

    // Honeypot: real users never fill this hidden field.
    if (b.company) return res.status(200).json({ ok: true });

    const lead = {
      name: String(b.name || '').slice(0, 120),
      phone: String(b.phone || '').slice(0, 40),
      email: String(b.email || '').slice(0, 160),
      role: String(b.role || '').slice(0, 60),
      pain: String(b.pain || '').slice(0, 120),
      volume: String(b.volume || '').slice(0, 60),
      source: 'getproytech.com · Ace Express',
      submitted_at: new Date().toISOString()
    };

    if (!lead.name || !lead.email || !lead.phone) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const jobs = [];

    if (process.env.SHEETS_WEBHOOK_URL) {
      jobs.push(fetch(process.env.SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead)
      }).catch(e => console.error('Sheets webhook failed:', e)));
    } else {
      console.warn('SHEETS_WEBHOOK_URL not set — lead not persisted:', lead.email);
    }

    if (process.env.GHL_WEBHOOK_URL) {
      jobs.push(fetch(process.env.GHL_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead)
      }).catch(e => console.error('GHL webhook failed:', e)));
    }

    await Promise.all(jobs);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('lead handler error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
