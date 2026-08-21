// ocrEngine.js: runs Tesseract.js and normalizes its result into the flat
// { lineIndex, text, confidence, bbox } word list the rest of the app works with.
// Uses the createWorker API (rather than the one-shot Tesseract.recognize()
// convenience call) because that's the only way to control page segmentation mode.
//
// Testing against real-world images (screenshots, designed flyers, UI mockups)
// showed that Phase 1's contrast-normalization preprocessing (preprocess.js) is a
// clear win on genuinely uneven-lit/low-contrast photos, but a clear LOSS on
// already-clean images (flat screenshots, evenly-lit graphics) - it has nothing to
// correct there and only adds blur/amplification artifacts. So rather than always
// trust preprocessing, this module runs the raw image first, only tries the
// preprocessed version when the raw pass leaves real room for improvement, and
// keeps whichever candidate actually scored higher. That guarantees preprocessing
// can only help, never hurt, at the cost of a second pass on harder images.
//
// Deskewing is delegated to Tesseract's own `rotateAuto` option (Leptonica-backed,
// well tested) rather than a hand-rolled estimate. Tesseract reports the angle it
// corrected for as data.rotateRadians, which this module inverts to map returned
// word boxes back onto the original, on-screen image.

import { preprocessImage } from "./preprocess.js";

// Tesseract.js's PSM constants (see naptha/tesseract.js src/constants/PSM.js) are
// exposed as Tesseract.PSM at runtime; this mirrors that file in case a future CDN
// build ever omits the export, so a missing global degrades gracefully instead of
// throwing before OCR can even start.
const FALLBACK_PSM = { AUTO: "3", SPARSE_TEXT: "11" };

// Below this mean confidence, the raw pass is considered to have real room for
// improvement, and preprocessing is worth trying as a second candidate.
const PREPROCESS_WORTH_TRYING_THRESHOLD = 70;
// Below this mean confidence (or with zero words), the best candidate so far is
// still bad enough to justify a bounded PSM.SPARSE_TEXT retry - well suited to
// scattered text on busy backgrounds (signs, flyers) where AUTO's block-based
// segmentation struggles.
const RETRY_MEAN_CONFIDENCE_THRESHOLD = 40;

function meanOf(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function rotatePoint(x, y, cx, cy, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Builds a function mapping a bbox in the recognized (rotated, possibly upscaled)
// image's pixel space back to the original image's pixel space: undo Tesseract's
// auto-rotation (around the image center) first, then undo any upscale.
function buildBboxMapper(imgWidth, imgHeight, rotateRadians, scaleFactor) {
  const cx = imgWidth / 2;
  const cy = imgHeight / 2;
  const angle = -(rotateRadians || 0);
  const inv = 1 / scaleFactor;

  return ({ x0, y0, x1, y1 }) => {
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => rotatePoint(x, y, cx, cy, angle));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    return {
      x0: Math.min(...xs) * inv,
      y0: Math.min(...ys) * inv,
      x1: Math.max(...xs) * inv,
      y1: Math.max(...ys) * inv,
    };
  };
}

function extractWords(data, mapBoxToOriginal) {
  const words = [];
  if (!Array.isArray(data.lines)) return words;
  data.lines.forEach((line, lineIndex) => {
    if (!Array.isArray(line.words)) return;
    line.words.forEach((word) => {
      const text = (word.text || "").trim();
      if (!text) return;
      words.push({
        lineIndex,
        text,
        confidence: typeof word.confidence === "number" ? word.confidence : 0,
        bbox: mapBoxToOriginal(word.bbox),
      });
    });
  });
  return words;
}

// Runs the full Phase 1 pipeline -> { words, text, preprocessed }. `onProgress`
// receives Tesseract's raw logger messages ({status, progress}); this module stays
// UI-agnostic and leaves rendering the progress bar to the caller.
export async function recognizeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  const PSM = (window.Tesseract && window.Tesseract.PSM) || FALLBACK_PSM;
  const worker = await window.Tesseract.createWorker("eng", 1, { logger: onProgress });

  const runPass = async (source, width, height, psm, preprocessed) => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const result = await worker.recognize(source, { rotateAuto: true }, { text: true, blocks: true });
    const mapBoxToOriginal = buildBboxMapper(width, height, result.data.rotateRadians, width / naturalWidth);
    const words = extractWords(result.data, mapBoxToOriginal);
    return {
      words,
      text: (result.data.text || "").trim(),
      meanConfidence: meanOf(words.map((w) => w.confidence)),
      source,
      width,
      height,
      preprocessed,
    };
  };

  try {
    let best = await runPass(previewImg, naturalWidth, naturalHeight, PSM.AUTO, false);

    if (best.meanConfidence < PREPROCESS_WORTH_TRYING_THRESHOLD) {
      const { canvas } = await preprocessImage(previewImg, naturalWidth, naturalHeight);
      const preResult = await runPass(canvas, canvas.width, canvas.height, PSM.AUTO, true);
      if (preResult.meanConfidence > best.meanConfidence) best = preResult;
    }

    if (best.words.length === 0 || best.meanConfidence < RETRY_MEAN_CONFIDENCE_THRESHOLD) {
      const retry = await runPass(best.source, best.width, best.height, PSM.SPARSE_TEXT, best.preprocessed);
      if (retry.words.length && retry.meanConfidence > best.meanConfidence) best = retry;
    }

    return { words: best.words, text: best.text, preprocessed: best.preprocessed };
  } finally {
    await worker.terminate();
  }
}
