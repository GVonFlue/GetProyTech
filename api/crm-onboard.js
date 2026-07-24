// api/crm-onboard.js — Vercel serverless function
// Receives the CRM onboarding form JSON and forwards it to the Google Sheets
// webhook. Identical pattern to api/onboard.js — the only difference is the
// `type` flag, which is what the Apps Script uses to route this to the
// "CRM Onboarding" tab instead of the website onboarding tab.
//
// Webhook URL lives in SHEETS_WEBHOOK_URL
// (Vercel → Project → Settings → Environment Variables).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('crm-onboard: SHEETS_WEBHOOK_URL is not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  // Vercel parses JSON bodies automatically when Content-Type is application/json
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const payload = {
    ...body,
    type: 'crm_onboarding',                // routes to the CRM Onboarding tab
    submitted_at: new Date().toISOString()
  };

  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      console.error('crm-onboard: webhook responded', upstream.status);
      return res.status(502).json({ ok: false, error: 'Upstream error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('crm-onboard: forward failed', err);
    return res.status(502).json({ ok: false, error: 'Forward failed' });
  }
}
