# TextScanner handoff — 2026-09-09

Supersedes the 2026-08-29 handoff, which was deleted in `2fac2c5` and is
recoverable at `git show 7ff391e:HANDOFF.md`. That document described the state
after the completion plan; this one describes the state after the **hardening
plan's Parts I–III**, plus the **document layer** added afterwards in `ca341d7`.

> **Read §0 first if you are picking this up cold.** The app changed shape after
> the hardening plan closed: it is no longer a single scan flow.

**Start here:** Section 5 is the only remaining work, and almost all of it needs
you rather than a machine — a phone, a domain registrar, an Apple Developer
account, and a camera. Sections 2–4 are done, committed, pushed, and green in CI.

**The current analysis is [`ANALYSIS.md`](ANALYSIS.md)** (third revision,
`4ae7cfd`). Both prior revisions are preserved under `docs/archive/`.

## 0. The app changed shape (`ca341d7`)

It was one flow: pick an image, scan it, edit the result. It is now **five views
over a real document model** — and the original flow is one of them, preserved
element for element.

| | |
|---|---|
| **Library** | Documents, folders, tags, pinning, full-text search across scanned pages, Recently Deleted |
| **Notes** | Rich text, checklists, inline images, autosave |
| **Scans** | Multi-page documents, edge detection, six filters, rotation, reordering, searchable-PDF export |
| **Crop** | Four-corner adjustment with a magnifier |
| **Settings** | Storage usage, translation history, diagnostics, delete-everything |

14 new modules, ~4,500 lines. `js/` went from 24 modules / 5,709 lines to 38 /
11,469. Storage is IndexedDB, device-local, no sync, no account.

> **Every count in this file is deliberately historical, and this file is not a
> gating candidate.** The numbers above record the `ca341d7` transition; the
> annotations below record later dates. The live counts live in
> `WEB-COMPLETION-PLAN.md` §0, where `test/repo-contract.js` (CHECK 1) gates
> them. Adding `HANDOFF.md` to that gate's `GATED_DOCS` would force these
> numbers to be rewritten as today's and destroy the record they exist to keep —
> so it has been considered and rejected, rather than being an ungated
> remainder anyone still needs to close. This file annotates; it does not
> overwrite.

**The constraint that shaped all of it:** the scan flow's element ids are the
app's de-facto public interface — ten CI gates drive it through them. So its
markup moved inside a view wrapper unchanged, and `js/views.js` keeps every
view's markup in the document permanently, hidden with a class. All 68 ids
`js/dom.js` resolves still exist, every pre-existing gate passes, and the
benchmark is **+0.00pts** — recognition was not touched.

> **Updated 2026-09-13: the count is now 71, and it is finally gated.** 68 was
> right at `ca341d7`; `8d37a35` and `e181738` added three more ids without any
> document noticing. `test/dom-contract.js` runs first in CI and pins the
> number, so the contract can no longer drift away from the prose describing it.
> See `ANALYSIS.md` §8.2 and `WEB-COMPLETION-PLAN.md` §W3.
>
> **Updated 2026-09-15: 71 again, but not the same 71.** It moved to 72
> (`a511ac0`, W12) and back down: the UI redesign (UI-REDESIGN-PLAN.md
> §2.1-§2.5) removed five ids (merged controls, gestured-away mode toggles)
> and added four (`paste-btn`, `download-menu`, `download-menu-backdrop`,
> `move-handle`). `EXPECTED_ID_COUNT` in `test/dom-contract.js` moved with it,
> in the same commit, per this section's own standing rule.
>
> **Updated 2026-09-17: still 71, for the third time by coincidence, not by
> nothing changing.** The F4 interaction-model rewrite (five phases: text
> select/edit/drag, copy/paste, chrome reorganization, drag-and-drop into
> folders, the liquid-glass token migration) touched ids only in Phases 2-3.
> Phase 2 deleted `copy-btn`/`paste-btn` outright (Ctrl/Cmd+C/V and a touch
> long-press menu trigger copy/paste now, not buttons) and added
> `text-clipboard-menu`/`text-clipboard-menu-backdrop` for that touch menu.
> Phase 3 deleted `new-text-btn` outright (along with the `addTextMode`
> plumbing only it drove) and added `filter-toggle-row` (Text-mode-only
> visibility needed one id to hide/inert as a unit) - and separately deleted
> `add-to-doc-btn` and `save-note-btn`, which were never part of this
> contract but were real controls in `index.html` (both actions live only
> inside `#download-menu` now). Net effect on `js/dom.js`'s resolved count:
> −3, +3, unchanged at 71. `index.html`'s total id count did move, 163 → 161,
> from the two non-contract deletions - see `WEB-COMPLETION-PLAN.md`'s own id
> table for the full per-phase breakdown. Phases 1, 4 and 5 added or removed
> no ids at all.

`ANALYSIS.md` §8 is the addendum covering this, including the four bugs found
while building it. `js/app.js` is the shell; `js/main.js` still owns the scan
flow and reaches the document model only through `bridge`.

## 1. What this is

A local-first document scanner, notes app and image-text editor, shipping as a
static site (GitHub Pages) and an iOS app (Capacitor) from one codebase.
Recognition is Tesseract.js on the web and Google ML Kit on iOS, dispatched by
`js/recognize.js`. The Coherence Filter and translate-in-place use Apple's
on-device Foundation Models on eligible iPhones and fall back to Claude with a
user-supplied API key everywhere else.

Nothing about the app requires a network connection to recognize text, on either
build, and nothing is uploaded anywhere.

## 2. The oldest bug in the project is closed

**The ML Kit positioning bug — "gibberish" word placement on some images — is
fixed, and it never needed a device.**

Both prior analyses concluded it required "exactly one instrumented device run."
That was the wrong plan, for a reason worth internalising: **a device dump has no
ground truth.** You can replay it and look, but "does this look right?" is
exactly the ambiguity that kept the bug open across two analyses.

The root cause is **axis-aligned envelope inflation**, and it is arithmetic. For
a word of true size `w × h` tilted `t°`, the axis-aligned box around it is
`h·cos(t) + w·sin(t)` tall. `flattenBlocks` threw away ML Kit's `cornerPoints`,
so the renderer sized and positioned every word from that envelope:

| Tilt | Font-size inflation | What was reported |
|---|---|---|
| 0° | **1.00×** | "really good" |
| 15° | **2.12×** | "gibberish" |
| 40° | **3.18×** | "gibberish" |

Long words inflate worst and overlap their neighbours. It matches the reported
symptom exactly.

**It was not EXIF orientation** — that hypothesis is disproved, because none of
the 11 corpus images carries an orientation tag at all.

The fix threads `cornerPoints` through as a quad and derives each word's true
origin, glyph height and tilt. `bbox` keeps its old envelope semantics so every
other consumer is untouched, and the Tesseract path — which has no corner points
— renders exactly as before. **Benchmark delta: +0.00pts CER and WER.**

`js/mlkitDebug.js` and `test/replay-dump.js` are **deleted**. A consequence worth
knowing: there is now no code path, armed or otherwise, that persists recognized
text anywhere.

## 3. What Parts I and II did

Two commits, one per part, plus one for a CI fix that could not wait.

| Phase | Outcome |
|---|---|
| 1. Positioning bug | Root-caused, fixed, gated. Fixtures with exact ground truth replaced the device-dump workflow |
| 2. Benchmark corpus | **Partial.** Noise floor measured; non-Latin asserted as a limitation. Expansion **blocked** — see §5 |
| 3. Coverage audit | Found a real motion bug and a decorative CI step. New gates for HEIC, both Claude tiers, TTS, export |
| 4. Vision scope | `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md`, verified against the iOS 26.5 SDK headers. Recommendation: **wait** |
| 5. Custom domain | **Blocked.** Prepared in `docs/CUSTOM-DOMAIN-MIGRATION.md` |
| 6. App Store prep | `docs/APP-STORE-SUBMISSION.md`. Three real blockers, all needing you |
| 7. `ANALYSIS.md` | Third revision, with §6 explicitly marked pending the device pass |

### Numbers worth carrying forward

- **Benchmark baseline is unchanged: 68.3% CER / 112.0% WER** over the 11-image
  corpus (`test/baseline-2026-08-28.json`), re-verified at +0.00pts after the
  positioning fix.
- **The number that actually matters is still 45.1% CER / 57.1% WER**, over the
  eight images with *complete* ground truth. complexPic7, 10 and 11 have
  deliberately partial transcriptions, so an engine that reads more real text
  scores worse on them. **Do not optimize against the 11-image number.**
- **CI: 6 test gates → 12** at `ca341d7`. Unit tests 45 → 60. The two newest
  gates (`test/pdf-export.js`, `test/library-documents.js`) covered the document
  layer. **It is 18 as of 2026-09-13**: `8d37a35` and `e181738` added
  `test/document-creation.js` and `test/interaction-layer.js`; the two contract
  gates (`test/dom-contract.js`, `test/motion-contract.js`) run first, before any
  browser is installed, because neither needs one; and
  `test/destructive-actions.js` and `test/radial-call-sites.js` cover the
  dialog-gated paths and the three radial call sites. A **second CI job** runs 14
  of those on WebKit and Firefox nightly rather than per-push - see
  `WEB-COMPLETION-PLAN.md` §W2 for why that split, and for the four bugs it found
  (X1 HEIC, X3 stale reduced-motion, X4 edge detection on noise, plus X2 resolved
  as a Playwright build limitation).
- **Run-to-run noise: the two recorded measurements disagree** — see §5.2. Use
  0.6 WER points as the merge bar until it is settled.
- Native build: `** BUILD SUCCEEDED **`, exit 0, zero errors (Xcode 26.6).

### The most important negative results

**Three, and all of them are load-bearing:**

1. **EXIF orientation was not the positioning bug.** Ruling it out is what
   forced the analysis onto the actual cause.
2. **The threshold sweep was deliberately not run.** Re-tuning against the same
   11 images that produced the current thresholds would be circular. Rejecting
   the work is the finding; `test/TUNING-2.md` §3 has the reasoning.
3. **Two documentation claims were wrong and are corrected in `ANALYSIS.md`** —
   the prior revision's "no `innerHTML` anywhere in `js/`" (false when written),
   and the privacy manifest's understatement of ML Kit's declared collection
   (six categories described as two).

> **Updated 2026-09-17: one of these negative results was overturned, and how it
> was overturned is the transferable part.** "Font-weight detection: measured,
> doesn't work" was carried here and in `js/editorObjects.js` for three
> revisions. The measurement behind it was real — ink fraction cannot separate
> weight 500 from weight 700, because ink coverage is dominated by the typeface
> and by which letters a word contains. What did not follow is *therefore it is
> impossible*: both confounds are properties of comparing a word against an
> **absolute** number. `js/fontMatch.js` compares it against a rendering of the
> **same string** in each candidate face, which cancels both exactly, and
> recovers weight on **99.0%** of a synthetic corpus where the same stroke
> measurement thresholded absolutely manages 84.1%. The lesson is not "try
> harder"; it is that a negative result about one *signal* was written down as a
> negative result about the *problem*, and nothing re-read it for three
> revisions.

## 4. Two things the audit caught that nothing else would have

**The CI gate was not gating.** Phase 3 step 2 required proving the workflow
fails on a real regression. It does ([run 34396467400](https://github.com/PrashaantM/TextScanner/actions/runs/34396467400)
red, [run 34396624486](https://github.com/PrashaantM/TextScanner/actions/runs/34396624486)
green after revert) — but doing it exposed a pre-existing bug: the workflow
installed browsers through the **`playwright`** package while the tests resolve
through **`playwright-core`**. Two independently-pinned browser revisions. They
agreed until an upstream release, then all 9 browser gates failed at launch.
Fixed by installing through the same package the tests use.

**`prefers-reduced-motion` did not reduce motion.** A comment in `style.css`
asserted that every transition used the `--motion-*` tokens so the single
reduced-motion block would zero them all. **3 of 6 did not.** Anyone who had
asked their OS to reduce motion still got animation on every button press. All
six are tokenized now, and the invariant is greppable rather than asserted in
prose:

```
grep -E '^\s*(transition|animation):' style.css | grep -v 'var(--motion-'
```

## 5. What's left

### 5.0 The device checklist does not yet cover the document layer

`docs/DEVICE-VERIFICATION-CHECKLIST.md` was written against the scan flow. The
library, notes editor, multi-page scanning, crop handles and PDF export are all
new surfaces with new device-specific risk — touch targets on the crop handles,
IndexedDB quota under iOS's eviction policy, the share sheet for a PDF, and
whether WKWebView's `contenteditable` behaves for the note editor. **Add those
sections before the device pass**, or the pass will confirm the old app and miss
the new one.

### 5.1 The device pass (Phase 8) — the main one

`docs/DEVICE-VERIFICATION-CHECKLIST.md` is rewritten and ready to walk. **Every
item now names the automated gate it confirms**, so this pass confirms rather
than discovers, and any failure is a contradiction to investigate.

One correction from the old checklist matters: **do not use the mitmproxy
Wi-Fi-proxy method.** `ubcsecure` is 802.1x and will not carry a manual proxy or
let you fully trust a user CA. Use `rvictl -s <UDID>` + Wireshark on `rvi0`,
filtering `tls.handshake.type == 1` — SNI is plaintext in the ClientHello, so
host confirmation needs no decryption and no CA install.

The check to weight most heavily: **angled photos.** Those are the ones that were
gibberish, and the fix is specifically about tilt.

### 5.2 The benchmark corpus — the honest blocker

**Needs 14 photographs only you can take**: low light, steep skew (>15°), dense
small text, a receipt, a street sign, a photo of a screen, and non-Latin script —
two each, shot on the phone you will use for the device pass.

These cannot be generated. A synthesized image has no sensor noise, motion blur,
rolling-shutter skew or lens geometry, so a generated corpus would measure the
generator rather than the pipeline. Transcribe each **completely**, including
fine print — three of the original 11 did not, which is exactly why the 11-image
average is misleading.

Until they exist, the threshold sweep stays unrun and the noise floor stays
unsettled: this pass measured **0.00pts** across two bit-identical runs, while
the 2026-08-29 handoff recorded **±0.3 WER** from the same experiment. That
disagreement is unresolved (`test/TUNING-2.md` §1).

### 5.3 The custom domain (Phase 5)

Blocked on a registrar login. `docs/CUSTOM-DOMAIN-MIGRATION.md` has everything
else ready — DNS records, the `CNAME` file, the exact replacement copy, and a
re-entry notice for keys that will not survive the origin change.

**Do not apply the copy changes early.** The current caveat — that any other site
on the shared `github.io` origin can read the key back — is true right now.
Changing it before the app moves would tell users their key is safer than it is.

Already verified: **no hardcoded `github.io` URL exists anywhere**, so no code
change is needed for the app to work on a new domain.

### 5.4 App Store submission (Phases 6 and 9)

Three real blockers, in `docs/APP-STORE-SUBMISSION.md` §8:

1. **The app icon is the unmodified Capacitor template logo** — a blue "⨉" on a
   grid. It will be rejected under Guideline 4.0. This is brand identity, so it
   is your call, not mine; the technical requirement is one 1024×1024 PNG with
   no alpha at
   `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
2. **Support and marketing URLs** wait on §5.3.
3. **Archive → Validate App** needs a Distribution certificate.

Screenshots follow the icon. Metadata and the full privacy nutrition label are
drafted and ready to paste.

### 5.5 Known limitations, carried forward deliberately

- **Do not bump tesseract.js to 6.x without checking the coverage-rescue
  trigger.** v6 restructured `blocks` to report only text-based blocks, and
  `js/ocrEngine.js`'s rescue pass fires on *zero-word* blocks — so the bump can
  silently disable a pass measured at **+3.6 CER points**, the largest accuracy
  effect in this pipeline's history. v6's changes are performance and memory
  only; none is an accuracy improvement. Full reasoning and the check to run:
  [`vendor/tesseract/README.md`](vendor/tesseract/README.md) §"Before you bump
  the version", [`RECOGNITION-SPIKE.md`](RECOGNITION-SPIKE.md) §4.3/§5.
- **`oem 3` (LSTM + legacy) is unmeasured, not rejected.** Only LSTM cores and
  LSTM traineddata are vendored, so the comparison cannot run offline. Expected
  impact is low; that is an expectation, not a measurement.
- **Recognition accuracy is exhausted locally — configuration *and* engines.**
  Seventeen categorical engine/preprocessing variants were swept over the full
  corpus and none helps without also hurting (`RECOGNITION-SPIKE.md` §3). ~~The
  open local option is a PaddleOCR-via-ONNX bake-off; the cloud-tier decision
  should wait for it.~~ **That bake-off has been run (2026-09-19/20) and the
  candidate was rejected twice over** — it reads this corpus better (36.4% vs
  41.6% macro CER, 6 of 8 images) and **cannot place a word** (10 boxes for 30
  words; a line detector has no word boxes to expose, and the in-place editor
  is built on them), while **detection alone costs 2.30× the entire Tesseract
  pipeline**, 87% of it the ONNX runtime rather than the model. Full result and
  both harnesses:
  [`test/research/paddle-bakeoff/paddleocr-bakeoff.md`](test/research/paddle-bakeoff/paddleocr-bakeoff.md).
  No third local candidate is identified. The cloud-tier decision is no longer
  waiting on a pending measurement — it now has the result, in both directions,
  set out in `RECOGNITION-SPIKE.md` §6 — and remains open. **The 14 photographs
  in §5.2 are the only live next step.**
- **`script: "LATIN"`** — now *asserted* rather than merely known, with measured
  CER per script and a tripwire that fires if it ever starts working.
- **ML Kit telemetry** — now precisely quantified from Google's own manifests
  (six data types, unlinked, non-tracking). Only the Vision migration removes it.
- **Nothing verifies the generated trees are current.** A stale `www/` or
  `ios/App/App/public/` breaks a native build while the source tree looks clean.
  This pass caught one by grep after deleting `mlkitDebug.js`; nothing would have
  caught it automatically. A cheap gate, not yet built.
- Non-Latin translation output can't be re-scanned on native. The web build
  needs a BYOK Claude key for both Coherence Filter and translation.
- **Font matching does not identify the typeface**, and cannot. `js/fontMatch.js`
  recovers a word's weight, slant, serif-ness, monospace-ness and width class and
  picks the closest face from four system stacks; a photo set in Futura comes back
  as the system sans at the right weight, not as Futura. Two axes are deliberately
  low-recall (monospace 37.5%, italic 66.3%) because their false positives are
  glaring and land on every word of an image at once — see that file's header.
  A photograph taken at an angle shears its text, and sheared upright type is
  pixel-for-pixel a slanted typeface; nothing recoverable from a word-sized crop
  separates the two.

## 6. Where things live

| | |
|---|---|
| Current analysis | `ANALYSIS.md` (third revision) |
| Prior analyses | `docs/archive/analysis-2026-08-29.md`, `analysis-2026-08-28.md` |
| The plan being executed | `TEXTSCANNER-HARDENING-PLAN.md` |
| Device pass | `docs/DEVICE-VERIFICATION-CHECKLIST.md` |
| Domain migration | `docs/CUSTOM-DOMAIN-MIGRATION.md` |
| Submission | `docs/APP-STORE-SUBMISSION.md` |
| Vision migration | `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` |
| Privacy decisions | `docs/PRIVACY-DECISIONS.md` |
| Tuning history | `test/TUNING.md`, `test/TUNING-2.md` |
