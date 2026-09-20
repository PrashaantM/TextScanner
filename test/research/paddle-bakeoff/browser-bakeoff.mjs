// browser-bakeoff.mjs: the half of the PaddleOCR bake-off that node cannot
// answer - what a BROWSER pays. Serves onnxruntime-web, ppu-paddle-ocr/web and
// the local PP-OCRv6 models over HTTP with an import map (no bundler, matching
// this repo's no-build-step constraint), then measures:
//
//   - bytes actually fetched to get to first text (the real payload)
//   - cold start: module load + wasm compile + session init
//   - warm per-image recognition time
//
// Threads are pinned to 1 so the page does not need SharedArrayBuffer and
// therefore no COOP/COEP isolation - which is also the configuration that would
// ship, since GitHub Pages cannot set those headers.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const NM = join(HERE, "node_modules");
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const MODELS = join(REPO, "vendor-candidate", "paddle", "models");
const PORT = 8192;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json", ".txt": "text/plain",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".ort": "application/octet-stream",
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>paddle bakeoff</title>
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
  const mod = await import("/nm/ppu-paddle-ocr/web/index.js");
  window.__ort = ort;
  window.__paddle = mod;
  return true;
})().catch((e) => { window.__initError = String(e && e.stack || e); return false; });
</script>`;

function serve() {
  return createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    try {
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(Buffer.byteLength(PAGE)) });
        return res.end(PAGE);
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
  }).listen(PORT);
}

const server = serve();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Count every byte the page actually pulls, which is the payload question.
const bytes = new Map();
page.on("response", async (r) => {
  try {
    const len = Number(r.headers()["content-length"] || 0);
    if (len) bytes.set(r.url(), len);
  } catch {}
});
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("[console]", m.text()); });

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/`);
const ok = await page.evaluate(() => window.__ready);
if (!ok) {
  console.error("MODULE LOAD FAILED:\n" + (await page.evaluate(() => window.__initError)));
  await browser.close();
  server.close();
  process.exit(1);
}
const moduleLoadMs = Date.now() - t0;
console.log(`module graph loaded (import map, no bundler): ${moduleLoadMs}ms`);

const result = await page.evaluate(async () => {
  const { PaddleOcrService } = window.__paddle;
  const model = {
    detection: "/models/PP-OCRv6_tiny_det.ort",
    recognition: "/models/PP-OCRv6_tiny_rec.ort",
    charactersDictionary: "/models/ppocrv6_tiny_dict.txt",
  };
  const t = performance.now();
  const svc = new PaddleOcrService({ model, processing: { engine: "canvas" } });
  await svc.initialize();
  const coldStartMs = Math.round(performance.now() - t);

  // First recognition after init - the user-visible "time to first text".
  const t1 = performance.now();
  const first = await svc.recognize("/images/complexPic5.jpeg", { flatten: true });
  const firstRecognizeMs = Math.round(performance.now() - t1);

  const warm = [];
  for (const n of ["complexPic1", "complexPic5", "complexPic3"]) {
    const t2 = performance.now();
    const r = await svc.recognize(`/images/${n}.jpeg`, { flatten: true });
    warm.push({ name: n, ms: Math.round(performance.now() - t2), chars: (r.text || "").trim().length });
  }
  await svc.destroy();
  return { coldStartMs, firstRecognizeMs, firstChars: (first.text || "").trim().length, warm };
});

console.log(`cold start (wasm compile + both ONNX sessions): ${result.coldStartMs}ms`);
console.log(`first recognize (complexPic5): ${result.firstRecognizeMs}ms -> ${result.firstChars} chars`);
console.log(`time to first text from page load: ${moduleLoadMs + result.coldStartMs + result.firstRecognizeMs}ms`);
for (const w of result.warm) console.log(`  warm ${w.name}: ${w.ms}ms -> ${w.chars} chars`);

const total = [...bytes.entries()].reduce((s, [, n]) => s + n, 0);
console.log(`\nbytes fetched by the page: ${(total / 1048576).toFixed(2)} MB across ${bytes.size} responses`);
for (const [u, n] of [...bytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${(n / 1048576).toFixed(2).padStart(6)} MB  ${u.replace(`http://localhost:${PORT}`, "")}`);
}

await browser.close();
server.close();
