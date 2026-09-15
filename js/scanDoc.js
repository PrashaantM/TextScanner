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
// **A REDACTED page is the one exception, and it is a deliberate trade.**
// Applying a redaction destroys that page's original (js/documents.js's
// destroyPageOriginal) and repoints `originalBlobKey` at the page's own
// redacted image. From then on this page really does re-filter from a processed
// image and really will degrade a little each time - accepted, because the
// alternative is keeping a copy of the thing someone just asked to have
// destroyed so that their filter buttons stay lossless. Only redacted pages pay
// it, and only after a confirmation that says so.
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
  destroyPageOriginal,
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
import { burnAnnotations, hasRedaction, createStroke, addPoint, TOOLS } from "./annotate.js";
import { detectPiiInWords, bboxToNormalizedBox } from "./piiDetect.js";
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

// ---- Redaction drafting state ----
//
// Draft boxes live HERE and not in the page record, which is the whole reason
// undo works before applying and stops existing afterwards. Nothing in
// `draftBoxes` has touched storage: cancelling drops the array, and applying
// converts it to strokes, burns them, and destroys the original in one action.
let redactMode = false;
let draftBoxes = [];
let dragStart = null;

// ---- PII scan state ----
//
// A separate draft-before-picker step, upstream of the redaction draft above:
// `piiCandidates` holds what detectPiiInWords found on the CURRENT page the
// last time "Find PII" was pressed, and `piiSelected` holds which of them are
// checked in that list right now. Neither has touched a page or a stroke -
// "Redact selected" is the one place this state turns into `draftBoxes`, at
// which point control passes entirely to the existing redaction draft/apply
// code above. There is deliberately no separate apply path here.
let piiCandidates = [];
let piiSelected = new Set();

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
  if (hasRedaction(page.annotations)) {
    // Two different facts, and the difference is the whole point of the
    // confirmation: "redacted" describes the pixels, "original destroyed"
    // describes the device. A page can only reach the second state through
    // applyRedaction below.
    info.push(page.originalDestroyedAt ? "redacted - original destroyed" : "redacted");
  }
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

// ---- Redaction ----
//
// WHAT THIS IS FOR. A redaction that leaves the unredacted page sitting in
// IndexedDB is not a redaction; it is a black rectangle drawn over a document
// anyone with the device can still re-derive, because rebuildPage re-reads
// `originalBlobKey` on every filter, rotate and crop. Applying a redaction here
// therefore does two things in one action: burns the boxes into the page's
// pixels (js/annotate.js's burnAnnotations) and destroys the original
// (js/documents.js's destroyPageOriginal).
//
// THE UNDO STORY, stated once, here, because it is the part people get wrong:
//
//   - While drafting, boxes are free. Undo removes the last one, Cancel drops
//     them all, and nothing has been written to storage.
//   - Accepting the SECOND confirmation is the last moment undo exists. Past
//     it, the covered pixels are gone from the page image and the bytes they
//     came from are gone from the device.
//   - So there is deliberately no undo control outside draft mode. Leaving one
//     enabled that could only ever no-op or throw is worse than not offering
//     it: it tells someone their redaction is reversible at exactly the moment
//     it stopped being.
//
// The preview's own black pills and the burned result are the same geometry:
// each stroke runs along its box's horizontal centre line, inset at both ends
// by half the box height, drawn at a line width of exactly that height with the
// round caps js/annotate.js already uses. Bounding box in, bounding box out.

// The page image is drawn `contain`-style inside the preview element, so the
// element's own box is not where the image is. Everything below works in the
// IMAGE's rect, because a box dropped in the letterboxing would otherwise map
// to page coordinates that do not exist.
function previewImageRect(page) {
  const box = elements.preview.getBoundingClientRect();
  const pageWidth = page.width || box.width || 1;
  const pageHeight = page.height || box.height || 1;
  const scale = Math.min(box.width / pageWidth, box.height / pageHeight);
  const width = pageWidth * scale;
  const height = pageHeight * scale;
  return {
    left: (box.width - width) / 2,
    top: (box.height - height) / 2,
    width,
    height,
    clientLeft: box.left + (box.width - width) / 2,
    clientTop: box.top + (box.height - height) / 2,
  };
}

function positionRedactOverlay() {
  const page = selectedPage();
  if (!elements.redactOverlay || !page) return;
  const rect = previewImageRect(page);
  elements.redactOverlay.style.left = `${rect.left}px`;
  elements.redactOverlay.style.top = `${rect.top}px`;
  elements.redactOverlay.style.width = `${rect.width}px`;
  elements.redactOverlay.style.height = `${rect.height}px`;
}

function renderDraftBoxes() {
  if (!elements.redactOverlay) return;
  elements.redactOverlay.innerHTML = draftBoxes
    .map(
      (b) =>
        `<span class="redact-box" style="left:${b.x * 100}%;top:${b.y * 100}%;` +
        `width:${b.width * 100}%;height:${b.height * 100}%"></span>`
    )
    .join("");
  if (elements.redactUndo) elements.redactUndo.disabled = draftBoxes.length === 0;
  if (elements.redactApply) elements.redactApply.disabled = draftBoxes.length === 0;
  if (elements.redactCount) {
    elements.redactCount.textContent = draftBoxes.length
      ? `${draftBoxes.length} box${draftBoxes.length === 1 ? "" : "es"} drawn`
      : "Drag across anything that should not leave this device.";
  }
}

function setRedactMode(on, seedBoxes = []) {
  redactMode = on;
  draftBoxes = on ? [...seedBoxes] : [];
  dragStart = null;
  elements.redactPanel?.classList.toggle("hidden", !on);
  elements.redactOverlay?.classList.toggle("hidden", !on);
  if (on) positionRedactOverlay();
  renderDraftBoxes();
  // Mutually exclusive with the PII picker: both draw into the same overlay
  // and the same draftBoxes array, so leaving one open under the other would
  // mean a click meant for one panel lands on the other's control instead.
  closePiiPanel();
}

// One drag, one box, in normalized 0-1 coordinates against the PAGE image.
function boxFromDrag(a, b) {
  const x = Math.max(0, Math.min(a.x, b.x));
  const y = Math.max(0, Math.min(a.y, b.y));
  return {
    x,
    y,
    width: Math.min(1, Math.max(a.x, b.x)) - x,
    height: Math.min(1, Math.max(a.y, b.y)) - y,
  };
}

// A normalized box becomes one redact stroke. `width` in a stroke is a fraction
// of the page's SMALLER edge (js/annotate.js), so the box's height has to be
// converted through the real pixel dimensions rather than used directly.
function strokeFromBox(box, pageWidth, pageHeight) {
  const minEdge = Math.min(pageWidth, pageHeight) || 1;
  const heightPx = box.height * pageHeight;
  const stroke = createStroke(TOOLS.REDACT, { width: heightPx / minEdge });

  // Inset by half the stroke height at each end so the round caps land exactly
  // on the box's left and right edges instead of bulging past them.
  const insetX = heightPx / 2 / (pageWidth || 1);
  const centreY = box.y + box.height / 2;
  const startX = box.x + insetX;
  const endX = box.x + box.width - insetX;

  if (endX <= startX) {
    // Taller than it is wide: a single capped point covers it, and covering a
    // little more than was asked for is the only safe direction to round in.
    addPoint(stroke, box.x + box.width / 2, centreY);
  } else {
    addPoint(stroke, startX, centreY);
    addPoint(stroke, endX, centreY);
  }
  return stroke;
}

async function applyRedaction() {
  const page = selectedPage();
  if (!page || !draftBoxes.length) return;

  const count = draftBoxes.length;
  const noun = `${count} redaction${count === 1 ? "" : "s"}`;
  if (!window.confirm(`Apply ${noun} to page ${pages.indexOf(page) + 1}? The covered content is removed from this page's image.`)) return;
  // The second confirm is the one that matters, and it is separate for the same
  // reason "Delete all local data" has two: this is the step that destroys
  // something, and it must not be reachable by a single mis-tap on the first.
  if (
    !window.confirm(
      "This also deletes this page's unredacted original from this device, permanently. " +
        "After this the redaction can't be undone. Destroy the original?"
    )
  )
    return;

  const boxes = draftBoxes;
  await withBusy("Applying redaction...", async () => {
    const strokes = boxes.map((box) => strokeFromBox(box, page.width, page.height));
    const merged = [...(page.annotations || []), ...strokes];

    // Burn first, destroy second. rebuildPage still needs the original to
    // re-derive from, and if the burn throws, the page is unchanged and its
    // original is still there - which is the right way round to fail.
    await rebuildPage(page, { annotations: merged });
    await destroyPageOriginal(page.id);

    currentDoc = await getDocument(currentDoc.id);
    await renderScanDoc();
    onDocumentChanged?.(currentDoc);
  });

  // Leaving draft mode is also what removes the Undo control from the DOM's
  // reach - see the undo story in this section's header.
  setRedactMode(false);
  hapticMedium();
}

// ---- PII scan ----
//
// The bridge described in js/piiDetect.js's header, made concrete: run the
// detector over the selected page's `page.words`, let the person pick which
// candidates to act on, then hand the selected set to the SAME draft/apply
// machinery a hand-drawn box already goes through. Nothing below burns a
// pixel or touches storage - that still only happens in applyRedaction.

function closePiiPanel() {
  piiCandidates = [];
  piiSelected = new Set();
  elements.piiPanel?.classList.add("hidden");
}

function renderPiiList() {
  if (!elements.piiList) return;

  elements.piiList.innerHTML = piiCandidates
    .map(
      (c, index) => `
      <li class="pii-candidate">
        <label>
          <input type="checkbox" data-pii-index="${index}" ${piiSelected.has(index) ? "checked" : ""} />
          <span class="pii-candidate__kind">${escapeHtml(c.label)}</span>
          <span class="pii-candidate__text">${escapeHtml(c.maskedText)}</span>
        </label>
      </li>`
    )
    .join("");

  if (elements.piiSummary) {
    elements.piiSummary.textContent = piiCandidates.length
      ? `${piiCandidates.length} candidate${piiCandidates.length === 1 ? "" : "s"} found - ` +
        `${piiSelected.size} selected.`
      : "No PII-shaped text found on this page.";
  }
  if (elements.piiRedactSelected) elements.piiRedactSelected.disabled = piiSelected.size === 0;
}

// Guarded the same way recognizeSelected's OWN callers are: this reads
// page.words, which only exists once "Recognize text" has run on this page.
async function runPiiScan() {
  const page = selectedPage();
  if (!page) return;

  if (redactMode) setRedactMode(false); // drop any unrelated hand-drawn draft first

  if (!page.words?.length) {
    window.alert('Run "Recognize text" on this page first - PII is found in its recognized words.');
    return;
  }

  piiCandidates = detectPiiInWords(page.words);
  // Pre-selected: the point of this panel is to catch things, and unchecking
  // a false positive is a lighter action than having to check every real one
  // individually on a page that might carry several.
  piiSelected = new Set(piiCandidates.map((_, i) => i));
  elements.piiPanel?.classList.toggle("hidden", false);
  renderPiiList();
}

function togglePiiCandidate(index) {
  if (piiSelected.has(index)) piiSelected.delete(index);
  else piiSelected.add(index);
  renderPiiList();
}

// Converts the SELECTED candidates into normalized boxes (js/piiDetect.js's
// bboxToNormalizedBox - the one real coordinate conversion in this feature)
// and opens the existing redaction draft pre-populated with them. From this
// point on it is exactly the hand-drawn flow: adjustable via Undo, cancellable,
// and only ever committed through applyRedaction's two confirms.
function redactSelectedPii() {
  const page = selectedPage();
  if (!page || !piiSelected.size) return;

  const boxes = piiCandidates
    .filter((_, i) => piiSelected.has(i))
    .map((c) => bboxToNormalizedBox(c.bbox, page.width, page.height))
    .filter(Boolean);

  setRedactMode(true, boxes);
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
  setRedactMode(false); // also closes the PII panel - see its own end
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
    redactPanel: document.getElementById("scan-redact-panel"),
    redactOverlay: document.getElementById("scan-redact-overlay"),
    redactCount: document.getElementById("scan-redact-count"),
    redactUndo: document.getElementById("scan-redact-undo"),
    redactApply: document.getElementById("scan-redact-apply"),
    piiPanel: document.getElementById("scan-pii-panel"),
    piiSummary: document.getElementById("scan-pii-summary"),
    piiList: document.getElementById("scan-pii-list"),
    piiRedactSelected: document.getElementById("scan-pii-redact-selected"),
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

  // Anything that changes a page's geometry or which page is selected drops the
  // draft first. Boxes are stored as fractions of the page image, so a rotate or
  // a crop underneath an open draft would leave those fractions pointing at
  // different content than the person drew over - and the overlay itself is
  // sized from the old dimensions. Dropping an unapplied draft costs a redraw;
  // keeping one costs a redaction landing in the wrong place.
  const DROPS_REDACT_DRAFT = new Set([
    "rotate-left", "rotate-right", "crop", "filter-all", "delete-page",
    "add-page", "move-left", "move-right",
  ]);

  elements.root.addEventListener("click", async (event) => {
    const filterButton = event.target.closest("[data-filter]");
    if (filterButton) {
      if (redactMode) setRedactMode(false);
      closePiiPanel();
      await setFilter(filterButton.dataset.filter);
      return;
    }

    const thumb = event.target.closest("[data-page]");
    if (thumb) {
      // A draft belongs to the page it was drawn on. Carrying it to another
      // page would place boxes by coordinate over content nobody chose.
      if (redactMode) setRedactMode(false);
      closePiiPanel();
      selectedPageId = thumb.dataset.page;
      await renderStrip();
      await renderPreview();
      return;
    }

    const action = event.target.closest("[data-scan-action]")?.dataset.scanAction;
    if (!action) return;

    if (redactMode && DROPS_REDACT_DRAFT.has(action)) setRedactMode(false);
    if (piiCandidates.length && DROPS_REDACT_DRAFT.has(action)) closePiiPanel();

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
      case "redact":
        if (selectedPage()) setRedactMode(!redactMode);
        break;
      case "redact-undo":
        draftBoxes.pop();
        renderDraftBoxes();
        break;
      case "redact-apply":
        await applyRedaction();
        break;
      case "redact-cancel":
        setRedactMode(false);
        break;
      case "pii-scan":
        await runPiiScan();
        break;
      case "pii-redact-selected":
        redactSelectedPii();
        break;
      case "pii-cancel":
        closePiiPanel();
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

  // PII candidate checkboxes. `change`, not `click`: a label wrapping the input
  // means clicking the label also fires a synthetic click on the input before
  // the browser has updated `.checked`, so reading `.checked` in a click
  // handler would see the PREVIOUS state.
  elements.piiList?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-pii-index]");
    if (!checkbox) return;
    togglePiiCandidate(Number(checkbox.dataset.piiIndex));
  });

  // Redaction drag. Pointer events rather than mouse events, so a finger on a
  // phone draws a box the same way a mouse does; setPointerCapture keeps the
  // drag alive when it leaves the overlay, which is exactly what happens when
  // someone redacts right up to the edge of a page.
  elements.redactOverlay?.addEventListener("pointerdown", (event) => {
    if (!redactMode) return;
    const page = selectedPage();
    if (!page) return;
    event.preventDefault();
    const rect = previewImageRect(page);
    dragStart = {
      x: (event.clientX - rect.clientLeft) / (rect.width || 1),
      y: (event.clientY - rect.clientTop) / (rect.height || 1),
    };
    elements.redactOverlay.setPointerCapture?.(event.pointerId);
  });

  elements.redactOverlay?.addEventListener("pointermove", (event) => {
    if (!redactMode || !dragStart) return;
    const page = selectedPage();
    if (!page) return;
    const rect = previewImageRect(page);
    const current = {
      x: (event.clientX - rect.clientLeft) / (rect.width || 1),
      y: (event.clientY - rect.clientTop) / (rect.height || 1),
    };
    // The in-progress box is the last entry, replaced on every move rather than
    // appended, so a drag produces one box and not one per pointer sample.
    const live = boxFromDrag(dragStart, current);
    if (dragStart.committed) draftBoxes.pop();
    draftBoxes.push(live);
    dragStart.committed = true;
    renderDraftBoxes();
  });

  const endRedactDrag = () => {
    if (!dragStart) return;
    // A tap with no movement leaves an empty box behind, which would burn as a
    // dot nobody asked for.
    const last = draftBoxes[draftBoxes.length - 1];
    if (dragStart.committed && last && (last.width <= 0.005 || last.height <= 0.005)) draftBoxes.pop();
    dragStart = null;
    renderDraftBoxes();
  };
  elements.redactOverlay?.addEventListener("pointerup", endRedactDrag);
  elements.redactOverlay?.addEventListener("pointercancel", endRedactDrag);

  // The overlay is sized from the preview's live box, so it has to be resized
  // when that box changes - otherwise boxes drawn before a rotation land in the
  // wrong place after it.
  window.addEventListener("resize", () => {
    if (redactMode) positionRedactOverlay();
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
