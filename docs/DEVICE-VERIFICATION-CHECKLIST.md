# Device Verification Checklist

Source: `TEXTSCANNER-HARDENING-PLAN.md`, Phase 8. Physical hardware only — nothing here can be verified in CI or a Simulator.

**This pass confirms; it does not discover.** Every check below names the automated gate that already asserts it, and all of those gates pass ([CI on `main`](https://github.com/PrashaantM/TextScanner/actions)). So a failure here is a **contradiction**, not an open question — it means the gate is wrong, and §8.5 at the bottom says what to do about that.

If this pass is finding new problems rather than confirming known-good behaviour, Part I was left incomplete. Go back rather than patching forward.

**Fill this in as you go.** Every item ends as checked, failed-with-an-issue, or explicitly `unverified — <reason>`. An unchecked box at the end is not a pass.

---

## 1. Network capture — USB, not a Wi-Fi proxy

> **Do not use the mitmproxy Wi-Fi-proxy method.** An earlier revision of this document did, and it will not work here: `ubcsecure` is a locked-down 802.1x enterprise network. It will not carry a manually configured proxy, and iOS will not let you enable full trust for a user-installed CA under that network policy.

Capture at the TLS handshake level over USB instead. No proxy, no CA install, works on any network — because **ClientHello carries the destination hostname in the SNI extension in plaintext**, and host confirmation is all this phase needs. Nothing is decrypted.

- [ ] iPhone connected by USB, paired and trusted in Xcode
- [ ] UDID copied from Xcode → Window → Devices and Simulators
- [ ] `rvictl -s <UDID>` — creates a virtual interface `rvi0` mirroring device traffic
- [ ] `brew install --cask wireshark`
- [ ] Wireshark capturing on `rvi0`, display filter `tls.handshake.type == 1`
- [ ] Capture left running for the whole of §3

**Fallback if `rvictl` fails to attach** (happens on some Xcode/macOS combinations): System Settings → General → Sharing → Internet Sharing, join the phone to *that* network, then the mitmproxy-with-CA-trust method works — because the network is yours.

- [ ] Method actually used: `rvictl + Wireshark` / `Internet Sharing + mitmproxy` *(circle one — §4 depends on which)*

---

## 2. Install

- [ ] Xcode → select the registered physical device → Product → Archive
- [ ] Organizer → Distribute App → **Development** → install directly

Not TestFlight — it adds review latency this pass does not need.

> Archive here will surface any signing gap. **Archive → Validate App** is a separate, still-outstanding item (`docs/APP-STORE-SUBMISSION.md` §8) and needs a Distribution certificate, not a Development one.

---

## 3. The walk

### 3.1 Touch

*Confirms `test/touch-interactions.js`, which drives real touch via CDP — a synthetic touch context, never a thumb.*

- [ ] Drag a word with a real finger
- [ ] Resize a word with a real finger
- [ ] Marquee ("Select multiple") selection with a real finger
- [ ] In Move mode, two-finger pinch-zoom works and does **not** conflict with single-finger drag *(confirms the `931ddc6` pinch fix)*

### 3.2 Positioning — the important one

*Confirms Phase 1: `test/unit/mlkit-geometry.test.js` (15 assertions) and the 232-word fixture replay in `test/render-fidelity.js`.*

**This is where a contradiction would matter most.** Phase 1 concluded the bug was axis-aligned envelope inflation on **tilted** text — 1.00× at 0°, 2.12× at 15°, 3.18× at 40°. So:

- Flat-on shots should have looked fine before and must still look fine.
- **Angled shots are the ones that were "gibberish" and must now be correct.** Include plenty.
- Portrait shots carry EXIF orientation and exercise `encodeUprightJpeg`.

Scan 15–20 real photos across lighting, angle and density. For each, confirm word positions match the source.

| # | Description (lighting / angle / density) | Tilted? | Positions match? | Notes |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |
| 11 | | | | |
| 12 | | | | |
| 13 | | | | |
| 14 | | | | |
| 15 | | | | |
| 16 | | | | |
| 17 | | | | |
| 18 | | | | |
| 19 | | | | |
| 20 | | | | |

> **If a portrait photo still misplaces words**, the EXIF hypothesis Phase 1 ruled out was not fully ruled out for real camera input, and `encodeUprightJpeg` is the first thing to inspect. **If an angled photo still misplaces words**, the fixtures missed a case — capture the photo and add it to `test/images/` before fixing anything.
>
> There is no debug dump to collect. `js/mlkitDebug.js` and `test/replay-dump.js` were deleted once this bug closed, because a device dump has no ground truth and that ambiguity is what kept the bug open across two analyses. A real photo that fails becomes a **fixture**, not a dump.

### 3.3 HEIC — the device half of a two-part case

*Confirms the device half of `test/heic-input.js`.*

The CI half asserts HEIC fails **safely** where there is no codec: a categorized message, no uncaught error, no hang, and specifically not a silent success. Measured 2026-09-09 in headless Chromium: `categorized-error`, *"That image couldn't be opened. It may be corrupted, or in a format this browser doesn't support."*

**WKWebView has the codec, so here the expectation inverts: anything other than clean success is a real failure.**

- [ ] Take a photo on the device (iOS produces `.heic` by default) and scan it directly, without converting
- [ ] Also scan a HEIC shot in **portrait** — the one real-world input that exercises both `encodeUprightJpeg` and the native decoder at once

> If you see that same "couldn't be opened" message on device, HEIC decoding is broken in WKWebView, and `test/heic-input.js`'s premise check (`canDecodeHeic`) is what to re-run against the device's own engine.

### 3.4 Coherence Filter and translate

*Confirms `test/web-tier-smoke.js`, which mocks `api.anthropic.com` — never calls it for real.*

- [ ] Coherence Filter, on-device tier: indicator reads "On-device" and the rewrite completes
- [ ] Same, with **Airplane Mode on**
- [ ] Translate in place, on-device tier, **Airplane Mode on**
- [ ] Airplane Mode **off**, switch to the Claude tier: the call succeeds **and** a ClientHello with SNI `api.anthropic.com` appears in the capture *(this is the check that confirms the CI mock matches reality)*

> If this device is not Apple Intelligence-eligible, mark the on-device rows **`unverified — device not Apple Intelligence-eligible`**. That is a documented gap, not a failure, and it is already named in the plan's residual-risk list.

### 3.5 Motion

*Confirms §3.7 of `ANALYSIS.md` — the single `prefers-reduced-motion` block, and the audit that found 3 of 6 transitions were **not** on the tokens until this pass fixed them.*

- [ ] Drag, resize, mode switching and view/filter toggling feel continuous — not snapped, not laggy
- [ ] Settings → Accessibility → Motion → **Reduce Motion ON**, then confirm transitions are actually disabled

> The second row is the one that would have failed before this pass. Button presses and the drop zone still animated under Reduce Motion because their durations were hardcoded rather than tokenized. All six now reference `--motion-*`.

### 3.6 Haptics

*Confirms `js/haptics.js` is correctly gated — it is a silent no-op on web, so it has never actually fired anywhere.*

- [ ] Selection
- [ ] Gesture completion (end of a drag or resize)
- [ ] Filter toggle
- [ ] Delete
- [ ] Scan completion

> Six call sites: `editorInteractions.js` (selection, gesture completion) and `main.js` (filter toggle, delete, scan completion). LIGHT for selection and adjustment, MEDIUM for committed actions.

### 3.7 Diagnostic export

*Confirms Phase 15's privacy constraint — `buildDiagnosticReport(includeImage)`, `js/diagnostics.js:41`.*

- [ ] Footer → Diagnostics → "Export diagnostic report" with the image checkbox **unchecked**: the native share sheet opens with a **JSON file attached**, not just a link
- [ ] The report contains device model and OS version (native-only fields, unverifiable off-device)
- [ ] Re-run with "include the image" **checked**: the JSON now has an `image` field
- [ ] **Confirm it is absent when unchecked** — this is the privacy constraint, not a nice-to-have

### 3.8 Keyboard avoidance

- [ ] Tap a contenteditable word near the bottom of the screen: it scrolls into view smoothly rather than abruptly

### 3.9 Library and documents

*Confirms `test/library-documents.js`, which covers the model against real IndexedDB in a desktop browser. What it cannot cover is iOS's own storage policy and WKWebView's own input behaviour, which is what this section is for.*

- [ ] Create a note. Type into it, leave the view, come back: the text is still there
- [ ] Tap a checklist item: it ticks, and stays ticked after closing and reopening the note
- [ ] **Paste formatted text from Safari or Mail into a note.** It should keep the words and lose the decoration, with no stray colours or fonts. This is the app's only untrusted-HTML surface
- [ ] Insert a photo into a note from the library; confirm it survives a reopen
- [ ] Search for a word that appears **only inside a scanned page**, not in any title. It should find the document and show the matching passage
- [ ] Delete a document, confirm it appears in Recently Deleted, restore it, confirm it comes back
- [ ] **Force-quit the app and relaunch.** Everything should still be there — this is the check that catches a storage layer that only appears to work

> **Storage eviction is the risk this section exists for.** iOS can evict a web
> app's storage under pressure, and the app asks for persistence at startup
> (`requestPersistence`) but the OS may refuse. Settings shows what is granted.
> If documents vanish after a period of not using the app, that is what happened,
> and it is worth recording rather than treating as a bug in the code.

### 3.10 Multi-page scanning

*Confirms the scan-document half of `test/library-documents.js` and `test/pdf-export.js`.*

- [ ] Scan a real multi-page document — take three photos of three pages into one document
- [ ] **Auto edge detection on a real page on a real desk.** Does it find the page? If it declines, that is a valid outcome (it prefers no crop to a wrong one) — note which it did
- [ ] **Crop handles with a real thumb.** Can you place a corner precisely? Does the magnifier help, or does your finger cover it anyway? This is the single most touch-sensitive thing in the app and has never been used with a finger
- [ ] Try each of the six filters on a real photographed page. Does Auto enhance actually look better than Original? Does Magic colour overdo it?
- [ ] Reorder pages by dragging. Then reorder with the keyboard if an external one is available
- [ ] Rotate a page; confirm the thumbnail and preview both update
- [ ] **Export a searchable PDF and open it in Files.** Confirm it opens, looks like a scan, and that selecting text over the page actually selects the recognized words
- [ ] Export images; confirm all pages arrive rather than only the first (browsers throttle rapid downloads — the app spaces them, and this is where that is proven)
- [ ] Sign a page with the pen tool using a finger. Does the stroke smoothing feel right?
- [ ] **Redact something, export, and reopen the export.** Confirm the redacted content is genuinely gone from the exported file, not just covered

---

## 4. Export and record

- [ ] Stop the capture
- [ ] Export as `test/artifacts/device-network-capture-<date>.pcapng`

**On committing it:** an SNI-only `.pcapng` contains no keys and no payloads, so it is safe to commit as-is. If the Internet Sharing fallback produced a full `.mitm` capture instead, strip `Authorization` / `x-api-key` header values before committing, or commit only a host-list summary.

- [ ] `test/artifacts/*` is gitignored, **or** the file has been confirmed safe by the rule above

- [ ] Add a **"Verified on device (`<date>`)"** section to `docs/PRIVACY-DECISIONS.md` listing the observed hosts

> This is the point of the whole capture. `docs/PRIVACY-DECISIONS.md`'s claim about native network activity is currently verified **statically** — by dependency-tree analysis — and is the one privacy claim in this project not confirmed empirically. Expected hosts: `api.anthropic.com` only when the Claude tier is used, plus whatever ML Kit's telemetry contacts (Google endpoints; see `ANALYSIS.md` §4.5, which quantifies what Google's own manifests declare). **Anything else in that list is a finding.**

---

## 5. Handling contradictions (§8.5)

Any check that fails against a green gate:

1. **File it.**
2. **Fix it.**
3. **Fix or add the automated gate that missed it** — this is the step that is easy to skip and the reason the pass exists.
4. **Re-run the affected check.**

Do not proceed to Phase 9 with an unexplained contradiction.

---

## 6. Sign-off

- [ ] Every item above is checked, failed-with-a-filed-issue, or marked `unverified — <reason>`
- [ ] Storage persistence: granted / refused (circle one) — see §3.9
- [ ] The capture exists at the path in §4
- [ ] `docs/PRIVACY-DECISIONS.md` has its verified-on-device section
- [ ] Every contradiction is resolved **with a corresponding gate fix**
- [ ] `ANALYSIS.md` §6 ("Device verification — pending Phase 8") is replaced with the real results, and §0's status table updated

Date of pass: `____________`  ·  Device / iOS version: `____________`  ·  Apple Intelligence eligible: `Y / N`
