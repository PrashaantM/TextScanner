// run-benchmark.js: drives the real app (via Playwright + a local static server,
// no mocking) through each ground-truth image, reads back the Raw-level OCR
// output, and reports CER/WER against the manual transcription in
// test/groundtruth/. Run before and after a pipeline change to get a real
// before/after, not vibes.
//
// Usage:
//   cd test && npm install && npm run install-browser   # once, per clone
//   node test/run-benchmark.js                          # from the repo root
//   node test/run-benchmark.js --json out.json          # also write a baseline file
//   node test/run-benchmark.js --check-regression --baseline test/baseline-2026-08-28.json --tolerance 2.0
//                                                        # exit non-zero if average CER or WER
//                                                        # regresses by more than --tolerance
//                                                        # percentage points versus the baseline file
//
// The browser is resolved by playwright-core's own registry (see test/package.json's
// devDependency and its install-browser script), so this runs from a fresh clone on
// any machine - no absolute paths and no borrowed node_modules, both of which this
// harness previously depended on.

import { chromium } from "playwright-core";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8123;
// The benchmark corpus and its ground truth live side by side under test/ (the
// corpus used to sit in a folder named legacy-opencv-scripts/, which hid it).
const IMAGE_DIR = join(ROOT, "test/images");
const GROUNDTRUTH_DIR = join(ROOT, "test/groundtruth");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
};

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

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `Couldn't launch Chromium: ${err.message.split("\n")[0]}\n` +
        `Install the browser this playwright-core pins with:  cd test && npm install && npm run install-browser`
    );
  }
}

async function main() {
  const jsonFlagIndex = process.argv.indexOf("--json");
  const jsonOutPath = jsonFlagIndex !== -1 ? process.argv[jsonFlagIndex + 1] : null;

  const checkRegression = process.argv.includes("--check-regression");
  const baselineFlagIndex = process.argv.indexOf("--baseline");
  const baselinePath = baselineFlagIndex !== -1 ? process.argv[baselineFlagIndex + 1] : null;
  const toleranceFlagIndex = process.argv.indexOf("--tolerance");
  const tolerance = toleranceFlagIndex !== -1 ? Number(process.argv[toleranceFlagIndex + 1]) : 2.0;

  if (checkRegression && !baselinePath) {
    console.error("--check-regression requires --baseline <path>");
    process.exitCode = 1;
    return;
  }

  const server = serveStatic();
  const files = (await readdir(GROUNDTRUTH_DIR)).filter((f) => f.endsWith(".txt")).sort();

  const browser = await launchBrowser();
  const page = await browser.newPage();

  const rows = [];
  for (const gtFile of files) {
    const name = basename(gtFile, ".txt");
    const imagePath = join(IMAGE_DIR, `${name}.jpeg`);
    const reference = await readFile(join(GROUNDTRUTH_DIR, gtFile), "utf8");

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

  const scored = rows.filter((r) => !r.error);
  const avgCer = scored.length ? scored.reduce((s, r) => s + r.cer, 0) / scored.length : 0;
  const avgWer = scored.length ? scored.reduce((s, r) => s + r.wer, 0) / scored.length : 0;
  if (scored.length) {
    console.log("------------------------------------------");
    console.log(`${"average".padEnd(15)} ${(avgCer * 100).toFixed(1).padStart(5)}%   ${(avgWer * 100).toFixed(1).padStart(5)}%`);
  }
  console.log();

  if (jsonOutPath) {
    await writeFile(
      jsonOutPath,
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          engine: "tesseract.js (web path)",
          imageCount: scored.length,
          averageCer: avgCer,
          averageWer: avgWer,
          images: rows,
        },
        null,
        2
      )}\n`
    );
    console.log(`Wrote ${jsonOutPath}\n`);
  }

  if (checkRegression) {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const cerDeltaPts = avgCer * 100 - baseline.averageCer * 100;
    const werDeltaPts = avgWer * 100 - baseline.averageWer * 100;
    console.log(`Baseline: ${baselinePath}`);
    console.log(`CER delta: ${cerDeltaPts >= 0 ? "+" : ""}${cerDeltaPts.toFixed(2)}pts (tolerance ${tolerance}pts)`);
    console.log(`WER delta: ${werDeltaPts >= 0 ? "+" : ""}${werDeltaPts.toFixed(2)}pts (tolerance ${tolerance}pts)`);
    if (cerDeltaPts > tolerance || werDeltaPts > tolerance) {
      console.error(`\nRegression: average CER/WER worsened by more than ${tolerance} percentage points versus baseline.`);
      process.exitCode = 1;
      return;
    }
    console.log("\nNo regression beyond tolerance.\n");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
