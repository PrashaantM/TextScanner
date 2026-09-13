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
//   WKWebView on iOS CAN decode HEIC, natively and without help, because the
//   codec is part of the OS. There the correct assertion is that it succeeds.
//   That half is not automatable here and lives in
//   docs/DEVICE-VERIFICATION-CHECKLIST.md.
//
// Both halves are required. The CI half alone would let a real HEIC regression
// on device pass unnoticed; the device half alone would never run.
//
// A note on what is NOT being asserted: this file does not claim the app
// "supports HEIC". It asserts the failure is graceful where the codec is
// missing. If HEIC support on the web ever becomes a goal, it needs a decoder
// (and a very different test) - see the closing note below.
//
// Usage: node test/heic-input.js   (exits non-zero if the failure is not graceful)

import { launchBrowser } from "./browser.js";
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
  "\nHEIC fails safely where the codec is missing.\n" +
    "The other half of this case - HEIC decoding and scanning correctly on a real iPhone,\n" +
    "where WKWebView has the codec - is in docs/DEVICE-VERIFICATION-CHECKLIST.md and cannot\n" +
    "be verified here."
);
