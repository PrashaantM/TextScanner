# TextScanner handoff — 2026-09-09

Supersedes the 2026-08-29 handoff, which was deleted in `2fac2c5` and is
recoverable at `git show 7ff391e:HANDOFF.md`. That document described the state
after the completion plan; this one describes the state after the **hardening
plan's Parts I and II**.

**Start here:** Section 5 is the only remaining work, and almost all of it needs
you rather than a machine — a phone, a domain registrar, an Apple Developer
account, and a camera. Sections 2–4 are done, committed, pushed, and green in CI.

**The current analysis is [`ANALYSIS.md`](ANALYSIS.md)** (third revision,
`4ae7cfd`). Both prior revisions are preserved under `docs/archive/`.

## 1. What this is now

Unchanged in shape: a local-first OCR and image-text editor shipping as a static
site (GitHub Pages) and an iOS app (Capacitor) from one codebase. Recognition is
Tesseract.js on the web and Google ML Kit on iOS, dispatched by
`js/recognize.js`. The Coherence Filter and translate-in-place use Apple's
on-device Foundation Models on eligible iPhones and fall back to Claude with a
user-supplied API key everywhere else.

Nothing about the app requires a network connection to recognize text, on either
build.

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
- **CI: 6 test gates → 10.** Unit tests 45 → 60.
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

- **`script: "LATIN"`** — now *asserted* rather than merely known, with measured
  CER per script and a tripwire that fires if it ever starts working.
- **ML Kit telemetry** — now precisely quantified from Google's own manifests
  (six data types, unlinked, non-tracking). Only the Vision migration removes it.
- **Nothing verifies the generated trees are current.** A stale `www/` or
  `ios/App/App/public/` breaks a native build while the source tree looks clean.
  This pass caught one by grep after deleting `mlkitDebug.js`; nothing would have
  caught it automatically. A cheap gate, not yet built.
- No font-weight detection (measured, doesn't work). Non-Latin translation output
  can't be re-scanned on native. The web build needs a BYOK Claude key for both
  Coherence Filter and translation.

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
