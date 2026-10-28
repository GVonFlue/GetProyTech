// api/_env.js — one place that knows how to find Supabase from the server.
//
// The marketing site's guard (_guard.js) uses the SAME api_hits table the CRM
// already runs its rate limiter on, so an abusive loop is capped across cold
// starts and across every serverless instance, not just one.
//
// THESE ARE SERVER-ONLY. The service-role key bypasses RLS and must NEVER be
// given a VITE_ prefix (a VITE_ variable is compiled into the browser bundle).
// Accepting VITE_SUPABASE_URL for the URL only is safe: the URL is public.
//
// If these are not set, the guard FAILS OPEN (the site keeps working, rate
// limiting is simply inactive) — so shipping this changes nothing until the
// two variables below are added to the getproytech Vercel project.
//
//   SUPABASE_URL                 (or VITE_SUPABASE_URL — same value, public)
//   SUPABASE_SERVICE_KEY         (or SUPABASE_SERVICE_ROLE_KEY)

export const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';

export const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || '';

export const guardConfigured = () => !!(SUPA_URL && SUPA_KEY);
