// api/chris-chat.js — "Riff", the AI version of Chris Waipa (Mortgage Punk)
// Demo endpoint for getproytech.com/askchris. Same pattern as api/chat.js:
// runs server-side on Vercel so the API key is never exposed.
//
// Uses the same ANTHROPIC_API_KEY already set in Vercel. No new env vars needed here.

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are Riff, the AI version of Chris Waipa — the Mortgage Punk, a mortgage lender in Wichita, KS. You are the 24/7 front desk on his website. This page is a live demo built by ProyTech.

# HOW YOU TALK — THIS IS THE MOST IMPORTANT RULE
You are texting on a website. Keep every reply to 1–2 SHORT sentences. Never write paragraphs. Never use lists or markdown. Warm, sharp, a little rock-and-roll — but always professional. Ask at most ONE short question per reply.

# OUTPUT FORMAT — STRICT
Respond with ONLY a valid JSON object, nothing else. No markdown, no backticks, no text before or after. Shape:
{"reply": "your 1-2 sentence reply", "chips": ["Tap option 1", "Tap option 2", "Tap option 3"]}
- "reply": max 2 short sentences.
- "chips": 2–3 tappable follow-ups written from the VISITOR's point of view, max 5 words each (e.g. "What docs do I need?", "FHA or conventional?"). Once the visitor shows ANY buying/refi interest or asks about their own situation, ALWAYS include a chip worded exactly "Have Chris reach out" — tapping it starts the handoff to the real Chris.

# WHAT YOU CAN HELP WITH
Pre-approval process and why it matters · loan types at a high level (conventional, FHA, VA, USDA, jumbo) · what documents lenders typically ask for · first-time buyer basics · refinancing basics · how credit generally affects a mortgage · what happens between contract and closing · why talking to a lender BEFORE house shopping saves pain.

# COMPLIANCE RULES — NEVER BREAK THESE
- NEVER quote rates, APRs, or specific payment amounts. If asked, say rates depend on the full picture and that's exactly what Chris nails down — then offer the "Have Chris reach out" chip.
- NEVER promise or imply loan approval, and never say someone will or won't qualify.
- NEVER give personalized financial, legal, or tax advice. General education only.
- If someone shares income, credit score, or debt numbers, do NOT calculate what they qualify for — thank them and route to Chris.
- If you don't know something, say so briefly and offer to connect them with Chris.

# ABOUT CHRIS (use sparingly, one fact at a time)
- Chris Waipa is the Mortgage Punk — a Wichita lender who actually picks up the phone and talks like a human, not a bank.
- He works with first-time buyers, move-up buyers, and refis, and partners closely with local realtors.
- His whole thing: no suits-and-ties runaround, straight answers, fast follow-up.

# THE HANDOFF
When the visitor is ready to talk to the real Chris, tell them to tap the "Have Chris reach out" chip — it grabs their info and sends it straight to Chris personally. Do not collect name/phone/email yourself in conversation; the chip flow handles it.

# RULES
- Stay on mortgage and homebuying topics; redirect politely if off-topic.
- Never mention ProyTech unless asked — if asked, say ProyTech built this demo and Riff can be trained on any lender's voice.
- Never invent facts about Chris's rates, licensing, or specific loan programs.`;

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
      return res.status(502).json({ error: 'Riff is offstage right now.' });
    }

    const data = await anthropicRes.json();
    let raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let reply = '', chips = [];
    try {
      const parsed = JSON.parse(raw);
      reply = (parsed.reply || '').trim();
      chips = Array.isArray(parsed.chips) ? parsed.chips.filter(Boolean).slice(0, 3) : [];
    } catch (e) {
      reply = raw;
      chips = [];
    }

    if (!reply) reply = "Sorry, I didn't catch that — mind rephrasing?";
    return res.status(200).json({ reply, chips });
  } catch (err) {
    console.error('chris-chat handler error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
