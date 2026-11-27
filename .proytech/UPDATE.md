# Update: security headers (redo of 343072a4, full-origin CSP)

## What changed
- `vercel.json` — added to the existing `/(.*)` headers block (the repo's only place for headers): Strict-Transport-Security, X-Frame-Options DENY, Permissions-Policy (recipe default), Content-Security-Policy. The existing X-Content-Type-Options and Referrer-Policy, and the `/report` no-referrer and X-Robots-Tag rules, are untouched.

## Pre-existing failures (baseline, before any change)
- `tests/report-page.test.mjs` #90 "td-ping: once per load, slug or token only, to the CRM; on every hand-built report and on no preview homepage": `assert.ok(reports.length >= 25)` is false. It is not caused by this change, and I did not touch it.

## What I ran
| Command | Before | After |
|---|---|---|
| `node --test tests/*.test.mjs` (repo has no package.json) | 115 tests, 114 pass, 1 fail (#90 above) | 115 tests, 114 pass, 1 fail (same #90) |
| `npm run build` / `npm test` / lint | not available: static site, no package.json | n/a |
| `curl -sI` on `/` and an API route | **not run.** There is no build or local server, because it is a static site on Vercel. The headers only take effect on a Vercel preview. | |

`node -e` JSON-parse of the config: valid, six security header keys present on `/(.*)`.

## Origin inventory (origin → directive → where)
| Origin | Directive(s) | Found in |
|---|---|---|
| widgets.leadconnectorhq.com | script-src (+ `*.leadconnectorhq.com` for style, font, img, connect and frame; see Look at this) | the GHL chat loader `<script>` on about 30 pages (index, work, sponsor, book, and others) |
| fonts.googleapis.com | style-src | `<link>` on about 190 pages |
| fonts.gstatic.com | font-src | same pages |
| maps.google.com | frame-src | iframes in previews/{jmplumbing,amypreister,3delectricplumbing,tellezlandscaping,goddardoutdoorpower,dmmechanical}.html |
| api.web3forms.com | connect-src | fetch in winanagent, suitenight, suitenight_1, suitenight-oct17 |
| proytech-crm.vercel.app | connect-src | js/td-ping.js, js/report.js, coffee.html |
| script.google.com | connect-src, form-action, frame-src | fetch in win, thunder, onboarding/mortgage-punk, winanagent, suitenight*; sponsor.html hidden-iframe form POST |
| script.googleusercontent.com | connect-src, form-action, frame-src | not in the code. Apps Script `/exec` redirects there at runtime. Standard behaviour, not a guess at an unrelated service. |
| erikachoriego.exprealty.com | form-action | previews/erikachoriego.html (2 GET forms) |
| bearcreek-ks.com | img-src | sponsors/bear-creek-construction.html |
| grandframemedia.com | img-src | resources.html |
| imagescdn.homes.com | img-src | sponsors/dwell-real-estate-group.html |
| img.chime.me | img-src | sponsors/dwell-real-estate-group.html |
| landing-page-app-hero-images.s3.amazonaws.com | img-src (this bucket only) | sponsors/liberty-lawn-landscape.html |
| pvobppbsoqelfdqwovgd.supabase.co | img-src (storage images) | previews/erikachoriego.html |
| 'self' | everything else | `/_vercel/insights/script.js` (Vercel analytics, same origin), `/js/*`, images |

Named in review but not loaded by any page in this repo, so **not added**:
- **Calendly.** Only text mentions. `/book` is a local page, with no embed or script.
- **Google Tag Manager.** The only reference is a mock string in `api/_audit-mock.js`, test data for the audit tool.
- **Supabase `connect-src`, and `wss://`.** No `createClient` or API calls exist, only public storage images.
- **Anthropic.** Called server-side only (`api/*.js`).
- **Vercel `va.vercel-scripts.com`.** Only a debug path in the vendored analytics.
- **`client-docs/` and `work/`.** Contain only a PDF and images, with no external loads. The `work.html` page loads only the GHL widget.

Other hosts (instagram, facebook, drive.google.com, app.tern.travel, meet.google.com, buzzsprout and similar) are plain `<a href>` links. Links are not governed by the CSP.

## Why `'unsafe-inline'` in script-src
Pages carry inline `<script>` blocks (for example the CONFIG, fetch and form handlers on win, thunder, suitenight and index). There are no nonces on a static site, so removing it would break them. Style-src needs it for the inline `<style>` blocks and `style=` attributes. No `'unsafe-eval'`. No bare `*` anywhere.

## Migrations
none

## Look at this
- **GHL chat widget.** The repo only names `widgets.leadconnectorhq.com`. I allowed `https://*.leadconnectorhq.com` (one vendor's subdomains, not a bare `*`) because the widget calls its own backend and API hosts at runtime. These are not visible in the repo, so I did not guess them one by one. Check the chat widget in the preview console. If it needs `wss://…`, `storage.googleapis.com`, `msgsndr.com` or similar, add them by name.
- Open previews (especially erikachoriego and the map previews), `/work`, `/sponsors/*`, `/win`, `/thunder`, `/suitenight`, `/coffee` and `/report` with the console open. Check for CSP violations.
- HSTS `includeSubDomains; preload` affects all subdomains of getproytech.com. Confirm they are all HTTPS.
- `X-Frame-Options: DENY` and `frame-ancestors 'none'`: nothing in the repo embeds the site, so no change was needed.
- `/report` and `/report.html` set their own `Referrer-Policy: no-referrer`. I left it as it was, so check that it still wins over the global value on the preview.
- Permissions-Policy: no page uses geolocation, camera, mic or payment.

## Seen, not touched
- The baseline failure above (`reports.length >= 25`, likely fewer report files than the test expects).
- Sponsor and onboarding pages contain Apps Script endpoint URLs in client code (public by design, but noted).
- `getproytech website V1/` and `OPTIONAL-classic-hero/` hold old copies. Not inventoried or covered.
