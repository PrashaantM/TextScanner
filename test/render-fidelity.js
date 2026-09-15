// render-fidelity.js: isolates renderImageFormatView (js/editorObjects.js) from whichever
// OCR engine produced the words. It draws a synthetic image whose word boxes are
// known EXACTLY (measured with ctx.measureText's actualBoundingBox metrics, not
// estimated), feeds those perfect boxes straight into renderImageFormatView, and
// screenshots the result next to the source.
//
// Why this exists: the on-device ML Kit run rendered Image format/Full image as
// "gibberish" on some images and "really good" on others, with no correlation to
// image dimensions or EXIF orientation. That leaves two very different causes -
// either ML Kit's bounding boxes are wrong, or the renderer mangles correct boxes.
// This harness answers that half of the question offline, with no device needed:
// if perfect boxes render wrong here, the renderer is at fault regardless of engine.
//
// Usage: node test/render-fidelity.js   (writes PNGs to test/manual-output/)

import { launchBrowser } from "./browser.js";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "./make-mlkit-fixture.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "test/manual-output");
const PORT = 8124;

// Placement error budget for the ML Kit fixture replay, as a percentage of the
// image's own width/height. The numbers this actually produces are ~1e-13 (the
// path is pure arithmetic, and the fixtures carry exact ground truth), so this
// is not a tuned tolerance - it is a tripwire wide enough that floating-point
// noise can never trip it and narrow enough that any real coordinate error will.
const MAX_PLACEMENT_ERROR_PCT = 0.05;
// Font size is asserted as a PROPERTY of what got rendered, not as a formula.
//
// It used to be a formula, and that is precisely why it never caught the size
// bug it was supposed to own: the assertion read
//
//     expectedFontPct = (t.h / naturalWidth) * 100 * 0.8
//
// which is renderImageFormatView's own line of code copied into the test. A
// gate written that way can only ever confirm that the implementation is still
// itself. It passed at 1.00x for months while every replacement word rendered
// at 0.58x the height of the text it replaced - measured from real pixels on
// complexPic1, complexPic5 and complexPic2, all three within 0.581-0.593.
//
// What a reader actually wants is stated below instead: a replacement fills the
// box of the word it replaces, and does not spill out of it. Both halves matter.
// "Does not spill" alone is satisfied by rendering nothing; "fills" alone is
// what produces words that collide with their neighbours and run off the image.
// Neither half mentions a font size, so neither can be satisfied by copying one.
// The band is 6% rather than something tighter, and the reason is measurable
// rather than defensive. The renderer measures the string once at a 100px
// reference and scales the result, because font metrics are linear in size -
// almost. Hinting and grid-fitting mean a face's advance width per em at 23px
// is not exactly its advance width per em at 100px; the gap runs to ~1.5% on
// this stack, and the exact figure depends on the rendered size, which depends
// on the viewport, which is not fixed. Anything tighter would be a flaky gate
// measuring the font rasteriser. It is still nowhere near wide enough to admit
// the bug this replaced: that one sat at 0.58.
const MAX_INK_OVERFLOW = 0.06;
// The fit has to be TIGHT in whichever dimension binds first - that is the half
// the old assertion had no way to express, and the half the 0.8 constant failed:
// it left the ink at 0.58 of the box's height AND 0.82 of its width, short in
// both, with nothing to say so.
const MIN_TIGHT_FIT = 0.94;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png" };

function serveStatic() {
  return createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }).listen(PORT);
}

// Drawn in the page: a poster-shaped image mixing display-sized headlines with
// body-sized copy, mirroring complexPic1 (the worst "gibberish" case) rather than
// a uniform screenshot. Two font variants are rendered so the experiment separates
// pure geometry error from font-metric mismatch:
//   "system" - drawn in the same font stack .image-format-word renders in, so a
//              perfect box SHOULD reproduce exactly. Any error here is the renderer.
//   "display" - drawn in a heavy condensed face, like a real poster. Isolates how
//              much error comes purely from the renderer's one-generic-font
//              assumption when the source art uses a different typeface.
//
// It now also measures COLOUR and WEIGHT fidelity (Phase 4b). The synthetic
// poster is drawn in a range of real ink colours on a range of backgrounds, and
// because this harness KNOWS what colour it drew each word in, the sampled
// colour on the rendered span can be compared against the truth directly. That
// makes "does matching the source colour actually work" a number rather than an
// impression - which matters, because the failure mode of colour sampling is
// subtle (a slightly-off tint reads as a rendering artifact, not a bug).
const PAGE_SCRIPT = (fontMode) => {
  const SYSTEM = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const DISPLAY = `"Impact", "Haettenschweiler", "Arial Narrow Bold", sans-serif`;
  return { family: fontMode === "display" ? DISPLAY : SYSTEM, fontMode };
};

async function run(page, fontMode) {
  const built = await page.evaluate(({ family }) => {
    const W = 1024;
    const H = 1536;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";

    // Bands of different background colour down the poster, so colour sampling
    // is exercised against light, dark and saturated grounds rather than one
    // flat cream. A word's background is whichever band it sits in.
    const BANDS = [
      { until: 480, bg: [250, 243, 230] }, // cream
      { until: 900, bg: [28, 32, 46] }, // near-black
      { until: 1180, bg: [186, 34, 42] }, // saturated red
      { until: 1536, bg: [245, 245, 245] }, // near-white
    ];
    let bandTop = 0;
    BANDS.forEach((band) => {
      ctx.fillStyle = `rgb(${band.bg[0]}, ${band.bg[1]}, ${band.bg[2]})`;
      ctx.fillRect(0, bandTop, W, band.until - bandTop);
      bandTop = band.until;
    });
    const bandAt = (y) => BANDS.find((b) => y < b.until) || BANDS[BANDS.length - 1];

    // [text, fontPx, weight, inkColor] - a poster-like size ladder, now with
    // real ink colours rather than one near-black.
    const lines = [
      [["POPCICHAWK", 118, 700, [180, 30, 40]]], // headline, red on cream
      [["POPSICLES", 62, 700, [17, 17, 17]], ["&", 62, 400, [17, 17, 17]], ["CHAWK", 62, 700, [17, 17, 17]], ["DRAWINGS", 62, 700, [17, 17, 17]]],
      [["LOWER", 44, 500, [40, 70, 140]], ["RESIDENT", 44, 500, [40, 70, 140]], ["LANE", 44, 500, [40, 70, 140]]],
      [["BUILDING", 44, 500, [245, 240, 230]], ["D", 44, 500, [245, 240, 230]], ["AREA", 44, 500, [245, 240, 230]]],
      [["RELAXING", 56, 600, [250, 210, 90]], ["ON", 56, 600, [250, 210, 90]], ["A", 56, 600, [250, 210, 90]]],
      [["SUNNY", 56, 600, [250, 210, 90]], ["DAY", 56, 600, [250, 210, 90]]],
      [["JULY", 92, 700, [255, 255, 255]], ["31ST", 92, 700, [255, 255, 255]]],
      [["GOOD", 30, 500, [255, 240, 240]], ["COMPANY.", 30, 500, [255, 240, 240]], ["COOL", 30, 500, [255, 240, 240]], ["TREATS.", 30, 500, [255, 240, 240]]],
      [["CREATIVE", 30, 500, [20, 20, 20]], ["VIBES.", 30, 500, [20, 20, 20]]],
      [["Fine", 18, 400, [90, 90, 90]], ["print", 18, 400, [90, 90, 90]], ["that", 18, 400, [90, 90, 90]], ["nobody", 18, 400, [90, 90, 90]], ["reads", 18, 400, [90, 90, 90]], ["carefully", 18, 400, [90, 90, 90]]],
    ];

    const words = [];
    let y = 170;
    lines.forEach((line, lineIndex) => {
      const maxPx = Math.max(...line.map((w) => w[1]));
      let x = 60;
      line.forEach(([text, px, weight, ink]) => {
        ctx.font = `${weight} ${px}px ${family}`;
        ctx.fillStyle = `rgb(${ink[0]}, ${ink[1]}, ${ink[2]})`;
        const m = ctx.measureText(text);
        ctx.fillText(text, x, y);
        // The ink box, not the advance box - this is what an OCR engine reports,
        // and what renderImageFormatView is handed.
        const x0 = x - m.actualBoundingBoxLeft;
        const x1 = x + m.actualBoundingBoxRight;
        const y0 = y - m.actualBoundingBoxAscent;
        const y1 = y + m.actualBoundingBoxDescent;
        words.push({
          lineIndex,
          text,
          confidence: 100,
          bbox: { x0, y0, x1, y1 },
          // Ground truth for the colour/weight comparison below. Ignored by
          // renderImageFormatView, which never sees these fields.
          trueInk: ink,
          trueWeight: weight,
          trueBg: bandAt(y).bg,
        });
        x = x + m.width + px * 0.28; // inter-word space
      });
      y += maxPx * 1.5;
    });

    return { dataUrl: canvas.toDataURL("image/png"), words, W, H };
  }, PAGE_SCRIPT(fontMode));

  // Feed the exact boxes into the real renderer, through the real module.
  await page.evaluate(async ({ dataUrl, words, W, H }) => {
    const dom = await import("/js/dom.js");
    const objects = await import("/js/editorObjects.js");
    const interactions = await import("/js/editorInteractions.js");
    // The app now has views, and the editor lives inside the scan view. A test
    // that drives the editor directly (rather than through loadFile, which
    // switches views itself) has to put the app on that view first, or the
    // editor's container is display:none and every measured rect is zero.
    const views = await import("/js/views.js");
    views.showView("scan", {}, { push: false });
    dom.previewImg.src = dataUrl;
    await dom.previewImg.decode();
    document.getElementById("result-section").classList.remove("hidden");
    await objects.renderImageFormatView(dom.previewImg, words, W, H, dataUrl);
    interactions.setMode("image");
  }, built);

  await page.waitForTimeout(400);
  return built;
}

// Replays the ML Kit fixture corpus (test/make-mlkit-fixture.js) through the
// REAL renderer in a real browser, and turns geometry error on the native path
// into a tracked number rather than a visual impression.
//
// This is the DOM-level counterpart to test/unit/mlkit-geometry.test.js. That
// test pins the arithmetic of flattenBlocks in isolation; this one proves the
// whole chain - flattenBlocks -> renderImageFormatView -> CSS - puts each word
// where its ground truth says it belongs, including the transform that carries
// a tilted word's rotation.
//
// It replaces test/replay-dump.js, which could only replay a device dump that
// had no ground truth to compare against.
async function replayMlkitFixtures(page) {
  const rows = [];
  const failures = [];

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    await page.goto(`http://localhost:${PORT}/index.html`);

    const measured = await page.evaluate(async ({ fixture }) => {
      const dom = await import("/js/dom.js");
      const objects = await import("/js/editorObjects.js");
      const interactions = await import("/js/editorInteractions.js");
      const { flattenBlocks } = await import("/js/mlkitEngine.js");
      const { state } = await import("/js/state.js");
      const views = await import("/js/views.js");
      // See the note in run() above - the editor must be on a visible view for
      // getBoundingClientRect to return real numbers.
      views.showView("scan", {}, { push: false });

      const { naturalWidth: W, naturalHeight: H } = fixture;
      // A blank ground: this measures where words land, and a backdrop would
      // only make the screenshots prettier.
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      const src = canvas.toDataURL("image/png");

      dom.previewImg.src = src;
      await dom.previewImg.decode();
      document.getElementById("result-section").classList.remove("hidden");

      // The real production call, fed the real production flattener.
      const words = flattenBlocks(fixture.rawResult.blocks);
      await objects.renderImageFormatView(dom.previewImg, words, W, H, src);
      interactions.setMode("image");

      const view = document.getElementById("image-format-view");
      const vb = view.getBoundingClientRect();
      const scale = vb.width / W;

      return state.editorObjects
        .filter((o) => o.type === "word")
        .map((obj) => {
          // obj.x/obj.y are the renderer's own output, in percent. The rect is
          // what the browser actually painted, which is the half that proves the
          // CSS rotation landed rather than being computed and dropped.
          const r = obj.el.getBoundingClientRect();
          // The INK the browser will actually paint for this span, in source-image
          // pixels - not the span's box, which carries line-height and padding and
          // so cannot be compared against a glyph height. Measured through the
          // span's own computed font so it reflects what is on screen rather than
          // a font stack named a second time here.
          const cs = getComputedStyle(obj.el);
          const mctx = document.createElement("canvas").getContext("2d");
          mctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const tm = mctx.measureText(obj.el.textContent);
          return {
            text: obj.el.textContent,
            xPct: obj.x,
            yPct: obj.y,
            fontSizePct: obj.fontSizePct,
            rotationDeg: obj.rotationDeg || 0,
            renderedEnvelopeW: r.width / scale,
            renderedEnvelopeH: r.height / scale,
            renderedInkW: tm.width / scale,
            renderedInkH: (tm.actualBoundingBoxAscent + tm.actualBoundingBoxDescent) / scale,
            transform: getComputedStyle(obj.el).transform,
          };
        });
    }, { fixture });

    const truth = fixture.groundTruth.lines.flat();
    if (measured.length !== truth.length) {
      failures.push(`${name}: rendered ${measured.length} words, ground truth has ${truth.length}`);
      continue;
    }

    let worstPlacement = 0;
    let worstFont = 0;
    let rotationsApplied = 0;

    measured.forEach((m, i) => {
      const t = truth[i];
      // Ground truth converted into the same percentage space the renderer
      // positions in.
      const expectedXPct = (t.x / fixture.naturalWidth) * 100;
      const expectedYPct = (t.y / fixture.naturalHeight) * 100;
      // How much of the word's true ink box the rendered ink actually fills.
      const hFill = m.renderedInkH / t.h;
      const wFill = m.renderedInkW / t.w;

      const placementError = Math.max(Math.abs(m.xPct - expectedXPct), Math.abs(m.yPct - expectedYPct));
      worstPlacement = Math.max(worstPlacement, placementError);
      worstFont = Math.max(worstFont, Math.abs(Math.max(hFill, wFill) - 1));

      if (placementError > MAX_PLACEMENT_ERROR_PCT) {
        failures.push(
          `${name}/"${m.text}": placed at ${m.xPct.toFixed(3)},${m.yPct.toFixed(3)}% but belongs at ` +
            `${expectedXPct.toFixed(3)},${expectedYPct.toFixed(3)}% (error ${placementError.toFixed(4)}%)`
        );
      }
      // Does not spill out of the box. The envelope-inflation bug showed up here
      // as 2.12x at 15 degrees and 3.18x at 40 (test/unit/mlkit-geometry.test.js).
      if (hFill > 1 + MAX_INK_OVERFLOW || wFill > 1 + MAX_INK_OVERFLOW) {
        failures.push(
          `${name}/"${m.text}": rendered ink is ${hFill.toFixed(3)}x the true glyph height and ` +
            `${wFill.toFixed(3)}x its width - a replacement must not spill out of the box it replaces`
        );
      }
      // ...and fills it. Whichever dimension runs out first has to run out
      // properly: a word that fits with room to spare in BOTH is simply too
      // small, which is what the 0.8 constant produced for every word in the app.
      if (Math.max(hFill, wFill) < MIN_TIGHT_FIT) {
        failures.push(
          `${name}/"${m.text}": rendered ink fills only ${hFill.toFixed(3)} of the box's height and ` +
            `${wFill.toFixed(3)} of its width - short in both, so the word is smaller than the text it replaces`
        );
      }

      // A word the fixture tilted must actually carry a non-identity transform.
      // Without this the renderer could compute the right rotation and never
      // apply it, and every placement assertion above would still pass.
      if (Math.abs(t.rotationDeg) >= 1) {
        if (m.transform === "none" || m.transform === "matrix(1, 0, 0, 1, 0, 0)") {
          failures.push(`${name}/"${m.text}": tilted ${t.rotationDeg} degrees but rendered with no transform`);
        } else {
          rotationsApplied++;
        }
      }
    });

    rows.push({
      fixture: name,
      words: measured.length,
      image: `${fixture.naturalWidth}x${fixture.naturalHeight}`,
      "worst placement error %": +worstPlacement.toFixed(5),
      "worst font size error": +worstFont.toFixed(5),
      "rotated words": rotationsApplied,
    });
  }

  console.log("\n=== ML Kit fixture replay (native path geometry) ===");
  console.table(rows);
  await writeFile(join(OUT, "mlkit-fixture-replay.json"), JSON.stringify(rows, null, 2));

  return failures;
}

async function main() {
  const server = serveStatic();
  await mkdir(OUT, { recursive: true });
  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 });

  for (const fontMode of ["system", "display"]) {
    await page.goto(`http://localhost:${PORT}/index.html`);
    const built = await run(page, fontMode);

    await writeFile(join(OUT, `fidelity-${fontMode}-source.png`), Buffer.from(built.dataUrl.split(",")[1], "base64"));
    const view = await page.$("#image-format-view");
    await view.screenshot({ path: join(OUT, `fidelity-${fontMode}-rendered.png`) });

    // Numeric version of the same comparison: for every word, how far is the
    // rendered span's actual on-screen box from the box it was given?
    const drift = await page.evaluate(async ({ W, H }) => {
      const { state } = await import("/js/state.js");
      const byElement = new Map(state.editorObjects.filter((o) => o.type === "word").map((o) => [o.el, o]));
      const view = document.getElementById("image-format-view");
      const vb = view.getBoundingClientRect();
      const scale = vb.width / W;
      const rows = [];
      view.querySelectorAll(".image-format-word").forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        rows.push({
          i,
          text: el.textContent,
          renderedW: (r.width / scale),
          renderedH: (r.height / scale),
          renderedX: ((r.left - vb.left) / scale),
          renderedY: ((r.top - vb.top) / scale),
          // What the word is actually painted in, after Phase 4b's sampling.
          // Read from computed style rather than the inline custom property so
          // this measures what the user sees, not what was intended.
          renderedColor: cs.color,
          renderedWeight: Number(cs.fontWeight) || 400,
          // What the bold/regular guess is actually derived from, so the
          // threshold can be calibrated against data instead of picked.
          inkFraction: byElement.get(el)?.inkFraction ?? null,
        });
      });
      return rows;
    }, built);

    const parseRgb = (css) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || "");
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    // Plain Euclidean distance in RGB. Not perceptually uniform, but this is a
    // regression measure against a known truth, not a perception study - and it
    // has the advantage of being obvious what it means: 0 is exact, 441 is
    // black-vs-white.
    const colorDistance = (a, b) => (a && b ? Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])) : null);

    const report = drift.map((d, i) => {
      const w = built.words[i];
      const gtW = w.bbox.x1 - w.bbox.x0;
      const gtH = w.bbox.y1 - w.bbox.y0;
      const rendered = parseRgb(d.renderedColor);
      return {
        text: w.text,
        gtW: Math.round(gtW),
        renderedW: Math.round(d.renderedW),
        widthRatio: +(d.renderedW / gtW).toFixed(2),
        gtH: Math.round(gtH),
        renderedH: Math.round(d.renderedH),
        heightRatio: +(d.renderedH / gtH).toFixed(2),
        xDrift: Math.round(d.renderedX - w.bbox.x0),
        overflowPx: Math.round(d.renderedW - gtW),
        trueInk: `rgb(${w.trueInk.join(", ")})`,
        renderedInk: rendered ? `rgb(${rendered.join(", ")})` : d.renderedColor,
        inkError: colorDistance(rendered, w.trueInk),
        trueBold: w.trueWeight >= 600,
        renderedBold: d.renderedWeight >= 600,
        trueWeight: w.trueWeight,
        inkFraction: d.inkFraction == null ? null : +d.inkFraction.toFixed(3),
      };
    });

    console.log(`\n=== ${fontMode} font ===`);
    console.table(report);
    const ratios = report.map((r) => r.widthRatio);
    console.log(`width ratio: min ${Math.min(...ratios)}  max ${Math.max(...ratios)}  mean ${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)}`);

    // Colour/weight fidelity (Phase 4b). Before colour sampling existed, every
    // word rendered in one theme colour, so inkError was simply the distance
    // from that colour to each word's real one - the number to beat.
    const inkErrors = report.map((r) => r.inkError).filter((n) => n != null);
    if (inkErrors.length) {
      const meanInk = inkErrors.reduce((a, b) => a + b, 0) / inkErrors.length;
      const worstInk = Math.max(...inkErrors);
      const boldRight = report.filter((r) => r.trueBold === r.renderedBold).length;
      console.log(
        `ink colour error (0 = exact, 441 = max): mean ${meanInk.toFixed(1)}  worst ${worstInk}` +
          `   |   bold/regular correct: ${boldRight}/${report.length}`
      );
    }
    await writeFile(join(OUT, `fidelity-${fontMode}.json`), JSON.stringify(report, null, 2));
  }

  const failures = await replayMlkitFixtures(page);

  await browser.close();
  server.close();
  console.log(`\nPNGs + JSON in ${OUT}`);

  // The colour/weight/width tables above are a report - they describe fidelity
  // that is inherently approximate (font metrics differ from the source art's).
  // The fixture replay is not: its ground truth is exact, so it is the half of
  // this harness that can fail a build, and does.
  if (failures.length) {
    console.error("\nML Kit fixture replay FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("ML Kit fixture replay: every word placed within its ground truth budget.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
