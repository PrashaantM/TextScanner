// documents.js: the document model, and every operation that changes one.
//
// Two document types share one model, deliberately:
//
//   note   rich text, optional inline attachments. The Notes-app side.
//   scan   an ordered list of pages, each a captured image with its own filter,
//          crop and OCR result. The CamScanner side.
//
// They share a model because everything *around* a document is identical -
// titles, folders, tags, pinning, search, trash, export - and duplicating that
// for two nearly-identical shapes is how a library ends up with two half-working
// search implementations. What differs is the body: a note has `body`, a scan
// has `pageIds`. Nothing else branches on type except the editor that opens it.
//
// A scan's OCR text is mirrored into `searchText` on the document record so
// search never has to open pages or blobs. That denormalization is the whole
// reason search over 500 scanned pages can run on a phone: the index is a few
// hundred KB of text in the same store the library already reads.
//
// Deletion is two-stage. `deletedAt` moves a document to Recently Deleted and
// nothing is destroyed; `purge` is what actually frees blobs. That matters more
// here than in a typical notes app because a scan's pages are megabytes each -
// an undo that could not restore them would be a lie.

import {
  STORES,
  newId,
  get,
  getAll,
  put,
  putMany,
  remove,
  getAllByIndex,
  putBlob,
  removeBlob,
} from "./store.js";

export const DOC_TYPES = { NOTE: "note", SCAN: "scan" };

// How long a document stays in Recently Deleted before it is eligible for
// purging. Matches the convention people already expect from Notes and Photos.
export const TRASH_RETENTION_DAYS = 30;

// ---- Creation ----

export function createDocumentRecord({ type, title = "", folderId = null, tags = [] } = {}) {
  const now = Date.now();
  return {
    id: newId("doc"),
    type: type === DOC_TYPES.SCAN ? DOC_TYPES.SCAN : DOC_TYPES.NOTE,
    title,
    folderId,
    tags: [...tags],
    pinned: false,
    locked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    // Notes only. HTML, produced by the note editor's contenteditable surface
    // and sanitized on the way in - see js/notesEditor.js.
    body: "",
    // Scans only. Ordered; this array IS the page order, rather than a sort key
    // on each page, so reordering is one write instead of N.
    pageIds: [],
    // Denormalized plaintext for search. Notes: the body stripped of markup.
    // Scans: every page's recognized text, concatenated.
    searchText: "",
    // Key into the blobs store for the library thumbnail.
    thumbKey: null,
    // A scan remembers the last filter used so the next page in the same
    // document defaults to matching its siblings, which is what makes a
    // multi-page scan look like one document rather than a pile.
    defaultFilter: "auto",
  };
}

export async function createDocument(options) {
  const doc = createDocumentRecord(options);
  await put(STORES.DOCUMENTS, doc);
  return doc;
}

export async function getDocument(id) {
  return get(STORES.DOCUMENTS, id);
}

export async function getAllDocuments() {
  return getAll(STORES.DOCUMENTS);
}

// The single write path for a document. Everything goes through here so
// `updatedAt` cannot be forgotten - a library sorted by "recently edited" is
// only as good as the least careful call site that touched a title.
export async function updateDocument(id, changes) {
  const existing = await getDocument(id);
  if (!existing) throw new Error("That document no longer exists.");
  const updated = { ...existing, ...changes, id: existing.id, updatedAt: Date.now() };
  await put(STORES.DOCUMENTS, updated);
  return updated;
}

// `touch: false` exists for changes a person did not make - a background
// re-index, a thumbnail regeneration. Bumping updatedAt for those would
// reshuffle the library for reasons invisible to the person reading it.
export async function updateDocumentQuietly(id, changes) {
  const existing = await getDocument(id);
  if (!existing) return null;
  const updated = { ...existing, ...changes, id: existing.id };
  await put(STORES.DOCUMENTS, updated);
  return updated;
}

// ---- Pages (scan documents) ----

export function createPageRecord({ docId, blobKey, order = 0 }) {
  return {
    id: newId("page"),
    docId,
    order,
    // Full-resolution processed image - what export and re-OCR read.
    blobKey,
    // The untouched capture, kept so a filter or crop can always be redone from
    // source rather than compounding on an already-processed image. This is the
    // difference between "change the filter" and "change the filter and lose a
    // little more of the image every time".
    originalBlobKey: blobKey,
    thumbKey: null,
    filter: "auto",
    rotation: 0,
    // Four {x, y} corners in ORIGINAL-image pixel space, or null for no crop.
    corners: null,
    // Recognition result for this page, in the same flat shape js/recognize.js
    // returns everywhere else in the app.
    words: [],
    text: "",
    // Freehand annotation strokes (signatures, markup) - see js/annotate.js.
    annotations: [],
    width: 0,
    height: 0,
    createdAt: Date.now(),
  };
}

export async function getPage(id) {
  return get(STORES.PAGES, id);
}

// Returns pages in the document's declared order. The `order` field on each
// page is maintained too, but `doc.pageIds` is authoritative - a page whose
// record survived a failed delete would otherwise reappear in the middle of a
// document.
export async function getPagesForDocument(doc) {
  if (!doc || doc.type !== DOC_TYPES.SCAN) return [];
  const pages = await getAllByIndex(STORES.PAGES, "docId", doc.id);
  const byId = new Map(pages.map((p) => [p.id, p]));
  return (doc.pageIds || []).map((id) => byId.get(id)).filter(Boolean);
}

export async function addPage(docId, { blob, width, height, filter }) {
  const doc = await getDocument(docId);
  if (!doc) throw new Error("That document no longer exists.");

  const blobKey = await putBlob(blob);
  const page = createPageRecord({ docId, blobKey, order: (doc.pageIds || []).length });
  page.width = width || 0;
  page.height = height || 0;
  page.filter = filter || doc.defaultFilter || "auto";

  await put(STORES.PAGES, page);
  await updateDocument(docId, { pageIds: [...(doc.pageIds || []), page.id] });
  return page;
}

export async function updatePage(id, changes) {
  const existing = await getPage(id);
  if (!existing) throw new Error("That page no longer exists.");
  const updated = { ...existing, ...changes, id: existing.id };
  await put(STORES.PAGES, updated);
  // A page's text is part of its document's search index.
  if ("text" in changes || "words" in changes) await reindexDocument(existing.docId);
  return updated;
}

export async function deletePage(docId, pageId) {
  const doc = await getDocument(docId);
  const page = await getPage(pageId);
  if (!doc || !page) return;

  // Blobs first: if this throws, the page record still points at them and the
  // next attempt can retry. Removing the record first would orphan the bytes
  // with nothing left pointing at them to clean up.
  await removeBlob(page.blobKey);
  if (page.originalBlobKey && page.originalBlobKey !== page.blobKey) await removeBlob(page.originalBlobKey);
  if (page.thumbKey) await removeBlob(page.thumbKey);
  await remove(STORES.PAGES, pageId);

  const pageIds = (doc.pageIds || []).filter((id) => id !== pageId);
  await updateDocument(docId, { pageIds });
  await reindexDocument(docId);
}

// Reorder is a single write to the document, not N writes to pages, because
// `doc.pageIds` is the order. The per-page `order` field is refreshed to match
// so anything reading a page in isolation still sees the truth.
export async function reorderPages(docId, orderedPageIds) {
  const doc = await getDocument(docId);
  if (!doc) return null;

  const known = new Set(doc.pageIds || []);
  const next = orderedPageIds.filter((id) => known.has(id));
  // Anything the caller forgot keeps its relative position at the end rather
  // than vanishing - a reorder must never be able to delete a page.
  for (const id of doc.pageIds || []) if (!next.includes(id)) next.push(id);

  const pages = await getAllByIndex(STORES.PAGES, "docId", docId);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const renumbered = next.map((id, index) => ({ ...byId.get(id), order: index })).filter((p) => p.id);
  if (renumbered.length) await putMany(STORES.PAGES, renumbered);

  return updateDocument(docId, { pageIds: next });
}

// ---- Search index ----

export function stripMarkup(html) {
  if (!html) return "";

  // A <template> parses the markup completely inertly - nothing in it loads,
  // runs, or lays out, and it is never attached to the document.
  const template = document.createElement("template");
  template.innerHTML = html;

  // Block elements imply a boundary that textContent does not represent. Without
  // this, "<li>Oat milk</li><li>Bread</li>" extracts as "Oat milkBread" - which
  // corrupts the search index, the card excerpt, the word count and the derived
  // title all at once, and is invisible until you read one.
  const BLOCK_SELECTOR = "p,div,br,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr,section,article,header,footer";
  for (const el of template.content.querySelectorAll(BLOCK_SELECTOR)) {
    el.after(document.createTextNode("\n"));
  }

  return (template.content.textContent || "")
    // Collapse runs of horizontal whitespace, but keep the line breaks just
    // inserted - deriveTitle splits on them to find a first line.
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function reindexDocument(docId) {
  const doc = await getDocument(docId);
  if (!doc) return null;

  let searchText = "";
  if (doc.type === DOC_TYPES.NOTE) {
    searchText = stripMarkup(doc.body);
  } else {
    const pages = await getPagesForDocument(doc);
    searchText = pages
      .map((p) => p.text || "")
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
  }

  return updateDocumentQuietly(docId, { searchText });
}

// ---- Titles ----
//
// A document should never show as "Untitled" when it plainly has a first line
// that reads like a title. Notes derives it from the body, a scan from its first
// page's first line of recognized text - both matching what the person would
// have typed anyway.
export function deriveTitle(doc, fallbackText = "") {
  if (doc.title && doc.title.trim()) return doc.title.trim();

  const source = doc.type === DOC_TYPES.NOTE ? stripMarkup(doc.body) : doc.searchText || fallbackText;
  const firstLine = (source || "").split(/[\n.!?]/)[0].trim();
  if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;

  return doc.type === DOC_TYPES.SCAN ? "Untitled scan" : "Untitled note";
}

// ---- Trash ----

export async function trashDocument(id) {
  return updateDocument(id, { deletedAt: Date.now() });
}

export async function restoreDocument(id) {
  return updateDocument(id, { deletedAt: null });
}

// The only function that actually destroys anything. Named `purge` rather than
// `delete` so no call site can reach it thinking it is the reversible one.
export async function purgeDocument(id) {
  const doc = await getDocument(id);
  if (!doc) return;

  if (doc.type === DOC_TYPES.SCAN) {
    const pages = await getAllByIndex(STORES.PAGES, "docId", id);
    for (const page of pages) {
      await removeBlob(page.blobKey);
      if (page.originalBlobKey && page.originalBlobKey !== page.blobKey) await removeBlob(page.originalBlobKey);
      if (page.thumbKey) await removeBlob(page.thumbKey);
      await remove(STORES.PAGES, page.id);
    }
  }

  if (doc.thumbKey) await removeBlob(doc.thumbKey);
  await remove(STORES.DOCUMENTS, id);
}

export async function purgeExpiredTrash(retentionDays = TRASH_RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const docs = await getAllDocuments();
  const expired = docs.filter((d) => d.deletedAt && d.deletedAt < cutoff);
  for (const doc of expired) await purgeDocument(doc.id);
  return expired.length;
}

export async function emptyTrash() {
  const docs = await getAllDocuments();
  const trashed = docs.filter((d) => d.deletedAt);
  for (const doc of trashed) await purgeDocument(doc.id);
  return trashed.length;
}

// ---- Folders ----

export async function createFolder(name) {
  const folder = { id: newId("folder"), name: name.trim() || "New folder", createdAt: Date.now() };
  await put(STORES.FOLDERS, folder);
  return folder;
}

export async function getFolders() {
  const folders = await getAll(STORES.FOLDERS);
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

export async function renameFolder(id, name) {
  const folder = await get(STORES.FOLDERS, id);
  if (!folder) return null;
  const updated = { ...folder, name: name.trim() || folder.name };
  await put(STORES.FOLDERS, updated);
  return updated;
}

// Deleting a folder must not delete what is in it. Documents move back to the
// top level - the alternative silently destroys work because someone tidied up.
export async function deleteFolder(id) {
  const docs = await getAllByIndex(STORES.DOCUMENTS, "folderId", id);
  for (const doc of docs) await updateDocumentQuietly(doc.id, { folderId: null });
  await remove(STORES.FOLDERS, id);
  return docs.length;
}

// ---- Tags ----

export async function getAllTags() {
  const docs = await getAllDocuments();
  const counts = new Map();
  for (const doc of docs) {
    if (doc.deletedAt) continue;
    for (const tag of doc.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function normalizeTag(raw) {
  return (raw || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 32);
}

export async function addTag(docId, rawTag) {
  const tag = normalizeTag(rawTag);
  if (!tag) return null;
  const doc = await getDocument(docId);
  if (!doc) return null;
  if ((doc.tags || []).includes(tag)) return doc;
  return updateDocument(docId, { tags: [...(doc.tags || []), tag] });
}

export async function removeTag(docId, tag) {
  const doc = await getDocument(docId);
  if (!doc) return null;
  return updateDocument(docId, { tags: (doc.tags || []).filter((t) => t !== tag) });
}

// ---- Query ----
//
// One function serves the whole library: folder, tag, search, trash and pin are
// all filters over the same list, applied in an order chosen so the cheapest
// discriminator runs first.
export function queryDocuments(docs, { search = "", folderId = undefined, tag = null, trash = false, type = null } = {}) {
  const needle = search.trim().toLowerCase();

  let out = docs.filter((doc) => (trash ? !!doc.deletedAt : !doc.deletedAt));

  if (folderId !== undefined) out = out.filter((doc) => (doc.folderId || null) === folderId);
  if (tag) out = out.filter((doc) => (doc.tags || []).includes(tag));
  if (type) out = out.filter((doc) => doc.type === type);

  if (needle) {
    out = out.filter((doc) => {
      const title = deriveTitle(doc).toLowerCase();
      if (title.includes(needle)) return true;
      if ((doc.searchText || "").toLowerCase().includes(needle)) return true;
      return (doc.tags || []).some((t) => t.includes(needle));
    });
  }

  // Pinned first, then most-recently-updated. Within the trash, sort by when it
  // was deleted instead - "what did I just throw away" is the only question that
  // view answers.
  return out.sort((a, b) => {
    if (trash) return (b.deletedAt || 0) - (a.deletedAt || 0);
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

// Returns a short excerpt around the first match, so a search result shows WHY
// it matched rather than just its first 100 characters. On a scanned document
// the match is usually deep inside a page of text, where the opening line tells
// you nothing.
export function searchExcerpt(doc, search, radius = 60) {
  const text = doc.searchText || "";
  if (!text) return "";
  const needle = search.trim().toLowerCase();
  if (!needle) return text.slice(0, radius * 2);

  const index = text.toLowerCase().indexOf(needle);
  if (index === -1) return text.slice(0, radius * 2);

  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}
