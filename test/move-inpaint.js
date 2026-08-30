// move-inpaint.js: drives the real editor - scan a real photo, enter Full
// image + Move components, drag a recognized word away from its original
// spot - and asserts the vacated region shows the inpainted patch, not the
// untouched source pixels.
//
// TEXTSCANNER-HARDENING-PLAN.md's Phase 13 described this as an open gap: the
// patch-application function was assumed to run only for the delete handler,
// gated behind editorObjects.js's `modified` display-state check, and moving a
// word was assumed to leave the original pixels visible underneath. Measured
// here instead of assumed: refreshModifiedStatesFor already flips a moved
// word's `modified` flag true (its x/y changed from originalX/originalY),
// which already unconditionally reveals patchEl and calls the same
// onPatchNeeded callback the delete handler uses - see beginObjectDrag in
// editorInteractions.js and refreshModifiedStatesFor in editorObjects.js. No
// gap found; this test locks in that finding as a regression test rather than
// leaving it as a one-time manual observation. (A likely explanation: this
// was already fixed by the "unblock the drag and delete" work mentioned in
// this repo's commit history, and the plan's Phase 13 description predates
// that fix.)
//
// Method: screenshot the raw #image-format-bg element (the untouched source
// photo, nothing drawn over it) cropped to the target word's rect BEFORE any
// interaction - this is what "original pixels still showing" looks like.
// Compare that, pixel-by-pixel, against a screenshot of the same rect on the
// live, composited view AFTER the word is dragged away. A patch that's really
// filling the gap changes the pixels there by a wide margin (Gauss-Seidel
// inpainting blends surrounding content, not a copy of the raw source); a
// gap that leaves raw pixels showing does not.
//
// Usage: node test/move-inpaint.js   (exits non-zero if anything regressed)

import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8129;
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

const failures = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic5.jpeg"));
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
await page.click("#mode-full-btn");
await page.click("#editor-mode-btn");
await page.evaluate(() => document.getElementById("image-format-view").scrollIntoView({ block: "start" }));
await page.waitForTimeout(300);

const target = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  window.__state = state;
  const vh = window.innerHeight,
    vw = window.innerWidth;
  const words = state.editorObjects.filter((o) => o.type === "word" && o.el.textContent.trim());
  for (const w of words) {
    const r = w.el.getBoundingClientRect();
    const cx = r.left + r.width / 2,
      cy = r.top + r.height / 2;
    if (cx > 40 && cx < vw - 200 && cy > 80 && cy < vh - 200 && r.width > 20 && r.height > 10) {
      window.__target = w.id;
      return { id: w.id, x: cx, y: cy, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
    }
  }
  return null;
});

if (!target) {
  console.error("FAILED: no eligible word found to drag");
  process.exit(1);
}

const rawBgShot = await page.locator("#image-format-bg").screenshot({ clip: target.rect });

await page.mouse.move(target.x, target.y);
await page.mouse.down();
await page.mouse.move(target.x + 150, target.y + 120, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(300);

const patchState = await page.evaluate(() => {
  const o = window.__state.editorObjects.find((x) => x.id === window.__target);
  const cs = getComputedStyle(o.patchEl);
  return { display: cs.display, hasBackgroundImage: cs.backgroundImage !== "none", modified: o.modified, moved: o.x !== o.originalX || o.y !== o.originalY };
});
console.log("patch state after move:", patchState);
if (!patchState.moved) failures.push("word did not actually move - test setup is broken, not the thing under test");
if (patchState.display === "none") failures.push("patchEl.display is 'none' after moving a word - the vacated spot has no patch shown at all");
if (!patchState.hasBackgroundImage) failures.push("patchEl has no backgroundImage after moving a word - the patch never got filled");

const afterShot = await page.screenshot({ clip: target.rect });

async function toPixels(page, pngBuffer) {
  return page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  }, pngBuffer.toString("base64"));
}

const rawPixels = await toPixels(page, rawBgShot);
const afterPixels = await toPixels(page, afterShot);
const n = Math.min(rawPixels.length, afterPixels.length);
let sumDiff = 0;
for (let i = 0; i < n; i += 4) {
  sumDiff += Math.abs(rawPixels[i] - afterPixels[i]) + Math.abs(rawPixels[i + 1] - afterPixels[i + 1]) + Math.abs(rawPixels[i + 2] - afterPixels[i + 2]);
}
const meanDiff = sumDiff / (n / 4);
console.log(`mean per-pixel RGB diff, raw source crop vs. after-move crop: ${meanDiff.toFixed(2)}`);

// Threshold picked well above ordinary JPEG re-encode/compositing noise (a
// couple of points) and well below what an actual inpainted fill produces
// (tens of points, since it blends surrounding content rather than copying
// the raw source) - see the probe run this was calibrated against, ~43.
const MIN_EXPECTED_DIFF = 15;
if (meanDiff < MIN_EXPECTED_DIFF) {
  failures.push(`vacated region barely changed (diff ${meanDiff.toFixed(2)} < ${MIN_EXPECTED_DIFF}) - looks like the raw source pixels are still showing through, not an inpainted patch`);
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nMoving a word reveals the inpainted patch at its original location, not raw source pixels.");
