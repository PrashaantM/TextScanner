# Condensed-source-text detection: the investigation behind the detector

Two research sessions, neither touching application code, that led to
`js/editorObjects.js`'s `detectCondensedSource` and the condensed replacement
font it selects (`vendor/fonts/roboto-condensed/`). This document is the
durable record of both; `font-features.mjs` in this directory is the script
that produced the numbers, and `font-features-raw.json` is its output from
the run this document quotes - rerunnable (`node test/research/font-features.mjs`,
a few minutes, 11 real OCR scans), not just asserted.

## Why this exists at all

A replacement word renders in the app's own font, not the photo's - there is
no font matcher. On ordinary type that costs almost nothing (complexPic5:
median height fill 0.948-0.999 depending on run). On complexPic1 - a poster
set in a condensed hand-drawn display face - it cost a lot: median height
fill 0.552, freshly measured in the pinned Playwright Docker container on
Liberation Sans, after both the preview-solve and export-canvas-solve fixes
that preceded this work. The app's default font is wider than the source
face, so fitting the source word's WIDTH forces the replacement's size down
well past what its HEIGHT alone would allow.

## Session 1: which features even separate (3 images, no build)

Measured six candidate features from REAL source-photograph pixels (OCR word
crops from complexPic1/2/5, decoded via canvas - never a font rendered by the
investigation script itself) against real corpus images spanning a condensed
display face and two ordinary sans faces:

| Feature | Result |
|---|---|
| Stroke width (relative to word height) | **No separation.** complexPic1 median 0.116, complexPic5 median 0.115 - nearly identical. Confirms the ink-coverage-as-weight-proxy already falsified against `test/render-fidelity.js` extends to stroke width directly, not just ink fraction. |
| Stroke contrast (thick:thin) | **Degenerates to ~1.0** at these pixel resolutions. Most photographed body text has a 2-3px thinnest stroke; a 2:1 or 5:1 contrast ratio needs sub-pixel precision to survive anti-aliasing and JPEG compression at that scale. Even complexPic1's poster-sized headline text (5-8px strokes) came back at ~1.1 - and no image in this 3-image (or later 11-image) corpus contains a genuine high-contrast serif face to validate the proxy against its actual purpose. **This is why Playfair vs. Source Serif is not resolvable this way**, independent of implementation quality. |
| Glyph aspect ratio (component width/height) | **Marginal, real.** complexPic1 median 0.633 vs. complexPic2/complexPic5 at 0.786/0.789 - a genuine ~20% gap in the right direction, though per-word IQRs overlap too much for a per-word classifier. The one feature worth pursuing further. |
| Inter-character width CV (mono vs. proportional) | No separation - and the 3-image (later 11-image) corpus contains no monospaced face to test against in the first place. |
| x-height/cap-height ratio | No separation - confounded by all-caps headline words, which have no real x-height band for the heuristic to find. |
| Terminal shape (flare proxy) | Some signal (complexPic1 tapers, ratio <1; ordinary sans stays flat, ~1.0), but for the wrong reason - consistent with hand-drawn stroke taper, not serifs - on a small sample (n=9), with no serif exemplar in the corpus to validate against. |

**Conclusion: only glyph aspect ratio was worth building anything on.**

## Session 2: does the signal hold on the full 11-image benchmark corpus?

The concern, stated up front: a threshold picked from one positive example
(complexPic1) and two negative examples (complexPic2, complexPic5) is exactly
the shape of bug this project has shipped to CI red before on. Widened to all
11 `complexPic*.jpeg` images before picking a threshold:

```
--- glyphAspectMedian --- (per-image median glyph aspect ratio, n = words measured)
  complexPic1.jpeg   n=21   median=0.633   <- the condensed poster
  complexPic2.jpeg   n=67   median=0.786
  complexPic5.jpeg   n=114  median=0.789
  complexPic9.jpeg   n=52   median=0.875
  complexPic4.jpeg   n=207  median=0.933
  complexPic8.jpeg   n=106  median=0.952
  complexPic3.jpeg   n=418  median=1.000
  complexPic6.jpeg   n=123  median=1.000
  complexPic7.jpeg   n=45   median=1.000
  complexPic11.jpeg  n=88   median=1.250
  complexPic10.jpeg  n=64   median=4.000   <- outlier: short numeric/price fragments, not prose
```

**Per-word, this does not cleanly separate** - individual words' aspect
ratios in complexPic2, complexPic5, complexPic6, complexPic7 and complexPic9
dip into complexPic1's own per-word range often enough that a per-word
classifier would misfire regularly. That is a real, negative finding, stated
plainly: this is not a reliable per-word signal, and nothing here should be
read as claiming otherwise.

**Per-image (the unit `detectCondensedSource` actually decides on), it does
separate.** complexPic1 is the unambiguous minimum across all 11, with a
0.153 gap (24% relative) to the next-lowest image and nothing else anywhere
near that range. complexPic10's outlier sits in the opposite direction
(short fragments inflating the ratio, not a condensed face) and doesn't
threaten the low end at all.

**The threshold: 0.70.** Roughly the midpoint of the 0.633-0.786 gap between
complexPic1 and its nearest neighbor - comfortable margin on both sides
(0.067 below complexPic1's own median, 0.086 above the next image's).

**What this evidence does and does not support.** Ten confirmed true
negatives (complexPic2 through complexPic11, all firmly on the "not
condensed" side) is real support for "this does not misfire on the images
already in the corpus." It is NOT evidence the threshold generalizes to a
condensed face this corpus doesn't happen to contain - there is still only
one positive example, widening the corpus did not create a second one. That
residual risk is exactly why the shipped gate
(`test/replacement-size.js`) checks `condensed-source` class presence/absence
per image and a height-fill regression floor for complexPic1, not just that
P1/P2 continue to hold: the claim actually being defended in CI is "this
branch does not make any non-condensed image worse," which the ten true
negatives support, not "this generalizes," which nothing here can.

## The result once built

Same Docker container, same Liberation Sans, `test/replacement-size.js`
"as-scanned" median height fill:

| Image | Before the detector | After it | Delta |
|---|---|---|---|
| complexPic1 (condensed - detector fires) | 0.552 | 0.705 | **+0.153 (+28%)** |
| complexPic2 (ordinary - detector does not fire) | 0.948 | 0.948 | unchanged |
| complexPic5 (ordinary - detector does not fire) | 0.948 | 0.948 | unchanged |

complexPic2 and complexPic5's numbers are bit-identical before and after,
because the classifier never applies the condensed font to them at all -
confirmed directly via `condensed-source` class presence, not inferred from
the fill numbers holding steady.
