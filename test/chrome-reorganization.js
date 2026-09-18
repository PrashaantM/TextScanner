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
// ---- 3. The corner menu is attached to its button, and on screen ----
//
// The menu used to be markup INSIDE #result-section, which is a .flow-panel -
// and .flow-panel's `transform: translateY(...)` (it keeps translateY(0) after
// the reveal, which is still a transform) makes that element a containing
// block for every position:fixed descendant. So the menu, positioned from
// downloadBtn.getBoundingClientRect() - viewport coordinates - resolved those
// coordinates against #result-section's box instead, and opened hundreds of
// pixels below the fold. index.html's comment on #text-clipboard-menu had
// already named this trap and predicted #download-menu shared it.
//
// Checked AFTER SCROLLING, because that is the only state where the bug shows:
// at scrollY 0 a fixed element and one captured by a containing block at the
// top of the document agree, and a gate that never scrolls passes either way.
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(150);
await openCornerMenu();
const anchored = await page.evaluate(() => {
  const btn = document.getElementById("download-btn");
  const menu = document.getElementById("download-menu");
  const b = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  return {
    onScreen: m.top >= 0 && m.left >= 0 && m.bottom <= innerHeight && m.right <= innerWidth,
    // Under the button if there is room, above it if there is not - either way
    // touching it rather than floating somewhere else on the page.
    verticalGap: Math.min(Math.abs(m.top - b.bottom), Math.abs(b.top - m.bottom)),
    rightEdgeGap: Math.abs(m.right - b.right),
    menu: { t: Math.round(m.top), b: Math.round(m.bottom), l: Math.round(m.left), r: Math.round(m.right) },
    viewport: { w: innerWidth, h: innerHeight },
  };
});
check("the corner menu opens fully on screen, after the page has been scrolled", anchored.onScreen, JSON.stringify(anchored));
check("...anchored to the button rather than floating elsewhere", anchored.verticalGap <= 8, `${anchored.verticalGap.toFixed(1)}px from the button's edge`);
check("...and right-aligned with it, since the toolbar row is right-aligned", anchored.rightEdgeGap <= 2, `${anchored.rightEdgeGap.toFixed(1)}px between the right edges`);
await page.keyboard.press("Escape");

// ---- 4. The toolbar's tool rows are right-aligned ----
const alignment = await page.evaluate(() =>
  [...document.querySelectorAll(".result-toolbar__actions")].map((r) => getComputedStyle(r).justifyContent)
);
check(
  "the filter set and More actions sit against the right edge, not the left",
  alignment.length > 0 && alignment.every((j) => j === "flex-end"),
  `justify-content: ${[...new Set(alignment)].join(", ")}`
);

// ---- 5. Download text is the WHOLE text, selection or not ----
//
// Copy and Download shared getActiveResultText, which narrows to the selection.
// That is right for Copy - "copy this word" has no other reading - and wrong
// for Download, which writes a file called textscanner-result.txt: a transient
// selection left over from editing silently turned the result into one word.
//
// Asked in FULL IMAGE mode, because that is the only place the question exists.
// getActiveResultText narrows by selection only in Image format/Full image -
// Text mode has no per-word selection to narrow to, and reads the textarea
// through the filter instead - so posing this in Text mode would compare two
// identical strings and pass no matter which way Download behaved.
await page.click('.mode-toggle__btn[data-mode="full"]');
await page.waitForTimeout(250);
const downloadScope = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const { getActiveResultText } = await import("/js/editorExport.js");
  const word = state.editorObjects.find((o) => o.type === "word" && o.el.textContent.trim());
  state.selectedObjectIds.clear();
  state.selectedObjectIds.add(word.id);
  return {
    selected: state.selectedObjectIds.size,
    download: getActiveResultText({ restrictToSelection: false }),
    copy: getActiveResultText(),
  };
});
check(
  "with a word selected, Download text still writes the whole result",
  downloadScope.selected === 1 && downloadScope.download.split("\n").length > 1,
  `${downloadScope.download.length} chars`
);
check(
  "...while Copy still narrows to the selection",
  downloadScope.copy.length > 0 && downloadScope.copy.length < downloadScope.download.length,
  `copy="${downloadScope.copy}"`
);

// ---- 6. The move handle reads as a move handle ----
//
// It was a plain accent dot, the same size and shape as resize-handle's square
// but round - so on a selected word showing both, the only thing separating
// "drag me to move this" from "drag me to resize this" was a corner radius.
// It is a four-way arrow now, drawn as a mask over an --accent background so
// it follows the theme (a baked-in SVG fill would be the light theme's teal in
// dark mode).
// Selected through a real click, not by writing to state: section 5 above set
// selectedObjectIds directly (it only needed getActiveResultText to see a
// selection) and never told the view, so the handles were still hidden. Going
// through the app's own path is also what puts move-handle where it belongs.
await page.evaluate(async () => {
  const { clearSelection } = await import("/js/editorObjects.js");
  clearSelection();
  const { state } = await import("/js/state.js");
  const word = state.editorObjects.find((o) => o.type === "word" && o.el.textContent.trim() && !o.removed);
  word.el.scrollIntoView({ block: "center" });
});
await page.waitForTimeout(150);
const firstWord = await page.$("#image-format-view .image-format-word");
await firstWord.click();
await page.waitForTimeout(250);
const handle = await page.evaluate(() => {
  const el = document.getElementById("move-handle");
  const after = getComputedStyle(el, "::after");
  const before = getComputedStyle(el, "::before");
  const maskOf = (cs) => cs.maskImage && cs.maskImage !== "none" ? cs.maskImage : cs.webkitMaskImage || "none";
  return {
    visible: getComputedStyle(el).display !== "none",
    hit: getComputedStyle(el).width,
    glyph: after.width,
    mask: maskOf(after),
    haloMask: maskOf(before),
    // The old dot's shape, which must be gone: a circle drawn by border-radius.
    radius: after.borderRadius,
    glyphColor: after.backgroundColor,
    haloColor: before.backgroundColor,
  };
});
check("the move handle is shown for a selected word", handle.visible);
check("...drawn as a masked move icon, not a border-radius dot", handle.mask.includes("svg") && handle.radius !== "50%", JSON.stringify({ radius: handle.radius, mask: handle.mask.slice(0, 40) }));
check("...with a contrast halo behind it, so it stays readable on a photo", handle.haloMask.includes("svg") && handle.haloColor !== handle.glyphColor);
check("...at the same visible size as before, on the same 28px hit target", handle.glyph === "11px" && handle.hit === "28px", `${handle.glyph} glyph on a ${handle.hit} target`);


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
console.log("\nThe filter set is Text-mode only (and genuinely inert elsewhere), Download/Save as note/Add as document page are all reachable from one right-aligned corner menu that opens attached to its button, Download text ignores the selection, and the move handle looks like one.");
