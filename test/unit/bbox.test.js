// Unit tests for js/ocrEngine.js's coordinate math (buildBboxMapper,
// transformBboxCorners). These map recognized word boxes from the rotated /
// upscaled image Tesseract actually saw back onto the original image the user
// is looking at. When they're wrong, every word renders in the wrong place and
// nothing throws - exactly the failure mode HANDOFF spent a session chasing on
// the ML Kit path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBboxMapper, transformBboxCorners } from "../../js/ocrEngine.js";

const closeBox = (actual, expected, tol = 1e-6) => {
  for (const k of ["x0", "y0", "x1", "y1"]) {
    assert.ok(
      Math.abs(actual[k] - expected[k]) < tol,
      `${k}: got ${actual[k]}, expected ${expected[k]}`
    );
  }
};

test("transformBboxCorners applies an identity transform unchanged", () => {
  const box = { x0: 10, y0: 20, x1: 30, y1: 40 };
  closeBox(transformBboxCorners(box, (x, y) => ({ x, y })), box);
});

test("transformBboxCorners translates a box", () => {
  const box = { x0: 10, y0: 20, x1: 30, y1: 40 };
  closeBox(transformBboxCorners(box, (x, y) => ({ x: x + 5, y: y - 3 })), {
    x0: 15,
    y0: 17,
    x1: 35,
    y1: 37,
  });
});

test("transformBboxCorners re-fits an axis-aligned box around a rotated one", () => {
  // A 90-degree rotation about the origin maps (x, y) -> (-y, x). The result is
  // still axis-aligned but with width and height swapped, and the function must
  // pick min/max rather than assume corner ordering survived.
  const box = { x0: 0, y0: 0, x1: 10, y1: 4 };
  closeBox(transformBboxCorners(box, (x, y) => ({ x: -y, y: x })), {
    x0: -4,
    y0: 0,
    x1: 0,
    y1: 10,
  });
});

test("transformBboxCorners grows the box for an off-axis rotation", () => {
  // 45 degrees about the origin: an axis-aligned box's bounding box must get
  // strictly larger. This is the ML-Kit-style inflation HANDOFF ruled out as a
  // cause there, and the behaviour is deliberate here.
  const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
  const a = Math.PI / 4;
  const out = transformBboxCorners(box, (x, y) => ({
    x: x * Math.cos(a) - y * Math.sin(a),
    y: x * Math.sin(a) + y * Math.cos(a),
  }));
  const diag = 10 * Math.SQRT2;
  assert.ok(Math.abs(out.x1 - out.x0 - diag) < 1e-6, "width should grow to the diagonal");
  assert.ok(Math.abs(out.y1 - out.y0 - diag) < 1e-6, "height should grow to the diagonal");
});

test("buildBboxMapper with no rotation and no scale is the identity", () => {
  const map = buildBboxMapper(100, 200, 0, 1);
  const box = { x0: 10, y0: 20, x1: 30, y1: 40 };
  closeBox(map(box), box);
});

test("buildBboxMapper undoes an upscale", () => {
  // Tesseract saw a 2x-upscaled image, so every returned coordinate is twice
  // what the original image uses.
  const map = buildBboxMapper(200, 400, 0, 2);
  closeBox(map({ x0: 20, y0: 40, x1: 60, y1: 80 }), { x0: 10, y0: 20, x1: 30, y1: 40 });
});

test("buildBboxMapper undoes rotateAuto around the image centre", () => {
  // Tesseract reports the angle it corrected FOR, so the mapper must rotate by
  // the negative of it. A box at the centre is a fixed point under any rotation
  // about that centre, which isolates the pivot from the angle.
  const map = buildBboxMapper(100, 100, Math.PI / 2, 1);
  closeBox(map({ x0: 45, y0: 45, x1: 55, y1: 55 }), { x0: 45, y0: 45, x1: 55, y1: 55 });
});

test("buildBboxMapper rotates an off-centre box to the expected quadrant", () => {
  // 100x100 image Tesseract auto-rotated by +90deg. Undoing it rotates by
  // -90deg about (50, 50), which simplifies to (x, y) -> (y, 100 - x).
  // So the box's corners (10,10)-(20,30) land at (10,90), (10,80), (30,80),
  // (30,90), and the re-fitted axis-aligned box is (10,80)-(30,90).
  const map = buildBboxMapper(100, 100, Math.PI / 2, 1);
  closeBox(map({ x0: 10, y0: 10, x1: 20, y1: 30 }), { x0: 10, y0: 80, x1: 30, y1: 90 });
});

test("buildBboxMapper composes rotation then scale, in that order", () => {
  // The scale divide must happen AFTER un-rotating around the (upscaled) image
  // centre. Swapping the order pivots around the wrong point and drifts every
  // box further from centre - the subtle version of the positioning bug.
  const map = buildBboxMapper(200, 200, Math.PI / 2, 2);
  // In upscaled space, undoing 90deg about (100,100) is (x, y) -> (y, 200 - x),
  // sending (20,20)-(40,60) to (20,160)-(60,180); dividing by 2 gives
  // (10,80)-(30,90). Dividing first would pivot around (100,100) in half-size
  // coordinates and land somewhere else entirely.
  closeBox(map({ x0: 20, y0: 20, x1: 40, y1: 60 }), { x0: 10, y0: 80, x1: 30, y1: 90 });
});

test("buildBboxMapper treats a missing rotateRadians as zero", () => {
  // Tesseract omits the field entirely when rotateAuto found nothing to correct.
  const box = { x0: 10, y0: 20, x1: 30, y1: 40 };
  closeBox(buildBboxMapper(100, 100, undefined, 1)(box), box);
  closeBox(buildBboxMapper(100, 100, null, 1)(box), box);
});

test("an off-axis rotation round trip preserves the centre but inflates the box", () => {
  // Deliberately NOT a clean round trip: re-fitting an axis-aligned box around
  // a rotated one is lossy, so rotating out and back grows the box rather than
  // restoring it. What must survive is the CENTRE - a word that inflates is
  // cosmetically loose, a word whose centre drifts is in the wrong place.
  const box = { x0: 12, y0: 34, x1: 56, y1: 78 };
  const out = buildBboxMapper(100, 100, -0.3, 1)(buildBboxMapper(100, 100, 0.3, 1)(box));

  const centre = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const before = centre(box);
  const after = centre(out);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `centre x drifted: ${after.x} vs ${before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `centre y drifted: ${after.y} vs ${before.y}`);

  assert.ok(out.x1 - out.x0 > box.x1 - box.x0, "width should inflate, not shrink");
  assert.ok(out.y1 - out.y0 > box.y1 - box.y0, "height should inflate, not shrink");
  assert.ok(out.x0 <= box.x0 && out.x1 >= box.x1, "should fully contain the original box");
  assert.ok(out.y0 <= box.y0 && out.y1 >= box.y1, "should fully contain the original box");
});
