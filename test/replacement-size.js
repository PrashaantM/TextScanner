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

// How far the BINDING dimension - the one the sizing chose to fit, height or
// width - may miss the source box by. This is the assertion that actually
// catches a sizing bug, and it can be three orders of magnitude tighter than
// the band above because both sides measure the same thing the same way: the
// app solves for the size whose canvas-measured ink equals the source box, and
// this measures the canvas ink at the size it actually rendered at.
//
// Chosen from measurement, with the separation stated rather than assumed.
// Correct code, over all 259 words of complexPic1/2/5 as-scanned and retyped,
// misses by at most 0.047% (median 0.005-0.010%). Reverting the per-size
// measurement in js/editorObjects.js - going back to one reading at a 100px
// reference - misses by 1.64% to 11.92% on those same populations. 0.5% sits
// ~10x above the first and ~3x below the second.
//
// AND IT IS NOT A ONE-FONT NUMBER, which matters because everything else in
// this file is. Re-run over complexPic5 with the stack forced to eight
// different faces, the residual under correct code was:
//
//     .SF NS 0.047%   Helvetica 0.030%   Arial Narrow 0.040%   Georgia 0.035%
//     Verdana 0.046%  Courier New 0.028%  American Typewriter 0.052%  Optima 0.052%
//
// The spread is 0.028-0.052% - it does not track the face, because the app
// solves against whatever face it measures and this checks the same face the
// same way. That is why this threshold can be tight where MAX_SPILL above
// cannot: MAX_SPILL is absorbing the app's font and the photo's font being
// different faces, and this is not.
//
// WHAT WOULD STILL MAKE IT FLAKY, stated because it is a real risk and not a
// hypothetical: the app solves the size by fixed-point iteration, which
// converges only because a face's ink per em varies smoothly-ish with size.
// Where the metric STEPS between two adjacent sizes, a target can sit in the
// gap and the iteration alternates instead of settling. That is not theory -
// it already happens on .SF NS, on 2 of the 440 solves this corpus needs (the
// word "the", on width), and it costs 0.046%, comfortably inside the number
// above. But how big a step is depends entirely on the face, and a heavily
// hinted face with coarser steps could land outside it. This assertion would
// then go red on correct code. That is a known limitation of the gate, not a
// licence to widen the number: the fix is to look at the face it happened on,
// which is why the run prints which face it resolved.
const MAX_BINDING_FIT_ERROR = 0.005;

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
    const s = window.__state;
    const view = document.getElementById("image-format-view");
    // clientWidth, not getBoundingClientRect().width: font-size is in `cqw`,
    // which resolves against the container's CONTENT box, and this element has
    // a 1px border. Using the border box here would bake a scale error into
    // every number the gate prints.
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
      rows.push({
        id: o.id,
        text,
        renderedPx: parseFloat(cs.fontSize),
        hFill: inkH / srcH,
        wFill: inkW / srcW,
        // Which dimension the size was chosen to fit, so the check below knows
        // which fill is supposed to land on 1.0. "floor" means neither: the
        // height is deliberately held above what the width allows.
        binding: !fit ? null : fit.flooredByWidth ? "floor" : fit.widthFitPx !== null && fit.widthFitPx < fit.heightFitPx ? "width" : "height",
        floorScale: MIN_WIDTH_FIT_SCALE,
        fontSizeLocked: !!o.fontSizeLocked,
      });
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
  let worstBindingError = 0;
  let flooredCount = 0;
  for (const r of rows) {
    const tight = Math.max(r.hFill, r.wFill);
    worstSlack = Math.min(worstSlack, tight);
    if (!r.binding) {
      failures.push(`${label}/"${r.text}": js/editorObjects.js could not size this word at all - inkFitPx returned nothing`);
      continue;
    }
    // Sized by the floor: the height is deliberately held above what the width
    // allows, so the width spills on purpose. This is the app's own answer, not
    // a guess from the rendered height - see the note in measureAll.
    const flooredOut = r.binding === "floor";
    if (flooredOut) flooredCount++;
    else worstSpill = Math.max(worstSpill, tight);
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
    if (flooredOut) {
      // A floored word is exempt from the spill assertion, but not from being
      // AT the floor: the floor is half the height-matched size, and the ink at
      // a smaller size is never less per em than at a larger one, so its height
      // fill cannot come out under half. Anything below that is the floor
      // failing to hold rather than the escape hatch working.
      //
      // There is deliberately no upper bound to match. How far above 0.5 a
      // floored word lands is exactly the quantity that varies with the face -
      // 0.500 on the font this ran against, 0.613 reported on another - and
      // bounding it is how this gate came to fail correct code in the first
      // place. Which words reach the floor at all varies just as much: the same
      // complexPic5 floors 1 word under .SF NS, 7 under Courier New and none at
      // all under Helvetica, Georgia, Verdana or Arial Narrow. Nothing about
      // this path is stable enough to pin with an absolute number.
      const atLeast = r.floorScale * (1 - MAX_BINDING_FIT_ERROR);
      if (r.hFill < atLeast) {
        failures.push(
          `${label}/"${r.text}": sized by the width floor but its ink is only ${r.hFill.toFixed(4)}x the source word's ` +
            `height, under the ${atLeast.toFixed(4)} the floor guarantees - the floor stopped holding`
        );
      }
      continue;
    }
    // The dimension the sizing actually bound on has to land on the source box,
    // and land on it tightly. This is what catches a per-em figure read at the
    // wrong size: the arithmetic still picks a winner between height and width,
    // it just picks the wrong number of pixels, and only the binding dimension
    // says so - the other one is under the box by design and cannot tell.
    const bindingFill = r.binding === "height" ? r.hFill : r.wFill;
    const err = Math.abs(bindingFill - 1);
    worstBindingError = Math.max(worstBindingError, err);
    if (err > MAX_BINDING_FIT_ERROR) {
      failures.push(
        `${label}/"${r.text}": sized to fit the source word's ${r.binding}, but its rendered ink is ` +
          `${bindingFill.toFixed(4)}x that ${r.binding} - off by ${(err * 100).toFixed(3)}%, over the ` +
          `${(MAX_BINDING_FIT_ERROR * 100).toFixed(3)}% this allows. The per-em figure used to pick the size does not ` +
          `hold at ${r.renderedPx.toFixed(2)}px, which is the size the word renders at`
      );
    }
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  console.log(
    `  ${label}: ${rows.length} words | median fill h=${med(rows.map((r) => r.hFill)).toFixed(3)} ` +
      `w=${med(rows.map((r) => r.wFill)).toFixed(3)} | worst spill ${worstSpill.toFixed(3)} | loosest fit ${worstSlack.toFixed(3)}` +
      ` | binding dim off by <=${(worstBindingError * 100).toFixed(3)}%` +
      (flooredCount ? ` | ${flooredCount} sized by the overflow floor` : "")
  );
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
  await page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    window.__state = state;
  });
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
