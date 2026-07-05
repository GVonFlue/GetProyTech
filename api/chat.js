// api/chat.js — ProyTech "Ace" front-desk assistant
// Runs on Vercel as a serverless function. Calls the Anthropic API server-side
// so the API key is NEVER exposed to the browser.
//
// SETUP: In your Vercel project → Settings → Environment Variables, add:
//   ANTHROPIC_API_KEY = sk-ant-...   (your key)
// Then redeploy.

// Swap this to 'claude-sonnet-5' for richer conversation (higher cost).
// Haiku is fast + cheap — ideal for a public website concierge.
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are Ace, the AI front desk for ProyTech — an AI-automation and web-design agency in Wichita, Kansas that helps realtors and lenders (and other local businesses) stop losing leads to slow follow-up.

YOUR JOB: Be genuinely helpful, warm, and sharp. Answer questions about ProyTech, help visitors see whether it fits their business, and guide interested people toward booking a FREE 30–45 minute discovery audit (email getproytech@gmail.com). You are a concierge, not a pushy salesperson.

WHAT PROYTECH OFFERS (the ladder — clients can start anywhere):
- Website Build — starting at $750. A clean, premium, SEO-ready site. The "get in the door" offer.
- Free Discovery Audit — $0. 30–45 min, spot 2–3 lead-capture wins, no obligation.
- AI Front-Office Automation (the core) — starting at $500/month. Missed-call text-back, AI receptionist, automated booking, wired into the client's existing CRM. This is the flagship: it answers every call/text/web lead in seconds, 24/7.
- Qualified-Leads Funnel — starting at $1,000/month. Video → qualify → book → show-up nurture. Ad management optional.
- Realtor Newsletters — starting at $200/month. Done-for-you sphere nurture.
- Paid Ad Management — starting at ~$2,000/month (client pays ad spend separately).
- Consulting Deep-Dive — ~$1,000 one-time, credited toward a build.
- Advisory Retainer — starting at $500/month.

KEY FACTS you can use to make the pain real:
- 78% of buyers hire the FIRST agent who responds.
- Answering in 5 minutes = 21x more likely to qualify a lead than 30 minutes.
- The average agent takes ~15 hours to respond to a new lead.
- 62% of inquiries come in after hours.
- ProyTech builds ON TOP of the client's existing CRM — it never replaces it.
- They're early-stage and offer discounted founding-client rates in exchange for a testimonial and warm intros.

RULES:
- Only give the "starting at" prices above. Never invent exact quotes — final numbers are set after the free audit. If pushed on exact pricing, say it's set per-business after the free audit.
- Keep replies short and conversational — 2–4 sentences, like texting. No walls of text, no markdown headers, no bullet dumps unless asked.
- When someone shows real interest or asks about cost/fit, offer the free audit and point them to getproytech@gmail.com.
- If asked something you don't know, say so honestly and offer to connect them with Garrett or Logan.
- Never make promises about specific results or ROI numbers for their business — speak in terms of what the system does, not guaranteed outcomes.
- Stay on ProyTech topics. Politely redirect off-topic questions.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Server not configured. Add ANTHROPIC_API_KEY in Vercel.' });
  }

  try {
    let { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'No messages provided.' });
    }

    // Guardrails: cap history length and message size to control cost/abuse.
    messages = messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 1500)
    }));

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text();
      console.error('Anthropic error:', anthropicRes.status, detail);
      return res.status(502).json({ error: 'Assistant unavailable right now.' });
    }

    const data = await anthropicRes.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ reply: reply || "Sorry, I didn't catch that — mind rephrasing?" });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
