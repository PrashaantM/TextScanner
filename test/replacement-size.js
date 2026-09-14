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

import { launchBrowser } from "./browser.js";
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
// The band around 1.0 is 6% rather than tighter for the reason spelled out in
// render-fidelity.js: the size is derived from one measurement at a 100px
// reference and scaled, and a face's metrics per em are not perfectly linear in
// size once hinting is involved (~1.5% on this stack, varying with the rendered
// size, which varies with the viewport). Nowhere near wide enough to admit 0.58.
// Measured worst case on this corpus is 1.062, on "vnanir" - six x-height
// letters rendered about ten pixels tall, where the dot on the "i" and the
// x-height both grid-fit to whole pixels and a single pixel is 10% of the ink.
// Small text is exactly where the quantization bites, and a real photo is full
// of it, so this band is wider than render-fidelity.js's 1.06 over synthetic
// boxes. It still cannot admit 0.58, nor the 2.12x and 3.18x that the
// envelope-inflation bug produced.
const MAX_SPILL = 1.1;
const MIN_TIGHT_FIT = 0.94;
// The floor in fontSizePctForInk: a replacement much longer than the original
// stops shrinking at half the height-matched size and overflows instead, rather
// than becoming unreadable inside a short word's box. A word sized by that floor
// is exempt from the spill assertion - it is the documented escape hatch, not a
// regression - but it must still not be shrinking below the floor.
const WIDTH_FIT_FLOOR = 0.5;

// Measures every word's rendered ink against the source box it stands in, in
// source-image pixels. Ink, not the span's border box: the box carries
// line-height and padding, so comparing it to a glyph height means nothing.
const measureAll = (page) =>
  page.evaluate(() => {
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
      rows.push({
        id: o.id,
        text,
        hFill: inkH / srcH,
        wFill: inkW / srcW,
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
  let flooredCount = 0;
  for (const r of rows) {
    const tight = Math.max(r.hFill, r.wFill);
    worstSlack = Math.min(worstSlack, tight);
    // Sized by the floor: height is deliberately held above what the width
    // allows, so width spills on purpose. Recognised by the height having
    // stopped shrinking - anything at or below the floor is the escape hatch.
    const flooredOut = r.wFill > MAX_SPILL && r.hFill <= WIDTH_FIT_FLOOR + 0.05;
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
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  console.log(
    `  ${label}: ${rows.length} words | median fill h=${med(rows.map((r) => r.hFill)).toFixed(3)} ` +
      `w=${med(rows.map((r) => r.wFill)).toFixed(3)} | worst spill ${worstSpill.toFixed(3)} | loosest fit ${worstSlack.toFixed(3)}` +
      (flooredCount ? ` | ${flooredCount} sized by the overflow floor` : "")
  );
}

const failures = [];
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
