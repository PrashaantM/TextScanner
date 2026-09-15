// editorObjects.js: the editor's object model. Every recognized word and the
// background image is an "object" with geometry, text and sampled appearance,
// and this module owns creating them, styling them, selecting them, tracking
// which have been modified, and undo/redo over the lot.
//
// One of three files that used to be a single 1,400-line editor.js. The split
// follows the section boundaries that file was already banner-commented into,
// and the dependency direction is one-way by design:
//
//   editorInteractions.js  ->  this file   (gestures and modes act on objects)
//   editorExport.js        ->  this file   (reads objects out to text/canvas)
//
// with exactly one edge back the other way, registered rather than imported:
// clearImageFormatView has to reset editor mode, which lives in interactions.
// That's registerModeReset below, in the same hook-registration idiom the rest
// of this module already uses for inpainting and undo - keeping the import
// graph acyclic rather than making two modules import each other.
//
// The hook pattern is the architecture here, not incidental: this module never
// learns what inpainting is, what the filter levels mean, or how a deleted word
// is recreated. It calls a function somebody else registered.

import {
  selectionStatus,
  imageFormatView,
  imageFormatBg,
  resizeHandle,
  undoBtn,
  redoBtn,
  deleteBtn,
} from "./dom.js";
import { state, MAX_UNDO_STEPS, FONT_SIZE_CORRECTION, LOW_CONFIDENCE_THRESHOLD } from "./state.js";
import { largestFittingSize, INK_GRID_STEP_PX } from "./inkFit.js";
import { wordPasses } from "./filter.js";

// ---- Object lookup ----
//
// The array is still the source of truth for order (reading order matters for
// text extraction), but every lookup went through state.editorObjects.find(),
// which is linear - and the hot paths do it per pointer-move, per word, on
// images with hundreds of objects. These two indexes are maintained alongside
// the array by the functions below, which are the only places it is mutated.
const objectsById = new Map();
const objectsByElement = new Map();

export function getObjectById(id) {
  return objectsById.get(id) || null;
}

// Used by every event handler that starts from a DOM node and needs the object
// behind it, which was the most frequent linear scan of all.
export function getObjectByElement(el) {
  return objectsByElement.get(el) || null;
}

export function addEditorObject(obj) {
  state.editorObjects.push(obj);
  objectsById.set(obj.id, obj);
  if (obj.el) objectsByElement.set(obj.el, obj);
  return obj;
}

export function removeEditorObject(obj) {
  state.editorObjects = state.editorObjects.filter((o) => o.id !== obj.id);
  objectsById.delete(obj.id);
  if (obj.el) objectsByElement.delete(obj.el);
}

export function resetEditorObjects() {
  state.editorObjects = [];
  objectsById.clear();
  objectsByElement.clear();
}

// ---- Mode reset hook ----
//
// The single dependency this module has on editorInteractions.js, registered
// instead of imported so the two files don't have to import each other.
// clearImageFormatView must leave Move-components mode, and that mode belongs
// to interactions.
let onResetModes = null;

export function registerModeReset(fn) {
  onResetModes = fn;
}

// Exported for editorInteractions.js's resize bounds.
export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Keep at least a sliver of an object within the container while dragging, without
// pinning full-bleed objects (like a background image at 100% size) in place.

const MIN_VISIBLE_PCT = 5;

// Exported for editorInteractions.js's drag and add-text paths, which are the
// only things that position an object.
export function clampPosition(value, size) {
  return clamp(value, MIN_VISIBLE_PCT - size, 100 - MIN_VISIBLE_PCT);
}

// Resize bounds (beginResize) - object width/height and word font size are
// all expressed as %-of-image-dimension, matching editorObjects' existing
// unit convention.

export function show(el) {
  el.classList.remove("hidden");
}

export function hide(el) {
  el.classList.add("hidden");
  // Harmless no-op for the many elements show()/hide() manage that never carry
  // `is-visible` (see revealFlowPanel below); for one that does, this resets it
  // so the next reveal actually transitions in rather than popping straight to
  // its already-`is-visible` end state.
  el.classList.remove("is-visible");
}

// Phase 17: fade+lift reveal for any element with the `.flow-panel` CSS class,
// paired with plain hide() (immediately, not a delayed opposite of this
// function) to conceal it. That asymmetry is deliberate, not an oversight:
// every one of this app's panel swaps (progress -> results, Text -> Image
// format, ...) is two flex-column siblings changing state in the same tick -
// a delayed hide would leave the outgoing one fading out while the incoming
// one simultaneously fades in, and since neither is absolutely positioned,
// both being un-hidden at once briefly doubles the page's height, then jumps
// again once the outgoing one finishes. Reveal still gets the real motion
// treatment, since a new view sliding smoothly into place is the half of this
// pattern that actually reads as "continuous" - a panel disappearing
// instantly, with nothing else moving into its place at that exact instant,
// isn't the jarring part.
export function revealFlowPanel(el) {
  el.classList.remove("hidden");
  void el.offsetWidth; // force layout so the hidden state registers before is-visible transitions from it
  el.classList.add("is-visible");
}

// Shared by any button group that reflects a single active selection (mode
// tabs here, filter-level tabs in main.js): toggles is-active/aria-pressed
// across the group based on whichever button matchFn identifies as current.

export function setActiveButton(buttons, matchFn) {
  buttons.forEach((btn) => {
    const isActive = matchFn(btn);
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

// ---- Selection ----

export function clearSelection() {
  state.selectedObjectIds.clear();
  updateSelectionVisuals();
}

export function toggleSelection(id) {
  if (state.selectedObjectIds.has(id)) {
    state.selectedObjectIds.delete(id);
  } else {
    state.selectedObjectIds.add(id);
  }
  updateSelectionVisuals();
}

export function updateSelectionVisuals() {
  state.editorObjects.forEach((obj) => {
    const selected = state.selectedObjectIds.has(obj.id);
    obj.el.classList.toggle("is-selected", selected);
    // Selection was a class and an outline - nothing an assistive technology
    // could read.
    if (obj.type === "word") obj.el.setAttribute("aria-selected", String(selected));
  });
  updateResizeHandle();
  updateDeleteButton();
  announceSelection();
}

// Announces the selection count into the live region. Only on CHANGE: a
// marquee drag updates the selection on every pointer-move, and re-announcing
// the same count dozens of times a second would make a screen reader unusable.
let lastAnnouncedCount = null;

function announceSelection() {
  if (!selectionStatus) return;
  const count = state.selectedObjectIds.size;
  if (count === lastAnnouncedCount) return;
  lastAnnouncedCount = count;
  if (count === 0) {
    selectionStatus.textContent = "Nothing selected";
    return;
  }
  if (count === 1) {
    const obj = getObjectById([...state.selectedObjectIds][0]);
    selectionStatus.textContent = obj ? `Selected: ${describeWordObject(obj)}` : "1 item selected";
    return;
  }
  selectionStatus.textContent = `${count} items selected`;
}

// A word's accessible name: what it says, roughly where it is, and any state
// that is otherwise conveyed only by colour or opacity. Position is given in
// plain words rather than percentages, since "top left" is what a person needs
// and "x 12.4%" is not.
export function describeWordObject(obj) {
  if (obj.type === "image") return "Background image";
  const vertical = obj.y < 33 ? "top" : obj.y < 66 ? "middle" : "bottom";
  const horizontal = obj.x < 33 ? "left" : obj.x < 66 ? "centre" : "right";
  const text = obj.el.textContent.trim();
  const parts = [text ? `"${text}"` : "empty text box", `${vertical} ${horizontal}`];
  if (obj.el.classList.contains("is-filtered-out")) parts.push("hidden by the current filter");
  if (obj.modified) parts.push("edited");
  if (obj.confidence != null && obj.confidence < LOW_CONFIDENCE_THRESHOLD) parts.push("low confidence, worth checking");
  // The dashed outline says this in the visual channel; this is the same thing
  // said in the one a screen reader can hear, for the same reason the
  // low-confidence underline is mirrored here.
  if (obj.probablyNotText) parts.push("may not be text, deleting this paints over the photo");
  return parts.join(", ");
}

// Keeps each word's accessible name in step with its text, position and state.
// Called from refreshModifiedStatesFor, which already runs whenever any of the
// three can have changed.
function updateWordLabel(obj) {
  if (obj.type !== "word") return;
  obj.el.setAttribute("aria-label", describeWordObject(obj));
}

export function objectsFromSelection() {
  return state.editorObjects.filter((obj) => state.selectedObjectIds.has(obj.id));
}

export function updateResizeHandle() {
  if (state.fullEditorMode && state.selectedObjectIds.size === 1) {
    const obj = getObjectById([...state.selectedObjectIds][0]);
    if (!obj) {
      resizeHandle.style.display = "none";
      return;
    }
    resizeHandle.style.left = `${obj.x + obj.w}%`;
    resizeHandle.style.top = `${obj.y + obj.h}%`;
    resizeHandle.style.display = "block";
  } else {
    resizeHandle.style.display = "none";
  }
}

// Exported so editorInteractions.js's mode toggles can keep the Delete button
// in step; enabling it depends on editor mode, which lives over there.
export function updateDeleteButton() {
  if (!deleteBtn) return;
  deleteBtn.disabled = !(state.fullEditorMode && state.selectedObjectIds.size > 0);
}

// ---- Undo / redo ----
//
// A snapshot is a full copy of editorObjects' persisted fields (id, type, origin,
// geometry, text). restoreSnapshot() reconciles the live editorObjects array
// against a snapshot by id: objects present in both are updated in place, objects
// only in the snapshot are recreated (they were deleted since), and objects only
// live (not in the snapshot) are removed (they were added since). This single
// mechanism covers moves, resizes, text edits, and object add/remove uniformly.

let createElementForSnapshot = null; // set via setSnapshotObjectFactory by editorObjects.js callers

let onObjectRemoved = null;

// Phase 2/4 wire these in so undo/redo can recreate deleted words and clean up
// removed ones without editor.js needing to know about inpainting/patch details.

export function configureUndoHooks({ createFromSnapshot, onRemoved }) {
  createElementForSnapshot = createFromSnapshot;
  onObjectRemoved = onRemoved;
}

export function snapshotState() {
  return state.editorObjects.map((obj) => ({
    id: obj.id,
    type: obj.type,
    origin: obj.origin,
    x: obj.x,
    y: obj.y,
    w: obj.w,
    h: obj.h,
    fontSizePct: obj.fontSizePct,
    fontSizeLocked: !!obj.fontSizeLocked,
    rotationDeg: obj.rotationDeg,
    removed: !!obj.removed,
    text: obj.type === "word" ? obj.el.textContent : undefined,
  }));
}

// ---- Retiring an emptied OCR word ----
//
// Deleting an OCR word only CLEARS its text, because the inpainted patch behind
// it is what hides the original pixels and that patch belongs to this object -
// take the object away and the photo's own text comes back, in the view and in
// the exported PNG. So the emptied span stayed, and stayed selectable: a
// zero-height strip that still caught taps, still drew selection chrome, still
// enabled the Delete button, and did nothing when it was pressed. That is the
// "empty components remain and can't be deleted" report.
//
// Retiring is the delete the user is actually asking for: the span stops
// existing as far as pointer, focus, marquee and keyboard are concerned, while
// the patch and the object stay so the deletion itself holds. `display: none`
// is doing the work rather than a DOM removal, so undo is one class away and
// obj.el never has to be re-attached.
export function setWordRemoved(obj, removed) {
  if (obj.type !== "word") return;
  obj.removed = !!removed;
  obj.el.classList.toggle("is-removed", obj.removed);
  if (obj.removed) state.selectedObjectIds.delete(obj.id);
}

export function restoreSnapshot(snapshot) {
  const snapshotIds = new Set(snapshot.map((s) => s.id));

  // Remove objects that exist now but not in the snapshot (added after it was taken).
  state.editorObjects
    .filter((obj) => !snapshotIds.has(obj.id) && obj.type !== "image")
    .forEach((obj) => {
      obj.el.remove();
      if (obj.patchEl) obj.patchEl.remove();
      if (onObjectRemoved) onObjectRemoved(obj);
      state.selectedObjectIds.delete(obj.id);
      removeEditorObject(obj);
    });

  snapshot.forEach((s) => {
    let obj = getObjectById(s.id);
    if (!obj && s.type === "word" && createElementForSnapshot) {
      obj = createElementForSnapshot(s);
      if (obj) addEditorObject(obj);
    }
    if (!obj) return;
    obj.x = s.x;
    obj.y = s.y;
    obj.w = s.w;
    obj.h = s.h;
    if (s.fontSizePct != null) obj.fontSizePct = s.fontSizePct;
    if (s.fontSizeLocked != null) obj.fontSizeLocked = s.fontSizeLocked;
    if (s.rotationDeg != null) obj.rotationDeg = s.rotationDeg;
    if (obj.type === "word" && s.text != null && obj.el.textContent !== s.text) {
      obj.el.textContent = s.text;
    }
    // Retirement is undoable like any other edit - without this, Undo after
    // "delete the empty leftover" would restore the text into a span still
    // hidden by .is-removed.
    if (obj.type === "word") setWordRemoved(obj, s.removed);
    applyObjectStyle(obj);
  });

  updateResizeHandle();
  refreshModifiedStates();
  updateSelectionVisuals();
}

export function pushUndo(preChangeSnapshot) {
  state.undoStack.push(preChangeSnapshot);
  if (state.undoStack.length > MAX_UNDO_STEPS) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoButtons();
}

export function updateUndoRedoButtons() {
  undoBtn.disabled = state.undoStack.length === 0;
  redoBtn.disabled = state.redoStack.length === 0;
}

undoBtn.addEventListener("click", () => {
  if (!state.undoStack.length) return;
  const current = snapshotState();
  const previous = state.undoStack.pop();
  state.redoStack.push(current);
  restoreSnapshot(previous);
  updateUndoRedoButtons();
});

redoBtn.addEventListener("click", () => {
  if (!state.redoStack.length) return;
  const current = snapshotState();
  const next = state.redoStack.pop();
  state.undoStack.push(current);
  restoreSnapshot(next);
  updateUndoRedoButtons();
});

// ---- Delete (Phase 2/4): remove/clear the current selection ----

let deleteHandler = null;
// Wired by main.js once inpainting/add-text logic exists, so editor.js's keyboard
// and button handling can stay generic over "delete the current selection."

export function setDeleteHandler(fn) {
  deleteHandler = fn;
}

function performDelete() {
  if (!state.fullEditorMode || state.selectedObjectIds.size === 0) return;
  if (deleteHandler) deleteHandler(objectsFromSelection());
}

if (deleteBtn) deleteBtn.addEventListener("click", performDelete);

document.addEventListener("keydown", (e) => {
  if ((state.activeMode === "image" || state.activeMode === "full") && e.key === "Escape") {
    clearSelection();
    return;
  }
  if (!state.fullEditorMode) return;
  if ((e.key === "Delete" || e.key === "Backspace") && state.selectedObjectIds.size > 0 && deleteHandler) {
    const active = document.activeElement;
    const editingText = active && active.isContentEditable;
    if (editingText) return; // let normal text editing handle Delete/Backspace
    e.preventDefault();
    performDelete();
    return;
  }
  const key = e.key.toLowerCase();
  const withMeta = e.ctrlKey || e.metaKey;
  if (withMeta && key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoBtn.click();
  } else if (withMeta && (key === "y" || (key === "z" && e.shiftKey))) {
    e.preventDefault();
    redoBtn.click();
  }
});

// ---- Rendering objects (words + background image) ----

// ---- "This region is probably not text" ----
//
// OCR does not know what a logo is. A map-pin icon, a decorative rule, a
// separator dash - it reads them as words, they become editable word objects
// like any other, and deleting one runs the inpainter over that part of the
// photo. Someone tidying up a stray character can paint over a company mark
// without ever being told that is what they were about to do.
//
// CONFIDENCE CANNOT DECIDE THIS, and that is measured, not assumed. On
// complexPic1 the map-pin icon comes back at confidence 89, while real text
// "&" scores 51 and a misread "GOOD" scores 44. Any confidence threshold that
// catches the pin throws away more real words than it saves, and one that
// spares the real words never sees the pin. The signal is the wrong shape.
//
// Geometry does decide it. A glyph that is really an icon is WIDE for how few
// characters OCR got out of it, and BIG relative to the text around it. Both
// halves are needed, and both are relative to the image rather than absolute,
// because "big" on a poster and "big" on a receipt are different numbers:
//
//   - at most 2 characters, and
//   - more than 1.8x the image's median width-per-character, and
//   - a glyph box more than 1.4x the image's median glyph height.
//
// Measured over five corpus images (regions flagged / total):
//
//   complexPic1   1/18   (5.6%)  - exactly the map pin, at confidence 89
//   complexPic5   0/115  (0%)
//   complexPic8   1/108  (0.9%)
//   complexPic3  27/556  (4.9%)  - separator rules; 130 without the height term
//   complexPic2  12/75   (16%)   - separators, a (c) mark
//
// WHICH IS WHY THIS ONLY WARNS. 16% is far too high to suppress on: a silent
// filter would quietly drop real words out of Copy, Download and text-to-speech
// to fix a rarer problem than the one it caused. So every flagged region stays a
// fully editable word, appears in the extracted text, and reads aloud. The flag
// buys exactly two things: a visible affordance (.is-probably-not-text, next to
// the existing low-confidence underline) and a confirm in front of the one
// action that destroys pixels. See test/not-text-warning.js.
//
// Scored once, from what the engine reported, and never rescored: this is a
// property of the REGION the photo contained, not of whatever the user has since
// typed into it. A flag that flickered as someone typed would be worse than no
// flag at all.

const NOT_TEXT_MAX_CHARS = 2;
const NOT_TEXT_MIN_WIDTH_PER_CHAR_RATIO = 1.8;
const NOT_TEXT_MIN_HEIGHT_RATIO = 1.4;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Flags the regions of one rendered image. Called once, after every word object
// exists, because both thresholds are medians over the whole image.
export function scoreRegionsForNotText(objects) {
  const words = objects.filter(
    (obj) => obj.type === "word" && obj.origin === "ocr" && obj.notTextMetrics
  );
  const widthsPerChar = median(words.map((obj) => obj.notTextMetrics.widthPerChar));
  const heights = median(words.map((obj) => obj.notTextMetrics.height));
  if (!widthsPerChar || !heights) return;

  words.forEach((obj) => {
    const m = obj.notTextMetrics;
    obj.probablyNotText =
      m.chars > 0 &&
      m.chars <= NOT_TEXT_MAX_CHARS &&
      m.widthPerChar > widthsPerChar * NOT_TEXT_MIN_WIDTH_PER_CHAR_RATIO &&
      m.height > heights * NOT_TEXT_MIN_HEIGHT_RATIO;
    obj.el.classList.toggle("is-probably-not-text", obj.probablyNotText);
    if (obj.probablyNotText) {
      // Sits alongside the low-confidence title rather than replacing it; a
      // region can be both, and the two say different things.
      const existing = obj.el.title ? obj.el.title + "\n\n" : "";
      obj.el.title = `${existing}This may not be text - it could be a logo, an icon or a decorative mark that was read as a word. Deleting it paints over that part of the photo.`;
    }
  });
}

// The one sentence the confirm shows. Kept here, next to the rule it describes,
// so the wording and the thing being warned about cannot drift apart.
export function describeNotTextWarning(objects) {
  const flagged = objects.filter((obj) => obj.probablyNotText && obj.el.textContent !== "");
  if (!flagged.length) return null;
  const names = flagged.map((obj) => `\u201c${obj.originalText || obj.el.textContent}\u201d`);
  const subject =
    flagged.length === 1
      ? `${names[0]} may not be text`
      : `${names.slice(0, 3).join(", ")}${flagged.length > 3 ? ` and ${flagged.length - 3} more` : ""} may not be text`;
  return (
    `${subject} - ${flagged.length === 1 ? "it could be" : "they could be"} a logo, an icon or a decorative mark that was read as ` +
    `${flagged.length === 1 ? "a word" : "words"}.\n\n` +
    `Deleting ${flagged.length === 1 ? "it" : "them"} paints reconstructed background over that part of the photo. ` +
    `Undo will bring ${flagged.length === 1 ? "it" : "them"} back.\n\n` +
    `Delete anyway?`
  );
}

// ---- Sizing a replacement word to the ink it replaces ----
//
// A replacement word should occupy the same height on the page as the text it
// stands in for. It did not: measured over complexPic1, every replacement
// rendered at 0.58x the height of the source word, tightly clustered (0.567 to
// 0.603 across 18 words), and the same 0.58 shows up on complexPic5. That is
// not noise, it is arithmetic:
//
//   font-size := bboxHeight * FONT_SIZE_CORRECTION   (0.8)
//   rendered cap height := font-size * capHeightPerEm  (~0.72 for this stack)
//   => rendered ink := 0.8 * 0.72 * bboxHeight = 0.576 * bboxHeight
//
// FONT_SIZE_CORRECTION exists because a bbox height used RAW as a font-size
// renders too big - true, and its comment says so. But the fix was a single
// constant applied to every word, and the right factor is not a constant: it
// depends on which glyphs the word actually contains. An all-caps word's bbox
// is its cap height; "energy" spans ascender to descender; "meow" is only
// x-height. One number cannot serve all three, so it is wrong for all three.
//
// So measure instead of guessing. The browser will tell us exactly how tall a
// given string renders in a given font. The result needs no magic number,
// adapts to whatever the font stack resolves to on the device, and - because it
// is driven by the CURRENT text - re-derives when the user retypes a word,
// which is the half the constant could never do.
//
// Falls back to FONT_SIZE_CORRECTION when the measurement is unavailable
// (no canvas, or a browser without actualBoundingBox* on TextMetrics), so the
// old behaviour is the floor rather than a crash.
//
// ---- ONE MEASUREMENT DOES NOT ANSWER EVERY SIZE ----
//
// That measurement used to be taken once, at a 100px reference, and scaled to
// whatever size was wanted - on the assumption that a face's ink per em is the
// same at every size, so one measurement answers all of them. It is not, and
// measurably so. The stack starts with -apple-system, which on macOS
// resolves to `.SF NS` - a VARIABLE font carrying an optical-size axis. The
// browser is not scaling one outline, it is interpolating a different outline
// at every size, and small sizes are deliberately drawn wider and taller so
// they stay legible. Measured in Chromium, per-em ink for "energy":
//
//     font-size   100px    30px     20px     16px     12px     8px
//     height      0.6982   0.6982   0.7157   0.7212   0.7212   0.7212
//     width       2.8701   2.9492   3.0216   3.1274   3.2446   3.3989
//
// Height moves 3.3% and WIDTH moves 18.4% between the reference size and the
// ten-pixel type a photo of a screen is full of. A word sized from the 100px
// figure therefore renders bigger than the arithmetic predicted, and the error
// grows as the word gets smaller - so small replacements systematically
// overshoot. Width is also the dimension that decides whether a word spills or
// gets held at the floor below, so the larger of the two errors lands exactly
// where it does the most damage.
//
// The figure has to be the one that holds AT THE SIZE THE WORD ACTUALLY RENDERS
// AT. That much was right. What was WRONG was the next step: solving for it by
// fixed-point iteration, size := target / perEm(size), which assumes ink is a
// continuous function of size.
//
// It is continuous on `.SF NS`, and on almost nothing else. Every hinted static
// face grid-fits ink to whole pixels, so the quantity being solved against is a
// STAIRCASE: for most targets no size renders the wanted ink at all, the
// iteration has nothing to converge to, and it oscillates. Liberation Sans -
// which is what CI actually resolves - swings 6.8% per em across five pixels of
// size and skips ink values entirely; DejaVu Sans swings 9.06% and is
// NON-MONOTONIC. That is not an edge case; `.SF NS` is the edge case, and
// developing against it is how this shipped red.
//
// So the size is no longer solved for, it is SEARCHED for: the largest size
// whose ink still fits. js/inkFit.js does that, is pure, and is tested against
// synthetic staircase and non-monotonic metrics in test/unit/ink-fit.test.js
// rather than against whichever faces this machine happens to have.

const INK_REF_FONT_PX = 100;

// A measurement size is rounded to the solver's own grid before it is taken, so
// the sizes that CAN be measured and the sizes that CAN be chosen are the same
// set. They have to be: the search below asks "does this size fit", and a
// measurement taken at a slightly different size than the one that gets
// rendered would answer a question about a size nobody uses.
const INK_SIZE_QUANTUM = INK_GRID_STEP_PX;

// The search is bounded by these rather than by nothing. Below 1px nothing is
// legible and the browser floors the used size anyway; above 2048 no word in a
// photograph belongs. Bisecting this range on the grid costs ~16 measurements.
const INK_MIN_FONT_PX = 1;
const INK_MAX_FONT_PX = 2048;

// Keyed by the string AND the size it was measured at, because - per the table
// above - the per-em figure is a function of both. Keying it on the string
// alone is what made every size share one wrong answer. Bounded by (words in
// one image x passes) and cleared with the view.
const inkPerEmCache = new Map();
let inkMeasureCtx;

function inkMeasureContext() {
  if (inkMeasureCtx === undefined) {
    try {
      inkMeasureCtx = document.createElement("canvas").getContext("2d") || null;
    } catch {
      inkMeasureCtx = null;
    }
  }
  return inkMeasureCtx;
}

function quantizeInkSize(px) {
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.max(INK_SIZE_QUANTUM, Math.round(px / INK_SIZE_QUANTUM) * INK_SIZE_QUANTUM);
}

// Resolved from the live editor surface, which the word spans inherit from, so
// the measurement is of the font the browser will actually paint rather than a
// stack copied into a second place that can drift out of step with the CSS.
//
// RE-RESOLVED on every sizing pass rather than resolved once and kept for the
// module's lifetime, and that is a deliberate reversal of what this did before.
// The cached version was the same shape as bug X3 - read once, trusted forever
// - and it cannot be justified here: the stack is inherited from :root, so any
// restyle of the document changes it and nothing in this module would ever
// learn. Re-reading costs one getComputedStyle per word sized, against a
// per-word cost that already reads the image's pixels twice. When the stack
// does change, every figure in the cache was measured against the old one, so
// the cache goes with it.
//
// What re-resolving does NOT cover is the same stack resolving to a different
// FACE - a webfont arriving after the first measurement. Until the condensed-
// source detector this could not happen: the app declared no @font-face and
// loaded no font resource, so every family in the stack was either present on
// the platform at load or never. It added exactly one @font-face (the
// condensed replacement font,
// see style.css and detectCondensedSource) - but every caller that applies
// its class (renderImageFormatView) does so only after confirming
// document.fonts.check() is already true, so by the time this function can
// possibly be called against that class, the face it resolves to is loaded,
// not still arriving. The invariant is narrower now, not gone.
let inkFontFamily = null;

// Exported for buildResultCanvas (editorExport.js), which used to carry a
// second, hardcoded copy of this same stack string - the two happened to
// agree only because nobody had a reason to change one without the other.
// Reading the live resolution here instead means the export canvas draws in
// whatever face the preview actually resolved to (condensed or not) by
// construction, not by two authors remembering to keep two strings in sync.
export function wordFontFamily() {
  const family = getComputedStyle(imageFormatView).fontFamily || "sans-serif";
  if (family !== inkFontFamily) {
    if (inkFontFamily !== null) inkPerEmCache.clear();
    inkFontFamily = family;
  }
  return family;
}

// The CSS-pixel width of the box a word's `cqw` font-size resolves against:
// #image-format-view's CONTENT box, which `container-type: inline-size` makes
// the query container.
//
// Words are sized DURING THE SCAN, while the app is still showing the text
// view - and at that point neither this element nor #result-section around it
// has been revealed, so both report a clientWidth of 0. The common case is the
// one where the element cannot measure itself, which is why this walks out to
// the first ancestor the browser HAS laid out and takes the edges back off.
//
// That walk is sound because every element on the path is a full-width
// border-box block (box-sizing: border-box is global, style.css:149), so each
// one's border box is its parent's content box: the view's content width is the
// laid-out ancestor's content width less the border and padding of everything
// between. Checked against the real value at two viewport widths - a 1200px
// viewport predicts 998 and measures 998; 390px predicts 359 and measures 359.
//
// If that ever stops holding the cost is bounded rather than silent: an
// estimate wrong by a factor k moves the per-em figure by roughly 0.2 * ln(k),
// so even a 20% error in the width costs about 4% in the metric.
function editorContentWidth() {
  let inset = 0;
  for (let el = imageFormatView; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    // getBoundingClientRect, NOT clientWidth. clientWidth is an integer, and
    // `cqw` resolves against the real, fractional layout width - so on a phone
    // the two disagree by up to half a pixel in ~359, which is 0.14%. That is
    // larger than the grid the size is chosen on, so the browser ends up
    // rendering at a size the solver never evaluated, and the word can spill by
    // the difference. Measured: two words over their box after a rotate, and
    // every size 0.01-0.02px off the grid. Fractional in, fractional out.
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) return Math.max(rect.width - border - padding - inset, 0);
    inset += padding + border;
  }
  return 0;
}

// Source-image pixels -> the CSS pixels the browser actually paints them at.
// Everything in this section works in source-image pixels, because that is the
// unit the OCR box arrives in, but the font size the renderer resolves is
// `fontSizePct` of the container's width - so a word whose fit is 12 image
// pixels is painted at 12 * scale CSS pixels, and THAT is the size its metrics
// have to be read at.
//
// Falls back to 1 when neither box can be measured (a detached document, a
// non-browser host). The fallback is not free, but it is bounded and small:
// getting the scale wrong by a factor k costs about 0.12 * ln(k) in the metric,
// so even a 2x error costs 8%, against the 18% the reference-size measurement
// was already costing.
function inkRenderScale(naturalWidth) {
  if (!naturalWidth) return 1;
  const width = editorContentWidth();
  return width > 0 ? width / naturalWidth : 1;
}

// How tall and wide `text` renders, per 1px of font-size, WHEN SET AT `fontPx`.
// Nulls when it cannot be measured. `family` is passed in by callers that have
// already resolved it, so sizing one word costs one getComputedStyle rather
// than one per measurement pass.
export function inkMetricsPerEm(text, fontPx = INK_REF_FONT_PX, family = null) {
  // Resolved before the cache lookup and never after: wordFontFamily() is what
  // notices the stack changing and empties the cache, so a lookup that ran
  // first could return a figure measured against the stack that just went away.
  const resolved = family || wordFontFamily();
  const px = quantizeInkSize(fontPx);
  if (!px) return null;
  const key = `${px} ${text}`;
  if (inkPerEmCache.has(key)) return inkPerEmCache.get(key);
  let metrics = null;
  const ctx = inkMeasureContext();
  if (ctx) {
    ctx.font = `${px}px ${resolved}`;
    const m = ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent;
    const descent = m.actualBoundingBoxDescent;
    if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0 && m.width > 0) {
      metrics = { height: (ascent + descent) / px, width: m.width / px };
    }
  }
  inkPerEmCache.set(key, metrics);
  return metrics;
}

// Height alone is not the target, and the reason is worth stating because it
// was tried first and measured: sizing purely to match ink height puts the
// replacement at exactly the right height (1.015x measured, against 0.581x
// before) and simultaneously makes it 1.5x to 1.8x too WIDE on a poster set in
// a condensed display face, so neighbouring words collide and the last word on
// a line runs off the image. That is worse than the bug.
//
// The reason a replacement can't have both is that it is set in the app's font,
// not the photo's - which is the font matcher that does not exist yet, and is
// deliberately out of scope. Until it does, the honest target is the one that
// holds regardless of which face the photo used: occupy the space the original
// word occupied. So take the smaller of the two fits.
//
// The floor keeps that from turning into its own absurdity. A replacement much
// longer than the original would otherwise shrink without limit to stay inside
// a short word's box; below half the height-matched size it stops shrinking and
// is allowed to overflow instead, because unreadable-but-contained is not a
// better answer than readable-but-wide.
//
// Exported because the floor is RELATIVE - half of whatever the height-matched
// size came out at - and a caller that wants to know whether a word is sitting
// on it has no way to re-derive that from the outside. See inkFitPx.
export const MIN_WIDTH_FIT_SCALE = 0.5;

// The fit for `text` inside a source ink box, in source-image pixels, plus the
// two facts that cannot be recovered from the answer alone: whether the width
// floor is what chose it, and whether anything fit at all.
//
// The search runs in CSS pixels, not image pixels, because CSS pixels are where
// the browser grid-fits the ink - that is the unit the staircase has treads in.
// The source box arrives in image pixels, so both ends convert through the
// render scale.
//
// Exported for test/replacement-size.js, which has to exempt a floor-sized word
// from its spill assertion. That gate used to recognise the floor with an
// ABSOLUTE threshold on rendered height - "0.5 of the source box, give or take"
// - while this code applies the floor RELATIVELY, against the height-matched
// size. Those two agree only if the per-em metric is constant across a 2x
// change of size, which the tables above show it is not, so the gate reported a
// spill failure on a word this code had floored exactly right. Handing out the
// predicate makes the gate ask this module's question instead of a similar-
// looking one of its own.
// The search itself, parameterized by `scale` rather than deriving it from the
// live editor surface - inkFitPx below is the on-screen caller (scale =
// editorContentWidth()/naturalWidth, re-read live so it tracks the container);
// buildResultCanvas (editorExport.js) is the other one, with scale = 1, because
// the export canvas is drawn at natural resolution - one canvas unit already IS
// one source-image pixel there, so no conversion is needed and none should be
// applied.
//
// That split exists because `scale` is NOT a property of the word, it is a
// property of WHICH SURFACE is about to render it, and the two surfaces are
// different absolute pixel scales almost always (a phone-width preview vs. a
// multi-thousand-pixel photo). Ink-per-em is a staircase in ABSOLUTE size (see
// this module's header), so a percentage solved to fit at one absolute scale is
// not thereby fit at another - measured, on complexPic5, retyped words that
// pass P1 in the preview still spill the export canvas with no resize involved
// at all, because "no resize" only holds the PREVIEW's scale fixed, not the
// export's.
export function inkFitPxAtScale(text, inkHeightPx, inkWidthPx, scale) {
  if (!inkHeightPx || !scale) return null;
  const family = wordFontFamily();
  const inkAt = (dimension) => (cssPx) => {
    const m = inkMetricsPerEm(text, cssPx, family);
    return m ? m[dimension] * cssPx : NaN;
  };
  const bounds = { minPx: INK_MIN_FONT_PX, maxPx: INK_MAX_FONT_PX };
  const height = largestFittingSize(inkHeightPx * scale, inkAt("height"), bounds);
  if (!height) return null;
  const width = inkWidthPx ? largestFittingSize(inkWidthPx * scale, inkAt("width"), bounds) : null;

  const heightFitPx = height.px / scale;
  const widthFitPx = width ? width.px / scale : null;
  const flooredByWidth = widthFitPx !== null && widthFitPx < heightFitPx * MIN_WIDTH_FIT_SCALE;
  const fitPx =
    widthFitPx === null ? heightFitPx : Math.max(Math.min(heightFitPx, widthFitPx), heightFitPx * MIN_WIDTH_FIT_SCALE);
  return {
    heightFitPx,
    widthFitPx,
    fitPx,
    flooredByWidth,
    renderScale: scale,
    // False when the source box is smaller than the smallest ink the face can
    // render - a two-pixel OCR box. The word still gets a size, but nothing
    // about it fits, and a caller that cannot tell this apart from success will
    // report the overflow as a sizing bug.
    heightFits: height.fits,
    widthFits: width ? width.fits : null,
  };
}

export function inkFitPx(text, inkHeightPx, inkWidthPx, naturalWidth) {
  if (!naturalWidth || !inkHeightPx) return null;
  return inkFitPxAtScale(text, inkHeightPx, inkWidthPx, inkRenderScale(naturalWidth));
}

export function fontSizePctForInk(text, inkHeightPx, inkWidthPx, naturalWidth) {
  if (!naturalWidth || !inkHeightPx) return 0;
  const fit = inkFitPx(text, inkHeightPx, inkWidthPx, naturalWidth);
  if (!fit) return (inkHeightPx / naturalWidth) * 100 * FONT_SIZE_CORRECTION;
  return (fit.fitPx / naturalWidth) * 100;
}

// Re-derives a word's font size from its CURRENT text, so a retyped word fills
// the space the word it replaced filled, instead of keeping a size derived from
// the glyph mix of whatever was recognized at scan time. Returns true if the
// size actually changed.
//
// Declines in three cases, each deliberate: a user-added word has no source ink
// to match; a word the user has resized by hand must keep the size they chose;
// and an empty word has nothing to measure, so it keeps its last size ready for
// the next character typed into it.
export function refitWordFontSize(obj) {
  if (!obj || obj.type !== "word") return false;
  if (!obj.inkTargetPx || obj.fontSizeLocked) return false;
  const text = obj.el.textContent;
  if (!text.trim()) return false;
  const next = fontSizePctForInk(text, obj.inkTargetPx, obj.inkTargetWpx, state.lastNaturalWidth);
  if (!next || Math.abs(next - obj.fontSizePct) < 1e-9) return false;
  obj.fontSizePct = next;
  applyObjectStyle(obj);
  return true;
}

// The container width the current word sizes were solved against.
//
// Everything in this section sizes a word by measuring its ink AT THE SIZE IT
// WILL RENDER AT, and that size depends on how wide the editor surface is:
// fontSizePct is a percentage of the container, resolved through `cqw`. So a
// size is only correct for the width it was derived for. Change the width -
// rotate a phone, open the app on a different screen - and every word's
// rendered size changes with it; because ink per em is NOT constant in size,
// the fit drifts, and it drifts in the direction that spills.
//
// That is measured, not feared. complexPic5 sized against a 998px container and
// then re-laid-out at 359px: 108 of its 115 words spilled their box, the worst
// by 15%. Nothing re-derived them, and nothing tested it - the gate ran at one
// fixed viewport, so the door nobody opened was the one that was broken.
//
// So a width change re-derives the sizes, through the same refitWordFontSize a
// retype uses, which declines for the same two reasons: a user-added word has
// no source ink to match, and a word the user resized by hand keeps their size.
let lastFitContainerWidth = 0;

export function refitWordsForContainerWidth() {
  const width = editorContentWidth();
  // 0 while the surface is display:none. Nothing to re-derive against yet, and
  // the first real width will bring this straight back.
  if (!width || width === lastFitContainerWidth) return 0;
  lastFitContainerWidth = width;
  let changed = 0;
  for (const obj of state.editorObjects) {
    if (obj.type === "word" && refitWordFontSize(obj)) changed++;
  }
  return changed;
}

// A ResizeObserver rather than a window resize listener, because it is the
// CONTAINER's width the sizes depend on and that can change while the window
// does not - entering Full image mode, a panel opening beside it, the page
// zooming. Coalesced to one pass per frame; re-entrancy is not possible anyway,
// since changing a child's font-size cannot change this element's inline size
// (it is width:100% with a fixed aspect-ratio), and the width-equality guard
// above would stop it if it could.
if (typeof ResizeObserver !== "undefined" && imageFormatView) {
  let queued = false;
  new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refitWordsForContainerWidth();
    });
  }).observe(imageFormatView);
}

export function applyObjectStyle(obj) {
  obj.el.style.left = `${obj.x}%`;
  obj.el.style.top = `${obj.y}%`;
  if (obj.type === "word") {
    obj.el.style.fontSize = `${obj.fontSizePct}cqw`;
    obj.el.style.minWidth = `${obj.w}%`;
    // .image-format-word already sets transform-origin: top left, which is the
    // same corner obj.x/obj.y anchor - so the span pivots about the word's own
    // start rather than drifting away from it. Left unset (rather than set to
    // rotate(0deg)) for level words so the common case keeps an identity
    // transform and stays out of the compositor.
    if (obj.rotationDeg) {
      obj.el.style.transform = `rotate(${obj.rotationDeg}deg)`;
      if (obj.patchEl) obj.patchEl.style.transform = `rotate(${obj.rotationDeg}deg)`;
    }
    // Written as custom properties rather than as `color` directly, and that
    // distinction matters: in Full image mode an untouched word is deliberately
    // `color: transparent` so it doesn't read as a duplicate of the photo's own
    // text. An inline `color` would beat that rule and make every recognized
    // word visible over the image. A custom property feeds the existing rules
    // instead of overriding them, so each keeps deciding *when* to show a word
    // while this decides *what colour* it is when shown.
    if (obj.textColor) obj.el.style.setProperty("--word-color", obj.textColor);
    // The backing box exists only for legibility. When the sampled ink already
    // contrasts with its surroundings, the word sits straight on the image,
    // which is the whole point of matching the colour.
    if (obj.textColor) {
      obj.el.style.setProperty("--word-bg", obj.needsBackingBox ? obj.textBackgroundColor || obj.patchColor || "transparent" : "transparent");
    }
  } else {
    obj.el.style.width = `${obj.w}%`;
    obj.el.style.height = `${obj.h}%`;
  }
}

export function clearImageFormatView() {
  imageFormatView.querySelectorAll(".image-format-word, .image-format-patch").forEach((el) => el.remove());
  imageFormatBg.removeAttribute("src");
  imageFormatView.style.aspectRatio = "";
  // renderImageFormatView always sets this to match the CURRENT scan, so
  // leaving a stale class here between Reset and the next scan is cosmetically
  // inert (nothing is rendered in between) rather than wrong - cleared anyway
  // so this function resets every per-scan flag it's responsible for, not all
  // but one of them (the condensed-source flag).
  imageFormatView.classList.remove("condensed-source");
  resetEditorObjects();
  state.imageFormatLines = [];
  inkPerEmCache.clear();
  lastFitContainerWidth = 0;
  state.objectIdCounter = 0;
  state.lastNaturalWidth = 0;
  state.lastNaturalHeight = 0;
  state.undoStack = [];
  state.redoStack = [];
  state.ocrWords = [];
  if (onResetModes) onResetModes();
  clearSelection();
  updateUndoRedoButtons();
}

// Builds one word span + its background patch placeholder and registers it as an
// editorObjects entry. Shared by the initial OCR render and by Phase 4's "New text"
// tool / Phase 2's undo-recreate path, so every word object is constructed the same
// way regardless of where it came from.

export function createWordObject({ text, x, y, w, h, fontSizePct, rotationDeg, origin, confidence, bbox, inkTargetPx, inkTargetWpx, notTextMetrics }) {
  const span = document.createElement("span");
  span.className = "image-format-word";
  span.contentEditable = String(!state.fullEditorMode);
  span.spellcheck = false;
  span.textContent = text;
  // A contenteditable <span> with no role and no name tells a screen reader
  // nothing: not that it is editable, not that it is a recognized word, not
  // where on the image it came from. The label is filled in by
  // describeWordObject once the object's geometry exists.
  span.setAttribute("role", "textbox");
  span.setAttribute("aria-multiline", "false");
  span.setAttribute("aria-selected", "false");
  // Explicit, and set here rather than per mode. contentEditable is what makes
  // a span focusable, and Move mode turns it off - which silently removed every
  // word from the tab order in exactly the mode a keyboard user most needs to
  // reach them in.
  span.tabIndex = 0;

  const patchEl = document.createElement("div");
  patchEl.className = "image-format-patch";
  patchEl.style.left = `${x}%`;
  patchEl.style.top = `${y}%`;
  patchEl.style.width = `${w}%`;
  patchEl.style.height = `${h}%`;
  imageFormatView.appendChild(patchEl);
  // The patch covers the word's own pixels the moment it is edited, so on a
  // tilted word it has to be tilted the same way - an axis-aligned patch over
  // rotated text either misses the ink or paints over its neighbours.

  const obj = {
    id: `obj-${++state.objectIdCounter}`,
    type: "word",
    origin: origin || "ocr",
    x,
    y,
    w,
    h,
    fontSizePct,
    // Baseline tilt in degrees, 0 for the overwhelming majority of words and
    // for every word on the Tesseract path. Set once at recognition time and
    // never changed by dragging or resizing, both of which move the word's own
    // frame without re-levelling it.
    rotationDeg: rotationDeg || 0,
    originalX: x,
    originalY: y,
    originalW: w,
    originalH: h,
    originalText: text,
    originalBbox: bbox || null,
    // The ink height, in source-image pixels, that this word's replacement text
    // must render at - see refitWordFontSize. Null for a user-added word, which
    // replaces nothing and so has no source ink to match.
    inkTargetPx: inkTargetPx || null,
    inkTargetWpx: inkTargetWpx || null,
    // Set once the user resizes the word by hand, after which retyping must not
    // silently override the size they chose.
    fontSizeLocked: false,
    removed: false,
    // The raw geometry scoreRegionsForNotText needs, in source-image pixels, and
    // the verdict it writes. Held as reported by the engine, so the flag is a
    // property of the region in the photo rather than of the current text.
    notTextMetrics: notTextMetrics || null,
    probablyNotText: false,
    confidence: typeof confidence === "number" ? confidence : null,
    patchColor: null,
    // Filled in by renderImageFormatView from the source pixels (see
    // sampleInkAppearance). A user-added word has no source to sample, so these
    // stay null and it renders in the theme's own text colour and weight.
    textColor: null,
    textBackgroundColor: null,
    needsBackingBox: false,
    inkFraction: null,
    patchEl,
    modified: false,
    el: span,
  };

  if (obj.confidence != null && obj.confidence < LOW_CONFIDENCE_THRESHOLD) {
    span.classList.add("is-low-confidence");
    span.title = `Low-confidence recognition (${Math.round(obj.confidence)}%) - please double-check this word.`;
  }

  imageFormatView.appendChild(span);
  return obj;
}

// A brand-new word has no OCR bbox to size itself against, so it borrows the
// median font size of the existing OCR words (typical body-text size, robust
// to a few oddly large headings/tiny captions) - or a fixed fallback if this
// image had none. h is derived from that font size via the image's aspect
// ratio (fontSizePct is expressed as %-of-width, h as %-of-height) so the
// resize handle starts at a proportionate box instead of a default square.

export function removeUserWordObject(obj) {
  obj.el.remove();
  if (obj.patchEl) obj.patchEl.remove();
  removeEditorObject(obj);
  state.selectedObjectIds.delete(obj.id);
  updateSelectionVisuals();
}

// Draws the already-loaded preview image into an offscreen canvas so word
// patch colors can be sampled from it. Blob: URLs are same-origin, so this
// never taints the canvas.

function readImagePixels(previewImg, naturalWidth, naturalHeight) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(previewImg, 0, 0, naturalWidth, naturalHeight);
    return ctx.getImageData(0, 0, naturalWidth, naturalHeight);
  } catch {
    return null;
  }
}

// Approximates the local background color around a word by averaging a thin
// strip of pixels just outside its bounding box (preferring above, falling
// back to below). Used as an immediate fallback patch color before (or if)
// Phase 2's real inpainting result is available.

export function sampleNearbyColor(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1) {
  if (!imageData) return null;
  const margin = 4;
  let top = Math.max(0, Math.floor(y0) - margin);
  let bottom = Math.floor(y0) - 1;
  if (bottom < top) {
    top = Math.min(naturalHeight - 1, Math.ceil(y1) + 1);
    bottom = Math.min(naturalHeight - 1, Math.ceil(y1) + margin);
  }
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(naturalWidth - 1, Math.ceil(x1));
  if (bottom < top || right < left) return null;

  const { data, width } = imageData;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x += 2) {
      const idx = (y * width + x) * 4;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      count++;
    }
  }
  if (!count) return null;
  return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
}

// ---- Sampling a word's actual appearance from the image (Phase 4b) ----
//
// Every rendered word used to come out in one system font stack in one theme
// colour, whatever the source looked like. That is the difference between a
// clever demo and an edit that blends in: retype a word on a red sign and it
// came back near-black on a grey slab.
//
// What's sampled here is deliberately coarse - an ink colour and a
// bold-or-not - because that is what can be recovered reliably from a word-sized
// crop. Font-family classification is not attempted: getting it wrong looks far
// worse than a neutral stack, and there is no way to verify a guess.

// WCAG relative luminance and contrast ratio. Used to decide whether a sampled
// ink colour is actually legible against its own background, rather than
// assuming it is because it came from the image.

function relativeLuminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Below this the sampled ink is replaced with plain black or white - whichever
// contrasts better with the background.
//
// Deliberately below the WCAG large-text bar of 3.0, which was the first value
// tried and was wrong here. This isn't a design being authored from scratch: the
// colours came out of an image where somebody chose them and a human is reading
// them. Dark text on saturated red sits at about 2.5 and is perfectly legible,
// yet a 3.0 bar replaced it with white - overriding the source to "fix"
// something that wasn't broken, which is the opposite of blending in. The
// fallback is for samples that are genuinely unreadable or genuinely wrong.

const MIN_INK_CONTRAST = 2;
// Above this, the word needs no backing box at all and can sit directly on the
// image, which is the whole point of matching the colour in the first place.

const NO_BACKING_BOX_CONTRAST = 4.5;
// NO BOLD/REGULAR DETECTION, and that is a measured decision rather than an
// omission. The obvious proxy is how much of a word's box is ink, so it was
// tried and measured against test/render-fidelity.js, which knows the weight it
// drew every word in:
//
//   system stack   weight 500: ink fraction 0.368-0.578   weight 700: 0.421-0.518
//   display face   weight 500: ink fraction 0.638-0.835   weight 700: 0.619-0.721
//
// The ranges overlap almost entirely, and in the display face bold text has a
// LOWER ink fraction than medium - the signal is inverted. Ink coverage is
// dominated by the typeface and by which letters a word happens to contain, not
// by its weight. There is no threshold that works, so guessing would just
// render some words wrongly bold for the appearance of doing something.
//
// The size half of "match the font" is already handled and does work: a word's
// font size is derived from its bbox height (see renderImageFormatView), and
// render-fidelity measures the resulting width ratio at a mean of 1.00.
// inkFraction is still reported by the sampler so that harness can keep
// measuring this if a better idea comes along.

// Splits the pixels inside a word's bbox into ink and background, and reports
// the ink's mean colour, the background's mean colour, and what fraction of the
// box the ink covers.
//
// Self-contained on purpose. The first version compared each pixel against the
// background sampled just OUTSIDE the box (sampleNearbyColor, which prefers a
// strip above). That inverted - reporting the background as the ink - whenever a
// word sat near a change in background, because the strip above the box belonged
// to the old background while the word sat on the new one. Cream text at the top
// of a dark panel came back near-black.
//
// Otsu's method on the box's own luminance histogram has no such dependency: it
// finds the split that best separates the two populations actually present. The
// smaller population is the ink, because within a word's own tight bounding box
// the letterforms always cover less area than the space around them - which also
// makes the background estimate a by-product rather than an input.
// Median luminance of a thin ring just outside a box, on all four sides. The
// median (rather than a mean) is the point: it ignores a minority of the ring
// that has strayed onto a different background.

function medianSurroundingLuma(imageData, naturalWidth, naturalHeight, left, top, right, bottom) {
  const { data, width } = imageData;
  const margin = Math.max(2, Math.round(Math.min(right - left, bottom - top) * 0.35));
  const samples = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= naturalWidth || y >= naturalHeight) return;
    const i = (y * width + x) * 4;
    samples.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  };
  for (let x = left - margin; x <= right + margin; x++) {
    for (let d = 1; d <= margin; d++) {
      push(x, top - d);
      push(x, bottom + d);
    }
  }
  for (let y = top; y <= bottom; y++) {
    for (let d = 1; d <= margin; d++) {
      push(left - d, y);
      push(right + d, y);
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// Otsu's method: the threshold maximizing between-class variance, over a
// 256-bin luminance histogram. Shared by sampleInkAppearance's ink/background
// split below and detectCondensedSource's binarization - one
// implementation, not two copies of the same algorithm.
function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v];
  let sumBelow = 0;
  let countBelow = 0;
  let bestVariance = -1;
  let threshold = 0;
  for (let v = 0; v < 256; v++) {
    countBelow += histogram[v];
    if (!countBelow) continue;
    const countAbove = total - countBelow;
    if (!countAbove) break;
    sumBelow += v * histogram[v];
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sum - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = v;
    }
  }
  return threshold;
}

function sampleInkAppearance(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1) {
  if (!imageData) return null;

  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(naturalWidth - 1, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(naturalHeight - 1, Math.ceil(y1));
  if (right <= left || bottom <= top) return null;

  const { data, width } = imageData;
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = (y * width + x) * 4;
      const luma = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      histogram[luma]++;
      total++;
    }
  }
  if (!total) return null;

  const threshold = otsuThreshold(histogram, total);

  // A box with no real two-tone structure - blank, or a flat fill. Guessing an
  // ink colour out of noise is worse than declining to.
  let meanAll = 0;
  for (let v = 0; v < 256; v++) meanAll += v * histogram[v];
  meanAll /= total;
  let spread = 0;
  for (let v = 0; v < 256; v++) spread += histogram[v] * (v - meanAll) ** 2;
  if (Math.sqrt(spread / total) < 12) return null;

  let darkR = 0, darkG = 0, darkB = 0, darkCount = 0;
  let lightR = 0, lightG = 0, lightB = 0, lightCount = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = (y * width + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma <= threshold) {
        darkR += data[i]; darkG += data[i + 1]; darkB += data[i + 2]; darkCount++;
      } else {
        lightR += data[i]; lightG += data[i + 1]; lightB += data[i + 2]; lightCount++;
      }
    }
  }
  if (!darkCount || !lightCount) return null;

  const dark = [Math.round(darkR / darkCount), Math.round(darkG / darkCount), Math.round(darkB / darkCount)];
  const light = [Math.round(lightR / lightCount), Math.round(lightG / lightCount), Math.round(lightB / lightCount)];

  // Which class is the background is decided by what SURROUNDS the word, not by
  // which is larger. "Ink is the minority" was the first rule tried and it fails
  // exactly where it matters most: in a heavy display face at poster size, the
  // letterforms cover more than half of their own tight bounding box, so the
  // rule inverts and the headline comes out in its background colour.
  //
  // The ring outside the box is read as a MEDIAN, not a mean, which is what
  // makes this survive a word sitting near a change of background - the case
  // that broke the previous attempt at using the surroundings. A minority of the
  // ring falling on the neighbouring colour moves a mean and doesn't move a
  // median.
  const surroundingLuma = medianSurroundingLuma(imageData, naturalWidth, naturalHeight, left, top, right, bottom);
  const darkLuma = 0.299 * dark[0] + 0.587 * dark[1] + 0.114 * dark[2];
  const lightLuma = 0.299 * light[0] + 0.587 * light[1] + 0.114 * light[2];
  const inkIsDark =
    surroundingLuma == null
      ? darkCount <= lightCount // no usable ring (word at the image edge): fall back to the size rule
      : Math.abs(lightLuma - surroundingLuma) < Math.abs(darkLuma - surroundingLuma);
  let ink = inkIsDark ? dark : light;
  const background = inkIsDark ? light : dark;
  const inkCount = inkIsDark ? darkCount : lightCount;

  let fallbackUsed = false;
  // Sampled from the image is no guarantee of readable once the original pixels
  // underneath have been inpainted away.
  if (contrastRatio(ink, background) < MIN_INK_CONTRAST) {
    const black = [0, 0, 0];
    const white = [255, 255, 255];
    ink = contrastRatio(black, background) >= contrastRatio(white, background) ? black : white;
    fallbackUsed = true;
  }

  return {
    color: `rgb(${ink[0]}, ${ink[1]}, ${ink[2]})`,
    backgroundColor: `rgb(${background[0]}, ${background[1]}, ${background[2]})`,
    // Only worth a backing box when the text would otherwise be hard to read;
    // otherwise the word sits straight on the image, which is the point.
    needsBackingBox: contrastRatio(ink, background) < NO_BACKING_BOX_CONTRAST,
    inkFraction: inkCount / total,
    fallbackUsed,
  };
}

// ---- Condensed-source-text detection ----
//
// A replacement word is set in the app's own font, not the photo's - the
// font matcher that doesn't exist yet (see fontSizePctForInk's header). On an
// ordinary photo that costs almost nothing: complexPic5, ordinary sans body
// text, sizes to a median 0.948 of its source box's height. On complexPic1 -
// a poster in a condensed hand-drawn display face - the same measured (in
// this session, freshly, in the pinned Docker container, on Liberation Sans)
// at 0.552: the app's WIDER default font has to shrink well past its
// height-matched size just to fit the box's WIDTH, and 8 of 22 words hit the
// width floor outright. Two prior investigation sessions ruled out ink
// coverage/stroke width (falsified: ranges overlap almost entirely, and
// invert on a display face), stroke contrast (degenerates to ~1.0 at the
// pixel resolutions real photographed text has), x-height ratio (confounded
// by all-caps headlines) and terminal shape (no serif exemplar in this
// corpus to test against) as usable signals. Glyph aspect ratio - how wide a
// letterform's own connected-component bounding box is relative to its
// height - was the one exception: real, if noisy, in the right direction.
//
// WHY 0.70, AND WHY IT'S ONE POSITIVE EXAMPLE STILL. Widened to the full
// 11-image benchmark corpus (test/research/condensed-source-detection.md has
// the per-image numbers and the script that produced them), the per-WORD
// distributions overlap substantially - this is NOT a reliable per-word
// classifier. But aggregated to one median per image - the unit this
// function actually decides on - complexPic1 is the unambiguous minimum
// across all 11 (0.633), with real headroom to the next-lowest image
// (complexPic2, 0.786 - a 0.153 gap no other image falls anywhere near; the
// one outlier, complexPic10, sits at 4.000, dominated by short numeric/price
// fragments rather than condensed prose). 0.70 sits close to the midpoint of
// that gap. That still means complexPic1 is the ONLY genuinely condensed
// face in the corpus this threshold was checked against - there is no second
// positive example to confirm the cut generalizes to a condensed face this
// corpus doesn't happen to contain, only 10 confirmed true negatives. That
// residual risk is exactly why the gate (test/replacement-size.js) checks
// every image the classifier can see, not just complexPic1: the claim being
// defended is "this does not make any non-condensed image worse," which 10
// true negatives DOES support, not "this generalizes to condensed faces in
// general," which it cannot.
const CONDENSED_MIN_WORDS = 5;
const CONDENSED_ASPECT_THRESHOLD = 0.7;
const CONDENSED_FONT_LOAD_SPEC = '400 16px "Roboto Condensed"';

// Warms the condensed-font cache well before any scan can complete - OCR
// takes seconds at minimum, this is a same-origin ~47KB file - so
// detectCondensedSource's caller below is awaiting an already-resolved
// promise in the overwhelming majority of real scans, not a fresh fetch.
// Fire-and-forget: a failed or slow load just means the condensed branch
// falls back to the regular stack for that one scan, not a broken word.
if (typeof document !== "undefined" && document.fonts) {
  document.fonts.load(CONDENSED_FONT_LOAD_SPEC).catch(() => {});
}

// The median glyph aspect ratio (connected-component width/height) within
// one word's own box. Otsu-thresholded exactly like sampleInkAppearance -
// ink is again whichever side of the split is the minority population,
// same reasoning as that function's own header - then split into
// 4-connected components; each surviving component (area >= 3px, filtering
// single-pixel noise) is a glyph candidate. Touching/cursive letters merge
// into fewer, wider components on some faces; that under-counts rather than
// crashing, and is why the classifier below requires several words' worth of
// agreement rather than trusting any single one.
function medianGlyphAspect(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1) {
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(naturalWidth - 1, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(naturalHeight - 1, Math.ceil(y1));
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < 6 || h < 6) return null;

  const { data, width } = imageData;
  const histogram = new Uint32Array(256);
  const luma = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((top + y) * width + (left + x)) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      luma[y * w + x] = l;
      histogram[Math.round(l)]++;
    }
  }
  const threshold = otsuThreshold(histogram, w * h);
  let darkCount = 0;
  for (let p = 0; p < luma.length; p++) if (luma[p] <= threshold) darkCount++;
  const inkIsDark = darkCount <= luma.length / 2;
  const grid = new Uint8Array(w * h);
  for (let p = 0; p < luma.length; p++) {
    grid[p] = (inkIsDark ? luma[p] <= threshold : luma[p] > threshold) ? 1 : 0;
  }

  const visited = new Uint8Array(w * h);
  const aspects = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!grid[idx] || visited[idx]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cy = (cur / w) | 0;
        const cx = cur % w;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0 && grid[cur - 1] && !visited[cur - 1]) { visited[cur - 1] = 1; stack.push(cur - 1); }
        if (cx < w - 1 && grid[cur + 1] && !visited[cur + 1]) { visited[cur + 1] = 1; stack.push(cur + 1); }
        if (cy > 0 && grid[cur - w] && !visited[cur - w]) { visited[cur - w] = 1; stack.push(cur - w); }
        if (cy < h - 1 && grid[cur + w] && !visited[cur + w]) { visited[cur + w] = 1; stack.push(cur + w); }
      }
      if (area >= 3) aspects.push((maxX - minX + 1) / (maxY - minY + 1));
    }
  }
  if (!aspects.length) return null;
  aspects.sort((a, b) => a - b);
  return aspects[Math.floor(aspects.length / 2)];
}

// Whether this scan's recognized text reads as a condensed face - see the
// header above this section for the evidence and the threshold. Takes the
// median-of-medians (one median per word, then the median of those) so a
// handful of odd words - a logo OCR misread as a word, a single stray digit
// - cannot swing the image-level decision the way they could swing a plain
// mean.
export function detectCondensedSource(pixels, naturalWidth, naturalHeight, ocrWords) {
  if (!pixels) return false;
  const medians = [];
  for (const word of ocrWords) {
    if (!word.bbox) continue;
    const m = medianGlyphAspect(pixels, naturalWidth, naturalHeight, word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1);
    if (m !== null) medians.push(m);
  }
  if (medians.length < CONDENSED_MIN_WORDS) return false;
  medians.sort((a, b) => a - b);
  return medians[Math.floor(medians.length / 2)] < CONDENSED_ASPECT_THRESHOLD;
}

export function isWordModified(obj) {
  if (obj.origin === "user") return true;
  return (
    obj.el.textContent !== obj.originalText ||
    Math.abs(obj.x - obj.originalX) > 0.01 ||
    Math.abs(obj.y - obj.originalY) > 0.01 ||
    Math.abs(obj.w - obj.originalW) > 0.01 ||
    Math.abs(obj.h - obj.originalH) > 0.01
  );
}

// Narrower than isWordModified: only true for an actual text change (or a
// Phase 4 user-added word, which has no OCR text to compare against). Used to
// let filter.js's wordPasses always keep a word the user explicitly edited,
// regardless of a move/resize that isWordModified would also flag.

function isWordTextEdited(obj) {
  return obj.origin === "user" || obj.el.textContent !== obj.originalText;
}

let onPatchNeeded = null;
// Wired by main.js (Phase 2) so editor.js can ask for an up-to-date patch fill
// (inpainted, if available) without owning any OpenCV/inpainting logic itself.

export function setPatchProvider(fn) {
  onPatchNeeded = fn;
}

// A full pass over every object: recomputes modified state, re-evaluates the
// active filter for each word, and asks for a patch fill where one is needed.
// Fine on a discrete change; not fine per pointer-move, which is what the drag
// loop used to do - see refreshModifiedStatesFor.
export function refreshModifiedStates() {
  refreshModifiedStatesFor(state.editorObjects);
}

// The same work, restricted to the objects that actually changed. The drag and
// resize loops call this instead: on an image with hundreds of recognized
// words, reconciling all of them on every pointer-move tick was doing hundreds
// of times the necessary work at exactly the moment the frame budget matters,
// and only the objects under the pointer can have changed.
export function refreshModifiedStatesFor(objects) {
  objects.forEach((obj) => {
    if (obj.type !== "word") return;
    const modified = isWordModified(obj);
    obj.modified = modified;
    obj.el.classList.toggle("is-modified", modified);

    const passesFilter = wordPasses(
      { text: obj.el.textContent, confidence: obj.confidence },
      state.activeFilterLevel,
      isWordTextEdited(obj)
    );
    obj.el.classList.toggle("is-filtered-out", !passesFilter);
    updateWordLabel(obj);

    if (!obj.patchEl) return;
    if (modified && obj.origin === "ocr") {
      obj.patchEl.style.display = "block";
      if (onPatchNeeded) onPatchNeeded(obj);
      else if (obj.patchColor) obj.patchEl.style.background = obj.patchColor;
    } else {
      obj.patchEl.style.display = "none";
    }
  });
}

// Builds the Image format / Full image view from Tesseract's recognition result.
// data.words is a flat, line-ordered list of { lineIndex, text, confidence, bbox }
// produced by ocrEngine.js (already corrected back into original-image coordinates
// by preprocess.js when preprocessing changed geometry).

// Async since the condensed-source detector landed - see the await below - but
// that await is only ever
// reached for a scan detectCondensedSource fires on, which is the rare case;
// every other call runs to completion synchronously the moment it's invoked,
// same as before. All three callers (js/main.js's scan handler, and
// test/render-fidelity.js and test/web-tier-smoke.js, which drive this
// function directly with synthetic fixtures) now await it, so none of them
// depend on which of those two paths a given call happens to take.
export async function renderImageFormatView(previewImg, ocrWords, naturalWidth, naturalHeight, imageUrl) {
  clearImageFormatView();

  if (!naturalWidth || !naturalHeight) return;

  state.lastNaturalWidth = naturalWidth;
  state.lastNaturalHeight = naturalHeight;
  state.ocrWords = ocrWords;
  imageFormatView.style.aspectRatio = `${naturalWidth} / ${naturalHeight}`;
  imageFormatBg.src = imageUrl;

  const bgObj = { id: "obj-bg", type: "image", x: 0, y: 0, w: 100, h: 100, el: imageFormatBg };
  addEditorObject(bgObj);
  applyObjectStyle(bgObj);

  const pixels = readImagePixels(previewImg, naturalWidth, naturalHeight);

  // The condensed-source decision: made once, before any word below is sized,
  // so every word sizes
  // against whatever wordFontFamily() ends up resolving to - the same
  // function inkFitPxAtScale (preview) and buildResultCanvas (export) both
  // read, so this is one decision feeding both surfaces, not two that could
  // drift. See detectCondensedSource's header for the evidence.
  let condensed = detectCondensedSource(pixels, naturalWidth, naturalHeight, ocrWords);
  if (condensed) {
    try {
      await document.fonts.load(CONDENSED_FONT_LOAD_SPEC);
    } catch {
      // Fetch failed (offline, blocked) - document.fonts.check() below will
      // correctly read false either way, so nothing more to do here.
    }
    condensed = document.fonts.check(CONDENSED_FONT_LOAD_SPEC);
  }
  imageFormatView.classList.toggle("condensed-source", condensed);

  let currentLineIndex = null;
  let lineSpans = [];

  ocrWords.forEach((word) => {
    const text = (word.text || "").trim();
    if (!text) return;
    if (word.lineIndex !== currentLineIndex) {
      if (lineSpans.length) state.imageFormatLines.push(lineSpans);
      lineSpans = [];
      currentLineIndex = word.lineIndex;
    }

    const { x0, y0, x1, y1 } = word.bbox;
    // A word the engine reported corner points for carries its own frame: the
    // true top-left, baseline length and glyph height of the tilted word,
    // rather than the axis-aligned envelope drawn around it. Sizing a span from
    // the envelope is what produced the on-device "gibberish" - see
    // quadGeometry in js/mlkitEngine.js for the arithmetic. Tesseract reports
    // no corner points, so its words fall back to the envelope exactly as
    // before and nothing on that path changes.
    const frame = word.frame || null;
    const width = Math.max(frame ? frame.width : x1 - x0, 1);
    const height = Math.max(frame ? frame.height : y1 - y0, 1);

    const x = ((frame ? frame.x : x0) / naturalWidth) * 100;
    const y = ((frame ? frame.y : y0) / naturalHeight) * 100;
    const w = (width / naturalWidth) * 100;
    const h = (height / naturalHeight) * 100;
    // The ink height this word has to match, in source-image pixels, kept on
    // the object so a retype can re-derive the size against the same target.
    const fontSizePct = fontSizePctForInk(text, height, width, naturalWidth);

    const obj = createWordObject({
      text,
      x,
      y,
      w,
      h,
      fontSizePct,
      rotationDeg: word.rotationDeg || 0,
      origin: "ocr",
      confidence: word.confidence,
      bbox: { x0, y0, x1, y1 },
      inkTargetPx: height,
      inkTargetWpx: width,
      notTextMetrics: { chars: text.length, widthPerChar: width / text.length, height },
    });
    obj.patchColor = sampleNearbyColor(pixels, naturalWidth, naturalHeight, x0, y0, x1, y1);
    if (obj.patchColor) obj.patchEl.style.background = obj.patchColor;

    // Sampled from the ORIGINAL pixels, here, before anything covers them - the
    // patch is drawn over this exact region the moment the word is edited, so
    // this is the only point at which the word's real appearance is still
    // readable from the image.
    const appearance = sampleInkAppearance(pixels, naturalWidth, naturalHeight, x0, y0, x1, y1);
    if (appearance) {
      obj.textColor = appearance.color;
      obj.needsBackingBox = appearance.needsBackingBox;
      // The backing box, on the rare occasions one is needed, should match what
      // surrounds the word rather than the app's own surface colour - and this
      // background came from inside the box, so it holds even where
      // sampleNearbyColor's strip-above would have looked at the wrong thing.
      obj.textBackgroundColor = appearance.backgroundColor;
      obj.inkFraction = appearance.inkFraction;
    }

    addEditorObject(obj);
    applyObjectStyle(obj);
    lineSpans.push(obj.el);
  });

  if (lineSpans.length) state.imageFormatLines.push(lineSpans);
  // The width every size above was solved against, so the observer can tell a
  // real width change from the surface simply becoming visible at the width
  // that was already predicted for it.
  lastFitContainerWidth = editorContentWidth();
  // After the loop, not inside it: both thresholds are medians over the whole
  // image, so no word can be scored until every word exists.
  scoreRegionsForNotText(state.editorObjects);
  refreshModifiedStates(); // sets initial is-filtered-out at the default filter level
}
