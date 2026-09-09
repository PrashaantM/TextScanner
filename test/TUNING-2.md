# Tuning round 2 — noise floor and the non-Latin limitation

**Date:** 2026-09-09
**Corpus:** 11 images (`test/images/`), unchanged from round 1
**Engine:** Tesseract.js, web path
**Format:** follows `test/TUNING.md`

> **This round is incomplete, and deliberately so.** The plan's Phase 2 calls for
> expanding the corpus to ≥25 images before re-tuning. Fourteen of those must be
> newly shot photographs (low light, steep skew, dense small text, a receipt, a
> street sign, a photo of a screen, non-Latin script) taken on the same phone
> used for the device pass. Those cannot be generated — a synthesized image has
> none of the sensor noise, motion blur, rolling-shutter skew, or lens geometry
> that make those categories worth testing. **Everything below is what could be
> established without them.** The threshold sweep is not in it: re-tuning against
> the same 11 images that produced the round-1 thresholds would be circular, and
> its results would not survive the corpus expansion anyway.
>
> What is blocked: steps 1, 3, 4 and 5 of Phase 2.
> What is done: step 2 (noise floor) and step 6 (non-Latin), below.

---

## 1. Noise floor (Phase 2, step 2)

Two runs of `test/run-benchmark.js` against identical code, no changes between
them, on the same machine.

| | Average CER | Average WER |
|---|---|---|
| Run A | 68.2597% | 112.0133% |
| Run B | 68.2597% | 112.0133% |
| **Delta** | **0.000000 pts** | **0.000000 pts** |

Per-image deltas were zero on all 11 images — the two runs were bit-identical,
not merely close.

**Measured noise floor: 0.00 percentage points.**

### What that means for the merge rule

Phase 2's rule is "merge a threshold change only if the improvement exceeds
**twice** the measured noise floor *and* reproduces in a second independent
sweep." With a floor of zero, twice the floor is also zero, so the rule reduces
to: **any strictly positive improvement that reproduces exactly may merge.**

The reproduction half of the rule carries all the weight now, and it should not
be dropped as redundant — it is what catches a change that helps by accident
rather than by mechanism.

### What it does not mean

A zero measured floor is not proof that the pipeline is deterministic in
general. It says these two runs, on this machine, on this corpus, with this
Tesseract.js build, produced identical output. It is consistent with
determinism, which is what a WASM single-threaded recognizer with no random
seed and no time-dependent behaviour should give — but two runs cannot
distinguish "always deterministic" from "deterministic here".

Specifically not covered: a different CPU or core count (Tesseract.js's worker
count could vary), a different browser build, and the images the corpus does not
yet contain. Marginal images — ones where two candidate interpretations score
almost identically — are where non-determinism would first appear, and the
current corpus may simply not have one. Several of the categories still to be
added (low light, steep skew) are exactly the ones that produce marginal images.

**Treat 0.00 as provisional and re-measure after the corpus expands.** If the
floor is still zero across 25 images, that is a much stronger claim than this
one.

---

## 2. Non-Latin script (Phase 2, step 6)

Added as a **known-limitation assertion, not a pass/fail accuracy case**, exactly
as the plan specifies.

`js/mlkitEngine.js` requests `script: "LATIN"` and nothing else, documented as a
deliberate limitation in its header: ML Kit needs a separate bundled model per
script with no universal or auto-detect option, and
`scripts/trim-mlkit-scripts.js` strips the other four from the binary. The web
path has the matching limitation for a different reason — `js/ocrEngine.js`
loads the `eng` traineddata only.

**New:** `test/non-latin-limitation.js`, plus four generated samples in
`test/images/non-latin/` (`test/make-non-latin-images.js`). Generated rather
than photographed on purpose: these pin current behaviour and need exact ground
truth, which a clean render gives and a photo does not. They are **not** corpus
images and their ground truth deliberately lives beside them rather than in
`test/groundtruth/`, which `run-benchmark.js` treats as the corpus manifest.

### Measured, 2026-09-09 (web path, Tesseract.js `eng`)

| Sample | Script | Outcome | CER |
|---|---|---|---|
| `latin-control` | Latin (control) | success | **3.8%** |
| `non-latin-devanagari` | Devanagari | success | 83.3% |
| `non-latin-cjk` | Han (Simplified Chinese) | success | 127.3% |
| `non-latin-cyrillic` | Cyrillic | success | 95.7% |

The Latin control is the assertion that makes the rest meaningful. Without it,
"recognized nothing" would be equally consistent with a broken harness; at 3.8%
CER through the identical pipeline, the null results are attributable to the
script and nothing else.

Note that no sample errored or hung. The limitation **fails safely**: the app
returns confident-looking nonsense rather than crashing, which is the honest
description of the current behaviour and is worth having written down.

### What the test gates on

Three things fail the build; one does not.

- **Fails:** an uncaught page error or a hang on any sample.
- **Fails:** the Latin control regressing above 25% CER — that invalidates the
  whole comparison.
- **Fails:** a non-Latin sample dropping *below* 50% CER. That would be good
  news, and it would mean this document, `js/mlkitEngine.js`'s header,
  `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` and `ANALYSIS.md` all now describe
  a limitation that no longer exists. Better to fail loudly than to pass
  silently while the docs go stale.
- **Does not fail:** the non-Latin CER figures themselves. They are tracked
  numbers, printed every run.

`docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` §6 records that Vision's
`automaticallyDetectsLanguage` would close this limitation outright. If that
migration happens, this test is the thing that measures it.

---

## 3. Thresholds

**No threshold was changed in this round, and none was evaluated.**

This is a rejection of the work, not a null result from having done it. Running
`test/tune-thresholds.js` against the same 11 images that produced the round-1
thresholds would fit them more tightly to the corpus they were already fitted
to, and any "improvement" would be indistinguishable from overfitting. The sweep
is worth running exactly once, against the expanded corpus, and this document
should be superseded by a `TUNING-3.md` that does it.

`test/TUNING.md`'s round-1 thresholds stand unchanged.
