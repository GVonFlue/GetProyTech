# Local SEO — events.html

**Only `events.html` changed.** No new files.

## Straight answer: there was almost none

The page had a title, a description and three Open Graph tags. Everything that
actually surfaces an event in search was missing.

## The big one — Event schema

There was **no structured data at all**, so Google saw three styled cards and
had no way to know they were events, when they were, or where.

Added `BusinessEvent` JSON-LD for all three, plus an `Organization` node they
all reference. That's what makes a page eligible for Google's **event rich
results** — the listings with date, venue and a link that appear above ordinary
results for searches like "networking events wichita."

Details that matter and are easy to get wrong:

- `eventAttendanceMode` and `eventStatus` are **required** for eligibility, not
  optional extras.
- Dates carry the Central offset (`-05:00`). A bare `2026-10-17` is read as UTC
  and can display as the wrong day.
- Real street addresses for both venues — this is the local signal.
- Wind Surge is marked `SoldOut`, which is correct and better than removing it.
  A past event with honest status still carries authority for the series.

**Verify after deploy:** paste the URL into Google's Rich Results Test. It'll
show three valid events or tell you exactly what's wrong.

## Sharing

There was **no `og:image`**, so every link you post unfurled as a grey box —
including in Messenger and on Facebook, which is where most of your Suite Night
traffic comes from. Added the image, dimensions, alt text, and a Twitter card.

## Also added

- `<link rel="canonical">` — was missing entirely
- A real title: *"Business Networking Events in Wichita | Suite Night by
  ProyTech"* instead of *"Events | ProyTech"*, which was competing for nothing
- A description that names both venues and the military night
- `geo.region` / `geo.placename`
- `max-image-preview:large` so the photos can appear in results

## On-page copy

Google needs words, not just cards. "Wichita" appeared **once** on the whole
page. There's now a short section under the grid naming both venues, the
surrounding towns (Derby, Andover, Maize, Goddard) and the trades you actually
want in the room. Counts now: Wichita 8, networking 7, Equity Bank Park 3,
INTRUST 2 — present without reading like keyword stuffing.

## The one thing I did not fix

**All three events share one URL.** Nothing can rank for "military networking
night wichita" specifically because there's no page for it to rank.

The Thunder night points at `suitenight.html`; the military night points at a
`gvonflue.vercel.app` subdomain, which sends its authority to a different
domain entirely. Giving each event its own page on getproytech.com — with its
own schema, title and description — is worth more than everything above
combined. Worth doing before October.
