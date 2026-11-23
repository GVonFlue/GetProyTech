// api/_bucket.js — the name a rate-limit counter goes by in the database.
// Underscore prefix: not a route.
//
// The limiter is the CRM's public.site_hit(), callable with the PUBLIC anon
// key, and anyone can hold that key. If counters went by readable names
// ("site:onboard:global", a hash of an email address), anyone could call
// site_hit with the same name: fill a form's daily cap and switch the form off
// for a day, or ask whether an address was sent an audit report.
//
// So the database only ever sees "site:" + the first 40 hex characters of
// HMAC-SHA256(readable name), keyed with SITE_LIMIT_SALT. That salt is
// server-only: it lives in this Vercel project and nowhere else, not in the
// CRM, not in a browser. Without it a real counter cannot be named. Readable
// names stay in our own logs only.
//
// Missing, or shorter than SALT_MIN characters, counts as "the limiter is not
// configured": limiterMissing() names SITE_LIMIT_SALT and each route's own
// fail rule applies. Changing the salt starts every counter at zero.
import { createHmac } from 'node:crypto';

export const SALT_MIN = 32;
export const saltOf = () => process.env.SITE_LIMIT_SALT || '';
export const saltOk = s => typeof s === 'string' && s.length >= SALT_MIN;

/** "site:" + 40 hex. Throws without a usable salt: callers check first, and a
 *  readable name must never be sent because the salt was forgotten. */
export function keyedBucket(readable, salt = saltOf()) {
  if (!saltOk(salt)) throw new Error('SITE_LIMIT_SALT is not set');
  return 'site:' + createHmac('sha256', salt).update(String(readable)).digest('hex').slice(0, 40);
}
