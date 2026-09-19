# RECOGNITION-SPIKE.md — can recognition improve without new photographs?

**Measured 2026-09-18, against `10d1e5d` on `main`.** A measurement spike, not a
feature. **No shipping code was changed.** The deliverable is evidence and a
recommendation; what ships is not decided here.

Everything below was produced by two new, non-gating harnesses committed
alongside this file — [`test/research/ocr-instrument.mjs`](test/research/ocr-instrument.mjs)
and [`test/research/ocr-sweep.mjs`](test/research/ocr-sweep.mjs) — plus
`test/run-benchmark.js` unchanged, and four experiments run in detached
`git worktree` checkouts. Raw output is committed next to the scripts so every
number here is re-derivable rather than asserted.

---

## 0. The honest frame, first

[`WEB-COMPLETION-PLAN.md` §4.4](WEB-COMPLETION-PLAN.md) is correct, and this
document does not pretend otherwise: re-tuning against the eleven images that
produced the current settings is circular, and
[`test/TUNING-2.md` §3](test/TUNING-2.md) already rejected doing it. This spike
did not try to escape that. It tried to find what can be measured *despite* it.

Every finding below carries one of two labels, and the distinction is the point:

- **WEAK-BUT-REAL** — a discrete, categorical setting (a PSM, a filter, an
  engine mode, a pass switched on or off) that helps most images and hurts
  none. On eight scoring images that is weak evidence, but it is evidence.
- **NOT EVIDENCE** — a continuous knob turned until the corpus average moved.
  That is overfitting wearing a number, and it is reported as such or not
  reported at all.

**The headline result is that nothing in this spike earned the first label.**
Seventeen categorical variants were scored across the full corpus. Not one of
them helps without also hurting. That is a null result, and it is the single
most useful thing in this document, because it is what §5's ceiling rests on.

Two things did earn a stronger label than either, because they are not tuning
at all — they are facts about the existing pipeline, measured for the first
time. They are in §2 and §4.3.

---

## 1. Baseline — confirmed, and one document corrected

`node test/run-benchmark.js --check-regression --baseline test/baseline-2026-08-28.json --tolerance 2.0`

```
image           CER      WER      time
------------------------------------------
complexPic1      31.4%    56.0%   2.8s
complexPic10 *  166.0%   297.1%   4.8s
complexPic11 *  143.2%   335.9%   4.9s
complexPic2      36.2%    71.4%   3.4s
complexPic3      79.1%    94.8%   27.1s
complexPic4      20.5%    16.5%   6.1s
complexPic5       7.8%    17.9%   2.0s
complexPic6      75.0%    97.3%   10.5s
complexPic7 *    80.6%   142.4%   4.5s
complexPic8      34.8%    41.5%   3.1s
complexPic9      47.8%    61.3%   2.5s
------------------------------------------
complete-GT (8)  41.6%    57.1%   <- gated
partial-GT (3) * 129.9%   258.5%
all 11 (info)    65.7%   112.0%   (continuity only, not gated)

CER delta: +0.00pts (tolerance 2pts)
WER delta: +0.00pts (tolerance 2pts)
No regression beyond tolerance.
```

**41.6% CER / 57.1% WER on the gated eight is confirmed exactly.** Reproduced
three separate times in this session (twice at `10d1e5d`, once at `423de90`),
bit-identical on every image every time — consistent with the 0.00 noise floor
`test/TUNING-2.md` §1 measured, and adding a third and fourth identical run to
that evidence.

### `test/TUNING.md`'s 45.1% is stale, not wrong — and §4.3 explains it

[`test/TUNING.md`](test/TUNING.md) states the eight-image baseline as **45.1%
CER**, while `run-benchmark.js`'s own header and the recorded baseline both say
**41.6%**. That contradiction has been sitting in the tree unexplained.

It is not a discrepancy. **45.1% is this pipeline with the coverage-rescue pass
switched off** — measured directly in §4.3 below, which lands on 45.1% to three
significant figures. `TUNING.md` was written before that pass existed, and its
number is simply the pre-coverage-rescue baseline. The gap between the two
documents *is* the feature.

---

## 2. The timing anomaly — one outlier is real, one does not reproduce

This was the first thing chased, on the stated reasoning that an outlier in a
different dimension than the one being scored is where a real cause hides. The
reasoning was sound. The answer is that one of the two outliers is not an
anomaly at all.

### 2.1 The recorded figures are exact, and they are in the baseline file

Both figures in the brief are correct: `test/baseline-2026-08-28.json` records
`complexPic6: 141487ms` and `complexPic3: 25697ms` under `elapsedMs`, against
1.8–5.7s for the rest.

### 2.2 complexPic6's 141s does not reproduce — at any commit

| Image | Recorded in baseline | At `423de90` (the commit that recorded it) | At `10d1e5d` (run 1 / run 2) | Verdict |
|---|---|---|---|---|
| complexPic6 | **141,487 ms** | **10.6 s** | 10.5 s / 10.5 s | **does not reproduce — 13× discrepancy** |
| complexPic11 | **21,088 ms** | 4.7 s | 4.9 s / 4.6 s | **does not reproduce — 4.5× discrepancy** |
| complexPic3 | 25,697 ms | 26.1 s | 27.1 s / 26.1 s | **reproduces exactly** |
| complexPic5 | 1,836 ms | 1.8 s | 2.0 s / 1.8 s | reproduces |
| complexPic4 | 5,664 ms | 5.6 s | 6.1 s / 5.6 s | reproduces |

The critical control is the second column. `423de90` is the exact commit whose
run produced the baseline file (`recordedAt: 2026-09-15T01:46:28Z`), checked out
into a detached worktree and run unmodified. **complexPic6 takes 10.6s there,
with byte-identical CER (75.0%) and WER (97.3%).** The same code, the same
image, the same output, 13× faster.

So the 141s was not code. It was the machine. Between `423de90` and `10d1e5d`
the only change to the recognition path at all is a `logger` null-guard
(`git diff 423de90..HEAD -- js/ocrEngine.js` is 16 lines, all comment plus
`logger: onProgress || (() => {})`), which cannot account for a 13× difference
and does not change output.

**Direct corroboration for "it was the machine":** this session began by
discovering *three* Claude sessions running this repo's full suite concurrently
on this machine, colliding on `run-benchmark.js`'s hardcoded port 8123. A
benchmark recorded under that kind of contention would show exactly this
signature — a few heavy images inflated several-fold, light ones untouched.
That is a plausible mechanism, not a proven one; what *is* proven is that the
number does not reproduce on quiet hardware at the commit that produced it.

**Consequence: `elapsedMs` in `test/baseline-2026-08-28.json` should not be
trusted or cited.** The CER/WER in that file are solid — they reproduce
bit-identically. The timings in it do not, and nothing in the repo gates them,
so nothing ever caught it.

### 2.3 complexPic3's 26s is real, and it is density, not pathology

complexPic3 reproduces at ~26s everywhere. `ocr-instrument.mjs` wrapped
`Tesseract.createWorker` from a Playwright init script — so the real
`js/ocrEngine.js` ran untouched — and logged every `recognize()` call:

| Image | `recognize()` calls | Engine ms | PSM histogram | GT chars |
|---|---|---|---|---|
| complexPic6 | 35 | 9,670 | `{3:2, 6:16, 11:17}` | 1,298 |
| complexPic10 | 35 | 4,113 | `{3:2, 6:32, 11:1}` | 159 |
| complexPic11 | 35 | 3,483 | `{3:2, 6:32, 11:1}` | 229 |
| complexPic7 | 31 | 3,354 | `{3:2, 6:22, 7:6, 11:1}` | 381 |
| **complexPic3** | **27** | **25,288** | `{3:2, 6:4, 7:4, 11:17}` | **7,351** |
| complexPic2 | 12 | 2,234 | — | 370 |
| complexPic1 | 4 | 898 | — | 156 |
| complexPic4 | 2 | 4,832 | `{3:1, 11:1}` | 1,556 |
| complexPic5 | 1 | 1,046 | `{3:1}` | 695 |

Four findings, all contention-immune because they are counts:

1. **Image dimensions are ruled out.** complexPic6 is 1536×2048 (3.15 MP) —
   identical in size to complexPic9, 7, 4 and 11, which finish in 1.8–6s.
   complexPic3 is 1536×1024 (1.57 MP), the *same* size as complexPic1, which
   takes 1.5s. Size explains nothing.
2. **There is no retry loop.** The pipeline is hard-capped by construction: at
   most 3 whole-image passes, plus `MAX_REGIONS` (16) regions × the 2
   preprocessing candidates `preprocessRegion` yields in practice (contrast and
   edge; the raw candidate is off — `REGION_INCLUDE_RAW_CANDIDATE` is `false`)
   = **35 calls**. complexPic6, 10 and 11 sit exactly on that cap. Nothing runs
   away; three images simply saturate it.
3. **complexPic3 is slow because it is dense, not because it loops.** It makes
   *fewer* calls than complexPic6 (27 vs 35) and takes 2.6× longer, because its
   calls are individually huge: pass 1 reads 455 words, pass 2 reads 683, the
   sparse pass reads 802 across 365 blocks. Its three whole-image passes alone
   cost 15.8s of 25.3s (62%). LSTM time scales with how much text there is, and
   complexPic3 holds **7,351 of the corpus's 12,511 ground-truth characters —
   58.8% of all the text in the gated eight, in one image.**
4. **The expensive work is discarded on exactly the images that trigger it.**
   On complexPic3 the preprocessed whole-image pass costs 4.9s and is thrown
   away (mean confidence 43.6 vs the raw pass's 48.0). On complexPic6 the same
   pass costs 1.3s and is thrown away (37.8 vs 49.9). That is the documented
   "can only help, never hurt" contract working as designed — but it is not
   free, and on these two images it is pure cost.

### 2.4 The causality runs the other way

**The slow images are slow *because* they score badly, not the reverse.** Every
extra pass in `js/ocrEngine.js` is gated on low confidence: preprocessing fires
below 70, the sparse retry below 40, region reprocessing below 85/70. An image
the engine reads confidently gets one pass (complexPic5: 1 call, 1.0s, 7.8%
CER). An image it struggles with gets up to 35 (complexPic6: 35 calls, 9.7s,
75.0% CER). Time spent is a *readout* of the engine's own difficulty, not a
cause of it.

**So the timing outlier was not hiding an accuracy bug.** That was the best
available hypothesis and it is now closed: the scores are bit-identical across
every run at every commit tested, fast or slow. This is a disclosed negative
result — the most likely place for a real cause turned out not to contain one.

---

## 3. The sweep — seventeen variants, none of them clean

`node test/research/ocr-sweep.mjs`. One variable at a time against a
**single-pass control** using the app's own pass-1 settings (PSM.AUTO, oem 1,
`rotateAuto: true`, untouched image), scored on the full corpus.

**Why the control is a single pass, and why that matters for reading this
table.** `js/ocrEngine.js` is an adaptive five-stage pipeline. Comparing a
single-pass variant against *that* would conflate "PSM 6 beats PSM 3" with "one
pass loses to five", and the second effect is far larger. So the control here is
one pass, and the app's end-to-end 41.6% is a **separate axis** that must not be
read as a row in this table. For reference: the single-pass control scores
**48.7%**, so the existing multi-pass pipeline is buying **7.1 CER points** over
a naive single pass.

### Per-image CER delta vs the single-pass control (negative = better)

| variant | p1 | p2 | p3 | p4 | p5 | p6 | p8 | p9 | mean |
|---|---|---|---|---|---|---|---|---|---|
| **control (absolute CER)** | 35.9 | 62.4 | 78.2 | 19.0 | 7.3 | 83.1 | 36.2 | 67.3 | **48.7** |
| psm 4 (single column) | +7.7 | −28.4 | +1.7 | −0.3 | +3.3 | −4.8 | +0.2 | −10.7 | 44.8 |
| psm 6 (single uniform block) | +18.6 | −33.0 | −0.5 | +5.0 | +3.5 | +23.0 | +14.3 | −1.6 | 52.3 |
| psm 11 (sparse text) | −7.1 | −38.6 | −3.3 | +0.0 | +1.4 | +14.4 | −2.4 | −6.2 | 43.4 |
| psm 12 (sparse text + OSD) | −3.8 | −41.4 | −3.2 | −0.1 | +1.0 | +18.0 | −2.3 | −19.1 | 42.3 |
| user_defined_dpi 70 | +0.0 | +0.0 | +0.0 | +0.0 | +0.0 | +0.0 | +0.0 | +0.0 | 48.7 |
| user_defined_dpi 150 | +9.0 | +0.0 | −5.3 | −0.3 | +3.3 | +3.0 | +1.2 | −12.1 | 48.5 |
| user_defined_dpi 300 | +10.9 | −27.0 | +2.4 | −0.6 | +0.0 | +2.5 | −0.3 | +2.9 | 47.5 |
| upscale 1.5× (bicubic) | +3.2 | −34.1 | −25.7 | −0.1 | +5.2 | −3.9 | −0.2 | −10.3 | **40.4** |
| upscale 2.0× (bicubic) | −0.6 | −26.8 | −19.5 | +5.7 | +1.4 | +0.6 | +3.5 | −9.6 | 43.0 |
| downscale 0.75× | +3.2 | −25.9 | +16.9 | +4.6 | +1.9 | +8.9 | +1.0 | +9.0 | 51.1 |
| scanFilters: auto enhance | +16.7 | +33.0 | −8.4 | +5.2 | +1.6 | +4.5 | +20.3 | +16.2 | 59.8 |
| scanFilters: magic colour | +25.6 | +30.8 | +1.2 | +6.5 | −1.3 | +1.6 | +21.7 | +19.9 | 61.9 |
| scanFilters: greyscale | −0.6 | −28.1 | −6.8 | +12.7 | −2.9 | −0.7 | −1.7 | +5.3 | 45.8 |
| scanFilters: black & white | +42.9 | +30.0 | −2.2 | +14.2 | +1.3 | +2.8 | +28.0 | +14.8 | 65.1 |
| scanFilters: soft B&W | +11.5 | +30.3 | −2.2 | +12.7 | +0.4 | +1.9 | +20.8 | +12.7 | 59.7 |
| rotateAuto off | +0.0 | +0.0 | +0.0 | −4.2 | +0.0 | +5.9 | −1.4 | −11.7 | 47.2 |
| OCR each block separately | +8.3 | −17.3 | −1.0 | +44.8 | +6.2 | +47.0 | +19.9 | +35.5 | 66.6 |
| oem 3 (LSTM + legacy) | — | — | — | — | — | — | — | — | **UNMEASURED** |

### Verdict table

| Variable | Setting | ΔCER | improved | regressed | Label |
|---|---|---|---|---|---|
| Page segmentation | psm 4 / 6 / 11 / 12 | −3.9 / +3.7 / −5.2 / −6.4 | 4 / 3 / 5 / 5 | 4 / 5 / 2 / 2 | NOT EVIDENCE — all trade |
| DPI hint | 70 | +0.0 | 0 | 0 | No effect whatsoever |
| DPI hint | 150 / 300 | −0.1 / −1.2 | 3 / 3 | 4 / 4 | NOT EVIDENCE — trades |
| Upscaling | 1.5× / 2.0× | −8.2 / −5.6 | 5 / 4 | 2 / 4 | NOT EVIDENCE — see §4.4 |
| Downscaling | 0.75× | +2.4 | 1 | 7 | Clearly worse |
| scanFilters | auto / magic / bw / softbw | +11.1 / +13.3 / +16.5 / +11.0 | 1 each | 7 each | **Clearly worse** |
| scanFilters | greyscale | −2.9 | 6 | 2 | NOT EVIDENCE — closest miss |
| Deskew | rotateAuto off | −1.4 | 3 | 1 | NOT EVIDENCE — 4 unaffected |
| Per-region OCR | each block separately | +17.9 | 2 | 6 | **Clearly worse** |
| Engine mode | oem 3 (LSTM+legacy) | — | — | — | **UNMEASURED — hard limit** |

### What the sweep actually established

- **No variant qualifies as WEAK-BUT-REAL.** Zero of seventeen help most and
  hurt none. The nearest miss is greyscale (6 better, 2 worse), and the two it
  hurts it hurts by +12.7 and +5.3 points.
- **Running OCR per detected region instead of the whole frame is much worse**
  (+17.9 CER), and catastrophically so on complexPic4 (+44.8), complexPic6
  (+47.0) and complexPic9 (+35.5). This directly answers that item in the brief:
  it is not a missed opportunity. The existing pipeline's *selective* region
  reprocessing — only weak regions, only when the whole-image result is poor,
  only if the result scores better — is doing something categorically different
  from "OCR every block", and the difference is worth 18 CER points.
- **`js/scanFilters.js` is actively harmful as OCR preprocessing**, by 11–17 CER
  points on four of its five non-identity filters. That module's header claims
  it produces "the image the PERSON keeps" while `js/preprocess.js` produces
  "the image the RECOGNIZER sees", and that the split is load-bearing. **That
  claim was an assertion in a comment and is now a measurement.** Binarization
  in particular (+16.5 CER, +32.9 WER) is the single worst thing tried.
- **The DPI hint at 70 changes nothing at all** — byte-identical output on all
  eleven images. Tesseract's own DPI estimate already lands there.
- **Almost every apparent win is one image.** complexPic2 alone moves −17 to
  −41 points under nearly every variant, because the single-pass control does
  badly on it (62.4%) and almost anything helps. In the shipping pipeline
  complexPic2 is already 36.2% — the multi-pass path *already captures* that
  gain. An average improvement sourced from one of eight images is precisely the
  overfitting `test/TUNING.md` rejected, and it recurs here.

---

## 4. Four experiments beyond the sweep

Run in detached `git worktree` checkouts so the main tree was never modified.

### 4.1 Reproducibility — the noise floor holds

Four full benchmark runs across two commits produced bit-identical CER and WER
on all eleven images. The 0.00pt floor in `test/TUNING-2.md` §1 now has four
more data points and no counter-example. It remains "deterministic here", not
"deterministic in general", for the reasons that document gives.

### 4.2 The 141s archaeology

Covered in §2.2. The decisive run is the benchmark executed unmodified at
`423de90` in a detached worktree.

### 4.3 The coverage-rescue pass is worth 3.6 CER points — **STRONG EVIDENCE**

Not a tuning result: a single behaviour switched off, at HEAD, in a worktree.
The branch was disabled surgically (`if (false && hasUnreachableStructure)`)
rather than by moving `MAX_ZERO_WORD_REGION_AREA_FRACTION`, because that
constant also gates the region-pass filter and moving it would change two things
at once.

| | gated CER | gated WER | complexPic6 time |
|---|---|---|---|
| HEAD (rescue on) | **41.6%** | 57.1% | 10.5s |
| rescue off | **45.1%** | 57.1% | 5.6s |
| **delta** | **+3.57 pts worse** | −0.01 | −4.9s |

Per-image, switching it off costs complexPic1 **+14.7** CER, complexPic9
**+9.9**, complexPic2 +1.9, complexPic6 +1.6, complexPic4 +0.5, complexPic3
+0.4 — it helps **six of eight images and hurts none.** That is the
WEAK-BUT-REAL bar, cleared by an existing feature rather than a proposed one.

This is the most valuable number in the document, for three reasons:

1. **It is the largest measured accuracy effect anywhere in this pipeline's
   recorded history**, larger than every variant in §3 and every threshold in
   `test/TUNING.md`.
2. **It explains `TUNING.md`'s 45.1%** — that document predates the feature.
3. **It prices the timing outliers.** The coverage rescue is also the single
   most expensive pass on exactly the slow images: 5.4s of complexPic6's 9.7s
   engine time, 7.2s of complexPic3's 25.3s. So roughly half the runtime of the
   two slowest images buys 3.6 CER points corpus-wide. **The slowness is the
   feature working, not a defect** — which retires the "pathological
   segmentation" hypothesis outright.

### 4.4 Upscaling does not transfer to the real pipeline — **NEGATIVE RESULT**

§3's best single-variable lever (upscale 1.5×, −8.2 CER against the single-pass
control) is the one result that looked worth chasing, so it was tested properly:
the **full app pipeline**, fed 1.5×-upscaled corpus images, ground truth
unchanged. This is a fair test because `js/preprocess.js` only upscales to a
1000px minimum dimension (`MAX_UPSCALE_FACTOR` 2) and every corpus image is
already ≥946px — so today the whole-image upscale barely fires.

| | gated CER | gated WER |
|---|---|---|
| HEAD, normal images | **41.6%** | **57.1%** |
| HEAD, 1.5× images | **42.5%** | **66.4%** |
| delta | **+0.94 worse** | **+9.35 worse** |

It regresses. complexPic8 +11.5 CER, complexPic5 +4.9, complexPic9 +4.5,
complexPic6 +2.0. The gain seen against a single pass was the single pass
recovering something the multi-pass pipeline already recovers by other means.

One genuinely interesting side effect, reported because it is a null result
pointing somewhere real: the **partial**-ground-truth images improved sharply
(129.9% → 79.8% CER), which per `test/partialGroundTruth.js` means the upscaled
run read *more of the real fine print* those transcriptions deliberately omit.
That is consistent with upscaling helping small text — and it is **unmeasurable
on this corpus** precisely because the ground truth for the small-text images is
incomplete. It is the clearest single argument for the "dense small text" and
"receipt" categories `test/images/README.md` says are missing.

---

## 5. Alternatives to Tesseract.js that run locally in a browser

Nothing was vendored, downloaded, or installed. This is desk research with
sources, and where a number could not be verified it says so.

**The bar to clear.** The current engine's real runtime payload is **6.75 MB**:
`tesseract-core-simd-lstm.wasm.js` (3.76 MB) + `eng.traineddata.gz` (2.82 MB) +
`tesseract.min.js` + `worker.min.js` (0.18 MB). Both cores are vendored but only
one is fetched. It is Apache-2.0, fully offline, CSP-clean, and vendored with no
build step — a bar that is much higher than "is the accuracy better".

| Candidate | Payload | License | Vendorable like `vendor/tesseract`? | Published accuracy | Verdict |
|---|---|---|---|---|---|
| **Tesseract.js 6.x** (version bump) | ~6.75 MB, unchanged | Apache-2.0 | Yes — same shape | **None claimed.** Release notes describe memory-leak fixes and lower runtime/memory, **not accuracy** | **Not an accuracy lever.** And it is a *breaking* change here — see below |
| **PaddleOCR (PP-OCRv5/v6) via onnxruntime-web** | **~18–20 MB** (ort wasm 12–14 MB + tiny models ~6 MB); small tier ~30 MB, medium ~139 MB | Apache-2.0 (models + PaddleOCR); MIT (the `ppu-paddle-ocr` JS SDK) | **Yes in principle** — ONNX files are static assets and can be served from this origin; the "fetches from CDN" default is a base-path setting, not a constraint | 99.2–99.5% char accuracy — **on one reference receipt**. PP-OCRv6 reports 83.2% recognition / 86.2% detection Hmean on *in-house* benchmarks and **no Tesseract comparison at all** | **The only serious candidate.** ~3× the payload for an accuracy claim that is not measured on anything resembling this corpus |
| **Transformers.js** (TrOCR, Donut, GOT-OCR2) | GOT-OCR2 is 580M params — **hundreds of MB even quantized** | Apache-2.0 / MIT varies | Technically yes; practically no at this size | Strong on documents; TrOCR is **single-line only** and needs a separate text detector | **Rejected on size.** 50–100× the current payload for a phone web app |
| **Browser-native `TextDetector`** (Shape Detection API) | **0 MB** | Platform | N/A — no asset | Platform-dependent, unspecified | **Rejected.** Moved to an *informative* spec as "not stable enough across platforms or character sets"; Chrome flag-only, regressed in Safari 18.x. Not shippable |

### The Tesseract.js 6 finding is a warning, not an upgrade path

v6 "restructured `blocks`; only text-based blocks are reported." `js/ocrEngine.js`
depends on the opposite: its coverage rescue is triggered by
`hasUnreachableStructure` — **regions where layout analysis produced a block but
word recognition produced zero words.** A zero-word block is precisely a block
that is not text-based. If v6 stops reporting those, the rescue pass stops
firing, and §4.3 prices that at **+3.6 CER points**. A v6 bump should be treated
as a change that can silently cost more accuracy than anything in §3 could
recover. This was not verified against a real v6 build — it is read from release
notes — and it should be verified before anyone bumps.

### What a PaddleOCR bake-off would actually cost

Roughly **2–3 days**, and it does not need new photographs:

1. Vendor `onnxruntime-web` + PP-OCRv5 mobile det/rec + dictionary into a
   scratch tree; confirm the CSP and offline story hold (~0.5 day).
2. Write an adapter producing the same flat `{ lineIndex, text, confidence, bbox }`
   word list `js/recognize.js` already dispatches to — the engine seam already
   exists and absorbed ML Kit's `quad`/`frame` without a new abstraction
   (`ANALYSIS.md` §2.5), so this is the cheap part (~1 day).
3. Score it with `test/run-benchmark.js` unchanged (~0.5 day).

The seam is the reason this is cheap. **The decision it would inform is not
"which is more accurate on 11 images" — §6 explains why that question cannot be
answered here — it is "is the gap large enough to be visible through an
11-image corpus at all".** A 3× payload increase needs a large, obvious win, and
a large obvious win is the one thing a small corpus *can* detect.

---

## 6. The ceiling — what I actually believe, and how confident I am

### The corpus is the binding constraint, in a way not previously written down

The gated metric is a **macro-average over eight images**, but the text is not
distributed anything like evenly:

| | chars of ground truth | share of all gated text | weight in the gated CER |
|---|---|---|---|
| complexPic3 | 7,351 | **58.8%** | 1/8 = 12.5% |
| complexPic1 | 156 | 1.2% | 1/8 = 12.5% |
| all eight | 12,511 | 100% | — |

**One image holds 59% of the corpus's text and gets 12.5% of the vote.**
complexPic1 holds 1.2% of the text and gets the same 12.5%. The two differ by
47× in text volume and not at all in influence.

This has a concrete consequence: the **pooled** error rate (total edits ÷ total
characters) is **62.2% CER / 76.3% WER**, against the macro-averaged **41.6% /
57.1%**. Both are defensible metrics; they differ by 20 points; and the gated one
is the more flattering. Nothing is wrong with the choice — the macro-average is
the right call for a gate, because it stops one image dominating — but **"41.6%
CER" should not be read as "the engine gets 58% of characters right on this
corpus". Per character, it gets 38% right.**

### My estimate

**For a locally-run engine on this corpus, I believe the realistic best case is
roughly 30–38% macro-averaged CER, and I do not believe any configuration of
Tesseract.js reaches the low 30s.** Reasoning:

- The pipeline is already at 41.6%, and §3 found nothing categorical left in the
  engine — seventeen variants, zero clean wins, on the levers the brief named
  plus five filters.
- The largest effect anyone has found in this pipeline's history is the coverage
  rescue at 3.6 points (§4.3), and it is already shipping.
- The remaining error is concentrated in complexPic3 (79.1%) and complexPic6
  (75.0%). complexPic3 is a dense UI mockup — many small text fields; complexPic6
  is photographed retail packaging with stylised display type, foil, and two
  languages. Neither is a *page*. Tesseract is a document OCR engine: layout
  analysis into blocks, then line recognition. Scene text and dense small UI
  chrome are the two things it is architecturally worst at, and no PSM or filter
  changes the architecture.
- A detector-based engine (PaddleOCR's DB detector + CRNN recogniser) is built
  for exactly that distribution, which is the honest reason it is the only
  candidate in §5 worth a bake-off. **I would guess** it lands somewhere in the
  high 20s to mid 30s on this corpus — and I want to be explicit that this is a
  guess from architecture, not a measurement, and §5 shows its published numbers
  are from a single receipt.

### Confidence

**Low-to-moderate on the number; high on the shape.**

- **High confidence (measured, reproduced):** 41.6% is correct; the engine levers
  are exhausted; per-region OCR and `scanFilters` preprocessing are worse; the
  coverage rescue is worth 3.6 points; the 141s is not a code defect.
- **Low confidence (eight images):** any claim that a given configuration lands
  at a specific CER. Eight scoring images cannot resolve a one-point difference —
  `test/images/README.md` has said so for months and this spike is one more
  confirmation of it, not a way around it.
- **This is §4.4's circularity, undefeated.** I could not beat it. I could only
  map where it binds.

### The answer to the question actually being asked

**Does a cloud tier become necessary?**

**Not on this evidence — and this is the one place I want to be most careful,
because it is the expensive decision.**

What the measurements support is narrower and more useful than a verdict:

1. **Local configuration is exhausted.** Nothing further will come from tuning
   Tesseract.js. That part is settled, and it is the question the spike was
   asked to settle.
2. **Local *engines* are not exhausted.** Exactly one untried local option
   (PaddleOCR via ONNX) is architecturally suited to this corpus, is
   Apache-2.0, is vendorable the way `vendor/tesseract` is, and has never been
   measured here. **Reaching for a cloud tier before spending 2–3 days on that
   bake-off would be buying a recurring cost, a privacy regression, and a
   network dependency to solve a problem that may have a local answer.** For an
   app whose entire pitch is local-first, that ordering matters.
3. **The corpus still gates everything.** Even if the bake-off shows PaddleOCR
   ahead, eight images cannot tell you *how far* ahead. The 14 photographs in
   `HANDOFF.md` §5.2 remain the highest-value unblocked-by-engineering item in
   the project, and §4.4's argument that a cloud decision needs them is
   unchanged by anything here.

My recommendation, in order: **run the PaddleOCR bake-off; take the
photographs; decide the cloud tier last, with both results in hand.** A cloud
tier is a reasonable answer to "the local ceiling is too low" — but the local
ceiling has not actually been established yet, only Tesseract's.

---

## 7. What this session did not verify

Stated plainly, because a disclosed gap is fine and a silent one is not.

- **`oem 3` / `oem 0` (LSTM+legacy, legacy-only) — UNMEASURED, hard limit.**
  `vendor/tesseract/core/` ships only `tesseract-core-simd-lstm.wasm.js` and
  `tesseract-core-lstm.wasm.js`, and `eng.traineddata.gz` is the
  `4.0.0_best_int` LSTM build. Running a legacy engine mode needs a non-LSTM
  wasm core *and* legacy-capable traineddata, neither of which is in the tree.
  Measuring it meant downloading from a CDN, which this repo has correctly
  refused and which the brief forbade vendoring. The sweep lists the variant and
  skips it out loud rather than omitting it. **Expected impact is low** — LSTM
  beats legacy on almost everything except very clean small single-font text —
  but that is an expectation, not a measurement.
- **Tesseract.js v6 was not run.** The `blocks` restructuring risk in §5 is read
  from release notes, not reproduced. Verify before bumping.
- **No real-device measurement.** Everything here is headless Chromium on a Mac.
  A real iPhone, real Safari, and an iOS Simulator are hardware I do not have,
  and WKWebView's wasm performance and the native ML Kit path are both untested
  by this spike. The native engine (`js/mlkitEngine.js`) was not measured at all
  — this is a web-path spike.
- **The timing contention hypothesis (§2.2) is plausible, not proven.** What is
  proven is that 141s does not reproduce at the commit that recorded it.
- **`elapsedMs` in the baseline file is now known to be unreliable and is still
  in the file.** Nothing was changed, because changing it would be a pipeline-
  adjacent edit this session was told not to make. Worth a follow-up: either
  stop recording it, or record it only from a quiet machine and say so.
- **The full suite "after" run was taken in an isolated worktree, not the main
  tree** — see §8.

---

## 8. Provenance, and one thing that went wrong

**Full suite before:** all **30** `run: node test/…` steps in `ci.yml`'s per-push
job, at `10d1e5d` with a clean tree — **30/30 pass, nothing red before starting.**

**Full suite after:** **32/32 pass**, in a clean worktree at `fa081b6` with only
this session's six files added. The count is 30 before and 32 after because
`fa081b6` — another session's commit, landed mid-session — added
`test/repo-contract.js` and wired `test/paste-placement.js`. **Neither gate is
mine and neither count moved because of this work.**

**Concurrency, disclosed.** Three Claude sessions were running this repo's suite
on this machine simultaneously when this one began, colliding on
`run-benchmark.js`'s hardcoded port 8123. That was surfaced before any number was
produced, and the measurement ran isolated afterwards. **Mid-session, another
session committed `fa081b6` and left uncommitted edits to `js/app.js`,
`js/cropView.js`, `js/documents.js`, `js/scanDoc.js` and others in the shared
working tree.** Consequently:

- Every number in this document was measured at **`10d1e5d`** with a clean tree,
  or in a detached worktree at `423de90` / `d77e029`. None is contaminated.
- The **"after" suite was run in a clean worktree** at the new HEAD with only
  this session's files added, rather than in the main tree, because the main
  tree contains another session's in-flight work and a red result there would
  not have been attributable.
- This commit stages **only its own paths**. It does not sweep up the other
  session's uncommitted changes.

**Counts.** This commit adds no `js/` module, no `ci.yml` step and no DOM id, so
it moves none of the three counts `WEB-COMPLETION-PLAN.md` §0 gates. Both new
harnesses are `.mjs` under `test/research/`, which `test/repo-contract.js`'s
CHECK 2 scopes to top-level `test/*.js` — the same precedent
`test/research/font-features.mjs` set. **They are deliberately not gates:** they
assert nothing, they produce tables, and a full sweep takes ~12 minutes against
a per-push job that runs in three and a half.

**Fail-then-pass.** The project's rule requires any new or changed assertion to
be shown failing before and passing after. **This commit contains no assertion
and claims no fix**, so the rule's precondition is not met — stated here rather
than silently skipped. The nearest equivalent evidence that the harnesses
measure what they claim is §4.3 and §4.4: both were run with a single behaviour
changed in a worktree, and both moved the gated number in the predicted
direction (+3.57 and +0.94), which a harness measuring nothing could not do.
