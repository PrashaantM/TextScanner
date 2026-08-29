# TextScanner — Architecture, Design & Security Analysis

**Date:** 2026-08-29 · **Commit:** `7ff391e` · **Branch:** `main`
**Scope:** folder structure, system design, UI/UX design, security. This is the **post-completion-plan** revision of the 2026-08-28 analysis below — every finding in that version's severity table has been addressed, and this revision documents what was actually built, what was measured and rejected, and what remains genuinely open. For session-to-session state see [HANDOFF.md](HANDOFF.md); for the phase-by-phase execution record see the git log (`Phase 0` through `Phase 7`, plus this rewrite).

---

## 0. Executive summary

TextScanner is a **zero-build, dependency-light, local-first OCR and image-text-editing app**: ~5,450 lines of vanilla ES-module JavaScript deployed straight to GitHub Pages, wrapped in a Capacitor iOS shell that dispatches between Tesseract.js and native Google ML Kit, plus two features (Coherence Filter, translate-in-place) that dispatch between Apple's on-device Foundation Models and a BYOK Claude fallback.

The codebase grew by about 2,250 lines since the prior analysis — not from feature sprawl, but from three real features (on-device rewriting, touch support, translation) each built with its own dispatcher, its own verification, and its own documentation of what didn't work.

**What was already strong, and still is**

- The **hook-registration dependency-inversion pattern** survived a three-way file split intact, and gained one more hook (`registerModeReset`) for exactly the reason the original ones existed — keeping the object model ignorant of the interaction layer above it.
- The **single-seam engine abstraction** pattern proved itself twice more: `js/coherence.js` and `js/translate.js` both copy `js/recognize.js`'s shape (caller states intent, dispatcher picks an implementation) rather than inventing a new one.
- The **"can only help" recognition pipeline** is unchanged, and is now the subject of a real experiment (§2.4) rather than an assumption.
- **Unusually honest product copy** got more honest, not less: the footer names the actual running engine, the README separates "your image is never uploaded" from "the app makes no network requests," and a dedicated document (`docs/PRIVACY-DECISIONS.md`) states the one privacy claim that couldn't be verified live (native network traffic) and says exactly why.
- **No injection surface**, still verified: no `innerHTML`/`eval`/`document.write` anywhere in `js/` or `index.html`.

**What changed, mapped against the prior severity table**

| # | 2026-08-28 finding | Severity | Status now |
|---|---|---|---|
| 1 | CDN script, no SRI, no CSP | High | **Fixed.** Tesseract vendored (`vendor/tesseract/`); CSP added and verified against a live scan — the verification itself caught a real break (`wasm-unsafe-eval` was required, not in the original plan) |
| 2 | API key readable by any co-hosted `github.io` project | High | **Disclosed, not fixed.** No code change closes this — it's a hosting-origin property — but the panel now states it explicitly and recommends a scoped, budget-limited key |
| 3 | Editor is mouse-only; touch doesn't work | High | **Fixed and regression-tested.** Pointer events throughout; `test/touch-interactions.js` drives real touch via CDP specifically because a mouse-based test would have passed against the old code |
| 4 | Native build fetches Tesseract from a CDN at launch | Medium | **Fixed** by the same vendoring that closed #1 — `scripts/sync-web-assets.sh` ships only the 67 KB script tag into the native bundle, not the 11 MB of cores/language data the web build needs |
| 5 | ML Kit telemetry vs. the privacy claim | Medium | **Researched and decided, not fixed.** No standalone opt-out exists (the documented one is Firebase's; this app has no Firebase). Left on, disclosed precisely — see §4.5 |
| 6 | Diagnostic dump persists recognized text to Documents | Medium | **Fixed.** `js/mlkitDebug.js` is off by default and inert until explicitly armed via a URL flag or a console-set `localStorage` key; still not deleted, because the bug it instruments is still open |
| 7 | No keyboard path; unlabeled 11px resize handle | Medium | **Fixed.** Full keyboard path (Tab/Enter/arrows/Alt+arrows/Escape), real ARIA on every word span, a 28px slider-role handle, non-colour state signals, a manual theme override |
| 8 | Benchmark harness depends on a symlinked, borrowed Playwright | Medium | **Fixed.** Real `playwright-core` devDependency in `test/package.json`; zero hardcoded paths |
| 9 | Drag loop is O(objects) per mousemove | Low | **Fixed.** Scoped to the objects actually being dragged; a full reconciliation happens once, at gesture end |
| 10 | No `PrivacyInfo.xcprivacy` | Low (was pre-submission) | **Fixed**, and verified present in a built app bundle, not just registered in the project file |

**New findings from this revision**, all Low unless noted:

| # | Finding | Area | Severity |
|---|---|---|---|
| 11 | No bold/regular font-weight detection for edited text | Design | Informational — measured and deliberately not built (§2.6) |
| 12 | Translating into a non-Latin script can't be re-scanned on the native build | Design | Low, disclosed at the moment it's true |
| 13 | Native network claims are verified statically, not by device packet capture | Security | Medium — the one privacy claim not independently confirmed |
| 14 | The recognition pipeline has not moved since the prior analysis | Design | Informational — two full tuning sweeps found nothing above the measurement's own noise floor (§2.4) |
| 15 | Nothing in this codebase has run on a physical iPhone | Testing | Medium — every verification is a real browser, a synthetic touch context, or a simulated native bridge |

---

## 1. Folder structure

### 1.1 Layout

```
TextScanner/
├── index.html                  ← app shell, now carries a verified CSP meta tag
├── style.css                   ← styling; three theme states (system/light/dark), not two
├── js/                         ← 23 ES modules, ~5,450 LOC, no bundler
├── vendor/tesseract/            ← NEW: Tesseract.js + worker + wasm cores + eng data, vendored
├── www/                        ← GENERATED, gitignored — Capacitor's webDir
├── ios/                        ← Capacitor iOS shell + TextCoherencePlugin.swift (app-target plugin)
├── test/                       ← Playwright benchmark, unit tests, touch tests, tuning sweep
├── docs/
│   ├── origins/                ← RENAMED from legacy-opencv-scripts/: history, not test data
│   └── PRIVACY-DECISIONS.md    ← NEW: what leaves the device, and why the telemetry stays on
├── scripts/
│   ├── sync-web-assets.sh      ← now also copies the one vendored file the native build needs
│   └── trim-mlkit-scripts.js   ← NEW: npm postinstall patch dropping 4 unused ML Kit models
├── capacitor.config.json
├── package.json                ← now has a real postinstall step
├── README.md
└── HANDOFF.md                  ← rewritten for the post-completion-plan state
```

### 1.2 The one-source-of-truth rule — unchanged, and the drift is gone

The repo root is still the only source of truth for the web app; `www/` and `ios/App/App/public/` are still gitignored, regenerated copies. The prior analysis flagged a concrete case of drift proving the risk (`textUtil.js` surviving in both generated trees after deletion from source). That specific drift is gone — both trees were regenerated repeatedly across all eight phases and are clean.

`scripts/sync-web-assets.sh` now does more than a flat copy: it deliberately copies `vendor/tesseract/tesseract.min.js` (67 KB) into `www/` but **not** the rest of `vendor/tesseract/` (~11 MB of wasm cores and language data), because the native build's recognition path is ML Kit and never touches Tesseract. The comment in the script names the exact line to change if a native Tesseract fallback is ever added — the kind of documentation this repo already did well, extended to a new asymmetry between the two builds.

### 1.3 Naming and cohesion — `editor.js` is gone

The single largest structural change: **`editor.js` (1,032 lines, previously the one module flagged as carrying more than one responsibility) no longer exists.** It's split along the section boundaries it was already banner-commented into:

| Module | LOC | Exports | Role |
|---|---|---|---|
| `editorObjects.js` | 927 | 34 | Object model, selection, undo/redo, pixel sampling (colour + geometry), rendering, id/element indexes |
| `editorInteractions.js` | 758 | 8 | View/editor/marquee/add-text modes, every pointer gesture, the full keyboard path |
| `editorExport.js` | 227 | 7 | Text extraction (Copy/Download/TTS/translation reads), PNG canvas export |

The dependency direction is one-way — `editorInteractions.js` and `editorExport.js` both import from `editorObjects.js`, which imports from neither — with exactly one edge running the other way: `clearImageFormatView` (in `editorObjects.js`) has to leave Move-components mode, which lives in `editorInteractions.js`. That's `registerModeReset`, a hook registered rather than imported, keeping the graph acyclic using the exact idiom the codebase already ran on for inpainting and undo (§2.2).

`main.js` grew to 972 lines — not because it absorbed editor logic, but because it now owns wiring for translation, the two-tier Coherence Filter panel, the theme toggle, the keyboard hint, categorized scan-error messages, and a yielding batch-delete path. It imports from all three editor modules directly rather than through a barrel file, so which concern a given call belongs to is visible at the import site.

The rest of the module list grew by ten files, all following the dispatcher pattern established by `recognize.js`:

```
coherence.js / coherenceClaude.js / coherenceOnDevice.js
translate.js / translateClaude.js / translateOnDevice.js / translateLanguages.js
theme.js
```

`legacy-opencv-scripts/` is gone. The 11-image benchmark corpus moved to `test/images/` (with a new `README.md` documenting the categories still missing — low light, steep skew, a receipt, non-Latin script — and exactly how to add one); the two origin-story Python scripts and the stock OpenCV tutorial media they read/write moved to `docs/origins/`, with its own `README.md` distinguishing history from dependency.

### 1.4 Documentation as a first-class artifact — the standard held

The prior analysis called the header-comment discipline "the repo's best-maintained asset." It held under three new features and a major refactor. New examples worth naming: `js/theme.js`'s header explains why "system" is represented by the *absence* of an attribute rather than a third value; `vendor/tesseract/README.md` documents that the file list was determined by running a scan with request logging, not by reading documentation, and explicitly corrects the record on `tessdata.projectnaptha.com` (never used by tesseract.js 5.x, despite being what the original security review's suggested CSP was built around); `scripts/trim-mlkit-scripts.js`'s header explains three approaches that were tried and failed before the one that shipped.

The one new practice worth calling out specifically: **negative results are written down.** `test/TUNING.md` exists to record that two full sweeps of every pipeline threshold found nothing worth changing, with the per-image numbers showing why each rejected candidate was rejected. Nothing forced this — a null result is easy to just not commit. Its presence is a real signal about how this project is being run.

---

## 2. System design

### 2.1 Layer map

```
                       index.html  (structure, CSP meta, ids/classes)
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
     dom.js             state.js             style.css
  (element registry,   (mutable store +      (3 theme states,
   now incl. theme/     tuning constants,      not 2; token-based
   translate/a11y refs)  marqueeMode)           per §3.4)
        │                   │
        └─────────┬─────────┘
                  │
   ┌──────────────┼───────────────┬──────────────┬────────────────┐
   │              │               │              │                │
recognize.js   filter.js    editorObjects.js   coherence.js   translate.js
 (dispatch)   (pure preds)  editorInteractions.js (dispatch)    (dispatch)
   │                       editorExport.js         │                │
   ├── ocrEngine.js ── preprocess.js          coherenceClaude.js  translateClaude.js
   │   (Tesseract)  └── perspective.js        coherenceOnDevice.js translateOnDevice.js
   └── mlkitEngine.js ── mlkitDebug.js [gated]      │                │
       (native ML Kit)                              └──── TextCoherencePlugin.swift
                  │                                        (shared native bridge)
               main.js  ── inpaint.js (patch cache, now yields on batch delete)
            (bootstrap: wires everything, owns theme.js's button, error categorization)
```

Three dispatchers now exist where one did. `js/recognize.js` picks an OCR engine; `js/coherence.js` and `js/translate.js` each pick between an on-device tier and a BYOK Claude tier. All three share the same shape — a plain function the caller awaits, with no indication upstream of which implementation actually ran — and `js/translate.js`'s own header comment says so explicitly: it's the third module built this way, not a new pattern invented for the occasion.

### 2.2 The central architectural idea: hook registration — extended, not replaced

The registration setters the prior analysis documented (`setPatchProvider`, `setDeleteHandler`, `setFilterTextHook`, `setAddTextClickHandler`, `configureUndoHooks`) are all still there, unchanged in shape, now split across the three editor modules by which concern each belongs to. One was added:

```js
registerModeReset(fn)   // "clearImageFormatView needs to leave Move/marquee mode"
```

This is the one dependency `editorObjects.js` has on `editorInteractions.js`, and it exists for the same reason the original hooks did: rather than have the object-model module import the interaction module (or worse, the two import each other), `editorInteractions.js` registers a callback at load time and `editorObjects.js` calls it without knowing what "Move mode" or "marquee mode" even are. The trade-off the prior analysis named — module-level mutable singletons with no compile-time guarantee they're wired — is unchanged and was not worth solving at this scale; the split proved the pattern generalizes cleanly rather than needing rework.

### 2.3 State model

`state.js` grew by two fields, both following the existing convention exactly: `marqueeMode` (touch's explicit rubber-band-selection toggle, §3.5) and no framework, no reactivity, still a single mutable object mutated in place. The two-representations problem the prior analysis flagged (`ocrWords` vs. `editorObjects`) is unchanged — `getActiveResultText()` in `editorExport.js` still has to choose based on active mode, and it's still the subtlest piece of logic in the app. It was not touched during the split, on the theory that refactoring genuinely subtle logic while also moving it between files is how subtle logic gets a subtle bug.

Object lookup is no longer linear. `state.editorObjects.find(...)` — flagged in the prior analysis as the app's most frequent scan — is now backed by two `Map`s (`objectsById`, `objectsByElement`) maintained by the four functions that are the only places the array is mutated. The array itself is kept as the order-preserving source of truth (reading order matters for text extraction), so this is an index alongside the array, not a replacement for it.

### 2.4 Recognition: the scored-candidate pipeline, now measured

The pipeline described in the prior analysis is **completely unchanged** — same five stages, same thresholds, same guards. What's new is that it was actually tested against the corpus, twice, with a real experiment design:

1. **A noise floor was established first.** The identical code, benchmarked twice, produced 57.1% and 56.9% WER — so any measured delta under roughly ±0.3 points is indistinguishable from run-to-run variation, and every subsequent number is read against that floor.
2. **Scoring was corrected before tuning began.** Three of the eleven benchmark images (`complexPic7`, `10`, `11`) have deliberately partial ground truth — illegible fine print was omitted rather than guessed — so an engine that reads *more* real text scores *worse* on them. The prior analysis's 11-image average is dominated by these three (they sit around 130% CER). The corrected headline metric is the mean over the other eight: **45.1% CER / 57.1% WER**, and that's the number every tuning decision was actually made against.
3. **Every threshold the completion plan named was swept**, patching both `ocrEngine.js` and `preprocess.js` in place and restoring them after each run (`test/tune-thresholds.js`). Results, in full, live in `test/TUNING.md`. The short version: four thresholds produced byte-identical output at every value tried — they don't bind on this corpus at all; one variant reproduced across both sweeps and was still rejected because its entire effect was one image out of eight (an average moved by a single sample is overfitting, not tuning); one variant (running the region pass on almost every image) was clearly and reproducibly worse, which is a useful confirmation that the existing `SKIP_REGION_PASS_OVERALL_THRESHOLD` is doing real work.
4. **One new preprocessing idea was tried and left off, deliberately.** `REGION_INCLUDE_RAW_CANDIDATE` in `preprocess.js` gives the region-reprocessing pass an untouched candidate to lose to, mirroring a rule the whole-image pass has always followed. It measured inside the noise floor (0.1 CER, 0.2 WER) and costs an extra `recognize()` call per weak region, so it's implemented, documented, and switched off — a decision the corpus couldn't distinguish from noise, not a rejected idea.

**Net result: the pipeline is bit-for-bit unchanged from the prior analysis, and the benchmark score after every later phase is identical to the Phase 0 baseline — 68.3% CER / 112.0% WER over all eleven images.** That stability was verified repeatedly, specifically to catch a regression from unrelated refactoring (the editor split, the touch rewrite) leaking into recognition — which never happened.

The one real constraint this surfaced: **eight scoring images cannot resolve a one-point difference.** `test/images/README.md` names the categories the corpus is missing (low light, steep skew, dense small text, a receipt, a street sign, a moiré case, non-Latin script) and is the actual blocker on any further tuning — not more threshold sweeping.

The megapixel cap flagged as a hardening opportunity (prior §4.7) is now implemented: `MAX_IMAGE_PIXELS` in `state.js` (12 MP) triggers a downscale in `main.js` before recognition runs, with the user told when it happens rather than a silent shrink. Verified: a 24 MP synthetic image comes back at 12.0 MP, correctly recognized, with an explicit status message.

### 2.5 Engine abstraction — the confidence gap is now honest, not silent

`js/recognize.js` is unchanged in shape (still the one-branch `isNativePlatform()` dispatch) but gained two exports: `isNativeEngine()` and `getEngineName()`, both used by the footer to name the engine actually running rather than hardcoding "Tesseract.js" (which the prior analysis correctly flagged as false on the native build).

The confidence-comparability gap the prior analysis flagged — ML Kit's fixed placeholder `100` making `LOW_CONFIDENCE_THRESHOLD` flagging silently dead on native — is fixed by making the gap visible instead of papering over it. `mlkitEngine.js` now sets confidence to `null` rather than a plausible-looking fake number (both downstream consumers were already `typeof`/null-guarded, so nothing had to change to accommodate this), and `js/recognize.js` exports `engineProvidesConfidence()`, which `main.js` uses to show a one-line note above the result whenever the active engine has nothing real to flag with. This is the fix the prior analysis explicitly named as one of two acceptable options ("surface the gap, or suppress the affordance") — surfacing was chosen because suppressing the underline styling entirely would have left no way to explain its absence.

The `cornerPoints`-vs-`boundingBox` question and the hardcoded `"LATIN"` script are both **unchanged and still open** — see §5.2 and §2.7 below.

### 2.6 Editor object model — colour matching added, font-family deliberately not

The prior analysis's biggest documented gap in the editor — "no font, colour, size, or style is captured from the source" — is now half-closed, and the half that's closed was measured rather than eyeballed.

**Colour sampling** (`sampleInkAppearance` in `editorObjects.js`) reads a word's real ink colour from the source pixels at render time, before the inpainting patch covers the region. `test/render-fidelity.js` was extended specifically to measure this: the synthetic poster it draws now uses real ink colours across four background bands, so the harness has ground truth to compare against.

The path to the current algorithm is worth recording because two earlier approaches looked correct and weren't, and both are documented in the Phase 4b commit rather than lost:
- Comparing against a background sampled just *outside* the box inverted near a background transition (the strip above the box belonged to the old background).
- Otsu's method on the box's own histogram, with "ink is the minority class," failed on heavy display text — where letterforms cover *more* than half their own tight bounding box, inverting the rule.

What works: Otsu for clean class means, then a **median** of a ring outside the box (not a mean — a minority of the ring straying onto a neighbouring colour moves a mean and doesn't move a median) to decide which class is the background. Measured result: mean ink-colour error fell from 204.4 (one fixed theme colour for every word) to ~30 (0 = exact, 441 = black-vs-white), with no geometry regression.

**Font-weight (bold/regular) detection was tried and explicitly rejected**, and this is worth citing as a model of how to handle a plausible-looking feature that doesn't survive contact with data. Ink-coverage fraction was the obvious proxy; it was measured against the harness's known ground truth and does not separate weights — in the system font stack, weight-500 and weight-700 ranges overlap almost completely (0.368–0.578 vs. 0.421–0.518), and in the display face the relationship *inverts*: bold text covers *less* of its box than medium weight does. There is no threshold that works, so none was shipped. Font *family* was never attempted, on the same reasoning the prior analysis already endorsed (getting it wrong looks worse than a neutral stack, and there's no way to verify a guess without exactly this kind of measurement infrastructure).

**Font size** was already correct (bbox height → `fontSizePct`) and remains so — `render-fidelity.js` reports a mean width ratio of 1.00–1.01 across both sweeps, unchanged.

The move/inpaint gap the prior analysis flagged — moving a word doesn't clean up its vacated spot — is **unchanged and still open.** It was not in scope for any of the eight phases and remains the editor's longest-standing known limitation.

### 2.7 Inpainting — no longer blocks the main thread on a batch delete

The prior analysis's performance table flagged 300 synchronous Gauss-Seidel iterations with no yield as fine for one word but freezing on a batch delete. This is fixed, and the fix was measured against the old behaviour rather than just asserted better:

deleting 115 words on a benchmark image, old path (one uninterrupted block): **1.0s fully blocked, 1 animation frame.** New path (`precomputePatches` in `main.js`, yielding via a real `setTimeout(0)` — a microtask would not have released the frame): **1.6s elapsed, 90 frames at ~55fps**, with a progress message shown only above an 8-word threshold (below that, the yielding is pure overhead). Slightly slower in wall-clock, which is the correct trade: the alternative is an app indistinguishable from a hung one.

Everything else about `inpaint.js` — the harmonic-diffusion approach, the OpenCV.js rejection reasoning, the per-object patch cache — is unchanged.

### 2.8 Native shell — one more plugin, registered by hand

`ios/App/App/TextCoherencePlugin.swift` is new: an app-target Capacitor plugin (not an npm package — the header explains why packaging a few app-specific lines just to import them back would be pure ceremony) wrapping `SystemLanguageModel`/`LanguageModelSession` behind `availability`, `rewrite`, `translate`, and `supportedLanguages`. Because it's app-target rather than installed, it can't appear in the generated `packageClassList` that `cap sync` rebuilds from installed packages — so `MainViewController.swift` exists solely to call `bridge?.registerPluginInstance(...)` from `capacitorDidLoad()`, and `Main.storyboard` now points its root view controller at that subclass instead of the stock `CAPBridgeViewController`. This is documented in both files' headers as the one thing that silently breaks (the plugin becomes `undefined` in JS with no error) if the storyboard ever gets reset by a fresh `cap add ios`.

The API surface was written against the SDK's own `.swiftinterface` file (`FoundationModels.swiftmodule/arm64e-apple-ios.swiftinterface`), not from memory or documentation, specifically because the framework is new enough (iOS 26) that training-data familiarity would be unreliable.

The four unused ML Kit script models (Chinese, Devanagari, Japanese, Korean) flagged in the prior analysis's §4.5/§4.7 are removed via `scripts/trim-mlkit-scripts.js`, an npm `postinstall` step — not a Podfile edit, because the two obvious alternatives were tried first and both failed: a `:podspec` override makes CocoaPods try to clone the upstream repo at a tag that doesn't exist, and a `:path` override needs a directory of vendored sources (the exact fragility Phase 0 removed from `test/`). The script patches two files together — the podspec's dependency list and the plugin's Swift imports/switch — because dropping one without the other fails the build outright (`unable to resolve module dependency`), which is exactly what happened on the first attempt and is why the shipped version verifies both patches apply before writing either. Measured on a clean build: **56 MB → 49 MB**, with only `LatinOCRResources.bundle` present.

### 2.9 Testing strategy — from "runs on one machine" to a real test suite

The prior analysis's two structural weaknesses are both closed:

- **The symlinked, borrowed Playwright is gone.** `test/package.json` declares a real `playwright-core` devDependency; `test/run-benchmark.js`, `test/render-fidelity.js`, and `test/replay-dump.js` all resolve the browser through `playwright-core`'s own registry with zero hardcoded paths. Verified by running the full suite from a state where the borrowed symlink no longer exists.
- **Unit tests exist**, covering exactly the pure functions the prior analysis named: `test/unit/metrics.test.js` (CER/WER, including the non-obvious property that CER can validly exceed 1.0), `test/unit/filter.test.js` (every `wordPasses` branch, including the acronym exemption), `test/unit/bbox.test.js` (`buildBboxMapper`/`transformBboxCorners`, including a rotation composed with scale — the exact class of bug the ML Kit positioning investigation is chasing), `test/unit/perspective.test.js` (keystone detection's decline-by-default behavior, and a homography round-trip). **45 tests, all passing**, run via plain `node --test` with no framework added. Two of the four exported-for-testing functions (`buildBboxMapper`, `transformBboxCorners`) were module-private before Phase 0 and are now exported solely for this, each flagged as such in a comment.

**New since the prior analysis:**

- `test/touch-interactions.js` — deliberately does **not** use Playwright's mouse API (which emits `pointerType: "mouse"` and would have passed against the broken pre-Phase-4a code). Drives CDP `Input.dispatchTouchEvent` directly to produce genuinely trusted touch input, and asserts drag, resize, and marquee all actually change state, not just that no error was thrown.
- `test/tune-thresholds.js` — the pipeline-tuning sweep harness described in §2.4, notable for restoring the patched source files even on `SIGINT`, so an interrupted sweep can't leave the pipeline silently mutated.
- `render-fidelity.js` gained colour/weight ground truth (§2.6) alongside its existing geometry measurement.

**Still true from the prior analysis: no CI.** Nothing runs on push. Every verification in this revision was run manually, once, and the results transcribed into commit messages and `test/TUNING.md` rather than being continuously re-checked. This is the same shape of risk the prior analysis flagged and it wasn't addressed — the completion plan didn't call for it, and eight phases of manual-but-thorough verification is not a substitute for a workflow that runs on every push.

### 2.10 Performance profile — the two flagged hot paths are both fixed

| Hot path (2026-08-28 finding) | Status |
|---|---|
| Drag `onMove`: O(n) `refreshModifiedStates` per mousemove | **Fixed.** `refreshModifiedStatesFor([...])` scopes the reconciliation to the objects actually moving; one full pass happens once, at gesture end |
| Object lookup: `state.editorObjects.find(...)` | **Fixed.** O(1) via `getObjectById`/`getObjectByElement`, backed by two `Map`s maintained at every mutation site |
| `computeInpaintedPatch`: 300 synchronous iterations, no yield | **Fixed** for the batch case (§2.7); a single delete was never the problem and is unchanged |
| Region reprocessing: up to 32 extra `recognize()` calls | **Unchanged.** Still count-capped, not time-capped; not addressed because the tuning sweep (§2.4) found no evidence the cap is currently the limiting factor on this corpus |
| Base64 encode on the native path | **Unchanged.** Still forced by the ML Kit plugin's path-only API |
| `readImagePixels`: full-resolution `getImageData` on every render | **Indirectly bounded** by the new 12 MP decode cap (§2.4), which limits how large this buffer can get, though the call site itself is unchanged |

---

## 3. UI & UX design

### 3.1–3.2 Flow and the orthogonal state matrix — extended by one dimension

The nine-state matrix (three views × three filter levels) the prior analysis described is unchanged in shape. Two things were added on top of it rather than into it:

- **Translate-in-place** (`translate-controls` in `index.html`) is a language picker plus a Translate/Revert pair, visible only in the two image views — "in place" is meaningless in the plain Text view, which has no positions to write into. It reuses the object model wholesale: a translated line's first word span takes the whole translated string, the rest of that line's spans are emptied — which is exactly what Delete already does to an OCR word, so the vacated spots get the existing inpainting treatment for free, and the whole operation is one snapshot, so it's one Undo step.
- The **Coherence Filter panel gained a tier indicator** ("Rewriting with: On-device" / "Claude (your API key)") with per-tier disclosure text, because the panel can now produce output from two different quality tiers and the prior single-tier design had no way to say which one a result came from. A "switch tier" button appears only when both tiers are genuinely usable — offering a toggle that would just fall back to the same tier was judged worse than not offering one.

The "one seam shows" gap the prior analysis flagged — Coherence Filter's word-level dimming silently falling back to Filtered Text's view with no on-screen indication — is **unchanged.** It wasn't in scope for any phase and remains a real, if minor, discoverability gap.

### 3.3 Standout interaction decisions — the invisible-word trick survived, and gained a colour rule

The "invisible-until-touched" Full-image rendering the prior analysis called the single best design decision in the project is architecturally unchanged, and now composes correctly with sampled colour: an untouched word is still `color: transparent`, but a *modified* word's colour comes from a CSS custom property (`--word-color`) written by `editorObjects.js` rather than a hardcoded `color: var(--text)` — chosen specifically so the "when is a word visible" rule (still owned by the existing CSS class logic) and the "what colour is it" rule (now owned by pixel sampling) can't fight each other. An inline `color` on the element would have overridden the transparency rule outright; the custom-property indirection was necessary, not stylistic.

The empty-new-text auto-undo and the mousedown blur-forcing behaviour are both unchanged and untouched by any phase.

**New interaction pattern, forced by touch:** marquee (rubber-band) selection is now an explicit toggle ("Select multiple") rather than a shift-drag gesture, because there is no shift key on a phone and a plain finger drag is how the page scrolls. While armed, the editor surface's `touch-action` drops to `none` so the browser can't intercept the drag as a scroll; it's released automatically on leaving the image views specifically so the page can never get stuck unscrollable.

### 3.4 Accessibility — every named gap addressed

All seven items from the prior analysis's gap list were built, in the order the prior analysis assigned them:

1. **Keyboard path through the editor**, previously entirely absent: Tab/Shift+Tab traverses objects, Enter/Space selects, arrows nudge (Shift for a coarse step), Alt+arrows resizes, Escape clears, Delete removes (already existed). A run of nudges collapses into one undo entry via an 800ms coalescing window — verified: seven keypresses produce one undo-stack entry, not seven.
2. **The resize handle** is now `role="slider"`, focusable, with `aria-valuenow`/`aria-valuetext` kept live, on a 28px transparent hit target (the visible square is drawn by `::after` so growing the target didn't have to grow the visual element over the word being resized).
3. **Selection state** is announced via a live region, deliberately gated to fire only on actual count change — a marquee drag updates the selection on every pointer-move, and re-announcing the same count dozens of times a second would make a screen reader unusable rather than more usable.
4. **Word spans** now carry `role="textbox"`, `aria-selected`, and an `aria-label` built from the word's text, a plain-language position ("top right," not a percentage), and any state otherwise conveyed only by colour (filtered-out, edited, low-confidence).
5. **Non-colour signals**: `is-filtered-out` gained a strike-through alongside its opacity; `is-modified` gained a small outline corner-caret — an outline shape rather than a hue, specifically so it survives greyscale and high-contrast rendering.
6. **Manual theme override** (`js/theme.js`): cycles system → light → dark, where "system" is the *absence* of a `data-theme` attribute rather than a third stored value, so a user who never touches the toggle gets byte-identical behaviour to before. `color-scheme` is now declared for all three states, fixing the flagged gap where form controls and scrollbars ignored a manual override.
7. **Errors** are categorized rather than interpolated raw: `describeScanError()` in `main.js` maps six failure signatures (corrupt image, tainted canvas, out-of-memory, network, wasm/worker failure, generic) to a sentence that says what happened and what to do, while the real `Error` object still goes to the console. Verified by forcing each signature through the real scan path and confirming none of the six leak internals like `getImageData` or `RuntimeError` into the status text.

One bug from building this worth recording as a caution: the first attempt to fix word-span focusability edited a function (`setFullEditorMode`) that had moved to a different file during the Phase 5 split. The edit silently matched nothing (a `.replace()` against a string that no longer existed in that file), and the failure surfaced three assertions later as a generic `focus()` no-op rather than an obvious error. Every subsequent edit in that phase asserts its target string was actually found — the general lesson being that a search-and-replace against a codebase mid-refactor needs its own verification, not just the downstream test's.

### 3.5 Mobile & the iOS target — the flagged gap is closed and regression-tested

This was the prior analysis's highest-impact UX finding, stated plainly: "Move components," the feature the README leads with, was effectively desktop-only. It's fixed:

- All three interactions (drag, resize, marquee) rebound from `mousedown`/`mousemove`/`mouseup` to `pointerdown`/`pointermove`/`pointerup`, sharing one `trackPointer` helper rather than three separate implementations. `setPointerCapture` is what makes a drag survive leaving the element; `pointercancel` is handled identically to `pointerup` specifically because iOS fires it whenever the system interrupts a gesture (a second finger starting a pinch, an edge swipe, an incoming call) — without that handling, an object stays visually stuck to a finger that's no longer touching the screen.
- `touch-action` is **not** blanket `none`, which the prior analysis's suggested fix implied. It's `pan-y pinch-zoom` on the surface by default (so the tall result image can still be scrolled and the already-fixed pinch-to-zoom keeps working) and drops to `pinch-zoom` only in Move mode, where owning the finger drag is the entire point. Marquee mode drops it to `none` outright, since that mode explicitly gives up scrolling in exchange for rubber-band selection (§3.3).
- The resize handle's hit area grew from 11×11px (well under the 24px minimum the prior analysis flagged) to 28×28px.
- **Verified with real touch, not renamed mouse events** — see §2.9. This is the one piece of the fix that most directly answers the prior analysis's own implicit warning ("that's exactly how this got missed the first time" — testing with desktop dev tools and a mouse).

**What's still unverified: an actual physical device.** Everything above is confirmed in a headless Chromium with a synthetic touch context (`hasTouch: true`, CDP-dispatched touch events), which is a materially better test than mouse events but is not WKWebView. The pinch-vs-drag `touch-action` compromise in particular has never been felt by a human thumb.

### 3.6 Copy and honesty — both flagged issues fixed, plus a new disclosure

Both specific inaccuracies the prior analysis named are corrected:
- The footer no longer hardcodes "Runs entirely client-side with Tesseract.js" — it reads the actual running engine from `getEngineName()` and fills it in at startup, so it says "Google ML Kit" on the native build and "Tesseract.js" on the web build, correctly, without a build-time branch.
- "Your images never leave your browser" became "Your images are never uploaded anywhere" — the claim that's actually true on both builds — and the README now states the sharper distinction explicitly: *your image is never uploaded* (true, on both builds) is not the same claim as *the app makes no network requests* (not true, once Coherence Filter/translation and ML Kit's telemetry are counted).

**New disclosure, not previously present:** the API key panel now states outright that browser storage is scoped to the whole shared `github.io` origin, not to TextScanner specifically, and recommends a scoped, budget-limited key. This doesn't fix the underlying exposure (§4.3, unchanged) — it makes the existing "commendably candid" disclosure standard the prior analysis praised extend to a risk that was previously undisclosed.

---

## 4. Security

### 4.1 Threat model — unchanged, and still well handled

The threat model, and the "no injection surface" finding, are unchanged and were re-verified: still no `innerHTML`/`eval`/`document.write`/`new Function` anywhere in `js/` or `index.html`, across ~2,250 new lines.

### 4.2 RESOLVED — Subresource Integrity and CSP

The prior analysis's highest-severity finding is closed, and closed more completely than its own suggested fix: rather than add SRI to the CDN tag, **Tesseract.js is vendored** (`vendor/tesseract/`, pinned to the same 5.1.1 that was previously loaded from jsDelivr — a hosting change, not a version bump), which removes the CDN dependency outright rather than merely pinning trust in it. The library's own runtime fetches (its worker, a wasm core, and English language data — none of which markup-level SRI could ever have covered, since they're fetched by the library itself, not by a `<script>` tag) are vendored too, resolved via `tesseractAssetPaths()` in `ocrEngine.js`.

The CSP is:
```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:;
connect-src 'self' https://api.anthropic.com blob:; worker-src 'self' blob:;
style-src 'self'; object-src 'none'; base-uri 'none'
```

Two things worth flagging about how this was arrived at, because both diverge from what the prior analysis's suggested policy assumed:

1. **The prior analysis's suggested `connect-src` allowance for `tessdata.projectnaptha.com` was based on a misconception.** Tesseract.js 5.x doesn't use that host at all — language data comes from `@tesseract.js-data` on jsDelivr (now vendored). A CSP written against the projectnaptha host would have allowed a host the app never contacts while blocking the one it does. The actual host list was determined by running a scan under request logging, not by documentation.
2. **`'wasm-unsafe-eval'` is required and was not anticipated by the plan.** `script-src 'self'` alone makes Chromium refuse `WebAssembly.instantiate` outright, aborting every scan inside the Tesseract worker. It's the narrow keyword — it permits compiling WebAssembly and nothing else, unlike `'unsafe-eval'`, which would also re-open `eval()`/`new Function()` across the whole page.

**Verified against a real end-to-end scan**: zero external (non-`self`, non-`blob:`) requests, zero CSP console violations, zero console errors, correct recognized text, exercised through Text/Image-format/Full-image/editor-mode. Also verified into the native bundle: the CSP applies identically inside the WKWebView, since `index.html` is the same file on both builds.

### 4.3 UNCHANGED but now disclosed — API key in `localStorage` on a shared origin

This finding is **not fixed**, and shouldn't be read as fixed: it's a property of the hosting choice (a shared `github.io` origin), not of the code, and no code change closes it short of moving to a custom domain. What changed is the disclosure: the Coherence Filter panel now states the risk in a dedicated caveat (§3.6) rather than leaving it implicit. This closes the gap between "the module's own comment is candid about this" (already true in the prior analysis) and "the user sees it" (not true before).

The combination with §4.2 that the prior analysis flagged — a CDN compromise being a key compromise — is now moot, since there's no CDN in the loop for either the vendored Tesseract or the recognition pipeline. The Coherence Filter's own outbound call to `api.anthropic.com` remains the one legitimate off-device path, unchanged and still correctly scoped by the CSP's `connect-src`.

### 4.4 RESOLVED — the native app no longer fetches from a CDN

Closed by the same vendoring that closed §4.2, with one additional decision worth documenting: `sync-web-assets.sh` copies only `tesseract.min.js` (67 KB) into the native bundle, not the ~11 MB of wasm cores and language data the web build needs — because native recognition is ML Kit and `js/recognize.js` never falls back to Tesseract on a native platform, so the rest would be pure dead weight in the App Store binary. The script tag in `index.html` is shared between both builds (one `index.html`, no build-time branch), so the one small file has to ship even though it's never actually executed on iOS.

### 4.5 RESEARCHED AND DECIDED, not fixed — ML Kit telemetry vs. the privacy claim

The prior analysis asked for two things: (a) a decision on the documented Info.plist opt-out, and (b) copy that distinguishes the image-privacy claim from the network-silence claim. (b) is done (§3.6). (a) turned out not to be available, and that finding is itself the useful result here.

**The documented opt-out (`FirebaseDataCollectionDefaultEnabled`) belongs to Firebase.** This app has no Firebase pod — confirmed by grepping `Podfile.lock`, which contains zero Firebase entries. Searching the shipped `MLKitCommon` binary for a standalone equivalent (`strings` against the framework binary, not guessing from documentation) surfaces only internal proto field names (`isStatsCollectionEnabled`, `isFirelogEnabled`, etc.) and no Info.plist key the app can actually set.

**The decision: leave it on, and be exact about what it means rather than ship a switch that doesn't do anything.** `MLKitCommon`'s own `PrivacyInfo.xcprivacy` declares device-ID and diagnostic-data collection for analytics, unlinked and non-tracking. `docs/PRIVACY-DECISIONS.md` (new) records the research, the decision, and the honest way out if this needs to change later: dropping ML Kit for Apple's Vision framework, which removes the telemetry by removing the dependency rather than by claiming an opt-out that doesn't exist. This is the same "candid disclosure over false reassurance" standard the prior analysis praised the codebase for, applied to a case where the fix the reviewer expected to be available simply wasn't.

The four unused script models flagged alongside this finding are removed — see §2.8.

### 4.6 RESOLVED — the diagnostic dump no longer persists by default

`js/mlkitDebug.js` is now off by default and genuinely inert until armed: `recordScan()` returns immediately without creating `window.__textscannerDebug` or writing any file unless a `localStorage` flag (`textscanner.debug.mlkit`) is set, either via a `?mlkitDebug=1` URL parameter or directly from the Web Inspector console. This is the "safest interim change" the prior analysis suggested (a build-time flag was the alternative, but this project has no build step to hang one off), not the "correct final change" of deletion — the positioning bug it exists to diagnose is still open (§5.2), so the module survives with its risk substantially reduced rather than eliminated. Its header states plainly why it isn't deleted yet and what the deletion trigger is.

### 4.7 Lower-severity observations — updates only

| Item | 2026-08-28 | Now |
|---|---|---|
| `PrivacyInfo.xcprivacy` | App target had none | **Present**, app-target-scoped (no restatement of what dependencies' own manifests already declare), verified in a built app bundle |
| Decode-size DoS | Unbounded, main-thread | **Bounded**: 12 MP cap, user-visible downscale message (§2.4) |
| ML Kit script models | 5 compiled, 1 used | **1 compiled** (§2.8) |
| Everything else in the prior table (ATS, file validation, object URL lifecycle, clipboard fallback, secrets in repo, canvas tainting, hosting) | — | **Unchanged**, re-verified where checkable (no `NSAppTransportSecurity` key present; no secrets found in a repo scan) |

### 4.8 What the prior "recommended order of work" became

Every item completed, most in a different order than listed (SRI/CSP and the CDN removal were combined into one vendoring change rather than sequenced; the privacy manifest and telemetry decision were done together at the end as Phase 7, since both needed the rest of the app's copy to already be accurate). The one item that changed from "do this" to "do this differently than planned" is #4 (ML Kit telemetry) — the plan assumed a settable opt-out existed; it didn't, and the actual work was determining that and disclosing it rather than flipping a switch.

---

## 5. What's actually left

This section replaces the prior "Consolidated recommendations" — there's no longer a backlog in the same sense, since the completion plan's full scope shipped. What remains is a shorter, more specific list.

### 5.1 A device run

Nothing in this codebase has executed on a physical iPhone. Specifically unconfirmed: the `touch-action: pinch-zoom` compromise under a real thumb (verified only in a synthetic CDP touch context); the Foundation Models path on an actual Apple Intelligence-eligible device (the Swift compiles, per `xcodebuild`, and the availability logic is verified against a simulated JS-side bridge, but the model has never run); and native network traffic under an actual packet capture, which is the one claim in `docs/PRIVACY-DECISIONS.md` that's verified statically (dependency-tree analysis) rather than empirically.

### 5.2 The ML Kit positioning bug — still open, now the oldest item in the project

Untouched by any of the eight phases, and by a wide margin the longest-open finding across both analyses. `js/mlkitDebug.js` is built and gated (§4.6); `test/replay-dump.js` is ready to replay a device dump offline in three variants. The diagnosis from the prior handoff stands unchanged: the renderer is exonerated (`render-fidelity.js`), a fixed coordinate transform is ruled out (some images render correctly, some don't, with no dimension-based pattern), and the remaining question — misplaced boxes vs. correctly-placed boxes flooded with unreadable fine print — needs exactly one instrumented device run to resolve. `js/mlkitDebug.js`, its import, and `test/replay-dump.js` should be deleted once it is.

### 5.3 The benchmark corpus

The hard limit on any further recognition work, stated precisely in §2.4: eight scoring images cannot resolve a one-point CER difference, which is smaller than the effect size of most plausible tuning changes. `test/images/README.md` has the categories and the process; this is the one piece of Phase 3 that was explicitly left blocked because it needs real source photographs no amount of engineering time substitutes for.

### 5.4 Known limitations, carried forward deliberately

Not oversights — each was investigated and the decision is documented where it lives:

- Moving a word doesn't clean up its vacated spot (§2.6) — untouched, longest-standing editor gap.
- No bold/regular font-weight detection (§2.6) — measured, doesn't work, not shipped.
- Non-Latin translation output can't be re-scanned on the native build (§3.1) — disclosed at the point of use.
- ML Kit telemetry has no available opt-out (§4.5) — researched, disclosed, not fixable without dropping the dependency.
- The web build still requires a BYOK Claude key for both Coherence Filter and translation — there's no on-device model in a browser, and the plan explicitly rejected pretending otherwise.
- The shared-origin key exposure (§4.3) — disclosed, not fixable without a custom domain.

---

*This revision is based on a full read of every file touched across `Phase 0` through `Phase 7` of the git history (commits `d77e029` through `9f7990a`), plus `HANDOFF.md`'s post-completion rewrite (`7ff391e`), against the 2026-08-28 analysis it supersedes in structure but not in content — every section above is a delta against that version, not a rewrite from a blank page.*
