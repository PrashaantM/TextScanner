// preprocess.js: prepares an image (or a cropped region of one) for OCR before
// Tesseract ever sees it - grayscale, local contrast normalization
// (background-subtraction, which handles uneven lighting/low contrast far better
// than a single global adjustment), upscaling for small text, and an
// edge-based binarization alternative for textured/gradient backgrounds where
// background-subtraction alone doesn't fully flatten illumination. All of it is
// plain Canvas 2D / pixel-array work, no OpenCV.js: loading OpenCV.js's WASM
// runtime from inside a real click-handler was found, during testing, to
// reproducibly freeze the tab's main thread for extremely long periods
// (confirmed with a heartbeat timer that stopped firing entirely), even though
// the identical script loads in about a second in isolation. That's an
// unacceptable risk for a step every scan goes through, so this module avoids
// OpenCV.js entirely - the original spec explicitly allows either approach here.
// (OpenCV.js is still used, much more narrowly, for Phase 2's inpainting.)
//
// Only the upscale step changes geometry; its scale factor is returned so
// callers can map returned word bboxes back into the source's pixel space.
// Grayscale/contrast normalization/edge-binarization are pixel-value-only and
// need no coordinate correction.

const UPSCALE_TARGET_MIN_DIMENSION = 1000;
const MAX_UPSCALE_FACTOR = 2;
// Region crops are typically much smaller than a whole photo (a poster's fine
// print might be 80px tall), so they're allowed to upscale further than a
// whole-image pass would - there's far less pixel data to blow up relative to
// the payoff of making small/fine-print text legible to Tesseract.
const REGION_UPSCALE_TARGET_MIN_DIMENSION = 200;
const REGION_MAX_UPSCALE_FACTOR = 4;
// How much of the local background estimate to divide out. Higher = more aggressive
// flattening of lighting gradients; 1 fully removes local brightness variation.
const CONTRAST_GAIN = 1.6;
// The local-background estimate is built by downscaling the grayscale image to
// roughly this many pixels on its longer side, then scaling back up - canvas's
// built-in bilinear scaling acts as a cheap, fast box blur, avoiding a hand-rolled
// per-pixel blur loop.
const BACKGROUND_DOWNSCALE_TARGET = 48;
// A region's own local-background estimate is built at a finer relative scale
// than a whole image would be, since a region is already a small crop - too
// coarse a downscale on a small crop blurs away the very edge it needs to find.
const REGION_BACKGROUND_DOWNSCALE_TARGET = 16;
// Above this variance (0-255 gray-level std-dev of the background estimate), a
// region's background is considered textured/patterned/gradient rather than
// flat, and worth also trying edge-based binarization for.
const HIGH_BACKGROUND_VARIANCE_THRESHOLD = 18;

function drawToCanvas(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function toGrayscaleCanvas(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const srcData = sourceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const grayCanvas = document.createElement("canvas");
  grayCanvas.width = width;
  grayCanvas.height = height;
  const grayCtx = grayCanvas.getContext("2d", { willReadFrequently: true });
  const grayImageData = grayCtx.createImageData(width, height);
  const grayData = grayImageData.data;
  for (let i = 0; i < srcData.length; i += 4) {
    const g = 0.299 * srcData[i] + 0.587 * srcData[i + 1] + 0.114 * srcData[i + 2];
    grayData[i] = g;
    grayData[i + 1] = g;
    grayData[i + 2] = g;
    grayData[i + 3] = 255;
  }
  grayCtx.putImageData(grayImageData, 0, 0);
  return grayCanvas;
}

// Builds a smoothed "local background" grayscale canvas the same size as the
// input, by shrinking it way down (which blends away text-sized detail, leaving
// only broad lighting/background variation) and scaling it back up.
function buildLocalBackground(grayCanvas, downscaleTarget) {
  const { width, height } = grayCanvas;
  const scale = downscaleTarget / Math.max(width, height);
  const smallW = Math.max(1, Math.round(width * scale));
  const smallH = Math.max(1, Math.round(height * scale));

  const small = document.createElement("canvas");
  small.width = smallW;
  small.height = smallH;
  small.getContext("2d").drawImage(grayCanvas, 0, 0, smallW, smallH);

  const bg = document.createElement("canvas");
  bg.width = width;
  bg.height = height;
  const bgCtx = bg.getContext("2d");
  bgCtx.imageSmoothingEnabled = true;
  bgCtx.imageSmoothingQuality = "high";
  bgCtx.drawImage(small, 0, 0, width, height);
  return bg;
}

function stdDev(data) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i];
    count++;
  }
  const mean = sum / count;
  let variance = 0;
  for (let i = 0; i < data.length; i += 4) {
    variance += (data[i] - mean) ** 2;
  }
  return Math.sqrt(variance / count);
}

// Grayscale + local-background-subtraction contrast normalization. Returns the
// normalized canvas plus how much the background estimate itself varies
// (background-flat vs. textured/gradient), which callers use to decide whether
// edge-based binarization is also worth trying.
function normalizeContrast(sourceCanvas, backgroundDownscaleTarget) {
  const { width, height } = sourceCanvas;
  const grayCanvas = toGrayscaleCanvas(sourceCanvas);
  const grayData = grayCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;

  const backgroundCanvas = buildLocalBackground(grayCanvas, backgroundDownscaleTarget);
  const backgroundData = backgroundCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext("2d");
  const outImageData = outCtx.createImageData(width, height);
  const outData = outImageData.data;
  for (let i = 0; i < grayData.length; i += 4) {
    const normalized = 128 + (grayData[i] - backgroundData[i]) * CONTRAST_GAIN;
    const v = normalized < 0 ? 0 : normalized > 255 ? 255 : normalized;
    outData[i] = v;
    outData[i + 1] = v;
    outData[i + 2] = v;
    outData[i + 3] = 255;
  }
  outCtx.putImageData(outImageData, 0, 0);

  return { canvas: outCanvas, backgroundVariance: stdDev(backgroundData) };
}

// Sobel-magnitude edge binarization: finds text strokes by their edges rather
// than by contrast against a flattened background, which holds up better than
// background-subtraction on genuinely textured/patterned surfaces (wood grain,
// fabric, busy photo backgrounds) where there's no single "background" to
// subtract - text-over-image and text-over-gradient cases specifically.
function edgeBinarize(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const grayCanvas = toGrayscaleCanvas(sourceCanvas);
  const grayData = grayCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;

  const at = (x, y) => grayData[(Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4];

  const magnitude = new Float32Array(width * height);
  let maxMag = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const mag = Math.sqrt(gx * gx + gy * gy);
      magnitude[y * width + x] = mag;
      if (mag > maxMag) maxMag = mag;
    }
  }

  // Fixed-fraction-of-max threshold rather than a full Otsu histogram search -
  // cheap, and good enough since this only needs to separate "strong edge"
  // (text stroke boundary) from "weak/no edge" (background texture noise), not
  // produce a perfectly tuned bilevel image.
  const threshold = maxMag * 0.18;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext("2d");
  const outImageData = outCtx.createImageData(width, height);
  const outData = outImageData.data;
  for (let i = 0; i < magnitude.length; i++) {
    // Text strokes render as dark-on-light for Tesseract regardless of the
    // original polarity, since this is a binary edge mask, not a polarity-
    // preserving normalization.
    const v = magnitude[i] > threshold ? 0 : 255;
    const o = i * 4;
    outData[o] = v;
    outData[o + 1] = v;
    outData[o + 2] = v;
    outData[o + 3] = 255;
  }
  outCtx.putImageData(outImageData, 0, 0);
  return outCanvas;
}

function computeUpscale(width, height, targetMinDimension, maxFactor) {
  const shorterSide = Math.min(width, height);
  return shorterSide < targetMinDimension ? Math.min(maxFactor, targetMinDimension / shorterSide) : 1;
}

// Returns { canvas, scaleFactor, preprocessed }. `canvas` is what should be fed to
// Tesseract; `scaleFactor` is how much larger canvas is than the original image (1
// if not upscaled), needed to map returned bboxes back to original coordinates.
export async function preprocessImage(previewImg, naturalWidth, naturalHeight) {
  if (!naturalWidth || !naturalHeight) {
    return { canvas: drawToCanvas(previewImg, naturalWidth || 1, naturalHeight || 1), scaleFactor: 1, preprocessed: false };
  }

  try {
    const scaleFactor = computeUpscale(naturalWidth, naturalHeight, UPSCALE_TARGET_MIN_DIMENSION, MAX_UPSCALE_FACTOR);
    const width = Math.round(naturalWidth * scaleFactor);
    const height = Math.round(naturalHeight * scaleFactor);
    const scaledCanvas = drawToCanvas(previewImg, width, height);
    const { canvas } = normalizeContrast(scaledCanvas, BACKGROUND_DOWNSCALE_TARGET);
    return { canvas, scaleFactor, preprocessed: true };
  } catch {
    // Never let a preprocessing bug block a scan: fall back to the untouched image.
    return { canvas: drawToCanvas(previewImg, naturalWidth, naturalHeight), scaleFactor: 1, preprocessed: false };
  }
}

// Region variant of preprocessImage: takes an already-cropped canvas (one
// text-block region from the layout pass) and returns a list of candidate
// canvases to try recognition against, each tagged with a `kind` and the
// `scaleFactor` needed to map bboxes back to the crop's own coordinate space
// (the caller then composes that with the crop's offset in the original image).
// Always includes the contrast-normalized candidate; adds the edge-binarized
// candidate only when the region's background reads as textured/gradient
// rather than flat, since edge-binarization is a worse choice than
// background-subtraction on a plain background and there's no reason to spend
// a second recognize() pass trying it there.
// Whether the region pass also tries the crop UNTOUCHED (upscaled only, no
// contrast normalization). The whole-image pass has always worked this way -
// recognize the raw image first, only try preprocessing if there's room to
// improve, keep whichever scored higher - on the finding that contrast
// normalization is a clear loss on already-clean content. The region pass never
// inherited that rule: every region got normalized whether it needed it or not,
// with no untouched candidate to lose to.
//
// OFF, because it was measured rather than assumed - and the measurement did
// not support turning it on. Across two full sweeps of the benchmark corpus
// (test/tune-thresholds.js), enabling it moved CER on the eight
// complete-ground-truth images by 0.1 points and WER by 0.2 - smaller than the
// run-to-run variation between two runs of the identical code, which was itself
// about 0.2 WER. It helped one image (complexPic3) and hurt another
// (complexPic6) by similar small amounts, and it costs an extra recognize()
// call on every weak region.
//
// Kept as a switch rather than deleted because the corpus, not the idea, is what
// is inconclusive here: eight scoring images cannot resolve a difference this
// size. With the corpus grown (see test/images/README.md), flip this to true and
// re-run the sweep - it is already a variant there.
//
// The idea itself is sound: the whole-image pass has always recognized the RAW
// image first and only kept preprocessing when it scored better, on the finding
// that contrast normalization is a clear loss on already-clean content. The
// region pass never inherited that rule - every region gets normalized whether
// it needs it or not, with no untouched candidate to lose to.
const REGION_INCLUDE_RAW_CANDIDATE = false;

export function preprocessRegion(cropCanvas) {
  const { width, height } = cropCanvas;
  if (!width || !height) return [];

  try {
    const scaleFactor = computeUpscale(width, height, REGION_UPSCALE_TARGET_MIN_DIMENSION, REGION_MAX_UPSCALE_FACTOR);
    const upW = Math.round(width * scaleFactor);
    const upH = Math.round(height * scaleFactor);
    const upscaledCanvas = scaleFactor === 1 ? cropCanvas : drawToCanvas(cropCanvas, upW, upH);

    const { canvas: contrastCanvas, backgroundVariance } = normalizeContrast(upscaledCanvas, REGION_BACKGROUND_DOWNSCALE_TARGET);
    const candidates = [{ canvas: contrastCanvas, scaleFactor, kind: "contrast" }];

    if (REGION_INCLUDE_RAW_CANDIDATE) {
      candidates.push({ canvas: upscaledCanvas, scaleFactor, kind: "raw" });
    }

    if (backgroundVariance > HIGH_BACKGROUND_VARIANCE_THRESHOLD) {
      candidates.push({ canvas: edgeBinarize(upscaledCanvas), scaleFactor, kind: "edge" });
    }

    return candidates;
  } catch {
    return [];
  }
}
