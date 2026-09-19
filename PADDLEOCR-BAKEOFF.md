# PADDLEOCR-BAKEOFF.md — PP-OCRv6 against Tesseract.js, on this corpus

**Measured 2026-09-19, on branch `spike/paddleocr-bakeoff` only.** The shipping
pipeline is untouched: nothing here is imported by `js/`, wired into `ci.yml`,
or reachable from the app. This is the measurement
[`RECOGNITION-SPIKE.md`](RECOGNITION-SPIKE.md) §5 costed at 2–3 days and §6
recommended running before any cloud-tier decision.

Re-run it with [`test/research/paddle-bakeoff/README.md`](test/research/paddle-bakeoff/README.md).

---

## The result in one table

Same eleven images. Same `test/metrics.js`, imported rather than reimplemented.
Same eight gated for the headline.

| | Tesseract.js 5.1.1 (shipping) | PP-OCRv6-tiny (candidate) | Δ |
|---|---|---|---|
| **macro CER, gated 8** | 41.6% | **36.4%** | **−5.2 pts** |
| **pooled CER, gated 8** | 62.2% | **58.6%** | **−3.6 pts** |
| macro WER, gated 8 | 57.1% | **56.1%** | −1.0 pts |
| pooled WER, gated 8 | 76.3% | **75.9%** | −0.4 pts |
| partial-GT 3 (directional) | 129.9% | **74.0%** | −55.9 pts |
| images improved / regressed (of 8) | — | **6 / 2** | — |
| **browser payload** | **6.75 MB** | **19.9 MB** | **2.9× worse** |
| cold start (wasm + session init) | not separately measured | 169 ms | — |
| time to first text, cold page | not separately measured | 1,346 ms | — |
| whole corpus, engine time only | 59.0 s | **5.1 s** | **11.5× faster** |
| complexPic3 (the slow one), engine only | 25.3 s | **5.06 s** | **5× faster** |

**PaddleOCR wins on accuracy and loses on payload.** Both margins are real and
neither is overwhelming.

The speed rows are like-for-like: Tesseract's 59.0 s is the sum of its own
`recognize()` calls, measured by `test/research/ocr-instrument.mjs`, not the
69.4 s wall-clock that includes page load and UI. PaddleOCR's 5.1 s is the sum
of its `recognize()` calls. Comparing the 69.4 s figure would have flattered the
candidate by about 20%.

---

## Per-image, against the recorded baseline

| image | Tesseract CER | Paddle CER | ΔCER | Tesseract WER | Paddle WER | ΔWER |
|---|---|---|---|---|---|---|
| complexPic1 | 31.4% | **15.4%** | **−16.0** | 56.0% | 76.0% | **+20.0** |
| complexPic2 | 36.2% | **17.8%** | **−18.4** | 71.4% | **31.7%** | −39.7 |
| complexPic3 | 79.1% | **74.5%** | −4.6 | 94.8% | 95.1% | +0.4 |
| complexPic4 | **20.5%** | 23.1% | +2.6 | **16.5%** | 25.7% | +9.2 |
| complexPic5 | 7.8% | **2.3%** | −5.5 | 17.9% | **13.7%** | −4.3 |
| complexPic6 | 75.0% | **70.6%** | −4.4 | 97.3% | **86.2%** | −11.2 |
| complexPic8 | **34.8%** | 40.6% | +5.8 | **41.5%** | 50.0% | +8.5 |
| complexPic9 | 47.8% | **47.0%** | −0.8 | 61.3% | 70.7% | +9.3 |
| complexPic7 * | 80.6% | **73.5%** | −7.1 | 142.4% | **91.5%** | −50.8 |
| complexPic10 * | 166.0% | **71.7%** | **−94.3** | 297.1% | **85.7%** | −211.4 |
| complexPic11 * | 143.2% | **76.9%** | **−66.4** | 335.9% | **100.0%** | −235.9 |

`*` partial ground truth — directional only, never gated.

### Three things this table says that the headline does not

**1. The partial-GT images are the loudest signal, and they are not gated.**
Tesseract scores 166% and 143% CER on complexPic10 and complexPic11 — above
100%, meaning it emits far more text than the reference contains. PaddleOCR
brings both to ~72–77%. Some of that is genuinely reading the fine print those
transcriptions deliberately omit, and some is Tesseract hallucinating less.
**This corpus cannot separate the two**, which is exactly the limitation
`test/images/README.md` describes. It is nonetheless the largest behavioural
difference measured, and it is invisible in the gated number.

**2. CER improves while WER gets worse on complexPic1 — reading order.**
−16.0 CER and **+20.0 WER** on the same image. The recognized text shows why:

```
POCHAWK    POPSICLES& CHAWK DRAWNGS LOWER RESIDENTLANE   BUILDINGD AREA
RELAXING  Q : ON A 2 2   SUNNY DAY 9 A JULY31ST 5-7PM ...
```

Every phrase on the poster is there — Tesseract missed most of them — but the
order is interleaved with junk tokens (`Q :`, `2 2`, `9 A`) picked up from the
illustrations. PaddleOCR is a **detector**: it finds text boxes and sorts them
geometrically. Tesseract does real page-layout analysis. On a decorative poster
with scattered type, detection wins on *what* is read and loses on *in what
order*. For this app that matters more than usual, because
`js/editorObjects.js` renders words back onto the photograph in place — so box
positions matter more than serialized order — but the Raw text view, Copy,
Download and the Coherence Filter all consume the ordered string.

**3. The two regressions are both clean screenshots.** complexPic4 (+2.6) and
complexPic8 (+5.8) are product-page screenshots — flat, high-contrast, already
Tesseract's best case. This is the mirror image of the corpus split
`RECOGNITION-SPIKE.md` §6 identified: the document engine wins on documents, the
scene-text engine wins on scenes.

---

## Payload, measured rather than estimated

Counted from a real Chromium page load, byte by byte, with the test images
subtracted:

| Asset | Size |
|---|---|
| `ort-wasm-simd-threaded.wasm` | 13.58 MB |
| `PP-OCRv6_tiny_rec.ort` | 4.32 MB |
| `PP-OCRv6_tiny_det.ort` | 1.80 MB |
| `ort.wasm.min.mjs` + wasm glue + `ppu-paddle-ocr` + `ppu-ocv` JS (36 files) | 0.14 MB |
| `ppocrv6_tiny_dict.txt` | 0.03 MB |
| **total** | **~19.9 MB** |
| *Tesseract.js today, for comparison* | *6.75 MB* |

**The default configuration is 34.3 MB, not 19.9 MB.** `onnxruntime-web`'s
default entry resolves to the JSEP/WebGPU core at **27 MB**; importing
`onnxruntime-web/wasm` instead drops it to 13.58 MB with identical accuracy.
Anyone repeating this must pin that, or the payload is 5× Tesseract rather
than 3×.

Two constraints that turned out **not** to bind, both worth recording because
both were expected to:

- **No bundler is needed.** The whole graph loads in the browser through a
  two-entry import map. This repo's no-build-step property survives.
- **No COOP/COEP isolation is needed.** With `ort.env.wasm.numThreads = 1` the
  page never touches `SharedArrayBuffer`. That matters concretely: GitHub Pages
  cannot set those headers, so a threaded build would not have been deployable
  at all on the current origin.

### The OpenCV problem is avoidable

`ppu-paddle-ocr` defaults to `processing: { engine: "opencv" }`, which pulls
`@techstark/opencv-js` through `ppu-ocv`. This repo has refused OpenCV.js
deliberately — `js/preprocess.js`'s header records that its WASM runtime
reproducibly froze the main thread when loaded from a click handler.

**The canvas path is both cleaner and better.** `ppu-ocv/canvas-web` imports no
OpenCV at all, and it scores *better*:

| processing engine | macro CER (8) | pooled CER (8) |
|---|---|---|
| `canvas` | **36.4%** | **58.6%** |
| `opencv` | 38.4% | 58.8% |

So the dependency that would have been the blocker is simply not needed.

---

## Licensing and vendorability

| | |
|---|---|
| `ppu-paddle-ocr` 6.6.0 | MIT |
| `onnxruntime-web` 1.30.0 | MIT |
| PP-OCRv6 models | Apache-2.0 (PaddleOCR) |
| Vendorable like `vendor/tesseract`? | **Yes — demonstrated, not assumed** |

Every run in this document fetched its models from
`vendor-candidate/paddle/models/` on local disk, not from HuggingFace. The
package's CDN default is a configurable base path, not a constraint, so the
"served from this origin, no third-party host, CSP stays `'self'`" property that
`vendor/tesseract/README.md` exists to protect is preserved. The models are
committed on this branch for exactly that reason.

`node_modules/` is **not** committed — ~430 MB of ONNX Runtime binaries for
three platforms. Shipping would mean vendoring the three browser files listed in
the payload table, the same way `vendor/tesseract` vendors four.

---

## What this does not establish

- **Eight scoring images still cannot resolve a small difference.** A 5.2-point
  macro gap is larger than anything in `RECOGNITION-SPIKE.md` §3, and it is
  consistent in direction (6 of 8 images), which is about as much as this corpus
  can support. It cannot tell you the gap holds at 25 images, and the two
  regressions being *both* clean screenshots is a warning that the direction may
  partly be a corpus-composition artifact.
- **No real device.** Headless Chromium on a Mac. WKWebView's wasm performance,
  iOS memory limits under a 13.58 MB wasm module, and Safari's behaviour are all
  unmeasured — and a 19.9 MB payload is a very different proposition on a phone
  than on a laptop. This needs the device pass.
- **Accuracy was measured through `onnxruntime-node`, payload and timing through
  `onnxruntime-web`.** Same models and same graph, so the CER is expected to be
  identical, but the two halves were not measured in the same process. The
  browser run's per-image character counts match the node run's (complexPic5:
  706 chars, complexPic3: 6,269), which is consistent with identical output but
  is not a full per-image CER comparison in-browser.
- **No word-level geometry check.** `js/recognize.js` consumes
  `{ lineIndex, text, confidence, bbox }`, and `js/editorObjects.js` renders
  those boxes back onto the photo. This bake-off scored **text only**. Whether
  PaddleOCR's boxes are as well-placed as Tesseract's — which
  `test/render-fidelity.js` and `test/region-coverage.js` would measure — is
  untested, and complexPic1's reading-order scrambling is a hint that it may not
  be free.
- **Nothing was decided.** This is evidence for a decision, not the decision.

---

## Recommendation

**Do not adopt it on this evidence, and do not discard it either. Take the
photographs next.**

The bake-off did its job: it converted "PaddleOCR might be better" into "on
eleven images PaddleOCR is 5.2 macro / 3.6 pooled CER points better, 14× faster,
and costs 2.9× the payload, with no bundler, no COOP/COEP and no OpenCV." That
is a real result and a better position than the spike started from.

It is not yet enough to justify tripling the download, because:

1. **The gap is real but not decisive**, and two of the eight images regressed —
   both of them the clean screenshots that are a large part of what this app is
   actually used for.
2. **The reading-order regression is unpriced.** complexPic1's +20 WER is the
   kind of thing a user notices immediately in the Raw text view, and it feeds
   the Coherence Filter.
3. **19.9 MB on a phone is a product decision**, not an engineering one, and it
   interacts with the device pass that has not happened.

On the original question — **does this justify a cloud tier?** — the answer has
moved, and against the cloud tier. §6 said local engines were unexhausted; they
now measure *better* than the shipping engine on the corpus's hardest images,
locally, offline, at 11.5× the speed. The strongest argument for a cloud tier was
that the local ceiling was too low. **The local ceiling just moved down by 5.2
points, and the cheapest remaining move is still the 14 photographs** —
which would also tell you whether the 5.2 points survives contact with low
light, steep skew and a receipt.

Ordered: **take the photographs → re-run this bake-off on the expanded corpus →
decide adoption → consider a cloud tier only if both engines are still short.**
