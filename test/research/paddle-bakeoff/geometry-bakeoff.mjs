// geometry-bakeoff.mjs: the measurement that actually decides the bake-off.
//
//   node geometry-bakeoff.mjs
//
// PADDLEOCR-BAKEOFF.md scored TEXT. This scores GEOMETRY, because this app's
// differentiator is not transcription - it is putting a replacement word back
// at the original word's position, at its size, in a matched face
// (js/editorObjects.js renderImageFormatView, js/fontMatch.js). All of that is
// a function of per-WORD box accuracy. A CER win bought with coarser boxes is a
// net loss here.
//
// ---- WHY test/render-fidelity.js COULD NOT SIMPLY BE POINTED AT THE CANDIDATE ----
//
// That gate is deliberately engine-INDEPENDENT. Its header says so: it "isolates
// renderImageFormatView from whichever OCR engine produced the words" by feeding
// PERFECT boxes into the renderer, so that if perfect boxes render wrong, the
// renderer is at fault regardless of engine. There is no OCR in it to swap. Its
// second half replays test/make-mlkit-fixture.js, which emits COORDINATES ONLY -
// no pixels - so no engine can consume it either.
//
// What that gate does own, and what is reused here verbatim in spirit, is the
// idea that makes it work: a synthetic image whose word boxes are known EXACTLY,
// measured with ctx.measureText's actualBoundingBox metrics rather than
// estimated. This file draws the same poster (same lines, sizes, weights and
// inks as render-fidelity.js's PAGE_SCRIPT), keeps those exact boxes as ground
// truth, then feeds the PIXELS to both engines and compares what each hands back.
//
// The boxes are additionally cross-checked against a pixel-darkness scan of the
// drawn image, so a transcription error in mirroring that poster cannot silently
// become the ground truth - the same "independent ground truth" discipline
// test/pii-redaction.js uses for its coordinate bridge.
//
// ---- MEASURED AT TWO GRANULARITIES, ON PURPOSE ----
//
// Comparing PaddleOCR's output to per-word ground truth and stopping there
// would be rigging the question: PP-OCR is a detector + line recognizer, and
// line boxes are what its architecture produces. So this reports BOTH:
//
//   word-level  - against ground-truth WORD boxes. What the app consumes.
//   line-level  - against ground-truth LINE boxes. Whether the engine is
//                 accurate at the granularity it actually reports.
//
// An engine can be excellent at the second and useless to this app at the first.
// That distinction is the finding, so it is measured rather than asserted.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const MODELS = join(REPO, "vendor-candidate", "paddle", "models");
const OUT = join(HERE, "geometry-out");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".traineddata": "application/octet-stream",
  ".gz": "application/gzip", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".ttf": "font/ttf",
};

let PORT;
async function serveRepo() {
  const server = createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(req.url.split("?")[0]);
      const body = await readFile(join(REPO, p === "/" ? "index.html" : p));
      res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  return server;
}

// ---------------------------------------------------------------------------
// The synthetic poster. Mirrors test/render-fidelity.js's PAGE_SCRIPT content
// so the two harnesses talk about the same picture.
// ---------------------------------------------------------------------------
function drawPoster() {
  const family = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const W = 1024;
  const H = 1536;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";

  const BANDS = [
    { until: 480, bg: [250, 243, 230] },
    { until: 900, bg: [28, 32, 46] },
    { until: 1180, bg: [186, 34, 42] },
    { until: 1536, bg: [245, 245, 245] },
  ];
  let bandTop = 0;
  BANDS.forEach((band) => {
    ctx.fillStyle = `rgb(${band.bg[0]}, ${band.bg[1]}, ${band.bg[2]})`;
    ctx.fillRect(0, bandTop, W, band.until - bandTop);
    bandTop = band.until;
  });

  const lines = [
    [["POPCICHAWK", 118, 700, [180, 30, 40]]],
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
      words.push({
        lineIndex,
        text,
        bbox: {
          x0: x - m.actualBoundingBoxLeft,
          y0: y - m.actualBoundingBoxAscent,
          x1: x + m.actualBoundingBoxRight,
          y1: y + m.actualBoundingBoxDescent,
        },
      });
      x = x + m.width + px * 0.28;
    });
    y += maxPx * 1.5;
  });

  return { dataUrl: canvas.toDataURL("image/png"), words, W, H };
}

// Independent check on the ground truth: every GT box must actually contain
// ink that differs from its band background. Catches a mis-mirrored poster
// before it becomes the yardstick.
function verifyGroundTruthInk({ dataUrl, words, W, H }) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      const bad = [];
      for (const w of words) {
        const x = Math.max(0, Math.floor(w.bbox.x0));
        const y = Math.max(0, Math.floor(w.bbox.y0));
        const bw = Math.min(W - x, Math.ceil(w.bbox.x1 - w.bbox.x0));
        const bh = Math.min(H - y, Math.ceil(w.bbox.y1 - w.bbox.y0));
        if (bw <= 0 || bh <= 0) { bad.push({ text: w.text, why: "empty box" }); continue; }
        const d = cx.getImageData(x, y, bw, bh).data;
        // Variance is the signal: a box sitting on flat background has none.
        //
        // Measured PER CHANNEL, not on luminance. The poster's last line is grey
        // ink on the saturated red band, where the luminance gap is ~10 and a
        // luminance-only check rejects it as blank - while the RED channel gap is
        // ~96 and the text is plainly legible. That is a real property of this
        // fixture (mirrored from render-fidelity.js), not a bug, and it is worth
        // keeping: low-luminance-contrast/high-chroma-contrast text is exactly
        // the kind a binarizing preprocessor destroys.
        const min = [255, 255, 255], max = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          for (let ch = 0; ch < 3; ch++) {
            if (d[i + ch] < min[ch]) min[ch] = d[i + ch];
            if (d[i + ch] > max[ch]) max[ch] = d[i + ch];
          }
        }
        const range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
        if (range < 20) bad.push({ text: w.text, why: `flat box (max channel range ${range})` });
      }
      resolve(bad);
    };
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function iou(a, b) {
  const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}
const centre = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

// Groups ground-truth words into line boxes, so a line-reporting engine can be
// judged at its own granularity.
function groundTruthLines(words) {
  const byLine = new Map();
  for (const w of words) {
    if (!byLine.has(w.lineIndex)) byLine.set(w.lineIndex, []);
    byLine.get(w.lineIndex).push(w);
  }
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([lineIndex, ws]) => ({
    lineIndex,
    text: ws.map((w) => w.text).join(" "),
    bbox: {
      x0: Math.min(...ws.map((w) => w.bbox.x0)),
      y0: Math.min(...ws.map((w) => w.bbox.y0)),
      x1: Math.max(...ws.map((w) => w.bbox.x1)),
      y1: Math.max(...ws.map((w) => w.bbox.y1)),
    },
  }));
}

// Best-overlap match. Text is NOT used: an engine that reads a word wrong but
// boxes it right is a geometry success and a recognition failure, and conflating
// the two is exactly what this file exists to avoid.
function matchByOverlap(truth, found) {
  return truth.map((t) => {
    let best = null;
    let bestIou = 0;
    for (const f of found) {
      const v = iou(t.bbox, f.bbox);
      if (v > bestIou) { bestIou = v; best = f; }
    }
    return { truth: t, found: best, iou: bestIou };
  });
}

function summarize(label, matches, truthCount) {
  const hit = matches.filter((m) => m.iou > 0.5);
  const any = matches.filter((m) => m.iou > 0.1);
  const ious = matches.map((m) => m.iou);
  const meanIou = ious.reduce((a, b) => a + b, 0) / (ious.length || 1);
  const centreErrs = matches.filter((m) => m.found).map((m) => {
    const c1 = centre(m.truth.bbox), c2 = centre(m.found.bbox);
    return Math.hypot(c1.x - c2.x, c1.y - c2.y);
  });
  const heightRatios = matches.filter((m) => m.found).map((m) => {
    const th = m.truth.bbox.y1 - m.truth.bbox.y0;
    const fh = m.found.bbox.y1 - m.found.bbox.y0;
    return th > 0 ? fh / th : 0;
  });
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  return {
    label,
    truthCount,
    meanIou,
    iouOver50: hit.length,
    iouOver10: any.length,
    medianCentreErrorPx: med(centreErrs),
    medianHeightRatio: med(heightRatios),
  };
}

function printSummary(rows) {
  console.log(`${"".padEnd(26)} ${"boxes".padStart(6)} ${"meanIoU".padStart(8)} ${"IoU>.5".padStart(7)} ${"IoU>.1".padStart(7)} ${"centreErr".padStart(10)} ${"htRatio".padStart(8)}`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(26)} ${String(r.truthCount).padStart(6)} ${r.meanIou.toFixed(3).padStart(8)} ` +
        `${`${r.iouOver50}/${r.truthCount}`.padStart(7)} ${`${r.iouOver10}/${r.truthCount}`.padStart(7)} ` +
        `${(isNaN(r.medianCentreErrorPx) ? "-" : r.medianCentreErrorPx.toFixed(1) + "px").padStart(10)} ` +
        `${(isNaN(r.medianHeightRatio) ? "-" : r.medianHeightRatio.toFixed(2) + "x").padStart(8)}`
    );
  }
}

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------
// Tesseract through the REAL APP FLOW - file input, Scan button, then
// state.ocrWords - not through a hand-built Image element.
//
// The difference is not cosmetic. js/ocrEngine.js decides between handing
// Tesseract the <img> (so the engine re-reads the ORIGINAL bytes) and drawing
// through a canvas first, and its header records that always using the canvas
// costs 8.83 WER because rotateAuto derives a different deskew angle from
// browser-decoded RGBA than from the original JPEG bytes. An earlier version of
// this file passed a data: URL and got 35 boxes on complexPic1 where the app
// produces 22 - i.e. it was measuring the rescue path, not the shipping one.
// Both engines now read the same file from disk.
async function tesseractWords(page, imagePath) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", imagePath);
  await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });
  return page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    return {
      W: state.lastNaturalWidth,
      H: state.lastNaturalHeight,
      words: (state.ocrWords || []).map((w) => ({ text: w.text, bbox: w.bbox })),
    };
  });
}

async function paddleBoxes(imagePath) {
  const { PaddleOcrService } = await import("ppu-paddle-ocr");
  const svc = new PaddleOcrService({
    model: {
      detection: join(MODELS, "PP-OCRv6_tiny_det.ort"),
      recognition: join(MODELS, "PP-OCRv6_tiny_rec.ort"),
      charactersDictionary: join(MODELS, "ppocrv6_tiny_dict.txt"),
    },
    processing: { engine: "canvas" },
  });
  await svc.initialize();
  const r = await svc.recognize(imagePath, { flatten: false });
  await svc.destroy();
  const out = [];
  for (const group of r.lines || []) {
    for (const e of group) {
      if (!e.text || !e.text.trim() || !e.box) continue;
      out.push({
        text: e.text.trim(),
        bbox: { x0: e.box.x, y0: e.box.y, x1: e.box.x + e.box.width, y1: e.box.y + e.box.height },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serveRepo();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));

  const report = {};
  try {
    await page.goto(`http://localhost:${PORT}/index.html`);

    // ---- 1. synthetic poster with exact ground truth ----
    const built = await page.evaluate(drawPoster);
    const badGt = await page.evaluate(verifyGroundTruthInk, built);
    console.log(`Ground truth: ${built.words.length} word boxes, ${groundTruthLines(built.words).length} line boxes.`);
    if (badGt.length) {
      console.error(`GROUND TRUTH REJECTED - ${badGt.length} box(es) contain no ink:`);
      badGt.forEach((b) => console.error(`   ${b.text}: ${b.why}`));
      process.exitCode = 1;
      return;
    }
    console.log(`Ground truth verified against a pixel-darkness scan: every box contains ink.\n`);

    const png = Buffer.from(built.dataUrl.split(",")[1], "base64");
    const posterPath = join(OUT, "synthetic-poster.png");
    await writeFile(posterPath, png);

    const tWords = (await tesseractWords(page, posterPath)).words;
    const pBoxes = await paddleBoxes(posterPath);

    const gtWords = built.words;
    const gtLines = groundTruthLines(built.words);

    console.log(`=== SYNTHETIC POSTER, exact ground truth (${built.W}x${built.H}, ${gtWords.length} words, ${gtLines.length} lines) ===\n`);
    console.log("--- against ground-truth WORD boxes (what js/editorObjects.js consumes) ---");
    printSummary([
      summarize("Tesseract (app path)", matchByOverlap(gtWords, tWords), gtWords.length),
      summarize("PaddleOCR PP-OCRv6", matchByOverlap(gtWords, pBoxes), gtWords.length),
    ]);
    console.log("\n--- against ground-truth LINE boxes (the granularity PP-OCR reports) ---");
    printSummary([
      summarize("Tesseract (app path)", matchByOverlap(gtLines, tWords), gtLines.length),
      summarize("PaddleOCR PP-OCRv6", matchByOverlap(gtLines, pBoxes), gtLines.length),
    ]);

    console.log(`\nboxes returned:  Tesseract ${tWords.length}   PaddleOCR ${pBoxes.length}   (ground truth: ${gtWords.length} words / ${gtLines.length} lines)`);
    const tokensPerBox = (boxes) => boxes.reduce((s, b) => s + b.text.split(/\s+/).filter(Boolean).length, 0) / (boxes.length || 1);
    console.log(`tokens per box:  Tesseract ${tokensPerBox(tWords).toFixed(2)}   PaddleOCR ${tokensPerBox(pBoxes).toFixed(2)}   (1.00 = one word per box)`);

    report.synthetic = {
      gtWords: gtWords.length, gtLines: gtLines.length,
      tesseractBoxes: tWords.length, paddleBoxes: pBoxes.length,
      tesseractTokensPerBox: tokensPerBox(tWords), paddleTokensPerBox: tokensPerBox(pBoxes),
      word: {
        tesseract: summarize("t", matchByOverlap(gtWords, tWords), gtWords.length),
        paddle: summarize("p", matchByOverlap(gtWords, pBoxes), gtWords.length),
      },
      line: {
        tesseract: summarize("t", matchByOverlap(gtLines, tWords), gtLines.length),
        paddle: summarize("p", matchByOverlap(gtLines, pBoxes), gtLines.length),
      },
    };

    // ---- 2. real photos: box granularity where there is no box ground truth ----
    console.log("\n\n=== REAL CORPUS IMAGES - box granularity (no box ground truth exists) ===");
    console.log("The two clean product-page screenshots that REGRESSED on CER are marked.\n");
    console.log(`${"image".padEnd(14)} ${"Tess boxes".padStart(11)} ${"Padd boxes".padStart(11)} ${"Tess tok/box".padStart(13)} ${"Padd tok/box".padStart(13)}  note`);
    const notes = { complexPic4: "<- CER regressed", complexPic8: "<- CER regressed", complexPic1: "poster (region-coverage image)" };
    report.corpus = {};
    for (const name of ["complexPic1", "complexPic2", "complexPic4", "complexPic5", "complexPic8", "complexPic9"]) {
      const imgPath = join(REPO, "test/images", `${name}.jpeg`);
      const tw = (await tesseractWords(page, imgPath)).words;
      const pb = await paddleBoxes(imgPath);
      const tpb = tokensPerBox(tw), ppb = tokensPerBox(pb);
      report.corpus[name] = { tesseractBoxes: tw.length, paddleBoxes: pb.length, tesseractTokensPerBox: tpb, paddleTokensPerBox: ppb };
      console.log(
        `${name.padEnd(14)} ${String(tw.length).padStart(11)} ${String(pb.length).padStart(11)} ` +
          `${tpb.toFixed(2).padStart(13)} ${ppb.toFixed(2).padStart(13)}  ${notes[name] || ""}`
      );
    }
  } finally {
    await browser.close();
    server.close();
  }

  await writeFile(join(HERE, "geometry-raw.json"), JSON.stringify(report, null, 2));
  console.log(`\nraw: geometry-raw.json   poster: geometry-out/synthetic-poster.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
