// library-documents.js: end-to-end coverage for the document model and the
// library that reads it - the Notes-app half of the app.
//
// Everything here runs against the REAL IndexedDB in a real browser, through the
// real modules. There is no mock store, deliberately: the interesting failures in
// a persistence layer are transaction and lifecycle failures (a write that
// resolves before it commits, a blob orphaned by a partial delete, an index that
// disagrees with the records it indexes), and a mock has none of them.
//
// The suite is destructive - it clears the database - so it runs against its own
// origin (a distinct port) rather than sharing one with any other test.
//
// Usage: node test/library-documents.js

import { launchBrowser, blobStorageWorks, noteBlobSkip } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8133;
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

const browser = await launchBrowser({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 15000 });

// ---- Store and document model ----

console.log("\nStore and document model");

const model = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  await store.clearAll();

  const out = {};
  out.available = await store.isAvailable();

  // Create, read back, update.
  const note = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "First note" });
  out.createdId = note.id;
  out.readBack = (await docs.getDocument(note.id))?.title;

  const updated = await docs.updateDocument(note.id, { body: "<p>Hello world</p>" });
  out.bodyPersisted = (await docs.getDocument(note.id))?.body;
  out.updatedAtMoved = updated.updatedAt >= note.updatedAt;

  // The search index is denormalized on the document, so search never has to
  // open a page or a blob.
  await docs.reindexDocument(note.id);
  out.searchText = (await docs.getDocument(note.id))?.searchText;

  // Block-boundary handling: the bug this specifically guards is textContent
  // concatenating "<li>a</li><li>b</li>" into "ab".
  out.stripsBlocks = docs.stripMarkup("<ul><li>Oat milk</li><li>Bread</li></ul>");
  out.stripsParagraphs = docs.stripMarkup("<p>One</p><p>Two</p>");
  out.stripsBreaks = docs.stripMarkup("Line one<br>Line two");

  // Title derivation falls back to the first line of content.
  const untitled = await docs.createDocument({ type: docs.DOC_TYPES.NOTE });
  await docs.updateDocument(untitled.id, { body: "<h2>Derived heading</h2><p>Body text</p>" });
  await docs.reindexDocument(untitled.id);
  out.derivedTitle = docs.deriveTitle(await docs.getDocument(untitled.id));
  out.emptyTitle = docs.deriveTitle(await docs.getDocument((await docs.createDocument({ type: docs.DOC_TYPES.SCAN })).id));

  return out;
});

check("IndexedDB is available", model.available === true);
check("a document round-trips", model.readBack === "First note", model.readBack);
check("an update persists", model.bodyPersisted === "<p>Hello world</p>", model.bodyPersisted);
check("updatedAt advances on write", model.updatedAtMoved === true);
check("searchText is denormalized onto the document", model.searchText === "Hello world", model.searchText);
check("stripMarkup separates list items", model.stripsBlocks === "Oat milk\nBread", JSON.stringify(model.stripsBlocks));
check("stripMarkup separates paragraphs", model.stripsParagraphs === "One\nTwo", JSON.stringify(model.stripsParagraphs));
check("stripMarkup honours <br>", model.stripsBreaks === "Line one\nLine two", JSON.stringify(model.stripsBreaks));
check("title is derived from the first line", model.derivedTitle === "Derived heading", model.derivedTitle);
check("an empty scan falls back to a placeholder title", model.emptyTitle === "Untitled scan", model.emptyTitle);

// ---- Search, folders, tags ----

console.log("\nSearch, folders and tags");

const query = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  await store.clearAll();

  const folder = await docs.createFolder("Receipts");

  const a = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Coffee receipt" });
  await docs.updateDocument(a.id, { body: "<p>Flat white, four pounds twenty</p>", folderId: folder.id });
  await docs.reindexDocument(a.id);
  await docs.addTag(a.id, "Expenses");

  const b = await docs.createDocument({ type: docs.DOC_TYPES.SCAN, title: "Train ticket" });
  await docs.updateDocumentQuietly(b.id, { searchText: "LONDON TO EDINBURGH departing 09:14" });

  const c = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Pinned thing" });
  await docs.updateDocument(c.id, { pinned: true });

  const all = await docs.getAllDocuments();
  const out = {};

  // Search reaches inside scanned text, not just titles.
  out.byBodyText = docs.queryDocuments(all, { search: "flat white" }).map((d) => d.title);
  out.byScanText = docs.queryDocuments(all, { search: "edinburgh" }).map((d) => d.title);
  out.byTitle = docs.queryDocuments(all, { search: "ticket" }).map((d) => d.title);
  out.byTag = docs.queryDocuments(all, { tag: "expenses" }).map((d) => d.title);
  out.byFolder = docs.queryDocuments(all, { folderId: folder.id }).map((d) => d.title);
  out.byType = docs.queryDocuments(all, { type: "scan" }).map((d) => d.title);

  // Pinned documents sort first regardless of recency.
  out.firstOverall = docs.queryDocuments(all, {})[0]?.title;

  // Tags are normalized - case folded, spaces hyphenated, leading # stripped.
  out.normalized = [docs.normalizeTag("  #Some Tag "), docs.normalizeTag("UPPER")];

  // The excerpt shows WHY a result matched, not just its opening words.
  out.excerpt = docs.searchExcerpt(all.find((d) => d.title === "Train ticket"), "edinburgh");

  return out;
});

check("search matches note body text", query.byBodyText.includes("Coffee receipt"), JSON.stringify(query.byBodyText));
check("search matches scanned text", query.byScanText.includes("Train ticket"), JSON.stringify(query.byScanText));
check("search matches titles", query.byTitle.includes("Train ticket"), JSON.stringify(query.byTitle));
check("filtering by tag works", query.byTag.includes("Coffee receipt"), JSON.stringify(query.byTag));
check("filtering by folder works", query.byFolder.length === 1 && query.byFolder[0] === "Coffee receipt", JSON.stringify(query.byFolder));
check("filtering by type works", query.byType.length === 1 && query.byType[0] === "Train ticket", JSON.stringify(query.byType));
check("pinned documents sort first", query.firstOverall === "Pinned thing", query.firstOverall);
check("tags are normalized", query.normalized[0] === "some-tag" && query.normalized[1] === "upper", JSON.stringify(query.normalized));
check("the excerpt is centred on the match", /EDINBURGH/i.test(query.excerpt), query.excerpt);

// ---- Trash ----

console.log("\nTrash");

const trash = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  await store.clearAll();

  const doc = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Doomed" });
  const out = {};

  await docs.trashDocument(doc.id);
  const all1 = await docs.getAllDocuments();
  out.hiddenFromLibrary = docs.queryDocuments(all1, {}).length;
  out.visibleInTrash = docs.queryDocuments(all1, { trash: true }).length;
  // Trashing must not destroy anything.
  out.stillExists = !!(await docs.getDocument(doc.id));

  await docs.restoreDocument(doc.id);
  const all2 = await docs.getAllDocuments();
  out.restored = docs.queryDocuments(all2, {}).length;

  await docs.trashDocument(doc.id);
  await docs.purgeDocument(doc.id);
  out.purged = !(await docs.getDocument(doc.id));

  // Expired trash is purged; unexpired trash is not.
  const old = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Old" });
  await docs.updateDocumentQuietly(old.id, { deletedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 });
  const recent = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Recent" });
  await docs.trashDocument(recent.id);
  out.purgedCount = await docs.purgeExpiredTrash(30);
  out.oldGone = !(await docs.getDocument(old.id));
  out.recentKept = !!(await docs.getDocument(recent.id));

  return out;
});

check("trashing hides from the library", trash.hiddenFromLibrary === 0, String(trash.hiddenFromLibrary));
check("trashing shows in Recently Deleted", trash.visibleInTrash === 1, String(trash.visibleInTrash));
check("trashing destroys nothing", trash.stillExists === true);
check("restoring brings it back", trash.restored === 1, String(trash.restored));
check("purging really deletes", trash.purged === true);
check("expired trash is purged", trash.purgedCount === 1 && trash.oldGone === true, String(trash.purgedCount));
check("unexpired trash is kept", trash.recentKept === true);

// ---- Folder deletion must not delete documents ----

console.log("\nFolders");

const folders = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  await store.clearAll();

  const folder = await docs.createFolder("Temp");
  const doc = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Inside" });
  await docs.updateDocument(doc.id, { folderId: folder.id });

  const moved = await docs.deleteFolder(folder.id);
  const after = await docs.getDocument(doc.id);

  return { moved, survived: !!after, folderCleared: after?.folderId === null, remaining: (await docs.getFolders()).length };
});

check("deleting a folder reports what moved", folders.moved === 1, String(folders.moved));
check("documents inside a deleted folder survive", folders.survived === true);
check("their folder reference is cleared", folders.folderCleared === true);
check("the folder itself is gone", folders.remaining === 0, String(folders.remaining));

// ---- Blobs and pages ----

console.log("\nPages and blobs");

// The ONLY section in this file that stores a Blob in IndexedDB. Guarded rather
// than letting the whole gate die here, which is what used to happen on WebKit -
// an UnknownError at this line took scan filters, edge detection, annotations,
// translation history, library UI and note sanitization down with it, so an
// engine that can run six of seven sections was reporting zero.
const canStoreBlobs = await blobStorageWorks(page);
if (!canStoreBlobs) noteBlobSkip("pages, blobs and their lifetime");

const pages = !canStoreBlobs ? null : await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  const filters = await import("/js/scanFilters.js");
  await store.clearAll();

  const makeBlob = async (label, w = 300, h = 400) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    ctx.font = "28px sans-serif";
    ctx.fillText(label, 20, 60);
    return filters.canvasToBlob(canvas, "image/jpeg", 0.9);
  };

  const doc = await docs.createDocument({ type: docs.DOC_TYPES.SCAN, title: "Multi" });
  const out = {};

  const p1 = await docs.addPage(doc.id, { blob: await makeBlob("ONE"), width: 300, height: 400 });
  const p2 = await docs.addPage(doc.id, { blob: await makeBlob("TWO"), width: 300, height: 400 });
  const p3 = await docs.addPage(doc.id, { blob: await makeBlob("THREE"), width: 300, height: 400 });

  let current = await docs.getDocument(doc.id);
  out.pageCount = current.pageIds.length;
  out.orderInitial = (await docs.getPagesForDocument(current)).map((p) => p.id === p1.id ? 1 : p.id === p2.id ? 2 : 3);

  // Reorder: move the third page to the front.
  current = await docs.reorderPages(doc.id, [p3.id, p1.id, p2.id]);
  out.orderAfter = (await docs.getPagesForDocument(current)).map((p) => (p.id === p1.id ? 1 : p.id === p2.id ? 2 : 3));

  // A reorder that omits a page must not lose it.
  current = await docs.reorderPages(doc.id, [p2.id]);
  out.orderRecovered = (await docs.getPagesForDocument(current)).length;

  // The blob really is readable back.
  const stored = await store.getBlob(p1.blobKey);
  out.blobSize = stored ? stored.size : 0;
  out.blobType = stored ? stored.type : null;

  // Deleting a page must free its blobs, not just unlink the record.
  const beforeKey = p1.blobKey;
  await docs.deletePage(doc.id, p1.id);
  out.blobFreed = (await store.getBlob(beforeKey)) === null;
  current = await docs.getDocument(doc.id);
  out.pageCountAfterDelete = current.pageIds.length;

  // Purging the document must free every remaining page blob.
  const remaining = await docs.getPagesForDocument(current);
  const keys = remaining.map((p) => p.blobKey);
  await docs.purgeDocument(doc.id);
  const stillThere = [];
  for (const key of keys) if (await store.getBlob(key)) stillThere.push(key);
  out.orphanedBlobs = stillThere.length;

  return out;
});

if (canStoreBlobs) {
  check("pages are added in order", pages.pageCount === 3, String(pages.pageCount));
  check("initial page order is insertion order", JSON.stringify(pages.orderInitial) === "[1,2,3]", JSON.stringify(pages.orderInitial));
  check("reordering works", JSON.stringify(pages.orderAfter) === "[3,1,2]", JSON.stringify(pages.orderAfter));
  check("a partial reorder does not lose pages", pages.orderRecovered === 3, String(pages.orderRecovered));
  check("page image blobs are stored and readable", pages.blobSize > 500, String(pages.blobSize));
  check("page blobs keep their MIME type", pages.blobType === "image/jpeg", pages.blobType);
  check("deleting a page frees its blob", pages.blobFreed === true);
  check("deleting a page updates the document", pages.pageCountAfterDelete === 2, String(pages.pageCountAfterDelete));
  check("purging a document leaves no orphaned blobs", pages.orphanedBlobs === 0, String(pages.orphanedBlobs));
}

// ---- Scan filters ----

console.log("\nScan filters");

const filters = await page.evaluate(async () => {
  const f = await import("/js/scanFilters.js");

  // A page-like image: light background, dark text, and a lighting gradient
  // across it - which is what every real photo of a page has and what the
  // filters exist to remove.
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 300;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 400, 300);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(1, "#9a9a90");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 400, 300);
  ctx.fillStyle = "#202020";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText("PAGE TEXT", 30, 160);

  const meanLuma = (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    return sum / (d.length / 4);
  };

  const out = { sizes: {}, luma: {} };
  for (const name of Object.values(f.FILTERS)) {
    const result = f.applyFilter(canvas, name);
    out.sizes[name] = `${result.width}x${result.height}`;
    out.luma[name] = Math.round(meanLuma(result));
  }

  // B&W must be genuinely two-valued, and soft B&W must genuinely not be.
  //
  // Counted as DISTINCT VALUES rather than compared by mean luma: two very
  // different distributions can share a mean, and an earlier version of this
  // check passed a hard and a soft image with identical means while their
  // histograms were 2 values and 182.
  const distinctValues = (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const values = new Set();
    for (let i = 0; i < d.length; i += 4) values.add(d[i]);
    return values.size;
  };
  out.bwDistinctValues = distinctValues(f.applyFilter(canvas, f.FILTERS.BW));
  out.softBwDistinctValues = distinctValues(f.applyFilter(canvas, f.FILTERS.SOFT_BW));

  // Rotation swaps dimensions on a quarter turn and is a no-op on a full turn.
  out.rot90 = (() => {
    const r = f.rotateCanvas(canvas, 90);
    return `${r.width}x${r.height}`;
  })();
  out.rot360 = (() => {
    const r = f.rotateCanvas(canvas, 360);
    return `${r.width}x${r.height}`;
  })();

  const thumb = f.makeThumbnail(canvas, 100);
  out.thumb = `${thumb.width}x${thumb.height}`;

  return out;
});

const allSameSize = Object.values(filters.sizes).every((s) => s === "400x300");
check("every filter preserves dimensions", allSameSize, JSON.stringify(filters.sizes));
check("auto enhance brightens a shaded page", filters.luma.auto > filters.luma.original, `auto ${filters.luma.auto} vs original ${filters.luma.original}`);
check("magic colour brightens further still", filters.luma.magic >= filters.luma.auto, `magic ${filters.luma.magic} vs auto ${filters.luma.auto}`);
check("black & white is strictly two-valued", filters.bwDistinctValues === 2, String(filters.bwDistinctValues));
check("soft B&W keeps intermediate tones", filters.softBwDistinctValues > 20, `${filters.softBwDistinctValues} distinct values`);
check("a quarter turn swaps dimensions", filters.rot90 === "300x400", filters.rot90);
check("a full turn is a no-op", filters.rot360 === "400x300", filters.rot360);
check("thumbnails are bounded by the requested edge", filters.thumb === "100x75", filters.thumb);

// ---- Edge detection ----

console.log("\nEdge detection");

const edges = await page.evaluate(async () => {
  const e = await import("/js/edgeDetect.js");

  const withPage = (angle = 0) => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 800;
    const ctx = canvas.getContext("2d");
    // A dark desk with a light page on it - the case detection is for.
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(0, 0, 600, 800);
    ctx.save();
    ctx.translate(300, 400);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.fillStyle = "#f4f2ec";
    ctx.fillRect(-200, -290, 400, 580);
    ctx.restore();
    return canvas;
  };

  // SEEDED, not Math.random(). This used to draw fresh random noise every run,
  // which made the assertion below a coin flip: measured across 40 frames per
  // engine, detectDocument finds a spurious "page" in uniform noise 0/40 on
  // Chromium, 14/40 on WebKit and 17/40 on Firefox. With Math.random() the
  // Firefox gate was passing roughly three runs in five - passing by luck, which
  // is worse than failing, because it hides the finding AND cannot be
  // reproduced. A fixed seed makes the result the same every run on a given
  // engine, so the number below means something.
  const noPage = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 800;
    const ctx = canvas.getContext("2d");
    // mulberry32, inlined: four lines, no dependency, identical everywhere.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const img = ctx.createImageData(600, 800);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 40 + Math.floor(rand() * 180);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  };

  const out = {};
  const straight = e.detectDocument(withPage(0));
  out.straightFound = !!straight;
  if (straight) {
    const xs = straight.map((p) => p.x);
    const ys = straight.map((p) => p.y);
    out.straightBounds = [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
    out.straightArea = Math.round(e.quadArea(straight));
  }

  out.rotatedFound = !!e.detectDocument(withPage(12));
  out.noiseFound = !!e.detectDocument(noPage());

  const full = e.fullFrameCorners(100, 200);
  out.fullFrame = e.isFullFrame(full, 100, 200);
  out.notFullFrame = e.isFullFrame([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 190 }, { x: 10, y: 190 }], 100, 200);

  // Ordering is top-left clockwise regardless of the input order.
  const shuffled = [{ x: 90, y: 190 }, { x: 10, y: 10 }, { x: 10, y: 190 }, { x: 90, y: 10 }];
  out.ordered = e.orderCorners(shuffled).map((p) => `${p.x},${p.y}`).join(" ");

  return out;
});

check("a page on a desk is detected", edges.straightFound === true);
check("the detected quad is roughly the page", edges.straightArea > 400 * 580 * 0.85 && edges.straightArea < 400 * 580 * 1.2, String(edges.straightArea));
check("a rotated page is detected", edges.rotatedFound === true);
// KNOWN TO FAIL on WebKit and Firefox, and that is the finding, not a flake.
// js/edgeDetect.js downscales to ~240px with imageSmoothingQuality "high"
// before looking for edges, and every engine implements "high" with a different
// resampling kernel. Chromium's smooths uniform noise into near-flat grey with
// nothing to find; WebKit's and Firefox's leave enough residual structure for
// the flood fill to percolate into a spurious quad. So the solidity requirement
// that fixed this (ANALYSIS.md §8.3, bug 3) was tuned against one engine's
// resampler and does not hold on the others.
//
// Left as a HARD failure deliberately: unlike the Blob-in-IndexedDB skip above,
// this is a real defect users hit - point the camera at a textured surface with
// no page and Safari or Firefox will confidently crop to nonsense, which is the
// exact behaviour README.md promises against ("it deliberately declines to guess
// when it cannot find a page"). Fixing it is a threshold change and belongs
// under the merge rule in test/TUNING-2.md, not a quick tighten here.
check("noise is refused rather than guessed at", edges.noiseFound === false);
check("isFullFrame recognises the whole frame", edges.fullFrame === true);
check("isFullFrame rejects a real crop", edges.notFullFrame === false);
check("corners are ordered top-left clockwise", edges.ordered === "10,10 90,10 90,190 10,190", edges.ordered);

// ---- Annotations ----

console.log("\nAnnotations");

const annotations = await page.evaluate(async () => {
  const a = await import("/js/annotate.js");
  const out = {};

  const stroke = a.createStroke(a.TOOLS.PEN);
  // Points closer than the minimum step are dropped, so a signature does not
  // store thousands of near-identical samples.
  a.addPoint(stroke, 0.1, 0.1);
  const acceptedFar = a.addPoint(stroke, 0.5, 0.5);
  const acceptedNear = a.addPoint(stroke, 0.5001, 0.5001);
  out.pointCount = stroke.points.length / 2;
  out.acceptedFar = acceptedFar;
  out.acceptedNear = acceptedNear;

  // Out-of-range points are clamped rather than stored.
  a.addPoint(stroke, 5, -3);
  out.clamped = stroke.points.slice(-2);

  // Erasing is whole-stroke.
  const other = a.createStroke(a.TOOLS.PEN);
  a.addPoint(other, 0.9, 0.9);
  a.addPoint(other, 0.95, 0.95);
  const erased = a.eraseAt([stroke, other], 0.5, 0.5, 0.03);
  out.erasedCount = erased.erased;
  out.survivors = erased.strokes.length;

  out.hasRedaction = a.hasRedaction([a.createStroke(a.TOOLS.REDACT)]);

  const redact = a.createStroke(a.TOOLS.REDACT);
  a.addPoint(redact, 0.2, 0.2);
  a.addPoint(redact, 0.8, 0.2);
  out.hasRealRedaction = a.hasRedaction([redact]);

  // Burning composites into the pixels, which is what makes redaction real
  // rather than a removable overlay.
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 100;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 200, 100);
  const burned = a.burnAnnotations(canvas, [redact]);
  const px = burned.getContext("2d").getImageData(100, 20, 1, 1).data;
  out.redactedPixel = [px[0], px[1], px[2]];

  const bounds = a.boundsOf([redact]);
  out.bounds = bounds ? [+bounds.x.toFixed(2), +bounds.y.toFixed(2)] : null;

  return out;
});

check("distant points are accepted", annotations.acceptedFar === true);
check("near-duplicate points are dropped", annotations.acceptedNear === false);
check("only distinct points are stored", annotations.pointCount === 2, String(annotations.pointCount));
check("out-of-range points are clamped to the page", JSON.stringify(annotations.clamped) === "[1,0]", JSON.stringify(annotations.clamped));
check("the eraser removes a whole stroke", annotations.erasedCount === 1 && annotations.survivors === 1, `${annotations.erasedCount}/${annotations.survivors}`);
check("an empty redact stroke is not a redaction", annotations.hasRedaction === false);
check("a real redact stroke is a redaction", annotations.hasRealRedaction === true);
check("redaction is burned into the pixels", annotations.redactedPixel.every((v) => v < 40), JSON.stringify(annotations.redactedPixel));
check("stroke bounds are computed", annotations.bounds !== null, JSON.stringify(annotations.bounds));

// ---- Translation history ----

console.log("\nTranslation history");

const history = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const h = await import("/js/translateHistory.js");
  await store.clearAll();

  const out = {};

  await h.recordTranslation({ sourceText: "Hello", translatedText: "Hola", targetLang: "es", tier: "claude" });
  await h.recordTranslation({ sourceText: "Goodbye", translatedText: "Adios", targetLang: "es", tier: "claude" });
  out.count = (await h.getHistory()).length;

  // Re-translating the same text into the same language refreshes rather than
  // duplicating.
  await h.recordTranslation({ sourceText: "Hello", translatedText: "Hola!", targetLang: "es", tier: "claude" });
  const after = await h.getHistory();
  out.afterRepeat = after.length;
  out.repeatCount = after.find((e) => e.sourceText === "Hello")?.count;
  out.refreshed = after.find((e) => e.sourceText === "Hello")?.translatedText;

  // Empty input records nothing.
  out.emptyIgnored = (await h.recordTranslation({ sourceText: "  ", translatedText: "x", targetLang: "es" })) === null;

  // Saving exempts an entry from trimming and from a plain clear.
  const target = after.find((e) => e.sourceText === "Goodbye");
  await h.toggleSaved(target.id);
  const removed = await h.clearHistory({ includeSaved: false });
  const remaining = await h.getHistory();
  out.clearedUnsaved = removed;
  out.savedSurvived = remaining.length === 1 && remaining[0].sourceText === "Goodbye";

  await h.clearHistory({ includeSaved: true });
  out.fullyCleared = (await h.getHistory()).length === 0;

  return out;
});

check("translations are recorded", history.count === 2, String(history.count));
check("re-translating the same text does not duplicate", history.afterRepeat === 2, String(history.afterRepeat));
check("a repeat increments its count", history.repeatCount === 2, String(history.repeatCount));
check("a repeat refreshes the translation", history.refreshed === "Hola!", history.refreshed);
check("empty input is ignored", history.emptyIgnored === true);
check("clearing history keeps saved phrases", history.clearedUnsaved === 1 && history.savedSurvived === true, `${history.clearedUnsaved}`);
check("clearing everything clears saved phrases too", history.fullyCleared === true);

// ---- The library UI itself ----

console.log("\nLibrary UI");

const ui = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const docs = await import("/js/documents.js");
  const library = await import("/js/library.js");
  const views = await import("/js/views.js");
  await store.clearAll();

  for (const title of ["Alpha note", "Beta scan", "Gamma note"]) {
    const doc = await docs.createDocument({
      type: title.includes("scan") ? docs.DOC_TYPES.SCAN : docs.DOC_TYPES.NOTE,
      title,
    });
    await docs.updateDocumentQuietly(doc.id, { searchText: `${title} contents here` });
  }

  views.showView("library", {}, { push: false });
  await library.renderLibrary();

  const out = {};
  out.cardCount = document.querySelectorAll("#library-list .doc-card").length;
  out.hasSidebar = document.querySelectorAll("#library-sidebar .library-nav__item").length > 0;
  out.countLabel = document.getElementById("library-count").textContent;

  // XSS: a title containing markup must render as text, not as elements.
  const nasty = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: '<img src=x onerror="window.__pwned=1">' });
  await docs.updateDocumentQuietly(nasty.id, { searchText: "<script>window.__pwned2=1</script>" });
  await library.renderLibrary();
  out.injectedImages = document.querySelectorAll("#library-list img").length;
  out.injectedScripts = document.querySelectorAll("#library-list script").length;
  out.pwned = !!window.__pwned || !!window.__pwned2;
  out.titleRenderedAsText = [...document.querySelectorAll(".doc-card__title")].some((el) =>
    el.textContent.includes("<img")
  );

  return out;
});

check("cards render for every document", ui.cardCount === 3, String(ui.cardCount));
check("the sidebar renders", ui.hasSidebar === true);
check("the count label is shown", /3 documents/.test(ui.countLabel), ui.countLabel);
check("a title containing markup injects no elements", ui.injectedImages === 0 && ui.injectedScripts === 0, `${ui.injectedImages}/${ui.injectedScripts}`);
check("no injected script executed", ui.pwned === false);
check("the markup is rendered as visible text instead", ui.titleRenderedAsText === true);

// ---- Note sanitization ----

console.log("\nNote sanitization");

const sanitize = await page.evaluate(async () => {
  const { sanitizeHtml } = await import("/js/notesEditor.js");
  return {
    script: sanitizeHtml('<p>ok</p><script>alert(1)</script>'),
    onerror: sanitizeHtml('<img src="x" onerror="alert(1)">'),
    javascriptHref: sanitizeHtml('<a href="javascript:alert(1)">click</a>'),
    safeHref: sanitizeHtml('<a href="https://example.com">click</a>'),
    styleStripped: sanitizeHtml('<p style="color:red">text</p>'),
    unknownUnwrapped: sanitizeHtml("<marquee>keep this text</marquee>"),
    iframe: sanitizeHtml('<iframe src="https://evil.test"></iframe>'),
    checklistKept: sanitizeHtml('<ul data-checklist=""><li data-checked="true">done</li></ul>'),
  };
});

check("<script> is removed entirely", !/script/i.test(sanitize.script) && /ok/.test(sanitize.script), sanitize.script);
check("event handlers are stripped", !/onerror/i.test(sanitize.onerror), sanitize.onerror);
check("javascript: links are stripped", !/javascript:/i.test(sanitize.javascriptHref), sanitize.javascriptHref);
check("safe links survive and gain rel=noopener", /example\.com/.test(sanitize.safeHref) && /noopener/.test(sanitize.safeHref), sanitize.safeHref);
check("inline styles are stripped", !/style=/i.test(sanitize.styleStripped) && /text/.test(sanitize.styleStripped), sanitize.styleStripped);
check("unknown tags are unwrapped, keeping their text", !/marquee/i.test(sanitize.unknownUnwrapped) && /keep this text/.test(sanitize.unknownUnwrapped), sanitize.unknownUnwrapped);
check("<iframe> is removed", !/iframe/i.test(sanitize.iframe), sanitize.iframe);
check("checklist markup round-trips", /data-checklist/.test(sanitize.checklistKept) && /data-checked/.test(sanitize.checklistKept), sanitize.checklistKept);

// ---- Done ----

await page.evaluate(async () => {
  const store = await import("/js/store.js");
  await store.clearAll();
});

await browser.close();
server.close();

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nLibrary, documents, filters, edge detection, annotations, history and sanitization all pass.");
