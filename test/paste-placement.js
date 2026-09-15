// paste-placement.js: Paste's arm-then-place mechanism in Image format/Full
// image mode (UI-REDESIGN-PLAN.md §2.2) - arms on click, places the
// clipboard's text as a new object at the next tap, and can be cancelled.
//
// WHY THIS EXISTS. This mirrors newTextBtn's own arm-then-place pattern
// exactly (same addUserTextObject call, just pre-filled) - and that pattern
// had no direct browser-driven coverage anywhere in this suite before this
// file, in either its original (New text) or new (Paste) form. Both go
// through addUserTextObject in js/editorInteractions.js, so this is also the
// first real coverage of that shared code path, not just of what's new here.
//
// Usage: node test/paste-placement.js   (exits non-zero if anything regressed)

import { launchBrowser } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8139;
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

// ---- 1. Arming Paste sets aria-pressed and flips the label to Cancel,
// mirroring newTextBtn exactly ----
await page.evaluate(() => navigator.clipboard.writeText("pasted word"));
const beforeArm = await page.evaluate(() => document.getElementById("paste-btn").textContent.trim());
check('Paste starts labeled "Paste"', beforeArm === "Paste", `got "${beforeArm}"`);

await page.click("#paste-btn");
await page.waitForTimeout(200);
const armed = await page.evaluate(() => ({
  label: document.getElementById("paste-btn").textContent.trim(),
  pressed: document.getElementById("paste-btn").getAttribute("aria-pressed"),
}));
check('arming Paste flips the label to "Cancel"', armed.label === "Cancel", `got "${armed.label}"`);
check("...and sets aria-pressed", armed.pressed === "true", `got "${armed.pressed}"`);

// ---- 2. Tapping the surface while armed places the clipboard text as a new
// object, selected, at the tapped point ----
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
  return obj ? { text: obj.el.textContent, origin: obj.origin, x: obj.x, y: obj.y } : null;
});
const after = await objectCount();

check("placing added exactly one new object", after === before + 1, `${before} -> ${after}`);
check("...pre-filled with the clipboard's text", placed?.text === "pasted word", JSON.stringify(placed));
check("...as a user-origin object, not OCR", placed?.origin === "user", JSON.stringify(placed));

const disarmed = await page.evaluate(() => document.getElementById("paste-btn").textContent.trim());
check("placing disarms Paste (label back to normal)", disarmed === "Paste", `got "${disarmed}"`);

// Tapping away from the freshly-placed (non-empty) word must not undo the
// placement - only an EMPTY placed word gets silently removed on blur.
// Clicking the toolbar heading is a stable way to blur that has nothing to
// do with the image surface itself.
await page.click(".result-toolbar h2");
await page.waitForTimeout(200);
const survivedBlur = await objectCount();
check("the placed word survives clicking away from it", survivedBlur === after, `${after} -> ${survivedBlur}`);

// ---- 3. Arming, then clicking Paste again (not placing) cancels it with no
// new object ----
await page.evaluate(() => navigator.clipboard.writeText("should not appear"));
await page.click("#paste-btn");
await page.waitForTimeout(150);
await page.click("#paste-btn");
await page.waitForTimeout(150);
const cancelledLabel = await page.evaluate(() => document.getElementById("paste-btn").textContent.trim());
const cancelledCount = await objectCount();
check('clicking Paste again while armed cancels it (label back to "Paste")', cancelledLabel === "Paste", `got "${cancelledLabel}"`);
check("...and no object was added", cancelledCount === survivedBlur, `${survivedBlur} -> ${cancelledCount}`);

// ---- 4. Arming Paste disarms New text, and vice versa - the two placement
// tools are mutually exclusive ----
await page.click("#new-text-btn");
await page.waitForTimeout(150);
const newTextArmed = await page.evaluate(() => document.getElementById("new-text-btn").textContent.trim());
check('New text arms independently ("Cancel")', newTextArmed === "Cancel", `got "${newTextArmed}"`);

await page.evaluate(() => navigator.clipboard.writeText("mutual exclusion check"));
await page.click("#paste-btn");
await page.waitForTimeout(150);
const bothStates = await page.evaluate(() => ({
  newText: document.getElementById("new-text-btn").textContent.trim(),
  paste: document.getElementById("paste-btn").textContent.trim(),
}));
check("arming Paste disarms New text", bothStates.newText === "New text", JSON.stringify(bothStates));
check("...and Paste itself is armed", bothStates.paste === "Cancel", JSON.stringify(bothStates));
await page.click("#paste-btn"); // clean up: cancel before moving on

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nPaste's arm-then-place mechanism (and the addUserTextObject path it shares with New text) works end to end.");
