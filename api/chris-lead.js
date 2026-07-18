// api/chris-lead.js — receives leads from the Riff demo (/askchris)
// and forwards them to a Google Apps Script webhook that:
//   1. Logs the lead to a Google Sheet
//   2. Emails it to chris@mortgagepunk.com (CC getproytech@gmail.com)
//
// ENV VAR (Vercel → Settings → Environment Variables):
//   CHRIS_WEBHOOK_URL = the Apps Script web-app URL (see chris-apps-script.gs)
//
// Same pattern as api/lead.js.

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
      goal: String(b.goal || '').slice(0, 60),
      timeline: String(b.timeline || '').slice(0, 60),
      source: 'getproytech.com/askchris · Riff demo',
      submitted_at: new Date().toISOString()
    };

    if (!lead.name || !lead.email || !lead.phone) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    if (!process.env.CHRIS_WEBHOOK_URL) {
      // Fail loudly during setup so a missing env var gets caught before demo day.
      console.error('CHRIS_WEBHOOK_URL not set — lead not delivered:', lead.email);
      return res.status(500).json({ error: 'Demo not fully configured yet.' });
    }

    await fetch(process.env.CHRIS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('chris-lead handler error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
