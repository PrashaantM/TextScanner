// main.js: application bootstrap. Wires file input (drag/drop, paste, camera,
// sample image), the Scan text button (preprocessing + OCR via recognize.js), and
// Copy/Download, on top of the editor surface (js/editorObjects.js and its two
// sibling modules) that renders and manages
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
  coherenceTierName,
  coherenceTierSwitchBtn,
  coherenceDisclosureOnDevice,
  coherenceDisclosureClaude,
  coherenceDisclosureOrigin,
  coherenceUnavailable,
  newTextBtn,
  selectMultiBtn,
  confidenceNote,
  editorKeyboardHint,
  themeBtn,
  translateControls,
  translateTarget,
  translateBtn,
  translateRevertBtn,
  translateTier,
  translateStatus,
  footerEngine,
  ttsControls,
  ttsPlayBtn,
  ttsStopBtn,
} from "./dom.js";
import { state, MAX_FILE_BYTES, MAX_IMAGE_PIXELS } from "./state.js";
// editor.js was split into three modules (Phase 5); main.js imports from each
// directly rather than through a barrel, so which concern a call belongs to is
// visible at the import site.
import {
  clearImageFormatView,
  renderImageFormatView,
  setPatchProvider,
  setDeleteHandler,
  snapshotState,
  restoreSnapshot,
  pushUndo,
  updateUndoRedoButtons,
  refreshModifiedStates,
  clearSelection,
  removeUserWordObject,
  createWordObject,
  configureUndoHooks,
  setActiveButton,
  show,
  hide,
} from "./editorObjects.js";
import {
  setMode,
  setMarqueeMode,
  setFullEditorMode,
  setAddTextMode,
  setAddTextClickHandler,
  addUserTextObject,
} from "./editorInteractions.js";
import {
  getActiveResultText,
  buildResultCanvas,
  setPatchCanvasProvider,
  setFilterTextHook,
  getLineTexts,
  applyTranslatedLines,
} from "./editorExport.js";
import { recognizeImage, getEngineName, engineProvidesConfidence } from "./recognize.js";
import { computeInpaintedPatch } from "./inpaint.js";
import { wordsToFilteredText } from "./filter.js";
import { getTheme, cycleTheme, themeLabel } from "./theme.js";
import {
  translateLines,
  resolveTranslateTier,
  translateTierLabel,
  getOfferableLanguages,
  NON_LATIN_TARGETS,
  TRANSLATE_TIER,
} from "./translate.js";
import {
  getStoredApiKey,
  setStoredApiKey,
  clearStoredApiKey,
  reconstructCoherentText,
  resolveTier,
  tierLabel,
  isOnDeviceAvailable,
  invalidateAvailabilityCache,
  TIER,
} from "./coherence.js";
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

// ML Kit reports no per-word confidence at all, so on the native build the
// low-confidence underline can never appear - and an absent underline is
// exactly how this UI says "this word is fine". Stating the gap once, up
// front, is the difference between an honest silence and a misleading one.
if (confidenceNote && !engineProvidesConfidence()) show(confidenceNote);

// The footer claims recognition happens on-device with a named engine. That
// name differs per build (Tesseract.js on the web, ML Kit inside the iOS app),
// and the old hardcoded "Tesseract.js" was simply false in the shipped app, so
// it's filled in from the dispatcher that actually decides.
if (footerEngine) footerEngine.textContent = getEngineName();

// Scan failures used to interpolate err.message straight into user-facing copy,
// which produced things like "Something went wrong while scanning: Failed to
// execute 'getImageData' on 'CanvasRenderingContext2D'". That tells a user
// nothing they can act on, and leaks internals into the UI.
//
// These map the failures that actually happen to a sentence that says what went
// wrong and what to do about it. The raw error still goes to the console, where
// it belongs and where it's useful.
function describeScanError(err) {
  const raw = String(err?.message || err || "");

  if (/Failed to load the selected image/i.test(raw)) {
    return "That image couldn't be opened. It may be corrupted, or in a format this browser doesn't support.";
  }
  if (/getImageData|tainted|SecurityError/i.test(raw)) {
    return "That image couldn't be read for processing. Try saving it to your device first, then choosing it again.";
  }
  // Recognition is memory-hungry; a very large or very dense image can exhaust
  // what the tab is allowed, especially on a phone.
  if (/out of memory|Array buffer allocation|Aborted|memory access out of bounds/i.test(raw)) {
    return "The app ran out of memory on this image. Try a smaller or less detailed one.";
  }
  if (/NetworkError|Failed to fetch|Load failed/i.test(raw)) {
    return "Part of the OCR engine couldn't load. Reload the page and try again.";
  }
  if (/worker|wasm|WebAssembly/i.test(raw)) {
    return "The OCR engine couldn't start in this browser. Reload the page, or try a different browser.";
  }
  return "Something went wrong while scanning this image. Try again, or try a different image.";
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

// MAX_FILE_BYTES caps what the user can hand us; this caps what we decode. They
// are unrelated numbers - a well-compressed photo well under 15 MB can still
// decode into a pixel buffer big enough to lock up the main thread, since
// readImagePixels, preprocessImage and computeInpaintedPatch each allocate
// width*height*4 bytes and none of them yields.
//
// Downscaling replaces the working image outright (object URL included) rather
// than keeping a separate "big original", so every later stage - recognition,
// bbox math, patch sampling, PNG export - operates in one consistent coordinate
// space. The cost is that an export comes back at the reduced size, which is
// why this says so out loud instead of quietly shrinking someone's photo.
//
// Returns the message to show, or null if the image was left alone.
async function downscaleIfOversized() {
  const width = previewImg.naturalWidth;
  const height = previewImg.naturalHeight;
  const pixels = width * height;
  if (!pixels || pixels <= MAX_IMAGE_PIXELS) return null;

  const scale = Math.sqrt(MAX_IMAGE_PIXELS / pixels);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.getContext("2d").drawImage(previewImg, 0, 0, targetWidth, targetHeight);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  // A failed toBlob is not worth aborting a scan over: the original still
  // works, it just risks being slow. Better a sluggish scan than none.
  if (!blob) return null;

  if (state.currentObjectUrl) URL.revokeObjectURL(state.currentObjectUrl);
  state.currentObjectUrl = URL.createObjectURL(blob);
  previewImg.src = state.currentObjectUrl;
  await waitForImageDecode(previewImg);

  const mp = (n) => (n / 1_000_000).toFixed(1);
  return `That image was ${mp(pixels)} MP, large enough to stall the app, so it was scaled down to ${targetWidth}x${targetHeight} (${mp(targetWidth * targetHeight)} MP) for processing.`;
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
    const downscaleMessage = await downscaleIfOversized();

    const { words, text } = await recognizeImage(previewImg, previewImg.naturalWidth, previewImg.naturalHeight, (msg) => {
      if (msg.status && typeof msg.progress === "number") {
        const percent = Math.round(msg.progress * 100);
        progressFill.style.width = `${percent}%`;
        progressLabel.textContent = `${formatStatus(msg.status)} (${percent}%)`;
      }
    });

    hide(progressSection);

    const plainText = text || wordsToFilteredText(words, "raw");
    if (!plainText) {
      setStatus("No text was detected in this image. Try a clearer or higher-contrast image.", "error");
    } else {
      renderImageFormatView(previewImg, words, previewImg.naturalWidth, previewImg.naturalHeight, state.currentObjectUrl);
      applyFilterLevel(state.activeFilterLevel);
      setMode("text");
      show(resultSection);
      // The downscale is the more useful thing to say when it happened - the
      // scan obviously succeeded, since results are on screen.
      setStatus(downscaleMessage || "Text extracted successfully.", downscaleMessage ? "" : "success");
    }
  } catch (err) {
    hide(progressSection);
    // The categorized sentence goes to the user; the real error goes to the
    // console, which is where it's actually diagnosable.
    console.error("TextScanner scan failed:", err);
    setStatus(describeScanError(err), "error");
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
  setActiveButton(filterButtons, (btn) => btn.dataset.level === level);

  if (level === "coherence") {
    resultText.value = state.coherentText || "";
    // Deliberately not awaited: the panel resolves the on-device availability
    // asynchronously (a real query into the Foundation Models framework), and
    // blocking a filter-tab switch on that would make the tab feel laggy for a
    // result that only affects the panel's own contents.
    void updateCoherencePanel();
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

// Phase 2: which tier the user has asked for. Defaults to on-device, so anyone
// on an eligible device gets a working Coherence Filter with no API key at all;
// BYOK Claude is the opt-in higher-quality tier. resolveTier() falls back on its
// own when the preferred tier can't actually run, so this is a preference, not
// a promise.
let preferOnDevice = true;

// Shows the coherence panel in whichever state matches reality. There are more
// states than there used to be, because there are now two tiers: which one will
// run, the disclosure that belongs to that tier, whether a key is still needed,
// and the case where neither tier can run at all (which has to say so plainly
// rather than present a Generate button that can only fail).
// `displayTier`, when given, overrides the tier the panel would otherwise
// predict. It's for the one case where prediction and reality diverge: an
// on-device rewrite that failed and fell back to Claude. Without it the label
// would say Claude while the on-device disclosure sat underneath it, which is
// exactly the "which one just ran?" ambiguity this UI exists to remove.
async function updateCoherencePanel(displayTier) {
  show(coherencePanel);

  const hasKey = !!getStoredApiKey();
  const onDeviceAvailable = await isOnDeviceAvailable();
  const resolved = await resolveTier(preferOnDevice);
  const tier = displayTier || resolved.tier;
  const reason = displayTier ? null : resolved.reason;

  coherenceTierName.textContent = tierLabel(tier);
  coherenceDisclosureOnDevice.classList.toggle("hidden", tier !== TIER.ON_DEVICE);
  coherenceDisclosureClaude.classList.toggle("hidden", tier !== TIER.CLAUDE);
  coherenceDisclosureOrigin.classList.toggle("hidden", tier !== TIER.CLAUDE);

  // The key row is for entering a key, so it shows whenever there isn't one AND
  // a key would actually buy something: on an eligible device that's the
  // optional upgrade to Claude, and everywhere else it's the only way in.
  coherenceKeyRow.classList.toggle("hidden", hasKey);
  coherenceGenerateRow.classList.toggle("hidden", tier === TIER.NONE);
  coherenceGenerateBtn.textContent = state.coherentText ? "Regenerate" : "Generate";
  // With no key saved there is nothing to change, and on-device needs none.
  coherenceChangeKeyBtn.classList.toggle("hidden", !hasKey);

  coherenceUnavailable.textContent = tier === TIER.NONE ? reason || "" : "";
  coherenceUnavailable.classList.toggle("hidden", tier !== TIER.NONE);

  // The switch only appears when there is a genuine choice to make - both tiers
  // usable - rather than offering a toggle that would just fall back.
  const canSwitch = onDeviceAvailable && hasKey;
  coherenceTierSwitchBtn.classList.toggle("hidden", !canSwitch);
  if (canSwitch) {
    coherenceTierSwitchBtn.textContent = preferOnDevice ? "Use Claude instead" : "Use on-device instead";
  }
}

if (coherenceTierSwitchBtn) {
  coherenceTierSwitchBtn.addEventListener("click", () => {
    preferOnDevice = !preferOnDevice;
    // The cached reconstruction came from the other tier, so it no longer
    // matches what the panel now says it will produce.
    state.coherentText = null;
    resultText.value = "";
    updateCoherencePanel();
  });
}

coherenceSaveKeyBtn.addEventListener("click", () => {
  const key = coherenceApiKeyInput.value.trim();
  if (!key) return;
  setStoredApiKey(key);
  coherenceApiKeyInput.value = "";
  coherenceStatus.textContent = "";
  // Saving a key is an explicit request to use Claude - the tier the user just
  // went to the trouble of enabling - so it becomes the preference rather than
  // sitting unused behind an on-device default.
  preferOnDevice = false;
  updateCoherencePanel();
});

coherenceChangeKeyBtn.addEventListener("click", () => {
  clearStoredApiKey();
  coherenceStatus.textContent = "";
  // With the key gone, on-device is the only tier left that could run.
  preferOnDevice = true;
  updateCoherencePanel();
});

// Enabling Apple Intelligence happens in Settings, which means leaving the app
// and coming back - the one case where the availability answer genuinely
// changes mid-session, so it's rechecked on return rather than cached forever.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  invalidateAvailabilityCache();
  if (state.activeFilterLevel === "coherence") void updateCoherencePanel();
});

coherenceGenerateBtn.addEventListener("click", async () => {
  const filteredText = wordsToFilteredText(state.ocrWords, "filtered");
  coherenceGenerateBtn.disabled = true;
  coherenceChangeKeyBtn.disabled = true;
  coherenceStatus.textContent = "Generating…";
  try {
    // Returns the tier that actually ran, which is not always the one the panel
    // predicted: an on-device failure falls back to Claude when a key exists.
    // Reporting the real one keeps the label honest.
    const { text, tier } = await reconstructCoherentText(filteredText, preferOnDevice);
    state.coherentText = text;
    resultText.value = text;
    coherenceStatus.textContent = "";
    await updateCoherencePanel(tier);
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

// Text view's Copy/Download path (see editorExport.js's getActiveResultText): always
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

// So undo/redo (see editorObjects.js's restoreSnapshot) can recreate a user-added word
// that was fully removed (Delete, or redo-of-add) and clean up after one that's
// gone for good (redo-of-delete, or undo-of-add) - without editorObjects.js needing to
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

// Inpainting one word is 300 synchronous Gauss-Seidel iterations, which is fine.
// "Select all, Delete" on a dense screenshot serializes hundreds of them with no
// yield, no progress and no way to tell the app from a hung one - the UI simply
// stops for several seconds.
//
// The fix is not to make the solver faster but to stop running the whole batch
// in one uninterrupted block. Patches are computed one word at a time with a
// yield to the event loop between each, so the browser can paint the progress
// message, and are written into the same cache the synchronous patch provider
// reads - so by the time refreshModifiedStates asks for them they are already
// there and nothing downstream has to become async.
//
// Below this many words the yielding and the progress message are pure
// overhead: a handful of patches complete inside a frame or two.
const PATCH_PROGRESS_THRESHOLD = 8;

async function precomputePatches(objects) {
  const needed = objects.filter((obj) => obj.type === "word" && obj.origin === "ocr" && obj.originalBbox && !patchCache.has(obj.id));
  if (!needed.length) return;

  const showProgress = needed.length >= PATCH_PROGRESS_THRESHOLD;
  for (let i = 0; i < needed.length; i++) {
    getOrComputePatch(needed[i]);
    if (!showProgress) continue;
    setStatus(`Repairing the image where the text was… ${i + 1}/${needed.length}`);
    // A real yield, not a microtask: setTimeout(0) lets the browser lay out and
    // paint between words, which is the whole point. await Promise.resolve()
    // would keep the frame blocked exactly as before.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (showProgress) setStatus("");
}

setDeleteHandler(async (selectedObjects) => {
  if (!selectedObjects.length) return;
  const preSnapshot = snapshotState();
  let changed = false;
  const cleared = [];
  selectedObjects.forEach((obj) => {
    if (obj.type !== "word") return;
    if (obj.origin === "user") {
      removeUserWordObject(obj);
      changed = true;
    } else if (obj.origin === "ocr") {
      if (obj.el.textContent === "") return;
      obj.el.textContent = "";
      cleared.push(obj);
      changed = true;
    }
  });
  if (!changed) return;
  pushUndo(preSnapshot);
  clearSelection();
  // Before the refresh, so the patches it asks for are already cached and it
  // doesn't trigger the serialized run this exists to avoid.
  await precomputePatches(cleared);
  refreshModifiedStates();
});

// ---- New text (Phase 4): arms add-mode; the next click on the image surface
// places a new user-added word there (see editorInteractions.js's addUserTextObject). ----

if (newTextBtn) {
  newTextBtn.addEventListener("click", () => {
    if (!state.fullEditorMode) setFullEditorMode(true);
    setAddTextMode(!state.addTextMode);
  });
}

setAddTextClickHandler((xPct, yPct) => addUserTextObject(xPct, yPct));

// ---- Translate in place (Phase 4c) ----
//
// The flow is: read the recognized text back a line at a time, translate the
// lines, write them back into the same positions. editorExport.js owns the reading
// and writing (getLineTexts / applyTranslatedLines) because that is object-model
// work; translate.js owns the choice of tier. This is only the wiring between
// them plus the button states.
//
// Restricted to the two image views. "In place" is meaningless in the plain
// Text view, which has no positions to put anything back into.

let translateLanguagesLoaded = false;
let preTranslateSnapshot = null;

async function populateTranslateLanguages() {
  if (translateLanguagesLoaded) return;
  const languages = await getOfferableLanguages();
  translateTarget.innerHTML = "";
  languages.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    translateTarget.appendChild(option);
  });
  translateLanguagesLoaded = true;

  // An ineligible device with no key can offer nothing at all. An empty dropdown
  // next to an enabled button is a dead end that only reveals itself when the
  // user presses it, so the control turns itself off and says why instead.
  if (!languages.length) {
    const { reason } = await resolveTranslateTier(null);
    translateTarget.disabled = true;
    translateBtn.disabled = true;
    translateTier.textContent = "";
    translateStatus.textContent = reason || "Translation isn't available on this device.";
    return;
  }

  translateTarget.disabled = false;
  // Default to the reader's own language where it's on offer - the common case
  // is translating something foreign INTO what you speak, not out of it.
  const preferred = (navigator.language || "en").split("-")[0];
  if (languages.some((l) => l.code === preferred)) translateTarget.value = preferred;
  await updateTranslateTier();
}

async function updateTranslateTier() {
  if (!translateTarget.value) {
    translateBtn.disabled = true;
    return;
  }
  const { tier, reason } = await resolveTranslateTier(translateTarget.value);
  translateTier.textContent = tier === TRANSLATE_TIER.NONE ? "" : `via ${translateTierLabel(tier)}`;
  translateBtn.disabled = tier === TRANSLATE_TIER.NONE;
  translateStatus.textContent = tier === TRANSLATE_TIER.NONE ? reason || "" : "";
}

function updateTranslateVisibility() {
  const visible = state.activeMode === "image" || state.activeMode === "full";
  if (!visible) {
    hide(translateControls);
    return;
  }
  show(translateControls);
  void populateTranslateLanguages();
}

document.addEventListener("mode-changed", updateTranslateVisibility);

translateTarget.addEventListener("change", () => {
  void updateTranslateTier();
});

translateBtn.addEventListener("click", async () => {
  const lines = getLineTexts();
  if (!lines.length) {
    translateStatus.textContent = "There's no recognized text to translate.";
    return;
  }

  const targetCode = translateTarget.value;
  translateBtn.disabled = true;
  translateStatus.textContent = "Translating…";

  // Captured before anything changes so "Revert to original" is a single
  // restore rather than an unknown number of undo steps - the translation
  // touches every line at once, and a user who wants the original back means
  // all of it, not the last line.
  const snapshotBeforeTranslation = snapshotState();

  try {
    const { lines: translated, tier } = await translateLines(lines, targetCode, {
      onProgress: ({ done, total }) => {
        translateStatus.textContent = total > 1 ? `Translating… ${done}/${total} lines` : "Translating…";
      },
    });
    const changed = applyTranslatedLines(translated);
    preTranslateSnapshot = snapshotBeforeTranslation;
    translateTier.textContent = `via ${translateTierLabel(tier)}`;
    translateStatus.textContent = changed ? `Translated ${changed} line${changed === 1 ? "" : "s"}.` : "Nothing needed translating.";
    if (changed) show(translateRevertBtn);
    if (NON_LATIN_TARGETS.has(targetCode)) {
      // Worth saying once, at the moment it becomes true: this renders and
      // exports correctly, but scanning the result back in won't work on the
      // native build, which only loads ML Kit's Latin model.
      translateStatus.textContent += " Note: this app can't re-scan text in this script.";
    }
  } catch (err) {
    translateStatus.textContent = err.message || "Translation failed.";
  } finally {
    translateBtn.disabled = false;
  }
});

translateRevertBtn.addEventListener("click", () => {
  if (!preTranslateSnapshot) return;
  const current = snapshotState();
  state.undoStack.push(current);
  restoreSnapshot(preTranslateSnapshot);
  updateUndoRedoButtons();
  preTranslateSnapshot = null;
  hide(translateRevertBtn);
  translateStatus.textContent = "Reverted to the original text.";
});

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

// "Select multiple" only makes sense where words have positions to rubber-band
// across, and it must not linger armed after leaving those views - it takes
// scrolling away from the surface while it's on.
function updateSelectMultiVisibility() {
  if (!selectMultiBtn) return;
  const visible = state.activeMode === "image" || state.activeMode === "full";
  if (visible) {
    show(selectMultiBtn);
  } else {
    hide(selectMultiBtn);
    if (state.marqueeMode) setMarqueeMode(false);
  }
}

// The editor's keyboard bindings, shown where they're discoverable rather than
// left to be guessed - and only in the views they apply to.
function updateKeyboardHintVisibility() {
  if (!editorKeyboardHint) return;
  if (state.activeMode === "image" || state.activeMode === "full") show(editorKeyboardHint);
  else hide(editorKeyboardHint);
}

document.addEventListener("mode-changed", updateKeyboardHintVisibility);

document.addEventListener("mode-changed", updateSelectMultiVisibility);

// ---- Theme (Phase 6) ----
//
// Cycles system -> light -> dark. js/theme.js applies the stored choice at
// module load, so this only has to keep the button's label truthful.

if (themeBtn) {
  themeBtn.textContent = themeLabel(getTheme());
  themeBtn.addEventListener("click", () => {
    themeBtn.textContent = themeLabel(cycleTheme());
  });
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
