# Lighter gradients — events.html

**Only `events.html` changed.** The images are already uploaded and untouched.

## What moved

Tints dropped from roughly **75% to 22–34%** — about a third of what they were.
The photos now read as photos.

## How the text stays legible at that opacity

The darkening moved off the whole picture and onto the heading:

- **`.ev-media::after`** — a soft radial pool of shade centred behind the title,
  fading to nothing at the edges. Invisible as a shape, but it keeps white type
  readable on all three.
- **`text-shadow`** on the heading and subtitle for the last bit of contrast.

That's what makes the low tint possible. Darkening the whole image to protect
text in the middle is what buried the photos in the first place.

Wind Surge desaturation eased from `.55` to `.7` — still visibly "past", but you
can see the sunset now.

## If you want them lighter still

Each tile's tint is the first `linear-gradient` in its `background` stack:

```css
.ev-media-thunder{background:
  linear-gradient(160deg,rgba(0,93,166,.24),rgba(4,38,63,.34)),   /* ← this */
  image-set(...),
  linear-gradient(160deg,#005DA6,#04263f)}                        /* fallback */
```

Drop those two decimals toward `.10` for more photo. **Don't remove the line
entirely** — the last gradient in each stack is the original flat colour and
only shows if an image fails to load, so it isn't a substitute.

Below about `.15` the Military tile gets difficult: the flag's white stripes sit
right where "Military Suite Night" does. If you push it that far, deepen the
`::after` pool from `.58` to about `.7` instead.
