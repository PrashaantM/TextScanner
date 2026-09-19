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

## Before you bump the version — read this

Three standing findings. Two are from the 2026-09-18 recognition spike
([`RECOGNITION-SPIKE.md`](../../RECOGNITION-SPIKE.md) §5 and §7); the third is
about the service worker. All are here rather than in their own reports because
this file is what someone about to change the pinned version actually opens.

### A bump MUST also bump `SW_VERSION` in `sw.js`

`sw.js` caches the recognition payload — `worker.min.js`, one core `.wasm.js` and
`eng.traineddata.gz` — **cache-first**, because it is 6.7 MB and revalidating
that on every scan would be hostile. The consequence is the one thing that can go
wrong here: if you bump the version and the new bytes land under the **same
filenames**, every client that already cached the old core keeps serving it
**forever**. The app would report the new version while recognizing with the old
engine, on exactly the users who had used it most.

So a version bump is two edits, not one:

1. the files in this directory, and
2. `SW_VERSION` in [`sw.js`](../../sw.js), which renames the caches and makes
   `activate` drop the old ones.

**This is gated, not trusted.** `sw.js` declares
`VENDORED_TESSERACT_VERSION` and `test/repo-contract.js` (CHECK 5) reads the real
version out of `tesseract.min.js`'s own bytes and fails if the two disagree — so
a bump cannot land without editing `sw.js`, which is where `SW_VERSION` lives.
The gate exists because this note on its own would not be enough: the pointer
used to run one way (`sw.js` pointed at this section, and this section did not
mention `SW_VERSION`), so the bumper was never told.

### A 5.x → 6.x bump can silently cost 3.6 CER points

tesseract.js 6.0.0's release notes say `blocks` was restructured so that **only
text-based blocks are reported**.

`js/ocrEngine.js`'s coverage-rescue pass is triggered by
`hasUnreachableStructure` — regions where layout analysis produced a block but
word recognition produced **zero words**. A zero-word block is exactly a block
that is not text-based. If v6 stops reporting those, the trigger never fires and
the rescue pass silently stops running.

That pass is measured at **+3.6 CER points on the gated eight**, helping six of
eight images and hurting none (`RECOGNITION-SPIKE.md` §4.3) — the largest single
accuracy effect in this pipeline's recorded history. `run-benchmark.js`'s
tolerance is 2 points, so this *would* go red — but only if someone runs it, and
the failure would look like a version-bump regression with no obvious cause.

**Before bumping: check whether `extractRegions` still sees zero-word blocks.**
`node test/research/ocr-instrument.mjs complexPic6` prints the per-call PSM
histogram; the rescue pass is the whole-image `psm 11` call, third in the list.
If it disappears, the trigger is gone.

v6's other changes (memory-leak fixes, lower runtime and memory) are real, and
**none of them is an accuracy improvement** — the notes describe performance and
resource usage only. There is no accuracy reason to bump.

### `oem 3` / `oem 0` cannot be measured against what is vendored here

The legacy engine modes need a non-LSTM core **and** legacy-capable traineddata.
Neither is in the tree: the two cores here are both `-lstm` builds, and
`eng.traineddata.gz` is `4.0.0_best_int`, which is LSTM data. So the LSTM-only
vs combined comparison is **unmeasured**, not measured-and-rejected —
`test/research/ocr-sweep.mjs` lists the variant and skips it out loud rather
than omitting it.

Measuring it means fetching a legacy core and legacy traineddata from a CDN,
which this directory exists to avoid. Expected impact is low (LSTM beats legacy
on everything except very clean, small, single-font text, which is not what this
corpus holds), but that is an expectation and not a measurement. If anyone does
add the legacy cores, the note above about `oem` 1 applies in reverse.

## Size

~11 MB total, dominated by the two core builds (3.8 MB each) and the language
data (2.9 MB). That is the deliberate trade: repository size in exchange for
removing an entire class of supply-chain risk and making *recognition* need no
network at all.

Worth stating precisely, because the wider claim does not follow from this:
vendoring makes the **scan** offline-capable on its own, not the **app**. Since
`1bbc46e` there IS a service worker ([`sw.js`](../../sw.js)), so opening
TextScanner with no connection does work — but that is the worker's doing, not
vendoring's. The division of labour: vendoring is why recognition needs no
third-party host, and the worker is why the page itself loads offline. The
payload here is cached on the **first successful scan** rather than up front,
precisely so a first visit does not pay 11 MB, which is why the first scan still
needs the network and every one after it does not. See
`WEB-COMPLETION-PLAN.md` §W1.

## Updating

1. `npm pack tesseract.js@<version>` and `npm pack tesseract.js-core@<version>`,
   then copy the files listed above out of each tarball.
2. Re-download `eng.traineddata.gz` from the matching `@tesseract.js-data/eng`
   path.
3. Re-run a scan with request logging and confirm the external request list is
   empty — filenames and default paths have changed between tesseract.js majors
   before.
4. Bump `SW_VERSION` **and** `VENDORED_TESSERACT_VERSION` in
   [`sw.js`](../../sw.js), in the same commit. `test/repo-contract.js` CHECK 5
   fails until the second one matches the bytes you just copied in; the first is
   what actually evicts the stale core from clients. See the section above.
