// commandPalette.js: Cmd/Ctrl+K. Two kinds of result in one list - commands
// (deterministic, always the same six) and documents (a live search over
// getAllDocuments, using the same deriveTitle-based matching js/library.js's
// own search already uses) - shown together because from the user's side
// "do a thing" and "find a thing" are the same gesture: type what you want,
// hit Enter.
//
// See 06-INTERACTION-MODEL-SPEC.md. The standard Spotlight/Linear/Notion/
// Raycast combobox+listbox shape, copied precisely because so many people
// already have it in muscle memory - novelty here would cost more than it's
// worth.

import { LOCAL_KEY_COMMAND_FRECENCY } from "./store.js";

import { getAllDocuments, deriveTitle } from "./documents.js";
import { showView, VIEWS } from "./views.js";

// From js/store.js's localStorage inventory (same try/catch pattern as
// theme.js), so "Delete all local data" clears these usage counts too.
const FRECENCY_KEY = LOCAL_KEY_COMMAND_FRECENCY;

function readFrecency() {
  try {
    return JSON.parse(localStorage.getItem(FRECENCY_KEY) || "{}");
  } catch {
    return {};
  }
}

function bumpFrecency(id) {
  try {
    const counts = readFrecency();
    counts[id] = (counts[id] || 0) + 1;
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(counts));
  } catch {
    // Private browsing - the palette still works, it just doesn't remember order.
  }
}

// Deterministic frequency ranking, not ML - consistent with how the rest of
// this app already does routing (js/coherenceRouter.js's keyword classifier
// is the same philosophy: a rule that's transparent and good enough beats a
// model for a problem this small).
export function buildCommands({ createAndOpenScan, createAndOpenNote, toggleTheme, openShortcutSheet }) {
  return [
    { id: "scan", label: "Scan a document", shortcut: "⌘N", run: createAndOpenScan },
    { id: "note", label: "New note", shortcut: "⌘⇧N", run: createAndOpenNote },
    { id: "library", label: "Go to Library", shortcut: "⌘L", run: () => showView(VIEWS.LIBRARY) },
    { id: "settings", label: "Open Settings", shortcut: "⌘,", run: () => showView(VIEWS.SETTINGS) },
    { id: "theme", label: "Toggle theme", run: toggleTheme },
    { id: "shortcuts", label: "Show keyboard shortcuts", shortcut: "?", run: openShortcutSheet },
  ];
}

// Trashed documents are excluded (queryDocuments's default library view
// excludes them too) - surfacing one here without any "this is in Recently
// Deleted" indication would make it too easy to reopen something you
// deliberately threw away. Matching against deriveTitle rather than the raw
// `title` field is what makes an untitled note findable by its first line,
// exactly like js/library.js's own search already works.
export async function renderPaletteResults(query, commands) {
  const q = query.trim().toLowerCase();
  const frecency = readFrecency();
  const commandHits = commands
    .filter((c) => !q || c.label.toLowerCase().includes(q))
    .sort((a, b) => (frecency[b.id] || 0) - (frecency[a.id] || 0));

  const docs = q ? await getAllDocuments() : [];
  const docHits = docs
    .filter((d) => !d.deletedAt)
    .filter((d) => deriveTitle(d).toLowerCase().includes(q) || (d.searchText || "").toLowerCase().includes(q))
    .slice(0, 6);

  return { commandHits, docHits };
}

export function runCommand(command) {
  bumpFrecency(command.id);
  command.run();
}

// ---- UI orchestration ----

let elements = null;
let commands = [];
let currentResults = { commandHits: [], docHits: [] };
let selectedIndex = 0;

function ensureElements() {
  if (elements) return elements;
  elements = {
    backdrop: document.getElementById("command-palette-backdrop"),
    root: document.getElementById("command-palette"),
    input: document.getElementById("command-palette-input"),
    list: document.getElementById("command-palette-list"),
  };
  return elements;
}

function flatResults() {
  return [
    ...currentResults.commandHits.map((command) => ({ kind: "command", command })),
    ...currentResults.docHits.map((doc) => ({ kind: "document", doc })),
  ];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function entryMarkup(entry, index, selected) {
  const label = entry.kind === "command" ? entry.command.label : deriveTitle(entry.doc);
  const meta = entry.kind === "command" ? entry.command.shortcut || "" : "Document";
  return `<li class="command-palette__item${selected ? " is-selected" : ""}" role="option"
             id="command-palette-option-${index}" aria-selected="${selected}" data-index="${index}">
    <span class="command-palette__label">${escapeHtml(label)}</span>
    ${meta ? `<span class="command-palette__meta">${escapeHtml(meta)}</span>` : ""}
  </li>`;
}

async function renderResults() {
  const el = ensureElements();
  currentResults = await renderPaletteResults(el.input.value, commands);
  const flat = flatResults();
  selectedIndex = flat.length ? Math.min(selectedIndex, flat.length - 1) : 0;

  el.list.innerHTML = flat.length
    ? flat.map((entry, index) => entryMarkup(entry, index, index === selectedIndex)).join("")
    : `<li class="command-palette__empty">No matching commands or documents</li>`;

  el.input.setAttribute("aria-activedescendant", flat.length ? `command-palette-option-${selectedIndex}` : "");
}

function runEntry(entry) {
  if (!entry) return;
  closeCommandPalette();
  if (entry.kind === "command") runCommand(entry.command);
  else showView(VIEWS.DOCUMENT, { id: entry.doc.id });
}

export function isCommandPaletteOpen() {
  const el = ensureElements();
  return !!el.root && !el.root.classList.contains("hidden");
}

export function openCommandPalette() {
  const el = ensureElements();
  if (!el.root) return;
  el.backdrop.classList.remove("hidden");
  el.root.classList.remove("hidden");
  el.input.value = "";
  selectedIndex = 0;
  renderResults();
  el.input.focus();
}

export function closeCommandPalette() {
  const el = ensureElements();
  if (!el.root) return;
  el.backdrop.classList.add("hidden");
  el.root.classList.add("hidden");
}

// `config` is the same shape openShortcutSheet/createAndOpenScan/etc. that
// js/app.js already owns - injected rather than imported, so this module
// never has to reach into the app shell's internals to get them.
export function initCommandPalette(config) {
  commands = buildCommands(config);
  const el = ensureElements();
  if (!el.root) return;

  el.input.addEventListener("input", () => {
    selectedIndex = 0;
    renderResults();
  });
  el.backdrop.addEventListener("click", closeCommandPalette);
  el.list.addEventListener("click", (event) => {
    const item = event.target.closest("[data-index]");
    if (item) runEntry(flatResults()[Number(item.dataset.index)]);
  });
  el.root.addEventListener("keydown", (event) => {
    const flat = flatResults();
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandPalette();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, flat.length - 1);
      renderResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runEntry(flat[selectedIndex]);
    }
  });
}
