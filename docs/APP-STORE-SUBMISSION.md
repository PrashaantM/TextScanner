# App Store submission preparation

**Phase 6 of `TEXTSCANNER-HARDENING-PLAN.md`.** Everything needed to be
submission-ready *before* the device pass, so Phase 8 is the last gate rather
than the start of a new work item.

**Verified 2026-09-09** against the repo and the installed Pods. Where something
was checked, it says what was checked and what the answer was. Where something
is blocked, it says who has to unblock it — those are marked **BLOCKED** and
listed together in §8 so nothing hides.

---

## 1. Assets

| Asset | Status |
|---|---|
| App icon, 1024×1024 | **Replaced — see below** |
| Launch screen | Present (`Base.lproj/LaunchScreen.storyboard` + `Splash.imageset`, 2732×2732 ×3) |
| 6.7" / 6.5" screenshots | **BLOCKED** — not produced |

### The app icon is no longer the stock Capacitor logo

**Updated 2026-09-11.** `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
was the unmodified Capacitor template icon (a blue "⨉" on a faint grid) — an
automatic rejection under App Review Guideline 4.0 (Design), independent of it
also being the wrong brand on someone else's mark. It has been replaced with a
first real design: a viewfinder frame (the universal "capture a photo" mark,
legible at any size because it's just eight strokes) with a text cursor
centered inside it, in the app's indigo accent — the two-word pitch of the
product ("scan", "edit the text") as one glyph. 1024×1024, RGB with no alpha
channel (verified: PNG color type 2), same file, same modern single-size
`Contents.json` Xcode already derives every other size from — no Xcode project
changes needed beyond what was already in place.

This is a first pass, not a locked decision — brand identity is still your
call, not a technical gap I should decide unilaterally on my own taste alone.
If you want a different direction (a different mark, palette, or a
magnifying-glass-with-a-sharpening-text-line alternate concept), say so and
it's a quick swap - only this one file changes.

Screenshots are unblocked now that a real icon exists, but still need someone
to pick which 5-6 screens tell the product's story before running
`xcrun simctl io <device> screenshot` against a Simulator - a presentation
choice, not a mechanical one, so still listed as blocked below rather than done
without you.

### Screenshots — BLOCKED

The plan notes correctly that these can be generated from the Simulator without
a physical device. They have not been, because the icon question above changes
what the screenshots should show, and because the App Store listing needs a
decision about which five or six screens tell the product's story — a
presentation choice rather than a mechanical one.

What is mechanically required: 6.7" (1290×2796) and 6.5" (1242×2688), PNG or
JPEG, no alpha, no device frame. `xcrun simctl io <device> screenshot` against a
Simulator running the app produces exactly this.

---

## 2. Metadata — drafted

Ready to paste into App Store Connect. Wording follows what `README.md` already
says about how this differs from Google Lens / Adobe Scan / Live Text, rather
than inventing new claims.

**Name:** TextScanner

**Subtitle** (30 char max): `Scan text. Then edit the photo.` — 31 characters,
so trim to `Scan text, then edit the photo` (30).

**Description:**

> TextScanner reads the text in a photo — and then lets you edit it *in place*,
> on the image itself.
>
> Most scanning apps stop at extraction: you get a block of text to copy, and
> the photo is left behind. TextScanner keeps the two together. Every recognized
> word becomes an object you can select, retype, move, resize or delete, sitting
> exactly where it sat in the original. Edit a word and the pixels underneath are
> filled in from the surrounding image, so the result still reads as a
> photograph rather than a photograph with a box pasted over it. Each word is
> drawn in ink colour sampled from the source, so corrections match what was
> already there.
>
> • Recognition runs entirely on your device. Photos are never uploaded.
> • Tap any word to correct it. Drag it, resize it, or delete it.
> • Translate the text in place, keeping the layout.
> • Clean up messy recognition with the Coherence Filter.
> • Hear the text read aloud.
> • Export the edited image, or copy the text out.
>
> The Coherence Filter and translation can run on-device on supported hardware.
> On other devices they are optional and use your own Anthropic API key — you
> hold the account, and nothing is sent anywhere unless you choose that tier.

**Keywords** (100 char max, comma-separated, no spaces):
`ocr,scan,text,extract,edit,photo,translate,recognition,copy,image,offline,scanner,reader,words`
— 94 characters.

**Support URL / Marketing URL:** **BLOCKED on Phase 5.** Both should be the
custom domain, which has not been acquired. Falling back to the
`github.io` URL would mean changing them again immediately after the migration.

**Category:** Productivity (primary). Utilities (secondary).

---

## 3. Privacy nutrition label — drafted from the manifests, not written fresh

This is the section that changed most on inspection, and the headline is:

> **The nutrition label cannot say this app collects nothing.** ML Kit's own
> privacy manifests declare six collected data types, and Apple aggregates
> linked SDKs' manifests into the app's privacy report.

### What every dependency actually declares

Read from `ios/App/Pods/**/PrivacyInfo.xcprivacy` on 2026-09-09, not recalled:

| Pod | Collected data types |
|---|---|
| **MLKitCommon** | DeviceID, OtherDataTypes, OtherUserContent, PerformanceData, ProductInteraction *(Analytics, App Functionality)*; OtherDiagnosticData *(Analytics)* |
| **MLKitTextRecognitionCommon** | identical to the above |
| **GoogleDataTransport** | OtherDiagnosticData *(Analytics)* |
| GoogleUtilities, GTMSessionFetcher, GoogleToolboxForMac, PromisesObjC, nanopb | none |
| **App target** (`ios/App/App/PrivacyInfo.xcprivacy`) | none — correct, its own code collects nothing |

**Every one of these is `Linked = false` and `Tracking = false`.** That matters:
they are not tied to a user's identity and are not used to track across apps or
sites. `NSPrivacyTracking` is `false` app-wide and there are no tracking domains.

`OtherUserContent` is the entry to read twice. This app's user content is
photographs of text. The declaration is Google's, covering the whole ML Kit
surface — including cloud-backed products this app does not use — and on-device
text recognition plausibly exercises little of it. But the manifest is what
Apple aggregates, and under-declaring is the failure mode with consequences.
**Declare it.**

### Recommended answers in App Store Connect

| Question | Answer |
|---|---|
| Does your app collect data? | **Yes** |
| Identifiers → Device ID | Yes · Analytics, App Functionality · **not** linked · **not** used for tracking |
| Usage Data → Product Interaction | Yes · Analytics, App Functionality · not linked · not tracking |
| Diagnostics → Performance Data | Yes · Analytics, App Functionality · not linked · not tracking |
| Diagnostics → Other Diagnostic Data | Yes · Analytics · not linked · not tracking |
| User Content → Other User Content | Yes · Analytics, App Functionality · not linked · not tracking |
| Other Data | Yes · Analytics, App Functionality · not linked · not tracking |
| Contact Info, Health, Financial, Location, Contacts, Browsing History, Search History, Purchases | **No** |

### The Claude API tier, which is separate and must also be declared

`js/coherenceClaude.js` and `js/translateClaude.js` POST recognized text to
`https://api.anthropic.com/v1/messages` when the user chooses that tier and
supplies their own key.

This is a user-initiated request to a service the user holds the account for,
not background collection by this app — but the text does leave the device, and
the honest answer is to declare it rather than argue the distinction:

- **User Content → Other User Content**, purpose **App Functionality**, not
  linked, not used for tracking.

That happens to be the same row ML Kit already forces, so it adds no new
category — but the reasoning should be recorded, because it is a *different*
reason and would survive the ML Kit dependency being removed.

**On-device tiers must not be declared as collection.** On Apple
Intelligence-eligible hardware the Coherence Filter and translation run locally
and make no request at all. Declaring those would be inaccurate in the direction
that misleads users about what the app does.

### Consistency

The plan requires the label to match both the privacy manifest and
`docs/PRIVACY-DECISIONS.md`. The app-target manifest's explanatory comment was
**corrected** in this pass — it previously said MLKitCommon declares "the device
ID and diagnostic data", which understated six categories down to two. It now
lists all six.

---

## 4. Privacy manifest — verified

- The app target has its own manifest, and its empty `NSPrivacyCollectedDataTypes`
  is **correct**: the target's own code collects nothing.
- **ML Kit does ship its own manifests**, which is Phase 6 step 4's question:
  `MLKitCommon.framework/PrivacyInfo.xcprivacy` and
  `MLKitTextRecognitionCommon.framework/PrivacyInfo.xcprivacy` are both present
  inside the shipped frameworks. Xcode aggregates them into the app's privacy
  report at archive time — nothing needs restating in the app's own manifest,
  and restating them would wrongly claim them as this target's usage.
- `plutil -lint ios/App/App/PrivacyInfo.xcprivacy` → **OK**.
- Required-reason APIs: the app target declares none, correctly. DiskSpace,
  FileTimestamp, SystemBootTime and UserDefaults are all accessed inside
  dependencies, each declaring its own reason code in its own manifest.

**This closes `ANALYSIS.md` §4.5 in its submission-blocking form.** The
telemetry question — does ML Kit phone home, and is it disclosable — is answered:
yes it does, Google declares exactly what, it is unlinked and non-tracking, and
it is disclosable through the standard nutrition-label rows above. What remains
open is the *product* question of whether to depend on an SDK that does this at
all, and only the Vision migration
(`docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md`) removes it.

---

## 5. Build settings

| Setting | Value | Status |
|---|---|---|
| `DEVELOPMENT_TEAM` | `YAQB9K65UT` | Set (carried over in `0961852`) |
| `CODE_SIGN_STYLE` | Automatic | Fine for development; App Store distribution needs a Distribution profile |
| `MARKETING_VERSION` | `1.0` | Correct for a first submission |
| `CURRENT_PROJECT_VERSION` | `1` | Correct for a first submission |
| Deployment target | iOS 15.5 | See note below |
| `CFBundleShortVersionString` / `CFBundleVersion` | `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` | Correctly driven from build settings |

**No version bump was made.** The plan says to bump version and build number,
but this is submission #1 — 1.0 (1) is exactly right, and incrementing before
anything has shipped would start the history at a number that never existed on
any device. Bump on the *second* submission.

**Deployment target iOS 15.5 — a finding for the Vision document.** This
resolves an item left open in `docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md` §7:
Vision's `automaticallyDetectsLanguage` requires **iOS 16**, so at the current
floor it is unavailable. A Vision migration wanting automatic multi-script
support would have to either raise the floor to 16 or set `recognitionLanguages`
explicitly. Not a blocker for that migration, but it is a real constraint that
was previously unquantified.

**Release configuration:** the Release build uses the standard Capacitor
template settings, which strip debug symbols into a dSYM rather than into the
binary. Not separately re-verified here.

---

## 6. Usage descriptions — verified, and they read well

Apple rejects generic usage strings. Both of these are specific about *what* is
accessed, *why*, and *what happens to it*:

> **NSCameraUsageDescription** — "TextScanner uses your camera to take a photo
> of text you want to scan. The photo is processed entirely on your device and
> is never uploaded or shared."

> **NSPhotoLibraryUsageDescription** — "TextScanner accesses your photo library
> so you can choose an existing photo to scan for text. The photo is processed
> entirely on your device and is never uploaded or shared."

Both claims are true of the scanning path specifically: recognition is ML Kit,
on device. The Claude tier transmits *text*, never the image — and only on the
user's explicit choice, with their own key. The strings say "the photo", which
stays accurate.

Added in `2b89352`. **No change needed.**

---

## 7. Native build — compiles

```
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
           -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

**`** BUILD SUCCEEDED **`, exit 0, zero errors** (Xcode 26.6, 2026-09-09).

Every warning emitted comes from a dependency — Capacitor's own Swift
(`CAPSceneDelegateProxy.swift`, `LegacyFilesystemImplementation.swift`) and the
CocoaPods "Copy Pods Resources" script phase having no declared outputs. None is
in this project's code, and none blocks submission.

This is not the same as Archive → Validate App, which is the plan's step 6 and
is blocked below. It does establish that the project, the Pods and the synced
web assets compile together after the Part I changes.

---

## 8. Blocked — and who unblocks it

| # | Item | Blocked on |
|---|---|---|
| 1 | **App icon** | **You.** A design decision. Stock Capacitor logo will be rejected. |
| 2 | **Screenshots** | Follows the icon; then a Simulator run and a choice of which screens to show. |
| 3 | **Support / Marketing URL** | **Phase 5** — the custom domain does not exist yet. |
| 4 | **Archive → Validate App** | **You.** Needs an App Store Distribution certificate and provisioning profile in an Apple Developer account. `xcodebuild` can archive unsigned, but Validate App submits to Apple's checks and requires real distribution signing. |
| 5 | Release-config symbol stripping | Confirmable during the Archive in #4. |

Items 1, 3 and 4 are the genuine submission blockers. Everything else in this
document is done.
