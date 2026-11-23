// api/_env.js — one place that knows how to find the rate limiter's database.
//
// The marketing site's guard (_guard.js) counts requests in the CRM's Supabase
// (its api_hits table), so an abusive loop is capped across cold starts and
// across every serverless instance, not just one.
//
// THE SITE HOLDS ONLY THE PUBLIC ANON KEY, NEVER THE SERVICE KEY. It can call
// exactly one thing with it: public.site_hit(), which the CRM's
// SITE-HIT-MIGRATION.sql creates. That function counts "site:" buckets and
// nothing else; anon cannot read, change or delete a row of api_hits, or
// reach any other table. The anon key is public by design (the CRM's own
// browser bundle carries it), so it being on this project exposes nothing new.
//
// The service key is deliberately NOT read, under any name. If one is set on
// this project it is ignored, and it should be removed.
//
// Read on every call, not at import, so a missing value is named in the log
// and the tests can set them.
//
//   SUPABASE_URL        (or VITE_SUPABASE_URL — same value, public)
//   SUPABASE_ANON_KEY   the CRM project's anon or publishable key (public)

export function limiterEnv() {
  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    key: process.env.SUPABASE_ANON_KEY || '',
  };
}

/** The limiter variables that are not set, in a fixed order. */
export function limiterMissing() {
  const { url, key } = limiterEnv(), m = [];
  if (!url) m.push('SUPABASE_URL');
  if (!key) m.push('SUPABASE_ANON_KEY');
  return m;
}

export const guardConfigured = () => limiterMissing().length === 0;
