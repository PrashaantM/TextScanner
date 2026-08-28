// editor.js: the Image format / Full image editing surface. Builds the per-word
// DOM overlay from an OCR result, and drives mode switching, selection, drag/resize/
// marquee interactions, undo/redo, and flattening the current view to a PNG canvas.
// This is the shared "object model" (editorObjects) that Phase 2 (inpainting),
// Phase 3 (filter view), and Phase 4 (add/remove) all build on top of.

import {
  modeTextBtn,
  modeImageBtn,
  modeFullBtn,
  modeButtons,
  resultText,
  imageFormatView,
  imageFormatBg,
  resizeHandle,
  marqueeBox,
  imageFormatHint,
  editorToolbar,
  editorModeBtn,
  downloadImageBtn,
  undoRedoGroup,
  undoBtn,
  redoBtn,
  deleteBtn,
  newTextBtn,
} from "./dom.js";
import { state, MAX_UNDO_STEPS, FONT_SIZE_CORRECTION, LOW_CONFIDENCE_THRESHOLD } from "./state.js";
import { wordPasses } from "./filter.js";

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Keep at least a sliver of an object within the container while dragging, without
// pinning full-bleed objects (like a background image at 100% size) in place.
const MIN_VISIBLE_PCT = 5;
function clampPosition(value, size) {
  return clamp(value, MIN_VISIBLE_PCT - size, 100 - MIN_VISIBLE_PCT);
}

// Resize bounds (beginResize) - object width/height and word font size are
// all expressed as %-of-image-dimension, matching editorObjects' existing
// unit convention.
const MIN_OBJECT_SIZE_PCT = 1.5;
const MAX_OBJECT_SIZE_PCT = 400;
const MIN_RESIZE_SCALE = 0.2;
const MAX_RESIZE_SCALE = 6;
const MIN_FONT_SIZE_PCT = 0.5;

// Fallback geometry for a new "New text" object (computeDefaultGeometry) when
// there's no OCR word to size it against yet.
const DEFAULT_FONT_SIZE_PCT = 3;
const DEFAULT_TEXT_WIDTH_PCT = 12;
const DEFAULT_TEXT_HEIGHT_PCT = 4;

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

// ---- Mode switching (Text / Image format / Full image) ----

export function setMode(mode) {
  state.activeMode = mode;
  setActiveButton(modeButtons, (btn) => btn.dataset.mode === mode);

  hide(resultText);
  hide(imageFormatView);
  hide(imageFormatHint);
  hide(editorToolbar);
  hide(downloadImageBtn);

  if (mode === "text") {
    show(resultText);
  } else {
    show(imageFormatView);
    show(imageFormatHint);
    show(downloadImageBtn);
    imageFormatView.classList.toggle("show-bg", mode === "full");

    if (mode === "full") {
      show(editorToolbar);
    } else if (state.fullEditorMode) {
      setFullEditorMode(false);
    }
  }

  updateImageFormatHint();
  document.dispatchEvent(new CustomEvent("mode-changed", { detail: { mode } }));
}

modeTextBtn.addEventListener("click", () => setMode("text"));
modeImageBtn.addEventListener("click", () => setMode("image"));
modeFullBtn.addEventListener("click", () => setMode("full"));

export function updateImageFormatHint() {
  if (state.activeMode === "image") {
    imageFormatHint.textContent =
      "Text is positioned where it appeared in the source image. Click a word to edit it, or shift-click and drag to select multiple.";
  } else if (state.activeMode === "full" && !state.fullEditorMode) {
    imageFormatHint.textContent =
      "The full image is shown with editable text on top. Click a word to edit it, or shift-click and drag to select multiple. Click Move components to move and resize.";
  } else if (state.activeMode === "full" && state.fullEditorMode) {
    imageFormatHint.textContent = state.addTextMode
      ? "Click anywhere on the image to place a new text box."
      : "Drag an item to move it, or drag its corner handle to resize. Shift-click or drag a selection box to move multiple items together. Press Delete to remove the selection.";
  }
}

// ---- Full editor mode ----

export function setFullEditorMode(on) {
  state.fullEditorMode = on;
  if (!on) setAddTextMode(false);
  imageFormatView.classList.toggle("editor-mode", on);
  state.editorObjects.forEach((obj) => {
    if (obj.type === "word") {
      obj.el.contentEditable = String(!on);
    }
  });
  editorModeBtn.textContent = on ? "Done moving" : "Move components";
  editorModeBtn.setAttribute("aria-pressed", String(on));
  if (on) {
    show(undoRedoGroup);
  } else {
    hide(undoRedoGroup);
  }
  updateUndoRedoButtons();
  updateDeleteButton();
  updateImageFormatHint();
  updateResizeHandle();
}

editorModeBtn.addEventListener("click", () => setFullEditorMode(!state.fullEditorMode));

// ---- Add-text mode (Phase 4 hook; toggled by main.js's New text button) ----

export function setAddTextMode(on) {
  state.addTextMode = on;
  imageFormatView.classList.toggle("add-text-mode", on);
  if (newTextBtn) {
    newTextBtn.textContent = on ? "Cancel" : "New text";
    newTextBtn.setAttribute("aria-pressed", String(on));
  }
  updateImageFormatHint();
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
    obj.el.classList.toggle("is-selected", state.selectedObjectIds.has(obj.id));
  });
  updateResizeHandle();
  updateDeleteButton();
}

export function objectsFromSelection() {
  return state.editorObjects.filter((obj) => state.selectedObjectIds.has(obj.id));
}

export function updateResizeHandle() {
  if (state.fullEditorMode && state.selectedObjectIds.size === 1) {
    const obj = state.editorObjects.find((o) => state.selectedObjectIds.has(o.id));
    resizeHandle.style.left = `${obj.x + obj.w}%`;
    resizeHandle.style.top = `${obj.y + obj.h}%`;
    resizeHandle.style.display = "block";
  } else {
    resizeHandle.style.display = "none";
  }
}

function updateDeleteButton() {
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
  state.editorObjects = state.editorObjects.filter((obj) => {
    if (snapshotIds.has(obj.id) || obj.type === "image") return true;
    obj.el.remove();
    if (obj.patchEl) obj.patchEl.remove();
    if (onObjectRemoved) onObjectRemoved(obj);
    state.selectedObjectIds.delete(obj.id);
    return false;
  });

  snapshot.forEach((s) => {
    let obj = state.editorObjects.find((o) => o.id === s.id);
    if (!obj && s.type === "word" && createElementForSnapshot) {
      obj = createElementForSnapshot(s);
      if (obj) state.editorObjects.push(obj);
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
  } else {
    obj.el.style.width = `${obj.w}%`;
    obj.el.style.height = `${obj.h}%`;
  }
}

export function clearImageFormatView() {
  imageFormatView.querySelectorAll(".image-format-word, .image-format-patch").forEach((el) => el.remove());
  imageFormatBg.removeAttribute("src");
  imageFormatView.style.aspectRatio = "";
  state.editorObjects = [];
  state.imageFormatLines = [];
  state.objectIdCounter = 0;
  state.lastNaturalWidth = 0;
  state.lastNaturalHeight = 0;
  state.undoStack = [];
  state.redoStack = [];
  state.ocrWords = [];
  setFullEditorMode(false);
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
function computeDefaultGeometry() {
  const ocrFontSizes = state.editorObjects
    .filter((o) => o.type === "word" && o.origin === "ocr")
    .map((o) => o.fontSizePct)
    .sort((a, b) => a - b);

  let fontSizePct = DEFAULT_FONT_SIZE_PCT;
  if (ocrFontSizes.length) {
    const mid = Math.floor(ocrFontSizes.length / 2);
    fontSizePct = ocrFontSizes.length % 2 ? ocrFontSizes[mid] : (ocrFontSizes[mid - 1] + ocrFontSizes[mid]) / 2;
  }

  const w = DEFAULT_TEXT_WIDTH_PCT;
  const h =
    state.lastNaturalWidth && state.lastNaturalHeight
      ? (fontSizePct * state.lastNaturalWidth) / state.lastNaturalHeight / FONT_SIZE_CORRECTION
      : DEFAULT_TEXT_HEIGHT_PCT;
  return { fontSizePct, w, h };
}

// Phase 4's "New text" tool: places a new origin:'user' word at the clicked
// point, selects it, and focuses it for immediate typing (contentEditable is
// normally false for every word while in Move mode, so this temporarily
// overrides that for just this new span until the user clicks away). If the
// user clicks away without typing anything, the placement is silently undone
// instead of leaving an invisible empty box in editorObjects/undo history.
export function addUserTextObject(xPct, yPct) {
  const preSnapshot = snapshotState();
  const { fontSizePct, w, h } = computeDefaultGeometry();

  const obj = createWordObject({
    text: "",
    x: clampPosition(xPct, w),
    y: clampPosition(yPct, h),
    w,
    h,
    fontSizePct,
    origin: "user",
    confidence: null,
    bbox: null,
  });
  state.editorObjects.push(obj);
  applyObjectStyle(obj);

  pushUndo(preSnapshot);
  state.selectedObjectIds.clear();
  state.selectedObjectIds.add(obj.id);
  updateSelectionVisuals();
  refreshModifiedStates();
  setAddTextMode(false);

  obj.el.contentEditable = "true";
  obj.el.focus();

  const onBlur = () => {
    obj.el.removeEventListener("blur", onBlur);
    if (obj.el.textContent.trim() !== "") {
      obj.el.contentEditable = String(!state.fullEditorMode);
      return;
    }
    if (state.undoStack[state.undoStack.length - 1] === preSnapshot) {
      state.undoStack.pop();
      updateUndoRedoButtons();
    }
    removeUserWordObject(obj);
  };
  obj.el.addEventListener("blur", onBlur);

  return obj;
}

// Fully removes a user-added word (unlike deleting an OCR word, which just
// clears its text and reveals an inpainted patch - a user word has no
// underlying image content to reveal, so there's nothing to keep around).
export function removeUserWordObject(obj) {
  obj.el.remove();
  if (obj.patchEl) obj.patchEl.remove();
  state.editorObjects = state.editorObjects.filter((o) => o.id !== obj.id);
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

export function refreshModifiedStates() {
  state.editorObjects.forEach((obj) => {
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
  state.editorObjects.push(bgObj);
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

    state.editorObjects.push(obj);
    applyObjectStyle(obj);
    lineSpans.push(obj.el);
  });

  if (lineSpans.length) state.imageFormatLines.push(lineSpans);
  refreshModifiedStates(); // sets initial is-filtered-out at the default filter level
}

imageFormatView.addEventListener("input", (e) => {
  const span = e.target.closest(".image-format-word");
  if (!span) return;
  const obj = state.editorObjects.find((o) => o.el === span);
  if (obj) refreshModifiedStates();
});

// Direct contenteditable text edits (typing into a word, outside full editor mode)
// aren't covered by the drag/resize undo pushes above. Capture a snapshot on focus
// and push it on blur, but only if the text actually changed during that session -
// otherwise every stray click into a word would pollute the undo stack.
let editingSpan = null;
let editingOriginalText = null;
let editingPreSnapshot = null;

imageFormatView.addEventListener("focusin", (e) => {
  const span = e.target.closest(".image-format-word");
  if (!span || state.fullEditorMode) return;
  editingSpan = span;
  editingOriginalText = span.textContent;
  editingPreSnapshot = snapshotState();
});

imageFormatView.addEventListener("focusout", (e) => {
  if (e.target !== editingSpan) return;
  if (editingSpan.textContent !== editingOriginalText && editingPreSnapshot) {
    pushUndo(editingPreSnapshot);
  }
  editingSpan = null;
  editingOriginalText = null;
  editingPreSnapshot = null;
});

// Returns the text to copy/download/read aloud: in Image format or Full image mode,
// rebuilds it line-by-line from the (possibly edited) word spans - skipping any
// word the active filter level dimmed via is-filtered-out - restricted to the
// current selection if any words are selected; otherwise defers to the
// filterTextHook (wired by main.js to filter.js, keyed off the same ocrWords/level
// that drove the Text view textarea) so Text mode gets the same filtering. Either
// way, any Phase 4 user-added words are appended as trailing lines in creation
// order (they live outside ocrWords/imageFormatLines entirely, so no other path
// would otherwise surface them) - restricted to the selection too, if one exists.
let filterTextHook = null;
export function setFilterTextHook(fn) {
  filterTextHook = fn;
}

export function getActiveResultText() {
  // Only a selection that actually includes a word should restrict the output -
  // the background image is itself a selectable/draggable object (e.g. while
  // resizing it in Full image mode), and selecting only that has nothing to do
  // with which text the user wants, so it must fall back to "no restriction"
  // rather than making Copy/Download return nothing.
  const selectedWordObjs = state.editorObjects.filter(
    (obj) => obj.type === "word" && state.selectedObjectIds.has(obj.id)
  );
  const selectedWordEls = selectedWordObjs.length ? new Set(selectedWordObjs.map((obj) => obj.el)) : null;

  let baseText;
  if ((state.activeMode === "image" || state.activeMode === "full") && state.imageFormatLines.length) {
    const lines = state.imageFormatLines
      .map((spans) => {
        const relevant = (selectedWordEls ? spans.filter((s) => selectedWordEls.has(s)) : spans).filter(
          (s) => !s.classList.contains("is-filtered-out")
        );
        return relevant
          .map((s) => s.textContent)
          .join(" ")
          .trim();
      })
      .filter((line) => line.length > 0);
    baseText = lines.join("\n").trim();
  } else if (filterTextHook) {
    baseText = filterTextHook(resultText.value);
  } else {
    baseText = resultText.value;
  }

  const userWordEls = state.editorObjects
    .filter((obj) => obj.type === "word" && obj.origin === "user")
    .map((obj) => obj.el);
  const relevantUserEls = selectedWordEls ? userWordEls.filter((el) => selectedWordEls.has(el)) : userWordEls;
  const userLines = relevantUserEls.map((el) => el.textContent.trim()).filter((t) => t.length > 0);

  return [baseText, ...userLines].filter((t) => t.length > 0).join("\n").trim();
}

// ---- Pointer interactions: select, drag, resize, marquee ----

function beginObjectDrag(e, obj, additive) {
  let selectionChangedAtDown = false;
  if (!state.selectedObjectIds.has(obj.id)) {
    if (!additive) state.selectedObjectIds.clear();
    state.selectedObjectIds.add(obj.id);
    updateSelectionVisuals();
    selectionChangedAtDown = true;
  }

  const startX = e.clientX;
  const startY = e.clientY;
  const rect = imageFormatView.getBoundingClientRect();
  const starts = new Map();
  objectsFromSelection().forEach((o) => starts.set(o.id, { x: o.x, y: o.y }));
  const preSnapshot = snapshotState();
  let moved = false;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 3) moved = true;
    if (!moved) return;
    const dxPct = (dx / rect.width) * 100;
    const dyPct = (dy / rect.height) * 100;
    objectsFromSelection().forEach((o) => {
      const s = starts.get(o.id);
      if (!s) return;
      o.x = clampPosition(s.x + dxPct, o.w);
      o.y = clampPosition(s.y + dyPct, o.h);
      applyObjectStyle(o);
    });
    updateResizeHandle();
    refreshModifiedStates();
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (moved) {
      pushUndo(preSnapshot);
    } else if (!selectionChangedAtDown) {
      if (additive) {
        state.selectedObjectIds.delete(obj.id);
        updateSelectionVisuals();
      } else if (state.selectedObjectIds.size > 1) {
        state.selectedObjectIds.clear();
        state.selectedObjectIds.add(obj.id);
        updateSelectionVisuals();
      }
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function beginResize(e) {
  const obj = state.editorObjects.find((o) => state.selectedObjectIds.has(o.id));
  if (!obj) return;

  const rect = imageFormatView.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = obj.w;
  const startH = obj.h;
  const startFontSizePct = obj.fontSizePct;
  const preSnapshot = snapshotState();
  let changed = false;

  function onMove(ev) {
    const dxPct = ((ev.clientX - startX) / rect.width) * 100;
    const dyPct = ((ev.clientY - startY) / rect.height) * 100;
    const scaleX = (startW + dxPct) / startW;
    const scaleY = (startH + dyPct) / startH;
    let scale = clamp((scaleX + scaleY) / 2, MIN_RESIZE_SCALE, MAX_RESIZE_SCALE);

    obj.w = clamp(startW * scale, MIN_OBJECT_SIZE_PCT, MAX_OBJECT_SIZE_PCT);
    obj.h = clamp(startH * scale, MIN_OBJECT_SIZE_PCT, MAX_OBJECT_SIZE_PCT);
    if (obj.type === "word") {
      obj.fontSizePct = Math.max(startFontSizePct * scale, MIN_FONT_SIZE_PCT);
    }
    changed = true;
    applyObjectStyle(obj);
    updateResizeHandle();
    refreshModifiedStates();
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (changed) pushUndo(preSnapshot);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function beginMarquee(e, additive) {
  if (!additive) clearSelection();

  const rect = imageFormatView.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  marqueeBox.style.display = "block";

  function onMove(ev) {
    const x1 = Math.min(startX, ev.clientX);
    const x2 = Math.max(startX, ev.clientX);
    const y1 = Math.min(startY, ev.clientY);
    const y2 = Math.max(startY, ev.clientY);
    marqueeBox.style.left = `${x1 - rect.left}px`;
    marqueeBox.style.top = `${y1 - rect.top}px`;
    marqueeBox.style.width = `${x2 - x1}px`;
    marqueeBox.style.height = `${y2 - y1}px`;

    state.editorObjects.forEach((obj) => {
      if (obj.type === "image" && !state.fullEditorMode) return;
      const r = obj.el.getBoundingClientRect();
      const intersects = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
      if (intersects) {
        state.selectedObjectIds.add(obj.id);
      } else if (!additive) {
        state.selectedObjectIds.delete(obj.id);
      }
    });
    updateSelectionVisuals();
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    marqueeBox.style.display = "none";
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

let onSurfaceClickForAdd = null;
export function setAddTextClickHandler(fn) {
  onSurfaceClickForAdd = fn;
}

imageFormatView.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;

  // Every branch below that acts on an object (drag/resize/add-placement) calls
  // preventDefault() to stop native text selection/drag - which has the side
  // effect of also suppressing the browser's normal focus-blur transfer. Without
  // this, clicking away from an actively-edited contentEditable word (e.g. a
  // freshly-placed Phase 4 word still being typed into) would never blur it.
  if (document.activeElement && document.activeElement !== e.target && document.activeElement.isContentEditable) {
    document.activeElement.blur();
  }

  const handleEl = e.target.closest(".resize-handle");
  if (handleEl && state.fullEditorMode) {
    e.preventDefault();
    beginResize(e);
    return;
  }

  if (state.fullEditorMode && state.addTextMode) {
    const onSurface = e.target === imageFormatView || e.target === imageFormatBg;
    if (onSurface) {
      e.preventDefault();
      const rect = imageFormatView.getBoundingClientRect();
      const xPct = ((e.clientX - rect.left) / rect.width) * 100;
      const yPct = ((e.clientY - rect.top) / rect.height) * 100;
      if (onSurfaceClickForAdd) onSurfaceClickForAdd(xPct, yPct);
      return;
    }
  }

  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const objEl = e.target.closest(".image-format-word, .image-format-bg");

  if (objEl) {
    const obj = state.editorObjects.find((o) => o.el === objEl);
    if (!obj) return;

    if (state.fullEditorMode) {
      e.preventDefault();
      beginObjectDrag(e, obj, additive);
    } else if (additive) {
      e.preventDefault();
      toggleSelection(obj.id);
    } else if (obj.type === "word") {
      clearSelection();
      // No preventDefault: let the browser place a text caret for normal editing.
    }
    return;
  }

  beginMarquee(e, additive);
});

// ---- Flatten the current view to a PNG canvas ----

let patchCanvasProvider = null;
// Phase 2 hook: given a word object, return a CanvasImageSource showing the
// inpainted fill for its original bbox, or null to fall back to patchColor.
export function setPatchCanvasProvider(fn) {
  patchCanvasProvider = fn;
}

export function buildResultCanvas() {
  if (!state.lastNaturalWidth || !state.lastNaturalHeight) return null;

  const canvas = document.createElement("canvas");
  canvas.width = state.lastNaturalWidth;
  canvas.height = state.lastNaturalHeight;
  const ctx = canvas.getContext("2d");

  const surfaceColor = getComputedStyle(imageFormatView).backgroundColor;
  ctx.fillStyle = surfaceColor || "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.activeMode === "full") {
    const bgObj = state.editorObjects.find((o) => o.type === "image");
    if (bgObj && imageFormatBg.complete && imageFormatBg.naturalWidth) {
      const bx = (bgObj.x / 100) * canvas.width;
      const by = (bgObj.y / 100) * canvas.height;
      const bw = (bgObj.w / 100) * canvas.width;
      const bh = (bgObj.h / 100) * canvas.height;
      ctx.drawImage(imageFormatBg, bx, by, bw, bh);
    }

    state.editorObjects.forEach((obj) => {
      if (obj.type !== "word" || !obj.modified || obj.origin !== "ocr") return;
      const px = (obj.originalX / 100) * canvas.width;
      const py = (obj.originalY / 100) * canvas.height;
      const pw = (obj.originalW / 100) * canvas.width;
      const ph = (obj.originalH / 100) * canvas.height;
      const patchSource = patchCanvasProvider ? patchCanvasProvider(obj) : null;
      if (patchSource) {
        ctx.drawImage(patchSource, px, py, pw, ph);
      } else if (obj.patchColor) {
        ctx.fillStyle = obj.patchColor;
        ctx.fillRect(px, py, pw, ph);
      }
    });
  }

  const textColor = getComputedStyle(document.body).color;
  state.editorObjects.forEach((obj) => {
    if (obj.type !== "word") return;
    // In Full image mode, an untouched OCR word stays invisible on screen (the real
    // image text underneath already shows it), so skip drawing it here too.
    // User-added words have no underlying image text, so always draw them.
    if (state.activeMode === "full" && !obj.modified && obj.origin === "ocr") return;
    const text = obj.el.textContent;
    if (!text) return;
    const fontPx = (obj.fontSizePct / 100) * canvas.width;
    ctx.font = `${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillStyle = textColor || "#111111";
    ctx.textBaseline = "top";
    const wx = (obj.x / 100) * canvas.width;
    const wy = (obj.y / 100) * canvas.height;
    ctx.fillText(text, wx, wy);
  });

  return canvas;
}
