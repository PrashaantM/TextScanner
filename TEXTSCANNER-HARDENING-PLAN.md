# TextScanner Completion Plan — Web-Provable First, Device Confirmation Last

**Source:** builds on the 2026-08-29 post-completion architecture review (`ANALYSIS.md`, commit `7ff391e`), specifically §5 ("What's actually left"), and supersedes the earlier device-first ordering of this document.

**What changed and why:** the previous revision opened with a physical-device verification pass and made the ML Kit positioning bug (§5.2, the oldest open item in the project) depend on a device dump. That ordering was wrong on two counts. It blocked the single most important remaining bug behind hardware, and it put discovery work at the point in the schedule where you least want surprises. This revision inverts it: **everything is closed, proven, and gated in CI on the web first; the device pass is the last step and is confirmation-only.** By the time you pick up a phone, nothing should be undetermined — the phone run either confirms what the automated gates already assert, or it finds a defect that becomes a new gate before release.

---

## What "no gaps" means here, precisely

You asked for completion with guaranteed success across all uses and no gaps. Stated as an absolute that is not something any plan can honestly promise — no test suite proves the absence of all bugs, and a plan that claims otherwise is just moving the risk somewhere you can't see it. What this plan *does* commit to, which is the useful version of that request:

1. **Every code path that can be exercised without hardware has an automated gate**, and that gate runs in CI on every push. Not "was tested once" — continuously enforced.
2. **Every remaining item is closed by evidence, not by inspection.** A phase is done when a test file, a measured number, or a committed artifact says so.
3. **The device pass discovers nothing.** It confirms. Each of its checks maps to an automated gate that already passes, so a device failure is a *contradiction* to investigate, not an open question being answered for the first time.
4. **Residual risk is named, not hidden.** §"Known residual risk" at the end lists what remains genuinely unverifiable and why. That list is short, and it is the honest remainder rather than a gap left by omission.

That is a complete project. It is not a proof of universal correctness, and the plan does not pretend to be one.

---

## Current state (verified against the repo, 2026-09-09)

Substantial parts of the previous revision already landed in commit `fc82803`. Verified present:

| Previously planned | Status in repo |
|---|---|
| CI pipeline (`.github/workflows/ci.yml`) | **Landed**, with more steps than specified — also runs `malformed-input.js`, `exif-orientation.js`, `move-inpaint.js` |
| Input hardening (EXIF, malformed input) | **Landed** — `test/exif-orientation.js`, `test/malformed-input.js`, `test/images/exif-orientations/`, `test/images/malformed/` |
| Move/inpaint gap fix | **Landed** — `test/move-inpaint.js` |
| Diagnostic export | **Landed** — `js/diagnostics.js`, `@capacitor/device` + `@capacitor/share` in `package.json` |
| Motion polish + haptics | **Landed** — `js/haptics.js`, `@capacitor/haptics` in `package.json` |
| Device checklist document | **Landed** — `docs/DEVICE-VERIFICATION-CHECKLIST.md` (unexecuted) |

Genuinely outstanding: the positioning bug, the benchmark corpus, the Vision scope document, the custom domain, App Store preparation, the `ANALYSIS.md` revision, and the device run itself. Those are Phases 1 through 9 below.

**Three corrections to the previous revision, found by reading the code rather than trusting the plan:**

- **`buildBboxMapper` is not on the ML Kit path at all.** [`mlkitEngine.js:143`](js/mlkitEngine.js#L143) returns `flattenBlocks(result.blocks)` directly into the editor with no coordinate mapping whatsoever. `buildBboxMapper` is called only from [`ocrEngine.js:373`](js/ocrEngine.js#L373), the Tesseract path. The old Phase 9 step 4 ("extend `buildBboxMapper` to accept a quad") pointed at a function ML Kit never touches. Phase 1 below fixes that misdirection.
- **`replay-dump.js` has no `--variant` flag.** Its usage is `node test/replay-dump.js <dump.json> [imageDir]`, and it renders all three variants (`raw`, `corner`, `fitted`) in a single run. The old Phase 9 step 1's three commands would all have failed.
- **The variant is named `corner`, not `cornerPoints`** ([`replay-dump.js:62`](test/replay-dump.js#L62)).

---

## Phase order

**Part I — Close everything on the web (Phases 1–4).** No hardware. Every phase ends in a CI gate.
**Part II — Release readiness (Phases 5–7).** Domain, store preparation, documentation.
**Part III — Device confirmation and release (Phases 8–9).** The phone, last.

| # | Phase | Tier | Was |
|---|---|---|---|
| 1 | Close the ML Kit positioning bug offline | P0 | 9 |
| 2 | Benchmark corpus expansion + re-tune | P0 | 11 |
| 3 | Coverage completion audit | P0 | new |
| 4 | Vision framework migration scope document | P2 | 16 |
| 5 | Custom domain migration | P1 | 14 |
| 6 | App Store submission preparation | P0 | new |
| 7 | `ANALYSIS.md` revision — the web-complete state | P0 | 18 (part) |
| 8 | Physical device confirmation pass | P0 | 8 |
| 9 | Release close-out | P0 | 18 (part) |

Phase 4 depends on Phase 1. Phase 8 depends on Phases 1–7. Phase 9 depends on Phase 8. Everything else is independent.

---

# Part I — Close everything on the web

## Phase 1 — Close the ML Kit positioning bug offline (P0)

This is the oldest open item in the project and the one the previous revision wrongly blocked behind a device. It does not need a device. ML Kit's output is just JSON with a known schema, and the schema is already documented by the code that writes it ([`mlkitDebug.js:99`](js/mlkitDebug.js#L99)) and the code that reads it ([`replay-dump.js:115`](test/replay-dump.js#L115)):

```
{ scans: [ { label, naturalWidth, naturalHeight, rawResult: { blocks, text }, imageByteLength, extent } ] }
```

Anything with that shape replays through the real renderer. So generate fixtures with known-correct geometry, push them through the actual production code path, and assert analytically. A synthetic fixture is *better* than a device dump for this purpose, because a device dump has no ground truth — you can only eyeball whether it looks right, which is exactly the ambiguity that left this bug open for months. A synthetic fixture knows where every word belongs to the pixel.

### 1.1 Establish the coordinate contract

Write `test/unit/mlkit-geometry.test.js`. First assert the contract that [`renderImageFormatView`](js/editorObjects.js#L876) actually imposes: word bboxes must be in **original-image pixel space**, bounded by `naturalWidth` × `naturalHeight`. Add an assertion that `flattenBlocks`' output for a known input satisfies that bound. This test is the thing that has been missing — there is currently no assertion anywhere that ML Kit's coordinate space matches the renderer's.

Export `flattenBlocks` from `mlkitEngine.js` so it can be tested directly. It is currently module-private; exporting it for test is the same justification already written into [`ocrEngine.js:134`](js/ocrEngine.js#L134) for `transformBboxCorners`.

### 1.2 Build the fixture generator

Write `test/make-mlkit-fixture.js`. Given a source image and a list of `{ text, x, y, w, h, rotationDeg }` word placements, it emits a dump-shaped JSON file whose `rawResult.blocks` contains those words as ML Kit would report them — `boundingBox` as `{ left, top, right, bottom }`, and `cornerPoints` as the four-point quad, correctly rotated for any non-zero `rotationDeg`.

Generate at minimum these fixtures, each with ground truth stored alongside:

- **Axis-aligned baseline.** No rotation. Boxes must render exactly where placed.
- **Rotated text**, 15° and 40°. `boundingBox` and `cornerPoints` diverge substantially here — this is the case that distinguishes the two geometries.
- **Portrait image with EXIF orientation 6**, and landscape with orientation 8. See 1.3.
- **Dense small text**, 200+ words, for the ordering and `lineIndex` assignment path.
- **Degenerate cases:** a zero-area box, a box extending past the image bounds, an empty `elements` array, a `cornerPoints` array that is absent or has fewer than 4 points. Each must not throw and must not emit a NaN coordinate.

### 1.3 Test the EXIF hypothesis first — it is the most likely root cause

Before touching the rotation math, test this, because it explains the observed "gibberish" better than anything else and is cheap to rule in or out:

`mlkitEngine.js` sends ML Kit the **raw original file bytes** (blob → base64 → `Filesystem.writeFile` → `processImage`). ML Kit on iOS decodes that file through `UIImage`, which **applies EXIF orientation**. Meanwhile the web layer passes `previewImg.naturalWidth/naturalHeight` from an `<img>` element, which in modern WebKit *also* applies EXIF orientation — but the two apply it to different things at different stages, and the coordinates ML Kit returns are in **its own post-orientation space**.

For a photo shot in portrait with EXIF orientation 6 (rotate 90° CW), ML Kit's coordinate space is transposed relative to the space `renderImageFormatView` renders into. Every word lands rotated 90° and off-image. That is precisely "gibberish," and it would affect phone-camera photos (which almost always carry EXIF orientation) while leaving screenshots and downloaded images (which usually do not) looking fine — a signature worth checking against the original bug reports in `HANDOFF.md`.

Assert this directly: build the orientation-6 fixture, run it through `flattenBlocks`, and check whether the resulting boxes fall within `naturalWidth` × `naturalHeight` or whether they exceed it in the transposed dimension. The repo already has orientation test images at `test/images/exif-orientations/` from the input-hardening work — reuse them rather than making new ones.

### 1.4 Apply the fix indicated by the evidence

Apply exactly the fix the failing test identifies, not a speculative one. In likelihood order:

- **If EXIF orientation is the cause:** normalize orientation before handing bytes to ML Kit. `mlkitEngine.js` should draw the image to a canvas with the orientation correction already written for Phase 12 (in `preprocess.js`), export *that* canvas as the JPEG written to cache, and pass its dimensions as the coordinate space. This makes ML Kit's input and the renderer's coordinate space the same by construction rather than by coincidence. Note the correction in the module header comment, which already documents the file-path reasoning at that level of detail.
- **If rotated text is the cause:** thread `cornerPoints` through `flattenBlocks` instead of discarding it (`el.boundingBox` at [`mlkitEngine.js:96`](js/mlkitEngine.js#L96)), carrying the quad as a `quad` field alongside `bbox` so downstream consumers that only understand axis-aligned boxes keep working. Do **not** route this through `buildBboxMapper` — that function belongs to the Tesseract path and composes a rotation ML Kit never applied.
- **If neither reproduces:** the boxes are correct and the bug is downstream in rendering, or it was fixed incidentally by earlier work. Prove that with a passing fixture suite and record the null result in `ANALYSIS.md` the way the ML Kit telemetry and font-weight investigations were recorded. A null result closes this phase legitimately.

### 1.5 Gate it

Add `node --test test/unit/mlkit-geometry.test.js` to `.github/workflows/ci.yml`. Add a fixture-replay assertion to `render-fidelity.js` so geometry error on the ML Kit path is a tracked number, not a visual impression.

### 1.6 Retire the diagnostic path

Once the fixture suite is the source of truth, delete `js/mlkitDebug.js`, its import at [`mlkitEngine.js:44`](js/mlkitEngine.js#L44), the `recordScan` call in `recognizeImage`, and `test/replay-dump.js`. Remove any `?mlkitDebug=1` / `textscanner.debug.mlkit` handling. Update `docs/PRIVACY-DECISIONS.md` §4.6 to note the diagnostic path is gone and that the fixture suite replaced it.

Keep `test/make-mlkit-fixture.js` and the fixtures — those are the permanent regression assets.

**Done when:** `test/unit/mlkit-geometry.test.js` passes with fixtures covering every case in 1.2; the root cause is identified and fixed, or conclusively ruled out and documented as a null result; `render-fidelity.js` reports a tracked geometry-error number for the ML Kit path; CI runs the new test; `mlkitDebug.js` and `replay-dump.js` no longer exist.

---

## Phase 2 — Benchmark corpus expansion and re-tune (P0)

The corpus is 11 images ([`test/images/`](test/images/)) and the baseline (`test/baseline-2026-08-28.json`) was computed against it. That is too narrow to claim broad correctness, and it is the evidence base every accuracy claim in `ANALYSIS.md` rests on.

1. **You personally:** supply at least 14 new images, 2 each covering: low light, steep skew (>15°), dense small text, a receipt, a street sign, a photo of a screen (moiré), and non-Latin script. Add each to `test/images/` with a ground-truth transcription in `test/groundtruth/` following the existing naming convention (`<name>.txt`).

   Transcribe **completely**, including legible fine print. Three of the original 11 omitted it, which inflated CER on those images and forced the prior analysis to correct for it explicitly. Do not repeat that.

   Shoot these on the phone you will use in Phase 8, so the corpus and the device pass share input characteristics.

2. Re-establish the noise floor: run `test/run-benchmark.js` twice against identical code with no changes between runs, and record the delta as the new noise floor.

3. Run `test/tune-thresholds.js` against the full corpus. Save to `test/TUNING-2.md`, dated, in the format of the existing `test/TUNING.md`.

4. **Merge rule, applied exactly:** merge a threshold change only if the improvement exceeds **twice** the measured noise floor *and* reproduces in a second independent sweep. Otherwise leave the threshold and record the rejection with its numbers, as the original `TUNING.md` did.

5. Write a new dated baseline (`test/baseline-<date>.json`) against the expanded corpus and point CI's `--check-regression` at it. The old baseline is no longer a valid comparison point.

6. Add the non-Latin images as a **known-limitation** case, not a pass/fail case: [`mlkitEngine.js:127`](js/mlkitEngine.js#L127) hardcodes `script: "LATIN"`, documented as a deliberate limitation at [`mlkitEngine.js:34`](js/mlkitEngine.js#L34). Assert current behavior so a future script-selection change shows up as a measured delta.

**Done when:** ≥25 images across the listed categories; `test/TUNING-2.md` exists with full results including rejections; CI regression-checks against the new baseline; non-Latin behavior is asserted as a known limitation rather than silently failing.

---

## Phase 3 — Coverage completion audit (P0)

The work in `fc82803` landed as code but was never audited for completeness against the plan that specified it. Close that loop before calling anything done.

1. **Verify each landed phase against its original "Done when."** For CI, input hardening, move/inpaint, diagnostic export, and motion polish, confirm the acceptance criteria are actually met, not just that a file with the right name exists. Specifically:
   - All 8 EXIF orientations normalize to identical recognized text *and* equivalent geometry (`test/exif-orientation.js`).
   - All four malformed inputs resolve to a `describeScanError()` category with no uncaught throw and no hang (`test/malformed-input.js`).
   - The move/inpaint test asserts vacated pixels match the patch, not the original (`test/move-inpaint.js`).
   - Every motion transition references a `--motion-*` token, and the single `prefers-reduced-motion` block zeroes all of them with no per-rule exceptions.
   - Haptics are gated behind `Capacitor.isNativePlatform()` and are silently absent — not throwing — on web.

2. **Prove the CI gate actually gates.** Deliberately regress a threshold on a throwaway branch, push, confirm the workflow fails, revert, confirm it passes. An untested failure path is not a gate. Record the failing run's URL in the commit message.

3. **Add the missing HEIC case.** Phase 12 specified HEIC input verification and it is the one input-hardening item with no test file. Headless Chromium cannot decode HEIC, so: add the file to `test/images/format-checks/`, write the test to assert a *categorized error* rather than success in CI, and add successful HEIC decoding to the Phase 8 device checklist. Both halves are required — the CI half proves it fails safely, the device half proves it works where it should.

4. **Close the coverage gap on the web-only paths that CI does not currently touch:** the Coherence Filter Claude tier (mock the `api.anthropic.com` response — do not call the real API in CI), the translate-in-place Claude tier, TTS invocation, and the export path in `editorExport.js`. Each needs at least a smoke test asserting it completes and produces the expected shape.

5. **Run the full suite from a clean checkout** (`git clone` to a temp directory, `npm ci`, run everything) to catch anything depending on untracked local state.

**Done when:** every landed phase's acceptance criteria are verified rather than assumed; the CI regression gate is demonstrated failing and recovering on a real push; HEIC is covered on both sides; no web-reachable feature lacks a smoke test; the suite passes from a clean checkout.

---

## Phase 4 — Vision framework migration scope document (P2, depends on Phase 1)

Do not start until Phase 1 has concluded and the positioning bug's status is documented — evaluating a second engine while the first engine's geometry is undetermined makes both results unattributable.

Write `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` containing:

- A mapping from ML Kit's `TextRecognizer` surface as used in `mlkitEngine.js` to `VNRecognizeTextRequest` / `VNRecognizedTextObservation`.
- Confirmation, **checked directly against Vision's `.swiftinterface`**, of whether `VNRecognizedTextObservation` (subclassing `VNRectangleObservation`) exposes `topLeft`/`topRight`/`bottomLeft`/`bottomRight` — the replacement for `cornerPoints`. Answer this definitively, not provisionally.
- Every file that would change: `mlkitEngine.js` (rewritten), the native plugin structure alongside `TextCoherencePlugin.swift`, the `Podfile` (removing `MLKitTextRecognition`), and `scripts/trim-mlkit-scripts.js` (deleted).
- **Whether Vision resolves Phase 1's root cause.** If Phase 1 found EXIF orientation to be the cause, note that Vision has the same class of hazard: it uses a **bottom-left origin** and takes an explicit `orientation:` parameter on `VNImageRequestHandler`. Getting that parameter wrong reproduces the identical bug. Phase 1's fixture suite should be reusable as the migration's acceptance test — say so explicitly, since that is the main argument that this migration is now low-risk.
- A note that migrating removes the ML Kit telemetry question in `ANALYSIS.md` §4.5 by removing the dependency, rather than by finding an opt-out.
- Whether `script: "LATIN"` (Phase 2 step 6) is resolved by Vision's automatic multi-script support. If so, this migration also closes the non-Latin limitation, which materially changes its priority.

This document is the deliverable. Do not implement the migration.

**Done when:** the document exists, answers the corner-point question definitively, and states whether Vision resolves the Phase 1 root cause and the non-Latin limitation.

---

# Part II — Release readiness

## Phase 5 — Custom domain migration (P1)

1. **You personally:** acquire or use a domain/subdomain you control. Add a CNAME record pointing it at `<owner>.github.io`.
2. Add a `CNAME` file at the repo root containing the domain, exactly as GitHub Pages requires.
3. **You personally:** in Settings → Pages, set the custom domain and enable "Enforce HTTPS" once the certificate provisions.
4. Update the API key disclosure copy in the Coherence Filter panel: remove the shared-`github.io`-origin sentence and replace it with the corrected scoping claim. This closes `ANALYSIS.md` §4.3.
5. Update the empty-state copy to note a key entered before the migration must be re-entered, since browser storage does not survive a domain change.
6. Verify the CSP still passes on the new origin, and that no absolute `github.io` URL is hardcoded anywhere (`grep -rn "github\.io" js/ index.html`).
7. Update `docs/PRIVACY-DECISIONS.md` to reflect the closed finding.

**Done when:** the app is reachable at the custom domain over HTTPS; the shared-origin caveat is replaced with the corrected claim; the re-entry notice is present; no hardcoded `github.io` URL remains.

---

## Phase 6 — App Store submission preparation (P0)

Everything required to be submission-ready *before* the device pass, so Phase 8 is the last gate rather than the start of a new work item.

1. **Assets:** app icon at every required size, launch screen, and 6.7"/6.5" screenshots. Generate screenshots from the Simulator against the real app — they do not require a physical device.
2. **Metadata:** name, subtitle, description, keywords, support URL (the custom domain from Phase 5), and marketing URL. The description should say what `README.md` already says about how this differs from Google Lens / Adobe Scan / Live Text.
3. **Privacy nutrition label**, filled from `docs/PRIVACY-DECISIONS.md` rather than written fresh. It must match the privacy manifest committed in Phase 7 of the prior plan (`9f7990a`). Specifically: the Claude API tier transmits text to `api.anthropic.com` and must be declared; on-device tiers must not be declared as collection.
4. **Verify the privacy manifest** (`PrivacyInfo.xcprivacy`) covers ML Kit's SDK requirements, and confirm whether ML Kit ships its own manifest that merges into yours — this is the §4.5 telemetry question in its submission-blocking form.
5. **Build settings:** bump version and build number, confirm the release configuration strips debug symbols appropriately, confirm the signing team is set (it was carried over in `0961852`).
6. **Archive validation:** Product → Archive, then **Validate App** in the Organizer. This runs Apple's submission checks without submitting and catches missing usage descriptions, bad entitlements, and asset problems. Do this now — it needs no physical device and catches most rejections.
7. Confirm `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` (added in `2b89352`) read as user-facing explanations, since Apple rejects generic ones.

**Done when:** Archive → Validate App passes with no errors; all assets and metadata are prepared; the nutrition label is consistent with both the privacy manifest and `docs/PRIVACY-DECISIONS.md`.

---

## Phase 7 — `ANALYSIS.md` revision, web-complete state (P0)

Write the third revision now, against the web-complete state, leaving one explicitly marked section for the device results. This is a change from the previous revision's non-goal, and deliberately: with the device pass moved to confirmation-only, there is nothing left to discover that would restructure the document. Phase 9 fills in one section and adjusts the summary table.

1. Read the current `ANALYSIS.md` in full and the git log across Phases 1–6.
2. Archive first: move the current `ANALYSIS.md` to `docs/archive/analysis-2026-08-29.md` and confirm the 2026-08-28 original is already archived alongside it.
3. Write the new revision following the prior structure: executive summary with a severity/status table mapping every §5 finding to its status; folder structure covering new files (`test/make-mlkit-fixture.js`, the fixtures, `test/unit/mlkit-geometry.test.js`, `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md`, `test/TUNING-2.md`, the new baseline, `CNAME`); system design covering the positioning bug's actual resolution and the CI pipeline; UI/UX covering the motion and haptics work with the same rigor §2.6/§2.7 used for colour sampling and inpainting; security covering the domain migration and the submission-readiness review.
4. **Citation standard, unchanged:** every claim cites an artifact present at the revision's commit. No "verified" or "fixed" without a linked test, log, or measured number. Null results are findings — write them down the way the ML Kit telemetry and font-weight investigations were.
5. Leave a section headed **"Device verification — pending Phase 8"** stating plainly that on-device behavior is unconfirmed at this revision.
6. Close with a "what's actually left" section in the spirit of the current §5. Some items will remain — `script: "LATIN"`, the Vision migration, whatever Phase 8 turns up. Name them plainly rather than implying the app is finished.

**Done when:** `ANALYSIS.md` is a complete third revision meeting the citation standard; both prior revisions are preserved under `docs/archive/`; the device section is present and explicitly marked pending.

---

# Part III — Device confirmation and release

## Phase 8 — Physical device confirmation pass (P0, depends on Phases 1–7)

By now every check below has a passing automated counterpart. **This pass confirms; it does not discover.** A failure here contradicts a green gate, which means the gate is wrong — fix the gate too, not just the symptom.

### 8.1 Network capture — USB, not a Wi-Fi proxy

`ubcsecure` is a locked-down enterprise (802.1x) network. It will not carry a manually configured proxy, and iOS will not let you fully trust a user-installed CA under that network policy. **Do not attempt the mitmproxy Wi-Fi-proxy method.** Capture at the TLS handshake level over USB instead — no proxy, no CA install, works on any network:

1. Connect the iPhone by USB, paired and trusted in Xcode. Get its UDID from Window → Devices and Simulators.
2. Run `rvictl -s <UDID>`. This creates a virtual interface (`rvi0`) mirroring the device's traffic.
3. `brew install --cask wireshark`, capture on `rvi0`, filter `tls.handshake.type == 1`. ClientHello messages carry the destination hostname in the SNI extension **in plaintext** — no decryption, no CA trust needed. Host confirmation is all this phase requires.
4. Leave it running for all of 8.3.

**Fallback if `rvictl` fails to attach** (happens on some Xcode/macOS combinations): share the Mac's connection over Wi-Fi via System Settings → General → Sharing → Internet Sharing, join the phone to *that* network, and use the original mitmproxy-with-CA-trust method — it works there because the network is yours. Record which method was used.

### 8.2 Install

**You personally:** in Xcode, select the registered physical device, Product → Archive, then Organizer → Distribute App → Development, and install directly. Not TestFlight — it adds review latency this pass does not need.

### 8.3 Walk `docs/DEVICE-VERIFICATION-CHECKLIST.md` with the capture running

Each item names the automated gate it confirms:

- **Touch:** drag a word, resize a word, marquee-select. *(Confirms `test/touch-interactions.js`.)*
- **Pinch:** enter Move mode, two-finger pinch. Zoom must work without conflicting with single-finger drag. *(Confirms the `931ddc6` pinch fix.)*
- **Positioning — the important one:** scan 15–20 real photos across lighting, angle, and density, including portrait shots that carry EXIF orientation. For each, confirm word positions match the source. *(Confirms Phase 1. This is where a contradiction would matter most — if Phase 1 concluded EXIF orientation and a portrait photo still misplaces words, the fixture missed a case.)*
- **HEIC:** scan an unconverted HEIC straight from the camera roll. Must succeed on device. *(Confirms the Phase 3 step 3 device half.)*
- **Coherence Filter, on-device tier:** confirm the tier indicator reads "On-device" and the rewrite completes. Repeat in Airplane Mode. If the device is not Apple Intelligence-eligible, mark **"unverified — device not Apple Intelligence-eligible"**; that is a documented gap, not a failure.
- **Translate in place**, on-device tier, Airplane Mode on.
- **Claude tier:** Airplane Mode off, switch to Claude, confirm success and a ClientHello with SNI `api.anthropic.com` in the capture. *(Confirms the Phase 3 step 4 mock matches reality.)*
- **Motion:** drag, resize, mode switching, and view/filter toggling feel continuous, not snapped or laggy. Then enable Settings → Accessibility → Motion → Reduce Motion and confirm transitions are actually disabled. *(Confirms the single `prefers-reduced-motion` block.)*
- **Haptics** fire on selection, gesture completion, filter toggle, delete, and scan completion.
- **Diagnostic export** opens the native share sheet, and the report contains no image data unless the opt-in box is checked. *(Confirms Phase 15's privacy constraint.)*
- **Keyboard avoidance:** tap a contenteditable word near the bottom; it scrolls into view smoothly rather than abruptly.

### 8.4 Export and record

Stop the capture, export as `test/artifacts/device-network-capture-<date>.pcapng`. Ensure `test/artifacts/*.pcapng` is gitignored or the file is safe to commit — an SNI-only capture contains no keys or payloads, so it is safe as-is. If the Internet Sharing fallback produced a full `.mitm` capture, strip `Authorization`/`x-api-key` before committing, or commit only a host-list summary.

Update `docs/PRIVACY-DECISIONS.md` with a "Verified on device (`<date>`)" section listing the observed hosts, confirming or correcting the previously-static claim about native network activity.

### 8.5 Handle contradictions

Any check failing against a green gate: file it, fix it, **and add or fix the automated gate that missed it**, then re-run the affected check. Do not proceed to Phase 9 with an unexplained contradiction.

**Done when:** every checklist item is checked, marked failed with a filed issue, or marked "unverified" with a stated reason; the capture exists; `docs/PRIVACY-DECISIONS.md` has its verified-on-device section; every contradiction is resolved with a corresponding gate fix.

---

## Phase 9 — Release close-out (P0, depends on Phase 8)

1. Fill in `ANALYSIS.md`'s "Device verification" section with Phase 8's actual results — the host list, the checklist outcome, and any contradiction found and what it revealed about the gate that missed it. Update the executive summary's status table.
2. Update the "what's actually left" section with anything Phase 8 surfaced and any item still marked unverified.
3. Update `HANDOFF.md` to point at the new revision, summarizing what changed since the last handoff in its existing style.
4. Submit to App Store Connect using the Phase 6 assets and the archive validated there.
5. Tag the release commit.

**Done when:** `ANALYSIS.md` is complete with real device results; `HANDOFF.md` points at current state; the build is submitted; the release is tagged.

---

## Known residual risk

The honest remainder after all nine phases. These are named, not hidden:

- **Single-device confirmation.** Phase 8 covers one iPhone on one iOS version. Behavior on older devices, smaller screens, and iPadOS is unconfirmed. Mitigation: the Simulator covers layout across sizes; ML Kit and WKWebView behavior does not vary much across recent iOS versions. Real mitigation is post-release feedback via the Phase 15 diagnostic export.
- **Apple Intelligence tier**, if the test device is not eligible. There is no way to verify on-device Coherence Filter and translate without eligible hardware. The code path is smoke-tested and the fallback to the Claude tier is tested, but the on-device path itself may be unconfirmed.
- **`script: "LATIN"`.** Non-Latin recognition is a known limitation, asserted as current behavior in Phase 2 rather than fixed. Phase 4 determines whether the Vision migration closes it.
- **ML Kit telemetry** (`ANALYSIS.md` §4.5) remains researched-and-decided rather than eliminated. Only the Vision migration removes the question.
- **Benchmark corpus scale.** 25 images is a meaningful improvement over 11 and still small in absolute terms. CER/WER figures carry real error bars; the noise-floor discipline in Phase 2 step 4 is what keeps them honest.
- **The Claude API tier depends on a third party.** Availability, latency, and pricing are outside this project's control.

---

## Non-goals

- No implementation of the Vision framework migration. Phase 4 produces a scope document only.
- No new analytics or telemetry beyond the user-triggered, opt-in export.
- No threshold change outside the Phase 2 step 4 rule. A change that does not clear that bar does not ship, however plausible it looks.
- No motion or haptic addition that ignores `prefers-reduced-motion`. No per-transition exceptions to the single global block.
- No treating the device pass as a discovery phase. If Phase 8 is finding new problems rather than confirming known-good behavior, Part I was left incomplete — go back rather than patching forward.
