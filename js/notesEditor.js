// notesEditor.js: the rich-text note editor.
//
// A `contenteditable` surface with a formatting toolbar, checklists, inline
// images, autosave and paste sanitization.
//
// **On `document.execCommand`:** it is deprecated, and it is still what this
// uses. That is a considered choice, not an oversight. The alternatives are:
//
//   - A full editor library (ProseMirror, Quill, TipTap): 100-400 KB, and this
//     app has no bundler and no build step, so it would be vendored wholesale
//     into every page load and into the App Store binary.
//   - A hand-rolled model-based editor: the correct long-term answer and a very
//     large amount of code, because it means reimplementing selection,
//     composition (IME), undo, and every input method by hand.
//
// execCommand is deprecated but universally implemented, and every browser
// vendor has said it is not going anywhere - too much of the web depends on it.
// For a note editor whose output is a small subset of HTML, it is the right size
// of tool. The subset is enforced on the way in (`sanitizeHtml`) rather than
// trusted on the way out, so the deprecation risk is confined to formatting
// commands rather than to correctness or safety.
//
// **Checklists are custom**, because execCommand has no checklist and Notes-style
// tappable checkboxes are one of the features people actually use a notes app
// for. They are `<ul data-checklist>` with `<li data-checked>`, which round-trips
// through sanitization and degrades to a plain list anywhere that markup is
// rendered without this app's CSS.
//
// **Everything is sanitized on the way in.** Pasted content, in particular, is
// arbitrary HTML from any origin. `sanitizeHtml` allows a fixed tag and attribute
// list and drops the rest - this is the app's only untrusted-HTML entry point,
// and it is why the note body can be stored and re-rendered without a second
// thought later.

import { DOC_TYPES, createDocument, updateDocument, reindexDocument, stripMarkup } from "./documents.js";
import { putBlob, getBlobUrl, releaseObjectUrl } from "./store.js";
import { hapticLight } from "./haptics.js";

// The complete set of markup a note may contain. Anything else is unwrapped
// (children kept, element discarded) rather than deleted, so pasting from a
// heavily-styled source keeps the words and loses only the decoration.
const ALLOWED_TAGS = new Set([
  "P", "BR", "DIV", "SPAN",
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL",
  "H1", "H2", "H3",
  "UL", "OL", "LI",
  "BLOCKQUOTE", "PRE", "CODE",
  "A", "IMG", "HR",
]);

// Attributes are allow-listed per tag. Note the absence of `style`, `class` and
// every `on*` handler: inline styles from a pasted document are the main source
// of notes that look broken in dark mode, and event handlers are the obvious
// injection vector.
const ALLOWED_ATTRIBUTES = {
  A: ["href", "target", "rel"],
  IMG: ["src", "alt", "data-blob"],
  LI: ["data-checked"],
  UL: ["data-checklist"],
};

const AUTOSAVE_DELAY = 600;

let elements = {};
let currentDoc = null;
let saveTimer = null;
let dirty = false;
// Object URLs for inline images, revoked when the note closes.
const imageUrls = new Set();
let onDocumentChanged = null;
// Fired exactly once per note: the moment a draft's first real content turns it
// into an actual stored document. Distinct from onDocumentChanged, which fires
// on every subsequent save - callers use this one to announce the creation
// itself (a toast, a chrome update) rather than react to every autosave.
let onDocumentCreated = null;

// ---- Sanitization ----

function isSafeUrl(url) {
  const value = (url || "").trim().toLowerCase();
  // `javascript:` and `data:` (except images, handled separately) are the two
  // schemes that turn a link into code execution.
  if (value.startsWith("javascript:") || value.startsWith("vbscript:")) return false;
  if (value.startsWith("data:") && !value.startsWith("data:image/")) return false;
  return true;
}

export function sanitizeHtml(html) {
  const template = document.createElement("template");
  // A <template> parses markup completely inertly - images do not load,
  // scripts do not run, and nothing is connected to the document.
  template.innerHTML = html || "";

  const walk = (node) => {
    // Iterate over a copy: unwrapping mutates the live child list.
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;

      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }

      const tag = child.tagName;

      if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap rather than remove, so the text survives - except for elements
        // whose content is not text a reader wants.
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED") {
          child.remove();
          continue;
        }
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }

      const allowed = ALLOWED_ATTRIBUTES[tag] || [];
      for (const attr of [...child.attributes]) {
        if (!allowed.includes(attr.name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if ((attr.name === "href" || attr.name === "src") && !isSafeUrl(attr.value)) {
          child.removeAttribute(attr.name);
        }
      }

      // Every external link opens in a new context, and `noopener` prevents the
      // opened page from reaching back through window.opener.
      if (tag === "A" && child.getAttribute("href")) {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }

      walk(child);
    }
  };

  walk(template.content);
  return template.innerHTML;
}

// ---- Save ----

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, AUTOSAVE_DELAY);
  if (elements.status) elements.status.textContent = "Saving...";
}

export async function save() {
  if (!dirty) return;
  clearTimeout(saveTimer);

  // Images are stored as blobs; the editor shows them through object URLs. Swap
  // those back to the durable `data-blob` key before persisting, or a reopened
  // note would reference URLs that were revoked when it closed.
  const body = serializeBody();
  const title = elements.title?.value?.trim() || "";

  // A draft with nothing typed yet has no document behind it (see
  // openNoteDraft). Saving "nothing" must discard silently, not create an
  // "Untitled note" record just because the editor was opened and closed.
  if (!currentDoc && !title && !stripMarkup(body).trim()) {
    dirty = false;
    return;
  }

  const isFirstSave = !currentDoc;

  try {
    if (isFirstSave) {
      // First real content in a draft: this is the one moment a Note actually
      // becomes a document, rather than at the moment the editor was opened.
      currentDoc = await createDocument({ type: DOC_TYPES.NOTE });
    }
    currentDoc = await updateDocument(currentDoc.id, { body, title });
    await reindexDocument(currentDoc.id);
    dirty = false;
    // Fired after the title/body write, not right after createDocument() -
    // otherwise the callback (a "Created ..." toast, in app.js) would always
    // read the brand-new, still-blank record and announce "Untitled note" even
    // when the person had already typed a real title.
    if (isFirstSave) onDocumentCreated?.(currentDoc);
    if (elements.status) {
      elements.status.textContent = "Saved";
      setTimeout(() => {
        if (elements.status && !dirty) elements.status.textContent = "";
      }, 1600);
    }
    onDocumentChanged?.(currentDoc);
  } catch (err) {
    if (elements.status) elements.status.textContent = "Couldn't save - your changes are still on screen.";
    console.error("Note save failed:", err);
  }
}

function serializeBody() {
  const clone = elements.body.cloneNode(true);
  for (const img of clone.querySelectorAll("img[data-blob]")) {
    // Blob key is the durable reference; the object URL is a per-session detail.
    img.removeAttribute("src");
  }
  return sanitizeHtml(clone.innerHTML);
}

// Re-attaches object URLs for stored images after loading a note.
async function hydrateImages() {
  for (const img of elements.body.querySelectorAll("img[data-blob]")) {
    const key = img.getAttribute("data-blob");
    if (!key) continue;
    const url = await getBlobUrl(key);
    if (url) {
      img.src = url;
      imageUrls.add(url);
    } else {
      // The blob is gone (storage cleared, or a partial delete). Leave a
      // visible placeholder rather than a broken-image icon with no explanation.
      img.replaceWith(
        Object.assign(document.createElement("p"), {
          className: "note-missing-image",
          textContent: "[This image is no longer available]",
        })
      );
    }
  }
}

function releaseImages() {
  for (const url of imageUrls) releaseObjectUrl(url);
  imageUrls.clear();
}

// ---- Formatting ----

function exec(command, value = null) {
  elements.body.focus();
  try {
    document.execCommand(command, false, value);
  } catch {
    // A command a browser refuses is a no-op rather than an error - the
    // toolbar simply does nothing for that one button.
  }
  scheduleSave();
  updateToolbarState();
}

// Reflects the caret's current formatting in the toolbar, so the buttons show
// state rather than only issuing commands. Without this, a person cannot tell
// whether they are about to type in bold.
function updateToolbarState() {
  if (!elements.toolbar) return;
  const commands = ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"];
  for (const command of commands) {
    const button = elements.toolbar.querySelector(`[data-command="${command}"]`);
    if (!button) continue;
    let active = false;
    try {
      active = document.queryCommandState(command);
    } catch {
      active = false;
    }
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  const block = elements.toolbar.querySelector("[data-block]");
  if (block) {
    let current = "p";
    try {
      current = (document.queryCommandValue("formatBlock") || "p").toLowerCase();
    } catch {
      current = "p";
    }
    block.value = ["h1", "h2", "h3", "blockquote", "pre"].includes(current) ? current : "p";
  }
}

// Checklists. execCommand has none, so this builds the structure directly and
// toggles items on click.
function insertChecklist() {
  const list = document.createElement("ul");
  list.setAttribute("data-checklist", "");
  const item = document.createElement("li");
  item.setAttribute("data-checked", "false");
  item.appendChild(document.createElement("br"));
  list.appendChild(item);

  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(list);
    // Put the caret inside the new item so typing continues naturally rather
    // than landing after the list.
    const caret = document.createRange();
    caret.setStart(item, 0);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  } else {
    elements.body.appendChild(list);
  }

  elements.body.focus();
  scheduleSave();
}

function handleChecklistClick(event) {
  const item = event.target.closest("li[data-checked]");
  if (!item) return;

  // Only the checkbox area toggles; clicking the text should place the caret,
  // not flip the item. 34px matches the ::before box in style.css.
  const rect = item.getBoundingClientRect();
  const isRtl = getComputedStyle(item).direction === "rtl";
  const offset = isRtl ? rect.right - event.clientX : event.clientX - rect.left;
  if (offset > 34) return;

  event.preventDefault();
  const checked = item.getAttribute("data-checked") === "true";
  item.setAttribute("data-checked", String(!checked));
  hapticLight();
  scheduleSave();
}

// Enter inside a checklist continues the list; Enter on an empty item ends it.
// This is the behaviour every notes app has and its absence is immediately
// noticeable.
function handleKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey) return;

  const selection = window.getSelection();
  if (!selection?.rangeCount) return;

  const node = selection.getRangeAt(0).startContainer;
  const item = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest("li[data-checked]");
  if (!item) return;

  const isEmpty = !item.textContent.trim();
  event.preventDefault();

  const list = item.parentElement;

  if (isEmpty) {
    // Break out of the list into a fresh paragraph.
    const paragraph = document.createElement("p");
    paragraph.appendChild(document.createElement("br"));
    list.parentNode.insertBefore(paragraph, list.nextSibling);
    item.remove();
    if (!list.children.length) list.remove();

    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    const next = document.createElement("li");
    next.setAttribute("data-checked", "false");
    next.appendChild(document.createElement("br"));
    list.insertBefore(next, item.nextSibling);

    const range = document.createRange();
    range.setStart(next, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  scheduleSave();
}

// Paste is the one place arbitrary external HTML enters a note, so it is
// intercepted and sanitized rather than allowed through the browser's default
// handling.
function handlePaste(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const files = [...(clipboard.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    event.preventDefault();
    for (const file of files) insertImageFile(file);
    return;
  }

  const html = clipboard.getData("text/html");
  if (html) {
    event.preventDefault();
    // insertHTML is applied to already-sanitized markup, so the editor's own
    // undo stack still works and the caret lands where it should.
    exec("insertHTML", sanitizeHtml(html));
    return;
  }

  const text = clipboard.getData("text/plain");
  if (text) {
    event.preventDefault();
    exec("insertText", text);
  }
}

export async function insertImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;

  const key = await putBlob(file);
  const url = await getBlobUrl(key);
  if (!url) return;
  imageUrls.add(url);

  const img = document.createElement("img");
  img.src = url;
  img.setAttribute("data-blob", key);
  img.alt = file.name || "Attached image";

  const selection = window.getSelection();
  if (selection?.rangeCount && elements.body.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    elements.body.appendChild(img);
  }

  scheduleSave();
}

// Drops recognized text from a scan into the note. The bridge between the two
// halves of this app: scan something, then keep working with it as text.
export function insertText(text) {
  if (!text) return;
  elements.body.focus();
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split("\n").map((line) => escapeForHtml(line)).join("<br>")}</p>`)
    .join("");
  exec("insertHTML", paragraphs);
}

function escapeForHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- Word count ----

function updateStats() {
  if (!elements.stats) return;
  const text = stripMarkup(elements.body.innerHTML);
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const characters = text.length;
  elements.stats.textContent = words
    ? `${words} word${words === 1 ? "" : "s"} · ${characters} character${characters === 1 ? "" : "s"}`
    : "";
}

// ---- Lifecycle ----

export async function openNote(doc, { onChanged } = {}) {
  await closeNote();

  currentDoc = doc;
  onDocumentChanged = onChanged;
  dirty = false;

  elements.title.value = doc.title || "";
  elements.body.innerHTML = sanitizeHtml(doc.body || "");
  await hydrateImages();
  updateStats();
  updateToolbarState();

  if (elements.status) elements.status.textContent = "";
}

// Opens a blank note with no backing document yet. save() creates one the
// first time there is real content to save; navigating away empty just
// discards the draft, which is the fix for the app silently littering the
// library with "Untitled note" on every tap of the Note button.
export async function openNoteDraft({ onChanged, onCreated } = {}) {
  await closeNote();

  currentDoc = null;
  onDocumentChanged = onChanged;
  onDocumentCreated = onCreated;
  dirty = false;

  elements.title.value = "";
  elements.body.innerHTML = "";
  updateStats();
  updateToolbarState();

  if (elements.status) elements.status.textContent = "";
}

export async function closeNote() {
  if (dirty) await save();
  clearTimeout(saveTimer);
  releaseImages();
  currentDoc = null;
  onDocumentChanged = null;
  onDocumentCreated = null;
  dirty = false;
}

export function getCurrentNote() {
  return currentDoc;
}

export function initNotesEditor() {
  elements = {
    root: document.getElementById("note-editor"),
    title: document.getElementById("note-title"),
    body: document.getElementById("note-body"),
    toolbar: document.getElementById("note-toolbar"),
    status: document.getElementById("note-status"),
    stats: document.getElementById("note-stats"),
    imageInput: document.getElementById("note-image-input"),
  };

  if (!elements.body) return;

  elements.title.addEventListener("input", () => {
    scheduleSave();
    // Guarded: a draft (see openNoteDraft) has no document yet until the
    // debounced save below actually creates one, and "the document changed"
    // doesn't mean anything before that - onDocumentCreated covers the moment
    // it's created, and onDocumentChanged resumes firing on every edit after.
    if (currentDoc) onDocumentChanged?.(currentDoc);
  });

  elements.body.addEventListener("input", () => {
    scheduleSave();
    updateStats();
  });

  elements.body.addEventListener("paste", handlePaste);
  elements.body.addEventListener("keydown", handleKeydown);
  elements.body.addEventListener("click", handleChecklistClick);

  // Toolbar state follows the caret, not just explicit commands.
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === elements.body) updateToolbarState();
  });

  elements.toolbar?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-command], [data-action]");
    if (!button) return;
    event.preventDefault();

    if (button.dataset.command) {
      exec(button.dataset.command, button.dataset.value || null);
      hapticLight();
      return;
    }

    switch (button.dataset.action) {
      case "checklist":
        insertChecklist();
        hapticLight();
        break;
      case "insert-image":
        elements.imageInput?.click();
        break;
      case "link": {
        const url = window.prompt("Link address");
        if (url && isSafeUrl(url)) exec("createLink", url);
        break;
      }
      case "clear-format":
        exec("removeFormat");
        break;
      default:
        break;
    }
  });

  elements.toolbar?.addEventListener("change", (event) => {
    const select = event.target.closest("[data-block]");
    if (!select) return;
    // <p> must be passed as the tag name for formatBlock to un-set a heading.
    exec("formatBlock", `<${select.value}>`);
  });

  elements.imageInput?.addEventListener("change", async () => {
    for (const file of elements.imageInput.files || []) await insertImageFile(file);
    elements.imageInput.value = "";
  });

  // A note must not be lost to a closed tab mid-edit.
  window.addEventListener("beforeunload", () => {
    if (dirty) save();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) save();
  });
}
