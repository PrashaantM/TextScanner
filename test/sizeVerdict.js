// sizeVerdict.js: the entire per-word pass/fail decision for
// test/replacement-size.js's P1/P2 property, pulled out to a pure function of
// a metric callback.
//
// WHY THIS EXISTS. MIN_TIGHT_FIT - the constant this file's logic replaced -
// used to live inline in test/replacement-size.js's check(), reachable only by
// scanning a real photo in a real browser. Nothing could exercise it, or
// anything that might replace it, except a full end-to-end run on whatever
// font the machine running it happened to have. That is exactly how it shipped
// red on CI: it looked fine on a Mac's variable font and failed three hours
// later on Liberation Sans, and there was no way to have found that out sooner
// because the decision logic had no existence apart from the browser run.
//
// wordVerdict below has no DOM dependency at all - `inkAt` is the only place
// measurement enters, and it is passed in. So test/unit/size-verdict.test.js
// can drive it under `node --test`, offline, against the same synthetic
// staircase metrics test/unit/ink-fit.test.js already uses for the solver
// (smooth, quantized, skipping, nonMonotonic), and answer "would this pass on
// Liberation Sans" before anything is pushed, not three hours after.

// Evaluates P1 (no spill) and P2 (no headroom) at one chosen size, for one
// dimension of one word, and returns the raw measurement rather than a
// verdict - wordVerdict below turns this into violations, and
// test/replacement-size.js's summary line reads it directly for the
// residual it prints as information.
//
// `inkAt(px)` is the metric: how much ink renders at that CSS-pixel size, in
// the dimension being checked. In the real gate it is canvas measureText,
// closed over a fixed font string; in the unit test it is one of the
// synthetic staircase functions.
//
// `chosenPx` is snapped to `gridStep` before probing - exactly, not with
// tolerance - because a size a few bits off the grid is a size the solver
// never chose, and probing it would test something the app doesn't do. The
// snap happens HERE rather than at every call site, which is how a previous
// version of this file let 0.0143px of getComputedStyle round-trip noise
// briefly report as 17 fake P2 violations - one call site remembered to snap
// and another didn't.
export function evaluateProperty({ chosenPx, targetPx, inkAt, gridStep, spanPx }) {
  const px = Math.round(chosenPx / gridStep) * gridStep;
  const ink = inkAt(px);
  let nextPx = null;
  let nextInk = null;
  for (let p = Math.ceil((px + 1e-9) / gridStep) * gridStep; p <= px + spanPx + 1e-9; p += gridStep) {
    const v = inkAt(p);
    if (v > ink + 1e-9) {
      nextPx = p;
      nextInk = v;
      break;
    }
  }
  return {
    px,
    ink,
    target: targetPx,
    spills: ink > targetPx,
    nextPx,
    nextInk,
    // Headroom means: a larger ink exists just above, and it would STILL have
    // fitted. That is the word being smaller than it needed to be. Looking for
    // MORE ink rather than merely DIFFERENT ink is deliberate: on a
    // non-monotonic face (DejaVu Sans: ink 30, 30, 29, 29 as size increases)
    // the next change can be ink going down, which fits but is smaller, and
    // reporting that as headroom would be backwards.
    headroom: nextPx !== null && nextInk <= targetPx,
    // True when nothing within the searched span rendered more ink at all -
    // meaning P2 was not actually verified, only assumed. See
    // requireProbedTread on wordVerdict for what that is allowed to mean.
    noLargerInkInSpan: nextPx === null,
  };
}

// The full verdict for one word: P1, P2, whether P2 could even be checked,
// the width-floor selection check, and the size-readback check - as a list of
// violation strings, empty when the word is fine.
//
// binding: "height" | "width" | "floor" | null (null when the word could not
//   be sized at all).
// chosenPx: the CSS-pixel size to check the property AT, for the dimension
//   that binds. For "height"/"width" this is simply the rendered size; for
//   "floor" it is NOT the rendered size - it is the height-matched size the
//   floor rule takes half of, because that is the size the property has to
//   hold for (see the floor note below).
// targetPx: the source box's target, in the SAME dimension, CSS pixels.
// inkAt(px): the metric for that dimension.
// gridStep, spanPx: see evaluateProperty.
// renderedPx: the size the browser is ACTUALLY using. Only consulted for the
//   floor-selection and readback-drift checks below; P1/P2 are evaluated at
//   `chosenPx`, which for "floor" deliberately differs from it.
// floorExpectedPx: only meaningful when binding is "floor" - the size the
//   floor rule selects (half of the height-matched size). Omit to skip the
//   floor-selection check (the unit test does this when it isn't exercising
//   the floor path).
// readbackDriftPx: |renderedPx rounded to the grid - renderedPx|, or omit to
//   skip the drift check (the unit test omits it for the same reason).
// readbackSlackPx: the tolerance for both drift-style checks above - the only
//   tolerance anywhere in this function, and it exists for float round-trip
//   noise, not for anything about the model. See test/replacement-size.js.
// requireProbedTread: when true, a word whose tread P2 could not verify
//   within `spanPx` is itself a violation, not silence. Off by default so the
//   unit test's synthetic fixtures - built with a generous span relative to
//   their tread width - don't have to reason about it unless they mean to.
export function wordVerdict({
  text,
  binding,
  chosenPx,
  targetPx,
  inkAt,
  gridStep,
  spanPx,
  renderedPx,
  floorExpectedPx,
  readbackDriftPx,
  readbackSlackPx = 0,
  requireProbedTread = false,
}) {
  const label = text !== undefined ? `"${text}"` : "(word)";
  if (!binding) {
    return [`${label}: could not be sized at all - inkFitPx returned nothing`];
  }

  const property = evaluateProperty({ chosenPx, targetPx, inkAt, gridStep, spanPx });
  const violations = [];
  const dim = binding === "floor" ? "height" : binding;
  const what = binding === "floor" ? "the height fit its floor is half of" : `the size it was fitted to (${binding})`;

  if (property.spills) {
    violations.push(
      `${label}: P1 violated - at ${property.px.toFixed(3)}px, ${what} renders ${property.ink.toFixed(2)}px of ` +
        `${dim} ink against a source box of ${property.target.toFixed(2)}px. A replacement must not spill out of ` +
        `the space it replaces, at any size, on any face.`
    );
  }
  if (property.headroom) {
    violations.push(
      `${label}: P2 violated - at ${property.px.toFixed(3)}px it renders ${property.ink.toFixed(2)}px of ${dim} ` +
        `ink, but ${property.nextPx.toFixed(3)}px renders ${property.nextInk.toFixed(2)}px, which ALSO fits the ` +
        `${property.target.toFixed(2)}px box. The word is smaller than it could be.`
    );
  }
  if (requireProbedTread && property.noLargerInkInSpan) {
    violations.push(
      `${label}: P2 could not be verified - no size within ${spanPx}px above ${property.px.toFixed(3)}px renders ` +
        `more ink, so this word's tread may be wider than the searched span and a spilling size just past it would ` +
        `go unseen`
    );
  }
  if (readbackDriftPx !== undefined && readbackDriftPx > readbackSlackPx) {
    violations.push(
      `${label}: the size the browser is using (${renderedPx.toFixed(4)}px) is ${readbackDriftPx.toFixed(4)}px off ` +
        `the grid the solver chooses from - the two have drifted apart, so every measurement here is of a size the ` +
        `app never picked`
    );
  }
  if (binding === "floor" && floorExpectedPx !== undefined) {
    const drift = Math.abs(renderedPx - floorExpectedPx);
    if (drift > readbackSlackPx) {
      violations.push(
        `${label}: sized by the width floor, but the browser is rendering it at ${renderedPx.toFixed(4)}px where ` +
          `the floor rule selects ${floorExpectedPx.toFixed(4)}px (half the height-matched size) - off by ` +
          `${drift.toFixed(4)}px`
      );
    }
  }
  return violations;
}
