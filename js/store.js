// store.js: the persistence layer. Everything the app remembers between
// launches lives here, on the device - the bulk of it in IndexedDB, plus the
// short list of localStorage keys inventoried below, which this module owns the
// NAMES of precisely so that clearAll() can be honest about clearing them.
//
// Why IndexedDB and not localStorage: this app now stores documents made of
// full-resolution page images. localStorage is a synchronous string store with
// a ~5 MB origin quota - a single phone photo blows through that, and doing it
// synchronously on the main thread would jank every save. IndexedDB stores Blobs
// natively (no base64 round-trip, which inflates by ~33% and costs a full
// encode/decode per access), is asynchronous, and has a quota measured in
// hundreds of megabytes to a percentage of free disk.
//
// The schema is deliberately split so that a Blob is never loaded just because
// something needed a title:
//
//   documents   metadata only - title, folder, tags, dates. Small, listed often.
//   pages       per-page metadata for scans - order, filter, OCR result, corners.
//   blobs       the actual image bytes, keyed by an opaque id. Loaded on demand.
//   folders     user-created folders.
//   settings    key/value app state that isn't a document.
//   history     translation history (see js/translateHistory.js).
//
// The library view reads `documents` and never touches `blobs` except for
// thumbnails, which are stored as their own small blob entries. That is the
// difference between a library that opens instantly with 500 documents and one
// that tries to decode 500 full-resolution photos to draw a list.
//
// Everything here is device-local. Nothing in this file talks to a network, and
// there is no sync, no account and no server - which is the same promise the
// rest of the app makes, extended to storage.

const DB_NAME = "textscanner";
const DB_VERSION = 1;

const STORE_DOCUMENTS = "documents";
const STORE_PAGES = "pages";
const STORE_BLOBS = "blobs";
const STORE_FOLDERS = "folders";
const STORE_SETTINGS = "settings";
const STORE_HISTORY = "history";

// ---- localStorage inventory ----
//
// IndexedDB holds the documents; these three keys are everything else the app
// persists. They live here rather than in the modules that use them for one
// reason: clearAll() below promises to delete all local data, and a promise
// like that cannot be kept from a module that does not know what "all" is.
// The owning modules import these names from here, so there is one definition
// and it cannot drift from what gets cleared.
//
// The API key is the one that matters. It is a secret, it is readable by anyone
// with this browser profile, and on the shared github.io origin it is readable
// by any other site on that origin too (see docs/PRIVACY-DECISIONS.md). Someone
// who presses "Delete all local data" on a shared machine and is told "All local
// data deleted." must not be leaving their Anthropic key behind.
export const LOCAL_KEY_ANTHROPIC_API = "textscanner.anthropicApiKey";
// The theme choice and the command palette's usage counts are not secrets, but
// they are still things this device remembers about the person using it, and the
// alert says ALL. Clearing them costs a re-pick of light/dark on an action that
// was double-confirmed as "delete everything"; leaving them would make the copy
// a half-truth, which is the thing this list exists to prevent.
export const LOCAL_KEY_THEME = "textscanner.theme";
export const LOCAL_KEY_COMMAND_FRECENCY = "textscanner.command-frecency";

const CLEARABLE_LOCAL_KEYS = [LOCAL_KEY_ANTHROPIC_API, LOCAL_KEY_THEME, LOCAL_KEY_COMMAND_FRECENCY];

export const STORES = {
  DOCUMENTS: STORE_DOCUMENTS,
  PAGES: STORE_PAGES,
  BLOBS: STORE_BLOBS,
  FOLDERS: STORE_FOLDERS,
  SETTINGS: STORE_SETTINGS,
  HISTORY: STORE_HISTORY,
};

let dbPromise = null;

// A crypto-random id. Date.now() alone collides when two documents are created
// in the same millisecond, which a batch import does routinely.
export function newId(prefix = "id") {
  const bytes = new Uint8Array(8);
  (globalThis.crypto || {}).getRandomValues?.(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;

      // Version 1. Each `if` guards on existence rather than on the old version
      // number, so a database left half-created by an interrupted upgrade
      // finishes rather than throwing ConstraintError on the next launch.
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        const docs = db.createObjectStore(STORE_DOCUMENTS, { keyPath: "id" });
        // updatedAt drives the default library sort; folderId and deletedAt
        // drive its two filters. Indexing them means the library never reads
        // every document to show one folder.
        docs.createIndex("updatedAt", "updatedAt");
        docs.createIndex("folderId", "folderId");
        docs.createIndex("deletedAt", "deletedAt");
        docs.createIndex("type", "type");
      }

      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const pages = db.createObjectStore(STORE_PAGES, { keyPath: "id" });
        pages.createIndex("docId", "docId");
      }

      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const history = db.createObjectStore(STORE_HISTORY, { keyPath: "id" });
        history.createIndex("createdAt", "createdAt");
      }

      if (tx) tx.onerror = () => reject(tx.error);
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab opened a newer version. Close this handle rather than
      // holding the upgrade hostage - the open one keeps working until reload.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(request.error || new Error("Couldn't open local storage."));
    request.onblocked = () =>
      reject(new Error("Local storage is blocked by another open tab. Close TextScanner's other tabs and reload."));
  });

  // A failed open must not be cached forever - a private-browsing window or a
  // storage-disabled browser should get a fresh attempt next time rather than
  // a permanently poisoned promise.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

// Wraps one IDB request in a promise. IndexedDB's event API predates promises
// and every call site would otherwise repeat this six-line dance.
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Runs `fn` inside a transaction and resolves once the transaction COMMITS,
// not merely once the last request succeeds. That distinction matters: a
// request can succeed and the transaction still abort (quota, constraint), and
// resolving early would report a save that never landed.
async function withTransaction(storeNames, mode, fn) {
  const db = await openDatabase();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (err) {
      reject(err);
      return;
    }

    let result;
    let failed = false;

    tx.oncomplete = () => {
      if (!failed) resolve(result);
    };
    tx.onerror = () => {
      failed = true;
      reject(tx.error || new Error("The change couldn't be saved."));
    };
    tx.onabort = () => {
      failed = true;
      reject(tx.error || new Error("The change was rolled back."));
    };

    const stores = names.map((name) => tx.objectStore(name));
    Promise.resolve(fn(names.length === 1 ? stores[0] : stores, tx))
      .then((value) => {
        result = value;
      })
      .catch((err) => {
        failed = true;
        try {
          tx.abort();
        } catch {
          // Already aborting or finished; the rejection below is what matters.
        }
        reject(err);
      });
  });
}

// ---- Generic record access ----

export async function get(storeName, key) {
  return withTransaction(storeName, "readonly", (store) => promisifyRequest(store.get(key)));
}

export async function getAll(storeName) {
  return withTransaction(storeName, "readonly", (store) => promisifyRequest(store.getAll()));
}

export async function put(storeName, value) {
  return withTransaction(storeName, "readwrite", async (store) => {
    await promisifyRequest(store.put(value));
    return value;
  });
}

export async function putMany(storeName, values) {
  return withTransaction(storeName, "readwrite", async (store) => {
    for (const value of values) await promisifyRequest(store.put(value));
    return values;
  });
}

export async function remove(storeName, key) {
  return withTransaction(storeName, "readwrite", (store) => promisifyRequest(store.delete(key)));
}

// Reads every record whose `indexName` equals `value`. Used for "pages of this
// document" and "documents in this folder", both of which would otherwise be a
// full-store scan.
export async function getAllByIndex(storeName, indexName, value) {
  return withTransaction(storeName, "readonly", (store) =>
    promisifyRequest(store.index(indexName).getAll(value))
  );
}

// ---- Blobs ----
//
// Kept behind their own functions rather than exposed as a raw store, because
// blob lifetime is the one thing in here that leaks real memory if handled
// casually: every object URL created from one must be revoked, and the only way
// to keep that honest is to have a single place that hands them out.

export async function putBlob(blob, key = newId("blob")) {
  await put(STORE_BLOBS, { key, blob, size: blob.size, type: blob.type, createdAt: Date.now() });
  return key;
}

export async function getBlob(key) {
  if (!key) return null;
  const record = await get(STORE_BLOBS, key);
  return record ? record.blob : null;
}

export async function removeBlob(key) {
  if (!key) return;
  await remove(STORE_BLOBS, key);
}

// ---- Destroyed-blob tombstones ----
//
// A tombstone is the record that a blob was deliberately DESTROYED, as opposed
// to merely deleted. Deleting a page removes its bytes because nothing needs
// them any more; destroying a redacted page's original removes bytes that the
// person using the app asked never to exist here again (js/annotate.js). Those
// are different promises, and only the second one has to survive.
//
// It has to survive because of restore. js/backup.js's importer adds any blob
// whose key it does not already hold - that is exactly what makes restoring a
// backup work - and a backup taken BEFORE a destruction still contains the
// destroyed original. Without a tombstone, restoring it writes those bytes
// straight back into this device's blob store, where nothing displays them and
// nothing will ever delete them, because the page record that used to point at
// them no longer does. A destruction that a later restore silently undoes is
// not a destruction.
//
// Only the KEY is kept: an opaque random id (see newId), with no title, no
// document, no date-of-capture and nothing derived from the image. The list is
// small - one short string per destroyed original.
//
// NOTE, found while adding this and deliberately not changed here: clearAll()
// below does not include STORE_SETTINGS in its transaction, so "Delete all
// local data" leaves this list behind. For the tombstone that is the safe
// direction to be wrong in - the guarantee outlives the wipe - and after a wipe
// there is no page left for a restore to attach resurrected bytes to anyway.
// It is still a gap between that button's copy and what it clears, and it
// belongs to that button rather than to this feature.
export const SETTING_DESTROYED_BLOBS = "destroyedBlobKeys";

export async function getDestroyedBlobKeys() {
  const stored = await getSetting(SETTING_DESTROYED_BLOBS, []);
  return new Set(Array.isArray(stored) ? stored : []);
}

// Records the tombstone and returns the full set. Call this BEFORE removeBlob:
// a crash between the two leaves bytes that are tombstoned but still present,
// which the next destruction pass can finish and which import already refuses -
// whereas the other order leaves bytes that are gone but resurrectable.
export async function tombstoneBlob(key) {
  if (!key) return await getDestroyedBlobKeys();
  const keys = await getDestroyedBlobKeys();
  if (!keys.has(key)) {
    keys.add(key);
    await setSetting(SETTING_DESTROYED_BLOBS, [...keys]);
  }
  return keys;
}

// Merges tombstones carried in from a backup file. A backup taken AFTER a
// destruction carries that destruction's tombstone, so restoring it onto a
// second device honours the destruction there too.
export async function mergeDestroyedBlobKeys(incoming) {
  const keys = await getDestroyedBlobKeys();
  let added = 0;
  for (const key of incoming || []) {
    if (typeof key === "string" && key && !keys.has(key)) {
      keys.add(key);
      added += 1;
    }
  }
  if (added) await setSetting(SETTING_DESTROYED_BLOBS, [...keys]);
  return keys;
}

// Object URLs created here are tracked so a view teardown can release them all
// at once. An untracked createObjectURL on a 4 MB photo holds that 4 MB until
// the page unloads, and a library scrolled through a few times leaks tens of
// megabytes without a single visible symptom.
const liveObjectUrls = new Set();

export async function getBlobUrl(key) {
  const blob = await getBlob(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  liveObjectUrls.add(url);
  return url;
}

export function releaseObjectUrl(url) {
  if (!url || !liveObjectUrls.has(url)) return;
  URL.revokeObjectURL(url);
  liveObjectUrls.delete(url);
}

export function releaseAllObjectUrls() {
  for (const url of liveObjectUrls) URL.revokeObjectURL(url);
  liveObjectUrls.clear();
}

// ---- Settings ----

export async function getSetting(key, fallback = null) {
  const record = await get(STORE_SETTINGS, key);
  return record === undefined || record === null ? fallback : record.value;
}

export async function setSetting(key, value) {
  await put(STORE_SETTINGS, { key, value });
  return value;
}

// ---- Storage estimate ----
//
// Surfaced in Settings so a person can see what the app is actually using
// before it becomes a problem, rather than discovering it when a save fails.
export async function estimateStorage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return {
      usage: usage || 0,
      quota: quota || 0,
      percent: quota ? Math.min(100, (usage / quota) * 100) : 0,
    };
  } catch {
    return null;
  }
}

// Asks the browser to make this origin's storage persistent, so it survives
// automatic eviction under storage pressure. Best-effort and non-blocking:
// browsers grant it on their own criteria (installed PWA, engagement) and may
// simply say no. A refusal is not an error worth showing anyone - the data is
// still there, it is just evictable.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// Reports whether the browser has ALREADY granted persistent storage, without
// asking for it. requestPersistence() above prompts or silently decides; this
// only observes, so Settings can tell someone the truth about their situation on
// every render rather than triggering a permission decision each time they look.
//
// Returns null - not false - where the browser does not implement the API at
// all. "It hasn't granted persistence" and "it won't say" need different copy:
// the first has a remedy, the second only has "back up".
export async function isPersisted() {
  if (!navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

// ---- Availability ----
//
// Storage can be unavailable outright: Safari private browsing, a browser with
// site data blocked, or a WebView with a broken profile. The app must degrade to
// a working single-document session rather than show an error wall, so callers
// check this once and switch to in-memory mode if it fails.
let availabilityPromise = null;

export function isAvailable() {
  if (!availabilityPromise) {
    availabilityPromise = (async () => {
      if (typeof indexedDB === "undefined") return false;
      try {
        await openDatabase();
        return true;
      } catch {
        return false;
      }
    })();
  }
  return availabilityPromise;
}

// Exported for tests and for the Settings "delete everything" action, which
// must remove image bytes rather than just unlinking documents from a list.
export async function clearAll() {
  releaseAllObjectUrls();

  // localStorage first, and deliberately so: it is synchronous and cannot fail
  // in a way worth aborting over, whereas the transaction below can. Clearing
  // the secret before the bulk data means an interrupted wipe leaves documents
  // behind rather than a key.
  for (const key of CLEARABLE_LOCAL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Private browsing or storage disabled - there was nothing stored to
      // clear, so there is nothing to report.
    }
  }

  return withTransaction(
    [STORE_DOCUMENTS, STORE_PAGES, STORE_BLOBS, STORE_FOLDERS, STORE_HISTORY],
    "readwrite",
    async (stores) => {
      for (const store of stores) await promisifyRequest(store.clear());
    }
  );
}
