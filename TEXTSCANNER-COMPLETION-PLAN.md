# TextScanner Completion Plan

**Source:** builds on the architecture/security review dated 2026-08-28 (commit `931ddc6`) and a follow-up discussion about the coherence filter's API key dependency, OCR accuracy goals, and product differentiation. Read `HANDOFF.md` and that review before starting; this plan assumes both as background and does not repeat their findings verbatim.

**How to use this with Claude Code:** work one phase at a time, in order, and commit at the end of each phase with a message referencing the phase number. Do not start a phase until the previous one's "Done when" criteria are met. Two phases (2c and 4c) have an explicit decision point that needs a human answer before Claude Code proceeds with that section; everything else can run unattended.

---

## Priority tiers

- **P0 (blocking):** the app is materially broken or insecure without this.
- **P1 (pre-launch):** required before App Store submission.
- **P2 (quality):** meaningfully improves the product but doesn't block shipping.
- **P3 (optional):** worth doing, not worth delaying anything else for.

| Phase | Tier |
|---|---|
| 0. Safety net | P0 |
| 1. Security fixes | P0 |
| 2. Coherence filter without a required key | P1 |
| 3. OCR accuracy (realistic version) | P1/P2 |
| 4. Touch input fix + one real feature | P0 (touch) / P2 (feature) |
| 5. Structural cleanup | P2 |
| 6. Accessibility | P2 |
| 7. App Store readiness | P1 |

---

## Phase 0 — Safety net before touching anything (P0)

The goal here is to make regressions detectable before Phase 2-4 start changing behavior.

1. **Fix the benchmark harness so it runs on any machine.**
   Replace the symlinked, borrowed Playwright install in `test/` with a real `devDependency`. Add a minimal `test/package.json`:
   ```json
   { "devDependencies": { "playwright-core": "^1.4x" } }
   ```
   Remove the hardcoded `CHROMIUM_PATH`; resolve the browser path via `playwright-core`'s normal install/launch flow instead. Confirm `test/run-benchmark.js` and `test/replay-dump.js` still run end to end.

2. **Add unit tests for the pure functions that currently have none.**
   Target: `test/metrics.js` (Levenshtein CER/WER), `filter.js`'s predicates, `buildBboxMapper`/`transformBboxCorners` in `ocrEngine.js`, and the quad math in `perspective.js`. These are exactly the functions Phase 3 and Phase 5 are going to touch. No browser needed; use `node --test` or a lightweight runner, don't add a framework dependency for this.

3. **Record a baseline.** Run the benchmark against the current 11-image corpus and save the CER/WER output somewhere durable (e.g. `test/baseline-2026-08-28.json`). Every later phase that touches recognition or preprocessing must be checked against this baseline; a change that regresses average CER/WER should not be merged silently.

4. **Fold in the two folder-hygiene fixes from the review while we're in here:**
   - Delete `www/js/textUtil.js` and `ios/App/App/public/js/textUtil.js` (stale, unreferenced, left behind by `cap sync` copying without pruning).
   - Move the 11-image test corpus out of `legacy-opencv-scripts/` into `test/images/`, and move the two throwaway Python origin-story files into `docs/origins/`. Update any paths `test/` scripts reference.

**Done when:** benchmark harness runs clean from a fresh clone with no absolute paths and no borrowed `node_modules`; unit tests exist and pass; baseline CER/WER is committed; stale generated files and the misplaced corpus are gone.

---

## Phase 1 — Security fixes (P0)

Cheapest, highest-leverage items from the review, all independent of each other.

1. **Vendor Tesseract.js locally instead of loading it from jsDelivr.**
   Download `tesseract.js@5.1.1` (pin the exact version already in use) into the repo, serve it from a local path, and remove the `<script src="https://cdn.jsdelivr.net/...">` tag entirely. This resolves the no-SRI issue, the native-build-fetches-from-CDN-at-launch issue, and moves the offline claim in the README from aspirational to true, in one change. If repo size is a concern, note the tradeoff in a comment but default to vendoring; it removes an entire class of supply-chain risk.

2. **Add a CSP meta tag to `index.html`.** Once Tesseract is vendored, `script-src` can drop `cdn.jsdelivr.net` entirely:
   ```
   default-src 'self'; script-src 'self'; img-src 'self' blob: data:;
   connect-src 'self' https://api.anthropic.com https://tessdata.projectnaptha.com blob:;
   worker-src 'self' blob:; style-src 'self'; object-src 'none'; base-uri 'none'
   ```
   Verify against a real scan (Tesseract's worker still needs to fetch language data from `tessdata.projectnaptha.com` unless that's also vendored, see item 3) before shipping. Adjust `connect-src` if it isn't.

3. **Consider vendoring the Tesseract language data too**, not just the script, if the corpus size is acceptable. This would let `connect-src` drop the last external host and make the "runs entirely offline" claim fully true rather than mostly true. Treat as P2 if it meaningfully bloats the repo; P1 if not.

4. **Gate or remove `mlkitDebug.js`.** Check `HANDOFF.md` for whether the positioning bug it was instrumenting is closed. If closed, delete the module and its wiring outright. If still open, gate it behind a debug-only build flag so it cannot ship active in a TestFlight or App Store build, and keep the deletion as a tracked follow-up.

5. **Fix the two copy inaccuracies flagged in the review:**
   - Footer claim "runs entirely client-side with Tesseract.js" is false on the native build (it runs ML Kit). Make this conditional on platform, or reword to something true on both.
   - "Your images never leave your browser" needs a native-build qualifier distinguishing *your image never leaves the device* (true) from *the app makes no network requests* (not quite true once ML Kit's bundled telemetry is accounted for, see Phase 7).

6. **Add one sentence to the API key disclosure** noting that `localStorage` is scoped to the shared `*.github.io` origin, and that other projects served from the same origin can read the key back. Don't need to solve hosting in this phase, just disclose it honestly, matching the project's existing standard for candor.

**Done when:** no third-party script tag remains in `index.html`; a CSP is present and verified against a live scan; `mlkitDebug.js` is either deleted or provably inert outside debug builds; the three copy inaccuracies are corrected.

---

## Phase 2 — Coherence filter without a required API key (P1)

**Scope note up front:** Apple's on-device LLM (Foundation Models framework) is iOS-only. This phase makes the *native iOS build* work without requiring a key. The GitHub Pages *web build* has no comparable on-device option and will continue to require BYOK for Coherence Filter, same as today, just labeled more clearly. Don't build anything that implies the web version also gets a free tier; it doesn't, and promising that would be dishonest in the same way the review flagged elsewhere.

1. **Add a native Foundation Models bridge.**
   New Capacitor plugin (Swift), e.g. `TextCoherencePlugin`, exposing one method that takes recognized text and returns a cleaned-up rewrite, backed by `SystemLanguageModel.default` + `LanguageModelSession`. Guard every call with `SystemLanguageModel.default.availability` and handle the "unavailable" case explicitly (device not Apple Intelligence-eligible, or the user has it turned off) rather than throwing.

2. **Restructure `coherence.js` into a dispatch layer, mirroring the existing `recognize.js` pattern** (this is the same seam that already worked cleanly for OCR, reuse the idea):
   ```js
   // coherence.js becomes the dispatcher, not the implementation
   if (nativeFoundationModelsAvailable()) return rewriteOnDevice(text);
   if (hasStoredApiKey()) return rewriteWithClaude(text);
   return { unavailable: true, reason: '...' };
   ```
   Move the existing Claude call into its own module (e.g. `coherenceClaude.js`) and add `coherenceOnDevice.js` for the native path, so `main.js`'s wiring stays consistent with how it treats `ocrEngine.js` vs `mlkitEngine.js`.

3. **Decision needed from you before this sub-step:** should the on-device result be the *default* for anyone on an eligible device (with BYOK Claude offered as an opt-in "better quality" tier), or should BYOK stay the default with on-device offered as the free fallback? The review's recommendation was on-device as default, since it removes the key requirement for most users and keeps the local-first story intact, but confirm before Claude Code changes the UI's default toggle state.

4. **Update the UI copy** to distinguish the two tiers clearly. Don't let "Coherence Filter" silently mean two different quality levels with no indication which one just ran. Something like a small label next to the toggle: "On-device" vs "Claude (your API key)".

5. **Verify `PrivacyInfo.xcprivacy` requirements** for apps using Foundation Models against current Apple documentation at implementation time; this plan is not the source of truth for that, Apple's requirements here may have shifted since this was written.

**Done when:** the iOS build offers a working Coherence Filter with zero API key required, on eligible devices; unsupported devices get an honest "unavailable" state rather than a silent failure; BYOK Claude remains available as documented; the web build's behavior is unchanged and clearly labeled as still requiring a key.

---

## Phase 3 — OCR accuracy, the realistic version (P1/P2)

This phase deliberately does **not** target "works on all possible photos." That's not an achievable engineering target, see the discussion this plan is based on. The goal is measurable improvement against a real benchmark, with known, disclosed failure modes.

1. **Grow the benchmark corpus.** 11 images isn't enough to trust a "this preprocessing change helped" conclusion. This step needs real photos from you across categories the current corpus likely under-represents: low light, steep skew, dense small text, a receipt, a street sign, a screenshot-of-a-screenshot (moiré case), and at least one intentionally hard image per known failure mode from the review (§2.4, §3.6). Claude Code cannot generate these; this is the one step in the whole plan that blocks on you supplying source material. Add ground-truth transcriptions alongside each.

2. **Once the corpus is expanded, tune the scored-candidate pipeline in `ocrEngine.js` against it.** This is the actual lever available in this codebase (see the architecture review §2.4), not model training. Concretely: experiment with additional preprocessing variants in the region-reprocessing stage, and revisit `MIN_REGION_WORD_COUNT_RATIO` / `MAX_ZERO_WORD_REGION_AREA_FRACTION` and the confidence thresholds that gate each stage, using the benchmark to confirm each change is a net improvement, not a guess. Every change must be checked against the Phase 0 baseline before merging.

3. **Add a megapixel/decode-size cap.** A valid 15 MB image can still decode into a pixel buffer large enough to freeze the tab on `readImagePixels` / `preprocessImage` / `computeInpaintedPatch`, all of which are currently unbounded and run on the main thread. Add a cap (downscale before processing if the natural dimensions exceed it) and surface a brief message if an image is being downscaled for performance.

4. **Surface the missing confidence signal on the native path**, rather than silently degrading. ML Kit doesn't expose per-word confidence, so `mlkitEngine.js` assigns a fixed 100, which means `LOW_CONFIDENCE_THRESHOLD` flagging is dead on native with no indication to the user. Either show a one-line note in the native UI that confidence flagging isn't available on this platform, or suppress the confidence-related UI affordances entirely on native so their absence doesn't read as "everything scored perfectly."

5. **(P3, optional, discuss before building)** An opt-in "hard case" cloud OCR fallback (Cloud Vision, Azure Read, or similar) for images the on-device engines fail on, offered the same way Coherence Filter is offered: opt-in, disclosed cost and network use, off by default. This is a real way to buy meaningfully higher accuracy on genuinely hard images, but it reintroduces the exact network-dependency and cost tradeoff Phase 2 was built to avoid for the coherence filter, so don't add it without confirming you actually want that tradeoff for OCR specifically.

**Done when:** benchmark corpus covers the disclosed failure-mode categories with ground truth; pipeline changes are validated against baseline CER/WER, not eyeballed; decode-size cap is in place; native confidence-signal gap is either surfaced or the UI no longer implies a signal that doesn't exist.

---

## Phase 4 — Fix the broken flagship feature, then build one real thing (P0 / P2)

### 4a. Touch input (P0)

The review's most urgent product finding: every editor interaction (`editor.js:805-912`) is bound to `mousedown`/`mousemove`/`mouseup` only. "Move components," the feature the README leads with, does not reliably work by touch on the iOS target this app is built for. Fix this before anything else in this phase.

1. Replace the mouse handlers with `pointerdown`/`pointermove`/`pointerup`, using `setPointerCapture` on drag start.
2. Add `touch-action: none` to the editor surface so single-finger drag doesn't fight the two-finger pinch zoom that was already fixed at the Capacitor config layer.
3. Increase the resize handle's hit area (currently 11x11px, below the 24px minimum target size) while this code is already open. Doesn't need a visual redesign, just a larger invisible hit target around the visible handle.
4. Retest marquee selection and drag-resize specifically on a physical device or accurate touch simulator, not just desktop dev tools with mouse events, since that's exactly how this got missed the first time.

**Done when:** move, resize, and marquee selection all work reliably by touch on a real iOS device.

### 4b. Font/color matching for edited text (P2)

Currently every rendered word uses one system font stack in one color regardless of the source. This is the gap between "clever demo" and "edits that actually blend in." Treat this as exploratory, not a fixed-scope task:

1. Sample the dominant color from the pixel region directly around each recognized word's bounding box (before it's covered) and use that as the rendered text color instead of the fixed `--text` variable, with a legibility fallback if the sampled color is too close to the background.
2. Investigate whether a coarse font-weight/size match (bold vs regular, relative size from bbox height) gets meaningfully closer to blending in than the current fixed stack, before investing in anything more ambitious like font-family classification. Measure against `test/render-fidelity.js`, which the review already flagged as the right instrument for this.
3. Apply the same treatment to `buildResultCanvas`'s `ctx.fillText` path so PNG export doesn't regress relative to the DOM view.

**Done when:** edited/added text color is derived from the source image rather than fixed, with a documented legibility fallback; `render-fidelity.js` shows measurable improvement over the current baseline.

### 4c. One real differentiating feature (P2)

**Decision needed from you before this sub-step starts.** The recommendation, in order of how directly they reuse what's already built:

- **Translation-in-place**: recognize text, replace it with a translated string at the same position, reusing the existing object model and the Coherence Filter's dispatch pattern (swap "clean this up" for "translate this to X"). Highest leverage against existing architecture, and a genuinely common need (menus, signage) that Live Text doesn't solve.
- **Redaction**: blur or remove sensitive text before sharing a photo, reusing the inpainting system already built for word deletion.
- **Correction**: fix a typo on a scanned document or receipt before sharing it, closest to what the app already does today, smallest net-new scope.

Default recommendation is translation-in-place, for the reuse and the distinctiveness, but confirm before Claude Code scopes the actual implementation tasks for this sub-step, since the work breaks down differently depending on which one is picked (translation needs a source/target language UI and a translation call; redaction needs a "blur vs remove" toggle and no new text input at all; correction needs close to nothing new).

Once confirmed, this plan should be extended with concrete steps for the chosen feature before Claude Code implements it; don't guess at the breakdown in advance of the decision.

---

## Phase 5 — Structural cleanup (P2)

Only start this once Phases 0-4 are stable; it's pure maintainability work with no user-facing effect, and touching `editor.js` while Phase 4a/4b are also mid-flight risks conflicts.

1. **Split `editor.js`** along its existing internal section boundaries (it's already banner-commented for this) into `editorObjects.js` (object model), `editorInteractions.js` (drag/resize/selection, now pointer-based from Phase 4a), and `editorExport.js` (canvas export, text extraction). Preserve the hook-registration pattern exactly as-is; that architecture is a strength, don't refactor it away while splitting files.
2. **Replace linear `state.editorObjects.find(...)` lookups** with an id-keyed `Map` kept alongside the array, updated wherever the array is mutated.
3. **Move `refreshModifiedStates()` out of the drag `onMove` hot path**, or debounce/scope it so it isn't doing a full reconciliation pass on every `mousemove`/`pointermove` tick.
4. **Give the inpainting loop a yield point or a worker.** 300 synchronous Gauss-Seidel iterations per deleted word is fine for one word; "select all and delete" on a dense screenshot currently serializes hundreds of these with no yield, no progress indicator, and no cancellation. Either move it to a Web Worker or add a periodic `await` yield with a progress callback the UI can show for batch deletes.

**Done when:** `editor.js` no longer exists as a single file; object lookup is O(1); the drag loop no longer does full-object reconciliation per pointer-move tick; a batch delete of 20+ words doesn't visibly freeze the UI.

---

## Phase 6 — Accessibility backlog (P2)

Addresses the review's §3.4 gaps, roughly in the impact order it already assigned them.

1. Keyboard path through the editor: arrow-key nudge for move, a keyboard-accessible resize mode, and tab-order traversal between objects ("select next object").
2. Give the resize handle a real accessible name, `role`, and focusability, on top of the larger hit area already added in Phase 4a.
3. Add `aria-selected` on selected objects and an `aria-live` region announcing selection count changes ("3 items selected").
4. Add `role="textbox"` and a descriptive `aria-label` (recognized word + rough position) to word spans, so a screen reader user knows a focused span is editable at all.
5. Add a non-color signal for `is-filtered-out` and `is-modified` states, currently opacity/tint only, e.g. a small icon or text badge.
6. Add a manual dark-mode override alongside the existing `prefers-color-scheme` support, and a `color-scheme` CSS declaration so form controls follow it.
7. Replace the generic error copy in `setStatus` (which currently interpolates raw `err.message` into user-facing text) with categorized, human-readable failure messages.

**Done when:** a keyboard-only user can select, move, resize, and delete an object without a pointer; screen reader output correctly announces selection state and word-span purpose; error messages no longer leak raw exception text.

---

## Phase 7 — App Store readiness (P1)

1. **Add an app-level `PrivacyInfo.xcprivacy`.** Pods already ship their own; the app target currently has none, and this blocks submission.
2. **Decide and document the ML Kit telemetry position.** `GoogleDataTransport`/`GoogleUtilities` perform usage logging to Google by default. Either disable it via ML Kit's documented Info.plist opt-out, or leave it on and correct the privacy copy to distinguish "your image never leaves the device" (true) from "the app makes no network requests" (not true once this is accounted for). Pick one, don't leave it ambiguous.
3. **Trim the four unused ML Kit script models.** Latin, Chinese, Devanagari, Japanese, and Korean are all compiled in via the Podfile; only Latin is ever requested (`mlkitEngine.js` hardcodes `script: "LATIN"`). Either drop the other four to cut binary size, or wire up real script selection if multi-script support is actually wanted, don't ship dead weight either way.
4. **Confirm no native network call happens at launch or during a scan**, now that Phase 1 has vendored Tesseract and Phase 2 has added an on-device coherence path. The only network calls that should remain possible on native are: BYOK Claude coherence (opt-in, user has a key), and whatever ML Kit's telemetry does per item 2 above (a decision, not a bug, once documented).
5. **Re-verify permission strings** (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`) are still accurate given any UI copy changes from earlier phases; the review found these already good, just confirm nothing drifted.

**Done when:** `PrivacyInfo.xcprivacy` exists at the app target level; the telemetry decision is made and reflected in both code and copy; unused ML Kit models are either removed or actually used; no undocumented network call exists on the native build.

---

## Explicit non-goals

State these to Claude Code up front so scope doesn't creep during implementation:

- No "close to 100% OCR success rate" target, on any phase. The target is measurable improvement against the Phase 0 baseline, with known failure modes disclosed in the UI/README, not universal accuracy.
- No backend proxy service for the coherence filter. Phase 2 uses on-device inference specifically to avoid taking on server infrastructure and per-user API cost.
- No accounts, cloud sync, or server-side storage of any kind, unless a future decision explicitly adds them. Everything stays local-first per the app's existing design.
- No new third-party CDN dependencies. Phase 1 removes the one that exists; don't add another as a side effect of any later phase.
