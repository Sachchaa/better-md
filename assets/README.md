# Brand assets

`logo-source.png` is the supplied artwork: the wordmark on a solid black field,
2000×2000. Everything shipped is derived from it, so replacing this file and
re-deriving is the way to change the mark.

## What was derived, and how

| Shipped | From | Notes |
| --- | --- | --- |
| `public/site/logo.png` | source, trimmed to ink bounds | 292×128, transparent |
| `public/site/logo-light.png` | `logo.png` | wordmark recoloured to `#202223`; badge untouched |
| `public/favicon.png` | the badge alone | 64×64 |
| `public/apple-touch-icon.png` | the badge alone | 180×180 |
| `public/site/og-image.png` | `logo.png` on `#0B0D0E` | 1200×630, opaque |

The background could not simply be keyed out to black. The badge carries **black
letters on green**, so a black-to-transparent pass would have punched holes through
`md`; and the badge is a **rounded** rectangle, so treating its bounding box as
opaque left black in the corners. Background is decided by reachability from
outside the mark instead: black that connects to the outside is background, black
enclosed by the badge is ink. That also keeps the counters of `b`, `e` and `t`
transparent, which a position-based rule would have filled.

Alpha comes from each pixel's distance from the background colour, so antialiased
edges fade out instead of stepping.

## The light variant is derived, not supplied

`#a8e063` on a white README is 1.55:1 against white — washed out. The supplied
inverse artwork is the **uppercase** `MD` form, and the lowercase form is the one
chosen, so the light variant recolours the wordmark to the site's ink rather than
switching to a different lettering. The badge is byte-identical to the dark
variant. Replace it with a proper lowercase inverse export when one exists.

## The brand green is not the editor's accent

`--brand` (`#a8e063`) is the identity, fixed in both themes. `--accent`
(`#3b6df2` light, `#5b87ff` dark) still drives buttons and selection in the
editor. They are separate because white text on the brand green is 1.55:1: making
it the UI accent means restyling every primary control to dark text, which is a
palette decision rather than a logo one.
