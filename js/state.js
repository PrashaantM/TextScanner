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
// Fallback only, since 2026-09-13. A word's font size is now MEASURED - the size
// at which its own glyphs fill the box of the word it replaces - because one
// constant cannot serve "MEOW" (cap height), "energy" (ascender to descender)
// and "meow" (x-height only), and being wrong for all three rendered every
// replacement at 0.58x the height of the source text. See fontSizePctForInk in
// js/editorObjects.js, which falls back to this when the measurement is
// unavailable, and test/replacement-size.js for the numbers.
//
// Its original rationale, still true as far as it went: a bbox height used
// directly as a CSS font-size renders visibly larger than the source text,
// because a font's em-box is taller than its ink.
export const FONT_SIZE_CORRECTION = 0.8;
// Below this per-word OCR confidence (0-100), a word is flagged in the UI as
// worth double-checking rather than trusted outright. See ocrEngine.js.
export const LOW_CONFIDENCE_THRESHOLD = 65;

// The one place the app's version string is written. Rendered in the footer
// (js/main.js, next to footerEngine) and included verbatim in the diagnostic
// export (js/diagnostics.js) - both read this constant rather than each
// carrying their own copy, so the two cannot drift the way the id/module/CI
// counts documented in WEB-COMPLETION-PLAN.md just did. See test/site-metadata.js,
// which gates the footer's rendered value against this.
export const APP_VERSION = "1.0.0";

export const state = {
  currentFile: null,
  currentObjectUrl: null,
  activeMode: "text",
  imageFormatLines: [], // array of arrays of word span elements, grouped by line
  lastNaturalWidth: 0,
  lastNaturalHeight: 0,

  // Image format / Full image shared state: every word span is an "object"
  // that can be selected and (in Full image mode) moved via move-handle and
  // resized via resize-handle. type: 'word' | 'image' (the background image
  // itself is type 'image' but not selectable/moveable - see
  // editorInteractions.js's pointerdown dispatcher). Word objects additionally
  // carry origin: 'ocr' (recognized from the scan) or 'user' (added via the
  // New text/Paste tools).
  editorObjects: [],
  objectIdCounter: 0,
  selectedObjectIds: new Set(),
  addTextMode: false,
  // Paste's placement mode (UI-REDESIGN-PLAN.md §2.2), mirroring addTextMode
  // exactly: armed by pasteBtn, disarmed by placing (or by leaving Full image
  // mode).
  pasteArmed: false,
  // True only for the live duration of an actual marquee drag (see
  // beginMarquee in js/editorInteractions.js) - not a standing mode. While
  // true, the editor surface takes the finger drag that would otherwise
  // scroll the page.
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

  // The categorized message from the most recent scan failure this session
  // (see describeScanError in main.js), or null if none occurred yet. Read by
  // js/diagnostics.js's opt-in export - not shown anywhere else, and not
  // itself sent anywhere the person didn't choose via the share sheet.
  lastScanError: null,
};
