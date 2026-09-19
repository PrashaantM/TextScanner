// serviceWorkerRegistration.js: registers sw.js, behind an escape hatch, and
// provides the kill switch that undoes it.
//
// WHY THIS IS A MODULE RATHER THAN AN INLINE BLOCK IN index.html.
// WEB-COMPLETION-PLAN.md §W1 says "registration in index.html (near the
// existing module <script>)", and taken literally - a <script> block in the
// markup - that cannot work here: index.html:55's CSP is
// script-src 'self' 'wasm-unsafe-eval', with no 'unsafe-inline', so the browser
// refuses an inline script outright. The same CSP has already dropped something
// silently once (style-src 'self' refusing style ATTRIBUTES, which rendered
// every redaction box 0x0 - ebb119d), so it is checked here rather than assumed.
// index.html loads this file as its own module instead; the registration is
// still visible at the registration site the plan names.
//
// It is a separate module rather than four lines inside js/main.js because
// main.js is the image-text editor's bootstrap and this is neither that nor
// dependent on it - and because a separate <script> tag means the kill switch
// below still runs if main.js ever fails to boot, which is exactly when
// somebody needs it.
//
// ---------------------------------------------------------------------------
// THE ESCAPE HATCH: REGISTER ONLY ON https:, OR ON AN EXPLICIT ?sw OPT-IN.
//
// §W1 offers two candidates - `location.protocol === "https:"` or a `?nosw`
// parameter - and they are not equivalent. `?nosw` is opt-OUT: the worker
// registers everywhere unless a page says not to, so making the existing suite
// safe would mean appending ?nosw to the URL in all 32 gates, and the 33rd gate
// - the one nobody has written yet - would silently inherit a worker
// intercepting its requests. That is the same shape of defect as the console
// capture test/browser.js exists to centralise: coverage believed rather than
// real, with the newest gate the least protected.
//
// So the hatch is opt-IN, and the protocol check carries it. Every gate serves
// the app over http://localhost:<ephemeral>, so no gate registers a worker
// unless it asks in its own URL - and test/offline.js asserts BOTH halves: that
// a plain load leaves navigator.serviceWorker.controller null with no
// registrations, and that ?sw=1 produces a controlled page.
//
// It falls out of this that the iOS build never registers either: Capacitor
// serves the WKWebView over capacitor://localhost, which is not https:. The
// `isNativePlatform` guard below states that intent explicitly rather than
// leaving it resting on a scheme comparison - and it matters, because
// scripts/sync-web-assets.sh copies js/ into www/ but not the root-level sw.js,
// so a registration attempt there would 404. NOT verified on a device: no iOS
// hardware in this session, so this is reasoned from the hatch condition and
// Capacitor's scheme, not measured.
//
// ?nosw is kept as well, as a genuine recovery path rather than a test hook: it
// unregisters the worker and purges its caches. If a stale-cache lockout ever
// happens despite sw.js being network-first for the whole shell, this is the URL
// to hand someone - it never touches IndexedDB, so their documents survive it.

const params = new URLSearchParams(location.search);

async function unregisterEverything() {
  // Purge through the worker first, while it is still controlling the page:
  // after unregister() there is nobody to ask, and caches.delete() from here
  // would work but would duplicate the worker's own teardown.
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = resolve;
      controller.postMessage("sw:purge", [channel.port2]);
      // Never leave the page hanging on a worker that does not answer.
      setTimeout(resolve, 2000);
    });
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  // Belt and braces: a cache left behind by a worker that was already gone
  // before this ran would otherwise be unreachable.
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith("textscanner-")).map((name) => caches.delete(name)));
  console.log("[sw] unregistered and purged (?nosw). Local documents are untouched.");
}

if ("serviceWorker" in navigator) {
  if (params.has("nosw")) {
    unregisterEverything();
  } else if (!window.Capacitor?.isNativePlatform?.() && (location.protocol === "https:" || params.has("sw"))) {
    // Registered relative to this document, NOT as "/sw.js": the deployment is
    // served from /TextScanner/, so an absolute path would ask for a worker at
    // the origin root - a 404 on the live site, and a scope that would not
    // cover the app even if it existed.
    navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: "./" }).catch((error) => {
      // A failed registration must never be fatal: the app works exactly as it
      // did before this file existed, just without offline support.
      console.error("[sw] registration failed; the app still works online.", error);
    });
  }
}
