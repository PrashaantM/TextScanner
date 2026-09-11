# TextScanner — hands-on findings and fix plan

**Scope note, read this first:** your repo already contains a genuinely rigorous
engineering audit — `ANALYSIS.md`, `HANDOFF.md`, `TEXTSCANNER-HARDENING-PLAN.md`,
`docs/APP-STORE-SUBMISSION.md`, `docs/PRIVACY-DECISIONS.md`. It root-caused a real
positioning bug with fixtures instead of guesswork, runs 12 CI gates, measures
CER/WER against a baseline, and corrects its own prior false claims instead of
repeating them. I read all of it. This document does not redo that work — it
would come out worse than what's already there. It does two things instead:

1. Reports what I found by actually clicking through the live app in your browser
   and reading the exact lines of code responsible — real bugs, not in the
   existing docs, because those are code/security audits, not UX walkthroughs.
2. Rolls up the open items from the existing docs into one place so you have a
   single prioritized list, with a source link back to the fuller writeup for
   each.

Everything in §1 I reproduced myself and traced to a line number. Everything in
§2 is carried over from your own docs, not independently re-verified by me.

---

## 1. New findings, found by testing the live app

### 1.1 Tapping "Note" creates a new blank note every time — HIGH, data hygiene

**Reproduced:** clicked the "Note" button in the top nav four times over the
course of testing. Got four separate empty "Untitled note" documents in the
library, each one immediately, with no content, no confirmation, no way to tell
it wasn't wanted until you go delete it.

**Cause:** `js/app.js:275` — `elements.navNote.addEventListener("click", () =>
createAndOpenNote())`. `createAndOpenNote()` (line 110) calls
`createDocument({ type: DOC_TYPES.NOTE, ... })` unconditionally, before a
single character has been typed. There's no "does a document already exist for
this intent" check and no lazy-create-on-first-edit.

**Why it matters:** this isn't a cosmetic glitch, it's silent, persistent data
creation from what looks like pure navigation. A user who taps Note to check an
existing note, decides against it, and backs out has just added junk to their
library — and TextScanner's whole pitch is "everything stays on this device,"
so that junk doesn't even get cleaned up by anything external. Over weeks of use
this is how "3 documents" becomes "47 documents, half of them named 'Untitled
note' with nothing in them."

### 1.2 Picking an image on the Scan screen silently creates a library entry — HIGH, data hygiene

**Reproduced:** on the Scan screen, clicking "Try a sample image" (before
clicking "Scan text") immediately showed "Adding to 'Untitled scan'." I hadn't
asked to create anything yet — I was previewing. Backing out at this point
leaves a real, permanent "Untitled scan · 0 pages" card sitting in the library
forever. I found two of these already sitting in the library before I'd touched
anything, which means this isn't hypothetical — it's already happened during
normal use of this app.

**Cause:** `js/app.js:122-135`, `createAndOpenScan()`, called from
`elements.navScan.addEventListener("click", ...)` at line 274. Same pattern as
1.1 — `createDocument()` fires on nav-tap, not on first committed page.

**Fix for both 1.1 and 1.2:** don't create the document record until there's
something to save. Concretely:
- Hold a draft in memory (title text, note body, or the in-progress scan
  image/pages) exactly as you do now, but only call `createDocument()` the
  first time there's real content — first keystroke in the note body/title,
  or the first successful "Scan text" / "Add as document page" for a scan.
- If the user navigates away from a draft with nothing in it, just discard the
  draft. Nothing to delete because nothing was ever created.
- This is a small, local change — `createAndOpenNote`/`createAndOpenScan`
  become "prepare a draft and show the view" instead of "create and show the
  view," and the existing `addCurrentImageAsPage`/note-body-changed handlers
  become the place that actually calls `createDocument()` if a doc doesn't
  exist yet for the current draft. It doesn't touch the document model, the
  storage layer, or any of the 68 element ids `dom.js` resolves, so it shouldn't
  put any of the existing CI gates at risk.
- One-time cleanup: add a startup or Settings-triggered sweep that finds
  existing `SCAN` documents with zero pages and `NOTE` documents with empty
  title and empty body, and either silently removes them or surfaces them in
  a "clean up empty documents" prompt. Otherwise every user who's already hit
  this bug (which, per the two ghost entries I found, includes you) keeps the
  litter forever.

### 1.3 The nav bar's visual language claims to be tabs; it isn't — MEDIUM, information architecture

**Reproduced/verified in code:** `index.html:84-86` —

```html
<button id="nav-library" class="btn btn--ghost btn--small">Library</button>
<button id="nav-new-scan" class="btn btn--primary btn--small">Scan</button>
<button id="nav-new-note" class="btn btn--secondary btn--small">Note</button>
```

"Scan" is hardcoded as the filled, high-emphasis `btn--primary` pill and "Note"
as the outlined `btn--secondary` pill, permanently, regardless of what view is
actually showing. Filled-pill-next-to-two-plain-buttons is a convention people
read as "currently selected tab." It isn't one. I opened the Library, and "Scan"
sat there lit up in blue the entire time. I opened a note, and both "Scan" and
"Note" were highlighted simultaneously — because neither button's styling has
anything to do with the active view; `document.body.dataset.activeView` was
correctly `"document"` the whole time, the buttons just never looked at it.

This is exactly what produces 1.1 and 1.2 in practice: the bar *looks* like
"Library / Scan / Note" are three destinations you switch between, so tapping
"Note" reads as "go look at my notes," not "create a new one right now." The
mismatch between what the UI implies and what the code does is the root cause
of the bug feeling surprising rather than obviously wrong. See the redesign
document (`03-REDESIGN-PLAN.md`) for the actual IA fix — this entry is here
because it's a genuine, reproducible finding, not just a styling nitpick.

### 1.4 Deleting a document has no confirmation and no undo affordance — LOW/MEDIUM, safety

**Reproduced:** hovering a library card reveals "Pin" / "Delete" (correctly
touch-visible via `@media (hover: none)` in `style.css:1420` — I checked, this
part is handled well, not a bug). Clicking "Delete" removes the card from the
main list instantly. No "are you sure?", no toast with an "Undo" action. It
does go to Recently Deleted rather than being purged outright, which is the
right safety net to have — but the only way to discover that net exists is to
already know to look for it. A user who fat-fingers Delete on a real document
gets zero on-screen acknowledgment that anything reversible just happened.

**Fix:** a lightweight toast — "Deleted 'Untitled scan'. Undo" — for 4-6
seconds after a trash action, is a small addition (`js/library.js` already owns
the trash/restore logic; this just needs a transient UI element and a timer)
and closes the gap without adding a modal confirmation dialog that would slow
down the common case.

### 1.5 Export is offered on a document with zero pages — LOW, polish

On the empty "Untitled scan" document, "Export PDF" renders as an enabled,
primary-styled button despite "No pages yet" being displayed directly above it.
I didn't click it (didn't want to trigger a download on your machine without
asking), so I can't tell you what it actually produces — an empty/invalid PDF,
a silent no-op, or a graceful "nothing to export" message. Worth a five-minute
check: either disable Export while `pageIds.length === 0`, or confirm the
existing code already handles it gracefully and this is a non-issue.

---

## 2. Open items already tracked in your own docs

Rolled up here for one prioritized view. Source doc and section noted for each
so you can go straight to the full reasoning rather than take my summary on
faith.

| # | Item | Severity | Status | Source |
|---|---|---|---|---|
| A | API key stored on the shared `github.io` origin — any other project hosted under the same GitHub Pages account can read it back | High | Open, correctly — blocked on owning a custom domain. Migration copy is pre-written and must **not** ship early, since the current warning is accurate right now | `ANALYSIS.md` §4.3, `docs/CUSTOM-DOMAIN-MIGRATION.md` |
| B | No physical-device pass has ever been run | Medium | Every check now maps to an automated gate, so this is confirmation, not discovery — but it hasn't happened yet | `ANALYSIS.md` §6, `docs/DEVICE-VERIFICATION-CHECKLIST.md` |
| C | Benchmark corpus is 11 images, only 8 with complete transcripts; needs 14 real photographs (low light, steep skew, receipt, street sign, non-Latin, etc.) that can't be synthetically generated | Medium | Blocked on you owning a camera and going and shooting them | `ANALYSIS.md` §7.2, `test/TUNING-2.md` |
| D | App icon is the unmodified Capacitor template logo | Medium–High | **Submission blocker.** Apple rejects placeholder icons under Guideline 4.0. See `04-APP-STORE-LAUNCH-PLAN.md` in this set for a real design direction | `docs/APP-STORE-SUBMISSION.md` §1 |
| E | ML Kit (iOS text recognition) declares six data-collection categories in its privacy manifest, not the two a stale comment used to claim | Low, corrected | Disclosed correctly now; only removable by migrating off ML Kit to Vision, which is scoped but deliberately not recommended yet | `ANALYSIS.md` §4.5 |
| F | No font-weight detection in the image-format editor | Informational | Measured, doesn't work reliably, deliberately not shipped rather than shipped broken | `ANALYSIS.md` §5.4 |
| G | `script: "LATIN"` — non-Latin script recognition is a known, measured gap | Low | Asserted with a tripwire test rather than silently broken | `ANALYSIS.md` §7.5 |
| H | Nothing automatically verifies the generated `www/`/`ios/App/App/public/` trees are in sync with source | Low | Caught once by a manual grep, not by tooling | `ANALYSIS.md` §7.5 |
| I | Archive → Validate App has never been run (needs a real Distribution certificate) | Medium | Submission blocker | `docs/APP-STORE-SUBMISSION.md` §8 |
| J | Support/marketing URLs blocked on the custom domain | Low | Same root cause as A | `docs/APP-STORE-SUBMISSION.md` §8 |

---

## 3. Suggested order of work

This threads the needle between "fix what I found" and "don't destabilize what
already has 12 green CI gates protecting it."

1. **1.1 + 1.2 first.** They're small, localized, don't touch the recognition
   pipeline or storage schema, and they're actively creating junk data in your
   library every time the app is used. Add a unit/browser test asserting
   "opening the Note view with no edits and navigating away creates zero
   documents" and "previewing a sample image without scanning creates zero
   documents" — mirrors the existing test style (`test/library-documents.js`
   already covers the document layer) and becomes a permanent regression gate.
2. **1.4**, same sitting — it's a small, additive UI change.
3. **1.3** as part of the redesign work in `03-REDESIGN-PLAN.md`, since fixing
   it properly means rethinking the nav bar rather than patching a class name.
4. **D (icon)** next, since it blocks submission and screenshots both wait on
   it — see the launch plan doc for a real proposal.
5. **A, B, C, I, J** proceed on their existing tracks — they're blocked on you
   (a domain purchase, a developer certificate, a camera, a phone), not on
   more engineering time, and the docs already have the exact steps ready to
   execute the moment each blocker clears.
6. **E, F, G, H** — no action needed now; they're correctly disclosed/asserted
   already. Revisit E only if you do the (currently not-recommended) Vision
   migration.
