// backup-roundtrip.js: proves the library can actually leave this device and
// come back - and that the API key does NOT travel with it.
//
// The app has no server, no sync and no account. That is the product, but it
// makes the browser's storage the only copy, and browsers delete storage:
// Safari's ITP purges all script-writable storage after 7 days without a visit
// for any site not installed to the home screen. So "Back up everything" is not
// a convenience feature, it is the only thing standing between a Safari user and
// total loss - which means a backup that silently fails to restore is worse than
// no backup at all, and worth a gate that does the whole cycle for real.
//
// THE CYCLE, end to end, through the real UI where there is one:
//   1. build a library: a note, and a scan document with pages whose recognized
//      text is indexed for search
//   2. back it up
//   3. "Delete all local data" - the genuine destructive path, both confirms
//   4. import the backup
//   5. assert the documents are back AND that full-text search finds a word that
//      only exists INSIDE a scanned page, which is the assertion that proves the
//      search index was rebuilt rather than just the records restored
//
// THE CANARY. A library backup is exactly the file someone emails themselves or
// drops in a synced folder. An Anthropic API key inside it would be the same
// leak js/store.js's clearAll() closed, with a wider blast radius because this
// file is meant to travel. So a key is saved before the export and the
// serialized backup is searched for it, as text - not "we intended not to
// include settings", but "the bytes do not contain it".
//
// Usage: node test/backup-roundtrip.js   (BROWSER= to pick an engine)

import { launchBrowser, blobStorageWorks, noteBlobSkip, BROWSER_NAME, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
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
  } catch { res.writeHead(404); res.end("nf"); }
});
const PORT = await listenOnEphemeralPort(server);

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
page.on("dialog", async (d) => { await d.accept(); }); // the two delete-all confirms

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });

const ev = (fn, arg) => page.evaluate(fn, arg);

// The import writes page images back as Blobs. Playwright's WebKit cannot store
// a Blob in IndexedDB - see test/browser.js for the evidence that this is a
// limitation of that BUILD rather than of Safari, which has shipped
// Blob-in-IndexedDB since Safari 10. Skipping here rather than forcing it green
// or leaving the nightly permanently red on a non-bug; the real-Safari
// confirmation is item 1 of WEB-COMPLETION-PLAN.md §4.3's manual checklist.
const canStoreBlobs = await blobStorageWorks(page);
if (!canStoreBlobs) {
  console.log("\nBackup round-trip");
  noteBlobSkip("the whole round-trip, which restores page images");
  console.log("           Blocked on X2. Item 1 of §4.3's real-Safari checklist covers it.");
  await browser.close();
  server.close();
  console.log(`\nSKIPPED on ${BROWSER_NAME}: backup round-trip needs Blob-in-IndexedDB.`);
  process.exit(0);
}

// ---- 1. Build a library worth losing ----

console.log("\nBuilding a library");

const SECRET_WORD = "pomegranate"; // appears ONLY inside a scanned page's text
const CANARY_KEY = "sk-ant-canary-must-not-be-exported-9c3f1a";

const built = await ev(async ({ secret }) => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  await store.clearAll();

  const note = await docs.createDocument({ type: "note" });
  await docs.updateDocument(note.id, { title: "Kept note", body: "<p>ordinary note body</p>" });

  const scan = await docs.createDocument({ type: "scan" });
  await docs.updateDocument(scan.id, { title: "Insurance policy" });
  const makeBlob = async (shade) => {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 280;
    const g = c.getContext("2d");
    g.fillStyle = shade; g.fillRect(0, 0, 200, 280);
    g.fillStyle = "#000"; g.font = "18px sans-serif"; g.fillText("page", 20, 40);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  };
  const p1 = await docs.addPage(scan.id, { blob: await makeBlob("#eee"), width: 200, height: 280, filter: "original" });
  const p2 = await docs.addPage(scan.id, { blob: await makeBlob("#ddd"), width: 200, height: 280, filter: "greyscale" });
  // Recognized text on page 2 only. The search assertion later depends on this
  // word existing nowhere else - not in a title, not in a note.
  await docs.updatePage(p2.id, { text: `deductible clause ${secret} renewal terms` });
  await docs.reindexDocument(scan.id);

  const folder = await docs.createFolder("Policies");
  await docs.updateDocument(scan.id, { folderId: folder.id });

  const counts = async () => ({
    documents: (await docs.getAllDocuments()).length,
    pages: (await store.getAll(store.STORES.PAGES)).length,
    blobs: (await store.getAll(store.STORES.BLOBS)).length,
    folders: (await docs.getFolders()).length,
  });
  return { before: await counts(), scanId: scan.id };
}, { secret: SECRET_WORD });

check("library has documents, pages, blobs and a folder",
      built.before.documents === 2 && built.before.pages === 2 && built.before.blobs > 0 && built.before.folders === 1,
      JSON.stringify(built.before));

// Search must find the word BEFORE the round-trip too, or the assertion after it
// would prove nothing about restoration.
const foundBefore = await ev(async (secret) => {
  const docs = await import("/js/documents.js");
  const all = await docs.getAllDocuments();
  return docs.queryDocuments(all, { search: secret }).length;
}, SECRET_WORD);
check(`full-text search finds "${SECRET_WORD}" inside the scanned page before backup`, foundBefore === 1, String(foundBefore));

// ---- 2. Save a key, then back up ----

console.log("\nBackup, and what it must not contain");

await ev((key) => localStorage.setItem("textscanner.anthropicApiKey", key), CANARY_KEY);

const exported = await ev(async () => {
  const { exportLibraryToBlob } = await import("/js/backup.js");
  const { blob, counts } = await exportLibraryToBlob();
  const text = await blob.text();
  return { text, size: blob.size, counts };
});

check("the backup contains every document, page, folder and image",
      exported.counts.documents === 2 && exported.counts.pages === 2 &&
      exported.counts.folders === 1 && exported.counts.blobs > 0,
      JSON.stringify(exported.counts));

// THE CANARY - searched in the raw serialized bytes, not inferred from intent.
check("the API key is NOT in the backup file", !exported.text.includes(CANARY_KEY),
      "the exported JSON contains the canary key - a library backup is exactly the file someone shares or syncs");
check("no 'anthropic' key name leaked into it either",
      !exported.text.toLowerCase().includes("anthropicapikey"),
      "the key's storage name appears in the export");
check("the key is still saved locally - the export must COPY nothing, not clear it",
      (await ev(() => localStorage.getItem("textscanner.anthropicApiKey"))) === CANARY_KEY);

// ---- 3. Delete everything, for real, through the UI ----

console.log("\nDelete all local data, then restore");

await page.click("#nav-settings");
await page.waitForTimeout(400);
await page.click("#settings-delete-all");
await page.waitForTimeout(2000);

const wiped = await ev(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  return {
    documents: (await docs.getAllDocuments()).length,
    pages: (await store.getAll(store.STORES.PAGES)).length,
    blobs: (await store.getAll(store.STORES.BLOBS)).length,
    folders: (await docs.getFolders()).length,
  };
});
check("everything really is gone before the restore", wiped.documents === 0 && wiped.pages === 0 && wiped.blobs === 0 && wiped.folders === 0,
      JSON.stringify(wiped));

// ---- 4. Import ----

const restored = await ev(async (text) => {
  const { importLibrary } = await import("/js/backup.js");
  const added = await importLibrary(JSON.parse(text));
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  return {
    added,
    after: {
      documents: (await docs.getAllDocuments()).length,
      pages: (await store.getAll(store.STORES.PAGES)).length,
      blobs: (await store.getAll(store.STORES.BLOBS)).length,
      folders: (await docs.getFolders()).length,
    },
  };
}, exported.text);

check("every document came back", restored.after.documents === built.before.documents,
      `${restored.after.documents} of ${built.before.documents}`);
check("every page came back", restored.after.pages === built.before.pages,
      `${restored.after.pages} of ${built.before.pages}`);
check("every image blob came back", restored.after.blobs === built.before.blobs,
      `${restored.after.blobs} of ${built.before.blobs}`);
check("the folder came back", restored.after.folders === built.before.folders,
      `${restored.after.folders} of ${built.before.folders}`);

// ---- 5. The assertions that prove it is USABLE, not merely present ----

const usable = await ev(async (secret) => {
  const docs = await import("/js/documents.js");
  const store = await import("/js/store.js");
  const all = await docs.getAllDocuments();
  const scan = all.find((d) => d.type === "scan");
  const pages = await docs.getPagesForDocument(scan);
  const blob = pages[0] ? await store.getBlob(pages[0].blobKey) : null;
  const img = blob ? await createImageBitmap(blob) : null;
  return {
    searchHits: docs.queryDocuments(all, { search: secret }).length,
    titles: all.map((d) => d.title).sort(),
    folderId: scan?.folderId || null,
    pageOrder: pages.map((p) => p.order),
    blobType: blob?.type || null,
    blobDecodes: !!img && img.width === 200 && img.height === 280,
    pageText: pages.map((p) => p.text || "").join(" "),
  };
}, SECRET_WORD);

check(`full-text search still finds "${SECRET_WORD}" INSIDE the restored scanned page`,
      usable.searchHits === 1,
      `${usable.searchHits} hits - the records may be back but the search index was not rebuilt`);
check("document titles survived", JSON.stringify(usable.titles) === JSON.stringify(["Insurance policy", "Kept note"]),
      JSON.stringify(usable.titles));
check("the scan is still in its folder", !!usable.folderId);
check("page order survived", JSON.stringify(usable.pageOrder) === "[0,1]", JSON.stringify(usable.pageOrder));
check("a restored page image is a real JPEG, not base64 text", usable.blobType === "image/jpeg", String(usable.blobType));
check("...and it decodes at its original dimensions", usable.blobDecodes === true);
check("the recognized page text came back", usable.pageText.includes(SECRET_WORD));

// ---- Importing twice must not duplicate ----

const twice = await ev(async (text) => {
  const { importLibrary } = await import("/js/backup.js");
  const added = await importLibrary(JSON.parse(text));
  const docs = await import("/js/documents.js");
  return { added, documents: (await docs.getAllDocuments()).length };
}, exported.text);
check("importing the same backup twice adds nothing", twice.added.documents === 0 && twice.documents === built.before.documents,
      JSON.stringify(twice));

// ---- A file that is not a backup ----

const rejected = await ev(async () => {
  const { importLibrary } = await import("/js/backup.js");
  const out = {};
  try { await importLibrary({ kind: "something-else" }); out.wrongKind = "accepted"; }
  catch (e) { out.wrongKind = e.message; }
  try { await importLibrary({ kind: "textscanner-backup", version: 99 }); out.futureVersion = "accepted"; }
  catch (e) { out.futureVersion = e.message; }
  return out;
});
check("a file that is not a backup is refused with a readable message",
      /doesn't look like/i.test(rejected.wrongKind), rejected.wrongKind);
check("a backup from a newer format is refused rather than half-read",
      /newer version/i.test(rejected.futureVersion), rejected.futureVersion);

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${[...new Set(pageErrors)].join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nThe library survives a full delete-and-restore, and the API key does not travel with it.");
