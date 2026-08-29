# TextScanner handoff — 2026-08-29

Supersedes the 2026-08-27 handoff entirely. That document described the state
before the completion plan was executed; this one describes where things
actually stand.

**Start here:** Sections 5 and 6 are the only open work. Everything in Sections
2–4 is done, committed, and verified.

## 1. What this is now

A local-first OCR and image-text editor, shipping as a static site (GitHub Pages)
and an iOS app (Capacitor) from one codebase. Recognition is Tesseract.js on the
web and Google ML Kit on iOS, dispatched by `js/recognize.js`. Two further
features — the Coherence Filter and translate-in-place — use Apple's on-device
Foundation Models on eligible iPhones, and fall back to Claude with a
user-supplied API key everywhere else.

Nothing about the app requires a network connection to recognize text, on either
build.

## 2. The completion plan is done (phases 0–7)

Executed in order, one commit per phase, each verified before the next started.
`TEXTSCANNER-COMPLETION-PLAN.md` has the original brief; the commit messages
have the detail, including the things that didn't work.

| Phase | Outcome |
|---|---|
| 0. Safety net | Benchmark harness runs from a fresh clone; 45 unit tests; baseline recorded |
| 1. Security | Tesseract vendored, CSP added and verified live, privacy copy corrected |
| 2. Coherence without a key | Foundation Models plugin; on-device is the default on eligible devices |
| 3. OCR accuracy | Decode cap, honest native confidence — and a measured **null result** on tuning |
| 4a. Touch | The editor now works by touch at all; regression test added |
| 4b. Colour matching | Ink colour sampled from the image; error 204 → ~30 |
| 4c. Translate in place | The differentiating feature, reusing the object model wholesale |
| 5. Structure | `editor.js` split into three; O(1) lookups; drag and batch-delete unblocked |
| 6. Accessibility | Full keyboard path, real ARIA, manual theme, categorized errors |
| 7. App Store readiness | Privacy manifest, telemetry decision documented, 4 unused models removed |

### Numbers worth carrying forward

- **Benchmark baseline: 68.3% CER / 112.0% WER** over the 11-image corpus
  (`test/baseline-2026-08-28.json`). Re-verified unchanged after every later
  phase.
- **The number that actually matters is 45.1% CER / 57.1% WER**, over the eight
  images with *complete* ground truth. complexPic7, 10 and 11 have deliberately
  partial transcriptions, so an engine that reads more real text scores worse on
  them, and at ~130% CER they dominate the 11-image average. Do not optimize
  against the 11-image number.
- **Run-to-run noise is about ±0.3 WER.** Established by running the identical
  code twice. Any smaller delta means nothing.
- iOS app bundle: 56 MB → 49 MB after dropping unused ML Kit models.

### The most important negative result

**Pipeline tuning changed nothing, and that was the correct outcome.** Two full
sweeps over every threshold the plan named (`test/tune-thresholds.js`, and
`test/TUNING.md` for the write-up) found:

- four thresholds that produce byte-identical output at any value — they don't
  bind on this corpus at all;
- one variant that reproduced across both sweeps and was still rejected, because
  the entire effect was **one image** out of eight;
- one clearly harmful variant, which usefully confirms an existing threshold is
  doing real work.

Nothing cleared the noise floor. Before spending time here again, read
`test/TUNING.md` — it exists so these experiments aren't repeated.

## 3. Architecture, as it stands

```
js/recognize.js        engine dispatch (Tesseract / ML Kit)
js/coherence.js        tier dispatch  (Foundation Models / Claude BYOK)
js/translate.js        tier dispatch  (Foundation Models / Claude BYOK)
```

Three modules, one shape. The caller states intent; the dispatcher picks an
implementation; nobody upstream knows which ran. This is the pattern to follow
for anything else that has an on-device and a hosted option.

The editor is three files (`editorObjects` / `editorInteractions` /
`editorExport`), with a strictly one-way dependency graph and a single
registered hook going the other way. Hook registration is the architecture here
— `editorObjects.js` doesn't know what inpainting is, what the filter levels
mean, or how a deleted word gets recreated.

The native plugin `ios/App/App/TextCoherencePlugin.swift` serves both the
Coherence Filter and translation. `MainViewController.swift` exists only to
register it — Capacitor auto-registers from a generated list that `cap sync`
rebuilds, so an app-target plugin can never appear in it.

## 4. Testing

```
cd test && npm install && npm run install-browser   # once per clone
node test/run-benchmark.js --json out.json          # CER/WER over the corpus
cd test && npm test                                 # 45 unit tests
node test/touch-interactions.js                     # real touch, via CDP
node test/render-fidelity.js                        # geometry + colour fidelity
node test/tune-thresholds.js                        # threshold sweep
```

`test/touch-interactions.js` deliberately does **not** use Playwright's mouse
API. That emits pointer events with `pointerType: "mouse"` and would have passed
against the code that made the iOS app's flagship feature do nothing.

## 5. Open work

1. **A device run.** Nothing here has been on a physical iPhone. Specifically
   worth checking by hand: pinch-zoom versus single-finger drag in Move mode
   (`touch-action: pinch-zoom` is the intended compromise, verified only in a
   synthetic touch context); the Foundation Models path on an Apple
   Intelligence-eligible device (the Swift compiles and the availability logic
   is unit-verified against a simulated bridge, but the model has never actually
   run); and a packet capture to close out the one network claim that is
   verified statically rather than empirically (see `docs/PRIVACY-DECISIONS.md`).

2. **The ML Kit positioning bug is still open**, and is now the oldest
   outstanding item. `js/mlkitDebug.js` is built, gated off by default, and
   waiting for one instrumented device run; `test/replay-dump.js` replays the
   dump offline. Nothing about the diagnosis has changed — the renderer is
   exonerated, rotation and a fixed coordinate transform are both ruled out, and
   the remaining question is whether ML Kit's boxes are misplaced or merely
   flooded with fine print. **Delete `js/mlkitDebug.js`, its import, and
   `test/replay-dump.js` once it's understood.**

3. **The benchmark corpus needs real photographs.** This is the hard limit on
   recognition work: eight scoring images cannot resolve a one-point difference.
   `test/images/README.md` lists the missing categories (low light, steep skew,
   dense small text, a receipt, a street sign, a moiré case, non-Latin script),
   the ground-truth conventions, and the drop-in steps.

## 6. Known limitations, deliberately

None of these are oversights; each was decided and is documented where it lives.

- **Moving a word still doesn't clean up its vacated spot.** Delete inpaints
  correctly; move does not. Longest-standing gap in the editor.
- **No bold/regular detection.** Measured and rejected — ink coverage doesn't
  separate weight, and inverts by typeface. See the Phase 4b commit.
- **Latin script only on iOS.** Translating *into* a non-Latin script renders
  and exports correctly but can't be re-scanned on the native build. The app
  says so at the moment it becomes true.
- **ML Kit sends usage telemetry**, and there is no opt-out this project can
  honestly claim to have applied. Disclosed rather than hidden; see
  `docs/PRIVACY-DECISIONS.md` for the reasoning and the way out.
- **The web build still requires an API key** for both the Coherence Filter and
  translation. There is no on-device model in a browser, and pretending
  otherwise would be dishonest.
- **The API key is readable by any other site on the same `github.io` origin.**
  Disclosed in the panel. A custom domain is the only real fix.
