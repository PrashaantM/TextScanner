// radialMenu.js: a small, reusable press-drag-release menu. Any caller that
// wants N items arranged around a point calls openRadialMenu once; this
// module owns the geometry, the arm/fire state machine, haptics, and the
// reduced-motion + keyboard fallback. Nothing here is app-specific - it
// doesn't know about documents, scans, or notes, only about items with a
// label and an onSelect.
//
// One primitive, several call sites (js/app.js's "+" button and theme button,
// js/library.js's card long-press) - see 06-INTERACTION-MODEL-SPEC.md. Building
// the viewport-edge flip, the reduced-motion fallback, and the keyboard
// arrow-key navigation once here means every call site inherits them for
// free instead of risking a slightly-different, slightly-wrong copy at each.

import { hapticLight, hapticMedium } from "./haptics.js";

// Queried fresh on every read rather than cached as a MediaQueryList at module
// load, which is what this used to do:
//
//     const PREFERS_REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
//
// On WebKit that cached object's .matches stays at whatever it was when the
// module loaded, so someone who turned on Reduce Motion in System Settings
// while the app was open kept getting the bloom animation until they reloaded -
// while a fresh matchMedia() call in the same page read true. Chromium and
// Firefox both updated the cached list; WebKit did not, and WebKit is the
// engine family the iOS build runs inside, on the platform where that
// preference matters most.
//
// matchMedia() is cheap and this is called twice per menu open, so there is no
// reason to hold the object at all. Nothing else in js/ matchMedia's anything.
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
// Must equal --motion-bloom in style.css, which is what .radial-menu__item's
// transform transition uses. If they drift, the menu is removed from the DOM
// either mid-close (too short) or after a visible dead pause (too long).
const CLOSE_TRANSITION_MS = 140;

/**
 * @param {Object} config
 * @param {number} config.originX - viewport x of the menu's center
 * @param {number} config.originY - viewport y of the menu's center
 * @param {Element} [config.originEl] - the element the opening gesture began
 *   on, if any. Used only to swallow a single stray "click" that a browser
 *   can synthesize on that element after a press-drag-release selection
 *   (a real risk for a mouse that presses, holds, and releases without
 *   moving far enough to read as a drag) - harmless to omit, but prevents a
 *   selection from also re-triggering whatever plain click handler the
 *   origin element already has.
 * @param {Array<{id: string, label: string, icon?: string, onSelect: () => void}>} config.items
 * @param {number} [config.radius=92]
 * @param {number} [config.arcSpan=90] - total degrees the items fan across, centered on arcCenter
 * @param {number} [config.arcCenter=0] - 0 = straight up, 90 = right, -90 = left, 180 = down
 * @returns {{ close: () => void }}
 */
export function openRadialMenu({ originX, originY, originEl, items, radius = 92, arcSpan = 90, arcCenter = 0 }) {
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
  if (prefersReducedMotion()) root.classList.add("radial-menu--instant");

  let armedId = null;
  let closed = false;
  const setArmed = (id) => {
    if (id === armedId) return;
    armedId = id;
    for (const el of spokeEls) el.classList.toggle("is-armed", el.dataset.itemId === id);
    if (id) hapticLight();
  };

  // Swallows exactly one "click" on the origin element, so a mouse press
  // that opened this menu and released over a spoke without ever reading as
  // a drag can't also fire the origin's own plain click handler right after
  // a selection already ran. A no-op if nothing ever follows (the common
  // touch case, where no synthetic click would have fired anyway).
  const swallowNextClick = () => {
    if (!originEl) return;
    const swallow = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    originEl.addEventListener("click", swallow, { capture: true, once: true });
    // A real browser synthesizes the stray click (a mouse press+release that
    // never read as a drag) within the same interaction, not hundreds of ms
    // later - a real user reactivating the same origin element shortly after
    // a selection (Tab back to it, press Enter again) is a legitimate,
    // unrelated click that this must not eat. 60ms comfortably covers the
    // former without meaningfully risking the latter.
    setTimeout(() => originEl.removeEventListener("click", swallow, { capture: true }), 60);
  };

  const select = (item) => {
    if (!item || closed) return;
    hapticMedium();
    swallowNextClick();
    close();
    item.onSelect();
  };

  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKeydown);
    root.classList.remove("radial-menu--open");
    setTimeout(() => root.remove(), prefersReducedMotion() ? 0 : CLOSE_TRANSITION_MS);
  }

  const onMove = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const spoke = target?.closest(".radial-menu__item");
    setArmed(spoke?.dataset.itemId ?? null);
  };

  const onUp = () => {
    const item = items.find((i) => i.id === armedId);
    if (item) select(item);
    // Releasing off-target leaves the menu open (pinned) rather than closing
    // empty-handed - a shaky drag never reads as a failure, it just leaves
    // you where a plain tap on the origin would have.
  };

  // Keyboard fallback: Tab already moves focus through role="menuitem"
  // buttons in document order; Enter/Space on a focused <button> fires a
  // native "click", which the per-spoke listener below maps onto the same
  // select() the drag path uses. Arrow keys map onto the same order for
  // anyone who'd rather not Tab through every item.
  const onKeydown = (event) => {
    if (event.key === "Escape") {
      close();
      return;
    }
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

  // The initial spokeEls[0].focus() call below exists for keyboard users -
  // so Tab/Arrow/Enter work immediately without an extra Tab first - but a
  // focus listener that arms on ANY focus would make that same call arm the
  // first spoke for a POINTER gesture too, before the finger has moved at
  // all: a plain tap-and-release with zero drag would then "release over an
  // armed spoke" and fire it, exactly the accidental-selection this
  // primitive's arm/fire model exists to prevent. Suppressing the first
  // focus event's arming call fixes that without affecting keyboard
  // behavior at all - a keyboard Enter/Space fires through the click
  // listener below using its own item reference, never through armedId.
  let suppressNextFocusArm = true;

  items.forEach((item, index) => {
    const el = spokeEls[index];
    // Fires for a native Enter/Space activation (down and up land on the
    // same focused button, which is exactly what a keyboard "press" is) and
    // for a plain, undragged pointer click landing directly on a spoke.
    // It does NOT double-fire against a real press-drag-release: that
    // sequence's down and up happen on different elements (the origin,
    // then wherever the finger ends up), so no native click is ever
    // synthesized for it in the first place.
    el.addEventListener("click", () => select(item));
    el.addEventListener("focus", () => {
      if (suppressNextFocusArm) {
        suppressNextFocusArm = false;
        return;
      }
      setArmed(item.id);
    });
  });
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKeydown);
  spokeEls[0]?.focus();

  return { close };
}
