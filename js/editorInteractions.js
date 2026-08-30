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
  resizeHandle,
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
  revealFlowPanel,
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
import { hapticLight } from "./haptics.js";


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
    revealFlowPanel(resultText);
    // Marquee mode takes scrolling away from the surface; it must not survive
    // into a view that has no marquee.
    if (state.marqueeMode) setMarqueeMode(false);
  } else {
    revealFlowPanel(imageFormatView);
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
      // Kept explicitly: turning contentEditable off would otherwise drop the
      // span out of the tab order (see createWordObject).
      obj.el.tabIndex = 0;
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
  // On native, the software keyboard's default scroll-into-view is often an
  // abrupt jump, and can undershoot a word near the bottom of the viewport
  // since it doesn't know the keyboard is about to cover it. A deliberate,
  // centered smooth scroll reads as an intentional response to the tap rather
  // than the page lurching once the keyboard finishes animating in. Web-only
  // scroll-into-view behavior (already reasonable there) is left alone.
  if (window.Capacitor?.isNativePlatform?.()) {
    span.scrollIntoView({ behavior: "smooth", block: "center" });
  }
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

// ---- Keyboard path through the editor ----
//
// Move, resize and selection were pointer-only. A keyboard user could edit a
// word's text (contenteditable spans take focus) but could not use the feature
// the product is built around - which is the accessibility gap that matters
// most here, because it isn't a missing label, it's a missing capability.
//
// The bindings are chosen to match what people already expect from any canvas
// or design tool, so there is nothing app-specific to learn:
//
//   Tab / Shift+Tab   move between items (word spans are in the tab order in
//                     both modes now - see setFullEditorMode)
//   Enter / Space     select the focused item
//   Arrows            nudge the selection
//   Shift + arrows    nudge in larger steps
//   Alt + arrows      resize the selection
//   Escape            clear the selection
//   Delete            remove it (already existed)
//
// One nudge is one undo step, but a run of them is not: holding an arrow key
// would otherwise push a hundred snapshots and make Undo useless. See
// commitKeyboardNudge.

// Percent of the image per keypress. The fine step is deliberately small enough
// to align a word by eye; Shift is for crossing the image.
const NUDGE_STEP_PCT = 0.5;
const NUDGE_STEP_COARSE_PCT = 3;
// Multiplier per Alt+arrow press.
const KEYBOARD_RESIZE_STEP = 1.08;
// A run of nudges collapses into one undo entry if they're this close together.
const NUDGE_COALESCE_MS = 800;

let nudgeSnapshot = null;
let nudgeTimer = null;

// Takes a snapshot at the start of a run of keyboard adjustments and pushes it
// once the run stops, so holding an arrow key produces one undo step rather
// than one per repeat.
function commitKeyboardNudge(preSnapshot) {
  if (!nudgeSnapshot) nudgeSnapshot = preSnapshot;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    if (nudgeSnapshot) pushUndo(nudgeSnapshot);
    nudgeSnapshot = null;
    refreshModifiedStates();
  }, NUDGE_COALESCE_MS);
}

function nudgeSelection(dxPct, dyPct) {
  const objects = objectsFromSelection();
  if (!objects.length) return false;
  const preSnapshot = snapshotState();
  objects.forEach((obj) => {
    obj.x = clampPosition(obj.x + dxPct, obj.w);
    obj.y = clampPosition(obj.y + dyPct, obj.h);
    applyObjectStyle(obj);
  });
  updateResizeHandle();
  refreshModifiedStatesFor(objects);
  commitKeyboardNudge(preSnapshot);
  return true;
}

function resizeSelection(factor) {
  const objects = objectsFromSelection();
  if (!objects.length) return false;
  const preSnapshot = snapshotState();
  objects.forEach((obj) => {
    obj.w = clamp(obj.w * factor, MIN_OBJECT_SIZE_PCT, MAX_OBJECT_SIZE_PCT);
    obj.h = clamp(obj.h * factor, MIN_OBJECT_SIZE_PCT, MAX_OBJECT_SIZE_PCT);
    if (obj.type === "word") obj.fontSizePct = Math.max(obj.fontSizePct * factor, MIN_FONT_SIZE_PCT);
    applyObjectStyle(obj);
  });
  updateResizeHandle();
  refreshModifiedStatesFor(objects);
  commitKeyboardNudge(preSnapshot);
  return true;
}

// The resize handle is a real slider now, so it reports where it is. Expressed
// relative to the object's original size, which is the number a user is
// actually adjusting.
export function updateResizeHandleValue() {
  const obj = getObjectById([...state.selectedObjectIds][0]);
  if (!obj || !resizeHandle) return;
  const percent = obj.originalW ? Math.round((obj.w / obj.originalW) * 100) : 100;
  resizeHandle.setAttribute("aria-valuenow", String(percent));
  resizeHandle.setAttribute("aria-valuetext", `${percent} percent`);
}

// Arrow keys on the focused handle resize, matching the slider role it now
// advertises. Handled here rather than in the document-level handler below so
// it works whether or not the editor is in Move mode.
if (resizeHandle) {
  resizeHandle.addEventListener("keydown", (e) => {
    const grow = e.key === "ArrowRight" || e.key === "ArrowUp";
    const shrink = e.key === "ArrowLeft" || e.key === "ArrowDown";
    if (!grow && !shrink) return;
    e.preventDefault();
    if (resizeSelection(grow ? KEYBOARD_RESIZE_STEP : 1 / KEYBOARD_RESIZE_STEP)) updateResizeHandleValue();
  });
}

document.addEventListener("keydown", (e) => {
  if (state.activeMode !== "image" && state.activeMode !== "full") return;

  const active = document.activeElement;
  const editingText = active && active.isContentEditable && !state.fullEditorMode;

  // Enter or Space on a focused word selects it - the keyboard equivalent of
  // clicking it - except while its text is being edited, where Space is a space.
  if ((e.key === "Enter" || e.key === " ") && active && active.classList?.contains("image-format-word")) {
    if (editingText) return;
    const obj = getObjectByElement(active);
    if (!obj) return;
    e.preventDefault();
    if (e.shiftKey) {
      toggleSelection(obj.id);
    } else {
      state.selectedObjectIds.clear();
      state.selectedObjectIds.add(obj.id);
      updateSelectionVisuals();
    }
    return;
  }

  if (!e.key.startsWith("Arrow")) return;
  // Arrow keys inside a word being edited move the caret, which is what a user
  // typing expects; they only move the object once the selection is the subject.
  if (editingText) return;
  if (!state.selectedObjectIds.size) return;

  const step = e.shiftKey ? NUDGE_STEP_COARSE_PCT : NUDGE_STEP_PCT;
  const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
  const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
  if (!dx && !dy) return;

  e.preventDefault();
  if (e.altKey) {
    // Alt turns the same keys into a resize, so there is a keyboard path to
    // resizing without having to reach the handle first.
    if (resizeSelection(dx > 0 || dy > 0 ? KEYBOARD_RESIZE_STEP : 1 / KEYBOARD_RESIZE_STEP)) updateResizeHandleValue();
    return;
  }
  nudgeSelection(dx, dy);
});

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
    hapticLight();
  }

  const startX = e.clientX;
  const startY = e.clientY;
  const rect = imageFormatView.getBoundingClientRect();
  // Captured once, not re-queried per pointermove: the selection doesn't
  // change mid-drag, and the transform-then-commit approach below needs a
  // fixed list of elements to apply/clear the transform on and compute final
  // positions for.
  const moving = objectsFromSelection();
  const starts = new Map();
  moving.forEach((o) => starts.set(o.id, { x: o.x, y: o.y }));
  const preSnapshot = snapshotState();
  const showsResizeHandle = state.fullEditorMode && state.selectedObjectIds.size === 1;
  let moved = false;
  let lastDx = 0;
  let lastDy = 0;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 3) {
      moved = true;
      moving.forEach((o) => {
        o.el.style.willChange = "transform";
      });
      if (showsResizeHandle) resizeHandle.style.willChange = "transform";
    }
    if (!moved) return;
    lastDx = dx;
    lastDy = dy;
    // Position during the gesture is a pure compositor transform, not a
    // percentage-based left/top write - the latter forces a full layout on
    // every pointermove tick, which is the stutter this replaces. obj.x/obj.y
    // (and therefore isWordModified/the inpainted-patch reveal, and clamping
    // to stay on-canvas) only update once, in onUp, from the accumulated
    // delta - see this function's header note in editorObjects.js's
    // revealFlowPanel for the same "commit once on release" idea applied here.
    const transform = `translate(${dx}px, ${dy}px)`;
    moving.forEach((o) => {
      o.el.style.transform = transform;
    });
    if (showsResizeHandle) resizeHandle.style.transform = transform;
  }

  function onUp() {
    if (moved) {
      const dxPct = (lastDx / rect.width) * 100;
      const dyPct = (lastDy / rect.height) * 100;
      moving.forEach((o) => {
        const s = starts.get(o.id);
        o.el.style.transform = "";
        o.el.style.willChange = "";
        if (!s) return;
        o.x = clampPosition(s.x + dxPct, o.w);
        o.y = clampPosition(s.y + dyPct, o.h);
        applyObjectStyle(o);
      });
      if (showsResizeHandle) {
        resizeHandle.style.transform = "";
        resizeHandle.style.willChange = "";
      }
      updateResizeHandle();
      // One full reconciliation at the end of the gesture, not hundreds during it.
      refreshModifiedStates();
      pushUndo(preSnapshot);
      hapticLight();
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
  let lastScale = 1;

  // Same transform-then-commit approach as beginObjectDrag: a live width/
  // fontSize write on every pointermove forces a full layout recompute of
  // this word (and can reflow neighbors); a transform: scale() preview from
  // the object's own top-left - the same corner obj.x/obj.y already anchor
  // the real resize to - does not. The real w/h/fontSizePct are computed from
  // the final scale and committed once, in onUp.
  obj.el.style.transformOrigin = "top left";
  obj.el.style.willChange = "transform";

  function onMove(ev) {
    const dxPct = ((ev.clientX - startX) / rect.width) * 100;
    const dyPct = ((ev.clientY - startY) / rect.height) * 100;
    const scaleX = (startW + dxPct) / startW;
    const scaleY = (startH + dyPct) / startH;
    lastScale = clamp((scaleX + scaleY) / 2, MIN_RESIZE_SCALE, MAX_RESIZE_SCALE);
    changed = true;
    obj.el.style.transform = `scale(${lastScale})`;
    // The resize handle isn't a child of obj.el, so it has no transform of
    // its own to inherit - reading the live (transformed) rect back keeps it
    // glued to the corner during the preview. Cheap here specifically because
    // scale() is a compositor-only change with nothing new to lay out.
    const objRect = obj.el.getBoundingClientRect();
    resizeHandle.style.left = `${((objRect.right - rect.left) / rect.width) * 100}%`;
    resizeHandle.style.top = `${((objRect.bottom - rect.top) / rect.height) * 100}%`;
  }

  function onUp() {
    obj.el.style.transform = "";
    obj.el.style.willChange = "";
    if (changed) {
      obj.w = clamp(startW * lastScale, MIN_OBJECT_SIZE_PCT, MAX_OBJECT_SIZE_PCT);
      obj.h = clamp(startH * lastScale, MIN_OBJECT_SIZE_PCT, MAX_OBJECT_SIZE_PCT);
      if (obj.type === "word") {
        obj.fontSizePct = Math.max(startFontSizePct * lastScale, MIN_FONT_SIZE_PCT);
      }
      applyObjectStyle(obj);
      updateResizeHandle();
      refreshModifiedStates();
      pushUndo(preSnapshot);
      hapticLight();
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
