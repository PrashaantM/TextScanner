// replay-dump.js: replays an on-device ML Kit dump (js/mlkitDebug.js) through the
// real Image format renderer, offline, so the positioning bug can be diagnosed
// without a device in the loop.
//
// Companion to test/render-fidelity.js, which already established that
// js/editorObjects.js's renderImageFormatView reproduces a layout faithfully when it's
// given correct boxes. So whatever this produces IS what ML Kit's coordinates say
// - if the replay looks like the "gibberish" seen on-device, the boxes are wrong;
// if it looks fine, the bug is somewhere after recognition.
//
// For each scan in the dump it renders three variants, which between them
// distinguish every hypothesis still standing:
//   raw      - element boundingBox exactly as mlkitEngine.js uses it today
//   corner   - element cornerPoints (the rotated quad the plugin already returns
//              and mlkitEngine.js currently throws away) reduced to its box
//   fitted   - raw boxes rescaled so their union fills the image, which is what a
//              pure coordinate-space/scale mismatch would need to look right
//
// Usage: node test/replay-dump.js <dump.json> [imageDir]
//   imageDir defaults to test/images/, matched to each scan by `label`.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "test/manual-output/replay");
const PORT = 8125;

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

// Mirrors mlkitEngine.js's flattenBlocks exactly, but parameterised by which of
// ML Kit's two geometries to read - so "would cornerPoints have fixed it?" is
// answered from the same dump, with no second device run.
function flatten(blocks, mode) {
  const words = [];
  let lineIndex = -1;
  (blocks || []).forEach((block) => {
    (block.lines || []).forEach((line) => {
      const lineWords = [];
      (line.elements || []).forEach((el) => {
        const text = (el.text || "").trim();
        if (!text) return;
        let bbox;
        if (mode === "corner" && Array.isArray(el.cornerPoints) && el.cornerPoints.length) {
          const xs = el.cornerPoints.map((p) => p.x);
          const ys = el.cornerPoints.map((p) => p.y);
          bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
        } else {
          const b = el.boundingBox;
          if (!b) return;
          bbox = { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom };
        }
        lineWords.push({ text, confidence: 100, bbox });
      });
      if (!lineWords.length) return;
      lineIndex++;
      lineWords.forEach((w) => words.push({ lineIndex, ...w }));
    });
  });
  return words;
}

// Rescales every box so their collective union fills the image. If the "fitted"
// render reads correctly while "raw" doesn't, the bug is a uniform scale factor
// (ML Kit reporting in points, a downscaled decode, ...) rather than anything
// per-word - and the fix is a single multiply in flattenBlocks.
function fitToImage(words, naturalWidth, naturalHeight) {
  if (!words.length) return { words, scaleX: 1, scaleY: 1 };
  const minX = Math.min(...words.map((w) => w.bbox.x0));
  const minY = Math.min(...words.map((w) => w.bbox.y0));
  const maxX = Math.max(...words.map((w) => w.bbox.x1));
  const maxY = Math.max(...words.map((w) => w.bbox.y1));
  const scaleX = naturalWidth / (maxX - minX || 1);
  const scaleY = naturalHeight / (maxY - minY || 1);
  return {
    scaleX,
    scaleY,
    words: words.map((w) => ({
      ...w,
      bbox: {
        x0: (w.bbox.x0 - minX) * scaleX,
        y0: (w.bbox.y0 - minY) * scaleY,
        x1: (w.bbox.x1 - minX) * scaleX,
        y1: (w.bbox.y1 - minY) * scaleY,
      },
    })),
  };
}

async function main() {
  const dumpPath = process.argv[2];
  if (!dumpPath) {
    console.error("Usage: node test/replay-dump.js <dump.json> [imageDir]");
    process.exit(1);
  }
  const imageDir = process.argv[3] || join(ROOT, "test/images");
  const dump = JSON.parse(await readFile(dumpPath, "utf8"));
  const scans = dump.scans || [];

  await mkdir(OUT, { recursive: true });
  const server = serveStatic();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 });

  const summary = [];
  for (const [scanIndex, scan] of scans.entries()) {
    const { label, naturalWidth, naturalHeight, rawResult, extent } = scan;
    // Index-prefixed so re-scanning the same image in one session doesn't
    // overwrite the earlier run's PNGs.
    const stem = `${String(scanIndex).padStart(2, "0")}-${basename(label, extname(label))}`;

    const raw = flatten(rawResult.blocks, "raw");
    const corner = flatten(rawResult.blocks, "corner");
    const fitted = fitToImage(raw, naturalWidth, naturalHeight);

    summary.push({
      scan: scanIndex,
      label,
      words: raw.length,
      image: `${naturalWidth}x${naturalHeight}`,
      boxExtent: extent && extent.elements ? `${Math.round(extent.maxX - extent.minX)}x${Math.round(extent.maxY - extent.minY)}` : "-",
      originX: extent?.minX,
      originY: extent?.minY,
      // The headline number: ~1.0 means ML Kit's boxes already span the image.
      // Only meaningful when the image's text actually reaches its edges - on an
      // image with text only in the middle, a large fitScale is expected and
      // means nothing. Compare it across images, and against fitScaleX/Y agreeing
      // with each other: a real scale bug shows up as both axes off by the SAME
      // factor on an image whose text does span the frame.
      fitScaleX: +fitted.scaleX.toFixed(3),
      fitScaleY: +fitted.scaleY.toFixed(3),
      cornerDiffers: JSON.stringify(raw.map((w) => w.bbox)) !== JSON.stringify(corner.map((w) => w.bbox)),
    });

    let imageDataUrl = null;
    try {
      const bytes = await readFile(join(imageDir, label));
      imageDataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    } catch {
      // Render against a blank background if the source image isn't to hand -
      // word positions are the point, the backdrop is a convenience.
    }

    for (const [variant, words] of [["raw", raw], ["corner", corner], ["fitted", fitted.words]]) {
      // Two screenshots per variant:
      //   <variant>.png         - Image format mode, words on a blank ground. This
      //                           is literally the view judged "gibberish" on-device.
      //   <variant>-overlay.png - the same boxes drawn ON the source photo, which
      //                           is what actually shows whether a word sits over
      //                           the text it was read from. Full image mode
      //                           renders untouched words transparent (so they
      //                           don't read as duplicates of the real text), so
      //                           the overlay re-reveals them with injected CSS
      //                           rather than by changing the app.
      for (const overlay of [false, true]) {
      await page.goto(`http://localhost:${PORT}/index.html`);
      await page.evaluate(
        async ({ words, naturalWidth, naturalHeight, imageDataUrl, overlay }) => {
          const dom = await import("/js/dom.js");
          const objects = await import("/js/editorObjects.js");
    const interactions = await import("/js/editorInteractions.js");
          const src =
            imageDataUrl ||
            (() => {
              const c = document.createElement("canvas");
              c.width = naturalWidth;
              c.height = naturalHeight;
              const x = c.getContext("2d");
              x.fillStyle = "#fff";
              x.fillRect(0, 0, c.width, c.height);
              return c.toDataURL();
            })();
          dom.previewImg.src = src;
          await dom.previewImg.decode();
          document.getElementById("result-section").classList.remove("hidden");
          objects.renderImageFormatView(dom.previewImg, words, naturalWidth, naturalHeight, src);
          interactions.setMode(overlay ? "full" : "image");
          if (overlay) {
            const style = document.createElement("style");
            style.textContent = `
              .image-format-view.show-bg .image-format-word {
                color: #d1004b !important;
                background: rgba(255,255,255,0.55) !important;
                outline: 1px solid rgba(209,0,75,0.8);
              }`;
            document.head.appendChild(style);
          }
        },
        { words, naturalWidth, naturalHeight, imageDataUrl, overlay }
      );
      await page.waitForTimeout(250);
      const view = await page.$("#image-format-view");
      await view.screenshot({ path: join(OUT, `${stem}-${variant}${overlay ? "-overlay" : ""}.png`) });
      }
    }
  }

  console.table(summary);
  await writeFile(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  await browser.close();
  server.close();
  console.log(`\nPNGs + summary.json in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
