// render-fidelity.js: isolates js/editor.js's renderImageFormatView from whichever
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
    ctx.fillStyle = "#faf3e6";
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#111";

    // [text, fontPx, weight, baselineY, startX] - a poster-like size ladder.
    const lines = [
      [["POPCICHAWK", 118, 700]], // headline
      [["POPSICLES", 62, 700], ["&", 62, 400], ["CHAWK", 62, 700], ["DRAWINGS", 62, 700]],
      [["LOWER", 44, 500], ["RESIDENT", 44, 500], ["LANE", 44, 500]],
      [["BUILDING", 44, 500], ["D", 44, 500], ["AREA", 44, 500]],
      [["RELAXING", 56, 600], ["ON", 56, 600], ["A", 56, 600]],
      [["SUNNY", 56, 600], ["DAY", 56, 600]],
      [["JULY", 92, 700], ["31ST", 92, 700]],
      [["GOOD", 30, 500], ["COMPANY.", 30, 500], ["COOL", 30, 500], ["TREATS.", 30, 500]],
      [["CREATIVE", 30, 500], ["VIBES.", 30, 500]],
      [["Fine", 18, 400], ["print", 18, 400], ["that", 18, 400], ["nobody", 18, 400], ["reads", 18, 400], ["carefully", 18, 400]],
    ];

    const words = [];
    let y = 170;
    lines.forEach((line, lineIndex) => {
      const maxPx = Math.max(...line.map((w) => w[1]));
      let x = 60;
      line.forEach(([text, px, weight]) => {
        ctx.font = `${weight} ${px}px ${family}`;
        const m = ctx.measureText(text);
        ctx.fillText(text, x, y);
        // The ink box, not the advance box - this is what an OCR engine reports,
        // and what renderImageFormatView is handed.
        const x0 = x - m.actualBoundingBoxLeft;
        const x1 = x + m.actualBoundingBoxRight;
        const y0 = y - m.actualBoundingBoxAscent;
        const y1 = y + m.actualBoundingBoxDescent;
        words.push({ lineIndex, text, confidence: 100, bbox: { x0, y0, x1, y1 } });
        x = x + m.width + px * 0.28; // inter-word space
      });
      y += maxPx * 1.5;
    });

    return { dataUrl: canvas.toDataURL("image/png"), words, W, H };
  }, PAGE_SCRIPT(fontMode));

  // Feed the exact boxes into the real renderer, through the real module.
  await page.evaluate(async ({ dataUrl, words, W, H }) => {
    const dom = await import("/js/dom.js");
    const editor = await import("/js/editor.js");
    dom.previewImg.src = dataUrl;
    await dom.previewImg.decode();
    document.getElementById("result-section").classList.remove("hidden");
    editor.renderImageFormatView(dom.previewImg, words, W, H, dataUrl);
    editor.setMode("image");
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
    const drift = await page.evaluate(({ W, H }) => {
      const view = document.getElementById("image-format-view");
      const vb = view.getBoundingClientRect();
      const scale = vb.width / W;
      const rows = [];
      view.querySelectorAll(".image-format-word").forEach((el, i) => {
        const r = el.getBoundingClientRect();
        rows.push({
          i,
          text: el.textContent,
          renderedW: (r.width / scale),
          renderedH: (r.height / scale),
          renderedX: ((r.left - vb.left) / scale),
          renderedY: ((r.top - vb.top) / scale),
        });
      });
      return rows;
    }, built);

    const report = drift.map((d, i) => {
      const w = built.words[i];
      const gtW = w.bbox.x1 - w.bbox.x0;
      const gtH = w.bbox.y1 - w.bbox.y0;
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
      };
    });

    console.log(`\n=== ${fontMode} font ===`);
    console.table(report);
    const ratios = report.map((r) => r.widthRatio);
    console.log(`width ratio: min ${Math.min(...ratios)}  max ${Math.max(...ratios)}  mean ${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)}`);
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
