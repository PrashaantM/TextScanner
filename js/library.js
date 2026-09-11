// library.js: the home screen. Every document, searchable, foldered, tagged.
//
// This is the Notes-app surface: a list of everything, sorted by recency with
// pinned items first, filtered by folder or tag, searched across full text, and
// with a Recently Deleted that actually holds things rather than pretending to.
//
// Two performance decisions shape the whole file, both driven by the fact that a
// scan document's pages are megabytes each:
//
//   1. **Thumbnails are their own small blobs.** Drawing a list never touches a
//      full-resolution page. See js/store.js's schema note.
//   2. **Thumbnails load lazily, through IntersectionObserver.** A library of
//      300 documents would otherwise issue 300 IndexedDB reads and hold 300
//      object URLs on first paint. Here, roughly a screenful loads, and object
//      URLs are revoked as cards scroll away - without that, scrolling a large
//      library leaks tens of megabytes with no visible symptom until the tab
//      dies.
//
// Rendering is full-innerHTML-per-card rather than a diffing reconciler, which
// is the right trade at this scale: the list is at most a few hundred rows, it
// re-renders only on an explicit user action (search, filter, delete), and a
// reconciler would be more code than the entire view. All interpolated values go
// through `escapeHtml`, and the one place user text could reach markup - the
// search excerpt - is highlighted by splitting on the match rather than by
// injecting markup around it.

import {
  DOC_TYPES,
  getDocument,
  getAllDocuments,
  queryDocuments,
  deriveTitle,
  searchExcerpt,
  getFolders,
  getAllTags,
  createFolder,
  deleteFolder,
  renameFolder,
  trashDocument,
  restoreDocument,
  purgeDocument,
  emptyTrash,
  updateDocument,
} from "./documents.js";
import { getBlobUrl, releaseObjectUrl } from "./store.js";
import { showView, VIEWS } from "./views.js";
import { hapticLight } from "./haptics.js";
import { showToast } from "./toast.js";

// Filter state. Kept in the module rather than in the DOM so a re-render after
// an edit cannot silently drop which folder the person was looking at.
const state = {
  search: "",
  folderId: undefined, // undefined = all folders; null = documents with no folder
  tag: null,
  trash: false,
  typeFilter: null,
  layout: "list", // 'list' | 'grid'
  scrollTop: 0,
};

let elements = {};
let thumbObserver = null;
// Every object URL this view created, so they can be revoked on teardown and as
// cards leave the viewport.
const cardUrls = new Map();

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Relative dates, because "2 hours ago" is what a person actually wants from a
// list sorted by recency. Falls back to an absolute date past a week, where
// relative phrasing stops being informative ("37 days ago" is not useful).
export function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "Just now";
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (seconds < 172800) return "Yesterday";
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

// Splits an excerpt around the search match and escapes each part separately,
// so the highlight is real markup and the surrounding text cannot become markup.
// Wrapping the match in <mark> by string replacement would let a document
// containing "<script" through.
function highlightExcerpt(excerpt, search) {
  const needle = search.trim();
  if (!needle) return escapeHtml(excerpt);

  const lower = excerpt.toLowerCase();
  const target = needle.toLowerCase();
  let index = lower.indexOf(target);
  if (index === -1) return escapeHtml(excerpt);

  let out = "";
  let cursor = 0;
  while (index !== -1) {
    out += escapeHtml(excerpt.slice(cursor, index));
    out += `<mark>${escapeHtml(excerpt.slice(index, index + needle.length))}</mark>`;
    cursor = index + needle.length;
    index = lower.indexOf(target, cursor);
  }
  out += escapeHtml(excerpt.slice(cursor));
  return out;
}

function documentIcon(doc) {
  if (doc.type === DOC_TYPES.SCAN) {
    const count = (doc.pageIds || []).length;
    return `<span class="doc-card__badge" aria-hidden="true">${count || 0}</span>`;
  }
  return `<span class="doc-card__badge doc-card__badge--note" aria-hidden="true">&#9998;</span>`;
}

function cardMarkup(doc) {
  const title = deriveTitle(doc);
  const excerpt = state.search ? searchExcerpt(doc, state.search) : (doc.searchText || "").slice(0, 140);
  const pageCount = (doc.pageIds || []).length;
  const meta =
    doc.type === DOC_TYPES.SCAN
      ? `${pageCount} page${pageCount === 1 ? "" : "s"} &middot; ${formatDate(doc.updatedAt)}`
      : formatDate(doc.updatedAt);

  const tags = (doc.tags || [])
    .slice(0, 3)
    .map((tag) => `<span class="doc-card__tag">#${escapeHtml(tag)}</span>`)
    .join("");

  const actions = state.trash
    ? `<button class="doc-card__action" data-action="restore" data-id="${escapeHtml(doc.id)}" type="button">Restore</button>
       <button class="doc-card__action doc-card__action--danger" data-action="purge" data-id="${escapeHtml(doc.id)}" type="button">Delete now</button>`
    : `<button class="doc-card__action" data-action="pin" data-id="${escapeHtml(doc.id)}" type="button" aria-pressed="${!!doc.pinned}">${doc.pinned ? "Unpin" : "Pin"}</button>
       <button class="doc-card__action doc-card__action--danger" data-action="trash" data-id="${escapeHtml(doc.id)}" type="button">Delete</button>`;

  return `
    <article class="doc-card${doc.pinned && !state.trash ? " is-pinned" : ""}" data-id="${escapeHtml(doc.id)}" data-type="${escapeHtml(doc.type)}">
      <button class="doc-card__open" data-action="open" data-id="${escapeHtml(doc.id)}" type="button">
        <span class="doc-card__thumb" data-thumb="${escapeHtml(doc.thumbKey || "")}">${documentIcon(doc)}</span>
        <span class="doc-card__body">
          <span class="doc-card__title">${escapeHtml(title)}</span>
          <span class="doc-card__excerpt">${highlightExcerpt(excerpt, state.search)}</span>
          <span class="doc-card__meta">${meta}${doc.pinned && !state.trash ? ' <span class="doc-card__pin" aria-label="Pinned">&#9733;</span>' : ""}</span>
          ${tags ? `<span class="doc-card__tags">${tags}</span>` : ""}
        </span>
      </button>
      <div class="doc-card__actions">${actions}</div>
    </article>`;
}

// Lazily attaches thumbnails as cards scroll into view, and releases them as
// cards scroll out. The release half is the part that matters: without it a
// long scroll accumulates object URLs for every card ever seen.
function setupThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  if (typeof IntersectionObserver === "undefined") return;

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        const key = el.dataset.thumb;
        if (!key) continue;

        if (entry.isIntersecting) {
          if (cardUrls.has(el)) continue;
          // Marked before the await so two rapid intersections cannot both
          // start a load for the same element.
          cardUrls.set(el, null);
          getBlobUrl(key).then((url) => {
            if (!url) {
              cardUrls.delete(el);
              return;
            }
            // The element may have scrolled away, or the list re-rendered,
            // while the read was in flight.
            if (!cardUrls.has(el) || !el.isConnected) {
              releaseObjectUrl(url);
              cardUrls.delete(el);
              return;
            }
            cardUrls.set(el, url);
            el.style.backgroundImage = `url("${url}")`;
            el.classList.add("has-thumb");
          });
        } else {
          const url = cardUrls.get(el);
          if (url) {
            releaseObjectUrl(url);
            el.style.backgroundImage = "";
            el.classList.remove("has-thumb");
          }
          cardUrls.delete(el);
        }
      }
    },
    { rootMargin: "200px" }
  );

  for (const el of elements.list.querySelectorAll("[data-thumb]")) {
    if (el.dataset.thumb) thumbObserver.observe(el);
  }
}

function releaseAllThumbs() {
  for (const [el, url] of cardUrls) {
    if (url) releaseObjectUrl(url);
    if (el?.style) el.style.backgroundImage = "";
  }
  cardUrls.clear();
}

function emptyStateMarkup() {
  if (state.trash) {
    return `<div class="library-empty">
      <p class="library-empty__title">Recently Deleted is empty</p>
      <p class="library-empty__hint">Documents you delete stay here for 30 days before they're removed for good.</p>
    </div>`;
  }
  if (state.search) {
    return `<div class="library-empty">
      <p class="library-empty__title">No results for &ldquo;${escapeHtml(state.search)}&rdquo;</p>
      <p class="library-empty__hint">Search looks inside scanned text as well as titles and tags.</p>
    </div>`;
  }
  if (state.tag) {
    return `<div class="library-empty">
      <p class="library-empty__title">Nothing tagged #${escapeHtml(state.tag)}</p>
    </div>`;
  }
  return `<div class="library-empty">
    <p class="library-empty__title">Nothing here yet</p>
    <p class="library-empty__hint">Scan a document or start a note &mdash; everything you make is saved on this device.</p>
    <div class="library-empty__actions">
      <button class="btn btn--primary" data-action="new-scan" type="button">Scan a document</button>
      <button class="btn btn--secondary" data-action="new-note" type="button">New note</button>
    </div>
  </div>`;
}

async function renderSidebar() {
  const [folders, tags] = await Promise.all([getFolders(), getAllTags()]);
  const docs = await getAllDocuments();

  const counts = {
    all: docs.filter((d) => !d.deletedAt).length,
    notes: docs.filter((d) => !d.deletedAt && d.type === DOC_TYPES.NOTE).length,
    scans: docs.filter((d) => !d.deletedAt && d.type === DOC_TYPES.SCAN).length,
    trash: docs.filter((d) => d.deletedAt).length,
  };

  const isAll = state.folderId === undefined && !state.tag && !state.trash && !state.typeFilter;

  const folderItems = folders
    .map((folder) => {
      const count = docs.filter((d) => !d.deletedAt && d.folderId === folder.id).length;
      const active = state.folderId === folder.id;
      return `<li>
        <button class="library-nav__item${active ? " is-active" : ""}" data-action="folder" data-id="${escapeHtml(folder.id)}" type="button">
          <span class="library-nav__label">${escapeHtml(folder.name)}</span>
          <span class="library-nav__count">${count}</span>
        </button>
        <button class="library-nav__edit" data-action="folder-menu" data-id="${escapeHtml(folder.id)}" type="button" aria-label="Rename or delete ${escapeHtml(folder.name)}">&#8942;</button>
      </li>`;
    })
    .join("");

  const tagItems = tags
    .slice(0, 24)
    .map(
      (tag) =>
        `<button class="library-tag${state.tag === tag.name ? " is-active" : ""}" data-action="tag" data-tag="${escapeHtml(tag.name)}" type="button">#${escapeHtml(tag.name)} <span>${tag.count}</span></button>`
    )
    .join("");

  elements.sidebar.innerHTML = `
    <nav class="library-nav" aria-label="Library filters">
      <ul class="library-nav__list">
        <li><button class="library-nav__item${isAll ? " is-active" : ""}" data-action="all" type="button">
          <span class="library-nav__label">All documents</span><span class="library-nav__count">${counts.all}</span></button></li>
        <li><button class="library-nav__item${state.typeFilter === DOC_TYPES.NOTE ? " is-active" : ""}" data-action="type" data-type="note" type="button">
          <span class="library-nav__label">Notes</span><span class="library-nav__count">${counts.notes}</span></button></li>
        <li><button class="library-nav__item${state.typeFilter === DOC_TYPES.SCAN ? " is-active" : ""}" data-action="type" data-type="scan" type="button">
          <span class="library-nav__label">Scans</span><span class="library-nav__count">${counts.scans}</span></button></li>
      </ul>

      <div class="library-nav__section">
        <h3 class="library-nav__heading">Folders</h3>
        <ul class="library-nav__list">${folderItems || '<li class="library-nav__empty">No folders yet</li>'}</ul>
        <button class="library-nav__add" data-action="new-folder" type="button">+ New folder</button>
      </div>

      ${tags.length ? `<div class="library-nav__section"><h3 class="library-nav__heading">Tags</h3><div class="library-tags">${tagItems}</div></div>` : ""}

      <div class="library-nav__section">
        <ul class="library-nav__list">
          <li><button class="library-nav__item${state.trash ? " is-active" : ""}" data-action="show-trash" type="button">
            <span class="library-nav__label">Recently Deleted</span><span class="library-nav__count">${counts.trash}</span></button></li>
        </ul>
      </div>
    </nav>`;
}

export async function renderLibrary() {
  if (!elements.list) return;

  releaseAllThumbs();

  const docs = await getAllDocuments();
  const filtered = queryDocuments(docs, {
    search: state.search,
    folderId: state.folderId,
    tag: state.tag,
    trash: state.trash,
    type: state.typeFilter,
  });

  elements.list.className = `library-list library-list--${state.layout}`;
  elements.list.innerHTML = filtered.length ? filtered.map(cardMarkup).join("") : emptyStateMarkup();

  elements.count.textContent = filtered.length
    ? `${filtered.length} document${filtered.length === 1 ? "" : "s"}`
    : "";

  elements.emptyTrash.classList.toggle("hidden", !state.trash || !filtered.length);

  await renderSidebar();
  setupThumbObserver();
}

// ---- Actions ----

async function handleAction(action, target) {
  const id = target.dataset.id;

  switch (action) {
    case "open":
      hapticLight();
      showView(VIEWS.DOCUMENT, { id });
      return true;

    case "pin": {
      const docs = await getAllDocuments();
      const doc = docs.find((d) => d.id === id);
      if (doc) await updateDocument(id, { pinned: !doc.pinned });
      hapticLight();
      return true;
    }

    case "trash": {
      // Deleting had no on-screen acknowledgment that anything reversible had
      // happened - the card just vanished (see 01-UX-FINDINGS-AND-FIX-PLAN.md
      // §1.4). It already went to Recently Deleted rather than being purged;
      // the toast is what makes that safety net discoverable in the moment
      // instead of only to someone who already knew to go look for it.
      const doc = await getDocument(id);
      const title = doc ? deriveTitle(doc) : "Document";
      await trashDocument(id);
      hapticLight();
      showToast(`Deleted "${title}"`, {
        actionLabel: "Undo",
        onAction: async () => {
          await restoreDocument(id);
          await renderLibrary();
        },
      });
      return true;
    }

    case "restore":
      await restoreDocument(id);
      return true;

    case "purge": {
      // Irreversible, and the only place in the library that is - so it asks,
      // and names the document rather than saying "this item".
      const docs = await getAllDocuments();
      const doc = docs.find((d) => d.id === id);
      const title = doc ? deriveTitle(doc) : "this document";
      if (!window.confirm(`Delete "${title}" permanently? This can't be undone.`)) return false;
      await purgeDocument(id);
      return true;
    }

    case "all":
      state.folderId = undefined;
      state.tag = null;
      state.trash = false;
      state.typeFilter = null;
      return true;

    case "type":
      state.typeFilter = state.typeFilter === target.dataset.type ? null : target.dataset.type;
      state.trash = false;
      return true;

    case "folder":
      state.folderId = state.folderId === id ? undefined : id;
      state.trash = false;
      state.tag = null;
      return true;

    case "tag":
      state.tag = state.tag === target.dataset.tag ? null : target.dataset.tag;
      state.trash = false;
      return true;

    // Named distinctly from the "trash" action above, which moves ONE document
    // to the trash. Two cases with the same label made the second unreachable.
    case "show-trash":
      state.trash = true;
      state.folderId = undefined;
      state.tag = null;
      state.typeFilter = null;
      return true;

    case "new-folder": {
      const name = window.prompt("Folder name");
      if (!name || !name.trim()) return false;
      await createFolder(name);
      return true;
    }

    case "folder-menu": {
      const choice = window.prompt('Type a new name for this folder, or "delete" to remove it (documents inside are kept).');
      if (choice === null) return false;
      if (choice.trim().toLowerCase() === "delete") {
        const moved = await deleteFolder(id);
        if (moved) window.alert(`Folder deleted. ${moved} document${moved === 1 ? "" : "s"} moved out of it.`);
        if (state.folderId === id) state.folderId = undefined;
      } else if (choice.trim()) {
        await renameFolder(id, choice);
      }
      return true;
    }

    default:
      return false;
  }
}

export function initLibrary({ onNewNote, onNewScan } = {}) {
  elements = {
    root: document.getElementById("view-library"),
    list: document.getElementById("library-list"),
    sidebar: document.getElementById("library-sidebar"),
    search: document.getElementById("library-search"),
    count: document.getElementById("library-count"),
    layoutBtn: document.getElementById("library-layout-btn"),
    emptyTrash: document.getElementById("library-empty-trash"),
    clearSearch: document.getElementById("library-clear-search"),
  };

  if (!elements.list) return;

  // Search is debounced because it re-reads every document and re-renders the
  // list; running that per keystroke on a large library is visibly laggy on a
  // phone. 140 ms is below the threshold where typing feels disconnected from
  // results and comfortably above a fast typist's inter-key interval.
  let searchTimer = null;
  elements.search?.addEventListener("input", () => {
    state.search = elements.search.value;
    elements.clearSearch?.classList.toggle("hidden", !state.search);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderLibrary, 140);
  });

  elements.clearSearch?.addEventListener("click", () => {
    elements.search.value = "";
    state.search = "";
    elements.clearSearch.classList.add("hidden");
    renderLibrary();
    elements.search.focus();
  });

  elements.layoutBtn?.addEventListener("click", () => {
    state.layout = state.layout === "list" ? "grid" : "list";
    elements.layoutBtn.textContent = state.layout === "list" ? "Grid" : "List";
    elements.layoutBtn.setAttribute("aria-label", `Switch to ${state.layout === "list" ? "grid" : "list"} view`);
    renderLibrary();
  });

  elements.emptyTrash?.addEventListener("click", async () => {
    if (!window.confirm("Permanently delete everything in Recently Deleted? This can't be undone.")) return;
    const removed = await emptyTrash();
    if (removed) await renderLibrary();
  });

  // One delegated listener for the whole view. The list is re-rendered
  // wholesale on every change, so per-card listeners would have to be
  // re-attached each time and any missed removal would leak.
  elements.root?.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;

    if (action === "new-note") {
      onNewNote?.();
      return;
    }
    if (action === "new-scan") {
      onNewScan?.();
      return;
    }

    const shouldRerender = await handleAction(action, target);
    if (shouldRerender) await renderLibrary();
  });

  // Remember where the library was scrolled to, so returning from a document
  // lands where the person left rather than at the top.
  window.addEventListener("scroll", () => {
    if (document.body.dataset.activeView === "library") state.scrollTop = window.scrollY;
  });
}

export function restoreLibraryScroll() {
  if (state.scrollTop) window.scrollTo({ top: state.scrollTop });
}

export function teardownLibrary() {
  releaseAllThumbs();
  thumbObserver?.disconnect();
  thumbObserver = null;
}

export function getLibraryState() {
  return { ...state };
}
