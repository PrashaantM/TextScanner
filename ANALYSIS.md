# TextScanner — Architecture, Design & Security Analysis

**Date:** 2026-08-28 · **Commit:** `931ddc6` · **Branch:** `main`
**Scope:** folder structure, system design, UI/UX design, security. Assessment of the code as it stands, not a plan — for the roadmap and current blockers see [HANDOFF.md](HANDOFF.md).

---

## 0. Executive summary

TextScanner is a **zero-build, dependency-light, local-first OCR and image-text-editing app**: ~3,200 lines of vanilla ES-module JavaScript deployed straight to GitHub Pages, wrapped in a Capacitor iOS shell that swaps Tesseract.js for native Google ML Kit behind a single dispatch seam.

**What's genuinely strong**

- A **clean layered module design** with an explicit dependency-inversion pattern (hook registration) that keeps the editor free of engine, inpainting, and network concerns.
- A **single-seam engine abstraction** ([js/recognize.js](js/recognize.js)) — swapping OCR engines touched no caller.
- A **"can only help" recognition pipeline**: every enhancement pass is scored against the previous best and discarded if it loses.
- **Unusually honest product copy** — the README and in-app hints state limitations (handwriting, accuracy vs. Google Lens, what leaves the device) rather than hiding them.
- **No injection surface**: `textContent` everywhere, zero `innerHTML`/`eval`/`document.write`.

**Where it's weakest**

| # | Finding | Area | Severity |
|---|---|---|---|
| 1 | CDN script has **no SRI and no CSP** — a jsDelivr compromise gets the DOM, all image data, and the stored API key | Security | **High** |
| 2 | API key in `localStorage` on a **shared `*.github.io` origin** with every other project the author publishes | Security | **High** |
| 3 | Editor is **mouse-event-only** — drag, resize and marquee do not work by touch, on an iOS-first product | UX / Design | **High** |
| 4 | Native build still **fetches Tesseract.js from a CDN at launch** despite never using it | Security / Design | Medium |
| 5 | ML Kit pulls **GoogleDataTransport/GoogleUtilities telemetry**, unqualified against the "nothing leaves your device" claim | Security / Privacy | Medium |
| 6 | Diagnostic dump persists **full recognized text of every scan** to Documents | Security / Privacy | Medium |
| 7 | **No keyboard path** through the editor; resize handle is an unlabeled 11px div | Accessibility | Medium |
| 8 | Benchmark harness depends on a **symlinked, borrowed Playwright** and a hardcoded Chromium path | Design / Testing | Medium |
| 9 | Drag loop is **O(objects) per mousemove** with full DOM class reconciliation | Design / Perf | Low |
| 10 | No app-level **Apple privacy manifest** (`PrivacyInfo.xcprivacy`) — App Store blocker | Security / Release | Low (now) |

---

## 1. Folder structure

### 1.1 Layout

```
TextScanner/
├── index.html                  ← the app shell (182 lines), heavily commented
├── style.css                   ← all styling (612 lines), CSS custom properties
├── js/                         ← 14 ES modules, ~3,200 LOC, no bundler
├── www/                        ← GENERATED, gitignored — Capacitor's webDir
├── ios/                        ← Capacitor iOS shell (87 tracked files; Pods untracked)
├── test/                       ← Playwright benchmark, CER/WER metrics, ground truth
├── legacy-opencv-scripts/      ← origin-story Python + the 11-image test corpus
├── scripts/sync-web-assets.sh  ← root → www/ copy, the only "build" step
├── capacitor.config.json       ├─ native config
├── package.json                ├─ exists *only* to drive `npx cap`
├── README.md                   ├─ user-facing
├── HANDOFF.md                  └─ session-to-session engineering state
```

### 1.2 The one-source-of-truth rule

The repo root **is** the web app. There is no `src/` and no build output, because the app deploys to GitHub Pages as-is. Capacitor needs a `webDir`, so [scripts/sync-web-assets.sh](scripts/sync-web-assets.sh) does a plain recursive copy into `www/`, and `cap sync` copies that again into `ios/App/App/public/`.

**Consequence: three copies of the web app exist on disk.** Only the root is source; `www/` and `ios/App/App/public/` are both gitignored build artifacts. This is correctly documented in the `.gitignore` and the sync script — but it is a real footgun, and there is currently drift proving it: `www/js/textUtil.js` and `ios/App/App/public/js/textUtil.js` exist while `js/textUtil.js` does not. A deleted module is still sitting in both generated trees because `cap sync` copies without pruning. It is inert (nothing imports it), but it means the stale trees are not trustworthy for reading.

### 1.3 Naming and cohesion

`js/` is flat with 14 modules and no subdirectories. At this size that's the right call — a `js/engines/`, `js/ui/`, `js/imaging/` split would add path noise for no navigational gain. The modules are cohesive and single-purpose:

| Module | LOC | Role |
|---|---|---|
| `editor.js` | 1032 | View/controller for the Image-format & Full-image surface |
| `main.js` | 555 | Bootstrap and wiring |
| `ocrEngine.js` | 403 | Tesseract.js pipeline |
| `preprocess.js` | 252 | Canvas pixel work |
| `perspective.js` | 200 | Keystone correction |
| `mlkitEngine.js` | 144 | Native ML Kit path |
| `inpaint.js` | 130 | Harmonic diffusion fill |
| `coherence.js` | 122 | Claude API call |
| `filter.js` | 89 | Raw / Filtered predicates |
| `tts.js` | 90 | SpeechSynthesis wrapper |
| `mlkitDebug.js` | 92 | **Temporary diagnostic** |
| `dom.js` | 60 | Element registry |
| `state.js` | 47 | Shared store + constants |
| `recognize.js` | 24 | Engine dispatch |

`editor.js` at 1,032 lines is the only module carrying more than one responsibility (object model + selection + drag/resize + undo/redo + text extraction + canvas export). It is the natural next split — `editorObjects.js` / `editorInteractions.js` / `editorExport.js` — but it is internally well-sectioned with banner comments, so this is a maintainability nudge, not a defect.

**`legacy-opencv-scripts/` is misnamed for what it now does.** It holds two throwaway Python files *and* the entire 11-image benchmark corpus that `test/` scores against. The test data's home being a folder named "legacy" is a discoverability trap. Splitting it into `test/images/` + `docs/origins/` would cost one commit.

### 1.4 Documentation as a first-class artifact

Unusual and worth naming: **the comments carry the reasoning, not the mechanics.** Nearly every module opens with a header explaining *why the approach was chosen and what was rejected* — the OpenCV.js main-thread freeze that killed the WASM plan ([js/preprocess.js](js/preprocess.js), [js/inpaint.js](js/inpaint.js)), why `file://` URIs are passed unstripped to ML Kit ([js/mlkitEngine.js](js/mlkitEngine.js)), why block-granularity reading-order sorting beats word-level ([js/ocrEngine.js](js/ocrEngine.js)). Each threshold constant is annotated with the failure it prevents. This is the repo's best-maintained asset, and combined with `HANDOFF.md` it makes the project resumable cold — which is exactly what it's been used for.

---

## 2. System design

### 2.1 Layer map

```
                       index.html  (static structure, ids/classes)
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
     dom.js             state.js             style.css
  (element registry) (mutable store +      (visual layer, reads
   looked up once)    tuning constants)     the same ids/classes)
        │                   │
        └─────────┬─────────┘
                  │
   ┌──────────────┼───────────────┬─────────────────┐
   │              │               │                 │
recognize.js   filter.js      editor.js          tts.js
 (dispatch)   (pure preds)  (view/controller)  (speech FSM)
   │                             │
   ├── ocrEngine.js ─── preprocess.js
   │   (Tesseract)  └── perspective.js
   └── mlkitEngine.js ── mlkitDebug.js  [temporary]
       (native ML Kit)
                  │
               main.js  ── coherence.js (the only network call)
            (bootstrap: wires everything, owns inpaint.js cache)
```

### 2.2 The central architectural idea: hook registration

`editor.js` is the biggest module and would naturally accumulate dependencies on inpainting, the Claude API, and the patch cache. It doesn't — because `main.js` injects behaviour into it through registration setters:

```js
setPatchProvider(fn)        // "how do I fill a deleted word's old spot?"
setPatchCanvasProvider(fn)  // "…and for PNG export?"
setDeleteHandler(fn)        // "what does Delete mean for this selection?"
setFilterTextHook(fn)       // "what text is active at this filter level?"
setAddTextClickHandler(fn)  // "a click landed in add-text mode"
configureUndoHooks({...})   // "recreate/destroy an object for undo"
```

This is dependency inversion done without a framework, and it works: `editor.js` imports nothing from `inpaint.js`, `coherence.js`, or the patch cache. Undo/redo, in particular, becomes uniform — one snapshot/reconcile mechanism ([editor.js:230-300](js/editor.js#L230)) covers moves, resizes, text edits, additions *and* deletions, because object recreation is delegated back to `main.js`.

**The trade-off is honest but real:** these are module-level mutable singletons with no compile-time guarantee they're wired. `editor.js` guards each (`if (onPatchNeeded)`), so an unwired hook degrades silently rather than throwing. Initialization order in `main.js` is load-bearing and undocumented as a contract. At this scale that's acceptable; a fourth consumer would justify a small explicit registry.

### 2.3 State model

[js/state.js](js/state.js) is a single exported mutable object, deliberately (the header explains why: ES module `let` exports can't be reassigned from outside). Every module mutates `state.x = y` in place.

- **Pro:** trivially inspectable, no framework, no reactivity cost, and the comment discipline keeps intent clear.
- **Con:** no change notification, so keeping views in sync is manual and by convention. `refreshModifiedStates()` is the de facto reconciler and is called from eight places. `applyFilterLevel()` in `main.js` is documented as "the single place that applies a filter level change" — an invariant enforced by comment, not by code.
- **Con:** two overlapping representations of the same scan coexist — `state.ocrWords` (immutable source of truth) and `state.editorObjects` (live, DOM-backed). `getActiveResultText()` has to choose between them based on active mode ([editor.js:735-780](js/editor.js#L735)). The rule is sound (image views read DOM, text view reads `ocrWords`), but it is the app's subtlest piece of logic.

### 2.4 Recognition: a scored-candidate pipeline

The Tesseract path in [js/ocrEngine.js](js/ocrEngine.js) is the most sophisticated part of the system, and its design principle is stated explicitly: **preprocessing can only help, never hurt.**

```
1. Raw pass (PSM.AUTO, rotateAuto)                    → best
2. if mean confidence < 70  → preprocessed pass       → keep if it scores higher
3. if 0 words or conf < 40  → PSM.SPARSE_TEXT retry   → keep if it scores higher
4. if conf < 85 → per-region reprocessing, ≤16 weakest regions:
     crop (+6px margin) → keystone-detect from line geometry → warp
     → contrast-normalize (+ edge-binarize if background is textured)
     → re-recognize at PSM tuned to region aspect ratio
     → keep only if confidence rose AND ≥50% of word count survived
5. flattenRegions() with block-granularity reading-order sort
```

Every stage is gated on measured score, and each guard encodes a specific observed failure — the `MIN_REGION_WORD_COUNT_RATIO` guard exists because merged multi-column blocks collapse into "confidently wrong" merged words; the `MAX_ZERO_WORD_REGION_AREA_FRACTION` guard exists because a poster's illustration area got hallucinated into text. This is empirically-derived engineering, not speculative complexity.

**Cost:** worst case is roughly 1 + 1 + 1 + (16 × 2) = 35 `recognize()` calls on the main thread for one hard image. Bounded, but unbudgeted — there is no time cap, only a count cap.

**Coordinate handling** is careful: `buildBboxMapper` composes an inverse rotation about the image centre with an inverse upscale, and `transformBboxCorners` re-fits an axis-aligned box around four transformed corners rather than transforming a rect naively. The region path composes crop offset ∘ unwarp ∘ inverse-scale correctly.

### 2.5 Engine abstraction

[js/recognize.js](js/recognize.js) is 24 lines and is the whole abstraction:

```js
if (window.Capacitor?.isNativePlatform?.()) return recognizeWithMlKit(...);
return recognizeWithTesseract(...);
```

Both engines return `{ words: [{lineIndex, text, confidence, bbox}], text, preprocessed }`. The payoff is verified by history: adding ML Kit, and later removing Android, required no changes to `editor.js`, `filter.js`, or `main.js`.

**Where the contract is leaky:**

- **Confidence is not comparable across engines.** ML Kit exposes no per-word score, so [mlkitEngine.js](js/mlkitEngine.js) assigns a fixed `100`. The choice to use an obviously-fake constant rather than a plausible fabrication is correct and documented — but it means `LOW_CONFIDENCE_THRESHOLD` flagging and `filter.js`'s `NOISE_CONFIDENCE_THRESHOLD` stripping are **both dead on the native path**. Filtered Text silently degrades to pattern checks only. Nothing in the UI tells the user the confidence signal is absent on their platform.
- **`flattenBlocks` discards `cornerPoints`.** ML Kit returns both an axis-aligned `boundingBox` and the rotated quad; only the former is read. Per HANDOFF §5 this is confirmed against the plugin's Swift source and is a live suspect in the positioning bug.
- **`script` is hardcoded to `"LATIN"`.** ML Kit needs one bundled model per script with no auto-detect; five are compiled in via the Podfile but only Latin is ever requested. Documented as intentional deferral.
- **A round-trip through the filesystem per scan.** Blob → base64 (≈33% memory inflation, and `FileReader` holds the whole string) → `Filesystem.writeFile` to CACHE → ML Kit reads the path → delete. Forced by the plugin's path-only API, not a design choice, but it is the native path's peak-memory moment.

### 2.6 Editor object model

Every word span and the background image are uniform `editorObjects` entries with `{id, type, origin, x, y, w, h, fontSizePct}` — **all geometry in percentages of the source image's natural dimensions.** The container uses `container-type: inline-size` and fonts are sized in `cqw`, so the whole layout is resolution-independent and reflows correctly at any rendered width. That's the right primitive, and it's why PNG export at full natural resolution works from the same numbers.

`origin: 'ocr' | 'user'` cleanly drives divergent behaviour: deleting an OCR word clears its text and reveals an inpainted patch; deleting a user word removes it outright, because there is no underlying image content to restore.

**Known gaps** (all documented in HANDOFF §1):

- **Moving a word does not repair its vacated spot** — the patch is keyed to `originalBbox` and shown when modified, but the original pixels remain visible beneath the moved text in Full image.
- **No font, colour, size or style is captured from the source.** Every rendered word uses one system stack in `--text` colour over a translucent legibility box. `test/render-fidelity.js` measured the cost: given perfect boxes, positioning drift is ~1px, but a condensed display face in the source produces visibly wider inter-word gaps.
- **`buildResultCanvas` re-renders text with `ctx.fillText`** using the same generic stack, so PNG export inherits the same fidelity ceiling — and, unlike the DOM, has no word-wrap or overflow handling.

### 2.7 Inpainting

[js/inpaint.js](js/inpaint.js) implements harmonic (Laplace) inpainting via 300 Gauss-Seidel iterations over the bbox interior with the surrounding margin as fixed boundary. The choice is well-justified: OpenCV.js's Telea/Navier-Stokes would be better, but loading its WASM runtime from a click handler reproducibly froze the tab.

Design notes:
- Seeding the interior with the mean boundary colour before relaxing is the right move — it prevents the loop reading residual text pixels as boundary data.
- Results are cached per object id in `main.js`'s `patchCache` and invalidated per scan, so the cost is paid once.
- **It runs synchronously on the main thread.** 300 iterations × 3 channels over (bbox + up to 40px margin)² is fine for a word, but "select all and delete" on a dense screenshot serializes hundreds of these with no yield, no progress, and no cancellation. A Web Worker or an iteration budget scaled to region area is the obvious hardening.
- Harmonic diffusion produces a smooth gradient, not texture. On patterned backgrounds (wood, fabric, photo detail) the fill will read as a soft blur — acceptable for word-sized regions, and correctly scoped as such.

### 2.8 Native shell

Minimal and correct: `CAPBridgeViewController` in a stock storyboard, `packageClassList` narrowed to exactly `FilesystemPlugin` and `TextRecognitionPlugin`, `ios/App/Pods` untracked with `Podfile.lock` committed. `ios/` is committed per standard Capacitor practice with its own nested `.gitignore` — 87 tracked files total, so the repo stays light.

The pinch-to-zoom fix in [capacitor.config.json](capacitor.config.json) (`ios.zoomEnabled: true`) is a good example of the project's debugging standard: root-caused by reading Capacitor's installed Swift source (`CAPInstanceDescriptor` default → `WebViewDelegationHandler.scrollViewWillBeginZooming` disabling the recognizer), not guessed at.

### 2.9 Testing strategy

`test/` is a **measurement harness, not a test suite**, and that's a deliberate fit — the thing worth defending here is recognition quality, which unit tests can't express.

- [test/metrics.js](test/metrics.js): clean, dependency-free Levenshtein CER/WER with whitespace normalization.
- [test/run-benchmark.js](test/run-benchmark.js): Playwright drives the **real app** through a real static server — no mocking. Correct methodology.
- [test/score-manual.js](test/score-manual.js): the escape hatch for engines that can't be automated (on-device ML Kit), scoring pasted output against the same ground truth.
- [test/render-fidelity.js](test/render-fidelity.js): isolates the renderer from the engine by feeding it perfect `measureText`-derived boxes. This is what exonerated the renderer in the positioning investigation, and it should be kept as a permanent regression test.
- [test/replay-dump.js](test/replay-dump.js): replays a device dump offline in three variants (raw / cornerPoints / fitted), each as both the rendered view and an overlay on the source. Smoke-tested against a synthetic dump with deliberately halved boxes before the real data exists — the right way to build an instrument.

**Real weaknesses:**
- `test/node_modules` is a **symlink to a Playwright install borrowed from another local project**, and `CHROMIUM_PATH` is a hardcoded absolute path including a pinned build number. The benchmark runs on exactly one machine. Any second contributor, any CI, any laptop reinstall breaks it. A `test/package.json` with a real `playwright-core` devDependency would fix this at the cost of the "no dependencies" aesthetic — worth it for the project's most valuable tooling.
- **No unit tests at all** for the genuinely testable pure functions: `metrics.js`, `filter.js`'s predicates, `buildBboxMapper`/`transformBboxCorners`, `perspective.js`'s quad math. These are exactly the places a silent regression would hide, and they need no browser.
- **No CI.** Nothing runs on push.

### 2.10 Performance profile

| Hot path | Cost | Notes |
|---|---|---|
| Drag `onMove` | O(n) `filter` + O(n) `refreshModifiedStates` per mousemove | Each object gets `wordPasses()` + up to four `classList.toggle` calls; patch provider may re-encode a `toDataURL()` |
| Object lookup | `state.editorObjects.find(...)` on every mousedown, input event, snapshot restore | Linear; an id→object `Map` alongside the array is a 5-line fix |
| `readImagePixels` | Full natural-resolution `getImageData` on every render | A 4000×3000 photo = 48 MB `Uint8ClampedArray`, retained for the whole render pass |
| `computeInpaintedPatch` | 300 synchronous iterations, no yield | Batched deletes serialize |
| Region reprocessing | Up to 32 extra `recognize()` calls | Count-capped, not time-capped |
| Base64 encode (native) | ~1.33× image size as a JS string | Peak memory on the native path |

None of these are pathological for the sample-image case, and the biggest (`refreshModifiedStates` in the drag loop) is masked by the fact that dragging is a deliberate, low-frequency interaction. But a 12-megapixel photo with 400 recognized words on an iPhone is the case that will surface all of them at once, and that is the app's intended use case.

---

## 3. UI & UX design

### 3.1 Flow

A single centered column with strict progressive disclosure — nothing appears before it's relevant:

```
Drop zone (+ Use camera / Try a sample)
   ↓ file chosen
Preview + [Scan text] [Choose a different image]
   ↓ scan
Progress bar (live %, engine-stage label)
   ↓ done
Results:  [Text | Image format | Full image]
          [Raw | Filtered Text | Coherence Filter]
          [Copy] [Download .txt] [Download image]
          [Play / Stop]                       ← text & image-format only
          [Move components] [New text] [Delete] [Undo] [Redo]  ← full image only
```

**Five input paths** — click, drag & drop, clipboard paste (bound at `window` level, so it works from anywhere on the page), camera capture (`capture="environment"`), and a canvas-generated sample image that requires no network. The sample is a genuinely good onboarding decision: a first-time visitor can evaluate the product in one click without finding a file.

### 3.2 The orthogonal state matrix

Three views × three filter levels = **nine result states**, and the design keeps them genuinely orthogonal — the filter bar stays visible in all three views and means the same thing in each. This is more ambitious than it first looks, and mostly lands:

- **Text** — plain readonly textarea.
- **Image format** — each word positioned as it appeared, on a blank surface. This is the "read the layout without the noise" view.
- **Full image** — the same words over the real photo.

**Filtering is non-destructive and visible.** A word the filter excludes is dimmed to `opacity: 0.35`, not removed — so the user can see *what* was filtered and switch back to Raw to recover it. Copy/Download/TTS honour the dimming. This is a materially better decision than the usual "silently drop the noise", and it's the mechanism behind the README's "graduated output, not one fixed guess" claim.

**One seam shows.** Coherence Filter is a generative rewrite that cannot be mapped back to individual words, so in Image format / Full image it silently falls back to Filtered Text's dimming while Text view shows the prose. Both `filter.js` and `main.js` document this as the only sensible fallback — but the UI never says so. A user on Coherence Filter who switches to Image format sees Filtered Text's word set with no indication they've changed levels.

### 3.3 Standout interaction decisions

**Invisible-until-touched words in Full image.** An untouched OCR word renders `color: transparent` over the real photo, so nothing looks duplicated. It reveals itself on hover, on focus, when selected, and *permanently* once actually edited. This solves the core visual problem of the app's headline feature — editable text over its own source image — with three CSS rules and no JavaScript. It is the single best design decision in the project.

**The empty-new-text auto-undo.** Place a "New text" box, click away without typing, and the placement is silently removed *and its undo entry popped* ([editor.js:485-510](js/editor.js#L485)). No invisible empty boxes, no polluted undo history. This is the kind of detail that only gets built after using the thing.

**Blur forcing on editor mousedown.** Because drag/resize call `preventDefault()`, the browser's normal focus transfer is suppressed — so an actively-edited word would never blur. The handler explicitly blurs the active contenteditable first, with a comment explaining exactly why. Subtle bug, caught and documented.

**Selection that behaves.** Shift-click toggles, marquee drag rubber-bands, Escape clears, and a mousedown that doesn't move past a 3px threshold is treated as a click rather than a zero-distance drag. `getActiveResultText` deliberately ignores a selection containing only the background image, so selecting the photo doesn't make Copy return nothing.

**TTS scoped by feature detection *and* by mode.** Hidden entirely if `speechSynthesis` is absent or never yields voices — and hidden in Full image, where the editor toolbar already competes for space, with any in-progress speech stopped on the way out.

**Low-confidence flagging.** Sub-65-confidence words get a dotted red-tinted underline plus a `title` with the actual percentage. Honest, non-destructive, and directly supports the README's "visible confidence flagging" claim — on the web path.

### 3.4 Accessibility

**Present:** `aria-pressed` maintained on every toggle group via a shared `setActiveButton`; `role="group"` with `aria-label` on both toggles; `aria-live="polite"` on progress; `role="status"` on the status region and the coherence status; `tabindex="0"` + `role="button"` + Enter/Space handling on the drop zone; `:focus-visible` styling; `alt` text on both images; a full keyboard path for undo/redo (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Y`, `Shift+Z`) and Delete/Backspace that correctly defers to text editing when a contenteditable is focused.

**Gaps, roughly in impact order:**

1. **No keyboard path through the editor.** Move, resize and marquee selection are pointer-only. There is no arrow-key nudge, no keyboard resize, no "select next object". A keyboard-only user can edit word text (contenteditable spans are focusable) but cannot use the feature the product is built around.
2. **The resize handle is a bare `<div>`** — not focusable, no `role`, no accessible name, and 11×11px, well under the 24px minimum target size.
3. **Selection state is invisible to assistive tech.** `is-selected` is a class with a visual outline; no `aria-selected`, no live region announcing "3 items selected".
4. **Word spans have no accessible name or role.** They're contenteditable `<span>`s with no `role="textbox"` and no label, so a screen reader gives no indication that a focused span is editable, let alone that it's a recognized word at a position.
5. **Colour/opacity-only encoding.** `is-filtered-out` is opacity alone; `is-modified` is colour plus a background tint. No text, icon, or ARIA equivalent.
6. **Dark mode is `prefers-color-scheme`-only** with no manual override, and no `color-scheme` declaration, so form controls won't follow.
7. **Errors are generic.** `setStatus` writes into one shared region; scan failures interpolate the raw `err.message` into user-facing copy.

### 3.5 Mobile & the iOS target

This is where the design and the shipping target diverge most sharply.

- The viewport meta is correct and permits zooming, and the native pinch-zoom block has been fixed at the Capacitor config layer.
- The layout is fluid, `container-type: inline-size` makes the editor surface genuinely resolution-independent, and buttons wrap.
- **But every editor interaction is bound to `mousedown` / `mousemove` / `mouseup`** ([editor.js:805-912](js/editor.js#L805)). There are no `pointer*` or `touch*` handlers anywhere in the codebase. WKWebView synthesizes a click from a tap, so *tapping* a word to edit it works — but **dragging to move, dragging the resize handle, and marquee selection do not reliably work by touch at all.** "Move components", the feature the README leads with, is effectively desktop-only on an iOS-first product.

  The fix is mechanical — swap the three handlers to `pointerdown`/`pointermove`/`pointerup` with `setPointerCapture`, and add `touch-action: none` to the editor surface — and it is arguably higher-impact than the positioning bug, because it affects a feature that is otherwise finished.
- Secondary touch issues once that lands: the 11px resize handle needs a larger hit area, and `touch-action` will need care so single-finger drag doesn't fight the newly-enabled two-finger pinch.

### 3.6 Copy and honesty

The product writing is a differentiator. The drop zone warns about cursive before you waste a scan. The README has a section explicitly conceding it does not claim better raw accuracy than Google Lens. The coherence panel restates, every single time it's open, that this is the one thing that leaves your device. The hint text changes with mode *and* with editor state.

Two copy issues:
- **The footer is now inaccurate on the native build.** "Runs entirely client-side with Tesseract.js" ships inside the iOS app, where recognition is ML Kit and Tesseract never runs.
- **"Your images never leave your browser"** needs a native-build qualifier (see §4.5).

---

## 4. Security

### 4.1 Threat model

Attack surface is deliberately small: a static site with no backend, no accounts, no server-side state, and no user-generated content shared between users. The realistic threats are (a) compromise of the one third-party script, (b) theft of the stored API key, (c) unintended data egress contradicting the privacy claim, and (d) a hostile image as an input.

**Hostile-image input is well handled.** OCR output is attacker-influenced text, and it is written to the DOM exclusively via `textContent` and to canvas via `fillText`. There is **no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function` anywhere in `js/` or `index.html`** — verified. Filenames are never rendered. Downloads use fixed names. There is no injection path.

### 4.2 High — no Subresource Integrity and no CSP

[index.html:179](index.html#L179):

```html
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
```

No `integrity`, no `crossorigin`. There is also **no Content-Security-Policy** anywhere — not as a meta tag, and GitHub Pages sends none.

This is the app's single highest-leverage weakness. A compromised or substituted jsDelivr response executes with full page privileges and gets: every scanned image (`previewImg`, all canvases), all recognized text, and `localStorage` — including the Anthropic API key. With no CSP, it can exfiltrate to anywhere. The version is pinned, which helps against accidental drift but not against a registry or CDN compromise.

**Fix — cheap and complete:**
```html
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"
        integrity="sha384-…" crossorigin="anonymous"></script>
```
plus a meta CSP roughly:
```
default-src 'self'; script-src 'self' https://cdn.jsdelivr.net;
img-src 'self' blob: data:; connect-src 'self' https://api.anthropic.com
  https://cdn.jsdelivr.net https://tessdata.projectnaptha.com blob:;
worker-src 'self' blob:; style-src 'self'; object-src 'none'; base-uri 'none'
```
(`connect-src` must allow Tesseract's worker and language-data fetches; verify against a real scan before shipping.)

Better still for the native build: **vendor Tesseract.js locally**, which resolves this, the offline claim, and §4.4 in one move.

### 4.3 High — API key in `localStorage` on a shared origin

[js/coherence.js](js/coherence.js) stores the user's Anthropic key under `textscanner.anthropicApiKey` and sends it directly from the browser with `anthropic-dangerous-direct-browser-access: true`.

The module's header is commendably candid about the trade-off ("anyone with access to this browser profile could read the key back out"), and given there is no server, the alternative is not obviously better. But two aspects deserve more weight than the current disclosure gives them:

1. **The deployment origin is `https://prashaantm.github.io`, which is shared by every GitHub Pages site the author publishes.** `localStorage` is scoped per origin, not per path. Any other project of theirs served from that same origin — now or in future, including anything that ever pulls in a third-party script — can read the key. This is a property of the hosting choice, not of this code, and it is not mentioned anywhere. A custom domain, or a `github.io` project-scoped origin, is the only real mitigation.
2. **Combined with §4.2, any CDN compromise is a key compromise.** SRI + CSP is what stops that.

Minor hardening available regardless: the disclosure could recommend a key scoped and budget-limited to this use; the key input is correctly `type="password"` with `autocomplete="off"`; and the key is never logged, never sent anywhere but `api.anthropic.com`, and error paths never echo it. That part is done right.

### 4.4 Medium — the native app still fetches from a CDN

`sync-web-assets.sh` copies `index.html` verbatim into the bundle, so the shipped iOS app **loads `cdn.jsdelivr.net/tesseract.js` on every launch** — a 3rd-party network request, made by an app that never calls Tesseract, executing untrusted-at-runtime script inside the WKWebView.

Consequences: an unnecessary third-party dependency in a shipping App Store binary; the app is not actually offline-capable; and the same CDN-compromise path from §4.2 exists in the native context where the user has granted camera and photo-library access. Removing the tag (or vendoring the file) from the native bundle is the cleanest fix, and HANDOFF §Phase 4 already lists "offline asset bundling" — this should be scoped as security work, not just polish.

### 4.5 Medium — ML Kit telemetry vs. the privacy claim

`Podfile.lock` shows `MLKitCommon` pulling in `GoogleDataTransport`, `GoogleUtilities`, `nanopb`, and `GoogleToolboxForMac`. Google's ML Kit performs usage/diagnostic logging to Google by default; `GoogleDataTransport` exists specifically to batch and upload it.

To be precise about what this is and isn't: **image content is not uploaded** — recognition genuinely runs on-device, and the app's own code sends nothing. But "TextScanner never sends anything anywhere except Coherence Filter" is, on the native build, no longer strictly true at the process level. Before App Store submission this needs (a) a decision on whether to disable ML Kit usage logging via its documented Info.plist opt-out, and (b) README/in-app copy that distinguishes *your image never leaves the device* from *the app makes no network requests*. The former is the defensible claim and is still true.

Related: five ML Kit script models (Latin, Chinese, Devanagari, Japanese, Korean) are compiled in while only Latin is ever requested — unnecessary binary size and unnecessary code in the process.

### 4.6 Medium — the diagnostic dump persists recognized content

[js/mlkitDebug.js](js/mlkitDebug.js) accumulates every scan of a session into `window.__textscannerDebug` **and writes it to the app's Documents directory** as `textscanner-mlkit-debug.json` — full recognized text plus complete geometry, accumulated across scans, never cleared.

It is correctly built (wrapped so diagnostics can never fail a scan, clearly labelled temporary, deletion already scheduled in HANDOFF's Next action §4). The risks are containment risks, not code defects:

- Documents is included in unencrypted local backups and is retrievable via Xcode's Download Container. `UIFileSharingEnabled` is *not* set, so it is at least not exposed through the Files app.
- If a user scans a passport, a prescription, or a bank statement during a diagnostic session, that text sits in a plaintext JSON file indefinitely.
- **This must not reach TestFlight or the App Store.** The safest interim change is a build-time flag or a guard so it only ever activates in a debug build; the correct final change is deletion, as already planned.

### 4.7 Lower-severity observations

| Item | Assessment |
|---|---|
| `config.xml` `<access origin="*" />` | Generated Cordova-compat file, gitignored. Inert under Capacitor with no Cordova plugins installed, but it is a permissive default worth not inheriting if a Cordova plugin is ever added. |
| App Transport Security | **No overrides** — default HTTPS enforcement intact. Correct. |
| `PrivacyInfo.xcprivacy` | Pods ship their own; **the app target has none.** Required for App Store submission, and required to declare the reasons for any covered APIs. Already flagged in HANDOFF Phase 4. |
| Permission strings | `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription` present, specific, and honest about on-device processing. Good. |
| File validation | `file.type.startsWith("image/")` + a 15 MB cap. Client-side trust is fine here since nothing is uploaded and decode failures are caught. |
| Decode-size DoS (self-inflicted) | A valid 15 MB image can decode to a very large pixel buffer; `readImagePixels`, `preprocessImage` and `computeInpaintedPatch` are all unbounded in natural dimensions and run on the main thread. Freezes the user's own tab/app only. Worth a megapixel cap. |
| Object URL lifecycle | Revoked on replace and on reset. Not revoked on unload — harmless. |
| Clipboard fallback | `document.execCommand("copy")` — deprecated, not a security issue. |
| Secrets in repo | **None.** `DEVELOPMENT_TEAM = YAQB9K65UT` is committed; that's an Apple Team ID, not a credential, and is standard practice — it does identify the developer account. |
| Dependency provenance | `package-lock.json` and `Podfile.lock` both committed. Good. No automated vulnerability scanning, no Dependabot, no CI. |
| Canvas tainting | Blob URLs are same-origin so `getImageData` never taints; every call is nonetheless wrapped in try/catch returning null. Correct defensive posture. |
| Hosting | GitHub Pages: HTTPS, static, no server-side attack surface. |

### 4.8 Recommended security order of work

1. Add `integrity` + `crossorigin` to the Tesseract tag and a CSP meta. *(highest value, ~15 minutes)*
2. Remove or vendor the Tesseract script for the native bundle. *(fixes §4.4 and the offline claim together)*
3. Gate `mlkitDebug.js` behind a debug-only flag now, delete it when the positioning bug closes.
4. Decide and document the ML Kit usage-logging position; correct the README/footer claims for the native build.
5. Add the app-level `PrivacyInfo.xcprivacy` before any TestFlight build.
6. Note the shared-`github.io`-origin caveat in the API key disclosure, or move to a custom domain.
7. Trim the four unused ML Kit script models.

---

## 5. Consolidated recommendations

**Do next (blocks the current phase or ships broken):**
- Pointer/touch events in the editor — "Move components" does not work by touch on the iOS target (§3.5).
- SRI + CSP (§4.2).
- Complete the positioning investigation with the prepared instrumentation; then delete `mlkitDebug.js` (§4.6, HANDOFF Next action).

**Do before shipping:**
- Vendor or drop the CDN script in the native bundle (§4.4).
- App-level privacy manifest; ML Kit telemetry decision; correct the privacy copy (§4.5, §4.7).
- Surface the "no confidence signal on this platform" gap in the UI, or suppress the confidence affordances on the native path (§2.5).

**Health of the codebase:**
- Real `playwright-core` dependency + no hardcoded Chromium path, so the benchmark runs anywhere (§2.9).
- Unit tests for `metrics.js`, `filter.js`, `buildBboxMapper`, `perspective.js` — pure functions, no browser needed.
- `Map` for object lookup; move `refreshModifiedStates` out of the drag loop (§2.10).
- Split `editor.js` along its existing section boundaries.
- Move the test corpus out of `legacy-opencv-scripts/`; prune stale files from the generated `www/` and `public/` trees.

**Accessibility backlog:**
- Keyboard path through the editor (arrow-nudge, keyboard resize, focus traversal).
- Accessible resize handle; `aria-selected` on selection; names/roles on word spans; non-colour encoding for filtered/modified.

---

*Analysis based on a full read of `index.html`, `style.css`, all 14 modules in `js/`, all 5 files in `test/`, the Capacitor and Xcode configuration, `Podfile.lock`, and the git history through `931ddc6`.*
