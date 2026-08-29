# Benchmark corpus

The images `test/run-benchmark.js`, `test/score-manual.js` and
`test/tune-thresholds.js` score against. Every image here needs a matching
transcription at `test/groundtruth/<same-name>.txt`; the harnesses iterate over
the **ground truth** files, so an image with no `.txt` is simply skipped.

## What's here now

`complexPic1` – `complexPic11`, eleven real-world photos and screenshots:
a decorative poster, a phone lock screen, a dense UI mockup, two product-page
screenshots, a retail shelf, a shelf tag, a mobile flyer photo, a POS terminal
screen, repeated TV boxes, and a cluttered store aisle.

**Three of them — `complexPic7`, `complexPic10`, `complexPic11` — have
deliberately partial ground truth.** Illegible fine print was omitted rather
than guessed at. That makes their CER directional only, and it makes them
actively misleading to optimize against: an engine that correctly reads *more*
of the real fine print scores *worse* on them. `tune-thresholds.js` reports
them separately for exactly this reason, and the headline number is the mean
over the other eight.

## What's missing, and why it matters

Eight scoring images is not enough to trust a small change. A tuning result
that moves the mean by a point or two cannot be distinguished from noise or
from overfitting to these particular eight, which is the single biggest
limitation on the recognition work right now.

**These categories are under-represented or absent, and need real photos —
they can't be synthesized honestly:**

| Category | Why it's needed |
|---|---|
| Low light / high ISO noise | The preprocessing path's contrast normalization is built for exactly this and is currently unmeasured on it. |
| Steep skew (30°+) | `perspective.js`'s keystone detection has no image here that triggers it hard. |
| Dense small text (a page of body copy) | Tests the region-reprocessing upscale path at its limit. |
| A receipt | Thermal print, narrow column, faded — a very common real use, entirely absent. |
| A street sign | Outdoor lighting, distance, non-flat mounting. |
| A screenshot of a screenshot | Moiré and resampling artifacts, a known weak spot. |
| Curved surfaces (a bottle, a can) | Known failure mode; keystone correction cannot help here and shouldn't pretend to. |
| Non-Latin script | `mlkitEngine.js` hardcodes `script: "LATIN"`. There is currently no image that would catch that. |

## Adding an image

1. Drop the photo in here. Any name works, but keep it descriptive
   (`receipt-faded-1.jpeg` beats `complexPic12.jpeg`) — the name is what the
   report prints. `.jpeg` is what `run-benchmark.js` looks for.
2. Write `test/groundtruth/<same-name>.txt` containing the text a careful human
   reads in the image, in natural reading order.
3. Re-run `node test/run-benchmark.js --json test/baseline-<date>.json` to get a
   new baseline that includes it.

### Ground-truth conventions

- Transcribe what a person can actually read. **If print is genuinely
  illegible, leave it out and say so at the top of the `.txt` in a comment
  line** — don't guess, and don't transcribe what you know is there from
  context but cannot see.
- Line breaks are free: `metrics.js` collapses all whitespace before scoring, so
  line-for-line fidelity with the image is not required and won't affect CER.
- Keep punctuation, casing, prices and phone numbers exactly as printed. Those
  are the details the Coherence Filter is explicitly promised to preserve, so
  they need to be right here.
- If you add an image whose ground truth is necessarily partial, add its name to
  `PARTIAL_GROUND_TRUTH` in `test/tune-thresholds.js` so it stays out of the
  headline average.
