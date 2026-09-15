// replacement-size.js: how big a replacement word renders, measured against the
// text it replaces, on real photographs rather than synthetic fixtures.
//
// WHY THIS EXISTS, AND WHY test/render-fidelity.js DID NOT CATCH IT. Retyping a
// word produced text visibly smaller than the word it stood in for. Measured
// from real pixels, every replacement rendered at 0.58x the height of the source
// word - 0.581 on complexPic1, 0.593 on complexPic5, 0.588 on complexPic2, a
// band far too tight to be anything but systematic. It was:
//
//     font-size    := bboxHeight * FONT_SIZE_CORRECTION      (0.8)
//     rendered ink := font-size * capHeightPerEm             (~0.72 here)
//                   = 0.576 * bboxHeight
//
// render-fidelity.js owned font size and was green throughout, because its
// assertion was `expectedFontPct = (t.h / naturalWidth) * 100 * 0.8` - the
// renderer's own line of code, restated. It could only ever confirm that the
// implementation still matched itself. That gate now asserts a property instead;
// this one exists because the property also has to hold on a real photo, where
// the word is a real word in a real face rather than a fixture's nominal box.
//
// WHAT IS ASSERTED, and what deliberately is not. A replacement is set in the
// app's font, not the photo's, and matching the photo's face is a font matcher
// that does not exist and is out of scope here. So "same size" cannot mean
// "identical ink" in general, and this does not pretend otherwise. It means:
//
//   - the replacement fills the box the original word occupied, tightly, in
//     whichever dimension binds first - it is as large as it can be; and
//   - it does not spill out of that box - so words never collide or run off the
//     image, which is what sizing purely to match HEIGHT produces on a poster
//     set in a condensed face (measured: correct 1.015x height, and 1.5x-1.8x
//     too wide, with neighbouring words overlapping).
//
// Both halves are load-bearing. Only the second is satisfied by rendering
// nothing; only the first by rendering something enormous.
//
// And it is asserted AFTER a retype as well as on first render, because the
// size has to be re-derived from the text that is actually there: "MEOW" is cap
// height, "energy" runs ascender to descender, "meow" is only x-height. One
// size chosen at scan time cannot be right for whatever the user types next.
//
// Usage: node test/replacement-size.js   (exits non-zero if anything regressed)

import { launchBrowser, BROWSER_NAME } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8133;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".wasm": "application/wasm", ".traineddata": "application/octet-stream", ".gz": "application/gzip", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  // Serves the forced-face override for the sweep below. It has to come from
  // the server rather than page.addStyleTag({content}), because index.html
  // ships a Content-Security-Policy of style-src 'self' and an inline <style>
  // is blocked outright - silently, from the test's point of view.
  if (req.url.startsWith("/__forced-face.css")) {
    const family = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("f") || "sans-serif");
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end(`:root, body, #image-format-view, .image-format-view, .image-format-word { font-family: "${family}", sans-serif !important; }`);
    return;
  }
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(ROOT, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
}).listen(PORT);

// MAX_SPILL (1.1) and MIN_TIGHT_FIT (0.94) used to sit here as a band around
// 1.0. Both are gone, and it is worth saying why out loud rather than quietly
// dropping two numbers, because "the assertion went red, so weaken it" is
// exactly the failure mode this whole file exists to prevent.
//
// Both were residual assertions wearing different names, on the same axis P1
// and P2 already cover, and by the time CI went red under Liberation Sans that
// was provable rather than argued: every one of the 53 CI failures was
// MIN_TIGHT_FIT, and not one was P1 or P2. On a staircase a 6% band is
// unachievable for small text - "you" in the CI log fills 0.810 of its box's
// height, which is one 1px tread short on a ~4px-tall word, 19% below the
// band - and MIN_TIGHT_FIT had no way to tell that apart from an actual sizing
// bug, because it does not know where the treads are. P1 and P2 do: P1 is
// strictly stricter than MAX_SPILL (P1 has no tolerance at all, MAX_SPILL
// allowed 10% over), and P1+P2 together pin the chosen size to the largest one
// that fits - a band only ever bounded it.
//
// Before deleting, the burden was discharged rather than argued: js/editorObjects.js
// was reverted, in a scratch copy, to the literal historic defect this file
// was first written to catch - fontSizePct := bboxHeight * FONT_SIZE_CORRECTION,
// unconditionally, the same 0.58x-height bug from the top of this file's
// header. Run against that defect with MIN_TIGHT_FIT and MAX_SPILL DISABLED,
// P1 and P2 alone produced 846 failures - every word, every phase, both
// P1-violated (the old formula ignores width entirely, so on complexPic1's
// condensed face it overshoots width by the same 1.5x-1.8x the header
// describes) and P2-violated (the chosen size is far below the largest that
// fits, so the very next grid step up still fits and is larger). Restoring
// the real solver and re-running clears every one of them. See the commit
// message for the invocation and the full counts.
//
// ---- The property, and why it is not a residual any more ----
//
// This used to assert that the binding dimension landed within 0.5% of the
// source box. That was wrong, and it was wrong in an instructive way: it is a
// claim about a NUMERICAL MODEL, not about the app. It assumes a size exists
// whose ink is within 0.5% of the target, which assumes ink is a continuous
// function of size. On `.SF NS` - a variable font, which is what a Mac resolves
// - that is nearly true. On every hinted static face it is false: the browser
// grid-fits ink to whole pixels, so for most targets NO size renders the wanted
// ink at all. Liberation Sans, which is what CI resolves, swings 6.8% per em
// across five pixels of size; a 1px step in ~25px of ink puts a ~4% floor under
// the achievable residual. The gate demanded 0.5%, the app could not deliver it
// on any Linux machine, and the pair shipped RED.
//
// The old absolute floor rule asked "is hFill under 0.55", which assumed a
// denominator the code does not use. The residual rule asked "is the error
// under 0.5%", which assumed a shape the font does not have. Replacing one
// wrong question with another is what happened once already; the fix is to
// assert something that is true on ANY face and that a reader can perceive:
//
//   P1  the rendered ink does NOT SPILL the source box in the binding dimension
//   P2  and there is NO HEADROOM: step the size up until the rendered ink
//       increases, and that size spills
//
// On a smooth face these collapse to the residual check this replaces. On a
// staircase they stay true and stay checkable, because they never mention a
// size that has to exist. The residual is still measured and still printed -
// it is useful information about how close the face lets us get - but nothing
// is gated on it.
//
// P2 looks for the next size whose ink INCREASES rather than the next size
// whose ink CHANGES, because a non-monotonic face (DejaVu Sans: ink 30, 30, 29,
// 29 as size increases) can change downward. That size fits, but moving to it
// would make the word smaller. Ink, not nominal size, is what the reader sees.
//
// P2 can only be VERIFIED within this span - if nothing above renders more
// ink within it, that is not proof there is no headroom further out, only
// that none was found. wordVerdict (test/sizeVerdict.js) treats that case as
// its own failure rather than silence, same discipline as
// test/region-coverage.js's ceilings: an unmeasured claim does not get to
// pass as a met one. It has not fired on any real word yet - checked, on
// every face this file resolves, including the forced sweep below - and the
// point of pinning it now is exactly that it hasn't: a short, condensed-face
// word on the WIDTH path can have per-em under 0.5, wide enough to plausibly
// exceed this span on a face nobody has tried yet.
const PROPERTY_SPAN_PX = 2;

// P1 and P2 are exact comparisons - no tolerance, because there is no model to
// be tolerant of. This is not a tolerance: the gate reads the used font-size
// back out through getComputedStyle, which round-trips through a float, so the
// size it measures at can differ from the size the app chose in the last bits.
// A hundredth of a CSS pixel is below anything a display can show.
const READBACK_SLACK_PX = 0.01;

// Measures every word's rendered ink against the source box it stands in, in
// source-image pixels. Ink, not the span's border box: the box carries
// line-height and padding, so comparing it to a glyph height means nothing.
//
// The pass/fail decision itself is NOT made here: it is delegated to
// wordVerdict, from test/sizeVerdict.js, which is pulled out to a pure
// function precisely so it has an existence apart from this browser run - see
// that file's header for why, and test/unit/size-verdict.test.js for where it
// is actually exercised offline.
const measureAll = (page) =>
  page.evaluate(async () => {
    // inkFitPx answers the one question this gate cannot answer from pixels:
    // whether the width floor is what chose a word's size. The floor is
    // RELATIVE - half of whatever the height-matched size came out at - and
    // this gate used to detect it with an ABSOLUTE threshold on rendered
    // height, "0.5 of the source box give or take 0.05". The two agree only
    // while the per-em metric is constant across a 2x change of size, which it
    // is not, so a word the app had floored exactly right was reported as a
    // spill failure. Asking the module is the fix; widening the 0.05 would only
    // have moved the disagreement to the next font.
    //
    // Note what is and is not being taken from the implementation here. The
    // DENOMINATORS stay this gate's own - originalBbox, what the OCR engine
    // reported - and every fill below is still measured from rendered pixels.
    // The only thing imported is the classification, which is not derivable
    // from the outside.
    const { inkFitPx, MIN_WIDTH_FIT_SCALE } = await import("/js/editorObjects.js");
    // The grid the solver chooses from. Imported as a DEFINITION - "which sizes
    // are reachable" - not as an algorithm: everything below re-measures from
    // pixels rather than asking the solver what it concluded.
    const { INK_GRID_STEP_PX: GRID } = await import("/js/inkFit.js");
    const { wordVerdict } = await import("/test/sizeVerdict.js");
    const { PROPERTY_SPAN, SLACK } = window.__gateConstants;
    const s = window.__state;
    const view = document.getElementById("image-format-view");
    // The CONTENT box, fractionally. `cqw` resolves against the container's
    // content box, so the border comes off - but clientWidth cannot be used to
    // get it, because clientWidth is an INTEGER and the real layout width is
    // not. At a 359px phone width that rounding is 0.14%, which is bigger than
    // the grid the app picks sizes on; a gate measuring on the integer would
    // bake that error into every number it prints and would disagree with the
    // app about which size is even being rendered.
    const viewStyle = getComputedStyle(view);
    const viewBorder = (parseFloat(viewStyle.borderLeftWidth) || 0) + (parseFloat(viewStyle.borderRightWidth) || 0);
    const viewPadding = (parseFloat(viewStyle.paddingLeft) || 0) + (parseFloat(viewStyle.paddingRight) || 0);
    const scale = (view.getBoundingClientRect().width - viewBorder - viewPadding) / s.lastNaturalWidth;
    const mctx = document.createElement("canvas").getContext("2d");
    const rows = [];
    for (const o of s.editorObjects) {
      // originalBbox, deliberately, and NOT the inkTarget* fields the renderer
      // keeps. Those are the implementation's own copy of this number, and a
      // gate that reads them is back to checking that the code agrees with
      // itself - which is exactly how the 0.8 constant survived in
      // render-fidelity.js. originalBbox is what the OCR engine reported: the
      // box the source word's ink actually occupies in the photo.
      if (o.type !== "word" || !o.originalBbox) continue;
      const srcH = o.originalBbox.y1 - o.originalBbox.y0;
      const srcW = o.originalBbox.x1 - o.originalBbox.x0;
      if (!(srcH > 0) || !(srcW > 0)) continue;
      const text = o.el.textContent;
      if (!text.trim()) continue;
      const cs = getComputedStyle(o.el);
      mctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = mctx.measureText(text);
      const inkH = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / scale;
      const inkW = m.width / scale;
      // Asked with the OCR box, not with the inkTarget* the renderer kept, so
      // the question goes in on this gate's numbers.
      const fit = inkFitPx(text, srcH, srcW, s.lastNaturalWidth);
      const binding = !fit ? null : fit.flooredByWidth ? "floor" : fit.widthFitPx !== null && fit.widthFitPx < fit.heightFitPx ? "width" : "height";

      // CSS pixels, not image pixels, because CSS pixels are the unit the
      // browser grid-fits ink in. Converting to image pixels first would divide
      // the staircase by a non-integer and blur the treads wordVerdict has to
      // see.
      const renderedPx = parseFloat(cs.fontSize);
      const inkAtSize = (px, dimension) => {
        mctx.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
        const q = mctx.measureText(text);
        return dimension === "height" ? q.actualBoundingBoxAscent + q.actualBoundingBoxDescent : q.width;
      };
      // How far a size drifts from the grid once rounded - the same round-trip
      // wordVerdict performs internally, computed here only so it can be
      // reported alongside `renderedPx` in the failure message.
      const driftPx = (px) => Math.abs(Math.round(px / GRID) * GRID - px);

      const row = {
        id: o.id,
        text,
        renderedPx,
        hFill: inkH / srcH,
        wFill: inkW / srcW,
        binding,
        floorScale: MIN_WIDTH_FIT_SCALE,
        fontSizeLocked: !!o.fontSizeLocked,
        violations: [],
      };
      if (o.fontSizeLocked) {
        // A word the user has resized by hand is carrying the size THEY chose,
        // not one this code derived, so P1/P2 say nothing about it. See
        // test/replacement-size.js's own hand-resize check further down.
        rows.push(row);
        continue;
      }
      if (binding === "height" || binding === "width") {
        const target = (binding === "height" ? srcH : srcW) * scale;
        row.violations = wordVerdict({
          text,
          binding,
          chosenPx: renderedPx,
          targetPx: target,
          inkAt: (px) => inkAtSize(px, binding),
          gridStep: GRID,
          spanPx: PROPERTY_SPAN,
          renderedPx,
          readbackDriftPx: driftPx(renderedPx),
          readbackSlackPx: SLACK,
          requireProbedTread: true,
        });
      } else if (binding === "floor") {
        // A floored word is exempt from spilling in WIDTH - that is the whole
        // point of the floor. What it is not exempt from is being anchored to a
        // real height fit: the floor is half the height-matched size, so that
        // height-matched size has to satisfy the property against the source
        // HEIGHT, and the size actually rendered has to be the one the floor
        // rule selects from it. Both are checked, and neither is a residual.
        const heightFitCssPx = fit.heightFitPx * scale;
        row.floorExpectedPx = fit.heightFitPx * MIN_WIDTH_FIT_SCALE * scale;
        row.violations = wordVerdict({
          text,
          binding,
          chosenPx: heightFitCssPx,
          targetPx: srcH * scale,
          inkAt: (px) => inkAtSize(px, "height"),
          gridStep: GRID,
          spanPx: PROPERTY_SPAN,
          renderedPx,
          floorExpectedPx: row.floorExpectedPx,
          readbackDriftPx: driftPx(heightFitCssPx),
          readbackSlackPx: SLACK,
          requireProbedTread: true,
        });
      } else {
        row.violations = wordVerdict({ text, binding: null });
      }
      rows.push(row);
    }
    return rows;
  });

// Measures the words buildResultCanvas() ACTUALLY draws - the surface Download
// and Save-as-note both flatten through - rather than the on-screen preview
// measureAll reads.
//
// This is a DIFFERENT surface, not a restatement of the same check. A word's
// fontSizePct is solved (and, since editorObjects.js's resize-refit, kept
// current) against editorContentWidth() - the on-screen container's width.
// buildResultCanvas draws at canvas.width = state.lastNaturalWidth, the
// photo's own resolution, an unrelated absolute pixel scale that is essentially
// never equal to the preview's. Ink-per-em is a staircase in ABSOLUTE size (see
// editorObjects.js's header), so a percentage solved to fit at one absolute
// scale is not thereby fit at another - the preview passing this gate proves
// nothing about the export, and measureAll never looks at the export canvas at
// all.
//
// CanvasRenderingContext2D.fillText is spied on for the one fact
// buildResultCanvas cannot be asked directly: which font-size string it
// actually used for a given word. That is a real-behaviour readback - the same
// role getComputedStyle(el).fontSize plays for measureAll - not a
// recomputation of the app's math: whatever formula chose the size, this reads
// back what actually got handed to the canvas and independently re-measures
// the ink it produces, at the size it was actually asked to render at.
const measureExportAll = (page) =>
  page.evaluate(async () => {
    const { buildResultCanvas } = await import("/js/editorExport.js");
    // MIN_WIDTH_FIT_SCALE only - the floor threshold, a constant this fix
    // doesn't touch. Not inkFitPx: that function's scale is the LIVE PREVIEW's
    // (editorContentWidth()/naturalWidth), and reusing a value computed at that
    // scale as though it applied at the export canvas's own scale (1) was tried
    // first and was wrong - it produced spurious P1/P2 failures on floored
    // words from nothing but the scale mismatch. largestFittingSize is scale-
    // free by construction (js/inkFit.js takes a metric callback and a target,
    // nothing else), so calling it directly, here, with a callback that
    // measures at the SAME absolute pixel sizes the export canvas actually
    // renders at, is what makes the classification correct rather than
    // borrowed from a different surface.
    const { MIN_WIDTH_FIT_SCALE } = await import("/js/editorObjects.js");
    const { largestFittingSize, INK_GRID_STEP_PX: GRID } = await import("/js/inkFit.js");
    const { wordVerdict } = await import("/test/sizeVerdict.js");
    const { PROPERTY_SPAN } = window.__gateConstants;
    const s = window.__state;

    const proto = CanvasRenderingContext2D.prototype;
    const originalFillText = proto.fillText;
    const draws = [];
    proto.fillText = function (text, x, y, ...rest) {
      draws.push({ text, font: this.font });
      return originalFillText.call(this, text, x, y, ...rest);
    };
    let canvas = null;
    try {
      canvas = buildResultCanvas();
    } finally {
      proto.fillText = originalFillText;
    }
    if (!canvas) return { rows: [], expectedCount: 0, drawnCount: 0 };

    // The exact predicate buildResultCanvas uses to decide which words it
    // draws, and in the exact order it iterates them in, so draws[i] lines up
    // with expected[i].
    const expected = s.editorObjects.filter((o) => {
      if (o.type !== "word") return false;
      if (s.activeMode === "full" && !o.modified && o.origin === "ocr") return false;
      return !!o.el.textContent;
    });

    const mctx = document.createElement("canvas").getContext("2d");
    const rows = [];
    for (let i = 0; i < expected.length; i++) {
      const o = expected[i];
      const draw = draws[i];
      if (!o.originalBbox || !draw || draw.text !== o.el.textContent) continue;
      const srcH = o.originalBbox.y1 - o.originalBbox.y0;
      const srcW = o.originalBbox.x1 - o.originalBbox.x0;
      if (!(srcH > 0) || !(srcW > 0)) continue;
      const text = o.el.textContent;

      // The size buildResultCanvas actually used, read back from the real
      // draw call - not recomputed. canvas.width is natural resolution, so
      // this is directly in source-image pixels, the same unit srcH/srcW are
      // in: no scale factor belongs anywhere in this file.
      const renderedPx = parseFloat(draw.font);
      mctx.font = draw.font;
      const m = mctx.measureText(text);
      const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      const inkW = m.width;

      const inkAtSize = (px, dimension) => {
        mctx.font = draw.font.replace(/^[\d.]+px/, `${px}px`);
        const q = mctx.measureText(text);
        return dimension === "height" ? q.actualBoundingBoxAscent + q.actualBoundingBoxDescent : q.width;
      };

      // The height- and width-matched sizes, searched independently at the
      // EXPORT's own scale (1: inkAtSize already measures in canvas/image
      // pixels), so binding classification and the floor's own P1/P2 check
      // below are self-consistent with what renderedPx was actually chosen
      // against - not a value transplanted from a different absolute scale.
      const heightFit = largestFittingSize(srcH, (px) => inkAtSize(px, "height"), { maxPx: 2048 });
      const widthFit = srcW ? largestFittingSize(srcW, (px) => inkAtSize(px, "width"), { maxPx: 2048 }) : null;
      const binding = !heightFit
        ? null
        : widthFit && widthFit.px < heightFit.px * MIN_WIDTH_FIT_SCALE
          ? "floor"
          : widthFit && widthFit.px < heightFit.px
            ? "width"
            : "height";

      const row = { id: o.id, text, renderedPx, hFill: inkH / srcH, wFill: inkW / srcW, binding, floorScale: MIN_WIDTH_FIT_SCALE, violations: [] };
      if (o.fontSizeLocked) {
        rows.push(row);
        continue;
      }
      if (binding === "height" || binding === "width") {
        const target = binding === "height" ? srcH : srcW;
        row.violations = wordVerdict({
          text,
          binding,
          chosenPx: renderedPx,
          targetPx: target,
          inkAt: (px) => inkAtSize(px, binding),
          gridStep: GRID,
          spanPx: PROPERTY_SPAN,
          renderedPx,
          requireProbedTread: true,
        });
      } else if (binding === "floor") {
        // A floored word is exempt from spilling in WIDTH by design (see
        // editorObjects.js's floor comment) - what still has to hold is
        // HEIGHT. Checked against renderedPx - the REAL rendered size - not a
        // freshly re-searched heightFit, and P2/floor-selection are not asked
        // at all here (spanPx: 0 with requireProbedTread left off, so neither
        // fires). Both were tried and both were wrong for the same reason:
        // this file's inkAtSize measures ink directly, while the app's own
        // inkMetricsPerEm reaches the same number through measure-then-
        // multiply-back-out "per em" arithmetic (see its header) - a
        // deliberately different path, close but not bit-identical. Right at a
        // tread boundary that's enough for the two independent searches this
        // file and the app each run to land on ADJACENT grid points, which
        // read as a P2/floor-selection failure even though nothing actually
        // spills. P1 against the real output sidesteps that: it asks whether
        // what was actually drawn fits, not whether a second computation
        // agrees digit-for-digit with a first one - which is exactly the
        // residual-vs-property distinction this file's own header describes.
        row.violations = wordVerdict({
          text,
          binding: "floor",
          chosenPx: renderedPx,
          targetPx: srcH,
          inkAt: (px) => inkAtSize(px, "height"),
          gridStep: GRID,
          spanPx: 0,
        });
      } else {
        row.violations = wordVerdict({ text, binding: null });
      }
      rows.push(row);
    }
    return { rows, expectedCount: expected.length, drawnCount: draws.length };
  });

// The gating decision is entirely wordVerdict's, computed in-browser by
// measureAll and carried on r.violations - see test/sizeVerdict.js. What is
// left here is aggregation: push every violation, and print the informational
// numbers (median fill, worst spill, the residual) that were never the gate,
// only ever a description of it.
function check(rows, label, failures) {
  if (!rows.length) {
    failures.push(`${label}: measured no words at all - the harness found nothing to assert on, which is a failure, not a pass`);
    return;
  }
  let worstSpill = 0;
  let worstSlack = 1;
  let worstResidual = 0;
  let flooredCount = 0;
  for (const r of rows) {
    const tight = Math.max(r.hFill, r.wFill);
    worstSlack = Math.min(worstSlack, tight);
    // A word the user has resized by hand is carrying the size THEY chose, not
    // one this code derived, so P1 and P2 say nothing about it. The assertion
    // that matters for those is further down: that a retype did not quietly
    // take the override back.
    if (r.fontSizeLocked) continue;
    for (const v of r.violations) failures.push(`${label}/${v}`);
    const flooredOut = r.binding === "floor";
    if (flooredOut) flooredCount++;
    else if (r.binding) worstSpill = Math.max(worstSpill, tight);
    if (!r.binding) continue;

    // Residual is INFORMATION, not a gate. How close a face lets the ink get to
    // the box is a property of the face's tread height, not of this code: on a
    // hinted face a 1px step in 25px of ink is a 4% floor nothing can beat.
    const bindingFill = r.binding === "height" ? r.hFill : r.binding === "width" ? r.wFill : r.hFill / r.floorScale;
    worstResidual = Math.max(worstResidual, Math.abs(bindingFill - 1));
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  console.log(
    `  ${label}: ${rows.length} words | median fill h=${med(rows.map((r) => r.hFill)).toFixed(3)} ` +
      `w=${med(rows.map((r) => r.wFill)).toFixed(3)} | worst spill ${worstSpill.toFixed(3)} | loosest fit ${worstSlack.toFixed(3)}` +
      ` | residual (INFO, not gated) <=${(worstResidual * 100).toFixed(2)}%` +
      (flooredCount ? ` | ${flooredCount} sized by the overflow floor` : "")
  );
}

// Liberation Sans, DejaVu Sans and FreeSans are the faces CI and most Android
// devices actually resolve, and all three grid-fit ink to whole pixels. Courier
// New and Georgia ship with macOS, so a developer gets some staircase coverage
// locally instead of only the variable font that hid this bug.
const FORCED_FACES = ["Liberation Sans", "DejaVu Sans", "FreeSans", "Courier New", "Georgia"];

// Which FACE the stack resolved to, as opposed to which stack was asked for.
// CDP only, so it is a chromium nicety rather than an assertion.
async function resolveFace(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".image-format-word" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((f) => f.familyName).join("+") || "";
  } catch {
    return "";
  }
}

const failures = [];
let resolvedFontReported = false;
const browser = await launchBrowser();

// complexPic1 is the poster set in a condensed hand-drawn face - the case
// where width binds and the font-matcher gap shows, and (since the condensed-
// source detector landed) the one
// image in the 11-image benchmark corpus detectCondensedSource actually
// fires on - see that function's header in js/editorObjects.js for the
// threshold and the evidence behind it. complexPic2 and complexPic5 are
// ordinary sans type, where height should land near 1.0 and the detector must
// NOT fire: the property this loop checks is unchanged by which image is being
// looked at, but these two exist here specifically to prove the condensed
// branch does not make a non-condensed image worse, which complexPic1 alone
// could never show.
for (const image of ["complexPic1.jpeg", "complexPic2.jpeg", "complexPic5.jpeg"]) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, "test/images/" + image));
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
  await page.click("#mode-full-btn");
  await page.evaluate(
    async (constants) => {
      const { state } = await import("/js/state.js");
      window.__state = state;
      window.__gateConstants = constants;
    },
    { PROPERTY_SPAN: PROPERTY_SPAN_PX, SLACK: READBACK_SLACK_PX }
  );
  await page.waitForTimeout(300);

  // Which FACE the stack resolved to, printed once. Every number this gate
  // prints is a measurement of that face, so a run whose numbers are compared
  // against another run's has to be able to tell whether it was even the same
  // font. -apple-system / Segoe UI / Roboto / sans-serif resolve to four
  // different faces with different ink per em, and the gate's own thresholds
  // were chosen against one of them. CDP only, so it is a chromium nicety
  // rather than an assertion - the gate does not fail for lack of it.
  if (!resolvedFontReported) {
    resolvedFontReported = true;
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".image-format-word" });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      console.log(`  [font] word spans render in: ${fonts.map((f) => `${f.familyName} (${f.postScriptName})`).join(", ") || "(none reported)"}`);
    } catch (e) {
      console.log(`  [font] could not read the resolved face on ${BROWSER_NAME}: ${e.message}`);
    }
  }

  // ---- As recognized ----
  const wideWidth = await page.evaluate(() => document.getElementById("image-format-view").clientWidth);
  const asScannedRows = await measureAll(page);
  check(asScannedRows, `${image} as-scanned`, failures);

  // ---- The condensed-source detector fired on the right image ----
  //
  // P1/P2 above already fail if the condensed font gets applied and produces
  // a bad fit, but say nothing about whether detectCondensedSource fired on
  // the RIGHT image. complexPic1 is the one condensed image in this gate's
  // own corpus (see that function's header in js/editorObjects.js); complexPic2
  // and complexPic5 are ordinary sans and must NOT get it. A future change to
  // the threshold that quietly starts firing on ordinary type would still
  // pass P1/P2 (the font swap is sized correctly either way) while silently
  // degrading images that never needed help - this is what actually catches
  // that, at the source, rather than hoping a fill number moves enough to notice.
  const gotCondensedClass = await page.evaluate(() =>
    document.getElementById("image-format-view").classList.contains("condensed-source")
  );
  const expectCondensed = image === "complexPic1.jpeg";
  if (gotCondensedClass !== expectCondensed) {
    failures.push(
      `${image}: condensed-source class is ${gotCondensedClass ? "present" : "absent"}, expected ` +
        `${expectCondensed ? "present - this is the one condensed image in the gate's corpus" : "absent - this is ordinary type"}`
    );
  }

  // ---- complexPic1's height fill actually improved, and stays improved ----
  //
  // Freshly measured before this feature existed (same image, same Docker
  // container, same Liberation Sans, same day): median height fill 0.552.
  // After: 0.705. 0.65 sits well above the old number and comfortably below
  // the new one, so a regression back toward the pre-detector behaviour - the
  // classifier silently stops firing, or fires but the stack it picks stops
  // helping - fails here rather than only showing up as a smaller number
  // nobody was watching.
  if (image === "complexPic1.jpeg") {
    const CONDENSED_FILL_FLOOR = 0.65;
    const hFills = asScannedRows.map((r) => r.hFill).sort((a, b) => a - b);
    const medianH = hFills[hFills.length >> 1];
    if (medianH < CONDENSED_FILL_FLOOR) {
      failures.push(
        `${image}: median height fill ${medianH.toFixed(3)} is below the condensed-source regression floor ${CONDENSED_FILL_FLOOR} ` +
          `(pre-detector baseline was 0.552) - the condensed-font branch may have stopped helping this image`
      );
    }
  }

  // ---- After retyping, through the real contenteditable spans ----
  // Replacements chosen to move the glyph mix around on purpose: all-caps (cap
  // height), a descender (runs below the baseline), and x-height-only. A size
  // frozen at scan time cannot be right for all three, which is the point.
  const REPLACEMENTS = ["MEOW", "energy", "meow"];
  const ids = await page.evaluate(
    () => window.__state.editorObjects.filter((o) => o.type === "word" && o.originalBbox && o.el.textContent.trim()).slice(0, 9).map((o) => o.id)
  );
  for (let i = 0; i < ids.length; i++) {
    const handle = await page.evaluateHandle((id) => {
      const el = window.__state.editorObjects.find((x) => x.id === id).el;
      el.scrollIntoView({ block: "center" });
      return el;
    }, ids[i]);
    await handle.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(REPLACEMENTS[i % REPLACEMENTS.length]);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(200);

  const retyped = (await measureAll(page)).filter((r) => ids.includes(r.id));
  if (retyped.length !== ids.length) {
    failures.push(`${image}: expected ${ids.length} retyped words back from the measurement, got ${retyped.length}`);
  }
  check(retyped, `${image} retyped`, failures);

  // ---- The export canvas, not the preview - no resize yet ----
  //
  // Download and Save-as-note both flatten through buildResultCanvas(), which
  // this file had never once checked - see measureExportAll's header for why
  // that is a genuinely different surface rather than a restatement of the
  // check above. No resize has happened at this point in the run: the surface
  // is still whatever the 1200x1600 viewport laid out. This is the SAME check
  // that runs again below after the resize, so a difference between the two
  // numbers is the resize's effect, not a difference in what is being asked.
  const exportedWide = await measureExportAll(page);
  if (exportedWide.drawnCount !== exportedWide.expectedCount) {
    failures.push(
      `${image}: buildResultCanvas drew ${exportedWide.drawnCount} word(s) but ${exportedWide.expectedCount} were expected - the draw predicate or order has drifted from what this gate assumes`
    );
  }
  check(exportedWide.rows, `${image} export (no resize)`, failures);

  // ---- And it survives the container changing width ----
  //
  // A word's font-size is a percentage of the editor surface's width, so every
  // size above is only correct for the width it was derived at. This gate ran
  // at one fixed viewport and asserted nothing about any other, which is the
  // guided-path bug's exact shape: one door tested, a second door shipped. The
  // second door here is a phone rotating.
  //
  // Re-checked rather than re-scanned: the OCR result is unchanged, it is the
  // LAYOUT that moved, which is precisely the thing that was untested.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
  const narrowWidth = await page.evaluate(() => document.getElementById("image-format-view").clientWidth);
  if (!(narrowWidth > 0) || narrowWidth >= wideWidth) {
    failures.push(`${image}: resizing to a phone viewport did not narrow the editor surface (${wideWidth} -> ${narrowWidth}), so this proves nothing`);
  }
  check(await measureAll(page), `${image} after resize to ${narrowWidth}px`, failures);

  // ---- The export canvas, not the preview - after the resize ----
  //
  // Same words, same measureExportAll, still at the narrowed container: the
  // resize-refit just re-solved every fontSizePct against a smaller preview
  // width, which moves it further from the export canvas's own scale, not
  // closer. Nothing about the export SHOULD depend on the preview's width at
  // all - the fixed version solves fresh against the export canvas regardless
  // of what the preview last did - so this number should not get worse than
  // the no-resize measurement above once that is true.
  const exportedNarrow = await measureExportAll(page);
  if (exportedNarrow.drawnCount !== exportedNarrow.expectedCount) {
    failures.push(
      `${image}: buildResultCanvas drew ${exportedNarrow.drawnCount} word(s) but ${exportedNarrow.expectedCount} were expected (after resize) - the draw predicate or order has drifted from what this gate assumes`
    );
  }
  check(exportedNarrow.rows, `${image} export (after resize to ${narrowWidth}px)`, failures);

  await page.setViewportSize({ width: 1200, height: 1600 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);

  // ---- A size the user chose by hand outranks the refit ----
  // Resizing is how someone overrides the automatic size; a later retype must
  // not quietly take that override back.
  const locked = await page.evaluate(async (id) => {
    const mod = await import("/js/editorObjects.js");
    if (typeof mod.refitWordFontSize !== "function") return { missing: true };
    const { refitWordFontSize } = mod;
    const o = window.__state.editorObjects.find((x) => x.id === id);
    o.fontSizeLocked = true;
    o.fontSizePct = 7.5;
    o.el.textContent = "COMPLETELYDIFFERENT";
    const changed = refitWordFontSize(o);
    return { changed, fontSizePct: o.fontSizePct };
  }, ids[0]);
  if (locked.missing) {
    failures.push(`${image}: editorObjects.js exports no refitWordFontSize, so nothing re-derives a word's size when its text changes`);
  } else if (locked.changed || Math.abs(locked.fontSizePct - 7.5) > 1e-9) {
    failures.push(`${image}: retyping a hand-resized word overrode the size the user chose (${locked.fontSizePct} instead of 7.5)`);
  }

  // ---- the same property, under faces this machine may not be running ----
  //
  // Everything above is a measurement of ONE face - whichever the stack
  // resolved to on this machine. That is exactly how the previous version of
  // this gate shipped red: it was green on `.SF NS`, a variable font whose ink
  // moves almost continuously, and the app's solver had assumed precisely that.
  // CI resolves Liberation Sans, where ink is grid-fit to whole pixels, and
  // nothing here could see the difference.
  //
  // So the property is re-checked under forced faces. The three Linux faces are
  // the ones that matter, because they are what CI and most Android devices
  // actually use; Courier New and Georgia are here because they are installed
  // on a Mac and have different tread shapes, so a developer gets SOME
  // staircase coverage locally rather than none.
  //
  // A face that is not installed cannot be covered, and this says so out loud
  // instead of silently re-testing the default and reporting a pass. It does
  // not FAIL for a missing face - a Mac has no Liberation Sans and should not
  // have a red build over it - but the coverage line makes the gap visible, and
  // on CI these resolve and the check is real.
  if (image === "complexPic5.jpeg") {
    console.log("  -- the same property under forced faces --");
    for (const family of FORCED_FACES) {
      // Added and then REMOVED each time round. Left in place they accumulate,
      // and since every override has the same specificity the winner becomes
      // whichever sheet the engine happens to order last - which is how this
      // first reported Georgia, a face that is installed, as missing.
      const override = await page.addStyleTag({ url: `http://localhost:${PORT}/__forced-face.css?f=${encodeURIComponent(family)}` });
      // One frame, so the face is resolved against the new stack before it is
      // read back - getPlatformFontsForNode reports what was last laid out.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const resolved = await resolveFace(context, page);
      // Re-size every word through the app's own refit path, which is what a
      // real font change would do.
      const refitted = await page.evaluate(async () => {
        const { refitWordFontSize } = await import("/js/editorObjects.js");
        let n = 0;
        for (const o of window.__state.editorObjects) if (o.type === "word" && refitWordFontSize(o)) n++;
        return n;
      });
      // An empty string means the engine could not be asked (CDP is chromium
      // only), not that the face is missing - so check anyway and say it is
      // unverified, rather than silently skipping coverage on webkit/firefox.
      const key = family.toLowerCase().split(" ")[0];
      const installed = resolved === "" || resolved.toLowerCase().includes(key);
      if (!installed) {
        console.log(`  [face] ${family.padEnd(16)} NOT INSTALLED here (resolved "${resolved}") - not covered on this machine`);
        await override.evaluate((el) => el.remove());
        continue;
      }
      console.log(
        `  [face] ${family.padEnd(16)} ${resolved ? `resolved "${resolved}"` : "(face unverified on this engine)"}, ${refitted} words re-sized`
      );
      check(await measureAll(page), `${image} forced:${family}`, failures);
      await override.evaluate((el) => el.remove());
    }
  }

  if (pageErrors.length) failures.push(`${image}: ${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
  await context.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures.slice(0, 25)) console.error("  -", f);
  if (failures.length > 25) console.error(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("\nA replacement word fills the space the word it replaces occupied, and does not spill out of it - on first render and after a retype.");
