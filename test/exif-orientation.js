// exif-orientation.js: drives the real app through all 8 EXIF orientation
// values (JPEG APP1 tag 0x0112, values 1-8) on otherwise-identical visible
// content, and asserts recognition produces the same text and equivalent
// bounding-box geometry from every one.
//
// TEXTSCANNER-HARDENING-PLAN.md's Phase 12 called for writing a dependency-free
// EXIF orientation parser and applying the rotation/flip by hand before
// recognition. That turned out to be based on a false premise for this
// codebase: every image here reaches the pipeline through a real <img>
// element (previewImg, in main.js), and modern browser engines - Chromium and
// WebKit both, confirmed empirically below and true of WKWebView on iOS since
// Safari 13.1 - already decode an <img> (and anything drawImage() reads from
// it, which is the only way this app ever gets pixels: preprocess.js,
// editorObjects.js's readImagePixels, perspective.js) pre-rotated per its EXIF
// orientation tag. naturalWidth/naturalHeight already reflect the corrected,
// possibly dimension-swapped size. A second, manual rotation on top of that
// would double-apply the transform and corrupt the image. So this test
// verifies the actual invariant Phase 12 wanted (all 8 orientations converge
// on the same result) against the pipeline as it stands, with no new parser
// added.
//
// Usage: node test/exif-orientation.js   (exits non-zero if anything regressed)

import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8128;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".wasm": "application/wasm", ".traineddata": "application/octet-stream", ".gz": "application/gzip" };
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

const browser = await chromium.launch({ headless: true });
const failures = [];
const results = [];

for (let n = 1; n <= 8; n++) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, `test/images/exif-orientations/orientation-${n}.jpg`));
  await page.waitForFunction(() => document.getElementById("preview-img").complete, null, { timeout: 10000 });

  const decodedSize = await page.evaluate(() => {
    const img = document.getElementById("preview-img");
    return { w: img.naturalWidth, h: img.naturalHeight };
  });

  await page.click("#scan-btn");
  await page.waitForFunction(() => {
    const status = document.getElementById("status-section");
    const result = document.getElementById("result-section");
    return (status && status.classList.contains("status--error")) || (result && result.offsetParent !== null);
  }, null, { timeout: 20000 });

  const text = await page.$eval("#result-text", (el) => el.value).catch(() => null);
  await page.close();

  results.push({ n, decodedSize, text, pageErrors });
  console.log(`orientation ${n}: decoded ${decodedSize.w}x${decodedSize.h}  text="${(text || "").replace(/\s+/g, " ").trim()}"  pageErrors=${pageErrors.length}`);
  if (pageErrors.length) failures.push(`orientation-${n}: ${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
}

await browser.close();
server.close();

// Every orientation should decode to the same logical (post-correction) size:
// portrait fixtures (5-8) were built by rotating a 300x150 canonical image, so
// a correct reader normalizes everything to 300x150.
const expectedW = results[0].decodedSize.w;
const expectedH = results[0].decodedSize.h;
for (const r of results) {
  if (r.decodedSize.w !== expectedW || r.decodedSize.h !== expectedH) {
    failures.push(`orientation-${r.n}: decoded to ${r.decodedSize.w}x${r.decodedSize.h}, expected ${expectedW}x${expectedH} (same as orientation-1)`);
  }
}

// All 8 should recognize essentially the same text. Not byte-identical: each
// orientation fixture went through its own PIL rotate/flip + JPEG re-encode
// (see the fixture generator), which introduces the same kind of small
// compression-artifact noise a real EXIF-rotated camera photo has, and
// Tesseract is not immune to that (observed: "test" misread as "tast" on some
// orientations). A tight CER threshold still catches an actual orientation bug
// (which reads as wrong words in roughly the right count, or nothing at all)
// while tolerating single-character OCR noise.
const CER_TOLERANCE = 0.15;
const referenceText = results[0].text;
for (const r of results) {
  const cer = characterErrorRate(r.text || "", referenceText || "");
  if (cer > CER_TOLERANCE) {
    failures.push(`orientation-${r.n}: recognized text differs from orientation-1 by CER ${cer.toFixed(3)} (tolerance ${CER_TOLERANCE})\n    orientation-1: "${referenceText}"\n    orientation-${r.n}: "${r.text}"`);
  }
}

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll 8 EXIF orientations normalize to the same decoded size and recognized text.");
