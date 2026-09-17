// chrome-reorganization.js: Phase 3 of the interaction-model rewrite.
//
// WHY THIS EXISTS. Two chrome consolidations landed with nothing driving them
// through a real browser before this file:
//
//   1. The filter set (Raw/Filtered Text/Clean up this text) is Text-mode
//      only now - js/editorInteractions.js's setMode makes it inert (not
//      just visually hidden) in Image format/Full image, since it has
//      nothing to toggle there (the level it's set to still drives
//      word-dimming and Copy/Download/TTS via state, independent of the
//      control's visibility).
//   2. Download, Save as note and Add as document page - three previously
//      separate controls, one of them (Add as document page) on an entirely
//      different screen (the pre-scan preview, not the post-scan result) -
//      are one small corner menu (#download-menu) now. New Text was deleted
//      outright in the same phase; test/dom-contract.js's static check
//      covers that one (nothing to drive through a browser for a control
//      that no longer exists).
//
// Usage: node test/chrome-reorganization.js   (exits non-zero if anything regressed)

import { launchBrowser } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8140;
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
const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
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

// ---- 1. The pre-scan preview screen has no "Add as document page" of its
// own any more - it moved into the post-scan corner menu ----
const addToDocOnPreviewScreen = await page.evaluate(() => !!document.getElementById("add-to-doc-btn"));
check("Add as document page is gone as a standalone element", !addToDocOnPreviewScreen);

const saveNoteStandalone = await page.evaluate(() => !!document.getElementById("save-note-btn"));
check("Save as note is gone as a standalone element", !saveNoteStandalone);

// ---- 2. The filter set: Text-mode only, and actually inert elsewhere, not
// just visually hidden ----
const filterState = () =>
  page.evaluate(() => {
    const el = document.getElementById("filter-toggle-row");
    const raw = document.getElementById("filter-raw-btn");
    return {
      hidden: el.classList.contains("hidden"),
      displayed: getComputedStyle(el).display !== "none",
      inert: el.inert,
      rawFocusable: raw.tabIndex >= 0 && !raw.disabled,
    };
  });

const inText = await filterState();
check("filter set is visible in Text mode", !inText.hidden && inText.displayed, JSON.stringify(inText));
check("...and not inert in Text mode", !inText.inert, JSON.stringify(inText));

await page.click("#mode-image-btn");
await page.waitForTimeout(150);
const inImage = await filterState();
check("filter set is hidden (display:none, not just visually) in Image format mode", inImage.hidden && !inImage.displayed, JSON.stringify(inImage));
check("...and inert (unfocusable) in Image format mode", inImage.inert, JSON.stringify(inImage));

await page.click("#mode-full-btn");
await page.waitForTimeout(150);
const inFull = await filterState();
check("filter set is hidden in Full image mode", inFull.hidden && !inFull.displayed, JSON.stringify(inFull));
check("...and inert in Full image mode", inFull.inert, JSON.stringify(inFull));

// A filter level chosen in Text mode still drives word-dimming/Copy/Download/
// TTS in Image format/Full image even though the control itself is inert
// there - the level lives in state, not in the (now hidden) buttons.
const levelSurvives = await page.evaluate(async () => (await import("/js/state.js")).state.activeFilterLevel);
check("the active filter level persists in state while its control is inert", !!levelSurvives, levelSurvives);

await page.click("#mode-text-btn");
await page.waitForTimeout(150);
const backInText = await filterState();
check("filter set is visible again back in Text mode", !backInText.hidden && !backInText.inert, JSON.stringify(backInText));

// ---- 3. Download, Save as note and Add as document page are all reachable
// from the one corner menu, in every mode - including Text mode, which used
// to skip the menu and download directly ----
async function openCornerMenu() {
  await page.click("#download-btn");
  await page.waitForTimeout(150);
  return page.evaluate(() => !document.getElementById("download-menu").classList.contains("hidden"));
}

const menuOpenInText = await openCornerMenu();
check("the corner menu opens from Text mode (no more download-directly bypass)", menuOpenInText);
const itemsInText = await page.evaluate(() => [...document.querySelectorAll("#download-menu button")].map((b) => b.dataset.download || b.dataset.menuAction));
check(
  "...and offers all four actions",
  itemsInText.includes("image") && itemsInText.includes("text") && itemsInText.includes("save-note") && itemsInText.includes("add-to-doc"),
  JSON.stringify(itemsInText)
);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// Save as note: clicking the menu item creates a note and navigates to it.
await openCornerMenu();
await page.click('#download-menu [data-menu-action="save-note"]');
await page.waitForTimeout(500);
const afterSaveNote = await page.evaluate(() => document.body.dataset.activeView);
check("Save as note (from the corner menu) navigates to the created document", afterSaveNote === "document", `activeView="${afterSaveNote}"`);

// Add as document page: a fresh scan setup (rather than continuing from the
// note just created above), so previewImg is freshly populated and this
// check doesn't depend on where Save as note left the app.
await page.click("#nav-library");
await page.waitForTimeout(200);
await page.click("#nav-add");
await page.click("#action-sheet-scan");
await page.waitForSelector("#sample-btn", { state: "visible" });
await page.click("#sample-btn");
await page.waitForSelector("#preview-section:not(.hidden)");
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 30000 });

await openCornerMenu();
await page.click('#download-menu [data-menu-action="add-to-doc"]');
await page.waitForTimeout(500);
const afterAddToDoc = await page.evaluate(() => document.body.dataset.activeView);
check(
  "Add as document page (from the corner menu) navigates away from the scan result",
  afterAddToDoc === "document" || afterAddToDoc === "crop",
  `activeView="${afterAddToDoc}"`
);

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nThe filter set is Text-mode only (and genuinely inert elsewhere), and Download/Save as note/Add as document page are all reachable from one corner menu.");
