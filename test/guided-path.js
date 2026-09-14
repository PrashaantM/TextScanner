// guided-path.js: drives the editor through the buttons the UI itself points
// people at, rather than through the raw mode toggles every other gate uses.
//
// WHY THIS EXISTS. "Components can't be moved" was reported from a phone while
// test/move-inpaint.js was green. Both were true, and the gap between them is
// the whole point of this file: move-inpaint.js reaches the editor by clicking
// #mode-full-btn, and so does every other browser gate in CI. Nothing had ever
// clicked #view-on-photo-btn - the large secondary CTA sitting directly under
// the results heading, labelled "View on photo ->", which is how the interface
// tells a first-time user to get to the photo editor at all.
//
// That button called modeImageBtn.click(). "Image format" is the view that lays
// the recognized words out on a BLANK canvas: no photo, and - because setMode
// only show()s #editor-toolbar in "full" - no "Move components" button either.
// So the guided path landed users in the one view where nothing can be moved,
// and stayed green because the gates all took the other door.
//
// Two assertions follow from that, and the second matters as much as the first:
//
//   1. The guided CTA must land where its label says. Asserted on the observable
//      state a user would see (the photo is showing, the editor toolbar is
//      reachable), not on which function it happens to call.
//   2. A word dragged from there must move ON SCREEN. move-inpaint.js checks
//      obj.x !== obj.originalX and the pixels at the vacated spot - both true of
//      a word whose model moved while its rendering did not. Nothing in CI had
//      ever compared a word's getBoundingClientRect() before a drag against
//      after one, which is the only thing a user can actually see.
//
// Run at both sides of the 600px breakpoint, because the report came from a
// phone and test/radial-call-sites.js has already caught one control that was
// present at desktop width and absent on every phone.
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
  const label = await page.textContent("#view-on-photo-btn");
  await page.click("#view-on-photo-btn");
  await page.waitForTimeout(250);

  const landed = await page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    const view = document.getElementById("image-format-view");
    const toolbar = document.getElementById("editor-toolbar");
    const moveBtn = document.getElementById("editor-mode-btn");
    return {
      activeMode: state.activeMode,
      // The photo itself - `show-bg` is what un-hides #image-format-bg.
      showsPhoto: view.classList.contains("show-bg"),
      toolbarHidden: toolbar.classList.contains("hidden"),
      // getClientRects().length is the honest question: not "does the element
      // exist" (it always does - views.js keeps every view in the document) but
      // "can a person see and press it".
      moveBtnVisible: moveBtn.getClientRects().length > 0,
    };
  });

  if (landed.activeMode !== "full") {
    failures.push(`${viewport.label}: "${label.trim()}" left activeMode="${landed.activeMode}", not "full" - the button that promises the photo is not the button that shows it`);
  }
  if (!landed.showsPhoto) {
    failures.push(`${viewport.label}: "${label.trim()}" did not show the photo (#image-format-view has no .show-bg)`);
  }
  if (landed.toolbarHidden || !landed.moveBtnVisible) {
    failures.push(`${viewport.label}: after "${label.trim()}", "Move components" is not reachable (toolbarHidden=${landed.toolbarHidden}, moveBtnVisible=${landed.moveBtnVisible}) - so nothing on the image can be moved`);
  }

  // ---- 2. A word dragged from there moves on screen, not just in the model ----
  // Everything below is reached WITHOUT touching #mode-full-btn, so the whole
  // chain is the one a user walks.
  if (landed.moveBtnVisible) {
    await page.click("#editor-mode-btn");
    await page.waitForTimeout(200);

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
          return { id: w.id, text: w.el.textContent, cx, cy, left: r.left, top: r.top, modelX: w.x, modelY: w.y, fullEditorMode: state.fullEditorMode };
        }
      }
      return null;
    });

    if (!before) {
      failures.push(`${viewport.label}: no word was on screen to drag - test setup problem, not the thing under test`);
    } else if (!before.fullEditorMode) {
      failures.push(`${viewport.label}: clicking "Move components" did not enter Move-components mode`);
    } else {
      await page.mouse.move(before.cx, before.cy);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(before.cx + (DRAG_DX * i) / 12, before.cy + (DRAG_DY * i) / 12);
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
