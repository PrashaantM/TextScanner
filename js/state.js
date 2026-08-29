// state.js: shared constants and the single mutable state object every module reads
// and writes. Properties are mutated in place (state.x = y) rather than re-exported
// as rebindable bindings, since plain ES module `let` exports can't be reassigned
// from outside the module that declares them.

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
// Decoded-pixel cap, which is a different limit from MAX_FILE_BYTES and guards
// a different failure. A well-compressed 15 MB JPEG can decode to a buffer far
// larger than its file size suggests, and readImagePixels, preprocessImage and
// computeInpaintedPatch all allocate width*height*4 bytes and run on the main
// thread - so a 48 MP photo asks for ~192 MB per pass and freezes the tab (or,
// on a phone, gets the app killed). 12 MP is chosen so a standard iPhone main
// camera shot passes through untouched and only genuinely huge images are
// downscaled; see downscaleIfOversized in js/main.js, which tells the user when
// it happens rather than quietly changing their image.
export const MAX_IMAGE_PIXELS = 12 * 1000 * 1000;
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
  // Rubber-band selection armed (see setMarqueeMode in js/editorInteractions.js). Exists for
  // touch: while on, the editor surface takes the finger drag that would
  // otherwise scroll the page.
  marqueeMode: false,
  undoStack: [],
  redoStack: [],

  // Raw OCR output for the current scan: flat list of { lineIndex, text,
  // confidence, bbox }, immutable once a scan completes. This is the shared
  // source of truth filter.js reads from; editorObjects/imageFormatLines are the
  // editable DOM-backed view built from the same scan.
  ocrWords: [],
  activeFilterLevel: "filtered", // 'raw' | 'filtered' | 'coherence'

  // Coherence Filter's last generated reconstruction for the current scan (see
  // js/coherence.js), or null if it hasn't been generated yet (or the scan
  // changed since). Cached here rather than regenerated on every level switch
  // so tabbing back to Coherence Filter doesn't re-fire a billed API call.
  coherentText: null,
};
