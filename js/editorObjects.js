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
    text: obj.type === "word" ? obj.el.textContent : undefined,
  }));
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
    if (obj.type === "word" && s.text != null && obj.el.textContent !== s.text) {
      obj.el.textContent = s.text;
    }
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

export function applyObjectStyle(obj) {
  obj.el.style.left = `${obj.x}%`;
  obj.el.style.top = `${obj.y}%`;
  if (obj.type === "word") {
    obj.el.style.fontSize = `${obj.fontSizePct}cqw`;
    obj.el.style.minWidth = `${obj.w}%`;
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
  resetEditorObjects();
  state.imageFormatLines = [];
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

export function createWordObject({ text, x, y, w, h, fontSizePct, origin, confidence, bbox }) {
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

  const obj = {
    id: `obj-${++state.objectIdCounter}`,
    type: "word",
    origin: origin || "ocr",
    x,
    y,
    w,
    h,
    fontSizePct,
    originalX: x,
    originalY: y,
    originalW: w,
    originalH: h,
    originalText: text,
    originalBbox: bbox || null,
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

  // Otsu: the threshold maximizing between-class variance.
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

export function renderImageFormatView(previewImg, ocrWords, naturalWidth, naturalHeight, imageUrl) {
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
    const width = Math.max(x1 - x0, 1);
    const height = Math.max(y1 - y0, 1);

    const x = (x0 / naturalWidth) * 100;
    const y = (y0 / naturalHeight) * 100;
    const w = (width / naturalWidth) * 100;
    const h = (height / naturalHeight) * 100;
    const fontSizePct = (height / naturalWidth) * 100 * FONT_SIZE_CORRECTION;

    const obj = createWordObject({
      text,
      x,
      y,
      w,
      h,
      fontSizePct,
      origin: "ocr",
      confidence: word.confidence,
      bbox: { x0, y0, x1, y1 },
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
  refreshModifiedStates(); // sets initial is-filtered-out at the default filter level
}
