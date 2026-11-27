# UPDATE — security-headers (GetProyTech site)

## What changed
- `vercel.json`: in the existing `/(.*)` headers block (the one place headers are set; no middleware or next.config) added Strict-Transport-Security (`max-age=63072000; includeSubDomains; preload`), X-Frame-Options `DENY`, Permissions-Policy (`camera=(), microphone=(), geolocation=(), payment=()`) and a Content-Security-Policy. Existing nosniff and Referrer-Policy kept. The `/report` no-referrer override is unchanged.

CSP origins (from a grep of the root pages, js/, chat.js, ace.js; no bare `*`):
- scripts/styles/fonts/frames/connect: `*.leadconnectorhq.com` (GHL chat/form widget), fonts.googleapis.com, fonts.gstatic.com
- connect: api.web3forms.com, the CRM backend (proytech-crm host), script.google.com, script.googleusercontent.com, storage.googleapis.com
- form-action: self + script.google.com / script.googleusercontent.com (sponsor.html posts a hidden form to Apps Script)
- img: self, data:, blob:, grandframemedia.com, *.leadconnectorhq.com, storage.googleapis.com
- `script-src` has `'unsafe-inline'`: 26 pages use inline `<script>` blocks and 58 inline `onclick=` handlers; removing it would break them. No `'unsafe-eval'`.
- The first-party analytics script is served from the site's own origin, so `'self'` covers it.

## What I ran
- JSON validity check of the config file: pass.
- `node --test tests/*.test.mjs`: 114 pass, 1 fail (`report-page.test.mjs`, "td-ping ... reports.length >= 25"). It counts hand-built report files and doesn't read headers. I only changed the config file, so it looks already failing, but I did not run the tests before my change to confirm. I did not touch it.
- There is no package.json, so there is no `npm run build`, `npm ci` or lint. This is a static site. I did not start a local server, so the headers were not curl-checked. They only apply on the hosted preview.

## Migrations
none

## Look at this
- On the preview, check all six headers on `/` and on an API route such as `/api/chat`. The `/(.*)` source covers API routes.
- Check the console for CSP errors on: home, book (CRM calendar), sponsor (Apps Script form), suitenight and winanagent (web3forms), coffee, story, and any page with the GHL chat widget. GHL may load extra origins (e.g. msgsndr.com, googletagmanager). If one is blocked, add its exact origin.
- Pages in `previews/`, `work/`, `getproytech website V1/` and `client-docs/` load other origins (Google Maps iframes, chime.me, Supabase images, Calendly, GTM, S3). They are demo and client-preview pages and I did NOT add those origins to the CSP, so they may show blocked images, maps or iframes. Decide whether they need a looser per-path policy.
- DENY on framing: if any page is embedded elsewhere on purpose, switch to SAMEORIGIN.

## Seen, not touched
- The `tests/report-page.test.mjs` failure above.
