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
// UNVERIFIED (no iOS device run has happened yet as of this writing - the
// project synced/built the Xcode workspace successfully, but nobody has
// pressed Run): whether processImage's `path` option accepts the file://
// URI Filesystem.writeFile returns as-is, or needs the scheme stripped
// first. If recognition fails with a "file not found"-shaped error on a
// real device, try stripping the `file://` prefix from `uri` first.
//
// KNOWN LIMITATION, intentionally not fixed in this pass: `script` is
// hardcoded to Latin. ML Kit needs a separate bundled model per script
// (Latin/Chinese/Devanagari/Japanese/Korean) with no universal/auto-detect
// option - fine for the English-text validation images, a real gap for
// non-Latin text to revisit once the core approach is validated.

const CACHE_FILE_PATH = "textscanner-scan-input.jpg";
// ML Kit gives no per-word confidence score at all (unlike Tesseract). Every
// word gets this fixed placeholder rather than a fabricated real-looking
// number - state.js's LOW_CONFIDENCE_THRESHOLD is well below it, so the
// low-confidence-underline UI simply never flags an ML Kit word, which is
// honest: there's nothing real to flag it with.
const PLACEHOLDER_CONFIDENCE = 100;

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
            confidence: PLACEHOLDER_CONFIDENCE,
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
