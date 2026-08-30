# TextScanner Hardening & Verification Plan (Phase 8-16)

**Source:** builds directly on the 2026-08-29 post-completion architecture review (commit `7ff391e`), specifically §5 ("What's actually left"). Every phase below maps to a specific finding in that document. Read it before starting.

**How to use this with Claude Code:** execute phases in order. Phase 9 depends on Phase 8's output existing. Phase 16 depends on Phase 9 being closed. Phase 18 depends on every other phase in this document (8 through 17) being complete, it is the closing step, not one that can run early. Every other phase is independent and can run in any order relative to the others, but do not skip ahead of 8 and 9, since later phases assume the positioning bug's status is known, not still open.

**A note on scope:** four phases below (8, part of 9, 14, 15) include a step that requires you personally, not Claude Code, because it needs physical hardware, an Apple Developer account, or a DNS registrar login. Each of those steps is written as a direct instruction, not a suggestion. Do it, then hand the output back to Claude Code to continue the phase.

---

## Priority tiers

| Phase | Tier |
|---|---|
| 8. Physical device verification pass | P0 |
| 9. Close the ML Kit positioning bug | P0 |
| 10. CI pipeline | P0 |
| 11. Benchmark corpus expansion + re-tune | P1 |
| 12. Real-world input hardening | P1 |
| 13. Move/inpaint gap fix | P2 |
| 14. Custom domain migration | P2 |
| 15. User-triggered diagnostic export | P2 |
| 16. Vision framework migration scope document | P3 |
| 17. UI fluidity and motion polish | P2 |
| 18. Update analysis.md to reflect the finished state | P0 (closing step) |

---

## Phase 8 — Physical device verification pass (P0)

Nothing in the current codebase has run on real hardware. This phase produces the artifacts that Phase 9 and the rest of this plan depend on.

1. Claude Code writes `docs/DEVICE-VERIFICATION-CHECKLIST.md` containing the exact checklist below, formatted as markdown checkboxes.

2. **You personally**, not Claude Code: install `mitmproxy` on your laptop (`brew install mitmproxy`). Run `mitmweb`. On the iPhone, connect to the same Wi-Fi network as the laptop, set the Wi-Fi proxy to the laptop's local IP and port 8080, then visit `mitm.it` in Safari and install the mitmproxy CA certificate. Go to Settings > General > VPN & Device Management and trust the certificate. Go to Settings > General > About > Certificate Trust Settings and enable full trust for the mitmproxy root certificate. This is required, not optional, since iOS does not trust user-installed CAs for TLS by default even after installation.

3. **You personally:** in Xcode, select a registered physical device as the build target, then Product > Archive, then in the Organizer choose "Distribute App" > "Development" and install directly to the device. Do not go through TestFlight for this pass, it adds review latency this verification doesn't need.

4. **You personally**, walking through `docs/DEVICE-VERIFICATION-CHECKLIST.md` on the device with the mitmproxy capture running the whole time:
   - Drag a word, resize a word, and use marquee ("Select multiple") selection, each with a real finger. Confirm all three work.
   - Enter Move mode, then perform a two-finger pinch. Confirm pinch-zoom still works and doesn't conflict with the single-finger drag.
   - Trigger Coherence Filter on an eligible device with Apple Intelligence enabled. Confirm the tier indicator reads "On-device" and the rewrite completes. Turn on Airplane Mode and repeat; confirm it still works.
   - Trigger translate-in-place the same way, on-device tier, with Airplane Mode on.
   - Turn off Airplane Mode, switch the Coherence Filter tier toggle to Claude, and confirm that call succeeds and appears in the mitmproxy capture as a request to `api.anthropic.com`.
   - Scan 15 to 20 real photos covering a range of lighting, angle, and text density. For each, note in the checklist whether the recognized result visually matches the source image's word positions.

5. **You personally:** stop the mitmweb capture and export it (mitmweb has a "Save" option in its UI, save as `.mitm` format). Save the file as `test/artifacts/device-network-capture-<date>.mitm`. Add `test/artifacts/*.mitm` to `.gitignore` if not already covered, this file may contain your API key in transit and must not be committed as-is; strip the `Authorization`/`x-api-key` header value before committing, or don't commit the raw capture at all and instead have Claude Code summarize the host list from it into `docs/PRIVACY-DECISIONS.md`.

6. **You personally:** on the device, open Safari's developer console against the app (Settings > Safari > Advanced > Web Inspector, then connect via a Mac's Safari Develop menu), and in the console run:
   ```js
   localStorage.setItem('textscanner.debug.mlkit', '1')
   ```
   Reload the app, scan the same 15-20 photos from step 4 again, then in the console run whatever export mechanism `mlkitDebug.js` exposes to pull `window.__textscannerDebug` as JSON. Save it as `test/artifacts/mlkit-dump-<date>.json`. AirDrop or otherwise transfer it off the device.

7. Claude Code updates `docs/PRIVACY-DECISIONS.md` with a new section, "Verified on device (`<date>`)", listing the exact host list observed in the capture and confirming or correcting the previously-static claim about which network requests occur on native.

**Done when:** `docs/DEVICE-VERIFICATION-CHECKLIST.md` exists with every item checked or explicitly marked failed with a note; `test/artifacts/mlkit-dump-<date>.json` exists; `docs/PRIVACY-DECISIONS.md` has a verified-on-device section.

---

## Phase 9 — Close the ML Kit positioning bug (P0, depends on Phase 8)

1. Run all three replay variants against the real dump:
   ```
   node test/replay-dump.js test/artifacts/mlkit-dump-<date>.json --variant raw
   node test/replay-dump.js test/artifacts/mlkit-dump-<date>.json --variant cornerPoints
   node test/replay-dump.js test/artifacts/mlkit-dump-<date>.json --variant fitted
   ```
2. For each of the 15-20 scans in the dump, compare the rendered box positions in the `raw` variant against the checklist notes from Phase 8 step 4 on whether that scan's positions looked correct on the actual device.
3. Apply this rule exactly: if the `raw` variant's boxes visually match the source image's word positions for the scans that were marked "looked correct" on-device, and the scans marked "looked wrong" show boxes that are genuinely offset (not just covering low-confidence fine print), this is a coordinate transform bug. If instead the boxes in `raw` are positioned correctly everywhere and the "looked wrong" scans are cases of unreadable or missed fine print, this is not a coordinate bug at all, and no rendering fix is needed, skip to step 6.
4. If it is a coordinate transform bug: in `mlkitEngine.js`, stop discarding `cornerPoints` in `flattenBlocks`, thread the rotated quad through instead of the axis-aligned `boundingBox`. In `ocrEngine.js`, extend `buildBboxMapper` to accept a quad rather than assuming an axis-aligned rect, and update `transformBboxCorners` to compose the correction against the actual corner points rather than re-fitting an axis-aligned box around a rotation-only transform.
5. Re-run `render-fidelity.js` and confirm mean geometry error decreases relative to the pre-fix baseline recorded in the existing test output.
6. Delete `js/mlkitDebug.js`, its import and wiring in `main.js`, and `test/replay-dump.js`. Remove the `?mlkitDebug=1` handling from wherever it's checked. Update `docs/PRIVACY-DECISIONS.md` to note the diagnostic path has been removed and why.

**Done when:** either a coordinate fix has shipped and `render-fidelity.js` shows improved geometry error, or the investigation has conclusively ruled out a coordinate bug and documented that conclusion in `HANDOFF.md`; either way, `mlkitDebug.js` and `replay-dump.js` no longer exist in the repo.

---

## Phase 10 — CI pipeline (P0)

1. Create `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 20
             cache: npm
             cache-dependency-path: test/package.json
         - run: npm ci
           working-directory: test
         - run: npx playwright install --with-deps chromium
           working-directory: test
         - run: node --test test/unit
         - run: node test/run-benchmark.js --check-regression --baseline test/baseline-2026-08-28.json --tolerance 2.0
         - run: node test/touch-interactions.js
   ```
2. If `test/run-benchmark.js` doesn't currently support a `--check-regression` flag, add one: it should compute CER/WER against the corpus, compare to the baseline file's stored values, and exit non-zero if the average CER or WER regresses by more than the `--tolerance` value in percentage points.
3. Add a status badge to the top of `README.md`:
   ```markdown
   ![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)
   ```

**Done when:** a push to `main` and a pull request both trigger the workflow; a deliberate benchmark regression (temporarily worsen a threshold, push to a test branch) causes the workflow to fail; reverting makes it pass again.

---

## Phase 11 — Benchmark corpus expansion and re-tune (P1)

1. **You personally:** supply at least 14 new images, 2 each covering: low light, steep skew (greater than 15 degrees), dense small text, a receipt, a street sign, a photo of a screen (moiré case), and non-Latin script. Add each to `test/images/` with a ground-truth transcription file following the existing corpus's naming and format convention. Do not omit illegible fine print from the ground truth the way three of the original 11 images do, that inflated CER on those three in a way the prior analysis had to explicitly correct for; transcribe what's actually legible, completely.
2. Once the corpus is expanded, re-establish the noise floor exactly as before: run `test/run-benchmark.js` twice against identical code with no changes between runs, and record the delta between the two runs as the new noise floor.
3. Run `test/tune-thresholds.js` against the full expanded corpus. Save results to `test/TUNING-2.md`, dated, in the same format as the existing `test/TUNING.md`.
4. Apply this rule exactly when deciding whether to merge a threshold change: merge it only if the measured improvement exceeds twice the newly measured noise floor, and the improvement reproduces in a second independent sweep run. Otherwise leave the threshold at its current value and record the rejection with the numbers, the same way the original `TUNING.md` did.
5. Update `test/baseline-2026-08-28.json` (or create a new dated baseline file and point CI at it) to reflect the new corpus's scores, since the old baseline was computed against 11 images and is no longer the correct comparison point.

**Done when:** the corpus has at least 25 images across the listed categories; `test/TUNING-2.md` exists with full results; CI's regression check points at a baseline computed against the new corpus.

---

## Phase 12 — Real-world input hardening (P1)

1. Add a device-captured `.heic` file to `test/images/format-checks/`. Write a test that loads it through the actual app decode path (canvas draw, not a Node-side library) and asserts recognition completes without error. If it fails in a headless Chromium context specifically because HEIC decoding isn't available there, note that in the test and instead verify HEIC handling as part of the Phase 8 device checklist rather than in CI; do not skip verifying it somewhere.
2. Write a small, dependency-free EXIF orientation parser: read the JPEG's APP1 segment, extract the orientation tag (values 1-8), and apply the corresponding canvas rotation/flip before the image is handed to `readImagePixels` or the recognition pipeline. Add this as a new function in `preprocess.js`, called from the same place `perspective.js`'s correction is currently invoked.
3. Create 8 test images, one for each EXIF orientation value 1 through 8, all encoding the same visible content. Add a unit test asserting that after the orientation-correction step, all 8 produce the same recognized text and equivalent bounding-box geometry.
4. Add four malformed-input test cases to the test suite: a zero-byte file, a JPEG truncated at 50% of its byte length, a `.txt` file renamed to `.jpg`, and an image with an extreme aspect ratio (50x5000px or similar). For each, assert the app produces one of the six `describeScanError()` categories and does not throw an uncaught exception or hang without a status update.

**Done when:** HEIC input is verified through either CI or the device checklist; all 8 EXIF orientations normalize to the same output; all four malformed-input cases resolve to a categorized error message.

---

## Phase 13 — Move/inpaint gap fix (P2)

1. In `editorInteractions.js`, locate the pointer-up handler that finalizes a move gesture. After the object's position is committed, call the same patch-application function currently invoked by the delete handler (via `setPatchProvider`/`setDeleteHandler`'s wiring in `main.js`) against the object's `originalBbox`, unconditionally, not gated behind the "modified" display state check that currently controls patch visibility.
2. Confirm this doesn't double-apply the patch on an object that's later deleted; the patch cache in `main.js` is keyed by object id and should already be idempotent, verify this rather than assuming it.
3. Extend `render-fidelity.js` (or add a new test file if that harness isn't the right fit for interaction testing) with a case that: places a word, records the pixels at its original location, moves it, then asserts the vacated region's pixels match the inpainted patch rather than the original source pixels.

**Done when:** moving a word in Full image view no longer leaves the original pixels visible underneath its old position, verified by an automated test, not just visual inspection.

---

## Phase 14 — Custom domain migration (P2)

1. **You personally:** acquire or use an existing domain or subdomain you control. In your DNS provider, add a CNAME record pointing it at `<owner>.github.io`.
2. Claude Code adds a `CNAME` file to the repo root containing the domain name, exactly as GitHub Pages requires.
3. **You personally:** in the repository's Settings > Pages, enter the custom domain and enable "Enforce HTTPS" once GitHub reports the certificate is provisioned.
4. Claude Code updates the API key disclosure copy in the Coherence Filter panel: remove the sentence about the key being readable by any other project on the shared `github.io` origin, and replace it with a sentence stating the key is scoped to this app's own domain.
5. Claude Code updates the empty-state copy shown when no API key is set, adding one sentence noting that a key entered before this domain change will need to be re-entered, since browser storage does not carry over across a domain change.
6. Claude Code updates `docs/PRIVACY-DECISIONS.md` to reflect the closed finding.

**Done when:** the app is reachable at the custom domain over HTTPS; the shared-origin caveat is removed from the UI and replaced with the corrected claim; the re-entry notice is present in the empty state.

---

## Phase 15 — User-triggered diagnostic export (P2)

1. Add `@capacitor/device` and `@capacitor/share` as dependencies.
2. Add a "Export diagnostic report" button to the app's settings or about panel (create one if it doesn't exist yet).
3. On tap, assemble a JSON object containing: timestamp, `getEngineName()`'s output, whether the platform is native or web, the most recent categorized error from `describeScanError()` if one occurred this session, and, on native only, the device model and OS version via `@capacitor/device`'s `getInfo()`; on web, `navigator.userAgent`.
4. Do not include any scanned image or recognized text in this object by default. Add a separate, unchecked-by-default checkbox in the export UI labeled "include the image that caused this issue," and only attach image data if the person explicitly checks it.
5. Pass the assembled JSON to `@capacitor/share`'s `share()` method so the OS share sheet handles delivery. The app must not transmit this report anywhere on its own; the person chooses the destination through the share sheet.

**Done when:** the export button produces a JSON report through the native share sheet on iOS and a download or Web Share API call on the web build; image data is absent unless explicitly opted in.

---

## Phase 16 — Vision framework migration scope document (P3, depends on Phase 9)

Do not start this phase until Phase 9 has concluded and the positioning bug's status (fixed or ruled-out) is documented. Migrating recognition engines while that investigation is still open would make it unclear which engine any given result came from.

1. Write `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` containing:
   - A mapping from ML Kit's `TextRecognizer` API surface, as currently used in `mlkitEngine.js`, to Apple's `VNRecognizeTextRequest` and `VNRecognizedTextObservation`.
   - Confirmation, checked directly against Vision's `.swiftinterface`, of whether `VNRecognizedTextObservation` (which subclasses `VNRectangleObservation`) exposes the four corner points (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`) needed to replace what `cornerPoints` currently provides.
   - A list of every file that would need to change: at minimum `mlkitEngine.js` (replaced or rewritten), the native plugin structure alongside `TextCoherencePlugin.swift`, the Podfile (removing `MLKitTextRecognition` and its dependencies), and `scripts/trim-mlkit-scripts.js` (deleted, since there would be no ML Kit script models to trim).
   - An explicit note that this migration removes the ML Kit telemetry question in §4.5 of the architecture review by removing the dependency, rather than by finding an opt-out.
   - An estimate of what test coverage needs to be rebuilt: `render-fidelity.js`'s geometry assertions would need reverification against Vision's coordinate system, which uses a bottom-left origin unlike ML Kit's top-left origin, and this is a likely source of a new coordinate bug if not handled explicitly during migration.
2. This document is the full deliverable for this phase. Do not begin implementing the migration itself as part of Phase 16.

**Done when:** `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` exists and answers the corner-point question definitively, not provisionally.

---

## Phase 17 — UI fluidity and motion polish (P2)

The app is functionally complete and accessible per the prior phases. This phase makes state changes read as continuous rather than instant, without adding a framework or a build step.

1. Add motion tokens to `style.css`, at the top with the other CSS custom properties:
   ```css
   --motion-fast: 120ms;
   --motion-medium: 200ms;
   --motion-slow: 320ms;
   --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
   ```
   Every transition added in this phase uses one of these tokens, not a hardcoded duration.

2. Wrap `prefers-reduced-motion: reduce` around all of it in one place, not scattered per-rule:
   ```css
   @media (prefers-reduced-motion: reduce) {
     :root { --motion-fast: 0ms; --motion-medium: 0ms; --motion-slow: 0ms; }
   }
   ```
   Since every transition below references these tokens, this single block disables all of them for a person who's set the OS-level preference, with no per-rule exceptions to track.

3. Top-level flow states (drop zone, preview, progress, results): in `main.js`, replace direct `display` toggling between these panels with a class toggle. Give each panel `opacity: 0; transform: translateY(4px); transition: opacity var(--motion-medium) var(--ease-standard), transform var(--motion-medium) var(--ease-standard);` in its hidden state and `opacity: 1; transform: translateY(0);` in its `.is-visible` state. Keep `display: none` on the fully-hidden state for accessibility, but apply it via a `transitionend` listener (or a `setTimeout` matching `--motion-medium`'s value) after the fade-out completes, not synchronously with the class change.

4. Result view switching (Text / Image format / Full image) and filter level switching (Raw / Filtered Text / Coherence Filter): apply the same `.is-visible` cross-fade pattern from step 3 to the result content area when either toggle changes.

5. Filter dimming: add `transition: opacity var(--motion-fast) var(--ease-standard);` to the existing `.is-filtered-out` rule in `style.css`, so toggling between filter levels fades words in and out instead of snapping.

6. Drag and resize, in `editorInteractions.js`: during an active pointer gesture, apply the object's position via `transform: translate(dx, dy)` relative to its gesture-start position, not by repeatedly writing percentage-based `left`/`top` on every `pointermove` (which forces layout on each frame). On `pointerup`, compute the final percentage-based `left`/`top` from the accumulated transform, write those once, and clear the `transform`. Add `will-change: transform` to the object at gesture start and remove it at gesture end, so the hint doesn't sit on every object permanently.

7. Touch feedback: add `-webkit-tap-highlight-color: transparent;` to buttons and toggle controls in `style.css`, removing the default flash, and replace it with an intentional pressed state: `button:active, .toggle-btn:active { transform: scale(0.97); transition: transform 80ms var(--ease-standard); }`.

8. Add `@capacitor/haptics` as a dependency. In `main.js` and `editorInteractions.js`, gated behind `Capacitor.isNativePlatform()`: fire `Haptics.impact({ style: ImpactStyle.Light })` on object selection, on completing a drag or resize gesture, and on toggling a filter level; fire `Haptics.impact({ style: ImpactStyle.Medium })` on delete and on scan completion.

9. Progress bar: change its width transition from an instant jump to `transition: width var(--motion-medium) linear;` in `style.css`, so the displayed percentage interpolates between the pipeline's discrete reported stages (raw pass, preprocessed pass, region pass) instead of jumping.

10. Add `overscroll-behavior: contain;` to the app's main scrollable container so an over-scroll at the top or bottom doesn't visibly rubber-band content behind it. Check for and remove any leftover `-webkit-overflow-scrolling: touch` rules, modern WKWebView doesn't need them and they can conflict with the containment behavior.

11. Keyboard avoidance: when a contenteditable word span receives focus on the native build, call `scrollIntoView({ behavior: 'smooth', block: 'center' })` on it rather than relying on the browser's default (often abrupt) scroll-into-view when the software keyboard appears.

12. Add a line item to `docs/DEVICE-VERIFICATION-CHECKLIST.md` (from Phase 8): "Drag, resize, mode switching, and view/filter toggling feel continuous, not snapped or laggy, on a real device." This is a real check, not a formality, several of the changes in this phase (haptics, the keyboard-avoidance scroll, the pinch/drag transform handling under load) can only be judged on physical hardware, the same limitation noted in Phase 8 itself.

**Done when:** every transition added above respects `prefers-reduced-motion`; drag and resize use `transform` during the gesture and commit final position only once, on release; haptics fire on native and are absent (not erroring) on web; the new device-checklist line item is checked on a real device, not just visually inspected in a simulator.

---

## Phase 18 — Update analysis.md to reflect the finished state (P0, depends on Phases 8-17)

Do not start this phase until every other phase in this document has met its own "Done when" criteria. This phase produces the third revision of the architecture and security analysis, in the same format and with the same rigor as the two that precede it.

1. Read the current `analysis.md` (the 2026-08-29 post-completion-plan revision) in full, and read the git log for every commit made across Phases 8 through 17.

2. Write a new revision of `analysis.md`, following the exact structure of the prior two revisions: an executive summary opening with a severity/status table that maps every finding from this document's §5 ("What's actually left" in the prior revision) to its resolution status now, a folder structure section reflecting every new file this plan added (`docs/DEVICE-VERIFICATION-CHECKLIST.md`, `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md`, `.github/workflows/ci.yml`, `test/TUNING-2.md`, the motion tokens in `style.css`, the haptics wiring), an updated system design section covering the positioning bug's actual resolution (fixed or ruled out, per Phase 9's outcome) and the CI pipeline, an updated UI/UX section documenting the Phase 17 motion and haptics work with the same before/after rigor the existing §2.6 and §2.7 used for colour sampling and inpainting (cite the `render-fidelity.js` numbers, the device checklist results, not just a description of what was added), an updated security section reflecting the custom domain migration and the real network capture from Phase 8, and a closing "what's actually left" section in the same spirit as the current §5, since some open items are likely to remain even after this pass, name them plainly rather than implying the app is now finished.

3. Every claim in the new revision must cite an artifact that exists in the repo as of the revision's commit hash, exactly as the prior two revisions did, no claim of "verified" or "fixed" without a linked test file, log, checklist, or measured number. If something in this plan was attempted and didn't work (as happened with the ML Kit telemetry opt-out and the font-weight detection in the prior revision), write that down the same way, a null result is a finding, not an omission.

4. Preserve the prior two revisions rather than overwriting their content: move the current `analysis.md` to `docs/archive/analysis-2026-08-29.md` (the 2026-08-28 original should already be archived alongside it, confirm it is) before writing the new one to `analysis.md` at its existing location.

5. Update `HANDOFF.md` to point at the new revision and briefly summarize, in a few sentences, what changed since the last handoff, following its own existing convention.

**Done when:** `analysis.md` is a complete third revision meeting the citation standard in step 3; both prior revisions are preserved under `docs/archive/`; `HANDOFF.md` points at the current state.

---

## Non-goals

- No App Store submission as part of this plan. Phase 8's device install is a development-profile install for verification, not a release.
- No new analytics or telemetry of any kind beyond the user-triggered, opt-in export in Phase 15.
- No implementation of the Vision framework migration. Phase 16 produces a scope document only.
- No changes to the recognition pipeline's thresholds outside the rule defined in Phase 11 step 4. A change that doesn't clear that bar does not ship, regardless of how plausible it looks.
- No motion or haptic addition in Phase 17 that ignores `prefers-reduced-motion`. There are no exceptions to the single global media query in step 2, individual transitions do not get their own opt-out.
- No writing Phase 18's `analysis.md` revision early or incrementally as other phases land. It is a single closing pass over the finished state, not a running log, that's what `HANDOFF.md` and the individual phase artifacts (`TUNING-2.md`, `PRIVACY-DECISIONS.md`, the device checklist) are already for.
