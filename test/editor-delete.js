// editor-delete.js: the whole life of a deleted OCR word, driven through the
// real Delete button.
//
// WHY THIS EXISTS. Deleting a recognized word does not remove its object - it
// clears the text and reveals an inpainted patch, because that patch is what
// hides the photo's own pixels and it belongs to the object. Take the object
// away and the original text comes straight back, on screen and in the exported
// PNG. That design is right, and nothing here changes it.
//
// What it left behind was not right. The emptied span stayed in the document,
// and an emptied span is not zero-sized: it keeps min-width from the word's
// bounding box, so it remained a full-width strip a couple of pixels tall that
// still caught taps, still drew selection chrome, and still enabled the Delete
// button when selected. Pressing Delete on it did nothing whatsoever - the
// handler's `if (obj.el.textContent === "") return;` skipped it, `changed`
// stayed false, and the function bailed before even clearing the selection. The
// user got an enabled button, an obvious target, and no response at all, with no
// way to ever get rid of it. That is the "empty components remain and can't be
// deleted" report.
//
// Nothing in CI covered the second press. test/destructive-actions.js covers the
// eleven paths behind a window.confirm, and deleting a word is not one of them;
// every other gate deletes a word once and moves on. The sequence that breaks is
// specifically delete-then-delete-again, which no test had ever performed.
//
// The fix retires the leftover rather than removing it (js/editorObjects.js's
// setWordRemoved), so the assertions below are about what a person can reach:
// the strip stops being selectable and focusable, while the deletion itself -
// the patch, and the exported image - keeps holding. And it is undoable, because
// every other edit in this editor is.
//
// Usage: node test/editor-delete.js   (exits non-zero if anything regressed)

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

const failures = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic1.jpeg"));
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
await page.click("#mode-full-btn");
await page.waitForTimeout(250);

// The state a person can observe, plus the two things only the model knows
// (whether the patch that holds the deletion is still shown, and how deep undo
// is). `reachable` is the crux: not "is the object gone" - it must not be - but
// "can a person still hit this thing".
const probe = () =>
  page.evaluate(() => {
    const o = window.__state.editorObjects.find((x) => x.id === window.__target);
    if (!o) return { missing: true };
    const r = o.el.getBoundingClientRect();
    const cs = getComputedStyle(o.el);
    const centreX = Math.round(r.left + r.width / 2);
    const centreY = Math.round(r.top + r.height / 2);
    return {
      text: o.el.textContent,
      objectStillExists: true,
      inDocument: document.contains(o.el),
      // Would a click at the middle of where it sits actually land on it?
      reachable: r.width > 0 && r.height > 0 && document.elementFromPoint(centreX, centreY) === o.el,
      focusable: cs.display !== "none" && o.el.tabIndex >= 0 && r.width > 0 && r.height > 0,
      selected: window.__state.selectedObjectIds.has(o.id),
      deleteBtnDisabled: document.getElementById("delete-btn").disabled,
      patchShown: getComputedStyle(o.patchEl).display !== "none",
      undoDepth: window.__state.undoStack.length,
      removedFlag: !!o.removed,
    };
  });

const selectTarget = async () => {
  const handle = await page.evaluateHandle(() => {
    const o = window.__state.editorObjects.find((x) => x.id === window.__target);
    o.el.scrollIntoView({ block: "center" });
    return o.el;
  });
  await handle.click();
  await page.waitForTimeout(150);
};

// A word big enough to be an easy target, in the middle of the image.
const target = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  window.__state = state;
  const w = state.editorObjects.find(
    (o) => o.type === "word" && o.origin === "ocr" && o.el.textContent.trim().length >= 4
  );
  if (!w) return null;
  window.__target = w.id;
  return { id: w.id, text: w.el.textContent };
});
if (!target) {
  console.error("FAILED: no recognized word to delete - test setup is broken");
  process.exit(1);
}
console.log(`target word: "${target.text}"`);

// ---- 1. First Delete empties it and reveals the patch ----
await selectTarget();
await page.click("#delete-btn");
await page.waitForTimeout(900);
const emptied = await probe();
if (emptied.text !== "") failures.push(`after Delete the word still reads "${emptied.text}"`);
if (!emptied.objectStillExists) failures.push("Delete removed the word object outright - the inpainted patch goes with it and the photo's own text comes back");
if (!emptied.patchShown) failures.push("after Delete the inpainted patch is not shown, so the original pixels are still visible");

// ---- 2. The emptied leftover is still a target, and Delete claims it can act ----
// This half is not a bug: the leftover has to stay selectable so it can be
// retyped into or undone. What was broken is what the second press did.
await selectTarget();
const leftover = await probe();
if (!leftover.selected) {
  failures.push("the emptied leftover could not be selected at all - then there is nothing for Delete to act on and this gate proves nothing");
}
if (leftover.deleteBtnDisabled) {
  failures.push("Delete is disabled for the emptied leftover, but it is selected - the button and the selection disagree");
}

// ---- 3. The second Delete has to actually do something ----
const undoBefore = leftover.undoDepth;
await page.click("#delete-btn");
await page.waitForTimeout(400);
const retired = await probe();

if (retired.reachable) {
  failures.push(
    `Delete on the emptied leftover left it reachable: a click at its centre still lands on it. ` +
      `This is the reported bug - an invisible strip that can be selected forever and never removed`
  );
}
if (retired.focusable) {
  failures.push("the retired leftover is still focusable, so Tab still stops on an item that shows nothing");
}
if (retired.selected) {
  failures.push("the retired leftover is still selected - Delete acted but never cleared the selection");
}
if (retired.undoDepth <= undoBefore) {
  failures.push(`the second Delete pushed no undo step (depth ${undoBefore} -> ${retired.undoDepth}) - an action the user can't take back, or an action that never happened`);
}
// The deletion itself must survive the retirement, or "delete the leftover"
// silently un-deletes the word.
if (!retired.objectStillExists) failures.push("retiring the leftover removed the object, taking the inpainted patch with it");
if (!retired.patchShown) failures.push("retiring the leftover hid the inpainted patch, so the photo's original text is visible again");

// ---- 4. A marquee that sweeps the whole image must not pick it back up ----
// UI-REDESIGN-PLAN.md §2.3: marquee is a press-and-hold-then-drag starting on
// empty canvas now, not a button-armed mode - no separate arm/disarm step,
// and it coexists with Full image mode rather than requiring it be left.
await page.evaluate(() => {
  window.__state.selectedObjectIds.clear();
});
const box = await page.evaluate(() => {
  const r = document.getElementById("image-format-view").getBoundingClientRect();
  return { x1: r.left + 2, y1: Math.max(r.top + 2, 2), x2: r.right - 2, y2: Math.min(r.bottom - 2, innerHeight - 2) };
});
await page.mouse.move(box.x1, box.y1);
await page.mouse.down();
await page.waitForTimeout(450); // past the 420ms hold threshold, arms the marquee
await page.mouse.move(box.x2, box.y2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const sweptIn = await page.evaluate(() => window.__state.selectedObjectIds.has(window.__target));
if (sweptIn) failures.push("a marquee across the whole image re-selected the retired leftover");

// ---- 5. Undo brings it back, because everything else in this editor is undoable ----
await page.click("#undo-btn");
await page.waitForTimeout(300);
const undone = await probe();
if (!undone.reachable) {
  failures.push("Undo did not bring the retired leftover back - it is still hidden, so the retirement is a one-way door");
}
if (undone.removedFlag) failures.push("Undo restored the leftover's text but left it flagged removed");

// ---- 6. Redo retires it again ----
await page.click("#redo-btn");
await page.waitForTimeout(300);
const redone = await probe();
if (redone.reachable) failures.push("Redo did not re-retire the leftover");

// ---- 7. The exported image still hides the word ----
// The patch is drawn into the export from the object model, so a retired word
// that stopped contributing its patch would put the photo's own text back into
// the downloaded PNG while the screen still looked correct.
const exportHidesIt = await page.evaluate(async () => {
  const { buildResultCanvas } = await import("/js/editorExport.js");
  const { state } = await import("/js/state.js");
  const o = state.editorObjects.find((x) => x.id === window.__target);
  const canvas = buildResultCanvas();
  if (!canvas) return { ok: false, reason: "buildResultCanvas returned null" };
  const raw = document.createElement("canvas");
  raw.width = canvas.width;
  raw.height = canvas.height;
  const rctx = raw.getContext("2d");
  rctx.drawImage(document.getElementById("image-format-bg"), 0, 0, raw.width, raw.height);
  const x = Math.round((o.originalX / 100) * canvas.width);
  const y = Math.round((o.originalY / 100) * canvas.height);
  const w = Math.max(2, Math.round((o.originalW / 100) * canvas.width));
  const h = Math.max(2, Math.round((o.originalH / 100) * canvas.height));
  const a = canvas.getContext("2d").getImageData(x, y, w, h).data;
  const b = rctx.getImageData(x, y, w, h).data;
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return { ok: true, meanDiff: diff / (a.length / 4) };
});
// The same idea, and the same calibration, as test/move-inpaint.js: an
// inpainted fill differs from the raw source by tens of points, untouched
// pixels by a couple.
const MIN_EXPECTED_DIFF = 15;
if (!exportHidesIt.ok) {
  failures.push(`could not check the export: ${exportHidesIt.reason}`);
} else if (exportHidesIt.meanDiff < MIN_EXPECTED_DIFF) {
  failures.push(
    `the exported image shows the raw source pixels where the retired word was (diff ${exportHidesIt.meanDiff.toFixed(2)} < ${MIN_EXPECTED_DIFF}) - ` +
      `retiring the leftover un-deleted the word in the download`
  );
} else {
  console.log(`export still covers the deleted word (mean RGB diff vs raw photo: ${exportHidesIt.meanDiff.toFixed(2)})`);
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAn emptied word can be deleted, stays deleted in the export, and comes back with Undo.");
