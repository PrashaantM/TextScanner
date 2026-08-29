# Privacy decisions

What leaves the device, what doesn't, and the decisions behind the difference.
Written to be checkable rather than reassuring: every claim below says how it was
established, and where verification stopped.

## The claim that is true, and the one that isn't

**True: your image is never uploaded.** Recognition happens on the device -
Tesseract.js in the browser, Google's ML Kit in the iOS app - and the picture
itself is never transmitted by this app, in any build, under any setting. That
is the claim the UI, the README and the iOS permission strings make.

**Not true: "the app makes no network requests."** It used to be close enough to
say, and it isn't any more, so the copy no longer says it. Three things can put
traffic on the wire:

| What | When | Contains |
|---|---|---|
| Coherence Filter via Claude | Only if the user saves an Anthropic API key and presses Generate | The extracted text |
| Translation via Claude | Only if the user saves a key and presses Translate | The extracted text, line by line |
| ML Kit usage logging | Automatically, on the iOS build | Device ID and diagnostic data — **not** image content |

The first two are opt-in, disclosed in the panel every time it is open, and are
requests to a service the user holds the account for. On an Apple Intelligence
eligible iPhone both run on-device instead and make no request at all.

The third is the one that needed a decision.

## Decision: ML Kit usage logging stays on, and is disclosed

`MLKitCommon` links `GoogleDataTransport`, which batches and uploads usage and
diagnostic data to Google. This is not speculation about what the SDK might do -
its own privacy manifest, shipped inside
`MLKitCommon.framework/PrivacyInfo.xcprivacy`, declares it:

```
NSPrivacyCollectedDataTypeDeviceID          purposes: Analytics, AppFunctionality
NSPrivacyCollectedDataTypeOtherDataTypes    purposes: Analytics, AppFunctionality
NSPrivacyCollectedDataTypeOtherDiagnosticData
```
all with `Linked: false` and `Tracking: false`.

**It is left enabled, because there is no way to turn it off that this project
can honestly claim to have applied.** The documented opt-out,
`FirebaseDataCollectionDefaultEnabled`, belongs to Firebase — and this app does
not use Firebase (confirmed: `Podfile.lock` contains no Firebase pod). The
standalone ML Kit SDK exposes no equivalent Info.plist key; searching the
shipped `MLKitCommon` binary for one turns up only proto field names, not a
setting the app can write.

Shipping a plist key that looks like an opt-out but isn't wired to anything
would be worse than not having one: it would let the app claim something
untrue. So the decision is the other option the review offered — leave it on,
and make the copy precise about what it means.

That is already done, in three places: the footer says "recognition runs on your
device" and "your images are never uploaded anywhere" rather than the old
"runs entirely client-side with Tesseract.js" (which was simply false in the iOS
app) and "never leave your browser"; the README separates "your image is never
uploaded" from "the app makes no network requests" explicitly; and the app-level
`PrivacyInfo.xcprivacy` declares no collection for the app's own code while
leaving MLKitCommon's manifest to declare its own, which is how Apple aggregates
them.

**If this should change:** the honest route is to stop linking ML Kit and use
Apple's Vision framework for recognition instead, which HANDOFF already lists as
a candidate. That removes the telemetry by removing the dependency, rather than
by claiming a switch that doesn't exist.

## Network verification: what was actually checked

**Web layer: verified empirically, zero external requests.** A full scan is run
under request logging (see `vendor/tesseract/README.md`); before Phase 1 it hit
four jsDelivr URLs, and after vendoring Tesseract.js it hits none. The
Content-Security-Policy in `index.html` enforces this rather than trusting it:
`connect-src` allows only `'self'`, `blob:` and `api.anthropic.com`, so any
other destination is blocked by the browser, in the iOS WKWebView as much as on
the web.

**Native layer: verified statically, not by packet capture.** No device was
available for a traffic capture, and this says so rather than implying more
than was done. What was established from the dependency tree: no Firebase; the
only network-capable code linked is `GoogleDataTransport` (via `MLKitCommon`)
with `GTMSessionFetcher` and `GoogleUtilities` beneath it; and no app code opens
a connection outside the CSP-constrained WKWebView. So the traffic the native
build can produce is ML Kit's logging above, plus whatever the user's own opt-in
Claude request makes.

**Remaining check for a real device:** run the app under Charles or a Network
Link Conditioner profile and confirm the only endpoints seen at launch and
during a scan are Google's logging endpoints. That is the one step this
verification is missing.

## App Transport Security

No ATS exceptions. Default HTTPS enforcement is intact — checked, not assumed:
`Info.plist` contains no `NSAppTransportSecurity` key at all.

## Permission strings, re-verified

Both are still accurate after every UI change in this work:

- `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` each say the
  photo "is processed entirely on your device and is never uploaded or shared."

Still true. Translation and the Coherence Filter send extracted **text**, never
the photo, and only when the user opts in. The strings are about the photo
specifically, which is what the permission actually governs.

## Binary contents

Four of ML Kit's five text-recognition script models — Chinese, Devanagari,
Japanese, Korean — are no longer compiled in. `js/mlkitEngine.js` requests
`script: "LATIN"` and nothing else, so they were unreachable by any code path.
See `scripts/trim-mlkit-scripts.js` for how, and why it has to patch two files
together. Measured on a clean build: the app bundle went from 56 MB to 49 MB and
now contains only `LatinOCRResources.bundle`.

This is a size fix, not a policy about languages. Non-Latin recognition is a
real gap; shipping four models the app cannot reach did not make it any smaller
a gap.

## The diagnostic dump

`js/mlkitDebug.js` records every scan's full recognized text and writes it to the
app's Documents directory — which is included in unencrypted backups and
retrievable through Xcode's Download Container. It is **off by default and inert
until explicitly armed** (a URL parameter or a localStorage flag set from the Web
Inspector), creating no window stash and writing no file otherwise. Deleting it
outright is still the plan; it survives only because the positioning bug it was
built to diagnose is still open. See its header, and HANDOFF's Next action.
