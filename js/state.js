// state.js: shared constants and the single mutable state object every module reads
// and writes. Properties are mutated in place (state.x = y) rather than re-exported
// as rebindable bindings, since plain ES module `let` exports can't be reassigned
// from outside the module that declares them.

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_UNDO_STEPS = 100;
// Tesseract's word bbox height (used directly as a CSS font-size) renders visibly
// larger than the source text, since a font's em-box is taller than its ink height.
export const FONT_SIZE_CORRECTION = 0.8;
// Below this per-word OCR confidence (0-100), a word is flagged in the UI as
// worth double-checking rather than trusted outright. See ocrEngine.js.
export const LOW_CONFIDENCE_THRESHOLD = 65;

export const state = {
  currentFile: null,
  currentObjectUrl: null,
  activeMode: "text",
  imageFormatLines: [], // array of arrays of word span elements, grouped by line
  lastNaturalWidth: 0,
  lastNaturalHeight: 0,

  // Image format / Full image shared state: every word span and the background
  // image are "objects" that can be selected, and (in full editor mode) moved and
  // resized. type: 'word' | 'image'. Word objects additionally carry origin:
  // 'ocr' (recognized from the scan) or 'user' (added via the New text tool).
  editorObjects: [],
  objectIdCounter: 0,
  selectedObjectIds: new Set(),
  fullEditorMode: false,
  addTextMode: false,
  undoStack: [],
  redoStack: [],

  // Raw OCR output for the current scan: flat list of { lineIndex, text,
  // confidence, bbox }, immutable once a scan completes. This is the shared
  // source of truth filter.js reads from; editorObjects/imageFormatLines are the
  // editable DOM-backed view built from the same scan.
  ocrWords: [],
  activeFilterLevel: "symbol", // 'raw' | 'symbol' | 'coherence'
};
