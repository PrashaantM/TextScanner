# TextScanner handoff — 2026-08-27 (Phase 1 complete)

Supersedes the earlier 2026-08-27 handoff written mid-session, before the on-device run actually succeeded. Sections 1-2 are stable background, Section 3 restates the full agreed phase plan (previously only in a local Claude Code plan file, not the repo), and Section 4 has the real Phase 1 results. Sections 5-7 were added by a later same-day session that took the positioning bug apart offline and fixed pinch-to-zoom — **a new session should start at Section 5 and Next action.**

## 1. Stable background (unchanged from earlier handoffs)

- Text extraction quality (web/Tesseract.js path), the filter rework (Raw/Filtered Text/Coherence Filter), and the repository cleanup pass are all done and verified — see git log (`Repository cleanup:...`, `README: explain how this differs from...`) if the detail is ever needed.
- **Move/inpaint bug (Priority 3)**: still genuinely untouched. Delete inpaints correctly; moving a component still doesn't clean up its old spot (original pixels stay visible underneath); in-place edits still render in one generic font/size via a solid-color legibility box, no font/color/style captured from OCR.
- **ML Kit's `script` hardcoded to `"LATIN"`**: fine for the English test images, a real gap for anything else — not fixed by design until the core approach is validated.
- **ML Kit gives no per-word confidence score**: every ML Kit word gets a fixed placeholder; the low-confidence-underline UI has nothing meaningful to flag for ML-Kit-sourced words.
- **Local dev environment**: single canonical clone at `~/TextScanner`, fully set up (Pods, node_modules, iOS signing). Open via Xcode's File → Open on `ios/App/App.xcworkspace`, never Source Control → Clone (that creates a new, un-set-up duplicate elsewhere — happened twice this week, both deleted).

## 2. Test image scope change

**complexPic12-15 are out of the active test set** — removed at your direction ("testing focuses on 1-11"). `test/groundtruth/complexPic12-15.txt` deleted so `test/run-benchmark.js` and `test/score-manual.js` naturally operate on 11 images now. The source JPEGs are still in `legacy-opencv-scripts/` (untouched — only the ground truth/test-scope was trimmed, not the files themselves), but they're not part of the MVP measurement going forward unless you decide otherwise.

## 3. The MVP process (phase plan, agreed and still active)

This was worked out in a planning session and hadn't been written into the repo itself until now — it lived only in a local Claude Code plan file outside version control. Restating it here so a fresh session has the whole picture without depending on that.

- **Phase 0 — close the measurement gap**: done. Ground truth for the full (now 11-image) test set, a real Tesseract baseline, `test/score-manual.js` built.
- **Phase 1 — on-device ML Kit checkpoint**: done, see Section 4 below. Real CER/WER numbers now exist for all 11 images.
- **Phase 2 — decision gate**: **not yet resolved.** Originally proposed bar: <10% CER on clean/screenshot-style images, <20% CER on cluttered/decorative real-world photos. Planned outcomes:
  - ML Kit clears the bar on most/all images → it becomes the shipping engine (Tesseract stays only as the existing web/GitHub Pages fallback, `js/recognize.js` already dispatches cleanly).
  - ML Kit falls short on the same hard categories Tesseract already struggles on → evaluate Apple's Vision framework (`VNRecognizeTextRequest`) next, before more Tesseract tuning.
  - Both fall short on the hardest images → those become the explicit target for Phase 5's training-data work (Tesseract only — ML Kit's model can't be retrained inside a Capacitor plugin).
  - **Where things actually stand**: the real data in Section 4 doesn't cleanly match any of these three outcomes — genuinely mixed, and now entangled with the Image format/Full image rendering bug below. This gate is not resolved; see Next action.
- **Phase 3 — close remaining gaps** on whichever engine wins Phase 2. Not started.
- **Phase 4 — App Store readiness** (doesn't block Phases 1-3): the move/inpaint bug (Section 1), offline asset bundling for whichever engine ships, an Apple privacy manifest if ML Kit/Firebase ships, app icon/screenshots/TestFlight build. Not started.
- **Phase 5 — training-data sourcing**: explicitly deferred, and only relevant if Tesseract is still in the mix after Phase 2 resolves (ML Kit's model isn't retrainable). Not started.

## 4. Phase 1 result: real ML Kit numbers exist (2026-08-27 device run)

Two blocking issues were hit and fixed before this run succeeded: a stale-clone Pods issue (resolved by the clone consolidation) and a hard crash on camera access (missing `NSCameraUsageDescription`/`NSPhotoLibraryUsageDescription` in `Info.plist`, fixed and pushed). **The device run itself then completed clean — no crash, all 11 images scanned.**

### CER/WER: ML Kit vs. the Tesseract baseline (Raw view, both engines)

| Image | Tesseract CER | ML Kit CER | Tesseract WER | ML Kit WER | Winner |
|---|---|---|---|---|---|
| complexPic1 (decorative poster) | 46.2% | **4.5%** | 64.0% | 20.0% | ML Kit, big |
| complexPic2 (phone lock screen) | 39.2% | **21.9%** | 71.4% | 36.5% | ML Kit |
| complexPic3 (dense UI mockup, longest text) | 79.2% | **55.4%** | 94.4% | 77.0% | ML Kit |
| complexPic4 (product page screenshot) | **21.0%** | 24.3% | **16.5%** | 17.0% | Tesseract |
| complexPic5 (product page screenshot) | **7.8%** | 11.2% | **17.9%** | 17.9% | Tesseract |
| complexPic6 (retail shelf, headsets) | 76.0% | **56.8%** | 92.6% | 78.2% | ML Kit |
| complexPic7 (Xbox shelf tag, partial GT) | 86.1% | **56.2%** | 98.3% | 89.8% | ML Kit |
| complexPic8 (mobile flyer photo) | 34.3% | **30.2%** | 40.6% | 39.6% | ML Kit |
| complexPic9 (POS terminal screen) | **57.7%** | 73.7% | **65.3%** | 106.7% | Tesseract |
| complexPic10 (repeated TV boxes, partial GT) | 381.1% | **44.0%** | 651.4% | 65.7% | ML Kit, huge |
| complexPic11 (cluttered store aisle, partial GT) | **132.3%** | 158.5% | **323.1%** | 187.2% | Tesseract |

**ML Kit average CER: 48.8%. Tesseract average CER on the same 11: ~87.4%.** ML Kit wins 7 of 11 images, sometimes dramatically (1, 3, 6, 7, 10) — but this is a genuinely mixed result, not a clean sweep:
- It **loses** to Tesseract on 4 images, including complexPic11 — the cluttered retail photo, exactly the category ML Kit was expected to dominate.
- Against the Phase 2 proposed bar (<10% CER clean/screenshot, <20% CER cluttered) — **only complexPic1 clearly clears its bar.** Nothing clears the cluttered-photo bar on either engine. complexPic5 is closest (Tesseract 7.8%, ML Kit 11.2%) but that's the easy case.
- complexPic7/10/11 have partial ground truth (illegible fine print deliberately omitted, not guessed) — read those three numbers as directional, not exact.

**Qualitative note on complexPic9** (from your testing): ML Kit recognized roughly 40% of the text correctly but **failed to recognize "Best Buy" even though it's the largest text in the center of the image** — a notable miss on ML Kit's part independent of the aggregate CER number.

**The Phase 2 engine decision is not made yet** — the data above is mixed enough that it's a real judgment call, not an obvious pick, and it's now entangled with a separate, more serious problem below.

### New, likely more urgent finding: Image format / Full image modes are broken on the ML Kit path

Your per-image notes on Image format / Full image (not measured by CER/WER, since that only scores the Text view):
- **complexPic1, 2, 6, 7: "gibberish... 0% accuracy... completely useless."** (complexPic7: only the word "XBOX" landed in a recognizable, correct position.)
- complexPic3: "look okay."
- complexPic4, 5, 8: "really good."
- complexPic9: "recognize about 40% of the text correctly but fail to recognize 'Best Buy'... some other text is only partially recognized."
- complexPic10: "good." complexPic11: "okay."

This was read at the time as a **word-positioning bug** rather than a recognition-accuracy one, since the underlying Raw text for those same images (1, 2, 6, 7) scored fine-to-good above. That is still the most likely reading, but Section 5 shows it is not yet established — "correctly positioned but flooded with unreadable fine print" fits the same reports, and the two are told apart by the instrumented run described there.

### New bug: pinch-to-zoom doesn't work on-device

Reported 2026-08-27. **Now root-caused and fixed — see Section 6.**

## 5. Positioning bug: what the 2026-08-27 follow-up session established

Three hypotheses were tested offline. **The renderer is exonerated; two of the leads in Section 4 are dead; the remaining work needs one instrumented device run, which is now fully prepared.**

### Ruled OUT: `renderImageFormatView` mangling large text

`test/render-fidelity.js` (new) isolates the renderer from the engine entirely. It draws a poster-shaped synthetic image, measures each word's **exact** ink box with `ctx.measureText`'s `actualBoundingBox*` metrics, feeds those perfect boxes straight into `editor.js`'s `renderImageFormatView`, and screenshots the result. Run in two font variants: the same system stack `.image-format-word` renders in, and a heavy condensed display face (to mimic real poster art).

**Result: given correct boxes, the rendered layout is clean and readable — headline text included.** Position drift is ~1px, and the only visible artifact is wider inter-word gaps when the source art uses a condensed face (the renderer's one-generic-font assumption; cosmetic, nothing like "gibberish"). Screenshots in `test/manual-output/fidelity-*.png`.

So the "big display text overflows/overlaps and turns to soup" theory is dead, and the coordinates reaching the renderer really are wrong.

### Ruled OUT: rotation, and any single fixed coordinate transform

- **Not rotation / axis-aligned-box inflation.** ML Kit's `element.frame` is the axis-aligned rect of a possibly-rotated text quad, which would inflate boxes for angled text — but complexPic1 (poster) and complexPic2 (lock screen) were opened and inspected, and both are **perfectly axis-aligned flat art**, yet both are in the "gibberish" bucket. Angle can't be the cause.
- **Not a uniform coordinate-space mismatch either** — which is what Section 4's `buildBboxMapper` hypothesis amounted to. A fixed wrong transform would break *every* image equally, but complexPic4/5/8/10 render "really good", so ML Kit's coordinates are in the right space at least some of the time. Section 4's own dimension pairs say the same: 946×2048 (pic2 bad, pic5 good) and 1536×2048 (pic4 good, pic6 bad).

Whatever this is, it is **content-dependent, not a fixed transform** — so it can't be fixed by copying `ocrEngine.js`'s mapper across, and it can't be settled without the real numbers.

### Also confirmed from the plugin source (not guessed)

`node_modules/@capacitor-mlkit/text-recognition/ios/Plugin/`: `TextRecognition.swift` loads the image with `UIImage(contentsOfFile:)` and sets `visionImage.orientation = image.imageOrientation`; `ProcessImageResult.swift` returns, for blocks/lines/**elements alike**, both `boundingBox` (the axis-aligned rect, which `flattenBlocks` uses) and `cornerPoints` (the rotated quad, which it **ignores**). That Swift is fully deterministic and image-independent — nothing in it can explain a per-image split, which is further evidence the difference is in ML Kit's own output.

### Still open, and what the dump will distinguish

Two readings remain, and the user's own complexPic7 note ("only the word XBOX landed in a recognizable, correct position") is consistent with **both**:
1. ML Kit's boxes are genuinely misplaced on those images.
2. The boxes are fine, but ML Kit — far more aggressive than Tesseract — detects a mass of tiny incidental fine print (barcodes, shelf labels, background packaging), so Image format is *correctly* positioned yet flooded with unreadable junk.

These look completely different in an overlay, so one device run settles it.

### Instrumentation, ready to run (one device round trip)

- **`js/mlkitDebug.js`** (new, diagnostic-only, **changes no app behaviour**): records ML Kit's raw result verbatim per scan — `boundingBox` *and* `cornerPoints`, blocks/lines/elements — plus `naturalWidth/naturalHeight` and a pre-computed `extent` (the union of all element boxes, which makes a scale mismatch readable at a glance). Wired into `mlkitEngine.js` right after `processImage`, inside its own try/catch so diagnostics can never fail a scan. Accumulates across scans, so **all 11 images can be captured in one pass**.
  - Retrieve it either way: Safari → Develop → *device* → TextScanner → console → `copy(JSON.stringify(window.__textscannerDebug))`; or Xcode → Devices and Simulators → Download Container → `AppData/Documents/textscanner-mlkit-debug.json`.
- **`test/replay-dump.js`** (new): replays that dump through the real renderer offline. Per scan it renders **raw** (today's `boundingBox`), **corner** (`cornerPoints` instead — answers "would that have fixed it?" with no second device run), and **fitted** (boxes rescaled to fill the image — what a pure scale bug would need), each both as the Image format view *and* as an **overlay on the source photo with the words forced visible**, which is the view that actually shows whether a word sits over the text it was read from. Plus a summary table of word counts, box extents and fit scales.
  - `node test/replay-dump.js <dump.json>`
  - Both tools were smoke-tested end to end against a synthetic dump whose boxes were deliberately halved; the overlay reproduced the exact "gibberish" signature (all words crammed into the top-left corner), so the kit is known to work before the real data arrives.

## 6. Pinch-to-zoom: root-caused and fixed (no device debugging needed)

Not speculation — traced through the installed Capacitor iOS source. `CAPInstanceDescriptor.m:40` defaults `_zoomingEnabled = NO`. `CAPBridgeViewController.swift:322` then does `if !configuration.zoomingEnabled { aWebView.scrollView.delegate = delegationHandler }`, and `WebViewDelegationHandler.swift:337-340`'s `scrollViewWillBeginZooming` **actively disables the pinch gesture recognizer**. `capacitor.config.json` never set `zoomEnabled`, so pinch was switched off by Capacitor's default — nothing to do with `editor.js`'s touch handling, and the page's viewport meta (`width=device-width, initial-scale=1.0`, no `user-scalable=no`) already permits zooming.

**Fixed**: `capacitor.config.json` now sets `ios.zoomEnabled: true`. Needs `npm run sync:ios` and a rebuild to take effect, and wants a quick check that two-finger pinch doesn't fight the Full-image editor's drag/resize gestures (single-finger, so it shouldn't).

## 7. Regression check

The web/Tesseract path was smoke-tested after these changes (headless Chromium, full sample-image scan): modules load, the debug stash initialises, OCR returns correct text, **zero console errors**. `js/mlkitDebug.js` is imported on the web path too but only ever *called* from the native path.

## Next action

1. **Run the instrumented build on-device** (`npm run sync:ios`, rebuild, scan complexPic1-11 in one session), retrieve `textscanner-mlkit-debug.json` by either route in Section 5, and run `node test/replay-dump.js <dump.json>`. That single run also verifies the pinch-to-zoom fix. Everything needed to diagnose the positioning bug offline is already built and smoke-tested — this is the only step that requires the device.
2. **Read the replay output** — the overlay PNGs distinguish "boxes misplaced" from "boxes fine, flooded with fine print" immediately, and the `corner`/`fitted` variants say whether `cornerPoints` or a scale correction is the fix. Then change `flattenBlocks` accordingly.
3. **Revisit the Phase 2 engine decision** with the Section 4 table once (2) lands — a fixed positioning bug might change how much the CER/WER gap actually matters, since Image format/Full image are core to this app's whole "edit the image" pitch, not just Text view.
4. **Delete the diagnostic scaffolding** once the bug is understood: `js/mlkitDebug.js`, its import in `mlkitEngine.js`, and `test/replay-dump.js`. (`test/render-fidelity.js` is worth keeping — it's a real regression test for the renderer.)
5. Everything else from Phase 3/4 (App Store readiness, training-data sourcing) stays deferred until 1-3 land.
