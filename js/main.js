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
} from "./editor.js";
import { recognizeImage } from "./ocrEngine.js";
import { wordsToText } from "./textUtil.js";
import { computeInpaintedPatch } from "./inpaint.js";

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
  resultText.value = "";
  hide(resultSection);
  setStatus("");
  hide(progressSection);
  progressFill.style.width = "0%";
  clearImageFormatView();
  setMode("text");
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
      resultText.value = plainText;
      renderImageFormatView(previewImg, words, previewImg.naturalWidth, previewImg.naturalHeight, state.currentObjectUrl);
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

// ---- Delete selection (Phase 2: clears an OCR word's text and reveals its
// inpainted patch; Phase 4 will extend this to remove user-added components). ----

setDeleteHandler((selectedObjects) => {
  if (!selectedObjects.length) return;
  const preSnapshot = snapshotState();
  let changed = false;
  selectedObjects.forEach((obj) => {
    if (obj.type !== "word" || obj.origin !== "ocr") return;
    if (obj.el.textContent === "") return;
    obj.el.textContent = "";
    changed = true;
  });
  if (!changed) return;
  pushUndo(preSnapshot);
  refreshModifiedStates();
  clearSelection();
});
