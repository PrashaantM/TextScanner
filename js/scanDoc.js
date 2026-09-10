// scanDoc.js: the multi-page scan document - the CamScanner surface.
//
// A scan document is an ordered list of pages. This view manages them: add,
// reorder, rotate, re-filter, re-crop, delete, OCR, and export to PDF, image or
// text.
//
// Two things here are worth reading before changing anything:
//
// **Filters are always applied to the ORIGINAL capture, never to the current
// image.** Every page keeps `originalBlobKey` alongside `blobKey`
// (js/documents.js). Re-filtering decodes the original, applies the new filter,
// and replaces the derived image. If it worked from the current image instead,
// switching Auto -> B&W -> Auto would compound three lossy operations and the
// page would visibly degrade each time - which is exactly the bug that makes
// filter buttons in lesser scanner apps feel dangerous to touch.
//
// **Page order lives in `doc.pageIds`, not in a sort key on each page.**
// Reordering is one small write instead of N, which matters because reordering is
// a drag gesture that fires continuously.
//
// Reordering supports both pointer drag and keyboard (Alt+Arrow on a focused
// page). The keyboard path is not a courtesy - a drag-only reorder is unusable
// with a screen reader, and it is the single most common accessibility failure
// in list-reordering UI.

import {
  DOC_TYPES,
  getDocument,
  getPagesForDocument,
  addPage,
  updatePage,
  deletePage,
  reorderPages,
  updateDocument,
  updateDocumentQuietly,
  deriveTitle,
  reindexDocument,
} from "./documents.js";
import { getBlob, getBlobUrl, releaseObjectUrl, putBlob, removeBlob } from "./store.js";
import {
  FILTERS,
  FILTER_LABELS,
  FILTER_ORDER,
  applyFilter,
  canvasFromSource,
  canvasToBlob,
  makeThumbnail,
  rotateCanvas,
} from "./scanFilters.js";
import { warpPerspective } from "./perspective.js";
import { isFullFrame } from "./edgeDetect.js";
import { burnAnnotations, hasRedaction } from "./annotate.js";
import { buildPdf, blobToUint8Array, PAPER_SIZES } from "./pdf.js";
import { recognizeImage } from "./recognize.js";
import { showView, VIEWS } from "./views.js";
import { hapticLight, hapticMedium } from "./haptics.js";
import { escapeHtml, formatBytes } from "./library.js";

let elements = {};
let currentDoc = null;
let pages = [];
let selectedPageId = null;
// Object URLs for the page strip and the main preview.
const pageUrls = new Map();
let onDocumentChanged = null;
let busy = false;

// ---- Image helpers ----

// Decodes a stored blob into an <img> that can be drawn to a canvas.
//
// `decode()` rather than an onload race: decode() resolves only once the bitmap
// is actually ready to draw, so a subsequent drawImage cannot silently produce
// a blank canvas. That failure is intermittent and maddening to diagnose, which
// is why every decode path in this file goes through here.
async function loadImage(blobKey) {
  const blob = await getBlob(blobKey);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { img, revoke: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

// Rebuilds a page's derived image from its original: crop, then rotate, then
// filter, then burn annotations. The order is deliberate and not interchangeable
// - filtering before cropping would compute the background estimate over pixels
// that get thrown away, which shifts the white point and makes the crop change
// the page's brightness.
async function rebuildPage(page, { filter, rotation, corners, annotations } = {}) {
  const loaded = await loadImage(page.originalBlobKey || page.blobKey);
  if (!loaded) throw new Error("That page's image couldn't be read.");

  const nextFilter = filter ?? page.filter;
  const nextRotation = rotation ?? page.rotation ?? 0;
  const nextCorners = corners !== undefined ? corners : page.corners;
  const nextAnnotations = annotations ?? page.annotations ?? [];

  try {
    let canvas = canvasFromSource(loaded.img);

    if (nextCorners && !isFullFrame(nextCorners, canvas.width, canvas.height)) {
      // Output size follows the crop's own average edge lengths, so a
      // keystoned page is de-warped to something close to its true proportions
      // rather than stretched to the source's aspect ratio.
      const [tl, tr, br, bl] = nextCorners;
      const width = Math.round((Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2);
      const height = Math.round((Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2);
      const warped = warpPerspective(canvas, nextCorners, Math.max(1, width), Math.max(1, height));
      if (warped) canvas = warped;
    }

    if (nextRotation) canvas = rotateCanvas(canvas, nextRotation);

    canvas = applyFilter(canvas, nextFilter);

    if (nextAnnotations.length) canvas = burnAnnotations(canvas, nextAnnotations);

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
    const thumbBlob = await canvasToBlob(makeThumbnail(canvas), "image/jpeg", 0.8);

    // Write the new blobs before removing the old ones, so a failure mid-way
    // leaves the page pointing at something that exists.
    const blobKey = await putBlob(blob);
    const thumbKey = await putBlob(thumbBlob);

    const previousBlob = page.blobKey;
    const previousThumb = page.thumbKey;

    const updated = await updatePage(page.id, {
      blobKey,
      thumbKey,
      filter: nextFilter,
      rotation: nextRotation,
      corners: nextCorners,
      annotations: nextAnnotations,
      width: canvas.width,
      height: canvas.height,
    });

    if (previousBlob && previousBlob !== page.originalBlobKey) await removeBlob(previousBlob);
    if (previousThumb) await removeBlob(previousThumb);

    return updated;
  } finally {
    loaded.revoke();
  }
}

// ---- Rendering ----

function releasePageUrls() {
  for (const url of pageUrls.values()) releaseObjectUrl(url);
  pageUrls.clear();
}

function selectedPage() {
  return pages.find((p) => p.id === selectedPageId) || pages[0] || null;
}

async function renderStrip() {
  if (!elements.strip) return;

  elements.strip.innerHTML = pages
    .map(
      (page, index) => `
      <li class="page-thumb${page.id === selectedPageId ? " is-selected" : ""}"
          data-page="${escapeHtml(page.id)}" draggable="true" tabindex="0"
          role="option" aria-selected="${page.id === selectedPageId}"
          aria-label="Page ${index + 1} of ${pages.length}">
        <span class="page-thumb__image" data-thumb-for="${escapeHtml(page.id)}"></span>
        <span class="page-thumb__number">${index + 1}</span>
      </li>`
    )
    .join("");

  for (const page of pages) {
    const holder = elements.strip.querySelector(`[data-thumb-for="${page.id}"]`);
    if (!holder) continue;
    const key = page.thumbKey || page.blobKey;
    if (!key) continue;
    const url = await getBlobUrl(key);
    if (url) {
      pageUrls.set(`thumb:${page.id}`, url);
      holder.style.backgroundImage = `url("${url}")`;
    }
  }

  elements.pageCount.textContent = pages.length
    ? `${pages.length} page${pages.length === 1 ? "" : "s"}`
    : "No pages yet";
}

async function renderPreview() {
  const page = selectedPage();
  if (!page || !elements.preview) {
    if (elements.preview) elements.preview.style.backgroundImage = "";
    if (elements.previewEmpty) elements.previewEmpty.classList.toggle("hidden", false);
    return;
  }

  elements.previewEmpty?.classList.add("hidden");

  const previous = pageUrls.get("preview");
  if (previous) releaseObjectUrl(previous);

  const url = await getBlobUrl(page.blobKey);
  if (url) {
    pageUrls.set("preview", url);
    elements.preview.style.backgroundImage = `url("${url}")`;
    elements.preview.setAttribute("aria-label", `Page ${pages.indexOf(page) + 1}`);
  }

  // Filter buttons reflect the selected page.
  for (const button of elements.filterRow?.querySelectorAll("[data-filter]") || []) {
    const active = button.dataset.filter === page.filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  const info = [];
  if (page.width && page.height) info.push(`${page.width} x ${page.height}`);
  if (page.corners) info.push("cropped");
  if (page.rotation) info.push(`rotated ${page.rotation}°`);
  if (hasRedaction(page.annotations)) info.push("redacted");
  if (page.text) info.push(`${page.text.split(/\s+/).filter(Boolean).length} words recognized`);
  if (elements.pageInfo) elements.pageInfo.textContent = info.join(" · ");
}

export async function renderScanDoc() {
  if (!currentDoc) return;

  releasePageUrls();
  pages = await getPagesForDocument(currentDoc);

  if (!pages.some((p) => p.id === selectedPageId)) selectedPageId = pages[0]?.id || null;

  elements.title.value = currentDoc.title || "";
  elements.title.placeholder = deriveTitle(currentDoc);

  await renderStrip();
  await renderPreview();

  const hasPages = pages.length > 0;
  for (const el of elements.needsPages || []) el.disabled = !hasPages;
}

// ---- Busy state ----
//
// Filters and OCR are synchronous canvas work on a full-resolution image, which
// on a phone can block for a second or more. Without a visible busy state the
// app looks frozen and people tap again, queuing a second pass.
function setBusy(on, message = "") {
  busy = on;
  elements.root?.classList.toggle("is-busy", on);
  if (elements.busyLabel) elements.busyLabel.textContent = message;
  elements.busy?.classList.toggle("hidden", !on);
}

async function withBusy(message, fn) {
  if (busy) return null;
  setBusy(true, message);
  // Yield a frame so the busy state actually paints before the blocking work
  // starts. Without this the class is added and the main thread is seized in
  // the same task, so nothing is ever drawn.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    window.alert(err?.message || "Something went wrong.");
    return null;
  } finally {
    setBusy(false);
  }
}

// ---- Page operations ----

export async function addPageFromCanvas(canvas, { filter, corners } = {}) {
  if (!currentDoc) return null;

  const chosenFilter = filter || currentDoc.defaultFilter || FILTERS.AUTO;
  const filtered = applyFilter(canvas, chosenFilter);
  const blob = await canvasToBlob(filtered, "image/jpeg", 0.92);

  const page = await addPage(currentDoc.id, {
    blob,
    width: filtered.width,
    height: filtered.height,
    filter: chosenFilter,
  });

  const thumbBlob = await canvasToBlob(makeThumbnail(filtered), "image/jpeg", 0.8);
  const thumbKey = await putBlob(thumbBlob);
  await updatePage(page.id, { thumbKey, corners: corners || null, originalBlobKey: page.originalBlobKey });

  // The document's own thumbnail is its first page.
  currentDoc = await getDocument(currentDoc.id);
  if (!currentDoc.thumbKey) {
    const docThumb = await putBlob(await canvasToBlob(makeThumbnail(filtered), "image/jpeg", 0.8));
    currentDoc = await updateDocumentQuietly(currentDoc.id, { thumbKey: docThumb });
  }

  selectedPageId = page.id;
  await renderScanDoc();
  onDocumentChanged?.(currentDoc);
  return page;
}

async function setFilter(filter) {
  const page = selectedPage();
  if (!page) return;

  await withBusy(`Applying ${FILTER_LABELS[filter] || filter}...`, async () => {
    await rebuildPage(page, { filter });
    currentDoc = await updateDocumentQuietly(currentDoc.id, { defaultFilter: filter });
    await renderScanDoc();
    onDocumentChanged?.(currentDoc);
  });
  hapticLight();
}

// Applies the selected page's filter to every page. The single most useful bulk
// action in a scanner app: you find the right look on one page, then commit.
async function applyFilterToAll() {
  const page = selectedPage();
  if (!page || pages.length < 2) return;

  if (!window.confirm(`Apply ${FILTER_LABELS[page.filter]} to all ${pages.length} pages?`)) return;

  await withBusy("Applying to every page...", async () => {
    for (const target of pages) {
      if (target.filter === page.filter) continue;
      await rebuildPage(target, { filter: page.filter });
    }
    await renderScanDoc();
    onDocumentChanged?.(currentDoc);
  });
  hapticMedium();
}

async function rotateSelected(delta) {
  const page = selectedPage();
  if (!page) return;

  await withBusy("Rotating...", async () => {
    await rebuildPage(page, { rotation: ((page.rotation || 0) + delta + 360) % 360 });
    await renderScanDoc();
    onDocumentChanged?.(currentDoc);
  });
  hapticLight();
}

async function deleteSelected() {
  const page = selectedPage();
  if (!page) return;

  const index = pages.indexOf(page);
  if (!window.confirm(`Delete page ${index + 1}?`)) return;

  await deletePage(currentDoc.id, page.id);
  currentDoc = await getDocument(currentDoc.id);
  // Select the neighbour that takes this page's place, which is what someone
  // deleting a run of pages expects.
  selectedPageId = pages[index + 1]?.id || pages[index - 1]?.id || null;
  await renderScanDoc();
  onDocumentChanged?.(currentDoc);
  hapticMedium();
}

async function recognizeSelected() {
  const page = selectedPage();
  if (!page) return;

  await withBusy("Recognizing text...", async () => {
    const loaded = await loadImage(page.blobKey);
    if (!loaded) throw new Error("That page's image couldn't be read.");
    try {
      const result = await recognizeImage(loaded.img, loaded.img.naturalWidth, loaded.img.naturalHeight, null);
      await updatePage(page.id, { words: result.words || [], text: result.text || "" });
      await reindexDocument(currentDoc.id);
      currentDoc = await getDocument(currentDoc.id);
      await renderScanDoc();
      onDocumentChanged?.(currentDoc);
    } finally {
      loaded.revoke();
    }
  });
}

async function recognizeAll() {
  const pending = pages.filter((p) => !p.text);
  if (!pending.length) {
    window.alert("Every page already has recognized text.");
    return;
  }

  await withBusy(`Recognizing ${pending.length} page${pending.length === 1 ? "" : "s"}...`, async () => {
    for (const [index, page] of pending.entries()) {
      if (elements.busyLabel) elements.busyLabel.textContent = `Recognizing page ${index + 1} of ${pending.length}...`;
      const loaded = await loadImage(page.blobKey);
      if (!loaded) continue;
      try {
        const result = await recognizeImage(loaded.img, loaded.img.naturalWidth, loaded.img.naturalHeight, null);
        await updatePage(page.id, { words: result.words || [], text: result.text || "" });
      } catch {
        // One unreadable page must not abandon the rest of the document.
      } finally {
        loaded.revoke();
      }
    }
    await reindexDocument(currentDoc.id);
    currentDoc = await getDocument(currentDoc.id);
    await renderScanDoc();
    onDocumentChanged?.(currentDoc);
  });
  hapticMedium();
}

// ---- Reordering ----

let dragPageId = null;

function movePage(pageId, delta) {
  const order = pages.map((p) => p.id);
  const from = order.indexOf(pageId);
  if (from === -1) return null;
  const to = Math.max(0, Math.min(order.length - 1, from + delta));
  if (to === from) return null;
  order.splice(to, 0, ...order.splice(from, 1));
  return order;
}

async function commitOrder(order) {
  if (!order) return;
  currentDoc = await reorderPages(currentDoc.id, order);
  await renderScanDoc();
  onDocumentChanged?.(currentDoc);
  hapticLight();
}

// ---- Export ----

async function exportPdf() {
  if (!pages.length) return;

  const paperSize = elements.paperSize?.value || "auto";
  const searchable = elements.searchable ? elements.searchable.checked : true;

  await withBusy("Building PDF...", async () => {
    const built = [];
    for (const page of pages) {
      const blob = await getBlob(page.blobKey);
      if (!blob) continue;
      built.push({
        jpegBytes: await blobToUint8Array(blob),
        words: searchable ? page.words || [] : [],
        width: page.width,
        height: page.height,
      });
    }

    if (!built.length) throw new Error("None of the pages could be read.");

    const pdf = await buildPdf(built, {
      title: deriveTitle(currentDoc),
      paperSize,
      searchable,
    });

    downloadBlob(pdf, `${safeFilename(deriveTitle(currentDoc))}.pdf`);
  });
  hapticMedium();
}

async function exportImages() {
  if (!pages.length) return;

  await withBusy("Preparing images...", async () => {
    for (const [index, page] of pages.entries()) {
      const blob = await getBlob(page.blobKey);
      if (!blob) continue;
      downloadBlob(blob, `${safeFilename(deriveTitle(currentDoc))}-${String(index + 1).padStart(2, "0")}.jpg`);
      // Browsers throttle or drop rapid successive downloads; a short gap
      // between them is the difference between getting all pages and getting
      // the first one.
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  });
}

function exportText() {
  const text = pages
    .map((page, index) => {
      const header = pages.length > 1 ? `--- Page ${index + 1} ---\n` : "";
      return `${header}${page.text || "[no recognized text]"}`;
    })
    .join("\n\n");

  downloadBlob(new Blob([text], { type: "text/plain" }), `${safeFilename(deriveTitle(currentDoc))}.txt`);
}

async function copyText() {
  const text = pages.map((p) => p.text || "").filter(Boolean).join("\n\n");
  if (!text) {
    window.alert("There's no recognized text yet. Run \"Recognize text\" first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (elements.exportStatus) {
      elements.exportStatus.textContent = "Copied";
      setTimeout(() => {
        if (elements.exportStatus) elements.exportStatus.textContent = "";
      }, 1600);
    }
  } catch {
    window.alert("Couldn't copy automatically. The text is in the document's pages.");
  }
}

export function safeFilename(name) {
  return (name || "scan")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "scan";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a delay rather than immediately: some browsers have not started
  // reading the blob by the time click() returns, and revoking synchronously
  // produces a zero-byte download.
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

// ---- Lifecycle ----

export async function openScanDoc(doc, { onChanged } = {}) {
  currentDoc = doc;
  onDocumentChanged = onChanged;
  selectedPageId = null;
  await renderScanDoc();
}

export async function closeScanDoc() {
  releasePageUrls();
  currentDoc = null;
  pages = [];
  selectedPageId = null;
  onDocumentChanged = null;
}

export function getCurrentScanDoc() {
  return currentDoc;
}

export function getSelectedPage() {
  return selectedPage();
}

export function initScanDoc({ onAddPage } = {}) {
  elements = {
    root: document.getElementById("scan-doc"),
    title: document.getElementById("scan-doc-title"),
    strip: document.getElementById("page-strip"),
    preview: document.getElementById("page-preview"),
    previewEmpty: document.getElementById("page-preview-empty"),
    pageCount: document.getElementById("scan-page-count"),
    pageInfo: document.getElementById("scan-page-info"),
    filterRow: document.getElementById("scan-filter-row"),
    busy: document.getElementById("scan-busy"),
    busyLabel: document.getElementById("scan-busy-label"),
    paperSize: document.getElementById("scan-paper-size"),
    searchable: document.getElementById("scan-searchable"),
    exportStatus: document.getElementById("scan-export-status"),
  };

  if (!elements.root) return;

  elements.needsPages = elements.root.querySelectorAll("[data-needs-pages]");

  // Filter buttons, built from the module's own order so adding a filter needs
  // no markup change.
  if (elements.filterRow) {
    elements.filterRow.innerHTML = FILTER_ORDER.map(
      (filter) =>
        `<button class="filter-chip" data-filter="${filter}" type="button" aria-pressed="false">${escapeHtml(FILTER_LABELS[filter])}</button>`
    ).join("");
  }

  if (elements.paperSize) {
    elements.paperSize.innerHTML = Object.entries(PAPER_SIZES)
      .map(([key, value]) => `<option value="${key}">${value ? escapeHtml(value.label) : "Fit to page"}</option>`)
      .join("");
  }

  elements.title?.addEventListener("input", async () => {
    if (!currentDoc) return;
    currentDoc = await updateDocument(currentDoc.id, { title: elements.title.value });
    onDocumentChanged?.(currentDoc);
  });

  elements.root.addEventListener("click", async (event) => {
    const filterButton = event.target.closest("[data-filter]");
    if (filterButton) {
      await setFilter(filterButton.dataset.filter);
      return;
    }

    const thumb = event.target.closest("[data-page]");
    if (thumb) {
      selectedPageId = thumb.dataset.page;
      await renderStrip();
      await renderPreview();
      return;
    }

    const action = event.target.closest("[data-scan-action]")?.dataset.scanAction;
    if (!action) return;

    switch (action) {
      case "add-page":
        onAddPage?.(currentDoc);
        break;
      case "rotate-left":
        await rotateSelected(-90);
        break;
      case "rotate-right":
        await rotateSelected(90);
        break;
      case "crop":
        if (selectedPage()) showView(VIEWS.CROP, { id: currentDoc.id, page: selectedPageId });
        break;
      case "delete-page":
        await deleteSelected();
        break;
      case "move-left":
        await commitOrder(movePage(selectedPageId, -1));
        break;
      case "move-right":
        await commitOrder(movePage(selectedPageId, 1));
        break;
      case "filter-all":
        await applyFilterToAll();
        break;
      case "recognize":
        await recognizeSelected();
        break;
      case "recognize-all":
        await recognizeAll();
        break;
      case "export-pdf":
        await exportPdf();
        break;
      case "export-images":
        await exportImages();
        break;
      case "export-text":
        exportText();
        break;
      case "copy-text":
        await copyText();
        break;
      default:
        break;
    }
  });

  // Pointer drag reorder.
  elements.strip?.addEventListener("dragstart", (event) => {
    const item = event.target.closest("[data-page]");
    if (!item) return;
    dragPageId = item.dataset.page;
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    // Firefox requires data to be set or the drag never starts.
    event.dataTransfer.setData("text/plain", dragPageId);
  });

  elements.strip?.addEventListener("dragover", (event) => {
    if (!dragPageId) return;
    event.preventDefault();
    const item = event.target.closest("[data-page]");
    if (!item || item.dataset.page === dragPageId) return;
    item.classList.add("is-drop-target");
  });

  elements.strip?.addEventListener("dragleave", (event) => {
    event.target.closest("[data-page]")?.classList.remove("is-drop-target");
  });

  elements.strip?.addEventListener("drop", async (event) => {
    event.preventDefault();
    const item = event.target.closest("[data-page]");
    if (!dragPageId || !item) return;

    const order = pages.map((p) => p.id);
    const from = order.indexOf(dragPageId);
    const to = order.indexOf(item.dataset.page);
    if (from !== -1 && to !== -1 && from !== to) {
      order.splice(to, 0, ...order.splice(from, 1));
      await commitOrder(order);
    }
    dragPageId = null;
  });

  elements.strip?.addEventListener("dragend", () => {
    dragPageId = null;
    for (const el of elements.strip.querySelectorAll(".is-dragging, .is-drop-target")) {
      el.classList.remove("is-dragging", "is-drop-target");
    }
  });

  // Keyboard reorder and selection. Alt+Arrow moves the page; plain arrows move
  // the selection, which is what a listbox role promises.
  elements.strip?.addEventListener("keydown", async (event) => {
    const item = event.target.closest("[data-page]");
    if (!item) return;
    const pageId = item.dataset.page;

    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      await commitOrder(movePage(pageId, event.key === "ArrowLeft" ? -1 : 1));
      // Keep focus on the page that moved, not on whatever now occupies the
      // old position - otherwise a second press moves a different page.
      elements.strip.querySelector(`[data-page="${pageId}"]`)?.focus();
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const order = pages.map((p) => p.id);
      const index = order.indexOf(pageId);
      const next = order[index + (event.key === "ArrowLeft" ? -1 : 1)];
      if (next) {
        selectedPageId = next;
        await renderStrip();
        await renderPreview();
        elements.strip.querySelector(`[data-page="${next}"]`)?.focus();
      }
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectedPageId = pageId;
      await renderStrip();
      await renderPreview();
    }
  });
}
