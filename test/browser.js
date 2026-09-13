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

import { chromium, firefox, webkit } from "playwright-core";

const ENGINES = { chromium, firefox, webkit };

export const BROWSER_NAME = (process.env.BROWSER || "chromium").toLowerCase();

if (!ENGINES[BROWSER_NAME]) {
  console.error(`Unknown BROWSER="${process.env.BROWSER}". Use one of: ${Object.keys(ENGINES).join(", ")}`);
  process.exit(2);
}

export const engine = ENGINES[BROWSER_NAME];

// Announces the engine on stderr rather than stdout, so a gate that parses its
// own stdout (run-benchmark.js prints a report) is unaffected.
export async function launchBrowser(options = {}) {
  console.error(`[browser] ${BROWSER_NAME}`);
  return engine.launch(options);
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
