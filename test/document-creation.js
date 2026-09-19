// document-creation.js: regression coverage for when a document is actually
// created, AND for the whole "Add as document page" flow, driven through the
// real UI in a real browser.
//
// Added alongside a fix to app.js: tapping "Note" used to call
// createDocument() immediately, and so did tapping "Scan" -
// so previewing a sample image, or opening the note editor and deciding against
// it, silently left a permanent "Untitled note" or "Untitled scan · 0 pages"
// card in the library. Nothing in CI drove app.js's nav handlers at all before
// this file - library-documents.js exercises js/documents.js directly, never
// through the UI that actually calls it - so this closes a real gap, not just a
// regenerated one.
//
// ---------------------------------------------------------------------------
// WHY PART 6 WAS ADDED, AND WHAT THIS FILE MISSED FOR SO LONG.
//
// Parts 1-5 below drive real UI - the nav bar, the action sheet, "Try a sample
// image", the delete/Undo toast - so this file was never a model-only gate in
// the way library-documents.js deliberately is. Its blind spot was narrower
// and more ordinary: it only ever asked WHEN a document comes into existence,
// and it reached the scan flow through `#sample-btn` and stopped at the
// preview. It never opened `#download-menu`, never clicked "Add as document
// page", and therefore never once executed js/app.js's addCurrentImageAsPage -
// the function that creates the document, routes through the crop screen and
// commits the page. Everything downstream of that menu item was ungated, and
// four separate defects lived there at once:
//
//   1. The crop screen - the only screen in this flow carrying a Cancel - was
//      shown ONLY when edge detection returned corners. detectDocument returns
//      null on 8 of the 11 photographs in test/images, so the ordinary path
//      committed a page on one tap and left the person in the document view,
//      where the flow's Cancel does not exist.
//   2. Cancel, when the crop screen WAS shown, committed the page anyway:
//      cropView.js handed back `undefined` and app.js turned that into "commit
//      uncropped". The document had also already been created, before the crop
//      screen was shown at all.
//   3. Every filter chip, both rotate buttons and "Apply filter to all" threw
//      `TypeError: Failed to execute 'drawImage'` on the resulting page, because
//      rebuildPage assigned warpPerspective's `{ canvas, unwarpPoint }` wrapper
//      where a canvas was expected. It fired only for a page carrying corners -
//      which is exactly what this flow's crop step stores, and nothing else in
//      CI produced one.
//   4. A new scan document defaulted to "Auto enhance", so the captured pixels
//      were contrast-stretched before anyone saw them.
//
// So Part 6 drives the flow with clicks, from the menu item to every button on
// the page it produces. The pageerror handler below is not incidental: three of
// the four defects above were uncaught runtime errors, and an assertion-only
// gate would have gone green while the console filled up.
//
// Usage: node test/document-creation.js

import { launchBrowser, takeConsoleErrors, listenOnEphemeralPort } from "./browser.js";
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
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
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

// A blob: URL that 404s is this app's signature for "an object URL was revoked
// while an element was still displaying it" - it produces no exception, nothing
// visibly wrong in a screenshot, and a console error on every re-render.
// renderScanDoc did exactly that until Part 6 caught it.
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 80)} (${r.failure()?.errorText})`));

// console.error counts too, and that is not belt-and-braces - it is the whole
// difference between this gate working and not. js/scanDoc.js's withBusy
// CATCHES whatever a filter, a rotate or a rebuild throws, logs it through
// console.error and puts the message in a window.alert. So the TypeError that
// broke every button on this screen was never an UNCAUGHT error, and a
// pageerror-only listener watched all six filter chips fail in a row and
// reported six clean passes. Verified by running this file against the commit
// before the fix: without this, it went green on exactly the defect it was
// written for.
//
// The listener itself now lives in test/browser.js and is attached to every
// page in the suite - see note 1 in that file's header. takeConsoleErrors
// DRAINS it, which is what lets this file attribute an error to the step that
// caused it; anything left undrained fails the run from browser.js's exit hook,
// so the two cannot disagree about whether something was reported.

// An uncaught rejection is not a pageerror in every Playwright build, and the
// bugs Part 6 exists for live in async click handlers, where a rejection is the
// ONLY trace a failure leaves.
await page.exposeFunction("__reportRejection", (message) => pageErrors.push(`Unhandled rejection: ${message}`));
await page.addInitScript(() => {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    window.__reportRejection?.(String(reason?.stack || reason?.message || reason));
  });
});

// Drains both error channels and reports what came out of them, so a failure is
// attributed to the step that caused it rather than to the end of the file.
const noErrorsDuring = (label) => {
  const problems = [
    ...pageErrors.map((e) => `uncaught: ${e}`),
    ...takeConsoleErrors(page).map((e) => `console.error: ${e.slice(0, 300)}`),
    ...failedRequests.map((r) => `failed request: ${r}`),
  ];
  pageErrors.length = 0;
  failedRequests.length = 0;
  check(`no console errors ${label}`, problems.length === 0, problems.join(" | "));
  return problems.length === 0;
};

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 15000 });

const countDocs = (type) =>
  page.evaluate(async (t) => {
    const docs = await import("/js/documents.js");
    return (await docs.getAllDocuments()).filter((d) => d.type === t && !d.deletedAt).length;
  }, type);

// ---- 1. Opening the note editor creates nothing until there is content ----

console.log("\nNote: opening the editor is not creating a document");

check("zero notes exist before touching anything", (await countDocs("note")) === 0, String(await countDocs("note")));

await page.click("#nav-add");
await page.waitForFunction(() => !document.getElementById("action-sheet").classList.contains("hidden"));
await page.click("#action-sheet-note");
await page.waitForFunction(() => document.body.dataset.activeView === "document");

check("the note editor is showing", await page.evaluate(() => !document.getElementById("note-editor").classList.contains("hidden")));
check("opening a blank draft created no document", (await countDocs("note")) === 0, String(await countDocs("note")));

// Navigating away from an untouched draft - the exact repro of the old bug
// (four taps of "Note", four permanent empty documents).
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");
check("leaving an empty draft still created no document", (await countDocs("note")) === 0, String(await countDocs("note")));

// ---- 2. Typing in a draft note is what creates it ----

console.log("\nNote: real content is what creates the document");

await page.click("#nav-add");
await page.waitForFunction(() => !document.getElementById("action-sheet").classList.contains("hidden"));
await page.click("#action-sheet-note");
await page.waitForFunction(() => document.body.dataset.activeView === "document");
await page.fill("#note-title", "Grocery list");
await page.waitForFunction(() => document.getElementById("note-status")?.textContent === "Saved", null, { timeout: 5000 });

check("typing a title created exactly one note", (await countDocs("note")) === 1, String(await countDocs("note")));
const titled = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const all = await docs.getAllDocuments();
  return all.find((d) => d.type === "note" && !d.deletedAt)?.title;
});
check("the created note kept the typed title", titled === "Grocery list", titled);

await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");

// ---- 3. Previewing a sample image is not creating a scan document ----

console.log("\nScan: previewing an image is not creating a document");

check("zero scans exist before touching anything", (await countDocs("scan")) === 0, String(await countDocs("scan")));

await page.click("#nav-add");
await page.waitForFunction(() => !document.getElementById("action-sheet").classList.contains("hidden"));
await page.click("#action-sheet-scan");
await page.waitForFunction(() => document.body.dataset.activeView === "scan");

check("entering Scan created no document", (await countDocs("scan")) === 0, String(await countDocs("scan")));
check(
  "the \"Adding to...\" note is not shown (nothing to add to yet)",
  await page.evaluate(() => document.getElementById("scan-target-note").classList.contains("hidden"))
);

// The exact repro of the old bug: "Try a sample image" used to already show
// "Adding to 'Untitled scan'" before Scan text was
// even clicked, because createAndOpenScan() created the document on nav alone.
await page.click("#sample-btn");
await page.waitForFunction(() => !document.getElementById("preview-section").classList.contains("hidden"), null, { timeout: 5000 });

check("previewing a sample image still created no document", (await countDocs("scan")) === 0, String(await countDocs("scan")));
check(
  "the \"Adding to...\" note is still not shown after previewing",
  await page.evaluate(() => document.getElementById("scan-target-note").classList.contains("hidden"))
);

// ---- 4. sweepEmptyDocuments cleans up what the old bug already left behind ----

console.log("\nsweepEmptyDocuments (one-time cleanup for pre-existing empty documents)");

const sweep = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const emptyNote = await docs.createDocument({ type: docs.DOC_TYPES.NOTE });
  const emptyScan = await docs.createDocument({ type: docs.DOC_TYPES.SCAN });
  const realNote = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Keep me" });

  const removed = await docs.sweepEmptyDocuments();

  const [afterEmptyNote, afterEmptyScan, afterRealNote] = await Promise.all([
    docs.getDocument(emptyNote.id),
    docs.getDocument(emptyScan.id),
    docs.getDocument(realNote.id),
  ]);

  return {
    removed,
    emptyNoteTrashed: !!afterEmptyNote.deletedAt,
    emptyScanTrashed: !!afterEmptyScan.deletedAt,
    realNoteUntouched: afterRealNote.deletedAt === null,
  };
});

check("the sweep reports two documents removed", sweep.removed === 2, String(sweep.removed));
check("an empty note was moved to trash, not deleted outright", sweep.emptyNoteTrashed === true);
check("a zero-page scan was moved to trash", sweep.emptyScanTrashed === true);
check("a note with a real title was left alone", sweep.realNoteUntouched === true);

// ---- 5. Deleting a document from the library shows an Undo toast ----

console.log("\nLibrary: deleting shows an Undo toast");

const toDelete = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const doc = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Delete me" });
  return doc.id;
});

// renderLibrary() re-reads IndexedDB on every call, so navigating to Library
// now (after creating the document above) is enough to pick it up - no reload
// needed.
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");
await page.waitForSelector(`[data-action="trash"][data-id="${toDelete}"]`, { timeout: 5000 });

// Waits for the MESSAGE TEXT itself, not just an "is a toast visible" flag -
// the earlier note-creation step already showed and auto-dismissed one toast,
// so "a toast is visible" alone could resolve against a stale one still mid-
// transition rather than this delete's own.
await page.click(`[data-action="trash"][data-id="${toDelete}"]`);
await page.waitForFunction(
  () =>
    document.getElementById("app-toast").classList.contains("is-visible") &&
    document.getElementById("app-toast-message").textContent.startsWith("Deleted"),
  null,
  { timeout: 5000 }
);

const toastText = await page.evaluate(() => document.getElementById("app-toast-message").textContent);
check("the toast names the deleted document", toastText === 'Deleted "Delete me"', toastText);

// The toast's Undo handler hides the toast synchronously and THEN awaits the
// actual restore (js/toast.js calls hideToast() before onAction()), so waiting
// for the toast to disappear would race the restore itself rather than confirm
// it. Polling the document directly is the real signal.
await page.click("#app-toast-action");
await page.waitForFunction(
  async (id) => {
    const docs = await import("/js/documents.js");
    const doc = await docs.getDocument(id);
    return doc?.deletedAt === null;
  },
  toDelete,
  { timeout: 5000 }
);
check("Undo restored the document", true);

// ---------------------------------------------------------------------------
// 6. "Add as document page", end to end, through real clicks.
// ---------------------------------------------------------------------------
//
// EVERY WAIT BELOW IS A waitForFunction, NEVER A FIXED SLEEP. This flow commits
// a page through four canvasToBlob calls, and a waitForTimeout here does not
// merely flake - it HANGS, forever, with no error. The full explanation is note
// 2 in test/browser.js's header, where the next person writing a gate will find
// it; the short version is that Chromium encodes toBlob on an idle task and a
// headless renderer nobody is waking never gets one.

console.log("\nAdd as document page: opening the flow");

const scansBefore = await countDocs("scan");
const pagesIn = (id) =>
  page.evaluate(async (docId) => {
    const docs = await import("/js/documents.js");
    const doc = await docs.getDocument(docId);
    return (doc?.pageIds || []).length;
  }, id);
const newestScan = () =>
  page.evaluate(async () => {
    const docs = await import("/js/documents.js");
    const all = (await docs.getAllDocuments()).filter((d) => d.type === "scan" && !d.deletedAt);
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all[0] ? { id: all[0].id, pages: (all[0].pageIds || []).length, defaultFilter: all[0].defaultFilter } : null;
  });

// Reaches the corner menu the way a person does: scan an image, then open
// "More actions" on the result screen.
async function reachResultScreen(loadImage) {
  await page.click("#nav-add");
  await page.waitForFunction(() => !document.getElementById("action-sheet").classList.contains("hidden"));
  await page.click("#action-sheet-scan");
  await page.waitForFunction(() => document.body.dataset.activeView === "scan");
  await loadImage();
  await page.waitForFunction(() => !document.getElementById("preview-section").classList.contains("hidden"), null, { timeout: 20000 });
  await page.click("#scan-btn");
  await page.waitForFunction(() => !document.getElementById("result-section").classList.contains("hidden"), null, { timeout: 120000 });
}

async function openAddAsDocumentPage() {
  await page.click("#download-btn");
  await page.waitForFunction(() => !document.getElementById("download-menu").classList.contains("hidden"));
  await page.click('#download-menu [data-menu-action="add-to-doc"]');
}

const useSample = () => page.click("#sample-btn");
const usePhoto = (name) => page.setInputFiles("#file-input", join(ROOT, "test/images", name));

// A failed assertion must not abort the assertions after it. Run against the
// commit before the fix, Cancel left the person in the DOCUMENT view - so the
// next `#download-btn` click found an invisible button, threw, and killed the
// file before the throwing-filter-chip and default-filter symptoms below ever
// got the chance to report. A gate that stops at the first symptom hides the
// rest of them, which is the opposite of what it is for.
async function ensureResultScreen(loadImage = useSample) {
  const ready = await page.evaluate(() => {
    const button = document.getElementById("download-btn");
    return (
      document.body.dataset.activeView === "scan" &&
      !!button &&
      !!(button.offsetParent || button.getClientRects().length)
    );
  });
  if (!ready) await reachResultScreen(loadImage);
}

await reachResultScreen(useSample);
noErrorsDuring("scanning the sample image");

await openAddAsDocumentPage();
await page.waitForFunction(() => document.body.dataset.activeView === "crop", null, { timeout: 10000 });

// The landing screen, and whether the flow can be backed out of FROM IT. The
// reported symptom was "Cancel is not reachable from where the user lands -
// they have to navigate back to find it", and the mechanism was routing:
// app.js showed #crop-view only when detection returned corners, so the other
// path landed in the document view, where this button does not exist.
const landing = await page.evaluate(() => {
  const cancel = document.querySelector('[data-crop-action="cancel"]');
  const rect = cancel?.getBoundingClientRect();
  return {
    view: document.body.dataset.activeView,
    cancelExists: !!cancel,
    // Actually on screen where the person is standing, not merely in the DOM:
    // the whole bug was a Cancel that existed in a section nobody was shown.
    cancelOnScreen: !!rect && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
    cancelInCurrentView: !!cancel?.closest(`[data-view="${document.body.dataset.activeView}"]`),
  };
});
check("opening the flow lands on the crop screen", landing.view === "crop", landing.view);
check("...with Cancel present in that same view, no back-navigation needed", landing.cancelInCurrentView, JSON.stringify(landing));
check("...and visible on screen", landing.cancelOnScreen, JSON.stringify(landing));
check("opening the flow created no document yet", (await countDocs("scan")) === scansBefore, `${await countDocs("scan")} vs ${scansBefore}`);
noErrorsDuring("opening the flow");

// ---- 6b. Cancel adds nothing ----

console.log("\nAdd as document page: Cancel");

await page.click('[data-crop-action="cancel"]');
await page.waitForFunction(() => document.body.dataset.activeView !== "crop", null, { timeout: 10000 });

check("Cancel left the crop screen", (await page.evaluate(() => document.body.dataset.activeView)) !== "crop");
check("Cancel created no document", (await countDocs("scan")) === scansBefore, `${await countDocs("scan")} vs ${scansBefore}`);
check(
  "Cancel returned to the capture screen with the scanned image still loaded",
  await page.evaluate(
    () =>
      document.body.dataset.activeView === "scan" && !document.getElementById("result-section").classList.contains("hidden")
  ),
  await page.evaluate(() => document.body.dataset.activeView)
);
check(
  "Cancel left no \"Adding to...\" target behind",
  await page.evaluate(() => document.getElementById("scan-target-note").classList.contains("hidden"))
);
noErrorsDuring("cancelling");

// Escape is the keyboard's only route to Cancel on this screen, which matters
// now that the screen is unconditional. Focus arrives on #crop-canvas
// (data-autofocus) and its corner-cycling handler preventDefault()s every
// plain Tab, so Tab never reaches the buttons - asserted here rather than
// described, because it is the reason the Escape binding exists.
await ensureResultScreen();
await openAddAsDocumentPage();
await page.waitForFunction(() => document.body.dataset.activeView === "crop", null, { timeout: 10000 });

const focusStart = await page.evaluate(() => document.activeElement?.id);
for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
const focusAfterTabs = await page.evaluate(() => document.activeElement?.id);
check("focus lands on the crop canvas", focusStart === "crop-canvas", focusStart);
check(
  "Tab cycles corners rather than leaving the canvas (so it cannot reach Cancel)",
  focusAfterTabs === "crop-canvas",
  focusAfterTabs
);

await page.keyboard.press("Escape");
// Tolerant: at the parent commit nothing was listening for Escape here at all,
// and that silence IS the symptom - it has to be reported as a failed check
// rather than as a timeout that ends the file.
await page
  .waitForFunction(() => document.body.dataset.activeView !== "crop", null, { timeout: 10000 })
  .catch(() => {});
check("Escape cancels, so Cancel is reachable without a pointer", (await page.evaluate(() => document.body.dataset.activeView)) === "scan", await page.evaluate(() => document.body.dataset.activeView));
check("Escape created no document either", (await countDocs("scan")) === scansBefore, `${await countDocs("scan")} vs ${scansBefore}`);

// Leave by the button if Escape did not, so the checks after this one still
// have a screen to stand on.
if ((await page.evaluate(() => document.body.dataset.activeView)) === "crop") {
  await page.click('[data-crop-action="cancel"]');
  await page.waitForFunction(() => document.body.dataset.activeView !== "crop", null, { timeout: 10000 }).catch(() => {});
}

// The command palette sits above this view and owns Escape first: dismissing it
// must not also abandon the capture underneath.
await ensureResultScreen();
await openAddAsDocumentPage();
await page.waitForFunction(() => document.body.dataset.activeView === "crop", null, { timeout: 10000 });
await page.keyboard.press("Control+k");
await page.waitForFunction(() => !document.getElementById("command-palette").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.getElementById("command-palette").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
check(
  "Escape that closes the command palette leaves the capture alone",
  (await page.evaluate(() => document.body.dataset.activeView)) === "crop",
  await page.evaluate(() => document.body.dataset.activeView)
);
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.body.dataset.activeView !== "crop", null, { timeout: 10000 }).catch(() => {});
if ((await page.evaluate(() => document.body.dataset.activeView)) === "crop") {
  await page.click('[data-crop-action="cancel"]');
  await page.waitForFunction(() => document.body.dataset.activeView !== "crop", null, { timeout: 10000 }).catch(() => {});
}
noErrorsDuring("the keyboard route out of the confirm screen");

// ---- 6c. Completing the flow adds exactly one page, filtered Original ----

console.log("\nAdd as document page: Apply");

await ensureResultScreen();
await openAddAsDocumentPage();
await page.waitForFunction(() => document.body.dataset.activeView === "crop", null, { timeout: 10000 });
await page.click('[data-crop-action="apply"]');
await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll("#page-strip [data-page]").length === 1, null, { timeout: 30000 });

const created = (await newestScan()) || { id: null, pages: 0, defaultFilter: null };
check("Apply created exactly one scan document", (await countDocs("scan")) === scansBefore + 1, `${await countDocs("scan")} vs ${scansBefore + 1}`);
check("...holding exactly one page", created?.pages === 1, JSON.stringify(created));
check("...and the scan document view is showing", await page.evaluate(() => !document.getElementById("scan-doc").classList.contains("hidden")));
noErrorsDuring("committing the page");

// The default filter. "Auto enhance" was the default and silently
// contrast-stretched every captured page; the value that decides it is
// js/documents.js's createDocumentRecord, not js/scanDoc.js's FILTERS.AUTO
// fallback, which a document created through the model never reaches.
const filterState = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const all = (await docs.getAllDocuments()).filter((d) => d.type === "scan" && !d.deletedAt);
  all.sort((a, b) => b.createdAt - a.createdAt);
  const pages = await docs.getPagesForDocument(all[0]);
  return {
    defaultFilter: all[0].defaultFilter,
    pageFilter: pages[0]?.filter,
    pressed: [...document.querySelectorAll("#scan-filter-row [data-filter]")]
      .filter((b) => b.classList.contains("is-active"))
      .map((b) => b.dataset.filter),
  };
});
check("the new document's default filter is Original", filterState.defaultFilter === "original", filterState.defaultFilter);
check("the committed page was stored as Original", filterState.pageFilter === "original", filterState.pageFilter);
check("Original is the chip shown as selected", JSON.stringify(filterState.pressed) === '["original"]', JSON.stringify(filterState.pressed));

// ---- 6d. Every button on the resulting document page ----
//
// The defect this covers threw on a page carrying CORNERS, which is precisely
// what the crop step above stores and what nothing else in CI produced. Native
// dialogs are dismissed rather than accepted: the OK branches are
// destructive-actions.js's job, and accepting "Delete page?" here would delete
// the page the rest of this section is about.

console.log("\nAdd as document page: every control on the resulting page");

page.on("dialog", (d) => d.dismiss().catch(() => {}));

const controls = await page.evaluate(() =>
  [...document.querySelectorAll("#scan-doc button")]
    .filter((b) => (b.offsetParent || b.getClientRects().length) && !b.disabled)
    .map((b) => ({ key: b.dataset.scanAction || (b.dataset.filter ? `filter:${b.dataset.filter}` : ""), label: b.textContent.trim().slice(0, 24) }))
    .filter((c) => c.key)
);
check("the resulting page offers its full control set", controls.length >= 20, `${controls.length} enabled buttons`);

for (const control of controls) {
  const selector = control.key.startsWith("filter:")
    ? `#scan-doc [data-filter="${control.key.slice(7)}"]`
    : `#scan-doc [data-scan-action="${control.key}"]`;

  const element = await page.$(selector);
  if (!element) {
    check(`clicking "${control.label}" [${control.key}]`, false, "control vanished between enumeration and click");
    continue;
  }

  await element.click();
  // Settles on whichever of the three outcomes a control has: it navigates, it
  // goes busy and comes back, or it finishes in place. Polling in the page also
  // keeps the renderer awake for any toBlob the click kicked off - see the note
  // at the top of Part 6.
  await page.waitForFunction(
    () => document.body.dataset.activeView !== "document" || document.getElementById("scan-busy").classList.contains("hidden"),
    null,
    { timeout: 30000 }
  );

  const clean = noErrorsDuring(`clicking "${control.label}" [${control.key}]`);
  if (!clean) failures.push(`"${control.label}" [${control.key}] raised an error`);

  // "Adjust edges" and "Add page" legitimately leave the document view.
  if ((await page.evaluate(() => document.body.dataset.activeView)) !== "document") {
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById("scan-busy").classList.contains("hidden"), null, { timeout: 15000 });
  }
}

check(
  "the page survived the whole sweep (nothing was destroyed by a dismissed dialog)",
  created.id !== null && (await pagesIn(created.id)) === 1,
  String(created.id === null ? "no document was created to sweep" : await pagesIn(created.id))
);

// ---- 6e. Original and Auto enhance both actually apply ----
//
// Both threw the same TypeError before the fix. Asserted on the STORED page
// rather than on the chip's class, because a chip can look selected while the
// rebuild behind it failed - which is exactly what it did.

console.log("\nAdd as document page: the two filters the report named");

const applyFilter = async (name) => {
  await page.click(`#scan-doc [data-filter="${name}"]`);
  await page.waitForFunction(() => document.getElementById("scan-busy").classList.contains("hidden"), null, { timeout: 30000 });
  await page.waitForFunction(
    async (expected) => {
      const docs = await import("/js/documents.js");
      const all = (await docs.getAllDocuments()).filter((d) => d.type === "scan" && !d.deletedAt);
      all.sort((a, b) => b.createdAt - a.createdAt);
      const pages = await docs.getPagesForDocument(all[0]);
      return pages[0]?.filter === expected;
    },
    name,
    { timeout: 30000 }
  ).catch(() => {});
  return page.evaluate(async () => {
    const docs = await import("/js/documents.js");
    const all = (await docs.getAllDocuments()).filter((d) => d.type === "scan" && !d.deletedAt);
    all.sort((a, b) => b.createdAt - a.createdAt);
    const pages = await docs.getPagesForDocument(all[0]);
    return pages[0]?.filter;
  });
};

const auto = await applyFilter("auto");
check("selecting Auto enhance applies it to the page", auto === "auto", auto);
noErrorsDuring("selecting Auto enhance");

const original = await applyFilter("original");
check("selecting Original applies it to the page", original === "original", original);
noErrorsDuring("selecting Original");

// ---- 6f. The path where edge detection finds nothing ----
//
// The mechanism behind "Cancel is not reachable". detectDocument returns null
// on this photograph - and on 8 of the 11 in test/images - and app.js used to
// take that as licence to skip the confirm screen entirely and commit on one
// tap. The confirm screen is now unconditional, so this path has a Cancel too.

console.log("\nAdd as document page: a photo edge detection cannot read");

const scansBeforePhoto = await countDocs("scan");
await page.click("#nav-library");
await page.waitForFunction(() => document.body.dataset.activeView === "library");
await reachResultScreen(() => usePhoto("complexPic1.jpeg"));

check(
  "edge detection genuinely finds nothing in this photo (the precondition)",
  await page.evaluate(async () => {
    const edges = await import("/js/edgeDetect.js");
    return edges.detectDocument(document.getElementById("preview-img")) === null;
  })
);

await openAddAsDocumentPage();
// `.catch` rather than a bare await: at the parent commit this path did not go
// to the crop screen at all - it committed the page and went straight to the
// document view - and that IS the symptom, so it has to be reported as a failed
// check rather than as a timeout that ends the run.
const reachedCrop = await page
  .waitForFunction(() => document.body.dataset.activeView === "crop", null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("...and the flow STILL lands on the crop screen rather than committing", reachedCrop, await page.evaluate(() => document.body.dataset.activeView));
check(
  "...with a Cancel in the view the person is looking at",
  await page.evaluate(
    () => !!document.querySelector('[data-view="crop"] [data-crop-action="cancel"]:not(.hidden)') && document.body.dataset.activeView === "crop"
  )
);
check("...and still no document created", (await countDocs("scan")) === scansBeforePhoto, `${await countDocs("scan")} vs ${scansBeforePhoto}`);

if (reachedCrop) {
  await page.click('[data-crop-action="cancel"]');
  await page.waitForFunction(() => document.body.dataset.activeView !== "crop", null, { timeout: 10000 });
}
check("Cancel on the undetected-edges path also adds nothing", (await countDocs("scan")) === scansBeforePhoto, `${await countDocs("scan")} vs ${scansBeforePhoto}`);
noErrorsDuring("the undetected-edges path");

// ---- 6g. Re-entering an existing document adds a second page, not a second
// document, and the "Adding to..." line keeps up ----

console.log("\nAdd as document page: re-entry into a document that already has a page");

await page.goto(`http://localhost:${PORT}/index.html#document/${created.id || "none"}`);
await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll("#page-strip [data-page]").length === 1, null, { timeout: 15000 });
pageErrors.length = 0;
failedRequests.length = 0;
takeConsoleErrors(page);

await page.click('#scan-doc [data-scan-action="add-page"]');
await page.waitForFunction(() => document.body.dataset.activeView === "scan", null, { timeout: 10000 });
// The line is filled from an IndexedDB read, so it lands a tick after the view
// flips. Waiting for the element rather than for the navigation keeps this
// about the content, not about which of the two resolved first.
await page
  .waitForFunction(() => !document.getElementById("scan-target-note").classList.contains("hidden"), null, { timeout: 10000 })
  .catch(() => {});
check(
  "\"Add page\" says which document the next page joins",
  await page.evaluate(() => {
    const note = document.getElementById("scan-target-note");
    return !note.classList.contains("hidden") && /1 page so far/.test(note.textContent);
  }),
  await page.evaluate(() => document.getElementById("scan-target-note").textContent)
);

await usePhoto("complexPic1.jpeg");
await page.waitForFunction(() => !document.getElementById("preview-section").classList.contains("hidden"), null, { timeout: 20000 });
await page.click("#scan-btn");
await page.waitForFunction(() => !document.getElementById("result-section").classList.contains("hidden"), null, { timeout: 120000 });
await openAddAsDocumentPage();
// Tolerant for the same reason as the undetected-edges section above: at the
// parent commit this photo's capture never reached a crop screen at all, and
// the checks below are what should say so.
const reachedCropOnReentry = await page
  .waitForFunction(() => document.body.dataset.activeView === "crop", null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
if (reachedCropOnReentry) await page.click('[data-crop-action="apply"]');
await page
  .waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 30000 })
  .catch(() => {});
await page
  .waitForFunction(() => document.querySelectorAll("#page-strip [data-page]").length === 2, null, { timeout: 30000 })
  .catch(() => {});

check("re-entry added a second page to the SAME document", (await pagesIn(created.id)) === 2, String(await pagesIn(created.id)));
check("re-entry created no extra document", (await countDocs("scan")) === scansBefore + 1, `${await countDocs("scan")} vs ${scansBefore + 1}`);
noErrorsDuring("adding a second page");

// The line went stale here: it still read "1 page so far" against a two-page
// document, because nothing refreshed it after a commit.
await page.click('#scan-doc [data-scan-action="add-page"]');
await page.waitForFunction(() => document.body.dataset.activeView === "scan", null, { timeout: 10000 });
await page
  .waitForFunction(() => !document.getElementById("scan-target-note").classList.contains("hidden"), null, { timeout: 10000 })
  .catch(() => {});
check(
  "the \"Adding to...\" line counts the page that was just added",
  await page.evaluate(() => /2 pages so far/.test(document.getElementById("scan-target-note").textContent)),
  await page.evaluate(() => document.getElementById("scan-target-note").textContent)
);

// ---- 6h. The empty state ----

console.log("\nAdd as document page: the empty-state entry point");

const emptyState = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const doc = await docs.createDocument({ type: docs.DOC_TYPES.SCAN, title: "Empty on purpose" });
  return doc.id;
});
await page.goto(`http://localhost:${PORT}/index.html#document/${emptyState}`);
await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 15000 });
pageErrors.length = 0;
failedRequests.length = 0;
takeConsoleErrors(page);

check(
  "a document with no pages says so and disables everything that needs one",
  await page.evaluate(() => {
    const empty = document.getElementById("page-preview-empty");
    const needsPages = [...document.querySelectorAll("#scan-doc [data-needs-pages]")];
    return !empty.classList.contains("hidden") && needsPages.length > 0 && needsPages.every((b) => b.disabled);
  })
);
check(
  "...while \"Add page\" stays available, since it is the way out of the empty state",
  await page.evaluate(() => !document.querySelector('#scan-doc [data-scan-action="add-page"]').disabled)
);
noErrorsDuring("opening an empty scan document");

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
console.log(
  "\nDocument creation timing, cleanup sweep, the delete/Undo toast, and the whole\n" +
    '"Add as document page" flow - Cancel, Apply, every control on the resulting\n' +
    "page, re-entry and the empty state - all behave as designed."
);
