// script.js: all client-side behavior for TextScanner.
// Looks up the DOM elements defined in index.html, wires up their event listeners
// (file input, drag-and-drop, paste, camera capture, buttons), runs OCR on the chosen
// image via the Tesseract.js worker (loaded globally by the CDN <script> tag in
// index.html before this file), and renders the recognized text into the results
// panel in three modes: a plain text view, an "Image format" view that lays each
// recognized word out at its original position on a blank surface, and a "Full
// image" view that overlays editable words on the source image with drag/resize
// and undo/redo support. style.css supplies the appearance for everything this
// file creates or toggles.
(() => {
  "use strict";

  // ---- Element references, matched to the ids/classes in index.html ----

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const cameraBtn = document.getElementById("camera-btn");
  const cameraInput = document.getElementById("camera-input");
  const sampleBtn = document.getElementById("sample-btn");

  const previewSection = document.getElementById("preview-section");
  const previewImg = document.getElementById("preview-img");
  const scanBtn = document.getElementById("scan-btn");
  const resetBtn = document.getElementById("reset-btn");

  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");

  const statusSection = document.getElementById("status-section");

  const resultSection = document.getElementById("result-section");
  const resultText = document.getElementById("result-text");
  const copyBtn = document.getElementById("copy-btn");
  const downloadBtn = document.getElementById("download-btn");
  const downloadImageBtn = document.getElementById("download-image-btn");
  const modeTextBtn = document.getElementById("mode-text-btn");
  const modeImageBtn = document.getElementById("mode-image-btn");
  const modeFullBtn = document.getElementById("mode-full-btn");
  const modeButtons = [modeTextBtn, modeImageBtn, modeFullBtn];
  const imageFormatView = document.getElementById("image-format-view");
  const imageFormatBg = document.getElementById("image-format-bg");
  const resizeHandle = document.getElementById("resize-handle");
  const marqueeBox = document.getElementById("marquee-box");
  const imageFormatHint = document.getElementById("image-format-hint");
  const editorToolbar = document.getElementById("editor-toolbar");
  const editorModeBtn = document.getElementById("editor-mode-btn");
  const undoRedoGroup = document.getElementById("undo-redo-group");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");

  // ---- Constants and shared mutable state ----

  const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
  const MAX_UNDO_STEPS = 100;
  // Tesseract's word bbox height (used directly as a CSS font-size) renders visibly
  // larger than the source text, since a font's em-box is taller than its ink height.
  const FONT_SIZE_CORRECTION = 0.8;
  let currentFile = null;
  let currentObjectUrl = null;
  let activeMode = "text";
  let imageFormatLines = []; // array of arrays of word span elements, grouped by line
  let lastNaturalWidth = 0;
  let lastNaturalHeight = 0;

  // Image format / Full image shared state: every word span and the background
  // image are "objects" that can be selected, and (in full editor mode) moved and resized.
  let editorObjects = []; // { id, type: 'word' | 'image', x, y, w, h, fontSizePct, el, ... }
  let objectIdCounter = 0;
  const selectedObjectIds = new Set();
  let fullEditorMode = false;
  let undoStack = [];
  let redoStack = [];

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  // Keep at least a sliver of an object within the container while dragging, without
  // pinning full-bleed objects (like a background image at 100% size) in place.
  const MIN_VISIBLE_PCT = 5;
  function clampPosition(value, size) {
    return clamp(value, MIN_VISIBLE_PCT - size, 100 - MIN_VISIBLE_PCT);
  }

  // Removes the shared "hidden" utility class (see style.css) from an element.
  function show(el) {
    el.classList.remove("hidden");
  }

  // Adds the shared "hidden" utility class to an element.
  function hide(el) {
    el.classList.add("hidden");
  }

  // Writes a message into status-section and toggles its error/success styling.
  // Called throughout for user-facing feedback (bad file, scan errors, scan success).
  // Passing an empty message hides the section instead.
  function setStatus(message, kind) {
    statusSection.textContent = message;
    statusSection.classList.remove("status--error", "status--success");
    if (!message) {
      hide(statusSection);
      return;
    }
    if (kind) {
      statusSection.classList.add(`status--${kind}`);
    }
    show(statusSection);
  }

  // Clears any previous OCR output and returns the results UI to its initial state.
  // Called when a new image is loaded or the user resets, before a new scan runs.
  function resetResult() {
    resultText.value = "";
    hide(resultSection);
    setStatus("");
    hide(progressSection);
    progressFill.style.width = "0%";
    clearImageFormatView();
    setMode("text");
  }

  // ---- Mode switching (Text / Image format / Full image) ----

  // Switches between the "text", "image" (Image format), and "full" (Full image)
  // result views. Triggered by the three mode-toggle buttons; updates their active
  // state, shows/hides the relevant result elements, and updates activeMode.
  function setMode(mode) {
    activeMode = mode;
    modeButtons.forEach((btn) => {
      const isActive = btn.dataset.mode === mode;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });

    hide(resultText);
    hide(imageFormatView);
    hide(imageFormatHint);
    hide(editorToolbar);
    hide(downloadImageBtn);

    if (mode === "text") {
      show(resultText);
      return;
    }

    show(imageFormatView);
    show(imageFormatHint);
    show(downloadImageBtn);
    imageFormatView.classList.toggle("show-bg", mode === "full");

    if (mode === "full") {
      show(editorToolbar);
    } else if (fullEditorMode) {
      setFullEditorMode(false);
    }

    updateImageFormatHint();
  }

  modeTextBtn.addEventListener("click", () => setMode("text"));
  modeImageBtn.addEventListener("click", () => setMode("image"));
  modeFullBtn.addEventListener("click", () => setMode("full"));

  // Updates the hint text below the image editor to match the current mode and
  // whether the full-image drag/resize editor is active. Called from setMode() and
  // setFullEditorMode() whenever either changes.
  function updateImageFormatHint() {
    if (activeMode === "image") {
      imageFormatHint.textContent =
        "Text is positioned where it appeared in the source image. Click a word to edit it, or shift-click and drag to select multiple.";
    } else if (activeMode === "full" && !fullEditorMode) {
      imageFormatHint.textContent =
        "The full image is shown with editable text on top. Click a word to edit it, or shift-click and drag to select multiple. Click Move components to move and resize.";
    } else if (activeMode === "full" && fullEditorMode) {
      imageFormatHint.textContent =
        "Drag an item to move it, or drag its corner handle to resize. Shift-click or drag a selection box to move multiple items together.";
    }
  }

  // ---- Full editor mode ----

  // Toggles "Move components" mode in the Full image view: makes word spans
  // draggable/resizable instead of directly text-editable, and shows/hides the
  // undo/redo controls. Triggered by clicking the editor-mode-btn button.
  function setFullEditorMode(on) {
    fullEditorMode = on;
    imageFormatView.classList.toggle("editor-mode", on);
    editorObjects.forEach((obj) => {
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
    updateImageFormatHint();
    updateResizeHandle();
  }

  editorModeBtn.addEventListener("click", () => setFullEditorMode(!fullEditorMode));

  // ---- Selection ----

  // Deselects every editor object (word span or background image). Called on
  // Escape, when starting a non-additive marquee, and whenever the editor view resets.
  function clearSelection() {
    selectedObjectIds.clear();
    updateSelectionVisuals();
  }

  // Adds or removes one object id from selectedObjectIds. Called for shift/cmd-click
  // selection of individual words or the background image.
  function toggleSelection(id) {
    if (selectedObjectIds.has(id)) {
      selectedObjectIds.delete(id);
    } else {
      selectedObjectIds.add(id);
    }
    updateSelectionVisuals();
  }

  // Syncs each editor object's "is-selected" CSS class with selectedObjectIds and
  // repositions the resize handle. Called after any change to the selection set.
  function updateSelectionVisuals() {
    editorObjects.forEach((obj) => {
      obj.el.classList.toggle("is-selected", selectedObjectIds.has(obj.id));
    });
    updateResizeHandle();
  }

  // Returns the editorObjects entries that are currently selected.
  function objectsFromSelection() {
    return editorObjects.filter((obj) => selectedObjectIds.has(obj.id));
  }

  // Shows the resize handle at the bottom-right corner of the single selected
  // object (only meaningful in full editor mode), or hides it otherwise.
  function updateResizeHandle() {
    if (fullEditorMode && selectedObjectIds.size === 1) {
      const obj = editorObjects.find((o) => selectedObjectIds.has(o.id));
      resizeHandle.style.left = `${obj.x + obj.w}%`;
      resizeHandle.style.top = `${obj.y + obj.h}%`;
      resizeHandle.style.display = "block";
    } else {
      resizeHandle.style.display = "none";
    }
  }

  // ---- Undo / redo ----

  // Captures the position/size/font-size of every editor object, for use as an
  // undo/redo checkpoint. Called before a drag or resize starts, and by the
  // undo/redo button handlers to save the current state before restoring another.
  function snapshotState() {
    return editorObjects.map((obj) => ({
      id: obj.id,
      x: obj.x,
      y: obj.y,
      w: obj.w,
      h: obj.h,
      fontSizePct: obj.fontSizePct,
    }));
  }

  // Applies a previously captured snapshotState() result back onto editorObjects
  // and re-renders their styles. Called by the undo and redo button handlers.
  function restoreSnapshot(snapshot) {
    snapshot.forEach((s) => {
      const obj = editorObjects.find((o) => o.id === s.id);
      if (!obj) return;
      obj.x = s.x;
      obj.y = s.y;
      obj.w = s.w;
      obj.h = s.h;
      if (s.fontSizePct != null) obj.fontSizePct = s.fontSizePct;
      applyObjectStyle(obj);
    });
    updateResizeHandle();
    refreshModifiedStates();
  }

  // Records a pre-change snapshot onto the undo stack (capping it at MAX_UNDO_STEPS)
  // and clears the redo stack, since a new change invalidates any prior redo history.
  // Called at the end of a completed drag or resize.
  function pushUndo(preChangeSnapshot) {
    undoStack.push(preChangeSnapshot);
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
  }

  // Enables/disables the undo and redo buttons based on whether their stacks have entries.
  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  // Undo button click: pops the last snapshot off undoStack, pushes the current
  // state onto redoStack, and restores the popped snapshot.
  undoBtn.addEventListener("click", () => {
    if (!undoStack.length) return;
    const current = snapshotState();
    const previous = undoStack.pop();
    redoStack.push(current);
    restoreSnapshot(previous);
    updateUndoRedoButtons();
  });

  // Redo button click: the inverse of the undo handler, replaying a change that was
  // previously undone.
  redoBtn.addEventListener("click", () => {
    if (!redoStack.length) return;
    const current = snapshotState();
    const next = redoStack.pop();
    undoStack.push(current);
    restoreSnapshot(next);
    updateUndoRedoButtons();
  });

  // Global keyboard shortcuts for the image editor: Escape clears the selection,
  // and (only while full editor mode is on) Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z
  // or Ctrl/Cmd+Y redoes.
  document.addEventListener("keydown", (e) => {
    if ((activeMode === "image" || activeMode === "full") && e.key === "Escape") {
      clearSelection();
      return;
    }
    if (!fullEditorMode) return;
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

  // Writes one editor object's current x/y/w/h (and, for words, font size) onto its
  // DOM element's inline style. Called after any change to an object's geometry
  // (initial render, drag, resize, undo/redo).
  function applyObjectStyle(obj) {
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

  // Removes all generated word/patch elements from image-format-view and resets the
  // editor's in-memory state (editorObjects, undo/redo stacks, selection, editor mode).
  // Called before rendering a fresh scan result and when the user resets the image.
  function clearImageFormatView() {
    imageFormatView.querySelectorAll(".image-format-word, .image-format-patch").forEach((el) => el.remove());
    imageFormatBg.removeAttribute("src");
    imageFormatView.style.aspectRatio = "";
    editorObjects = [];
    imageFormatLines = [];
    objectIdCounter = 0;
    lastNaturalWidth = 0;
    lastNaturalHeight = 0;
    undoStack = [];
    redoStack = [];
    setFullEditorMode(false);
    clearSelection();
    updateUndoRedoButtons();
  }

  // Draws the already-loaded preview image into an offscreen canvas so word
  // patch colors can be sampled from it. Blob: URLs are same-origin, so this
  // never taints the canvas.
  function readImagePixels(naturalWidth, naturalHeight) {
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
  // back to below), used to mask leftover original text once a word moves.
  function sampleNearbyColor(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1) {
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

  // Returns true if a word object's text or geometry differs from the values it was
  // originally rendered with (obj.originalText/X/Y/W/H).
  function isWordModified(obj) {
    return (
      obj.el.textContent !== obj.originalText ||
      Math.abs(obj.x - obj.originalX) > 0.01 ||
      Math.abs(obj.y - obj.originalY) > 0.01 ||
      Math.abs(obj.w - obj.originalW) > 0.01 ||
      Math.abs(obj.h - obj.originalH) > 0.01
    );
  }

  // Recomputes each word's "modified" flag via isWordModified(), toggles its
  // "is-modified" class, and shows/hides its background patch accordingly. Called
  // after text edits, drags, resizes, and undo/redo.
  function refreshModifiedStates() {
    editorObjects.forEach((obj) => {
      if (obj.type !== "word") return;
      const modified = isWordModified(obj);
      obj.modified = modified;
      obj.el.classList.toggle("is-modified", modified);
      if (obj.patchEl) {
        obj.patchEl.style.display = modified && obj.patchColor ? "block" : "none";
      }
    });
  }

  // Builds the Image format / Full image view from Tesseract's recognition result.
  // Called once after a successful scan (data is Tesseract's `data` object, with
  // per-line/per-word bounding boxes). Sets the background image, creates one
  // absolutely-positioned word span and background patch per recognized word inside
  // image-format-view, and populates editorObjects and imageFormatLines for later use.
  function renderImageFormatView(data, naturalWidth, naturalHeight, imageUrl) {
    clearImageFormatView();

    if (!naturalWidth || !naturalHeight) return;

    lastNaturalWidth = naturalWidth;
    lastNaturalHeight = naturalHeight;
    imageFormatView.style.aspectRatio = `${naturalWidth} / ${naturalHeight}`;
    imageFormatBg.src = imageUrl;

    const bgObj = { id: "obj-bg", type: "image", x: 0, y: 0, w: 100, h: 100, el: imageFormatBg };
    editorObjects.push(bgObj);
    applyObjectStyle(bgObj);

    if (!Array.isArray(data.lines)) return;

    const pixels = readImagePixels(naturalWidth, naturalHeight);

    data.lines.forEach((line) => {
      if (!Array.isArray(line.words) || line.words.length === 0) return;
      const lineSpans = [];

      line.words.forEach((word) => {
        const text = (word.text || "").trim();
        if (!text) return;
        const { x0, y0, x1, y1 } = word.bbox;
        const width = Math.max(x1 - x0, 1);
        const height = Math.max(y1 - y0, 1);

        const x = (x0 / naturalWidth) * 100;
        const y = (y0 / naturalHeight) * 100;
        const w = (width / naturalWidth) * 100;
        const h = (height / naturalHeight) * 100;
        const fontSizePct = (height / naturalWidth) * 100 * FONT_SIZE_CORRECTION;

        const patchColor = sampleNearbyColor(pixels, naturalWidth, naturalHeight, x0, y0, x1, y1);
        const patchEl = document.createElement("div");
        patchEl.className = "image-format-patch";
        patchEl.style.left = `${x}%`;
        patchEl.style.top = `${y}%`;
        patchEl.style.width = `${w}%`;
        patchEl.style.height = `${h}%`;
        if (patchColor) patchEl.style.background = patchColor;
        imageFormatView.appendChild(patchEl);

        const span = document.createElement("span");
        span.className = "image-format-word";
        span.contentEditable = String(!fullEditorMode);
        span.spellcheck = false;
        span.textContent = text;

        const obj = {
          id: `obj-${++objectIdCounter}`,
          type: "word",
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
          patchColor,
          patchEl,
          modified: false,
          el: span,
        };
        editorObjects.push(obj);
        applyObjectStyle(obj);

        imageFormatView.appendChild(span);
        lineSpans.push(span);
      });

      if (lineSpans.length) {
        imageFormatLines.push(lineSpans);
      }
    });
  }

  // Fires as the user directly types into a contenteditable word span (outside full
  // editor mode). Refreshes the modified-state styling so the edited word is marked.
  imageFormatView.addEventListener("input", (e) => {
    const span = e.target.closest(".image-format-word");
    if (!span) return;
    const obj = editorObjects.find((o) => o.el === span);
    if (obj) refreshModifiedStates();
  });

  // Returns the text to copy/download: in Image format or Full image mode, rebuilds
  // it line-by-line from the (possibly edited) word spans, restricted to the current
  // selection if any words are selected; otherwise returns the plain result-text value.
  // Called by the Copy and Download .txt button handlers.
  function getActiveResultText() {
    if ((activeMode === "image" || activeMode === "full") && imageFormatLines.length) {
      const selectedWordEls = selectedObjectIds.size
        ? new Set(
            editorObjects
              .filter((obj) => obj.type === "word" && selectedObjectIds.has(obj.id))
              .map((obj) => obj.el)
          )
        : null;

      const lines = imageFormatLines
        .map((spans) => {
          const relevant = selectedWordEls ? spans.filter((s) => selectedWordEls.has(s)) : spans;
          return relevant
            .map((s) => s.textContent)
            .join(" ")
            .trim();
        })
        .filter((line) => line.length > 0);

      return lines.join("\n").trim();
    }
    return resultText.value;
  }

  // ---- Pointer interactions: select, drag, resize, marquee ----

  // Starts a drag on one or more selected editor objects. Called from the
  // image-format-view mousedown handler when the pointer goes down on a word or the
  // background image while in full editor mode. Tracks mouse movement to update each
  // selected object's x/y (writing to editorObjects and re-applying styles via
  // applyObjectStyle), and on mouseup either commits the move to the undo stack or,
  // if the pointer never moved, treats it as a selection click.
  function beginObjectDrag(e, obj, additive) {
    let selectionChangedAtDown = false;
    if (!selectedObjectIds.has(obj.id)) {
      if (!additive) selectedObjectIds.clear();
      selectedObjectIds.add(obj.id);
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
          selectedObjectIds.delete(obj.id);
          updateSelectionVisuals();
        } else if (selectedObjectIds.size > 1) {
          selectedObjectIds.clear();
          selectedObjectIds.add(obj.id);
          updateSelectionVisuals();
        }
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Starts a resize drag on the single selected object via the resize handle.
  // Called from the image-format-view mousedown handler when the pointer goes down
  // on resize-handle. Scales the object's w/h (and, for words, fontSizePct)
  // proportionally to pointer movement, and commits the change to the undo stack on mouseup.
  function beginResize(e) {
    const obj = editorObjects.find((o) => selectedObjectIds.has(o.id));
    if (!obj) return;

    const rect = imageFormatView.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = obj.w;
    const startH = obj.h;
    const startFontSizePct = obj.fontSizePct;
    const preSnapshot = snapshotState();
    const minSize = 1.5;
    let changed = false;

    function onMove(ev) {
      const dxPct = ((ev.clientX - startX) / rect.width) * 100;
      const dyPct = ((ev.clientY - startY) / rect.height) * 100;
      const scaleX = (startW + dxPct) / startW;
      const scaleY = (startH + dyPct) / startH;
      let scale = clamp((scaleX + scaleY) / 2, 0.2, 6);

      obj.w = clamp(startW * scale, minSize, 400);
      obj.h = clamp(startH * scale, minSize, 400);
      if (obj.type === "word") {
        obj.fontSizePct = Math.max(startFontSizePct * scale, 0.5);
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

  // Starts a rubber-band (marquee) selection drag. Called from the image-format-view
  // mousedown handler when the pointer goes down on empty space. Draws marquee-box
  // and adds/removes any object whose bounding rect intersects it to/from selectedObjectIds.
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

      editorObjects.forEach((obj) => {
        if (obj.type === "image" && !fullEditorMode) return;
        const r = obj.el.getBoundingClientRect();
        const intersects = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
        if (intersects) {
          selectedObjectIds.add(obj.id);
        } else if (!additive) {
          selectedObjectIds.delete(obj.id);
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

  // Dispatches a mousedown inside image-format-view to the appropriate interaction:
  // resizing (if the handle was hit), dragging or toggling selection on a word/image
  // object, or starting a marquee selection on empty space.
  imageFormatView.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;

    const handleEl = e.target.closest(".resize-handle");
    if (handleEl && fullEditorMode) {
      e.preventDefault();
      beginResize(e);
      return;
    }

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const objEl = e.target.closest(".image-format-word, .image-format-bg");

    if (objEl) {
      const obj = editorObjects.find((o) => o.el === objEl);
      if (!obj) return;

      if (fullEditorMode) {
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

  // Validates and accepts a chosen image file, whatever its source (file picker,
  // camera, drag-and-drop, paste, or the generated sample). Called by all of those
  // input paths. Rejects non-images and oversized files via setStatus(), otherwise
  // stores it as currentFile, points previewImg at a fresh object URL, and reveals
  // the preview section.
  function loadFile(file) {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setStatus("That file doesn't look like an image. Please choose a JPG, PNG, WEBP, or BMP file.", "error");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setStatus("That image is larger than 15 MB. Please choose a smaller file.", "error");
      return;
    }

    currentFile = file;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }
    currentObjectUrl = URL.createObjectURL(file);
    previewImg.src = currentObjectUrl;

    resetResult();
    show(previewSection);
    previewSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Drop zone: click or Enter/Space opens the hidden file picker (file-input).
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Fires once the user picks a file from the file picker; hands it to loadFile().
  fileInput.addEventListener("change", () => {
    loadFile(fileInput.files[0]);
    fileInput.value = "";
  });

  // "Use camera" button opens the hidden camera-input (capture="environment").
  cameraBtn.addEventListener("click", () => cameraInput.click());
  // Fires once a photo is captured from camera-input; hands it to loadFile().
  cameraInput.addEventListener("change", () => {
    loadFile(cameraInput.files[0]);
    cameraInput.value = "";
  });

  // Drag and drop: toggles the "dragover" hover styling on the drop zone.
  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  // Handles a file actually dropped onto the drop zone, passing it to loadFile().
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    loadFile(file);
  });

  // Paste from clipboard: if the clipboard contains an image (pasted anywhere on
  // the page), loads it the same way as a picked or dropped file.
  window.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        loadFile(item.getAsFile());
        break;
      }
    }
  });

  // "Choose a different image" button: clears the current file/preview/object URL
  // and hides the preview and result sections.
  resetBtn.addEventListener("click", () => {
    currentFile = null;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    previewImg.src = "";
    hide(previewSection);
    resetResult();
  });

  // Draws a small canvas of sample text and converts it to a PNG File, so "Try a
  // sample image" works without fetching an external asset. Called by the
  // sample-btn click handler.
  function generateSampleImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 220;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText("TextScanner sample", 30, 70);
    ctx.font = "24px sans-serif";
    ctx.fillText("The quick brown fox jumps over", 30, 120);
    ctx.fillText("the lazy dog.", 30, 155);
    ctx.font = "18px sans-serif";
    ctx.fillText("Click Scan text to extract this line.", 30, 195);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(new File([blob], "sample.png", { type: "image/png" }));
      }, "image/png");
    });
  }

  // "Try a sample image" button: generates the sample image and loads it as if picked.
  sampleBtn.addEventListener("click", async () => {
    const file = await generateSampleImage();
    loadFile(file);
  });

  // "Scan text" button: runs Tesseract.js OCR on currentFile. Disables the
  // scan/reset buttons and shows the progress bar (updated live from Tesseract's
  // logger callback), then on success writes the recognized text into resultText,
  // builds the Image format / Full image view via renderImageFormatView(), and
  // reveals the results section; on failure or empty result, reports via setStatus().
  scanBtn.addEventListener("click", async () => {
    if (!currentFile) return;

    scanBtn.disabled = true;
    resetBtn.disabled = true;
    resetResult();
    show(progressSection);
    progressLabel.textContent = "Loading OCR engine...";

    try {
      const { data } = await Tesseract.recognize(currentFile, "eng", {
        logger: (msg) => {
          if (msg.status && typeof msg.progress === "number") {
            const percent = Math.round(msg.progress * 100);
            progressFill.style.width = `${percent}%`;
            progressLabel.textContent = `${formatStatus(msg.status)} (${percent}%)`;
          }
        },
      });

      const text = (data.text || "").trim();
      hide(progressSection);

      if (!text) {
        setStatus("No text was detected in this image. Try a clearer or higher-contrast image.", "error");
      } else {
        resultText.value = text;
        renderImageFormatView(data, previewImg.naturalWidth, previewImg.naturalHeight, currentObjectUrl);
        setMode("text");
        show(resultSection);
        setStatus("Text extracted successfully.", "success");
      }
    } catch (err) {
      hide(progressSection);
      setStatus(`Something went wrong while scanning: ${err.message || err}`, "error");
    } finally {
      scanBtn.disabled = false;
      resetBtn.disabled = false;
    }
  });

  // Capitalizes the first letter of a Tesseract logger status string (e.g.
  // "recognizing text" to "Recognizing text") for display in the progress label.
  function formatStatus(status) {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  // "Copy" button: copies getActiveResultText() to the clipboard via the async
  // Clipboard API, falling back to a hidden textarea + execCommand("copy") if that
  // API is unavailable or denied. Briefly shows "Copied!" as feedback.
  copyBtn.addEventListener("click", async () => {
    const text = getActiveResultText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1500);
    } catch {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
  });

  // "Download .txt" button: saves getActiveResultText() as a downloaded text file
  // via a temporary Blob URL and a clicked, then discarded, anchor element.
  downloadBtn.addEventListener("click", () => {
    const text = getActiveResultText();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "textscanner-result.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // Flattens the current Image format or Full image view into a PNG, mirroring
  // what's on screen: the photo (Full image only) at its current position and
  // size, patches over any moved/edited words' original spots, then each
  // word's current text at its current position and size.
  function buildResultCanvas() {
    if (!lastNaturalWidth || !lastNaturalHeight) return null;

    const canvas = document.createElement("canvas");
    canvas.width = lastNaturalWidth;
    canvas.height = lastNaturalHeight;
    const ctx = canvas.getContext("2d");

    const surfaceColor = getComputedStyle(imageFormatView).backgroundColor;
    ctx.fillStyle = surfaceColor || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (activeMode === "full") {
      const bgObj = editorObjects.find((o) => o.type === "image");
      if (bgObj && imageFormatBg.complete && imageFormatBg.naturalWidth) {
        const bx = (bgObj.x / 100) * canvas.width;
        const by = (bgObj.y / 100) * canvas.height;
        const bw = (bgObj.w / 100) * canvas.width;
        const bh = (bgObj.h / 100) * canvas.height;
        ctx.drawImage(imageFormatBg, bx, by, bw, bh);
      }

      editorObjects.forEach((obj) => {
        if (obj.type !== "word" || !obj.modified || !obj.patchColor) return;
        const px = (obj.originalX / 100) * canvas.width;
        const py = (obj.originalY / 100) * canvas.height;
        const pw = (obj.originalW / 100) * canvas.width;
        const ph = (obj.originalH / 100) * canvas.height;
        ctx.fillStyle = obj.patchColor;
        ctx.fillRect(px, py, pw, ph);
      });
    }

    const textColor = getComputedStyle(document.body).color;
    editorObjects.forEach((obj) => {
      if (obj.type !== "word") return;
      // In Full image mode, an untouched word stays invisible on screen (the real
      // image text underneath already shows it), so skip drawing it here too.
      if (activeMode === "full" && !obj.modified) return;
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

  // "Download image" button (Image format / Full image modes): builds the flattened
  // canvas via buildResultCanvas() and saves it as a PNG through a temporary Blob URL.
  downloadImageBtn.addEventListener("click", () => {
    const canvas = buildResultCanvas();
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = activeMode === "full" ? "textscanner-full-image.png" : "textscanner-image-format.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  });
})();
