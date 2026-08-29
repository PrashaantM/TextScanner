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

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "test/manual-output");
const PORT = 8124;

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
    dom.previewImg.src = dataUrl;
    await dom.previewImg.decode();
    document.getElementById("result-section").classList.remove("hidden");
    objects.renderImageFormatView(dom.previewImg, words, W, H, dataUrl);
    interactions.setMode("image");
  }, built);

  await page.waitForTimeout(400);
  return built;
}

async function main() {
  const server = serveStatic();
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
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

  await browser.close();
  server.close();
  console.log(`\nPNGs + JSON in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
