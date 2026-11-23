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
// State lives in the CRM's Supabase (its api_hits table) because Vercel
// functions are stateless and cold starts — exactly when you're hit hardest —
// would reset an in-memory counter. The site holds ONLY the public anon key
// (see _env.js) and makes ONE kind of call with it: public.site_hit(), which
// counts a "site:" bucket and answers true (over), false (under, recorded) or
// null (its table is full, read here as "down"). Bucket names are KEYED
// (_bucket.js): the database sees "site:" + 40 hex, never a readable name, so
// a stranger holding the anon key cannot name one of our counters to fill it.
// The count and the record happen in one database call under a per-bucket
// lock, so a burst cannot slip past the way read-then-write over REST did.
// The function also deletes old rows, so there is nothing to sweep from here.
//
// WHEN THE LIMITER IS MISSING OR DOWN, the route decides:
//   forms (default)    let the request through. Losing a real lead is worse
//                      than one junk row, and the size check still runs.
//   failClosed: true   refuse with 503. The AI routes pass this: with no
//                      counter, nothing bounds the Anthropic bill.
// A missing variable is named in the log; it is never silently "fine".

import { limiterEnv, limiterMissing } from './_env.js';
import { keyedBucket } from './_bucket.js';

/** Caller's IP. Vercel sets x-forwarded-for; take the FIRST entry — later ones
 *  are proxies and are trivially spoofable by the client. */
export function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

const LIMITER_MS = 3000;

/** One call to public.site_hit() for the counter called `name` (readable;
 *  it is keyed before it leaves). Answers 'ok' (under, recorded), 'limit'
 *  (over, nothing recorded), 'down' (unreachable, full, or an unexpected
 *  answer) or 'off' (not configured). `record: false` asks for the count only. */
export async function siteHit(name, limit, windowSec, { record = true } = {}) {
  const { url, key } = limiterEnv();
  if (!url || !key || limiterMissing().length) return 'off';
  const bucket = keyedBucket(name);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), LIMITER_MS);
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/site_hit`, {
      method: 'POST',
      // the key goes on `apikey` ONLY: a publishable key (sb_publishable_…) on
      // Authorization is parsed as a JWT and refused. A legacy anon JWT works
      // the same way on `apikey`.
      headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify({ p_bucket: bucket, p_window_sec: Math.round(windowSec), p_limit: Math.round(limit), p_record: !!record }),
      signal: ctl.signal,
    });
    if (!r.ok) { console.error(`[guard] the limiter answered ${r.status} for ${name}`); return 'down'; }
    const over = await r.json();
    if (over === null) console.error(`[guard] the limiter's table is full; treating ${name} as down`);
    return over === true ? 'limit' : over === false ? 'ok' : 'down';
  } catch {
    return 'down';
  } finally { clearTimeout(timer); }
}

/**
 * Guard a public endpoint. Call it first thing in the handler:
 *
 *   const gate = await guard(req, res, { name:'chat', perIp:30, perDay:3000, maxChars:30000, failClosed:true });
 *   if (!gate.ok) return;              // guard already sent the response
 *
 * Options:
 *   name        required. Namespaces the counters per endpoint.
 *   perIp       requests per IP per window     (default 20)
 *   windowMin   window length in minutes       (default 10)
 *   perDay      GLOBAL cap across all callers   (default 2000)
 *   maxChars    reject bodies larger than this  (default 12000) — ALWAYS set per route.
 *   failClosed  refuse (503) when the limiter is missing or down (default false).
 *               Every route that spends on a model passes true.
 */
export async function guard(req, res, opts = {}) {
  const {
    name,
    perIp = 20,
    windowMin = 10,
    perDay = 2000,
    maxChars = 12000,
    failClosed = false,
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

  const ip = ipOf(req);
  const unavailable = why => {
    res.status(503).json({ error: 'This service is unavailable right now. Please try again later.' });
    return { ok: false, why };
  };
  const missing = limiterMissing();
  if (missing.length) {
    if (failClosed) {
      console.error(`[guard] ${name}: REFUSING, the rate limiter is not set on this project: ${missing.join(', ')}`);
      return unavailable('not_configured');
    }
    console.error(`[guard] ${name}: running WITHOUT a rate limit, not set on this project: ${missing.join(', ')}`);
    return { ok: true, ip, limiter: 'off' };
  }

  // 2. global daily cap FIRST — the only layer that bounds a botnet's bill
  const day = await siteHit(`site:${name}:global`, perDay, 24 * 3600);
  if (day === 'limit') {
    console.error(`[guard] DAILY CAP HIT on ${name}`);
    res.status(429).json({ error: 'This service is busy right now. Please try again later.' });
    return { ok: false };
  }
  if (day === 'down') {
    if (failClosed) { console.error(`[guard] ${name}: REFUSING, the rate limiter cannot be reached`); return unavailable('limiter_unavailable'); }
    console.error(`[guard] ${name}: the rate limiter cannot be reached; letting this request through`);
    return { ok: true, ip, limiter: 'down' };
  }

  // 3. per-IP
  const one = await siteHit(`site:${name}:ip:${ip}`, perIp, windowMin * 60);
  if (one === 'limit') {
    res.setHeader('retry-after', String(windowMin * 60));
    res.status(429).json({ error: `Too many requests. Try again in ${windowMin} minutes.` });
    return { ok: false };
  }
  if (one === 'down') {
    if (failClosed) { console.error(`[guard] ${name}: REFUSING, the rate limiter cannot be reached`); return unavailable('limiter_unavailable'); }
    console.error(`[guard] ${name}: the rate limiter cannot be reached; letting this request through`);
    return { ok: true, ip, limiter: 'down' };
  }

  return { ok: true, ip, limiter: 'on' };
}

/** Kept so the routes that call it need no change. Cleanup now happens inside
 *  site_hit() in the database; the anon key cannot delete rows, by design. */
export function sweep() {}
