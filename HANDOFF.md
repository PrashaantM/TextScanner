# TextScanner handoff — 2026-08-27

Supersedes the 2026-08-22 handoff. That doc's Section 1 (text extraction quality, filter rework, native ML Kit scaffolding) is still accurate background — this doc covers what's changed since, and narrows the "next action" down to exactly where things stand right now, since a device build is mid-flight.

## 1. What's done and verified since the last handoff

### MVP measurement gap closed
Ground truth previously existed for only 5 of the 15 `complexPic*` test images, so "full successful output on all 15" was never actually measurable. Fixed:
- Ground truth for the missing 10 (`complexPic5`, `7-15`) transcribed directly from the images and added to `test/groundtruth/`. `complexPic7`, `10`, and `11` are **partial/flagged** — some fine print (tiny repeated spec copy, rotated box-art background text, gift-card denominations) was genuinely illegible even on close inspection and was deliberately left out rather than guessed at. Their CER/WER numbers below should be read as a soft signal, not gospel.
- `test/score-manual.js` added: scores hand-pasted OCR output (one `.txt` per image in `test/manual-output/`, gitignored) against `test/groundtruth/` using the same CER/WER metrics as `test/run-benchmark.js`. This is the bridge for on-device testing, since nothing here can drive a physical iPhone automatically.
- `js/mlkitEngine.js`'s previously-"unverified" `file://` URI handling: traced through the actual `@capacitor/filesystem` and ML Kit plugin iOS source (not left as a guess). Confirmed correct as written — `Filesystem.writeFile` returns `url.absoluteString`, and ML Kit's `createVisionImageFromFilePath` does `URL(string: path)!.path`, which strips the scheme itself. No code change was needed.

### Repository cleanup (no behavior change — verified, not assumed)
Removed dead code (`js/textUtil.js` — fully redundant with `filter.js`'s `wordsToFilteredText(words, "raw")`; 3 unused `filter.js` exports; `dom.js`'s dead `filterToggle` binding; an empty 0-byte legacy script; an orphaned, unrelated `.github/modernize/` tooling artifact). Consolidated 3 duplicated logic patterns into shared helpers (`setActiveButton`, `hide`/`show`, `ocrEngine.js`'s `transformBboxCorners`). Named magic numbers in `editor.js`'s resize logic. Trimmed `.gitignore` from ~150 lines of irrelevant Python-framework boilerplate to ~30 relevant lines, and filled two real gaps (`.DS_Store`, `test/manual-output/`).

Verified, not just asserted: re-ran the full 15-image benchmark before/after — every score identical. Drove a real browser through mode switching, filter switching, and a resize drag — all work, zero console/page errors.

### README repositioned
Added a "Why not just use Google Lens, Adobe Scan, or Live Text?" section: per-word editable/movable/deletable text objects with real inpainting on delete, graduated Raw/Filtered/Coherence output instead of one fixed guess, visible confidence flagging, no-account/no-upload privacy. Deliberately **not** an accuracy claim — Tesseract's ceiling on hard photos is real (see baseline below) and the section says so explicitly.

While writing it, caught and fixed a stale claim already in the Features list: it said moving a word patches its old spot from the surrounding image. That hasn't been true since the move/inpaint gap below was diagnosed — only delete currently inpaints. Corrected rather than left standing next to the new, accurate section.

### Local dev environment consolidated
This machine had **three** independent git clones at various points today — `~/TextScanner` (this one), `~/Documents/TextScanner`, and `~/Desktop/TextScanner` (the latter two both accidental duplicates, one from early Xcode setup, one from using Xcode's Source Control → Clone instead of File → Open on the existing workspace). Both duplicates are deleted. `~/TextScanner` is the single canonical copy — dependencies installed, CocoaPods installed, iOS signing team configured (`DEVELOPMENT_TEAM`, ported over from the Documents clone before deleting it, since that was real local work).

**If you ever need to open this project in Xcode**: File → Open → `~/TextScanner/ios/App/App.xcworkspace`. Not Source Control → Clone (that creates a new, un-set-up duplicate elsewhere on disk).

### First real on-device run: in progress, two blocking issues hit and fixed today
1. Missing `Pods/*.xcconfig` — turned out to be the stale `~/Documents/TextScanner` duplicate clone (never had `npm install`/`pod install` run in it). Moot now that there's one clone with Pods already installed.
2. **Hard crash on tapping "Use camera"**: iOS requires `NSCameraUsageDescription` in `Info.plist` before any camera access, or it aborts the process rather than showing a permission prompt. Neither that key nor `NSPhotoLibraryUsageDescription` existed. Both added (`ios/App/App/Info.plist`) and pushed — the photo-library key added preemptively, since the plain "click to browse" file input routes through the same kind of native picker on-device and would very likely have crashed identically on the next test.

**Not yet confirmed**: a clean, crash-free scan on a real device, or any real ML Kit accuracy number. That's the very next thing to check, after a fresh Xcode build picks up the Info.plist fix.

## 2. Still true from the 2026-08-22 handoff, unchanged

- **Move/inpaint bug (Priority 3)**: genuinely untouched. Delete inpaints correctly; moving a component still doesn't clean up its old spot (original pixels stay visible underneath); in-place edits still render in one generic font/size via a solid-color legibility box, no font/color/style captured from OCR.
- **ML Kit's `script` hardcoded to `"LATIN"`**: fine for the English test images, a real gap for anything else — not fixed by design until the core approach is validated.
- **ML Kit gives no per-word confidence score**: every ML Kit word gets a fixed placeholder; the existing low-confidence-underline UI has nothing meaningful to flag for ML-Kit-sourced words.
- Handwriting disclosure copy exists for the Tesseract/web path; nothing ML-Kit-specific written yet, since there's still no real device data.

## 3. The MVP process (agreed plan, still active)

- **Phase 0 — close the measurement gap**: done, see Section 1 above.
- **Phase 1 — on-device ML Kit checkpoint**: in progress, blocked on you (I can't drive a physical iPhone). Get a clean run (camera crash just fixed, unretested), run all 15 `complexPic1-15` images through the app, paste each Raw-view output into `test/manual-output/<name>.txt`, then run `node test/score-manual.js`.
- **Phase 2 — decision gate**: compare ML Kit's real numbers against the Tesseract baseline below. Proposed bar (adjustable once real numbers exist): **<10% CER** on clean/screenshot-style images, **<20% CER** on cluttered/decorative real-world photos. If ML Kit clears it on most/all 15, it becomes the shipping engine (Tesseract stays only as the existing web/GitHub Pages fallback — `js/recognize.js` already dispatches cleanly, zero code changes needed there). If it falls short on the same hard categories Tesseract already struggles on, evaluate Apple's Vision framework (`VNRecognizeTextRequest`) next, before more Tesseract tuning.
- **Phase 3 — close remaining gaps** on whichever engine wins Phase 2.
- **Phase 4 — App Store readiness**: the move/inpaint bug above, offline asset bundling, an Apple privacy manifest if ML Kit/Firebase ships, app icon/screenshots/TestFlight — none of this blocks Phase 1-3.
- **Phase 5 — training-data sourcing**: explicitly deferred, and only relevant if Tesseract is still in the mix after Phase 2 (ML Kit's model isn't retrainable inside a Capacitor plugin, so this step doesn't apply if ML Kit wins).

## Current Tesseract/web baseline (all 15 images)

For comparison once real ML Kit numbers exist. From `node test/run-benchmark.js`, unchanged across the cleanup pass (verified identical before/after):

| Image | CER | WER | Ground truth |
|---|---|---|---|
| complexPic1 | 46.2% | 64.0% | full |
| complexPic2 | 39.2% | 71.4% | full |
| complexPic3 | 79.2% | 94.4% | full |
| complexPic4 | 21.0% | 16.5% | full |
| complexPic5 | 7.8% | 17.9% | full |
| complexPic6 | 76.0% | 92.6% | full |
| complexPic7 | 86.1% | 98.3% | partial |
| complexPic8 | 34.3% | 40.6% | full |
| complexPic9 | 57.7% | 65.3% | full |
| complexPic10 | 381.1% | 651.4% | partial |
| complexPic11 | 132.3% | 323.1% | partial |
| complexPic12 | 396.7% | 719.7% | full (cropped source) |
| complexPic13 | 590.4% | 1544.8% | full (cropped source) |
| complexPic14 | 70.9% | 97.3% | full |
| complexPic15 | 6.7% | 18.2% | full (cropped source) |

The >100% CER scores (10, 11, 12, 13) aren't measurement bugs — CER can exceed 100% when the hypothesis is much longer than the reference. For 10 and 11 specifically, that's partly an artifact of the ground truth being conservative (illegible fine print omitted) while Tesseract still outputs *something* for that same region.

## Next action

1. Rebuild in Xcode (the Info.plist fix needs a fresh build) and retry "Use camera" — confirm no crash.
2. Run all 15 `complexPic1-15` images through the app on-device (camera and/or the file-picker path), Raw view, save each into `test/manual-output/<name>.txt`.
3. `node test/score-manual.js` — that result is what Phase 2's engine decision hinges on. Nothing else moves until it exists.
