// views.js: which screen is showing.
//
// The app grew from a single flow (pick an image, scan it, edit the result) into
// something with a library, a note editor and a multi-page scan document. That
// needs a router, but it does NOT need a routing framework - there are five
// views, they never nest, and exactly one is visible at a time.
//
// A deliberate constraint shapes this file: **every view's markup stays in the
// document at all times**, hidden with a class rather than created and destroyed.
// Three reasons, in order of how much they mattered:
//
//   1. The scan flow's DOM ids (#file-input, #scan-btn, #result-section and the
//      rest) are the app's de-facto public interface. Ten CI gates drive the app
//      through them, and js/editorObjects.js / js/dom.js resolve them once at
//      module load. Rendering them conditionally would break both.
//   2. The editor holds live state - object model, undo stack, sampled pixels.
//      Tearing its DOM down on every navigation would mean rebuilding all of it.
//   3. It is simply faster. Toggling a class is a style recalculation;
//      recreating the editor's markup is hundreds of nodes.
//
// The cost is that all views' markup is parsed up front. At this app's size that
// is a few kilobytes, which is a good trade for not breaking the test suite and
// not losing editor state on every tap.
//
// History is handled with pushState so the phone's back gesture and the
// browser's back button do the obvious thing, which is the single biggest
// difference between this feeling like an app and feeling like a web page.

export const VIEWS = {
  LIBRARY: "library",
  SCAN: "scan",
  DOCUMENT: "document",
  CROP: "crop",
  SETTINGS: "settings",
};

const listeners = new Set();
let currentView = null;
let currentParams = {};
// Views the user has passed through, so "back" can return somewhere sensible
// when there is no history entry to pop - opening a document from a search
// result should go back to the search, not to an empty library.
const trail = [];

// Suppresses the popstate handler while we are the ones changing history.
let navigatingProgrammatically = false;

// Scoped to #app-main deliberately. `document.body` also carries a
// view attribute (see showView), and an unscoped `[data-view]` selector matched
// the body itself - so hiding "every view except the current one" hid the entire
// page, including the view being shown. The body's attribute is named
// differently as a second layer of protection.
function viewRoot() {
  return document.getElementById("app-main") || document;
}

function elementsFor(view) {
  return viewRoot().querySelectorAll(`[data-view="${view}"]`);
}

function allViewElements() {
  return viewRoot().querySelectorAll("[data-view]");
}

export function getView() {
  return currentView;
}

export function getParams() {
  return { ...currentParams };
}

export function onViewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Moves focus to the newly shown view so a keyboard or screen-reader user lands
// in the content rather than staying on a button that is now hidden. Without
// this, navigating leaves focus on document.body and the next Tab starts from
// the top of the page every single time.
function focusView(view) {
  const target = document.querySelector(`[data-view="${view}"] [data-autofocus]`);
  if (target) {
    target.focus({ preventScroll: true });
    return;
  }

  const container = document.querySelector(`[data-view="${view}"]`);
  if (!container) return;
  // Not in the tab order permanently - just focusable enough to receive this
  // one programmatic focus, then it releases so Tab behaves normally.
  container.setAttribute("tabindex", "-1");
  container.focus({ preventScroll: true });
}

function announce(view) {
  const region = document.getElementById("view-status");
  if (!region) return;
  const labels = {
    [VIEWS.LIBRARY]: "Library",
    [VIEWS.SCAN]: "Scan",
    [VIEWS.DOCUMENT]: "Document",
    [VIEWS.CROP]: "Adjust edges",
    [VIEWS.SETTINGS]: "Settings",
  };
  region.textContent = labels[view] || view;
}

export function showView(view, params = {}, { push = true, restoreScroll = false } = {}) {
  if (!Object.values(VIEWS).includes(view)) return;

  const previous = currentView;
  if (previous === view && JSON.stringify(params) === JSON.stringify(currentParams)) return;

  for (const el of allViewElements()) el.classList.add("hidden");
  for (const el of elementsFor(view)) el.classList.remove("hidden");

  // Named data-active-view, NOT data-view: the view containers use data-view,
  // and giving the body the same attribute made it match the "hide everything"
  // selector above.
  document.body.dataset.activeView = view;

  if (previous && previous !== view) trail.push({ view: previous, params: currentParams });

  currentView = view;
  currentParams = { ...params };

  if (push && !navigatingProgrammatically) {
    const url = new URL(window.location.href);
    url.hash = buildHash(view, params);
    try {
      window.history.pushState({ view, params }, "", url.toString());
    } catch {
      // A sandboxed or file:// context can refuse pushState. Navigation still
      // works; only the back button loses its meaning, which is worth
      // degrading rather than failing over.
    }
  }

  // The library restores its scroll position when returning to it; every other
  // view starts at the top, because arriving at a document part-scrolled is
  // disorienting rather than helpful.
  if (!restoreScroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

  announce(view);
  focusView(view);

  for (const fn of listeners) {
    try {
      fn(view, currentParams, previous);
    } catch (err) {
      // One misbehaving listener must not leave the app on a half-switched
      // screen with the rest of the listeners unrun.
      console.error("View change listener failed:", err);
    }
  }
}

function buildHash(view, params) {
  if (view === VIEWS.LIBRARY) return "";
  const id = params.id ? `/${encodeURIComponent(params.id)}` : "";
  return `#${view}${id}`;
}

export function parseHash(hash = window.location.hash) {
  const raw = (hash || "").replace(/^#/, "");
  if (!raw) return { view: VIEWS.LIBRARY, params: {} };

  const [view, id] = raw.split("/");
  if (!Object.values(VIEWS).includes(view)) return { view: VIEWS.LIBRARY, params: {} };
  return { view, params: id ? { id: decodeURIComponent(id) } : {} };
}

// Goes back one step. Prefers real browser history so the platform's own back
// gesture and this button stay in sync; falls back to the internal trail when
// there is no history to pop (a deep link opened directly, for instance).
export function goBack(fallbackView = VIEWS.LIBRARY) {
  if (window.history.length > 1 && window.history.state) {
    window.history.back();
    return;
  }

  const previous = trail.pop();
  if (previous) showView(previous.view, previous.params, { push: false, restoreScroll: true });
  else showView(fallbackView, {}, { push: false });
}

export function initRouter(defaultView = VIEWS.LIBRARY) {
  window.addEventListener("popstate", (event) => {
    navigatingProgrammatically = true;
    try {
      const state = event.state;
      if (state?.view) showView(state.view, state.params || {}, { push: false, restoreScroll: true });
      else {
        const { view, params } = parseHash();
        showView(view, params, { push: false, restoreScroll: true });
      }
    } finally {
      navigatingProgrammatically = false;
    }
  });

  const { view, params } = parseHash();
  showView(view || defaultView, params, { push: false });
}
