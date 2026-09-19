// heic-input.js: HEIC is the default camera format on every iPhone since iOS 11,
// so it is the single most likely input this app will ever be handed on the
// platform it ships to. It is also the one input-hardening case that cannot be
// verified where CI runs.
//
// The split, which is the whole point of this file:
//
//   Headless Chromium on Linux CANNOT decode HEIC. There is no codec in the
//   build. So in CI the only correct assertion is that the app fails SAFELY -
//   a categorized, human-readable message, no uncaught exception, no hang, and
//   no silent success that would render a blank preview and scan nothing.
//
//   A browser WITH the codec - Playwright's WebKit, and WKWebView on iOS, where
//   it is part of the OS - must SUCCEED. That assertion was written at the same
//   time as the failure one, but had nothing to run it: headless Chromium is
//   the only engine CI had.
//
// Both halves are required. The CI half alone would let a real HEIC regression
// on device pass unnoticed; the device half alone would never run.
//
// THE SUCCESS HALF NOW RUNS, AND IT FOUND THE BUG IT WAS WRITTEN FOR. The first
// time this file was pointed at an engine with a codec (BROWSER=webkit, after
// test/browser.js landed), it failed: "This browser CAN decode HEIC, so the scan
// should have succeeded, but the outcome was categorized-error", plus an
// uncaught "Error attempting to read image." from vendor/tesseract.
//
// The cause was in js/ocrEngine.js, not here. Recognition pass 1 handed
// tesseract.js the <img> element, and the engine re-reads the bytes behind its
// src with its OWN decoders - which have no HEIC. The browser had already
// decoded the file perfectly, so the preview looked right and only the scan
// died. js/ocrEngine.js now checks the source's real MIME type and draws
// through a canvas for anything the engine cannot read itself. See the long
// comment there for why that is a pre-check rather than the simpler
// always-use-a-canvas (it costs 8.83 WER points) or a try/catch (tesseract
// dispatches the worker error to window, where no catch reaches it).
//
// What is still NOT claimed: that the app "supports HEIC" everywhere. It
// asserts the failure is graceful where the codec is missing and success where
// it is present. Both are now executed - the first on chromium, the second on
// webkit - so the pair runs in the nightly job rather than waiting for a phone.
//
// Usage: node test/heic-input.js   (exits non-zero if the failure is not graceful)

import { launchBrowser, expectConsoleErrors } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8130;
const HEIC = join(ROOT, "test/images/format-checks/camera-roll.heic");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".heic": "image/heic",
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
};

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
const page = await browser.newPage();

// CI has no HEIC codec and this gate exists to prove the failure is graceful,
// so the caught-and-logged decode failure is the thing being asserted. The
// other half - that it SUCCEEDS on a device, where WKWebView does have the
// codec - is in docs/DEVICE-VERIFICATION-CHECKLIST.md.
expectConsoleErrors(page, [/TextScanner scan failed:/], "no HEIC codec here is the premise of this gate");
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const failures = [];

await page.goto(`http://localhost:${PORT}/index.html`);

// Confirm the premise. If a future Chromium gains HEIC decoding, this test's
// expected outcome inverts, and it should say so rather than silently asserting
// the wrong thing.
const canDecodeHeic = await page.evaluate(async () => {
  const res = await fetch("/test/images/format-checks/camera-roll.heic");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth > 0;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
});

console.log(`This browser can decode HEIC: ${canDecodeHeic}`);

await page.setInputFiles("#file-input", HEIC);

// The app's first gate is `file.type.startsWith("image/")`. A .heic file gets
// type "image/heic" from the OS, so it passes that gate and proceeds to decode -
// which is the interesting path, and the one that has to fail gracefully.
const accepted = await page
  .waitForSelector("#preview-section:not(.hidden)", { timeout: 10000 })
  .then(() => true)
  .catch(() => false);

let outcome;
let message = "";

if (!accepted) {
  // Rejected at the type gate before any decode was attempted.
  outcome = "rejected-at-type-gate";
  message = await page.$eval("#status-section", (el) => el.textContent.trim()).catch(() => "");
} else {
  await page.click("#scan-btn");
  const settled = await page
    .waitForFunction(
      () => {
        const status = document.getElementById("status-section");
        const result = document.getElementById("result-section");
        return (status && status.classList.contains("status--error")) || (result && !result.classList.contains("hidden"));
      },
      null,
      { timeout: 60000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!settled) {
    outcome = "hang";
  } else {
    const errored = await page.$eval("#status-section", (el) => el.classList.contains("status--error")).catch(() => false);
    outcome = errored ? "categorized-error" : "success";
    message = await page.$eval("#status-section", (el) => el.textContent.trim()).catch(() => "");
  }
}

console.log(`outcome=${outcome}`);
console.log(`message="${message}"`);
console.log(`uncaught page errors: ${pageErrors.length}`);

await browser.close();
server.close();

// ---- Assertions ----

if (outcome === "hang") {
  failures.push("The app neither produced a result nor reported an error - a HEIC input hangs it.");
}

if (canDecodeHeic) {
  // Inverted premise: the browser grew a codec. Then success is the only
  // acceptable outcome, and a categorized error would be a real regression.
  if (outcome !== "success") {
    failures.push(
      `This browser CAN decode HEIC, so the scan should have succeeded, but the outcome was "${outcome}". ` +
        `Either the app is rejecting a decodable format, or this test's premise needs revisiting.`
    );
  } else {
    console.log("\nHEIC decoded and scanned successfully - this browser has a codec.");
  }
} else {
  // The expected CI path.
  if (outcome === "success") {
    failures.push(
      "The scan reported success even though this browser cannot decode HEIC. That means it scanned " +
        "a blank or undecoded image and told the user it worked - a silent failure, which is worse than an error."
    );
  }
  if (outcome !== "success" && !message) {
    failures.push("The app failed on HEIC without showing the user any message at all.");
  }
  // The categorized message must be the human-readable kind describeScanError
  // produces, not a raw exception string leaking through.
  if (message && /\b(Error|undefined|null|NaN|\[object)\b/.test(message)) {
    failures.push(`The message shown to the user looks like a raw error rather than a categorized one: "${message}"`);
  }
}

if (pageErrors.length) {
  failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
}

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}

console.log(
  canDecodeHeic
    ? "\nHEIC decoded and scanned successfully on an engine that has the codec.\n" +
        "Confirming the same on a real iPhone's WKWebView is still a device-checklist item,\n" +
        "but it is now a confirmation rather than the only place this could be tested."
    : "\nHEIC fails safely where the codec is missing.\n" +
        "Run this with BROWSER=webkit for the other half - an engine WITH a codec, where the\n" +
        "assertion is that the scan succeeds. The nightly cross-browser job does exactly that."
);
