# Mobile spacing — events.html

**Only `events.html` changed.** Images untouched.

## What was wrong

`.wrap` had `padding:0 20px` at **every** screen width — nothing ever increased
it for phones. The grid collapsed to one column at 920px and that was the whole
mobile treatment. So on a 390px screen the cards sat almost against the glass.

The subhead was worse: `max-width:560px` does nothing on a screen narrower than
560px, so it was only ever held in by that 20px wrapper. That's why "Real rooms,"
ran off the right edge in your screenshot.

## What changed

A proper `max-width:640px` block:

| | Was | Now |
|---|---|---|
| Side padding | 20px | 22px |
| Subhead | 17px, unconstrained | 15.5px, `max-width:100%`, tighter line-height |
| H1 | `clamp(2.4rem, 5vw, 3.8rem)` | `clamp(2rem, 9vw, 2.6rem)` |
| Header padding | 70px top | 44px |
| Grid gap | 24px | 18px |
| Card body | 22px | 18px |
| Media padding | 26px | 20px 18px |
| Card heading | 1.7rem | 1.45rem |
| Badge | 14px inset | 12px, slightly smaller |

The grid `gap` matters more than it looks — once the layout is a single column
it's the *vertical* space between cards, not just horizontal.

## Why the H1 changed

`5vw` on a 390px phone computes to ~19.5px, so the clamp was always pinned at
its 2.4rem floor. Switching to `9vw` lets it actually scale between 2rem and
2.6rem instead of being a fixed size wearing a clamp.

## Worth checking

Desktop should be pixel-identical — every change is inside the 640px block, and
the existing 920px rule that collapses the grid is untouched.
