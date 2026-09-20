# PaddleOCR bake-off — how to re-run it

**Branch only.** Nothing here is wired into `ci.yml`, imported by `js/`, or
reachable from the app. The shipping pipeline is untouched; this branch exists
to hold a measurement and its evidence. Results are in
[`PADDLEOCR-BAKEOFF.md`](../../../PADDLEOCR-BAKEOFF.md).

## One-time setup

`node_modules/` here is gitignored — ~430 MB of ONNX Runtime binaries for three
platforms, which is not something to commit even on a branch. The models it
scores **are** committed, under `vendor-candidate/paddle/`, because they are the
artifact being evaluated and because committing them is what proves the offline
claim: no run below makes a network request.

```sh
cd test/research/paddle-bakeoff
npm install
```

That pulls `ppu-paddle-ocr` (MIT), `onnxruntime-web` (MIT) and
`onnxruntime-node` (MIT). Versions are pinned in `package.json`.

## The four measurements

```sh
node score-paddle.mjs                  # accuracy, all 11 corpus images (node, ORT CPU)
node score-paddle.mjs --engine opencv  # the same, with the OpenCV preprocessing path
node browser-bakeoff.mjs               # payload + cold start, in real Chromium
node geometry-bakeoff.mjs              # per-word box accuracy vs exact ground truth
node region-coverage-bakeoff.mjs       # complexPic1 area by area, both engines
node detector-probe.mjs                # detection-only payload: the hybrid's price
```

`detector-probe.mjs` is the last one and it ends the spike. It strips the
recognizer and measures what a detection-only build costs in a browser:
**15.52 MB against Tesseract's entire 6.75 MB pipeline**, 87% of it the ONNX
runtime rather than the 1.80 MB model. Everything that would have followed —
missed-region counts, a second Tesseract pass inside proposed regions, the
reverse difference — was deliberately **not** measured, because the design is
dead at the download.

The last two are the ones that decided it — see PADDLEOCR-BAKEOFF.md's Geometry
section. Neither runs `test/render-fidelity.js` or `test/region-coverage.js`
against the candidate, because neither gate can be: render-fidelity is
deliberately engine-independent (it feeds *perfect* boxes to the renderer, and
its fixture half emits coordinates with no pixels), and region-coverage drives
the real app. What the two harnesses reuse is those gates' *methods* — exact
`measureText` ground-truth boxes, and region-coverage's own centre-assignment
rule and recorded ceilings. **Neither gate was modified.**

`geometry-bakeoff.mjs` drives Tesseract through the **real app flow**
(`setInputFiles` → Scan → `state.ocrWords`), not a hand-built `Image`. That is
not fussiness: `js/ocrEngine.js` chooses between handing Tesseract the original
bytes and drawing through a canvas first, and its header records the canvas path
costing 8.83 WER because `rotateAuto` derives a different deskew angle. An
earlier draft passed a `data:` URL and got 35 boxes on complexPic1 where the app
produces 22 — it was measuring the rescue path.

`score-paddle.mjs` imports `test/metrics.js` and `test/partialGroundTruth.js`
from this repo directly rather than reimplementing them, so a CER printed here
is computed by the identical function `test/run-benchmark.js` uses, over the
identical eight gated images. That is the whole point — the numbers are
comparable rather than adjacent.

`browser-bakeoff.mjs` answers what node cannot: what a browser actually pays. It
serves the runtime and models over HTTP behind an **import map** — no bundler,
matching this repo's no-build-step constraint — counts every byte fetched, and
times wasm compile, session init and first recognition separately.

## Two settings that matter, both non-obvious

- **`processing: { engine: "canvas" }`, not the default `"opencv"`.** The
  package defaults to OpenCV.js (`@techstark/opencv-js`, via `ppu-ocv`), which
  this repo has refused for good reason — see `js/preprocess.js`'s header. The
  canvas path is both better here (36.4% vs 38.4% CER) and avoids the
  dependency entirely: `ppu-ocv/canvas-web` imports no OpenCV.
- **`onnxruntime-web/wasm`, not the default entry.** The default resolves to the
  JSEP/WebGPU core at **27 MB**; the wasm-only core is **13.58 MB**. Same
  accuracy, 14 MB less. `ort.env.wasm.numThreads = 1` avoids needing
  SharedArrayBuffer, so no COOP/COEP headers are required — which matters
  because GitHub Pages cannot set them.

## One upstream bug, avoided

`model-catalogue.js`'s `V5_EN_MOBILE_MODEL` points `charactersDictionary` at
`ppocrv5_th_dict.txt` — a **Thai** dictionary for the English model. Anything
scored through that preset would be garbage for reasons that have nothing to do
with the engine. The bake-off uses `V6_TINY` (the package default), whose
dictionary is correct.
