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
export const downloadBtn = document.getElementById("download-btn");
export const downloadImageBtn = document.getElementById("download-image-btn");
export const modeTextBtn = document.getElementById("mode-text-btn");
export const modeImageBtn = document.getElementById("mode-image-btn");
export const modeFullBtn = document.getElementById("mode-full-btn");
export const modeButtons = [modeTextBtn, modeImageBtn, modeFullBtn];
export const imageFormatView = document.getElementById("image-format-view");
export const imageFormatBg = document.getElementById("image-format-bg");
export const resizeHandle = document.getElementById("resize-handle");
export const marqueeBox = document.getElementById("marquee-box");
export const imageFormatHint = document.getElementById("image-format-hint");
export const editorToolbar = document.getElementById("editor-toolbar");
export const editorModeBtn = document.getElementById("editor-mode-btn");
export const newTextBtn = document.getElementById("new-text-btn");
export const deleteBtn = document.getElementById("delete-btn");
export const undoRedoGroup = document.getElementById("undo-redo-group");
export const undoBtn = document.getElementById("undo-btn");
export const redoBtn = document.getElementById("redo-btn");

export const filterToggle = document.getElementById("filter-toggle");
export const filterRawBtn = document.getElementById("filter-raw-btn");
export const filterSymbolBtn = document.getElementById("filter-symbol-btn");
export const filterCoherenceBtn = document.getElementById("filter-coherence-btn");
export const filterButtons = [filterRawBtn, filterSymbolBtn, filterCoherenceBtn];

export const ttsControls = document.getElementById("tts-controls");
export const ttsPlayBtn = document.getElementById("tts-play-btn");
export const ttsStopBtn = document.getElementById("tts-stop-btn");
