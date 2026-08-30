// malformed-input.js: drives the real app (file input, then Scan text) against
// four deliberately broken/edge-case images and asserts each one resolves to a
// categorized status message - never an uncaught exception, and never an
// indefinite hang with the progress bar stuck and no status update.
//
// This test exists because it found a real bug while being written: a zero-byte
// or non-image file selected before Scan text is clicked hung forever with no
// status update. waitForImageDecode() in main.js checked `img.complete &&
// img.naturalWidth` and, if that was false, attached fresh 'load'/'error'
// listeners - but the image's load attempt (and its error event) happens as
// soon as loadFile() assigns the object URL, well before the user reaches Scan
// text, so the listeners were attached after the only error event had already
// fired and would never fire again. Fixed by resolving/rejecting synchronously
// off img.complete + img.naturalWidth once loading has already finished.
//
// Usage: node test/malformed-input.js   (exits non-zero if anything regressed)
//
// One known, harmless quirk this test does NOT fail on: a truncated JPEG makes
// vendor/tesseract/tesseract.min.js's worker-message handler both (correctly)
// reject the pending recognize() promise - which this app's own try/catch in
// main.js already catches and turns into the right status message - AND
// separately throw the same "Error attempting to read image." synchronously
// from inside its onmessage handler, which surfaces as an uncaught page error
// with no app-code frames in its stack. It doesn't affect app behavior (the
// worker is terminated in ocrEngine.js's `finally` either way, and the next
// scan works normally) and isn't something safe to patch in a vendored,
// minified file, so it's allowlisted below by exact message rather than
// ignored silently.

import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8127;
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

const KNOWN_VENDOR_QUIRKS = ["Error: Error attempting to read image."];

// A well-formed image with an extreme aspect ratio is not malformed - it's
// expected to scan successfully like any other image. The other three are
// genuinely broken input and are expected to fail into a categorized message.
const CASES = [
  { file: "zero-byte.jpg", expect: "error" },
  { file: "truncated-50pct.jpg", expect: "error" },
  { file: "renamed-txt.jpg", expect: "error" },
  { file: "extreme-aspect.jpg", expect: "success" },
];

for (const { file, expect } of CASES) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, "test/images/malformed", file));
  await page.click("#scan-btn");

  let outcome = null;
  try {
    outcome = await page.waitForFunction(() => {
      const status = document.getElementById("status-section");
      const result = document.getElementById("result-section");
      if (status && status.classList.contains("status--error") && status.textContent) return "error";
      if (result && result.offsetParent !== null) return "success";
      return false;
    }, null, { timeout: 20000 }).then((h) => h.jsonValue());
  } catch {
    outcome = null; // timed out - still stuck after 20s, this IS the hang bug
  }

  const statusText = await page.$eval("#status-section", (el) => el.textContent).catch(() => "");
  await page.close();

  console.log(`${file}: outcome=${outcome ?? "HANG/TIMEOUT"}${statusText ? ` ("${statusText}")` : ""} pageErrors=${pageErrors.length}`);

  if (outcome === null) {
    failures.push(`${file}: scan neither errored nor succeeded within 20s (hang, no status update)`);
  } else if (outcome !== expect) {
    failures.push(`${file}: expected outcome "${expect}", got "${outcome}"`);
  }
  const unexpectedErrors = pageErrors.filter((e) => !KNOWN_VENDOR_QUIRKS.includes(e));
  if (pageErrors.length !== unexpectedErrors.length) {
    console.log(`  (${pageErrors.length - unexpectedErrors.length} known vendor quirk error(s) allowlisted, see file header)`);
  }
  if (unexpectedErrors.length) {
    failures.push(`${file}: ${unexpectedErrors.length} uncaught page error(s): ${unexpectedErrors.join("; ")}`);
  }
}

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll malformed-input cases resolved to a categorized outcome.");
