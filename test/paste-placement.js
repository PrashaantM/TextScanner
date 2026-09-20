// paste-placement.js: Phase 2's copy/paste - Ctrl/Cmd+C on a selected,
// non-editing word records its resolved font/size/colour; Ctrl/Cmd+V arms a
// placement click (the SAME arm-then-place flow Paste's old button drove,
// unchanged - UI-REDESIGN-PLAN.md §2.2), which clones that word exactly
// rather than building a fresh default-styled one.
//
// WHY THIS EXISTS. Originally covered copy-btn/paste-btn, which are gone -
// deleted along with the whole idea of "paste whatever plain text is on the
// OS clipboard as a new default-styled box." What replaced it needed real
// coverage of three things nothing else in this suite checks: that Ctrl/
// Cmd+C/V actually reproduces a copied word's exact appearance (not just its
// text), that the same shortcut inside an actively-edited word is left
// alone for the browser's own native copy/paste, and that a touch long-press
// on a selected word reaches the same copy/paste through a small menu
// instead of a keyboard shortcut. The underlying placement mechanism
// (addUserTextObject/addClonedTextObject in js/editorInteractions.js) is
// otherwise unchanged from what this file already exercised.
//
// Usage: node test/paste-placement.js   (exits non-zero if anything regressed)

import { launchBrowser, skipUnlessChromium, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
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
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
};

const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1200, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.click("#nav-add");
await page.click("#action-sheet-scan");
await page.waitForSelector("#sample-btn", { state: "visible" });
await page.click("#sample-btn");
await page.waitForSelector("#preview-section:not(.hidden)");
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 30000 });
await page.click("#mode-full-btn");
await page.evaluate(() => document.getElementById("image-format-view").scrollIntoView({ block: "start" }));
await page.waitForTimeout(300);

const objectCount = () => page.evaluate(async () => (await import("/js/state.js")).state.editorObjects.length);

// A placement click has to land where nothing else is - the sample image's
// text fills enough of the canvas that a guessed percentage point can easily
// land ON a word instead, which routes through the "select/edit that word"
// branch rather than the placement branch and makes this test fail for a
// reason that has nothing to do with the thing under test (the same lesson
// touch-interactions.js's marquee check learned the hard way).
const findEmptyPoint = () =>
  page.evaluate(async () => {
    const { state } = await import("/js/state.js");
    const view = document.getElementById("image-format-view");
    const r = view.getBoundingClientRect();
    const margin = 6;
    const wordRects = state.editorObjects.filter((o) => o.type === "word" && !o.removed).map((o) => o.el.getBoundingClientRect());
    const top = Math.max(r.top, 0) + margin;
    const bottom = Math.min(r.bottom, innerHeight) - margin;
    const left = r.left + margin;
    const right = r.right - margin;
    for (let y = top; y < bottom; y += 8) {
      for (let x = left; x < right; x += 8) {
        const clear = wordRects.every((wr) => x < wr.left - margin || x > wr.right + margin || y < wr.top - margin || y > wr.bottom + margin);
        if (clear) return { x, y };
      }
    }
    return null;
  });

// ---- 1. The buttons are gone from the DOM ----
const buttonsGone = await page.evaluate(() => !document.getElementById("copy-btn") && !document.getElementById("paste-btn"));
check("copy-btn and paste-btn are gone from the DOM", buttonsGone);

// ---- 2. Ctrl/Cmd+C on a selected, non-editing word records its exact
// resolved font/size/colour; Ctrl/Cmd+V arms placement (the same click-to-
// place-or-cancel flow as before), and the clone reproduces all of it, not
// just the text ----
const source = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const w = state.editorObjects.find((o) => o.type === "word" && o.el.textContent.trim());
  w.el.scrollIntoView({ block: "center" });
  const r = w.el.getBoundingClientRect();
  return { id: w.id, x: r.left + r.width / 2, y: r.top + r.height / 2, text: w.el.textContent, fontSizePct: w.fontSizePct, textColor: w.textColor, fontClass: w.fontClass };
});

await page.mouse.click(source.x, source.y); // single click: select only
await page.waitForTimeout(150);
await page.keyboard.press("ControlOrMeta+C");
await page.waitForTimeout(150);
const copiedElement = await page.evaluate(async () => (await import("/js/state.js")).state.copiedElement);
check(
  "Ctrl/Cmd+C on a selected word records its text, size, colour and font class",
  copiedElement?.text === source.text &&
    copiedElement?.fontSizePct === source.fontSizePct &&
    copiedElement?.textColor === source.textColor &&
    copiedElement?.fontClass === source.fontClass,
  JSON.stringify({ source, copiedElement })
);

await page.keyboard.press("ControlOrMeta+V");
await page.waitForTimeout(150);
const armedViaKeyboard = await page.evaluate(async () => (await import("/js/state.js")).state.pasteArmed);
check("Ctrl/Cmd+V arms placement", armedViaKeyboard === true, `got ${armedViaKeyboard}`);

const before = await objectCount();
const tapPoint = await findEmptyPoint();
if (!tapPoint) {
  console.error("FAILED: could not find an empty point on the image surface to place at");
  process.exit(1);
}
await page.mouse.click(tapPoint.x, tapPoint.y);
await page.waitForTimeout(300);

const placed = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const id = [...state.selectedObjectIds][0];
  const obj = state.editorObjects.find((o) => o.id === id);
  return obj ? { text: obj.el.textContent, origin: obj.origin, fontSizePct: obj.fontSizePct, textColor: obj.textColor, fontClass: obj.fontClass } : null;
});
const after = await objectCount();

check("placing added exactly one new object", after === before + 1, `${before} -> ${after}`);
check("...as a user-origin clone of the copied word", placed?.origin === "user", JSON.stringify(placed));
check(
  "...reproducing the copied word's exact text, size, colour and font class",
  placed?.text === source.text && placed?.fontSizePct === source.fontSizePct && placed?.textColor === source.textColor && placed?.fontClass === source.fontClass,
  JSON.stringify({ source, placed })
);

const disarmedAfterPlace = await page.evaluate(async () => (await import("/js/state.js")).state.pasteArmed);
check("placing disarms paste mode", disarmedAfterPlace === false, `got ${disarmedAfterPlace}`);

// Tapping away from the freshly-placed (non-empty) word must not undo the
// placement - only an EMPTY placed word gets silently removed on blur.
// Clicking the toolbar heading is a stable way to blur that has nothing to
// do with the image surface itself.
await page.click(".result-toolbar h2");
await page.waitForTimeout(200);
const survivedBlur = await objectCount();
check("the placed word survives clicking away from it", survivedBlur === after, `${after} -> ${survivedBlur}`);

// ---- 3. Ctrl/Cmd+C/V while a word is actively being edited does normal
// in-place text-selection copy/paste instead - state.copiedElement (and
// pasteArmed) must stay untouched ----
await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  state.copiedElement = null;
});
const editTarget = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const w = state.editorObjects.find((o) => o.type === "word" && o.origin === "ocr" && o.el.textContent.trim());
  w.el.scrollIntoView({ block: "center" });
  return w.id;
});
const editHandle = await page.evaluateHandle(async (id) => {
  const { state } = await import("/js/state.js");
  return state.editorObjects.find((x) => x.id === id).el;
}, editTarget);
await editHandle.dblclick(); // enters edit mode (Phase 1)
await page.waitForTimeout(150);
await page.keyboard.press("ControlOrMeta+C");
await page.keyboard.press("ControlOrMeta+V");
await page.waitForTimeout(150);
const duringEdit = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  return { copiedElement: state.copiedElement, pasteArmed: state.pasteArmed };
});
check(
  "Ctrl/Cmd+C/V while editing a word leaves state.copiedElement/pasteArmed untouched",
  duringEdit.copiedElement === null && duringEdit.pasteArmed === false,
  JSON.stringify(duringEdit)
);
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(150);

// ---- 4. A simulated long-press on a touch viewport shows the copy/paste
// menu near the touch point (Chromium/CDP only - see touch-interactions.js
// for why a real trusted touch event needs the DevTools protocol rather than
// Playwright's own synthesized touchscreen API) ----
if (!skipUnlessChromium("needs CDP Input.dispatchTouchEvent for a genuine long-press, same as test/touch-interactions.js")) {
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const touchPage = await touchContext.newPage();
  const touchCdp = await touchContext.newCDPSession(touchPage);
  const tap = async (p) => {
    await touchCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await touchCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const pressHold = async (p, ms) => {
    await touchCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await new Promise((resolve) => setTimeout(resolve, ms));
    await touchCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await touchPage.goto(`http://localhost:${PORT}/index.html`);
  await touchPage.click("#nav-add");
  await touchPage.click("#action-sheet-scan");
  await touchPage.waitForSelector("#sample-btn", { state: "visible" });
  await touchPage.click("#sample-btn");
  await touchPage.waitForSelector("#preview-section:not(.hidden)");
  await touchPage.click("#scan-btn");
  await touchPage.waitForSelector("#result-section:not(.hidden)", { timeout: 30000 });
  await touchPage.click("#mode-full-btn");
  await touchPage.waitForTimeout(300);

  const touchTarget = await touchPage.evaluate(async () => {
    const { state } = await import("/js/state.js");
    const words = state.editorObjects.filter((o) => o.type === "word" && o.el.textContent.trim());
    for (const w of words) {
      w.el.scrollIntoView({ block: "center" });
      const r = w.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx > 30 && cx < innerWidth - 30 && cy > 90 && cy < innerHeight - 120 && r.width > 60 && r.height > 20) return { x: cx, y: cy };
    }
    return null;
  });

  if (!touchTarget) {
    failures.push("touch long-press menu: no suitably sized word to target");
  } else {
    await tap(touchTarget); // select
    await touchPage.waitForTimeout(300);
    await pressHold(touchTarget, 500); // long-press the now-selected word
    await touchPage.waitForTimeout(200);
    const menuVisible = await touchPage.evaluate(() => !document.getElementById("text-clipboard-menu").classList.contains("hidden"));
    check("a long-press on a selected word shows the touch copy/paste menu", menuVisible);

    // Dismissed on an outside tap.
    await tap({ x: 5, y: 5 });
    await touchPage.waitForTimeout(150);
    const menuHiddenAfterOutsideTap = await touchPage.evaluate(() => document.getElementById("text-clipboard-menu").classList.contains("hidden"));
    check("...and dismissed by tapping outside it", menuHiddenAfterOutsideTap);
  }

  await touchContext.close();
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nCtrl/Cmd+C/V clone a selected word's exact appearance, leave in-place editing untouched, and the touch long-press menu reaches the same thing.");
