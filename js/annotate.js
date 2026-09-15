// annotate.js: freehand marks on a page - signatures, highlights, redaction.
//
// Strokes are stored as VECTORS in the page record, never burned into the image,
// and that is the design decision everything else here follows from:
//
//   - A stroke can be undone, re-coloured or deleted after the fact.
//   - Re-running OCR still sees the original page, not ink over it.
//   - Changing the scan filter does not destroy the signature.
//   - Storage cost is a few hundred bytes rather than a re-encoded photo.
//
// They are burned in exactly once, at export, by `renderAnnotations`.
//
// Coordinates are normalized 0-1 against the page image, not pixels. A page
// rotated or re-cropped after being signed would otherwise put the signature in
// the wrong place, and the same stroke data has to draw correctly onto a 320px
// thumbnail and a 4000px export.
//
// Redaction is the one tool that is NOT merely cosmetic, and it is treated
// differently on purpose - see REDACT below. In particular the first bullet
// above ("a stroke can be undone") stops applying to a redact stroke the moment
// it is applied, because applying one destroys the page's original.

export const TOOLS = {
  PEN: "pen",
  HIGHLIGHTER: "highlighter",
  REDACT: "redact",
  ERASER: "eraser",
};

export const TOOL_LABELS = {
  [TOOLS.PEN]: "Pen",
  [TOOLS.HIGHLIGHTER]: "Highlighter",
  [TOOLS.REDACT]: "Redact",
  [TOOLS.ERASER]: "Eraser",
};

// Widths are fractions of the page's smaller dimension, so a stroke drawn on a
// phone looks the same weight when the page is exported at full resolution.
export const TOOL_DEFAULTS = {
  [TOOLS.PEN]: { width: 0.004, color: "#1a1a2e", opacity: 1, composite: "source-over" },
  [TOOLS.HIGHLIGHTER]: { width: 0.022, color: "#ffe14d", opacity: 0.4, composite: "multiply" },
  [TOOLS.REDACT]: { width: 0.03, color: "#000000", opacity: 1, composite: "source-over" },
};

export const PEN_COLORS = ["#1a1a2e", "#d1004b", "#0b6bcb", "#1b8a5a", "#e0680b"];

export function createStroke(tool, { color, width } = {}) {
  const defaults = TOOL_DEFAULTS[tool] || TOOL_DEFAULTS[TOOLS.PEN];
  return {
    id: `stroke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    tool,
    color: color || defaults.color,
    width: width || defaults.width,
    opacity: defaults.opacity,
    // Flat [x0, y0, x1, y1, ...] rather than [{x, y}, ...]. A signature is
    // easily 400 points; the object form costs roughly 6x the JSON and is
    // measurably slower to serialize on every autosave.
    points: [],
  };
}

export function addPoint(stroke, x, y) {
  const points = stroke.points;
  const clampedX = Math.min(1, Math.max(0, x));
  const clampedY = Math.min(1, Math.max(0, y));

  // Drop points closer than this to the previous one. A pointermove stream on a
  // high-refresh screen emits far more points than a stroke needs; without this
  // a signature stores thousands of them and redraws visibly slower.
  const MIN_STEP = 0.0015;
  const n = points.length;
  if (n >= 2) {
    const dx = clampedX - points[n - 2];
    const dy = clampedY - points[n - 1];
    if (Math.hypot(dx, dy) < MIN_STEP) return false;
  }

  points.push(clampedX, clampedY);
  return true;
}

// Chaikin-style midpoint smoothing, drawn with quadratic curves through the
// midpoints of consecutive segments. A polyline through raw pointer samples
// looks visibly faceted at export resolution; this costs nothing and is the
// difference between a signature that looks written and one that looks traced
// on an Etch A Sketch.
function strokePath(ctx, points, width, height) {
  const n = points.length / 2;
  if (n === 0) return;

  const px = (i) => points[i * 2] * width;
  const py = (i) => points[i * 2 + 1] * height;

  ctx.beginPath();

  if (n === 1) {
    // A single tap still deserves a mark.
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(0) + 0.01, py(0));
    ctx.stroke();
    return;
  }

  ctx.moveTo(px(0), py(0));
  for (let i = 1; i < n - 1; i++) {
    const midX = (px(i) + px(i + 1)) / 2;
    const midY = (py(i) + py(i + 1)) / 2;
    ctx.quadraticCurveTo(px(i), py(i), midX, midY);
  }
  ctx.lineTo(px(n - 1), py(n - 1));
  ctx.stroke();
}

// Draws every stroke onto a context sized `width` x `height`. Used for both the
// live overlay and the burned-in export, so what someone sees while drawing is
// produced by the same code that writes the final pixels.
export function renderAnnotations(ctx, strokes, width, height) {
  if (!strokes || !strokes.length) return;

  const minEdge = Math.min(width, height);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Highlighter before pen, so ink always sits on top of its own highlight
  // regardless of the order they were drawn in. Redaction goes last because it
  // must cover everything, including strokes made after it.
  const order = [TOOLS.HIGHLIGHTER, TOOLS.PEN, TOOLS.REDACT];
  const sorted = [...strokes].sort((a, b) => order.indexOf(a.tool) - order.indexOf(b.tool));

  for (const stroke of sorted) {
    if (!stroke.points || stroke.points.length < 2) continue;

    const defaults = TOOL_DEFAULTS[stroke.tool] || TOOL_DEFAULTS[TOOLS.PEN];
    ctx.globalAlpha = stroke.opacity ?? defaults.opacity;
    ctx.globalCompositeOperation = stroke.tool === TOOLS.HIGHLIGHTER ? "multiply" : "source-over";
    ctx.strokeStyle = stroke.color || defaults.color;
    ctx.lineWidth = Math.max(1, (stroke.width || defaults.width) * minEdge);

    strokePath(ctx, stroke.points, width, height);
  }

  ctx.restore();
}

// Burns annotations into a copy of the page. Called once, at export.
//
// REDACTION, and why it is done here rather than only in the overlay: a redact
// stroke that exists only as vector data on top of an untouched image is not
// redaction at all - anyone can open the file and remove the black box, which is
// how organisations leak documents. Because this composites into the pixels and
// the exported JPEG carries no stroke data, what leaves the app has the
// underlying content genuinely destroyed.
//
// AND THE ORIGINAL GOES TOO. This used to say the opposite - that the untouched
// capture stayed in local storage under `originalBlobKey` so the person who drew
// the redaction could undo it, and that redaction was removed from what is
// exported rather than from the device. That was a real position, and it is the
// wrong one: a page whose unredacted source is one tap from being re-derived has
// not been redacted, it has been annotated, and the "redacted" badge on it was
// telling the truth about the export and a lie about the phone.
//
// So applying a redaction now destroys that page's original on the device, in
// the same action, behind a confirmation - js/documents.js's
// destroyPageOriginal, called from js/scanDoc.js's applyRedaction. Undo for a
// redaction exists right up to the moment that confirmation is accepted, and
// not one step past it.
//
// What is still true and worth keeping in mind: this composites into the pixels
// at rebuild time, so it is the burn that removes the content from the image.
// Destroying the original is what stops the content being rebuilt FROM
// somewhere else.
export function burnAnnotations(sourceCanvas, strokes) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0);
  renderAnnotations(ctx, strokes, canvas.width, canvas.height);
  return canvas;
}

export function hasRedaction(strokes) {
  return (strokes || []).some((s) => s.tool === TOOLS.REDACT && s.points?.length >= 2);
}

// Distance from a point to a stroke, used by the eraser. Returns the smallest
// distance to any segment, in normalized units.
function distanceToStroke(stroke, x, y) {
  const points = stroke.points;
  const n = points.length / 2;
  let best = Infinity;

  for (let i = 0; i < n - 1; i++) {
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const bx = points[(i + 1) * 2];
    const by = points[(i + 1) * 2 + 1];

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    // Project onto the segment, clamped to its ends.
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }

  if (n === 1) best = Math.hypot(x - points[0], y - points[1]);
  return best;
}

// Whole-stroke erase rather than pixel erase. Partial erasure would mean
// splitting a stroke's point list, which produces fragments that are hard to
// reason about and impossible to undo cleanly - and on a signature, "remove the
// mark I just made" is what people actually want.
export function eraseAt(strokes, x, y, radius = 0.02) {
  const survivors = [];
  let erased = 0;

  for (const stroke of strokes) {
    const threshold = radius + (stroke.width || 0.004) / 2;
    if (distanceToStroke(stroke, x, y) <= threshold) erased++;
    else survivors.push(stroke);
  }

  return { strokes: survivors, erased };
}

// Trims a signature to its own ink, so a signature captured on a large canvas
// can be placed at a sensible size on a page instead of arriving as mostly empty
// space. Returns null when there is nothing to trim.
export function boundsOf(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes || []) {
    const points = stroke.points || [];
    for (let i = 0; i < points.length; i += 2) {
      const halfWidth = (stroke.width || 0.004) / 2;
      minX = Math.min(minX, points[i] - halfWidth);
      maxX = Math.max(maxX, points[i] + halfWidth);
      minY = Math.min(minY, points[i + 1] - halfWidth);
      maxY = Math.max(maxY, points[i + 1] + halfWidth);
    }
  }

  if (!Number.isFinite(minX)) return null;
  return {
    x: Math.max(0, minX),
    y: Math.max(0, minY),
    width: Math.min(1, maxX) - Math.max(0, minX),
    height: Math.min(1, maxY) - Math.max(0, minY),
  };
}

// Re-maps strokes into a sub-rectangle of the page. Placing a saved signature
// is exactly this: take strokes normalized to their own capture area and
// normalize them to where they now sit on the page.
export function transformStrokes(strokes, { x, y, width, height }, sourceBounds = null) {
  const source = sourceBounds || boundsOf(strokes) || { x: 0, y: 0, width: 1, height: 1 };
  const scaleX = source.width > 0 ? width / source.width : 1;
  const scaleY = source.height > 0 ? height / source.height : 1;

  return strokes.map((stroke) => {
    const points = new Array(stroke.points.length);
    for (let i = 0; i < stroke.points.length; i += 2) {
      points[i] = x + (stroke.points[i] - source.x) * scaleX;
      points[i + 1] = y + (stroke.points[i + 1] - source.y) * scaleY;
    }
    return {
      ...stroke,
      id: `stroke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      // Width scales with the placement so a signature shrunk to a corner has
      // proportionally finer lines rather than the same heavy stroke.
      width: (stroke.width || 0.004) * Math.min(scaleX, scaleY),
      points,
    };
  });
}
