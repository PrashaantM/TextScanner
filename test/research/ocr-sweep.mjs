// ocr-sweep.mjs: scores one engine/preprocessing variable at a time against the
// whole benchmark corpus, for the RECOGNITION-SPIKE measurement session.
//
//   node test/research/ocr-sweep.mjs               # every variant
//   node test/research/ocr-sweep.mjs --only psm    # one group (psm|dpi|scale|filter|deskew|region|oem)
//   node test/research/ocr-sweep.mjs --list        # names only, run nothing
//
// NOT A CI GATE. Same precedent and same reason as test/research/font-features.mjs
// and test/research/ocr-instrument.mjs: it asserts nothing, it produces a table,
// and a full run is far too slow for a per-push job. That is why it is .mjs
// under test/research/ rather than a test/*.js, which this project's standing
// rule would require to carry a `run:` line in .github/workflows/ci.yml.
//
// ---- WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT ----
//
// It measures the ENGINE, not the app. js/ocrEngine.js is an adaptive
// multi-pass pipeline (raw pass, conditional preprocessed pass, conditional
// sparse retry, coverage rescue, per-region reprocessing). Comparing a
// single-pass variant against THAT would conflate "PSM 6 beats PSM 3" with
// "one pass loses to five", and the second effect is much larger than the
// first.
//
// So the control here is a single pass with exactly the app's first-pass
// settings - PSM.AUTO, oem 1 (LSTM), rotateAuto: true, the untouched image -
// and every variant changes ONE thing against that control. The app's own
// end-to-end number (41.6% CER on the gated eight) is a separate figure,
// produced by test/run-benchmark.js, and the two must not be read as if they
// were on the same axis. The report says so in as many words.
//
// ---- THE CIRCULARITY THIS CANNOT ESCAPE ----
//
// WEB-COMPLETION-PLAN.md §4.4 is correct: tuning against the eleven images that
// produced the current settings is circular. This tool cannot fix that. What it
// can do is separate two kinds of result, and it labels them in its own output:
//
//   CATEGORICAL - a discrete engine setting (a PSM, a filter, LSTM vs legacy).
//     "Helps most images and hurts none" is weak-but-real evidence on 11 images.
//   FITTED - a continuous knob turned until the corpus average improved.
//     That is not evidence at all, it is overfitting, and test/TUNING-2.md §3
//     already rejected doing it on this corpus.
//
// Every variant below is categorical by construction. No numeric threshold in
// js/ocrEngine.js is swept here; test/tune-thresholds.js already does that and
// test/TUNING.md records that the levers do not move this corpus.
//
// The headline is the EIGHT complete-ground-truth images. complexPic7/10/11
// have deliberately partial transcriptions, so reading more real fine print
// scores WORSE on them - see test/partialGroundTruth.js. They are printed, and
// never averaged into the headline.

import { launchBrowser } from "../browser.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate } from "../metrics.js";
import { PARTIAL_GROUND_TRUTH } from "../partialGroundTruth.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const IMAGE_DIR = join(ROOT, "test/images");
const GROUNDTRUTH_DIR = join(ROOT, "test/groundtruth");
// Above the 8123-8153 band the gates in test/ occupy, so this can run beside a
// suite without an EADDRINUSE collision.
const PORT = 8191;

// PSM values are Tesseract's own (see js/ocrEngine.js's FALLBACK_PSM).
const CONTROL = {
  label: "control (app pass 1: psm 3, oem 1, rotateAuto, untouched)",
  group: "control",
  psm: "3", oem: 1, dpi: null, scale: 1, filter: "original", rotateAuto: true, perRegion: false,
};

const VARIANTS = [
  // ---- page segmentation mode ----
  { group: "psm", label: "psm 4 (single column)", psm: "4" },
  { group: "psm", label: "psm 6 (single uniform block)", psm: "6" },
  { group: "psm", label: "psm 11 (sparse text)", psm: "11" },
  { group: "psm", label: "psm 12 (sparse text + OSD)", psm: "12" },

  // ---- DPI hint ----
  // Tesseract warns about unknown DPI and guesses; telling it changes the
  // scale at which it normalizes glyphs before the LSTM sees them.
  { group: "dpi", label: "user_defined_dpi 70", dpi: 70 },
  { group: "dpi", label: "user_defined_dpi 150", dpi: 150 },
  { group: "dpi", label: "user_defined_dpi 300", dpi: 300 },

  // ---- input upscaling ----
  { group: "scale", label: "upscale 1.5x (bicubic)", scale: 1.5 },
  { group: "scale", label: "upscale 2.0x (bicubic)", scale: 2 },
  { group: "scale", label: "downscale 0.75x", scale: 0.75 },

  // ---- js/scanFilters.js, used as OCR preprocessing ----
  // NOT what they were built for: that module's own header says it produces the
  // image the PERSON keeps, while js/preprocess.js produces the image the
  // RECOGNIZER sees. Scoring them here tests whether the split is load-bearing.
  { group: "filter", label: "scanFilters: auto enhance", filter: "auto" },
  { group: "filter", label: "scanFilters: magic colour", filter: "magic" },
  { group: "filter", label: "scanFilters: greyscale", filter: "grayscale" },
  { group: "filter", label: "scanFilters: black & white (binarize)", filter: "bw" },
  { group: "filter", label: "scanFilters: soft B&W (adaptive)", filter: "softbw" },

  // ---- deskew ----
  { group: "deskew", label: "rotateAuto off", rotateAuto: false },

  // ---- per-region OCR ----
  { group: "region", label: "OCR each detected block separately", perRegion: true },

  // ---- engine mode ----
  // oem 3 (LSTM + legacy combined) and oem 0 (legacy only) need a non-LSTM core
  // build AND legacy-capable traineddata. vendor/tesseract/core/ ships only
  // tesseract-core-simd-lstm.wasm.js and tesseract-core-lstm.wasm.js, and
  // vendor/tesseract/tessdata/eng.traineddata.gz is 4.0.0_best_int (LSTM). So
  // this variant CANNOT run offline against the vendored assets. It is listed
  // so the gap is visible in the output rather than silently absent; it skips
  // itself and the report states it as an unmeasured item.
  { group: "oem", label: "oem 3 (LSTM + legacy) - NOT VENDORED, skipped", oem: 3, unrunnable: "vendor/tesseract/core has no legacy wasm build and tessdata is LSTM-only (4.0.0_best_int)" },
];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".gz": "application/gzip",
};

// A bare page on the app's own origin, so `import("/js/scanFilters.js")` and the
// vendored worker/core/tessdata all resolve exactly as they do in the app.
const HARNESS_HTML = `<!doctype html><meta charset="utf-8"><title>ocr-sweep</title>
<script src="/vendor/tesseract/tesseract.min.js"></script>`;

function serveStatic() {
  return createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/__sweep.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(HARNESS_HTML);
    }
    try {
      const body = await readFile(join(ROOT, urlPath === "/" ? "index.html" : urlPath));
      res.writeHead(200, { "Content-Type": MIME[extname(urlPath)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }).listen(PORT);
}

// Runs entirely in the page. Returns the recognized text for one image under
// one variant.
// Takes its two arguments as one array: page.evaluate passes a single value.
async function recognizeInPage([cfg, imageUrl]) {
  const { applyFilter } = await import("/js/scanFilters.js");

  const img = new Image();
  img.src = imageUrl;
  await img.decode();

  // Build the input canvas: scale first, then filter, mirroring the order the
  // app uses (rebuildPage scales/crops, then filters).
  const w = Math.round(img.naturalWidth * cfg.scale);
  const h = Math.round(img.naturalHeight * cfg.scale);
  let canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  if (cfg.filter !== "original") {
    canvas = applyFilter(canvas, cfg.filter);
  }

  const worker = await window.Tesseract.createWorker("eng", cfg.oem, {
    workerPath: new URL("/vendor/tesseract/worker.min.js", location.href).href,
    corePath: new URL("/vendor/tesseract/core/", location.href).href,
    langPath: new URL("/vendor/tesseract/tessdata/", location.href).href,
    logger: () => {},
  });

  const started = performance.now();
  try {
    const params = { tessedit_pageseg_mode: cfg.psm };
    if (cfg.dpi != null) params.user_defined_dpi = String(cfg.dpi);
    await worker.setParameters(params);

    if (!cfg.perRegion) {
      const r = await worker.recognize(canvas, { rotateAuto: cfg.rotateAuto }, { text: true, blocks: true });
      return { text: (r.data.text || "").trim(), ms: Math.round(performance.now() - started), calls: 1 };
    }

    // Per-region: one layout pass, then one recognize() per detected block crop.
    const layout = await worker.recognize(canvas, { rotateAuto: cfg.rotateAuto }, { text: true, blocks: true });
    const blocks = (layout.data.blocks || [])
      .filter((b) => b.bbox && b.bbox.x1 > b.bbox.x0 && b.bbox.y1 > b.bbox.y0)
      // Reading order: top to bottom, then left to right, matching how
      // js/ocrEngine.js's orderRegionsForReading treats regions.
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

    const MARGIN = 6; // js/ocrEngine.js's REGION_CROP_MARGIN
    const pieces = [];
    let calls = 1;
    for (const block of blocks) {
      const x0 = Math.max(0, Math.floor(block.bbox.x0) - MARGIN);
      const y0 = Math.max(0, Math.floor(block.bbox.y0) - MARGIN);
      const x1 = Math.min(canvas.width, Math.ceil(block.bbox.x1) + MARGIN);
      const y1 = Math.min(canvas.height, Math.ceil(block.bbox.y1) + MARGIN);
      const cw = x1 - x0;
      const ch = y1 - y0;
      if (cw <= 8 || ch <= 8) continue;
      const crop = document.createElement("canvas");
      crop.width = cw;
      crop.height = ch;
      crop.getContext("2d").drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
      // js/ocrEngine.js's SINGLE_LINE_ASPECT_RATIO rule.
      await worker.setParameters({ tessedit_pageseg_mode: cw / ch > 6 ? "7" : "6" });
      const r = await worker.recognize(crop, {}, { text: true });
      calls += 1;
      const t = (r.data.text || "").trim();
      if (t) pieces.push(t);
    }
    return { text: pieces.join("\n").trim(), ms: Math.round(performance.now() - started), calls };
  } finally {
    await worker.terminate();
  }
}

function fmt(n) {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const listOnly = process.argv.includes("--list");
  const onlyIdx = process.argv.indexOf("--only");
  const onlyGroup = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;

  const variants = [CONTROL, ...VARIANTS.filter((v) => !onlyGroup || v.group === onlyGroup)];
  if (listOnly) {
    for (const v of variants) console.log(`${v.group.padEnd(9)} ${v.label}`);
    return;
  }

  const files = (await readdir(IMAGE_DIR))
    .filter((f) => /^complexPic\d+\.jpe?g$/i.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const truth = {};
  for (const f of files) {
    const name = basename(f, extname(f));
    truth[name] = await readFile(join(GROUNDTRUTH_DIR, `${name}.txt`), "utf8");
  }

  const server = serveStatic();
  const browser = await launchBrowser({ headless: true });
  const results = [];

  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));
    await page.goto(`http://localhost:${PORT}/__sweep.html`);

    for (const variant of variants) {
      const cfg = { ...CONTROL, ...variant };
      if (variant.unrunnable) {
        console.log(`\n### ${variant.label}\n    SKIPPED: ${variant.unrunnable}`);
        results.push({ ...variant, skipped: variant.unrunnable, perImage: {} });
        continue;
      }
      console.log(`\n### ${cfg.label}`);
      const perImage = {};
      for (const f of files) {
        const name = basename(f, extname(f));
        let out;
        try {
          out = await page.evaluate(recognizeInPage, [cfg, `http://localhost:${PORT}/test/images/${f}`]);
        } catch (err) {
          console.log(`    ${name.padEnd(14)} ERROR ${String(err.message).split("\n")[0]}`);
          perImage[name] = { error: String(err.message).split("\n")[0] };
          continue;
        }
        const cer = characterErrorRate(out.text, truth[name]);
        const wer = wordErrorRate(out.text, truth[name]);
        perImage[name] = { cer, wer, ms: out.ms, calls: out.calls, chars: out.text.length };
        console.log(
          `    ${name.padEnd(14)} CER ${fmt(cer).padStart(7)}  WER ${fmt(wer).padStart(7)}  ` +
            `${String(out.ms).padStart(6)}ms  ${String(out.calls).padStart(3)} call(s)`
        );
      }
      results.push({ ...cfg, perImage });
      await writeFile(join(ROOT, "test/research/ocr-sweep-raw.json"), JSON.stringify(results, null, 2));
    }
  } finally {
    await browser.close();
    server.close();
  }

  // ---- report ----
  const complete = files.map((f) => basename(f, extname(f))).filter((n) => !PARTIAL_GROUND_TRUTH.has(n));
  const mean = (r, names, key) => {
    const vals = names.map((n) => r.perImage[n]).filter((v) => v && typeof v[key] === "number").map((v) => v[key]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  };

  const control = results.find((r) => r.group === "control");
  const baseCer = mean(control, complete, "cer");
  const baseWer = mean(control, complete, "wer");

  console.log(`\n\n=== SWEEP SUMMARY - headline is the EIGHT complete-ground-truth images ===`);
  console.log(`control: CER ${fmt(baseCer)}  WER ${fmt(baseWer)}  (single pass, app's pass-1 settings)`);
  console.log(`\n${"variant".padEnd(46)} ${"ΔCER".padStart(8)} ${"ΔWER".padStart(8)}  better/worse/same  verdict`);
  console.log("-".repeat(46 + 8 + 8 + 30));

  const rows = [];
  for (const r of results) {
    if (r.group === "control") continue;
    if (r.skipped) {
      console.log(`${r.label.padEnd(46)} ${"-".padStart(8)} ${"-".padStart(8)}  UNMEASURED (${r.skipped.slice(0, 40)}…)`);
      rows.push({ label: r.label, skipped: r.skipped });
      continue;
    }
    const dCer = mean(r, complete, "cer") - baseCer;
    const dWer = mean(r, complete, "wer") - baseWer;
    let better = 0, worse = 0, same = 0;
    for (const n of complete) {
      const a = control.perImage[n], b = r.perImage[n];
      if (!a || !b || typeof a.cer !== "number" || typeof b.cer !== "number") continue;
      const d = b.cer - a.cer;
      if (d < -0.001) better += 1;
      else if (d > 0.001) worse += 1;
      else same += 1;
    }
    // The rule this session was given: helps most and hurts NONE is
    // weak-but-real evidence. Anything that trades wins for losses is not.
    const verdict = worse === 0 && better > 0
      ? (better >= 4 ? "WEAK-BUT-REAL (helps many, hurts none)" : "helps a few, hurts none")
      : better === 0 && worse > 0 ? "clearly worse"
      : better === 0 && worse === 0 ? "no effect at all"
      : "mixed - trades wins for losses";
    console.log(
      `${r.label.padEnd(46)} ${(dCer >= 0 ? "+" : "") + (dCer * 100).toFixed(1)}pt`.padEnd(56) +
        `${(dWer >= 0 ? "+" : "") + (dWer * 100).toFixed(1)}pt`.padStart(9) +
        `   ${better}/${worse}/${same}  ${verdict}`
    );
    rows.push({ label: r.label, group: r.group, dCer, dWer, better, worse, same, verdict });
  }

  await writeFile(join(ROOT, "test/research/ocr-sweep-summary.json"),
    JSON.stringify({ control: { cer: baseCer, wer: baseWer }, completeImages: complete, rows }, null, 2));
  console.log(`\nPer-image detail: test/research/ocr-sweep-raw.json`);
  console.log(`Summary:          test/research/ocr-sweep-summary.json`);
  console.log(`\nEvery variant above is CATEGORICAL (a discrete setting), not a fitted threshold.`);
  console.log(`On 11 images that makes "helps many, hurts none" weak-but-real evidence and nothing stronger.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
