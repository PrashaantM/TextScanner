// make-mlkit-fixture.js: builds ML-Kit-shaped recognition results with known,
// exact ground truth, so the native path's coordinate handling can be asserted
// analytically instead of eyeballed.
//
// This replaces the device-dump workflow (js/mlkitDebug.js + test/replay-dump.js,
// both deleted) that the positioning bug spent months blocked behind. A device
// dump has no ground truth: you can only look at the replay and judge whether it
// "looks right", which is precisely the ambiguity that kept the bug open. A
// synthetic fixture knows where every word belongs to the pixel, so a wrong
// coordinate is a failing number rather than an opinion.
//
// The emitted shape matches what @capacitor-mlkit/text-recognition's
// processImage resolves with - blocks > lines > elements, each carrying BOTH
// geometries ML Kit reports:
//
//   boundingBox  { left, top, right, bottom }   axis-aligned envelope
//   cornerPoints [ {x,y} x4 ]                   the quad, top-left then clockwise
//
// and those two are generated independently from the same placement, exactly as
// ML Kit derives them: the quad follows the text baseline, the bounding box is
// the axis-aligned envelope drawn around that quad. For level text they
// coincide. For tilted text they diverge, and the divergence is the whole point.
//
// Usage as a library (test/unit/mlkit-geometry.test.js):
//   import { makeFixture, FIXTURES } from "../make-mlkit-fixture.js";
//
// Usage as a CLI, to write the fixture corpus to disk:
//   node test/make-mlkit-fixture.js [outDir]     (default test/fixtures/mlkit/)

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const toRad = (deg) => (deg * Math.PI) / 180;

// Rotates (x, y) about (cx, cy) by `deg`, in a y-down image coordinate system -
// so a positive angle tilts clockwise on screen, matching CSS's rotate().
function rotateAbout(x, y, cx, cy, deg) {
  const rad = toRad(deg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// One placed word -> the element object ML Kit would report for it.
//
// The placement is the ground truth: (x, y) is where the word's top-left corner
// actually sits, w/h are its true baseline length and glyph height, and
// rotationDeg is its tilt about that top-left corner. Everything below is
// derived; nothing is hand-written, so the fixture cannot drift from its own
// ground truth.
export function elementFromPlacement({ text, x, y, w, h, rotationDeg = 0 }) {
  const corners = [
    [x, y], // top-left
    [x + w, y], // top-right
    [x + w, y + h], // bottom-right
    [x, y + h], // bottom-left
  ].map(([px, py]) => rotateAbout(px, py, x, y, rotationDeg));

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);

  return {
    text,
    cornerPoints: corners,
    boundingBox: {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    },
  };
}

// Groups placements into ML Kit's block > line > element hierarchy. Callers pass
// lines (arrays of placements); each line becomes one line, and every line goes
// into a single block unless `blocks` is given explicitly. Line and block
// geometry is the envelope of their children, which is what ML Kit reports and
// what a consumer walking the hierarchy would expect to find.
function envelopeOf(elements) {
  const xs = elements.flatMap((el) => [el.boundingBox.left, el.boundingBox.right]);
  const ys = elements.flatMap((el) => [el.boundingBox.top, el.boundingBox.bottom]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function cornersOfEnvelope(box) {
  return [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
}

// Builds a full dump-shaped fixture: { label, naturalWidth, naturalHeight,
// rawResult: { blocks, text }, groundTruth }.
//
// groundTruth is carried in the fixture itself rather than in a sidecar file, so
// a fixture can never be separated from the placements it was generated from.
export function makeFixture({ label, naturalWidth, naturalHeight, lines }) {
  const blockLines = lines.map((placements) => {
    const elements = placements.map(elementFromPlacement);
    const box = envelopeOf(elements);
    return {
      text: placements.map((p) => p.text).join(" "),
      elements,
      boundingBox: box,
      cornerPoints: cornersOfEnvelope(box),
    };
  });

  const blockBox = envelopeOf(blockLines);
  const text = blockLines.map((l) => l.text).join("\n");

  return {
    label,
    naturalWidth,
    naturalHeight,
    rawResult: {
      text,
      blocks: [
        {
          text,
          lines: blockLines,
          boundingBox: blockBox,
          cornerPoints: cornersOfEnvelope(blockBox),
        },
      ],
    },
    groundTruth: {
      lines: lines.map((placements) => placements.map((p) => ({ ...p, rotationDeg: p.rotationDeg || 0 }))),
    },
  };
}

// A row of words laid out left to right on one baseline, all at the same tilt.
// Tilt is applied per word about that word's own top-left, which is how ML Kit
// reports a tilted line: each element's quad follows the same angle, and the
// row's start points step along the rotated baseline.
function row({ text, x, y, wordWidth, height, gap = 12, rotationDeg = 0 }) {
  const words = text.split(" ");
  return words.map((word, i) => {
    const along = i * (wordWidth + gap);
    const start = rotateAbout(x + along, y, x, y, rotationDeg);
    return { text: word, x: start.x, y: start.y, w: wordWidth, h: height, rotationDeg };
  });
}

// The fixture corpus. Each entry covers one case from the hardening plan's
// Phase 1.2, and every one of them is asserted in
// test/unit/mlkit-geometry.test.js.
export const FIXTURES = {
  // Level text. Envelope and quad must agree exactly - this is the case that
  // has always worked, and it is here to prove the fix changes nothing about it.
  "axis-aligned": makeFixture({
    label: "axis-aligned",
    naturalWidth: 1200,
    naturalHeight: 800,
    lines: [
      row({ text: "THE QUICK BROWN FOX", x: 100, y: 120, wordWidth: 200, height: 60 }),
      row({ text: "JUMPS OVER THE DOG", x: 100, y: 260, wordWidth: 200, height: 60 }),
    ],
  }),

  // 15 degrees. The angle at which a 400px word's envelope is already ~1.7x its
  // true height - visibly wrong on screen, and the regime the "gibberish"
  // posters sit in.
  "rotated-15": makeFixture({
    label: "rotated-15",
    naturalWidth: 1600,
    naturalHeight: 1200,
    lines: [
      row({ text: "ANGLED POSTER HEADLINE", x: 120, y: 200, wordWidth: 400, height: 90, rotationDeg: 15 }),
    ],
  }),

  // 40 degrees. Steep enough that the envelope's height exceeds its own width
  // for a wide word, which is the extreme end of the same failure.
  "rotated-40": makeFixture({
    label: "rotated-40",
    naturalWidth: 1600,
    naturalHeight: 1600,
    lines: [
      row({ text: "STEEPLY TILTED SIGN", x: 200, y: 200, wordWidth: 300, height: 80, rotationDeg: 40 }),
    ],
  }),

  // Portrait, matching the decoded size of an orientation-6 phone photo
  // (test/images/exif-orientations/orientation-6.jpg is the 200x400 stored
  // buffer of a 400x200 upright image). Asserts the coordinate space the
  // renderer is handed is the post-orientation one.
  "portrait-orientation-6": makeFixture({
    label: "portrait-orientation-6",
    naturalWidth: 3024,
    naturalHeight: 4032,
    lines: [
      row({ text: "PORTRAIT PHONE PHOTO", x: 240, y: 500, wordWidth: 700, height: 140 }),
      row({ text: "SECOND LINE OF TEXT", x: 240, y: 900, wordWidth: 600, height: 140, rotationDeg: 3 }),
    ],
  }),

  // Landscape counterpart, orientation 8.
  "landscape-orientation-8": makeFixture({
    label: "landscape-orientation-8",
    naturalWidth: 4032,
    naturalHeight: 3024,
    lines: [row({ text: "LANDSCAPE PHONE PHOTO", x: 300, y: 400, wordWidth: 800, height: 150 })],
  }),

  // 208 words across 16 lines, for the ordering and lineIndex-assignment path.
  "dense-small-text": makeFixture({
    label: "dense-small-text",
    naturalWidth: 1600,
    naturalHeight: 2000,
    lines: Array.from({ length: 16 }, (_, lineNo) =>
      row({
        text: Array.from({ length: 13 }, (_, i) => `w${lineNo}x${i}`).join(" "),
        x: 60,
        y: 80 + lineNo * 110,
        wordWidth: 90,
        height: 34,
      })
    ),
  }),
};

// Degenerate inputs, which are deliberately NOT built through makeFixture -
// the point of each is a malformation makeFixture would never produce. Every
// one must be survivable: no throw, no NaN coordinate, no word placed nowhere.
export const DEGENERATE_BLOCKS = {
  // Zero-area element: ML Kit does occasionally emit these.
  "zero-area": [
    {
      lines: [
        {
          elements: [
            {
              text: "ZERO",
              boundingBox: { left: 100, top: 100, right: 100, bottom: 100 },
              cornerPoints: [
                { x: 100, y: 100 },
                { x: 100, y: 100 },
                { x: 100, y: 100 },
                { x: 100, y: 100 },
              ],
            },
          ],
        },
      ],
    },
  ],

  // Extends past the image bounds. Must survive; must not be silently clamped
  // into a different place than the engine reported.
  "out-of-bounds": [
    {
      lines: [
        {
          elements: [
            {
              text: "OUTSIDE",
              boundingBox: { left: -50, top: -30, right: 2400, bottom: 1900 },
              cornerPoints: [
                { x: -50, y: -30 },
                { x: 2400, y: -30 },
                { x: 2400, y: 1900 },
                { x: -50, y: 1900 },
              ],
            },
          ],
        },
      ],
    },
  ],

  // A line with no elements at all, which must not consume a lineIndex.
  "empty-elements": [{ lines: [{ elements: [] }, { elements: [] }] }],

  // cornerPoints absent entirely - the shape an older plugin version returns.
  // Must fall back to boundingBox rather than dropping the word.
  "no-corner-points": [
    {
      lines: [
        {
          elements: [{ text: "NOQUAD", boundingBox: { left: 10, top: 20, right: 110, bottom: 60 } }],
        },
      ],
    },
  ],

  // A truncated quad. Same requirement: fall back, don't produce NaN.
  "short-corner-points": [
    {
      lines: [
        {
          elements: [
            {
              text: "TRUNCATED",
              boundingBox: { left: 10, top: 20, right: 110, bottom: 60 },
              cornerPoints: [
                { x: 10, y: 20 },
                { x: 110, y: 20 },
              ],
            },
          ],
        },
      ],
    },
  ],

  // A quad carrying non-finite values, which is the one shape that would put a
  // NaN into a CSS percentage and place a word nowhere at all.
  "nan-corner-points": [
    {
      lines: [
        {
          elements: [
            {
              text: "NANQUAD",
              boundingBox: { left: 10, top: 20, right: 110, bottom: 60 },
              cornerPoints: [
                { x: NaN, y: 20 },
                { x: 110, y: null },
                { x: 110, y: 60 },
                { x: 10, y: 60 },
              ],
            },
          ],
        },
      ],
    },
  ],

  // Neither geometry. There is nowhere to put this word; it must be dropped
  // rather than guessed at.
  "no-geometry": [{ lines: [{ elements: [{ text: "NOWHERE" }] }] }],
};

async function main() {
  const outDir = process.argv[2] || join(ROOT, "test/fixtures/mlkit");
  await mkdir(outDir, { recursive: true });
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    await writeFile(join(outDir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  }
  const total = Object.values(FIXTURES).reduce(
    (n, f) => n + f.rawResult.blocks[0].lines.reduce((m, l) => m + l.elements.length, 0),
    0
  );
  console.log(`Wrote ${Object.keys(FIXTURES).length} fixtures (${total} words) to ${outDir}`);
}

if (process.argv[1] && process.argv[1].endsWith("make-mlkit-fixture.js")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
