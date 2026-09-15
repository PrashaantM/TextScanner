// guided-path.js: drives the editor through the guided path to the photo
// editor and asserts a word dragged from there moves ON SCREEN, at both sides
// of the 600px breakpoint.
//
// WHY THIS EXISTS, ORIGINALLY. "Components can't be moved" was reported from a
// phone while test/move-inpaint.js was green. Both were true, and the gap
// between them was the whole point of this file: move-inpaint.js reached the
// editor by clicking #mode-full-btn, and so did every other browser gate in
// CI. Nothing had ever clicked #view-on-photo-btn - a SEPARATE guided CTA that
// called modeImageBtn.click() (the view with no photo and no "Move
// components"), so the guided path landed users somewhere nothing could be
// moved, and stayed green because the gates all took the other door.
//
// WHY IT STILL EXISTS. UI-REDESIGN-PLAN.md §2.4 removed the separate
// #view-on-photo-btn outright: "View on photo" is now #mode-full-btn's own
// label, the same element every other gate already drives. That specific bug
// class - a guided proxy quietly pointing somewhere else - is structurally
// gone, since there is only one button left to point anywhere. What is still
// worth a dedicated file: nothing else in CI checks the tap-to-select,
// drag-from-move-handle mechanics (UI-REDESIGN-PLAN.md §2.3) at PHONE width
// with mouse input specifically - move-inpaint.js only runs one desktop
// viewport, touch-interactions.js only runs one phone viewport via CDP touch.
// This is the combination test/radial-call-sites.js taught this repo to check
// for separately: present at desktop width, absent (or broken) on a phone.
//
// A word dragged via move-handle must move ON SCREEN, not just in the model -
// move-inpaint.js checks obj.x !== obj.originalX and the pixels at the
// vacated spot, both true of a word whose model moved while its rendering did
// not. Nothing in CI had ever compared a word's getBoundingClientRect() before
// a drag against after one, which is the only thing a user can actually see.
//
// Usage: node test/guided-path.js   (exits non-zero if anything regressed)

import { launchBrowser } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8131;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".wasm": "application/wasm", ".traineddata": "application/octet-stream", ".gz": "application/gzip", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

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

// A drag has to clear beginObjectDrag's 3px "is this really a drag" threshold by
// a wide margin, and land somewhere still inside the image.
const DRAG_DX = 60;
const DRAG_DY = -50;
// The rendered position must follow the pointer. The tolerance covers the
// percent-of-container rounding the commit does (obj.x is a percentage, the
// pointer delta is in px), not a difference anyone could see.
const MAX_RENDER_DRIFT_PX = 6;

const failures = [];
const browser = await launchBrowser();

for (const viewport of [
  { width: 1200, height: 1600, label: "desktop" },
  { width: 390, height: 844, label: "phone" },
]) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic1.jpeg"));
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });

  // ---- 1. The guided CTA lands where its label promises ----
  // No separate #view-on-photo-btn any more (UI-REDESIGN-PLAN.md §2.4) -
  // #mode-full-btn IS the guided CTA now, labeled "View on photo".
  const label = await page.textContent("#mode-full-btn");
  await page.click("#mode-full-btn");
  await page.waitForTimeout(250);

  const landed = await page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    const view = document.getElementById("image-format-view");
    const toolbar = document.getElementById("editor-toolbar");
    return {
      activeMode: state.activeMode,
      // The photo itself - `show-bg` is what un-hides #image-format-bg.
      showsPhoto: view.classList.contains("show-bg"),
      toolbarHidden: toolbar.classList.contains("hidden"),
    };
  });

  if (landed.activeMode !== "full") {
    failures.push(`${viewport.label}: "${label.trim()}" left activeMode="${landed.activeMode}", not "full" - the button that promises the photo is not the button that shows it`);
  }
  if (!landed.showsPhoto) {
    failures.push(`${viewport.label}: "${label.trim()}" did not show the photo (#image-format-view has no .show-bg)`);
  }
  if (landed.toolbarHidden) {
    failures.push(`${viewport.label}: after "${label.trim()}", the editor toolbar is not reachable`);
  }

  // ---- 2. A word dragged from there moves on screen, not just in the model ----
  // Select it with a tap (always available now - no separate mode to enter),
  // then drag from move-handle, which appears at the selection's corner.
  if (!landed.toolbarHidden) {
    const before = await page.evaluate(async () => {
      const { state } = await import("/js/state.js");
      window.__state = state;
      const words = state.editorObjects.filter((o) => o.type === "word" && o.el.textContent.trim());
      for (const w of words) {
        w.el.scrollIntoView({ block: "center" });
        const r = w.el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx > 30 && cx < innerWidth - 30 && cy > 90 && cy < innerHeight - 120 && r.width > 16 && r.height > 8) {
          window.__target = w.id;
          return { id: w.id, text: w.el.textContent, cx, cy, left: r.left, top: r.top, modelX: w.x, modelY: w.y };
        }
      }
      return null;
    });

    if (!before) {
      failures.push(`${viewport.label}: no word was on screen to drag - test setup problem, not the thing under test`);
    } else {
      await page.mouse.click(before.cx, before.cy);
      await page.waitForTimeout(150);

      const handle = await page.evaluate(() => {
        const el = document.getElementById("move-handle");
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: getComputedStyle(el).display !== "none" };
      });

      if (!handle.visible) {
        failures.push(`${viewport.label}: tapping "${before.text}" selected it but move-handle never appeared - so nothing on the image can be moved`);
        if (pageErrors.length) failures.push(`${viewport.label}: ${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
        await context.close();
        continue;
      }

      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(handle.x + (DRAG_DX * i) / 12, handle.y + (DRAG_DY * i) / 12);
      }
      await page.mouse.up();
      await page.waitForTimeout(250);

      const after = await page.evaluate(() => {
        const o = window.__state.editorObjects.find((x) => x.id === window.__target);
        const r = o.el.getBoundingClientRect();
        return { modelX: o.x, modelY: o.y, left: r.left, top: r.top, transform: o.el.style.transform };
      });

      const modelMoved = Math.abs(after.modelX - before.modelX) > 0.01 || Math.abs(after.modelY - before.modelY) > 0.01;
      const renderedDx = after.left - before.left;
      const renderedDy = after.top - before.top;

      if (!modelMoved) {
        failures.push(`${viewport.label}: dragging "${before.text}" did not move it in the model at all`);
      }
      // The assertion move-inpaint.js does not make. A word whose model moved
      // while its element stayed put looks, to the user, exactly like a drag
      // that did nothing - and reveals the inpainted patch underneath either
      // way, so the pixel check at the vacated spot cannot tell the two apart.
      if (Math.abs(renderedDx - DRAG_DX) > MAX_RENDER_DRIFT_PX || Math.abs(renderedDy - DRAG_DY) > MAX_RENDER_DRIFT_PX) {
        failures.push(
          `${viewport.label}: dragging "${before.text}" by (${DRAG_DX},${DRAG_DY})px moved it on screen by ` +
            `(${renderedDx.toFixed(1)},${renderedDy.toFixed(1)})px - the model and the rendering disagree`
        );
      } else {
        console.log(`  ${viewport.label}: "${before.text}" dragged (${DRAG_DX},${DRAG_DY})px, rendered (${renderedDx.toFixed(1)},${renderedDy.toFixed(1)})px`);
      }

      // A committed drag must leave no live gesture transform behind: the drag
      // moves by transform and commits to left/top on release, and a transform
      // still set afterwards would double the offset on the next reflow.
      if (after.transform) {
        failures.push(`${viewport.label}: the drag's compositor transform survived the release ("${after.transform}") instead of committing to left/top`);
      }
    }
  }

  if (pageErrors.length) {
    failures.push(`${viewport.label}: ${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
  }
  await context.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nThe guided “View on photo” path reaches the photo editor, and a word dragged from there moves on screen.");
