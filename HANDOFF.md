# TextScanner handoff — 2026-08-27 (Phase 1 complete)

Supersedes the earlier 2026-08-27 handoff written mid-session, before the on-device run actually succeeded. Sections 1-2 below are stable background, Section 3 restates the full agreed phase plan (previously only in a local Claude Code plan file, not the repo), and Section 4 has the real Phase 1 results — that's where a new session should start.

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

This is a **word-positioning bug**, not a text-recognition-accuracy problem — the underlying Raw text for those same images (1, 2, 6, 7) actually scored fine-to-good above. The words are being recognized; they're landing in the wrong place when overlaid on the image.

**Leading hypothesis, not yet confirmed** — checked the code, not guessing: `js/ocrEngine.js` (Tesseract path) always runs every bbox through `buildBboxMapper`/`transformBboxCorners` (`ocrEngine.js:96-131`) to map from recognition-time coordinate space back to the original image's pixel space, undoing rotation and scale. `js/mlkitEngine.js`'s `flattenBlocks` (`mlkitEngine.js:64-87`) does **no such correction at all** — it takes ML Kit's `boundingBox.left/top/right/bottom` and uses them completely as-is. If ML Kit's bounding boxes come back in a coordinate space that doesn't exactly match `previewImg.naturalWidth/naturalHeight` (which is what `editor.js`'s `renderImageFormatView` positions words against, as a percentage), every word lands in the wrong spot.

What doesn't explain it: checked EXIF orientation on the "gibberish" images (1, 2, 6, 7) vs. the "good" ones (4, 5, 8, 10) via `sips` — none of the 11 source JPEGs carry EXIF orientation metadata, and complexPic4/complexPic6 have identical pixel dimensions (1536×2048) despite landing in opposite buckets. So it's not a simple orientation or aspect-ratio correlation — the actual cause needs real on-device debugging (log ML Kit's raw `boundingBox` values next to what `renderImageFormatView` actually draws, for one "gibberish" and one "good" image, and diff them).

### New bug: pinch-to-zoom doesn't work on-device

Reported today, not yet investigated. No code changes made — this needs its own look next session (likely something in `editor.js`'s touch/gesture handling never got a native-equivalent path, or a native gesture recognizer is intercepting it before the web layer sees it — pure speculation, not checked yet).

## Next action

In priority order — the rendering bug likely blocks shipping ML Kit at all regardless of how the CER/WER debate resolves, so it comes first:

1. **Diagnose the Image format/Full image positioning bug.** Start by comparing `mlkitEngine.js`'s lack of bbox correction against `ocrEngine.js`'s `buildBboxMapper` pattern (see above) — instrument `flattenBlocks` to log raw `boundingBox` values on-device for complexPic1 (bad) and complexPic5 (good) and see whether the coordinates make sense against the actual image dimensions.
2. **Fix pinch-to-zoom.**
3. **Revisit the Phase 2 engine decision** with the table above once (1) is understood — a fixed positioning bug might change how much the CER/WER gap actually matters, since Image format/Full image are core to this app's whole "edit the image" pitch, not just Text view.
4. Everything else from Phase 3/4 (App Store readiness, training-data sourcing) stays deferred until 1-3 land.
