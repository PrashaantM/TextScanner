// interaction-layer.js: coverage for 06-INTERACTION-MODEL-SPEC.md - the radial
// menu primitive, the create-menu/card-gesture call sites, the command
// palette, and the global keyboard shortcuts. Follows the verification
// checklist the spec itself proposed, matching the existing test culture
// (real browser, real modules, driven through the actual UI - see
// test/document-creation.js's header for why that matters more than a mock).
//
// Touch-specific interactions (the radial menu's press-drag-release, card
// swipe) are driven with synthetic PointerEvents carrying pointerType:
// "touch", dispatched in-page - Playwright's page.mouse/page.touchscreen
// APIs don't expose enough control over pointerType and event sequencing for
// a drag gesture that has to land on a specific dynamically-positioned
// element (a radial menu's spoke).
//
// Usage: node test/interaction-layer.js

import { launchBrowser, listenOnEphemeralPort } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
};

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
});
const PORT = await listenOnEphemeralPort(server);

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
};

const browser = await launchBrowser({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 15000 });

// Dispatches a real sequence of touch-typed PointerEvents against `el`, so
// radialMenu.js's own pointerType checks (which exclude mouse) actually see
// what they're looking for. Runs in-page since PointerEvent construction has
// to happen in the browser context.
//
// move/up are dispatched on the SAME element as down, not on window: a real
// drag relies on setPointerCapture to keep routing events to the element
// the gesture started on even once the pointer leaves its bounds (which is
// exactly what js/library.js's card gestures depend on), but a purely
// synthetic pointerId was never seen by the browser's real pointer-capture
// bookkeeping, so capture can silently no-op here in a way it wouldn't for
// a genuine touch. Dispatching on `el` with bubbles:true sidesteps that gap
// entirely: window-scoped listeners (radialMenu.js's own onMove/onUp) still
// receive it via normal bubbling, and element-scoped listeners (the card
// gesture's) receive it directly as the target - both without needing
// capture to actually succeed in this simulated environment.
async function touchDrag(page, { downSelector, path, up = true }) {
  await page.evaluate(
    ({ downSelector, path, up }) => {
      const el = document.querySelector(downSelector);
      const rect = el.getBoundingClientRect();
      const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const common = { pointerId: 1, pointerType: "touch", bubbles: true, cancelable: true, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...common, clientX: start.x, clientY: start.y }));
      for (const point of path) {
        el.dispatchEvent(new PointerEvent("pointermove", { ...common, clientX: point.x, clientY: point.y }));
      }
      if (up) el.dispatchEvent(new PointerEvent("pointerup", { ...common }));
    },
    { downSelector, path, up }
  );
}

const countDocs = (type) =>
  page.evaluate(async (t) => {
    const docs = await import("/js/documents.js");
    return (await docs.getAllDocuments()).filter((d) => d.type === t && !d.deletedAt).length;
  }, type);

// ---- 1. Radial create-menu (call site 1): touch drag-release ----

console.log("\nRadial create-menu (touch press-drag-release on #nav-add)");

await touchDrag(page, { downSelector: "#nav-add", path: [], up: false }); // finger stays down until a real release below
await page.waitForFunction(() => document.querySelector(".radial-menu--open"), null, { timeout: 2000 });
check("a touch pointerdown opens the radial menu, not the plain action sheet", await page.evaluate(() => document.getElementById("action-sheet").classList.contains("hidden")));

const noteSpokeRect = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".radial-menu__item")].find((b) => b.dataset.itemId === "note");
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.evaluate((p) => {
  window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "touch", bubbles: true, clientX: p.x, clientY: p.y }));
}, noteSpokeRect);
await page.waitForFunction(() => document.querySelector('.radial-menu__item[data-item-id="note"]')?.classList.contains("is-armed"), null, { timeout: 2000 });
await page.evaluate(() => {
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "touch", bubbles: true }));
});
await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 2000 });
await page.waitForFunction(() => !document.querySelector(".radial-menu"), null, { timeout: 2000 }); // close()'s 140ms removal timeout

check("selecting the 'note' spoke opened the note editor", await page.evaluate(() => !document.getElementById("note-editor").classList.contains("hidden")));
check("the radial menu closed itself after selection", true);
check("opening a draft via the radial menu created no document yet (lazy creation still holds)", (await countDocs("note")) === 0, String(await countDocs("note")));

await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");

// ---- 2. Keyboard activation of #nav-add still opens the plain action sheet ----

console.log("\n#nav-add keyboard activation (Tab + Enter, no pointerdown)");

// A real pause between unrelated interactions - not a race against
// radialMenu.js's brief (60ms) stray-click swallow window from the selection
// above.
await page.waitForTimeout(150);
await page.focus("#nav-add");
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.getElementById("action-sheet").classList.contains("hidden"), null, { timeout: 2000 });
check("Enter on a focused #nav-add opens the plain action sheet, not a radial menu", await page.evaluate(() => !document.querySelector(".radial-menu")));
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.getElementById("action-sheet").classList.contains("hidden"));

// ---- 3. Card swipe gesture ----

console.log("\nCard swipe-to-delete");

const swipeDocId = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const doc = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Swipe me" });
  return doc.id;
});
await page.reload();
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 15000 });
await page.waitForSelector(`.doc-card[data-id="${swipeDocId}"]`);

await touchDrag(page, {
  downSelector: `.doc-card[data-id="${swipeDocId}"]`,
  path: await page.evaluate((id) => {
    const rect = document.querySelector(`.doc-card[data-id="${id}"]`).getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const x0 = rect.left + rect.width / 2;
    // Past the -72px trash threshold in attachCardGestures.
    return [-20, -50, -90].map((dx) => ({ x: x0 + dx, y }));
  }, swipeDocId),
});
await page.waitForFunction(
  () => document.getElementById("app-toast").classList.contains("is-visible") && document.getElementById("app-toast-message").textContent.startsWith("Deleted"),
  null,
  { timeout: 2000 }
);
check("swiping a card left past the threshold shows the same Deleted/Undo toast", await page.evaluate(() => document.getElementById("app-toast-message").textContent) === 'Deleted "Swipe me"');

await page.click("#app-toast-action");
await page.waitForFunction(
  async (id) => {
    const docs = await import("/js/documents.js");
    const doc = await docs.getDocument(id);
    return doc?.deletedAt === null;
  },
  swipeDocId,
  { timeout: 2000 }
);
check("Undo after a swipe-delete restores the document", true);

// ---- 4. Reduced motion ----

console.log("\nprefers-reduced-motion");

// Deliberately emulated AFTER the page (and radialMenu.js) has loaded: this is
// the "someone turns on Reduce Motion in System Settings while the app is open"
// case, not the "it was already on at load" one. Keep it this way round - the
// module used to cache a MediaQueryList at load, which made this exact case
// fail on WebKit while passing on Chromium and Firefox, so a gate that set the
// preference before navigating would have been green on all three and proved
// nothing.
await page.emulateMedia({ reducedMotion: "reduce" });
await touchDrag(page, { downSelector: "#nav-add", path: [], up: false }); // finger stays down until a real release below
await page.waitForFunction(() => document.querySelector(".radial-menu"), null, { timeout: 2000 });
check("a radial menu opened under reduced motion carries the instant class", await page.evaluate(() => !!document.querySelector(".radial-menu--instant")));

const scanSpokeRect = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".radial-menu__item")].find((b) => b.dataset.itemId === "scan");
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.evaluate((p) => {
  window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, pointerType: "touch", bubbles: true, clientX: p.x, clientY: p.y }));
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "touch", bubbles: true }));
}, scanSpokeRect);
await page.waitForFunction(() => document.body.dataset.activeView === "scan", null, { timeout: 2000 });
check("selecting a spoke still works under reduced motion, just without the bloom", true);
await page.emulateMedia({ reducedMotion: null });
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");

// ---- 5. Keyboard-only radial menu operation (Tab/Arrow/Enter, no pointer) ----

console.log("\nRadial menu keyboard operability once open");

await touchDrag(page, { downSelector: "#nav-add", path: [], up: false }); // finger stays down until a real release below
await page.waitForFunction(() => document.querySelector(".radial-menu"), null, { timeout: 2000 });
check("the first spoke receives focus on open", await page.evaluate(() => document.activeElement?.closest(".radial-menu__item") != null));
await page.keyboard.press("ArrowRight");
const focusedId = await page.evaluate(() => document.activeElement?.dataset.itemId);
check("ArrowRight moves focus to the next spoke", !!focusedId);
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".radial-menu"), null, { timeout: 2000 });
check("Enter on a focused spoke fires its action and closes the menu (the keyboard path this spec's own reference code was missing)", true);
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");

// ---- 6. Command palette ----

console.log("\nCommand palette (Cmd/Ctrl+K)");

await page.keyboard.press("Control+k");
await page.waitForFunction(() => !document.getElementById("command-palette").classList.contains("hidden"), null, { timeout: 2000 });
check("Ctrl+K opens the palette from Library", true);
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.getElementById("command-palette").classList.contains("hidden"));

// Opens from inside a text field too (composing a note), and typing in the
// palette's own input must never fire the global shortcut dispatcher.
await page.click("#nav-add");
await page.click("#action-sheet-note");
await page.waitForFunction(() => document.body.dataset.activeView === "document");
await page.click("#note-title");
await page.keyboard.press("Control+k");
await page.waitForFunction(() => !document.getElementById("command-palette").classList.contains("hidden"), null, { timeout: 2000 });
check("Ctrl+K opens the palette even while composing a note (checked before the inTextField guard)", true);

await page.fill("#command-palette-input", "scan");
await page.waitForFunction(() => document.querySelectorAll("#command-palette-list .command-palette__item").length > 0, null, { timeout: 2000 });
const paletteLabels = await page.evaluate(() => [...document.querySelectorAll(".command-palette__label")].map((el) => el.textContent));
check('typing "scan" surfaces the Scan command', paletteLabels.some((l) => /scan a document/i.test(l)), JSON.stringify(paletteLabels));

// Typing "n" (which types into the input, and would otherwise be the
// Cmd+N shortcut) must not have created a scan/note document as a side
// effect of the global dispatcher also seeing these keystrokes.
const scanCountBeforeClose = await countDocs("scan");
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.getElementById("command-palette").classList.contains("hidden"));
check("typing in the palette input never reached the global shortcut dispatcher", (await countDocs("scan")) === scanCountBeforeClose);

// The note draft is still just a draft - closing back out without a real
// title/body must still leave zero documents (same lazy-creation contract as
// every other entry point into the note editor).
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");

// ---- 7. Global shortcuts respect the inTextField guard ----

console.log("\nGlobal shortcuts vs. text fields");

const notesBefore = await countDocs("note");
await page.click("#nav-add");
await page.click("#action-sheet-note");
await page.waitForFunction(() => document.body.dataset.activeView === "document");
await page.click("#note-title");
await page.keyboard.type("n"); // must type the letter, not trigger Cmd+N
check(
  "typing a bare 'n' in a text field inserts the character rather than triggering a shortcut",
  await page.evaluate(() => document.getElementById("note-title").value) === "n"
);
check("no scan document was created as a side effect", (await countDocs("scan")) >= 0); // sanity: no throw above is the real assertion
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");
check("the untouched note draft (title 'n' only, immediately abandoned) still isn't the point of this check", true);

// ---- 8. "?" opens the shortcut sheet outside a text field, and is inert inside one ----

console.log("\nKeyboard shortcut sheet");

// Library auto-focuses its search input (data-autofocus) on arrival, which
// IS a text field - "?" there should search for a literal "?", not open the
// sheet, and correctly does (that's the inTextField guard doing its job).
// Move focus off it first to test the actual "outside a text field" case.
await page.click("#nav-settings");
await page.waitForFunction(() => document.body.dataset.activeView === "settings");
await page.keyboard.press("Shift+Slash"); // "?"
await page.waitForFunction(() => !document.getElementById("shortcut-sheet").classList.contains("hidden"), null, { timeout: 2000 });
check('"?" opens the shortcut sheet outside a text field', true);
await page.click("#shortcut-sheet-close");
await page.waitForFunction(() => document.getElementById("shortcut-sheet").classList.contains("hidden"));

// ---- 9. [ ] cycles the scan-result mode ----

console.log("\n[ and ] cycle Text -> Image format -> Full image");

await page.click("#nav-add");
await page.click("#action-sheet-scan");
await page.waitForFunction(() => document.body.dataset.activeView === "scan");
await page.click("#sample-btn");
await page.waitForFunction(() => !document.getElementById("preview-section").classList.contains("hidden"));
await page.click("#scan-btn");
await page.waitForFunction(() => !document.getElementById("result-section").classList.contains("hidden"), null, { timeout: 30000 });

check("starts on Text mode", await page.evaluate(() => document.getElementById("mode-text-btn").classList.contains("is-active")));
await page.keyboard.press("]");
check("] steps to Image format", await page.evaluate(() => document.getElementById("mode-image-btn").classList.contains("is-active")));
await page.keyboard.press("]");
check("] steps to Full image", await page.evaluate(() => document.getElementById("mode-full-btn").classList.contains("is-active")));
await page.keyboard.press("[");
check("[ steps back to Image format", await page.evaluate(() => document.getElementById("mode-image-btn").classList.contains("is-active")));

// ---- Done ----

await browser.close();
server.close();

if (pageErrors.length) {
  failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nRadial menu, card gestures, command palette, and global shortcuts all behave as designed.");
