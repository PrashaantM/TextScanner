// editorInteractions.js: everything the user does to the editor with a pointer,
// keyboard or mode button - view switching, paste-placement mode, copy/paste
// (Phase 2), and the select/edit/drag/resize/marquee gestures themselves.
// Move-components and Select multiple are not separate persistent modes
// (UI-REDESIGN-PLAN.md §2.3): dragging a word's move-handle (which appears on
// selection next to resize-handle) or its own body once selected (Phase 1b)
// moves the selection, and a press-and-hold-then-drag starting on empty canvas
// starts a marquee - both transient gestures, not modes you explicitly step
// into and out of. A single click/tap selects a word without editing it; a
// double click/tap edits it (Phase 1a) - New text, the one persistent
// placement mode this file used to also own, was deleted in Phase 3.
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
  moveHandle,
  imageFormatBg,
  marqueeBox,
  imageFormatHint,
  editorToolbar,
  undoRedoGroup,
  textClipboardMenu,
  textClipboardMenuBackdrop,
  filterToggleRow,
} from "./dom.js";
import { state } from "./state.js";
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
  updateMoveHandle,
  updateDeleteButton,
  refreshModifiedStates,
  refreshModifiedStatesFor,
  refitWordFontSize,
  registerModeReset,
  syncWordEditability,
} from "./editorObjects.js";
import { hapticLight } from "./haptics.js";


const MIN_OBJECT_SIZE_PCT = 1.5;

const MAX_OBJECT_SIZE_PCT = 400;

const MIN_RESIZE_SCALE = 0.2;

const MAX_RESIZE_SCALE = 6;

const MIN_FONT_SIZE_PCT = 0.5;

// ---- Mode switching (Text / Image format / Full image) ----

export function setMode(mode) {
  state.activeMode = mode;
  // Full image mode is the only one with a selected/editing split (see
  // syncWordEditability in editorObjects.js) - leaving it always exits
  // whatever was being edited, and the sweep below re-syncs every word's
  // contentEditable for the new mode in one pass (Image format/Text mode
  // want every word editable again; Full mode wants none, unless one is
  // still mid-edit, which the line above already ruled out).
  if (mode !== "full") state.editingObjectId = null;
  state.editorObjects.forEach(syncWordEditability);
  setActiveButton(modeButtons, (btn) => btn.dataset.mode === mode);

  hide(resultText);
  hide(imageFormatView);
  hide(imageFormatHint);
  hide(editorToolbar);

  // Phase 3: the filter set only makes sense in Text mode (it drives what
  // the Text textarea shows; Image format/Full image have no textarea to
  // filter, only word-dimming, which state.activeFilterLevel keeps driving
  // regardless of this control's visibility - see main.js's filterTextHook).
  // hide() already sets display:none, which alone removes it from the
  // accessibility tree, tab order and hit-testing - inert is set too,
  // redundantly, so "not just visually hidden" is unambiguous on sight.
  if (mode === "text") {
    show(filterToggleRow);
    filterToggleRow.inert = false;
  } else {
    hide(filterToggleRow);
    filterToggleRow.inert = true;
  }

  if (mode === "text") {
    revealFlowPanel(resultText);
    // Marquee takes scrolling away from the surface while it's actively being
    // drawn; it must not survive into a view that has no marquee.
    if (state.marqueeMode) setMarqueeMode(false);
    if (state.pasteArmed) setPasteArmed(false);
  } else {
    revealFlowPanel(imageFormatView);
    show(imageFormatHint);
    imageFormatView.classList.toggle("show-bg", mode === "full");

    if (mode === "full") {
      show(editorToolbar);
      show(undoRedoGroup);
    } else {
      hide(undoRedoGroup);
      if (state.pasteArmed) setPasteArmed(false);
    }
  }

  updateUndoRedoButtons();
  updateDeleteButton();
  updateResizeHandle();
  updateMoveHandle();
  updateImageFormatHint();
  document.dispatchEvent(new CustomEvent("mode-changed", { detail: { mode } }));
}

modeTextBtn.addEventListener("click", () => setMode("text"));

modeImageBtn.addEventListener("click", () => setMode("image"));

modeFullBtn.addEventListener("click", () => setMode("full"));

export function updateImageFormatHint() {
  if (state.pasteArmed) {
    imageFormatHint.textContent = "Tap anywhere on the image to paste the copied text there.";
    return;
  }
  if (state.activeMode === "image") {
    imageFormatHint.textContent =
      "Text is positioned where it appeared in the source image. Tap a word to edit it, or press and hold empty space and drag to select several.";
  } else if (state.activeMode === "full") {
    imageFormatHint.textContent =
      "The full image is shown with editable text on top. Tap a word to edit it or select it \u2014 drag its move-handle to reposition it, or its corner handle to resize. Press and hold empty space and drag to select several. Press Delete to remove the selection.";
  }
}

// Registered with editorObjects.js so clearImageFormatView can leave any
// in-progress marquee/paste gesture without that module importing this one.
// See registerModeReset there for why the edge goes this way round.
registerModeReset(() => {
  setMarqueeMode(false);
  setPasteArmed(false);
  state.editingObjectId = null;
});

// ---- Marquee (rubber-band) selection ----
//
// On a mouse this was never a mode: shift-drag, or drag on empty space, and the
// marquee appears. Touch has neither - there is no shift key, and a plain drag
// is how the page scrolls, so the surface has to give scrolling up while a
// marquee is actually being drawn (see .marquee-mode's touch-action in
// style.css). A press-and-hold-then-drag starting on empty canvas is what
// arms it now (see beginCanvasPressHold below) - not a persistent toggle
// button - mirroring the same fast-drag-scrolls/held-drag-escalates pattern
// the library view's card swipe/long-press already uses (UI-REDESIGN-PLAN.md
// \u00a72.3, \u00a71.1).
//
// Deliberately does NOT start on top of a word - that disambiguation (what
// the press landed on) is decided once, at pointerdown, by the dispatcher
// below, the same way it already decides word vs. resize-handle vs. canvas.

export function setMarqueeMode(on) {
  state.marqueeMode = on;
  imageFormatView.classList.toggle("marquee-mode", on);
  updateImageFormatHint();
}

// ---- Paste-placement mode (UI-REDESIGN-PLAN.md §2.2) ----

let onSurfaceClickForPaste = null;

export function setPasteClickHandler(fn) {
  onSurfaceClickForPaste = fn;
}

export function setPasteArmed(on) {
  state.pasteArmed = on;
  imageFormatView.classList.toggle("paste-armed", on);
  // No button to label any more (Phase 2 - armed by Ctrl/Cmd+V or the touch
  // clipboard menu's Paste, not a button click); updateImageFormatHint below
  // is the only user-facing signal that placement is armed.
  updateImageFormatHint();
}

// ---- Copy/paste (Phase 2): Ctrl/Cmd+C/V on a selected, non-editing word in
// Full image mode, or the press-and-hold touch menu above. Text mode's own
// Ctrl/Cmd+V (whole-result replace) is wired by main.js via
// setTextPasteReplaceHandler below - this module owns selection state, not
// the extracted-text buffer, so it only dispatches to a registered hook
// rather than reading resultText itself. ----

function copySelectedElement() {
  if (state.activeMode !== "full" || state.selectedObjectIds.size !== 1) return false;
  const obj = getObjectById([...state.selectedObjectIds][0]);
  if (!obj || obj.type !== "word") return false;
  state.copiedElement = {
    text: obj.el.textContent,
    fontSizePct: obj.fontSizePct,
    w: obj.w,
    h: obj.h,
    textColor: obj.textColor,
    textBackgroundColor: obj.textBackgroundColor,
    needsBackingBox: obj.needsBackingBox,
    fontClass: obj.fontClass,
    rotationDeg: obj.rotationDeg,
  };
  // Best-effort cross-app interop: the font/size/colour above only round-trip
  // within this app (via state.copiedElement); the plain text is what a
  // paste into another app would get. Never awaited/blocking - a clipboard
  // permission prompt or a private-browsing failure must not stop the copy
  // this app itself just recorded.
  navigator.clipboard?.writeText(obj.el.textContent).catch(() => {});
  return true;
}

function pasteCopiedElement() {
  if (state.activeMode !== "full" || !state.copiedElement) return false;
  setPasteArmed(true);
  return true;
}

// The placement click itself is the existing arm-then-place flow
// (setPasteClickHandler/onSurfaceClickForPaste, wired by the pointerdown
// dispatcher below) - self-registered here since, unlike the old OS-
// clipboard-text path, cloning no longer needs anything main.js owns.
setPasteClickHandler((xPct, yPct) => {
  if (state.copiedElement) addClonedTextObject(xPct, yPct, state.copiedElement);
});

function closeClipboardMenu() {
  textClipboardMenu.classList.add("hidden");
  textClipboardMenuBackdrop.classList.add("hidden");
}

function openClipboardMenu(x, y) {
  // Paste is omitted, not just disabled, when nothing has been copied yet -
  // an item that does nothing when pressed is worse than one that isn't there.
  const pasteItem = textClipboardMenu.querySelector('[data-clipboard-action="paste"]');
  if (pasteItem) pasteItem.closest("li").hidden = !state.copiedElement;
  textClipboardMenu.style.setProperty("--menu-x", `${x}px`);
  textClipboardMenu.style.setProperty("--menu-y", `${y}px`);
  textClipboardMenu.classList.remove("hidden");
  textClipboardMenuBackdrop.classList.remove("hidden");
}

textClipboardMenu.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-clipboard-action]");
  if (!button) return;
  closeClipboardMenu();
  if (button.dataset.clipboardAction === "copy") copySelectedElement();
  else pasteCopiedElement();
});
// pointerdown, not click: the long-press gesture that OPENS this menu ends in
// its own touchend, which synthesizes a compatibility click at the original
// press point - exactly where the now-visible, viewport-covering backdrop
// sits. A click listener here would catch that same release and close the
// menu the instant it opened. pointerdown only fires on a genuinely NEW
// press, which is what "dismissed on outside tap" actually means.
textClipboardMenuBackdrop.addEventListener("pointerdown", closeClipboardMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !textClipboardMenu.classList.contains("hidden")) closeClipboardMenu();
});

let onTextPasteReplace = null;

// Registered by main.js, which owns the extracted-text buffer and the
// destructive-replace confirm dialog - this module only knows selection and
// mode, not what Text mode's result actually contains.
export function setTextPasteReplaceHandler(fn) {
  onTextPasteReplace = fn;
}

// meta = event.metaKey || event.ctrlKey handles Mac/PC in one check (only
// one of the two is ever meaningful on a given OS), so there is no separate
// platform-sniffing branch anywhere in this handler.
document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (!meta || (key !== "c" && key !== "v")) return;
  // A word actively being edited (Full mode's editingObjectId) or any word
  // in Image format mode (permanently editable there) must keep doing normal
  // in-place text-selection copy/paste - untouched, not intercepted.
  if (document.activeElement?.isContentEditable) return;

  if (state.activeMode === "text") {
    // Ctrl/Cmd+C: no interception needed, native selection-copy on the
    // (selectable, if read-only) textarea already works.
    if (key === "v" && onTextPasteReplace) {
      e.preventDefault();
      onTextPasteReplace();
    }
    return;
  }
  if (state.activeMode !== "full") return;
  if (key === "c") {
    if (copySelectedElement()) e.preventDefault();
  } else if (pasteCopiedElement()) {
    e.preventDefault();
  }
});

// Paste's placement click (UI-REDESIGN-PLAN.md §2.2) places a new
// origin:'user' word at the tapped point, cloned from the copied element,
// selects it, and focuses it for immediate editing. If the user taps away
// without changing anything, the placement is silently undone instead of
// leaving an invisible empty box in editorObjects/undo history - the
// pre-filled clone text counts as "typed" for this purpose, since discarding
// a pasted word the moment you tap away from it would be a surprising way to
// lose it. New text, the tool this used to also serve, was deleted in Phase 3.

// Shared by placeUserWord's pre-filled clone text and the dblclick edit-entry
// handler below - both want the caret at the end, not the start.
function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// The shared placement mechanics behind addClonedTextObject below (Phase
// 2's paste - the only caller left since New text, the other one, was
// deleted in Phase 3): undo, selection, focus, the discard-if-never-typed-
// into blur handler.
function placeUserWord(xPct, yPct, { text = "", fontSizePct, w, h, textColor = null, textBackgroundColor = null, needsBackingBox = false, fontClass = "regular", rotationDeg = 0 }) {
  const preSnapshot = snapshotState();

  const obj = createWordObject({
    text,
    x: clampPosition(xPct, w),
    y: clampPosition(yPct, h),
    w,
    h,
    fontSizePct,
    rotationDeg,
    origin: "user",
    confidence: null,
    bbox: null,
    fontClass,
  });
  obj.textColor = textColor;
  obj.textBackgroundColor = textBackgroundColor;
  obj.needsBackingBox = needsBackingBox;
  addEditorObject(obj);
  applyObjectStyle(obj);

  pushUndo(preSnapshot);
  state.selectedObjectIds.clear();
  state.selectedObjectIds.add(obj.id);
  updateSelectionVisuals();
  refreshModifiedStates();
  setPasteArmed(false);

  // A freshly placed word goes straight into edit mode (Full image mode's
  // selected/editing split doesn't apply here - the whole point of placing
  // one is to type into it immediately), so syncWordEditability must see
  // editingObjectId set before contentEditable is read via .focus() below.
  state.editingObjectId = obj.id;
  syncWordEditability(obj);
  obj.el.focus();
  if (text) {
    // Caret at the end of the placed text, not the start - matches where a
    // caret lands after any other paste.
    placeCaretAtEnd(obj.el);
  }

  const onBlur = () => {
    obj.el.removeEventListener("blur", onBlur);
    if (obj.el.textContent.trim() !== "") return;
    if (state.undoStack[state.undoStack.length - 1] === preSnapshot) {
      state.undoStack.pop();
      updateUndoRedoButtons();
    }
    removeUserWordObject(obj);
  };
  obj.el.addEventListener("blur", onBlur);

  return obj;
}

// Phase 2's paste: clones the copied element's own resolved font, size and
// colour (state.copiedElement, set by copySelectedElement below) - a pasted
// clone should look like the thing that was copied.
export function addClonedTextObject(xPct, yPct, cloneData) {
  return placeUserWord(xPct, yPct, {
    text: cloneData.text,
    fontSizePct: cloneData.fontSizePct,
    w: cloneData.w,
    h: cloneData.h,
    textColor: cloneData.textColor,
    textBackgroundColor: cloneData.textBackgroundColor,
    needsBackingBox: cloneData.needsBackingBox,
    fontClass: cloneData.fontClass,
    rotationDeg: cloneData.rotationDeg,
  });
}

// Fully removes a user-added word (unlike deleting an OCR word, which just
// clears its text and reveals an inpainted patch - a user word has no
// underlying image content to reveal, so there's nothing to keep around).

imageFormatView.addEventListener("input", (e) => {
  const span = e.target.closest(".image-format-word");
  if (!span) return;
  const obj = getObjectByElement(span);
  if (!obj) return;
  // Retyping changes which glyphs are on the page, and how tall a string
  // renders depends on exactly that - an all-caps word is cap height, "energy"
  // spans ascender to descender. The size was fixed at scan time from the
  // recognized text and never revisited, so the replacement came out at a
  // height that belonged to the word it replaced. See refitWordFontSize.
  refitWordFontSize(obj);
  refreshModifiedStates();
});

// Direct contenteditable text edits (typing into a word) aren't covered by
// the drag/resize undo pushes above. Capture a snapshot on focus and push it
// on blur, but only if the text actually changed during that session -
// otherwise every stray click into a word would pollute the undo stack.

let editingSpan = null;

let editingOriginalText = null;

let editingPreSnapshot = null;

imageFormatView.addEventListener("focusin", (e) => {
  const span = e.target.closest(".image-format-word");
  if (!span) return;
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
  // Full image mode: losing focus on the word that was actually in edit mode
  // (not just selected - a merely-selected word also passes through this
  // handler on blur, but never matches editingObjectId) exits edit mode and
  // flips it back to non-editable, so the next plain click on it only selects.
  if (state.activeMode === "full") {
    const obj = getObjectByElement(editingSpan);
    if (obj && obj.id === state.editingObjectId) {
      state.editingObjectId = null;
      syncWordEditability(obj);
    }
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
//   Tab / Shift+Tab   move between items (word spans are always in the tab
//                     order - see createWordObject in editorObjects.js)
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
  updateMoveHandle();
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
    if (obj.type === "word") {
      obj.fontSizePct = Math.max(obj.fontSizePct * factor, MIN_FONT_SIZE_PCT);
      // Same reason as the pointer resize: a size the user picked, by keyboard
      // this time, outranks the measured refit on the next retype.
      obj.fontSizeLocked = true;
    }
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
  // Image format mode has no selected/editing split (every word stays
  // contentEditable, unchanged), so a focused word there is an editing caret,
  // full stop. Full image mode does now have that split (Phase 1: a single
  // click/tap selects; a double click/tap edits) - this comment used to claim
  // "no separate focused-but-not-editing DOM state exists," which was true of
  // the model that got replaced and is not true any more: contentEditable now
  // tracks state.editingObjectId (see syncWordEditability), not mere focus, so
  // isContentEditable correctly tells the two states apart in both modes.
  const editingText = active && active.isContentEditable;

  // Enter or Space on a focused-but-not-editing word selects it - the
  // keyboard equivalent of a single tap - except Space while its text is
  // being edited, where Space must stay a literal space. Enter on a word
  // that's ALREADY the sole selection enters edit mode instead of redundantly
  // re-selecting it - the keyboard equivalent of a double tap/click, so a
  // keyboard-only user keeps a way to start typing into a Full-mode word now
  // that contentEditable is no longer on unconditionally there.
  if (active && active.classList?.contains("image-format-word") && (e.key === "Enter" || (e.key === " " && !editingText))) {
    const obj = getObjectByElement(active);
    if (!obj) return;
    e.preventDefault();
    if (e.shiftKey) {
      toggleSelection(obj.id);
    } else if (
      e.key === "Enter" &&
      state.activeMode === "full" &&
      state.selectedObjectIds.size === 1 &&
      state.selectedObjectIds.has(obj.id)
    ) {
      state.editingObjectId = obj.id;
      syncWordEditability(obj);
      placeCaretAtEnd(obj.el);
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

// Drags the current selection - reached from move-handle, and (Phase 1b,
// replacing an earlier restriction to move-handle only) from pressing
// anywhere on an already-selected word or obj-bg's own body. Pressing the
// body of something NOT yet selected still just selects it - see the
// pointerdown dispatcher below - so this is only ever armed on a second
// press, after selection, matching "drag from the selected state." That
// ordering is also what keeps a plain, un-moved click on an already-selected
// word from racing the browser's native text-selection handling: the word is
// contentEditable="false" at rest under the Phase 1 model (see
// syncWordEditability), so there is no text to start selecting in the first
// place until a double click deliberately enters edit mode. contentEditable
// still comes off the moving words for the live duration of the drag itself
// below (irrelevant for a non-editing word, but harmless, and still needed
// for the case where the drag interrupts an in-progress edit) - restored via
// syncWordEditability on release rather than unconditionally, since "restore
// to editable" is no longer correct on its own: it's only correct if the word
// is still state.editingObjectId, same "commit once on release" shape as the
// transform-then-commit positioning below and as beginResize's own
// scale-then-commit.
function beginObjectDrag(e) {
  const moving = objectsFromSelection();
  if (!moving.length) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const rect = imageFormatView.getBoundingClientRect();
  const starts = new Map();
  moving.forEach((o) => starts.set(o.id, { x: o.x, y: o.y }));
  const preSnapshot = snapshotState();
  const showsResizeHandle = state.activeMode === "full" && state.selectedObjectIds.size === 1;
  let moved = false;
  let lastDx = 0;
  let lastDy = 0;

  moving.forEach((o) => {
    if (o.type === "word") o.el.contentEditable = "false";
  });

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 3) {
      moved = true;
      moving.forEach((o) => {
        o.el.style.willChange = "transform";
      });
      if (showsResizeHandle) resizeHandle.style.willChange = "transform";
      moveHandle.style.willChange = "transform";
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
    moveHandle.style.transform = transform;
  }

  function onUp() {
    moving.forEach((o) => syncWordEditability(o));
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
      moveHandle.style.transform = "";
      moveHandle.style.willChange = "";
      updateResizeHandle();
      updateMoveHandle();
      // One full reconciliation at the end of the gesture, not hundreds during it.
      refreshModifiedStates();
      pushUndo(preSnapshot);
      hapticLight();
    }
  }

  trackPointer(e, { onMove, onEnd: onUp });
}

// The "pending" phase of a Phase 1b body-drag on an already-selected word:
// mirrors beginCanvasPressHold's own "adds no listener that could intercept
// anything ... until the gesture actually escalates" rule (see that
// function's comment). Calling beginObjectDrag directly from pointerdown
// would call setPointerCapture immediately - and pointer capture retargets
// the compatibility click event for that pointer to the capturing element,
// which silently broke double click detection on a word: the second
// pointerdown of a double click always lands in this branch (the first
// click already selected the word), so capturing on it meant e.target for
// the resulting dblclick was #image-format-view, never the word, and the
// dblclick handler below's `.closest(".image-format-word")` check always
// missed. Waiting for real movement before calling beginObjectDrag (which
// captures internally, via trackPointer) is what keeps a plain click/double
// click from ever triggering capture at all.
//
// Also races a Phase 2 long-press, touch/pen only (matching every other
// press-and-hold gesture in this app - see beginCanvasPressHold and
// js/radialMenu.js's own call sites, all gated the same way): whichever of
// movement (-> drag), the hold timer (-> the copy/paste menu) or a plain
// release (-> nothing) happens first wins: the other two never fire.
const CLIPBOARD_MENU_HOLD_MS = 420;

function beginPendingBodyDrag(e) {
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;

  function cleanup() {
    imageFormatView.removeEventListener("pointermove", onPendingMove);
    imageFormatView.removeEventListener("pointerup", onPendingUp);
    imageFormatView.removeEventListener("pointercancel", onPendingUp);
    clearTimeout(holdTimer);
  }
  function onPendingMove(ev) {
    if (ev.pointerId !== pointerId) return;
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) {
      cleanup();
      beginObjectDrag(e);
    }
  }
  function onPendingUp(ev) {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    // Released without moving - the word stays selected, same as a plain
    // click on something already selected would leave it.
  }
  const holdTimer =
    e.pointerType !== "mouse"
      ? setTimeout(() => {
          cleanup();
          hapticLight();
          openClipboardMenu(startX, startY);
        }, CLIPBOARD_MENU_HOLD_MS)
      : null;
  imageFormatView.addEventListener("pointermove", onPendingMove);
  imageFormatView.addEventListener("pointerup", onPendingUp);
  imageFormatView.addEventListener("pointercancel", onPendingUp);
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
        // The user has chosen a size; retyping must not quietly take it back.
        obj.fontSizeLocked = true;
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

// The "armed" phase of a marquee: only reached once beginCanvasPressHold's
// hold timer has actually fired (see below). state.marqueeMode is true for
// exactly the live duration of this drag - not a standing mode - which is
// what lets the surface give touch-scrolling back the instant it ends.
function beginMarquee(e, additive, startX, startY) {
  if (!additive) clearSelection();
  setMarqueeMode(true);

  const rect = imageFormatView.getBoundingClientRect();
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
      // The background image object (obj-bg) exists even in Image format
      // mode, where its element is display:none (the photo is never shown
      // there) - which means its getBoundingClientRect() is the same
      // 0,0,0,0 a retired word's is, and the exact same false-positive the
      // next line exists to avoid: a marquee dragged from the very top-left
      // of the surface would still "intersect" it. Marquee is unlikely to
      // even reach this far in Full image mode at all now that the photo is
      // a selectable object again (a press on it goes to the dispatcher's
      // objEl branch instead - see test/touch-interactions.js for whether
      // that leaves marquee reachable there at all), so this mostly matters
      // for Image format mode in practice.
      if (obj.type === "image") return;
      // A retired word is display:none, so its rect is 0,0,0,0 - which a marquee
      // dragged from the very top-left of the surface would still "intersect".
      // Skipping it explicitly is cheaper than reasoning about that every time.
      if (obj.removed) return;
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
    setMarqueeMode(false);
  }

  trackPointer(e, { onMove, onEnd: onUp });
}

// The "pending" phase: a press on empty canvas that MIGHT become a marquee.
// Mirrors the library card's own long-press-vs-swipe split (§1.1) and the
// phase-2 prototype's verified timing - see UI-REDESIGN-PLAN.md §2.3. Adds no
// listener that could intercept anything (no preventDefault, no capture,
// no touch-action change) until the hold timer actually fires, so a quick
// drag below the threshold is indistinguishable from an ordinary scroll/pan
// and the browser keeps driving it exactly as it does today.
const MARQUEE_HOLD_MS = 420;
const MARQUEE_MOVE_THRESHOLD_PX = 10;

function beginCanvasPressHold(e, additive) {
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;

  function cleanupPending() {
    imageFormatView.removeEventListener("pointermove", pendingMove);
    imageFormatView.removeEventListener("pointerup", pendingUp);
    imageFormatView.removeEventListener("pointercancel", pendingUp);
  }
  function pendingMove(ev) {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) > MARQUEE_MOVE_THRESHOLD_PX) {
      clearTimeout(timer);
      cleanupPending();
    }
  }
  function pendingUp(ev) {
    if (ev.pointerId !== pointerId) return;
    clearTimeout(timer);
    cleanupPending();
  }
  imageFormatView.addEventListener("pointermove", pendingMove);
  imageFormatView.addEventListener("pointerup", pendingUp);
  imageFormatView.addEventListener("pointercancel", pendingUp);

  const timer = setTimeout(() => {
    cleanupPending();
    hapticLight();
    beginMarquee(e, additive, startX, startY);
  }, MARQUEE_HOLD_MS);
}

imageFormatView.addEventListener("pointerdown", (e) => {
  // Left button only for mouse; touch and pen report button 0 too, so this
  // doesn't exclude them.
  if (e.button !== 0) return;
  // Only the first finger down drives a gesture. The second finger of a pinch
  // is a non-primary pointer, and letting it start its own drag is what makes
  // two-finger zoom yank an object across the image.
  if (!e.isPrimary) return;

  // Every branch below that acts on an object (drag/resize/paste-placement)
  // calls preventDefault() to stop native text selection/drag - which has the
  // side effect of also suppressing the browser's normal focus-blur transfer.
  // Without this, clicking away from an actively-edited contentEditable word
  // (e.g. a freshly-pasted word still being typed into) would never blur it.
  if (document.activeElement && document.activeElement !== e.target && document.activeElement.isContentEditable) {
    document.activeElement.blur();
  }

  const moveHandleEl = e.target.closest(".move-handle");
  if (moveHandleEl && state.activeMode === "full" && state.selectedObjectIds.size > 0) {
    e.preventDefault();
    beginObjectDrag(e);
    return;
  }

  const resizeHandleEl = e.target.closest(".resize-handle");
  if (resizeHandleEl && state.activeMode === "full") {
    e.preventDefault();
    beginResize(e);
    return;
  }

  if (state.activeMode === "full" && state.pasteArmed) {
    const onSurface = e.target === imageFormatView || e.target === imageFormatBg;
    if (onSurface) {
      e.preventDefault();
      const rect = imageFormatView.getBoundingClientRect();
      const xPct = ((e.clientX - rect.left) / rect.width) * 100;
      const yPct = ((e.clientY - rect.top) / rect.height) * 100;
      if (onSurfaceClickForPaste) onSurfaceClickForPaste(xPct, yPct);
      return;
    }
  }

  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  // .image-format-bg is included on purpose: the background photo is a real
  // selectable/moveable object here (obj-bg, type "image", still built by
  // renderImageFormatView in js/editorObjects.js), matching the README's
  // "moving and resizing the text and the image itself, freely and
  // independently." It only ever matches in Full image mode - Image format
  // mode's .image-format-bg is display:none (see style.css), so it can't be
  // pressed there regardless of this selector - and only once
  // .image-format-view.show-bg grants it pointer-events (see style.css).
  const objEl = e.target.closest(".image-format-word, .image-format-bg");

  if (objEl) {
    const obj = getObjectByElement(objEl);
    if (!obj) return;

    if (additive) {
      e.preventDefault();
      toggleSelection(obj.id);
      return;
    }

    // Phase 1: a single click/tap SELECTS ONLY, never edits - replacing an
    // earlier model where a tap both selected and edited a word in one motion
    // (UI-REDESIGN-PLAN.md §2.3). Text stays non-editable at rest
    // (syncWordEditability), so there is no caret to place and no
    // preventDefault needed to suppress one. A double click/tap (see the
    // dblclick handler below) is what now enters edit mode - which is also
    // exactly why the branch below defers to beginPendingBodyDrag rather
    // than beginObjectDrag directly: see that function's own comment for why
    // capturing the pointer immediately here would silently break double
    // click detection on the second click of the pair.
    //
    // A press on a word that is ALREADY the sole selection may be the start
    // of a body-drag instead (Phase 1b: dragging works from anywhere on the
    // selected element's body, not only move-handle/resize-handle) - and a
    // plain click that lands here and never moves reads identically to
    // reselecting the same thing.
    if (state.activeMode === "full" && obj.type === "word" && state.selectedObjectIds.size === 1 && state.selectedObjectIds.has(obj.id)) {
      beginPendingBodyDrag(e);
      return;
    }

    // In Full image mode this also reveals move-handle/resize-handle
    // immediately rather than only once a separate mode button had been
    // pressed first (UI-REDESIGN-PLAN.md §2.3). Image format mode keeps
    // today's behaviour for words, where a plain tap does not touch the
    // selection at all (only shift-click/additive does) - nothing about that
    // was part of the named flaw, and Image format has no handles to reveal
    // anyway (its background is never shown, so obj-bg can't be reached
    // there regardless).
    if (state.activeMode === "full") {
      state.selectedObjectIds.clear();
      state.selectedObjectIds.add(obj.id);
      updateSelectionVisuals();
    } else {
      clearSelection();
    }
    return;
  }

  // Empty canvas: a press-and-hold-then-drag starts a marquee; a quick drag
  // keeps scrolling/panning exactly as it does today. Available in both
  // Image format and Full image, matching where selection already applied
  // before this redesign. In Full image mode specifically, the background
  // photo now absorbs presses again (the branch above), the same as every
  // other pre-redesign build - see test/touch-interactions.js for whether
  // that leaves this reachable there at all, checked rather than assumed.
  if (state.activeMode === "image" || state.activeMode === "full") {
    beginCanvasPressHold(e, additive);
  }
});

// Phase 1: double click/tap enters edit mode in Full image mode (a single
// click there only selects - see the pointerdown dispatcher above). Image
// format mode is untouched: its words stay permanently editable, so a plain
// click there already edits, same as before this phase.
imageFormatView.addEventListener("dblclick", (e) => {
  if (state.activeMode !== "full") return;
  const span = e.target.closest(".image-format-word");
  if (!span) return;
  const obj = getObjectByElement(span);
  if (!obj) return;
  e.preventDefault();
  state.selectedObjectIds.clear();
  state.selectedObjectIds.add(obj.id);
  updateSelectionVisuals();
  state.editingObjectId = obj.id;
  syncWordEditability(obj);
  obj.el.focus();
  placeCaretAtEnd(obj.el);
});
