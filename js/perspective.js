// perspective.js: keystone correction for photographed text - not full
// arbitrary-angle document-edge detection (finding a physical page/sign's
// corners in a cluttered photo is a hard CV problem, fragile to hand-roll
// without OpenCV.js, which this codebase deliberately avoids - see
// js/preprocess.js's header comment for why). Instead, this detects keystone
// distortion from the text's OWN line geometry within a region - photographed
// text on a tilted plane produces lines whose height or horizontal position
// trends consistently across the region - and corrects just that, which
// handles the common "photographed at a shallow angle" case without needing a
// general document detector. When the signal isn't clear and consistent, this
// intentionally does nothing rather than guess: a forced warp on straight text
// would actively hurt recognition, and this pipeline's rule throughout is that
// every step can only help, never hurt.

// A trend has to explain most of the variation across lines (not just exist)
// before it's trusted enough to warp on - guards against a warp triggered by
// noisy/inconsistent line detection rather than genuine perspective distortion.
const MIN_R_SQUARED = 0.6;
// Below this fractional change in line height across the region, any detected
// trend is too small to be worth a warp (the correction would be imperceptible
// to recognition but adds a resampling pass).
const MIN_HEIGHT_RATIO_CHANGE = 0.15;
const MIN_LINES_FOR_DETECTION = 3;

// Ordinary least-squares slope/intercept/R² of y = f(x).
function linearFit(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denom = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    denom += (xs[i] - meanX) ** 2;
  }
  const slope = denom === 0 ? 0 : num / denom;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, rSquared };
}

// `lines`: array of { y0, y1, x0, x1 } bboxes (in the region's own local pixel
// space) for each recognized line within one region, in reading order. Returns
// a source quad (4 corners, clockwise from top-left) to warp to a rectangle, or
// null if there's no clear, consistent keystone signal worth acting on.
export function detectKeystoneQuad(lines, regionWidth, regionHeight) {
  if (lines.length < MIN_LINES_FOR_DETECTION) return null;

  const centersY = lines.map((l) => (l.y0 + l.y1) / 2);
  const heights = lines.map((l) => l.y1 - l.y0);
  const fit = linearFit(centersY, heights);

  if (fit.rSquared < MIN_R_SQUARED) return null;

  const topHeight = fit.slope * 0 + fit.intercept;
  const bottomHeight = fit.slope * regionHeight + fit.intercept;
  if (topHeight <= 0 || bottomHeight <= 0) return null;
  const ratioChange = Math.abs(topHeight - bottomHeight) / Math.max(topHeight, bottomHeight);
  if (ratioChange < MIN_HEIGHT_RATIO_CHANGE) return null;

  // Lines get shorter toward whichever edge is farther from the camera; taper
  // that edge's width inward proportionally to model the perspective foreshortening.
  const taper = Math.min(0.4, ratioChange);
  const topInset = bottomHeight > topHeight ? regionWidth * taper * 0.5 : 0;
  const bottomInset = topHeight > bottomHeight ? regionWidth * taper * 0.5 : 0;

  return [
    { x: topInset, y: 0 },
    { x: regionWidth - topInset, y: 0 },
    { x: regionWidth - bottomInset, y: regionHeight },
    { x: bottomInset, y: regionHeight },
  ];
}

// Solves the 8-coefficient projective transform mapping the 4 `from` points to
// the 4 `to` points (standard DLT-style linear system for a planar homography).
// Returns a 3x3 matrix (row-major, 9 entries, h22 normalized to 1) or null if
// the points are degenerate.
//
// Exported, with applyHomography below, only so test/unit/perspective.test.js
// can round-trip them without a canvas: warpPerspective (the sole in-app
// caller) needs a DOM, this math doesn't, and a silently wrong homography
// misplaces every reprocessed word's bbox.
export function solveHomography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = from[i];
    const { x: dx, y: dy } = to[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
    b.push(dy);
  }

  // Gaussian elimination with partial pivoting on the augmented 8x8 system.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-10) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = A[row][col] / A[col][col];
      for (let k = col; k < 8; k++) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }

  const h = A.map((row, i) => b[i] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

function bilinearSample(data, width, height, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return null;
  const fx = x - x0;
  const fy = y - y0;
  const at = (px, py) => {
    const i = (py * width + px) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const c00 = at(x0, y0);
  const c10 = at(x1, y0);
  const c01 = at(x0, y1);
  const c11 = at(x1, y1);
  return c00.map((_, i) => {
    const top = c00[i] * (1 - fx) + c10[i] * fx;
    const bottom = c01[i] * (1 - fx) + c11[i] * fx;
    return top * (1 - fy) + bottom * fy;
  });
}

// Warps `sourceCanvas` so that `sourceQuad` (4 corners, clockwise from
// top-left, in sourceCanvas's own pixel space) becomes a straightened
// destWidth x destHeight rectangle. Returns `{ canvas, unwarpPoint }`, where
// `unwarpPoint(x, y)` maps a point in the returned (rectified) canvas's space
// back into sourceCanvas's original space - needed to map recognized word
// bboxes, which come back in rectified space, back to real image coordinates.
// Returns null if the quad is degenerate.
export function warpPerspective(sourceCanvas, sourceQuad, destWidth, destHeight) {
  const rect = [
    { x: 0, y: 0 },
    { x: destWidth, y: 0 },
    { x: destWidth, y: destHeight },
    { x: 0, y: destHeight },
  ];
  // H maps rectangle (destination) coordinates back into sourceQuad
  // (source) coordinates - the inverse mapping direction, so every
  // destination pixel has a defined source sample and there are no holes.
  // This is also exactly `unwarpPoint`, reused as-is below.
  const h = solveHomography(rect, sourceQuad);
  if (!h) return null;

  const { width: sw, height: sh } = sourceCanvas;
  const srcData = sourceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = destWidth;
  outCanvas.height = destHeight;
  const outCtx = outCanvas.getContext("2d");
  const outImageData = outCtx.createImageData(destWidth, destHeight);
  const outData = outImageData.data;

  for (let y = 0; y < destHeight; y++) {
    for (let x = 0; x < destWidth; x++) {
      const src = applyHomography(h, x, y);
      const sample = bilinearSample(srcData, sw, sh, src.x, src.y);
      const o = (y * destWidth + x) * 4;
      if (sample) {
        outData[o] = sample[0];
        outData[o + 1] = sample[1];
        outData[o + 2] = sample[2];
        outData[o + 3] = sample[3];
      } else {
        outData[o] = 255;
        outData[o + 1] = 255;
        outData[o + 2] = 255;
        outData[o + 3] = 255;
      }
    }
  }
  outCtx.putImageData(outImageData, 0, 0);
  return { canvas: outCanvas, unwarpPoint: (x, y) => applyHomography(h, x, y) };
}
