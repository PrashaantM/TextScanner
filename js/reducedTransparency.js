// reducedTransparency.js: applies prefers-reduced-transparency to <html> as a
// root class (style.css's :root.reduced-transparency overrides the glass
// tokens - --glass-blur/--glass-saturate/--surface-glass/--glass-edge - to
// opaque/zero there), kept live for the life of the page rather than read
// once at load.
//
// Queried fresh on every check rather than cached as a MediaQueryList at
// module load, mirroring js/radialMenu.js's own fix for the identical shape
// of bug there (see that file's header comment in full): on WebKit, a
// MediaQueryList held from an earlier matchMedia() call keeps reporting its
// .matches value from whenever it was created, even after the OS setting
// changes - a fresh window.matchMedia(query).matches call in the same page
// reads correctly. A change listener is still what makes this live rather
// than a one-time check at load; it just isn't trusted to hand back the
// fresh answer itself - the handler re-queries fresh instead of relying on
// the list (or event) it fired from.

const QUERY = "(prefers-reduced-transparency: reduce)";

function prefersReducedTransparency() {
  return window.matchMedia(QUERY).matches;
}

function apply() {
  document.documentElement.classList.toggle("reduced-transparency", prefersReducedTransparency());
}

apply();
// A fresh matchMedia() call here too, purely to have something to attach the
// listener to - the list itself is never read again once fired; apply()
// above re-queries fresh instead.
window.matchMedia(QUERY).addEventListener("change", apply);
