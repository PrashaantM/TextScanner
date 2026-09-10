// scanFilters.js: the look of a scanned page.
//
// Distinct from js/preprocess.js, and the distinction is worth stating because
// the two do superficially similar things. preprocess.js produces an image for
// the RECOGNIZER - it is allowed to be ugly, it is thrown away after OCR, and
// it optimizes purely for character legibility. This module produces the image
// the PERSON KEEPS. It has to look like a good scan, stay faithful to the
// original document, and survive being exported to PDF and printed.
//
// So they share techniques (grayscale, local background estimation) and share
// no code, because every tuning decision pulls in a different direction. An
// aggressive binarization that lifts OCR accuracy will also eat a signature's
// pressure variation and turn a photograph on the page into a blob.
//
// All of it is plain Canvas 2D and typed arrays - no OpenCV.js, for the reason
// documented at length in js/preprocess.js's header (its WASM runtime
// reproducibly froze the main thread when loaded from a click handler).
//
// Every filter is pure: source canvas in, new canvas out. Nothing mutates its
// input, so the original capture is always recoverable and re-filtering never
// compounds - see `originalBlobKey` in js/documents.js.

export const FILTERS = {
  ORIGINAL: "original",
  AUTO: "auto",
  MAGIC: "magic",
  GRAYSCALE: "grayscale",
  BW: "bw",
  SOFT_BW: "softbw",
};

export const FILTER_LABELS = {
  [FILTERS.ORIGINAL]: "Original",
  [FILTERS.AUTO]: "Auto enhance",
  [FILTERS.MAGIC]: "Magic colour",
  [FILTERS.GRAYSCALE]: "Greyscale",
  [FILTERS.BW]: "Black & white",
  [FILTERS.SOFT_BW]: "Soft B&W",
};

export const FILTER_ORDER = [
  FILTERS.AUTO,
  FILTERS.MAGIC,
  FILTERS.ORIGINAL,
  FILTERS.GRAYSCALE,
  FILTERS.SOFT_BW,
  FILTERS.BW,
];

// The local-background estimate every "flatten the lighting" filter needs is
// built by downscaling hard and scaling back up - canvas's bilinear resampling
// is a fast, cache-friendly approximation of a very large box blur, and doing it
// by hand per pixel is orders of magnitude slower for an identical result at
// this radius. 48px on the long edge is enough to capture a shadow gradient or
// a page curl without following the text itself.
const BACKGROUND_TARGET = 48;
// Text is darker than its local background by at least this fraction before a
// binarizing filter will call it ink. Below it, the pixel is paper.
const INK_THRESHOLD = 0.86;

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function canvasFromSource(source, width, height) {
  const w = width || source.naturalWidth || source.width;
  const h = height || source.naturalHeight || source.height;
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cloneCanvas(source) {
  const canvas = createCanvas(source.width, source.height);
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

// Per-channel local background, kept in colour rather than collapsed to
// luminance. A page photographed under a warm desk lamp has a background that is
// genuinely orange, and dividing all three channels by a single grey estimate
// leaves that cast behind - which is exactly the "my scan looks yellow" problem
// the Magic Colour filter exists to solve.
function buildBackground(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const scale = BACKGROUND_TARGET / Math.max(width, height);
  const smallW = Math.max(1, Math.round(width * scale));
  const smallH = Math.max(1, Math.round(height * scale));

  const small = createCanvas(smallW, smallH);
  const smallCtx = small.getContext("2d");
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(sourceCanvas, 0, 0, smallW, smallH);

  const background = createCanvas(width, height);
  const bgCtx = background.getContext("2d");
  bgCtx.imageSmoothingEnabled = true;
  bgCtx.imageSmoothingQuality = "high";
  bgCtx.drawImage(small, 0, 0, width, height);

  return bgCtx.getImageData(0, 0, width, height).data;
}

// Percentile over a sampled histogram. Used to find "what counts as white on
// this page" without letting a single blown-out highlight define it - a stray
// specular reflection off a staple would otherwise set the white point and make
// the whole page grey.
function percentile(data, fraction, stride = 4 * 16) {
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += stride) {
    const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    histogram[Math.min(255, Math.max(0, Math.round(luma)))]++;
    count++;
  }
  const target = count * fraction;
  let running = 0;
  for (let value = 0; value < 256; value++) {
    running += histogram[value];
    if (running >= target) return value;
  }
  return 255;
}

// ---- The filters ----

function applyGrayscale(sourceCanvas) {
  const out = cloneCanvas(sourceCanvas);
  const ctx = out.getContext("2d");
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma. Perceptual weighting matters here: a flat average turns
    // red ink and blue ink into the same grey, and receipts are full of both.
    const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    data[i] = data[i + 1] = data[i + 2] = luma;
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

// Auto enhance: flatten the lighting, then stretch what is left to fill the
// range. The conservative default, and the one that stays honest on a page with
// a photograph or a coloured logo on it.
function applyAuto(sourceCanvas, { strength = 1 } = {}) {
  const out = cloneCanvas(sourceCanvas);
  const ctx = out.getContext("2d");
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const data = image.data;
  const background = buildBackground(sourceCanvas);

  // The white point is the 92nd percentile rather than the maximum, so a
  // handful of blown highlights cannot define it.
  const whitePoint = Math.max(1, percentile(data, 0.92));
  const blackPoint = Math.min(whitePoint - 1, percentile(data, 0.04));
  const range = Math.max(1, whitePoint - blackPoint);

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const bg = Math.max(1, background[i + c]);
      // Divide out the local background, scaled back toward the global white
      // point so the result is a page rather than a uniform flat grey.
      const flattened = (data[i + c] / bg) * whitePoint;
      const mixed = data[i + c] + (flattened - data[i + c]) * strength;
      const stretched = ((mixed - blackPoint) / range) * 255;
      data[i + c] = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched;
    }
  }

  ctx.putImageData(image, 0, 0);
  return out;
}

// Magic colour: auto enhance, then push saturation and contrast. This is the
// filter that makes a phone photo of a printed page look like it came off a
// flatbed - whites go actually white, coloured ink stays coloured and gets
// bolder, and the paper texture drops out.
function applyMagic(sourceCanvas) {
  const enhanced = applyAuto(sourceCanvas, { strength: 1 });
  const ctx = enhanced.getContext("2d");
  const image = ctx.getImageData(0, 0, enhanced.width, enhanced.height);
  const data = image.data;

  const saturation = 1.35;
  const contrast = 1.22;
  // Standard contrast pivot. Pivoting about mid-grey rather than 0 keeps the
  // image's overall brightness where it was instead of darkening everything.
  const pivot = 128;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = (r * 299 + g * 587 + b * 114) / 1000;

    for (let c = 0; c < 3; c++) {
      // Saturate by pushing each channel away from its own luma.
      const saturated = luma + (data[i + c] - luma) * saturation;
      const contrasted = pivot + (saturated - pivot) * contrast;
      data[i + c] = contrasted < 0 ? 0 : contrasted > 255 ? 255 : contrasted;
    }
  }

  ctx.putImageData(image, 0, 0);
  return enhanced;
}

// Adaptive binarization against the local background. A global threshold fails
// on every real photo of a page - one corner is always in shadow - so each pixel
// is compared to its own neighbourhood instead.
function applyBW(sourceCanvas, { soft = false } = {}) {
  const out = cloneCanvas(sourceCanvas);
  const ctx = out.getContext("2d");
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const data = image.data;
  const background = buildBackground(sourceCanvas);

  for (let i = 0; i < data.length; i += 4) {
    const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    const bgLuma = Math.max(1, (background[i] * 299 + background[i + 1] * 587 + background[i + 2] * 114) / 1000);
    const ratio = luma / bgLuma;

    let value;
    if (soft) {
      // Soft B&W keeps a short ramp either side of the threshold instead of
      // slamming to 0 or 255. Signatures, pencil and halftone photographs
      // survive this and are destroyed by hard binarization - which is the whole
      // reason both exist as separate choices rather than one "B&W" button.
      const t = (ratio - (INK_THRESHOLD - 0.12)) / 0.24;
      value = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
    } else {
      value = ratio < INK_THRESHOLD ? 0 : 255;
    }

    data[i] = data[i + 1] = data[i + 2] = value;
  }

  ctx.putImageData(image, 0, 0);
  return out;
}

// The one entry point callers use. Unknown filter names fall through to the
// original rather than throwing - a document saved by a future version with a
// filter this build has never heard of should still open and show its page.
export function applyFilter(sourceCanvas, filter) {
  switch (filter) {
    case FILTERS.AUTO:
      return applyAuto(sourceCanvas);
    case FILTERS.MAGIC:
      return applyMagic(sourceCanvas);
    case FILTERS.GRAYSCALE:
      return applyGrayscale(sourceCanvas);
    case FILTERS.BW:
      return applyBW(sourceCanvas, { soft: false });
    case FILTERS.SOFT_BW:
      return applyBW(sourceCanvas, { soft: true });
    case FILTERS.ORIGINAL:
    default:
      return cloneCanvas(sourceCanvas);
  }
}

// ---- Rotation ----

export function rotateCanvas(sourceCanvas, degrees) {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
  if (turns === 0) return cloneCanvas(sourceCanvas);

  const swapped = turns % 2 === 1;
  const width = swapped ? sourceCanvas.height : sourceCanvas.width;
  const height = swapped ? sourceCanvas.width : sourceCanvas.height;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.translate(width / 2, height / 2);
  ctx.rotate((turns * 90 * Math.PI) / 180);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return canvas;
}

// ---- Encoding ----

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the page image."))),
      type,
      quality
    );
  });
}

// Thumbnails are deliberately small and cheap. The library draws hundreds of
// them; decoding a full-resolution page for each is the difference between a
// list that opens instantly and one that stalls for seconds.
export function makeThumbnail(sourceCanvas, maxEdge = 320) {
  const scale = Math.min(1, maxEdge / Math.max(sourceCanvas.width, sourceCanvas.height));
  const canvas = createCanvas(sourceCanvas.width * scale, sourceCanvas.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}
