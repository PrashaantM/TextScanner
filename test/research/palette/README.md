# Palette contrast — the single scheme, measured

**Not a gate.** This is a measurement, and this repo's rule is that a
measurement which gates nothing lives under `test/research/` rather than in
`test/`, where `test/repo-contract.js`'s CHECK 2 would require a `run:` line for
it in `.github/workflows/ci.yml`.

```
node test/research/palette/measure.mjs
```

## Why it exists

The theme system was removed in favour of one fixed colour scheme. With two
palettes there was always a fallback; with one there is none — and several of
this app's surfaces are **glass**, a translucent fill plus `backdrop-filter`,
whose backdrop is *the user's own photograph*. That can be a blown-out white
page scan or a night shot, and nothing in the app controls which.

Nobody had measured that. `contrast.mjs` composites the alpha the way the
browser does and computes WCAG 2.1 ratios; `measure.mjs` runs every
text-over-surface pair in the scheme against both ends of that range.

**The backdrop model.** `backdrop-filter`'s blur redistributes the backdrop's
pixels but preserves their mean, so the mean is what the text has to survive.
Pure white and near-black bracket it.

## What it found

Run against the palette as it stood *before* the single-scheme change, over a
white page scan:

| Pair | Before | After |
|---|---|---|
| `--text` on `--surface-glass` | **4.26:1** — below the 4.5 body floor | 10.22:1 |
| `--text-muted` on the same | **1.49:1** — not "low contrast", gone | 5.17:1 |
| `--accent` on the same | 3.05:1 — clearing 3.0 by 0.05 | 7.32:1 |

Two tokens moved because of those numbers and for no other reason:
`--text-muted` from `#8291a8` to `#9fb0c8`, and the glass fill from
`rgba(16,22,31,0.6)` to `rgba(6,9,13,0.8)`.

## Two honest limits

1. **It is not enforced.** Running a script is not a gate. A future palette edit
   can reintroduce exactly the defect above and CI will stay green. Making it a
   gate means a 35th step in `ci.yml`'s per-push job and a row in
   WEB-COMPLETION-PLAN.md §0's table.
2. **Nothing here is observed.** Every ratio is computed from the token values.
   Real `backdrop-filter` compositing in Safari and in WKWebView on a device is
   unverified — see ANALYSIS.md §3.10 and §6.

## Keeping it true

`measure.mjs`'s `T` table is kept in sync with `style.css`'s `:root` **by hand**.
This file reports, it does not gate, so a drift there is a wrong report rather
than a false green — but it is still a drift. Cross-check with:

```
awk '/^:root \{/,/^\}/' style.css | grep -oE '\-\-[a-z0-9-]+: *#[0-9a-f]{6}'
```
