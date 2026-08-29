// tune-thresholds.js: sweeps js/ocrEngine.js's pipeline constants against the
// real benchmark corpus, so a "this change helped" claim is a measurement
// rather than an impression.
//
// Usage:
//   node test/tune-thresholds.js              # run the built-in sweep
//   node test/tune-thresholds.js --baseline   # just re-measure the current code
//
// How it works: patches one or more `const NAME = value;` declarations in
// js/ocrEngine.js on disk, reloads the page (which re-fetches the module), runs
// every corpus image, then restores the file. One browser and one server for
// the whole sweep, since a full pass is ~45s and relaunching per variant would
// dominate the runtime. The original file is restored in a finally block, and
// again on SIGINT - an interrupted sweep must never leave patched constants
// behind.
//
// ---- Reading the output ----
//
// The headline number is CER over the EIGHT images with complete ground truth,
// not the eleven-image average. complexPic7, 10 and 11 have deliberately
// partial transcriptions (illegible fine print was omitted rather than
// guessed), so on those an engine that reads MORE real text scores WORSE. They
// are reported separately and must not be optimized against - tuning to
// minimize the eleven-image average would actively select for reading less.
//
// ---- The honest caveat ----
//
// Eight scoring images is a small sample. A change that improves the mean by a
// point or two is not distinguishable from noise or from overfitting to this
// particular corpus, which is why the sweep prints the per-image deltas: a
// change worth keeping should help broadly, not win on one image and lose on
// three. Growing the corpus (Phase 3 step 1, blocked on new source photos) is
// what would make finer distinctions trustworthy.

import { chromium } from "playwright-core";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Constants live in two files, so the sweep patches both: the stage thresholds
// in ocrEngine.js, and the preprocessing-candidate switches in preprocess.js.
const TUNABLE_FILES = [join(ROOT, "js/ocrEngine.js"), join(ROOT, "js/preprocess.js")];
const IMAGE_DIR = join(ROOT, "test/images");
const GROUNDTRUTH_DIR = join(ROOT, "test/groundtruth");
const PORT = 8124;

// Ground truth for these three deliberately omits illegible fine print, so
// their CER is directional only and is reported apart from the headline.
const PARTIAL_GROUND_TRUTH = new Set(["complexPic7", "complexPic10", "complexPic11"]);

// Each variant is a set of constant overrides applied together. Chosen around
// the levers the completion plan names: the thresholds gating each pipeline
// stage, and the two guards on region reprocessing.
const SWEEP = [
  { label: "baseline (current code)", overrides: {} },

  // Does the SPARSE_TEXT retry help if it fires more often? Scattered text on
  // busy backgrounds is where AUTO segmentation struggles most.
  { label: "retry threshold 40 -> 55", overrides: { RETRY_MEAN_CONFIDENCE_THRESHOLD: 55 } },
  { label: "retry threshold 40 -> 25", overrides: { RETRY_MEAN_CONFIDENCE_THRESHOLD: 25 } },

  // Preprocessing is currently only tried when the raw pass is below 70.
  { label: "preprocess-worth-trying 70 -> 85", overrides: { PREPROCESS_WORTH_TRYING_THRESHOLD: 85 } },
  { label: "preprocess-worth-trying 70 -> 55", overrides: { PREPROCESS_WORTH_TRYING_THRESHOLD: 55 } },

  // Region reprocessing: run it on more images, and on more regions per image.
  { label: "region pass on more images (85 -> 95)", overrides: { SKIP_REGION_PASS_OVERALL_THRESHOLD: 95 } },
  { label: "reprocess more regions (70 -> 80)", overrides: { REGION_REPROCESS_THRESHOLD: 80 } },
  { label: "reprocess fewer regions (70 -> 55)", overrides: { REGION_REPROCESS_THRESHOLD: 55 } },
  { label: "region cap 16 -> 24", overrides: { MAX_REGIONS: 24 } },

  // The two guards against a bad region swap.
  { label: "stricter word-count guard (0.5 -> 0.8)", overrides: { MIN_REGION_WORD_COUNT_RATIO: 0.8 } },
  { label: "looser word-count guard (0.5 -> 0.3)", overrides: { MIN_REGION_WORD_COUNT_RATIO: 0.3 } },
  { label: "zero-word region area 0.08 -> 0.03", overrides: { MAX_ZERO_WORD_REGION_AREA_FRACTION: 0.03 } },
  { label: "zero-word region area 0.08 -> 0.15", overrides: { MAX_ZERO_WORD_REGION_AREA_FRACTION: 0.15 } },

  // The preprocessing lever, rather than a threshold: give the region pass an
  // untouched (upscale-only) candidate to compare against, the way the
  // whole-image pass has always been able to.
  { label: "no raw region candidate", overrides: { REGION_INCLUDE_RAW_CANDIDATE: false } },
  { label: "raw region candidate + reprocess more (80)", overrides: { REGION_INCLUDE_RAW_CANDIDATE: true, REGION_REPROCESS_THRESHOLD: 80 } },
  { label: "raw region candidate + region pass always (95)", overrides: { REGION_INCLUDE_RAW_CANDIDATE: true, SKIP_REGION_PASS_OVERALL_THRESHOLD: 95 } },
];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".gz": "application/gzip",
};

function serveStatic() {
  return createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      const body = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
        // The point of this harness is that the page re-reads a file we just
        // rewrote, so nothing may be cached.
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }).listen(PORT);
}

// Applies overrides across the tunable files, and insists every named constant
// was actually found somewhere - a silent miss would report a variant as
// "no change" when in truth it never ran.
function applyOverrides(originals, overrides) {
  const patched = new Map(originals);
  for (const [name, value] of Object.entries(overrides)) {
    const re = new RegExp(`(const ${name} = )[^;]+;`);
    let found = false;
    for (const [path, source] of patched) {
      if (!re.test(source)) continue;
      patched.set(path, source.replace(re, `$1${value};`));
      found = true;
      break;
    }
    if (!found) throw new Error(`Constant ${name} not found in any tunable file`);
  }
  return patched;
}

async function scanImage(page, imagePath) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", imagePath);
  await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });
  await page.click("#filter-raw-btn");
  return page.$eval("#result-text", (el) => el.value);
}

async function measure(page, corpus) {
  const rows = [];
  for (const { name, imagePath, reference } of corpus) {
    let hypothesis;
    try {
      hypothesis = await scanImage(page, imagePath);
    } catch {
      hypothesis = "";
    }
    rows.push({
      name,
      cer: characterErrorRate(hypothesis, reference),
      wer: wordErrorRate(hypothesis, reference),
    });
  }
  const complete = rows.filter((r) => !PARTIAL_GROUND_TRUTH.has(r.name));
  const partial = rows.filter((r) => PARTIAL_GROUND_TRUTH.has(r.name));
  const mean = (xs, k) => (xs.length ? xs.reduce((s, r) => s + r[k], 0) / xs.length : 0);
  return {
    rows,
    completeCer: mean(complete, "cer"),
    completeWer: mean(complete, "wer"),
    partialCer: mean(partial, "cer"),
  };
}

async function main() {
  const baselineOnly = process.argv.includes("--baseline");
  const originals = new Map();
  for (const path of TUNABLE_FILES) originals.set(path, await readFile(path, "utf8"));

  const restore = async () => {
    for (const [path, source] of originals) await writeFile(path, source);
  };
  process.on("SIGINT", async () => {
    await restore();
    process.exit(130);
  });

  const server = serveStatic();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const gtFiles = (await readdir(GROUNDTRUTH_DIR)).filter((f) => f.endsWith(".txt")).sort();
  const corpus = [];
  for (const f of gtFiles) {
    const name = basename(f, ".txt");
    corpus.push({
      name,
      imagePath: join(IMAGE_DIR, `${name}.jpeg`),
      reference: await readFile(join(GROUNDTRUTH_DIR, f), "utf8"),
    });
  }

  const variants = baselineOnly ? [SWEEP[0]] : SWEEP;
  const results = [];

  try {
    for (const variant of variants) {
      for (const [path, source] of applyOverrides(originals, variant.overrides)) await writeFile(path, source);
      process.stdout.write(`running: ${variant.label} ... `);
      const result = await measure(page, corpus);
      results.push({ ...variant, ...result });
      console.log(
        `complete-GT CER ${(result.completeCer * 100).toFixed(1)}%  WER ${(result.completeWer * 100).toFixed(1)}%  (partial-GT CER ${(result.partialCer * 100).toFixed(1)}%)`
      );
    }
  } finally {
    await restore();
    await browser.close();
    server.close();
  }

  const base = results[0];
  console.log("\n=== Sweep summary (vs. current code), 8 complete-ground-truth images ===\n");
  console.log("variant                                    CER      dCER     WER      dWER");
  console.log("---------------------------------------------------------------------------");
  for (const r of results) {
    const dCer = (r.completeCer - base.completeCer) * 100;
    const dWer = (r.completeWer - base.completeWer) * 100;
    const sign = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
    console.log(
      `${r.label.padEnd(42)} ${(r.completeCer * 100).toFixed(1).padStart(5)}%  ${sign(dCer).padStart(6)}  ${(r.completeWer * 100).toFixed(1).padStart(5)}%  ${sign(dWer).padStart(6)}`
    );
  }

  console.log("\n=== Per-image CER delta vs. current code (negative = better) ===\n");
  const names = base.rows.map((r) => r.name);
  console.log(`${"variant".padEnd(42)}${names.map((n) => n.replace("complexPic", "p").padStart(7)).join("")}`);
  for (const r of results.slice(1)) {
    const cells = r.rows.map((row, i) => {
      const d = (row.cer - base.rows[i].cer) * 100;
      return `${d >= 0 ? "+" : ""}${d.toFixed(1)}`.padStart(7);
    });
    console.log(`${r.label.padEnd(42)}${cells.join("")}`);
  }
  console.log("\n(p7, p10 and p11 have partial ground truth - reading more real text makes them look worse.)\n");
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
