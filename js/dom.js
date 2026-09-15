// dom.js: single source of truth for every DOM element reference used across the
// app's modules, matched up by id/class with index.html. Importing from here instead
// of re-querying the document keeps every module looking at the same nodes.

export const dropZone = document.getElementById("drop-zone");
export const fileInput = document.getElementById("file-input");
export const cameraBtn = document.getElementById("camera-btn");
export const cameraInput = document.getElementById("camera-input");
export const sampleBtn = document.getElementById("sample-btn");

export const previewSection = document.getElementById("preview-section");
export const previewImg = document.getElementById("preview-img");
export const scanBtn = document.getElementById("scan-btn");
export const resetBtn = document.getElementById("reset-btn");

export const progressSection = document.getElementById("progress-section");
export const progressFill = document.getElementById("progress-fill");
export const progressLabel = document.getElementById("progress-label");

export const statusSection = document.getElementById("status-section");

export const resultSection = document.getElementById("result-section");
export const resultText = document.getElementById("result-text");
export const copyBtn = document.getElementById("copy-btn");
// Paste (UI-REDESIGN-PLAN.md §2.2): whole-buffer replace in Text mode,
// arm-then-place in Image format/Full image - see js/main.js.
export const pasteBtn = document.getElementById("paste-btn");
// Download (UI-REDESIGN-PLAN.md §2.1): one button, merged from the old
// download-btn/download-image-btn pair. Downloads the text directly in Text
// mode; opens downloadMenu (Image/Text) in the two image modes, where both
// artifacts exist. See js/main.js.
export const downloadBtn = document.getElementById("download-btn");
export const downloadMenu = document.getElementById("download-menu");
export const downloadMenuBackdrop = document.getElementById("download-menu-backdrop");
export const modeTextBtn = document.getElementById("mode-text-btn");
export const modeImageBtn = document.getElementById("mode-image-btn");
// Doubles as the old guided "View on photo ->" CTA, merged into this toggle's
// third option (UI-REDESIGN-PLAN.md §2.4) - modeFullBtn.click() is no longer
// a separate proxy target, it's just this button.
export const modeFullBtn = document.getElementById("mode-full-btn");
export const modeButtons = [modeTextBtn, modeImageBtn, modeFullBtn];
// The skip-the-call gate's inline suggestion (js/coherenceGate.js), now fired
// directly from filterCoherenceBtn - see js/main.js.
export const coherenceGateHint = document.getElementById("coherence-gate-hint");
export const imageFormatView = document.getElementById("image-format-view");
export const imageFormatBg = document.getElementById("image-format-bg");
export const resizeHandle = document.getElementById("resize-handle");
// Appears alongside resizeHandle on selection (Full image only); dragging
// from here moves the current selection (UI-REDESIGN-PLAN.md §2.3's
// handle-based move gesture) rather than dragging a word's own body.
export const moveHandle = document.getElementById("move-handle");
export const marqueeBox = document.getElementById("marquee-box");
export const imageFormatHint = document.getElementById("image-format-hint");
// Shown only on an engine with no per-word confidence signal (see
// engineProvidesConfidence() in js/recognize.js).
export const confidenceNote = document.getElementById("confidence-note");
// Phase 6 accessibility: a live region for selection changes, the editor's
// keyboard hint, and the manual theme toggle.
export const selectionStatus = document.getElementById("selection-status");
export const editorKeyboardHint = document.getElementById("editor-keyboard-hint");
export const themeBtn = document.getElementById("theme-btn");
export const editorToolbar = document.getElementById("editor-toolbar");
export const newTextBtn = document.getElementById("new-text-btn");
export const deleteBtn = document.getElementById("delete-btn");
export const undoRedoGroup = document.getElementById("undo-redo-group");
export const undoBtn = document.getElementById("undo-btn");
export const redoBtn = document.getElementById("redo-btn");

export const filterRawBtn = document.getElementById("filter-raw-btn");
export const filterFilteredBtn = document.getElementById("filter-filtered-btn");
export const filterCoherenceBtn = document.getElementById("filter-coherence-btn");
export const filterButtons = [filterRawBtn, filterFilteredBtn, filterCoherenceBtn];

export const coherencePanel = document.getElementById("coherence-panel");
export const coherenceKeyRow = document.getElementById("coherence-key-row");
export const coherenceApiKeyInput = document.getElementById("coherence-api-key");
export const coherenceSaveKeyBtn = document.getElementById("coherence-save-key-btn");
export const coherenceGenerateRow = document.getElementById("coherence-generate-row");
export const coherenceGenerateBtn = document.getElementById("coherence-generate-btn");
export const coherenceChangeKeyBtn = document.getElementById("coherence-change-key-btn");
export const coherenceStatus = document.getElementById("coherence-status");
// Phase 2's two-tier UI: which tier will run, the per-tier disclosures, the
// opt-in switch between them, and the honest "neither tier can run" state.
export const coherenceTierName = document.getElementById("coherence-tier-name");
export const coherenceTierSwitchBtn = document.getElementById("coherence-tier-switch-btn");
export const coherenceDisclosureOnDevice = document.getElementById("coherence-disclosure-ondevice");
export const coherenceDisclosureClaude = document.getElementById("coherence-disclosure-claude");
export const coherenceDisclosureOrigin = document.getElementById("coherence-disclosure-origin");
export const coherenceUnavailable = document.getElementById("coherence-unavailable");

// Filled in at startup with whichever recognition engine this build actually
// runs (see js/main.js) - Tesseract.js on the web, ML Kit inside the iOS app.
export const footerEngine = document.getElementById("footer-engine");
// W12: set from state.js's APP_VERSION at startup, same as footerEngine above -
// see js/main.js. The markup also carries that value directly as a fallback for
// no-JS/pre-load display; test/site-metadata.js gates the two against each other.
export const footerVersion = document.getElementById("footer-version");

// Translate in place (Phase 4c). See js/translate.js for the dispatch and
// js/editorExport.js's applyTranslatedLines for how a translation is written back.
export const translateControls = document.getElementById("translate-controls");
export const translateTarget = document.getElementById("translate-target");
export const translateBtn = document.getElementById("translate-btn");
export const translateRevertBtn = document.getElementById("translate-revert-btn");
export const translateTier = document.getElementById("translate-tier");
export const translateStatus = document.getElementById("translate-status");

export const ttsControls = document.getElementById("tts-controls");
export const ttsPlayBtn = document.getElementById("tts-play-btn");
export const ttsStopBtn = document.getElementById("tts-stop-btn");

// User-triggered diagnostic export (Phase 15). See js/diagnostics.js.
export const diagnosticsExportBtn = document.getElementById("diagnostics-export-btn");
export const diagnosticsIncludeImage = document.getElementById("diagnostics-include-image");
export const diagnosticsStatus = document.getElementById("diagnostics-status");
