# Vendored Tesseract.js

Everything TextScanner's web/OCR path needs at runtime, served from this origin
instead of a CDN. Pinned to **tesseract.js 5.1.1** and **tesseract.js-core
5.1.1** — the exact versions the app previously loaded from jsDelivr, so this
was a hosting change, not a version bump.

## Why this is vendored rather than loaded from a CDN

Four separate problems, one fix:

1. **No Subresource Integrity was possible.** The `<script>` tag could have taken
   an `integrity` hash, but the worker, the wasm core and the language data are
   fetched by the library itself at scan time — there is no markup to hang a
   hash off. A compromised CDN response ran with full page privileges and could
   read the scanned image, the recognized text, and the Anthropic API key in
   `localStorage`.
2. **The shipped iOS app phoned a CDN.** `scripts/sync-web-assets.sh` copies
   `index.html` verbatim into the native bundle, so the App Store build fetched
   third-party script on launch — inside a WKWebView that has been granted
   camera and photo-library access — for an engine it never even uses (native
   recognition is ML Kit).
3. **"Runs entirely offline" wasn't true.** The first scan on any device needed
   a network round trip.
4. **A CSP couldn't be tightened.** With this gone, `script-src` is `'self'` and
   no third-party host appears anywhere in the policy.

## What's here

| File | Fetched as | Notes |
|---|---|---|
| `tesseract.min.js` | `<script>` in `index.html` | Exposes the `Tesseract` global. |
| `worker.min.js` | `workerPath` | tesseract.js fetches this and wraps it in a Blob worker, which is why the CSP needs `worker-src blob:`. |
| `core/tesseract-core-simd-lstm.wasm.js` | `corePath` + a name the worker picks | The build actually used on any browser with wasm SIMD. |
| `core/tesseract-core-lstm.wasm.js` | `corePath` + a name the worker picks | Non-SIMD fallback. |
| `tessdata/eng.traineddata.gz` | `langPath` + `eng.traineddata.gz` | From `@tesseract.js-data/eng/4.0.0_best_int`. |

The three paths are set in `tesseractAssetPaths()` in
[`js/ocrEngine.js`](../../js/ocrEngine.js).

## How the file list was determined

Not from documentation, and not guessed: a full scan was run against
`test/images/complexPic5.jpeg` with request logging on, and these are the four
URLs it actually hit.

```
https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
https://cdn.jsdelivr.net/npm/tesseract.js@v5.1.1/dist/worker.min.js
https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/tesseract-core-simd-lstm.wasm.js
https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
```

Worth noting, because the earlier analysis assumed otherwise:
`tessdata.projectnaptha.com` is **not** used by tesseract.js 5.x at all. Language
data comes from `@tesseract.js-data` on jsDelivr. A CSP written to allow the
projectnaptha host would have allowed a host the app never contacts while still
blocking the one it does.

## What's deliberately *not* here

The two **legacy (non-LSTM) core builds**, `tesseract-core.wasm.js` and
`tesseract-core-simd.wasm.js` (~4.5 MB each). `js/ocrEngine.js` creates its
worker with `oem` 1 (LSTM only), and the worker only ever requests an `-lstm`
build under that setting. If the OEM ever changes, add them here from
`tesseract.js-core@5.1.1` and nothing else needs to change.

The raw `.wasm` files and their small JS loaders are also omitted: the
`.wasm.js` builds vendored here are the single-file variants, with the module
embedded, which is what tesseract.js requests.

## Size

~11 MB total, dominated by the two core builds (3.8 MB each) and the language
data (2.9 MB). That is the deliberate trade: repository size in exchange for
removing an entire class of supply-chain risk and making the offline claim true.

## Updating

1. `npm pack tesseract.js@<version>` and `npm pack tesseract.js-core@<version>`,
   then copy the files listed above out of each tarball.
2. Re-download `eng.traineddata.gz` from the matching `@tesseract.js-data/eng`
   path.
3. Re-run a scan with request logging and confirm the external request list is
   empty — filenames and default paths have changed between tesseract.js majors
   before.
