# TextScanner — what's actually left

**Rewritten 2026-09-11 (twice — see below).** This file started as a nine-
phase completion plan. Five of those phases (1, 3, 4, 7, and half of 2) were
done and verified against the repo, and a same-day UX/redesign/Coherence-
Filter pass (commit `8d37a35`) plus an interaction-layer pass (radial menus,
command palette, global shortcuts — commit `e181738`) landed since. This
revision folds both in and **states only what remains.**

A note on citations below: five planning documents this file used to point
to (`01`-`05`, plus a `07-REMAINING-ROADMAP.md` that briefly replaced them)
have been deleted (commit `0220749`) — everything in them either shipped or
is carried forward here, self-contained, rather than by pointer to a file
that no longer exists. Where a fact used to cite one of those, it now cites
the code directly, or a commit. `06-INTERACTION-MODEL-SPEC.md` is the one
survivor, kept because the interaction-layer code's own comments cite it as
design rationale, not a to-do list.

If you're picking this up cold: `HANDOFF.md` is still the fuller narrative of
how the app got here, and `ANALYSIS.md` is still the cited, evidence-backed
audit of the state through `ca341d7`. This file is the punch list for
everything after that.

---

## Done (verified, not assumed)

| Item | What it closed | Evidence |
|---|---|---|
| Phase 1 — ML Kit positioning bug | Root-caused (axis-aligned envelope inflation on tilted text), fixed, gated. Diagnostic path retired. | `test/unit/mlkit-geometry.test.js`; `js/mlkitDebug.js` and `test/replay-dump.js` no longer exist |
| Phase 3 — Coverage completion audit | Every web-reachable path smoke-tested; the CI regression gate was proven to actually fail and recover, not just assumed to | `test/web-tier-smoke.js`; commit `4ae7cfd`, CI runs [34396467400](https://github.com/PrashaantM/TextScanner/actions/runs/34396467400) (deliberate failure) / [34396624486](https://github.com/PrashaantM/TextScanner/actions/runs/34396624486) (recovery) |
| Phase 4 — Vision framework migration scope | Scope document written; the `cornerPoints` question answered definitively against the SDK headers; migration itself correctly not started | `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` |
| Phase 7 — `ANALYSIS.md` third revision | Written against the web-complete state; both prior revisions archived; §8 addendum added after the document-layer rewrite | `ANALYSIS.md` header, §8 |
| Phase 2, steps 2 & 6 only | Noise floor measured (0.00pts across two bit-identical runs); non-Latin limitation asserted with a tripwire test | `test/TUNING-2.md` §1; `test/non-latin-limitation.js` |
| Eager document creation (2026-09-11) | Tapping "Scan"/"Note" no longer creates a document until real content exists; a startup sweep cleans up what the old bug already left in the library | `js/documents.js`'s `sweepEmptyDocuments`, `js/notesEditor.js`'s `openNoteDraft`; `test/document-creation.js`; commit `8d37a35` |
| Nav redesign (2026-09-11) | Library / + / Settings replaces two permanently-lit "tab" buttons with an action sheet; delete shows an Undo toast; the scan-result screen has guided "Clean up this text" / "View on photo" buttons | `js/app.js`, `js/toast.js`; commit `8d37a35` |
| Coherence Filter fact-check + router (2026-09-11) | A deterministic post-check flags a rewrite that dropped a price/date/time/number; receipt and business-card inputs get a specialized prompt instead of narrated prose | `js/factCheck.js`, `js/coherenceRouter.js`; commit `8d37a35` |
| App icon (2026-09-11) | Stock Capacitor template logo (an automatic Guideline 4.0 rejection) replaced with a real design - a viewfinder frame with a text cursor, in the app's indigo accent | `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`; `docs/APP-STORE-SUBMISSION.md` §1 |
| Coherence Filter skip-the-call gate (2026-09-11) | "Clean up this text" on already-coherent-looking input offers "Reconstruct anyway" instead of silently skipping or silently running - the last unbuilt piece of the original Coherence Filter plan | `js/coherenceGate.js`; commit `e181738` |
| Interaction layer (2026-09-11) | Radial press-drag-release menu (one primitive, three call sites: the "+" create menu, a library card's long-press/swipe, the theme button), a command palette (Cmd/Ctrl+K), and global keyboard shortcuts. Two real bugs found and fixed while integrating the spec rather than pasting it: keyboard Enter/Space on a spoke never actually ran its action, and auto-focusing the first spoke on open also armed it, so any tap-and-release with zero drag fired the first item regardless of where the finger lifted | `js/radialMenu.js`, `js/commandPalette.js`; `test/interaction-layer.js` (24 checks); `06-INTERACTION-MODEL-SPEC.md`; commit `e181738` |

Everything below this line is genuinely open.

---

## 1. Test the 2026-09-11 changes — do this first, no hardware needed

Two rounds landed the same day: the redesign/coherence-filter/icon pass
(`8d37a35`) and the interaction-layer pass (`e181738`). Both are covered by
automated tests (`test/document-creation.js`, `test/interaction-layer.js`,
running in CI), but neither has run outside a headless browser yet. Do this
before picking up the phone for §5 below, so the device pass confirms
known-good behavior rather than finding UI bugs for the first time.

### Web (desktop or phone browser)

Don't open `index.html` directly via `file://` — ES modules get blocked by
Chrome's CORS handling under that protocol. Serve it:

```bash
cd /Users/prashaantmudgala/TextScanner
python3 -m http.server 8080
```

Open `http://localhost:8080` on the Mac. To reach it from a phone on the same
Wi-Fi: `http://<mac-lan-ip>:8080` (`ipconfig getifaddr en0` for the IP) — this
can fail on a locked-down 802.1x network that isolates devices from each
other (the same class of network called out in the device-pass network
capture section below), in which case push to `main` and use the live
`github.io` URL instead.

**Redesign/coherence/icon (`8d37a35`):**

1. Tap **"+ New"** → confirm the action sheet shows "Scan a document" / "New
   note" over a dimmed backdrop, and that Escape or a backdrop click closes it.
2. Choose **New note**, type nothing, tap **Library** → confirm no card was
   created. This is the exact repro of the bug that used to create a permanent
   "Untitled note" on a bare tap.
3. Open **New note** again, type a title → go back to Library → confirm a
   card *does* now appear.
4. Choose **Scan a document**, tap **"Try a sample image"** but not "Scan
   text" → go back to Library → confirm no "Untitled scan" card appeared.
5. Actually scan the sample image → confirm the result screen shows **"Clean
   up this text"** / **"View on photo →"** prominently, with the original
   Raw/Filtered/Text/Image controls still present underneath, just smaller.
   Click each guided button and confirm it drives the right underlying
   filter/mode — **naming the destination, because "the right mode" is what
   made this check pass over a real bug**: "Clean up this text" must select
   the **Coherence Filter** level, and "View on photo →" must land on **Full
   image** (the photo visible, with the "Move components" button present), NOT
   Image format. It called `modeImageBtn.click()` until 2026-09-13, so the
   guided path reached a view with no photo and no way to move anything.
   Gated since by `test/guided-path.js`.
6. Scan an image containing a **receipt-like layout** (dollar amounts, a
   "total" line, several short lines) or a **business-card-like layout** (an
   email address plus a phone number) and run Coherence Filter — confirm the
   output reads as an itemized list / structured contact fields rather than
   narrated prose. (Needs a Claude API key on the web build — BYOK is still
   the only tier there.)
7. Scan something that's already a clean sentence or two and click **"Clean
   up this text"** — confirm it becomes **"Reconstruct anyway"** with a hint,
   rather than immediately running the tier. Click it again and confirm it
   proceeds normally the second time.
8. Delete any document → confirm the "Deleted '…'. Undo" toast appears
   bottom-center and Undo actually restores it.
9. Check the browser tab's favicon matches the new mark.

**Interaction layer (`e181738`):**

10. On a touchscreen (or Chrome DevTools' device toolbar with touch
    simulation on), **press and hold "+ New"**, then drag to "Scan" or "Note"
    and release — confirm a radial menu fans out and the release fires the
    right action. On a real mouse, clicking "+ New" should still show the
    plain list from steps 1-4 above, not the radial menu.
11. Tab to "+ New" and press **Enter** (no drag) — confirm this still opens
    the plain action sheet, not a radial menu.
12. On a library card, **long-press** (touch) — confirm a Pin/Move/Delete
    radial menu appears; try "Move" and confirm a folder picker opens.
    **Swipe a card left** past roughly a third of its width — confirm it
    deletes with the same Undo toast as the hover Delete button. On desktop,
    **right-click a card** — confirm a plain context menu with the same three
    actions.
13. Long-press the **theme button** (bottom-right of the nav bar area) —
    confirm a System/Light/Dark radial picker appears; a plain click should
    still just cycle through the three as before.
14. Press **Cmd/Ctrl+K** — confirm the command palette opens from any view,
    including while typing in a note's title (it should open even there).
    Type a document's title and press Enter — confirm it opens that document.
    Type "shortcuts" and press Enter — confirm the keyboard shortcut sheet
    opens.
15. Outside a text field, press **`?`** — confirm the shortcut sheet opens.
    Inside a text field (e.g., a note's title), type `?` — confirm it types
    the character instead of opening anything.
    **Do this from Settings or an open document, not from the Library.** The
    Library auto-focuses its search input on arrival, so `?` there IS inside a
    text field and correctly types into the search box rather than opening the
    sheet — that is the `inTextField` guard working, not a failure.
    `test/interaction-layer.js` navigates to Settings first for exactly this
    reason. Anyone walking this list literally lands on the Library and would
    otherwise record a false failure.
16. On the scan-result screen, press **`[`** and **`]`** — confirm they step
    Text → Image format → Full image and back.
17. Focus a library card (Tab to it) and press **Delete** — confirm the same
    trash-and-Undo-toast behavior as clicking its Delete button.

### Native iOS (Xcode)

No Android target exists in this project — "on the phone" means the iOS app.

```bash
cd /Users/prashaantmudgala/TextScanner
npm run sync:ios   # copies www/ into the iOS project, runs `cap sync`
open ios/App/App.xcworkspace   # the .xcworkspace, not .xcodeproj
```

Pick a connected iPhone (or an iPhone Simulator for a faster first pass — no
camera, haptics, or HEIC-from-camera there, but fine for layout/nav) as the
run destination, set the Team under Signing & Capabilities the first time,
and Run. First launch on a real device needs the dev profile trusted under
**Settings → General → VPN & Device Management**.

Repeat all 17 checks above on the real touchscreen (this is where the radial
menu, swipe, and long-press checks actually matter — a desktop browser's
touch simulation is a reasonable first pass but not the real gesture), plus
what only a real device can show:

- The footer in Settings should read **"ML Kit,"** not "Tesseract.js."
- On an Apple Intelligence-eligible iPhone on iOS 26+: Coherence Filter should
  offer an **on-device** tier with no API key needed, and the receipt/
  business-card prompt routing should still apply there too (`coherence.js`
  dispatches by tier, not by which prompt runs).
- Haptic taps on the action sheet, nav, delete, and every radial menu's arm
  (light) and fire (medium).
- Safe-area spacing around the notch/Dynamic Island for the app bar, the
  action sheet, the command palette, the shortcut sheet, and the toast.
- A **hardware keyboard** paired to the iPhone (Bluetooth or Smart
  Connector, if available) should drive the command palette and global
  shortcuts identically to a Mac.
- "Note" is now reachable at all on a phone-width screen — it used to be
  hidden below 600px because the old nav bar couldn't fit five controls.
  Confirm it's there (now via the "+ New" action sheet/radial menu).

---

## 2. The benchmark corpus (Phase 2, steps 1/3/4/5) — blocked on you

**Needs 14 photographs only you can take**, two each: low light, steep skew
(>15°), dense small text, a receipt, a street sign, a photo of a screen
(moiré), non-Latin script. Shoot them on the same phone used for the device
pass in §5, so the corpus and the device run share input characteristics.

These can't be generated — a synthesized image has none of the sensor noise,
motion blur, rolling-shutter skew, or lens geometry that make those
categories worth testing, and a generated corpus would measure the generator
rather than the pipeline. Transcribe each **completely**, including legible
fine print — three of the original 11 didn't, which is exactly what made the
11-image average misleading.

Once they exist:

1. Add each image to `test/images/` and its transcript to `test/groundtruth/`,
   following the existing naming convention.
2. Run `test/tune-thresholds.js` against the full ≥25-image corpus. Append the
   results to `test/TUNING-2.md` (it already has the noise-floor and
   non-Latin sections; this fills in what it explicitly left blocked).
3. **Merge rule, unchanged:** merge a threshold change only if the
   improvement exceeds **twice** the measured noise floor (0.00pts, so in
   practice any real, reproducible improvement clears it) *and* reproduces in
   a second independent sweep. Record rejections with their numbers, same as
   round 1.
4. Write a new dated baseline (`test/baseline-<date>.json`) and point
   `ci.yml`'s `--check-regression --baseline` at it — `test/baseline-2026-08-28.json`
   is measured against the 11-image corpus and stops being a valid comparison
   point the moment the corpus grows.

**Done when:** ≥25 images across the listed categories; `test/TUNING-2.md`'s
blocked sections are filled in; CI regression-checks against the new
baseline.

---

## 3. The custom domain — blocked on you

Blocked on a registrar login, nothing else. `docs/CUSTOM-DOMAIN-MIGRATION.md`
already has the DNS records, the `CNAME` file content, the exact replacement
copy for the Coherence Filter panel's shared-origin disclosure, and a
re-entry notice for keys that won't survive the origin change.

1. Acquire or point a domain/subdomain you control at `<owner>.github.io`
   via a CNAME record.
2. Add the `CNAME` file at the repo root.
3. In Settings → Pages, set the custom domain, enable "Enforce HTTPS" once
   the certificate provisions.
4. **Then, and only then**, apply the pre-written copy changes. Applying them
   early would tell users their key is safer than it currently is — the
   shared-`github.io`-origin caveat is true right now and must stay until the
   app actually moves.
5. Verify no hardcoded `github.io` URL remains (`grep -rn "github\.io" js/ index.html`)
   — already checked once and came back clean, worth re-checking after the
   move.

**Done when:** the app is reachable at the custom domain over HTTPS; the
copy is updated (not before); no hardcoded `github.io` URL remains.

---

## 4. App Store launch readiness

### 4.1 The remaining submission blockers

1. **Archive → Validate App** — needs a real Apple Distribution certificate.
   Product → Archive, then Validate App in the Organizer. Needs no physical
   device; catches most rejections before submission.
2. **Support and marketing URLs** — wait on §3 (the domain).
3. **Screenshots** — mechanically unblocked now that a real icon exists
   (6.7": 1290×2796, 6.5": 1242×2688, PNG/JPEG, no alpha, no device frame, via
   `xcrun simctl io <device> screenshot` against a Simulator), but still needs
   you to pick which 5-6 screens tell the product's story — a presentation
   choice, not a mechanical one. Worth including at least one screen showing
   the new "+" action sheet or a radial menu now that they exist.

Metadata, the privacy nutrition label, the privacy manifest, and usage
descriptions are already drafted/verified in `docs/APP-STORE-SUBMISSION.md`
§§2-6 and don't need revisiting unless the description's claims change.

### 4.2 Two open decisions, not blockers

- **Naming.** The strongest researched alternative to "TextScanner" was
  **"Inplace"** — checked against App Store listings, GitHub, and general web
  search (the only real collision found was an unrelated B2B Confluence
  plugin) — after an earlier top pick, "Retext," was dropped for colliding
  with a real, active open-source project (`retext-project/retext`, ~2,000
  GitHub stars). Neither check was a formal trademark clearance. Deliberately
  **not applied**: it touches the bundle's public identity and
  `docs/APP-STORE-SUBMISSION.md`'s already-drafted, submission-ready
  metadata, and — unlike the pricing decision below — was never confirmed
  with you directly. If you want to commit to it, the rollout touches
  `index.html`'s `<title>`/`#app-title`, `capacitor.config.json`'s `appName`,
  `README.md`, and App Store Connect's listing name together, so a mismatch
  across even one doesn't read as a rename in progress, it reads as a bug.
  Get a formal USPTO/trademark check done before spending money on final
  assets either way.
- **Pricing (Option A — confirmed).** One-time Pro unlock, no subscription:
  free tier stays a complete product on its own (unlimited single-document
  scanning, all views, translation/Coherence Filter via your own key, TTS,
  plain-text export); the paid unlock gates unlimited multi-page documents/
  folders (free tier capped, e.g. 3 open documents or 15 pages), searchable
  PDF export, and batch "Recognize all pages." This decision is made, but the
  actual StoreKit implementation is blocked on you creating the in-app
  purchase product in App Store Connect first — there's no product ID to
  wire client code against until that exists, and no way to test the
  integration end-to-end without it.

### 4.3 Explicitly deferred, not blocked — the hosted AI tier

**The problem:** Coherence Filter and translation currently require a BYOK
Anthropic API key on any device without Apple Intelligence eligibility.
Reasonable for a developer, a bad ask for someone who just wants to clean up
a photo of a flyer.

**The fix, if you build it:** a third tier in `js/coherence.js`'s existing
dispatcher (`ON_DEVICE` / `HOSTED` / `CLAUDE` / `NONE`) — a bounded number of
free AI runs per month, included with the one-time Pro purchase above, no key
required, funded by you rather than the user. BYOK stays as an optional
unlimited tier for people who want it; on-device stays free and automatic.
The relay is a small Cloudflare Worker holding your Anthropic key as a
secret, validating the purchase server-side against Apple's App Store Server
API (never trust a client-supplied "I paid" flag), enforcing the monthly
allowance in a KV/D1 record keyed by a hash of the entitlement, then calling
Claude — default to **Sonnet 5**, not the Opus 5 BYOK users get, since this
task doesn't need Opus-level reasoning and it's not your cost to spend
generously on. At current published rates (Sonnet 5, $2 input / $10 output
per million tokens), a single call runs roughly $0.008; a 50-run/month
allowance costs about 50 cents for someone who maxes it every month, against
a $6.99-$9.99 one-time Pro price. Apple's IAP is iOS-only, so this only works
as stated there — leave the web build BYOK-only rather than building a
second payment system speculatively. Update the in-app privacy disclosure
for this tier specifically before it ships (today's copy — "the only thing
that leaves your device" — stops being true for hosted-tier calls, which hit
your relay before Anthropic).

**Not built, on purpose:** it needs a Cloudflare account and Apple Developer
Program Server API access this session doesn't have, and it's sequenced
*after* §4.2's IAP ships and after real usage data exists — building it now
would be unwired scaffolding referencing an entitlement system that doesn't
exist yet. Revisit once §4.2 is live and has a few weeks of data.

---

## 5. The physical device pass — needs hardware

**This pass confirms; it does not discover.** Every check maps to something
already green in CI or verified in §1 above. A failure here contradicts a
passing gate, which means the gate is wrong — fix the gate too, not just the
symptom.

### 5.1 What's new since the checklist was last current

`docs/DEVICE-VERIFICATION-CHECKLIST.md` was written against the original
scan-only flow, before the document layer (`ca341d7`) and before the
2026-09-11 redesign and interaction-layer passes. Add these before walking
it, or the pass confirms an app that no longer exists:

- **Document layer** (per `HANDOFF.md` §5.0): touch targets on the crop
  handles; IndexedDB quota behavior under iOS's storage eviction policy; the
  native share sheet for a PDF export; whether WKWebView's `contenteditable`
  behaves correctly for the note editor (cursor placement, IME, the checklist
  tap target).
- **Nav redesign:** the "+" action sheet opens/closes correctly with a real
  finger tap (not just a mouse click) including on the backdrop; "New note"
  is genuinely reachable now on a phone-width screen.
- **Guided scan-result buttons:** "Clean up this text" / "View on photo"
  respond correctly to a tap and haptic fires; the skip-the-call gate's
  "Reconstruct anyway" relabel behaves the same on-device.
- **Delete/Undo toast:** appears above the home indicator / safe area, Undo
  works within the 5-second window on a real touch target.
- **Coherence Filter routing:** scan an actual receipt and an actual business
  card on-device; confirm the output uses the specialized voice, on whichever
  tier (on-device or Claude) actually runs there.
- **New app icon:** appears correctly on the home screen at every size,
  including in Spotlight search and Settings.
- **Radial menus** (the "+" create menu, a card's long-press, the theme
  button): the press-drag-release gesture reads naturally on a real
  touchscreen — this is the one class of check §1's desktop/simulated-touch
  pass genuinely cannot substitute for. Confirm the viewport-edge flip (open
  one near the top and bottom of the screen) and that Reduce Motion
  (Settings → Accessibility → Motion) removes the bloom animation.
- **Card swipe and long-press:** swipe-to-delete/pin, and that a long-press
  cleanly supersedes an in-progress swipe read rather than fighting it.
- **Command palette and shortcuts** with a hardware keyboard, if you have one
  to pair.

### 5.2 The original checklist, still the main body of the pass

- **Touch:** drag a word, resize a word, marquee-select.
- **Pinch:** enter Move mode, two-finger pinch zoom without conflicting with
  single-finger drag.
- **Positioning — weight this one most:** scan 15-20 real photos across
  lighting, angle, and density, including portrait shots carrying EXIF
  orientation. Angled photos are the ones that were gibberish before Phase 1;
  confirm word positions match the source.
- **HEIC:** scan an unconverted HEIC straight from the camera roll — must
  succeed on device (CI only proves it fails *safely* where the codec is
  missing).
- **Coherence Filter, on-device tier:** tier indicator reads "On-device," the
  rewrite completes, repeat in Airplane Mode. If the device isn't Apple
  Intelligence-eligible, mark "unverified — device not eligible" rather than
  failed.
- **Translate in place**, on-device tier, Airplane Mode on.
- **Claude tier:** Airplane Mode off, confirm success and capture the network
  request (see 5.3).
- **Motion:** interactions feel continuous; enable Settings → Accessibility →
  Reduce Motion and confirm transitions actually stop.
- **Haptics** fire on selection, gesture completion, filter toggle, delete,
  and scan completion.
- **Diagnostic export** opens the native share sheet; confirm the report has
  no image data unless the opt-in box is checked.
- **Keyboard avoidance:** tapping a contenteditable word near the bottom of
  the screen scrolls it into view smoothly.

### 5.3 Network capture — USB, not a Wi-Fi proxy

If the network is 802.1x-locked (won't carry a manual proxy or let you fully
trust a user-installed CA), don't attempt the mitmproxy Wi-Fi method — capture
at the TLS handshake level over USB instead:

1. Connect the iPhone by USB, paired and trusted in Xcode. Get its UDID from
   Window → Devices and Simulators.
2. `rvictl -s <UDID>` creates a virtual interface (`rvi0`) mirroring the
   device's traffic.
3. `brew install --cask wireshark`, capture on `rvi0`, filter
   `tls.handshake.type == 1`. ClientHello messages carry the destination
   hostname in the SNI extension in plaintext — no decryption, no CA trust
   needed, and host confirmation is all this needs.

If `rvictl` fails to attach: share the Mac's connection over Wi-Fi (System
Settings → General → Sharing → Internet Sharing), join the phone to that
network, and use mitmproxy with CA trust there instead — record which method
was used.

Export the capture as `test/artifacts/device-network-capture-<date>.pcapng`
(an SNI-only capture has no keys or payloads, so it's safe to commit as-is).
Update `docs/PRIVACY-DECISIONS.md` with a "Verified on device" section
listing the observed hosts.

### 5.4 Handle contradictions

Anything failing against a green gate: file it, fix it, **and fix the
automated gate that missed it**, then re-run the affected check. Don't move
to §6 with an unexplained contradiction.

**Done when:** every checklist item (original + 5.1's additions) is checked,
failed-and-filed, or marked "unverified" with a stated reason; the capture
exists; `docs/PRIVACY-DECISIONS.md` has its verified-on-device section; every
contradiction resolved with a corresponding gate fix.

---

## 6. Release close-out

1. Fill in `ANALYSIS.md` §6 ("Device verification — pending Phase 8") with
   the actual results: host list, checklist outcome, any contradiction found
   and what it revealed about the gate that missed it. Update §0's status
   table. Add a note on the 2026-09-11 redesign/coherence/icon/interaction-
   layer work if §8's addendum doesn't already cover it by then.
2. Update `HANDOFF.md` to point at the new state, in its existing style.
3. Submit to App Store Connect using §4's assets and the archive validated
   there.
4. Tag the release commit.

**Done when:** `ANALYSIS.md` has real device results; `HANDOFF.md` points at
current state; the build is submitted; the release is tagged.

---

## Known residual risk (carried forward, still honest)

- **Single-device confirmation.** §5 covers one iPhone on one iOS version.
  The Simulator covers layout across sizes; real cross-device confirmation is
  post-release feedback via the diagnostic export.
- **Apple Intelligence tier**, if the test device isn't eligible — the code
  path is smoke-tested and the Claude fallback is tested, but the on-device
  path itself may stay unconfirmed.
- **`script: "LATIN"`** — non-Latin recognition is a known, asserted
  limitation. The Vision migration (scoped, not built) is what would close it.
- **ML Kit telemetry** — precisely quantified, not eliminated. Only dropping
  ML Kit for Vision removes the question.
- **Benchmark corpus scale** — even at ≥25 images post-§2, CER/WER figures
  carry real error bars; the noise-floor discipline is what keeps them
  honest, not the count alone.
- **The Claude API tier depends on a third party** — availability, latency,
  and pricing are outside this project's control, on both the BYOK tier today
  and the hosted tier if §4.3 is ever built.
- **Nothing verifies the generated `www/`/`ios/App/App/public/` trees are in
  sync with source.** Caught once by a manual grep; no automated gate exists
  for it yet.
- **The radial menu primitive is new** (`e181738`) — thoroughly covered for
  the cases `test/interaction-layer.js` can reach with synthetic touch events
  and reduced-motion emulation, but genuinely novel touch physics (how it
  feels, not just whether it fires) is a §5 device-pass question, not
  something CI can settle.

## Non-goals

- No implementation of the Vision framework migration — a scope document
  only, until you decide to act on it.
- No hosted AI tier implementation until §4.2's IAP is live and has usage
  data — see §4.3.
- No app rename until you confirm it — see §4.2.
- No threshold change outside §2's merge rule, however plausible it looks.
- No motion or haptic addition that ignores `prefers-reduced-motion`.
- No radial menu or gesture added anywhere `06-INTERACTION-MODEL-SPEC.md`
  deliberately left alone (the note editor's text area, the image-format
  word editor's own keyboard model) - layering a second interaction system
  onto a surface that already has a good, purpose-built one is a net loss.
- No treating §5 (the device pass) as a discovery phase. If it's finding new
  problems rather than confirming known-good behavior, something above was
  left incomplete — go back rather than patching forward.
