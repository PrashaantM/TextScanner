# UI Redesign Plan — a proposal, not a spec

**This is a starting point for a conversation, not a decided design.** Every
disposition below is my recommendation, not a instruction I'm about to carry
out. Several sections end in an explicit open question because I did not have
enough evidence to decide and would rather say so than guess quietly. Nothing
in this document changes any code — no edits were made this session, by
request, because another session is mid-flight on a separate change.

## 0. Scope and how this was built

The task named three "real" views. The app's own markup (`index.html`'s
header comment) actually declares five: library, scan, document, crop,
settings. I'm mapping the three requested views onto the app's real structure
like this, and flagging the mapping itself as an assumption:

| Requested view | Actual `data-view` | What's in it |
|---|---|---|
| Home / library | `library` | The whole library screen: search, sidebar, document list/grid |
| Scan | `scan` | Capture, OCR, and the single-image result editor (Text / Image format / Full image) |
| Edit / annotate | `document` | Both real editors: the note editor and the multi-page scan-doc editor |

**Left out on purpose:** `crop` (a focused four-corner tool, already a single
clear job) and `settings` (pure utility, no redesign-relevant controls). If
"edit/annotate" was meant to include the crop view or the Full-image word
editor as a fourth thing, say so — I treated Full image's word editor as part
of "scan" (it lives inside `view-scan`'s `result-section`) and `document` as
"edit/annotate," which is a judgment call, not a given.

**Sourcing.** Per the task, I walked `index.html`, `js/dom.js`, and
`js/scanDoc.js` directly rather than recalling them, and every row below is
tied to a real id or `data-*` attribute I found in one of those three files.
Two gaps forced me outside that list, stated here rather than silently:

- **`js/dom.js` exports nothing for the library view** — no `library-*` id
  appears in it. The library's real controls (cards, swipe, the long-press
  radial menu, the right-click menu, the sidebar) are built entirely in
  `js/library.js` and `js/radialMenu.js`, which resolve their own ids the same
  way `js/scanDoc.js` does. I read both directly to inventory the home screen
  at all; without them, section 1.1 would be four rows long and miss most of
  what a person actually touches.
- **The note editor's toolbar** (`#note-toolbar` in `index.html`) is fully
  described by its own markup (`data-command` / `data-action` attributes are
  self-explanatory: they're `document.execCommand` names and a small set of
  custom actions), so I inventoried it from `index.html` alone. Its behavior
  lives in `js/notesEditor.js`, which I did not read line-by-line — flagging
  that as a shallower pass than scan-doc and the library got.

---

## 1. Control inventory

Disposition vocabulary, matching the task's four plus one I needed:

- **keep** — works, not part of a named flaw, no change proposed here.
- **merge** — collapses with another control; see the numbered resolution.
- **gesture** — convert from a persistent toggle/button into a direct-manipulation gesture.
- **remove** — a duplicate with nothing left for it to do once another control is fixed.
- **redesign** — same behavior, different visual/affordance under the token system in §3 (not a behavior change).

Persistent chrome (present on every view, so listed once):

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Skip to content | `index.html:105` | Jumps focus past the app bar for keyboard users | keep |
| Back | `#app-back`, `index.html:111` | Returns to the previous view; hidden on library | keep |
| App title/subtitle | `#app-title`/`#app-subtitle`, `index.html:116-117` | Contextual heading, set per view by `js/main.js` | keep |
| Library | `#nav-library`, `index.html:121` | Navigates to library | keep |
| + New | `#nav-add`, `index.html:127` | Opens the action sheet (Scan / Note), creates nothing itself | keep |
| Settings (gear) | `#nav-settings`, `index.html:130` | Navigates to settings | keep |
| Theme | `#theme-btn`, `index.html:136` | Cycles system → light → dark | keep |
| Action sheet: Scan a document | `#action-sheet-scan`, `index.html:148` | Opens the scan view empty | keep |
| Action sheet: New note | `#action-sheet-note`, `index.html:155` | Opens a blank note draft | keep |
| Command palette | `#command-palette*`, `index.html:167-173` | Cmd/Ctrl+K search over commands and documents | keep |
| Shortcut sheet | `#shortcut-sheet*`, `index.html:177-197` | "?" opens a static cheat sheet | keep |
| Toast + its action | `#app-toast*`, `index.html:222-225` | "Deleted 'x'. Undo" style transient notice | keep |

### 1.1 Home / Library

Static shell from `index.html:232-254`; everything inside `#library-sidebar`
and `#library-list` is rendered by `js/library.js` (cited by function/line).

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Search | `#library-search`, `index.html:236` | Full-text search across titles, tags, scanned text; debounced 140ms (`library.js:715-725`) | keep |
| Clear search (×) | `#library-clear-search`, `index.html:239` | Empties the search box | keep |
| Result count | `#library-count`, `index.html:242` | Status text, not interactive | keep |
| Grid/List toggle | `#library-layout-btn`, `index.html:243` | Text button, swaps list↔grid card layout (`library.js:735-740`) | redesign — a text label that flips between "Grid" and "List" is legible but generic; an icon pair (list-rows / grid-cells) with `aria-pressed` reads faster and fits the HUD-style toggle language proposed in §3 |
| Empty trash | `#library-empty-trash`, `index.html:244` | Shown only while viewing Recently Deleted; purges everything in it after a confirm | keep |
| Sidebar: All documents / Notes / Scans | `library.js:310-315` | Type filters, with live counts | keep |
| Sidebar: Folders list + ⋮ menu | `library.js:285-297` | Filter by folder; ⋮ opens rename/delete | keep |
| Sidebar: + New folder | `library.js:321` | Creates a folder | keep |
| Sidebar: Tags | `library.js:299-305` | Filters by tag, up to 24 shown | keep |
| Sidebar: Recently Deleted | `library.js:328-329` | Switches to trash view, with count | keep |
| Card: open | `library.js:169` (`data-action="open"`) | Opens the document | keep |
| Card: Pin/Unpin, Delete (hover buttons) | `library.js:164-165` | Mouse-only, always visible on hover; the touch equivalent is the swipe/long-press below | keep — this is the correct mouse-vs-touch split, not a duplicate |
| Card: Restore, Delete now (trash view) | `library.js:162-163` | Only shown inside Recently Deleted | keep |
| Card: swipe left/right | `library.js:499-573` | Touch-only: swipe left past 72px = delete, right = pin; armed state shown past 56px | keep — **this is the pattern §2.3 proposes for Move/Select-multiple** |
| Card: long-press → radial menu | `library.js:524-541` | 420ms hold (cancelled by >8px of movement) opens a 3-spoke radial menu: Pin, Move, Delete | keep |
| Card: right-click → context menu | `library.js:575-578`, menu built at `library.js:667-671` | Desktop equivalent of the radial menu: Pin/Unpin, Move to folder…, Delete | keep |
| Folder picker | `#folder-picker*`, `index.html:206-210` | Opened by "Move"; lists folders + "+ New folder" | keep |
| Empty-state: Scan a document / New note | `library.js:266-267` | Shown only when the library (or a filtered view) has nothing in it | keep |

**Note for §4:** `js/library.js`'s own header comment (line 3) calls this "the
Notes-app surface" already — this section is the evidence base for the
home-screen discussion later in this document, not a new claim.

### 1.2 Scan

All ids below are exported from `js/dom.js` unless noted otherwise.

**Capture**

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Drop zone | `#drop-zone`, `index.html:269` | Click, drag-drop, or paste target for an image | keep |
| Use camera | `#camera-btn` | Opens the device camera (capture="environment") | keep |
| Try a sample image | `#sample-btn` | Draws a canned sample on canvas, no network | keep |

**Preview**

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Scan text | `#scan-btn` | Runs OCR on the selected image | keep |
| Add as document page | `#add-to-doc-btn` | Runs edge detection, offers crop, appends as a page — the bridge into a multi-page document | keep |
| Choose a different image | `resetBtn`, `#reset-btn` | Returns to the drop zone | keep |

**Result — mode/filter toggles**

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Text / Image format / Full image | `modeTextBtn`/`modeImageBtn`/`modeFullBtn`, `index.html:327-329` | Three-way view switch; only "full" shows the editor toolbar | keep — the manual/granular control; see §2.4 |
| Clean up this text | `cleanUpTextBtn`, `index.html:340` | Proxies to `filterCoherenceBtn.click()`, plus a skip-the-call gate (`js/main.js:531-546`) | merge — see §2.5 |
| View on photo → | `viewOnPhotoBtn`, `index.html:341` | Proxies to `modeFullBtn.click()` (`js/main.js:555-557`) | merge — see §2.4 |
| Coherence-gate hint | `coherenceGateHint` | "This already looks like a sentence" — inline suggestion, not a control | keep |
| Raw / Filtered Text / Coherence Filter | `filterRawBtn`/`filterFilteredBtn`/`filterCoherenceBtn`, `index.html:357-359` | Three-way filter level | keep — the manual/granular control; see §2.5 |

**Coherence panel** (`coherencePanel` and children, `index.html:367-405`) — functional, not part of a named flaw:

| Control | Does today | Disposition |
|---|---|---|
| Tier name + switch button | States which tier (on-device/Claude) will run; lets you opt into the other | keep |
| API key input + Save key | Stores a BYOK Anthropic key, browser-local | keep |
| Generate | Runs the rewrite | keep |
| Change key | Clears the stored key | keep |

**Result — actions row**

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Select multiple | `selectMultiBtn`, `index.html:412` | Toggles marquee/rubber-band selection mode (`js/editorInteractions.js:192-204`) | gesture — see §2.3 |
| Copy | `copyBtn`, `index.html:413` | Copies the active result text to the clipboard | keep, but see §2.2 for its missing counterpart |
| Download .txt | `downloadBtn`, `index.html:414` | Always visible; downloads the active text as `.txt` (`js/main.js:713-725`) | merge — see §2.1 |
| Download image | `downloadImageBtn`, `index.html:415` | Visible only in Image format/Full image; downloads a PNG of the canvas (`js/main.js:727-741`) | merge — see §2.1 |
| Save as note | `saveNoteBtn`, `#save-note-btn` | Sends recognized text into a new note | keep |

**Translate / TTS** (not part of a named flaw):

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Translate to (select) | `translateTarget` | Target language, pre-filled from detected language | keep |
| Translate | `translateBtn` | Replaces text in place at the same image position | keep |
| Revert to original | `translateRevertBtn` | Undoes the in-place translation | keep |
| Play / Stop | `ttsPlayBtn`/`ttsStopBtn` | Browser SpeechSynthesis playback of the active text | keep |

**Editor toolbar** (Full image only, `index.html:455-463`)

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Move components | `editorModeBtn`, `index.html:456` | Toggles `fullEditorMode`; **while on, every word's `contentEditable` is explicitly turned off** (`js/editorInteractions.js:158`) — this is the literal mechanism of "blocks editing" | gesture — see §2.3 |
| New text | `newTextBtn`, `index.html:457` | Arms placement mode; next click on the canvas drops a new text box | keep — an arm-then-place pattern, not a persistent blocking mode; not a named flaw |
| Delete | `deleteBtn` | Deletes the current selection | keep (needed regardless of §2.3's outcome) |
| Undo / Redo | `undoBtn`/`redoBtn` | Standard undo/redo stack for editor edits | keep |

**Result surface / status** (not controls — listed for completeness, not rows to dispose of):

`result-text` (textarea, readonly — relevant to §2.2), `image-format-view` +
`image-format-bg` (the canvas), `resize-handle` (a real `role="slider"`,
keyboard-operable — its *availability* changes under §2.3's proposal, not its
mechanism), `marquee-box` (visual only), `confidence-note`,
`editor-keyboard-hint`, `image-format-hint`, `selection-status` (all hint/live-region text, copy of which will need updating if §2.3 ships).

### 1.3 Edit / Annotate (Document view: note editor + scan-doc)

**Note editor** (`index.html:513-559`, ids/attributes only — behavior lives in
`js/notesEditor.js`, not walked line-by-line this pass):

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Title | `#note-title` | Document title | keep |
| Paragraph style (select) | `[data-block]` | Body/Title/Heading/Subheading/Quote/Code | keep |
| Bold/Italic/Underline/Strikethrough | `[data-command]` ×4 | Standard `execCommand` formatting | keep |
| Bulleted/Numbered list | `[data-command]` ×2 | Standard list commands | keep |
| Checklist | `[data-action="checklist"]` | Custom checkbox-list insertion | keep |
| Add link | `[data-action="link"]` | Inserts a link | keep |
| Insert image | `[data-action="insert-image"]` | Opens `#note-image-input` (multi-file) | keep |
| Clear formatting | `[data-action="clear-format"]` | Strips inline formatting | keep |
| Body | `#note-body` (contenteditable) | The note surface; paste is sanitized on the way in | keep |

**Scan-doc** (`index.html:562-687`; all dispatch through one delegated click
handler in `js/scanDoc.js:931-1026`, keyed by `data-scan-action`):

| Control | Where | Does today | Disposition |
|---|---|---|---|
| Title | `#scan-doc-title` | Document title | keep |
| Page preview | `#page-preview` | Shows the selected page; `contain`-fit | keep (canvas, not a control) |
| Filter chips | `#scan-filter-row`, built at `scanDoc.js:901-906` | One chip per `FILTER_ORDER` entry; re-derives from the page's *original*, never the current image (`scanDoc.js:9-15`) | keep |
| Rotate left/right | `data-scan-action="rotate-left/-right"` | 90° rotation, rebuilds from original | keep — candidate for a rotate gesture on the preview itself later, but not a named flaw |
| Adjust edges | `data-scan-action="crop"` | Navigates to the dedicated crop view | keep |
| Apply filter to all | `data-scan-action="filter-all"` | Applies the selected page's filter to every page, after a confirm | keep |
| Redact | `data-scan-action="redact"` | Toggles redaction drafting mode | keep — **this is a toggle mode, but not one of the two named ones, and it shouldn't be gestured away**: it gates a two-confirm, irreversible action (destroys the page's original, `scanDoc.js:452-490`) that genuinely benefits from an explicit "I am now drafting a destructive edit" state with a visible Cancel, unlike Move/Select-multiple, which block a non-destructive one |
| Delete page | `data-scan-action="delete-page"` | Deletes the selected page, after a confirm | keep |
| Redaction: box count / Apply / Undo last box / Cancel | `#scan-redact-*`, `index.html:606-618` | Drafting-only controls; Undo deliberately does not exist outside draft mode (`scanDoc.js:334-344`) | keep |
| Recognize text | `data-scan-action="recognize"` | OCR on the selected page | keep |
| Recognize all pages | `data-scan-action="recognize-all"` | OCR on every page missing text | keep |
| Copy text | `data-scan-action="copy-text"` | Copies every page's concatenated text | keep — **not** given a matching Paste; see the scope note under §2.2 |
| Find PII | `data-scan-action="pii-scan"` | Runs format-shaped PII detection on the page's recognized words | keep |
| PII: candidate checkboxes, Redact selected, Cancel | `#scan-pii-*`, `index.html:634-646` | Feeds selected candidates into the same redaction draft above | keep |
| Page size (select) | `#scan-paper-size` | Export paper size | keep |
| Searchable text layer (checkbox) | `#scan-searchable` | Embeds an invisible OCR text layer in the PDF | keep |
| Export PDF | `data-scan-action="export-pdf"` | Builds and downloads a PDF | keep |
| Export images | `data-scan-action="export-images"` | Downloads each page as a JPEG, 220ms apart | keep |
| Export text | `data-scan-action="export-text"` | Downloads all pages' text as one `.txt` | keep — genuinely three different artifacts (PDF/images/text), not two labels for one thing, so §2.1's merge logic doesn't apply here as-is. A cosmetic "Export ▾" menu unifying all three under the token system is a reasonable optional follow-up, not a requirement. |
| Add page | `data-scan-action="add-page"` | Hands off to the scan flow to capture another page | keep |
| Page strip | `#page-strip` | Listbox; drag to reorder, Alt+Arrow to reorder by keyboard, plain Arrow to move selection (`scanDoc.js:1139-1173`) | keep — already the right model: gesture **and** keyboard, not gesture-only |
| Move page earlier/later | `data-scan-action="move-left/-right"` | Keyboard/tap-accessible reorder, redundant with Alt+Arrow by design — serves touch users with no hardware keyboard | keep |

---

## 2. Named-flaw resolutions

### 2.1 "Download" and "Download .txt" → one control

**What's actually there today**, verified against `js/main.js:713-741`:
`download-btn` ("Download .txt") has no `hidden` class and is **always**
visible. `download-image-btn` ("Download image") is shown only in Image
format/Full image mode. So in those two modes, the toolbar shows both at
once — two adjacent buttons that both start with "Download," for two
different artifacts.

**Proposed mechanism:** one `Download` control. In Text mode there is only
one artifact (the text), so it downloads directly with no menu — behavior
unchanged from today's `download-btn`. In Image format/Full image mode,
where both a text and an image artifact exist, the same button opens a small
attached menu ("Image", "Text") rather than showing two buttons side by side.
This is the same "single entry point, disclosed choice when there's more than
one thing to do" shape the app already uses for diagnostics export ("hands it
to your device's share sheet," `index.html:762-764`) — not a new interaction
vocabulary, an existing one applied here.

**Trade-off to flag:** this trades one click for zero in the two-artifact
case (today's two-buttons-visible is actually *faster* than a menu, once you
know it exists). If discoverability of the second artifact matters more than
one extra tap, keeping two buttons but restyling them as a single visually-grouped
segmented control ("Download: Text | Image") is the lower-risk alternative —
same two clicks as today, just visually one control instead of two. I'd lean
towards the menu version, but this is a real trade-off, not a settled call.

### 2.2 Copy needs a matching Paste

Verified there is no clipboard-*read* action anywhere in the scan-result
toolbar — `copyBtn` (`index.html:413`) only writes. The app does already read
the clipboard in two unrelated places (`js/main.js:305`, an image paste onto
the drop zone; `js/notesEditor.js:381-400`, sanitized HTML/text paste into a
note body), so "Paste" as a concept isn't foreign to the app — it's just
absent at the one spot named here.

**The real obstacle:** Copy and Paste aren't naturally symmetric in this
view, because `result-text` is `readonly` (`index.html:467`) — there is
nowhere for pasted text to *go* in Text mode today. I see two candidate
mechanisms and I'm not confident which one the flaw actually points at:

1. **Whole-buffer paste.** Matches Copy's own granularity exactly: a Paste
   button reads `navigator.clipboard.readText()` and replaces the active
   result text outright. Simple, symmetric, but destructive (would need a
   confirm or an undo, since it discards the OCR result) and only makes sense
   in Text mode — Image format/Full image have no single "buffer" to replace.
2. **Positional paste.** In Image format/Full image, reuse the existing
   arm-then-place pattern from `newTextBtn` (§1.2): "Paste" arms a placement
   click that drops the clipboard's text as a new object at the tapped point,
   pre-filled instead of empty. This fits the image modes naturally but has
   no obvious meaning in Text mode.

These solve different problems (correcting the whole OCR result vs. adding
pasted text onto the image) and I don't have evidence for which one "a
matching Paste" was asking for — possibly both, at different altitudes.
**Flagging this as open** rather than picking one.

Scope note: `scan-doc`'s own "Copy text" (§1.3) is excluded from this — it
copies concatenated multi-page text as a bulk-export action, closer in kind
to "Export text" than to an editable buffer's Copy, so no matching Paste is
proposed for it.

### 2.3 Move and Select-multiple stop blocking editing

This is the flaw with the clearest code-level cause. `setFullEditorMode(on)`
does this at `js/editorInteractions.js:156-163`:

```js
state.editorObjects.forEach((obj) => {
  if (obj.type === "word") {
    obj.el.contentEditable = String(!on);   // <-- editing is OFF while Move is ON
    obj.el.tabIndex = 0;
  }
});
```

Entering "Move components" is not just "now you can also drag things" — it
*revokes* `contentEditable` from every word for as long as the mode is on.
Editing text and repositioning it are mutually exclusive states you have to
explicitly step between. `setMarqueeMode` (`js/editorInteractions.js:192-200`)
has the same shape for selection: it's a persistent toggle (`selectMultiBtn`
text flips "Select multiple" ↔ "Done selecting") rather than a transient
gesture, because on touch a plain drag is how the page scrolls
(`js/editorInteractions.js:179-190` explains this directly).

The library view already solved the touch-drag-vs-scroll problem without a
mode button (§1.1: swipe reads a *fast, deliberate* horizontal drag on a
card; scrolling is a normal vertical drag; a long-press escalates to more
options). I'm proposing the same vocabulary here instead of inventing a new
one:

**Move components → gesture.** Drop the toggle. A tap on a word still edits
it (unchanged). A press-and-hold-then-drag on a word's body (not on its text
caret — i.e., movement past a small threshold before a caret would normally
land) picks it up and moves it; releasing drops it. The resize handle
(`resizeHandle`, already a real `role="slider"`) appears on selection the
moment an object is selected, not only once a separate mode button has been
pressed — so select → resize/move/edit all become available at once, the way
a native drawing or notes app treats an object rather than the way a "mode"
based editor does. `editorModeBtn` itself is removed as a control (its label
and aria-pressed state have nothing left to represent).

**Select multiple → gesture.** Propose a long-press-and-drag on empty canvas
(not on a word) starting the marquee directly, mirroring the card long-press
in §1.1 exactly: a quick drag continues to scroll/pan as it does today; a
held drag starts rubber-banding. `selectMultiBtn` is removed as a control.

**What survives unchanged:** `newTextBtn`'s arm-then-place pattern (§1.3) and
`deleteBtn`/`undoBtn`/`redoBtn` (still needed once something is selected,
regardless of how it got selected).

**What I'm not sure about:** long-press-and-drag for marquee selection
competes with the same gesture already used to *move* a word (both start
with a press-and-hold). The disambiguator would have to be "did the press
start on a word, or on empty canvas" — workable, but it's a real design
detail that needs to be tried on an actual touch device before I'd call it
settled, not just reasoned about on paper. Flagging that as a prototype-and-verify
item, not a decided mechanism.

### 2.4 "View on photo" and Full image merge into one control

`viewOnPhotoBtn` is not a second control with overlapping behavior by
accident — `js/main.js:555-557` makes it a literal one-line proxy:
`modeFullBtn.click()`. It exists specifically because this used to be wired
to `modeImageBtn` instead (a real, fixed bug — Image format has no photo and
no "Move components," so the button's own promise didn't match its
destination; see `js/dom.js:33-38` and `test/guided-path.js`). Today the two
are **genuinely identical in destination**, wearing two names at two
altitudes: `viewOnPhotoBtn` is the guided, one-tap CTA; `modeFullBtn` is one
of three peers in the manual Text/Image format/Full image toggle.

**Decision: merge.** The toggle's third option is renamed from "Full image"
to "View on photo," restyled as the primary-styled button in that row, and
the separate `viewOnPhotoBtn` is deleted. The three-way toggle stays complete
(still three peer options: Text / Image format / View on photo) — the guided
path becomes the primary-styled member of the real toggle instead of a proxy
button sitting above it.

**Accepted consequence:** this removes the visual hierarchy the guided row
was deliberately built to have (a big obvious CTA above a smaller manual
control, per the commit history in `TEXTSCANNER-HARDENING-PLAN.md`). That's a
real loss, taken deliberately in exchange for one control instead of two with
identical destinations — not an oversight.

### 2.5 "Clean up this text" and Coherence Filter merge into one control

Same shape as §2.4, confirmed at `js/main.js:531-546`: `cleanUpTextBtn`'s
click handler ends with `filterCoherenceBtn.click()`. **Not quite identical,
though** — `cleanUpTextBtn` carries one behavior `filterCoherenceBtn` doesn't:
the skip-the-call gate (`looksAlreadyCoherent`, `js/coherenceGate.js`).
Clicking "Coherence Filter" directly in the manual filter-toggle row runs the
rewrite immediately today, with no "this already looks like a sentence,
reconstruct anyway?" check — that check only fires through the guided button.

**Decision: merge, and the gate moves with it.** The filter-toggle's third
option is renamed from "Coherence Filter" to "Clean up this text," restyled
as the primary-styled button in that row, and the separate `cleanUpTextBtn`
is deleted. The skip-the-call gate moves onto the merged control itself, so
it fires on every path to that filter level, not only the guided path that no
longer exists as a separate button.

**Accepted consequence:** same visual-hierarchy loss as §2.4, taken for the
same reason. Additionally, a power user who previously reached Coherence
Filter through the manual toggle (bypassing the gate) now sees the "this
already looks like a sentence" suggestion too — a behavior change, not just a
label change, and a deliberate one: one control means one behavior, not a
behavior that depends on which now-deleted button used to lead here.

---

## 3. Design tokens — a sci-fi system

None of this exists yet. `style.css`'s `:root` (lines 21-58) defines color,
radius, shadow, and motion tokens already, consumed by hundreds of rules —
but **no type scale and no spacing scale exist today**; font sizes are ad hoc
per-rule (`0.78rem`, `0.85rem`, `0.9rem`, `1.1rem`... scattered with no shared
step), and spacing is likewise per-rule `rem`/`px`/`em` values with nothing
named. So this section is genuinely additive in two of its four parts (type,
spacing) and a *value swap under stable names* in the third (color), to avoid
a mechanical rename across every rule in a 2,900-line stylesheet that
currently reads `var(--accent)` etc. directly.

### 3.1 Color — named, with real hex values

Sci-fi here means dark-first (a HUD/viewfinder register fits a *scanner* app
literally, not just aesthetically), with a light palette that stays on-brand
rather than reverting to generic light-mode grey.

**Dark (primary):**

| Token | Name | Hex | Replaces |
|---|---|---|---|
| `--bg` | Void | `#0a0e14` | `#14141a` |
| `--surface` | Panel | `#10161f` | `#1e1e26` |
| `--surface-2` | Panel Raised | `#161d29` | `#262630` |
| `--surface-3` | Panel Deep | `#1c2532` | `#30303c` |
| `--border` | Hairline | `#26303f` | `#33333e` |
| `--text` | Phosphor | `#eef3f8` | `#f2f2f5` |
| `--text-muted` | Static | `#8291a8` | `#a3a3af` |
| `--accent` | Ion Cyan | `#34e2ff` | `#7f9cff` |
| `--accent-hover` | Ion Cyan Bright | `#6eecff` | `#a2b8ff` |
| `--accent-contrast` | (text on accent) | `#06222b` | `#101018` |
| `--success` | Verified Green | `#35e0a1` | `#4fd08c` |
| `--error` / `--danger` | Alert Red | `#ff4d6a` | `#ff6b6b` |
| `--warning` *(new)* | Hazard Amber | `#ffb020` | — |

**Light (secondary — kept genuinely usable outdoors, where this app is
often used to photograph a document in daylight):**

| Token | Hex | Replaces |
|---|---|---|
| `--bg` | `#f4f6f9` | `#f7f7f9` |
| `--surface` | `#ffffff` | unchanged |
| `--border` | `#d3dae3` | `#d9d9e0` |
| `--text` | `#10151d` | `#1a1a1f` |
| `--accent` | `#0091b3` (Signal Teal — darker than the dark-mode cyan on purpose; `#34e2ff` fails contrast on white) | `#3457d5` |
| `--success` | `#128a56` | close to today's `#1b8a5a` |
| `--error` / `--danger` | `#d02847` | `#c23434` |
| `--warning` *(new)* | `#b5720a` | — |

**New, additive — glass and glow.** This is the section that connects to the
liquid-glass item (see 3.5): a translucent surface token pair and a
focus/active glow, neither of which exist in `style.css` today.

```css
--surface-glass: rgba(16, 22, 31, 0.6);      /* dark; light uses rgba(255,255,255,0.6) */
--glass-blur: 20px;
--glass-saturate: 160%;
--glass-edge: rgba(255, 255, 255, 0.08);     /* top hairline highlight; light uses 0.5 alpha */
--glow-accent: 0 0 0 3px rgba(52, 226, 255, .25), 0 0 16px rgba(52, 226, 255, .35);
```

Used as `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`
on floating surfaces (the action sheet, command palette, radial menu, folder
picker) — nothing here needs a new CSP directive: `backdrop-filter` is a
rendering property, not a network fetch, so it's unaffected by `style-src
'self'`.

### 3.2 Type scale

Anchored to one real number already in the codebase — `--text-2xl` matches
the drop-zone icon's existing `2.25rem` (`style.css:789`) exactly, so this
isn't invented from nothing:

| Token | rem | px | Use |
|---|---|---|---|
| `--text-2xs` | 0.6875 | 11 | Badges, timestamps |
| `--text-xs` | 0.75 | 12 | Hints, captions |
| `--text-sm` | 0.8125 | 13 | Secondary buttons, filter chips |
| `--text-base` | 0.9375 | 15 | Body, inputs |
| `--text-md` | 1.0625 | 17 | Card titles, subheads |
| `--text-lg` | 1.25 | 20 | View titles |
| `--text-xl` | 1.625 | 26 | Empty-state titles |
| `--text-2xl` | 2.25 | 36 | Large glyphs/icons |

Plus one new, deliberately narrow addition: `--font-mono:
ui-monospace, "SF Mono", Menlo, Consolas, monospace` — **system fonts only,
no vendoring, no CSP change** — for the handful of places a technical
readout fits the sci-fi register better than prose: word confidence
percentages, the Coherence Filter tier name, PII masked text
(`scan-pii-list`), diagnostics output. This is a small, optional accent, not
a base-font change — body text stays on the existing system sans stack.

### 3.3 Spacing

Also net-new; a 4px base unit, 8 steps:

| Token | rem | px |
|---|---|---|
| `--space-1` | 0.25 | 4 |
| `--space-2` | 0.5 | 8 |
| `--space-3` | 0.75 | 12 |
| `--space-4` | 1 | 16 |
| `--space-5` | 1.5 | 24 |
| `--space-6` | 2 | 32 |
| `--space-7` | 3 | 48 |
| `--space-8` | 4 | 64 |

Recommend rolling this out incrementally — new/touched components adopt the
tokens; existing spacing isn't mass-refactored in one pass, both because
that's a large, purely-cosmetic diff and because it's the kind of change
likeliest to collide with whatever the other in-flight session is touching
right now.

### 3.4 Motion — through the existing contract, not around it

`style.css` already defines `--motion-fast` (120ms), `--motion-medium`
(200ms), `--motion-slow` (320ms), `--motion-bloom` (140ms), all zeroed under
one `prefers-reduced-motion: reduce` block, and `test/motion-contract.js`
actively asserts every `transition`/`animation` declaration in the file
either uses one of those four tokens, is `transition: none`, sits inside the
reduced-motion block itself, or is explicitly allowlisted by content (today's
one entry: the infinite `scan-spin` animation, which is *frozen* rather than
*calmed* by a zeroed duration, so it gets a substituted slower pulse instead
of a zeroed one — see `test/motion-contract.js:32-37,56-62`).

**Rule for anything new this redesign adds:** every sci-fi motion touch — a
glow pulse on focus, a scan-line sweep on a busy state, an entrance
transition on a glass panel — must express its duration as one of the four
existing `--motion-*` tokens. No new hardcoded millisecond literal may be
introduced; `test/motion-contract.js` will fail the build on one (it parses
`style.css` directly, not from a changelog of what's supposed to be true). If
a new *infinite* animation is added (the one case a zeroed duration actively
breaks rather than helps, per the file's own reasoning), it needs its own
entry in that file's `ALLOWLIST` array with a stated reason, exactly like
`scan-spin`'s — not a blanket exemption, one entry per animation, each
justified on its own.

No new duration tokens are proposed. Four is enough for fast/medium/slow plus
the one coupled special case (`--motion-bloom`, pinned to the radial menu's
own `CLOSE_TRANSITION_MS`); adding a fifth "sci-fi glow" duration would just
be a duplicate of one of the four with a different name.

### 3.5 The liquid-glass roadmap item

There's no internal document for this — confirmed there was never going to
be one. "Liquid glass" refers to Apple's own public design language
(introduced as "Liquid Glass" in iOS 26): blurred translucency, a specular
top edge, and a saturation boost on floating surfaces. §3.1's
`--surface-glass` / `--glass-blur` / `--glass-saturate` / `--glass-edge`
tokens are that recipe, reconstructed directly from the public design
language rather than from a repo source, and are treated here as correct and
complete. This section supersedes the roadmap item by giving it a concrete
token implementation rather than a name on a list.

---

## 4. Home-screen plan: what "similar to Notes" already means here

Before proposing changes, it's worth being exact about what's already true,
because more of it is true than a "make it similar to Notes" ask usually
implies has been done yet.

`js/library.js`'s own header comment, unprompted, already states the intent:

> "This is the Notes-app surface: a list of everything, sorted by recency
> with pinned items first, filtered by folder or tag, searched across full
> text, and with a Recently Deleted that actually holds things rather than
> pretending to." — `js/library.js:3-5`

Checked against Apple Notes' actual home screen, feature by feature, using
the inventory in §1.1:

| Notes.app | TextScanner today | Match? |
|---|---|---|
| Sidebar: Folders, smart lists | Sidebar: All/Notes/Scans, Folders, Tags | Structurally yes |
| Main pane: flat searchable list, pinned-first, recency-sorted | Same (`library.js:3-5`, confirmed in `cardMarkup`) | Yes |
| Full-text search including note body | Search reaches "titles, tags and scanned text" (`index.html:237`) | Yes |
| Swipe-to-delete / swipe-to-pin on a row | Implemented, same thresholds pattern (`library.js:499-573`) | Yes |
| Recently Deleted, time-limited retention | Implemented — 30-day retention stated in the UI (`library.js:248`) | Yes |
| List/Gallery view toggle | List/Grid toggle exists (`library-layout-btn`) | Yes, by name if not by visual polish |
| Long-press / right-click row actions | Radial menu (touch) + context menu (desktop), both present | Yes |

**So structurally, "similar to Notes" is largely already the case** — this
isn't a screen that needs to be rebuilt toward that model, it's one that was
already built toward it and needs closing the remaining gap between
*structural* parity and *visual/interaction* parity. Concretely, where Notes
and TextScanner still diverge:

- **Notes' Gallery view shows real page content as a thumbnail/cover**; a
  scan document's thumbnail is its first page image already (`library.js`'s
  thumbnail handling), so this may already be closer than it looks — I did
  not check the actual rendered grid-card visual, only the state machine
  behind it.
- **Notes' sidebar is a native, resizable, collapsible split view**;
  TextScanner's `#library-sidebar` is fixed-width markup with no resize/collapse
  affordance in what I read.
- **Every interaction inside a Notes document is direct manipulation** — there
  is no "enter edit mode" step anywhere in Notes. This is exactly the gap
  §2.3 is about, just scoped to the library screen's sibling (the editor), not
  the library screen itself, which is already gesture-first.

**Decision: scope this to a visual pass, not a structural one.** The
structural model above stays exactly as it is — same sidebar, same list,
same swipe/long-press/context-menu gestures, same folder-picker modal. What
changes is purely visual, under §3's tokens: a glass-treated sidebar,
glow-accented active states on the current filters, mono readouts on card
metadata (page counts, dates). Explicitly out of scope for this pass:

- **No resizable or collapsible sidebar.** `#library-sidebar` keeps its
  current fixed-width behavior.
- **No drag-and-drop between folders on the canvas.** Moving a document to a
  folder stays the existing folder-picker-modal flow (§1.1).
- **No new gallery-thumbnail system.** The grid layout keeps its current
  card, restyled under the token system, not rebuilt around new cover-art
  logic.

This follows the original scope directly: the home screen was meant to stay
close to what it already is, with the substantive redesign work landing on
scan and edit/annotate instead.

---

## 5. Consolidated open questions

Four of the original eight items are resolved as of this revision: §2.4/§2.5
(merge decided, skip-the-call gate moves with it), §3.5 (identified as
Apple's public design language, not a repo document), and §4 (scoped to a
visual pass, structural changes explicitly excluded). What's left still needs
a real decision from you, not a default made on your behalf:

1. **§0** — Does "edit/annotate" include the crop view or only the document view (note editor + scan-doc)? I assumed the latter.
2. **§2.1** — Menu-behind-one-button, or a visually-merged two-button segmented control, for Download?
3. **§2.2** — Whole-buffer paste (Text mode, destructive, needs a confirm) or positional paste (Image/Full modes, arm-then-place)? Or both, at different altitudes?
4. **§2.3** — Long-press-and-drag for both "move a word" and "start a marquee" is a real gesture-disambiguation risk (same starting gesture, disambiguated only by what's under the finger). Needs a hands-on prototype before being called settled.
