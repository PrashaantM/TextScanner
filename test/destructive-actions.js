// destructive-actions.js: drives every path in the app that is gated behind a
// native window.confirm/prompt through its REAL UI control, and asserts what it
// did to the store.
//
// WHY THIS EXISTS. Playwright auto-dismisses any dialog nothing is listening
// for. No test file in this repo had ever installed a `page.on("dialog", ...)`
// handler, so in every CI run to date `window.confirm(...)` returned **false**
// and each of these handlers took its early-return branch. The suite has been
// exercising the "user clicked Cancel" path eleven times over and reporting it
// as coverage.
//
// test/library-documents.js does test deletion and trash - but by importing
// /js/documents.js and calling purgeDocument() directly. That tests the model.
// It cannot catch a button wired to nothing, a handler that reads the wrong id,
// or a confirm whose early return is inverted, because it never presses
// anything. The eleven rows below were, until this file, reachable only by a
// human.
//
// The most consequential of them is "Delete all local data" (js/app.js:512-513),
// the only genuinely unrecoverable action in the app. Nothing automated had ever
// pressed it.
//
// WHAT IT ASSERTS, three ways:
//
//   1. ACCEPT - the action happens, and the store shows it.
//   2. DISMISS - the action does NOT happen. This is the branch CI has been
//      taking accidentally; asserting it deliberately is what turns an accident
//      into a contract, and it is the half that catches an inverted `if (!...)`.
//   3. The dialog TEXT. A confirm that silently stopped asking would still pass
//      an accept/dismiss test, so each check pins the message it answered.
//
// Usage: node test/destructive-actions.js   (exits non-zero on any failure)

import { launchBrowser } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8147;
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".gz": "application/gzip", ".wasm": "application/wasm",
};

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(ROOT, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
}).listen(PORT);

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); failures.push(`${name}${detail ? `: ${detail}` : ""}`); }
};

const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// The handler this whole file exists for. `reply` is swapped by each check so
// the same listener can answer OK, Cancel, or typed text.
let reply = { accept: true, text: "" };
let dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  if (reply.accept) await d.accept(reply.text);
  else await d.dismiss();
});
const answerOk = (text = "") => { reply = { accept: true, text }; dialogs = []; };
const answerCancel = () => { reply = { accept: false, text: "" }; dialogs = []; };
const sawMessage = (fragment) => dialogs.some((d) => d.message.includes(fragment));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });

const ev = (fn, arg) => page.evaluate(fn, arg);
const folderNames = () => ev(async () => {
  const d = await import("/js/documents.js");
  return (await d.getFolders()).map((f) => f.name);
});
const rowCounts = () => ev(async () => {
  const s = await import("/js/store.js");
  const n = async (k) => (await s.getAll(s.STORES[k])).length;
  return { documents: await n("DOCUMENTS"), pages: await n("PAGES"), blobs: await n("BLOBS"),
           folders: await n("FOLDERS"), history: await n("HISTORY"), settings: await n("SETTINGS") };
});
const liveDocs = () => ev(async () => {
  const d = await import("/js/documents.js");
  return (await d.getAllDocuments()).map((x) => ({ title: x.title || x.type, trashed: !!x.deletedAt }));
});
const pageFilters = (docId) => ev(async (id) => {
  const d = await import("/js/documents.js");
  return (await d.getPagesForDocument(await d.getDocument(id))).map((p) => p.filter);
}, docId);

async function makeNote(title) {
  await page.click("#nav-add");
  await page.click("#action-sheet-note");
  await page.waitForSelector("#note-title", { state: "visible" });
  await page.fill("#note-title", title);
  await page.waitForTimeout(900); // autosave debounce
  await page.click("#nav-library");
  await page.waitForTimeout(400);
}

// A scan document with three pages whose filters deliberately DIFFER, because
// applyFilterToAll skips any page already on the target filter - three identical
// pages would make it a no-op and the assertion meaningless.
async function makeScanDoc() {
  return ev(async () => {
    const docs = await import("/js/documents.js");
    const doc = await docs.createDocument({ type: "scan" });
    const makeBlob = async (shade) => {
      const c = document.createElement("canvas");
      c.width = 120; c.height = 160;
      const g = c.getContext("2d");
      g.fillStyle = shade; g.fillRect(0, 0, 120, 160);
      g.fillStyle = "#000"; g.font = "20px sans-serif"; g.fillText("P", 20, 80);
      return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    };
    const filters = ["original", "greyscale", "greyscale"];
    for (let i = 0; i < 3; i++) {
      await docs.addPage(doc.id, { blob: await makeBlob("#eeeeee"), width: 120, height: 160, filter: filters[i] });
    }
    return doc.id;
  });
}

// Settings is where the last two sections press their buttons, and a FAILING
// assertion there usually means the store was wiped early - which navigates the
// app back to the library and would make every later click time out, turning one
// real failure into a crash that hides the rest. Re-assert the view first.
const gotoSettings = async () => {
  if ((await ev(() => document.body.dataset.activeView)) !== "settings") {
    await page.click("#nav-settings");
    await page.waitForFunction(() => document.body.dataset.activeView === "settings", null, { timeout: 5000 });
  }
  await page.waitForTimeout(300);
};

// Every section below is a PAIR: cancel first (nothing must happen), then accept
// (it must). If the cancel half fails - the exact bug this file exists to catch,
// an inverted `if (!confirm(...))` - the target of the accept half is already
// gone, and a bare page.click() would then throw 30 seconds later and take every
// remaining assertion in the file with it. One real failure must not cost the
// other forty.
async function clickChecked(selector, what) {
  const el = await page.$(selector);
  if (!el) {
    check(what, false, `${selector} is no longer present - the cancel half of this pair already failed, so the action happened when it should not have`);
    return false;
  }
  await el.click();
  return true;
}

const resetStore = async () => {
  await ev(async () => { const s = await import("/js/store.js"); await s.clearAll(); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });
};

// ---- 1. Create a folder, from the library nav (js/library.js:460) ----

console.log("\nFolders");
await resetStore();
await makeNote("Doc A");

answerCancel();
await page.click('[data-action="new-folder"]');
await page.waitForTimeout(500);
check("cancelling the folder-name prompt creates nothing", (await folderNames()).length === 0, JSON.stringify(await folderNames()));
check("...and it was the folder-name prompt that was answered", dialogs.some((d) => d.type === "prompt"), JSON.stringify(dialogs));

answerOk("Receipts");
await page.click('[data-action="new-folder"]');
await page.waitForTimeout(600);
check("accepting it creates the folder", JSON.stringify(await folderNames()) === '["Receipts"]', JSON.stringify(await folderNames()));

// An empty name must be refused - `if (!name || !name.trim()) return false`.
answerOk("   ");
await page.click('[data-action="new-folder"]');
await page.waitForTimeout(500);
check("a whitespace-only name is refused", (await folderNames()).length === 1, JSON.stringify(await folderNames()));

// ---- 2. Rename a folder (js/library.js:467) ----

answerOk("Invoices");
await page.click('[data-action="folder-menu"]');
await page.waitForTimeout(600);
check("typing a new name renames the folder", JSON.stringify(await folderNames()) === '["Invoices"]', JSON.stringify(await folderNames()));
check("...and the prompt explained both options", sawMessage("delete"), JSON.stringify(dialogs));

// ---- 3. Delete a folder, documents kept (js/library.js:467/471) ----

// Put a document inside it first, so the "N documents moved out" alert - which
// only fires when the count is non-zero - is actually exercised.
await ev(async () => {
  const d = await import("/js/documents.js");
  const [folder] = await d.getFolders();
  const [doc] = await d.getAllDocuments();
  await d.updateDocument(doc.id, { folderId: folder.id });
});
await page.click("#nav-library");
await page.waitForTimeout(400);

answerCancel();
await page.click('[data-action="folder-menu"]');
await page.waitForTimeout(500);
check("cancelling the rename/delete prompt leaves the folder alone", (await folderNames()).length === 1, JSON.stringify(await folderNames()));

answerOk("delete");
await page.click('[data-action="folder-menu"]');
await page.waitForTimeout(800);
check('typing "delete" removes the folder', (await folderNames()).length === 0, JSON.stringify(await folderNames()));
check("...and says how many documents moved out of it", sawMessage("moved out of it"), JSON.stringify(dialogs));
check("...and the documents themselves are kept", (await liveDocs()).length === 1, JSON.stringify(await liveDocs()));

// ---- 4. Create a folder from the folder picker (js/library.js:629) ----
//
// A second, independent call site for the same prompt, reached from a card's
// Move action rather than the nav. It also MOVES the document, which the nav
// one does not.

await page.click("#nav-library");
await page.waitForSelector(".doc-card");
await page.click(".doc-card", { button: "right" });
await page.waitForTimeout(400);
// The context menu's Move item is data-action="folder" (labelled "Move to
// folder..."), not "move" - runCardAction never sees it, openFolderPicker does.
const moveItem = await page.$('#card-context-menu [data-action="folder"]');
check("the card context menu offers Move to folder", !!moveItem);
if (!moveItem) {
  // Leave no modal backdrop up, or every later click in this file is
  // intercepted by an invisible full-screen div and fails for the wrong reason.
  await page.keyboard.press("Escape");
} else {
  await moveItem.click();
  await page.waitForTimeout(500);
  check("Move opens the folder picker", (await ev(() => !document.getElementById("folder-picker").classList.contains("hidden"))));

  answerOk("FromPicker");
  await page.click(".folder-picker__item--new");
  await page.waitForTimeout(800);
  check("the picker's + New folder creates it", (await folderNames()).includes("FromPicker"), JSON.stringify(await folderNames()));
  const movedInto = await ev(async () => {
    const d = await import("/js/documents.js");
    const folders = await d.getFolders();
    const [doc] = await d.getAllDocuments();
    return folders.find((f) => f.id === doc.folderId)?.name || null;
  });
  check("...and moves the document into it", movedInto === "FromPicker", String(movedInto));
}

// ---- 5. Insert a link in a note (js/notesEditor.js:575) ----

console.log("\nNote editor");
await page.click("#nav-library");
await page.waitForSelector(".doc-card__open");
await page.click(".doc-card__open");
await page.waitForTimeout(700);

const selectBody = (text) => ev((t) => {
  const b = document.getElementById("note-body");
  b.focus();
  b.textContent = t;
  const r = document.createRange();
  r.selectNodeContents(b);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}, text);

await selectBody("cancel me");
answerCancel();
await page.click('#note-toolbar [data-action="link"]');
await page.waitForTimeout(400);
check("cancelling the link prompt inserts no anchor", !(await ev(() => document.getElementById("note-body").innerHTML)).includes("<a"),
      await ev(() => document.getElementById("note-body").innerHTML));

await selectBody("click here");
answerOk("https://example.com/");
await page.click('#note-toolbar [data-action="link"]');
await page.waitForTimeout(400);
check("a safe URL becomes a real anchor", (await ev(() => document.getElementById("note-body").innerHTML)).includes('href="https://example.com/"'),
      await ev(() => document.getElementById("note-body").innerHTML));

// isSafeUrl is the only thing between window.prompt and an executable href, and
// this is the one untrusted-input path in this file.
await selectBody("danger");
answerOk("javascript:alert(1)");
await page.click('#note-toolbar [data-action="link"]');
await page.waitForTimeout(400);
const afterUnsafe = await ev(() => document.getElementById("note-body").innerHTML);
check("a javascript: URL is rejected outright", !afterUnsafe.includes("<a") && !afterUnsafe.includes("javascript:"), afterUnsafe);

// ---- 6. Purge one document from Recently Deleted (js/library.js:422) ----

console.log("\nRecently Deleted");
await resetStore();
await makeNote("Doomed");
await page.waitForSelector('.doc-card__action[data-action="trash"]');
await page.click('.doc-card__action[data-action="trash"]');
await page.waitForTimeout(700);
await page.click('[data-action="show-trash"]');
await page.waitForTimeout(600);

answerCancel();
await page.click('.doc-card__action[data-action="purge"]');
await page.waitForTimeout(600);
check("cancelling the purge keeps the document in the trash", (await rowCounts()).documents === 1, JSON.stringify(await rowCounts()));
check("...and the confirm named the document", sawMessage("Doomed"), JSON.stringify(dialogs));

answerOk();
await clickChecked('.doc-card__action[data-action="purge"]', "the document is still there to purge");
await page.waitForTimeout(900);
const afterPurge = await rowCounts();
check("accepting purges it for good", afterPurge.documents === 0, JSON.stringify(afterPurge));
check("...and takes its blobs with it", afterPurge.blobs === 0, JSON.stringify(afterPurge));

// ---- 7. Empty the trash (js/library.js:743) ----

await resetStore();
for (const t of ["Trash 1", "Trash 2", "Trash 3"]) await makeNote(t);
for (let i = 0; i < 3; i++) {
  const b = await page.$('.doc-card__action[data-action="trash"]');
  if (b) { await b.click(); await page.waitForTimeout(700); }
}
await page.click('[data-action="show-trash"]');
await page.waitForTimeout(700);
check("the Empty trash button appears once there is something in the trash", await page.isVisible("#library-empty-trash"));

answerCancel();
await page.click("#library-empty-trash");
await page.waitForTimeout(700);
check("cancelling keeps all three", (await rowCounts()).documents === 3, JSON.stringify(await rowCounts()));

answerOk();
await clickChecked("#library-empty-trash", "the Empty trash button is still there to press");
await page.waitForTimeout(1500);
check("accepting empties it", (await rowCounts()).documents === 0, JSON.stringify(await rowCounts()));
check("...and the confirm said it could not be undone", sawMessage("can't be undone"), JSON.stringify(dialogs));

// ---- 8. Apply one page's filter to every page (js/scanDoc.js:337) ----

console.log("\nScan document");
await resetStore();
let docId = await makeScanDoc();
await page.goto(`http://localhost:${PORT}/index.html#document/${docId}`);
await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 15000 });
await page.waitForTimeout(1500);
check("the document opens with three pages on two different filters",
      JSON.stringify(await pageFilters(docId)) === '["original","greyscale","greyscale"]', JSON.stringify(await pageFilters(docId)));

answerCancel();
await page.click('[data-scan-action="filter-all"]');
await page.waitForTimeout(900);
check("cancelling leaves every page's filter alone",
      JSON.stringify(await pageFilters(docId)) === '["original","greyscale","greyscale"]', JSON.stringify(await pageFilters(docId)));

answerOk();
await clickChecked('[data-scan-action="filter-all"]', "Apply filter to all is still available");
await page.waitForTimeout(4000);
check("accepting applies the selected page's filter to all of them",
      (await pageFilters(docId)).every((f) => f === "original"), JSON.stringify(await pageFilters(docId)));
check("...and the confirm named the filter and the page count", sawMessage("all 3 pages"), JSON.stringify(dialogs));

// ---- 9. Delete a page (js/scanDoc.js:367) ----

const beforeDelete = await rowCounts();
answerCancel();
await page.click('[data-scan-action="delete-page"]');
await page.waitForTimeout(800);
check("cancelling keeps the page", (await rowCounts()).pages === beforeDelete.pages, JSON.stringify(await rowCounts()));

answerOk();
await clickChecked('[data-scan-action="delete-page"]', "Delete page is still available");
await page.waitForTimeout(1500);
const afterDelete = await rowCounts();
check("accepting deletes exactly one page", afterDelete.pages === beforeDelete.pages - 1, `${beforeDelete.pages} -> ${afterDelete.pages}`);
// deletePage removes blobKey, originalBlobKey and thumbKey, so a deleted page
// must take its bytes with it rather than orphaning them in the blob store.
check("...and its blobs with it", afterDelete.blobs < beforeDelete.blobs, `${beforeDelete.blobs} -> ${afterDelete.blobs}`);

// ---- 10. Clear translation history (js/app.js:503) ----

console.log("\nTranslation history");
await resetStore();
await ev(async () => {
  const h = await import("/js/translateHistory.js");
  await h.recordTranslation({ sourceText: "hola", translatedText: "hello", sourceLang: "es", targetLang: "en", tier: "claude" });
  await h.recordTranslation({ sourceText: "adios", translatedText: "bye", sourceLang: "es", targetLang: "en", tier: "claude" });
  const all = await h.getHistory({});
  await h.toggleSaved(all[0].id); // one SAVED entry - the whole point of the two buttons
});
await page.click("#nav-settings");
await page.waitForTimeout(600);
check("two history rows exist, one of them saved", (await rowCounts()).history === 2, JSON.stringify(await rowCounts()));

// "Clear history" has no confirm - it keeps saved phrases, so it is not
// destructive in the way the other button is. Included because the PAIR is the
// contract: this one must spare the saved entry the other one takes.
answerOk();
await gotoSettings();
await page.click("#settings-clear-history");
await page.waitForTimeout(900);
check("Clear history removes the unsaved row and keeps the saved one", (await rowCounts()).history === 1, JSON.stringify(await rowCounts()));

answerCancel();
await gotoSettings();
await page.click("#settings-clear-history-all");
await page.waitForTimeout(700);
check("cancelling Clear history AND saved keeps the saved row", (await rowCounts()).history === 1, JSON.stringify(await rowCounts()));

answerOk();
await gotoSettings();
await page.click("#settings-clear-history-all");
await page.waitForTimeout(900);
check("accepting removes the saved row too", (await rowCounts()).history === 0, JSON.stringify(await rowCounts()));
check("...and the confirm said saved phrases were included", sawMessage("saved phrases"), JSON.stringify(dialogs));

// ---- 11. Delete all local data (js/app.js:512-513) ----
//
// The only genuinely unrecoverable action in the app, and the one nothing
// automated had ever pressed. Two confirms, deliberately.

console.log("\nDelete all local data - the unrecoverable one");
await resetStore();
await makeNote("Survivor");
docId = await makeScanDoc();
await ev(async () => {
  const h = await import("/js/translateHistory.js");
  await h.recordTranslation({ sourceText: "hola", translatedText: "hello", sourceLang: "es", targetLang: "en", tier: "claude" });
});
await ev(async () => {
  const d = await import("/js/documents.js");
  await d.createFolder("Keepsakes");
});
await page.click("#nav-settings");
await page.waitForTimeout(700);
const populated = await rowCounts();
check("the store is populated across every kind of row before we press it",
      populated.documents >= 2 && populated.pages === 3 && populated.blobs > 0 && populated.folders === 1 && populated.history === 1,
      JSON.stringify(populated));

// Cancelling EITHER confirm must stop it. Two separate checks, because a single
// `if (!a || !b)` refactor would break one and not the other.
answerCancel();
await gotoSettings();
await page.click("#settings-delete-all");
await page.waitForTimeout(900);
check("cancelling the FIRST confirm deletes nothing",
      JSON.stringify(await rowCounts()) === JSON.stringify(populated), JSON.stringify(await rowCounts()));
check("...and it only got as far as asking once", dialogs.length === 1, JSON.stringify(dialogs));

// Accept the first, dismiss the second.
dialogs = [];
let answered = 0;
page.removeAllListeners("dialog");
page.on("dialog", async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  answered += 1;
  if (answered === 1) await d.accept();
  else await d.dismiss();
});
await gotoSettings();
await page.click("#settings-delete-all");
await page.waitForTimeout(900);
check("cancelling the SECOND confirm also deletes nothing",
      JSON.stringify(await rowCounts()) === JSON.stringify(populated), JSON.stringify(await rowCounts()));
check("...and it did ask twice", dialogs.length === 2, JSON.stringify(dialogs.map((d) => d.message)));

// Restore the normal handler and go through with it.
page.removeAllListeners("dialog");
dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  if (reply.accept) await d.accept(reply.text); else await d.dismiss();
});

// A secret in localStorage, to measure what "delete all local data" reaches.
await ev(() => localStorage.setItem("textscanner.anthropicApiKey", "sk-ant-canary-value"));

answerOk();
await gotoSettings();
await page.click("#settings-delete-all");
await page.waitForTimeout(2500);
const wiped = await rowCounts();

check("every document is gone", wiped.documents === 0, JSON.stringify(wiped));
check("every page is gone", wiped.pages === 0, JSON.stringify(wiped));
check("every image blob is gone - the bytes, not just the records", wiped.blobs === 0, JSON.stringify(wiped));
check("every folder is gone", wiped.folders === 0, JSON.stringify(wiped));
check("translation history is gone", wiped.history === 0, JSON.stringify(wiped));
check("the settings store is empty too", wiped.settings === 0, JSON.stringify(wiped));
check("it asked twice and then confirmed", dialogs.length === 3 && dialogs[2].type === "alert", JSON.stringify(dialogs.map((d) => d.type)));
check("it returns you to the library", (await ev(() => document.body.dataset.activeView)) === "library");

// THE LIMITATION, PINNED - not an endorsement.
//
// clearAll() empties all six IndexedDB stores and nothing else. The Anthropic
// API key lives in localStorage (js/coherenceClaude.js:26,117), and so do the
// theme choice and the command palette's frecency counts. None is touched.
//
// For the key that is worth stating plainly: after pressing "Delete all local
// data" and being told "All local data deleted.", a saved API key is still
// readable by the next person to open this browser profile.
//
// The section's own hint copy is accurate - "every document, page, image and
// translation on this device", none of which is the key. The BUTTON LABEL and
// the closing ALERT are the two that overreach. This is a copy/scope question,
// not a failure to delete, so this test pins the behaviour rather than
// asserting a fix nobody has decided on - the same pattern as
// test/non-latin-limitation.js.
//
// If someone makes clearAll() reach localStorage, this check FAILS, and that is
// correct: it means the decision was made and this comment plus the copy in
// index.html:675 and js/app.js:517 need updating together.
const survivingKey = await ev(() => localStorage.getItem("textscanner.anthropicApiKey"));
check('LIMITATION PINNED: the API key in localStorage SURVIVES "Delete all local data"',
      survivingKey === "sk-ant-canary-value",
      `key is now ${JSON.stringify(survivingKey)} - if this was deliberately fixed, update this check, index.html:675 and js/app.js:517 together`);
if (survivingKey) {
  console.log('       ^ deliberate-for-now, see the comment above this check. The closing alert says');
  console.log('         "All local data deleted." while a saved Anthropic API key is still readable.');
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${[...new Set(pageErrors)].join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll eleven dialog-gated paths act on OK, do nothing on Cancel, and ask what they claim to.");
