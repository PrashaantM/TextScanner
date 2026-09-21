// radial-call-sites.js: drives BOTH call sites of the radial-menu primitive,
// at BOTH a phone width and a desktop width.
//
// WHY THIS EXISTS. test/interaction-layer.js covers call site 1 (#nav-add) and
// call site 2 (library cards), but it sets no viewport, so it runs at
// Playwright's 1280x720 default and has never seen the 600px breakpoint where
// style.css hides and re-lays-out controls. This file is the one that crosses
// that breakpoint, and it is the only place either call site is driven on a
// phone-sized screen at all.
//
// WHAT HAPPENED TO CALL SITE 3. There used to be a third: #theme-btn, whose
// press-and-hold offered System / Light / Dark. The theme system is gone - one
// fixed scheme now, no switcher - so the button and its menu went with it.
// That deletion would have taken real coverage with it, because call site 3
// was carrying two assertions nothing else made:
//
//   F2 (phone width). style.css's `@media (max-width: 600px)` set
//       `.app-bar__actions #theme-btn { display: none }`, so call site 3 did
//       not exist on a phone, and this file asserted that hiding as current,
//       deliberate behaviour. That assertion died with the button - the
//       decision it pinned ("is the theme radial deliberately desktop-only?")
//       no longer exists to be pinned. What is re-homed instead is the thing
//       that assertion existed to protect: that SOME call site is exercised
//       below the breakpoint. Call site 2 now runs at phone width too, which
//       it never did before, in this file or in interaction-layer.js.
//
//   F3 (pointer type). Call site 3 accepted ANY pointer, so a 420ms mouse
//       press-and-hold opened a radial menu while the identical gesture on
//       #nav-add correctly gave the flat action sheet - one primitive, two
//       answers. The fix was in js/main.js, and that file is gone. The
//       assertion is re-homed onto call site 2, which gates pointerType the
//       same way (js/library.js's attachCardGestures returns early on
//       "mouse"), so the two surviving call sites still cannot drift apart.
//
// Net: this gate did not shrink when call site 3 was deleted. It grew, because
// call site 2 is now driven at both widths rather than only at the default one.
//
// Usage: node test/radial-call-sites.js   (BROWSER= to pick an engine)

import { launchBrowser, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The breakpoint style.css actually uses. Named once so the two viewports below
// are obviously on either side of it rather than arbitrary numbers.
const PHONE_BREAKPOINT = 600;
const PHONE = { width: 430, height: 900 };
const DESKTOP = { width: 1280, height: 900 };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
const PORT = await listenOnEphemeralPort(server);

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); failures.push(`${name}${detail ? `: ${detail}` : ""}`); }
};

const browser = await launchBrowser({ headless: true });
const pageErrors = [];

// One real touch-typed pointerdown. Both call sites check pointerType, so a
// synthesized "mouse" would be rejected by design - which is exactly what the
// F3 assertions below rely on.
const pressTouch = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 1, pointerType: "touch", bubbles: true, cancelable: true, button: 0,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
}, selector);

async function open(viewport) {
  const context = await browser.newContext({ viewport, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });
  return { context, page };
}

// Call site 2 needs a card to long-press. Seeded through the real document
// model rather than injected markup, so the card carries the gesture handlers
// js/library.js actually attaches - the same approach interaction-layer.js
// uses for its swipe test.
// Waits for the card to EXIST rather than to be visible, and hands visibility
// back as a value. A card that renders but is hidden at one width is exactly
// the phone-only regression this file exists to catch, and it should arrive as
// a named failed assertion, not as a timeout thrown inside a helper.
async function seedCard(page) {
  const id = await page.evaluate(async () => {
    const docs = await import("/js/documents.js");
    const doc = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Long-press me" });
    return doc.id;
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });
  const selector = `.doc-card[data-id="${id}"]`;
  await page.waitForSelector(selector, { state: "attached", timeout: 10000 });
  return { selector, visible: await page.isVisible(selector) };
}

const radialOpen = (page) => page.evaluate(() => !!document.querySelector(".radial-menu"));
const spokes = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".radial-menu__item")].map((e) => e.textContent.trim()));

// ---- Phone width: the viewport interaction-layer.js never used ----

console.log(`\nPhone width (${PHONE.width}px, under the ${PHONE_BREAKPOINT}px breakpoint)`);
{
  const { context, page } = await open(PHONE);

  // Call site 1 must work here, or the whole primitive is absent on phones.
  await pressTouch(page, "#nav-add");
  await page.waitForTimeout(500);
  check("call site 1 (#nav-add) opens a radial menu at phone width", await radialOpen(page));
  check("...with both create spokes", (await spokes(page)).length >= 2, JSON.stringify(await spokes(page)));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Re-homed from call site 3: a press-and-hold radial, exercised below the
  // breakpoint. This is the coverage #theme-btn's F2 assertion was standing in
  // for, now on a call site that actually exists on a phone.
  const { selector: card, visible } = await seedCard(page);
  // The explicit half of the re-home. Call site 3 used to assert its button's
  // visibility at this width directly; losing that would have left the card
  // long-press guarded only by whether a helper happened to time out.
  check("a library card is reachable at phone width", visible,
        "the card renders but is not visible below the breakpoint - call site 2 does not exist on a phone, which is what happened to call site 3");
  await pressTouch(page, card);
  await page.waitForTimeout(700); // past the 420ms press timer in attachCardGestures
  check("call site 2 (a library card) opens a radial menu at phone width", await radialOpen(page));
  const phoneItems = await spokes(page);
  check("...offering Pin / Move / Delete",
        /pin/i.test(phoneItems.join(" ")) && /move/i.test(phoneItems.join(" ")) && /delete/i.test(phoneItems.join(" ")),
        JSON.stringify(phoneItems));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await context.close();
}

// ---- Desktop width: the same two call sites, above the breakpoint ----

console.log(`\nDesktop width (${DESKTOP.width}px)`);
{
  const { context, page } = await open(DESKTOP);

  await pressTouch(page, "#nav-add");
  await page.waitForTimeout(500);
  check("call site 1 (#nav-add) opens a radial menu at desktop width too", await radialOpen(page));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const { selector: card, visible } = await seedCard(page);
  check("a library card is reachable at desktop width", visible);
  await pressTouch(page, card);
  await page.waitForTimeout(700);
  check("call site 2 (a library card) opens a radial menu at desktop width", await radialOpen(page));
  const items = await spokes(page);
  check("...offering Pin / Move / Delete",
        /pin/i.test(items.join(" ")) && /move/i.test(items.join(" ")) && /delete/i.test(items.join(" ")),
        JSON.stringify(items));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await context.close();
}

// ---- F3: both call sites must treat the mouse the same ----

console.log("\nF3 - a mouse press-and-hold must NOT open a radial, at either call site");
{
  const { context, page } = await open(DESKTOP);

  const holdMouse = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700); // well past the 420ms timer
    const opened = await radialOpen(page);
    await page.mouse.up();
    await page.waitForTimeout(200);
    return opened;
  };

  check("call site 1 (#nav-add): mouse hold gives no radial", (await holdMouse("#nav-add")) === false);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // The regression this file was written for, re-homed off the deleted
  // #theme-btn. Before the fix that prompted it, one call site opened a radial
  // on a mouse hold while the other did not - one primitive, two answers.
  const { selector: card } = await seedCard(page);
  check("call site 2 (a library card): mouse hold gives no radial either",
        (await holdMouse(card)) === false,
        "a 420ms mouse hold opened a radial menu - call site 2 is not gating pointerType the way call site 1 does");

  // And the plain click must still do its ordinary job at both sites. The hold
  // above ended in a real mouse-up on the card, so it IS an ordinary click, and
  // an ordinary click on a card opens the document. Asserting it here rather
  // than clicking again is the stronger version: it proves the ignored
  // press-and-hold degrades to the plain action instead of being swallowed.
  // This is the direct replacement for the deleted "a plain mouse click still
  // cycles the theme".
  await page.waitForTimeout(400);
  check("a plain mouse click on a card still opens the document",
        (await page.evaluate(() => document.body.dataset.activeView)) === "document",
        await page.evaluate(() => document.body.dataset.activeView));

  // Back to the library by navigation rather than history: if the assertion
  // above failed we may never have left, and goBack() would then time out and
  // take the two #nav-add checks below down with it - a broken tree should
  // report every failure it has, not just the first.
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => document.body.dataset.activeView === "library", null, { timeout: 20000 });
  await page.click("#nav-add");
  await page.waitForTimeout(300);
  check("a plain mouse click on #nav-add still opens the flat action sheet",
        await page.evaluate(() => !document.getElementById("action-sheet").classList.contains("hidden")));
  check("...and not a radial menu", (await radialOpen(page)) === false);
  await context.close();
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${[...new Set(pageErrors)].join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nBoth radial call sites behave consistently, at both sides of the 600px breakpoint.");
