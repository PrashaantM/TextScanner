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

// Fill and spill, as fractions of the source word's own ink box.
//
// This is the OUTER statement of the property, in the terms the header
// describes it: a replacement fills the box and does not spill out of it. The
// band around 1.0 is 6% and stays 6% - deliberately, now that the precision
// check below carries the real weight. It is the assertion that holds whatever
// face the stack resolves to, so widening or narrowing it should track what the
// property means, not what this month's font happens to measure.
//
// (The reason it USED to be 6% no longer applies and should not be cited: the
// size was derived from one measurement at a 100px reference and scaled, and
// the scaling was wrong by up to 18%. That is fixed - see js/editorObjects.js.)
const MAX_SPILL = 1.1;
const MIN_TIGHT_FIT = 0.94;

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
    const { PROPERTY_SPAN, SLACK } = window.__gateConstants;
    const s = window.__state;
    const view = document.getElementById("image-format-view");
    // clientWidth, not getBoundingClientRect().width: font-size is in `cqw`,
    // which resolves against the container's CONTENT box, and this element has
    // a 1px border.
    const scale = view.clientWidth / s.lastNaturalWidth;
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

      // ---- the property, measured in CSS pixels ----
      // CSS pixels, not image pixels, because CSS pixels are the unit the
      // browser grid-fits ink in. Converting to image pixels first would divide
      // the staircase by a non-integer and blur the treads this has to see.
      const renderedPx = parseFloat(cs.fontSize);
      const inkAtSize = (px, dimension) => {
        mctx.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
        const q = mctx.measureText(text);
        return dimension === "height" ? q.actualBoundingBoxAscent + q.actualBoundingBoxDescent : q.width;
      };
      // Walks up the same grid the solver chooses from, looking for the next
      // size that renders MORE ink - see the note on P2 above for why "more"
      // rather than "different". Returns null when the span holds no larger
      // ink at all, which means the word is already maximal as far as this
      // looked, and P2 is satisfied with nothing to report.
      const nextLargerInk = (fromPx, dimension) => {
        const here = inkAtSize(fromPx, dimension);
        const stop = fromPx + PROPERTY_SPAN;
        for (let px = Math.ceil((fromPx + 1e-9) / GRID) * GRID; px <= stop + 1e-9; px += GRID) {
          const v = inkAtSize(px, dimension);
          if (v > here + 1e-9) return { px, ink: v };
        }
        return null;
      };
      // P1 and P2 for one size against one target, both in CSS pixels.
      const propertyAt = (rawPx, dimension, targetCssPx) => {
        // Snapped to the grid before probing. The size is read back out of
        // getComputedStyle, which round-trips through a float, so it can sit a
        // few bits off the grid point the solver actually chose; probing the
        // off-grid value would compare a size the solver never considered.
        // SLACK bounds how far that readback is allowed to have drifted, and it
        // is the ONLY thing it is used for. It is deliberately NOT applied to
        // the ink comparisons below: slackening those would make this gate
        // demand something stricter than the solver promises - it would call a
        // size 'still fitting' that the solver had correctly rejected, and
        // report headroom that does not exist.
        const px = Math.round(rawPx / GRID) * GRID;
        const here = inkAtSize(px, dimension);
        const up = nextLargerInk(px, dimension);
        return {
          px,
          readbackDriftPx: Math.abs(px - rawPx),
          ink: here,
          target: targetCssPx,
          spills: here > targetCssPx,
          nextPx: up ? up.px : null,
          nextInk: up ? up.ink : null,
          // Headroom means: a larger ink exists just above, and it would STILL
          // have fitted. That is the word being smaller than it needed to be.
          headroom: !!up && up.ink <= targetCssPx,
          noLargerInkInSpan: !up,
        };
      };

      const row = {
        id: o.id,
        text,
        renderedPx,
        hFill: inkH / srcH,
        wFill: inkW / srcW,
        binding,
        floorScale: MIN_WIDTH_FIT_SCALE,
        fontSizeLocked: !!o.fontSizeLocked,
      };
      if (binding === "height" || binding === "width") {
        const target = (binding === "height" ? srcH : srcW) * scale;
        row.property = propertyAt(renderedPx, binding, target);
      } else if (binding === "floor") {
        // A floored word is exempt from spilling in WIDTH - that is the whole
        // point of the floor. What it is not exempt from is being anchored to a
        // real height fit: the floor is half the height-matched size, so that
        // height-matched size has to satisfy the property against the source
        // HEIGHT, and the size actually rendered has to be the one the floor
        // rule selects from it. Both are checked, and neither is a residual.
        row.property = propertyAt(fit.heightFitPx * scale, "height", srcH * scale);
        row.floorExpectedPx = fit.heightFitPx * MIN_WIDTH_FIT_SCALE * scale;
      }
      rows.push(row);
    }
    return rows;
  });

function check(rows, label, failures) {
  if (!rows.length) {
    failures.push(`${label}: measured no words at all - the harness found nothing to assert on, which is a failure, not a pass`);
    return;
  }
  let worstSpill = 0;
  let worstSlack = 1;
  let worstResidual = 0;
  let flooredCount = 0;
  let unprobedCount = 0;
  for (const r of rows) {
    const tight = Math.max(r.hFill, r.wFill);
    worstSlack = Math.min(worstSlack, tight);
    // A word the user has resized by hand is carrying the size THEY chose, not
    // one this code derived, so P1 and P2 say nothing about it. The assertion
    // that matters for those is further down: that a retype did not quietly
    // take the override back.
    if (r.fontSizeLocked) continue;
    if (!r.binding || !r.property) {
      failures.push(`${label}/"${r.text}": js/editorObjects.js could not size this word at all - inkFitPx returned nothing`);
      continue;
    }
    const flooredOut = r.binding === "floor";
    if (flooredOut) flooredCount++;
    else worstSpill = Math.max(worstSpill, tight);

    // ---- the outer statement of the property, in the header's own terms ----
    if (!flooredOut && (r.hFill > MAX_SPILL || r.wFill > MAX_SPILL)) {
      failures.push(
        `${label}/"${r.text}": rendered ink is ${r.hFill.toFixed(3)}x the source word's height and ` +
          `${r.wFill.toFixed(3)}x its width - a replacement must not spill out of the space it replaces`
      );
    }
    if (tight < MIN_TIGHT_FIT) {
      failures.push(
        `${label}/"${r.text}": rendered ink fills only ${r.hFill.toFixed(3)} of the source word's height ` +
          `and ${r.wFill.toFixed(3)} of its width - short in both, so the replacement is smaller than the text it replaces`
      );
    }

    // ---- P1: it does not spill ----
    const p = r.property;
    const dim = flooredOut ? "height" : r.binding;
    const what = flooredOut ? "the height fit its floor is half of" : `the size it was fitted to (${r.binding})`;
    if (p.spills) {
      failures.push(
        `${label}/"${r.text}": P1 violated - at ${p.px.toFixed(3)}px, ${what} renders ${p.ink.toFixed(2)}px of ` +
          `${dim} ink against a source box of ${p.target.toFixed(2)}px. A replacement must not spill out of the ` +
          `space it replaces, at any size, on any face.`
      );
    }
    // ---- P2: and there is no headroom left ----
    if (p.headroom) {
      failures.push(
        `${label}/"${r.text}": P2 violated - at ${p.px.toFixed(3)}px it renders ${p.ink.toFixed(2)}px of ${dim} ` +
          `ink, but ${p.nextPx.toFixed(3)}px renders ${p.nextInk.toFixed(2)}px, which ALSO fits the ` +
          `${p.target.toFixed(2)}px box. The word is smaller than it could be.`
      );
    }
    if (p.noLargerInkInSpan) unprobedCount++;
    if (p.readbackDriftPx > READBACK_SLACK_PX) {
      failures.push(
        `${label}/"${r.text}": the size the browser is using (${r.renderedPx.toFixed(4)}px) is ` +
          `${p.readbackDriftPx.toFixed(4)}px off the grid the solver chooses from - the two have drifted apart, ` +
          `so every measurement below is of a size the app never picked`
      );
    }

    // ---- the floor selects the size, and that is checked as a selection ----
    if (flooredOut) {
      // Not "its ink lands within x of a continuously-derived guarantee" - that
      // was the same modelling mistake in a different place. The floor is a
      // RULE: half the height-matched size. So check the rule was applied, by
      // comparing the size the browser is actually using against the size the
      // rule selects.
      const drift = Math.abs(r.renderedPx - r.floorExpectedPx);
      if (drift > READBACK_SLACK_PX) {
        failures.push(
          `${label}/"${r.text}": sized by the width floor, but the browser is rendering it at ` +
            `${r.renderedPx.toFixed(4)}px where the floor rule selects ${r.floorExpectedPx.toFixed(4)}px ` +
            `(half the height-matched size) - off by ${drift.toFixed(4)}px`
        );
      }
    }

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
      (flooredCount ? ` | ${flooredCount} sized by the overflow floor` : "") +
      (unprobedCount ? ` | ${unprobedCount} on a tread wider than ${PROPERTY_SPAN_PX}px` : "")
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

// complexPic1 is the poster set in a condensed hand-drawn face - the case where
// width binds and the font-matcher gap shows. complexPic5 is ordinary type,
// where height should land on 1.0 almost exactly.
for (const image of ["complexPic1.jpeg", "complexPic5.jpeg"]) {
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
  check(await measureAll(page), `${image} as-scanned`, failures);

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
