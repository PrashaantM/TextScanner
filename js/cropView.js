// cropView.js: the "adjust edges" screen - four draggable corners over the
// page, with auto-detection as the starting point.
//
// Auto-detection (js/edgeDetect.js) proposes corners; this is where a person
// corrects them. That division matters, because detection deliberately returns
// null rather than guessing badly, and a scanner app whose auto-crop is
// occasionally wrong is only usable if fixing it is trivial.
//
// Three things make the handles actually usable on a phone, and all three are
// easy to leave out:
//
//   1. **The hit target is much larger than the visual handle.** The dot is
//      ~22px; the touch area is 44px, the platform minimum. A finger cannot hit
//      a 22px target reliably near a screen edge.
//   2. **A magnifier follows the active handle.** A fingertip covers the corner
//      it is placing, so without a loupe the person is positioning something
//      they cannot see. This is the single biggest difference between a crop UI
//      that feels precise and one that feels like guessing.
//   3. **Corners cannot cross each other.** A quad whose corners have swapped
//      produces a self-intersecting shape, and the homography solved from it
//      warps the page inside out. Each corner is constrained to its own
//      quadrant of the frame.
//
// Pointer Events throughout, for the same reason the editor uses them
// (js/editorInteractions.js): one code path for mouse, touch and pencil.

import { getBlob, releaseObjectUrl } from "./store.js";
import { getPage, updatePage, getDocument } from "./documents.js";
import { detectDocument, fullFrameCorners, orderCorners } from "./edgeDetect.js";
import { hapticLight, hapticMedium } from "./haptics.js";
import { goBack } from "./views.js";

// Surfaces that sit above this view and answer Escape before it does - see the
// Escape handler in initCropView.
const OVERLAY_IDS = ["command-palette", "action-sheet", "shortcut-sheet"];

// Visual radius of a handle, in CSS pixels.
const HANDLE_RADIUS = 11;
// Touch slop around it. 44px total is Apple's and Google's stated minimum.
const HANDLE_HIT_RADIUS = 22;
const MAGNIFIER_SIZE = 108;
const MAGNIFIER_ZOOM = 2.4;

let elements = {};
let sourceImage = null;
let sourceUrl = null;
let corners = null;
let currentPage = null;
let currentDoc = null;
let activeHandle = -1;
let onApply = null;

// Maps between the displayed canvas and the original image's pixel space. The
// canvas is laid out to fit the viewport, so every pointer coordinate needs
// converting and every stored corner needs the inverse.
let layout = { scale: 1, offsetX: 0, offsetY: 0, displayWidth: 0, displayHeight: 0 };

function computeLayout() {
  if (!sourceImage || !elements.canvas) return;

  const container = elements.stage.getBoundingClientRect();
  const imageWidth = sourceImage.naturalWidth;
  const imageHeight = sourceImage.naturalHeight;

  // Padding leaves room for handles dragged to the very edge of the image -
  // without it, a corner at (0,0) has half its hit area off-screen.
  const padding = HANDLE_HIT_RADIUS + 6;
  const availableWidth = Math.max(80, container.width - padding * 2);
  const availableHeight = Math.max(80, container.height - padding * 2);

  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  const displayWidth = imageWidth * scale;
  const displayHeight = imageHeight * scale;

  layout = {
    scale,
    offsetX: (container.width - displayWidth) / 2,
    offsetY: (container.height - displayHeight) / 2,
    displayWidth,
    displayHeight,
  };

  // Backing store at device resolution so the page and the handle outlines are
  // sharp on a retina screen; CSS size stays in layout pixels.
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  elements.canvas.width = Math.round(container.width * dpr);
  elements.canvas.height = Math.round(container.height * dpr);
  elements.canvas.style.width = `${container.width}px`;
  elements.canvas.style.height = `${container.height}px`;
  elements.canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

function toDisplay(point) {
  return {
    x: layout.offsetX + point.x * layout.scale,
    y: layout.offsetY + point.y * layout.scale,
  };
}

function toImage(x, y) {
  return {
    x: (x - layout.offsetX) / layout.scale,
    y: (y - layout.offsetY) / layout.scale,
  };
}

// Keeps a corner inside the image and inside its own quadrant, so the quad can
// never self-intersect. `index` is the corner's position in top-left-clockwise
// order.
function constrainCorner(index, point) {
  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;

  let x = Math.min(width, Math.max(0, point.x));
  let y = Math.min(height, Math.max(0, point.y));

  // Minimum separation so opposite edges cannot collapse onto each other.
  const minGap = Math.min(width, height) * 0.08;
  const [tl, tr, br, bl] = corners;

  switch (index) {
    case 0: // top-left: right of nothing, left of top-right; above bottom-left
      x = Math.min(x, tr.x - minGap);
      y = Math.min(y, bl.y - minGap);
      break;
    case 1: // top-right
      x = Math.max(x, tl.x + minGap);
      y = Math.min(y, br.y - minGap);
      break;
    case 2: // bottom-right
      x = Math.max(x, bl.x + minGap);
      y = Math.max(y, tr.y + minGap);
      break;
    case 3: // bottom-left
      x = Math.min(x, br.x - minGap);
      y = Math.max(y, tl.y + minGap);
      break;
    default:
      break;
  }

  return { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
}

function draw() {
  if (!sourceImage || !elements.canvas) return;

  const ctx = elements.canvas.getContext("2d");
  const width = elements.canvas.width / (Math.min(3, window.devicePixelRatio || 1));
  const height = elements.canvas.height / (Math.min(3, window.devicePixelRatio || 1));

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sourceImage, layout.offsetX, layout.offsetY, layout.displayWidth, layout.displayHeight);

  const display = corners.map(toDisplay);

  // Dim everything outside the quad, so the crop reads as "this is what you
  // keep" rather than as four floating dots. Drawn as the frame minus the quad
  // using the even-odd fill rule.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.moveTo(display[0].x, display[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(display[i].x, display[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(10, 10, 16, 0.55)";
  ctx.fill("evenodd");
  ctx.restore();

  // The quad outline.
  ctx.beginPath();
  ctx.moveTo(display[0].x, display[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(display[i].x, display[i].y);
  ctx.closePath();
  ctx.strokeStyle = "#4d9fff";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Edge midpoint marks, which make it obvious the edges themselves are
  // straight lines between corners rather than following the page.
  ctx.fillStyle = "rgba(77, 159, 255, 0.9)";
  for (let i = 0; i < 4; i++) {
    const a = display[i];
    const b = display[(i + 1) % 4];
    ctx.beginPath();
    ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Handles.
  display.forEach((point, index) => {
    const active = index === activeHandle;
    ctx.beginPath();
    ctx.arc(point.x, point.y, HANDLE_RADIUS + (active ? 3 : 0), 0, Math.PI * 2);
    ctx.fillStyle = active ? "#4d9fff" : "#ffffff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = active ? "#ffffff" : "#4d9fff";
    ctx.stroke();
  });

  if (activeHandle >= 0) drawMagnifier(ctx, display[activeHandle], width, height);
}

// The loupe. Positioned away from the finger - on the opposite side of the
// handle from wherever there is room - because a magnifier under the fingertip
// solves nothing.
function drawMagnifier(ctx, point, width, height) {
  const size = MAGNIFIER_SIZE;
  const margin = 12;

  let x = point.x + margin + size / 2;
  let y = point.y - margin - size / 2;
  if (x + size / 2 > width) x = point.x - margin - size / 2;
  if (y - size / 2 < 0) y = point.y + margin + size / 2;
  x = Math.min(width - size / 2 - 4, Math.max(size / 2 + 4, x));
  y = Math.min(height - size / 2 - 4, Math.max(size / 2 + 4, y));

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = "#0a0a10";
  ctx.fill();

  // Re-draw the image, scaled about the handle, so the loupe shows real pixels
  // rather than an upscaled screenshot of the already-dimmed canvas.
  const zoom = MAGNIFIER_ZOOM;
  ctx.translate(x, y);
  ctx.scale(zoom, zoom);
  ctx.translate(-point.x, -point.y);
  ctx.drawImage(sourceImage, layout.offsetX, layout.offsetY, layout.displayWidth, layout.displayHeight);

  // Crosshair at the exact corner position.
  ctx.strokeStyle = "#4d9fff";
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  ctx.moveTo(point.x - 14, point.y);
  ctx.lineTo(point.x + 14, point.y);
  ctx.moveTo(point.x, point.y - 14);
  ctx.lineTo(point.x, point.y + 14);
  ctx.stroke();

  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function handleAt(x, y) {
  let best = -1;
  let bestDistance = HANDLE_HIT_RADIUS;

  corners.map(toDisplay).forEach((point, index) => {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });

  return best;
}

// ---- Pointer handling ----

function onPointerDown(event) {
  if (!sourceImage) return;
  const rect = elements.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const index = handleAt(x, y);
  if (index === -1) return;

  activeHandle = index;
  elements.canvas.setPointerCapture(event.pointerId);
  hapticLight();
  draw();
  event.preventDefault();
}

function onPointerMove(event) {
  if (activeHandle === -1) return;
  const rect = elements.canvas.getBoundingClientRect();
  const point = toImage(event.clientX - rect.left, event.clientY - rect.top);
  corners[activeHandle] = constrainCorner(activeHandle, point);
  draw();
  event.preventDefault();
}

function onPointerUp(event) {
  if (activeHandle === -1) return;
  activeHandle = -1;
  try {
    elements.canvas.releasePointerCapture(event.pointerId);
  } catch {
    // Capture may already have been lost; releasing twice is harmless.
  }
  hapticLight();
  draw();
}

// Keyboard nudging, so the crop is adjustable without a pointer. Tab cycles the
// corner, arrows move it, Shift+arrow moves further.
let keyboardCorner = 0;

function onKeyDown(event) {
  if (!sourceImage) return;

  if (event.key === "Tab" && !event.shiftKey) {
    keyboardCorner = (keyboardCorner + 1) % 4;
    activeHandle = keyboardCorner;
    draw();
    event.preventDefault();
    return;
  }

  const step = event.shiftKey ? 20 : 3;
  const deltas = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  };
  const delta = deltas[event.key];
  if (!delta) return;

  event.preventDefault();
  activeHandle = keyboardCorner;
  const current = corners[keyboardCorner];
  corners[keyboardCorner] = constrainCorner(keyboardCorner, {
    x: current.x + delta.x / layout.scale,
    y: current.y + delta.y / layout.scale,
  });
  draw();
}

// ---- Actions ----

function autoDetect() {
  if (!sourceImage) return;
  const detected = detectDocument(sourceImage);
  if (detected) {
    corners = detected;
    setHint("Edges detected. Drag any corner to adjust.");
    hapticMedium();
  } else {
    corners = fullFrameCorners(sourceImage.naturalWidth, sourceImage.naturalHeight);
    // Honest about the outcome rather than silently doing nothing - a person who
    // taps "Detect edges" and sees no change needs to know it tried.
    setHint("Couldn't find a page edge in this photo - drag the corners to set it yourself.");
  }
  draw();
}

function resetToFull() {
  corners = fullFrameCorners(sourceImage.naturalWidth, sourceImage.naturalHeight);
  setHint("Using the whole image.");
  draw();
  hapticLight();
}

function setHint(message) {
  if (elements.hint) elements.hint.textContent = message;
}

async function apply() {
  if (!sourceImage) return;

  const ordered = orderCorners(corners);
  const isFull =
    Math.abs(ordered[0].x) < 2 &&
    Math.abs(ordered[0].y) < 2 &&
    Math.abs(ordered[2].x - sourceImage.naturalWidth) < 2 &&
    Math.abs(ordered[2].y - sourceImage.naturalHeight) < 2;

  if (onApply) {
    // Capture flow: hand the corners back rather than writing to a page that
    // does not exist yet.
    const callback = onApply;
    onApply = null;
    callback(isFull ? null : ordered);
    return;
  }

  if (currentPage) {
    await updatePage(currentPage.id, { corners: isFull ? null : ordered });
    // The page's derived image is rebuilt by the scan document view, which owns
    // the filter/rotate/crop pipeline - doing it here would duplicate that
    // ordering and the two would drift.
    window.dispatchEvent(new CustomEvent("textscanner:page-cropped", { detail: { pageId: currentPage.id } }));
  }

  goBack();
}

// ---- Lifecycle ----

async function loadSource(blobKey) {
  releaseSource();

  const blob = await getBlob(blobKey);
  if (!blob) return false;

  sourceUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.src = sourceUrl;
  try {
    await img.decode();
  } catch {
    releaseSource();
    return false;
  }
  sourceImage = img;
  return true;
}

function releaseSource() {
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    releaseObjectUrl(sourceUrl);
    sourceUrl = null;
  }
  sourceImage = null;
}

// Opens the crop screen for an existing page.
export async function openCropForPage(docId, pageId) {
  currentDoc = await getDocument(docId);
  currentPage = await getPage(pageId);
  if (!currentPage) return false;

  const ok = await loadSource(currentPage.originalBlobKey || currentPage.blobKey);
  if (!ok) return false;

  computeLayout();

  if (currentPage.corners) {
    corners = currentPage.corners.map((p) => ({ ...p }));
    setHint("Drag any corner to adjust. Tab then arrow keys also work.");
  } else {
    autoDetect();
  }

  draw();
  return true;
}

// Opens the crop screen during capture, before a page exists. `callback`
// receives the chosen corners (or null for the full frame).
export async function openCropForImage(image, callback) {
  releaseSource();
  sourceImage = image;
  currentPage = null;
  currentDoc = null;
  onApply = callback;

  computeLayout();
  autoDetect();
  draw();
  return true;
}

export function closeCrop() {
  releaseSource();
  currentPage = null;
  currentDoc = null;
  corners = null;
  activeHandle = -1;
  onApply = null;
}

export function initCropView() {
  elements = {
    root: document.getElementById("crop-view"),
    stage: document.getElementById("crop-stage"),
    canvas: document.getElementById("crop-canvas"),
    hint: document.getElementById("crop-hint"),
  };

  if (!elements.canvas) return;

  elements.canvas.addEventListener("pointerdown", onPointerDown);
  elements.canvas.addEventListener("pointermove", onPointerMove);
  elements.canvas.addEventListener("pointerup", onPointerUp);
  elements.canvas.addEventListener("pointercancel", onPointerUp);
  elements.canvas.addEventListener("keydown", onKeyDown);

  elements.root?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-crop-action]")?.dataset.cropAction;
    if (!action) return;

    switch (action) {
      case "detect":
        autoDetect();
        break;
      case "reset":
        resetToFull();
        break;
      case "apply":
        await apply();
        break;
      case "cancel":
        cancel();
        break;
      default:
        break;
    }
  });

  // Escape cancels, and on the capture path that is not a convenience - it is
  // the only way a keyboard reaches this screen's Cancel at all. Focus lands on
  // #crop-canvas (data-autofocus), and the corner-cycling handler above
  // preventDefault()s every plain Tab, so Tab never moves off the canvas: six
  // presses, six times still on the canvas, measured rather than assumed. Only
  // Shift+Tab escapes, and it goes BACKWARDS out of the view entirely, past the
  // buttons rather than to them. Tab keeps cycling corners - the canvas's own
  // aria-label promises exactly that, and it is genuinely useful - so the fix
  // is the way out, not the trap. Escape is also what every other dismissible
  // surface in this app already uses (#download-menu, the action sheet, the
  // command palette).
  //
  // Scoped to this view being visible rather than bound globally: every view's
  // markup stays in the document at all times (js/views.js), so an unguarded
  // document-level handler here would fire while someone was pressing Escape
  // at something else entirely.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.root || elements.root.classList.contains("hidden")) return;
    // An overlay ON TOP of this view owns Escape first - dismissing the command
    // palette must not also abandon the capture underneath it. Two checks,
    // because the overlays in this app answer Escape in two different places
    // and one check catches only one of them:
    //
    //   - `defaultPrevented` covers a surface that handles Escape NEARER THE
    //     TARGET than this listener. js/commandPalette.js binds keydown on
    //     #command-palette itself, and focus is in its input - so it closes
    //     itself and calls preventDefault() while the event is still bubbling
    //     UP to here. The id check below cannot see that one: by the time this
    //     runs, the palette is already hidden. Measured, not reasoned about -
    //     an Escape aimed at the palette cancelled the capture underneath it.
    //   - the id check covers surfaces handled by js/app.js's own document-level
    //     listener (the action sheet, the shortcut sheet), which is registered
    //     AFTER this one and so has not run yet. Those are still visible here,
    //     and they do not preventDefault.
    if (event.defaultPrevented) return;
    if (OVERLAY_IDS.some((id) => document.getElementById(id) && !document.getElementById(id).classList.contains("hidden"))) return;
    event.preventDefault();
    cancel();
  });

  // The canvas is sized from its container, so a rotation or window resize has
  // to recompute the layout or the handles end up detached from the image.
  const onResize = () => {
    if (!sourceImage) return;
    computeLayout();
    draw();
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
}

// Cancel, shared by the button and by Escape below so the two can never drift
// into meaning different things.
function cancel() {
  if (onApply) {
    const callback = onApply;
    onApply = null;
    // `undefined` means CANCELLED, and the capture flow treats it as such:
    // nothing is added and nothing is created (js/app.js's
    // addCurrentImageAsPage). It used to be documented as "cancelling during
    // capture keeps the page uncropped rather than abandoning the capture
    // entirely - the photo is already taken", and the caller duly committed
    // the page. That reasoning confuses two different things: the photo being
    // taken, and the person having asked for it to become a document page.
    // Only the second is what this screen is asking about, and Cancel is the
    // answer "no". Applying the whole frame is still one tap away - "Use whole
    // image", then Apply, which hands back `null` rather than `undefined`.
    callback(undefined);
    return;
  }

  goBack();
}
