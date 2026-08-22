// main.js: application bootstrap. Wires file input (drag/drop, paste, camera,
// sample image), the Scan text button (preprocessing + OCR via ocrEngine.js), and
// Copy/Download, on top of the editor surface (editor.js) that renders and manages
// the OCR result.
import {
  dropZone,
  fileInput,
  cameraBtn,
  cameraInput,
  sampleBtn,
  previewSection,
  previewImg,
  scanBtn,
  resetBtn,
  progressSection,
  progressFill,
  progressLabel,
  statusSection,
  resultSection,
  resultText,
  copyBtn,
  downloadBtn,
  downloadImageBtn,
  filterButtons,
  coherencePanel,
  coherenceKeyRow,
  coherenceApiKeyInput,
  coherenceSaveKeyBtn,
  coherenceGenerateRow,
  coherenceGenerateBtn,
  coherenceChangeKeyBtn,
  coherenceStatus,
  newTextBtn,
  ttsControls,
  ttsPlayBtn,
  ttsStopBtn,
} from "./dom.js";
import { state, MAX_FILE_BYTES } from "./state.js";
import {
  setMode,
  clearImageFormatView,
  renderImageFormatView,
  getActiveResultText,
  buildResultCanvas,
  setPatchProvider,
  setPatchCanvasProvider,
  setDeleteHandler,
  snapshotState,
  pushUndo,
  refreshModifiedStates,
  clearSelection,
  setFilterTextHook,
  setFullEditorMode,
  setAddTextMode,
  setAddTextClickHandler,
  addUserTextObject,
  removeUserWordObject,
  createWordObject,
  configureUndoHooks,
} from "./editor.js";
import { recognizeImage } from "./ocrEngine.js";
import { wordsToText } from "./textUtil.js";
import { computeInpaintedPatch } from "./inpaint.js";
import { wordsToFilteredText } from "./filter.js";
import { getStoredApiKey, setStoredApiKey, clearStoredApiKey, reconstructCoherentText } from "./coherence.js";
import {
  isTTSSupported,
  waitForVoices,
  speak,
  pause as pauseTTS,
  resume as resumeTTS,
  stop as stopTTS,
  getTTSState,
  setTTSStateChangeHandler,
  TTS_STATE,
} from "./tts.js";

function show(el) {
  el.classList.remove("hidden");
}

function hide(el) {
  el.classList.add("hidden");
}

function setStatus(message, kind) {
  statusSection.textContent = message;
  statusSection.classList.remove("status--error", "status--success");
  if (!message) {
    hide(statusSection);
    return;
  }
  if (kind) statusSection.classList.add(`status--${kind}`);
  show(statusSection);
}

// A word's inpainted patch only ever needs computing once per scan (it depends
// only on the source image and the word's original bbox), so it's cached by
// object id here rather than recomputed on every modified-state refresh. Cleared
// whenever a fresh scan replaces the current result.
const patchCache = new Map();

function resetResult() {
  patchCache.clear();
  stopTTS();
  resultText.value = "";
  hide(resultSection);
  setStatus("");
  hide(progressSection);
  progressFill.style.width = "0%";
  clearImageFormatView();
  setMode("text");
  state.coherentText = null;
}

// ---- File loading (file picker, camera, drag-and-drop, paste, sample) ----

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

  state.currentFile = file;
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
  }
  state.currentObjectUrl = URL.createObjectURL(file);
  previewImg.src = state.currentObjectUrl;

  resetResult();
  show(previewSection);
  previewSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  loadFile(fileInput.files[0]);
  fileInput.value = "";
});

cameraBtn.addEventListener("click", () => cameraInput.click());
cameraInput.addEventListener("change", () => {
  loadFile(cameraInput.files[0]);
  cameraInput.value = "";
});

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

dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  loadFile(file);
});

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

resetBtn.addEventListener("click", () => {
  state.currentFile = null;
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = null;
  }
  previewImg.src = "";
  hide(previewSection);
  resetResult();
});

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

sampleBtn.addEventListener("click", async () => {
  const file = await generateSampleImage();
  loadFile(file);
});

// ---- Scan ----

function formatStatus(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function waitForImageDecode(img) {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => reject(new Error("Failed to load the selected image.")), { once: true });
  });
}

scanBtn.addEventListener("click", async () => {
  if (!state.currentFile) return;

  scanBtn.disabled = true;
  resetBtn.disabled = true;
  resetResult();
  show(progressSection);
  progressLabel.textContent = "Loading OCR engine...";

  try {
    await waitForImageDecode(previewImg);

    const { words, text } = await recognizeImage(previewImg, previewImg.naturalWidth, previewImg.naturalHeight, (msg) => {
      if (msg.status && typeof msg.progress === "number") {
        const percent = Math.round(msg.progress * 100);
        progressFill.style.width = `${percent}%`;
        progressLabel.textContent = `${formatStatus(msg.status)} (${percent}%)`;
      }
    });

    hide(progressSection);

    const plainText = text || wordsToText(words);
    if (!plainText) {
      setStatus("No text was detected in this image. Try a clearer or higher-contrast image.", "error");
    } else {
      renderImageFormatView(previewImg, words, previewImg.naturalWidth, previewImg.naturalHeight, state.currentObjectUrl);
      applyFilterLevel(state.activeFilterLevel);
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

// ---- Filter level (Raw / Filtered Text / Coherence Filter) ----

// The single place that applies a filter level change: rebuilds the Text view
// textarea and refreshes Image format/Full image's per-word is-filtered-out
// dimming, so both views and Copy/Download/TTS stay in sync with whichever
// level is active. Coherence Filter is a special case: its output is a
// generative LLM reconstruction, not a selection over ocrWords (see
// filter.js's header comment), so Text view shows either the cached
// reconstruction or the coherence panel's controls to generate one, while
// Image format/Full image dimming falls back to Filtered Text's word-level
// view since a freely-paraphrased reconstruction can't be mapped back onto
// individual source words.
function applyFilterLevel(level) {
  state.activeFilterLevel = level;
  filterButtons.forEach((btn) => {
    const isActive = btn.dataset.level === level;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });

  if (level === "coherence") {
    resultText.value = state.coherentText || "";
    updateCoherencePanel();
  } else {
    hide(coherencePanel);
    resultText.value = wordsToFilteredText(state.ocrWords, level);
  }
  refreshModifiedStates();
  if (ttsSupported) updateTTSButtons();
}

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => applyFilterLevel(btn.dataset.level));
});

// Shows the coherence panel in whichever state matches reality: no key saved
// yet (key-entry row), or a key saved and ready to (re)generate.
function updateCoherencePanel() {
  show(coherencePanel);
  const hasKey = !!getStoredApiKey();
  coherenceKeyRow.classList.toggle("hidden", hasKey);
  coherenceGenerateRow.classList.toggle("hidden", !hasKey);
  coherenceGenerateBtn.textContent = state.coherentText ? "Regenerate" : "Generate";
}

coherenceSaveKeyBtn.addEventListener("click", () => {
  const key = coherenceApiKeyInput.value.trim();
  if (!key) return;
  setStoredApiKey(key);
  coherenceApiKeyInput.value = "";
  coherenceStatus.textContent = "";
  updateCoherencePanel();
});

coherenceChangeKeyBtn.addEventListener("click", () => {
  clearStoredApiKey();
  coherenceStatus.textContent = "";
  updateCoherencePanel();
});

coherenceGenerateBtn.addEventListener("click", async () => {
  const filteredText = wordsToFilteredText(state.ocrWords, "filtered");
  coherenceGenerateBtn.disabled = true;
  coherenceChangeKeyBtn.disabled = true;
  coherenceStatus.textContent = "Generating…";
  try {
    const text = await reconstructCoherentText(filteredText);
    state.coherentText = text;
    resultText.value = text;
    coherenceStatus.textContent = "";
    refreshModifiedStates();
    if (ttsSupported) updateTTSButtons();
  } catch (err) {
    coherenceStatus.textContent = err.message || "Something went wrong.";
  } finally {
    coherenceGenerateBtn.disabled = false;
    coherenceChangeKeyBtn.disabled = false;
    coherenceGenerateBtn.textContent = state.coherentText ? "Regenerate" : "Generate";
  }
});

// Text view's Copy/Download path (see editor.js's getActiveResultText): always
// recompute from ocrWords + the active level rather than trusting resultText.value
// to still be in sync, so it can't go stale under some future code path. Coherence
// Filter has no ocrWords-derived text at all, so it reads the cached reconstruction.
setFilterTextHook(() =>
  state.activeFilterLevel === "coherence" ? state.coherentText || "" : wordsToFilteredText(state.ocrWords, state.activeFilterLevel)
);

// ---- Copy / Download ----

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

downloadImageBtn.addEventListener("click", () => {
  const canvas = buildResultCanvas();
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.activeMode === "full" ? "textscanner-full-image.png" : "textscanner-image-format.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
});

// ---- Inpainted patches (Phase 2) ----

function getOrComputePatch(obj) {
  if (patchCache.has(obj.id)) return patchCache.get(obj.id);
  const canvas = obj.originalBbox
    ? computeInpaintedPatch(previewImg, state.lastNaturalWidth, state.lastNaturalHeight, obj.originalBbox)
    : null;
  patchCache.set(obj.id, canvas);
  return canvas;
}

setPatchProvider((obj) => {
  const canvas = getOrComputePatch(obj);
  if (canvas) {
    obj.patchEl.style.backgroundImage = `url(${canvas.toDataURL()})`;
    obj.patchEl.style.backgroundSize = "100% 100%";
  } else if (obj.patchColor) {
    obj.patchEl.style.background = obj.patchColor;
  }
});

setPatchCanvasProvider((obj) => getOrComputePatch(obj));

// So undo/redo (see editor.js's restoreSnapshot) can recreate a user-added word
// that was fully removed (Delete, or redo-of-add) and clean up after one that's
// gone for good (redo-of-delete, or undo-of-add) - without editor.js needing to
// know about the patch cache it's cleaning up here.
configureUndoHooks({
  createFromSnapshot: (s) =>
    createWordObject({
      text: s.text || "",
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      fontSizePct: s.fontSizePct,
      origin: s.origin,
      confidence: null,
      bbox: null,
    }),
  onRemoved: (obj) => patchCache.delete(obj.id),
});

// ---- Delete selection (Phase 2/4): 'ocr' words clear their text and reveal an
// inpainted patch; 'user' words (Phase 4's "New text" tool) have no underlying
// image content to reveal, so they're removed outright instead. ----

setDeleteHandler((selectedObjects) => {
  if (!selectedObjects.length) return;
  const preSnapshot = snapshotState();
  let changed = false;
  selectedObjects.forEach((obj) => {
    if (obj.type !== "word") return;
    if (obj.origin === "user") {
      removeUserWordObject(obj);
      changed = true;
    } else if (obj.origin === "ocr") {
      if (obj.el.textContent === "") return;
      obj.el.textContent = "";
      changed = true;
    }
  });
  if (!changed) return;
  pushUndo(preSnapshot);
  refreshModifiedStates();
  clearSelection();
});

// ---- New text (Phase 4): arms add-mode; the next click on the image surface
// places a new user-added word there (see editor.js's addUserTextObject). ----

if (newTextBtn) {
  newTextBtn.addEventListener("click", () => {
    if (!state.fullEditorMode) setFullEditorMode(true);
    setAddTextMode(!state.addTextMode);
  });
}

setAddTextClickHandler((xPct, yPct) => addUserTextObject(xPct, yPct));

// ---- Text-to-speech (Phase 5) ----
//
// Reuses getActiveResultText() directly as the text source, so TTS gets mode,
// selection, and filter-level resolution for free instead of reimplementing
// any of it. Feature-detected once at startup: if speechSynthesis is absent,
// or supported but no voices are ever available, ttsControls stays hidden for
// the rest of the session rather than exposing controls that can't work.

let ttsSupported = false;

function updateTTSButtons() {
  const ttsState = getTTSState();
  ttsPlayBtn.textContent = ttsState === TTS_STATE.SPEAKING ? "Pause" : "Play";
  ttsPlayBtn.disabled = ttsState === TTS_STATE.IDLE && !getActiveResultText();
  ttsStopBtn.disabled = ttsState === TTS_STATE.IDLE;
}

// Per spec, TTS is scoped to Text/Image format - not Full image, which has its
// own editor toolbar already. Switching into Full image stops any in-progress
// speech too, since its controls are about to disappear with nothing left to
// stop it otherwise.
function updateTTSVisibility() {
  if (!ttsSupported) return;
  const visible = state.activeMode === "text" || state.activeMode === "image";
  if (visible) {
    show(ttsControls);
  } else {
    hide(ttsControls);
    stopTTS();
  }
  updateTTSButtons();
}

document.addEventListener("mode-changed", updateTTSVisibility);

ttsPlayBtn.addEventListener("click", () => {
  const ttsState = getTTSState();
  if (ttsState === TTS_STATE.IDLE) {
    const text = getActiveResultText();
    if (text) speak(text);
  } else if (ttsState === TTS_STATE.SPEAKING) {
    pauseTTS();
  } else if (ttsState === TTS_STATE.PAUSED) {
    resumeTTS();
  }
});

ttsStopBtn.addEventListener("click", () => stopTTS());

(async () => {
  if (!isTTSSupported()) return;
  const voices = await waitForVoices();
  if (!voices.length) return;
  ttsSupported = true;
  setTTSStateChangeHandler(updateTTSButtons);
  updateTTSVisibility();
})();
