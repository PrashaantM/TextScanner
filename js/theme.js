// theme.js: the manual light/dark override that sits alongside the app's
// existing prefers-color-scheme support.
//
// prefers-color-scheme on its own is not enough for two reasons. It follows the
// OS with no way to disagree, which matters most to the people most likely to
// need to - anyone who finds one of the two genuinely hard to read. And because
// the app never declared `color-scheme`, the browser kept painting form
// controls, scrollbars and focus rings from the OS setting regardless, so a
// dark page could carry a light <select>. Both are fixed together: this module
// writes data-theme on <html>, and style.css defines color-scheme and the full
// palette for each of the three states.
//
// Three states, not two. "System" is a real choice and the default, and it is
// represented by the ABSENCE of data-theme - so with nothing stored, only the
// media query applies and the page follows the OS exactly as it always did.

const STORAGE_KEY = "textscanner.theme";
const THEMES = ["system", "light", "dark"];

const LABELS = {
  system: "Theme: system",
  light: "Theme: light",
  dark: "Theme: dark",
};

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : "system";
  } catch {
    // Private browsing / storage disabled. The preference just won't persist,
    // which is a degraded experience rather than a broken one.
    return "system";
  }
}

function writeStored(theme) {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // As above.
  }
}

export function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function getTheme() {
  return readStored();
}

export function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "system";
  writeStored(next);
  applyTheme(next);
  return next;
}

export function cycleTheme() {
  const current = readStored();
  return setTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
}

export function themeLabel(theme) {
  return LABELS[theme] || LABELS.system;
}

// Applied at module load, before first paint of the result UI, so a stored
// preference doesn't show up as a flash of the wrong theme.
applyTheme(readStored());
