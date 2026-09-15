// editorExport.js: reading the editor's contents back out - as text (Copy,
// Download, text-to-speech, and the line-level read used by translation), and
// as a flattened PNG canvas.
//
// One of three files that used to be a single 1,400-line editor.js. Depends on
// editorObjects.js and nothing else in the editor, so the "get the result out"
// path can be read without the gesture code.
//
// Translation's write-back lives here too, next to the read it pairs with:
// getLineTexts reads a line, applyTranslatedLines writes one back. Keeping them
// together is what makes it obvious they have to agree about what a line is.

import {
  resultText,
  imageFormatView,
  imageFormatBg,
} from "./dom.js";
import { state } from "./state.js";
import {
  applyObjectStyle,
  getObjectByElement,
  snapshotState,
  pushUndo,
  refreshModifiedStates,
  refitWordFontSize,
  inkFitPxAtScale,
  wordFontFamily,
} from "./editorObjects.js";

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

// ---- Translate in place (Phase 4c) ----
//
// The editor's contribution to translation is deliberately small, because the
// object model already does the hard part. Text is read out and written back a
// LINE at a time (js/translate.js explains why word-at-a-time translation
// produces nonsense in most languages), and writing a line back is expressed
// entirely in operations that already exist:
//
//   - the line's first word span takes the whole translated string, so the
//     translation starts exactly where the original line started and inherits
//     its font size;
//   - every other span on that line is emptied, which is precisely what Delete
//     does to an OCR word, so those spots get the existing inpainting treatment
//     with no new code;
//   - the whole thing is one snapshot/pushUndo pair, so it is one Undo step.
//
// No new object type, no new export path, no new undo handling.

// The word objects of each recognized line, in reading order. Same grouping as
// state.imageFormatLines (which holds elements), resolved to objects so callers
// can read and write text through the object model rather than the DOM.

export function getLineObjects() {
  return state.imageFormatLines
    .map((spans) => spans.map((span) => getObjectByElement(span)).filter(Boolean))
    .filter((objs) => objs.length > 0);
}

// The current text of each line, joined the way a reader would see it. This is
// what gets sent for translation - the live span text, not the original OCR, so
// a user's own corrections are translated rather than silently discarded.

export function getLineTexts() {
  return getLineObjects().map((objs) =>
    objs
      .map((o) => o.el.textContent)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Writes translated lines back, one per line from getLineTexts(), as a single
// undoable step. A line whose translation is empty or unchanged is left exactly
// as it was rather than being collapsed into one span for no reason.

export function applyTranslatedLines(translated) {
  const lines = getLineObjects();
  if (!lines.length) return 0;

  const preSnapshot = snapshotState();
  let changedLines = 0;

  lines.forEach((objs, i) => {
    const text = (translated[i] || "").trim();
    if (!text) return;
    const current = objs
      .map((o) => o.el.textContent)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text === current) return;

    objs[0].el.textContent = text;
    // Widen the first span to span the whole original line, so a translation
    // that runs longer than the first word has the line's own width to sit in
    // before it starts overflowing to the right.
    const lineRight = Math.max(...objs.map((o) => o.x + o.w));
    objs[0].w = Math.max(objs[0].w, lineRight - objs[0].x);
    for (let k = 1; k < objs.length; k++) objs[k].el.textContent = "";
    // A translated line is new text in the same spot, so it needs the same
    // re-measure a retype does - otherwise the line renders at the height the
    // FIRST original word's glyphs happened to call for.
    refitWordFontSize(objs[0]);
    applyObjectStyle(objs[0]);
    changedLines++;
  });

  if (!changedLines) return 0;
  pushUndo(preSnapshot);
  refreshModifiedStates();
  return changedLines;
}

// ---- Flatten the current view to a PNG canvas ----

let patchCanvasProvider = null;
// Phase 2 hook: given a word object, return a CanvasImageSource showing the
// inpainted fill for its original bbox, or null to fall back to patchColor.

export function setPatchCanvasProvider(fn) {
  patchCanvasProvider = fn;
}

// The font size to draw `obj`'s text at on the export canvas, in canvas pixels.
//
// obj.fontSizePct is solved against editorContentWidth() - the ON-SCREEN
// PREVIEW's width - and re-solved live as that width changes (see
// refitWordsForContainerWidth in editorObjects.js). The export canvas is a
// DIFFERENT, unrelated absolute pixel scale: canvas.width is
// state.lastNaturalWidth, the photo's own resolution, which is essentially
// never equal to the preview's on-screen width. Ink-per-em is a staircase in
// absolute size (see editorObjects.js's header), so a percentage that fits at
// the preview's scale is not thereby fit at the export's - reusing it here
// renders a word sized for a container it is not being drawn into.
//
// So a word with a source target to match gets its own solve, fresh, against
// the export canvas's own scale (1: canvas.width is already natural-resolution
// pixels, one canvas unit is one source-image pixel, no conversion applies).
// The two words this can't do anything for keep the percentage: a user-added
// word has no inkTargetPx to solve against, and a hand-resized word is
// carrying the size the user chose, which must not be silently overridden.
function exportFontPx(obj, text, canvasWidth) {
  if (!obj.fontSizeLocked && obj.inkTargetPx) {
    const fit = inkFitPxAtScale(text, obj.inkTargetPx, obj.inkTargetWpx, 1);
    if (fit) return fit.fitPx;
  }
  return (obj.fontSizePct / 100) * canvasWidth;
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
    const bgObj = state.editorObjects.find((o) => o.type === "image"); // exactly one, and only here
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

  const defaultTextColor = getComputedStyle(document.body).color;
  state.editorObjects.forEach((obj) => {
    if (obj.type !== "word") return;
    // In Full image mode, an untouched OCR word stays invisible on screen (the real
    // image text underneath already shows it), so skip drawing it here too.
    // User-added words have no underlying image text, so always draw them.
    if (state.activeMode === "full" && !obj.modified && obj.origin === "ocr") return;
    const text = obj.el.textContent;
    if (!text) return;
    const fontPx = exportFontPx(obj, text, canvas.width);
    // wordFontFamily(), not a second hardcoded copy of the stack: the
    // condensed-source detector made the family conditional (condensed source
    // text draws in a narrower font -
    // see editorObjects.js's detectCondensedSource), and reading the same
    // live resolution the preview and the sizing solve already use is what
    // keeps the export canvas from silently drawing in the wrong one.
    ctx.font = `${fontPx}px ${wordFontFamily()}`;
    const wx = (obj.x / 100) * canvas.width;
    const wy = (obj.y / 100) * canvas.height;
    ctx.textBaseline = "top";
    // The legibility box, when the sampled ink needs one, is drawn the same way
    // and for the same reason as on screen.
    if (obj.textColor && obj.needsBackingBox && (obj.textBackgroundColor || obj.patchColor)) {
      const metrics = ctx.measureText(text);
      ctx.fillStyle = obj.textBackgroundColor || obj.patchColor;
      ctx.fillRect(wx, wy, metrics.width, fontPx * 1.15);
    }
    ctx.fillStyle = obj.textColor || defaultTextColor || "#111111";
    ctx.fillText(text, wx, wy);
  });

  return canvas;
}
