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
// UI-REDESIGN-PLAN.md §2.3 first replaced direct-body dragging with
// move-handle/resize-handle, and a tap both selected and edited a word in one
// motion. That second part is no longer true, and saying so plainly matters
// more than leaving the old claim to rot: Phase 1 of the interaction-model
// rewrite deliberately replaced it. A single tap now ONLY selects - text
// stays non-editable (no caret, no keyboard) until a double tap enters edit
// mode. Dragging, meanwhile, no longer needs move-handle exclusively: once a
// word is already selected, a further press-and-drag on its own body moves it
// too (move-handle still works, and is still what sections 1 and 4 below
// use, since it's the mechanism that exists regardless of selection state).
// Section 6 near the end of this file is what actually covers the new
// select/edit split and body-drag - added rather than folded into the
// sections below, so the original tap-selects-then-drags-from-handle flow
// stays intact as its own coverage.
// Marquee is a press-and-hold-then-drag starting on empty canvas rather than
// a button-armed mode.
//
// The background image (obj-bg) is a real selectable/moveable object too,
// the same as it was before this redesign - §2.3 was never about it, and an
// earlier revision of this branch removed it by mistake (a real regression,
// not a planned decision; restored). It's selected the same way a word is -
// tap it, then drag from the same move-handle/resize-handle pair - rather
// than the old direct-body drag. Checked below alongside marquee, since the
// two interact: a press on the photo goes to selecting/dragging it, not to
// marquee, so marquee's reachability in Full image mode is checked rather
// than assumed either way.
//
// One thing that looks like a failure and is not, learned while writing this:
//   - Targets must be scrolled into the viewport first. A tap at y=1064 in an
//     844px-tall viewport hits nothing and every later assertion cascades.
//
// Usage: node test/touch-interactions.js   (exits non-zero if anything regressed)

import { launchBrowser, skipUnlessChromium, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const server = createServer(async (req, res) => {
  try { const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) }); res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
const PORT = await listenOnEphemeralPort(server);

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

// launchBrowser, NOT chromium.launch: this gate skipped straight past the
// console-error capture in test/browser.js, which only attaches to pages
// created through it. It installed page.on("pageerror") like the other 25
// gates and was the one file cedffae could not reach, so every handled
// console.error on a touch path - withBusy in js/scanDoc.js catches, logs
// and alerts - stayed invisible here after it was fixed everywhere else.
// The engine is already known to be chromium: the skip above exits first.
const browser = await launchBrowser({ headless: true });
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
// Same as readTarget, but by explicit id rather than window.__target - section
// 6 picks its own word independent of whichever one earlier sections left in
// that slot.
const readTarget2 = (id) =>
  page.evaluate((oid) => {
    const o = window.__state.editorObjects.find((x) => x.id === oid);
    return { x: +o.x.toFixed(3), y: +o.y.toFixed(3) };
  }, id);
// Two genuine taps close enough together for the browser's own touch-to-click
// synthesis to combine them into a real dblclick, the same as a finger would
// on a real device - not a synthesized dblclick event, which would test
// nothing about whether real touch input reaches the new edit-mode handler.
async function doubleTap(p) {
  await tap(p);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await tap(p);
}

await page.goto(`http://localhost:${PORT}/index.html`);
await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic5.jpeg"));
await page.waitForSelector("#preview-section:not(.hidden)");
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
await page.click("#mode-full-btn");
await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  window.__state = state;
});
// scrollIntoView({block:"start"}) alone can leave the view's own top edge a
// few px above the viewport (font/image reflow after the call), which is
// close enough to 0 that it doesn't matter for a WORD's handles but matters
// a great deal for the background image's move-handle: obj-bg sits at
// x:0,y:0, so its move-handle sits exactly at the container's top-left
// corner - the one spot the sticky app bar can still be covering after a
// naive scroll. Scrolling with real clearance past the app bar's own bottom
// edge is what section 4 below needs to actually reach that handle.
async function scrollSurfaceIntoView() {
  await page.evaluate(() => {
    const view = document.getElementById("image-format-view");
    const appBar = document.getElementById("app-bar");
    const r = view.getBoundingClientRect();
    const chromeBottom = appBar ? appBar.getBoundingClientRect().bottom : 0;
    window.scrollBy(0, r.top - chromeBottom - 20);
  });
  await page.waitForTimeout(300);
}
await scrollSurfaceIntoView();

// ---- 1. Touch: tap a word to select it (selects only, per Phase 1 - see
// section 6 for the edit-mode/body-drag coverage), then drag it via
// move-handle, which appears at the selection's corner and still works
// regardless of whether the drag could also have started on the body ----
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
//
// In Full image mode specifically, "clear of every word" is no longer the
// same thing as "empty canvas": obj-bg is full-bleed, so every such point
// sits on the (now selectable) photo. That's intentional here, not a gap in
// this helper - section 4 below relies on exactly that to reach the image,
// and the marquee section right after this one relies on it to check where a
// press actually goes now.
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
//
// Deliberately runs BEFORE section 4 (background image drag/resize) below,
// not after: section 4 moves and shrinks-or-grows obj-bg away from its
// default full-bleed x:0,y:0,w:100,h:100, which opens up real empty canvas
// even in Full image mode. Run in that order, a "clear of every word" point
// here would sometimes land on genuinely empty canvas and sometimes on the
// image depending on where section 4 last left it - a flake this file
// exists to avoid, not reproduce. Running marquee first, against the
// pristine full-bleed image every fresh Full-image-mode session actually
// starts with, is what makes the result below deterministic.
//
// Image format mode still has real empty canvas around/between words, so
// marquee is checked there as a straightforward success case.
//
// Full image mode is different now that obj-bg is selectable again (section
// 4 below): the background photo is full-bleed, so there is no point on
// that surface that is not the photo - the same press that would start a
// marquee lands on the image instead and selects/drags IT, exactly like
// every pre-redesign build. Confirmed empirically (CDP touch, not reasoned
// out on paper): a press-hold-then-drag on a "clear of every word" point in
// Full image mode selects obj-bg (selectedCount 1, is-selected true,
// marqueeMode stays false) and the drag falls through to the page's own
// scroll, rather than growing a selection past 1. So this mode's case below
// asserts that non-reachability directly instead of the old
// selectedCount > 1 success check, which described a marquee that only
// existed because the image had been (mistakenly) made unselectable. ----
async function marqueeByTouch(modeBtnId, label, { expectMarquee } = { expectMarquee: true }) {
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
  const result = await page.evaluate(() => ({
    selectedCount: window.__state.selectedObjectIds.size,
    selected: [...window.__state.selectedObjectIds],
    marqueeMode: window.__state.marqueeMode,
  }));
  console.log(`3. MARQUEE BY TOUCH (${label})`);
  console.log("   start point:", start, "| result:", result);
  if (expectMarquee) {
    console.log("   ->", result.selectedCount > 1 ? "MARQUEE SELECTED MULTIPLE (ok)" : "NOT SELECTED - FAIL");
    if (result.selectedCount <= 1) failures.push(`touch marquee in ${label} selected ${result.selectedCount} objects`);
  } else {
    // The press landed on the now-selectable background image instead of
    // starting a marquee: exactly one object selected (obj-bg), and
    // marqueeMode never armed.
    const isBgOnly = result.selectedCount === 1 && result.selected[0] === "obj-bg";
    console.log("   ->", isBgOnly && !result.marqueeMode ? "SELECTED THE IMAGE, NOT MARQUEE (ok)" : "UNEXPECTED - FAIL");
    if (!isBgOnly) failures.push(`touch press-hold-drag in ${label} was expected to select only obj-bg, got ${JSON.stringify(result.selected)}`);
    if (result.marqueeMode) failures.push(`touch press-hold-drag in ${label} armed marqueeMode even though the press landed on the background image`);
  }
}
await marqueeByTouch("#mode-image-btn", "Image format mode");
// The background image absorbs every press here now (restored below the
// dispatcher's objEl branch - see section 4 further down for the direct
// tap-select/move/resize coverage), so this is a not-reachable-there check,
// matching the pre-redesign app - see the comment above marqueeByTouch for
// how that was confirmed.
await marqueeByTouch("#mode-full-btn", "Full image mode", { expectMarquee: false });

// ---- 3b. A quick drag (below the 420ms hold threshold) keeps scrolling/
// panning exactly as it does today, rather than arming a marquee.
//
// In Full image mode the touch point findEmptyPoint returns is the
// background image (the marquee case just above), so the quick press
// legitimately selects obj-bg here - that's correct, not a regression. What
// this check actually guards is narrower now: the press must not escalate
// into a marquee (marqueeMode/multi-select), and the drag must still scroll
// the page rather than the touch being consumed some other way. ----
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
const afterQuickDrag = await page.evaluate(() => ({
  selectedCount: window.__state.selectedObjectIds.size,
  selected: [...window.__state.selectedObjectIds],
  marqueeMode: window.__state.marqueeMode,
}));
console.log("3b. QUICK DRAG STILL SCROLLS (Full image mode)");
console.log("   scrollY:", scrollBefore, "->", scrollAfter, "| result:", afterQuickDrag);
if (scrollAfter === scrollBefore) failures.push("a quick drag on empty canvas did not scroll the page - the marquee hold may be intercepting quick drags too");
if (afterQuickDrag.marqueeMode) failures.push("a quick drag on empty canvas armed marqueeMode instead of just scrolling");
if (afterQuickDrag.selectedCount > 1) failures.push(`a quick drag on empty canvas selected ${afterQuickDrag.selectedCount} objects (marquee), not just the one object under the touch`);

// ---- 4. Background image: tap-select, then move-handle drag and
// resize-handle resize - the same mechanism as a word (§2.3's move-handle/
// resize-handle pair), not the old direct-body drag. obj-bg
// (js/editorObjects.js's renderImageFormatView) is a real selectable/
// moveable object in Full image mode, matching the README's "moving and
// resizing the text and the image itself, freely and independently." An
// earlier revision of this branch made it permanently unselectable by
// mistake - a real regression, not a planned decision; restored here, and
// covered directly rather than taken on faith.
//
// Runs last, after the marquee checks above: moving/resizing obj-bg away
// from its default full-bleed coverage opens up real empty canvas even in
// Full image mode, which would change what "clear of every word" means for
// section 3's marquee check if this ran first. See the comment there.
// Already in Full image mode here (section 3's Full-image marquee case and
// section 3b both leave it there), so no mode switch is needed. ----
await page.evaluate(async () => {
  const { clearSelection } = await import("/js/editorObjects.js");
  clearSelection();
});
await scrollSurfaceIntoView();
// obj-bg is (still, at this point) full-bleed (x:0,y:0,w:100,h:100), so any
// point clear of every word necessarily lands on the image - findEmptyPoint
// is reused as-is for that reason, not because it was changed to target the
// image.
const bgPoint = await findEmptyPoint();
console.log("4. BACKGROUND IMAGE TAP-SELECT + MOVE-HANDLE DRAG + RESIZE-HANDLE");
if (!bgPoint) {
  failures.push("background image tap-select: no point on the image surface was clear of every word to tap");
} else {
  await tap(bgPoint);
  await page.waitForTimeout(150);
  const bgSelection = await page.evaluate(() => ({
    ids: [...window.__state.selectedObjectIds],
    outlined: document.getElementById("image-format-bg").classList.contains("is-selected"),
  }));
  console.log("   selected after tap:", bgSelection.ids, "| is-selected class:", bgSelection.outlined);
  if (bgSelection.ids.length !== 1 || bgSelection.ids[0] !== "obj-bg") failures.push(`tapping the background image selected ${JSON.stringify(bgSelection.ids)} instead of just obj-bg`);
  if (!bgSelection.outlined) failures.push("background image did not get the is-selected outline after tap-select");

  const readBg = () => page.evaluate(() => {
    const o = window.__state.editorObjects.find((x) => x.id === "obj-bg");
    return { x: +o.x.toFixed(3), y: +o.y.toFixed(3), w: +o.w.toFixed(3), h: +o.h.toFixed(3) };
  });
  // obj-bg's full-bleed position puts its handles at the CONTAINER's own
  // corners, which - unlike a typical word away from the edges - can sit
  // below a container taller than the viewport even after
  // scrollSurfaceIntoView (which only guarantees the container's TOP edge
  // clears the app bar). scrollIntoView on each handle itself, right before
  // dragging it, is what actually gets it on-screen; relying on the one
  // upfront scroll intermittently missed it here.
  const bgBeforeMove = await readBg();
  await page.evaluate(() => document.getElementById("move-handle").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(200);
  const bgMoveHandle = await page.evaluate(() => {
    const el = document.getElementById("move-handle");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: getComputedStyle(el).display !== "none" };
  });
  if (!bgMoveHandle.visible) failures.push("move-handle did not appear after tap-selecting the background image");
  await touchDrag(bgMoveHandle, { x: bgMoveHandle.x + 55, y: bgMoveHandle.y + 70 });
  await page.waitForTimeout(150);
  const bgAfterMove = await readBg();
  console.log("   position:", `${bgBeforeMove.x},${bgBeforeMove.y}`, "->", `${bgAfterMove.x},${bgAfterMove.y}`);
  if (bgAfterMove.x === bgBeforeMove.x && bgAfterMove.y === bgBeforeMove.y) failures.push("touch drag from move-handle did not move the background image");

  await page.evaluate(() => document.getElementById("resize-handle").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(200);
  const bgResizeHandle = await page.evaluate(() => {
    const el = document.getElementById("resize-handle");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: getComputedStyle(el).display !== "none" };
  });
  if (!bgResizeHandle.visible) failures.push("resize-handle did not appear while the background image was selected");
  await touchDrag(bgResizeHandle, { x: bgResizeHandle.x + 40, y: bgResizeHandle.y + 40 });
  await page.waitForTimeout(150);
  const bgAfterResize = await readBg();
  console.log("   size:", `${bgAfterMove.w}x${bgAfterMove.h}`, "->", `${bgAfterResize.w}x${bgAfterResize.h}`);
  if (bgAfterResize.w === bgAfterMove.w && bgAfterResize.h === bgAfterMove.h) failures.push("touch drag on the resize handle did not resize the background image");
}
await page.evaluate(async () => {
  const { clearSelection } = await import("/js/editorObjects.js");
  clearSelection();
});

console.log("5. UNDO after touch gestures:", (await page.$eval("#undo-btn", (el) => el.disabled)) ? "DISABLED - gestures did not register" : "enabled (ok)");

// ---- 6. Phase 1: single tap selects only (never edits); a double tap
// enters edit mode; dragging works from the word's own body once it's
// already selected, not only from move-handle; color stays the matched
// colour (never black/the theme default) through both states.
//
// Runs last and picks its own word: everything above already dragged/
// resized/selected other objects, and this section's own body-drag moves
// obj-bg's sibling word regardless of what state sections 1-5 left behind, as
// long as it starts from a clean selection. ----
await page.evaluate(async () => {
  const { clearSelection } = await import("/js/editorObjects.js");
  clearSelection();
});
await scrollSurfaceIntoView();
const target6 = await pickVisibleWord();
console.log("6. PHASE 1: SELECT/EDIT SPLIT + BODY DRAG + COLOR");
if (!target6) {
  failures.push("Phase 1 select/edit check: no visible word to target");
} else {
  const expectedColor = await page.evaluate(
    (id) => window.__state.editorObjects.find((o) => o.id === id)?.textColor,
    target6.id
  );

  // Single tap: selects, does not edit.
  await tap(target6);
  await page.waitForTimeout(150);
  const afterSingleTap = await page.evaluate((id) => {
    const o = window.__state.editorObjects.find((x) => x.id === id);
    return {
      editingObjectId: window.__state.editingObjectId,
      selected: window.__state.selectedObjectIds.has(id),
      contentEditable: o.el.contentEditable,
      color: getComputedStyle(o.el).color,
    };
  }, target6.id);
  console.log("   after single tap:", afterSingleTap, "| expected color:", expectedColor);
  if (!afterSingleTap.selected) failures.push("Phase 1: single tap did not select the word");
  if (afterSingleTap.editingObjectId === target6.id || afterSingleTap.contentEditable === "true") {
    failures.push("Phase 1: single tap entered edit mode - it must only select");
  }
  if (expectedColor && afterSingleTap.color !== expectedColor) {
    failures.push(`Phase 1: word color after single-tap selection is ${afterSingleTap.color}, expected the matched colour ${expectedColor}`);
  }

  // Drag from the word's own body (not move-handle) now that it's selected.
  const beforeBodyDrag = await readTarget2(target6.id);
  await touchDrag(target6, { x: target6.x + 35, y: target6.y + 25 });
  await page.waitForTimeout(150);
  const afterBodyDrag = await readTarget2(target6.id);
  console.log("   body-drag:", beforeBodyDrag, "->", afterBodyDrag);
  if (beforeBodyDrag.x === afterBodyDrag.x && beforeBodyDrag.y === afterBodyDrag.y) {
    failures.push("Phase 1: dragging from the selected word's own body did not move it");
  }

  // Double tap: enters edit mode, color still correct.
  await doubleTap(target6);
  await page.waitForTimeout(150);
  const afterDoubleTap = await page.evaluate((id) => {
    const o = window.__state.editorObjects.find((x) => x.id === id);
    return {
      editingObjectId: window.__state.editingObjectId,
      contentEditable: o.el.contentEditable,
      focused: document.activeElement === o.el,
      color: getComputedStyle(o.el).color,
    };
  }, target6.id);
  console.log("   after double tap:", afterDoubleTap);
  if (afterDoubleTap.editingObjectId !== target6.id || afterDoubleTap.contentEditable !== "true" || !afterDoubleTap.focused) {
    failures.push("Phase 1: double tap did not enter edit mode");
  }
  if (expectedColor && afterDoubleTap.color !== expectedColor) {
    failures.push(`Phase 1: word color while editing (post double-tap) is ${afterDoubleTap.color}, expected the matched colour ${expectedColor}`);
  }

  await page.evaluate(() => document.activeElement?.blur());
}

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
