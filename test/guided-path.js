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

import { launchBrowser, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
const PORT = await listenOnEphemeralPort(server);

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
  // Select it with a click (a single click only selects - Phase 1 replaced
  // the earlier model where the same click both selected and edited a word
  // in one motion), then drag from move-handle, which appears at the
  // selection's corner.
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

    // ---- 3. Phase 1, mouse input: single click selects only (never edits);
    // dragging works from the word's own body once selected, not only from
    // move-handle; double click enters edit mode; colour stays the matched
    // colour (never the palette default/black) through both states.
    //
    // Picks a DIFFERENT word than section 2's (window.__target, set there):
    // section 2 already dragged that one by a fixed pixel delta, which on a
    // short phone-width container can push its top% negative - clipped by
    // #image-format-view's own bounds even though getBoundingClientRect()
    // still reports the word's full, un-clipped box, so a coordinate/click
    // computed from that box (Playwright's own or this file's) lands on
    // whatever is behind the clip instead of the word. Not a Phase 1 bug -
    // reusing an already near-the-edge word was the test's own mistake. ----
    await page.evaluate(async () => {
      const { clearSelection } = await import("/js/editorObjects.js");
      clearSelection();
    });
    const target3Id = await page.evaluate(() => {
      const words = window.__state.editorObjects.filter((o) => o.type === "word" && o.el.textContent.trim() && o.id !== window.__target);
      for (const w of words) {
        w.el.scrollIntoView({ block: "center" });
        const r = w.el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // Generous minimum size (bigger than section 2's own 16x8): once
        // selected, resize-handle sits right at the word's bottom-right
        // corner, and a small word leaves too little body clear of it for
        // this section's own body-drag/double-click to land reliably away
        // from the handle.
        if (cx > 30 && cx < innerWidth - 30 && cy > 90 && cy < innerHeight - 120 && r.width > 80 && r.height > 40) return w.id;
      }
      return null;
    });

    if (!target3Id) {
      failures.push(`${viewport.label}: Phase 1 select/edit check - no word to target`);
    } else {
      const target3 = await page.evaluateHandle((id) => window.__state.editorObjects.find((x) => x.id === id).el, target3Id);
      const expectedColor = await page.evaluate((id) => window.__state.editorObjects.find((x) => x.id === id).textColor, target3Id);

      await target3.click();
      await page.waitForTimeout(150);
      const afterSingleClick = await page.evaluate((id) => {
        const o = window.__state.editorObjects.find((x) => x.id === id);
        return {
          selected: window.__state.selectedObjectIds.has(id),
          editingObjectId: window.__state.editingObjectId,
          contentEditable: o.el.contentEditable,
          color: getComputedStyle(o.el).color,
        };
      }, target3Id);
      if (!afterSingleClick.selected) failures.push(`${viewport.label}: Phase 1 - single click did not select the word`);
      if (afterSingleClick.editingObjectId === target3Id || afterSingleClick.contentEditable === "true") {
        failures.push(`${viewport.label}: Phase 1 - single click entered edit mode, it must only select`);
      }
      if (expectedColor && afterSingleClick.color !== expectedColor) {
        failures.push(`${viewport.label}: Phase 1 - colour after single-click selection is ${afterSingleClick.color}, expected ${expectedColor}`);
      }

      // Drag from the word's own body (not move-handle), now that it's
      // selected. boundingBox() re-measures just-in-time, same reasoning as
      // the click above. The start point is offset toward the word's
      // top-left rather than its exact centre: resize-handle sits at the
      // selected word's bottom-right corner (revealed the moment selection
      // happens), and for a short/narrow word that corner can overlap the
      // geometric centre closely enough to start a resize instead of this
      // section's intended body-drag.
      const beforeBodyDrag = await page.evaluate((id) => {
        const o = window.__state.editorObjects.find((x) => x.id === id);
        return { x: o.x, y: o.y };
      }, target3Id);
      const box = await target3.boundingBox();
      const startX = box.x + box.width * 0.25;
      const startY = box.y + box.height * 0.25;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(startX + (35 * i) / 8, startY + (25 * i) / 8);
      await page.mouse.up();
      await page.waitForTimeout(150);
      const afterBodyDrag = await page.evaluate((id) => {
        const o = window.__state.editorObjects.find((x) => x.id === id);
        return { x: o.x, y: o.y };
      }, target3Id);
      if (Math.abs(afterBodyDrag.x - beforeBodyDrag.x) < 0.01 && Math.abs(afterBodyDrag.y - beforeBodyDrag.y) < 0.01) {
        failures.push(`${viewport.label}: Phase 1 - dragging from the selected word's own body did not move it`);
      }

      // Double click enters edit mode; colour is still correct there too.
      await target3.dblclick();
      await page.waitForTimeout(150);
      const afterDoubleClick = await page.evaluate((id) => {
        const o = window.__state.editorObjects.find((x) => x.id === id);
        return {
          editingObjectId: window.__state.editingObjectId,
          contentEditable: o.el.contentEditable,
          focused: document.activeElement === o.el,
          color: getComputedStyle(o.el).color,
        };
      }, target3Id);
      if (afterDoubleClick.editingObjectId !== target3Id || afterDoubleClick.contentEditable !== "true" || !afterDoubleClick.focused) {
        failures.push(`${viewport.label}: Phase 1 - double click did not enter edit mode`);
      }
      if (expectedColor && afterDoubleClick.color !== expectedColor) {
        failures.push(`${viewport.label}: Phase 1 - colour while editing (post double-click) is ${afterDoubleClick.color}, expected ${expectedColor}`);
      }
      await page.evaluate(() => document.activeElement?.blur());
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
