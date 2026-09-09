// mlkitEngine.js: native recognition path via Capacitor + Google ML Kit Text
// Recognition v2 (iOS - the only native platform this project targets; see
// js/recognize.js for the web/Tesseract.js fallback used everywhere else).
// Writes the current image to native cache storage (ML Kit's processImage
// needs a real filesystem path, not a Blob/canvas), runs recognition, and
// normalizes ML Kit's block/line/element hierarchy into the same flat
// { lineIndex, text, confidence, bbox } word list js/ocrEngine.js produces,
// so the editor modules/filter.js/main.js need no changes regardless of which engine
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


const CACHE_FILE_PATH = "textscanner-scan-input.jpg";
// Re-encode quality for the upright JPEG handed to ML Kit (see
// encodeUprightJpeg). High enough that the re-encode is not a second
// generation of visible compression damage on text edges - which is what the
// recognizer actually reads - while keeping the cache write small.
const CACHE_JPEG_QUALITY = 0.92;
// Below this many degrees of baseline tilt, a word is treated as axis-aligned
// and rendered exactly as it always was. ML Kit reports a fraction of a degree
// of tilt on plenty of genuinely straight text (its corner points come from a
// fitted quad, not from an exact grid), and rotating a span by 0.3 degrees
// buys nothing while making every word's transform non-identity.
const MIN_MEANINGFUL_ROTATION_DEG = 0.75;
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
// null instead says what's true. editorObjects.js already guards its low-confidence
// styling on `confidence != null`, and filter.js's confidence check is
// typeof-guarded, so neither fabricates anything from a missing score. The gap
// is then stated outright in the UI - see engineProvidesConfidence() in
// js/recognize.js and the note it drives in js/main.js.
const NO_CONFIDENCE_SIGNAL = null;

// Re-encodes the already-decoded preview image as an upright JPEG with no EXIF
// metadata, and that is a correctness fix rather than a convenience.
//
// This used to send ML Kit the raw original file bytes. Those bytes carry the
// camera's EXIF orientation tag, and the two sides of the pipeline resolve that
// tag in different places:
//
//   - The web side never sees it. previewImg is a real <img>, and every engine
//     since Safari 13.1 / Chromium 81 decodes an <img> pre-rotated per its EXIF
//     tag, so naturalWidth/naturalHeight are already the corrected, possibly
//     dimension-swapped size. That is the space renderImageFormatView renders
//     into (see test/exif-orientation.js, which asserts exactly this invariant
//     across all 8 orientation values).
//   - The native side sees it and resolves it as metadata, not pixels. The
//     plugin's createVisionImageFromFilePath does
//     `UIImage(contentsOfFile:)` then `visionImage.orientation =
//     image.imageOrientation` (TextRecognition.swift). UIImage does NOT rotate
//     the pixel buffer on load: for a portrait photo tagged orientation 6 the
//     backing CGImage stays landscape and the rotation lives only in
//     imageOrientation.
//
// So the coordinate space ML Kit reports into is a function of how ML Kit
// chooses to reconcile a rotated buffer with an orientation flag - an internal
// detail of a third-party SDK that this app cannot pin down and must not
// depend on. Drawing through a canvas resolves the tag into the pixels
// themselves: the exported JPEG is upright, carries no orientation tag for
// UIImage to find, and its dimensions are naturalWidth x naturalHeight exactly.
// Both spaces then coincide by construction rather than by coincidence.
function encodeUprightJpeg(previewImg, naturalWidth, naturalHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(previewImg, 0, 0, naturalWidth, naturalHeight);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode the image for recognition."))),
      "image/jpeg",
      CACHE_JPEG_QUALITY
    );
  });
}

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

// ML Kit reports each element's geometry twice: `boundingBox`, the axis-aligned
// rectangle, and `cornerPoints`, the four-point quad following the text's actual
// baseline (top-left first, then clockwise). For level text the two agree. For
// tilted text they diverge badly, and the divergence is what this function
// exists to preserve - see quadGeometry below for why it matters.
//
// Returns null unless the quad is complete and finite, so a malformed or absent
// cornerPoints array falls back to boundingBox rather than producing NaN
// coordinates that would place a word nowhere at all.
function normalizeQuad(cornerPoints) {
  if (!Array.isArray(cornerPoints) || cornerPoints.length !== 4) return null;
  const points = cornerPoints.map((p) => ({ x: Number(p?.x), y: Number(p?.y) }));
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return points;
}

// The word's own frame, read off the quad: where its top-left corner actually
// sits, how long its baseline actually is, how tall its glyphs actually are,
// and how far it is tilted.
//
// This is the fix for the positioning bug. Rendering used to derive both the
// word's position and its font size from the axis-aligned `boundingBox`, and
// for tilted text that box is the *envelope* of the rotated word, not the word:
// its height is h*cos(t) + w*sin(t). A 400x60 word tilted 10 degrees has an
// envelope 129px tall, so the span rendered at 2.1x the correct font size,
// anchored at a top-left corner well above and left of where the word starts.
// Long words inflate worst, neighbouring words then overlap, and the result is
// the "gibberish" reported on-device - on exactly the images whose text is
// tilted (the angled posters), while flat-on screenshots looked "really good".
// test/unit/mlkit-geometry.test.js pins the arithmetic; the derivation of the
// inflation factor is asserted there directly rather than described.
export function quadGeometry(quad) {
  const [topLeft, topRight, , bottomLeft] = quad;
  const baselineX = topRight.x - topLeft.x;
  const baselineY = topRight.y - topLeft.y;
  const sideX = bottomLeft.x - topLeft.x;
  const sideY = bottomLeft.y - topLeft.y;
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.hypot(baselineX, baselineY),
    height: Math.hypot(sideX, sideY),
    rotationDeg: (Math.atan2(baselineY, baselineX) * 180) / Math.PI,
  };
}

function envelopeOfQuad(quad) {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function envelopeOfBoundingBox(box) {
  if (!box) return null;
  const x0 = Number(box.left);
  const y0 = Number(box.top);
  const x1 = Number(box.right);
  const y1 = Number(box.bottom);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  // ML Kit is documented to report left <= right and top <= bottom, but a
  // normalized box costs one comparison and means a downstream width is never
  // negative even if that ever stops holding.
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

// Walks ML Kit's block -> line -> element hierarchy into a flat word list,
// assigning a fresh sequential lineIndex per line (mirrors
// ocrEngine.js's flattenRegions - each block/line already comes back in
// ML Kit's own reading order, no re-sorting needed).
//
// Each word carries `bbox`, the axis-aligned envelope every existing consumer
// already understands (js/filter.js, js/editorExport.js, the editor's own
// move/resize maths), and additionally `quad`/`rotationDeg`/`frame` when ML Kit
// supplied usable corner points. Consumers that only understand rectangles are
// unaffected; renderImageFormatView uses the frame when it is there and falls
// back to the envelope when it is not, which is also what happens on the
// Tesseract path, where there are no corner points at all.
//
// Exported for test/unit/mlkit-geometry.test.js. The justification is the same
// one already written into ocrEngine.js for transformBboxCorners: this is
// coordinate maths that silently misplaces every word on screen when it is
// wrong, and it has no DOM dependency, so it is worth testing in isolation
// rather than only through a full device scan.
export function flattenBlocks(blocks) {
  const words = [];
  let lineIndex = -1;
  (blocks || []).forEach((block) => {
    (block.lines || []).forEach((line) => {
      const lineWords = [];
      (line.elements || []).forEach((el) => {
        const text = (el.text || "").trim();
        if (!text) return;

        const quad = normalizeQuad(el.cornerPoints);
        const bbox = quad ? envelopeOfQuad(quad) : envelopeOfBoundingBox(el.boundingBox);
        // No usable geometry from either source: there is nowhere to put this
        // word, and inventing a position would be worse than dropping it.
        if (!bbox) return;

        const word = { text, confidence: NO_CONFIDENCE_SIGNAL, bbox };

        if (quad) {
          const frame = quadGeometry(quad);
          // A degenerate quad (a zero-area element, which ML Kit does
          // occasionally emit) has no meaningful baseline direction - atan2 of
          // 0,0 is 0, but the width/height are useless. Keep the envelope.
          if (frame.width > 0 && frame.height > 0) {
            word.quad = quad;
            word.frame = frame;
            word.rotationDeg = Math.abs(frame.rotationDeg) >= MIN_MEANINGFUL_ROTATION_DEG ? frame.rotationDeg : 0;
          }
        }

        lineWords.push(word);
      });
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
  const blob = await encodeUprightJpeg(previewImg, naturalWidth, naturalHeight);
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
