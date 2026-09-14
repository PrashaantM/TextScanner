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

// ---- Routing: diffusion or exemplar ----
//
// Harmonic diffusion is not a weak inpainter, it is a SPECIFIC one. It solves
// for the smoothest surface consistent with the boundary, which is exactly right
// on flat colour and on gradients - a linear gradient IS harmonic, so it comes
// back essentially perfect - and is structurally incapable of reinventing
// high-frequency detail, because a Laplace solution has no mechanism to create
// any. Measured against held ground truth (the background captured before the
// text was drawn over it), mean absolute per-channel error 0-255:
//
//     plain paper      0.00   <- exact
//     soft gradient    2.07   <- correct; a gradient is harmonic
//     lined paper      4.15   (RMSE 13.84, worst 93)  <- rules erased
//     wood grain      11.95   (RMSE 14.83)            <- grain erased
//     graph paper     18.49   (RMSE 19.54)            <- grid erased
//
// So the fix is not to replace diffusion, it is to stop using it where it cannot
// work. Smooth regions keep it: it is cheaper, it is deterministic, and on those
// backgrounds it is not merely adequate but exact. Textured regions get
// patch-based exemplar synthesis, which reproduces structure by copying real
// neighbouring pixels rather than averaging them away.
//
// The routing signal is the high-frequency energy of the KNOWN ring around the
// hole - mean absolute Laplacian, which is ~0 for flat colour, near 0 for a
// linear gradient (the Laplacian of a linear function is exactly zero, which is
// the same reason diffusion nails it), and large wherever there is real detail.
// Measured on the five fixtures above; see test/inpaint-fidelity.js for the
// numbers this threshold sits between.
// Set from the measurements above, in the gap between the smooth backgrounds and
// the textured ones - which is a wide one, not a hairline:
//
//     plain paper     0.00  |
//     soft gradient   0.50  |  diffusion
//     ----------------------+---- 1.0
//     lined paper     1.85  |
//     wood grain      4.02  |  exemplar
//     graph paper     5.26  |
//
// 1.0 is deliberately nearer the smooth side. Getting it wrong in the exemplar
// direction costs some work and a slightly different texture; getting it wrong
// in the diffusion direction erases structure that was really there, which is
// the defect this whole path exists to fix. test/inpaint-fidelity.js reports
// the energy per fixture, so if a future background lands near this line it
// shows up as a number rather than as a surprise.
const TEXTURE_ENERGY_THRESHOLD = 1.0;

// Minimum ring width when exemplar synthesis may run. PATCH_RADIUS is 3, so a
// margin of 8 leaves a 5px band of valid patch centres - technically usable,
// practically not enough distinct material to synthesize from.
const EXEMPLAR_MIN_MARGIN = 28;

// Mean |Laplacian| over the known ring, per channel, 0-255. Only pixels whose
// full 4-neighbourhood is outside the hole contribute, so the hole's own
// contents - which at this point are still the original text - never influence
// the routing decision.
export function ringTextureEnergy(data, width, height, mx0, my0, mx1, my1) {
  let sum = 0;
  let count = 0;
  const known = (x, y) => x >= 0 && y >= 0 && x < width && y < height && !(x >= mx0 && x < mx1 && y >= my0 && y < my1);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!known(x, y) || !known(x - 1, y) || !known(x + 1, y) || !known(x, y - 1) || !known(x, y + 1)) continue;
      const i = (y * width + x) * 4;
      const iL = i - 4;
      const iR = i + 4;
      const iU = i - width * 4;
      const iD = i + width * 4;
      for (let k = 0; k < 3; k++) {
        sum += Math.abs(4 * data[i + k] - data[iL + k] - data[iR + k] - data[iU + k] - data[iD + k]) / 4;
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

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

// ---- Exemplar synthesis (PatchMatch-style) ----
//
// Hand-rolled, ~120 lines, no dependency - the same call this project made for
// the PDF writer. OpenCV.js would bring a multi-megabyte WASM runtime whose
// load has already frozen this app's main thread once (see js/preprocess.js),
// to do a job scoped to one word-sized box.
//
// The idea, which is Barnes et al.'s PatchMatch reduced to what this needs: for
// every hole pixel keep an OFFSET pointing at some fully-known pixel elsewhere
// in the crop, and improve those offsets by alternating
//
//   propagation  - a good offset for my neighbour is probably good for me,
//                  because natural images are locally coherent, and
//   random search - jump to random candidates at exponentially shrinking
//                  radius, which escapes local minima cheaply.
//
// Two deliberate choices worth naming:
//
//   The hole is SEEDED WITH THE DIFFUSION RESULT rather than with noise. The
//   patch distance below compares a target patch against a source patch, and on
//   the first pass most of the target patch is hole, so it needs plausible
//   values to compare at all. Seeding with diffusion also means the worst case
//   here degrades to roughly "what we had before" rather than to garbage.
//
//   The final image is VOTED, not copied: each hole pixel averages the
//   predictions of every overlapping patch rather than taking only its own
//   offset. Copying alone leaves visible patch seams; voting costs one extra
//   accumulation pass and removes them.
const PATCH_RADIUS = 3;          // 7x7 patches - big enough to carry a rule or a grain, small enough to stay fast
const PM_ITERATIONS = 4;         // propagate+search passes per EM round, alternating direction
const PM_RANDOM_CANDIDATES = 6;  // random jumps per pixel per pass
// EM rounds: search against the current fill, vote, then search again against
// the IMPROVED fill. One round alone is not enough and the reason is worth
// recording, because the first implementation here shipped exactly that and the
// texture did not come back: on round one most of a target patch is still the
// diffusion seed, which is smooth, so the search happily matches smooth source
// patches and the vote averages them into more smoothness. Re-searching against
// the voted result is what lets structure bootstrap itself into the hole.
const EM_ROUNDS = 3;

function exemplarFill(data, width, height, mx0, my0, mx1, my1) {
  const r = PATCH_RADIUS;
  const holeW = mx1 - mx0;
  const holeH = my1 - my0;
  const size = width * height;

  // `known` starts as everything outside the hole and grows inward as pixels are
  // filled. It is the heart of this function: the patch distance below compares
  // ONLY known positions, so a target patch is always matched against real
  // pixels rather than against a guess.
  const known = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      known[y * width + x] = x >= mx0 && x < mx1 && y >= my0 && y < my1 ? 0 : 1;
    }
  }

  // Valid source centres: patch fully inside the crop and fully outside the
  // hole, so a copied patch never carries the text being removed back in.
  const sources = [];
  for (let y = r; y < height - r; y++) {
    for (let x = r; x < width - r; x++) {
      if (x + r >= mx0 && x - r < mx1 && y + r >= my0 && y - r < my1) continue;
      sources.push(y * width + x);
    }
  }
  // Not enough exemplar material to synthesize from: leave the diffusion result
  // rather than inventing something worse out of a handful of pixels.
  if (sources.length < 64) return;

  // Deterministic PRNG. The same image must inpaint identically twice or the
  // fidelity numbers in test/inpaint-fidelity.js would drift run to run and mean
  // nothing. mulberry32, seeded from the geometry.
  let seed = (mx0 * 73856093) ^ (my0 * 19349663) ^ (holeW * 83492791) ^ holeH;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Mask-aware SSD: only positions that are known on the TARGET side count, and
  // the total is normalized by how many did, so a patch with few known
  // neighbours is not flattered by having little to disagree about.
  const patchDistance = (tx, ty, sx, sy, best) => {
    let total = 0;
    let counted = 0;
    for (let dy = -r; dy <= r; dy++) {
      const tyy = ty + dy;
      const syy = sy + dy;
      if (tyy < 0 || tyy >= height || syy < 0 || syy >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const txx = tx + dx;
        const sxx = sx + dx;
        if (txx < 0 || txx >= width || sxx < 0 || sxx >= width) continue;
        if (!known[tyy * width + txx]) continue;
        const ti = (tyy * width + txx) * 4;
        const si = (syy * width + sxx) * 4;
        const dr = data[ti] - data[si];
        const dg = data[ti + 1] - data[si + 1];
        const db = data[ti + 2] - data[si + 2];
        total += dr * dr + dg * dg + db * db;
        counted++;
        if (counted > 8 && total / counted >= best) return Infinity;
      }
    }
    return counted ? total / counted : Infinity;
  };

  const inCropSource = (cx, cy) =>
    cx >= r && cy >= r && cx < width - r && cy < height - r &&
    !(cx + r >= mx0 && cx - r < mx1 && cy + r >= my0 && cy - r < my1);

  // ---- Onion peel ----
  //
  // Fill from the hole's border inward, one shell at a time, rather than solving
  // the whole hole at once. This is the difference between working and not, and
  // the first two versions of this function got it wrong: filling everything at
  // once means every target patch is mostly seed, the seed is smooth, and the
  // search dutifully finds a SMOOTH source patch that matches it perfectly. That
  // is a real minimum of the distance and EM cannot escape it, so lines and
  // grids came back erased no matter how the voting was weighted (measured:
  // high-frequency energy restored, 0.00 and 0.01 of the truth's).
  //
  // Filling inward instead means the first shell sits directly against real
  // pixels - including whatever rule, grain or grid line runs INTO the hole - so
  // matching there selects source patches carrying that structure, and each
  // shell then becomes real context for the next. Structure propagates in from
  // the edges, which is exactly how it left.
  const dist = new Int32Array(size).fill(-1);
  let frontier = [];
  for (let y = my0; y < my1; y++) {
    for (let x = mx0; x < mx1; x++) {
      const i = y * width + x;
      const border =
        x === mx0 || x === mx1 - 1 || y === my0 || y === my1 - 1;
      if (border) { dist[i] = 0; frontier.push(i); }
    }
  }
  const shells = [];
  let d = 0;
  while (frontier.length) {
    shells.push(frontier);
    const next = [];
    for (const i of frontier) {
      const x = i % width;
      const y = (i / width) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < mx0 || nx >= mx1 || ny < my0 || ny >= my1) continue;
        const ni = ny * width + nx;
        if (dist[ni] !== -1) continue;
        dist[ni] = d + 1;
        next.push(ni);
      }
    }
    frontier = next;
    d++;
  }

  const field = new Int32Array(size);
  const score = new Float64Array(size);

  for (const shell of shells) {
    for (const i of shell) {
      const x = i % width;
      const y = (i / width) | 0;

      let bestSrc = -1;
      let bestScore = Infinity;

      // Seed candidates from already-filled neighbours, shifted - this is
      // PatchMatch's propagation, and it is what keeps a copied run of pixels
      // coherent instead of confetti.
      for (const [nx, ny, sh] of [[x - 1, y, 1], [x + 1, y, -1], [x, y - 1, width], [x, y + 1, -width]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!known[ni] || !field[ni]) continue;
        const cand = field[ni] + sh;
        const cx = cand % width;
        const cy = (cand / width) | 0;
        if (!inCropSource(cx, cy)) continue;
        const dd = patchDistance(x, y, cx, cy, bestScore);
        if (dd < bestScore) { bestScore = dd; bestSrc = cand; }
      }

      // Random search, widening the net when propagation had nothing to offer.
      const tries = bestSrc === -1 ? PM_RANDOM_CANDIDATES * 4 : PM_RANDOM_CANDIDATES;
      for (let k = 0; k < tries; k++) {
        const cand = sources[(rand() * sources.length) | 0];
        const dd = patchDistance(x, y, cand % width, (cand / width) | 0, bestScore);
        if (dd < bestScore) { bestScore = dd; bestSrc = cand; }
      }

      // Local refinement around the current best, which is where the last few
      // points of accuracy come from.
      if (bestSrc !== -1) {
        let radius = 16;
        while (radius >= 1) {
          const bx = bestSrc % width;
          const by = (bestSrc / width) | 0;
          for (let k = 0; k < 4; k++) {
            const cx = bx + Math.round((rand() * 2 - 1) * radius);
            const cy = by + Math.round((rand() * 2 - 1) * radius);
            if (!inCropSource(cx, cy)) continue;
            const dd = patchDistance(x, y, cx, cy, bestScore);
            if (dd < bestScore) { bestScore = dd; bestSrc = cy * width + cx; }
          }
          radius >>= 1;
        }
      }

      if (bestSrc === -1) { known[i] = 1; continue; } // keep the diffusion value
      const si = bestSrc * 4;
      const di = i * 4;
      data[di] = data[si];
      data[di + 1] = data[si + 1];
      data[di + 2] = data[si + 2];
      field[i] = bestSrc;
      score[i] = bestScore;
      known[i] = 1; // real pixels now; the next shell matches against them
    }
  }

  // ---- Refinement ----
  //
  // The onion peel decides each pixel from one patch, which can leave faint
  // seams where two shells disagreed. Now that the whole hole holds real texture
  // rather than a smooth seed, a similarity-weighted vote over the overlapping
  // patches smooths those seams WITHOUT erasing structure - the thing an
  // unweighted vote over a smooth seed could never do.
  for (let round = 0; round < EM_ROUNDS; round++) {
    const accum = new Float64Array(holeW * holeH * 3);
    const weight = new Float64Array(holeW * holeH);
    const at = (x, y) => (y - my0) * holeW + (x - mx0);

    for (let y = my0; y < my1; y++) {
      for (let x = mx0; x < mx1; x++) {
        const i = y * width + x;
        const src = field[i];
        if (!src) continue;
        const sx = src % width;
        const sy = (src / width) | 0;
        const w = 1 / Math.pow(score[i] / 3 + 4, 2);
        for (let dy = -r; dy <= r; dy++) {
          const ty = y + dy;
          if (ty < my0 || ty >= my1) continue;
          for (let dx = -r; dx <= r; dx++) {
            const tx = x + dx;
            if (tx < mx0 || tx >= mx1) continue;
            const si = ((sy + dy) * width + (sx + dx)) * 4;
            const ti = at(tx, ty);
            accum[ti * 3] += data[si] * w;
            accum[ti * 3 + 1] += data[si + 1] * w;
            accum[ti * 3 + 2] += data[si + 2] * w;
            weight[ti] += w;
          }
        }
      }
    }
    for (let y = my0; y < my1; y++) {
      for (let x = mx0; x < mx1; x++) {
        const ti = at(x, y);
        if (!weight[ti]) continue;
        const di = (y * width + x) * 4;
        data[di] = accum[ti * 3] / weight[ti];
        data[di + 1] = accum[ti * 3 + 1] / weight[ti];
        data[di + 2] = accum[ti * 3 + 2] / weight[ti];
      }
    }

    // Re-search against the improved fill so the next round has better context.
    if (round < EM_ROUNDS - 1) {
      for (let y = my0; y < my1; y++) {
        for (let x = mx0; x < mx1; x++) {
          const i = y * width + x;
          let bestSrc = field[i] || sources[(rand() * sources.length) | 0];
          let bestScore = patchDistance(x, y, bestSrc % width, (bestSrc / width) | 0, Infinity);
          for (const [nx, ny, sh] of [[x - 1, y, 1], [x + 1, y, -1], [x, y - 1, width], [x, y + 1, -width]]) {
            if (nx < mx0 || nx >= mx1 || ny < my0 || ny >= my1) continue;
            const cand = field[ny * width + nx] + sh;
            const cx = cand % width;
            const cy = (cand / width) | 0;
            if (!inCropSource(cx, cy)) continue;
            const dd = patchDistance(x, y, cx, cy, bestScore);
            if (dd < bestScore) { bestScore = dd; bestSrc = cand; }
          }
          field[i] = bestSrc;
          score[i] = bestScore;
        }
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

  // Exemplar synthesis needs real source material to copy from, so the ring is
  // widened when it might be used. computeMargin's 8-40px is plenty of boundary
  // for diffusion, which only reads the ring's inner edge, but leaves too thin a
  // band of valid patch centres to synthesize from.
  const margin = Math.max(computeMargin(bw, bh), EXEMPLAR_MIN_MARGIN);
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

  // Route on the texture of the surrounding ring, measured BEFORE the hole is
  // touched. Diffusion runs either way: on a smooth background it is the answer,
  // and on a textured one it is the seed exemplarFill refines (see its header).
  const energy = ringTextureEnergy(imageData.data, pw, ph, maskX0, maskY0, maskX1, maskY1);
  diffuseFill(imageData.data, pw, ph, maskX0, maskY0, maskX1, maskY1);
  if (energy > TEXTURE_ENERGY_THRESHOLD) {
    exemplarFill(imageData.data, pw, ph, maskX0, maskY0, maskX1, maskY1);
  }
  cropCtx.putImageData(imageData, 0, 0);

  const patchCanvas = document.createElement("canvas");
  patchCanvas.width = maskX1 - maskX0;
  patchCanvas.height = maskY1 - maskY0;
  patchCanvas
    .getContext("2d")
    .drawImage(cropCanvas, maskX0, maskY0, patchCanvas.width, patchCanvas.height, 0, 0, patchCanvas.width, patchCanvas.height);
  return patchCanvas;
}
