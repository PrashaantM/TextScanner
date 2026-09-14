// inkFit.js: pick the font size a word renders at, when "how much ink a size
// renders" is a STAIRCASE rather than a curve.
//
// WHY THIS IS ITS OWN FILE, WITH NO IMPORTS. Everything here is a pure function
// of a metric callback. That is not tidiness: the previous version of this
// solver could only be exercised through a real browser against whatever faces
// the developer's machine happened to have, and it shipped RED on CI because of
// it. A DOM-free module can be driven from `node --test` against synthetic
// metrics that reproduce the awkward faces directly - see
// test/unit/ink-fit.test.js, which is the primary proof that this is correct
// and is deliberately not a browser test.
//
// ---- WHAT WENT WRONG BEFORE ----
//
// The previous fix measured a word's ink at the size it actually renders at,
// rather than once at a 100px reference. That diagnosis was right. What was
// wrong was the next step: solving for the size by fixed-point iteration,
// size := target / perEm(size), which assumes ink is a CONTINUOUS function of
// size.
//
// It is continuous on `.SF NS` - a variable font whose optical-size axis moves
// the outline smoothly - and on almost nothing else. Every hinted static face
// grid-fits ink to whole pixels. Same browser, "Reviews" in Liberation Sans,
// which is what CI actually resolves:
//
//     font-size  33     34     34.5   36     37.5   38
//     ink (px)   24     24     26     27     27     28
//     per em     0.727  0.706  0.754  0.750  0.720  0.737
//
// Per em swings 6.8% across five pixels of size, and no size at all renders 25.
// DejaVu Sans swings 9.06% and is NON-MONOTONIC - its ink goes 30, 30, 29, 29
// as the size INCREASES. FreeSans swings 6.59%.
//
// So for most targets there is no size that renders exactly the wanted ink. The
// fixed point had nothing to converge to; it oscillated, and the old code
// returned whichever iterate the pass cap happened to land on - which could be
// one that SPILLS. `.SF NS` is the edge case here, not the staircase, and
// developing against it is how that shipped.
//
// ---- WHAT IS SOLVED FOR INSTEAD ----
//
// Not "the size whose ink equals the target" - that size usually does not
// exist, so a residual tolerance is a claim about a numerical model rather than
// about the app. The property that is true on any face, and that a reader can
// actually perceive, is optimality:
//
//   P1  the ink FITS:     inkAt(chosen) <= targetInk
//   P2  and is MAXIMAL:   stepping up to the next size on the grid does not fit,
//                         and no size within VERIFY_SPAN_PX above renders MORE
//                         ink that still fits
//
// On a smooth face this collapses to "the residual is one grid step". On a
// staircase it stays true and stays checkable.
//
// P2 says "renders MORE INK that still fits" rather than the simpler "step up
// until the ink changes, and that size spills" because on a non-monotonic face
// the next change can be ink going DOWN. That size fits, but moving to it would
// make the word smaller. Ink, not nominal size, is what the reader sees.
//
// ---- WHY THE PROBE BUDGET IS PART OF THE CONTRACT ----
//
// The first attempt at this searched exhaustively over the grid. That is
// obviously correct and it made the app unusable: in Chromium, assigning a NEW
// size to `ctx.font` costs ~228us (measured - it is the font lookup, not the
// string parse; `measureText` once the font is set costs 0.2us, and re-assigning
// the SAME value costs 0.3us). At ~1000 sizes per word that is 228ms per word,
// and a 115-word photo stopped responding.
//
// So every probe here is counted and the algorithm is built around spending as
// few as possible: a Newton step to get close, a geometric bracket, a bisection
// to the grid, and a verify pass that walks TREADS rather than grid points -
// within a tread the ink is constant, so one probe answers for all of it, and
// the tread's far end is found by bisection. test/unit/ink-fit.test.js asserts
// the budget as well as the properties, because the budget is what broke.

// The grid of sizes this chooses from, in the caller's unit (CSS pixels for the
// browser caller). Every size handed back is a multiple of this and every
// measurement is taken at a multiple of this, so the sizes that CAN be measured
// and the sizes that CAN be chosen are the same set - they have to be, or a
// measurement answers a question about a size nobody renders.
//
// It sets the residual floor on a SMOOTH face: the chosen size is the largest
// grid point that fits, so the ink can be short by one step's worth, ~0.2% at
// 30px. On a staircase face the tread is an order of magnitude wider than this
// and the grid contributes nothing to the residual. Finer would buy nothing on
// the faces that matter and would cost probes in the bisection.
export const INK_GRID_STEP_PX = 1 / 16;

// How far above the chosen size P2 is verified, and so how far a non-monotonic
// face may dip back under the target before this stops looking. Sized against
// what it has to cross: ink is roughly 0.7 * size, so a 1px change of ink is
// about 1.4px of size, and a tread is about that wide AT ANY SIZE - treads do
// not widen as the text grows, because the ink grows with it. 2px therefore
// covers more than the one-pixel dip DejaVu actually shows.
const VERIFY_SPAN_PX = 2;

// Treads crossed by the verify walk before it gives up. Two is enough to cross
// the span above at any size; the cap exists so a pathological face cannot turn
// this into an unbounded walk.
const MAX_TREAD_WALKS = 2;

// Geometric bracket growth stops here. The Newton step lands within a few
// percent, so the bracket needs to cover a few percent; doubling from one grid
// step reaches 2px in six probes, which is past any tread.
const MAX_BRACKET_PROBES = 12;

const snapDown = (px, step) => Math.floor(px / step + 1e-9) * step;
const snapUp = (px, step) => Math.ceil(px / step - 1e-9) * step;

// The largest size on the grid whose rendered ink fits `targetInk`.
//
// `inkAt(px)` returns the ink rendered at that size, in the same unit as
// `targetInk`. It may be a staircase, it may be non-monotonic, and it is
// assumed only to be broadly increasing - enough for the bracket and bisection
// to land near a boundary. Nothing is assumed after that.
//
// Returns { px, ink, fits, probes } - the chosen size, the ink it renders,
// whether P1 actually holds, and how many DISTINCT sizes had to be measured -
// or null when the metric cannot be read at all, so the caller can fall back
// rather than render something arbitrary.
//
// `fits` is false only when nothing on the grid fits: a target below the
// smallest ink the face can render, which is what a two-pixel OCR box asks for.
// Some size still has to be chosen, so the smallest is returned and the caller
// is told, rather than left to read the overflow as a sizing bug.
export function largestFittingSize(targetInk, inkAt, options = {}) {
  const step = INK_GRID_STEP_PX;
  const minPx = Math.max(snapUp(options.minPx ?? step, step), step);
  const maxPx = snapDown(options.maxPx ?? 2048, step);
  if (!(targetInk > 0) || !(maxPx >= minPx)) return null;

  // One memo per solve. The browser caller has its own cache across words; this
  // one exists so the bracket, the bisection and the verify walk never pay for
  // the same size twice, and so `probes` counts distinct sizes - which is the
  // number that costs 228us each.
  const seen = new Map();
  const ink = (px) => {
    const key = snapDown(px, step);
    if (seen.has(key)) return seen.get(key);
    const raw = inkAt(key);
    const value = Number.isFinite(raw) ? raw : null;
    seen.set(key, value);
    return value;
  };
  const fits = (px) => {
    const v = ink(px);
    return v !== null && v <= targetInk;
  };
  const clampGrid = (px) => Math.min(Math.max(snapDown(px, step), minPx), maxPx);
  const done = (px) => ({ px, ink: ink(px), fits: fits(px), probes: seen.size });

  // ---- estimate: one probe, then one Newton step ----
  // This is exactly where the old solver stopped. It is a good ESTIMATE - ink is
  // broadly proportional to size - and a bad ANSWER, because "broadly" is doing
  // all the work and the staircase is in the gap.
  const seed = clampGrid(options.seedPx ?? 32);
  const seedInk = ink(seed);
  if (seedInk === null || !(seedInk > 0)) return null;
  let guess = clampGrid((targetInk * seed) / seedInk);

  // ---- bracket: grow geometrically until the answer is straddled ----
  let lo = null;
  let hi = null;
  if (fits(guess)) {
    lo = guess;
    let d = step;
    for (let i = 0; i < MAX_BRACKET_PROBES && lo + d <= maxPx; i++) {
      if (fits(lo + d)) {
        lo += d;
        d *= 2;
      } else {
        hi = lo + d;
        break;
      }
    }
    if (hi === null) return done(lo === maxPx ? maxPx : lo);
  } else {
    hi = guess;
    let d = step;
    for (let i = 0; i < MAX_BRACKET_PROBES && hi - d >= minPx; i++) {
      if (fits(hi - d)) {
        lo = hi - d;
        break;
      } else {
        hi -= d;
        d *= 2;
      }
    }
    if (lo === null) {
      // Either nothing fits at all, or the bracket ran out before reaching the
      // bottom. minPx settles which, and it is one probe.
      if (fits(minPx)) lo = minPx;
      else return { px: minPx, ink: ink(minPx), fits: false, probes: seen.size };
    }
  }

  // ---- bisect down to the grid ----
  while (hi - lo > step * 1.5) {
    const mid = snapDown(lo + (hi - lo) / 2, step);
    if (mid <= lo || mid >= hi) break;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }

  // `lo` fits and `lo + step` does not, so P2's first half already holds: the
  // very next size on the grid renders more ink than the box allows.
  let best = lo;
  let bestInk = ink(lo);

  // ---- verify: walk treads, not grid points ----
  // The only thing left that could beat `best` is a face that dips back under
  // the target further up - DejaVu going 30, 30, 29, 29. Walking grid point by
  // grid point would be exhaustive and unaffordable; walking treads is both,
  // because within a tread the ink does not change, so one probe answers for
  // the whole tread and its far end is a bisection away.
  const ceiling = Math.min(snapDown(best + VERIFY_SPAN_PX, step), maxPx);
  let cur = best;
  for (let walk = 0; walk < MAX_TREAD_WALKS && cur < ceiling; walk++) {
    const end = treadEnd(cur, ceiling, ink, step);
    if (end >= ceiling) break;
    cur = end + step;
    const v = ink(cur);
    if (v === null) break;
    if (v <= targetInk && v > bestInk) {
      // Take the top of this tread, not its first step, so that "the next size
      // whose ink differs" really is the next tread.
      best = treadEnd(cur, ceiling, ink, step);
      bestInk = ink(best);
    }
  }
  return { px: best, ink: bestInk, fits: bestInk <= targetInk, probes: seen.size };
}

// The largest size in [from, limit] that renders the same ink as `from`.
// Bisection rather than a scan: within a tread the ink is constant, so "same
// ink as `from`" is a prefix property of the tread and a bisection finds its
// end in log2(span / step) probes instead of span / step of them.
function treadEnd(from, limit, ink, step) {
  const here = ink(from);
  if (here === null || limit <= from) return from;
  if (ink(limit) === here) return limit;
  let a = from;
  let b = limit;
  while (b - a > step * 1.5) {
    const mid = snapDown(a + (b - a) / 2, step);
    if (mid <= a || mid >= b) break;
    if (ink(mid) === here) a = mid;
    else b = mid;
  }
  return a;
}
