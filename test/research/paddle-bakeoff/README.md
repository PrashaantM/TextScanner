# PaddleOCR bake-off — how to re-run it

**Research only.** Nothing here is wired into `ci.yml`, imported by `js/`, or
reachable from the app, and no gate was modified to produce any of it. Results
are in [`paddleocr-bakeoff.md`](paddleocr-bakeoff.md).

## Where things are, and what a `main` checkout can and cannot do

| | |
|---|---|
| The write-up and these harnesses | on **`main`**, in this directory |
| The PP-OCRv6 ONNX models (~6 MB) | **only** on branch `spike/paddleocr-bakeoff`, commit **`5855505`**, under `vendor-candidate/paddle/models/` |
| `node_modules/` (~430 MB) | gitignored everywhere; installed per checkout |

**A plain `main` checkout cannot run any of these scripts.** The models are not
on `main` and should not be — this is a rejected candidate, and `main` carries
the finding, not the engine. The scripts are here so the method can be read
next to the claim, which is what `test/research/` is for.

## The exact sequence to re-run

Pinned by SHA rather than branch name: a branch ref moves or gets deleted, a
commit does not.

```sh
# 1. Get the commit that carries the models. The branch tip is 5855505 today;
#    the SHA is what matters if it ever moves.
git fetch origin spike/paddleocr-bakeoff
git worktree add /tmp/bakeoff 5855505        # or: git checkout 5855505

# 2. Install the harness dependencies. package.json lives in this directory
#    ON THAT COMMIT, not at the repo root.
cd /tmp/bakeoff/test/research/paddle-bakeoff
npm install                                   # ppu-paddle-ocr, onnxruntime-web,
                                              # onnxruntime-node - all MIT, pinned

# 3. Point playwright-core at the browser this repo already has.
#    REQUIRED, and the one step that is easy to miss: package.json asks for
#    playwright-core ^1.62.1, and npm will happily resolve a NEWER one whose
#    browser revision is not installed, which fails at launch with
#    "Executable doesn't exist at .../chromium_headless_shell-<rev>".
#    The repo's own test/node_modules has the pinned 1.62.1 with its browser.
rm -rf node_modules/playwright-core
ln -s "$(git rev-parse --show-toplevel)/test/node_modules/playwright-core" \
      node_modules/playwright-core

# 4. Run any of the five. Models resolve from vendor-candidate/paddle/models
#    on local disk - no run makes a network request.
node score-paddle.mjs
```

Only the browser harnesses (`browser-bakeoff.mjs`, `geometry-bakeoff.mjs`,
`region-coverage-bakeoff.mjs`, `detector-probe.mjs`) need step 3;
`score-paddle.mjs` runs on `onnxruntime-node` and does not launch a browser.

`geometry-bakeoff.mjs` and `region-coverage-bakeoff.mjs` also drive the **real
app** through Playwright to get Tesseract's side, so they need the repo checkout
they are sitting in — another reason to use a worktree of `5855505` rather than
copying the scripts somewhere.

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

The last two are the ones that decided it — see [`paddleocr-bakeoff.md`](paddleocr-bakeoff.md)'s Geometry
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
