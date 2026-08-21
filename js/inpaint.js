// inpaint.js: fills a deleted/modified word's original spot with a plausible
// continuation of the surrounding image, instead of a flat sampled color.
//
// This was originally planned around OpenCV.js's cv.inpaint(), per the project's
// OpenCV history. But Phase 1's testing found that loading OpenCV.js's WASM
// runtime from inside a real click handler in this app reproducibly froze the
// tab's main thread for extremely long periods (see js/preprocess.js and the
// Phase 1 commit for the full story) - an unacceptable risk to reintroduce here.
// Instead, this implements diffusion-based inpainting directly: the region to fill
// is treated as an unknown interior with the surrounding pixels as a fixed
// boundary, and Gauss-Seidel relaxation solves for smooth values in between (i.e.
// harmonic/Laplace inpainting). It's simpler than OpenCV's Telea/Navier-Stokes
// methods, but for the small, bounded regions this app fills (one word's bounding
// box at a time, not whole-image editing), it produces a smooth, texture-
// continuing result that reads as part of the background rather than a smudge -
// and it's plain, fast, dependency-free JS with no WASM/freeze risk.

const ITERATIONS = 300;

// How far past the tight word bbox to sample "known" pixels from, so the
// diffusion has real surrounding context to work from rather than just its own
// initial guess. Scales with the region's size, clamped to a sane range.
function computeMargin(width, height) {
  return Math.max(8, Math.min(40, Math.round(Math.min(width, height) * 0.75)));
}

// Gauss-Seidel relaxation: repeatedly replace each masked pixel with the average
// of its 4-neighbors (which may be fixed boundary pixels or other masked pixels
// converging alongside it), per color channel. Converges to a smooth ("harmonic")
// fill consistent with the surrounding boundary.
function diffuseFill(data, width, height, mx0, my0, mx1, my1) {
  // Seed the masked region with the average boundary color first, both so there's
  // a reasonable starting point and so the loop below never reads leftover
  // original (e.g. text) pixels as if they were legitimate boundary data.
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  const addIfInBounds = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    count++;
  };
  for (let x = mx0; x < mx1; x++) {
    addIfInBounds(x, my0 - 1);
    addIfInBounds(x, my1);
  }
  for (let y = my0; y < my1; y++) {
    addIfInBounds(mx0 - 1, y);
    addIfInBounds(mx1, y);
  }
  const avgR = count ? rSum / count : 200;
  const avgG = count ? gSum / count : 200;
  const avgB = count ? bSum / count : 200;
  for (let y = my0; y < my1; y++) {
    for (let x = mx0; x < mx1; x++) {
      const i = (y * width + x) * 4;
      data[i] = avgR;
      data[i + 1] = avgG;
      data[i + 2] = avgB;
    }
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let y = my0; y < my1; y++) {
      const rowAbove = (y - 1) * width;
      const row = y * width;
      const rowBelow = (y + 1) * width;
      for (let x = mx0; x < mx1; x++) {
        const iUp = (rowAbove + x) * 4;
        const iDown = (rowBelow + x) * 4;
        const iLeft = (row + x - 1) * 4;
        const iRight = (row + x + 1) * 4;
        const i = (row + x) * 4;
        data[i] = (data[iUp] + data[iDown] + data[iLeft] + data[iRight]) / 4;
        data[i + 1] = (data[iUp + 1] + data[iDown + 1] + data[iLeft + 1] + data[iRight + 1]) / 4;
        data[i + 2] = (data[iUp + 2] + data[iDown + 2] + data[iLeft + 2] + data[iRight + 2]) / 4;
      }
    }
  }
}

// Given the source image and a word's tight bbox (in the image's natural pixel
// coordinates), returns a small canvas the same size as the bbox, containing an
// inpainted fill for that region - or null if the bbox is degenerate.
export function computeInpaintedPatch(previewImg, naturalWidth, naturalHeight, bbox) {
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  if (bw <= 0 || bh <= 0) return null;

  const margin = computeMargin(bw, bh);
  const px0 = Math.max(0, Math.floor(bbox.x0) - margin);
  const py0 = Math.max(0, Math.floor(bbox.y0) - margin);
  const px1 = Math.min(naturalWidth, Math.ceil(bbox.x1) + margin);
  const py1 = Math.min(naturalHeight, Math.ceil(bbox.y1) + margin);
  const pw = px1 - px0;
  const ph = py1 - py0;
  if (pw <= 0 || ph <= 0) return null;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = pw;
  cropCanvas.height = ph;
  const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
  try {
    cropCtx.drawImage(previewImg, px0, py0, pw, ph, 0, 0, pw, ph);
  } catch {
    return null;
  }

  const imageData = cropCtx.getImageData(0, 0, pw, ph);
  const maskX0 = Math.max(0, Math.round(bbox.x0 - px0));
  const maskY0 = Math.max(0, Math.round(bbox.y0 - py0));
  const maskX1 = Math.min(pw, Math.round(bbox.x1 - px0));
  const maskY1 = Math.min(ph, Math.round(bbox.y1 - py0));
  if (maskX1 <= maskX0 || maskY1 <= maskY0) return null;

  diffuseFill(imageData.data, pw, ph, maskX0, maskY0, maskX1, maskY1);
  cropCtx.putImageData(imageData, 0, 0);

  const patchCanvas = document.createElement("canvas");
  patchCanvas.width = maskX1 - maskX0;
  patchCanvas.height = maskY1 - maskY0;
  patchCanvas
    .getContext("2d")
    .drawImage(cropCanvas, maskX0, maskY0, patchCanvas.width, patchCanvas.height, 0, 0, patchCanvas.width, patchCanvas.height);
  return patchCanvas;
}
