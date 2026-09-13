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
