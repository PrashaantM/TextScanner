# TextScanner: Bug Fixes & Feature Build Prompt

Context for the agent: TextScanner is a static, fully client-side OCR web app (`index.html`, `script.js`, `style.css`), using Tesseract.js via WASM, hosted on GitHub Pages. No server, no upload, everything runs in the browser. There's also a `legacy-opencv-scripts/` folder with early Python/OpenCV exploration from before the project became a browser app. Repo: https://github.com/PrashaantM/TextScanner

Work through the phases below in order. Each phase is meant to be a self-contained unit of work you can implement, test, and commit before moving to the next. Don't skip ahead to later phases before earlier ones are working, the later features depend on the earlier fixes being solid (the filter feature especially depends on OCR output quality being fixed first, not papered over).

---

## Phase 1: Fix garbled/weird-symbol OCR output on otherwise-clear images

**Problem:** Some images with clear, legible text produce output full of weird symbols and garbage characters scattered through otherwise correct text.

**Likely root causes to investigate and address:**
1. No image preprocessing before the image is handed to Tesseract.js. Tesseract is very sensitive to contrast, lighting, and background noise. Uneven lighting, low contrast, colored/busy backgrounds, and JPEG artifacts all get misread as characters.
2. No confidence-based filtering. Tesseract.js returns a confidence score per word (and per character, depending on API used). If the current code isn't checking these scores, low-confidence garbage gets treated the same as high-confidence real text.
3. Page segmentation mode (PSM) may not be matched to the kind of image being scanned. Check what PSM is currently set (or if it's left at default) and whether that's appropriate for varied inputs (signs, receipts, screenshots, book pages all have different layouts).
4. Image resolution/scaling: verify images aren't being fed in too small, too large, or unscaled in a way that hurts recognition.

**Implementation:**
- Add a preprocessing step that runs before the image is passed to Tesseract: convert to grayscale, apply contrast normalization or adaptive thresholding (binarization), consider deskewing if the image has any tilt. This can be done with canvas pixel manipulation directly, or by pulling in OpenCV.js, which is a natural fit given the project's OpenCV origins. Evaluate both and pick whichever is simpler to integrate without adding significant load time.
- After OCR, read the confidence score for each recognized word. Add a configurable confidence threshold (start around 60-70% and tune based on testing) below which a word gets flagged as low-confidence. Do not silently drop these, mark them (e.g. a subtle visual indicator in Image format / Full image view) so the user knows to double check that word, rather than either hiding it or presenting it with false authority.
- Test against a deliberately varied set of sample images: low light photo, angled/skewed photo, screenshot with clean text, receipt with small print, sign with a busy background. Confirm the garbage-symbol issue is meaningfully reduced across this set, not just on one test case.
- Keep this preprocessing step distinct from the Phase 3 filter feature below. This phase fixes recognition quality at the source; Phase 3 is a separate, user-facing cleanup layer on top of whatever Tesseract still returns.

---

## Phase 2: Fix text deletion leaving a smudge on the background

**Problem:** Per the README, deleting a text component currently covers its old spot with "a patch sampled from the surrounding image," which visibly smudges on textured or patterned backgrounds.

**Implementation:**
- Replace the naive patch-sampling approach with proper inpainting. Since the project already has OpenCV history, use OpenCV.js's `cv.inpaint()` (Telea or Navier-Stokes method) to fill the deleted region based on the surrounding image content, rather than a single sampled patch.
- Scope the inpainting mask tightly to the actual bounding box of the deleted word/component, with a small margin, to avoid unnecessarily blurring nearby image content.
- Test on textured backgrounds (wood grain, fabric, gradients) and patterned backgrounds (repeating designs) specifically, since these are where naive patch sampling fails most visibly. Compare before/after against the current behavior.
- Make sure this integrates cleanly with the existing Undo/Redo system, deletion (and its inpainting result) needs to be a reversible step like moves and resizes already are.

---

## Phase 3: Three-level text filter

**Problem/goal:** Add a filter that lets users view extracted text at three levels of strictness, without losing access to the raw output.

**Levels:**
1. **Raw** — unmodified OCR output, exactly as recognized.
2. **Symbol-filtered** — strips characters/symbols that are clearly not valid text (isolated punctuation-like artifacts, non-alphanumeric noise), using pattern-based rules. This is a relatively safe, mechanical filter.
3. **Coherence-filtered** — attempts to remove words/fragments that don't form coherent text. This is the riskiest level: it can easily strip proper nouns, abbreviations, numbers, non-English words, or anything that looks wrong to a naive check but is actually correct.

**Implementation:**
- Build this as a non-destructive view layer, not a transformation that discards data. The underlying raw OCR result (with confidence scores from Phase 1) should always be retained; each filter level is just a different rendering/selection over that same data.
- For level 2, use pattern/regex-based rules (e.g. stripping tokens that are pure symbol noise, orphaned punctuation, or repeated garbage characters) combined with the confidence scores from Phase 1, low-confidence + non-dictionary-shaped tokens are good level-2 candidates to strip.
- For level 3, use a dictionary/wordlist check (does this look like a real word in the detected language) combined with confidence score, rather than trying to do full semantic coherence checking. Be conservative: default to keeping a word if uncertain, since silently dropping correct text is worse than leaving in an occasional artifact.
- Add a UI toggle for switching between the three levels in the existing Text / Image format / Full image views, and make sure Copy and Download respect whichever level is currently selected.
- Do not make level 3 the default. Default to raw or symbol-filtered, and let users opt into the more aggressive filtering, since it carries the highest risk of removing text they actually wanted.

---

## Phase 4: Add/remove components (MVP scope)

**Problem/goal:** Let users add new text elements onto the image (not just edit/move/delete existing OCR'd words), and remove components they've added, without needing an external editor.

**Scope for this phase, deliberately minimal:**
- Add a "New text" action in Full image view (alongside the existing Move components mode) that places a new, empty editable text box onto the image at a default position or where the user clicks/taps.
- Support: typing/editing the text content, dragging to reposition, resizing, and deleting the added component. One font, one default size range, no color picker or font selection yet, that's explicitly out of scope for this phase.
- Newly added components should participate in the existing Undo/Redo system the same way moves and resizes do.
- Newly added components should be included in PNG downloads from Full image view (they're part of the rendered output the user is building).
- Explicitly do not build in this phase: font selection, color picker, multiple fonts/styles, layering/z-index controls, alignment guides. Flag these as a possible v2 if this MVP tests well, don't build them now.

---

## Phase 5: Text-to-speech

**Problem/goal:** Let users have the extracted text read aloud.

**Implementation:**
- Use the Web Speech API (`SpeechSynthesis`), which runs entirely client-side in supported browsers, no server call, no API key, consistent with the app's existing privacy model.
- Add a "Read aloud" control in the Text view (and consider Image format view too, reading words in their recognized order). Support play/pause/stop at minimum.
- Respect whichever filter level (Phase 3) is currently active, read the filtered text, not always the raw text, unless the user has raw selected.
- Handle the case where Web Speech API isn't supported or no voices are available in the current browser gracefully (hide/disable the control rather than erroring).

---

## Phase 6: Translation (flag as optional, needs a decision first)

**Problem/goal:** Let users translate extracted text into another language.

**Important tradeoff to flag back to the user before building this, don't just implement it silently:** every good translation option either calls an external API (Google Translate, DeepL, etc.) or requires a large on-device model. An API call means the extracted text leaves the browser, which conflicts with the app's current "your images never leave your browser" privacy claim. Confirm with the product owner which of these they want before writing code:
- **Option A:** API-based translation. Simple to implement, costs money per call at scale, requires clearly disclosing in the UI and privacy policy that translated text is sent to a third-party service.
- **Option B:** Hold off on translation entirely until/unless the app goes native, where on-device translation frameworks are available without a network call.

Do not proceed with implementation until this is confirmed. If Option A is chosen, implement it as clearly opt-in per use (e.g. a "Translate" button the user actively presses, not automatic), and surface a one-time or persistent notice that this specific action sends text off-device.

---

## Cross-cutting notes

- **Offline readiness:** regardless of whether this ends up wrapped for a native shell, becomes a PWA, or stays web-only, bundling the Tesseract.js language data locally instead of fetching it from a CDN on first load will make first-run experience faster and is a prerequisite if this ever gets wrapped for App Store submission (offline-capable is expected there). Worth doing this as infrastructure work even if the platform decision isn't final yet.
- **Testing:** for every phase above, test against a varied image set (low light, skewed, high-res screenshot, small receipt print, busy-background sign), not a single happy-path image. Several of these bugs and features only misbehave on the harder cases.
- **Don't couple phases tighter than necessary:** Phase 3 (filter) should work fine on its own once Phase 1 (recognition quality) is done, without waiting on Phases 4-6. Ship and test incrementally rather than batching everything into one large change.
