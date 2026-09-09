// mlkit-geometry.test.js: the coordinate contract for the native (ML Kit)
// recognition path.
//
// Nothing anywhere in this repo used to assert that ML Kit's coordinate space
// matches the space js/editorObjects.js's renderImageFormatView renders into.
// That missing assertion is why the Image format positioning bug stayed open as
// long as it did: the only way to judge it was to look at a device screenshot
// and decide whether it seemed right.
//
// The contract, read off renderImageFormatView directly, is:
//
//   every word bbox is in ORIGINAL-IMAGE PIXEL SPACE, bounded by
//   naturalWidth x naturalHeight
//
// because that function's only use of the numbers is `x0 / naturalWidth * 100`
// and its three siblings. A box in any other space produces a percentage that
// is meaningless, and a box outside those bounds produces a percentage outside
// 0-100, which is a word rendered off the image.
//
// Fixtures come from test/make-mlkit-fixture.js, which knows where every word
// belongs to the pixel - so a wrong coordinate fails as a number here rather
// than as an opinion on a screenshot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { flattenBlocks, quadGeometry } from "../../js/mlkitEngine.js";
import { FIXTURES, DEGENERATE_BLOCKS, elementFromPlacement } from "../make-mlkit-fixture.js";

// Generous next to the 1e-13 these actually land at, tight enough that a real
// coordinate error cannot hide underneath it.
const EPS = 1e-6;
const close = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${what}: expected ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`
  );

const flatGroundTruth = (fixture) => fixture.groundTruth.lines.flat();

// ---- The contract itself ----

test("every fixture's words land inside naturalWidth x naturalHeight", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const words = flattenBlocks(fixture.rawResult.blocks);
    assert.ok(words.length > 0, `${name}: produced no words at all`);
    for (const w of words) {
      const { x0, y0, x1, y1 } = w.bbox;
      assert.ok(
        x0 >= 0 && y0 >= 0 && x1 <= fixture.naturalWidth && y1 <= fixture.naturalHeight,
        `${name}/"${w.text}": bbox ${JSON.stringify(w.bbox)} escapes ${fixture.naturalWidth}x${fixture.naturalHeight}`
      );
      assert.ok(x1 >= x0 && y1 >= y0, `${name}/"${w.text}": bbox is inside-out`);
    }
  }
});

test("no fixture produces a NaN or infinite coordinate", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    for (const w of flattenBlocks(fixture.rawResult.blocks)) {
      for (const [key, value] of Object.entries(w.bbox)) {
        assert.ok(Number.isFinite(value), `${name}/"${w.text}": bbox.${key} is ${value}`);
      }
      if (w.frame) {
        for (const [key, value] of Object.entries(w.frame)) {
          assert.ok(Number.isFinite(value), `${name}/"${w.text}": frame.${key} is ${value}`);
        }
      }
    }
  }
});

// ---- The frame recovers the ground truth exactly ----

test("flattenBlocks recovers each word's true placement from its quad", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const words = flattenBlocks(fixture.rawResult.blocks);
    const truth = flatGroundTruth(fixture);
    assert.equal(words.length, truth.length, `${name}: word count`);

    words.forEach((w, i) => {
      const t = truth[i];
      assert.equal(w.text, t.text, `${name}: word ${i} text`);
      assert.ok(w.frame, `${name}/"${w.text}": no frame recovered from a well-formed quad`);
      close(w.frame.x, t.x, `${name}/"${w.text}" frame.x`);
      close(w.frame.y, t.y, `${name}/"${w.text}" frame.y`);
      close(w.frame.width, t.w, `${name}/"${w.text}" frame.width`);
      close(w.frame.height, t.h, `${name}/"${w.text}" frame.height`);
      close(w.frame.rotationDeg, t.rotationDeg, `${name}/"${w.text}" frame.rotationDeg`);
    });
  }
});

test("level text leaves the envelope and the frame identical", () => {
  const fixture = FIXTURES["axis-aligned"];
  for (const w of flattenBlocks(fixture.rawResult.blocks)) {
    close(w.bbox.x0, w.frame.x, `"${w.text}" x`);
    close(w.bbox.y0, w.frame.y, `"${w.text}" y`);
    close(w.bbox.x1 - w.bbox.x0, w.frame.width, `"${w.text}" width`);
    close(w.bbox.y1 - w.bbox.y0, w.frame.height, `"${w.text}" height`);
    assert.equal(w.rotationDeg, 0, `"${w.text}" should be reported level`);
  }
});

// ---- The root cause, pinned as arithmetic ----
//
// This is the test that explains the bug. renderImageFormatView derives a word's
// font size from its box height. Before the fix that height was the axis-aligned
// ENVELOPE height, which for a word of true size w x h tilted by t degrees is
//
//     h*cos(t) + w*sin(t)
//
// For a wide word that is dramatically larger than h, so the span rendered at a
// correspondingly inflated font size, anchored at a corner up and to the left of
// where the word actually starts. Neighbouring words then overlap each other -
// the "gibberish" reported on-device, on exactly the images whose text is
// tilted, while flat-on screenshots were reported as "really good".

test("the envelope height of tilted text inflates exactly as h*cos(t) + w*sin(t)", () => {
  for (const rotationDeg of [5, 10, 15, 25, 40]) {
    const placement = { text: "HEADLINE", x: 100, y: 100, w: 400, h: 60, rotationDeg };
    const el = elementFromPlacement(placement);
    const [word] = flattenBlocks([{ lines: [{ elements: [el] }] }]);

    const rad = (rotationDeg * Math.PI) / 180;
    const predicted = placement.h * Math.cos(rad) + placement.w * Math.sin(rad);
    const envelopeHeight = word.bbox.y1 - word.bbox.y0;

    close(envelopeHeight, predicted, `${rotationDeg}deg envelope height`);
    // The frame, which is what the renderer now uses, stays the true glyph height.
    close(word.frame.height, placement.h, `${rotationDeg}deg frame height`);
  }
});

test("the envelope would have inflated a 15-degree headline past 2x its font size", () => {
  const placement = { text: "HEADLINE", x: 100, y: 100, w: 400, h: 60, rotationDeg: 15 };
  const [word] = flattenBlocks([{ lines: [{ elements: [elementFromPlacement(placement)] }] }]);

  const envelopeHeight = word.bbox.y1 - word.bbox.y0;
  const inflation = envelopeHeight / word.frame.height;

  // ~2.42x. Asserted as a bound rather than a point value so this documents the
  // severity of the bug without becoming a brittle restatement of the formula
  // already pinned above.
  assert.ok(inflation > 2, `expected >2x inflation at 15 degrees, got ${inflation.toFixed(2)}x`);
  assert.ok(inflation < 3, `expected <3x inflation at 15 degrees, got ${inflation.toFixed(2)}x`);
});

test("the frame's origin is the word's own corner, not the envelope's", () => {
  // The second half of the misplacement, independent of the size inflation:
  // the envelope's top-left corner is not the word's top-left corner. Which way
  // it slips depends on the sign of the tilt, and both are asserted because
  // getting only one right is exactly how a coordinate bug survives a test.
  //
  // Rotating clockwise (positive, y-down) about the word's own top-left leaves
  // that corner the topmost point and pushes the envelope's left edge out by
  // h*sin(t). Rotating anticlockwise leaves the left edge alone and lifts the
  // envelope's top by w*sin(t) - much the larger error, since w >> h.
  const rad = (20 * Math.PI) / 180;

  const clockwise = { text: "TILTED", x: 500, y: 300, w: 400, h: 60, rotationDeg: 20 };
  const [cw] = flattenBlocks([{ lines: [{ elements: [elementFromPlacement(clockwise)] }] }]);
  close(cw.frame.x, 500, "clockwise frame.x");
  close(cw.frame.y, 300, "clockwise frame.y");
  close(cw.bbox.y0, 300, "clockwise envelope top stays at the word's own top");
  close(cw.bbox.x0, 500 - clockwise.h * Math.sin(rad), "clockwise envelope left");
  assert.ok(500 - cw.bbox.x0 > 10, "the clockwise origin gap should be substantial at 20 degrees");

  const anticlockwise = { ...clockwise, rotationDeg: -20 };
  const [acw] = flattenBlocks([{ lines: [{ elements: [elementFromPlacement(anticlockwise)] }] }]);
  close(acw.frame.x, 500, "anticlockwise frame.x");
  close(acw.frame.y, 300, "anticlockwise frame.y");
  close(acw.bbox.x0, 500, "anticlockwise envelope left stays at the word's own left");
  close(acw.bbox.y0, 300 - anticlockwise.w * Math.sin(rad), "anticlockwise envelope top");
  assert.ok(300 - acw.bbox.y0 > 100, "the anticlockwise origin gap should be large at 20 degrees");
});

// ---- Rotation reporting ----

test("negligible tilt is reported as level, meaningful tilt is preserved", () => {
  const at = (rotationDeg) => {
    const [w] = flattenBlocks([
      { lines: [{ elements: [elementFromPlacement({ text: "W", x: 10, y: 10, w: 100, h: 20, rotationDeg })] }] },
    ]);
    return w.rotationDeg;
  };

  assert.equal(at(0), 0, "0 degrees");
  assert.equal(at(0.2), 0, "0.2 degrees is below the meaningful-rotation floor");
  close(at(15), 15, "15 degrees");
  close(at(-15), -15, "-15 degrees");
});

// ---- Ordering and line assignment ----

test("lineIndex increments per line and words keep reading order", () => {
  const fixture = FIXTURES["dense-small-text"];
  const words = flattenBlocks(fixture.rawResult.blocks);

  assert.equal(words.length, 208, "208 words across 16 lines");
  assert.equal(words[0].lineIndex, 0);
  assert.equal(words.at(-1).lineIndex, 15);

  // Monotonic, gapless, and every line the same width.
  const perLine = new Map();
  let previous = 0;
  for (const w of words) {
    assert.ok(w.lineIndex === previous || w.lineIndex === previous + 1, `lineIndex jumped ${previous} -> ${w.lineIndex}`);
    previous = w.lineIndex;
    perLine.set(w.lineIndex, (perLine.get(w.lineIndex) || 0) + 1);
  }
  assert.equal(perLine.size, 16);
  for (const [line, count] of perLine) assert.equal(count, 13, `line ${line} word count`);

  // Reading order: within a line, words advance left to right.
  for (let i = 1; i < words.length; i++) {
    if (words[i].lineIndex !== words[i - 1].lineIndex) continue;
    assert.ok(words[i].bbox.x0 > words[i - 1].bbox.x0, `line ${words[i].lineIndex} is out of order at word ${i}`);
  }
});

// ---- Portrait / orientation-sensitive shapes ----
//
// The coordinate space handed to the renderer must be the post-orientation one.
// js/mlkitEngine.js now guarantees that by construction - it re-encodes the
// decoded image as an upright JPEG with no EXIF tag before ML Kit ever sees it,
// so ML Kit's input dimensions ARE naturalWidth x naturalHeight - and this
// asserts the consequence: a portrait image's words stay within portrait bounds
// rather than exceeding them in the transposed dimension.

test("portrait words do not overflow into the transposed dimension", () => {
  for (const name of ["portrait-orientation-6", "landscape-orientation-8"]) {
    const fixture = FIXTURES[name];
    const words = flattenBlocks(fixture.rawResult.blocks);
    const maxX = Math.max(...words.map((w) => w.bbox.x1));
    const maxY = Math.max(...words.map((w) => w.bbox.y1));

    assert.ok(maxX <= fixture.naturalWidth, `${name}: max x ${maxX} exceeds width ${fixture.naturalWidth}`);
    assert.ok(maxY <= fixture.naturalHeight, `${name}: max y ${maxY} exceeds height ${fixture.naturalHeight}`);
    // A transposed coordinate space is the specific failure this guards, and on
    // a 3024x4032 image it shows up as x values that only fit the other axis.
    assert.ok(maxX <= Math.max(fixture.naturalWidth, fixture.naturalHeight), `${name}: transposed x`);
  }
});

// ---- Degenerate input ----

test("every degenerate shape survives without throwing or emitting NaN", () => {
  for (const [name, blocks] of Object.entries(DEGENERATE_BLOCKS)) {
    let words;
    assert.doesNotThrow(() => {
      words = flattenBlocks(blocks);
    }, `${name} threw`);

    for (const w of words) {
      for (const [key, value] of Object.entries(w.bbox)) {
        assert.ok(Number.isFinite(value), `${name}/"${w.text}": bbox.${key} is ${value}`);
      }
      if (w.frame) {
        for (const [key, value] of Object.entries(w.frame)) {
          assert.ok(Number.isFinite(value), `${name}/"${w.text}": frame.${key} is ${value}`);
        }
      }
      assert.ok(Number.isFinite(w.rotationDeg ?? 0), `${name}/"${w.text}": rotationDeg is not finite`);
    }
  }
});

test("degenerate shapes resolve the way each one specifically should", () => {
  const only = (name) => flattenBlocks(DEGENERATE_BLOCKS[name]);

  // A zero-area quad has no usable baseline direction, so it keeps the envelope
  // and gets no frame - rather than a frame of width 0 the renderer would
  // divide by.
  const zero = only("zero-area");
  assert.equal(zero.length, 1);
  assert.equal(zero[0].frame, undefined, "a zero-area quad should not produce a frame");
  assert.deepEqual(zero[0].bbox, { x0: 100, y0: 100, x1: 100, y1: 100 });

  // Out-of-bounds boxes are reported as the engine gave them. Silently clamping
  // would move a word to a place nothing recognized it at, which is worse than
  // showing it where the engine actually claims it is.
  const outside = only("out-of-bounds");
  assert.equal(outside[0].bbox.x0, -50);
  assert.equal(outside[0].bbox.y1, 1900);

  // Empty lines consume no lineIndex and produce no words.
  assert.deepEqual(only("empty-elements"), []);

  // Missing or truncated corner points fall back to boundingBox.
  for (const name of ["no-corner-points", "short-corner-points"]) {
    const [word] = only(name);
    assert.ok(word, `${name}: the word was dropped instead of falling back`);
    assert.deepEqual(word.bbox, { x0: 10, y0: 20, x1: 110, y1: 60 }, `${name}: bbox`);
    assert.equal(word.frame, undefined, `${name}: should have no frame`);
  }

  // A quad with non-finite values is rejected wholesale rather than partially
  // trusted - this is the one shape that could put NaN into a CSS percentage.
  const [nanWord] = only("nan-corner-points");
  assert.deepEqual(nanWord.bbox, { x0: 10, y0: 20, x1: 110, y1: 60 });
  assert.equal(nanWord.frame, undefined);

  // No geometry at all: dropped, not guessed at.
  assert.deepEqual(only("no-geometry"), []);
});

test("blank and whitespace-only elements are dropped without consuming a lineIndex", () => {
  const words = flattenBlocks([
    {
      lines: [
        { elements: [{ text: "   ", boundingBox: { left: 0, top: 0, right: 10, bottom: 10 } }] },
        { elements: [{ text: "REAL", boundingBox: { left: 0, top: 20, right: 40, bottom: 40 } }] },
      ],
    },
  ]);

  assert.equal(words.length, 1);
  assert.equal(words[0].text, "REAL");
  assert.equal(words[0].lineIndex, 0, "the blank line must not have consumed index 0");
});

test("flattenBlocks tolerates missing blocks, lines and elements arrays", () => {
  assert.deepEqual(flattenBlocks(undefined), []);
  assert.deepEqual(flattenBlocks(null), []);
  assert.deepEqual(flattenBlocks([]), []);
  assert.deepEqual(flattenBlocks([{}]), []);
  assert.deepEqual(flattenBlocks([{ lines: [{}] }]), []);
});

// ---- quadGeometry in isolation ----

test("quadGeometry reads a known quad correctly", () => {
  // A 100x40 word at (10, 20), level.
  const level = quadGeometry([
    { x: 10, y: 20 },
    { x: 110, y: 20 },
    { x: 110, y: 60 },
    { x: 10, y: 60 },
  ]);
  assert.deepEqual(level, { x: 10, y: 20, width: 100, height: 40, rotationDeg: 0 });

  // The same word rotated 90 degrees clockwise about its top-left.
  const turned = quadGeometry([
    { x: 10, y: 20 },
    { x: 10, y: 120 },
    { x: -30, y: 120 },
    { x: -30, y: 20 },
  ]);
  close(turned.width, 100, "width");
  close(turned.height, 40, "height");
  close(turned.rotationDeg, 90, "rotationDeg");
});
