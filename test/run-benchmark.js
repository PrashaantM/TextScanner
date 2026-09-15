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
//                                                        # exit non-zero if the COMPLETE-GROUND-TRUTH
//                                                        # average CER or WER regresses by more than
//                                                        # --tolerance percentage points versus the
//                                                        # baseline file - see the note below on why
//                                                        # that average, and not the eleven-image one.
//   node test/run-benchmark.js --check-regression --baseline B --replay R
//                                                        # TESTING ONLY - see --replay's own comment
//                                                        # in main(). Never used by ci.yml.
//
// The browser is resolved by playwright-core's own registry (see test/package.json's
// devDependency and its install-browser script), so this runs from a fresh clone on
// any machine - no absolute paths and no borrowed node_modules, both of which this
// harness previously depended on.
//
// ---- WHY THE GATE IS THE EIGHT-IMAGE AVERAGE, NOT THE ELEVEN-IMAGE ONE ----
//
// complexPic7, complexPic10 and complexPic11 have deliberately partial ground
// truth (test/images/README.md): illegible fine print was left out of the
// transcription rather than guessed at. An engine that correctly reads MORE of
// that real fine print scores WORSE against a transcription that never
// contained it. test/tune-thresholds.js has always excluded them from its
// headline for exactly this reason - this file did not, and its all-eleven
// average was the number --check-regression compared to a tolerance.
//
// Measured at b11ead9: the eight complete-ground-truth images average 41.6%
// CER / 57.1% WER. The three partial ones average 129.9% / 258.5% - dragged up
// by exactly the "more real text, worse-looking score" effect described above.
// All eleven together average 65.7% / 112.0%, which is the number that used to
// be gated. A genuine recognition improvement that reads more of the partial
// images' fine print can push that eleven-image average UP and trip the
// tolerance - this gate could go red for getting better. It now gates on the
// eight-image average only; the partial-image and eleven-image averages are
// still measured and printed, for visibility and continuity, but never
// compared to a tolerance. See test/partialGroundTruth.js for the shared set.

import { launchBrowser, BROWSER_NAME } from "./browser.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate } from "./metrics.js";
import { PARTIAL_GROUND_TRUTH } from "./partialGroundTruth.js";

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

// Wraps browser.js's launcher to keep this file's original, more helpful
// failure message - the one that tells you how to install the browser
// playwright-core actually pins. Named distinctly from the imported
// launchBrowser so the two cannot shadow each other.
async function launchBenchmarkBrowser() {
  try {
    return await launchBrowser({ headless: true });
  } catch (err) {
    throw new Error(
      `Couldn't launch ${BROWSER_NAME}: ${err.message.split("\n")[0]}\n` +
        `Install the browser this playwright-core pins with:  cd test && npm install && npx playwright-core install ${BROWSER_NAME}`
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

  // --replay <path>: TESTING ONLY, never used by ci.yml. Skips driving the
  // browser and takes `rows` from a JSON file's `images` array instead - the
  // same shape --json writes. This is what makes --check-regression's gating
  // arithmetic provable with a synthetic result set in milliseconds, rather
  // than only ever by mutating real OCR output through two more ~70s
  // Playwright scans per proof. See the commit message for both proofs run
  // through this flag.
  const replayFlagIndex = process.argv.indexOf("--replay");
  const replayPath = replayFlagIndex !== -1 ? process.argv[replayFlagIndex + 1] : null;

  let rows;
  if (replayPath) {
    const replay = JSON.parse(await readFile(replayPath, "utf8"));
    rows = replay.images;
  } else {
    const server = serveStatic();
    const files = (await readdir(GROUNDTRUTH_DIR)).filter((f) => f.endsWith(".txt")).sort();

    const browser = await launchBenchmarkBrowser();
    const page = await browser.newPage();

    rows = [];
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
  }

  console.log("\nimage           CER      WER      time");
  console.log("------------------------------------------");
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.name.padEnd(15)} ERROR: ${r.error}`);
      continue;
    }
    const tag = PARTIAL_GROUND_TRUTH.has(r.name) ? " *" : "";
    console.log(`${(r.name + tag).padEnd(15)} ${(r.cer * 100).toFixed(1).padStart(5)}%   ${(r.wer * 100).toFixed(1).padStart(5)}%   ${(r.elapsedMs / 1000).toFixed(1)}s`);
  }

  // Three means, not one - see the header comment for why the eleven-image
  // average cannot be what gates. `complete` is what --check-regression reads;
  // `partial` and `all` are printed for visibility and continuity only.
  const scored = rows.filter((r) => !r.error);
  const complete = scored.filter((r) => !PARTIAL_GROUND_TRUTH.has(r.name));
  const partial = scored.filter((r) => PARTIAL_GROUND_TRUTH.has(r.name));
  const mean = (xs, k) => (xs.length ? xs.reduce((s, r) => s + r[k], 0) / xs.length : 0);
  const completeCer = mean(complete, "cer");
  const completeWer = mean(complete, "wer");
  const partialCer = mean(partial, "cer");
  const partialWer = mean(partial, "wer");
  const allCer = mean(scored, "cer");
  const allWer = mean(scored, "wer");

  if (scored.length) {
    console.log("------------------------------------------");
    console.log(`${`complete-GT (${complete.length})`.padEnd(15)} ${(completeCer * 100).toFixed(1).padStart(5)}%   ${(completeWer * 100).toFixed(1).padStart(5)}%   <- gated`);
    if (partial.length) {
      console.log(`${`partial-GT (${partial.length}) *`.padEnd(15)} ${(partialCer * 100).toFixed(1).padStart(5)}%   ${(partialWer * 100).toFixed(1).padStart(5)}%`);
      console.log("  * directional only - more real text read scores WORSE here, see test/partialGroundTruth.js. Never gated.");
    }
    console.log(`${`all ${scored.length} (info)`.padEnd(15)} ${(allCer * 100).toFixed(1).padStart(5)}%   ${(allWer * 100).toFixed(1).padStart(5)}%   (continuity only, not gated)`);
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
          completeImageCount: complete.length,
          partialImageCount: partial.length,
          // completeCer/completeWer are what --check-regression compares to a
          // tolerance. partialCer/partialWer and allCer/allWer are recorded
          // for visibility and continuity and are never compared to one.
          completeCer,
          completeWer,
          partialCer,
          partialWer,
          allCer,
          allWer,
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
    const cerDeltaPts = completeCer * 100 - baseline.completeCer * 100;
    const werDeltaPts = completeWer * 100 - baseline.completeWer * 100;
    console.log(`Baseline: ${baselinePath}`);
    console.log(`Gated on the ${complete.length}-image complete-ground-truth average (see the header comment for why).`);
    console.log(`CER delta: ${cerDeltaPts >= 0 ? "+" : ""}${cerDeltaPts.toFixed(2)}pts (tolerance ${tolerance}pts)`);
    console.log(`WER delta: ${werDeltaPts >= 0 ? "+" : ""}${werDeltaPts.toFixed(2)}pts (tolerance ${tolerance}pts)`);
    if (cerDeltaPts > tolerance || werDeltaPts > tolerance) {
      // Name the images that actually got worse, not the whole complete set -
      // a regression is useful to act on only if it says where to look.
      const baselineByName = new Map((baseline.images || []).map((r) => [r.name, r]));
      const worsened = complete
        .map((r) => {
          const b = baselineByName.get(r.name);
          if (!b || typeof b.cer !== "number") return null;
          return { name: r.name, dCer: (r.cer - b.cer) * 100, dWer: (r.wer - b.wer) * 100 };
        })
        .filter((d) => d && (d.dCer > 0 || d.dWer > 0))
        .sort((a, b) => b.dCer - a.dCer)
        .map((d) => `${d.name} (${d.dCer >= 0 ? "+" : ""}${d.dCer.toFixed(1)}pt CER, ${d.dWer >= 0 ? "+" : ""}${d.dWer.toFixed(1)}pt WER)`);
      console.error(
        `\nRegression: complete-ground-truth average CER/WER worsened by more than ${tolerance} percentage points ` +
          `versus baseline.\nWorsened: ${worsened.length ? worsened.join(", ") : "(no single image individually worsened - check for a new failure across several)"}`
      );
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
