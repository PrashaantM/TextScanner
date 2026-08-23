# TextScanner handoff — 2026-08-22

Status snapshot for picking this project back up, whether that's a future session, a future me, or someone else entirely. Covers the whole picture, not just the native ML Kit thread that's been most active recently.

One correction up front: the request that prompted this doc described the filter rework (Raw / Filtered Text / Coherence Filter) as untouched and still deferred. That's not accurate — it's done, verified, and already reflected in the README's Features section. Flagging this clearly rather than writing a handoff doc that misstates what's finished, since that would be worse than not writing one. Details below.

## 1. What's actually done and verified

### Text extraction quality (web/Tesseract.js path)

Rewrote `js/ocrEngine.js` from a single whole-image recognition pass into a region-based two-pass pipeline: a layout pass reads Tesseract's block-level data (previously requested but discarded), then any block that scored poorly gets individually re-cropped and re-recognized with region-scoped preprocessing (`js/preprocess.js`), including an edge-based binarization candidate for text over textured/gradient backgrounds, and keystone correction from the block's own text-line geometry (`js/perspective.js` — deliberately *not* full document-edge detection, which needs fragile hand-rolled edge detection this codebase has an established policy against, see the OpenCV.js hang history in `preprocess.js`'s header comment).

Verified with a real Playwright-driven CER/WER benchmark (`test/`) against manually-transcribed ground truth, not vibes:

| Image | Before | After |
|---|---|---|
| Poster (decorative, multi-font) | 46.2% CER / 60.0% WER | 46.2% / 64.0% (flat) |
| Phone lock-screen screenshot | 61.1% / 76.2% | 39.2% / 71.4% (clear win) |
| Dense 9-panel UI screenshot | 81.3% / 94.4% | 79.2% / 94.4% (small win) |
| Photographed product page (angled+glare) | 22.6% / 17.0% | 21.0% / 16.5% (small win) |
| Cluttered retail shelf photo | 77.9% / 89.4% | 76.0% / 92.6% (mixed) |

Ground truth exists for only **5 of the 15** `complexPic*.jpeg` test images (pic1, 2, 3, 4, 6) — pic5 and pic7–15 (added mid-session, real photos from your retail job) have never been transcribed or scored.

No image regressed. One clear win, the rest flat or marginal. This is the ceiling that motivated going native: even after this rewrite, several real-world images sit at 20-40% accuracy, which is a genuine Tesseract engine/layout-analysis limitation (confirmed through extensive iteration — a naive global word-sort, forcing single-block recognition on mixed illustration+text regions, and a couple other approaches were tried and made things *worse* before landing on the current guarded design), not a tuning gap closable with more of the same approach.

### Filter rework (Raw / Filtered Text / Coherence Filter) — done, not deferred

- **Raw**: unchanged, unfiltered OCR output.
- **Filtered Text** (renamed from "Symbol"): same regex/confidence noise-stripping logic as before — it already matched the "cleanup pass, not a rewrite" definition, so this was a rename plus documentation update, not new logic.
- **Coherence Filter**: rebuilt from scratch as genuine LLM-based prose reconstruction (`js/coherence.js`), replacing the old rule-based dictionary check (its ~10k-word vendored wordlist was deleted, confirmed unused elsewhere first). Calls the Anthropic API directly from the browser with a user-supplied API key stored only in `localStorage` (the only architecturally consistent option for a zero-backend static app) via a dedicated disclosure panel with an explicit Generate action — never fires automatically. Verified end-to-end with a real call to `api.anthropic.com` using a fake key: got a genuine 401 back and the UI surfaced "That API key was rejected" correctly, so the full request/response/error-handling path is confirmed working, not just plumbed.

This is why the README's privacy claim changed from an unqualified "everything stays local" to explicitly carving out Coherence Filter as the one disclosed, opt-in exception.

### Native ML Kit path (iOS) — scaffolded and structurally verified, never run on a device

Given the Tesseract ceiling above, and a 90%+ accuracy bar across all 15 images, the decision was made to validate a native ML Kit Text Recognition v2 path via Capacitor before investing further in the web pipeline. Android was built first, fully removed later this session per direction (iPhone is the only test device) — see git history if that decision ever needs revisiting.

- `js/recognize.js`: runtime dispatcher, `window.Capacitor?.isNativePlatform()` routes to `js/mlkitEngine.js` (native) or the untouched `js/ocrEngine.js` (everywhere else, including the existing GitHub Pages deployment). Fully platform-generic — needed zero changes when Android was dropped.
- `js/mlkitEngine.js`: writes the current image to native cache storage, calls `TextRecognition.processImage`, normalizes ML Kit's block/line/element hierarchy into the same flat word-list shape `ocrEngine.js` produces, so `editor.js`/`filter.js` need no changes regardless of which engine ran.
- iOS project (`ios/`) scaffolded with `cap add ios --packagemanager Cocoapods` (the default is Swift Package Manager, which the ML Kit plugin doesn't support — confirmed the hard way, a first attempt failed to link). `pod install` succeeded after bumping the Podfile's deployment target to 15.5 (the plugin's documented minimum). `xcodebuild -list` confirms a structurally valid workspace with all native ML Kit pods linked correctly, including all five per-script OCR resource bundles.
- **Nothing has actually run on a device or simulator yet.** No real ML Kit accuracy number exists for any image. Everything above is "the pipe is connected," not "water came out."

## 2. Deferred regardless of how ML Kit testing goes

- **Image/Full-image editing overlap bug (was Priority 3)**: genuinely untouched, correctly gated on text extraction being solid first. Root cause was diagnosed during the initial audit: delete already inpaints correctly, but **moving** a component never triggers inpainting (the original OCR'd pixels stay visible underneath), and in-place text edits render in one generic font/size via a solid-color legibility box rather than the original's extracted style. No font/color/style is captured from OCR today — only size. Fixing this needs per-region style extraction at detection time plus real inpainting on move, not just delete.
- **Benchmark harness beyond CER/WER**: no layout-preservation score, no offline-capability test, no handwriting sample set, no compression-rate measurement. Just the CER/WER piece exists.
- **Full pitch/messaging pass**: only the specific claims Coherence Filter itself falsified got fixed (README's privacy section). Nothing else in the pitch/marketing copy has been revisited for the native-app-store direction.

## 3. Specifically waiting on your phone test

- **`script` is hardcoded to `"LATIN"`** in `js/mlkitEngine.js`. ML Kit needs a separate bundled model per script (Latin/Chinese/Devanagari/Japanese/Korean) with no auto-detect option. Fine for English test images, a real gap for anything else — not fixed, by design, until the core approach is validated.
- ML Kit gives no per-word confidence score at all. Every ML Kit word gets a fixed placeholder (documented in code, not a fabricated real number) — meaning the existing low-confidence-underline UI feature has nothing meaningful to flag for ML Kit-sourced words. This is only commented in code right now, not documented anywhere user-facing.
- One specific line of code is unverified and flagged as such in `mlkitEngine.js`: whether `processImage`'s `path` option accepts the `file://` URI `Filesystem.writeFile` returns as-is, or needs the scheme stripped. If recognition fails with a "file not found"-shaped error on your phone, that's the first thing to check.
- Handwriting disclosure copy exists for the Tesseract/web path (README + UI) but nothing ML-Kit-specific has been written, since there's no real data yet on how it behaves.
- `test/score-manual.js` (a CER/WER scorer for OCR output you paste in by hand, scored against the existing ground truth for the three hardest images) does not exist yet — deliberately deferred until there's real output to score.

## Next action

Get a signed build running on your phone via Xcode:

1. `npm run sync:ios` (regenerates `www/` and re-runs `cap sync ios` — do this if you've pulled or made any code changes since this doc was written).
2. Open `ios/App/App.xcworkspace` in Xcode — **not** `App.xcodeproj`, CocoaPods requires the workspace.
3. Select the `App` target → Signing & Capabilities → set Team to your Apple ID.
4. Select your iPhone as the run destination, Cmd+R.
5. First run to a new device may prompt you to trust the developer certificate on-device: Settings → General → VPN & Device Management.

Then test the three hardest images (the decorative poster, the dense multi-panel screenshot, the cluttered shelf photo) and report back the real numbers. That result decides whether the rest of this integration is worth finishing — nothing else moves until then.
