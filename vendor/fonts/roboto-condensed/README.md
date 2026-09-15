# Vendored Roboto Condensed

The replacement font used when `js/editorObjects.js`'s `detectCondensedSource`
decides a scan's recognized text reads as condensed (W13) - see that
function's header comment for the measured evidence behind the feature, and
`test/research/condensed-source-detection.md` for the full investigation this
was built on.

## Why this is vendored rather than loaded from a CDN

Same reasoning as `vendor/tesseract/` (see that README): no third-party host
appears anywhere in the CSP, so `script-src`/`style-src`/(by inheritance from
`default-src`) `font-src` stay `'self'`, and the replacement path doesn't
depend on a CDN being reachable mid-scan.

## Provenance

- **Source:** [google/fonts](https://github.com/google/fonts), commit at fetch
  time `main` branch, `ofl/robotocondensed/RobotoCondensed[wght].ttf` - the
  upstream variable font, weight axis only (this family has no width axis;
  "Condensed" is the family itself, not a variable instance of Roboto).
- **License:** SIL Open Font License 1.1. Full text in `OFL.txt` next to this
  file, fetched from the same commit (`ofl/robotocondensed/OFL.txt`).
  Copyright 2011 The Roboto Project Authors.

## What's here, and how it was derived

| File | What it is |
|---|---|
| `RobotoCondensed-Regular.ttf` | A single static Regular (weight 400) instance, subset to Basic Latin + Latin-1 Supplement + common punctuation (curly quotes, em/en dash, ellipsis) - the character set OCR replacement text actually needs (see `test/non-latin-limitation.js`: non-Latin script is a documented, deliberate limitation of this app already, not something this font needs to cover). |
| `OFL.txt` | The license, verbatim, as required by the OFL itself. |

Derived from the upstream variable font with `fonttools`, once, at vendoring
time - not a build step the app runs, the same way `vendor/tesseract`'s
assets are whatever upstream shipped, prepared once and committed as-is:

```
fonttools varLib.instancer RobotoCondensed[wght].ttf wght=400 \
  -o RobotoCondensed-Regular-static.ttf                          # 371KB -> 144KB

pyftsubset RobotoCondensed-Regular-static.ttf \
  --output-file=RobotoCondensed-Regular.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2018-201F,U+2013-2014,U+2026" \
  --layout-features='*'                                          # 144KB -> 47KB
```

WOFF2 (usually the better choice for web delivery) was not produced - the
`brotli` module `pyftsubset` needs for it isn't available without changing
this machine's managed Python environment, which is out of scope for
vendoring one font. A 47KB static TTF, gzipped by GitHub Pages same as every
other asset here (see `WEB-COMPLETION-PLAN.md` §0), is small next to
`vendor/tesseract`'s 11MB and was judged not worth chasing further.

## Where it's used

- `style.css`'s `@font-face` declaration and `.image-format-view.condensed-source` rule.
- `js/editorObjects.js`: `detectCondensedSource` decides when to apply the
  class; `wordFontFamily()` (the same function `inkFitPxAtScale` already used
  for sizing) is what actually resolves to it once applied - preview and the
  export canvas both read that one function, so there's one decision, not two
  that could drift.
