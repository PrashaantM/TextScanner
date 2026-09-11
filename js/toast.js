// toast.js: a small, transient, bottom-anchored notice - "Deleted 'x'. Undo",
// "Created 'x'" - for actions that change data but don't need to block on a
// confirmation dialog. One toast is shown at a time; showing a new one replaces
// whatever is currently visible rather than queuing, since stacking transient
// notices is more confusing than useful at this app's scale.

let elements = null;
let hideTimer = null;

function ensureElements() {
  if (elements) return elements;
  elements = {
    root: document.getElementById("app-toast"),
    message: document.getElementById("app-toast-message"),
    action: document.getElementById("app-toast-action"),
  };
  return elements;
}

// Shows `message` for `duration` ms. If `actionLabel`/`onAction` are both
// given, an action button appears alongside the message and dismisses the
// toast when pressed - used for "Undo" today, but not named after that one
// caller so a future confirmation toast doesn't need a second component.
export function showToast(message, { actionLabel, onAction, duration = 5000 } = {}) {
  const el = ensureElements();
  if (!el.root) return;

  clearTimeout(hideTimer);
  el.message.textContent = message;

  if (actionLabel && onAction) {
    el.action.textContent = actionLabel;
    el.action.classList.remove("hidden");
    el.action.onclick = () => {
      hideToast();
      onAction();
    };
  } else {
    el.action.classList.add("hidden");
    el.action.onclick = null;
  }

  // Restart the transition even if a toast is already visible, so a second
  // trash action while the first toast is still up resets the clock instead
  // of leaving it to disappear early.
  el.root.classList.remove("is-visible");
  el.root.classList.remove("hidden");
  void el.root.offsetWidth;
  el.root.classList.add("is-visible");

  hideTimer = setTimeout(hideToast, duration);
}

export function hideToast() {
  const el = ensureElements();
  if (!el.root) return;
  clearTimeout(hideTimer);
  el.root.classList.remove("is-visible");
  // Cleared rather than left stale: an aria-live region that still holds the
  // last message's text is a trap for anything that reads it - a test waiting
  // for "is a toast visible right now" as its signal, an assistive tech user
  // encountering it mid-transition - for a cost of literally nothing, since
  // showToast() always sets it fresh before showing again anyway.
  el.message.textContent = "";
}
