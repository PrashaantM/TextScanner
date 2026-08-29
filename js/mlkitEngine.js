// mlkitEngine.js: native recognition path via Capacitor + Google ML Kit Text
// Recognition v2 (iOS - the only native platform this project targets; see
// js/recognize.js for the web/Tesseract.js fallback used everywhere else).
// Writes the current image to native cache storage (ML Kit's processImage
// needs a real filesystem path, not a Blob/canvas), runs recognition, and
// normalizes ML Kit's block/line/element hierarchy into the same flat
// { lineIndex, text, confidence, bbox } word list js/ocrEngine.js produces,
// so editor.js/filter.js/main.js need no changes regardless of which engine
// actually ran.
//
// No bundler is used anywhere in this app (index.html loads plain
// <script type="module"> files), and Capacitor's native CAPBridgeViewController
// (the root view controller in ios/App/App/Base.lproj/Main.storyboard)
// auto-injects window.Capacitor and window.Capacitor.Plugins.* directly into
// the WKWebView before any page JS runs - there's no ES import path to
// @capacitor/filesystem's Directory/Encoding enums or
// @capacitor-mlkit/text-recognition's Script enum available here. Their
// runtime string values (confirmed against the installed packages'
// definitions, not guessed) are used directly instead:
// Directory.Cache = "CACHE", Script.Latin = "LATIN". Filesystem.writeFile
// treats `data` as base64 whenever `encoding` is omitted (its documented
// default for binary writes).
//
// The file:// URI Filesystem.writeFile returns is passed to processImage
// as-is, deliberately not stripped to a bare path - traced through both
// native plugins' source (still no device run to confirm at runtime, but
// this is no longer a guess): @capacitor/filesystem's iOS side builds
// `uri` from `url.absoluteString` (IONFileStructures+Converters.swift), and
// the ML Kit plugin's createVisionImageFromFilePath does
// `URL(string: path)!.path` (TextRecognition.swift), which strips the
// file:// scheme itself. Stripping it here first would be redundant, not
// a fix.
//
// KNOWN LIMITATION, intentionally not fixed in this pass: `script` is
// hardcoded to Latin. ML Kit needs a separate bundled model per script
// (Latin/Chinese/Devanagari/Japanese/Korean) with no universal/auto-detect
// option - fine for the English-text validation images, a real gap for
// non-Latin text to revisit once the core approach is validated.

// DIAGNOSTIC, temporary: see js/mlkitDebug.js. Records ML Kit's raw result so
// the Image format positioning bug can be replayed off-device. Changes nothing
// about what this module returns, and is OFF unless explicitly armed - on a
// shipped build recordScan is a no-op that records and writes nothing.
import { recordScan } from "./mlkitDebug.js";
import { state } from "./state.js";

const CACHE_FILE_PATH = "textscanner-scan-input.jpg";
// ML Kit gives no per-word confidence score at all (unlike Tesseract), so every
// word's confidence is null - explicitly absent, not a number.
//
// This used to be a fixed placeholder of 100. That was well-intentioned (it
// avoided inventing a real-looking score) but it read, everywhere downstream,
// as "the engine was completely certain about every single word": the
// low-confidence underline never appeared, and its absence is exactly the
// signal the UI uses to mean "this one is fine". A user had no way to tell
// "nothing was flagged" from "flagging doesn't work here".
//
// null instead says what's true. editor.js already guards its low-confidence
// styling on `confidence != null`, and filter.js's confidence check is
// typeof-guarded, so neither fabricates anything from a missing score. The gap
// is then stated outright in the UI - see engineProvidesConfidence() in
// js/recognize.js and the note it drives in js/main.js.
const NO_CONFIDENCE_SIGNAL = null;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      // reader.result is "data:<mime>;base64,<data>" - writeFile wants the
      // bare base64 payload.
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read image data."));
    reader.readAsDataURL(blob);
  });
}

// Walks ML Kit's block -> line -> element hierarchy into a flat word list,
// assigning a fresh sequential lineIndex per line (mirrors
// ocrEngine.js's flattenRegions - each block/line already comes back in
// ML Kit's own reading order, no re-sorting needed).
function flattenBlocks(blocks) {
  const words = [];
  let lineIndex = -1;
  (blocks || []).forEach((block) => {
    (block.lines || []).forEach((line) => {
      const lineWords = (line.elements || [])
        .map((el) => {
          const text = (el.text || "").trim();
          if (!text) return null;
          const box = el.boundingBox;
          return {
            text,
            confidence: NO_CONFIDENCE_SIGNAL,
            bbox: { x0: box.left, y0: box.top, x1: box.right, y1: box.bottom },
          };
        })
        .filter(Boolean);
      if (!lineWords.length) return;
      lineIndex++;
      lineWords.forEach((w) => words.push({ lineIndex, ...w }));
    });
  });
  return words;
}

// Same signature/return shape as ocrEngine.js's recognizeImage, so
// js/recognize.js can dispatch to either with no caller-visible difference.
export async function recognizeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  const { Filesystem, TextRecognition } = window.Capacitor.Plugins;

  if (onProgress) onProgress({ status: "loading image", progress: 0.1 });
  const blob = await (await fetch(previewImg.src)).blob();
  const base64 = await blobToBase64(blob);

  if (onProgress) onProgress({ status: "writing to device", progress: 0.3 });
  const { uri } = await Filesystem.writeFile({
    path: CACHE_FILE_PATH,
    data: base64,
    directory: "CACHE",
  });

  try {
    if (onProgress) onProgress({ status: "recognizing text", progress: 0.5 });
    const result = await TextRecognition.processImage({ path: uri, script: "LATIN" });

    try {
      await recordScan({
        label: state.currentFile?.name || "unknown",
        naturalWidth,
        naturalHeight,
        rawResult: result,
        imageByteLength: blob.size,
      });
    } catch {
      // Diagnostics must never be able to fail a scan that otherwise worked.
    }

    if (onProgress) onProgress({ status: "done", progress: 1 });
    return {
      words: flattenBlocks(result.blocks),
      text: (result.text || "").trim(),
      preprocessed: false,
    };
  } finally {
    try {
      await Filesystem.deleteFile({ path: CACHE_FILE_PATH, directory: "CACHE" });
    } catch {
      // Best-effort cleanup of the temp scan file - a leftover cache file
      // isn't worth failing the whole scan over.
    }
  }
}
