// editorInteractions.js: everything the user does to the editor with a pointer
// or a mode button - view switching, Move-components mode, marquee mode,
// add-text mode, and the drag/resize/marquee gestures themselves.
//
// One of three files that used to be a single 1,400-line editor.js. Depends on
// editorObjects.js (it acts on objects; objects know nothing about gestures)
// and on nothing else in the editor.
//
// All gestures are pointer-based, which is not a stylistic choice: bound to
// mouse events only, none of this worked by touch on the iOS build the app is
// actually shipped as. See trackPointer for the details that make a drag
// survive a real finger.

import {
  modeTextBtn,
  modeImageBtn,
  modeFullBtn,
  modeButtons,
  resultText,
  imageFormatView,
  imageFormatBg,
  marqueeBox,
  imageFormatHint,
  editorToolbar,
  editorModeBtn,
  downloadImageBtn,
  undoRedoGroup,
  newTextBtn,
  selectMultiBtn,
} from "./dom.js";
import { state, FONT_SIZE_CORRECTION } from "./state.js";
import {
  clamp,
  show,
  hide,
  setActiveButton,
  clampPosition,
  applyObjectStyle,
  createWordObject,
  removeUserWordObject,
  addEditorObject,
  getObjectById,
  getObjectByElement,
  snapshotState,
  restoreSnapshot,
  pushUndo,
  updateUndoRedoButtons,
  clearSelection,
  toggleSelection,
  updateSelectionVisuals,
  objectsFromSelection,
  updateResizeHandle,
  updateDeleteButton,
  refreshModifiedStates,
  refreshModifiedStatesFor,
  registerModeReset,
} from "./editorObjects.js";


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
    // Marquee mode takes scrolling away from the surface; it must not survive
    // into a view that has no marquee.
    if (state.marqueeMode) setMarqueeMode(false);
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
  if (state.marqueeMode) {
    imageFormatHint.textContent =
      "Drag across the image to select several items at once. Tap \u201cDone selecting\u201d when you're finished.";
    return;
  }
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

// Registered with editorObjects.js so clearImageFormatView can leave
// Move-components mode without that module importing this one. See
// registerModeReset there for why the edge goes this way round.
registerModeReset(() => {
  setFullEditorMode(false);
  setMarqueeMode(false);
});

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

// ---- Marquee (rubber-band) selection mode ----
//
// On a mouse this was never a mode: shift-drag, or drag on empty space, and the
// marquee appears. Touch has neither - there is no shift key, and a plain drag
// is how the page scrolls, so the surface has to give scrolling up to receive
// it (see .marquee-mode's touch-action in style.css). Making that an explicit,
// visible toggle rather than a silent gesture means scrolling still works the
// rest of the time, and it makes multi-select discoverable on a phone at all,
// which the desktop-worded hint ("shift-click and drag") never did.
//
// While armed, a drag starts a marquee even when it begins on top of a word -
// otherwise on a densely recognized image there would be nowhere to start one.

export function setMarqueeMode(on) {
  state.marqueeMode = on;
  imageFormatView.classList.toggle("marquee-mode", on);
  if (selectMultiBtn) {
    selectMultiBtn.textContent = on ? "Done selecting" : "Select multiple";
    selectMultiBtn.setAttribute("aria-pressed", String(on));
  }
  updateImageFormatHint();
}

if (selectMultiBtn) {
  selectMultiBtn.addEventListener("click", () => setMarqueeMode(!state.marqueeMode));
}

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
  addEditorObject(obj);
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

imageFormatView.addEventListener("input", (e) => {
  const span = e.target.closest(".image-format-word");
  if (!span) return;
  const obj = getObjectByElement(span);
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

// ---- Pointer interactions: select, drag, resize, marquee ----
//
// These were bound to mousedown/mousemove/mouseup only, which meant that on the
// iOS build this app is actually shipped as, "Move components" - the feature the
// README leads with - did not work at all. WKWebView synthesizes a click from a
// tap, so tapping a word to edit it worked, which is exactly why the gap went
// unnoticed: the parts that fail silently are dragging to move, dragging the
// resize handle, and marquee selection.
//
// Pointer events cover mouse, touch and stylus in one path, so there is no
// separate touch branch to keep in sync.

// Tracks one pointer from press to release for a drag/resize/marquee gesture.
//
// setPointerCapture is what makes a drag survive leaving the element - without
// it, moving a finger or cursor off the editor surface silently strands the
// gesture mid-drag. Because capture retargets every subsequent event for that
// pointer to the capturing element, the move/up listeners go on the surface
// rather than on document.
//
// pointercancel is not optional on touch: iOS fires it whenever the system takes
// the gesture over (a second finger starting a pinch, an edge swipe, an incoming
// call). It's treated exactly like pointerup - finish the gesture cleanly and
// commit what happened - because the alternative is an object left stuck to a
// finger that is no longer there.
//
// The pointerId check keeps a second finger from driving a gesture the first one
// started.

function trackPointer(e, { onMove, onEnd }) {
  const surface = imageFormatView;
  const pointerId = e.pointerId;

  try {
    surface.setPointerCapture(pointerId);
  } catch {
    // Capture can be refused (a pointer that ended before capture was
    // requested). The gesture still works, it just won't survive leaving the
    // element - strictly better than aborting it.
  }

  function onPointerMove(ev) {
    if (ev.pointerId !== pointerId) return;
    onMove(ev);
  }

  function finish(ev) {
    if (ev.pointerId !== pointerId) return;
    surface.removeEventListener("pointermove", onPointerMove);
    surface.removeEventListener("pointerup", finish);
    surface.removeEventListener("pointercancel", finish);
    try {
      surface.releasePointerCapture(pointerId);
    } catch {
      // Already released (the pointer ended, or capture was never granted).
    }
    onEnd(ev);
  }

  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", finish);
  surface.addEventListener("pointercancel", finish);
}

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
    const moving = objectsFromSelection();
    moving.forEach((o) => {
      const s = starts.get(o.id);
      if (!s) return;
      o.x = clampPosition(s.x + dxPct, o.w);
      o.y = clampPosition(s.y + dyPct, o.h);
      applyObjectStyle(o);
    });
    updateResizeHandle();
    // Only the objects being dragged can have changed, so reconcile just those.
    // This used to be a full pass over every object on every pointer-move tick.
    refreshModifiedStatesFor(moving);
  }

  function onUp() {
    // One full reconciliation at the end of the gesture, not hundreds during it.
    if (moved) refreshModifiedStates();
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

  trackPointer(e, { onMove, onEnd: onUp });
}

function beginResize(e) {
  const obj = getObjectById([...state.selectedObjectIds][0]);
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
    refreshModifiedStatesFor([obj]);
  }

  function onUp() {
    if (changed) {
      refreshModifiedStates();
      pushUndo(preSnapshot);
    }
  }

  trackPointer(e, { onMove, onEnd: onUp });
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
    marqueeBox.style.display = "none";
  }

  trackPointer(e, { onMove, onEnd: onUp });
}

let onSurfaceClickForAdd = null;

export function setAddTextClickHandler(fn) {
  onSurfaceClickForAdd = fn;
}

imageFormatView.addEventListener("pointerdown", (e) => {
  // Left button only for mouse; touch and pen report button 0 too, so this
  // doesn't exclude them.
  if (e.button !== 0) return;
  // Only the first finger down drives a gesture. The second finger of a pinch
  // is a non-primary pointer, and letting it start its own drag is what makes
  // two-finger zoom yank an object across the image.
  if (!e.isPrimary) return;

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

  // Armed marquee wins over everything except the editor's own drag/resize: on a
  // densely recognized image the words cover the surface, so requiring empty
  // space to start from would leave nowhere to begin.
  if (state.marqueeMode && !state.fullEditorMode) {
    e.preventDefault();
    beginMarquee(e, additive);
    return;
  }

  if (objEl) {
    const obj = getObjectByElement(objEl);
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
