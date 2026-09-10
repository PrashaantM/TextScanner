// app.js: the shell. Boots the store, wires the views together, and owns every
// transition between them.
//
// This exists as its own module rather than as more of js/main.js on purpose.
// main.js owns the *scan flow* - file in, recognition out, editor surface. This
// owns the *application* - what a document is, which view is showing, and how
// the pieces reach each other. Keeping them apart means the scan flow stayed
// exactly as it was (and its ten CI gates with it) while everything around it
// changed.
//
// The one genuinely important integration: **the capture flow feeds the
// document model, and the document model feeds the capture flow.** A page can be
// captured from anywhere and lands in whichever document is currently being
// added to; a document can send you back to capture for another page. That round
// trip is what makes multi-page scanning work at all, and it is coordinated by
// `pendingTarget` below.
//
// Storage may be entirely unavailable - Safari private browsing, a browser with
// site data blocked, a WebView with a broken profile. The app degrades to the
// original single-shot scanner rather than showing an error wall, because
// scanning an image and copying the text out never needed a database.

import { isAvailable, estimateStorage, requestPersistence, clearAll } from "./store.js";
import {
  DOC_TYPES,
  createDocument,
  getDocument,
  deriveTitle,
  purgeExpiredTrash,
  updateDocument,
} from "./documents.js";
import { VIEWS, showView, onViewChange, initRouter, goBack } from "./views.js";
import { initLibrary, renderLibrary, restoreLibraryScroll, formatBytes } from "./library.js";
import { initNotesEditor, openNote, closeNote, insertText as insertNoteText, getCurrentNote } from "./notesEditor.js";
import {
  initScanDoc,
  openScanDoc,
  closeScanDoc,
  renderScanDoc,
  addPageFromCanvas,
  getCurrentScanDoc,
} from "./scanDoc.js";
import { initCropView, openCropForPage, openCropForImage, closeCrop } from "./cropView.js";
import { canvasFromSource } from "./scanFilters.js";
import { detectDocument } from "./edgeDetect.js";
import { clearHistory, historyStats } from "./translateHistory.js";
import { hapticLight, hapticMedium } from "./haptics.js";

let storageReady = false;
// The scan document a captured page should be appended to, if the capture flow
// was entered from one. Null means "capture is standalone".
let pendingTarget = null;

const elements = {};

// ---- Chrome ----

const VIEW_CHROME = {
  [VIEWS.LIBRARY]: { title: "TextScanner", subtitle: "Everything stays on this device", back: false },
  [VIEWS.SCAN]: { title: "Scan", subtitle: "Choose or capture an image", back: true },
  [VIEWS.DOCUMENT]: { title: "Document", subtitle: "", back: true },
  [VIEWS.CROP]: { title: "Adjust edges", subtitle: "Drag the corners to match the page", back: true },
  [VIEWS.SETTINGS]: { title: "Settings", subtitle: "Storage, privacy and diagnostics", back: true },
};

function setChrome(view, { title, subtitle } = {}) {
  const chrome = VIEW_CHROME[view] || VIEW_CHROME[VIEWS.LIBRARY];
  elements.title.textContent = title || chrome.title;
  elements.subtitle.textContent = subtitle ?? chrome.subtitle;
  elements.subtitle.classList.toggle("hidden", !elements.subtitle.textContent);
  elements.back.classList.toggle("hidden", !chrome.back);
}

// ---- Document opening ----

async function openDocument(id) {
  const doc = await getDocument(id);
  if (!doc) {
    // A document can legitimately vanish - deleted in another tab, or a stale
    // deep link. Going back to the library is better than an error.
    showView(VIEWS.LIBRARY, {}, { push: false });
    return;
  }

  const isNote = doc.type === DOC_TYPES.NOTE;
  elements.noteEditor.classList.toggle("hidden", !isNote);
  elements.scanDoc.classList.toggle("hidden", isNote);

  const onChanged = (updated) => {
    setChrome(VIEWS.DOCUMENT, {
      title: deriveTitle(updated || doc),
      subtitle: updated?.type === DOC_TYPES.SCAN ? `${(updated.pageIds || []).length} pages` : "",
    });
  };

  if (isNote) {
    await closeScanDoc();
    await openNote(doc, { onChanged });
  } else {
    await closeNote();
    await openScanDoc(doc, { onChanged });
  }

  setChrome(VIEWS.DOCUMENT, {
    title: deriveTitle(doc),
    subtitle: doc.type === DOC_TYPES.SCAN ? `${(doc.pageIds || []).length} pages` : "",
  });
}

async function createAndOpenNote({ body = "", title = "" } = {}) {
  if (!storageReady) {
    window.alert("This browser isn't allowing local storage, so notes can't be saved. Scanning still works.");
    return null;
  }
  const doc = await createDocument({ type: DOC_TYPES.NOTE, title });
  if (body) await updateDocument(doc.id, { body });
  hapticMedium();
  showView(VIEWS.DOCUMENT, { id: doc.id });
  return doc;
}

async function createAndOpenScan() {
  if (!storageReady) {
    // Without storage there is no document to add pages to, so the capture flow
    // is still useful on its own - just say so instead of failing.
    showView(VIEWS.SCAN);
    return null;
  }
  const doc = await createDocument({ type: DOC_TYPES.SCAN });
  pendingTarget = doc.id;
  hapticMedium();
  showView(VIEWS.SCAN);
  updateScanTargetNote();
  return doc;
}

// Tells the person, on the capture screen, which document a page will join.
// Without it, "Add as document page" is a button with no visible consequence.
async function updateScanTargetNote() {
  if (!elements.scanTargetNote) return;

  if (!pendingTarget) {
    elements.scanTargetNote.classList.add("hidden");
    elements.scanTargetNote.textContent = "";
    return;
  }

  const doc = await getDocument(pendingTarget);
  if (!doc) {
    pendingTarget = null;
    elements.scanTargetNote.classList.add("hidden");
    return;
  }

  const count = (doc.pageIds || []).length;
  elements.scanTargetNote.textContent = count
    ? `Adding to "${deriveTitle(doc)}" - ${count} page${count === 1 ? "" : "s"} so far.`
    : `Adding to "${deriveTitle(doc)}".`;
  elements.scanTargetNote.classList.remove("hidden");
}

// ---- Capture -> page ----
//
// The crop step is offered rather than forced: detection returning corners means
// there is something worth confirming, and detection returning null means there
// is nothing to confirm and the whole frame is the honest default.
async function addCurrentImageAsPage(previewImg) {
  if (!storageReady) {
    window.alert("This browser isn't allowing local storage, so multi-page documents aren't available here.");
    return;
  }

  if (!previewImg?.naturalWidth) return;

  let targetId = pendingTarget;
  if (!targetId) {
    const doc = await createDocument({ type: DOC_TYPES.SCAN });
    targetId = doc.id;
    pendingTarget = doc.id;
  }

  const detected = detectDocument(previewImg);

  const commit = async (corners) => {
    const doc = await getDocument(targetId);
    if (!doc) return;

    await openScanDoc(doc, {});
    const canvas = canvasFromSource(previewImg);
    await addPageFromCanvas(canvas, { corners: corners || null });

    hapticMedium();
    showView(VIEWS.DOCUMENT, { id: targetId });
    await openDocument(targetId);
  };

  if (detected) {
    // Straight into the crop screen with the detection pre-loaded, so the
    // person confirms or corrects rather than starting from scratch.
    showView(VIEWS.CROP, { id: targetId });
    await openCropForImage(previewImg, async (corners) => {
      // `undefined` means cancelled - keep the page, uncropped.
      await commit(corners === undefined ? null : corners);
    });
    return;
  }

  await commit(null);
}

// ---- Settings ----

async function renderSettings() {
  const estimate = await estimateStorage();
  if (estimate) {
    elements.storage.textContent = `${formatBytes(estimate.usage)} used of about ${formatBytes(estimate.quota)} available`;
    elements.storageFill.style.width = `${Math.max(1, Math.min(100, estimate.percent))}%`;
  } else {
    elements.storage.textContent = "This browser doesn't report a storage estimate.";
    elements.storageFill.style.width = "0%";
  }

  const stats = await historyStats();
  elements.historyStats.textContent = stats.total
    ? `${stats.total} translation${stats.total === 1 ? "" : "s"} remembered, ${stats.saved} saved`
    : "No translations recorded yet.";
}

// ---- Init ----

export async function initApp() {
  Object.assign(elements, {
    title: document.getElementById("app-title"),
    subtitle: document.getElementById("app-subtitle"),
    back: document.getElementById("app-back"),
    navLibrary: document.getElementById("nav-library"),
    navScan: document.getElementById("nav-new-scan"),
    navNote: document.getElementById("nav-new-note"),
    navSettings: document.getElementById("nav-settings"),
    noteEditor: document.getElementById("note-editor"),
    scanDoc: document.getElementById("scan-doc"),
    scanTargetNote: document.getElementById("scan-target-note"),
    storage: document.getElementById("settings-storage"),
    storageFill: document.getElementById("settings-storage-fill"),
    historyStats: document.getElementById("settings-history-stats"),
  });

  storageReady = await isAvailable();

  if (storageReady) {
    // Fire and forget: neither should delay first paint, and neither has a
    // failure worth surfacing.
    requestPersistence();
    purgeExpiredTrash().catch(() => {});
  }

  initLibrary({ onNewNote: () => createAndOpenNote(), onNewScan: () => createAndOpenScan() });
  initNotesEditor();
  initScanDoc({
    onAddPage: (doc) => {
      pendingTarget = doc?.id || null;
      showView(VIEWS.SCAN);
      updateScanTargetNote();
    },
  });
  initCropView();

  // Navigation.
  elements.back.addEventListener("click", () => {
    hapticLight();
    goBack();
  });
  elements.navLibrary.addEventListener("click", () => showView(VIEWS.LIBRARY));
  elements.navScan.addEventListener("click", () => createAndOpenScan());
  elements.navNote.addEventListener("click", () => createAndOpenNote());
  elements.navSettings.addEventListener("click", () => showView(VIEWS.SETTINGS));

  // Settings actions.
  document.getElementById("settings-persist")?.addEventListener("click", async () => {
    const granted = await requestPersistence();
    const status = document.getElementById("settings-persist-status");
    if (status) {
      status.textContent = granted
        ? "Storage is now persistent - the browser won't evict it automatically."
        : "The browser declined. Your data is still saved, but it can be cleared automatically if the device runs low on space.";
    }
  });

  document.getElementById("settings-clear-history")?.addEventListener("click", async () => {
    const removed = await clearHistory({ includeSaved: false });
    await renderSettings();
    window.alert(removed ? `Cleared ${removed} translation${removed === 1 ? "" : "s"}. Saved phrases were kept.` : "Nothing to clear.");
  });

  document.getElementById("settings-clear-history-all")?.addEventListener("click", async () => {
    if (!window.confirm("Delete translation history AND saved phrases? This can't be undone.")) return;
    const removed = await clearHistory({ includeSaved: true });
    await renderSettings();
    window.alert(removed ? `Cleared ${removed} entries.` : "Nothing to clear.");
  });

  document.getElementById("settings-delete-all")?.addEventListener("click", async () => {
    // Two confirmations, because this is the only genuinely unrecoverable
    // action in the app and there is no copy anywhere else.
    if (!window.confirm("Delete every document, page and image stored on this device?")) return;
    if (!window.confirm("This really cannot be undone. Delete everything?")) return;
    await clearAll();
    await renderLibrary();
    await renderSettings();
    showView(VIEWS.LIBRARY);
    window.alert("All local data deleted.");
  });

  // A crop applied to an existing page has to rebuild that page's image, and
  // js/scanDoc.js owns that pipeline (crop -> rotate -> filter -> annotate). An
  // event keeps the ordering in one place instead of duplicating it in the crop
  // view.
  window.addEventListener("textscanner:page-cropped", async () => {
    const doc = getCurrentScanDoc();
    if (doc) await renderScanDoc();
  });

  onViewChange(async (view, params, previous) => {
    // Leaving a note must flush its autosave before the DOM is reused.
    if (previous === VIEWS.DOCUMENT && view !== VIEWS.DOCUMENT) await closeNote();
    if (previous === VIEWS.CROP && view !== VIEWS.CROP) closeCrop();

    setChrome(view);

    switch (view) {
      case VIEWS.LIBRARY:
        await renderLibrary();
        restoreLibraryScroll();
        break;

      case VIEWS.SCAN:
        await updateScanTargetNote();
        break;

      case VIEWS.DOCUMENT:
        if (params.id) await openDocument(params.id);
        break;

      case VIEWS.CROP:
        // Only load here when arriving with a page id. The capture flow calls
        // openCropForImage itself, before the page exists.
        if (params.id && params.page) {
          const ok = await openCropForPage(params.id, params.page);
          if (!ok) goBack();
        }
        break;

      case VIEWS.SETTINGS:
        await renderSettings();
        break;

      default:
        break;
    }
  });

  initRouter(VIEWS.LIBRARY);

  if (!storageReady) {
    // Said once, plainly, rather than on every failed save.
    const note = document.createElement("p");
    note.className = "storage-warning";
    note.textContent =
      "This browser isn't allowing local storage, so documents can't be saved. Scanning and copying text still work.";
    document.getElementById("view-library")?.prepend(note);
  }
}

// Exposed so js/main.js's scan flow can reach the document model without
// importing the whole shell - main.js is the older module and keeping the
// dependency one-way makes the boundary obvious.
export const bridge = {
  addCurrentImageAsPage,
  createAndOpenNote,
  getPendingTarget: () => pendingTarget,
  clearPendingTarget: () => {
    pendingTarget = null;
    updateScanTargetNote();
  },
  isStorageReady: () => storageReady,
  insertNoteText,
  getCurrentNote,
};
