# PADDLEOCR-BAKEOFF.md — PP-OCRv6 against Tesseract.js, on this corpus

**Measured 2026-09-18 to 2026-09-20.** The shipping pipeline is untouched:
nothing here is imported by `js/`, wired into `ci.yml`, or reachable from the
app. This is the measurement
[`RECOGNITION-SPIKE.md`](../../RECOGNITION-SPIKE.md) §5 costed at 2–3 days and
§6 made the cloud-tier decision conditional on.

> **This is the record on `main`, and it does not run from a `main` checkout.**
> The harnesses beside it are byte-identical to the ones that produced every
> number below, but they need `ppu-paddle-ocr`, `onnxruntime-web` and ~6 MB of
> PP-OCRv6 ONNX models — none of which is on `main`, and none of which should
> be.
>
> **Everything needed to re-run lives at commit `5855505` on branch
> `spike/paddleocr-bakeoff`** (pinned by SHA because a branch ref moves or gets
> deleted and a commit does not). [`README.md`](README.md) has the exact
> sequence.
>
> Kept here anyway because a write-up whose method cannot be inspected is an
> assertion, and `test/research/` is where this repo keeps the script next to
> the claim.

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

**PaddleOCR wins on accuracy, loses on payload, and cannot place a word.**

The accuracy and payload margins are real and neither is overwhelming. The
geometry is not a margin: PP-OCR returns **10 boxes for 30 words**, with a
median per-word centre error of **105.6 px** against Tesseract's **0.4 px**.
That is the number that decides this, and it is measured in the Geometry
section below. Read the accuracy table knowing the conclusion turns on it.

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

## Geometry — the measurement that decides it

**Added 2026-09-19.** The text scores above were never the deciding number. This
app's differentiator is putting a replacement word back at the original word's
position, at its size, in a matched face — `renderImageFormatView`
(`js/editorObjects.js`) and `js/fontMatch.js` — and all of that is a function of
per-**word** box accuracy. A CER win bought with coarser boxes is a net loss here.

Run it with `node test/research/paddle-bakeoff/geometry-bakeoff.mjs` and
`node test/research/paddle-bakeoff/region-coverage-bakeoff.mjs`.

### Why the two gates could not simply be pointed at the candidate

- **`test/render-fidelity.js` has no OCR in it to swap.** It is deliberately
  engine-*independent*: its header says it "isolates `renderImageFormatView`
  from whichever OCR engine produced the words" by feeding **perfect** boxes to
  the renderer, so that if perfect boxes render wrong, the renderer is at fault
  regardless of engine. Its second half replays `test/make-mlkit-fixture.js`,
  which emits **coordinates only, no pixels** — nothing an engine can read.
- **`test/region-coverage.js` drives the real app**, so it measures Tesseract by
  construction.

So the gates were not run against the candidate — they *cannot* be, as written.
What was reused is the idea that makes each work: render-fidelity's synthetic
image whose word boxes are known exactly from `ctx.measureText`'s
`actualBoundingBox` metrics, and region-coverage's own assignment rule and
per-area ceilings. Both harnesses are new files; neither gate was modified.

The synthetic poster's ground-truth boxes are cross-checked against a
per-channel pixel scan before being used as a yardstick, so a mis-mirrored
poster cannot silently become the standard. That check earned its keep
immediately: a luminance-only version rejected the poster's last line, which is
grey ink on the red band — a ~10 luminance gap and a ~96 red-channel gap. The
text is plainly legible; the check was wrong, and is now per-channel.

### Per-word box accuracy, against exact ground truth

Synthetic poster, 1024×1536, 30 words on 10 lines, measured two ways on purpose.

**Against ground-truth WORD boxes — what `js/editorObjects.js` consumes:**

| | boxes | mean IoU | IoU>0.5 | IoU>0.1 | median centre error | median height ratio |
|---|---|---|---|---|---|---|
| **Tesseract (app path)** | 30 | **0.835** | **25/30** | 29/30 | **0.4 px** | 1.02× |
| PaddleOCR PP-OCRv6 | 30 | 0.260 | 4/30 | 23/30 | **105.6 px** | 1.15× |

**Against ground-truth LINE boxes — the granularity PP-OCR actually reports:**

| | boxes | mean IoU | IoU>0.5 | IoU>0.1 | median centre error | median height ratio |
|---|---|---|---|---|---|---|
| Tesseract (app path) | 10 | 0.355 | 2/10 | 9/10 | 78.4 px | 1.02× |
| **PaddleOCR PP-OCRv6** | 10 | **0.845** | **10/10** | 10/10 | **1.9 px** | 1.12× |

The two tables are near mirror images, and that is the whole finding.

**PaddleOCR is not inaccurate. It is reporting a different unit.** At its own
granularity it is excellent — 10/10 lines over 0.5 IoU, a median centre error of
**1.9 px** on a 1024×1536 image, better than Tesseract manages at line level.
At word granularity it is unusable for this app: a median centre error of
**105.6 px** and 4 of 30 words over 0.5 IoU.

This is architectural, not a wrapper defect. PP-OCR is a DB detector plus a CRNN
line recognizer: the detector emits text-*line* polygons and the recognizer
transcribes a whole line at once. There are no word boxes to expose. Recovering
them would mean splitting a line box by CTC alignment — approximate, not
exposed by `ppu-paddle-ocr`, and a research task rather than an integration one.

The engine returned **10 boxes for 30 words**, at **2.70 tokens per box**.
Tesseract returned 28 boxes at **1.00**.

**Checked before concluding, because "the engine can't do it" is the kind of
claim that is usually a missed option.** `ppu-paddle-ocr` exposes a
`recognition.strategy` of `per-line`, `per-box` or `cross-line`, and a
`spaceRecovery` flag. All three strategies return **identical** granularity on
the poster — 10 boxes, 27 tokens, 2.70 tokens per box — so `strategy` governs
how crops are batched for recognition, not what unit comes back.
`spaceRecovery` changes nothing on complexPic1 either: `BUILDINGD AREA` and
`POPSICLES& CHAWK DRAWNGS` come back identical with it on and off. There is no
word-level setting being left unused.

### Where the word boundaries physically go

`address-line-2` on complexPic1, both engines, same image:

```
ground truth   BUILDING D AREA
Tesseract      BUILDING D AREA     3 boxes  -> 3 placeable words
PaddleOCR      BUILDINGD AREA      1 box    -> 1 placeable blob
```

The lost space is not a recognition error. With one box per line, the only word
boundaries that survive are whatever the recognizer happened to emit as spaces
inside one string — and `js/editorObjects.js` has nothing to anchor a
replacement to but that single box.

### Region coverage, area by area — where it genuinely wins

`test/region-coverage.js` exists because "an average cannot see a hole".
complexPic1 cut into its nine independently-failing areas, both engines scored
by that gate's own centre-assignment rule and its own recorded ceilings:

| region | ceiling | Tesseract CER | PaddleOCR CER | T words | P boxes | verdict |
|---|---|---|---|---|---|---|
| headline | 30% | 30.0% | 30.0% | 1 | 1 | same |
| popsicles | 100% | 100.0% | 100.0% | 0 | 0 | same |
| chawk-drawings | 0% | **0.0%** | 62.5% | 3 | 1 | **PaddleOCR worse by 63pt** |
| address-line-1 | 6% | 5.3% | 5.3% | 3 | 1 | same |
| address-line-2 | 0% | **0.0%** | 6.7% | 3 | 1 | **PaddleOCR worse by 7pt** |
| teal-panel | 61% | 60.9% | **8.7%** | 2 | 4 | PaddleOCR better by 52pt |
| date-panel | 100% | 100.0% | **11.1%** | 0 | 1 | **PaddleOCR better by 89pt** |
| time-panel | 20% | 20.0% | **0.0%** | 1 | 1 | PaddleOCR better by 20pt |
| footer | 15% | 14.3% | **9.5%** | 7 | 3 | PaddleOCR better by 5pt |
| **mean** | | **36.7%** | **26.0%** | 22 | 18 | 4 better / 2 worse / 3 same |

**It fills the two holes that gate was built to catch.** `date-panel` is pinned
at 1.0 — "still not recognized at all" — and PaddleOCR reads `JULY31ST` at
11.1%. `teal-panel` goes 60.9% → 8.7%. That is a real capability Tesseract does
not have, and it is exactly the failure an average could not see.

**And it breaks two areas Tesseract gets perfect, by the mechanism above:**

```
chawk-drawings   ground truth   CHAWK DRAWINGS  (region excludes POPSICLES)
                 Tesseract      "& CHAWK DRAWINGS"        -> 0.0% CER
                 PaddleOCR      "POPSICLES& CHAWK DRAWNGS" -> 62.5% CER
```

PaddleOCR *did* read POPSICLES — the word Tesseract misses entirely, which is
why `popsicles` is pinned at 100%. But it put it in **one box with its
neighbours**, so the whole string is filed under `chawk-drawings` by that box's
centre, and `popsicles` stays empty anyway. It read more and scored worse in
both areas. Coarse boxes do not just blur placement; they misattribute text.

Two consequences worth stating plainly:

- **`test/region-coverage.js` would fail on the candidate.** Two of nine areas
  land over their recorded ceilings (Tesseract: zero of nine).
- **Unassigned boxes rise from 2 to 5** — `Q`, `:`, `2`, `A`, `9`, single-character
  junk hallucinated out of the poster's illustrations, landing outside every
  region. This is the same noise behind complexPic1's +20 WER in the text table.

### The asymmetry — yes, and it is sharper in geometry than in CER

You asked whether the geometry shows the same shape as the accuracy: wins on
hard images, losses on easy ones. It does, and more steeply. Tokens per box is
1.00 for Tesseract on every image; for PaddleOCR:

| image | kind | Paddle tokens/box | Tess boxes | Padd boxes | CER |
|---|---|---|---|---|---|
| complexPic1 | decorative poster (hard) | **1.44** | 22 | 18 | −16.0 better |
| complexPic9 | retail shelf (hard) | **1.54** | 54 | 46 | −0.8 better |
| complexPic2 | phone lock screen | 2.17 | 83 | 30 | −18.4 better |
| complexPic8 | product page (clean) | 2.39 | 109 | 44 | **+5.8 worse** |
| complexPic5 | phone screenshot (clean) | 3.73 | 115 | 33 | −5.5 better |
| complexPic4 | product page (clean) | **6.61** | 214 | 31 | **+2.6 worse** |

**complexPic4 collapses 214 word boxes into 31 line boxes — 6.61 words per
box.** It is one of the two images that regressed on CER, and it is the worst
geometry case in the corpus by a wide margin.

The mechanism is simple and it generalises: line boxes merge in proportion to
**words per line**. A poster has one or two words per line and loses almost
nothing; a dense product page has six or seven and loses almost everything. So
the coarser the text, the better this engine looks — and **dense, flat, clean
pages are what most people photograph.** The risk profile you identified in the
CER table is confirmed and amplified by the geometry.

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
- ~~No word-level geometry check.~~ **Measured 2026-09-19 — see the Geometry
  section above.** It was the deciding number and it decided against the
  candidate. What the geometry work still does *not* cover: whether per-word
  boxes could be recovered from a PP-OCR line by CTC alignment (untested, and
  the one result that would reopen the decision), and the synthetic poster is a
  clean render rather than a photograph — exact box ground truth requires that,
  but it means the word-level numbers are measured on the easiest possible
  input. The real-photo half (region coverage, tokens per box) carries no such
  caveat.
- **The detector-for-coverage idea in the recommendation is untested.** Using
  PP-OCR's detector only to locate regions Tesseract's layout analysis misses,
  with Tesseract still recognizing inside them, is suggested by these
  measurements but is not one of them.
- **Nothing was decided.** This is evidence for a decision, not the decision.

---

## The hybrid was priced, and it dies on payload

**Measured 2026-09-20, before building anything** — `node
test/research/paddle-bakeoff/detector-probe.mjs`.

The recommendation below names one idea worth taking without the engine: use
PP-OCR's DB detector **only** to find regions Tesseract's layout analysis
misses, keeping Tesseract's word boxes inside them. That idea was priced first,
because it is **additive** — the detector ships *alongside* the entire Tesseract
payload, not instead of it — so its download is pure addition.

The recognizer was stripped: no rec model, no dictionary, just the DB detection
graph and the minimum `onnxruntime-web/wasm` entry (not the default WebGPU entry
this document prices at 27 MB).

| | |
|---|---|
| `ort-wasm-simd-threaded.wasm` | **13.58 MB** |
| `PP-OCRv6_tiny_det.ort` | 1.80 MB |
| `ort.wasm.min.mjs` + glue + JS (30 files) | 0.14 MB |
| **detection only, total** | **15.52 MB** |
| Tesseract's **entire** pipeline today | **6.75 MB** |
| ratio | **2.30×** |
| hybrid total (Tesseract + detector) | **22.27 MB** |

The detector itself works: 26 boxes on complexPic1, 167 ms to create the
session, 347 ms to detect.

**STOP. Detection alone costs 2.3× the whole incumbent pipeline.**

The decisive detail is *where* the cost is. **The model is 1.80 MB — 12% of the
total. The ONNX runtime is 13.58 MB — 87%.** So this is not a "pick a smaller
model" problem, and PP-OCRv6's tiny detector is already the small one. Shipping
any ONNX graph in this app means shipping ORT's wasm core, and that core alone
is twice Tesseract's entire footprint.

**Everything downstream of this number was therefore not measured**, exactly as
scoped: no missed-region counts, no second-pass word-box check, no reverse
difference. They would have been work spent on a design already dead at the
download. That is a deliberate stop, not an omission.

### The one thing that would change this, and why it is out of scope

ONNX Runtime supports a **custom minimal build** that prunes the operator set to
whatever one model actually uses, which for a single DB detector would be a
small fraction of 13.58 MB. That is a C++/emscripten build from source, pinned
and re-run on every ORT bump. This repo has **no build step at all** and treats
that as a property worth protecting (`WEB-COMPLETION-PLAN.md` §0: *"Don't add a
bundler; the no-build-step property is worth more than the milliseconds"*). So
it is not a small follow-up — it is a different kind of project, and it should
not be started on the strength of a coverage gain measured on one poster.

**Hard limit, stated rather than worked around:** producing that build needs an
emscripten toolchain and a from-source ORT checkout. I did not build one, so the
figure a pruned runtime would reach is **unmeasured** — I can say 13.58 MB is
not the floor, and I cannot say what the floor is.

---

## Recommendation

**Do not spend the 14 photographs on this candidate.** That is a change from
what this document said before the geometry was measured, and the geometry is
what changed it.

PP-OCRv6 reads this corpus better than Tesseract — 5.2 macro CER points, 3.6
pooled, 6 of 8 images, 11.5× faster, offline, Apache-2.0/MIT, no bundler, no
COOP/COEP, no OpenCV. Every one of those still holds. **It cannot place a word.**

It returns 10 boxes for 30 words. Median per-word centre error is 105.6 px on a
1024×1536 image against Tesseract's 0.4 px, and on the densest corpus image it
collapses 214 word boxes into 31. That is not a tuning gap or a wrapper defect —
a DB detector emits line polygons and a CRNN transcribes a line at once, so
there are no word boxes to expose. `renderImageFormatView` and `js/fontMatch.js`
have nothing to anchor to, and the app's differentiator is exactly that anchor.

So the trade is not "5.2 CER points for 13 MB". It is **5.2 CER points for the
feature the app is built around**, plus 13 MB. As a *transcriber* it is better;
as *this app's engine* it is not a candidate in its current form.

Three things follow, and the third is the one worth acting on:

1. **The photographs are still the right next move — for Tesseract, not for
   this.** `HANDOFF.md` §5.2's 14 images remain the highest-value unblocked
   item. Shooting them to re-run this bake-off would answer a question whose
   answer no longer changes the decision.
2. **The cloud-tier case is not strengthened, and is slightly weakened.** A
   local engine does read this corpus's hardest images materially better, which
   is evidence the local ceiling is not where `RECOGNITION-SPIKE.md` §6 feared.
   But that engine cannot do the app's core job, so it is not an alternative to
   a cloud tier either. The honest position is unchanged from §6: the ceiling
   question is still open, and 8 scoring images still cannot close it.
3. **Two capabilities here are worth stealing without adopting the engine.**
   Both are measured above and neither needs a replacement recognizer:
   - ~~A detector used only to find regions Tesseract's layout analysis
     misses.~~ **Priced 2026-09-20 and killed: 15.52 MB for detection alone,
     2.30× Tesseract's entire pipeline, 87% of it the ONNX runtime rather than
     the model.** See the section above. The coverage gap it would have closed
     is real — `date-panel` and `teal-panel` are pinned as never recognized —
     but the mechanism for closing it has to come from somewhere that is not an
     ONNX graph.
   - Tesseract emits far more junk on the partial-GT images (166% and 143% CER
     — it writes more than exists). PaddleOCR's detector simply declines to box
     those areas. That is a *filtering* signal, not a recognition one.

### If someone wants to revisit this

The one measurement that would reopen it: whether per-word boxes can be
recovered from a PP-OCR line by CTC alignment at usable accuracy. If they can —
better than roughly 0.5 IoU against the word ground truth in this document —
every other number here is favourable and the decision flips. That is a research
spike, not an integration, and nothing in this bake-off bears on whether it
would work.

### HYPOTHESIS, not a finding: why the coverage-rescue pass may already reach those two regions

PP-OCR reads `date-panel` and `popsicles` — two of the three regions
`test/groundtruth/complexPic1.regions.json` pins at `maxCer: 1.0`, "still missed
entirely", with pins that exist to "go red the moment they start working".
Tesseract does not read them. The detector that does is dead on payload, so the
useful question is whether **Tesseract's own coverage-rescue pass** could reach
them instead. What follows is a **hypothesis from reading `js/ocrEngine.js` and
one existing measurement. It is not a finding, and it should not be acted on
without the check named below.**

**What the code does.** The rescue runs a whole-image `PSM.SPARSE_TEXT` pass and
appends only words that `novelRegions()` judges novel. `isNovel` is **per word**
and requires *both*:

```js
word.confidence >= COVERAGE_RESCUE_MIN_CONFIDENCE          // 70
&& !existingWordBoxes.some((box) =>
     overlapFraction(box, word.bbox) > COVERAGE_RESCUE_MAX_OVERLAP)  // 0.30
```

**What the existing measurement says.** `test/research/ocr-instrument.mjs`
recorded complexPic1's four `recognize()` calls:

| # | PSM | words | mean confidence |
|---|---|---|---|
| 1 | 3 (AUTO) | 20 | 80.2 |
| 2 | **11 (the rescue)** | **31** | **70.4** |
| 3–4 | 6 (one region, two candidates) | 8, 8 | 74.0, 74.1 |

The rescue pass **finds 31 words where AUTO found 20**, and the final output
carries 22 — so roughly two survived `isNovel` and about 29 were dropped. Many
of those are legitimately "already covered" by the overlap clause. But the
confidence floor is **70** and the sparse pass's own mean is **70.4**: the
threshold sits almost exactly at the middle of that pass's confidence
distribution, so about half its output is discarded on confidence alone. The
words the code's own header records as rescued — `CICHAWK` 77, `SUNNY` 96,
`DAY` 96, `5-7pM` 88 — are all comfortably above it, which is what a floor
admitting only the top half would look like.

**The hypothesis:** the sparse pass already detects text in `popsicles` and
`date-panel`, and those words are discarded by `isNovel` — most likely by the
confidence floor, and for `popsicles` possibly by the overlap clause instead,
since its line-mates `& CHAWK DRAWINGS` *were* read by AUTO and a sparse pass
that merges boxes differently could overlap them past 0.30. The overlap clause
cannot explain `date-panel`, where AUTO read nothing adjacent.

**What is NOT established:** that those words exist in the sparse output at all.
A mean of 70.4 over 31 words says nothing about which words sit where, and the
nearest available comparison actively argues against a simple story —
`time-panel` (`5-7PM`) and `date-panel` (`JULY 31ST`) are adjacent, on the same
red band, in the same white bold type, and one was rescued at 88 while the other
was not rescued at all. No environmental explanation I can construct from the
code separates them.

**The single check that confirms or kills it.** Dump the rescue pass's 31 words
with their text, confidence and bbox **before** `novelRegions()` filters them,
and look for `POPSICLES`, `JULY` and `31ST`. Three outcomes, all decisive:

| what the dump shows | conclusion |
|---|---|
| present, confidence **≥ 70** | the **overlap clause** dropped them; the floor is not the mechanism |
| present, confidence **< 70** | the **confidence floor** is the mechanism — hypothesis confirmed |
| **absent** | the rescue is not the mechanism at all; PSM 11 cannot see them either, and PP-OCR's detector finds something Tesseract's sparse mode genuinely cannot |

That is diagnostic, not tuning: it moves no threshold and changes no output.

**And tuning is the wrong move even if the check confirms it.** `complexPic1` is
the image `COVERAGE_RESCUE_MIN_CONFIDENCE = 70` was *itself* measured on — the
code's header says the thresholds were "measured on the novel words that merge
produces", on this image — and it is also the image every `maxCer` ceiling in
`complexPic1.regions.json` was measured on. Lowering 70 until `popsicles` turns
green would fit the threshold to the one image that produced both the threshold
and the target, and the gate would go green by construction. That is the same
circularity that keeps the threshold sweep unrun
([`RECOGNITION-SPIKE.md`](../../RECOGNITION-SPIKE.md) §0, `test/TUNING-2.md` §3),
and it is why **the 14 photographs are the real next step**: a floor that has to
hold on low light, steep skew and a receipt cannot be chosen on a poster.

**Ordered: take the photographs for the incumbent → leave the cloud tier where
§6 left it.** The detector-for-coverage idea was the third item here; it was
priced above and it is dead at 15.52 MB. **This spike is finished.** It produced
two durable negatives — the candidate cannot place a word, and its detector
cannot be afforded on its own — and neither needs revisiting until either a
pruned ONNX runtime exists or someone wants the CTC word-box research spike.
