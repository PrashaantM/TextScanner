// document-creation.js: regression coverage for when a document is actually
// created, driven through the real UI in a real browser.
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
// Usage: node test/document-creation.js

import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8140;
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
}).listen(PORT);

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

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
console.log("\nDocument creation timing, cleanup sweep, and the delete/Undo toast all behave as designed.");
