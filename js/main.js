// main.js: application bootstrap. Wires file input (drag/drop, paste, camera,
// sample image), the Scan text button (preprocessing + OCR via recognize.js), and
// Download, on top of the editor surface (js/editorObjects.js and its two
// sibling modules) that renders and manages the OCR result. Copy/paste is
// wired in js/editorInteractions.js instead (Phase 2) - this module only
// supplies the Text-mode paste-replace hook it doesn't have direct access to.
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
  downloadBtn,
  downloadMenu,
  downloadMenuBackdrop,
  filterButtons,
  filterCoherenceBtn,
  modeImageBtn,
  modeFullBtn,
  coherenceGateHint,
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
  footerVersion,
  ttsControls,
  ttsPlayBtn,
  ttsStopBtn,
  diagnosticsExportBtn,
  diagnosticsIncludeImage,
  diagnosticsStatus,
} from "./dom.js";
import { state, MAX_FILE_BYTES, MAX_IMAGE_PIXELS, APP_VERSION } from "./state.js";
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
  setWordRemoved,
  describeNotTextWarning,
  createWordObject,
  configureUndoHooks,
  setActiveButton,
  show,
  hide,
  revealFlowPanel,
} from "./editorObjects.js";
import { setMode, setTextPasteReplaceHandler } from "./editorInteractions.js";
import {
  getActiveResultText,
  buildResultCanvas,
  setPatchCanvasProvider,
  setFilterTextHook,
  getLineTexts,
  applyTranslatedLines,
} from "./editorExport.js";
import { recognizeImage, getEngineName, engineProvidesConfidence } from "./recognize.js";
import { exportDiagnosticReport } from "./diagnostics.js";
import { hapticLight, hapticMedium } from "./haptics.js";
import { computeInpaintedPatch } from "./inpaint.js";
import { wordsToFilteredText } from "./filter.js";
import { getTheme, setTheme, cycleTheme, themeLabel } from "./theme.js";
// Side-effect only (Phase 5): applies and live-updates the
// prefers-reduced-transparency root class. No exports to pull in.
import "./reducedTransparency.js";
import { openRadialMenu } from "./radialMenu.js";
// The application shell - library, documents, routing. main.js owns the scan
// flow; app.js owns everything around it. The dependency runs one way: main.js
// reaches the document model through `bridge`, and app.js never reaches back
// into the scan flow's internals.
import { showView, VIEWS } from "./views.js";
import { initApp, bridge } from "./app.js";
import { detectLanguage, describeDetection } from "./langDetect.js";
import { recordTranslation } from "./translateHistory.js";
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
import { looksAlreadyCoherent } from "./coherenceGate.js";
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
if (footerVersion) footerVersion.textContent = APP_VERSION;

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

// Top-level flow panel transitions (Phase 17): revealFlowPanel (see
// editorObjects.js) drives the preview/progress/results fade+lift on reveal;
// concealing them is a plain hide(), see revealFlowPanel's comment for why.

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
  resetCoherenceGate();
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

  // A file can now arrive from anywhere - the library's empty state, a drop on
  // the settings screen, a paste while reading a note - so choosing one brings
  // the capture view forward rather than updating a screen nobody is looking at.
  // This is also what keeps the test suite's setInputFiles("#file-input") ->
  // click("#scan-btn") sequence working from a cold load.
  showView(VIEWS.SCAN);

  resetResult();
  revealFlowPanel(previewSection);
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
  // img.complete goes true once loading finishes, success OR failure - a failed
  // load leaves naturalWidth at 0. Loading finishes as soon as the object URL is
  // assigned in loadFile(), well before the user gets to Scan text, so by the
  // time this runs the load/error event has usually already fired. Attaching
  // fresh listeners at that point waits for an event that already happened and
  // will never fire again, hanging the scan forever with no status update -
  // this has to resolve the already-settled case synchronously instead.
  if (img.complete) {
    return img.naturalWidth ? Promise.resolve() : Promise.reject(new Error("Failed to load the selected image."));
  }
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
  revealFlowPanel(progressSection);
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
      await renderImageFormatView(previewImg, words, previewImg.naturalWidth, previewImg.naturalHeight, state.currentObjectUrl);
      applyFilterLevel(state.activeFilterLevel);
      // Suggest a translation target from what was actually recognized, so the
      // translate controls open with a sensible default rather than an
      // arbitrary first option.
      updateDetectedLanguage();
      setMode("text");
      revealFlowPanel(resultSection);
      hapticMedium();
      // The downscale is the more useful thing to say when it happened - the
      // scan obviously succeeded, since results are on screen.
      setStatus(downscaleMessage || "Text extracted successfully.", downscaleMessage ? "" : "success");
    }
  } catch (err) {
    hide(progressSection);
    // The categorized sentence goes to the user; the real error goes to the
    // console, which is where it's actually diagnosable.
    console.error("TextScanner scan failed:", err);
    const message = describeScanError(err);
    state.lastScanError = message;
    setStatus(message, "error");
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

// Raw/Filtered Text get the generic handler; Coherence Filter (now also
// labeled "Clean up this text" - UI-REDESIGN-PLAN.md §2.5, merged from the
// old guided cleanUpTextBtn proxy) gets its own below, so the skip-the-call
// gate can sit in front of applyFilterLevel("coherence") on every path that
// reaches it, not just the deleted guided button's path.
filterButtons
  .filter((btn) => btn !== filterCoherenceBtn)
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      applyFilterLevel(btn.dataset.level);
      hapticLight();
    });
  });

// Skip-the-call gate (js/coherenceGate.js): a suggestion, not a silent
// skip. The first click on already-coherent-looking text swaps the button to
// "Reconstruct anyway" instead of running the filter; a second click - now
// past the gate - proceeds exactly as it always did. resetCoherenceGate lets
// resetResult() below clear this back to the default label for a new scan,
// so a "Reconstruct anyway" state can never survive onto a different image.
let pendingCoherenceOverride = false;
function resetCoherenceGate() {
  pendingCoherenceOverride = false;
  filterCoherenceBtn.textContent = "Clean up this text";
  hide(coherenceGateHint);
}

filterCoherenceBtn.addEventListener("click", () => {
  const filteredText = wordsToFilteredText(state.ocrWords, "filtered");
  const alreadyCoherent = !state.coherentText && looksAlreadyCoherent(filteredText);

  if (alreadyCoherent && !pendingCoherenceOverride) {
    pendingCoherenceOverride = true;
    filterCoherenceBtn.textContent = "Reconstruct anyway";
    coherenceGateHint.textContent = "This already looks like a sentence.";
    show(coherenceGateHint);
    hapticLight();
    return;
  }

  resetCoherenceGate();
  applyFilterLevel("coherence");
  hapticLight();
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
    const { text, tier, factCheck } = await reconstructCoherentText(filteredText, preferOnDevice);
    state.coherentText = text;
    resultText.value = text;
    // Deterministic, no extra tokens (js/factCheck.js): catches a rewrite that
    // dropped a price, date, time or number the prompt already asked it to
    // keep. A nudge to double check, not an error - the rewrite is still shown.
    coherenceStatus.textContent =
      factCheck && !factCheck.ok ? `Double check: the rewrite may have dropped ${factCheck.missing.join(", ")}.` : "";
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

// ---- Download ----
//
// Text mode's own Copy is gone (Phase 2 of the interaction-model rewrite)
// with no replacement needed: #result-text is a plain (if read-only)
// textarea, so selecting text in it and pressing Ctrl/Cmd+C already copies
// it via the browser's native handling - nothing left for this app to do.

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Always the WHOLE recognized text, never just the selected word - see
// getActiveResultText's header in js/editorExport.js for why Download and Copy
// want different answers to what looks like the same question.
function downloadResultText() {
  const text = getActiveResultText({ restrictToSelection: false });
  if (!text) return;
  downloadFile(new Blob([text], { type: "text/plain" }), "textscanner-result.txt");
}

function downloadResultImage() {
  const canvas = buildResultCanvas();
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadFile(blob, state.activeMode === "full" ? "textscanner-full-image.png" : "textscanner-image-format.png");
  }, "image/png");
}

// One small corner menu (Phase 3), consolidating Download
// (UI-REDESIGN-PLAN.md §2.1 already merged Image+Text into these two items),
// Save as note and Add as document page. Always opens the menu now, in every
// mode - Text mode used to skip straight to downloading the text back when
// Download was the only thing here; now the other two items need to stay
// reachable there too. See the markup comment in index.html for why that's
// safe: buildResultCanvas renders a meaningful image-format snapshot
// regardless of which mode is currently showing.
function closeDownloadMenu() {
  if (!downloadMenu) return;
  downloadMenu.classList.add("hidden");
  downloadMenuBackdrop.classList.add("hidden");
  downloadBtn.setAttribute("aria-expanded", "false");
}

// Anchored to the button: directly beneath it, and RIGHT-aligned with it
// rather than left, because the button now sits at the right edge of a
// right-aligned toolbar row (.result-toolbar__actions) - a menu growing
// rightwards from a control that is already against the right margin either
// runs off the screen or straddles the edge it is supposed to hang from.
//
// Measured after the menu is visible, not before: it is `display: none` while
// hidden, so offsetWidth reads 0 and a right-aligned position computed from it
// would land the menu's left edge exactly on the button's right edge. Unhiding
// first costs one forced layout on a click, which is free at this rate.
//
// Clamped to the viewport on both axes afterwards. The clamp is what makes this
// correct on a narrow phone, where a 4-item menu anchored under a button near
// the right margin can be wider than the space left to its left; and flipping
// above the button when there is no room below is what keeps the last item
// reachable when the toolbar has been scrolled near the bottom of the screen.
const MENU_VIEWPORT_MARGIN = 8;

function openDownloadMenu() {
  if (!downloadMenu) return;
  downloadMenu.classList.remove("hidden");
  downloadMenuBackdrop.classList.remove("hidden");

  const rect = downloadBtn.getBoundingClientRect();
  const width = downloadMenu.offsetWidth;
  const height = downloadMenu.offsetHeight;

  const maxX = window.innerWidth - width - MENU_VIEWPORT_MARGIN;
  const x = Math.max(MENU_VIEWPORT_MARGIN, Math.min(rect.right - width, maxX));

  const below = rect.bottom + 4;
  const y = below + height > window.innerHeight - MENU_VIEWPORT_MARGIN ? Math.max(MENU_VIEWPORT_MARGIN, rect.top - height - 4) : below;

  downloadMenu.style.setProperty("--menu-x", `${x}px`);
  downloadMenu.style.setProperty("--menu-y", `${y}px`);
  downloadBtn.setAttribute("aria-expanded", "true");
}

downloadBtn.addEventListener("click", () => {
  if (downloadMenu.classList.contains("hidden")) openDownloadMenu();
  else closeDownloadMenu();
});

downloadMenu?.addEventListener("click", (e) => {
  const downloadButton = e.target.closest("button[data-download]");
  if (downloadButton) {
    closeDownloadMenu();
    if (downloadButton.dataset.download === "image") downloadResultImage();
    else downloadResultText();
    return;
  }
  const actionButton = e.target.closest("button[data-menu-action]");
  if (!actionButton) return;
  closeDownloadMenu();
  if (actionButton.dataset.menuAction === "save-note") saveResultAsNote();
  else addCurrentImageAsDocumentPage();
});

downloadMenuBackdrop?.addEventListener("click", closeDownloadMenu);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && downloadMenu && !downloadMenu.classList.contains("hidden")) closeDownloadMenu();
});

document.addEventListener("mode-changed", closeDownloadMenu);

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
      // Was dropped on the floor: the snapshot carries rotationDeg, and a word
      // recreated by Undo came back level no matter how the photo was tilted.
      rotationDeg: s.rotationDeg,
      origin: s.origin,
      confidence: null,
      bbox: null,
      fontClass: s.fontClass,
      // Carried for the same reason rotationDeg above is, and lost the same
      // way if it isn't: a matched bold or italic word recreated by Undo came
      // back in the app's default face.
      fontWeight: s.fontWeight,
      fontItalic: s.fontItalic,
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

  // A region OCR probably misread as a word - a logo, an icon, a decorative
  // rule - gets one question before its pixels are painted over. See
  // scoreRegionsForNotText in js/editorObjects.js for the rule and the measured
  // flag rates, and why this warns rather than filtering those regions out.
  //
  // Only in front of the delete that actually destroys something. Retiring an
  // ALREADY-emptied leftover is excluded by describeNotTextWarning's own
  // textContent check: those pixels are gone already, the patch is already
  // drawn, and asking again would be a prompt that protects nothing - the fast
  // way to teach someone to dismiss these without reading them.
  const warning = describeNotTextWarning(selectedObjects);
  // Dismiss must not delete. Same discipline as every other confirm in the app
  // (test/destructive-actions.js): OK acts, Cancel does nothing at all - not a
  // partial delete of the unflagged half of the selection, which would be a
  // destructive action taken by a button labelled Cancel.
  if (warning && !window.confirm(warning)) return;

  const preSnapshot = snapshotState();
  let changed = false;
  const cleared = [];
  selectedObjects.forEach((obj) => {
    if (obj.type !== "word") return;
    if (obj.origin === "user") {
      removeUserWordObject(obj);
      changed = true;
    } else if (obj.origin === "ocr") {
      if (obj.el.textContent === "") {
        // Already emptied by an earlier Delete (or by backspacing it away).
        // Pressing Delete on the leftover used to `return` here, so nothing
        // happened at all - no removal, no cleared selection, not even a
        // refusal - while the Delete button sat enabled promising otherwise.
        // Second Delete retires it: see setWordRemoved for why the object and
        // its patch have to survive even though the span must not.
        if (!obj.removed) {
          setWordRemoved(obj, true);
          changed = true;
        }
        return;
      }
      obj.el.textContent = "";
      cleared.push(obj);
      changed = true;
    }
  });
  if (!changed) return;
  pushUndo(preSnapshot);
  clearSelection();
  hapticMedium();
  // Before the refresh, so the patches it asks for are already cached and it
  // doesn't trigger the serialized run this exists to avoid.
  await precomputePatches(cleared);
  refreshModifiedStates();
});

// ---- Text mode's Ctrl/Cmd+V (Phase 2) ----
//
// The one capability that genuinely had no native fallback once paste-btn
// was deleted: #result-text is readonly, so a native paste into it is
// rejected outright, and the destructive whole-buffer replace this ran was
// never something more than a button click could do anyway. Retriggered by
// Ctrl/Cmd+V (js/editorInteractions.js's keydown handler, via
// setTextPasteReplaceHandler) instead of a button click - same confirm gate,
// same destructive-replace semantics, unchanged.
//
// Image format/Full image's own paste (arm a placement click, clone a
// copied element's font/size/colour) is wired entirely inside
// editorInteractions.js now - it no longer needs anything from this module.
setTextPasteReplaceHandler(async () => {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (!text) return;
  if (!window.confirm("Replace the extracted text with what's on your clipboard? This can't be undone.")) return;
  resultText.value = text;
  hapticLight();
});

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
    // Remembered so the same text does not have to be translated - and, on the
    // Claude tier, billed - twice. Device-local and clearable in Settings.
    rememberTranslation(lines.join("\n"), translated.join("\n"), targetCode, translateTierLabel(tier));
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

// The editor's keyboard bindings, shown where they're discoverable rather than
// left to be guessed - and only in the views they apply to.
function updateKeyboardHintVisibility() {
  if (!editorKeyboardHint) return;
  if (state.activeMode === "image" || state.activeMode === "full") show(editorKeyboardHint);
  else hide(editorKeyboardHint);
}

document.addEventListener("mode-changed", updateKeyboardHintVisibility);

// ---- Theme (Phase 6) ----
//
// Cycles system -> light -> dark. js/theme.js applies the stored choice at
// module load, so this only has to keep the button's label truthful.

if (themeBtn) {
  themeBtn.textContent = themeLabel(getTheme());
  themeBtn.addEventListener("click", () => {
    themeBtn.textContent = themeLabel(cycleTheme());
  });

  // Long-press turns the same button into a direct three-way radial pick
  // (06-INTERACTION-MODEL-SPEC.md, call site 3) - a plain click still cycles
  // exactly as it does today, unchanged; this is additive, and a good test
  // of whether the primitive generalizes since this button is nothing like a
  // card or a create button. radialMenu.js's own originEl swallow is what
  // stops a fired selection from also re-triggering the cycle-click above -
  // not preventDefault, which would be a no-op by the time a 420ms timer
  // fires, long after the pointerdown event that started it finished
  // dispatching.
  let pressTimer = null;
  const setThemeAndLabel = (theme) => {
    themeBtn.textContent = themeLabel(setTheme(theme));
  };
  themeBtn.addEventListener("pointerdown", (event) => {
    // Gated to touch/pen, exactly as call site 1 (#nav-add) in js/app.js is.
    // This used to accept any pointer, so a 420ms mouse press-and-hold opened a
    // radial menu here while the identical gesture on "+ New" correctly gave the
    // flat action sheet - one primitive, two different answers to "is this
    // gesture for a mouse?". A desktop user who happened to hold the button got
    // a gesture menu they did not ask for and could not discover, and the
    // inconsistency is the kind that makes an interaction model feel arbitrary.
    // The plain click below still cycles the theme for everyone.
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      const rect = themeBtn.getBoundingClientRect();
      openRadialMenu({
        originX: rect.left + rect.width / 2,
        originY: rect.top + rect.height / 2,
        originEl: themeBtn,
        arcCenter: 180,
        arcSpan: 90,
        items: [
          { id: "system", label: "System", onSelect: () => setThemeAndLabel("system") },
          { id: "light", label: "Light", onSelect: () => setThemeAndLabel("light") },
          { id: "dark", label: "Dark", onSelect: () => setThemeAndLabel("dark") },
        ],
      });
    }, 420);
  });
  themeBtn.addEventListener("pointerup", () => clearTimeout(pressTimer));
  themeBtn.addEventListener("pointerleave", () => clearTimeout(pressTimer));
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

// ---- Diagnostic export (Phase 15): opt-in, user-triggered, no automatic collection ----

if (diagnosticsExportBtn) {
  diagnosticsExportBtn.addEventListener("click", async () => {
    diagnosticsExportBtn.disabled = true;
    diagnosticsStatus.textContent = "Building report…";
    try {
      await exportDiagnosticReport(diagnosticsIncludeImage.checked);
      diagnosticsStatus.textContent = "Report ready — choose a destination in the share sheet.";
    } catch (err) {
      // AbortError means the person closed the share sheet without picking a
      // destination - not a failure, nothing to tell them went wrong.
      if (err?.name === "AbortError") {
        diagnosticsStatus.textContent = "";
      } else {
        console.error("Diagnostic export failed:", err);
        diagnosticsStatus.textContent = "Couldn't build the diagnostic report. Try again.";
      }
    } finally {
      diagnosticsExportBtn.disabled = false;
    }
  });
}

// ---- Application shell ----
//
// Everything above this line is the scan flow, unchanged in behaviour. What
// follows connects it to the library: a captured image can become a page in a
// multi-page document, and recognized text can become a note.
//
// The two functions below are the whole bridge, and they run in opposite
// directions: addCurrentImageAsDocumentPage sends the IMAGE into a scan
// document; saveResultAsNote sends the TEXT into a note. Both used to be
// standalone buttons; both are now items in #download-menu (Phase 3's "one
// small corner menu" - see that menu's own wiring above), addressed by
// data-menu-action rather than an id each, so there's no per-button element
// to hold this file's own reference the way addToDocBtn/saveNoteBtn used to -
// re-queried from the menu each time instead.

async function addCurrentImageAsDocumentPage() {
  const menuItem = downloadMenu?.querySelector('[data-menu-action="add-to-doc"]');
  if (!previewImg?.naturalWidth) {
    setStatus("Choose an image first.", "error");
    return;
  }
  if (menuItem) menuItem.disabled = true;
  try {
    await bridge.addCurrentImageAsPage(previewImg);
  } catch (err) {
    console.error("Couldn't add the page:", err);
    setStatus("Couldn't add that image as a page. Try again.", "error");
  } finally {
    if (menuItem) menuItem.disabled = false;
  }
}

async function saveResultAsNote() {
  const menuItem = downloadMenu?.querySelector('[data-menu-action="save-note"]');
  const text = getActiveResultText();
  if (!text || !text.trim()) {
    setStatus("There's no text to save yet. Scan an image first.", "error");
    return;
  }

  // The note is created with the text already in its body rather than created
  // empty and then typed into - so a failure leaves no empty note behind.
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split("\n").map(escapeNoteLine).join("<br>")}</p>`)
    .join("");

  // First line makes a better default title than "Untitled note".
  const firstLine = text.split("\n").find((line) => line.trim()) || "";
  const title = firstLine.trim().slice(0, 60);

  if (menuItem) menuItem.disabled = true;
  try {
    await bridge.createAndOpenNote({ body: paragraphs, title });
    hapticMedium();
  } catch (err) {
    console.error("Couldn't save the note:", err);
    setStatus("Couldn't save that as a note.", "error");
  } finally {
    if (menuItem) menuItem.disabled = false;
  }
}

function escapeNoteLine(line) {
  return String(line ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- Language detection for translation ----
//
// Fills the detected-language hint and pre-selects a sensible target, so the
// translate controls arrive with a reasonable default instead of an empty
// dropdown. Always a SUGGESTION - js/langDetect.js reports a confidence and the
// label hedges accordingly, because a confidently wrong language is worse than
// an honest question.
const translateDetected = document.getElementById("translate-detected");

export function updateDetectedLanguage() {
  if (!translateDetected) return;

  const text = (state.ocrWords || [])
    .map((w) => w.text)
    .join(" ")
    .trim();

  if (!text) {
    translateDetected.textContent = "";
    return;
  }

  const detection = detectLanguage(text);
  translateDetected.textContent = detection ? describeDetection(detection) : "";

  // Never override a choice the person has already made.
  if (detection && translateTarget && !translateTarget.dataset.userChosen) {
    const match = [...translateTarget.options].find((option) => option.value === detection.code);
    // Only switch away from the source language - translating English into
    // English is not a useful default.
    if (match && detection.code !== "en") translateTarget.value = detection.code;
  }
}

translateTarget?.addEventListener("change", () => {
  translateTarget.dataset.userChosen = "true";
});

// Records every completed translation so it can be found again without
// re-running it (and re-billing it, on the Claude tier). Device-local, capped,
// and clearable from Settings - see js/translateHistory.js.
export async function rememberTranslation(sourceText, translatedText, targetCode, tier) {
  try {
    const detection = detectLanguage(sourceText);
    await recordTranslation({
      sourceText,
      translatedText,
      sourceLang: detection?.code || null,
      targetLang: targetCode,
      tier,
    });
  } catch (err) {
    // History is a convenience. It must never be able to fail a translation
    // that otherwise worked.
    console.error("Couldn't record the translation:", err);
  }
}

// Boot the shell last, once every handler above is attached.
initApp().catch((err) => {
  console.error("The app shell failed to start:", err);
});
