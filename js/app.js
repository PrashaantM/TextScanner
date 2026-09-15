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

import { isAvailable, estimateStorage, requestPersistence, isPersisted, clearAll } from "./store.js";
import { exportLibraryToBlob, importLibraryFromFile } from "./backup.js";
import {
  DOC_TYPES,
  createDocument,
  getDocument,
  deriveTitle,
  purgeExpiredTrash,
  sweepEmptyDocuments,
  updateDocument,
} from "./documents.js";
import { VIEWS, showView, onViewChange, initRouter, goBack } from "./views.js";
import { initLibrary, renderLibrary, restoreLibraryScroll, formatBytes } from "./library.js";
import { initNotesEditor, openNote, openNoteDraft, closeNote, insertText as insertNoteText, getCurrentNote } from "./notesEditor.js";
import { showToast } from "./toast.js";
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
import { cycleTheme, themeLabel } from "./theme.js";
import { initCommandPalette, openCommandPalette, closeCommandPalette, isCommandPaletteOpen } from "./commandPalette.js";
import { openRadialMenu } from "./radialMenu.js";

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

// `body`/`title` arrive non-empty from exactly one caller - "Save as note" on a
// scan result (see js/main.js) - where there is already real content to save,
// so creating immediately is correct. Called with neither (a bare tap of the
// "New note" action) it opens a draft instead: nothing is written to storage
// until the person actually types something. See notesEditor.js's
// openNoteDraft/save for where that actually happens - this replaced a bug
// where every tap of "Note" created a permanent, empty "Untitled note".
async function createAndOpenNote({ body = "", title = "" } = {}) {
  if (!storageReady) {
    window.alert("This browser isn't allowing local storage, so notes can't be saved. Scanning still works.");
    return null;
  }

  await closeScanDoc();
  elements.noteEditor.classList.remove("hidden");
  elements.scanDoc.classList.add("hidden");

  const onChanged = (updated) => {
    setChrome(VIEWS.DOCUMENT, { title: deriveTitle(updated), subtitle: "" });
  };

  if (body || title) {
    const doc = await createDocument({ type: DOC_TYPES.NOTE, title });
    if (body) await updateDocument(doc.id, { body });
    hapticMedium();
    showView(VIEWS.DOCUMENT, { id: doc.id });
    await openNote(doc, { onChanged });
    setChrome(VIEWS.DOCUMENT, { title: deriveTitle(doc), subtitle: "" });
    return doc;
  }

  hapticMedium();
  showView(VIEWS.DOCUMENT, {});
  setChrome(VIEWS.DOCUMENT, { title: "New note", subtitle: "" });
  await openNoteDraft({
    onChanged,
    onCreated: (created) => {
      setChrome(VIEWS.DOCUMENT, { title: deriveTitle(created), subtitle: "" });
      showToast(`Created "${deriveTitle(created)}"`);
    },
  });
  return null;
}

// Navigation only - no document is created here. The first page actually
// committed (see addCurrentImageAsPage below) is what creates one, which is
// what makes previewing a sample image without scanning it a no-op on the
// library instead of leaving behind an "Untitled scan · 0 pages" card.
async function createAndOpenScan() {
  pendingTarget = null;
  hapticMedium();
  showView(VIEWS.SCAN);
  updateScanTargetNote();
  return null;
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
  let justCreated = false;
  if (!targetId) {
    const doc = await createDocument({ type: DOC_TYPES.SCAN });
    targetId = doc.id;
    pendingTarget = doc.id;
    justCreated = true;
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
    // Announced after the page (and therefore the document's real title, if the
    // page recognized one) is in, not at creation - "Created 'Untitled scan'" a
    // beat before it says "Created 'Coffee receipt'" would be a confusing flash.
    if (justCreated) {
      const created = await getDocument(targetId);
      if (created) showToast(`Created "${deriveTitle(created)}"`);
    }
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

  // Persistence, stated plainly rather than as a boolean nobody can act on.
  //
  // "Persistent" is not a nicety. Safari's ITP deletes all script-writable
  // storage - IndexedDB included - after 7 days without a visit, for any site
  // that is not installed. This app has no server to re-download from, so for a
  // person in that situation the honest message is "your documents can be
  // deleted by the browser, here is what to do", not silence.
  const persisted = await isPersisted();
  if (persisted === null) {
    elements.persistState.textContent = "This browser doesn't say whether storage is permanent.";
    elements.persistExplain.textContent =
      "Back up regularly - see below - since there is no way to know whether this browser will keep your documents.";
  } else if (persisted) {
    elements.persistState.textContent = "Storage is permanent on this browser.";
    elements.persistExplain.textContent =
      "Your documents will not be removed automatically. They are still only on this device, so a backup is still the only copy that survives losing it.";
  } else {
    elements.persistState.textContent = "Storage is NOT permanent on this browser.";
    elements.persistExplain.textContent =
      "The browser may delete your documents to reclaim space - Safari does this after about 7 days without a visit unless the app is installed to your home screen. Install it, press \u201cKeep storage permanently\u201d above, or back up below.";
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
    navAdd: document.getElementById("nav-add"),
    navSettings: document.getElementById("nav-settings"),
    actionSheet: document.getElementById("action-sheet"),
    actionSheetBackdrop: document.getElementById("action-sheet-backdrop"),
    actionSheetScan: document.getElementById("action-sheet-scan"),
    actionSheetNote: document.getElementById("action-sheet-note"),
    shortcutSheet: document.getElementById("shortcut-sheet"),
    shortcutSheetBackdrop: document.getElementById("shortcut-sheet-backdrop"),
    shortcutSheetClose: document.getElementById("shortcut-sheet-close"),
    noteEditor: document.getElementById("note-editor"),
    scanDoc: document.getElementById("scan-doc"),
    scanTargetNote: document.getElementById("scan-target-note"),
    storage: document.getElementById("settings-storage"),
    storageFill: document.getElementById("settings-storage-fill"),
    historyStats: document.getElementById("settings-history-stats"),
    persistState: document.getElementById("settings-persist-state"),
    persistExplain: document.getElementById("settings-persist-explain"),
    backupExport: document.getElementById("settings-backup-export"),
    backupImport: document.getElementById("settings-backup-import"),
    backupFile: document.getElementById("settings-backup-file"),
    backupStatus: document.getElementById("settings-backup-status"),
  });

  storageReady = await isAvailable();

  if (storageReady) {
    // Fire and forget: none of these should delay first paint, and none has a
    // failure worth surfacing. sweepEmptyDocuments is the one-time cleanup for
    // documents the eager-creation bug already left behind - it runs every
    // launch, but is a no-op past the first one now that nothing creates
    // empty documents anymore.
    requestPersistence();
    purgeExpiredTrash().catch(() => {});
    sweepEmptyDocuments().catch(() => {});
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
  elements.navSettings.addEventListener("click", () => showView(VIEWS.SETTINGS));

  // Action sheet (see index.html for why "Scan"/"Note" collapsed into one "+"
  // button): opens on tap, closes on either choice, a backdrop click, or
  // Escape, and always returns focus to the button that opened it. This stays
  // the keyboard-activation path (a focus + Enter/Space on #nav-add never
  // fires pointerdown, so it never reaches the radial menu below) and the
  // mouse path - see 06-INTERACTION-MODEL-SPEC.md's "Architecture decision"
  // for why a mouse deliberately keeps the plain list rather than the drag
  // gesture a touch/pen press gets instead.
  const openActionSheet = () => {
    elements.actionSheetBackdrop.classList.remove("hidden");
    elements.actionSheet.classList.remove("hidden");
    elements.navAdd.setAttribute("aria-expanded", "true");
    elements.actionSheetScan.focus();
  };
  const closeActionSheet = ({ restoreFocus = true } = {}) => {
    elements.actionSheetBackdrop.classList.add("hidden");
    elements.actionSheet.classList.add("hidden");
    elements.navAdd.setAttribute("aria-expanded", "false");
    if (restoreFocus) elements.navAdd.focus();
  };
  const isActionSheetOpen = () => !elements.actionSheet.classList.contains("hidden");

  elements.navAdd.addEventListener("click", () => {
    if (isActionSheetOpen()) closeActionSheet();
    else openActionSheet();
  });
  elements.actionSheetBackdrop.addEventListener("click", () => closeActionSheet());
  elements.actionSheetScan.addEventListener("click", () => {
    closeActionSheet({ restoreFocus: false });
    createAndOpenScan();
  });
  elements.actionSheetNote.addEventListener("click", () => {
    closeActionSheet({ restoreFocus: false });
    createAndOpenNote();
  });

  // Radial create-menu (06-INTERACTION-MODEL-SPEC.md, call site 1): the touch/
  // pen press-drag-release presentation of the exact same two choices above.
  // Deliberately gated to touch/pen, not mouse - every pointerdown on a real
  // mouse would otherwise open this AND the plain click handler above would
  // still fire afterward for an undragged press (a mouse's click isn't
  // suppressed by pointerdown's preventDefault the way touch's is), and a
  // press-drag-release gesture isn't obviously better than a plain click for
  // a mouse anyway.
  elements.navAdd.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    event.preventDefault();
    const rect = elements.navAdd.getBoundingClientRect();
    openRadialMenu({
      originX: rect.left + rect.width / 2,
      originY: rect.top + rect.height / 2,
      originEl: elements.navAdd,
      arcCenter: 180, // nav-add sits at the top edge, so the fan opens downward
      arcSpan: 70,
      items: [
        { id: "scan", label: "Scan", icon: "&#128247;", onSelect: () => createAndOpenScan() },
        { id: "note", label: "Note", icon: "&#9998;", onSelect: () => createAndOpenNote() },
      ],
    });
  });

  // Keyboard shortcut cheat sheet ("?" below, or the command palette's "Show
  // keyboard shortcuts").
  const openShortcutSheet = () => {
    elements.shortcutSheetBackdrop.classList.remove("hidden");
    elements.shortcutSheet.classList.remove("hidden");
    elements.shortcutSheetClose.focus();
  };
  const closeShortcutSheet = () => {
    elements.shortcutSheetBackdrop.classList.add("hidden");
    elements.shortcutSheet.classList.add("hidden");
  };
  const isShortcutSheetOpen = () => !elements.shortcutSheet.classList.contains("hidden");
  elements.shortcutSheetClose.addEventListener("click", closeShortcutSheet);
  elements.shortcutSheetBackdrop.addEventListener("click", closeShortcutSheet);

  initCommandPalette({
    createAndOpenScan,
    createAndOpenNote,
    toggleTheme: () => {
      const btn = document.getElementById("theme-btn");
      if (btn) btn.textContent = themeLabel(cycleTheme());
    },
    openShortcutSheet,
  });

  // Steps the scan-result screen's Text -> Image format -> View on photo modes
  // via the real buttons (dispatching a .click() on the original control)
  // rather than reaching into main.js's editor state directly - app.js owns
  // the shell, main.js owns the scan flow, and this keeps that boundary
  // one-way.
  // A no-op when the scan result isn't even showing.
  function cycleScanView(direction) {
    const resultSection = document.getElementById("result-section");
    if (!resultSection || resultSection.classList.contains("hidden")) return;
    const order = ["mode-text-btn", "mode-image-btn", "mode-full-btn"];
    const activeId = document.querySelector(".mode-toggle__btn.is-active")?.id;
    const currentIndex = Math.max(0, order.indexOf(activeId));
    const nextIndex = (currentIndex + direction + order.length) % order.length;
    document.getElementById(order[nextIndex])?.click();
  }

  // Global keyboard shortcuts (06-INTERACTION-MODEL-SPEC.md). Bound once,
  // guarded once - every other shortcut handler in this app (the note
  // editor's Enter-in-checklist, the crop view's arrow-key nudging) is scoped
  // to its own surface; this is the one dispatcher for cross-cutting actions.
  // Cmd/Ctrl+K and Escape are checked before the "inside a text field" guard
  // on purpose: the palette must be reachable while composing a note, and
  // Escape must be able to close an overlay regardless of what's focused
  // underneath it.
  document.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (isCommandPaletteOpen()) closeCommandPalette();
      else openCommandPalette();
      return;
    }

    if (event.key === "Escape") {
      if (isCommandPaletteOpen()) closeCommandPalette();
      else if (isActionSheetOpen()) closeActionSheet();
      else if (isShortcutSheetOpen()) closeShortcutSheet();
      return;
    }

    const inTextField =
      ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (inTextField) return;

    if (meta && !event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      createAndOpenScan();
    } else if (meta && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      createAndOpenNote();
    } else if (meta && event.key.toLowerCase() === "l") {
      event.preventDefault();
      showView(VIEWS.LIBRARY);
    } else if (meta && event.key === ",") {
      event.preventDefault();
      showView(VIEWS.SETTINGS);
    } else if (event.key === "?") {
      event.preventDefault();
      openShortcutSheet();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      // Proxied via a real .click() on the card's own trash button, reusing
      // library.js's existing delegated handler (and its Undo toast) rather
      // than reaching into that module's private handleAction.
      document.activeElement?.closest(".doc-card")?.querySelector('[data-action="trash"]')?.click();
    } else if (event.key === "[" || event.key === "]") {
      cycleScanView(event.key === "]" ? 1 : -1);
    }
  });

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

  // ---- Back up / restore ----
  //
  // The download is a plain object-URL anchor: no Web Share, because a backup is
  // a file you keep rather than something you send, and the share sheet on
  // desktop cannot take a file at all.
  elements.backupExport?.addEventListener("click", async () => {
    if (!storageReady) {
      window.alert("This browser isn't allowing local storage, so there is nothing to back up.");
      return;
    }
    elements.backupExport.disabled = true;
    elements.backupStatus.textContent = "Collecting documents\u2026";
    try {
      const { blob, counts } = await exportLibraryToBlob({
        onProgress: (done, total) => {
          elements.backupStatus.textContent = `Encoding images\u2026 ${done} of ${total}`;
        },
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `textscanner-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on a timer rather than immediately: Safari has historically
      // cancelled an in-flight download when its object URL was revoked in the
      // same tick as the click.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      elements.backupStatus.textContent =
        `Backed up ${counts.documents} document${counts.documents === 1 ? "" : "s"}, ` +
        `${counts.pages} page${counts.pages === 1 ? "" : "s"} and ${counts.blobs} image${counts.blobs === 1 ? "" : "s"} ` +
        `(${formatBytes(blob.size)}). Your API key is not in this file.`;
      hapticMedium();
    } catch (err) {
      console.error("Backup failed:", err);
      elements.backupStatus.textContent = "Couldn't build the backup. Try again.";
    } finally {
      elements.backupExport.disabled = false;
    }
  });

  elements.backupImport?.addEventListener("click", () => elements.backupFile?.click());

  elements.backupFile?.addEventListener("change", async () => {
    const file = elements.backupFile.files?.[0];
    elements.backupFile.value = "";
    if (!file) return;
    if (!storageReady) {
      window.alert("This browser isn't allowing local storage, so a backup can't be restored here.");
      return;
    }
    elements.backupStatus.textContent = "Reading backup\u2026";
    try {
      const added = await importLibraryFromFile(file, {
        onProgress: (done, total) => {
          elements.backupStatus.textContent = `Restoring images\u2026 ${done} of ${total}`;
        },
      });
      await renderLibrary();
      await renderSettings();
      elements.backupStatus.textContent = added.documents
        ? `Restored ${added.documents} document${added.documents === 1 ? "" : "s"} and ${added.pages} page${added.pages === 1 ? "" : "s"}.`
        : "Nothing new to restore - everything in that backup is already here.";
      hapticMedium();
    } catch (err) {
      console.error("Restore failed:", err);
      elements.backupStatus.textContent = err?.message || "Couldn't read that backup.";
    }
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
