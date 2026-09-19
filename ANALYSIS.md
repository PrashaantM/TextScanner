# TextScanner — Architecture, Design & Security Analysis

**Date:** 2026-09-09 · **Commit:** `4ae7cfd` (with a §8 addendum at `ca341d7`) · **Branch:** `main`
**Scope:** folder structure, system design, UI/UX design, security. This is the **third revision**, written against the *web-complete* state — every code path reachable without hardware now has an automated gate, and those gates run in CI on every push. It supersedes [`docs/archive/analysis-2026-08-29.md`](docs/archive/analysis-2026-08-29.md), which supersedes [`docs/archive/analysis-2026-08-28.md`](docs/archive/analysis-2026-08-28.md); both are preserved rather than overwritten.

**Section 6 is explicitly incomplete.** On-device behaviour is unconfirmed at this revision and is Phase 8's job. Everything else here is closed by evidence.

**Section 8 is an addendum**, written after the hardening plan closed. The app gained a document library, a notes editor, multi-page scanning and PDF export in commit `ca341d7`, which is a large enough change that leaving §§0-7 describing the older app would make them wrong. They are left as they were - accurate for `4ae7cfd` - and §8 records what changed, what it cost, and what it did NOT change.

**Citation standard, carried forward unchanged:** every claim below cites an artifact present at this commit — a test file, a measured number, a CI run, or a line of source. Nothing is called "verified" or "fixed" without one. Null results are findings and are written down as such.

---

## 0. Executive summary

TextScanner is a **zero-build, dependency-light, local-first OCR and image-text-editing app**: 5,709 lines of vanilla ES-module JavaScript across 24 modules, deployed straight to GitHub Pages, wrapped in a Capacitor iOS shell that dispatches between Tesseract.js and native Google ML Kit, plus two features (Coherence Filter, translate-in-place) that dispatch between Apple's on-device Foundation Models and a BYOK Claude fallback.

The headline of this revision is not a feature. It is that **the oldest open bug in the project is closed, and was closed without a device** — by generating recognition fixtures with exact ground truth rather than waiting for a device dump that would have had none.

### What changed since 2026-08-29

**The ML Kit positioning bug is fixed, root-caused, and gated.** Not EXIF orientation — that hypothesis is *disproved* here, since none of the 11 corpus images carries an orientation tag at all ([`test/make-mlkit-fixture.js`](test/make-mlkit-fixture.js) documents the probe). The cause is **axis-aligned envelope inflation**, and it is arithmetic:

> `flattenBlocks` discarded ML Kit's `cornerPoints`, so `renderImageFormatView` derived each word's font size *and* origin from the axis-aligned box. For tilted text that box is the **envelope around** the word, not the word. A word of true size `w × h` tilted `t°` has an envelope `h·cos(t) + w·sin(t)` tall — **1.00× at 0°, 2.12× at 15°, 3.18× at 40°** ([`test/unit/mlkit-geometry.test.js`](test/unit/mlkit-geometry.test.js)).

Long words inflate worst and overlap their neighbours. That matches the reported symptom exactly: gibberish on the angled posters, "really good" on the flat-on screenshots. §2.4 has the full account.

**CI went from 6 test gates to 10, and the browser-based ones had just broken.** Proving the gate actually gates (Phase 3 step 2) found a real pre-existing bug: the workflow installed browsers through the `playwright` package while the tests resolve through `playwright-core`. Two packages, two independently-pinned browser revisions; they agreed until an upstream release, and then every browser gate failed at launch rather than on its assertions. §2.9.

**Two documentation claims were found to be wrong** and are corrected here rather than repeated — see §4.1 and §4.5. Both were in the prior revision's security section.

### Status of every item the prior revision left open (§5)

| Prior §5 item | Severity | Status now |
|---|---|---|
| **5.2** ML Kit positioning bug — "the oldest item in the project" | High | **FIXED and gated.** Root cause is envelope inflation, not EXIF (§2.4). 15 unit assertions + a 232-word browser replay, both in CI |
| **5.1** No device run | Medium | **STILL OPEN**, and deliberately last. Now confirmation-only — every checklist item maps to a passing gate (§6) |
| **5.3** Benchmark corpus too narrow | Medium | **PARTIALLY CLOSED.** Noise floor measured at 0.00pts; non-Latin added as a known-limitation assertion. The 14-image expansion is **BLOCKED** on photographs that cannot be generated ([`test/TUNING-2.md`](test/TUNING-2.md)) |
| **13** Native network claims verified statically, not by packet capture | Medium | **STILL OPEN** — Phase 8.1 |
| **15** Nothing has run on a physical iPhone | Medium | **STILL OPEN** — but the native project *builds* clean (§5.6) |
| **4.5** ML Kit telemetry, no opt-out | Medium | **ANSWERED in its submission-blocking form** (§4.5). Google's manifests declare six data types, unlinked and non-tracking. The *product* question is still open; only the Vision migration removes it |
| **4.3** API key on a shared `github.io` origin | High | **STILL OPEN, correctly.** Blocked on a domain. The prepared migration is [`docs/CUSTOM-DOMAIN-MIGRATION.md`](docs/CUSTOM-DOMAIN-MIGRATION.md); the caveat copy must **not** change before the move (§4.3) |
| **4.6** Diagnostic dump persists recognized text | Medium | **FIXED BY DELETION.** `js/mlkitDebug.js` and `test/replay-dump.js` are gone; no code path now persists recognized text anywhere (§4.6) |
| **5.4** `script: "LATIN"` non-Latin gap | Low | **ASSERTED, not fixed** — as intended. Now a tracked number with a tripwire ([`test/non-latin-limitation.js`](test/non-latin-limitation.js)) |
| **5.4** Moving a word doesn't clean its vacated spot | Low | **FIXED** in `fc82803`, verified this pass ([`test/move-inpaint.js`](test/move-inpaint.js)) |
| **5.4** No font-weight detection | Informational | **OVERTURNED 2026-09-17.** The measurement was right about *ink fraction*; the conclusion generalised it to the whole problem. [`js/fontMatch.js`](js/fontMatch.js) compares a word against a rendering of the **same string** in each candidate face rather than against an absolute threshold, which cancels both confounds and recovers weight on **99.0%** of a scored corpus ([`test/font-match.js`](test/font-match.js)) |

### New findings from this revision

| # | Finding | Area | Severity |
|---|---|---|---|
| 16 | CI installed browsers through the wrong package, so all 9 browser-based gates failed at launch rather than on their assertions | Testing | **Medium — fixed** (§2.9) |
| 17 | 3 of 6 CSS transitions used hardcoded durations, so `prefers-reduced-motion` did not zero them — despite a comment claiming every transition used the tokens | Design | **Low — fixed** (§3.7) |
| 18 | The prior revision's "no `innerHTML` anywhere in `js/`" was factually wrong when written | Security | **Informational — corrected, not a vulnerability** (§4.1) |
| 19 | The privacy manifest's comment understated ML Kit's declared collection from six categories to two | Security | **Low — corrected** (§4.5) |
| 20 | The app icon is the unmodified Capacitor template logo | Design | **Medium — submission blocker, needs a design decision** (§5.3) |
| 21 | Deployment target is iOS 15.5; Vision's `automaticallyDetectsLanguage` needs iOS 16 | Design | Informational — quantifies a previously-open cost (§5.6) |
| 22 | Benchmark noise floor is 0.00pts across two runs — provisional, not proof of determinism | Testing | Informational (§2.10) |

---

## 1. Folder structure

### 1.1 Layout — what this revision added

```
TextScanner/
├── ANALYSIS.md                     ← this file, third revision
├── index.html                      ← unchanged; CSP still verified
├── style.css                       ← all 6 transitions now on --motion-* tokens (§3.7)
├── js/                             ← 24 modules, 5,709 LOC (was 23 / ~5,450)
│   └── mlkitDebug.js               ← DELETED (§4.6)
├── test/
│   ├── make-mlkit-fixture.js       ← NEW: fixtures with exact ground truth
│   ├── fixtures/mlkit/             ← NEW: 6 committed fixtures, 232 words
│   ├── unit/mlkit-geometry.test.js ← NEW: 15 assertions, the coordinate contract
│   ├── heic-input.js               ← NEW: the CI half of a two-part case
│   ├── non-latin-limitation.js     ← NEW: pins a limitation, not an accuracy target
│   ├── make-non-latin-images.js    ← NEW: generates its samples
│   ├── web-tier-smoke.js           ← NEW: both Claude tiers (mocked), TTS, export
│   ├── images/non-latin/           ← NEW: 3 scripts + a Latin control
│   ├── images/format-checks/       ← NEW: a real HEIC
│   ├── TUNING-2.md                 ← NEW: noise floor; records what is blocked and why
│   └── replay-dump.js              ← DELETED (§4.6)
└── docs/
    ├── archive/                    ← NEW: both prior revisions, preserved
    ├── VISION-FRAMEWORK-MIGRATION-SCOPE.md  ← NEW (Phase 4)
    ├── APP-STORE-SUBMISSION.md              ← NEW (Phase 6)
    └── CUSTOM-DOMAIN-MIGRATION.md           ← NEW (Phase 5, blocked)
```

### 1.2 The one-source-of-truth rule — held, and exercised

Deleting `js/mlkitDebug.js` was the first real test of the generated-tree discipline since the `textUtil.js` drift the 2026-08-28 revision flagged. Both `www/` and `ios/App/App/public/` carried stale copies importing the deleted module — which would have broken a native build while the source tree was clean. Both were regenerated ([`scripts/sync-web-assets.sh`](scripts/sync-web-assets.sh)), and the native project then compiled: `** BUILD SUCCEEDED **`, exit 0, zero errors (§5.6).

This is the failure mode the rule exists to prevent, and it is worth noting that **the rule did not catch it — a grep did.** Nothing automated checks that the generated trees are current.

### 1.3 Documentation — the standard held, including against itself

Two prior claims were checked and found wrong (§4.1, §4.5). Both are corrected in place rather than quietly dropped. That is the citation standard applied to the document's own history, which is the only way it means anything.

[`test/TUNING-2.md`](test/TUNING-2.md) continues the negative-results practice `TUNING.md` started, and extends it: it records not only a null result (the noise floor) but **work deliberately not done**, with the reasoning — re-tuning against the same 11 images that produced the current thresholds would be circular, so the sweep is rejected rather than run and reported.

---

## 2. System design

### 2.4 Recognition — the positioning bug, closed

This replaces the prior revision's §5.2, which had stood since the first analysis.

**Why it stayed open so long.** Both prior revisions concluded it needed "exactly one instrumented device run." The instrumentation was built ([`js/mlkitDebug.js`](docs/archive/analysis-2026-08-29.md)) and a three-variant offline replay was ready. The flaw in that plan is that **a device dump has no ground truth.** You can replay it and look at the result, but "does this look right?" is precisely the ambiguity that left the bug unresolved across two analyses.

**What actually resolved it.** [`test/make-mlkit-fixture.js`](test/make-mlkit-fixture.js) generates ML-Kit-shaped results from known word placements — `boundingBox` and `cornerPoints` derived independently from the same placement, exactly as ML Kit derives them. A synthetic fixture knows where every word belongs to the pixel, so a wrong coordinate is a failing number rather than an opinion.

**The contract that was never asserted.** `renderImageFormatView` ([`js/editorObjects.js`](js/editorObjects.js)) does `x0 / naturalWidth * 100` and three siblings. So word bboxes must be in original-image pixel space, bounded by `naturalWidth × naturalHeight`. **Nothing anywhere in the repo asserted that.** It is the first thing [`test/unit/mlkit-geometry.test.js`](test/unit/mlkit-geometry.test.js) checks now.

**Hypothesis 1, EXIF orientation — disproved.** The reasoning was sound: the web layer's `naturalWidth`/`naturalHeight` are post-EXIF-correction ([`test/exif-orientation.js`](test/exif-orientation.js) asserts this across all 8 values), while `mlkitEngine.js` handed ML Kit the raw file bytes with the tag intact. But **none of the 11 corpus images carries an orientation tag**, so it cannot explain the reported symptom. This matches what `mlkitDebug.js`'s own header had observed and never followed up: "no correlation to image dimensions or EXIF orientation."

**Hypothesis 2, envelope inflation — confirmed, analytically.** For a word of true size `w × h` tilted `t°`, the axis-aligned envelope is `h·cos(t) + w·sin(t)` tall. Since `fontSizePct` derives directly from box height, the span renders at that ratio:

| Tilt | Font-size inflation | Reported behaviour |
|---|---|---|
| 0° | **1.00×** | "really good" (flat-on screenshots) |
| 3° | 1.22× | — |
| 15° | **2.12×** | "gibberish" (angled posters) |
| 40° | **3.18×** | "gibberish" |

Measured by replaying the pre-fix `flattenBlocks` against the same fixtures. The origin slips too, and asymmetrically: rotating clockwise about the word's own top-left leaves the envelope's *top* correct and pushes its *left* out by `h·sin(t)`; anticlockwise does the reverse, by `w·sin(t)` — much larger, since `w >> h`. Both directions are asserted, because getting only one right is how a coordinate bug survives a test.

**The fix.** `flattenBlocks` now threads `cornerPoints` through as a `quad` and derives a `frame` — the word's true origin, baseline length, glyph height and tilt. `bbox` keeps its existing axis-aligned envelope semantics, so every other consumer (`filter.js`, `editorExport.js`, the editor's move/resize maths) is untouched. `renderImageFormatView` uses the frame when present and the envelope when not — and **words with no corner points, which is the entire Tesseract path, render exactly as before.** The benchmark confirms it: **+0.00pts CER and WER** against `test/baseline-2026-08-28.json`.

Rotation is applied as a CSS transform. `.image-format-word` already carried `transform-origin: top left`, which is the same corner `obj.x`/`obj.y` anchor — the renderer was built anticipating this. `.image-format-patch` needed the same property added, or a tilted word's inpaint patch would have pivoted about its centre and swung off the ink it exists to hide.

**A latent hazard fixed alongside it.** `mlkitEngine.js` now re-encodes the decoded image as an upright, EXIF-free JPEG before ML Kit sees it. The plugin does `UIImage(contentsOfFile:)` then sets `visionImage.orientation` (`TextRecognition.swift`, in the `@capacitor-mlkit/text-recognition` pod — not linked, since `node_modules/` is gitignored), and `UIImage` does **not** rotate the pixel buffer on load — so the coordinate space ML Kit reports into depended on how a third-party SDK reconciles a rotated buffer with an orientation flag. That is not something this app can pin down or should depend on. Drawing through a canvas makes both spaces `naturalWidth × naturalHeight` **by construction**. This did not cause the reported bug, and is documented as defensive rather than as the fix.

### 2.5 Engine abstraction — extended without a new seam

The `quad`/`frame` fields are additive and optional. `js/recognize.js`'s dispatch is unchanged, and the renderer's fallback is the same branch that serves Tesseract. The single-seam pattern absorbed an engine-specific geometry concept without either engine learning about the other.

### 2.9 Testing — 12 CI gates, and one that wasn't gating

CI grew from 6 test gates to 10 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), on top of the two setup steps:

| Gate | What it pins |
|---|---|
| `node --test test/unit/*.test.js` | 60 unit tests (was 45) — 15 new for ML Kit geometry |
| `run-benchmark.js --check-regression` | CER/WER vs. the recorded baseline |
| `touch-interactions.js` | Real touch via CDP |
| `malformed-input.js` | 4 malformed inputs → categorized errors |
| `exif-orientation.js` | All 8 orientations converge |
| `move-inpaint.js` | Vacated pixels match the patch |
| **`render-fidelity.js`** | **NEW gate:** 232-word fixture replay through the real renderer |
| **`non-latin-limitation.js`** | **NEW:** a limitation stays a limitation, and fails safely |
| **`heic-input.js`** | **NEW:** HEIC fails gracefully where there is no codec |
| **`web-tier-smoke.js`** | **NEW:** both Claude tiers (mocked), TTS, export |

**The gate that wasn't gating.** Phase 3 step 2 required demonstrating the gate fails and recovers on a real push, on the principle that an untested failure path is not a gate. Doing it produced two results:

1. **The gate gates.** A deliberate regression — disabling the quad handling, exactly the §2.4 fix — failed [run 34396467400](https://github.com/PrashaantM/TextScanner/actions/runs/34396467400) on `node --test`, catching 6 assertions including *"the envelope height of tilted text inflates exactly as h·cos(t) + w·sin(t)"*. Reverting went green: [run 34396624486](https://github.com/PrashaantM/TextScanner/actions/runs/34396624486).

2. **A real pre-existing bug**, unrelated to the regression, which is why the Part I push went red on main while the whole suite passed locally *and* from a clean checkout. The workflow ran `npx playwright install`, resolving the **`playwright`** package from npm at run time, while `test/package.json` depends on **`playwright-core`**. Two packages, two independently-pinned browser revisions. They agreed on the previous run and no longer did:

   ```
   Couldn't launch Chromium: Executable doesn't exist at
   .../chromium_headless_shell-1234/chrome-headless-shell-linux64/...
   ```

   All 9 browser-based gates — the benchmark regression check included — were failing at launch rather than on their assertions. Only `node --test`, which needs no browser, still ran. Installing through `playwright-core` makes the revisions agree by construction.

   **This was not a break introduced by this work**: the previous run passed with the identical step, and only an upstream `playwright` release moved the two revisions apart. It failed loudly rather than silently, which is the good case — but the setup was one package bump away from taking the whole browser suite with it at any time, and nothing would have flagged that in advance. It is the strongest available argument for having run Phase 3 step 2 at all.

**Mocking discipline.** `web-tier-smoke.js` intercepts `api.anthropic.com` and answers locally. This is a hard requirement, not a convenience: a live call would need a real key in CI, would bill the account on every push, and would fail whenever a third party had an outage. It also tests *more* than a live call could — you cannot ask the real API for a 429 on demand.

**Clean-checkout verification.** The full suite was run from `git checkout-index` of the tracked tree only — no `node_modules`, no `www/`, no untracked local state — followed by `npm ci`. Everything passed, so nothing depends on a developer machine's incidental state.

### 2.10 The noise floor — measured, and provisional

Two `run-benchmark.js` runs against identical code were **bit-identical**: 68.2597% CER, 112.0133% WER, per-image delta 0.000000pts on all 11 images.

With a floor of zero, Phase 2's merge rule ("twice the noise floor") reduces to *any strictly positive improvement that reproduces*, and the reproduction half now carries all the weight.

**It is not proof of determinism**, and [`test/TUNING-2.md`](test/TUNING-2.md) says so explicitly. Two runs on one machine cannot distinguish "always deterministic" from "deterministic here." Marginal images — where two interpretations score almost identically — are where non-determinism would first appear, and the current corpus may simply not contain one. Several of the categories still missing (low light, steep skew) are exactly the ones that produce them.

---

## 3. UI & UX design

### 3.7 Motion — the tokens, and the three that weren't

`fc82803` introduced `--motion-fast/medium/slow` with a single `prefers-reduced-motion` block zeroing all three, and a comment stating:

> *"Every transition below references these tokens rather than a hardcoded duration, so a person who's set the OS-level 'reduce motion' preference gets every one of them disabled from this single block — no per-rule exceptions to track down."*

**That was untrue when written.** Auditing it against its own acceptance criterion (Phase 3 step 1) found **3 of 6** transition declarations using hardcoded durations — the drop zone (`0.15s`), `.btn` (`0.15s`/`0.05s`), and the mode/filter toggle `:active` (`80ms`). None was zeroed by the reduced-motion block. A person who had asked the OS to reduce motion still got animation on every button press in the app.

All six now reference the tokens, so the comment is true. The finding is worth recording for a reason beyond the fix: **the comment was the only thing asserting the invariant, and a comment cannot fail.** The single-block design is good precisely because it is checkable — `grep -E '^\s*(transition|animation):' style.css | grep -v 'var(--motion-'` returns nothing, and that is a real check where the prose was not.

> **Correction, 2026-09-13 (after `e181738`).** Two claims in the paragraph above
> have not survived, and are corrected here rather than left standing.
>
> **The invariant broke again, and nothing noticed for two commits.** `e181738`
> added `.radial-menu__item` with `transform 140ms … opacity 100ms … box-shadow
> 120ms … background 120ms` — four hardcoded durations, none reachable from the
> single block. Reduced motion still worked for that menu, but by a *second*
> mechanism (`js/radialMenu.js` adds `.radial-menu--instant` off `matchMedia`),
> not by the one this section is about. All four are tokenized now, with a new
> `--motion-bloom` for the 140ms travel, which `js/radialMenu.js`'s
> `CLOSE_TRANSITION_MS` is coupled to and which the single block zeroes with the
> other three. The `opacity` fade moved 100ms → 120ms in the process; that is a
> deliberate, stated change, not a rounding.
>
> **And the grep above is not a sufficient check.** Two problems, both found by
> trying to use it as one. It reports four false positives it cannot reason
> about — `transition: none` (no duration to tokenize), a declaration *inside*
> the reduced-motion block (it is the reduced path), and the infinite
> `.scan-busy__spinner`, whose duration must **not** be tokenized because a
> zeroed `animation-duration` on an infinite animation freezes the spinner
> instead of calming it. And its `^\s*` anchor is a hole: a rule written on one
> line (`.thing { transition: opacity 200ms; }`) never matches it at all.
>
> [`test/motion-contract.js`](test/motion-contract.js) replaces it and runs in
> CI, second step, before any browser is installed. It strips comments, tracks
> block structure to recognise the reduced-motion path, covers the `-duration`
> longhands, and carries the spinner as the single allowlist entry *with its
> reason attached* — plus an assertion that the allowlist entry still matches
> something, so a stale exemption cannot quietly become a hole. Verified against
> six seeded regressions, including the exact `e181738` one and the two
> single-line cases the old grep missed.

### 3.8 Haptics — correctly scoped, correctly silent

[`js/haptics.js`](js/haptics.js) is gated behind `window.Capacitor?.isNativePlatform?.()`, optional-chained through to the plugin, and every call ends in `.catch(() => {})`. On web it is a silent no-op rather than a throw — verified by every browser test in the suite running through code paths that call it without a single uncaught page error.

Six call sites across `editorInteractions.js` (selection, gesture completion) and `main.js` (filter toggle, delete, scan completion). The `LIGHT`/`MEDIUM` split maps to gesture-scale: light for selection and adjustment, medium for committed or completed actions.

The design decision worth naming: haptics are **fire-and-forget and never awaited**. Feedback is polish, and a tap, drag or delete must never fail because a haptic did.

### 3.9 Rotated words — a visual improvement that came free

§2.4's fix changes what the editor looks like on tilted source text: words now sit *over* the text they were read from, at the right size and angle, instead of oversized and axis-aligned. Because rotation is a CSS transform and every gesture measures through `getBoundingClientRect()` ([`js/editorInteractions.js`](js/editorInteractions.js) — drag, resize and marquee hit-testing all do), **the interaction model needed no changes at all**: the browser accounts for the transform. `obj.x`/`obj.y` remain the word's own anchor, so dragging still moves it and resizing still scales it.

---

## 4. Security

### 4.1 Threat model, and a correction to the record

The threat model is unchanged and still well handled. But the prior revision's claim —

> *"still no `innerHTML`/`eval`/`document.write`/`new Function` anywhere in `js/` or `index.html`"*

— **was factually wrong when it was written.** [`js/main.js:796`](js/main.js#L796) does `translateTarget.innerHTML = ""`, and `git show 7ff391e:js/main.js` puts it at line 770 in the very commit the claim was made against.

**It is not a vulnerability.** It assigns a constant empty string to clear a `<select>`, and the options are rebuilt with `createElement` + `textContent` immediately below. There is no attacker-controlled data anywhere near it, and no injection surface.

It is recorded because a security section that repeats an unverified absolute is worth less than one that checks and corrects. The accurate claim: **no `eval`, `document.write` or `new Function` anywhere in `js/` or `index.html`, and the single `innerHTML` assignment writes a constant empty string.**

### 4.3 API key on a shared origin — still open, and must stay disclosed

**Unchanged, and deliberately so.** This is a property of the hosting origin, not the code, and only a custom domain closes it.

The temptation is to write the corrected copy now so it is ready. **That would make the app lie.** The current caveat — that any other site on the shared `github.io` origin can read the key back — is true right now. Replacing it before the app actually moves would tell users their key is safer than it is.

[`docs/CUSTOM-DOMAIN-MIGRATION.md`](docs/CUSTOM-DOMAIN-MIGRATION.md) has the whole migration prepared: the exact replacement copy, the re-entry notice for keys that will not survive the origin change, and the CSP re-check. One part is already verified: **no hardcoded `github.io` URL exists anywhere.** `grep -rn "github\.io" js/ index.html style.css` returns three matches and none is a URL — two comments and the caveat copy itself. So no code change is needed for the app to work on a new domain.

### 4.5 ML Kit telemetry — answered in submission form, corrected in substance

The prior revision recorded that no standalone opt-out exists (the documented one is Firebase's; this app has no Firebase pod). That stands.

**What is new is what the manifests actually say**, read from the installed Pods rather than recalled. The app-target manifest's own comment claimed MLKitCommon declares "the device ID and diagnostic data it sends to Google." That **understated six categories down to two**:

| Pod | Declared collection |
|---|---|
| **MLKitCommon** / **MLKitTextRecognitionCommon** | DeviceID, OtherDataTypes, **OtherUserContent**, PerformanceData, ProductInteraction *(Analytics, App Functionality)*; OtherDiagnosticData *(Analytics)* |
| **GoogleDataTransport** | OtherDiagnosticData *(Analytics)* |
| GoogleUtilities, GTMSessionFetcher, GoogleToolboxForMac, PromisesObjC, nanopb | none |

All are `Linked = false` and `Tracking = false` — not tied to identity, not used across apps. `NSPrivacyTracking` is `false` app-wide with no tracking domains.

**`OtherUserContent` is the one to read twice**, because this app's user content is photographs of text. The declaration is Google's, covering ML Kit's whole surface including cloud-backed products this app does not use, and on-device recognition plausibly exercises little of it. But the manifest is what Apple aggregates, and **under-declaring is the failure mode with consequences.** The nutrition label must declare it; [`docs/APP-STORE-SUBMISSION.md`](docs/APP-STORE-SUBMISSION.md) §3 has the full row-by-row answers.

`ios/App/App/PrivacyInfo.xcprivacy`'s comment is corrected to list all six. **Phase 6 step 4's question — does ML Kit ship its own manifest that merges into yours — is answered: yes**, both frameworks carry one, and the app target correctly restates none of it.

The *product* question is untouched: whether to depend on an SDK that does this at all. Only the Vision migration removes it, by removing the dependency.

### 4.6 The diagnostic dump — resolved by deletion

The prior revision called gating it "the safest interim change, not the correct final change," with deletion blocked on the positioning bug being open. **The bug is closed (§2.4), so the module is deleted.** `js/mlkitDebug.js` and `test/replay-dump.js` no longer exist, and neither does the `?mlkitDebug=1` parameter or the `textscanner.debug.mlkit` key.

**There is now no code path, armed or otherwise, that persists recognized text anywhere.** That is a stronger statement than the prior revision could make, and it came free with the bug fix: the fixture suite that replaced the dump contains no user text at all.

### 4.7 What the diagnostic export still does — unchanged and still opt-in

[`js/diagnostics.js`](js/diagnostics.js) is a *different* thing from the deleted dump and survives: user-triggered, through the native share sheet, with the source image included **only** if the user ticks the box (`buildDiagnosticReport(includeImage)`, line 41). Nothing writes it to disk unprompted. The device half of this is Phase 8.

---

## 5. Release readiness

### 5.3 The app icon is the Capacitor template — submission blocker

`ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` is technically compliant: 1024×1024, **no alpha channel** (alpha is an automatic rejection), single-size `Contents.json` from which Xcode derives every other size.

It is also **the unmodified Capacitor logo** — a blue "⨉" on a faint grid. Apple rejects template and placeholder assets under Guideline 4.0, and independently it is the wrong brand.

This is flagged rather than fixed because an app icon is brand identity, which is a decision for the project's owner and not one to make unilaterally. The technical requirement is one file at that path.

### 5.4 Metadata and the nutrition label — drafted

[`docs/APP-STORE-SUBMISSION.md`](docs/APP-STORE-SUBMISSION.md) has name, subtitle (with the character count corrected — the natural phrasing is 31 and the limit is 30), description built from what `README.md` already claims rather than new marketing, keywords at 94/100 characters, and the complete nutrition-label answers derived from §4.5's manifest audit.

Support and marketing URLs are **blocked on Phase 5** — they should be the custom domain, and using the `github.io` URL would mean changing them again immediately.

### 5.5 Usage descriptions — verified, no change needed

Both `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` name what is accessed, why, and what happens to it. Apple rejects generic strings; these are not generic. Both claims are true of the scanning path: recognition is on-device, and the Claude tier transmits *text*, never the image.

### 5.6 The native build compiles

```
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
           -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

**`** BUILD SUCCEEDED **`, exit 0, zero errors** (Xcode 26.6). Every warning is from a dependency — Capacitor's own Swift and the CocoaPods resource-copy phase — none from this project's code.

This is **not** Archive → Validate App, which is Phase 6 step 6 and is blocked on an App Store Distribution certificate. It does establish that the project, the Pods and the synced web assets compile together after this revision's changes, including the deletion of a module the generated trees still referenced (§1.2).

**Deployment target is iOS 15.5**, which resolves a cost left unquantified in [`docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md`](docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md): Vision's `automaticallyDetectsLanguage` requires iOS 16, so a migration wanting automatic multi-script support must raise the floor or set `recognitionLanguages` explicitly.

### 5.7 Vision framework — scoped, and the recommendation is to wait

[`docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md`](docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md), verified against the iOS 26.5 SDK headers rather than documentation:

- **The corner-point question is answered definitively.** `VNRecognizedTextObservation : VNRectangleObservation`, which exposes `topLeft`/`topRight`/`bottomLeft`/`bottomRight` — but **normalized (0–1) with a bottom-left origin**, where ML Kit reports top-left pixels. Getting the y-flip wrong mirrors every word.
- **Vision would close the non-Latin limitation** (`automaticallyDetectsLanguage`, subject to §5.6's iOS 16 floor) **and add per-word confidence**, which ML Kit does not expose at all — lighting up the low-confidence underline on native for the first time.
- **It deletes the §4.5 telemetry question** by deleting the dependency, along with ~49 MB of bundled models and `scripts/trim-mlkit-scripts.js`.
- **The blocker is that Vision has no word level.** It returns line observations; per-word geometry comes from `boundingBoxForRange:`, which Apple's own header documents as *"purely meant for UI purposes and not for image processing."* This app does image processing on those boxes — colour sampling, ink appearance, inpaint patches.
- **Recommendation: do not migrate yet**, because nobody has measured whether Vision reads this corpus as well as ML Kit does. Phase 2's merge discipline should apply to an engine swap at least as strictly as to a threshold.

**§2.4's fixture suite is reusable as that migration's acceptance test**, which is the main argument that it is now low-risk work rather than a leap.

---

## 6. Device verification — pending Phase 8

**On-device behaviour is unconfirmed at this revision. Nothing in this codebase has executed on a physical iPhone.**

This section is a placeholder, and stating that plainly is the point. What is *known* is that the project builds for a device (§5.6) and that every item on [`docs/DEVICE-VERIFICATION-CHECKLIST.md`](docs/DEVICE-VERIFICATION-CHECKLIST.md) now maps to a passing automated gate — so Phase 8 confirms rather than discovers, and a failure there is a **contradiction to investigate**, not an open question.

Specifically unconfirmed:

| Check | The gate it should confirm |
|---|---|
| Word positioning on real photos, portrait included | §2.4 — the fixture suite. **The one that matters most**: if a portrait photo still misplaces words, the fixtures missed a case |
| HEIC decoding and scanning | [`test/heic-input.js`](test/heic-input.js) asserts graceful *failure* where there is no codec; the device has one, so anything but success is a real failure |
| Pinch-zoom under a real thumb | The `931ddc6` fix, verified only in a synthetic CDP touch context |
| Apple Intelligence tiers | Smoke-tested only; the model has never run |
| Haptics | §3.8 — gated correctly, never fired |
| Reduce Motion actually disabling transitions | §3.7 — now genuinely single-block |
| Native network hosts under packet capture | The one `docs/PRIVACY-DECISIONS.md` claim verified statically, not empirically |

Phase 9 fills this section in with real results and updates §0's status table.

---

## 7. What's actually left

### 7.1 The device run

Unchanged as an item, changed in character: it is now confirmation, not discovery. §6 has the mapping. `ubcsecure` is 802.1x and will not carry a manually configured proxy, so the capture method is `rvictl` + Wireshark over USB, filtering `tls.handshake.type == 1` — SNI is plaintext in the ClientHello, so host confirmation needs no CA trust and no decryption.

### 7.2 The benchmark corpus — the honest blocker

**Still the hard limit on any further recognition work**, and the one item in this plan that engineering time cannot substitute for. Phase 2 needs 14 newly shot photographs across low light, steep skew, dense small text, a receipt, a street sign, a photo of a screen, and non-Latin script — on the phone used for the device pass.

These cannot be generated. A synthesized image has none of the sensor noise, motion blur, rolling-shutter skew or lens geometry that make those categories worth testing, and generating them would produce a corpus that measures the generator rather than the pipeline. The threshold sweep is deliberately **not run** until they exist, because re-tuning against the same 11 images that produced the current thresholds would be circular ([`test/TUNING-2.md`](test/TUNING-2.md) §3).

### 7.3 The custom domain

Blocked on a registrar login. Everything else is prepared (§4.3).

### 7.4 App Store submission

Three real blockers, in [`docs/APP-STORE-SUBMISSION.md`](docs/APP-STORE-SUBMISSION.md) §8: the icon (§5.3), the support/marketing URLs (blocked on the domain), and Archive → Validate App (needs a Distribution certificate). Screenshots follow the icon.

### 7.5 Known limitations, carried forward deliberately

Each investigated, each documented where it lives:

- **`script: "LATIN"`** — now *asserted* rather than merely known, with measured CER per script and a tripwire that fires if it ever starts working ([`test/non-latin-limitation.js`](test/non-latin-limitation.js)). Vision would close it (§5.7).
- **ML Kit telemetry** — researched, now precisely quantified (§4.5), disclosable. Not fixable without dropping the dependency.
- **The shared-origin key exposure** — disclosed, blocked on the domain (§4.3).
- **Font matching does not identify the typeface** — and cannot, from a word-sized crop against a handful of system stacks. [`js/fontMatch.js`](js/fontMatch.js) recovers the attributes a reader notices (weight, slant, serif-ness, monospace, width class) and picks the nearest available face; a photo set in Futura comes back as the system sans at the right weight, not as Futura. Monospace (37.5%) and italic (66.3%) are deliberately tuned for precision over recall — a missed italic stays upright, while a wrongly-italicised one is glaring and lands on every word of a hand-lettered image at once. Perspective shear is indistinguishable from a slanted typeface in a word-sized crop.
- **Non-Latin translation output can't be re-scanned on native** — disclosed at the point of use.
- **The web build requires a BYOK Claude key** for both Coherence Filter and translation — there is no on-device model in a browser.
- **Nothing verifies the generated trees are current** (§1.2). A stale `www/` or `ios/App/App/public/` breaks a native build while the source tree looks clean. This pass caught one by grep; nothing would have caught it automatically. A cheap gate, not yet built.

---

*This revision is based on a full read of the repository at `4ae7cfd`, the git history across Phases 1–6, the installed CocoaPods privacy manifests, the iOS 26.5 SDK's Vision headers, and CI runs [34396467400](https://github.com/PrashaantM/TextScanner/actions/runs/34396467400) (deliberate failure) and [34396624486](https://github.com/PrashaantM/TextScanner/actions/runs/34396624486) (recovery). It is a delta against [`docs/archive/analysis-2026-08-29.md`](docs/archive/analysis-2026-08-29.md), not a rewrite from a blank page — sections unchanged since that revision are not restated here, and two of its claims are corrected (§4.1, §4.5).*

---

## 8. Addendum — the document layer (`ca341d7`)

Written after §§0–7. Everything above describes the app at `4ae7cfd`: a single
capture-recognize-edit flow. This section records what `ca341d7` added and, more
usefully, what it deliberately left alone.

**Scale:** 14 new modules, ~4,500 lines, taking `js/` from 24 modules / 5,709
lines to 38 / 11,469. Two new CI gates, taking the suite from 10 to 12.

### 8.1 What was added

| Area | Modules | What it does |
|---|---|---|
| Persistence | `store.js`, `documents.js` | IndexedDB; documents, pages, blobs, folders, settings, history |
| Library | `library.js`, `views.js`, `app.js` | Five views, routing, search, folders, tags, trash |
| Notes | `notesEditor.js` | Rich text, checklists, attachments, autosave, paste sanitization |
| Scanning | `scanFilters.js`, `edgeDetect.js`, `scanDoc.js`, `cropView.js`, `annotate.js` | Six filters, edge detection, multi-page, crop, signatures |
| Export | `pdf.js` | Hand-written PDF writer with an invisible OCR text layer |
| Translation | `langDetect.js`, `translateHistory.js` | Script/language detection, local history |

### 8.2 What did NOT change, and why that was the constraint

**The scan flow is untouched.** Its element ids are the app's de-facto public
interface — ten CI gates drive it through them, and `js/dom.js` resolves them
once at module load. So the original markup moved inside a view wrapper
element-for-element, and `js/views.js` keeps **every view's markup in the
document at all times**, hidden with a class rather than created on demand.

The evidence that this held: all 68 ids `dom.js` resolves still exist (checked
programmatically, not by eye), every pre-existing gate passes, and the benchmark
reports **+0.00pts CER and WER** — the recognition pipeline was not touched at
all.

> **Update, 2026-09-13.** 68 was correct at `ca341d7` and is no longer the
> current number: `8d37a35` added `clean-up-text-btn` and `view-on-photo-btn`,
> `e181738` added `coherence-gate-hint`, and **`js/dom.js` now resolves 71**.
> The drift is the point of the correction. The number was quoted in this
> section, in `HANDOFF.md` §0 and in the interaction spec, and *the contract it
> describes was enforced by nothing* — `getElementById` returns `null` rather
> than throwing, so a renamed id imports cleanly and only breaks whichever gate
> happens to touch that control. "Checked programmatically" above was a one-off
> check at one commit, not a gate. [`test/dom-contract.js`](test/dom-contract.js)
> is now CI's first step: it asserts every id `dom.js` resolves exists in
> `index.html`, that none is declared or resolved twice, and it pins the count,
> so the next change to the contract is a deliberate edit rather than a number
> three documents quietly disagree with.

> **Update, 2026-09-15.** The number moved again, past 72 this time (this
> section's own last update stopped at 71; `a511ac0`, W12's footer-version
> id, took it to 72 after that). The UI redesign (UI-REDESIGN-PLAN.md
> §2.1-§2.5) removed `download-image-btn`, `clean-up-text-btn`,
> `view-on-photo-btn`, `select-multi-btn` and `editor-mode-btn` outright
> (merged into other controls or converted to gestures) and added
> `paste-btn`, `download-menu`, `download-menu-backdrop` and `move-handle`.
> Net -1, landing back on 71 - the same digit as an earlier commit, by
> coincidence of arithmetic, not because nothing changed since then.
> **`js/dom.js` now resolves 71 ids.** `EXPECTED_ID_COUNT` in
> `test/dom-contract.js` was updated in the same commit as the markup, per
> that file's own header, and `node test/dom-contract.js` confirms the count
> and that no removed id is still referenced anywhere it would matter.
>
> **Update, 2026-09-17.** The F4 interaction-model rewrite (text
> select/edit/drag, copy/paste, chrome reorganization, drag-and-drop into
> folders, the liquid-glass token migration) moved ids in Phases 2 and 3
> only. Phase 2: `copy-btn`/`paste-btn` deleted outright (Ctrl/Cmd+C/V and a
> touch long-press menu trigger copy/paste now), `text-clipboard-menu`/
> `text-clipboard-menu-backdrop` added for that menu. Phase 3:
> `new-text-btn` deleted outright (with the `addTextMode` state/plumbing
> that existed only to serve it), `filter-toggle-row` added so the filter
> set can be hidden and made `inert` as one unit outside Text mode; separately,
> `add-to-doc-btn` and `save-note-btn` were deleted outright too (both
> actions now live only inside `#download-menu`, addressed by
> `data-menu-action` rather than an id each) - these two were never part of
> `js/dom.js`'s resolved set, so removing them didn't move the number below,
> only `index.html`'s total. Net effect: **`js/dom.js` still resolves 71
> ids** (−3, +3). `index.html`'s total declared id count moved **163 → 161**.
> `EXPECTED_ID_COUNT` needed no edit, since the number it pins didn't change -
> confirmed by `node test/dom-contract.js`, not assumed from the arithmetic
> above balancing out. Phases 1, 4 and 5 touched no ids at all.

Two tests needed one line each: `render-fidelity.js` and `web-tier-smoke.js`
drive the editor directly rather than through `loadFile`, so they now switch to
the scan view first. Without it the editor's container is `display: none` and
every measured rect is zero. That is a real consequence of the change, recorded
rather than papered over.

### 8.3 Four bugs found while building, three of them in the new code

1. **`stripMarkup` concatenated across block boundaries.** `textContent` renders
   `<li>Oat milk</li><li>Bread</li>` as `"Oat milkBread"`. It corrupted the
   search index, card excerpts, word counts and derived titles simultaneously,
   and was invisible until you read one. Now inserts a separator at every block
   element before extracting.
2. **`views.js` hid the entire page.** It set `data-view` on `<body>`, and the
   "hide every view except the current one" selector then matched the body
   itself. The body attribute is now `data-active-view` and the selector is
   scoped to `#app-main` — two independent fixes, because one would have been
   enough and the class of bug is worth belt and braces.
3. **Edge detection accepted pure noise.** A flood fill percolates through a
   noisy image and touches all four edges; the extreme-point fit then returns a
   quad covering 99% of the frame, which passes every area and aspect check
   while being meaningless. Fixed with a **solidity** requirement — how much of
   its own quad the mask actually fills — rather than by tightening the area
   bound, which would have been a threshold papering over a missing test.
4. **Page thumbnails used `background-size: cover`**, cropping portrait pages to
   a middle slice. Page 3 of a three-page agreement rendered blank because its
   middle band was empty. Caught by looking at a screenshot, which is the only
   way this class of bug is ever caught.

A fifth was found in the *test* rather than the code: the soft-B&W assertion
compared mean luma, and a hard and a soft image shared a mean while their
histograms were 2 values and 182. It now counts distinct values.

### 8.3.1 Four more, all in one flow, 2026-09-19 (`ba6e733`)

Reported as "the Add as document page flow is broken through normal use". All
four were reproduced in a real browser with the console open before anything
was edited, which is the only reason two of the diagnoses below are the
opposite of the ones everyone (including the report) started with.

1. **Cancel was not reachable from where the flow landed — and the cause was
   routing, not layout.** `js/app.js` entered the crop screen only inside
   `if (detected)`, and `detectDocument` returns **null on 8 of the 11
   photographs in `test/images`** (measured across four scales, null at every
   one). On that majority path the page was committed on a single tap and the
   person was deposited in the document view, which carries no Cancel at all.
   The crop screen is now shown unconditionally, at a cost of one extra
   "Apply" tap on a photo whose edges cannot be found.
2. **Cancel committed the page anyway**, by design: `js/cropView.js` handed
   back `undefined` and `js/app.js` mapped that to "commit uncropped", under a
   comment arguing that "the photo is already taken". That conflates the photo
   being taken with the person having asked for it to become a page; only the
   second is what the screen asks about. Compounding it, the document was
   created *before* the crop screen was shown, so opening the flow — not
   completing it — is what created it. Creation now happens inside `commit()`.
3. **Every button on the resulting page threw**, and the cause was neither of
   the two things a missing-element bug usually is. See below.
4. **"Auto enhance" was the default**, from `js/documents.js`'s
   `createDocumentRecord`. `js/scanDoc.js`'s `|| FILTERS.AUTO` — the codebase's
   only `FILTERS.AUTO` fallback, and the obvious suspect — is **unreachable**
   for any document created through the model, because that field is always
   set. Both now say `original`. "Selecting Original throws a *separate*
   error" turned out to be bug 3 again, one stack frame shorter
   (`applyFilter` → `cloneCanvas` directly rather than via `applyAuto`).

**The two hypotheses that were wrong, and why they were worth writing down.**

- *Proposed:* Cancel is unreachable because `#crop-view`'s Cancel sits in a
  different `<section data-view>` from the preview screen carrying
  `#scan-target-note`. *Actual:* that separation is real and is not the
  mechanism — on an image where detection succeeds, the crop section IS shown
  and its Cancel IS on screen. What stranded people was the `if (detected)`
  branch never showing that section in the first place. A structural fact about
  the markup looked like an explanation because it was true; it explained
  nothing.
- *Proposed:* the throwing buttons are a `js/dom.js` id-resolution failure
  (lookups before the elements exist, `getElementById` returning `null` rather
  than throwing) or an id collision with the main editor. *Actual:* neither.
  `js/scanDoc.js`'s `rebuildPage` did `if (warped) canvas = warped;` where
  `warpPerspective` returns `{ canvas, unwarpPoint }`. Both hypotheses were
  plausible precisely because this repo has been bitten by id drift before —
  it is why `test/dom-contract.js` exists — and pattern-matching to the last
  bug of a similar shape is exactly what reproducing first is a defence
  against.

**The generalizable lesson: two call sites disagreeing about a return shape.**
`warpPerspective` grew a second return value (`unwarpPoint`, so recognized word
bboxes could be mapped out of rectified space) and became
`{ canvas, unwarpPoint }`. `js/ocrEngine.js` — the caller that wanted the new
half — was written against the new shape and has always been correct.
`js/scanDoc.js`, added later by the document layer, was written against the
shape the *name* implies. Nothing detected the disagreement:

- It is not a type error JavaScript can raise. A plain object is a perfectly
  good value to assign; it only fails when something tries to **draw** it,
  which happened three calls later in a different module. The stack pointed at
  `cloneCanvas` in `js/scanFilters.js` — two files away from the mistake.
- It fires only when `nextCorners` is set and is not the full frame, i.e. only
  for a page that has actually been cropped. Nothing else in CI produced one,
  so every existing scan-document gate ran the untaken branch.
- `js/perspective.js`'s own header documents the `{ canvas, unwarpPoint }`
  contract accurately. The documentation was right and was not read; a comment
  cannot fail, which is the same argument `test/dom-contract.js`,
  `test/motion-contract.js` and `test/repo-contract.js` were each written to
  settle for a different contract.

The honest generalization is not "check return shapes". It is that **a
function with more than one caller and a compound return value has a contract,
and this repo's practice is that contracts get gated rather than described.**
There is no gate for this one, and adding a unit test asserting
`warpPerspective` returns an object with a `canvas` property would be a gate
against the thing that was already right. What actually caught it — and what
would catch the next instance in any module — was driving the real UI until
something threw.

### 8.3.2 The gate that reported six clean passes on six broken buttons

Worth its own heading because the lesson is suite-wide rather than about this
flow. `test/document-creation.js` was extended to click every control on the
page the flow produces. Written with `page.on("pageerror")` — which is what
every browser gate in this repo installs — it went **green against the build
where all six filter chips, both rotate buttons and "Apply filter to all"
raised a TypeError**.

The reason is `js/scanDoc.js`'s `withBusy`, which is good code doing its job:
it catches what the work throws, logs it through `console.error` and shows the
message in a `window.alert`. So the error is *handled*, and a handled error is
not a `pageerror`. Playwright reported nothing because nothing uncaught
happened.

`js/` has eleven `console.error` sites, six of them inside a `catch`. Any gate
watching only `pageerror` is blind to all six. The listener is one line:

```js
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
```

It now lives in `test/browser.js` and attaches to every page created through
`launchBrowser`, so a gate written next month inherits it without knowing it
exists. Anything left unclaimed when the process exits fails the run, which
means a new gate inherits the *failure* and not merely the listener. A gate
that drives an error path deliberately declares it with `expectConsoleErrors`,
per pattern and with a stated reason, rather than switching the check off.

### 8.3.3 What the console capture found on its first run — including a live data-destruction bug

Landing it turned six gates red at once. Four were the capture working as
designed and are now declared: `malformed-input.js` (the app catching and
logging four unreadable files is that gate's pass condition), `heic-input.js`
(no HEIC codec on CI is its premise), `web-tier-smoke.js` (the mocked API
answers 401/429/503 on purpose) and `library-documents.js` (`sanitizeHtml`
parsing hostile pasted markup into an inert `<template>`, where the CSP
correctly refuses a `style` attribute that was about to be stripped anyway).

**The other two are a real defect, left open deliberately so it can be triaged
rather than folded into an unrelated commit.**

`redaction-destroys-original.js` and `pii-redaction.js` report, 18 and 5 times
respectively:

> Applying inline style violates the following Content Security Policy
> directive `style-src 'self'` … Note that hashes do not apply to event
> handlers, **style attributes** and javascript: navigations unless the
> `'unsafe-hashes'` keyword is present. **The action has been blocked.**

`js/scanDoc.js`'s `renderDraftBoxes` builds each redaction draft box as an
`innerHTML` string carrying a `style` attribute:

```js
`<span class="redact-box" style="left:${b.x * 100}%;top:${b.y * 100}%;` +
`width:${b.width * 100}%;height:${b.height * 100}%"></span>`
```

`style-src 'self'` blocks style *attributes*, and `.redact-box` carries only
`position: absolute` in `style.css` — every dimension comes from the blocked
attribute. Measured on a real page, after a real drag:

| | |
|---|---|
| `style` attribute in the DOM | `left:11.1%;top:8.3%;width:44.4%;height:16.7%` |
| computed `left`/`top`/`width`/`height` | `0px` / `0px` / `0px` / `0px` |
| rendered rect | `0 × 0` |
| what the panel says | **"1 box drawn"**, Undo enabled |

So **you drag to redact and see nothing**, while the app reports the box was
recorded — and it *was*. Applying it then burns a box the person never saw,
destroying the page's unredacted original, which is the one irreversible
operation in the document layer. An invisible preview in front of a
destructive, unrecoverable action is the worst possible place for this bug.

Why nothing caught it before: `redaction-destroys-original.js` asserts against
`STORES.BLOBS` and the burned pixels, and `pii-redaction.js` against OCR
coordinates. Both are right to — and neither ever asked whether the box was
on screen. The CSP is enforced by the `<meta>` tag in `index.html`, so this is
live on GitHub Pages and inside the iOS WKWebView, not a test artifact.

**The PII picker shared it, and that was checked rather than assumed.**
`redactSelectedPii` is not a second rendering path: it hands its boxes to
`setRedactMode`, which assigns them to `draftBoxes` and calls the same
`renderDraftBoxes`. Confirmed in a browser — one detected candidate, one box,
`0 × 0` before the fix and `100 × 10` after. So the one-tap "Redact selected"
flow was also offering destruction over an invisible preview.

**Fixed the same day, in its own commit.** `renderDraftBoxes` now creates each
element and sets `.style.left`/`.top`/`.width`/`.height` through CSSOM, exactly
as `positionRedactOverlay` fifteen lines above always did — which is why the
overlay landed correctly while its contents did not. A CSSOM property
assignment is not inline CSS and CSP never blocks it. `grep -rn 'style="'
js/*.js` now returns nothing, and it was one site: every other dynamic style in
the codebase already went through CSSOM.

**The assertion that was missing is the real content of that commit.** Both
gates were right about what they covered and neither had ever asked whether
the box was on screen. `test/redaction-destroys-original.js` now asserts, after
a real drag, that the draft box has non-zero computed width and height *and
that its rect corresponds to where the drag happened* — position as well as
size, because a box rendering at the wrong end of the page would redact content
nobody selected and is indistinguishable from this bug if only dimensions are
checked. Against the parent commit those fail with
`width: 0, height: 0, computedWidth: "0px"` at `x: 362, y: 146` while the drag
was `259 × 69` at `x: 394, y: 327`.

**One defensive change came with it.** Apply was enabled by
`draftBoxes.length` alone, so the UI would offer an irreversible action over a
preview that was not rendering — which is exactly what it did for a release.
`renderDraftBoxes` now measures the box it just created and refuses to enable
Apply if it came back `0 × 0`, saying why in the count line instead of leaving
a dead button. It measures only when a drag is *not* in progress, so the reflow
costs one layout per completed box rather than one per `pointermove` sample.
The guard is gated by its own assertion — the test collapses `.redact-box`
through an inserted stylesheet rule and confirms Apply goes disabled — because
the specific cause is fixed but the class of failure, a box in `draftBoxes`
that is not on the screen, is what must never again reach that button.

### 8.4 The PDF writer, and why it is hand-written

`pdf-lib` and `jsPDF` are 300–400 KB minified. This app has no bundler, so a
library would be vendored into every page load and into the App Store binary —
to do a job scoped to exactly one shape: one JPEG per page, plus optional
invisible text.

Two things make that worth the ~450 lines. A JPEG is embedded with `/DCTDecode`,
meaning the compressed bytes *are* the stream — no decode, no re-compress, so
export is lossless and near-instant. And text rendering mode 3 (`3 Tr`) draws
nothing while still participating in extraction and search, which is exactly how
commercial scanners produce "searchable PDF".

A hand-written PDF writer is also precisely the kind of code that fails silently
— a wrong xref offset produces a file that saves without complaint and then will
not open. So `test/pdf-export.js` validates on three independent levels:
structurally (re-parsing the file and checking every xref offset lands on its own
object header), semantically (the embedded JPEG must come back byte-identical),
and **through CoreGraphics** via `qlmanage` on macOS — a genuinely independent
parser that would catch a spec violation the first two share a blind spot with.

### 8.5 Security surface

Two new untrusted-input paths, both covered by tests:

- **Note paste.** Arbitrary HTML from any origin. `sanitizeHtml` allow-lists tags
  and per-tag attributes and unwraps everything else, keeping the text. Covered
  against `<script>`, event handlers, `javascript:` URLs, inline styles and
  `<iframe>`.
- **Library card rendering.** Document titles and scanned text are interpolated
  into markup. Everything goes through `escapeHtml`, and search-match
  highlighting splits on the match and escapes each part rather than injecting
  `<mark>` by string replacement — which would let a document containing
  `<script` through.

**No CSP change was needed.** IndexedDB is not subject to CSP, and the PDF writer
is hand-written precisely so no external script has to be allowed in.

### 8.6 What this does not fix

The four blockers in §7 are unchanged: the device pass, the benchmark corpus,
the custom domain and the app icon. Nothing here touched recognition accuracy —
the benchmark is identical — and nothing here can be verified on a phone. The
new surfaces are *larger* than the old ones, so the device pass matters more
than it did, not less; `docs/DEVICE-VERIFICATION-CHECKLIST.md` does not yet cover
them.
