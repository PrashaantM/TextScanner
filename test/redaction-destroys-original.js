// redaction-destroys-original.js: asserts that applying a redaction actually
// destroys that page's unredacted original on the device - by reading the blob
// store, not by trusting a flag.
//
// WHY THIS EXISTS. Until this gate, redaction was half a feature that read like
// a whole one. burnAnnotations() did composite the black boxes into the exported
// pixels, and the exported JPEG really did carry no stroke data, so everything
// anyone tested about redaction passed. What nothing tested was the device: the
// untouched capture stayed in IndexedDB under `originalBlobKey`, and every
// filter, rotate and crop re-derives the page FROM it (js/scanDoc.js's
// rebuildPage). A page badged "redacted" could be turned back into the
// unredacted page by pressing a filter button.
//
// The failure mode this file is built around is specifically the one an
// in-memory assertion cannot see. A `destroyed: true` on the page record, a
// resolved promise, a toast that says "original deleted" - all of those can be
// true while the bytes sit in the blob store. So every destruction assertion
// below reads STORES.BLOBS directly and asks whether a record with that key
// still exists. That is the only question that matters.
//
// WHAT IT ASSERTS
//
//   1. Before: the original is a real, readable blob, distinct from the page's
//      processed image. (Without this, "it's gone" proves nothing.)
//   2. Cancelling EITHER confirm destroys nothing and applies nothing.
//   3. Accepting both: the original blob is absent from the blob store, the
//      page's own record no longer points at it, the black box is really in the
//      new image's pixels, and the badge says so.
//   4. No undo control is left reachable past the point undo stops working.
//   5. Restore cannot resurrect it. A backup taken BEFORE the destruction still
//      CONTAINS the original, and js/backup.js's importer exists to add blobs it
//      does not already hold - so this imports exactly that backup and asserts
//      the bytes stay gone.
//
// Usage: node test/redaction-destroys-original.js   (exits non-zero on failure)

import { launchBrowser, blobStorageWorks, noteBlobSkip } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8149;
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

// Same dialog shape as test/destructive-actions.js: Playwright auto-dismisses
// any dialog nothing is listening for, so without this handler every confirm
// below would silently take its Cancel branch and the file would "pass" while
// asserting nothing.
let reply = { accept: true };
let dialogs = [];
let acceptOnly = 0; // 0 = answer every dialog with `reply`; n = accept the first n, dismiss the rest
page.on("dialog", async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  if (acceptOnly) await (dialogs.length <= acceptOnly ? d.accept() : d.dismiss());
  else if (reply.accept) await d.accept();
  else await d.dismiss();
});
const answerOk = () => { reply = { accept: true }; acceptOnly = 0; dialogs = []; };
const answerCancel = () => { reply = { accept: false }; acceptOnly = 0; dialogs = []; };
const acceptFirstOnly = () => { acceptOnly = 1; dialogs = []; };
const sawMessage = (fragment) => dialogs.some((d) => d.message.includes(fragment));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });

const ev = (fn, arg) => page.evaluate(fn, arg);

const canStoreBlobs = await blobStorageWorks(page);
if (!canStoreBlobs) {
  noteBlobSkip("redaction destroys the original");
  await browser.close();
  server.close();
  console.log("\nSkipped: this browser cannot store a Blob in IndexedDB (see test/browser.js).");
  process.exit(0);
}

// A page with a recognisable light band across the middle, so "the black box
// really is in the pixels" is a measurable claim rather than a vibe. The band
// is where the redaction will be drawn.
async function makeScanDocWithPage() {
  return ev(async () => {
    const docs = await import("/js/documents.js");
    const doc = await docs.createDocument({ type: "scan" });
    const c = document.createElement("canvas");
    c.width = 240; c.height = 320;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 240, 320);
    g.fillStyle = "#ffffff"; g.fillRect(0, 140, 240, 40);
    g.fillStyle = "#111111"; g.font = "24px sans-serif"; g.fillText("SSN 123", 20, 168);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
    const p = await docs.addPage(doc.id, { blob, width: 240, height: 320, filter: "original" });
    return { docId: doc.id, pageId: p.id };
  });
}

// Reads the blob store DIRECTLY. This is the assertion the whole file is for:
// not "does a flag say destroyed", but "is there still a record under that key".
const blobStoreHas = (key) => ev(async (k) => {
  const s = await import("/js/store.js");
  const rows = await s.getAll(s.STORES.BLOBS);
  return {
    byGetBlob: !!(await s.getBlob(k)),
    byRawScan: rows.some((r) => r.key === k),
    totalBlobs: rows.length,
  };
}, key);

const pageRecord = (pageId) => ev(async (id) => {
  const d = await import("/js/documents.js");
  const a = await import("/js/annotate.js");
  const p = await d.getPage(id);
  return p && {
    blobKey: p.blobKey,
    originalBlobKey: p.originalBlobKey,
    originalDestroyedAt: p.originalDestroyedAt || null,
    strokes: (p.annotations || []).length,
    redacted: a.hasRedaction(p.annotations),
  };
}, pageId);

// Samples the page's CURRENT image where the redaction was drawn.
const pixelAt = (key, fx, fy) => ev(async ({ k, x, y }) => {
  const s = await import("/js/store.js");
  const blob = await s.getBlob(k);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const d = c.getContext("2d").getImageData(Math.round(img.naturalWidth * x), Math.round(img.naturalHeight * y), 1, 1).data;
    return [d[0], d[1], d[2]];
  } finally { URL.revokeObjectURL(url); }
}, { k: key, x: fx, y: fy });

const openDoc = async (docId) => {
  await page.goto(`http://localhost:${PORT}/index.html#document/${docId}`);
  await page.waitForFunction(() => document.body.dataset.activeView === "document", null, { timeout: 15000 });
  await page.waitForTimeout(1200);
};

// One drag across the middle band. Coordinates come from the overlay's own
// bounding box rather than being guessed, and the draft-box count is asserted
// straight afterwards so a coordinate mismatch fails here, loudly, instead of
// silently producing a redaction of nothing.
async function drawRedactionBox() {
  await page.click('[data-scan-action="redact"]');
  await page.waitForSelector("#scan-redact-panel:not(.hidden)", { timeout: 5000 });
  const overlay = await page.$("#scan-redact-overlay");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.58, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  return ev(() => document.querySelectorAll("#scan-redact-overlay .redact-box").length);
}

// ---- 1. A page whose original is real, readable and distinct ----

console.log("\nBefore the redaction");
const { docId, pageId } = await makeScanDocWithPage();
await openDoc(docId);

// addPage starts a page with originalBlobKey === blobKey. The rebuild that
// burns the redaction is what makes them diverge, so the ORIGINAL key has to be
// captured now, before anything touches the page.
const before = await pageRecord(pageId);
const originalKey = before.originalBlobKey;
check("the page starts with an original blob key", !!originalKey, JSON.stringify(before));
const presentBefore = await blobStoreHas(originalKey);
check("...and those bytes are really in the blob store", presentBefore.byGetBlob && presentBefore.byRawScan, JSON.stringify(presentBefore));
check("...and nothing is redacted yet", before.redacted === false && before.originalDestroyedAt === null, JSON.stringify(before));

// ---- 2. Cancelling either confirm destroys nothing ----

console.log("\nCancelling");
answerCancel();
let drawn = await drawRedactionBox();
check("dragging across the preview draws one draft box", drawn === 1, `drew ${drawn}`);

await page.click("#scan-redact-apply");
await page.waitForTimeout(800);
let afterFirstCancel = await blobStoreHas(originalKey);
check("cancelling the FIRST confirm leaves the original in the blob store", afterFirstCancel.byRawScan, JSON.stringify(afterFirstCancel));
check("...and applies no redaction", (await pageRecord(pageId)).redacted === false, JSON.stringify(await pageRecord(pageId)));
check("...and the confirm named the page", sawMessage("Apply 1 redaction"), JSON.stringify(dialogs.map((d) => d.message)));

acceptFirstOnly();
await page.click("#scan-redact-apply");
await page.waitForTimeout(1200);
const afterSecondCancel = await blobStoreHas(originalKey);
check("cancelling the SECOND confirm also leaves the original in the blob store", afterSecondCancel.byRawScan, JSON.stringify(afterSecondCancel));
check("...and still applies no redaction", (await pageRecord(pageId)).redacted === false, JSON.stringify(await pageRecord(pageId)));
check("...and it did ask twice", dialogs.length === 2, JSON.stringify(dialogs.map((d) => d.message)));
check("...and the second confirm said the original would be deleted from this device",
      dialogs[1] && dialogs[1].message.includes("unredacted original from this device"),
      JSON.stringify(dialogs.map((d) => d.message)));

// The draft survives a cancelled confirm - nothing was written, so there is
// nothing to have lost.
check("the draft box is still there to apply", (await ev(() => document.querySelectorAll("#scan-redact-overlay .redact-box").length)) === 1);

// ---- 3. Accepting both destroys it, for real ----

console.log("\nAccepting - the destruction");
answerOk();
await page.click("#scan-redact-apply");
await page.waitForTimeout(3000);

const destroyed = await blobStoreHas(originalKey);
check("the original blob is GONE from the blob store - the bytes, not a flag",
      destroyed.byRawScan === false,
      `a record under key ${originalKey} is still in STORES.BLOBS`);
check("...and getBlob() cannot read it either", destroyed.byGetBlob === false, JSON.stringify(destroyed));

const after = await pageRecord(pageId);
check("the page no longer points at the destroyed original", after.originalBlobKey !== originalKey, JSON.stringify(after));
check("...it points at its own redacted image instead, so filters still work", after.originalBlobKey === after.blobKey, JSON.stringify(after));
check("...and the destruction is dated on the record", typeof after.originalDestroyedAt === "number", JSON.stringify(after));
check("the page is genuinely redacted", after.redacted === true && after.strokes === 1, JSON.stringify(after));

const inBand = await pixelAt(after.blobKey, 0.5, 0.5);
const aboveBand = await pixelAt(after.blobKey, 0.5, 0.08);
check("the black box is really in the page's pixels", inBand && inBand.every((c) => c < 40), JSON.stringify(inBand));
check("...and only where it was drawn", aboveBand && aboveBand.every((c) => c > 200), JSON.stringify(aboveBand));

const badge = await ev(() => document.getElementById("scan-page-info").textContent);
check("the page badge says the original was destroyed, not just that it was redacted",
      badge.includes("original destroyed"), badge);

// ---- 4. No undo control is left offering something it cannot do ----

const undoState = await ev(() => {
  const panel = document.getElementById("scan-redact-panel");
  const undo = document.getElementById("scan-redact-undo");
  return {
    panelHidden: panel.classList.contains("hidden"),
    undoVisible: !!(undo.offsetWidth || undo.offsetHeight || undo.getClientRects().length),
    boxesLeft: document.querySelectorAll("#scan-redact-overlay .redact-box").length,
  };
});
check("the redaction panel closes once applied", undoState.panelHidden, JSON.stringify(undoState));
check('"Undo last box" is not reachable past the point undo stops working', undoState.undoVisible === false, JSON.stringify(undoState));
check("...and no draft box is left on screen to suggest one could be removed", undoState.boxesLeft === 0, JSON.stringify(undoState));

// Re-entering redaction must offer a FRESH draft, not the committed boxes
// dressed up as editable ones.
await page.click('[data-scan-action="redact"]');
await page.waitForSelector("#scan-redact-panel:not(.hidden)", { timeout: 5000 });
const reentered = await ev(() => ({
  boxes: document.querySelectorAll("#scan-redact-overlay .redact-box").length,
  undoDisabled: document.getElementById("scan-redact-undo").disabled,
  applyDisabled: document.getElementById("scan-redact-apply").disabled,
}));
check("re-opening Redact shows no committed box as if it were editable", reentered.boxes === 0, JSON.stringify(reentered));
check("...with Undo and Apply both inert until something new is drawn",
      reentered.undoDisabled && reentered.applyDisabled, JSON.stringify(reentered));
await page.click("#scan-redact-cancel");
await page.waitForTimeout(300);

// ---- 5. A backup taken BEFORE the destruction must not resurrect it ----
//
// This is the leg that the tombstone in js/store.js exists for. The backup file
// genuinely contains the original's bytes - it was made while they were still
// here - and js/backup.js's importer adds any blob whose key it does not
// already hold. Without the tombstone this import writes the destroyed original
// straight back into IndexedDB, where nothing displays it and nothing will ever
// delete it, because the page record stopped pointing at it.

console.log("\nRestore must not resurrect it");
const second = await makeScanDocWithPage();
await openDoc(second.docId);
const secondBefore = await pageRecord(second.pageId);
const secondOriginalKey = secondBefore.originalBlobKey;

// The backup is taken HERE, while the original still exists.
const backupHoldsOriginal = await ev(async (k) => {
  const b = await import("/js/backup.js");
  const backup = await b.exportLibrary();
  window.__preDestructionBackup = backup;
  return {
    holdsIt: (backup.blobs || []).some((e) => e.key === k),
    tombstones: (backup.destroyedBlobKeys || []).length,
  };
}, secondOriginalKey);
check("the backup taken before the destruction really does contain the original",
      backupHoldsOriginal.holdsIt, JSON.stringify(backupHoldsOriginal));

answerOk();
drawn = await drawRedactionBox();
check("a box is drawn on the second page too", drawn === 1, `drew ${drawn}`);
await page.click("#scan-redact-apply");
await page.waitForTimeout(3000);

const secondDestroyed = await blobStoreHas(secondOriginalKey);
check("the second page's original is destroyed", secondDestroyed.byRawScan === false, JSON.stringify(secondDestroyed));

const imported = await ev(async () => {
  const b = await import("/js/backup.js");
  return await b.importLibrary(window.__preDestructionBackup);
});
const afterRestore = await blobStoreHas(secondOriginalKey);
check("restoring that backup does NOT put the destroyed original back",
      afterRestore.byRawScan === false,
      `key ${secondOriginalKey} is back in STORES.BLOBS after import - the destruction was undone by a restore`);
check("...and the importer says it refused it rather than silently skipping",
      imported.refusedDestroyed >= 1, JSON.stringify(imported));
check("...while the rest of the backup still restores normally",
      imported.blobs >= 0 && typeof imported.documents === "number", JSON.stringify(imported));

// A backup taken AFTER a destruction carries the tombstone forward, which is
// what makes the destruction survive onto a device that never held the page.
const laterBackup = await ev(async (k) => {
  const b = await import("/js/backup.js");
  const backup = await b.exportLibrary();
  return {
    tombstoned: (backup.destroyedBlobKeys || []).includes(k),
    holdsIt: (backup.blobs || []).some((e) => e.key === k),
  };
}, secondOriginalKey);
check("a backup taken after the destruction carries the tombstone", laterBackup.tombstoned, JSON.stringify(laterBackup));
check("...and does not contain the destroyed bytes", laterBackup.holdsIt === false, JSON.stringify(laterBackup));

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${[...new Set(pageErrors)].join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nApplying a redaction destroys the page's original in the blob store, cancelling either confirm does not,");
console.log("no undo control outlives the point undo stops working, and a pre-destruction backup cannot bring it back.");
