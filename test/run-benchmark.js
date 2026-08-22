// run-benchmark.js: drives the real app (via Playwright + a local static server,
// no mocking) through each ground-truth image, reads back the Raw-level OCR
// output, and reports CER/WER against the manual transcription in
// test/groundtruth/. Run before and after a pipeline change to get a real
// before/after, not vibes.
//
// Usage: node test/run-benchmark.js
//
// Requires a local Chromium build + Playwright package; see the symlinked
// test/node_modules (borrowed from another local project — this app itself has
// no build step or dependencies) and CHROMIUM_PATH below.

import { chromium } from "playwright-core";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8123;
const CHROMIUM_PATH = join(
  process.env.HOME,
  "Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
);

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

async function scanImage(page, imagePath) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", imagePath);
  await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
  await page.click("#scan-btn");
  // Recognition (including the region-reprocessing passes this benchmark is
  // meant to time) can legitimately take a while on harder images.
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });
  await page.click("#filter-raw-btn");
  return page.$eval("#result-text", (el) => el.value);
}

async function main() {
  const server = serveStatic();
  const groundTruthDir = join(ROOT, "test/groundtruth");
  const files = (await readdir(groundTruthDir)).filter((f) => f.endsWith(".txt"));

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage();

  const rows = [];
  for (const gtFile of files) {
    const name = basename(gtFile, ".txt");
    const imagePath = join(ROOT, "legacy-opencv-scripts", `${name}.jpeg`);
    const reference = await readFile(join(groundTruthDir, gtFile), "utf8");

    const start = Date.now();
    let hypothesis;
    try {
      hypothesis = await scanImage(page, imagePath);
    } catch (err) {
      rows.push({ name, error: err.message });
      continue;
    }
    const elapsedMs = Date.now() - start;

    rows.push({
      name,
      cer: characterErrorRate(hypothesis, reference),
      wer: wordErrorRate(hypothesis, reference),
      elapsedMs,
    });
  }

  await browser.close();
  server.close();

  console.log("\nimage           CER      WER      time");
  console.log("------------------------------------------");
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.name.padEnd(15)} ERROR: ${r.error}`);
      continue;
    }
    console.log(`${r.name.padEnd(15)} ${(r.cer * 100).toFixed(1).padStart(5)}%   ${(r.wer * 100).toFixed(1).padStart(5)}%   ${(r.elapsedMs / 1000).toFixed(1)}s`);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
