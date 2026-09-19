// browser.js: one place that decides which engine a gate runs in.
//
// Every browser gate used to do `import { chromium } from "playwright-core"`
// and `chromium.launch()`. The app ships to Safari and Firefox users and had
// never been executed in either - the largest unmeasured risk in the web build,
// larger than anything in the scan pipeline, which at least has a benchmark.
//
// WebKit coverage is worth double here: it is the same engine family as the iOS
// WKWebView the native build runs inside, so a WebKit failure is very likely an
// iOS failure that would otherwise wait for the device pass to discover.
//
// Usage in a gate:
//
//     import { launchBrowser, BROWSER_NAME } from "./browser.js";
//     const browser = await launchBrowser({ headless: true });
//
// and at the shell:
//
//     node test/library-documents.js              # chromium, the default
//     BROWSER=webkit node test/library-documents.js
//     BROWSER=firefox node test/library-documents.js
//
// WHY THE DEFAULT STAYS CHROMIUM, AND WHY CI IS SPLIT. Per-push CI runs chromium
// only, exactly as before. WebKit and Firefox run on a nightly schedule instead.
// That is deliberate and it is not timidity: Playwright's WebKit is known to be
// timing-flaky around canvas toBlob and IndexedDB transaction commit, which are
// precisely this app's two hottest paths (js/inpaint.js, js/editorExport.js,
// js/store.js). Gating every commit on a flaky engine does not make the app more
// correct - it trains everyone to re-run red builds until they go green, which
// costs the per-push signal its meaning. Nightly catches genuine divergence
// without poisoning the signal people actually act on.

// ---------------------------------------------------------------------------
// TWO THINGS EVERY BROWSER GATE INHERITS FROM THIS FILE, INCLUDING ONES NOT
// WRITTEN YET. Both were learned the expensive way; read them before writing a
// gate that drives the app.
//
// 1. A HANDLED ERROR IS NOT A pageerror, AND THIS SUITE WAS ONLY WATCHING
//    pageerror.
//
//    Measured on 2026-09-19: 25 gates installed `page.on("pageerror")` and
//    ZERO installed `page.on("console")`, while `js/` carries eleven
//    `console.error` sites, six of them inside a `catch`. Every one of those
//    six is invisible to a pageerror-only gate.
//
//    That is not hypothetical. js/scanDoc.js's `withBusy` catches whatever the
//    work throws, logs it with console.error and shows a window.alert - good
//    code, doing its job. So when `rebuildPage` threw a TypeError on every
//    filter chip, both rotate buttons and "Apply filter to all",
//    test/document-creation.js - freshly written to click all of them, with a
//    pageerror handler installed - reported SIX CLEAN PASSES. Nothing uncaught
//    had happened. The gate was green and the screen was broken.
//
//    So the console listener lives HERE and is attached to every page created
//    through launchBrowser, rather than pasted into each gate, because the
//    gate most likely to need it is the one nobody has written yet. Anything
//    still uncollected when the process exits fails the run (see the exit hook
//    at the bottom of this file) - so a new gate inherits the FAILURE too, not
//    just the capture.
//
//    `pageerror` is deliberately left to each gate: 25 of them already handle
//    it their own way, and duplicating it here would report every uncaught
//    error twice.
//
//    A gate that drives an error path ON PURPOSE - malformed input, a mocked
//    429, a codec that is absent by design - declares it with
//    expectConsoleErrors(page, [...], "why"), which is a statement about that
//    gate's intent rather than a switch that turns the check off.
//
//    A gate that checks errors itself, step by step, drains them with
//    takeConsoleErrors(page) so the same error is not reported twice.
//
// 2. NEVER WAIT WITH page.waitForTimeout() AROUND CANVAS WORK. USE
//    page.waitForFunction().
//
//    Chromium encodes canvas.toBlob on an IDLE TASK. A headless renderer that
//    nobody is waking has no idle periods, so an encode scheduled behind
//    another one simply never runs: the promise never settles, no error is
//    raised, and the flow stops mid-commit. It does NOT happen headed, which
//    is what makes it so disorienting - the app is fine and the gate hangs.
//
//    waitForFunction polls inside the page (rAF by default), which keeps
//    frames coming and idle tasks running. waitForTimeout sleeps in node and
//    touches the renderer not at all.
//
//    This was hit for real: js/scanDoc.js's addPageFromCanvas calls
//    canvasToBlob four times while committing one page, and a gate written
//    with waitForTimeout stalled on the second one every time. A gate that
//    HANGS is worse than one that fails - CI kills it at the job timeout with
//    no assertion to point at.
// ---------------------------------------------------------------------------

import { chromium, firefox, webkit } from "playwright-core";

const ENGINES = { chromium, firefox, webkit };

export const BROWSER_NAME = (process.env.BROWSER || "chromium").toLowerCase();

if (!ENGINES[BROWSER_NAME]) {
  console.error(`Unknown BROWSER="${process.env.BROWSER}". Use one of: ${Object.keys(ENGINES).join(", ")}`);
  process.exit(2);
}

export const engine = ENGINES[BROWSER_NAME];

// ---------------------------------------------------------------------------
// Console-error capture. See note 1 in this file's header for why it lives here
// rather than in each gate.

// Keyed by page. A Map rather than a WeakMap because the exit hook has to
// ENUMERATE these; a gate's pages live as long as its process anyway.
const watchedPages = new Map();

function watchPage(page) {
  if (watchedPages.has(page)) return page;

  const record = { errors: [], allowed: [] };
  watchedPages.set(page, record);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (record.allowed.some(({ pattern }) => pattern.test(text))) return;
    const location = message.location?.();
    record.errors.push(location?.url ? `${text}\n      at ${location.url}:${location.lineNumber}` : text);
  });

  return page;
}

// Wraps page creation so every route to a page is covered: browser.newPage(),
// context.newPage(), and a popup the page opens itself.
function watchContext(context) {
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => watchPage(await newPage(...args));
  context.on("page", watchPage);
  return context;
}

function watchBrowser(browser) {
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => watchPage(await newPage(...args));

  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => watchContext(await newContext(...args));

  return browser;
}

// Declares that this gate drives an error path ON PURPOSE. `patterns` are
// regexes or plain substrings matched against the console text; `reason` is
// printed when the gate runs, so an exemption is visible in the log rather than
// silently swallowing whatever else breaks on the same page.
//
// Deliberately per-pattern rather than a blanket "ignore console errors on this
// page": a gate for malformed input should still fail if something UNRELATED
// starts throwing while it runs.
export function expectConsoleErrors(page, patterns, reason) {
  const record = watchedPages.get(page);
  if (!record) return;
  for (const pattern of patterns) {
    record.allowed.push({ pattern: pattern instanceof RegExp ? pattern : new RegExp(escapeForRegExp(String(pattern))) });
  }
  console.log(`  [console] expected errors allowed: ${reason}`);
  // Anything already collected that a late declaration covers is dropped too,
  // so the call can sit next to the step it describes rather than having to be
  // hoisted above page creation.
  record.errors = record.errors.filter((text) => !record.allowed.some(({ pattern }) => pattern.test(text)));
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns and CLEARS the console errors seen on this page, for a gate that
// reports them itself, step by step. Without the clear, the exit hook below
// would report the same error a second time.
export function takeConsoleErrors(page) {
  const record = watchedPages.get(page);
  if (!record) return [];
  const errors = record.errors.slice();
  record.errors.length = 0;
  return errors;
}

// Anything nobody claimed fails the run, so a gate written next week inherits
// the failure and not merely the listener. Setting exitCode from an exit
// listener works even after an explicit process.exit(0), which several gates
// call - verified, not assumed.
process.on("exit", () => {
  const unclaimed = [];
  for (const [, record] of watchedPages) unclaimed.push(...record.errors);
  if (!unclaimed.length) return;

  // Grouped, because one broken render can log the same line on every frame.
  const counts = new Map();
  for (const text of unclaimed) counts.set(text, (counts.get(text) || 0) + 1);

  console.error(`\nCONSOLE ERRORS (${unclaimed.length}) - the page logged these and no assertion claimed them.`);
  console.error("See test/browser.js note 1: a handled error is not a pageerror. If this gate");
  console.error("drives an error path on purpose, declare it with expectConsoleErrors().");
  for (const [text, count] of counts) console.error(`  - ${count > 1 ? `(x${count}) ` : ""}${text}`);
  process.exitCode = 1;
});

// Announces the engine on stderr rather than stdout, so a gate that parses its
// own stdout (run-benchmark.js prints a report) is unaffected.
export async function launchBrowser(options = {}) {
  console.error(`[browser] ${BROWSER_NAME}`);
  return watchBrowser(await engine.launch(options));
}

// ---------------------------------------------------------------------------
// Binds a gate's static server to a port the OS picks, and resolves with the
// port it actually got.
//
// WHY NOT A FIXED PORT. Every gate used to declare `const PORT = 81xx` and
// `.listen(PORT)`. Twenty-eight files were sharing twenty numbers, so eight
// PAIRS collided outright - render-fidelity/tune-thresholds on 8124,
// move-inpaint/non-latin-limitation on 8129, guided-path/web-tier-smoke on
// 8131, editor-delete/pdf-export on 8132, library-documents/replacement-size
// on 8133, chrome-reorganization/document-creation on 8140,
// radial-call-sites/redaction-destroys-original on 8149, and
// inpaint-fidelity/pii-redaction on 8151.
//
// Renumbering would have fixed those eight and left the real defect in place:
// a FIXED port means two runs of the SAME gate collide too. That is not
// hypothetical - it cost one session a run when 8140 was taken, and another a
// full benchmark run on 8123. Two sessions on one machine, a stale server from
// an interrupted run, a dev server that happens to want 8131: all the same bug.
//
// Port 0 asks the OS for a free port, so a gate can never collide with anything
// - including itself. The port is only knowable after the socket binds, hence
// the promise: `server.address()` returns null until the "listening" event.
//
// The `error` listener is once-only and paired with the success path so a real
// bind failure (EACCES, EMFILE) still rejects rather than hanging forever.
export function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

// True when the current engine is NOT the one a gate requires. A gate that
// genuinely cannot run elsewhere should say so and skip with exit 0 rather than
// fail - a skip with a stated reason is information; a red build for a test that
// was never applicable is noise.
export function skipUnlessChromium(reason) {
  if (BROWSER_NAME === "chromium") return false;
  console.log(`SKIPPED on ${BROWSER_NAME}: ${reason}`);
  return true;
}

// ---------------------------------------------------------------------------
// Playwright's WebKit cannot store a Blob in IndexedDB. This is a limitation of
// that BUILD, not of Safari, and the evidence is specific enough to say so:
//
//   - structuredClone(new Blob([...]))  -> works
//   - port.postMessage(new Blob([...])) -> works
//     So the structured-clone serializer in this build knows Blobs perfectly
//     well. What fails is only IndexedDB's file-backed storage path, which is
//     exactly the piece a headless build omits - WebKit stores IDB blobs as
//     separate on-disk files referenced by the record, and that machinery needs
//     platform integration the Playwright build does not ship.
//   - ArrayBuffer and Uint8Array into IDB -> work. So IndexedDB itself is fine;
//     only the Blob path is not.
//   - The transaction aborts with a NULL tx.error. A real quota, constraint or
//     data failure raises a named DOMException (QuotaExceededError,
//     DataCloneError). An abort carrying no error object at all is an internal
//     backend that is not wired up, not a spec-defined rejection.
//   - Chromium and Firefox are headless Playwright builds too, and both store
//     Blobs without complaint - so this is not "headless" in general.
//
// Safari has shipped Blob-in-IndexedDB since Safari 10, and js/store.js's entire
// page-image layer would be unusable on iOS if it had not.
//
// So the affected assertions SKIP on an engine that cannot do it, with the
// reason printed, rather than leaving the nightly job permanently red on a
// non-bug - a nightly nobody trusts is the failure mode the per-push/nightly
// split exists to prevent. Confirming it on real Safari is a manual item in
// WEB-COMPLETION-PLAN.md §4.3, because only a real browser can settle it.
//
// This PROBES rather than hardcoding "webkit": if a future Playwright build
// gains the capability, the coverage comes back on its own with no edit here.
let blobStorageCache = null;
export async function blobStorageWorks(page) {
  if (blobStorageCache !== null) return blobStorageCache;
  blobStorageCache = await page.evaluate(async () => {
    try {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("__blobcap", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("s", { keyPath: "k" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const ok = await new Promise((res) => {
        const tx = db.transaction("s", "readwrite");
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
        tx.onabort = () => res(false);
        try { tx.objectStore("s").put({ k: "probe", blob: new Blob(["x"]) }); } catch { res(false); }
      });
      db.close();
      indexedDB.deleteDatabase("__blobcap");
      return ok;
    } catch {
      return false;
    }
  });
  return blobStorageCache;
}

// Prints the standard skip notice once, so every call site words it the same.
export function noteBlobSkip(what) {
  console.log(`  SKIPPED (${BROWSER_NAME}): ${what} - this build cannot store a Blob in IndexedDB.`);
  console.log("           See test/browser.js for why that is a build limitation rather than a");
  console.log("           Safari bug, and WEB-COMPLETION-PLAN.md §4.3 for the real-Safari check.");
}
