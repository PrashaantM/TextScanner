# Device Verification Checklist

Source: `TEXTSCANNER-HARDENING-PLAN.md`, Phase 8. This is a physical-hardware pass — nothing here can be verified in CI or a simulator. Walk through it on a real iPhone with a real finger, with the mitmproxy capture running for the whole session.

## Setup (once per pass)

- [ ] mitmproxy installed on laptop (`brew install mitmproxy`), `mitmweb` running
- [ ] iPhone Wi-Fi proxy pointed at laptop's local IP:8080
- [ ] mitmproxy CA certificate installed via `mitm.it` in Safari
- [ ] Certificate trusted in Settings > General > VPN & Device Management
- [ ] Full trust enabled in Settings > General > About > Certificate Trust Settings
- [ ] App archived in Xcode (Product > Archive) and installed to a registered physical device via Organizer > Distribute App > Development (not TestFlight)

## Interaction checks

- [ ] Drag a word with a real finger — works
- [ ] Resize a word with a real finger — works
- [ ] Marquee ("Select multiple") selection with a real finger — works
- [ ] In Move mode, two-finger pinch-zoom works and doesn't conflict with single-finger drag

## Coherence Filter / translate checks

- [ ] Coherence Filter on-device tier: tier indicator reads "On-device", rewrite completes (Apple Intelligence enabled device)
- [ ] Coherence Filter on-device tier still works with Airplane Mode on
- [ ] Translate-in-place, on-device tier, works with Airplane Mode on
- [ ] Airplane Mode off, Coherence Filter tier toggled to Claude: call succeeds and appears in the mitmproxy capture as a request to `api.anthropic.com`

## Scan quality (15-20 real photos, range of lighting/angle/text density)

For each photo scanned, note pass/fail on whether the recognized result visually matches the source image's word positions:

| # | Description (lighting/angle/density) | Positions match source? | Notes |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |
| 11 | | | |
| 12 | | | |
| 13 | | | |
| 14 | | | |
| 15 | | | |
| 16 | | | |
| 17 | | | |
| 18 | | | |
| 19 | | | |
| 20 | | | |

## Artifact capture

- [ ] mitmweb capture stopped and exported (`.mitm` format)
- [ ] Capture saved as `test/artifacts/device-network-capture-<date>.mitm`, with `Authorization`/`x-api-key` header values stripped before committing (or not committed raw at all — host list summarized into `docs/PRIVACY-DECISIONS.md` instead)
- [ ] `test/artifacts/*.mitm` covered by `.gitignore`
The ML Kit debug dump steps that used to sit here are **gone, deliberately**.
`js/mlkitDebug.js` and `test/replay-dump.js` were deleted once the positioning
bug was closed offline against synthetic fixtures with exact ground truth
(`test/make-mlkit-fixture.js`, `test/unit/mlkit-geometry.test.js`, and the
fixture replay in `test/render-fidelity.js`). There is no debug flag to arm and
no dump to export. Positioning is confirmed by eye against the checklist item
above, and any disagreement with it is a contradiction to investigate per the
plan's §8.5 — not a new diagnosis to start from scratch.

## Motion/interaction feel (Phase 17)

- [ ] Drag, resize, mode switching, and view/filter toggling feel continuous, not snapped or laggy, on a real device

## Diagnostic export (Phase 15)

- [ ] Open Diagnostics in the footer, tap "Export diagnostic report" (image checkbox unchecked): the native share sheet opens with a JSON file attached, not just a link
- [ ] Report content includes device model and OS version (native-only fields, can't be verified off-device)
- [ ] Re-run with "include the image" checked: the shared JSON now has an `image` field; confirm it's absent when unchecked

## Format checks (Phase 12)

- [ ] Take a real photo on the device (produces a `.heic` file by default on iOS) and scan it directly, without converting it first. Confirm it decodes and recognizes normally.
  - Headless Chromium (the browser CI runs against) does not support HEIC decoding, so this cannot be verified in CI — it can only be confirmed here, on-device. If it fails, capture the exact `describeScanError()` message shown and note it below rather than leaving this unchecked.
  - **This is the device half of a two-part case.** The CI half is `test/heic-input.js`, which asserts that where the codec is *missing* the app fails safely: a categorized message, no uncaught error, no hang, and specifically **not** a silent success that would scan an undecoded image and report that it worked. Measured 2026-09-09 in headless Chromium: `categorized-error`, *"That image couldn't be opened. It may be corrupted, or in a format this browser doesn't support."*
  - So the contradiction to watch for here is the opposite one: this device **has** the codec, so anything other than a clean success is a real failure. If you see that same "couldn't be opened" message on device, HEIC decoding is broken in WKWebView and `test/heic-input.js`'s premise check (`canDecodeHeic`) is the thing to re-run against the device's own engine.
  - [ ] Also scan a HEIC shot in **portrait**, so this covers an EXIF-orientation-carrying HEIC rather than only the format. That combination is the one real-world input that exercises both `encodeUprightJpeg` and the native decoder at once.
