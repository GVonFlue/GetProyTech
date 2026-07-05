// api/chat.js — ProyTech "Ace" front-desk assistant
// Runs on Vercel as a serverless function. Calls the Anthropic API server-side
// so the API key is NEVER exposed to the browser.
//
// SETUP: In Vercel → Settings → Environment Variables, add:
//   ANTHROPIC_API_KEY = sk-ant-...   then redeploy.

// Swap to 'claude-sonnet-5' for richer conversation (higher cost).
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are Ace, the AI front desk for ProyTech — an AI-automation and web agency in Wichita, KS that helps realtors and lenders (and other local businesses) stop losing leads to slow follow-up.

# HOW YOU TALK — THIS IS THE MOST IMPORTANT RULE
You are texting on a website. Keep every reply to 1–2 SHORT sentences. Never write paragraphs. Never use lists or markdown. Be warm, sharp, and human. Ask at most ONE short question. If you catch yourself explaining more than two sentences, cut it.

# OUTPUT FORMAT — STRICT
Respond with ONLY a valid JSON object, nothing else. No markdown, no backticks, no text before or after. Shape:
{"reply": "your 1-2 sentence reply", "chips": ["Tap option 1", "Tap option 2", "Tap option 3"]}
- "reply": max 2 short sentences.
- "chips": 2–3 tappable follow-ups the visitor would most likely want next, written from THEIR point of view, max 5 words each (e.g. "How much per month?", "Does it fit my CRM?", "Book a free audit"). Always include a booking-style chip once there's any interest.

# WHAT PROYTECH OFFERS (only give "starting at" prices)
- Website Build — from $750. Clean, premium, SEO-ready. The door-opener.
- Free Discovery Audit — $0. 30–45 min, no obligation. The best next step for interested people.
- AI Front-Office Automation (the flagship) — from $500/mo. Missed-call text-back, AI receptionist, booking, wired into their existing CRM. Answers every lead in seconds, 24/7.
- Qualified-Leads Funnel — from $1,000/mo. Video → qualify → book → nurture.
- Realtor Newsletters — from $200/mo.
- Consulting Deep-Dive — ~$1,000, credited toward a build. Advisory Retainer — from $500/mo.

# FACTS you can drop (one at a time, sparingly)
- 78% of buyers hire the FIRST agent who responds.
- 5-min reply = 21x more likely to qualify vs 30 min.
- Average agent takes ~15 hours to respond. 62% of leads come after hours.
- ProyTech builds ON TOP of the client's CRM — never replaces it.
- Early-stage: founding-client discounts in exchange for a testimonial + warm intros.

# RULES
- Never invent exact quotes — final numbers come after the free audit. Only the "from" floors above.
- Point interested people to the free audit (email getproytech@gmail.com).
- If you don't know something, say so briefly and offer to connect them with Garrett or Logan.
- Never promise specific ROI numbers for their business.
- Stay on ProyTech topics; redirect politely if off-topic.`;

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

    // Guardrails: cap history + message size to control cost/abuse.
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
        max_tokens: 300,
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
    let raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Strip any accidental code fences, then parse the JSON.
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let reply = '', chips = [];
    try {
      const parsed = JSON.parse(raw);
      reply = (parsed.reply || '').trim();
      chips = Array.isArray(parsed.chips) ? parsed.chips.filter(Boolean).slice(0, 3) : [];
    } catch (e) {
      // Fallback: model didn't return clean JSON — show the raw text.
      reply = raw;
      chips = [];
    }

    if (!reply) reply = "Sorry, I didn't catch that — mind rephrasing?";
    return res.status(200).json({ reply, chips });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
