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
// UI-REDESIGN-PLAN.md §2.3: dragging a word now happens from move-handle,
// which appears next to resize-handle on selection, rather than from the
// word's own body - a tap always edits/selects; move-handle is what drags.
// Marquee is a press-and-hold-then-drag starting on empty canvas rather than
// a button-armed mode, and (also per §2.3) the background image is no longer
// a draggable object anywhere, so marquee is reachable in Full image mode
// now too, not only Image format - both are checked below.
//
// One thing that looks like a failure and is not, learned while writing this:
//   - Targets must be scrolled into the viewport first. A tap at y=1064 in an
//     844px-tall viewport hits nothing and every later assertion cascades.
//
// Usage: node test/touch-interactions.js   (exits non-zero if anything regressed)

import { chromium } from "playwright-core";
import { skipUnlessChromium } from "./browser.js";
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

// CHROMIUM-PINNED ON PURPOSE - do not "fix" this to honour BROWSER=webkit.
//
// This gate exists because the app once handled pointerdown but not touchstart,
// and Playwright's own mouse/touchscreen APIs synthesize events that would have
// passed against that broken code. The whole value of this file is that
// `cdp.send("Input.dispatchTouchEvent", ...)` below makes the browser emit
// GENUINE, trusted touch input at the protocol level rather than a script-
// dispatched approximation.
//
// The Chrome DevTools Protocol is Chromium-only. Playwright exposes no
// equivalent on WebKit or Firefox: `context.newCDPSession()` throws there. The
// available substitute, `page.touchscreen.tap()`, is exactly the synthesized
// input this file was written to avoid - swapping to it would keep the gate
// green on all three engines while silently destroying the property it pins.
//
// So on any other engine this skips with a stated reason and exit 0. A skip that
// says why is information; a red build for a test that was never applicable is
// noise, and a downgraded test that still says "ok" is worse than either.
if (skipUnlessChromium("needs CDP Input.dispatchTouchEvent for genuine trusted touch input; page.touchscreen would synthesize the very events this gate exists to rule out")) {
  process.exit(0);
}

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
// Same shape, but holds past the marquee threshold (420ms, editorInteractions.js)
// before moving, so a press-and-hold on empty canvas escalates into a marquee
// the way it's meant to rather than reading as a quick drag/scroll.
async function touchPressHoldDrag(from, to, { holdMs = 500, steps = 10 } = {}) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  await new Promise((resolve) => setTimeout(resolve, holdMs));
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
await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  window.__state = state;
  document.getElementById("image-format-view").scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);

// ---- 1. Touch: tap a word to select it (a tap always edits/selects now -
// UI-REDESIGN-PLAN.md §2.3), then drag it via move-handle, which appears at
// the selection's corner rather than dragging the word's own body ----
const target = await pickVisibleWord();
await tap(target);
await page.waitForTimeout(150);
const before = await readTarget();
const moveHandlePos = await page.evaluate(() => {
  const el = document.getElementById("move-handle");
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: getComputedStyle(el).display !== "none" };
});
console.log("1. TOUCH SELECT + MOVE-HANDLE DRAG");
console.log("   move-handle visible after tap-select:", moveHandlePos.visible);
if (!moveHandlePos.visible) failures.push("move-handle did not appear after tap-selecting a word in Full image mode");
await touchDrag(moveHandlePos, { x: moveHandlePos.x + 55, y: moveHandlePos.y + 70 });
await page.waitForTimeout(150);
const afterDrag = await readTarget();
console.log("   before:", before, "\n   after: ", afterDrag);
const dragOk = before.x !== afterDrag.x || before.y !== afterDrag.y;
console.log("   ->", dragOk ? "MOVED (ok)" : "NOT MOVED - FAIL");
if (!dragOk) failures.push("touch drag from move-handle did not move the word");

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

// Finds a point on the image surface that is not inside ANY word's real
// bounding box (plus a safety margin), checked directly against the object
// model rather than document.elementFromPoint - elementFromPoint's hit-test
// and a real CDP-dispatched touch's own hit-test turned out to disagree at
// exactly the coordinates this originally picked (elementFromPoint said
// "empty", the real touch landed on a word anyway), so this checks the thing
// a touch actually has to avoid instead of trusting a second hit-test API to
// agree with the first.
async function findEmptyPoint() {
  return page.evaluate(() => {
    const view = document.getElementById("image-format-view");
    const r = view.getBoundingClientRect();
    const margin = 8;
    const wordRects = window.__state.editorObjects
      .filter((o) => o.type === "word" && !o.removed)
      .map((o) => o.el.getBoundingClientRect());
    // The view's own top edge can sit above the viewport after
    // scrollIntoView({block:"start"}) (a negative rect.top), and clamping
    // that up to 0 alone can still land inside the sticky app bar - a real
    // element, just not the one under test. Floor at the app bar's own
    // bottom edge too, not just the viewport's.
    const appBar = document.getElementById("app-bar");
    const chromeBottom = appBar ? appBar.getBoundingClientRect().bottom : 0;
    const top = Math.max(r.top, chromeBottom, 0) + margin;
    const bottom = Math.min(r.bottom, innerHeight) - margin;
    const left = r.left + margin;
    const right = r.right - margin;
    for (let y = top; y < bottom; y += 10) {
      for (let x = left; x < right; x += 10) {
        const clear = wordRects.every((wr) => x < wr.left - margin || x > wr.right + margin || y < wr.top - margin || y > wr.bottom + margin);
        if (clear) return { x, y, left: r.left, right: r.right, width: r.width };
      }
    }
    return null;
  });
}

// ---- 3. Marquee by touch: press-and-hold on empty canvas, then drag.
// Checked in both Image format AND Full image mode now - UI-REDESIGN-PLAN.md
// §2.3 removed the background image as a draggable object, which is
// specifically what used to make Full image's surface have nowhere for a
// marquee to start from. ----
async function marqueeByTouch(modeBtnId, label) {
  await page.click(modeBtnId);
  await page.evaluate(async () => {
    // clearSelection(), not a raw Set.clear() - the raw Set never hides
    // move-handle/resize-handle, which stay positioned wherever selection
    // last put them and can sit right on top of the "empty" point this is
    // about to compute.
    const { clearSelection } = await import("/js/editorObjects.js");
    clearSelection();
    document.getElementById("image-format-view").scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(300);
  const start = await findEmptyPoint();
  if (!start) {
    failures.push(`touch marquee in ${label}: could not find an empty point on the image surface to start from`);
    return;
  }
  const y1 = Math.min(start.y + 300, (await page.evaluate(() => innerHeight)) - 8);
  await touchPressHoldDrag({ x: start.x, y: start.y }, { x: start.right - 8, y: y1 }, { holdMs: 500, steps: 14 });
  await page.waitForTimeout(200);
  const selectedCount = await page.evaluate(() => window.__state.selectedObjectIds.size);
  console.log(`3. MARQUEE BY TOUCH (${label})`);
  console.log("   start point:", start, "| objects selected:", selectedCount, selectedCount > 1 ? "(ok)" : "- FAIL");
  if (selectedCount <= 1) failures.push(`touch marquee in ${label} selected ${selectedCount} objects`);
}
await marqueeByTouch("#mode-image-btn", "Image format mode");
await marqueeByTouch("#mode-full-btn", "Full image mode");

// ---- 3b. A quick drag (below the 420ms hold threshold) keeps scrolling/
// panning exactly as it does today, rather than arming a marquee ----
await page.evaluate(async () => {
  const { clearSelection } = await import("/js/editorObjects.js");
  clearSelection();
  document.getElementById("image-format-view").scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);
const scrollBefore = await page.evaluate(() => window.scrollY);
const scrollStart = await findEmptyPoint();
if (!scrollStart) failures.push("quick-drag-scrolls check: could not find an empty point on the image surface to start from");
else await touchDrag({ x: scrollStart.x, y: scrollStart.y }, { x: scrollStart.x, y: scrollStart.y - 340 }, 10);
await page.waitForTimeout(200);
const scrollAfter = await page.evaluate(() => window.scrollY);
const selectedAfterQuickDrag = await page.evaluate(() => window.__state.selectedObjectIds.size);
console.log("3b. QUICK DRAG STILL SCROLLS (Full image mode)");
console.log("   scrollY:", scrollBefore, "->", scrollAfter, "| objects selected:", selectedAfterQuickDrag);
if (scrollAfter === scrollBefore) failures.push("a quick drag on empty canvas did not scroll the page - the marquee hold may be intercepting quick drags too");
if (selectedAfterQuickDrag > 0) failures.push("a quick drag on empty canvas armed a marquee (selected something) instead of just scrolling");

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
