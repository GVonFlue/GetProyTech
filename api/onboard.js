// api/onboard.js — Vercel serverless function
// Receives the onboarding form JSON and forwards it to the Google Sheets
// webhook. Same pattern as api/lead.js: the webhook URL lives in the
// SHEETS_WEBHOOK_URL environment variable (Vercel → Project → Settings →
// Environment Variables).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('onboard: SHEETS_WEBHOOK_URL is not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  // Vercel parses JSON bodies automatically when Content-Type is application/json
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const payload = {
    ...body,
    type: 'onboarding',                    // flag so the Sheet script can route it
    submitted_at: new Date().toISOString()
  };

  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      console.error('onboard: webhook responded', upstream.status);
      return res.status(502).json({ ok: false, error: 'Upstream error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('onboard: forward failed', err);
    return res.status(502).json({ ok: false, error: 'Forward failed' });
  }
}
