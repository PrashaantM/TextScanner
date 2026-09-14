// Unit tests for test/sizeVerdict.js - the per-word pass/fail decision behind
// test/replacement-size.js's P1/P2 property.
//
// WHY THIS FILE EXISTS. MIN_TIGHT_FIT and MAX_SPILL used to live inline in
// test/replacement-size.js's check(), which only ever ran end-to-end, in a
// real browser, against whatever font the machine happened to have. Nothing
// could tell whether that decision logic - or anything meant to replace it -
// behaved correctly on a staircase font without actually scanning a photo on
// Linux. That is exactly how it shipped red on CI: green on a Mac's variable
// font, and 53 failures three hours later on Liberation Sans, with nothing in
// between to have caught it sooner.
//
// test/sizeVerdict.js has no DOM dependency - `inkAt` is the only place
// measurement enters - so it is driven here under `node --test`, offline,
// against the same four synthetic staircase metrics test/unit/ink-fit.test.js
// uses for the solver itself (quantized, value-skipping, non-monotonic), and
// against the REAL solver's output for what size to check them at. If a
// future MIN_TIGHT_FIT-shaped constant is ever added back to sizeVerdict.js,
// this fails locally in milliseconds instead of on CI three hours later - see
// the file's own fail-then-pass proof, run manually and pasted into the
// commit message rather than kept in the suite, since deliberately
// reintroducing the deleted logic has no place in a passing test file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { largestFittingSize, INK_GRID_STEP_PX as GRID } from "../../js/inkFit.js";
import { evaluateProperty, wordVerdict } from "../sizeVerdict.js";

// The span test/replacement-size.js's PROPERTY_SPAN_PX uses. Duplicated as a
// literal rather than imported: replacement-size.js is a script, not a
// module - importing it would start its HTTP server and launch a browser as
// a side effect of `node --test` collecting this file.
const SPAN = 2;

// ---- the same four synthetic faces test/unit/ink-fit.test.js uses ----
// Duplicated rather than shared, to keep that already-verified file
// untouched. See its header for the measured faces these model.
const smooth = (px) => 0.72 * px;
const quantized = (px) => Math.round(0.72 * px);
const skipping = (px) => {
  const raw = 0.72 * px;
  return raw >= 24 ? 2 * Math.round(raw / 2) : Math.round(raw);
};
const nonMonotonic = (px) => {
  const base = Math.round(0.72 * px);
  const phase = px % 12;
  return phase >= 8 && phase < 10 ? base - 1 : base;
};
const FACES = { smooth, quantized, skipping, nonMonotonic };

const TARGETS = [];
for (let t = 2; t <= 80; t += 0.37) TARGETS.push(Number(t.toFixed(4)));

// ---- a correctly sized word passes, on every face ----
//
// "Correctly sized" means exactly what production does: the size comes from
// js/inkFit.js's own solver, not from independently recomputing what the
// right answer should be. This is the test MIN_TIGHT_FIT could never pass:
// it demanded a residual no staircase font can deliver. wordVerdict must not
// make the same demand.
for (const [name, face] of Object.entries(FACES)) {
  test(`wordVerdict: a correctly sized word produces zero violations on a ${name} face`, () => {
    for (const dimension of ["height", "width"]) {
      for (const target of TARGETS) {
        const fit = largestFittingSize(target, face, { minPx: GRID, maxPx: 200 });
        assert.ok(fit, `${name}/${dimension}/target=${target}: solver returned nothing`);
        if (!fit.fits) continue; // below the smallest renderable ink - a different case, see below
        const violations = wordVerdict({
          text: `${name}-${dimension}-${target}`,
          binding: dimension,
          chosenPx: fit.px,
          targetPx: target,
          inkAt: face,
          gridStep: GRID,
          spanPx: SPAN,
          requireProbedTread: true,
        });
        assert.deepEqual(
          violations,
          [],
          `${name}/${dimension}/target=${target}: correctly sized word was rejected: ${violations.join(" | ")}`
        );
      }
    }
  });
}

// ---- P1 actually fires: a size forced past the fitting boundary spills ----
test("wordVerdict: P1 fires when the chosen size is pushed past the fitting boundary", () => {
  const target = 20;
  const fit = largestFittingSize(target, quantized, { minPx: GRID, maxPx: 200 });
  // Several grid steps past the boundary, not one - so this cannot be a
  // same-tread false positive, only a genuine spill.
  const tooLarge = fit.px + GRID * 20;
  const violations = wordVerdict({
    text: "spiller",
    binding: "height",
    chosenPx: tooLarge,
    targetPx: target,
    inkAt: quantized,
    gridStep: GRID,
    spanPx: SPAN,
  });
  assert.ok(
    violations.some((v) => v.includes("P1 violated")),
    `expected a P1 violation, got: ${JSON.stringify(violations)}`
  );
});

// ---- P2 actually fires: this is the historic defect's shape ----
//
// The original bug this whole file exists for rendered replacements at 0.58x
// the correct size - nowhere near the fitting boundary, with plenty of
// headroom below it. This is that shape, reduced to the unit the pure
// function understands: a chosen size well under the one the solver would
// have picked.
test("wordVerdict: P2 fires when the chosen size leaves headroom - the historic 0.58x shape", () => {
  const target = 40;
  const correct = largestFittingSize(target, quantized, { minPx: GRID, maxPx: 200 });
  const historicallyUndersized = correct.px * 0.58;
  const violations = wordVerdict({
    text: "energy",
    binding: "height",
    chosenPx: historicallyUndersized,
    targetPx: target,
    inkAt: quantized,
    gridStep: GRID,
    spanPx: SPAN,
  });
  assert.ok(
    violations.some((v) => v.includes("P2 violated")),
    `expected a P2 violation on a 0.58x-undersized word, got: ${JSON.stringify(violations)}`
  );
});

// ---- no binding means no size, and that is reported as its own failure ----
test("wordVerdict: a null binding is reported, not silently skipped", () => {
  const violations = wordVerdict({ text: "nope", binding: null, chosenPx: 10, targetPx: 10, inkAt: quantized, gridStep: GRID, spanPx: SPAN });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not be sized at all/);
});

// ---- (a): an unverifiable tread is a FAILURE when pinned, silent when not ----
//
// Constructed rather than found on the four faces above: none of them ever
// produces this today (checked - the solver always lands its chosen size at
// the exact edge of a tread, where the very next grid step already changes
// the ink, so an unverifiable tread does not arise from solver output on
// these faces). This tests the PIN itself: if a future face or a future word
// ever does produce one, requireProbedTread must not let it pass in silence,
// which is exactly the failure mode a summary-line suffix could not prevent.
test("wordVerdict: a tread wider than the search span is a failure only when requireProbedTread is set", () => {
  // Ink changes only once every ~10px of size - a per-em of 0.1, modelling the
  // "one or two character word, condensed face" case the width path can hit.
  // Placed mid-plateau, not at its edge, so 2px of headroom genuinely finds
  // no change in either direction.
  const veryFlat = (px) => Math.round(0.1 * px);
  const midPlateau = 100.5; // Math.round(0.1*100.5) = 10, flat well past +2px
  assert.equal(veryFlat(midPlateau), veryFlat(midPlateau + SPAN), "fixture is wrong: the plateau is not flat across the span");

  const pinned = wordVerdict({
    text: "ta",
    binding: "width",
    chosenPx: midPlateau,
    targetPx: 10,
    inkAt: veryFlat,
    gridStep: GRID,
    spanPx: SPAN,
    requireProbedTread: true,
  });
  assert.ok(
    pinned.some((v) => v.includes("P2 could not be verified")),
    `expected the unverified-tread violation, got: ${JSON.stringify(pinned)}`
  );

  const unpinned = wordVerdict({
    text: "ta",
    binding: "width",
    chosenPx: midPlateau,
    targetPx: 10,
    inkAt: veryFlat,
    gridStep: GRID,
    spanPx: SPAN,
    requireProbedTread: false,
  });
  assert.deepEqual(unpinned, [], "requireProbedTread:false must reproduce the old silent behaviour exactly");
});

// ---- the floor path checks the height fit, not the rendered size ----
test("wordVerdict: a floored word's P1/P2 run against the height fit, and its rendered size is checked separately", () => {
  const target = 30;
  const heightFit = largestFittingSize(target, quantized, { minPx: GRID, maxPx: 200 });
  const floorExpectedPx = heightFit.px * 0.5;

  // Rendered exactly where the floor rule says: no violation of any kind.
  const clean = wordVerdict({
    text: "floored",
    binding: "floor",
    chosenPx: heightFit.px,
    targetPx: target,
    inkAt: quantized,
    gridStep: GRID,
    spanPx: SPAN,
    renderedPx: floorExpectedPx,
    floorExpectedPx,
    readbackSlackPx: 0.01,
  });
  assert.deepEqual(clean, []);

  // Rendered somewhere else entirely: the floor-selection check fires, and it
  // is the ONLY thing that fires - P1/P2 above were satisfied by the height
  // fit, which is unrelated to where the browser is actually rendering.
  const drifted = wordVerdict({
    text: "floored",
    binding: "floor",
    chosenPx: heightFit.px,
    targetPx: target,
    inkAt: quantized,
    gridStep: GRID,
    spanPx: SPAN,
    renderedPx: floorExpectedPx + 5,
    floorExpectedPx,
    readbackSlackPx: 0.01,
  });
  assert.equal(drifted.length, 1);
  assert.match(drifted[0], /floor rule selects/);
});

// ---- the readback-drift check is exact about what it guards ----
test("wordVerdict: readback drift is reported past slack and ignored within it", () => {
  // A genuinely correctly-sized word first, from the real solver - so P1/P2
  // are both clean and the only thing being isolated is the drift check.
  const target = 30;
  const fit = largestFittingSize(target, smooth, { minPx: GRID, maxPx: 200 });
  const base = { text: "x", binding: "height", chosenPx: fit.px, targetPx: target, inkAt: smooth, gridStep: GRID, spanPx: SPAN, renderedPx: fit.px };
  const within = wordVerdict({ ...base, readbackDriftPx: 0.005, readbackSlackPx: 0.01 });
  assert.deepEqual(within, []);
  const past = wordVerdict({ ...base, readbackDriftPx: 0.02, readbackSlackPx: 0.01 });
  assert.equal(past.length, 1);
  assert.match(past[0], /off the grid the solver chooses from/);
});

// ---- evaluateProperty's non-monotonic handling, isolated from wordVerdict ----
test("evaluateProperty: headroom requires MORE ink, not merely different ink", () => {
  // A face that DROPS just above the chosen point. A naive "next size whose
  // ink differs" check would call that headroom; it is not - moving there
  // makes the word smaller.
  const dip = (px) => (px > 10 && px < 10 + SPAN ? 5 : 6);
  const result = evaluateProperty({ chosenPx: 10, targetPx: 8, inkAt: dip, gridStep: GRID, spanPx: SPAN });
  assert.equal(result.headroom, false, "a drop in ink must not be reported as headroom");
});
