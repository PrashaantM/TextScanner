# Pipeline tuning: what was measured, and what came of it

Run `node test/tune-thresholds.js` to reproduce. This records the sweeps done for
Phase 3 of the completion plan, because a null result is only useful if it's
written down — otherwise the next person re-runs the same experiments.

## Headline

**Nothing was changed.** Every threshold in `js/ocrEngine.js` and every
preprocessing candidate in `js/preprocess.js` is exactly where it was. Two full
sweeps of the benchmark corpus found no variant whose improvement was
distinguishable from noise, and several that were clearly worse.

That is a real finding, not a failure to try. The levers were swept; they don't
move this corpus.

## How the numbers are read

The headline metric is **mean CER over the eight images with complete ground
truth**. `complexPic7`, `complexPic10` and `complexPic11` have deliberately
partial transcriptions (illegible fine print omitted rather than guessed), so an
engine that reads *more* real text scores *worse* on them. Optimizing the
eleven-image average would actively select for reading less. They are tracked
separately.

Baseline (see `test/baseline-2026-08-28.json`):

| Set | CER | WER |
|---|---|---|
| 8 complete-ground-truth images | 45.1% | 57.1% |
| 3 partial-ground-truth images | 130.0% | — |
| all 11 (the number in the baseline file) | 68.3% | 112.0% |

## The noise floor

Worth knowing before reading any delta: **the same code, run twice, produced
57.1% and 56.9% WER.** Recognition is not fully deterministic run to run. So a
delta under roughly ±0.3 points means nothing, and the whole table below has to
be read against that.

## Results

Both sweeps, on the eight complete-ground-truth images:

| Variant | ΔCER | ΔWER | Verdict |
|---|---|---|---|
| `RETRY_MEAN_CONFIDENCE_THRESHOLD` 40 → 55 | +0.0 | +0.0 | No effect at all |
| `RETRY_MEAN_CONFIDENCE_THRESHOLD` 40 → 25 | +0.0 | +0.0 | No effect at all |
| `PREPROCESS_WORTH_TRYING_THRESHOLD` 70 → 85 | +0.0 | +0.0 | No effect at all |
| `PREPROCESS_WORTH_TRYING_THRESHOLD` 70 → 55 | +0.0 | +0.0 | No effect at all |
| `SKIP_REGION_PASS_OVERALL_THRESHOLD` 85 → 95 | **+4.2** | **+9.3** | Clearly worse |
| `REGION_REPROCESS_THRESHOLD` 70 → 80 | +0.4 | +0.2 | Worse |
| `REGION_REPROCESS_THRESHOLD` 70 → 55 | −0.1 | −0.9 | Reproducible, but one image only |
| `MAX_REGIONS` 16 → 24 | −0.0 | +0.0 | No effect (hurts partial-GT images) |
| `MIN_REGION_WORD_COUNT_RATIO` 0.5 → 0.8 | −0.0 | +0.0 | No effect |
| `MIN_REGION_WORD_COUNT_RATIO` 0.5 → 0.3 | +0.0 | +0.0 | No effect at all |
| `MAX_ZERO_WORD_REGION_AREA_FRACTION` 0.08 → 0.03 | +0.3 | −0.0 | Worse |
| `MAX_ZERO_WORD_REGION_AREA_FRACTION` 0.08 → 0.15 | +0.4 / −0.1 | +2.2 / +0.2 | Contradicted itself between sweeps — noise |
| Raw (upscale-only) region candidate added | −0.1 | −0.2 | Within noise |

### The four that did literally nothing

The retry and preprocess-worth-trying thresholds produced **byte-identical
output** at every value tried, in both directions. They don't bind on this
corpus: no image sits near enough to either boundary for moving it to change
which candidate wins. Worth knowing before anyone spends time on them again.

### The one that looked promising

`REGION_REPROCESS_THRESHOLD` 70 → 55 was the only variant that reproduced across
both sweeps: −0.1 CER, −0.9 WER, identical numbers each time.

It was still rejected, because the per-image table shows the entire effect is
**one image** (complexPic2, −0.8 CER) and *exactly zero* change on the other ten.
An 0.9-point average improvement sourced from a single sample out of eight is
overfitting, not tuning — and the change makes the pipeline reprocess *fewer*
regions, which is precisely the sort of thing that generalizes badly to images
this corpus doesn't contain.

### The one that was clearly bad

Running the region pass on nearly every image (`SKIP_REGION_PASS_OVERALL_THRESHOLD`
85 → 95) costs **+4.2 CER / +9.3 WER**, concentrated in complexPic4 (+19.2) and
complexPic8 (+19.6) — both clean product-page screenshots. This is the same
finding the whole-image path already encodes: preprocessing clean content makes
it worse. The existing 85 threshold is doing real work, and is now measured
rather than assumed.

### The preprocessing lever

`REGION_INCLUDE_RAW_CANDIDATE` in `js/preprocess.js` adds an untouched
(upscale-only) candidate to the region pass, so a region can lose to its own
un-normalized self the way the whole-image pass already allows. It's a sound
idea — it makes the region pass follow the rule the whole-image pass follows —
but the measurement came back inside the noise floor: 0.1 CER, 0.2 WER, helping
complexPic3 and hurting complexPic6 by similar small amounts, at the cost of an
extra `recognize()` call per weak region.

Left **off**, and kept as a switch rather than deleted. What's inconclusive here
is the corpus, not the idea.

## What would actually move this

Not more threshold sweeping. **More images** — see `test/images/README.md` for
the categories that are missing and why. Eight scoring images cannot resolve a
one-point difference, which puts a hard floor under how much any of this can be
tuned. That step needs real photographs and is the one part of Phase 3 that
can't be done without them.
