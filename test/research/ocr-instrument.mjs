// ocr-instrument.mjs: answers "what is the pipeline actually DOING on this
// image?" rather than "how well did it score?" - built for the RECOGNITION-SPIKE
// investigation of the two timing outliers in test/baseline-2026-08-28.json
// (complexPic6 at 141s and complexPic3 at 25.7s, against 1.8-5s for the rest).
//
//   node test/research/ocr-instrument.mjs                 # whole corpus
//   node test/research/ocr-instrument.mjs complexPic6     # one image
//
// NOT A CI GATE, and deliberately so - see test/research/font-features.mjs for
// the same precedent. It asserts nothing, it measures; a gate has to have a
// pass/fail condition and this has only numbers. It is also far too slow for a
// per-push job (the image it exists to study takes over two minutes by itself).
// Hence .mjs in test/research/ rather than a test/*.js, which the project's
// standing rule would require to carry a `run:` line in ci.yml.
//
// ---- HOW IT INSTRUMENTS WITHOUT TOUCHING SHIPPING CODE ----
//
// index.html:879 loads vendor/tesseract/tesseract.min.js as a plain <script>,
// which assigns the `Tesseract` global. An init script installed BEFORE any page
// script runs defines an accessor for `window.Tesseract`, so the assignment is
// intercepted and `createWorker` can be wrapped on the way through. Every
// `recognize()` and `setParameters()` the real js/ocrEngine.js makes is then
// recorded with its page-segmentation mode, source dimensions, duration, word
// count and mean confidence.
//
// js/ is not modified, and neither is index.html. That matters for this
// session specifically: the spike is forbidden from changing the shipping
// pipeline, so the measurement had to be non-invasive rather than a patch that
// gets reverted afterwards.
//
// ---- ON THE DURATIONS THIS PRINTS ----
//
// Wall-clock numbers here are only as quiet as the machine. They were first
// collected while two other processes were driving the same corpus through the
// same engine, which is why the report that quotes this tool leans on the
// CALL COUNTS - which are contention-immune - and treats the milliseconds as
// corroborating rather than load-bearing.

import { launchBrowser } from "../browser.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const IMAGE_DIR = join(ROOT, "test/images");
const GROUNDTRUTH_DIR = join(ROOT, "test/groundtruth");
// 8123-8153 are taken by the gates in test/; this sits above all of them so the
// instrument can run alongside a suite without an EADDRINUSE collision.
const PORT = 8190;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".traineddata": "application/octet-stream",
  ".gz": "application/gzip", ".ttf": "font/ttf",
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

// Installed with page.addInitScript, so it runs before index.html's own
// <script> tags. See the header for why the accessor is necessary.
function instrumentation() {
  window.__ocrLog = { calls: [], params: [], workers: 0 };
  let current = "3"; // js/ocrEngine.js's PSM.AUTO, the value tesseract.js starts at

  const describe = (src) => {
    if (!src) return { kind: "none", w: 0, h: 0 };
    if (src instanceof HTMLCanvasElement) return { kind: "canvas", w: src.width, h: src.height };
    if (src instanceof HTMLImageElement) return { kind: "img", w: src.naturalWidth, h: src.naturalHeight };
    return { kind: String(src && src.constructor && src.constructor.name), w: 0, h: 0 };
  };

  const wrapWorker = (worker) => {
    const origRecognize = worker.recognize.bind(worker);
    const origSetParameters = worker.setParameters.bind(worker);

    worker.setParameters = async (params) => {
      if (params && params.tessedit_pageseg_mode != null) {
        current = String(params.tessedit_pageseg_mode);
        window.__ocrLog.params.push(current);
      }
      return origSetParameters(params);
    };

    worker.recognize = async (source, opts, out) => {
      const started = performance.now();
      const src = describe(source);
      const result = await origRecognize(source, opts, out);
      const words = [];
      (result?.data?.blocks || []).forEach((b) =>
        (b.paragraphs || []).forEach((p) =>
          (p.lines || []).forEach((l) => (l.words || []).forEach((w) => words.push(w)))
        )
      );
      const confs = words.map((w) => (typeof w.confidence === "number" ? w.confidence : 0));
      window.__ocrLog.calls.push({
        psm: current,
        rotateAuto: !!(opts && opts.rotateAuto),
        ms: Math.round(performance.now() - started),
        ...src,
        blocks: (result?.data?.blocks || []).length,
        words: words.length,
        meanConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
        rotateRadians: result?.data?.rotateRadians ?? null,
      });
      return result;
    };
    return worker;
  };

  let stored;
  Object.defineProperty(window, "Tesseract", {
    configurable: true,
    get: () => stored,
    set: (value) => {
      if (value && typeof value.createWorker === "function" && !value.__instrumented) {
        const orig = value.createWorker.bind(value);
        value.createWorker = async (...args) => {
          window.__ocrLog.workers += 1;
          return wrapWorker(await orig(...args));
        };
        value.__instrumented = true;
      }
      stored = value;
    },
  });
}

async function run(page, imagePath) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", imagePath);
  await page.waitForSelector("#preview-section:not(.hidden)", { timeout: 15000 });
  const started = Date.now();
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 300000 });
  const wall = Date.now() - started;
  await page.click("#filter-raw-btn");
  const text = await page.$eval("#result-text", (el) => el.value);
  const log = await page.evaluate(() => window.__ocrLog);
  return { wall, text, log };
}

async function main() {
  const only = process.argv[2];
  const files = (await readdir(IMAGE_DIR))
    .filter((f) => /^complexPic\d+\.jpe?g$/i.test(f))
    .filter((f) => !only || basename(f, extname(f)) === only)
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  if (!files.length) {
    console.error(`No corpus images matched${only ? ` "${only}"` : ""}.`);
    process.exit(2);
  }

  const server = serveStatic();
  const browser = await launchBrowser({ headless: true });
  const rows = [];
  try {
    const page = await browser.newPage();
    await page.addInitScript(instrumentation);

    for (const file of files) {
      const name = basename(file, extname(file));
      const { wall, text, log } = await run(page, join(IMAGE_DIR, file));
      let truth = "";
      try {
        truth = await readFile(join(GROUNDTRUTH_DIR, `${name}.txt`), "utf8");
      } catch {}
      const row = {
        name,
        wall,
        workers: log.workers,
        calls: log.calls.length,
        engineMs: log.calls.reduce((a, c) => a + c.ms, 0),
        wholeImage: log.calls.filter((c) => c.kind === "img" || (c.kind === "canvas" && c.w > 900)).length,
        psmHistogram: log.calls.reduce((acc, c) => ((acc[c.psm] = (acc[c.psm] || 0) + 1), acc), {}),
        slowest: log.calls.slice().sort((a, b) => b.ms - a.ms).slice(0, 3)
          .map((c) => `psm${c.psm} ${c.w}x${c.h} ${c.ms}ms ${c.words}w`),
        chars: text.trim().length,
        truthChars: truth.trim().length,
        calls_detail: log.calls,
      };
      rows.push(row);
      console.log(
        `${name.padEnd(14)} wall ${String(wall).padStart(7)}ms  ` +
          `recognize() x${String(row.calls).padStart(3)}  engine ${String(row.engineMs).padStart(7)}ms  ` +
          `psm ${JSON.stringify(row.psmHistogram)}`
      );
      for (const s of row.slowest) console.log(`${" ".repeat(16)}slowest: ${s}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const outPath = join(ROOT, "test/research/ocr-instrument-raw.json");
  await writeFile(outPath, JSON.stringify(rows, null, 2));

  console.log("\n--- summary, sorted by recognize() call count ---");
  console.log("image           calls   engine ms   wall ms   chars/truth");
  for (const r of rows.slice().sort((a, b) => b.calls - a.calls)) {
    console.log(
      `${r.name.padEnd(14)} ${String(r.calls).padStart(5)} ${String(r.engineMs).padStart(11)} ` +
        `${String(r.wall).padStart(9)}   ${r.chars}/${r.truthChars}`
    );
  }
  console.log(`\nRaw per-call detail written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
