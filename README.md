# Event tile backgrounds — getproytech.com/events

## Upload

| From the zip | Goes to |
|---|---|
| `events.html` | repo root (replaces the existing one) |
| `images/suite-night-*.webp` and `*.jpg` | `images/` |

Static site, no build step — Vercel redeploys on commit.

## What changed

**Three CSS lines in `events.html`.** No markup changes at all — the existing
`.ev-media-thunder`, `.ev-media-military` and `.ev-media-past` blocks already
existed as flat gradients, so the photos slot straight in behind them.

## The one decision worth knowing

The photo sits **under** the existing gradient, not instead of it.

Your headings are centred over that block, and both the Wind Surge sunset and
the Thunder ice are brightest in exactly the middle where the text sits.
Dropping the gradient for a raw photo would make white type disappear into the
image. The gradients are the same colours as before, just eased back enough
(≈70–85% opacity) to read the photo through them.

Each background is a stack:

```
tint gradient  →  photo  →  original solid gradient
```

The last layer is the original colour, so a slow connection shows what the page
shows today rather than an empty block. Nothing regresses if an image 404s.

**The past tile is desaturated** (`filter:saturate(.55)`) so Wind Surge reads as
over without the copy having to say so twice — "Sold out · done" already does
that work once.

## Sizes

Your source PNGs were ~2 MB each — **6.5 MB for three tiles**, slow on a phone.
These are 1200×800, 66–92 KB in WebP with JPEG fallbacks served via `image-set`,
so browsers that can't do WebP get the JPEG with no markup change.

Total added: **~610 KB**, and only ~250 KB of that is what a modern browser
actually downloads.

## Worth checking after deploy

- The Military tile has bright white flag stripes across the top. The heading
  sits centred so it should be clear, but if it ever reads thin, deepen the
  first gradient stop from `.68` to about `.78`.
- Tiles are 190px tall on desktop, 170px under 640px. The photos are 3:2, so
  they crop top and bottom at that height — all three are composed with the
  interesting part in the middle, so this is fine, but it's why they're not
  taller.
