// Unit tests for js/inkFit.js - the size solver behind every replacement word.
//
// WHY THESE ARE NOT BROWSER TESTS, WHICH IS THE WHOLE POINT. The previous
// version of this solver was verified only through test/replacement-size.js,
// in a real browser, against whatever faces the developer's Mac happened to
// have. Those faces were `.SF NS` and friends - a variable font whose ink moves
// almost continuously with size. The solver assumed exactly that, the browser
// gate could not see the assumption because it shared it, and the pair shipped
// RED on CI, where the font is Liberation Sans and the assumption is false.
//
// A browser gate can only test the faces the machine running it has installed.
// So the property is pinned here instead, against SYNTHETIC metrics that
// reproduce the awkward shapes directly and are available on every machine:
//
//   - `quantized`     ink grid-fit to whole pixels, as every hinted static
//                     face does. Monotone, but flat in long treads.
//   - `skipping`      the same, but where one ink value is never produced by
//                     ANY size - measured on Liberation Sans, where "Reviews"
//                     goes 24, 24, 26 as the size goes 33, 34, 34.5, and no
//                     size renders 25. This is the shape that makes a
//                     fixed-point solve oscillate forever.
//   - `nonMonotonic`  ink DECREASING as size increases, measured on DejaVu
//                     Sans (30, 30, 29, 29). This is the shape that makes a
//                     plain binary search over size unsafe.
//   - `smooth`        a continuous face, so the staircase handling is not
//                     allowed to regress the easy case.
//
// WHAT IS ASSERTED is the property, not a residual. "The rendered ink is within
// x% of the box" is a claim about a numerical model; on a staircase, most
// targets have NO size that satisfies it, at any x below the tread height. The
// claim about the app is optimality:
//
//   P1  the ink fits:    ink(chosen) <= target
//   P2  and is maximal:  no larger size in the verified span renders more ink
//                        that still fits
//
// Both are checked by brute force over the same grid the solver chooses from,
// so the test does not share an algorithm with the thing it is testing - only
// the definition.

import { test } from "node:test";
import assert from "node:assert/strict";
import { largestFittingSize, INK_GRID_STEP_PX } from "../../js/inkFit.js";

const MIN_PX = 1;
const MAX_PX = 120;
// Must match js/inkFit.js's VERIFY_SPAN_PX: P2 is a bounded claim and the
// brute-force check has to be bounded the same way or it is checking something
// the solver never promised.
const VERIFY_SPAN_PX = 2;

const gridUp = (px) => Math.ceil(px / INK_GRID_STEP_PX) * INK_GRID_STEP_PX;

// ---- the synthetic faces ----

// A face whose ink is a continuous function of size. `.SF NS` behaves close to
// this, and it is the only shape the old fixed-point solver could handle.
const smooth = (px) => 0.72 * px;

// A hinted static face: the browser grid-fits ink to whole pixels, so the ink
// is flat across a tread about 1/0.72 = 1.4px of size wide.
const quantized = (px) => Math.round(0.72 * px);

// Liberation Sans's actual shape: as well as being quantized, some ink values
// are never produced at all. Modelled by rounding to EVEN pixels above a
// threshold, so ink jumps 24 -> 26 with no size rendering 25 - exactly what was
// measured for "Reviews" at 33 / 34 / 34.5px.
const skipping = (px) => {
  const raw = 0.72 * px;
  return raw >= 24 ? 2 * Math.round(raw / 2) : Math.round(raw);
};

// DejaVu Sans's actual shape: ink goes DOWN as size goes up, over a window.
// Modelled as a 1px dip across a 2px-wide band of sizes, repeated so the test
// meets it at more than one place.
const nonMonotonic = (px) => {
  const base = Math.round(0.72 * px);
  const phase = px % 12;
  return phase >= 8 && phase < 10 ? base - 1 : base;
};

const FACES = { smooth, quantized, skipping, nonMonotonic };

// ---- brute force, which is what makes this a test and not a restatement ----

// Every grid size in [MIN_PX, MAX_PX], walked exhaustively.
function* grid(from = MIN_PX, to = MAX_PX) {
  for (let px = gridUp(from); px <= to + 1e-9; px += INK_GRID_STEP_PX) yield px;
}

// P1 and P2, checked against the metric directly.
function checkProperties(face, target, chosen, label) {
  assert.ok(chosen, `${label}: solver returned nothing`);
  const inkHere = face(chosen.px);
  assert.equal(chosen.ink, inkHere, `${label}: reported ink ${chosen.ink} but the metric says ${inkHere}`);

  const smallest = face(gridUp(MIN_PX));
  const anythingFits = smallest <= target;
  assert.equal(chosen.fits, inkHere <= target, `${label}: 'fits' disagrees with the metric`);

  if (anythingFits) {
    // P1
    assert.ok(
      inkHere <= target,
      `${label}: P1 violated - chose ${chosen.px}px rendering ${inkHere} ink, over the target ${target}. ` +
        `A replacement that spills is the failure this whole file exists to prevent.`
    );
    // P2, over exactly the span the solver promises.
    for (const px of grid(chosen.px + INK_GRID_STEP_PX, chosen.px + VERIFY_SPAN_PX)) {
      const v = face(px);
      assert.ok(
        !(v <= target && v > inkHere),
        `${label}: P2 violated - chose ${chosen.px}px rendering ${inkHere} ink, but ${px}px renders ` +
          `${v} ink, which also fits ${target} and is larger. The word is smaller than it could be.`
      );
    }
  } else {
    // Nothing fits: the smallest size is the least wrong answer, and the caller
    // has to be told rather than left to assume it fits.
    assert.equal(chosen.fits, false, `${label}: claimed to fit when nothing does`);
  }
}

// Targets chosen to land all over the treads - on them, between them, and on
// the values `skipping` never produces - rather than on round numbers that
// might happen to be reachable.
const TARGETS = [];
for (let t = 2; t <= 80; t += 0.37) TARGETS.push(Number(t.toFixed(4)));

for (const [name, face] of Object.entries(FACES)) {
  test(`largestFittingSize: P1 and P2 hold on a ${name} face, for every target`, () => {
    for (const target of TARGETS) {
      const chosen = largestFittingSize(target, face, { minPx: MIN_PX, maxPx: MAX_PX });
      checkProperties(face, target, chosen, `${name} target=${target}`);
    }
  });
}

test("a target no size can render exactly still returns a size that FITS", () => {
  // This is the regression the fixed-point solver could not survive. On
  // `skipping`, ink 25 is unreachable: the solve has nothing to converge to and
  // oscillates between the size that renders 24 and the one that renders 26.
  // The old code returned whichever iterate the pass cap happened to land on,
  // which could be the one rendering 26 - a word that SPILLS out of its box.
  const target = 25;
  const reachable = new Set();
  for (const px of grid()) reachable.add(skipping(px));
  assert.ok(!reachable.has(25), "the fixture is wrong: 25 ink is reachable, so this proves nothing");

  const chosen = largestFittingSize(target, skipping, { minPx: MIN_PX, maxPx: MAX_PX });
  assert.equal(chosen.ink, 24, `expected the largest reachable ink under 25, got ${chosen.ink}`);
  assert.ok(chosen.ink <= target, "returned a size that spills");
  checkProperties(skipping, target, chosen, "oscillation target=25");
});

test("a non-monotonic face does not trap the solver below a dip", () => {
  // DejaVu's shape: a larger size can render LESS ink. A plain binary search
  // stops at the first boundary it finds and never looks past the dip, so it
  // can leave the word a whole pixel smaller than it needs to be. The verify
  // scan is what covers this, and this asserts it actually does.
  let improvedSomewhere = false;
  for (const target of TARGETS) {
    const chosen = largestFittingSize(target, nonMonotonic, { minPx: MIN_PX, maxPx: MAX_PX });
    checkProperties(nonMonotonic, target, chosen, `nonMonotonic target=${target}`);
    // Did the verify pass ever have to reach past a dip to get here? It has if
    // some smaller size in the span below also fits but renders less ink.
    for (const px of grid(Math.max(MIN_PX, chosen.px - VERIFY_SPAN_PX), chosen.px - INK_GRID_STEP_PX)) {
      const v = nonMonotonic(px);
      if (v <= target && v < chosen.ink) improvedSomewhere = true;
    }
  }
  assert.ok(improvedSomewhere, "the fixture never exercised a dip, so this test proves nothing");
});

test("the smooth case still lands within one grid step of the target", () => {
  // The staircase handling must not regress the easy case: where ink IS a
  // continuous function of size, the answer is still the largest size that
  // fits, so the ink is short by at most what one grid step is worth.
  for (const target of TARGETS) {
    const chosen = largestFittingSize(target, smooth, { minPx: MIN_PX, maxPx: MAX_PX });
    const shortfall = target - chosen.ink;
    assert.ok(shortfall >= 0, `smooth target=${target}: spilled`);
    assert.ok(
      shortfall <= 0.72 * INK_GRID_STEP_PX + 1e-9,
      `smooth target=${target}: short by ${shortfall}, more than one grid step (${0.72 * INK_GRID_STEP_PX}) is worth`
    );
  }
});

test("the solve terminates, and in a bounded number of measurements", () => {
  // The old solver's pass cap existed because its iteration could run forever.
  // This one has no iteration to run away, but the verify scan does have a
  // cost, and a cost that grows with the size of the word would be a phone
  // freezing on a poster. Asserted rather than assumed.
  for (const [name, face] of Object.entries(FACES)) {
    for (const target of [3, 12, 25, 40, 80]) {
      const sizes = new Set();
      const counted = (px) => {
        sizes.add(px);
        return face(px);
      };
      const chosen = largestFittingSize(target, counted, { minPx: MIN_PX, maxPx: MAX_PX });
      assert.ok(chosen, `${name}/${target}: no answer`);
      // 40, not 1200. In Chromium each DISTINCT size costs ~228us because
      // assigning a new size to ctx.font is a font lookup; measureText once it
      // is set is free. The first version of this solver scanned the grid
      // exhaustively - ~1000 sizes a word, 228ms a word - and a 115-word photo
      // stopped responding. The budget is part of the contract, not a nicety.
      assert.ok(
        sizes.size <= 40,
        `${name}/${target}: measured ${sizes.size} distinct sizes; at ~228us each that is ${(sizes.size * 0.228).toFixed(0)}ms for one dimension of one word`
      );
      assert.equal(chosen.probes, sizes.size, `${name}/${target}: reported probe count disagrees with the metric calls`);
    }
  }
});

test("a target below the smallest renderable ink says so instead of pretending", () => {
  // An OCR box two pixels tall cannot be matched by any size: the smallest ink
  // the face renders is already bigger. The caller has to be able to tell that
  // apart from a successful fit, or it will report a spill as a size bug.
  const chosen = largestFittingSize(0.1, quantized, { minPx: MIN_PX, maxPx: MAX_PX });
  assert.equal(chosen.fits, false);
  assert.equal(chosen.px, gridUp(MIN_PX));
});

test("an unreadable metric returns null rather than a made-up size", () => {
  assert.equal(largestFittingSize(10, () => NaN, { minPx: MIN_PX, maxPx: MAX_PX }), null);
  assert.equal(largestFittingSize(0, smooth, { minPx: MIN_PX, maxPx: MAX_PX }), null);
});
