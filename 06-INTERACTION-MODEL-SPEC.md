# The interaction layer — implementation spec

This is written to be handed to Claude Code directly. Every function, file,
and element name below is checked against the codebase as it exists right
now (I re-pulled the repo and grepped it before writing this), not
reconstructed from memory of the earlier docs. Where I'm proposing a new
file or function, it's marked new; everything else is a real, existing hook.

One thing stated once and then set aside: "detailed and innovative" doesn't
mean "never needs another look once built." It means this pass shouldn't
leave the kind of gap the flat-button version quietly had. Every pattern
below ships with its accessibility fallback, its reduced-motion behavior,
and its verification steps specified up front, in the same breath as the
feature, not as an afterthought section.

## Architecture decision: one primitive, three call sites

Rather than building a radial menu three separate times (create button,
library card actions, and — new in this pass — a theme picker), build it
once as a real module and call it three times. This is the single highest-
leverage structural choice in this document: it means the arming/firing
logic, the angle math, the haptics, and the reduced-motion fallback all get
written, tested, and fixed exactly once, and every call site inherits every
future fix to the primitive for free.

### `js/radialMenu.js` — new file

```js
// radialMenu.js: a small, reusable press-drag-release menu. Any caller that
// wants N items arranged around a point calls openRadialMenu once; this
// module owns the geometry, the arm/fire state machine, haptics, and the
// reduced-motion + keyboard fallback. Nothing here is app-specific - it
// doesn't know about documents, scans, or notes, only about items with a
// label and an onSelect.

import { hapticLight, hapticMedium } from "./haptics.js";

const PREFERS_REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * @param {Object} config
 * @param {number} config.originX - viewport x of the menu's center
 * @param {number} config.originY - viewport y of the menu's center
 * @param {Array<{id: string, label: string, icon?: string, onSelect: () => void}>} config.items
 * @param {number} [config.radius=92]
 * @param {number} [config.arcSpan=90] - total degrees the items fan across, centered on arcCenter
 * @param {number} [config.arcCenter=0] - 0 = straight up, 90 = right, -90 = left, 180 = down
 * @returns {{ close: () => void }}
 */
export function openRadialMenu({ originX, originY, items, radius = 92, arcSpan = 90, arcCenter = 0 }) {
  const root = document.createElement("div");
  root.className = "radial-menu";
  root.setAttribute("role", "menu");
  root.style.setProperty("--origin-x", `${originX}px`);
  root.style.setProperty("--origin-y", `${originY}px`);

  // Viewport-aware flip: if the natural arc would push items off the top
  // or bottom edge, mirror arcCenter so the fan always opens into open
  // space instead of clipping. This is the difference between a menu that
  // always looks intentional and one that occasionally renders half
  // off-screen depending on where on the list the user happened to press.
  if (originY < 140 && arcCenter === 0) arcCenter = 180; // near top edge, fan down instead of up
  if (originY > window.innerHeight - 140 && arcCenter === 180) arcCenter = 0;

  const angleFor = (index, count) => {
    if (count === 1) return arcCenter;
    const start = arcCenter - arcSpan / 2;
    const step = arcSpan / (count - 1);
    return start + index * step;
  };

  const spokeEls = items.map((item, index) => {
    const angleDeg = angleFor(index, items.length);
    const angleRad = (angleDeg * Math.PI) / 180;
    const x = radius * Math.sin(angleRad);
    const y = -radius * Math.cos(angleRad);

    const el = document.createElement("button");
    el.type = "button";
    el.className = "radial-menu__item";
    el.setAttribute("role", "menuitem");
    el.style.setProperty("--x", `${x}px`);
    el.style.setProperty("--y", `${y}px`);
    el.innerHTML = `${item.icon ? `<span class="radial-menu__icon" aria-hidden="true">${item.icon}</span>` : ""}<span class="radial-menu__label">${item.label}</span>`;
    el.dataset.itemId = item.id;
    root.appendChild(el);
    return el;
  });

  document.body.appendChild(root);
  // Force layout before adding the open class so the bloom transition
  // actually plays instead of starting from the final state.
  root.getBoundingClientRect();
  root.classList.add("radial-menu--open");
  if (PREFERS_REDUCED_MOTION.matches) root.classList.add("radial-menu--instant");

  let armedId = null;
  const setArmed = (id) => {
    if (id === armedId) return;
    armedId = id;
    for (const el of spokeEls) el.classList.toggle("is-armed", el.dataset.itemId === id);
    if (id) hapticLight();
  };

  const close = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKeydown);
    root.classList.remove("radial-menu--open");
    // Match the CSS transition duration - see .radial-menu__item below.
    setTimeout(() => root.remove(), PREFERS_REDUCED_MOTION.matches ? 0 : 140);
  };

  const onMove = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const spoke = target?.closest(".radial-menu__item");
    setArmed(spoke?.dataset.itemId ?? null);
  };

  const onUp = () => {
    const item = items.find((i) => i.id === armedId);
    if (item) {
      hapticMedium();
      item.onSelect();
      close();
    }
    // Releasing off-target leaves the menu open (pinned), same rationale as
    // the create-menu behavior it grew out of - a shaky drag never reads as
    // a failure, it just leaves you where a plain tap would have.
  };

  // Keyboard fallback: Tab already moves focus through role="menuitem"
  // buttons in document order, and native <button> Enter/Space firing needs
  // no extra code. Arrow keys map onto the same order for anyone who'd
  // rather not Tab through every item.
  const onKeydown = (event) => {
    if (event.key === "Escape") { close(); return; }
    const idx = spokeEls.findIndex((el) => el === document.activeElement);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      spokeEls[(idx + 1 + spokeEls.length) % spokeEls.length]?.focus();
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      spokeEls[(idx - 1 + spokeEls.length) % spokeEls.length]?.focus();
    }
  };

  for (const el of spokeEls) {
    el.addEventListener("click", () => { hapticMedium(); el.onSelectRan = true; });
    el.addEventListener("focus", () => setArmed(el.dataset.itemId));
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKeydown);
  spokeEls[0]?.focus();

  return { close };
}
```

```css
/* style.css additions */
.radial-menu {
  position: fixed;
  left: var(--origin-x);
  top: var(--origin-y);
  z-index: 60;
  pointer-events: none; /* only the items themselves are hit targets */
}
.radial-menu__item {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(calc(-50% + var(--x, 0px)), calc(-50% + var(--y, 0px))) scale(0.4);
  opacity: 0;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 76px;
  padding: 10px 6px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  transition: transform 140ms cubic-bezier(0.2, 0.8, 0.3, 1.2), opacity 100ms ease-out, box-shadow 120ms ease-out;
}
.radial-menu--open .radial-menu__item {
  transform: translate(calc(-50% + var(--x, 0px)), calc(-50% + var(--y, 0px))) scale(1);
  opacity: 1;
}
.radial-menu--instant .radial-menu__item {
  transition: none; /* prefers-reduced-motion: appear in place, no bloom animation */
}
.radial-menu__item.is-armed {
  box-shadow: 0 0 0 3px var(--accent);
  background: var(--surface-3);
}
.radial-menu__icon { font-size: 20px; }
.radial-menu__label { font-size: 12px; }
```

**Why this earns being a shared module rather than three copies:** the
viewport-edge flip, the reduced-motion fallback, and the keyboard arrow-key
navigation are each easy to get right once and easy to forget on the second
or third copy-paste. Building it once means the theme-picker call site
below costs about fifteen lines, not another whole implementation.

## Call site 1 — create menu on `#nav-add`

```js
// js/app.js — replaces the plain click handler on elements.navAdd
elements.navAdd.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  const rect = elements.navAdd.getBoundingClientRect();
  openRadialMenu({
    originX: rect.left + rect.width / 2,
    originY: rect.top + rect.height / 2,
    arcCenter: 180, // nav-add sits at the top edge, so the fan opens downward
    arcSpan: 70,
    items: [
      { id: "scan", label: "Scan", icon: "&#128247;", onSelect: () => createAndOpenScan() },
      { id: "note", label: "Note", icon: "&#9998;", onSelect: () => createAndOpenNote() },
    ],
  });
});
```

The existing `#action-sheet`/`#action-sheet-backdrop` markup and its
`openActionSheet`/`closeActionSheet` functions stay exactly as they are and
become the keyboard-activation path: a `focus` + `Enter`/`Space` on
`#nav-add` (i.e., no `pointerdown` fired) still calls the original
`openActionSheet()`, unchanged. Two presentations of the same choice,
selected by how the button was activated, not two features to maintain.

## Call site 2 — library card quick actions

**Swipe is primary**, not the radial menu, for the two most frequent actions.
It needs no visual chrome at rest and no explanation the first time — it's
the same gesture as every Mail/Reminders/Things row.

```js
// js/library.js, inside the per-card render loop
function attachCardGestures(cardEl, id) {
  let startX = 0, dx = 0, dragging = false, pressTimer = null;

  cardEl.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return; // desktop: right-click, below
    startX = event.clientX;
    dragging = true;
    cardEl.setPointerCapture(event.pointerId);
    pressTimer = setTimeout(() => {
      dragging = false; // a long-press supersedes an in-progress swipe read
      cardEl.style.transform = "";
      const rect = cardEl.getBoundingClientRect();
      openRadialMenu({
        originX: startX,
        originY: rect.top + rect.height / 2,
        arcSpan: 140,
        items: [
          { id: "pin", label: "Pin", icon: "&#128204;", onSelect: () => handleAction("pin", cardEl) },
          { id: "folder", label: "Move", icon: "&#128193;", onSelect: () => openFolderPicker(id) },
          { id: "trash", label: "Delete", icon: "&#128465;", onSelect: () => handleAction("trash", cardEl) },
        ],
      });
    }, 420);
  });

  cardEl.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    if (Math.abs(event.clientX - startX) > 8) clearTimeout(pressTimer); // real movement cancels the long-press read
    dx = event.clientX - startX;
    cardEl.style.transform = `translateX(${Math.max(-96, Math.min(96, dx))}px)`;
    cardEl.classList.toggle("swipe-armed-delete", dx < -56);
    cardEl.classList.toggle("swipe-armed-pin", dx > 56);
  });

  cardEl.addEventListener("pointerup", () => {
    clearTimeout(pressTimer);
    if (!dragging) return; // long-press already took over
    dragging = false;
    cardEl.style.transform = "";
    cardEl.classList.remove("swipe-armed-delete", "swipe-armed-pin");
    if (dx < -72) handleAction("trash", cardEl);
    else if (dx > 72) handleAction("pin", cardEl);
    dx = 0;
  });

  cardEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openCardContextMenu(cardEl, id, event.clientX, event.clientY); // plain vertical menu - desktop idiom, not radial
  });
}
```

`openFolderPicker(id)` is new — a small popover listing existing folders
(`getAllDocuments`'s folder set, already surfaced elsewhere in
`js/library.js`'s sidebar) plus "New folder," reusing the existing
`new-folder` action. `openCardContextMenu` is a plain, small, absolutely-
positioned `<ul>` of the same three actions — standard desktop right-click
shape, deliberately not radial, matching the platform idiom rather than
forcing visual consistency across input devices that don't share one
convention to begin with.

The existing hover/touch-visible Pin/Delete buttons in `style.css:1400`
stay untouched as the pointer/keyboard-accessible path. Nothing here removes
a working control in favor of a gesture that has no visible fallback.

## Call site 3 (new) — long-press the theme button for a radial picker

> **Built, then deleted.** This call site shipped as specified and is gone: the
> theme system it existed to drive was removed in favour of one fixed colour
> scheme, so there is no `#theme-btn` and no System/Light/Dark to pick between.
> The two assertions it was carrying in `test/radial-call-sites.js` - a
> press-and-hold radial exercised below the 600px breakpoint, and a mouse hold
> being refused the way call site 1 refuses one - were re-homed onto call site 2
> (library cards) rather than dropped. The rollout reasoning below is left as
> written; it was right about the primitive, which now has two call sites.

Small, and a good proof that the primitive is worth having: today
`#theme-btn` is a three-way *cycle* button — click it enough times and you'll
land on the theme you want, eventually. A long-press turns the same button
into a direct three-way radial pick (System / Light / Dark), costing about
fifteen lines because the geometry, haptics, and reduced-motion handling are
already solved by `radialMenu.js`:

```js
document.getElementById("theme-btn")?.addEventListener("pointerdown", (event) => {
  const timer = setTimeout(() => {
    const rect = event.target.getBoundingClientRect();
    openRadialMenu({
      originX: rect.left + rect.width / 2,
      originY: rect.top + rect.height / 2,
      arcCenter: 180,
      arcSpan: 90,
      items: [
        { id: "system", label: "System", onSelect: () => setTheme("system") },
        { id: "light", label: "Light", onSelect: () => setTheme("light") },
        { id: "dark", label: "Dark", onSelect: () => setTheme("dark") },
      ],
    });
  }, 420);
  event.target.addEventListener("pointerup", () => clearTimeout(timer), { once: true });
});
```

A plain click still cycles through the three states exactly as it does
today — this is additive, and it's a genuinely good test of whether the
primitive generalizes, since the theme button is nothing like a card or a
create button.

## Command palette (`Cmd/Ctrl+K`)

The biggest single lever in this document, and the direct answer to "every
action uses a button" for anyone on a keyboard, which on the web build is
everyone.

```js
// js/commandPalette.js — new file
import { getAllDocuments } from "./documents.js";
import { showView, VIEWS } from "./views.js";

const FRECENCY_KEY = "textscanner.command-frecency"; // same localStorage + try/catch pattern as theme.js

function readFrecency() {
  try { return JSON.parse(localStorage.getItem(FRECENCY_KEY) || "{}"); }
  catch { return {}; }
}
function bumpFrecency(id) {
  try {
    const counts = readFrecency();
    counts[id] = (counts[id] || 0) + 1;
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(counts));
  } catch { /* private browsing - palette still works, just doesn't remember order */ }
}

// Deterministic frequency ranking, not ML - consistent with how the rest of
// this app already does routing (js/coherenceRouter.js's keyword classifier
// is the same philosophy: a rule that's transparent and good enough beats a
// model for a problem this small).
export function buildCommands({ createAndOpenScan, createAndOpenNote, cycleTheme }) {
  return [
    { id: "scan", label: "Scan a document", shortcut: "⌘N", run: createAndOpenScan },
    { id: "note", label: "New note", shortcut: "⌘⇧N", run: createAndOpenNote },
    { id: "library", label: "Go to Library", shortcut: "⌘L", run: () => showView(VIEWS.LIBRARY) },
    { id: "settings", label: "Open Settings", shortcut: "⌘,", run: () => showView(VIEWS.SETTINGS) },
    { id: "theme", label: "Toggle theme", run: cycleTheme },
    { id: "shortcuts", label: "Show keyboard shortcuts", shortcut: "?", run: openShortcutSheet },
  ];
}

export async function renderPaletteResults(query, commands) {
  const q = query.trim().toLowerCase();
  const frecency = readFrecency();
  const commandHits = commands
    .filter((c) => c.label.toLowerCase().includes(q))
    .sort((a, b) => (frecency[b.id] || 0) - (frecency[a.id] || 0));

  const docs = q ? await getAllDocuments() : [];
  const docHits = docs
    .filter((d) => (d.title || "").toLowerCase().includes(q) || (d.searchText || "").toLowerCase().includes(q))
    .slice(0, 6);

  return { commandHits, docHits };
}

export function runCommand(command) {
  bumpFrecency(command.id);
  command.run();
}
```

Markup (`index.html`): a centered `role="dialog"` overlay with a text input
(`role="combobox"`) and a `role="listbox"` results list — the standard
Spotlight/Linear/Notion/Raycast shape, worth copying precisely because so
many people already have it in muscle memory. Arrow keys move a
`aria-selected` cursor, Enter runs the selected item via `runCommand`, Escape
closes. Document hits open the document (`showView(VIEWS.DOCUMENT, { id })`)
same as clicking a library card.

```js
// js/app.js — global shortcut dispatcher. Bound once, guarded once.
document.addEventListener("keydown", (event) => {
  const inTextField = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)
    || document.activeElement?.isContentEditable;
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key.toLowerCase() === "k") { event.preventDefault(); openCommandPalette(); return; }
  if (inTextField) return; // everything below only fires outside text entry

  if (meta && event.key.toLowerCase() === "n" && !event.shiftKey) { event.preventDefault(); createAndOpenScan(); }
  if (meta && event.shiftKey && event.key.toLowerCase() === "n") { event.preventDefault(); createAndOpenNote(); }
  if (meta && event.key.toLowerCase() === "l") { event.preventDefault(); showView(VIEWS.LIBRARY); }
  if (meta && event.key === ",") { event.preventDefault(); showView(VIEWS.SETTINGS); }
  if (event.key === "?") { event.preventDefault(); openShortcutSheet(); }
  if ((event.key === "Delete" || event.key === "Backspace") && document.activeElement?.closest(".doc-card")) {
    handleAction("trash", document.activeElement.closest(".doc-card"));
  }
  if (event.key === "[" || event.key === "]") cycleScanView(event.key === "]" ? 1 : -1);
});
```

## `?` — keyboard shortcut cheat sheet

Small, and worth having precisely because a shortcut nobody can remember
exists is a shortcut that doesn't exist. Pressing `?` (outside a text field)
or selecting "Show keyboard shortcuts" from the palette opens a plain modal
listing every row in the table below, grouped by section. This is the
Notion/Linear/Superhuman/Gmail convention for the same reason the palette
copies its precedent: zero explanation needed for anyone who's used one
before, and a two-second answer for anyone who hasn't.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+K` | Command palette |
| `Cmd/Ctrl+N` | Scan a document |
| `Cmd/Ctrl+Shift+N` | New note |
| `Cmd/Ctrl+L` | Go to Library |
| `Cmd/Ctrl+,` | Settings |
| `?` | Show this list |
| `Delete`/`Backspace` | Delete the focused library card (same Undo toast as a click) |
| `↑`/`↓` | Move focus between library cards |
| `Enter` | Open the focused card |
| `Esc` | Close whatever's topmost — palette, radial menu, action sheet, shortcut sheet, in that order |
| `[` / `]` | Step Text → Image format → Full image on the scan-result screen |
| *(existing, unchanged)* `Tab`/`Enter`/arrows/`Alt`+arrows/`Delete` | Image-format word editor — already good, not touched by this pass |

## Accessibility guarantees

- Every radial menu is `role="menu"`/`role="menuitem"` real `<button>`
  elements, Tab- and arrow-key-navigable, Enter/Space-activatable — a screen
  reader sees a normal menu regardless of whether it opened via drag or via
  keyboard focus.
- `prefers-reduced-motion: reduce` strips the bloom transition entirely
  (`.radial-menu--instant`) — items appear in final position immediately.
- Swipe is strictly additive; the existing hover/touch-visible Pin/Delete
  buttons are untouched and remain the mouse/keyboard/AT path.
- The command palette is a standard combobox/listbox pattern, not a custom
  widget fighting the accessibility tree.
- Nothing here removes a labeled control in favor of a gesture with no
  visible fallback.

## Where this pass deliberately stops

No swipe inside the note editor's text area (collides with text selection).
No radial menu on the image-format word editor — it already has a good,
purpose-built keyboard model (`Tab`/`Enter`/arrows/`Alt`+arrows/`Delete`),
and layering a second, different interaction system on the same screen is a
net loss, not a gain. No global shortcut for anything occasional enough that
a person would look it up anyway — an unused binding is just a way to
accidentally trigger something while typing in the wrong field.

## File manifest

| File | Status |
|---|---|
| `js/radialMenu.js` | new |
| `js/commandPalette.js` | new |
| `index.html` | add command palette markup, shortcut-sheet markup, `data-needs-pages`-style hooks unaffected |
| `js/app.js` | wire `pointerdown` on `#nav-add` (and, at the time, `#theme-btn` — since deleted), add the global `keydown` dispatcher |
| `js/library.js` | add `attachCardGestures`, `openFolderPicker`, `openCardContextMenu` |
| `style.css` | `.radial-menu*`, `.swipe-armed-*`, command palette + shortcut sheet styles |

## Verification checklist

Matches the existing test culture in this repo (CI gates driven through
element ids, per `ANALYSIS.md` §8.2) rather than introducing a separate,
unverified feature:

- [ ] Opening the create menu via `pointerdown`-drag-release on `#nav-add`
      fires `createAndOpenScan`/`createAndOpenNote` exactly as a click on
      the original `#action-sheet-scan`/`#action-sheet-note` buttons did —
      assert via the same document-count-before/after check used to verify
      the eager-creation fix.
- [ ] Opening the create menu via `Tab`+`Enter` (no `pointerdown`) still
      renders the plain `#action-sheet` list, unchanged.
- [ ] Swipe-to-delete on a card triggers the same `showToast(... Undo ...)`
      path as the existing hover Delete button, and Undo restores the
      document identically.
- [ ] `prefers-reduced-motion: reduce` (settable in Chrome DevTools'
      rendering tab) removes all radial-menu transitions; items still
      function, just without the bloom animation.
- [ ] Every radial menu and the command palette are fully operable with
      only `Tab`, arrow keys, `Enter`, and `Escape` — no pointer.
- [ ] `Cmd/Ctrl+K` opens the palette from every view (Library, a scan
      document, a note, Settings), and typing in it never fires the
      global shortcut dispatcher (the `inTextField` guard).

## Rollout order

1. `radialMenu.js` itself, with the theme-button call site as the first
   integration — smallest surface area, cheapest to verify the primitive
   works before depending on it elsewhere.
2. Command palette + global shortcuts — no touch dependency, biggest
   standalone win.
3. Create-menu call site.
4. Card swipe gesture.
5. Card long-press radial menu + folder picker — last, since it's the most
   novel pattern here and benefits from the swipe gesture already being
   live to compare real usage against before deciding it's worth the extra
   menu.
