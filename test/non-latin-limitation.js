// non-latin-limitation.js: pins the CURRENT behaviour of non-Latin recognition,
// which is a known and documented limitation rather than a bug.
//
// This test does NOT assert that non-Latin text is recognized. It is expected
// not to be, on both engines and for two different reasons:
//
//   Web (Tesseract.js)  - js/ocrEngine.js loads the "eng" traineddata and only
//                         that, so a non-Latin script has no model behind it.
//   Native (ML Kit)     - js/mlkitEngine.js requests `script: "LATIN"`. ML Kit
//                         needs a separate bundled model per script with no
//                         universal or auto-detect option, and the other four
//                         are stripped from the binary by
//                         scripts/trim-mlkit-scripts.js.
//
// What it asserts instead is that the limitation stays exactly as understood:
//
//   1. Non-Latin input FAILS SAFELY - a categorized outcome, no uncaught error,
//      no hang. A limitation that crashes is a bug.
//   2. A Latin control through the identical pipeline recognizes WELL. This is
//      the assertion that gives the null result meaning: without it, "recognized
//      nothing" would be equally consistent with a broken harness.
//   3. The measured non-Latin CER is reported as a TRACKED NUMBER. If a future
//      change (the Vision migration in docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md
//      being the obvious one - Vision has automatic multi-script support and
//      would close this) starts recognizing these, that shows up here as a
//      measured delta instead of passing silently.
//   4. The native script hardcode is still LATIN. Nothing in CI can execute the
//      native path, so this is a source-level tripwire: it fires the moment
//      someone changes script selection, which is the change that would
//      invalidate everything above.
//
// Usage: node test/non-latin-limitation.js   (exits non-zero only on 1, 2 or 4)

import { launchBrowser } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8129;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
};

// The Latin control has to clear this for the run to mean anything. Generous:
// the point is "the pipeline demonstrably works on this exact shape of image",
// not a tight accuracy target - run-benchmark.js is where accuracy is measured.
const CONTROL_MAX_CER = 0.25;
// Below this, a "non-Latin" sample would actually be getting recognized, and
// this file's entire premise - and the documentation that rests on it - would
// need rewriting. Deliberately loose: it is a premise check, not a target.
const NON_LATIN_RECOGNIZED_CER = 0.5;

const SAMPLES = [
  { name: "latin-control", script: "Latin (control)", control: true },
  { name: "non-latin-devanagari", script: "Devanagari" },
  { name: "non-latin-cjk", script: "Han (Simplified Chinese)" },
  { name: "non-latin-cyrillic", script: "Cyrillic" },
];

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(ROOT, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
}).listen(PORT);

const browser = await launchBrowser({ headless: true });
const failures = [];
const results = [];

for (const sample of SAMPLES) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, `test/images/non-latin/${sample.name}.png`));
  await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
  await page.click("#scan-btn");

  // Either outcome is acceptable for a non-Latin sample - recognizing nothing
  // and reporting a categorized error are both "failed safely". What is not
  // acceptable is neither happening, which this timeout catches as a hang.
  let outcome = "success";
  try {
    await page.waitForFunction(
      () => {
        const status = document.getElementById("status-section");
        const result = document.getElementById("result-section");
        return (status && status.classList.contains("status--error")) || (result && !result.classList.contains("hidden"));
      },
      null,
      { timeout: 180000 }
    );
    const errored = await page.$eval("#status-section", (el) => el.classList.contains("status--error")).catch(() => false);
    if (errored) outcome = "error";
  } catch {
    outcome = "hang";
  }

  let text = "";
  if (outcome === "success") {
    await page.click("#filter-raw-btn").catch(() => {});
    text = await page.$eval("#result-text", (el) => el.value).catch(() => "");
  }

  const truth = (await readFile(join(ROOT, `test/images/non-latin/${sample.name}.txt`), "utf8")).trim();
  const cer = characterErrorRate(text.trim(), truth);
  await page.close();

  results.push({ ...sample, outcome, cer, pageErrors: pageErrors.length, text: text.trim() });

  console.log(
    `${sample.script.padEnd(26)} outcome=${outcome.padEnd(8)} CER=${(cer * 100).toFixed(1).padStart(6)}%  ` +
      `pageErrors=${pageErrors.length}  text="${text.replace(/\s+/g, " ").trim().slice(0, 60)}"`
  );

  if (outcome === "hang") failures.push(`${sample.name}: neither a result nor a categorized error appeared`);
  if (pageErrors.length) failures.push(`${sample.name}: ${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
}

await browser.close();
server.close();

// 2. The control must actually work, or nothing above means anything.
const control = results.find((r) => r.control);
if (control.outcome !== "success" || control.cer > CONTROL_MAX_CER) {
  failures.push(
    `latin-control: expected a clean recognition (CER <= ${CONTROL_MAX_CER}) but got outcome=${control.outcome} ` +
      `CER=${(control.cer * 100).toFixed(1)}% - the harness itself is broken, so the non-Latin results below prove nothing`
  );
}

// 3. Tracked, not gated - EXCEPT that a non-Latin sample suddenly recognizing
//    well would invalidate this file's premise, so that direction does fail.
console.log("\nKnown limitation, current measurements:");
for (const r of results.filter((x) => !x.control)) {
  console.log(`  ${r.script.padEnd(26)} CER ${(r.cer * 100).toFixed(1)}%`);
  if (r.cer < NON_LATIN_RECOGNIZED_CER) {
    failures.push(
      `${r.name}: CER ${(r.cer * 100).toFixed(1)}% means this script IS being recognized now. ` +
        `That is good news, but it invalidates the documented limitation - update this test, ` +
        `js/mlkitEngine.js's header, docs/VISION-FRAMEWORK-MIGRATION-SCOPE.md and ANALYSIS.md.`
    );
  }
}

// 4. Source-level tripwire on the native path, which CI cannot execute.
const engineSource = await readFile(join(ROOT, "js/mlkitEngine.js"), "utf8");
if (!/script:\s*"LATIN"/.test(engineSource)) {
  failures.push(
    "js/mlkitEngine.js no longer requests script: \"LATIN\". If script selection became dynamic, " +
      "this test's premise changed - re-verify the limitation on device and update it."
  );
}

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nNon-Latin recognition is absent as documented; the Latin control recognizes cleanly.");
