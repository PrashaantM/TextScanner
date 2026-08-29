// touch-interactions.js: drives the editor with REAL touch input and asserts
// that move, resize and marquee selection actually work.
//
// This test exists because its absence is how the bug it covers survived. Every
// editor interaction was bound to mousedown/mousemove/mouseup only, so on the
// iOS build the app is actually shipped as, "Move components" - the feature the
// README leads with - did nothing. It went unnoticed because WKWebView
// synthesizes a click from a tap, so tapping a word to edit it worked fine, and
// because testing happened in desktop dev tools with a mouse.
//
// So this deliberately does NOT use Playwright's mouse API, which would emit
// pointer events with pointerType "mouse" and pass against the broken code. It
// uses CDP Input.dispatchTouchEvent, which makes the browser produce genuine,
// trusted touch input.
//
// Two things that look like failures and are not, learned while writing this:
//   - Targets must be scrolled into the viewport first. A tap at y=1064 in an
//     844px-tall viewport hits nothing and every later assertion cascades.
//   - Marquee belongs to the NON-editor views. In Full image + Move components
//     the background image is itself a draggable object covering the surface, so
//     a drag there correctly moves the image instead.
//
// Usage: node test/touch-interactions.js   (exits non-zero if anything regressed)

import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8126;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".png": "image/png", ".gz": "application/gzip" };
const server = createServer(async (req, res) => {
  try { const p = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(ROOT, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
}).listen(PORT);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const page = await context.newPage();
const errors = [];
const failures = [];
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await context.newCDPSession(page);

async function touchDrag(from, to, steps = 10) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const tap = async (p) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

// Picks a word whose on-screen box sits comfortably inside the viewport, with
// room to drag. Everything below fails meaninglessly on an off-screen target.
const pickVisibleWord = () => page.evaluate(() => {
  const vh = window.innerHeight, vw = window.innerWidth;
  const words = window.__state.editorObjects.filter((o) => o.type === "word" && o.el.textContent.trim());
  for (const w of words) {
    const r = w.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx > 40 && cx < vw - 120 && cy > 80 && cy < vh - 160) {
      window.__target = w.id;
      return { id: w.id, x: cx, y: cy };
    }
  }
  return null;
});
const readTarget = () => page.evaluate(() => {
  const o = window.__state.editorObjects.find((x) => x.id === window.__target);
  return { x: +o.x.toFixed(3), y: +o.y.toFixed(3), w: +o.w.toFixed(3), font: +o.fontSizePct.toFixed(3) };
});

await page.goto(`http://localhost:${PORT}/index.html`);
await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic5.jpeg"));
await page.waitForSelector("#preview-section:not(.hidden)");
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
await page.click("#mode-full-btn");
await page.click("#editor-mode-btn");
await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  window.__state = state;
  document.getElementById("image-format-view").scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);

// ---- 1. Touch-drag a word ----
const target = await pickVisibleWord();
const before = await readTarget();
await touchDrag(target, { x: target.x + 55, y: target.y + 70 });
await page.waitForTimeout(150);
const afterDrag = await readTarget();
console.log("1. TOUCH DRAG");
console.log("   before:", before, "\n   after: ", afterDrag);
const dragOk = before.x !== afterDrag.x || before.y !== afterDrag.y;
console.log("   ->", dragOk ? "MOVED (ok)" : "NOT MOVED - FAIL");
if (!dragOk) failures.push("touch drag did not move the word");

// ---- 2. Resize handle by touch ----
// The drag already left the word selected; no extra tap needed.
const handle = await page.evaluate(() => {
  const el = document.getElementById("resize-handle");
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { visible: cs.display !== "none", touchAction: cs.touchAction, x: r.left + r.width / 2, y: r.top + r.height / 2,
           w: Math.round(r.width), h: Math.round(r.height), selected: window.__state.selectedObjectIds.size };
});
console.log("2. RESIZE HANDLE");
console.log(`   hit target: ${handle.w}x${handle.h} CSS px`, handle.w >= 24 && handle.h >= 24 ? "(>= 24px minimum: ok)" : "(TOO SMALL)");
console.log("   visible:", handle.visible, "| selected objects:", handle.selected, "| touch-action:", handle.touchAction);
const beforeResize = await readTarget();
await touchDrag({ x: handle.x, y: handle.y }, { x: handle.x + 40, y: handle.y + 40 });
await page.waitForTimeout(150);
const afterResize = await readTarget();
const resizeOk = afterResize.font !== beforeResize.font;
console.log("   font:", beforeResize.font, "->", afterResize.font, resizeOk ? "RESIZED (ok)" : "NOT RESIZED - FAIL");
if (!resizeOk) failures.push("touch drag on the resize handle did not resize");
if (handle.w < 24 || handle.h < 24) failures.push(`resize handle hit target is ${handle.w}x${handle.h}, below the 24px minimum`);

// ---- 3. Marquee by touch, in the mode where it is reachable ----
// Not Full-image editor mode: there the background image is itself a draggable
// object covering the surface, so a drag correctly moves the image. Marquee
// lives in the non-editor views, where the background has pointer-events: none.
await page.click("#mode-image-btn");
await page.evaluate(() => {
  window.__state.selectedObjectIds.clear();
  document.getElementById("image-format-view").scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);
await page.click("#select-multi-btn");
await page.waitForTimeout(150);
const view = await page.evaluate(() => {
  const r = document.getElementById("image-format-view").getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height,
           touchAction: getComputedStyle(document.getElementById("image-format-view")).touchAction };
});
const y0 = Math.max(view.top + 8, 60);
const y1 = Math.min(view.top + view.height * 0.45, 800);
await touchDrag({ x: view.left + 5, y: y0 }, { x: view.left + view.width - 8, y: y1 }, 14);
await page.waitForTimeout(200);
const selectedCount = await page.evaluate(() => window.__state.selectedObjectIds.size);
console.log("3. MARQUEE BY TOUCH (Image format mode)");
console.log("   touch-action:", view.touchAction, "| objects selected:", selectedCount, selectedCount > 1 ? "(ok)" : "- FAIL");
if (selectedCount <= 1) failures.push("touch marquee selected " + selectedCount + " objects");

console.log("4. UNDO after touch gestures:", (await page.$eval("#undo-btn", (el) => el.disabled)) ? "DISABLED - gestures did not register" : "enabled (ok)");
console.log("ERRORS:", errors.length ? errors : "(none)");
if (errors.length) failures.push(`${errors.length} page error(s)`);
await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll touch interactions OK.");
