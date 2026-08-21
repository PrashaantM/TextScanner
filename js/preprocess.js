// preprocess.js: prepares an image for OCR before Tesseract ever sees it -
// grayscale, local contrast normalization (background-subtraction, which handles
// uneven lighting/low contrast far better than a single global adjustment), and
// upscaling small images. All of it is plain Canvas 2D / pixel-array work, no
// OpenCV.js: loading OpenCV.js's WASM runtime from inside a real click-handler was
// found, during testing, to reproducibly freeze the tab's main thread for extremely
// long periods (confirmed with a heartbeat timer that stopped firing entirely),
// even though the identical script loads in about a second in isolation. That's an
// unacceptable risk for a step every scan goes through, so this module avoids
// OpenCV.js entirely - the original spec explicitly allows either approach here.
// (OpenCV.js is still used, much more narrowly, for Phase 2's inpainting.)
//
// Only the upscale step changes geometry; its scale factor is returned so
// ocrEngine.js can map returned word bboxes back into the original image's pixel
// space. Grayscale/contrast normalization are pixel-value-only and need no
// coordinate correction.

const UPSCALE_TARGET_MIN_DIMENSION = 1000;
const MAX_UPSCALE_FACTOR = 2;
// How much of the local background estimate to divide out. Higher = more aggressive
// flattening of lighting gradients; 1 fully removes local brightness variation.
const CONTRAST_GAIN = 1.6;
// The local-background estimate is built by downscaling the grayscale image to
// roughly this many pixels on its longer side, then scaling back up - canvas's
// built-in bilinear scaling acts as a cheap, fast box blur, avoiding a hand-rolled
// per-pixel blur loop.
const BACKGROUND_DOWNSCALE_TARGET = 48;

function drawToCanvas(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

// Builds a smoothed "local background" grayscale canvas the same size as the
// input, by shrinking it way down (which blends away text-sized detail, leaving
// only broad lighting/background variation) and scaling it back up.
function buildLocalBackground(grayCanvas) {
  const { width, height } = grayCanvas;
  const scale = BACKGROUND_DOWNSCALE_TARGET / Math.max(width, height);
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

// Returns { canvas, scaleFactor, preprocessed }. `canvas` is what should be fed to
// Tesseract; `scaleFactor` is how much larger canvas is than the original image (1
// if not upscaled), needed to map returned bboxes back to original coordinates.
export async function preprocessImage(previewImg, naturalWidth, naturalHeight) {
  if (!naturalWidth || !naturalHeight) {
    return { canvas: drawToCanvas(previewImg, naturalWidth || 1, naturalHeight || 1), scaleFactor: 1, preprocessed: false };
  }

  try {
    const shorterSide = Math.min(naturalWidth, naturalHeight);
    const scaleFactor = shorterSide < UPSCALE_TARGET_MIN_DIMENSION
      ? Math.min(MAX_UPSCALE_FACTOR, UPSCALE_TARGET_MIN_DIMENSION / shorterSide)
      : 1;
    const width = Math.round(naturalWidth * scaleFactor);
    const height = Math.round(naturalHeight * scaleFactor);

    const scaledCanvas = drawToCanvas(previewImg, width, height);
    const ctx = scaledCanvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;

    // Grayscale in place, written into a same-size canvas so buildLocalBackground
    // can reuse ordinary canvas scaling on it.
    const grayCanvas = document.createElement("canvas");
    grayCanvas.width = width;
    grayCanvas.height = height;
    const grayCtx = grayCanvas.getContext("2d", { willReadFrequently: true });
    const grayImageData = grayCtx.createImageData(width, height);
    const grayData = grayImageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      grayData[i] = g;
      grayData[i + 1] = g;
      grayData[i + 2] = g;
      grayData[i + 3] = 255;
    }
    grayCtx.putImageData(grayImageData, 0, 0);

    const backgroundCanvas = buildLocalBackground(grayCanvas);
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

    return { canvas: outCanvas, scaleFactor, preprocessed: true };
  } catch {
    // Never let a preprocessing bug block a scan: fall back to the untouched image.
    return { canvas: drawToCanvas(previewImg, naturalWidth, naturalHeight), scaleFactor: 1, preprocessed: false };
  }
}
