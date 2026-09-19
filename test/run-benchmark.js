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
// ---- TWO NUMBERS ARE PRINTED FOR THE SAME EIGHT IMAGES. READ BOTH. ----
//
//   complete-GT (8)   41.6% CER   <- macro average, one vote per image. GATED.
//   pooled (8)        62.2% CER   <- weighted by how much text each image holds.
//
// They differ by 20 points and neither is wrong. The macro average is the right
// shape for a gate: it stops a single image dominating the tolerance. It is the
// wrong shape for describing how well the engine reads, because this corpus is
// wildly uneven - complexPic3 alone holds 7,351 of the gated eight's 12,511
// ground-truth characters (58.8%) and gets 1/8 of the vote, while complexPic1
// holds 156 characters (1.2%) and gets the same 1/8.
//
// So "41.6% CER" must not be read as "the engine gets 58% of characters right".
// Per character it gets 38% right. The gate is unchanged and still compares the
// macro average only; the pooled figure is reported so the friendlier of the two
// is no longer the only one on screen. RECOGNITION-SPIKE.md §6.
//
// ---- PER-IMAGE TIMINGS ARE PRINTED, NEVER RECORDED ----
//
// The "time" column below is measured live every run. It is deliberately NOT
// written into a baseline file, and --check-regression FAILS on a baseline that
// contains one (see the check at the top of main()).
//
// This is not tidiness. The previous baseline recorded complexPic6 at
// 141,487ms; re-run unmodified at 423de90 - the exact commit that produced that
// file - it takes 10.6s, with byte-identical CER and WER. Nothing read the
// field and nothing gated it, so nothing caught it, and it was cited as
// evidence in two separate analyses before anyone re-measured. A wall-clock
// number is a property of the machine that ran it, and a checked-in baseline is
// precisely what gets compared across machines. RECOGNITION-SPIKE.md §2.2.
//
// refChars/refWords ARE recorded, because a character count is a property of
// the corpus and reproduces anywhere.
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

import { launchBrowser, BROWSER_NAME, listenOnEphemeralPort } from "./browser.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate, referenceLengths } from "./metrics.js";
import { PARTIAL_GROUND_TRUTH } from "./partialGroundTruth.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Assigned by serveStatic() below, once the OS has picked a free port.
// See listenOnEphemeralPort in test/browser.js for why nothing here is fixed.
let PORT;
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

async function serveStatic() {
  const server = createServer(async (req, res) => {
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
  });
  PORT = await listenOnEphemeralPort(server);
  return server;
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

  // Checked BEFORE the browser launches, so a bad baseline fails in
  // milliseconds rather than after a full corpus pass.
  //
  // WHY THIS IS AN ASSERTION AND NOT A COMMENT. The baseline used to carry
  // per-image elapsedMs that did not reproduce - complexPic6 recorded at
  // 141,487ms runs in 10.6s at the very commit that recorded it, with
  // byte-identical output. Nothing read the field, nothing gated it, and it was
  // quoted as evidence in two separate analyses anyway. A note saying "do not
  // trust these" is a comment, and a comment cannot fail; the next person to
  // regenerate a baseline with an older copy of this script would put them
  // straight back. RECOGNITION-SPIKE.md §2.2 has the measurements.
  if (checkRegression) {
    const raw = JSON.parse(await readFile(baselinePath, "utf8"));
    const withTimings = (raw.images || []).filter((r) => typeof r.elapsedMs === "number");
    if (withTimings.length) {
      console.error(
        `\n${basename(baselinePath)} records per-image elapsedMs on ${withTimings.length} image(s).\n` +
          `Wall-clock timings must not be recorded in a baseline: they are a property of the machine\n` +
          `that ran it, a baseline is exactly what people compare across machines, and the last set\n` +
          `was wrong by 13x on complexPic6 while nothing in CI could notice.\n` +
          `Re-record with --json (this script strips the field), or delete it by hand.\n` +
          `Per-run durations still print in the "time" column above. See RECOGNITION-SPIKE.md §2.2.`
      );
      process.exit(1);
    }
  }

  let rows;
  if (replayPath) {
    const replay = JSON.parse(await readFile(replayPath, "utf8"));
    rows = replay.images;
  } else {
    const server = await serveStatic();
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

      const { chars: refChars, words: refWords } = referenceLengths(reference);
      rows.push({
        name,
        cer: characterErrorRate(hypothesis, reference),
        wer: wordErrorRate(hypothesis, reference),
        // Carried so the pooled averages below can weight each image by how
        // much text it actually holds. Recorded in a baseline too, unlike
        // elapsedMs - a character count is a property of the corpus and
        // reproduces anywhere; a wall-clock time is a property of the machine
        // and does not. See the writer below.
        refChars,
        refWords,
        // Measured and printed live, deliberately NOT written to a baseline.
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

  // ---- POOLED (text-length-weighted) averages ----
  //
  // The macro average above gives every image one vote regardless of how much
  // text it holds, which is the right shape for a GATE - it stops one image
  // dominating, and it is what --check-regression compares, unchanged.
  //
  // It is the wrong shape for describing how well the engine reads, and on this
  // corpus the gap is 20 points. complexPic3 holds 7,351 of the gated eight's
  // 12,511 ground-truth characters - 58.8% of all the text - and gets 1/8 of
  // the vote. complexPic1 holds 156 characters (1.2%) and gets the same 1/8.
  //
  // Pooling re-weights by text: total edit distance over total reference
  // length, which is what a person holding one of these images actually
  // experiences. Measured 2026-09-18: macro 41.6% CER, pooled 62.2%. Reporting
  // only the macro number let the friendlier of the two be the only one on
  // screen. Both are printed now; only macro is gated. RECOGNITION-SPIKE.md §6.
  //
  // cer * refChars recovers the edit distance the rate was divided by, so this
  // needs no second pass over the text. Rows from --replay may predate the
  // refChars field, so a pooled figure is only reported when every scored row
  // carries one rather than silently averaging over a subset.
  const canPool = (xs) => xs.length > 0 && xs.every((r) => typeof r.refChars === "number" && typeof r.refWords === "number");
  const pooled = (xs, rateKey, lenKey) =>
    xs.reduce((s, r) => s + r[rateKey] * r[lenKey], 0) / xs.reduce((s, r) => s + r[lenKey], 0);
  const completePooledCer = canPool(complete) ? pooled(complete, "cer", "refChars") : null;
  const completePooledWer = canPool(complete) ? pooled(complete, "wer", "refWords") : null;

  if (scored.length) {
    console.log("------------------------------------------");
    console.log(`${`complete-GT (${complete.length})`.padEnd(15)} ${(completeCer * 100).toFixed(1).padStart(5)}%   ${(completeWer * 100).toFixed(1).padStart(5)}%   <- gated`);
    if (partial.length) {
      console.log(`${`partial-GT (${partial.length}) *`.padEnd(15)} ${(partialCer * 100).toFixed(1).padStart(5)}%   ${(partialWer * 100).toFixed(1).padStart(5)}%`);
      console.log("  * directional only - more real text read scores WORSE here, see test/partialGroundTruth.js. Never gated.");
    }
    console.log(`${`all ${scored.length} (info)`.padEnd(15)} ${(allCer * 100).toFixed(1).padStart(5)}%   ${(allWer * 100).toFixed(1).padStart(5)}%   (continuity only, not gated)`);
    if (completePooledCer !== null) {
      const totalChars = complete.reduce((s, r) => s + r.refChars, 0);
      const biggest = complete.slice().sort((a, b) => b.refChars - a.refChars)[0];
      console.log("------------------------------------------");
      console.log(
        `${`pooled (${complete.length})`.padEnd(15)} ${(completePooledCer * 100).toFixed(1).padStart(5)}%   ${(completePooledWer * 100).toFixed(1).padStart(5)}%   <- same 8 images, weighted by text length`
      );
      console.log(
        `  The two lines marked (${complete.length}) are the same images scored two ways. "complete-GT" gives each image one\n` +
          `  vote and is what the tolerance gates; "pooled" divides total edit distance by total reference\n` +
          `  length. Pooled is what a reader experiences. On this corpus ${biggest.name} alone is ` +
          `${((biggest.refChars / totalChars) * 100).toFixed(1)}% of the\n  ${totalChars} gated characters and still gets 1/${complete.length} of the macro vote. See RECOGNITION-SPIKE.md §6.`
      );
    }
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
          // Weighted by text length over the same gated images. Never compared
          // to a tolerance - recorded so the 20-point gap between the two is
          // visible in the file as well as on screen.
          completePooledCer,
          completePooledWer,
          partialCer,
          partialWer,
          allCer,
          allWer,
          // elapsedMs is deliberately STRIPPED here rather than recorded.
          //
          // The previous baseline carried it, and the numbers did not
          // reproduce: it recorded complexPic6 at 141,487ms, and the same
          // commit re-run on a quiet machine does it in 10.6s with
          // byte-identical output (RECOGNITION-SPIKE.md §2.2). Nothing read the
          // field and nothing gated it, so nothing caught it - but it was cited
          // as evidence in two separate analyses before anyone re-measured.
          //
          // A wall-clock time is a property of the machine that ran it, and a
          // checked-in baseline is exactly the place people compare ACROSS
          // machines. The live per-image "time" column above still prints every
          // run, which is where a duration is meaningful. refChars/refWords are
          // kept because a character count is a property of the corpus and
          // reproduces anywhere.
          images: rows.map(({ elapsedMs, ...rest }) => rest),
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
