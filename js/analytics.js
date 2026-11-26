/* js/analytics.js — Vercel Web Analytics for getproytech.com. One module, loaded
   on every public page:   <script type="module" src="/js/analytics.js"></script>

   PRODUCTION ONLY. The script loads, and events are sent, only on the real
   domain. Preview deployments (*.vercel.app), localhost and file:// count
   nothing, so testing a branch never shows up as a visit.

   PINNED. The loader is @vercel/analytics 2.0.1, vendored under js/vendor/
   (this site has no build step, so a pin means a file in the repo). Vercel
   serves the tracking script itself at /_vercel/insights/script.js once Web
   Analytics is turned on for the project; until then that request 404s and
   nothing is counted.

   NO PERSONAL DATA. Three events, each sent with a name only and no
   properties: no email, phone, business name, website or src tag. The page
   view is Vercel's own (path and referrer, no cookies). */
import { inject, track } from './vendor/vercel-analytics-2.0.1.js';

export const PROD_HOSTS = ['getproytech.com', 'www.getproytech.com'];

/* The one vocabulary. A page calls window.ptTrack('<one of these names>'); a
   name that is not here is dropped, so a typo cannot start a fourth event.
   tests/analytics.test.mjs checks every name a page uses is in this list. */
export const EVENTS = Object.freeze({
  bookingStarted: 'Booking started',      // book.html: the visitor finished the first step
  bookingCompleted: 'Booking completed',  // book.html: the CRM confirmed the booking
  teardownStarted: 'Teardown started',    // audit.html: a website scan began
});
const NAMES = Object.values(EVENTS);

export const isProd = host => PROD_HOSTS.includes(String(host || '').toLowerCase());

const on = typeof location !== 'undefined' && isProd(location.hostname);
if (on) inject({ mode: 'production' });

if (typeof window !== 'undefined') {
  window.PT_EVENTS = EVENTS;
  window.ptTrack = name => {
    if (!on || !NAMES.includes(name)) return;
    track(name);
  };
}
