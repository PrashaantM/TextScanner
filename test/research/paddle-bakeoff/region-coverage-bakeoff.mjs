// region-coverage-bakeoff.mjs: test/region-coverage.js's question, asked of the
// candidate as well as the incumbent.
//
//   node region-coverage-bakeoff.mjs
//
// That gate exists because "an average cannot see a hole": complexPic1 stayed
// inside run-benchmark.js's 2-point tolerance while losing its pink headline AND
// its entire middle band. So it cuts the poster into nine areas that fail
// independently and scores each on its own, against
// test/groundtruth/complexPic1.regions.json.
//
// The gate itself drives the real app, so it measures Tesseract by construction.
// This file asks the same question of both engines, reusing the gate's OWN
// assignment rule verbatim - a word belongs to the region its box CENTRE falls
// in - and the repo's own characterErrorRate. The per-region ceilings
// (`maxCer`) come from the same JSON the gate reads.
//
// The assignment rule is where a coarse box shows itself. A line box spanning
// two regions lands, whole, in whichever region holds its centre: its text is
// credited to one area and missing from the other. That is not an artefact of
// this harness - it is what js/scanDoc.js's PII bridge and
// js/editorObjects.js's renderer would do with the same box.

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const MODELS = join(REPO, "vendor-candidate", "paddle", "models");
const { characterErrorRate } = await import(new URL("../../metrics.js", import.meta.url).href);

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".traineddata": "application/octet-stream",
  ".gz": "application/gzip", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
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

// Lifted from test/region-coverage.js so both engines are scored by the same
// rule the gate uses. Kept as one function taking a plain word list, because the
// gate reads state.ocrWords and this has to work for a list that never went
// through the app at all.
function assignAndJoin(words, spec, W, H) {
  const assigned = spec.regions.map((r) => ({ id: r.id, words: [] }));
  const unassigned = [];
  for (const w of words) {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2 / W;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2 / H;
    const hit = spec.regions.findIndex((r) => cx >= r.box[0] && cx <= r.box[2] && cy >= r.box[1] && cy <= r.box[3]);
    if (hit >= 0) assigned[hit].words.push({ text: w.text, x: w.bbox.x0, y: (w.bbox.y0 + w.bbox.y1) / 2 });
    else unassigned.push({ text: w.text, xPct: +(cx * 100).toFixed(1), yPct: +(cy * 100).toFixed(1) });
  }
  const lineTolerance = H * 0.025;
  const regions = assigned.map((a) => {
    const lines = [];
    for (const w of [...a.words].sort((p, q) => p.y - q.y)) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(w.y - line.y) <= lineTolerance) line.words.push(w);
      else lines.push({ y: w.y, words: [w] });
    }
    return {
      id: a.id,
      wordCount: a.words.length,
      text: lines.map((l) => l.words.sort((p, q) => p.x - q.x).map((w) => w.text).join(" ")).join(" "),
    };
  });
  return { regions, unassigned };
}

async function paddleWords(imagePath) {
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

async function main() {
  const spec = JSON.parse(await readFile(join(REPO, "test/groundtruth/complexPic1.regions.json"), "utf8"));
  const imagePath = join(REPO, "test/images/complexPic1.jpeg");

  const server = await serveRepo();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));

  let tess;
  try {
    // Tesseract through the real app, exactly as the gate drives it.
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.setInputFiles("#file-input", imagePath);
    await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
    await page.click("#scan-btn");
    await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });
    tess = await page.evaluate(async () => {
      const { state } = await import("/js/state.js");
      return {
        W: state.lastNaturalWidth,
        H: state.lastNaturalHeight,
        words: state.ocrWords.map((w) => ({ text: w.text, bbox: w.bbox })),
      };
    });
  } finally {
    await browser.close();
    server.close();
  }

  const padd = await paddleWords(imagePath);

  const t = assignAndJoin(tess.words, spec, tess.W, tess.H);
  const p = assignAndJoin(padd, spec, spec.naturalWidth, spec.naturalHeight);

  console.log(`complexPic1, ${spec.naturalWidth}x${spec.naturalHeight}. Nine areas that fail independently.`);
  console.log(`boxes: Tesseract ${tess.words.length} (word-level)   PaddleOCR ${padd.length} (line-level)\n`);
  console.log(`${"region".padEnd(17)} ${"ceiling".padStart(7)} ${"Tess CER".padStart(9)} ${"Padd CER".padStart(9)}  ${"T words".padStart(7)} ${"P boxes".padStart(7)}  verdict`);
  console.log("-".repeat(96));

  const rows = [];
  for (let i = 0; i < spec.regions.length; i++) {
    const r = spec.regions[i];
    const tCer = characterErrorRate(t.regions[i].text, r.text);
    const pCer = characterErrorRate(p.regions[i].text, r.text);
    const d = pCer - tCer;
    const verdict =
      Math.abs(d) < 0.02 ? "same" :
      d < 0 ? `PaddleOCR better by ${(-d * 100).toFixed(0)}pt` :
      `PaddleOCR WORSE by ${(d * 100).toFixed(0)}pt`;
    rows.push({ id: r.id, maxCer: r.maxCer, tCer, pCer, tWords: t.regions[i].wordCount, pBoxes: p.regions[i].wordCount, verdict });
    console.log(
      `${r.id.padEnd(17)} ${(r.maxCer * 100).toFixed(0).padStart(6)}% ${(tCer * 100).toFixed(1).padStart(8)}% ${(pCer * 100).toFixed(1).padStart(8)}%  ` +
        `${String(t.regions[i].wordCount).padStart(7)} ${String(p.regions[i].wordCount).padStart(7)}  ${verdict}`
    );
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log("-".repeat(96));
  console.log(`${"MEAN".padEnd(17)} ${"".padStart(7)} ${(mean(rows.map((r) => r.tCer)) * 100).toFixed(1).padStart(8)}% ${(mean(rows.map((r) => r.pCer)) * 100).toFixed(1).padStart(8)}%`);
  const better = rows.filter((r) => r.pCer < r.tCer - 0.02).length;
  const worse = rows.filter((r) => r.pCer > r.tCer + 0.02).length;
  console.log(`\nareas where PaddleOCR is better: ${better}/9   worse: ${worse}/9   same: ${9 - better - worse}/9`);
  console.log(`areas over their recorded ceiling - Tesseract: ${rows.filter((r) => r.tCer > r.maxCer).length}/9   PaddleOCR: ${rows.filter((r) => r.pCer > r.maxCer).length}/9`);
  console.log(`\nunassigned boxes (centre outside every region) - Tesseract: ${t.unassigned.length}   PaddleOCR: ${p.unassigned.length}`);

  await writeFile(join(HERE, "region-coverage-raw.json"), JSON.stringify({ rows, tesseract: t, paddle: p }, null, 2));
  console.log(`\nraw: region-coverage-raw.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
