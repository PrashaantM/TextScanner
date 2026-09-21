// scan-latency.js: how long a scan actually takes, gated.
//
// NOTHING IN THIS SUITE MEASURED SCAN TIME BEFORE THIS FILE. 35 gates checked
// what the pipeline produces and none checked what it costs to produce it, so a
// change that doubled every scan would have gone in green. That is not
// hypothetical for this project: the recorded baseline once claimed complexPic6
// took 141,487ms, the claim was cited as evidence in two separate analyses, and
// nothing in CI could have noticed either the number or its wrongness.
//
// ---------------------------------------------------------------------------
// WHY THIS NORMALIZES, AND WHY IT NORMALIZES AGAINST THE MACHINE.
//
// This repo has already paid for the naive version. RECOGNITION-SPIKE.md §2.2
// established that per-image wall-clock does not reproduce across machines -
// complexPic6 recorded at 141,487ms runs in 10.6s at the exact commit that
// recorded it, a 13x discrepancy - and test/run-benchmark.js now FAILS on a
// baseline file that contains an elapsedMs at all. A gate that hard-coded
// "complexPic3 must finish in N ms" would re-introduce precisely the defect the
// rest of the project removed: it would be measuring the CI runner, and it would
// be retuned every time the runner changed until it stopped meaning anything.
//
// So the scan is divided by a MACHINE-SPEED INDEX measured in the same page, in
// the same run: a fixed, deterministic integer loop (40M rounds of an FNV-style
// mix, no allocation, so no GC and no JIT deopt), warmed once and then taken as
// the median of five samples. Measured here at 45.8-49.0ms across fifteen
// samples - about 1% spread - and it returns the same hash every time, so a
// change in its timing is the machine and never the workload.
//
// THE FIRST VERSION OF THIS FILE NORMALIZED AGAINST ANOTHER SCAN, AND THAT WAS
// WRONG. It divided the corpus's worst image by its simplest one, on the
// reasoning that machine speed cancels. It does - and so does any regression in
// a code path BOTH images take. Proving the gate non-vacuous is what caught it:
// injecting one extra whole-image pass into js/ocrEngine.js slowed complexPic5
// from 1,824ms to 2,752ms and complexPic3 from 25,641ms to 29,025ms, and the
// ratio therefore went DOWN, 14.06 to 10.55. The gate passed a deliberate
// regression, in the safest-looking possible way. A calibration has to measure
// something the code under test cannot change.
//
// The simple scan is still run, and still printed - but as a DIAGNOSTIC, never
// as an assertion. When this gate fails it is the first thing worth looking at:
// if the simple scan moved too, the regression is in a shared path.
//
// ---------------------------------------------------------------------------
// WHAT THIS CATCHES, AND WHAT IT DOES NOT. Because the index is the same engine
// doing the same kind of work, the normalized figure carries very little machine
// dependence, and the ceiling can be tight:
//
//   caught      one extra whole-image pass on the hard path - measured, +12%,
//               and the smallest regression worth calling one. Anything larger
//               follows.
//   NOT caught  a change that makes EVERY scan slower in the same proportion as
//               the calibration frame, since that is what the denominator is.
//               The absolute backstop below is the only guard against that, and
//               it is deliberately loose.
//   NOT caught  removing the MAX_REGIONS cap. Measured: it does not move this
//               image at all, because 16 is not what bounds it. A gate that
//               claimed otherwise would be claiming coverage it does not have.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT COVER, stated rather than implied:
//
//   - A PHONE. Every number here is headless Chromium on a developer machine or
//     a CI runner. The device pass (docs/DEVICE-VERIFICATION-CHECKLIST.md) is
//     the only thing that can tell you what a scan costs on the hardware people
//     actually use, and this gate is not a substitute for it.
//   - The cloud tier. js/recognize.js's hybrid branch adds a network round trip
//     this gate never makes; it runs its two halves concurrently so the round
//     trip is not additive, but the local pass measured here is still the floor.
//
// Usage: node test/scan-latency.js
//        node test/scan-latency.js --report   (print measurements, never fail)

import { launchBrowser, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPORT_ONLY = process.argv.includes("--report");

// The corpus's simplest and worst images. Named rather than discovered, because
// which image is the worst case is a measured fact about this corpus
// (test/research/ocr-instrument.mjs) and picking it dynamically would mean the
// gate silently changed subject the day a new image landed.
const CALIBRATION_IMAGE = "complexPic5.jpeg";
const SUBJECT_IMAGE = "complexPic3.jpeg";

// Measured 2026-09-21 on a quiet machine (load average 2.3-3.2), three runs of
// this file via `--report`:
//
//   run   engine index   complexPic3      normalized
//   1     102.2ms        25,702ms         251.5
//   2     102.5ms        25,657ms         250.3
//   3     102.5ms        25,701ms         250.7
//
// Spread 1.2 units - 0.5% - which is what makes a tight ceiling possible at all.
//
// THE CEILING IS 270, AND EVERY NUMBER BEHIND IT WAS MEASURED BY BREAKING THE
// CODE ON PURPOSE rather than reasoned about. An earlier draft of this comment
// asserted that removing the MAX_REGIONS cap would push this to 1,187; running
// it showed the figure does not move AT ALL (555 -> 555 on the old scale),
// because complexPic3 never has more than 16 weak regions to begin with. That
// claim was written before it was measured, which is the failure this project
// keeps naming, and it is recorded here rather than quietly corrected.
//
// What was actually measured, each by injecting the change and re-running:
//
//   one extra whole-image AUTO pass    250.7 -> 280.8 and 282.8 (two runs). FAILS.
//   MAX_REGIONS cap removed (16 -> 10000)  no change. NOT caught, and cannot be:
//                                      the cap is not what bounds this image.
//
// 270 sits 7.4% above the worst clean run (251.5) and 3.9% below the cheapest
// regression measured (280.8). Both margins are thin, deliberately: the index is
// the SAME ENGINE on a fixed frame, so the ratio carries almost no machine
// dependence, and a wide margin would buy portability this design does not need
// while letting a real regression through.
//
// HARD LIMIT, STATED RATHER THAN WORKED AROUND: those margins have NOT been
// validated on a GitHub Actions runner, because this was developed on a Mac and
// there is no CI hardware here to measure. If it proves flaky in practice the
// honest fix is to widen this number ONCE, with the observed spread recorded
// next to it - not to re-run until green.
const MAX_NORMALIZED_SCAN = 270;

// The catastrophe backstop, and the one un-normalized number in this file. The
// worst case measures ~25.6s here; a CI runner is slower, so this is set at
// roughly 4.7x the observed figure. It exists to catch "every scan now takes
// minutes" - the shape of the 141s claim in the old baseline - and deliberately
// nothing subtler than that. Do not tighten it to make it a second normalized
// gate; that is what MAX_NORMALIZED_SCAN is for.
const ABSOLUTE_CEILING_MS = 120_000;

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
const PORT = await listenOnEphemeralPort(server);

const failures = [];
const browser = await launchBrowser({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// Times the scan itself - the click to the result appearing - and not page load
// or file decode. Those are real costs to a user but they are not what this gate
// is about, and including them would put a fixed overhead into both halves of
// the ratio and flatten it.
async function timeScan(imageName) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, "test/images", imageName));
  await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
  const start = Date.now();
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: ABSOLUTE_CEILING_MS + 30_000 });
  const elapsed = Date.now() - start;
  const words = await page.evaluate(async () => (await import("/js/state.js")).state.ocrWords.length);
  return { elapsed, words };
}

// The machine-speed index: ONE Tesseract recognize() call on a fixed synthetic
// frame, warmed once and then sampled five times, median taken so a single
// scheduling hiccup cannot move it.
//
// SAME ENGINE AS THE SUBJECT, ON PURPOSE. An earlier draft used a pure-JS
// integer loop. It was beautifully stable, and it normalized the wrong thing:
// the subject is wasm and the index was JS, so the ratio still carried whatever
// the machine's wasm-versus-JS speed difference happened to be, and the ceiling
// needed a large portability allowance to survive an unfamiliar runner. Timing
// the same engine on a fixed input removes that: what is left is "how many
// calibration frames of work does the worst corpus image provoke", which is a
// property of js/ocrEngine.js and of nothing else.
//
// IT CALLS THE WORKER DIRECTLY rather than going through js/ocrEngine.js, and
// that is what makes it a valid denominator. A change to the pipeline - an added
// pass, a widened trigger - cannot move this number, so it cannot cancel itself
// out of the ratio. That is exactly the defect the first version of this file
// had, described in the header.
async function machineIndex() {
  await page.goto(`http://localhost:${PORT}/index.html`);
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 260;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 900, 260);
    ctx.fillStyle = "#000";
    ctx.font = "44px serif";
    ctx.fillText("The quick brown fox jumps", 20, 70);
    ctx.fillText("over the lazy dog 0123456789", 20, 140);
    ctx.fillText("TextScanner calibration frame", 20, 210);

    const worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: new URL("vendor/tesseract/worker.min.js", document.baseURI).href,
      corePath: new URL("vendor/tesseract/core/", document.baseURI).href,
      langPath: new URL("vendor/tesseract/tessdata/", document.baseURI).href,
      logger: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    await worker.recognize(canvas);

    const samples = [];
    let words = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const result = await worker.recognize(canvas, {}, { blocks: true });
      samples.push(performance.now() - t);
      words = (result.data.blocks || [])
        .flatMap((b) => b.paragraphs || [])
        .flatMap((p) => p.lines || [])
        .flatMap((l) => l.words || []).length;
    }
    await worker.terminate();
    samples.sort((a, b) => a - b);
    return { ms: samples[2], words };
  });
}

// The index is measured BEFORE AND AFTER the subject, and the SLOWER of the two
// is used as the denominator.
//
// This is not belt-and-braces, it is the one failure mode actually observed
// while building this gate. A run that happened to land while the machine was
// loaded (load average 18.5) produced a subject of 98,439ms against an index of
// 102.3ms measured moments earlier, normalizing to 962 - a 3.8x phantom
// regression. The index and the subject are sequential, so a load spike that
// lands inside the subject scan is not normalized away by an index taken before
// it. Bracketing catches the spike in at least one sample and divides by it.
//
// It cannot fix a spike that lands entirely inside the subject scan and nowhere
// near either index sample. That residue is what the diagnostic line and the
// failure message's triage instructions are for.
const indexBefore = await machineIndex();
// The simple scan is a DIAGNOSTIC, not an assertion - see the header for why
// normalizing against it was wrong. It is what tells you, when this gate fails,
// whether the regression is in the hard path or in a shared one.
const simple = await timeScan(CALIBRATION_IMAGE);
const subject = await timeScan(SUBJECT_IMAGE);
const indexAfter = await machineIndex();
const index = indexBefore.ms >= indexAfter.ms ? indexBefore : indexAfter;
const normalized = subject.elapsed / index.ms;

// The calibration frame renders 13 words. Pinned so that an index measured on a
// frame the engine could not read - a blank canvas, a font that failed to load -
// fails loudly instead of producing a meaninglessly small denominator and a
// meaninglessly large ratio. That is the vacuous-pass shape this project keeps
// finding.
const EXPECTED_INDEX_WORDS = 13;

console.log(`engine index     fixed frame, 1 pass    ${indexBefore.ms.toFixed(1)}ms before, ${indexAfter.ms.toFixed(1)}ms after  ${indexBefore.words} words  (slower used)`);
console.log(`diagnostic       ${CALIBRATION_IMAGE.padEnd(18)} ${String(simple.elapsed).padStart(7)}ms  ${simple.words} words  (not asserted)`);
console.log(`subject          ${SUBJECT_IMAGE.padEnd(18)} ${String(subject.elapsed).padStart(7)}ms  ${subject.words} words`);
console.log(`normalized       subject / index        ${normalized.toFixed(1)}  (ceiling ${MAX_NORMALIZED_SCAN})`);
console.log(`absolute         worst-case scan        ${subject.elapsed}ms  (ceiling ${ABSOLUTE_CEILING_MS}ms, catastrophe backstop only)`);

if (indexBefore.words !== EXPECTED_INDEX_WORDS || indexAfter.words !== EXPECTED_INDEX_WORDS) {
  failures.push(
    `the calibration frame recognized ${indexBefore.words}/${indexAfter.words} words, expected ${EXPECTED_INDEX_WORDS}. The index did not measure ` +
      `the work it claims to, so every number above is meaningless. Do not "fix" this by updating the constant unless ` +
      `the frame itself was deliberately changed.`
  );
}

// A scan that produced nothing is fast for the wrong reason, and a normalized
// ceiling would happily pass it. Both scans have to have recognized something or
// the timing means nothing.
if (!simple.words) failures.push(`${CALIBRATION_IMAGE} recognized 0 words - a scan that does nothing is not a fast scan`);
if (!subject.words) failures.push(`${SUBJECT_IMAGE} recognized 0 words - a scan that does nothing is not a fast scan`);

if (normalized > MAX_NORMALIZED_SCAN) {
  failures.push(
    `the worst corpus image now costs ${normalized.toFixed(1)} calibration frames of work, over the ${MAX_NORMALIZED_SCAN} ceiling. ` +
      `This is normalized against a fixed frame put through the SAME engine, measured either side of this scan, so a slow runner cannot cause it. ` +
      `Check ${CALIBRATION_IMAGE} above (${simple.elapsed}ms, usually ~1.8s): if it moved too, the regression is in a ` +
      `path every scan takes. Run \`node test/research/ocr-instrument.mjs complexPic3\` to see which recognize() calls appeared.`
  );
}

if (subject.elapsed > ABSOLUTE_CEILING_MS) {
  failures.push(
    `the worst corpus image took ${subject.elapsed}ms, over the ${ABSOLUTE_CEILING_MS}ms catastrophe backstop. ` +
      `Unlike the normalized figure this IS machine-dependent - check the engine index (${index.ms.toFixed(1)}ms, ` +
      `usually ~103ms) first: if that is also far above normal, this is a loaded machine rather than a regression.`
  );
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (REPORT_ONLY) {
  console.log("\n--report: measurements only, nothing asserted.");
  process.exit(0);
}
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nScan latency is within both ceilings.");
