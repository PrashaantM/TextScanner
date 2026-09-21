# Palette contrast — a readable report

**The gate is [`test/palette-contrast.js`](../../palette-contrast.js), not this
directory.** It runs in CI (per-push step 3), parses `:root` out of `style.css`,
and fails the build if any text-over-surface pair drops below its WCAG floor.

`measure.mjs` here is the same numbers laid out to look at, for when you are
comparing a candidate token against what ships or writing up why a value is what
it is. It asserts nothing.

```
node test/research/palette/measure.mjs     # the report
node test/palette-contrast.js              # the gate
```

## What changed, and why it matters more than the numbers

This started as a research harness that **hard-coded its own 16-token copy of
the palette**, with a header saying so and a "keeping it true" section
explaining how to cross-check it by hand. Every value in that copy was correct.
That is exactly the property that makes it dangerous: it was an honest local
copy of a value that lives somewhere else, which is the same shape as the 30
test servers that each carried their own MIME map (CHECK 6 in
`test/repo-contract.js`). As research it was an honest report that could go
wrong. As a gate it would have been a false green waiting for `style.css` to
move.

So the tokens and the WCAG arithmetic both moved into the gate, and this file
imports them. **The dependency points research → gate and never the other way**:
a gate that imported a research harness could be disabled by editing something
nothing runs.

Parsing rather than listing paid off immediately. The hand-written version
checked three `color-mix()` tinted surfaces; reading the stylesheet found
**five** — `style.css:1556` and `:1561`, the editor's hover and modified-word
backgrounds, are text sitting directly on the user's photograph and had been
missed. 27 pairs measured by hand became 45 asserted.

## The finding this exists because of

Removing the theme system left one scheme and no light mode to fall back to when
a surface sits over something bright — and several surfaces here are glass, a
translucent fill plus `backdrop-filter`, whose backdrop is the user's own
photograph. Over a white page scan, the palette before `49d1176` measured:

| Pair | Before | After |
|---|---|---|
| `--text` on `--surface-glass` | **4.26:1** — below the 4.5 body floor | 10.22:1 |
| `--text-muted` on the same | **1.49:1** — not "low contrast", gone | 5.17:1 |
| `--accent` on the same | 3.05:1 — clearing 3.0 by 0.05 | 7.32:1 |

`node test/palette-contrast.js` reproduces both of those reds if you revert
`--text-muted` and `--surface-glass` in `style.css`.

**The backdrop model:** `backdrop-filter`'s blur redistributes the backdrop's
pixels but preserves their mean, so the mean is what the text has to survive.
Pure white and near-black bracket it.

## The limit that remains

**Nothing here is observed.** Every ratio is computed from the token values.
Real `backdrop-filter` compositing in Safari and in WKWebView on a device is
unverified — see `ANALYSIS.md` §3.10 and §6. A real photograph also has local
structure a mean does not capture; pure white is the worst-case bound, so the
numbers hold, but no real image has been sampled.
