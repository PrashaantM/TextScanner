# Redesign plan — fixing "cumbersome"

## Where the cumbersome feeling actually comes from

Not from any single screen looking bad — the dark theme, spacing, and card
layout are all reasonably clean. It comes from three structural decisions that
compound on each other:

**1. The top nav mixes a destination ("Library") with two one-shot actions
("Scan", "Note") and presents all three as equal-weight tabs.** Covered in
detail with code citations in `01-UX-FINDINGS-AND-FIX-PLAN.md` §1.1-1.3 — the
short version is that "Scan" and "Note" aren't places you go, they're buttons
that immediately create a new document. Styling them like tabs is what makes
the nav feel unpredictable: the thing you tap doesn't do what its position in
the bar implies.

**2. The scan-result screen has two independent toggle rows that multiply into
nine states, with no guidance on what most of them mean.** `Raw / Filtered
Text / Coherence Filter` (a filter axis) crossed with `Text / Image format /
Full image` (a view axis) is a 3×3 grid, all visible at once, all equal
weight, on a screen a first-time user reaches maybe ninety seconds after
opening the app. "Filtered Text" and "Coherence Filter" in particular are
internal engineering vocabulary — they describe *how* the text was produced,
not what a user is trying to do. Nothing on screen explains the difference
before you've clicked into both and compared.

**3. Nothing in the flow tells you what just happened.** Selecting a sample
image quietly creates a document. Scanning text swaps a filter tab's content
with no transition. Deleting a card removes it with no undo toast. Individually
each of these is small; together they add up to an app that keeps doing things
without telling you, which is the actual definition of "feels cumbersome" as
opposed to "is missing a feature."

None of this requires rewriting the OCR pipeline, the editor, or the document
model — all three are solid and shouldn't be touched. This is entirely
navigation, labeling, and feedback.

## The proposed IA

**Top bar becomes: Library (home) · a single "+" action · Settings.**

Tapping "+" opens a small action sheet — "Scan a document" / "New note" —
instead of two permanently-lit buttons that fire on tap. This does two things
at once: it removes the tab-that-isn't-a-tab illusion (there's exactly one
navigational destination now, Library, and everything else is either "go
there" or "create something," never both at once), and it gives you a natural
place to fix the 1.1/1.2 eager-creation bug, since the sheet can hold the
"what am I creating" decision for a beat before any `createDocument()` call
happens.

```
Before                              After
┌────────────────────────────┐      ┌────────────────────────────┐
│ Library   [Scan]  [Note] ⚙ │      │ Library            [+]   ⚙ │
└────────────────────────────┘      └────────────────────────────┘
  ^ looks like 3 tabs,                 ^ one destination,
    2 of them silently create            one clearly-an-action button
    a document on tap
```

**The scan-result screen collapses from a 3×3 grid to one guided path.**
Default to showing **Text** view with plain extracted text. Offer "Clean up
this text" as a single button rather than exposing "Raw / Filtered / Coherence
Filter" as three permanently-visible tabs — most people scanning a poster or a
receipt want either the text as read, or the text cleaned up; they don't have
a mental model of "raw vs. filtered vs. coherence" as three distinct products,
and don't need one. **Image format** and **Full image** move to a secondary
"View on photo" toggle reached from the Text view, rather than sitting
alongside it as equally-weighted destinations — they're a specific, valuable,
somewhat advanced feature (editing words in place on the image) that most
scans won't need, and burying the primary "get my text" path under it is
backwards.

```
Before: everything visible at once, all equal weight
┌───────────────────────────────────────────────────┐
│ Filter:  Raw | Filtered Text | Coherence Filter    │
│ View:    Text | Image format | Full image          │
│ [extracted text or image editor, depending on both]│
└───────────────────────────────────────────────────┘

After: one primary path, secondary options one tap away
┌───────────────────────────────────────────────────┐
│ [extracted text]                                   │
│ [ Clean up this text ]   [ View on photo → ]       │
└───────────────────────────────────────────────────┘
```

This is a real design tradeoff, not a free win, and worth being upfront about:
power users who already understand the raw/filtered/coherence distinction lose
one tap of directness, since "Clean up this text" now has to resolve to
whichever tier `resolveTier()` picks rather than being chosen explicitly up
front. The fix is to make the tier choice visible *after* tapping "Clean up"
— which `coherence.js` already surfaces via `tierLabel()` — not to hide it
permanently. Nothing about the underlying data or API changes, only which
controls are visible by default versus one tap deeper.

**Feedback for actions that change data.** A toast on delete ("Deleted 'x'.
Undo"), and a brief non-blocking confirmation the first time a new document is
actually created from the "+" sheet, so a user always has a moment's signal
before or after something persists.

## What this does and doesn't touch, for the "don't regress anything" constraint

`ANALYSIS.md` §8.2 is explicit that the scan flow's element ids are a de facto
public interface — ten CI gates drive the app through them. This redesign
respects that boundary on purpose:

- **Untouched:** the OCR pipeline, `js/recognize.js`'s dispatch, the document
  model, `js/editorObjects.js`, the image-format renderer, all 68 ids
  `js/dom.js` resolves. The redesign is a rearrangement of which controls are
  visible/primary by default, not new functionality.
- **Changed, and needs matching test updates:** the nav bar markup (new "+"
  button and sheet, replacing two always-visible buttons — `index.html` nav
  section and its two click handlers in `js/app.js`), and which filter/view
  controls render by default on the scan-result screen (a CSS/JS visibility
  change, not a markup deletion — keep the existing elements and ids in the
  DOM so `js/dom.js` and the CI gates that click through `#coherence-panel`,
  `Image format`, etc. by id keep working; just don't show all nine
  combinations as equally-weighted top-level buttons).
- **New tests to add, not just old ones to keep green:** one asserting the
  "+" sheet doesn't call `createDocument()` until a real choice is made
  (ties directly to the fix in `01-UX-FINDINGS-AND-FIX-PLAN.md` §1.1/1.2),
  and one asserting the secondary "View on photo" path still reaches the
  existing Image format/Full image views and their existing ids.

## Suggested sequence

1. Ship the eager-document-creation fix (`01-UX-FINDINGS-AND-FIX-PLAN.md`
   §1.1/1.2) on its own first — it's valuable independent of any nav redesign
   and de-risks the bigger change.
2. Nav bar restructure (Library / + / Settings) — self-contained, testable in
   isolation, and it's the change most directly responsible for the
   "cumbersome" feeling.
3. Scan-result screen simplification — bigger surface area, touches more of
   the existing UI, do it once the nav change has proven the "keep old ids,
   change visibility/defaults" pattern works cleanly against the CI gates.
4. Toasts/confirmations last — pure addition, lowest risk, easiest to cut if
   you're short on time before a submission deadline.
