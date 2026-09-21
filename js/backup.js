// backup.js: exports the whole library to one file, and reads it back.
//
// WHY THIS EXISTS. The app has no server, no sync and no account - that is the
// product, not an omission. The consequence is that the browser's storage is the
// only copy, and browsers delete storage. Safari's ITP purges all
// script-writable storage, IndexedDB included, after 7 days without a visit to
// the site, for any site that is not installed to the home screen. A scan taken
// today can simply be gone next week with nothing to restore it from. Until this
// file, the app could export ONE document as a PDF and had no way at all to get
// the library out.
//
// FORMAT: a single JSON file with page images base64-encoded inline.
//
// Not a zip, and that is a decision rather than laziness. A zip needs a vendored
// compression library in a project that has refused heavy dependencies
// throughout - the PDF writer is hand-written for exactly this reason
// (ANALYSIS.md §8.4) - and the payload is already-compressed JPEG, so a zip
// container would save almost nothing on the bytes that matter. base64 inflates
// blobs by about a third; that is the accepted, stated cost of a format that
// needs no code to read, can be inspected in any text editor, and cannot break
// because a library changed.
//
// WHAT IS DELIBERATELY NOT IN IT: the Anthropic API key.
//
// A library backup is precisely the file someone emails themselves, drops in
// iCloud, or hands to another device. A key bundled into it is the same leak
// that "Delete all local data" used to have (js/store.js's localStorage
// inventory, added when clearAll stopped leaving the key behind) - just with a
// wider blast radius, because this file is meant to travel. So the export walks
// the four document stores and nothing else: no credentials, no preferences.
// test/backup-roundtrip.js asserts that with a canary key, by searching the
// serialized text for it.
//
// The one thing outside those four stores that IS in the file is
// `destroyedBlobKeys` - the list of originals a redaction destroyed (see
// js/store.js). It is in here for the opposite reason the key is not: it exists
// to stop this file putting bytes BACK that someone deleted on purpose, and a
// list of opaque ids that name nothing present is the smallest thing that can
// carry that promise to another device.

import {
  STORES,
  getAll,
  put,
  putBlob,
  getBlob,
  getDestroyedBlobKeys,
  mergeDestroyedBlobKeys,
} from "./store.js";
import { getAllDocuments, getFolders } from "./documents.js";

// Bumped only for a change that an older importer could not read correctly.
// import() refuses anything newer than it understands rather than guessing.
const BACKUP_VERSION = 1;
const BACKUP_KIND = "textscanner-backup";

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL gives "data:<type>;base64,<payload>" - the payload is taken
    // and the type stored separately, so the file is not carrying the same
    // information twice.
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

// Every blob key any page record points at, including the originals kept for
// re-filtering and the thumbnails. Collected from the page records themselves
// rather than by exporting the whole blob store, so an orphaned blob from an
// interrupted delete is not carried into the backup.
function blobKeysFor(pages) {
  const keys = new Set();
  for (const page of pages) {
    for (const key of [page.blobKey, page.originalBlobKey, page.thumbKey]) {
      if (key) keys.add(key);
    }
  }
  return keys;
}

export async function exportLibrary({ onProgress } = {}) {
  const documents = await getAllDocuments();
  const pages = await getAll(STORES.PAGES);
  const folders = await getFolders();

  // Document thumbnails live in the blob store too and are referenced from the
  // document record, so they have to be collected alongside the page blobs.
  const keys = blobKeysFor(pages);
  for (const doc of documents) if (doc.thumbKey) keys.add(doc.thumbKey);

  const blobs = [];
  let done = 0;
  for (const key of keys) {
    const blob = await getBlob(key);
    if (!blob) continue; // referenced but missing: skip rather than fail the whole export
    blobs.push({ key, type: blob.type, size: blob.size, data: await blobToBase64(blob) });
    done += 1;
    onProgress?.(done, keys.size);
  }

  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    counts: { documents: documents.length, pages: pages.length, folders: folders.length, blobs: blobs.length },
    documents,
    pages,
    folders,
    blobs,
    // Destroyed-original tombstones (js/store.js). Carried so that a backup
    // made AFTER a redaction destroyed a page's original honours that
    // destruction wherever it is restored, including a device that has never
    // seen the page before. It is a list of opaque blob ids and nothing else -
    // the bytes they name are not in this file, which is the point.
    destroyedBlobKeys: [...(await getDestroyedBlobKeys())],
  };
}

export async function exportLibraryToBlob(options) {
  const backup = await exportLibrary(options);
  return { blob: new Blob([JSON.stringify(backup)], { type: "application/json" }), counts: backup.counts };
}

// Reads a backup back in. MERGES rather than replacing: importing into a
// non-empty library must not silently destroy what is already there, and a
// record that already exists is left alone rather than overwritten, so importing
// the same file twice is a no-op instead of a duplication.
export async function importLibrary(backup, { onProgress } = {}) {
  if (!backup || backup.kind !== BACKUP_KIND) {
    throw new Error("That doesn't look like a TextScanner backup file.");
  }
  if (typeof backup.version !== "number" || backup.version > BACKUP_VERSION) {
    throw new Error(
      `That backup was made by a newer version of TextScanner (format ${backup.version}). Update the app, then import it again.`
    );
  }

  const existingDocs = new Set((await getAllDocuments()).map((d) => d.id));
  const existingPages = new Set((await getAll(STORES.PAGES)).map((p) => p.id));
  const existingFolders = new Set((await getFolders()).map((f) => f.id));

  // Tombstones from this device and from the file, merged before anything is
  // written. A backup taken BEFORE a redaction destroyed a page's original
  // still CONTAINS that original, and the importer's whole job is to add blobs
  // it does not already hold - so without this, restoring an old backup writes
  // the destroyed bytes straight back. This device's own tombstones catch that
  // case; the file's tombstones carry a destruction made here onto a device
  // that has never seen this page.
  //
  // What this cannot do, stated rather than glossed: the backup FILE itself
  // still holds the unredacted bytes, and a file is not something the app can
  // reach. Destroying an original destroys it on this device, not inside copies
  // that were already made.
  const destroyed = await mergeDestroyedBlobKeys(backup.destroyedBlobKeys);

  const added = { documents: 0, pages: 0, folders: 0, blobs: 0 };
  let refused = 0;

  // Blobs first. A page record that lands before its image would, if the import
  // were interrupted, leave a document pointing at bytes that do not exist -
  // which renders as a permanently broken page. This ordering means an
  // interrupted import leaves unreferenced bytes instead, which the next
  // "Delete all local data" clears and which nothing displays.
  let done = 0;
  for (const entry of backup.blobs || []) {
    if (!entry?.key || typeof entry.data !== "string") continue;
    if (destroyed.has(entry.key)) {
      refused += 1;
      done += 1;
      onProgress?.(done, (backup.blobs || []).length);
      continue;
    }
    if (!(await getBlob(entry.key))) {
      await putBlob(base64ToBlob(entry.data, entry.type), entry.key);
      added.blobs += 1;
    }
    done += 1;
    onProgress?.(done, (backup.blobs || []).length);
  }

  for (const folder of backup.folders || []) {
    if (!folder?.id || existingFolders.has(folder.id)) continue;
    await put(STORES.FOLDERS, folder);
    added.folders += 1;
  }
  for (const page of backup.pages || []) {
    if (!page?.id || existingPages.has(page.id)) continue;
    // A page record restored onto a device that never held this page would
    // otherwise arrive still pointing at the destroyed original, and every
    // filter, rotate and crop re-derives from `originalBlobKey` - which would
    // then decode nothing and report the page as unreadable. Point it at its
    // own (redacted) image, exactly as destroyPageOriginal does.
    if (page.originalBlobKey && destroyed.has(page.originalBlobKey)) {
      page = { ...page, originalBlobKey: page.blobKey, originalDestroyedAt: page.originalDestroyedAt || Date.now() };
    }
    await put(STORES.PAGES, page);
    added.pages += 1;
  }
  for (const doc of backup.documents || []) {
    if (!doc?.id || existingDocs.has(doc.id)) continue;
    await put(STORES.DOCUMENTS, doc);
    added.documents += 1;
  }

  added.refusedDestroyed = refused;
  return added;
}

export async function importLibraryFromFile(file, options) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't readable as a TextScanner backup.");
  }
  return importLibrary(parsed, options);
}
