// detector-probe.mjs: prices the ONE idea worth taking from the PaddleOCR
// bake-off before anyone builds it.
//
//   node detector-probe.mjs
//
// PADDLEOCR-BAKEOFF.md's recommendation names a hybrid: use PP-OCR's DB detector
// ONLY to find regions Tesseract's layout analysis misses, and keep Tesseract
// doing word-level recognition inside them, so word boxes survive. That idea is
// worth exactly as much as its download costs, because it is ADDITIVE - the
// detector ships alongside the whole Tesseract payload, not instead of it.
//
// So this measures the detector's standalone browser payload first and stops if
// it fails. The recognizer is stripped: no rec model, no dictionary, nothing
// but the DB detection graph and the minimum onnxruntime-web entry.
//
// The entry matters and is pinned deliberately. onnxruntime-web's DEFAULT
// import resolves to the JSEP/WebGPU core at 27 MB; `onnxruntime-web/wasm`
// resolves to the plain wasm core at 13.58 MB. Using the default here would
// have made the answer wrong by 13 MB in the wrong direction.
//
// The bar: Tesseract's ENTIRE pipeline - worker, one wasm core and
// eng.traineddata.gz - is 6.75 MB, measured in PADDLEOCR-BAKEOFF.md.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const NM = join(HERE, "node_modules");
const MODELS = join(REPO, "vendor-candidate", "paddle", "models");

// What Tesseract's whole pipeline costs today, for comparison.
const TESSERACT_PAYLOAD_MB = 6.75;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json", ".txt": "text/plain",
  ".jpeg": "image/jpeg", ".png": "image/png", ".ort": "application/octet-stream",
};

// Detection only. No recognition model, no dictionary, no PaddleOcrService.
const PAGE = `<!doctype html><meta charset="utf-8"><title>detector payload probe</title>
<script type="importmap">
{"imports":{
  "onnxruntime-web":"/nm/onnxruntime-web/dist/ort.wasm.min.mjs",
  "ppu-ocv/canvas-web":"/nm/ppu-ocv/index.canvas-web.js"
}}
</script>
<script type="module">
window.__ready = (async () => {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = "/nm/onnxruntime-web/dist/";
  const { DetectionService } = await import("/nm/ppu-paddle-ocr/web/index.js");
  window.__DetectionService = DetectionService;
  return true;
})().catch((e) => { window.__initError = String((e && e.stack) || e); return false; });
</script>`;

let PORT;
async function serve() {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    try {
      if (url === "/" || url === "/index.html") {
        const body = Buffer.from(PAGE);
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(body.length) });
        return res.end(body);
      }
      let file;
      if (url.startsWith("/nm/")) file = join(NM, url.slice(4));
      else if (url.startsWith("/models/")) file = join(MODELS, url.slice(8));
      else if (url.startsWith("/images/")) file = join(REPO, "test/images", url.slice(8));
      else { res.writeHead(404); return res.end("nf"); }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] || "application/octet-stream",
        "Content-Length": String(body.length),
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("nf");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  return server;
}

const server = await serve();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const bytes = new Map();
page.on("response", (r) => {
  const len = Number(r.headers()["content-length"] || 0);
  if (len) bytes.set(r.url(), len);
});
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

await page.goto(`http://localhost:${PORT}/`);
const ok = await page.evaluate(() => window.__ready);
if (!ok) {
  console.error("DETECTOR LOAD FAILED:\n" + (await page.evaluate(() => window.__initError)));
  await browser.close();
  server.close();
  process.exit(1);
}

// Actually run detection, so the payload counted is the payload a working
// detector needs rather than whatever merely parsed.
const result = await page.evaluate(async () => {
  const ort = await import("onnxruntime-web");
  const DetectionService = window.__DetectionService;
  // DetectionService takes an ALREADY-LOADED session - there is no
  // initialize(). That is convenient here: it means the detector can be stood
  // up with nothing but ORT and the detection graph, which is exactly the
  // configuration being priced.
  const t0 = performance.now();
  const session = await ort.InferenceSession.create("/models/PP-OCRv6_tiny_det.ort", {
    executionProviders: ["wasm"],
  });
  const svc = new DetectionService(session);
  const initMs = Math.round(performance.now() - t0);

  const buf = await (await fetch("/images/complexPic1.jpeg")).arrayBuffer();
  const t1 = performance.now();
  const boxes = await svc.run(buf);
  const detectMs = Math.round(performance.now() - t1);
  return { initMs, detectMs, boxCount: Array.isArray(boxes) ? boxes.length : -1 };
});

console.log(`detector initialized in ${result.initMs}ms; detect() on complexPic1 -> ${result.boxCount} boxes in ${result.detectMs}ms\n`);

// The image is the subject, not the payload.
const isImage = (u) => u.includes("/images/");
const engineBytes = [...bytes.entries()].filter(([u]) => !isImage(u));
const total = engineBytes.reduce((s, [, n]) => s + n, 0);

console.log("detection-only browser payload, counted byte by byte:");
for (const [u, n] of engineBytes.sort((a, b) => b[1] - a[1])) {
  if (n < 2048) continue;
  console.log(`  ${(n / 1048576).toFixed(2).padStart(6)} MB  ${u.replace(`http://localhost:${PORT}`, "")}`);
}
const smallCount = engineBytes.filter(([, n]) => n < 2048).length;
if (smallCount) console.log(`  ${"(+" + smallCount + " files under 2 KB)"}`);

const mb = total / 1048576;
console.log(`\n  TOTAL (detection only, no recognizer): ${mb.toFixed(2)} MB`);
console.log(`  Tesseract's ENTIRE pipeline today:      ${TESSERACT_PAYLOAD_MB.toFixed(2)} MB`);
console.log(`  ratio:                                  ${(mb / TESSERACT_PAYLOAD_MB).toFixed(2)}x`);
console.log(`  hybrid total (Tesseract + detector):    ${(mb + TESSERACT_PAYLOAD_MB).toFixed(2)} MB\n`);

if (mb >= TESSERACT_PAYLOAD_MB) {
  console.log("VERDICT: STOP. Detection alone costs more than the whole incumbent pipeline.");
  console.log("The hybrid is additive - the detector ships ALONGSIDE Tesseract, not instead");
  console.log("of it - so adopting it means shipping the sum above. Nothing downstream of");
  console.log("this number is worth measuring until a smaller runtime exists.");
} else {
  console.log("VERDICT: survives the payload gate. Proceed to the missed-region measurement.");
}

await browser.close();
server.close();
