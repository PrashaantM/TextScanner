// Unit tests for js/perspective.js's quad math: detectKeystoneQuad's
// gate-or-guess decision, and the homography solve/apply pair that
// warpPerspective (and, through unwarpPoint, every reprocessed word's bbox)
// is built on.
//
// detectKeystoneQuad's whole design contract is "when the signal isn't clear,
// do nothing" - a forced warp on straight text actively hurts recognition - so
// most of these tests assert on it correctly declining.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectKeystoneQuad, solveHomography, applyHomography } from "../../js/perspective.js";

// Builds `count` line bboxes stacked down a region, with line height
// interpolating linearly from `topHeight` to `bottomHeight` - i.e. the exact
// signature of text on a plane tilted away from the camera.
function taperedLines(count, regionHeight, topHeight, bottomHeight, width = 400) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const centre = t * regionHeight;
    const height = topHeight + (bottomHeight - topHeight) * t;
    lines.push({ x0: 0, x1: width, y0: centre - height / 2, y1: centre + height / 2 });
  }
  return lines;
}

test("detectKeystoneQuad declines with fewer than three lines", () => {
  assert.equal(detectKeystoneQuad(taperedLines(2, 300, 10, 40), 400, 300), null);
  assert.equal(detectKeystoneQuad([], 400, 300), null);
});

test("detectKeystoneQuad declines on uniform line heights (flat text)", () => {
  // No trend at all: R^2 is 0, and there is nothing to correct.
  assert.equal(detectKeystoneQuad(taperedLines(6, 300, 20, 20), 400, 300), null);
});

test("detectKeystoneQuad declines when the height change is too small to matter", () => {
  // A 5% taper is a real trend but below MIN_HEIGHT_RATIO_CHANGE - correcting
  // it would add a resampling pass for an imperceptible gain.
  assert.equal(detectKeystoneQuad(taperedLines(6, 300, 20, 21), 400, 300), null);
});

test("detectKeystoneQuad declines when line heights vary without a trend", () => {
  // Noisy detection, not perspective: R^2 falls below the bar.
  const lines = [
    { x0: 0, x1: 400, y0: 0, y1: 40 },
    { x0: 0, x1: 400, y0: 60, y1: 70 },
    { x0: 0, x1: 400, y0: 100, y1: 145 },
    { x0: 0, x1: 400, y0: 180, y1: 192 },
    { x0: 0, x1: 400, y0: 220, y1: 262 },
  ];
  assert.equal(detectKeystoneQuad(lines, 400, 300), null);
});

test("detectKeystoneQuad returns a quad tapered at the top when lines grow downward", () => {
  // Lines getting taller toward the bottom means the top is farther from the
  // camera, so the TOP edge is the one inset.
  const quad = detectKeystoneQuad(taperedLines(6, 300, 15, 40), 400, 300);
  assert.ok(quad, "expected a quad for a clear, strong taper");
  assert.equal(quad.length, 4);
  const [tl, tr, br, bl] = quad;
  assert.ok(tl.x > 0, "top-left should be inset");
  assert.ok(tr.x < 400, "top-right should be inset");
  assert.equal(bl.x, 0, "bottom-left should stay at the edge");
  assert.equal(br.x, 400, "bottom-right should stay at the edge");
  assert.equal(tl.y, 0);
  assert.equal(bl.y, 300);
});

test("detectKeystoneQuad taper direction flips when lines shrink downward", () => {
  const quad = detectKeystoneQuad(taperedLines(6, 300, 40, 15), 400, 300);
  assert.ok(quad, "expected a quad for a clear, strong taper");
  const [tl, tr, br, bl] = quad;
  assert.equal(tl.x, 0, "top-left should stay at the edge");
  assert.equal(tr.x, 400, "top-right should stay at the edge");
  assert.ok(bl.x > 0, "bottom-left should be inset");
  assert.ok(br.x < 400, "bottom-right should be inset");
});

test("detectKeystoneQuad caps the taper so an extreme trend can't collapse the quad", () => {
  // The inset is capped at 0.4 * width * 0.5 = 20% per side, so the top edge
  // keeps at least 60% of the region's width no matter how steep the trend.
  const quad = detectKeystoneQuad(taperedLines(8, 300, 2, 200), 400, 300);
  assert.ok(quad);
  const topWidth = quad[1].x - quad[0].x;
  assert.ok(topWidth >= 400 * 0.6 - 1e-9, `top edge collapsed to ${topWidth}`);
});

test("solveHomography recovers an identity map", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const h = solveHomography(square, square);
  assert.ok(h, "identity should be solvable");
  for (const p of [{ x: 3, y: 7 }, { x: 0, y: 0 }, { x: 10, y: 10 }]) {
    const out = applyHomography(h, p.x, p.y);
    assert.ok(Math.abs(out.x - p.x) < 1e-6 && Math.abs(out.y - p.y) < 1e-6, "identity should be a no-op");
  }
});

test("solveHomography maps each named corner onto its target", () => {
  // The property that actually matters: the four correspondences hold exactly.
  const from = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
  ];
  const to = [
    { x: 20, y: 5 },
    { x: 90, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
  ];
  const h = solveHomography(from, to);
  assert.ok(h);
  from.forEach((p, i) => {
    const out = applyHomography(h, p.x, p.y);
    assert.ok(
      Math.abs(out.x - to[i].x) < 1e-6 && Math.abs(out.y - to[i].y) < 1e-6,
      `corner ${i}: got (${out.x}, ${out.y}), expected (${to[i].x}, ${to[i].y})`
    );
  });
});

test("solveHomography inverts cleanly, so unwarpPoint round-trips", () => {
  // warpPerspective uses rect -> quad as unwarpPoint; recognized bboxes come
  // back through it, so a point pushed one way and pulled back the other has to
  // land where it started or every reprocessed word drifts.
  const rect = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const quad = [
    { x: 18, y: 0 },
    { x: 182, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const forward = solveHomography(rect, quad);
  const backward = solveHomography(quad, rect);
  assert.ok(forward && backward);
  for (const p of [{ x: 40, y: 30 }, { x: 150, y: 90 }, { x: 100, y: 60 }]) {
    const there = applyHomography(forward, p.x, p.y);
    const back = applyHomography(backward, there.x, there.y);
    assert.ok(
      Math.abs(back.x - p.x) < 1e-6 && Math.abs(back.y - p.y) < 1e-6,
      `round trip drifted: (${p.x}, ${p.y}) -> (${back.x}, ${back.y})`
    );
  }
});

test("solveHomography returns null for degenerate points instead of throwing", () => {
  // A quad collapsed to a line has no unique solution. warpPerspective checks
  // for null and skips the warp; it must never get NaNs it would happily
  // resample the whole crop with.
  const degenerate = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
  const rect = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(solveHomography(degenerate, rect), null);
});

test("solveHomography returns null when all four points coincide", () => {
  const same = [
    { x: 5, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: 5 },
  ];
  const rect = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(solveHomography(same, rect), null);
});
