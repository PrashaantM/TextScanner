// edgeDetect.js: finds the document in a photo of a document.
//
// This is the feature that separates "a photo of a page" from "a scan". Given a
// snapshot of a receipt on a desk, it returns the four corners of the receipt so
// the page can be cropped and de-keystoned to a clean rectangle.
//
// The approach, and why it is not the textbook one:
//
// The canonical recipe is Canny edges -> Hough lines -> intersect -> pick the
// best quadrilateral. That needs OpenCV, and OpenCV.js is off the table in this
// project for a documented reason (js/preprocess.js's header: its WASM runtime
// reproducibly froze the main thread when loaded from a click handler). Writing
// Canny and a Hough accumulator by hand in JS is possible but slow on a
// full-resolution phone photo, and Hough is fragile on the case that actually
// matters - a white page on a light desk, where the strongest gradients in the
// frame are the text, not the page border.
//
// So this works the other way round: instead of finding edges and assembling
// them into a shape, it finds the REGION that looks like paper and takes its
// boundary. Concretely:
//
//   1. Downscale hard. A 4032x3024 photo becomes ~240px on its long edge. Edge
//      geometry at document scale survives that completely, and it turns a
//      12-megapixel problem into a 30-thousand-pixel one - the difference
//      between ~2 seconds and ~15 milliseconds.
//   2. Estimate the page's colour from the centre, where the document almost
//      always is, using a median rather than a mean so a dark logo or a photo
//      on the page cannot drag the estimate.
//   3. Build a mask of pixels close to that colour, then keep only the connected
//      component that touches the centre. This is what rejects a second sheet of
//      paper elsewhere on the desk.
//   4. Fit a quadrilateral to that component by finding its extreme points in
//      rotated coordinate frames, which handles a rotated page without needing
//      a convex hull.
//   5. Score the result and refuse it if it does not look like a document.
//
// Step 5 is the important one. A wrong crop is much worse than no crop: it
// silently removes part of someone's document. So `detectDocument` returns null
// far more readily than it returns a bad guess, and every caller treats null as
// "show the manual crop handles at the full frame".

const WORK_EDGE = 240;
// Below this, the detected quad is not plausibly a document in the frame and is
// more likely a patch of desk. A real document photo is framed to fill.
const MIN_AREA_FRACTION = 0.12;
// Above this, the "document" is essentially the whole frame, which means nothing
// was actually distinguished - cropping to it would do nothing but risk shaving
// the edges.
const MAX_AREA_FRACTION = 0.985;
// How much of the fitted quad the mask must actually fill.
//
// This is the check that separates a page from noise, and it is the important
// one. The flood fill from the centre will percolate through a noisy or textured
// image and produce a mask that touches all four edges - the extreme-point fit
// then dutifully returns a quad covering nearly the whole frame, which passes
// every area and aspect check while being completely meaningless.
//
// A real page fills its own quad almost entirely (solidity ~1). A percolated
// noise mask is spidery: it spans a large area but fills only a fraction of it.
// Requiring solidity is therefore a direct test of "is this a solid region"
// rather than "is this region big", and no threshold on size alone can
// substitute for it.
const MIN_SOLIDITY = 0.72;
// How far a pixel's colour may sit from the page estimate and still count as
// page. In 0-255 units per channel, summed across three channels.
const COLOUR_TOLERANCE = 108;
// A quad whose corners deviate this far from the fitted component's own
// bounding shape is rejected as not-a-quadrilateral.
const MIN_CORNER_SEPARATION = 0.08;

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

// Median of a sampled set. Used for the page-colour estimate specifically
// because it is insensitive to outliers - a mean over a page with a big black
// header estimates "grey" and the mask then matches nothing.
function medianOf(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function downscale(source, targetEdge) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const scale = Math.min(1, targetEdge / Math.max(sw, sh));
  const canvas = createCanvas(sw * scale, sh * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, scale: canvas.width / sw };
}

// Samples the middle third of the frame to estimate what the page looks like.
function estimatePageColour(data, width, height) {
  const x0 = Math.floor(width / 3);
  const x1 = Math.ceil((width * 2) / 3);
  const y0 = Math.floor(height / 3);
  const y1 = Math.ceil((height * 2) / 3);

  const reds = [];
  const greens = [];
  const blues = [];
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4;
      reds.push(data[i]);
      greens.push(data[i + 1]);
      blues.push(data[i + 2]);
    }
  }

  return [medianOf(reds), medianOf(greens), medianOf(blues)];
}

// Flood fill from the centre outward across pixels within tolerance of the page
// colour. An explicit stack rather than recursion - a 240px frame is ~57,000
// pixels and recursion overflows long before that.
function pageMask(data, width, height, pageColour) {
  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const [pr, pg, pb] = pageColour;

  const startX = width >> 1;
  const startY = height >> 1;
  const stack = [startY * width + startX];
  visited[stack[0]] = 1;

  let filled = 0;

  while (stack.length) {
    const index = stack.pop();
    const i = index * 4;
    const distance = Math.abs(data[i] - pr) + Math.abs(data[i + 1] - pg) + Math.abs(data[i + 2] - pb);
    if (distance > COLOUR_TOLERANCE) continue;

    mask[index] = 1;
    filled++;

    const x = index % width;
    const y = (index / width) | 0;

    // 4-connectivity. 8-connectivity leaks through single-pixel diagonal gaps,
    // which a JPEG-compressed page edge has plenty of.
    if (x > 0 && !visited[index - 1]) {
      visited[index - 1] = 1;
      stack.push(index - 1);
    }
    if (x < width - 1 && !visited[index + 1]) {
      visited[index + 1] = 1;
      stack.push(index + 1);
    }
    if (y > 0 && !visited[index - width]) {
      visited[index - width] = 1;
      stack.push(index - width);
    }
    if (y < height - 1 && !visited[index + width]) {
      visited[index + width] = 1;
      stack.push(index + width);
    }
  }

  return { mask, filled };
}

// Closes small holes in the mask. Dark text on the page reads as "not page" and
// punches holes through it; without this the extreme-point fit below latches
// onto the inside of a letter. Two dilations then two erosions - a morphological
// close, written directly because it is 20 lines and a dependency is not.
function closeMask(mask, width, height, radius = 2) {
  let current = mask;
  for (let pass = 0; pass < radius; pass++) current = dilate(current, width, height);
  for (let pass = 0; pass < radius; pass++) current = erode(current, width, height);
  return current;
}

function dilate(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i]) {
        out[i] = 1;
        continue;
      }
      if (
        (x > 0 && mask[i - 1]) ||
        (x < width - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - width]) ||
        (y < height - 1 && mask[i + width])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

function erode(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const up = y > 0 ? mask[i - width] : 1;
      const down = y < height - 1 ? mask[i + width] : 1;
      const left = x > 0 ? mask[i - 1] : 1;
      const right = x < width - 1 ? mask[i + 1] : 1;
      out[i] = up && down && left && right ? 1 : 0;
    }
  }
  return out;
}

// Fits a quadrilateral by extreme points. For an axis-aligned page the corners
// are the extremes of (x+y) and (x-y); for a rotated one they are the extremes
// in a rotated frame. Rather than search angles, this takes both sets and keeps
// whichever produces the larger quad - which is the correct one, because the
// wrong frame always under-covers.
function fitQuad(mask, width, height) {
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  let topLeft = null;
  let bottomRight = null;
  let topRight = null;
  let bottomLeft = null;
  let leftMost = null;
  let rightMost = null;
  let topMost = null;
  let bottomMost = null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;

      const sum = x + y;
      const diff = x - y;

      if (sum < minSum) {
        minSum = sum;
        topLeft = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        bottomRight = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        topRight = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bottomLeft = { x, y };
      }
      if (x < minX) {
        minX = x;
        leftMost = { x, y };
      }
      if (x > maxX) {
        maxX = x;
        rightMost = { x, y };
      }
      if (y < minY) {
        minY = y;
        topMost = { x, y };
      }
      if (y > maxY) {
        maxY = y;
        bottomMost = { x, y };
      }
    }
  }

  if (!topLeft || !bottomRight || !topRight || !bottomLeft) return null;

  const diagonalQuad = [topLeft, topRight, bottomRight, bottomLeft];
  const axisQuad = [topMost, rightMost, bottomMost, leftMost];

  return quadArea(diagonalQuad) >= quadArea(axisQuad) ? diagonalQuad : axisQuad;
}

// Shoelace formula. Returns absolute area, so winding order does not matter.
export function quadArea(quad) {
  if (!quad || quad.length !== 4 || quad.some((p) => !p)) return 0;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

// Rejects shapes that are technically quadrilaterals but are not documents:
// slivers, near-degenerate corners, and anything so close to the full frame that
// cropping to it accomplishes nothing.
function isPlausibleDocument(quad, width, height, filled) {
  const frameArea = width * height;
  const area = quadArea(quad);
  const fraction = area / frameArea;

  if (fraction < MIN_AREA_FRACTION || fraction > MAX_AREA_FRACTION) return false;

  // Solidity: how much of the quad the mask actually occupies. See MIN_SOLIDITY.
  if (area > 0 && filled / area < MIN_SOLIDITY) return false;

  const minSeparation = Math.min(width, height) * MIN_CORNER_SEPARATION;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(quad[i].x - quad[j].x, quad[i].y - quad[j].y) < minSeparation) return false;
    }
  }

  // Opposite sides of a real page, even under perspective, stay within a
  // generous ratio of each other. A wild mismatch means the fit caught a
  // shadow running off the frame.
  const top = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const bottom = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  const left = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const right = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);

  const horizontalRatio = Math.max(top, bottom) / Math.max(1, Math.min(top, bottom));
  const verticalRatio = Math.max(left, right) / Math.max(1, Math.min(left, right));

  return horizontalRatio < 3.2 && verticalRatio < 3.2;
}

// Orders four arbitrary points as top-left, top-right, bottom-right, bottom-left
// - the order js/perspective.js expects, and the order the crop handles are
// drawn in. Sorting by angle about the centroid is robust to the points arriving
// in any order, including a mirrored one.
export function orderCorners(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  const withAngle = points.map((p) => ({ ...p, angle: Math.atan2(p.y - cy, p.x - cx) }));
  withAngle.sort((a, b) => a.angle - b.angle);

  // After an angular sort the sequence is in order but may start anywhere.
  // Rotate so the point closest to the top-left of the bounding box is first.
  let startIndex = 0;
  let best = Infinity;
  withAngle.forEach((p, i) => {
    const score = p.x + p.y;
    if (score < best) {
      best = score;
      startIndex = i;
    }
  });

  return [0, 1, 2, 3].map((i) => {
    const p = withAngle[(startIndex + i) % 4];
    return { x: p.x, y: p.y };
  });
}

// The entry point. Returns four corners in ORIGINAL-image pixel space, ordered
// top-left clockwise, or null if nothing document-shaped was found.
//
// Returning null is a first-class outcome, not a failure. A wrong crop silently
// destroys part of someone's document; no crop just means they position the
// handles themselves.
export function detectDocument(source) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  if (!sw || !sh) return null;

  const { canvas, scale } = downscale(source, WORK_EDGE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);

  const pageColour = estimatePageColour(data, width, height);
  const { mask, filled } = pageMask(data, width, height, pageColour);

  // Nothing contiguous around the centre looked like a page.
  if (filled < width * height * MIN_AREA_FRACTION) return null;

  const closed = closeMask(mask, width, height);
  const quad = fitQuad(closed, width, height);

  // Count the CLOSED mask rather than reusing `filled` from the flood fill - the
  // morphological close is what the quad was fitted to, so it is what the
  // solidity check has to measure against.
  let closedCount = 0;
  for (let i = 0; i < closed.length; i++) closedCount += closed[i];

  if (!quad || !isPlausibleDocument(quad, width, height, closedCount)) return null;

  // Back to original-image coordinates, and clamped - the morphological close
  // dilates before it erodes and can push a corner a pixel outside the frame.
  const ordered = orderCorners(quad);
  return ordered.map((p) => ({
    x: Math.min(sw, Math.max(0, p.x / scale)),
    y: Math.min(sh, Math.max(0, p.y / scale)),
  }));
}

// The full frame, as corners. What the crop UI starts from when detection
// declines to guess.
export function fullFrameCorners(width, height) {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

// True when the corners are (near enough) the whole frame, so the caller can
// skip an expensive warp that would be a no-op.
export function isFullFrame(corners, width, height, tolerance = 2) {
  if (!corners || corners.length !== 4) return true;
  const expected = fullFrameCorners(width, height);
  return corners.every(
    (p, i) => Math.abs(p.x - expected[i].x) <= tolerance && Math.abs(p.y - expected[i].y) <= tolerance
  );
}
