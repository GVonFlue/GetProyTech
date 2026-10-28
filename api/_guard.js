// api/_guard.js — rate limiting for the PUBLIC marketing-site endpoints.
//
// The threat isn't a clever attacker, it's a cheap one: a loop calling a public
// endpoint a few thousand times overnight. The AI endpoints (Ace, Riff) bill
// per token to Anthropic and per invocation to Vercel, so an open endpoint is a
// direct line to the card. The form endpoints are cheaper but can be flooded
// with junk leads into the Sheet, the CRM, and the inbox.
//
// Three layers:
//   1. Input size  — rejects an oversized body before anything expensive runs
//   2. Global cap   — bounds the worst-case daily bill across ALL callers,
//                     which per-IP limits cannot (a botnet passes every per-IP
//                     check); this is the layer that actually caps the bill
//   3. Per-IP       — stops one machine hammering the endpoint
//
// State lives in Supabase (the same api_hits table the CRM uses) because Vercel
// functions are stateless and cold starts — exactly when you're hit hardest —
// would reset an in-memory counter. Buckets are namespaced "site:<name>" so
// they never collide with the CRM's own counters.
//
// FAILS OPEN. If Supabase isn't configured, or it blips, the request is allowed:
// a rate limiter that takes the marketing site down when its datastore hiccups
// is worse than the abuse it prevents. Until SUPABASE_URL + SUPABASE_SERVICE_KEY
// are set on this Vercel project (see _env.js), the size check still runs and
// the rate limiting is simply inactive — so deploying this breaks nothing.

import { SUPA_URL, SUPA_KEY } from './_env.js';

/** Caller's IP. Vercel sets x-forwarded-for; take the FIRST entry — later ones
 *  are proxies and are trivially spoofable by the client. */
export function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function sbCall(path, opts = {}) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPA_KEY,
      authorization: `Bearer ${SUPA_KEY}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sb(path, opts = {}) {
  if (!SUPA_URL || !SUPA_KEY) return null;   // not configured — fail open
  try { return await sbCall(path, opts); }
  catch { return null; }                     // outage — fail open
}

/** Count hits in a rolling window and record this one. Returns {ok}. */
async function bump(bucket, limit, windowMin) {
  const since = new Date(Date.now() - windowMin * 60000).toISOString();
  const rows = await sb(
    `api_hits?bucket=eq.${encodeURIComponent(bucket)}&at=gte.${since}&select=id`
  );
  if (rows === null) return { ok: true, degraded: true };   // unreachable → allow
  if (rows.length >= limit) return { ok: false };
  await sb('api_hits', {
    method: 'POST',
    body: JSON.stringify({ bucket, at: new Date().toISOString() }),
  });
  return { ok: true };
}

/**
 * Guard a public endpoint. Call it first thing in the handler:
 *
 *   const gate = await guard(req, res, { name:'chat', perIp:30, perDay:3000, maxChars:30000 });
 *   if (!gate.ok) return;              // guard already sent the response
 *
 * Options:
 *   name      required. Namespaces the counters per endpoint.
 *   perIp     requests per IP per window     (default 20)
 *   windowMin window length in minutes       (default 10)
 *   perDay    GLOBAL cap across all callers   (default 2000)
 *   maxChars  reject bodies larger than this  (default 12000) — ALWAYS set per route.
 */
export async function guard(req, res, opts = {}) {
  const {
    name,
    perIp = 20,
    windowMin = 10,
    perDay = 2000,
    maxChars = 12000,
  } = opts;

  if (req.method === 'OPTIONS') { res.status(204).end(); return { ok: false }; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return { ok: false };
  }

  // 1. input size, before anything expensive
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (raw.length > maxChars) {
    res.status(413).json({ error: 'That request is too large.' });
    return { ok: false };
  }

  // 2. global daily cap FIRST — the only layer that bounds a botnet's bill
  const day = await bump(`site:${name}:global`, perDay, 60 * 24);
  if (!day.ok) {
    console.error(`[guard] DAILY CAP HIT on ${name}`);
    res.status(429).json({ error: 'This service is busy right now. Please try again later.' });
    return { ok: false };
  }

  // 3. per-IP
  const ip = ipOf(req);
  const one = await bump(`site:${name}:ip:${ip}`, perIp, windowMin);
  if (!one.ok) {
    res.setHeader('retry-after', String(windowMin * 60));
    res.status(429).json({ error: `Too many requests. Try again in ${windowMin} minutes.` });
    return { ok: false };
  }

  return { ok: true, ip };
}

/** Best-effort cleanup so the table doesn't grow forever. Cheap, ~1% of calls.
 *  Only deletes this site's own rate-limit rows (bucket like 'site:%'). */
export async function sweep() {
  if (Math.random() > 0.01) return;
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  await sb(`api_hits?at=lt.${cutoff}&bucket=like.site:*`, { method: 'DELETE' }).catch(() => {});
}
