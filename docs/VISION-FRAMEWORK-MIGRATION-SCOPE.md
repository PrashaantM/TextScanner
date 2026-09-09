# Vision framework migration — scope

**Status: scope only. Nothing here is implemented, and this document does not
recommend implementing it yet.** See "Recommendation" at the end.

**Written:** 2026-09-09, after the ML Kit positioning bug was closed (Phase 1).
That ordering was deliberate: evaluating a second engine while the first
engine's geometry was undetermined would have made both results unattributable.
It is now determined, and this document can say precisely what Vision would and
would not change.

**Verified against:** the iOS 26.5 SDK headers shipped with Xcode 26.6
(`$(xcrun --show-sdk-path --sdk iphoneos)/System/Library/Frameworks/Vision.framework/Headers/`).
Every API claim below was read out of those headers, not recalled and not
inferred from documentation.

---

## 1. The corner-point question, answered definitively

**Yes.** `VNRecognizedTextObservation` inherits the four corner points, and they
are a direct replacement for ML Kit's `cornerPoints`.

From `VNObservation.h`:

```objc
@interface VNRecognizedTextObservation : VNRectangleObservation
- (NSArray<VNRecognizedText*>*) topCandidates:(NSUInteger)maxCandidateCount;
@end

@interface VNRectangleObservation : VNDetectedObjectObservation
@property (readonly, nonatomic, assign) CGPoint topLeft;
@property (readonly, nonatomic, assign) CGPoint topRight;
@property (readonly, nonatomic, assign) CGPoint bottomLeft;
@property (readonly, nonatomic, assign) CGPoint bottomRight;
@end
```

Two differences from ML Kit that the port must handle, and both are exactly the
class of thing that caused the original bug:

1. **The points are normalized (0–1), not pixels.** ML Kit reports pixels.
   Vision ships `VNImagePointForNormalizedPoint(point, width, height)` in
   `VNUtils.h` to convert.
2. **Vision's origin is bottom-left; the image, the web layer and CSS are all
   top-left.** So `y` must be flipped (`1 - y` before denormalizing, or
   `height - y` after). `VNImagePointForNormalizedPoint` does **not** flip for
   you — it only scales.

Get either wrong and every word lands mirrored vertically. That is a different
symptom from the bug Phase 1 fixed, but the same category, and it is caught by
the same test — see §5.

---

## 2. Surface mapping

| ML Kit, as used in `js/mlkitEngine.js` | Vision |
|---|---|
| `TextRecognizer.textRecognizer(options:)` | `VNRecognizeTextRequest` |
| `VisionImage(image:)` + `.orientation` | `VNImageRequestHandler(cgImage:orientation:options:)` |
| `textRecognizer.process(_:completion:)` | `handler.perform([request])` (synchronous, throws) |
| `Text.blocks` → `TextBlock.lines` → `TextLine.elements` | `request.results` → `[VNRecognizedTextObservation]` — **lines only, see §3** |
| `element.text` | `observation.topCandidates(1).first?.string` |
| `element.boundingBox` (pixels, top-left origin) | `observation.boundingBox` (normalized `CGRect`, bottom-left origin) |
| `element.cornerPoints` (pixels) | `observation.topLeft` / `.topRight` / `.bottomLeft` / `.bottomRight` (normalized, bottom-left origin) |
| *(nothing — ML Kit exposes no confidence)* | `VNRecognizedText.confidence`, a `VNConfidence` in `[0.0, 1.0]` |
| `script: "LATIN"` (one bundled model per script) | `recognitionLanguages` + `automaticallyDetectsLanguage` (iOS 16+) |

---

## 3. The one genuinely hard problem: Vision has no word level

This is the finding that most affects the migration's cost, and it is not
visible from the API summary above.

**ML Kit returns a three-level hierarchy — block → line → element — where an
"element" is a word.** `flattenBlocks` walks straight to the elements and this
app's entire editor is built on per-word objects: every recognized word is a
separately selectable, draggable, editable span with its own sampled ink colour
and its own inpaint patch (`js/editorObjects.js`).

**Vision returns line-level observations only.** `VNRecognizeTextRequest.results`
is `[VNRecognizedTextObservation]`, and each observation is a line of text. There
is no word-level observation type in the framework.

The only route to per-word geometry is `VNRecognizedText`:

```objc
- (nullable VNRectangleObservation *)boundingBoxForRange:(NSRange)range error:(NSError**)error;
```

You would split the line's `string` into words yourself, compute each word's
`NSRange`, and call `boundingBoxForRange:` per word. That works, but the header
carries an explicit warning:

> The bounding boxes are not guaranteed to be an exact fit around the characters
> and are purely meant for **UI purposes and not for image processing**.

This app does both. It positions UI (fine) *and* samples source pixels inside
each word's box to recover ink colour, decide whether a backing box is needed,
and generate the inpaint patch that covers the word when it is edited
(`sampleInkAppearance`, `sampleNearbyColor`, `computeInpaintedPatch`). Those are
image processing, on boxes Apple declines to guarantee.

**Cost:** a per-word range walk, plus `NSRange` handling that has to be correct
for composed characters and non-Latin scripts, plus an unquantified accuracy
risk on the colour-sampling and inpainting paths. This is the single largest
line item in the migration and the main reason the recommendation below is "not
yet".

---

## 4. Files that would change

| File | Change |
|---|---|
| `js/mlkitEngine.js` | Rewritten as `visionEngine.js`. `flattenBlocks`, `normalizeQuad`, `quadGeometry` survive nearly intact — they consume a quad and know nothing about which SDK produced it. The plugin call, the normalization, and the y-flip are new. |
| `js/recognize.js` | One import swap. The dispatch itself is `isNativePlatform()` and needs no change. |
| A new native plugin | Alongside `ios/App/App/TextCoherencePlugin.swift`, following the same `CAPPlugin` shape. Replaces the whole `@capacitor-mlkit/text-recognition` dependency; roughly the 60 lines of `TextRecognition.swift` plus the range walk from §3. |
| `ios/App/Podfile` | `MLKitTextRecognition` removed. Vision is part of the OS — no pod, no bundled models. |
| `scripts/trim-mlkit-scripts.js` | Deleted. It exists solely to strip four unreachable ML Kit script models; with no ML Kit there is nothing to strip. |
| `package.json` | `@capacitor-mlkit/text-recognition` removed, along with the `postinstall` hook that runs the trim script. |
| `js/recognize.js` (again) | `engineProvidesConfidence()` currently returns `false` on native because ML Kit exposes no score. Vision does expose one — see §6. |
| `docs/PRIVACY-DECISIONS.md` | The "Binary contents" section is about trimming ML Kit's models and would be replaced by a much shorter note. |

---

## 5. Does Vision resolve Phase 1's root cause?

**The root cause: no. The bug: yes, already — and Phase 1's fix is engine-agnostic.**

Phase 1 found that the misplacement was **not** EXIF orientation. It was
axis-aligned-envelope inflation: `flattenBlocks` discarded `cornerPoints` and
`renderImageFormatView` derived each word's font size and origin from the
envelope around the tilted word rather than the word itself. For a word of true
size `w × h` tilted `t` degrees the envelope's height is `h·cos(t) + w·sin(t)` —
**2.12× the correct font size at 15°, 3.18× at 40°, and exactly 1.00× at 0°**
(`test/unit/mlkit-geometry.test.js`). That matched the reported symptom exactly:
gibberish on the angled posters, "really good" on the flat-on screenshots.

Vision would not have prevented that. `VNRecognizedTextObservation` exposes both
a `boundingBox` and four corner points, precisely as ML Kit does, and a port that
read the bounding box and ignored the corners would reproduce the identical bug
with the identical arithmetic.

**Vision does carry the same class of hazard, in two forms:**

- **`orientation:` on `VNImageRequestHandler`.** Every initializer takes a
  `CGImagePropertyOrientation`, documented as "an integer from 1 to 8" that
  "**supersedes every other orientation information**". Pass the wrong value and
  every word is rotated and off-image — the failure mode Phase 1.3 hypothesized
  and ruled out for ML Kit. The mitigation already in the tree applies
  unchanged: `js/mlkitEngine.js`'s `encodeUprightJpeg` re-encodes the decoded
  image as an upright, EXIF-free JPEG before the native side sees it, so the
  correct value is `.up` **by construction** rather than by getting a lookup
  table right.
- **The bottom-left origin** (§1). New, and specific to Vision.

**The acceptance test already exists.** `test/make-mlkit-fixture.js` generates
recognition results with exact ground truth, and
`test/unit/mlkit-geometry.test.js` plus the fixture replay in
`test/render-fidelity.js` assert placement analytically. Neither is coupled to
ML Kit beyond the fixture's field names: point the generator at Vision's shape
(normalized, y-flipped) and the same 232-word corpus becomes the migration's
acceptance suite, including a y-flip regression the moment one is introduced.

**This is the main argument that the migration is now low-risk**, and it is why
this document was scheduled after Phase 1 rather than before it. Before the
fixture suite existed, the only way to judge a migration was to run it on a
phone and look. Now a wrong coordinate is a failing number in CI.

---

## 6. What Vision closes that ML Kit cannot

**`script: "LATIN"` — closed.** `js/mlkitEngine.js` hardcodes Latin because ML
Kit needs a separate bundled model per script with no auto-detect option. Vision
takes `recognitionLanguages` and, since iOS 16, `automaticallyDetectsLanguage`,
with the supported set queryable at runtime via
`-supportedRecognitionLanguagesAndReturnError:`. Revision 3 is documented as
supporting all earlier revisions' languages plus more, and as improving
"recognition capabilities for rotation and handwriting".

This **materially raises the migration's priority**: it converts the non-Latin
limitation from "known gap, asserted as current behaviour" into "resolved", and
it does so without shipping a single extra byte, because Vision is part of the
OS. The plan's Phase 2 step 6 assertion becomes the regression test for it.

**Per-word confidence — closed, and this one is a UI change.** ML Kit exposes no
confidence at all, which is why `NO_CONFIDENCE_SIGNAL` is `null`, why
`engineProvidesConfidence()` returns `false` on native, and why the
low-confidence underline never appears there. `VNRecognizedText.confidence` is a
real score in `[0.0, 1.0]`. Migrating would light up the low-confidence
underline on native for the first time — a genuine feature gain, and one that
needs `LOW_CONFIDENCE_THRESHOLD` (currently 65, calibrated against Tesseract's
0–100 scale) re-checked against Vision's distribution rather than rescaled by
arithmetic.

**ML Kit telemetry (`ANALYSIS.md` §4.5) — closed by removal.** The open question
is whether ML Kit's SDK phones home and whether that is disclosable. Migrating
does not answer it; it **deletes** it, along with the third-party SDK, the
CocoaPods dependency, the bundled models, and the trim script that exists to
manage them. Vision is a first-party framework already covered by the OS
privacy posture, and there is no third-party SDK left to declare in
`PrivacyInfo.xcprivacy`.

**Binary size.** The ML Kit pod plus `LatinOCRResources.bundle` is what took the
build from 56 MB to 49 MB after trimming four unreachable models. Vision adds
nothing to the binary. The saving is larger than the trim was.

---

## 7. What it would cost, and what it would risk

| | |
|---|---|
| **Removes** | A third-party SDK, a CocoaPods dependency, ~49 MB of bundled models, `scripts/trim-mlkit-scripts.js`, the `postinstall` hook, and the §4.5 telemetry question |
| **Gains** | Multi-script recognition, per-word confidence, Apple's rotation/handwriting improvements |
| **Costs** | A hand-written native plugin, the per-word range walk (§3), a y-flip and a denormalization |
| **Risks** | Per-word boxes Apple explicitly does not guarantee for image processing, feeding this app's colour sampling and inpainting; recognition accuracy against the corpus is unmeasured and could be worse |
| **Floor** | **iOS 16 for `automaticallyDetectsLanguage`, and the project's deployment target is iOS 15.5** (`ios/App/Podfile`, confirmed 2026-09-09) — so at the current floor it is *not* available. Either raise the target to 16, or set `recognitionLanguages` explicitly and lose auto-detection. Not a blocker, but it is a real cost that §6's non-Latin argument has to absorb. |

---

## 8. Recommendation

**Do not migrate yet. Migrate when there is a measured accuracy comparison and
the §3 problem has a tested answer.**

The case for migrating is strong on every axis except the one that matters most:
nobody has measured whether Vision reads this app's corpus as well as ML Kit
does. Everything in §6 is worthless if CER gets worse, and the plan's Phase 2
step 4 discipline — an improvement must clear twice the measured noise floor and
reproduce — should apply to an engine swap at least as strictly as it applies to
a threshold.

The order that would make this decidable:

1. Expand the benchmark corpus (the plan's Phase 2), so there is a real
   comparison basis including non-Latin images.
2. Build a throwaway Vision plugin that runs both engines on the same image and
   dumps both results. Measure CER/WER against the corpus.
3. Settle §3 on real output: how far do `boundingBoxForRange:` boxes sit from ML
   Kit's element boxes, and does colour sampling survive the difference?
4. If Vision wins or ties on accuracy and §3 is tolerable, migrate — with the
   Phase 1 fixture suite, re-pointed, as the acceptance gate.

Steps 2 and 3 need a physical device. Step 1 does not.
